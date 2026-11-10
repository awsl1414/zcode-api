/**
 * `config.defaultModel` 接进主链路（`proxy/default-model.ts`）。
 *
 * 背景：聊天页「服务端默认」= body 不带 `model`，而主链路从不读
 * `defaultModel`，出线请求缺 `model`，上游回 `{"code":3001,"msg":"parameter
 * error"}`（2026-11-08 用户实测）。本文件钉住三件事：
 *
 * 1. 三条入站协议（/v1/chat/completions、/v1/messages、/v1/responses）body 缺
 *    `model` 时，出线请求带 `config.defaultModel`，且发生在能力过滤与
 *    路由选择之前（注入值与显式指定同样接受过滤，行为不可区分）；
 * 2. config 为空串 → 不注入（出线维持缺 model 的现状）；显式 model → 不被覆盖；
 * 3. 记录口径：`record.model` / intake 阶段 / intake dump 记**注入后**的值，
 *    `requestBytes` 维持「读入的原始字节数（改写前）」。
 *
 * 断言打在「上游实际收到的 body」上（fetchImpl 捕获），不是翻译器单元 —— 注入
 * 点在翻译之前，改错位置（比如塞进 transformRequestBody）这些用例会红。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account, Credential, RouteKind } from "../accounts/types.js";
import { accountFor, inMemoryAccounts } from "../accounts/testing.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { proxyRequest } from "./handler.js";
import { handleResponses } from "./responses-handler.js";
import { handleListModels } from "../server/routes-openai.js";
import { RequestStore } from "./request-record.js";
import { configuredDefaultModel, injectDefaultModel } from "./default-model.js";

const IDENTITY: ProxyIdentity = {
  appVersion: "test-1.0.0",
  appVersionSource: "default",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
  betaPolicy: "drop",
  betaAllowlist: [],
};

function configWith(defaultModel: string): ProxyConfig {
  return {
    server: { port: 8080, host: "0.0.0.0" },
    auth: { requireKey: false },
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel,
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
}

/** coding-plan 账号（apiKey 对）：不触 captcha / 签名层，链路短。*/
const CRED: Credential = {
  kind: "zhipu-account",
  provider: "zai",
  apiKey: "testkey",
  secret: "testsecret",
  identity: { targetType: "PERSONAL", deviceMid: "test-device-mid" },
};

function brokerOf() {
  const accounts: Account[] = [accountFor(CRED, { label: "coding", routes: ["coding-plan"] as RouteKind[] })];
  return inMemoryAccounts(accounts).broker;
}

const ANTHROPIC_OK = JSON.stringify({
  id: "msg_w48",
  type: "message",
  role: "assistant",
  model: "glm-4.6",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

/** 捕获出线请求的 fetchImpl；响应恒为一份合法 Anthropic message。*/
function capturingUpstream(): { fetchImpl: typeof fetch; bodies: () => string[] } {
  const seen: string[] = [];
  const fetchImpl = (async (req: Request) => {
    seen.push(await req.text());
    return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies: () => seen };
}

/** 用户 bug 现场（聊天页「服务端默认」）：body 没有 model 字段。*/
const MODELESS_CHAT_BODY = JSON.stringify({ messages: [{ role: "user", content: "hello" }], stream: true });

interface RunResult {
  status: number;
  upstreamBodies: Array<Record<string, unknown>>;
  record: ReturnType<RequestStore["recent"]>[number] | undefined;
  clientBody: string;
}

async function runOpenai(body: string, defaultModel: string): Promise<RunResult> {
  const config = configWith(defaultModel);
  const requests = new RequestStore();
  const { fetchImpl, bodies } = capturingUpstream();
  const clientReq = new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const resp = await proxyRequest(clientReq, "openai", {
    config,
    broker: brokerOf(),
    fetchImpl,
    endpointRouting: null,
    clientSigning: null,
    highspeed: null,
    requests,
  });
  const clientBody = await resp.text();
  return {
    status: resp.status,
    upstreamBodies: bodies().map((raw) => JSON.parse(raw) as Record<string, unknown>),
    record: requests.recent(1)[0],
    clientBody,
  };
}

async function runAnthropic(body: string, defaultModel: string): Promise<RunResult> {
  const config = configWith(defaultModel);
  const requests = new RequestStore();
  const { fetchImpl, bodies } = capturingUpstream();
  const clientReq = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const resp = await proxyRequest(clientReq, "anthropic", {
    config,
    broker: brokerOf(),
    fetchImpl,
    endpointRouting: null,
    clientSigning: null,
    highspeed: null,
    requests,
  });
  const clientBody = await resp.text();
  return {
    status: resp.status,
    upstreamBodies: bodies().map((raw) => JSON.parse(raw) as Record<string, unknown>),
    record: requests.recent(1)[0],
    clientBody,
  };
}

async function runResponses(body: unknown, defaultModel: string): Promise<RunResult> {
  const config = configWith(defaultModel);
  const requests = new RequestStore();
  const { fetchImpl, bodies } = capturingUpstream();
  const clientReq = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const resp = await handleResponses(clientReq, {
    config,
    broker: brokerOf(),
    fetchImpl,
    endpointRouting: null,
    clientSigning: null,
    highspeed: null,
    requests,
  });
  const clientBody = await resp.text();
  return {
    status: resp.status,
    upstreamBodies: bodies().map((raw) => JSON.parse(raw) as Record<string, unknown>),
    record: requests.recent(1)[0],
    clientBody,
  };
}

describe("injectDefaultModel（字符串 body 单元）", () => {
  it("缺 model → 注入 config.defaultModel 并重新序列化", () => {
    const config = configWith("glm-4.6");
    const result = injectDefaultModel(MODELESS_CHAT_BODY, config);
    expect(result.injected).toBe(true);
    expect(JSON.parse(result.body!)).toEqual({ model: "glm-4.6", messages: [{ role: "user", content: "hello" }], stream: true });
  });

  it("空串 / 纯空白 model 都算没带", () => {
    const config = configWith("glm-4.6");
    for (const model of ["", "   "]) {
      const result = injectDefaultModel(JSON.stringify({ model, messages: [] }), config);
      expect(result.injected).toBe(true);
      expect(JSON.parse(result.body!).model).toBe("glm-4.6");
    }
  });

  it("显式 model → 一个字节不动（同一引用，不重新序列化）", () => {
    const config = configWith("glm-4.6");
    const body = JSON.stringify({ model: "glm-5.3-flash", messages: [] });
    const result = injectDefaultModel(body, config);
    expect(result.injected).toBe(false);
    expect(result.body).toBe(body);
  });

  it("config.defaultModel 为空串 / 纯空白 → 不注入", () => {
    const body = MODELESS_CHAT_BODY;
    for (const value of ["", "  "]) {
      const result = injectDefaultModel(body, configWith(value));
      expect(result.injected).toBe(false);
      expect(result.body).toBe(body);
    }
    expect(configuredDefaultModel(configWith("  "))).toBeUndefined();
    expect(configuredDefaultModel(configWith("glm-4.6"))).toBe("glm-4.6");
  });

  it("非法 JSON / 非对象 body → 原样返回，不注入也不抛", () => {
    const config = configWith("glm-4.6");
    for (const body of ["not json", "[1,2,3]", "null", ""]) {
      const result = injectDefaultModel(body, config);
      expect(result.injected).toBe(false);
      expect(result.body).toBe(body);
    }
    expect(injectDefaultModel(undefined, config).body).toBeUndefined();
  });
});

describe("三条入站协议的 defaultModel 注入", () => {
  it("openai：聊天页 bug 现场（body 无 model）→ 出线请求带 defaultModel", async () => {
    const run = await runOpenai(MODELESS_CHAT_BODY, "glm-4.6");
    expect(run.status).toBe(200);
    // 出线是翻译后的 Anthropic 形状，注入发生在翻译之前，所以 model 已经带上。
    expect(run.upstreamBodies[0]!.model).toBe("glm-4.6");
    // 记录口径：record.model 记注入后的值，intake 阶段打 modelInjected 标记。
    expect(run.record!.model).toBe("glm-4.6");
    expect(run.record!.modelInjected).toBe(true);
    const intake = run.record!.stages.find((stage) => stage.stage === "intake");
    expect(intake!.fields.model).toBe("glm-4.6");
    expect(intake!.fields.modelInjected).toBe(true);
  });

  it("openai：requestBytes 维持「读入的原始字节数（改写前）」，注入补的字节不计入", async () => {
    const run = await runOpenai(MODELESS_CHAT_BODY, "glm-4.6");
    // 不是注入后的长度：注入后的 body 至少多出 `,"model":"glm-4.6"` 这一段。
    expect(run.record!.requestBytes).toBe(MODELESS_CHAT_BODY.length);
    expect(MODELESS_CHAT_BODY.length + ",\"model\":\"glm-4.6\"".length).toBeLessThan(JSON.stringify(run.upstreamBodies[0]).length);
  });

  it("anthropic：body 无 model → 直传改写后的 body 带 defaultModel（model 原样保留过 transform）", async () => {
    const run = await runAnthropic(JSON.stringify({ max_tokens: 16, messages: [{ role: "user", content: "hi" }] }), "glm-4.6");
    expect(run.status).toBe(200);
    expect(run.upstreamBodies[0]!.model).toBe("glm-4.6");
    expect(run.record!.model).toBe("glm-4.6");
    expect(run.record!.modelInjected).toBe(true);
  });

  it("responses：body 无 model → 不再 400，出线请求带 defaultModel", async () => {
    const run = await runResponses({ input: "hi" }, "glm-4.6");
    expect(run.status).toBe(200);
    expect(run.upstreamBodies[0]!.model).toBe("glm-4.6");
    expect(run.record!.model).toBe("glm-4.6");
    expect(run.record!.modelInjected).toBe(true);
    const intake = run.record!.stages.find((stage) => stage.stage === "intake");
    expect(intake!.fields.modelInjected).toBe(true);
  });
});

describe("不注入的边界（维持现状）", () => {
  it("config.defaultModel 为空串 → openai 出线维持缺 model（现状语义，不替用户选）", async () => {
    const run = await runOpenai(MODELESS_CHAT_BODY, "");
    expect(run.status).toBe(200);
    expect(run.upstreamBodies[0]).not.toHaveProperty("model");
    expect(run.record!.model).toBe("-");
    expect(run.record!.modelInjected).toBeUndefined();
  });

  it("config.defaultModel 为空串 → anthropic 出线维持缺 model", async () => {
    const run = await runAnthropic(JSON.stringify({ max_tokens: 16, messages: [{ role: "user", content: "hi" }] }), "");
    expect(run.status).toBe(200);
    expect(run.upstreamBodies[0]).not.toHaveProperty("model");
  });

  it("config.defaultModel 为空串 → responses 维持 400 `model` is required", async () => {
    const run = await runResponses({ input: "hi" }, "");
    expect(run.status).toBe(400);
    expect(run.clientBody).toContain("`model` is required");
    expect(run.upstreamBodies).toHaveLength(0);
  });

  it("显式 model → 三条协议都不被覆盖", async () => {
    const body = JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }], stream: true });
    const openai = await runOpenai(body, "glm-4.6");
    expect(openai.status).toBe(200);
    expect(openai.upstreamBodies[0]!.model).toBe("glm-5.3-flash");
    expect(openai.record!.modelInjected).toBeUndefined();

    const anthropic = await runAnthropic(JSON.stringify({ model: "glm-5.3-flash", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }), "glm-4.6");
    expect(anthropic.status).toBe(200);
    expect(anthropic.upstreamBodies[0]!.model).toBe("glm-5.3-flash");

    const responses = await runResponses({ model: "glm-5.3-flash", input: "hi" }, "glm-4.6");
    expect(responses.status).toBe(200);
    expect(responses.upstreamBodies[0]!.model).toBe("glm-5.3-flash");
  });
});

describe("intake dump 记注入后的形状", () => {
  let dumpDir: string;
  let dumpFile: string;

  beforeEach(() => {
    dumpDir = mkdtempSync(join(tmpdir(), "zcode-dump-w48-"));
    dumpFile = join(dumpDir, "dump.jsonl");
    process.env.ZCODE_DUMP_UPSTREAM = dumpFile;
  });

  afterEach(() => {
    delete process.env.ZCODE_DUMP_UPSTREAM;
    rmSync(dumpDir, { recursive: true, force: true });
  });

  it("intake 阶段的 dump body 已是注入后的 body", async () => {
    const run = await runOpenai(MODELESS_CHAT_BODY, "glm-4.6");
    expect(run.status).toBe(200);

    const lines = readFileSync(dumpFile, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { phase: string; body: unknown });
    const intake = lines.filter((line) => line.phase === "intake");
    expect(intake).toHaveLength(1);
    expect((intake[0]!.body as Record<string, unknown>).model).toBe("glm-4.6");
  });
});

describe("/v1/models 广播 defaultModel（前端「服务端默认」文案的数据源）", () => {
  it("普通 OpenAI 形态带 default_model；未配置时整键消失", async () => {
    const configured = handleListModels(new Request("http://localhost/v1/models"), configWith("glm-4.6"));
    const configuredBody = JSON.parse(await configured.text()) as { default_model?: string; data: unknown[] };
    expect(configuredBody.default_model).toBe("glm-4.6");
    expect(configuredBody.data).toHaveLength(1);

    const unconfigured = handleListModels(new Request("http://localhost/v1/models"), configWith(""));
    const unconfiguredBody = JSON.parse(await unconfigured.text()) as { default_model?: string };
    expect("default_model" in unconfiguredBody).toBe(false);
  });

  it("?client_version=pi 的 rich 形态不带 default_model（探针契约保持最小偏差）", async () => {
    const resp = handleListModels(new Request("http://localhost/v1/models?client_version=pi"), configWith("glm-4.6"));
    const body = JSON.parse(await resp.text()) as { default_model?: string; models: unknown[] };
    expect("default_model" in body).toBe(false);
    expect(body.models).toHaveLength(1);
  });
});
