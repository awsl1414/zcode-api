/**
 * Request body transformer — applies ZCode-equivalent body mutations before
 * forwarding upstream. All transformations are no-ops on parse failure (the
 * original body is returned unchanged) so a malformed body never breaks the
 * proxy: it just loses the optimization.
 *
 * Transformations applied:
 *   1. OpenAI + `stream: true` → inject `stream_options.include_usage: true`
 *      (matches `@ai-sdk/openai-compatible` default in `_reverse/zcode.cjs`).
 *   2. start-plan → prepend ZCode gateway system blocks. OpenAI upstream gets
 *      system messages; Anthropic-shaped input gets the Anthropic `system` field.
 *      Both routes run the client's own system text through the SAME
 *      `normalizeClientSystem` identity normalizer (the third layer of the
 *      client-identity normalization):
 *      Anthropic via block 3, OpenAI via the client's `system`/`developer`
 *      messages (which used to pass through verbatim).
 *   3. Anthropic format → clear existing `cache_control` markers on all
 *      non-system messages, then add `{ type: "ephemeral" }` to the last
 *      content block of the last non-system message (mirrors the bundle's
 *      `zsi`+`Fsi` pair). Anthropic's API silently ignores `cache_control`
 *      below the per-model token floor, so unconditional marking is safe and
 *      matches ZCode's `applyCacheControl: true` default.
 *   4. Anthropic format + `ctx.metadataUserId` set → inject
 *      `metadata: { user_id }` (bundle `E2e`/`UIo` device/session blob —
 *      value assembled by the caller via buildAnthropicMetadataUserId).
 *   5. Anthropic format + `ctx.effortOverride` set → rewrite the request to
 *      the panel-configured reasoning tier (via the shared
 *      applyEffortOverrideToBody). Only the Anthropic branch needs it: the
 *      OpenAI/Responses translation chains converge to Anthropic shape
 *      BEFORE transformRequestBody runs, and the Anthropic passthrough body
 *      is already client-shaped. Every upstream-bound call site passes the
 *      tier resolved by provider/effort-override.ts (which also lands it on
 *      the request record, so resolve and rewrite cannot disagree):
 *      proxy/handler.ts (chat + Anthropic passthrough), proxy/
 *      responses-handler.ts (the /v1/responses route assembles its own
 *      outbound body and does NOT go through proxyRequest), and
 *      async/handler.ts (both off-peak inbound protocols).
 *
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import type { Format } from "../translator/types.js";
import { applyEffortOverrideToBody, type EffortOverride } from "../provider/effort-override.js";
import { buildStartPlanSystem, buildCurrentDateMessage, normalizeClientSystem } from "./system-prompt.js";

interface TransformContext {
  format: Format;
  /**
   * When set, the Anthropic-format body gets `metadata.user_id` injected.
   * Callers pass the bundle's device/session blob (see
   * buildAnthropicMetadataUserId in trace-headers.ts) — real traffic never
   * carries the account uuid here (account_uuid is hardcoded "" upstream).
   */
  metadataUserId?: string;
  /**
   * 代填 ZCode 网关的 system 三块 + 客户端 system 身份归一。
   * 取值来自路由事实 `RouteSpec.injectsZcodeSystemPrompt`（只有 `start-plan` 为真：
   * zcode.z.ai 网关缺身份块回 3012）；不开仿冒层的路由因此天然不注入。
   */
  injectZcodeSystem?: boolean;
  /**
   * Active upstream provider — feeds the powered-by line's `{providerId}/`
   * prefix (bundle `p2`: zai→"zai-api", bigmodel→"bigmodel-api"). Always set
   * by production callers alongside `injectZcodeSystem`.
   */
  provider?: "zai" | "bigmodel";
  /**
   * 面板推理强度覆盖命中时的档位（resolve 结果）。undefined = 透传，
   * body 一个字不改。只对 Anthropic 形态的 body 生效——OpenAI/Responses 入站
   * 在进本函数前已归一为 Anthropic（见文件头第 5 条），出线的 body 只此一种。
   */
  effortOverride?: EffortOverride;
}

/**
 * Apply body transformations. Returns the original `body` string when nothing
 * changed OR when parsing failed; otherwise returns the re-serialized body.
 */
export function transformRequestBody(body: string | undefined, ctx: TransformContext): string | undefined {
  if (body === undefined || body.length === 0) return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof parsed !== "object" || parsed === null) return body;

  let modified = false;

  if (ctx.format === "openai") {
    if (ctx.injectZcodeSystem) {
      modified = applyStartPlanOpenAISystem(parsed as Record<string, unknown>) || modified;
    }
    modified = applyStreamOptionsIncludeUsage(parsed as Record<string, unknown>) || modified;
  }
  if (ctx.format === "anthropic") {
    const obj = parsed as Record<string, unknown>;
    if (ctx.injectZcodeSystem) {
      modified = applyStartPlanSystem(obj) || modified;
    }
    modified = applyAnthropicCacheControl(obj) || modified;
    if (ctx.metadataUserId) {
      modified = applyAnthropicUserId(obj, ctx.metadataUserId) || modified;
    }
    if (ctx.effortOverride !== undefined) {
      modified = applyEffortOverrideToBody(obj, ctx.effortOverride).changed || modified;
    }
  }

  return modified ? JSON.stringify(parsed) : body;
}

/** OpenAI streaming: ensure `stream_options.include_usage: true`. */
function applyStreamOptionsIncludeUsage(body: Record<string, unknown>): boolean {
  if (body.stream !== true) return false;
  const existing = body.stream_options;
  if (isPlainObject(existing) && existing.include_usage === true) {
    return false;
  }
  const merged: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
  merged.include_usage = true;
  body.stream_options = merged;
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Anthropic: two-phase cache_control injection, mirroring the bundle's
 * `zsi` (clear) + `Fsi` (mark) pair:
 *   (1) strip `cache_control` from every content block of every NON-system
 *       message (string content carries no marker to clear);
 *   (2) mark the last content block of the LAST non-system message (existing
 *       location algorithm) with `{type: "ephemeral"}`; string content is
 *       converted to a block array first (kept from the previous behavior).
 *
 * Without the clear phase, client-supplied `cache_control` on earlier messages
 * would pass through alongside our marker → multiple cache breakpoints and
 * more cache writes than the real client produces. The top-level `system`
 * field is untouched. The bundle's skipCacheWrite variant (marks the
 * second-to-last message instead) is NOT implemented — this proxy always
 * writes cache.
 *
 * Output-stable: applying this to an already-canonical body yields the same
 * bytes (no duplicate markers, target block unchanged). Note the function
 * still reports `modified` in that case — the clear phase strips the target
 * block's own marker before phase 2 re-adds the identical one — so callers
 * re-serialize once more; harmless (byte-identical output), just not free.
 */
function applyAnthropicCacheControl(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;

  // Phase 1 (bundle `zsi`): clear stale markers on non-system messages.
  let cleaned = false;
  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    if (msg.role === "system") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (typeof block === "object" && block !== null && "cache_control" in block) {
        delete block.cache_control;
        cleaned = true;
      }
    }
  }

  // Phase 2 (bundle `Fsi`): mark the last non-system message's last block.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg !== "object" || msg === null) continue;
    if (msg.role === "system") continue;

    if (typeof msg.content === "string") {
      msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
      return true;
    }
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const lastBlock = msg.content[msg.content.length - 1];
      if (typeof lastBlock === "object" && lastBlock !== null && !lastBlock.cache_control) {
        lastBlock.cache_control = { type: "ephemeral" };
        return true;
      }
      // Already marked — only report modified if the clear phase stripped
      // stray markers elsewhere (idempotency: avoid needless re-serialize).
      return cleaned;
    }
    return cleaned;
  }
  return cleaned;
}

/**
 * Anthropic: inject `metadata: { user_id }` when not already set.
 * Preserves any existing `metadata.*` fields other than `user_id`.
 */
function applyAnthropicUserId(body: Record<string, unknown>, userId: string): boolean {
  const existing = body.metadata;
  if (isPlainObject(existing) && existing.user_id === userId) {
    return false;
  }
  body.metadata = {
    ...(isPlainObject(existing) ? existing : {}),
    user_id: userId,
  };
  return true;
}

/**
 * start-plan: prepend ZCode gateway system blocks (ContextBuilder mirror —
 * see system-prompt.ts). The gateway rejects requests without these identity
 * blocks with 3012 "method not allowed". Since 3.17.1 the system blocks carry
 * no Environment/powered-by content (the client moved those to meta_user
 * attachments), so `body.model` no longer feeds the assembly; the meta_user
 * "date" attachment (`Today's date is …` `<system-reminder>` user turn) that
 * every real client request carries is attached instead. Client
 * `cache_control` on tools is stripped: official blocks (3) + last-message
 * marker (1) already fill Anthropic's 4-breakpoint cache budget.
 */
function applyStartPlanSystem(body: Record<string, unknown>): boolean {
  body.system = buildStartPlanSystem(body.system);
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    body.messages = [buildCurrentDateMessage() as unknown, ...body.messages];
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (typeof tool === "object" && tool !== null && "cache_control" in tool) {
        delete (tool as Record<string, unknown>).cache_control;
      }
    }
  }
  return true;
}

/**
 * OpenAI 的 system 系角色。`developer` 与 `system` 在翻译器里同样被折进上游的
 * `system` 段（`openai-to-anthropic.ts:34`：`m.role === "system" || m.role ===
 * "developer"`），所以两者的文本都会原样到上游，必须一起过归一。
 */
const OPENAI_SYSTEM_ROLES: ReadonlySet<string> = new Set(["system", "developer"]);

/**
 * start-plan（OpenAI 路由）：插官方 system 段 + 归一客户端自己的 system 消息。
 *
 * 身份归一的第三层（路由覆盖）：此前只往 `messages` 前插官方段，**完全不碰客户端
 * system 消息**，走 `/v1/chat/completions` 的客户端（Cline / Roo / Kilo 这类多数走
 * OpenAI 格式）身份句 100% 原样出站（`docs/research/client-fingerprints.md` 记的是这条路由级缺口）。
 * 现在客户端 system 文本与 Anthropic 路由的 block 3 共用
 * {@link normalizeClientSystem} —— 同一函数、同一开关，不会分叉。
 */
function applyStartPlanOpenAISystem(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;

  for (const msg of messages) {
    if (!isPlainObject(msg)) continue;
    if (typeof msg.role !== "string" || !OPENAI_SYSTEM_ROLES.has(msg.role)) continue;
    normalizeClientSystemMessage(msg);
  }

  const official = buildStartPlanSystem(undefined).map((block) => ({
    role: "system",
    content: typeof block === "object" && block !== null && "text" in block ? String(block.text) : "",
  }));
  body.messages = [...official, ...messages];
  return true;
}

/**
 * 归一条客户端 system 消息的文本：`content` 是字符串时直接归，是内容块数组时只归
 * `type: "text"` 块的 `text`（其他块原样保留）。
 */
function normalizeClientSystemMessage(msg: Record<string, unknown>): void {
  if (typeof msg.content === "string") {
    msg.content = normalizeClientSystem(msg.content);
    return;
  }
  if (!Array.isArray(msg.content)) return;
  for (const part of msg.content) {
    if (!isPlainObject(part)) continue;
    if (part.type !== "text" || typeof part.text !== "string") continue;
    part.text = normalizeClientSystem(part.text);
  }
}
