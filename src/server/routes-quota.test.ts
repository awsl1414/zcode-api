/**
 * Regression tests for the GET /quota billing snapshot (routes-quota.ts).
 *
 * Invariants under test:
 *  - the platform/arch fingerprint is built from real values with env
 *    overrides (never `identity.platform/arch` → "undefined-undefined");
 *  - empty/whitespace env overrides fall back instead of producing `-x64`;
 *  - both billing calls share the same fingerprint;
 *  - upstream snake_case and live-observed camelCase balance fields both map;
 *  - non-numeric / NaN values never leak into the JSON snapshot.
 *
 * 多账号：逐账号分组、单账号失败不影响其他账号、顶层兼容字段仍在。
 */
import { describe, it, expect } from "bun:test";
import os from "node:os";
import { collectQuotaSnapshot, handleQuota } from "./routes-quota.js";
import type { ProxyConfig } from "../config/types.js";
import type { Credential } from "../auth/types.js";
import { accountFor, brokerFor, inMemoryAccounts, zhipuCredential } from "../accounts/testing.js";

/** 一账号一指纹（R1）：额度采集要按账号传指纹，单测里固定一个。*/
const TEST_DEVICE_MID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

const noAccountAccounts = () => inMemoryAccounts([]);

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
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
    clientSigning: { enabled: false }, highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
    mcp: { enabled: true, gateway: { enabled: true, upstreamOrigin: "https://zcode.chatglm.site" } },
    async: {
      enabled: false,
      origin: "https://zcode.z.ai",
      pollIntervalMs: 10,
      keepAliveIntervalMs: 5,
      maxWaitMs: 0,
      maxRetries: 3,
      settleTimeoutMs: 100,
      controlTimeoutMs: 1000,
      defaultModel: "",
    },
    claim: { enabled: false, auto: true, origin: "https://billing.example", pollIntervalMs: 300000, cooldownMs: 600000, sprintWindowMs: 1800000, sprintPollIntervalMs: 60000 },
    logging: { level: "info" },
    ...overrides,
  };
}

/** Minimal valid start-plan JWT payload (iat only, no exp). */
const IAT = Math.floor(Date.now() / 1000) - 8 * 24 * 3600; // 8 days old, still valid per jwt-age.ts docs
function makeJwt(tag = ""): string {
  const payload = Buffer.from(JSON.stringify({ iat: IAT, sub: tag })).toString("base64url");
  return `h.${payload}.s`;
}

const fakeCred: Credential = { apiKey: "key-x.secret-y", provider: "zai", jwt: makeJwt() };

/** 带一个账号的账号仓 + broker（quota surface 只借凭据，不占槽）。*/
function quotaAccounts(credential: Credential = fakeCred) {
  return brokerFor({
    kind: "zhipu-account",
    provider: credential.provider,
    apiKey: credential.apiKey,
    ...(credential.secret ? { secret: credential.secret } : {}),
    ...(credential.jwt ? { jwt: credential.jwt } : {}),
    identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
  });
}

interface BillingCall {
  url: string;
  headers: Record<string, string>;
}

/** Mock fetch that records billing/monitor calls and answers all three endpoints. */
function makeBillingFetch(opts: {
  code?: number;
  body?: unknown;
  /** Monitor-plane (coding) envelope data; defaults to an empty limits list. */
  codingBody?: unknown;
  codingCode?: number;
  /** Simulate monitor-endpoint network/HTTP failure. */
  codingFail?: boolean;
} = {}): { fetchImpl: typeof fetch; calls: BillingCall[] } {
  const calls: BillingCall[] = [];
  const record = (u: string, init?: RequestInit): void => {
    calls.push({ url: u, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
  };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/api/monitor/usage/quota/limit")) {
      record(u, init);
      if (opts.codingFail) return new Response("upstream exploded", { status: 500 });
      const code = opts.codingCode ?? 0;
      return new Response(JSON.stringify({ code, msg: "ok", data: opts.codingBody ?? { level: "max", limits: [] } }), { status: 200 });
    }
    if (u.includes("/api/v1/zcode-plan/billing/")) {
      record(u, init);
      const code = opts.code ?? 0;
      return new Response(JSON.stringify({ code, msg: "ok", data: opts.body ?? { server_time: 1720000000, balances: [], plans: [] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { type: "not_found", message: u } }), { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Calls to one plane, in request order. */
function planeCalls(calls: BillingCall[], plane: "billing" | "monitor"): BillingCall[] {
  return calls.filter((c) => c.url.includes(plane === "billing" ? "/api/v1/zcode-plan/billing/" : "/api/monitor/usage/quota/limit"));
}

/** Set/restore identity env overrides around a test body. */
async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ["ZCODE_IDENTITY_PLATFORM", "ZCODE_IDENTITY_ARCH"]) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("collectQuotaSnapshot fingerprint", () => {
  it("no overrides → real platform/arch on billing calls, raw key auth on coding call", async () => {
    await withEnv({ ZCODE_IDENTITY_PLATFORM: undefined, ZCODE_IDENTITY_ARCH: undefined }, async () => {
      const { fetchImpl, calls } = makeBillingFetch();
      const snap = await collectQuotaSnapshot(makeConfig(), fakeCred, TEST_DEVICE_MID, fetchImpl);
      const billing = planeCalls(calls, "billing");
      const monitor = planeCalls(calls, "monitor");
      expect(billing.length).toBe(2);
      expect(monitor.length).toBe(1);
      const expected = `${process.platform}-${os.arch()}`;
      expect(snap.errors).toEqual([]);
      for (const c of billing) {
        const url = new URL(c.url);
        expect(url.searchParams.get("platform")).toBe(expected);
        expect(url.searchParams.get("app_version")).toBe("test-1.0.0");
        expect(c.headers["X-Platform"]).toBe(expected);
      }
      expect(billing[0].url).toContain("/billing/balance?");
      expect(billing[1].url).toContain("/billing/preview?");
      // Coding plane mirror: bundle `wK` origin + `md` single raw-key header.
      expect(monitor[0].url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
      expect(monitor[0].headers["authorization"]).toBe("key-x.secret-y");
      expect(monitor[0].headers["accept"]).toBe("application/json");
      expect(monitor[0].headers["X-Platform"]).toBeUndefined();
      expect(snap.codingPlan).toEqual({ level: "max", limits: [] });
    });
  });

  it("valid overrides → billing calls use the overridden fingerprint (coding plane unaffected)", async () => {
    await withEnv({ ZCODE_IDENTITY_PLATFORM: "linux", ZCODE_IDENTITY_ARCH: "x64" }, async () => {
      const { fetchImpl, calls } = makeBillingFetch();
      await collectQuotaSnapshot(makeConfig(), fakeCred, TEST_DEVICE_MID, fetchImpl);
      for (const c of planeCalls(calls, "billing")) {
        const url = new URL(c.url);
        expect(url.searchParams.get("platform")).toBe("linux-x64");
        expect(c.headers["X-Platform"]).toBe("linux-x64");
      }
    });
  });

  it("empty/whitespace overrides fall back to real values (no `-x64` / `linux-`)", async () => {
    await withEnv({ ZCODE_IDENTITY_PLATFORM: "  ", ZCODE_IDENTITY_ARCH: "" }, async () => {
      const { fetchImpl, calls } = makeBillingFetch();
      await collectQuotaSnapshot(makeConfig(), fakeCred, TEST_DEVICE_MID, fetchImpl);
      const expected = `${process.platform}-${os.arch()}`;
      for (const c of planeCalls(calls, "billing")) {
        expect(new URL(c.url).searchParams.get("platform")).toBe(expected);
      }
    });
  });

  it("no JWT credential → handleQuota returns 503 quota_unavailable envelope", async () => {
    const { fetchImpl, calls } = makeBillingFetch();
    // 没有账号：broker 拒绝出线，quota 端点回 503 信封。
    const empty = noAccountAccounts();
    const resp = await handleQuota(makeConfig(), empty.broker, empty.manager, fetchImpl);
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("quota_unavailable");
    expect(calls.length).toBe(0);
  });

  it("handleQuota 200 path: samples the broker-resolved credential", async () => {
    const { fetchImpl, calls } = makeBillingFetch();
    const single = quotaAccounts();
    const resp = await handleQuota(makeConfig(), single.broker, single.manager, fetchImpl);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { accounts: Array<{ label: string }> };
    expect(body.accounts.map((a) => a.label)).toEqual(["test"]);
    // 采样的凭据来自账号仓（而不是某个全局凭据）：billing 平面的 Bearer 就是
    // 这个账号的 plan JWT。
    const billing = planeCalls(calls, "billing");
    expect(billing.length).toBe(2);
    for (const c of billing) expect(c.headers["authorization"]).toBe(`Bearer ${fakeCred.jwt}`);
  });

  it("upstream nonzero code surfaces in errors, snapshot still 200", async () => {
    const { fetchImpl } = makeBillingFetch({ code: 3012 });
    const snap = await collectQuotaSnapshot(makeConfig(), fakeCred, TEST_DEVICE_MID, fetchImpl);
    expect(snap.errors.length).toBe(2);
    expect(snap.errors[0]).toContain("3012");
  });
});

describe("collectQuotaSnapshot response mapping", () => {
  it("snake_case balance fields map (live-observed shape)", async () => {
    const body = {
      server_time: 1720000100,
      balances: [{ show_name: "Free", total_units: 1000, used_units: 250, remaining_units: 750, unit_type: "token", expires_at: 1735689600 }],
    };
    const { fetchImpl } = makeBillingFetch({ body });
    const snap = await collectQuotaSnapshot(makeConfig(), fakeCred, TEST_DEVICE_MID, fetchImpl);
    expect(snap.balances).toEqual([{ showName: "Free", remainingUnits: 750, totalUnits: 1000, usedUnits: 250, unitType: "token", expiresAt: 1735689600 }]);
  });

  it("period 归属：bucket → (user_plan_id|plan_id) → plans[].entitlements[].entitlement_id → period", async () => {
    // 官方 normalizeZaiStartPlanBalanceLimits 的同一套反查：桶自身不带 period，
    // 归属链反查 balance 载荷的套餐实例（订阅卡）。daily = 订阅周期授予、
    // one_time = 一次性/体验授予——两类套餐在数据模型上靠它区分。
    const body = {
      server_time: 1720000100,
      plans: [
        {
          user_plan_id: "up-1",
          plan_id: "start-plan-monthly",
          name: "ZCode Start Plan",
          status: "active",
          entitlements: [
            { entitlement_id: "ent-daily", show_name: "每月授予", period: "daily", effective_at: 1719900000 },
            { entitlement_id: "ent-once", show_name: "新手体验", period: "one_time", effective_at: 1719900000 },
          ],
        },
      ],
      balances: [
        {
          show_name: "Monthly grant",
          bucket_id: "bkt-1",
          user_plan_id: "up-1",
          plan_id: "start-plan-monthly",
          entitlement_id: "ent-daily",
          meter: "model_usage",
          unit_type: "token",
          capabilities: ["model:glm-5.3-flash"],
          total_units: 500_000_000,
          used_units: 100,
          remaining_units: 499_999_900,
          expires_at: 1735689600,
        },
        {
          show_name: "Trial grant",
          bucket_id: "bkt-2",
          plan_id: "start-plan-monthly", // 无 user_plan_id 时退 plan_id 归属（官方同款）
          entitlement_id: "ent-once",
          total_units: 100,
          remaining_units: 90,
        },
      ],
    };
    const { fetchImpl } = makeBillingFetch({ body });
    const snap = await collectQuotaSnapshot(makeConfig(), fakeCred, TEST_DEVICE_MID, fetchImpl);
    expect(snap.balances[0]).toEqual({
      showName: "Monthly grant",
      bucketId: "bkt-1",
      planId: "start-plan-monthly",
      userPlanId: "up-1",
      entitlementId: "ent-daily",
      period: "daily",
      meter: "model_usage",
      unitType: "token",
      capabilities: ["model:glm-5.3-flash"],
      remainingUnits: 499_999_900,
      totalUnits: 500_000_000,
      usedUnits: 100,
      expiresAt: 1735689600,
    });
    expect(snap.balances[1]!.period).toBe("one_time");
    expect(snap.balances[1]!.planId).toBe("start-plan-monthly");
    // 归属不上的桶 period 缺省（不虚构）。
    const body2 = {
      server_time: 1720000100,
      plans: [],
      balances: [{ show_name: "Orphan", entitlement_id: "ent-x", total_units: 1, remaining_units: 1 }],
    };
    const snap2 = await collectQuotaSnapshot(makeConfig(), fakeCred, TEST_DEVICE_MID, makeBillingFetch({ body: body2 }).fetchImpl);
    expect(snap2.balances[0]!.period).toBeUndefined();
  });

  it("remaining_units wins over available_units (官方：available 扣除了进行中请求的 reserved)", async () => {
    // 官方 provider 注释：Start Plan 余额必须展示 remaining_units，
    // available_units 会再扣除进行中请求的 reserved_units，不能当「剩余」兑底。
    const body = {
      server_time: 1720000100,
      balances: [
        { show_name: "Free", total_units: 1000, used_units: 250, remaining_units: 750, available_units: 700, reserved_units: 50 },
      ],
    };
    const { fetchImpl } = makeBillingFetch({ body });
    const snap = await collectQuotaSnapshot(makeConfig(), fakeCred, TEST_DEVICE_MID, fetchImpl);
    expect(snap.balances[0]!.remainingUnits).toBe(750);
  });

  it("camelCase aliases (unitType/expiresAt) map — not silently dropped", async () => {
    const body = {
      server_time: 1720000100,
      balances: [{ show_name: "Free", total_units: 100, used_units: 10, remaining_units: 90, unitType: "token", expiresAt: 1735689600 }],
    };
    const { fetchImpl } = makeBillingFetch({ body });
    const snap = await collectQuotaSnapshot(makeConfig(), fakeCred, TEST_DEVICE_MID, fetchImpl);
    expect(snap.balances[0].unitType).toBe("token");
    expect(snap.balances[0].expiresAt).toBe(1735689600);
  });

  it("preview plans keep starts/ends/effective times (snake_case + camelCase aliases)", async () => {
    // 营销活动的起止在 preview 载荷里（领取客户端 claim/client.ts 证实），采样层
    // 只收字段不换算刻度 —— 秒/毫秒归一在 accounts/quota.ts 的套餐归一里。
    const body = {
      server_time: 1720000100,
      balances: [],
      plans: [
        {
          plan_id: "wk-1114",
          name: "ZCODE WEEKEND BUILD",
          description: "weekend tokens",
          starts_at: 1719993600,
          ends_at: 1720086000,
          entitlements: [{ show_name: "GLM-5.3-Flash", grant_units: "500000000", unit_type: "token", effective_at: 1720014000 }],
        },
        {
          plan_id: "wk-1121",
          name: "ZCODE WEEKEND BUILD II",
          startsAt: 1720598400,
          endsAt: 1720684800,
          entitlements: [],
        },
      ],
    };
    const { fetchImpl } = makeBillingFetch({ body });
    const snap = await collectQuotaSnapshot(makeConfig(), fakeCred, TEST_DEVICE_MID, fetchImpl);
    expect(snap.claimablePlans[0]).toEqual({
      planId: "wk-1114",
      name: "ZCODE WEEKEND BUILD",
      description: "weekend tokens",
      startsAt: 1719993600,
      endsAt: 1720086000,
      entitlements: [{ showName: "GLM-5.3-Flash", grantUnits: 500000000, unitType: "token", effectiveAt: 1720014000 }],
    });
    expect(snap.claimablePlans[1].startsAt).toBe(1720598400);
    expect(snap.claimablePlans[1].endsAt).toBe(1720684800);
  });

  it("numeric-string timestamps/units coerce; NaN/garbage never reach the JSON", async () => {
    const body = {
      server_time: "1720000100",
      balances: [
        { show_name: "Free", total_units: "100", used_units: "x", remaining_units: "50", expires_at: "1735689600" },
        { show_name: "Bad", total_units: NaN, used_units: null, remaining_units: 7 },
      ],
    };
    const { fetchImpl } = makeBillingFetch({ body });
    const snap = await collectQuotaSnapshot(makeConfig(), fakeCred, TEST_DEVICE_MID, fetchImpl);
    expect(snap.balances[0].totalUnits).toBe(100);
    expect(snap.balances[0].usedUnits).toBe(0);
    expect(snap.balances[0].expiresAt).toBe(1735689600);
    expect(snap.balances[1].totalUnits).toBe(0); // NaN → undefined → 0, JSON.stringify would emit null
    expect(snap.balances[1].usedUnits).toBe(0);
    expect(snap.balances[1].expiresAt).toBeUndefined();
  });
});

describe("collectQuotaSnapshot coding plane", () => {
  const bigmodelCred: Credential = { apiKey: "bm-key-123", provider: "bigmodel", jwt: makeJwt() };
  const jwtLessCred: Credential = { apiKey: "key-x.secret-y", provider: "zai" };

  it("maps level + limits (numeric coercion, snake alias, type-only rows kept, unknown types verbatim)", async () => {
    const { fetchImpl } = makeBillingFetch({
      codingBody: {
        level: "max",
        limits: [
          // 官方真形：unit/number 是窗口周期身份（unit=5 & number=1 → 每月工具窗），
          // 不是总量；usage/remaining 才是用量对。
          { type: "TIME_LIMIT", number: 1, unit: 5, usage: 84, remaining: 36, percentage: 70, next_reset_time: "1720000000" },
          // 只有窗口身份、没有数字载荷的行也保留（官方 normalizeLimits 同款 filter：
          // 只要求非空 type）；判定层对它无 percentage/remaining，自然不触发任何条件。
          { type: "TOKENS_LIMIT", unit: 3, number: 5 },
          { number: 5 }, // no type → dropped (official filter keeps typed rows only)
          // 未知 type 原样保留（含官方合成的 MCP_USAGE_LIMIT——采集层不裁剪语义，
          // 判定层套整张平面统一的 percentage/remaining 契约）。
          { type: "WEEK_LIMIT", remaining: 500 },
          { type: "MCP_USAGE_LIMIT", remaining: 10 },
        ],
      },
    });
    const snap = await collectQuotaSnapshot(makeConfig(), fakeCred, TEST_DEVICE_MID, fetchImpl);
    expect(snap.codingPlan).toEqual({
      level: "max",
      limits: [
        { type: "TIME_LIMIT", unit: 5, number: 1, usage: 84, remaining: 36, percentage: 70, nextResetTime: 1720000000 },
        { type: "TOKENS_LIMIT", unit: 3, number: 5 },
        { type: "WEEK_LIMIT", remaining: 500 },
        { type: "MCP_USAGE_LIMIT", remaining: 10 },
      ],
    });
  });

  it("code 200 envelope counts as success (bundle `$_` semantics)", async () => {
    const { fetchImpl } = makeBillingFetch({ codingCode: 200, codingBody: { level: "pro", limits: [] } });
    const snap = await collectQuotaSnapshot(makeConfig(), fakeCred, TEST_DEVICE_MID, fetchImpl);
    expect(snap.errors).toEqual([]);
    expect(snap.codingPlan).toEqual({ level: "pro", limits: [] });
  });

  it("bigmodel credential → open.bigmodel.cn monitor origin with the raw key", async () => {
    const { fetchImpl, calls } = makeBillingFetch();
    await collectQuotaSnapshot(makeConfig(), bigmodelCred, TEST_DEVICE_MID, fetchImpl);
    const monitor = planeCalls(calls, "monitor");
    expect(monitor[0].url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    expect(monitor[0].headers["authorization"]).toBe("bm-key-123");
  });

  it("monitor endpoint failure degrades to codingPlan null + errors entry, credits data intact", async () => {
    const { fetchImpl } = makeBillingFetch({
      body: { server_time: 1, balances: [{ show_name: "Free", total_units: 10, remaining_units: 5 }] },
      codingFail: true,
    });
    const snap = await collectQuotaSnapshot(makeConfig(), fakeCred, TEST_DEVICE_MID, fetchImpl);
    expect(snap.codingPlan).toBeNull();
    expect(snap.errors.length).toBe(1);
    expect(snap.errors[0]).toContain("coding: 500");
    expect(snap.balances).toHaveLength(1);
  });

  it("nonzero monitor envelope code surfaces in errors, snapshot still resolves", async () => {
    const { fetchImpl } = makeBillingFetch({ codingCode: 3012 });
    const snap = await collectQuotaSnapshot(makeConfig(), fakeCred, TEST_DEVICE_MID, fetchImpl);
    expect(snap.codingPlan).toBeNull();
    expect(snap.errors.length).toBe(1);
    expect(snap.errors[0]).toContain("coding: 3012");
  });

  it("jwt-less credential still serves the coding plane (billing skipped with a note)", async () => {
    const { fetchImpl, calls } = makeBillingFetch({
      codingBody: { level: null, limits: [{ type: "TIME_LIMIT", remaining: 36, number: 120 }] },
    });
    const snap = await collectQuotaSnapshot(makeConfig(), jwtLessCred, TEST_DEVICE_MID, fetchImpl);
    expect(planeCalls(calls, "billing").length).toBe(0);
    expect(planeCalls(calls, "monitor").length).toBe(1);
    expect(snap.jwt).toBeNull();
    expect(snap.balances).toEqual([]);
    expect(snap.errors.length).toBe(1);
    expect(snap.errors[0]).toContain("no plan JWT");
    expect(snap.codingPlan).toEqual({ level: null, limits: [{ type: "TIME_LIMIT", remaining: 36, number: 120 }] });
  });

  it("unusable coding origin → coding plane silently skipped (fail-open)", async () => {
    const cfg = makeConfig();
    cfg.providers.zai.openaiBase = "not a url";
    const { fetchImpl, calls } = makeBillingFetch();
    const snap = await collectQuotaSnapshot(cfg, fakeCred, TEST_DEVICE_MID, fetchImpl);
    expect(planeCalls(calls, "monitor").length).toBe(0);
    expect(snap.codingPlan).toBeNull();
    expect(snap.errors).toEqual([]);
  });
});

/**
 * 按凭据分流的 stub：`billing` 按 plan JWT、`monitor` 按 API key 区分账号。
 *
 * 两个账号必须能"一个挂、一个正常"地并存，所以响应由**凭据**决定，而不是由 URL
 * 决定（同 provider 的两个账号打的是同一个 origin）。
 */
function perAccountFetch(opts: { monitorFailKeys?: Set<string> } = {}): typeof fetch {
  const json = (payload: unknown): Response =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    const headers = (init?.headers as Record<string, string> | undefined) ?? {};
    if (u.includes("/api/monitor/usage/quota/limit")) {
      const key = headers["authorization"] ?? "";
      if (opts.monitorFailKeys?.has(key)) return new Response("monitor exploded", { status: 500 });
      return json({
        code: 0,
        msg: "ok",
        data: { level: `level-${key}`, limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 40, remaining: 60, percentage: 40 }] },
      });
    }
    if (u.includes("/api/v1/zcode-plan/billing/")) {
      const bearer = (headers["authorization"] ?? "").replace(/^Bearer\s+/u, "");
      return json({
        code: 0,
        msg: "ok",
        data: { server_time: 1720000000, balances: [{ show_name: bearer, total_units: 10, used_units: 1, remaining_units: 9 }], plans: [] },
      });
    }
    return new Response(JSON.stringify({ error: { type: "not_found", message: u } }), { status: 404 });
  }) as typeof fetch;
}

/** 两个账号：`work-team`（zai）与 `home`（bigmodel）。*/
function twoAccounts() {
  return inMemoryAccounts([
    accountFor(zhipuCredential({ apiKey: "key-work", secret: "sec-work", jwt: makeJwt("work") }), { label: "work-team" }),
    accountFor(zhipuCredential({ provider: "bigmodel", apiKey: "key-home", secret: undefined, jwt: makeJwt("home") }), { label: "home" }),
  ]);
}

interface QuotaReportBody {
  accounts: Array<{
    label: string;
    plan: string;
    windows: Array<{ type: string; unit?: number; number?: number; usage?: number; remaining?: number; percentage?: number }>;
    credits: { available: boolean; balances: Array<{ showName: string }>; claimablePlans: unknown[] };
    stale: boolean;
    errors: string[];
  }>;
}

describe("handleQuota 多账号", () => {
  it("两个账号各自返回一份快照", async () => {
    const { broker, manager } = twoAccounts();
    const resp = await handleQuota(makeConfig(), broker, manager, perAccountFetch());
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as QuotaReportBody;

    // 逐账号分组：两个账号都在，各自带自己的窗口与 credits。
    expect(body.accounts.map((a) => a.label)).toEqual(["work-team", "home"]);
    const work = body.accounts[0]!;
    const home = body.accounts[1]!;
    expect(work.plan).toBe("coding-plan");
    expect(work.windows).toEqual([{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 40, remaining: 60, percentage: 40 }]);
    expect(work.credits.available).toBe(true);
    expect(work.stale).toBe(false);
    expect(home.stale).toBe(false);
    // 每个账号采到的是**自己**那份额度（stub 按凭据分流）。
    expect(work.credits.balances[0]!.showName).not.toBe(home.credits.balances[0]!.showName);
  });

  it("一个账号的 monitor 平面失败 → 它自己 stale，另一个账号正常", async () => {
    const { broker, manager } = twoAccounts();
    // 只让 work-team 的 coding 平面挂掉：monitor 平面用 `credentialString`（zai 是
    // `{apiKey}.{secret}`）作 authorization，按它区分账号。
    const resp = await handleQuota(makeConfig(), broker, manager, perAccountFetch({ monitorFailKeys: new Set(["key-work.sec-work"]) }));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as QuotaReportBody;
    const work = body.accounts[0]!;
    const home = body.accounts[1]!;
    expect(work.stale).toBe(true);
    expect(work.errors.some((e) => e.includes("coding: 500"))).toBe(true);
    expect(work.windows).toEqual([]);
    // 另一个账号完全不受影响。
    expect(home.stale).toBe(false);
    expect(home.errors).toEqual([]);
    expect(home.windows.length).toBe(1);
    expect(home.credits.available).toBe(true);
  });

  it("单账号：`accounts` 只有一项，顶层只剩 `accounts` 一个键", async () => {
    const single = quotaAccounts();
    const resp = await handleQuota(makeConfig(), single.broker, single.manager, perAccountFetch());
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as QuotaReportBody & Record<string, unknown>;
    // 顶层单账号快照字段（provider / serverTime / balances / codingPlan /
    // planes / errors）不在协议里：额度是账号级的，只有 `accounts[]`。
    expect(Object.keys(body)).toEqual(["accounts"]);
    expect(body.accounts.length).toBe(1);
    expect(body.accounts[0]!.label).toBe("test");
  });

  it("禁用的账号不参与采集（只列启用账号）", async () => {
    const disabled = accountFor(zhipuCredential({ apiKey: "key-off", secret: "sec-off", jwt: makeJwt() }), {
      label: "disabled-one",
      enabled: false,
    });
    const active = accountFor(zhipuCredential({ apiKey: "key-on", secret: "sec-on", jwt: makeJwt() }), { label: "enabled-one" });
    const { broker, manager } = inMemoryAccounts([active, disabled]);
    const resp = await handleQuota(makeConfig(), broker, manager, perAccountFetch());
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as QuotaReportBody;
    expect(body.accounts.map((a) => a.label)).toEqual(["enabled-one"]);
  });
});
