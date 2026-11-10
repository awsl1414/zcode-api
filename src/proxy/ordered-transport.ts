import { egressForOptions, inflateFormatFor, requestVia, RESPONSE_CODINGS, type EgressOptions, type ViaInit } from "./egress.js";

type OrderedHeaderPair = [string, string];

export interface OrderedUpstreamRequest {
  url: string;
  method?: string;
  headers: OrderedHeaderPair[];
  body?: string | Uint8Array;
  decompress?: boolean;
  /** Client abort signal — destroys the socket the moment the client aborts. */
  signal?: AbortSignal;
  /**
   * 该账号的出口代理。`undefined` = 直连。
   *
   * 只换 socket：`node:http(s).request` 的 agent 负责连代理，写进去的
   * 仍然是原来的请求头与原来的压缩字节。
   */
  egress?: EgressOptions;
}

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

let advertisedCodingsCache: readonly string[] | null = null;

/**
 * `accept-encoding` tokens this transport can inflate itself (memoized, `x-gzip`
 * excluded so the advertised list stays canonical).
 *
 * The ultra gateway's CDN applies brotli to SSE streams whenever the request
 * advertises `br` (observed 2026-09-18 on coding-plan traffic rerouted via
 * proxyEndpoint.mapping; the direct provider endpoints never compress SSE).
 * The real client's fetch stack auto-inflates gzip/deflate/br — this transport
 * mirrors that. Format ids differ from HTTP tokens (`br` → `"brotli"`), and
 * support is runtime-dependent, so every coding is capability-checked before
 * it is advertised; unsupported codings fall through to raw passthrough (paired
 * with the accept-encoding cap in handler.ts, which stops the upstream selecting
 * them).
 */
export function orderedAdvertisedCodings(): readonly string[] {
  if (advertisedCodingsCache === null) {
    advertisedCodingsCache = Object.keys(RESPONSE_CODINGS)
      .filter((coding) => coding !== "x-gzip" && inflateFormatFor(coding) !== null);
  }
  return advertisedCodingsCache;
}

/**
 * Ordered (raw-header-order) upstream request.
 *
 * Why this is not `fetch`: the wire order of the application headers is part of
 * the ZCode impersonation (`Accept-Encoding` position and the signature block are
 * pinned by tests and by the upstream gateway), and the Anthropic passthrough
 * needs the compressed bytes untouched. `node:http` sends a header
 * array in the exact order and case it is given, and its agent swaps only the
 * socket — so one code path serves direct, HTTP-proxy and SOCKS5 egress.
 *
 * Node does not append `Host` when headers arrive as a pair array (verified on
 * Bun 1.4.4 and Node 24), and `Content-Length` must be explicit or the body goes
 * out chunked. Both are built here, around the caller's ordered pairs.
 */
export async function sendOrderedUpstreamRequest(req: OrderedUpstreamRequest): Promise<Response> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw new Error(`upstream url is not a valid url: "${req.url}"`);
  }
  const bodyBytes = bodyToBytes(req.body);
  const pairs: OrderedHeaderPair[] = [
    ["Host", url.host],
    ...req.headers,
    ["Content-Length", String(bodyBytes.byteLength)],
    ["Connection", "close"],
  ];
  // 校验必须发生在任何 I/O 之前：注入的换行会把整条请求拆成两条，而上游只会
  // 看到第一条。node 自己也会拒，但它的报错在连接之后才到，且文案不同。
  for (const [name, value] of pairs) {
    if (!HEADER_NAME.test(name)) throw new Error(`Invalid upstream header name: ${name}`);
    if (/[\r\n]/.test(value)) throw new Error(`Invalid upstream header value for ${name}`);
  }

  const init: ViaInit = { method: req.method ?? "POST", headers: pairs, body: bodyBytes };
  if (req.decompress !== undefined) init.decompress = req.decompress;
  if (req.signal !== undefined) init.signal = req.signal;
  return requestVia(url, init, egressForOptions(req.egress));
}

function bodyToBytes(body: string | Uint8Array | undefined): Uint8Array<ArrayBufferLike> {
  if (body === undefined) return new Uint8Array(0);
  if (typeof body === "string") return new TextEncoder().encode(body);
  return body;
}
