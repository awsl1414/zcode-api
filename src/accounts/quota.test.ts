/**
 * 额度采集与 drained 判定的用例（验收口径：「start-plan 用完自动切
 * coding-plan」）。
 *
 * 覆盖采样与判定两端：
 *
 * 1. **两套平面归一**：一次快照里 credits 与 coding 各自映射到对应路由；
 * 2. **失败保留上次值 + stale**：按平面判脏，coding 挂了不许把 start-plan
 *    的结果一起清空；
 * 3. **错峰 + 抖动**：账号哈希相位不同、轮次间隔带 ±5% 抖动；
 * 4. **空闲跳过**：从不活跃/久未活跃的账号不采，但 drained 的账号必须继续采；
 * 5. **四条 drained 判定**：percentage / remaining / credits 三条在采样侧，错误码那条在
 *    `broker-quota.test.ts`（需要请求侧的上报入口）；
 * 6. **until = nextResetTime**（秒 → 毫秒）与**恢复 markOk**。
 *
 * @see 数据源 · 采集 · drained 判定
 */
import { describe, expect, it } from "bun:test";
import { ActivityClock } from "./activity.js";
import { HealthEngine } from "./health.js";
import {
  createQuotaSampler,
  DEFAULT_ACCOUNTS_QUOTA,
  evaluateDrain,
  QuotaSampler,
  quotaPlane,
  type RouteQuota,
} from "./quota.js";
import { accountFor, inMemoryAccounts, zhipuCredential } from "./testing.js";
import { normalizePersonalSubscription } from "./subscription.js";
import type { Account, QuotaWindow } from "./types.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";

const IDENTITY: ProxyIdentity = {
  appVersion: "test-1.0.0",
  appVersionSource: "default",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
  betaPolicy: "drop",
  betaAllowlist: [],
};

const CONFIG: ProxyConfig = {
  server: { port: 0, host: "127.0.0.1" },
  auth: { requireKey: false },
  providers: {
    zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
    bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
  },
  defaultModel: "glm-4.6",
  models: ["glm-4.6"],
  identity: IDENTITY,
  clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
  responses: { storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false },
  highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
  mcp: { enabled: true, gateway: { enabled: true, upstreamOrigin: "https://zcode.z.ai" } },
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
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, sprintWindowMs: 1800000, sprintPollIntervalMs: 60000 },
  logging: { level: "info" },
};

/** 两条额度路由都在白名单里的账号（凭据同时带 apiKey 对与 plan JWT）。*/
function dualRouteAccount(label = "a"): Account {
  return accountFor(
    zhipuCredential({ apiKey: `key-${label}`, secret: `secret-${label}`, jwt: `jwt-${label}` }),
    { label, routes: ["start-plan", "coding-plan"] },
  );
}

/** 一个可复现的最小 JWT（`routes-quota.ts` 只需要能解出 iat）。*/
const IAT = Math.floor(Date.now() / 1000) - 8 * 24 * 3600;

interface PlaneScript {
  /** 订阅产品的上游响应；缺省 = 一轮合法的当前期个人订阅，所以只测额度的用例
      `stale` 语义不受影响，订阅自身的失败/团队形态另有专测。*/
  subscription?: { status?: number; body?: unknown; fail?: boolean };
  /** credits 平面的 buckets（`billing/balance` 的 `data.balances`）。*/
  balances?: Array<Record<string, unknown>>;
  /** 已持有的套餐实例（`billing/balance` 的 `data.plans`，对应
      `docs/research/plan-system.md` 的 2.1 节实例层）。*/
  balancePlans?: Array<Record<string, unknown>>;
  /** credits 平面的可领套餐（`billing/preview` 的 `data.plans`）。*/
  plans?: Array<Record<string, unknown>>;
  /** coding 平面的窗口（`monitor/usage/quota/limit` 的 `data.limits`）。*/
  limits?: Array<Record<string, unknown>>;
  /** coding 端点失败（模拟上游挂掉）。*/
  codingFail?: boolean;
  /** credits 平面业务码（非 0 即失败 envelope）。*/
  billingCode?: number;
}

interface PlaneFetch {
  fetchImpl: typeof fetch;
  /** `billing` / `coding` / `subscription` 三个平面各被问了几次。*/
  calls: { billing: number; coding: number; subscription: number };
  /** 订阅请求的方法 / URL / 头（断言官方 GET 与凭据分流用）。*/
  subscriptionRequests: Array<{ url: string; method: string; headers: Record<string, string> }>;
}

/** 两套额度平面 + 订阅产品的 mock 上游；每个平面可独立失败。*/
function planeFetch(script: PlaneScript): PlaneFetch {
  const calls = { billing: 0, coding: 0, subscription: 0 };
  const subscriptionRequests: PlaneFetch["subscriptionRequests"] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/api/biz/subscription/list") || u.includes("/api/biz/team/subscribe/product/querySubscribeDetail")) {
      calls.subscription += 1;
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
      subscriptionRequests.push({ url: u, method: init?.method ?? "GET", headers });
      const probe = script.subscription ?? {};
      if (probe.fail) throw new Error("subscription upstream offline");
      return new Response(
        JSON.stringify(probe.body ?? {
          code: 200,
          success: true,
          data: [{
            productId: "coding-plan-pro",
            productName: "GLM Coding Plan Pro",
            status: "VALID",
            inCurrentPeriod: true,
            autoRenew: true,
            nextRenewTime: "2026-12-09 09:00:00",
            valid: "2026-11-09 至 2027-11-09",
            billingCycle: "MONTHLY",
          }],
        }),
        { status: probe.status ?? 200 },
      );
    }
    if (u.includes("/api/monitor/usage/quota/limit")) {
      calls.coding += 1;
      if (script.codingFail) return new Response("upstream exploded", { status: 500 });
      return new Response(
        JSON.stringify({ code: 0, msg: "ok", data: { level: "max", limits: script.limits ?? [] } }),
        { status: 200 },
      );
    }
    if (u.includes("/api/v1/zcode-plan/billing/")) {
      calls.billing += 1;
      const code = script.billingCode ?? 0;
      // balance 与 preview 的 `plans[]` 是两份列表（实例 vs 可领活动，见
      // `docs/research/plan-system.md` 的 5.3 节），
      // mock 也分开喂——同一份载荷喂两端会把「可领」永远撞成「已领」。
      const isPreview = u.includes("/billing/preview");
      return new Response(
        JSON.stringify({
          code,
          msg: code === 0 ? "ok" : "nope",
          data: {
            server_time: 1_720_000_000,
            balances: script.balances ?? [],
            plans: isPreview ? (script.plans ?? []) : (script.balancePlans ?? []),
          },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: { type: "not_found" } }), { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls, subscriptionRequests };
}

/** 采样器 + 可推进的时钟（`now` 注入，不真的 sleep）。*/
function harness(options: {
  accounts?: Account[];
  script: PlaneScript;
  pollSeconds?: number;
  random?: () => number;
  /** 与样本共用同一个物理时钟：健康表与采样器必须一致，否则 `until` 断言会漂。*/
  clockValue?: { now: number };
}) {
  const clock = options.clockValue ?? { now: 1_720_000_000_000 };
  const now = (): number => clock.now;
  const accounts = options.accounts ?? [dualRouteAccount()];
  const { manager, broker } = inMemoryAccounts(accounts, { now });
  const health = new HealthEngine(now);
  const activity = new ActivityClock(now);
  const planes = planeFetch(options.script);
  const sampler = new QuotaSampler({
    config: CONFIG,
    accounts: manager,
    health,
    activity,
    quota: { pollSeconds: options.pollSeconds ?? 100 },
    fetchImpl: planes.fetchImpl,
    now,
    ...(options.random ? { random: options.random } : {}),
  });
  return { clock, now, accounts, manager, broker, health, activity, sampler, planes };
}

/**
 * 订阅采样夹具：把 `planeFetch` 的额度/订阅 mock 与调用记录单独带出来，
 * 断言「一个串行 tick = 一次订阅 GET」及团队凭据分流不动其它平面。
 */
function subscriptionHarness(options: {
  account?: Account;
  script: PlaneScript;
  pollSeconds?: number;
}) {
  const { accounts, sampler, planes, clock } = harness({
    accounts: [options.account ?? dualRouteAccount()],
    script: options.script,
    ...(options.pollSeconds !== undefined ? { pollSeconds: options.pollSeconds } : {}),
  });
  return { accounts, sampler, planes, clock };
}

// ---------------------------------------------------------------------------
// 1. 两套平面归一
// ---------------------------------------------------------------------------

describe("quota 采样：两套平面归一", () => {
  it("quotaPlane 映射：start-plan→credits，coding 系→coding", () => {
    expect(quotaPlane("start-plan")).toBe("credits");
    expect(quotaPlane("coding-plan")).toBe("coding");
    // 派生入口继承母体，额度就是 coding 平面那套窗口。
    expect(quotaPlane("off-peak")).toBe("coding");
    expect(quotaPlane("highspeed")).toBe("coding");
  });

  it("同一账号的两条路由各自归一：start-plan 看 credits 合计，coding-plan 看窗口", async () => {
    const { sampler, accounts, planes } = harness({
      script: {
        balances: [
          { show_name: "Free", total_units: 1000, used_units: 250, remaining_units: 750, unit_type: "token" },
          { show_name: "Pack", total_units: 500, used_units: 100, remaining_units: 400, unit_type: "token" },
        ],
        limits: [
          // 官方真形：unit=3 & number=5 → 5 小时 token 窗；unit=5 & number=1 →
          // 每月工具调用窗。unit/number 是窗口身份，不是总量。
          { type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 500, remaining: 1500, percentage: 25, next_reset_time: 1_720_003_600 },
          { type: "TIME_LIMIT", unit: 5, number: 1, remaining: 7, percentage: 30 },
        ],
      },
    });

    const samples = (await sampler.sampleNow(accounts[0]!.id, "test"))!;
    expect(samples.length).toBe(2);
    // 只问一次上游：两套平面一次拿齐（逐路由各打一次等于把探测频率翻倍）。
    expect(planes.calls.billing).toBe(2); // balance + preview
    expect(planes.calls.coding).toBe(1);

    const startPlan = sampler.sample(accounts[0]!.id, "start-plan")!;
    expect(startPlan.stale).toBe(false);
    expect(startPlan.quota!.windows).toEqual([]);
    // 多个 bucket 合计（只有一个 remainingUnits 口径）。
    expect(startPlan.quota!.credits).toEqual({ remainingUnits: 1150, totalUnits: 1500 });

    const coding = sampler.sample(accounts[0]!.id, "coding-plan")!;
    expect(coding.stale).toBe(false);
    // nextResetTime 在归一层统一成毫秒（上游两种刻度都发过；展示层直接减 Date.now()）。
    // unit/number（窗口周期身份）原样透传：展示层靠 (type, unit, number) 区分
    // 5 小时 / 每周 / 工具调用三格；它们不参与判定（见下方 drained 判定用例）。
    expect(coding.quota!.windows).toEqual([
      { type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 500, remaining: 1500, percentage: 25, nextResetTime: 1_720_003_600_000 },
      { type: "TIME_LIMIT", unit: 5, number: 1, remaining: 7, percentage: 30 },
    ]);
    expect(coding.quota!.credits).toBeUndefined();
  });

  it("unit/number 缺失时不注水（只有 type 的窗口照旧归一）", async () => {
    // 上游某些窗口只发 type + percentage（实弹：5 小时窗生命初期就是这个形态）。
    // 缺身份就是缺，不要补 0 —— 0 会被展示层当成合法身份去查窗。
    const { sampler, accounts } = harness({
      script: { limits: [{ type: "TOKENS_LIMIT", percentage: 0 }] },
    });
    await sampler.sampleNow(accounts[0]!.id, "test");
    const coding = sampler.sample(accounts[0]!.id, "coding-plan")!;
    expect(coding.quota!.windows).toEqual([{ type: "TOKENS_LIMIT", percentage: 0 }]);
  });

  it("窗口 nextResetTime 已是毫秒时不被二次换算", async () => {
    const msReset = 1_720_003_600_000;
    const { sampler, accounts } = harness({
      script: {
        limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 500, remaining: 1500, percentage: 25, next_reset_time: msReset }],
      },
    });
    await sampler.sampleNow(accounts[0]!.id, "test");
    const coding = sampler.sample(accounts[0]!.id, "coding-plan")!;
    expect(coding.quota!.windows[0]!.nextResetTime).toBe(msReset);
  });

});

// ---------------------------------------------------------------------------
// 1a-2. 套餐三段归一：余额桶 balances、套餐实例 plans、可领活动 campaigns
// ---------------------------------------------------------------------------

describe("quota 采样：套餐三段归一", () => {
  it("credits 平面把 bucket 明细、套餐实例与可领活动一并搬出：名字、毫秒刻度、状态判定", async () => {
    const { sampler, accounts } = harness({
      script: {
        balances: [
          {
            show_name: "GLM-5.3-Flash",
            plan_id: "wk-1114",
            total_units: 500_000_000,
            used_units: 159_000_000,
            remaining_units: 341_000_000,
            unit_type: "token",
            expires_at: 1_720_086_000, // Unix 秒 → 采样层归一到毫秒
          },
        ],
        // balance 的 plans[]：套餐实例（套餐卡数据源，卡片名 = name）。
        balancePlans: [
          {
            plan_id: "wk-1114",
            user_plan_id: "up-1114",
            name: "ZCODE WEEKEND BUILD",
            status: "active",
            starts_at: 1_719_993_600,
            ends_at: 1_720_086_000,
            entitlements: [
              { entitlement_id: "ent-1", show_name: "GLM-5.3-Flash", period: "one_time", effective_at: 1_720_014_000 },
            ],
          },
        ],
        // preview 的 plans[]：可领活动（本期活动段）。
        plans: [
          {
            plan_id: "wk-1114",
            name: "ZCODE WEEKEND BUILD",
            description: "weekend tokens",
            starts_at: 1_719_993_600,
            ends_at: 1_720_086_000,
            entitlements: [
              { show_name: "GLM-5.3-Flash", grant_units: 500_000_000, unit_type: "token", effective_at: 1_720_014_000 },
            ],
          },
          { plan_id: "start", name: "ZCode Start Plan", entitlements: [] },
        ],
      },
    });

    await sampler.sampleNow(accounts[0]!.id, "test");
    const startPlan = sampler.sample(accounts[0]!.id, "start-plan")!;
    expect(startPlan.quota!.balances).toEqual([
      {
        name: "GLM-5.3-Flash",
        planId: "wk-1114",
        remainingUnits: 341_000_000,
        totalUnits: 500_000_000,
        unitType: "token",
        expiresAt: 1_720_086_000_000,
        // 领取记录是 claim 子系统的本地结果，采样数据里没有，恒缺省。
      },
    ]);
    // 套餐实例：时间归一到毫秒、status 原值与 entitlements 逐字段透传。
    expect(startPlan.quota!.plans).toEqual([
      {
        planId: "wk-1114",
        userPlanId: "up-1114",
        name: "ZCODE WEEKEND BUILD",
        status: "active",
        startsAt: 1_719_993_600_000,
        endsAt: 1_720_086_000_000,
        entitlements: [{ entitlementId: "ent-1", showName: "GLM-5.3-Flash", period: "one_time", effectiveAt: 1_720_014_000_000 }],
      },
    ]);
    // planId 命中套餐实例 → 已领；另一个活动没人领 → 可领。都是 preview 来源。
    expect(startPlan.quota!.campaigns).toEqual([
      {
        planId: "wk-1114",
        name: "ZCODE WEEKEND BUILD",
        description: "weekend tokens",
        startsAt: 1_719_993_600_000,
        endsAt: 1_720_086_000_000,
        status: "claimed",
        entitlements: [
          { showName: "GLM-5.3-Flash", grantUnits: 500_000_000, unitType: "token", effectiveAt: 1_720_014_000_000 },
        ],
        source: "preview",
      },
      {
        planId: "start",
        name: "ZCode Start Plan",
        status: "claimable",
        entitlements: [],
        source: "preview",
      },
    ]);
  });

  it("period/planId 等归属字段随桶透传到归一形态（period = 授予/重置周期文案）", async () => {
    const { sampler, accounts } = harness({
      script: {
        balancePlans: [
          {
            plan_id: "start-plan-monthly",
            status: "active",
            entitlements: [
              { entitlement_id: "ent-daily", show_name: "每月授予", period: "daily" },
              { entitlement_id: "ent-once", show_name: "新手体验", period: "one_time" },
            ],
          },
        ],
        balances: [
          {
            show_name: "Monthly grant",
            bucket_id: "bkt-1",
            plan_id: "start-plan-monthly",
            entitlement_id: "ent-daily",
            meter: "model_usage",
            unit_type: "token",
            capabilities: ["model:glm-5.3-flash"],
            total_units: 500,
            used_units: 100,
            remaining_units: 400,
          },
          {
            show_name: "Trial grant",
            bucket_id: "bkt-2",
            plan_id: "start-plan-monthly",
            entitlement_id: "ent-once",
            unit_type: "token",
            total_units: 50,
            remaining_units: 50,
          },
        ],
      },
    });
    await sampler.sampleNow(accounts[0]!.id, "test");
    const balances = sampler.sample(accounts[0]!.id, "start-plan")!.quota!.balances!;
    // period 归属在采集层反查（官方 normalizeZaiStartBalanceLimits 同款），
    // 采样层原样透传。daily（每日重置）与 one_time（一次性）是「刷新周期」文案的
    // 数据源——**不是**订阅/体验的分类标记，官方从不用 period 判类型。
    expect(balances).toEqual([
      {
        name: "Monthly grant",
        bucketId: "bkt-1",
        planId: "start-plan-monthly",
        entitlementId: "ent-daily",
        period: "daily",
        meter: "model_usage",
        unitType: "token",
        capabilities: ["model:glm-5.3-flash"],
        remainingUnits: 400,
        totalUnits: 500,
      },
      {
        name: "Trial grant",
        bucketId: "bkt-2",
        planId: "start-plan-monthly",
        entitlementId: "ent-once",
        period: "one_time",
        unitType: "token",
        remainingUnits: 50,
        totalUnits: 50,
      },
    ]);
  });

  it("平面答了但没套餐：balances / plans / campaigns 是空数组，不缺省（空态要能和没采过区分开）", async () => {
    const { sampler, accounts } = harness({ script: {} });
    await sampler.sampleNow(accounts[0]!.id, "test");
    const startPlan = sampler.sample(accounts[0]!.id, "start-plan")!;
    expect(startPlan.quota!.balances).toEqual([]);
    expect(startPlan.quota!.plans).toEqual([]);
    expect(startPlan.quota!.campaigns).toEqual([]);
    // coding 平面的样本不携带这三段（窗口里没有套餐概念），汇总层遇到
    // undefined 不能把已拿到的套餐数据盖掉。
    const coding = sampler.sample(accounts[0]!.id, "coding-plan")!;
    expect(coding.quota).not.toBeNull();
    expect(coding.quota!.balances).toBeUndefined();
    expect(coding.quota!.plans).toBeUndefined();
    expect(coding.quota!.campaigns).toBeUndefined();
  });

  it("活动状态判定：ends_at 已过 → expired；planId 命中套餐实例 → claimed；其余 → claimable", async () => {
    const { sampler, accounts } = harness({
      script: {
        balancePlans: [{ plan_id: "wk-1114", name: "ZCODE WEEKEND BUILD II", entitlements: [] }],
        plans: [
          {
            plan_id: "wk-0918",
            name: "ZCODE WEEKEND BUILD",
            ends_at: 1_719_900_000, // 早于采样时刻（1720000000 秒）→ expired
            entitlements: [],
          },
          { plan_id: "wk-1114", name: "ZCODE WEEKEND BUILD II", ends_at: 1_720_090_000, entitlements: [] },
          { plan_id: "wk-1225", name: "ZCODE XMAS", ends_at: 1_720_090_000, entitlements: [] },
        ],
      },
    });
    await sampler.sampleNow(accounts[0]!.id, "test");
    const campaigns = sampler.sample(accounts[0]!.id, "start-plan")!.quota!.campaigns!;
    expect(campaigns.map((campaign) => campaign.status)).toEqual(["expired", "claimed", "claimable"]);
  });
});

// ---------------------------------------------------------------------------
// 1a-3. credits 合计的过期桶处置（过期桶不得虚增可用额度）
// ---------------------------------------------------------------------------

describe("credits 合计：过期桶（expires_at 已过）的处置", () => {
  /** 采样钟在 1_720_000_000_000 ms；桶到期用秒刻度（上游真形）。*/
  const PAST = 1_719_000_000;
  const FUTURE = 1_720_100_000;

  it("只剩过期桶有余量：credits 合计为 0 → 判耗尽（不虚增可用额度）", async () => {
    const { sampler, health, accounts } = harness({
      script: {
        balances: [
          { show_name: "Expired", total_units: 500, used_units: 0, remaining_units: 500, expires_at: PAST },
        ],
      },
    });
    await sampler.sampleNow(accounts[0]!.id, "test");
    const quota = sampler.sample(accounts[0]!.id, "start-plan")!.quota!;
    expect(quota.credits).toEqual({ remainingUnits: 0, totalUnits: 0 });
    expect(health.status(accounts[0]!.id, "start-plan").status).toBe("drained");
  });

  it("过期桶与活桶混合：只求和活桶，有余量 → 不耗尽；过期桶仍留在明细里（展示层画「已过期」）", async () => {
    const { sampler, health, accounts } = harness({
      script: {
        balances: [
          { show_name: "Expired", total_units: 500, used_units: 0, remaining_units: 500, expires_at: PAST },
          { show_name: "Live", total_units: 300, used_units: 0, remaining_units: 300, expires_at: FUTURE },
        ],
      },
    });
    await sampler.sampleNow(accounts[0]!.id, "test");
    const quota = sampler.sample(accounts[0]!.id, "start-plan")!.quota!;
    // 合计只收活桶（官方 normalizeStartPlanExpiry 把过期套餐的桶整个滤掉是同一
    // 原则；我们保留明细供展示，只在合计口径里剔除）。
    expect(quota.credits).toEqual({ remainingUnits: 300, totalUnits: 300, expiresAt: FUTURE * 1_000 });
    expect(health.status(accounts[0]!.id, "start-plan").status).toBe("ok");
    expect(quota.balances).toHaveLength(2);
    expect(quota.balances![0]!.name).toBe("Expired");
    expect(quota.balances![0]!.remainingUnits).toBe(500);
  });

  it("全桶 remaining_units=0 → 耗尽（未过期也一样）", async () => {
    const { sampler, health, accounts } = harness({
      script: {
        balances: [
          { show_name: "Burnt", total_units: 100, used_units: 100, remaining_units: 0, expires_at: FUTURE },
        ],
      },
    });
    await sampler.sampleNow(accounts[0]!.id, "test");
    // 桶没过期，只是烧完了：照常参与合计（totalUnits 仍是它的额度），
    // remainingUnits=0 触发第三条 drained 判定。
    expect(sampler.sample(accounts[0]!.id, "start-plan")!.quota!.credits).toEqual({ remainingUnits: 0, totalUnits: 100 });
    expect(health.status(accounts[0]!.id, "start-plan").status).toBe("drained");
  });

  it("drain-first 的 expiresAt 不收过期桶（过期余量不是紧迫度）", async () => {
    const { sampler, accounts } = harness({
      script: {
        balances: [
          { show_name: "Expired", total_units: 500, used_units: 0, remaining_units: 500, expires_at: PAST },
          { show_name: "Live", total_units: 300, used_units: 0, remaining_units: 300, expires_at: FUTURE },
        ],
      },
    });
    await sampler.sampleNow(accounts[0]!.id, "test");
    expect(sampler.expiresAt(accounts[0]!.id, "start-plan")).toBe(FUTURE * 1_000);
  });
});

// ---------------------------------------------------------------------------
// 1b. 额度过期时间（`withinTier: drain-first` 的排序输入）
// ---------------------------------------------------------------------------

describe("quota 采样：额度过期时间", () => {
  it("start-plan 取还有余量的 bucket 里最早到期的那个", async () => {
    const { sampler, accounts } = harness({
      script: {
        balances: [
          { show_name: "Free", total_units: 1000, used_units: 0, remaining_units: 1000, expires_at: 1_720_003_600 },
          { show_name: "Pack", total_units: 500, used_units: 0, remaining_units: 500, expires_at: 1_720_000_100 },
        ],
      },
    });
    await sampler.sampleNow(accounts[0]!.id, "test");

    // 上游发的是秒，`expiresAt` 一律是毫秒。
    expect(sampler.expiresAt(accounts[0]!.id, "start-plan")).toBe(1_720_000_100_000);
  });

  it("已经烧完的 bucket 什么时候到期与调度无关", async () => {
    const { sampler, accounts } = harness({
      script: {
        balances: [
          { show_name: "Burnt", total_units: 100, used_units: 100, remaining_units: 0, expires_at: 1_700_000_000 },
          { show_name: "Live", total_units: 100, used_units: 0, remaining_units: 100, expires_at: 1_720_003_600 },
        ],
      },
    });
    await sampler.sampleNow(accounts[0]!.id, "test");

    expect(sampler.expiresAt(accounts[0]!.id, "start-plan")).toBe(1_720_003_600_000);
  });

  it("上游没给 expires_at 时是 undefined（不是 0）", async () => {
    const { sampler, accounts } = harness({
      script: { balances: [{ show_name: "Free", total_units: 100, used_units: 0, remaining_units: 100 }] },
    });
    await sampler.sampleNow(accounts[0]!.id, "test");

    expect(sampler.expiresAt(accounts[0]!.id, "start-plan")).toBeUndefined();
  });

  it("coding 系取窗口里最早的重置时刻", async () => {
    const { sampler, accounts } = harness({
      script: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 0, next_reset_time: 1_720_003_600 },
          { type: "TIME_LIMIT", unit: 5, number: 1, remaining: 7, percentage: 30, next_reset_time: 1_720_000_100 },
        ],
      },
    });
    await sampler.sampleNow(accounts[0]!.id, "test");

    expect(sampler.expiresAt(accounts[0]!.id, "coding-plan")).toBe(1_720_000_100_000);
  });

  it("派生入口按自己的 (account, route) 取样本：窗口是母体那套，样本键仍是自己的", async () => {
    const derived = accountFor(zhipuCredential({ apiKey: "key-derived", secret: "s", jwt: "j" }), {
      label: "derived",
      routes: ["coding-plan", "off-peak", "highspeed"],
    });
    const { sampler } = harness({
      accounts: [derived],
      script: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 0, next_reset_time: 1_720_003_600 }] },
    });
    await sampler.sampleNow(derived.id, "test");

    // off-peak / highspeed 继承 coding-plan 的权益，所以三条路由同一套窗口。
    expect(sampler.expiresAt(derived.id, "coding-plan")).toBe(1_720_003_600_000);
    expect(sampler.expiresAt(derived.id, "off-peak")).toBe(1_720_003_600_000);
    expect(sampler.expiresAt(derived.id, "highspeed")).toBe(1_720_003_600_000);
  });

  it("没有采样结果时是 undefined（调度据此把该账号排最后）", async () => {
    const { sampler, accounts } = harness({ script: {} });

    expect(sampler.expiresAt(accounts[0]!.id, "start-plan")).toBeUndefined();
    expect(sampler.expiresAt("no-such-account", "coding-plan")).toBeUndefined();
  });

  it("stale 时沿用上一轮的过期时间（额度是慢变量，采样失败不改结论）", async () => {
    const script: PlaneScript = {
      balances: [{ show_name: "Free", total_units: 100, used_units: 0, remaining_units: 100, expires_at: 1_720_003_600 }],
    };
    const { sampler, accounts, clock } = harness({ script });
    await sampler.sampleNow(accounts[0]!.id, "test");
    const before = sampler.expiresAt(accounts[0]!.id, "start-plan");

    script.billingCode = 500;
    clock.now += 31_000; // 跨过 sampleNow 的 30s 去重窗，真正发第二轮
    await sampler.sampleNow(accounts[0]!.id, "test");

    expect(sampler.sample(accounts[0]!.id, "start-plan")!.stale).toBe(true);
    expect(sampler.expiresAt(accounts[0]!.id, "start-plan")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 2. 失败保留上次结果 + stale
// ---------------------------------------------------------------------------

describe("quota 采样：失败保留上次结果并标记 stale", () => {
  it("coding 平面挂掉：coding-play 路由 stale 且保留上次值，start-plan 照常刷新", async () => {
    const account = dualRouteAccount();
    // 同一个 script 对象会被 mock 每次调用时重读，所以可以逐轮改上游行为。
    const script: PlaneScript = {
      balances: [{ show_name: "Free", total_units: 100, used_units: 10, remaining_units: 90 }],
      limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 10, percentage: 10 }],
    };
    const { sampler, clock, accounts } = harness({ accounts: [account], script });

    const first = (await sampler.sampleNow(accounts[0]!.id, "test"))!;
    const codingBefore = first.find((sample) => sample.route === "coding-plan")!;
    expect(codingBefore.stale).toBe(false);

    // 第二轮：coding 端点失败，credits 平面照旧。中间推进时钟，证明 stale 时
    // `sampledAt` 不被刷新（保留"这份数据是什么时候采到的"）。
    script.codingFail = true;
    clock.now += 60_000;
    const second = (await sampler.sampleNow(accounts[0]!.id, "test"))!;
    const codingAfter = second.find((sample) => sample.route === "coding-plan")!;
    const startPlan = second.find((sample) => sample.route === "start-plan")!;

    expect(codingAfter.stale).toBe(true);
    expect(codingAfter.error).toContain("coding");
    // 不清空：额度结论还是上一轮的。
    expect(codingAfter.quota).toEqual(codingBefore.quota);
    expect(codingAfter.sampledAt).toBe(codingBefore.sampledAt);
    // 另一套平面不受牵连。
    expect(startPlan.stale).toBe(false);
    expect(startPlan.sampledAt).toBe(codingBefore.sampledAt + 60_000);
  });

  it("首次采样就失败：`quota` 为 null 而 stale，不是空对象", async () => {
    const account = dualRouteAccount();
    const { sampler, accounts } = harness({ accounts: [account], script: { codingFail: true } });
    const samples = (await sampler.sampleNow(accounts[0]!.id, "test"))!;
    const coding = samples.find((sample) => sample.route === "coding-plan")!;
    expect(coding.stale).toBe(true);
    expect(coding.quota).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. 错峰 + 抖动
// ---------------------------------------------------------------------------

describe("quota 采样：错峰 + 抖动", () => {
  it("不同账号的首轮相位不同：一个周期内各采一次，且不落在同一秒", async () => {
    const a = dualRouteAccount("a");
    const b = dualRouteAccount("b");
    const { sampler, clock, activity } = harness({ accounts: [a, b], script: {}, pollSeconds: 100 });
    // 两个账号都"刚活跃过"：空闲跳过生效，错峰本身只在会采的账号之间比较。
    activity.mark(a.id);
    activity.mark(b.id);

    const sampledAt = new Map<string, number>();
    const start = clock.now;
    // 逐秒推进一个完整周期（每 tick 是一次"到点了没有"的判断）。
    for (let second = 0; second <= 100; second++) {
      clock.now = start + second * 1_000;
      await sampler.tick();
      for (const sample of sampler.snapshot()) {
        if (!sampledAt.has(sample.accountId)) sampledAt.set(sample.accountId, second);
      }
    }

    expect(sampledAt.size).toBe(2);
    const [firstA, firstB] = [...sampledAt.values()];
    // 错峰的意义就在这里：两个账号不在同一秒发心跳。
    expect(firstA).not.toBe(firstB);
    // 相位落在 [0, 周期) 内，不会排到第二个周期去。
    for (const second of sampledAt.values()) expect(second).toBeLessThan(100);
  });

  it("轮次间隔带 ±5% 抖动：正抖动时到点前不采、到点后才采", async () => {
    const account = dualRouteAccount();
    // 固定正抖动上限（random=1 → +5%）。
    const { sampler, clock, planes, activity } = harness({
      accounts: [account],
      script: {},
      pollSeconds: 100,
      random: () => 1,
    });
    activity.mark(account.id);

    const start = clock.now;
    // 找首轮采样时刻（相位由哈希决定，逐秒探）。
    let firstSampleAt = -1;
    for (let second = 0; second <= 100 && firstSampleAt < 0; second++) {
      clock.now = start + second * 1_000;
      const before = planes.calls.billing + planes.calls.coding;
      await sampler.tick();
      if (planes.calls.billing + planes.calls.coding > before) firstSampleAt = clock.now;
    }
    expect(firstSampleAt).toBeGreaterThan(0);

    // 周期 + 5% = 105s。104s 时还不该采（轮次边界被抖动推后了）。
    const beforeBoundary = planes.calls.coding;
    clock.now = firstSampleAt + 104_000;
    await sampler.tick();
    expect(planes.calls.coding).toBe(beforeBoundary);

    // 到点（105s）后必须采。
    clock.now = firstSampleAt + 105_000;
    await sampler.tick();
    expect(planes.calls.coding).toBe(beforeBoundary + 1);
  });
});

// ---------------------------------------------------------------------------
// 4. 空闲跳过
// ---------------------------------------------------------------------------

describe("quota 采样：只采最近活跃账号", () => {
  it("从未被派发的健康账号：一个周期内一次都不采", async () => {
    const account = dualRouteAccount();
    const { sampler, clock, planes } = harness({ accounts: [account], script: {}, pollSeconds: 100 });
    const start = clock.now;
    for (let second = 0; second <= 100; second++) {
      clock.now = start + second * 1_000;
      await sampler.tick();
    }
    expect(planes.calls.coding).toBe(0);
  });

  it("活跃过的账号会被采；过了 2 个周期不再活跃就重新跳过", async () => {
    const account = dualRouteAccount();
    const { sampler, clock, planes, activity } = harness({ accounts: [account], script: {}, pollSeconds: 100 });
    const start = clock.now;
    activity.mark(account.id);

    // 一个周期内必定采到（相位 + 抖动都在周期附近）。
    for (let second = 0; second <= 106; second++) {
      clock.now = start + second * 1_000;
      await sampler.tick();
    }
    expect(planes.calls.coding).toBeGreaterThan(0);

    // 空闲窗口 = 2 个周期。再推进 2 个周期以上再 tick：一次都不该采。
    const before = planes.calls.coding;
    clock.now = start + 400_000;
    await sampler.tick();
    expect(planes.calls.coding).toBe(before);
  });

  it("drained 的账号即使完全没活动也继续采（否则永远发现不了额度恢复）", async () => {
    const account = dualRouteAccount();
    const { sampler, clock, health, accounts, planes, activity } = harness({
      accounts: [account],
      script: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 5e8, remaining: 0, percentage: 100 }] },
      pollSeconds: 100,
    });
    const id = accounts[0]!.id;
    // 先让账号活跃起来，采到 100% → drained。
    activity.mark(id);
    const start = clock.now;
    for (let second = 0; second <= 120; second++) {
      clock.now = start + second * 1_000;
      await sampler.tick();
      if (health.status(id, "coding-plan").status === "drained") break;
    }
    expect(health.status(id, "coding-plan").status).toBe("drained");

    // 从此**完全没有请求活动**（连活跃记录都清掉），仍然必须继续采，否则
    // drained 且没有 nextResetTime 的账号永远回不来。
    activity.forget(id);
    const before = planes.calls.coding;
    for (let second = 121; second <= 480; second++) {
      clock.now = start + second * 1_000;
      await sampler.tick();
    }
    expect(planes.calls.coding).toBeGreaterThan(before);
  });
});

// ---------------------------------------------------------------------------
// 5. 三条采样侧判定 + until + 恢复
// ---------------------------------------------------------------------------

describe("drained 判定", () => {
  const credits = (remainingUnits: number): RouteQuota => ({
    windows: [],
    credits: { remainingUnits, totalUnits: 100 },
  });

  it("事故回归：周窗 usage=4.28亿 / remaining=7200万 不判耗尽", () => {
    // 事故的直接形态：官方载荷的 `number`（窗口周期身份，现场 unit=3
    // number=5）曾被误标成 token 总量 `total`，4.28亿/5 相除恒 ≥ 1，额度充足却被
    // 恒判耗尽。采集层（routes-quota.test.ts）已验证 unit/number 原样保留；归一后
    // 的 QuotaWindow 只带用量三元组，总量 = usage+remaining = 5亿，占比 0.856。
    const quota: RouteQuota = {
      windows: [{ type: "TOKENS_LIMIT", usage: 4.28e8, remaining: 7.2e7 }],
    };
    expect(evaluateDrain(quota, 1).drained).toBe(false);
    expect(evaluateDrain(quota, 1).reasons).toEqual([]);
  });

  it("条件 1：usage/(usage+remaining) 达到阈值（烧完命中，还有余量不命中）", () => {
    const hit = evaluateDrain({ windows: [{ type: "TOKENS_LIMIT", usage: 5e8, remaining: 0, percentage: 100 }] }, 1);
    expect(hit.drained).toBe(true);
    expect(hit.reasons[0]).toContain("TOKENS_LIMIT");

    const miss = evaluateDrain({ windows: [{ type: "TOKENS_LIMIT", usage: 4.95e8, remaining: 5e6, percentage: 99 }] }, 1);
    expect(miss.drained).toBe(false);
    expect(miss.reasons).toEqual([]);
  });

  it("阈值可调：drainThreshold 0.9 时 95% 即 drained", () => {
    const quota: RouteQuota = { windows: [{ type: "TOKENS_LIMIT", usage: 95, remaining: 5 }] };
    expect(evaluateDrain(quota, 1).drained).toBe(false);
    expect(evaluateDrain(quota, 0.9).drained).toBe(true);
  });

  it("remaining 缺失不等于 0：只有 usage 时不能推出总量，不判耗尽", () => {
    // usage/(usage+remaining) 要求两字段同时在场——「上游没报剩余」不是「剩余为 0」。
    const quota: RouteQuota = { windows: [{ type: "TOKENS_LIMIT", usage: 1e8 }] };
    expect(evaluateDrain(quota, 1).drained).toBe(false);
  });

  it("事故回归：percentage=1（1% 已用，官方显示 99% 剩余）不得判耗尽", () => {
    // 误判现场（真实快照，2026-11-09，bigmodel 账号）：
    //   {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":1,
    //    "nextResetTime":1794164017000}   // 2026/11/9 02:53:37，正好在 5 小时网格上
    // 官方面板同时显示「5 小时剩余 99%」，模型可正常使用，而详情写着
    // 「coding-plan 额度耗尽 · 恢复 2026/11/9 02:53:37」。
    //
    // 根因：`percentage` 的契约刻度是 0..100 的已用百分数（官方
    // `getQuotaRemainingPercentage` = 100 - percentage、`normalizeUsagePercentage`
    // 只 clamp(0,100)），旧实现却用 `> 1 ? /100 : value` 猜刻度，于是 1 被读成
    // 比例 1.0 = 100% 已用 → fraction 1.0 ≥ drainThreshold(1.0) → drained，
    // until 取该窗口的 nextResetTime（5 小时窗的重置边界，就那个 02:53:37）。
    // 5 小时窗在 1% 附近会停留整窗，所以误判一直不解除，直到重置才回落。
    const fiveHourWindow: QuotaWindow = {
      type: "TOKENS_LIMIT",
      unit: 3,
      number: 5,
      percentage: 1,
      nextResetTime: 1_794_164_017_000,
    };
    const decision = evaluateDrain({ windows: [fiveHourWindow] }, 1);
    expect(decision.drained).toBe(false);
    expect(decision.until).toBeUndefined();
    expect(decision.reasons).toEqual([]);

    // 边界两侧：1% 已用不耗尽，100% 已用才耗尽（百分比刻度，不是 1.0 比例刻度）。
    expect(evaluateDrain({ windows: [{ type: "X", percentage: 99 }] }, 1).drained).toBe(false);
    expect(evaluateDrain({ windows: [{ type: "X", percentage: 100 }] }, 1).drained).toBe(true);
  });

  it("真实快照四格（5h 1% / 周 40% / 工具 2%）整体不判耗尽", () => {
    // 与上面那份现场快照同一份上游载荷（2026-11-09 实采，只把 5 小时窗的 percentage 从 0
    // 换成同一天的 1）：三格都由 `percentage` 判，均远低于阈值。
    const quota: RouteQuota = {
      windows: [
        { type: "TIME_LIMIT", unit: 5, number: 1, usage: 1000, remaining: 972, percentage: 2, nextResetTime: 1_795_491_762_977 },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 40, nextResetTime: 1_794_365_985_961 },
      ],
    };
    expect(evaluateDrain(quota, 1).drained).toBe(false);
    // 对照：同一份窗口里 5 小时窗真烧完（percentage=100）才 drained，且 until 只取
    // 命中窗口的 nextResetTime（周窗 11/11 不被误当恢复时间）。
    const hit = evaluateDrain(
      {
        windows: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 100, nextResetTime: 1_794_164_017_000 },
          { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 40, nextResetTime: 1_794_365_985_961 },
        ],
      },
      1,
    );
    expect(hit.drained).toBe(true);
    expect(hit.until).toBe(1_794_164_017_000);
  });

  it("percentage 是百分数刻度：0.5 是 0.5% 已用，不是 50%", () => {
    // 旧实现：0.5 <= 1 所以直传成比例 0.5 = 50% 已用。契约下它只能是 0.5%。
    expect(evaluateDrain({ windows: [{ type: "X", percentage: 0.5 }] }, 0.4).drained).toBe(false);
    expect(evaluateDrain({ windows: [{ type: "X", percentage: 40 }] }, 0.4).drained).toBe(true);
  });

  it("percentage=85（无 usage/remaining）→ 不耗尽；percentage=100 → 耗尽", () => {
    expect(evaluateDrain({ windows: [{ type: "TOKENS_LIMIT", percentage: 85 }] }, 1).drained).toBe(false);
    expect(evaluateDrain({ windows: [{ type: "TOKENS_LIMIT", percentage: 100 }] }, 1).drained).toBe(true);
  });

  it("TIME_LIMIT（每月工具窗）同口径；CREDIT_LIMIT 与 TOKENS_LIMIT 等价处理", () => {
    // 官方 codingPlanQuotaPresentation：CREDIT_LIMIT（zai team plan）与
    // TOKENS_LIMIT unit/number 语义完全一致，判定层不做 type 白名单，
    // 两个 type 套同一张平面契约。
    expect(evaluateDrain({ windows: [{ type: "TIME_LIMIT", usage: 30, remaining: 0 }] }, 1).drained).toBe(true);
    expect(evaluateDrain({ windows: [{ type: "TIME_LIMIT", usage: 30, remaining: 12 }] }, 1).drained).toBe(false);
    expect(evaluateDrain({ windows: [{ type: "CREDIT_LIMIT", usage: 5e8, remaining: 0 }] }, 1).drained).toBe(true);
    expect(evaluateDrain({ windows: [{ type: "CREDIT_LIMIT", usage: 4.28e8, remaining: 7.2e7 }] }, 1).drained).toBe(false);
  });

  it("条件 2：窗口 remaining <= 0（usage/percentage 缺失也判得出）", () => {
    const hit = evaluateDrain({ windows: [{ type: "TIME_LIMIT", remaining: 0 }] }, 1);
    expect(hit.drained).toBe(true);
    expect(hit.reasons[0]).toContain("remaining");
    expect(evaluateDrain({ windows: [{ type: "TIME_LIMIT", remaining: 1 }] }, 1).drained).toBe(false);
  });

  it("条件 3：credits remainingUnits <= 0", () => {
    expect(evaluateDrain(credits(0), 1).drained).toBe(true);
    expect(evaluateDrain(credits(1), 1).drained).toBe(false);
  });

  it("until 取命中窗口的 nextResetTime（秒 → 毫秒；多个取最早）", () => {
    const decision = evaluateDrain(
      {
        windows: [
          { type: "A", usage: 10, remaining: 0, nextResetTime: 1_720_010_000 }, // 秒
          { type: "B", usage: 10, remaining: 0, nextResetTime: 1_720_005_000 },
          { type: "C", usage: 10, remaining: 0 }, // 没有重置时间
        ],
      },
      1,
    );
    expect(decision.until).toBe(1_720_005_000_000);
  });

  it("毫秒形态的 nextResetTime 不被二次换算", () => {
    const decision = evaluateDrain(
      { windows: [{ type: "A", usage: 10, remaining: 0, nextResetTime: 1_720_010_000_000 }] },
      1,
    );
    expect(decision.until).toBe(1_720_010_000_000);
  });
});

describe("drained 落到健康表：退出候选集 + 恢复 markOk", () => {
  it("采样判定耗尽 → markDrained(until=重置时间) → 采样到恢复 → markOk", async () => {
    const account = dualRouteAccount();
    const { sampler, health, accounts, clock } = harness({
      accounts: [account],
      script: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 5e8, remaining: 0, percentage: 100, next_reset_time: 1_720_003_600 }] },
    });
    const id = accounts[0]!.id;

    await sampler.sampleNow(accounts[0]!.id, "test");
    const state = health.status(id, "coding-plan");
    expect(state.status).toBe("drained");
    expect(state.until).toBe(1_720_003_600_000);
    // 该 (account, route) 退出候选集（候选集最后一层是健康过滤）。
    expect(health.isAvailable(id, "coding-plan")).toBe(false);
    // 另一条路由不受牵连（状态键是 (account, route)，不是账号）。
    expect(health.isAvailable(id, "start-plan")).toBe(true);

    // 窗口重置后额度回来：采样必须把它放回候选集（markOk）。
    const healthy = harness({
      accounts: [account],
      script: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 5e6, remaining: 4.95e8, percentage: 5 }] },
      clockValue: clock,
    });
    healthy.health.markDrained(id, "coding-plan", clock.now + 60_000);
    await healthy.sampler.sampleNow(healthy.accounts[0]!.id, "test");
    expect(healthy.health.isAvailable(id, "coding-plan")).toBe(true);
  });

  it("现场重演：5 小时窗 percentage=1 不会把账号踢出候选集（不再带 until）", async () => {
    // 整条链路（上游载荷 → 归一 → 判定 → 健康表）跑一遍上面那份真实快照的形状：
    // 三格窗口的百分比分别是 1% / 40% / 2%（官方：99% / 60% / 98% 剩余）。
    // 修复前：5 小时窗的 percentage=1 被当成比例 1.0 → drained，
    // until = 该窗口 next_reset_time，账号在整窗内被误踢（用户看到
    // 「coding-plan 额度耗尽 · 恢复 2026/11/9 02:53:37」）。
    const resetSeconds = 1_794_164_017; // 5 小时窗重置 2026/11/9 02:53:37（秒刻度，上游主发）
    const { sampler, health, accounts } = harness({
      script: {
        limits: [
          { type: "TIME_LIMIT", unit: 5, number: 1, usage: 1000, currentValue: 28, remaining: 972, percentage: 2, next_reset_time: 1_795_491_762 },
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1, next_reset_time: resetSeconds },
          { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 40, next_reset_time: 1_794_365_985 },
        ],
      },
    });
    const id = accounts[0]!.id;
    await sampler.sampleNow(accounts[0]!.id, "test");

    const state = health.status(id, "coding-plan");
    expect(state.status).toBe("ok");
    expect(state.until).toBeUndefined();
    expect(health.isAvailable(id, "coding-plan")).toBe(true);

    // 同一份快照的归一结果：三格身份完整（unit/number 透传）且都带 percentage。
    const windows = sampler.sample(id, "coding-plan")!.quota!.windows;
    expect(windows.map((w) => [w.type, w.unit, w.number, w.percentage])).toEqual([
      ["TIME_LIMIT", 5, 1, 2],
      ["TOKENS_LIMIT", 3, 5, 1],
      ["TOKENS_LIMIT", 6, 1, 40],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. 订阅产品采样（同一周期 / 同一串行 tick / 零独立流量）
// ---------------------------------------------------------------------------

describe("quota 采样：Coding Plan 订阅产品", () => {
  it("个人 subscription/list：当前期筛选 + 产品身份/续期/到期归一，GET + PAT 去 Bearer", async () => {
    const { accounts, sampler, planes } = subscriptionHarness({
      script: {
        subscription: {
          body: {
            code: 200,
            success: true,
            data: [
              // 异构商品 + 非当前期条目不许遮蔽有效 Coding 订阅（官方逐条解析口径）。
              { productId: "other", productName: "Other", status: "VALID", inCurrentPeriod: true },
              { productId: "coding-plan-old", productName: "GLM Coding Plan Old", status: "EXPIRED", inCurrentPeriod: false },
              {
                productId: "coding-plan-pro",
                productName: "GLM Coding Plan Pro",
                status: "VALID",
                inCurrentPeriod: true,
                autoRenew: 1,
                nextRenewTime: "2026-12-09 09:00:00",
                valid: "2026-11-09 至 2027-11-09",
                billingCycle: "MONTHLY",
              },
            ],
          },
        },
      },
    });
    const samples = (await sampler.sampleNow(accounts[0]!.id, "test"))!;
    const coding = samples.find((sample) => sample.route === "coding-plan")!;
    expect(coding.quota?.subscription).toEqual({
      productId: "coding-plan-pro",
      productName: "GLM Coding Plan Pro",
      status: "VALID",
      inCurrentPeriod: true,
      autoRenew: true,
      billingCycle: "MONTHLY",
      renewTime: Date.parse("2026-12-09T09:00:00"),
      expireTime: Date.parse("2027-11-09"),
      kind: "personal",
    });
    // credits 样本不带订阅段（摘要层见 undefined 不覆盖）。
    expect(samples.find((sample) => sample.route === "start-plan")?.quota?.subscription).toBeUndefined();
    expect(samples.find((sample) => sample.route === "start-plan")?.stale).toBe(false);
    const request = planes.subscriptionRequests[0]!;
    expect(request.url).toBe("https://api.z.ai/api/biz/subscription/list");
    expect(request.method).toBe("GET");
    expect(request.headers.authorization).toBe("key-a.secret-a");
    expect(request.headers["bigmodel-organization"]).toBeUndefined();
  });

  it("非自动续费：nextRenewTime 归到期而非续期，缺到期字段不编造", () => {
    // 直接在归一函数上验时间语义（与采样链路同一份实现），避免把 Date.parse 的
    // 时区口径绑进采样器用例。官方依据 bigmodelUsageQuotaMapper.ts:117-146。
    const result = normalizePersonalSubscription({
      code: 200,
      data: [{
        productId: "coding-plan-lite",
        productName: "GLM Coding Plan Lite",
        status: "VALID",
        inCurrentPeriod: true,
        autoRenew: false,
        nextRenewTime: "2026-12-01 08:00:00",
        billingCycle: "YEARLY",
      }],
    });
    expect(result).toEqual({
      kind: "known",
      subscription: {
        productId: "coding-plan-lite",
        productName: "GLM Coding Plan Lite",
        status: "VALID",
        inCurrentPeriod: true,
        autoRenew: false,
        billingCycle: "YEARLY",
        expireTime: Date.parse("2026-12-01T08:00:00"),
        kind: "personal",
      },
    });
  });

  it("团队 querySubscribeDetail：GET + 业务 token/团队头，EFFECTIVE+VALID 才发布产品", async () => {
    const account = accountFor(
      zhipuCredential({
        apiKey: "team-key",
        secret: "team-secret",
        oauthAccessToken: "oauth-access-token",
        identity: { targetType: "TEAM", organizationId: "org-7", projectId: "proj-7", productId: "team-product", deviceMid: "team-mid" },
      }),
      { label: "team", routes: ["coding-plan"] },
    );
    const { accounts, sampler, planes } = subscriptionHarness({
      account,
      script: {
        subscription: {
          body: {
            code: 200,
            success: true,
            data: {
              hasSubscription: true,
              status: "EFFECTIVE",
              memberGrantStatus: "VALID",
              productId: "team-product",
              productName: "Team Coding Plan",
              subscribeEndTime: "2027-08-25",
              subscribePeriod: "YEARLY",
            },
          },
        },
      },
    });
    const [sample] = (await sampler.sampleNow(accounts[0]!.id, "test"))!;
    expect(sample?.quota?.subscription).toEqual({
      productId: "team-product",
      productName: "Team Coding Plan",
      status: "EFFECTIVE",
      memberGrantStatus: "VALID",
      billingCycle: "yearly",
      expireTime: Date.parse("2027-08-25"),
      kind: "team",
    });
    const request = planes.subscriptionRequests[0]!;
    expect(request.url).toBe("https://api.z.ai/api/biz/team/subscribe/product/querySubscribeDetail");
    expect(request.method).toBe("GET");
    expect(request.headers.authorization).toBe("Bearer oauth-access-token");
    expect(request.headers["bigmodel-organization"]).toBe("org-7");
    expect(request.headers["bigmodel-project"]).toBe("proj-7");
  });

  it("缺团队上下文只查个人；缺业务 token 的 TEAM 也不猜团队接口", async () => {
    const teamWithoutIds = accountFor(
      zhipuCredential({ apiKey: "k", secret: "s", oauthAccessToken: "token", identity: { targetType: "TEAM", deviceMid: "d" } }),
      { routes: ["coding-plan"] },
    );
    const first = subscriptionHarness({ account: teamWithoutIds, script: {} });
    await first.sampler.sampleNow(first.accounts[0]!.id, "test");
    expect(first.planes.subscriptionRequests[0]?.url).toContain("/api/biz/subscription/list");

    const teamWithoutToken = accountFor(
      zhipuCredential({
        apiKey: "k",
        secret: "s",
        identity: { targetType: "TEAM", organizationId: "org", projectId: "proj", productId: "p", deviceMid: "d" },
      }),
      { routes: ["coding-plan"] },
    );
    const second = subscriptionHarness({ account: teamWithoutToken, script: {} });
    await second.sampler.sampleNow(second.accounts[0]!.id, "test");
    expect(second.planes.subscriptionRequests[0]?.url).toContain("/api/biz/subscription/list");
    expect(second.planes.subscriptionRequests[0]?.headers["bigmodel-project"]).toBeUndefined();
  });

  it("失败 = unknown：保留旧产品与窗口，stale 语义按额度平面独立，不丢窗口数据", async () => {
    const script: PlaneScript = {
      limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 10, percentage: 10 }],
    };
    const { accounts, sampler, planes, clock } = subscriptionHarness({ script });
    const first = (await sampler.sampleNow(accounts[0]!.id, "test"))!.find((s) => s.route === "coding-plan")!;
    expect(first.quota?.subscription?.productName).toBe("GLM Coding Plan Pro");
    expect(first.stale).toBe(false);
    const windowsBefore = first.quota?.windows;

    // 订阅接口连续两轮失败（HTTP 500 与传输异常），额度窗口照常刷新。
    script.subscription = { status: 500, body: { code: 500, msg: "oops" } };
    clock.now += 60_000;
    const second = (await sampler.sampleNow(accounts[0]!.id, "test"))!.find((s) => s.route === "coding-plan")!;
    expect(second.quota?.subscription).toEqual(first.quota?.subscription);
    expect(second.quota?.windows).toEqual(windowsBefore);
    expect(second.stale).toBe(false); // 额度采样本身是成功的
    expect(second.error).toContain("subscription: HTTP 500");
    script.subscription = { fail: true };
    // sampleNow 的 30s 去重是统一预算；第三轮跨过去重窗才算「新的一轮」。
    clock.now += 31_000;
    const third = (await sampler.sampleNow(accounts[0]!.id, "test"))!.find((s) => s.route === "coding-plan")!;
    expect(third.quota?.subscription).toEqual(first.quota?.subscription);
    expect(third.quota?.windows).toEqual(windowsBefore);
    expect(third.error).toContain("subscription upstream offline");
    expect(planes.calls.subscription).toBe(3);
  });

  it("首次订阅采样失败：无产品身份，窗口卡仍可回落", async () => {
    const { accounts, sampler } = subscriptionHarness({ script: { subscription: { fail: true } } });
    const [sample] = (await sampler.sampleNow(accounts[0]!.id, "test"))!;
    expect(sample?.quota?.subscription).toBeUndefined();
    expect(sample?.quota?.windows).toEqual([]);
  });

  it("无当前期有效条目 = unknown；缺 PAT 的 JWT-only 账号不发流量", async () => {
    const { accounts, sampler, planes } = subscriptionHarness({
      script: {
        subscription: {
          body: { code: 200, success: true, data: [{ productId: "coding-plan-pro", status: "EXPIRED", inCurrentPeriod: false }] },
        },
      },
    });
    const [sample] = (await sampler.sampleNow(accounts[0]!.id, "test"))!;
    expect(sample?.quota?.subscription).toBeUndefined();
    expect(planes.calls.subscription).toBe(1);

    const jwtOnly = accountFor(zhipuCredential({ apiKey: "", jwt: "plan.jwt" }), { routes: ["start-plan"] });
    const second = subscriptionHarness({ account: jwtOnly, script: {} });
    await second.sampler.sampleNow(second.accounts[0]!.id, "test");
    expect(second.planes.calls.subscription).toBe(0); // 无 coding 路由，本就不该问订阅
    expect(second.planes.calls.billing).toBe(2);
  });

  it("零新增独立流量：一个 tick 只问一次订阅，采样器只有一个定时器", async () => {
    const { accounts, sampler, planes } = subscriptionHarness({ script: {} });
    await sampler.sampleNow(accounts[0]!.id, "test");
    expect(planes.calls.billing).toBe(2);
    expect(planes.calls.coding).toBe(1);
    expect(planes.calls.subscription).toBe(1);
    // 只有周期采样器那一个定时器（start() 幂等），订阅探测本身不注册定时器。
    sampler.start();
    sampler.start();
    expect(sampler.running).toBe(true);
    sampler.stop();
  });

  it("多 coding 路由共享同一份产品：一轮一次 GET，sampledAt 与额度采样同源", async () => {
    const account = accountFor(
      zhipuCredential({ apiKey: "derived-key", secret: "derived-secret", jwt: "derived-jwt" }),
      { routes: ["coding-plan", "off-peak", "highspeed"] },
    );
    const { accounts, sampler, planes } = subscriptionHarness({ account, script: {} });
    const samples = (await sampler.sampleNow(accounts[0]!.id, "test"))!;
    expect(planes.calls.subscription).toBe(1);
    for (const sample of samples) {
      expect(sample.quota?.subscription?.productName).toBe("GLM Coding Plan Pro");
      expect(sample.sampledAt).toBe(1_720_000_000_000);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. 配置与生命周期
// ---------------------------------------------------------------------------

describe("采样器：配置默认值与定时器", () => {
  it("accounts.quota 缺省时取默认值（300s / 1.0）", () => {
    const { manager, broker } = inMemoryAccounts([dualRouteAccount()]);
    const sampler = createQuotaSampler(CONFIG, manager, broker);
    expect(sampler.quota).toEqual(DEFAULT_ACCOUNTS_QUOTA);
    expect(sampler.quota.pollSeconds).toBe(300);
    expect(sampler.quota.drainThreshold).toBe(1);
  });

  it("config.accounts.quota 覆盖默认值", () => {
    const { manager, broker } = inMemoryAccounts([dualRouteAccount()]);
    const sampler = createQuotaSampler({ ...CONFIG, accounts: { ...accountsSection(), quota: { pollSeconds: 42, drainThreshold: 0.5 } } }, manager, broker);
    expect(sampler.quota).toEqual({ pollSeconds: 42, drainThreshold: 0.5 });
  });

  it("start/stop 幂等，且 stop 之后不再 tick", async () => {
    const { sampler } = harness({ script: {} });
    expect(sampler.running).toBe(false);
    sampler.start();
    sampler.start();
    expect(sampler.running).toBe(true);
    sampler.stop();
    sampler.stop();
    expect(sampler.running).toBe(false);
  });
});

/** 只给"覆盖"用例用的最小 `accounts` 段（其余字段用默认值补齐）。*/
function accountsSection() {
  return {
    routing: {
      order: ["start-plan" as const],
      withinTier: "sticky" as const,
      mode: "prefer" as const,
      strategy: "sticky-hash" as const,
      onSaturated: "wait" as const,
      onDrained: "fallback" as const,
      onAuthFailed: "rotate" as const,
      queueTimeoutMs: 1,
      maxQueue: 1,
      maxTotalInflight: 1,
    },
    stickiness: { enabled: false, ttlSeconds: 1, maxSessions: 1, onSaturated: "wait" as const, overflowAfterMs: 1 },
    quota: DEFAULT_ACCOUNTS_QUOTA,
    // 风控开关：这个用例只测 quota 覆盖，risk 取默认值（心跳抖动开）。
    risk: { jitterHeartbeat: true },
    entries: [],
  };
}

// `IAT` 常量只为让 `zhipuCredential` 的 jwt 看起来像真的（收集器会解析它）。
void IAT;

describe("采样器：配置热重载", () => {
  it("applyConfigQuota 换掉采样周期与阈值，并重排到期时间", () => {
    const { manager, broker } = inMemoryAccounts([dualRouteAccount()]);
    const sampler = createQuotaSampler(CONFIG, manager, broker);
    expect(sampler.quota.pollSeconds).toBe(300);

    sampler.applyConfigQuota({ pollSeconds: 42, drainThreshold: 0.5 });

    expect(sampler.quota.pollSeconds).toBe(42);
    expect(sampler.quota.drainThreshold).toBe(0.5);
  });
});
