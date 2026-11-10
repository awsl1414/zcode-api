/**
 * Tests for server routing and data-plane API key auth.
 */
import { describe, it, expect } from "bun:test";
import { createFetchHandler } from "./server.js";
import { SessionStore } from "../users/session.js";
import { ApiKeyManager } from "../apikeys/manager.js";
import { memoryApiKeysStore } from "../apikeys/testing.js";
import { handleListModels } from "./routes-openai.js";
import type { ProxyConfig } from "../config/types.js";
import { brokerFor } from "../accounts/testing.js";

/**
 * 一个 coding-plan 账号的 broker + 账号仓（`startServer` 需要两者）。
 * 凭据与路由都来自 `broker.acquire()`，不是进程级 `AuthManager`。
 */
function codingPlanServer(key = "testkey.testsecret") {
  const [apiKey, secret] = key.split(".");
  const { broker, manager } = brokerFor({
    kind: "zhipu-account",
    provider: "zai",
    apiKey,
    ...(secret ? { secret } : {}),
    identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
  });
  return { broker, accounts: manager };
}


function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: { requireKey: false, ...overrides.auth },
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
    mcp: { enabled: true, gateway: { enabled: true, upstreamOrigin: "https://zcode.chatglm.site" } },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, sprintWindowMs: 1800000, sprintPollIntervalMs: 60000 },
    logging: { level: "info" },
    ...overrides,
  };
}

function mockUpstream(): typeof fetch {
  return (async (req: Request): Promise<Response> => {
    const url = req.url;
    if (url.includes("/v1/models") || req.method === "GET") {
      return new Response('{"object":"list","data":[]}', { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = await req.text();
    const parsed = JSON.parse(body);
    if (url.includes("/anthropic/") || url.includes("/v1/messages")) {
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello from upstream" }],
          model: parsed.model ?? "glm-4.6",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: Date.now(),
        model: parsed.model ?? "glm-4.6",
        choices: [{ index: 0, message: { role: "assistant", content: "Hello from upstream" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

describe("server routing", () => {
  it("POST /v1/chat/completions forwards to upstream", async () => {
    const config = makeConfig();
    const { broker, accounts } = codingPlanServer();
    const handler = createFetchHandler({ config, broker, accounts, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] }),
      }),
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.choices[0].message.content).toBe("Hello from upstream");
  });

  it("POST /v1/messages returns Anthropic-compatible response", async () => {
    const config = makeConfig();
    const { broker, accounts } = codingPlanServer();
    const handler = createFetchHandler({ config, broker, accounts, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 100, messages: [{ role: "user", content: "Hi" }] }),
      }),
    );
    expect(resp.status).toBe(200);
  });

  it("POST /v1/responses is mounted with no switch at all (always-on protocol)", async () => {
    // 配置里没有任何 enabled 可写：三条入站协议都是一等公民，挂载是无条件的。
    // 这里连 responses 段都整个不给（等价于只有 store 默认值的最简配置）。
    const config = { ...makeConfig(), responses: { storeMaxEntries: 1000, storeTtlMs: 86400000 } };
    const { broker, accounts } = codingPlanServer();
    let upstreamCalls = 0;
    const fetchImpl = Object.assign(async (_request: RequestInfo | URL): Promise<Response> => {
      upstreamCalls++;
      return new Response("unexpected", { status: 500 });
    }, { preconnect: fetch.preconnect });
    const handler = createFetchHandler({ config, broker, accounts, fetchImpl });

    const resp = await handler(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", input: "Hi" }),
    }));
    // 404 = 路由没挂上；能打到上游（哪怕上游 500）就证明路由挂载无条件。
    expect(resp.status).toBe(500);
    expect(upstreamCalls).toBeGreaterThan(0);
  });

  it("returns async_plan_unsupported on /async/* when no account can run async", async () => {
    // 判据是"有没有账号同时持有 plan JWT 与 coding-plan API key"，不是全局 plan。
    // start-plan 账号（无 apiKey 对）不满足。
    const config = makeConfig({
      async: { enabled: true, origin: "https://zcode.z.ai", pollIntervalMs: 10, keepAliveIntervalMs: 5, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 100, controlTimeoutMs: 1000, defaultModel: "" },
    });
    const { broker, manager } = brokerFor({
      kind: "zhipu-account",
      provider: "zai",
      apiKey: "",
      jwt: "jwt-only",
      identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
    }, ["start-plan"]);
    const handler = createFetchHandler({ config, broker, accounts: manager, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] }),
    }));
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("async_plan_unsupported");
  });

  it("GET /health returns ok status", async () => {
    const config = makeConfig();
    const { broker, accounts } = codingPlanServer("test");
    const handler = createFetchHandler({ config, broker, accounts });

    const resp = await handler(new Request("http://localhost/health"));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
  });
});

describe("data-plane API key auth (\u00a734.3)", () => {
  /** 一个「表里已经有一把 key」的 handler，外加那把 key 的明文与仓。*/
  async function gated() {
    const keys = new ApiKeyManager(memoryApiKeysStore());
    const created = await keys.create("claude-code-laptop");
    if (!created.ok || !created.key) throw new Error("test key creation failed");
    const config = makeConfig({ auth: { requireKey: true } });
    const { broker, accounts } = codingPlanServer("test");
    return { keys, key: created.key, config, broker, accounts };
  }

  it("lets /v1/* through while the key table is empty (first start)", async () => {
    const config = makeConfig({ auth: { requireKey: true } });
    const { broker, accounts } = codingPlanServer("test");
    // 空仓：还没人建过 key，闸门必须放行，否则用户连建 key 的面板入口都进不去。
    const handler = createFetchHandler({ config, broker, accounts, apiKeys: new ApiKeyManager(memoryApiKeysStore()), fetchImpl: mockUpstream() });
    const resp = await handler(new Request("http://localhost/v1/models"));
    expect(resp.status).toBe(200);
  });

  it("rejects a keyless request once a key exists", async () => {
    const g = await gated();
    const handler = createFetchHandler({ config: g.config, broker: g.broker, accounts: g.accounts, apiKeys: g.keys, fetchImpl: mockUpstream() });
    const resp = await handler(new Request("http://localhost/v1/models"));
    expect(resp.status).toBe(401);
    expect(((await resp.json()) as { error: { type: string } }).error.type).toBe("authentication_error");
  });

  it("rejects a wrong key", async () => {
    const g = await gated();
    const handler = createFetchHandler({ config: g.config, broker: g.broker, accounts: g.accounts, apiKeys: g.keys, fetchImpl: mockUpstream() });
    const resp = await handler(new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${"sk-zcp-".concat("A".repeat(43))}` } }));
    expect(resp.status).toBe(401);
  });

  it("accepts the right key via Authorization: Bearer and via x-api-key", async () => {
    const g = await gated();
    const handler = createFetchHandler({ config: g.config, broker: g.broker, accounts: g.accounts, apiKeys: g.keys, fetchImpl: mockUpstream() });

    const bearer = await handler(new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${g.key}` } }));
    expect(bearer.status).toBe(200);

    const apiKeyHeader = await handler(new Request("http://localhost/v1/models", { headers: { "x-api-key": g.key } }));
    expect(apiKeyHeader.status).toBe(200);
  });

  it("rejects a disabled key", async () => {
    const g = await gated();
    const [record] = await g.keys.list();
    expect((await g.keys.setEnabled(record!.id, false)).ok).toBe(true);
    const handler = createFetchHandler({ config: g.config, broker: g.broker, accounts: g.accounts, apiKeys: g.keys, fetchImpl: mockUpstream() });
    const resp = await handler(new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${g.key}` } }));
    expect(resp.status).toBe(401);
  });

  it("also accepts a control-plane session cookie (\u00a734.2, so the panel's chat view needs no second key)", async () => {
    const g = await gated();
    const sessions = new SessionStore();
    const token = sessions.create("admin");
    const handler = createFetchHandler({ config: g.config, broker: g.broker, accounts: g.accounts, apiKeys: g.keys, sessions, fetchImpl: mockUpstream() });

    const resp = await handler(
      new Request("http://localhost/v1/models", {
        headers: { cookie: `theme=dark; session=${token}` },
      }),
    );
    expect(resp.status).toBe(200);
  });

  it("rejects an unknown session cookie and a keyless request together", async () => {
    const g = await gated();
    const sessions = new SessionStore();
    const handler = createFetchHandler({ config: g.config, broker: g.broker, accounts: g.accounts, apiKeys: g.keys, sessions, fetchImpl: mockUpstream() });

    const forged = await handler(
      new Request("http://localhost/v1/models", {
        headers: { cookie: "session=zcp_sess_not-a-real-token" },
      }),
    );
    expect(forged.status).toBe(401);
  });

  it("does not require a key when auth.requireKey is false", async () => {
    const config = makeConfig({ auth: { requireKey: false } });
    const keys = new ApiKeyManager(memoryApiKeysStore());
    await keys.create("whatever");
    const { broker, accounts } = codingPlanServer("test");
    const handler = createFetchHandler({ config, broker, accounts, apiKeys: keys, fetchImpl: mockUpstream() });

    const resp = await handler(new Request("http://localhost/v1/models"));
    expect(resp.status).toBe(200);
  });

  it("attributes usage to the key that made the request", async () => {
    const g = await gated();
    const sessions = new SessionStore();
    const handler = createFetchHandler({ config: g.config, broker: g.broker, accounts: g.accounts, apiKeys: g.keys, sessions, fetchImpl: mockUpstream() });

    for (let i = 0; i < 2; i += 1) {
      const resp = await handler(new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${g.key}` } }));
      expect(resp.status).toBe(200);
    }
    // 会话 cookie 没有 key 可归因：它不该改变任何一把 key 的计数。
    const token = sessions.create("admin");
    await handler(new Request("http://localhost/v1/models", { headers: { cookie: `session=${token}` } }));

    const [record] = await g.keys.list();
    expect(record!.usage.requests).toBe(2);
    expect(record!.usage.todayRequests).toBe(2);
    expect(record!.usage.lastUsedAt).not.toBeNull();
  });
});

describe("CORS", () => {
  it("emits CORS headers when the data plane actually requires a key", async () => {
    const keys = new ApiKeyManager(memoryApiKeysStore());
    await keys.create("ci");
    const config = makeConfig({ auth: { requireKey: true } });
    const { broker, accounts } = codingPlanServer("test");
    const handler = createFetchHandler({ config, broker, accounts, apiKeys: keys });

    const resp = await handler(new Request("http://localhost/v1/models", { method: "OPTIONS" }));
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
    expect(resp.headers.get("access-control-allow-methods")).toContain("DELETE");
  });

  it("open deployment (no key required, or no key created yet) emits no CORS headers (blocks cross-origin browsers)", async () => {
    const openConfig = makeConfig({ auth: { requireKey: false } });
    const { broker, accounts } = codingPlanServer("test");
    const openKeys = new ApiKeyManager(memoryApiKeysStore());
    await openKeys.create("ignored");
    const openHandler = createFetchHandler({ config: openConfig, broker, accounts, apiKeys: openKeys });

    const preflight = await openHandler(new Request("http://localhost/v1/models", { method: "OPTIONS" }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

    const resp = await openHandler(new Request("http://localhost/v1/models", { method: "GET" }));
    expect(resp.headers.get("access-control-allow-origin")).toBeNull();

    // 表空时同理：闸门没生效，就不该替跨源浏览器开口子。
    const emptyKeys = new ApiKeyManager(memoryApiKeysStore());
    const emptyHandler = createFetchHandler({
      config: makeConfig({ auth: { requireKey: true } }),
      broker,
      accounts,
      apiKeys: emptyKeys,
    });
    const emptyPreflight = await emptyHandler(new Request("http://localhost/v1/models", { method: "OPTIONS" }));
    expect(emptyPreflight.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("web UI", () => {
  /** 闸门真的开着（`requireKey` + 表里有一把 key）：断言「没凭据 → 401」的前提。*/
  async function gatedWebHandler() {
    const keys = new ApiKeyManager(memoryApiKeysStore());
    await keys.create("ci");
    const { broker, accounts } = codingPlanServer("test");
    return createFetchHandler({
      config: makeConfig({ auth: { requireKey: true } }),
      broker,
      accounts,
      apiKeys: keys,
      fetchImpl: mockUpstream(),
    });
  }

  it("retires /chat: no standalone page, the path falls through to the gate", async () => {
    // `/chat` 不是一页 HTML：闸门开着时 GET 与 POST 都落到鉴权闸门（无凭据）→ 401；
    // 闸门关时才会到路由表 → 404。
    const handler = await gatedWebHandler();

    const get = await handler(new Request("http://localhost/chat", { method: "GET" }));
    expect(get.status).toBe(401);
    const body = await get.text();
    expect(body).toContain("authentication_error");
    expect(body).not.toContain("chat-log");

    const post = await handler(new Request("http://localhost/chat", { method: "POST" }));
    expect(post.status).toBe(401);
  });

  it("answers 404 for /chat when the data plane is open", async () => {
    // 闸门关着时（requireKey: false、表空）路径落到路由表：/chat 不在表里，
    // 回代理的稳定 404，而不是一页 HTML。
    const { broker, accounts } = codingPlanServer("test");
    const handler = createFetchHandler({
      config: makeConfig({ auth: { requireKey: false } }),
      broker,
      accounts,
      apiKeys: new ApiKeyManager(memoryApiKeysStore()),
      fetchImpl: mockUpstream(),
    });

    const resp = await handler(new Request("http://localhost/chat", { method: "GET" }));
    expect(resp.status).toBe(404);
    const body = await resp.json();
    expect(body).toMatchObject({ error: { type: "not_found_error" } });
  });

  it("keeps the old /webui path retired (4.x page is gone)", async () => {
    const handler = await gatedWebHandler();

    // `/webui` falls through to the auth gate (key required, no creds) -> 401.
    const resp = await handler(new Request("http://localhost/webui", { method: "GET" }));
    expect(resp.status).toBe(401);
  });
});

describe("route handler exports", () => {
  it("handleListModels advertises the pair the default config lists, plain shape carries both capability styles", async () => {
    const config = makeConfig({ models: ["glm-5.3", "glm-5.3-flash"] });
    const resp = handleListModels(new Request("http://localhost/v1/models"), config);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      object: string;
      data: Array<{
        id: string;
        object: string;
        owned_by: string;
        input_modalities?: string[];
        name?: string;
        description?: string;
        context_length?: number;
        architecture?: { input_modalities?: string[]; output_modalities?: string[]; modality?: string };
        supported_parameters?: string[];
        max_tokens?: number;
        mode?: string;
      }>;
    };
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id)).toEqual(["glm-5.3", "glm-5.3-flash"]);
    for (const m of body.data) {
      expect(m.object).toBe("model");
      expect(m.owned_by).toBe("zcode-proxy");
      // 顶层 input_modalities 不出现：模态只发在 architecture 块里。
      expect("input_modalities" in m).toBe(false);
    }

    // Reasoning-only text model (glm-5.3): OpenRouter 风格全键 + LiteLLM 风格。
    const glm53 = body.data.find((m) => m.id === "glm-5.3")!;
    expect(glm53.name).toBe("GLM 5.3");
    expect(glm53.description).toBe(
      "GLM 5.3: 1,000,000-token context window; up to 128,000 output tokens; reasoning mode.",
    );
    expect(glm53.context_length).toBe(1_000_000);
    expect(glm53.architecture).toEqual({
      input_modalities: ["text"],
      output_modalities: ["text"],
      modality: "text->text",
    });
    expect(glm53.supported_parameters).toEqual(["reasoning"]);
    expect(glm53.max_tokens).toBe(128_000);
    expect(glm53.mode).toBe("chat");

    // Vision + reasoning model (glm-5.3-flash): vision 只进 modality 块，
    // supported_parameters 仍只有 reasoning。
    const flash = body.data.find((m) => m.id === "glm-5.3-flash")!;
    expect(flash.name).toBe("GLM 5.3 Flash");
    expect(flash.context_length).toBe(1_000_000);
    expect(flash.architecture).toEqual({
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      modality: "text+image->text",
    });
    expect(flash.supported_parameters).toEqual(["reasoning"]);
    expect(flash.max_tokens).toBe(128_000);
    expect(flash.mode).toBe("vision");
  });

  it("handleListModels plain shape: vision-only model gets no invented parameter facts", async () => {
    // glm-4.6v：vision 有、reasoning 无 → supported_parameters 空数组 = 「已知、
    // 无特殊参数声明」（与目录外未知的字段缺席区分）。
    const config = makeConfig({ models: ["glm-4.6v", "glm-5v-turbo"] });
    const body = (await handleListModels(new Request("http://localhost/v1/models"), config).json()) as {
      data: Array<Record<string, unknown>>;
    };
    const v46 = body.data.find((m) => m.id === "glm-4.6v")!;
    expect(v46.mode).toBe("vision");
    expect(v46.supported_parameters).toEqual([]);
    expect(v46.max_tokens).toBe(32_768);
    expect(v46.architecture).toMatchObject({ input_modalities: ["text", "image"], modality: "text+image->text" });

    const v5turbo = body.data.find((m) => m.id === "glm-5v-turbo")!;
    expect(v5turbo.name).toBe("GLM 5V Turbo");
    expect(v5turbo.mode).toBe("vision");
    expect(v5turbo.max_tokens).toBe(131_072);
    expect(v5turbo.supported_parameters).toEqual([]);
    expect(v5turbo.description).toBe(
      "GLM 5V Turbo: 200,000-token context window; up to 131,072 output tokens; image input.",
    );
  });

  it("handleListModels rich catalog on client_version=pi", async () => {
    const config = makeConfig({ models: ["glm-5.3", "glm-5.3-flash"] });
    const resp = handleListModels(new Request("http://localhost/v1/models?client_version=pi"), config);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      models: Array<{
        slug: string;
        display_name: string;
        context_window?: number;
        max_tokens?: number;
        input_modalities: string[];
        supported_reasoning_levels: Array<{ effort: string }>;
        visibility: string;
      }>;
      data?: unknown;
    };
    // Rich shape: top-level models[], no data[].
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.data).toBeUndefined();
    // Only the configured pair is listed (config.models is the advertising
    // surface; other catalog ids still forward but are not advertised).
    expect(body.models.map((m) => m.slug)).toEqual(["glm-5.3", "glm-5.3-flash"]);
    const flash = body.models.find((m) => m.slug === "glm-5.3-flash");
    expect(flash).toBeDefined();
    expect(flash!.display_name).toBe("GLM 5.3 Flash");
    expect(flash!.context_window).toBe(1_000_000);
    expect(flash!.max_tokens).toBe(128_000);
    expect(flash!.visibility).toBe("list");
    expect(flash!.input_modalities).toEqual(["text", "image"]);
    expect(body.models.find((m) => m.slug === "glm-5.3")!.input_modalities).toEqual(["text"]);
    // Reasoning model advertises the Codex-style effort levels the DSH
    // better-basicfun bridge maps onto its selector levels.
    const efforts = flash!.supported_reasoning_levels.map((l) => l.effort);
    expect(efforts).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("config.models drives the list: a custom id appears with placeholder capabilities", async () => {
    const config = makeConfig({ models: ["glm-5.3", "my-model"] });

    // Plain shape: listed, owned as custom, alongside the catalog entry. An id
    // outside MODELS has no capability facts, so it carries only the base keys
    // plus name=id — every capability key is absent, "unknown" not "guessed"
    // (the panel chat view fails open on the missing architecture block
    // instead of blocking images on a guess; the rich catalog below keeps its
    // least-claim "text" answer).
    const plain = (await handleListModels(new Request("http://localhost/v1/models"), config).json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(plain.data.map((m) => m.id)).toEqual(["glm-5.3", "my-model"]);
    const custom = plain.data.find((m) => m.id === "my-model")!;
    expect(custom.owned_by).toBe("custom");
    expect(custom.name).toBe("my-model");
    for (const key of [
      "description",
      "context_length",
      "architecture",
      "supported_parameters",
      "max_tokens",
      "mode",
      "input_modalities",
    ]) {
      expect(key in custom).toBe(false);
    }

    // Rich catalog: no invented numbers for an id outside MODELS. The model
    // still forwards upstream (config.models is not a whitelist), so it stays
    // listed; capabilities degrade to the honest minimum.
    const rich = (await handleListModels(new Request("http://localhost/v1/models?client_version=pi"), config).json()) as {
      models: Array<Record<string, unknown>>;
    };
    const richCustom = rich.models.find((m) => m.slug === "my-model");
    expect(richCustom).toBeDefined();
    expect(richCustom!["display_name"]).toBe("my-model");
    expect("context_window" in richCustom!).toBe(false);
    expect("max_context_window" in richCustom!).toBe(false);
    expect("max_tokens" in richCustom!).toBe(false);
    expect(richCustom!["input_modalities"]).toEqual(["text"]);
    expect(richCustom!["supported_reasoning_levels"]).toEqual([]);
    // The catalog entry next to it keeps its full specs.
    const known = rich.models.find((m) => m.slug === "glm-5.3");
    expect(known!["context_window"]).toBe(1_000_000);
  });

  it("config.models drives the list: an id dropped from config disappears", async () => {
    const config = makeConfig({ models: ["glm-5.3-flash"] });
    const plain = (await handleListModels(new Request("http://localhost/v1/models"), config).json()) as {
      data: Array<{ id: string }>;
    };
    expect(plain.data.map((m) => m.id)).toEqual(["glm-5.3-flash"]);

    const rich = (await handleListModels(new Request("http://localhost/v1/models?client_version=pi"), config).json()) as {
      models: Array<{ slug: string }>;
    };
    expect(rich.models.map((m) => m.slug)).toEqual(["glm-5.3-flash"]);
  });
});

// ── 请求记录 ────────────────────────────────────────────────
// 三条入站协议都是一等公民：面板的请求事件 tab 必须三条都能看到。
// createFetchHandler 把同一个 RequestStore 接进三条链路，这里做协议级回归。

import { RequestStore } from "../proxy/request-record.js";

describe("request records across the three inbound protocols", () => {
  it("leaves a record for /v1/messages, /v1/chat/completions and /v1/responses", async () => {
    const store = new RequestStore();
    const { broker, accounts } = codingPlanServer();
    const handler = createFetchHandler({ config: makeConfig(), broker, accounts, fetchImpl: mockUpstream(), requests: store });

    const messages = await handler(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(messages.status).toBe(200);

    const chat = await handler(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(chat.status).toBe(200);

    const responses = await handler(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", input: "hi" }),
    }));
    expect(responses.status).toBe(200);

    // recent 是新的在前；reverse 回请求顺序。
    const records = store.recent(10).reverse();
    expect(records.map((r) => r.format)).toEqual(["anthropic", "openai", "openai"]);
    expect(records.every((r) => r.status === 200)).toBe(true);
    // 三条协议共用一个 reqId 计数器：时序与编号一致。
    expect(records[0]!.reqId).not.toBe(records[1]!.reqId);
    expect(records[1]!.reqId).not.toBe(records[2]!.reqId);
    // 既有 handler 的 record 不回归：anthropic 侧还是老词表。
    expect(records[0]!.stages.map((s) => s.stage)).toContain("intake");
    expect(records[0]!.stages.map((s) => s.stage)).toContain("dispatch");
    // responses 侧现在也有同一条词表。
    expect(records[2]!.stages.map((s) => s.stage)).toContain("upstream-resp");
  });

  it("attributes records to the API key; pass-through stays empty string", async () => {
    const store = new RequestStore();
    const { broker, accounts } = codingPlanServer();
    const keys = new ApiKeyManager(memoryApiKeysStore());
    const created = await keys.create("claude-code-laptop");
    if (!created.ok || !created.key) throw new Error("test key creation failed");
    // requireKey 关着：带 key 的请求归因到那把 key，不带的放行归因为空串。
    const handler = createFetchHandler({
      config: makeConfig({ auth: { requireKey: false } }),
      broker,
      accounts,
      apiKeys: keys,
      fetchImpl: mockUpstream(),
      requests: store,
    });

    const authed = await handler(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${created.key}` },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(authed.status).toBe(200);

    const anonymous = await handler(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(anonymous.status).toBe(200);

    const records = store.recent(10).reverse();
    expect(records).toHaveLength(2);
    expect(records[0]!.apiKeyId).toBe(created.record.id);
    expect(records[1]!.apiKeyId).toBe("");
  });
});
