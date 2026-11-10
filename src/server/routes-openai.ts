/**
 * OpenAI-format route handlers: /v1/chat/completions + /v1/models.
 *
 * `/v1/models` 的广告面是 `config.models`（用户可改，与能力事实表 `MODELS` 分开）：用户改
 * config.yaml 的 models 后，这个列表与启动横幅、/api/state 读同一份数据，三处
 * 说的是同一件事。`MODELS` 全集只当能力事实表用（translator 钳制与 reasoning
 * 判定），config 里的 id 落在全集内就取它的 ModelDef；全集之外的 id 仍然列出
 * 并转发（config 注释原话 "any other model id still forwards upstream"，models
 * 列表与转发行为保持一致），能力字段缺省，不编数字。
 *
 * 普通形态的 data[] 条目在基本三键之上同时发 OpenRouter 与 LiteLLM 两套
 * 能力键（事实源 = `MODELS`，映射见 plainEntryOf）；顶层
 * `input_modalities` 收编进 `architecture` 块。`?client_version=pi` 的 rich
 * 形态（CLIProxyAPI 探针契约）保持不动。
 */
import { proxyRequest, type ProxyHandlerOptions } from "../proxy/handler.js";
import { configuredDefaultModel } from "../proxy/default-model.js";
import { MODELS } from "../provider/models.js";
import type { ModelDef } from "../provider/types.js";
import type { ProxyConfig } from "../config/types.js";
import type { OpenAIModel, OpenAIModelList } from "../translator/types.js";
import { rejectUnsupportedChatRequest } from "../translator/protocol-fields.js";

/** Handle POST /v1/chat/completions — forward OpenAI-compatible chat requests upstream. */
export async function handleChatCompletions(
  req: Request,
  opts: ProxyHandlerOptions,
): Promise<Response> {
  // 协议准入闸门：不可映射或未知字段一律 400 带 `param`，绝不静默
  // 丢弃。放在翻译之前 —— 翻译器只认它认识的字段，让不认识的字段走到那里就等于
  // 「收下但不生效」。判定表与错误形状在 `translator/protocol-fields.ts`。
  const rejection = await rejectUnsupportedChatRequest(req);
  if (rejection) return rejection;
  return proxyRequest(req, "openai", opts);
}

/** One advertised entry: `def` is the pinned catalog entry when the id is one of MODELS. */
interface AdvertisedEntry {
  id: string;
  def?: ModelDef;
}

/** Thousands grouping without locale dependence (tests must be deterministic). */
function grouped(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 一句话描述，只陈述 `MODELS` 里核实过的事实（名字 + 数字 + 能力旗标），
 * 不做营销式扩写——编造比缺失更糟，与「不编数字」同一纪律。目录外 id 没有
 * 描述（调用方看到的是字段缺席）。
 */
function descriptionOf(def: ModelDef): string {
  const facts: string[] = [`${grouped(def.contextWindow)}-token context window`];
  if (def.maxOutputTokens !== undefined) facts.push(`up to ${grouped(def.maxOutputTokens)} output tokens`);
  if (def.reasoning) facts.push("reasoning mode");
  if (def.vision) facts.push("image input");
  return `${def.name}: ${facts.join("; ")}.`;
}

/**
 * 普通 OpenAI 形态的 data[] 条目 = OpenAI 基本三键 + OpenRouter 与
 * LiteLLM 两个事实标准的能力键**同时发**（各自生态的客户端各认各的；OpenAI
 * SDK 忽略未知键，冗余无害）。事实源是 `MODELS` 的 ModelDef；目录外的 id
 * （config.models 广告面用户自加）没有可信事实，只发基本键 + name=id——
 * 「字段缺席 = 未知」，消费方 fail-open。价格字段刻意
 * 不发：本项目没有核实过的价格事实源，编造比缺失更糟。
 */
function plainEntryOf({ id, def }: AdvertisedEntry): OpenAIModel {
  // Unknown id: base keys + honest name, every capability key omitted.
  if (!def) return { id, object: "model", owned_by: "custom", name: id };
  const inputModalities = def.vision ? ["text", "image"] : ["text"];
  const entry: OpenAIModel = {
    id,
    object: "model",
    // Catalog ids are pinned and spec-verified by this proxy; anything else
    // is a user-added forward-through model, so "custom" is the honest label.
    owned_by: "zcode-proxy",
    // ── OpenRouter style ──
    name: def.name,
    description: descriptionOf(def),
    context_length: def.contextWindow,
    architecture: {
      // Vision capability is an explicit catalog flag (glm-5.3-flash takes
      // images without a "v" in its id; glm-4.6v-style ids also carry it).
      // `input_modalities` 只落在这个块里，顶层键不存在。
      input_modalities: inputModalities,
      // Catalog models are all text-out chat models: no image-output fact
      // exists in ModelDef, and none of them produce images.
      output_modalities: ["text"],
      // OpenRouter's documented `input->output` notation, derived from the
      // same two facts as the modality arrays above (certain, so emitted).
      modality: `${def.vision ? "text+image" : "text"}->text`,
    },
    // ModelDef 里唯一的请求参数事实是 `reasoning` →
    // ["reasoning"]；vision 不进这张表（进上面的 modality 块）。空数组 = 目录
    // 内已知模型、无特殊参数声明；字段缺席 = 目录外未知模型。
    supported_parameters: def.reasoning ? ["reasoning"] : [],
    // ── LiteLLM style ──
    mode: def.vision ? "vision" : "chat",
  };
  // max_tokens = 最大输出 tokens；目录条目没有核实数字时整键缺席（不编数
  // 字——现行目录每个条目都有，分支是给未来条目的防御）。
  if (def.maxOutputTokens !== undefined) entry.max_tokens = def.maxOutputTokens;
  return entry;
}

/** `client_version` query read. node:http 构造的 Request.url 恒为绝对地址，
 * try/catch 只是防御：解析失败按「没有查询参数」处理，回落到普通 OpenAI 形态。 */
function clientVersionOf(req: Request): string | null {
  try {
    return new URL(req.url).searchParams.get("client_version");
  } catch {
    return null;
  }
}

/** Handle GET /v1/models — advertise the models the config lists. */
export function handleListModels(req: Request, config: ProxyConfig): Response {
  const catalogById = new Map(MODELS.map((m) => [m.id, m] as const));
  const advertised: AdvertisedEntry[] = config.models.map((id) => ({
    id,
    def: catalogById.get(id),
  }));
  const defaultModel = configuredDefaultModel(config);

  // CLIProxyAPI-style rich catalog: DSH's better-basicfun synchronizer probes
  // with ?client_version=pi and parses a top-level `models[]` array with
  // slug/context_window/max_tokens/supported_reasoning_levels fields. A plain
  // OpenAI request keeps the original `data[]` shape.
  const clientVersion = clientVersionOf(req);
  if (clientVersion === "pi") {
    const body = {
      object: "list",
      models: advertised.map(({ id, def }) => ({
        slug: id,
        display_name: def?.name ?? id,
        description: def?.name ?? id,
        // Unknown models get no numeric capability fields: we have no verified
        // spec for them and inventing numbers would be worse than omitting.
        ...(def ? { context_window: def.contextWindow, max_context_window: def.contextWindow } : {}),
        ...(def?.maxOutputTokens === undefined ? {} : { max_tokens: def.maxOutputTokens }),
        // Vision capability is an explicit catalog flag (glm-5.3-flash takes
        // images without a "v" in its id; glm-4.6v-style ids also carry it).
        // Unknown models advertise text only, the least claim a chat model
        // must satisfy.
        input_modalities: def?.vision ? ["text", "image"] : ["text"],
        supported_reasoning_levels: def?.reasoning
          ? [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }]
          : [],
        visibility: "list",
      })),
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const list: OpenAIModelList = {
    object: "list",
    // 条目形态见 plainEntryOf —— OpenAI 基本键 + OpenRouter/LiteLLM 双
    // 风格能力键；input_modalities 在 architecture 块里，面板聊天
    // 视图（app-view-chat.js）读 architecture.input_modalities。
    data: advertised.map(plainEntryOf),
    // 把生效的 defaultModel 一并广播（面板聊天视图的「服务端默认」选项
    // 显示成「默认（glm-5.3）」，不再是神秘值）。未配置时整键消失，前端退回
    // 原文案 —— 见 OpenAIModelList.default_model 的字段注释。
    ...(defaultModel !== undefined ? { default_model: defaultModel } : {}),
  };
  return new Response(JSON.stringify(list), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
