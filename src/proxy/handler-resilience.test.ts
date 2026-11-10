/**
 * Tests for the two resilience behaviors added after the PR #34 review:
 *
 * 1. In-body captcha challenge detection: a start-plan upstream response with
 *    HTTP 400 + {"code":3007,...} in the JSON body (no captcha header) must
 *    be treated as a captcha challenge and retried with a fresh token.
 * 2. Connect-retry freshness: after a connect-level failure, the retried
 *    dispatch must receive a FRESH Request. Review follow-up #1 (PR #34):
 *    a `req.bodyUsed === false` assertion is vacuous in a mock (mock fetch
 *    never consumes the body), so freshness is pinned by OBJECT IDENTITY —
 *    the second call must receive a different Request instance.
 *
 * Tests inject a request-local captcha dependency so real facade tests can
 * run before or after this file without sharing a module mock.
 */
import { describe, it, expect, mock } from "bun:test";
import { proxyRequest, type ProxyHandlerOptions } from "./handler.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { brokerFor } from "../accounts/testing.js";

/**
 * Broker backed by an in-memory account (replaces the removed `AuthManager`:
 * 5.0 resolves credentials through `broker.acquire()`). `routes` decides which
 * route this request resolves to, which is what used to be the global `plan`.
 */
function oauthBroker(key: string, routes: ("coding-plan" | "start-plan")[] = ["coding-plan"]) {
  const [apiKey, secret] = key.split(".");
  return brokerFor({
    kind: "zhipu-account",
    provider: "zai",
    apiKey,
    ...(secret ? { secret } : {}),
    // start-plan 路由按 plan JWT 鉴权（auth/capabilities.ts 规则 4）。
    jwt: "jwt-mock",
    identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
  }, routes).broker;
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
  clientSigning: { enabled: false }, highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
  mcp: { enabled: true, gateway: { enabled: true, upstreamOrigin: "https://zcode.chatglm.site" } },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, sprintWindowMs: 1800000, sprintPollIntervalMs: 60000 },
  logging: { level: "info" },
};

const ANTHROPIC_OK = JSON.stringify({
  id: "msg_resilience",
  type: "message",
  role: "assistant",
  model: "glm-4.6",
  content: [{ type: "text", text: "resilience reply" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 3 },
});

type CaptchaStub = NonNullable<ProxyHandlerOptions["captcha"]>;

function captchaStub(getCaptchaToken: CaptchaStub["getCaptchaToken"]): CaptchaStub {
  return {
    detectCaptchaChallenge: (resp: Response): string | null => {
      const v = resp.headers.get("x-aliyun-captcha-verify-param");
      return v && v.trim().length > 0 ? v.trim() : null;
    },
    getCaptchaToken,
    RETRY_HEADERS: { PARAM: "x-aliyun-captcha-verify-param", REGION: "x-aliyun-captcha-verify-region" },
  };
}

describe("proxyRequest — start-plan resilience", () => {
  it("retries an in-body 3007 captcha challenge with a fresh token", async () => {
    // Inject captcha behavior: config enabled, token take returns distinct
    // tokens per call so we can assert the retry used a FRESH token.
    let tokenSeq = 0;
    const captcha = captchaStub(async () => {
      tokenSeq += 1;
      return { verifyParam: `tok-${tokenSeq}`, region: "sgp" };
    });

    // Upstream: first call = HTTP 400 with {"code":3007} in the body (no
    // captcha header), second call = success. The mock also records the
    // captcha header of each call so we can assert the retry used a FRESH
    // token (tok-2, not the consumed tok-1).
    const seenCaptchaHeaders: (string | null)[] = [];
    let calls = 0;
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      if (req.url.includes("/client/configs")) {
        return new Response(JSON.stringify({ data: { configs: { captcha: { enabled: true } } } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      calls += 1;
      seenCaptchaHeaders.push(req.headers.get("x-aliyun-captcha-verify-param"));
      if (calls === 1) {
        return new Response(JSON.stringify({ code: 3007, msg: "captcha verify failed" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    });

    const broker = oauthBroker("key-mock.secret-mock", ["start-plan"]);
    const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}',
    });

    const resp = await proxyRequest(clientReq, "openai", { config: TEST_CONFIG, broker, fetchImpl: fetchMock as any, captcha });

    // The in-body 3007 challenge was detected and retried with a fresh token.
    expect(calls).toBe(2);
    expect(seenCaptchaHeaders[0]).toBe("tok-1");
    expect(seenCaptchaHeaders[1]).toBe("tok-2");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.choices[0].message.content).toBe("resilience reply");
  });

  it("retries a connect failure with a FRESH Request (identity-pinned)", async () => {
    const captcha = captchaStub(async () => ({ verifyParam: "tok-connect", region: "sgp" }));
    // Upstream: first call = connect-level failure (the bug shape), second
    // call = success. Review follow-up #1 (PR #34): a mock fetch never
    // consumes the Request body, so a `req.bodyUsed === false` assertion is
    // vacuous — it passes even if the handler re-dispatches the SAME Request
    // object. Pin freshness by OBJECT IDENTITY instead: the second call must
    // receive a different Request instance than the first.
    let calls = 0;
    let firstReq: Request | null = null;
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        firstReq = req;
        throw new Error("Unable to connect. Is the computer able to access the url?");
      }
      // The freshness assertion: re-dispatching the SAME Request object
      // would fail this identity check.
      expect(firstReq).not.toBeNull();
      expect(req).not.toBe(firstReq);
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    });

    const broker = oauthBroker("key-mock.secret-mock", ["start-plan"]);
    const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}',
    });

    const resp = await proxyRequest(clientReq, "openai", { config: TEST_CONFIG, broker, fetchImpl: fetchMock as any, captcha });

    // The connect failure was retried with a FRESH Request (identity check
    // inside the mock passed).
    expect(calls).toBe(2);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.choices[0].message.content).toBe("resilience reply");
  });
});

describe("proxyRequest — start-plan strict captcha acquisition", () => {
  const makeClientReq = () =>
    new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}',
    });

  it("acquisition failure → 503 captcha_solver_failed, upstream NEVER dispatched", async () => {
    const captcha = captchaStub(async () => {
      throw new Error("captcha worker timeout");
    });

    let upstreamCalls = 0;
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      if (req.url.includes("/client/configs")) {
        return new Response(JSON.stringify({ data: { configs: { captcha: { enabled: true } } } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      upstreamCalls += 1;
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    });

    const savedBudget = process.env.CAPTCHA_ACQUIRE_BUDGET_MS;
    process.env.CAPTCHA_ACQUIRE_BUDGET_MS = "10";
    const broker = oauthBroker("key-mock.secret-mock", ["start-plan"]);
    try {
      const resp = await proxyRequest(makeClientReq(), "openai", { config: TEST_CONFIG, broker, fetchImpl: fetchMock as any, captcha });
      expect(resp.status).toBe(503);
      const body = await resp.json();
      expect(body.error.type).toBe("captcha_solver_failed");
      // Strict mode: a captcha-less dispatch is a shape the real client never
      // produces — the ESA edge answers it with bare 502s. Must not go out.
      expect(upstreamCalls).toBe(0);
    } finally {
      if (savedBudget === undefined) delete process.env.CAPTCHA_ACQUIRE_BUDGET_MS;
      else process.env.CAPTCHA_ACQUIRE_BUDGET_MS = savedBudget;
    }
  });

  it("bounds a pending acquisition and ignores its token after the deadline", async () => {
    const lateToken = { verifyParam: "tok-too-late", region: "sgp" };
    let resolveToken!: (value: typeof lateToken) => void;
    const pendingToken = new Promise<typeof lateToken>((resolve) => { resolveToken = resolve; });
    let acquireCalls = 0;
    const captcha = captchaStub(async () => {
      acquireCalls += 1;
      return pendingToken;
    });
    const fetchMock = mock(async () =>
      new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const broker = oauthBroker("key-mock.secret-mock", ["start-plan"]);
    const savedBudget = process.env.CAPTCHA_ACQUIRE_BUDGET_MS;
    process.env.CAPTCHA_ACQUIRE_BUDGET_MS = "25";
    const responsePromise = proxyRequest(makeClientReq(), "openai", {
      config: TEST_CONFIG, broker, fetchImpl: fetchMock as unknown as typeof fetch, captcha,
    });
    let guardTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A stalled solver must not keep the handler alive until the solve ends.
      const resp = await Promise.race([
        responsePromise,
        new Promise<never>((_, reject) => {
          guardTimer = setTimeout(() => reject(new Error("captcha acquisition exceeded its budget")), 1_000);
        }),
      ]);
      expect(resp.status).toBe(503);
      expect((await resp.json()).error.type).toBe("captcha_solver_failed");
      expect(acquireCalls).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();

      resolveToken(lateToken);
      await pendingToken;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(acquireCalls).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      clearTimeout(guardTimer);
      resolveToken(lateToken);
      if (savedBudget === undefined) delete process.env.CAPTCHA_ACQUIRE_BUDGET_MS;
      else process.env.CAPTCHA_ACQUIRE_BUDGET_MS = savedBudget;
      await responsePromise;
    }
  });

  it("config-disabled (token=null) → dispatches WITHOUT captcha headers, upstream 200", async () => {
    const captcha = captchaStub(async () => null);

    let upstreamCalls = 0;
    let sawCaptchaHeader: string | null = "sentinel";
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      if (req.url.includes("/client/configs")) {
        return new Response(JSON.stringify({ data: {} }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      upstreamCalls += 1;
      sawCaptchaHeader = req.headers.get("x-aliyun-captcha-verify-param");
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    });

    const broker = oauthBroker("key-mock.secret-mock", ["start-plan"]);
    const resp = await proxyRequest(makeClientReq(), "openai", { config: TEST_CONFIG, broker, fetchImpl: fetchMock as any, captcha });

    expect(resp.status).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(sawCaptchaHeader).toBeNull();
    const body = await resp.json();
    expect(body.choices[0].message.content).toBe("resilience reply");
  });
});
