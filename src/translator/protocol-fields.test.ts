/**
 * 对外协议字段审计的回归测试。
 *
 * 三组守卫，缺一不可：
 *   1. **铁律**：矩阵里每一个「不可映射」字段，真的带值发出来就必须拿到
 *      400 且 `param` 指向它；未知字段同理。这样以后有人往 `types.ts` 加字段却忘了
 *      实现，运行期测试会挡（编译期还有 `Record<keyof …>` 穷举那道闸）。
 *   2. **不误伤**：矩阵里每个字段的「默认值/无害取值」都必须放行；拒绝是按取值判
 *      定的，默认值等于没提要求，我们本来就满足它。
 *   3. **响应侧**：我们产出的每个键都在审计表里，没产出的也记录了原因。
 */
import { describe, it, expect } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  CHAT_REQUEST_FIELDS,
  CHAT_RESPONSE_FIELDS,
  RESPONSES_REQUEST_FIELDS,
  RESPONSES_RESPONSE_FIELDS,
  UNKNOWN_PARAMETER,
  UNSUPPORTED_PARAMETER,
  collectUnsupportedChatParams,
  collectUnsupportedResponsesParams,
  openAIParamErrorResponse,
  rejectUnsupportedChatRequest,
  rejectUnsupportedResponsesRequest,
  responsesParamErrorResponse,
  type FieldVerdict,
} from "./protocol-fields.js";
import { translateRequestOpenAIToAnthropic, translateResponseAnthropicToOpenAI } from "./openai-to-anthropic.js";
import { chatCompletionsToResponses } from "./chat-to-responses.js";
import { transformRequestBody } from "../proxy/body-transformer.js";
import { handleChatCompletions } from "../server/routes-openai.js";
import { handleResponsesRoute } from "../server/routes-responses.js";
import type { ProxyHandlerOptions } from "../proxy/handler.js";
import type { ResponsesHandlerOptions } from "../proxy/responses-handler.js";
import type { OpenAIChatRequest, AnthropicMessagesResponse } from "./types.js";

// ─────────────────────────────────────────────
// 样本表：与矩阵一一对应（键集合相等，漂移即失败）
// ─────────────────────────────────────────────

/**
 * 「真的要求了上游给不了的能力」的取值。每个 `unmappable` 字段必须有一样本。
 */
const CHAT_REJECTING_SAMPLES: Record<string, unknown> = {
  n: 2,
  presence_penalty: 0.5,
  frequency_penalty: 0.5,
  logit_bias: { "50256": -100 },
  logprobs: true,
  top_logprobs: 3,
  response_format: { type: "json_object" },
  seed: 42,
  modalities: ["text", "audio"],
  audio: { voice: "alloy", format: "wav" },
  prediction: { type: "content", content: "prefill" },
  verbosity: "high",
  functions: [{ name: "get_weather" }],
  function_call: { name: "get_weather" },
};

/**
 * 「默认值 / 无害取值」：必须放行。每个字段都必须有一样本，没有默认值的字段
 * 用显式 `null`（JSON 里 `null` 就是「没给」，见模块头注释）。
 */
const CHAT_TOLERATED_SAMPLES: Record<string, unknown> = {
  model: "glm-5.3",
  messages: [{ role: "user", content: "hi" }],
  temperature: 0.5,
  top_p: 0.9,
  max_tokens: 1024,
  max_completion_tokens: 1024,
  stream: true,
  stop: ["\n"],
  tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
  tool_choice: "auto",
  parallel_tool_calls: false,
  reasoning_effort: "high",
  thinking: { type: "disabled" },
  n: 1,
  presence_penalty: 0,
  frequency_penalty: 0,
  logit_bias: {},
  logprobs: false,
  top_logprobs: 0,
  response_format: { type: "text" },
  seed: null,
  modalities: ["text"],
  audio: null,
  prediction: null,
  verbosity: "medium",
  functions: [],
  function_call: "auto",
  stream_options: { include_usage: true },
  store: false,
  metadata: { tenant: "t1" },
  service_tier: "auto",
  prompt_cache_key: "cache-key-1",
  safety_identifier: "user-hash",
  user: "alice",
};

const RESPONSES_REJECTING_SAMPLES: Record<string, unknown> = {
  truncation: "auto",
  text: { format: { type: "json_schema", name: "out", schema: { type: "object" } } },
  background: true,
  max_tool_calls: 5,
  top_logprobs: 3,
  conversation: "conv_123",
  include: ["message.output_text.logprobs"],
};

const RESPONSES_TOLERATED_SAMPLES: Record<string, unknown> = {
  model: "glm-5.3",
  input: "hello",
  instructions: "be brief",
  max_output_tokens: 1024,
  temperature: 0.5,
  top_p: 0.9,
  stream: true,
  tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
  tool_choice: "auto",
  parallel_tool_calls: false,
  reasoning: { effort: "high", summary: "auto" },
  previous_response_id: "resp_abc",
  store: false,
  metadata: { tenant: "t1" },
  user: "alice",
  service_tier: "auto",
  prompt_cache_key: "cache-key-1",
  safety_identifier: "user-hash",
  include: ["reasoning.encrypted_content"],
  client_metadata: { source: "codex-cli" },
  stream_options: { include_usage: true },
  truncation: "disabled",
  text: { format: { type: "text" }, verbosity: "medium" },
  background: false,
  max_tool_calls: null,
  top_logprobs: 0,
  conversation: null,
};

function verdicts(table: Readonly<Record<string, FieldVerdict>>): Array<[string, FieldVerdict]> {
  return Object.entries(table);
}

/** 审计表里的路径是**字面键**（`choices[].index`），不能走 toHaveProperty 的嵌套路径解析。 */
function documented(table: Readonly<Record<string, FieldVerdict>>, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, path);
}

function chatRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }], ...body }),
  });
}

function responsesRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3", input: "hi", ...body }),
  });
}

// ─────────────────────────────────────────────
// 1. 铁律：不可映射 → 400 + param
// ─────────────────────────────────────────────

describe("铁律：Chat 请求的不可映射字段必须 400 且带 param", () => {
  it("矩阵里每个带 rejection 的字段都有拒绝样本（防止矩阵与样本漂移）", () => {
    const rejectable = verdicts(CHAT_REQUEST_FIELDS)
      .filter(([, verdict]) => verdict.rejection !== undefined)
      .map(([field]) => field)
      .sort();
    expect(Object.keys(CHAT_REJECTING_SAMPLES).sort()).toEqual(rejectable);
  });

  for (const [field, sample] of Object.entries(CHAT_REJECTING_SAMPLES)) {
    it(`${field} 带真实要求 → 400，param 指向 ${field}`, async () => {
      const resp = await rejectUnsupportedChatRequest(chatRequest({ [field]: sample }));
      expect(resp).toBeDefined();
      expect(resp!.status).toBe(400);
      const body = await resp!.json() as { error: { param: string; code: string; type: string; message: string } };
      expect(body.error.param).toBe(field);
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe(UNSUPPORTED_PARAMETER);
      expect(body.error.message.length).toBeGreaterThan(0);
    });
  }

  it("response_format 的 json_schema 形态同样 400", async () => {
    const resp = await rejectUnsupportedChatRequest(chatRequest({
      response_format: { type: "json_schema", json_schema: { name: "out", schema: { type: "object" } } },
    }));
    expect(resp?.status).toBe(400);
    const body = await resp!.json() as { error: { param: string } };
    expect(body.error.param).toBe("response_format");
  });

  it("未知字段 → 400 unknown_parameter，param 指向该字段", async () => {
    const resp = await rejectUnsupportedChatRequest(chatRequest({ nonsense_parameter: 1 }));
    expect(resp?.status).toBe(400);
    const body = await resp!.json() as { error: { param: string; code: string } };
    expect(body.error.param).toBe("nonsense_parameter");
    expect(body.error.code).toBe(UNKNOWN_PARAMETER);
  });

  it("一次只回第一条命中（OpenAI 也只回一个 error 对象）", async () => {
    const resp = await rejectUnsupportedChatRequest(chatRequest({ seed: 42, logprobs: true }));
    const body = await resp!.json() as { error: { param: string } };
    expect(body.error.param).toBe("seed");
  });
});

describe("铁律：Responses 请求的不可映射字段必须 400 且带 param", () => {
  it("矩阵里每个带 rejection 的字段都有拒绝样本", () => {
    const rejectable = verdicts(RESPONSES_REQUEST_FIELDS)
      .filter(([, verdict]) => verdict.rejection !== undefined)
      .map(([field]) => field)
      .sort();
    expect(Object.keys(RESPONSES_REJECTING_SAMPLES).sort()).toEqual(rejectable);
  });

  for (const [field, sample] of Object.entries(RESPONSES_REJECTING_SAMPLES)) {
    it(`${field} 带真实要求 → 400，param 指向 ${field}`, async () => {
      const resp = await rejectUnsupportedResponsesRequest(responsesRequest({ [field]: sample }));
      expect(resp).toBeDefined();
      expect(resp!.status).toBe(400);
      const body = await resp!.json() as { error: { param: string; code: string; message: string } };
      expect(body.error.param).toBe(field);
      expect(body.error.code).toBe(UNSUPPORTED_PARAMETER);
      expect(body.error.message.length).toBeGreaterThan(0);
    });
  }

  it("text.verbosity 非默认值同样 400", async () => {
    const resp = await rejectUnsupportedResponsesRequest(responsesRequest({ text: { verbosity: "high" } }));
    expect(resp?.status).toBe(400);
    const body = await resp!.json() as { error: { param: string } };
    expect(body.error.param).toBe("text");
  });

  it("未知字段 → 400 unknown_parameter", async () => {
    const resp = await rejectUnsupportedResponsesRequest(responsesRequest({ warmth: 0.7 }));
    const body = await resp!.json() as { error: { param: string; code: string } };
    expect(resp?.status).toBe(400);
    expect(body.error.param).toBe("warmth");
    expect(body.error.code).toBe(UNKNOWN_PARAMETER);
  });
});

// ─────────────────────────────────────────────
// 2. 不误伤：默认值 / 无害取值一律放行
// ─────────────────────────────────────────────

describe("默认值放行：拒绝按取值判定，不按「出现即拒」", () => {
  it("Chat 样本表覆盖矩阵里每个字段", () => {
    expect(Object.keys(CHAT_TOLERATED_SAMPLES).sort()).toEqual(Object.keys(CHAT_REQUEST_FIELDS).sort());
  });

  it("Responses 样本表覆盖矩阵里每个字段", () => {
    expect(Object.keys(RESPONSES_TOLERATED_SAMPLES).sort()).toEqual(Object.keys(RESPONSES_REQUEST_FIELDS).sort());
  });

  for (const [field, sample] of Object.entries(CHAT_TOLERATED_SAMPLES)) {
    it(`Chat ${field} 的默认值/无害取值不被拒绝`, () => {
      expect(collectUnsupportedChatParams({ model: "glm-5.3", messages: [], [field]: sample })).toEqual([]);
    });
  }

  for (const [field, sample] of Object.entries(RESPONSES_TOLERATED_SAMPLES)) {
    it(`Responses ${field} 的默认值/无害取值不被拒绝`, () => {
      expect(collectUnsupportedResponsesParams({ model: "glm-5.3", input: "hi", [field]: sample })).toEqual([]);
    });
  }

  it("整条「客户端把默认值全显式发一遍」的请求照样通过（不误伤老客户端）", async () => {
    const resp = await rejectUnsupportedChatRequest(chatRequest({
      n: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      logit_bias: {},
      logprobs: false,
      top_logprobs: 0,
      response_format: { type: "text" },
      seed: null,
      modalities: ["text"],
      verbosity: "medium",
      stream_options: { include_usage: false },
      store: false,
      service_tier: "auto",
    }));
    expect(resp).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// 3. 错误形状
// ─────────────────────────────────────────────

describe("两种 400 形状", () => {
  it("OpenAI 路由：{error:{message,type:'invalid_request_error',param,code}}", async () => {
    const resp = openAIParamErrorResponse({ param: "seed", code: UNSUPPORTED_PARAMETER, message: "nope" });
    expect(resp.status).toBe(400);
    expect(resp.headers.get("content-type")).toBe("application/json");
    expect(await resp.json()).toEqual({
      error: { message: "nope", type: "invalid_request_error", param: "seed", code: UNSUPPORTED_PARAMETER },
    });
  });

  it("Responses 路由：{error:{code,message,param}}（无 type）", async () => {
    const resp = responsesParamErrorResponse({ param: "truncation", code: UNSUPPORTED_PARAMETER, message: "nope" });
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({
      error: { code: UNSUPPORTED_PARAMETER, message: "nope", param: "truncation" },
    });
  });
});

// ─────────────────────────────────────────────
// 4. 路由接线（闸门在翻译之前）
// ─────────────────────────────────────────────

describe("路由入口接线：闸门在翻译之前生效", () => {
  it("handleChatCompletions 对不可映射字段直接 400（不进 proxyRequest）", async () => {
    // opts 不会被读到：闸门在任何代理逻辑之前返回。
    const resp = await handleChatCompletions(chatRequest({ seed: 42 }), {} as ProxyHandlerOptions);
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: { param: string } };
    expect(body.error.param).toBe("seed");
  });

  it("handleResponsesRoute 对不可映射字段直接 400（不进 handleResponses）", async () => {
    const resp = await handleResponsesRoute(responsesRequest({ background: true }), {} as ResponsesHandlerOptions);
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: { param: string } };
    expect(body.error.param).toBe("background");
  });

  it("合法请求不被闸门拦下（返回 undefined 表示放行）", async () => {
    expect(await rejectUnsupportedChatRequest(chatRequest({}))).toBeUndefined();
    expect(await rejectUnsupportedResponsesRequest(responsesRequest({}))).toBeUndefined();
  });

  it("gzip 请求体同样校验（客户端压缩不等于绕过闸门）", async () => {
    const payload = JSON.stringify({ model: "glm-5.3", messages: [], seed: 7 });
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: gzipSync(payload),
    });
    const resp = await rejectUnsupportedChatRequest(req);
    expect(resp?.status).toBe(400);
  });

  it("读不懂的 body 交给下游既有错误路径（校验是旁路，不重复报错）", async () => {
    const broken = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(await rejectUnsupportedChatRequest(broken)).toBeUndefined();
    const notObject = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[1,2,3]",
    });
    expect(await rejectUnsupportedChatRequest(notObject)).toBeUndefined();
    const empty = new Request("http://localhost/v1/chat/completions", { method: "POST" });
    expect(await rejectUnsupportedChatRequest(empty)).toBeUndefined();
  });

  it("校验不消费原始请求体（下游仍能读到完整 body）", async () => {
    const payload = JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }] });
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    await rejectUnsupportedChatRequest(req);
    expect(await req.text()).toBe(payload);
  });
});

// ─────────────────────────────────────────────
// 5. 客户端侧字段：接受但不改变上行
// ─────────────────────────────────────────────

describe("客户端侧字段：接受、但不进上游请求", () => {
  const base: OpenAIChatRequest = { model: "glm-5.3", messages: [{ role: "user", content: "hi" }] };

  it("user 不写进 metadata（那是设备指纹专用槽）", () => {
    const translated = translateRequestOpenAIToAnthropic({ ...base, user: "alice" });
    expect(translated.metadata).toBeUndefined();
  });

  it("user 也不会覆盖 body-transformer 注入的 ZCode 设备指纹（风控硬约束）", () => {
    const fingerprint = JSON.stringify({ device_id: "dev-1", account_uuid: "", session_id: "" });
    const translated = translateRequestOpenAIToAnthropic({ ...base, user: "alice" });
    const transformed = transformRequestBody(JSON.stringify(translated), {
      format: "anthropic",
      metadataUserId: fingerprint,
    });
    const parsed = JSON.parse(transformed!) as { metadata: { user_id: string } };
    expect(parsed.metadata.user_id).toBe(fingerprint);
  });

  it("store / metadata / service_tier / prompt_cache_key / safety_identifier 不上行", () => {
    const translated = translateRequestOpenAIToAnthropic({
      ...base,
      store: true,
      metadata: { tenant: "t1" },
      service_tier: "flex",
      prompt_cache_key: "k",
      safety_identifier: "s",
    });
    // 上游请求体里没有这些字段的容器：唯一可能承载的是 metadata.user_id，而它留给设备指纹。
    expect(translated.metadata).toBeUndefined();
    expect(JSON.stringify(translated)).not.toContain("service_tier");
    expect(JSON.stringify(translated)).not.toContain("prompt_cache_key");
    expect(JSON.stringify(translated)).not.toContain("tenant");
  });

  it("stream_options 不改变翻译产物（usage 恒挂在收尾 chunk，由 SSE 翻译器负责）", () => {
    const withOptions = translateRequestOpenAIToAnthropic({ ...base, stream: true, stream_options: { include_usage: true } });
    const without = translateRequestOpenAIToAnthropic({ ...base, stream: true });
    expect(withOptions).toEqual(without);
  });

  it("Responses 的 previous_response_id / store / include 不阻塞续轮", async () => {
    const resp = await rejectUnsupportedResponsesRequest(responsesRequest({
      previous_response_id: "resp_prev",
      store: false,
      include: ["reasoning.encrypted_content"],
      client_metadata: { source: "codex-cli" },
    }));
    expect(resp).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// 6. 响应侧：产出即承诺
// ─────────────────────────────────────────────

describe("响应侧：产出的键都在审计表里", () => {
  const anthropicResp: AnthropicMessagesResponse = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "glm-5.3",
    content: [{ type: "text", text: "hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
  };

  it("Chat 响应顶层键 ⊆ 审计表，且不含 logprobs / system_fingerprint", () => {
    const resp = translateResponseAnthropicToOpenAI(anthropicResp, "glm-5.3");
    for (const key of Object.keys(resp)) expect(documented(CHAT_RESPONSE_FIELDS, key)).toBe(true);
    expect(Object.keys(resp)).not.toContain("logprobs");
    expect(Object.keys(resp)).not.toContain("system_fingerprint");
    expect(Object.keys(resp)).not.toContain("service_tier");
  });

  it("Chat 响应的 choice / usage 子键 ⊆ 审计表", () => {
    const resp = translateResponseAnthropicToOpenAI(anthropicResp, "glm-5.3");
    for (const key of Object.keys(resp.choices[0])) expect(documented(CHAT_RESPONSE_FIELDS, `choices[].${key}`)).toBe(true);
    for (const key of Object.keys(resp.usage!)) expect(documented(CHAT_RESPONSE_FIELDS, `usage.${key}`)).toBe(true);
    for (const key of Object.keys(resp.usage!.prompt_tokens_details!)) {
      expect(documented(CHAT_RESPONSE_FIELDS, `usage.prompt_tokens_details.${key}`)).toBe(true);
    }
  });

  it("Chat 响应不回 logprobs（与请求侧 400 两侧一致）", () => {
    const resp = translateResponseAnthropicToOpenAI(anthropicResp, "glm-5.3");
    expect(resp.choices[0].logprobs).toBeUndefined();
  });

  it("Responses 响应顶层键 ⊆ 审计表，且不回 metadata / service_tier", () => {
    const chatResp = translateResponseAnthropicToOpenAI(anthropicResp, "glm-5.3");
    const resp = chatCompletionsToResponses(chatResp, "glm-5.3", { instructions: "be brief" });
    for (const key of Object.keys(resp)) expect(documented(RESPONSES_RESPONSE_FIELDS, key)).toBe(true);
    expect(Object.keys(resp)).not.toContain("metadata");
    expect(Object.keys(resp)).not.toContain("service_tier");
    expect(Object.keys(resp)).not.toContain("system_fingerprint");
  });

  it("Responses usage 子键 ⊆ 审计表（reasoning_tokens 恒 0 是哨兵值）", () => {
    const chatResp = translateResponseAnthropicToOpenAI(anthropicResp, "glm-5.3");
    const resp = chatCompletionsToResponses(chatResp, "glm-5.3");
    for (const key of Object.keys(resp.usage!)) expect(documented(RESPONSES_RESPONSE_FIELDS, `usage.${key}`)).toBe(true);
    expect(resp.usage!.output_tokens_details.reasoning_tokens).toBe(0);
  });
});

// ─────────────────────────────────────────────
// 7. 矩阵自身的一致性
// ─────────────────────────────────────────────

describe("矩阵自洽", () => {
  it("unmappable 必有 rejection；mapped 不得有；client_side 只允许「窄口」rejection", () => {
    for (const table of [CHAT_REQUEST_FIELDS, RESPONSES_REQUEST_FIELDS]) {
      for (const [field, verdict] of verdicts(table)) {
        if (verdict.disposition === "unmappable") {
          expect(verdict.rejection).toBeDefined();
        }
        if (verdict.disposition === "mapped") {
          expect(verdict.rejection).toBeUndefined();
        }
        // client_side 也可以带一条窄口拒绝：整体接受、只有某个具体能力缺口才 400
        // （例如 `include` 只拒绝 logprob 类内容）。
        if (verdict.rejection !== undefined) {
          expect(verdict.rejection.message.length).toBeGreaterThan(0);
          expect(verdict.rejection.code).toBe(UNSUPPORTED_PARAMETER);
        }
        expect(verdict.note.length).toBeGreaterThan(0);
        expect(field.length).toBeGreaterThan(0);
      }
    }
  });

  it("响应侧四张表都不含 unmappable 之外的 rejection（响应不能 400）", () => {
    for (const table of [CHAT_RESPONSE_FIELDS, RESPONSES_RESPONSE_FIELDS]) {
      for (const [, verdict] of verdicts(table)) {
        expect(verdict.rejection).toBeUndefined();
        expect(verdict.note.length).toBeGreaterThan(0);
      }
    }
  });
});
