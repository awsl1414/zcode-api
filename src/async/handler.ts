/**
 * Async route handlers — wrap the bridge with format-specific translation.
 *
 * Three handlers:
 *   - `handleAsyncMessages`  (Anthropic client, POST /async/v1/messages)         — passthrough
 *   - `handleAsyncChat`      (OpenAI client, POST /async/v1/chat/completions)    — request OAI→ANT, response ANT SSE→OAI SSE
 *   - `handleAsyncHealth`    (GET /async/v1/health)                              — probe queue availability
 *
 * Common pre-flight (B1 fix: validate BEFORE takeTicket so we never leak a ticket
 * on JSON parse / model-missing / translation failures):
 *   1. Verify credential has `jwt` (login-captured JWT; absent on imported keys)
 *   2. Read + parse client body (skip for health)
 *   3. Validate required fields + build the Anthropic-format upstream body
 *   4. ONLY THEN takeTicket (any failure above returns 4xx WITHOUT a ticket)
 *
 * For non-stream (B5+B10): internally force `stream:true` upstream; return a
 * chunked `application/json` response that emits legal leading whitespace during
 * wait (defeats client TCP idle) and writes the final aggregated JSON at the end.
 *
 * 请求记录：/async/* 与另外两条入站协议一样被记录，面板的
 * 请求事件 tab 能看到它。记录由各入口在开头创建、与租约同寿，收尾（endedAt /
 * totalMs / notify）在 finally 里做，形状与 `proxy/handler.ts` 的 `proxyRequest`
 * 一致；流式用量统计复用 `handler-log.ts` 的 `observeStream`。
 *
 * async 的两个事实要如实进记录，不做美化：
 * - 票券排队可能长达数小时，queueMs 因此会非常大。queueMs 在票券 ready（bridge
 *   的 ready 迁移）那一刻落定，覆盖「选号 + takeTicket + 排队」全程。
 * - 等待期间桥接流会发 `: keepalive` 注释帧。统计旁路把注释帧滤掉之后才交给
 *   `observeStream`：首块**数据**才算 TTFB，否则排队时长会被重复算进 ttfbMs。
 *   客户端拿到的流原样保留注释帧（那是 B1 修的 TCP 保活，不能动）。
 *
 */
import type { ProxyConfig } from "../config/types.js";
import type { Broker, Lease } from "../accounts/broker.js";
import { toAuthCredential } from "../accounts/manager.js";
import { accountDeviceMid } from "../accounts/device-mid.js";
import type { Credential } from "../auth/types.js";
import { credentialString } from "../auth/types.js";
import { checkSurface } from "../auth/capabilities.js";
import { acquireLease, withLeaseRelease } from "../proxy/lease.js";
import { errorResponse } from "../proxy/http-io.js";
import { resolveEffortOverride } from "../provider/effort-override.js";
import { transformRequestBody } from "../proxy/body-transformer.js";
import { buildAnthropicMetadataUserId } from "../proxy/trace-headers.js";
import { inflateWithCap } from "../proxy/inflate.js";
import { translateRequestOpenAIToAnthropic, translateResponseAnthropicToOpenAI } from "../translator/openai-to-anthropic.js";
import { anthropicSseToOpenaiSseWithKeepalive } from "./openai-stream-adapter.js";
import type { AnthropicMessagesRequest, OpenAIChatRequest, AnthropicMessagesResponse } from "../translator/types.js";
import { createOffPeakClient, type OffPeakClient } from "./client.js";
import type { OffPeakCredentials, TakeTicketResult } from "./types.js";
import { runAsyncBridge } from "./bridge.js";
import type { EgressOptions } from "../proxy/egress.js";
import { addStage, failStage, getDefaultRequestStore, markClientAborted, nextReqId } from "../proxy/request-record.js";
import { reasoningEffortFromBody } from "../proxy/reasoning-effort.js";
import type { RequestRecord, RequestStore } from "../proxy/request-record.js";
import { classifyClientKind } from "../proxy/client-kind.js";
import { observeStream, printRow } from "../proxy/handler-log.js";
// 统一观测点：async 的出线响应/流层信号与数据面同一套观测链路，
// lease/account 上下文由票券绑定的租约自带。
import { observeUpstream } from "../proxy/upstream-error.js";
import type { UpstreamEvent } from "../proxy/upstream-error.js";
import { logger } from "../log/index.js";

/** 闲时通道的日志。`onTransition` 只在 `debug` 时接，所以这里只记状态变化。*/
const log = logger("async");

/** Cap request body size to prevent memory exhaustion (B16). */
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/** Single space byte — used for non-stream chunked JSON whitespace keepalive. */
const SINGLE_SPACE = new Uint8Array([32]);

export interface AsyncHandlerOptions {
  config: ProxyConfig;
  /** 唯一出线口：按 `(account, route)` 解析凭据与路由。*/
  broker: Broker;
  fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  debug?: boolean;
  /**
   * 请求记录的持有者。缺省用进程级实例：理由与 `handler.ts` 相同，
   * 「忘了传」不该变成静默丢记录。
   */
  requests?: RequestStore;
  /** 这次请求归因到哪条 key。缺省 = 没有归因（会话 Cookie 或表空放行）。*/
  apiKeyId?: string;
}

function buildCredentials(cred: Credential): OffPeakCredentials {
  return {
    jwt: cred.jwt ?? "",
    codingPlanApiKey: credentialString(cred),
  };
}

function generateTaskId(): string {
  return `proxy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function resolveModel(req: { model?: string }, config: ProxyConfig): string {
  const explicit = typeof req.model === "string" ? req.model.trim() : "";
  if (explicit) return explicit;
  if (config.async.defaultModel && config.async.defaultModel.trim()) return config.async.defaultModel.trim();
  return config.defaultModel;
}

async function readBody(req: Request): Promise<{ ok: true; body: string } | { ok: false; response: Response }> {
  // Reject oversized Content-Length up front; otherwise drain the stream incrementally
  // and abort as soon as we exceed the cap. This prevents an attacker from exhausting
  // memory by sending a huge chunked body with no Content-Length.
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const cl = parseInt(contentLength, 10);
    if (Number.isFinite(cl) && cl > MAX_REQUEST_BODY_BYTES) {
      // Cancel the request body stream so the underlying socket releases; otherwise
      // the client can keep the connection alive despite the 413 response.
      req.body?.cancel().catch(() => {});
      return { ok: false, response: errorResponse(413, "request_too_large", `body exceeds ${MAX_REQUEST_BODY_BYTES} byte cap`, undefined, "other") };
    }
  }
  if (!req.body) {
    return { ok: false, response: errorResponse(400, "invalid_request_error", "missing request body", undefined, "other") };
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false, response: errorResponse(413, "request_too_large", `body exceeds ${MAX_REQUEST_BODY_BYTES} byte cap`, undefined, "other") };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, response: errorResponse(400, "invalid_request_error", "could not read request body", undefined, "other") };
  } finally {
    reader.releaseLock?.();
  }
  // Inflate `content-encoding: gzip` request bodies with the cap enforced on
  // the DECOMPRESSED size — a small gzip bomb must not bypass the byte cap.
  const encoding = req.headers.get("content-encoding")?.toLowerCase().trim() ?? "";
  let bytes: Uint8Array = Buffer.concat(chunks);
  if (encoding === "gzip" || encoding === "x-gzip") {
    const inflated = await inflateWithCap(bytes, MAX_REQUEST_BODY_BYTES);
    if (!inflated.ok) {
      if (inflated.reason === "too_large") {
        return { ok: false, response: errorResponse(413, "request_too_large", `decompressed body exceeds ${MAX_REQUEST_BODY_BYTES} byte cap`, undefined, "other") };
      }
      return { ok: false, response: errorResponse(400, "invalid_request_error", "could not decompress gzip request body", undefined, "other") };
    }
    bytes = inflated.bytes;
  }
  const body = new TextDecoder().decode(bytes);
  if (!body || body.length === 0) {
    return { ok: false, response: errorResponse(400, "invalid_request_error", "empty request body", undefined, "other") };
  }
  return { ok: true, body };
}

/**
 * 取本次异步请求的凭据（走 broker，不是进程级全局凭据）。
 *
 * `/async/*` 今天仍然直接对 off-peak 票券后端发请求（`async/client.ts`），没有经过
 * `proxy/handler.ts` 的按路由组装，所以这里只借租约拿**凭据**与**已解析的路由**；
 * `route` 传给 `checkSurface` 做闸门。
 *
 * **不钉 `off-peak` 路由（有意为之）**：off-peak 是一条路由（票券队列是
 * 准入、端点是推理），但 `/async/*` 仍解析到各账号实际启用的路由上——账号白名单
 * 默认 `"coding-plan"`（`accounts/manager.ts::inferRoutes`），钉死会把所有账号的
 * `/async/*` 变成 400。`checkSurface("async", …)` 本身不绑路由（它只要求 jwt +
 * apiKey 对），对外行为与路由化之前逐字等价。
 *
 * `X-ZCode-Route` 不接：这条通道的出线路由由票券语义固定（off-peak），
 * acquire 不带 `pinnedRoute`，显式选档在这里没有可表达的对象。
 */
async function resolveCredential(opts: AsyncHandlerOptions, record?: RequestRecord): Promise<{ ok: true; cred: Credential; credentials: OffPeakCredentials; lease: Lease } | { ok: false; response: Response }> {
  const acquired = await acquireLease(opts.broker, {});
  if (!acquired.ok) {
    // 选号失败记在 dispatch 阶段（同 handler.ts 的 acquire 出口）。health 不传
    // 记录（它不是数据面请求，不建记录）。
    if (record) {
      record.status = 401;
      failStage(record, "dispatch", `credential resolution failed: ${acquired.message}`, acquired.errorCode);
      printRow(record);
    }
    return { ok: false, response: errorResponse(401, "authentication_error", `credential resolution failed: ${acquired.message}`, undefined, acquired.errorCode) };
  }
  const lease = acquired.lease;
  const cred = toAuthCredential(lease.credential);
  // /async carries the plan JWT *and* x-coding-plan-api-key
  // (async/bridge.ts forwardLLM), so both halves are required
  // (auth/capabilities.ts).
  const credentialCheck = checkSurface("async", cred, lease.route);
  if (!credentialCheck.ok) {
    if (record) {
      record.status = 400;
      failStage(record, "route-facts", credentialCheck.message, "auth-invalid");
      printRow(record);
    }
    return {
      ok: false,
      response: errorResponse(400, "async_credentials_unavailable", credentialCheck.message, undefined, "other"),
    };
  }
  // 调度结果先落字段：dispatch **阶段**要等票券 ready 才登记，queueMs
  // 在那时才是「选号 + 排队」的全程。
  if (record) {
    record.account = lease.account.label;
    record.route = lease.route;
  }
  return { ok: true, cred, credentials: buildCredentials(cred), lease };
}

function buildClient(opts: AsyncHandlerOptions, credentials: OffPeakCredentials, egress: EgressOptions | undefined): OffPeakClient {
  return createOffPeakClient({
    origin: opts.config.async.origin,
    credentials,
    controlTimeoutMs: opts.config.async.controlTimeoutMs,
    settleTimeoutMs: opts.config.async.settleTimeoutMs,
    fetchImpl: opts.fetchImpl,
    egress,
  });
}

async function takeTicketOr502(client: OffPeakClient, taskId: string, signal: AbortSignal | undefined): Promise<{ ok: true; ticket: TakeTicketResult } | { ok: false; response: Response; message: string }> {
  try {
    const ticket = await client.takeTicket(taskId, signal);
    return { ok: true, ticket };
  } catch (err) {
    const message = `off-peak takeTicket failed: ${(err as Error).message}`;
    return { ok: false, response: errorResponse(502, "async_take_ticket_failed", message, undefined, "other"), message };
  }
}

function buildBridge(opts: AsyncHandlerOptions, client: OffPeakClient, credentials: OffPeakCredentials, llmRequestBody: string, initialTicket: TakeTicketResult, taskId: string, req: Request, deviceMid: string, egress: EgressOptions | undefined, record: RequestRecord,
  /** 出线响应观测回调（bridge 每次 forwardLLM 的响应都递出去，见 BridgeOptions）。*/
  onUpstreamResp: (resp: Response) => void | Promise<unknown>) {
  /**
   * 桥接迁移 → 记录。
   *
   * 票券 ready 才算排完队：queueMs 覆盖「选号 + takeTicket + 排队」全程，闲时
   * 排队可能长达数小时，这个大数就是真实情况。ready 之后每次退回重取票都是一次
   * retry；终局错误从 outcome 里补 failedStage：HTTP 200 已经带 SSE 头出去了，
   * 表格行上看不出错误，记录必须能看出。onTransition 由 bridge 自带吞错，记录
   * 侧的任何异常都不会破坏桥接。
   */
  let lastBridgeError: string | undefined;
  const bridge = runAsyncBridge({
    client,
    credentials,
    origin: opts.config.async.origin,
    identity: opts.config.identity,
    deviceMid,
    llmRequestBody,
    initialTicket,
    taskId,
    pollIntervalMs: opts.config.async.pollIntervalMs,
    keepAliveIntervalMs: opts.config.async.keepAliveIntervalMs,
    maxRetries: opts.config.async.maxRetries,
    maxWaitMs: opts.config.async.maxWaitMs,
    clientSignal: req.signal,
    fetchImpl: opts.fetchImpl,
    // 闲时通道也是这个账号的出线：票券与 LLM 流都走它。
    egress,
    // 出线响应 → 统一观测点（同数据面规则）。
    onUpstreamResp,
    onTransition: (info) => {
      if (info.phase === "ready") {
        // 票券第 N 次 ready = 第 N 次上游出线（bridge 的 `attempt` 从 0 起，
        // 每次过期重取前 +1），所以这里是 `attempt + 1`。与 handler.ts 的计数点
        // 同一语义：一次真实的 LLM 出线算一次。
        // 这行**必须在下面的 `queueMs === undefined` 判定之外**：票券先 ready、
        // LLM 阶段过期、再重取回来，第二次 ready 的 queueMs 已经落过了，写在里面
        // 就永远数不到第二次出线。
        record.upstreamAttempts = info.attempt + 1;
      }
      if (info.phase === "ready" && record.queueMs === undefined) {
        const queueMs = Date.now() - record.startedAt;
        record.queueMs = queueMs;
        addStage(record, "dispatch", { account: record.account, route: record.route, queueMs, ticketId: info.ticketId });
        // LLM 请求此刻出线（bridge 的 forwardLLM 紧跟 ready）。async 直发 off-peak
        // 网关，走的是票券准入而非客户端签名，所以 signed 恒为 false。
        record.upstreamUrl = `${opts.config.async.origin.replace(/\/+$/, "")}/api/v1/off-peak/anthropic/v1/messages`;
        record.upstreamFormat = "anthropic";
        record.signed = false;
        addStage(record, "upstream-req", { url: record.upstreamUrl, signed: false });
      } else if (info.phase === "expired") {
        // 票券过期后的重取是一次 retry：同一账号同一路由，只登记阶段，不改
        // `retries`（那是「换号次数」）。
        addStage(record, "retry", {
          event: "ticket-expired",
          reason: "ticket-expired",
          ticketId: info.ticketId,
          ...(info.message ? { message: info.message } : {}),
        });
      }
      if ((info.phase === "error" || info.phase === "expired") && info.message) lastBridgeError = info.message;
      if (opts.debug) {
        log.debug("ticket transition", {
          taskId,
          ticketId: info.ticketId,
          phase: info.phase,
          attempt: info.attempt,
          ...(info.state ? { state: info.state } : {}),
          ...(info.message ? { message: info.message } : {}),
        });
      }
    },
  });
  void bridge.outcome.then((o) => {
    if (o.terminalPhase === "error" && record.failedStage === undefined) {
      failStage(record, "upstream-resp", lastBridgeError ?? `async upstream failed after ${o.attempts} attempt(s)`, "upstream-error");
    }
  });
  return bridge;
}

function sseHeaders(): Record<string, string> {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };
}

export async function handleAsyncMessages(req: Request, opts: AsyncHandlerOptions): Promise<Response> {
  // 记录与 reqId 同寿，finally 收尾（与 proxyRequest 同形状）。Anthropic
  // 入站 → format "anthropic"；reqId 复用三条协议共用的那个计数器，终端与面板上
  // 的时序才一致。health 不建记录（它不是数据面请求）。
  const requests = opts.requests ?? getDefaultRequestStore();
  const record = requests.begin({ reqId: nextReqId(), format: "anthropic", apiKeyId: opts.apiKeyId ?? "" });
  // 客户端归类只看请求头（见 client-kind.ts），与主链路同一写入时机。
  record.clientKind = classifyClientKind(req.headers);
  try {
    return await handleAsyncMessagesOnLease(req, opts, record);
  } catch (err) {
    // 逃出内层的异常没有阶段可归（内层的失败路径都已 failStage）：记在 handler 上，
    // 与 handler.ts 同款，否则这条记录会是一个没有原因的失败。
    if (record.failedStage === undefined) failStage(record, "handler", (err as Error).message, "other");
    throw err;
  } finally {
    record.endedAt = Date.now();
    // 流式请求的 totalMs 之后会被 observeStream 改成流的真实时长（这里只能算到
    // 「响应已经交回客户端」为止），非流式它就是最终值。
    record.totalMs = record.endedAt - record.startedAt;
    // 客户端已断开 = 客户端自己放弃（票券排队期间断开也算）。
    if (req.signal.aborted) markClientAborted(record);
    requests.notify(record);
  }
}

/**
 * async 流层信号的回传口（`observeStream` 的 onSignal）。
 *
 * **过滤 stream-error**：桥接会把内部故障（票券超时、重试耗尽、帧超限）合成为
 * `event: error` 帧下发给客户端，那不是上游的流内错误，放行会让它们污染路由级
 * gateway streak（反向误伤）。上游真错误已由响应层观测覆盖（forwardLLM 的
 * `onUpstreamResp`）。空流 / 流中断照常放行（async 通道同样适用）。
 */
function asyncStreamSignal(broker: Broker, lease: Lease): (event: UpstreamEvent) => void {
  return (event) => {
    if (event.type === "stream-error") return;
    void observeUpstream(broker, lease, event).catch(() => {
      // 有意吞错：观测失败不影响请求本身（旁路语义）。
    });
  };
}

async function handleAsyncMessagesOnLease(req: Request, opts: AsyncHandlerOptions, record: RequestRecord): Promise<Response> {
  // 流式出口的落盘收尾（onFinal → finalize）要同一个仓实例（同 handler.ts）。
  const requests = opts.requests ?? getDefaultRequestStore();
  // B1: validate everything before ticket acquisition
  const cred = await resolveCredential(opts, record);
  if (!cred.ok) return cred.response;
  // 一账号一指纹：deviceMid 是账号属性，所以从租约账号取，
  // 不是从进程级 config 取。`api-key` 凭据没有身份面 → 空串不发这个头。
  const deviceMid = accountDeviceMid(cred.lease.account) ?? "";

  const bodyResult = await readBody(req);
  if (!bodyResult.ok) {
    record.status = bodyResult.response.status;
    failStage(record, "intake", `request body rejected (HTTP ${bodyResult.response.status})`, "other");
    return bodyResult.response;
  }

  let parsedBody: Record<string, unknown>;
  try {
    const raw = JSON.parse(bodyResult.body);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      record.status = 400;
      failStage(record, "intake", "request body must be a JSON object", "other");
      return errorResponse(400, "invalid_request_error", "request body must be a JSON object", undefined, "other");
    }
    parsedBody = raw as Record<string, unknown>;
  } catch {
    record.status = 400;
    failStage(record, "intake", "request body is not valid JSON", "other");
    return errorResponse(400, "invalid_request_error", "request body is not valid JSON", undefined, "other");
  }
  if (!Array.isArray(parsedBody.messages) || parsedBody.messages.length === 0) {
    record.status = 400;
    failStage(record, "intake", "missing or invalid `messages` field", "other");
    return errorResponse(400, "invalid_request_error", "missing or invalid `messages` field", undefined, "other");
  }
  // Anthropic spec: omitted `stream` defaults to non-streaming (false).
  const clientWantsStream = parsedBody.stream === true;

  const modelStr = typeof parsedBody.model === "string" ? parsedBody.model : undefined;
  const resolvedModel = resolveModel({ model: modelStr }, opts.config);
  const upstreamBody = {
    ...parsedBody,
    model: resolvedModel,
    stream: true,
  } as AnthropicMessagesRequest;
  // 推理强度覆盖（面板 reasoning 段）。resolve 一次两处共用：落 record 与
  // 传给 transformRequestBody 改写（真源 effort-override.ts，与 handler.ts 同一
  // 函数——async 通道与同步通道的覆盖行为不可能分叉）。undefined = 透传原样。
  const effortOverride = resolveEffortOverride(opts.config, resolvedModel);
  if (effortOverride !== undefined) record.reasoningEffortOverride = effortOverride;
  const upstreamBodyText = transformRequestBody(JSON.stringify(upstreamBody), { format: "anthropic", metadataUserId: buildAnthropicMetadataUserId(deviceMid, undefined), ...(effortOverride !== undefined ? { effortOverride } : {}) }) ?? JSON.stringify(upstreamBody);

  // 阶段 intake：请求形状（与 handler.ts 同字段）。requestBytes 是读入的原始
  // 字节数（改写前）。
  record.model = resolvedModel;
  record.stream = clientWantsStream;
  record.requestBytes = bodyResult.body.length;
  // 推理强度（三套协议共用 `reasoning-effort.ts`；这是客户端原始 body，
  // 不是下面改写后出线的形状——口径见该模块文件头）。
  const reasoningEffort = reasoningEffortFromBody(parsedBody);
  if (reasoningEffort !== undefined) record.reasoningEffort = reasoningEffort;
  addStage(record, "intake", {
    format: "anthropic",
    model: record.model,
    stream: record.stream,
    bytes: record.requestBytes,
    clientKind: record.clientKind,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(record.reasoningEffortOverride !== undefined
      ? { reasoningEffortOverride: record.reasoningEffortOverride }
      : {}),
  });

  // Now we're safe to take a ticket
  const client = buildClient(opts, cred.credentials, cred.lease.egress);
  const taskId = generateTaskId();
  const ticket = await takeTicketOr502(client, taskId, req.signal);
  if (!ticket.ok) {
    // 票券准入失败记在 dispatch 阶段：那是「排队」的第一步。
    record.status = ticket.response.status;
    failStage(record, "dispatch", ticket.message, "other");
    printRow(record);
    return ticket.response;
  }
  record.status = 200;

  const { stream, outcome } = buildBridge(opts, client, cred.credentials, upstreamBodyText, ticket.ticket, taskId, req, deviceMid, cred.lease.egress, record,
    // async 出线响应 → observeUpstream（同数据面规则；票券绑账号，lease 自带）。
    (resp) => observeUpstream(opts.broker, cred.lease, resp));
  void outcome;

  // 统计旁路：把桥接流 tee 出一份给 `observeStream`，TTFB / token / tps /
  // stream-end 阶段全由它填。等待期的 keepalive 注释帧先滤掉（首块**数据**才算
  // TTFB），客户端分支原样保留。非流式的桥接流同样是 Anthropic SSE，同一套旁路
  // 覆盖两种出口，token 不用再从聚合 JSON 里数一遍。
  const [clientStream, statsStream] = stream.tee();
  // 落盘延到流收尾（onFinal → finalize）——异步的桥接流恒为 SSE，token /
  // 缓存桶 / stream-end 阶段都在流收尾才写进记录（与 handler.ts 同款）。
  // 流层信号（空流 / 流中断；error 帧被过滤，见 asyncStreamSignal）回观测点；
  // `req.signal` 区分客户端主动断开（账号无辜，不发信号）。
  observeStream(record, stripCommentFrames(statsStream), undefined, undefined, () => requests.finalize(record), req.signal, asyncStreamSignal(opts.broker, cred.lease));

  // 租约跟着响应体走：票券等待 + LLM 流式输出期间一直占着槽位，客户端读完
  // 或取消才释放。
  if (clientWantsStream) {
    return withLeaseRelease(new Response(clientStream, { status: 200, headers: sseHeaders() }), cred.lease.release);
  }

  // Non-stream: chunked response with leading whitespace during wait + final JSON (B10).
  // NOTE: no explicit `transfer-encoding` header — it is a forbidden Response
  // constructor header (runtimes drop/override it) and Node http already sends
  // chunked when no content-length is set.
  return withLeaseRelease(new Response(nonStreamChunkedJson(clientStream), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" },
  }), cred.lease.release);
}

export async function handleAsyncChat(req: Request, opts: AsyncHandlerOptions): Promise<Response> {
  // 同 handleAsyncMessages，OpenAI 入站 → format "openai"。
  const requests = opts.requests ?? getDefaultRequestStore();
  const record = requests.begin({ reqId: nextReqId(), format: "openai", apiKeyId: opts.apiKeyId ?? "" });
  // 同 handleAsyncMessages。
  record.clientKind = classifyClientKind(req.headers);
  try {
    return await handleAsyncChatOnLease(req, opts, record);
  } catch (err) {
    if (record.failedStage === undefined) failStage(record, "handler", (err as Error).message, "other");
    throw err;
  } finally {
    record.endedAt = Date.now();
    record.totalMs = record.endedAt - record.startedAt;
    // 同 handleAsyncMessages。
    if (req.signal.aborted) markClientAborted(record);
    requests.notify(record);
  }
}

async function handleAsyncChatOnLease(req: Request, opts: AsyncHandlerOptions, record: RequestRecord): Promise<Response> {
  // 同 handleAsyncMessagesOnLease。
  const requests = opts.requests ?? getDefaultRequestStore();
  const cred = await resolveCredential(opts, record);
  if (!cred.ok) return cred.response;
  const deviceMid = accountDeviceMid(cred.lease.account) ?? "";

  const bodyResult = await readBody(req);
  if (!bodyResult.ok) {
    record.status = bodyResult.response.status;
    failStage(record, "intake", `request body rejected (HTTP ${bodyResult.response.status})`, "other");
    return bodyResult.response;
  }

  let openaiReq: OpenAIChatRequest;
  try {
    openaiReq = JSON.parse(bodyResult.body) as OpenAIChatRequest;
  } catch {
    record.status = 400;
    failStage(record, "intake", "request body is not valid JSON", "other");
    return errorResponse(400, "invalid_request_error", "request body is not valid JSON", undefined, "other");
  }
  if (!Array.isArray(openaiReq.messages) || openaiReq.messages.length === 0) {
    record.status = 400;
    failStage(record, "intake", "missing or invalid `messages` field", "other");
    return errorResponse(400, "invalid_request_error", "missing or invalid `messages` field", undefined, "other");
  }
  openaiReq.model = resolveModel(openaiReq, opts.config);
  const clientWantsStream = openaiReq.stream === true;

  // 阶段 intake：请求形状（与 handleAsyncMessages 同字段）。
  record.model = openaiReq.model;
  record.stream = clientWantsStream;
  record.requestBytes = bodyResult.body.length;
  // 同 handleAsyncMessages（OpenAI 形状 → `reasoning_effort` / `thinking`）。
  const reasoningEffort = reasoningEffortFromBody(openaiReq);
  if (reasoningEffort !== undefined) record.reasoningEffort = reasoningEffort;
  // 覆盖 resolve（真源同 handleAsyncMessages），intake 落档位 + 下面的
  // transformRequestBody 改写共用这一次结果。
  const effortOverride = resolveEffortOverride(opts.config, openaiReq.model);
  if (effortOverride !== undefined) record.reasoningEffortOverride = effortOverride;
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
  });

  let anthropicReq: AnthropicMessagesRequest;
  try {
    anthropicReq = translateRequestOpenAIToAnthropic(openaiReq);
  } catch (err) {
    record.status = 400;
    failStage(record, "translate", `OpenAI→Anthropic translation failed: ${(err as Error).message}`, "translate-failed");
    return errorResponse(400, "invalid_request_error", `OpenAI→Anthropic translation failed: ${(err as Error).message}`, undefined, "translate-failed");
  }
  anthropicReq.stream = true;
  const upstreamBodyText = transformRequestBody(JSON.stringify(anthropicReq), { format: "anthropic", metadataUserId: buildAnthropicMetadataUserId(deviceMid, undefined), ...(effortOverride !== undefined ? { effortOverride } : {}) }) ?? JSON.stringify(anthropicReq);

  const client = buildClient(opts, cred.credentials, cred.lease.egress);
  const taskId = generateTaskId();
  const ticket = await takeTicketOr502(client, taskId, req.signal);
  if (!ticket.ok) {
    record.status = ticket.response.status;
    failStage(record, "dispatch", ticket.message, "other");
    printRow(record);
    return ticket.response;
  }
  record.status = 200;

  const { stream: rawStream, outcome } = buildBridge(opts, client, cred.credentials, upstreamBodyText, ticket.ticket, taskId, req, deviceMid, cred.lease.egress, record,
    // 同 handleAsyncMessagesOnLease —— 出线响应 → observeUpstream。
    (resp) => observeUpstream(opts.broker, cred.lease, resp));
  void outcome;

  // 统计旁路读桥接流的原始 Anthropic SSE（翻译前的那一份）：与 handleAsyncMessages
  // 同一套旁路，token / TTFB 的口径两边一致。
  const [clientStream, statsStream] = rawStream.tee();
  // 同 handleAsyncMessages —— 落盘延到流收尾。
  // 同 handleAsyncMessages —— 流层信号回观测点（error 帧过滤）。
  observeStream(record, stripCommentFrames(statsStream), undefined, undefined, () => requests.finalize(record), req.signal, asyncStreamSignal(opts.broker, cred.lease));

  if (clientWantsStream) {
    // B4: custom translator that preserves `: keepalive` comments and converts Anthropic errors
    const openaiStream = anthropicSseToOpenaiSseWithKeepalive(clientStream, openaiReq.model);
    return withLeaseRelease(new Response(openaiStream, { status: 200, headers: sseHeaders() }), cred.lease.release);
  }

  return withLeaseRelease(new Response(nonStreamChunkedJson(clientStream, { translate: "openai", model: openaiReq.model }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" },
  }), cred.lease.release);
}

export async function handleAsyncHealth(_req: Request, opts: AsyncHandlerOptions): Promise<Response> {
  const cred = await resolveCredential(opts);
  if (!cred.ok) return cred.response;
  const client = buildClient(opts, cred.credentials, cred.lease.egress);
  // 健康探测是一次性的控制面调用，没有长连接要守，探测结束即释放槽位。
  try {
    const avail = await client.getAvailability();
    return withLeaseRelease(new Response(JSON.stringify(avail), { status: 200, headers: { "content-type": "application/json" } }), cred.lease.release);
  } catch (err) {
    cred.lease.release();
    return errorResponse(502, "async_health_failed", (err as Error).message, undefined, "other");
  }
}

/**
 * 把 SSE 流里的纯注释帧滤掉（统计旁路专用）。
 *
 * 桥接流在票券等待期间会周期性发 `: keepalive\n\n` 注释帧（bridge 反模式 #1）。
 * `observeStream` 把「第一个到达的字节块」当 TTFB，直接喂原始流会让 ttfbMs 把整个
 * 排队时长都算进去——与 queueMs 重复计账。这里按完整 SSE 帧（`\n\n` 分隔）缓冲，
 * 只丢弃「每一非空行都以 `:` 开头」的注释帧，数据帧原样透传。只滤旁路这一份：
 * 客户端拿到的流原样保留注释帧，那是 TCP 保活，不能动。
 */
function stripCommentFrames(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      reader = source.getReader();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            // 按完整帧缓冲：半截帧（跨 chunk 边界）留在 pending 里，不误判。
            let boundary: number;
            while ((boundary = pending.indexOf("\n\n")) >= 0) {
              const frame = pending.slice(0, boundary + 2);
              pending = pending.slice(boundary + 2);
              if (!isCommentOnlyFrame(frame)) controller.enqueue(encoder.encode(frame));
            }
          }
          // 尾部冲洗：EOF 后剩下的不足一帧的文本原样透传（正常流不会走到这里）。
          if (pending && !isCommentOnlyFrame(pending)) controller.enqueue(encoder.encode(pending));
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      })();
    },
    cancel(reason) {
      // 客户端侧取消：透传给上游读端（fire-and-forget，取消失败无可告知对象）。
      reader?.cancel(reason).catch(() => {});
    },
  });
}

/** 每一非空行都以 `:` 开头的帧 = SSE 注释帧（`: keepalive`）。*/
function isCommentOnlyFrame(frame: string): boolean {
  for (const line of frame.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith(":")) return false;
  }
  return true;
}

/**
 * Wrap the SSE byte stream as a non-stream JSON response. Emits leading whitespace
 * during ticket-queue wait (defeats client TCP idle), then a single JSON document.
 *
 * Two modes:
 *   - default: Anthropic batch JSON shape
 *   - {translate: "openai"}: OpenAI batch JSON shape (translated from Anthropic)
 */
function nonStreamChunkedJson(
  bridgeStream: ReadableStream<Uint8Array>,
  translateOpts?: { translate: "openai"; model: string },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = bridgeStream.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // One space byte per received chunk (not per char). Resets TCP idle timer
          // while keeping allocation count proportional to chunk count, not byte count.
          try {
            controller.enqueue(SINGLE_SPACE);
          } catch {
            return;
          }
          sseBuffer += decoder.decode(value, { stream: true });
        }
        sseBuffer += decoder.decode();
      } finally {
        reader.releaseLock?.();
      }

      // Reconstruct Anthropic batch JSON from accumulated SSE
      const anthropicMsg = reconstructAnthropicBatch(sseBuffer);
      if (!anthropicMsg) {
        const errPayload = { error: { type: "async_aggregation_failed", message: "could not reconstruct response from bridge stream" } };
        try {
          controller.enqueue(encoder.encode(JSON.stringify(errPayload)));
        } catch {
          // closed
        }
        controller.close();
        return;
      }

      const finalJson = translateOpts?.translate === "openai"
        ? JSON.stringify(translateResponseAnthropicToOpenAI(anthropicMsg, translateOpts.model))
        : JSON.stringify(anthropicMsg);
      try {
        controller.enqueue(encoder.encode(finalJson));
      } catch {
        // closed
      }
      controller.close();
    },
  });
}

/**
 * Reconstruct a synthetic `AnthropicMessagesResponse` from a stream of Anthropic SSE bytes.
 * Handles message_start, content_block_start/delta/stop, message_delta, message_stop.
 *
 * Fail-closed: returns null if `message_stop` not seen, or on `event: error`.
 * Preserves `signature_delta` for thinking blocks. No production `any`.
 */
function reconstructAnthropicBatch(sseText: string): AnthropicMessagesResponse | null {
  const blocks = sseText.split("\n\n");
  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; signature?: string }
    | { type: "tool_use"; id: string; name: string; input: unknown };
  let message: Partial<AnthropicMessagesResponse> | null = null;
  const content: ContentBlock[] = [];
  let currentBlock: ContentBlock | null = null;
  let currentToolJson = "";
  let sawMessageStop = false;
  let sawError = false;

  for (const block of blocks) {
    const lines = block.split("\n");
    let eventType: string | undefined;
    let data: string | undefined;
    for (const line of lines) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (!data) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = (eventType ?? parsed.type) as string;
    switch (type) {
      case "message_start": {
        const msg = parsed.message as Partial<AnthropicMessagesResponse> | undefined;
        message = { ...(msg ?? {}) };
        break;
      }
      case "content_block_start": {
        const cb = parsed.content_block as Partial<ContentBlock> | undefined;
        if (!cb || !cb.type) break;
        if (cb.type === "text") currentBlock = { type: "text", text: "" };
        else if (cb.type === "thinking") currentBlock = { type: "thinking", thinking: "" };
        else if (cb.type === "tool_use" && typeof cb.id === "string" && typeof cb.name === "string") {
          currentBlock = { type: "tool_use", id: cb.id, name: cb.name, input: {} };
          currentToolJson = "";
        }
        break;
      }
      case "content_block_delta": {
        const delta = parsed.delta as Record<string, unknown> | undefined;
        if (!currentBlock || !delta) break;
        if (delta.type === "text_delta" && currentBlock.type === "text" && typeof delta.text === "string") {
          currentBlock.text += delta.text;
        } else if (delta.type === "thinking_delta" && currentBlock.type === "thinking" && typeof delta.thinking === "string") {
          currentBlock.thinking += delta.thinking;
        } else if (delta.type === "signature_delta" && currentBlock.type === "thinking" && typeof delta.signature === "string") {
          currentBlock.signature = (currentBlock.signature ?? "") + delta.signature;
        } else if (delta.type === "input_json_delta" && currentBlock.type === "tool_use" && typeof delta.partial_json === "string") {
          currentToolJson += delta.partial_json;
        }
        break;
      }
      case "content_block_stop": {
        if (currentBlock) {
          if (currentBlock.type === "tool_use") {
            try {
              currentBlock.input = JSON.parse(currentToolJson || "{}");
            } catch {
              currentBlock.input = {};
            }
            currentToolJson = "";
          }
          content.push(currentBlock);
          currentBlock = null;
        }
        break;
      }
      case "message_delta": {
        const delta = parsed.delta as Partial<AnthropicMessagesResponse> | undefined;
        const usage = parsed.usage as Record<string, number> | undefined;
        if (delta && message) Object.assign(message, delta);
        if (usage && message) message.usage = { ...(message.usage ?? { input_tokens: 0, output_tokens: 0 }), ...usage } as AnthropicMessagesResponse["usage"];
        break;
      }
      case "message_stop":
        sawMessageStop = true;
        break;
      case "error":
        sawError = true;
        break;
      default:
        // ignore ping / unknown
        break;
    }
  }

  if (sawError || !sawMessageStop || !message) return null;
  message.content = content as AnthropicMessagesResponse["content"];
  if (!message.stop_reason) message.stop_reason = "end_turn";
  if (!message.role) message.role = "assistant";
  if (!message.usage) message.usage = { input_tokens: 0, output_tokens: 0 };
  return message as AnthropicMessagesResponse;
}
