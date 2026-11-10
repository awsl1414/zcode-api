/**
 * Type definitions for OpenAI and Anthropic API formats.
 * @see https://platform.openai.com/docs/api-reference/chat
 * @see https://docs.anthropic.com/en/api/messages
 */

// ─────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────

/** API format identifier. */
export type Format = "openai" | "anthropic";

// ─────────────────────────────────────────────
// OpenAI types
// ─────────────────────────────────────────────

/** OpenAI message role. */
type OpenAIRole = "system" | "developer" | "user" | "assistant" | "tool";

/** OpenAI message in a chat completion request. */
export interface OpenAIMessage {
  role: OpenAIRole;
  content: string | null | OpenAIContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
  /** Reasoning / chain-of-thought content (GLM, DeepSeek-R1, o1-style models). */
  reasoning_content?: string;
  /**
   * Assistant refusal text. Declared for the response-side audit and
   * never emitted: the upstream has no separate refusal channel — a refusal is
   * just `content`.
   */
  refusal?: string | null;
}

/** Multi-modal content part (OpenAI format). */
export interface OpenAIContentPart {
  type: "text" | "image_url" | "video_url" | "file";
  text?: string;
  image_url?: { url: string; detail?: string };
  /** GLM-style video part (`video_url.url` is a data URL or an http(s) URL). */
  video_url?: { url: string };
  /** File part (`file_data` is a data URL, usually `data:application/pdf;base64,...`). */
  file?: { filename?: string; file_data?: string };
}

/** Tool call in an assistant message. */
export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Tool call delta in a streaming chunk (carries `index` to align parallel calls). */
export interface OpenAIStreamToolCall {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

/**
 * OpenAI usage block. `prompt_tokens` is *inclusive* of cache hits on most
 * compatible upstreams, so the Anthropic `input_tokens` (exclusive of cache)
 * is derived by subtracting the cache buckets — see `openaiUsageToAnthropic`.
 */
export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Standard OpenAI cache breakdown. */
  prompt_tokens_details?: { cached_tokens?: number };
  /** Anthropic-style direct cache fields (some compatible upstreams emit these). */
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** Standard OpenAI reasoning-token breakdown (mirrors `prompt_tokens_details`). */
  completion_tokens_details?: { reasoning_tokens?: number; audio_tokens?: number };
}

/** Tool definition in OpenAI format. */
export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** Legacy (pre-`tools`) function definition — `functions[]` carries no `type` wrapper. */
export interface OpenAILegacyFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/**
 * `stream_options` (OpenAI streaming).
 *
 * `include_usage` asks for a final chunk carrying `usage`; the proxy always
 * attaches usage to the finish chunk (`sse-translator.ts`), so `true` is
 * satisfied and `false` simply does not get a separate usage-only chunk.
 * `include_obfuscation` asks OpenAI to pad SSE frames against network probing;
 * the proxy never pads, so it is accepted and ignored.
 */
export interface OpenAIStreamOptions {
  include_usage?: boolean;
  include_obfuscation?: boolean;
}

/**
 * Structured-output request. Only `type:"text"` (the OpenAI default) can be
 * honored: the Anthropic upstream has no structured-output channel, so
 * `json_object` / `json_schema` are declared here only so the audit can reject
 * them with a `param`-carrying 400 instead of dropping them silently
 * (`protocol-fields.ts`).
 */
export type OpenAIResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema?: { name?: string; schema?: Record<string, unknown>; strict?: boolean };
    };

/**
 * POST /v1/chat/completions request body.
 *
 * This interface is the **declared protocol surface**: every field here must have
 * a verdict in `CHAT_REQUEST_FIELDS` (`protocol-fields.ts`) — that record is typed
 * `Record<keyof OpenAIChatRequest, FieldVerdict>`, so adding a field without a
 * disposition fails `tsc` (the "no silent drops" rule).
 */
export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stream_options?: OpenAIStreamOptions;
  stop?: string | string[];
  max_tokens?: number;
  max_completion_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  logprobs?: boolean;
  top_logprobs?: number;
  user?: string;
  tools?: OpenAIToolDefinition[];
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string | undefined } };
  parallel_tool_calls?: boolean;
  response_format?: OpenAIResponseFormat;
  seed?: number;
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  thinking?: AnthropicThinkingConfig & { budgetTokens?: number };
  /** Output modalities; only `["text"]` is honorable (no audio out upstream). */
  modalities?: Array<"text" | "audio">;
  /** Audio-output config (voice/format) — no audio modality upstream. */
  audio?: { voice?: string; format?: string };
  /** Predicted outputs (prefill) — no upstream channel. */
  prediction?: { type: "content"; content: string | OpenAIContentPart[] };
  /** Server-side storage flag — the proxy is stateless, accepted and ignored. */
  store?: boolean;
  /** Business metadata — not forwarded (`metadata.user_id` is the device fingerprint slot). */
  metadata?: Record<string, unknown>;
  /** Service tier hint — no upstream concept, accepted and ignored. */
  service_tier?: string;
  /** OpenAI cache-routing key — Anthropic caching is driven by `cache_control` instead. */
  prompt_cache_key?: string;
  /** Abuse-detection identifier — no upstream field, not forwarded. */
  safety_identifier?: string;
  /** Output verbosity — no upstream axis (GLM `output_config.effort` is reasoning effort). */
  verbosity?: "low" | "medium" | "high";
  /** Legacy function calling (pre-`tools`) — rejected with a pointer to `tools`. */
  functions?: OpenAILegacyFunction[];
  /** Legacy forced-function selector — rejected with a pointer to `tool_choice`. */
  function_call?: "none" | "auto" | { name: string };
}

/**
 * Non-streaming response.
 *
 * `system_fingerprint` / `service_tier` are declared because they belong to the
 * OpenAI response surface we are audited against (`protocol-fields.ts`
 * `CHAT_RESPONSE_FIELDS`) — and they are deliberately **never
 * emitted**: the upstream has no fingerprint concept, and echoing a service tier
 * we do not honor would be a lie.
 */
export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
  /** Never emitted — no upstream equivalent. */
  system_fingerprint?: string;
  /** Never emitted — the request-side value is accepted but has no effect. */
  service_tier?: string;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
}

/** Single choice in a non-streaming chat completion response. */
export interface OpenAIChoice {
  index?: number;
  message: OpenAIMessage;
  finish_reason?: "stop" | "length" | "tool_calls" | "content_filter" | null;
  /** Never emitted — the upstream returns no log probabilities; the request side 400s on `logprobs`. */
  logprobs?: null;
}

/** Streaming chunk (SSE `data:` payload). */
export interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];
  /** Present on the final chunk when `stream_options.include_usage` is set. */
  usage?: OpenAIUsage;
}

/** Choice in a streaming chunk. */
export interface OpenAIStreamChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string;
    reasoning_content?: string;
    tool_calls?: OpenAIStreamToolCall[];
  };
  finish_reason?: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

/** /v1/models list entry (plain OpenAI shape). */
export interface OpenAIModel {
  id: string;
  object: "model";
  created?: number;
  owned_by: string;
  /**
   * 双风格能力字段：OpenRouter 与 LiteLLM 两个事实标准的键名风格**同时**
   * 发在普通形态的 data[] 条目上（各自生态的客户端各认各的；OpenAI SDK 忽略
   * 未知键，冗余无害）。事实源 = `MODELS` 的 ModelDef；目录外的 id（config
   * models 广告面用户自加）没有可信事实——全部能力键缺席，「字段缺席 = 未知」，
   * 消费方 fail-open（字段缺席按未知处理，不拦）。价格字段刻意不发：没有核实过
   * 的价格事实源。
   *
   * 曾短暂发在顶层的 `input_modalities` 已收编进 `architecture`（顶层键删除：
   * 同仓消费方 app-view-chat.js 读新位置）。
   */
  /** OpenRouter 风格：显示名。目录内 = ModelDef.name；目录外 = id 本身。 */
  name?: string;
  /** OpenRouter 风格：一句话描述，只含已核实事实；仅目录内 id 携带。 */
  description?: string;
  /** OpenRouter 风格：上下文窗口（ModelDef.contextWindow 的投影）。 */
  context_length?: number;
  /** OpenRouter 风格：模态块（`input_modalities` = MODELS.vision 的投影）。 */
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    /** OpenRouter 的 `input->output` 记法，如 "text->text" / "text+image->text"。 */
    modality?: string;
  };
  /**
   * OpenRouter 风格：可声明的请求参数。映射定稿（ModelDef → 本表）：
   * `reasoning` → ["reasoning"]，其余无对应事实；vision 不进这张表（进
   * architecture）。空数组 = 目录内已知、无特殊参数声明；缺席 = 目录外未知。
   */
  supported_parameters?: string[];
  /** LiteLLM 风格：最大输出 tokens（ModelDef.maxOutputTokens；条目无核实数字时整键缺席）。 */
  max_tokens?: number;
  /** LiteLLM 风格：`vision` ? "vision" : "chat"；仅目录内 id 携带。 */
  mode?: "vision" | "chat";
}

/** /v1/models list response. */
export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
  /**
   * 非标准扩展：`config.defaultModel` 的广播面（面板聊天视图的「服务端
   * 默认」选项用它显示实际将用的模型）。仅 `handleListModels` 的普通 OpenAI
   * 形态携带；defaultModel 未配置（空串）时整键消失。OpenAI 客户端只读
   * `data`，多余键无害；`?client_version=pi` 的 rich 形态不带它（那是
   * CLIProxyAPI 同步器的探针契约，保持最小偏差）。
   */
  default_model?: string;
}

// ─────────────────────────────────────────────
// Anthropic types
// ─────────────────────────────────────────────

/** Anthropic image/video source: inline base64 payload or a remote URL. */
type AnthropicImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };

/**
 * Anthropic document source. `base64` carries binary documents (PDF), `text`
 * carries inline plain text, `url` references a remote file — the three shapes
 * the official ZCode client emits for `application/pdf` / `text/plain` files
 * (`_reverse` bundle 3.14.0, Anthropic request builder).
 */
type AnthropicDocumentSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "text"; media_type: string; data: string }
  | { type: "url"; url: string };

/** Anthropic content block types. */
export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: AnthropicImageSource }
  | { type: "video"; source: AnthropicImageSource }
  | { type: "document"; source: AnthropicDocumentSource; title?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentBlock[]; is_error?: boolean }
  | { type: "thinking"; thinking: string; signature?: string };

/** Anthropic message in a request. */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/** POST /v1/messages request body. */
export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: "text"; text: string }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  stop_sequences?: string[];
  metadata?: { user_id?: string };
  tools?: AnthropicToolDefinition[];
  /** `disable_parallel_tool_use` is the Anthropic-side home of OpenAI's `parallel_tool_calls:false` — there is no top-level flag. */
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string; disable_parallel_tool_use?: boolean };
  thinking?: AnthropicThinkingConfig;
  /** GLM-5.3+ reasoning-effort channel; the Anthropic upstream ignores `reasoning_effort`. */
  output_config?: AnthropicOutputConfig;
}

/** GLM-5.3+ reasoning-effort control (Anthropic upstream extension). */
export interface AnthropicOutputConfig {
  effort?: string;
  task_budget?: { type: string; [k: string]: unknown };
}

/** Anthropic thinking/reasoning control. */
export interface AnthropicThinkingConfig {
  type: "enabled" | "disabled" | "adaptive";
  budget_tokens?: number;
  display?: boolean;
}

/** Tool definition in Anthropic format. */
export interface AnthropicToolDefinition {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

/** Non-streaming response. */
export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

/** Anthropic usage block (cache buckets are optional — only present when non-zero). */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// ─────────────────────────────────────────────
// Anthropic SSE event types
// @see https://docs.anthropic.com/en/api/messages-streaming
// ─────────────────────────────────────────────

export type AnthropicStreamEvent =
  | { type: "message_start"; message: AnthropicMessagesResponse }
  | { type: "content_block_start"; index: number; content_block: AnthropicContentBlock }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "signature_delta"; signature: string }
        | { type: "stop_reason"; stop_reason: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta?: { stop_reason?: string | null; stop_sequence?: string | null };
      /**
       * The upstream reports the real token counts here rather than in
       * `message_start` — including the input and cache buckets. Extra vendor
       * members (`server_tool_use`, `service_tier`) are left unmodelled.
       */
      usage?: Partial<AnthropicUsage>;
    }
  | { type: "message_stop" }
  | { type: "ping" };
