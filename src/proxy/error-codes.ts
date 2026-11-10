/**
 * 统一错误分类学：产生点落码，健康 / 统计 / 用户三个出口读同一份身份。
 *
 * 全表两类稳定键 + 一个兜底：
 * - 本地调度族（8）：broker `AccountUnavailableError.code` 是结构化源头，经
 *   {@link errorCodeOf} 直通/归一成这里的键；
 * - 上游族（11 个键 / 10 行用户词）：`accounts/signals.ts::UpstreamSignal.kind`
 *   是结构化源头，`gateway`/`transport` 两键共用「连接失败」一个用户词；
 *   `upstream-error` 是没有信号可依的通用上游失败，`translate-failed` 是翻译层
 *   自己的失败（两者都没有对应的 `UpstreamSignalKind`）；
 * - `other`：未归类的新错误 / 旧记录缺码。诚实兜底，**不猜**。
 *
 * 这里是分类学的**唯一真源**：`errorCodeOf(brokerCode | signalKind)` 是唯一映射，
 * 反向 `signalKindOfErrorCode` 由同一张表导出（不是第二张手写表）。三出口同源：
 *
 * ```
 * 产生点（broker / upstream-error / 翻译层 / handler）
 *   → RequestRecord.errorCode（error 原文保留为 detail）
 *   → ① 健康层：observeUpstream 由 errorCode 反推 signal.kind → HealthEngine
 *     ② 统计层：usage-stats 直接按 errorCode 分组（零字符串匹配）
 *     ③ 用户层：errorCode.<code> / .hint（i18n 两语言），CLI 与日志页读同一批键
 * ```
 *
 * 依赖方向：本文件是叶子（只有 `import type`，没有运行时依赖），所以 accounts 的
 * broker / signals 与 proxy 的 handler / record 都能安全引用它。`BrokerErrorCode`
 * 与 `UpstreamSignalKind` 仍是各自层的结构化原因码；它们**不**是对外展示词，
 * 展示词只从本表的键经 i18n 派生：一份分类学，三个出口。
 */
import type { BrokerErrorCode } from "../accounts/broker.js";
import type { UpstreamSignalKind } from "../accounts/signals.js";

// ---------------------------------------------------------------------------
// 全表：本地调度族与上游族
// ---------------------------------------------------------------------------

/** 本地调度族：broker 拒绝出线的用户可见身份。*/
export type LocalErrorCode =
  | "accounts-saturated"
  | "all-accounts-cooling"
  | "quota-exhausted"
  | "auth-invalid"
  | "route-broken"
  | "model-unsupported"
  | "account-disabled"
  | "queue-timeout";

/** 上游族：signalKind 同源派生 + 翻译层失败 + 无信号可依的通用上游失败。*/
export type UpstreamErrorCode =
  | "upstream-rate-limited"
  | "upstream-fair-usage"
  | "upstream-auth-rejected"
  | "upstream-quota-terminal"
  | "upstream-endpoint-shape"
  | "upstream-gateway"
  | "upstream-transport"
  | "upstream-empty-stream"
  | "upstream-model-level"
  | "upstream-error"
  | "translate-failed";

/** 未归类的新错误 / 旧记录缺码：诚实兜底，不猜。*/
export type OtherErrorCode = "other";

/** 一条失败记录的稳定身份。*/
export type ErrorCode = LocalErrorCode | UpstreamErrorCode | OtherErrorCode;

/** 本地调度族全表。*/
export const LOCAL_ERROR_CODES: readonly LocalErrorCode[] = [
  "accounts-saturated",
  "all-accounts-cooling",
  "quota-exhausted",
  "auth-invalid",
  "route-broken",
  "model-unsupported",
  "account-disabled",
  "queue-timeout",
];

/** 上游族全表（gateway / transport 是两个键、一个用户词）。*/
export const UPSTREAM_ERROR_CODES: readonly UpstreamErrorCode[] = [
  "upstream-rate-limited",
  "upstream-fair-usage",
  "upstream-auth-rejected",
  "upstream-quota-terminal",
  "upstream-endpoint-shape",
  "upstream-gateway",
  "upstream-transport",
  "upstream-empty-stream",
  "upstream-model-level",
  "upstream-error",
  "translate-failed",
];

/** 全表（含兜底）：i18n 键覆盖、落码用例、聚合分组都按这一份遍历。*/
export const ERROR_CODES: readonly ErrorCode[] = [...LOCAL_ERROR_CODES, ...UPSTREAM_ERROR_CODES, "other"];

// ---------------------------------------------------------------------------
// 唯一映射（三出口同源）
// ---------------------------------------------------------------------------

/**
 * `UpstreamSignalKind`（除 `success`，成功不是错误）→ 上游族 errorCode。
 *
 * `Record` 而不是 switch：signals.ts 新增 kind 时这里直接编译报错，不会静默漏码。
 * 反向表 {@link SIGNAL_KIND_OF_ERROR_CODE} 从这一张导出，健康层与统计层不可能
 * 对同一个错误给出两个身份（同源派生）。
 */
const SIGNAL_ERROR_CODES: Record<Exclude<UpstreamSignalKind, "success">, UpstreamErrorCode> = {
  "rate-limited": "upstream-rate-limited",
  "fair-usage": "upstream-fair-usage",
  "auth": "upstream-auth-rejected",
  "quota-terminal": "upstream-quota-terminal",
  "endpoint-shape": "upstream-endpoint-shape",
  "gateway": "upstream-gateway",
  "transport": "upstream-transport",
  "empty-stream": "upstream-empty-stream",
  "model-level": "upstream-model-level",
};

/** broker 内部原因码 → 本地调度族（`Record` 保证每个内部码都有身份）。*/
const BROKER_ERROR_CODES: Record<BrokerErrorCode, ErrorCode> = {
  // 与本地调度族同名的键直通：产生点已经是用户身份，不再二次分类。
  "accounts-saturated": "accounts-saturated",
  "all-accounts-cooling": "all-accounts-cooling",
  "quota-exhausted": "quota-exhausted",
  "auth-invalid": "auth-invalid",
  "route-broken": "route-broken",
  "model-unsupported": "model-unsupported",
  "account-disabled": "account-disabled",
  "queue-timeout": "queue-timeout",
  // 比用户身份更细的调度状态：按「用户该做什么」归一，detail 原文不丢。
  // 没有账号 / 全被禁用 → 去账号页启用或导入；账号健康态非 ok → 等自动恢复。
  "no-account": "account-disabled",
  "account-unhealthy": "all-accounts-cooling",
  // 显式指定的账号不存在 / 该账号不允许此路由：全表没有对应身份 → other（不猜）。
  "account-unknown": "other",
  "route-not-allowed": "other",
};

/**
 * 唯一映射：`brokerCode | signalKind` → errorCode。
 *
 * 三出口同源契约：产生点（broker 拒绝 / `observeUpstream` 的信号）只调这一个函数，
 * 健康层、统计层、用户层都读落下来的 `RequestRecord.errorCode`，不再各自分类。
 * `success` 不是错误，返回 `undefined`（调用方据此不给记录落码）。
 */
export function errorCodeOf(source: BrokerErrorCode | UpstreamSignalKind): ErrorCode | undefined {
  if (source in SIGNAL_ERROR_CODES) {
    return SIGNAL_ERROR_CODES[source as Exclude<UpstreamSignalKind, "success">];
  }
  if (source === "success") return undefined;
  return BROKER_ERROR_CODES[source as BrokerErrorCode];
}

/** 反查表：从同一张映射导出，不手写第二张（健康层 errorCode → kind 的唯一入口）。*/
const SIGNAL_KIND_OF_ERROR_CODE: ReadonlyMap<UpstreamErrorCode, UpstreamSignalKind> = new Map(
  (Object.entries(SIGNAL_ERROR_CODES) as [Exclude<UpstreamSignalKind, "success">, UpstreamErrorCode][])
    .map(([kind, code]) => [code, kind]),
);

/**
 * errorCode → `UpstreamSignal.kind`（健康层的出线）。
 *
 * `observeUpstream` 解析出信号后先落 errorCode，再用这里反推交给 HealthEngine 的
 * kind——健康动作与统计/展示读的是同一个身份。`upstream-error` /
 * `translate-failed` / 本地族 / `other` 没有对应 kind（它们不是信号形态的失败），
 * 返回 `undefined`；调用方保留解析出的原 kind。
 */
export function signalKindOfErrorCode(code: ErrorCode): UpstreamSignalKind | undefined {
  return SIGNAL_KIND_OF_ERROR_CODE.get(code as UpstreamErrorCode);
}

/** 全表成员判定（读 JSONL 旧行 / 外部输入用；不是字符串分类，只是集合检查）。*/
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * 事件形态上游失败 → errorCode（与 `upstream-error.ts::readUpstreamSignal` 同源）。
 *
 * `biz-code` / `stream-error` 的 kind 要解析后才知道，调用方优先用
 * `observeUpstream()` 返回的 `errorCode`；这里只覆盖**不带解析结果**就返回错误
 * 响应的出口（connect 失败 / 流中断 / 空流），避免每个 handler 自己抄一遍 kind。
 */
export type UpstreamEventCode =
  | "connect-failed"
  | "stream-interrupted"
  | "empty-stream"
  | "biz-code"
  | "stream-error";

export function errorCodeOfUpstreamEvent(type: UpstreamEventCode): ErrorCode {
  switch (type) {
    case "connect-failed":
      return SIGNAL_ERROR_CODES.gateway;
    case "stream-interrupted":
      return SIGNAL_ERROR_CODES.transport;
    case "empty-stream":
      return SIGNAL_ERROR_CODES["empty-stream"];
    // 这两种的 kind 取决于业务码 / 帧内容；没有解析结果时的诚实兜底。
    case "biz-code":
    case "stream-error":
      return "upstream-error";
  }
}
