/**
 * 对外协议字段审计与准入校验。
 *
 * 要解决的问题：`types.ts` 里声明了大量 OpenAI 字段，翻译函数却只消费其中十来个，
 * 差额被**静默丢弃**：客户端传了、类型收下了、请求成功返回了，上游根本不知道。
 * 本模块把「每个字段的去处」变成**可执行的数据**：
 *
 *   1. 四张判定表（Chat 请求 / Chat 响应 / Responses 请求 / Responses 响应），
 *      每项标注四类归属之一：已映射 / 可映射 / 不可映射 / 客户端侧。
 *   2. 两张请求表是 `Record<keyof …, FieldVerdict>`，**类型层强制穷举**：以后往
 *      `OpenAIChatRequest` / `ResponsesRequest` 里加字段却忘了给判定，`tsc` 直接
 *      失败。这是「无静默丢弃」的编译期保险，比运行期测试更早一步。
 *   3. 准入校验把「不可映射」和「未知字段」变成 400（带 `param` 的错误形状），由两个
 *      路由入口调用（`server/routes-openai.ts` / `server/routes-responses.ts`）。
 *
 * 判定原则（铁律）：字段只要有语义就必须有去处：翻成上游参数、代理自己
 * 消费、或 400。**没有第四种**：「收下但不生效」不接受。
 *
 * 拒绝是**取值敏感**的，不是「出现即拒」：OpenAI 多数参数带默认值，而默认值等于
 * 「没提要求」，我们本来就已经满足它（单候选、零惩罚、无 logprob、文本输出）。
 * 所以 `n:1` / `presence_penalty:0` / `logit_bias:{}` / `logprobs:false` /
 * `response_format:{type:"text"}` 一律放行，只有客户端**真的要求了上游给不了的
 * 能力**才 400。这样既守住铁律，又不误伤「总是把默认值显式发出来」的客户端
 * （很多 SDK 和网关会那么做）。
 *
 * 显式 `null` 一律视为「未指定」（JSON 里 `"seed": null` 就是没给 seed），不拒绝。
 *
 * 校验范围 = 请求体**顶层**字段。`messages[]` / `input[]` / `tools[]` 的子结构由
 * 翻译器按块处理；子结构字段没有逐项审计表，改动时对照翻译器的分支。
 */
import type { OpenAIChatRequest } from "./types.js";
import type { ResponsesRequest } from "./responses-types.js";
import { inflateWithCap } from "../proxy/inflate.js";

// ─────────────────────────────────────────────
// 判定词汇表
// ─────────────────────────────────────────────

/** 四类归属。 */
export type FieldDisposition =
  /** 已映射：已经翻成 Anthropic 对应参数。 */
  | "mapped"
  /** 可映射：有语义对应，且已经实现（复核后此桶为空）。 */
  | "mappable"
  /** 不可映射：Anthropic 侧无对应能力，客户端真的要求了能力时返回 400。 */
  | "unmappable"
  /** 客户端侧：由代理自己消费或明确忽略并记录，不上行。 */
  | "client_side";

/** 400 的 `code`：字段根本不在协议面上（拼错、或新版本 OpenAI 新增而我们没实现）。 */
export const UNKNOWN_PARAMETER = "unknown_parameter";

/** 400 的 `code`：字段在协议面上，但本代理/上游给不了它要的能力。 */
export const UNSUPPORTED_PARAMETER = "unsupported_parameter";

/** 一条不可映射字段的拒绝规则。 */
export interface ParamRejection {
  /** 400 的 `code`，见 {@link UNKNOWN_PARAMETER} / {@link UNSUPPORTED_PARAMETER}。 */
  code: string;
  /** 400 的 `param`；缺省用字段名本身（嵌套字段可写成 `text.format` 这种路径）。 */
  param?: string;
  /** 面向客户端的英文说明：为什么给不了 + 该怎么办。 */
  message: string;
  /**
   * 「何时拒绝」判定：返回 true 才拒绝。缺省 = 字段一出现就拒绝（显式 null 除外）。
   * 带默认值的字段必须给判定，让默认值走放行分支（见模块头注释）。
   */
  rejectWhen?: (value: unknown) => boolean;
}

/** 一个字段的审计结论。 */
export interface FieldVerdict {
  disposition: FieldDisposition;
  /** 判定依据（表里每个字段的审计结论都写在这里）。 */
  note: string;
  /** 仅 `unmappable` 才有：400 的 code / param / message。 */
  rejection?: ParamRejection;
}

/** 一条要回给客户端的 400。 */
export interface UnsupportedParam {
  /** 具体字段名（`param` 必须指向字段，客户端才能定位）。 */
  param: string;
  code: string;
  message: string;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─────────────────────────────────────────────
// 表 1：Chat Completions 请求
// ─────────────────────────────────────────────

/**
 * `POST /v1/chat/completions` 请求字段矩阵。
 *
 * 键类型是 `keyof OpenAIChatRequest`：往类型里加字段而不在这里给判定，
 * `tsc --noEmit` 会失败（无静默丢弃的编译期保险）。
 */
export const CHAT_REQUEST_FIELDS: Record<keyof OpenAIChatRequest, FieldVerdict> = {
  model: { disposition: "mapped", note: "原样进 Anthropic `model`。" },
  messages: {
    disposition: "mapped",
    note: "system/developer 折进顶层 `system`；连续 tool 消息合并为一个 user 的多个 tool_result 块；图片/视频/文件块转 Anthropic 对应块。",
  },
  temperature: { disposition: "mapped", note: "→ `temperature`；thinking 开启时按 SDK 兼容规则作废。" },
  top_p: { disposition: "mapped", note: "→ `top_p`；与 temperature 同发时按 SDK 兼容规则作废。" },
  max_tokens: { disposition: "mapped", note: "→ `max_tokens`（缺省取模型 catalog 上限）。" },
  max_completion_tokens: { disposition: "mapped", note: "优先于 `max_tokens`，→ `max_tokens`。" },
  stream: { disposition: "mapped", note: "→ `stream`；流式由 SSE 翻译器接管。" },
  stop: { disposition: "mapped", note: "字符串或数组 → `stop_sequences`。" },
  tools: { disposition: "mapped", note: "`function` 工具 → Anthropic `tools[]`（parameters → input_schema）。" },
  tool_choice: {
    disposition: "mapped",
    note: "auto→auto、required→any、指定函数→tool；`none` 会剥掉 `tools`（Anthropic 没有 none 型，只能靠无工具实现）。",
  },
  parallel_tool_calls: {
    disposition: "mapped",
    note: "`false` → `tool_choice.disable_parallel_tool_use`（issue #65）；`true`/缺省是上游默认，不序列化。",
  },
  reasoning_effort: {
    disposition: "mapped",
    note: "GLM-5.3 家族 → `output_config.effort` + 配套 `thinking.budget_tokens`；其他模型只有 thinking 开关，上游没有 effort 分档。",
  },
  thinking: { disposition: "mapped", note: "ZCode 扩展：显式 thinking 配置原样转 Anthropic `thinking`。" },
  n: {
    disposition: "unmappable",
    note: "Anthropic 单次只产出一个候选；`n:1`（默认）本来就是我们的行为，故按取值拒绝。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      message:
        "`n` > 1 is not supported: the Anthropic upstream returns exactly one candidate per request. Send n:1 (or omit it) and issue parallel requests if you need several completions.",
      rejectWhen: (value) => typeof value === "number" && value > 1,
    },
  },
  presence_penalty: {
    disposition: "unmappable",
    note: "上游没有重复惩罚项；默认值 0 = 不加惩罚，我们本来就满足。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      message:
        "`presence_penalty` is not supported: the upstream exposes no repetition-penalty knob. Only the OpenAI default (0) is accepted.",
      rejectWhen: (value) => value !== 0,
    },
  },
  frequency_penalty: {
    disposition: "unmappable",
    note: "同 `presence_penalty`：无对应惩罚项，默认值 0 放行。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      message:
        "`frequency_penalty` is not supported: the upstream exposes no repetition-penalty knob. Only the OpenAI default (0) is accepted.",
      rejectWhen: (value) => value !== 0,
    },
  },
  logit_bias: {
    disposition: "unmappable",
    note: "上游无 token 级偏置；空对象等于没提要求，放行。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      message:
        "`logit_bias` is not supported: the upstream exposes no token-level bias. Only an empty object (no bias) is accepted.",
      rejectWhen: (value) => isJsonObject(value) && Object.keys(value).length > 0,
    },
  },
  logprobs: {
    disposition: "unmappable",
    note: "上游不返回 logprob；`false`（默认）放行，响应侧同样不返回（两侧一致）。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      message: "`logprobs` is not supported: the upstream returns no log probabilities. Omit it or send logprobs:false.",
      rejectWhen: (value) => value === true,
    },
  },
  top_logprobs: {
    disposition: "unmappable",
    note: "同 `logprobs`；只有正数才是真要求。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      message: "`top_logprobs` is not supported: the upstream returns no log probabilities.",
      rejectWhen: (value) => typeof value === "number" && value > 0,
    },
  },
  response_format: {
    disposition: "unmappable",
    note: "Anthropic 上游没有结构化输出通道（需上游实证）；`type:\"text\"` 是 OpenAI 默认值，放行。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      message:
        "`response_format` structured output (json_object / json_schema) is not supported: the Anthropic upstream has no structured-output channel. Only response_format:{\"type\":\"text\"} (the OpenAI default) is accepted — ask for JSON in the prompt and parse it client-side.",
      rejectWhen: (value) => isJsonObject(value) && typeof value.type === "string" && value.type !== "text",
    },
  },
  seed: {
    disposition: "unmappable",
    note: "上游没有确定性采样种子。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      message: "`seed` is not supported: the upstream exposes no deterministic sampling seed. Remove it (results are not reproducible).",
    },
  },
  modalities: {
    disposition: "unmappable",
    note: "上游只出文本，代理也不合成音频；`[\"text\"]` 是默认值，放行。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      message: "`modalities` beyond text is not supported: the upstream is text-out only. Send modalities:[\"text\"] or omit it.",
      rejectWhen: (value) => !(Array.isArray(value) && value.every((m) => m === "text")),
    },
  },
  audio: {
    disposition: "unmappable",
    note: "无音频输出能力。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      message: "`audio` output is not supported: the upstream has no audio modality.",
    },
  },
  prediction: {
    disposition: "unmappable",
    note: "上游没有 predicted-output 预填通道。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      message: "`prediction` (predicted outputs) is not supported: the upstream has no predicted-output prefill channel.",
    },
  },
  verbosity: {
    disposition: "unmappable",
    note: "上游无 verbosity 轴（GLM 的 `output_config.effort` 是**推理**强度，不是输出啰嗦度）；默认值 medium 放行。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      message:
        "`verbosity` is not supported: the upstream has no output-verbosity control (GLM's output_config.effort is reasoning effort, a different axis). Only the OpenAI default (\"medium\") is accepted.",
      rejectWhen: (value) => value !== "medium",
    },
  },
  functions: {
    disposition: "unmappable",
    note: "遗留函数调用形态（`functions` + `function_call`）。只做上行映射会让响应形态错位（遗留客户端读 `function_call`，我们只会返回 `tool_calls`），所以整对拒绝并指路。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      param: "functions",
      message:
        "Legacy `functions` is not supported: use `tools` instead. (Mapping only the request half would leave legacy clients unable to read the `tool_calls` response shape.)",
      rejectWhen: (value) => !Array.isArray(value) || value.length > 0,
    },
  },
  function_call: {
    disposition: "unmappable",
    note: "同 `functions`；`\"auto\"`/`\"none\"` 是默认行为（无函数可用），放行，只有点名函数的对象形态拒绝。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      param: "function_call",
      message: "Legacy `function_call` is not supported: use `tool_choice` instead.",
      rejectWhen: (value) => isJsonObject(value),
    },
  },
  stream_options: {
    disposition: "client_side",
    note: "`include_usage`：代理恒把 usage 挂在收尾 chunk 上（`sse-translator.ts`），`true` 满足、`false` 也不会多出独立 usage chunk。`include_obfuscation`：代理不做 SSE 填充，接受并忽略。",
  },
  store: {
    disposition: "client_side",
    note: "代理无状态、不存储会话（Chat 侧没有 ResponseStore 对应物），`store:true` 只能做到「不影响输出」，接受并记录。",
  },
  metadata: {
    disposition: "client_side",
    note: "业务元数据不上行：`metadata.user_id` 是设备指纹的专用槽（`body-transformer` 无条件写入），其余键上游无容器可放。",
  },
  service_tier: {
    disposition: "client_side",
    note: "上游无服务档位概念，接受但零影响（回显会谎报档位，故响应侧也不回）。",
  },
  prompt_cache_key: {
    disposition: "client_side",
    note: "OpenAI 的缓存路由键；Anthropic 侧缓存由 `cache_control` 标记驱动（代理自己打），没有对应字段可放，接受并忽略。",
  },
  safety_identifier: {
    disposition: "client_side",
    note: "OpenAI 的滥用检测标识；上游无对应字段，不上行。",
  },
  user: {
    disposition: "client_side",
    note: "**不**上行。`metadata.user_id` 是 ZCode 设备指纹的专用槽，由 `body-transformer` 在翻译后无条件写入，转发 `user` 会被覆盖（等于静默丢弃），覆盖它又等于破坏身份归一（风控硬约束）。",
  },
};

// ─────────────────────────────────────────────
// 表 2：Chat Completions 响应
// ─────────────────────────────────────────────

/**
 * Chat Completions 响应字段审计。
 *
 * 响应侧不存在「400」这个去处，所以这张表的作用是**承诺**：我们产出的每个键都在
 * 表里、都标注了归属；没产出的也要记录原因（测试 `协议响应只含已审计字段` 用
 * 它做子集断言，防止哪天悄悄多塞一个字段）。
 */
export const CHAT_RESPONSE_FIELDS: Readonly<Record<string, FieldVerdict>> = {
  id: { disposition: "mapped", note: "回显上游 message id。" },
  object: { disposition: "mapped", note: "恒 `chat.completion`。" },
  created: { disposition: "mapped", note: "代理侧时间戳（上游不提供 created）。" },
  model: { disposition: "mapped", note: "回显客户端请求的 model，不是挂卡改写后的模型。" },
  choices: { disposition: "mapped", note: "恒一个元素：`n>1` 已在请求侧 400，两侧自洽。" },
  "choices[].index": { disposition: "mapped", note: "恒 0（单候选）。" },
  "choices[].finish_reason": {
    disposition: "mapped",
    note: "end_turn/stop_sequence→stop、max_tokens→length、tool_use→tool_calls；上游若下发未知 stop_reason 则为 null。",
  },
  "choices[].message": { disposition: "mapped", note: "text 块→content、thinking 块→reasoning_content、tool_use 块→tool_calls。" },
  "choices[].logprobs": { disposition: "unmappable", note: "不返回：上游无 logprob，请求侧同项已 400，两侧一致。" },
  "choices[].message.refusal": { disposition: "unmappable", note: "不返回：上游没有独立拒答通道，拒答文本走 content。" },
  system_fingerprint: { disposition: "unmappable", note: "不返回：上游无指纹概念；OpenAI 客户端把它当可选字段。" },
  service_tier: { disposition: "client_side", note: "不返回：请求侧接受但不生效，回显会谎报档位。" },
  usage: { disposition: "mapped", note: "Anthropic usage → OpenAI cache-inclusive 语义，见 `anthropicUsageToOpenAI`。" },
  "usage.prompt_tokens": { disposition: "mapped", note: "input + cache_read + cache_creation（OpenAI 的 prompt_tokens 含缓存命中）。" },
  "usage.completion_tokens": { disposition: "mapped", note: "= Anthropic `output_tokens`（thinking 已计入其中）。" },
  "usage.total_tokens": { disposition: "mapped", note: "prompt + completion，精确往返。" },
  "usage.prompt_tokens_details": { disposition: "mapped", note: "缓存明细容器（仅当上游报了缓存桶才出现）。" },
  "usage.prompt_tokens_details.cached_tokens": { disposition: "mapped", note: "cache_read_input_tokens 折算，仅当上游报了缓存桶。" },
  "usage.completion_tokens_details": {
    disposition: "unmappable",
    note: "不产出：唯一成员 `reasoning_tokens` 上游给不出（见下），空的明细容器只会误导客户端。",
  },
  "usage.completion_tokens_details.reasoning_tokens": {
    disposition: "unmappable",
    note: "不返回：Anthropic 把 thinking 计入 output_tokens，没有分项，编不出来。",
  },
};

// ─────────────────────────────────────────────
// 表 3：Responses 请求
// ─────────────────────────────────────────────

/**
 * `POST /v1/responses` 请求字段矩阵。
 *
 * 键类型是 `keyof ResponsesRequest`（该接口刻意**没有**索引签名，否则 `keyof`
 * 退化成 `string`，穷举保险失效）。
 */
export const RESPONSES_REQUEST_FIELDS: Record<keyof ResponsesRequest, FieldVerdict> = {
  model: { disposition: "mapped", note: "原样进 Chat `model` → Anthropic `model`。" },
  input: {
    disposition: "mapped",
    note: "字符串或 item 数组 → Chat messages；function_call/custom_tool_call 历史按 tool_calls + tool 回复不变式重建。",
  },
  instructions: { disposition: "mapped", note: "→ `messages[0]`（system），并在响应里回显。" },
  max_output_tokens: { disposition: "mapped", note: "→ Chat `max_tokens` → Anthropic `max_tokens`。" },
  temperature: { disposition: "mapped", note: "→ Chat `temperature`。" },
  top_p: { disposition: "mapped", note: "→ Chat `top_p`。" },
  stream: { disposition: "mapped", note: "→ `stream`；流式走 Responses SSE 事件生命周期。" },
  tools: {
    disposition: "mapped",
    note: "function/custom/namespace/tool_search 全部降级成 Chat 工具；web_search 与 hosted 工具被剥掉（代理不执行托管工具）。",
  },
  tool_choice: { disposition: "mapped", note: "→ Chat `tool_choice`；指向已被剥掉的工具时整条丢弃（避免上游 400）。" },
  parallel_tool_calls: { disposition: "mapped", note: "→ Chat `parallel_tool_calls` → `tool_choice.disable_parallel_tool_use`。" },
  reasoning: {
    disposition: "mapped",
    note: "`reasoning.effort` → Chat `reasoning_effort`。`reasoning.summary` 属客户端侧：代理恒把上游 thinking 块映射成 reasoning summary 输出，`\"none\"` 不抑制。",
  },
  previous_response_id: {
    disposition: "client_side",
    note: "代理自己消费：从 `ResponseStore` 取历史前置到 `input[]`，并钉住产出它的 (account, route)，保证续轮回到同一账号与路由。不上行。",
  },
  store: { disposition: "client_side", note: "代理自己消费：决定是否把这条响应写入 `ResponseStore`（`store:false` 不入库），不上行。" },
  metadata: { disposition: "client_side", note: "不上行也不回显：代理不存业务元数据（ResponseStore 只存 input/output）。" },
  user: {
    disposition: "client_side",
    note: "**不**上行，理由同 Chat `user`：`metadata.user_id` 是设备指纹专用槽，转发必被覆盖、覆盖即破坏身份归一。",
  },
  service_tier: { disposition: "client_side", note: "上游无服务档位概念，接受但零影响。" },
  prompt_cache_key: { disposition: "client_side", note: "无对应字段（Anthropic 缓存由 cache_control 驱动），接受并忽略。" },
  safety_identifier: { disposition: "client_side", note: "上游无对应字段，不上行。" },
  include: {
    disposition: "client_side",
    note: "代理自己消费：控制响应返回哪些字段。`reasoning.encrypted_content` 由 ResponseStore 续轮替代（不需要加密推理内容回传）；但只要 include 点名 logprob 类内容就拒绝，那是真能力缺口。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      param: "include",
      message: "`include` requesting log probabilities is not supported: the upstream returns no logprobs.",
      rejectWhen: (value) => Array.isArray(value) && value.some((e) => typeof e === "string" && e.includes("logprob")),
    },
  },
  client_metadata: {
    disposition: "client_side",
    note: "Codex CLI 的遥测扩展（非 OpenAI 官方字段），接受并忽略、不上行；列在这里是为了让 Codex 不被未知字段拒绝。",
  },
  stream_options: { disposition: "client_side", note: "`include_usage`：代理恒在收尾事件里带 usage。" },
  truncation: {
    disposition: "unmappable",
    note: "**不**映射到 `max_output_tokens`：那是输出预算，truncation 讲的是输入裁剪；上游也没有上下文裁剪参数。默认值 disabled 放行。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      param: "truncation",
      message:
        "`truncation:\"auto\"` is not supported: the proxy does not truncate conversation history and the upstream has no context-truncation parameter. Trim `input` yourself, or send truncation:\"disabled\" (the OpenAI default).",
      rejectWhen: (value) => value !== "disabled",
    },
  },
  text: {
    disposition: "unmappable",
    note: "`text.format` 是 Responses 版的结构化输出（同 Chat `response_format`），`text.verbosity` 是输出啰嗦度，两者上游都没有通道。默认（`format.type:\"text\"`、`verbosity:\"medium\"`）放行。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      param: "text",
      message:
        "`text.format` structured output (json_object / json_schema) and `text.verbosity` are not supported: the upstream has no structured-output or verbosity channel. Only text.format:{\"type\":\"text\"} and verbosity:\"medium\" (the OpenAI defaults) are accepted.",
      rejectWhen: rejectsUnsupportedTextControls,
    },
  },
  background: {
    disposition: "unmappable",
    note: "代理没有异步响应队列（要么流式要么同步返回）。默认值 false 放行。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      param: "background",
      message: "`background: true` is not supported: the proxy has no async response queue. Send background:false (or omit it).",
      rejectWhen: (value) => value === true,
    },
  },
  max_tool_calls: {
    disposition: "unmappable",
    note: "上游没有工具调用预算参数（模型自己决定，轮次由客户端循环控制）。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      param: "max_tool_calls",
      message: "`max_tool_calls` is not supported: the upstream has no tool-call budget. Bound the loop client-side.",
    },
  },
  top_logprobs: {
    disposition: "unmappable",
    note: "上游不返回 logprob；只有正数才是真要求。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      param: "top_logprobs",
      message: "`top_logprobs` is not supported: the upstream returns no log probabilities.",
      rejectWhen: (value) => typeof value === "number" && value > 0,
    },
  },
  conversation: {
    disposition: "unmappable",
    note: "托管会话对象（服务端会话库）本代理没有；续轮用 `previous_response_id`。",
    rejection: {
      code: UNSUPPORTED_PARAMETER,
      param: "conversation",
      message: "`conversation` (hosted conversation objects) is not supported: use `previous_response_id`, which the proxy resolves from its own ResponseStore.",
    },
  },
};

/** `text` 的两条子规则：结构化格式 + 啰嗦度。默认值放行，见表 3。 */
function rejectsUnsupportedTextControls(value: unknown): boolean {
  if (!isJsonObject(value)) return false;
  const format = value.format;
  if (isJsonObject(format) && typeof format.type === "string" && format.type !== "text") return true;
  const verbosity = value.verbosity;
  return typeof verbosity === "string" && verbosity !== "medium";
}

// ─────────────────────────────────────────────
// 表 4：Responses 响应
// ─────────────────────────────────────────────

/** Responses 响应字段审计。语义同表 2：产出即承诺。 */
export const RESPONSES_RESPONSE_FIELDS: Readonly<Record<string, FieldVerdict>> = {
  id: { disposition: "mapped", note: "`resp_<32hex>`，同时是 `previous_response_id` 的键。" },
  object: { disposition: "mapped", note: "恒 `response`。" },
  created_at: { disposition: "mapped", note: "代理侧时间戳。" },
  model: { disposition: "mapped", note: "回显请求的 model。" },
  status: { disposition: "mapped", note: "completed / incomplete（`finish_reason:length` → incomplete + `max_output_tokens`）。" },
  output: { disposition: "mapped", note: "message / reasoning / function_call / custom_tool_call / tool_search_call 五种 item。" },
  usage: { disposition: "mapped", note: "见 `chatUsageToResponsesUsage`。" },
  incomplete_details: { disposition: "mapped", note: "`reason: \"max_output_tokens\"`。" },
  instructions: { disposition: "mapped", note: "回显请求的 `instructions`。" },
  previous_response_id: { disposition: "mapped", note: "回显请求的 `previous_response_id`。" },
  metadata: { disposition: "client_side", note: "不回显：代理不存业务元数据（请求侧 metadata 也不上行）。" },
  service_tier: { disposition: "client_side", note: "不回显：请求侧接受但不生效。" },
  system_fingerprint: { disposition: "unmappable", note: "不返回：上游无指纹概念。" },
  truncation: { disposition: "client_side", note: "不回显：只有 `disabled` 被接受，回显没有信息量。" },
  "usage.output_tokens_details.reasoning_tokens": {
    disposition: "unmappable",
    note: "恒 0：Anthropic 把 thinking 计入 output_tokens 无分项，0 是「上游未报」的哨兵值（`chatUsageToResponsesUsage` 注释已说明）。",
  },
  "usage.input_tokens": { disposition: "mapped", note: "= Chat `prompt_tokens`（含缓存）。" },
  "usage.output_tokens": { disposition: "mapped", note: "= Chat `completion_tokens`。" },
  "usage.total_tokens": { disposition: "mapped", note: "= Chat `total_tokens`。" },
  "usage.input_tokens_details": { disposition: "mapped", note: "`cached_tokens` 来自 Chat `prompt_tokens_details`。" },
  "usage.output_tokens_details": { disposition: "mapped", note: "`reasoning_tokens` 恒 0（上游无分项）。" },
  "output[].web_search_call": { disposition: "unmappable", note: "不产出：web_search 托管工具在请求侧被剥掉，代理不执行搜索。" },
  "output[].file_search_call": { disposition: "unmappable", note: "不产出：hosted 工具在请求侧被剥掉。" },
};

// ─────────────────────────────────────────────
// 校验
// ─────────────────────────────────────────────

/**
 * 按表判定一个请求体里所有「不能静默接受」的字段。
 *
 * 两类命中：
 *   1. 表里没有的键 → `unknown_parameter`（拼错、或新版本 OpenAI 新增而我们没实现）；
 *   2. 表里判成 `unmappable` 且取值真的在要求上游给不了的能力 → 该字段的 rejection。
 *
 * 显式 `null` 视为未指定，不拒绝（JSON 里 `"seed": null` 就是没给 seed）。
 */
function collectUnsupportedParams(
  body: Record<string, unknown>,
  table: Readonly<Record<string, FieldVerdict>>,
): UnsupportedParam[] {
  const unsupported: UnsupportedParam[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (value === null || value === undefined) continue;
    const verdict = table[key];
    if (verdict === undefined) {
      unsupported.push({
        param: key,
        code: UNKNOWN_PARAMETER,
        message: `Unrecognized request argument: \`${key}\`. This proxy rejects unknown parameters instead of silently ignoring them.`,
      });
      continue;
    }
    const rejection = verdict.rejection;
    if (rejection === undefined) continue;
    if (rejection.rejectWhen !== undefined && !rejection.rejectWhen(value)) continue;
    unsupported.push({
      param: rejection.param ?? key,
      code: rejection.code,
      message: rejection.message,
    });
  }
  return unsupported;
}

/** Chat Completions 请求：列出所有不可接受字段（空数组 = 全部有去处）。 */
export function collectUnsupportedChatParams(body: Record<string, unknown>): UnsupportedParam[] {
  return collectUnsupportedParams(body, CHAT_REQUEST_FIELDS);
}

/** Responses 请求：列出所有不可接受字段。 */
export function collectUnsupportedResponsesParams(body: Record<string, unknown>): UnsupportedParam[] {
  return collectUnsupportedParams(body, RESPONSES_REQUEST_FIELDS);
}

// ─────────────────────────────────────────────
// 400 响应（两条路由各一种形状）
// ─────────────────────────────────────────────

/**
 * OpenAI 路由 400：`{error: {message, type: "invalid_request_error", param, code}}`。
 *
 * 与 `proxy/handler.ts::errorResponse`（`{error:{type,message}}`）不是同一个形状：
 * 那个给代理自己的失败（凭据、上游、翻译），这个给**客户端参数错误**，必须带
 * `param` 让 SDK 能定位到字段。
 */
export function openAIParamErrorResponse(unsupported: UnsupportedParam): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: unsupported.message,
        type: "invalid_request_error",
        param: unsupported.param,
        code: unsupported.code,
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/** Responses 路由 400：`{error: {code, message, param}}`（无 `type`）。 */
export function responsesParamErrorResponse(unsupported: UnsupportedParam): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: unsupported.code,
        message: unsupported.message,
        param: unsupported.param,
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

// ─────────────────────────────────────────────
// 路由入口用的前置旁路
// ─────────────────────────────────────────────

/**
 * 校验旁路能读的 body 上限。
 *
 * 与 `proxy/handler.ts::MAX_INFLATED_BODY_BYTES` 同一个数：那是对普通 body 的唯一
 * 硬上限，校验旁路不该比真正的读取路径更严格，否则会出现「校验先拒、正常路径本可
 * 通过」的分叉。
 */
const MAX_AUDIT_BODY_BYTES = 64 * 1024 * 1024;

/**
 * 读入站 body 并解析成 JSON 对象，供准入校验使用。
 *
 * 语义与 `proxy/handler.ts::readBody` 对齐（gzip 解压 + 上限），但**不承担报错**：
 * 任何读不懂的形态（空体、坏 gzip、非 JSON、JSON 不是对象）都返回 `undefined`，
 * 把请求交回下游既有错误路径：那里已经有精确的 413/400 文案，这里重复报错只会
 * 出现两套措辞。这不是吞错：校验是**旁路**，它的失败不改变请求结果。
 *
 * 读的是 `req.clone()`：原始请求体仍归下游消费，一次 tee 换一次前置判定。
 */
async function readJsonObjectForAudit(req: Request): Promise<Record<string, unknown> | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const probe = req.clone();
  const bytes = new Uint8Array(await probe.arrayBuffer());
  if (bytes.byteLength === 0) return undefined;
  const encoding = (probe.headers.get("content-encoding") ?? "").toLowerCase().trim();
  let text: string;
  if (encoding === "gzip" || encoding === "x-gzip") {
    const inflated = await inflateWithCap(bytes, MAX_AUDIT_BODY_BYTES);
    if (!inflated.ok) return undefined;
    text = new TextDecoder().decode(inflated.bytes);
  } else {
    text = new TextDecoder().decode(bytes);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isJsonObject(parsed) ? parsed : undefined;
}

/**
 * `POST /v1/chat/completions` 的准入闸门：不可映射或未知字段 → 400（带 `param`）。
 *
 * 只返回**第一条**命中：OpenAI 一次也只回一个 error 对象，客户端改完再来一次比
 * 一次抛一长串更好读。
 */
export async function rejectUnsupportedChatRequest(req: Request): Promise<Response | undefined> {
  const body = await readJsonObjectForAudit(req);
  if (body === undefined) return undefined;
  const [first] = collectUnsupportedChatParams(body);
  return first === undefined ? undefined : openAIParamErrorResponse(first);
}

/** `POST /v1/responses` 的准入闸门，语义同上，错误形状换成 Responses 版。 */
export async function rejectUnsupportedResponsesRequest(req: Request): Promise<Response | undefined> {
  const body = await readJsonObjectForAudit(req);
  if (body === undefined) return undefined;
  const [first] = collectUnsupportedResponsesParams(body);
  return first === undefined ? undefined : responsesParamErrorResponse(first);
}
