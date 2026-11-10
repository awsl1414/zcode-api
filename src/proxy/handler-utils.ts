/**
 * handler 主链的纯工具：收尾回调契约、响应字节计数、显式头解析。
 *
 * 这里的东西都不碰 broker、不构造出线请求、不决定走哪条出口——主链
 * （`handler.ts::proxyRequestOnLease`）负责编排，它们只回答「这一次出线的记录字段
 * 怎么算」。所以本模块没有状态，也没有第二个出线口。
 */
import { isRouteKind, ROUTE_KINDS } from "../accounts/routes.js";
import type { RouteKind } from "../accounts/types.js";
import type { ErrorCode } from "./error-codes.js";
import type { RequestRecord } from "./request-record.js";

/**
 * 一次收尾附带的失败事实。
 *
 * `code` 是产生点的统一身份；`stage` / `error` 分别是阶段与 detail 原文。
 * 所有失败出口都必须带 code（缺省 `other` 只给真正的未知异常兜底）。
 */
export interface ReportFailure {
  stage: string;
  error: string;
  code?: ErrorCode;
}

/**
 * 一次请求的收尾回调。
 *
 * 由 `proxyRequestOnLease` 构造（它闭包了 record），辅助函数（翻译批处理、上游
 * 错误直传）通过它收尾，这样「每个出口都记一次」只有一处实现。
 */
export type ReportEnd = (
  status: number,
  headersAt: number,
  outputTokens?: number,
  inputTokens?: number,
  failure?: ReportFailure,
  /**
   * 上游报告的缓存命中 / 缓存写入 token 数（批量翻译路径从上游 Anthropic
   * usage 直读）。`undefined` = 上游没报这个桶；`0` = 明确报了 0 命中——两者
   * 都要保真地落到记录上（聚合的缓存命中率分母只收「报了」的）。
   */
  cacheReadTokens?: number,
  cacheCreationTokens?: number,
) => void;

/**
 * 直传非流式出口的字节计数。
 *
 * 这条路径 body 一个字节都不读（压缩字节与 `Content-Encoding` 原样透传，这是直传
 * 语义），所以字节数只能在**字节流过时**数：这里挂一层纯转发的 TransformStream，
 * 把经过的字节累加进 `record.responseBytes`，流结束时落定。不缓冲、不改 chunk 边界、
 * 不改编码，所以直传语义逐字节不变（实测上游 batch 应答常是 chunked、
 * 没有 `content-length`，光靠那个头这一条路径永远是"未观测"）。
 *
 * 客户端中途取消时 flush 不会跑 → 字段保持未观测（旧值不被半份字节覆盖）。
 * 非 chunked、带 `content-length` 的应答由 {@link noteDeclaredResponseBytes} 落。 */
export function countingPassthrough(
  source: ReadableStream<Uint8Array>,
  record: RequestRecord,
): ReadableStream<Uint8Array> {
  let bytes = 0;
  const commit = (): void => {
    record.responseBytes = bytes;
  };
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush: commit,
  }));
}

/**
 * 直传非流式出口（无 body 时）：只取上游声明的 `content-length`。
 *
 * 只在该头是**合法非负整数**时才落：缺失就是缺失，拿解压后的长度去猜一个只会让
 * `usage-stats` 的字节聚合混进两类不同的样本。有 body 时走
 * {@link countingPassthrough}，那边是实测值，不必回退到这里。
 */
export function noteDeclaredResponseBytes(record: RequestRecord, upstream: Response): void {
  const declared = upstream.headers.get("content-length");
  if (declared === null) return;
  const bytes = Number.parseInt(declared, 10);
  if (!Number.isFinite(bytes) || bytes < 0) return;
  record.responseBytes = bytes;
}

/** 显式指定账号的请求头。*/
export const ACCOUNT_HEADER = "x-zcode-account";

/**
 * `X-ZCode-Account: <label>`（对应请求参数 `requestedAccount`）。
 *
 * 空值当未指定处理：这个头常见于"面板把空字符串拼进头里"的情形，把空串当成 label
 * 会得到一个必然的 `account-unknown`。
 */
export function requestedAccountLabel(req: Request): string | undefined {
  const value = req.headers.get(ACCOUNT_HEADER)?.trim();
  if (value === undefined || value === "") return undefined;
  return value;
}

/** 显式指定路由的请求头（对应请求参数 `pinnedRoute`）。*/
const ROUTE_HEADER = "x-zcode-route";

/**
 * `X-ZCode-Route` 的值不是四条 `RouteKind` 之一。
 *
 * 调用方翻成 400 `route_unknown`；这里只报「路由不存在」。「账号不允许该路由」是
 * 另一种情况，由 broker 报 `route-not-allowed`（消息里带账号 label），两个错误码
 * 在现有管线里已经分开。
 */
export class RouteUnknownError extends Error {
  constructor(readonly value: string) {
    super(`unknown route "${value}" (valid routes: ${ROUTE_KINDS.join(", ")})`);
    this.name = "RouteUnknownError";
  }
}

/**
 * `X-ZCode-Route: <routeKind>`（对应请求参数 `pinnedRoute`）：与 `X-ZCode-Account`
 * 同一家族的显式路由头。
 *
 * 背景：pinned 账号固定走 `account.routes[0]`，多路由账号（如
 * `coding-plan,start-plan`）被 `X-ZCode-Account` 指定时请求永远落在第一档，用户
 * 没有办法表达「用这个账号的 start-plan」。broker 侧的 `pinnedRoute` 机制已经
 * 存在（Responses 续轮在用），缺的只是请求头到 `request.pinnedRoute` 这一段。
 *
 * 三条语义：
 *
 * 1. 只带本头（不带 Account）：该路由成为唯一的档，`broker.routeOrder` 的 pinned
 *    分支负责「没有任何账号允许它就报 route-not-allowed」；档内按策略选号。
 * 2. `X-ZCode-Account` + 本头：账号必须允许该路由，否则 route-not-allowed
 *    （`broker.pinnedRoute` 已有校验，头值直接进 `request.pinnedRoute`）。
 * 3. 只带 `X-ZCode-Account`：行为不变，仍取 `routes[0]`。
 *
 * Responses 续轮钉号与本头同时出现时续轮优先：`pinnedAccountId` + `pinnedRoute`
 * 成对钉住上游上下文，换档等于丢上下文，所以显式头被忽略（优先级由
 * responses-handler 的分支顺序表达，不是静默丢失，那里有注释）。
 *
 * `/async/*` 不接本头：出线路由由票券通道固定（off-peak），没有选档可言；`/mcp`
 * 不做推理出线，同理。
 *
 * 值合法性：必须是 `ROUTE_KINDS` 之一，非法值抛 {@link RouteUnknownError}，由调用
 * 方翻成 400 `route_unknown`。不许静默忽略：静默改道会把「指定了但没生效」重演
 * 一遍；`X-ZCode-Account` 明确要求「显式指定，不静默改道」。
 *
 * 空值当未指定处理（同 {@link requestedAccountLabel}：面板会把空字符串拼进头里）。
 * 大小写归一：`ROUTE_KINDS` 全小写，头值先小写化再比对（HTTP 头值惯例）；配置
 * 文件里的路由 kind 不做这一步，那边有 `normalizeRoutes` 的严格校验。
 */
export function requestedRoute(req: Request): RouteKind | undefined {
  const value = req.headers.get(ROUTE_HEADER)?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  if (!isRouteKind(value)) throw new RouteUnknownError(value);
  return value;
}
