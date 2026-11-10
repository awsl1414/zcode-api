/**
 * Tests for the reasoning-effort panel override contract.
 * @see src/provider/effort-override.ts
 */
import { describe, it, expect } from "bun:test";
import { applyEffortOverrideToBody, resolveEffortOverride } from "./effort-override.js";
import { GLM53_THINKING_BUDGETS } from "./reasoning.js";
import { MODELS } from "./models.js";

describe("resolveEffortOverride", () => {
  const override = { mode: "override" as const, effort: "high" as const };

  it("returns undefined in passthrough mode (default section omitted)", () => {
    expect(resolveEffortOverride({}, "glm-5.3")).toBeUndefined();
    expect(resolveEffortOverride({ reasoning: { mode: "passthrough", effort: "high" } }, "glm-5.3")).toBeUndefined();
  });

  it("resolves the tier for GLM-5.3 family models", () => {
    expect(resolveEffortOverride({ reasoning: override }, "glm-5.3")).toBe("high");
    expect(resolveEffortOverride({ reasoning: override }, "glm-5.3-flash")).toBe("high");
  });

  it("resolves the tier for other reasoning models", () => {
    expect(resolveEffortOverride({ reasoning: override }, "glm-5.1")).toBe("high");
    expect(resolveEffortOverride({ reasoning: override }, "glm-4.6")).toBe("high");
  });

  it("returns undefined for non-reasoning models", () => {
    expect(resolveEffortOverride({ reasoning: override }, "glm-5v-turbo")).toBeUndefined();
    expect(resolveEffortOverride({ reasoning: override }, "glm-4.6v")).toBeUndefined();
  });

  it("returns undefined for unknown or missing models", () => {
    expect(resolveEffortOverride({ reasoning: override }, "gpt-4o")).toBeUndefined();
    expect(resolveEffortOverride({ reasoning: override }, undefined)).toBeUndefined();
  });

  it("resolves 'off' verbatim", () => {
    expect(resolveEffortOverride({ reasoning: { mode: "override", effort: "off" } }, "glm-5.3")).toBe("off");
    expect(resolveEffortOverride({ reasoning: { mode: "override", effort: "off" } }, "glm-5.1")).toBe("off");
  });
});

describe("applyEffortOverrideToBody — GLM-5.3 family", () => {
  it("overrides low: paired effort + budget, sampling params dropped", () => {
    const body: Record<string, unknown> = {
      model: "glm-5.3",
      max_tokens: 4096,
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      thinking: { type: "enabled", budget_tokens: 1024 },
    };
    const { changed } = applyEffortOverrideToBody(body, "low");
    expect(changed).toBe(true);
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: GLM53_THINKING_BUDGETS.low });
    expect(body.temperature).toBeUndefined();
    expect(body.top_k).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    // max_tokens += newBudget - oldBudget = 4096 + 8000 - 1024
    expect(body.max_tokens).toBe(4096 + GLM53_THINKING_BUDGETS.low - 1024);
  });

  it("overrides max: budget clamped against the model ceiling", () => {
    const modelMax = MODELS.find((m) => m.id === "glm-5.3")?.maxOutputTokens;
    // Artificially small max_tokens so the delta addition caps at the ceiling.
    const body: Record<string, unknown> = { model: "glm-5.3", max_tokens: modelMax };
    applyEffortOverrideToBody(body, "max");
    expect(body.thinking).toEqual({
      type: "enabled",
      budget_tokens: GLM53_THINKING_BUDGETS.max,
    });
    expect(body.max_tokens).toBe(modelMax);
  });

  it("off: thinking disabled, output_config dropped, budget refunded", () => {
    const body: Record<string, unknown> = {
      model: "glm-5.3",
      max_tokens: 4096 + GLM53_THINKING_BUDGETS.high,
      thinking: { type: "enabled", budget_tokens: GLM53_THINKING_BUDGETS.high },
      output_config: { effort: "high" },
      temperature: 0.7,
    };
    const { changed } = applyEffortOverrideToBody(body, "off");
    expect(changed).toBe(true);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config).toBeUndefined();
    expect(body.max_tokens).toBe(4096);
    // off does not clear sampling params (mirrors the compat pass).
    expect(body.temperature).toBe(0.7);
  });

  it("off with no prior budget still writes disabled and leaves max_tokens", () => {
    const body: Record<string, unknown> = { model: "glm-5.3", max_tokens: 4096 };
    applyEffortOverrideToBody(body, "off");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.max_tokens).toBe(4096);
  });

  it("off on flash: explicit-disabled shape (no output_config)", () => {
    const body: Record<string, unknown> = {
      model: "glm-5.3-flash",
      max_tokens: 4096,
      output_config: { effort: "low" },
    };
    applyEffortOverrideToBody(body, "off");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config).toBeUndefined();
  });

  it("keeps extra output_config fields while retargeting the effort label", () => {
    const body: Record<string, unknown> = {
      model: "glm-5.3",
      max_tokens: 4096,
      output_config: { effort: "low", task_budget: { type: "tokens", total: 500 } },
    };
    applyEffortOverrideToBody(body, "high");
    expect(body.output_config).toEqual({ effort: "high", task_budget: { type: "tokens", total: 500 } });
  });
});

describe("applyEffortOverrideToBody — other reasoning models", () => {
  it("enabled tier: thinking budget without output_config", () => {
    const body: Record<string, unknown> = { model: "glm-5.1", max_tokens: 4096 };
    const { changed } = applyEffortOverrideToBody(body, "max");
    expect(changed).toBe(true);
    expect(body.thinking).toEqual({
      type: "enabled",
      budget_tokens: Math.min(GLM53_THINKING_BUDGETS.max, 64_000 - 1),
    });
    expect(body.output_config).toBeUndefined();
    expect(body.max_tokens).toBe(4096 + GLM53_THINKING_BUDGETS.max);
  });

  it("off tier: thinking disabled", () => {
    const body: Record<string, unknown> = {
      model: "glm-4.6",
      max_tokens: 4096 + 1024,
      thinking: { type: "enabled", budget_tokens: 1024 },
    };
    applyEffortOverrideToBody(body, "off");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.max_tokens).toBe(4096);
  });
});

describe("applyEffortOverrideToBody — out of scope", () => {
  it("leaves non-reasoning models untouched", () => {
    const body: Record<string, unknown> = {
      model: "glm-4.6v",
      max_tokens: 4096,
      temperature: 0.7,
    };
    const { changed } = applyEffortOverrideToBody(body, "max");
    expect(changed).toBe(false);
    expect(body.temperature).toBe(0.7);
    expect(body.thinking).toBeUndefined();
  });

  it("leaves unknown models untouched", () => {
    const body: Record<string, unknown> = { model: "unknown-model", max_tokens: 4096 };
    expect(applyEffortOverrideToBody(body, "low").changed).toBe(false);
    expect(body.thinking).toBeUndefined();
  });

  it("leaves bodies without a model field untouched", () => {
    const body: Record<string, unknown> = { max_tokens: 4096 };
    expect(applyEffortOverrideToBody(body, "low").changed).toBe(false);
  });
});

describe("applyEffortOverrideToBody — idempotence", () => {
  it("re-applying the same tier reports changed:false", () => {
    const body: Record<string, unknown> = {
      model: "glm-5.3",
      max_tokens: 4096 + GLM53_THINKING_BUDGETS.low,
      thinking: { type: "enabled", budget_tokens: GLM53_THINKING_BUDGETS.low },
      output_config: { effort: "low" },
    };
    expect(applyEffortOverrideToBody(body, "high").changed).toBe(true);
    expect(applyEffortOverrideToBody(body, "high").changed).toBe(false);
    expect(body.max_tokens).toBe(4096 + GLM53_THINKING_BUDGETS.high);
  });

  it("re-applying off to a disabled body reports changed:false", () => {
    const body: Record<string, unknown> = {
      model: "glm-5.3",
      max_tokens: 4096 + GLM53_THINKING_BUDGETS.high,
      thinking: { type: "enabled", budget_tokens: GLM53_THINKING_BUDGETS.high },
      output_config: { effort: "high" },
    };
    expect(applyEffortOverrideToBody(body, "off").changed).toBe(true);
    expect(applyEffortOverrideToBody(body, "off").changed).toBe(false);
    expect(body.max_tokens).toBe(4096);
  });

  it("a body already in the target tier reports changed:false on first apply", () => {
    const body: Record<string, unknown> = {
      model: "glm-5.3",
      max_tokens: 4096 + GLM53_THINKING_BUDGETS.low,
      thinking: { type: "enabled", budget_tokens: GLM53_THINKING_BUDGETS.low },
      output_config: { effort: "low" },
    };
    expect(applyEffortOverrideToBody(body, "low").changed).toBe(false);
    expect(body.max_tokens).toBe(4096 + GLM53_THINKING_BUDGETS.low);
  });
});
