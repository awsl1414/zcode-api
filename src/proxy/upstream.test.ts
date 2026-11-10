/**
 * Tests for upstream request builder and proxy handler.
 */
import { describe, it, expect, mock } from "bun:test";
import { gzipSync } from "node:zlib";
import { createServer } from "node:net";
import { buildUpstreamRequest, buildUpstreamHeaderPairs, buildUpstreamURL, buildAuthHeaders } from "./upstream.js";
import { sendOrderedUpstreamRequest } from "./ordered-transport.js";
import { buildZcodeTraceHeaders } from "./trace-headers.js";
import { proxyRequest } from "./handler.js";
import { errorResponse, shouldUseOrderedTransport } from "./http-io.js";
/** 官方 Anthropic 端点（与 `config/loader.ts` 的 DEFAULTS 逐字一致）。*/
const ZAI_ANTHROPIC_BASE = "https://api.z.ai/api/anthropic";
const BIGMODEL_ANTHROPIC_BASE = "https://open.bigmodel.cn/api/anthropic";
import type { Credential } from "../auth/types.js";
import type { ProxyConfig, ProxyIdentity, BetaPolicy } from "../config/types.js";
import { brokerFor, inMemoryAccounts } from "../accounts/testing.js";

/**
 * Broker backed by an in-memory single account (replaces the removed
 * `AuthManager` helper: 5.0 resolves credentials through `broker.acquire()`).
 */
function oauthBroker(key = "testkey.testsecret") {
  const [apiKey, secret] = key.split(".");
  return brokerFor({
    kind: "zhipu-account",
    provider: "zai",
    apiKey,
    ...(secret ? { secret } : {}),
    identity: { targetType: "PERSONAL", deviceMid: "test-device-mid" },
  }).broker;
}

/** start-plan 账号：路由白名单只有 start-plan，凭据带 plan JWT。*/
function startPlanBroker(jwt = "jwt-mock") {
  return brokerFor({
    kind: "zhipu-account",
    provider: "zai",
    apiKey: "dummy",
    jwt,
    identity: { targetType: "PERSONAL", deviceMid: "test-device-mid" },
  }, ["start-plan"]).broker;
}

/** 没有账号的 broker：验证"未登录"的 503。*/
function noAccountBroker() {
  return inMemoryAccounts([]).broker;
}

const ZAI_CRED: Credential = { apiKey: "testkey", secret: "testsecret", provider: "zai" };
const BIGMODEL_CRED: Credential = { apiKey: "bmkey", provider: "bigmodel" };

const IDENTITY: ProxyIdentity = {
  appVersion: "test-1.0.0",
  appVersionSource: "default",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
  betaPolicy: "drop",
  betaAllowlist: [],
};

function makeClientReq(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:8080/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

async function captureOrderedRequest(headers: Array<[string, string]>): Promise<{ raw: string; response: Response }> {
  let resolveRaw!: (raw: string) => void;
  const rawPromise = new Promise<string>((resolve) => { resolveRaw = resolve; });
  const server = createServer((socket) => {
    let raw = "";
    socket.on("data", (chunk) => {
      raw += chunk.toString("latin1");
      if (raw.includes("\r\n\r\n")) {
        resolveRaw(raw);
        socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok");
        server.close();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");

  const response = await sendOrderedUpstreamRequest({
    url: `http://127.0.0.1:${address.port}/v1/messages`,
    method: "POST",
    headers,
    body: "{}",
    decompress: false,
  });
  const raw = await rawPromise;
  return { raw, response };
}

describe("buildUpstreamURL", () => {
  it("builds Anthropic URL for Z.AI", () => {
    expect(buildUpstreamURL(ZAI_ANTHROPIC_BASE)).toBe(
      "https://api.z.ai/api/anthropic/v1/messages",
    );
  });


  it("builds Anthropic URL for Bigmodel", () => {
    expect(buildUpstreamURL(BIGMODEL_ANTHROPIC_BASE)).toBe(
      "https://open.bigmodel.cn/api/anthropic/v1/messages",
    );
  });

});

describe("buildZcodeTraceHeaders", () => {
  it("emits ZCode trace headers in source order and strips internal prefixes", () => {
    const h = buildZcodeTraceHeaders({
      requestId: "req_1",
      traceId: "trace_1",
      queryId: "query_turn_1",
      sessionId: "sess_thread_1",
    });

    expect(Object.keys(h)).toEqual(["x-request-id", "x-zcode-session-type", "x-zcode-trace-id", "x-query-id", "x-session-id"]);
    expect(h["x-request-id"]).toBe("req_1");
    expect(h["x-zcode-session-type"]).toBe("main");
    expect(h["x-zcode-trace-id"]).toBe("trace_1");
    expect(h["x-query-id"]).toBe("turn_1");
    expect(h["x-session-id"]).toBe("thread_1");
  });

  it("strips subagent session prefixes at emission time", () => {
    const h = buildZcodeTraceHeaders({
      requestId: "req_1",
      traceId: "trace_1",
      sessionId: "subagent_agent_worker_1",
    });

    expect(Object.keys(h)).toEqual(["x-request-id", "x-zcode-session-type", "x-zcode-trace-id", "x-session-id"]);
    expect(h["x-zcode-session-type"]).toBe("subagent");
    expect(h["x-session-id"]).toBe("worker_1");
  });

  it("omits query and session headers when no IDs exist", () => {
    const h = buildZcodeTraceHeaders({ requestId: "req_1", traceId: "trace_1" });

    expect(Object.keys(h)).toEqual(["x-request-id", "x-zcode-session-type", "x-zcode-trace-id"]);
    expect(h["x-zcode-session-type"]).toBe("main");
    expect(h["x-query-id"]).toBeUndefined();
    expect(h["x-session-id"]).toBeUndefined();
  });
});
describe("buildAuthHeaders", () => {
  it("injects x-api-key + anthropic-version for Anthropic", () => {
    const h = buildAuthHeaders(ZAI_CRED, IDENTITY, "coding-plan");
    expect(h["x-api-key"]).toBe("testkey.testsecret");
    expect(h["anthropic-version"]).toBe("2023-06-01");
  });


  it("coding-plan anthropic: dual auth headers (x-api-key AND Authorization, same value — bundle ebo, CL-25)", () => {
    const h = buildAuthHeaders(ZAI_CRED, IDENTITY, "coding-plan");
    expect(h["x-api-key"]).toBe("testkey.testsecret");
    expect(h["authorization"]).toBe("Bearer testkey.testsecret");
  });

  it("start-plan anthropic: only Authorization Bearer jwt, no x-api-key", () => {
    const h = buildAuthHeaders({ ...ZAI_CRED, jwt: "jwt-token" }, IDENTITY, "start-plan");
    expect(h["authorization"]).toBe("Bearer jwt-token");
    expect(h["x-api-key"]).toBeUndefined();
    expect(h["anthropic-version"]).toBe("2023-06-01");
    // CL-26: the SDK UA suffix applies to BOTH plans' LLM path (bundle `Cm`).
    expect(h["User-Agent"]).toBe("ZCode/test-1.0.0 ai-sdk/anthropic/3.0.81");
  });

  it("uses apiKey only (no secret) for Bigmodel Anthropic", () => {
    const h = buildAuthHeaders(BIGMODEL_CRED, IDENTITY, "coding-plan");
    expect(h["x-api-key"]).toBe("bmkey");
    expect(h["anthropic-version"]).toBe("2023-06-01");
  });


  it("injects ZCode identity headers (User-Agent + companions + SDK suffix)", () => {
    const h = buildAuthHeaders(ZAI_CRED, IDENTITY, "coding-plan");
    // CL-26: bundle Cm/k0o merges the anthropic SDK identity into the UA.
    expect(h["User-Agent"]).toBe("ZCode/test-1.0.0 ai-sdk/anthropic/3.0.81");
    expect(h["X-ZCode-App-Version"]).toBe("test-1.0.0");
    expect(h["X-Title"]).toBe("Z Code@cli");
    expect(h["X-ZCode-Agent"]).toBe("glm");
    expect(h["HTTP-Referer"]).toBe("https://zcode.z.ai");
  });

  it("generates unique x-session-id per call (no shared singleton)", () => {
    const h1 = buildAuthHeaders(ZAI_CRED, IDENTITY, "coding-plan");
    const h2 = buildAuthHeaders(ZAI_CRED, IDENTITY, "coding-plan");
    expect(h1["x-session-id"]).toBeTruthy();
    expect(h2["x-session-id"]).toBeTruthy();
    expect(h1["x-session-id"]).not.toBe(h2["x-session-id"]);
  });

  it("generates unique x-request-id and x-zcode-trace-id per call", () => {
    const h1 = buildAuthHeaders(ZAI_CRED, IDENTITY, "coding-plan");
    const h2 = buildAuthHeaders(ZAI_CRED, IDENTITY, "coding-plan");
    expect(h1["x-request-id"]).not.toBe(h2["x-request-id"]);
    expect(h1["x-zcode-trace-id"]).not.toBe(h2["x-zcode-trace-id"]);
    expect(h1["x-query-id"]).not.toBe(h2["x-query-id"]);
  });

  it("uses a stable x-session-id when an enforced client session is provided", () => {
    const session = { action: "enforce" as const, upstreamSessionId: "11111111-1111-4111-8111-111111111111" };
    const h1 = buildAuthHeaders(ZAI_CRED, IDENTITY, "coding-plan", session);
    const h2 = buildAuthHeaders(ZAI_CRED, IDENTITY, "coding-plan", session);

    expect(h1["x-session-id"]).toBe("11111111-1111-4111-8111-111111111111");
    expect(h2["x-session-id"]).toBe("11111111-1111-4111-8111-111111111111");
    expect(h1["x-request-id"]).not.toBe(h2["x-request-id"]);
    expect(h1["x-zcode-trace-id"]).not.toBe(h2["x-zcode-trace-id"]);
    expect(h1["x-query-id"]).toBeUndefined();
    expect(h2["x-query-id"]).toBeUndefined();
  });

  it("emits explicit enforced trace headers in ZCode/auth order", () => {
    const session = {
      source: "explicit" as const,
      action: "enforce" as const,
      requestId: "req_1",
      traceId: "trace_1",
      queryId: "query_turn_1",
      upstreamSessionId: "sess_thread_1",
    };
    const h = buildAuthHeaders(ZAI_CRED, IDENTITY, "coding-plan", session);

    // Identity part mirrors the bundle's 3.12.3 LLM builder `g6n` (CL-27):
    // language/timezone always present, X-Release-Channel right after
    // X-Title, X-ZCode-Agent inline 8th (before platform headers), no
    // X-Device-Mid. Then trace headers, then auth (dual x-api-key +
    // Authorization for coding-plan, CL-25).
    expect(Object.keys(h)).toEqual([
      "HTTP-Referer",
      "User-Agent",
      "X-ZCode-App-Version",
      "X-Title",
      "X-Release-Channel",
      "X-Client-Language",
      "X-Client-Timezone",
      "X-ZCode-Agent",
      "X-Platform",
      "X-Os-Category",
      "X-Os-Version",
      "x-request-id",
      "x-zcode-session-type",
      "x-zcode-trace-id",
      "x-query-id",
      "x-session-id",
      "x-api-key",
      "authorization",
      "anthropic-version",
    ]);
    expect(h["x-request-id"]).toBe("req_1");
    expect(h["x-zcode-session-type"]).toBe("main");
    expect(h["x-zcode-trace-id"]).toBe("trace_1");
    expect(h["x-query-id"]).toBe("turn_1");
    expect(h["x-session-id"]).toBe("thread_1");
  });
  it("does not stabilize x-session-id for observe-only client sessions", () => {
    const session = { action: "observe" as const, upstreamSessionId: "11111111-1111-4111-8111-111111111111" };
    const h1 = buildAuthHeaders(ZAI_CRED, IDENTITY, "coding-plan", session);
    const h2 = buildAuthHeaders(ZAI_CRED, IDENTITY, "coding-plan", session);

    expect(h1["x-session-id"]).toBeTruthy();
    expect(h2["x-session-id"]).toBeTruthy();
    expect(h1["x-session-id"]).not.toBe(h2["x-session-id"]);
  });

  it("does not synthesize start-plan query/session headers when no trace context exists", () => {
    const h = buildAuthHeaders({ ...ZAI_CRED, jwt: "jwt-token" }, IDENTITY, "start-plan");

    expect(h["x-request-id"]).toBeTruthy();
    expect(h["x-zcode-trace-id"]).toBeTruthy();
    expect(h["x-query-id"]).toBeUndefined();
    expect(h["x-session-id"]).toBeUndefined();
  });

  it("does not forward inferred start-plan session in observe mode", () => {
    const session = {
      source: "lineage" as const,
      action: "observe" as const,
      upstreamSessionId: "11111111-1111-4111-8111-111111111111",
    };
    const h = buildAuthHeaders({ ...ZAI_CRED, jwt: "jwt-token" }, IDENTITY, "start-plan", session);

    expect(h["x-request-id"]).toBeTruthy();
    expect(h["x-zcode-trace-id"]).toBeTruthy();
    expect(h["x-session-id"]).toBeUndefined();
  });

  it("forwards inferred start-plan session in enforce mode", () => {
    const session = {
      source: "lineage" as const,
      action: "enforce" as const,
      upstreamSessionId: "11111111-1111-4111-8111-111111111111",
    };
    const h = buildAuthHeaders({ ...ZAI_CRED, jwt: "jwt-token" }, IDENTITY, "start-plan", session);

    expect(h["x-session-id"]).toBe("11111111-1111-4111-8111-111111111111");
  });

});

describe("sendOrderedUpstreamRequest", () => {
  it("writes application headers in the supplied wire order", async () => {
    const headers: Array<[string, string]> = [
      ["content-type", "application/json"],
      ["accept-encoding", "gzip"],
      ["HTTP-Referer", "https://zcode.z.ai"],
      ["User-Agent", "ZCode/test-1.0.0"],
      ["X-ZCode-App-Version", "test-1.0.0"],
      ["X-Title", "Z Code@cli"],
      ["X-ZCode-Agent", "glm"],
      ["x-request-id", "req_1"],
      ["x-zcode-trace-id", "trace_1"],
      ["x-query-id", "turn_1"],
      ["x-session-id", "thread_1"],
      ["x-api-key", "testkey.testsecret"],
      ["anthropic-version", "2023-06-01"],
    ];

    const { raw, response } = await captureOrderedRequest(headers);
    const requestHeaders = raw.split("\r\n\r\n")[0].split("\r\n").slice(1);
    const appHeaders = requestHeaders.filter((line) => !/^(Host|Content-Length|Connection):/i.test(line));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(appHeaders).toEqual(headers.map(([k, v]) => `${k}: ${v}`));
  });

  it("rejects invalid header names and CRLF header values before writing", async () => {
    await expect(sendOrderedUpstreamRequest({
      url: "http://127.0.0.1:9/v1/messages",
      method: "POST",
      headers: [["x-request-id", "req_1\r\nx-extra: injected"]],
      body: "{}",
    })).rejects.toThrow(/Invalid upstream header value/);

    await expect(sendOrderedUpstreamRequest({
      url: "http://127.0.0.1:9/v1/messages",
      method: "POST",
      headers: [["bad header", "value"]],
      body: "{}",
    })).rejects.toThrow(/Invalid upstream header name/);
  });
});
describe("buildUpstreamHeaderPairs — accept-encoding forwarding", () => {
  it("forwards the client's accept-encoding when present (e.g. identity)", () => {
    const req = makeClientReq("{}", { "accept-encoding": "identity" });
    const pairs = buildUpstreamHeaderPairs(req, ZAI_CRED, IDENTITY, "coding-plan");
    const ae = pairs.find(([k]) => k === "accept-encoding");
    expect(ae?.[1]).toBe("identity");
  });

  it("defaults to gzip when the client sent no accept-encoding", () => {
    const req = makeClientReq("{}");
    const pairs = buildUpstreamHeaderPairs(req, ZAI_CRED, IDENTITY, "coding-plan");
    const ae = pairs.find(([k]) => k === "accept-encoding");
    expect(ae?.[1]).toBe("gzip");
  });

  it("forwards multi-value accept-encoding verbatim", () => {
    const req = makeClientReq("{}", { "accept-encoding": "gzip, deflate, br" });
    const pairs = buildUpstreamHeaderPairs(req, ZAI_CRED, IDENTITY, "coding-plan");
    const ae = pairs.find(([k]) => k === "accept-encoding");
    expect(ae?.[1]).toBe("gzip, deflate, br");
  });
});

describe("buildUpstreamRequest", () => {
  it("constructs full Anthropic request with correct URL + headers", async () => {
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');
    const upstream = buildUpstreamRequest(clientReq, ZAI_ANTHROPIC_BASE, ZAI_CRED, '{"model":"glm-4.6","messages":[]}', IDENTITY, "coding-plan");

    expect(upstream.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(upstream.method).toBe("POST");
    expect(upstream.headers.get("x-api-key")).toBe("testkey.testsecret");
    expect(upstream.headers.get("authorization")).toBe("Bearer testkey.testsecret");
    expect(upstream.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(upstream.headers.get("content-type")).toBe("application/json");
    expect(upstream.headers.get("user-agent")).toBe("ZCode/test-1.0.0 ai-sdk/anthropic/3.0.81");

    const body = await upstream.text();
    expect(body).toBe('{"model":"glm-4.6","messages":[]}');
  });


  it("no longer copies anthropic-beta verbatim (filtered by policy)", () => {
    const clientReq = makeClientReq("{}", { "anthropic-beta": "prompt-caching-2024-07-31" });
    const upstream = buildUpstreamRequest(clientReq, ZAI_ANTHROPIC_BASE, ZAI_CRED, "{}", IDENTITY, "coding-plan");
    expect(upstream.headers.get("anthropic-beta")).toBeNull();
  });

  it("strips client Authorization header (prevents credential leak)", () => {
    const clientReq = makeClientReq("{}", { authorization: "Bearer client-token" });
    const upstream = buildUpstreamRequest(clientReq, ZAI_ANTHROPIC_BASE, ZAI_CRED, "{}", IDENTITY, "coding-plan");
    // Auth must be the injected credential, NOT the client's. Coding-plan
    // anthropic requests carry BOTH x-api-key and Authorization with the
    // same injected value (bundle ebo, CL-25).
    expect(upstream.headers.get("x-api-key")).toBe("testkey.testsecret");
    expect(upstream.headers.get("authorization")).toBe("Bearer testkey.testsecret");
    expect(upstream.headers.get("authorization")).not.toContain("client-token");
  });

});

/**
 * `anthropic-beta` is filtered by `identity.betaPolicy` instead of being
 * copied through. Request-header audit (`docs/research/request-header-audit.md`
 * 2.1): the official ZCode CLI sends no beta unless tool search is on, so `drop`
 * is the default, while Claude Code v2.1.319 puts a dozen on `/v1/messages`, two of
 * which name the client against a `User-Agent: ZCode/…`.
 */
describe("anthropic-beta policy", () => {
  /** The single beta the official ZCode client ever sends (tool-search path). */
  const TOOL_SEARCH_BETA = "advanced-tool-use-2025-11-20";
  /** Betas Claude Code v2.1.319 actually ships on `/v1/messages`. */
  const CLAUDE_CODE_BETAS = [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "context-1m-2025-08-07",
  ].join(", ");

  function withBetaPolicy(betaPolicy: BetaPolicy, betaAllowlist: string[] = []): ProxyIdentity {
    return { ...IDENTITY, betaPolicy, betaAllowlist };
  }

  /** The `anthropic-beta` value that would reach the wire, or `undefined`. */
  function betaValue(
    clientHeaders: Record<string, string>,
    betaPolicy: BetaPolicy,
    betaAllowlist: string[] = [],
  ): string | undefined {
    const pairs = buildUpstreamHeaderPairs(
      makeClientReq("{}", clientHeaders),
      ZAI_CRED,
      withBetaPolicy(betaPolicy, betaAllowlist),
      "coding-plan",
    );
    return pairs.find(([name]) => name === "anthropic-beta")?.[1];
  }

  it("drop (default): no anthropic-beta reaches the wire at all", () => {
    expect(betaValue({ "anthropic-beta": CLAUDE_CODE_BETAS }, "drop")).toBeUndefined();
  });

  it("drop stays authoritative even when an allowlist is configured", () => {
    // `betaAllowlist` is only consulted under `allowlist`; a leftover
    // list must not resurrect the header after switching back to `drop`.
    expect(betaValue({ "anthropic-beta": TOOL_SEARCH_BETA }, "drop", [TOOL_SEARCH_BETA])).toBeUndefined();
  });

  it("allowlist: keeps the listed value and drops the rest", () => {
    const value = betaValue(
      { "anthropic-beta": `${CLAUDE_CODE_BETAS}, ${TOOL_SEARCH_BETA}` },
      "allowlist",
      [TOOL_SEARCH_BETA],
    );
    expect(value).toBe(TOOL_SEARCH_BETA);
  });

  it("allowlist: values outside the list are dropped entirely (no empty header)", () => {
    expect(betaValue({ "anthropic-beta": CLAUDE_CODE_BETAS }, "allowlist", [TOOL_SEARCH_BETA])).toBeUndefined();
  });

  it("allowlist: multiple hits keep their original order", () => {
    const second = "mid-conversation-system-2026-04-07";
    const value = betaValue(
      { "anthropic-beta": `${TOOL_SEARCH_BETA}, ${second}` },
      "allowlist",
      [TOOL_SEARCH_BETA, second],
    );
    expect(value).toBe(`${TOOL_SEARCH_BETA},${second}`);
  });

  it("allowlist: value match is case-insensitive", () => {
    const value = betaValue({ "anthropic-beta": "Advanced-Tool-Use-2025-11-20" }, "allowlist", [TOOL_SEARCH_BETA]);
    expect(value?.toLowerCase()).toBe(TOOL_SEARCH_BETA);
  });

  it("allowlist: surrounding whitespace in the client value is trimmed, not matched", () => {
    expect(betaValue({ "anthropic-beta": `  ${TOOL_SEARCH_BETA}  ` }, "allowlist", [TOOL_SEARCH_BETA])).toBe(TOOL_SEARCH_BETA);
  });

  it("header name is case-insensitive: `Anthropic-Beta` is recognized", () => {
    expect(betaValue({ "Anthropic-Beta": TOOL_SEARCH_BETA }, "drop")).toBeUndefined();
    expect(betaValue({ "Anthropic-Beta": TOOL_SEARCH_BETA }, "allowlist", [TOOL_SEARCH_BETA])).toBe(TOOL_SEARCH_BETA);
  });

  it("header name is case-insensitive: `ANTHROPIC-BETA` is recognized", () => {
    expect(betaValue({ "ANTHROPIC-BETA": TOOL_SEARCH_BETA }, "drop")).toBeUndefined();
    expect(betaValue({ "ANTHROPIC-BETA": TOOL_SEARCH_BETA }, "allowlist", [TOOL_SEARCH_BETA])).toBe(TOOL_SEARCH_BETA);
  });

  it("empty / comma-only / space-only values never produce an empty header", () => {
    // A present-but-blank `anthropic-beta:` is itself a shape the official
    // client never emits, so the header must be absent, not empty.
    for (const blank of ["", ",", ",,", " ", "   ", " , ", ", ,"]) {
      expect(betaValue({ "anthropic-beta": blank }, "drop")).toBeUndefined();
      expect(betaValue({ "anthropic-beta": blank }, "allowlist", [TOOL_SEARCH_BETA])).toBeUndefined();
    }
  });

  it("omits the header when the client sent none", () => {
    expect(betaValue({}, "allowlist", [TOOL_SEARCH_BETA])).toBeUndefined();
  });

  it("full upstream request carries no client-identifying beta", () => {
    const clientReq = makeClientReq("{}", { "anthropic-beta": CLAUDE_CODE_BETAS });
    const upstream = buildUpstreamRequest(clientReq, ZAI_ANTHROPIC_BASE, ZAI_CRED, "{}", IDENTITY, "coding-plan");
    const wire = JSON.stringify([...upstream.headers.entries()]);
    expect(upstream.headers.get("anthropic-beta")).toBeNull();
    expect(wire).not.toContain("claude-code-20250219");
    expect(wire).not.toContain("oauth-2025-04-20");
  });
});

describe("proxyRequest", () => {
  const testConfig: ProxyConfig = {
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

  it("uses ordered transport for session-aware requests only outside injected fetch tests", () => {
    expect(shouldUseOrderedTransport({
      source: "lineage",
      action: "observe",
      confidence: 0.95,
      upstreamSessionId: "11111111-1111-4111-8111-111111111111",
    }, false)).toBe(false);
    expect(shouldUseOrderedTransport({
      source: "lineage",
      action: "enforce",
      confidence: 0.95,
      upstreamSessionId: "11111111-1111-4111-8111-111111111111",
    }, false)).toBe(true);
    expect(shouldUseOrderedTransport({
      source: "explicit",
      action: "observe",
      confidence: 1,
      upstreamSessionId: "sess_thread_1",
    }, false)).toBe(true);
    expect(shouldUseOrderedTransport({
      source: "explicit",
      action: "observe",
      confidence: 1,
      upstreamSessionId: "sess_thread_1",
    }, true)).toBe(false);
  });

  it("forwards request to the Anthropic upstream with injected auth (native passthrough)", async () => {
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      expect(req.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
      expect(req.headers.get("x-api-key")).toBe("testkey.testsecret");
      expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
      const reqBody = JSON.parse(await req.text());
      // metadata.user_id is the device/session blob (bundle UIo): the account
      // uuid is never transmitted, device_id is the leased account's own
      // fingerprint, and observe-mode clientIdentity may synthesize
      // a session, so only the deterministic parts are asserted.
      const uid = JSON.parse(reqBody.metadata.user_id);
      expect(uid.account_uuid).toBe("");
      expect(uid.device_id).toBe("test-device-mid");
      expect(typeof uid.session_id).toBe("string");
      return new Response(JSON.stringify({
        id: "msg_fwd",
        type: "message",
        role: "assistant",
        model: "glm-4.6",
        content: [{ type: "text", text: "Hello" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const broker = oauthBroker();
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, broker, fetchImpl: fetchMock as any });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.content[0].text).toBe("Hello");
  });

  it("passes the Anthropic SSE stream through natively for Anthropic clients", async () => {
    const sseBody = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"glm-4.6","content":[],"usage":{"input_tokens":10,"output_tokens":1}}}',
      '',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      '',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
      '',
      'event: message_stop\ndata: {"type":"message_stop"}',
      '',
    ].join("\n");

    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const broker = oauthBroker();
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[],"stream":true}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, broker, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");

    const text = await resp.text();
    expect(text).toContain("message_start");
    expect(text).toContain("text_delta");
    expect(text).toContain('"text":"Hi"');
    expect(text).toContain("message_stop");
  });

  it("passes the Anthropic batch response through with raw-decompress transport", async () => {
    const fetchMock = mock(async (_req: Request, init?: RequestInit & { decompress?: boolean }): Promise<Response> => {
      expect(init?.decompress).toBe(false);
      return new Response(JSON.stringify({
        id: "msg_fwd2",
        type: "message",
        role: "assistant",
        model: "glm-4.6",
        content: [{ type: "text", text: "Hello" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });

    const broker = oauthBroker();
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, broker, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/json");
    expect(resp.headers.get("content-encoding")).toBeNull();
    const body = await resp.json();
    expect(body.content[0].text).toBe("Hello");
  });

  it("returns 502 when upstream is unreachable", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    });

    const broker = oauthBroker();
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, broker, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error.type).toBe("upstream_unreachable");
    expect(body.error.message).toContain("ECONNREFUSED");
  });

  it("returns 503 when credential unavailable", async () => {
    const fetchMock = mock(async (): Promise<Response> => new Response("ok"));

    const broker = noAccountBroker();
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, broker, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    const body = await resp.json();
    expect(body.error.type).toBe("credential_unavailable");
  });

  it("forwards upstream error status codes through verbatim for native Anthropic clients", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"bad model"}}', {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });

    const broker = oauthBroker();
    const clientReq = makeClientReq('{"model":"bad-model","messages":[]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, broker, fetchImpl: fetchMock as any });

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("invalid_request_error");
  });
});

describe("proxyRequest — OpenAI translation mode (coding-plan → Anthropic upstream)", () => {
  const testConfig: ProxyConfig = {
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

  function makeOpenAIReq(body: string, headers: Record<string, string> = {}): Request {
    return new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  }

  const ANTHROPIC_RESPONSE = JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "glm-4.6",
    content: [{ type: "text", text: "Anthropic hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 3 },
  });

  it("routes OpenAI client request to the Anthropic upstream endpoint", async () => {
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      expect(req.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const broker = oauthBroker();
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    await proxyRequest(clientReq, "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses x-api-key + anthropic-version on the Anthropic upstream request", async () => {
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      expect(req.headers.get("x-api-key")).toBe("testkey.testsecret");
      // CL-25: the real client sends BOTH headers with the same credential
      // (bundle `ebo` injects Authorization alongside the SDK's x-api-key).
      expect(req.headers.get("authorization")).toBe("Bearer testkey.testsecret");
      expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const broker = oauthBroker();
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    await proxyRequest(clientReq, "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
  });

  it("sends a translated Anthropic body upstream (no stream_options concept)", async () => {
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      const body = await req.text();
      const parsed = JSON.parse(body);
      expect(parsed.model).toBe("glm-4.6");
      expect(parsed.messages[0].role).toBe("user");
      expect(parsed.messages[0].content[0].type).toBe("text");
      expect(parsed.messages[0].content[0].text).toBe("Hi");
      expect(parsed.stream_options).toBeUndefined();
      expect(parsed.system).toBeUndefined();
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const broker = oauthBroker();
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}],"stream":true}');

    await proxyRequest(clientReq, "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
  });

  it("translates the Anthropic batch response back to OpenAI shape", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const broker = oauthBroker();
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/json");
    const body = await resp.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("Anthropic hello");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage.total_tokens).toBe(13);
  });

  it("does not synthesize gzip when the client does not accept it", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const broker = oauthBroker();
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
    expect(resp.headers.get("content-encoding")).toBeNull();
    const body = await resp.json();
    expect(body.object).toBe("chat.completion");
  });

  it("translates the Anthropic SSE stream to OpenAI chunks", async () => {
    const sseBody = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"glm-4.6","content":[],"usage":{"input_tokens":10,"output_tokens":1}}}',
      '',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      '',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
      '',
      'event: message_stop\ndata: {"type":"message_stop"}',
      '',
    ].join("\n");

    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const broker = oauthBroker();
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[],"stream":true}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");

    const text = await resp.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("data: [DONE]");
  });

  it("forwards selected upstream headers in the translated batch response", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "req_abc123",
          "anthropic-ratelimit-requests-remaining": "99",
          "anthropic-ratelimit-tokens-reset": "2025-01-01T00:00:00Z",
        },
      });
    });

    const broker = oauthBroker();
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
    expect(resp.headers.get("x-request-id")).toBe("req_abc123");
    expect(resp.headers.get("anthropic-ratelimit-requests-remaining")).toBe("99");
    expect(resp.headers.get("anthropic-ratelimit-tokens-reset")).toBe("2025-01-01T00:00:00Z");
  });

  it("gzips the translated body when the client advertises gzip", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const broker = oauthBroker();
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}', { "accept-encoding": "gzip" });

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
    expect(resp.headers.get("content-encoding")).toBe("gzip");
  });

  it("does not propagate a stale upstream gzip label to the translated client response", async () => {
    // translate mode lets the runtime inflate; the mock simulates the
    // post-inflate state (decoded body, stale label) — the label must not
    // reach the OpenAI client
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response(ANTHROPIC_RESPONSE, {
        status: 200,
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      });
    });

    const broker = oauthBroker();
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
    expect(resp.headers.get("content-encoding")).toBeNull();
    const body = await resp.json();
    expect(body.object).toBe("chat.completion");
  });

  it("returns 400 for a malformed OpenAI body without calling upstream", async () => {
    const fetchMock = mock(async (): Promise<Response> => new Response("ok"));
    const broker = oauthBroker();
    const clientReq = makeOpenAIReq("not json");

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    const body = await resp.json();
    expect(body.error.type).toBe("translation_failed");
  });

  it("returns 502 when the upstream returns a non-JSON body", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response("not json", { status: 200, headers: { "content-type": "text/plain" } });
    });
    const broker = oauthBroker();
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error.type).toBe("translation_failed");
  });

  it("passes the REAL upstream status + body through for translated clients (issue #71: no 502 wrap)", async () => {
    const fetchMock = mock(async (): Promise<Response> => {
      return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"bad request"}}', { status: 400, headers: { "content-type": "application/json" } });
    });
    const broker = oauthBroker();
    const clientReq = makeOpenAIReq('{"model":"glm-4.6","messages":[]}');

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
    // Wrapping upstream 4xx/5xx as 502 made clients retry real rejections
    // (405/3012, 429) as transient faults — the status and body now pass
    // through verbatim so clients see the true error.
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });
});

describe("client gzip handling", () => {
  const ANTHROPIC_RESPONSE = JSON.stringify({
    id: "msg_gz",
    type: "message",
    role: "assistant",
    model: "glm-4.6",
    content: [{ type: "text", text: "Anthropic hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 8, output_tokens: 5 },
  });

  const testConfig: ProxyConfig = {
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

  const broker = oauthBroker();

  it("inflates gzip request bodies before forwarding upstream", async () => {
    const payload = '{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}';
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      const parsed = JSON.parse(await req.text());
      expect(parsed.model).toBe("glm-4.6");
      expect(parsed.messages[0].content[0].text).toBe("Hi");
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: gzipSync(new TextEncoder().encode(payload)),
    });

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await resp.json();
    expect(body.object).toBe("chat.completion");
  });

  it("returns 400 for a corrupt gzip request body without calling upstream", async () => {
    const fetchMock = mock(async (): Promise<Response> => new Response("{}"));

    const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: new Uint8Array([1, 2, 3, 4]),
    });

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    const body = await resp.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("gzip");
  });

  it("returns 413 when a gzip request body inflates past the ceiling", async () => {
    const fetchMock = mock(async (): Promise<Response> => new Response("{}"));

    // 65 MiB of zeros — tiny on the wire, 1 MiB past the 64 MiB inflated cap.
    const bomb = gzipSync(Buffer.alloc(65 * 1024 * 1024));
    const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: bomb,
    });

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(413);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    const body = await resp.json();
    expect(body.error.type).toBe("request_too_large");
  });

  it("forwards plain (uncompressed) request bodies translated", async () => {
    const payload = '{"model":"glm-4.6","messages":[]}';
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      const parsed = JSON.parse(await req.text());
      expect(parsed.model).toBe("glm-4.6");
      expect(parsed.messages).toEqual([]);
      return new Response(ANTHROPIC_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
    });

    const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });

    const resp = await proxyRequest(clientReq, "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(200);
  });
});

describe("proxyRequest — Anthropic compatibility mode (coding-plan)", () => {
  const testConfig: ProxyConfig = {
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

  it("Anthropic client request passes through to the native Anthropic upstream", async () => {
    const fetchMock = mock(async (req: Request, init?: RequestInit & { decompress?: boolean }): Promise<Response> => {
      expect(req.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
      expect(req.headers.get("x-api-key")).toBe("testkey.testsecret");
      expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
      expect(init?.decompress).toBe(false);
      const reqBody = JSON.parse(await req.text());
      expect(reqBody.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }]);
      return new Response(JSON.stringify({
        id: "msg_pt",
        type: "message",
        role: "assistant",
        model: "glm-4.6",
        content: [{ type: "text", text: "Hi" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const broker = oauthBroker();
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}');

    const resp = await proxyRequest(clientReq, "anthropic", { config: testConfig, broker, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.type).toBe("message");
    expect(body.content[0]).toEqual({ type: "text", text: "Hi" });
  });

  it("start-plan OpenAI request translates to the live Anthropic gateway (Bearer JWT)", async () => {
    const startPlanConfig: ProxyConfig = testConfig;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (req: Request | string): Promise<Response> => {
      const url = typeof req === "string" ? req : req.url;
      if (url.includes("/client/configs")) {
        return new Response(JSON.stringify({ data: { configs: { captcha: { enabled: false } } } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected global fetch in test: ${url}`);
    }) as typeof fetch;

    try {
      const fetchMock = mock(async (req: Request): Promise<Response> => {
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
        expect(req.headers.get("authorization")).toBe("Bearer jwt-mock");
        expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
        const reqBody = JSON.parse(await req.text());
        expect(reqBody.system[0].text).toBe("You are ZCode, an interactive agent");
        // start-plan carries the same device/session user_id blob (bundle E2e is plan-agnostic)
        const uid1 = JSON.parse(reqBody.metadata.user_id);
        expect(uid1.account_uuid).toBe("");
        expect(typeof uid1.session_id).toBe("string");
        expect(reqBody.messages).toHaveLength(2);
        expect(reqBody.messages[0].role).toBe("user");
        expect(reqBody.messages[0].content[0].text).toMatch(
          /^<system-reminder>Today's date is \d{4}-\d{2}-\d{2}\.<\/system-reminder>$/,
        );
        expect(reqBody.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] });
        // Catalog default (131,072) + default thinking budget 1,024, clamped
        // back to the model ceiling (bundle additive rule).
        expect(reqBody.max_tokens).toBe(131_072);
        return new Response(JSON.stringify({
          id: "msg_sp",
          type: "message",
          role: "assistant",
          model: "glm-4.6",
          content: [{ type: "text", text: "start-plan reply" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 3 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      });

      const broker = startPlanBroker();
      const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}',
      });

      const resp = await proxyRequest(clientReq, "openai", { config: startPlanConfig, broker, fetchImpl: fetchMock as any });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toBe("application/json");
      const body = await resp.json();
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0].message.content).toBe("start-plan reply");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("start-plan forwards explicit ZCode trace metadata to gateway attribution headers", async () => {
    const startPlanConfig: ProxyConfig = testConfig;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (req: Request | string): Promise<Response> => {
      const url = typeof req === "string" ? req : req.url;
      if (url.includes("/client/configs")) {
        return new Response(JSON.stringify({ data: { configs: { captcha: { enabled: false } } } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected global fetch in test: ${url}`);
    }) as typeof fetch;

    try {
      const fetchMock = mock(async (req: Request): Promise<Response> => {
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
        expect(req.headers.get("x-request-id")).toBe("req_start_1");
        expect(req.headers.get("x-zcode-trace-id")).toBe("trace_start_1");
        expect(req.headers.get("x-query-id")).toBe("start_query_1");
        expect(req.headers.get("x-session-id")).toBe("start_session_1");
        return new Response(JSON.stringify({
          id: "msg_sp",
          type: "message",
          role: "assistant",
          model: "glm-4.6",
          content: [{ type: "text", text: "start-plan reply" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 3 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      });

      const broker = startPlanBroker();
      const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "glm-4.6",
          metadata: {
            requestId: "req_start_1",
            traceId: "trace_start_1",
            queryId: "query_start_query_1",
            sessionId: "sess_start_session_1",
          },
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      const resp = await proxyRequest(clientReq, "openai", { config: startPlanConfig, broker, fetchImpl: fetchMock as any });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(resp.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("start-plan enforce reuses inferred session through the unified resolver", async () => {
    const startPlanConfig: ProxyConfig = {
      ...testConfig,
      clientIdentity: { mode: "enforce", ttlSeconds: 900, maxSessions: 1024 },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (req: Request | string): Promise<Response> => {
      const url = typeof req === "string" ? req : req.url;
      if (url.includes("/client/configs")) {
        return new Response(JSON.stringify({ data: { configs: { captcha: { enabled: false } } } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected global fetch in test: ${url}`);
    }) as typeof fetch;

    try {
      const seenSessions: string[] = [];
      const fetchMock = mock(async (req: Request): Promise<Response> => {
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
        seenSessions.push(req.headers.get("x-session-id") ?? "");
        return new Response(JSON.stringify({
          id: "msg_sp",
          type: "message",
          role: "assistant",
          model: "glm-4.6",
          content: [{ type: "text", text: "start-plan reply" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 3 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      });

      const broker = startPlanBroker();
      const body = '{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}';

      const first = await proxyRequest(new Request("http://localhost:8080/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }), "openai", { config: startPlanConfig, broker, fetchImpl: fetchMock as any });
      const second = await proxyRequest(new Request("http://localhost:8080/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }), "openai", { config: startPlanConfig, broker, fetchImpl: fetchMock as any });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(seenSessions[0]).toBeTruthy();
      expect(seenSessions[1]).toBe(seenSessions[0]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("start-plan Anthropic request passes through to the live gateway with start-plan system blocks", async () => {
    const startPlanConfig: ProxyConfig = testConfig;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (req: RequestInfo | URL): Promise<Response> => {
      const url = typeof req === "string" ? req : req instanceof URL ? req.toString() : req.url;
      if (url.includes("/client/configs")) {
        return new Response(JSON.stringify({ data: { configs: { captcha: { enabled: false } } } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected global fetch in test: ${url}`);
    }, { preconnect: originalFetch.preconnect });

    try {
      const fetchMock: typeof fetch = Object.assign(async (req: RequestInfo | URL): Promise<Response> => {
        if (!(req instanceof Request)) throw new Error("expected Request");
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
        expect(req.headers.get("authorization")).toBe("Bearer jwt-mock");
        const reqBody = JSON.parse(await req.text());
        expect(reqBody.system[0].text).toBe("You are ZCode, an interactive agent");
        const uid2 = JSON.parse(reqBody.metadata.user_id);
        expect(uid2.account_uuid).toBe("");
        expect(typeof uid2.session_id).toBe("string");
        expect(reqBody.messages).toHaveLength(2);
        expect(reqBody.messages[0].role).toBe("user");
        expect(reqBody.messages[0].content[0].text).toMatch(
          /^<system-reminder>Today's date is \d{4}-\d{2}-\d{2}\.<\/system-reminder>$/,
        );
        expect(reqBody.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] });
        expect(reqBody.max_tokens).toBe(1024);
        return new Response(JSON.stringify({
          id: "msg_sp",
          type: "message",
          role: "assistant",
          model: "glm-4.6",
          content: [{ type: "text", text: "start-plan reply" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 3 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }, { preconnect: originalFetch.preconnect });

      const broker = startPlanBroker();
      const clientReq = new Request("http://localhost:8080/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"glm-4.6","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}',
      });

      const resp = await proxyRequest(clientReq, "anthropic", { config: startPlanConfig, broker, fetchImpl: fetchMock });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.type).toBe("message");
      expect(body.content[0].text).toBe("start-plan reply");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not re-solve captcha for a start-plan 403 without captcha challenge header", async () => {
    const startPlanConfig: ProxyConfig = testConfig;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (req: Request | string): Promise<Response> => {
      const url = typeof req === "string" ? req : req.url;
      if (url.includes("/client/configs")) {
        return new Response(JSON.stringify({ data: { configs: { captcha: { enabled: false } } } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected global fetch in test: ${url}`);
    }) as typeof fetch;

    try {
      const fetchMock = mock(async (): Promise<Response> => {
        return new Response(JSON.stringify({ error: { type: "forbidden", message: "not captcha" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      });

      const broker = startPlanBroker();
      const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model":"glm-4.6","messages":[{"role":"user","content":"hi"}]}',
      });

      const resp = await proxyRequest(clientReq, "openai", { config: startPlanConfig, broker, fetchImpl: fetchMock as any });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The REAL upstream status + body pass through (issue #71): no 502
      // wrapping, so a genuine 403 is not mistaken for a transient fault.
      expect(resp.status).toBe(403);
      const body = await resp.json();
      expect(body.error.type).toBe("forbidden");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("proxyRequest — tool-call roundtrip (OpenAI client → Anthropic upstream)", () => {
  const testConfig: ProxyConfig = {
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

  function makeOpenAIReq(body: string): Request {
    return new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

  it("passes a full tool-call roundtrip through the Anthropic translation layer", async () => {
    let upstreamBody2: string | undefined;
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      const bodyText = await req.text();
      const parsed = JSON.parse(bodyText) as { messages: Array<{ role: string; content: unknown }> };

      const hasToolResultInHistory = parsed.messages.some(
        (m) => Array.isArray(m.content) && m.content.some((b: any) => b?.type === "tool_result"),
      );

      if (!hasToolResultInHistory) {
        return new Response(JSON.stringify({
          id: "msg_tool_1",
          type: "message",
          role: "assistant",
          model: "glm-4.6",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "call_xyz", name: "get_weather", input: { city: "SF" } },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 8 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      upstreamBody2 = bodyText;
      return new Response(JSON.stringify({
        id: "msg_final",
        type: "message",
        role: "assistant",
        model: "glm-4.6",
        content: [{ type: "text", text: "It's 62°F in SF." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 25, output_tokens: 6 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const broker = oauthBroker();

    const req1Body = JSON.stringify({
      model: "glm-4.6",
      messages: [{ role: "user", content: "What's the weather in SF?" }],
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
      tool_choice: "auto",
    });
    const resp1 = await proxyRequest(makeOpenAIReq(req1Body), "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
    expect(resp1.status).toBe(200);
    const resp1Body = await resp1.json();
    expect(resp1Body.choices[0].finish_reason).toBe("tool_calls");
    const toolCall = resp1Body.choices[0].message.tool_calls?.[0];
    expect(toolCall).toBeDefined();
    expect(toolCall.id).toBe("call_xyz");
    expect(toolCall.function.name).toBe("get_weather");
    expect(JSON.parse(toolCall.function.arguments)).toEqual({ city: "SF" });

    const req2Body = JSON.stringify({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "What's the weather in SF?" },
        { role: "assistant", content: null, tool_calls: [toolCall] },
        { role: "tool", tool_call_id: toolCall.id, content: "62°F and sunny" },
      ],
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
    });
    const resp2 = await proxyRequest(makeOpenAIReq(req2Body), "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
    expect(resp2.status).toBe(200);
    const resp2Body = await resp2.json();
    expect(resp2Body.choices[0].message.content).toBe("It's 62°F in SF.");
    expect(resp2Body.choices[0].finish_reason).toBe("stop");

    expect(upstreamBody2).toBeDefined();
    const upstreamReq = JSON.parse(upstreamBody2!);
    expect(upstreamReq.messages).toHaveLength(3);
    expect(upstreamReq.messages[0].role).toBe("user");
    expect(upstreamReq.messages[1].role).toBe("assistant");
    expect(upstreamReq.messages[1].content.some((b: any) => b.type === "tool_use" && b.id === "call_xyz")).toBeTrue();
    const toolResultMsg = upstreamReq.messages[2];
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content.some((b: any) => b.type === "tool_result" && b.tool_use_id === "call_xyz" && b.content === "62°F and sunny")).toBeTrue();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces parallel OpenAI tool results into one user tool_result message upstream", async () => {
    let upstreamBody: string | undefined;
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      upstreamBody = await req.text();
      return new Response(JSON.stringify({
        id: "msg_done",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "glm-4.6",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const broker = oauthBroker();

    const body = JSON.stringify({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "weather in SF and NYC" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "w", arguments: '{"city":"SF"}' } },
            { id: "call_b", type: "function", function: { name: "w", arguments: '{"city":"NYC"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_a", content: "62°F" },
        { role: "tool", tool_call_id: "call_b", content: "58°F" },
      ],
    });

    const resp = await proxyRequest(makeOpenAIReq(body), "openai", { config: testConfig, broker, fetchImpl: fetchMock as any });
    expect(resp.status).toBe(200);

    const upstreamReq = JSON.parse(upstreamBody!);
    expect(upstreamReq.messages).toHaveLength(3);
    const assistantMsg = upstreamReq.messages[1];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content.filter((b: any) => b.type === "tool_use").map((b: any) => b.id)).toEqual(["call_a", "call_b"]);
    const toolResultMsg = upstreamReq.messages[2];
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content.filter((b: any) => b.type === "tool_result").map((b: any) => b.tool_use_id)).toEqual(["call_a", "call_b"]);
  });
});

describe("proxyRequest — thinking endpoint matrix", () => {
  const testConfig: ProxyConfig = {
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

  function makeOpenAIReq(stream: boolean): Request {
    return new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-4.6",
        messages: [{ role: "user", content: "think then answer" }],
        stream,
      }),
    });
  }

  function makeAnthropicReq(stream: boolean): Request {
    return new Request("http://localhost:8080/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-4.6",
        max_tokens: 1024,
        messages: [{ role: "user", content: "think then answer" }],
        stream,
      }),
    });
  }

  function codingPlanBroker() {
    return oauthBroker();
  }

  function startPlanBrokerLocal() {
    return startPlanBroker();
  }

  async function withDisabledCaptcha<T>(run: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (req: Request | string): Promise<Response> => {
      const url = typeof req === "string" ? req : req.url;
      if (url.includes("/client/configs")) {
        return new Response(JSON.stringify({ data: { configs: { captcha: { enabled: false } } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected global fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  function anthropicThinkingResponse(): string {
    return JSON.stringify({
      id: "msg_thinking",
      type: "message",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "First step. Second step.", signature: "sig_real" },
        { type: "text", text: "Final answer." },
      ],
      model: "glm-4.6",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 7 },
    });
  }


  function anthropicThinkingSse(): string {
    return [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_thinking","type":"message","role":"assistant","content":[],"model":"glm-4.6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"First step. "}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Second step."}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_real"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Final answer."}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":1}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":7}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join("\n");
  }


  function openAIReasoningDeltas(sse: string): string[] {
    return sse
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)))
      .map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content)
      .filter((text): text is string => typeof text === "string");
  }

  function anthropicEvents(sse: string): Array<{ event: string; data: any }> {
    return sse
      .split("\n\n")
      .map((block) => {
        const lines = block.trim().split("\n").filter(Boolean);
        const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
        const dataLine = lines.find((line) => line.startsWith("data: "));
        if (!dataLine) return null;
        return { event, data: JSON.parse(dataLine.slice(6)) };
      })
      .filter((event): event is { event: string; data: any } => event !== null);
  }

  it("coding-plan Anthropic upstream non-streaming surfaces thinking as OpenAI reasoning_content", async () => {
    let upstreamUrl = "";
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      upstreamUrl = req.url;
      return new Response(anthropicThinkingResponse(), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const resp = await proxyRequest(makeOpenAIReq(false), "openai", {
      config: testConfig,
      broker: codingPlanBroker(),
      fetchImpl: fetchMock as any,
    });

    expect(upstreamUrl).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.choices[0].message.reasoning_content).toBe("First step. Second step.");
    expect(body.choices[0].message.content).toBe("Final answer.");
  });

  it("coding-plan Anthropic upstream streaming surfaces thinking as reasoning_content deltas", async () => {
    let upstreamUrl = "";
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      upstreamUrl = req.url;
      return new Response(anthropicThinkingSse(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const resp = await proxyRequest(makeOpenAIReq(true), "openai", {
      config: testConfig,
      broker: codingPlanBroker(),
      fetchImpl: fetchMock as any,
    });

    expect(upstreamUrl).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(openAIReasoningDeltas(text)).toEqual(["First step. ", "Second step."]);
    expect(text).toContain('"content":"Final answer."');
  });

  it("coding-plan Anthropic client non-streaming passes thinking blocks through natively", async () => {
    let upstreamUrl = "";
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      upstreamUrl = req.url;
      return new Response(anthropicThinkingResponse(), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const resp = await proxyRequest(makeAnthropicReq(false), "anthropic", {
      config: testConfig,
      broker: codingPlanBroker(),
      fetchImpl: fetchMock as any,
    });

    expect(upstreamUrl).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.content[0]).toEqual({ type: "thinking", thinking: "First step. Second step.", signature: "sig_real" });
    expect(body.content[1]).toEqual({ type: "text", text: "Final answer." });
  });

  it("coding-plan Anthropic client streaming passes thinking deltas through natively", async () => {
    let upstreamUrl = "";
    const fetchMock = mock(async (req: Request): Promise<Response> => {
      upstreamUrl = req.url;
      return new Response(anthropicThinkingSse(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const resp = await proxyRequest(makeAnthropicReq(true), "anthropic", {
      config: testConfig,
      broker: codingPlanBroker(),
      fetchImpl: fetchMock as any,
    });

    expect(upstreamUrl).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toContain('"type":"thinking_delta"');
    expect(text).toContain('"thinking":"First step. "');
    expect(text).toContain('"text":"Final answer."');
  });

  it("start-plan OpenAI endpoint non-streaming surfaces Anthropic upstream thinking as OpenAI reasoning_content", async () => {
    await withDisabledCaptcha(async () => {
      const fetchMock = mock(async (req: Request): Promise<Response> => {
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
        return new Response(anthropicThinkingResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const resp = await proxyRequest(makeOpenAIReq(false), "openai", {
        config: testConfig,
        broker: startPlanBrokerLocal(),
        fetchImpl: fetchMock as any,
      });

      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.choices[0].message.reasoning_content).toBe("First step. Second step.");
      expect(body.choices[0].message.content).toBe("Final answer.");
    });
  });

  it("start-plan OpenAI endpoint streaming surfaces Anthropic upstream thinking deltas as reasoning_content", async () => {
    await withDisabledCaptcha(async () => {
      const fetchMock = mock(async (req: Request): Promise<Response> => {
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
        return new Response(anthropicThinkingSse(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });

      const resp = await proxyRequest(makeOpenAIReq(true), "openai", {
        config: testConfig,
        broker: startPlanBrokerLocal(),
        fetchImpl: fetchMock as any,
      });

      expect(resp.status).toBe(200);
      expect(openAIReasoningDeltas(await resp.text())).toEqual(["First step. ", "Second step."]);
    });
  });

  it("start-plan Anthropic endpoint passes Anthropic upstream thinking through natively (non-streaming)", async () => {
    await withDisabledCaptcha(async () => {
      const fetchMock = mock(async (req: Request): Promise<Response> => {
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
        return new Response(anthropicThinkingResponse(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const resp = await proxyRequest(makeAnthropicReq(false), "anthropic", {
        config: testConfig,
        broker: startPlanBrokerLocal(),
        fetchImpl: fetchMock as any,
      });

      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.content[0]).toEqual({ type: "thinking", thinking: "First step. Second step.", signature: "sig_real" });
      expect(body.content[1]).toEqual({ type: "text", text: "Final answer." });
    });
  });

  it("start-plan Anthropic endpoint passes Anthropic upstream thinking through natively (streaming)", async () => {
    await withDisabledCaptcha(async () => {
      const fetchMock = mock(async (req: Request): Promise<Response> => {
        expect(req.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
        return new Response(anthropicThinkingSse(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });

      const resp = await proxyRequest(makeAnthropicReq(true), "anthropic", {
        config: testConfig,
        broker: startPlanBrokerLocal(),
        fetchImpl: fetchMock as any,
      });

      expect(resp.status).toBe(200);
      const events = anthropicEvents(await resp.text());
      const thinkingStarts = events.filter((e) =>
        e.event === "content_block_start" && e.data.content_block?.type === "thinking"
      );
      const thinkingDeltas = events.filter((e) => e.data.delta?.type === "thinking_delta");

      expect(thinkingStarts).toHaveLength(1);
      expect(thinkingStarts[0].data).toEqual({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      expect(thinkingDeltas.map((e) => e.data.index)).toEqual([0, 0]);
      expect(thinkingDeltas.map((e) => e.data.delta.thinking)).toEqual(["First step. ", "Second step."]);
    });
  });
});

describe("errorResponse", () => {
  it("builds JSON error with correct status", () => {
    const resp = errorResponse(401, "auth_error", "Invalid API key");
    expect(resp.status).toBe(401);
    expect(resp.headers.get("content-type")).toBe("application/json");
  });
});
