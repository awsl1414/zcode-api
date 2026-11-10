import {
  CaptchaCpuGovernor,
  resolveCpuGovernorConfig,
  type CpuGovernorSnapshot,
} from "./captcha-cpu-governor.js";
import {
  captchaSolverConcurrency,
  runCaptchaSolve,
  setCaptchaSolverConcurrency,
  shutdownCaptchaSolver,
} from "./captcha-solver.js";
import { isCaptchaDuplicateError, isCaptchaIpBlockError, parseCertifyId } from "./captcha-token.js";
import { captchaEnvPositiveInt } from "./captcha-env.js";
// 错峰复用 highspeed 卡槽的心跳相位口径（`heartbeatPhaseOffset`），即
// 「sha256(accountId) 高 32 位取模间隔 + ±10% 抖动」。不另写一套：两处相位必须
// 同口径，否则「账号 A 的抽卡与补池同时落在同一毫秒」依旧存在，只是换了层。
import { heartbeatPhaseOffset } from "../highspeed/slots.js";
import { logger } from "../log/index.js";

/** 验证码池的日志：并行求解失败与 mint 风暴（两者都会触发 IP 重置请求）。*/
const log = logger("captcha");

export interface CaptchaPoolOptions {
  poolSizeMin?: number;
  poolSizeMax?: number;
  /** Idle seconds before shrinking toward min (default 120). */
  scaleDownIdleMs?: number;
  /** Deep-idle floor: pool target decays to this after sustained zero traffic
   *  (default 1). First token take restores the full poolSizeMin. */
  idleFloor?: number;
  /** Zero-traffic seconds after which background solving stops entirely —
   *  target floor decays to 0 (default 900). One banked token is still kept
   *  for an instant serve on wake-up. */
  deepIdleAfterMs?: number;
  tokenTtlMs?: number;
  refillIntervalMs?: number;
  solveRetries?: number;
  staggerMs?: number;
  solveConcurrency?: number;
  /** Parallel solves raced when a take finds the pool empty (default 2). */
  emptyTakeRace?: number;
  /** 取 token 失败后等后台补池的宽限窗口（默认 10000）。测试把它调小以免真等。*/
  takeGraceMs?: number;
  /** Host CPU ceiling for captcha workers (default 100, 0 = off). */
  cpuLimitPercent?: number;
  cpuGovernorIntervalSec?: number;
  /**
   * 这个池属于哪个账号。只用于错峰：后台补充循环的
   * 首轮相位由 `accountId` 的哈希决定，避免 N 个账号同拍补池（机器特征）。
   * 不传 = 相位 0（单元测试直接构造池时就是这样）。
   */
  accountId?: string;
  /** 相位抖动的随机源（同 `HighspeedSlotsOptions.random`）；测试注入固定值。 */
  random?: () => number;
  /**
   * Called when minting fails with an IP-level block ("too many captcha
   * requests" family). The proxy wires this to the Telegram network reset so
   * an Aliyun IP block self-heals instead of stranding the token pool.
   */
  onCaptchaIpBlock?: (reason: string) => void;
}

type TokenEntry = { param: string; cachedAt: number; certifyId: string | null };

/** Tracks certifyIds already handed out or queued — prevents F008 duplicate usage. */
class CertifyIdRegistry {
  private seen = new Map<string, number>();

  constructor(private ttlMs: number) {}

  setTtlMs(ttlMs: number): void {
    this.ttlMs = ttlMs;
  }

  prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, at] of this.seen) {
      if (at < cutoff) this.seen.delete(id);
    }
  }

  has(id: string): boolean {
    this.prune();
    return this.seen.has(id);
  }

  add(id: string): void {
    this.prune();
    this.seen.set(id, Date.now());
  }

  clear(): void {
    this.seen.clear();
  }
}

// Sized for start-plan's 5-concurrent ceiling (~10 instantaneous takes with
// challenge retries, 8-24 tokens circulating per 95s TTL). Pre-configure
// fallbacks only; startCaptchaPool() passes explicit sizes. 除 `CAPTCHA_POOL_MAX`
// 与 `CAPTCHA_SOLVE_CONCURRENCY` 外都是常量。
const DEFAULT_POOL_MIN = 15;
const DEFAULT_POOL_MAX = captchaEnvPositiveInt("CAPTCHA_POOL_MAX", 60);
const DEFAULT_TOKEN_TTL_MS = 95_000;
const DEFAULT_REFILL_INTERVAL_MS = 1_000;
const DEFAULT_STAGGER_MS = 0;
// 3 lanes ≈ 4-6 mints/s，比 5 并发的 start-plan 需求（≤0.5/s）高一个量级。
// 低端机用 `CAPTCHA_SOLVE_CONCURRENCY` 往下压，不必另设 CPU 探测开关。
const DEFAULT_SOLVE_CONCURRENCY = captchaEnvPositiveInt("CAPTCHA_SOLVE_CONCURRENCY", 3);
const DEFAULT_SCALE_DOWN_IDLE_MS = 120_000;
const DEFAULT_IDLE_FLOOR = 1;
// Zero-traffic beyond this stops background solving entirely (floor 0): no
// mint churn, near-zero CPU. The next token take restores poolSizeMin.
const DEFAULT_DEEP_IDLE_AFTER_MS = 900_000;
// Parallel solves raced on an empty-pool take: first success serves the
// client, the twins top up the pool. Cuts worst-case cold TTFB and widens
// odds against a bad rotated pe bundle stalling one racer.
const EMPTY_TAKE_RACE = 3;
const SOLVE_RETRIES = 4;
/** Overall deadline for the racing mint chain: during mint storms a racer grinds
 *  through its retry budget (~30-45s), so cap the client-facing wait and let
 *  background waves finish the job instead. */
const SOLVE_RACE_DEADLINE_MS = 35_000;
/** Grace window after a failed take: mints fail in clusters (pe-stall storms,
 *  F008 velocity), so give background refill a short chance to land a token
 *  before surfacing 503. Turns most storm-window errors into slower successes. */
const DEFAULT_TAKE_GRACE_MS = 10_000;
const SCALE_UP_STEP = 20;
const TAKE_RATE_WINDOW_MS = 120_000;

type ResolvedPoolOpts = {
  poolSizeMin: number;
  poolSizeMax: number;
  idleFloor: number;
  deepIdleAfterMs: number;
  scaleDownIdleMs: number;
  tokenTtlMs: number;
  refillIntervalMs: number;
  solveRetries: number;
  staggerMs: number;
  solveConcurrency: number;
  emptyTakeRace: number;
  takeGraceMs: number;
  onCaptchaIpBlock?: (reason: string) => void;
};

function resolvePoolOpts(opts: CaptchaPoolOptions): ResolvedPoolOpts {
  const max = opts.poolSizeMax ?? DEFAULT_POOL_MAX;
  const min = Math.min(opts.poolSizeMin ?? DEFAULT_POOL_MIN, max);
  return {
    poolSizeMin: min,
    poolSizeMax: max,
    idleFloor: Math.min(opts.idleFloor ?? DEFAULT_IDLE_FLOOR, min),
    deepIdleAfterMs: Math.max(
      opts.deepIdleAfterMs ?? DEFAULT_DEEP_IDLE_AFTER_MS,
      opts.scaleDownIdleMs ?? DEFAULT_SCALE_DOWN_IDLE_MS,
    ),
    scaleDownIdleMs: opts.scaleDownIdleMs ?? DEFAULT_SCALE_DOWN_IDLE_MS,
    tokenTtlMs: opts.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS,
    refillIntervalMs: opts.refillIntervalMs ?? DEFAULT_REFILL_INTERVAL_MS,
    solveRetries: opts.solveRetries ?? SOLVE_RETRIES,
    staggerMs: opts.staggerMs ?? DEFAULT_STAGGER_MS,
    solveConcurrency: opts.solveConcurrency ?? DEFAULT_SOLVE_CONCURRENCY,
    emptyTakeRace: Math.max(1, opts.emptyTakeRace ?? EMPTY_TAKE_RACE),
    takeGraceMs: Math.max(0, opts.takeGraceMs ?? DEFAULT_TAKE_GRACE_MS),
    onCaptchaIpBlock: opts.onCaptchaIpBlock,
  };
}

export class CaptchaTokenPool {
  private tokens: TokenEntry[] = [];
  private opts: ResolvedPoolOpts;
  private effectiveTarget: number;
  private refillTimer: ReturnType<typeof setInterval> | null = null;
  private refillInFlight = false;
  private lastSolveAt = 0;
  private activeSolves = 0;
  private cfg: CaptchaConfig | null = null;
  private pausedUntil = 0;
  private lastTakeAt: number;
  private takeTimestamps: number[] = [];
  private certifyIds: CertifyIdRegistry;
  private governor: CaptchaCpuGovernor | null = null;
  /**
   * 首轮后台补充的相位偏移（毫秒）。构造时由 `accountId` 哈希得出，
   * 0 = 立即开始。
   */
  readonly startPhaseMs: number;
  /** 相位定时器（首轮补充尚未开始时的 pending 启动）。 */
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  // Mint-storm detection: sliding windows of failed vs successful mint
  // attempts. A burst of failures with zero successes means velocity/IP
  // flagging — fire the telegram IP reset automatically.
  private mintFailures: number[] = [];
  private mintSuccesses: number[] = [];
  private lastStormResetAt = 0;

  constructor(opts: CaptchaPoolOptions = {}) {
    // The module-level per-account pools are constructed before config load
    // (first touch of an account) — resolvePoolOpts would fall back to
    // env/global defaults there and configure()'s clamp would preserve that
    // as the starting target, minting a storm of soon-expired tokens. With no
    // sizing opts, defer sizing to the first configure(). `accountId` is
    // identity, not sizing, so it must not count as "opts present".
    const hasSizingOpts = Object.keys(opts).some((key) => key !== "accountId" && key !== "random");
    this.opts = resolvePoolOpts(opts);
    this.effectiveTarget = hasSizingOpts ? this.opts.poolSizeMin : 0;
    // Seed idle clock at startup so a no-traffic proxy decays to idleFloor
    // instead of solving 40-60 tokens forever (lastTakeAt=0 disabled decay).
    this.lastTakeAt = Date.now();
    this.certifyIds = new CertifyIdRegistry(this.opts.tokenTtlMs);
    this.initGovernor(opts);
    setCaptchaSolverConcurrency(this.opts.solveConcurrency);
    // 错峰：相位取构造时的补充间隔。生产上间隔来自同一个 configure() 批（不单独
    // 调 refillIntervalMs），所以构造值与运行值同源；相位本身只是 0..interval
    // 的偏移，不需要随重配置重算。
    this.startPhaseMs = opts.accountId
      ? heartbeatPhaseOffset(opts.accountId, this.opts.refillIntervalMs, opts.random)
      : 0;
  }

  configure(opts: CaptchaPoolOptions): void {
    this.opts = resolvePoolOpts({ ...this.opts, ...opts });
    this.certifyIds.setTtlMs(this.opts.tokenTtlMs);
    this.effectiveTarget = Math.max(
      this.opts.poolSizeMin,
      Math.min(this.effectiveTarget, this.opts.poolSizeMax),
    );
    this.initGovernor(opts);
    // Propagate the resolved concurrency to the solver daemon — the
    // import-time constructor runs before config load and would otherwise
    // leave the daemon at its fallback (8) instead of the configured value.
    setCaptchaSolverConcurrency(this.opts.solveConcurrency);
    this.trimToTarget();
  }

  stats(): {
    ready: number;
    target: number;
    min: number;
    max: number;
    activeSolves: number;
    solverWorkers: number;
    cpu?: CpuGovernorSnapshot;
  } {
    this.pruneExpired();
    return {
      ready: this.tokens.length,
      target: this.effectiveTarget,
      min: this.opts.poolSizeMin,
      max: this.opts.poolSizeMax,
      activeSolves: this.activeSolves,
      solverWorkers: captchaSolverConcurrency(),
      cpu: this.governor?.enabled ? this.governor.snapshot() : undefined,
    };
  }

  invalidate(): void {
    this.tokens = [];
    this.certifyIds.clear();
    this.pausedUntil = Date.now() + this.opts.staggerMs;
  }

  startBackgroundRefill(cfg: CaptchaConfig): void {
    this.cfg = cfg;
    this.stopBackgroundRefill();
    this.governor?.start();
    const begin = () => {
      this.startTimer = null;
      void this.refill({ urgent: false });
      this.refillTimer = setInterval(() => {
        void this.refill({ urgent: false });
      }, this.opts.refillIntervalMs);
    };
    if (this.startPhaseMs > 0) {
      // 错峰：相位只推迟首轮补充，后续节拍全部继承这个相位。
      // 同一账号的相位是确定性的（哈希），账号之间稳定错开；直接同步启动会让
      // N 个账号的补池落在同一毫秒，那正是错峰要避免的机器特征。
      this.startTimer = setTimeout(begin, this.startPhaseMs);
      return;
    }
    begin();
  }

  stopBackgroundRefill(): void {
    this.governor?.stop();
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }
  }

  async takeToken(cfg: CaptchaConfig): Promise<string> {
    this.cfg = cfg;

    const token = this.popFresh();
    if (token) {
      this.onTokenTaken();
      void this.refill({ urgent: true });
      return token;
    }

    this.onTokenTaken();
    // Re-size immediately from current demand (this take is already in the
    // window) so an empty-pool arrival widens the buffer right away.
    this.effectiveTarget = Math.max(this.effectiveTarget, this.computeActiveTarget());
    let param: string;
    try {
      // Overall deadline for the racing chain (see SOLVE_RACE_DEADLINE_MS).
      const raceDeadlineMs = SOLVE_RACE_DEADLINE_MS;
      param = await Promise.race([
        this.solveRaced(cfg),
        new Promise<never>((_, rej) =>
          setTimeout(
            () => rej(new Error(`captcha take deadline (${raceDeadlineMs}ms)`)),
            Math.max(1_000, raceDeadlineMs),
          ),
        ),
      ]);
    } catch (err) {
      // Mints fail in clusters (pe-stall storms, F008 velocity). Background
      // refill waves keep retrying, so wait a short grace window before
      // surfacing the failure to the client.
      const deadline = Date.now() + this.opts.takeGraceMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        const token = this.popFresh();
        if (token) {
          this.markParamIssued(token);
          void this.refill({ urgent: true });
          return token;
        }
      }
      throw err;
    }
    this.markParamIssued(param);
    void this.refill({ urgent: true });
    return param;
  }

  async prefill(cfg: CaptchaConfig, count?: number): Promise<void> {
    this.cfg = cfg;
    const target = Math.min(count ?? this.effectiveTarget, this.effectiveTarget);
    while (this.tokens.length + this.activeSolves < target) {
      const need = target - this.tokens.length - this.activeSolves;
      if (need <= 0) break;
      const concurrency = this.governor?.enabled
        ? this.governor.backgroundConcurrency(this.tokens.length)
        : this.opts.solveConcurrency;
      await this.solveBatch(cfg, need, Math.max(1, concurrency));
    }
  }

  private poolHasCertifyId(certifyId: string): boolean {
    return this.tokens.some((t) => t.certifyId === certifyId);
  }

  private isDuplicateParam(param: string): boolean {
    const certifyId = parseCertifyId(param);
    if (!certifyId) return false;
    return this.certifyIds.has(certifyId) || this.poolHasCertifyId(certifyId);
  }

  private markParamIssued(param: string): void {
    const certifyId = parseCertifyId(param);
    if (certifyId) this.certifyIds.add(certifyId);
  }

  private popFresh(): string | null {
    this.pruneExpired();
    while (this.tokens.length > 0) {
      const entry = this.tokens.pop()!;
      if (entry.certifyId && this.certifyIds.has(entry.certifyId)) continue;
      this.markParamIssued(entry.param);
      return entry.param;
    }
    return null;
  }

  private pushToken(param: string): void {
    this.pruneExpired();
    if (this.tokens.length >= this.effectiveTarget) return;
    const certifyId = parseCertifyId(param);
    if (certifyId && (this.certifyIds.has(certifyId) || this.poolHasCertifyId(certifyId))) {
      return;
    }
    this.tokens.push({ param, cachedAt: Date.now(), certifyId });
  }

  private pruneExpired(): void {
    const now = Date.now();
    this.tokens = this.tokens.filter((t) => now - t.cachedAt < this.opts.tokenTtlMs);
  }

  private deficit(): number {
    this.pruneExpired();
    return Math.max(0, this.effectiveTarget - this.tokens.length - this.activeSolves);
  }

  private pruneTakeWindow(): void {
    const cutoff = Date.now() - TAKE_RATE_WINDOW_MS;
    this.takeTimestamps = this.takeTimestamps.filter((t) => t > cutoff);
  }

  private demandTarget(): number {
    this.pruneTakeWindow();
    if (this.takeTimestamps.length === 0) return this.opts.poolSizeMin;
    const ratePerSec = this.takeTimestamps.length / (TAKE_RATE_WINDOW_MS / 1000);
    const ttlSec = this.opts.tokenTtlMs / 1000;
    return Math.ceil(ratePerSec * ttlSec * 1.25);
  }

  /**
   * Target while traffic is recent: measured demand (take rate × TTL ×
   * margin) plus one token of arrival-jitter headroom, floored at
   * poolSizeMin, capped by governor + poolSizeMax. This is the ONLY sizing
   * authority while active — bursts raise demand, quiet periods drain it.
   */
  private computeActiveTarget(): number {
    const demand = Math.max(this.demandTarget(), this.opts.poolSizeMin);
    const raw = Math.ceil(demand * 1.25) + 1;
    const governorMax = this.governor?.maxPoolTarget() ?? this.opts.poolSizeMax;
    return Math.max(
      this.currentFloor(),
      Math.min(this.opts.poolSizeMax, governorMax, raw),
    );
  }

  private onTokenTaken(): void {
    this.lastTakeAt = Date.now();
    this.takeTimestamps.push(this.lastTakeAt);
    this.pruneTakeWindow();
    this.wakeFromIdle();
    // Sizing is demand-driven via computeActiveTarget() on the next refill
    // tick; takes only need to restore the active floor instantly.
  }

  /**
   * Refresh the demand/idle clock WITHOUT taking a token or widening the
   * target: an in-flight request whose SSE is still producing is activity —
   * its stream must not leave the pool decayed after the turn ends; the next
   * tool-loop turn would land on a decayed pool. Fires at stream end: a stream
   * longer than the scale-down idle still decays mid-flight to the keeper floor;
   * this resets the idle clock so computeActiveTarget() restores the full target
   * on the next refill tick. Unlike onTokenTaken this never pollutes
   * takeTimestamps (the demand-sizing signal) — it only resets the idle decay
   * levers.
   */
  touchDemand(): void {
    this.lastTakeAt = Date.now();
  }

  private maybeScaleDown(): void {
    if (this.lastTakeAt === 0) return;
    const idleMs = Date.now() - this.lastTakeAt;
    if (idleMs < this.opts.scaleDownIdleMs) return;

    this.pruneTakeWindow();
    const recentTakes = this.takeTimestamps.filter((t) => t > Date.now() - 60_000).length;
    if (recentTakes > 1) return;

    // Deep idle: decay the effective floor itself so Chromium workers and
    // solve churn wind down — first toward idleFloor, then to zero after
    // deepIdleAfterMs (no background mints at all). Any token take snaps the
    // floor back to full poolSizeMin.
    const floor = this.currentFloor();
    if (this.effectiveTarget > floor) {
      this.effectiveTarget = Math.max(floor, this.effectiveTarget - SCALE_UP_STEP);
      this.trimToTarget();
    }
  }

  /**
   * Active traffic → poolSizeMin. After scaleDownIdleMs of no takes →
   * idleFloor (keeper churn ≈ 1 mint/TTL). After deepIdleAfterMs → 0:
   * background solving stops; the banked token still serves a wake-up take.
   */
  private currentFloor(): number {
    if (this.lastTakeAt === 0) return this.opts.poolSizeMin;
    const idleMs = Date.now() - this.lastTakeAt;
    if (idleMs >= this.opts.deepIdleAfterMs) return 0;
    if (idleMs >= this.opts.scaleDownIdleMs) {
      return Math.min(this.opts.idleFloor, this.opts.poolSizeMin);
    }
    return this.opts.poolSizeMin;
  }

  /** Traffic returned: restore the full configured floor immediately. */
  private wakeFromIdle(): void {
    if (this.effectiveTarget < this.opts.poolSizeMin) {
      this.effectiveTarget = this.opts.poolSizeMin;
    }
  }

  private trimToTarget(): void {
    this.pruneExpired();
    // Never trim the last banked token: it serves a wake-up take instantly
    // (free TTFB) and expires naturally via pruneExpired.
    const floor = Math.max(this.effectiveTarget, 1);
    while (this.tokens.length > floor) {
      this.tokens.shift();
    }
  }

  private applyGovernorCaps(): void {
    if (!this.governor?.enabled) return;
    const governorMax = this.governor.maxPoolTarget();
    // Floor is idle-aware (idleFloor → 0 past deepIdleAfterMs) — don't clamp
    // it back up (that would refill forever during idle).
    const floor = this.currentFloor();
    this.effectiveTarget = Math.max(
      floor,
      Math.min(this.effectiveTarget, governorMax, this.opts.poolSizeMax),
    );
  }

  private async refill(opts: { urgent: boolean }): Promise<void> {
    if (!this.cfg) return;
    // Refresh sizing BEFORE the in-flight guard: a fill batch with slow or
    // stalling solves can hold refillInFlight for minutes, and freezing the
    // target that whole time starves the buffer exactly when demand exists.
    const idleDecay =
      this.lastTakeAt > 0 && Date.now() - this.lastTakeAt >= this.opts.scaleDownIdleMs;
    if (!idleDecay) {
      this.effectiveTarget = this.computeActiveTarget();
    } else {
      this.maybeScaleDown();
    }

    // Idle decay: drop the target toward the current floor (idleFloor → 0
    // past deepIdleAfterMs) and skip background solves while enough banked
    // tokens remain. This is what stops mint churn at zero traffic.
    if (!opts.urgent && idleDecay) {
      if (this.tokens.length >= Math.max(this.currentFloor(), 1)) return;
    }

    if (this.refillInFlight || Date.now() < this.pausedUntil) return;

    this.applyGovernorCaps();

    const ready = this.tokens.length;
    const concurrency = this.governor?.enabled
      ? opts.urgent
        ? Math.max(1, this.governor.backgroundConcurrency(ready) || this.governor.snapshot().concurrency)
        : this.governor.backgroundConcurrency(ready)
      : this.opts.solveConcurrency;

    if (!opts.urgent && concurrency === 0 && ready >= this.opts.poolSizeMin) {
      return;
    }

    const need = this.deficit();
    if (need <= 0) return;

    this.refillInFlight = true;
    try {
      await this.solveBatch(this.cfg, need, Math.max(1, concurrency));
    } finally {
      this.refillInFlight = false;
    }
  }

  /** Fire up to `need` solves in parallel waves of solveConcurrency. */
  private async solveBatch(cfg: CaptchaConfig, need: number, concurrency = this.opts.solveConcurrency): Promise<void> {
    let remaining = need;
    while (remaining > 0 && this.tokens.length + this.activeSolves < this.effectiveTarget) {
      const wave = Math.min(remaining, concurrency, this.deficit());
      if (wave <= 0) break;
      if (this.opts.staggerMs > 0) await this.waitForStagger();
      const results = await Promise.allSettled(
        Array.from({ length: wave }, () => this.solveOne(cfg)),
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          this.pushToken(r.value);
        } else {
          log.warn("parallel solve failed", { reason: r.reason instanceof Error ? r.reason.message : String(r.reason) });
        }
      }
      remaining -= wave;
      if (results.every((r) => r.status === "rejected")) break;
    }
  }

  private async waitForStagger(): Promise<void> {
    const elapsed = Date.now() - this.lastSolveAt;
    const wait = this.opts.staggerMs - elapsed;
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  private noteMintFailure(reason: string): void {
    const now = Date.now();
    this.mintFailures.push(now);
    const cutoff = now - 360_000;
    this.mintFailures = this.mintFailures.filter((t) => t > cutoff);
    this.maybeFireMintStormReset(reason);
  }

  private noteMintSuccess(): void {
    const now = Date.now();
    this.mintSuccesses.push(now);
    const cutoff = now - 360_000;
    this.mintSuccesses = this.mintSuccesses.filter((t) => t > cutoff);
  }

  /** Velocity/IP flagging signature: many failed mints in the last 5 min
   *  while nothing succeeded in the last 3. Fires the telegram IP reset at
   *  most once per cooldown — requestCaptchaIpResetSync dedupes further. */
  private maybeFireMintStormReset(latestReason: string): void {
    const now = Date.now();
    const fails = this.mintFailures.filter((t) => t > now - 300_000).length;
    const succs = this.mintSuccesses.filter((t) => t > now - 180_000).length;
    if (fails < 8 || succs > 0) return;
    if (now - this.lastStormResetAt < 12 * 60_000) return;
    this.lastStormResetAt = now;
    log.warn("mint storm detected, requesting IP reset", {
      failures: fails,
      successes: succs,
      latest: latestReason.slice(0, 120),
    });
    try {
      this.opts.onCaptchaIpBlock?.(`mint storm: ${fails} failed mints in 5min`);
    } catch {
      // callback is best-effort; never break the pool
    }
  }

  private async solveFresh(cfg: CaptchaConfig): Promise<string> {
    this.activeSolves += 1;
    this.lastSolveAt = Date.now();
    try {
      let lastErr: string | null = null;
      let sawIpBlock = false;
      for (let attempt = 1; attempt <= this.opts.solveRetries; attempt += 1) {
        try {
          const param = await runCaptchaSolve(cfg.sceneId, cfg.region, cfg.prefix);
          if (!param) {
            lastErr = "solver returned empty";
            continue;
          }
          if (this.isDuplicateParam(param)) {
            lastErr = `duplicate certifyId ${parseCertifyId(param) ?? "?"}`;
            continue;
          }
          this.noteMintSuccess();
          return param;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
          if (isCaptchaDuplicateError(lastErr)) {
            lastErr = `duplicate certifyId (F008)`;
          } else if (isCaptchaIpBlockError(lastErr)) {
            sawIpBlock = true;
          }
          this.noteMintFailure(lastErr);
        }
      }
      // All retries failed. If any failure was an IP-level block, ask the
      // caller to rotate the egress (Telegram network reset) so the next
      // mint has a fresh IP instead of being stuck unable to mint.
      if (sawIpBlock && this.opts.onCaptchaIpBlock) {
        try {
          this.opts.onCaptchaIpBlock(lastErr ?? "captcha ip block");
        } catch {
          // callback is best-effort; never let it break the pool
        }
      }
      throw new Error(`captcha failed after ${this.opts.solveRetries} attempts: ${lastErr ?? "unknown"}`);
    } finally {
      this.activeSolves -= 1;
    }
  }

  private async solveOne(cfg: CaptchaConfig): Promise<string> {
    return this.solveFresh(cfg);
  }

  /**
   * Empty-pool serve: race up to `emptyTakeRace` solves in parallel and
   * resolve with the first success so the client waits for one mint, not a
   * sequential retry chain. Extra successes are banked into the pool instead
   * of being wasted; the race only rejects when every racer fails.
   */
  private solveRaced(cfg: CaptchaConfig): Promise<string> {
    const racers = Math.max(1, Math.min(this.opts.emptyTakeRace, this.opts.solveConcurrency));
    if (racers <= 1) return this.solveFresh(cfg);

    return new Promise<string>((resolve, reject) => {
      let pending = racers;
      let served = false;
      let lastErr: unknown = null;
      for (let i = 0; i < racers; i += 1) {
        this.solveFresh(cfg).then(
          (param) => {
            if (served) {
              // Lost the race but minted a valid token — bank it.
              this.pushToken(param);
            } else {
              served = true;
              resolve(param);
            }
          },
          (err) => {
            lastErr = err ?? lastErr;
          },
        ).finally(() => {
          pending -= 1;
          if (pending === 0 && !served) {
            reject(
              lastErr instanceof Error
                ? lastErr
                : new Error(String(lastErr ?? "captcha race failed")),
            );
          }
        });
      }
    });
  }

  private initGovernor(opts: CaptchaPoolOptions): void {
    const cfg = resolveCpuGovernorConfig({
      poolSizeMin: this.opts.poolSizeMin,
      poolSizeMax: this.opts.poolSizeMax,
      solveConcurrency: this.opts.solveConcurrency,
      cpuLimitPercent: opts.cpuLimitPercent,
      cpuGovernorIntervalSec: opts.cpuGovernorIntervalSec,
    });
    if (!this.governor) {
      this.governor = new CaptchaCpuGovernor(cfg);
    } else {
      this.governor.configure(cfg);
    }
  }
}

export interface CaptchaConfig {
  enabled: boolean;
  prefix: string;
  sceneId: string;
  region: string;
}

/**
 * 按账号分池。
 *
 * 为什么不能共用一个池：token 是拿某个账号的客户端配置（`sceneId`/`prefix`，
 * 将来还可能带账号自己的指纹）解出来的，也是替那个账号去阿里云验的。混用
 * 的结果是 A 的流量把 B 的池喂大、B 的错峰心跳被 A 的补池节拍覆盖，而“一个账号
 * 的验证码频率”本身是上游可见的行为面。所以作用域是 `Map<accountId, pool>`。
 *
 * 生命周期与 highspeed 卡槽（`highspeed/slots.ts`）对齐：
 *
 * | 事件 | 动作 |
 * |---|---|
 * | 账号首次要 token | `poolFor()` 懒创建（后台补充此时才可能点燃） |
 * | 账号被删除 / 禁用 | `accounts/runtime.ts::bindCaptchaPools` 的回调调 `stopCaptchaPoolFor` |
 * | 进程关闭 | `stopCaptchaPool()`（停全部池）|
 *
 * 池表不设上限：账号数由用户配置决定（个位数），且 `stopCaptchaPoolFor` 给出了
 * 确定性回收路径；再加一层 LRU 只会让“池被默默丢掉”变成难查的行为。
 */
const pools = new Map<string, CaptchaTokenPool>();

/**
 * 全局池配置（`configureCaptchaPool` 的语义仍是“全局”）：后创建的账号池要
 * 继承它，否则一个在 `startCaptchaPool()` 之后才首次出线的账号会拿到构造默认
 * 值（未配置的 target 0）而永远不预热。
 */
let poolOptions: CaptchaPoolOptions | null = null;

/** 该账号的池（懒创建，继承全局配置）。 */
function poolFor(accountId: string): CaptchaTokenPool {
  const existing = pools.get(accountId);
  if (existing) return existing;
  const pool = new CaptchaTokenPool({ accountId });
  if (poolOptions) pool.configure(poolOptions);
  pools.set(accountId, pool);
  return pool;
}

/**
 * 全局池配置（池容量 / TTL / 补充间隔 / CPU 上限 …）。对所有已有池立即生效，
 * 并记录给后续懒创建的池。
 */
export function configureCaptchaPool(opts: CaptchaPoolOptions): void {
  poolOptions = { ...(poolOptions ?? {}), ...opts };
  for (const pool of pools.values()) pool.configure(opts);
}

/** 停全部池的后台补充（进程关闭）。solver 是全局的，一并关。 */
export function stopCaptchaPool(): void {
  for (const pool of pools.values()) pool.stopBackgroundRefill();
  pools.clear();
  shutdownCaptchaSolver();
}

/**
 * 停掉某账号的池（账号删除 / 禁用）。返回是否真的有池被停。
 *
 * 只停这个池的后台补充循环。solver 是全局的（worker 池与并发数），不随单个
 * 账号生死。
 *
 * 账号的启用状态只有账号仓知道，所以回收入口由 `accounts/runtime.ts::bindCaptchaPools`
 * 挂在 `accounts.onChange` 上，对“已删除或已禁用”的账号调 `stopCaptchaPoolFor`；
 * 接法与 `highspeed/slots.ts::bindHighspeedSlots` 相同。这里只导出入口。
 */
export function stopCaptchaPoolFor(accountId: string): boolean {
  const pool = pools.get(accountId);
  if (!pool) return false;
  pool.stopBackgroundRefill();
  pools.delete(accountId);
  return true;
}

/**
 * 当前持有池的账号 id（对账用）。池是懒创建的，所以这张表就是「哪些账号正在跑
 * 补池循环」的答案；账号启用状态不在池这边，在对账时由调用方传入。
 */
export function captchaPoolAccountIds(): string[] {
  return [...pools.keys()];
}

/** 测试缝：按账号取池实例（隔离断言用）。生产代码不读池实例。 */
export function __captchaPoolForTests(accountId: string): CaptchaTokenPool | undefined {
  return pools.get(accountId);
}

export async function takeCaptchaToken(cfg: CaptchaConfig, accountId: string): Promise<string> {
  if (!cfg.enabled || !cfg.prefix || !cfg.sceneId) {
    throw new Error("Captcha config unavailable from ZCode API");
  }
  return poolFor(accountId).takeToken(cfg);
}

/**
 * In-flight request activity (stream still producing) — see pool.touchDemand.
 *
 * 只碰已存在的池：这条路径在每条流式请求结束时都跑，为一个还没用过 captcha
 * 的账号建池会让池表随账号表增长，而 demand 的语义本来就是“刷新已启动的池的
 * 空闲时钟”（池没启动就没有可刷的时钟）。
 */
export function touchCaptchaDemand(accountId: string): void {
  pools.get(accountId)?.touchDemand();
}

export function startCaptchaPoolRefill(cfg: CaptchaConfig, accountId: string): void {
  if (!cfg.enabled || !cfg.prefix || !cfg.sceneId) return;
  poolFor(accountId).startBackgroundRefill(cfg);
}

export async function prefillCaptchaPool(cfg: CaptchaConfig, accountId: string, count?: number): Promise<void> {
  if (!cfg.enabled || !cfg.prefix || !cfg.sceneId) return;
  await poolFor(accountId).prefill(cfg, count);
}
