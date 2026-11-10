/**
 * 统一上游信号层：出线通道的每一次上游活动最终都产出这里的 `UpstreamSignal`，
 * 交给健康引擎（`health.ts::HealthEngine.apply`）处理健康状态变化。
 * `proxy/upstream-error.ts::observeUpstream` 是唯一观测点，全部出线通道（数据面 /
 * 翻译层 / SSE 流 / async / claim）经它汇入引擎；一个观测点保证了状态机只吃一种
 * 事实形态，不会出现几处各自解释上游响应。
 *
 * 码表依据：上游业务码调研文档 `docs/research/upstream-risk-control.md`
 * （zcode-plan / Start Plan 码与 BigModel / Z.AI 兼容接口码两套，逐码的官方出处见
 * 各自注释）。每个解析分支都有 `signals.test.ts` 里的实测形态用例背书（502+1005
 * 信封、SSE `[1302]` 前缀、claim `429; retry in 600s`、200 空流），不留「如有」分支。
 *
 * 依赖方向：本文件是**叶子**（只有 `import type` + 同目录纯函数），不 import 任何
 * 运行时消费者。`parseRetryAfterSeconds` / `upstreamBizCode` 两个纯函数从
 * `proxy/upstream-error.ts` 收编进来（零行为变化，同一批单测覆盖跟着搬）：
 * 解析是信号层的职责，且 `claim/client.ts` 等叶子消费者不该为了一个 RFC 9110
 * 解析去 import 观测点模块。
 */
import type { ProviderFamily } from "./types.js";

// ---------------------------------------------------------------------------
// 信号类型
// ---------------------------------------------------------------------------

export type UpstreamSignalKind =
  /** 2xx 完成。成功响应体大，不读体；200 形态的错误信封判定交给流/翻译层。 */
  | "success"
  /** 瞬时可重试（429 / 并发 / 过频）：冷却后恢复。未收录码的保守归类也落这里。 */
  | "rate-limited"
  /** 额度/权益终态：判 drained，恢复靠额度采样确认。 */
  | "quota-terminal"
  /** 公平使用限制（1313）：风控标记不是速率窗口，继续重试会放大异常流量。 */
  | "fair-usage"
  /** 凭据/安全校验问题（401/403、3007、1006）：恢复靠 re-import / 升级 auth-invalid。 */
  | "auth"
  /** 端点形态被拒（405 强信号 / 404 弱信号）：路由级问题，不惩罚账号。 */
  | "endpoint-shape"
  /** 请求/模型级问题（3006 模型不可用、1261 超窗、无码 4xx）：换模型/改请求。 */
  | "model-level"
  /** 上游网关/服务错误（无码 5xx、流内错误提取不到码）：默认可重试。 */
  | "gateway"
  /** 传输层故障（connect 失败 / 流中断）。 */
  | "transport"
  /** 200 空流软拒绝：账号级信号（同路由其他账号正常）。 */
  | "empty-stream";

export interface UpstreamSignal {
  kind: UpstreamSignalKind;
  /** 上游业务码（有则带）；HTTP 状态码不算业务码。 */
  code?: number | string;
  /** 冷却恢复的秒数（retry-after 头解析；大值直接采信，无 cap）。 */
  retryAfterSeconds?: number;
  /** 原始错误片段（排障；截断 ≤200 字符）。 */
  detail?: string;
}

// ---------------------------------------------------------------------------
// 解析基元（RFC 9110 Retry-After / 信封业务码）
// ---------------------------------------------------------------------------

/** 毫秒 → 秒（`Retry-After` 的单位是秒）。*/
const MS_PER_SECOND = 1_000;

/**
 * `Retry-After` 头 → 秒。
 *
 * 支持 RFC 9110 的两种形态：
 * - delta-seconds：`Retry-After: 120`；
 * - HTTP-date：`Retry-After: Wed, 21 Oct 2015 07:28:00 GMT`（算出与 `now` 的差）。
 *
 * 返回 `undefined` = 没有这个头或值不可解，调用方据此落成**无 until** 冷却，
 * 等下一轮额度采样给出权威解除时间，不回落固定常量。负数归零：上游时钟偏差不该
 * 变成"未来才解冻"。
 */
export function parseRetryAfterSeconds(raw: string | null, now: number): number | undefined {
  if (raw === null) return undefined;
  const value = raw.trim();
  if (value === "") return undefined;

  const deltaSeconds = Number(value);
  if (Number.isFinite(deltaSeconds)) return Math.max(0, Math.ceil(deltaSeconds));

  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / MS_PER_SECOND));
}

/**
 * 上游错误体里的业务码。
 *
 * 两种形态都见过：
 * - 开放平台扁平信封：`{"code":1113,"msg":"..."}`；
 * - Anthropic 风格嵌套：`{"error":{"type":"...","code":"1113"}}`（码可能是字符串）。
 *
 * 不是 JSON（例如纯文本 5xx 页）就没有业务码可读，返回 `undefined` 是诚实的答案，
 * 不是"吞错"：这里的输入是外部字符串，读不出码是常态之一（防御外部输入是边界
 * 该做的事，不是掩盖内部 bug）。
 */
export function upstreamBizCode(bodyText: string): number | string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const envelope = parsed as { code?: unknown; error?: unknown };
  const nested = envelope.error;
  if (nested !== null && typeof nested === "object") {
    const inner = (nested as { code?: unknown }).code;
    if (typeof inner === "number" || typeof inner === "string") return inner;
  }
  const flat = envelope.code;
  if (typeof flat === "number" || typeof flat === "string") return flat;
  return undefined;
}

// ---------------------------------------------------------------------------
// 业务码全表（按 provider 分族，对照上游调研的两套码表全量）
// ---------------------------------------------------------------------------

/**
 * zai / bigmodel 共享的码 → kind 表。
 *
 * 两家 family 是同一套网关的两个域名，业务码一致（`quota-rules.ts` 的既有结论）；
 * 下面按 `ProviderFamily` 分族只是保留「分叉时编译器在这里报缺项」的护栏。
 *
 * 上游码表另有 `1314`/`1315`/`1008`（泛终态业务）、`3001`（参数错）、闲时票据族
 * `3102`/`3104`/`3105`/`3106` 等码——本表未收录，命中未收录码走
 * 下面的保守策略（rate-limited + detail 带原码），不是静默丢弃。
 */
const SHARED_CODE_KINDS: ReadonlyMap<number, UpstreamSignalKind> = new Map<number, UpstreamSignalKind>([
  // --- quota-terminal（额度/权益终态，判 drained）---
  // 上游码表的「不重试」族：1005 是 claim 平面 quotaExhausted（`claim/types.ts`
  // 的官方 `$vt` mapper verbatim）；1113 是开放平台余额不足；1304 日调用限制 /
  // 1308 使用量上限 / 1309 Coding Plan 到期 / 1310 周月额度上限 / 1311 套餐无模型权限；
  // 1316-1321 额度/套餐边界族（TERMINAL_RATE_LIMIT_MAPPING，:297-314）。
  // 502 信封携带 1005 是 2026-11-09 实测形态。
  [1_005, "quota-terminal"],
  [1_113, "quota-terminal"],
  [1_304, "quota-terminal"],
  [1_308, "quota-terminal"],
  [1_309, "quota-terminal"],
  [1_310, "quota-terminal"],
  [1_311, "quota-terminal"],
  [1_316, "quota-terminal"],
  [1_317, "quota-terminal"],
  [1_318, "quota-terminal"],
  [1_319, "quota-terminal"],
  [1_320, "quota-terminal"],
  [1_321, "quota-terminal"],

  // --- fair-usage ---
  // 1313 fair usage restriction——上游原话「继续 retry 容易放大异常流量」，
  // 是风控标记不是速率窗口，所以独立成 kind（引擎侧长冷却 + 健康降权）。
  [1_313, "fair-usage"],

  // --- rate-limited（瞬时可重试）---
  // 上游码表的「会重试」族：1302 并发过高 / 1303 调用频率过高 / 1305 平台流量限制 /
  // 1312 模型访问负载过高（官方归 provider_overloaded，可重试语义同瞬时限流）/
  // 1120 临时账号访问异常（风控相关）/ 1230 API 调用流程异常 / 1234 网络错误
  // （三者官方归 model_request_failed 可重试，本层统一按瞬时可重试语义）。
  // 3002 请求过频 / 2007 上游 HTTP 异常（HTTP 500 信封携带业务码的同类形态，
  // 已实测）。
  // 3008/3009/3010 会话/模型级/当前模型并发上限（HTTP 429 + Retry-After 语义；
  // 官方客户端的细粒度重试豁免是客户端行为，本层只负责分类）。
  [1_302, "rate-limited"],
  [1_303, "rate-limited"],
  [1_305, "rate-limited"],
  [1_312, "rate-limited"],
  [2_007, "rate-limited"],
  [3_002, "rate-limited"],
  [1_120, "rate-limited"],
  [1_230, "rate-limited"],
  [1_234, "rate-limited"],
  [3_008, "rate-limited"],
  [3_009, "rate-limited"],
  [3_010, "rate-limited"],

  // --- auth ---
  // 3007 安全校验拒绝（HTTP 403，官方 AuthFailed→AuthRefresh；本仓验证码失败
  // 亦此码，`captcha-retry.ts` 在出线层单次重试消化，漏网的按 auth 处理）；
  // 1006 JWT 缺失/失效（AuthFailed→AuthRefresh）。裸 401/403 由 HTTP 状态判定，
  // 不靠码（见 signalFromResponse）。
  [3_007, "auth"],
  [1_006, "auth"],

  // --- model-level ---
  // 3006 模型不可用（响应可带 allowed_models 候选列表）；
  // 1261 上下文超窗（context_exceeded）。
  [3_006, "model-level"],
  [1_261, "model-level"],
]);

/**
 * 按 provider 分族的全表（这张表就是业务码分类的单一真相）。
 * 当前两族共享同一张表；真要分叉时换掉任一族的映射，漏项会在这里的类型上暴露。
 */
export const BUSINESS_CODE_KINDS: Record<ProviderFamily, ReadonlyMap<number, UpstreamSignalKind>> = {
  zai: SHARED_CODE_KINDS,
  bigmodel: SHARED_CODE_KINDS,
};

/**
 * 归一业务码：上游可能把码发成字符串（`"1113"`）。无法归一（`"abc"` / NaN）返回
 * `undefined`——与 `isQuotaExhaustedCode` 的既有纪律一致：错判两侧代价不对等，
 * 漏判只是晚一轮采样才降级，误判会把还能用的账号踢出候选集。
 */
function normalizeCode(code: number | string): number | undefined {
  const numeric = typeof code === "string" ? Number.parseInt(code, 10) : code;
  return Number.isFinite(numeric) ? numeric : undefined;
}

/**
 * 表查找（纯查表，无兜底）：命中返回 kind，未收录/不可归一返回 `undefined`。
 * 「未收录码 → 保守 rate-limited」是信号组装层的策略，见 `signalFromBusinessCode`。
 */
export function kindForBusinessCode(
  provider: ProviderFamily,
  code: number | string | undefined,
): UpstreamSignalKind | undefined {
  if (code === undefined) return undefined;
  const numeric = normalizeCode(code);
  if (numeric === undefined) return undefined;
  return BUSINESS_CODE_KINDS[provider].get(numeric);
}

/** 某族某 kind 的全部业务码（`quota-rules.ts` 并表的单一真相来源）。 */
export function codesOfKind(provider: ProviderFamily, kind: UpstreamSignalKind): readonly number[] {
  return [...BUSINESS_CODE_KINDS[provider].entries()].filter(([, k]) => k === kind).map(([code]) => code);
}

// ---------------------------------------------------------------------------
// 解析来源 ⓪：业务码 → 信号（两个来源共享的分类策略，200 信封形态也复用）
// ---------------------------------------------------------------------------

/**
 * 业务码 → 信号（含未收录码保守策略）。
 *
 * 未收录码 → `rate-limited`（保守：按瞬时限流处理，可重试语义）+ detail 带原码。
 * 这是**确定的保守策略**，不是回避探查：表外码的真实语义未知时，「冷却后可重试」
 * 比「误判终态踢出候选集」的代价小得多；码带在 detail 里，出现即能在日志里补表。
 */
export function signalFromBusinessCode(code: number | string): UpstreamSignal {
  return classifyBusinessCode(code).signal;
}

/**
 * 内部分解版：`known` 显式区分「查表命中」与「未收录码保守归类」，供
 * `signalFromResponse` 决定未收录码能否被强状态（401/403）覆盖——不从 detail
 * 形态反推。
 */
function classifyBusinessCode(code: number | string): { signal: UpstreamSignal; known: boolean } {
  // 解析来源不按 provider 分族：两族同表（见 SHARED_CODE_KINDS），分叉时这里要
  // 跟着 `signalFromResponse` 一起补族参数。
  const numeric = normalizeCode(code);
  const kind = numeric === undefined ? undefined : SHARED_CODE_KINDS.get(numeric);
  if (kind !== undefined) return { signal: { kind, code }, known: true };
  return { signal: { kind: "rate-limited", code, detail: truncateDetail(`未收录业务码 ${String(code)}`) }, known: false };
}

/** 把原始错误片段并进 `detail`（已有 detail 用「；」连接，整体仍截断 ≤200 字符）。 */
function mergeDetail(signal: UpstreamSignal, extra: string | undefined): UpstreamSignal {
  const merged = truncateDetail([signal.detail, extra === undefined ? "" : extra].filter((part) => part !== "").join("；"));
  return merged === undefined ? signal : { ...signal, detail: merged };
}

// ---------------------------------------------------------------------------
// 解析来源 ①：响应头 + 信封（全状态码）
// ---------------------------------------------------------------------------

/**
 * 观察一次上游响应，产出信号。
 *
 * `bodyText` 由调用方读出（透传路径用 `resp.clone().text()`，原体留给客户端）；
 * 2xx 不必读也不必传——正常成功响应体大，200 形态的错误判定交给流/翻译层。
 *
 * 判定级联（每级的实测/契约依据）：
 *
 * 1. 2xx → `success`（不读体）；
 * 2. 405 / 404 → `endpoint-shape`：官方立场是 405 = invalid_request，重试
 *    无用，修代码而不是重试；404 是弱信号（也可能只是请求的模型 id 不存在），
 *    detail 标注「可能为模型 id 不存在」；
 * 3. 有业务码 → 查表得 kind。**表优先于状态**：429 携带的终态码保持不重试（上游码表：
 *    即使由 HTTP 429 携带也保持非重试）；403 携带 1113 判 drained 是现有
 *    行为（403 也是业务码载体）。未收录码**不推翻**
 *    401/403 强状态（401 永远是 auth 的动作域，auth 失败与限流是两回事），落状态
 *    kind + detail 带原码；5xx/其他 4xx 的未收录码按保守 rate-limited
 *    （`signalFromBusinessCode` 的策略）；
 * 4. 无码：401/403 → `auth`；429 → `rate-limited`；5xx → `gateway`；4xx →
 *    `model-level`；
 * 5. `retry-after` 头（RFC 9110 delta-seconds 与 HTTP-date 两形态，沿用
 *    `parseRetryAfterSeconds`）→ `retryAfterSeconds`，**无 cap**（大值 = 窗口重置远，
 *    正是代理要的精确信号；官方客户端的 5min cap 是用户在界面等的妥协）。
 *    `x-should-retry` 头存在时照常解析——本层不特判它，它的透传语义由调用方决定。
 */
export function signalFromResponse(
  status: number,
  headers: Headers,
  bodyText?: string | null,
  now: number = Date.now(),
): UpstreamSignal {
  const retryAfterSeconds = parseRetryAfterSeconds(headers.get("retry-after"), now);
  const withRetryAfter = (signal: UpstreamSignal): UpstreamSignal =>
    retryAfterSeconds === undefined ? signal : { ...signal, retryAfterSeconds };

  // 2xx：不读体（bodyText 即便传了也不解析）。
  if (status >= 200 && status < 300) return withRetryAfter({ kind: "success" });

  // 405 / 404：端点形态问题，状态即结论（405 是「无码形态」，见全表注释）。
  if (status === 405) return withRetryAfter({ kind: "endpoint-shape", detail: truncateDetail("HTTP 405：端点/方法被上游拒绝") });
  if (status === 404) {
    return withRetryAfter({
      kind: "endpoint-shape",
      detail: truncateDetail(`HTTP 404：可能为模型 id 不存在${bodyText ? `；${bodyText}` : ""}`),
    });
  }

  const code = bodyText === undefined || bodyText === null ? undefined : upstreamBizCode(bodyText);
  if (code !== undefined) {
    const { signal: base, known } = classifyBusinessCode(code);
    const merged = mergeDetail(base, bodyText ?? undefined);
    // 未收录码不推翻 401/403 强状态（401 永远是 auth 的动作域，auth 失败与限流不能混）；
    // 429 的未收录码落点本来就是 rate-limited，与状态语义一致，不用特判。
    const kind = !known && (status === 401 || status === 403) ? "auth" : merged.kind;
    return withRetryAfter({ ...merged, kind });
  }

  if (status === 401 || status === 403) return withRetryAfter({ kind: "auth" });
  if (status === 429) return withRetryAfter({ kind: "rate-limited" });
  return withRetryAfter({ kind: status >= 500 ? "gateway" : "model-level" });
}

// ---------------------------------------------------------------------------
// 解析来源 ②：SSE error frame（HTTP 200 流内）
// ---------------------------------------------------------------------------

/**
 * 观察一个 SSE error frame（HTTP 200 流内），产出信号。
 *
 * 两种实测形态（SSE 流内错误）：
 *
 * - Anthropic 风格 `type:"error"` 帧：`error.type` / `error.message`（`frameType` /
 *   `message` 两个参数即这两段；Anthropic error.type → kind 映射零实证样本，不发明）；
 * - BigModel 强格式前缀 `[1302][...][request_id]`：error frame 只有 message 没有
 *   结构化 code，用正则 `^\[(\d{4})\](?=\[)` 提取四位业务码查表（与官方
 *   `provider-finish-business-error.ts:248-252` 同款提取）。
 *
 * 提取不到码 → `gateway`：上游流内错误默认按可重试处理。
 */
export function signalFromStreamError(frameType: string | undefined, message: string | undefined): UpstreamSignal {
  const frameDetail = truncateDetail(`${frameType === undefined ? "" : `${frameType}：`}${message ?? ""}`);
  const matched = message === undefined ? null : /^\[(\d{4})\](?=\[)/.exec(message);
  if (matched !== null) {
    // 已知码保留截断后的原文片段排障；未收录码的 detail 已带原码，归并原文即可。
    return mergeDetail(classifyBusinessCode(Number.parseInt(matched[1], 10)).signal, frameDetail);
  }
  return mergeDetail({ kind: "gateway" }, frameDetail);
}

// ---------------------------------------------------------------------------
// 解析来源 ③：空流
// ---------------------------------------------------------------------------

/**
 * 空流软拒绝信号：固定返回 `{kind:"empty-stream"}`，detail 由调用方附上下文。
 *
 * 检测本身（流式 0 events / 非流式非 Message 无业务码）由调用方判定，这里只提供
 * 信号形态。实测依据（2026-11-09）：25 条嫌疑全部 start-plan、coding-plan
 * 零命中、两账号反复、ttfb≈total 129-367ms——上游对不可用服务的 200 软拒绝，与
 * `{"code":1005}` 的 502 信封是**两种不同形态**（后者走来源①判 quota-terminal）。
 * 空流是账号级信号（同路由其他账号正常），不做路由级熔断。
 */
export function emptyStreamSignal(): UpstreamSignal {
  return { kind: "empty-stream" };
}

// ---------------------------------------------------------------------------
// detail 截断（≤200 字符）
// ---------------------------------------------------------------------------

const DETAIL_MAX_CHARS = 200;

/** 原始错误片段截断到 ≤200 字符（`UpstreamSignal.detail` 的契约）；空串不带 detail。 */
function truncateDetail(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  return trimmed.length <= DETAIL_MAX_CHARS ? trimmed : `${trimmed.slice(0, DETAIL_MAX_CHARS - 1)}…`;
}
