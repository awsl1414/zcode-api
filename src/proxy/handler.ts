import type { Broker, Lease } from "../accounts/broker.js";
import { accountDeviceMid } from "../accounts/device-mid.js";
import { toAuthCredential } from "../accounts/manager.js";
import { getRouteSpec } from "../accounts/routes.js";
import type { RouteKind } from "../accounts/types.js";
import type { DataPlaneObserver } from "../apikeys/types.js";
import { checkSurface, llmSurfaceFor } from "../auth/capabilities.js";
import { credentialString } from "../auth/types.js";
import { resolveEffortOverride } from "../provider/effort-override.js";
import { acquireCaptchaWithRetry, isCaptchaChallenged, resolveCaptchaAcquireBudgetMs, retryOnCaptchaChallenge } from "../captcha/captcha-retry.js";
import type { CaptchaModuleLike } from "../captcha/captcha-retry.js";
import type { ProxyConfig } from "../config/types.js";
import { applyHighspeedCardHeaders, highspeedAuthFrom, isHighspeedFailure } from "../highspeed/manager.js";
import type { HighspeedAuth, HighspeedCard } from "../highspeed/manager.js";
import { injectDefaultModel } from "./default-model.js";
import { getDefaultHighspeedSlots } from "../highspeed/slots.js";
import type { HighspeedSlots } from "../highspeed/slots.js";
import { anthropicSseToOpenaiSse } from "../translator/sse-translator.js";
import type { Format } from "../translator/types.js";
import { transformRequestBody } from "./body-transformer.js";
import { getDefaultClientSigning, sendWithClientSigning } from "./client-signing.js";
import type { ClientSigningManager } from "./client-signing.js";
import { UPSTREAM_ERROR_BODY_LIMIT, dumpBody, dumpEnabled, dumpHeaders, dumpPhase, peekResponseBody } from "./dump.js";
import { getDefaultEndpointRouting } from "./endpoint-routing.js";
import type { EndpointRoutingService } from "./endpoint-routing.js";
import { acquireLease, withLeaseRelease } from "./lease.js";
import { routeUpstreamBaseUrl } from "./route-endpoint.js";
import { inferSessionFingerprint, resolveSessionContext, sessionIdForHeader } from "./session-context.js";
import { buildAnthropicMetadataUserId } from "./trace-headers.js";
import { observeUpstream } from "./upstream-error.js";
import type { UpstreamEvent } from "./upstream-error.js";
import { buildUpstreamHeaderPairs, buildUpstreamRequest, routeUsesPlanJwt } from "./upstream.js";
import type { UpstreamHeaderPair } from "./upstream.js";
import { logger } from "../log/index.js";
import { formatHeaderPairs, formatResponseHeaders, observeAnthropicUsage, observeStream, previewBody, printRow } from "./handler-log.js";
import { UNKNOWN_MODEL, addStage, failStage, getDefaultRequestStore, markClientAborted, nextReqId, noteUpstreamAttempt, noteErrorCode, peekBody } from "./request-record.js";
import type { RequestRecord, RequestStore } from "./request-record.js";
import { errorCodeOfUpstreamEvent } from "./error-codes.js";
import type { ErrorCode } from "./error-codes.js";
import { type ReportEnd, RouteUnknownError, countingPassthrough, noteDeclaredResponseBytes, requestedAccountLabel, requestedRoute } from "./handler-utils.js";
import { passthroughResponse, translateOpenAIBody, translatedBatchResponse, translatedSseResponse, upstreamErrorPassthrough, withHighspeedFallbackNotice } from "./response-translation.js";
import { classifyClientKind } from "./client-kind.js";
import { InflatedBodyTooLargeError, MAX_CONNECT_ATTEMPTS, capOrderedAcceptEncoding, clientAcceptsGzip, dispatchWithConnectRetry, errorResponse, readBody, retryAfterHeader, sendUpstreamRequest, shouldUseOrderedTransport } from "./http-io.js";

// captcha.ts is loaded lazily inside the `layers.captcha` branch (only path that
// touches it). The solver itself (captcha-happy.ts) is dynamically imported
// by captcha-solver.ts, so non-start-plan processes never pay its startup
// cost. Desktop Bun keeps the same code path; the dynamic import resolves
// synchronously enough on Bun's warm cache.
type CaptchaModule = CaptchaModuleLike;

let captchaModule: CaptchaModule | null = null;

/**
 * 请求链路的阶段登记。
 *
 * 阶段不再进 logger：`logger("proxy").debug("stage", {...})` 这种写法把请求的
 * 属性写成了日志行，读的人得自己按 `reqId` 把散在缓冲里的行拼回一条请求。现在阶段
 * 直接落在 `RequestRecord.stages` 上，终端那一行表格由 `handler-log.ts::printRow`
 * 从同一条记录渲染。
 *
 * 留下的 logger 调用只负责**系统**事件（端点改写到哪、上游错误码、captcha 挑战），
 * 那些不是「这一次请求走到了哪一步」。
 */
const log = logger("proxy");

/**
 * 事件形态失败的产生点身份：由 `UpstreamSignal.kind` 同源派生
 * （`readUpstreamSignal` 对 `connect-failed` 产 `gateway`、流中断产 `transport`），
 * 不经消息文案。响应形态失败则直接读 `observeUpstream` 返回的 `errorCode`。
 */
const CONNECT_FAILED_CODE = errorCodeOfUpstreamEvent("connect-failed");
const CAPTCHA_FAILED_CODE: ErrorCode = "other";

async function loadCaptcha(): Promise<CaptchaModule> {
  if (!captchaModule) captchaModule = await import("../captcha/captcha.js");
  return captchaModule;
}

/** Options for the proxy handler. */
export interface ProxyHandlerOptions {
  config: ProxyConfig;
  /**
   * 唯一出线口：按 `(account, route)` 解析凭据与路由。
   *
   * 凭据缓存只能回答"凭据是什么"，回答不了"这次请求走哪条路由"；而端点、鉴权
   * 形态、仿冒层、签名、captcha 全是路由的属性。所以取凭据的动作整个是
   * `broker.acquire()`。
   */
  broker: Broker;
  /** Override the global fetch (for testing). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * When true, emit additional per-request diagnostic lines: upstream URL,
   * redacted request headers, body preview, upstream response status and
   * selected response headers. Activated by `zcode-proxy serve debug`.
   */
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
   * 数据面用量回调。由 `server.ts` 在鉴权通过后注入，handler 只在每次
   * 请求结束时报告一行数字：它不知道 key 记录长什么样，也不持有任何 key 状态。
   */
  observer?: DataPlaneObserver;
  /**
   * 这次请求归因到哪条 key。缺省 = 没有归因（会话 cookie 或表空放行），
   * `apikeys/manager.ts` 会忽略空 id。
   */
  apiKeyId?: string;
  /**
   * 请求记录的持有者。缺省用进程级实例：路由文件与测试都会调
   * `proxyRequest`，要求每处先建一个 store 只会让「忘了传」变成静默丢记录。
   */
  requests?: RequestStore;
}

/**
 * Forward a client request to the upstream provider with injected auth.
 *
 * Upstream fetch options differ by mode:
 * - **Passthrough** (OpenAI client): `{ decompress: false }` — compressed
 *   response bodies (gzip/deflate/br) pass through untouched; raw bytes and the
 *   Content-Encoding header are forwarded as-is, letting the client decompress.
 * - **Translation** (Anthropic client): no options — Bun decompresses so the proxy
 *   can read the body and translate OpenAI→Anthropic (then re-gzip if the client
 *   accepts).
 *
 * No upstream timeout is applied — matches ZCode desktop client behaviour
 * (the bundle has no automatic timer on LLM calls, only user-initiated abort).
 * Connection-level errors (ECONNREFUSED, DNS failure) still surface as 502.
 */
export async function proxyRequest(
  clientReq: Request,
  format: Format,
  opts: ProxyHandlerOptions,
): Promise<Response> {
  // 租约的释放挂在**响应体**上（lease.ts::withLeaseRelease）：流式请求在
  // 客户端读完/取消之前一直占着槽位，非流式在 body 读完时释放。内层把租约登记
  // 进这个可变槽，外层负责收尾，这样内层几十个 return 分支都不用各写一遍释放。
  const leaseSlot: LeaseSlot = { current: null };
  // 换号一次：请求体流只能读一次，换号后必须复用第一次读到的字节。
  let replay: { body: string | undefined } | undefined;
  /** 换号后的第二次尝试。阶段 `retry` 在拿到新租约时才打（那时才知道下一个账号）。*/
  let retry: RetryContext | undefined;
  let rotated = false;
  // 一个 reqId 贯穿整个逻辑请求（含换号重放）：时间线按请求聚合，换号不该切成两条。
  const reqId = nextReqId();
  // 记录与 reqId 同寿。换号重放复用同一条（`retry` 分支里只加 `retries`），
  // 因为用户看到的是「一次请求」。
  const requests = opts.requests ?? getDefaultRequestStore();
  const record = requests.begin({ reqId, format, apiKeyId: opts.apiKeyId ?? "" });
  // 客户端归类只看请求头（见 client-kind.ts），在读 body 之前就落——
  // 连 body 都读不出来的请求记录上也要有「谁发的」。
  record.clientKind = classifyClientKind(clientReq.headers);
  // 落盘（finalize）是否延到流收尾。流式响应交回客户端时记录还没有用量
  // （统计旁路要等流走完），那种路径由 observeStream 的 onFinal 收尾；非流式
  // 路径的记录在 finally 时已完整，直接 finalize。内层（OnLease）是唯一知道
  // 「这次响应是不是流式」的地方，用槽传出来（与 leaseSlot 同一模式）。
  const persistSlot: PersistSlot = { deferred: false };
  try {
    for (;;) {
      const outcome = await proxyRequestOnLease(clientReq, format, opts, leaseSlot, record, replay, retry, persistSlot);
      if (outcome instanceof Response) {
        const lease = leaseSlot.current;
        return lease ? await withLeaseRelease(outcome, lease.release, clientReq.signal) : outcome;
      }

      // auth 信号：换**同路由**其他账号，**不降级**（降级是 drained 的动作，
      // 三种切走必须分离）。判定点在 dispatch 之后、任何字节回写之前，所以此刻
      // 换号合法。
      //
      // 冷却该 `(account, route)` + auth 计数已经由内层的 `observeUpstream`
      // 落过（auth 信号是健康动作的唯一入口）——这里只做
      // 调度侧的换号，不再上报第二次。
      const failedLease = outcome.lease;

      // 一次请求最多换一次。已经换过就只能把上游的 401/403 原样交给客户端
      // 这是「不轮询试号」。注意先归还槽位再返回，否则这份 401 会白白占着一个槽。
      if (rotated) {
        failedLease.release();
        leaseSlot.current = null;
        return await outcome.fallback();
      }

      rotated = true;
      replay = { body: outcome.body };
      retry = { reason: outcome.reason };
      outcome.discard();
      // 先释放旧槽位再取新的：不释放的话自己就把同路由的其他槽位占着。
      failedLease.release();
      leaseSlot.current = null;
    }
  } catch (err) {
    leaseSlot.current?.release();
    // 逃出内层的异常没有阶段可归（内层的失败路径都已 `failStage`）：记在 `handler`
    // 上，否则这条记录会显示成一个没有错误的原因不明的失败。
    if (record.failedStage === undefined) failStage(record, "handler", (err as Error).message, "other");
    throw err;
  } finally {
    record.endedAt = Date.now();
    // 流式请求的 `totalMs` 之后会被 `observeStream` 改成流的真实时长（这里只能算到
    // 「响应已经交回客户端」为止），非流式它就是最终值。
    record.totalMs = record.endedAt - record.startedAt;
    // 客户端在这一刻已经断开 = 这次请求是客户端自己放弃的（不是上游失败）。
    // 流式输出中途的断开由 `observeStream` 补（它拿得到流上的 `signal` 与读失败）。
    if (clientReq.signal.aborted) markClientAborted(record);
    // 实时通知（面板 SSE）照旧在交接时刻；落盘（finalize）只有非流式在这里
    // 做 —— 流式路径由 observeStream 的流收尾调（persistSlot.deferred）。
    requests.notify(record);
    if (!persistSlot.deferred) requests.finalize(record);
  }
}

/** 落盘时机的槽（内层流式出口置位，见 proxyRequest 的 finally）。*/
interface PersistSlot {
  deferred: boolean;
}

/** 租约登记槽：内层 acquire 之后写入，外层（`proxyRequest`）负责释放。*/
interface LeaseSlot {
  current: Lease | null;
}

/**
 * 换号重放要给下一轮尝试的上下文。
 *
 * 只装一个原因：新账号与新路由要等 `acquireLease` 返回才知道，而 `retry` 阶段的
 * 「关键字段」正是 `reason` / `nextAccount` / `nextRoute`。
 */
interface RetryContext {
  reason: string;
}

/**
 * 「尚未向客户端回写首字节时上游 auth 信号」的换号载体。
 *
 * 换号判定没有独立的检测函数——`proxyRequestOnLease` 只在 `observeUpstream` 的
 * 信号是 `kind === "auth"`（含 3007/1006 与裸 401/403，查表优先于状态）时返回本
 * 载体，健康动作（冷却 + auth 计数）已经由观测点落过，这里只负责调度侧的换号。
 *
 * 用返回值而不是异常表达：换号是一个**正常的调度动作**（不是错误路径），并且只有
 * 一个判定点会产生它。`fallback()` 延迟到真的换不出去时才构造，避免换号成功时
 * 白读一遍上游错误体。
 */
interface RotateOutcome {
  /** 换号重放要用的请求体（body 流已消费，不能重读）。*/
  readonly body: string | undefined;
  /** 这次失败所占的租约。外层必须先 `release()` 它（无论换号与否），否则槽位泄漏。*/
  readonly lease: Lease;
  /** 换号原因（阶段 `retry` 的 `reason` 字段）。*/
  readonly reason: string;
  /** 丢掉这份上游响应（换号成功后它不会再被读，不 cancel 白占一个 socket）。*/
  discard(): void;
  /** 换不出去时把上游错误原样交给客户端（不轮询试号）。*/
  fallback(): Promise<Response>;
}

async function proxyRequestOnLease(
  clientReq: Request,
  format: Format,
  opts: ProxyHandlerOptions,
  leaseSlot: LeaseSlot,
  record: RequestRecord,
  replay?: { body: string | undefined },
  retry?: RetryContext,
  /** 流式出口置 `deferred`，落盘延到流收尾（见 proxyRequest 的 finally）。*/
  persistSlot?: PersistSlot,
): Promise<Response | RotateOutcome> {
  const { config, broker } = opts;
  // 流式出口的落盘收尾（onFinal → finalize）要同一个仓实例；与外层
  // proxyRequest 的解析表达式一致（opts.requests 缺省时是进程级单例）。
  const requests = opts.requests ?? getDefaultRequestStore();
  const reqId = record.reqId;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const hasCustomFetchImpl = opts.fetchImpl !== undefined;
  /**
   * 冗长诊断（请求头 / body 预览 / 响应头）。
   *
   * 阶段时间线本身跟着 `logging.level` 走，这个开关只管那几行**体积大**
   * 的细节：把整个请求头和 body 预览都打进时间线，等于每次请求都写一条日志洪水。
   * 所以 `serve debug` 显式要求时才打。
   */
  const verbose = opts.debug === true;
  // 时间基准是**请求开始**（不是这次尝试开始）：换号重放后表格里的时刻与 TTFB 仍然
  // 从客户端发出那一刻算起，否则重放的请求看起来比真实的快。
  const started = record.startedAt;

  // ── 数据面用量 ──
  // handler 不持有 key 状态：记录里已经有归因与结果字段，记账方自己从 record 里读。
  const observer = opts.observer;

  /** 只报告用量。流式请求的日志行由 `observeStream` 自己打，这里不再打第二遍。*/
  const reportUsage = (): void => {
    if (!observer) return;
    try {
      // 异步实现（`apikeys/manager.ts`，仓要读文件）自己吞掉失败；这里只挡住同步抛出。
      void observer.onRequestEnd(record);
    } catch {
      // 有意吞错：记账失败不能把一次已经完成的代理请求变成错误。
    }
  };

  /**
   * 非流式收尾：结果字段 + 日志行 + 用量。
   *
   * 合成一个函数的理由是「每个出口都要记一次账」不能靠人记得多写一行：handler 的
   * 终止路径有十几条（租约失败 / 凭据不全 / 上游不可达 / captcha 失败 / 直传…），
   * 逐条后补一行 `reportUsage` 迟早会漏掉一条。
   */
  const reportEnd: ReportEnd = (status, headersAt, outputTokens = 0, inputTokens = 0, failure, cacheReadTokens, cacheCreationTokens): void => {
    record.status = status;
    // 批量请求的「首字节」就是响应头到达（body 已经整份读回）。
    record.ttfbMs = headersAt - started;
    if (outputTokens > 0) record.outputTokens = outputTokens;
    if (inputTokens > 0) record.inputTokens = inputTokens;
    // 缓存桶是「在场即有效」（0 也是有效样本），与 token 数的「>0 才记」
    // 不同：聚合要区分「上游没报」与「0 命中」，见 RequestRecord 字段注释。
    if (cacheReadTokens !== undefined) record.cacheReadTokens = cacheReadTokens;
    if (cacheCreationTokens !== undefined) record.cacheCreationTokens = cacheCreationTokens;
    if (failure) failStage(record, failure.stage, failure.error, failure.code);
    printRow(record);
    reportUsage();
  };

  let body: string | undefined;
  if (replay) {
    // 换号重放：复用第一次读到的 body。客户端的请求体流已经消费完了。
    // 这份 body 是第一次尝试注入 `config.defaultModel` 之后的形状（注入在
    // 下面首次读取的分支里做），这里不再重复 —— 重跑一遍只是幂等空转。
    body = replay.body;
  } else {
    try {
      body = await readBody(clientReq);
    } catch (err) {
      // 这两个出口不打表格行（旧实现也不打：连 body 都没读成，没有可展示的请求），
      // 但记录上要能看出它停在这里。
      failStage(record, "intake", (err as Error).message, "other");
      record.status = err instanceof InflatedBodyTooLargeError ? 413 : 400;
      if (err instanceof InflatedBodyTooLargeError) {
        return errorResponse(413, "request_too_large", err.message, undefined, "other");
      }
      return errorResponse(400, "invalid_request_error", (err as Error).message, undefined, "other");
    }

    // ── 默认模型注入（config.defaultModel 接进主链路）──────────────────────
    //
    // `defaultModel` 配置字段的存在意义就是「客户端不带 model 时的缺省」
    // （config/types.ts 该字段注释的原话）。主链路必须在这里消费它，否则聊天页
    // 「服务端默认」（body 不带 model）出线就缺 model，上游回
    // `{"code":3001,"msg":"parameter error"}`（2026-11-08 用户实测）。
    // 注入语义与顺序关系见 `default-model.ts` 文件头：
    // 在 peekBody / 模型能力过滤 / 路由选择**之前**补缺，注入值与显式指定
    // 不可区分、同样接受过滤（不特判）；显式 model 一个字节不动；config 为空
    // 串则不注入（不替用户选模型）。
    //
    // 记录口径：intake 阶段与 dump 记**注入后**的值 —— 请求
    // 记录描述的是实际出线的形状，不是客户端方言；`requestBytes` 维持字段契约
    // 「读入的原始请求体字节数（改写前）」，所以注入前的长度先取好，注入补上的
    // 字节不计入。真注入了的请求在 intake 阶段打 `modelInjected: true`，让
    // 「model 与原始字节对不上」在记录上自解释。
    const rawRequestBytes = body?.length ?? 0;
    const defaulted = injectDefaultModel(body, config);
    body = defaulted.body;
    record.requestBytes = rawRequestBytes;
    // 只在真注入了才落：`modelInjected` 是可选字段，false 也写会让 requests.jsonl
    // 里的每条旧记录都多一个键（记录口径见 default-model.ts 文件头）。
    if (defaulted.injected) record.modelInjected = true;
  }

  // 入站形状：模型与是否流式决定路由、能力过滤与表格的模式列，所以读到的第一件事
  // 就把它们落到记录上。后续代码只读 `record.model`，不再另行解析 body。
  // （`model` 是注入后的值 —— 见上方注入点注释的记录口径。）
  // `reasoningEffort` 与 model/stream 同一次 parse（`peekBody`），三套协议的
  // 词汇收敛在 `reasoning-effort.ts` 里；这里只负责落字段与阶段项。
  const shape = peekBody(body);
  record.model = shape.model;
  record.stream = shape.stream;
  if (shape.reasoningEffort !== undefined) record.reasoningEffort = shape.reasoningEffort;

  // 推理强度覆盖（面板 reasoning 段）。resolve 一次，两个消费者共用同一
  // 结果：落 record 字段（与客户端原始要求 `reasoningEffort` 并排，见该字段注释）
  // + 传给 transformRequestBody 改写 body（provider/effort-override.ts 是唯一
  // 判定真源，记录与改写不可能分叉）。undefined = 透传或不在作用范围，body 原样。
  const effortOverride = resolveEffortOverride(config, record.model);
  if (effortOverride !== undefined) record.reasoningEffortOverride = effortOverride;

  // ── 显式路由头（X-ZCode-Route）──
  // 解析放在 intake 之前：intake 阶段要记下客户端指定了哪条路由；非法值在这里
  // 直接 400 出局，不进调度。静默忽略会让这个头变成「建议」——X-ZCode-Account
  // 同样要求「显式指定，不静默改道」，见 `requestedRoute`。
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

  // ── 阶段 intake：这次请求是什么形状 ──
  // 时间线的第一条，也是排查「包有没有被读坏」的基准：`bytes` 是读入的原始字节数，
  // 后面的 `body` 阶段报的是改写后的字节数，两者不相等是正常的（注入 / model 改写）。
  // X-ZCode-Route 显式指定了才记 route 字段；dispatch 阶段的 route 是调度选出来的结果。
  // `model` 记注入后的值；`modelInjected` = 这次补了 config.defaultModel
  // （default-model.ts 文件头的「记录口径」），没有它这个差异得靠人肉对 dump 才能发现。
  addStage(record, "intake", {
    format,
    model: record.model,
    stream: record.stream,
    bytes: record.requestBytes,
    clientKind: record.clientKind,
    // 推理强度只在客户端表达了意图时落（undefined = 没说，不猜）。
    ...(record.reasoningEffort !== undefined ? { reasoningEffort: record.reasoningEffort } : {}),
    // 覆盖命中时落档位（undefined = 透传或模型不在作用范围）。
    ...(record.reasoningEffortOverride !== undefined
      ? { reasoningEffortOverride: record.reasoningEffortOverride }
      : {}),
    ...(record.modelInjected ? { modelInjected: true } : {}),
    ...(explicitRoute !== undefined ? { route: explicitRoute } : {}),
  });

  if (!replay && dumpEnabled()) {
    dumpPhase(reqId, "intake", {
      method: clientReq.method,
      url: clientReq.url,
      headers: dumpHeaders(clientReq.headers),
      body: dumpBody(body),
    });
  }

  // ── 会话身份的规范形状 ──
  // 上游恒为 Anthropic 形状（只剩一种出线协议），所以这里只做一件与路由无关的
  // 事：OpenAI 入站先归一到**规范形状**（Anthropic），专供 lineage 哈希与会话推断。
  // 这是「推断先于路由改写」的前提：body 一旦被路由相关的改写（system prompt 注入 / model
  // 改写）动过，同一会话在不同路由上就会算出不同的 sessionId，粘性当场失效。
  const canonicalBody = format === "openai" ? translateOpenAIBody(body) : body;
  if (canonicalBody instanceof Response) {
    record.status = canonicalBody.status;
    failStage(record, "translate", "OpenAI→Anthropic translation failed", "translate-failed");
    return canonicalBody;
  }
  if (verbose && format === "openai") {
    log.debug("openai→anthropic canonical", { reqId, bytes: canonicalBody?.length ?? 0 });
  }

  // ── 会话身份 ──
  // 必须在**路由选择之前**算：sessionId 是粘性绑定与哈希的输入。
  // 输入用 `upstreamBody`（翻译后的 anthropic 形状，与上游会话对齐），且此刻还没做
  // system prompt 注入 / model 改写（那些在 `transformRequestBody` 与 highspeed 挂卡里，
  // 都在下面），这正是会话推断要求的顺序：
  //
  //   解析客户端 body → 推断会话键 → 路由选择 → 推断 sessionId → body 改写 → 发出
  //
  // sessionId 自己带账号种子（一账号一命名空间），所以它只能在拿到租约之后算；而选号又需要会话
  // 键，于是推断拆成两段：这里算账号无关的指纹（粘性键），选号后 `finalize` 出
  // sessionId。两段共用同一条血缘链，同一请求只做一次 O(body) 哈希。
  //
  // Session affinity 在转换后的 anthropic 侧计算：上游请求恒为 Anthropic 形状，
  // OpenAI 客户端与 Anthropic 客户端的同一逻辑对话得到同构的 canonical 身份
  // （hash 谱系/任务身份与上游会话对齐，而非客户端方言）。
  // （2026-10-24 网关规则再变，issue #71：不再因客户端 system 强制 subagent
  // 会话身份；custom 两块形态已全灭，客户端 system 走默认三块 + main。）
  const sessionFingerprint = inferSessionFingerprint({ clientReq, body: canonicalBody, traceBody: body, upstreamFormat: "anthropic", model: record.model, config });

  // ── 路由解析 ──
  // 取凭据不是"读进程里那份全局凭据"，而是"按 (account, route) 解析"：账号决定
  // 凭据与身份，路由决定端点、鉴权形态与叠加层。model 参与候选集过滤（模型能力矩阵）。
  // `"-"` 是 peekBody 在"请求体没写 model"时给的占位，不能拿去过滤（否则每个
  // 不带 model 的请求都会被判成"模型不支持"）。`X-ZCode-Account` 对应请求参数
  // `requestedAccount`：显式指定账号，不健康直接报错、不静默改道。
  // `X-ZCode-Route` 是同家族的 `pinnedRoute`：显式选档；两个头同带时钉到
  // (账号, 路由) 那一对。语义全集见 `requestedRoute`。
  // `sessionId` 只接 `explicit` / `lineage` 来源的键（`none` 不参与粘性）。
  const acquireStartedAt = Date.now();
  const acquired = await acquireLease(broker, {
    model: record.model === UNKNOWN_MODEL ? undefined : record.model,
    sessionId: sessionFingerprint?.stickyKey,
    requestedAccount: requestedAccountLabel(clientReq),
    pinnedRoute: explicitRoute,
    signal: clientReq.signal,
  });
  if (!acquired.ok) {
    log.error("error", { reqId, kind: acquired.type, message: acquired.message, stage: "dispatch" });
    // broker 拒绝是产生点——`acquireLease` 已把结构化原因码映射成 errorCode，
    // 与响应体、统计、展示三处同码（error 原文仍是 detail）。
    reportEnd(acquired.status, Date.now(), 0, 0, { stage: "dispatch", error: acquired.message, code: acquired.errorCode });
    return errorResponse(acquired.status, acquired.type, acquired.message, retryAfterHeader(acquired.retryAfterSeconds), acquired.errorCode);
  }
  const lease = acquired.lease;
  leaseSlot.current = lease;
  // 阶段 dispatch：谁出线、走哪条路由、在队列里等了多久。`queueMs` 是 acquire 的
  // 耗时（排队 + 选号），它比总耗时更能回答「为什么这个请求慢」。
  const queueMs = Date.now() - acquireStartedAt;
  record.account = lease.account.label;
  record.route = lease.route;
  record.queueMs = queueMs;
  addStage(record, "dispatch", { account: record.account, route: record.route, queueMs });
  // 阶段 retry：换号后的第二次尝试。放在拿到新租约之后登记，是因为 `nextAccount` /
  // `nextRoute` 要等调度器给出来才知道（换号一次，一个 reqId 一条时间线）。
  // `retries` 只数换号，不数同一账号的高低速退回，所以只有这里加。
  if (retry) {
    record.retries += 1;
    addStage(record, "retry", { event: "auth-rotation", reason: retry.reason, nextAccount: lease.account.label, nextRoute: lease.route });
  }
  // 会话身份的第二段（账号相关的那一半）：现在才有 accountId。`sessionFingerprint` 复用了上面
  // 那条血缘链，这里不会再哈希一遍 body。
  const clientSession = resolveSessionContext({ accountId: lease.account.id, clientReq, body: canonicalBody, traceBody: body, upstreamFormat: "anthropic", model: record.model, config, fingerprint: sessionFingerprint });
  // 阶段 session：会话身份从哪来、有多确定。`source=none` 是合法结果，
  // 它意味着这条请求不参与粘性，不是推断失败。
  addStage(record, "session", {
    sessionId: clientSession?.sessionId ?? "-",
    source: clientSession?.source ?? "none",
    confidence: clientSession?.confidence ?? 0,
  });
  // force 禁用会 abort 这份租约；它同时跟随客户端 abort，所以上游 fetch
  // 只接这一个 signal 就同时满足"客户端断开"与"账号被强制下线"两条路径。
  const upstreamSignal = lease.signal;
  const route: RouteKind = lease.route;
  // 出线层（签名、加速卡、MCP、endpoint routing）用的是 `auth/types.ts` 的凭据
  // 形状；租约里是 v2 账号凭据，在这里转一次（accounts/manager.ts::toAuthCredential）。
  const cred = toAuthCredential(lease.credential);
  // provider family 也不是全局配置：它是这份凭据的属性。
  const providerFamily = cred.provider;
  const baseUrl = routeUpstreamBaseUrl(route, providerFamily, config.providers);

  // Surfaces authenticate differently and an imported JWT-only credential only
  // satisfies one of them (auth/capabilities.ts). Forwarding the request anyway
  // would reach the upstream with an empty credential and come back as a 401
  // that names no cause, so refuse here with the requirement — gated on the
  // resolved route instead of the global plan. Which requirement
  // applies is itself a route fact (`llmSurfaceFor`): start-plan wants the JWT,
  // the rest want the apiKey pair.
  const credentialCheck = checkSurface(llmSurfaceFor(route), cred, route);
  if (!credentialCheck.ok) {
    log.error("error", { reqId, kind: "credential_incomplete", message: credentialCheck.message, stage: "route-facts" });
    reportEnd(503, Date.now(), 0, 0, { stage: "route-facts", error: credentialCheck.message, code: "auth-invalid" });
    return errorResponse(503, "credential_unavailable", credentialCheck.message, undefined, "auth-invalid");
  }

  // ── 路由事实与出线协议方向 ──
  // `layers` 是这条路由**要不要穿哪几层**的唯一真源：下面所有叠加层（仿冒头 /
  // system prompt / 签名 / captcha / 加速卡 / 会话亲和 / 归因头）一律读它，不再读
  // 「是不是 start-plan」这类路由判断；四条路由的既有行为由同一张表逐位复现。
  const spec = getRouteSpec(route);
  const layers = spec.layers;
  //
  // 出站协议恒为 Anthropic（只剩一种 `apiType`），入站协议（`format`）只决定
  // 要不要翻译：
  //   Anthropic 入站 → 直传
  //   OpenAI 入站    → openai-to-anthropic
  const upstreamFormat: Format = "anthropic";
  const translateMode = format === "openai";
  // 阶段 route-facts：这条路由穿了哪几层。四个布尔值就是叠加层的全部开关，它们与
  // 「route 是什么」分开登记，是因为路由改了而层没改（或反过来）是这类
  // bug 的典型形态。出线协议也在这里落定：它恒为 Anthropic。
  record.upstreamFormat = upstreamFormat;
  addStage(record, "route-facts", {
    upstreamFormat,
    impersonation: layers.impersonation,
    signing: layers.signing,
    captcha: layers.captcha,
    highspeed: layers.highspeed,
  });

  // OpenAI 入站已在上面归一到 Anthropic，Anthropic 入站原样。
  const upstreamBody: string | undefined = canonicalBody;

  // Bundle `E2e` 对每个 anthropic-kind 请求都注入 `metadata.user_id`（device/session
  // blob，从不含 account uuid）。它属于仿冒面（provider-kind 门控、非 plan 门控），
  // 所以由 `layers.impersonation` 决定。
  //
  // `device_id` 取**租约账号**的指纹：这一行躺在每个 anthropic 请求的
  // body 里，用全局值就是 N 个账号向网关报告同一个 device_id，那正是
  // 「一机多号」要禁的。
  //
  // `session_id` 与 `x-session-id` 头同源：上游两处都出自同一个
  // `ModelStatusContext.sessionId`，我们发两份不同的值等于让上游对不上账。
  // `sessionIdForHeader` 就是 header 那个取值点，两边必须读它。
  const metadataUserId = layers.impersonation
    ? buildAnthropicMetadataUserId(accountDeviceMid(lease.account) ?? "", sessionIdForHeader(clientSession))
    : undefined;
  // system prompt 三块注入是路由事实（`spec.injectsZcodeSystemPrompt`，只有
  // start-plan 为真：zcode.z.ai 网关缺身份块回 3012）。见 types.ts 该字段注释。
  let transformedBody = transformRequestBody(upstreamBody, {
    format: upstreamFormat,
    metadataUserId,
    injectZcodeSystem: spec.injectsZcodeSystemPrompt,
    provider: providerFamily,
    // 命中才传（undefined = 透传），见 intake 段 resolve 点的注释。
    ...(effortOverride !== undefined ? { effortOverride } : {}),
  });
  const transformBytes = transformedBody?.length ?? 0;
  addStage(record, "body", { transformBytes, injectZcodeSystem: spec.injectsZcodeSystemPrompt });

  // ── HighSpeed 加速卡（官方形态：挂卡 = 切路由，每账号独立卡槽）──
  //
  // 命中卡后出线路由从 `coding-plan` 切到 `highspeed`：端点换成
  // `accounts/routes.ts` 里已钉好的 `zcode.z.ai/api/v1/highspeed/anthropic`，鉴权换成
  // Coding Plan 双 JWT + 账号身份头 + `X-Highspeed-Card-ID`，且该请求不签名（官方
  // 静态规则：highspeed mode 永不签名）。**body 的 model 一个字都不改**（官方原文
  // 「加速只换端点不换模型」），卡上 model 与请求不一致时
  // `activeCardFor` 已经把这卡丢了，所以能走到这里的卡 model 必然与请求一致。
  //
  // 卡槽按账号取：同一进程里两个账号各有自己的 draw 循环与单卡槽，
  // 互不抢卡（派生权益必须继承同账号母体）。
  const highspeedSlots = opts.highspeed !== undefined ? opts.highspeed : getDefaultHighspeedSlots(config, broker.risk.jitterHeartbeat);
  // 卡槽按账号建。出口代理也按账号给：抽卡走的是这个账号的
  // 出口，否则同一个 IP 上会出现「推理在代理出口、抽卡在本机」的矛盾。
  const highspeedManager = highspeedSlots ? highspeedSlots.forAccount(lease.account, lease.egress) : null;
  // 可挂卡的前提是**这条路由本身可挂卡**（路由表 `layers.highspeed`，只有 coding-plan
  // 为真），而不是「不是 start-plan」：off-peak 也不该挂卡。
  const highspeedEligible = highspeedManager !== null
    && layers.highspeed
    && highspeedManager.isEligibleModel(record.model)
    && transformedBody !== undefined;
  let highspeedCard: HighspeedCard | undefined;
  let highspeedAuth: HighspeedAuth | undefined;
  let highspeedOrigPairs: UpstreamHeaderPair[] | undefined;
  if (highspeedManager && highspeedEligible) {
    // 身份从账号读：`Bigmodel-Target-Type` 与 TEAM 的两个头取自
    // `lease.account.credential.identity`，不再硬编码 PERSONAL。
    const auth = highspeedAuthFrom(lease.account);
    if (auth) {
      highspeedAuth = auth;
      highspeedManager.onRequest(record.model, clientSession?.upstreamSessionId, auth);
      const card = highspeedManager.activeCardFor(record.model);
      if (card) highspeedCard = card;
    }
  }
  // 阶段 highspeed：挂没挂上卡。`applied=false` 也是信息（没抽到卡 / 模型不合格 /
  // 卡过期），缺了它就无法区分「本来就没卡」与「挂卡逻辑没跑到」。
  addStage(record, "highspeed", { cardId: highspeedCard?.cardId ?? "-", applied: highspeedCard !== undefined });
  // 挂卡出线基准地址。不走 `config.providers` 覆盖：那两组键是
  // **各 family 自己的**端点（route-endpoint.ts），highspeed 是 zcode.z.ai 网关下的
  // 派生入口，拿 family 端点去改它只会拼出上游不认的地址。
  const highspeedBaseUrl = routeUpstreamBaseUrl("highspeed", providerFamily, config.providers);

  let captchaHeaders: Record<string, string> | undefined;
  // 在飞即活动：SSE 还在输出就不是空闲；流结束/请求
  // 完成时刷新 captcha 池与 highspeed 抽卡循环的空闲窗，长流式请求不得让池衰减、
  // 抽卡循环自熄（下一个 tool-loop turn 会落在被误判空闲抽干的池上）。captcha 侧
  // 用动态 import 维持懒加载纪律（coding-plan 永不加载 captcha 模块）；highspeed
  // 侧仅对合格请求记账（与 onRequest 同门）；不合格流量刷窗会让抽卡循环对永不
  // 挂卡的流量空转烧 draw 配额。
  // Only requests that actually entered onRequest may extend its auth's loop.
  const hsNoteEligible = highspeedAuth !== undefined;
  const noteInFlightEnded = (): void => {
    if (layers.captcha) void (opts.captcha ? Promise.resolve(opts.captcha) : loadCaptcha()).then((m) => m.noteDemand?.(lease.account.id)).catch(() => {});
    if (hsNoteEligible) highspeedManager?.noteActivity();
  };
  if (layers.captcha) {
    // Captcha 头在 start-plane 是承重结构（2026-10-23 实弹）：
    // 裸发是真实客户端永不产生的形态，ESA 边缘对之间歇性回**空体 502**（无源站
    // request-id，下方 403 挑战重试不认识这种失败，不会兜底）。获取失败必须有界重试
    // （configs 镜像 1h 快照/无负缓存、池内已含 25s+10s 等待，预算覆盖典型故障窗口）后诚实 503，
    // 绝不 fail-open 裸发；getCaptchaToken 返回 null = 服务端明示禁用 → 无头即正确形态。
    try {
      captchaHeaders = await acquireCaptchaWithRetry(async () => {
        const captcha = opts.captcha ?? (await loadCaptcha());
        const token = await captcha.getCaptchaToken(config.identity.appVersion, lease.account.id);
        return token ? { [captcha.RETRY_HEADERS.PARAM]: token.verifyParam, [captcha.RETRY_HEADERS.REGION]: token.region } : undefined;
      }, {
        budgetMs: resolveCaptchaAcquireBudgetMs(process.env.CAPTCHA_ACQUIRE_BUDGET_MS),
        signal: upstreamSignal,
        onRetry: (err) => log.debug("captcha acquire retry", { reqId, message: err.message }),
      });
    } catch (err) {
      log.error("error", { reqId, kind: "captcha_solver_failed", message: (err as Error).message, stage: "captcha" });
      reportEnd(503, Date.now(), 0, 0, { stage: "captcha", error: (err as Error).message, code: CAPTCHA_FAILED_CODE });
      return errorResponse(503, "captcha_solver_failed", `Captcha acquisition failed: ${(err as Error).message}. The start-plan edge rejects captcha-less requests — retry shortly.`, undefined, CAPTCHA_FAILED_CODE);
    }
  }

  const useOrderedTransport = shouldUseOrderedTransport(clientSession, hasCustomFetchImpl);
  let upstreamHeaderPairs = buildUpstreamHeaderPairs(clientReq, cred, config.identity, route, captchaHeaders, clientSession);
  if (highspeedCard && highspeedAuth) {
    highspeedOrigPairs = upstreamHeaderPairs;
    upstreamHeaderPairs = applyHighspeedCardHeaders(upstreamHeaderPairs, highspeedCard, highspeedAuth);
  }
  let upstreamReq = buildUpstreamRequest(clientReq, highspeedCard ? highspeedBaseUrl : baseUrl, cred, transformedBody, config.identity, route, captchaHeaders, clientSession);
  if (highspeedCard && highspeedAuth) {
    // dispatch reuses the pre-built Request whenever the signer returns the
    // pairs unchanged (unsigned path) — rebuild it from the swapped pairs so
    // the card headers actually reach the wire (buildUpstreamRequest derives
    // its own header set internally).
    upstreamReq = new Request(upstreamReq.url, {
      method: upstreamReq.method,
      headers: Object.fromEntries(upstreamHeaderPairs),
      body: transformedBody ?? undefined,
    });
  }

  const routing = opts.endpointRouting !== undefined ? opts.endpointRouting : getDefaultEndpointRouting(config, lease.egress);
  /**
   * 这条路由的签名器（静态规则）：`layers.signing` 为假时恒为 `null`。
   * start-plan / off-peak / highspeed 永不签名（签名材料是 coding-plan 凭据）。
   * highspeed 挂卡也不签（官方 3.15.1 `TUs` 静态规则）。这是签名的**唯一判定点**，
   * 挂卡退回时也走它。
   */
  const routeSigner = (): ClientSigningManager | null => {
    if (!layers.signing) return null;
    return opts.clientSigning !== undefined ? opts.clientSigning : getDefaultClientSigning(config);
  };
  let signer = highspeedCard ? null : routeSigner();
  // When the ordered transport must READ the upstream body (translate mode), it
  // has to inflate whatever coding the upstream picks — cap the advertised
  // accept-encoding (a passthrough of the inbound client's list, which browsers
  // set to `gzip, deflate, br, zstd`) to what the transport can decompress.
  // The ultra CDN serves SSE brotli-compressed when `br` is advertised, and a
  // coding the transport cannot inflate would starve the SSE translator
  // (observed 2026-09-18 as 0-byte streams → client timeouts). Pure-passthrough
  // requests keep the client's list verbatim — the client decodes those itself.
  if (useOrderedTransport && translateMode) {
    upstreamHeaderPairs = capOrderedAcceptEncoding(upstreamHeaderPairs);
  }
  const dispatch = async (req: Request, pairs: UpstreamHeaderPair[]): Promise<Response> => {
    // 每一次 `dispatch()` 就是一次真实的上游出线（连接重试的第二次、加速卡
    // 退回、captcha 重试、换号重放全部经这里）。计数点放在最前面，因为后面任何一步
    // 抛出（路由改写失败、fetch 拒绝）都已经算"尝试过一次"。
    noteUpstreamAttempt(record);
    let sendUrl = req.url;
    let routingHeaderPairs: UpstreamHeaderPair[] | undefined;
    if (routing) {
      const routed = await routing.resolve(req.url, credentialString(cred), cred.jwt, lease.egress);
      if (routed.routed) {
        sendUrl = routed.url;
        routingHeaderPairs = routed.headers ? (Object.entries(routed.headers) as UpstreamHeaderPair[]) : undefined;
        log.debug("endpoint routed", { reqId, from: req.url, to: routed.url });
      }
    }
    // Signing decisions (exempt-path, handshake origin, bypass keying) run
    // against the PRE-routing provider URL — the client's signer wraps the
    // routing transport, so its checks see the original URL too.
    return sendWithClientSigning(signer, {
      url: req.url,
      headerPairs: pairs,
      credential: credentialString(cred),
      oauthAccessToken: cred.oauthAccessToken,
      provider: cred.provider,
      appVersion: config.identity.appVersion,
      // 握手也是一次出线：它必须走这个账号的代理，否则 fail-open 的
      // 未签名请求就从本机 IP 出去了。
      egress: lease.egress,
      debug: (message) => log.debug(message, { reqId }),
      send: (finalPairs) => {
        // 3.16.2 X-ZCode-Authorization: the client appends it inside its
        // routing wrapper, which sits INSIDE the signing wrapper — so on the
        // wire it lands after the signature block, as the very last header.
        const outboundPairs = routingHeaderPairs ? [...finalPairs, ...routingHeaderPairs] : finalPairs;
        if (dumpEnabled()) {
          // Both lines carry the stage name `upstream-req`: the earlier one
          // shows the pre-routing URL and pre-signing header set, this one
          // captures what actually went on the wire (routed URL + signed
          // pairs) — they diverge silently otherwise and misled a 2026-09-18
          // debugging session. `signed` is what tells the two apart.
          dumpPhase(reqId, "upstream-req", {
            url: sendUrl,
            signed: outboundPairs.some(([k]) => k.toLowerCase() === "x-client-sig"),
            headers: dumpHeaders(new Headers(Object.fromEntries(outboundPairs))),
          });
        }
        const sendReq = sendUrl === req.url && outboundPairs === pairs
          ? req
          : new Request(sendUrl, {
              method: req.method,
              headers: Object.fromEntries(outboundPairs),
              body: transformedBody ?? undefined,
            });
        return sendUpstreamRequest(sendReq, outboundPairs, transformedBody, translateMode, useOrderedTransport, fetchImpl, upstreamSignal, hasCustomFetchImpl, lease.egress);
      },
    });
  };

  // 阶段 upstream-req：即将发出的那一次。`url` 是路由**前**的地址（改写自哪到哪由
  // `endpoint routed` 那行记），`signed` 说明签名层有没有参与。头只报**数量**：
  // 值里有凭据，所以这里不打头的值。
  record.upstreamUrl = upstreamReq.url;
  record.headerCount = upstreamHeaderPairs.length;
  record.signed = signer !== null;
  addStage(record, "upstream-req", { url: record.upstreamUrl, headerCount: record.headerCount, signed: record.signed });

  if (verbose) {
    // 体积大的排障细节（请求头 / body 预览）：只在 `serve debug` 时打，不跟级别走。
    log.debug("upstream request headers", { reqId, headers: formatHeaderPairs(upstreamReq.headers) });
    if (transformedBody) log.debug("upstream body preview", { reqId, preview: previewBody(transformedBody) });
  }

  if (dumpEnabled()) {
    dumpPhase(reqId, "upstream-req", {
      method: upstreamReq.method,
      url: upstreamReq.url,
      headers: dumpHeaders(upstreamReq.headers),
      body: dumpBody(transformedBody),
      upstreamFormat,
      translateMode,
      useOrderedTransport,
      injectZcodeSystem: spec.injectsZcodeSystemPrompt,
    });
  }

  let upstreamResp: Response;
  try {
    // Transient connect failures (DNS blip, TLS reset, Bun "Unable to
    // connect") happen a few times a day against the gateway. Retry the
    // CONNECT twice with a short backoff before surfacing a 502 — the
    // request never reached upstream, so resending is side-effect-free.
    // Guard rails: skip retry when the client already aborted or the ordered
    // transport flagged the failure postWrite; re-dispatch a FRESH Request
    // each attempt — a reused Request has its body stream marked used after
    // the first fetch (start-plan hits the plain pass-through path where
    // dispatch does NOT rebuild the Request).
    let dispatchAttempt = 0;
    upstreamResp = await dispatchWithConnectRetry(
      () => {
        dispatchAttempt += 1;
        const currentReq = dispatchAttempt === 1
          ? upstreamReq
          : highspeedCard
            // buildUpstreamRequest derives its own (uncarded) header set; a
            // carded rebuild must come from the swapped pairs — same reuse
            // hazard as the attempt-1 rebuild above
            ? new Request(upstreamReq.url, {
              method: upstreamReq.method,
              headers: Object.fromEntries(upstreamHeaderPairs),
              body: transformedBody ?? undefined,
            })
            : buildUpstreamRequest(clientReq, baseUrl, cred, transformedBody, config.identity, route, captchaHeaders, clientSession);
        return dispatch(currentReq, upstreamHeaderPairs);
      },
      {
        isAborted: () => upstreamSignal.aborted,
        onRetry: (attempt, err) => {
          // 连接失败是每个请求都可能碰上的瞬态事件，旧实现无条件打一行；换成 logger
          // 后落在 `warn`：默认级别下看得见，`logging.level=error` 时可以安静。
          log.warn("upstream connect retry", {
            reqId,
            message: err.message,
            attempt,
            attempts: MAX_CONNECT_ATTEMPTS,
            delayMs: 500 * attempt,
          });
        },
      },
    );
  } catch (err) {
    // connect 失败（`dispatchWithConnectRetry` 重试后仍失败）→ gateway
    // 信号进路由级熔断 streak（不冷却账号）。客户端已 abort 的不发——连接都
    // 还没建立，是客户端自己走的（同 clientAborted 归因纪律）。
    if (!upstreamSignal.aborted) {
      await observeUpstream(opts.broker, lease, { type: "connect-failed", detail: (err as Error).message });
    }
    log.error("error", { reqId, kind: "upstream_unreachable", message: (err as Error).message, stage: "upstream-req" });
    reportEnd(502, Date.now(), 0, 0, { stage: "upstream-req", error: (err as Error).message, code: CONNECT_FAILED_CODE });
    return errorResponse(502, "upstream_unreachable", (err as Error).message, undefined, CONNECT_FAILED_CODE);
  }
  const headersAt = Date.now();

  // 阶段 upstream-resp：首字节到达（TTFB）。`contentEncoding` 是上游选的压缩，
  // 直传模式下它必须原样回给客户端，所以这一条也是「压缩后来对不上」的第一现场。
  record.status = upstreamResp.status;
  record.ttfbMs = headersAt - started;
  record.contentEncoding = upstreamResp.headers.get("content-encoding") ?? "identity";
  addStage(record, "upstream-resp", {
    status: record.status,
    ttfbMs: record.ttfbMs,
    contentEncoding: record.contentEncoding,
  });

  if (verbose) {
    log.debug("upstream response headers", { reqId, headers: formatResponseHeaders(upstreamResp.headers) });
  }

  const isSseResponse = upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false;

  if (dumpEnabled()) {
    dumpPhase(reqId, "upstream-resp", {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: dumpHeaders(upstreamResp.headers),
      isSSE: isSseResponse,
      ttfbMs: headersAt - started,
    });
  }

  // 错误响应体里往往就是原因（那张 500 的单子最后靠用户从客户端贴出
  // `ascii codec can't encode character '—'` 才有线索）。两个判据：
  // - 非 SSE：SSE 上 `clone()` 会把整条流缓冲进内存，破坏流式的初衷；
  // - 状态码 >= 400：正常响应是常态，复制一份的代价与请求数成正比。
  // 读的是副本，所以下面任何一条透传路径都不受影响。
  if (dumpEnabled() && !isSseResponse && upstreamResp.status >= 400) {
    dumpPhase(reqId, "upstream-error-body", {
      status: upstreamResp.status,
      body: dumpBody(await peekResponseBody(upstreamResp, UPSTREAM_ERROR_BODY_LIMIT)),
    });
  }

  if (upstreamResp.status === 401 && routeUsesPlanJwt(route)) {
    // JWT 失效也是 auth 信号（健康域照常记账——5min 冷却 + 计数），只是不换号
    // （换成另一个 start-plan 账号只是把同一个问题掩起来），所以走早退分支。
    await observeUpstream(opts.broker, lease, upstreamResp);
    log.error("error", { reqId, kind: "start_plan_jwt_invalid", message: "JWT rejected upstream", stage: "upstream-resp" });
    reportEnd(401, headersAt, 0, 0, { stage: "upstream-resp", error: "JWT rejected upstream", code: "upstream-auth-rejected" });
    return errorResponse(401, "start_plan_jwt_invalid", "Start-plan JWT was rejected. Re-run: zcode-proxy auth login", undefined, "upstream-auth-rejected");
  }

  // ── highspeed 失败退回（官方规范）──
  //
  // 官方原文：「任一次 Highspeed 请求失败时——卡过期的 HTTP 400 /
  // provider_code=3402、鉴权失败、限流、5xx、网络错误、超时、流中断等**任何失败**
  // ——Agent 必须保留已完成的工具结果和对话上下文，将该 Turn 剩余的模型请求切回
  // 发送前的原始 session 模型，且不得把加速请求的失败作为整轮失败上抛」。
  //
  // 落点（3 件）：
  // 1. **弃卡**：任何失败都说明这张卡不应继续用（官方 `invalidateCard` 同理）；
  // 2. **切回 coding-plan**：重发时 URL 用 `baseUrl`（coding-plan）、模型用
  //    客户端原值（我们从来没改过它）、鉴权用 coding-plan 双头并**恢复签名**；
  // 3. **只提示一次**：整轮只回写一行日志 + 一个响应头（`HIGHSPEED_FALLBACK_HEADER`），
  //    客户端收到的是**一个**正常完成的响应，不是错误。
  //
  // 注：流中断（已回写字节之后的失败）无法重放，那一段只能弃卡，让客户端的下一
  // 轮/重试落回 coding-plan（见下方 `observeStream` 的 `onFailure`）。
  if (highspeedCard && highspeedManager && highspeedOrigPairs !== undefined
    && (await isHighspeedFailure(upstreamResp))) {
    // 降级原因必须在重发**之前**取：重发成功后 upstreamResp 已经被换成新响应，
    // 它的状态码不再代表加速请求的失败类型（官方 3402 规则靠 400 识别）。
    const failedStatus = upstreamResp.status;
    // 阶段 retry：挂卡失败退回 coding-plan。这是「同一个逻辑请求走了两次」的
    // 第二种形态（第一种是 auth-failed 换号），两个都在 `retry` 阶段下。`retries`
    // 不在这里加：账号没换，只是换了路由。
    addStage(record, "retry", {
      event: "highspeed-fallback",
      reason: "highspeed-fallback",
      nextAccount: lease.account.label,
      nextRoute: route,
    });
    highspeedManager.dropCard(`upstream_failed_${failedStatus}`);
    // restore + re-cap: highspeedOrigPairs was captured BEFORE the ordered-
    // transport accept-encoding cap, which only ran against the carded pairs
    // (same re-cap the captcha retry path performs after rebuilding pairs)
    upstreamHeaderPairs = useOrderedTransport && translateMode
      ? capOrderedAcceptEncoding(highspeedOrigPairs)
      : highspeedOrigPairs;
    signer = routeSigner();
    const fallbackReq = buildUpstreamRequest(clientReq, baseUrl, cred, transformedBody, config.identity, route, captchaHeaders, clientSession);
    try {
      upstreamResp = await dispatch(fallbackReq, upstreamHeaderPairs);
    } catch (err) {
      // connect 失败 → gateway 信号（同主 dispatch 的 catch，不冷却账号）。
      if (!upstreamSignal.aborted) {
        await observeUpstream(opts.broker, lease, { type: "connect-failed", detail: (err as Error).message });
      }
      log.error("error", { reqId, kind: "upstream_unreachable", message: (err as Error).message, stage: "upstream-req" });
      reportEnd(502, Date.now(), 0, 0, { stage: "upstream-req", error: (err as Error).message, code: CONNECT_FAILED_CODE });
      return errorResponse(502, "upstream_unreachable", (err as Error).message, undefined, CONNECT_FAILED_CODE);
    }
    upstreamResp = withHighspeedFallbackNotice(upstreamResp, failedStatus === 400 ? "card_expired" : "request_failed");
    log.debug("highspeed fallback dispatched", { reqId, status: upstreamResp.status });
  }

  // start-plan: on explicit captcha challenge, retry once with a fresh
  // pooled token (the challenged token was already consumed by this request;
  // getCaptchaToken takes the next pre-solved one). Detection covers the
  // response-header variant AND the in-body `{"code":3007}` variant (observed
  // 2026-08-29 as HTTP 400 JSON with no captcha header) via the shared
  // captcha-retry seam (used by /v1/responses too).
  //
  // 挑战重试在统一观测点**之前**——被自家重试层消化掉的挑战不是上游失败，
  // 不该进健康域（3007 的 auth 信号留给你够不着重试的漏网形态；重试拿到的最终
  // 响应才是要观测的事实）。
  const captcha = layers.captcha ? (opts.captcha ?? (await loadCaptcha())) : null;
  const captchaChallenge = captcha ? await isCaptchaChallenged(upstreamResp, captcha) : false;
  if (captchaChallenge && captcha) {
    log.debug("captcha challenge, re-solving", { reqId });
    const outcome = await retryOnCaptchaChallenge({
      captcha,
      appVersion: config.identity.appVersion,
      accountId: lease.account.id,
      challengedResp: upstreamResp,
      debug: (message) => log.debug(message, { reqId }),
      solveAndRetry: (retryHeaders) => {
        log.debug("captcha re-solved", { reqId, tokenLength: retryHeaders[captcha.RETRY_HEADERS.PARAM].length });
        upstreamHeaderPairs = buildUpstreamHeaderPairs(clientReq, cred, config.identity, route, retryHeaders, clientSession);
        if (useOrderedTransport && translateMode) {
          upstreamHeaderPairs = capOrderedAcceptEncoding(upstreamHeaderPairs);
        }
        upstreamReq = buildUpstreamRequest(clientReq, baseUrl, cred, transformedBody, config.identity, route, retryHeaders, clientSession);
        return dispatch(upstreamReq, upstreamHeaderPairs).then((resp) => {
          log.debug("captcha retry dispatched", { reqId, status: resp.status });
          return resp;
        });
      },
      mapError: (err, phase) => {
        if (phase === "solver") {
          log.error("error", { reqId, kind: "captcha_solver_failed", message: err.message, stage: "captcha" });
          reportEnd(503, Date.now(), 0, 0, { stage: "captcha", error: err.message, code: CAPTCHA_FAILED_CODE });
          return errorResponse(503, "captcha_solver_failed", err.message, undefined, CAPTCHA_FAILED_CODE);
        }
        // 重试出线的 connect 失败同款进 gateway streak（fire-and-forget：
        // mapError 是同步契约，观测不挡错误响应的返回）。
        if (!upstreamSignal.aborted) {
          void observeUpstream(opts.broker, lease, { type: "connect-failed", detail: err.message }).catch(() => {});
        }
        log.error("error", { reqId, kind: "upstream_unreachable", message: err.message, stage: "upstream-req" });
        reportEnd(502, Date.now(), 0, 0, { stage: "upstream-req", error: err.message, code: CONNECT_FAILED_CODE });
        return errorResponse(502, "upstream_unreachable", err.message, undefined, CONNECT_FAILED_CODE);
      },
    });
    if (!outcome.ok) return outcome.resp;
    upstreamResp = outcome.resp;
  }

  // ── 统一观测点：最终上游响应 → observeUpstream ──────────────────────────────
  //
  // 全状态码解析（signals.ts `signalFromResponse`）→ 健康引擎：
  // 429 → 冷却（`Retry-After` 无 cap 采信）；额度终态码 → drained（含 5xx 信封形态）；
  // 405/404 → 路由级 endpoint-shape 记账（不冷却账号）；401/403 →
  // auth。观察是**旁路**的：只读 `clone()`，响应仍按原路径透给客户端（流式一行不动）。
  //
  // 位置：任何字节回写之前、highspeed 弃卡与 captcha 重试之后——被自家重试层换掉的
  // 中间响应不是「这一次出线的结果」，只观测最终那一个。旧 `noteUpstreamFailure`
  // （仅 429/白名单状态码）与 `isAuthFailedSignal` 特判在此合并为信号驱动。
  const observed = await observeUpstream(opts.broker, lease, upstreamResp);
  /**
   * 本次出线的统一身份（三出口同源）。`success` 信号不给 errorCode；
   * 非 2xx 的每个 kind 都映射到上游族全表。透传 / 换号兜底 / 翻译失败出口共用它，
   * 不再各写一份分类。`upstream-error.ts` 的 `errorCodeOf(signal.kind)` 是唯一派生点。
   */
  const responseCode = observed.errorCode ?? "upstream-error";

  // ── auth 信号 → 换同路由其他账号（不降级）──
  //
  // 位置很关键，必须同时满足三个条件：
  // 1. **在任何字节回写之前**，所以放在所有 body 读取/翻译之前；
  // 2. **在 highspeed 弃卡之后**：挂卡请求的 401 是"卡被拒"，弃卡重发才是正确
  //    动作（官方 selectionFallback），不能当成账号鉴权失败去换号；
  // 3. **鉴权就是 plan JWT 的路由除外**（`routeUsesPlanJwt`：start-plan）：那条路由的
  //    401 是 JWT 失效，已有专门分支（上方）把原因告诉用户，换成另一个 start-plan
  //    账号只是把同一个问题掩起来。
  //
  // 判定读信号（`signal.kind === "auth"`，含 3007/1006 与裸 401/403，查表优先
  // 于状态——403+1313 是 fair-usage 不是 auth，不换号），没有独立的 401/403 状态
  // 检测函数；额度耗尽是另一种 kind（drained 走降级，三种切走之一），天然不进这里。
  if (!routeUsesPlanJwt(route) && observed.signal.kind === "auth") {
    // 换号由外层（`proxyRequest`）做，这里只把原因带出去：`stage=retry` 要等
    // `acquireLease` 给了下一个账号才打得准（`nextAccount` / `nextRoute`）。
    const reason = `upstream_${upstreamResp.status}`;
    return {
      body,
      lease,
      reason,
      discard: () => {
        // 换号成功后这份错误响应不会再被读；不 cancel 会白占一个上游连接。
        // cancel 本身失败（连接已断）不影响换号，故不处理它的拒绝。
        void upstreamResp.body?.cancel().catch(() => undefined);
      },
      fallback: () => upstreamErrorPassthrough(upstreamResp, headersAt, reportEnd, record, responseCode),
    };
  }

  const isSSE = upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false;

  // 上面两处（highspeed 退回、captcha 重试）可能已经把 `upstreamResp` 换掉了。阶段里
  // 那一条 `upstream-resp` 保留第一次的样子（那是时间线上真实发生过的事），而记录的
  // 最终事实要跟上：表格行、用量的错误计数、直传的编码判定都读这里。
  record.status = upstreamResp.status;
  record.contentEncoding = upstreamResp.headers.get("content-encoding") ?? "identity";

  // 「流中断」分支：已经向客户端回写了字节的失败**无法重放**（只能让
  // 客户端看到截断的流），所以退回动作退化成"当场作废这张卡"，下一轮（客户端的重试
  // 或下一个 tool-loop turn）自然落回 coding-plan，而不是继续拿一张坏卡去撞。
  const cardedStreamFailed = highspeedCard && highspeedManager
    ? (): void => highspeedManager.dropCard("stream_interrupted")
    : undefined;

  // 流层信号回传口。`observeStream` 的 onSignal 把 error 帧 /
  // 空流 / 流中断送回唯一观测点——译码器与统计旁路都不直接碰 broker，健康动作只在
  // observeUpstream 一处发生。
  /**
   * 流式出口的失败信号（error 帧 / 空流 / 流中断）异步到达时补 errorCode。
   *
   * 记录已在 `observeStream` 里落过 `failedStage` / `error`（缺省 `other`），这里把
   * 观察结果的统一身份覆盖回去——统计与展示读的是同一个字段。无信号的成功流不动它。
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

  // 阶段 stream-end 由 `observeStream` 登记（它才有流结束那一刻的 `usage`）。

  if (translateMode) {
    if (!upstreamResp.ok) {
      return upstreamErrorPassthrough(upstreamResp, headersAt, reportEnd, record, responseCode);
    }
    if (isSSE && upstreamResp.body) {
      // 翻译流的 OpenAI usage 装不下 cache_creation 桶（strict-schema 客户端
      // 拒未知成员，anthropicUsageToOpenAI 有意不镜像），所以缓存桶从翻译器内部的
      // Anthropic 快照观察（onUsage，每次上游折用量后回调）；cache_read 在翻译
      // 流上由 StreamMetrics 从 prompt_tokens_details 补一份（同值，后写覆盖先写）。
      // 流式出口置 deferred：落盘延到流收尾（onFinal → requests.finalize）。
      if (persistSlot) persistSlot.deferred = true;
      const translated = anthropicSseToOpenaiSse(upstreamResp.body, record.model, observeAnthropicUsage(record));
      const [clientBody, statsBody] = translated.tee();
      // 流式收尾（填记录、打表格行、用量记账）在 `observeStream` 里，包括 `onEnd`
      // 里的在飞记账：那个时刻才是「流真的走完了」，不是这里返回响应的时候。
      // 流层信号（error 帧经 AnthropicStreamError / 空流 / 流中断）从 onSignal
      // 回 observeUpstream（译码器不碰 broker）。
      observeStream(record, statsBody, () => {
        noteInFlightEnded();
        reportUsage();
      }, cardedStreamFailed, () => requests.finalize(record), upstreamSignal, streamSignal);
      return translatedSseResponse(clientBody);
    }
    const batchResp = await translatedBatchResponse(clientReq, upstreamResp, record.model, headersAt, reportEnd, record,
      (input) => observeUpstream(opts.broker, lease, input));
    noteInFlightEnded();
    return batchResp;
  }

  if (isSSE && upstreamResp.body) {
    // 直传流式同样落盘延到流收尾（统计旁路在流结束时才有完整用量）。
    if (persistSlot) persistSlot.deferred = true;
    const [clientBody, statsBody] = upstreamResp.body.tee();
    // 直传流的 error 帧（[1302] 前缀提取在 signals.ts）/ 空流 / 流中断同样
    // 从 onSignal 回 observeUpstream（含 zstd/br 压缩流解压解析）。
    observeStream(record, statsBody, () => {
      noteInFlightEnded();
      reportUsage();
    }, cardedStreamFailed, () => requests.finalize(record), upstreamSignal, streamSignal);
    return passthroughResponse(upstreamResp, clientAcceptsGzip(clientReq), clientBody);
  }

  // 直传（Anthropic 入站、非流式）：body 一个字节都不读（压缩字节与
  // `Content-Encoding` 原样透传），所以 token 数拿不到，只记请求与状态码。
  // 响应体字节靠一层纯转发的计数流（`countingPassthrough`）在流过时数；
  // 没有 body 时才回退到上游声明的 `content-length`。
  reportEnd(upstreamResp.status, headersAt, 0);
  noteInFlightEnded();
  const passBody = upstreamResp.body ? countingPassthrough(upstreamResp.body, record) : undefined;
  if (!passBody) noteDeclaredResponseBytes(record, upstreamResp);
  return passthroughResponse(upstreamResp, clientAcceptsGzip(clientReq), passBody);
}
