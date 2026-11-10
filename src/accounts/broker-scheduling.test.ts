/**
 * 调度的用例：候选集五层过滤、选号、三种切走、兜底。
 *
 * 这些用例全部在 broker 层断言**可观测的调度事实**（在飞数、选中的账号/路由、原因码、
 * `Retry-After`），而不是"返回了个对象"：错误映射分 429/400/503 三档，
 * 混档会让客户端做错事（排队排满 ≠ 凭据坏了）。
 *
 * @see 候选集计算 · 选号顺序 · 三种切走 · 兜底 · 能力矩阵
 */
import { describe, expect, it } from "bun:test";
import { configureLogging, resetLogging } from "../log/index.js";
import { AccountUnavailableError, type BrokerErrorCode } from "./broker.js";
import { accountFor, inMemoryAccounts, zhipuCredential } from "./testing.js";
import { defaultPolicy } from "./types.js";
import type { Account, Credential, RouteKind } from "./types.js";

/**
 * zai 套餐凭据。**每个账号必须有自己的 apiKey**：账号 id 就是凭据指纹，
 * 共用凭据的两个账号其实是同一个账号，会共享同一个槽位池（`(accountId, route)`），
 * 那样"两个账号各 2 并发"就变成了"一个账号 2 并发"，用例测的就不是它想测的东西。
 */
function zaiCredential(tag: string): Credential {
  return zhipuCredential({ apiKey: `key-${tag}`, secret: `secret-${tag}`, jwt: `jwt-${tag}` });
}

function account(label: string, routes: RouteKind[], maxConcurrency = 2): Account {
  return accountFor(zaiCredential(label), {
    label,
    routes,
    policy: defaultPolicy({ maxConcurrency }),
  });
}

function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectCode(
  fn: () => Promise<unknown>,
  code: BrokerErrorCode,
): Promise<AccountUnavailableError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AccountUnavailableError);
    const unavailable = err as AccountUnavailableError;
    expect(unavailable.code).toBe(code);
    return unavailable;
  }
  throw new Error(`expected AccountUnavailableError(${code})`);
}

describe("候选集：模型能力（第三层过滤）", () => {
  it("start-plan 不支持 glm-5.3：请求 glm-5.3 时直接落到 coding-plan", async () => {
    const trial = account("trial", ["start-plan"]);
    const coding = account("coding", ["coding-plan"]);
    const { broker } = inMemoryAccounts([trial, coding]);

    const lease = await broker.acquire({ model: "glm-5.3" });
    expect(lease.account.label).toBe("coding");
    expect(lease.route).toBe("coding-plan");
    lease.release();
  });

  it("glm-5.2 可以走 start-plan：默认 order 里 start-plan 优先", async () => {
    const trial = account("trial", ["start-plan"]);
    const coding = account("coding", ["coding-plan"]);
    const { broker } = inMemoryAccounts([trial, coding]);

    const lease = await broker.acquire({ model: "glm-5.2" });
    expect(lease.account.label).toBe("trial");
    expect(lease.route).toBe("start-plan");
    lease.release();
  });

  it("没有任何账号能服务该模型 → model-unsupported（400，不排队）", async () => {
    const trial = account("trial", ["start-plan"]);
    const { broker } = inMemoryAccounts([trial]);

    await expectCode(() => broker.acquire({ model: "glm-5.3" }), "model-unsupported");
  });

  it("未知 model id 不拦（项目不做模型白名单）", async () => {
    const coding = account("coding", ["coding-plan"]);
    const { broker } = inMemoryAccounts([coding]);

    const lease = await broker.acquire({ model: "glm-4.6" });
    expect(lease.route).toBe("coding-plan");
    lease.release();
  });
});

describe("候选集：启用 / 健康 / 在飞（第一、四、五层过滤）", () => {
  it("禁用的账号不参与选号", async () => {
    const disabled = accountFor(zaiCredential("off"), { label: "off", routes: ["coding-plan"], enabled: false });
    const live = account("live", ["coding-plan"]);
    const { broker } = inMemoryAccounts([disabled, live]);

    const lease = await broker.acquire({ model: "glm-4.6" });
    expect(lease.account.label).toBe("live");
    lease.release();
  });

  it("全部禁用 → no-account（503 档，客户端改不了）", async () => {
    const disabled = accountFor(zaiCredential("off"), { label: "off", routes: ["coding-plan"], enabled: false });
    const { broker } = inMemoryAccounts([disabled]);

    const err = await expectCode(() => broker.acquire({}), "no-account");
    expect(err.message).toContain("disabled");
  });

  it("在飞数最少者优先", async () => {
    const busy = account("busy", ["coding-plan"], 4);
    const idle = account("idle", ["coding-plan"], 4);
    const { broker } = inMemoryAccounts([busy, idle]);

    // 先给 busy 占一个槽：此后选号必须偏向 idle（在飞更少）。
    const first = await broker.acquire({ requestedAccount: "busy" });
    expect(first.account.label).toBe("busy");

    const next = await broker.acquire({ model: "glm-4.6" });
    expect(next.account.label).toBe("idle");

    first.release();
    next.release();
  });

  it("平手按权重：权重高的先被选中", async () => {
    const light = account("light", ["coding-plan"], 2);
    const heavy = accountFor(zaiCredential("heavy"), {
      label: "heavy",
      routes: ["coding-plan"],
      policy: defaultPolicy({ maxConcurrency: 2, weight: 5 }),
    });
    const { broker } = inMemoryAccounts([light, heavy]);

    const lease = await broker.acquire({ model: "glm-4.6" });
    expect(lease.account.label).toBe("heavy");
    lease.release();
  });
});

describe("saturated：wait 与 overflow", () => {
  it("wait（默认）：排队等同一账号，释放后拿到槽", async () => {
    const solo = account("solo", ["coding-plan"], 1);
    const { broker } = inMemoryAccounts([solo], {
      routing: { order: ["coding-plan"], onSaturated: "wait", queueTimeoutMs: 2_000 },
    });

    const first = await broker.acquire({ model: "glm-4.6" });
    let secondDone = false;
    const pending = broker.acquire({ model: "glm-4.6" }).then((lease) => {
      secondDone = true;
      return lease;
    });

    await tick();
    expect(secondDone).toBe(false);
    expect(broker.leases.queueDepth()).toBe(1);

    first.release();
    const second = await pending;
    expect(second.account.label).toBe("solo");
    expect(broker.leases.queueDepth()).toBe(0);
    second.release();
  });

  it("wait：排队超时 → queue-timeout + Retry-After（429）", async () => {
    const solo = account("solo", ["coding-plan"], 1);
    const { broker } = inMemoryAccounts([solo], {
      routing: { order: ["coding-plan"], onSaturated: "wait", queueTimeoutMs: 20 },
    });

    const held = await broker.acquire({ model: "glm-4.6" });
    const err = await expectCode(
      () => broker.acquire({ model: "glm-4.6" }),
      "queue-timeout",
    );
    expect(err.retryAfterSeconds).toBe(1);
    held.release();
  });

  it("overflow：同路由还有空闲账号就换号（不排队）", async () => {
    const a = account("a", ["coding-plan"], 1);
    const b = account("b", ["coding-plan"], 1);
    const { broker } = inMemoryAccounts([a, b], {
      routing: { order: ["coding-plan"], onSaturated: "overflow" },
    });

    const first = await broker.acquire({ model: "glm-4.6" });
    const second = await broker.acquire({ model: "glm-4.6" });
    expect(first.account.id).not.toBe(second.account.id);
    expect(broker.leases.queueDepth()).toBe(0);

    // 两个都满了 → order 已尽 → 直接 429（overflow 的语义就是不排队）。
    const err = await expectCode(
      () => broker.acquire({ model: "glm-4.6" }),
      "accounts-saturated",
    );
    expect(err.retryAfterSeconds).toBe(1);

    first.release();
    second.release();
  });

  it("overflow：本档全满时降级到 order 的下一档", async () => {
    const coding = account("coding", ["coding-plan"], 1);
    const trial = account("trial", ["start-plan"], 1);
    const { broker } = inMemoryAccounts([coding, trial], {
      routing: { order: ["coding-plan", "start-plan"], onSaturated: "overflow" },
    });

    const first = await broker.acquire({});
    expect(first.route).toBe("coding-plan");

    const second = await broker.acquire({});
    expect(second.route).toBe("start-plan");
    expect(second.account.label).toBe("trial");

    first.release();
    second.release();
  });
});

describe("auth-failed：冷却 + 同路由换号，不降级", () => {
  it("冷却该 (account, route)，下一次选号换同路由的另一个账号", async () => {
    const a = account("a", ["coding-plan"], 2);
    const b = account("b", ["coding-plan"], 2);
    const { broker } = inMemoryAccounts([a, b], {
      routing: { order: ["coding-plan"], onSaturated: "wait" },
    });

    const first = await broker.acquire({ requestedAccount: "a" });
    broker.noteUpstreamSignal(first.account, first.route, { kind: "auth" });
    first.release();

    // a 在 coding-plan 上冷却中 → 必须换到 b，且**仍是** coding-plan（不降级）。
    const second = await broker.acquire({ model: "glm-4.6" });
    expect(second.account.label).toBe("b");
    expect(second.route).toBe("coding-plan");
    second.release();
  });

  it("显式指定一个冷却中的账号 → account-unhealthy（不静默改道）", async () => {
    const a = account("a", ["coding-plan"], 2);
    const b = account("b", ["coding-plan"], 2);
    const { broker } = inMemoryAccounts([a, b]);

    broker.noteUpstreamSignal(a, "coding-plan", { kind: "auth" });
    const err = await expectCode(
      () => broker.acquire({ requestedAccount: "a" }),
      "account-unhealthy",
    );
    // 冷却是有期限的，所以带 Retry-After。
    expect(err.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("冷却只作用于那一条路由，不牵连账号的其他路由（状态键是 (account, route)）", async () => {
    const both = account("both", ["coding-plan", "start-plan"], 2);
    const { broker } = inMemoryAccounts([both], {
      routing: { order: ["coding-plan", "start-plan"] },
    });

    broker.noteUpstreamSignal(both, "coding-plan", { kind: "auth" });
    expect(broker.health.isAvailable(both.id, "coding-plan")).toBe(false);
    expect(broker.health.isAvailable(both.id, "start-plan")).toBe(true);

    // coding-plan 不可用 → 降级到 start-plan（当前档无候选）。
    const lease = await broker.acquire({});
    expect(lease.route).toBe("start-plan");
    lease.release();
  });

  it("全部账号冷却 → all-accounts-cooling，带最早恢复时间", async () => {
    const a = account("a", ["coding-plan"], 2);
    const { broker } = inMemoryAccounts([a], { routing: { order: ["coding-plan"] } });

    broker.noteUpstreamSignal(a, "coding-plan", { kind: "auth" });
    const err = await expectCode(() => broker.acquire({}), "all-accounts-cooling");
    expect(err.message).toContain("cooling");
    expect(err.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});

describe("drained：状态与动作接口", () => {
  it("标记 drained 后该 (account, route) 不再进候选集", async () => {
    const a = account("a", ["coding-plan"], 2);
    const { broker } = inMemoryAccounts([a], { routing: { order: ["coding-plan"] } });

    broker.health.markDrained(a.id, "coding-plan");
    expect(broker.health.isAvailable(a.id, "coding-plan")).toBe(false);
    await expectCode(() => broker.acquire({}), "all-accounts-cooling");
  });
});

describe("调度器内部异常不再静默 fail-open", () => {
  it("账号仓读取失败时把异常抛给调用方（并打一行日志）", async () => {
    const a = account("a", ["coding-plan"], 1);
    const { broker, manager } = inMemoryAccounts([a]);
    // 模拟存储 IO 失败：`list()` 抛错。
    manager.list = async () => {
      throw new Error("simulated store failure");
    };

    // 日志走 `src/log/` 的 logger（写 `process.stderr`），不再走 `console.error`，
    // 所以这里注入一个内存 sink：断言的东西没变（"失败要留一行日志"），抓取位置变了。
    const errors: string[] = [];
    configureLogging({ write: (line) => { errors.push(line); } });
    try {
      // 早先这里会退回「默认账号 + 白名单第一条路由」，把 bug 藏进一个看起来
      // 正常的请求里；没有默认账号之后那条路也不存在了。
      await expect(broker.acquire({})).rejects.toThrow("simulated store failure");
    } finally {
      resetLogging();
    }
    expect(errors.some((line) => line.includes("simulated store failure"))).toBe(true);
    // 没有拿到租约，所以也没有占槽。
    expect(broker.leases.inflight(a.id, "coding-plan")).toBe(0);
  });
});
