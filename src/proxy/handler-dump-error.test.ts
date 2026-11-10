/**
 * dump 记录上游错误响应体。
 *
 * 这些用例走真实的 `proxyRequest`，把 `ZCODE_DUMP_UPSTREAM` 指到临时文件再读回来。
 * 为什么值得端到端跑一遍：`clone()` 的时机是这里唯一容易写错的地方。读早了原响应
 * 还会被消耗，读晚了（`tee()` 之后）会抛 `TypeError`。写错了客户端会收到空响应，
 * 而「dump 里有错误体」的断言照样会过，所以最后那条「客户端仍拿到完整响应体」
 * 才是回归的关键。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerFor } from "../accounts/testing.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { UPSTREAM_ERROR_BODY_LIMIT } from "./dump.js";
import { proxyRequest } from "./handler.js";

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

function oauthBroker() {
  return brokerFor({
    kind: "zhipu-account",
    provider: "zai",
    apiKey: "testkey",
    secret: "testsecret",
    identity: { targetType: "PERSONAL", deviceMid: "test-device-mid" },
  }).broker;
}

function makeClientReq(body = '{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}'): Request {
  return new Request("http://localhost:8080/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function mockFetch(impl: (req: Request) => Promise<Response>): typeof fetch {
  return Object.assign(impl, { preconnect: () => {} }) as typeof fetch;
}

function anthropicError(message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message } }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

let dumpDir: string;
let dumpFile: string;

/** 读 dump 文件，按 phase 过滤（文件不存在就是没有 dump 行）。 */
function dumpLines(phase?: string): Array<Record<string, unknown>> {
  let raw: string;
  try {
    raw = readFileSync(dumpFile, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return phase ? lines.filter((line) => line.phase === phase) : lines;
}

beforeEach(() => {
  dumpDir = mkdtempSync(join(tmpdir(), "zcode-dump-"));
  dumpFile = join(dumpDir, "dump.jsonl");
  process.env.ZCODE_DUMP_UPSTREAM = dumpFile;
});

afterEach(() => {
  delete process.env.ZCODE_DUMP_UPSTREAM;
  rmSync(dumpDir, { recursive: true, force: true });
});

describe("upstream error body dump", () => {
  it("dumps the 500 body so the failure can explain itself", async () => {
    const resp = await proxyRequest(makeClientReq(), "anthropic", {
      config: TEST_CONFIG,
      broker: oauthBroker(),
      fetchImpl: mockFetch(async () => anthropicError("ascii codec can't encode character")),
    });

    expect(resp.status).toBe(500);
    const [line] = dumpLines("upstream-error-body");
    expect(line).toBeDefined();
    expect(line.status).toBe(500);
    expect(JSON.stringify(line.body)).toContain("ascii codec can't encode character");
  });

  it("leaves the original response untouched, so the client still gets the full body", async () => {
    const upstreamBody = JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } });
    const resp = await proxyRequest(makeClientReq(), "anthropic", {
      config: TEST_CONFIG,
      broker: oauthBroker(),
      fetchImpl: mockFetch(async () => new Response(upstreamBody, {
        status: 500,
        headers: { "content-type": "application/json" },
      })),
    });

    // 这条用例挡的是「实现改成直接读原响应」：那时 dump 照样有内容，客户端却是空的。
    expect(await resp.text()).toBe(upstreamBody);
    expect(dumpLines("upstream-error-body")).toHaveLength(1);
  });

  it("does not dump a successful response body", async () => {
    const okBody = JSON.stringify({
      id: "msg_dump",
      type: "message",
      role: "assistant",
      model: "glm-4.6",
      content: [{ type: "text", text: "Hi" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const resp = await proxyRequest(makeClientReq(), "anthropic", {
      config: TEST_CONFIG,
      broker: oauthBroker(),
      fetchImpl: mockFetch(async () => new Response(okBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      })),
    });

    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe(okBody);
    expect(dumpLines("upstream-resp")).toHaveLength(1);
    expect(dumpLines("upstream-error-body")).toHaveLength(0);
  });

  it("skips the body on an SSE failure to avoid buffering the stream", async () => {
    const resp = await proxyRequest(makeClientReq(), "anthropic", {
      config: TEST_CONFIG,
      broker: oauthBroker(),
      fetchImpl: mockFetch(async () => new Response("event: error\ndata: {}\n\n", {
        status: 500,
        headers: { "content-type": "text/event-stream" },
      })),
    });

    expect(resp.status).toBe(500);
    await resp.text();
    expect(dumpLines("upstream-resp")).toHaveLength(1);
    expect(dumpLines("upstream-error-body")).toHaveLength(0);
  });

  it("truncates an oversized error body at the limit", async () => {
    const long = "e".repeat(UPSTREAM_ERROR_BODY_LIMIT + 500);
    const resp = await proxyRequest(makeClientReq(), "anthropic", {
      config: TEST_CONFIG,
      broker: oauthBroker(),
      fetchImpl: mockFetch(async () => new Response(long, {
        status: 500,
        headers: { "content-type": "text/plain" },
      })),
    });

    expect(await resp.text()).toBe(long);
    const [line] = dumpLines("upstream-error-body");
    expect(line.body).toBe(`${"e".repeat(UPSTREAM_ERROR_BODY_LIMIT)}…(${long.length} bytes total)`);
  });

  it("redacts credentials echoed back inside the error body", async () => {
    const secret = `sk-${"b".repeat(32)}`;
    const resp = await proxyRequest(makeClientReq(), "anthropic", {
      config: TEST_CONFIG,
      broker: oauthBroker(),
      fetchImpl: mockFetch(async () => anthropicError(`rejected key ${secret}; header was Bearer top.secret.token`)),
    });

    expect(resp.status).toBe(500);
    const dumped = JSON.stringify(dumpLines("upstream-error-body"));
    expect(dumped).toContain("sk-<redacted>");
    expect(dumped).toContain("Bearer <redacted>");
    expect(dumped).not.toContain(secret);
    expect(dumped).not.toContain("top.secret.token");
  });
});
