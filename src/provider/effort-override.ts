/**
 * Reasoning-effort panel override — the single shared contract for
 * rewriting a request body to the panel-configured effort tier.
 *
 * Consumers: `proxy/body-transformer.ts` (the transformRequestBody exit that
 * serves the OpenAI translation chain, the Responses chain and the Anthropic
 * passthrough alike) and `async/handler.ts` (the off-peak bridge, which
 * builds its bodies on separate code paths). Both call `resolveEffortOverride`
 * once per request (the same result also lands on the request record as
 * `reasoningEffortOverride`), then hand the tier to `applyEffortOverrideToBody`.
 *
 * The rewrite deliberately mirrors what the OpenAI translation layer already
 * produces for each tier (`translator/openai-to-anthropic.ts`), so an
 * overridden request and a client-requested one reach the upstream in the
 * same shape:
 *
 * - GLM-5.3 family (`glm-5.3`, `glm-5.3-flash`): enabled tiers set the
 *   paired `output_config.effort` + `thinking.budget_tokens` — the effort
 *   label alone still produces near-zero thinking (see reasoning.ts); `off`
 *   writes `thinking:{type:"disabled"}` and drops `output_config`, the same
 *   shape an explicit client `thinking:{type:"disabled"}` produces. Plain
 *   glm-5.3 cannot truly disable thinking upstream (live-tested: 54 chars
 *   still came back); `off` is still the closest available signal, and
 *   glm-5.3-flash does honor it.
 * - Other reasoning models (glm-5.2/5.1/5/4.x): `thinking: enabled` with the
 *   tier budget (clamped to the model ceiling) or `thinking: disabled`.
 *   `output_config` is GLM-5.3+ only — never attached, never touched here.
 * - Non-reasoning models (glm-5v-turbo, glm-4.6v): untouched, `changed:false`.
 *
 * max_tokens arithmetic: the translation layer ADDS the thinking budget on
 * top of max_tokens (applyAnthropicThinkingCompat), so overriding the budget
 * must adjust max_tokens by the same delta — `max_tokens += new - old`,
 * where `old` is the budget already in the body (0 when absent) — then cap
 * at the model ceiling exactly like the compat pass does. Enabled tiers drop
 * `temperature` / `top_k` / `top_p` (sampling params are rejected alongside
 * thinking upstream); `off` leaves them alone, mirroring the compat pass.
 */
import { MODELS } from "./models.js";
import {
  GLM53_THINKING_BUDGETS,
  clampGlm53BudgetToModel,
  isGlm53Model,
  type Glm53Effort,
} from "./reasoning.js";
import type { ReasoningConfig } from "../config/types.js";

/** A resolved override tier: a GLM-5.3 effort label or full disable. */
export type EffortOverride = Glm53Effort | "off";

/**
 * Resolve the override tier for one request, or `undefined` when the request
 * is out of scope (passthrough mode, or a model the override does not apply
 * to). Provider-agnostic on purpose: the tier is a property of the model, not
 * of the credential family. The request record's `reasoningEffortOverride`
 * and the body rewrite share this one function so they can never disagree.
 */
export function resolveEffortOverride(
  config: { reasoning?: ReasoningConfig },
  model: string | undefined,
): EffortOverride | undefined {
  if (config.reasoning?.mode !== "override") return undefined;
  const effort = config.reasoning.effort;
  if (isGlm53Model(model)) return effort;
  if (MODELS.some((m) => m.id === model && m.reasoning === true)) return effort;
  return undefined;
}

/** The body fields this rewrite may touch; both sides of the change check. */
const WATCHED_KEYS = ["thinking", "output_config", "max_tokens", "temperature", "top_k", "top_p"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Budget already present in the body's thinking block; 0 when absent/garbage. */
function readBudget(thinking: unknown): number {
  if (!isRecord(thinking)) return 0;
  const raw = thinking.budget_tokens;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isRecord(a) || !isRecord(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function snapshot(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of WATCHED_KEYS) out[k] = body[k];
  return out;
}

/**
 * Rewrite `body` in place to the given tier. Idempotent: applying the tier
 * the body already carries leaves it byte-equivalent and reports
 * `changed: false` (compared field-by-field, not byte-wise, so key order
 * inside untouched nested objects never counts as a change).
 *
 * Returns `changed` so callers can log/assert the rewrite without guessing.
 * Bodies that fail to parse upstream of this call are not our concern here;
 * a body without a catalog model is simply out of scope.
 */
export function applyEffortOverrideToBody(
  body: Record<string, unknown>,
  effort: EffortOverride,
): { changed: boolean } {
  const model = typeof body.model === "string" ? body.model : undefined;
  const glm53 = isGlm53Model(model);
  const catalogEntry = model !== undefined ? MODELS.find((m) => m.id === model) : undefined;
  // The override only shapes reasoning models; anything else passes through
  // untouched (vision-only models, unknown ids, missing model field).
  if (!glm53 && catalogEntry?.reasoning !== true) return { changed: false };

  const before = snapshot(body);
  const modelMax = catalogEntry?.maxOutputTokens;
  const oldBudget = readBudget(body.thinking);
  const newBudget =
    effort === "off" ? 0 : clampGlm53BudgetToModel(GLM53_THINKING_BUDGETS[effort], modelMax);

  body.thinking =
    effort === "off" ? { type: "disabled" } : { type: "enabled", budget_tokens: newBudget };

  if (glm53) {
    if (effort === "off") {
      // Explicit-disabled shape: thinking carries the signal, no effort label.
      delete body.output_config;
    } else {
      // Keep any extra fields a client already sent (e.g. task_budget) and
      // retarget only the effort label.
      body.output_config = {
        ...(isRecord(body.output_config) ? body.output_config : {}),
        effort,
      };
    }
  }

  if (effort !== "off") {
    // Same rejection the translation layer applies whenever thinking is on.
    delete body.temperature;
    delete body.top_k;
    delete body.top_p;
  }

  // Local binding first: TS narrows a property read through an index
  // signature only when it sits in a variable, not on each `body.max_tokens`.
  const currentMax = typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens)
    ? body.max_tokens
    : undefined;
  if (currentMax !== undefined) {
    // Delta bookkeeping: the tier budget rides on top of max_tokens (see the
    // file header), so growing the budget grows max_tokens by the same delta,
    // and `off` gives the answer tokens back. Capped at the model ceiling
    // exactly like applyAnthropicThinkingCompat caps its own addition.
    let nextMax = currentMax + (newBudget - oldBudget);
    if (typeof modelMax === "number" && Number.isFinite(modelMax) && nextMax > modelMax) {
      nextMax = modelMax;
    }
    body.max_tokens = nextMax;
  }

  const after = snapshot(body);
  return { changed: !deepEqual(before, after) };
}
