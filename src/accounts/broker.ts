/**
 * 唯一出线口：`acquire` / `release`。
 *
 * 一次出线：候选集（多层过滤）→ 选号 → 租约占槽（`lease.ts`）→ 三种切走
 * （saturated / drained / auth-failed）。调用点（handler / responses / async /
 * mcp / quota）都按 `Lease { account, route, credential, release }` 写，除这两个字段外
 * 还有：
 *
 * - `signal`：force 禁用时被 abort，调用方接到上游 fetch 上；
 * - `release()` 是真实的幂等释放（重复调用不重复计数）。
 *
 * 刻意**不提供** `getCredential()` 这类单凭据取用入口：那种形状会让调用点以为
 * 拿到凭据就能发请求，而端点和鉴权形态是路由的属性。调用方拿到的必须是一个
 * **已绑定的路由**，一个裸凭据不足以发请求。
 *
 * 候选集多层过滤，逐层对应 `eligibleCandidates` / `trySlot` 的判定：
 *
 * 1. `enabled`：生效值走优先级链（RuntimeOverride > entries > 账号 policy）
 * 2. 路由白名单 `account.routes`（用户意图）
 * 3. 模型能力 `routeSupportsModel`（只拦官方 builtin 配置里那条明确排除）
 * 3b. **实际套餐能力**：`routes ∩ 实际 planKinds 对应路由`，
 *     由 `PlanCapabilityAlignment` 按已探测的额度平面证据做运行时遮蔽，不改写配置
 * 4. 健康 `HealthEngine`（状态机 + 路由熔断）
 * 5. 额度 `QuotaExpirySource`（drain-first 排序，不淘汰候选）
 * 6. 在飞 < 上限（`lease.ts::inflight` 与生效的 `maxConcurrency`）
 *
 * 候选集与租约之间还有两件事：
 *
 * - **粘性绑定优先**：`sessionId → (accountId, routeKind)` 命中且健康
 *   就用它；命中但失效（TTL / 账号禁用删除 / 该路由冷却）就**解绑并当场换号**，
 *   不是等着；命中但饱和则按 `stickiness.onSaturated`（wait / overflow /
 *   wait-then-overflow）。
 * - **策略选号**：`sticky-hash`（默认）/ `balanced` / `round-robin`，
 *   排序在 `scheduler.ts`，本模块负责按顺序占槽。
 *
 * 两者的分工有一条硬要求：**overflow 不改写绑定**。所以写表只发生在
 * "本次请求没有可用绑定、由策略选出账号"的那条路径上，溢出路径一律不写。
 *
 * 本文件只装状态机与命令面：`Broker` 类的字段（租约池、健康表、绑定表、覆盖表）
 * 互相引用，拆开就是各拿一份副本，所以类实例不拆。与它无关的纯映射住在旁边两处：
 * 构造参数与「配置 → 参数」在 `broker-options.ts`，信号的调度副作用判定在
 * `signal-effects.ts`。
 */
import type { AccountsConfig } from "../config/types.js";
import { DEFAULT_ACCOUNTS_RISK, type AccountsRisk } from "../config/types.js";
import { readPolicyOverrides } from "./policy-store.js";
import { ActivityClock } from "./activity.js";
import type { AccountManager } from "./manager.js";
import type { BrokerOptions, OverrideStore } from "./broker-options.js";
import {
  DIRECT_PROXY,
  DEFAULT_PROXY_ENABLED,
  ProxyError,
  effectiveProxyName,
  egressFor,
  findProxy,
  isDirectProxy,
  validateProxies,
  type ProxySpec,
} from "./proxies.js";
import type { EgressOptions } from "../proxy/egress.js";
import { HealthEngine } from "./health.js";
import type { RouteHealth } from "./health.js";
import { observeHealth, type HealthObservation } from "./health-observation.js";
import { PlanCapabilityAlignment, type CapabilityAlignment } from "./plan-capability.js";
import { clearPersistedOverride, persistAccountOverride } from "./policy-store.js";
import type { UpstreamSignal } from "./signals.js";
import { signalEffects } from "./signal-effects.js";
import { RpmGate } from "./rpm.js";
import { LeaseManager, LeaseRejectedError, type SlotLease } from "./lease.js";
import { routeSupportsModel } from "./model-support.js";
import {
  AccountOverrides,
  resolvePolicy,
  type EffectivePolicy,
  type PolicyEntry,
} from "./overrides.js";
import {
  DEFAULT_ACCOUNTS_ROUTING,
  DEFAULT_ACCOUNTS_STICKINESS,
  type AccountsRouting,
  type AccountsStickiness,
  type SaturatedAction,
} from "./routing.js";
import { orderCandidates, StrategyRotation } from "./scheduler.js";
import { StickinessTable } from "./stickiness.js";
import type { Account, Credential, DispatchRequest, RouteKind, RuntimeOverride } from "./types.js";
import { logger } from "../log/index.js";

/** 账号子系统的日志：调度、额度采样、导入导出。*/
const log = logger("accounts");

/**
 * 一次 acquire 的输入。
 *
 * 从 {@link DispatchRequest} 派生而不是另立一份结构：调度请求的字段集是契约
 * 的一部分，抄一遍迟早与调度器对不上。`model` 缺省（mcp / quota / async 这些没有
 * 模型概念的 surface）= 不做模型能力过滤；`signal` 是客户端 abort。
 */
export type AcquireRequest = Partial<DispatchRequest> & {
  /** 客户端 abort：排队时立即退出，占槽后立即释放。*/
  signal?: AbortSignal;
};

/**
 * 租约：请求占用一个 `(account, route)` 的凭据与槽位。
 *
 * 槽位在**真正占用上游的整个期间**持有（含流式输出），所以 `release` 必须包在响应体
 * 上（ReadableStream 的 close / error / cancel，非流式在 body 读完时）或客户端 abort
 * 时立即调用，见 `proxy/lease.ts::withLeaseRelease`。
 */
export interface Lease {
  readonly account: Account;
  readonly route: RouteKind;
  readonly credential: Credential;
  /**
   * 租约自己的 AbortSignal（force 禁用会 abort 它）。
   *
   * 它同时跟随客户端 abort：所以把它接到上游 fetch 上，force 禁用与客户端断开两条
   * 路径都自动生效，调用方不必自己组合两个 signal。
   */
  readonly signal: AbortSignal;
  /** 释放租约。幂等：重复调用不重复计数。*/
  release(): void;
  /**
   * 这个账号这次出线走的代理：`undefined` = 直连。
   *
   * 由 `broker` 在发租约时算好（`entries[].proxy` > `risk.defaultProxy` > 直连）。
   * 出线层只读这个字段，不反向查 broker：`policyFor` 是 private，而让每个出线
   * 点自己拼一遍优先级链，迟早有一处与这里不一致。
   */
  readonly egress?: EgressOptions;
  /**
   * 被动探针租约：熔断路由到期放行的**真实请求**（不另造合成探测请求）。
   *
   * 出线层（`proxy/upstream-error.ts::observeUpstream`）据此把这次请求的结果只回
   * `noteProbeResult`（2xx 恢复 / 失败翻倍），**不进账号健康**（探针失败说明
   * 路由还没好，不是探针账号的错）。缺省 = 普通请求。
   */
  readonly probe?: true;
}

/**
 * broker 拒绝出线的**结构化原因码**：产生点就有码，不靠错误消息反推。
 *
 * 这里是调度器自己的原因集合，有些状态比用户身份更细（`no-account` /
 * `account-unknown` / `route-not-allowed` / `account-unhealthy`）；
 * `proxy/error-codes.ts::errorCodeOf` 是它们到 8 个用户身份的**唯一**映射（含
 * `other` 诚实兜底）。`quota-exhausted`（`onDrained: stop`）、`auth-invalid`
 * （健康态升级）、`queue-timeout`（排队超时）各自有独立产生点，不再被折成
 * `all-accounts-cooling` / `accounts-saturated`。
 *
 * `proxy/lease.ts::httpForBrokerError` 负责 HTTP 语义：容量类 429 + `Retry-After`，
 * 本地状态类 503，模型不支持 400。消息原文继续留在 `error`（detail）。
 */
export type BrokerErrorCode =
  | "no-account"
  | "account-unknown"
  | "account-disabled"
  | "route-not-allowed"
  | "accounts-saturated"
  | "all-accounts-cooling"
  | "account-unhealthy"
  | "route-broken"
  | "model-unsupported"
  | "quota-exhausted"
  | "auth-invalid"
  | "queue-timeout";

/** 无法出线。把原因码与（容量类错误的）`Retry-After` 一起带在错误上。*/
export class AccountUnavailableError extends Error {
  constructor(
    readonly code: BrokerErrorCode,
    message: string,
    /** 建议客户端多久后重试（秒）。只有容量类错误会带。*/
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AccountUnavailableError";
  }
}

/**
 * 调度读额度的唯一入口（`withinTier: drain-first` 的排序键）。
 *
 * 只读一件事：这条 `(account, route)` 的权益什么时候过期。采样器（`quota.ts`）实现了
 * 它，但 broker 只按结构引用，所以采样模块仍然不进 broker 的运行时依赖图。
 */
export interface QuotaExpirySource {
  /** `undefined` = 没有采样结果（或上游没给过期时间）。*/
  expiresAt(accountId: string, route: RouteKind): number | undefined;
}

/** 落盘口的生产实现：`policy.json` 的 `entries` 段。*/
const DEFAULT_OVERRIDE_STORE: OverrideStore = {
  set: async (label, patch) => {
    await persistAccountOverride(label, patch);
  },
  clear: async (label) => {
    await clearPersistedOverride(label);
  },
};

/** 顶栏分级采的应答形状（控制面 `quota` 命令的回复）。*/
export interface RefreshQuotaDecision {
  sampled: string[];
  skipped: string[];
  reason: "focused" | "stale" | "fresh" | "dedup" | "no-sampler";
}

/**
 * 一次「候选集 → 占槽」的结果。
 *
 * 把 account 与 slot 绑在一起传，是因为排队唤醒时 `attempt` 每次都会重新选号：
 * 唤醒后可能换成了同路由的另一个账号（禁用转移），不能沿用入队时的那个人。
 */
interface SlotPick {
  account: Account;
  slot: SlotLease;
}

/**
 * 一条"冷却中"的 `(account, route)`（全部账号冷却时，用它回答最早恢复时刻）。
 *
 * 形状与 `HealthEngine.earliestRecovery()` 的入参一致：那个方法只需要"哪些
 * `(account, route)` 没候选"，不需要知道它们为什么不可用。
 */
interface CoolingPair {
  accountId: string;
  route: RouteKind;
}

/**
 * 调度器：候选集 → 选号 → 占槽，外加运行时热调节的命令面。
 *
 * 它只依赖三样东西：账号仓（谁存在）、租约池（谁还有空槽）、健康表（谁暂时不可用）。
 * 三者的写入口都在这里，所以"读到的状态"与"改的状态"是同一份，控制面接上来时
 * 不会出现"改了一个调度器看不见的副本"。
 */
export class Broker {
  readonly routing: AccountsRouting;
  /** 粘性参数。`ttlSeconds` / `maxSessions` 在建表时生效，其余每次现读。*/
  readonly stickiness: AccountsStickiness;
  /** 运行时风控开关（热调节时 `setRoutingPolicy` 直接改这个对象）。*/
  readonly risk: AccountsRisk;
  readonly overrides: AccountOverrides;
  private readonly overrideStore: OverrideStore;
  readonly health: HealthEngine;
  /** 最近活跃时钟：拿到租约就打一拍，额度采样器据此只采活跃账号。*/
  readonly activity: ActivityClock;
  /** 上游 RPM 闸：每分钟请求数上限，超限按 saturated 处理。*/
  readonly rpm: RpmGate;
  readonly leases: LeaseManager;
  /** 粘性表。控制面可以读/清，但写入口只有调度自己。*/
  readonly bindings: StickinessTable;
  /**
   * 实际持有套餐 ↔ 配置路由的运行时交集。只读配置、只读采样事实，
   * 所以策略变更（YAML reload / 面板改 order）下一次 `acquire` 立即重对齐。
   */
  readonly capability: PlanCapabilityAlignment;
  /** 健康状态变化/熔断的结构化观测（面板账号页与路由页读）。*/
  readonly healthEvents: { snapshot(): HealthObservation; stop(): void };
  private readonly classifyRefresh: BrokerOptions["classifyRefresh"];
  private readonly onAlignment: BrokerOptions["onAlignment"];
  private readonly resample: BrokerOptions["resample"];
  /**
   * `accounts.entries[]`：构造时与配置段共用同一个数组，热重载时整体换成新配置段
   * 的数组（见 `applyConfigAccounts`）。`PolicyEntry` 只读不写，所以允许只读切片。
   */
  private entries: readonly PolicyEntry[];
  /** 出口代理表。可被控制面就地修改，所以是可变的。*/
  private proxies: ProxySpec[];
  private readonly now: () => number;
  /** 已经为哪些账号排过 RPM 唤醒（避免每个被閘下的尝试都留一个定时器）。*/
  private readonly rpmWakes = new Set<string>();
  /** 选号轮转位置（`round-robin` 与 `balanced` 平手时的判据）。*/
  private readonly rotation = new StrategyRotation();
  /** 额度采样的读口。由 `bootstrap` 在采样器造好后挂上，没挂上就是未知。*/
  private quotaExpiry: QuotaExpirySource | undefined;

  constructor(
    private readonly accounts: AccountManager,
    options: BrokerOptions = {},
  ) {
    this.routing = { ...DEFAULT_ACCOUNTS_ROUTING, ...options.routing };
    if (this.routing.order.length === 0) {
      // 空 order 会让"降级顺序"这件事失去意义，且 `mode: only` 会直接没有候选。
      // 在边界上拒绝，而不是让每个请求都静默落到"没有候选"。
      throw new Error("accounts.routing.order must list at least one route");
    }
    this.stickiness = { ...DEFAULT_ACCOUNTS_STICKINESS, ...options.stickiness };
    this.risk = { ...DEFAULT_ACCOUNTS_RISK, ...options.risk };
    this.entries = options.entries ?? [];
    this.proxies = options.proxies ?? [];
    this.now = options.now ?? Date.now;
    this.overrides = options.overrides ?? new AccountOverrides(this.now);
    this.overrideStore = options.overrideStore ?? DEFAULT_OVERRIDE_STORE;
    this.health = options.health ?? new HealthEngine(this.now);
    this.capability = new PlanCapabilityAlignment();
    this.healthEvents = observeHealth(this.health);
    this.classifyRefresh = options.classifyRefresh;
    this.onAlignment = options.onAlignment;
    this.resample = options.resample;
    this.activity = options.activity ?? new ActivityClock(this.now);
    this.rpm = options.rpm ?? new RpmGate(this.now);
    this.bindings =
      options.bindings ??
      new StickinessTable({
        ttlSeconds: this.stickiness.ttlSeconds,
        maxSessions: this.stickiness.maxSessions,
        now: this.now,
      });
    this.leases =
      options.leases ??
      new LeaseManager({
        maxQueue: () => this.routing.maxQueue,
        queueTimeoutMs: () => this.routing.queueTimeoutMs,
      });
  }

  /**
   * 把热重载后的 `accounts` 段灌进调度器持有的运行时对象。
   *
   * `policy.json` 的显式覆盖优先于 config.yaml，所以只把配置值写进「当前没有覆盖」
   * 的字段；三段各自保留原对象，`LeaseManager` 等持有它们引用的地方跟着看到新值。
   * 粘性表的 `ttlSeconds` / `maxSessions` 在构造时生效，这里不重建表。
   *
   * 代理表按名字合并：配置里写了的行以配置为准，配置里没有的运行期新增行
   * （`addProxy` 只活在内存里，从来没人把它写回 config.yaml）继续留在表里。
   */
  async applyConfigAccounts(accounts: AccountsConfig): Promise<void> {
    const persisted = await readPolicyOverrides();
    Object.assign(this.routing, accounts.routing, persisted.routing);
    Object.assign(this.stickiness, accounts.stickiness, persisted.stickiness);
    Object.assign(this.risk, accounts.risk, persisted.risk);
    this.entries = accounts.entries;
    const configured = accounts.proxies ?? [];
    const names = new Set(configured.map((proxy) => proxy.name));
    this.proxies = [...configured, ...this.proxies.filter((proxy) => !names.has(proxy.name))];
  }

  /**
   * 取租约（请求链路的第一步）。
   *
   * 调度器内部异常（存储 IO、候选集计算的意外 bug）原样上抛，打一行日志让用户看见。
   * 早先这里会静默退回「单账号 + 白名单第一条路由」，那条路径既绕过了健康与额度
   * 检查，也把 bug 藏进一个看起来正常工作的请求里；没有默认账号之后它更没有可以
   * 退回的对象。
   */
  async acquire(request: AcquireRequest = {}): Promise<Lease> {
    try {
      return await this.schedule(request);
    } catch (err) {
      if (err instanceof AccountUnavailableError) throw err;
      log.error("scheduler failed", { message: (err as Error).message }, err);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // 调度
  // -------------------------------------------------------------------------

  /**
   * 挂上额度采样的读口（`withinTier: drain-first` 的排序键）。
   *
   * 用挂载而不是构造参数：采样器要读 broker 的健康表与活跃时钟，只能在 broker 之后
   * 造（`bootstrap.ts`）。没挂上时 `expiresAt` 一律未知，同档内退化为粘性顺序。
   */
  attachQuotaExpiry(source: QuotaExpirySource): void {
    this.quotaExpiry = source;
  }

  private async schedule(request: AcquireRequest): Promise<Lease> {
    const accounts = await this.accounts.list();
    if (accounts.length === 0) {
      throw new AccountUnavailableError(
        "no-account",
        "no account available; import or log in an account first",
      );
    }

    const pinned = this.pinnedAccount(accounts, request);
    if (pinned) return await this.acquirePinned(pinned, request);
    return await this.acquireScheduled(accounts, request);
  }

  /**
   * 显式指定：`requestedAccount`（label，`X-ZCode-Account` 头）或
   * `pinnedAccountId`（Responses 续轮钉号）。
   *
   * 命中返回账号；不存在**直接报错**。这里返回 `undefined` 表示"没指定"，与"指定了
   * 但不存在"必须区分开：后者静默落到候选集里的某个账号会让这个头变成"建议"
   * 而不是"要求"。
   */
  private pinnedAccount(
    accounts: readonly Account[],
    request: AcquireRequest,
  ): Account | undefined {
    if (request.requestedAccount !== undefined) {
      const label = request.requestedAccount.trim();
      const byLabel = accounts.find((account) => account.label === label);
      if (!byLabel) {
        throw new AccountUnavailableError(
          "account-unknown",
          `requested account "${request.requestedAccount}" does not exist`,
        );
      }
      return byLabel;
    }
    if (request.pinnedAccountId !== undefined) {
      const byId = accounts.find((account) => account.id === request.pinnedAccountId);
      if (!byId) {
        throw new AccountUnavailableError(
          "account-unknown",
          `pinned account "${request.pinnedAccountId}" does not exist`,
        );
      }
      return byId;
    }
    return undefined;
  }

  /**
   * 钉住账号的路径：**不静默改道**。
   *
   * 禁用 / 不健康 / 模型不支持都直接报错；唯一的"等"是饱和：钉住的账号满了就排队
   * 等它（即使 `onSaturated: overflow` 也不溢出）：溢出等于静默换号，而用户显式指定
   * 账号的意图正是"只准用这个"。
   */
  private async acquirePinned(account: Account, request: AcquireRequest): Promise<Lease> {
    const policy = this.policyFor(account);
    if (!policy.enabled) {
      throw new AccountUnavailableError("account-disabled", `account "${account.label}" is disabled`);
    }

    const route = this.pinnedRoute(account, request.pinnedRoute);
    if (request.model !== undefined && !routeSupportsModel(route, request.model)) {
      throw new AccountUnavailableError(
        "model-unsupported",
        `route "${route}" does not serve model "${request.model}" (account "${account.label}")`,
      );
    }
    this.assertHealthy(account, route);

    // ── 熔断闭环：显式指定同样遵守熔断——不静默改道也不硬闯，
    // 快速失败或当探针放行，两条路都与策略路径同一套语义。──
    let probe: true | undefined;
    if (this.health.isRouteBroken(route)) {
      if (!this.health.isProbeDue(route)) throw this.routeBrokenError([route]);
      probe = true;
    }

    const slot =
      this.trySlot(account, route, request.signal) ??
      (await this.awaitSlot(() => this.trySlot(account, route, request.signal), request.signal));
    return this.toLease(account, route, slot, probe);
  }

  /**
   * 按 `routing.order` 逐档找候选：粘性 → 策略 → 路由降级。
   *
   * 顺序固定：先看粘性绑定，没命中或已失效才走策略选号，
   * 当前档无候选才降级到下一档。
   */
  private async acquireScheduled(
    accounts: readonly Account[],
    request: AcquireRequest,
  ): Promise<Lease> {
    const order = this.routeOrder(accounts, request.pinnedRoute);
    const sessionId = this.stickySessionId(request);
    const cooling: CoolingPair[] = [];

    if (sessionId !== undefined) {
      const bound = this.bindings.get(sessionId);
      if (bound !== undefined) {
        const account = accounts.find((candidate) => candidate.id === bound.accountId);
        if (account !== undefined && this.bindingUsable(account, bound.routeKind, order, request.model)) {
          const lease = await this.acquireBound(account, bound.routeKind, request);
          if (lease !== undefined) return lease;
          // overflow：**不改写绑定**，本次请求改走策略，下次仍回原账号。
          // 饱和动作固定为 `overflow`：`stickiness.onSaturated` 已经表态"不等"，
          // 再让 `routing.onSaturated: wait` 在这里排一次队就等于反悔。
          return await this.acquireByStrategy(accounts, order, request, {
            sessionId,
            rebind: false,
            cooling,
            saturated: "overflow",
          });
        }
        // 失效（TTL 之外）：账号禁用 / 删除 / 该 `(account, route)` 健康失败，
        // 以及"这条路由已经不在本次可调度范围里"（账号白名单收窄、`mode: only`）。
        // 冷却与满载在这里必须分开：冷却**立刻换号**（下面的策略路径），
        // 满载才按 `stickiness.onSaturated` 等或溢出（`acquireBound` 里）。
        this.bindings.unbind(sessionId);
      }
    }

    return await this.acquireByStrategy(accounts, order, request, {
      sessionId,
      rebind: true,
      cooling,
      saturated: this.routing.onSaturated,
    });
  }

  /**
   * 粘性绑定还能不能用（失效条件里需要外部状态的那几条）。
   *
   * TTL 与容量由粘性表自己判（`bindings.get` 已经过滤过期项），这里只判账号侧的
   * 事实：账号还在（由调用方判）、还启用、这条路由仍在白名单与本次的可调度范围里、
   * 模型还支持、这条 `(account, route)` 还健康。
   *
   * "不在本次可调度范围里"也算失效而不是"本次跳过"：`routing.mode: only` 下只会
   * 有一条路由被调度，钉在别的路由上的绑定永远不可能再命中，留着只会白占容量。
   */
  private bindingUsable(
    account: Account,
    route: RouteKind,
    order: readonly RouteKind[],
    model: string | undefined,
  ): boolean {
    if (!account.routes.includes(route)) return false;
    if (!order.includes(route)) return false;
    if (!this.policyFor(account).enabled) return false;
    if (model !== undefined && !routeSupportsModel(route, model)) return false;
    return this.health.isAvailable(account.id, route);
  }

  /**
   * 走绑定账号。返回 `undefined` = 溢出，调用方改走策略且**不写表**。
   *
   * 三种饱和行为在这里分岔，对应 `stickiness.onSaturated`：
   *
   * - `wait`（默认，风控优先）：等这个账号。上游缓存与「一账号一 session 命名空间」
   *   都要求同一会话不跨账号，所以默认宁等不换。
   * - `overflow`：立刻溢出到同路由空闲账号，本次**不改写**绑定。
   * - `wait-then-overflow`：先等 `overflowAfterMs`，等不到才溢出。
   *
   * 绑定路由被熔断时同样返回 `undefined`（按溢出走）——不派发、也不解绑
   * （同会话不漂移：路由故障是暂时的），探针放行 / 快速失败 / 降级由策略路径决定。
   */
  private async acquireBound(
    account: Account,
    route: RouteKind,
    request: AcquireRequest,
  ): Promise<Lease | undefined> {
    if (this.health.isRouteBroken(route)) return undefined;
    const slot = this.trySlot(account, route, request.signal);
    if (slot) return this.toLease(account, route, slot);

    switch (this.stickiness.onSaturated) {
      case "wait": {
        const waited = await this.awaitSlot(() => this.trySlot(account, route, request.signal), request.signal);
        return this.toLease(account, route, waited);
      }
      case "wait-then-overflow": {
        const waited = await this.awaitBoundSlot(account, route, request);
        return waited === undefined ? undefined : this.toLease(account, route, waited);
      }
      case "overflow":
        return undefined;
    }
  }

  /**
   * `wait-then-overflow`：等绑定账号至多 `overflowAfterMs`，超时就溢出。
   *
   * 用一个**内部** AbortController 把"等"变成可撤销的：计时器到点就 abort，`lease.wait`
   * 以 `aborted` 拒绝，这里把它读成"该溢出了"（返回 `undefined`）。客户端 abort 走
   * 同一条撤销路径但 `overflowed` 为假，所以仍然按容量错误抛出去；不能把客户端
   * 主动断开误读成溢出。
   */
  private async awaitBoundSlot(
    account: Account,
    route: RouteKind,
    request: AcquireRequest,
  ): Promise<SlotLease | undefined> {
    const controller = new AbortController();
    let overflowed = false;
    const forwardAbort = (): void => controller.abort();
    request.signal?.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => {
      overflowed = true;
      controller.abort();
    }, this.stickiness.overflowAfterMs);
    try {
      return await this.awaitSlot(() => this.trySlot(account, route, controller.signal), controller.signal);
    } catch (err) {
      if (overflowed && err instanceof AccountUnavailableError) return undefined;
      throw err;
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  /**
   * 策略选号 + 路由降级。
   *
   * 每一档的处理：
   * - 没有账号 / 没有启用且能力合格的账号 → 下一档；
   * - 全部冷却 → 记下来（最后用于"全部账号冷却中"的答复），下一档；
   * - 首选账号占不到槽 → `saturated: wait` 就在这一档排队并**停止降级**；
   *   `overflow` 则按顺序试本档其他候选，全满再降级。
   *
   * 首选为什么不能"换下一个有空的"就完事：`sticky-hash` 下首选就是本会话的账号，
   * 在 `wait` 语义里换人等于跨账号漂移（违反同一会话不跨账号这条风控约束）。所以
   * "要不要换人"由饱和动作决定，而不是由"谁有空"决定。
   *
   * `plan.saturated` 平时就是 `routing.onSaturated`，只有"粘性绑定溢出"那条路径
   * 会传入 `overflow`（`stickiness.onSaturated` 已经表态不等，这里不能再等）。
   */
  private async acquireByStrategy(
    accounts: readonly Account[],
    order: readonly RouteKind[],
    request: AcquireRequest,
    plan: { sessionId: string | undefined; rebind: boolean; cooling: CoolingPair[]; saturated: SaturatedAction },
  ): Promise<Lease> {
    let waitRoute: { route: RouteKind; probe: true | undefined } | undefined;
    const broken: RouteKind[] = [];

    for (const route of order) {
      // ── 熔断闭环 ──
      // 熔断期间该路由不派发（本地快速失败，不占槽、不打上游）；只有 `isProbeDue`
      // 认领的那一个请求放行当探针（真实流量验证恢复，不另造探测请求），其
      // 结果由出线层回 `noteProbeResult`（探针失败不冷却账号）。
      let probe: true | undefined;
      if (this.health.isRouteBroken(route)) {
        if (!this.health.isProbeDue(route)) {
          broken.push(route);
          continue;
        }
        probe = true;
      }

      const eligible = this.eligibleCandidates(accounts, route, request.model, plan.cooling);
      if (eligible.length === 0) {
        // drained + `routing.onDrained`：`stop` = "额度用完就报错，不许降级到
        // 下一档"。`fallback`（默认）不需要分支，它本来就是继续往下走。
        if (this.routing.onDrained === "stop" && this.routeOutOfQuota(accounts, route, request.model)) {
          throw this.outOfQuotaError(accounts, route, request.model);
        }
        continue;
      }

      const ordered = this.orderOn(route, eligible, plan.sessionId);
      const preferred = ordered[0];
      const slot = this.trySlot(preferred, route, request.signal);
      if (slot) return this.commit(preferred, route, slot, plan, probe);

      if (plan.saturated === "wait") {
        waitRoute = { route, probe };
        break;
      }

      // overflow：不排队，同路由换号；仍不改写绑定。
      for (const account of ordered.slice(1)) {
        const next = this.trySlot(account, route, request.signal);
        if (next) return this.commit(account, route, next, plan, probe);
      }
    }

    if (waitRoute !== undefined) {
      const { route, probe } = waitRoute;
      const pick = await this.awaitSlot(
        () => this.tryPickOnRoute(accounts, route, request, plan.sessionId),
        request.signal,
      );
      return this.commit(pick.account, route, pick.slot, plan, probe);
    }

    // 所有档都被熔断挡住：路由级拒绝（429 + Retry-After），不是账号故障。
    if (broken.length === order.length) {
      throw this.routeBrokenError(broken);
    }

    throw this.exhaustedError(accounts, order, request.model, plan.cooling);
  }

  /**
   * 选出账号后的收尾：推进轮转、必要时写粘性表、包成租约。
   *
   * 写表条件是 `sessionId !== undefined && rebind`：`rebind=false` 只出现在
   * "绑定还在、本次只是溢出"的路径上（溢出不改绑定）。
   *
   * `probe` 是熔断期放行的探针标记，随租约带给出线层的观测点。
   */
  private commit(
    account: Account,
    route: RouteKind,
    slot: SlotLease,
    plan: { sessionId: string | undefined; rebind: boolean },
    probe?: true,
  ): Lease {
    this.rotation.advance(route);
    if (plan.sessionId !== undefined && plan.rebind) {
      this.bindings.bind(plan.sessionId, account.id, route);
    }
    return this.toLease(account, route, slot, probe);
  }

  /**
   * 这一档的候选是不是**全部额度耗尽**。
   *
   * 只在 `onDrained: stop` 且该档候选为空时才问（`fallback` 不需要区分，它本来就
   * 继续往下走）；"全部 drained" 与 "全部冷却" 必须分开：前者是用户选的 `stop`
   * 要拦的，后者本来就该按 `order` 往下找。
   */
  private routeOutOfQuota(accounts: readonly Account[], route: RouteKind, model: string | undefined): boolean {
    const pool = this.quotaPool(accounts, route, model);
    if (pool.length === 0) return false;
    return pool.every((pair) => this.health.status(pair.accountId, route).status === "drained");
  }

  /** 该档"本来能用"的候选（启用 + 路由白名单 + 模型能力），用于 drained 判定。*/
  private quotaPool(accounts: readonly Account[], route: RouteKind, model: string | undefined): CoolingPair[] {
    return accounts
      .filter((account) => account.routes.includes(route) && this.isEnabledAndCapable(account, route, model))
      .map((account) => ({ accountId: account.id, route }));
  }

  /**
   * `onDrained: stop` 的拒绝。
   *
   * 额度耗尽有自己的 errorCode（`quota-exhausted`，用户词「额度耗尽 / 等重置时间恢复」），
   * 不再借 `all-accounts-cooling`：两者 HTTP 语义同为 429，但用户该做的事不同
   * （等窗口重置 vs 等自动恢复）。
   * `errorCodeOf` 直通，`Retry-After` 仍取采样器给的最早恢复时刻。
   */
  private outOfQuotaError(
    accounts: readonly Account[],
    route: RouteKind,
    model: string | undefined,
  ): AccountUnavailableError {
    const earliest = this.health.earliestRecovery(this.quotaPool(accounts, route, model));
    const message = `route "${route}" is out of quota (routing.onDrained: stop)`;
    if (earliest === undefined) return new AccountUnavailableError("quota-exhausted", message);
    return new AccountUnavailableError(
      "quota-exhausted",
      `${message}; earliest recovery in ${secondsUntil(earliest, this.now())}s`,
      secondsUntil(earliest, this.now()),
    );
  }

  /**
   * 本请求的粘性键：`undefined` = 不参与粘性。
   *
   * `stickiness.enabled: false` 与"推断不出来的会话"（`none` 来源）都走这里返回
   * `undefined`：调用方据此既不查表也不写表。`none` 来源的会话每次都是新身份，
   * 强行粘性会把互不相关的对话串到同一个账号上。
   */
  private stickySessionId(request: AcquireRequest): string | undefined {
    if (!this.stickiness.enabled) return undefined;
    const sessionId = request.sessionId?.trim();
    if (sessionId === undefined || sessionId.length === 0) return undefined;
    return sessionId;
  }

  /** 按策略给这一档的候选排序（`scheduler.ts` 是三种策略的唯一实现）。*/
  private orderOn(route: RouteKind, candidates: readonly Account[], sessionId: string | undefined): Account[] {
    return orderCandidates(
      candidates,
      {
        strategy: this.routing.strategy,
        withinTier: this.routing.withinTier,
        route,
        sessionId,
        position: this.rotation.peek(route),
      },
      {
        weight: (account) => this.policyFor(account).weight,
        inflight: (accountId, poolRoute) => this.leases.inflight(accountId, poolRoute),
        // 没有采样器时一律未知：`drain-first` 于是退化为粘性顺序，不会把“不知道”
        // 当成“快过期”排到前面。
        expiresAt: (accountId, poolRoute) => this.quotaExpiry?.expiresAt(accountId, poolRoute),
      },
    );
  }

  /**
   * 所有档都走完仍无候选时的原因码。
   *
   * 三个分支的回答必须不同：客户端该做的事完全不同（重新启用账号 / 稍后重试 / 换模型）。
   */
  private exhaustedError(
    accounts: readonly Account[],
    order: readonly RouteKind[],
    model: string | undefined,
    cooling: readonly CoolingPair[],
  ): AccountUnavailableError {
    const enabled = accounts.filter((account) => this.policyFor(account).enabled);
    if (enabled.length === 0) {
      return new AccountUnavailableError(
        "no-account",
        `every account is disabled (${accounts.length} configured)`,
      );
    }

    if (model !== undefined) {
      const servesModel = enabled.some((account) =>
        account.routes.some((route) => order.includes(route) && routeSupportsModel(route, model)),
      );
      if (!servesModel) {
        return new AccountUnavailableError(
          "model-unsupported",
          `no enabled account serves model "${model}" on routes [${order.join(", ")}]`,
        );
      }
    }

    // 全部账号冷却：取最早恢复者，明确告诉客户端都在冷却。
    // `drained` 且没有已知重置时间时也在这一档（`nextResetTime` 未必给得出），
    // 此时不带 `Retry-After`，猜一个值会让客户端按错节奏重试。
    if (cooling.length > 0) {
      const earliest = this.health.earliestRecovery(cooling);
      if (earliest === undefined) {
        return new AccountUnavailableError(
          "all-accounts-cooling",
          "every candidate account is cooling down or out of quota",
        );
      }
      return new AccountUnavailableError(
        "all-accounts-cooling",
        `every candidate account is cooling down; earliest recovery in ${secondsUntil(earliest, this.now())}s`,
        secondsUntil(earliest, this.now()),
      );
    }

    return new AccountUnavailableError(
      "accounts-saturated",
      "every candidate account is at its concurrency limit",
      SATURATED_RETRY_AFTER_SECONDS,
    );
  }

  // -------------------------------------------------------------------------
  // 候选集 / 选号
  // -------------------------------------------------------------------------

  /**
   * 候选集第一层 + 第三层：启用（按优先级链）且模型能力合格。
   *
   * 第二层（路由白名单）由 {@link eligibleCandidates} 先过；第四层（健康）也在那里；
   * 第五层（在飞）不再预判，直接 `trySlot`；上限每次现算（热调节立刻生效）。
   */
  private isEnabledAndCapable(account: Account, route: RouteKind, model: string | undefined): boolean {
    if (!this.policyFor(account).enabled) return false;
    // 实际持有套餐是硬约束（运行时交集遮蔽，不改 account.routes）。
    if (this.capability.isBlocked(account, route)) return false;
    if (model === undefined) return true;
    return routeSupportsModel(route, model);
  }

  /**
   * 候选集第二~四层：路由白名单 → 启用与能力 → 健康。
   *
   * 第三、四层"不合格"的含义不同，所以分开记：能力不合格只是"这一档没有候选"（往
   * 下一档走），而**冷却**要进 `cooling` 列表，供"全部账号冷却中"的回答给出最早恢复
   * 时间。这就是为什么冷却的收集写在这里（它是候选集计算的副产物，不是选号的一部分）。
   */
  private eligibleCandidates(
    accounts: readonly Account[],
    route: RouteKind,
    model: string | undefined,
    cooling: CoolingPair[],
  ): Account[] {
    const pool = accounts.filter((account) => account.routes.includes(route));
    if (pool.length === 0) return [];

    const capable = pool.filter((account) => this.isEnabledAndCapable(account, route, model));
    if (capable.length === 0) return [];

    const healthy = capable.filter((account) => this.health.isAvailable(account.id, route));
    if (healthy.length === 0) {
      for (const account of capable) cooling.push({ accountId: account.id, route });
    }
    return healthy;
  }

  /**
   * 排队唤醒时用：重算这一档的候选并占**首选**（调大并发 / 禁用转移都靠它）。
   *
   * 只试首选而不是"谁有空就试谁"：`sticky-hash` 下首选就是本会话的账号，按"谁有空"
   * 排队会在等待中把会话漂到另一个账号上（违反同一会话永不跨账号）。策略顺序
   * 在每次唤醒时重算，所以 `balanced` 仍会选到最先空出来的那个，`round-robin` 仍守
   * 轮转位置（游标只在真的选出账号后推进）。
   */
  private tryPickOnRoute(
    accounts: readonly Account[],
    route: RouteKind,
    request: AcquireRequest,
    sessionId: string | undefined,
  ): SlotPick | null {
    const eligible = this.eligibleCandidates(accounts, route, request.model, []);
    if (eligible.length === 0) return null;
    const preferred = this.orderOn(route, eligible, sessionId)[0];
    const slot = this.trySlot(preferred, route, request.signal);
    return slot ? { account: preferred, slot } : null;
  }

  /** 占一个槽（不阻塞）。上限每次现算，所以热调节立刻生效。*/
  private trySlot(account: Account, route: RouteKind, signal?: AbortSignal): SlotLease | null {
    const policy = this.policyFor(account);
    // saturated：RPM 超限按"此刻没空"处理，**不**把请求发上去让上游回 429，
    // 那既浪费一次配额，也是一次明确的滥用信号。未配置 = 不限。
    const rpmLimit = policy.rpmLimit;
    if (rpmLimit !== undefined && !this.rpm.allows(account.id, rpmLimit)) {
      this.scheduleRpmWake(account.id, rpmLimit);
      return null;
    }
    const slot = this.leases.tryAcquire({
      accountId: account.id,
      route,
      limit: policy.maxConcurrency,
      totalLimit: this.routing.maxTotalInflight,
      signal,
    });
    // 只有真的占到槽（即将出线）才计一次 RPM，被闸下/被满挡的尝试不计数。
    if (slot) this.rpm.record(account.id);
    return slot;
  }

  /**
   * RPM 闸把候选挡下时，窗口腾出的那一刻唤醒排队者（有界等待）。
   *
   * 不排这个定时器的话，`onSaturated: wait` 的排队者只能等到 `queueTimeoutMs` 才
   * 429；而 RPM 窗口是按时间滑动的，它本来只需要等到最早那条记录滑出窗口。
   * 每个账号只排一个（`Set` 去重），否则每个被挡的尝试都会留一个定时器。
   */
  private scheduleRpmWake(accountId: string, limit: number): void {
    if (this.rpmWakes.has(accountId)) return;
    const at = this.rpm.nextCapacityAt(accountId, limit);
    if (at === undefined) return;
    this.rpmWakes.add(accountId);
    const timer = setTimeout(() => {
      this.rpmWakes.delete(accountId);
      this.leases.notifyCapacity();
    }, Math.max(0, at - this.now()));
    // 后台定时器一律 unref：被闸死的账号不能拖住进程退出。
    timer.unref?.();
  }

  /** 排队等槽；把租约池的拒绝码翻成 broker 的结构化原因码（映射成 429）。*/
  private async awaitSlot<T>(attempt: () => T | null, signal?: AbortSignal): Promise<T> {
    try {
      return await this.leases.wait(attempt, signal);
    } catch (err) {
      if (err instanceof LeaseRejectedError) {
        // 排队超时是自己的 errorCode（`queue-timeout`），队列满
        // 是 `accounts-saturated`——两者 HTTP 语义同为 429，但用户动作不同（等恢复
        // vs 稍后重试）。`LeaseRejectionCode` 是产生点已有的结构化事实，直通。
        const code: BrokerErrorCode = err.code === "queue-timeout" ? "queue-timeout" : "accounts-saturated";
        throw new AccountUnavailableError(code, `no concurrency slot: ${err.message}`, err.retryAfterSeconds);
      }
      throw err;
    }
  }

  /**
   * 本阶段能考虑的路由顺序。
   *
   * `pinnedRoute` 优先级最高（Responses 续轮钉住路由）：此时**只**考虑这一档，且
   * 没有账号允许它时报 `route-not-allowed`，不静默改道。
   * `mode: only` 则把降级这条腿整体关掉。
   */
  private routeOrder(accounts: readonly Account[], pinnedRoute: RouteKind | undefined): RouteKind[] {
    if (pinnedRoute !== undefined) {
      const allowed = accounts.some((account) => account.routes.includes(pinnedRoute));
      if (!allowed) {
        throw new AccountUnavailableError(
          "route-not-allowed",
          `no account allows route "${pinnedRoute}"`,
        );
      }
      return [pinnedRoute];
    }
    if (this.routing.mode === "only") return [this.routing.order[0]];
    return [...this.routing.order];
  }

  /** 钉住的路由必须在白名单里，否则取白名单第一条。*/
  private pinnedRoute(account: Account, pinnedRoute: RouteKind | undefined): RouteKind {
    const first = account.routes[0];
    if (!first) {
      throw new AccountUnavailableError(
        "route-not-allowed",
        `account "${account.label}" allows no routes`,
      );
    }
    if (pinnedRoute === undefined) return first;
    if (!account.routes.includes(pinnedRoute)) {
      throw new AccountUnavailableError(
        "route-not-allowed",
        `account "${account.label}" does not allow route "${pinnedRoute}"`,
      );
    }
    return pinnedRoute;
  }

  /** 显式指定路径的健康检查（不健康直接报错，不静默改道）。*/
  private assertHealthy(account: Account, route: RouteKind): void {
    const state = this.health.status(account.id, route);
    if (state.status === "ok") return;
    const reason = state.reason === undefined ? "" : ` (${state.reason})`;
    // `auth-invalid` 健康态（连续 auth 失败升级而来）在产生
    // 点就落成自己的 errorCode——用户动作是「重新登录或导入凭据」，与冷却中的
    // 「稍后自动恢复」不同。其余非 ok 态仍走 `account-unhealthy` → 冷却用户词。
    const code: BrokerErrorCode = state.status === "auth-invalid" ? "auth-invalid" : "account-unhealthy";
    throw new AccountUnavailableError(
      code,
      `account "${account.label}" route "${route}" is ${state.status}${reason}`,
      state.until === undefined ? undefined : secondsUntil(state.until, this.now()),
    );
  }

  /**
   * 路由熔断快速失败：熔断期间不派发、不占槽、不打上游。
   *
   * 429 + `Retry-After: 60`：恢复靠被动探针（`isProbeDue` 放行真实请求）或面板
   * 「重置熔断」，60s 是"下一次有机会被放行当探针"的下界量级。路由级拒绝不是账号
   * 故障，文案必须说清"等探测恢复"而不是"账号没了"。
   */
  private routeBrokenError(routes: readonly RouteKind[]): AccountUnavailableError {
    return new AccountUnavailableError(
      "route-broken",
      `route "${routes.join(", ")}" endpoint rejected by upstream (breaker open): 路由端点被上游拒绝（熔断中），将在探测恢复后自动放行`,
      ROUTE_BROKEN_RETRY_AFTER_SECONDS,
    );
  }

  private toLease(account: Account, route: RouteKind, slot: SlotLease, probe?: true): Lease {
    // 唯一"槽位 → 租约"的汇合点：活跃打点放这里，保证 pinned / fail-open / 策略
    // 三条路径都不会漏记（活跃时钟的输入）。出口代理也在这里算，所以三种路径
    // 拿到的是同一份生效值。
    this.activity.mark(account.id);
    const lease: Lease = {
      account,
      route,
      credential: account.credential,
      signal: slot.signal,
      release: () => slot.release(),
      ...(probe !== undefined ? { probe } : {}),
    };
    const egress = this.egressFor(account);
    return egress === undefined ? lease : { ...lease, egress };
  }

  /**
   * 某账号此刻生效的出口代理：`entries[].proxy` > `risk.defaultProxy`
   * > 直连。`undefined` = 直连。
   *
   * 公开是因为两类调用方需要它：`toLease`（请求链路），以及按账号起的长驻子系统
   * （`highspeed` 卡槽 / `claim` 调度器 / `async` 桥）在构造时把值传进去。
   * 它不是给出线层反查用的入口：出线层拿 `lease.egress`。
   */
  egressFor(account: Account): EgressOptions | undefined {
    const name = effectiveProxyName(this.policyFor(account).proxy, this.risk.defaultProxy);
    return egressFor(this.proxies, name);
  }

  /** 代理表快照（控制面 `listProxies` 与面板用）。*/
  proxyTable(): readonly ProxySpec[] {
    return this.proxies;
  }

  /** 生效策略（优先级链：RuntimeOverride > entries > 账号 policy）。*/
  private policyFor(account: Account): EffectivePolicy {
    const entry = this.entries.find((candidate) => candidate.label === account.label);
    return resolvePolicy(account, entry, this.overrides.get(account.label));
  }

  /** 人工重置凭据失效态：由账号仓的重新登录/导入观察口接线。*/
  resetAuthInvalid(account: Account): void {
    for (const route of account.routes) this.health.resetAuthInvalid(account.id, route);
    this.leases.notifyCapacity();
    log.info("auth-invalid cleared by credential refresh", { account: account.label });
  }

  /** 套餐探测结果落对齐：只有成功拿到事实才调用；策略变更无需重探测。*/
  notePlanProbe(account: Account, alignment: CapabilityAlignment, origin: string): void {
    if (!alignment.changed) return;
    log.info("plan capability aligned", {
      origin,
      account: account.label,
      planKinds: alignment.planKinds ?? [],
      blocked: alignment.blocked.map((block) => `${block.route}:${block.reason}`).join(","),
    });
    this.onAlignment?.(alignment);
    // 对齐可能让一个原本 drained/cooling 之外的新候选出现（或反过来屏蔽），
    // 排队者必须重算，否则会一直等一个已经不在候选集里的账号。
    this.leases.notifyCapacity();
  }

  /** 面板顶栏刷新时的分级采：一个机制、两处用（复采也走 sampleNow）。*/
  async refreshQuota(
    accountIds: readonly string[],
    focusedId: string | undefined,
    sampleNow: (accountId: string) => Promise<unknown>,
  ): Promise<RefreshQuotaDecision> {
    const decision: RefreshQuotaDecision = { sampled: [], skipped: [], reason: "no-sampler" };
    if (!this.classifyRefresh) return { ...decision, skipped: [...accountIds] };
    const targets = this.classifyRefresh(accountIds, focusedId);
    const targetSet = new Set(targets);
    for (const id of accountIds) {
      if (!targetSet.has(id)) {
        decision.skipped.push(id);
        continue;
      }
      // 归一结果非 null = 真的发了这次请求（30s 去重命中时是 null）。
      if ((await sampleNow(id)) !== null) decision.sampled.push(id);
      else decision.skipped.push(id);
    }
    decision.reason = decision.sampled.length > 0 ? "focused" : decision.skipped.length > 0 ? "dedup" : "fresh";
    return decision;
  }

  // -------------------------------------------------------------------------
  // 健康上报（统一观测点的健康落点）
  // -------------------------------------------------------------------------

  /**
   * 统一上游信号上报（`proxy/upstream-error.ts::observeUpstream` 是唯一观测点，
   * 信号→动作的映射表在 `HealthEngine.apply`）。
   *
   * 这里只补一件调度侧的事：**可用性变化唤醒排队者**重算候选（否则它们会一直等一个
   * 已经不可用 / 刚恢复的账号）。endpoint-shape / gateway / transport 只进路由级记账、
   * model-level 不动健康——都没有候选集变化，不必唤醒。
   *
   * 取代旧的 `reportAuthFailure` / `reportRateLimited` / `reportUpstreamError`
   * 三个分立入口：403+业务码双报（auth 计数 +2）与 403+1313
   * fair-usage 被 auth 覆写，都是"多个入口各自判定"的产物；统一后 401/403 只走
   * 信号分类（查表优先），换号判定在 handler 读 `signal.kind === "auth"`。
   */
  noteUpstreamSignal(account: Account, route: RouteKind, signal: UpstreamSignal): RouteHealth {
    const health = this.health.apply(signal, account.id, route);
    const effects = signalEffects(signal);
    if (effects.availability) {
      // 冷却/耗尽/恢复 = 容量变化：唤醒排队者重算候选。
      this.leases.notifyCapacity();
    }
    if (effects.resample) {
      // 终态码/空流触发该账号即时一次额度采样，用 nextResetTime 精确化
      // until 并复核套餐持有。额度真没了 → drained（applyHealth）；额度还在 →
      // 风控软拒绝继续冷却观测（靠 10min 自愈兜底）。去重在 sampleNow。
      void this.resample?.(account.id, `signal:${signal.kind}`).catch(() => {});
    }
    return health;
  }

  // -------------------------------------------------------------------------
  // 运行时热调节命令面（CLI / 面板接在这里）
  // -------------------------------------------------------------------------

  /**
   * `setAccountEnabled(label, enabled, { drain = true })`。
   *
   * - **drain**（默认）：等在飞请求自然结束，只停止派发。排队者被唤醒后重算候选，
   *   自然转移到同路由其他账号；没有其他账号就按 `queueTimeoutMs` 超时 429。
   * - **force**（`drain: false`，必须显式）：立即 abort 在飞请求并释放槽位。中途 abort
   *   会让客户端收到半截流，所以默认不是它。
   *
   * 返回被强制中止的在飞数，供控制面回报。
   *
   * 禁用 → **解绑**粘性。这里按账号整体清（`forgetAccount`），
   * 因为禁用是账号级的，不是某条路由的；单条路由冷却仍然只靠健康判定逐条失效
   * （状态键是 `(account, route)`，不是账号）。
   */
  async setAccountEnabled(
    label: string,
    enabled: boolean,
    options: { drain?: boolean } = {},
  ): Promise<{ aborted: number }> {
    const account = await this.requireAccount(label);
    AccountOverrides.validate({ enabled });
    this.overrides.set(account.label, { enabled });
    // 落盘（默认持久化）：用户调启停通常想长期生效，重启后仍然是这个值。
    await this.overrideStore.set(account.label, { enabled });
    if (!enabled) this.bindings.forgetAccount(account.id);

    // 派发能力变了（无论启停）都要唤醒排队者：停 → 转移候选；启 → 有新槽位。
    this.leases.notifyCapacity();
    if (!enabled && options.drain === false) {
      return { aborted: this.leases.forceRelease(account.id) };
    }
    return { aborted: 0 };
  }

  /**
   * `setAccountConcurrency(label, n)`。`0` = 软禁用（停止派发，不打断在飞）。
   *
   * 调大立即唤醒排队者；**调小不驱逐**任何在飞或排队请求，上限只约束"下一次
   * acquire"，这是热调节最关键的一条（中途 abort 会让客户端收到半截流，比慢更糟）。
   *
   * `0` = 软禁用：它同样要求**解绑**粘性（新请求不再往这个账号上钉），
   * 但不动在飞请求。
   */
  async setAccountConcurrency(label: string, maxConcurrency: number): Promise<void> {
    const account = await this.requireAccount(label);
    AccountOverrides.validate({ maxConcurrency });
    this.overrides.set(account.label, { maxConcurrency });
    await this.overrideStore.set(account.label, { maxConcurrency });
    if (maxConcurrency === 0) this.bindings.forgetAccount(account.id);
    this.leases.notifyCapacity();
  }

  /** `setAccountWeight(label, n)`。权重只影响选号平手，不需要唤醒排队者。*/
  async setAccountWeight(label: string, weight: number): Promise<void> {
    const account = await this.requireAccount(label);
    AccountOverrides.validate({ weight });
    this.overrides.set(account.label, { weight });
    await this.overrideStore.set(account.label, { weight });
  }

  /**
   * `setAccountProxy(label, name)`：这个账号用哪个出口代理。
   *
   * `name` 是 `accounts.proxies[].name` 或 `direct`。引用不存在的名字、引用已停用的
   * 代理全部报错，不降级成直连。静默直连等于把这个账号的真实地址
   * 泄给上游，是本功能最危险的失败模式。
   *
   * 不需要唤醒排队者：排队在等槽位，与出口在哪无关；下一个请求自然拿到新代理。
   */
  async setAccountProxy(label: string, name: string): Promise<void> {
    const account = await this.requireAccount(label);
    const proxy = name.trim();
    if (proxy === "") {
      throw new ProxyError("unknown-proxy", 'proxy must be a name from accounts.proxies or "direct"');
    }
    AccountOverrides.validate({ proxy });
    if (!isDirectProxy(proxy)) {
      const target = findProxy(this.proxies, proxy);
      if (target === undefined) throw new ProxyError("unknown-proxy", `unknown proxy "${proxy}"`);
      if ((target.enabled ?? DEFAULT_PROXY_ENABLED) === false) {
        throw new ProxyError(
          "disabled-proxy",
          `proxy "${proxy}" is disabled; enable it before pointing an account at it`,
        );
      }
      this.assertProxyConsistent(proxy);
    }
    this.overrides.set(account.label, { proxy });
    await this.overrideStore.set(account.label, { proxy });
  }

  /**
   * 某账号此刻生效的出口代理名（优先级链出口）：`direct` = 直连。
   *
   * 与 {@link egressFor} 的区别是返回名字而不是出线参数：控制面的「使用中」统计、
   * 面板的代理列与概览的共用出口告警都按名字分组，解析成 URL 会把两账号「同一个名字」
   * 变成两段看起来不同的字符串。
   */
  accountProxyName(account: Account): string {
    return effectiveProxyName(this.policyFor(account).proxy, this.risk.defaultProxy) ?? DIRECT_PROXY;
  }

  /**
   * `addProxy`（热调节）：往表里加一条命名代理。
   *
   * 校验直接复用加载期那个校验器（`validateProxies`）：控制面能存下的值必须与手改
   * YAML 能存下的值同一套规则，否则面板里配好的一条代理会让下次启动直接报错。
   * 空的认证字段不落进表：`username: ""` 会变成「带空用户名的代理认证请求」。
   */
  addProxy(spec: ProxySpec): void {
    const candidate: ProxySpec = { name: spec.name.trim(), url: spec.url.trim() };
    if (spec.username !== undefined && spec.username !== "") candidate.username = spec.username;
    if (spec.password !== undefined && spec.password !== "") candidate.password = spec.password;
    if (spec.enabled !== undefined) candidate.enabled = spec.enabled;
    validateProxies([...this.proxies, candidate], []);
    this.proxies.push(candidate);
  }

  /**
   * `setProxy`：改地址、认证或启停。
   *
   * `undefined` = 保持原值，空串 = 清掉该字段，这是清除密码的唯一方式（面板不会回显
   * 密码，所以它也拿不到旧值来「原样提交」）。
   *
   * 停用一条仍被引用的代理是允许的：配置面要求的是「列出受影响的账号并要求确认」，
   * 确认在控制面做，拒绝在这里做会让「先停用、再逐个改绑定」这个顺序做不到。停用之后
   * 那些账号的请求会在 `egressFor` 里明确报错，不会静默直连。
   */
  updateProxy(
    name: string,
    patch: { url?: string; enabled?: boolean; username?: string; password?: string },
  ): void {
    const index = this.proxies.findIndex((proxy) => proxy.name === name);
    if (index < 0) throw new ProxyError("unknown-proxy", `unknown proxy "${name}"`);
    const next: ProxySpec = { ...(this.proxies[index] as ProxySpec) };
    if (patch.url !== undefined) next.url = patch.url.trim();
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.username !== undefined) {
      if (patch.username === "") delete next.username;
      else next.username = patch.username;
    }
    if (patch.password !== undefined) {
      if (patch.password === "") delete next.password;
      else next.password = patch.password;
    }
    validateProxies(this.proxies.map((proxy, at) => (at === index ? next : proxy)), []);
    this.proxies[index] = next;
  }

  /**
   * `removeProxy`：删一条代理。
   *
   * 仍被账号引用时拒绝（不给 `force`）：删掉之后那些账号的下一个请求会在
   * `egressFor` 里抛 unknown proxy，等于把它们一起弄坏。`force` 时把引用改回默认值
   * （`risk.defaultProxy`；它不存在或正好是被删的那条时改成显式直连），并把受影响的
   * label 回给调用方展示。静默改出口是这里最危险的动作，所以它必须是一次可见的确认。
   *
   * 已知限制：`config.yaml` 的 `entries[].proxy` 没法在这里改写，被 force 删掉的名字
   * 仍留在 YAML 里，下次启动会在加载期报 unknown proxy。控制面因此会打一行提示，
   * 让用户去改配置（不假装这件事没有发生）。
   */
  async removeProxy(name: string, force = false): Promise<{ detached: string[] }> {
    const index = this.proxies.findIndex((proxy) => proxy.name === name);
    if (index < 0) throw new ProxyError("unknown-proxy", `unknown proxy "${name}"`);
    const accounts = await this.accounts.list();
    const using = accounts.filter((account) => this.accountProxyName(account) === name);
    if (using.length > 0 && !force) {
      throw new ProxyError(
        "in-use",
        `proxy "${name}" is used by ${using.map((account) => account.label).join(", ")}`,
      );
    }
    const fallback = this.fallbackProxyName(name);
    // 先断引用再删名字：反过来，中间那段时间里 egressFor 会抛 unknown proxy。
    for (const account of using) {
      this.overrides.set(account.label, { proxy: fallback });
      await this.overrideStore.set(account.label, { proxy: fallback });
    }
    this.proxies.splice(index, 1);
    return { detached: using.map((account) => account.label) };
  }

  /** 删掉 `removed` 之后，原来指向它的账号改指哪一条（默认代理还可用就用默认，否则直连）。*/
  private fallbackProxyName(removed: string): string {
    const candidate = this.risk.defaultProxy;
    if (candidate === undefined || isDirectProxy(candidate) || candidate === removed) return DIRECT_PROXY;
    const target = findProxy(this.proxies, candidate);
    if (target === undefined || (target.enabled ?? DEFAULT_PROXY_ENABLED) === false) return DIRECT_PROXY;
    return candidate;
  }

  /** 引用一条代理前的配置一致性检查（协议白名单 + 启用状态）。*/
  private assertProxyConsistent(name: string): void {
    // 直接复用加载期的校验器：控制面写入与手改 YAML 必须走同一套规则，
    // 否则面板能存下的值重启后会把进程启动搞挂。
    validateProxies(this.proxies, [{ where: "command", name }]);
  }

  /**
   * `resetAccountOverrides(label)`：清掉内存与落盘，生效值回落到
   * `config.yaml` 的 `accounts.entries[]`。
   *
   * 两处都清才算真复位：只清内存的话，下次启动会从 `policy.json` 把刚清掉的值读回来。
   * 返回值只回答内存里有没有东西被清掉（命令面据此回 `cleared`），落盘是幂等的。
   */
  async resetAccountOverrides(label: string): Promise<boolean> {
    const account = await this.requireAccount(label);
    const cleared = this.overrides.clear(account.label);
    await this.overrideStore.clear(account.label);
    this.leases.notifyCapacity();
    return cleared;
  }

  /**
   * 账号删除时清掉它的覆盖：内存与落盘都要清。
   *
   * 只清内存的话，同名 label 重新导入会继承上一个账号的手调值，而用户删号的意思
   * 正好是「这些设置一起不要了」。
   */
  async forgetAccountOverrides(label: string): Promise<void> {
    this.overrides.clear(label);
    await this.overrideStore.clear(label);
  }

  /**
   * 把落盘的账号级覆盖灌回内存。
   *
   * 启动时调用一次。不调 `notifyCapacity`：启动那一刻还没有排队者，而且这一步发生在
   * 服务器开始监听之前。取值域已在 `policy-store.ts` 读回时筛过，这里不再校验，
   * 否则一份手改坏的文件会让代理起不来。
   */
  applyPersistedOverrides(entries: Record<string, RuntimeOverride>): void {
    for (const [label, patch] of Object.entries(entries)) {
      if (Object.keys(patch).length > 0) this.overrides.set(label, patch);
    }
  }

  private async requireAccount(label: string): Promise<Account> {
    const account = await this.accounts.getByLabel(label);
    if (!account) {
      throw new AccountUnavailableError("account-unknown", `account "${label}" does not exist`);
    }
    return account;
  }
}

/**
 * 溢出模式（`onSaturated: overflow`）走到 `order` 尽头时的 `Retry-After`（秒）。
 *
 * overflow 的语义就是"不排队"，所以这个值只表达"过一会儿再来"，不是等待上限。
 * 取 1 秒：客户端下一轮很可能已经有人释放了槽位，而更长的值会把"容量瞬时打满"
 * 误报成"账号故障"。
 */
const SATURATED_RETRY_AFTER_SECONDS = 1;

/**
 * 路由熔断快速失败的 `Retry-After`（秒）。
 *
 * 熔断的恢复靠被动探针（指数退避 2min 起步）或人工重置，60s 是"下一次有机会被
 * 放行当探针"的下界量级——比探针起步窗短，客户端到点重试正好赶上第一次探针窗口。
 */
const ROUTE_BROKEN_RETRY_AFTER_SECONDS = 60;

/** 毫秒 → 秒的换算（`Retry-After` 的单位是秒）。*/
const MS_PER_SECOND = 1_000;

/** `Retry-After` 的最小值（秒）：`Retry-After: 0` 不接受。*/
const MIN_RETRY_AFTER_SECONDS = 1;

/** `until` 距现在多少秒（向上取整）。*/
function secondsUntil(until: number, now: number): number {
  return Math.max(MIN_RETRY_AFTER_SECONDS, Math.ceil((until - now) / MS_PER_SECOND));
}
