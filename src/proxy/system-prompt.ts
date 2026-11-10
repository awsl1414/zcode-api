/**
 * ZCode system-prompt assembly — a faithful mirror of the desktop client's
 * ContextBuilder (ZCode 3.17.1, `_reverse/glm/zcode.cjs` `Y8e`;
 * 3.16.3 `Fje` — the 3-block wire shape is byte-identical across
 * 3.12.3→3.17.1, `_reverse/NOTEPAD.md` "3.17.1 增补" 四轮).
 *
 * The gateway does content inspection — if it doesn't see the ZCode identity
 * blocks in the `system` field, it rejects with 3012 "method not allowed".
 * Beyond the identity marker, the real client's assembly has a precise shape
 * (all symbols verified in the 3.17.1 bundle):
 *
 *   `assembleSystemMessages` (`Y8e#assembleSystemMessages`, `Lxt` join)
 *   groups the built sections into EXACTLY 3 wire blocks:
 *     1. cli_prefix alone — NO cache_control since 3.15.1 (3.12.3–3.14.4
 *        carried ephemeral here; the wire serializer maps absent cacheControl
 *        to an omitted `cache_control` key)
 *     2. every other STABLE section, `\n\n`-joined (`Lxt`), ephemeral
 *     3. every DYNAMIC section, `\n\n`-joined, with an explicit `"\n\n"`
 *        prefix on the block text, ephemeral
 *
 *   The minimal mirrored set (config-dependent sections — Session Guidance,
 *   Memory, skills, agentsMd — are absent, which is a real, common client
 *   state):
 *     block 2: Agent Identity (`wDn`/`fBa` — default branch `dBa` identity +
 *              `nBo` security notice + `SDn` Harness; bullets carry a leading
 *              space since 3.17.1, bullet 3 takes the `e=!0` default branch).
 *              The desktop client appends ZCode Desktop Context (`WDn`,
 *              presentationSurface === "zcode_desktop" gate) here; the proxy
 *              deliberately does NOT (CLI-face traffic never carries it —
 *              see buildStartPlanSystem).
 *     block 3: EMPTY (minimal-set anchoring 2026-10-30) — official 3.17.1
 *              clients ship the Dynamic Behavior (`TBo`) + Context
 *              Management (`IBo`) duo; the gateway constrains neither
 *              (probe M1/M3/N09), so the proxy omits it for token economy.
 *              3.17.1 moved Environment Info (`mSo`/`hSo`), Model Identity
 *              (`YTn`, the powered-by line) and Current Date (`fce`) out of
 *              the system blocks into meta_user attachments regardless.
 *
 *   meta_user attachments (`GDn` + request-time `$5o`): the client attaches
 *   a standalone "date" attachment — `Today's date is YYYY-MM-DD.` (local
 *   date, no heading since 3.17.1) — to the first user turn, rendered as a
 *   `<system-reminder>`-wrapped text block. {@link buildCurrentDateMessage}
 *   mirrors it (stateless per-request approximation of the fresh-session
 *   attachment; environment/model attachments are session-state reconciled
 *   and intentionally not mirrored).
 *
 * Static section texts live in zcode_system.json (sidecar asset, inlined into
 * the single-file binary via the json import attribute); that sidecar is the
 * only record of the official section texts.
 *
 * @see zcode_system.json
 */
// Inlined as a build-time constant (Bun `json` import attribute) so it ships
// inside the single-file compiled binary — a runtime
// `readFileSync` would resolve `__dirname` to the build-time CI path and crash
// with ENOENT on every other host. @see types.d.ts
import data from "./zcode_system.json" with { type: "json" };

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

const EPHEMERAL: { type: "ephemeral" } = { type: "ephemeral" };

// ---------------------------------------------------------------------------
// 客户端身份归一的三层实现：把第三方客户端写进 system 的产品名与模型名换成
// ZCode 官方的身份句。
//
// 唯一的泄露点：客户端 system 原文被原样送上游，Anthropic 路由进 block 3
// （客户端文本整段替换动态二连的形态），OpenAI 路由留在客户端自己的 system 消息里。
// 第三方客户端会带进两类身份断言：
//   A 类 产品自称：`You are Cline, …` / `Your name is Junie.`
//   B 类 模型归属：`You are powered by the model named Sonnet 4.5. The exact model
//     ID is claude-sonnet-4-5-20250929.`（同时断言模型名与模型 id）
// 二者都与请求头 `User-Agent: ZCode/…` + 上游实为 GLM 的事实互相矛盾，是上游风控
// 最容易抓的内部不一致。调研实测：50 条代表性身份句里 49 条 no-match
// （证据见 `docs/research/client-fingerprints.md` 的「我们的归一覆盖情况」一节）。
//
// 三层：
//   1. 文本预处理：NBSP → 普通空格（{@link CLIENT_IDENTITY_NBSP}）
//   2. 身份句归一：按**句式类**处理（A1/A4 品牌自称、A2 角色句、B1/B2 模型
//      归属句），不按客户端逐一列举（{@link CLIENT_IDENTITY_RULES}）
//   3. 路由覆盖：两个路由共用 {@link normalizeClientSystem}
//
// 只做**精确句式**（整句，或由系动词/固定短语限定作用域的句内替换），不做全文
// `Claude` → `ZCode`：全文替换会误伤用户代码与正常讨论（`claudeCode` 变量、
// `CLAUDE_MODEL` 环境变量、"Claude wrote this" 这类叙述），而身份声明只需要归一
// 那几句。功能性内容
// （`<system-reminder>`、环境信息、工具规则）原样保留。A3（无品牌通用句）与
// C 类（反向指令）**不处理**。
//
// 证据：docs/research/client-fingerprints.md（58 条身份句、8 类模板、逐条
// `path:line`）。
// ---------------------------------------------------------------------------

/**
 * 身份归一的替换目标（A 类自称句与 B 类模型归属句共用）：官方 cli_prefix
 * （bundle `uBa`，`zcode_system.json` 的 `cliPrefix`）+ 句末句点。
 *
 * 措辞直接取自 sidecar 的官方身份文本：3.17.1 已把 Model Identity
 * （`YTn`，powered-by 行）移出 system blocks 进 meta_user 附件（`zcode_system.json`
 * 只保留 system 侧的稳定段），所以真实客户端 system 里既没有 powered-by 行，也不该由代理
 * 伪造一条；B 类必须整句替换成官方身份句，形态与真实 3.17.1 客户端一致。
 */
const CLIENT_IDENTITY_SENTENCE_ZCODE = `${data.cliPrefix}.`;

/**
 * 第一层：文本预处理。`Trae/Chat Prompt.txt` 用 NBSP（U+00A0）当词间空格
 * （520 处，`You\u00a0are\u00a0Trae\u00a0AI`），逐字精确匹配会**静默失效**
 * （`docs/research/client-fingerprints.md` 的实测一节）。全仓扫描确认 NBSP 只出现在 2 份资料
 * 文件、且只有 Trae 那份污染身份句，转换无害。
 * 归一化只在开关打开时发生；开关关闭时逐字节原样透传。
 */
const CLIENT_IDENTITY_NBSP = /\u00a0/g;
const CLIENT_IDENTITY_PLAIN_SPACE = " ";

/**
 * A 类：品牌自称 / 名字声明 / 角色句里的产品名（A1 / A2 / A4 三种形态合一）。
 *
 * 一个模式覆盖全部 A 类作用域：品牌必须紧跟一个**身份短语**才算身份声明，
 * 因此仍然精确、可审：
 *   A1  `You are <产品>, …` / `I'm <产品>`        （品牌紧跟身份系动词）
 *   A4  `Your name is <产品>.`                      （名字声明）
 *   A2  `… You operate [exclusively] in <产品>`     （角色句的产品位）
 *   A1 尾句 `… developed by the <产品> team.`      （品牌在同句尾部再现一次）
 *
 * 只换**品牌词**、保留其余文字（`a highly skilled software engineer …` 这类行为
 * 约束、`the world's best IDE` 这类描述），功能性内容全部保留。
 * 品牌枚举（每个一条证据，资料仓库 `path:line`，见
 * `docs/research/client-fingerprints.md` 的「客户端清单」一节与附录 B）：
 *   Cline      `Open Source prompts/Cline/Prompt.txt:1`
 *   Roo        `Open Source prompts/RooCode/Prompt.txt:1`
 *   Kilo       `Open Source prompts/Kilo Code/Agent Prompt (kilo.auto-free) 2026-09-11.txt:1`
 *   CodeBuddy  `CodeBuddy Prompts/Craft Prompt.txt:3`
 *   opencode   `Open Source prompts/OpenCode/Agent Prompt (big.pickle) 2026-09-11.txt:1`
 *   Qoder      `Qoder/prompt.txt:5` + PR #502 `Qoder CN/Prompt.txt:1`
 *   Trae AI    `Trae/Chat Prompt.txt:2`（原文词间是 NBSP，靠第一层归一）
 *   Junie      `Junie/Prompt.txt:2`（A4 形态 `Your name is Junie.`）
 *   Cursor     `Cursor Prompts/Chat Prompt.txt:1`（仅 A2 位：B2 规则会留下
 *              `You operate in Cursor.` 这半句，必须同时归）
 * 长名在前（`Trae AI` 先于任何短名），避免短名先吃掉长名前缀。
 */
const CLIENT_IDENTITY_BRAND_TOKEN =
  /((?:You are|You're|I am|I'm|Your name is|You operate (?:exclusively )?in|developed by the)\s+)(?:Cline|Roo|Kilo|CodeBuddy|opencode|Qoder|Trae AI|Junie|Cursor)\b/g;

/**
 * B1：模型归属句（**最严重**：它同时断言了模型名与模型 id）。
 * `You are powered by the model named <M>. The exact model ID is <id>.`
 * 9 处实例、模型名可变，只能模式匹配（`docs/research/client-fingerprints.md` 附录 B 第 51 条）。
 * 用「前缀 + 句末锚点」的结构化匹配：惰性 `.+?` 吃到第一个
 * `. The exact model ID is ` 之前，所以模型名里的句点（`Sonnet 4.5`）不会截断；
 * id 段同样惰性，并要求后面是句界（`\s` / 行尾），因为真实模型 id 也可能带句点
 * （`glm-4.6`）；若用「禁句点」会把 `glm-4.6.` 截成 `glm-4.`，留下残句 `6.`。
 */
const CLIENT_MODEL_ATTRIBUTION_B1 = /You are powered by the model named .+?\. The exact model ID is [^\n]+?\.(?=\s|$)/g;

/**
 * B2：句内模型署名（附录 B 第 52–56 条）。
 * `You are an AI coding assistant, powered by <M>.`
 * 模型名可变（`GPT-5` / `GPT-4o` / `Claude Sonnet 4` / `GPT-4.1`），只能模式匹配。
 * 冠词位有三个实测变体：`an` / `a`（Cursor 四版）、`a an`
 * （`Cursor Prompts/Chat Prompt.txt:1` 原文笔误）、`∅`（Same.dev `You are AI
 * coding assistant and agent manager, …`），枚举它们而不是用宽松的 `\w+`。
 * 模型名惰性 + 句界 lookahead：`GPT-4.1` 这类带句点的名字不能被截断。
 */
const CLIENT_MODEL_ATTRIBUTION_B2 = /You are (?:an?|a an)?\s*AI coding assistant[^.\n]*?, powered by [^\n]+?\.(?=\s|$)/g;

/** 一条身份归一规则：作用域由 `pattern` 自身限定（整句或固定短语）。 */
interface ClientIdentityRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * 规则表：**按序应用**，整句（长、具体）优先于句内短语，
 * 避免短规则先吃掉长句的一部分造成半归一。
 *
 * 幂等性：任何一条规则的产物都不再被后续规则或自身匹配
 * （替换目标 `ZCode` / `ZCode CLI` 不在任何规则的品牌枚举里），因此对已归一文本
 * 再跑一次输出完全相同。
 */
const CLIENT_IDENTITY_RULES: readonly ClientIdentityRule[] = [
  // B1：模型归属句（整句，最长最具体）
  { pattern: CLIENT_MODEL_ATTRIBUTION_B1, replacement: CLIENT_IDENTITY_SENTENCE_ZCODE },
  // B2：句内模型署名（整句）
  { pattern: CLIENT_MODEL_ATTRIBUTION_B2, replacement: CLIENT_IDENTITY_SENTENCE_ZCODE },
  // A1：Claude Code 2.0.0 身份句（整句；含 `Claude agent` + `Anthropic's Claude Agent SDK`）
  { pattern: /You are a Claude agent, built on Anthropic's Claude Agent SDK\./g, replacement: CLIENT_IDENTITY_SENTENCE_ZCODE },
  // A1：Claude Code 2.1 身份句（整句）
  { pattern: /You are Claude Code, Anthropic's official CLI tool for Claude\./g, replacement: CLIENT_IDENTITY_SENTENCE_ZCODE },
  // 品牌化 CLI 短语
  { pattern: /Anthropic's official CLI tool/g, replacement: "ZCode CLI" },
  // 身份句内的独立 `Claude Code`
  { pattern: /((?:You are|You're|I am|I'm)\s+)Claude Code\b/g, replacement: "$1ZCode" },
  // A 类：品牌自称 / 名字声明 / 角色句 / vendor team（A1 / A2 / A4 合一）
  { pattern: CLIENT_IDENTITY_BRAND_TOKEN, replacement: "$1ZCode" },
];

/** 归一开关：默认开；关闭后逐字节回到原文透传行为。config 开关留待后续接通。 */
const NORMALIZE_CLIENT_SYSTEM_ENV = "ZCODE_NORMALIZE_CLIENT_SYSTEM";
/** 关闭取值的白名单（小写比较），其余取值（含未设置）都视为开启。 */
const NORMALIZE_CLIENT_SYSTEM_OFF_VALUES = new Set(["0", "false", "no"]);

/**
 * 客户端身份归一（第二层）：把明确的身份声明句式换成 ZCode 对应句式。
 *
 * 先做 NBSP → 空格预处理（第一层），再按 {@link CLIENT_IDENTITY_RULES} 顺序应用
 * 全部规则。只做精确句式：不做全文 `Claude` → `ZCode` 替换（见文件上方常量区说明）。
 */
export function normalizeClientSystemText(text: string): string {
  let out = text.replace(CLIENT_IDENTITY_NBSP, CLIENT_IDENTITY_PLAIN_SPACE);
  for (const rule of CLIENT_IDENTITY_RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

/**
 * 归一开关是否开启：`ZCODE_NORMALIZE_CLIENT_SYSTEM` 为 `0` / `false` /
 * `no`（大小写不敏感）时关闭，其余情况（含未设置）开启。逐请求读取，便于测试
 * 与运行时热切换。
 */
function clientSystemNormalizationEnabled(): boolean {
  const raw = process.env[NORMALIZE_CLIENT_SYSTEM_ENV];
  if (raw === undefined) return true;
  return !NORMALIZE_CLIENT_SYSTEM_OFF_VALUES.has(raw.trim().toLowerCase());
}

/**
 * 客户端 system 文本归一的**唯一入口**（含开关），两个路由共用（第三层：归一
 * 必须走同一个函数，否则会分叉）：
 *   - Anthropic 路由：block 3 内容（{@link buildStartPlanSystem}）
 *   - OpenAI 路由：客户端自己的 `system` / `developer` 消息（`body-transformer.ts`
 *     的 `applyStartPlanOpenAISystem`）
 * 开关关闭时返回原文（逐字节不变）。
 */
export function normalizeClientSystem(text: string): string {
  return clientSystemNormalizationEnabled() ? normalizeClientSystemText(text) : text;
}

/**
 * block 3 的内容：客户端文本先过身份归一，开关关闭时原样透传；没有
 * 非空客户端 system 时为空串（minimal-set 默认形态）。
 */
function blockThreeText(custom: string | undefined): string {
  if (custom === undefined) return "";
  return normalizeClientSystem(custom);
}

/** Bundle `pK`-family (`_Ne`): local `YYYY-MM-DD`, zero-padded. */
export function formatLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Prepend the official ZCode gateway blocks to the request's `system` field,
 * mirroring `assembleSystemMessages`.
 *
 * ALWAYS the 3-block shape (cli_prefix plain, stable and dynamic blocks
 * ephemeral, dynamic block `\n\n`-prefixed).
 *
 * DELIBERATE DEVIATION from the desktop client's stable block: the ZCode
 * Desktop Context section (3.17.1 `WDn`, ~1.8KB) is NOT injected. It is gated
 * on `presentationSurface === "zcode_desktop"` in the real client, so CLI-face
 * traffic never carries it — a real, common client state. The start-plan
 * gateway requires the stable block to OPEN with the full identity text but
 * does not require Desktop Context behind it (probe matrix 2026-10-27,
 * `_reverse/NOTEPAD.md` "3.16.3 增补" 的实测矩阵；两种形态都回 200).
 *
 * Client system present → its normalized text becomes the ENTIRE block-3
 * content behind the `\n\n` prefix, REPLACING the official dynamic duo
 * form, user-approved 2026-10-27 after the live matrix proved block 3 is
 * unconstrained — empty string, 1 char, whitespace-only and arbitrary client
 * text all pass). Block 2 then stays the byte-exact pure stable text, immune
 * to a prefix→exact gateway tightening, and the client text rides the
 * loosest-validated block. Client system ABSENT → EMPTY block 3 (the
 * 2026-10-30 "minimal set" anchoring: official-default duo deliberately NOT
 * mirrored, saving 322 tokens/request (measured 2026-10-30: duo 584 vs
 * empty 262 input_tokens on the cache-miss stateless path); live matrix
 * M1/M3/N09 prove block 3
 * carries no constraints — see NOTEPAD "3.17.1 增补" 六轮).
 * Multiple client text blocks are `\n\n`-joined into one string; client
 * `cache_control` is dropped (the stable block owns its single ephemeral
 * breakpoint — no new breakpoints are introduced).
 *
 * The joined client text passes through {@link normalizeClientSystemText}
 * before it lands in block 3 (identity normalization — block 3 is
 * the one place a third-party client's "You are Claude Code, Anthropic's
 * official CLI tool for Claude." would otherwise contradict the
 * `User-Agent: ZCode/…` headers). `ZCODE_NORMALIZE_CLIENT_SYSTEM=0|false|no`
 * restores byte-identical passthrough.
 */
export function buildStartPlanSystem(existingSystem: unknown): SystemBlock[] {
  const custom = customSystemText(existingSystem);
  const stable = data.stableSections.join("\n\n");
  // 客户端文本替换动态二连，作为 block 3 的内容。默认（客户端没带 system）走
  // **空 block 3**——即网关锚定的最小集（2026-10-30 探针 M1：block 3 完全不受
  // 约束；官方默认的动态二连是有意省掉的偏离，每请求省 322 token——实测二连
  // 584、空块 262 input_tokens，缓存未命中的无状态路径）。空 block 3 与「客户端
  // 文本为空串」不可区分——实测矩阵证明这种形状能过网（9.5KB 的真实 opencode
  // prompt 走的是同一个位置，docker e2e 2026-10-30）。二连的文本仍留在
  // zcode_system.json 里，作为官方形状记录与将来重新镜像的来源。
  // 身份归一：只作用于进入 block 3 的客户端文本；block 1（cli_prefix）与
  // block 2（稳定段）是官方 ZCode 文本，本来就是 ZCode，不经过归一。开关关闭时
  // 逐字节回到原文透传行为。
  const dynamic = blockThreeText(custom);
  return [
    { type: "text", text: data.cliPrefix },
    { type: "text", text: stable, cache_control: { ...EPHEMERAL } },
    { type: "text", text: dynamic === "" ? "" : `\n\n${dynamic}`, cache_control: { ...EPHEMERAL } },
  ];
}

/**
 * The meta_user "date" attachment (3.17.1 `$5o`/`fce`): a leading user turn
 * whose single text block is `Today's date is YYYY-MM-DD.` (no heading —
 * 3.16.x carried a `# currentDate` heading inside the context_prefix; the
 * whole context_prefix intro/outro wrapper was removed in 3.17.1) wrapped in
 * `<system-reminder>…</system-reminder>` (no inner padding newlines).
 */
export function buildCurrentDateMessage(now?: Date): { role: "user"; content: SystemBlock[] } {
  const date = formatLocalIsoDate(now ?? new Date());
  const body = data.currentDate.line.replace("{date}", date);
  return {
    role: "user",
    content: [{ type: "text", text: `${data.systemReminder.open}${body}${data.systemReminder.close}` }],
  };
}

/**
 * Client system → the single customSystemPrompt string (bundle semantic:
 * `customSystemPrompt?.trim()`). String input is used as-is (trimmed);
 * array input's text blocks are `\n\n`-joined into one string — the real
 * client carries exactly one custom prompt string, never a block list.
 * Returns undefined when there is no non-empty text (whitespace-only
 * systems take the default identity path, matching `!!o` in the bundle).
 */
function customSystemText(system: unknown): string | undefined {
  if (system == null) return undefined;
  if (typeof system === "string") {
    const text = system.trim();
    return text ? text : undefined;
  }
  if (!Array.isArray(system)) return undefined;
  const parts: string[] = [];
  for (const item of system) {
    if (typeof item === "string") {
      if (item.trim()) parts.push(item);
    } else if (item && typeof item === "object") {
      const b = item as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        // cache_control intentionally dropped — see buildStartPlanSystem doc.
        parts.push(b.text);
      }
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
