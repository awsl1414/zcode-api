/**
 * 上游信号在调度侧的副作用。
 *
 * 信号本身是「上游发生了什么」的单一事实（`signals.ts`），健康状态机怎么迁移由
 * `HealthEngine.apply` 决定；本文件只回答 broker 的另一个问题：**这次信号之后，
 * 调度器还得跟着动什么**。两件事，都只看 `kind`：
 *
 * - `availability`：候选集变了，必须唤醒排队者重算（否则他们一直在等一个已经
 *   不可用 / 刚刚恢复的账号）。
 * - `resample`：终态码与空流让额度采样立刻说话（`sampleNow` 自带去重），用
 *   `nextResetTime` 精确化 `until` 并复核套餐持有。
 *
 * 与 `health-observation.ts` 分开：那个文件是面板的结构化快照（事件缓冲 + 熔断
 * 视图），变更理由是"页面要看什么"；这里是调度动作判定，变更理由是"上游新增了
 * 哪类信号"。混在一起会让同一个文件有两个改法。
 */
import type { UpstreamSignal, UpstreamSignalKind } from "./signals.js";

/**
 * 会改变 `(account, route)` 可用性的信号类。
 *
 * endpoint-shape / gateway / transport 只做路由级记账（不冷却账号）、model-level
 * 不动健康——都不改候选集，唤醒排队者只会让他们空转一轮。
 */
export const AVAILABILITY_KINDS: ReadonlySet<UpstreamSignalKind> = new Set<UpstreamSignalKind>([
  "success",
  "rate-limited",
  "quota-terminal",
  "fair-usage",
  "auth",
  "empty-stream",
]);

/** 触发即时复采的信号：终态码与空流都让数据说话，且共用 `sampleNow` 的去重窗口。*/
export const RESAMPLE_KINDS: ReadonlySet<UpstreamSignalKind> = new Set<UpstreamSignalKind>([
  "quota-terminal",
  "empty-stream",
]);

/** 一次信号要调度器跟着做的副作用。两个都能为假（只进健康表与路由记账）。*/
export interface SignalEffects {
  /** 候选集可能变化：唤醒排队者。*/
  readonly availability: boolean;
  /** 额度采集需要立刻重采这个账号。*/
  readonly resample: boolean;
}

/**
 * 四种组合各一个定值对象。
 *
 * 这条路径每个上游响应走一次，返回常量而不是每次新建：副作用判定是纯查表，
 * 没有按次状态可言。
 */
const EFFECTS: Readonly<Record<`${boolean}-${boolean}`, SignalEffects>> = {
  "true-true": Object.freeze({ availability: true, resample: true }),
  "true-false": Object.freeze({ availability: true, resample: false }),
  "false-true": Object.freeze({ availability: false, resample: true }),
  "false-false": Object.freeze({ availability: false, resample: false }),
};

/** 判定一次信号的调度副作用。*/
export function signalEffects(signal: UpstreamSignal): SignalEffects {
  const availability = AVAILABILITY_KINDS.has(signal.kind);
  const resample = RESAMPLE_KINDS.has(signal.kind);
  return EFFECTS[`${availability}-${resample}`];
}
