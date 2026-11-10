/**
 * 验收用例：`X-ZCode-Route` 显式路由头（`pinnedRoute`）。
 *
 * 背景：pinned 账号固定走 `account.routes[0]`，多路由账号被
 * `X-ZCode-Account` 指定时永远落在第一档。这个头把「用这个账号的某一条路由」补成
 * 可表达的，三条语义见 `handler-utils.ts::requestedRoute` 的注释。
 *
 * 断言分两层：
 *
 * - broker 层的组合语义（label 钉住 + 路由钉住）在 `accounts/broker.test.ts` 的
 *   「路由钉住」组，那里已有 pinnedRoute 的单路由用例；
 * - 这里测请求头到 `request.pinnedRoute` 的传递与三个入站协议（/v1/messages、
 *   /v1/chat/completions、/v1/responses 都过同一段解析），断言落在**出线 URL**
 *   （端点由路由决定）与请求记录的 intake/dispatch 阶段上。
 *
 * 一个刻意的边界：`route-not-allowed` 从 broker 抛出后走既有 HTTP 映射
 * （`proxy/lease.ts`：本地状态问题 → 503 `credential_unavailable`），这里不改它，
 * 改映射会同时改掉 Responses 续轮同错误的返回码，超出这个头的范围。
 */
import { describe, it, expect } from "bun:test";
import { proxyRequest } from "./handler.js";
import { handleResponses } from "./responses-handler.js";
import { ResponseStore } from "../responses/store.js";
import { inMemoryAccounts, accountFor } from "../accounts/testing.js";
import type { Account, Credential, RouteKind } from "../accounts/types.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import type * as CaptchaExports from "../captcha/captcha.js";
import { RequestStore } from "./request-record.js";

/**
 * start-plan 路由过验证码。用假模块注入，测试不碰 happy-dom
 * 求解器、也不发任何网络请求：真求解器会去 alicdn 拉脚本（离线环境下会挂）。
 */
const FAKE_CAPTCHA = {
  RETRY_HEADERS: { PARAM: "x-aliyun-captcha-verify-param", REGION: "x-aliyun-captcha-verify-region" },
  getCaptchaToken: async () => ({ verifyParam: "test-token", region: "cn" }),
  detectCaptchaChallenge: () => null,
} as unknown as typeof CaptchaExports;

const IDENTITY: ProxyIdentity = {
  appVersion: "test-1.0.0",
  appVersionSource: "default",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
  betaPolicy: "drop",
  betaAllowlist: [],
};

const CONFIG: ProxyConfig = {
  server: { port: 8080, host: "0.0.0.0" },
  auth: { requireKey: false },
  providers: {
    zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
    bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
  },
  defaultModel: "glm-5.3-flash",
  models: ["glm-5.3-flash"],
  identity: IDENTITY,
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

const ANTHROPIC_OK = JSON.stringify({
  id: "msg_route_header",
  type: "message",
  role: "assistant",
  model: "glm-5.3-flash",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

/** 两个端点：断言路由选对了，最直接的证据就是请求打到了谁的 URL 上。*/
const CODING_URL = "https://api.z.ai/api/anthropic/v1/messages";
const START_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";

/** 双路由凭据：apiKey 对（coding-plan 要）+ plan JWT（start-plan 要）。*/
const FULL_CRED: Credential = {
  kind: "zhipu-account",
  provider: "zai",
  apiKey: "key-id",
  secret: "key-secret",
  jwt: "plan.jwt.token",
  identity: { targetType: "PERSONAL", deviceMid: "test-device-mid" },
};

/** 多路由账号（`coding-plan,start-plan` 两条都在白名单里，这是这个头要处理的形态）。*/
function multiRouteAccounts(labels: string[]): { accounts: Account[] } {
  return {
    accounts: labels.map((label, i) =>
      accountFor(
        i === 0 ? FULL_CRED : { ...FULL_CRED, apiKey: `${label}-key`, secret: `${label}-secret` },
        { label, routes: ["coding-plan", "start-plan"] as RouteKind[] },
      ),
    ),
  };
}

type Opts = Parameters<typeof proxyRequest>[2];

/** proxyRequest 的公共选项：注入点全部关掉，fetch 捕获出线请求。*/
function proxyOpts(broker: Opts["broker"], capture: { url?: string }, requests?: RequestStore): Opts {
  return {
    config: CONFIG,
    broker,
    requests,
    fetchImpl: (async (req: Request) => {
      capture.url = req.url;
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
    endpointRouting: null,
    clientSigning: null,
    highspeed: null,
    captcha: FAKE_CAPTCHA,
  } as Opts;
}

const anthropicReq = (): Request =>
  new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3-flash", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });

const openaiReq = (): Request =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3-flash", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });

/** 在 anthropic 请求上叠加路由/账号头。*/
function withHeaders(base: Request, headers: Record<string, string>): Request {
  return new Request(base.url, {
    method: base.method,
    headers: { ...Object.fromEntries(base.headers.entries()), ...headers },
    body: base.body,
    // @ts-expect-error duplex 在 lib.dom 的 RequestInit 里没有，Bun 运行时需要它。
    duplex: "half",
  });
}

async function errorBody(resp: Response): Promise<{ error: { type: string; message: string } }> {
  return (await resp.json()) as { error: { type: string; message: string } };
}

describe("X-ZCode-Route — anthropic 入站（/v1/messages）", () => {
  it("账号 + 路由组合合法：落在指定账号的指定路由（start-plan 端点）", async () => {
    const { accounts } = multiRouteAccounts(["bigmodel"]);
    const { broker } = inMemoryAccounts(accounts);
    const capture: { url?: string } = {};
    const resp = await proxyRequest(
      withHeaders(anthropicReq(), { "x-zcode-account": "bigmodel", "x-zcode-route": "start-plan" }),
      "anthropic",
      proxyOpts(broker, capture),
    );
    expect(resp.status).toBe(200);
    await resp.text();
    expect(capture.url).toBe(START_URL);
  });

  it("路由不带账号：该路由成为唯一的档，档内按策略选号（不钉账号）", async () => {
    const { accounts } = multiRouteAccounts(["alpha", "beta"]);
    const { broker } = inMemoryAccounts(accounts);
    const requests = new RequestStore();
    const capture: { url?: string } = {};
    const resp = await proxyRequest(
      withHeaders(anthropicReq(), { "x-zcode-route": "start-plan" }),
      "anthropic",
      proxyOpts(broker, capture, requests),
    );
    expect(resp.status).toBe(200);
    await resp.text();
    expect(capture.url).toBe(START_URL);
    // 账号由档内策略决定，不是某个被钉住的 label：两个多路由账号都合法。
    const record = requests.recent(1)[0]!;
    expect(["alpha", "beta"]).toContain(record.account as string);
    expect(record.route).toBe("start-plan");
  });

  it("路由没有任何账号允许：503 route-not-allowed 的既有映射（不静默改道）", async () => {
    const { accounts } = multiRouteAccounts(["coding-only"]);
    accounts[0]!.routes = ["coding-plan"];
    const { broker } = inMemoryAccounts(accounts);
    const capture: { url?: string } = {};
    const resp = await proxyRequest(
      withHeaders(anthropicReq(), { "x-zcode-route": "start-plan" }),
      "anthropic",
      proxyOpts(broker, capture),
    );
    expect(resp.status).toBe(503);
    const body = await errorBody(resp);
    expect(body.error.type).toBe("credential_unavailable");
    expect(body.error.message).toContain('no account allows route "start-plan"');
    expect(capture.url).toBeUndefined();
  });

  it("账号不允许该路由：503，消息里点名账号（不静默改道）", async () => {
    const { accounts } = multiRouteAccounts(["coding-only"]);
    accounts[0]!.routes = ["coding-plan"];
    const { broker } = inMemoryAccounts(accounts);
    const resp = await proxyRequest(
      withHeaders(anthropicReq(), { "x-zcode-account": "coding-only", "x-zcode-route": "start-plan" }),
      "anthropic",
      proxyOpts(broker, {}),
    );
    expect(resp.status).toBe(503);
    const body = await errorBody(resp);
    expect(body.error.message).toContain('account "coding-only" does not allow route "start-plan"');
  });

  it("非法路由值：400 route_unknown，请求不进调度", async () => {
    const { accounts } = multiRouteAccounts(["bigmodel"]);
    const { broker } = inMemoryAccounts(accounts);
    const capture: { url?: string } = {};
    const resp = await proxyRequest(
      withHeaders(anthropicReq(), { "x-zcode-route": "super-plan" }),
      "anthropic",
      proxyOpts(broker, capture),
    );
    expect(resp.status).toBe(400);
    const body = await errorBody(resp);
    expect(body.error.type).toBe("route_unknown");
    expect(body.error.message).toContain('unknown route "super-plan"');
    expect(capture.url).toBeUndefined();
  });

  it("大小写归一：头值按 ROUTE_KINDS 小写化比对", async () => {
    const { accounts } = multiRouteAccounts(["bigmodel"]);
    const { broker } = inMemoryAccounts(accounts);
    const capture: { url?: string } = {};
    const resp = await proxyRequest(
      withHeaders(anthropicReq(), { "x-zcode-route": "START-PLAN" }),
      "anthropic",
      proxyOpts(broker, capture),
    );
    expect(resp.status).toBe(200);
    await resp.text();
    expect(capture.url).toBe(START_URL);
  });

  it("空头值当未指定处理（不 400）", async () => {
    const { accounts } = multiRouteAccounts(["solo"]);
    accounts[0]!.routes = ["coding-plan"];
    const { broker } = inMemoryAccounts(accounts);
    const capture: { url?: string } = {};
    const resp = await proxyRequest(
      withHeaders(anthropicReq(), { "x-zcode-route": "" }),
      "anthropic",
      proxyOpts(broker, capture),
    );
    expect(resp.status).toBe(200);
    await resp.text();
    expect(capture.url).toBe(CODING_URL);
  });

  it("回归：只带 X-ZCode-Account 仍走 routes[0]（多路由账号不因默认 order 改道）", async () => {
    // 默认 routing.order 是 start-plan 优先；pinned 账号的语义是 routes[0]，
    // 两者不同。这个用例钉住「只带账号不改道」的现状。
    const { accounts } = multiRouteAccounts(["bigmodel"]);
    const { broker } = inMemoryAccounts(accounts);
    const capture: { url?: string } = {};
    const resp = await proxyRequest(
      withHeaders(anthropicReq(), { "x-zcode-account": "bigmodel" }),
      "anthropic",
      proxyOpts(broker, capture),
    );
    expect(resp.status).toBe(200);
    await resp.text();
    expect(capture.url).toBe(CODING_URL);
  });

  it("intake 阶段记录显式路由；未指定时不记", async () => {
    const { accounts } = multiRouteAccounts(["bigmodel"]);
    const { broker } = inMemoryAccounts(accounts);
    const requests = new RequestStore();
    const capture: { url?: string } = {};
    const resp = await proxyRequest(
      withHeaders(anthropicReq(), { "x-zcode-route": "start-plan" }),
      "anthropic",
      proxyOpts(broker, capture, requests),
    );
    expect(resp.status).toBe(200);
    await resp.text();
    const record = requests.recent(1)[0]!;
    expect(record.stages[0]!.stage).toBe("intake");
    expect(record.stages[0]!.fields.route).toBe("start-plan");

    const requests2 = new RequestStore();
    const resp2 = await proxyRequest(anthropicReq(), "anthropic", proxyOpts(broker, {}, requests2));
    expect(resp2.status).toBe(200);
    await resp2.text();
    const record2 = requests2.recent(1)[0]!;
    expect("route" in record2.stages[0]!.fields).toBe(false);
  });
});

describe("X-ZCode-Route — openai 入站（/v1/chat/completions）", () => {
  it("显式路由对 OpenAI 客户端同样生效", async () => {
    const { accounts } = multiRouteAccounts(["bigmodel"]);
    const { broker } = inMemoryAccounts(accounts);
    const capture: { url?: string } = {};
    const resp = await proxyRequest(
      withHeaders(openaiReq(), { "x-zcode-route": "start-plan" }),
      "openai",
      proxyOpts(broker, capture),
    );
    expect(resp.status).toBe(200);
    await resp.text();
    expect(capture.url).toBe(START_URL);
  });
});

describe("X-ZCode-Route — responses 入站（/v1/responses）", () => {
  /** Responses 请求；headers 叠加路由/账号头。*/
  function responsesReq(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  function responsesOpts(
    broker: Parameters<typeof handleResponses>[1]["broker"],
    store: ResponseStore,
    capture: { url?: string },
  ): Parameters<typeof handleResponses>[1] {
    return {
      config: CONFIG,
      broker,
      responseStore: store,
      fetchImpl: (async (req: Request) => {
        capture.url = req.url;
        return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
      captcha: FAKE_CAPTCHA,
    } as Parameters<typeof handleResponses>[1];
  }

  it("显式路由对 Responses 客户端同样生效", async () => {
    const { accounts } = multiRouteAccounts(["bigmodel"]);
    const { broker } = inMemoryAccounts(accounts);
    const store = new ResponseStore();
    const capture: { url?: string } = {};
    const resp = await handleResponses(
      responsesReq({ model: "glm-5.3-flash", input: "hi" }, { "x-zcode-route": "start-plan" }),
      responsesOpts(broker, store, capture),
    );
    expect(resp.status).toBe(200);
    await resp.text();
    expect(capture.url).toBe(START_URL);
  });

  it("Responses 续轮 + 显式 Route 头：续轮钉号优先（previous_response_id 的档不变）", async () => {
    const { accounts } = multiRouteAccounts(["bigmodel"]);
    const { broker } = inMemoryAccounts(accounts);
    const store = new ResponseStore();

    // 首轮用显式头落到 start-plan，产出 (bigmodel, start-plan) 的续轮钉号。
    const first: { url?: string } = {};
    const r1 = await handleResponses(
      responsesReq({ model: "glm-5.3-flash", input: "first turn" }, { "x-zcode-route": "start-plan" }),
      responsesOpts(broker, store, first),
    );
    expect(r1.status).toBe(200);
    const body1 = (await r1.json()) as { id: string };
    expect(body1.id).toBeTruthy();

    // 续轮带 previous_response_id + 一个不同的显式路由头：钉号优先，头被忽略
    // （上游上下文只存在于 (账号, start-plan) 那一对上）。
    const second: { url?: string } = {};
    const r2 = await handleResponses(
      responsesReq(
        { model: "glm-5.3-flash", input: "second turn", previous_response_id: body1.id },
        { "x-zcode-route": "coding-plan" },
      ),
      responsesOpts(broker, store, second),
    );
    expect(r2.status).toBe(200);
    await r2.text();
    expect(second.url).toBe(START_URL);
  });
});
