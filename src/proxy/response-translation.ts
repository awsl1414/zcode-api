/**
 * 出线响应在交给客户端之前的成形：翻译（Anthropic JSON/SSE → OpenAI 形状）与
 * 直传（原样透出上游字节）。
 *
 * 三条出口都在这里成形，但**谁出线、什么时候出线**不归本模块管——那仍是
 * `handler.ts::proxyRequestOnLease` 的主链（唯一出线口，架构硬约束）。本模块
 * 只接收一个已经拿到手的上游 Response：
 *
 * - `translatedBatchResponse`：OpenAI 入站 + 非流式，Anthropic JSON → OpenAI JSON；
 * - `translatedSseResponse`：OpenAI 入站 + 流式，交给 `sse-translator.ts` 的流；
 * - `passthroughResponse`：直传壳（头白名单 + 按客户端 gzip 能力解压）；
 * - `upstreamErrorPassthrough`：翻译模式下的上游 4xx/5xx 原样透出。
 *
 * 记一账的唯一实现是 `ReportEnd`（`handler-utils.ts` 定义、`proxyRequestOnLease`
 * 构造）：这些出口不自己落 record 的结果字段，只通过它收尾。
 */
import { gzipSync } from "node:zlib";
import { upstreamBizCode } from "../accounts/signals.js";
import { translateRequestOpenAIToAnthropic, translateResponseAnthropicToOpenAI } from "../translator/openai-to-anthropic.js";
import type { AnthropicMessagesResponse, OpenAIChatRequest } from "../translator/types.js";
import type { ErrorCode } from "./error-codes.js";
import type { ReportEnd } from "./handler-utils.js";
import { clientAcceptsGzip, errorResponse, retryAfterHeader } from "./http-io.js";
import { markZeroOutput } from "./request-record.js";
import type { RequestRecord } from "./request-record.js";
import type { UpstreamEvent, UpstreamObservation } from "./upstream-error.js";

const TRANSLATE_FAILED_CODE: ErrorCode = "translate-failed";

/** Translate an OpenAI request body string to Anthropic JSON. Returns error Response on failure. */
export function translateOpenAIBody(body: string | undefined): Response | string | undefined {
  if (body === undefined || body.length === 0) {
    return errorResponse(400, "translation_failed", "OpenAI request body is empty; cannot translate.", undefined, "translate-failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return errorResponse(400, "translation_failed", `OpenAI request body is not valid JSON: ${(err as Error).message}`, undefined, "translate-failed");
  }
  try {
    const translated = translateRequestOpenAIToAnthropic(parsed as OpenAIChatRequest);
    return JSON.stringify(translated);
  } catch (err) {
    return errorResponse(400, "translation_failed", `OpenAI→Anthropic translation failed: ${(err as Error).message}`, undefined, "translate-failed");
  }
}

/** Build a translated batch (non-streaming) OpenAI response. Gzip if client accepts. */
export async function translatedBatchResponse(
  clientReq: Request,
  upstream: Response,
  model: string,
  headersAt: number,
  reportEnd: ReportEnd,
  /** 响应体字节的落点（`responseBytes`）。*/
  record: RequestRecord,
  /**
   * 统一观测点的入口（调用方闭包了 broker + lease）。「invalid Anthropic
   * message」分支的业务码/空流信号从这里汇入健康引擎——译码层不直接碰 broker。
   */
  observe: (input: UpstreamEvent) => Promise<UpstreamObservation>,
): Promise<Response> {
  const raw = await upstream.text();
  // 字节数在**任何解析之前**落：解析失败（上游回了 HTML 错误页）也是一份
  // 真实的响应体，正是排障时要看的那种。`Buffer.byteLength` 而不是 `raw.length`：
  // 后者是 UTF-16 码元数，中文/emoji 会话会少算一半以上。
  record.responseBytes = Buffer.byteLength(raw, "utf8");

  /**
   * 「invalid Anthropic message」两个分支共用的分流：
   *
   * - 有业务码（`signals.ts::upstreamBizCode`，2xx 信封的 1005 双形态在此汇合）→
   *   observeUpstream（quota-terminal 等按信号落健康）+ **语义化错误**：429 +
   *   `Retry-After` = 引擎 until（额度/限流的客户端语义是「稍后重试」，不是误导性
   *   的 502 translation_failed）；无 until（等采样确认）就不带该头，不猜值。
   * - 无码 → `empty-stream` 信号（200 软拒绝的非流式形态）+ `zeroOutput` 标记，
   *   返回 null 让调用方**维持** translation_failed 502（既有客户端语义不动）。
   */
  const envelopeFailure = async (detail: string, translateError: string): Promise<Response> => {
    const bizCode = upstreamBizCode(raw);
    if (bizCode !== undefined) {
      const observed = await observe({ type: "biz-code", code: bizCode, detail });
      // invalid message 有码 → 上游族 errorCode 直接从观察结果
      // 派生（quota-terminal 的 1005/1113 落 `upstream-quota-terminal`，其余按 kind）；
      // 无码 → `translate-failed`（上游响应无法解析）。零字符串判定。
      const code = observed.errorCode ?? "upstream-error";
      const until = observed.health.until;
      const retryAfterSeconds = until === undefined ? undefined : Math.max(1, Math.ceil((until - Date.now()) / 1000));
      reportEnd(429, headersAt, 0, 0, {
        stage: "upstream-resp",
        error: `upstream business code ${String(bizCode)} (${observed.signal.kind})`,
        code,
      });
      return errorResponse(
        429,
        observed.signal.kind === "quota-terminal" ? "quota_exhausted" : "rate_limited",
        `upstream business code ${String(bizCode)}: ${detail}`,
        retryAfterSeconds !== undefined ? retryAfterHeader(retryAfterSeconds) : undefined,
        code,
      );
    }
    await observe({ type: "empty-stream", detail });
    markZeroOutput(record);
    reportEnd(502, headersAt, 0, 0, { stage: "translate", error: translateError, code: TRANSLATE_FAILED_CODE });
    return errorResponse(502, "translation_failed", translateError, undefined, TRANSLATE_FAILED_CODE);
  };

  let parsedAnthropic: AnthropicMessagesResponse;
  try {
    parsedAnthropic = JSON.parse(raw) as AnthropicMessagesResponse;
  } catch (err) {
    return await envelopeFailure(`non-JSON body: ${(err as Error).message}`,
      `upstream returned non-JSON body: ${(err as Error).message}`);
  }
  if (!isAnthropicMessagesResponse(parsedAnthropic)) {
    return await envelopeFailure(raw.slice(0, 200),
      `upstream returned invalid Anthropic message: ${raw.slice(0, 200)}`);
  }
  const openaiResp = translateResponseAnthropicToOpenAI(parsedAnthropic, model);
  const json = JSON.stringify(openaiResp);
  const payload = new TextEncoder().encode(json);

  const respHeaders = new Headers();
  respHeaders.set("content-type", "application/json");
  for (const h of forwardedUpstreamHeaders()) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  if (clientAcceptsGzip(clientReq)) {
    respHeaders.set("content-encoding", "gzip");
    reportEnd(upstream.status, headersAt, openaiResp.usage?.completion_tokens ?? 0, openaiResp.usage?.prompt_tokens ?? 0,
      // 缓存桶从上游 Anthropic usage 直读（在场即有效：没报 = undefined，
      // 报了 = 数字，含 0）——翻译后的 OpenAI usage 只有 cache_read，creation
      // 桶在 OpenAI 形状里不存在，只能在上游形状还没丢的时候拿。
      undefined, parsedAnthropic.usage?.cache_read_input_tokens, parsedAnthropic.usage?.cache_creation_input_tokens);
    return new Response(gzipSync(payload), {
      status: upstream.status,
      headers: respHeaders,
    });
  }
  reportEnd(upstream.status, headersAt, openaiResp.usage?.completion_tokens ?? 0, openaiResp.usage?.prompt_tokens ?? 0,
    undefined, parsedAnthropic.usage?.cache_read_input_tokens, parsedAnthropic.usage?.cache_creation_input_tokens);
  return new Response(payload, {
    status: upstream.status,
    headers: respHeaders,
  });
}

/** Message 形状校验（`/v1/responses` 的批量信封分流同用：非此形状 = 非 Message 信封）。*/
export function isAnthropicMessagesResponse(value: unknown): value is AnthropicMessagesResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AnthropicMessagesResponse>;
  return candidate.type === "message" && candidate.role === "assistant" && Array.isArray(candidate.content);
}

function forwardedUpstreamHeaders(): string[] {
  return [
    "x-request-id",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
  ];
}

export function translatedSseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

/**
 * Translate-mode upstream failures pass the REAL status + body through
 * (issue #71): wrapping them as 502 made clients retry 405/429 as if they
 * were transient gateway faults. The upstream body (Anthropic error JSON)
 * is forwarded verbatim with its content-type.
 */
export async function upstreamErrorPassthrough(
  upstreamResp: Response,
  headersAt: number,
  reportEnd: ReportEnd,
  /** 错误响应体也是响应体，`responseBytes` 照样落（排障时"上游回了多少字节"）。*/
  record: RequestRecord,
  /** `observeUpstream` 同源派生的 errorCode（与健康层、统计层共读一个身份）。*/
  errorCode: ErrorCode,
): Promise<Response> {
  const errBody = await upstreamResp.text().catch(() => "");
  record.responseBytes = Buffer.byteLength(errBody, "utf8");
  // 上游的 4xx/5xx 也是一次失败（表格里看得到状态码，但记录里要有阶段可筛）。
  reportEnd(upstreamResp.status, headersAt, 0, 0, {
    stage: "upstream-resp",
    error: `upstream returned ${upstreamResp.status}`,
    code: errorCode,
  });
  return new Response(errBody, {
    status: upstreamResp.status,
    headers: { "content-type": upstreamResp.headers.get("content-type") ?? "application/json" },
  });
}

/**
 * 降级提示响应头（客户端只收到一次降级提示）。
 *
 * 官方客户端是一个结构化事件（`TurnExecutionModelFallback`）+ 一次 Renderer toast；
 * 反代里没有这个事件通道，所以把同样的事实用**响应头**带给下游：一个响应最多带
 * 一个值（整轮只退回一次），取值对齐官方两条规则
 * （`card_expired` = 3402 卡过期，`request_failed` = 其他失败）。
 */
export const HIGHSPEED_FALLBACK_HEADER = "x-zcode-highspeed-fallback";

/** 给已经退回 coding-plan 的响应打上一次性降级标记（body 不动，只加一个头）。*/
export function withHighspeedFallbackNotice(resp: Response, reason: string): Response {
  const headers = new Headers(resp.headers);
  headers.set(HIGHSPEED_FALLBACK_HEADER, reason);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

/**
 * Create a passthrough response that streams the upstream body to the client.
 * Preserves status and the allowlisted headers, and honors the client's
 * `Accept-Encoding` for gzip.
 *
 * The upstream request FORWARDS the client's `accept-encoding` (only
 * defaulting to "gzip" when the client sent none — see
 * `buildUpstreamHeaderPairs`), so the upstream compresses only when the
 * client can decode it. If THIS client did not advertise gzip but the body
 * arrived gzip-compressed anyway, we decompress before forwarding and drop
 * the now-mismatched `content-encoding`/`content-length` headers — otherwise
 * clients whose HTTP stack does not auto-decompress (e.g. some Tauri-based
 * clients) receive raw gzip bytes and fail to parse the JSON body with
 * "non-JSON body" errors despite a 200 status.
 */
export function passthroughResponse(
  upstream: Response,
  clientAcceptsGzip: boolean,
  body?: ReadableStream<Uint8Array>,
): Response {
  const headers = new Headers();
  const forwardHeaders = [
    "content-type",
    "content-encoding",
    "cache-control",
    "x-request-id",
    // 加速退回的唯一提示通道（见 withHighspeedFallbackNotice）。
    HIGHSPEED_FALLBACK_HEADER,
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
  ];

  for (const h of forwardHeaders) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }

  const upstreamEncoding = headers.get("content-encoding")?.toLowerCase() ?? "";
  const source = body ?? upstream.body;
  if (upstreamEncoding.includes("gzip") && !clientAcceptsGzip && source) {
    // SAFETY: `DecompressionStream` 在 TS 的 DOM lib 里被声明成 TransformStream 的子类型，
    // 而 `pipeThrough` 的入参要求 `ReadableWritablePair`；运行时的双工语义完全一致
    // （可读端是解压后字节，可写端吃压缩字节），只是 lib 的类型没有直接兼容这个别名。
    const gunzip = new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
    const decompressed = source.pipeThrough(gunzip);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(decompressed, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  return new Response(source, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
