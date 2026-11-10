/**
 * POST /v1/responses request handler.
 *
 * Pipeline:
 *   1. Parse body + credential.
 *   2. Resolve `previous_response_id` via `ResponseStore` (prepend stored history).
 *   3. Translate Responses → Chat Completions (`responsesToChatCompletions`):
 *        - function / custom / namespace / tool_search tools → Chat tools.
 *        - web_search / web_search_preview / file_search / code_interpreter /
 *          computer_use / image_generation / mcp → stripped silently.
 *   4. Apply the standard body transform (stream_options, user_id, start-plan system).
 *   5. POST to the GLM Chat Completions upstream (reuse `buildUpstreamRequest`).
 *   6. Translate the Chat response → Responses (`chatCompletionsToResponses`
 *      or `chatChunkToResponsesEvents` for streaming).
 *   7. Store the new response under its id (unless `store:false`).
 *
 * State management: in-memory only (process restart clears the store); see
 * `responses/store.ts`.
 *
 * 请求记录：Responses 与 /v1/messages、/v1/chat/completions 一样是
 * 一等公民入站协议，面板的请求事件 tab 必须能看到它。这里复用与 handler.ts
 * 同一个 reqId 计数器与同一套阶段词表，记录由 `handleResponses` 创建、在 finally
 * 里收尾（与 `proxyRequest` 同形状）；流式用量统计复用 `handler-log.ts`
 * 的 `observeStream`，不另抄一份。
 */
import { transformRequestBody } from "./body-transformer.js";
import { resolveEffortOverride } from "../provider/effort-override.js";
import type { ProxyConfig } from "../config/types.js";
import type { Broker, Lease } from "../accounts/broker.js";
import { accountDeviceMid } from "../accounts/device-mid.js";
import { toAuthCredential } from "../accounts/manager.js";
import type { RouteKind } from "../accounts/types.js";
import { routeUpstreamBaseUrl } from "./route-endpoint.js";
import { fetchWithEgress } from "./egress.js";
import { acquireLease, withLeaseRelease } from "./lease.js";
// X-ZCode-Route 的解析只有一处实现，落在 handler-utils.ts：这里与
// `proxyRequest` 同语义。handler 与 handler-utils 都不反向依赖本文件，无环。
// isAnthropicMessagesResponse 同理（批量信封分流的 Message 形状校验，两边
// 同一份实现，落在 response-translation.ts）。
import { RouteUnknownError, requestedRoute } from "./handler-utils.js";
import { isAnthropicMessagesResponse } from "./response-translation.js";
import { buildUpstreamRequest, buildUpstreamHeaderPairs, buildUpstreamURL, type UpstreamHeaderPair } from "./upstream.js";
import { isCaptchaChallenged, retryOnCaptchaChallenge, resolveCaptchaAcquireBudgetMs, acquireCaptchaWithRetry, type CaptchaModuleLike } from "../captcha/captcha-retry.js";
import { dispatchWithConnectRetry } from "./http-io.js";

// Lazy, runtime-gated module load (exception to the static-import rule, same
// as handler.ts): pulling captcha.ts eagerly drags in the happy-dom solver, so
// only start-plan — the one plan whose upstream is captcha-gated — pays for it.
type CaptchaModule = CaptchaModuleLike;
let captchaModule: CaptchaModule | null = null;
async function loadCaptcha(): Promise<CaptchaModule> {
  if (!captchaModule) captchaModule = await import("../captcha/captcha.js");
  return captchaModule;
}
import { getDefaultEndpointRouting, type EndpointRoutingService } from "./endpoint-routing.js";
import { getDefaultClientSigning, sendWithClientSigning, type ClientSigningManager } from "./client-signing.js";
import { inferSessionFingerprint, resolveSessionContext, sessionIdForHeader } from "./session-context.js";
import {
  applyHighspeedCardHeaders,
  highspeedAuthFrom,
  isHighspeedFailure,
  type HighspeedAuth,
  type HighspeedCard,
} from "../highspeed/manager.js";
import { getDefaultHighspeedSlots, type HighspeedSlots } from "../highspeed/slots.js";
import { getRouteSpec } from "../accounts/routes.js";
import { buildAnthropicMetadataUserId } from "./trace-headers.js";
import { credentialString } from "../auth/types.js";
import { checkSurface, llmSurfaceFor } from "../auth/capabilities.js";
import { translateRequestOpenAIToAnthropic, translateResponseAnthropicToOpenAI } from "../translator/openai-to-anthropic.js";
import { anthropicSseToOpenaiSse, AnthropicStreamError } from "../translator/sse-translator.js";
import type { AnthropicMessagesRequest, AnthropicMessagesResponse, AnthropicUsage } from "../translator/types.js";
import {
  responsesToChatCompletions,
  ToolTranslationError,
} from "../translator/responses-to-chat.js";
import {
  chatCompletionsToResponses,
  chatChunkToResponsesEvents,
  finalizeResponsesStream,
  failResponsesStream,
  newResponsesStreamState,
  responsesEventToSse,
} from "../translator/chat-to-responses.js";
import {
  generateResponsesId,
  type ResponsesInputItem,
  type ResponsesRequest,
  type ResponsesResponse,
  type ResponsesStreamEvent,
  type ResponsesOutputItem,
} from "../translator/responses-types.js";
import { ResponseStore, type StoredResponse } from "../responses/store.js";
import { logger } from "../log/index.js";
import { errorResponse, readBody, retryAfterHeader, InflatedBodyTooLargeError } from "./http-io.js";
import { injectDefaultModelIntoRequest } from "./default-model.js";
import { addStage, failStage, getDefaultRequestStore, markClientAborted, markZeroOutput, nextReqId, noteUpstreamAttempt, noteErrorCode } from "./request-record.js";
import { reasoningEffortFromBody } from "./reasoning-effort.js";
import type { RequestRecord, RequestStore } from "./request-record.js";
import { errorCodeOfUpstreamEvent } from "./error-codes.js";
import type { ErrorCode } from "./error-codes.js";
import { classifyClientKind } from "./client-kind.js";
import { observeAnthropicUsage, observeStream, printRow } from "./handler-log.js";
// 统一观测点。/v1/responses 的出线与 handler.ts 同一套观测：响应层
// 全状态码、connect 失败、流层信号（error 帧/空流/流中断）全部汇入 observeUpstream。
import { observeUpstream } from "./upstream-error.js";
import type { UpstreamEvent } from "./upstream-error.js";
import { upstreamBizCode } from "../accounts/signals.js";

/**
 * `/v1/responses` 的日志。
 *
 * 阶段时间线不走 logger：与 `handler.ts` 同一套纪律，阶段落在
 * `RequestRecord.stages` 上，终端表格与面板请求事件读的是同一条记录。留下来的
 * logger 调用只负责**系统**事件（凭据闸门拒绝、captcha 求解失败、端点改写），
 * 那些不是「这一次请求走到了哪一步」。
 */
const log = logger("responses");

/** 事件形态失败的产生点身份（与 handler.ts 同一张表，见 error-codes.ts）。*/
const CONNECT_FAILED_CODE = errorCodeOfUpstreamEvent("connect-failed");
const CAPTCHA_FAILED_CODE: ErrorCode = "other";
const TRANSLATE_FAILED_CODE: ErrorCode = "translate-failed";

export interface ResponsesHandlerOptions {
  config: ProxyConfig;
  /** 唯一出线口：按 `(account, route)` 解析凭据与路由。*/
  broker: Broker;
  /** Response store; if absent, `previous_response_id` always 404s. */
  responseStore?: ResponseStore;
  /** DI seam for tests. */
  fetchImpl?: typeof fetch;
  /** Verbose per-request diagnostics. */
  debug?: boolean;
  /** Override the process-wide endpoint routing service (for testing). `null` disables. */
  endpointRouting?: EndpointRoutingService | null;
  /** Override the process-wide client signing manager (for testing). `null` disables. */
  clientSigning?: ClientSigningManager | null;
  /** Override the process-wide per-account highspeed card slots (for testing). `null` disables. */
  highspeed?: HighspeedSlots | null;
  /** Override the lazily-imported captcha module (for testing). */
  captcha?: CaptchaModule;
  /**
   * 请求记录的持有者。缺省用进程级实例：理由与 `handler.ts` 相同，
   * 「忘了传」不该变成静默丢记录。
   */
  requests?: RequestStore;
  /** 这次请求归因到哪条 key。缺省 = 没有归因（会话 Cookie 或表空放行）。*/
  apiKeyId?: string;
}

/** Handle POST /v1/responses. */
export async function handleResponses(
  clientReq: Request,
  opts: ResponsesHandlerOptions,
): Promise<Response> {
  // 租约释放挂在响应体上（同 proxy/handler.ts）：续轮与流式输出期间槽位必须
  // 一直被占着。内层登记租约，外层负责收尾，避免几十个 return 各写一遍释放。
  const leaseSlot: { current: Lease | null } = { current: null };
  // 记录与 reqId 同寿。reqId 从这一个口出（三条协议共用同一个计数器，终端
  // 与面板上的时序才一致）。这条链路没有换号重放，一次请求天然就是一条记录；
  // Responses 是 OpenAI 家族协议，format 记 "openai"。
  const requests = opts.requests ?? getDefaultRequestStore();
  const reqId = nextReqId();
  const record = requests.begin({ reqId, format: "openai", apiKeyId: opts.apiKeyId ?? "" });
  // 客户端归类只看请求头（见 client-kind.ts），在读 body 之前就落。
  record.clientKind = classifyClientKind(clientReq.headers);
  // 落盘时机槽（同 handler.ts）：流式出口由 observeStream 的流收尾 finalize。
  const persistSlot: { deferred: boolean } = { deferred: false };
  try {
    const resp = await handleResponsesOnLease(clientReq, opts, leaseSlot, record, persistSlot);
    const lease = leaseSlot.current;
    return lease ? await withLeaseRelease(resp, lease.release, clientReq.signal) : resp;
  } catch (err) {
    leaseSlot.current?.release();
    // 逃出内层的异常没有阶段可归（内层的失败路径都已 failStage）：记在 handler 上，
    // 与 handler.ts 同款，否则这条记录会是一个没有原因的失败。
    if (record.failedStage === undefined) failStage(record, "handler", (err as Error).message, "other");
    throw err;
  } finally {
    record.endedAt = Date.now();
    // 流式请求的 totalMs 之后会被 observeStream 改成流的真实时长（这里只能算到
    // 「响应已经交回客户端」为止），批量请求它就是最终值。
    record.totalMs = record.endedAt - record.startedAt;
    // 客户端已断开 = 客户端自己放弃（与 handler.ts 同款；流式输出中途的断开
    // 由 observeStream 用同一个 signal 补判）。
    if (clientReq.signal.aborted) markClientAborted(record);
    // 实时通知（面板 SSE）照旧；落盘非流式在这里、流式在流收尾（同 handler.ts）。
    requests.notify(record);
    if (!persistSlot.deferred) requests.finalize(record);
  }
}

async function handleResponsesOnLease(
  clientReq: Request,
  opts: ResponsesHandlerOptions,
  leaseSlot: { current: Lease | null },
  record: RequestRecord,
  /** 流式出口置 `deferred`，落盘延到流收尾（见 handleResponses 的 finally）。*/
  persistSlot?: { deferred: boolean },
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const reqId = record.reqId;
  // 流式出口的落盘收尾（onFinal → finalize）要同一个仓实例（同 handler.ts）。
  const requests = opts.requests ?? getDefaultRequestStore();

  /**
   * 非流式收尾（同 handler.ts 的 reportEnd）：结果字段 + 表格行。
   *
   * 这条链路的终止出口有十几条，逐条后补一行「填记录 + 打行」迟早漏掉一条，合成
   * 一个函数只有一处实现。流式出口不走这里：它的收尾（TTFB / token / tps /
   * stream-end 阶段）由 `observeStream` 做。
   */
  const reportEnd = (
    status: number,
    headersAt: number,
    outputTokens = 0,
    inputTokens = 0,
    failure?: { stage: string; error: string; code?: ErrorCode },
    /** 缓存桶，在场即有效（undefined = 上游没报；0 = 明报 0 命中）。*/
    cacheReadTokens?: number,
    cacheCreationTokens?: number,
  ): void => {
    record.status = status;
    record.ttfbMs = headersAt - record.startedAt;
    if (outputTokens > 0) record.outputTokens = outputTokens;
    if (inputTokens > 0) record.inputTokens = inputTokens;
    if (cacheReadTokens !== undefined) record.cacheReadTokens = cacheReadTokens;
    if (cacheCreationTokens !== undefined) record.cacheCreationTokens = cacheCreationTokens;
    if (failure) failStage(record, failure.stage, failure.error, failure.code);
    printRow(record);
  };

  // ── 1. parse body ──
  let rawBody: string;
  try {
    rawBody = (await readBody(clientReq)) ?? "";
  } catch (err) {
    // 这两个出口不打表格行（同 handler.ts 的 intake 出口：连 body 都没读成，没有
    // 可展示的请求），但记录上要能看出它停在这里。
    record.status = err instanceof InflatedBodyTooLargeError ? 413 : 400;
    failStage(record, "intake", (err as Error).message, "other");
    if (err instanceof InflatedBodyTooLargeError) {
      return errorResponse(413, "request_too_large", err.message, undefined, "other");
    }
    return errorResponse(400, "invalid_request", `could not read request body: ${(err as Error).message}`, undefined, "other");
  }
  let req: ResponsesRequest;
  try {
    req = JSON.parse(rawBody) as ResponsesRequest;
  } catch (err) {
    record.status = 400;
    failStage(record, "intake", `request body is not valid JSON: ${(err as Error).message}`, "other");
    return errorResponse(400, "invalid_request", `request body is not valid JSON: ${(err as Error).message}`, undefined, "other");
  }
  if (!req || typeof req !== "object" || Array.isArray(req)) {
    record.status = 400;
    failStage(record, "intake", "request body must be an object", "other");
    return errorResponse(400, "invalid_request", "request body must be an object", undefined, "other");
  }
  if (typeof req.input !== "string" && !Array.isArray(req.input)) {
    record.status = 400;
    failStage(record, "intake", "`input` must be a string or an array", "other");
    return errorResponse(400, "invalid_request", "`input` must be a string or an array", undefined, "other");
  }
  // ── 默认模型注入（config.defaultModel 接进主链路）──────────────────────────
  // 与 handler.ts 同一条语义（见 proxy/default-model.ts 文件头）：`model` 没带
  // 且 `config.defaultModel` 非空时补上。注入在下面的 model 必填校验与能力
  // 过滤之前 —— 注入后这里就不再对带 default 的请求报 400，注入值同样接受调度
  // 过滤（不特判）；显式 model 一个字节不动；config 空串维持现状（400 不变）。
  const modelInjected = injectDefaultModelIntoRequest(req, opts.config);
  if (typeof req.model !== "string" || req.model.length === 0) {
    record.status = 400;
    failStage(record, "intake", "`model` is required", "other");
    return errorResponse(400, "invalid_request", "`model` is required", undefined, "other");
  }

  const stream = req.stream === true;

  // 入站形状 + 阶段 intake：与 handler.ts 同字段。时间线的第一条，也是排查「包
  // 有没有被读坏」的基准；`bytes` 是读入的原始字节数（改写前），后面的 `body`
  // 阶段报的是改写后的字节数。
  // ── 显式路由头（X-ZCode-Route）──
  // 同 handler.ts：解析在 intake 之前（阶段要记它），非法值直接 400 不进调度。
  let explicitRoute: RouteKind | undefined;
  try {
    explicitRoute = requestedRoute(clientReq);
  } catch (err) {
    if (err instanceof RouteUnknownError) {
      record.status = 400;
      failStage(record, "intake", err.message, "other");
      return errorResponse(400, "route_unknown", err.message, undefined, "other");
    }
    throw err;
  }
  record.model = req.model;
  record.stream = stream;
  record.requestBytes = rawBody.length;
  // 推理强度读**客户端原始的 Responses 形状**（`reasoning.effort`），不读下面
  // 翻译出来的 chat 请求——记录口径是「客户端要了什么」，见 `reasoning-effort.ts`。
  const reasoningEffort = reasoningEffortFromBody(req);
  if (reasoningEffort !== undefined) record.reasoningEffort = reasoningEffort;
  // 推理强度覆盖。resolve 一次两处共用（真源 effort-override.ts）：intake 落
  // 档位 + 下面 transformRequestBody 改写。这条路由的出线 body 在本函数里组装
  // （不经过 handler.ts），所以接线必须在这里——漏了它 Responses 路径就静默透传。
  const effortOverride = resolveEffortOverride(opts.config, record.model);
  if (effortOverride !== undefined) record.reasoningEffortOverride = effortOverride;
  if (modelInjected) record.modelInjected = true;
  addStage(record, "intake", {
    format: "openai",
    model: record.model,
    stream: record.stream,
    bytes: record.requestBytes,
    clientKind: record.clientKind,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(record.reasoningEffortOverride !== undefined
      ? { reasoningEffortOverride: record.reasoningEffortOverride }
      : {}),
    ...(modelInjected ? { modelInjected: true } : {}),
    ...(explicitRoute !== undefined ? { route: explicitRoute } : {}),
  });

  // ── 2. resolve previous_response_id ──
  let historyItems: ResponsesInputItem[] = [];
  let prevId: string | undefined;
  // 续轮钉号（Responses 特例）：`previous_response_id` 是**状态化**的，产出它的
  // `(account, route)` 就是唯一能接上上游上下文的那个。这里只把"去哪"记下来，
  // 真正的钉住在下面 acquire 时生效（绕过候选集）。
  let continuation: { accountId: string; routeKind: RouteKind } | undefined;
  if (typeof req.previous_response_id === "string" && req.previous_response_id.length > 0) {
    if (!opts.responseStore) {
      record.status = 404;
      failStage(record, "intake", "`previous_response_id` was supplied but the response store is not configured", "other");
      return errorResponse(404, "response_store_disabled", "`previous_response_id` was supplied but the response store is not configured", undefined, "other");
    }
    const prev = opts.responseStore.get(req.previous_response_id);
    if (!prev) {
      record.status = 404;
      failStage(record, "intake", `previous_response_id ${req.previous_response_id} not found`, "other");
      return errorResponse(404, "response_not_found", `previous_response_id ${req.previous_response_id} not found (response store is in-memory; entries are lost on restart and after the TTL)`, undefined, "other");
    }
    prevId = req.previous_response_id;
    historyItems = [...prev.input, ...outputItemsAsInputItems(prev.output)];
    continuation = { accountId: prev.accountId, routeKind: prev.routeKind };
  }

  // ── 3. translate Responses → Chat Completions ──
  const input: ResponsesInputItem[] = typeof req.input === "string"
    ? [...historyItems, { type: "message", role: "user", content: req.input }]
    : [...historyItems, ...req.input];
  const reqWithHistory: ResponsesRequest = {
    ...req,
    input,
  };
  let translated;
  try {
    translated = responsesToChatCompletions(reqWithHistory);
  } catch (err) {
    if (err instanceof ToolTranslationError) {
      record.status = 400;
      failStage(record, "translate", err.message, TRANSLATE_FAILED_CODE);
      return errorResponse(400, "tool_translation_error", err.message, undefined, TRANSLATE_FAILED_CODE);
    }
    throw err;
  }
  const { chatRequest, customToolNames, namespaceMap, hasToolSearch } = translated;

  // ── 4. translate Chat → Anthropic + infer the session identity ──
  // 与 handler.ts 同一条纪律：会话推断的输入是**规范形状**（恒为
  // Anthropic），不依赖路由，所以它和归一都排在路由选择**之前**。此刻还没做
  // system prompt 注入 / model 改写（那些在 acquire 之后）。顺序：解析 → 推断
  // sessionId → 路由选择 → 改写 → 发出。
  const CANONICAL_UPSTREAM_FORMAT: "anthropic" = "anthropic";
  let anthropicReq: AnthropicMessagesRequest;
  try {
    anthropicReq = translateRequestOpenAIToAnthropic(chatRequest);
  } catch (err) {
    record.status = 400;
    failStage(record, "translate", `Chat→Anthropic translation failed: ${(err as Error).message}`, TRANSLATE_FAILED_CODE);
    return errorResponse(400, "translation_failed", `Chat→Anthropic translation failed: ${(err as Error).message}`, undefined, TRANSLATE_FAILED_CODE);
  }
  const anthropicBody = JSON.stringify(anthropicReq);
  // Session affinity 收口（2026-10-14，与 handler.ts 同构）：在转换后的
  // anthropic 侧计算，同一逻辑对话与 /v1/messages 得到同构的会话身份，
  // trace 头、metadata.user_id 与 highspeed task_id 共用该结果。
  //
  // 选号与 sessionId 分两段（同 handler.ts）：先算账号无关的粘性键，拿到租约后
  // 才 `finalize` 出带账号种子的 sessionId（一账号一命名空间）。
  const sessionFingerprint = inferSessionFingerprint({ clientReq, body: anthropicBody, traceBody: rawBody, upstreamFormat: CANONICAL_UPSTREAM_FORMAT, model: req.model, config: opts.config });

  // ── 5. route resolution (account + route) ──
  // 同 handler.ts：凭据与路由来自 broker.acquire()，不是进程级的
  // config.provider / config.plan。queueMs 是 acquire 的耗时。
  // 续轮：`pinnedAccountId` + `pinnedRoute` **绕过候选集直接钉住**，不走
  // 粘性也不走策略：续轮的上游上下文只存在于那个账号上。钉住的账号不存在 / 已删除
  // 时 broker 报 `account-unknown`（503，明确错误），**不静默改道**。
  // X-ZCode-Route：显式路由头，语义同 handler.ts（`requestedRoute`）。续轮
  // 钉号优先：previous_response_id 把 (account, route) 成对钉住，显式头此时被忽略
  // ——分支顺序即优先级。这不算静默丢失：续轮换档等于丢上游上下文，是协议事实，
  // 不是「指定了但没生效」的那种被否决的语义。
  const acquireStartedAt = Date.now();
  const acquired = await acquireLease(opts.broker, {
    model: req.model,
    sessionId: sessionFingerprint?.stickyKey,
    ...(continuation !== undefined
      ? { pinnedAccountId: continuation.accountId, pinnedRoute: continuation.routeKind }
      : { pinnedRoute: explicitRoute }),
    signal: clientReq.signal,
  });
  if (!acquired.ok) {
    log.error("error", { reqId, kind: acquired.type, message: acquired.message, stage: "dispatch" });
    reportEnd(acquired.status, Date.now(), 0, 0, { stage: "dispatch", error: acquired.message, code: acquired.errorCode });
    return errorResponse(acquired.status, acquired.type, acquired.message, retryAfterHeader(acquired.retryAfterSeconds), acquired.errorCode);
  }
  const lease = acquired.lease;
  leaseSlot.current = lease;
  // 阶段 dispatch：谁出线、走哪条路由、在队列里等了多久（与 handler.ts 同字段）。
  const queueMs = Date.now() - acquireStartedAt;
  record.account = lease.account.label;
  record.route = lease.route;
  record.queueMs = queueMs;
  addStage(record, "dispatch", { account: record.account, route: record.route, queueMs });
  const clientSession = resolveSessionContext({ accountId: lease.account.id, clientReq, body: anthropicBody, traceBody: rawBody, upstreamFormat: CANONICAL_UPSTREAM_FORMAT, model: req.model, config: opts.config, fingerprint: sessionFingerprint });
  // 阶段 session：会话身份从哪来、有多确定。`source=none` 是合法结果，
  // 它意味着这条请求不参与粘性，不是推断失败。
  addStage(record, "session", {
    sessionId: clientSession?.sessionId ?? "-",
    source: clientSession?.source ?? "none",
    confidence: clientSession?.confidence ?? 0,
  });
  const route: RouteKind = lease.route;
  // 产出这条响应的 `(account, route)`：随响应一起入库，供下一条
  // `previous_response_id` 钉号（Responses 特例）。
  const origin = { accountId: lease.account.id, routeKind: route };
  const cred = toAuthCredential(lease.credential);
  // Same gate as handler.ts (auth/capabilities.ts): fail here with the missing
  // half instead of sending an empty credential upstream. Which requirement
  // applies is a route fact (`llmSurfaceFor`).
  const credentialCheck = checkSurface(llmSurfaceFor(route), cred, route);
  if (!credentialCheck.ok) {
    log.error("error", { reqId, kind: "credential_incomplete", message: credentialCheck.message, stage: "route-facts" });
    reportEnd(503, Date.now(), 0, 0, { stage: "route-facts", error: credentialCheck.message, code: "auth-invalid" });
    return errorResponse(503, "credential_unavailable", credentialCheck.message, undefined, "auth-invalid");
  }
  const providerFamily = cred.provider;
  const baseUrl = routeUpstreamBaseUrl(route, providerFamily, opts.config.providers);

  // ── 6. 路由事实 + body transform ──
  // `layers` 是叠加层的唯一真源（与 handler.ts 同构）。
  const spec = getRouteSpec(route);
  const layers = spec.layers;
  //
  // 出线协议恒为 Anthropic（只剩一种 `apiType`）：Responses 入站已经在上面
  // 转成 Chat，再翻 Chat→Anthropic 出线（Responses → 先转 chat 再出线），
  // 回程再归一成 Chat 供下游 Responses 翻译器消费。
  const outboundBody = anthropicBody;
  // 阶段 route-facts：这条路由穿了哪几层（与 handler.ts 同字段）。四个布尔值就是
  // 叠加层的全部开关，它们与「route 是什么」分开登记。
  record.upstreamFormat = CANONICAL_UPSTREAM_FORMAT;
  addStage(record, "route-facts", {
    upstreamFormat: CANONICAL_UPSTREAM_FORMAT,
    impersonation: layers.impersonation,
    signing: layers.signing,
    captcha: layers.captcha,
    highspeed: layers.highspeed,
  });
  // userId mirrors handler.ts: the bundle's `E2e` is provider-kind gated only
  // (never plan-gated) — but it belongs to the impersonation surface, so
  // `layers.impersonation` decides, and it is anthropic-only. `device_id` is the
  // leased account's own fingerprint, never a process-wide value.
  // `session_id` reads `sessionIdForHeader`, the same value the x-session-id
  // header carries (upstream derives both from one session id).
  const metadataUserId = layers.impersonation
    ? buildAnthropicMetadataUserId(accountDeviceMid(lease.account) ?? "", sessionIdForHeader(clientSession))
    : undefined;
  let transformedBody = transformRequestBody(outboundBody, {
    format: CANONICAL_UPSTREAM_FORMAT,
    metadataUserId,
    injectZcodeSystem: spec.injectsZcodeSystemPrompt,
    provider: providerFamily,
    // 命中才传（undefined = 透传），见 intake 段 resolve 点的注释。
    ...(effortOverride !== undefined ? { effortOverride } : {}),
  }) ?? outboundBody;
  // 阶段 body：改写后的字节数与 system prompt 注入开关（与 handler.ts 同字段）。
  const transformBytes = transformedBody?.length ?? 0;
  addStage(record, "body", { transformBytes, injectZcodeSystem: spec.injectsZcodeSystemPrompt });

  // ── HighSpeed 加速卡（官方形态，与 handler.ts 同构）──
  // 命中卡 = 把出线路由从 coding-plan 切到 highspeed（**不改写**
  // body 的 model），鉴权用账号身份，卡槽按账号取。挂卡请求永不签名（官方静态规则）。
  const highspeedSlots = opts.highspeed !== undefined ? opts.highspeed : getDefaultHighspeedSlots(opts.config);
  const highspeedManager = highspeedSlots ? highspeedSlots.forAccount(lease.account) : null;
  const highspeedEligible = highspeedManager !== null
    && layers.highspeed
    && highspeedManager.isEligibleModel(req.model)
    && transformedBody !== undefined;
  let highspeedCard: HighspeedCard | undefined;
  let highspeedAuth: HighspeedAuth | undefined;
  let highspeedOrigPairs: UpstreamHeaderPair[] | undefined;
  if (highspeedManager && highspeedEligible) {
    const hsAuth = highspeedAuthFrom(lease.account);
    if (hsAuth) {
      highspeedAuth = hsAuth;
      highspeedManager.onRequest(req.model, clientSession?.upstreamSessionId, hsAuth);
      const card = highspeedManager.activeCardFor(req.model);
      if (card) highspeedCard = card;
    }
  }
  // 挂卡出线基准地址：zcode.z.ai 网关下的 highspeed 派生入口。
  const highspeedBaseUrl = routeUpstreamBaseUrl("highspeed", providerFamily, opts.config.providers);
  // 阶段 highspeed：挂没挂上卡。`applied=false` 也是信息（没抽到卡 / 模型不合格 /
  // 卡过期），缺了它就无法区分「本来就没卡」与「挂卡逻辑没跑到」（与 handler.ts 同字段）。
  addStage(record, "highspeed", { cardId: highspeedCard?.cardId ?? "-", applied: highspeedCard !== undefined });

  // ── 6. POST upstream ──
  // start-plan gates every upstream call behind an Aliyun captcha token. The
  // Anthropic/OpenAI routes mint one in handler.ts; /v1/responses did not, so
  // start-plan users got {"code":3007,"msg":"captcha verify failed"} surfaced
  // as HTTP 400 upstream_error on every request. `layers.captcha` is the switch
  // (only start-plan sets it).
  let captchaHeaders: Record<string, string> | undefined;
  if (layers.captcha) {
    // 与 handler.ts 同款严格获取：裸发 captcha-less 会被
    // start-plane 边缘空体 502 间歇拦截；null=服务端明示禁用（无头即正确形态），
    // throw=有界重试（CAPTCHA_ACQUIRE_BUDGET_MS，默认 45s）后诚实 503。
    try {
      captchaHeaders = await acquireCaptchaWithRetry(async () => {
        const captcha = opts.captcha ?? (await loadCaptcha());
        const token = await captcha.getCaptchaToken(opts.config.identity.appVersion, lease.account.id);
        return token ? { [captcha.RETRY_HEADERS.PARAM]: token.verifyParam, [captcha.RETRY_HEADERS.REGION]: token.region } : undefined;
      }, {
        budgetMs: resolveCaptchaAcquireBudgetMs(process.env.CAPTCHA_ACQUIRE_BUDGET_MS),
        signal: clientReq.signal,
      });
    } catch (err) {
      log.error("error", { reqId, kind: "captcha_solver_failed", message: (err as Error).message, stage: "captcha" });
      reportEnd(503, Date.now(), 0, 0, { stage: "captcha", error: (err as Error).message, code: CAPTCHA_FAILED_CODE });
      return errorResponse(503, "captcha_solver_failed", `Captcha acquisition failed: ${(err as Error).message}. The start-plan edge rejects captcha-less requests — retry shortly.`, undefined, CAPTCHA_FAILED_CODE);
    }
  }
  // 在飞即活动（同 handler.ts）：流结束/请求完成刷新
  // captcha 池与 highspeed 抽卡循环的空闲窗；SSE 输出中不算空闲。highspeed 侧
  // 仅对合格请求记账（与上面 onRequest 同门），防止不合格流量空转抽卡循环。
  // Only requests that actually entered onRequest may extend its auth's loop.
  const hsNoteEligible = highspeedAuth !== undefined;
  const noteInFlightEnded = (): void => {
    if (layers.captcha) void (opts.captcha ? Promise.resolve(opts.captcha) : loadCaptcha()).then((m) => m.noteDemand?.(lease.account.id)).catch(() => {});
    if (hsNoteEligible) highspeedManager?.noteActivity();
  };

  const upstreamHeaders = buildUpstreamHeaderPairs(clientReq, cred, opts.config.identity, route, captchaHeaders, clientSession);
  let wireHeaders = upstreamHeaders;
  if (highspeedCard && highspeedAuth) {
    highspeedOrigPairs = upstreamHeaders;
    wireHeaders = applyHighspeedCardHeaders(upstreamHeaders, highspeedCard, highspeedAuth);
  }
  const upstreamReq = buildUpstreamRequest(clientReq, highspeedCard ? highspeedBaseUrl : baseUrl, cred, transformedBody, opts.config.identity, route, captchaHeaders, clientSession);

  const routing = opts.endpointRouting !== undefined ? opts.endpointRouting : getDefaultEndpointRouting(opts.config, lease.egress);
  /**
   * 签名的唯一判定点（与 handler.ts 同构）：`layers.signing` 为假时恒为 null。
   * 官方 3.15.1 `TUs` 静态规则：highspeed 挂卡也不签。
   */
  const routeSigner = (): ClientSigningManager | null => {
    if (!layers.signing) return null;
    return opts.clientSigning !== undefined ? opts.clientSigning : getDefaultClientSigning(opts.config);
  };
  let signer = highspeedCard ? null : routeSigner();
  // 阶段 upstream-req：即将发出的那一次（与 handler.ts 同字段）。`url` 是路由**前**
  // 的地址，`signed` 说明签名层有没有参与。头只报**数量**：值里有凭据。
  record.upstreamUrl = upstreamReq.url;
  record.headerCount = wireHeaders.length;
  record.signed = signer !== null;
  addStage(record, "upstream-req", { url: record.upstreamUrl, headerCount: record.headerCount, signed: record.signed });
  // URL 也走参数：退回时同一条 dispatch 必须换成 coding-plan 的地址。
  const dispatch = async (pairs: UpstreamHeaderPair[], url: string = upstreamReq.url): Promise<Response> => {
    // 每次 `dispatch()` 就是一次上游出线（同 handler.ts）——连接重试、加速卡
    // 退回、captcha 重试都经这里。
    noteUpstreamAttempt(record);
    const routed = routing ? await routing.resolve(url, credentialString(cred), cred.jwt, lease.egress) : null;
    const sendUrl = routed?.routed ? routed.url : url;
    const routingHeaderPairs = routed?.headers
      ? (Object.entries(routed.headers) as UpstreamHeaderPair[])
      : undefined;
    if (routed?.routed) log.debug("endpoint routed", { reqId, from: url, to: sendUrl });
    // signing decisions run against the PRE-routing provider URL (mirrors the
    // client, whose signer wraps the routing transport)
    return sendWithClientSigning(signer, {
      url: upstreamReq.url,
      headerPairs: pairs,
      credential: credentialString(cred),
      oauthAccessToken: cred.oauthAccessToken,
      provider: cred.provider,
      appVersion: opts.config.identity.appVersion,
      // 握手也是一次出线，与上面推理请求同一个出口。
      egress: lease.egress,
      debug: (message) => log.debug(message, { reqId }),
      send: (finalPairs) => {
        // 3.16.2 X-ZCode-Authorization rides after the signature block (the
        // client's routing wrapper sits inside its signing wrapper) — last on
        // the wire, same as handler.ts.
        const outboundPairs = routingHeaderPairs ? [...finalPairs, ...routingHeaderPairs] : finalPairs;
        const req = new Request(sendUrl, {
          method: "POST",
          headers: Object.fromEntries(outboundPairs),
          body: transformedBody ?? undefined,
        });
        // 出口代理跟着租约走：Responses 推理也是一次上游出线，
        // 漏了这一处就等于这个协议从本机 IP 出去。
        return fetchWithEgress(fetchImpl, req, { method: "POST", headers: Object.fromEntries(outboundPairs), body: transformedBody ?? undefined, signal: clientReq.signal }, lease.egress);
      },
    });
  };

  let upstreamResp: Response;
  try {
    // Connect-retry ladder mirrors the chat hot path (handler.ts): 3 attempts,
    // fresh Request per dispatch (built inside `dispatch`), 500ms×attempt
    // backoff, no retry once the client aborted.
    upstreamResp = await dispatchWithConnectRetry(() => dispatch(wireHeaders), {
      isAborted: () => clientReq.signal.aborted,
    });
  } catch (err) {
    // connect 失败 → gateway 信号进路由级熔断 streak（不冷却账号）。
    if (!clientReq.signal.aborted) {
      await observeUpstream(opts.broker, lease, { type: "connect-failed", detail: (err as Error).message });
    }
    reportEnd(502, Date.now(), 0, 0, { stage: "upstream-req", error: (err as Error).message, code: CONNECT_FAILED_CODE });
    return errorResponse(502, "upstream_unreachable", (err as Error).message, undefined, CONNECT_FAILED_CODE);
  }

  const headersAt = Date.now();
  // 阶段 upstream-resp：首字节到达（TTFB）。`contentEncoding` 是上游选的压缩
  // （与 handler.ts 同字段）。
  record.status = upstreamResp.status;
  record.ttfbMs = headersAt - record.startedAt;
  record.contentEncoding = upstreamResp.headers.get("content-encoding") ?? "identity";
  addStage(record, "upstream-resp", {
    status: record.status,
    ttfbMs: record.ttfbMs,
    contentEncoding: record.contentEncoding,
  });

  // ── highspeed 失败退回（与 handler.ts 同构）──
  // 任何加速请求失败（3402 卡过期 / 401 / 5xx / …）→ 弃卡 + 切回 coding-plan
  // 路由重发一次，模型保持客户端原值（我们从来没改过它），并恢复签名。
  if (highspeedCard && highspeedOrigPairs !== undefined
    && await isHighspeedFailure(upstreamResp)) {
    // 阶段 retry：挂卡失败退回 coding-plan（与 handler.ts 同字段）。`retries` 不在
    // 这里加：账号没换，只是换了路由。
    addStage(record, "retry", {
      event: "highspeed-fallback",
      reason: "highspeed-fallback",
      nextAccount: lease.account.label,
      nextRoute: route,
    });
    highspeedManager?.dropCard(`upstream_failed_${upstreamResp.status}`);
    signer = routeSigner();
    const retryPairs = highspeedOrigPairs;
    try {
      upstreamResp = await dispatchWithConnectRetry(() => dispatch(retryPairs, buildUpstreamURL(baseUrl)), {
        isAborted: () => clientReq.signal.aborted,
      });
    } catch (err) {
      // 同主 dispatch 的 catch（gateway streak，不冷却账号）。
      if (!clientReq.signal.aborted) {
        await observeUpstream(opts.broker, lease, { type: "connect-failed", detail: (err as Error).message });
      }
      reportEnd(502, Date.now(), 0, 0, { stage: "upstream-req", error: (err as Error).message, code: CONNECT_FAILED_CODE });
      return errorResponse(502, "upstream_unreachable", (err as Error).message, undefined, CONNECT_FAILED_CODE);
    }
  }

  // Captcha challenge retry (mirrors handler.ts via the shared captcha-retry
  // seam): the gateway signals it either through the captcha response header
  // or as HTTP 400 with {"code":3007} in the body. The challenged token is
  // already spent, so retry once with a fresh pooled one.
  if (layers.captcha && !upstreamResp.ok) {
    const captcha = opts.captcha ?? (await loadCaptcha());
    if (await isCaptchaChallenged(upstreamResp, captcha)) {
      log.debug("captcha challenge, re-solving once", { reqId });
      const outcome = await retryOnCaptchaChallenge({
        captcha,
        appVersion: opts.config.identity.appVersion,
        accountId: lease.account.id,
        challengedResp: upstreamResp,
        debug: (message) => log.debug(message, { reqId }),
        solveAndRetry: (retryHeaders) => dispatch(
          buildUpstreamHeaderPairs(clientReq, cred, opts.config.identity, route, retryHeaders, clientSession),
        ),
        mapError: (err, phase) => {
          if (phase === "solver") {
            reportEnd(503, Date.now(), 0, 0, { stage: "captcha", error: err.message, code: CAPTCHA_FAILED_CODE });
            return errorResponse(503, "captcha_solver_failed", err.message, undefined, CAPTCHA_FAILED_CODE);
          }
          // 重试出线的 connect 失败同款进 gateway streak（fire-and-forget：
          // mapError 是同步契约，观测不挡错误响应的返回）。
          if (!clientReq.signal.aborted) {
            void observeUpstream(opts.broker, lease, { type: "connect-failed", detail: err.message }).catch(() => {});
          }
          reportEnd(502, Date.now(), 0, 0, { stage: "upstream-req", error: err.message, code: CONNECT_FAILED_CODE });
          return errorResponse(502, "upstream_unreachable", err.message, undefined, CONNECT_FAILED_CODE);
        },
      });
      if (!outcome.ok) return outcome.resp;
      upstreamResp = outcome.resp;
    }
  }

  // ── 统一观测点（与 handler.ts 同序：highspeed 弃卡 / captcha 重试之后、
  // 任何字节回写之前）：最终上游响应 → observeUpstream（全状态码 → 健康引擎）。──
  const observed = await observeUpstream(opts.broker, lease, upstreamResp);
  /** 本次出线的统一身份（三出口同源，与 handler.ts 同款）。*/
  const responseCode = observed.errorCode ?? "upstream-error";
  /**
   * 流式出口的失败信号（error 帧 / 空流 / 流中断）异步到达时补 errorCode。
   * 记录已由 `observeStream` 落过失败事实，这里用观察结果覆盖缺省的 `other`。
   */
  const streamSignal = (event: UpstreamEvent): void => {
    void observeUpstream(opts.broker, lease, event)
      .then((observation) => {
        if (observation.errorCode !== undefined && record.failedStage !== undefined) noteErrorCode(record, observation.errorCode);
      })
      .catch(() => {
        // 有意吞错：观测失败不影响请求本身（旁路语义）。
      });
  };

  // 上面两处（highspeed 退回、captcha 重试）可能已经把 `upstreamResp` 换掉了。阶段里
  // 那一条 `upstream-resp` 保留第一次的样子（那是时间线上真实发生过的事），而记录的
  // 最终事实要跟上：表格行、直传的编码判定都读这里（与 handler.ts 同款）。
  record.status = upstreamResp.status;
  record.contentEncoding = upstreamResp.headers.get("content-encoding") ?? "identity";

  // 「流中断」分支：已经向客户端回写了字节的失败无法重放，只能当场
  // 作废这张卡（与 handler.ts 同款，交给 observeStream 的 onFailure）。
  const cardedStreamFailed = highspeedCard && highspeedManager
    ? (): void => highspeedManager.dropCard("stream_interrupted")
    : undefined;

  if (!upstreamResp.ok) {
    const errText = await upstreamResp.text().catch(() => "");
    // 错误响应体字节照样落（同 handler.ts 的 upstreamErrorPassthrough）。
    record.responseBytes = Buffer.byteLength(errText, "utf8");
    reportEnd(upstreamResp.status, headersAt, 0, 0, { stage: "upstream-resp", error: `upstream returned ${upstreamResp.status}`, code: responseCode });
    return errorResponse(upstreamResp.status, "upstream_error", errText.slice(0, 500) || `upstream returned ${upstreamResp.status}`, undefined, responseCode);
  }

  // normalize the Anthropic upstream response into the OpenAI Chat shape the
  // downstream Responses translators already consume (SSE + batch)
  // 上游 Anthropic usage 的缓存桶（在场即有效）。流式出口在 observeStream /
  // onUsage 钩子里落；批量出口在下面 else 分支里从解析后的响应 JSON 拿——翻译成
  // Chat/Responses 形状后 creation 桶就没了，必须在翻译前留住。
  let upstreamAnthropicUsage: AnthropicUsage | undefined;
  if (stream) {
    if (!upstreamResp.body) {
      reportEnd(502, headersAt, 0, 0, { stage: "upstream-resp", error: "upstream returned no body for stream", code: TRANSLATE_FAILED_CODE });
      return errorResponse(502, "translation_failed", "upstream returned no body for stream", undefined, TRANSLATE_FAILED_CODE);
    }
    // 统计旁路：把翻译后的流 tee 出一份给 `observeStream`，TTFB / token /
    // tps / stream-end 阶段全由它填（与 handler.ts 的流式出口同款）。客户端拿到的
    // 是另一份分支，字节与旧行为完全一致。Responses 的 SSE 里没有 keepalive 注释帧，
    // 「首块即首字节」在这里天然成立，不需要 async 那套过滤。
    // 同 handler.ts 的翻译流式出口——cache_creation 桶从翻译器的 Anthropic
    // 快照观察（OpenAI usage 装不下它），cache_read 由 StreamMetrics 从翻译流的
    // prompt_tokens_details 补一份（同值）。落盘延到流收尾（onFinal → finalize）。
    if (persistSlot) persistSlot.deferred = true;
    const [clientStream, statsStream] = anthropicSseToOpenaiSse(upstreamResp.body, req.model, observeAnthropicUsage(record)).tee();
    upstreamResp = new Response(clientStream, {
      status: upstreamResp.status,
      headers: { "content-type": "text/event-stream" },
    });
    // 流层信号（error 帧经 AnthropicStreamError / 空流 / 流中断）从 onSignal
    // 回 observeUpstream（与 handler.ts 的流式出口同款）。
    observeStream(record, statsStream, () => {
      noteInFlightEnded();
    }, cardedStreamFailed, () => requests.finalize(record), clientReq.signal, streamSignal);
  } else {
    const rawAnthropic = await upstreamResp.text();
    // 上游 Anthropic JSON 的字节数（解析前落，见 response-translation.ts::translatedBatchResponse）。
    record.responseBytes = Buffer.byteLength(rawAnthropic, "utf8");
    // ── 信封失败分流（与 response-translation.ts::translatedBatchResponse 的 envelopeFailure
    // 同一套分流）：业务码 → observeUpstream + 语义化 429（Retry-After=引擎 until）；
    // 无码非 Message → empty-stream 信号 + zeroOutput，维持 translation_failed 502。──
    const envelopeFailure = async (detail: string, translateError: string): Promise<Response> => {
      const bizCode = upstreamBizCode(rawAnthropic);
      if (bizCode !== undefined) {
        const observation = await observeUpstream(opts.broker, lease, { type: "biz-code", code: bizCode, detail });
        // invalid message 有码 → 观察结果的 errorCode（1005/1113 即
        // `upstream-quota-terminal`）；无码 → `translate-failed`。零字符串判定。
        const code = observation.errorCode ?? "upstream-error";
        const until = observation.health.until;
        const retryAfterSeconds = until === undefined ? undefined : Math.max(1, Math.ceil((until - Date.now()) / 1000));
        reportEnd(429, headersAt, 0, 0, {
          stage: "upstream-resp",
          error: `upstream business code ${String(bizCode)} (${observation.signal.kind})`,
          code,
        });
        return errorResponse(
          429,
          observation.signal.kind === "quota-terminal" ? "quota_exhausted" : "rate_limited",
          `upstream business code ${String(bizCode)}: ${detail}`,
          retryAfterSeconds !== undefined ? retryAfterHeader(retryAfterSeconds) : undefined,
          code,
        );
      }
      await observeUpstream(opts.broker, lease, { type: "empty-stream", detail });
      markZeroOutput(record);
      reportEnd(502, headersAt, 0, 0, { stage: "translate", error: translateError, code: TRANSLATE_FAILED_CODE });
      return errorResponse(502, "translation_failed", translateError, undefined, TRANSLATE_FAILED_CODE);
    };
    let parsedAnthropic: AnthropicMessagesResponse;
    try {
      parsedAnthropic = JSON.parse(rawAnthropic) as AnthropicMessagesResponse;
    } catch (err) {
      return await envelopeFailure(`non-JSON body: ${(err as Error).message}`,
        `upstream returned non-JSON body: ${(err as Error).message}`);
    }
    if (!isAnthropicMessagesResponse(parsedAnthropic)) {
      return await envelopeFailure(rawAnthropic.slice(0, 200),
        `upstream returned invalid Anthropic message: ${rawAnthropic.slice(0, 200)}`);
    }
    const openaiResp = translateResponseAnthropicToOpenAI(parsedAnthropic, req.model);
    upstreamAnthropicUsage = parsedAnthropic.usage;
    upstreamResp = new Response(JSON.stringify(openaiResp), {
      status: upstreamResp.status,
      headers: { "content-type": "application/json" },
    });
  }

  // ── 8. translate Chat → Responses ──
  const responseId = generateResponsesId();
  const meta = { customToolNames, namespaceMap, hasToolSearch };

  if (stream) {
    return streamResponse(upstreamResp, { reqId, responseId, model: req.model, meta, request: req, input, options: opts, origin, onStreamEnd: noteInFlightEnded });
  }

  const rawChatResp = await upstreamResp.text();
  let chatRespJson;
  try {
    chatRespJson = JSON.parse(rawChatResp);
  } catch (err) {
    reportEnd(502, headersAt, 0, 0, { stage: "translate", error: (err as Error).message, code: TRANSLATE_FAILED_CODE });
    return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`, undefined, TRANSLATE_FAILED_CODE);
  }
  const responsesResp = chatCompletionsToResponses(chatRespJson, req.model, {
    responseId,
    meta,
    ...(typeof req.instructions === "string" ? { instructions: req.instructions } : {}),
    ...(prevId ? { previousResponseId: prevId } : {}),
  });

  // ── 9. store the response (unless `store:false`) ──
  if (req.store !== false && opts.responseStore) {
    const stored = buildStoredResponse(responsesResp, input, req.instructions, origin);
    opts.responseStore.set(stored);
  }

  // 批量收尾：token 从翻译后的 OpenAI 形状读（上游是 Anthropic 的 usage，翻译层
  // 已经折算成 prompt/completion_tokens），表格行由 reportEnd 打；流式出口的表格行
  // 由 observeStream 打，这里不走它。
  const chatUsage = (chatRespJson as { usage?: { completion_tokens?: number; prompt_tokens?: number } }).usage;
  // 缓存桶从上游 Anthropic usage 直读（在场即有效）；OpenAI/Responses 的
  // usage 形状只有 cached_tokens（cache_read 折算），creation 桶只能在翻译前拿。
  reportEnd(200, headersAt, chatUsage?.completion_tokens ?? 0, chatUsage?.prompt_tokens ?? 0,
    undefined, upstreamAnthropicUsage?.cache_read_input_tokens, upstreamAnthropicUsage?.cache_creation_input_tokens);
  noteInFlightEnded();
  return new Response(JSON.stringify(responsesResp), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ─────────────────────────────────────────────
// Streaming response
// ─────────────────────────────────────────────

interface StreamResponseContext {
  /** 这次请求的 id：流式响应也要归到同一条时间线上（`stage=stream-end` 之类）。*/
  reqId: string;
  responseId: string;
  model: string;
  meta: { customToolNames: Set<string>; namespaceMap: Map<string, { namespace: string; name: string }>; hasToolSearch: boolean };
  request: ResponsesRequest;
  input: ResponsesInputItem[];
  options: ResponsesHandlerOptions;
  /** 产出这条响应的账号与路由（续轮钉号：下一条 `previous_response_id` 要用）。*/
  origin: { accountId: string; routeKind: RouteKind };
  /** Fired once when the client stream completes, errors, or is cancelled. */
  onStreamEnd?: () => void;
}

function streamResponse(upstreamResp: Response, context: StreamResponseContext): Response {
  if (!upstreamResp.body) {
    return errorResponse(502, "translation_failed", "upstream returned no body for stream", undefined, TRANSLATE_FAILED_CODE);
  }
  const state = newResponsesStreamState(context.model, { meta: context.meta, responseId: context.responseId });
  let onStreamEnded = false;
  const fireStreamEnd = (): void => {
    if (onStreamEnded) return;
    onStreamEnded = true;
    // 收尾回调（刷新 captcha 池 / 抽卡空闲窗）抛错不能反向污染已经写完的响应流：
    // 这里是有意的 fail-open，不记录日志是因为它在流关闭路径上，记日志本身会
    // 在客户端已断开时再碰一次 IO。
    try {
      context.onStreamEnd?.();
    } catch {
      /* 见上：收尾回调失败不影响已发出的字节 */
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (evt: ResponsesStreamEvent) => controller.enqueue(encoder.encode(responsesEventToSse(evt)));
      try {
        const reader = upstreamResp.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let errored = false;
        for (;;) {
          if (errored) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE chunks are separated by `\n\n`; process complete frames.
          let nl: number;
          while ((nl = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            const dataLine = extractSseData(frame);
            if (!dataLine || dataLine === "[DONE]") continue;
            try {
              const chunk = JSON.parse(dataLine);
              for (const evt of chatChunkToResponsesEvents(chunk, state)) send(evt);
            } catch (err) {
              errored = true;
              // Release the upstream reader too — without the cancel the
              // upstream connection lingers until GC. Fire-and-forget so a
              // slow cancel never delays the client-visible error. The
              // errored-flag + early-return semantics (anti-pattern #24) are
              // unchanged: no further reads, no finalize, no close().
              reader.cancel().catch(() => {});
              controller.error(err);
              return;
            }
          }
        }
        const finalEvents = finalizeResponsesStream(state);
        for (const evt of finalEvents) send(evt);
        const finalEvent = finalEvents.find((evt) => evt.type === "response.completed" || evt.type === "response.incomplete");
        if (finalEvent && context.request.store !== false && context.options.responseStore) {
          context.options.responseStore.set(buildStoredResponse(finalEvent.response, context.input, context.request.instructions, context.origin));
        }
        // `close()` 在客户端已取消时抛（controller 已失效），流已经结束，
        // 这个异常没有任何可做的事情。
        try {
          controller.close();
        } catch {
          /* 客户端已取消：流已终止，close 失败无副作用 */
        }
      } catch (err) {
        try {
          for (const evt of failResponsesStream(state, {
            code: err instanceof AnthropicStreamError ? err.code : "upstream_error",
            message: err instanceof Error ? err.message : String(err),
          })) send(evt);
          controller.close();
        } catch {
          // 连错误事件都发不出去（controller 已失效）：退一步直接 error，再失败就
          // 只能放弃，客户端已经不在了。
          try {
            controller.error(err);
          } catch {
            /* 见上：客户端已断开，无可通知对象 */
          }
        }
      } finally {
        fireStreamEnd();
      }
    },
    cancel(reason) {
      log.debug("stream cancelled", { reqId: context.reqId, reason: String(reason) });
      fireStreamEnd();
      // 取消上游读取（fire-and-forget）：客户端走了，上游连接不应该继续挂着；
      // 但 cancel 本身失败没有可告知的对象。
      try {
        upstreamResp.body?.cancel();
      } catch {
        /* 见上：客户端已断开 */
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function extractSseData(frame: string): string | null {
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("data:")) return line.slice(5).replace(/^\s/, "");
  }
  return null;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Cast stored output items back into input items so the next turn's history is
 * a flat list the translator can walk. Responses output and input item shapes
 * overlap enough that a structural cast is sound (the fields we read — `type`,
 * `call_id`, `name`, `arguments`, `content`, `role` — are shared).
 */
function outputItemsAsInputItems(outputs: ResponsesOutputItem[]): ResponsesInputItem[] {
  // SAFETY: the shared field set above is the whole contract the translator
  // walks; the two interfaces differ only in fields it never reads.
  return outputs as unknown as ResponsesInputItem[];
}

function buildStoredResponse(
  resp: ResponsesResponse,
  input: ResponsesInputItem[],
  instructions: string | undefined,
  origin: { accountId: string; routeKind: RouteKind },
): StoredResponse {
  return {
    id: resp.id,
    model: resp.model,
    status: (resp.status === "completed" || resp.status === "incomplete" || resp.status === "failed" ? resp.status : "completed"),
    input,
    output: resp.output,
    usage: resp.usage,
    instructions,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    accountId: origin.accountId,
    routeKind: origin.routeKind,
  };
}
