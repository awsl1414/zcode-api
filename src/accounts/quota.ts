/**
 * 额度采集与 drained 判定。
 *
 * 四件事，边界分明：
 *
 * 1. **采集**：后台按 `accounts.quota.pollSeconds`（默认 300s）逐账号逐路由
 *    采样。HTTP 那一层不在这里重写，复用 `server/routes-quota.ts::collectQuotaSnapshot`
 *    （它已经知道两套平面的鉴权、身份指纹与 envelope 容错），本模块只负责"什么时候
 *    问、问谁、结果怎么归一"。
 * 2. **归一**：一次快照里两套平面各自的数据映射到 `(account, route)` 的
 *    {@link RouteQuota}（`start-plan` 看 credits，`coding-plan` 及其派生入口看窗口）。
 *    **按平面判 stale**：coding 平面挂了不许把 start-plan 的结果一起标脏。
 * 3. **判定**：四条耗尽条件任一命中就 `health.markDrained(accountId, route,
 *    until)`，该 `(account, route)` 就此退出候选集（候选集里有一层是健康过滤）；
 *    额度恢复时 `markOk` 把它放回去，状态表自己不会知道额度回来了。
 * 4. **订阅产品**：coding 平面的账号在同一轮 `sampleAccount` 里顺带问一次
 *    `subscription.ts` 的产品身份（个人 `subscription/list` / 团队
 *    `querySubscribeDetail`）。它回答「哪个产品、当前期是否有效、什么时候续期」，
 *    与窗口（用了多少）正交；失败 = unknown，保留上次产品与全部窗口数据。
 *
 * 第 4 项**没有独立定时器、没有独立缓存、没有额外相位**：一个账号一轮只有一次
 * `sampleAccount`，里面一次额度快照 + 一次订阅产品 GET，逐路由归一只是把同一份
 * 结果写进各自的样本。这样复采与启动探测都不引入新的探测流量。
 *
 * 风控上的两条硬要求：
 *
 * - **错峰 + 抖动**：首次心跳按账号 id 的 sha256 落在周期内的随机相位（确定性，
 *   重启后同一账号还在同一个相位），每轮间隔再加 ±5% 抖动。错峰解决"相位相同"，
 *   抖动解决"间隔完全相同"：固定节奏的 N 个心跳在时间序列上仍是机器特征。
 * - **只采最近活跃账号**：`quota.ts` 不自己定义"活跃"，读 `activity.ts` 的记录
 *   （由 `broker.ts` 在每次拿到租约时打一拍）。**但额度耗尽/冷却中的账号必须继续
 *   采**：它们已经被候选集排除，不再产生请求活动，只靠采样才能发现额度恢复。
 *
 * 「什么时候问」统一收口到 {@link QuotaSampler.sampleNow}：
 * 启动探测、终态码/空流即时复采、面板顶栏分级采、详情卡必采全部走这一个入口，
 * 同一账号 30s 内只发一次（去重），周期采样与它共用同一条归一/健康路径。探测成功
 * 的 `snapshot.planes` 是**套餐持有的数据面证据**，由 broker 的候选集
 * 能力对齐层消费；失败绝不猜、绝不屏蔽账号。启动首轮与复采都是本来就会发生的
 * 额度采样，只是提前/补一次，不新增独立探测流量。
 *
 * 定时器一律 `unref()`：采样器永远不能自持进程。
 */
import { createHash } from "node:crypto";
import type { ProxyConfig } from "../config/types.js";
import { collectQuotaSnapshot, type QuotaSnapshot } from "../server/routes-quota.js";
import type { ActivityClock } from "./activity.js";
import type { Broker } from "./broker.js";
import type { HealthEngine } from "./health.js";
import { toAuthCredential, type AccountManager } from "./manager.js";
import { accountDeviceMid } from "./device-mid.js";
import { quotaPlane, type QuotaPlane } from "./quota-rules.js";
import { sampleSubscription, type AccountQuotaSubscription, type SubscriptionProbe } from "./subscription.js";
export type { AccountQuotaSubscription } from "./subscription.js";
import { resolveEgressFor } from "./proxies.js";
import { PlanCapabilityAlignment, type CapabilityAlignment } from "./plan-capability.js";
import type { AccountPlanKind } from "../control/control-views.js";
import type { Account, QuotaCredits, QuotaWindow, RouteKind } from "./types.js";
import { logger } from "../log/index.js";

/** 账号子系统的日志：调度、额度采样、导入导出。*/
const log = logger("accounts");

/**
 * `accounts.quota` 段。段本身可缺省：缺省即"按默认值跑"，不强制用户配置。
 *
 * 类型放在这里（而不是 `config/types.ts`）与 `accounts/routing.ts` 是同一个理由：
 * **默认值与语义的唯一真源在实现模块里**，配置层只做聚合，避免"配置写 300、采样器
 * 按 600 跑"这种没人查得出来的偏差。
 */
export interface AccountsQuota {
  /** 采样周期，默认 300 秒。*/
  pollSeconds: number;
  /** drained 阈值：窗口已用比例 ≥ 此值即耗尽，默认 1.0。*/
  drainThreshold: number;
}

/** 默认采样周期：5 分钟。写成乘积，避免留一个裸的 `300`。*/
const DEFAULT_QUOTA_POLL_SECONDS = 5 * 60;

/** 默认 drained 阈值：100%（窗口 percentage 达到 100 即耗尽）。*/
const DEFAULT_QUOTA_DRAIN_THRESHOLD = 1;

/** `accounts.quota` 的全量默认值。*/
export const DEFAULT_ACCOUNTS_QUOTA: AccountsQuota = {
  pollSeconds: DEFAULT_QUOTA_POLL_SECONDS,
  drainThreshold: DEFAULT_QUOTA_DRAIN_THRESHOLD,
};

/**
 * 采样循环的判定粒度：1 秒。
 *
 * 错峰要求"不同账号的心跳不落在同一秒"，所以粒度必须是秒级；每 tick 只做一次
 * 「有几个账号到期了」的 Map 扫描，本身不发任何网络请求。
 */
const DUE_TICK_MS = 1_000;

/**
 * 每轮间隔的抖动幅度：周期的 ±5%。
 *
 * 5% 的取法：抖动要大到打断"固定间隔"这个机器特征，又要小到不会让实际采样率偏离
 * `pollSeconds` 太多（采样率是风控参数，不能被抖动显著改变）。
 */
const JITTER_RATIO = 0.05;

/**
 * "最近活跃"的窗口：`pollSeconds × 2`。
 *
 * 两轮周期：一轮是"上次采样到现在"，再给一轮余量，避免刚好卡在边界上的活跃账号被
 * 当成空闲跳过。
 */
const IDLE_POLL_MULTIPLE = 2;

/** 启动首轮探测的抖动窗：0–30s，与官方「登录后拉额度」同形。*/
export const STARTUP_PROBE_JITTER_MS = 30_000;

/**
 * `sampleNow` 的去重窗。
 *
 * 同一账号 30s 内只发一次：终态码/空流即时复采与顶栏分级采共用这一个预算，
 * 连点刷新或一次风暴里的多条终态信号都不会放大成请求风暴（风控上要求特征轻）。
 */
export const SAMPLE_DEDUP_WINDOW_MS = 30_000;

/** 毫秒 → 秒（`pollSeconds` 是秒，定时器吃毫秒）。*/
const MS_PER_SECOND = 1_000;

/**
 * `nextResetTime` 的秒/毫秒判别阈值。
 *
 * 上游两种都发过（`routes-quota.ts::QuotaCodingLimit.nextResetTime` 的注释）：小于
 * `1e12` 的一律按"秒"解释（`1e12` 毫秒 ≈ 2001 年，任何真实重置时间都远大于它），
 * 否则按毫秒。
 */
const EPOCH_MILLISECONDS_THRESHOLD = 1_000_000_000_000;

/**
 * 上游 `percentage` 的刻度：**0..100 的百分数**（不是 0..1 比例）。
 *
 * 依据两条，都是契约级而不是猜测：上游 `UsageQuotaLimit.percentage` 的注释写明「已使用
 * 占比」，官方展示端 `getQuotaRemainingPercentage` 就是 `100 - percentage`；官方
 * `normalizeUsagePercentage` 只做 `clamp(0, 100)`，从不除 100、也不接受比例刻度。
 * 实弹（2026-09-30 / 2026-11-09 两轮）见过的值：0 / 1 / 2 / 3 / 40 / 60 / 100。
 *
 * 这里曾用 `> 1 ? /100 : value` 猜刻度，于是 `percentage: 1`（1% 已用，官方显示
 * 99% 剩余）被读成比例 1.0 = 100% 已用 → 误判 drained。上游只发 0..100 的百分数，
 * 不需要猜刻度。
 */
const PERCENT_SCALE = 100;

/**
 * 某条路由吃哪套额度平面，定义在 `quota-rules.ts`（那里还有上游耗尽码表），
 * 这里重导出一份，调用方不必知道"静态事实"与"采样器"分居两个文件。
 */
export { quotaPlane, type QuotaPlane } from "./quota-rules.js";

/**
 * 归一到 `(account, route)` 的额度状态（`RouteState.quota` 的形状）。
 *
 * `balances` / `plans` 只由 credits 平面产出：coding 平面的窗口
 * 里没有套餐概念，所以那侧的样本不设这两段（`undefined`），汇总层见空不覆盖。
 */
export interface RouteQuota {
  /** coding 平面的窗口（5h/周 TOKENS_LIMIT、工具调用 TIME_LIMIT）。*/
  windows: QuotaWindow[];
  /** start-plan 的 credits 平面合计量。*/
  credits?: QuotaCredits;
  /** 已领套餐，credits 平面按 bucket 展开；平面没取到数据时缺省。*/
  balances?: AccountQuotaBalance[];
  /** 套餐实例（balance 载荷的 `plans[]`，套餐卡的数据源）；平面没取到数据时缺省。*/
  plans?: AccountQuotaPlan[];
  /** 可领 / 活动中的套餐（billing preview）；平面没取到数据时缺省。*/
  campaigns?: AccountQuotaCampaign[];
  /**
   * Coding Plan 订阅产品身份（个人/团队官方订阅接口归一）。只由 coding 平面的
   * 样本携带，且与额度窗口共用同一轮采样、同一个 `sampledAt`。`undefined` = 这次没
   * 取到产品身份（unknown），**不是**「没有订阅」；窗口数据照旧可用。
   */
  subscription?: AccountQuotaSubscription;
}

/**
 * 一个已领套餐的余额桶（`AccountQuotaBalance`）：credits 平面的 `balances[]` 逐桶展开，
 * 「一个 bucket 一条」。归属与周期字段随官方 `normalizeZaiStartBalanceLimits`
 * 逐字段透传：`period` 由 `balance.plans[].entitlements[]` 反查得到，是**授予/
 * 重置周期**（daily = 每日重置、one_time = 一次性），只作「刷新周期」文案——
 * 官方从不用它推套餐类型（订阅/体验的二分在数据面，credits 平面恒属
 * 体验体系）。桶归属哪个套餐看 `planId`（套餐卡的分组键）。
 * 采样数据里没有领取记录，所以 `claimedAt` 恒缺省——那要读 claim 子系统的领取
 * 结果，不为了它去改 claim。
 */
export interface AccountQuotaBalance {
  /** bucket 显示名（上游 `show_name`，如「GLM-5.3-Flash」；服务端已翻译）。*/
  name: string;
  /** 上游 `bucket_id`：桶身份（官方提醒去重键的组成部分）。*/
  bucketId?: string;
  /** 上游 `plan_id`：桶归属的套餐商品（套餐卡按它分组，官方契约保证每桶都带）。*/
  planId?: string;
  /** 上游 `user_plan_id`：用户套餐实例身份。*/
  userPlanId?: string;
  /** 上游 `entitlement_id`：桶挂的权益，period 反查链的钥匙。*/
  entitlementId?: string;
  /** 归属 entitlement 的授予/重置周期（daily / one_time）：只作「刷新周期」文案。*/
  period?: string;
  remainingUnits: number;
  totalUnits: number;
  /** 上游 `available_units`：扣掉进行中请求预留后的可用量（不是「剩余」，语义完整透传）。*/
  availableUnits?: number;
  /** 上游 `reserved_units`：进行中请求的预留量（解释「可用 ≠ 剩余」）。*/
  reservedUnits?: number;
  /** 上游 `meter`：计量面（如 model_usage）。*/
  meter?: string;
  unitType?: string;
  /** 上游 `capabilities` 原样（如 `model:glm-5.3-flash`）。*/
  capabilities?: string[];
  /** 这个桶整体到期/重置的时刻（Unix ms）；上游两种刻度都发过，已归一。*/
  expiresAt?: number;
  /** 桶的当前授予周期起点（Unix ms；active 桶判定与提醒去重键用）。*/
  periodStart?: number;
  /** 桶的当前授予周期终点（Unix ms）。*/
  periodEnd?: number;
  /** 本地领取时间（Unix ms）。采样数据里没有，恒缺省。*/
  claimedAt?: number;
}

/**
 * 一个套餐实例（套餐卡的数据源）：credits 平面 `billing/balance` 载荷的
 * `plans[]` 逐字段对齐官方 `ZaiStartPlanPlan`（对应官方三层结构里的实例层）。
 *
 * 套餐卡按 `plan_id` 分组、卡片名取 `name`、状态词由 `status` + `endsAt` +
 * `entitlements[].effectiveAt` 投影（「待生效」= 生效时刻在未来，官方
 * `resolveStartPlanStatusMetaState` 同口径）。活动套餐与基础套餐在数据上同构，
 * 都走这里，无类型字段区分。
 */
export interface AccountQuotaPlan {
  planId: string;
  /** 用户套餐实例身份（上游 `user_plan_id`；同商品多实例时区分归属）。*/
  userPlanId?: string;
  /** 面向用户的套餐名（卡片标题，如「ZCode Start Plan」「ZCODE GLOBAL BUILD」）。*/
  name: string;
  /**
   * 上游 `status` 原值（实测 `active` / `expired`）。不收窄成枚举：服务端契约
   * 文档不在客户端仓，未知取值不猜；「已过期」的展示判定叠
   * `endsAt` 已过（官方 `normalizeStartPlanExpiry` 同款强制归一）。
   */
  status?: string;
  /** 生效时刻（Unix ms）。*/
  startsAt?: number;
  /** 过期时刻（Unix ms）；「已过期」的展示判定叠它。*/
  endsAt?: number;
  entitlements: Array<{
    /** 上游 `entitlement_id`：权益身份（桶反查 period 的钥匙）。*/
    entitlementId?: string;
    showName: string;
    /** 授予/重置周期（daily / one_time）：只作「刷新周期」文案。*/
    period?: string;
    /** 该权益生效时刻（Unix ms；`0` = 立即生效哨兵，未来值 = 「待生效」）。*/
    effectiveAt?: number;
  }>;
}

/**
 * 一个可领 / 活动中的套餐。来源是 billing preview（领取客户端证实
 * 营销活动也在这个载荷里带起止时间）；marketing/touch 横幅面仍归 claim 子系统
 * 枚举，所以 `source` 目前恒为 `"preview"`，字段留给两种来源共用。
 *
 * 与 {@link AccountQuotaPlan} 的分工：这是**领取前的活动位**（本期活动段），不是
 * 套餐卡的数据源——已领实例在 `plans[]`（balance 载荷）里。`status` 是本仓的
 * 展示语义：`claimed` = 同 `planId` 的实例已出现在 balance 的 `plans[]` 里
 * （精确比对 planId，不再按名字撞桶）。
 */
export interface AccountQuotaCampaign {
  planId: string;
  name: string;
  description?: string;
  /** 活动起止（Unix ms，营销活动才有）。*/
  startsAt?: number;
  endsAt?: number;
  /** 状态：可领 / 已领 / 失效。*/
  status: "claimable" | "claimed" | "expired";
  /** entitlements 展开成一行人话：`GLM-5.3-Flash 5亿 token`。*/
  entitlements: Array<{
    /** 上游 `entitlement_id`：权益身份。*/
    entitlementId?: string;
    showName: string;
    grantUnits: number;
    unitType: string;
    /** 该权益生效时刻（Unix ms）。*/
    effectiveAt?: number;
    /** 授予/重置周期（daily / one_time）：只作「刷新周期」文案。*/
    period?: string;
  }>;
  /** 来源：billing preview 还是营销横幅。当前只接了 preview。*/
  source?: "preview" | "banner";
}

/** drained 判定结果。`reasons` 为空即未耗尽，逐条写清是哪个条件命中的。*/
export interface DrainDecision {
  drained: boolean;
  /** 恢复时间点（Unix ms），取自命中窗口的 `nextResetTime`；无则"等采样发现恢复"。*/
  until?: number;
  /** 命中的条件（日志 / 控制面「最近失败原因」，风控可见性要求）。*/
  reasons: string[];
}

/** 一次 `(account, route)` 的采样结果。*/
export interface QuotaSample {
  accountId: string;
  route: RouteKind;
  /** 归一后的额度状态；`null` = 至今没取到过数据（首次采样就失败）。*/
  quota: RouteQuota | null;
  /** 结果对应的采样时刻（Unix ms）。stale 时保留上一次的时刻。*/
  sampledAt: number;
  /** 本次采样失败：保留上一次结果并标记 stale，不清空。*/
  stale: boolean;
  /** 失败原因（控制面展示用）。*/
  error?: string;
}

/** 采样器的依赖。全部注入，便于测试跨过时钟与网络。*/
export interface QuotaSamplerOptions {
  config: ProxyConfig;
  accounts: AccountManager;
  health: HealthEngine;
  /** "最近活跃"的来源（`broker.ts` 写入）。*/
  activity: ActivityClock;
  /** `accounts.quota` 段；缺省回落 {@link DEFAULT_ACCOUNTS_QUOTA}。*/
  quota?: Partial<AccountsQuota>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** 均匀随机源（抖动用）。注入是为了让"抖动幅度"可断言。*/
  random?: () => number;
  /** 调度器：能力对齐事实与分级采都挂在它身上；测试可注入替身。*/
  broker?: PlanProbeBroker;
}

/** 采样器需要的 broker 读/写口（不 import Broker 类型，避免采样模块进入运行时环）。*/
export interface PlanProbeBroker {
  capability: PlanCapabilityAlignment;
  notePlanProbe(account: Account, alignment: CapabilityAlignment, origin: string): void;
}

/**
 * 后台额度采样器。
 *
 * 生命周期：`start()` 起定时器（unref），`stop()` 收起。定时器只负责"到点了没有"，
 * 采样在 `tick()` 里按账号串行跑。串行是刻意的：N 个账号同时打上游额度
 * 端点本身就是错峰要消除的模式。
 */
export class QuotaSampler {
  readonly quota: AccountsQuota;
  private readonly config: ProxyConfig;
  private readonly accounts: AccountManager;
  private readonly health: HealthEngine;
  private readonly activity: ActivityClock;
  private readonly broker: PlanProbeBroker;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  /** 每 `(accountId, route)` 的最近结果。*/
  private readonly samples = new Map<string, QuotaSample>();
  /** 每个账号下一轮到期的时刻（Unix ms）；没有条目 = 还没排过错峰相位。*/
  private readonly nextDueAt = new Map<string, number>();
  /** 每账号最近一次发采样请求的时刻（`sampleNow` 的 30s 去重）。*/
  private readonly lastSampleAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** 上一轮还没跑完（上游慢）时跳过本轮，避免请求叠加。*/
  private ticking = false;
  /** 启动探测是否已经排过（幂等，YAML reload 不重排）。*/
  private startupScheduled = false;
  /** 启动探测定时器（unref，永不自持进程）。*/
  private readonly startupTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: QuotaSamplerOptions) {
    this.config = options.config;
    this.accounts = options.accounts;
    this.health = options.health;
    this.activity = options.activity;
    // 未注入 broker 的用例（纯归一/判定测试）用一份空对齐表：不屏蔽任何账号，
    // 旧用例的候选集断言因此不受影响。
    this.broker = options.broker ?? {
      capability: new PlanCapabilityAlignment(),
      notePlanProbe: () => {},
    };
    this.quota = { ...DEFAULT_ACCOUNTS_QUOTA, ...options.quota };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /** 起后台采样（幂等）。定时器 `unref()`：永不自持进程。*/
  start(): void {
    if (this.timer !== undefined) return;
    const timer = setInterval(() => {
      void this.tick();
    }, DUE_TICK_MS);
    timer.unref?.();
    this.timer = timer;
  }

  /** 后台循环是否在跑（控制面 / 测试用；不代表本轮采样正在进行）。*/
  get running(): boolean {
    return this.timer !== undefined;
  }

  /** 停后台采样（不 await 在飞的那一轮，它自己会结束）。*/
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const timer of this.startupTimers) clearTimeout(timer);
    this.startupTimers.clear();
  }

  /** 热重载后替换采样参数。下一次 tick 按新周期计算到期时间。 */
  applyConfigQuota(quota: Partial<AccountsQuota>): void {
    Object.assign(this.quota, DEFAULT_ACCOUNTS_QUOTA, quota);
    this.nextDueAt.clear();
  }

  /** 某条 `(account, route)` 的最近一次结果（控制面 / 测试读）。*/
  sample(accountId: string, route: RouteKind): QuotaSample | undefined {
    return this.samples.get(sampleKey(accountId, route));
  }

  /**
   * 该 `(account, route)` 的权益什么时候过期（Unix ms，`withinTier: drain-first` 的主序键）。
   *
   * `undefined` = 还没采到过，或上游没给过期时间。调度器据此把该账号排在同档已知
   * 结果之后、彼此按调度基线分散：“不知道”不等于“快过期”，有数据的
   * 账号仍然先烧。stale 的旧结果照旧用：额度是慢变量，一次采集失败
   * 不该把已知的过期时间抹掉。
   */
  expiresAt(accountId: string, route: RouteKind): number | undefined {
    const sample = this.samples.get(sampleKey(accountId, route));
    if (sample?.quota === undefined || sample.quota === null) return undefined;
    return expiryOf(sample.quota, route);
  }

  /** 全部最近结果（控制面额度页用）。*/
  snapshot(): QuotaSample[] {
    return [...this.samples.values()].map((sample) => ({ ...sample }));
  }

  /**
   * 唯一采样入口：启动首轮探测、终态码/空流即时复采、
   * 顶栏分级采、详情卡「必采」全部走这里。
   *
   * `origin` 只用于「对齐生效」的调度事件归因，不改变采样行为。详情卡「必采」是
   * 跳过分级采的分类（直接调本入口），不是另开一条绕过 30s 去重的旁路
   * （分级采里「必采」优先，但同账号连点的去重仍然生效）。
   *
   * 返回本次归一后的样本数组；`null` = 这次没发请求（账号不存在 / 30s 内已采）。
   * 调用方据此给面板答「用了缓存」而不是「刷新成功」；一等公民返回值也让周期
   * 采样与刷新命令共用同一份归一结果，不必再回读一次缓存。
   */
  async sampleNow(accountId: string, origin: string): Promise<QuotaSample[] | null> {
    const now = this.now();
    const last = this.lastSampleAt.get(accountId);
    if (last !== undefined && now - last < SAMPLE_DEDUP_WINDOW_MS) return null;
    const account = await this.accounts.get(accountId);
    if (!account) return null;
    this.lastSampleAt.set(accountId, now);
    return await this.sampleAccount(account, origin);
  }

  /**
   * 启动首轮主动探测：对**每个**账号各排一次额度采样，0–30s 抖动窗
   * 内复用账号哈希的错峰相位（确定性，随机源可注入）。
   *
   * 停用的账号也在其列：`enabled` 只决定它参不参与调度，账号页仍然要展示它的
   * 额度。停用账号不产生活跃记录，周期采样按"只采最近活跃账号"永远跳开它们，
   * 若启动首轮也筛掉，它们的额度列就只能是「未采样」，只能靠手动刷新拿到值。
   * 采样本身不改调度资格：只写样本与（成功时的）能力对齐，不碰健康态与 `enabled`。
   *
   * 与官方客户端「登录后拉额度」同形、不新增独立探测流量：它就是本来会在
   * 首个周期内发生的那次采样，只是提前到启动后；账号变多只是同一窗口里多几个
   * 相位，不并发打上游。失败不屏蔽账号——只有拿到 `snapshot.planes` 才写能力
   * 对齐（{@link sampleAccount} 内判定）。定时器 `unref()`，且进程收尾时
   * {@link stop} 一并清掉。
   */
  async probeAtStartup(): Promise<number[]> {
    if (this.startupScheduled) return [];
    this.startupScheduled = true;
    const delays: number[] = [];
    for (const account of await this.accounts.list()) {
      const phase = Math.floor(this.staggerMs(account.id) / DUE_TICK_MS) % (STARTUP_PROBE_JITTER_MS / DUE_TICK_MS);
      // 确定性哈希相位 × 注入随机源：同一账号重启后仍在同一相位，随机源只用来
      // 让 0–30s 窗口内的起点不固定（与周期采样的错峰/抖动同一纪律）。
      const delayMs = Math.floor(this.random() * STARTUP_PROBE_JITTER_MS);
      const offset = (phase * 1_000 + delayMs) % STARTUP_PROBE_JITTER_MS;
      delays.push(offset);
      const timer = setTimeout(() => {
        this.startupTimers.delete(timer);
        void this.sampleNow(account.id, "startup").catch(() => {});
      }, offset);
      timer.unref?.();
      this.startupTimers.add(timer);
    }
    return delays;
  }

  /**
   * 顶栏刷新的分级采：四类决策全部由本采样器的样本龄与去重表回答，
   * 不引入第二份「上次采样时刻」。
   *
   * 1. 抽屉详情账号必采（focused）；
   * 2. 采样失败沿用旧值（stale）/ 超过一个采样周期 → 补采；
   * 3. 新鲜账号不采；
   * 4. 同账号 30s 去重（在 {@link sampleNow} 里）。
   */
  classifyRefresh(accountIds: readonly string[], focusedId: string | undefined): string[] {
    const now = this.now();
    const periodMs = this.periodMs();
    const targets: string[] = [];
    for (const id of accountIds) {
      if (id === focusedId) {
        targets.push(id);
        continue;
      }
      const mine = this.snapshot().filter((entry) => entry.accountId === id);
      if (mine.length === 0 || mine.some((entry) => entry.stale)) {
        targets.push(id);
        continue;
      }
      const newest = Math.max(...mine.map((entry) => entry.sampledAt));
      if (now - newest >= periodMs) targets.push(id);
    }
    return targets;
  }

  /**
   * 一轮采样：把到期的账号采一遍。
   *
   * 到期判定分两步：先看错峰相位（`nextDueAt`），再看是否值得采（{@link shouldSample}
   * 健康出问题时无条件采，否则只采最近活跃账号）。周期采样同样走
   * {@link sampleNow}：这样「刚周期采过又收到终态码」与「启动探测刚采过就到周期」
   * 都由同一个 30s 去重窗吃掉，特征不增。
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const account of await this.accounts.list()) {
        if (!this.isDue(account, now)) continue;
        if (!this.shouldSample(account)) continue;
        await this.sampleNow(account.id, "periodic");
        this.nextDueAt.set(account.id, this.now() + this.roundDelayMs());
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * 采一个账号的全部额度路由（唯一归一路径，只由 {@link sampleNow} 调用）。
   *
   * 一次 HTTP 采集喂该账号的所有额度路由：两套平面在**同一批请求**里返回
   * （`collectQuotaSnapshot` 一次拿齐），再按平面归一到每条路由。逐条路由各打一次
   * 上游等于把探测频率翻倍，与错峰、只采活跃账号这两条风控纪律直接冲突。
   *
   * 订阅产品也在这一轮里采一次（只对 coding 平面账号），与额度快照共用
   * 错峰相位、串行 tick、`nextDueAt` 去重与 `sampledAt`。订阅失败只留 `unknown`，
   * 不让额度窗口跟着降级；上一次成功的产品身份由 coding 样本自己留着（与额度
   * 采样的 stale 纪律一致）。
   * `snapshot.planes` 是能力对齐的**数据面事实**；只有成功拿到
   * 数据才更新对齐。某平面失败不等于「账号没有这个套餐」——那种推断会把一次
   * 网络抖动变成永久屏蔽，所以失败一律 `undefined`（不猜、不屏蔽）。
   */
  private async sampleAccount(account: Account, origin: string): Promise<QuotaSample[]> {
    const targets = quotaRoutesOf(account);
    if (targets.length === 0) return [];
    const now = this.now();
    let snapshot: QuotaSnapshot;
    try {
      snapshot = await collectQuotaSnapshot(
        this.config,
        toAuthCredential(account.credential),
        // 额度采集也是“这个账号发出去的请求”：billing 网关看到的设备指纹
        // 必须是账号自己的，不能是进程级全局值。
        accountDeviceMid(account) ?? "",
        this.fetchImpl,
      );
    } catch (err) {
      // 有意的 fail-open（与调度兜底同一条原则）：采样是后台任务，一次异常不能让定时器
      // 停摆，也不能把已有的额度结论清空，保留上次结果并标记 stale。
      log.error("quota sampling failed", { account: account.label, message: (err as Error).message }, err);
      return targets.map(({ route }) => this.keepStale(account.id, route, (err as Error).message, now));
    }
    // 本轮能力对齐来自额度快照成功拿到的 entitlement 平面；订阅产品身份
    // 是同一轮里的另一份事实，两者都复用这一个采样相位，不新增探测流量。
    this.notePlanEvidence(account, snapshot, origin);
    // 先归一额度，再采订阅产品：额度是 drained 判定与恢复的依据，订阅接口挂了
    // 不能拖住它。两条请求都在本轮串行 tick 内，没有第二个定时器或独立心跳。
    // `derive` 会用本轮额度结果覆盖 samples，所以先在本轮内留下上轮产品身份——
    // 不另建缓存表，失败沿用上次结果的依据就来自这一轮已有的样本（stale 样本）。
    const previousSubscriptions = new Map<string, AccountQuotaSubscription | undefined>();
    for (const { route, plane } of targets) {
      if (plane !== "coding") continue;
      previousSubscriptions.set(sampleKey(account.id, route), this.samples.get(sampleKey(account.id, route))?.quota?.subscription);
    }
    const samples = targets.map(({ route, plane }) => this.derive(account, route, plane, snapshot, now));
    if (!targets.some(({ plane }) => plane === "coding")) return samples;
    const egress = resolveEgressFor(this.config.accounts, account.label);
    let subscription: SubscriptionProbe;
    try {
      subscription = await sampleSubscription(account, {
        config: this.config,
        fetchImpl: this.fetchImpl,
        ...(egress ? { egress } : {}),
      });
    } catch (err) {
      // 采样模块自己吞掉网络异常，这里只兜住意外（注入实现抛错/配置畸形）。
      subscription = { kind: "unknown", reason: `subscription: ${(err as Error).message}` };
    }
    return samples.map((sample) => attachSubscription(this.samples, sample, subscription, previousSubscriptions.get(sampleKey(sample.accountId, sample.route))));
  }

  /** 采样成功 → 按 entitlement 平面派生 planKinds 并落到 broker 的对齐层。*/
  private notePlanEvidence(account: Account, snapshot: QuotaSnapshot, origin: string): void {
    // 两套平面都没答 = 这次没有可信事实（凭据缺口/网络/上游拒绝），保留旧结论。
    if (!snapshot.planes.credits && !snapshot.planes.coding) {
      this.broker.notePlanProbe(account, this.broker.capability.noteProbe(account, undefined), origin);
      return;
    }
    const kinds: AccountPlanKind[] = [];
    if (snapshot.planes.coding) kinds.push("subscription");
    if (snapshot.planes.credits) kinds.push("experience");
    const alignment = this.broker.capability.noteProbe(account, kinds);
    this.broker.notePlanProbe(account, alignment, origin);
  }

  // -------------------------------------------------------------------------
  // 定时
  // -------------------------------------------------------------------------

  /** 到这个账号的错峰相位了没有。首次见到一个账号时只排相位（本轮不采）。*/
  private isDue(account: Account, now: number): boolean {
    if (quotaRoutesOf(account).length === 0) return false;
    const due = this.nextDueAt.get(account.id);
    if (due === undefined) {
      this.nextDueAt.set(account.id, now + this.staggerMs(account.id));
      return false;
    }
    return now >= due;
  }

  /**
   * 这个账号这一轮值不值得采。
   *
   * 健康不是 `ok` 的账号**无条件采**：它已经被候选集排除，不再产生请求活动，
   * 若按"空闲跳过"处理就再也发现不了额度恢复（`drained` 且没有 `nextResetTime`
   * 的账号会永久卡死）。
   */
  private shouldSample(account: Account): boolean {
    for (const route of account.routes) {
      if (this.health.status(account.id, route).status !== "ok") return true;
    }
    return this.activity.isActive(account.id, this.idleWindowMs());
  }

  /** 错峰相位：账号 id 的 sha256 落在 `[0, period)` 内（确定性）。*/
  private staggerMs(accountId: string): number {
    const periodMs = this.periodMs();
    const digest = createHash("sha256").update(accountId, "utf-8").digest();
    return digest.readUInt32BE(0) % periodMs;
  }

  /** 本轮结束后到下一轮的间隔：周期 ± 抖动。*/
  private roundDelayMs(): number {
    const periodMs = this.periodMs();
    const span = periodMs * JITTER_RATIO;
    const jitter = Math.round((this.random() * 2 - 1) * span);
    // 抖动可以略略超过一个 tick 的下限：取 `DUE_TICK_MS` 作为地板，避免周期被配置成
    // 0 秒时退化成一个忙循环。
    return Math.max(DUE_TICK_MS, periodMs + jitter);
  }

  private periodMs(): number {
    return this.quota.pollSeconds * MS_PER_SECOND;
  }

  private idleWindowMs(): number {
    return this.periodMs() * IDLE_POLL_MULTIPLE;
  }

  // -------------------------------------------------------------------------
  // 归一 / 判定
  // -------------------------------------------------------------------------

  /** 把一次快照归一到一条路由：这套平面这次没数据就保留上次结果。*/
  private derive(
    account: Account,
    route: RouteKind,
    plane: QuotaPlane,
    snapshot: QuotaSnapshot,
    now: number,
  ): QuotaSample {
    const quota = planeQuota(plane, snapshot, now);
    if (quota === undefined) {
      return this.keepStale(account.id, route, snapshot.errors.join("; "), now);
    }
    const decision = evaluateDrain(quota, this.quota.drainThreshold);
    this.applyHealth(account.id, route, decision);
    const sample: QuotaSample = { accountId: account.id, route, quota, sampledAt: now, stale: false };
    this.samples.set(sampleKey(account.id, route), sample);
    return sample;
  }

  /**
   * 采样失败：保留上一次的 `quota` 与 `sampledAt`，只把 `stale` 立起来。
   *
   * 不清空是有意的：额度是**慢变量**，上游挂一分钟不代表账号真的没额度了；清空等于
   * 让一个暂时读不到额度的账号重新进候选集，正好撞在"额度早就用完"上。
   */
  private keepStale(accountId: string, route: RouteKind, error: string, now: number): QuotaSample {
    const previous = this.samples.get(sampleKey(accountId, route));
    const sample: QuotaSample = {
      accountId,
      route,
      quota: previous ? previous.quota : null,
      sampledAt: previous ? previous.sampledAt : now,
      stale: true,
      error,
    };
    this.samples.set(sampleKey(accountId, route), sample);
    return sample;
  }

  /**
   * 判定结果落到健康表。
   *
   * 两个方向都要动：耗尽 → `markDrained(until = nextResetTime)`；恢复 → `markOk`。
   * 恢复方向容易漏：`markDrained` 之后这个 `(account, route)` 就不在候选集里了，
   * 没有任何请求会再触发一次判定，只有采样能把它放回去。
   */
  private applyHealth(accountId: string, route: RouteKind, decision: DrainDecision): void {
    if (decision.drained) {
      this.health.markDrained(accountId, route, decision.until);
      return;
    }
    if (this.health.status(accountId, route).status === "drained") {
      this.health.markOk(accountId, route);
      return;
    }
    const state = this.health.status(accountId, route);
    // 恢复缺口：429 无 Retry-After / 复采前的 cooling 是**无 until**
    // 的（「等采样确认」，与 drained 无 until 时纯靠采样发现恢复是同一套语义）。
    // 采样没判出耗尽就是「额度还在」，有权把这类 cooling 放回 ok；有 until 的
    // cooling 是上游给的权威窗口，交给本地时钟，采样不许提前抹掉。
    if (state.status === "cooling" && state.until === undefined) {
      this.health.markOk(accountId, route);
    }
  }
}

/**
 * 一条路由的额度过期时刻。
 *
 * 平面按路由查（`quotaPlane`），不看数据形状：credits 平面读余额桶的 `expiresAt`，
 * coding 平面取窗口里最早的重置时刻（窗口重置即这一轮的额度作废）。
 */
function expiryOf(quota: RouteQuota, route: RouteKind): number | undefined {
  if (quotaPlane(route) === "credits") return quota.credits?.expiresAt;
  let expiresAt: number | undefined;
  for (const window of quota.windows) expiresAt = earliest(expiresAt, toEpochMs(window.nextResetTime));
  return expiresAt;
}

/**
 * 订阅产品挂到本轮 coding 样本上（credits 样本不带这段）。
 *
 * `known` 直接覆盖上次产品；`unknown` 保留 `samples` 里上一次成功的产品与全部
 * 窗口数据（临时故障沿用上次结果，与额度采样的 stale 纪律一致），只把本次失败原因写进样本
 * `error`。产品身份也是慢变量，一次 502 不代表订阅没了；额度采样本身成功时不
 * 额外立 `stale`（它描述的是额度数据的新鲜度），窗口与产品各自按自己的结果走。
 * 首次采样就失败则连产品也没有：展示层退回「用量窗口」描述词，窗口照常显示。
 */
function attachSubscription(
  samples: Map<string, QuotaSample>,
  sample: QuotaSample,
  probe: SubscriptionProbe,
  previousSubscription: AccountQuotaSubscription | undefined,
): QuotaSample {
  if (quotaPlane(sample.route) !== "coding") return sample;
  const previous = samples.get(sampleKey(sample.accountId, sample.route));
  const next: QuotaSample = sample;
  if (probe.kind === "known") {
    const subscription = probe.subscription;
    if (next.quota) next.quota = { ...next.quota, subscription };
    else if (previousSubscription) {
      // 额度平面本次没答（stale），但订阅产品答了：产品身份与窗口各按自己的
      // 采样结果走，窗口仍是上次那份（不因这一次失败清空）。
      next.quota = { windows: previous?.quota?.windows ?? [], subscription };
    }
  } else {
    // `derive` 写进 samples 的是一份全新 RouteQuota，不带上次订阅；失败时把上一次
    // 产品身份挂回本轮窗口（额度仍用本轮数据），避免一次 502 把产品名抹掉。
    if (previousSubscription && next.quota) {
      next.quota = { ...next.quota, subscription: previousSubscription };
    }
    // 订阅失败只诚实标记，不动窗口数据、不动 sampledAt（额度采样本身是成功的）。
    next.error = [next.error, probe.reason].filter(Boolean).join("; ");
  }
  samples.set(sampleKey(sample.accountId, sample.route), next);
  return next;
}

/** 采样结果/相位表的键（`\u0000` 分隔，与 `health.ts::routeStateKey` 同构）。*/
function sampleKey(accountId: string, route: RouteKind): string {
  return `${accountId}\u0000${route}`;
}

/** 该账号要采的路由：没有额度平面的路由不在其列。*/
function quotaRoutesOf(account: Account): Array<{ route: RouteKind; plane: QuotaPlane }> {
  const targets: Array<{ route: RouteKind; plane: QuotaPlane }> = [];
  for (const route of account.routes) {
    const plane = quotaPlane(route);
    if (plane !== undefined) targets.push({ route, plane });
  }
  return targets;
}

/**
 * 一套平面 → 一条路由的额度状态；`undefined` = 这套平面这次没取到数据。
 *
 * - credits：采集层没有可空载荷（`balances[]` 空数组与"没取到"是两件事），所以看
 *   {@link QuotaSnapshot.planes} 这个显式位；
 * - coding：`codingPlan` 本身就是可空的（失败即 `null`），再叠上 `planes.coding`
 *   这位就能把"平面有没有数据"与"数据长什么样"一次收窄，不必断言非空。
 */
function planeQuota(plane: QuotaPlane, snapshot: QuotaSnapshot, now: number): RouteQuota | undefined {
  if (plane === "credits") {
    if (!snapshot.planes.credits) return undefined;
    // 平面取到了数据就把 bucket 明细、套餐实例与可领活动一并搬出，没有
    // 也是空数组：「平面答了、桶是空的」与「平面没答」是两件事，前者不该缺省成
    // undefined。
    return {
      windows: [],
      ...creditsOf(snapshot.balances, now),
      balances: balancesOf(snapshot.balances),
      plans: planInstancesOf(snapshot.plans),
      campaigns: campaignsOf(snapshot.claimablePlans, snapshot.plans, now),
    };
  }
  const plan = snapshot.planes.coding ? snapshot.codingPlan : null;
  if (plan === null) return undefined;
  return { windows: plan.limits.map(toWindow) };
}

/**
 * credits 平面合计。
 *
 * 求和口径与官方 `buildZaiStartPlanRemaining` 一致：**全部桶求和**，不区分授予
 * 来源与重置周期（period 只管「怎么刷新」，不分类套餐——「还剩多少额度」不区分
 * 授予来源，区分是展示层的事）。耗尽判定只看「`remainingUnits <= 0`」，所以按 bucket 求和后再判：
 * 只要还有一个 bucket 有余量，这个账号就没耗尽。
 *
 * 唯一的例外是**过期桶**：`expires_at` 已过的桶整桶退出合计（`remainingUnits` 与
 * `totalUnits` 都不计）——过期桶不得虚增可用额度。官方在
 * `normalizeStartPlanExpiry` 里把过期套餐名下的桶从 `balances[]` 里直接滤掉，是
 * 同一条原则在 fetch 层的强表述；我们的桶保留在明细里（控制面要显示「已过期」
 * 标签），只在合计口径里剔除。桶列表（`QuotaSnapshot.balances`）是原始清单，
 * 这里的 `credits` 是可用量口径，两者故意不同。
 */
function creditsOf(balances: QuotaSnapshot["balances"], now: number): { credits?: QuotaCredits } {
  if (balances.length === 0) return {};
  let remainingUnits = 0;
  let totalUnits = 0;
  let expiresAt: number | undefined;
  for (const balance of balances) {
    const expiry = toEpochMs(balance.expiresAt);
    if (expiry !== undefined && expiry <= now) continue;
    remainingUnits += balance.remainingUnits;
    totalUnits += balance.totalUnits;
    // 过期时间只关心“还没烧完的额度什么时候作废”，所以只收还有余量的
    // bucket。
    if (balance.remainingUnits > 0) expiresAt = earliest(expiresAt, expiry);
  }
  return { credits: { remainingUnits, totalUnits, ...(expiresAt !== undefined ? { expiresAt } : {}) } };
}

/**
 * credits 平面的 bucket 明细（`AccountQuotaBalance`）。
 *
 * 归属/周期字段（bucketId/planId/userPlanId/entitlementId/period/meter/capabilities）
 * 原样透传（采集层已反查好 period）；时间字段（expiresAt/periodStart/periodEnd）
 * 上游两种刻度都发过（与 {@link toEpochMs} 同一套判别），换算成毫秒；
 * `availableUnits`/`reservedUnits` 语义完整透传（展示「剩余」仍只用 remainingUnits）；
 * `claimedAt` 采样数据里没有，恒缺省（不为了它去改 claim）。
 */
function balancesOf(balances: QuotaSnapshot["balances"]): AccountQuotaBalance[] {
  return balances.map((balance) => {
    const expiresAt = toEpochMs(balance.expiresAt);
    const periodStart = toEpochMs(balance.periodStart);
    const periodEnd = toEpochMs(balance.periodEnd);
    return {
      name: balance.showName,
      ...(balance.bucketId !== undefined ? { bucketId: balance.bucketId } : {}),
      ...(balance.planId !== undefined ? { planId: balance.planId } : {}),
      ...(balance.userPlanId !== undefined ? { userPlanId: balance.userPlanId } : {}),
      ...(balance.entitlementId !== undefined ? { entitlementId: balance.entitlementId } : {}),
      ...(balance.period !== undefined ? { period: balance.period } : {}),
      remainingUnits: balance.remainingUnits,
      totalUnits: balance.totalUnits,
      ...(balance.availableUnits !== undefined ? { availableUnits: balance.availableUnits } : {}),
      ...(balance.reservedUnits !== undefined ? { reservedUnits: balance.reservedUnits } : {}),
      ...(balance.meter !== undefined ? { meter: balance.meter } : {}),
      ...(balance.unitType !== undefined ? { unitType: balance.unitType } : {}),
      ...(balance.capabilities !== undefined ? { capabilities: balance.capabilities } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(periodStart !== undefined ? { periodStart } : {}),
      ...(periodEnd !== undefined ? { periodEnd } : {}),
    };
  });
}

/**
 * balance 载荷的套餐实例 → `AccountQuotaPlan`（套餐卡数据源）。
 *
 * 时间字段与桶同一批判别（秒/毫秒 → 毫秒）；`status` 原值透传（不收窄成枚举，
 * 契约文档不在客户端仓，未知取值按「不猜」处理）。
 */
function planInstancesOf(plans: QuotaSnapshot["plans"]): AccountQuotaPlan[] {
  return plans.map((plan) => {
    const startsAt = toEpochMs(plan.startsAt);
    const endsAt = toEpochMs(plan.endsAt);
    return {
      planId: plan.planId,
      ...(plan.userPlanId !== undefined ? { userPlanId: plan.userPlanId } : {}),
      name: plan.name,
      ...(plan.status !== undefined ? { status: plan.status } : {}),
      ...(startsAt !== undefined ? { startsAt } : {}),
      ...(endsAt !== undefined ? { endsAt } : {}),
      entitlements: plan.entitlements.map((entitlement) => {
        const effectiveAt = toEpochMs(entitlement.effectiveAt);
        return {
          ...(entitlement.entitlementId !== undefined ? { entitlementId: entitlement.entitlementId } : {}),
          showName: entitlement.showName,
          ...(entitlement.period !== undefined ? { period: entitlement.period } : {}),
          ...(effectiveAt !== undefined ? { effectiveAt } : {}),
        };
      }),
    };
  });
}

/**
 * billing preview 的可领套餐 → `AccountQuotaCampaign`。
 *
 * 状态判定是纯数据推导：`ends_at` 已过 → expired；`planId` 命中某个**套餐实例**
 * （balance 载荷的 `plans[]`）→ 已领（比对要走 planId 精确匹配，早先
 * 「套餐名撞余额桶 showName」在真实数据上永远撞不上——桶名是模型名）；其余 →
 * claimable。fail-open：比不上就当可领，活动段的时间标签仍然自洽。
 */
function campaignsOf(
  campaigns: QuotaSnapshot["claimablePlans"],
  instances: QuotaSnapshot["plans"],
  now: number,
): AccountQuotaCampaign[] {
  const heldPlanIds = new Set(instances.map((instance) => instance.planId));
  return campaigns.map((campaign) => {
    const startsAt = toEpochMs(campaign.startsAt);
    const endsAt = toEpochMs(campaign.endsAt);
    let status: AccountQuotaCampaign["status"] = "claimable";
    if (endsAt !== undefined && endsAt <= now) status = "expired";
    else if (heldPlanIds.has(campaign.planId)) status = "claimed";
    return {
      planId: campaign.planId,
      name: campaign.name,
      ...(campaign.description !== undefined ? { description: campaign.description } : {}),
      ...(startsAt !== undefined ? { startsAt } : {}),
      ...(endsAt !== undefined ? { endsAt } : {}),
      status,
      entitlements: campaign.entitlements.map((entitlement) => ({
        ...(entitlement.entitlementId !== undefined ? { entitlementId: entitlement.entitlementId } : {}),
        showName: entitlement.showName,
        grantUnits: entitlement.grantUnits,
        unitType: entitlement.unitType,
        ...(toEpochMs(entitlement.effectiveAt) !== undefined
          ? { effectiveAt: toEpochMs(entitlement.effectiveAt) }
          : {}),
        ...(entitlement.period !== undefined ? { period: entitlement.period } : {}),
      })),
      source: "preview" as const,
    };
  });
}

/**
 * coding 平面的一条窗口 → `QuotaWindow`（判定与面板展示要用的字段）。
 *
 * 搬两类事实：**用量**（usage/remaining/percentage，判定与「已用/总量」用）与
 * **周期身份**（unit/number，回答「这是哪个窗」）。身份不参与判定，但早先曾被
 * 判定层主动剔掉，结果是展示层只能看到 `type`，官方 UI 的四格（5 小时 / 每周 /
 * 工具调用 / ZCode MCP）在控制面完全不可区分——官方按
 * `findCodingPlanQuotaLimit(type, unit, number)` 查窗，我们平铺窗口行让消费方自己查。
 * 两个字段原样透传，不当总量（早先的 `total` 就是把它当总量才出的错）。
 * `nextResetTime` 在这里归一到毫秒：上游两种刻度都发过（`EPOCH_MILLISECONDS_THRESHOLD`
 * 同一套判别），而展示层拿它直接减 `Date.now()`（面板的重置倒计时）——秒刻度
 * 直传会把倒计时算成负数，显示成 0s。判定侧 {@link evaluateDrain} 与过期时刻
 * {@link expiryOf} 本来就各自过一遍 {@link toEpochMs}，归一后重复调用是幂等的。
 */
function toWindow(limit: NonNullable<QuotaSnapshot["codingPlan"]>["limits"][number]): QuotaWindow {
  const nextResetTime = toEpochMs(limit.nextResetTime);
  return {
    type: limit.type,
    // 窗口周期身份（unit/number）原样透传：它们回答「这是哪个窗」（5 小时 / 每周 /
    // 每月工具调用），面板靠它区分官方 UI 的四格。**不参与判定**，也不当总量——
    // 官方按 `findCodingPlanQuotaLimit(type, unit, number)` 查窗，我们平铺窗口行让
    // 展示层自己查（早先只透传 type，四格全塌成「Token 窗口」）。
    ...(limit.unit !== undefined ? { unit: limit.unit } : {}),
    ...(limit.number !== undefined ? { number: limit.number } : {}),
    ...(limit.usage !== undefined ? { usage: limit.usage } : {}),
    ...(limit.remaining !== undefined ? { remaining: limit.remaining } : {}),
    ...(limit.percentage !== undefined ? { percentage: limit.percentage } : {}),
    ...(nextResetTime !== undefined ? { nextResetTime } : {}),
  };
}

/**
 * drained 判定（四条条件，逐条对应下面四个 if/循环分支）。
 *
 * 1. 窗口已用比例达到阈值（口径见 {@link usedFraction}：`percentage` 优先，
 *    `usage/(usage+remaining)` 兜底；默认阈值 100%）。**对所有 type 一体适用**——
 *    TOKENS_LIMIT / CREDIT_LIMIT（两者官方等价）/ TIME_LIMIT / 未知 type 都套同一张
 *    平面契约，不做 type 白名单（官方展示端 `getQuotaRemainingPercentage` 同样对
 *    任意 limit 生效）；
 * 2. 窗口 `remaining <= 0`；
 * 3. credits `remainingUnits <= 0`——求和口径见 {@link creditsOf}：全部桶求和
 *    （跨 daily / one_time，照官方 `buildZaiStartPlanRemaining`），过期桶剔除；
 * 4. 上游额度耗尽错误码：不在采样里判，见 `quota-rules.ts` +
 *    `proxy/upstream-error.ts::observeUpstream`（统一观测点 → `broker.noteUpstreamSignal`）
 *    （采样拿不到"某个请求被上游拒了"这件事）。
 *
 * `until` 取命中窗口的 `nextResetTime`（最早的那个）。没有就留空：`markDrained`
 * 的语义是"一直 drained，直到采样发现恢复"（`health.ts::markDrained`）。
 */
export function evaluateDrain(quota: RouteQuota, drainThreshold: number): DrainDecision {
  const reasons: string[] = [];
  let until: number | undefined;

  for (const window of quota.windows) {
    const fractional = usedFraction(window);
    if (fractional !== undefined && fractional >= drainThreshold) {
      reasons.push(`${window.type} window at ${(fractional * PERCENT_SCALE).toFixed(1)}%`);
      until = earliest(until, toEpochMs(window.nextResetTime));
      continue;
    }
    if (window.remaining !== undefined && window.remaining <= 0) {
      reasons.push(`${window.type} window has no remaining units`);
      until = earliest(until, toEpochMs(window.nextResetTime));
    }
  }

  if (quota.credits !== undefined && quota.credits.remainingUnits <= 0) {
    reasons.push("credits have no remaining units");
  }

  return { drained: reasons.length > 0, ...(until !== undefined ? { until } : {}), reasons };
}

/**
 * 窗口已用比例（0..1）。只用于 coding 窗口；credits 走 {@link creditsOf} 的
 * remainingUnits 求和口径，不走这里。
 *
 * 口径与官方展示端同一套事实、**同一字段**：官方额度卡与侧边栏剩余用量都是
 * `100 - percentage`，所以判定也用 `percentage`，两边不可能给出相反的结论。
 *
 * 1. **`percentage`**（上游算好的已用占比）。归一照 {@link PERCENT_SCALE} 的契约直接
 *    除以 100，**不再用 `> 1` 猜刻度**（误判的根因：`percentage: 1` = 1% 已用，
 *    旧实现读成 100% 已用 → drained）。刻度歧义在值 1 上不可区分，取舍看代价
 *    不对称——误判把还能用的账号踢出候选集（本次事故），漏判只是晚一轮采样才
 *    降级（同 `quota-rules.ts` 的 `isQuotaExhaustedCode` 原则）；而契约与实弹都指向
 *    百分数，所以按百分数读。
 * 2. **usage/(usage+remaining)**：`percentage` 缺位时的兜底（窗口没有
 *    上游总量字段时，总量由 usage+remaining 反推）。两字段必须同时在场——`remaining`
 *    缺失不等于 0，只看 usage 就判满会把「上游没报剩余」误判成耗尽；分母 0 时回退
 *    {@link undefined}（`remaining = 0` 自有判定第 2 条兜底）。
 *    口径唯一的已知偏差：`TIME_LIMIT` 窗的 `usage` 是**总量上限**而不是已用量
 *    （实弹：usage=1000 / currentValue=28 / remaining=972 / percentage=2；已用数在
 *    `currentValue`，采集层不搬它），所以这条兜底对工具窗会高估占比。只影响
 *    「上游偏偏不给 percentage」的形态，而现实中三条窗口都带 percentage（判定第 1 条接手）。
 * 3. 都没有 → `undefined`（判不出，不猜）。
 *
 * 旧的 `used/total` 路径已彻底删除：`total` 曾把上游 `number`（窗口周期身份）误标
 * 成 token 总量，4.28亿/5 相除恒 ≥ 1，导致额度充足却判耗尽。
 */
function usedFraction(window: QuotaWindow): number | undefined {
  const percentage = window.percentage;
  if (percentage !== undefined) {
    // 百分数刻度归一成 0..1 比例；越界值夹紧（上游只发 0..100，夹紧是防御）。
    return Math.max(0, Math.min(1, percentage / PERCENT_SCALE));
  }
  if (window.usage !== undefined && window.remaining !== undefined) {
    const total = window.usage + window.remaining;
    if (total > 0) return window.usage / total;
  }
  return undefined;
}

/** 上游 `nextResetTime` 统一成 Unix ms（上游两种刻度都发过，见常量注释）。*/
function toEpochMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return value < EPOCH_MILLISECONDS_THRESHOLD ? value * MS_PER_SECOND : value;
}

/** 取较早的时间点。*/
function earliest(current: number | undefined, candidate: number | undefined): number | undefined {
  if (candidate === undefined) return current;
  if (current === undefined || candidate < current) return candidate;
  return current;
}

/**
 * 按配置造一个采样器。生产入口只用这一处，采样参数 / 时钟 / 活跃表 / 健康表
 * 全部从 `config` 与 `broker` 里取；让每个调用点自己拼，迟早出现"采样写进一个
 * 调度器看不见的健康表副本"。
 *
 * `broker` 只做 `import type`（见文件头注释：采样模块不能进 broker 的运行时依赖图），
 * 这里读的 `health` / `activity` 都是它的公开字段（broker 是它们唯一的写入方）。
 */
export function createQuotaSampler(
  config: ProxyConfig,
  accounts: AccountManager,
  broker: Broker,
  options: { fetchImpl?: typeof fetch; now?: () => number; random?: () => number } = {},
): QuotaSampler {
  return new QuotaSampler({
    config,
    accounts,
    broker,
    health: broker.health,
    activity: broker.activity,
    // `accounts` 段本身可缺省（只导入账号不写策略也能跑），缺省即按默认值采。
    ...(config.accounts ? { quota: config.accounts.quota } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.random ? { random: options.random } : {}),
  });
}
