/**
 * 一次请求的「推理强度」：客户端到底要求了多少思考量。
 *
 * 为什么需要单独一个字段：三套入站协议各用一套词汇表达同一件事，而请求记录要能用
 * 一列读出来（日志表格的「推理强度」列）：
 *
 *   OpenAI chat        `reasoning_effort`（`low` / `medium` / `high` / …），
 *                      以及翻译层支持的 `thinking.budget_tokens`
 *   OpenAI Responses   `reasoning.effort`（`responses-to-chat.ts` 把它折成
 *                      `reasoning_effort`，但记录读的是**客户端原始形状**）
 *   Anthropic          `thinking.budget_tokens`（客户端直发），GLM-5.3 家族还会带
 *                      `output_config.effort`（`provider/reasoning.ts` 的文件头）
 *
 * 记录口径是**客户端要求的**强度，不是我们推导出来发往上游的值：`reasoning_effort`
 * 缺失时不补 `max`（那是 `translateGlm53Reasoning` 对 glm-5.3 的默认），因为「客户端
 * 没提」与「客户端要了 max」在排障时是两个不同的事实。同理，`thinking.type:
 * "enabled"` 且没给 budget 时记 `low` 而不是留空 —— SDK 会给它补
 * `GLM53_MIN_THINKING_BUDGET`（1024，落在 low 档），那是可推断的实际强度。
 *
 * 词汇表只有四档（`none` / `low` / `medium` / `high`）：这既是日志表格一列能装下的
 * 量级，也覆盖了上下游的全部档位。数值化的 budget 走 {@link effortFromBudget} 的
 * 三档映射（阈值与 GLM-5.3 的三个档位一一对应，见该函数注释）。
 */

/** 记录里 `reasoningEffort` 的取值域（`none` = 客户端明确关掉思考）。*/
export const REASONING_EFFORT_LEVELS = ["none", "low", "medium", "high"] as const;

/** 一次请求的推理强度档位（`RequestRecord.reasoningEffort` 的类型）。*/
export type ReasoningEffort = (typeof REASONING_EFFORT_LEVELS)[number];

/**
 * thinking budget → 档位的两个阈值（毫秒无关，单位是 token）。
 *
 * 取值来自 `provider/reasoning.ts::GLM53_THINKING_BUDGETS` 的三个档位
 * （8000 / 16000 / 32000）取相邻中点：8000 落 `low`、16000 落 `medium`、
 * 32000 落 `high`，每个规范档位都映射到唯一一档，不出现「同为 low 档的
 * 8000 与 15999 显示不同」这种反直觉结果。
 *
 * 用中位数阈值而不是「小于等于规范值」的理由：客户端会给任意 budget
 * （`12000` 这种夹在中间的值很常见），「≤8000 才是 low」会把 9000 也归进
 * medium，与它实际的思考量不符。中点阈值在分档边界上各让一半，最不容易错。
 */
const BUDGET_LOW_MAX = 12_000;
const BUDGET_MEDIUM_MAX = 24_000;

/**
 * thinking budget（token）→ 档位。
 *
 * 非有限数、非正数一律 `undefined`：那是「没给」，不是「0 思考」，调用方按各协议
 * 的默认值决定要不要补 `low`（见 {@link reasoningEffortFromBody}）。
 */
export function effortFromBudget(budget: unknown): ReasoningEffort | undefined {
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) return undefined;
  if (budget <= BUDGET_LOW_MAX) return "low";
  if (budget <= BUDGET_MEDIUM_MAX) return "medium";
  return "high";
}

/**
 * 任意 effort 标签 → 四档。认不出来的标签返回 `undefined`（不猜）。
 *
 * 词表来自三处客户端：
 * - OpenAI 官方：`minimal` / `low` / `medium` / `high`；
 * - OpenAI 扩展：`none` / `xhigh`；
 * - Z.AI 目录 + 本仓 `normalizeGlm53Effort` 见过的：`light` / `max` / `ultra`。
 *
 * 映射方向是**保守**的：`xhigh` / `max` / `ultra` 归 `high`（四档词汇里没有更细的
 * 档），`minimal` / `light` 归 `low`。不做「认不出就当 medium」的默认——那会让
 * 「客户端发了非标准值」与「客户端要了 medium」在记录上不可分辨。
 */
export function normalizeEffortLabel(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "none":
    case "off":
    case "disabled":
      return "none";
    case "minimal":
    case "light":
    case "low":
      return "low";
    case "medium":
    case "mid":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
    case "ultra":
      return "high";
    default:
      return undefined;
  }
}

/**
 * 入参是 `JSON.parse` 的产物（形状不受控），先收敛成「键值对象或 undefined」。
 *
 * 数组也算「不是对象」：请求体可能是 `[{…}]` 这种畸形值，把它当对象读字段只会
 * 读到 `undefined`，不如在这里一次判掉。
 */
function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * 请求体（已 parse 的 JSON 对象）→ 推理强度。三套协议共用这一处实现。
 *
 * 判定顺序（先具体后宽泛，第一个有结论的胜出）：
 *
 * 1. `thinking.type === "disabled"` → `none`。客户端明确关掉思考是最强信号，
 *    优先于同时出现的 budget / effort 标签（上游可能忽略标签，但客户端意图明确）。
 * 2. `thinking.budget_tokens` 有效正数 → {@link effortFromBudget}。budget 是真正
 *    驱动上游思考量的那个数字（`provider/reasoning.ts` 文件头：只发标签不发
 *    budget，上游仍按自己的近零默认跑），所以它比标签更可信。
 * 3. `output_config.effort` → {@link normalizeEffortLabel}。GLM-5.3 家族的
 *    Anthropic 侧扩展通道，ZCode 客户端在 `/v1/messages` 上直发它。
 * 4. `reasoning_effort` → {@link normalizeEffortLabel}。OpenAI chat 的标准字段。
 * 5. `reasoning.effort` → {@link normalizeEffortLabel}。Responses 的原始形状
 *    （`responses-to-chat.ts` 会把它折成 `reasoning_effort`，但记录读客户端原始
 *    body，不能指望那条翻译先跑过）。
 * 6. `thinking.type` 是 `enabled` / `adaptive` 且没给可用 budget → `low`。SDK 会
 *    补 1024（`GLM53_MIN_THINKING_BUDGET`），落在 low 档，因此这是可推断的强度，
 *    而不是「客户端没说」。
 *
 * 都没有 → `undefined`（记录里整键省略；旧记录同样缺这个键，聚合归 `-` 桶）。
 */
export function reasoningEffortFromBody(body: unknown): ReasoningEffort | undefined {
  const root = asObject(body);
  if (root === undefined) return undefined;
  const thinking = asObject(root.thinking);
  const thinkingType = thinking?.type;
  if (thinkingType === "disabled") return "none";

  const fromBudget = effortFromBudget(thinking?.budget_tokens ?? thinking?.budgetTokens);
  if (fromBudget !== undefined) return fromBudget;

  const fromOutputConfig = normalizeEffortLabel(asObject(root.output_config)?.effort);
  if (fromOutputConfig !== undefined) return fromOutputConfig;

  const fromReasoningEffort = normalizeEffortLabel(root.reasoning_effort);
  if (fromReasoningEffort !== undefined) return fromReasoningEffort;

  const fromResponses = normalizeEffortLabel(asObject(root.reasoning)?.effort);
  if (fromResponses !== undefined) return fromResponses;

  if (thinkingType === "enabled" || thinkingType === "adaptive") return "low";
  return undefined;
}
