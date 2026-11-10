/**
 * 请求记录数据层的链路级测试：每个新字段的**写入点**都要有一条真实请求穿过。
 *
 * 为什么必须走 `proxyRequest` / `handleResponses` 而不是直接调用写入函数：最常见的
 * 漏法正是「字段声明了、传进去了、但线上那条路径没写」。单元测试证明不了
 * 「流式出口写了 `responseBytes`」，只有让一条流真的流完才算。
 *
 * 每个字段的读取点在别处（`usage-stats.test.ts` 的聚合、`logs.test.ts` 的渲染），
 * 这里只钉写入侧的事实。
 */
import { describe, expect, it } from "bun:test";
import { proxyRequest } from "./handler.js";
import { handleResponses } from "./responses-handler.js";
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
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, sprintWindowMs: 1800000, sprintPollIntervalMs: 60000 },
  logging: { level: "info" },
};

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

/** 关掉全部叠加层：这些用例只关心记录字段，不关心签名/加速卡/端点改写。 */
const PLAIN = { endpointRouting: null, clientSigning: null, highspeed: null } as const;

function mockFetch(impl: (req: Request) => Promise<Response>): typeof fetch {
  return Object.assign(impl, { preconnect: () => {} }) as typeof fetch;
}

function anthropicBatch(): string {
  return JSON.stringify({
    id: "msg_w74",
    type: "message",
    role: "assistant",
    model: "glm-4.6",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

function anthropicSse(): string {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_s", type: "message", role: "assistant", model: "glm-4.6", content: [], usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
}

function batchResponse(body: string): Response {
  // 有意不给 `content-length`：上游的 batch 应答实测常常是 chunked，直传路径的
  // 字节数必须靠“流过时计数”拿到，不能靠这个头。
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

function sseResponse(sse: string): Response {
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function waitFor(predicate: () => boolean, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function recordOf(store: RequestStore) {
  const [record] = store.recent(1);
  if (!record) throw new Error("没有落进 RequestStore 的记录");
  return record;
}

function messagesReq(body: Record<string, unknown>, init: { signal?: AbortSignal } = {}): Request {
  // 请求记录读的是**客户端原始 body**（reasoning-effort 的口径），所以这里把
  // thinking / reasoning_effort 直接写进请求体，与真实客户端的形状一致。
  const payload = JSON.stringify({ model: "glm-4.6", max_tokens: 64, messages: [{ role: "user", content: "hi" }], ...body });
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    ...(init.signal ? { signal: init.signal } : {}),
  });
}

describe("request fields — /v1/messages (Anthropic passthrough)", () => {
  it("records the thinking budget as reasoningEffort, plus attempts/queue/bytes", async () => {
    const requests = new RequestStore();
    const upstreamBody = anthropicBatch();
    const resp = await proxyRequest(
      messagesReq({ thinking: { type: "enabled", budget_tokens: 32_000 } }),
      "anthropic",
      { config: TEST_CONFIG, broker: brokerForAccounts(), requests, fetchImpl: mockFetch(async () => batchResponse(upstreamBody)), ...PLAIN },
    );
    expect(resp.status).toBe(200);
    // 直传非流式：字节数由计数流在客户端读完 body 时落定（不是 content-length、
    // 也不是提前算出来的），所以先读完再断言。
    const wire = await resp.text();

    const record = recordOf(requests);
    // 推理强度：客户端要了 32000 token 的思考 → 最高档。
    expect(record.reasoningEffort).toBe("high");
    // intake 阶段也带上（排障时间线要能一眼看到）。
    const intake = record.stages.find((stage) => stage.stage === "intake");
    expect(intake?.fields.reasoningEffort).toBe("high");
    // 出线计数：一次成功的请求恒为 1。
    expect(record.upstreamAttempts).toBe(1);
    expect(record.queueMs).toBeGreaterThanOrEqual(0);
    expect(record.requestBytes).toBeGreaterThan(0);
    expect(record.responseBytes).toBe(Buffer.byteLength(wire, "utf8"));
    expect(record.responseBytes).toBe(Buffer.byteLength(upstreamBody, "utf8"));
    expect(record.clientAborted).toBeUndefined();
  });

  it("falls back to content-length when the upstream sends no body at all", async () => {
    const requests = new RequestStore();
    const resp = await proxyRequest(
      messagesReq({}),
      "anthropic",
      { config: TEST_CONFIG, broker: brokerForAccounts(), requests, ...PLAIN, fetchImpl: mockFetch(async () => new Response(null, { status: 204, headers: { "content-length": "0" } })) },
    );
    await resp.text();
    const record = recordOf(requests);
    expect(record.status).toBe(204);
    expect(record.responseBytes).toBe(0);
  });

  it("leaves reasoningEffort absent when the client expressed no thinking intent", async () => {
    const requests = new RequestStore();
    const resp = await proxyRequest(
      messagesReq({}),
      "anthropic",
      { config: TEST_CONFIG, broker: brokerForAccounts(), requests, fetchImpl: mockFetch(async () => batchResponse(anthropicBatch())), ...PLAIN },
    );
    await resp.text();
    const record = recordOf(requests);
    expect(record.reasoningEffort).toBeUndefined();
    expect(record.stages.find((stage) => stage.stage === "intake")?.fields.reasoningEffort).toBeUndefined();
  });

  it("accumulates responseBytes on the streaming path after the stream ends", async () => {
    const requests = new RequestStore();
    const sse = anthropicSse();
    const resp = await proxyRequest(
      messagesReq({ stream: true, output_config: { effort: "max" } }),
      "anthropic",
      { config: TEST_CONFIG, broker: brokerForAccounts(), requests, fetchImpl: mockFetch(async () => sseResponse(sse)), ...PLAIN },
    );
    expect(resp.status).toBe(200);
    const wire = await resp.text();
    const record = recordOf(requests);
    await waitFor(() => record.stages.some((stage) => stage.stage === "stream-end"));
    // 直传流：旁路读的就是客户端拿到的那一份字节。
    expect(record.responseBytes).toBe(Buffer.byteLength(wire, "utf8"));
    expect(record.reasoningEffort).toBe("high");
    expect(record.upstreamAttempts).toBe(1);
    expect(record.clientAborted).toBeUndefined();
  });
});

describe("request fields — /v1/chat/completions (translate path)", () => {
  it("records reasoning_effort and the upstream JSON size for a batch request", async () => {
    const requests = new RequestStore();
    const upstreamBody = anthropicBatch();
    const resp = await proxyRequest(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", reasoning_effort: "medium", messages: [{ role: "user", content: "hi" }] }),
      }),
      "openai",
      { config: TEST_CONFIG, broker: brokerForAccounts(), requests, fetchImpl: mockFetch(async () => batchResponse(upstreamBody)), ...PLAIN },
    );
    expect(resp.status).toBe(200);
    await resp.text();
    const record = recordOf(requests);
    expect(record.reasoningEffort).toBe("medium");
    // 批量翻译：读到的上游 JSON 文本字节数（不是翻译后的 OpenAI JSON）。
    expect(record.responseBytes).toBe(Buffer.byteLength(upstreamBody, "utf8"));
    expect(record.upstreamAttempts).toBe(1);
  });

  it("accumulates responseBytes on a translated stream (the SSE the client receives)", async () => {
    const requests = new RequestStore();
    const resp = await proxyRequest(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", stream: true, reasoning_effort: "low", messages: [{ role: "user", content: "hi" }] }),
      }),
      "openai",
      { config: TEST_CONFIG, broker: brokerForAccounts(), requests, fetchImpl: mockFetch(async () => sseResponse(anthropicSse())), ...PLAIN },
    );
    expect(resp.status).toBe(200);
    const wire = await resp.text();
    const record = recordOf(requests);
    await waitFor(() => record.stages.some((stage) => stage.stage === "stream-end"));
    expect(record.responseBytes).toBe(Buffer.byteLength(wire, "utf8"));
    expect(record.reasoningEffort).toBe("low");
  });
});

describe("request fields — upstreamAttempts counting", () => {
  it("counts a connect retry as a second upstream attempt", async () => {
    const requests = new RequestStore();
    let calls = 0;
    const resp = await proxyRequest(
      messagesReq({}),
      "anthropic",
      {
        config: TEST_CONFIG,
        broker: brokerForAccounts(),
        requests,
        ...PLAIN,
        fetchImpl: mockFetch(async () => {
          calls += 1;
          // 第一次是连接级失败（fetch 拒绝），第二次成功：日志里是一次请求，记录上
          // 是两次上游出线。
          if (calls === 1) throw new Error("ECONNRESET");
          return batchResponse(anthropicBatch());
        }),
      },
    );
    expect(resp.status).toBe(200);
    await resp.text();
    const record = recordOf(requests);
    expect(calls).toBe(2);
    expect(record.upstreamAttempts).toBe(2);
    // 换号次数不动：账号没换，只是重连。
    expect(record.retries).toBe(0);
  });

  it("counts an auth-failed account rotation as a second attempt and one retry", async () => {
    const requests = new RequestStore();
    let calls = 0;
    const resp = await proxyRequest(
      messagesReq({}),
      "anthropic",
      {
        config: TEST_CONFIG,
        broker: brokerForAccounts(["a", "b"]),
        requests,
        ...PLAIN,
        fetchImpl: mockFetch(async () => {
          calls += 1;
          if (calls === 1) {
            return new Response(JSON.stringify({ error: { type: "authentication_error" } }), { status: 401, headers: { "content-type": "application/json" } });
          }
          return batchResponse(anthropicBatch());
        }),
      },
    );
    expect(resp.status).toBe(200);
    await resp.text();
    const record = recordOf(requests);
    expect(record.upstreamAttempts).toBe(2);
    expect(record.retries).toBe(1);
    expect(record.stages.filter((stage) => stage.stage === "retry")).toHaveLength(1);
  });
});

describe("request fields — clientAborted", () => {
  it("marks the record when the client aborts before the upstream answers", async () => {
    const requests = new RequestStore();
    const controller = new AbortController();
    const resp = await proxyRequest(
      messagesReq({}, { signal: controller.signal }),
      "anthropic",
      {
        config: TEST_CONFIG,
        broker: brokerForAccounts(),
        requests,
        ...PLAIN,
        fetchImpl: mockFetch(async () => {
          controller.abort();
          throw new Error("client aborted during upstream fetch");
        }),
      },
    );
    // 客户端断开时上游 fetch 也失败，这条路径仍然要有个明确的状态码。
    expect(resp.status).toBe(502);
    await resp.text();
    const record = recordOf(requests);
    expect(record.clientAborted).toBe(true);
    // 归属是客户端，但失败阶段照样记（结果确实不成功）——两个事实不互斥。
    expect(record.failedStage).toBe("upstream-req");
    expect(record.upstreamAttempts).toBe(1);
  });
});

describe("request fields — /v1/responses", () => {
  it("records reasoning.effort and the response size for a batch request", async () => {
    const requests = new RequestStore();
    const resp = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", input: "hi", reasoning: { effort: "high" } }),
      }),
      { config: TEST_CONFIG, broker: brokerForAccounts(), requests, fetchImpl: mockFetch(async () => batchResponse(anthropicBatch())), ...PLAIN },
    );
    expect(resp.status).toBe(200);
    await resp.text();
    const record = recordOf(requests);
    expect(record.reasoningEffort).toBe("high");
    expect(record.upstreamAttempts).toBe(1);
    expect(record.responseBytes).toBeGreaterThan(0);
    expect(record.stages.find((stage) => stage.stage === "intake")?.fields.reasoningEffort).toBe("high");
  });

  it("accumulates responseBytes on the streaming path", async () => {
    const requests = new RequestStore();
    const resp = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", input: "hi", stream: true, reasoning: { effort: "minimal" } }),
      }),
      { config: TEST_CONFIG, broker: brokerForAccounts(), requests, fetchImpl: mockFetch(async () => sseResponse(anthropicSse())), ...PLAIN },
    );
    expect(resp.status).toBe(200);
    await resp.text();
    const record = recordOf(requests);
    await waitFor(() => record.stages.some((stage) => stage.stage === "stream-end"));
    expect(record.responseBytes).toBeGreaterThan(0);
    // minimal → low（四档词汇里没有更细的档）。
    expect(record.reasoningEffort).toBe("low");
  });
});
