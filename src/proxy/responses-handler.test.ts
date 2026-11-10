import { describe, it, expect, afterEach } from "bun:test";
import { handleResponses, type ResponsesHandlerOptions } from "./responses-handler.js";
import { ResponseStore } from "../responses/store.js";
import type { ProxyConfig } from "../config/types.js";
import { accountFor, brokerFor, inMemoryAccounts } from "../accounts/testing.js";
import { highspeedAuthFrom, type HighspeedManager } from "../highspeed/manager.js";
import { HighspeedSlots } from "../highspeed/slots.js";
import { ClientSigningManager } from "./client-signing.js";
import type * as CaptchaExports from "../captcha/captcha.js";

type CaptchaModule = typeof CaptchaExports;
const liveSlots: HighspeedSlots[] = [];
afterEach(() => {
  for (const slots of liveSlots.splice(0)) slots.stopAll();
});

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
  clientSigning: { enabled: false }, highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
  mcp: { enabled: true, gateway: { enabled: true, upstreamOrigin: "https://zcode.chatglm.site" } },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, sprintWindowMs: 1800000, sprintPollIntervalMs: 60000 },
  logging: { level: "info" },
};

// Both halves: the coding-plan tests exercise the apiKey pair, and the
// start-plan cases below pin an account whose whitelist is start-plan so the
// route (not a global plan) selects the JWT branch (auth/capabilities.ts).
const broker = brokerFor({
  kind: "zhipu-account",
  provider: "zai",
  apiKey: "testkey",
  secret: "testsecret",
  jwt: "test-zcode-jwt",
  identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
}).broker;

/** start-plan account: JWT present, whitelist pinned to the start-plan route. */
const startPlanBroker = brokerFor({
  kind: "zhipu-account",
  provider: "zai",
  apiKey: "testkey",
  secret: "testsecret",
  jwt: "test-zcode-jwt",
  identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
}, ["start-plan"]).broker;

function chatUpstream(body: string, status = 200): typeof fetch {
  return (async (): Promise<Response> => new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

function anthropicMsg(text: string, id = "msg_1"): string {
  return JSON.stringify({
    id,
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

describe("handleResponses credential gate", () => {
  it("refuses start-plan traffic when the credential has no plan JWT", async () => {
    // No JWT: the start-plan surface must refuse it locally.
    const keyOnlyBroker = brokerFor({
      kind: "zhipu-account",
      provider: "zai",
      apiKey: "keyid",
      secret: "secret",
      identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
    }, ["start-plan"]).broker;
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
      config: CONFIG,
      broker: keyOnlyBroker,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
      fetchImpl: (async () => {
        throw new Error("upstream must not be reached");
      }) as unknown as typeof fetch,
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("credential_unavailable");
    expect(body.error.message).toContain("needs the plan JWT");
  });
});

describe("handleResponses", () => {
  it.each([null, [], 1, true])("rejects non-object JSON bodies: %j", async (body) => {
    const response = await handleResponses(makeReq(body), { config: CONFIG, broker });
    expect(response.status).toBe(400);
    expect((await response.json()).error.type).toBe("invalid_request");
  });
  it("sends easy input messages to the Anthropic upstream", async () => {
    let sent = "";
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: [{ role: "user", content: "easy question" }] }), {
      config: CONFIG, broker, endpointRouting: null, clientSigning: null,
      fetchImpl: (async (request: Request) => {
        sent = await request.text();
        return new Response(anthropicMsg("answer"));
      }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(sent).messages[0].content).toContainEqual(expect.objectContaining({ type: "text", text: "easy question" }));
  });

  it.each([false, true])("surfaces Anthropic errors without completing or storing the response (partial=%s)", async (partial) => {
    const store = new ResponseStore({ maxEntries: 10, ttlMs: 60000 });
    const prefix = partial ? anthropicSse("partial").split("event: message_delta")[0] : "";
    const upstream = prefix + 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"upstream overloaded"}}\n\n';
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hello", stream: true }), {
      config: CONFIG, broker, responseStore: store, endpointRouting: null, clientSigning: null,
      fetchImpl: chatUpstream(upstream),
    });
    const wire = await response.text();
    const events = wire.split("\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)));
    const failed = events.find(e => e.type === "response.failed");
    expect(failed?.response.status).toBe("failed");
    expect(failed?.response.error).toEqual({ code: "overloaded_error", message: "upstream overloaded" });
    expect(events.some(e => e.type === "response.completed" || e.type === "response.output_item.done")).toBe(false);
    expect(store.get(failed.response.id)).toBeUndefined();
  });

  it.each([false, true])("replays namespaced tool calls with matching Anthropic tool definitions (stream=%s)", async (stream) => {
    const store = new ResponseStore({ maxEntries: 10, ttlMs: 60000 });
    const tools = [{ type: "namespace", name: "fs", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] }];
    const toolEvents = [
      { type: "message_start", message: { id: "m1", model: "glm-5.2", usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_ns", name: "fs__read", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const batch = { ...JSON.parse(anthropicMsg("")), content: [{ type: "tool_use", id: "call_ns", name: "fs__read", input: {} }], stop_reason: "tool_use" };
    const first = await handleResponses(makeReq({ model: "glm-5.2", input: "read file", tools, stream }), {
      config: CONFIG, broker, responseStore: store, endpointRouting: null, clientSigning: null,
      fetchImpl: chatUpstream(stream ? toolEvents.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("") : JSON.stringify(batch)),
    });
    const wire = await first.text();
    const result = stream ? wire.split("\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6))).find(e => e.type === "response.completed").response : JSON.parse(wire);
    expect(result.output[0]).toMatchObject({ name: "read", namespace: "fs" });
    for (const useStore of [false, true]) {
      let sent = "";
      const reply = { type: "function_call_output", call_id: "call_ns", output: "file content" };
      const next = await handleResponses(makeReq({ model: "glm-5.2", tools,
        ...(useStore ? { previous_response_id: result.id, input: [reply] } : { input: [...result.output, reply] }),
      }), { config: CONFIG, broker, responseStore: store, endpointRouting: null, clientSigning: null,
        fetchImpl: (async (request: Request) => { sent = await request.text(); return new Response(anthropicMsg("done")); }) as typeof fetch,
      });
      expect(next.status).toBe(200);
      const body = JSON.parse(sent);
      expect(body.tools[0].name).toBe("fs__read");
      const assistant = body.messages.find((m: { role: string }) => m.role === "assistant");
      expect(assistant.content[0]).toMatchObject({ type: "tool_use", id: "call_ns", name: "fs__read" });
    }
  });

  it("returns a ResponsesResponse with message output for a basic text request", async () => {
    const fetchImpl = chatUpstream(anthropicMsg("hi back"));
    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hello" }), { config: CONFIG, broker, fetchImpl });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.object).toBe("response");
    expect(body.output[0].type).toBe("message");
    expect(body.output[0].content[0].text).toBe("hi back");
  });

  it("stores the response and resolves previous_response_id from the store", async () => {
    const store = new ResponseStore();
    const fetchImpl = chatUpstream(anthropicMsg("turn1"));
    const r1 = await handleResponses(makeReq({ model: "glm-5.2", input: "first turn" }), { config: CONFIG, broker, fetchImpl, responseStore: store });
    const body1 = await r1.json();
    expect(store.size()).toBe(1);

    // Second request references the first response's id.
    let secondUpstreamBody = "";
    const fetchImpl2 = (async (request: Request): Promise<Response> => {
      secondUpstreamBody = await request.text();
      return new Response(anthropicMsg("turn2", "msg_2"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r2 = await handleResponses(makeReq({ model: "glm-5.2", input: "second turn", previous_response_id: body1.id }), { config: CONFIG, broker, fetchImpl: fetchImpl2, responseStore: store });
    expect(r2.status).toBe(200);
    expect(secondUpstreamBody).toContain("first turn");
    expect(secondUpstreamBody).toContain("turn1");
    expect(secondUpstreamBody).toContain("second turn");
  });

  it("returns 404 when previous_response_id is not in the store", async () => {
    const store = new ResponseStore();
    const fetchImpl = chatUpstream(anthropicMsg("x"));
    const r = await handleResponses(makeReq({ model: "glm-5.2", input: "x", previous_response_id: "resp_missing" }), { config: CONFIG, broker, fetchImpl, responseStore: store });
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.error.type).toBe("response_not_found");
  });

  it("does not store the response when store:false", async () => {
    const store = new ResponseStore();
    const fetchImpl = chatUpstream(anthropicMsg("x"));
    await handleResponses(makeReq({ model: "glm-5.2", input: "x", store: false }), { config: CONFIG, broker, fetchImpl, responseStore: store });
    expect(store.size()).toBe(0);
  });

  it("strips web_search_preview silently (model never sees it)", async () => {
    let upstreamCalls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      upstreamCalls++;
      return new Response(anthropicMsg("no search needed"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r = await handleResponses(makeReq({ model: "glm-5.2", input: "search the web", tools: [{ type: "web_search_preview" }] }), { config: CONFIG, broker, fetchImpl });
    expect(r.status).toBe(200);
    expect(upstreamCalls).toBe(1);
    const body = await r.json();
    expect(body.output[0].type).toBe("message");
    const wsCall = body.output.find((o: { type: string }) => o.type === "web_search_call");
    expect(wsCall).toBeUndefined();
  });

  it("returns a text/event-stream response for stream:true", async () => {
    const fetchImpl = (async (): Promise<Response> => new Response(anthropicSse("hi"), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const r = await handleResponses(makeReq({ model: "glm-5.2", input: "hi", stream: true }), { config: CONFIG, broker, fetchImpl });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const text = await r.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.completed");
    expect(text).toContain("response.output_text.delta");
  });

  it("stores a completed stream for previous_response_id continuation", async () => {
    const store = new ResponseStore();
    const streamFetch = (async (): Promise<Response> => new Response(anthropicSse("turn1"), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const streamed = await handleResponses(makeReq({ model: "glm-5.2", input: "first turn", stream: true }), { config: CONFIG, broker, fetchImpl: streamFetch, responseStore: store });
    const streamText = await streamed.text();
    const responseId = streamText.match(/event: response\.completed\ndata: .*?"id":"([^"]+)"/)?.[1];
    expect(responseId).toBeDefined();

    let continuationUpstreamBody = "";
    const continuationFetch = (async (request: Request): Promise<Response> => {
      continuationUpstreamBody = await request.text();
      return new Response(anthropicMsg("turn2", "msg_c2"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const continuation = await handleResponses(makeReq({ model: "glm-5.2", input: "second turn", previous_response_id: responseId }), { config: CONFIG, broker, fetchImpl: continuationFetch, responseStore: store });
    expect(continuation.status).toBe(200);
    expect(continuationUpstreamBody).toContain("first turn");
    expect(continuationUpstreamBody).toContain("turn1");
    expect(continuationUpstreamBody).toContain("second turn");
  });
});

// /v1/responses used to skip captcha entirely (it passed `undefined` where
// handler.ts passes captcha headers), so every start-plan request came back as
// HTTP 400 {"code":3007,"msg":"captcha verify failed"} while the OpenAI and
// Anthropic routes worked.
describe("handleResponses captcha (start-plan)", () => {
  const START_PLAN: ProxyConfig = CONFIG;
  // provider 现在是凭据属性：这组用例原本用 bigmodel 起 start-plan，改成
  // bigmodel 的 start-plan 账号即可保持同等语义。
  const startPlanBrokerForBigmodel = brokerFor({
    kind: "zhipu-account",
    provider: "bigmodel",
    apiKey: "bmkey",
    jwt: "test-zcode-jwt",
    identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
  }, ["start-plan"]).broker;
  const PARAM_HEADER = "x-aliyun-captcha-verify-param";
  const REGION_HEADER = "x-aliyun-captcha-verify-region";

  /** Fake captcha module: mints sequential tokens, records how many were asked for. */
  function fakeCaptcha(): { module: CaptchaModule; minted: () => number } {
    let n = 0;
    const module = {
      RETRY_HEADERS: { PARAM: PARAM_HEADER, REGION: REGION_HEADER },
      getCaptchaToken: async () => {
        n += 1;
        return { verifyParam: `token-${n}`, region: "cn" };
      },
      detectCaptchaChallenge: (resp: Response) => resp.headers.get(PARAM_HEADER),
    } as unknown as CaptchaModule;
    return { module, minted: () => n };
  }

  it("sends a captcha token upstream on start-plan", async () => {
    const seen: (string | null)[] = [];
    const fetchImpl = (async (request: Request): Promise<Response> => {
      seen.push(request.headers.get(PARAM_HEADER));
      return new Response(anthropicMsg("ok"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const captcha = fakeCaptcha();
    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
      config: START_PLAN, broker: startPlanBrokerForBigmodel, fetchImpl, captcha: captcha.module,
    });
    expect(resp.status).toBe(200);
    expect(seen).toEqual(["token-1"]);
    expect(captcha.minted()).toBe(1);
  });

  it("retries once with a fresh token when upstream answers in-body 3007", async () => {
    const seen: (string | null)[] = [];
    const fetchImpl = (async (request: Request): Promise<Response> => {
      seen.push(request.headers.get(PARAM_HEADER));
      if (seen.length === 1) {
        return new Response(JSON.stringify({ code: 3007, msg: "captcha verify failed" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      return new Response(anthropicMsg("recovered"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const captcha = fakeCaptcha();
    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
      config: START_PLAN, broker: startPlanBrokerForBigmodel, fetchImpl, captcha: captcha.module,
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.output[0].content[0].text).toBe("recovered");
    // The challenged token is already spent, so the retry must carry a NEW one.
    expect(seen).toEqual(["token-1", "token-2"]);
  });

  it("retries when the challenge arrives as a response header", async () => {
    const seen: (string | null)[] = [];
    const fetchImpl = (async (request: Request): Promise<Response> => {
      seen.push(request.headers.get(PARAM_HEADER));
      if (seen.length === 1) {
        return new Response("denied", { status: 403, headers: { [PARAM_HEADER]: "challenge-abc" } });
      }
      return new Response(anthropicMsg("ok"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const captcha = fakeCaptcha();
    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
      config: START_PLAN, broker: startPlanBrokerForBigmodel, fetchImpl, captcha: captcha.module,
    });
    expect(resp.status).toBe(200);
    expect(seen).toEqual(["token-1", "token-2"]);
  });

  it("gives up after one retry instead of looping", async () => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      return new Response(JSON.stringify({ code: 3007, msg: "captcha verify failed" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const captcha = fakeCaptcha();
    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
      config: START_PLAN, broker: startPlanBrokerForBigmodel, fetchImpl, captcha: captcha.module,
    });
    expect(calls).toBe(2);
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("upstream_error");
    expect(body.error.message).toContain("3007");
  });

  it("does not touch captcha on coding-plan", async () => {
    const seen: (string | null)[] = [];
    const fetchImpl = (async (request: Request): Promise<Response> => {
      seen.push(request.headers.get(PARAM_HEADER));
      return new Response(anthropicMsg("ok"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const captcha = fakeCaptcha();
    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
      config: CONFIG, broker, fetchImpl, captcha: captcha.module,
    });
    expect(resp.status).toBe(200);
    expect(seen).toEqual([null]);
    expect(captcha.minted()).toBe(0);
  });

  it("injects the device/session metadata.user_id blob on BOTH plans (bundle E2e is plan-agnostic)", async () => {
    const START_PLAN: ProxyConfig = CONFIG;
  // provider 现在是凭据属性：这组用例原本用 bigmodel 起 start-plan，改成
  // bigmodel 的 start-plan 账号即可保持同等语义。
  const startPlanBrokerForBigmodel = brokerFor({
    kind: "zhipu-account",
    provider: "bigmodel",
    apiKey: "bmkey",
    jwt: "test-zcode-jwt",
    identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
  }, ["start-plan"]).broker;
    let codingBody = "";
    let startBody = "";
    const codingFetch = (async (request: Request): Promise<Response> => {
      codingBody = await request.text();
      return new Response(anthropicMsg("ok"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const startFetch = (async (request: Request): Promise<Response> => {
      startBody = await request.text();
      return new Response(anthropicMsg("ok"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    // Inject a fake captcha module — without it the start-plan pre-mint path
    // lazy-imports the REAL solver and fires a network solve, timing out
    // single-file runs and leaking solver state into later tests.
    const startPlanCaptcha = fakeCaptcha();
    await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), { config: CONFIG, broker, fetchImpl: codingFetch });
    await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), { config: START_PLAN, broker: startPlanBrokerForBigmodel, fetchImpl: startFetch, captcha: startPlanCaptcha.module });

    // The account uuid ("u1") is never transmitted: account_uuid is hardcoded
    // empty in the bundle (UIo), and no session resolution happens on this path.
    // `device_id` is the leased account's own fingerprint.
    expect(JSON.parse(JSON.parse(codingBody).metadata?.user_id)).toEqual({
      device_id: "test-device-mid",
      account_uuid: "",
      session_id: "",
    });
    expect(JSON.parse(JSON.parse(startBody).metadata?.user_id)).toEqual({
      device_id: "test-device-mid",
      account_uuid: "",
      session_id: "",
    });
  });
});

// CL-08: /v1/responses used to give up on the FIRST connect-level failure and
// mislabel captcha-retry dispatch failures as captcha_solver_failed.
describe("handleResponses resilience (CL-08)", () => {
  it("retries transient connect failures (3 attempts, fresh dispatch each)", async () => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      if (calls < 3) throw new Error("Unable to connect");
      return new Response(anthropicMsg("after retry"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), { config: CONFIG, broker, fetchImpl });
    expect(resp.status).toBe(200);
    expect(calls).toBe(3);
    const body = await resp.json();
    expect(body.output[0].content[0].text).toBe("after retry");
  });

  it("surfaces 502 upstream_unreachable after exhausting connect attempts", async () => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      throw new Error("Unable to connect");
    }) as unknown as typeof fetch;

    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), { config: CONFIG, broker, fetchImpl });
    expect(resp.status).toBe(502);
    expect(calls).toBe(3);
    const body = await resp.json();
    expect(body.error.type).toBe("upstream_unreachable");
  });

  it("does not retry once the client aborted", async () => {
    const controller = new AbortController();
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.2", input: "hi" }),
      signal: controller.signal,
    });
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      controller.abort(); // abort while the first attempt is "in flight"
      throw new Error("Unable to connect");
    }) as unknown as typeof fetch;

    const resp = await handleResponses(req, { config: CONFIG, broker, fetchImpl });
    expect(resp.status).toBe(502);
    expect(calls).toBe(1);
  });

  it("captcha retry dispatch failure → 502 upstream_unreachable (not mislabeled 503)", async () => {
    const START_PLAN: ProxyConfig = CONFIG;
  // provider 现在是凭据属性：这组用例原本用 bigmodel 起 start-plan，改成
  // bigmodel 的 start-plan 账号即可保持同等语义。
  const startPlanBrokerForBigmodel = brokerFor({
    kind: "zhipu-account",
    provider: "bigmodel",
    apiKey: "bmkey",
    jwt: "test-zcode-jwt",
    identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
  }, ["start-plan"]).broker;
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ code: 3007, msg: "captcha verify failed" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      throw new Error("connection reset during retry");
    }) as unknown as typeof fetch;

    let n = 0;
    const captcha = {
      RETRY_HEADERS: { PARAM: "x-aliyun-captcha-verify-param", REGION: "x-aliyun-captcha-verify-region" },
      getCaptchaToken: async () => {
        n += 1;
        return { verifyParam: `token-${n}`, region: "cn" };
      },
      detectCaptchaChallenge: (resp: Response) => resp.headers.get("x-aliyun-captcha-verify-param"),
    } as unknown as CaptchaModule;

    const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
      config: START_PLAN, broker: startPlanBrokerForBigmodel, fetchImpl, captcha,
    });
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error.type).toBe("upstream_unreachable");
  });

  it("captcha solver failure → 503 captcha_solver_failed (after bounded acquire retries)", async () => {
    const START_PLAN: ProxyConfig = CONFIG;
  // provider 现在是凭据属性：这组用例原本用 bigmodel 起 start-plan，改成
  // bigmodel 的 start-plan 账号即可保持同等语义。
  const startPlanBrokerForBigmodel = brokerFor({
    kind: "zhipu-account",
    provider: "bigmodel",
    apiKey: "bmkey",
    jwt: "test-zcode-jwt",
    identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
  }, ["start-plan"]).broker;
    const fetchImpl = (async (): Promise<Response> =>
      new Response(JSON.stringify({ code: 3007, msg: "captcha verify failed" }), {
        status: 400, headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    // Strict acquisition retries within CAPTCHA_ACQUIRE_BUDGET_MS before
    // giving up — shrink the budget for the test.
    const savedBudget = process.env.CAPTCHA_ACQUIRE_BUDGET_MS;
    process.env.CAPTCHA_ACQUIRE_BUDGET_MS = "10";
    let upstreamCalled = 0;
    const countingFetch = (async (req: Request): Promise<Response> => {
      upstreamCalled += 1;
      return fetchImpl(req);
    }) as unknown as typeof fetch;
    try {
      const captcha = {
        RETRY_HEADERS: { PARAM: "x-aliyun-captcha-verify-param", REGION: "x-aliyun-captcha-verify-region" },
        getCaptchaToken: async () => {
          throw new Error("solver exploded");
        },
        detectCaptchaChallenge: (resp: Response) => resp.headers.get("x-aliyun-captcha-verify-param"),
      } as unknown as CaptchaModule;

      const resp = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
        config: START_PLAN, broker: startPlanBrokerForBigmodel, fetchImpl: countingFetch, captcha,
      });
      expect(resp.status).toBe(503);
      const body = await resp.json();
      expect(body.error.type).toBe("captcha_solver_failed");
      // Strict mode: a captcha-less request is NEVER dispatched upstream.
      expect(upstreamCalled).toBe(0);
    } finally {
      if (savedBudget === undefined) delete process.env.CAPTCHA_ACQUIRE_BUDGET_MS;
      else process.env.CAPTCHA_ACQUIRE_BUDGET_MS = savedBudget;
    }
  });

  it("times out a stalled captcha acquisition and never dispatches a late token", async () => {
    const savedBudget = process.env.CAPTCHA_ACQUIRE_BUDGET_MS;
    process.env.CAPTCHA_ACQUIRE_BUDGET_MS = "25";
    const lateToken = { verifyParam: "late-token", region: "cn" };
    let finishAcquire!: (token: typeof lateToken) => void;
    const acquisition = new Promise<typeof lateToken>((resolve) => { finishAcquire = resolve; });
    let acquires = 0;
    let upstreamCalls = 0;
    let pendingResponse: Promise<Response> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const captcha = {
        RETRY_HEADERS: { PARAM: "x-aliyun-captcha-verify-param", REGION: "x-aliyun-captcha-verify-region" },
        getCaptchaToken: () => {
          acquires++;
          return acquisition;
        },
        detectCaptchaChallenge: () => null,
      } as unknown as CaptchaModule;
      pendingResponse = handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
        config: CONFIG, broker: startPlanBroker, captcha,
        endpointRouting: null, clientSigning: null, highspeed: null,
        fetchImpl: (async () => {
          upstreamCalls++;
          return new Response(anthropicMsg("should not dispatch"));
        }) as unknown as typeof fetch,
      });
      const response = await Promise.race([
        pendingResponse,
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(() => reject(new Error("captcha acquisition exceeded its budget")), 1_000);
        }),
      ]);
      expect(response.status).toBe(503);
      expect((await response.json()).error.type).toBe("captcha_solver_failed");
      expect(acquires).toBe(1);
      expect(upstreamCalls).toBe(0);

      finishAcquire(lateToken);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(acquires).toBe(1);
      expect(upstreamCalls).toBe(0);
    } finally {
      finishAcquire(lateToken);
      await pendingResponse?.catch(() => {});
      if (watchdog !== undefined) clearTimeout(watchdog);
      if (savedBudget === undefined) delete process.env.CAPTCHA_ACQUIRE_BUDGET_MS;
      else process.env.CAPTCHA_ACQUIRE_BUDGET_MS = savedBudget;
    }
  });
});

// ── HighSpeed 加速卡接线（2026-10-14）+ session affinity 收口 ──

const ENFORCE_CONFIG: ProxyConfig = {
  ...CONFIG,
  clientIdentity: { mode: "enforce", ttlSeconds: 900, maxSessions: 1024 },
};

/** coding-plan 账号的凭据（apiKey 对 + JWT）：highspeed 接线用例的前提。*/
const HS_CREDENTIAL = {
  kind: "zhipu-account",
  provider: "zai",
  apiKey: "testkey",
  secret: "testsecret",
  jwt: "test-zcode-jwt",
  identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
} as const;

/** 官方 highspeed 网关地址（`accounts/routes.ts` 的 baseUrl + `/v1/messages`）。*/
const HIGHSPEED_URL = "https://zcode.z.ai/api/v1/highspeed/anthropic/v1/messages";
const CODING_PLAN_URL = "https://api.z.ai/api/anthropic/v1/messages";

/** 同一个 coding-plan 账号的 broker（凭据指纹不变 → 卡槽键不变）。*/
function oauthJwtBroker() {
  return brokerFor({ ...HS_CREDENTIAL }).broker;
}

async function until(cond: () => boolean): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return cond();
}

/** 抽卡 mock：卡绑定**请求的模型**（model 必须与卡一致）。*/
function drawFetch(draws: string[] = []): typeof fetch {
  const now = Date.now();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith("/api/v1/highspeed/draw")) {
      return new Response(JSON.stringify({
        code: 0, msg: "success",
        data: { card_id: "hsc_resp_1", prompt_tokens: 1, completion_tokens: 2, duration_seconds: 1 },
      }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { task_id: string; model: string };
    draws.push(body.model);
    return new Response(JSON.stringify({
      code: 0,
      msg: "success",
      data: {
        card: {
          card_id: "hsc_resp_1",
          task_id: body.task_id,
          provider: "builtin:zai-coding-plan",
          model: body.model,
          issued_at: now,
          expires_at: now + 300_000,
        },
        next_draw_at: now + 120_000,
      },
    }), { status: 200 });
  }) as unknown as typeof fetch;
}

/** 卡槽表（该账号已持卡）。 */
async function cardHoldingSlots(draws: string[] = []): Promise<{ slots: HighspeedSlots; highspeed: HighspeedManager }> {
  const slots = new HighspeedSlots({
    origin: "https://zcode.z.ai",
    models: ["glm-5.3", "glm-5.2", "glm-5.1"],
    jitterHeartbeat: false,
    retryMs: 2,
    fetchImpl: drawFetch(draws),
  });
  liveSlots.push(slots);
  const account = accountFor({ ...HS_CREDENTIAL });
  const highspeed = slots.forAccount(account);
  highspeed.onRequest("glm-5.2", "t-1", highspeedAuthFrom(account)!);
  expect(await until(() => highspeed.activeCard() !== null)).toBeTrue();
  return { slots, highspeed };
}

describe("handleResponses highspeed wiring", () => {
  it("没有 JWT 的账号既不抽卡也不给别人的循环续命（每账号卡槽隔离）", async () => {
    const clock = { now: 1_000_000 };
    let draws = 0;
    let finishIdleCheck!: (stopped: boolean) => void;
    const idleStopped = new Promise<boolean>((resolve) => { finishIdleCheck = resolve; });
    const slots = new HighspeedSlots({
      origin: "https://zcode.z.ai",
      models: ["glm-5.2"],
      jitterHeartbeat: false,
      now: () => clock.now,
      retryMs: 2,
      onEvent: (message) => {
        if (message.includes("idle-stopped")) finishIdleCheck(true);
      },
      fetchImpl: (async (input: RequestInfo | URL) => {
        if (!String(input).endsWith("/api/v1/highspeed/draw")) {
          return new Response(JSON.stringify({ code: 0, data: { card_id: "hsc_a", prompt_tokens: 1, completion_tokens: 1, duration_seconds: 1 } }));
        }
        draws++;
        return new Response(JSON.stringify({ code: 0, data: { card: null } }));
      }) as unknown as typeof fetch,
    });
    liveSlots.push(slots);
    // 账号 A：有 JWT → 点燃自己的抽卡循环
    const accountA = accountFor({
      kind: "zhipu-account",
      provider: "zai",
      apiKey: "old-key",
      secret: "old-secret",
      jwt: "old-jwt",
      identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
    });
    slots.forAccount(accountA).onRequest("glm-5.2", "old-task", highspeedAuthFrom(accountA)!);
    expect(draws).toBe(1);

    // 账号 B：只有 apiKey（重新导入后没有 plan JWT）→ 不抽卡、也不给 A 的循环续命
    const switchedBroker = brokerFor({
      kind: "zhipu-account",
      provider: "zai",
      apiKey: "imported-key",
      identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
    }).broker;
    clock.now += 4 * 60_000;
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
      config: CONFIG, broker: switchedBroker, highspeed: slots,
      endpointRouting: null, clientSigning: null,
      fetchImpl: chatUpstream(anthropicMsg("answer")),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(draws).toBe(1); // B 没有抽卡

    const drawsBeforeIdle = draws;
    clock.now += 2 * 60_000; // 距离 A 最后一次请求已 6 分钟
    const timeout = setTimeout(() => finishIdleCheck(false), 1_000);
    try {
      expect(await idleStopped).toBeTrue();
      expect(draws).toBe(drawsBeforeIdle);
    } finally {
      clearTimeout(timeout);
    }
  });

  it("restores the signing manager after a rejected unsigned card request", async () => {
    const { slots, highspeed } = await cardHoldingSlots();
    let signingCalls = 0;
    let requests = 0;
    const signer = new ClientSigningManager({ fetchImpl: (async () => {
      signingCalls++;
      return new Response("unavailable", { status: 503 });
    }) as unknown as typeof fetch });
    try {
      const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), {
        config: CONFIG, broker: oauthJwtBroker(), endpointRouting: null, clientSigning: signer, highspeed: slots,
        fetchImpl: (async () => {
          requests++;
          if (requests === 1) {
            expect(signingCalls).toBe(0);
            return new Response("expired", { status: 401 });
          }
          expect(signingCalls).toBeGreaterThan(0);
          return new Response(anthropicMsg("recovered"));
        }) as unknown as typeof fetch,
      });
      expect(response.status).toBe(200);
      expect(requests).toBe(2);
    } finally { highspeed.stop(); }
  });

  it("挂卡：路由切到 highspeed、model 不改写、JWT 鉴权套装 + 卡头、永不签名", async () => {
    const { slots } = await cardHoldingSlots();
    const signingFetches: string[] = [];
    const calls: { url: string; headers: Headers; body: string }[] = [];
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hello" }), {
      config: CONFIG, broker: oauthJwtBroker(), endpointRouting: null,
      clientSigning: new ClientSigningManager({
        fetchImpl: (async (input: RequestInfo | URL) => {
          signingFetches.push(String(input instanceof Request ? input.url : input));
          throw new Error(`unexpected signing fetch: ${String(input)}`);
        }) as unknown as typeof fetch,
      }),
      highspeed: slots,
      fetchImpl: (async (request: Request) => {
        calls.push({ url: request.url, headers: request.headers, body: await request.clone().text() });
        return new Response(anthropicMsg("answer"));
      }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(calls.length).toBe(1);
    // 出线端点换成 highspeed 路由
    expect(calls[0]!.url).toBe(HIGHSPEED_URL);
    // model 保持客户端请求值
    expect(JSON.parse(calls[0]!.body).model).toBe("glm-5.2");
    expect(calls[0]!.headers.get("x-api-key")).toBe("test-zcode-jwt");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer test-zcode-jwt");
    expect(calls[0]!.headers.get("x-bigmodel-authorization")).toBe("Bearer testkey.testsecret");
    expect(calls[0]!.headers.get("bigmodel-target-type")).toBe("PERSONAL");
    expect(calls[0]!.headers.get("x-highspeed-card-id")).toBe("hsc_resp_1");
    // official static rule: highspeed-mode requests are never signed
    expect(signingFetches.length).toBe(0);
    expect(calls[0]!.headers.get("x-client-sig")).toBeNull();
  });

  it("卡被拒（401）→ 退回 coding-plan 路由 + 原模型 + 常规鉴权", async () => {
    const draws: string[] = [];
    const { slots, highspeed } = await cardHoldingSlots(draws);
    const calls: { url: string; headers: Headers; body: string }[] = [];
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hello" }), {
      config: CONFIG, broker: oauthJwtBroker(), endpointRouting: null, clientSigning: null, highspeed: slots,
      fetchImpl: (async (request: Request) => {
        calls.push({ url: request.url, headers: request.headers, body: await request.clone().text() });
        return calls.length === 1
          ? new Response(JSON.stringify({ msg: "VERIFY_SIGNATURE_INVALID" }), { status: 401 })
          : new Response(anthropicMsg("answer"));
      }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(calls.length).toBe(2);
    // first: carded, on the highspeed endpoint
    expect(calls[0]!.url).toBe(HIGHSPEED_URL);
    expect(calls[0]!.headers.get("x-highspeed-card-id")).toBe("hsc_resp_1");
    expect(JSON.parse(calls[0]!.body).model).toBe("glm-5.2");
    // fallback: coding-plan endpoint, original model, normal dual auth, no card header
    expect(calls[1]!.url).toBe(CODING_PLAN_URL);
    expect(calls[1]!.headers.get("x-highspeed-card-id")).toBeNull();
    expect(calls[1]!.headers.get("x-api-key")).toBe("testkey.testsecret");
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer testkey.testsecret");
    expect(JSON.parse(calls[1]!.body).model).toBe("glm-5.2");
    // 卡被丢弃：丢弃后循环在空闲窗口内立即按请求模型重抽（保留的“后台最大速率抽卡”
    // 偏差），所以断言看的是“旧卡已作废、重新抽了一次”。
    expect(draws.length).toBeGreaterThan(1);
    expect(highspeed.activeCard()?.cardId).toBe("hsc_resp_1");
  });

  it("leaves requests untouched when the model is not eligible", async () => {
    const { slots } = await cardHoldingSlots();
    const calls: { url: string; headers: Headers; body: string }[] = [];
    const response = await handleResponses(makeReq({ model: "glm-4.6", input: "hello" }), {
      config: CONFIG, broker: oauthJwtBroker(), endpointRouting: null, clientSigning: null, highspeed: slots,
      fetchImpl: (async (request: Request) => {
        calls.push({ url: request.url, headers: request.headers, body: await request.clone().text() });
        return new Response(anthropicMsg("answer"));
      }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(CODING_PLAN_URL);
    expect(calls[0]!.headers.get("x-highspeed-card-id")).toBeNull();
    expect(calls[0]!.headers.get("x-api-key")).toBe("testkey.testsecret");
    expect(JSON.parse(calls[0]!.body).model).toBe("glm-4.6");
  });
});

describe("handleResponses session affinity (2026-10-14 收口)", () => {
  it("preserves explicit trace context through captcha retry", async () => {
    const seen: Headers[] = [];
    const request = makeReq({ model: "glm-5.2", input: "hi" });
    request.headers.set("x-request-id", "request-retry");
    request.headers.set("x-zcode-trace-id", "trace-retry");
    const response = await handleResponses(request, {
      config: ENFORCE_CONFIG, broker: startPlanBroker,
      endpointRouting: null, clientSigning: null, highspeed: null,
      captcha: {
        RETRY_HEADERS: { PARAM: "x-aliyun-captcha-verify-param", REGION: "x-aliyun-captcha-verify-region" },
        getCaptchaToken: async () => ({ verifyParam: "test-token", region: "cn" }),
        detectCaptchaChallenge: () => null,
      } as unknown as CaptchaModule,
      fetchImpl: (async (req: Request) => {
        seen.push(req.headers);
        return seen.length === 1
          ? new Response(JSON.stringify({ code: 3007 }), { status: 400 })
          : new Response(anthropicMsg("recovered"));
      }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    for (const headers of seen) {
      expect(headers.get("x-request-id")).toBe("request-retry");
      expect(headers.get("x-zcode-trace-id")).toBe("trace-retry");
    }
  });
  it("explicit x-session-id reaches trace headers and metadata.user_id (mirrors /v1/messages)", async () => {
    let sent: Request | undefined;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "sess_test123" },
      body: JSON.stringify({ model: "glm-5.2", input: "hello" }),
    }), {
      config: ENFORCE_CONFIG, broker, endpointRouting: null, clientSigning: null,
      fetchImpl: (async (request: Request) => {
        sent = request;
        return new Response(anthropicMsg("answer"));
      }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(sent).toBeDefined();
    expect(sent!.headers.get("x-session-id")).toBe("test123");
    const body = JSON.parse(await sent!.clone().text()) as { metadata?: { user_id?: string } };
    const userId = JSON.parse(body.metadata!.user_id!) as { device_id?: string; account_uuid: string; session_id: string };
    expect(userId.session_id).toBe("test123");
    expect(userId.account_uuid).toBe("");
  });
});

// ── 请求记录 ──────────────────────────────────────────────
// Responses 与 /v1/messages、/v1/chat/completions 一样是一等公民，面板的
// 请求事件 tab 必须能看到它：一次请求后 `RequestStore.recent(1)` 要有完整 record，
// 阶段词表与 handler.ts 一致，流式收尾走 `observeStream`。

import { RequestStore } from "./request-record.js";

describe("handleResponses request record", () => {
  function recordOpts(store: RequestStore, extra: Partial<ResponsesHandlerOptions> = {}): ResponsesHandlerOptions {
    return {
      config: CONFIG,
      broker,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
      requests: store,
      ...extra,
    };
  }

  /** 等 observeStream 的收尾（流式统计在响应返回之后才落全）：轮询直到谓词满足。*/
  async function waitFor(pred: () => boolean, attempts = 100): Promise<void> {
    for (let i = 0; i < attempts && !pred(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("leaves a complete record after a batch request", async () => {
    const store = new RequestStore();
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), recordOpts(store, { fetchImpl: chatUpstream(anthropicMsg("hey")) }));
    expect(response.status).toBe(200);
    await response.text();

    const [record] = store.recent(1);
    expect(record).toBeDefined();
    expect(record!.format).toBe("openai");
    expect(record!.model).toBe("glm-5.2");
    expect(record!.stream).toBe(false);
    expect(record!.requestBytes).toBeGreaterThan(0);
    expect(record!.status).toBe(200);
    expect(record!.apiKeyId).toBe("");
    expect(record!.account).toBe("test");
    expect(record!.route).toBe("coding-plan");
    expect(record!.queueMs).toBeGreaterThanOrEqual(0);
    expect(record!.upstreamFormat).toBe("anthropic");
    expect(record!.upstreamUrl).toContain("/api/anthropic");
    expect(record!.signed).toBe(false);
    expect(record!.headerCount).toBeGreaterThan(0);
    expect(record!.contentEncoding).toBe("identity");
    // usage 从翻译后的 OpenAI 形状读：anthropicMsg 报 3 in / 2 out。
    expect(record!.outputTokens).toBe(2);
    expect(record!.inputTokens).toBe(3);
    expect(record!.failedStage).toBeUndefined();
    expect(record!.endedAt).toBeDefined();
    // 全程亚毫秒时 Date.now() 的分辨率会给 0：非负且已定义就是收尾发生过的凭证。
    expect(record!.totalMs).toBeGreaterThanOrEqual(0);
    // 阶段词表与 handler.ts 一致：同一条时间线在两种协议上长得一样。
    expect(record!.stages.map((s) => s.stage)).toEqual([
      "intake", "dispatch", "session", "route-facts", "body", "highspeed", "upstream-req", "upstream-resp",
    ]);
  });

  it("fills token counts and tps from the stream via observeStream", async () => {
    const store = new RequestStore();
    const sseFetch: typeof fetch = (async () =>
      new Response(anthropicSse("hello"), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hi", stream: true }), recordOpts(store, { fetchImpl: sseFetch }));
    expect(response.status).toBe(200);
    const wire = await response.text();
    expect(wire).toContain("response.completed");

    const [record] = store.recent(1);
    expect(record!.stream).toBe(true);
    await waitFor(() => record!.outputTokens !== undefined && record!.stages.some((s) => s.stage === "stream-end"));
    // usage 走 observeStream 的 StreamMetrics：anthropicSse 报 3 in / 2 out。
    expect(record!.outputTokens).toBe(2);
    expect(record!.inputTokens).toBe(3);
    // 整条 SSE 在一个 chunk 里到达时生成窗口为 0，tps 按定义回 0（StreamMetrics）；
    // 有值时必须是正数。
    expect(record!.tps).toBeGreaterThanOrEqual(0);
    // 本地 mock 的流整条在一个毫秒内到达，ttfbMs 合法地可以为 0（Date.now() 分辨率）。
    expect(record!.ttfbMs).toBeGreaterThanOrEqual(0);
    expect(record!.totalMs).toBeGreaterThanOrEqual(0);
    const last = record!.stages.at(-1)!;
    expect(last.stage).toBe("stream-end");
    expect(last.fields).toMatchObject({ tokens: 2 });
  });

  it("marks failedStage on an upstream error", async () => {
    const store = new RequestStore();
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), recordOpts(store, { fetchImpl: chatUpstream("boom", 500) }));
    expect(response.status).toBe(500);
    const [record] = store.recent(1);
    expect(record!.status).toBe(500);
    expect(record!.failedStage).toBe("upstream-resp");
    expect(record!.error).toContain("upstream returned 500");
  });

  // 缓存桶与 clientKind。批量从上游 Anthropic usage 直读（翻译成
  // Chat/Responses 形状后 creation 桶就没了）；流式从 onUsage 钩子 +
  // StreamMetrics（prompt_tokens_details）。
  it("batch: cache buckets flow from the upstream Anthropic usage into the record", async () => {
    const store = new RequestStore();
    const upstream = JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "glm-5.2",
      content: [{ type: "text", text: "hey" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 1216, cache_creation_input_tokens: 4 },
    });
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), recordOpts(store, { fetchImpl: chatUpstream(upstream) }));
    expect(response.status).toBe(200);
    await response.text();
    const [record] = store.recent(1);
    expect(record!.cacheReadTokens).toBe(1216);
    expect(record!.cacheCreationTokens).toBe(4);
  });

  it("stream: cache buckets via the usage hook + StreamMetrics; clientKind from headers", async () => {
    const store = new RequestStore();
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_s", type: "message", role: "assistant", model: "glm-5.2", content: [], usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 1216, cache_creation_input_tokens: 4 } } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
    const sseFetch: typeof fetch = (async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const request = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "ZCode/3.17.1" },
      body: JSON.stringify({ model: "glm-5.2", input: "hi", stream: true }),
    });
    const response = await handleResponses(request, recordOpts(store, { fetchImpl: sseFetch }));
    expect(response.status).toBe(200);
    await response.text();
    const [record] = store.recent(1);
    await waitFor(() => record!.stages.some((s) => s.stage === "stream-end"));
    expect(record!.cacheReadTokens).toBe(1216);
    expect(record!.cacheCreationTokens).toBe(4);
    expect(record!.clientKind).toBe("zcode");
    expect(record!.stages[0].fields.clientKind).toBe("zcode");
  });

  it("marks failedStage on dispatch failure (no account)", async () => {
    const store = new RequestStore();
    const emptyBroker = inMemoryAccounts([]).broker;
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), recordOpts(store, {
      broker: emptyBroker,
      fetchImpl: (async () => {
        throw new Error("upstream must not be reached");
      }) as unknown as typeof fetch,
    }));
    expect(response.status).toBe(503);
    const [record] = store.recent(1);
    expect(record!.status).toBe(503);
    expect(record!.failedStage).toBe("dispatch");
    expect(record!.account).toBeUndefined();
    // failStage 会登记同名阶段条目（与 handler.ts 同款）：时间线上能看到它停在哪。
    expect(record!.stages.map((s) => s.stage)).toEqual(["intake", "dispatch"]);
  });

  it("attributes the record to the API key", async () => {
    const store = new RequestStore();
    const response = await handleResponses(makeReq({ model: "glm-5.2", input: "hi" }), recordOpts(store, { fetchImpl: chatUpstream(anthropicMsg("hey")), apiKeyId: "key-42" }));
    expect(response.status).toBe(200);
    const [record] = store.recent(1);
    expect(record!.apiKeyId).toBe("key-42");
  });
});
