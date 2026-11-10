/**
 * 端到端会话粘性的用例。
 *
 * 这里走 `proxyRequest` 的真实链路，断言**会话身份与选号的连接**，而不是 broker 内部
 * 的绑定表：陷阱 ① 只在真实链路里才可能被踩到：
 *
 * > 哈希时机必须在路由改写之前。lineage 哈希输入是 canonical body；按路由注入
 * > system prompt / 改写 model 后 body 就变了。
 *
 * 所以核心回归用例是：**同一段客户端对话，钉到不同路由（start-plan / coding-plan）
 * 时推断出的 sessionId 必须一致**。start-plan 会往 body 里注入 system 块（
 * `body-transformer.ts::applyStartPlanSystem`），一旦有人把哈希挪到改写之后，这两次
 * 请求的 canonical body 就不同，sessionId 随之分叉，这条用例会立刻红。
 *
 * @see 粘性 · 会话身份来源 · 三个实现陷阱
 */
import { describe, expect, it } from "bun:test";
import { proxyRequest } from "./handler.js";
import { accountFor, inMemoryAccounts, zhipuCredential } from "../accounts/testing.js";
import { defaultPolicy } from "../accounts/types.js";
import type { Account, Credential, RouteKind } from "../accounts/types.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import type * as CaptchaExports from "../captcha/captcha.js";

/**
 * start-plan 路由过验证码。用假模块注入，测试不碰 happy-dom
 * 求解器、也不发任何网络请求（真求解器会去 alicdn 拉脚本，离线环境直接挂）。
 * 本文件用 start-plan 账号只是为了让 body 改写（system 块注入）真的发生。
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
  // 会话推断必须开着，否则粘性无从谈起。
  clientIdentity: { mode: "enforce", ttlSeconds: 900, maxSessions: 1024 },
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
  id: "msg_ok",
  type: "message",
  role: "assistant",
  model: "glm-4.6",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

function credential(tag: string): Credential {
  // 账号 id = 凭据指纹：不同 apiKey 才是不同账号。
  return zhipuCredential({ apiKey: `key-${tag}`, secret: `secret-${tag}`, jwt: `jwt-${tag}` });
}

function account(label: string, routes: RouteKind[] = ["coding-plan"]): Account {
  return accountFor(credential(label), {
    label,
    routes,
    policy: defaultPolicy({ maxConcurrency: 4 }),
  });
}

/** 一段客户端对话（内容每个用例不同，避免共享 lineage 表的串扰）。*/
function clientReq(text: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: "glm-4.6",
      max_tokens: 16,
      system: "you are a coding agent",
      messages: [{ role: "user", content: text }],
    }),
  });
}

const okFetch = (async () =>
  new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

/**
 * 记录 broker 收到的 `sessionId`，并透传给真正的 broker。
 *
 * 断言 sessionId 只能在这一层做：它是"会话身份"与"选号"之间的唯一接口，而
 * 这里要回归的正是"这个值不该随路由改写而变"。
 */
function spySessionIds(broker: ReturnType<typeof inMemoryAccounts>["broker"]): Array<string | undefined> {
  const seen: Array<string | undefined> = [];
  const original = broker.acquire.bind(broker);
  broker.acquire = async (request) => {
    seen.push(request?.sessionId);
    return await original(request);
  };
  return seen;
}

describe("陷阱 ①：哈希时机在路由改写之前", () => {
  it("同一段对话钉到 start-plan 与 coding-plan，推断出的 sessionId 必须一致", async () => {
    const trial = account("trial", ["start-plan"]);
    const coding = account("coding", ["coding-plan"]);
    const { broker } = inMemoryAccounts([trial, coding], {
      routing: { order: ["start-plan", "coding-plan"] },
    });
    const seen = spySessionIds(broker);

    // 抓出线 body：用来证明"两条路由的上游 body 确实不同"（即改写真的发生了），
    // 否则下面"sessionId 相同"只能说明改写没生效，证明不了哈希时机。
    const wireBodies: string[] = [];
    const recordingFetch = (async (req: Request) => {
      wireBodies.push(await req.text());
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const text = "trap-one-regression: explain the scheduler";

    const onTrial = await proxyRequest(clientReq(text, { "x-zcode-account": "trial" }), "anthropic", {
      config: CONFIG,
      broker,
      fetchImpl: recordingFetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
      captcha: FAKE_CAPTCHA,
    });
    expect(onTrial.status).toBe(200);

    const onCoding = await proxyRequest(clientReq(text, { "x-zcode-account": "coding" }), "anthropic", {
      config: CONFIG,
      broker,
      fetchImpl: recordingFetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    });
    expect(onCoding.status).toBe(200);

    expect(seen.length).toBe(2);
    const [first, second] = seen;
    expect(first).toBeDefined();

    // 前提：两条路由的上游 body 不同（start-plan 注入 system 块 + 换端点鉴权）。
    expect(wireBodies.length).toBe(2);
    expect(wireBodies[0]).not.toBe(wireBodies[1]);

    // 结论：body 被改写了，sessionId 却没有变，因为哈希在改写之前。
    // 一旦有人把哈希挪到改写之后，这两个值必然分叉，这条断言立刻红。
    expect(second).toBe(first);
  });
});

describe("陷阱：none 来源不参与粘性", () => {
  it("推断不出会话（body 没有 messages）时不写绑定表", async () => {
    const a = account("a");
    const b = account("b");
    const { broker } = inMemoryAccounts([a, b], { routing: { order: ["coding-plan"] } });
    const seen = spySessionIds(broker);

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 没有 messages → canonicalize 返回 null → source "none"。
      body: JSON.stringify({ model: "glm-4.6", max_tokens: 16, messages: [] }),
    });

    const resp = await proxyRequest(req, "anthropic", {
      config: CONFIG,
      broker,
      fetchImpl: okFetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    });

    expect(resp.status).toBe(200);
    expect(seen[0]).toBeUndefined();
    expect(broker.bindings.size()).toBe(0);
  });
});

describe("端到端粘性：同一对话固定同一账号（对客户端透明）", () => {
  it("两轮同一对话落在同一账号，且绑定表里只有一条记录", async () => {
    const a = account("a");
    const b = account("b");
    const { broker } = inMemoryAccounts([a, b], { routing: { order: ["coding-plan"] } });

    const usedKeys: string[] = [];
    const fetchImpl = (async (req: Request) => {
      usedKeys.push(req.headers.get("x-api-key") ?? "unknown");
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const opts = { config: CONFIG, broker, fetchImpl, endpointRouting: null, clientSigning: null, highspeed: null };
    const text = "sticky-e2e: write a haiku about slots";

    const first = await proxyRequest(clientReq(text), "anthropic", opts);
    expect(first.status).toBe(200);
    const second = await proxyRequest(clientReq(text), "anthropic", opts);
    expect(second.status).toBe(200);

    expect(usedKeys.length).toBe(2);
    // 同一个会话 → 同一个账号（凭据不同 = 账号不同，见 credential()）。
    expect(usedKeys[1]).toBe(usedKeys[0]);
    expect(broker.bindings.size()).toBe(1);
  });

  it("不同对话可以落在不同账号（粘性不是把一切都压到一个账号）", async () => {
    const a = account("a");
    const b = account("b");
    const c = account("c");
    const { broker } = inMemoryAccounts([a, b, c], { routing: { order: ["coding-plan"] } });

    const usedKeys = new Set<string>();
    const fetchImpl = (async (req: Request) => {
      usedKeys.add(req.headers.get("x-api-key") ?? "unknown");
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const opts = { config: CONFIG, broker, fetchImpl, endpointRouting: null, clientSigning: null, highspeed: null };
    for (let index = 0; index < 12; index++) {
      const resp = await proxyRequest(clientReq(`distinct-conversation-${index}`), "anthropic", opts);
      expect(resp.status).toBe(200);
    }

    expect(usedKeys.size).toBeGreaterThan(1);
    expect(broker.bindings.size()).toBe(12);
  });
});
