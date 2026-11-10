/**
 * Responses 续轮钉号的用例。
 *
 * `previous_response_id` 是**状态化**的：上游那段对话只存在于产出它的
 * `(account, route)` 上。所以续轮必须回到那个账号，而且必须**绕过调度器**——
 * 让它再走一次候选集/粘性/策略，就可能被换到另一个账号上，上游看到的是"另一段
 * 对话"，状态与缓存全部作废。
 *
 * 三条断言：
 *
 * 1. 续轮落回原账号（用 `round-robin` 制造"如果走调度器就会换号"的反证）；
 * 2. 钉住的账号已被删除 → 明确报错，**不静默改道**；
 * 3. 流式响应同样把 `(account, route)` 存进去（流式路径的 origin 也接了）。
 *
 * @see 粘性（Responses 特例）· 选号顺序
 */
import { describe, expect, it } from "bun:test";
import { handleResponses } from "./responses-handler.js";
import { ResponseStore } from "../responses/store.js";
import { accountFor, inMemoryAccounts, zhipuCredential } from "../accounts/testing.js";
import { defaultPolicy } from "../accounts/types.js";
import type { Account, Credential, RouteKind } from "../accounts/types.js";
import type { ProxyConfig } from "../config/types.js";

const CONFIG: ProxyConfig = {
  server: { port: 0, host: "127.0.0.1" },
  auth: { requireKey: false },
  providers: {
    zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
    bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
  },
  defaultModel: "glm-5.2",
  models: ["glm-5.2"],
  identity: { appVersion: "test-1.0.0", appVersionSource: "default", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai", betaPolicy: "drop", betaAllowlist: [] },
  clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
  responses: { storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false },
  highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
  mcp: { enabled: true, gateway: { enabled: true, upstreamOrigin: "https://zcode.z.ai" } },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, sprintWindowMs: 1800000, sprintPollIntervalMs: 60000 },
  logging: { level: "info" },
};

function credential(tag: string): Credential {
  return zhipuCredential({ apiKey: `key-${tag}`, secret: `secret-${tag}`, jwt: `jwt-${tag}` });
}

function account(label: string, routes: RouteKind[] = ["coding-plan"]): Account {
  return accountFor(credential(label), {
    label,
    routes,
    policy: defaultPolicy({ maxConcurrency: 4 }),
  });
}

function anthropicMsg(text: string): string {
  return JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "glm-5.2",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 },
  });
}

function anthropicSse(text: string): string {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_s", type: "message", role: "assistant", model: "glm-5.2", content: [], usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
}

function makeReq(body: unknown): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 记录每次出线用的是哪份凭据（apiKey 不同 = 账号不同）。 */
function recordingFetch(sink: string[], body: string): typeof fetch {
  return (async (req: Request): Promise<Response> => {
    sink.push(req.headers.get("x-api-key") ?? "unknown");
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("续轮钉号：回到产出它的 (account, route)", () => {
  it("续轮绕过调度器，落回原账号（即使 round-robin 下一个是别人）", async () => {
    const a = account("a");
    const b = account("b");
    const c = account("c");
    const { broker } = inMemoryAccounts([a, b, c], {
      routing: { order: ["coding-plan"], strategy: "round-robin" },
    });
    const store = new ResponseStore({ maxEntries: 10, ttlMs: 60_000 });

    const keys: string[] = [];
    const fetchImpl = recordingFetch(keys, anthropicMsg("answer"));
    const opts = { config: CONFIG, broker, responseStore: store, fetchImpl, endpointRouting: null, clientSigning: null, highspeed: null };

    // 第一轮：round-robin 位置 0 → a。
    const first = await handleResponses(makeReq({ model: "glm-5.2", input: "turn one" }), opts);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { id: string };

    // 第二轮（无关请求）：位置 1 → b。
    const second = await handleResponses(makeReq({ model: "glm-5.2", input: "unrelated" }), opts);
    expect(second.status).toBe(200);

    // 续轮：如果走调度器，round-robin 位置 2 会选 c；钉号必须让它回到 a。
    const continuation = await handleResponses(
      makeReq({ model: "glm-5.2", input: "turn two", previous_response_id: firstBody.id }),
      opts,
    );
    expect(continuation.status).toBe(200);

    expect(keys.length).toBe(3);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe(keys[0]);
  });

  it("钉住的账号已被删除 → 503 明确报错，不静默改道", async () => {
    const a = account("a");
    const b = account("b");
    const { broker, manager } = inMemoryAccounts([a, b], {
      routing: { order: ["coding-plan"], strategy: "round-robin" },
    });
    const store = new ResponseStore({ maxEntries: 10, ttlMs: 60_000 });

    const keys: string[] = [];
    const fetchImpl = recordingFetch(keys, anthropicMsg("answer"));
    const opts = { config: CONFIG, broker, responseStore: store, fetchImpl, endpointRouting: null, clientSigning: null, highspeed: null };

    const first = await handleResponses(makeReq({ model: "glm-5.2", input: "turn one" }), opts);
    const firstBody = (await first.json()) as { id: string };
    const produced = store.get(firstBody.id);
    expect(produced).toBeDefined();

    // 删掉产出这条响应的账号。
    expect(await manager.remove(produced!.accountId)).toBe(true);

    const continuation = await handleResponses(
      makeReq({ model: "glm-5.2", input: "turn two", previous_response_id: firstBody.id }),
      opts,
    );

    // 明确报错：不能悄悄换到 b 上继续（上游那段对话只存在于被删账号上）。
    expect(continuation.status).toBe(503);
    const error = (await continuation.json()) as { error: { type: string; message: string } };
    expect(error.error.type).toBe("credential_unavailable");
    expect(error.error.message).toContain("does not exist");
    // 只有第一轮真的出过线。
    expect(keys.length).toBe(1);
  });

  it("存储记录里带着 accountId 与 routeKind（续轮钉号的输入）", async () => {
    const a = account("a");
    const { broker } = inMemoryAccounts([a], { routing: { order: ["coding-plan"] } });
    const store = new ResponseStore({ maxEntries: 10, ttlMs: 60_000 });

    const opts = {
      config: CONFIG,
      broker,
      responseStore: store,
      fetchImpl: recordingFetch([], anthropicMsg("answer")),
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    };

    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hello" }), opts);
    const body = (await response.json()) as { id: string };

    const stored = store.get(body.id);
    expect(stored?.accountId).toBe(a.id);
    expect(stored?.routeKind).toBe("coding-plan");
  });

  it("流式响应同样记下 (account, route)：流式续轮也钉得住", async () => {
    const a = account("a");
    const b = account("b");
    const c = account("c");
    const { broker } = inMemoryAccounts([a, b, c], {
      routing: { order: ["coding-plan"], strategy: "round-robin" },
    });
    const store = new ResponseStore({ maxEntries: 10, ttlMs: 60_000 });

    const keys: string[] = [];
    // 流式第一轮：SSE 上游；后续轮用普通 JSON。
    let sse = true;
    const fetchImpl = (async (req: Request): Promise<Response> => {
      keys.push(req.headers.get("x-api-key") ?? "unknown");
      if (sse) {
        sse = false;
        return new Response(anthropicSse("streamed"), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(anthropicMsg("answer"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const opts = { config: CONFIG, broker, responseStore: store, fetchImpl, endpointRouting: null, clientSigning: null, highspeed: null };

    const streamed = await handleResponses(makeReq({ model: "glm-5.2", input: "turn one", stream: true }), opts);
    expect(streamed.status).toBe(200);
    // 必须把流读完才会写入存储（流式在 `response.completed` 时入库）。
    const wire = await streamed.text();
    const completed = wire
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; response?: { id: string } })
      .find((event) => event.type === "response.completed");
    expect(completed?.response?.id).toBeDefined();

    const responseId = completed!.response!.id;
    const stored = store.get(responseId);
    expect(stored?.accountId).toBeDefined();
    expect(stored?.routeKind).toBe("coding-plan");

    // 无关请求把 round-robin 位置推走（位置 1 → b）。
    const unrelated = await handleResponses(makeReq({ model: "glm-5.2", input: "unrelated" }), opts);
    expect(unrelated.status).toBe(200);

    // 续轮钉回流式第一轮的那个账号。
    const continuation = await handleResponses(
      makeReq({ model: "glm-5.2", input: "turn two", previous_response_id: responseId }),
      opts,
    );
    expect(continuation.status).toBe(200);
    expect(keys[2]).toBe(keys[0]);
  });
});
