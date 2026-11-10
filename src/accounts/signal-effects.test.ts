/**
 * 信号副作用的判定表（`signal-effects.ts`）。
 *
 * 两组集合决定 broker 要不要唤醒排队者、要不要即时复采；漏掉一个 kind 的代价是
 * 排队者一直等一个已经恢复的账号（或反过来）——测试逐 kind 列出来，新增信号类时
 * 这里会强制回答"它算不算可用性变化"。
 */
import { describe, expect, it } from "bun:test";
import { AVAILABILITY_KINDS, RESAMPLE_KINDS, signalEffects } from "./signal-effects.js";
import type { UpstreamSignalKind } from "./signals.js";

const ALL_KINDS: UpstreamSignalKind[] = [
  "success",
  "rate-limited",
  "quota-terminal",
  "fair-usage",
  "auth",
  "endpoint-shape",
  "model-level",
  "gateway",
  "transport",
  "empty-stream",
];

describe("上游信号的调度副作用", () => {
  it("可用性类：成功 / 限流 / 终态 / 公平使用 / 鉴权 / 空流都唤醒排队者", () => {
    const kinds = ALL_KINDS.filter((kind) => signalEffects({ kind }).availability);
    expect(kinds).toEqual(["success", "rate-limited", "quota-terminal", "fair-usage", "auth", "empty-stream"]);
    expect(kinds).toEqual([...AVAILABILITY_KINDS]);
  });

  it("路由级记账与模型级问题不改候选集：不唤醒", () => {
    for (const kind of ["endpoint-shape", "model-level", "gateway", "transport"] as const) {
      expect(signalEffects({ kind }).availability).toBe(false);
    }
  });

  it("只有终态码与空流触发即时复采（其余靠常驻采样节奏）", () => {
    const kinds = ALL_KINDS.filter((kind) => signalEffects({ kind }).resample);
    expect(kinds).toEqual(["quota-terminal", "empty-stream"]);
    expect(kinds).toEqual([...RESAMPLE_KINDS]);
  });

  it("返回值按组合复用同一份常量，且不可变", () => {
    expect(signalEffects({ kind: "success" })).toBe(signalEffects({ kind: "auth" }));
    expect(signalEffects({ kind: "gateway" })).toBe(signalEffects({ kind: "transport" }));
    expect(Object.isFrozen(signalEffects({ kind: "quota-terminal" }))).toBe(true);
  });
});
