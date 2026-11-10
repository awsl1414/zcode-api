/**
 * 每账号出口代理：代理表 → 生效代理 → 一条 `node:http` 出线路径。
 *
 * 风控里最高风险的是「同一出口 IP 上有多个账号」。所有账号从同一台机器出线时，
 * 上游看到「一个 IP，N 个账号轮流用」，比「一台机器一个账号」显眼得多。所以出口
 * 代理必须是**按账号**的，不能靠 `setGlobalDispatcher` 这种进程级开关。
 *
 * 三条硬约束，逐条对应代码：
 *
 * 1. **不静默回落直连**。代理引用了不存在的名字、引用了已停用的
 *    代理、URL 协议不认识，全部在加载配置时抛错（`accounts/proxies.ts`）。运行期
 *    代理连不上就报错，绝不「换直连试试」：静默直连等于泄露真实 IP，比报错难查。
 * 2. **`fetchImpl` 可注入且注入时不套代理**。测试注入的 fetch 必须原样调用，否则
 *    mock 被绕过，用例会去碰真网络。
 * 3. **代理只换 socket**。压缩字节、`Content-Encoding`、SSE 分块节奏、
 *    TLS 端到端加密都必须与直连一致，所以这里不碰解压（除非翻译路径要求）也不重编码。
 *
 * ## 为什么所有代理都走 `node:http(s).request({ agent })`
 *
 * 不能按运行时分叉（Bun 用 fetch 的 `proxy` 选项、Node 用 undici 的
 * `ProxyAgent`），实测差异有三条（Bun 1.4.4 / undici 8.10）：
 *
 * - Bun 的 `undici` 裸模块名解析到它**自带的 shim**，shim 的 fetch **忽略** `dispatcher`；
 * - Bun 的 fetch 原生 `proxy` 选项只认 `http://` / `https://`，`socks5://` 直接报
 *   `UnsupportedProxyProtocol`；
 * - `socks-proxy-agent`（`agent-base` 的 `http.Agent`）只能配 `node:http(s).request`。
 *
 * 统一走一条路：`agent` 统一是 `proxy-agent` 的 `ProxyAgent`，它按代理 URL
 * 的协议自己挑 `http-proxy-agent`（http 目标走 absolute-form，https 目标走
 * `CONNECT`）、`https-proxy-agent` 或 `socks-proxy-agent`，三者都是 `http.Agent`。
 * `node:http` 在 Bun 与 Node 上都是原生实现，`http.Agent` 是两边共同支持的抽象，
 * 所以不需要「按运行时选 dispatcher 还是 proxy 字段」，也不需要自建
 * CONNECT / SOCKS5 隧道。
 *
 * | 协议 | 代理实现 | 出线方式 |
 * |---|---|---|
 * | `http://` / `https://`（目标 http） | `HttpProxyAgent` | `node:http.request`，absolute-form |
 * | `http://` / `https://`（目标 https） | `HttpsProxyAgent` | `node:https.request` + `CONNECT` 隧道 |
 * | `socks5://` / `socks5h://` | `SocksProxyAgent` | `node:http(s).request`，SOCKS5 CONNECT |
 *
 * 直连（没有代理）不走这里：那条路没有分叉，`fetchImpl(url, init)` 就是答案，绕到
 * `node:http` 只会让每个测试 mock 与 highspeed 首抽的同步语义跟着改。
 *
 * `proxy-agent` 8.x 的构造函数只接受选项，默认从 `HTTP_PROXY` 之类的环境变量取代理。
 * 按账号的代理是**固定**的一个 URL，所以这里用 `getProxyForUrl: () => url` 把它钉死；
 * 直接 `new ProxyAgent(proxyUrl)` 会静默退回环境变量，那正是这里不允许的静默回落。
 */
import { request as httpRequest, type Agent, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { ProxyAgent } from "proxy-agent";

/** 名代理的协议白名单。`socks5h://` 让代理解析 DNS。*/
export const PROXY_PROTOCOLS = ["http:", "https:", "socks5:", "socks5h:"] as const;

/** 显式直连的保留名字（与「不写」的区别见 `accounts/proxies.ts`）。*/
export const DIRECT_PROXY = "direct";

/** 句柄缓存上界。代理是配置里的小表，几项就够；上界只防手改配置塞进几百条。*/
export const MAX_CACHED_EGRESS = 16;

/**
 * 一个账号生效的出口代理。`undefined` 的字段表示「这一层没说」。
 *
 * `proxyUrl` 缺省即直连（出线层只认这个结构，不认识 label 与配置表）。
 */
export interface EgressOptions {
  /** 代理 URL（`http://` / `https://` / `socks5://` / `socks5h://`）。缺省 = 直连。*/
  proxyUrl?: string;
  /** 代理认证的用户名（`Proxy-Authorization` / SOCKS5 子协商）。*/
  username?: string;
  /** 代理认证的密码。**不要**写进日志。*/
  password?: string;
}

/**
 * 一个代理出线句柄：`agent` 是 `node:http` 认的东西，`proxyUrl` 留给日志与排障。
 *
 * 代理 URL 单独带出来，是因为 `http.Agent` 把目标信息藏在私有字段里，排障时
 * 「这条连接走的哪个出口」只能从配置侧回答。
 */
export interface Egress {
  readonly agent: Agent;
  readonly proxyUrl: string;
}

/** 代理 URL 的协议（小写、带冒号）。解析失败时抛，不猜。*/
export function proxyProtocol(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid proxy url "${url}"`);
  }
  return parsed.protocol;
}

/**
 * 解析代理 URL。配置层已经校验过一次，这里仍然接住：热改与控制面写入也会来这里。
 * 失败消息说清是代理 URL，而不是漏一条裸的 `Invalid URL` 到请求链路。
 */
function parseProxyUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(`proxy url is not a valid url: "${url}"`);
  }
}

/**
 * 把代理认证塞进 URL（`http://user:pass@host:port`）。
 *
 * 认证集中在这一处：`proxy-agent` 的三种底层 agent 都从 URL 读用户名与密码，所以
 * 「http 代理带上了、socks5 忘了带」这种不对称不会发生。用户名/密码各自
 * `encodeURIComponent`，密码里的 `@` / `:` 不会把 URL 拆坏。
 */
export function proxyUrlWithAuth(options: EgressOptions): string {
  const url = options.proxyUrl;
  if (url === undefined) throw new Error("proxyUrl is required");
  if (options.username === undefined) return url;

  const parsed = parseProxyUrl(url);
  parsed.username = encodeURIComponent(options.username);
  parsed.password = options.password === undefined ? "" : encodeURIComponent(options.password);
  return parsed.toString();
}

const egressCache = new Map<string, Egress>();

/**
 * 按代理 URL（含认证）取句柄：懒创建 + 有界缓存，满了淘汰最旧的一条。
 *
 * 缓存键是完整 URL，所以改密码不会拿到旧连接池。`ProxyAgent` 自己按协议缓存底层
 * agent，同一 URL 复用一个句柄也就复用了连接池。
 */
export function egressFor(proxyUrl: string): Egress {
  const parsed = parseProxyUrl(proxyUrl);
  const key = parsed.toString();
  const cached = egressCache.get(key);
  if (cached !== undefined) {
    // 命中即刷新顺序：Map 的插入序就是淘汰序，淘汰时删最旧的那条。
    egressCache.delete(key);
    egressCache.set(key, cached);
    return cached;
  }

  const created: Egress = {
    // `keepAlive` 打开：上游是 HTTPS 且请求密集，每次重开 TCP 要多一轮握手。
    // `proxy-agent` 默认关掉它是为了能按 URL 动态换代理，我们这里一个账号固定一个
    // 代理，没有动态切换的需求。
    agent: new ProxyAgent({ getProxyForUrl: () => key, keepAlive: true }),
    proxyUrl: key,
  };
  egressCache.set(key, created);
  while (egressCache.size > MAX_CACHED_EGRESS) {
    const oldest = egressCache.keys().next();
    if (oldest.done === true) break;
    egressCache.delete(oldest.value);
  }
  return created;
}

/** 账号生效代理 → 句柄。`undefined` 直连，调用方按直连处理。*/
export function egressForOptions(options: EgressOptions | undefined): Egress | undefined {
  if (options === undefined) return undefined;
  return egressFor(proxyUrlWithAuth(options));
}

// ---------------------------------------------------------------------------
// 请求：node:http(s).request → Response
// ---------------------------------------------------------------------------

/**
 * 出线请求头：`HeadersInit` 的普通形态，外加**有序 pair 数组**。
 *
 * 数组形态原样上线（顺序与大小写都不动），`ordered-transport.ts` 靠它控制
 * `Accept-Encoding` 与签名头的位置；对象/`Headers` 形态按 WHATWG 规则归一
 * （名字小写）。
 */
export type ViaHeaders = HeadersInit;

/**
 * 出线 init。
 *
 * `decompress` 与 fetch 的同名扩展同向：缺省解压，`false` 原样透传压缩字节。
 * 翻译路径要明文，所以不能给 `false`；Anthropic 直传必须给 `false`（压缩字节原样透传）。
 */
export interface ViaInit extends Omit<RequestInit, "headers" | "body"> {
  headers?: ViaHeaders;
  /**
   * 请求体。`Uint8Array<ArrayBufferLike>` 单独列出来：`BodyInit` 的 `BufferSource`
   * 分支在 TS 5.7+ 收紧了 buffer 参数，而有序传输手里就是一块现成字节，不该为
   * 类型兼容再拷一份。
   */
  body?: BodyInit | Uint8Array<ArrayBufferLike> | null;
  decompress?: boolean;
}

/** 出线点能接受的最小 fetch 形状。*/
export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * 带代理的请求：`node:http(s).request` + 该账号的 agent，结果包成 `Response`。
 *
 * `egress` 缺省 = 直连（不带 agent，走 `node:http` 的默认连接池）。
 *
 * 透传语义（数据透传的三个坑）：
 * - 响应体按 `Readable.toWeb` 转流，分块原样过，不缓冲（SSE 节奏不变）。
 * - 只有 `decompress !== false` 时才按 `content-encoding` 解压，与 fetch 的默认
 *   行为一致；直传路径一律原样送字节（压缩与 `Content-Encoding` 保持一致）。
 * - HTTPS 目标的 TLS 由底层 agent 在隧道之上直接握，证书校验照常，没有「跳过校验」
 *   的开关。
 *
 * `RequestOptions.agent` 在 `https.request` 上传的是同一个 agent：`agent-base` 用
 * `secureEndpoint` 判断该走 `CONNECT` + TLS 还是 absolute-form 转发。
 */
export async function requestVia(
  input: string | URL | Request,
  init: ViaInit,
  egress: Egress | undefined,
): Promise<Response> {
  const prepared = await normalizeRequest(input, init);
  let url: URL;
  try {
    url = new URL(prepared.url);
  } catch {
    throw new Error(`upstream url is not a valid url: "${prepared.url}"`);
  }

  const options: RequestOptions = {
    agent: egress?.agent,
    method: prepared.method,
    headers: prepared.headers,
  };

  /**
   * 请求头与体是否已经写到线上。
   *
   * `finish` 只在把数据交给 socket 之后触发，连接失败（DNS / ECONNREFUSED / 代理
   * 拒绝 CONNECT）时不会触发。用它而不是「`end()` 调过了」：后者会把连接失败也
   * 标成「已发出」，重试阶梯就再也补不上这类瞬时故障。
   */
  let written = false;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const secure = url.protocol === "https:";
    const request = (secure ? httpsRequest : httpRequest)(url, options, resolve);
    request.on("finish", () => {
      written = true;
    });
    request.on("error", (err: Error) => {
      // 已经写到线上的请求可能被上游处理过（LLM 调用会消耗额度），重发会重复计费。
      // 标给 handler 的 connect-retry 阶梯，见 http-io.ts::dispatchWithConnectRetry。
      if (!written) {
        reject(err);
        return;
      }
      Object.assign(err, { postWrite: true });
      reject(err);
    });
    const signal = prepared.signal;
    if (signal !== undefined) {
      const onAbort = (): void => {
        request.destroy(new Error("client aborted during egress request"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      // handler 会把同一个客户端 signal 跨重试复用，不能在它身上堆监听器。
      request.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    request.end(prepared.body);
  });

  return responseFromUpstream(response, init.decompress !== false);
}

/** 逐跳头：只对单条连接有意义，不能出现在给调用方的 `Response` 上。*/
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set(["transfer-encoding", "connection"]);

/**
 * `node:http` 响应 → `Response`。`decompress` 为真时按 `content-encoding` 解压。
 *
 * 逐跳头（`transfer-encoding` / `connection`）不往上带：`node:http` 已经替我们拆了
 * 分块，把它的标签留在 `Response` 上就成了一条与 body 不符的声明。fetch 的
 * `Response` 从来不暴露这两个头，这里保持一致，两条出线路径的响应形状才相同。
 *
 * 解压后 `content-encoding` / `content-length` 与 body 不符，两个头必须一起去掉，
 * 留着会让客户端二次解压失败。不认识的编码原样透传，与 fetch 的宽容度对齐。
 */
export function responseFromUpstream(response: IncomingMessage, decompress: boolean): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }

  const status = response.statusCode ?? 502;
  const statusText = response.statusMessage ?? "";
  // SAFETY: `Readable.toWeb` 的返回类型在 @types/bun 里是 `ReadableStream<any>`，
  // 实际分块就是 Buffer（Uint8Array 子类）。收窄成字节流才能交给 Response。
  const stream = Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
  const decoder = decompress ? decompressionFor(headers.get("content-encoding")) : null;
  if (decoder === null) return new Response(stream, { status, statusText, headers });

  headers.delete("content-encoding");
  headers.delete("content-length");
  // SAFETY: `DecompressionStream` 的 writable 侧在 DOM 类型里是 BufferSource，
  // pipeThrough 要求精确的 Uint8Array；运行时字节进字节出，类型对不上只是声明差异。
  const inflater = new makeInflateStream(decoder) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  // SAFETY: pipeThrough 的返回类型随输入泛型走，运行时分块就是 Uint8Array。
  const inflated = stream.pipeThrough(inflater) as unknown as ReadableStream<Uint8Array>;
  return new Response(inflated, { status, statusText, headers });
}

// DOM 的 `DecompressionStream` 类型不含 Bun 的 "brotli"/"zstd"，但运行时接受。经由
// 一个 Bun 类型的别名构造，避免在多处散布断言；能力探测集中在本模块，见
// {@link inflateFormatFor}。
type InflateConstructor = new (format: Bun.CompressionFormat) => DecompressionStream;
// SAFETY: `DecompressionStream` 在 Bun 里接受 brotli/zstd，DOM 的类型声明没有这两个值。
const makeInflateStream: InflateConstructor = DecompressionStream as unknown as InflateConstructor;

/**
 * HTTP content-coding → `DecompressionStream` 格式。
 *
 * 运行时能力不同（Node 24 不认 `zstd`，Bun 1.4 认），所以这张表只是候选集，
 * 用之前必须过 {@link inflateFormatFor} 的能力探测。
 */
export const RESPONSE_CODINGS: Readonly<Record<string, Bun.CompressionFormat>> = {
  gzip: "gzip",
  "x-gzip": "gzip",
  deflate: "deflate",
  br: "brotli",
  zstd: "zstd",
};

/**
 * 该 coding 在本运行时能自己解吗？能就返回格式 token。
 *
 * 不认识的与不支持的都返回 `null`，调用方按「原样透传」处理：宁可把字节送给客户端，
 * 也不要在请求链路上抛一个解压构造错误。
 */
export function inflateFormatFor(coding: string): Bun.CompressionFormat | null {
  const format = RESPONSE_CODINGS[coding.toLowerCase().trim()];
  if (format === undefined) return null;
  try {
    new makeInflateStream(format);
    return format;
  } catch {
    return null;
  }
}

/** 翻译路径需要的解压器；不认识的编码与当前运行时解不了的编码都原样透传。*/
function decompressionFor(coding: string | null): Bun.CompressionFormat | null {
  if (coding === null) return null;
  // 多编码（`gzip, br`）不解：那需要串两层，而这里的上游从未这样回过。
  if (coding.includes(",")) return null;
  return inflateFormatFor(coding);
}

/** 请求三要素的归一结果（`Request` 与 URL+init 两种入参折成同一形状）。*/
interface PreparedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array<ArrayBufferLike>;
  signal?: AbortSignal;
}

/**
 * 把 `fetch` 的两种入参折成 node 的请求参数。
 *
 * `Request` 入参只有一个调用方（`proxy/handler.ts` 的翻译分支），但那条路在走代理
 * 时会把整个请求塞进来，所以必须支持：body 只能读一次，读成字节后按定长发送。
 *
 * 头部的有序数组形态原样保留（顺序与大小写），其余形态交给 `Headers` 归一。数组形态
 * 之所以不能过 `Headers`：WHATWG 会把名字小写，而 `ordered-transport.ts` 的线上顺序
 * 与 `HTTP-Referer` 这类大小写是被测试逐字钉住的。
 */
async function normalizeRequest(input: string | URL | Request, init: ViaInit): Promise<PreparedRequest> {
  if (input instanceof Request) {
    const body = input.body === null ? undefined : new Uint8Array(await input.clone().arrayBuffer());
    const headers = headerRecord(init.headers ?? input.headers);
    const prepared: PreparedRequest = { url: input.url, method: init.method ?? input.method, headers };
    if (body !== undefined) prepared.body = body;
    if (init.signal !== undefined && init.signal !== null) prepared.signal = init.signal;
    return prepared;
  }

  const url = typeof input === "string" ? input : input.toString();
  const prepared: PreparedRequest = {
    url,
    method: init.method ?? "GET",
    headers: headerRecord(init.headers),
  };
  if (init.body instanceof Uint8Array) prepared.body = init.body;
  else if (init.body !== undefined && init.body !== null) prepared.body = await bodyBytes(init.body);
  if (init.signal !== undefined && init.signal !== null) prepared.signal = init.signal;
  return prepared;
}

/** 头部入参 → 平铺记录，保持给的顺序（数组形态连大小写一起保留）。*/
function headerRecord(headers: ViaHeaders | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (headers === undefined) return record;
  if (Array.isArray(headers)) {
    for (const pair of headers) record[pair[0]] = pair[1];
    return record;
  }
  new Headers(headers).forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

/** 请求体 → 字节。字符串与字节数组直接转，其余（Blob / FormData / 流）交给 `Response` 读。*/
async function bodyBytes(body: BodyInit): Promise<Uint8Array<ArrayBufferLike>> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/**
 * 带代理的 fetch。
 *
 * 注入的 `fetchImpl` **原样调用**：测试的 mock 不该被绕过，也不该被逼着实现 agent
 * 语义。判断条件是 `fetchImpl !== globalThis.fetch`，与 handler.ts 里
 * `hasCustomFetchImpl` 同一口径。
 *
 * 直连（`egress` 缺省）也直接调 `fetchImpl`：没有代理时运行时原生的 fetch 没有分叉，
 * 而 `proxy/highspeed` 的首抽要求「fetch 在任何 await 之前发出」
 * （`highspeed/manager.test.ts` 的抽取相位断言），所以这条快路不能改成异步。
 */
export function fetchVia(
  fetchImpl: FetchLike,
  url: string | URL | Request,
  init: RequestInit,
  egress: Egress | undefined,
): Promise<Response> {
  // SAFETY: 同一函数对象的不同静态类型（Bun 的 `typeof fetch` 带 preconnect 等扩展字段，
  // `FetchLike` 只保留被调用的两个参数）。比较的是引用相等，运行时就是 fetch 本身。
  const globalFetch = globalThis.fetch as unknown as FetchLike;
  if (fetchImpl !== globalFetch) return fetchImpl(url, init);
  if (egress === undefined) return fetchImpl(url, init);
  // `RequestInit` 的字段除 `body` 外与 `ViaInit` 同形，`body` 只是放宽到字节数组。
  return requestVia(url, init, egress);
}

/**
 * 账号生效代理 + `fetchImpl` 的合并入口：出线点用它少一次查找。
 *
 * `egress` 缺省（直连）时只是 `fetchImpl(url, init)`，不多一个微任务。
 */
export function fetchWithEgress(
  fetchImpl: FetchLike,
  url: string | URL | Request,
  init: RequestInit,
  egress: EgressOptions | undefined,
): Promise<Response> {
  return fetchVia(fetchImpl, url, init, egressForOptions(egress));
}
