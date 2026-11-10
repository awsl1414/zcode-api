/**
 * Integration wiring tests: highspeed card application inside `proxyRequest`.
 *
 * 官方形态下要证明的四件事：
 * 1. 挂卡请求打到 **highspeed 路由的 baseUrl**（`/api/v1/highspeed/anthropic`），
 *    不是 coding-plan 的地址；
 * 2. body 的 `model` **未被改写**；
 * 3. 鉴权换成 Coding Plan 双 JWT + 账号身份头 + `X-Highspeed-Card-ID`，且不签名；
 * 4. 任何失败都退回 coding-plan 路由 + 原模型。
 */
import { describe, it, expect, afterEach } from "bun:test";
import { proxyRequest } from "./handler.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { brokerFor } from "../accounts/testing.js";
import { highspeedAuthFrom, type HighspeedManager } from "../highspeed/manager.js";
import { HighspeedSlots } from "../highspeed/slots.js";
import { ClientSigningManager } from "./client-signing.js";
import type { Credential } from "../accounts/types.js";

const IDENTITY: ProxyIdentity = {
  appVersion: "3.15.1",
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
  clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
  responses: { storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false },
  highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
  mcp: { enabled: true, gateway: { enabled: true, upstreamOrigin: "https://zcode.chatglm.site" } },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, sprintWindowMs: 1800000, sprintPollIntervalMs: 60000 },
  logging: { level: "info" },
};

const CRED = "testkey.testsecret";
const JWT = "test-zcode-jwt";
/** 官方 highspeed 网关地址（`accounts/routes.ts` 的 highspeed baseUrl + `/v1/messages`）。*/
const HIGHSPEED_URL = "https://zcode.z.ai/api/v1/highspeed/anthropic/v1/messages";
/** coding-plan 的地址：挂卡时**不该**出现，退回时**必须**出现。*/
const CODING_PLAN_URL = "https://api.z.ai/api/anthropic/v1/messages";

const liveSlots: HighspeedSlots[] = [];
afterEach(() => {
  for (const slots of liveSlots.splice(0)) slots.stopAll();
});

/** coding-plan 账号（apiKey 对 + JWT）：highspeed 接线用例的前提。*/
function highspeedCredential(overrides: Partial<Extract<Credential, { kind: "zhipu-account" }>> = {}): Credential {
  return {
    kind: "zhipu-account",
    provider: "zai",
    apiKey: "testkey",
    secret: "testsecret",
    jwt: JWT,
    identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
    ...overrides,
  };
}

function anthropicClientReq(model = "glm-5.1"): Request {
  return new Request("http://localhost:8080/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: "user", content: "hi" }] }),
  });
}

function anthropicOk(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_wire", type: "message", role: "assistant", model: "glm-5.1",
      content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function until(cond: () => boolean): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return cond();
}

/** 抽卡 mock：卡绑定**请求的模型**（官方语义：model 必须与卡一致）。*/
function drawFetch(draws: string[], now = Date.now()): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith("/api/v1/highspeed/draw")) {
      return new Response(JSON.stringify({
        code: 0, msg: "success",
        data: { card_id: "hsc_wiring_1", prompt_tokens: 1, completion_tokens: 2, duration_seconds: 1 },
      }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { task_id: string; model: string };
    draws.push(body.model);
    return new Response(JSON.stringify({
      code: 0,
      msg: "success",
      data: {
        card: {
          card_id: "hsc_wiring_1",
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

/** 账号 + 卡槽（已持卡）。返回 broker / slots / 该账号的卡槽实例。 */
async function cardHoldingSetup(
  credential: Credential = highspeedCredential(),
  draws: string[] = [],
  events: string[] = [],
) {
  const { broker, manager } = brokerFor(credential);
  const account = (await manager.list())[0]!;
  const slots = new HighspeedSlots({
    origin: "https://zcode.z.ai",
    models: ["glm-5.3", "glm-5.2", "glm-5.1"],
    jitterHeartbeat: false,
    retryMs: 2,
    fetchImpl: drawFetch(draws),
    onEvent: (message) => events.push(message),
  });
  liveSlots.push(slots);
  const highspeed = slots.forAccount(account);
  highspeed.onRequest("glm-5.1", "t-1", highspeedAuthFrom(account)!);
  expect(await until(() => highspeed.activeCard() !== null)).toBeTrue();
  return { broker, slots, highspeed, account };
}

/** Signer whose fetch records every call — proves carded requests never even attempt a handshake. */
function recordingSigner(calls: string[]): ClientSigningManager {
  return new ClientSigningManager({
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      throw new Error(`unexpected signing fetch: ${url}`);
    }) as unknown as typeof fetch,
  });
}

describe("proxyRequest highspeed wiring（官方形态）", () => {
  it("挂卡请求打到 highspeed 路由、model 不改写、鉴权换成 JWT 套装、且不签名", async () => {
    const { broker, slots } = await cardHoldingSetup();
    const upstreamCalls: { url: string; headers: Headers; body: string }[] = [];
    const signingFetches: string[] = [];

    const resp = await proxyRequest(anthropicClientReq(), "anthropic", {
      config: TEST_CONFIG,
      broker,
      fetchImpl: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        upstreamCalls.push({ url: req.url, headers: req.headers, body: await req.clone().text() });
        return anthropicOk();
      }, { preconnect: () => {} }) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: recordingSigner(signingFetches),
      highspeed: slots,
    });

    expect(resp.status).toBe(200);
    expect(upstreamCalls.length).toBe(1);
    const call = upstreamCalls[0]!;
    // 出线路由切到 highspeed（不是 coding-plan 的地址）
    expect(call.url).toBe(HIGHSPEED_URL);
    expect(call.url).not.toBe(CODING_PLAN_URL);
    // model 保持客户端请求值
    expect(JSON.parse(call.body).model).toBe("glm-5.1");
    // Coding Plan 双 JWT 换成 zcode JWT 套装 + 卡 ID + 账号身份
    expect(call.headers.get("x-api-key")).toBe(JWT);
    expect(call.headers.get("authorization")).toBe(`Bearer ${JWT}`);
    expect(call.headers.get("x-bigmodel-authorization")).toBe(`Bearer ${CRED}`);
    expect(call.headers.get("bigmodel-target-type")).toBe("PERSONAL");
    expect(call.headers.get("bigmodel-organization")).toBeNull();
    expect(call.headers.get("bigmodel-project")).toBeNull();
    expect(call.headers.get("x-highspeed-card-id")).toBe("hsc_wiring_1");
    // 官方静态规则：highspeed-mode 请求永不签名（signer 连握手都没试过）
    expect(signingFetches.length).toBe(0);
    expect(call.headers.get("x-client-sig")).toBeNull();
  });

  it("TEAM 账号挂卡请求带齐四个身份头", async () => {
    const { broker, slots } = await cardHoldingSetup(highspeedCredential({
      provider: "bigmodel",
      apiKey: "teamkey",
      secret: "teamsecret",
      jwt: "team-jwt",
      identity: { targetType: "TEAM", organizationId: "org-7", projectId: "proj-7", productId: "prod-7" , deviceMid: "test-device-mid" },
    }));
    const upstreamCalls: { url: string; headers: Headers }[] = [];

    const resp = await proxyRequest(anthropicClientReq(), "anthropic", {
      config: TEST_CONFIG,
      broker,
      fetchImpl: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        upstreamCalls.push({ url: req.url, headers: req.headers });
        return anthropicOk();
      }, { preconnect: () => {} }) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: slots,
    });

    expect(resp.status).toBe(200);
    const call = upstreamCalls[0]!;
    // bigmodel 账号同样走 zcode.z.ai 的 highspeed 网关（两家同址）
    expect(call.url).toBe(HIGHSPEED_URL);
    expect(call.headers.get("bigmodel-target-type")).toBe("TEAM");
    expect(call.headers.get("bigmodel-organization")).toBe("org-7");
    expect(call.headers.get("bigmodel-project")).toBe("proj-7");
    expect(call.headers.get("authorization")).toBe("Bearer team-jwt");
    expect(call.headers.get("x-bigmodel-authorization")).toBe("Bearer teamkey.teamsecret");
    expect(call.headers.get("x-highspeed-card-id")).toBe("hsc_wiring_1");
  });

  it("卡过期（3402）→ 退回原模型、路由切回 coding-plan，只提示一次", async () => {
    const draws: string[] = [];
    const { broker, slots, highspeed } = await cardHoldingSetup(highspeedCredential(), draws);
    const upstreamCalls: { url: string; headers: Headers; body: string }[] = [];

    const resp = await proxyRequest(anthropicClientReq(), "anthropic", {
      config: TEST_CONFIG,
      broker,
      fetchImpl: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        upstreamCalls.push({ url: req.url, headers: req.headers, body: await req.clone().text() });
        return upstreamCalls.length === 1
          ? new Response(JSON.stringify({ code: 3402, msg: "highspeed_card_expired" }), { status: 400 })
          : anthropicOk();
      }, { preconnect: () => {} }) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: slots,
    });

    expect(resp.status).toBe(200);
    expect(upstreamCalls.length).toBe(2);
    // 第一次：highspeed 路由 + 卡头
    expect(upstreamCalls[0]!.url).toBe(HIGHSPEED_URL);
    expect(upstreamCalls[0]!.headers.get("x-highspeed-card-id")).toBe("hsc_wiring_1");
    // 第二次：coding-plan 路由 + 原模型 + 常规双头鉴权 + 无卡头
    expect(upstreamCalls[1]!.url).toBe(CODING_PLAN_URL);
    expect(upstreamCalls[1]!.headers.get("x-highspeed-card-id")).toBeNull();
    expect(upstreamCalls[1]!.headers.get("x-api-key")).toBe(CRED);
    expect(upstreamCalls[1]!.headers.get("authorization")).toBe(`Bearer ${CRED}`);
    expect(JSON.parse(upstreamCalls[1]!.body).model).toBe("glm-5.1");
    // 客户端只收到一次降级提示
    expect(resp.headers.get("x-zcode-highspeed-fallback")).toBe("card_expired");
    // 卡被丢弃，且循环在空闲窗口内按原模型重抽了一张（保留的“后台最大速率”偏差）；
    // 下一轮拿到的是一张**新**卡，不是刚才被拒的那张。
    expect(draws.length).toBeGreaterThan(1);
    expect(highspeed.activeCard()?.cardId).toBe("hsc_wiring_1");
    expect(highspeed.activeCard()?.model).toBe("glm-5.1");
  });

  it("5xx / 401 等任何失败同样退回 coding-plan（官方原文「任何失败」）", async () => {
    const { broker, slots } = await cardHoldingSetup();
    const upstreamCalls: { url: string }[] = [];

    const resp = await proxyRequest(anthropicClientReq(), "anthropic", {
      config: TEST_CONFIG,
      broker,
      fetchImpl: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        upstreamCalls.push({ url: req.url });
        return upstreamCalls.length === 1
          ? new Response(JSON.stringify({ msg: "upstream exploded" }), { status: 503 })
          : anthropicOk();
      }, { preconnect: () => {} }) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: slots,
    });

    expect(resp.status).toBe(200);
    expect(upstreamCalls.map((c) => c.url)).toEqual([HIGHSPEED_URL, CODING_PLAN_URL]);
    expect(resp.headers.get("x-zcode-highspeed-fallback")).toBe("request_failed");
  });

  it("keeps card headers on connect-retry rebuilds (attempt ≥ 2 rebuilds from the swapped pairs)", async () => {
    const { broker, slots } = await cardHoldingSetup();
    const upstreamCalls: { url: string; headers: Headers; body: string }[] = [];
    let attempts = 0;

    const resp = await proxyRequest(anthropicClientReq(), "anthropic", {
      config: TEST_CONFIG,
      broker,
      fetchImpl: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        attempts++;
        if (attempts === 1) throw new Error("Unable to connect");
        const req = input instanceof Request ? input : new Request(String(input), init);
        upstreamCalls.push({ url: req.url, headers: req.headers, body: await req.clone().text() });
        return anthropicOk();
      }, { preconnect: () => {} }) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: slots,
    });

    expect(resp.status).toBe(200);
    expect(attempts).toBe(2);
    expect(upstreamCalls.length).toBe(1);
    // 重试的请求仍然是 highspeed 路由 + 完整卡头（model 未变）
    expect(upstreamCalls[0]!.url).toBe(HIGHSPEED_URL);
    expect(upstreamCalls[0]!.headers.get("x-highspeed-card-id")).toBe("hsc_wiring_1");
    expect(upstreamCalls[0]!.headers.get("x-api-key")).toBe(JWT);
    expect(upstreamCalls[0]!.headers.get("x-bigmodel-authorization")).toBe(`Bearer ${CRED}`);
    expect(JSON.parse(upstreamCalls[0]!.body).model).toBe("glm-5.1");
  });

  it("流中断（已回写字节）→ 作废卡，下一轮自然落回 coding-plan", async () => {
    const events: string[] = [];
    const { broker, slots, highspeed } = await cardHoldingSetup(highspeedCredential(), [], events);
    // 上游开流后立即断流：客户端只能看到截断的流（字节已回写，无法重放）
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
        ));
        controller.error(new Error("upstream stream interrupted"));
      },
    });

    const resp = await proxyRequest(anthropicClientReq(), "anthropic", {
      config: TEST_CONFIG,
      broker,
      fetchImpl: Object.assign(
        async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
        { preconnect: () => {} },
      ) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: slots,
    });

    expect(resp.status).toBe(200);
    await resp.text().catch(() => ""); // 截断的流：读取失败是预期的
    // 统计旁路读到错误 → 当场作废这张卡（下一轮不会再拿它去撞）
    expect(await until(() => events.some((m) => m.includes("card dropped (stream_interrupted)")))).toBeTrue();
    void highspeed;
  });

  it("leaves requests untouched when the model is not eligible", async () => {
    const draws: string[] = [];
    const { broker, slots, account } = await cardHoldingSetup(highspeedCredential(), draws);
    const base = slots.forAccount(account);
    let noteActivityCalls = 0;
    // 同一个卡槽实例（slots.forAccount 返回同一个对象），只换 noteActivity 实现
    base.noteActivity = () => {
      noteActivityCalls += 1;
    };
    const upstreamCalls: { url: string; headers: Headers; body: string }[] = [];

    const resp = await proxyRequest(anthropicClientReq("glm-4.6"), "anthropic", {
      config: TEST_CONFIG,
      broker,
      fetchImpl: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        upstreamCalls.push({ url: req.url, headers: req.headers, body: await req.clone().text() });
        return anthropicOk();
      }, { preconnect: () => {} }) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: slots,
    });

    expect(resp.status).toBe(200);
    expect(upstreamCalls.length).toBe(1);
    expect(upstreamCalls[0]!.url).toBe(CODING_PLAN_URL);
    expect(upstreamCalls[0]!.headers.get("x-highspeed-card-id")).toBeNull();
    expect(upstreamCalls[0]!.headers.get("x-api-key")).toBe(CRED);
    expect(JSON.parse(upstreamCalls[0]!.body).model).toBe("glm-4.6");
    // 合格性闸门：不合格流量不得给抽卡循环续命（空转烧 draw 配额）
    expect(noteActivityCalls).toBe(0);
  });

  it("notifies in-flight activity for an eligible model after the response completes", async () => {
    const { broker, slots, account } = await cardHoldingSetup();
    const base: HighspeedManager = slots.forAccount(account);
    let noteActivityCalls = 0;
    base.noteActivity = () => {
      noteActivityCalls += 1;
    };

    const resp = await proxyRequest(anthropicClientReq(), "anthropic", {
      config: TEST_CONFIG,
      broker,
      fetchImpl: Object.assign(async () => anthropicOk(), { preconnect: () => {} }) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: slots,
    });

    expect(resp.status).toBe(200);
    expect(noteActivityCalls).toBe(1);
  });

  it("没有 JWT 的账号既不抽卡也不给别人的循环续命（每账号卡槽隔离）", async () => {
    const draws: string[] = [];
    // 账号 A：有 JWT，先点燃自己的循环并拿到卡
    const { broker: brokerA, slots, account: accountA } = await cardHoldingSetup(highspeedCredential(), draws);
    const managerA = slots.forAccount(accountA);
    const drawsAfterA = draws.length;
    expect(managerA.activeCard()).not.toBeNull();

    // 账号 B：只有 apiKey（没有 JWT）→ 不抽卡、也不碰 A 的卡槽
    const { broker: brokerB } = brokerFor({
      kind: "zhipu-account",
      provider: "zai",
      apiKey: "imported-key",
      identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
    });
    const resp = await proxyRequest(anthropicClientReq(), "anthropic", {
      config: TEST_CONFIG,
      broker: brokerB,
      highspeed: slots,
      endpointRouting: null,
      clientSigning: null,
      fetchImpl: Object.assign(async () => anthropicOk(), { preconnect: () => {} }) as unknown as typeof fetch,
    });
    expect(resp.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(draws.length).toBe(drawsAfterA); // B 没抽卡
    expect(managerA.activeCard()).not.toBeNull(); // A 的卡槽原样
    // 两张卡槽互不相同
    expect(slots.accountIds().length).toBe(2);
    void brokerA;
  });
});
