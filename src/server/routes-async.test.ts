/**
 * Integration tests for `/async/*` routes — models the REAL off-peak protocol.
 *
 * The mock ticket/LLM server returns the canonical `{code:0, data:{...}}` envelope
 * on control-plane responses, returns batch JSON (not SSE) when the LLM request
 * has `stream:false`, and can simulate mid-stream ticket-expired inside an HTTP-200
 * SSE stream. This catches bugs that the v1 mocks (always-SSE, no-envelope) hid.
 */
import { describe, it, expect } from "bun:test";
import { createFetchHandler } from "./server.js";
import { handleAsyncMessages } from "../async/handler.js";
import type { ProxyConfig } from "../config/types.js";
import { inMemoryAccounts } from "../accounts/testing.js";
import type { Account } from "../accounts/types.js";

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
    async: {
      enabled: true,
      origin: "https://zcode.z.ai",
      pollIntervalMs: 10,
      keepAliveIntervalMs: 5,
      maxWaitMs: 0,
      maxRetries: 3,
      settleTimeoutMs: 100,
      controlTimeoutMs: 1000,
      defaultModel: "",
    },
    claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, sprintWindowMs: 1800000, sprintPollIntervalMs: 60000 },
    logging: { level: "info" },
    ...overrides,
  };
}

/**
 * 一个账号：默认 JWT + apiKey 对齐全（auth/capabilities.ts 的 async 面）。
 * `jwt: null` 去掉 JWT、`apiKey: ""` 去掉 key，用来测缺半边的闸门。
 */
function asyncAccount(overrides: { jwt?: string | null; apiKey?: string } = {}): Account {
  const jwt = overrides.jwt === undefined ? "the-jwt" : overrides.jwt;
  const apiKey = overrides.apiKey ?? "key-x";
  return {
    id: `async-${jwt ?? "no-jwt"}-${apiKey || "no-key"}`,
    label: "async",
    credential: {
      kind: "zhipu-account",
      provider: "zai",
      apiKey,
      secret: "secret-y",
      ...(jwt ? { jwt } : {}),
      identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
    },
    routes: ["coding-plan"],
    enabled: true,
    policy: { weight: 1, maxConcurrency: 2 },
  };
}

/** 带一个 async 账号的 broker + 账号仓（`startServer` 需要两者）。*/
function asyncServer(overrides: { jwt?: string | null; apiKey?: string } = {}) {
  return inMemoryAccounts([asyncAccount(overrides)]);
}

/** 没有账号的 broker + 账号仓：验证"未登录"与 async 闸门。*/
function emptyServer() {
  return inMemoryAccounts([]);
}

interface MockServerOpts {
  initialTicketState?: "queued" | "ready";
  queueProgression?: ("queued" | "ready" | "expired" | "not_found")[];
  /** Status poll 的 next_poll_after（秒）。默认 0.01；queueMs 的用例放大它来模拟真实排队。*/
  nextPollAfterSeconds?: number;
  /** First LLM call emits a 200 SSE whose FIRST event is `event:error` with the marker.
   *  Bridge detects pre-commit (no client-visible output yet) → transparent retry. */
  midStreamExpiredPreCommit?: boolean;
  /** First LLM call emits `message_start` (commits), THEN `event:error` with marker.
   *  Bridge detects post-commit → terminal error (no retry, no duplicate lifecycle). */
  midStreamExpiredPostCommit?: boolean;
  llmStatusOverride?: number;
  takeCount: { value: number };
  settleCount: { value: number };
}

function envelope(data: unknown, code: number = 0, msg: string = "ok"): unknown {
  return { code, msg, data };
}

function makeMockFetch(opts: MockServerOpts): typeof fetch {
  const state = { ticketCounter: 0, pollCounter: 0, llmCounter: 0 };

  return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    const method = init?.method ?? "GET";

    if (u.endsWith("/api/v1/off-peak/ticket/availability") && method === "GET") {
      return json(envelope({ can_take_number: true }));
    }

    if (u.endsWith("/api/v1/off-peak/ticket") && method === "POST") {
      state.ticketCounter++;
      opts.takeCount.value++;
      return json(envelope({
        ticket_id: `t-${state.ticketCounter}`,
        state: opts.initialTicketState ?? "ready",
        ...(opts.initialTicketState === "queued" ? { position: 1, next_poll_after: 0.01 } : {}),
      }));
    }

    if (u.endsWith("/api/v1/off-peak/ticket/status") && method === "POST") {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const tid = body.ticket_ids?.[0] ?? "t-1";
      const stateStr = opts.queueProgression?.[state.pollCounter] ?? "ready";
      state.pollCounter++;
      return json(envelope({
        next_poll_after: opts.nextPollAfterSeconds ?? 0.01,
        tickets: [{ ticket_id: tid, state: stateStr }],
      }));
    }

    if (u.includes("/api/v1/off-peak/ticket/") && u.endsWith("/settle") && method === "POST") {
      opts.settleCount.value++;
      return new Response(null, { status: 200 });
    }

    if (u.endsWith("/api/v1/off-peak/anthropic/v1/messages") && method === "POST") {
      state.llmCounter++;
      const reqBody = JSON.parse((init?.body as string) ?? "{}");

      if (opts.llmStatusOverride && opts.llmStatusOverride !== 200) {
        return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "forced upstream error" } }), {
          status: opts.llmStatusOverride,
          headers: { "content-type": "application/json" },
        });
      }

      if (opts.midStreamExpiredPreCommit && state.llmCounter === 1) {
        // FIRST event is the error (no message_start emitted to client).
        // Bridge scans the pre-commit buffer, sees the marker before any boundary
        // is committed → transparent retry.
        const chunks = [
          `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"off-peak-ticket-expired: deadline reached"}}\n\n`,
        ];
        return sseResponse(chunks);
      }

      if (opts.midStreamExpiredPostCommit && state.llmCounter === 1) {
        // First chunk: normal message_start (commits to client).
        // Second chunk: error containing the marker → post-commit, must NOT retry.
        const chunks = [
          `event: message_start\ndata: {"type":"message_start","message":{"id":"msg-x"}}\n\n`,
          `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"off-peak-ticket-expired: deadline reached"}}\n\n`,
        ];
        return sseResponse(chunks);
      }

      if (reqBody.stream === false || reqBody.stream === undefined) {
        throw new Error(`UNEXPECTED stream:false upstream request — handler must force stream:true internally. body.stream=${reqBody.stream}`);
      }

      const chunks = [
        // mock 带缓存桶：message_start 的 cache_* 由 StreamMetrics 读（两条
        // 旁路的统计旁路都吃原始 Anthropic SSE，主链路流式同理）。
        `event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1","role":"assistant","model":"glm-4.6","usage":{"input_tokens":5,"output_tokens":0,"cache_read_input_tokens":1216,"cache_creation_input_tokens":4}}}\n\n`,
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from off-peak"}}\n\n`,
        `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
        `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n`,
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
      ];
      return sseResponse(chunks);
    }

    return new Response("not mocked: " + u, { status: 599 });
  }) as typeof fetch;
}

function json(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function drain(resp: Response, maxMs: number = 2000): Promise<string> {
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const readP = reader.read();
    const timeoutP = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 500));
    const r = await Promise.race([readP, timeoutP]);
    if (r === "timeout") {
      if (chunks.length > 0) break;
      continue;
    }
    if (r.done) break;
    chunks.push(r.value);
  }
  reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks));
}

describe("/async/* routing", () => {
  it("returns 404 when async.enabled=false", async () => {
    const config = makeConfig({ async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 10, keepAliveIntervalMs: 5, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 100, controlTimeoutMs: 1000, defaultModel: "" } });
    const { broker, manager } = asyncServer();
    const handler = createFetchHandler({ config, broker, accounts: manager, fetchImpl: makeMockFetch({ takeCount: { value: 0 }, settleCount: { value: 0 } }) });
    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100 }),
    }));
    expect(resp.status).toBe(404);
  });

  it("returns 400 async_plan_unsupported when no account can run async", async () => {
    // 闸门判的是"有没有账号同时持有 plan JWT 与 coding-plan API key"，不是全局
    // plan。空账号仓 = 没有账号能跑，明确 400。
    const config = makeConfig();
    const { broker, manager } = emptyServer();
    const handler = createFetchHandler({ config, broker, accounts: manager, fetchImpl: makeMockFetch({ takeCount: { value: 0 }, settleCount: { value: 0 } }) });
    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100 }),
    }));
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("async_plan_unsupported");
    expect(body.error.message).toContain("plan JWT");
  });

  // 直接打 handler：`createFetchHandler` 前面的账号能力闸门会先把"没有
  // 账号能跑 async"挡成 async_plan_unsupported，这条用例要测的是 handler 自己的
  // 凭据闸门（账号存在但缺一半凭据）。
  it("returns 400 async_credentials_unavailable when credential lacks a JWT", async () => {
    const config = makeConfig();
    const { broker } = asyncServer({ jwt: null });
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const resp = await handleAsyncMessages(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100 }),
    }), { config, broker, fetchImpl: makeMockFetch(counters) });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("async_credentials_unavailable");
    expect(counters.takeCount.value).toBe(0);
  });

  it("returns 400 async_credentials_unavailable when the credential has a JWT but no API key", async () => {
    const config = makeConfig();
    // JWT only: the async surface needs both halves.
    const { broker } = asyncServer({ jwt: "jwt-only", apiKey: "" });
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const resp = await handleAsyncMessages(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100 }),
    }), { config, broker, fetchImpl: makeMockFetch(counters) });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("async_credentials_unavailable");
    expect(body.error.message).toContain("coding-plan API key");
    expect(counters.takeCount.value).toBe(0);
  });

  it("B1: malformed JSON returns 400 WITHOUT taking a ticket", async () => {
    const config = makeConfig();
    const { broker, manager } = asyncServer();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const handler = createFetchHandler({ config, broker, accounts: manager, fetchImpl: makeMockFetch(counters) });
    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ malformed json",
    }));
    expect(resp.status).toBe(400);
    expect(counters.takeCount.value).toBe(0);
    expect(counters.settleCount.value).toBe(0);
  });

  it("B1: missing messages field returns 400 WITHOUT taking a ticket", async () => {
    const config = makeConfig();
    const { broker, manager } = asyncServer();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const handler = createFetchHandler({ config, broker, accounts: manager, fetchImpl: makeMockFetch(counters) });
    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6" }),
    }));
    expect(resp.status).toBe(400);
    expect(counters.takeCount.value).toBe(0);
  });
});

describe("/async/v1/messages (Anthropic)", () => {
  it("happy path streaming: 200 + text/event-stream with Anthropic bytes", async () => {
    const config = makeConfig();
    const { broker, manager } = asyncServer();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const handler = createFetchHandler({ config, broker, accounts: manager, fetchImpl: makeMockFetch(counters) });

    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true }),
    }));

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type") ?? "").toContain("text/event-stream");
    const text = await drain(resp);
    expect(text).toContain("message_start");
    expect(text).toContain("Hello from off-peak");
    expect(text).toContain("message_stop");
    expect(counters.takeCount.value).toBe(1);
    expect(counters.settleCount.value).toBe(1);
  });

  it("B3 pre-commit: marker arrives BEFORE first boundary → transparent retry, no leaked marker", async () => {
    const config = makeConfig();
    const { broker, manager } = asyncServer();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const fetchImpl = makeMockFetch({ ...counters, midStreamExpiredPreCommit: true });
    const handler = createFetchHandler({ config, broker, accounts: manager, fetchImpl });

    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true }),
    }));

    const text = await drain(resp);
    expect(text).toContain("Hello from off-peak");
    expect(text).not.toContain("off-peak-ticket-expired");
    expect(counters.takeCount.value).toBe(2);
    expect(counters.settleCount.value).toBe(2);
  });

  it("B3 post-commit: marker arrives AFTER first chunk committed → terminal error, NO retry, NO duplicate message_start", async () => {
    const config = makeConfig();
    const { broker, manager } = asyncServer();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const fetchImpl = makeMockFetch({ ...counters, midStreamExpiredPostCommit: true });
    const handler = createFetchHandler({ config, broker, accounts: manager, fetchImpl });

    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true }),
    }));

    const text = await drain(resp);
    // Pre-commit succeeded → first message_start reached client.
    // Post-commit error → terminal error event emitted, no retry.
    expect(text).toContain("message_start");
    expect(text).toContain("event: error");
    expect(text).toContain("expired mid-stream after output started");
    expect(text).not.toContain("off-peak-ticket-expired");
    // NO retry happened — only the initial ticket was taken
    expect(counters.takeCount.value).toBe(1);
    expect(counters.settleCount.value).toBe(1);
  });

  it("B9: non-expired upstream 500 → standard Anthropic event:error (no raw body leak)", async () => {
    const config = makeConfig();
    const { broker, manager } = asyncServer();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const fetchImpl = makeMockFetch({ ...counters, llmStatusOverride: 500 });
    const handler = createFetchHandler({ config, broker, accounts: manager, fetchImpl });

    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true }),
    }));

    const text = await drain(resp);
    expect(text).toContain("event: error");
    expect(text).toContain('"type":"error"');
    expect(text).toContain("HTTP 500");
    expect(counters.settleCount.value).toBe(1);
  });

  it("non-stream: returns aggregated Anthropic JSON", async () => {
    const config = makeConfig();
    const { broker, manager } = asyncServer();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const handler = createFetchHandler({ config, broker, accounts: manager, fetchImpl: makeMockFetch(counters) });

    const resp = await handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: false }),
    }));

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type") ?? "").toContain("application/json");
    const body = await resp.json();
    expect(body.role).toBe("assistant");
    expect(Array.isArray(body.content)).toBe(true);
    expect(body.content[0].text).toBe("Hello from off-peak");
    expect(body.stop_reason).toBe("end_turn");
    expect(counters.settleCount.value).toBe(1);
  });
});

describe("/async/v1/chat/completions (OpenAI)", () => {
  it("B4: happy path stream — keepalives preserved + OpenAI chunks emitted", async () => {
    const config = makeConfig({ async: { enabled: true, origin: "https://zcode.z.ai", pollIntervalMs: 30, keepAliveIntervalMs: 5, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 100, controlTimeoutMs: 1000, defaultModel: "" } });
    const { broker, manager } = asyncServer();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    // Two queued polls then ready — gives keepalive time to fire during wait
    const fetchImpl = makeMockFetch({ ...counters, initialTicketState: "queued", queueProgression: ["queued", "queued", "ready"] });
    const handler = createFetchHandler({ config, broker, accounts: manager, fetchImpl });

    const resp = await handler(new Request("http://localhost/async/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], stream: true }),
    }));

    expect(resp.status).toBe(200);
    const text = await drain(resp);
    expect(text).toContain("choices");
    expect(text).toContain("Hello from off-peak");
    expect(text).toContain("[DONE]");
    expect(text).toContain(": keepalive\n\n");
    expect(counters.settleCount.value).toBe(1);
  });

  it("B4: bridge error event translates to OpenAI data:{error}", async () => {
    const config = makeConfig();
    const { broker, manager } = asyncServer();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const fetchImpl = makeMockFetch({ ...counters, llmStatusOverride: 500 });
    const handler = createFetchHandler({ config, broker, accounts: manager, fetchImpl });

    const resp = await handler(new Request("http://localhost/async/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], stream: true }),
    }));

    const text = await drain(resp);
    expect(text).toContain('"error"');
    expect(text).toContain("HTTP 500");
    expect(text).toContain("[DONE]");
  });

  it("non-stream: returns aggregated OpenAI JSON", async () => {
    const config = makeConfig();
    const { broker, manager } = asyncServer();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const handler = createFetchHandler({ config, broker, accounts: manager, fetchImpl: makeMockFetch(counters) });

    const resp = await handler(new Request("http://localhost/async/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }] }),
    }));

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices?.[0]?.message?.content).toBe("Hello from off-peak");
    expect(counters.settleCount.value).toBe(1);
  });
});

describe("/async/v1/health", () => {
  it("returns availability (envelope unwrapped)", async () => {
    const config = makeConfig();
    const { broker, manager } = asyncServer();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const handler = createFetchHandler({ config, broker, accounts: manager, fetchImpl: makeMockFetch(counters) });

    const resp = await handler(new Request("http://localhost/async/v1/health", { method: "GET" }));

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.canTakeNumber).toBe(true);
  });

  it("returns 400 when credential lacks jwt", async () => {
    const config = makeConfig();
    const { broker, manager } = asyncServer({ jwt: null });
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const handler = createFetchHandler({ config, broker, accounts: manager, fetchImpl: makeMockFetch(counters) });

    const resp = await handler(new Request("http://localhost/async/v1/health", { method: "GET" }));
    expect(resp.status).toBe(400);
  });
});

// ── 请求记录 ────────────────────────────────────────────────
// /async/* 与另外两条入站协议一样是一等公民：messages / chat 各留一条
// record（format 各对），票券等待计入 queueMs，health 不产生 record。

import { RequestStore } from "../proxy/request-record.js";

describe("/async/* request records", () => {
  /** 等桥接流的统计旁路收尾（observeStream 在响应返回之后才落全）。*/
  async function waitFor(pred: () => boolean, attempts = 100): Promise<void> {
    for (let i = 0; i < attempts && !pred(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function recordServer(mockOpts: Partial<MockServerOpts> = {}, asyncConfig: Partial<ProxyConfig["async"]> = {}) {
    const store = new RequestStore();
    const config = makeConfig({ async: { ...makeConfig().async, ...asyncConfig } });
    const { broker, manager } = asyncServer();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const handler = createFetchHandler({
      config,
      broker,
      accounts: manager,
      fetchImpl: makeMockFetch({ takeCount: counters.takeCount, settleCount: counters.settleCount, ...mockOpts }),
      requests: store,
    });
    return { store, handler };
  }

  async function postMessages(handler: (req: Request) => Promise<Response>, body: Record<string, unknown>): Promise<Response> {
    return handler(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
  }

  it("leaves a complete record for /async/v1/messages (anthropic format)", async () => {
    const { store, handler } = recordServer();
    const resp = await postMessages(handler, { model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100 });
    expect(resp.status).toBe(200);
    const wire = await drain(resp);
    expect(wire).toContain("Hello from off-peak");

    const [record] = store.recent(1);
    expect(record).toBeDefined();
    expect(record!.format).toBe("anthropic");
    expect(record!.model).toBe("glm-4.6");
    expect(record!.stream).toBe(false);
    expect(record!.requestBytes).toBeGreaterThan(0);
    expect(record!.account).toBe("async");
    // route 填实际 lease 的 route（broker 已经解析），不硬编码。
    expect(record!.route).toBe("coding-plan");
    expect(record!.status).toBe(200);
    expect(record!.queueMs).toBeGreaterThanOrEqual(0);
    expect(record!.upstreamUrl).toContain("/api/v1/off-peak/anthropic/v1/messages");
    expect(record!.signed).toBe(false);
    expect(record!.upstreamFormat).toBe("anthropic");
    await waitFor(() => record!.outputTokens !== undefined);
    // usage 来自桥接流的 Anthropic SSE（message_delta 的 output_tokens=4）。
    expect(record!.outputTokens).toBe(4);
    expect(record!.inputTokens).toBe(5);
    // 缓存桶从同一份 SSE 的 message_start 帧读（旁路与主链路同源）。
    expect(record!.cacheReadTokens).toBe(1216);
    expect(record!.cacheCreationTokens).toBe(4);
    const stages = record!.stages.map((s) => s.stage);
    expect(stages).toContain("intake");
    expect(stages).toContain("dispatch");
    expect(stages).toContain("upstream-req");
    expect(stages.at(-1)).toBe("stream-end");
    // dispatch 阶段带票号：排队排的是哪张票，时间线上可查。
    const dispatchStage = record!.stages.find((s) => s.stage === "dispatch")!;
    expect(dispatchStage.fields.ticketId).toBe("t-1");
  });

  it("leaves a complete record for /async/v1/chat/completions (openai format)", async () => {
    const { store, handler } = recordServer();
    const resp = await handler(new Request("http://localhost/async/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], stream: true }),
    }));
    expect(resp.status).toBe(200);
    const wire = await drain(resp);
    expect(wire).toContain("[DONE]");

    const [record] = store.recent(1);
    expect(record!.format).toBe("openai");
    expect(record!.stream).toBe(true);
    expect(record!.model).toBe("glm-4.6");
    expect(record!.status).toBe(200);
    await waitFor(() => record!.outputTokens !== undefined);
    expect(record!.outputTokens).toBe(4);
    // openai 旁路同样吃原始 Anthropic SSE 的缓存桶（统计旁路在翻译前 tee）。
    expect(record!.cacheReadTokens).toBe(1216);
    expect(record!.cacheCreationTokens).toBe(4);
    expect(record!.stages.map((s) => s.stage)).toContain("stream-end");
  });

  it("counts the ticket queue wait into queueMs", async () => {
    // queued → queued → ready：两拍轮询（next_poll_after=0.05s = 50ms/拍），
    // queueMs 必须把这段时间算进去——闲时排队的大数是真实情况。
    const { store, handler } = recordServer(
      { initialTicketState: "queued", queueProgression: ["queued", "queued", "ready"], nextPollAfterSeconds: 0.05 },
    );
    const resp = await postMessages(handler, { model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100 });
    expect(resp.status).toBe(200);
    await drain(resp);
    const [record] = store.recent(1);
    expect(record!.queueMs).toBeGreaterThanOrEqual(90);
    // dispatch 阶段在票券 ready 时才登记（queueMs = 选号 + takeTicket + 排队）。
    const dispatchStage = record!.stages.find((s) => s.stage === "dispatch");
    expect(dispatchStage).toBeDefined();
    expect(dispatchStage!.fields.queueMs).toBe(record!.queueMs);
  });

  it("does not leave a record for /async/v1/health", async () => {
    const { store, handler } = recordServer();
    expect(store.recent(100)).toHaveLength(0);
    const resp = await handler(new Request("http://localhost/async/v1/health"));
    expect(resp.status).toBe(200);
    expect(store.recent(100)).toHaveLength(0);
  });

  it("records the failure when the credential lacks a JWT (handler level)", async () => {
    // 服务层闸门会把这种账号挡在 handler 之外，那一条路径不产生记录；
    // 这里直接打 handler，验证 handler 自己的凭据闸门会留下可筛的失败记录。
    const store = new RequestStore();
    const config = makeConfig();
    const { broker } = asyncServer({ jwt: null });
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const resp = await handleAsyncMessages(new Request("http://localhost/async/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }] }),
    }), {
      config,
      broker,
      fetchImpl: makeMockFetch({ takeCount: counters.takeCount, settleCount: counters.settleCount }),
      requests: store,
      apiKeyId: "key-7",
    });
    expect(resp.status).toBe(400);
    const [record] = store.recent(1);
    expect(record!.format).toBe("anthropic");
    expect(record!.status).toBe(400);
    expect(record!.failedStage).toBe("route-facts");
    expect(record!.apiKeyId).toBe("key-7");
  });

  it("attributes the record to the API key through the server wiring", async () => {
    const store = new RequestStore();
    const config = makeConfig();
    const { broker, manager } = asyncServer();
    const counters = { takeCount: { value: 0 }, settleCount: { value: 0 } };
    const handler = createFetchHandler({
      config,
      broker,
      accounts: manager,
      fetchImpl: makeMockFetch({ takeCount: counters.takeCount, settleCount: counters.settleCount }),
      requests: store,
    });
    // 这套配置的鉴权关着（requireKey=false、表空）：放行的请求归因为空串，
    // record 仍然要留。带 key 的归因接线在 server.test.ts 的协议级用例里验证。
    const resp = await postMessages(handler, { model: "glm-4.6", messages: [{ role: "user", content: "hi" }] });
    expect(resp.status).toBe(200);
    const [record] = store.recent(1);
    expect(record!.apiKeyId).toBe("");
  });

  // ── 请求记录的新字段（async 旁路不能漏）──
  it("records reasoningEffort, upstreamAttempts and responseBytes (anthropic body)", async () => {
    const { store, handler } = recordServer();
    const resp = await postMessages(handler, {
      model: "glm-4.6",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      thinking: { type: "enabled", budget_tokens: 8_000 },
    });
    expect(resp.status).toBe(200);
    const wire = await drain(resp);
    expect(wire).toContain("Hello from off-peak");

    const [record] = store.recent(1);
    // 8000 token 思考 → low 档（`reasoning-effort.ts` 的三档阈）。
    expect(record!.reasoningEffort).toBe("low");
    expect(record!.stages.find((s) => s.stage === "intake")!.fields.reasoningEffort).toBe("low");
    // 票券第一次就 ready：一次上游出线（桥接的 attempt 从 0 起）。
    expect(record!.upstreamAttempts).toBe(1);
    await waitFor(() => record!.responseBytes !== undefined);
    // 旁路读的就是桥接 SSE 的字节（客户端那一份同源）。
    expect(record!.responseBytes).toBeGreaterThan(0);
    expect(record!.clientAborted).toBeUndefined();
  });

  it("records reasoning_effort on the async OpenAI path too", async () => {
    const { store, handler } = recordServer();
    const resp = await handler(new Request("http://localhost/async/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }], stream: true, reasoning_effort: "high" }),
    }));
    expect(resp.status).toBe(200);
    await drain(resp);

    const [record] = store.recent(1);
    expect(record!.format).toBe("openai");
    expect(record!.reasoningEffort).toBe("high");
    expect(record!.upstreamAttempts).toBe(1);
  });

  it("counts a ticket-expired re-take as a second upstream attempt", async () => {
    // 票券过期 → 重取一次 → 第二次出线。`upstreamAttempts` 数的是“上游被打了几次”，
    // 不是“换了几次号”（`retries`），与票券重取的阶段事件分开算。
    const { store, handler } = recordServer({ initialTicketState: "queued", queueProgression: ["expired", "ready"], nextPollAfterSeconds: 0.01 });
    const resp = await postMessages(handler, { model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 100 });
    expect(resp.status).toBe(200);
    await drain(resp);

    const [record] = store.recent(1);
    await waitFor(() => record!.upstreamAttempts !== undefined);
    expect(record!.upstreamAttempts).toBe(2);
    // 换号次数不动：同一账号同一路由，只是重取了票。
    expect(record!.retries).toBe(0);
    expect(record!.stages.filter((s) => s.stage === "retry").length).toBeGreaterThan(0);
  });
});
