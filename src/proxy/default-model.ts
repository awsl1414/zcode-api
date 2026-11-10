/**
 * `config.defaultModel` 接进主链路 —— 客户端不带 `model` 时的缺省补全。
 *
 * `defaultModel` 配置字段的存在意义就是「客户端不写 model 时的缺省」
 * （`config/types.ts` 该字段注释的原话，config.example.yaml / template.ts 也照这个
 * 口径注释）。async 子系统有自己的 `async.defaultModel` 优先级
 * （`async/handler.ts::resolveModel`），本模块不插手；主链路的补全在这里：聊天页选
 * 「服务端默认」时 body 不带 model，出线请求缺 `model`，上游直接回
 * `{"code":3001,"msg":"parameter error"}`（2026-11-08 用户实测）。
 *
 * 注入点与顺序（三条入站协议一致）：
 *
 *   解析出 body → **这里注入** → peekBody / 模型能力过滤（`routeSupportsModel`）
 *   → 路由选择（acquireLease）→ 会话指纹 → 翻译/改写 → 出线
 *
 * 注入发生在能力过滤与路由选择**之前**，所以注入值与「客户端显式带了它」不可
 * 区分，同样接受模型能力过滤：defaultModel 不被路由/账号支持时，行为与显式指定
 * 一致（`model-unsupported` 400 或候选集降级），不做任何特判。
 *
 * 语义边界：
 * - `model` 已显式存在（非空、非纯空白）时一个字节不动 —— 「缺省」不覆盖显式值；
 * - config 为空串（或纯空白）时不注入 —— 不替用户选模型（出线缺 model 由上游报错）；
 * - body 不是合法 JSON 对象时不注入 —— 真正的 body 校验在下游（协议闸门 /
 *   翻译器），那里会给客户端一个像样的 400，这里不抢它们的活。
 *
 * 记录口径：注入后的值就是实际出线的形状，intake 阶段与 dump
 * 都记注入后的 model；`record.requestBytes` 维持字段契约「读入的原始字节数（改写
 * 前）」，注入补上的字节不计入（见 handler.ts 的注入点注释）。
 */
import type { ProxyConfig } from "../config/types.js";

/**
 * 生效的默认模型 id；未配置（空串/纯空白）返回 `undefined`。
 *
 * config 里的值不 trim 落盘（loader 原样收），但注入的是**模型 id**，带空白出去
 * 上游必拒，所以这里取 trim 后的值；trim 完为空视同未配置。
 */
export function configuredDefaultModel(config: ProxyConfig): string | undefined {
  if (typeof config.defaultModel !== "string") return undefined;
  const trimmed = config.defaultModel.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** `model` 字段「没带」的判定：缺失、非字符串、空串、纯空白都算没带。 */
function modelOmitted(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

/** `injectDefaultModel` 的结果：注入后的 body 与「这次是否真的注入了」。 */
export interface DefaultModelInjection {
  /** 注入后的 body；未注入时是原串（同一引用，不做无谓的重新序列化）。 */
  body: string | undefined;
  /** 这次调用是否补上了 `model`（intake 阶段用打 `modelInjected` 标记）。 */
  injected: boolean;
}

/**
 * 字符串 body 版注入（/v1/chat/completions 与 /v1/messages 共用的 `proxyRequest`
 * 出线口）：`model` 没带时把 `config.defaultModel` 填进去。
 *
 * 只在真的注入时重新序列化 —— 显式 model / 非法 JSON / 非对象 body 原样返回，
 * 热路径（每个请求都要过这里）不为它们付一次 parse+stringify。
 */
export function injectDefaultModel(
  body: string | undefined,
  config: ProxyConfig,
): DefaultModelInjection {
  const fallback = configuredDefaultModel(config);
  if (fallback === undefined || body === undefined || body.length === 0) {
    return { body, injected: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { body, injected: false };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { body, injected: false };
  }
  const obj = parsed as Record<string, unknown>;
  if (!modelOmitted(obj.model)) return { body, injected: false };
  obj.model = fallback;
  return { body: JSON.stringify(obj), injected: true };
}

/**
 * 已解析对象版注入（/v1/responses 在 `ResponsesRequest` 上做，那边把 body 解析成
 * 对象之后才轮到 model 校验）。命中时原地改写并返回 true，调用方往 intake 阶段
 * 打 `modelInjected` 标记。
 */
export function injectDefaultModelIntoRequest<T extends object>(
  req: T,
  config: ProxyConfig,
): boolean {
  const fallback = configuredDefaultModel(config);
  if (fallback === undefined) return false;
  const obj = req as Record<string, unknown>;
  if (!modelOmitted(obj.model)) return false;
  obj.model = fallback;
  return true;
}
