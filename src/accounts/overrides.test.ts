/**
 * 运行时热调节的用例。
 *
 * 三件事必须同时成立，否则"热调节"就是假的热：
 *
 * 1. **优先级链**：`RuntimeOverride > config.yaml entries[] > 账号 policy`，
 *    逐字段取值。调一次并发不能把权重和启停一起抹掉。
 * 2. **调小不打断在飞**：中途 abort 会让客户端收到半截流，
 *    比慢更糟。新上限只约束"下一次 acquire"。
 * 3. **禁用 = 停止派发**：排队者被唤醒后重算候选，转移到同路由其他账号；没有其他
 *    账号就按 `queueTimeoutMs` 超时 429。force 才中止在飞。
 *
 * @see 运行时账号控制 · RuntimeOverride · entries
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountUnavailableError } from "./broker.js";
import { AccountOverrides, resolvePolicy } from "./overrides.js";
import type { PolicyEntry } from "./overrides.js";
import type { AccountsRouting } from "./routing.js";
import { readPolicyOverrides } from "./policy-store.js";
import { createBroker } from "./runtime.js";
import { accountFor, inMemoryAccounts, zhipuCredential } from "./testing.js";
import { defaultPolicy } from "./types.js";
import type { Account, Credential, RouteKind } from "./types.js";

/**
 * 每个用例一个临时 store 目录：`broker.setAccount*` 会写 `policy.json`，
 * **绝不能**碰到真实 `~/.zcode-proxy`。
 */
let storeDir = "";
const prevStoreDir = process.env.ZCODE_PROXY_STORE_DIR;

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "zcode-overrides-"));
  process.env.ZCODE_PROXY_STORE_DIR = storeDir;
});

afterEach(() => {
  if (prevStoreDir === undefined) delete process.env.ZCODE_PROXY_STORE_DIR;
  else process.env.ZCODE_PROXY_STORE_DIR = prevStoreDir;
  rmSync(storeDir, { recursive: true, force: true });
});

function credential(tag: string): Credential {
  // 账号 id = 凭据指纹：每个账号必须有自己的 apiKey，否则是同一个账号。
  return zhipuCredential({ apiKey: `key-${tag}`, secret: `secret-${tag}`, jwt: `jwt-${tag}` });
}

function account(label: string, routes: RouteKind[], maxConcurrency = 2): Account {
  return accountFor(credential(label), {
    label,
    routes,
    policy: defaultPolicy({ maxConcurrency }),
  });
}

function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("优先级链：RuntimeOverride > entries > 账号 policy", () => {
  const base = account("work", ["coding-plan"], 2);

  it("没有覆盖与条目时用账号自身 policy（即默认值）", () => {
    const policy = resolvePolicy(base, undefined, undefined);
    expect(policy).toEqual({ enabled: true, weight: 1, maxConcurrency: 2 });
  });

  it("entries 覆盖账号 policy", () => {
    const policy = resolvePolicy(base, { label: "work", maxConcurrency: 8, weight: 3 }, undefined);
    expect(policy.maxConcurrency).toBe(8);
    expect(policy.weight).toBe(3);
  });

  it("RuntimeOverride 覆盖 entries", () => {
    const policy = resolvePolicy(
      base,
      { label: "work", maxConcurrency: 8 },
      { maxConcurrency: 1, enabled: false },
    );
    expect(policy.maxConcurrency).toBe(1);
    expect(policy.enabled).toBe(false);
    // 没被覆盖的字段继续沿链条往下取。
    expect(policy.weight).toBe(1);
  });

  it("逐字段覆盖：只调并发不影响启停与权重", () => {
    const policy = resolvePolicy(base, { label: "work", enabled: false, weight: 5 }, { maxConcurrency: 4 });
    expect(policy.maxConcurrency).toBe(4);
    expect(policy.enabled).toBe(false);
    expect(policy.weight).toBe(5);
  });
});

describe("AccountOverrides — expiresAt 到点回落（--ttl）", () => {
  it("到期后 get() 返回 undefined 并清掉条目", () => {
    let now = 1_000;
    const overrides = new AccountOverrides(() => now);
    overrides.set("work", { maxConcurrency: 1, expiresAt: 2_000 });
    expect(overrides.get("work")).toEqual({ maxConcurrency: 1, expiresAt: 2_000 });

    now = 2_000;
    expect(overrides.get("work")).toBeUndefined();
    // 过期条目不应残留在快照里。
    expect(overrides.snapshot()).toEqual([]);
  });

  it("set 是逐字段合并，不会抹掉已有的覆盖", () => {
    const overrides = new AccountOverrides();
    overrides.set("work", { weight: 3 });
    overrides.set("work", { maxConcurrency: 4 });
    expect(overrides.get("work")).toEqual({ weight: 3, maxConcurrency: 4 });
  });

  it("clear 清空某账号的覆盖", () => {
    const overrides = new AccountOverrides();
    overrides.set("work", { weight: 3 });
    expect(overrides.clear("work")).toBe(true);
    expect(overrides.get("work")).toBeUndefined();
    expect(overrides.clear("work")).toBe(false);
  });

  it("validate 拒绝非法取值（面板/脚本直接传错时必须报错）", () => {
    expect(() => AccountOverrides.validate({ weight: 0 })).toThrow();
    expect(() => AccountOverrides.validate({ weight: 1.5 })).toThrow();
    expect(() => AccountOverrides.validate({ maxConcurrency: -1 })).toThrow();
    expect(() => AccountOverrides.validate({ expiresAt: Number.NaN })).toThrow();
    expect(() => AccountOverrides.validate({ maxConcurrency: 0 })).not.toThrow(); // 0 = 软禁用
  });
});

describe("broker 命令面", () => {
  it("setAccountConcurrency 立即生效：新请求按新上限排队", async () => {
    const solo = account("solo", ["coding-plan"], 2);
    const { broker } = inMemoryAccounts([solo], {
      routing: { order: ["coding-plan"], queueTimeoutMs: 20 },
    });

    const held = await broker.acquire({});
    await broker.setAccountConcurrency("solo", 1);

    // 上限已降到 1，在飞 1 → 下一个请求必须排队并超时 429。
    await expect(broker.acquire({})).rejects.toThrow(AccountUnavailableError);
    held.release();

    // 调回 2 之后立刻恢复。
    await broker.setAccountConcurrency("solo", 2);
    const lease = await broker.acquire({});
    lease.release();
  });

  it("调小并发**不打断在飞**请求", async () => {
    const solo = account("solo", ["coding-plan"], 4);
    const { broker } = inMemoryAccounts([solo], { routing: { order: ["coding-plan"] } });

    const a = await broker.acquire({});
    const b = await broker.acquire({});
    expect(broker.leases.inflight(solo.id, "coding-plan")).toBe(2);

    await broker.setAccountConcurrency("solo", 1);

    // 两个在飞请求都还活着，槽位一个没少。
    expect(broker.leases.inflight(solo.id, "coding-plan")).toBe(2);
    expect(a.signal.aborted).toBe(false);
    expect(b.signal.aborted).toBe(false);

    a.release();
    b.release();
  });

  it("setAccountConcurrency(0) = 软禁用：停止派发但不动在飞", async () => {
    const solo = account("solo", ["coding-plan"], 2);
    const { broker } = inMemoryAccounts([solo], {
      routing: { order: ["coding-plan"], queueTimeoutMs: 20 },
    });

    const held = await broker.acquire({});
    await broker.setAccountConcurrency("solo", 0);
    expect(held.signal.aborted).toBe(false); // 在飞不被打断

    await expect(broker.acquire({})).rejects.toThrow(AccountUnavailableError);
    held.release();
  });

  it("setAccountEnabled(false) 默认 drain：等在飞自然结束，只停止派发", async () => {
    const solo = account("solo", ["coding-plan"], 2);
    const { broker } = inMemoryAccounts([solo], { routing: { order: ["coding-plan"] } });

    const held = await broker.acquire({});
    const result = await broker.setAccountEnabled("solo", false);

    expect(result.aborted).toBe(0);
    expect(held.signal.aborted).toBe(false); // drain 不打断在飞
    expect(broker.leases.inflight(solo.id, "coding-plan")).toBe(1);

    await expect(broker.acquire({})).rejects.toThrow(AccountUnavailableError);
    held.release();
  });

  it("setAccountEnabled(false, { drain: false }) = force：立即中止在飞并释放槽位", async () => {
    const solo = account("solo", ["coding-plan"], 2);
    const { broker } = inMemoryAccounts([solo], { routing: { order: ["coding-plan"] } });

    const held = await broker.acquire({});
    const result = await broker.setAccountEnabled("solo", false, { drain: false });

    expect(result.aborted).toBe(1);
    expect(held.signal.aborted).toBe(true); // 上游 fetch 会因此断开
    expect(broker.leases.inflight(solo.id, "coding-plan")).toBe(0);
  });

  it("重新启用后恢复派发", async () => {
    const solo = account("solo", ["coding-plan"], 2);
    const { broker } = inMemoryAccounts([solo], { routing: { order: ["coding-plan"] } });

    await broker.setAccountEnabled("solo", false);
    await expect(broker.acquire({})).rejects.toThrow(AccountUnavailableError);

    await broker.setAccountEnabled("solo", true);
    const lease = await broker.acquire({});
    lease.release();
  });

  it("resetAccountOverrides 清空覆盖，回落到持久配置", async () => {
    const solo = account("solo", ["coding-plan"], 2);
    const { broker } = inMemoryAccounts([solo], { routing: { order: ["coding-plan"] } });

    await broker.setAccountConcurrency("solo", 1);
    expect(broker.overrides.get("solo")).toEqual({ maxConcurrency: 1 });

    expect(await broker.resetAccountOverrides("solo")).toBe(true);
    expect(broker.overrides.get("solo")).toBeUndefined();

    // 回到账号自身的 2：两个槽都能占。
    const a = await broker.acquire({});
    const b = await broker.acquire({});
    expect(broker.leases.inflight(solo.id, "coding-plan")).toBe(2);
    a.release();
    b.release();
  });

  it("setAccountWeight 影响平手时的选号", async () => {
    const light = account("light", ["coding-plan"], 2);
    const heavy = account("heavy", ["coding-plan"], 2);
    const { broker } = inMemoryAccounts([light, heavy], {
      routing: { order: ["coding-plan"] },
    });

    // 默认平手 → 按账号仓顺序取 light。
    const first = await broker.acquire({});
    expect(first.account.label).toBe("light");
    first.release();

    await broker.setAccountWeight("heavy", 9);
    const second = await broker.acquire({});
    expect(second.account.label).toBe("heavy");
    second.release();
  });

  it("命令面作用在未知 label 上报 account-unknown（不静默忽略）", async () => {
    const solo = account("solo", ["coding-plan"], 2);
    const { broker } = inMemoryAccounts([solo]);

    await expect(broker.setAccountConcurrency("nope", 1)).rejects.toThrow(AccountUnavailableError);
  });
});

describe("禁用账号：队列里的请求转移到同路由其他账号", () => {
  it("排队中的请求在账号被禁用后由同路由的另一个账号接手", async () => {
    const a = account("a", ["coding-plan"], 1);
    const b = account("b", ["coding-plan"], 1);
    const { broker } = inMemoryAccounts([a, b], {
      routing: { order: ["coding-plan"], onSaturated: "wait", queueTimeoutMs: 2_000 },
    });

    // 两个账号各占一个槽 → 第三个请求进入队列。
    const heldA = await broker.acquire({});
    const heldB = await broker.acquire({});
    expect(new Set([heldA.account.label, heldB.account.label])).toEqual(new Set(["a", "b"]));

    let done = false;
    const queued = broker.acquire({}).then((lease) => {
      done = true;
      return lease;
    });
    await tick();
    expect(done).toBe(false);
    expect(broker.leases.queueDepth()).toBe(1);

    // 禁用 a 并释放两个槽 → 排队者被唤醒、重算候选（a 出局，b 空出）。
    await broker.setAccountEnabled("a", false);
    heldA.release();
    heldB.release();
    const lease = await queued;
    expect(lease.account.label).toBe("b");

    lease.release();
  });

  it("没有同路由其他账号时，排队者按 queueTimeoutMs 超时 429", async () => {
    const solo = account("solo", ["coding-plan"], 1);
    const { broker } = inMemoryAccounts([solo], {
      routing: { order: ["coding-plan"], onSaturated: "wait", queueTimeoutMs: 20 },
    });

    const held = await broker.acquire({});
    const queued = broker.acquire({});
    await tick();
    await broker.setAccountEnabled("solo", false);
    held.release();

    const err = await queued.then(
      () => {
        throw new Error("expected the queued acquire to fail");
      },
      (e: unknown) => e as AccountUnavailableError,
    );
    expect(err).toBeInstanceOf(AccountUnavailableError);
    expect(err.code).toBe("queue-timeout");
  });
});

/**
 * 持久化（账号级覆盖默认落盘）：三个 setter 与 reset 都要跨重启。
 *
 * 每个用例的「重启」都是真的重来一遍：同一个临时 store 目录，重新开账号仓、重新造
 * `Broker`（`createBroker` 就是三个入口共用的那一步）。只看内存断言证明不了持久化。
 */
describe("账号级覆盖落盘：重启后值还在", () => {
  const CODING_ONLY: Partial<AccountsRouting> = { order: ["coding-plan"], onSaturated: "overflow" };

  /** 重建一个 broker：同一份落盘、同一批账号，等价于进程重启。*/
  async function restart(entries?: PolicyEntry[]) {
    const solo = account("solo", ["coding-plan"], 2);
    const { manager } = inMemoryAccounts([solo]);
    // `createBroker` 就是三个入口共用的启动那一步（config.yaml + 落盘覆盖）。
    const broker = await createBroker(manager, null, { routing: CODING_ONLY, ...(entries ? { entries } : {}) });
    return { broker, account: solo };
  }

  it("setAccountConcurrency 落盘：重建 broker 后值还在", async () => {
    const first = await restart();
    await first.broker.setAccountConcurrency("solo", 4);
    expect((await readPolicyOverrides()).entries).toEqual({ solo: { maxConcurrency: 4 } });

    const second = await restart();
    expect(second.broker.overrides.get("solo")).toEqual({ maxConcurrency: 4 });
  });

  it("setAccountWeight / setAccountEnabled 同样落盘，且启动后真的生效", async () => {
    const first = await restart();
    await first.broker.setAccountWeight("solo", 9);
    await first.broker.setAccountEnabled("solo", false);
    expect((await readPolicyOverrides()).entries).toEqual({ solo: { weight: 9, enabled: false } });

    const second = await restart();
    expect(second.broker.overrides.get("solo")).toEqual({ weight: 9, enabled: false });
    // 生效值也一起回来了：禁用状态不该因为重启就复活。
    await expect(second.broker.acquire({})).rejects.toThrow(AccountUnavailableError);
  });

  it("resetAccountOverrides 清内存与落盘，重建后回落到 config.yaml 的 entries", async () => {
    // config.yaml 写着并发 1；用户在面板改成 4，再点「重置」。
    const first = await restart([{ label: "solo", maxConcurrency: 1 }]);
    await first.broker.setAccountConcurrency("solo", 4);
    expect((await readPolicyOverrides()).entries).toEqual({ solo: { maxConcurrency: 4 } });

    expect(await first.broker.resetAccountOverrides("solo")).toBe(true);
    expect(first.broker.overrides.get("solo")).toBeUndefined();
    // 落盘那条也要消失，否则重启会把它读回来。
    expect((await readPolicyOverrides()).entries).toBeUndefined();

    const second = await restart([{ label: "solo", maxConcurrency: 1 }]);
    expect(second.broker.overrides.get("solo")).toBeUndefined();
    // 回落到 entries 的 1：第二个请求立刻溢出（不排队，直接 429）。
    const held = await second.broker.acquire({});
    await expect(second.broker.acquire({})).rejects.toThrow(AccountUnavailableError);
    held.release();
  });

  it("config.yaml 的 entries 与 persisted 冲突时，persisted 赢（优先级链）", async () => {
    const first = await restart();
    await first.broker.setAccountConcurrency("solo", 4);
    expect((await readPolicyOverrides()).entries).toEqual({ solo: { maxConcurrency: 4 } });

    // 重启时 config.yaml 说 1，persisted 说 4：优先级链第一档是 RuntimeOverride。
    const second = await restart([{ label: "solo", maxConcurrency: 1 }]);
    expect(second.broker.overrides.get("solo")).toEqual({ maxConcurrency: 4 });
    const leases = [];
    for (let i = 0; i < 4; i++) leases.push(await second.broker.acquire({}));
    expect(second.broker.leases.inflight(second.account.id, "coding-plan")).toBe(4);
    for (const lease of leases) lease.release();
  });
});
