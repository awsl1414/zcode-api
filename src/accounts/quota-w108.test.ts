/**
 * 采样器统一入口：启动探测、30s 去重、分级采决策、
 * 能力对齐证据与 cooling 恢复缺口。
 *
 * 复用 quota.test.ts 的 mock 上游思路，但这里只关心「什么时候问、问几次、对齐到谁」。
 */
import { afterEach, describe, expect, it, jest } from "bun:test";
import { ActivityClock } from "./activity.js";
import { HealthEngine } from "./health.js";
import { PlanCapabilityAlignment } from "./plan-capability.js";
import {
  QuotaSampler,
  SAMPLE_DEDUP_WINDOW_MS,
  STARTUP_PROBE_JITTER_MS,
  type PlanProbeBroker,
} from "./quota.js";
import type { CapabilityAlignment } from "./plan-capability.js";
import { accountFor, inMemoryAccounts, zhipuCredential } from "./testing.js";
import type { Account, RouteKind } from "./types.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";

const IDENTITY: ProxyIdentity = {
  appVersion: "test-1.0.0",
  appVersionSource: "default",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
  betaPolicy: "drop",
  betaAllowlist: [],
};

const CONFIG = {
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
} as unknown as ProxyConfig;

function account(label: string, routes: RouteKind[] = ["start-plan", "coding-plan"], enabled = true): Account {
  return accountFor(zhipuCredential({ apiKey: `key-${label}`, secret: `s-${label}`, jwt: `jwt-${label}` }), {
    label,
    routes,
    enabled,
  });
}

interface Harness {
  sampler: QuotaSampler;
  clock: { now: number };
  calls: { billing: number; coding: number };
  alignments: CapabilityAlignment[];
  broker: PlanProbeBroker;
  health: HealthEngine;
  accounts: Account[];
  manager: ReturnType<typeof inMemoryAccounts>["manager"];
}

/** 两套平面都答成功；`failBoth` 模拟探测彻底失败（网络/凭据）。*/
function harness(options: {
  accounts?: Account[];
  failBoth?: boolean;
  random?: () => number;
  pollSeconds?: number;
  /** credits 平面的余额桶（默认空数组）。*/
  balances?: Array<Record<string, unknown>>;
} = {}): Harness {
  const clock = { now: 1_720_000_000_000 };
  const now = () => clock.now;
  const accounts = options.accounts ?? [account("a")];
  const { manager } = inMemoryAccounts(accounts, { now });
  const health = new HealthEngine(now);
  const activity = new ActivityClock(now);
  const calls = { billing: 0, coding: 0 };
  const alignments: CapabilityAlignment[] = [];
  const capability = new PlanCapabilityAlignment();
  const broker: PlanProbeBroker = {
    capability,
    notePlanProbe: (_account, alignment) => alignments.push(alignment),
  };
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/api/monitor/usage/quota/limit")) {
      calls.coding += 1;
      if (options.failBoth) return new Response("down", { status: 500 });
      return new Response(JSON.stringify({ code: 0, data: { limits: [] } }), { status: 200 });
    }
    calls.billing += 1;
    if (options.failBoth) return new Response("down", { status: 500 });
    return new Response(JSON.stringify({ code: 0, data: { balances: options.balances ?? [], plans: [] } }), { status: 200 });
  }) as typeof fetch;
  const sampler = new QuotaSampler({
    config: CONFIG,
    accounts: manager,
    health,
    activity,
    broker,
    quota: { pollSeconds: options.pollSeconds ?? 300 },
    fetchImpl,
    now,
    ...(options.random ? { random: options.random } : {}),
  });
  return { sampler, clock, calls, alignments, broker, health, accounts, manager };
}

afterEach(() => {
  jest.useRealTimers();
});

/**
 * 把假定时器触发后挂起的异步链跑完。
 *
 * `advanceTimersByTime` 只同步执行到期回调，采样内部还有一长串 await；
 * 让出若干轮微任务比数清层数可靠，又不像真实定时器那样被假时钟扣住。
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

describe("启动主动探测", () => {
  it("0–30s 抖动窗、确定性相位、随机源可注入、停用账号也排相位", async () => {
    const accounts = [account("a"), account("b"), account("off", ["start-plan"], false)];
    const first = harness({ accounts, random: () => 0.5 });
    const delays = await first.sampler.probeAtStartup();
    expect(delays).toHaveLength(3); // 停用账号同样排相位：账号页仍要展示它的额度
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(STARTUP_PROBE_JITTER_MS);
    }
    const repeat = harness({ accounts, random: () => 0.5 });
    expect(await repeat.sampler.probeAtStartup()).toEqual(delays);
    expect(await repeat.sampler.probeAtStartup()).toEqual([]); // 幂等
    first.sampler.stop();
    repeat.sampler.stop();
  });

  it("定时器到点后停用账号也产出额度样本，且采样不改调度资格", async () => {
    const enabled = account("a");
    const off = account("off", ["start-plan"], false);
    const h = harness({
      accounts: [enabled, off],
      random: () => 0,
      balances: [{ show_name: "GLM-5.3", remaining_units: 40, total_units: 100 }],
    });
    jest.useFakeTimers();
    const delays = await h.sampler.probeAtStartup();
    expect(delays).toHaveLength(2);
    jest.advanceTimersByTime(STARTUP_PROBE_JITTER_MS);
    await settle();
    jest.useRealTimers();

    for (const id of [enabled.id, off.id]) {
      const sample = h.sampler.sample(id, "start-plan");
      expect(sample?.stale).toBe(false);
      expect(sample?.quota?.credits?.remainingUnits).toBe(40);
    }

    // 「只是采样」不改调度资格：健康态仍是 ok（采样不写健康），`enabled` 原样保留。
    expect(h.health.status(off.id, "start-plan").status).toBe("ok");
    expect((await h.manager.get(off.id))?.enabled).toBe(false);
    h.sampler.stop();
  });

  it("探测成功的 planes 才写能力对齐；失败不屏蔽", async () => {
    const success = harness({ accounts: [account("a")] });
    await success.sampler.sampleNow(success.accounts[0]!.id, "startup");
    expect(success.alignments[0]!.planKinds).toEqual(["subscription", "experience"]);
    expect(success.alignments[0]!.blocked).toEqual([]);

    const failure = harness({ accounts: [account("b")], failBoth: true });
    await failure.sampler.sampleNow(failure.accounts[0]!.id, "startup");
    expect(failure.alignments[0]!.planKinds).toBeUndefined();
    expect(failure.alignments[0]!.blocked).toEqual([]);
    expect(failure.broker.capability.blockedOf(failure.accounts[0]!)).toEqual([]);
  });

  it("周期采样发现套餐变化（新购/到期）自动更新对齐", async () => {
    const h = harness({ accounts: [account("a")] });
    const id = h.accounts[0]!.id;
    await h.sampler.sampleNow(id, "startup");
    // 只答 credits 平面：模拟订阅到期（coding 端点挂掉）。
    h.clock.now += 31_000;
    await h.sampler.sampleNow(id, "periodic");
    expect(h.alignments.length).toBeGreaterThanOrEqual(1);
    expect(h.broker.capability.blockedOf(h.accounts[0]!)).toEqual([]); // 两套平面都答成功
  });
});

describe("sampleNow 去重（30s 窗口）", () => {
  it("同一账号 30s 内只发一次，跨窗才重发", async () => {
    const h = harness({ accounts: [account("a")] });
    const id = h.accounts[0]!.id;
    expect(await h.sampler.sampleNow(id, "signal:quota-terminal")).not.toBeNull();
    const afterFirst = h.calls.coding;
    expect(await h.sampler.sampleNow(id, "panel-refresh")).toBeNull();
    h.clock.now += SAMPLE_DEDUP_WINDOW_MS - 1;
    expect(await h.sampler.sampleNow(id, "panel-refresh")).toBeNull();
    expect(h.calls.coding).toBe(afterFirst);
    h.clock.now += 1;
    expect(await h.sampler.sampleNow(id, "panel-refresh")).not.toBeNull();
    expect(h.calls.coding).toBe(afterFirst + 1);
  });

  it("不同账号各有各的去重窗", async () => {
    const accounts = [account("a"), account("b")];
    const h = harness({ accounts });
    await h.sampler.sampleNow(accounts[0]!.id, "startup");
    expect(await h.sampler.sampleNow(accounts[1]!.id, "startup")).not.toBeNull();
    expect(h.calls.coding).toBe(2);
  });
});

describe("分级采四类决策", () => {
  it("详情必采 / stale 补采 / 新鲜不采 / 未采过补采", async () => {
    const accounts = [account("a"), account("b"), account("c")];
    const h = harness({ accounts, pollSeconds: 300 });
    const idA = accounts[0]!.id;
    const idB = accounts[1]!.id;
    const idC = accounts[2]!.id;
    // a / c 刚采过；b 没采过。
    await h.sampler.sampleNow(idA, "startup");
    await h.sampler.sampleNow(idC, "startup");
    expect(h.sampler.classifyRefresh([idA, idB, idC], idA)).toEqual([idA, idB]);
    expect(h.sampler.classifyRefresh([idA, idB, idC], undefined)).toEqual([idB]);

    // 全部新鲜后：只有详情账号必采。
    h.clock.now += 31_000;
    await h.sampler.sampleNow(idB, "panel-refresh");
    expect(h.sampler.classifyRefresh([idA, idB, idC], idB)).toEqual([idB]);
    // 超过一个采样周期：stale 之外的正常老化也补采。
    h.clock.now += 300_000;
    expect(h.sampler.classifyRefresh([idA, idB, idC], undefined)).toEqual([idA, idB, idC]);
  });

  it("stale（失败沿用旧值）下一拍补采", async () => {
    const h = harness({ accounts: [account("a")], failBoth: true });
    const id = h.accounts[0]!.id;
    await h.sampler.sampleNow(id, "startup");
    expect(h.sampler.sample(id, "coding-plan")!.stale).toBe(true);
    expect(h.sampler.classifyRefresh([id], undefined)).toEqual([id]);
  });
});

describe("applyHealth 恢复缺口", () => {
  it("采样结果没耗尽时把无 until 的 cooling 放回 ok", async () => {
    const h = harness({ accounts: [account("a")] });
    const id = h.accounts[0]!.id;
    h.health.apply({ kind: "rate-limited" }, id, "coding-plan"); // 429 无 Retry-After
    expect(h.health.status(id, "coding-plan").status).toBe("cooling");
    await h.sampler.sampleNow(id, "signal:empty-stream");
    expect(h.health.status(id, "coding-plan").status).toBe("ok");
  });

  it("有权威 until 的 cooling 不被采样提前抹掉（交给本地时钟）", async () => {
    const h = harness({ accounts: [account("a")] });
    const id = h.accounts[0]!.id;
    h.health.apply({ kind: "rate-limited", retryAfterSeconds: 600 }, id, "coding-plan");
    await h.sampler.sampleNow(id, "panel-refresh");
    expect(h.health.status(id, "coding-plan").status).toBe("cooling");
  });
});
