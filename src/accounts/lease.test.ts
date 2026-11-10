/**
 * 租约与有界队列的用例：并发与租约、兜底、运行时热调节与租约队列的交互。
 *
 * 这一层的契约很窄但每条都是硬约束，所以逐条钉死：
 *
 * 1. 并发不超限（池级 + 全局）
 * 2. `release` 幂等（重复调用不重复计数）
 * 3. 客户端 abort **立即**释放，不等流自然结束
 * 4. 队列有界：满了直接拒，不排队
 * 5. 等待有超时，超时带 `Retry-After` 秒数
 * 6. 调大并发立即唤醒排队者
 * 7. 调小并发**不驱逐**排队者
 * 8. force 禁用立即中止在飞并释放槽位
 *
 * @see 并发与租约 · 兜底 · 运行时账号控制
 */
import { describe, expect, it } from "bun:test";
import { LeaseManager, LeaseRejectedError, type QueueLimits, type SlotLease } from "./lease.js";
import type { RouteKind } from "./types.js";

const ROUTE: RouteKind = "coding-plan";
const ACCOUNT = "account-a";

/** 用例默认的排队上限（1 秒）：只要不撞上超时，具体值不重要。*/
const TEST_QUEUE_TIMEOUT_MS = 1_000;

/** 队列参数：默认给足空间，个别用例压到毫秒级。*/
function limits(overrides: Partial<QueueLimits> = {}): QueueLimits {
  return {
    maxQueue: () => 8,
    queueTimeoutMs: () => TEST_QUEUE_TIMEOUT_MS,
    ...overrides,
  };
}

/** 让出事件循环，等排队者的定时器/唤醒落地。*/
function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slot(leases: LeaseManager, limit = 1, totalLimit = 8, signal?: AbortSignal): SlotLease | null {
  return leases.tryAcquire({ accountId: ACCOUNT, route: ROUTE, limit, totalLimit, signal });
}

describe("LeaseManager — 并发不超限", () => {
  it("池级上限：占满后再占返回 null，释放后才能再占", () => {
    const leases = new LeaseManager(limits());
    const first = slot(leases, 2);
    const second = slot(leases, 2);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(slot(leases, 2)).toBeNull();
    expect(leases.inflight(ACCOUNT, ROUTE)).toBe(2);

    first!.release();
    expect(leases.inflight(ACCOUNT, ROUTE)).toBe(1);
    expect(slot(leases, 2)).not.toBeNull();
  });

  it("全局上限优先于池级上限：账号调大也突不破 maxTotalInflight", () => {
    const leases = new LeaseManager(limits());
    expect(leases.tryAcquire({ accountId: "a", route: ROUTE, limit: 8, totalLimit: 2 })).not.toBeNull();
    expect(leases.tryAcquire({ accountId: "b", route: ROUTE, limit: 8, totalLimit: 2 })).not.toBeNull();
    // 两个账号各自上限 8，但全局只剩 0，第三个请求必须被拒。
    expect(leases.tryAcquire({ accountId: "c", route: ROUTE, limit: 8, totalLimit: 2 })).toBeNull();
    expect(leases.totalInflight()).toBe(2);
  });

  it("上限 0 = 软禁用：永远占不到槽", () => {
    const leases = new LeaseManager(limits());
    expect(slot(leases, 0)).toBeNull();
    expect(leases.totalInflight()).toBe(0);
  });

  it("槽位池按 (account, route) 隔离（状态键不是账号）", () => {
    const leases = new LeaseManager(limits());
    expect(leases.tryAcquire({ accountId: "a", route: "coding-plan", limit: 1, totalLimit: 8 })).not.toBeNull();
    // 同一账号的另一条路由不受影响。
    expect(leases.tryAcquire({ accountId: "a", route: "start-plan", limit: 1, totalLimit: 8 })).not.toBeNull();
    // 同一路由的另一个账号也不受影响。
    expect(leases.tryAcquire({ accountId: "b", route: "coding-plan", limit: 1, totalLimit: 8 })).not.toBeNull();
    expect(leases.inflight("a", "coding-plan")).toBe(1);
    expect(leases.inflight("a", "start-plan")).toBe(1);
    expect(leases.totalInflight()).toBe(3);
  });
});

describe("LeaseManager — release 幂等", () => {
  it("重复调用不重复计数，也不会把在飞数减成负数", () => {
    const leases = new LeaseManager(limits());
    const lease = slot(leases, 1)!;
    lease.release();
    lease.release();
    lease.release();
    expect(leases.inflight(ACCOUNT, ROUTE)).toBe(0);
    expect(leases.totalInflight()).toBe(0);
  });
});

describe("LeaseManager — 客户端 abort", () => {
  it("已占槽后 abort：立即释放，不等流自然结束", () => {
    const leases = new LeaseManager(limits());
    const controller = new AbortController();
    const lease = slot(leases, 1, 8, controller.signal)!;
    expect(leases.inflight(ACCOUNT, ROUTE)).toBe(1);

    controller.abort();
    expect(leases.inflight(ACCOUNT, ROUTE)).toBe(0);
    expect(lease.signal.aborted).toBe(true);
  });

  it("abort 后不再占槽", () => {
    const leases = new LeaseManager(limits());
    const controller = new AbortController();
    controller.abort();
    expect(slot(leases, 1, 8, controller.signal)).toBeNull();
  });

  it("排队中 abort：排队者立即退出并释放队列位", async () => {
    const leases = new LeaseManager(limits());
    const held = slot(leases, 1)!;
    const controller = new AbortController();
    const queued = leases.wait(() => slot(leases, 1), controller.signal);
    await tick();
    expect(leases.queueDepth()).toBe(1);

    controller.abort();
    await expect(queued).rejects.toThrow(LeaseRejectedError);
    expect(leases.queueDepth()).toBe(0);
    held.release();
  });
});

describe("LeaseManager — 有界队列与超时", () => {
  it("队列满：直接拒绝（queue-full），不排队", async () => {
    const leases = new LeaseManager(limits({ maxQueue: () => 1 }));
    const held = slot(leases, 1)!;

    const first = leases.wait(() => slot(leases, 1));
    await tick();
    expect(leases.queueDepth()).toBe(1);

    // 第二个排队者被拒：队列深度已到 maxQueue。
    const second = leases.wait(() => slot(leases, 1));
    await expect(second).rejects.toThrow(LeaseRejectedError);
    await second.catch((err: LeaseRejectedError) => {
      expect(err.code).toBe("queue-full");
      expect(err.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    });

    held.release();
    (await first).release();
  });

  it("等待超时：queue-timeout 且带 Retry-After 秒数", async () => {
    const leases = new LeaseManager(limits({ queueTimeoutMs: () => 20 }));
    const held = slot(leases, 1)!;

    const queued = leases.wait(() => slot(leases, 1));
    const err = await queued.then(
      () => {
        throw new Error("expected the queued acquire to time out");
      },
      (e: unknown) => e as LeaseRejectedError,
    );
    expect(err).toBeInstanceOf(LeaseRejectedError);
    expect(err.code).toBe("queue-timeout");
    // 20ms → 向上取整 1 秒（Retry-After 不接受 0）。
    expect(err.retryAfterSeconds).toBe(1);
    expect(leases.queueDepth()).toBe(0);
    held.release();
  });

  it("排队期间不占槽，只计队列深度", async () => {
    const leases = new LeaseManager(limits());
    const held = slot(leases, 1)!;
    const queued = leases.wait(() => slot(leases, 1));
    await tick();

    expect(leases.inflight(ACCOUNT, ROUTE)).toBe(1);
    expect(leases.queueDepth()).toBe(1);

    held.release();
    (await queued).release();
    expect(leases.queueDepth()).toBe(0);
  });

  it("释放后唤醒排队者：先释放者先拿到槽", async () => {
    const leases = new LeaseManager(limits());
    const held = slot(leases, 1)!;
    const queued = leases.wait(() => slot(leases, 1));
    await tick();

    held.release();
    const acquired = await queued;
    expect(acquired.accountId).toBe(ACCOUNT);
    expect(leases.inflight(ACCOUNT, ROUTE)).toBe(1);
    acquired.release();
  });
});

describe("LeaseManager — 热调节", () => {
  it("调大并发：notifyCapacity 立即唤醒排队者", async () => {
    const leases = new LeaseManager(limits());
    // 上限由外部可变变量提供：模拟运行时把 maxConcurrency 从 1 调到 2。
    let limit = 1;
    const attempt = (): SlotLease | null =>
      leases.tryAcquire({ accountId: ACCOUNT, route: ROUTE, limit, totalLimit: 8 });

    const held = attempt()!;
    const queued = leases.wait(attempt);
    await tick();
    expect(leases.queueDepth()).toBe(1);

    // 只调大、不释放：唤醒后排队者必须能占上第二个槽。
    limit = 2;
    leases.notifyCapacity();
    const acquired = await queued;
    expect(leases.inflight(ACCOUNT, ROUTE)).toBe(2);

    held.release();
    acquired.release();
  });

  it("调小并发：不驱逐排队者，按新上限继续等", async () => {
    const leases = new LeaseManager(limits());
    let limit = 2;
    const attempt = (): SlotLease | null =>
      leases.tryAcquire({ accountId: ACCOUNT, route: ROUTE, limit, totalLimit: 8 });

    const first = attempt()!;
    const second = attempt()!;
    const queued = leases.wait(attempt);
    await tick();
    expect(leases.queueDepth()).toBe(1);

    // 调小到 1：排队者被唤醒但占不到槽，必须继续留在队列里（不驱逐、不报错）。
    limit = 1;
    leases.notifyCapacity();
    await tick();
    expect(leases.queueDepth()).toBe(1);
    // 在飞请求一个都没被打断。
    expect(leases.inflight(ACCOUNT, ROUTE)).toBe(2);

    // 释放到低于新上限后，排队者才拿到槽。
    first.release();
    second.release();
    const acquired = await queued;
    expect(leases.inflight(ACCOUNT, ROUTE)).toBe(1);
    acquired.release();
  });

  it("force 禁用：立即中止在飞并释放槽位", () => {
    const leases = new LeaseManager(limits());
    const a = slot(leases, 2)!;
    const b = slot(leases, 2)!;
    expect(leases.totalInflight()).toBe(2);

    const aborted = leases.forceRelease(ACCOUNT);
    expect(aborted).toBe(2);
    expect(leases.totalInflight()).toBe(0);
    // 被中止的租约 signal 必须真的 abort（调用方靠它断开上游）。
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
  });

  it("force 禁用只影响目标账号", () => {
    const leases = new LeaseManager(limits());
    const mine = slot(leases, 1)!;
    const other = leases.tryAcquire({ accountId: "account-b", route: ROUTE, limit: 1, totalLimit: 8 })!;

    expect(leases.forceRelease("account-b")).toBe(1);
    expect(mine.signal.aborted).toBe(false);
    expect(other.signal.aborted).toBe(true);
    expect(leases.inflight(ACCOUNT, ROUTE)).toBe(1);
    mine.release();
  });
});
