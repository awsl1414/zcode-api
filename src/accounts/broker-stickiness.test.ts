/**
 * 调度层的粘性用例：绑定优先、失效重绑、溢出不改写、冷却换号。
 *
 * 这里断言的都是**可观测的调度事实**（选中哪个账号、绑定表现在是什么、等了多久），
 * 因为粘性的价值全在"下一次请求落在哪"上：只看"返回了个租约"证明不了任何事。
 *
 * 用例分成五组，对应四条失效条件加来源为 `none` 的陷阱：
 *
 * 1. 稳定命中 / 绑定优先于负载
 * 2. 失效：TTL 到期、账号删除、账号禁用、该 `(account, route)` 冷却
 * 3. 饱和：`wait` / `overflow` / `wait-then-overflow`，且 overflow **不改写绑定**
 * 4. `none` 来源（无 sessionId）不写绑定表
 * 5. 三种策略经 broker 接线后的实际选号结果
 *
 * @see 粘性 · 三个实现陷阱 · 选号顺序
 */
import { describe, expect, it } from "bun:test";
import { accountFor, inMemoryAccounts, zhipuCredential } from "./testing.js";
import { defaultPolicy } from "./types.js";
import type { Account, Credential, RouteKind } from "./types.js";

/** 每个账号必须有自己的凭据：账号 id 就是凭据指纹。 */
function credential(tag: string): Credential {
  return zhipuCredential({ apiKey: `key-${tag}`, secret: `secret-${tag}`, jwt: `jwt-${tag}` });
}

function account(label: string, maxConcurrency = 2, weight = 1): Account {
  return accountFor(credential(label), {
    label,
    routes: ["coding-plan"] as RouteKind[],
    policy: defaultPolicy({ maxConcurrency, weight }),
  });
}

function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 只跑 coding-plan 一档的调度参数，避免默认 order 把请求带去 start-plan。 */
const CODING_ONLY = { order: ["coding-plan"] as RouteKind[] };

describe("粘性：同一 sessionId 稳定命中", () => {
  it("sticky-hash 下同一会话多次请求固定同一账号，且写入了绑定", async () => {
    const a = account("a");
    const b = account("b");
    const c = account("c");
    const { broker } = inMemoryAccounts([a, b, c], { routing: CODING_ONLY });

    const first = await broker.acquire({ sessionId: "ses_stable" });
    const firstLabel = first.account.label;
    first.release();

    for (let round = 0; round < 5; round++) {
      const lease = await broker.acquire({ sessionId: "ses_stable" });
      expect(lease.account.label).toBe(firstLabel);
      lease.release();
    }

    expect(broker.bindings.size()).toBe(1);
    expect(broker.bindings.get("ses_stable")?.accountId).toBe(first.account.id);
  });

  it("绑定优先于负载：绑定账号不是最闲的那个也照样用它", async () => {
    const a = account("a");
    const b = account("b");
    const { broker } = inMemoryAccounts([a, b], {
      routing: { ...CODING_ONLY, withinTier: "drain-first", strategy: "balanced" },
    });

    const first = await broker.acquire({ sessionId: "ses_pin" });
    first.release();
    const bound = first.account;

    // 给绑定账号占一个槽，让它成为"在飞更多"的那个（balanced 本会选另一个）。
    const busy = await broker.acquire({ requestedAccount: bound.label });

    const next = await broker.acquire({ sessionId: "ses_pin" });
    expect(next.account.label).toBe(bound.label);

    next.release();
    busy.release();
  });
});

describe("粘性失效：TTL 到期重绑", () => {
  it("TTL 过期后绑定失效，按策略重新选号并写新绑定", async () => {
    let now = 1_000_000;
    const a = account("a");
    const b = account("b");
    const { broker } = inMemoryAccounts([a, b], {
      routing: { ...CODING_ONLY, withinTier: "drain-first", strategy: "balanced" },
      stickiness: { ttlSeconds: 10 },
      now: () => now,
    });

    const first = await broker.acquire({ sessionId: "ses_ttl" });
    const boundId = first.account.id;
    first.release();
    expect(broker.bindings.get("ses_ttl")?.accountId).toBe(boundId);

    // 绑定账号占一个槽：TTL 过期后 balanced 会选更闲的另一个账号。
    const busy = await broker.acquire({ requestedAccount: first.account.label });

    now += 11_000; // 越过 10 秒 TTL
    const rebound = await broker.acquire({ sessionId: "ses_ttl" });

    expect(rebound.account.id).not.toBe(boundId);
    expect(broker.bindings.get("ses_ttl")?.accountId).toBe(rebound.account.id);

    rebound.release();
    busy.release();
  });
});

describe("粘性失效：账号移除只影响其名下会话", () => {
  it("被删账号名下的会话重绑，其余会话一个都不动", async () => {
    const a = account("a");
    const b = account("b");
    const c = account("c");
    const { broker, manager } = inMemoryAccounts([a, b, c], { routing: CODING_ONLY });

    const sessions = Array.from({ length: 24 }, (_, index) => `ses_${index}`);
    const before = new Map<string, string>();
    for (const sessionId of sessions) {
      const lease = await broker.acquire({ sessionId });
      before.set(sessionId, lease.account.id);
      lease.release();
    }

    // 删掉"名下会话最多"的那个账号，让用例的迁移面尽量大。
    const counts = new Map<string, number>();
    for (const accountId of before.values()) counts.set(accountId, (counts.get(accountId) ?? 0) + 1);
    const victimId = [...counts.entries()].sort((left, right) => right[1] - left[1])[0][0];
    expect(await manager.remove(victimId)).toBe(true);

    let moved = 0;
    for (const sessionId of sessions) {
      const lease = await broker.acquire({ sessionId });
      const was = before.get(sessionId)!;
      if (was === victimId) {
        expect(lease.account.id).not.toBe(victimId);
        moved += 1;
      } else {
        // 不在被删账号名下的会话必须原地不动（rendezvous 的迁移面）。
        expect(lease.account.id).toBe(was);
      }
      lease.release();
    }
    expect(moved).toBeGreaterThan(0);
  });
});

describe("粘性失效：该 (account, route) 冷却 → 解绑并立刻换号", () => {
  it("冷却不是满载：不等待，本次请求直接换号，并改写绑定", async () => {
    const a = account("a");
    const b = account("b");
    const { broker } = inMemoryAccounts([a, b], {
      // `wait` 是默认饱和行为：若把冷却误当满载，这里就会卡住 30 秒。
      routing: { ...CODING_ONLY, onSaturated: "wait", queueTimeoutMs: 30_000 },
    });

    const first = await broker.acquire({ sessionId: "ses_cool" });
    const cooled = first.account;
    first.release();

    broker.noteUpstreamSignal(cooled, "coding-plan", { kind: "auth" });

    const started = Date.now();
    const next = await broker.acquire({ sessionId: "ses_cool" });
    expect(next.account.id).not.toBe(cooled.id);
    expect(Date.now() - started).toBeLessThan(1_000);
    // auth-failed 的语义是"改写绑定"。
    expect(broker.bindings.get("ses_cool")?.accountId).toBe(next.account.id);

    next.release();
  });
});

describe("粘性失效：账号禁用 → 解绑", () => {
  it("禁用账号会清掉它名下的绑定", async () => {
    const a = account("a");
    const b = account("b");
    // 落盘口给个空实现：这条用例只关心绑定表，没必要在每个单测里开临时存储目录。
    const { broker } = inMemoryAccounts([a, b], {
      routing: CODING_ONLY,
      overrideStore: { set: async () => {}, clear: async () => {} },
    });

    const lease = await broker.acquire({ sessionId: "ses_disable" });
    lease.release();
    expect(broker.bindings.size()).toBe(1);

    await broker.setAccountEnabled(lease.account.label, false);
    expect(broker.bindings.size()).toBe(0);
  });
});

describe("粘性饱和：wait / overflow / wait-then-overflow", () => {
  it("wait（默认）：等绑定账号，释放后仍回到它", async () => {
    const solo = account("solo", 1);
    const { broker } = inMemoryAccounts([solo], {
      routing: { ...CODING_ONLY, queueTimeoutMs: 2_000 },
      stickiness: { onSaturated: "wait" },
    });

    const held = await broker.acquire({ sessionId: "ses_wait" });
    let secondDone = false;
    const pending = broker.acquire({ sessionId: "ses_wait" }).then((lease) => {
      secondDone = true;
      return lease;
    });

    await tick();
    expect(secondDone).toBe(false);

    held.release();
    const second = await pending;
    expect(second.account.label).toBe("solo");
    second.release();
  });

  it("overflow：溢出到同路由空闲账号，且**不改写绑定**，下次仍回原账号", async () => {
    const a = account("a", 1);
    const b = account("b", 1);
    const { broker } = inMemoryAccounts([a, b], {
      routing: CODING_ONLY,
      stickiness: { onSaturated: "overflow" },
    });

    const held = await broker.acquire({ sessionId: "ses_overflow" });
    const boundId = held.account.id;

    // 绑定账号满了 → 溢出到另一个账号。
    const spilled = await broker.acquire({ sessionId: "ses_overflow" });
    expect(spilled.account.id).not.toBe(boundId);
    // 溢出不改写绑定。
    expect(broker.bindings.get("ses_overflow")?.accountId).toBe(boundId);

    // 释放后下一次请求回到原账号。
    spilled.release();
    held.release();
    const back = await broker.acquire({ sessionId: "ses_overflow" });
    expect(back.account.id).toBe(boundId);
    back.release();
  });

  it("wait-then-overflow：先等 overflowAfterMs，等不到才溢出", async () => {
    const a = account("a", 1);
    const b = account("b", 1);
    const overflowAfterMs = 30;
    const { broker } = inMemoryAccounts([a, b], {
      routing: CODING_ONLY,
      stickiness: { onSaturated: "wait-then-overflow", overflowAfterMs },
    });

    const held = await broker.acquire({ sessionId: "ses_wto" });
    const boundId = held.account.id;

    const started = Date.now();
    const spilled = await broker.acquire({ sessionId: "ses_wto" });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(overflowAfterMs - 5);
    expect(spilled.account.id).not.toBe(boundId);
    expect(broker.bindings.get("ses_wto")?.accountId).toBe(boundId);

    spilled.release();
    held.release();
  });
});

describe("陷阱：none 来源不参与粘性", () => {
  it("没有 sessionId 的请求不写绑定表", async () => {
    const a = account("a");
    const b = account("b");
    const { broker } = inMemoryAccounts([a, b], { routing: CODING_ONLY });

    for (let round = 0; round < 3; round++) {
      const lease = await broker.acquire({});
      lease.release();
    }
    expect(broker.bindings.size()).toBe(0);
  });

  it("stickiness.enabled=false 时不写绑定表（配置关掉即整体失效）", async () => {
    const a = account("a");
    const { broker } = inMemoryAccounts([a], {
      routing: CODING_ONLY,
      stickiness: { enabled: false },
    });

    const lease = await broker.acquire({ sessionId: "ses_off" });
    lease.release();
    expect(broker.bindings.size()).toBe(0);
  });
});

describe("策略接线：routing.strategy 真的影响选号", () => {
  /**
   * `strategy` 只在 `drain-first` 的平手处说话：`withinTier: sticky` 会按粘性
   * 哈希排，策略根本不参与。所以这组用例一律显式关掉强制粘性，不挂额度采样器时
   * `drain-first` 退化为 `strategy` 的顺序，正好能单独验策略。
   */
  const STRATEGY_UNDER_TEST = { ...CODING_ONLY, withinTier: "drain-first" as const };

  it("round-robin：连续请求按 a → b → c 轮转", async () => {
    const a = account("a");
    const b = account("b");
    const c = account("c");
    const { broker } = inMemoryAccounts([a, b, c], {
      routing: { ...STRATEGY_UNDER_TEST, strategy: "round-robin" },
    });

    const picks: string[] = [];
    for (let round = 0; round < 4; round++) {
      const lease = await broker.acquire({});
      picks.push(lease.account.label);
      lease.release();
    }
    expect(picks).toEqual(["a", "b", "c", "a"]);
  });

  it("balanced：在飞最少的账号优先", async () => {
    const busy = account("busy", 4);
    const idle = account("idle", 4);
    const { broker } = inMemoryAccounts([busy, idle], {
      routing: { ...STRATEGY_UNDER_TEST, strategy: "balanced" },
    });

    const held = await broker.acquire({ requestedAccount: "busy" });
    const next = await broker.acquire({});
    expect(next.account.label).toBe("idle");

    held.release();
    next.release();
  });
});
