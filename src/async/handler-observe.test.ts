/**
 * async 出线的上游信号接进统一观测点。
 *
 * 闲时通道的 LLM 出线（bridge 的 `forwardLLM`）拿到上游响应后递
 * `onUpstreamResp` → `observeUpstream`（同数据面规则；票券绑账号，lease 自带）：
 * 429 + `Retry-After` → 该 `(account, route)` 进 rate-limited 冷却。
 *
 * 桥接自身合成的 error 帧（票券超时/重试耗尽）不过滤之外的路径不进健康域——
 * `asyncStreamSignal` 把 stream-error 挡在门外（那是活动域，不是上游流内错误）。
 *
 * mock 形状照抄 `server/routes-async.test.ts` 的 `{code:0, data:{...}}` 信封。
 *
 * @see 统一观测点 · 恢复矩阵的 rate-limited 行
 */
import { describe, expect, it } from "bun:test";
import { handleAsyncMessages } from "./handler.js";
import { inMemoryAccounts, accountFor, zhipuCredential } from "../accounts/testing.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";

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
  async: {
    enabled: true,
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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function envelope(data: unknown): unknown {
  return { code: 0, msg: "ok", data };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("async 出线 429 → 健康冷却", () => {
  it("forwardLLM 的 429 + Retry-After 经 onUpstreamResp 进 observeUpstream", async () => {
    const account = accountFor(zhipuCredential({ apiKey: "key-g3", secret: "secret-g3", jwt: "jwt-g3" }), {
      label: "async-solo",
      routes: ["coding-plan"],
    });
    const { broker } = inMemoryAccounts([account], { routing: { order: ["coding-plan"] } });

    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = typeof url === "string" ? url : url.toString();
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/v1/off-peak/ticket") && method === "POST") {
        return json(envelope({ ticket_id: "t-1", state: "ready" }));
      }
      if (u.includes("/api/v1/off-peak/ticket/") && u.endsWith("/settle") && method === "POST") {
        return new Response(null, { status: 200 });
      }
      if (u.endsWith("/api/v1/off-peak/anthropic/v1/messages") && method === "POST") {
        // 实测形态：上游 429 + Retry-After，头值无 cap 直接采信。
        return new Response(JSON.stringify({ code: 3_002, msg: "too many requests" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "30" },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }) as unknown as typeof fetch;

    const resp = await handleAsyncMessages(
      new Request("http://localhost/async/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }] }),
      }),
      { config: CONFIG, broker, fetchImpl },
    );
    // async 通道的对外语义不变：HTTP 200 + 流内错误（桥接合成），不炸响应。
    expect(resp.status).toBe(200);
    await resp.text();

    await waitFor(() => broker.health.status(account.id, "coding-plan").status === "cooling", "async rate-limited cooling");
    const state = broker.health.status(account.id, "coding-plan");
    expect(state.reason).toBe("rate-limited");
    // Retry-After 30s 无 cap 采信 + 后置抖动 [0, min(6s, 5s)]：只加不减。
    const remaining = state.until! - Date.now();
    expect(remaining).toBeGreaterThan(28_000);
    expect(remaining).toBeLessThanOrEqual(36_000);
  });
});
