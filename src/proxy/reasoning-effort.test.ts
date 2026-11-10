/**
 * 推理强度映射的用例。
 *
 * 三套协议的体形状各测一遍：这里是唯一把「客户端要了多少思考」折成四档的地方，
 * 映射错了 `usage-stats` 的分组与 `logs --req` 的 `effort=` 会一起错。
 */
import { describe, expect, it } from "bun:test";
import { effortFromBudget, normalizeEffortLabel, reasoningEffortFromBody } from "./reasoning-effort.js";

describe("effortFromBudget", () => {
  it("maps the three canonical GLM-5.3 budgets to distinct levels", () => {
    // 8000 / 16000 / 32000 是 provider/reasoning.js 的三个规范档位，必须落在三档里。
    expect(effortFromBudget(8_000)).toBe("low");
    expect(effortFromBudget(16_000)).toBe("medium");
    expect(effortFromBudget(32_000)).toBe("high");
  });

  it("uses midpoint thresholds so an in-between budget stays intuitive", () => {
    expect(effortFromBudget(12_000)).toBe("low");
    expect(effortFromBudget(12_001)).toBe("medium");
    expect(effortFromBudget(24_000)).toBe("medium");
    expect(effortFromBudget(24_001)).toBe("high");
  });

  it("treats a non-number / non-positive budget as 'not given'", () => {
    expect(effortFromBudget(undefined)).toBeUndefined();
    expect(effortFromBudget(0)).toBeUndefined();
    expect(effortFromBudget(-1)).toBeUndefined();
    expect(effortFromBudget(Number.NaN)).toBeUndefined();
    expect(effortFromBudget("8000")).toBeUndefined();
  });
});

describe("normalizeEffortLabel", () => {
  it("maps the OpenAI vocabulary (including extensions) onto the four levels", () => {
    expect(normalizeEffortLabel("none")).toBe("none");
    expect(normalizeEffortLabel("minimal")).toBe("low");
    expect(normalizeEffortLabel("low")).toBe("low");
    expect(normalizeEffortLabel("medium")).toBe("medium");
    expect(normalizeEffortLabel("high")).toBe("high");
    expect(normalizeEffortLabel("xhigh")).toBe("high");
    expect(normalizeEffortLabel("max")).toBe("high");
  });

  it("is case/space tolerant but never guesses on an unknown label", () => {
    expect(normalizeEffortLabel(" HIGH ")).toBe("high");
    expect(normalizeEffortLabel("turbo")).toBeUndefined();
    expect(normalizeEffortLabel(42)).toBeUndefined();
    expect(normalizeEffortLabel(undefined)).toBeUndefined();
  });
});

describe("reasoningEffortFromBody — OpenAI chat shape", () => {
  it("reads reasoning_effort", () => {
    expect(reasoningEffortFromBody({ model: "glm-5.3", reasoning_effort: "low" })).toBe("low");
    expect(reasoningEffortFromBody({ reasoning_effort: "medium" })).toBe("medium");
  });

  it("prefers the explicit thinking budget over the effort label", () => {
    // 预算才是真正驱动上游思考量的数字（provider/reasoning.ts 文件头）。
    expect(reasoningEffortFromBody({ reasoning_effort: "low", thinking: { type: "enabled", budget_tokens: 30_000 } })).toBe("high");
  });

  it("records `none` for an explicitly disabled thinking block", () => {
    expect(reasoningEffortFromBody({ thinking: { type: "disabled" } })).toBe("none");
    expect(reasoningEffortFromBody({ thinking: { type: "disabled" }, reasoning_effort: "high" })).toBe("none");
  });

  it("records `low` for an enabled thinking block without a budget (SDK default 1024)", () => {
    expect(reasoningEffortFromBody({ thinking: { type: "enabled" } })).toBe("low");
    expect(reasoningEffortFromBody({ thinking: { type: "adaptive" } })).toBe("low");
  });

  it("stays undefined when the client expressed no intent", () => {
    expect(reasoningEffortFromBody({ model: "glm-4.6" })).toBeUndefined();
  });
});

describe("reasoningEffortFromBody — Anthropic shape", () => {
  it("maps thinking.budget_tokens", () => {
    expect(reasoningEffortFromBody({ thinking: { type: "enabled", budget_tokens: 8_000 } })).toBe("low");
    expect(reasoningEffortFromBody({ thinking: { type: "enabled", budget_tokens: 32_000 } })).toBe("high");
  });

  it("reads the GLM-5.3 output_config.effort channel the desktop client sends", () => {
    expect(reasoningEffortFromBody({ output_config: { effort: "max" } })).toBe("high");
    expect(reasoningEffortFromBody({ output_config: { effort: "low" }, thinking: { type: "enabled", budget_tokens: 8_000 } })).toBe("low");
  });

  it("accepts the camelCase budgetTokens alias the Anthropic client type allows", () => {
    expect(reasoningEffortFromBody({ thinking: { type: "enabled", budgetTokens: 26_000 } })).toBe("high");
  });
});

describe("reasoningEffortFromBody — Responses shape", () => {
  it("reads reasoning.effort from the raw Responses body", () => {
    expect(reasoningEffortFromBody({ reasoning: { effort: "medium" } })).toBe("medium");
    expect(reasoningEffortFromBody({ reasoning: { effort: "minimal" } })).toBe("low");
  });
});

describe("reasoningEffortFromBody — malformed bodies", () => {
  it("never throws on non-object bodies", () => {
    expect(reasoningEffortFromBody(null)).toBeUndefined();
    expect(reasoningEffortFromBody("string")).toBeUndefined();
    expect(reasoningEffortFromBody([])).toBeUndefined();
    expect(reasoningEffortFromBody({ thinking: "enabled" })).toBeUndefined();
    expect(reasoningEffortFromBody({ output_config: "max" })).toBeUndefined();
  });
});
