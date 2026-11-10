/**
 * RPM 闸的用例（`accounts.entries[].rpmLimit`）。
 *
 * 语义定死：**超限按 `saturated` 处理，不是直接 429 上游**。所以这一层只
 * 回答"还能不能发"，动作（排队/溢出）在 `broker.ts`（见 `broker-quota.test.ts`）。
 *
 * 窗口是滑动窗口：固定桶会在交界处放行 2×rpm 个请求，对上游就是一次突发。
 *
 * @see 三种切走 · 配置项清单
 */
import { describe, expect, it } from "bun:test";
import { RpmGate } from "./rpm.js";

/** 一分钟（`RATE_WINDOW_MS` 的字面值，用例里当"窗口长度"用）。*/
const WINDOW_MS = 60_000;

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

describe("RpmGate：每分钟请求数上限", () => {
  it("未配置（undefined）= 不限制：任意次数都放行", () => {
    const rpm = new RpmGate(clock().now);
    for (let i = 0; i < 500; i++) {
      expect(rpm.allows("a", undefined)).toBe(true);
      rpm.record("a");
    }
    expect(rpm.nextCapacityAt("a", undefined)).toBeUndefined();
  });

  it("达到上限后拦截；窗口滑过之后重新放行", () => {
    const time = clock();
    const rpm = new RpmGate(time.now);

    expect(rpm.allows("a", 2)).toBe(true);
    rpm.record("a");
    expect(rpm.allows("a", 2)).toBe(true);
    rpm.record("a");
    // 第 3 次：超限（按 saturated 处理，调用方排队/溢出）。
    expect(rpm.allows("a", 2)).toBe(false);
    expect(rpm.inflightWindow("a")).toBe(2);

    // 第一条记录滑出窗口的时刻 = 起点 + 一次窗口长度。
    expect(rpm.nextCapacityAt("a", 2)).toBe(1_000_000 + WINDOW_MS);

    time.advance(WINDOW_MS - 1);
    expect(rpm.allows("a", 2)).toBe(false);
    time.advance(1);
    // 恰好到窗口边界：最早那条过期，名额腾出。
    expect(rpm.allows("a", 2)).toBe(true);
  });

  it("滑动窗口而不是固定桶：交界处不会放行 2×rpm", () => {
    const time = clock();
    const rpm = new RpmGate(time.now);
    // 窗口末尾打满 2 次。
    time.advance(WINDOW_MS - 10);
    rpm.record("a");
    rpm.record("a");
    // 跨过边界：如果是固定桶，这里会重置成 0 并再放行 2 次；滑动窗口仍应拦截。
    time.advance(20);
    expect(rpm.allows("a", 2)).toBe(false);
    expect(rpm.inflightWindow("a")).toBe(2);
  });

  it("按账号独立计数：一个账号打满不影响另一个", () => {
    const rpm = new RpmGate(clock().now);
    rpm.record("a");
    rpm.record("a");
    expect(rpm.allows("a", 2)).toBe(false);
    expect(rpm.allows("b", 2)).toBe(true);
  });

  it("nextCapacityAt 在有空额时返回 undefined（调用方据此不排唤醒）", () => {
    const rpm = new RpmGate(clock().now);
    rpm.record("a");
    expect(rpm.nextCapacityAt("a", 2)).toBeUndefined();
  });

  it("forget 清掉账号的窗口占用", () => {
    const rpm = new RpmGate(clock().now);
    rpm.record("a");
    rpm.record("a");
    expect(rpm.allows("a", 2)).toBe(false);
    rpm.forget("a");
    expect(rpm.allows("a", 2)).toBe(true);
    expect(rpm.inflightWindow("a")).toBe(0);
  });
});
