/**
 * 三种选号策略的用例。
 *
 * 断言的是**顺序**而不是"选了个账号"：策略的产物就是候选顺序，占槽与饱和由 broker
 * 负责。所以这里用纯数据（账号 id + 权重 + 在飞数 + 过期时间）把性质钉住：
 *
 * 1. `sticky-hash`：同一 sessionId 稳定命中；删除一个账号只影响其名下会话
 * 2. `balanced`：在飞最少者优先，平手按权重轮转
 * 3. `round-robin`：按权重计数轮转
 * 4. 两层关系：`withinTier` 是档内主序，`strategy` 只在它的平手处说话
 *
 * @see 选号顺序 · 档内排序 · 粘性
 */
import { describe, expect, it } from "bun:test";
import { orderCandidates, StrategyRotation, type CandidateView } from "./scheduler.js";
import { accountFor, zhipuCredential } from "./testing.js";
import { defaultPolicy } from "./types.js";
import type { Account, RouteKind } from "./types.js";

const ROUTE: RouteKind = "coding-plan";

/**
 * 权重分流用例的样本数：要大到"比例"这种统计断言稳定，又要小到用例毫秒级。
 * （rendezvous 哈希是确定性的，所以这个数只需避开"恰好全部落在同一个账号"的偶然。）
 */
const WEIGHT_SAMPLES = 60;

function account(label: string, weight = 1): Account {
  // 账号 id = 凭据指纹：不同 label 必须是不同凭据，否则 id 会撞。
  return accountFor(zhipuCredential({ apiKey: `key-${label}` }), {
    label,
    routes: [ROUTE],
    policy: defaultPolicy({ weight }),
  });
}

/** 权重、在飞数与过期时间的视图（策略只读这三个数）。 */
function view(inflight: Record<string, number> = {}, expiresAt: Record<string, number> = {}): CandidateView {
  return {
    weight: (candidate) => candidate.policy.weight,
    inflight: (accountId) => inflight[accountId] ?? 0,
    expiresAt: (accountId) => expiresAt[accountId],
  };
}

function labels(accounts: readonly Account[]): string[] {
  return accounts.map((candidate) => candidate.label);
}

describe("sticky-hash：哈希稳定性（默认策略）", () => {
  const pool = [account("a"), account("b"), account("c")];

  it("同一 sessionId 永远命中同一账号（与候选集顺序无关）", () => {
    const first = orderCandidates(pool, { withinTier: "sticky", strategy: "sticky-hash", route: ROUTE, sessionId: "ses_x", position: 0 }, view());
    const reversed = orderCandidates([...pool].reverse(), { withinTier: "sticky", strategy: "sticky-hash", route: ROUTE, sessionId: "ses_x", position: 0 }, view());

    expect(reversed[0].label).toBe(first[0].label);
  });

  it("同一 sessionId 的多次计算完全一致（无共享表也稳定）", () => {
    const runs = Array.from({ length: 5 }, () =>
      orderCandidates(pool, { withinTier: "sticky", strategy: "sticky-hash", route: ROUTE, sessionId: "ses_stable", position: 0 }, view())[0].label,
    );
    expect(new Set(runs).size).toBe(1);
  });

  it("不同 sessionId 会散到不同账号（哈希不是常量）", () => {
    const hits = new Set(
      Array.from({ length: 60 }, (_, index) =>
        orderCandidates(pool, { withinTier: "sticky", strategy: "sticky-hash", route: ROUTE, sessionId: `ses_${index}`, position: 0 }, view())[0].label,
      ),
    );
    expect(hits.size).toBeGreaterThan(1);
  });

  it("删除账号只影响其名下会话（rendezvous 的迁移面）", () => {
    const sessions = Array.from({ length: 40 }, (_, index) => `ses_${index}`);
    const before = new Map(
      sessions.map((sessionId) => [
        sessionId,
        orderCandidates(pool, { withinTier: "sticky", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 }, view())[0].label,
      ]),
    );

    const victim = "b";
    const after = new Map(
      sessions.map((sessionId) => [
        sessionId,
        orderCandidates(pool.filter((candidate) => candidate.label !== victim), { withinTier: "sticky", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 }, view())[0].label,
      ]),
    );

    let moved = 0;
    for (const sessionId of sessions) {
      const was = before.get(sessionId);
      const now = after.get(sessionId);
      if (was === now) {
        // 原本不在被删账号名下的会话，一个都不许动。
        expect(was).not.toBe(victim);
        continue;
      }
      // 只有原本落在被删账号上的会话才会改判。
      expect(was).toBe(victim);
      expect(now).not.toBe(victim);
      moved += 1;
    }
    // 确实有会话原本落在 b 上，否则这条用例什么都没证明。
    expect(moved).toBeGreaterThan(0);
  });

  it("权重影响分流比例：权重 3 的账号分到更多会话", () => {
    const weighted = [account("light", 1), account("heavy", 3)];
    let heavy = 0;
    const samples = WEIGHT_SAMPLES;
    for (let index = 0; index < samples; index++) {
      const picked = orderCandidates(weighted, { withinTier: "sticky", strategy: "sticky-hash", route: ROUTE, sessionId: `ses_${index}`, position: 0 }, view())[0];
      if (picked.label === "heavy") heavy += 1;
    }
    // 理论比例 3:1 → 3/4 的样本落在 heavy 上；给足容差，只验证方向性。
    expect(heavy).toBeGreaterThan(samples / 2);
  });

  it("没有 sessionId 时退化为 balanced（会话来源为 none，按策略选号）", () => {
    const busy = account("busy");
    const idle = account("idle");
    const inflight = { [busy.id]: 2 };
    const ordered = orderCandidates([busy, idle], { withinTier: "sticky", strategy: "sticky-hash", route: ROUTE, position: 0 }, view(inflight));

    expect(ordered[0].label).toBe("idle");
  });
});

describe("balanced：在飞最少者，平手按权重轮转", () => {
  it("在飞数最少者排在最前", () => {
    const a = account("a");
    const b = account("b");
    const c = account("c");
    const ordered = orderCandidates([a, b, c], { withinTier: "sticky", strategy: "balanced", route: ROUTE, position: 0 }, view({ [a.id]: 3, [b.id]: 1 }));

    expect(labels(ordered)).toEqual(["c", "b", "a"]);
  });

  it("全部空闲时按权重：权重高的先被选中", () => {
    const light = account("light", 1);
    const heavy = account("heavy", 5);
    const ordered = orderCandidates([light, heavy], { withinTier: "sticky", strategy: "balanced", route: ROUTE, position: 0 }, view());

    expect(ordered[0].label).toBe("heavy");
  });

  it("平手轮转：位置推进后轮到另一个账号（不会永远压在第一个上）", () => {
    const a = account("a");
    const b = account("b");
    const pool = [a, b];

    const first = orderCandidates(pool, { withinTier: "sticky", strategy: "balanced", route: ROUTE, position: 0 }, view())[0].label;
    const second = orderCandidates(pool, { withinTier: "sticky", strategy: "balanced", route: ROUTE, position: 1 }, view())[0].label;

    expect(first).not.toBe(second);
  });

  it("在飞不同时不受轮转位置影响（负载优先于轮转）", () => {
    const a = account("a");
    const b = account("b");
    const inflight = { [a.id]: 1 };

    for (const position of [0, 1, 2]) {
      const ordered = orderCandidates([a, b], { withinTier: "sticky", strategy: "balanced", route: ROUTE, position }, view(inflight));
      expect(ordered[0].label).toBe("b");
    }
  });
});

describe("round-robin：按权重计数轮转", () => {
  it("等权重时严格轮转 a → b → c → a", () => {
    const pool = [account("a"), account("b"), account("c")];
    const picks = [0, 1, 2, 3].map(
      (position) => orderCandidates(pool, { withinTier: "sticky", strategy: "round-robin", route: ROUTE, position }, view())[0].label,
    );

    expect(picks).toEqual(["a", "b", "c", "a"]);
  });

  it("权重 2:1 的轮转顺序是 a, a, b, a, a, b", () => {
    const heavy = account("a", 2);
    const light = account("b", 1);
    const pool = [heavy, light];
    const picks = [0, 1, 2, 3, 4, 5].map(
      (position) => orderCandidates(pool, { withinTier: "sticky", strategy: "round-robin", route: ROUTE, position }, view())[0].label,
    );

    expect(picks).toEqual(["a", "a", "b", "a", "a", "b"]);
  });

  it("排序结果覆盖全部候选（溢出时按环顺序接着试）", () => {
    const pool = [account("a", 2), account("b", 1)];
    const ordered = orderCandidates(pool, { withinTier: "sticky", strategy: "round-robin", route: ROUTE, position: 1 }, view());

    expect(new Set(labels(ordered))).toEqual(new Set(["a", "b"]));
    expect(ordered.length).toBe(2);
  });
});

describe("withinTier：同档内按权益紧迫度排序", () => {
  const EARLY = 1_720_000_100_000;
  const LATE = 1_720_003_600_000;

  it("sticky 与 drain-first 在没有任何过期时间时给出同一顺序（默认行为不变）", () => {
    const pool = [account("a"), account("b"), account("c")];
    for (const sessionId of ["ses_1", "ses_2", "ses_3"]) {
      const sticky = orderCandidates(
        pool,
        { withinTier: "sticky", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
        view(),
      );
      const drain = orderCandidates(
        pool,
        { withinTier: "drain-first", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
        view(),
      );
      expect(labels(drain)).toEqual(labels(sticky));
    }
  });

  it("drain-first：最早过期的排第一，与粘性哈希落在谁身上无关", () => {
    const a = account("a");
    const b = account("b");
    const c = account("c");
    const expires = { [a.id]: LATE, [b.id]: EARLY, [c.id]: LATE + 1 };

    for (const sessionId of ["ses_1", "ses_2", "ses_3", "ses_4"]) {
      const ordered = orderCandidates(
        [a, b, c],
        { withinTier: "drain-first", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
        view({}, expires),
      );
      expect(ordered[0].label).toBe("b");
      // 其余两个仍按过期时间升序，不是按候选集顺序。
      expect(labels(ordered)).toEqual(["b", "a", "c"]);
    }
  });

  it("drain-first：没有采样结果的账号排在已知之后，即使哈希选中它", () => {
    const known = account("known");
    const unknown = account("unknown");
    const expires = { [known.id]: LATE };

    for (const sessionId of ["ses_1", "ses_2", "ses_3", "ses_4", "ses_5", "ses_6"]) {
      const ordered = orderCandidates(
        [unknown, known],
        { withinTier: "drain-first", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
        view({}, expires),
      );
      expect(ordered[0].label).toBe("known");
    }
  });

  it("drain-first：过期时间相同则按粘性哈希排（确定性，不是候选集顺序）", () => {
    const pool = [account("a"), account("b"), account("c")];
    const expires = { [pool[0]!.id]: LATE, [pool[1]!.id]: LATE, [pool[2]!.id]: LATE };

    for (const sessionId of ["ses_1", "ses_2", "ses_3"]) {
      const sticky = orderCandidates(
        pool,
        { withinTier: "sticky", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
        view({}, expires),
      );
      const drain = orderCandidates(
        pool,
        { withinTier: "drain-first", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
        view({}, expires),
      );
      expect(labels(drain)).toEqual(labels(sticky));
      // 反过来传候选集也给出同一顺序：平手判据是哈希，不是数组下标。
      const reversed = orderCandidates(
        [...pool].reverse(),
        { withinTier: "drain-first", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
        view({}, expires),
      );
      expect(labels(reversed)).toEqual(labels(drain));
    }
  });

  it("drain-first 且没有 sessionId 时仍按过期时间排（退化到均衡当平手判据）", () => {
    const a = account("a");
    const b = account("b");
    const expires = { [a.id]: LATE, [b.id]: EARLY };

    const ordered = orderCandidates(
      [a, b],
      { withinTier: "drain-first", strategy: "sticky-hash", route: ROUTE, position: 0 },
      view({}, expires),
    );
    expect(labels(ordered)).toEqual(["b", "a"]);
  });
});

describe("withinTier 与 strategy：两层各管一层", () => {
  const EARLY = 1_720_000_100_000;
  const LATE = 1_720_003_600_000;

  /** 六个会话：够让哈希散到不止一个账号，又小到用例毫秒级。*/
  const SESSIONS = ["ses_1", "ses_2", "ses_3", "ses_4", "ses_5", "ses_6"];

  /** 四个账号，用作回归基线的候选池（下标与 {@link BEFORE_HASH_ORDER} 无关）。*/
  function quad(): Account[] {
    return ["a", "b", "c", "d"].map((label) => account(label));
  }

  it("drain-first + round-robin：过期时间升序，同时过期的按轮转序", () => {
    // c 权重 2：环是 c, c, a, b，与候选集顺序 a, b, c 不同。
    const a = account("a");
    const b = account("b");
    const c = account("c", 2);
    const expires = { [a.id]: LATE, [b.id]: LATE, [c.id]: EARLY };

    for (const sessionId of SESSIONS) {
      for (const position of [0, 3]) {
        const ordered = orderCandidates(
          [a, b, c],
          { withinTier: "drain-first", strategy: "round-robin", route: ROUTE, sessionId, position },
          view({}, expires),
        );
        // 过期时间永远是第一键：c 最早过期，轮转位置改不了这一点。
        expect(ordered[0].label).toBe("c");
      }
    }

    // a 与 b 同时过期，先后由环决定：位置 0 从环首 c 之后排 a，位置 3 从 b 起环。
    const atZero = orderCandidates([a, b, c], { withinTier: "drain-first", strategy: "round-robin", route: ROUTE, sessionId: "ses_1", position: 0 }, view({}, expires));
    const atThree = orderCandidates([a, b, c], { withinTier: "drain-first", strategy: "round-robin", route: ROUTE, sessionId: "ses_1", position: 3 }, view({}, expires));
    expect(labels(atZero)).toEqual(["c", "a", "b"]);
    expect(labels(atThree)).toEqual(["c", "b", "a"]);
  });

  it("drain-first + balanced：过期时间升序，同时过期的看在飞数", () => {
    const a = account("a");
    const b = account("b");
    const c = account("c");
    const expires = { [a.id]: EARLY, [b.id]: LATE, [c.id]: LATE };

    // b 与 c 同时过期，c 在飞 2，于是 b 在前；a 在飞 0 但过期最晚，仍排第一行
    // （过期时间是主键，在飞数只在平手处说话）。
    const ordered = orderCandidates(
      [c, b, a],
      { withinTier: "drain-first", strategy: "balanced", route: ROUTE, sessionId: "ses_1", position: 0 },
      view({ [a.id]: 5, [c.id]: 2 }, expires),
    );
    expect(labels(ordered)).toEqual(["a", "b", "c"]);
  });

  it("sticky + round-robin：按哈希排，strategy 被覆盖", () => {
    const pool = [account("a"), account("b"), account("c")];

    for (const sessionId of SESSIONS) {
      const hashOrder = orderCandidates(
        pool,
        { withinTier: "sticky", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
        view(),
      );
      for (const position of [0, 1, 2, 5]) {
        const ordered = orderCandidates(
          pool,
          { withinTier: "sticky", strategy: "round-robin", route: ROUTE, sessionId, position },
          view(),
        );
        // 轮转位置怎么变都不影响顺序：round-robin 在 sticky 下不参与。
        expect(labels(ordered)).toEqual(labels(hashOrder));
      }
    }

    // 哈希确实在起作用：不同会话落到不同账号。
    const firsts = SESSIONS.map(
      (sessionId) => orderCandidates(pool, { withinTier: "sticky", strategy: "round-robin", route: ROUTE, sessionId, position: 0 }, view())[0].label,
    );
    expect(new Set(firsts).size).toBeGreaterThan(1);
  });

  it("sticky + balanced：在飞数与过期时间都不参与，顺序等于哈希序", () => {
    const pool = [account("a"), account("b"), account("c")];

    for (const sessionId of SESSIONS) {
      const hashOrder = orderCandidates(
        pool,
        { withinTier: "sticky", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
        view(),
      );
      // 把哈希选中的账号压到最忙、把掉在最后的那个标成最早过期：balanced 若生效会改判。
      const top = hashOrder[0];
      const last = hashOrder[hashOrder.length - 1];
      const ordered = orderCandidates(
        pool,
        { withinTier: "sticky", strategy: "balanced", route: ROUTE, sessionId, position: 0 },
        view({ [top.id]: 9 }, { [last.id]: EARLY, [top.id]: LATE }),
      );
      expect(labels(ordered)).toEqual(labels(hashOrder));
    }
  });

  it("drain-first + 无 sessionId：过期时间升序，平手按 strategy", () => {
    const a = account("a");
    const b = account("b");
    const c = account("c");
    const expires = { [a.id]: EARLY, [b.id]: LATE, [c.id]: LATE };

    // 平手按 balanced：a 在飞 5 也仍排第一（过期时间优先），b 空闲所以压在 c 前面。
    const balanced = orderCandidates(
      [c, b, a],
      { withinTier: "drain-first", strategy: "balanced", route: ROUTE, position: 0 },
      view({ [a.id]: 5, [c.id]: 2 }, expires),
    );
    expect(labels(balanced)).toEqual(["a", "b", "c"]);

    // 平手按 round-robin：位置 2 从 c 起环，于是 c 压在 b 前面。
    const ringAtZero = orderCandidates(
      [a, b, c],
      { withinTier: "drain-first", strategy: "round-robin", route: ROUTE, position: 0 },
      view({}, expires),
    );
    const ringAtTwo = orderCandidates(
      [a, b, c],
      { withinTier: "drain-first", strategy: "round-robin", route: ROUTE, position: 2 },
      view({}, expires),
    );
    expect(labels(ringAtZero)).toEqual(["a", "b", "c"]);
    expect(labels(ringAtTwo)).toEqual(["a", "c", "b"]);
  });

  describe("withinTier: strategy：档内主序交给 strategy", () => {
    it("strategy + balanced：在飞数最少者在前，带 sessionId 也不退回哈希", () => {
      const a = account("a");
      const b = account("b");
      const c = account("c");
      const load = { [a.id]: 3, [b.id]: 1 };

      // 这就是 `balanced` 唯一能被启用的入口：`sticky` 下它会被哈希覆盖，
      // `drain-first` 下主键变成过期时间。
      for (const sessionId of [undefined, "ses_1", "ses_42"]) {
        const ordered = orderCandidates(
          [a, b, c],
          { withinTier: "strategy", strategy: "balanced", route: ROUTE, sessionId, position: 0 },
          view(load),
        );
        expect(labels(ordered)).toEqual(["c", "b", "a"]);
      }
    });

    it("strategy + round-robin：按 position 轮转", () => {
      const pool = [account("a"), account("b"), account("c")];
      const byPosition = [
        ["a", "b", "c"],
        ["b", "c", "a"],
        ["c", "a", "b"],
      ];

      for (const [position, expected] of byPosition.entries()) {
        const ordered = orderCandidates(
          pool,
          // 带了 sessionId 也照轮转走：`strategy` 模式下有粘性键不改变主序。
          { withinTier: "strategy", strategy: "round-robin", route: ROUTE, sessionId: "ses_1", position },
          view(),
        );
        expect(labels(ordered)).toEqual(expected!);
      }
    });

    it("strategy + sticky-hash + 有 sessionId：按哈希，与 sticky 一致", () => {
      const pool = [account("a"), account("b"), account("c")];

      for (const sessionId of SESSIONS) {
        const viaStrategy = orderCandidates(
          pool,
          { withinTier: "strategy", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
          view(),
        );
        const viaSticky = orderCandidates(
          pool,
          { withinTier: "sticky", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
          view(),
        );
        expect(labels(viaStrategy)).toEqual(labels(viaSticky));
      }
    });

    it("strategy + sticky-hash + 无 sessionId：退化为均衡", () => {
      const a = account("a");
      const b = account("b");
      const c = account("c");
      const load = { [a.id]: 2 };

      // 没有哈希输入，`sticky-hash` 退化为在飞数最少者，所以在
      // `strategy` 模式下它与 `strategy: balanced` 给出同一个顺序。
      const viaHash = orderCandidates(
        [a, b, c],
        { withinTier: "strategy", strategy: "sticky-hash", route: ROUTE, position: 0 },
        view(load),
      );
      const viaBalanced = orderCandidates(
        [a, b, c],
        { withinTier: "strategy", strategy: "balanced", route: ROUTE, position: 0 },
        view(load),
      );
      expect(labels(viaHash)).toEqual(["b", "c", "a"]);
      expect(labels(viaHash)).toEqual(labels(viaBalanced));
    });
  });

  /**
   * 改动前的输出（HEAD 的 `orderCandidates` 在同一组输入上的结果），下标与
   * {@link SESSIONS} 对齐，池是 `[a, b, c, d]`。
   *
   * 两条回归用例拿它当基线：默认组合与 `sticky-hash + drain-first` 的每一格顺序
   * 都必须与改动前一致，否则是静默的行为回归。
   */
  const BEFORE_HASH_ORDER: string[][] = [
    ["a", "d", "b", "c"],
    ["a", "b", "c", "d"],
    ["c", "a", "d", "b"],
    ["a", "d", "b", "c"],
    ["c", "b", "a", "d"],
    ["c", "d", "a", "b"],
  ];
  const BEFORE_DRAIN_FIRST_ORDER: string[][] = [
    ["c", "a", "d", "b"],
    ["c", "a", "b", "d"],
    ["c", "a", "d", "b"],
    ["c", "a", "d", "b"],
    ["c", "a", "b", "d"],
    ["c", "a", "d", "b"],
  ];

  it("回归：sticky-hash + sticky 与改动前逐字节一致", () => {
    const forward = quad();
    const backwards = [...forward].reverse();
    // 过期时间全部相同与全部未知都不该改判：sticky 根本不看过期时间。
    const allSame = Object.fromEntries(forward.map((candidate) => [candidate.id, LATE]));

    for (const pool of [forward, backwards]) {
      for (const expires of [{}, allSame]) {
        for (const [index, sessionId] of SESSIONS.entries()) {
          const ordered = orderCandidates(
            pool,
            { withinTier: "sticky", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
            view({}, expires),
          );
          expect(labels(ordered)).toEqual(BEFORE_HASH_ORDER[index]!);
        }
      }
    }
  });

  it("回归：sticky-hash + drain-first 与改动前一致", () => {
    const forward = quad();
    const backwards = [...forward].reverse();
    const [a, , c] = forward;
    const oneEarly = { [a!.id]: LATE, [c!.id]: EARLY };

    for (const pool of [forward, backwards]) {
      for (const [index, sessionId] of SESSIONS.entries()) {
        const ordered = orderCandidates(
          pool,
          { withinTier: "drain-first", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
          view({}, oneEarly),
        );
        expect(labels(ordered)).toEqual(BEFORE_DRAIN_FIRST_ORDER[index]!);

        // 没有任何采样结果时退化为粘性序，也与改动前一致。
        const unknown = orderCandidates(
          pool,
          { withinTier: "drain-first", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
          view(),
        );
        expect(labels(unknown)).toEqual(BEFORE_HASH_ORDER[index]!);
      }
    }
  });

  /**
   * 下面两条回归用的输入：池 `[a, b, c, d]`，在飞数 a=3 / c=1，过期时间
   * a=LATE / c=EARLY（b 与 d 没有采样结果，排在已知值之后）。
   *
   * 基线是改动前（`withinTier` 只有两个取值时）的 `orderCandidates` 在同一组输入
   * 上的输出。新增的 `strategy` 取值不得改动已有组合的任何一格。
   */
  const GRID_INFLIGHT = (forward: readonly Account[]) => ({ [forward[0]!.id]: 3, [forward[2]!.id]: 1 });
  const GRID_EXPIRES = (forward: readonly Account[]) => ({ [forward[0]!.id]: LATE, [forward[2]!.id]: EARLY });

  /** `sticky` 不读在飞数与过期时间，两种候选集顺序给出同一结果。*/
  const BEFORE_STICKY: string[][] = [
    ["a", "d", "b", "c"],
    ["a", "b", "c", "d"],
    ["c", "a", "d", "b"],
    ["a", "d", "b", "c"],
    ["c", "b", "a", "d"],
    ["c", "d", "a", "b"],
  ];
  const BEFORE_DRAIN_HASH: string[][] = [
    ["c", "a", "d", "b"],
    ["c", "a", "b", "d"],
    ["c", "a", "d", "b"],
    ["c", "a", "d", "b"],
    ["c", "a", "b", "d"],
    ["c", "a", "d", "b"],
  ];
  /** `balanced` 与 `round-robin` 在这里不读 sessionId，六个会话给出同一顺序。*/
  const BEFORE_DRAIN_TIE = {
    forward: ["c", "a", "b", "d"],
    backwards: ["c", "a", "d", "b"],
  };

  it("回归：sticky 三格不变（strategy 三选一都被覆盖）", () => {
    const forward = quad();
    const tables = view(GRID_INFLIGHT(forward), GRID_EXPIRES(forward));

    for (const pool of [forward, [...forward].reverse()]) {
      for (const strategy of ["sticky-hash", "balanced", "round-robin"] as const) {
        for (const [index, sessionId] of SESSIONS.entries()) {
          const ordered = orderCandidates(
            pool,
            { withinTier: "sticky", strategy, route: ROUTE, sessionId, position: 0 },
            tables,
          );
          expect(labels(ordered)).toEqual(BEFORE_STICKY[index]!);
        }
      }
    }
  });

  it("回归：drain-first 三格不变", () => {
    const forward = quad();
    const tables = view(GRID_INFLIGHT(forward), GRID_EXPIRES(forward));
    const pools = [
      ["forward", forward],
      ["backwards", [...forward].reverse()],
    ] as const;

    for (const [tag, pool] of pools) {
      for (const [index, sessionId] of SESSIONS.entries()) {
        const base = { withinTier: "drain-first", route: ROUTE, sessionId, position: 0 } as const;

        expect(labels(orderCandidates(pool, { ...base, strategy: "sticky-hash" }, tables))).toEqual(BEFORE_DRAIN_HASH[index]!);
        expect(labels(orderCandidates(pool, { ...base, strategy: "balanced" }, tables))).toEqual(BEFORE_DRAIN_TIE[tag]);
        expect(labels(orderCandidates(pool, { ...base, strategy: "round-robin" }, tables))).toEqual(BEFORE_DRAIN_TIE[tag]);
      }
    }
  });
});

describe("未知 expiresAt 的排位与采样闭环", () => {
  const EARLY = 1_720_000_100_000;
  const MID = 1_720_001_850_000;
  const LATE = 1_720_003_600_000;

  it("全部已知：expiresAt 升序不变（回归）", () => {
    const a = account("a");
    const b = account("b");
    const c = account("c");
    const expires = { [a.id]: LATE, [b.id]: EARLY, [c.id]: MID };

    for (const pool of [[a, b, c], [c, b, a]]) {
      const ordered = orderCandidates(
        pool,
        { withinTier: "drain-first", strategy: "sticky-hash", route: ROUTE, sessionId: "ses_w29", position: 0 },
        view({}, expires),
      );
      expect(labels(ordered)).toEqual(["b", "c", "a"]);
    }
  });

  it("全部未知：彼此按 baseline 序（粘性哈希），不按候选集顺序", () => {
    const pool = [account("a"), account("b"), account("c")];

    for (const sessionId of ["ses_1", "ses_2", "ses_3"]) {
      const sticky = orderCandidates(
        pool,
        { withinTier: "sticky", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
        view(),
      );
      const drain = orderCandidates(
        pool,
        { withinTier: "drain-first", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
        view(),
      );
      // 未知之间没有主键可用，顺序整个交给 baseline：与 sticky 给出的哈希序一致。
      expect(labels(drain)).toEqual(labels(sticky));

      const reversed = orderCandidates(
        [...pool].reverse(),
        { withinTier: "drain-first", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
        view(),
      );
      expect(labels(reversed)).toEqual(labels(sticky));
    }
  });

  it("混合：已知排第一，两个未知的先后等于 baseline 序（关键）", () => {
    const known = account("known");
    const one = account("one");
    const two = account("two");
    // 候选集故意打乱：未知的先后只能来自 baseline，不能来自数组下标。
    const pool = [two, known, one];
    // 已知的过期时间给最晚一档：排第一靠的是「已知」，不是「最早过期」。
    const expires = { [known.id]: LATE };

    for (const sessionId of ["ses_1", "ses_2", "ses_3", "ses_4"]) {
      const ordered = orderCandidates(
        pool,
        { withinTier: "drain-first", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
        view({}, expires),
      );
      const baseline = orderCandidates(
        [known, one, two],
        { withinTier: "sticky", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
        view(),
      );
      expect(ordered[0]!.label).toBe("known");
      expect(labels(ordered).slice(1)).toEqual(labels(baseline).filter((label) => label !== "known"));
    }
  });

  it("已知相同过期：平手按 baseline（哈希），与候选集顺序无关", () => {
    const pool = [account("a"), account("b"), account("c")];
    const expires = Object.fromEntries(pool.map((candidate) => [candidate.id, LATE]));

    for (const sessionId of ["ses_1", "ses_2", "ses_3"]) {
      const sticky = orderCandidates(
        pool,
        { withinTier: "sticky", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
        view({}, expires),
      );
      const drain = orderCandidates(
        [...pool].reverse(),
        { withinTier: "drain-first", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
        view({}, expires),
      );
      expect(labels(drain)).toEqual(labels(sticky));
    }
  });

  it("闭环模拟：只有 baseline 第一的账号被采样，第二个账号下一轮排到它前面（关键）", () => {
    const pool = [account("a"), account("b"), account("c")];
    const sessionId = "ses_starve";

    // baseline 序（全未知时的哈希序）。空闲跳过只采「最近活跃」的账号，而 drain-first
    // 把第一波流量全部给 baseline 第一名，于是采样器只覆盖到它。
    const baseline = labels(
      orderCandidates(pool, { withinTier: "sticky", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 }, view()),
    );
    const byLabel = new Map<string, Account>(pool.map((candidate) => [candidate.label, candidate]));
    const first = byLabel.get(baseline[0]!)!;
    const second = byLabel.get(baseline[1]!)!;

    // 第 1 轮：只有 baseline 第一名有采样结果。它排第一吃下流量；其余账号排在它
    // 后面，按 baseline 序等着，而不是钉死成固定顺序。
    const roundOne = orderCandidates(
      pool,
      { withinTier: "drain-first", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
      view({}, { [first.id]: LATE }),
    );
    expect(labels(roundOne)).toEqual(baseline);

    // 第 2 轮：第一名被烧干退出候选（quota gate 摘掉耗尽的账号），第二名顶上，
    // 这就是「喂到」。它随后也被采样；它的窗口结束得更早，因为一直没被烧过。
    const survivors = pool.filter((candidate) => candidate.id !== first.id);
    const roundTwo = orderCandidates(
      survivors,
      { withinTier: "drain-first", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
      view(),
    );
    expect(roundTwo[0]!.label).toBe(second.label);

    // 第 3 轮：第二名的采样结果回来了；第一名的窗口重置后回到候选集。第二个账号
    // 排到了它前面：喂到 → 采样 → 参与升序，闭环从「一个账号吃所有流量」变成
    // 未知组轮流被喂。
    const roundThree = orderCandidates(
      pool,
      { withinTier: "drain-first", strategy: "sticky-hash", route: ROUTE, sessionId, position: 0 },
      view({}, { [first.id]: LATE, [second.id]: EARLY }),
    );
    expect(labels(roundThree)).toEqual([second.label, first.label, ...baseline.slice(2)]);
  });
});

describe("StrategyRotation：游标只在真的选出账号后推进", () => {
  it("peek 不推进，advance 才推进", () => {
    const rotation = new StrategyRotation();
    expect(rotation.peek(ROUTE)).toBe(0);
    expect(rotation.peek(ROUTE)).toBe(0);

    rotation.advance(ROUTE);
    expect(rotation.peek(ROUTE)).toBe(1);
  });

  it("按路由各自计数（coding-plan 的轮转不影响 start-plan）", () => {
    const rotation = new StrategyRotation();
    rotation.advance("coding-plan");

    expect(rotation.peek("coding-plan")).toBe(1);
    expect(rotation.peek("start-plan")).toBe(0);
  });
});
