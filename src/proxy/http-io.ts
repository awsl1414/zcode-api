import type { ClientSessionResult } from "./client-session.js";
import type { ErrorCode } from "./error-codes.js";
import { fetchWithEgress, type EgressOptions } from "./egress.js";
import { inflateWithCap } from "./inflate.js";
import { orderedAdvertisedCodings, sendOrderedUpstreamRequest } from "./ordered-transport.js";
import type { UpstreamHeaderPair } from "./upstream.js";

export function shouldUseOrderedTransport(clientSession: ClientSessionResult | undefined, hasCustomFetchImpl: boolean): boolean {
  if (hasCustomFetchImpl) return false;
  return clientSession?.action === "enforce" || clientSession?.source === "explicit";
}

/**
 * Restrict an ordered-transport header-pair list's `accept-encoding` to codings
 * the transport can inflate itself (see ordered-transport.ts). Preserves the
 * client's token order, drops q-weights and unsupported tokens (including `*`),
 * and falls back to `identity` when nothing remains. Header order is untouched —
 * only the value at the existing position changes.
 */
export function capOrderedAcceptEncoding(
  pairs: UpstreamHeaderPair[],
  supported: readonly string[] = orderedAdvertisedCodings(),
): UpstreamHeaderPair[] {
  const idx = pairs.findIndex(([name]) => name.toLowerCase() === "accept-encoding");
  if (idx < 0) return pairs;
  const advertised = pairs[idx][1];
  const tokens = advertised
    .split(",")
    .map((token) => token.split(";")[0]!.trim().toLowerCase())
    .filter((token) => token.length > 0);
  const kept = tokens.filter((token) => token === "identity" || supported.includes(token));
  if (kept.length === tokens.length) return pairs;
  const next = kept.length > 0 ? kept.join(", ") : "identity";
  return pairs.map((pair, i) => (i === idx ? [pair[0], next] as UpstreamHeaderPair : pair));
}

/** Max attempts (initial + 2 retries) for transient CONNECT-level failures. */
export const MAX_CONNECT_ATTEMPTS = 3;

/**
 * Connect-level retry ladder shared by the chat hot path and /v1/responses.
 * Transient connect failures (DNS blip, TLS reset, Bun "Unable to connect")
 * happen a few times a day against the gateway; the request never reached
 * upstream, so resending is side-effect-free.
 *
 * Contract (review follow-ups, PR #34/#35):
 *   - `attemptDispatch` must dispatch a FRESH request each call — a reused
 *     Request has its body stream marked used after the first fetch.
 *   - failures flagged `postWrite` (ordered transport already wrote the full
 *     request) are never retried — the upstream may have processed it.
 *   - no retry once the client aborted (`opts.isAborted`).
 */
export async function dispatchWithConnectRetry(
  attemptDispatch: () => Promise<Response>,
  opts: { isAborted?: () => boolean; onRetry?: (attempt: number, err: Error) => void } = {},
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    if (opts.isAborted?.()) throw new Error("client aborted before upstream connect");
    try {
      return await attemptDispatch();
    } catch (err) {
      if ((err as { postWrite?: boolean }).postWrite) throw err;
      if (attempt >= MAX_CONNECT_ATTEMPTS) throw err;
      const backoffMs = 500 * attempt;
      opts.onRetry?.(attempt, err as Error);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}

export async function sendUpstreamRequest(
  upstreamReq: Request,
  headerPairs: UpstreamHeaderPair[],
  body: string | undefined,
  translateMode: boolean,
  useOrderedTransport: boolean,
  fetchImpl: typeof fetch,
  abortSignal?: AbortSignal,
  // 末位 egress 仍按位置传参，这里保留调用点仍在传的布尔值；出线逻辑不使用它。
  _hasCustomFetchImpl = false,
  egress?: EgressOptions,
): Promise<Response> {
  if (useOrderedTransport) {
    return sendOrderedUpstreamRequest({
      url: upstreamReq.url,
      method: upstreamReq.method,
      headers: headerPairs,
      body,
      decompress: translateMode,
      signal: abortSignal,
      // 出口代理：agent 只换 socket，压缩字节与 `Content-Encoding` 一个都
      // 不经过代理层。
      egress,
    });
  }
  const fetchOpts: RequestInit & { decompress?: boolean } = translateMode ? {} : { decompress: false };
  if (abortSignal) fetchOpts.signal = abortSignal;
  // 注入的 fetchImpl 原样调用（`fetchVia` 内部判），所以测试的 mock 不被绕过。
  return fetchWithEgress(fetchImpl, upstreamReq, fetchOpts, egress);
}

/**
 * Read the request body as a string, returning undefined for empty bodies.
 * Transparently inflates `content-encoding: gzip` request bodies (the OpenAI /
 * Anthropic upstreams accept gzipped request bodies; without this, clients
 * that send them got a misleading "body is not valid JSON" 400). Corrupt gzip
 * throws a descriptive Error; inflation past `MAX_INFLATED_BODY_BYTES` throws
 * `InflatedBodyTooLargeError` (streamed + aborted early, so a small wire
 * payload cannot expand into unbounded proxy memory).
 */
export async function readBody(req: Request): Promise<string | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0) return undefined;
  const encoding = req.headers.get("content-encoding")?.toLowerCase().trim() ?? "";
  if (encoding === "gzip" || encoding === "x-gzip") {
    return new TextDecoder().decode(await inflateGzipBody(bytes));
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Decompressed-size ceiling for gzip request bodies. Generous by design:
 * plain bodies on `/v1/*` routes are intentionally uncapped (long-context LLM
 * requests reach several MB), so this only rejects pathological amplification.
 */
const MAX_INFLATED_BODY_BYTES = 64 * 1024 * 1024;

/** Thrown when a gzip request body expands past MAX_INFLATED_BODY_BYTES. */
export class InflatedBodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`gzip request body exceeds ${limit} bytes after decompression`);
    this.name = "InflatedBodyTooLargeError";
  }
}

async function inflateGzipBody(bytes: Uint8Array): Promise<Uint8Array> {
  const result = await inflateWithCap(bytes, MAX_INFLATED_BODY_BYTES);
  if (!result.ok) {
    if (result.reason === "too_large") throw new InflatedBodyTooLargeError(MAX_INFLATED_BODY_BYTES);
    throw new Error(`request body is marked content-encoding: gzip but failed to decompress: ${result.detail}`);
  }
  return result.bytes;
}

/**
 * 错误响应：`type` 仍是协议层的既有值，`message` 是 detail 原文，
 * `error.code` 是**产生点**传进来的稳定身份（errorCode 全表）。
 *
 * `extraHeaders` 目前只用于容量类拒绝的 `Retry-After`：429 不带它的话客户端
 * 只能自己猜重试节奏，而猜错的重试风暴比 429 本身更伤上游。
 *
 * 缺省落 `other`——诚实兜底，不从 `type` / `message` 猜。客户端、终端、面板三处
 * 因此与 `RequestRecord.errorCode` 同源，不需要第二套映射。
 */
export function errorResponse(
  status: number,
  type: string,
  message: string,
  extraHeaders?: Record<string, string>,
  code: ErrorCode = "other",
): Response {
  const body = JSON.stringify({
    error: { type, message, code },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

/**
 * 容量类拒绝的 `Retry-After` 头。
 *
 * 没有建议秒数（非容量类拒绝）时返回 `undefined`，而不是塞一个默认值：503 的
 * `credential_unavailable` 不是"等一下再来"能解决的问题。
 */
export function retryAfterHeader(seconds: number | undefined): Record<string, string> | undefined {
  if (seconds === undefined) return undefined;
  return { "retry-after": String(seconds) };
}

/** True when the client request explicitly accepts gzip (and has not disabled it via q=0). */
export function clientAcceptsGzip(req: Request): boolean {
  const ae = req.headers.get("accept-encoding");
  if (!ae) return false;
  return /\bgzip\b(?!\s*;\s*q=0(?:\.0+)?\s*(?:,|$))/i.test(ae);
}
