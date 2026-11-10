/**
 * 共享限流窗口：claim 的 preview 轮询按出口 IP 被上游限流，多账号同出口
 * 时一个人撞 429，同出口的其他账号大概率同窗（用户实测：8 账号各自独立 5 分钟
 * 轮询，轮流把限流窗口打满）。所有走同一出口的 scheduler 共享一个窗口对象：
 *
 *   - 撞限流者 `reportLimited(retryUntil)` —— 窗口只推迟不提前（取 max）；
 *   - 其他 scheduler 在每拍开头采纳（`scheduler.ts::adoptSharedRateLimit`），
 *     把 `holdUntil` 推到窗口结束之后 —— 同一限流窗口内全组**最多撞一次**。
 *
 * 只对 429 生效：already_claimed / quota_exhausted 是账号自己的业务状态，
 * 与出口无关，不进这个窗口：它们描述的是账号自己的业务状态，换出口也不会变。
 *
 * 按**出口**分组（`runtime.ts::rateLimitForEgress`）：上游按 IP 限流，不同代理
 * 出口的账号限流域不同，不该互相牵连；直连账号共享本机 IP，归同一窗口。
 */

/** 一个出口的共享限流窗口（不可变读取 + 单向推迟的汇报）。*/
export interface ClaimRateLimitWindow {
  /** 窗口结束时刻（unix ms）；`0` = 无已知限流。*/
  readonly untilMs: number;
  /** 撞限流者汇报。早于当前窗口的时刻被忽略（窗口只推迟，不提前）。*/
  reportLimited(untilMs: number): void;
}

/** 造一个窗口（`runtime.ts` 按出口各造一个；测试可直接注入假窗口）。*/
export function createClaimRateLimitWindow(): ClaimRateLimitWindow {
  let untilMs = 0;
  return {
    get untilMs(): number {
      return untilMs;
    },
    reportLimited(next: number): void {
      if (Number.isFinite(next) && next > untilMs) untilMs = next;
    },
  };
}

/**
 * 出口 → 窗口分组键（同键 = 同一个上游限流域）。
 *
 * 代理出口用它的 URL（不含凭据：username/password 不进键，也不进日志）；
 * `undefined` = 直连，全部归 `"direct"` —— 本机只有一个 IP。
 */
export function rateLimitEgressKey(proxyUrl: string | undefined): string {
  return proxyUrl?.trim() || "direct";
}
