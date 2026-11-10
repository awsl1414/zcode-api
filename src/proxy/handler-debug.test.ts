/**
 * `debug` 开关与请求链路阶段打点的用例。
 *
 * 两件事分开管：
 *
 *   阶段时间线  跟着 `logging.level` 走。走 `debug` 级，所以测试把级别抬到 `debug`。
 *   冗长诊断    URL 列表、请求头、body 预览、响应头仍然只认 `serve debug`，因为它们
 *              的体积与请求数成正比，不该由级别一把打开。
 *
 * logger 写 `process.stdout/stderr` 而不是 `console`（那样面板的 console tee 会把同一
 * 行记两遍），所以这里捕获的是注入的 sink，不是 `console.log`。
 */
import { describe, it, expect } from "bun:test";
import { proxyRequest } from "./handler.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { brokerFor } from "../accounts/testing.js";
import { configureLogging, resetLogging } from "../log/index.js";
import type { LogLevel } from "../log/types.js";
import { RequestStore } from "./request-record.js";
import type { RequestRecord } from "./request-record.js";

/**
 * Broker backed by an in-memory coding-plan account (replaces the removed
 * `AuthManager`: 5.0 resolves credentials through `broker.acquire()`).
 */
function oauthBroker(key = "testkey.testsecret") {
  const [apiKey, secret] = key.split(".");
  return brokerFor({
    kind: "zhipu-account",
    provider: "zai",
    apiKey,
    ...(secret ? { secret } : {}),
    identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
  }).broker;
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

function makeClientReq(body: string): Request {
  return new Request("http://localhost:8080/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function mockFetch(impl: (req: Request) => Promise<Response>): typeof fetch {
  return Object.assign(impl, { preconnect: () => {} }) as typeof fetch;
}

/**
 * 跑一段请求，收集 logger 的输出行。
 *
 * 默认级别 `debug`（阶段打点就在这一档）；级别过滤的用例自己传 `info`。
 * `resetLogging` 放在 `finally`：`bun test` 同进程跑所有文件，漏还原会让后面的用例
 * 按上一个级别输出（或者全静音）。
 */
async function captureLogs(fn: () => Promise<void>, level: LogLevel = "debug"): Promise<string[]> {
  const lines: string[] = [];
  configureLogging({ level, write: (line) => { lines.push(line); } });
  try {
    await fn();
  } finally {
    resetLogging();
  }
  return lines;
}

function openaiOk(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_debug",
      object: "chat.completion",
      model: "glm-4.6",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hi" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function anthropicOk(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_debug",
      type: "message",
      role: "assistant",
      model: "glm-4.6",
      content: [{ type: "text", text: "Hi" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("proxyRequest debug mode", () => {
  /** 跑一段请求，拿它落进 store 的那一条记录（阶段就在记录里）。*/
  function recordOf(store: RequestStore, reqId?: string): RequestRecord {
    const record = reqId ? store.get(reqId) : store.recent(1)[0];
    if (!record) throw new Error("请求没有落进 RequestStore");
    return record;
  }

  it("records the stage timeline on the request record", async () => {
    const broker = oauthBroker();
    const requests = new RequestStore();
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}');

    await captureLogs(async () => {
      const resp = await proxyRequest(clientReq, "anthropic", {
        config: TEST_CONFIG,
        broker,
        requests,
        fetchImpl: mockFetch(async () => anthropicOk()),
      });
      expect(resp.status).toBe(200);
    });

    // 阶段顺序就是时间线的顺序：intake → dispatch → session → route-facts → body
    // → highspeed → upstream-req → upstream-resp。
    const record = recordOf(requests);
    expect(record.stages.map((stage) => stage.stage)).toEqual([
      "intake",
      "dispatch",
      "session",
      "route-facts",
      "body",
      "highspeed",
      "upstream-req",
      "upstream-resp",
    ]);
    expect(record.upstreamUrl).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(record.status).toBe(200);
    expect(record.account).toBeTruthy();
    expect(record.route).toBe("coding-plan");
  });

  it("keeps the bulky header dump behind `debug: true`", async () => {
    const broker = oauthBroker();
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const lines = await captureLogs(async () => {
      await proxyRequest(clientReq, "anthropic", {
        config: TEST_CONFIG,
        broker,
        debug: true,
        fetchImpl: mockFetch(async () => anthropicOk()),
      });
    });

    const headerLine = lines.find((line) => line.includes("upstream request headers") && line.includes("x-api-key="));
    expect(headerLine).toBeDefined();
    expect(headerLine!).not.toContain("testkey.testsecret");
  });

  it("omits the header dump when `debug` is off, without dropping the timeline", async () => {
    const broker = oauthBroker();
    const requests = new RequestStore();
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const lines = await captureLogs(async () => {
      await proxyRequest(clientReq, "anthropic", {
        config: TEST_CONFIG,
        broker,
        requests,
        fetchImpl: mockFetch(async () => openaiOk()),
      });
    });

    expect(lines.some((line) => line.includes("upstream request headers"))).toBe(false);
    expect(recordOf(requests).stages.some((stage) => stage.stage === "upstream-req")).toBe(true);
  });

  it("keeps stages off the log stream at every level (they live on the record)", async () => {
    const broker = oauthBroker();
    const requests = new RequestStore();
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const lines = await captureLogs(async () => {
      await proxyRequest(clientReq, "anthropic", {
        config: TEST_CONFIG,
        broker,
        requests,
        fetchImpl: mockFetch(async () => openaiOk()),
      });
    }, "info");

    // 请求阶段不走 logger，所以日志里一条 `stage=` 都没有（级不级别都一样），
    // 而记录里那几条阶段照旧齐全。
    expect(lines.some((line) => line.includes("stage="))).toBe(false);
    expect(recordOf(requests).stages.length).toBeGreaterThan(0);
  });

  it("reports an upstream connect failure as the `upstream-req` failure stage", async () => {
    const broker = oauthBroker();
    const requests = new RequestStore();
    const clientReq = makeClientReq('{"model":"glm-4.6","messages":[]}');

    const lines = await captureLogs(async () => {
      const resp = await proxyRequest(clientReq, "anthropic", {
        config: TEST_CONFIG,
        broker,
        requests,
        fetchImpl: mockFetch(async () => { throw new Error("ECONNREFUSED"); }),
      });
      expect(resp.status).toBe(502);
    });

    // 失败是 `error` 级，所以在 `info` 阈值下也看得见（这才是「生产环境能看到」）；
    // 结构化的那一半在记录上，给汇总表按阶段筛失败用。
    expect(lines.some((line) => line.includes("ERROR [proxy] error") && line.includes("kind=upstream_unreachable"))).toBe(true);
    const record = recordOf(requests);
    expect(record.failedStage).toBe("upstream-req");
    expect(record.error).toContain("ECONNREFUSED");
    expect(record.status).toBe(502);
  });

  it("notes the OpenAI→Anthropic canonicalization for OpenAI clients", async () => {
    const broker = oauthBroker();
    const requests = new RequestStore();
    const clientReq = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-4.6",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    const lines = await captureLogs(async () => {
      await proxyRequest(clientReq, "openai", {
        config: TEST_CONFIG,
        broker,
        debug: true,
        requests,
        fetchImpl: mockFetch(async () => anthropicOk()),
      });
    });

    expect(lines.some((line) => line.includes("openai→anthropic canonical"))).toBe(true);
    expect(lines.some((line) => line.includes("stage="))).toBe(false);
    expect(recordOf(requests).upstreamUrl).toBe("https://api.z.ai/api/anthropic/v1/messages");
  });

  it("emits observe-only client identity inference without stabilizing x-session-id", async () => {
    const broker = oauthBroker();
    const requests = new RequestStore();
    const body = '{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}';
    const seenSessions: string[] = [];

    await captureLogs(async () => {
      for (let i = 0; i < 2; i++) {
        const resp = await proxyRequest(makeClientReq(body), "anthropic", {
          config: TEST_CONFIG,
          broker,
          requests,
          fetchImpl: mockFetch(async (req) => {
            seenSessions.push(req.headers.get("x-session-id") ?? "");
            return openaiOk();
          }),
        });
        expect(resp.status).toBe(200);
      }
    });

    const sessionStages = requests.recent(2).map((record) => record.stages.find((stage) => stage.stage === "session"));
    expect(sessionStages.every((stage) => stage?.fields.source === "lineage")).toBe(true);
    expect(seenSessions[0]).toBeTruthy();
    expect(seenSessions[1]).toBeTruthy();
    expect(seenSessions[0]).not.toBe(seenSessions[1]);
  });

  it("stabilizes x-session-id in enforce mode for the same inferred session", async () => {
    const broker = oauthBroker();
    const body = '{"model":"glm-4.6","messages":[{"role":"user","content":"Hi"}]}';
    const seenSessions: string[] = [];
    const config: ProxyConfig = { ...TEST_CONFIG, clientIdentity: { mode: "enforce", ttlSeconds: 900, maxSessions: 1024 } };

    for (let i = 0; i < 2; i++) {
      const resp = await proxyRequest(makeClientReq(body), "anthropic", {
        config,
        broker,
        fetchImpl: mockFetch(async (req) => {
          seenSessions.push(req.headers.get("x-session-id") ?? "");
          return openaiOk();
        }),
      });
      expect(resp.status).toBe(200);
    }

    expect(seenSessions[0]).toBeTruthy();
    expect(seenSessions[1]).toBe(seenSessions[0]);
  });

  it("reports `source=none` when no session can be inferred", async () => {
    const broker = oauthBroker();
    const requests = new RequestStore();
    await captureLogs(async () => {
      await proxyRequest(makeClientReq('{"model":"glm-4.6","messages":[]}'), "anthropic", {
        config: TEST_CONFIG,
        broker,
        requests,
        fetchImpl: mockFetch(async () => openaiOk()),
      });
    });

    const session = recordOf(requests).stages.find((stage) => stage.stage === "session");
    expect(session?.fields).toEqual({ sessionId: "-", source: "none", confidence: 0 });
  });
});
