/**
 * HealthEngine：`(account, route)` 级健康状态机 + 路由级熔断。
 *
 * **状态变化唯一入口**是 {@link HealthEngine.apply}：出线通道的每一次上游活动
 * （`UpstreamSignal`，定义在 `signals.ts`）都从这里进，动作按下表：
 *
 * | signal.kind        | 动作 |
 * |--------------------|------|
 * | `success`          | markOk + 清零 auth-failed 计数 |
 * | `rate-limited`     | cooling：`until = now + retryAfterSeconds` **无 cap** + 后置抖动 `[0, min(20%, 5s)]`；无 `retryAfterSeconds` → **无 until**（等采样确认） |
 * | `quota-terminal`   | drained：`until` 取信号 `resetAt`（如有），无则无 until |
 * | `fair-usage`       | cooling，reason=`fair-usage`，固定 30min（风控标记不是速率窗口） |
 * | `auth`             | cooling 5min + 计数 +1；连续 3 次无成功间隔 → `auth-invalid` |
 * | `endpoint-shape`   | 路由级 `endpoint-broken` 熔断计数，**不冷却账号**（不惩罚错对象） |
 * | `transport`/`gateway` | 路由级 `gateway-broken` 熔断计数，**不冷却账号**（同上） |
 * | `empty-stream`     | 账号级 cooling 短时 10min（reason=`empty-stream`；额度复采能提前翻转） |
 * | `model-level`      | 不动健康（请求级问题：换模型/减上下文，账号无辜） |
 *
 * 每个非 ok 状态都带 reason + until（或「等采样确认」语义的无 until），状态变化全落
 * 事件（{@link HealthEngine.onTransition}），页面才有稳定的状态语义可读。
 * 恢复闭环逐条都有主：cooling=时钟、drained=采样、endpoint-broken=真实流量或人工、
 * auth-invalid=人工、saturated/rpm=本地（不在本表）——**没有任何一条依赖新增的
 * 独立探测流量**。这是风控要求：固定周期的合成探测（bytes 恒定、节奏规律）比故障
 * 本身更像机器，1302 风暴就是这么踩出来的。
 *
 * 状态键是 `(accountId, routeKind)` 而不是账号：同一份凭据的 `coding-plan`
 * 被上游 401 拒绝，不代表它的 `start-plan` 也不可用。`saturated` 不在这里：它是
 * "此刻没有空槽"的瞬时事实，判定与动作在 `broker.ts` + `lease.ts`。
 *
 * 状态机纯逻辑：`now` / `random` 可注入（测试不靠真实时钟，抖动可钉住）。
 */
import type { UpstreamSignal } from "./signals.js";
import type { HealthReason, HealthStatus, RouteBreakerStatus, RouteKind } from "./types.js";

// ---------------------------------------------------------------------------
// 公开形状
// ---------------------------------------------------------------------------

/**
 * apply 的信号入参。
 *
 * 在 `UpstreamSignal` 之上补一个 `resetAt`：`quota-terminal` 的 `until` 取它。
 * 信号层本身不携带额度窗口的重置时刻（那是采样侧的字段），所以这里用结构化扩展
 * 而不是扩 `UpstreamSignal`——传普通 `UpstreamSignal` 完全兼容。
 */
export type HealthSignal = UpstreamSignal & { resetAt?: number };

/** 一个 `(account, route)` 的健康快照（`RouteState.health` 的形状）。*/
export interface RouteHealth {
  status: HealthStatus;
  /** Unix ms。`cooling` / `drained` 的恢复时间点。缺省 = 「等采样确认」（不自动回落）。*/
  until?: number;
  reason?: HealthReason;
}

/**
 * 健康状态变化事件（状态变化全部落事件，页面与日志各取所需）。
 *
 * 一次**状态变化**恰好一个事件（`from`/`to` 消歧）：ok→非 ok 是 `*-enter`，非 ok→ok
 * 是 `*-exit`，非 ok→另一种非 ok（如 cooling→auth-invalid 升级）是目标态的
 * `*-enter` 且 `from` 带原状态。同状态刷新（如 429 延长 until）不是状态变化，不落事件。
 */
export type HealthTransitionType =
  | "cooling-enter"
  | "cooling-exit"
  | "drained-enter"
  | "drained-exit"
  | "auth-invalid-enter"
  | "auth-invalid-exit"
  | "breaker-open"
  | "breaker-close"
  | "probe-result";

export interface HealthTransition {
  type: HealthTransitionType;
  route: RouteKind;
  /** 事件时刻（Unix ms，注入时钟的值）。*/
  at: number;
  /** 账号级事件必填；路由级事件（breaker/probe）带触发账号（若有）。*/
  accountId?: string;
  from?: HealthStatus;
  to?: HealthStatus;
  reason?: HealthReason;
  /** 冷却/耗尽的恢复时间点（进入事件才有）。*/
  until?: number;
  /** 排障注记：breaker-open 的排查点 / 404 弱信号注记；probe-result 的窗口变化。*/
  detail?: string;
  /** 仅 `probe-result`：探针是否成功。*/
  ok?: boolean;
}

// ---------------------------------------------------------------------------
// 状态键与常量
// ---------------------------------------------------------------------------

/**
 * 状态键分隔符：NUL（`String.fromCharCode(0)` 而不是转义写法，产出与旧版
 * `routeStateKey` 的 NUL 分隔逐字节同构；字段值里不会出现 NUL，避免
 * "ab"+"c" 与 "a"+"bc" 撞成同一键）。
 */
const STATE_KEY_SEP = String.fromCharCode(0);

/** `(accountId, routeKind)` 的状态键（状态键是账号×路由，不是账号）。 */
export function routeStateKey(accountId: string, route: RouteKind): string {
  return accountId + STATE_KEY_SEP + route;
}

/** 默认健康态。每次返回新对象，避免调用方改到共享常量。 */
function healthy(): RouteHealth {
  return { status: "ok" };
}

/** 毫秒 → 秒（`Retry-After` 的单位是秒）。 */
const MS_PER_SECOND = 1_000;

/**
 * auth-failed 冷却时长，5 分钟。
 *
 * 401/403 几乎都是凭据问题，不会秒级自愈；但也不能太长，用户改完凭据要能较快回来。
 */
const AUTH_FAILED_COOLDOWN_MS = 5 * 60_000;

/** 连续 auth 失败升级 auth-invalid 的阈值（中间没有成功请求）。 */
const AUTH_INVALID_AFTER_FAILURES = 3;

/** 1313 fair-usage 固定冷却 30min（风控标记，不是速率窗口，所以不走 retry-after）。 */
const FAIR_USAGE_COOLDOWN_MS = 30 * 60_000;

/**
 * empty-stream 软拒绝冷却 10min。
 *
 * 为什么不给无 until：无 until 的冷却只能靠额度复采兜底，而复采没把握一定能翻转
 * 空流账号，会把它卡死在 cooling 里。给一个 10min 的 until，到点自动回落，是自愈
 * 安全网；复采接线后两条路都通（复采 markOk 提前恢复）。
 */
const EMPTY_STREAM_COOLDOWN_MS = 10 * 60_000;

/**
 * `Retry-After` 后置抖动：`[0, min(retryAfter × 20%, 5s)]`。
 *
 * **只加不减**——绝不早于上游要求的恢复时刻（1302 风暴教训：大批客户端同拍重试
 * 会把限流放大成持续故障）；无 cap 采信大值（大值 = 窗口重置远，正是要的精确信号）。
 */
const RETRY_AFTER_JITTER_RATIO = 0.2;
const RETRY_AFTER_JITTER_CAP_MS = 5_000;

/** endpoint-shape 熔断窗口与阈值：5min 窗口内 405 命中 3 个不同账号即熔断。 */
const ENDPOINT_WINDOW_MS = 5 * 60_000;
const ENDPOINT_STRONG_ACCOUNTS = 3;
/** 404 是弱信号（可能只是模型 id 不存在），要 5 个不同账号才熔断。 */
const ENDPOINT_WEAK_ACCOUNTS = 5;

/** gateway-broken：连续 transport/gateway 失败 ≥3 次（路由级聚合计数，成功清零）。 */
const GATEWAY_STREAK_LIMIT = 3;

/**
 * 被动探针退避（零独立探测：探针 = 放行的下一个真实请求）：
 * 2min 起步，失败翻倍，cap 30min；每窗口 ±25% 抖动（确定性随机源可注入）。
 */
const PROBE_WINDOW_INITIAL_MS = 2 * 60_000;
const PROBE_WINDOW_MAX_MS = 30 * 60_000;
const PROBE_JITTER_RATIO = 0.25;

/**
 * 探针认领宽限：`isProbeDue` 返回 true 即一次性认领（放行下一个真实请求当探针），
 * 之后 60s 内不再放行。探针请求无回报（进程崩/流断）时 60s 后重新放行，既不
 * 「漏一路真实流量」也不「永远卡死无探针」。
 */
const PROBE_ADMISSION_GRACE_MS = 60_000;

/**
 * 状态严重度（失败写不降级）：ok(0) < cooling(1) < drained(2) < auth-invalid(3)。
 *
 * 低严重度的失败写入被拒绝：每种状态的恢复路径只有一条，drained 的恢复只靠采样，
 * 不能被一个 429 打回 cooling；同状态刷新走 no-clobber 规则（见 writeState）。
 */
function severityOf(status: HealthStatus): number {
  if (status === "auth-invalid") return 3;
  if (status === "drained") return 2;
  if (status === "cooling") return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// 状态变化事件辅助与熔断器内部形状
// ---------------------------------------------------------------------------

/** 进入事件类型：非 ok 目标态才有（ok 无 enter）。 */
function enterTypeOf(status: HealthStatus): HealthTransitionType | undefined {
  if (status === "cooling") return "cooling-enter";
  if (status === "drained") return "drained-enter";
  if (status === "auth-invalid") return "auth-invalid-enter";
  return undefined;
}

/** 退出事件类型：非 ok 原状态才有（回到 ok 落 exit）。 */
function exitTypeOf(status: HealthStatus): HealthTransitionType | undefined {
  if (status === "cooling") return "cooling-exit";
  if (status === "drained") return "drained-exit";
  if (status === "auth-invalid") return "auth-invalid-exit";
  return undefined;
}

/** 一次 endpoint-shape 命中的滑动窗口条目。 */
interface EndpointHit {
  accountId: string;
  at: number;
  /** 404 弱信号（可能为模型 id 不存在）；405 / 无 detail = 强信号（405 强制计数）。 */
  weak: boolean;
}

/**
 * 路由级熔断器的内部状态（键是 `RouteKind`）。
 *
 * 与账号级健康正交：路由端点被拒不惩罚账号，账号故障也不熔断路由。
 * `status` 缺省 = 未熔断（仍在计数/观察）；熔断关闭时整个条目删除（回落初始）。
 */
interface RouteBreakerState {
  /** 熔断打开时的形态（`endpoint-broken` / `gateway-broken`）。 */
  status?: RouteBreakerStatus;
  openedAt?: number;
  /** endpoint-shape 判定窗口（只在未熔断时累积，打开即停）。 */
  hits: EndpointHit[];
  /** 连续 transport/gateway 失败计数（成功清零；打开即停）。 */
  streak: number;
  /** 当前探针退避窗口（失败翻倍，cap 30min；关闭重建即回落 2min 起步）。 */
  probeWindowMs: number;
  /** 下一次放行探针的时刻（打开时排程；认领后推到宽限期）。 */
  probeDueAt?: number;
}

/**
 * 弱信号判定：404 的 detail 契约前缀（`signals.ts::signalFromResponse` 的
 * "HTTP 404：可能为模型 id 不存在…"）。405 的 detail 是 "HTTP 405：…"，不匹配
 * 即强信号；无 detail 的 endpoint-shape（流内形态）也按强信号计（405 强制计数）。
 */
function isWeakEndpointHit(signal: HealthSignal): boolean {
  return signal.detail !== undefined && /^HTTP 404/.test(signal.detail);
}

// ---------------------------------------------------------------------------
// HealthEngine
// ---------------------------------------------------------------------------

/**
 * 内存健康状态机（不落盘）。
 *
 * 时钟与随机源注入（`now` / `random`）：测试直接跨过冷却窗口、钉住抖动区间，不靠
 * 真实时钟。生产路径默认 `Date.now` / `Math.random`。
 */
export class HealthEngine {
  private readonly states = new Map<string, RouteHealth>();
  /** auth-failed 连续计数：按状态键计，清零只由 success 信号触发。 */
  private readonly authFailures = new Map<string, number>();
  private readonly breakers = new Map<RouteKind, RouteBreakerState>();
  private readonly listeners: ((event: HealthTransition) => void)[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * 状态变化唯一入口（信号→动作的映射见文件头；每行的恢复路径见各分支注释）。
   *
   * 返回该 `(account, route)` 状态变化后的健康快照。信号携带的观测（retryAfter /
   * resetAt / detail）只影响动作，不进状态本体。
   */
  apply(signal: HealthSignal, accountId: string, route: RouteKind): RouteHealth {
    const key = routeStateKey(accountId, route);
    this.settle(accountId, route);

    switch (signal.kind) {
      case "success": {
        // 成功：markOk + 清零 auth-failed 计数（计数清零只由 success 信号触发）。
        this.authFailures.delete(key);
        this.markOk(accountId, route);
        // 真实流量成功 = 路由恢复证据（探针也是真实流量）：整条路由恢复 + 清熔断。
        if (this.isRouteBroken(route)) {
          this.restoreRoute(route, "真实流量成功");
        } else {
          const state = this.breakers.get(route);
          if (state !== undefined) state.streak = 0;
        }
        return this.status(accountId, route);
      }
      case "rate-limited": {
        // 限流：until = now + retryAfter（无 cap）+ 后置抖动（只加不减，
        // 绝不早于上游要求——1302 风暴教训）；无 retryAfter → 无 until
        // （等采样/复采确认，不自动回落）。
        const until =
          signal.retryAfterSeconds === undefined
            ? undefined
            : this.now() +
              signal.retryAfterSeconds * MS_PER_SECOND +
              this.retryAfterJitterMs(signal.retryAfterSeconds);
        return this.writeState(
          accountId,
          route,
          { status: "cooling", reason: "rate-limited", ...(until !== undefined ? { until } : {}) },
          until !== undefined,
        );
      }
      case "quota-terminal": {
        // 额度终态：until 取信号 resetAt（如有）；无则「等采样确认」。
        const until = signal.resetAt;
        return this.writeState(
          accountId,
          route,
          { status: "drained", reason: "drained", ...(until !== undefined ? { until } : {}) },
          until !== undefined,
        );
      }
      case "fair-usage": {
        // 1313 例外：风控标记不是速率窗口，固定 30min（继续重试会放大异常流量）。
        return this.writeState(
          accountId,
          route,
          { status: "cooling", reason: "fair-usage", until: this.now() + FAIR_USAGE_COOLDOWN_MS },
          true,
        );
      }
      case "auth": {
        // 凭据问题：cooling 5min + 计数 +1；连续 3 次无成功间隔 → auth-invalid（升级，
        // 不再自动冷却循环；恢复靠 re-import / success）。
        const count = (this.authFailures.get(key) ?? 0) + 1;
        this.authFailures.set(key, count);
        if (count >= AUTH_INVALID_AFTER_FAILURES) {
          return this.writeState(accountId, route, { status: "auth-invalid", reason: "auth-failed" }, false);
        }
        return this.writeState(
          accountId,
          route,
          { status: "cooling", reason: "auth-failed", until: this.now() + AUTH_FAILED_COOLDOWN_MS },
          true,
        );
      }
      case "endpoint-shape": {
        // 端点形态被拒是路由级问题，不冷却账号（不动任何 (account, route) 态）。
        this.recordEndpointHit(route, accountId, isWeakEndpointHit(signal));
        return this.status(accountId, route);
      }
      case "transport":
      case "gateway": {
        // 同上：只进路由级 gateway-broken 计数，不冷却账号。
        this.recordGatewayFailure(route, accountId);
        return this.status(accountId, route);
      }
      case "empty-stream": {
        // 空流软拒绝：账号级信号（同路由其他账号正常），cooling 10min。
        return this.writeState(
          accountId,
          route,
          { status: "cooling", reason: "empty-stream", until: this.now() + EMPTY_STREAM_COOLDOWN_MS },
          true,
        );
      }
      case "model-level": {
        // 不动健康（请求级问题：换模型/减上下文，账号无辜）。
        return this.status(accountId, route);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 查询与直接写入（quota.ts 的采样判定、broker 的排程读取用；信号路径一律走 apply）
  // -------------------------------------------------------------------------

  /** 当前健康态。冷却/耗尽到点自动回落为 ok（含 exit 事件，不留表里，避免无限增长）。 */
  status(accountId: string, route: RouteKind): RouteHealth {
    this.settle(accountId, route);
    const state = this.states.get(routeStateKey(accountId, route));
    return state === undefined ? healthy() : { ...state };
  }

  /** 这条 (account, route) 现在能不能出线（只有 ok 能，候选集过滤的一层）。 */
  isAvailable(accountId: string, route: RouteKind): boolean {
    return this.status(accountId, route).status === "ok";
  }

  /**
   * 恢复健康（额度采样确认恢复 / 人工复位）。
   *
   * **不清 auth-failed 计数**（「计数清零只由 success 信号触发」）：坏凭据 re-import
   * 后第一次 auth 失败立刻再升级，不再自动冷却循环。
   */
  markOk(accountId: string, route: RouteKind): void {
    const key = routeStateKey(accountId, route);
    const state = this.states.get(key);
    if (state === undefined) return;
    this.states.delete(key);
    this.emitExit(route, accountId, state);
  }

  /**
   * 额度耗尽：触发在 `quota.ts` 的采样判定（`evaluateDrain`），
   * 命中后由它调用本方法；错误体业务码的 quota-terminal 信号走 apply。
   *
   * `until` = 窗口的 nextResetTime；缺省 =「没有已知恢复时间」，保持 drained 直到
   * 采样 markOk。同状态再报不抹已有 until（no-clobber，见 writeState）。
   */
  markDrained(accountId: string, route: RouteKind, until?: number): RouteHealth {
    return this.writeState(
      accountId,
      route,
      { status: "drained", reason: "drained", ...(until !== undefined ? { until } : {}) },
      until !== undefined,
    );
  }

  /**
   * 人工重置凭据失效态（auth-invalid 的自动恢复路径：manager re-import 后接线）。
   *
   * 只清 auth-invalid（其他态各有各的恢复路径，不误伤）；同样**不清 auth-failed
   * 计数**（与 markOk 同一理由）。
   */
  resetAuthInvalid(accountId: string, route: RouteKind): void {
    const key = routeStateKey(accountId, route);
    const state = this.states.get(key);
    if (state === undefined || state.status !== "auth-invalid") return;
    this.states.delete(key);
    this.emitExit(route, accountId, state);
  }

  /** 账号删除时清掉它的全部路由状态与 auth 计数，避免状态表跟着账号无限增长。 */
  forgetAccount(accountId: string): void {
    for (const route of ROUTE_STATE_SUFFIXES) {
      this.states.delete(routeStateKey(accountId, route));
      this.authFailures.delete(routeStateKey(accountId, route));
    }
  }

  /**
   * 全部不可用中最早恢复的时间点（全部账号冷却时，用它告诉客户端最早何时恢复）。
   *
   * 返回 `undefined` =「至少有一条 (account, route) 是 ok」或「全部无 until」；调用方
   * 只在确认全部不可用时才问这个问题。
   */
  earliestRecovery(pairs: readonly { accountId: string; route: RouteKind }[]): number | undefined {
    let earliest: number | undefined;
    for (const pair of pairs) {
      const state = this.status(pair.accountId, pair.route);
      if (state.status === "ok") return undefined;
      if (state.until === undefined) continue;
      if (earliest === undefined || state.until < earliest) earliest = state.until;
    }
    return earliest;
  }

  // -------------------------------------------------------------------------
  // 路由级熔断与被动探针（探针复用真实流量，不新增探测请求）
  // -------------------------------------------------------------------------

  /** 这条路由现在是否熔断（endpoint-broken / gateway-broken）：broker 据此本地快速失败。 */
  isRouteBroken(route: RouteKind): boolean {
    return this.breakers.get(route)?.status !== undefined;
  }

  /**
   * 探针到期判定（探针 = 放行的下一个真实请求，零独立探测流量）。
   *
   * **返回 true 即一次性认领**（放行一个真实请求当探针），之后
   * `PROBE_ADMISSION_GRACE_MS` 宽限内不再放行：既不把熔断期的真实流量整路漏去上游，
   * 也不让无回报的探针把放行卡死。未熔断 / 未到期返回 false。
   */
  isProbeDue(route: RouteKind, now: number = this.now()): boolean {
    const state = this.breakers.get(route);
    if (state === undefined || state.status === undefined) return false;
    if (now < (state.probeDueAt ?? 0)) return false;
    state.probeDueAt = now + PROBE_ADMISSION_GRACE_MS;
    return true;
  }

  /**
   * 探针结果回报（`broker.acquire` 接线）。
   *
   * 成功 = 路由恢复：全量恢复路由故障写下的候选 + 清熔断；失败 = 只翻倍
   * 退避窗口（2→4→8→16→30min，±25% 抖动），**不冷却该账号**：探针失败说明
   * 路由还没好，不是探针账号的错。
   */
  noteProbeResult(route: RouteKind, ok: boolean): void {
    const now = this.now();
    if (ok) {
      this.restoreRoute(route, "探针成功");
      this.emit({ type: "probe-result", route, at: now, ok: true });
      return;
    }
    const state = this.breakers.get(route);
    if (state !== undefined) {
      state.probeWindowMs = Math.min(state.probeWindowMs * 2, PROBE_WINDOW_MAX_MS);
      state.probeDueAt = now + this.jittered(state.probeWindowMs);
    }
    this.emit({ type: "probe-result", route, at: now, ok: false, detail: "探针失败：窗口翻倍" });
  }

  /** 人工重置路由熔断（endpoint-broken 的人工恢复路径）。 */
  resetBreaker(route: RouteKind): void {
    this.closeBreaker(route, "人工重置");
  }

  /** 订阅健康状态变化事件。返回退订函数；监听器异常不打断状态机。 */
  onTransition(handler: (event: HealthTransition) => void): () => void {
    this.listeners.push(handler);
    return () => {
      const index = this.listeners.indexOf(handler);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  // -------------------------------------------------------------------------
  // 内部：状态写入与事件
  // -------------------------------------------------------------------------

  /**
   * 到点状态的惰性回落（到点即从表里删掉）+ exit 事件（出冷却也是一次状态变化）。
   */
  private settle(accountId: string, route: RouteKind): void {
    const key = routeStateKey(accountId, route);
    const state = this.states.get(key);
    if (state === undefined || state.until === undefined || this.now() < state.until) return;
    this.states.delete(key);
    this.emitExit(route, accountId, state);
  }

  private emitExit(route: RouteKind, accountId: string, state: RouteHealth): void {
    const exit = exitTypeOf(state.status);
    if (exit === undefined) return;
    this.emit({
      type: exit,
      route,
      at: this.now(),
      accountId,
      from: state.status,
      to: "ok",
      ...(state.reason !== undefined ? { reason: state.reason } : {}),
    });
  }

  /**
   * 失败写入的统一闸门（每种状态的恢复路径唯一，靠这里保证不被降级覆盖）：
   *
   * - 低严重度失败不覆盖高严重度状态（429 不得把 drained / auth-invalid 打回 cooling）；
   * - 同状态刷新：新信号自带 until 才替换（no-clobber：429 无 Retry-After 的二次上报
   *   不抹已有权威窗口——`noteUpstreamFailure` 先报 rate-limited 再报业务码就是靠这条）；
   * - 状态变化恰好一个 enter 事件，同状态刷新静默。
   */
  private writeState(accountId: string, route: RouteKind, next: RouteHealth, hasExplicitUntil: boolean): RouteHealth {
    const key = routeStateKey(accountId, route);
    const current = this.states.get(key) ?? healthy();
    const currentSev = severityOf(current.status);
    const nextSev = severityOf(next.status);
    if (nextSev < currentSev) return { ...current };
    if (nextSev === currentSev && !hasExplicitUntil && current.until !== undefined) return { ...current };
    this.states.set(key, { ...next });
    if (nextSev > currentSev) {
      const enter = enterTypeOf(next.status);
      if (enter !== undefined) {
        this.emit({
          type: enter,
          route,
          at: this.now(),
          accountId,
          from: current.status,
          to: next.status,
          ...(next.reason !== undefined ? { reason: next.reason } : {}),
          ...(next.until !== undefined ? { until: next.until } : {}),
        });
      }
    }
    return { ...next };
  }

  // -------------------------------------------------------------------------
  // 内部：熔断判定
  // -------------------------------------------------------------------------

  private breakerFor(route: RouteKind): RouteBreakerState {
    let state = this.breakers.get(route);
    if (state === undefined) {
      state = { hits: [], streak: 0, probeWindowMs: PROBE_WINDOW_INITIAL_MS };
      this.breakers.set(route, state);
    }
    return state;
  }

  /**
   * endpoint-shape 计数：5min 滑动窗口，405 强信号 ≥3 不同账号、
   * 404 弱信号 ≥5 不同账号才熔断；同账号连打不熔断（单账号问题不是端点问题）。
   * 已熔断不再累积（窗口只服务「何时打开」）。
   */
  private recordEndpointHit(route: RouteKind, accountId: string, weak: boolean): void {
    const state = this.breakerFor(route);
    if (state.status !== undefined) return;
    const now = this.now();
    state.hits = state.hits.filter((hit) => now - hit.at < ENDPOINT_WINDOW_MS);
    state.hits.push({ accountId, at: now, weak });
    const distinct = new Set(state.hits.map((hit) => hit.accountId));
    const strongDistinct = new Set(state.hits.filter((hit) => !hit.weak).map((hit) => hit.accountId));
    if (strongDistinct.size >= ENDPOINT_STRONG_ACCOUNTS) {
      this.openBreaker(route, "endpoint-broken", accountId);
    } else if (distinct.size >= ENDPOINT_WEAK_ACCOUNTS) {
      this.openBreaker(route, "endpoint-broken", accountId, "404 弱信号：可能为模型 id 不存在");
    }
  }

  /**
   * transport/gateway 连败计数：连续 ≥3 次（路由级聚合、成功清零）
   * → gateway-broken。单账号的连接故障也计入——成功即清零 + 2min 探针的恢复路径
   * 比「猜哪个账号的出口代理坏了」更可靠（每账号出口代理的细分归因是后续事）。
   */
  private recordGatewayFailure(route: RouteKind, accountId: string): void {
    const state = this.breakerFor(route);
    if (state.status !== undefined) return;
    state.streak += 1;
    if (state.streak >= GATEWAY_STREAK_LIMIT) this.openBreaker(route, "gateway-broken", accountId);
  }

  /** 打开熔断并排程第一次探针（2min ±25%）；只在未熔断时生效。 */
  private openBreaker(route: RouteKind, status: RouteBreakerStatus, accountId?: string, note?: string): void {
    const state = this.breakerFor(route);
    if (state.status !== undefined) return;
    const now = this.now();
    state.status = status;
    state.openedAt = now;
    state.probeWindowMs = PROBE_WINDOW_INITIAL_MS;
    state.probeDueAt = now + this.jittered(PROBE_WINDOW_INITIAL_MS);
    this.emit({
      type: "breaker-open",
      route,
      at: now,
      ...(accountId !== undefined ? { accountId } : {}),
      detail: note === undefined ? status : status + "；" + note,
    });
  }

  /** 清熔断（判定窗口/连败/探针排程整体删除重建）；只在本来开着时落 breaker-close。 */
  private closeBreaker(route: RouteKind, note: string): void {
    const state = this.breakers.get(route);
    if (state === undefined) return;
    const status = state.status;
    this.breakers.delete(route);
    if (status === undefined) return;
    this.emit({ type: "breaker-close", route, at: this.now(), detail: status + "；" + note });
  }

  /**
   * 路由恢复（全量恢复 markOk 所有候选 + 清熔断）。
   *
   * 「候选」= 该路由下路由故障写下的 pair 态（reason 为 transport / endpoint）；凭据 /
   * 额度 / 风控归因的态各有各的恢复路径（auth-invalid=人工、drained=采样、
   * fair-usage / empty-stream=账号自身信号），不跟路由恢复走。路由故障本就不写
   * pair 态，所以这步当前是防御性兜底（将来若引入路由归因的 pair 态写入，在此生效）。
   */
  private restoreRoute(route: RouteKind, note: string): void {
    for (const [key, state] of [...this.states]) {
      const sep = key.indexOf(STATE_KEY_SEP);
      if (sep < 0 || key.slice(sep + 1) !== route) continue;
      if (state.reason !== "transport" && state.reason !== "endpoint") continue;
      this.states.delete(key);
      this.emitExit(route, key.slice(0, sep), state);
    }
    this.closeBreaker(route, note);
  }

  /** 探针窗口抖动：±PROBE_JITTER_RATIO（[0.75w, 1.25w]）；随机源可注入（测试钉住）。 */
  private jittered(windowMs: number): number {
    return Math.round(windowMs * (1 + (this.random() * 2 - 1) * PROBE_JITTER_RATIO));
  }

  /** Retry-After 后置抖动 [0, min(retryAfter×20%, 5s)]，只加不减。 */
  private retryAfterJitterMs(retryAfterSeconds: number): number {
    const cap = Math.min(retryAfterSeconds * MS_PER_SECOND * RETRY_AFTER_JITTER_RATIO, RETRY_AFTER_JITTER_CAP_MS);
    return Math.round(this.random() * cap);
  }

  private emit(event: HealthTransition): void {
    for (const handler of [...this.listeners]) {
      try {
        handler(event);
      } catch {
        // 监听器异常不得影响状态机（上报与探针同在调用链上）。
      }
    }
  }
}

/**
 * `forgetAccount` 要扫的路由集合。
 *
 * 显式列出而不是遍历 `ROUTE_KINDS`：`routes.ts` 是路由表的真源，但健康表不该为了
 * 一次清理引入对路由表的运行时依赖（那会让本模块在测试里也得先加载整张表）。
 */
const ROUTE_STATE_SUFFIXES: readonly RouteKind[] = [
  "coding-plan",
  "start-plan",
  "off-peak",
  "highspeed",
];
