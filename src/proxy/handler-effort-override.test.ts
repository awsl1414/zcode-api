/**
 * 推理强度覆盖的链路级测试：覆盖档位必须在**每一条出线路径**上真的改写了
 * 发往上游的 body。单元测试（effort-override.test.ts / body-transformer.test.ts）
 * 只证明函数本身，证明不了「线上那条路径真的传了 ctx.effortOverride」；
 * 「字段声明了、传进去了、但那条路径没接」正是靠这里拦的。
 *
 * 四条路径：`/v1/messages`（Anthropic 直传）、`/v1/chat/completions`（OpenAI 翻译链）、
 * `/v1/responses`（Responses 收敛链）、`/async/v1/*`（闲时通道的两条入站协议）。
 * 上游一律 mock fetch，捕获出线 body 逐字段断言；记录侧断言
 * `reasoningEffortOverride`（与客户端原始要求 `reasoningEffort` 并排）。
 *
 * 透传零行为变化也在链路上钉一条：不带 reasoning 段的 config（= 缺省），body 原样。
 */
import { describe, expect, it } from "bun:test";
import { proxyRequest } from "./handler.js";
import { handleResponses } from "./responses-handler.js";
import { handleAsyncMessages, handleAsyncChat } from "../async/handler.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { accountFor, inMemoryAccounts, zhipuCredential } from "../accounts/testing.js";
import { defaultPolicy } from "../accounts/types.js";
import type { Account, Credential, RouteKind } from "../accounts/types.js";
import { RequestStore } from "./request-record.js";

const IDENTITY: ProxyIdentity = {
  appVersion: "test-1.0.0",
  appVersionSource: "default",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
  betaPolicy: "drop",
  betaAllowlist: [],
};

const TEST_CONFIG: ProxyConfig = {
  server: { port: 8080, host: "0.0.0.0" },
  auth: { requireKey: false },
  providers: {
    zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
    bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
  },
  defaultModel: "glm-4.6",
  models: ["glm-4.6"],
  identity: IDENTITY,
  clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
  responses: { storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false },
  highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
  mcp: { enabled: true, gateway: { enabled: true, upstreamOrigin: "https://zcode.chatglm.site" } },
  async: { enabled: true, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, sprintWindowMs: 1800000, sprintPollIntervalMs: 60000 },
  logging: { level: "info" },
};

/** 覆盖模式的 config 变体：spread 基座 + reasoning 段（字段可选，正好测「省略=透传」）。 */
function configWithReasoning(reasoning: ProxyConfig["reasoning"], model = "glm-5.3"): ProxyConfig {
  return { ...TEST_CONFIG, defaultModel: model, models: [model], reasoning };
}

function credential(tag: string): Credential {
  return zhipuCredential({ apiKey: `key-${tag}`, secret: `secret-${tag}`, jwt: `jwt-${tag}` });
}

function account(label: string, routes: RouteKind[] = ["coding-plan"]): Account {
  return accountFor(credential(label), { label, routes, policy: defaultPolicy({ maxConcurrency: 2 }) });
}

function brokerForAccounts(labels: string[] = ["a"]) {
  return inMemoryAccounts(labels.map((label) => account(label)), {
    routing: { order: ["coding-plan"], onSaturated: "wait" },
  }).broker;
}

/** 关掉全部叠加层：这些用例只关心 body 改写与记录字段。 */
const PLAIN = { endpointRouting: null, clientSigning: null, highspeed: null } as const;

function mockFetch(impl: (req: Request) => Promise<Response>): typeof fetch {
  return Object.assign(impl, { preconnect: () => {} }) as typeof fetch;
}

/** 捕获每条出线 body 的 mock fetch（同步数组，测试断言前上游应答已消费完）。 */
function bodyCapturingFetch(bodies: Record<string, unknown>[], reply: (req: Request) => Response): typeof fetch {
  return mockFetch(async (req: Request) => {
    bodies.push((await req.json()) as Record<string, unknown>);
    return reply(req);
  });
}

function anthropicBatch(): string {
  return JSON.stringify({
    id: "msg_w103",
    type: "message",
    role: "assistant",
    model: "glm-5.3",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

function anthropicSse(): string {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_s", type: "message", role: "assistant", model: "glm-5.3", content: [], usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
}

function batchResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

function sseResponse(sse: string): Response {
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function recordOf(store: RequestStore) {
  const [record] = store.recent(1);
  if (!record) throw new Error("没有落进 RequestStore 的记录");
  return record;
}

describe("effort override — /v1/messages (Anthropic passthrough)", () => {
  it("rewrites glm-5.3 to the low tier: paired thinking + output_config, sampling dropped", async () => {
    const requests = new RequestStore();
    const bodies: Record<string, unknown>[] = [];
    const resp = await proxyRequest(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", max_tokens: 4096, temperature: 0.7, messages: [{ role: "user", content: "hi" }] }),
      }),
      "anthropic",
      {
        config: configWithReasoning({ mode: "override", effort: "low" }),
        broker: brokerForAccounts(),
        requests,
        fetchImpl: bodyCapturingFetch(bodies, () => batchResponse(anthropicBatch())),
        ...PLAIN,
      },
    );
    expect(resp.status).toBe(200);
    await resp.text();

    const upstream = bodies[0];
    expect(upstream.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    expect(upstream.output_config).toEqual({ effort: "low" });
    // oldBudget = 0（客户端没带 thinking），max_tokens += 8000 − 0。
    expect(upstream.max_tokens).toBe(4096 + 8000);
    expect(upstream.temperature).toBeUndefined();

    const record = recordOf(requests);
    expect(record.reasoningEffortOverride).toBe("low");
    expect(record.stages.find((s) => s.stage === "intake")?.fields.reasoningEffortOverride).toBe("low");
  });

  it("off tier: thinking disabled, output_config dropped, budget refunded", async () => {
    const requests = new RequestStore();
    const bodies: Record<string, unknown>[] = [];
    const resp = await proxyRequest(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "glm-5.3",
          max_tokens: 20_000,
          thinking: { type: "enabled", budget_tokens: 16_000 },
          output_config: { effort: "high" },
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      "anthropic",
      {
        config: configWithReasoning({ mode: "override", effort: "off" }),
        broker: brokerForAccounts(),
        requests,
        fetchImpl: bodyCapturingFetch(bodies, () => batchResponse(anthropicBatch())),
        ...PLAIN,
      },
    );
    await resp.text();

    const upstream = bodies[0];
    expect(upstream.thinking).toEqual({ type: "disabled" });
    expect(upstream.output_config).toBeUndefined();
    expect(upstream.max_tokens).toBe(4000);
    const record = recordOf(requests);
    expect(record.reasoningEffortOverride).toBe("off");
  });

  it("passthrough (no reasoning section): the body leaves byte-identical in shape", async () => {
    const requests = new RequestStore();
    const bodies: Record<string, unknown>[] = [];
    const resp = await proxyRequest(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", max_tokens: 4096, temperature: 0.7, messages: [{ role: "user", content: "hi" }] }),
      }),
      "anthropic",
      {
        config: TEST_CONFIG,
        broker: brokerForAccounts(),
        requests,
        fetchImpl: bodyCapturingFetch(bodies, () => batchResponse(anthropicBatch())),
        ...PLAIN,
      },
    );
    await resp.text();

    const upstream = bodies[0];
    expect(upstream.thinking).toBeUndefined();
    expect(upstream.output_config).toBeUndefined();
    expect(upstream.max_tokens).toBe(4096);
    expect(upstream.temperature).toBe(0.7);
    const record = recordOf(requests);
    expect(record.reasoningEffortOverride).toBeUndefined();
    expect(record.stages.find((s) => s.stage === "intake")?.fields.reasoningEffortOverride).toBeUndefined();
  });

  it("non-reasoning models are untouched even in override mode", async () => {
    const requests = new RequestStore();
    const bodies: Record<string, unknown>[] = [];
    const resp = await proxyRequest(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6v", max_tokens: 4096, temperature: 0.7, messages: [{ role: "user", content: "hi" }] }),
      }),
      "anthropic",
      {
        config: configWithReasoning({ mode: "override", effort: "low" }, "glm-4.6v"),
        broker: brokerForAccounts(),
        requests,
        fetchImpl: bodyCapturingFetch(bodies, () => batchResponse(anthropicBatch())),
        ...PLAIN,
      },
    );
    await resp.text();

    const upstream = bodies[0];
    expect(upstream.thinking).toBeUndefined();
    expect(upstream.output_config).toBeUndefined();
    expect(upstream.temperature).toBe(0.7);
    expect(recordOf(requests).reasoningEffortOverride).toBeUndefined();
  });
});

describe("effort override — /v1/chat/completions (translate path)", () => {
  it("rewrites the translated body: tier budget replaces the client's, delta lands on max_tokens", async () => {
    const requests = new RequestStore();
    const bodies: Record<string, unknown>[] = [];
    const resp = await proxyRequest(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 64, reasoning_effort: "low", messages: [{ role: "user", content: "hi" }] }),
      }),
      "openai",
      {
        config: configWithReasoning({ mode: "override", effort: "max" }, "glm-4.6"),
        broker: brokerForAccounts(),
        requests,
        fetchImpl: bodyCapturingFetch(bodies, () => batchResponse(anthropicBatch())),
        ...PLAIN,
      },
    );
    expect(resp.status).toBe(200);
    await resp.text();

    const upstream = bodies[0];
    // 翻译层先把客户端 low 落成 budget 1024（max_tokens = 64 + 1024 = 2088）；覆盖
    // max 档把 budget 换成 32000，max_tokens += 32000 − 1024 = 33064。glm-4.6 不带
    // output_config（GLM-5.3+ 专属通道）。
    expect(upstream.thinking).toEqual({ type: "enabled", budget_tokens: 32_000 });
    expect(upstream.output_config).toBeUndefined();
    expect(upstream.max_tokens).toBe(64 + 1024 + (32_000 - 1024));
    const record = recordOf(requests);
    // 记录双口径：客户端原始要求 low，实际出线 max。
    expect(record.reasoningEffort).toBe("low");
    expect(record.reasoningEffortOverride).toBe("max");
  });
});

describe("effort override — /v1/responses (converge path)", () => {
  it("rewrites the converged body and keeps both record vocabularies side by side", async () => {
    const requests = new RequestStore();
    const bodies: Record<string, unknown>[] = [];
    const resp = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", input: "hi", reasoning: { effort: "high" } }),
      }),
      {
        config: configWithReasoning({ mode: "override", effort: "low" }),
        broker: brokerForAccounts(),
        requests,
        fetchImpl: bodyCapturingFetch(bodies, () => batchResponse(anthropicBatch())),
        ...PLAIN,
      },
    );
    expect(resp.status).toBe(200);
    await resp.text();

    const upstream = bodies[0];
    expect(upstream.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    expect(upstream.output_config).toEqual({ effort: "low" });
    const record = recordOf(requests);
    expect(record.reasoningEffort).toBe("high");
    expect(record.reasoningEffortOverride).toBe("low");
  });
});

/** async 通道的 mock fetch：票券直通 ready，LLM 端点捕获 body 回 Anthropic SSE。 */
function asyncMockFetch(bodies: Record<string, unknown>[]): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (href.includes("/ticket/availability")) {
      return new Response(JSON.stringify({ canTakeNumber: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.endsWith("/ticket")) {
      return new Response(JSON.stringify({ ticket_id: "t-w103", state: "ready" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("/ticket/status")) {
      return new Response(JSON.stringify({ tickets: [{ ticket_id: "t-w103", state: "ready" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("/settle")) {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("/anthropic/v1/messages")) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse(anthropicSse());
    }
    throw new Error(`asyncMockFetch: unexpected URL ${href}`);
  };
}

describe("effort override — async off-peak bridge", () => {
  it("/async/v1/messages: rewrites the bridged body (Anthropic inbound)", async () => {
    const requests = new RequestStore();
    const bodies: Record<string, unknown>[] = [];
    const resp = await handleAsyncMessages(
      new Request("http://localhost/async/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", max_tokens: 4096, stream: true, messages: [{ role: "user", content: "hi" }] }),
      }),
      {
        config: configWithReasoning({ mode: "override", effort: "low" }),
        broker: brokerForAccounts(),
        requests,
        fetchImpl: asyncMockFetch(bodies),
      },
    );
    expect(resp.status).toBe(200);
    await resp.text();

    const upstream = bodies[0];
    expect(upstream.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    expect(upstream.output_config).toEqual({ effort: "low" });
    expect(upstream.max_tokens).toBe(4096 + 8000);
    const record = recordOf(requests);
    expect(record.reasoningEffortOverride).toBe("low");
    expect(record.stages.find((s) => s.stage === "intake")?.fields.reasoningEffortOverride).toBe("low");
  });

  it("/async/v1/chat/completions: rewrites the translated body (OpenAI inbound)", async () => {
    const requests = new RequestStore();
    const bodies: Record<string, unknown>[] = [];
    const resp = await handleAsyncChat(
      new Request("http://localhost/async/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", max_tokens: 4096, stream: true, messages: [{ role: "user", content: "hi" }] }),
      }),
      {
        config: configWithReasoning({ mode: "override", effort: "low" }),
        broker: brokerForAccounts(),
        requests,
        fetchImpl: asyncMockFetch(bodies),
      },
    );
    expect(resp.status).toBe(200);
    await resp.text();

    const upstream = bodies[0];
    expect(upstream.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    expect(upstream.output_config).toEqual({ effort: "low" });
    const record = recordOf(requests);
    expect(record.reasoningEffortOverride).toBe("low");
  });

  it("async passthrough: bridged body untouched without a reasoning section", async () => {
    const requests = new RequestStore();
    const bodies: Record<string, unknown>[] = [];
    const resp = await handleAsyncMessages(
      new Request("http://localhost/async/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", max_tokens: 4096, stream: true, messages: [{ role: "user", content: "hi" }] }),
      }),
      {
        config: { ...TEST_CONFIG, defaultModel: "glm-5.3", models: ["glm-5.3"] },
        broker: brokerForAccounts(),
        requests,
        fetchImpl: asyncMockFetch(bodies),
      },
    );
    expect(resp.status).toBe(200);
    await resp.text();

    const upstream = bodies[0];
    expect(upstream.thinking).toBeUndefined();
    expect(upstream.output_config).toBeUndefined();
    expect(upstream.max_tokens).toBe(4096);
    expect(recordOf(requests).reasoningEffortOverride).toBeUndefined();
  });
});
