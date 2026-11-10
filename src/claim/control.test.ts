/**
 * claim 控制面的四条命令：配置快照、实时清单、发现层选择器、手动领取。
 * 领取动作、发现层与台账全部注入，单测不碰网络，也不写用户的存储目录。
 */
import { describe, it, expect } from "bun:test";
import { createClaimControl, type ClaimControlDeps } from "./control.js";
import type { ClaimActions, ClaimAutoClaim } from "./runtime.js";
import { ClaimPreviewError } from "./client.js";
import type { ClaimablePlan, ClaimOutcome } from "./types.js";
import type { ClaimSchedulerStatus } from "./scheduler.js";
import { createActivityLedger, type ActivityLedger } from "./ledger.js";
import { inMemoryAccounts, accountFor, zhipuCredential } from "../accounts/testing.js";
import type { Account } from "../accounts/types.js";
import type { ProxyConfig } from "../config/types.js";

function makeConfig(overrides: Partial<ProxyConfig["claim"]> = {}): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: { requireKey: false },
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: { appVersion: "test-1.0.0", appVersionSource: "default", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai", betaPolicy: "drop", betaAllowlist: [] },
    clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
    responses: { storeMaxEntries: 1000, storeTtlMs: 86400000 },
    endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: false },
    highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
    mcp: { enabled: true, gateway: { enabled: true, upstreamOrigin: "https://zcode.test" } },
    async: {
      enabled: false,
      origin: "https://zcode.z.ai",
      pollIntervalMs: 5000,
      keepAliveIntervalMs: 3000,
      maxWaitMs: 0,
      maxRetries: 3,
      settleTimeoutMs: 8000,
      controlTimeoutMs: 15000,
      defaultModel: "",
    },
    claim: {
      enabled: true,
      auto: true,
      origin: "https://zcode.test",
      pollIntervalMs: 300000,
      cooldownMs: 600000,
      opening: {
        preheatMs: 180000,
        probeIntervalMs: 10000,
        burstIntervalMs: 2000,
        burstWindowMs: 180000,
        accountStaggerMs: 200,
        maxClaimsPerAccount: 6,
      },
      policy: "upstream-priority",
      sprintWindowMs: 1800000,
      sprintPollIntervalMs: 60000,
      ...overrides,
    },
    logging: { level: "info" },
  };
}

function claimableAccount(label: string, jwt: string): Account {
  return accountFor(zhipuCredential({ jwt }), { label });
}

function plan(planId: string, extra: Partial<ClaimablePlan> = {}): ClaimablePlan {
  return {
    planId,
    name: `name-${planId}`,
    description: `desc-${planId}`,
    priority: 5,
    entitlements: [
      { entitlementId: "e1", showName: "GLM", meter: "tokens", unitType: "token", capabilities: [], grantUnits: 1000, period: "one_time", priority: 1 },
    ],
    source: "billing/preview",
    discoveryFaces: ["billing/preview"],
    raw: {},
    ...extra,
  };
}

/** 可编程的领取动作替身（`buildActions` 注入的接收端）。*/
function fakeActions(behavior: {
  plans?: ClaimablePlan[];
  previewError?: Error;
  claimOutcome?: ClaimOutcome;
  claimError?: Error;
}): ClaimActions & { claimCalls: string[]; discoverCalls: number } {
  const claimCalls: string[] = [];
  let discoverCalls = 0;
  return {
    claimCalls,
    get discoverCalls(): number {
      return discoverCalls;
    },
    discoverActivities: () => {
      discoverCalls += 1;
      if (behavior.previewError) return Promise.reject(behavior.previewError);
      return Promise.resolve({ activities: behavior.plans ?? [], diagnostics: { noDelivery: false, versionGate: false, eligibility: false, reasons: [] } });
    },
    claim: (planId: string) => {
      claimCalls.push(planId);
      if (behavior.claimError) return Promise.reject(behavior.claimError);
      return Promise.resolve(behavior.claimOutcome ?? { ok: true, planId });
    },
  };
}

/** 发现层替身：只在 `listClaimPlanChoices` 用，计数与上游错误都可控。*/
function fakeDiscovery(behavior: { plans?: ClaimablePlan[]; error?: Error }) {
  let calls = 0;
  return {
    get calls() { return calls; },
    discover: () => {
      calls += 1;
      return behavior.error ? Promise.reject(behavior.error) : Promise.resolve({ activities: behavior.plans ?? [] });
    },
  };
}

function testLedger(): ActivityLedger {
  return createActivityLedger({ memoryOnly: true, now: () => 1_700_000_000_000 });
}

const idleStatus = (holdUntilMs = 0): ClaimSchedulerStatus => ({
  stopped: false,
  holdUntilMs,
  phaseMs: 0,
  planHolds: {},
});

async function autoClaimFor(
  accounts: Account[],
  statuses: (account: Account) => ClaimSchedulerStatus | null,
  noted: ClaimOutcome[] = [],
): Promise<ClaimAutoClaim> {
  return {
    runtimes: accounts.map((account) => ({
      accountId: account.id,
      label: account.label,
      scheduler: {
        start(): void {},
        stop(): void {},
        ...(statuses(account)
          ? {
              status: () => statuses(account) as ClaimSchedulerStatus,
              noteOutcome: (outcome: ClaimOutcome) => {
                noted.push(outcome);
              },
            }
          : {}),
      },
    })),
    stop(): void {},
  };
}

describe("claim control — getClaimOverview", () => {
  it("returns the config snapshot and only claim-capable account rows (pure memory read)", async () => {
    const work = claimableAccount("work", "jwt-work");
    const other = claimableAccount("other", "jwt-other");
    const { manager } = inMemoryAccounts([work, other]);
    const control = createClaimControl({ config: makeConfig(), accounts: manager, getAutoClaim: () => null, ledger: testLedger() });
    const result = await control.getOverview();
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    expect(result.value.config.policy).toBe("upstream-priority");
    expect(result.value.config.opening.preheatMs).toBe(180000);
    expect(Object.keys(result.value.config).sort()).toEqual([
      "auto", "cooldownMs", "enabled", "opening", "origin", "policy", "pollIntervalMs", "sprintPollIntervalMs", "sprintWindowMs",
    ]);
    expect(result.value.config.enabled).toBe(true);
    expect(result.value.config.auto).toBe(true);
    expect(result.value.accounts.map((row) => row.label).sort()).toEqual(["other", "work"]);
    expect(result.value.accounts.every((row) => row.running === false && row.holdUntil === undefined)).toBe(true);
  });

  it("maps scheduler status into the account row (running, holdUntil, planHolds, last)", async () => {
    const work = claimableAccount("work", "jwt-work");
    const { manager } = inMemoryAccounts([work]);
    const noted: ClaimOutcome[] = [];
    const group = await autoClaimFor([work], () => ({
      stopped: false,
      holdUntilMs: 1_234_567,
      phaseMs: 42,
      planHolds: { "weekend-1": { until: 2_000_000, reason: "claimed" } },
      last: { at: 1_000, action: "failed", source: "auto", planId: "weekend-1", failureKind: "quota_exhausted", code: 1005 },
    }), noted);
    const control = createClaimControl({ config: makeConfig(), accounts: manager, getAutoClaim: () => group, ledger: testLedger() });
    const result = await control.getOverview();
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    const row = result.value.accounts[0];
    expect(row).toMatchObject({
      label: "work",
      running: true,
      holdUntil: 1_234_567,
      last: { action: "failed", failureKind: "quota_exhausted", code: 1005 },
    });
    expect(row.planHolds?.["weekend-1"]).toEqual({ until: 2_000_000, reason: "claimed" });
  });

  it("enriches each account row with ledgerState, nextCheckAt, openingAt and userAction", async () => {
    const work = claimableAccount("work", "jwt-work");
    const { manager } = inMemoryAccounts([work]);
    const ledger = testLedger();
    await ledger.markClaimed(work.id, "weekend-1", { effectiveAt: 1_700_003_600_000 }, 1_700_000_000_000);
    const group = await autoClaimFor([work], () => ({
      ...idleStatus(1_700_060_000_000),
      nextCheckAtMs: 1_700_060_000_000,
      nextOpeningAtMs: 1_700_120_000_000,
      last: { at: 1_700_000_000_000, action: "failed", source: "auto", planId: "weekend-1", failureKind: "captcha", code: 3007, userAction: "manual-captcha" },
    }));
    const control = createClaimControl({ config: makeConfig(), accounts: manager, getAutoClaim: () => group, ledger, now: () => 1_700_000_000_000 });
    const result = await control.getOverview();
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    const row = result.value.accounts[0];
    expect(row.ledgerState).toBe("claimed");
    expect(row.userAction).toBe("manual-captcha");
    expect(row.nextCheckAt).toBeGreaterThanOrEqual(1_700_060_000_000);
    expect(row.openingAt).toBe(1_700_120_000_000);
    expect(row.last?.userAction).toBe("manual-captcha");
  });

  it("marks stopped schedulers (login_required terminal case)", async () => {
    const work = claimableAccount("work", "jwt-work");
    const { manager } = inMemoryAccounts([work]);
    const group = await autoClaimFor([work], () => ({ ...idleStatus(9_999), stopped: true }));
    const control = createClaimControl({ config: makeConfig(), accounts: manager, getAutoClaim: () => group, ledger: testLedger() });
    const result = await control.getOverview();
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    expect(result.value.accounts[0]).toMatchObject({ running: true, stopped: true });
  });
});

describe("claim control — previewClaimPlans", () => {
  it("returns the merged plan list for a claimable account", async () => {
    const { manager } = inMemoryAccounts([claimableAccount("work", "jwt-work")]);
    const actions = fakeActions({ plans: [plan("weekend-1"), plan("wk-1108", { source: "marketing/touch", discoveryFaces: ["marketing/touch"], campaignId: "c1" })] });
    const control = createClaimControl({ config: makeConfig(), accounts: manager, getAutoClaim: () => null, buildActions: () => actions, ledger: testLedger() });
    const result = await control.previewPlans("work");
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    expect(result.value.map((p) => p.planId)).toEqual(["weekend-1", "wk-1108"]);
    expect(actions.discoverCalls).toBe(1);
  });

  it("answers account_not_found for unknown labels and non-claim credentials", async () => {
    const { manager } = inMemoryAccounts([claimableAccount("work", "jwt-work")]);
    const control = createClaimControl({ config: makeConfig(), accounts: manager, getAutoClaim: () => null, buildActions: () => fakeActions({}), ledger: testLedger() });
    expect(await control.previewPlans("ghost")).toEqual({ ok: false, code: "account_not_found" });
  });

  it("maps 429 to claim_rate_limited and other upstream failures to claim_preview_failed", async () => {
    const { manager } = inMemoryAccounts([claimableAccount("work", "jwt-work")]);
    const rateLimited = createClaimControl({
      config: makeConfig(),
      accounts: manager,
      getAutoClaim: () => null,
      buildActions: () => fakeActions({ previewError: new ClaimPreviewError("limited", 429, 429, 30) }),
      ledger: testLedger(),
    });
    expect(await rateLimited.previewPlans("work")).toMatchObject({ ok: false, code: "claim_rate_limited" });

    const broken = createClaimControl({
      config: makeConfig(),
      accounts: manager,
      getAutoClaim: () => null,
      buildActions: () => fakeActions({ previewError: new ClaimPreviewError("boom", 500, -1) }),
      ledger: testLedger(),
    });
    expect(await broken.previewPlans("work")).toMatchObject({ ok: false, code: "claim_preview_failed" });
  });
});

describe("claim control — listClaimPlanChoices", () => {
  it("projects the discovery list into choices, with effectiveAt and ledger state, without raw", async () => {
    const account = claimableAccount("work", "jwt-work");
    const { manager } = inMemoryAccounts([account]);
    const discovery = fakeDiscovery({
      plans: [
        plan("weekend-1", { name: "周末免费", description: "周末两天", priority: 9, startsAt: 1_700_000_000, endsAt: 1_700_100_000, effectiveAt: 1_700_003_600 }),
        plan("wk-1108", { source: "marketing/touch", campaignId: "c1", raw: { unknown_field: 1 } }),
      ],
    });
    const ledger = testLedger();
    await ledger.markClaimed(account.id, "weekend-1", { effectiveAt: 1_700_000_000_000 }, 1_700_000_000_000);
    const control = createClaimControl({
      config: makeConfig(), accounts: manager, getAutoClaim: () => null,
      discover: discovery.discover, ledger, now: () => 1_700_000_000_000,
    });
    const result = await control.listPlanChoices();
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    expect(result.value.accountLabel).toBe("work");
    expect(result.value.plans).toEqual([
      { planId: "weekend-1", name: "周末免费", description: "周末两天", priority: 9, source: "billing/preview", startsAt: 1_700_000_000, endsAt: 1_700_100_000, effectiveAt: 1_700_003_600, ledgerState: "effective" },
      { planId: "wk-1108", name: "name-wk-1108", description: "desc-wk-1108", priority: 5, source: "marketing/touch" },
    ]);
    expect(JSON.stringify(result.value)).not.toContain("unknown_field");
    expect(JSON.stringify(result.value)).not.toContain("entitlements");
    expect(discovery.calls).toBe(1);
  });

  it("keeps claimed activities in the choice list (ledger annotates, never filters)", async () => {
    const account = claimableAccount("work", "jwt-work");
    const { manager } = inMemoryAccounts([account]);
    const ledger = testLedger();
    await ledger.markExhausted(account.id, "weekend-1", {}, 1_700_000_000_000);
    const control = createClaimControl({
      config: makeConfig(), accounts: manager, getAutoClaim: () => null,
      discover: fakeDiscovery({ plans: [plan("weekend-1")] }).discover,
      ledger, now: () => 1_700_000_000_000,
    });
    const result = await control.listPlanChoices();
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    expect(result.value.plans[0]?.ledgerState).toBe("exhausted");
  });

  it("answers an empty list (not an error) when no account can claim", async () => {
    const keyOnly = accountFor(zhipuCredential({ jwt: undefined }), { label: "key-only" });
    const { manager } = inMemoryAccounts([keyOnly]);
    const discovery = fakeDiscovery({ plans: [plan("weekend-1")] });
    const control = createClaimControl({ config: makeConfig(), accounts: manager, getAutoClaim: () => null, discover: discovery.discover, ledger: testLedger() });
    expect(await control.listPlanChoices()).toEqual({ ok: true, value: { plans: [] } });
    expect(discovery.calls).toBe(0);
  });

  it("prefers an enabled account over a disabled one", async () => {
    const disabled = claimableAccount("old", "jwt-old");
    disabled.enabled = false;
    const work = claimableAccount("work", "jwt-work");
    const { manager } = inMemoryAccounts([disabled, work]);
    const control = createClaimControl({
      config: makeConfig(), accounts: manager, getAutoClaim: () => null,
      discover: fakeDiscovery({ plans: [] }).discover, ledger: testLedger(),
    });
    const result = await control.listPlanChoices();
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    expect(result.value.accountLabel).toBe("work");
  });

  it("maps discovery failures to the same stable codes as previewClaimPlans", async () => {
    const { manager } = inMemoryAccounts([claimableAccount("work", "jwt-work")]);
    const rateLimited = createClaimControl({
      config: makeConfig(), accounts: manager, getAutoClaim: () => null,
      discover: fakeDiscovery({ error: new ClaimPreviewError("limited", 429, 429, 30) }).discover,
      ledger: testLedger(),
    });
    expect(await rateLimited.listPlanChoices()).toMatchObject({ ok: false, code: "claim_rate_limited" });

    const broken = createClaimControl({
      config: makeConfig(), accounts: manager, getAutoClaim: () => null,
      discover: fakeDiscovery({ error: new ClaimPreviewError("boom", 500, -1) }).discover,
      ledger: testLedger(),
    });
    expect(await broken.listPlanChoices()).toMatchObject({ ok: false, code: "claim_preview_failed" });
  });
});

describe("claim control — claimNow", () => {
  async function makeDeps(
    actions: ReturnType<typeof fakeActions>,
    withGroup: boolean,
  ): Promise<ClaimControlDeps & { noted: ClaimOutcome[]; account: Account }> {
    const work = claimableAccount("work", "jwt-work");
    const { manager } = inMemoryAccounts([work]);
    const noted: ClaimOutcome[] = [];
    const group = withGroup ? await autoClaimFor([work], () => idleStatus(), noted) : null;
    return {
      config: makeConfig(),
      accounts: manager,
      getAutoClaim: () => group,
      buildActions: () => actions,
      ledger: testLedger(),
      now: () => 1_700_000_000_000,
      noted,
      account: work,
    };
  }

  it("claims a listed plan, notes the scheduler and writes the ledger", async () => {
    const actions = fakeActions({
      plans: [plan("weekend-1", { startsAt: 1_700_000_000, effectiveAt: 1_700_003_600, endsAt: 1_700_100_000 })],
      claimOutcome: { ok: true, planId: "weekend-1", startsAt: 1_700_000_000, endsAt: 1_700_100_000 },
    });
    const deps = await makeDeps(actions, true);
    const control = createClaimControl(deps);
    const result = await control.claimNow("work", "weekend-1");
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    expect(result.value).toEqual({ ok: true, planId: "weekend-1", startsAt: 1_700_000_000, endsAt: 1_700_100_000 });
    expect(actions.claimCalls).toEqual(["weekend-1"]);
    expect(deps.noted).toEqual([{ ok: true, planId: "weekend-1", startsAt: 1_700_000_000, endsAt: 1_700_100_000 }]);
    const entry = deps.ledger?.get(deps.account.id, "weekend-1", 1_700_000_000_000);
    expect(entry?.claimedAt).toBe(1_700_000_000_000);
    expect(entry?.effectiveAt).toBe(1_700_003_600_000);
    expect(entry?.expiresAt).toBe(1_700_100_000_000);
  });

  it("rejects plans that are not in the current dual-face list without a claim POST", async () => {
    const actions = fakeActions({ plans: [plan("weekend-1")] });
    const control = createClaimControl(await makeDeps(actions, false));
    expect(await control.claimNow("work", "ghost-plan")).toEqual({ ok: false, code: "claim_plan_not_listed" });
    expect(actions.claimCalls).toEqual([]);
  });

  it("passes upstream failure outcomes through verbatim (and notes them)", async () => {
    const actions = fakeActions({
      plans: [plan("weekend-1")],
      claimOutcome: { ok: false, planId: "weekend-1", failureKind: "already_claimed", code: 1003, message: "claimed" },
    });
    const deps = await makeDeps(actions, true);
    const control = createClaimControl(deps);
    const result = await control.claimNow("work", "weekend-1");
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    expect(result.value).toMatchObject({ ok: false, failureKind: "already_claimed", code: 1003 });
    expect(deps.noted).toHaveLength(1);
    expect(deps.ledger?.get(deps.account.id, "weekend-1", 1_700_000_000_000)?.claimedAt).toBeUndefined();
  });

  it("marks quota exhaustion in the ledger", async () => {
    const actions = fakeActions({
      plans: [plan("weekend-1")],
      claimOutcome: { ok: false, planId: "weekend-1", failureKind: "quota_exhausted", code: 1005, message: "quota" },
    });
    const deps = await makeDeps(actions, false);
    await createClaimControl(deps).claimNow("work", "weekend-1");
    expect(deps.ledger?.get(deps.account.id, "weekend-1", 1_700_000_000_000)?.exhaustedAt).toBe(1_700_000_000_000);
  });

  it("maps captcha mint failure to claim_captcha_unavailable", async () => {
    const actions = fakeActions({ plans: [plan("weekend-1")], claimError: new Error("captcha config flipped to disabled between gate and mint") });
    const control = createClaimControl(await makeDeps(actions, false));
    expect(await control.claimNow("work", "weekend-1")).toMatchObject({ ok: false, code: "claim_captcha_unavailable" });
  });

  it("maps network failures to claim_request_failed", async () => {
    const actions = fakeActions({ plans: [plan("weekend-1")], claimError: new Error("connection reset") });
    const control = createClaimControl(await makeDeps(actions, false));
    expect(await control.claimNow("work", "weekend-1")).toMatchObject({ ok: false, code: "claim_request_failed" });
  });

  it("writes one shared outcome path for manual and automatic results", async () => {
    const actions = fakeActions({
      plans: [plan("weekend-1", { endsAt: 1_700_100_000 })],
      claimOutcome: { ok: false, planId: "weekend-1", failureKind: "unknown", code: 9999, message: "new rejection" },
    });
    const deps = await makeDeps(actions, true);
    const control = createClaimControl(deps);
    const result = await control.claimNow("work", "weekend-1");
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    const entry = deps.ledger?.get(deps.account.id, "weekend-1", 1_700_000_000_000);
    expect(entry?.lastCode).toBe(9999);
    expect(entry?.claimedAt).toBeUndefined();
    expect(deps.noted).toHaveLength(1);
    expect(deps.noted[0]).toMatchObject({ ok: false, code: 9999 });
  });

  it("no scheduler running (auto off) → claim succeeds without linkage", async () => {
    const actions = fakeActions({ plans: [plan("weekend-1")], claimOutcome: { ok: true, planId: "weekend-1" } });
    const control = createClaimControl(await makeDeps(actions, false));
    const result = await control.claimNow("work", "weekend-1");
    expect(result.ok).toBe(true);
  });
});
