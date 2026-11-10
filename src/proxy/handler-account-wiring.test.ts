/**
 * 会话身份的账号维度、同源要求、captcha 分池的接线用例。
 *
 * 三条断言都只能在真实链路上做：
 *
 * 1. `x-session-id` 头与 `metadata.user_id.session_id` 必须是同一个值
 *    上游两处都出自同一个 `ModelStatusContext.sessionId`。单测
 *    `trace-headers.test.ts` 只能证明两个构造函数各自正确，证明不了调用方喂了
 *    同一个输入。
 * 2. 两个账号各发一次请求，token 必须来自各自的池。池隔离本身在
 *    `captcha.test.ts` 里断言；这里断言的是 `proxyRequest` 把租约账号的 id 真的
 *    传到了取 token 的入口。
 * 3. 选号用的粘性键与出线 sessionId 是两个值（见 `client-session.ts` 的
 *    「选号顺序」）：键不能带账号，sessionId 必须带。
 *
 * 求解器用 mock 替换（真求解器会去 alicdn 拉脚本），configs 快照用测试缝注入，
 * 全程不发网络请求。
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { accountFor, inMemoryAccounts, zhipuCredential } from "../accounts/testing.js";
import { defaultPolicy } from "../accounts/types.js";
import type { Account, Credential, RouteKind } from "../accounts/types.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { proxyRequest } from "./handler.js";

const solveMock = mock(async () => "t".repeat(64));

mock.module("../captcha/captcha-solver.js", () => ({
  runCaptchaSolve: solveMock,
  shutdownCaptchaSolver: () => {},
  setCaptchaSolverConcurrency: () => {},
  captchaSolverConcurrency: () => 2,
  CAPTCHA_NODE_DIR: "/tmp",
}));

// mock.module 先注册，所以这里拿到的是 solver 已被替换的同一份实例。
const captcha = await import("../captcha/captcha.js");
const pools = await import("../captcha/captcha-pool.js");

const ENABLED_CONFIGS = JSON.stringify({
  data: { configs: { captcha: { enabled: true, prefix: "no8xfe", sceneId: "11xygtvd", region: "sgp" } } },
});

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
  defaultModel: "glm-5.2",
  models: ["glm-5.2"],
  identity: IDENTITY,
  // x-session-id 只在真的出线时才可观测，所以这里用 enforce。
  clientIdentity: { mode: "enforce", ttlSeconds: 900, maxSessions: 1024 },
  responses: { storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false },
  highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
  mcp: { enabled: true, gateway: { enabled: true, upstreamOrigin: "https://zcode.chatglm.site" } },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, sprintWindowMs: 1800000, sprintPollIntervalMs: 60000 },
  logging: { level: "info" },
};

const ANTHROPIC_OK = JSON.stringify({
  id: "msg_ok",
  type: "message",
  role: "assistant",
  model: "glm-5.2",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

/** 账号 id 由凭据指纹算，所以每个账号必须有不同 apiKey。*/
function credential(tag: string, deviceMid: string): Credential {
  return zhipuCredential({
    apiKey: `key-${tag}`,
    secret: `secret-${tag}`,
    jwt: `jwt-${tag}`,
    identity: { targetType: "PERSONAL", deviceMid },
  });
}

function account(label: string, routes: RouteKind[], deviceMid = `device-${label}`): Account {
  return accountFor(credential(label, deviceMid), {
    label,
    routes,
    policy: defaultPolicy({ maxConcurrency: 4 }),
  });
}

function clientReq(text: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: "glm-5.2",
      max_tokens: 16,
      system: "you are a coding agent",
      messages: [{ role: "user", content: text }],
    }),
  });
}

interface WireCapture {
  headers: Headers;
  body: string;
}

const okFetch = (captured: WireCapture[] = []) =>
  (async (req: Request) => {
    captured.push({ headers: new Headers(req.headers), body: await req.text() });
    return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

describe("metadata.user_id 与 x-session-id 同源", () => {
  beforeEach(() => {
    captcha.__resetCaptchaConfigCacheForTests();
  });
  afterEach(() => {
    captcha.__setConfigsFetchForTests(null);
    try { captcha.shutdownCaptcha(); } catch { /* pool never started */ }
  });

  it("同一次请求里，头的值与 body 里的 session_id 完全相同", async () => {
    const coding = account("coding", ["coding-plan"]);
    const { broker } = inMemoryAccounts([coding], { routing: { order: ["coding-plan"] } });
    const captured: WireCapture[] = [];

    const resp = await proxyRequest(clientReq("metadata-alignment: one request"), "anthropic", {
      config: CONFIG,
      broker,
      fetchImpl: okFetch(captured),
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    });
    expect(resp.status).toBe(200);
    expect(captured.length).toBe(1);

    const headerSessionId = captured[0].headers.get("x-session-id");
    expect(headerSessionId).toBeTruthy();

    const body = JSON.parse(captured[0].body) as { metadata?: { user_id?: string } };
    expect(body.metadata?.user_id).toBeTruthy();
    const userId = JSON.parse(body.metadata!.user_id!) as { device_id?: string; account_uuid?: string; session_id?: string };

    // 同源：上游两处出自同一个 session id，头说 A、body 说 B 就是关联不上账。
    expect(userId.session_id).toBe(headerSessionId!);
    // 出线值是剥掉内部前缀的裸 UUID：`sess_` 漏给上游是真实客户端
    // 永不产生的形态。
    expect(headerSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // device_id 取租约账号自己的指纹，account_uuid 恒为空。
    expect(userId.device_id).toBe("device-coding");
    expect(userId.account_uuid).toBe("");
  });

  it("同一段对话跨轮次仍然同源（不是只在首轮对齐）", async () => {
    const coding = account("coding", ["coding-plan"]);
    const { broker } = inMemoryAccounts([coding], { routing: { order: ["coding-plan"] } });
    const captured: WireCapture[] = [];
    const opts = {
      config: CONFIG,
      broker,
      fetchImpl: okFetch(captured),
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    };

    expect((await proxyRequest(clientReq("cross-turn alignment"), "anthropic", opts)).status).toBe(200);
    expect((await proxyRequest(clientReq("cross-turn alignment"), "anthropic", opts)).status).toBe(200);
    expect(captured.length).toBe(2);

    const pairs = captured.map((wire) => {
      const parsed = JSON.parse(wire.body) as { metadata?: { user_id?: string } };
      const userId = JSON.parse(parsed.metadata!.user_id!) as { session_id?: string };
      return { header: wire.headers.get("x-session-id"), body: userId.session_id };
    });
    for (const pair of pairs) expect(pair.body).toBe(pair.header!);
    // 两轮是同一段对话：会话身份稳定（粘性靠它）。
    expect(pairs[1].header).toBe(pairs[0].header);
  });
});

describe("两个账号各发一次请求，token 来自各自的池", () => {
  beforeEach(() => {
    solveMock.mockClear();
    captcha.__resetCaptchaConfigCacheForTests();
    captcha.__setConfigsFetchForTests((async () =>
      new Response(ENABLED_CONFIGS, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch);
    try { captcha.shutdownCaptcha(); } catch { /* pools never started */ }
  });
  afterEach(() => {
    captcha.__setConfigsFetchForTests(null);
    try { captcha.shutdownCaptcha(); } catch { /* pool never started */ }
  });

  it("每个账号的池只被自己的请求点燃，且各自带上 captcha 头", async () => {
    const trialA = account("trial-a", ["start-plan"]);
    const trialB = account("trial-b", ["start-plan"]);
    const { broker } = inMemoryAccounts([trialA, trialB], { routing: { order: ["start-plan"] } });
    const captured: WireCapture[] = [];
    const opts = {
      config: CONFIG,
      broker,
      fetchImpl: okFetch(captured),
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    };

    // 起点：一个池都没有（池是懒创建的）。
    expect(pools.__captchaPoolForTests(trialA.id)).toBeUndefined();
    expect(pools.__captchaPoolForTests(trialB.id)).toBeUndefined();

    const first = await proxyRequest(clientReq("captcha-per-account: A", { "x-zcode-account": "trial-a" }), "anthropic", opts);
    expect(first.status).toBe(200);
    // 只有被用的那个账号有池，这就是「token 来自各自的池」的直接证据。
    const poolA = pools.__captchaPoolForTests(trialA.id);
    expect(poolA).toBeDefined();
    expect(pools.__captchaPoolForTests(trialB.id)).toBeUndefined();

    const second = await proxyRequest(clientReq("captcha-per-account: B", { "x-zcode-account": "trial-b" }), "anthropic", opts);
    expect(second.status).toBe(200);
    const poolB = pools.__captchaPoolForTests(trialB.id);
    expect(poolB).toBeDefined();
    // 两个池是两个实例，不是同一个池被两个账号轮流喂。
    expect(poolB).not.toBe(poolA);
    // A 的池没有被 B 的请求改写：实例还是同一个。
    expect(pools.__captchaPoolForTests(trialA.id)).toBe(poolA);

    // 两条出线请求都带上了 captcha 头（start-plan 边缘裸发会被空体 502 拦掉）。
    expect(captured.length).toBe(2);
    for (const wire of captured) {
      expect(wire.headers.get("x-aliyun-captcha-verify-param")).toBeTruthy();
      expect(wire.headers.get("x-aliyun-captcha-verify-region")).toBe("sgp");
    }
    // 求解器确实跑了：两个空池各触发一次求解（不是从一个池里取了两次）。
    expect(solveMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
