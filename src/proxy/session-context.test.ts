/**
 * Tests for unified session context policy.
 */
import { describe, expect, it } from "bun:test";
import type { ProxyConfig } from "../config/types.js";
import { createClientSessionResolver } from "./client-session.js";
import { resolveSessionContext, sessionIdForHeader, shouldForwardSessionId } from "./session-context.js";

const BASE_CONFIG: ProxyConfig = {
  server: { port: 8080, host: "0.0.0.0" },
  auth: { requireKey: false },
  providers: {
    zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
    bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
  },
  defaultModel: "glm-4.6",
  models: ["glm-4.6"],
  identity: {
    appVersion: "3.3.3",
    appVersionSource: "default",
    sourceTitle: "zcode",
    refererOrigin: "https://zcode.z.ai",
    betaPolicy: "drop",
    betaAllowlist: [],
  },
  clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
  responses: { storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false }, highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
  mcp: { enabled: true, gateway: { enabled: true, upstreamOrigin: "https://zcode.chatglm.site" } },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, sprintWindowMs: 1800000, sprintPollIntervalMs: 60000 },
  logging: { level: "info" },
};

describe("session context", () => {
  it("uses the lineage resolver for session inference (both plan callers share it)", () => {
    const resolver = createClientSessionResolver();
    const body = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });
    const req = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    const session = resolveSessionContext({
      accountId: "acct-a",
      clientReq: req,
      body,
      upstreamFormat: "openai",
      model: "glm-4.6",
      config: BASE_CONFIG,
      resolver,
    });

    expect(session?.source).toBe("lineage");
    expect(session?.action).toBe("observe");
    expect(session?.upstreamSessionId).toBeTruthy();
  });

  it("透传 accountId：同一段对话在两个账号下得到不同的 sessionId", () => {
    const resolver = createClientSessionResolver();
    const body = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });
    const makeReq = () => new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const resolve = (accountId: string) => resolveSessionContext({
      accountId,
      clientReq: makeReq(),
      body,
      upstreamFormat: "openai",
      model: "glm-4.6",
      config: BASE_CONFIG,
      resolver,
    });

    const a = resolve("acct-a");
    const b = resolve("acct-b");

    // 账号维度真的穿到了 resolver：否则两条会是同一个 sessionId
    expect(a?.sessionId).toBeTruthy();
    expect(a?.sessionId).not.toBe(b?.sessionId);
  });

  it("does not resolve any session when clientIdentity mode is off", () => {
    const body = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });
    const session = resolveSessionContext({
      accountId: "acct-a",
      clientReq: new Request("http://localhost:8080/v1/chat/completions", { method: "POST", body }),
      body,
      upstreamFormat: "openai",
      model: "glm-4.6",
      config: { ...BASE_CONFIG, clientIdentity: { ...BASE_CONFIG.clientIdentity, mode: "off" } },
    });

    expect(session).toBeUndefined();
  });

  it("forwards session IDs only for explicit or enforce contexts", () => {
    expect(shouldForwardSessionId({
      source: "lineage",
      action: "observe",
      upstreamSessionId: "11111111-1111-4111-8111-111111111111",
    })).toBe(false);
    expect(sessionIdForHeader({
      source: "lineage",
      action: "observe",
      upstreamSessionId: "11111111-1111-4111-8111-111111111111",
    })).toBeUndefined();
    expect(sessionIdForHeader({
      source: "lineage",
      action: "enforce",
      upstreamSessionId: "11111111-1111-4111-8111-111111111111",
    })).toBe("11111111-1111-4111-8111-111111111111");
    expect(sessionIdForHeader({
      source: "explicit",
      action: "observe",
      upstreamSessionId: "sess_thread_1",
    })).toBe("sess_thread_1");
  });
});
