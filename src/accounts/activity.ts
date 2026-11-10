/**
 * 账号「最近活跃」时钟。额度采样器用它决定**健康账号要不要采**：只采最近活跃过的
 * 健康账号，不健康的一律照采，因为全量轮询每个账号正是"定时探测"这个特征。
 *
 * "活跃"以额度采样间隔为窗口：窗口内没有派发过请求的健康账号，采样器跳过它。
 *
 * 为什么需要单独一份记录：额度采样器要回答"这个账号最近有没有被派发过请求"，而
 * 这个事实只有调度器（`broker.ts`）知道。让 `quota.ts` 反过来去问 broker 会逼出
 * accounts 内部的双向依赖；让它自己记账又必然与调度器漏记（例如 fail-open 路径）。
 * 所以由 broker 在每次**拿到租约**时打一拍，采样器只读。
 *
 * 刻意**不做**的：不做 LRU、不做容量上限。条目数 = 账号数（O(N)，N 是用户自己导入
 * 的账号个数），账号删除由控制面调 {@link forget} 清掉，不需要淘汰策略。
 */

/**
 * 账号最近一次被派发的时刻表（内存，不落盘）。
 *
 * 时钟注入（`now`）是为了测试能直接跨过"空闲窗口"，生产路径默认 `Date.now`。
 */
export class ActivityClock {
  /** accountId → Unix ms。没有条目 = 从未被派发过。*/
  private readonly lastActiveAt = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 记一拍：这个账号刚刚拿到租约（即将出线）。*/
  mark(accountId: string): void {
    this.lastActiveAt.set(accountId, this.now());
  }

  /** 最近一次活跃时刻；`undefined` = 本进程从未派发过它。*/
  lastActive(accountId: string): number | undefined {
    return this.lastActiveAt.get(accountId);
  }

  /**
   * 是否在 `windowMs` 内活跃过。
   *
   * 从未被派发过的账号算**不活跃**：刚启动时一次全量采样等于
   * 一上来就把所有账号都探一遍，正是"定时全量轮询"这个探测特征。
   */
  isActive(accountId: string, windowMs: number): boolean {
    const last = this.lastActiveAt.get(accountId);
    if (last === undefined) return false;
    return this.now() - last <= windowMs;
  }

  /** 账号删除时清掉，避免表跟着账号无限增长。*/
  forget(accountId: string): void {
    this.lastActiveAt.delete(accountId);
  }
}
