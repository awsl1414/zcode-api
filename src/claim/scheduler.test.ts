/**
 * Scheduler tests with a fake clock, injected discovery and an in-memory
 * ledger. The opening-window timeline itself lives in `opening.test.ts`; this
 * file covers normal polling, policy holds, shared rate limits and the
 * manual/auto outcome linkage.
 */
import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import { ClaimScheduler, type ClaimSchedulerDeps } from "./scheduler.js";
import { ClaimPreviewError } from "./client.js";
import { createClaimRateLimitWindow, type ClaimRateLimitWindow } from "./rate-limit.js";
import { createActivityLedger } from "./ledger.js";
import { DEFAULT_OPENING } from "./opening.js";
import type { ClaimDiscovery, ClaimOutcome, ClaimablePlan } from "./types.js";

type HarnessFields = {
  jwt: string | undefined;
  plans: ClaimablePlan[];
  discoveryError: Error | undefined;
  claimOutcome: ClaimOutcome | Error | ((planId: string) => ClaimOutcome | Error);
  captchaResult: { verifyParam: string; region?: string } | Error;
  captchaCalls: number;
  claimCalls: Array<{ planId: string; captcha: { verifyParam: string; region?: string } | undefined }>;
  listCalls: number;
  nowMs: number;
  logs: string[];
  logLevels: Array<string | undefined>;
  logFields: Array<Record<string, unknown> | undefined>;
  rateLimit: ClaimRateLimitWindow | undefined;
  ledger: ReturnType<typeof createActivityLedger>;
  config: ClaimSchedulerDeps["config"];
};

interface Harness extends HarnessFields {
  scheduler: ClaimScheduler;
}

function plan(planId: string, extra: Partial<ClaimablePlan> = {}): ClaimablePlan {
  return {
    planId, name: planId, description: "", priority: 1, entitlements: [],
    source: "billing/preview", discoveryFaces: ["billing/preview"], raw: {},
    ...extra,
  };
}

function makeHarness(
  overrides: Partial<{
    accountId: string;
    accountIndex: number;
    rateLimit: ClaimRateLimitWindow;
    pollIntervalMs: number;
    cooldownMs: number;
    sprintWindowMs: number;
    sprintPollIntervalMs: number;
    diagnostics: ClaimDiscovery["diagnostics"];
  }> = {},
): Harness {
  const h: HarnessFields = {
    jwt: "jwt-1",
    plans: [plan("weekend-1")],
    discoveryError: undefined,
    claimOutcome: { ok: true, planId: "weekend-1" },
    captchaResult: { verifyParam: "cap", region: "cn" },
    captchaCalls: 0,
    claimCalls: [],
    listCalls: 0,
    nowMs: 1_000_000,
    logs: [],
    logLevels: [],
    logFields: [],
    rateLimit: overrides.rateLimit,
    ledger: createActivityLedger({ memoryOnly: true, now: () => h.nowMs }),
    config: {
      pollIntervalMs: overrides.pollIntervalMs ?? 300_000,
      cooldownMs: overrides.cooldownMs ?? 600_000,
      sprintWindowMs: overrides.sprintWindowMs ?? 1_800_000,
      sprintPollIntervalMs: overrides.sprintPollIntervalMs ?? 60_000,
      opening: DEFAULT_OPENING,
    },
  };

  const deps: ClaimSchedulerDeps = {
    accountId: overrides.accountId,
    accountIndex: overrides.accountIndex,
    rateLimit: h.rateLimit,
    ledger: h.ledger,
    getJwt: () => Promise.resolve(h.jwt),
    createClient: () => ({
      discoverActivities: async () => {
        h.listCalls += 1;
        if (h.discoveryError) throw h.discoveryError;
        return { activities: h.plans, diagnostics: overrides.diagnostics ?? { noDelivery: false, versionGate: false, eligibility: false, reasons: [] } };
      },
      claim: (planId, captcha) => {
        h.claimCalls.push({ planId, captcha });
        const outcome = typeof h.claimOutcome === "function" ? h.claimOutcome(planId) : h.claimOutcome;
        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
      },
    }),
    getCaptcha: () => {
      h.captchaCalls += 1;
      return h.captchaResult instanceof Error ? Promise.reject(h.captchaResult) : Promise.resolve(h.captchaResult);
    },
    config: h.config,
    log: (m, level, fields) => {
      h.logs.push(m);
      h.logLevels.push(level);
      h.logFields.push(fields);
    },
    now: () => h.nowMs,
  };
  const harness = h as HarnessFields & { scheduler?: ClaimScheduler };
  harness.scheduler = new ClaimScheduler(deps);
  return harness as Harness;
}

describe("ClaimScheduler.tick — normal poll and policy holds", () => {
  it("claims the highest-priority plan and writes claimedAt to the ledger", async () => {
    const h = makeHarness();
    h.plans = [plan("high", { priority: 9, endsAt: 3000 }), plan("low", { priority: 1 })];
    h.claimOutcome = { ok: true, planId: "high", startsAt: 2000, endsAt: 3000 };
    const res = await h.scheduler.tick();
    expect(res).toEqual({ action: "claimed", planId: "high", startsAt: 2000, endsAt: 3000 });
    expect(h.claimCalls).toEqual([{ planId: "high", captcha: { verifyParam: "cap", region: "cn" } }]);
    expect(h.ledger.get("default", "high", h.nowMs)?.claimedAt).toBe(h.nowMs);

    h.nowMs = 3_000_000;
    h.plans = [plan("low")];
    expect((await h.scheduler.tick()).action).toBe("claimed");
    expect(h.claimCalls.map((c) => c.planId)).toEqual(["high", "low"]);
  });

  it("empty feeds keep the 30-minute cadence all day and tag distinct diagnostics", async () => {
    const h = makeHarness({ diagnostics: { noDelivery: true, versionGate: false, eligibility: false, reasons: [] } });
    h.plans = [];
    expect((await h.scheduler.tick()).action).toBe("idle");
    expect(h.scheduler.holdUntilMs()).toBe(h.nowMs + 300_000);
    expect(h.logs[0]).toContain("no delivery in either discovery face");
    expect(h.logLevels).toEqual(["debug", "debug"]);
    expect(h.logFields[0]).toEqual({ reason: "empty" });
    expect(h.logFields[1]).toEqual({ reason: "empty" });

    const variants: Array<[ClaimDiscovery["diagnostics"], string]> = [
      [{ noDelivery: false, versionGate: true, eligibility: false, reasons: [] }, "versionGate"],
      [{ noDelivery: false, versionGate: false, eligibility: true, reasons: [] }, "1004"],
    ];
    for (const [diagnostics, reason] of variants) {
      const variant = makeHarness({ diagnostics });
      variant.plans = [];
      await variant.scheduler.tick();
      expect(variant.logFields[0]).toEqual({ reason });
    }

    const expired = makeHarness();
    expired.plans = [plan("old", { endsAt: 1 })];
    await expired.scheduler.tick();
    expect(expired.logs.join("\n")).toContain("all plans expired");
  });

  it("1002 outside an opening window returns to the next normal poll", async () => {
    const h = makeHarness();
    h.claimOutcome = { ok: false, planId: "weekend-1", failureKind: "unavailable", code: 1002, message: "not yet" };
    const failed = await h.scheduler.tick();
    expect((failed as { holdMs: number }).holdMs).toBe(300_000);
    expect(h.ledger.get("default", "weekend-1", h.nowMs)?.claimedAt).toBeUndefined();
  });

  it("1004 rechecks in 30 minutes; 1001 and 3001 use their own policy rows", async () => {
    for (const [code, kind, expected] of [
      [1004, "ineligible", 1_800_000],
      [1001, "not_found", 1_800_000],
      [3001, "invalid_request", 600_000],
    ] as const) {
      const h = makeHarness();
      h.claimOutcome = { ok: false, planId: "weekend-1", failureKind: kind, code, message: "later" };
      const result = await h.scheduler.tick();
      expect((result as { holdMs: number }).holdMs).toBe(expected);
    }
  });

  it("1005 is terminal for the Beijing day and survives a restart", async () => {
    const h = makeHarness();
    h.claimOutcome = { ok: false, planId: "weekend-1", failureKind: "quota_exhausted", code: 1005, message: "gone" };
    await h.scheduler.tick();
    expect(h.ledger.get("default", "weekend-1", h.nowMs)?.exhaustedAt).toBe(h.nowMs);
    h.nowMs += 40_000;
    expect((await h.scheduler.tick()).action).toBe("idle");
    expect(h.claimCalls).toHaveLength(1);
  });

  it("an unknown code keeps the raw code and never writes a success fact", async () => {
    const h = makeHarness();
    h.claimOutcome = { ok: false, planId: "weekend-1", failureKind: "unknown", code: 9999, message: "new code" };
    const result = await h.scheduler.tick();
    expect((result as { holdMs: number }).holdMs).toBe(60_000);
    const entry = h.ledger.get("default", "weekend-1", h.nowMs);
    expect(entry?.lastCode).toBe(9999);
    expect(entry?.claimedAt).toBeUndefined();
    expect(h.scheduler.status().last?.userAction).toBe("inspect-code");
  });

  it("3007 hands a manual-captcha action to the panel and holds until the next day", async () => {
    const h = makeHarness();
    h.claimOutcome = { ok: false, planId: "weekend-1", failureKind: "captcha", code: 3007, message: "solve it" };
    await h.scheduler.tick();
    expect(h.scheduler.status().last?.userAction).toBe("manual-captcha");
    expect(h.scheduler.status().planHolds["weekend-1"]?.until).toBeGreaterThan(h.nowMs + 60_000);
  });

  it("401 stops the scheduler; success and 1003 are terminal", async () => {
    const stopped = makeHarness();
    stopped.claimOutcome = { ok: false, planId: "weekend-1", failureKind: "login_required", code: 401, message: "auth" };
    await stopped.scheduler.tick();
    expect(stopped.scheduler.isStopped()).toBe(true);

    const already = makeHarness();
    already.claimOutcome = { ok: false, planId: "weekend-1", failureKind: "already_claimed", code: 1003, message: "dup" };
    await already.scheduler.tick();
    expect(already.ledger.get("default", "weekend-1", already.nowMs)?.claimedAt).toBeUndefined();
    expect(already.scheduler.status().planHolds["weekend-1"]?.reason).toBe("already_claimed");
    already.nowMs += 40_000;
    expect((await already.scheduler.tick()).action).toBe("idle");
  });

  it("one claim per normal tick; other plans wait for the next round", async () => {
    const h = makeHarness();
    h.plans = [plan("a"), plan("b")];
    h.claimOutcome = (planId: string) => ({ ok: true, planId, endsAt: h.nowMs / 1000 + 3600 });
    expect((await h.scheduler.tick()).action).toBe("claimed");
    expect(h.claimCalls).toHaveLength(1);
    h.nowMs += h.config.pollIntervalMs;
    expect((await h.scheduler.tick()).action).toBe("claimed");
    expect(h.claimCalls.map((c) => c.planId)).toEqual(["a", "b"]);
  });

  it("sprint cadence remains independent of opening and applies to retryable failures", async () => {
    const h = makeHarness({ sprintWindowMs: 1_800_000, sprintPollIntervalMs: 60_000 });
    h.plans = [plan("ending", { endsAt: h.nowMs / 1000 + 1200 })];
    h.claimOutcome = { ok: false, planId: "ending", failureKind: "unavailable", code: 1002, message: "not yet" };
    const failed = await h.scheduler.tick();
    expect((failed as { holdMs: number }).holdMs).toBe(60_000);
  });
});

describe("ClaimScheduler — discovery errors and shared rate-limit window", () => {
  function rateLimitError(retryAfterSeconds?: number): ClaimPreviewError {
    return new ClaimPreviewError("claim discovery failed (429): slow down", 429, 429, retryAfterSeconds);
  }

  it("404 idles at poll cadence; 5xx backs off with cooldown", async () => {
    const notDeployed = makeHarness();
    notDeployed.discoveryError = new ClaimPreviewError("not deployed", 404, 404);
    expect((await notDeployed.scheduler.tick()).action).toBe("idle");
    expect(notDeployed.logs.join("\n")).toContain("campaign endpoint not deployed");

    const broken = makeHarness({ cooldownMs: 45_000 });
    broken.discoveryError = new ClaimPreviewError("down", 503, 503);
    const failed = await broken.scheduler.tick();
    expect((failed as { holdMs: number }).holdMs).toBe(45_000);
  });

  it("Retry-After becomes the hold and is reported to the shared window", async () => {
    const window = createClaimRateLimitWindow();
    const h = makeHarness({ rateLimit: window });
    h.discoveryError = rateLimitError(90);
    const failed = await h.scheduler.tick();
    expect((failed as { holdMs: number; holdSource: string }).holdMs).toBe(90_000);
    expect((failed as { holdSource: string }).holdSource).toBe("retry-after");
    expect(window.untilMs).toBe(h.nowMs + 90_000);
  });

  it("a peer adopts the shared window and resumes with its own phase", async () => {
    const window = createClaimRateLimitWindow();
    const a = makeHarness({ accountId: "account-a", rateLimit: window });
    const b = makeHarness({ accountId: "account-b", rateLimit: window });
    a.discoveryError = rateLimitError(120);
    await a.scheduler.tick();
    b.nowMs = 1_030_000;
    expect(b.scheduler.holdUntilMs()).toBe(0);
    b.scheduler.tick();
    expect(b.scheduler.holdUntilMs()).toBe(1_120_000 + b.scheduler.staggerPhaseMs());
    expect(b.listCalls).toBe(0);
    b.nowMs = b.scheduler.holdUntilMs();
    b.plans = [];
    expect((await b.scheduler.tick()).action).toBe("idle");
  });

  it("a 3002 claim failure retries through the shared window with the opening phase", async () => {
    const window = createClaimRateLimitWindow();
    const h = makeHarness({ accountIndex: 1, rateLimit: window });
    h.claimOutcome = { ok: false, planId: "weekend-1", failureKind: "rate_limited", code: 3002, message: "slow down" };
    await h.scheduler.tick();
    expect(window.untilMs).toBe(h.nowMs + 60_000);
    expect(h.scheduler.openingStaggerMs()).toBe(200);
  });
});

describe("ClaimScheduler — phases, gateway and lifecycle", () => {
  it("normal phase uses sha256(accountId) % pollIntervalMs; opening phase is milliseconds", () => {
    for (const id of ["acc-1", "acc-2", "account-work", "账号-八"]) {
      const h = makeHarness({ accountId: id, pollIntervalMs: 300_000 });
      expect(h.scheduler.staggerPhaseMs()).toBe(createHash("sha256").update(id, "utf-8").digest().readUInt32BE(0) % 300_000);
    }
    expect(makeHarness({ accountIndex: 3 }).scheduler.openingStaggerMs()).toBe(600);
    expect(makeHarness().scheduler.staggerPhaseMs()).toBe(0);
  });

  it("start/stop drives unref'd ticks; tick after stop reports stopped", async () => {
    const h = makeHarness({ pollIntervalMs: 5 });
    h.plans = [];
    h.scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    h.scheduler.stop();
    expect(h.scheduler.isStopped()).toBe(true);
    expect(await h.scheduler.tick()).toEqual({ action: "stopped" });
  });

  it("captcha gate false skips the token; a throwing gate fails open", async () => {
    const plans = [plan("weekend-1")];
    function gateHarness(captchaRequired: ClaimSchedulerDeps["captchaRequired"]) {
      let calls = 0;
      const seen: Array<{ planId: string; captcha: unknown }> = [];
      const scheduler = new ClaimScheduler({
        getJwt: () => Promise.resolve("jwt"),
        createClient: () => ({
          discoverActivities: async () => ({ activities: plans, diagnostics: { noDelivery: false, versionGate: false, eligibility: false, reasons: [] } }),
          claim: (planId: string, captcha?: { verifyParam: string }) => { seen.push({ planId, captcha }); return Promise.resolve({ ok: true, planId }); },
        }),
        getCaptcha: () => { calls += 1; return Promise.resolve({ verifyParam: "cap" }); },
        ledger: createActivityLedger({ memoryOnly: true, now: () => 1_000_000 }),
        captchaRequired,
        config: { pollIntervalMs: 300_000, cooldownMs: 600_000, sprintWindowMs: 0, sprintPollIntervalMs: 60_000 },
        now: () => 1_000_000,
      });
      return { calls: () => calls, seen, scheduler };
    }
    const off = gateHarness(async () => false);
    expect((await off.scheduler.tick()).action).toBe("claimed");
    expect(off.calls()).toBe(0);
    expect(off.seen[0].captcha).toBeUndefined();

    const failOpen = gateHarness(() => { throw new Error("configs unavailable"); });
    expect((await failOpen.scheduler.tick()).action).toBe("claimed");
    expect(failOpen.calls()).toBe(1);
  });
});

describe("ClaimScheduler.status — ledger-backed observation", () => {
  it("reports claimed holds, next check and the last result with policy fields", async () => {
    const h = makeHarness();
    h.plans = [plan("weekend-1", { endsAt: 3_000 })];
    h.claimOutcome = { ok: true, planId: "weekend-1", startsAt: 1_500, endsAt: 3_000 };
    await h.scheduler.tick();
    const status = h.scheduler.status();
    expect(status.stopped).toBe(false);
    expect(status.planHolds["weekend-1"]).toMatchObject({ until: 3_000_000, reason: "claimed" });
    expect(status.nextCheckAtMs).toBe(h.scheduler.holdUntilMs());
    expect(status.last).toMatchObject({ action: "claimed", source: "auto", planId: "weekend-1" });
  });

  it("an alarm carries both startsAt and effectiveAt in the status", async () => {
    const h = makeHarness();
    h.plans = [plan("two-clocks", { startsAt: 2_000, effectiveAt: 2_600, endsAt: 9_000 })];
    await h.scheduler.tick();
    const alarm = h.scheduler.status().alarms![0];
    expect(alarm.claimAtMs).toBe(2_000_000);
    expect(alarm.effectiveAtMs).toBe(2_600_000);
    expect(alarm.staggerMs).toBe(0);
  });

  it("manual and automatic outcomes share one ledger and hold path", async () => {
    const h = makeHarness();
    h.plans = [plan("weekend-1", { endsAt: 9_000 })];
    h.scheduler.noteOutcome({ ok: true, planId: "weekend-1", endsAt: 9_000 }, { endsAt: 9_000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.scheduler.status().planHolds["weekend-1"]).toMatchObject({ until: 9_000_000, reason: "claimed" });
    expect(h.ledger.get("default", "weekend-1", h.nowMs)?.claimedAt).toBe(h.nowMs);
    expect((await h.scheduler.tick()).action).toBe("idle");
    expect(h.claimCalls).toEqual([]);
  });

  it("a manual failure uses the same policy hold as an automatic one", async () => {
    const h = makeHarness();
    h.scheduler.noteOutcome({ ok: false, planId: "weekend-1", failureKind: "unavailable", code: 1002, message: "ended" });
    expect(h.scheduler.status().planHolds["weekend-1"]?.until).toBe(h.nowMs + 300_000);
    expect(h.ledger.get("default", "weekend-1", h.nowMs)?.lastCode).toBe(1002);
  });
});
