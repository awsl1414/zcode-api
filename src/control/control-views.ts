/**
 * 控制面的展示形态（面板 / CLI 读的那些结构）。
 *
 * 与 `control-types.ts` 的分界：那个文件是**命令契约**（客户端发什么、dispatcher 回
 * 什么包络），这里是**读模型**（账号表一行、额度窗口、风控报告、代理表一行、登录
 * 状态）。聚合层（`control-report.ts`）负责把调度器的瞬时状态算成这些形状，页面只
 * 渲染不计算。
 *
 * 依赖方向：`control-types.ts` → 本文件，本文件不 import 命令侧（也就不会有类型层
 * 的循环）。
 */
import type {
  CredentialKind,
  HealthReason,
  HealthStatus,
  ProviderFamily,
  RouteKind,
} from "../accounts/types.js";
// 套餐的几段结构（余额桶 / 套餐实例 / 可领活动）在采样层归一（accounts/quota.ts 是生产方），这里只复用形状。
// type-only import：读模型不得把采样模块拉进运行时依赖图。
import type { AccountQuotaBalance, AccountQuotaCampaign, AccountQuotaPlan, AccountQuotaSubscription } from "../accounts/quota.js";
import type { OAuthFlowClient } from "../auth/oauth.js";

/**
 * `listAccounts` 的单行摘要（面板账号页表格的一行）。
 *
 * 没有「哪个是默认账号」这一列：出线账号由调度器按请求决定。
 */
export interface AccountSummary {
  /** 凭据指纹前 `ACCOUNT_ID_PREFIX_CHARS` 位（展示用，永不用于查找）。*/
  idPrefix: string;
  label: string;
  kind: CredentialKind;
  provider: ProviderFamily;
  routes: RouteKind[];
  /** 生效值（运行时覆盖 > entries > 账号 policy），不是账号自身的默认值。*/
  enabled: boolean;
  weight: number;
  maxConcurrency: number;
  /** 路由级健康的聚合：任一 `drained` → `drained`，任一 `cooling` → `cooling`。*/
  health: HealthStatus;
  /** 逐路由明细：状态键是 `(account, route)`，不是账号。*/
  routeHealth: RouteHealthSummary[];
  /** 全账号在飞合计（各路由 `inflight` 之和）。*/
  inflight: number;
  /** 能力对齐结果：配置里写了但运行时被遮蔽的路由（账号实际没有对应套餐）。*/
  capabilityBlocks: CapabilityBlock[];
  /** 额度摘要；没有采样结果时为 `null`（不是"零额度"）。*/
  quota: AccountQuotaSummary | null;
  /**
   * 账号级套餐类型（`subscription` 订阅编码套餐 / `experience` 体验套餐）。
   *
   * 派生字段（从 `routes` 的平面归属推导，无新数据源，不读 period）：
   * UI 靠它在账号行 / 抽屉上打「订阅」「体验」标签，不必自己按路由名拼。
   * 固定顺序 `["subscription", "experience"]` 取并集，无数据时为空数组。
   */
  planKinds: AccountPlanKind[];
  /**
   * 凭据里有没有 apiKey 对。
   *
   * 页面靠它解释「为什么这个账号只能跑 start-plan」：JWT-only 账号的
   * `apiKey` 是空串，四条路由里只有 start-plan 不要求 apiKey 对。没有这个字段，
   * 界面只能显示 `routes: ["start-plan"]`，用户会以为是配置问题。
   * 只回答有没有，不搬凭据原文。
   */
  hasApiKey: boolean;
  /** 上游 RPM 闸；未配置时不出现该字段。*/
  rpmLimit?: number;
  /**
   * 该账号的 `X-Device-Mid` 指纹前若干位（一账号一指纹）。
   * `api-key` 凭据没有身份面（R6），所以这个字段对它是缺省的。
   */
  deviceMid?: string;
  /**
   * 生效的出口代理名（优先级链：`export override` > `entries[].proxy` >
   * `risk.defaultProxy` > 直连）。`direct` 表示直连，从不缺省。
   *
   * 回显**名字**而不是 URL：概览按它分组算「N 个账号共用同一出口」，账号页的代理
   * 下拉也用它回填。同一出口被多账号共用时，名字才是「一组」的标识。
   */
  proxy: string;
}

/**
 * 账号级套餐类型：订阅编码套餐 vs 体验套餐。
 *
 * 判据只有一条：**路由 → 平面**（`quota-rules.ts::quotaPlane`）。coding 平面
 * （`coding-plan` 及派生入口 `off-peak` / `highspeed`，订阅接口确认的权益）→
 * 订阅；credits 平面（`start-plan` 的 billing/balance，恒属体验体系）→ 体验。
 * 二分在数据面，官方从不用桶上的 `period` 字段判（`period` 只是
 * entitlement 的授予/重置周期，daily ≠ 订阅）。
 *
 * 一个账号可以两类都有（路由白名单两条平面各占一条），所以是**集合**而不是
 * 单选。这是纯派生字段：没有新数据源，值全部来自路由。
 */
export type AccountPlanKind = "subscription" | "experience";

/** 单条 `(account, route)` 的健康明细。*/
export interface RouteHealthSummary {
  route: RouteKind;
  status: HealthStatus;
  until?: number;
  reason?: HealthReason;
}

/**
 * 被能力对齐屏蔽的一条路由。
 *
 * `reason` 是稳定码，页面按 `error.*` 键翻译：配置里写了 `coding-plan` 但账号实际
 * 只有体验套餐 → `no-subscription`；两套权益都没探测到 → `no-plan`。
 */
export interface CapabilityBlock {
  route: RouteKind;
  reason: "no-subscription" | "no-experience" | "no-plan";
}

/** 额度摘要（coding 平面看窗口，start-plan 看 credits；另加余额桶 / 套餐实例 / 可领活动三段）。*/
export interface AccountQuotaSummary {
  /** 本次采样失败、沿用上次结果（stale 语义）。*/
  stale: boolean;
  /**
   * 这份额度数据的采样时刻（Unix ms，数据龄标注用它）。
   *
   * stale 时保留上一次的时刻——「这份数据是什么时候采到的」正是数据龄要回答的，
   * 面板据此显示「上次采样 X 分钟前」。
   */
  sampledAt: number;
  /**
   * 采样周期（秒，`accounts.quota.pollSeconds`）：「超过一个采样周期」的
   * 判定阈值。它是配置值，面板猜不得。
   */
  pollSeconds: number;
  windows: AccountQuotaWindow[];
  credits?: { remainingUnits: number; totalUnits: number; expiresAt?: number };
  /**
   * 余额桶，credits 平面按 bucket 展开。
   *
   * 空数组不缺省：消费方靠「有段没数据」区分「平面答了、桶是空」与「还没采过」
   * （后者整份 `quota` 是 `null`）。数据由采样层（`accounts/quota.ts`）归一。
   */
  balances: AccountQuotaBalance[];
  /**
   * 套餐实例（balance 载荷的 `plans[]`，三层结构的实例层）：套餐卡按
   * `plan_id` 分组、卡片名取 `name`、状态词由 `status` + `endsAt` +
   * `entitlements[].effectiveAt` 投影。空数组同上。
   */
  plans: AccountQuotaPlan[];
  /** 可领 / 活动中的套餐（billing preview + marketing banner）；空数组同上。*/
  campaigns: AccountQuotaCampaign[];
  /**
   * Coding Plan 订阅产品身份（与 windows[] / balances[] / plans[] 并列）。
   *
   * 官方个人 `subscription/list` / 团队 `querySubscribeDetail` 的当前期归一结果，
   * 由采样层（`accounts/subscription.ts`）在同一轮额度采样里产出，复用本摘要的
   * `sampledAt` / `stale`。字段缺省 = 没采到产品身份（unknown / 账号不服务 coding
   * 平面），**不是**「没有订阅」；窗口数据照旧可用，面板退回「用量窗口」描述词。
   * 字段是加法：没读它的消费者不受影响。
   */
  subscription?: AccountQuotaSubscription;
}

/**
 * 额度窗口摘要（只搬控制面展示用得上的字段）。
 *
 * `nextResetTime` 是上游 `QuotaWindow.nextResetTime` 的原样搬运：账号页展开行要显示
 * 「重置倒计时」，没有它这一栏就只能空着。`usage` / `remaining`
 * 是窗口行的「4.28亿 / 5亿」两列——总量没有上游字段，页面由 usage+remaining 反推
 * （官方同口径），两者都到场才画那一行。
 */
export interface AccountQuotaWindow {
  type: string;
  /**
   * 上游 `unit`：窗口周期身份，缺省 = 上游没给。
   *
   * `unit` + `number` 一起回答「这是哪个窗」：unit=3 & number=5 → 5 小时窗、unit=6 →
   * 每周窗、unit=5 & number=1 → 每月工具调用——官方四格（5 小时 / 每周 / 工具调用 /
   * ZCode MCP）全靠它区分，缺了就只剩 `type`，5 小时与每周两行同名。查法同官方
   * `findCodingPlanQuotaLimit(type, unit, number)`；不参与判定，也不当总量（把它当
   * 总量正是 `number` 被误读的来源）。
   */
  unit?: number;
  /** 上游 `number`：窗口周期身份的计数（5 小时窗 = 5、每月工具窗 = 1、每周 = 1）。*/
  number?: number;
  usage?: number;
  remaining?: number;
  percentage?: number;
  /** 窗口重置时刻（毫秒时间戳）；上游没给时缺省。*/
  nextResetTime?: number;
}

/**
 * 风控可见性报告（控制面必须能回答的六问，逐条对应下面的字段）。
 *
 * `alerts` 是**稳定码**而不是人话：面板与 CLI 各自按同一份翻译表翻译，后端不
 * 拼句子（与错误码同一条规矩）。
 */
export interface RiskReport {
  /**
   * R1：一账号一 deviceMid，账号间绝不共用。
   *
   * 只查**冲突**：deviceMid 在类型上必填，每个账号建号时都拿到自己的一个，
   * 所以「没有指纹」在结构上不可能出现。但账号文件是外部输入（手改、导入导出包），
   * 两个账号撞同一个指纹仍可能发生，所以冲突列表保留。
   */
  deviceMid: {
    /** 参与检查的账号数（`api-key` 账号不带身份面，R6）。*/
    accounts: number;
    /** 冲突：同一 `deviceMid` 被多个账号使用。*/
    conflicts: { deviceMid: string; labels: string[] }[];
  };
  /** R2：一账号一 session 命名空间。*/
  sessions: {
    /** 当前绑定条数（`sessionId → account`）。*/
    bound: number;
    /** 粘性表容量上限（`stickiness.maxSessions`）。*/
    capacity: number;
    /**
     * 跨账号 session 数（必须为 0）。
     *
     * 本进程的血缘表按 `(accountId, 血缘哈希)` 建键、生成的 sessionId 也带账号种子
     * （`proxy/client-session.ts`），同一个 sessionId 不会被两个账号复用，所以该字段
     * 恒为 0。它一旦非 0 就是血缘表或粘性表被打穿的告警，不是装饰性字段。
     *
     * 两个边界得说清楚，否则「恒为 0」会被读成「跨账号不可能发生」：
     *
     * - `explicit` 来源的 sessionId 是客户端自己给的，根本不进血缘表，也挡不住
     *   客户端自己串号；
     * - 粘性表只管 `sessionId → account` 的绑定，它自己并不保证 sessionId 唯一。
     *   隔离成立是因为生成 sessionId 时把 accountId 混进了种子。
     */
    crossAccount: number;
  };
  /** R16：全局并发与队列深度。*/
  inflight: {
    total: number;
    limit: number;
    queueDepth: number;
    perAccount: { label: string; inflight: number }[];
  };
  /** 每个账号最近失败原因与冷却状态。*/
  failures: { label: string; route: RouteKind; status: HealthStatus; reason?: HealthReason; until?: number }[];
  alerts: RiskAlert[];
}

/** 风控告警码（面板概览页的「风控告警横幅」）。*/
export type RiskAlert =
  | "device_mid_shared"
  | "session_cross_account"
  | "account_cooling"
  | "account_drained"
  | "concurrency_above_r11";

/**
 * 代理表的一行（账号页代理抽屉与代理下拉）。
 *
 * **密码永不回显**：`url` 里的 userinfo 先被打码，`password` 本身只通过
 * `hasPassword` 回答「有没有」，因为面板不需要旧密码也能保存新密码（不传这个字段
 * 就是保留原值，空串是清掉）。
 */
export interface ProxySummary {
  name: string;
  /** 被打码的地址：`http://user:***@host:port`；没有 userinfo 时就是原样。*/
  url: string;
  hasPassword: boolean;
  enabled: boolean;
  /** 生效出口指向它的账号数（含继承 `risk.defaultProxy` 与运行时覆盖）。*/
  usedBy: number;
}

/** `exportAccounts` 的掩码清单行（审计/核对用）。*/
export interface MaskedAccount {  label: string;
  kind: CredentialKind;
  provider: ProviderFamily;
  routes: RouteKind[];
  /** 凭据指纹前缀（与 `Account.id` 同源，永不回显原文）。*/
  idPrefix: string;
}

export interface ControlState {
  /** Currently-bound proxy server port. 0 only in the construction window before `startServer`. */
  proxyPort: number;
  /** Active OAuth client while a flow is in flight; nulled on completion. */
  activeOauth?: {
    client: OAuthFlowClient;
    callbackUrl: string;
    state: string;
  };
  /**
   * 最近一次 OAuth 流程的状态。流程结束后**不立即清空**（登录模态要轮询到结果），
   * 保留多久见 {@link OAUTH_STATUS_TTL_MS}。
   */
  oauthStatus?: OAuthStatus;
}

/**
 * 最近一次 OAuth 流程的状态（`GET /api/oauth-status` 的数据源）。
 *
 * 与 `activeOauth` 分开：那个是在飞的客户端句柄，流程一结束就关掉；这一个要在结束
 * 后继续留一会儿，否则页面轮询到「成功」的那一次可能刚好错过，那就永远显示「等待中」。
 *
 * 三个相位都带 `flowId`（本次流程 id，= `started.state`）、`startedAt`（开始时刻，
 * 页面显示等待时长用）与 `updatedAt`（相位最后一次变更的时刻，TTL 的锚点）。
 */
export type OAuthStatus =
  | { flowId: string; phase: "pending"; startedAt: number; updatedAt: number }
  | { flowId: string; phase: "ready"; accountLabel: string; startedAt: number; updatedAt: number }
  | { flowId: string; phase: "failed"; error: string; startedAt: number; updatedAt: number };

/**
 * 流程状态在内存里保留的时长。
 *
 * 锚点必须是最后一次相位变更（`updatedAt`），不能是 `startedAt`：登录超时本来就
 * 是 5 分钟（`LOGIN_TIMEOUT_MS`），用户在最后半分钟扫码成功的话，从开始算起的 5
 * 分钟一到状态就判过期，页面还是停在「等待中」。
 */
export const OAUTH_STATUS_TTL_MS = 5 * 60_000;

/* ------------------------------------------------------------------------- */
/* 抢活动：claim 控制面的读模型                                               */
/* ------------------------------------------------------------------------- */

// claim 领域的形状在 `src/claim/`（types.ts 领域模型 / scheduler.ts 运行状态）。
// 读模型只复用形状：type-only import，不得把 claim 的运行时依赖图拉进控制面。
import type { ClaimablePlan, ClaimOutcome } from "../claim/types.js";
import type { ClaimSchedulerStatus } from "../claim/scheduler.js";

import type { ClaimOpeningConfig } from "../config/types.js";

/** `getClaimOverview` 的配置快照段（面板只读展示；编辑走 writeSettings）。*/
export interface ClaimConfigSummary {
  enabled: boolean;
  auto: boolean;
  origin: string;
  pollIntervalMs: number;
  cooldownMs: number;
  sprintWindowMs: number;
  sprintPollIntervalMs: number;
  policy: string;
  opening: ClaimOpeningConfig;
}

/** per-plan hold 的面板形状：挂到几点（unix ms）+ 为什么挂（「已领」标注的来源）。*/
export interface ClaimPlanHoldView {
  until: number;
  reason: string;
  userAction?: string;
}

/** 最近一次 tick / 手动领取（`ClaimLastTick` 的 JSON 形状，联合收窄成 string）。*/
export interface ClaimLastTickView {
  at: number;
  action: string;
  source?: string;
  planId?: string;
  failureKind?: string;
  code?: number | string;
  message?: string;
  startsAt?: number;
  endsAt?: number;
  holdSource?: string;
  waitReason?: string;
  reason?: string;
  userAction?: string;
}

/** `getClaimOverview` 的每账号行：账号抽屉的 claim 区块按它渲染状态行。*/
export interface ClaimAccountStatus {
  label: string;
  /** 有没有活的 scheduler（claim.enabled + auto 且账号可领）。*/
  running: boolean;
  /** scheduler 主动停机（login_required 等）；仅 `running` 时可能为 true。*/
  stopped?: boolean;
  /** 全局唤醒时刻（unix ms）；`0` = 尚未排程。*/
  holdUntil?: number;
  /** per-plan hold：planId → 挂到几点 + 为什么 + 策略给的用户动作。*/
  planHolds?: Record<string, ClaimPlanHoldView>;
  /** 台账状态、下一次检查/开抢时刻、策略动作与开抢闹钟。*/
  ledgerState?: string;
  nextCheckAt?: number;
  openingAt?: number;
  userAction?: string;
  alarms?: ClaimSchedulerStatus["alarms"];
  /** 最近一次 tick / 手动领取。*/
  last?: ClaimLastTickView;
}

/** `getClaimOverview` 的应答载荷（纯内存读，无上游请求，可随面板轮询）。*/
export interface ClaimOverviewPayload {
  config: ClaimConfigSummary;
  accounts: ClaimAccountStatus[];
}

/** `previewClaimPlans` 的应答载荷：两面合并的当前可领活动（按需拉取，不缓存）。*/
export interface ClaimPlansPayload {
  plans: ClaimablePlan[];
}

/**
 * 发现层活动选择器的一个选项（`listClaimPlanChoices` 的载荷元素）。
 *
 * 只留选择器要读的字段：权益明细、campaignId 与 `raw` 不进设置页。
 * `planId` 只用于排障标识，界面上读的是 `name`；`ledgerState` 是当天台账状态，
 * `userAction` 是策略表给面板的动作。
 */
export interface ClaimPlanChoice {
  planId: string;
  name: string;
  description?: string;
  source?: string;
  priority?: number;
  startsAt?: number;
  endsAt?: number;
  effectiveAt?: number;
  ledgerState?: string;
  userAction?: string;
}

/** `listClaimPlanChoices` 的应答载荷：发现层活动 + 取清单的那个账号。*/
export interface ClaimPlanChoicesPayload {
  /** 清单是从哪个账号拉的；没有可领账号时不出现。*/
  accountLabel?: string;
  plans: ClaimPlanChoice[];
}

/** `claimNow` 的应答载荷：上游的领取结果原样透传（成功 / 失败形状见 ClaimOutcome）。*/
export type ClaimOutcomePayload = ClaimOutcome;
