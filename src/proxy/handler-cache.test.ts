/**
 * 缓存字段抓取 + 客户端归类的链路级测试。
 *
 * 覆盖三条主协议（mock 上游恒为 Anthropic 形状）：
 * - `/v1/chat/completions` 批量：缓存桶从上游 Anthropic usage 直读（reportEnd 追加参数）；
 * - `/v1/chat/completions` 流式：cache_read 从翻译流的 prompt_tokens_details
 *   （StreamMetrics），cache_creation 从翻译器的 onUsage 钩子（OpenAI usage 装不下它）；
 * - `/v1/messages` 流式（直传）：message_start 帧的 cache_* 由 StreamMetrics 读。
 * - clientKind：intake 阶段写入 + 阶段字段。
 */
import { describe, expect, it } from "bun:test";
import { proxyRequest } from "./handler.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { brokerFor } from "../accounts/testing.js";
import { RequestStore } from "./request-record.js";

function oauthBroker(key = "testkey.testsecret") {
  const [apiKey, secret] = key.split(".");
  return brokerFor({
    kind: "zhipu-account",
    provider: "zai",
    apiKey,
    ...(secret ? { secret } : {}),
    identity: { targetType: "PERSONAL", deviceMid: "test-device-mid" },
  }).broker;
}

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

function mockFetch(impl: (req: Request) => Promise<Response>): typeof fetch {
  return Object.assign(impl, { preconnect: () => {} }) as typeof fetch;
}

async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 上游 Anthropic 批量响应：带缓存桶（在场即有效：报了 0 也是样本）。 */
function anthropicBatchJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "glm-4.6",
    content: [{ type: "text", text: "hey" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1216, cache_creation_input_tokens: 4 },
    ...overrides,
  });
}

/** 上游 Anthropic SSE：message_start 带缓存桶（直传流式与翻译流的共同上游形状）。 */
function anthropicSse(): string {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_s", type: "message", role: "assistant", model: "glm-4.6", content: [], usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 1216, cache_creation_input_tokens: 4 } } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
}

function sseResponse(sse: string): Response {
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function store(): RequestStore {
  return new RequestStore();
}

describe("cache capture — /v1/chat/completions (translate path)", () => {
  it("batch: cache buckets flow from the upstream Anthropic usage into the record", async () => {
    const requests = store();
    const resp = await proxyRequest(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "claude-cli/2.1.87" },
        body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }] }),
      }),
      "openai",
      { config: TEST_CONFIG, broker: oauthBroker(), fetchImpl: mockFetch(() => Promise.resolve(new Response(anthropicBatchJson(), { status: 200, headers: { "content-type": "application/json" } }))), requests, endpointRouting: null, clientSigning: null, highspeed: null },
    );
    expect(resp.status).toBe(200);
    await resp.text();

    const [record] = requests.recent(1);
    expect(record!.status).toBe(200);
    // token 语义不变：prompt_tokens = input + cache_read + cache_creation（含缓存）。
    expect(record!.inputTokens).toBe(1230);
    expect(record!.outputTokens).toBe(5);
    // 缓存桶在场即有效（0 也是样本）；两桶都从上游 Anthropic usage 直读。
    expect(record!.cacheReadTokens).toBe(1216);
    expect(record!.cacheCreationTokens).toBe(4);
    // intake 阶段写入 clientKind（CC 的 UA）。
    expect(record!.clientKind).toBe("claude-code");
    expect(record!.stages[0].fields.clientKind).toBe("claude-code");
  });

  it("batch: an upstream that omits the cache buckets leaves the record fields absent", async () => {
    const requests = store();
    const body = JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "glm-4.6",
      content: [{ type: "text", text: "hey" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const resp = await proxyRequest(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }] }),
      }),
      "openai",
      { config: TEST_CONFIG, broker: oauthBroker(), fetchImpl: mockFetch(() => Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }))), requests, endpointRouting: null, clientSigning: null, highspeed: null },
    );
    expect(resp.status).toBe(200);
    await resp.text();
    const [record] = requests.recent(1);
    expect(record!.cacheReadTokens).toBeUndefined();
    expect(record!.cacheCreationTokens).toBeUndefined();
  });

  it("stream: cache_read from prompt_tokens_details, cache_creation from the translator's usage hook", async () => {
    const requests = store();
    const resp = await proxyRequest(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "ZCode/3.17.1" },
        body: JSON.stringify({ model: "glm-4.6", stream: true, messages: [{ role: "user", content: "hi" }] }),
      }),
      "openai",
      { config: TEST_CONFIG, broker: oauthBroker(), fetchImpl: mockFetch(() => Promise.resolve(sseResponse(anthropicSse()))), requests, endpointRouting: null, clientSigning: null, highspeed: null },
    );
    expect(resp.status).toBe(200);
    const wire = await resp.text();
    expect(wire).toContain("[DONE]");
    const [record] = requests.recent(1);
    await waitFor(() => record!.stages.some((s) => s.stage === "stream-end"));
    // 翻译流的最终 usage 帧：prompt_tokens=1230（含缓存）、cached_tokens=1216。
    expect(record!.inputTokens).toBe(1230);
    expect(record!.cacheReadTokens).toBe(1216);
    // OpenAI usage 没有这个桶——只能来自 onUsage 钩子的 Anthropic 快照。
    expect(record!.cacheCreationTokens).toBe(4);
    expect(record!.clientKind).toBe("zcode");
  });
});

describe("cache capture — /v1/messages streaming (direct passthrough)", () => {
  it("reads cache buckets from message_start via StreamMetrics", async () => {
    const requests = store();
    const resp = await proxyRequest(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "curl/8.4.0" },
        body: JSON.stringify({ model: "glm-4.6", stream: true, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      }),
      "anthropic",
      { config: TEST_CONFIG, broker: oauthBroker(), fetchImpl: mockFetch(() => Promise.resolve(sseResponse(anthropicSse()))), requests, endpointRouting: null, clientSigning: null, highspeed: null },
    );
    expect(resp.status).toBe(200);
    await resp.text();
    const [record] = requests.recent(1);
    await waitFor(() => record!.stages.some((s) => s.stage === "stream-end"));
    // 直传流：input_tokens 是排缓存后的裸输入（既有语义，不变）。
    expect(record!.inputTokens).toBe(10);
    expect(record!.outputTokens).toBe(5);
    expect(record!.cacheReadTokens).toBe(1216);
    expect(record!.cacheCreationTokens).toBe(4);
    // 无特殊头的请求归类 other。
    expect(record!.clientKind).toBe("other");
  });
});
