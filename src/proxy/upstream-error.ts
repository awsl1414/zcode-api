/**
 * 上游观测点：**全部出线通道**
 * 的每一次上游活动都产出一个信号（`UpstreamSignal`，解析真源 `accounts/signals.ts`），
 * 健康动作一律走 `HealthEngine.apply`（经 `broker.noteUpstreamSignal`）。此前分散的
 * 三条判定路径已并入这里：只看白名单状态码的失败记账、只认三个状态码的业务码读取、
 * 以及 handler 里的 401/403 特判。
 *
 * ```
 * 通道（数据面流式/非流式 · 翻译层 · SSE 流 · async · claim）
 *   → observeUpstream(broker, lease, resp | event)     ← 唯一观测点（本文件）
 *       resp：非 2xx 全状态码 → signalFromResponse（含 5xx 信封业务码）
 *       event：SSE error 帧 / 空流 / connect 失败 / 流中断 / 翻译层信封码
 *   → broker.noteUpstreamSignal → HealthEngine.apply    ← 唯一状态变化入口
 *   → 消费方（broker 熔断 / claim 跳过 / record 标记）
 * ```
 *
 * 观测是**旁路**的：`Response` 输入用 `clone().text()` 读错误体，原响应体保持未消费，
 * 照原路径透给客户端。成功响应（2xx）不读体——200 形态的错误信封判定在翻译层
 * （`response-translation.ts::translatedBatchResponse` 的 `biz-code` 事件）与流层（`observeStream`
 * 的 error 帧 / 空流事件），不在这里。
 *
 * **被动探针**：broker 放行的探针请求带 `lease.probe`，其结果只回
 * `noteProbeResult`（2xx 恢复 / 失败翻倍），**不进账号健康**（探针失败说明路由
 * 还没好，不是探针账号的错）。
 *
 * **claim 的账号级观测**（{@link observeClaimUpstream}）：活动接口是账号面不是路由面，
 * 只有「额度终态码 / 限流码」（quota-terminal / rate-limited / fair-usage）是对账号
 * 健康的反馈，落到该账号的全部路由；活动域自己的失败（404 的活动不存在、
 * 3007 验证码、HTTP 429 活动频率限制、成功响应）不进账号健康——成功尤其不能进：
 * claim 平面可用 ≠ 服务额度恢复，误 markOk 会把采样才该解除的 drained 冲掉。
 *
 * 为什么在 proxy 层而不是 accounts 层：`Retry-After` 是 HTTP 语义、错误体只能读一次
 * （读法必须与"响应要透给客户端"写在一起）、事件在传输层产生。判定与动作在 accounts
 * 侧；本模块只做"读出来、交上去"，对 `Broker` 只有 `import type` + 运行时窄接口调用。
 */
import type { Account, RouteKind } from "../accounts/types.js";
import {
  emptyStreamSignal,
  signalFromBusinessCode,
  signalFromResponse,
  signalFromStreamError,
} from "../accounts/signals.js";
import type { UpstreamSignal, UpstreamSignalKind } from "../accounts/signals.js";
import type { RouteHealth } from "../accounts/health.js";
import type { Broker } from "../accounts/broker.js";
import { errorCodeOf } from "./error-codes.js";
import type { ErrorCode } from "./error-codes.js";

// ---------------------------------------------------------------------------
// 输入与输出形状
// ---------------------------------------------------------------------------

/**
 * 非响应形态的上游活动（信号解析的三类来源 + 翻译层信封）。
 *
 * - `biz-code`：翻译层已读出的信封业务码（`translatedBatchResponse` 的「invalid
 *   Anthropic message」分支，2xx 体携带 1005 的实测形态）；
 * - `stream-error`：SSE `type:"error"` 帧（BigModel `[1302][…]` 前缀提取在
 *   `signalFromStreamError`）——译码器不直接碰 broker，信号由流旁路回调送回这里；
 * - `empty-stream`：200 空流软拒绝（流式 0 events / 非流式非 Message 且无业务码）；
 * - `connect-failed`：`dispatchWithConnectRetry` 重试后仍失败（→ gateway 熔断 streak）；
 * - `stream-interrupted`：已回写字节后流读失败且**非**客户端主动断（→ transport）。
 */
export type UpstreamEvent =
  | { type: "biz-code"; code: number | string; detail?: string }
  | { type: "stream-error"; frameType?: string; message?: string }
  | { type: "empty-stream"; detail?: string }
  | { type: "connect-failed"; detail?: string }
  | { type: "stream-interrupted"; detail?: string };

/**
 * 一次观测的结果：解析出的信号 + 由它派生的统一 errorCode + 引擎动作后的健康快照。
 *
 * 调用方按 `signal.kind` 分流（换号判定读 `kind === "auth"`，替代旧
 * `isAuthFailedSignal` 特判）；语义化错误的 `Retry-After` 取 `health.until`。
 *
 * 统一身份之后：`errorCode` 由 `errorCodeOf(signal.kind)` 在同一处派生——健康层读
 * `signal.kind`，统计/展示层读这同一个身份。`success` 不是错误，落 `undefined`
 * （调用方不给记录落码）。
 */
export interface UpstreamObservation {
  signal: UpstreamSignal;
  errorCode?: ErrorCode;
  health: RouteHealth;
}

/**
 * 观测目标：`Lease` 的结构子集（`{ account, route, probe? }`），数据面直接传租约。
 *
 * `probe` 由 broker 在 `isProbeDue` 放行时标记（`Lease.probe`），见文件头探针语义。
 */
export interface ObservationTarget {
  account: Account;
  route: RouteKind;
  probe?: boolean;
}

// ---------------------------------------------------------------------------
// 解析（纯读，不动健康）
// ---------------------------------------------------------------------------

/** 原始错误片段截断到 ≤200 字符（`UpstreamSignal.detail` 的契约）；空串不带 detail。 */
const DETAIL_MAX_CHARS = 200;

function truncate(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  return trimmed.length <= DETAIL_MAX_CHARS ? trimmed : `${trimmed.slice(0, DETAIL_MAX_CHARS - 1)}…`;
}

/**
 * 把一次上游活动读成信号（不动健康）。`observeUpstream` 的解析半边，独立导出给
 * claim 的账号级观测复用（那边要先分类再决定落不落健康）。
 *
 * `Response` 输入：2xx 不读体（成功响应体大，200 形态的错误判定在流/翻译层）；
 * 非 2xx 用 `clone().text()` 读错误体——原响应体必须保持未消费（要原样透传），
 * clone 失败（体已被读过）按"读不出码"处理，不是错误。
 */
export async function readUpstreamSignal(
  input: Response | UpstreamEvent,
  now: number = Date.now(),
): Promise<UpstreamSignal> {
  if (input instanceof Response) {
    if (input.ok) return signalFromResponse(input.status, input.headers, undefined, now);
    let bodyText: string | null = null;
    try {
      bodyText = await input.clone().text();
    } catch {
      bodyText = null;
    }
    return signalFromResponse(input.status, input.headers, bodyText, now);
  }

  switch (input.type) {
    case "biz-code": {
      const signal = signalFromBusinessCode(input.code);
      return input.detail === undefined ? signal : withDetail(signal, input.detail);
    }
    case "stream-error":
      return signalFromStreamError(input.frameType, input.message);
    case "empty-stream":
      return input.detail === undefined ? emptyStreamSignal() : withDetail(emptyStreamSignal(), input.detail);
    case "connect-failed":
      // connect 失败 = 网关不可达：进路由级 gateway-broken streak。
      return withDetail({ kind: "gateway" }, input.detail);
    case "stream-interrupted":
      // 流中断 = 传输层故障：同上进 streak，不冷却账号。
      return withDetail({ kind: "transport" }, input.detail);
  }
}

/** detail 并入信号（已有 detail 时保留原值——解析层的原文更权威），整体截断 ≤200。 */
function withDetail(signal: UpstreamSignal, detail: string | undefined): UpstreamSignal {
  const merged = truncate(signal.detail ?? detail);
  return merged === undefined ? signal : { ...signal, detail: merged };
}

// ---------------------------------------------------------------------------
// 唯一观测点
// ---------------------------------------------------------------------------

/**
 * 观测一次上游活动并落健康动作（唯一观测点）。
 *
 * - 普通请求：信号 → `broker.noteUpstreamSignal` → `HealthEngine.apply`（信号→动作
 *   映射表见 `health.ts` 文件头）；
 * - 探针请求（`target.probe`）：只回 `noteProbeResult`（2xx = 恢复路由 / 失败 =
 *   退避翻倍），**不动账号健康**。事件形态的输入不改写探针判定——探针结果是
 *   响应形状的（2xx/4xx 才调 `noteProbeResult`），流事件忽略之。
 *
 * 返回信号与动作后的健康快照；观测永不抛错路径上的异常（读体失败已吞）。
 */
export async function observeUpstream(
  broker: Broker,
  target: ObservationTarget,
  input: Response | UpstreamEvent,
  now: number = Date.now(),
): Promise<UpstreamObservation> {
  const signal = await readUpstreamSignal(input, now);
  // 错误产生点落码：与上面解析出的信号同源派生，不做第二次分类。
  const errorCode = errorCodeOf(signal.kind);
  if (target.probe === true) {
    if (input instanceof Response) {
      broker.health.noteProbeResult(target.route, input.ok);
    }
    return { signal, ...(errorCode !== undefined ? { errorCode } : {}), health: broker.health.status(target.account.id, target.route) };
  }
  const health = broker.noteUpstreamSignal(target.account, target.route, signal);
  return { signal, ...(errorCode !== undefined ? { errorCode } : {}), health };
}

// ---------------------------------------------------------------------------
// claim 的账号级观测
// ---------------------------------------------------------------------------

/**
 * claim（活动接口）出线对账号健康有反馈的信号类：额度终态 → drained、限流码 →
 * 冷却、fair-usage → 长冷却。
 *
 * **不含** success（claim 可用 ≠ 服务额度恢复，误 markOk 会冲掉采样才该解除的
 * drained）、auth（claim 的 401/3007 是活动域的 login/captcha 域，`claim/types.ts`
 * 的 `$vt` mapper 自有处理）、endpoint-shape / gateway / transport（活动端点的形态
 * 问题不进数据面路由熔断）、model-level（活动域的请求类错误）。HTTP 429 活动频率
 * 限制是「claim 自有的 rate-limit」（活动调度域，`rate-limit.ts` 的共享窗口），同样
 * 不进账号健康——本函数只在**业务码**把分类带进上述三类时才落健康。
 */
const CLAIM_HEALTH_KINDS: ReadonlySet<UpstreamSignalKind> = new Set<UpstreamSignalKind>([
  "quota-terminal",
  "rate-limited",
  "fair-usage",
]);

/**
 * 观测一次 claim 出线（账号级，不是路由级）：命中 {@link CLAIM_HEALTH_KINDS} 的
 * 信号落到该账号的**全部路由**（claim 平面报的是账号面事实——额度/限流不是某条
 * 路由的事）。返回落了健康的信号；`undefined` = 这次活动归活动域，没动账号健康。
 */
export async function observeClaimUpstream(
  broker: Pick<Broker, "noteUpstreamSignal">,
  account: Account,
  input: Response | UpstreamEvent,
  now: number = Date.now(),
): Promise<UpstreamSignal | undefined> {
  const signal = await readUpstreamSignal(input, now);
  if (!CLAIM_HEALTH_KINDS.has(signal.kind)) return undefined;
  for (const route of account.routes) {
    broker.noteUpstreamSignal(account, route, signal);
  }
  return signal;
}
