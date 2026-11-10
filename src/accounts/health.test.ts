/**
 * HealthEngine 测试：状态变化矩阵逐格 + 429 确定性 + auth-invalid
 * 升级 + 路由级熔断 / 被动探针 + 事件 API + 过渡层 API 保真。
 *
 * 全部用注入时钟 / 随机源（状态机是纯逻辑）：不靠真实时钟；抖动用随机源 0/1 钉住
 * 上下界断言（冷却只加不减、无 cap；`docs/research/upstream-risk-control.md`
 * 的 5.4 节记着 1302 风暴教训）。
 */
import { describe, expect, it } from "bun:test";
import { HealthEngine, routeStateKey, type HealthSignal, type HealthTransition } from "./health.js";

/** 可拨时钟 + 可钉随机源的测试夹具。 */
function fixture(randomValue = 0.5) {
  let now = 1_000_000;
  const engine = new HealthEngine(
    () => now,
    () => randomValue,
  );
  return {
    engine,
    advance(ms: number): void {
      now += ms;
    },
    now: () => now,
  };
}

const A = "acc-a";
const B = "acc-b";
const C = "acc-c";
const D = "acc-d";
const E = "acc-e";
const R = "coding-plan" as const;

function hit405(): HealthSignal {
  return { kind: "endpoint-shape", detail: "HTTP 405：端点/方法被上游拒绝" };
}

function hit404(): HealthSignal {
  return { kind: "endpoint-shape", detail: "HTTP 404：可能为模型 id 不存在" };
}

function transport(): HealthSignal {
  return { kind: "transport" };
}

describe("状态变化矩阵逐格", () => {
  it("success → markOk + 清零 auth-failed 计数", () => {
    const f = fixture();
    f.engine.apply({ kind: "auth" }, A, R);
    f.engine.apply({ kind: "auth" }, A, R);
    expect(f.engine.apply({ kind: "success" }, A, R).status).toBe("ok");
    // 计数已清零：再来两次 auth 也只是冷却，不升级
    f.engine.apply({ kind: "auth" }, A, R);
    expect(f.engine.apply({ kind: "auth" }, A, R).status).toBe("cooling");
  });

  it("rate-limited + Retry-After → cooling，until = now + retryAfter（无 cap）+ 后置抖动", () => {
    // 抖动下界（random=0）：+0s
    const lo = fixture(0);
    const loState = lo.engine.apply({ kind: "rate-limited", retryAfterSeconds: 600 }, A, R);
    expect(loState.status).toBe("cooling");
    expect(loState.reason).toBe("rate-limited");
    expect(loState.until).toBe(lo.now() + 600_000);
    // 抖动上界（random=1）：+min(20%, 5s) = 5s
    const hi = fixture(1);
    expect(hi.engine.apply({ kind: "rate-limited", retryAfterSeconds: 600 }, A, R).until).toBe(hi.now() + 605_000);
    // 中值（random=0.5）：+2.5s
    const mid = fixture(0.5);
    expect(mid.engine.apply({ kind: "rate-limited", retryAfterSeconds: 600 }, A, R).until).toBe(mid.now() + 602_500);
  });

  it("rate-limited 无 Retry-After → 无 until（等采样确认）", () => {
    const f = fixture();
    const state = f.engine.apply({ kind: "rate-limited" }, A, R);
    expect(state.status).toBe("cooling");
    expect(state.until).toBeUndefined();
    // 无 until 不自动回落：时钟拨多久都还在冷却
    f.advance(24 * 60 * 60_000);
    expect(f.engine.status(A, R).status).toBe("cooling");
  });

  it("rate-limited 大值无 cap：3600s 原样采信", () => {
    const f = fixture(0);
    expect(f.engine.apply({ kind: "rate-limited", retryAfterSeconds: 3600 }, A, R).until).toBe(f.now() + 3_600_000);
  });

  it("quota-terminal → drained，until 取信号 resetAt（如有）", () => {
    const f = fixture();
    const resetAt = f.now() + 500_000;
    const state = f.engine.apply({ kind: "quota-terminal", resetAt }, A, R);
    expect(state.status).toBe("drained");
    expect(state.reason).toBe("drained");
    expect(state.until).toBe(resetAt);
    const open = fixture();
    const openState = open.engine.apply({ kind: "quota-terminal" }, A, R);
    expect(openState.status).toBe("drained");
    expect(openState.until).toBeUndefined();
  });

  it("fair-usage → cooling 固定 30min，reason=fair-usage", () => {
    const f = fixture();
    const state = f.engine.apply({ kind: "fair-usage" }, A, R);
    expect(state.status).toBe("cooling");
    expect(state.reason).toBe("fair-usage");
    expect(state.until).toBe(f.now() + 30 * 60_000);
  });

  it("auth → cooling 5min，reason=auth-failed", () => {
    const f = fixture();
    const state = f.engine.apply({ kind: "auth" }, A, R);
    expect(state.status).toBe("cooling");
    expect(state.reason).toBe("auth-failed");
    expect(state.until).toBe(f.now() + 5 * 60_000);
  });

  it("endpoint-shape → 不冷却账号（不惩罚错对象）", () => {
    const f = fixture();
    f.engine.apply(hit405(), A, R);
    f.engine.apply(hit405(), A, R);
    expect(f.engine.status(A, R).status).toBe("ok");
    expect(f.engine.isAvailable(A, R)).toBe(true);
  });

  it("transport / gateway → 不冷却账号", () => {
    const f = fixture();
    f.engine.apply(transport(), A, R);
    f.engine.apply({ kind: "gateway" }, A, R);
    expect(f.engine.status(A, R).status).toBe("ok");
    expect(f.engine.isAvailable(A, R)).toBe(true);
  });

  it("empty-stream → 账号级 cooling 10min，reason=empty-stream", () => {
    const f = fixture();
    const state = f.engine.apply({ kind: "empty-stream" }, A, R);
    expect(state.status).toBe("cooling");
    expect(state.reason).toBe("empty-stream");
    expect(state.until).toBe(f.now() + 10 * 60_000);
  });

  it("model-level → 不动健康", () => {
    const f = fixture();
    expect(f.engine.apply({ kind: "model-level", code: 3006 }, A, R).status).toBe("ok");
    // 也不清 auth 计数：计数清零只由 success 信号触发
    f.engine.apply({ kind: "auth" }, A, R);
    f.engine.apply({ kind: "auth" }, A, R);
    f.engine.apply({ kind: "model-level" }, A, R);
    expect(f.engine.apply({ kind: "auth" }, A, R).status).toBe("auth-invalid");
  });
});

describe("恢复路径（每种状态只有一条恢复路径）", () => {
  it("cooling 到点自动回落 ok（含 cooling-exit 事件）", () => {
    const f = fixture(0);
    const events: HealthTransition[] = [];
    f.engine.onTransition((event) => events.push(event));
    f.engine.apply({ kind: "rate-limited", retryAfterSeconds: 60 }, A, R);
    f.advance(59_999);
    expect(f.engine.status(A, R).status).toBe("cooling");
    f.advance(1);
    expect(f.engine.status(A, R).status).toBe("ok");
    expect(events.map((event) => event.type)).toEqual(["cooling-enter", "cooling-exit"]);
  });

  it("drained 恢复靠采样 markOk（quota.ts 契约），success 信号也能恢复", () => {
    const f = fixture();
    f.engine.apply({ kind: "quota-terminal" }, A, R);
    f.engine.markOk(A, R);
    expect(f.engine.status(A, R).status).toBe("ok");
    f.engine.apply({ kind: "quota-terminal" }, A, R);
    expect(f.engine.apply({ kind: "success" }, A, R).status).toBe("ok");
  });

  it("auth-invalid 恢复：success 信号 → ok 并清计数", () => {
    const f = fixture();
    f.engine.apply({ kind: "auth" }, A, R);
    f.engine.apply({ kind: "auth" }, A, R);
    f.engine.apply({ kind: "auth" }, A, R);
    expect(f.engine.status(A, R).status).toBe("auth-invalid");
    expect(f.engine.apply({ kind: "success" }, A, R).status).toBe("ok");
    // 计数清零：重新累计到 3 次才再升级
    f.engine.apply({ kind: "auth" }, A, R);
    f.engine.apply({ kind: "auth" }, A, R);
    expect(f.engine.status(A, R).status).toBe("cooling");
  });

  it("auth-invalid 恢复：resetAuthInvalid → ok；计数保留，坏凭据立刻再升级", () => {
    const f = fixture();
    f.engine.apply({ kind: "auth" }, A, R);
    f.engine.apply({ kind: "auth" }, A, R);
    f.engine.apply({ kind: "auth" }, A, R);
    expect(f.engine.status(A, R).status).toBe("auth-invalid");
    f.engine.resetAuthInvalid(A, R);
    expect(f.engine.status(A, R).status).toBe("ok");
    // 「计数清零只由 success 信号触发」：仍是坏凭据时下一次 auth 立刻再升级，
    // 不会进入自动冷却循环
    expect(f.engine.apply({ kind: "auth" }, A, R).status).toBe("auth-invalid");
  });

  it("resetAuthInvalid 只清 auth-invalid，其他态不误伤", () => {
    const f = fixture();
    f.engine.apply({ kind: "quota-terminal" }, A, R);
    f.engine.resetAuthInvalid(A, R);
    expect(f.engine.status(A, R).status).toBe("drained");
  });
});

describe("auth-invalid 升级（连续 3 次失败且中间无成功）", () => {
  it("401×2 + success×1 + 401×2：计数被 success 重置，不升级", () => {
    const f = fixture();
    f.engine.apply({ kind: "auth" }, A, R);
    f.engine.apply({ kind: "auth" }, A, R);
    f.engine.apply({ kind: "success" }, A, R);
    f.engine.apply({ kind: "auth" }, A, R);
    expect(f.engine.apply({ kind: "auth" }, A, R).status).toBe("cooling");
    expect(f.engine.status(A, R).status).toBe("cooling");
  });

  it("401×3 连续 → auth-invalid（无 until，等人工 re-import）", () => {
    const f = fixture();
    f.engine.apply({ kind: "auth" }, A, R);
    f.engine.apply({ kind: "auth" }, A, R);
    const state = f.engine.apply({ kind: "auth" }, A, R);
    expect(state.status).toBe("auth-invalid");
    expect(state.reason).toBe("auth-failed");
    expect(state.until).toBeUndefined();
    // 不自动回落：时钟拨多久都还是 auth-invalid
    f.advance(24 * 60 * 60_000);
    expect(f.engine.status(A, R).status).toBe("auth-invalid");
    expect(f.engine.isAvailable(A, R)).toBe(false);
  });

  it("计数按状态键隔离：同账号另一条路由不受牵连（状态键是 (account, route)，不是账号）", () => {
    const f = fixture();
    f.engine.apply({ kind: "auth" }, A, R);
    f.engine.apply({ kind: "auth" }, A, R);
    f.engine.apply({ kind: "auth" }, A, "start-plan");
    expect(f.engine.status(A, "start-plan").status).toBe("cooling");
    expect(f.engine.status(A, R).status).toBe("cooling");
    f.engine.apply({ kind: "auth" }, A, R);
    expect(f.engine.status(A, R).status).toBe("auth-invalid");
    expect(f.engine.status(A, "start-plan").status).toBe("cooling");
  });
});

describe("严重度闸门与 no-clobber（writeState）", () => {
  it("低严重度失败不降级：drained 不被 429 打回 cooling", () => {
    const f = fixture();
    f.engine.apply({ kind: "quota-terminal" }, A, R);
    f.engine.apply({ kind: "rate-limited", retryAfterSeconds: 60 }, A, R);
    expect(f.engine.status(A, R).status).toBe("drained");
  });

  it("升级照常：cooling 时 quota-terminal 升为 drained", () => {
    const f = fixture();
    f.engine.apply({ kind: "rate-limited", retryAfterSeconds: 60 }, A, R);
    const resetAt = f.now() + 90_000;
    const state = f.engine.apply({ kind: "quota-terminal", resetAt }, A, R);
    expect(state.status).toBe("drained");
    expect(state.until).toBe(resetAt);
  });

  it("no-clobber：429 双报（rate-limited 无 retryAfter 的第二次）不抹权威窗口", () => {
    const f = fixture(0);
    // 上游实测的双报顺序（observeUpstream 是唯一观测点，业务码只分类一次）：
    // 先 rate-limited(429, retryAfter=600)，再一个无 retryAfter 的 rate-limited（如 1302 码信号）
    const first = f.engine.apply({ kind: "rate-limited", retryAfterSeconds: 600 }, A, R);
    f.engine.apply({ kind: "rate-limited", code: 1302 }, A, R);
    expect(f.engine.status(A, R).until).toBe(first.until);
  });

  it("no-clobber：drained 已有 until 时，无 resetAt 的 quota-terminal 再报不抹窗口", () => {
    const f = fixture();
    const resetAt = f.now() + 300_000;
    f.engine.apply({ kind: "quota-terminal", resetAt }, A, R);
    f.engine.apply({ kind: "quota-terminal", code: 1304 }, A, R);
    expect(f.engine.status(A, R).until).toBe(resetAt);
  });

  it("同状态刷新静默且新窗口生效：第二个带 retryAfter 的 429 替换 until", () => {
    const f = fixture(0);
    const events: HealthTransition[] = [];
    f.engine.onTransition((event) => events.push(event));
    f.engine.apply({ kind: "rate-limited", retryAfterSeconds: 60 }, A, R);
    f.engine.apply({ kind: "rate-limited", retryAfterSeconds: 120 }, A, R);
    expect(f.engine.status(A, R).until).toBe(f.now() + 120_000);
    expect(events).toHaveLength(1);
  });

  it("markDrained 同款 no-clobber：无 until 的重报不抹 nextResetTime", () => {
    const f = fixture();
    const until = f.now() + 400_000;
    f.engine.markDrained(A, R, until);
    f.engine.markDrained(A, R);
    expect(f.engine.status(A, R).until).toBe(until);
  });
});

describe("路由级熔断（路由级状态表）", () => {
  it("3 不同账号 405 → endpoint-broken", () => {
    const f = fixture();
    const events: HealthTransition[] = [];
    f.engine.onTransition((event) => events.push(event));
    f.engine.apply(hit405(), A, R);
    f.engine.apply(hit405(), B, R);
    expect(f.engine.isRouteBroken(R)).toBe(false);
    f.engine.apply(hit405(), C, R);
    expect(f.engine.isRouteBroken(R)).toBe(true);
    expect(events.filter((event) => event.type === "breaker-open")).toHaveLength(1);
    expect(events.find((event) => event.type === "breaker-open")?.detail).toBe("endpoint-broken");
  });

  it("同账号 3 次 405 不熔断（单账号问题不是端点问题）", () => {
    const f = fixture();
    f.engine.apply(hit405(), A, R);
    f.engine.apply(hit405(), A, R);
    f.engine.apply(hit405(), A, R);
    expect(f.engine.isRouteBroken(R)).toBe(false);
  });

  it("404 弱信号要 5 不同账号；4 个不熔断", () => {
    const f = fixture();
    f.engine.apply(hit404(), A, R);
    f.engine.apply(hit404(), B, R);
    f.engine.apply(hit404(), C, R);
    f.engine.apply(hit404(), D, R);
    expect(f.engine.isRouteBroken(R)).toBe(false);
    f.engine.apply(hit404(), E, R);
    expect(f.engine.isRouteBroken(R)).toBe(true);
  });

  it("405 强信号 2 账号 + 404 弱信号 3 账号（共 5 不同账号）→ 熔断", () => {
    const f = fixture();
    f.engine.apply(hit405(), A, R);
    f.engine.apply(hit405(), B, R);
    f.engine.apply(hit404(), C, R);
    f.engine.apply(hit404(), D, R);
    expect(f.engine.isRouteBroken(R)).toBe(false);
    f.engine.apply(hit404(), E, R);
    expect(f.engine.isRouteBroken(R)).toBe(true);
  });

  it("强信号不足 3 账号时弱信号不能凑数触发 3 阈值（保守）", () => {
    const f = fixture();
    f.engine.apply(hit405(), A, R);
    f.engine.apply(hit405(), A, R);
    f.engine.apply(hit404(), B, R);
    f.engine.apply(hit404(), C, R);
    f.engine.apply(hit404(), D, R);
    // distinct=4 < 5、strongDistinct=1 < 3：不熔断
    expect(f.engine.isRouteBroken(R)).toBe(false);
  });

  it("5min 滑动窗口：旧命中过期后不累计", () => {
    const f = fixture();
    f.engine.apply(hit405(), A, R);
    f.engine.apply(hit405(), B, R);
    f.advance(5 * 60_000); // 窗口只服务「何时打开」：先到 2 个不同账号后过期
    f.engine.apply(hit405(), C, R);
    expect(f.engine.isRouteBroken(R)).toBe(false);
    f.engine.apply(hit405(), D, R);
    f.engine.apply(hit405(), E, R);
    expect(f.engine.isRouteBroken(R)).toBe(true);
  });

  it("gateway-broken：连续 transport/gateway 失败 ≥3 次（路由级聚合）", () => {
    const f = fixture();
    f.engine.apply(transport(), A, R);
    f.engine.apply({ kind: "gateway" }, B, R);
    expect(f.engine.isRouteBroken(R)).toBe(false);
    f.engine.apply(transport(), C, R);
    expect(f.engine.isRouteBroken(R)).toBe(true);
  });

  it("成功清零连败计数：2 失败 + success + 2 失败不熔断", () => {
    const f = fixture();
    f.engine.apply(transport(), A, R);
    f.engine.apply(transport(), B, R);
    f.engine.apply({ kind: "success" }, A, R);
    f.engine.apply(transport(), C, R);
    f.engine.apply(transport(), D, R);
    expect(f.engine.isRouteBroken(R)).toBe(false);
  });

  it("熔断只影响该路由；已熔断后不再累积命中", () => {
    const f = fixture();
    f.engine.apply(hit405(), A, R);
    f.engine.apply(hit405(), B, R);
    f.engine.apply(hit405(), C, R);
    expect(f.engine.isRouteBroken(R)).toBe(true);
    expect(f.engine.isRouteBroken("start-plan")).toBe(false);
    // 404 ×5 新窗口打进来也不重开（已熔断忽略判定输入）
    f.engine.apply(hit404(), A, R);
    f.engine.apply(hit404(), B, R);
    f.engine.apply(hit404(), C, R);
    f.engine.apply(hit404(), D, R);
    f.engine.apply(hit404(), E, R);
    expect(f.engine.isRouteBroken(R)).toBe(true);
  });

  it("resetBreaker 人工恢复", () => {
    const f = fixture();
    f.engine.apply(transport(), A, R);
    f.engine.apply(transport(), B, R);
    f.engine.apply(transport(), C, R);
    expect(f.engine.isRouteBroken(R)).toBe(true);
    f.engine.resetBreaker(R);
    expect(f.engine.isRouteBroken(R)).toBe(false);
    // 重新从零计数：一次 transport 不会立刻再熔断
    f.engine.apply(transport(), A, R);
    expect(f.engine.isRouteBroken(R)).toBe(false);
  });
});

describe("被动探针（健康信号只来自真实请求，不另发探测）", () => {
  /** 用 3 个 transport 失败把 gateway-broken 打开。 */
  function breakRoute(engine: HealthEngine): void {
    engine.apply(transport(), A, R);
    engine.apply(transport(), B, R);
    engine.apply(transport(), C, R);
    expect(engine.isRouteBroken(R)).toBe(true);
  }

  it("打开熔断排程 2min ±25% 的第一次探针", () => {
    const lo = fixture(0);
    breakRoute(lo.engine);
    lo.advance(89_999);
    expect(lo.engine.isProbeDue(R)).toBe(false);
    lo.advance(1); // 90s = 2min × 0.75
    expect(lo.engine.isProbeDue(R)).toBe(true);

    const hi = fixture(1);
    breakRoute(hi.engine);
    hi.advance(149_999);
    expect(hi.engine.isProbeDue(R)).toBe(false);
    hi.advance(1); // 150s = 2min × 1.25
    expect(hi.engine.isProbeDue(R)).toBe(true);
  });

  it("一次性认领：放行一个探针后 60s 宽限内不再放行", () => {
    const f = fixture(0.5);
    breakRoute(f.engine);
    f.advance(120_000);
    expect(f.engine.isProbeDue(R)).toBe(true); // 认领 = 放行下一个真实请求当探针
    expect(f.engine.isProbeDue(R)).toBe(false);
    f.advance(59_999);
    expect(f.engine.isProbeDue(R)).toBe(false);
    f.advance(1);
    expect(f.engine.isProbeDue(R)).toBe(true); // 无回报的探针 60s 后重新放行
  });

  it("未熔断 / 未到期不放行", () => {
    const f = fixture();
    expect(f.engine.isProbeDue(R)).toBe(false);
    breakRoute(f.engine);
    f.advance(119_999);
    expect(f.engine.isProbeDue(R)).toBe(false);
  });

  it("probeResult(false)：窗口翻倍 2→4→8→16→30min（cap），探针失败不冷却账号", () => {
    const f = fixture(0.5);
    breakRoute(f.engine);
    // random=0.5 → 抖动为 0，窗口序列精确
    f.advance(120_000);
    expect(f.engine.isProbeDue(R)).toBe(true);
    f.engine.noteProbeResult(R, false);
    f.advance(240_000);
    expect(f.engine.isProbeDue(R)).toBe(true);
    f.engine.noteProbeResult(R, false);
    f.advance(480_000);
    expect(f.engine.isProbeDue(R)).toBe(true);
    f.engine.noteProbeResult(R, false);
    f.advance(960_000);
    expect(f.engine.isProbeDue(R)).toBe(true);
    f.engine.noteProbeResult(R, false);
    f.advance(1_800_000); // 32min 被 cap 到 30min
    expect(f.engine.isProbeDue(R)).toBe(true);
    f.engine.noteProbeResult(R, false);
    f.advance(1_800_000); // cap 后不再增长
    expect(f.engine.isProbeDue(R)).toBe(true);
    // 探针失败不冷却该账号
    expect(f.engine.status(A, R).status).toBe("ok");
  });

  it("探针退避窗口 ±25% 抖动区间（钉住随机源上下界）", () => {
    const lo = fixture(0);
    breakRoute(lo.engine);
    lo.advance(120_000);
    lo.engine.isProbeDue(R); // 认领
    lo.engine.noteProbeResult(R, false); // 窗口翻倍到 4min
    lo.advance(179_999); // 4min × 0.75 = 180s
    expect(lo.engine.isProbeDue(R)).toBe(false);
    lo.advance(1);
    expect(lo.engine.isProbeDue(R)).toBe(true);

    const hi = fixture(1);
    breakRoute(hi.engine);
    hi.advance(120_000);
    hi.engine.isProbeDue(R);
    hi.engine.noteProbeResult(R, false);
    hi.advance(299_999); // 4min × 1.25 = 300s
    expect(hi.engine.isProbeDue(R)).toBe(false);
    hi.advance(1);
    expect(hi.engine.isProbeDue(R)).toBe(true);
  });

  it("probeResult(true)：全量恢复 + 清熔断，窗口回落 2min 起步", () => {
    const f = fixture(0.5);
    const events: HealthTransition[] = [];
    f.engine.onTransition((event) => events.push(event));
    breakRoute(f.engine);
    f.advance(120_000);
    expect(f.engine.isProbeDue(R)).toBe(true);
    f.engine.noteProbeResult(R, true);
    expect(f.engine.isRouteBroken(R)).toBe(false);
    expect(events.find((event) => event.type === "breaker-close")?.detail).toContain("探针成功");
    expect(events.filter((event) => event.type === "probe-result")).toHaveLength(1);
    // 再次熔断：探针窗口从 2min 重新起步（不是接着翻倍）
    breakRoute(f.engine);
    f.advance(119_999);
    expect(f.engine.isProbeDue(R)).toBe(false);
    f.advance(1);
    expect(f.engine.isProbeDue(R)).toBe(true);
  });

  it("真实流量成功即路由恢复：熔断期的成功信号清熔断", () => {
    const f = fixture();
    breakRoute(f.engine);
    expect(f.engine.apply({ kind: "success" }, A, R).status).toBe("ok");
    expect(f.engine.isRouteBroken(R)).toBe(false);
  });
});

describe("事件 API（每次状态变化都落一个事件）", () => {
  it("一次状态变化恰好一个事件；同状态刷新与低严重度拒绝都静默", () => {
    const f = fixture(0);
    const events: HealthTransition[] = [];
    f.engine.onTransition((event) => events.push(event));
    f.engine.apply({ kind: "rate-limited", retryAfterSeconds: 60 }, A, R);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("cooling-enter");
    expect(events[0]?.from).toBe("ok");
    expect(events[0]?.to).toBe("cooling");
    expect(events[0]?.reason).toBe("rate-limited");
    expect(events[0]?.until).toBe(f.now() + 60_000);
    expect(events[0]?.accountId).toBe(A);
    // 同状态刷新静默
    f.engine.apply({ kind: "rate-limited", retryAfterSeconds: 120 }, A, R);
    expect(events).toHaveLength(1);
    // 低严重度写被拒静默
    f.engine.apply({ kind: "quota-terminal" }, A, R);
    expect(events).toHaveLength(2);
    expect(events[1]?.type).toBe("drained-enter");
    expect(events[1]?.from).toBe("cooling");
    f.engine.apply({ kind: "rate-limited", retryAfterSeconds: 5 }, A, R);
    expect(events).toHaveLength(2);
    // 恢复 = exit 事件
    f.engine.markOk(A, R);
    expect(events[2]?.type).toBe("drained-exit");
    expect(events[2]?.to).toBe("ok");
  });

  it("auth-invalid 升级落 auth-invalid-enter（from 带原状态）", () => {
    const f = fixture();
    const events: HealthTransition[] = [];
    f.engine.onTransition((event) => events.push(event));
    f.engine.apply({ kind: "auth" }, A, R);
    f.engine.apply({ kind: "auth" }, A, R);
    f.engine.apply({ kind: "auth" }, A, R);
    const last = events[events.length - 1];
    expect(last?.type).toBe("auth-invalid-enter");
    expect(last?.from).toBe("cooling");
    expect(last?.to).toBe("auth-invalid");
  });

  it("监听器异常不影响状态机与后续监听器；退订生效", () => {
    const f = fixture();
    const seen: string[] = [];
    const off1 = f.engine.onTransition(() => {
      throw new Error("boom");
    });
    const off2 = f.engine.onTransition((event) => seen.push(event.type));
    f.engine.apply({ kind: "fair-usage" }, A, R);
    expect(seen).toEqual(["cooling-enter"]);
    off1();
    off2();
    f.engine.markOk(A, R);
    expect(seen).toEqual(["cooling-enter"]);
    void off1;
  });

  it("breaker / 探针事件形状", () => {
    const f = fixture();
    const events: HealthTransition[] = [];
    f.engine.onTransition((event) => events.push(event));
    f.engine.apply(transport(), A, R);
    f.engine.apply(transport(), B, R);
    f.engine.apply(transport(), C, R);
    const open = events.find((event) => event.type === "breaker-open");
    expect(open?.detail).toBe("gateway-broken");
    expect(open?.accountId).toBe(C);
    f.engine.noteProbeResult(R, false);
    const probe = events.find((event) => event.type === "probe-result");
    expect(probe?.ok).toBe(false);
    f.engine.noteProbeResult(R, true);
    expect(events.filter((event) => event.type === "breaker-close")).toHaveLength(1);
  });
});

describe("过渡层 API 保真（quota.ts / broker.ts 消费面）", () => {
  it("status 返回副本；isAvailable 只认 ok", () => {
    const f = fixture();
    const state = f.engine.status(A, R);
    expect(state).toEqual({ status: "ok" });
    f.engine.apply({ kind: "quota-terminal" }, A, R);
    expect(f.engine.isAvailable(A, R)).toBe(false);
    f.engine.markOk(A, R);
    expect(f.engine.isAvailable(A, R)).toBe(true);
  });

  it("earliestRecovery：任一 ok 返回 undefined；全不可用取最早 until", () => {
    const f = fixture();
    const t1 = f.now() + 30_000;
    const t2 = f.now() + 10_000;
    f.engine.markDrained(A, R, t1);
    f.engine.markDrained(B, R, t2);
    expect(f.engine.earliestRecovery([{ accountId: A, route: R }, { accountId: B, route: R }])).toBe(t2);
    // 任一 ok → undefined（调用方只在全部不可用时才问）
    f.engine.markOk(B, R);
    expect(f.engine.earliestRecovery([{ accountId: A, route: R }, { accountId: B, route: R }])).toBeUndefined();
  });

  it("earliestRecovery：全部无 until → undefined", () => {
    const f = fixture();
    f.engine.apply({ kind: "rate-limited" }, A, R);
    f.engine.apply({ kind: "quota-terminal" }, B, R);
    expect(f.engine.earliestRecovery([{ accountId: A, route: R }, { accountId: B, route: R }])).toBeUndefined();
  });

  it("forgetAccount 清全部路由状态与 auth 计数", () => {
    const f = fixture();
    f.engine.apply({ kind: "auth" }, A, R);
    f.engine.apply({ kind: "auth" }, A, R);
    f.engine.apply({ kind: "quota-terminal" }, A, "start-plan");
    f.engine.forgetAccount(A);
    expect(f.engine.status(A, R).status).toBe("ok");
    expect(f.engine.status(A, "start-plan").status).toBe("ok");
    // 计数也清了：重新累计到 3 次才升级
    f.engine.apply({ kind: "auth" }, A, R);
    expect(f.engine.apply({ kind: "auth" }, A, R).status).toBe("cooling");
  });

  it("routeStateKey 按 (账号, 路由) 分键", () => {
    expect(routeStateKey(A, R)).not.toBe(routeStateKey(B, R));
    expect(routeStateKey(A, R)).not.toBe(routeStateKey(A, "start-plan"));
    expect(routeStateKey(A, R)).toBe(routeStateKey(A, R));
  });
});
