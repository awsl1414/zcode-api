/**
 * Guard for credentials that carry no coding-plan key.
 *
 * A plan JWT imported with `auth import --jwt` authenticates the start-plan
 * gateway and the control plane, but coding-plan requests authenticate with
 * `{apiKey}.{secret}`. Sending that request anyway would reach the upstream
 * with an empty credential and come back as a 401 that says nothing about the
 * real cause, so the handler refuses it locally.
 */
import { describe, it, expect, mock } from "bun:test";
import { proxyRequest } from "./handler.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { brokerFor } from "../accounts/testing.js";

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
    bigmodel: {
      anthropicBase: "https://open.bigmodel.cn/api/anthropic",
      openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4",
    },
  },
  defaultModel: "glm-4.6",
  models: ["glm-4.6"],
  identity: IDENTITY,
  clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
  responses: { storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false },
  highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
  mcp: {
    enabled: true,
    gateway: { enabled: true, upstreamOrigin: "https://zcode.chatglm.site" },
  },
  async: {
    enabled: false,
    origin: "https://zcode.z.ai",
    pollIntervalMs: 5000,
    keepAliveIntervalMs: 3000,
    maxWaitMs: 0,
    maxRetries: 3,
    settleTimeoutMs: 8000,
    controlTimeoutMs: 15000,
    defaultModel: "",
  },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, sprintWindowMs: 1800000, sprintPollIntervalMs: 60000 },
  logging: { level: "info" },
};

const ANTHROPIC_OK = JSON.stringify({
  id: "msg_guard",
  type: "message",
  role: "assistant",
  model: "glm-4.6",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 3 },
});

const makeClientReq = (): Request =>
  new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "glm-4.6",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    }),
  });

/**
 * 一个账号 + broker。`routes` 决定这次请求解析到的路由，所以"JWT-only 却挂
 * coding-plan"这种非法组合可以直接构造出来（写入时校验会拒绝它，但请求期必须
 * 兜住 —— 手改文件、迁移来的旧账号都可能出现）。
 */
const handlerOpts = (
  cred: { apiKey: string; secret?: string; jwt?: string },
  opts: { config?: ProxyConfig; routes?: ("coding-plan" | "start-plan")[] } = {},
) => {
  const { broker } = brokerFor(
    {
      kind: "zhipu-account",
      provider: "zai",
      apiKey: cred.apiKey,
      ...(cred.secret ? { secret: cred.secret } : {}),
      ...(cred.jwt ? { jwt: cred.jwt } : {}),
      identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
    },
    opts.routes ?? ["coding-plan"],
  );
  const fetchMock = mock(async () => new Response(ANTHROPIC_OK, {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  return { broker, fetchMock, config: opts.config ?? CONFIG };
};

describe("proxyRequest credential guard", () => {
  it("refuses coding-plan traffic when the credential only carries a plan JWT", async () => {
    const { broker, fetchMock } = handlerOpts({ apiKey: "", jwt: "jwt-only" });
    const resp = await proxyRequest(makeClientReq(), "anthropic", {
      config: CONFIG,
      broker,
      fetchImpl: fetchMock as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    });

    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("credential_unavailable");
    expect(body.error.message).toContain("coding-plan needs the coding-plan API key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses start-plan traffic when the credential has no plan JWT", async () => {
    // start-plan 路由 + 没有 JWT 的凭据：必须在本地拒绝。
    const { broker, fetchMock } = handlerOpts({ apiKey: "keyid", secret: "secret" }, { routes: ["start-plan"] });
    const resp = await proxyRequest(makeClientReq(), "anthropic", {
      config: CONFIG,
      broker,
      fetchImpl: fetchMock as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    });

    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("credential_unavailable");
    expect(body.error.message).toContain("needs the plan JWT");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards normally once an apiKey is present", async () => {
    const { broker, fetchMock, config } = handlerOpts({ apiKey: "keyid", secret: "secret", jwt: "jwt-only" });
    const resp = await proxyRequest(makeClientReq(), "anthropic", {
      config,
      broker,
      fetchImpl: fetchMock as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    });

    expect(resp.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
