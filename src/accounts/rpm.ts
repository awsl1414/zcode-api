/**
 * 上游 RPM 闸：每分钟请求数上限，取自 `accounts.entries[].rpmLimit` 或账号 policy。
 *
 * 语义是**超限按 `saturated` 处理，不是直接 429 上游**。
 *
 * | | 饱和（本模块） | 上游 429（`health.apply` rate-limited） |
 * |---|---|---|
 * | 触发 | 我们先算出来的"这一分钟用满了" | 上游已经拒绝了我们 |
 * | 动作 | 排队/溢出（`routing.onSaturated`） | 冷却该 `(account, route)` |
 * | 上游观感 | 一个请求都没多发 | 已经多发了，且被限流 |
 *
 * 所以闸门必须在**发请求之前、按本地计数**拦下来：把超限请求放上去再让上游回 429，
 * 既浪费一次配额又是一次明确的滥用信号（同一个请求只走一个账号、失败不轮询试号，
 * 是风控硬约束）。
 *
 * 窗口是滑动窗口而不是固定桶：固定桶在窗口交界处会放行 2×rpm 个请求（桶尾一阵 +
 * 桶头一阵），对上游就是一次突发，正好踩风控。
 *
 * 键是**账号**而不是 `(account, route)`：RPM 是上游按凭据（API Key / JWT）计的，
 * 同一份凭据打哪个端点都算同一个配额。并发槽位则相反，它按 `(account, route)` 计
 * （`lease.ts` 文件头），两者不能混。
 */

/** 一分钟窗口（RPM 的字面定义）。*/
const RATE_WINDOW_MS = 60_000;

/**
 * 一条"这个账号窗口内的请求时间戳"记录。
 *
 * 数组按时间升序（`record` 只往后 push，`prune` 只从头部切），所以"窗口内有几条"
 * 就是长度，"下一个名额何时腾出"就是"第 (length - limit + 1) 条滑出窗口的时刻"。
 */
export class RpmGate {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * 现在还能不能给这个账号发请求（**不计数**）。
   *
   * `limit === undefined` = 用户没配 = 不限制：配置缺省项按默认补齐，而
   * `rpmLimit` 的默认值就是"无"。
   */
  allows(accountId: string, limit: number | undefined): boolean {
    if (limit === undefined) return true;
    const hits = this.prune(accountId);
    return hits.length < limit;
  }

  /** 计一次请求。**只在真的占到槽位、即将出线时**调，被闸下的尝试不计数。*/
  record(accountId: string): void {
    this.bucket(accountId).push(this.now());
  }

  /**
   * 窗口内腾出下一个名额的时间点（Unix ms）；`undefined` = 现在就能放行。
   *
   * 调用方（`broker.ts`）用它排一次唤醒：没有它，`onSaturated: wait` 的排队者会
   * 傻等到 `queueTimeoutMs` 才 429，而 RPM 窗口是按时间滑动的 —— 它本来只需要等
   * 到最早那条记录滑出窗口。
   */
  nextCapacityAt(accountId: string, limit: number | undefined): number | undefined {
    if (limit === undefined) return undefined;
    const hits = this.prune(accountId);
    if (hits.length < limit) return undefined;
    // 要等到第 (hits.length - limit + 1) 条滑出窗口，它在数组里的下标是 length - limit。
    const oldestBlocking = hits[hits.length - limit];
    return oldestBlocking + RATE_WINDOW_MS;
  }

  /** 窗口内的请求数（控制面「今日请求量」/ 面板用，风控可见性要求）。*/
  inflightWindow(accountId: string): number {
    return this.prune(accountId).length;
  }

  /** 账号删除时清掉：内存状态不跟着账号无限增长。*/
  forget(accountId: string): void {
    this.hits.delete(accountId);
  }

  /**
   * 丢掉窗口外的记录并返回该账号的窗口内记录（没有则返回空数组）。
   *
   * 只读路径（`allows` / `nextCapacityAt` / `inflightWindow`）走这里：不创建条目，
   * 所以查询本身不会让表长大。
   */
  private prune(accountId: string): number[] {
    const cutoff = this.now() - RATE_WINDOW_MS;
    const hits = this.hits.get(accountId);
    if (hits === undefined) return [];
    let drop = 0;
    while (drop < hits.length && hits[drop] <= cutoff) drop++;
    if (drop > 0) hits.splice(0, drop);
    return hits;
  }

  /** 取（必要时创建）该账号的窗口记录数组，先剪掉滑出窗口的旧记录。*/
  private bucket(accountId: string): number[] {
    const hits = this.prune(accountId);
    if (hits.length > 0) return hits;
    const fresh: number[] = [];
    this.hits.set(accountId, fresh);
    return fresh;
  }
}
