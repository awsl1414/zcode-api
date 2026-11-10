/**
 * 请求侧的三条用例：drained 降级、RPM 闸、`Retry-After` 与上游耗尽码的接线。
 *
 * 与 `quota.test.ts` 的分工：那边验"怎么采、怎么判"，这边验"判完之后调度器怎么走"，
 * 即验收口径 **start-plan 用完自动切 coding-plan**。
 *
 * @see 三种切走 · 兜底 · 采集 · drained 判定 · 粘性
 */
import { describe, expect, it } from "bun:test";
import { AccountUnavailableError } from "./broker.js";
import { AccountOverrides } from "./overrides.js";
import { defaultPolicy } from "./types.js";
import { accountFor, inMemoryAccounts, zhipuCredential } from "./testing.js";
import type { Account, RouteKind } from "./types.js";

/** 一个能走某条路由的账号（凭据带 apiKey 对 + plan JWT，两条路由都开得起）。*/
function account(label: string, routes: RouteKind[], maxConcurrency = 2): Account {
  return accountFor(
    zhipuCredential({ apiKey: `key-${label}`, secret: `secret-${label}`, jwt: `jwt-${label}` }),
    { label, routes, policy: defaultPolicy({ maxConcurrency }) },
  );
}

/**
 * "额度还会很久才恢复"的时间点。
 *
 * 必须**相对真实时钟**取未来值：`health.status()` 见到 `until <= now` 就自动回落成
 * `ok`（`health.ts` 的惰性过期），写死一个绝对时间戳在测试跑起来的第二天就会变成
 * "过去"，用例会莫名其妙地变绿/变红。
 */
const RESET_AT = Date.now() + 3_600_000;

/** 固定时钟（冷却/窗口的断言都靠它跨过时间，不真的 sleep）。*/
function fixedClock(start = 1_720_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// drained 降级
// ---------------------------------------------------------------------------

describe("drained 降级：onDrained 的两种动作", () => {
  it("fallback（默认）：start-plan 额度耗尽 → 降到 order 下一档 coding-plan", async () => {
    const startPlan = account("start", ["start-plan"]);
    const coding = account("coding", ["coding-plan"]);
    const { broker } = inMemoryAccounts([startPlan, coding], {
      routing: { order: ["start-plan", "coding-plan"] },
    });

    // 采样判定 start-plan 耗尽 → 该 (account, route) 退出候选集。
    broker.health.markDrained(startPlan.id, "start-plan", RESET_AT);

    const lease = await broker.acquire({});
    // 降级而不是报错：这就是 drained 的验收行为。
    expect(lease.account.id).toBe(coding.id);
    expect(lease.route).toBe("coding-plan");
    lease.release();
  });

  it("fallback：同一账号同时有两条路由时也降级到自己的下一档", async () => {
    const both = account("both", ["start-plan", "coding-plan"]);
    const { broker } = inMemoryAccounts([both], {
      routing: { order: ["start-plan", "coding-plan"] },
    });
    broker.health.markDrained(both.id, "start-plan", RESET_AT);

    const lease = await broker.acquire({});
    expect(lease.account.id).toBe(both.id);
    expect(lease.route).toBe("coding-plan");
    lease.release();
  });

  it("stop：该档全 drained 时直接报错，不降级", async () => {
    const startPlan = account("start", ["start-plan"]);
    const coding = account("coding", ["coding-plan"]);
    const { broker } = inMemoryAccounts([startPlan, coding], {
      routing: { order: ["start-plan", "coding-plan"], onDrained: "stop" },
    });
    broker.health.markDrained(startPlan.id, "start-plan", RESET_AT);

    const err = await broker.acquire({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountUnavailableError);
    const unavailable = err as AccountUnavailableError;
    // 429 + Retry-After 的容量语义（不是 503 凭据语义）。
    expect(unavailable.code).toBe("quota-exhausted");
    expect(unavailable.message).toContain("out of quota");
    expect(unavailable.message).toContain("stop");
    expect(unavailable.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("stop 只拦真正的 drained：该档只是冷却（auth-failed）时仍然降级", async () => {
    const startPlan = account("start", ["start-plan"]);
    const coding = account("coding", ["coding-plan"]);
    const { broker } = inMemoryAccounts([startPlan, coding], {
      routing: { order: ["start-plan", "coding-plan"], onDrained: "stop" },
    });
    // 冷却 ≠ 耗尽：onDrained 不该管它，按 order 正常降级。
    broker.health.apply({ kind: "auth" }, startPlan.id, "start-plan");

    const lease = await broker.acquire({});
    expect(lease.route).toBe("coding-plan");
    lease.release();
  });

  it("全部档都 drained：报 all-accounts-cooling 并带最早恢复时间", async () => {
    const startPlan = account("start", ["start-plan"]);
    const coding = account("coding", ["coding-plan"]);
    const clock = fixedClock();
    const { broker } = inMemoryAccounts([startPlan, coding], { now: clock.now });
    broker.health.markDrained(startPlan.id, "start-plan", clock.now() + 30_000);
    broker.health.markDrained(coding.id, "coding-plan", clock.now() + 10_000);

    const err = await broker.acquire({}).catch((e: unknown) => e);
    const unavailable = err as AccountUnavailableError;
    expect(unavailable.code).toBe("all-accounts-cooling");
    // 取最早恢复者（10s 那条），不是第一条命中的 30s。
    expect(unavailable.retryAfterSeconds).toBe(10);
  });

  it("粘性绑定改写：绑在 drained 账号上的会话改绑到新账号", async () => {
    const a = account("a", ["coding-plan"]);
    const b = account("b", ["coding-plan"]);
    const { broker } = inMemoryAccounts([a, b], {
      routing: { order: ["coding-plan"], strategy: "sticky-hash" },
    });

    const first = await broker.acquire({ sessionId: "s-1" });
    const bound = broker.bindings.get("s-1");
    expect(bound).toBeDefined();
    const boundId = bound!.accountId;
    first.release();

    // 把绑定的那个账号判成 drained：本次请求必须换号**并改写绑定**。
    // drained 改写、saturated 不改写，这是两条不同的腿。
    broker.health.markDrained(boundId, "coding-plan", RESET_AT);

    const second = await broker.acquire({ sessionId: "s-1" });
    expect(second.account.id).not.toBe(boundId);
    expect(broker.bindings.get("s-1")!.accountId).toBe(second.account.id);
    second.release();
  });

  it("显式指定（X-ZCode-Account / 钉号）命中 drained 账号：直接报错，不静默改道", async () => {
    const a = account("a", ["coding-plan"]);
    const b = account("b", ["coding-plan"]);
    const { broker } = inMemoryAccounts([a, b]);
    broker.health.markDrained(a.id, "coding-plan", RESET_AT);

    const err = await broker.acquire({ requestedAccount: "a" }).catch((e: unknown) => e);
    const unavailable = err as AccountUnavailableError;
    expect(unavailable.code).toBe("account-unhealthy");
    expect(unavailable.message).toContain("drained");
    expect(unavailable.retryAfterSeconds).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// RPM 闸真正生效
// ---------------------------------------------------------------------------

describe("rpmLimit 真正生效（saturated 语义）", () => {
  it("超限被拦：达到 rpmLimit 后第 N+1 个请求按饱和处理（不排队到上游）", async () => {
    const solo = account("solo", ["coding-plan"], 8);
    const { broker } = inMemoryAccounts([solo], {
      // overflow = 不排队：直接把"此刻没容量"翻译成 429，用例不用等队列超时。
      routing: { order: ["coding-plan"], onSaturated: "overflow" },
      entries: [{ label: "solo", rpmLimit: 2 }],
    });

    const one = await broker.acquire({});
    const two = await broker.acquire({});
    expect(broker.rpm.inflightWindow(solo.id)).toBe(2);

    const err = await broker.acquire({}).catch((e: unknown) => e);
    const unavailable = err as AccountUnavailableError;
    expect(unavailable.code).toBe("accounts-saturated");
    // 被拦下的尝试不计数（它没出线）。
    expect(broker.rpm.inflightWindow(solo.id)).toBe(2);
    one.release();
    two.release();
  });

  it("未配置 rpmLimit：不拦（只受并发上限约束）", async () => {
    const solo = account("solo", ["coding-plan"], 8);
    const { broker } = inMemoryAccounts([solo], {
      routing: { order: ["coding-plan"], onSaturated: "overflow" },
    });

    const leases = [];
    for (let i = 0; i < 5; i++) leases.push(await broker.acquire({}));
    expect(leases.length).toBe(5);
    expect(broker.rpm.inflightWindow(solo.id)).toBe(5);
    for (const lease of leases) lease.release();
  });

  it("窗口滑过之后重新放行（RPM 是速率而不是总量）", async () => {
    const solo = account("solo", ["coding-plan"], 8);
    const clock = fixedClock();
    const { broker } = inMemoryAccounts([solo], {
      routing: { order: ["coding-plan"], onSaturated: "overflow" },
      entries: [{ label: "solo", rpmLimit: 1 }],
      now: clock.now,
    });

    const first = await broker.acquire({});
    const blocked = await broker.acquire({}).catch((e: unknown) => e);
    expect((blocked as AccountUnavailableError).code).toBe("accounts-saturated");

    clock.advance(60_000);
    const afterWindow = await broker.acquire({});
    expect(afterWindow.account.id).toBe(solo.id);
    first.release();
    afterWindow.release();
  });

  it("账号自身 policy 的 rpmLimit 同样生效（配置不是唯一来源）", async () => {
    const solo = accountFor(zhipuCredential({ apiKey: "k", secret: "s", jwt: "j" }), {
      label: "solo",
      routes: ["coding-plan"],
      policy: defaultPolicy({ maxConcurrency: 8, rpmLimit: 1 }),
    });
    const { broker } = inMemoryAccounts([solo], {
      routing: { order: ["coding-plan"], onSaturated: "overflow" },
    });
    const first = await broker.acquire({});
    const blocked = await broker.acquire({}).catch((e: unknown) => e);
    expect((blocked as AccountUnavailableError).code).toBe("accounts-saturated");
    first.release();
  });

  it("entries 的 rpmLimit 覆盖账号 policy（账号策略优先级链）", async () => {
    const solo = accountFor(zhipuCredential({ apiKey: "k2", secret: "s2", jwt: "j2" }), {
      label: "solo",
      routes: ["coding-plan"],
      policy: defaultPolicy({ maxConcurrency: 8, rpmLimit: 1 }),
    });
    const { broker } = inMemoryAccounts([solo], {
      routing: { order: ["coding-plan"], onSaturated: "overflow" },
      entries: [{ label: "solo", rpmLimit: 3 }],
    });
    const leases = [];
    for (let i = 0; i < 3; i++) leases.push(await broker.acquire({}));
    expect(leases.length).toBe(3);
    for (const lease of leases) lease.release();
  });
});

// ---------------------------------------------------------------------------
// Retry-After 与上游耗尽码的接线
// ---------------------------------------------------------------------------

describe("上游信号接线：Retry-After 与额度耗尽码", () => {
  it("429 带 Retry-After：冷却时长用头里的值 + 后置抖动（只加不减）", () => {
    const clock = fixedClock();
    const solo = account("solo", ["coding-plan"]);
    const { broker } = inMemoryAccounts([solo], { now: clock.now });

    // 信号分类（429 → rate-limited、retry-after 解析）的真源在 signals.ts，
    // broker 只做「信号 → 引擎迁移 + 唤醒排队者」，统一入口是
    // `noteUpstreamSignal`（分立的上报入口会让同一信号报两次，403 双报即其产物）。
    broker.noteUpstreamSignal(solo, "coding-plan", { kind: "rate-limited", retryAfterSeconds: 12 });
    const state = broker.health.status(solo.id, "coding-plan");
    expect(state.status).toBe("cooling");
    expect(state.reason).toBe("rate-limited");
    // 12s 无 cap 采信 + 抖动 [0, min(2.4s, 5s)]：绝不早于上游要求。
    expect(state.until! - clock.now()).toBeGreaterThanOrEqual(12_000);
    expect(state.until! - clock.now()).toBeLessThanOrEqual(14_400);
    expect(broker.health.isAvailable(solo.id, "coding-plan")).toBe(false);
  });

  it("429 没有 Retry-After：无 until（等采样确认，不回落固定常量）", () => {
    const clock = fixedClock();
    const solo = account("solo", ["coding-plan"]);
    const { broker } = inMemoryAccounts([solo], { now: clock.now });

    broker.noteUpstreamSignal(solo, "coding-plan", { kind: "rate-limited" });
    const state = broker.health.status(solo.id, "coding-plan");
    expect(state.status).toBe("cooling");
    expect(state.until).toBeUndefined();
  });

  it("冷却到点自动回到候选集（冷却不是永久封号）", async () => {
    const clock = fixedClock();
    const solo = account("solo", ["coding-plan"]);
    const { broker } = inMemoryAccounts([solo], {
      routing: { order: ["coding-plan"] },
      now: clock.now,
    });
    broker.noteUpstreamSignal(solo, "coding-plan", { kind: "rate-limited", retryAfterSeconds: 5 });
    expect(broker.health.isAvailable(solo.id, "coding-plan")).toBe(false);
    // 5s + 后置抖动上限 min(1s, 5s)：拨过 6s 必然到点。
    clock.advance(6_000);
    expect(broker.health.isAvailable(solo.id, "coding-plan")).toBe(true);
    const lease = await broker.acquire({});
    lease.release();
  });

  it("额度终态信号 → drained，退出候选集", () => {
    const solo = account("solo", ["coding-plan"]);
    const { broker } = inMemoryAccounts([solo], { routing: { order: ["coding-plan"] } });

    // zai 的 1113（余额不足）与 1005（quotaExhausted，claim 平面同码）——两码在
    // signals.ts 全表里都是 quota-terminal（1304/1308/1316-1321 同族）。
    broker.noteUpstreamSignal(solo, "coding-plan", { kind: "quota-terminal", code: 1_113 });
    expect(broker.health.status(solo.id, "coding-plan").status).toBe("drained");

    broker.health.markOk(solo.id, "coding-plan");
    broker.noteUpstreamSignal(solo, "coding-plan", { kind: "quota-terminal", code: "1005" });
    expect(broker.health.status(solo.id, "coding-plan").status).toBe("drained");
  });

  it("auth 信号（3007 归 auth kind，真源 signals.ts）：5min 冷却，绝不判 drained", () => {
    const solo = account("solo", ["coding-plan"]);
    const { broker } = inMemoryAccounts([solo], { routing: { order: ["coding-plan"] } });

    broker.noteUpstreamSignal(solo, "coding-plan", { kind: "auth", code: 3_007 });
    const state = broker.health.status(solo.id, "coding-plan");
    expect(state.status).toBe("cooling");
    expect(state.reason).toBe("auth-failed");
    expect(state.status).not.toBe("drained");
  });


  it("上游耗尽后粘性绑定随之失效", async () => {
    const solo = account("solo", ["coding-plan"]);
    const { broker } = inMemoryAccounts([solo], { routing: { order: ["coding-plan"] } });

    const lease = await broker.acquire({ sessionId: "s-x" });
    lease.release();
    expect(broker.bindings.get("s-x")).toBeDefined();

    broker.noteUpstreamSignal(solo, "coding-plan", { kind: "quota-terminal", code: 1_113 });
    // drained 之后：绑定命中但不可用 → 解绑，且没有别的候选 → 明确报冷却。
    const err = await broker.acquire({ sessionId: "s-x" }).catch((e: unknown) => e);
    expect((err as AccountUnavailableError).code).toBe("all-accounts-cooling");
    expect(broker.bindings.get("s-x")).toBeUndefined();
  });

  it("运行时可覆盖表不含 rpmLimit（覆盖层只开放三个旋钮）", () => {
    // 这条断言是给未来改动的护栏：RPM 是风控参数，一旦进了运行时覆盖层就会出现
    // "面板改了一半、在飞请求按哪份配额算"的中间态。
    const overrides = new AccountOverrides();
    expect(Object.keys(overrides.get("x") ?? {})).toEqual([]);
  });
});
