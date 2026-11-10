/**
 * 粘性表本身的用例：TTL、容量 LRU、解绑、按账号清理。
 *
 * 这里只测表的行为，不碰调度。"绑定还有没有效"里需要账号仓与健康表的那些条
 * 在 `broker-stickiness.test.ts` 里测，因为那是 broker 的判定，不是表的。
 *
 * @see 粘性 · 三个实现陷阱
 */
import { describe, expect, it } from "bun:test";
import { StickinessTable } from "./stickiness.js";

/** 可拨动的时钟：TTL 用例直接跨过窗口，不真的等 30 分钟。 */
function clock(start = 1_000_000): { now: () => number; advance(ms: number): void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe("StickinessTable — 基本读写（键值形状）", () => {
  it("bind 之后 get 拿到 { accountId, routeKind }", () => {
    const table = new StickinessTable();
    table.bind("ses_a", "acct_1", "coding-plan");

    expect(table.get("ses_a")).toEqual({ accountId: "acct_1", routeKind: "coding-plan" });
    expect(table.get("ses_missing")).toBeUndefined();
    expect(table.size()).toBe(1);
  });

  it("重复 bind 覆盖旧值，不新增条目", () => {
    const table = new StickinessTable();
    table.bind("ses_a", "acct_1", "coding-plan");
    table.bind("ses_a", "acct_2", "start-plan");

    expect(table.get("ses_a")).toEqual({ accountId: "acct_2", routeKind: "start-plan" });
    expect(table.size()).toBe(1);
  });

  it("get 返回副本：改它不会污染表内状态", () => {
    const table = new StickinessTable();
    table.bind("ses_a", "acct_1", "coding-plan");
    const binding = table.get("ses_a");
    binding!.accountId = "mutated";

    expect(table.get("ses_a")?.accountId).toBe("acct_1");
  });

  it("unbind 删掉绑定并返回是否命中", () => {
    const table = new StickinessTable();
    table.bind("ses_a", "acct_1", "coding-plan");

    expect(table.unbind("ses_a")).toBe(true);
    expect(table.unbind("ses_a")).toBe(false);
    expect(table.get("ses_a")).toBeUndefined();
  });
});

describe("StickinessTable — TTL（失效条件之一）", () => {
  it("TTL 未到命中，过期后失效并当场删除", () => {
    const time = clock();
    const table = new StickinessTable({ ttlSeconds: 10, now: time.now });
    table.bind("ses_a", "acct_1", "coding-plan");

    // 9 秒后还新鲜。注意 `get` 会续期（滑动 TTL），所以下面先不动它。
    time.advance(9_000);
    expect(table.size()).toBe(1);

    // 再走 2 秒（距绑定时 11 秒）→ 过期，且当场从表里删掉。
    time.advance(2_000);
    expect(table.get("ses_a")).toBeUndefined();
    expect(table.size()).toBe(0);
  });

  it("TTL 是滑动的：持续命中会一直续期", () => {
    const time = clock();
    const table = new StickinessTable({ ttlSeconds: 10, now: time.now });
    table.bind("ses_a", "acct_1", "coding-plan");

    // 每 9 秒命中一次，累计远超 10 秒仍有效（长对话不能中途失联）。
    for (let round = 0; round < 5; round++) {
      time.advance(9_000);
      expect(table.get("ses_a")?.accountId).toBe("acct_1");
    }
  });

  it("只有过期的条目失效，新鲜的留着", () => {
    const time = clock();
    const table = new StickinessTable({ ttlSeconds: 10, now: time.now });
    table.bind("ses_old", "acct_1", "coding-plan");
    time.advance(9_000);
    table.bind("ses_new", "acct_2", "coding-plan");

    time.advance(2_000); // ses_old 过期，ses_new 还新鲜
    expect(table.get("ses_old")).toBeUndefined();
    expect(table.get("ses_new")?.accountId).toBe("acct_2");
  });
});

describe("StickinessTable — 容量 LRU（maxSessions）", () => {
  it("超出容量时淘汰最久未用的那条", () => {
    const table = new StickinessTable({ maxSessions: 2 });
    table.bind("ses_a", "acct_1", "coding-plan");
    table.bind("ses_b", "acct_1", "coding-plan");

    // 命中 a 把它挪到队尾，于是 b 变成最久未用的。
    expect(table.get("ses_a")?.accountId).toBe("acct_1");

    table.bind("ses_c", "acct_1", "coding-plan");
    expect(table.size()).toBe(2);
    expect(table.get("ses_b")).toBeUndefined();
    expect(table.get("ses_a")?.accountId).toBe("acct_1");
    expect(table.get("ses_c")?.accountId).toBe("acct_1");
  });
});

describe("StickinessTable — 按账号清理（禁用 / 并发设 0 → 解绑）", () => {
  it("forgetAccount 只清该账号名下的绑定，返回清掉的条数", () => {
    const table = new StickinessTable();
    table.bind("ses_a", "acct_1", "coding-plan");
    table.bind("ses_b", "acct_1", "start-plan");
    table.bind("ses_c", "acct_2", "coding-plan");

    expect(table.forgetAccount("acct_1")).toBe(2);
    expect(table.get("ses_a")).toBeUndefined();
    expect(table.get("ses_b")).toBeUndefined();
    expect(table.get("ses_c")?.accountId).toBe("acct_2");
  });

  it("forgetAccount 对不存在的账号是空操作", () => {
    const table = new StickinessTable();
    table.bind("ses_a", "acct_1", "coding-plan");

    expect(table.forgetAccount("acct_missing")).toBe(0);
    expect(table.size()).toBe(1);
  });
});
