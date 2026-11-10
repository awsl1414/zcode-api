/**
 * Tests for the aggregated /mcp route: listing vs SSE-405, JSON-RPC surface
 * (initialize / tools/list / tools/call / batch / notifications), data-plane
 * API key gating, plan gating, credential matrix, and DELETE session close — all
 * through the full fetch-handler dispatch.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { createFetchHandler } from "./server.js";
import { MCP_AGGREGATE_CACHE_LIMIT, resetMcpAggregateCache } from "./routes-mcp.js";
import { OFFICIAL_MCP_CATALOGUE } from "../mcp/catalogue.js";
import type { ProxyConfig, McpGatewayConfig } from "../config/types.js";
import { brokerFor, inMemoryAccounts } from "../accounts/testing.js";
import { ApiKeyManager } from "../apikeys/manager.js";
import { memoryApiKeysStore } from "../apikeys/testing.js";
import type { Credential } from "../auth/types.js";

function makeConfig(overrides: Partial<ProxyConfig> = {}, mcpGateway: McpGatewayConfig = { enabled: true, upstreamOrigin: "https://zcode.test" }): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: { requireKey: false },
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: { appVersion: "test-1.0.0", appVersionSource: "default", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai", betaPolicy: "drop", betaAllowlist: [] },
    clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
    responses: { storeMaxEntries: 1000, storeTtlMs: 86400000 },
    endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: false }, highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
    mcp: { enabled: true, gateway: mcpGateway },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
    claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, sprintWindowMs: 1800000, sprintPollIntervalMs: 60000 },
    logging: { level: "info" },
    ...overrides,
  };
}

function fullCred(fields: Partial<Credential> = {}): Credential {
  return { apiKey: "sk-x.sec", provider: "zai", jwt: "jwt-1", ...fields };
}

/**
 * Minimal official-gateway stub: answers initialize (session id per route),
 * notifications, tools/list (one tool per plugin) and tools/call (echo).
 */
function officialGatewayStub(opts: { failInit?: Set<string> } = {}) {
  // `headers` 记下来是为了把 DELETE 归到具体账号（关闭上游会话时鉴权头带的是账号的 JWT）。
  const calls: Array<{ url: string; method: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, method: init?.method ?? "GET", body, headers: (init?.headers as Record<string, string> | undefined) ?? {} });
    const routeId = new URL(url).pathname.split("/").pop() ?? "";
    if (init?.method === "DELETE") return new Response(null, { status: 202 });
    const rpcMethod = body.method as string | undefined;
    const id = body.id;
    const json = (payload: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", ...headers } });
    if (rpcMethod === "initialize") {
      if (opts.failInit?.has(routeId)) return new Response("forbidden", { status: 403 });
      return json({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "zcode-official-mcp", version: "1" } } }, { "mcp-session-id": `sess-${routeId}` });
    }
    if (rpcMethod === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpcMethod === "tools/list") {
      return json({ jsonrpc: "2.0", id, result: { tools: [{ name: "quote", description: "d", inputSchema: { type: "object" } }] } });
    }
    if (rpcMethod === "tools/call") {
      const name = (body.params as { name?: string } | undefined)?.name ?? "?";
      return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `called:${name}` }] } });
    }
    return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown" } });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

/**
 * 建一个 handler。`cred` 决定账号凭据，`routes` 决定解析到哪条路由（5.0 里
 * "plan" 是路由的属性，不再是全局配置）。MCP 不占并发槽，所以这里也顺带验证
 * "借完凭据立刻释放"这条路径。
 */
function handler(
  config: ProxyConfig,
  cred: Credential = fullCred(),
  fetchImpl?: typeof fetch,
  routes: ("coding-plan" | "start-plan")[] = ["coding-plan"],
  apiKeys?: ApiKeyManager,
) {
  const { broker, manager } = brokerFor({
    kind: "zhipu-account",
    provider: cred.provider,
    apiKey: cred.apiKey,
    ...(cred.secret ? { secret: cred.secret } : {}),
    ...(cred.jwt ? { jwt: cred.jwt } : {}),
    identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
  }, routes);
  return createFetchHandler({
    config,
    broker,
    accounts: manager,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(apiKeys ? { apiKeys } : {}),
  });
}

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(() => {
  resetMcpAggregateCache();
});

describe("GET /mcp discovery", () => {
  it("lists the aggregate endpoint + catalogue as JSON by default", async () => {
    const cred = fullCred();
    const resp = await handler(makeConfig(), cred, officialGatewayStub().fetch)(new Request("http://localhost/mcp"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { endpoint: string; servers: unknown[]; authReady: boolean };
    expect(body.endpoint).toBe("/mcp");
    expect(body.servers.length).toBeGreaterThan(10);
    expect(body.authReady).toBe(true);
  });

  it("renders HTML for browsers", async () => {
    const cred = fullCred();
    const resp = await handler(makeConfig(), cred, officialGatewayStub().fetch)(
      new Request("http://localhost/mcp", { headers: { accept: "text/html" } }),
    );
    expect(resp.headers.get("content-type")).toContain("text/html");
  });

  it("answers 405 to MCP clients asking for an SSE stream (no server push)", async () => {
    const cred = fullCred();
    const resp = await handler(makeConfig(), cred, officialGatewayStub().fetch)(
      new Request("http://localhost/mcp", { headers: { accept: "text/event-stream" } }),
    );
    expect(resp.status).toBe(405);
    expect(resp.headers.get("allow")).toBe("POST, DELETE");
  });
});

describe("POST /mcp — JSON-RPC surface", () => {
  it("initialize: 200, aggregate serverInfo, protocol echo, no Mcp-Session-Id (stateless)", async () => {
    const cred = fullCred();
    const resp = await handler(makeConfig(), cred, officialGatewayStub().fetch)(
      rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } } }),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("mcp-session-id")).toBeNull();
    const body = (await resp.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.serverInfo.name).toBe("zcode-proxy-mcp");
  });

  it("tools/list: namespaced merge across all plugins (upstream via shared fetchImpl)", async () => {
    const cred = fullCred();
    const stub = officialGatewayStub();
    const resp = await handler(makeConfig(), cred, stub.fetch)(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const body = (await resp.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.some((t) => t.name === "wind-stock__quote")).toBe(true);
    expect(body.result.tools.some((t) => t.name === "finance-search__quote")).toBe(true);
  });

  it("tools/call: dispatches with the original tool name", async () => {
    const cred = fullCred();
    const stub = officialGatewayStub();
    const resp = await handler(makeConfig(), cred, stub.fetch)(
      rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tianyancha__quote", arguments: { q: "x" } } }),
    );
    const body = (await resp.json()) as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]!.text).toBe("called:quote");
    const call = stub.calls.filter((c) => c.body.method === "tools/call").at(-1)!;
    expect(call.url).toContain("/api/v1/mcp/server/finance_tianyancha");
    expect((call.body.params as { name: string }).name).toBe("quote");
  });

  it("notifications get 202 with no body", async () => {
    const cred = fullCred();
    const resp = await handler(makeConfig(), cred, officialGatewayStub().fetch)(
      rpc({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(resp.status).toBe(202);
    expect(await resp.text()).toBe("");
  });

  it("batches: replies collected for requests only", async () => {
    const cred = fullCred();
    const resp = await handler(makeConfig(), cred, officialGatewayStub().fetch)(
      rpc([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
        "not-a-message",
      ]),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Array<{ id: number | null }>;
    // The invalid element earns an id:null error reply per JSON-RPC 2.0 section 5.1.
    expect(body.map((r) => r.id)).toEqual([1, 2, null]);
  });

  it("invalid JSON → 400 -32700; empty batch → 400 -32600", async () => {
    const cred = fullCred();
    const h = handler(makeConfig(), cred, officialGatewayStub().fetch);
    const bad = await h(rpc("{oops"));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700);
    const empty = await h(rpc([]));
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: { code: number } }).error.code).toBe(-32600);
  });
});

describe("/mcp gates", () => {
  it("start-plan → 400 mcp_plan_unsupported", async () => {
    const cred = fullCred();
    const resp = await handler(makeConfig(), cred, officialGatewayStub().fetch, ["start-plan"])(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: { type: string } }).error.type).toBe("mcp_plan_unsupported");
  });

  it("JWT-only credential (imported plan token) → 400 mcp_credentials_unavailable", async () => {
    const resp = await handler(makeConfig(), fullCred({ apiKey: "" }), officialGatewayStub().fetch)(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: { type: string } }).error.type).toBe("mcp_credentials_unavailable");
  });

  it("no account → 400 mcp_credentials_unavailable", async () => {
    // 空账号仓：broker 拒绝出线，/mcp 回 400（MCP 不占并发槽，只借凭据）。
    const empty = inMemoryAccounts([]);
    const h = createFetchHandler({ config: makeConfig(), broker: empty.broker, accounts: empty.manager, fetchImpl: officialGatewayStub().fetch });
    const resp = await h(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: { type: string } }).error.type).toBe("mcp_credentials_unavailable");
  });

  it("the API key gate applies to /mcp like every other route, and counts the request", async () => {
    const cred = fullCred();
    const keys = new ApiKeyManager(memoryApiKeysStore());
    const created = await keys.create("mcp-client");
    if (!created.ok || !created.key) throw new Error("test key creation failed");
    const h = handler(makeConfig({ auth: { requireKey: true } }), cred, officialGatewayStub().fetch, ["coding-plan"], keys);

    const denied = await h(new Request("http://localhost/mcp"));
    expect(denied.status).toBe(401);

    const allowed = await h(new Request("http://localhost/mcp", { headers: { authorization: `Bearer ${created.key}` } }));
    expect(allowed.status).toBe(200);
    // /mcp 是数据面：请求数与状态码要记在这把 key 上。
    expect((await keys.list())[0]!.usage.requests).toBe(1);
  });

  it("a re-login (credential change) rebuilds the aggregate automatically", async () => {
    const cred = fullCred();
    const stub = officialGatewayStub();
    const h = handler(makeConfig(), cred, stub.fetch);
    await h(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const initsFirst = stub.calls.filter((c) => c.body.method === "initialize").length;
    // 换一份凭据 = 换一个账号（指纹不同）→ 聚合器按指纹缓存，必须重建会话。
    const h2 = handler(makeConfig(), fullCred({ jwt: "jwt-2" }), stub.fetch);
    await h2(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const initsSecond = stub.calls.filter((c) => c.body.method === "initialize").length;
    expect(initsSecond).toBe(initsFirst * 2); // fresh sessions for the new credential
  });
});

describe("DELETE /mcp", () => {
  it("closes cached upstream sessions with 202", async () => {
    const cred = fullCred();
    const stub = officialGatewayStub();
    const h = handler(makeConfig(), cred, stub.fetch);
    await h(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const resp = await h(new Request("http://localhost/mcp", { method: "DELETE" }));
    expect(resp.status).toBe(202);
    expect(stub.calls.some((c) => c.method === "DELETE")).toBe(true);
  });
});

/** 官方目录里的插件数 = 一个实例的上游会话数（每个插件一条 `Mcp-Session-Id`）。*/
const PLUGIN_COUNT = OFFICIAL_MCP_CATALOGUE.servers.length;

/** 建一个 handler 并把账号仓一起交出来（清理用例要能删 / 禁账号）。*/
function handlerWithManager(
  config: ProxyConfig,
  cred: Credential,
  fetchImpl: typeof fetch,
): { handle: (req: Request) => Promise<Response>; manager: ReturnType<typeof brokerFor>["manager"] } {
  const { broker, manager } = brokerFor({
    kind: "zhipu-account",
    provider: cred.provider,
    apiKey: cred.apiKey,
    ...(cred.secret ? { secret: cred.secret } : {}),
    ...(cred.jwt ? { jwt: cred.jwt } : {}),
    identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
  }, ["coding-plan"]);
  return { handle: createFetchHandler({ config, broker, accounts: manager, fetchImpl }), manager };
}

const toolsListRpc = (id: number) => rpc({ jsonrpc: "2.0", id, method: "tools/list" });

/** 让 `onChange` 触发的异步清理（closeAll）跑完。*/
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 一次 initialize 调用数（每个插件一次，所以实例数 = inits / PLUGIN_COUNT）。*/
const inits = (calls: Array<{ body: Record<string, unknown> }>): number =>
  calls.filter((c) => c.body.method === "initialize").length;

/** 关闭上游会话的 DELETE 调用，按账号 JWT 归组。*/
function closesByAccount(calls: Array<{ method: string; headers: Record<string, string> }>): Map<string, number> {
  const byAccount = new Map<string, number>();
  for (const call of calls) {
    if (call.method !== "DELETE") continue;
    const auth = call.headers["Authorization"] ?? "";
    byAccount.set(auth, (byAccount.get(auth) ?? 0) + 1);
  }
  return byAccount;
}

describe("/mcp 多账号聚合缓存", () => {
  it("两个 fingerprint 各自命中缓存：A → B → A 不重建 A", async () => {
    const stub = officialGatewayStub();
    const credA = fullCred();
    const credB = fullCred({ jwt: "jwt-b" });
    const handleA = handler(makeConfig(), credA, stub.fetch);
    const handleB = handler(makeConfig(), credB, stub.fetch);

    await handleA(toolsListRpc(1));
    const afterA = inits(stub.calls);
    expect(afterA).toBe(PLUGIN_COUNT);

    await handleB(toolsListRpc(2));
    expect(inits(stub.calls)).toBe(PLUGIN_COUNT * 2);

    // 回到 A：命中缓存，一条 initialize 都不该再发（单槽实现这里会重建）。
    await handleA(toolsListRpc(3));
    expect(inits(stub.calls)).toBe(PLUGIN_COUNT * 2);
  });

  it("LRU 超限淘汰最久未用的实例，并在淘汰前 closeAll", async () => {
    const stub = officialGatewayStub();
    const creds = Array.from({ length: MCP_AGGREGATE_CACHE_LIMIT }, (_, i) => fullCred({ jwt: `jwt-${i}` }));
    const handles = creds.map((cred) => handler(makeConfig(), cred, stub.fetch));
    for (const [i, handle] of handles.entries()) await handle(toolsListRpc(i + 1));
    expect(inits(stub.calls)).toBe(PLUGIN_COUNT * MCP_AGGREGATE_CACHE_LIMIT);
    expect(closesByAccount(stub.calls).size).toBe(0);

    // 重新命中第 0 个 → 它变成"最近使用"，最久未用变成第 1 个。
    await handles[0]!(toolsListRpc(99));
    expect(inits(stub.calls)).toBe(PLUGIN_COUNT * MCP_AGGREGATE_CACHE_LIMIT);

    // 第 LIMIT+1 个账号进缓存 → 淘汰第 1 个，且先 closeAll 它的全部上游会话。
    const overflowHandle = handler(makeConfig(), fullCred({ jwt: "jwt-overflow" }), stub.fetch);
    await overflowHandle(toolsListRpc(100));
    expect(inits(stub.calls)).toBe(PLUGIN_COUNT * (MCP_AGGREGATE_CACHE_LIMIT + 1));

    const closes = closesByAccount(stub.calls);
    expect(closes.get(`Bearer jwt-1`)).toBe(PLUGIN_COUNT);
    // 被重新命中的第 0 个没被淘汰。
    expect(closes.get("Bearer jwt-0")).toBeUndefined();

    // 被淘汰的实例确实没了：再请求第 1 个账号要重新建会话。
    await handles[1]!(toolsListRpc(101));
    expect(inits(stub.calls)).toBe(PLUGIN_COUNT * (MCP_AGGREGATE_CACHE_LIMIT + 2));
  });

  it("账号删除清理它的聚合实例（onChange → closeAll）", async () => {
    const stub = officialGatewayStub();
    const { handle, manager } = handlerWithManager(makeConfig(), fullCred(), stub.fetch);
    await handle(toolsListRpc(1));
    expect(inits(stub.calls)).toBe(PLUGIN_COUNT);
    expect(closesByAccount(stub.calls).size).toBe(0);

    const account = (await manager.list())[0]!;
    expect(await manager.remove(account.id)).toBe(true);
    await settle();

    expect(closesByAccount(stub.calls).get("Bearer jwt-1")).toBe(PLUGIN_COUNT);
    // 账号没了：再请求直接 400（MCP 不占槽，只借凭据）。
    const after = await handle(toolsListRpc(2));
    expect(after.status).toBe(400);
  });

  it("账号禁用同样清理它的聚合实例", async () => {
    const stub = officialGatewayStub();
    // 这个用例走 `manager.update`（写入期校验），所以凭据要带齐 apiKey 对。
    const { handle, manager } = handlerWithManager(makeConfig(), fullCred({ secret: "sec" }), stub.fetch);
    await handle(toolsListRpc(1));
    const account = (await manager.list())[0]!;
    await manager.update(account.id, { enabled: false });
    await settle();
    expect(closesByAccount(stub.calls).get("Bearer jwt-1")).toBe(PLUGIN_COUNT);
  });

  it("DELETE /mcp 关闭全部账号的实例", async () => {
    const stub = officialGatewayStub();
    const handleA = handler(makeConfig(), fullCred(), stub.fetch);
    const handleB = handler(makeConfig(), fullCred({ jwt: "jwt-b" }), stub.fetch);
    await handleA(toolsListRpc(1));
    await handleB(toolsListRpc(2));
    expect(closesByAccount(stub.calls).size).toBe(0);

    const resp = await handleA(new Request("http://localhost/mcp", { method: "DELETE" }));
    expect(resp.status).toBe(202);
    const closes = closesByAccount(stub.calls);
    expect(closes.get("Bearer jwt-1")).toBe(PLUGIN_COUNT);
    expect(closes.get("Bearer jwt-b")).toBe(PLUGIN_COUNT);
  });
});
