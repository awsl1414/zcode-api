import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { heartbeatPhaseOffset } from "../highspeed/slots.js";

const solveMock = mock(async (_scene: string, _region: string, _prefix: string) => {
  return "x".repeat(64);
});

mock.module("./captcha-solver.js", () => ({
  runCaptchaSolve: solveMock,
  shutdownCaptchaSolver: () => {},
  setCaptchaSolverConcurrency: () => {},
  captchaSolverConcurrency: () => 2,
  CAPTCHA_NODE_DIR: "/tmp",
}));

const { CaptchaTokenPool } = await import("./captcha-pool.js");

const CFG = {
  enabled: true,
  prefix: "no8xfe",
  sceneId: "11xygtvd",
  region: "sgp",
};

let pool: InstanceType<typeof CaptchaTokenPool>;

describe("CaptchaTokenPool", () => {
  beforeEach(() => {
    process.env.ZCODE_CAPTCHA_SKIP_DEPS = "1";
    solveMock.mockClear();
    pool = new CaptchaTokenPool({
      poolSizeMin: 3,
      poolSizeMax: 3,
      tokenTtlMs: 60_000,
      refillIntervalMs: 60_000,
      staggerMs: 0,
      solveRetries: 1,
      solveConcurrency: 2,
      scaleDownIdleMs: 60_000,
    });
  });

  afterEach(() => {
    delete process.env.ZCODE_CAPTCHA_SKIP_DEPS;
    pool.stopBackgroundRefill();
  });

  it("prefill adds tokens without consuming on take", async () => {
    await pool.prefill(CFG, 2);
    expect(pool.stats().ready).toBe(2);
    expect(solveMock).toHaveBeenCalledTimes(2);
  });

  it("takeToken uses prefetched token and triggers background refill", async () => {
    await pool.prefill(CFG, 2);
    solveMock.mockClear();

    const param = await pool.takeToken(CFG);
    expect(param.length).toBeGreaterThan(20);
    expect(pool.stats().ready).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(solveMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("concurrent takes use parallel solves when pool is empty", async () => {
    const [a, b] = await Promise.all([pool.takeToken(CFG), pool.takeToken(CFG)]);
    expect(a.length).toBeGreaterThan(20);
    expect(b.length).toBeGreaterThan(20);
    expect(solveMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("invalidate clears the pool", async () => {
    await pool.prefill(CFG, 2);
    pool.invalidate();
    expect(pool.stats().ready).toBe(0);
  });

  it("pushToken rejects duplicate certifyId", async () => {
    const payload = Buffer.from(
      JSON.stringify({ certifyId: "dup-test-id", sceneId: "11xygtvd", isSign: true, securityToken: "x" }),
    ).toString("base64");
    const poolAny = pool as unknown as {
      pushToken: (p: string) => void;
      stats: () => { ready: number };
    };
    poolAny.pushToken(payload);
    poolAny.pushToken(payload);
    expect(poolAny.stats().ready).toBe(1);
  });

  it("takeToken prefers newest token (LIFO)", async () => {
    let n = 0;
    solveMock.mockImplementation(async () => {
      n += 1;
      return `token-${n}:${"x".repeat(48)}`;
    });
    await pool.prefill(CFG, 3);
    solveMock.mockClear();

    const taken = await pool.takeToken(CFG);
    expect(taken.startsWith("token-3:")).toBe(true);
  });
});

describe("CaptchaTokenPool deep idle", () => {
  beforeEach(() => {
    process.env.ZCODE_CAPTCHA_SKIP_DEPS = "1";
    solveMock.mockClear();
  });
  afterEach(() => {
    delete process.env.ZCODE_CAPTCHA_SKIP_DEPS;
    pool?.stopBackgroundRefill?.();
  });

  it("decays target to idleFloor after sustained zero traffic", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 5,
      poolSizeMax: 10,
      idleFloor: 1,
      tokenTtlMs: 60_000,
      refillIntervalMs: 60_000,
      solveRetries: 1,
      solveConcurrency: 1,
      scaleDownIdleMs: 60_000,
    });
    await pool.prefill(CFG, 5);
    expect(pool.stats().target).toBe(5);
    // Simulate 61s of idle: lastTakeAt far in the past.
    const p = pool as unknown as { lastTakeAt: number };
    p.lastTakeAt = Date.now() - 61_000;
    const decayed = pool as unknown as { maybeScaleDown: () => void; applyGovernorCaps: () => void };
    decayed.maybeScaleDown();
    decayed.applyGovernorCaps();
    expect(pool.stats().target).toBeLessThanOrEqual(1);
    expect(pool.stats().ready).toBeLessThanOrEqual(1);
  });

  it("touchDemand (in-flight stream activity) suppresses idle decay without taking a token", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 5,
      poolSizeMax: 10,
      idleFloor: 1,
      tokenTtlMs: 60_000,
      refillIntervalMs: 60_000,
      solveRetries: 1,
      solveConcurrency: 1,
      scaleDownIdleMs: 60_000,
    });
    await pool.prefill(CFG, 5);
    expect(pool.stats().target).toBe(5);
    // A request whose SSE has been producing for minutes is NOT idle: the last
    // token take is 61s old, but the stream just ended (touchDemand refreshes
    // the idle clock) — the pool must not decay mid/after-stream.
    const p = pool as unknown as { lastTakeAt: number };
    p.lastTakeAt = Date.now() - 61_000;
    pool.touchDemand();
    const decayed = pool as unknown as { maybeScaleDown: () => void; applyGovernorCaps: () => void };
    decayed.maybeScaleDown();
    decayed.applyGovernorCaps();
    expect(pool.stats().target).toBe(5);
    expect(pool.stats().ready).toBe(5);
    // touchDemand refreshes only the idle clock — it never pollutes the
    // demand-sizing signal (takeTimestamps), so repeat calls stay inert.
    pool.touchDemand();
    decayed.maybeScaleDown();
    expect(pool.stats().target).toBe(5);
  });

  it("restores full floor on the next token take", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 5,
      poolSizeMax: 10,
      idleFloor: 1,
      tokenTtlMs: 60_000,
      refillIntervalMs: 60_000,
      solveRetries: 1,
      solveConcurrency: 1,
      scaleDownIdleMs: 60_000,
    });
    await pool.prefill(CFG, 5);
    const p = pool as unknown as { lastTakeAt: number };
    p.lastTakeAt = Date.now() - 61_000;
    const decayed = pool as unknown as { maybeScaleDown: () => void };
    decayed.maybeScaleDown();
    expect(pool.stats().target).toBeLessThanOrEqual(1);
    await pool.takeToken(CFG);
    expect(pool.stats().target).toBe(5);
  });

  it("decays floor to 0 after deepIdleAfterMs (no background mints)", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 5,
      poolSizeMax: 10,
      idleFloor: 1,
      deepIdleAfterMs: 120_000,
      tokenTtlMs: 60_000,
      refillIntervalMs: 60_000,
      solveRetries: 1,
      solveConcurrency: 1,
      scaleDownIdleMs: 60_000,
    });
    await pool.prefill(CFG, 5);
    const p = pool as unknown as { lastTakeAt: number };
    // Past scaleDownIdleMs but before deepIdleAfterMs → keeper floor.
    p.lastTakeAt = Date.now() - 61_000;
    let decayed = pool as unknown as { maybeScaleDown: () => void };
    decayed.maybeScaleDown(); expect(pool.stats().target).toBe(1);
    // Past deepIdleAfterMs → floor 0.
    p.lastTakeAt = Date.now() - 121_000;
    decayed.maybeScaleDown();
    expect(pool.stats().target).toBe(0);
  });

  it("keeps one banked token through decay for instant wake-up serves", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 5,
      poolSizeMax: 10,
      idleFloor: 0,
      deepIdleAfterMs: 120_000,
      tokenTtlMs: 60_000,
      refillIntervalMs: 60_000,
      solveRetries: 1,
      solveConcurrency: 1,
      scaleDownIdleMs: 60_000,
    });
    await pool.prefill(CFG, 5);
    const p = pool as unknown as { lastTakeAt: number };
    p.lastTakeAt = Date.now() - 121_000;
    const decayed = pool as unknown as { maybeScaleDown: () => void };
    decayed.maybeScaleDown();
    // Target is 0 but the last banked token survives trimming.
    expect(pool.stats().target).toBe(0);
    expect(pool.stats().ready).toBe(1);
    // …and a take right after deep idle still gets served instantly.
    solveMock.mockClear();
    const param = await pool.takeToken(CFG);
    expect(param.length).toBeGreaterThan(20);
  });

  it("races parallel solves on an empty-pool take and banks extras", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 2,
      poolSizeMax: 10,
      emptyTakeRace: 3,
      tokenTtlMs: 60_000,
      refillIntervalMs: 60_000,
      staggerMs: 0,
      solveRetries: 1,
      solveConcurrency: 4,
      scaleDownIdleMs: 60_000,
    });
    let n = 0;
    let active = 0;
    let peak = 0;
    solveMock.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      n += 1;
      return `race-token-${n}:${"y".repeat(48)}`;
    });
    const param = await pool.takeToken(CFG);
    expect(param).toContain("race-token-");
    // Racers overlap: peak concurrent solves equals the race width instead
    // of stacking sequentially.
    expect(peak).toBe(3);
    // Extra successes are banked into the pool once they settle.
    await new Promise((r) => setTimeout(r, 30));
    expect(pool.stats().ready).toBeGreaterThanOrEqual(2);
  });

  it("grace-waits for refill when all raced solves fail before surfacing the error", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 1,
      poolSizeMax: 10,
      emptyTakeRace: 2,
      tokenTtlMs: 60_000,
      refillIntervalMs: 60_000,
      staggerMs: 0,
      solveRetries: 1,
      solveConcurrency: 4,
      scaleDownIdleMs: 600_000,
      deepIdleAfterMs: 600_000,
      takeGraceMs: 1_500,
    });
    // Every solve fails at first, a full storm.
    solveMock.mockImplementation(async () => {
      throw new Error("captcha solve stall pe=pe.099.storm.js");
    });
    const takePromise = pool.takeToken(CFG);
    // Mid-storm, a refill wave succeeds and banks a token.
    const pushTimer = setTimeout(() => {
      const p = pool as unknown as { pushToken: (s: string) => void };
      p.pushToken(`storm-rescue:${"g".repeat(48)}`);
    }, 400);
    const param = await takePromise;
    clearTimeout(pushTimer);
    expect(param).toContain("storm-rescue");
  });

  it("fires the IP reset once when a mint storm is detected (no successes)", async () => {
    pool = new CaptchaTokenPool({
      poolSizeMin: 1,
      poolSizeMax: 10,
      tokenTtlMs: 60_000,
      refillIntervalMs: 600_000,
      staggerMs: 0,
      solveRetries: 1,
      solveConcurrency: 4,
      scaleDownIdleMs: 600_000,
    });
    const fired: string[] = [];
    (pool as unknown as { opts: { onCaptchaIpBlock?: (r: string) => void } }).opts.onCaptchaIpBlock =
      (reason) => fired.push(reason);

    const p = pool as unknown as {
      noteMintFailure: (r: string) => void;
      noteMintSuccess: () => void;
    };
    // 7 failures: below threshold — no fire.
    for (let i = 0; i < 7; i++) p.noteMintFailure("captcha solve stall pe=x.js");
    expect(fired.length).toBe(0);
    // 8th failure crosses the threshold with zero successes — fires.
    p.noteMintFailure("captcha solve stall pe=x.js");
    expect(fired.length).toBe(1);
    expect(fired[0]).toContain("mint storm");
    // Cooldown: more failures do not re-fire immediately.
    for (let i = 0; i < 5; i++) p.noteMintFailure("captcha solve stall pe=x.js");
    expect(fired.length).toBe(1);

    // A success inside the window suppresses the trigger entirely.
    const poolB = new CaptchaTokenPool({
      poolSizeMin: 1,
      poolSizeMax: 10,
      tokenTtlMs: 60_000,
      refillIntervalMs: 600_000,
      staggerMs: 0,
      solveRetries: 1,
      solveConcurrency: 4,
      scaleDownIdleMs: 600_000,
    });
    const fired2: string[] = [];
    (poolB as unknown as { opts: { onCaptchaIpBlock?: (r: string) => void } }).opts.onCaptchaIpBlock =
      (reason) => fired2.push(reason);
    const p2 = poolB as unknown as {
      noteMintFailure: (r: string) => void;
      noteMintSuccess: () => void;
    };
    p2.noteMintSuccess();
    for (let i = 0; i < 10; i++) p2.noteMintFailure("stall");
    expect(fired2.length).toBe(0);
  });
});

/**
 * 错峰：N 个账号的后台补池循环必须相位错开。
 *
 * 口径与 `highspeed/slots.ts::heartbeatPhaseOffset` 完全一致（同一个函数：sha256
 * 相位 + ±10% 抖动），这里注入固定随机源把抖动消掉，只断言确定性部分 —— 账号之间
 * 相位不同，且首轮补充真的被推迟了。
 */
describe("CaptchaTokenPool 账号相位错峰", () => {
  const NO_JITTER = () => 0.5;

  function accountIdWithPhaseAtLeast(intervalMs: number, minPhase: number): string {
    for (let i = 0; i < 500; i += 1) {
      const id = `acct-${i}`;
      if (heartbeatPhaseOffset(id, intervalMs, NO_JITTER) >= minPhase) return id;
    }
    throw new Error("no account id reaches the requested phase");
  }

  it("相位由 accountId 哈希决定，与 highspeed 卡槽同口径", () => {
    const intervalMs = 4_000;
    const pool = new CaptchaTokenPool({ accountId: "acct-a", refillIntervalMs: intervalMs, random: NO_JITTER });
    expect(pool.startPhaseMs).toBe(heartbeatPhaseOffset("acct-a", intervalMs, NO_JITTER));
    expect(pool.startPhaseMs).toBeGreaterThanOrEqual(0);
    expect(pool.startPhaseMs).toBeLessThanOrEqual(intervalMs);
    // 不传 accountId = 相位 0（单元测试直接构造池的老用法）
    expect(new CaptchaTokenPool({ poolSizeMin: 1, poolSizeMax: 1 }).startPhaseMs).toBe(0);
  });

  it("不同账号的相位不同（不是所有账号同拍补池）", () => {
    const intervalMs = 4_000;
    const phases = ["acct-a", "acct-b", "acct-c", "acct-d", "acct-e"].map(
      (accountId) => new CaptchaTokenPool({ accountId, refillIntervalMs: intervalMs, random: NO_JITTER }).startPhaseMs,
    );
    expect(new Set(phases).size).toBeGreaterThan(1);
  });

  it("首轮后台补充被相位推迟（错峰而非同拍）", async () => {
    const intervalMs = 4_000;
    const accountId = accountIdWithPhaseAtLeast(intervalMs, 500);
    const phased = new CaptchaTokenPool({
      accountId,
      refillIntervalMs: intervalMs,
      random: NO_JITTER,
      poolSizeMin: 2,
      poolSizeMax: 2,
      solveRetries: 1,
      solveConcurrency: 1,
      scaleDownIdleMs: 60_000,
    });
    solveMock.mockClear();
    phased.startBackgroundRefill(CFG);
    await new Promise((r) => setTimeout(r, 80));
    // 相位 ≥500ms：80ms 内不该有任何一次补充
    expect(solveMock).not.toHaveBeenCalled();
    phased.stopBackgroundRefill();
  });

  it("stopBackgroundRefill 取消尚未到期的相位启动", async () => {
    const intervalMs = 4_000;
    const accountId = accountIdWithPhaseAtLeast(intervalMs, 500);
    const phased = new CaptchaTokenPool({
      accountId,
      refillIntervalMs: intervalMs,
      random: NO_JITTER,
      poolSizeMin: 2,
      poolSizeMax: 2,
      solveRetries: 1,
      solveConcurrency: 1,
      scaleDownIdleMs: 60_000,
    });
    solveMock.mockClear();
    phased.startBackgroundRefill(CFG);
    phased.stopBackgroundRefill();
    await new Promise((r) => setTimeout(r, 80));
    expect(solveMock).not.toHaveBeenCalled();
  });
});
