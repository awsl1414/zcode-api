/**
 * `(route, model)` 能力判定的用例（能力矩阵的路由侧）。
 *
 * 唯一的**排他**路由是 `start-plan`（官方 builtin 明确不含 `GLM-5.3`）。其余路由
 * 只拦"我们认识但这条路由不提供"。
 *
 * @see 各路由的模型集 · 能力矩阵
 */
import { describe, it, expect } from "bun:test";
import { routeSupportsModel } from "./model-support.js";

describe("start-plan 的排他清单（官方的关键约束）", () => {
  it("不含 glm-5.3，但含 flash / 5.2 / turbo", () => {
    expect(routeSupportsModel("start-plan", "glm-5.3")).toBe(false);
    expect(routeSupportsModel("start-plan", "glm-5.3-flash")).toBe(true);
    expect(routeSupportsModel("start-plan", "glm-5.2")).toBe(true);
    expect(routeSupportsModel("start-plan", "glm-5-turbo")).toBe(true);
  });

  it("大小写归一：官方写法 GLM-5.3 与内部 glm-5.3 同判", () => {
    expect(routeSupportsModel("start-plan", "GLM-5.3")).toBe(false);
    expect(routeSupportsModel("start-plan", "GLM-5.3-Flash")).toBe(true);
  });

  it("不认识的 model id 放行（没有白名单，与 config.example.yaml 一致）", () => {
    expect(routeSupportsModel("start-plan", "glm-9-imaginary")).toBe(true);
  });
});

describe("非排他路由不设白名单", () => {
  it("按量独有的模型在非排他路由上照旧放行", () => {
    // glm-4.6 不在任何套餐清单里，但 coding-plan 不是排他路由 → 放行。
    expect(routeSupportsModel("coding-plan", "glm-4.6")).toBe(true);
    expect(routeSupportsModel("off-peak", "glm-4.6")).toBe(true);
    expect(routeSupportsModel("highspeed", "glm-4.6")).toBe(true);
  });

  it("start-plan 对套餐目录外的模型放行（既有降级路径不变）", () => {
    // glm-4.6 不在 start-plan 清单、也不在套餐目录 → 「不认识」→ 放行。
    expect(routeSupportsModel("start-plan", "glm-4.6")).toBe(true);
  });
});
