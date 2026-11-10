/**
 * 路由化的验收用例：**两个不同路由的账号各自跑通，凭据不串**。
 *
 * 这是路由化的验收标准，也是整个路由化最容易被"看起来跑通了"骗过去
 * 的地方：只要还在读进程级 `config.plan` / `config.provider`，两个账号都会用同一
 * 条路由、同一份凭据出线，而单账号的用例永远发现不了。
 *
 * 所以这里断言的不是"返回 200"，而是**出线请求的可观测属性**：
 *
 * 1. URL 不同：coding-plan 走 family 端点，start-plan 走 zcode.z.ai 网关
 *    （端点由路由决定）；
 * 2. 鉴权形态不同：coding-plan 是 `x-api-key` + `Authorization` 双头，start-plan
 *    只有 `Authorization: Bearer {plan JWT}`（见 `proxy/upstream.ts`）；
 * 3. 凭据值不串 —— A 账号的请求里不得出现 B 账号的 apiKey 或 JWT，反之亦然。
 */
import { describe, it, expect } from "bun:test";
import { proxyRequest } from "./handler.js";
import { inMemoryAccounts, accountFor } from "../accounts/testing.js";
import type { Account, Credential, RouteKind } from "../accounts/types.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import type * as CaptchaExports from "../captcha/captcha.js";

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
  defaultModel: "glm-4.6",
  models: ["glm-4.6"],
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
  id: "msg_split",
  type: "message",
  role: "assistant",
  model: "glm-4.6",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

/** coding-plan 账号：apiKey 对，路由白名单只有 coding-plan。*/
const CODING_CRED: Credential = {
  kind: "zhipu-account",
  provider: "zai",
  apiKey: "coding-key-id",
  secret: "coding-secret",
  identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
};

/** start-plan 账号：plan JWT，路由白名单只有 start-plan。*/
const START_CRED: Credential = {
  kind: "zhipu-account",
  provider: "zai",
  apiKey: "",
  jwt: "start-plan-jwt",
  identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
};

function twoAccounts(): { accounts: Account[] } {
  return {
    accounts: [
      accountFor(CODING_CRED, { label: "coding", routes: ["coding-plan"] as RouteKind[] }),
      accountFor(START_CRED, { label: "start", routes: ["start-plan"] as RouteKind[] }),
    ],
  };
}

/**
 * 客户端请求。`account` 非空时带 `X-ZCode-Account: <label>`。
 *
 * 账号由调度器按候选集与选号决定（`routing.order` 决定路由优先级），
 * 没有「默认账号」可依赖，所以"这条请求由哪个账号出线"必须用
 * `requestedAccount` 显式钉住。这正是本文件要断言的"两条路由各自跑通"。
 */
const clientReq = (account?: string): Request =>
  new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(account ? { "x-zcode-account": account } : {}),
    },
    body: JSON.stringify({ model: "glm-4.6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });

/**
 * 跑一次请求，返回上游实际收到的 URL 与鉴权头。
 * `account` 用 `X-ZCode-Account` 钉住出线账号（没有"默认账号"语义，见
 * {@link clientReq}）。
 */
async function capture(
  label: string,
  account: "coding" | "start",
): Promise<{ url: string; xApiKey: string | null; authorization: string | null }> {
  const { accounts } = twoAccounts();
  const { broker } = inMemoryAccounts(accounts);
  let seen: Request | undefined;
  const resp = await proxyRequest(clientReq(account), "anthropic", {
    config: CONFIG,
    broker,
    fetchImpl: (async (req: Request) => {
      seen = req;
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
    endpointRouting: null,
    clientSigning: null,
    highspeed: null,
    captcha: FAKE_CAPTCHA,
  });
  expect(resp.status, `${label} must succeed`).toBe(200);
  await resp.text();
  if (!seen) throw new Error(`${label}: upstream was never reached`);
  return {
    url: seen.url,
    xApiKey: seen.headers.get("x-api-key"),
    authorization: seen.headers.get("authorization"),
  };
}

describe("两个不同路由的账号并存：各自跑通、凭据不串", () => {
  it("coding-plan 账号走 family 端点，用 apiKey 对双头鉴权", async () => {
    const { accounts } = twoAccounts();
    const { broker } = inMemoryAccounts(accounts);
    let seen: Request | undefined;
    const resp = await proxyRequest(clientReq("coding"), "anthropic", {
      config: CONFIG,
      broker,
      fetchImpl: (async (req: Request) => {
        seen = req;
        return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
      captcha: FAKE_CAPTCHA,
    });
    expect(resp.status).toBe(200);
    await resp.text();
    expect(seen!.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(seen!.headers.get("x-api-key")).toBe("coding-key-id.coding-secret");
    expect(seen!.headers.get("authorization")).toBe("Bearer coding-key-id.coding-secret");
  });

  it("start-plan 账号走 zcode.z.ai 网关，只用 plan JWT，且不带 coding 账号的任何凭据", async () => {
    const { accounts } = twoAccounts();
    const { broker } = inMemoryAccounts(accounts);
    let seen: Request | undefined;
    const resp = await proxyRequest(clientReq("start"), "anthropic", {
      config: CONFIG,
      broker,
      fetchImpl: (async (req: Request) => {
        seen = req;
        return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
      captcha: FAKE_CAPTCHA,
    });
    expect(resp.status).toBe(200);
    await resp.text();

    // 端点由路由决定：start-plan 的 baseUrl 是 zcode.z.ai 网关。
    expect(seen!.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
    // 鉴权形态由路由决定：只有 Bearer JWT，没有 x-api-key。
    expect(seen!.headers.get("authorization")).toBe("Bearer start-plan-jwt");
    expect(seen!.headers.get("x-api-key")).toBeNull();
    // 凭据不串：coding 账号的 key 一个字节都不该出现在这条请求里。
    const serialized = JSON.stringify([...seen!.headers.entries()]);
    expect(serialized).not.toContain("coding-key-id");
    expect(serialized).not.toContain("coding-secret");
  });

  it("两条路由的鉴权值与端点互不相同（同一进程内并发成立，不靠全局状态）", async () => {
    const coding = await capture("coding", "coding");
    const start = await capture("start", "start");

    expect(coding.url).not.toBe(start.url);
    expect(coding.authorization).not.toBe(start.authorization);
    expect(coding.xApiKey).toBe("coding-key-id.coding-secret");
    expect(start.xApiKey).toBeNull();
    // 双向不串。
    expect(coding.authorization).not.toContain("start-plan-jwt");
    expect(start.authorization).not.toContain("coding-key-id");
  });
});
