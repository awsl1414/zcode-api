/**
 * Opening-window timeline with a fake clock and injected discovery. All three
 * clocks from the 1030-wk capture are exercised: 19:00 opens claiming, 23:00
 * activates the grant, 11-02 09:00 expires it.
 */
import { describe, it, expect } from "bun:test";
import { ClaimScheduler, type ClaimSchedulerDeps } from "./scheduler.js";
import { createActivityLedger } from "./ledger.js";
import { createClaimRateLimitWindow } from "./rate-limit.js";
import { DEFAULT_OPENING, computeNextWake, openingAlarms, openingStaggerMs } from "./opening.js";
import type { ClaimOutcome, ClaimablePlan } from "./types.js";

const START = 1793358000; // 2026-10-30 19:00 Beijing / 11:00 UTC
const EFFECTIVE = 1793372400; // 2026-10-30 23:00 Beijing, four hours after claiming opens
const END = 1793581200; // 2026-11-02 09:00 Beijing
const T = START * 1000;

function plan(planId: string, extra: Partial<ClaimablePlan> = {}): ClaimablePlan {
  return {
    planId, name: planId, description: "", priority: 1, entitlements: [],
    source: "marketing/touch", discoveryFaces: ["marketing/touch"], raw: {},
    ...extra,
  };
}

interface Fields {
  accountId: string;
  nowMs: number;
  plans: ClaimablePlan[];
  claimOutcome: ClaimOutcome | ((planId: string, call: number) => ClaimOutcome);
  claimCalls: Array<{ at: number; planId: string; captcha?: string }>;
  discoveryCalls: number[];
  captchaCalls: number[];
  config: ClaimSchedulerDeps["config"];
  ledger: ReturnType<typeof createActivityLedger>;
  logs: string[];
  reportCalls: number;
  preflightCalls: number;
}

function harness(fields: Partial<Fields> & { accountIndex?: number; rateLimit?: ReturnType<typeof createClaimRateLimitWindow> } = {}) {
  const h: Fields & { accountIndex?: number; rateLimit?: ReturnType<typeof createClaimRateLimitWindow> } = {
    accountId: "account-a",
    nowMs: T - DEFAULT_OPENING.preheatMs,
    plans: [plan("zcode-v3-start-plan-1030-wk", { startsAt: START, endsAt: END, effectiveAt: EFFECTIVE })],
    claimOutcome: { ok: true, planId: "zcode-v3-start-plan-1030-wk" },
    claimCalls: [],
    discoveryCalls: [],
    captchaCalls: [],
    config: {
      pollIntervalMs: 300_000,
      cooldownMs: 600_000,
      sprintWindowMs: 1_800_000,
      sprintPollIntervalMs: 60_000,
      opening: DEFAULT_OPENING,
    },
    ledger: createActivityLedger({ memoryOnly: true, now: () => h.nowMs }),
    logs: [],
    reportCalls: 0,
    preflightCalls: 0,
    ...fields,
  };
  let claims = 0;
  const scheduler = new ClaimScheduler({
    accountId: fields.accountId ?? "account-a",
    accountIndex: fields.accountIndex ?? 0,
    ledger: h.ledger,
    getJwt: async () => "jwt-a",
    createClient: () => ({
      discoverActivities: async () => {
        h.discoveryCalls.push(h.nowMs);
        return { activities: h.plans, diagnostics: { noDelivery: false, versionGate: false, eligibility: false, reasons: [] } };
      },
      claim: async (planId, captcha) => {
        claims += 1;
        h.claimCalls.push({ at: h.nowMs, planId, captcha: captcha?.verifyParam });
        const outcome = typeof h.claimOutcome === "function" ? h.claimOutcome(planId, claims) : h.claimOutcome;
        return outcome;
      },
    }),
    getCaptcha: async () => {
      h.captchaCalls.push(h.nowMs);
      return { verifyParam: "cap-ready" };
    },
    captchaRequired: async () => true,
    preflight: async () => { h.preflightCalls += 1; },
    reportActivation: async () => { h.reportCalls += 1; return { ok: true }; },
    config: h.config,
    log: (message) => { h.logs.push(message); },
    now: () => h.nowMs,
    ...(fields.rateLimit ? { rateLimit: fields.rateLimit } : {}),
  });
  return { h, scheduler };
}

async function at(target: { h: Fields; scheduler: ClaimScheduler }, time: number) {
  target.h.nowMs = time;
  return target.scheduler.tick();
}

describe("opening window — timeline", () => {
  it("T−N registers the alarm, T−1s preheats, T sends discovery + claim, T+2s retries", async () => {
    const run = harness();
    const N = DEFAULT_OPENING.preheatMs;
    const preheat = await at(run, T - N);
    expect(preheat.action).toBe("idle");
    const alarm = run.scheduler.status().alarms![0];
    expect(alarm.preheatAtMs).toBe(T - N);
    expect(alarm.claimAtMs).toBe(T);
    expect(alarm.burstEndsAtMs).toBe(T + DEFAULT_OPENING.burstWindowMs);
    expect(alarm.effectiveAtMs).toBe(EFFECTIVE * 1000);
    expect(alarm.expiresAtMs).toBe(END * 1000);
    expect(run.h.claimCalls).toHaveLength(0);
    expect(run.h.captchaCalls).toHaveLength(1); // token minted during preheat
    expect(run.h.preflightCalls).toBe(1);
    expect(run.h.reportCalls).toBe(1);
    expect(run.h.ledger.get("account-a", "zcode-v3-start-plan-1030-wk", run.h.nowMs)?.preparedAt).toBe(T - N);

    await at(run, T - 1_000);
    expect(run.h.claimCalls).toHaveLength(0);
    expect(run.scheduler.status().alarms![0].phase).toBe("preheat");

    const atT = await at(run, T);
    expect(atT.action).toBe("claimed");
    expect(run.h.discoveryCalls.at(-1)).toBe(T);
    expect(run.h.claimCalls[0].at).toBe(T);
    expect(run.h.claimCalls[0].captcha).toBe("cap-ready");

    // A successful grant is terminal for the account; start the retry from the
    // same pre-claim state so the 1002 short-retry row is what gets exercised.
    const retryRun = harness({
      nowMs: T - DEFAULT_OPENING.preheatMs,
      claimOutcome: { ok: false, planId: "zcode-v3-start-plan-1030-wk", failureKind: "unavailable", code: 1002, message: "not yet" },
    });
    await at(retryRun, T - DEFAULT_OPENING.preheatMs);
    const first = await at(retryRun, T);
    expect(first.action).toBe("failed");
    expect((first as { holdMs: number }).holdMs).toBe(DEFAULT_OPENING.burstIntervalMs);
    const retry = await at(retryRun, T + 2_000);
    expect(retry.action).toBe("failed");
    expect(retryRun.h.claimCalls[1].at).toBe(T + 2_000);
  });

  it("uses millisecond deterministic phases, not the five-minute sha256 phase", () => {
    const alarms = [0, 1, 2, 3].map((index) => openingStaggerMs(index, DEFAULT_OPENING));
    expect(alarms).toEqual([0, 200, 400, 600]);
    const a = harness({ accountIndex: 0 });
    const b = harness({ accountIndex: 1 });
    expect(a.scheduler.openingStaggerMs()).toBe(0);
    expect(b.scheduler.openingStaggerMs()).toBe(200);
    expect(a.scheduler.staggerPhaseMs()).toBeGreaterThanOrEqual(0);
    expect(a.scheduler.staggerPhaseMs()).toBeLessThan(300_000);
    expect(computeNextWake(T + 300_000, openingAlarms(a.h.plans, T - 60_000, { accountIndex: 0 }), T - 60_000, { config: DEFAULT_OPENING })).toBeLessThan(T);
  });

  it("1005 closes the activity for the day; a feed with failureEndsAt reopens it", async () => {
    const run = harness({
      nowMs: T,
      claimOutcome: (planId) => ({ ok: false, planId, failureKind: "quota_exhausted", code: 1005, message: "gone" }),
    });
    await at(run, T);
    expect(run.h.ledger.get("account-a", "zcode-v3-start-plan-1030-wk", T)?.exhaustedAt).toBe(T);
    await at(run, T + 40_000);
    expect(run.h.claimCalls).toHaveLength(1);

    run.h.plans = [plan("zcode-v3-start-plan-1030-wk", { startsAt: (T + 100_000) / 1000, endsAt: (T + 180_000) / 1000, effectiveAt: EFFECTIVE })];
    run.h.claimOutcome = { ok: true, planId: "zcode-v3-start-plan-1030-wk" };
    const atNewStart = await at(run, T + 100_000);
    expect(atNewStart.action).toBe("claimed");
    expect(run.h.ledger.get("account-a", "zcode-v3-start-plan-1030-wk", T + 100_000)?.exhaustedAt).toBeUndefined();
    expect(run.h.claimCalls.length).toBeGreaterThan(1);
  });

  it("a feed that appears at T+40s still claims inside the burst window", async () => {
    const run = harness({ nowMs: T - DEFAULT_OPENING.preheatMs, plans: [] });
    await at(run, T - DEFAULT_OPENING.preheatMs);
    run.h.plans = [plan("late-drop", { startsAt: START, endsAt: END })];
    const result = await at(run, T + 40_000);
    expect(result.action).toBe("claimed");
    expect(run.h.claimCalls[0].at).toBe(T + 40_000);
    expect(run.scheduler.status().alarms![0].preheatAtMs).toBe(T + 40_000);
  });

  it("no startsAt claims immediately; effectiveAt > startsAt keeps two clocks", async () => {
    const run = harness({
      nowMs: T - DEFAULT_OPENING.preheatMs,
      plans: [plan("no-start", { effectiveAt: EFFECTIVE, endsAt: END })],
    });
    const result = await at(run, T - DEFAULT_OPENING.preheatMs);
    expect(result.action).toBe("claimed");
    expect(run.h.claimCalls).toHaveLength(1);
    expect(run.scheduler.status().alarms).toEqual([]);
    const entry = run.h.ledger.get("account-a", "no-start", run.h.nowMs);
    expect(entry?.effectiveAt).toBe(EFFECTIVE * 1000);
    expect(entry?.alarmAt).toBeUndefined();

    const twoClocks = harness({ nowMs: T - 1_000 });
    await at(twoClocks, T - 1_000);
    const twoClocksEntry = twoClocks.h.ledger.get("account-a", "zcode-v3-start-plan-1030-wk", T - 1_000);
    expect(twoClocksEntry?.alarmAt).toBe(START * 1000);
    expect(twoClocksEntry?.effectiveAt).toBe(EFFECTIVE * 1000);
    expect(twoClocks.h.claimCalls).toHaveLength(0);
    expect((await at(twoClocks, EFFECTIVE * 1000)).action).toBe("claimed");
  });

  it("1030-wk capture: 19:00 opens, 23:00 activates, 11-02 09:00 expires", async () => {
    const opened = openingAlarms([plan("capture", { startsAt: START, effectiveAt: EFFECTIVE, endsAt: END })], T - 60_000);
    expect(opened[0].claimAtMs).toBe(START * 1000);
    expect(opened[0].effectiveAtMs).toBe(EFFECTIVE * 1000);
    const waiting = harness({ nowMs: T + 1_000 });
    const claimed = await waiting.h.ledger.markClaimed("account-a", "zcode-v3-start-plan-1030-wk", {
      effectiveAt: EFFECTIVE * 1000, expiresAt: END * 1000,
    }, T + 1_000);
    expect(claimed.claimedAt).toBe(T + 1_000);
    await at(waiting, EFFECTIVE * 1000 - 1_000);
    expect(waiting.h.ledger.state(waiting.h.ledger.get("account-a", "zcode-v3-start-plan-1030-wk", EFFECTIVE * 1000 - 1_000), EFFECTIVE * 1000 - 1_000)).toBe("claimed");
    expect(waiting.h.ledger.state(waiting.h.ledger.get("account-a", "zcode-v3-start-plan-1030-wk", EFFECTIVE * 1000), EFFECTIVE * 1000)).toBe("effective");
    waiting.h.plans = [plan("capture", { startsAt: START, effectiveAt: EFFECTIVE, endsAt: END })];
    const expired = await at(waiting, END * 1000 + 1_000);
    expect(expired.action).toBe("idle");
    expect(waiting.h.claimCalls.some((call) => call.planId === "capture")).toBe(false);
    expect(waiting.h.ledger.state(claimed, END * 1000 + 1_000)).toBe("expired");
  });

  it("a shared-egress 429 retries after the hold with millisecond phases, not five-minute ones", async () => {
    const window = createClaimRateLimitWindow();
    const shared = { accountIndex: 1, rateLimit: window };
    const run = harness({
      ...shared,
      nowMs: T,
      claimOutcome: (planId) => ({ ok: false, planId, failureKind: "rate_limited", code: 3002, message: "slow down" }),
    });
    const first = await at(run, T + 200);
    expect(first.action).toBe("failed");
    expect(window.untilMs).toBeGreaterThan(T + 200);
    const wake = run.scheduler.holdUntilMs();
    expect(wake - (T + 200)).toBe(60_000);
    expect(run.scheduler.openingStaggerMs()).toBe(200);
    run.h.claimOutcome = { ok: true, planId: "zcode-v3-start-plan-1030-wk" };
    const retry = await at(run, Math.min(window.untilMs + 200, T + DEFAULT_OPENING.burstWindowMs - 1_000));
    expect(retry.action).toBe("claimed");
    expect(run.h.claimCalls.length).toBe(2);
  });

  it("a preheat captcha-solver failure records the same policy as 3007", async () => {
    const run = harness({ nowMs: T - DEFAULT_OPENING.preheatMs });
    run.h.captchaCalls.length = 0;
    // A local solver failure must not be retried as a generic request error.
    const scheduler = new ClaimScheduler({
      accountId: "account-a",
      accountIndex: 0,
      ledger: run.h.ledger,
      getJwt: async () => "jwt-a",
      createClient: () => ({
        discoverActivities: async () => ({ activities: run.h.plans, diagnostics: { noDelivery: false, versionGate: false, eligibility: false, reasons: [] } }),
        claim: async (planId) => ({ ok: true, planId }),
      }),
      getCaptcha: async () => { throw new Error("solver unavailable"); },
      captchaRequired: async () => true,
      config: run.h.config,
      now: () => run.h.nowMs,
    });
    const result = await scheduler.tick();
    expect(result.action).toBe("failed");
    if (result.action === "failed") {
      expect(result.outcome.failureKind).toBe("captcha");
      expect(result.outcome.code).toBe(3007);
    }
    expect(run.h.ledger.get("account-a", "zcode-v3-start-plan-1030-wk", run.h.nowMs)?.lastOutcome).toBe("captcha");
  });

  it("a synthetic new campaign with unknown fields reaches decision and claim", async () => {
    const synthetic = plan("plan-november-nova-7788", {
      startsAt: START,
      endsAt: END,
      effectiveAt: EFFECTIVE,
      source: "popup",
      raw: { experiment_bucket: "novel-field", resource_position: "popup", unknown_plan_shape: { nested: ["kept"] } },
      entitlements: [{
        entitlementId: "ent-nova-1", showName: "NOVA-QUOTA", meter: "credit_pool", unitType: "credits",
        capabilities: ["model:nova"], grantUnits: 42, period: "until_next_solstice", priority: 88,
      }],
    });
    const run = harness({ nowMs: T - 1_000, plans: [synthetic], claimOutcome: { ok: true, planId: synthetic.planId } });
    await at(run, T - 1_000);
    expect(run.h.claimCalls).toHaveLength(0);
    const result = await at(run, T);
    expect(result.action).toBe("claimed");
    expect(run.h.claimCalls[0].planId).toBe("plan-november-nova-7788");
    const entry = run.h.ledger.get("account-a", synthetic.planId, T);
    expect(entry?.effectiveAt).toBe(EFFECTIVE * 1000);
    expect(entry?.claimedAt).toBe(T);
  });
});
