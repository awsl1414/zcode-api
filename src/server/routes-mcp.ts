/**
 * Aggregated MCP route: ONE `/mcp` endpoint exposing every official plugin's
 * tools (namespaced `{plugin}__{tool}`). Replaces the old per-plugin
 * `/mcp/{key}` passthrough relay — clients configure a single MCP server URL.
 *
 * Surface (streamable HTTP; the aggregate itself is stateless — no client
 * session id is issued, upstream sessions are internal, see aggregate.ts):
 *   POST   /mcp  JSON-RPC: initialize / ping / tools/list / tools/call,
 *                notifications (→202), JSON-RPC batches
 *   GET    /mcp  human listing (JSON / HTML for browsers); MCP clients that
 *                ask for an SSE stream get 405 — this server never pushes
 *   DELETE /mcp  close all cached upstream plugin sessions
 *
 * Inbound auth is the shared data-plane API key gate in `server.ts::createFetchHandler`
 * (same semantics as the LLM routes); outbound auth is the stored OAuth
 * credential via `src/mcp/upstream.ts` (coding-plan only — the gateway rejects
 * identity-only credentials with JSON-RPC 3101, so start-plan gets an explicit
 * 400 here, mirroring the async-route pattern).
 *
 * The aggregate instances (upstream sessions + tools cache) are cached **per
 * credential fingerprint**, i.e. one per account: a
 * single-slot cache would rebuild every plugin session each time the scheduler
 * alternated accounts. The map is LRU-bounded and closed on eviction, and
 * `DELETE /mcp` drops every instance; a re-login (different fingerprint)
 * rebuilds its own instance automatically.
 *
 * Route registration lives in `server.ts` (gated by `config.mcp.gateway.enabled`).
 *
 * @see _reverse/NOTEPAD.md "Official plugin MCP"
 */
import { createHash } from "node:crypto";
import {
  buildOfficialMcpAuthHeaders,
  McpCredentialsUnavailableError,
  type OfficialMcpAuth,
  type McpCredentialReason,
} from "../mcp/upstream.js";
import { McpAggregateServer, type JsonRpcMessage, type JsonRpcReply } from "../mcp/aggregate.js";
import { OFFICIAL_MCP_CATALOGUE } from "../mcp/catalogue.js";
import { errorResponse } from "../proxy/http-io.js";
import type { EgressOptions } from "../proxy/egress.js";
import type { Credential } from "../auth/types.js";
import type { Broker } from "../accounts/broker.js";
import { toAuthCredential, type AccountManager } from "../accounts/manager.js";
import type { Account, RouteKind } from "../accounts/types.js";
import { acquireLease } from "../proxy/lease.js";
import type { ProxyConfig } from "../config/types.js";

export interface McpRouteOptions {
  config: ProxyConfig;
  /** 唯一出线口：按 `(account, route)` 解析凭据与路由。*/
  broker: Broker;
  /**
   * 账号仓：只用于**缓存生命周期**：账号删除 / 禁用时清掉它的聚合实例
   * （`accounts.onChange` 是唯一的写成功通知口，见 `accounts/manager.ts`）。
   * 出线仍然只走 broker。
   */
  accounts: AccountManager;
  fetchImpl?: typeof fetch;
}

type McpAuthStatus =
  | { ok: true; auth: OfficialMcpAuth; fingerprint: string; egress?: EgressOptions }
  | { ok: false; reason: McpCredentialReason | "not_logged_in" | "plan_unsupported"; message: string };

/**
 * MCP 网关的闸门：**必须是 coding-plan 路由**。
 *
 * 上游官方网关拒绝"只有身份"的鉴权（JSON-RPC 3101），所以 start-plan / off-peak
 * 等路由在这里直接 400，而不是让每个 JSON-RPC 调用各自撞一次 3101。判定依据是
 * 本次解析出来的路由，不是某个全局 plan 标记。
 *
 * 多账号：鉴权头里的 `Bigmodel-Target-Type` / TEAM 两个头取自**账号自己的**
 * identity（TEAM 账号的三个 id 必须齐全），不能硬编码成 `PERSONAL`，否则 TEAM 账号走 MCP 会被
 * 上游当成个人账号（与 highspeed 那条同一个病）。
 */
function resolveMcpAuth(account: Account, route: RouteKind): McpAuthStatus {
  if (route !== "coding-plan") {
    return {
      ok: false,
      reason: "plan_unsupported",
      message: `the /mcp endpoint requires the "coding-plan" route (this request resolved route "${route}")`,
    };
  }
  const stored = account.credential;
  const cred: Credential = toAuthCredential(stored);
  try {
    const auth = buildOfficialMcpAuthHeaders(cred, stored.identity);
    const fingerprint = credentialFingerprint(cred);
    return { ok: true, auth, fingerprint };
  } catch (err) {
    if (err instanceof McpCredentialsUnavailableError) {
      return { ok: false, reason: err.reason, message: err.message };
    }
    throw err;
  }
}

function credentialFingerprint(cred: Credential): string {
  return createHash("sha256").update(`${cred.jwt ?? ""}|${cred.apiKey ?? ""}|${cred.secret ?? ""}`).digest("hex").slice(0, 16);
}

/**
 * 聚合实例缓存的 LRU 上限。
 *
 * 来源：设计文档没有给数字，这里按**内存成本**定：每个实例持有全套官方插件的
 * 上游会话（每条插件一份 `Mcp-Session-Id` + 一条连接），而常见部署里账号数
 * 是 2~4 个。取 8 是"常见账号数留一倍余量"：再多就让最久未用的账号付一次重建
 * 成本（重建对客户端透明：聚合器不签发客户端 session，上游会话是缓存不是状态）。
 */
export const MCP_AGGREGATE_CACHE_LIMIT = 8;

/**
 * 聚合实例缓存：`fingerprint → server`，Map 的插入顺序即 LRU 顺序（命中时重新入队）。
 *
 * 为什么按指纹而不是按账号 id：指纹来自凭据本身，重新登录（JWT 轮换）会得到新指纹，
 * 旧实例自然失效，不需要额外失效逻辑（4.x 单槽缓存的注释里就是这个理由）。
 */
const aggregateCache = new Map<string, McpAggregateServer>();

/** 哪些账号仓已经挂过清理回调（同一个仓被多次 `createFetchHandler` 复用时不重复挂）。*/
const cleanupInstalled = new WeakSet<AccountManager>();

/** Test seam: drop every cached aggregate without closing — tests only. */
export function resetMcpAggregateCache(): void {
  aggregateCache.clear();
}

/**
 * 取（或建）某个账号的聚合实例，并把缓存维持在上限内。
 *
 * LRU 命中要把键重新入队，否则"最久未用"退化成"最早创建"，活跃账号会被自己的
 * 老条目挤掉。
 */
async function aggregateFor(opts: McpRouteOptions, auth: OfficialMcpAuth, fingerprint: string, egress: EgressOptions | undefined): Promise<McpAggregateServer> {
  const cached = aggregateCache.get(fingerprint);
  if (cached) {
    aggregateCache.delete(fingerprint);
    aggregateCache.set(fingerprint, cached);
    return cached;
  }
  const server = new McpAggregateServer(opts.config.mcp.gateway.upstreamOrigin, auth, {
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    // MCP 工具调用同样走账号的出口。聚合实例按凭据指纹缓存，所以换代理要
    // 等这个缓存条目被淘汰或进程重启（长寿命限制，见 proxies.ts::resolveEgress）。
    ...(egress ? { egress } : {}),
  });
  aggregateCache.set(fingerprint, server);
  await evictOverflow();
  return server;
}

/**
 * 超出上限时淘汰最久未用的实例，**淘汰前先 `closeAll()`** 释放上游会话
 * 之后再丢引用：只丢引用不关会话等于把上游连接泄漏给一个再也拿不到的实例。
 */
async function evictOverflow(): Promise<void> {
  const overflow = aggregateCache.size - MCP_AGGREGATE_CACHE_LIMIT;
  if (overflow <= 0) return;
  // 快照再删：遍历中改 Map 会让迭代器行为依赖引擎实现。
  const victims = [...aggregateCache].slice(0, overflow);
  for (const [fingerprint, server] of victims) {
    await server.closeAll();
    aggregateCache.delete(fingerprint);
  }
}

/**
 * 账号删除 / 禁用时清理它的聚合实例。
 *
 * 挂在 `AccountManager.onChange` 上而不是每次请求比对账号表：写成功是**唯一**的
 * 生命周期事件（`manager.ts` 的注释说明了为什么通知放在写入口），逐请求扫表则要为
 * 每个请求算一遍全部凭据指纹。
 *
 * 判据是"**启用中**的账号里还有没有人用这个指纹"：禁用与删除都表现为指纹消失；
 * 重新登录换指纹同理（旧指纹没人认领）。
 */
async function pruneAggregates(accounts: readonly Account[]): Promise<void> {
  const live = new Set(
    accounts
      .filter((account) => account.enabled)
      .map((account) => credentialFingerprint(toAuthCredential(account.credential))),
  );
  const victims = [...aggregateCache].filter(([fingerprint]) => !live.has(fingerprint));
  for (const [fingerprint, server] of victims) {
    await server.closeAll();
    aggregateCache.delete(fingerprint);
  }
}

/** 幂等安装清理回调（`WeakSet` 防重：同一个账号仓可能被多个 handler 共享）。*/
function installAggregateCleanup(accounts: AccountManager): void {
  if (cleanupInstalled.has(accounts)) return;
  cleanupInstalled.add(accounts);
  accounts.onChange((list) => {
    void pruneAggregates(list);
  });
}

/** Any of POST/GET/DELETE /mcp. */
export async function handleMcpRoute(req: Request, opts: McpRouteOptions): Promise<Response> {
  installAggregateCleanup(opts.accounts);
  if (req.method === "GET") return handleMcpListing(req, opts);
  if (req.method === "DELETE") return handleMcpClose(opts);
  return handleMcpRpc(req, opts);
}

/** POST /mcp — one JSON-RPC message or a batch. */
async function handleMcpRpc(req: Request, opts: McpRouteOptions): Promise<Response> {
  const status = await resolveAuthForRpc(opts);
  if ("response" in status) return status.response;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await req.text());
  } catch {
    return jsonRpcHttpResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: body is not valid JSON" } }, 400);
  }

  const aggregate = await aggregateFor(opts, status.auth, status.fingerprint, status.egress);

  // Batch (array): empty batch → single error; replies collected for entries
  // with ids, notifications dropped — an all-notification batch → 202.
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return jsonRpcHttpResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: empty batch" } }, 400);
    }
    const replies: JsonRpcReply[] = [];
    for (const entry of parsed) {
      if (!isJsonRpcMessage(entry)) {
        replies.push({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: batch entry is not a JSON-RPC message" } });
        continue;
      }
      const outcome = await aggregate.handle(entry);
      if (outcome.kind === "reply") replies.push(outcome.message);
    }
    if (replies.length === 0) return acceptedResponse();
    return jsonRpcHttpResponse(replies);
  }

  if (!isJsonRpcMessage(parsed)) {
    return jsonRpcHttpResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: expected a JSON-RPC message or batch" } }, 400);
  }
  const outcome = await aggregate.handle(parsed);
  if (outcome.kind === "notification") return acceptedResponse();
  return jsonRpcHttpResponse(outcome.message);
}

function isJsonRpcMessage(v: unknown): v is JsonRpcMessage {
  return typeof v === "object" && v !== null && "method" in (v as Record<string, unknown>);
}

type RpcAuthResult =
  | { ok: true; auth: OfficialMcpAuth; fingerprint: string; egress?: EgressOptions }
  | { response: Response };

async function resolveAuthForRpc(opts: McpRouteOptions): Promise<RpcAuthResult> {
  const resolved = await resolveMcpCredentials(opts);
  if ("response" in resolved) return resolved;
  return resolved;
}

/**
 * 解析一次 MCP 调用的凭据。
 *
 * **MCP 不占并发槽**：并发槽只在真正占用上游的整个期间持有，而 MCP 是长活的 JSON-RPC 会话（聚合器按凭据指纹缓存，
 * 跨请求复用），把它算进账号在飞数会让一个挂着 `/mcp` 的客户端永久吃掉一个并发
 * 名额（R11 的默认上限只有 2）。所以这里拿到凭据就立刻 `release()`，只借"哪份凭据
 * 能出线"这个判定，不持有槽位。
 */
async function resolveMcpCredentials(opts: McpRouteOptions): Promise<RpcAuthResult> {
  const acquired = await acquireLease(opts.broker, {});
  if (!acquired.ok) {
    // 没有账号 / 账号被禁 / 路由不在白名单：与"未登录"同一语义（400 + 原因）。
    return { response: errorResponse(400, "mcp_credentials_unavailable", acquired.message, undefined, acquired.errorCode) };
  }
  const lease = acquired.lease;
  lease.release();
  const status = resolveMcpAuth(lease.account, lease.route);
  if (!status.ok) {
    const type = status.reason === "plan_unsupported" ? "mcp_plan_unsupported" : "mcp_credentials_unavailable";
    return { response: errorResponse(400, type, status.message, undefined, "auth-invalid") };
  }
  // 出口代理跟着租约走：MCP 工具调用也是这个账号的出线。
  return { ...status, egress: lease.egress };
}

/** DELETE /mcp — close every cached upstream session (all accounts), drop the cache. */
async function handleMcpClose(opts: McpRouteOptions): Promise<Response> {
  const status = await resolveAuthForRpc(opts);
  if ("response" in status) return status.response;
  for (const server of aggregateCache.values()) {
    await server.closeAll();
  }
  aggregateCache.clear();
  return new Response(null, { status: 202 });
}

function jsonRpcHttpResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-cache" },
  });
}

function acceptedResponse(): Response {
  return new Response(null, { status: 202 });
}

interface ListedServer {
  key: string;
  routeId: string;
  plugin: string;
  pluginVersion: string;
  requiresPaidPlan: boolean;
  displayName: Record<string, string>;
  description: Record<string, string>;
  category?: string;
}

interface ListingBody {
  generatedAt: string;
  upstreamOrigin: string;
  endpoint: string;
  authReady: boolean;
  authMode: string | null;
  authError: string | null;
  servers: ListedServer[];
}

/**
 * GET /mcp — human discovery (JSON; HTML for browsers). MCP clients asking
 * for an SSE stream (Accept includes text/event-stream) get 405 instead:
 * this aggregate never pushes server-initiated messages.
 */
async function handleMcpListing(req: Request, opts: McpRouteOptions): Promise<Response> {
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("text/event-stream")) {
    return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
  }

  const origin = opts.config.mcp.gateway.upstreamOrigin;
  // 列表页只是展示"鉴权是否就绪"，同样借一次租约判定后立即释放（不占槽）。
  const resolved = await resolveMcpCredentials(opts);
  const status = "response" in resolved ? { ok: false as const, reason: "not_logged_in" as const, message: "" } : resolved;

  const servers: ListedServer[] = OFFICIAL_MCP_CATALOGUE.servers.map((s) => ({
    key: s.key,
    routeId: s.routeId,
    plugin: s.plugin,
    pluginVersion: s.version,
    requiresPaidPlan: s.requiresPaidPlan,
    displayName: s.displayName,
    description: s.description,
    ...(s.category ? { category: s.category } : {}),
  }));

  const body: ListingBody = {
    generatedAt: OFFICIAL_MCP_CATALOGUE.generatedAt,
    upstreamOrigin: origin,
    endpoint: "/mcp",
    authReady: status.ok,
    authMode: status.ok ? status.auth.mode : null,
    authError: status.ok ? null : status.reason,
    servers,
  };

  if (accept.includes("text/html")) {
    return new Response(renderListingHtml(body), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  }
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-cache" },
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderListingHtml(body: ListingBody): string {
  const rows = body.servers
    .map((s) => {
      const name = s.displayName["zh-CN"] ?? s.displayName.en ?? s.key;
      const desc = s.description["zh-CN"] ?? s.description.en ?? "";
      return `      <tr><td><code>${escapeHtml(s.key)}</code></td><td>${escapeHtml(name)}</td><td>${escapeHtml(desc)}</td><td><code>${escapeHtml(s.routeId)}</code></td><td>${s.requiresPaidPlan ? "yes" : "no"}</td></tr>`;
    })
    .join("\n");
  const authLine = body.authReady
    ? `auth: <b>ready</b> (${escapeHtml(String(body.authMode))})`
    : `auth: <b>not ready</b> (${escapeHtml(String(body.authError))})`;
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>zcode-proxy · MCP endpoint</title>
<style>body{font-family:system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}code{background:#f4f4f4;padding:0 .3rem}</style>
</head>
<body>
  <h1>MCP endpoint</h1>
  <p>One aggregated endpoint: <code>POST ${escapeHtml(body.endpoint)}</code> (streamable HTTP). Tools are named <code>{plugin}__{tool}</code>. Gateway: <code>${escapeHtml(body.upstreamOrigin)}</code> · catalogue: ${escapeHtml(body.generatedAt)} · ${authLine}</p>
  <table>
    <thead><tr><th>plugin key</th><th>name</th><th>description</th><th>route id</th><th>paid plan</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>
`;
}
