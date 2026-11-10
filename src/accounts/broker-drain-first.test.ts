/**
 * `withinTier` 经 broker 接线后的选号用例。
 *
 * `scheduler.test.ts` 钉的是排序函数本身，这里钉的是接线：过期时间由谁提供、
 * 没提供时退化成什么、以及跨档行为有没有被这一层改掉。
 *
 * 三组断言：
 *
 * 1. `sticky`（默认）：行为与改动前逐字一致，同一会话不跨账号；
 * 2. `drain-first`：同档内最早过期的先上，没有采样结果的排在已知之后；
 * 3. 跨档：`order[0]` 有候选就不看 `order[1]`，同档内的紧迫度不能把请求推下档。
 *
 * @see 档内排序 · 选号顺序
 */
import { describe, expect, it } from "bun:test";
import type { QuotaExpirySource } from "./broker.js";
import { accountFor, inMemoryAccounts, zhipuCredential } from "./testing.js";
import { defaultPolicy } from "./types.js";
import type { Account, RouteKind } from "./types.js";

const EARLY = 1_720_000_100_000;
const LATE = 1_720_003_600_000;

/** 一组会话 id：多到"哈希恰好全落在同一个账号"不成立。 */
const SESSIONS = Array.from({ length: 12 }, (_, index) => `ses_${index}`);

function account(label: string, routes: RouteKind[] = ["coding-plan"]): Account {
  return accountFor(zhipuCredential({ apiKey: `key-${label}` }), {
    label,
    routes,
    policy: defaultPolicy(),
  });
}

/** 只读过期时间的假采样器：表里没有的账号就是"没有采样结果"。 */
function quotaSource(expiry: Record<string, number>): QuotaExpirySource {
  return { expiresAt: (accountId) => expiry[accountId] };
}

/** 走一遍会话，收集每个会话选中的账号 label。*/
async function picksFor(
  broker: ReturnType<typeof inMemoryAccounts>["broker"],
  sessions: readonly string[],
): Promise<string[]> {
  const picked: string[] = [];
  for (const sessionId of sessions) {
    const lease = await broker.acquire({ sessionId });
    picked.push(lease.account.label);
    lease.release();
  }
  return picked;
}

describe("withinTier: sticky（默认）", () => {
  it("不挂采样器时与挂上采样器后选号一致（过期时间不参与排序）", async () => {
    const a = account("a");
    const b = account("b");
    const c = account("c");
    const pool = [a, b, c];

    const plain = inMemoryAccounts(pool, { routing: { withinTier: "sticky" } });
    const withQuota = inMemoryAccounts(pool, { routing: { withinTier: "sticky" } });
    // 故意给 a 一个最早的过期时间：sticky 不该因此改判。
    withQuota.broker.attachQuotaExpiry(quotaSource({ [a.id]: EARLY, [b.id]: LATE }));

    expect(await picksFor(withQuota.broker, SESSIONS)).toEqual(await picksFor(plain.broker, SESSIONS));
  });

  it("同一会话永远同一账号，且散到不止一个账号上（哈希仍然在起作用）", async () => {
    const a = account("a");
    const b = account("b");
    const { broker } = inMemoryAccounts([a, b], { routing: { withinTier: "sticky" } });
    broker.attachQuotaExpiry(quotaSource({ [a.id]: LATE, [b.id]: EARLY }));

    const first = await picksFor(broker, SESSIONS);
    const second = await picksFor(broker, SESSIONS);

    expect(second).toEqual(first);
    expect(new Set(first).size).toBeGreaterThan(1);
  });
});

describe("withinTier: drain-first", () => {
  it("最早过期的账号排在第一位，与哈希落在谁身上无关", async () => {
    const a = account("a");
    const b = account("b");
    const { broker } = inMemoryAccounts([a, b], {
      routing: { withinTier: "drain-first" },
    });
    broker.attachQuotaExpiry(quotaSource({ [a.id]: LATE, [b.id]: EARLY }));

    expect(new Set(await picksFor(broker, SESSIONS))).toEqual(new Set(["b"]));
  });

  it("没有采样结果的账号排在已知之后（不知道不等于快过期）", async () => {
    const known = account("known");
    const unknown = account("unknown");
    const { broker } = inMemoryAccounts([unknown, known], {
      routing: { withinTier: "drain-first" },
    });
    // 只给 known 一条过期时间：unknown 就是"还没采过"。
    broker.attachQuotaExpiry(quotaSource({ [known.id]: LATE }));

    expect(new Set(await picksFor(broker, SESSIONS))).toEqual(new Set(["known"]));
  });

  it("没有挂采样器时退化为粘性顺序（drain-first 缺数据不改变既有行为）", async () => {
    const a = account("a");
    const b = account("b");
    const pool = [a, b];

    const sticky = inMemoryAccounts(pool, { routing: { withinTier: "sticky" } });
    const drain = inMemoryAccounts(pool, { routing: { withinTier: "drain-first" } });

    expect(await picksFor(drain.broker, SESSIONS)).toEqual(await picksFor(sticky.broker, SESSIONS));
  });

  it("跨档行为不变：order[0] 有候选就不看 order[1] 的紧迫度", async () => {
    const startOnly = account("start", ["start-plan"]);
    const codingOnly = account("coding", ["coding-plan"]);
    const { broker } = inMemoryAccounts([startOnly, codingOnly], {
      routing: { order: ["start-plan", "coding-plan"], withinTier: "drain-first" },
    });
    // coding 那条路由的权益比 start 更早过期，但档位优先于同档内的紧迫度。
    broker.attachQuotaExpiry(quotaSource({ [startOnly.id]: LATE, [codingOnly.id]: EARLY }));

    for (const sessionId of SESSIONS) {
      const lease = await broker.acquire({ sessionId });
      expect(lease.account.label).toBe("start");
      expect(lease.route).toBe("start-plan");
      lease.release();
    }
  });

  it("order[0] 没有候选时才降级，降级后仍按过期时间选号", async () => {
    const a = account("a", ["coding-plan"]);
    const b = account("b", ["coding-plan"]);
    const { broker } = inMemoryAccounts([a, b], {
      routing: { order: ["start-plan", "coding-plan"], withinTier: "drain-first" },
    });
    broker.attachQuotaExpiry(quotaSource({ [a.id]: LATE, [b.id]: EARLY }));

    const lease = await broker.acquire({ sessionId: "ses_fallback" });
    expect(lease.route).toBe("coding-plan");
    expect(lease.account.label).toBe("b");
    lease.release();
  });
});
