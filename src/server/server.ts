/**
 * HTTP server bootstrap with routing and data-plane authentication.
 *
 * Built on `node:http.createServer` rather than `Bun.serve`: the routing table,
 * the loopback re-check and the data-plane gate are all request callbacks, and
 * `node:http` expresses them without a framework. Bun serves `node:http`
 * natively, and a compiled binary carries the same code.
 *
 */
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import type { ProxyConfig } from "../config/types.js";
import type { Broker } from "../accounts/broker.js";
import type { AccountManager } from "../accounts/manager.js";
import { hasCapableAccount } from "../accounts/capability.js";
import { getDefaultApiKeyManager } from "../apikeys/manager.js";
import type { ApiKeyManager } from "../apikeys/manager.js";
import { handleChatCompletions, handleListModels } from "./routes-openai.js";
import { handleMessages } from "./routes-anthropic.js";
import { handleResponsesRoute } from "./routes-responses.js";
import { handleAsyncMessagesRoute, handleAsyncChatRoute, handleAsyncHealthRoute } from "./routes-async.js";
import { handleMcpRoute, type McpRouteOptions } from "./routes-mcp.js";
import { handleQuota } from "./routes-quota.js";
import { errorResponse } from "../proxy/http-io.js";
import { classifyClientKind } from "../proxy/client-kind.js";
import type { ProxyHandlerOptions } from "../proxy/handler.js";
import { addStage, getDefaultRequestStore, nextReqId } from "../proxy/request-record.js";
import type { RequestStore } from "../proxy/request-record.js";
import type { ResponseStore } from "../responses/store.js";
import { SESSION_COOKIE, readCookie, type SessionStore } from "../users/session.js";
import type { PanelHandler } from "./panel.js";

interface ServerOptions {
  config: ProxyConfig;
  /**
   * 唯一出线口：各 handler 按 `(account, route)` 解析凭据与路由。
   */
  broker: Broker;
  /**
   * 账号仓：只有 async 闸门需要它：那是一个"有没有账号能跑
   * async"的账号能力问题，不是某一次请求的路由问题，所以问 broker 不合适
   * （broker 回答的是"这次请求走谁"）。
   */
  accounts: AccountManager;
  /** Override fetch for testing. */
  fetchImpl?: typeof fetch;
  /** When true, enable per-request debug diagnostics in the proxy handler. */
  debug?: boolean;
  /** Responses-API state store. When absent, `/v1/responses` runs stateless (`previous_response_id` returns 404). */
  responseStore?: ResponseStore;
  /**
   * 控制面（网页面板）的请求处理器。
   *
   * 面板挂在这个监听上而不是自己开一个端口：Docker 里 `-p 8080:8080` 一个端口
   * 就够，而独立端口要么拿不到（令牌只在容器内的 stdout 里），要么多开一个面。
   * 处理器返回 `false` 表示「这条请求不是面板的」，交给下面的代理路由。
   */
  panel?: PanelHandler;
  /**
   * 控制面会话表。给了它，`/v1/*` 的鉴权就变成「API key 或会话 Cookie，任一通过」。
   *
   * 这条让面板里的聊天视图在登录之后不必再收一次 key：页面带着会话 Cookie
   * 请求，服务端认这个 Cookie。语义上等于数据面接受控制面凭据，这是有意的
   * 取舍：反过来让控制面在转发时自己补一把 key，就要多一个只在
   * 面板里存在的代理端点。
   */
  sessions?: SessionStore;
  /**
   * 数据面 API key 仓。缺省用进程级单例：控制面命令（`/keys` 页）与
   * 鉴权必须是**同一个实例**，否则页面读到的用量永远停在 0。测试注入自己的实例。
   */
  apiKeys?: ApiKeyManager;
  /**
   * 请求记录的持有者。缺省用进程级实例：两个入口（`bootstrap.ts` /
   * CLI）与面板读的应该是同一个，否则面板看到的永远是新开的一份空仓库。
   */
  requests?: RequestStore;
}

/** Minimal server handle: what the caller needs to print URLs and shut down. */
export interface ProxyServer {
  hostname: string;
  port: number;
  /** Close the server. When `exit` is true, also call `process.exit(0)`. */
  stop(exit?: boolean): void;
  /** Promise that resolves once the server has fully stopped. */
  close(): Promise<void>;
}

/** Create a fetch-style handler that routes the request through the proxy. */
export function createFetchHandler(opts: ServerOptions): (req: Request) => Promise<Response> {
  const { config, broker, accounts } = opts;
  const apiKeys = opts.apiKeys ?? getDefaultApiKeyManager();
  const requests = opts.requests ?? getDefaultRequestStore();
  const baseProxyOpts: ProxyHandlerOptions = {
    config,
    broker,
    fetchImpl: opts.fetchImpl,
    debug: opts.debug === true,
    requests,
  };
  const responsesOpts = {
    config,
    broker,
    fetchImpl: opts.fetchImpl,
    debug: opts.debug === true,
    // 请求记录：三条协议共用同一份 store。归因（apiKeyId）按
    // 请求在路由点补，见下面各调用点。
    requests,
    ...(opts.responseStore ? { responseStore: opts.responseStore } : {}),
  };
  const asyncOpts = {
    config,
    broker,
    fetchImpl: opts.fetchImpl,
    debug: opts.debug === true,
    requests,
  };
  const mcpOpts: McpRouteOptions = {
    config,
    broker,
    accounts,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  };

  /** 会话 Cookie 是否有效（滑动续期在 `SessionStore.resolve` 里）。*/
  const sessionAuthenticated = (req: Request): boolean => {
    if (!opts.sessions) return false;
    const token = readCookie(req.headers.get("cookie") ?? undefined, SESSION_COOKIE);
    return opts.sessions.resolve(token) !== null;
  };

  /**
   * 数据面鉴权。三条的优先级是有意的：
   *
   * 1. 先看控制面会话 Cookie：面板里的聊天视图登录之后
   *    直接带 Cookie，不必让用户把 key 再贴一遍。
   * 2. 再看 `Authorization: Bearer` / `x-api-key`；命中的那条记录就是用量归因对象。
   * 3. 都没带凭据时：`auth.requireKey` 关着，或者 key 表还是空的，就放行。表空放行
   *    是既有语义，也是「第一次启动还没建 key」时唯一可行的状态。
   *
   * 返回 `null` = 拒绝（401）。会话与放行没有 key 可归因，`apiKeyId` 为 `null`。
   */
  const authenticate = async (req: Request): Promise<DataPlaneAuth | null> => {
    if (sessionAuthenticated(req)) return { apiKeyId: null };

    const presented = presentedKey(req);
    if (presented) {
      const record = await apiKeys.authenticate(presented);
      if (record) return { apiKeyId: record.id };
      // 带了 key 但不认：只有「校验开着」时才拒。关掉校验的部署里，客户端手里
      // 遗留的任意 key 不该从能用变成 401。
    }
    if (!config.auth.requireKey) return { apiKeyId: null };
    if (presented) return null;
    if (await apiKeys.isEmpty()) return { apiKeyId: null };
    return null;
  };

  /**
   * 不走 `proxyRequest` 的数据面路由（`/v1/models`、`/mcp`）：只记状态码。
   *
   * token 数拿不到（那条链路不解析上游 `usage`），但「哪个 key 在用、出了几次错」
   * 仍然要有，否则只查模型或只调 MCP 的客户端会永远显示零请求。为了让记账方只
   * 收一种东西，这两条路由也开一条记录：它是一次真实的数据面请求，只是不经过
   * 上游翻译链路（所以 `format` 不参与判定，`model` 留占位）。
   */
  const countDataPlane = async (auth: DataPlaneAuth, resp: Response, path: string, clientReq: Request): Promise<Response> => {
    if (auth.apiKeyId !== null) {
      const record = requests.begin({ reqId: nextReqId(), format: "openai", apiKeyId: auth.apiKeyId });
      // 这两条路由也归类客户端（只看请求头），报表按客户端维度才不漏。
      record.clientKind = classifyClientKind(clientReq.headers);
      record.status = resp.status;
      record.endedAt = Date.now();
      record.totalMs = record.endedAt - record.startedAt;
      addStage(record, "route", { path });
      // 记账失败不能把一次已经完成的请求变成错误：收尾的写盘由仓自己兜（见
      // `apikeys/manager.ts::onRequestEnd`）。
      await apiKeys.onRequestEnd(record);
      requests.notify(record);
      // 记录此刻已完整（无流式收尾），落盘在同一收尾点。
      requests.finalize(record);
    }
    return resp;
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    // CORS 只在数据面真的要求凭据时才发（理由见 `corsHeaders`）。
    // 表是否为空要读存储（异步），所以这一条也变成 await。
    const cors = corsHeaders(await dataPlaneGated(config, apiKeys));

    // CORS preflight
    if (method === "OPTIONS") {
      return corsResponse(cors);
    }

    // （`/chat` 没有独立页路由：聊天收进面板后那条路径落到下面的数据面鉴权
    // 闸门 —— 打过去就是 401 或 404，不再是一页 HTML。）

    const auth = await authenticate(req);
    if (!auth) {
      return errorResponse(401, "authentication_error", "Invalid or missing data-plane API key", undefined, "auth-invalid");
    }
    /** 归因信息：key 请求带 `apiKeyId`，会话 / 放行不带（没有 key 可记账）。*/
    const proxyOpts: ProxyHandlerOptions = {
      ...baseProxyOpts,
      observer: apiKeys,
      ...(auth.apiKeyId === null ? {} : { apiKeyId: auth.apiKeyId }),
    };

    // --- Routing ---

    if (path === "/v1/chat/completions" && method === "POST") {
      return handleChatCompletions(req, proxyOpts);
    }
    if (path === "/v1/responses" && method === "POST") {
      // 归因与 proxyOpts 同款：key 请求带 apiKeyId，会话 / 放行不带。
      return handleResponsesRoute(req, { ...responsesOpts, ...(auth.apiKeyId === null ? {} : { apiKeyId: auth.apiKeyId }) });
    }
    if (path === "/v1/models" && method === "GET") {
      return await countDataPlane(auth, handleListModels(req, config), `${method} ${path}`, req);
    }

    if (path === "/quota" && method === "GET") {
      return handleQuota(config, broker, accounts, opts.fetchImpl);
    }

    if (path === "/v1/messages" && method === "POST") {
      return handleMessages(req, proxyOpts);
    }

    if (config.async.enabled) {
      // Off-peak needs a credential that carries both halves (plan JWT for the
      // ticket queue + coding-plan API key for the upstream call,
      // auth/capabilities.ts). There is no process-global plan setting, so the
      // gate asks the account registry whether *any* enabled account can serve
      // async. Still an explicit 400 rather than a silent 404: the
      // operator turned the routes on, so "no account can run them" is worth
      // naming.
      const isAsyncRoute =
        (path === "/async/v1/messages" && method === "POST") ||
        (path === "/async/v1/chat/completions" && method === "POST") ||
        (path === "/async/v1/health" && method === "GET");
      if (isAsyncRoute && !(await hasCapableAccount(accounts, "async"))) {
        return errorResponse(
          400,
          "async_plan_unsupported",
          "async (off-peak) endpoints need an account holding both the plan JWT and the coding-plan API key; no enabled account has both",
          undefined,
          "auth-invalid",
        );
      }
      if (path === "/async/v1/messages" && method === "POST") {
        return handleAsyncMessagesRoute(req, { ...asyncOpts, ...(auth.apiKeyId === null ? {} : { apiKeyId: auth.apiKeyId }) });
      }
      if (path === "/async/v1/chat/completions" && method === "POST") {
        return handleAsyncChatRoute(req, { ...asyncOpts, ...(auth.apiKeyId === null ? {} : { apiKeyId: auth.apiKeyId }) });
      }
      if (path === "/async/v1/health" && method === "GET") {
        return handleAsyncHealthRoute(req, asyncOpts);
      }
    }

    if (config.mcp.gateway.enabled) {
      // Aggregated MCP endpoint: ONE `/mcp` URL exposes every official
      // plugin's tools (streamable HTTP — POST JSON-RPC, GET listing,
      // DELETE session close). Replaces the per-plugin `/mcp/{key}` relay.
      if (path === "/mcp" && (method === "POST" || method === "GET" || method === "DELETE")) {
        return await countDataPlane(auth, await handleMcpRoute(req, mcpOpts), `${method} ${path}`, req);
      }
    }

    if (path === "/health" || path === "/") {
      // 这里只回存活状态与账号数：provider 是凭据的属性（不是进程级配置），
      // 没有进程级答案可回，那个字段整体不存在（不留"为兼容而存在"的字段）；
      // 账号数才是运维真正能用的信号（0 = 还没登录）。
      return new Response(JSON.stringify({ status: "ok", accounts: (await accounts.list()).length }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return errorResponse(404, "not_found_error", `No route for ${method} ${path}`, undefined, "other");
  };
}

/**
 * Start the HTTP server. Resolves once the listener is bound; the returned
 * `ProxyServer.stop()` closes the underlying `node:http.Server`.
 *
 * `idleTimeout: 0` (the original Bun.serve setting for self-hosted long
 * reasoning calls) is mirrored by zeroing Node's request/keep-alive/headers
 * timeouts.
 */
export function startServer(opts: ServerOptions): Promise<ProxyServer> {
  const handler = createFetchHandler(opts);
  const { port: requestedPort, host } = opts.config.server;
  const apiKeys = opts.apiKeys ?? getDefaultApiKeyManager();

  const server: Server = createServer(async (req, res) => {
    /*
     * 面板先看：它认领 `/`、页面路径、`/login` 与 `/api/*`，其余返回
     * `false` 交回代理。放在超时与 abort 处理之前，是因为面板自己管响应，不参与
     * 代理那条「客户端断开就 abort 上游」的链路。
     */
    if (opts.panel) {
      try {
        if (await opts.panel(req, res)) return;
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { type: "internal_error", message: (err as Error).message } }));
        } else {
          try { res.end(); } catch { /* socket already gone */ }
        }
        return;
      }
    }

    const abortController = new AbortController();
    const onClientClose = (): void => {
      if (!res.writableEnded) abortController.abort();
    };
    res.on("close", onClientClose);

    // `/async/*` routes can hold the connection open for minutes-to-hours while
    // waiting for an off-peak ticket. Lift the per-request socket timeout from
    // the default 600s (set below via server.requestTimeout) to 24h so the long
    // queue wait + LLM stream doesn't get killed mid-flight. `/mcp/*` GET SSE
    // streams are equally long-lived. Other routes keep the default timeout.
    const pathForTimeout = req.url ?? "";
    if (pathForTimeout.startsWith("/async/") || pathForTimeout.startsWith("/mcp/")) {
      req.setTimeout(24 * 60 * 60 * 1000);
    }

    try {
      // CORS 头要按「数据面是否要求凭据」现算（表可能刚被建了第一把 key）。仓自己
      // 缓存内存表，所以这里只有第一次会真的读文件。
      const cors = corsHeaders(await dataPlaneGated(opts.config, apiKeys));
      const webReq = nodeReqToWebRequest(req, abortController.signal);
      const resp = await handler(webReq).then((r) => addCorsHeaders(r, cors));
      await writeWebResponseToNodeResp(resp, res, abortController.signal);
    } catch (err) {
      if (abortController.signal.aborted) return;
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "internal_error", message: (err as Error).message } }));
      } else {
        // 响应头已经发出去（流式或已写半份 body）：这里只能尽力收尾，失败意味着
        // 客户端已经断开，没有任何可补救的动作。
        try { res.end(); } catch { /* socket already gone */ }
      }
    }
  });

  // Disable all Node HTTP server timeouts to match Bun's `idleTimeout: 0`.
  // Long LLM reasoning calls (60-120s before first token) would otherwise
  // be killed by Node's defaults.
  server.requestTimeout = 600_000;
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 600_000;

  return new Promise<ProxyServer>((resolve, reject) => {
    server.on("error", reject);
    server.listen(requestedPort, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : requestedPort;
      resolve({
        hostname: host,
        port: actualPort,
        stop: (exit) => {
          server.close();
          if (exit) process.exit(0);
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** Convert a Node.js IncomingMessage to a Web API Request. */
function nodeReqToWebRequest(req: import("node:http").IncomingMessage, signal?: AbortSignal): Request {
  const headers = new Headers();
  for (const [key, val] of Object.entries(req.headers)) {
    if (val == null) continue;
    if (Array.isArray(val)) {
      for (const v of val) headers.append(key, v);
    } else {
      headers.set(key, val);
    }
  }
  const host = headers.get("host") ?? "localhost";
  const url = `http://${host}${req.url ?? "/"}`;
  const method = req.method ?? "GET";

  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers, signal });
  }

  // SAFETY: Node's ReadableStream type and the Web one are structurally different at
  // the type layer, but `Readable.toWeb` returns a spec-compliant Web stream at
  // runtime; `fetch` only ever calls `getReader()` on it, which both provide.
  const bodyStream = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    body: bodyStream,
    duplex: "half",
    signal,
  };
  return new Request(url, init);
}

/** Write a Web API Response to a Node.js ServerResponse. */
async function writeWebResponseToNodeResp(resp: Response, res: import("node:http").ServerResponse, abortSignal?: AbortSignal): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  resp.headers.forEach((value, key) => {
    const existing = headers[key];
    if (existing === undefined) {
      headers[key] = value;
    } else if (typeof existing === "string") {
      headers[key] = [existing, value];
    } else {
      existing.push(value);
    }
  });

  res.writeHead(resp.status, resp.statusText, headers);

  if (resp.body == null) {
    res.end();
    return;
  }

  const reader = resp.body.getReader();
  const onAbort = (): void => { reader.cancel().catch(() => {}); };
  abortSignal?.addEventListener("abort", onAbort);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => res.once("drain", () => resolve()));
      }
    }
    res.end();
  } catch (err) {
    if (abortSignal?.aborted) {
      // 客户端 abort：上游流已无意义，尽力结束响应；socket 已断时 `end` 会抛。
      try { res.end(); } catch { /* socket already gone */ }
    } else {
      // 上游/转换失败：把错误推给 Node 的 socket 让它销毁连接；已断开时同样会抛。
      try { res.destroy(err as Error); } catch { /* socket already gone */ }
    }
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 数据面鉴权结果。
 *
 * `apiKeyId` 为 `null` 表示这次请求没有 key 可归因：控制面会话（在面板 `/panel`
 * 登录过的浏览器）或「表空 / 关掉校验」的放行。用量只记在具体的 key 上，所以这两种情况
 * 不计入任何一把 key 的统计。
 */
interface DataPlaneAuth {
  apiKeyId: string | null;
}

/**
 * 客户端出示的凭据：`Authorization: Bearer <key>` 或 `x-api-key: <key>`。
 *
 * 两个头都接受是因为各家 SDK 习惯不同（OpenAI 系用前者，Anthropic 系用后者）。
 * 比较本身在 `apikeys/manager.ts::authenticate` 里做，走 hash 的 `timingSafeEqual`：
 * 明文字符串相等会留下一条把 key 逐字节试出来的时序旁路（audit R2-10）。
 */
function presentedKey(req: Request): string | undefined {
  const header = req.headers.get("authorization") ?? req.headers.get("x-api-key");
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("Bearer ") ? trimmed.slice(7).trim() : trimmed;
}

/**
 * 数据面是否真的要求凭据（CORS 与启动日志共用这一条判定）。
 *
 * `auth.requireKey` 关掉、或者 key 表还是空的时候鉴权是敞开的。
 */
async function dataPlaneGated(config: ProxyConfig, apiKeys: ApiKeyManager): Promise<boolean> {
  return config.auth.requireKey && !(await apiKeys.isEmpty());
}

/** Build a CORS preflight response. */
function corsResponse(cors: Record<string, string>): Response {
  return new Response(null, {
    status: 204,
    headers: cors,
  });
}

/** Add CORS headers to an existing response (non-mutating). */
function addCorsHeaders(resp: Response, cors: Record<string, string>): Response {
  if (Object.keys(cors).length === 0) return resp;
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(cors)) {
    headers.set(k, v);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

/**
 * CORS headers are emitted ONLY when the data plane actually requires credentials
 * (`auth.requireKey` on and at least one key created).
 *
 * Rationale: the /mcp relay (and /v1/*) inject the operator's real OAuth
 * credentials upstream; with `access-control-allow-origin: *` on an open
 * deployment, any webpage in a logged-in user's browser could pass preflight
 * and drive those routes cross-origin (MCP JSON POSTs are preflighted, so
 * withholding the headers blocks the browser before the request fires).
 * Local CLI/curl tools and the panel's own same-origin views (under `/panel`)
 * never needed CORS.
 */
function corsHeaders(corsEnabled: boolean): Record<string, string> {
  if (!corsEnabled) return {};
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, mcp-session-id, mcp-protocol-version, last-event-id",
    "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
    "access-control-max-age": "86400",
  };
}
