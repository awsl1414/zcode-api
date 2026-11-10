/**
 * 调度策略的运行时形状与默认值。
 *
 * 这一份是**唯一真源**：`config/types.ts` 的 `accounts.routing` / `accounts.stickiness`
 * 直接引用这里的类型，`config/loader.ts` 用这里的默认值补齐缺省项，`broker.ts` /
 * `lease.ts` 读它决定候选集、队列与降级顺序。抄两份的后果是"配置里写 8、调度器按
 * 64 排队"这种没人能查出来的偏差。
 *
 * 默认值一律按风控优先选，而不是按性能：
 *
 * | 键 | 默认 | 依据 |
 * |---|---|---|
 * | `order` | start-plan → coding-plan | 会过期的权益排在前面，先烧完再降级 |
 * | `withinTier` | sticky | 跨账号漂移是风控信号，要开得显式开 |
 * | `mode` | prefer | 上一档不可用就降级 |
 * | `strategy` | sticky-hash | 均衡会让同一会话在账号间漂移 |
 * | `onSaturated` | wait | 换号本身是异常信号 |
 * | `onDrained` | fallback | 额度用完降级到下一档 |
 * | `onAuthFailed` | rotate | 401/403 换同路由其他账号，**不降级** |
 * | `queueTimeoutMs` | 30000 | 排队超过这个时长就报 429，不让客户端无限等 |
 * | `maxQueue` | 64 | 队列有界，防止吞掉无限请求 |
 * | `maxTotalInflight` | 8 | N 个账号叠加不能出远超人类的并发 |
 */
import type { RouteKind } from "./types.js";

/**
 * `routing.mode`：`prefer` = 上一档不可用就降级；`only` = 只用 `order[0]`。
 *
 * `only` 是给"我就想只用 start-plan，宁可 429 也不许走套餐"的用户准备的：它把
 * 降级这条腿整体关掉，而不是把 order 写短一条 —— 后者在额度耗尽降级接上之后
 * 会重新长出降级行为。
 */
export type RoutingMode = "prefer" | "only";

/**
 * `routing.withinTier`：同一档路由里先试谁。
 *
 * 三个取值各自指定档内主序，`strategy` 在其中的位置随之变化（档间、档内主序、
 * 档内平手各由一个旋钮管）：
 *
 * - `sticky`（默认）按粘性哈希选号，同一会话永不跨账号。哈希给出全序，
 *   没有平手可判，所以它覆盖 `strategy`：那是同一取舍的表达，不是遗漏。
 * - `drain-first` 先烧最快过期的账号：已知 `expiresAt` 的按升序在前，没有采样结果
 *   的排在已知之后、彼此按 `strategy` 序分散。未知组也要散开：固定成一个顺序会让
 *   已知账号烧干后流量全堆到同一个账号上，采样闭环就断了。它回答的问题与负载均衡
 *   正交：哪种权益会先作废。
 * - `strategy` 把档内主序整体交给 `routing.strategy`，`balanced` 与 `round-robin`
 *   只有这一条入口。`sticky-hash` 在这里与 `sticky` 等价（有粘性键时按哈希，没有时
 *   退化为均衡）。
 *
 * `order` 只决定档与档的先后，档内的顺序由这个开关决定。
 */
export type WithinTierOrder = "sticky" | "drain-first" | "strategy";

/**
 * `routing.strategy`：同层里按什么排序。
 *
 * 三种策略的唯一实现是 `scheduler.ts::orderByStrategy`；这里只定义枚举与默认值。
 * 它的地位由 `withinTier` 决定：`withinTier: strategy` 时它就是档内主序，
 * `drain-first` 时它只判过期时间相同的平手，`sticky` 时被强制粘性覆盖。
 * 默认 `sticky-hash` 是风控取舍，不是性能取舍。
 */
export type RoutingStrategy = "sticky-hash" | "balanced" | "round-robin";

/** `routing.onSaturated`：`wait` 排队（默认）或 `overflow` 换同路由其他账号。*/
export type SaturatedAction = "wait" | "overflow";

/** `routing.onDrained`：降级到 `order` 下一档，或直接停。*/
export type DrainedAction = "fallback" | "stop";

/** `routing.onAuthFailed`：`rotate` = 换同路由其他账号且不降级。*/
export type AuthFailedAction = "rotate";

/** 粘性饱和行为：等绑定账号 / 溢出到同路由空闲账号 / 先等再溢出。*/
export type StickinessSaturatedAction = "wait" | "overflow" | "wait-then-overflow";

/** `accounts.routing`：调度面的全部旋钮。*/
export interface AccountsRouting {
  /** 权益紧迫度：会过期的在前，`order[0]` 最优先。*/
  order: RouteKind[];
  /** 档内主序：`sticky` 强制粘性并覆盖 `strategy`；`drain-first` 先烧最快过期的；`strategy` 交给 `strategy`。*/
  withinTier: WithinTierOrder;
  mode: RoutingMode;
  strategy: RoutingStrategy;
  onSaturated: SaturatedAction;
  onDrained: DrainedAction;
  onAuthFailed: AuthFailedAction;
  /** 排队等待上限，超时返回 429 + Retry-After。*/
  queueTimeoutMs: number;
  /** 队列深度上限，超出直接 429，不排队。*/
  maxQueue: number;
  /** 全局在飞上限：任何账号调大都不能突破它。*/
  maxTotalInflight: number;
}

/**
 * `accounts.stickiness`：会话粘性表。
 *
 * 表本身是 `stickiness.ts::StickinessTable`；这里只定义形状与默认值。
 * `ttlSeconds` / `maxSessions` 在建表时生效（表是内存结构，不支持热改容量），
 * `onSaturated` / `overflowAfterMs` 每次现读。
 */
export interface AccountsStickiness {
  enabled: boolean;
  /** 会话粘性 TTL，默认 30 分钟。*/
  ttlSeconds: number;
  /** 粘性表容量上限，LRU 淘汰。*/
  maxSessions: number;
  onSaturated: StickinessSaturatedAction;
  /** `wait-then-overflow` 的等待时长。*/
  overflowAfterMs: number;
}

// ---------------------------------------------------------------------------
// 默认值（TTL / 容量 / 超时 / 并发数一律命名，不在调用点写裸数字）
// ---------------------------------------------------------------------------

/** 默认降级顺序：会过期的权益在前。*/
export const DEFAULT_ROUTING_ORDER: readonly RouteKind[] = [
  "start-plan",
  "coding-plan",
];

/**
 * 同档内的默认主序：粘性。
 *
 * `drain-first` 能让多账号的免费额度先烧完，但代价是同一会话会在账号之间漂移，
 * 而漂移本身是风控信号。默认取粘性，想榨干额度的人显式打开。
 *
 * 连带后果：默认值下 `strategy` 不参与排序，要让 `balanced` /
 * `round-robin` 参与得把 `withinTier` 改成 `strategy`。
 */
export const DEFAULT_ROUTING_WITHIN_TIER: WithinTierOrder = "sticky";

/** 默认排队等待上限，30 秒（`routing.queueTimeoutMs`）。*/
export const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;

/** 默认队列深度上限（`routing.maxQueue`）。*/
export const DEFAULT_MAX_QUEUE = 64;

/** 默认全局在飞上限（`routing.maxTotalInflight`）。*/
export const DEFAULT_MAX_TOTAL_INFLIGHT = 8;

/** 会话粘性 TTL，30 分钟（`stickiness.ttlSeconds`）。*/
export const DEFAULT_STICKINESS_TTL_SECONDS = 1_800;

/** 粘性表容量上限，LRU 淘汰（`stickiness.maxSessions`）。*/
export const DEFAULT_STICKINESS_MAX_SESSIONS = 4_096;

/** `wait-then-overflow` 的默认等待时长（`stickiness.overflowAfterMs`）。*/
export const DEFAULT_STICKINESS_OVERFLOW_AFTER_MS = 5_000;

/** `accounts.routing` 的全量默认值；配置缺省项一律回落到这里。*/
export const DEFAULT_ACCOUNTS_ROUTING: AccountsRouting = {
  order: [...DEFAULT_ROUTING_ORDER],
  withinTier: DEFAULT_ROUTING_WITHIN_TIER,
  mode: "prefer",
  strategy: "sticky-hash",
  onSaturated: "wait",
  onDrained: "fallback",
  onAuthFailed: "rotate",
  queueTimeoutMs: DEFAULT_QUEUE_TIMEOUT_MS,
  maxQueue: DEFAULT_MAX_QUEUE,
  maxTotalInflight: DEFAULT_MAX_TOTAL_INFLIGHT,
};

/** `accounts.stickiness` 的全量默认值。*/
export const DEFAULT_ACCOUNTS_STICKINESS: AccountsStickiness = {
  enabled: true,
  ttlSeconds: DEFAULT_STICKINESS_TTL_SECONDS,
  maxSessions: DEFAULT_STICKINESS_MAX_SESSIONS,
  onSaturated: "wait",
  overflowAfterMs: DEFAULT_STICKINESS_OVERFLOW_AFTER_MS,
};

/** 枚举键的合法取值，供 `config/loader.ts` 校验（写错一个字母不能静默回落）。*/
export const ROUTING_MODES: readonly RoutingMode[] = ["prefer", "only"];
export const WITHIN_TIER_ORDERS: readonly WithinTierOrder[] = ["sticky", "drain-first", "strategy"];
export const ROUTING_STRATEGIES: readonly RoutingStrategy[] = ["sticky-hash", "balanced", "round-robin"];
export const SATURATED_ACTIONS: readonly SaturatedAction[] = ["wait", "overflow"];
export const DRAINED_ACTIONS: readonly DrainedAction[] = ["fallback", "stop"];
export const AUTH_FAILED_ACTIONS: readonly AuthFailedAction[] = ["rotate"];
export const STICKINESS_SATURATED_ACTIONS: readonly StickinessSaturatedAction[] = [
  "wait",
  "overflow",
  "wait-then-overflow",
];
