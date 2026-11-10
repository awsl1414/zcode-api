/**
 * 控制面协议：客户端发什么，dispatcher 回什么。
 *
 * 命令联合类型、三个补丁类型、应答包络、分发的 `HandlerContext` 都在这；展示形态
 * （账号行、风控报告、代理行、登录状态）在 `control-views.ts`，本文件单向依赖它。
 * 命令表有三个消费者（面板 `/api/control`、CLI 转发、`serve` 回环监听），改字段三处
 * 一起看。
 */
import type { Broker, RefreshQuotaDecision } from "../accounts/broker.js";
import type { AccountManager } from "../accounts/manager.js";
import type { PolicyEntry } from "../accounts/overrides.js";
import type { QuotaSample } from "../accounts/quota.js";
import type { HealthObservation } from "../accounts/health-observation.js";
import type {
  AccountsRouting,
  AccountsStickiness,
  AuthFailedAction,
  DrainedAction,
  RoutingMode,
  RoutingStrategy,
  SaturatedAction,
  StickinessSaturatedAction,
  WithinTierOrder,
} from "../accounts/routing.js";
import type { RouteKind, TargetType } from "../accounts/types.js";
import type { ApiKeyManager } from "../apikeys/manager.js";
import type { ApiKeySummary } from "../apikeys/types.js";
import type { OAuthFlowClient } from "../auth/oauth.js";
import type { KeyResolver } from "../auth/resolver.js";
import type { DetectedAppVersion } from "../identity/app-version.js";
import type { LogBuffer } from "../log/buffer.js";
import type { RequestHistoryPage } from "../proxy/request-log.js";
import type { RequestRecord, RequestStore } from "../proxy/request-record.js";
import type { UsageStatsStats } from "../proxy/usage-stats.js";
import type { ProviderId } from "../provider/types.js";
import type { QuotaSnapshot } from "../server/routes-quota.js";
import type {
  AccountSummary,
  ClaimAccountStatus,
  ClaimConfigSummary,
  ClaimOutcomePayload,
  ClaimOverviewPayload,
  ClaimPlanChoicesPayload,
  ClaimPlansPayload,
  MaskedAccount,
  ProxySummary,
  RiskReport,
} from "./control-views.js";

/**
 * `addAccount` 的凭据来源（`label` 由调用方给）。
 *
 * - `file`：ZCode 本机凭据文件（OAuth token 经 `KeyResolver` 换 coding-plan key），
 *   走 `auth/import.ts` 的既有解析与合并规则。手工粘贴 `{apiKeyId}.{secret}`
 *   的凭据文件同样走这条（`content` 上传），所以手工 key 入口不再单列；
 * - `jwt`：直接粘贴的 plan JWT（离线校验，只能开 start-plan 那半边）。
 */
export type AccountSource = "file" | "jwt";

/** 导出格式。默认 `encrypted`；`plain` 需显式 `force`。*/
export type ExportFormat = "encrypted" | "plain" | "masked";

/** `setRoutingPolicy` 的 `routing` 补丁（字段缺省 = 保持原值）。*/
export interface RoutingPolicyPatch {
  order?: RouteKind[];
  withinTier?: WithinTierOrder;
  mode?: RoutingMode;
  strategy?: RoutingStrategy;
  onSaturated?: SaturatedAction;
  onDrained?: DrainedAction;
  onAuthFailed?: AuthFailedAction;
  queueTimeoutMs?: number;
  maxQueue?: number;
  maxTotalInflight?: number;
}

/**
 * `setRoutingPolicy` 的 `risk` 补丁（字段缺省 = 保持原值）。
 *
 * `accounts.risk` 里只有 `jitterHeartbeat` 进了配置面（有真实消费者：
 * `highspeed/slots.ts` 的错峰相位）。每账号出口代理**不在**
 * 这里：出口代理由命名代理表 + `entries[].proxy` 表达，没有消费者的开关就是伪配置。
 */
export interface RiskPolicyPatch {
  jitterHeartbeat?: boolean;
}

/**
 * 生效中的风控开关（`getRoutingPolicy` 的 `risk` 段）。
 *
 * 与 `RoutingPolicyPatch` 不同，这里是**全量**值而不是补丁：页面直接拿它渲染开关，
 * 不需要自己合并默认值。
 */
export interface RiskPolicy {
  jitterHeartbeat: boolean;
}

/** `setRoutingPolicy` 的 `stickiness` 补丁（字段缺省 = 保持原值）。*/
export interface StickinessPolicyPatch {
  enabled?: boolean;
  ttlSeconds?: number;
  maxSessions?: number;
  onSaturated?: StickinessSaturatedAction;
  overflowAfterMs?: number;
}

/** `addAccount` 的身份入参（TEAM 三个 id 必须齐全，且同源）。
 *
 * 没有 `deviceMid`：它是代理建号时生成的（一账号一指纹），不是用户输入项。
 */
export interface AccountIdentityInput {
  targetType: TargetType;
  organizationId?: string;
  projectId?: string;
  productId?: string;
}

/** `getRequests` 的缺省条数。面板的请求表一屏也放不下更多。*/
export const DEFAULT_REQUESTS_LIMIT = 50;

/**
 * `getRequestsHistory` 的读函数：生产里是 `pageRequestHistory` 的透传，
 * 测试注入桩。同步异步都收（dispatcher 一律 await）。
 */
export type RequestHistoryReader = (query: {
  before?: number;
  limit: number;
}) => RequestHistoryPage | Promise<RequestHistoryPage>;

/**
 * `getUsageStats` 的读函数：生产里是 `computeUsageStats` 的透传，测试注入
 * 桩。同步函数（JSONL 流式扫描，毫秒级）；dispatcher 一律 await。
 */
export type UsageStatsReader = (query: { from?: number; to?: number }) => UsageStatsStats;

/** The control protocol: request shape for `POST /control`. */
export type ControlCommand =
  | { cmd: "status" }
  | { cmd: "startOAuth"; provider: ProviderId }
  | { cmd: "deliverOAuthCode"; provider: ProviderId; code: string; state: string }
  | { cmd: "getLogs"; since?: number }
  /**
   * 最近 N 条请求记录。请求列表读它，与面板的 `request` 事件同源（都是进程内存
   * 里的 `RequestStore`）。缺省 50 条。
   */
  | { cmd: "getRequests"; limit?: number }
  /**
   * 请求历史的一页：从 `requests.jsonl`（全量落盘、只追加不重写）倒序
   * 分页读，面板「加载更早」用。`before` 是游标（上一批最早一条的 `startedAt`，
   * Unix ms）：只回 `startedAt <= before` 的记录——游标上的记录会随下一页重发
   * （同毫秒的并列记录因此不丢），客户端按 `reqId` 去重；缺省从最新开始。
   * `limit` 缺省 100，上限 500（`REQUEST_HISTORY_PAGE_LIMIT` / `REQUEST_HISTORY_PAGE_MAX`）。
   */
  | { cmd: "getRequestsHistory"; before?: number; limit?: number }
  /**
   * 用量统计聚合：requests.jsonl 的单遍倒序流式扫描，一次输出全部维度
   * （totals / 时间桶 / 六个分组 / 错误表 / 调度事件 / 缓存命中）。`from` / `to`
   * 是 `startedAt` 的双闭区间边界（Unix ms）；非法值按缺省（不限）处理，判定在
   * `computeUsageStats` 里（与 `getRequestsHistory` 对非法游标同一条纪律）。
   */
  | { cmd: "getUsageStats"; from?: number; to?: number }
  /**
   * 双平面额度快照。
   *
   * 缺省 `label` = 原行为：租约命中的账号采一次双平面，应答带整份 `QuotaSnapshot`
   * （一次性的全量读）。带 `label` = 控制面「立即刷新」那个账号（账号
   * 详情卡的「刷新」按钮）：走采样器同一条归一路径，顺带喂健康表，应答不带快照——
   * 面板随后自己回读 `/api/state`，服务端是唯一真值。
   * 带 `labels` = 顶栏刷新的分级采：服务端按「抽屉详情账号必采 /
   * stale 补采 / 新鲜不采 / 30s 去重」决策，`focusedLabel` 是开着的那个抽屉账号。
   * 面板按 label 引用账号（摘要不回显完整 id），服务端逐条解析成账号 id 后分级采。
   */
  | { cmd: "quota"; label?: string; labels?: string[]; focusedLabel?: string }
  | { cmd: "getHealthObservation" }
  | { cmd: "shutdown" }
  // ---- 账号 / 策略命令面------------------------------------------------
  | { cmd: "listAccounts" }
  | {
      cmd: "addAccount";
      source: AccountSource;
      /** 用户指定的 label（配置与 `X-ZCode-Account` 的引用键，必须唯一）。*/
      label: string;
      /** `source: "file"`：凭据文件路径，缺省 `~/.zcode/v2/credentials.json`。*/
      file?: string;
      /** `source: "file"`：直接给文件内容（上传时用），优先于 `file`，不落盘。*/
      content?: string;
      /**
       * `source: "file"`：手工粘贴的 `{apiKeyId}.{secret}` 整串，优先于文件。
       *
       * 它和凭据文件里的 `api-key-pair` 落到同一个凭据形状（`auth/import.ts` 的
       * 那条分支），所以不需要独立的来源值。
       */
      apiKey?: string;
      /** `source: "jwt"`：plan JWT 原文。*/
      jwt?: string;
      /** 凭据出身：`jwt` 的 payload 没有这个字段，必须由调用方指定。*/
      provider?: ProviderId;
      /** 白名单收窄；缺省按凭据能力推断。*/
      routes?: RouteKind[];
      identity?: AccountIdentityInput;
    }
  | { cmd: "removeAccount"; label: string; drain?: boolean }
  | { cmd: "setAccountEnabled"; label: string; enabled: boolean; force?: boolean }
  | { cmd: "setAccountConcurrency"; label: string; maxConcurrency: number }
  | { cmd: "setAccountWeight"; label: string; weight: number }
  | { cmd: "resetAccountOverrides"; label: string }
  | { cmd: "getRoutingPolicy" }
  | {
      cmd: "setRoutingPolicy";
      routing?: RoutingPolicyPatch;
      stickiness?: StickinessPolicyPatch;
      risk?: RiskPolicyPatch;
    }
  | { cmd: "getRiskReport" }
  | {
      cmd: "exportAccounts";
      format: ExportFormat;
      password?: string;
      /** 服务端落盘路径（CLI 用）。给了 `inline` 时忽略。*/
      out?: string;
      force?: boolean;
      /**
       * 内容返回模式：不写服务端文件，把整份包放在应答里（`payload` +
       * `filename`），由浏览器用 Blob + `<a download>` 落进下载目录。
       *
       * 浏览器用户看不见服务端的文件系统，所以「导出到 `.zcode-proxy/`」对他们不是
       * 导出。`out` 路径模式保留给 CLI（`auth account export --out`）与备份脚本。
       */
      inline?: boolean;
    }
  | {
      cmd: "importAccount";
      /** 服务端路径（CLI 用）：`auth account import <path>`。*/
      path?: string;
      password?: string;
      /**
       * 导入文件的内容（网页用）：浏览器 `<input type="file">` 读到的原文，
       * 只读入内存、不落盘。给了它就**优先于** `path`（与 `addAccount.content` 同一
       * 条口径），两种包（本工具的导出包 / ZCode 凭据文件）的区分仍在服务端按内容做。
       */
      content?: string;
    }
  // ---- 设置页「服务」组----------------------------------------------
  | { cmd: "checkUpdate" }
  // ---- 设置页「身份」组------------------------------------------------
  /** 重新探测本机官方客户端版本（「从系统同步」按钮）。*/
  | { cmd: "detectAppVersion" }
  // ---- 数据面 API key-----------------------------------------------------
  //
  // 五个命令对应 `/keys` 页的五个动作。创建的应答顶层 `key` 是一次性仪式（创建
  // 弹窗）；`listApiKeys` 也回完整明文（`ApiKeySummary.secret`，由服务端
  // 解密后携带）——面板掩码 / 复制与聊天页「选已管理 key 直接发」都靠它（契约：
  // 记录必带可解密的 secret，损坏记录由服务端丢弃）。除这两处外一律只回
  // 名字 / 前缀 / 用量（hash 永不离开服务端）。
  | { cmd: "listApiKeys" }
  | { cmd: "createApiKey"; name: string }
  | { cmd: "setApiKeyEnabled"; id: string; enabled: boolean }
  | { cmd: "deleteApiKey"; id: string }
  | { cmd: "resetApiKeyUsage"; id: string }
  // ---- 出口代理表---------------------------------------------------------
  //
  // 五条命令对应账号页的代理抽屉与代理列。密码永不回显：`listProxies` 只回
  // `hasPassword`，所以「保存时保留原密码」用**不给 password 字段**表达，空串则
  // 表示清掉它。
  | { cmd: "listProxies" }
  | { cmd: "addProxy"; name: string; url: string; username?: string; password?: string }
  | {
      cmd: "setProxy";
      name: string;
      url?: string;
      enabled?: boolean;
      username?: string;
      password?: string;
    }
  | { cmd: "removeProxy"; name: string; force?: boolean }
  | { cmd: "setAccountProxy"; label: string; proxy: string }
  // ---- 抢活动控制面------------------------------------------------------
  //
  // 四条命令的限频纪律（同 quota，见 control/AGENTS.md）：`getClaimOverview` 纯内存读、可随
  // 面板轮询；`previewClaimPlans` / `listClaimPlanChoices` 实时拉两面活动清单，
  // **仅手动/进屏触发，永不定时轮询**（billing 面限频）；`claimNow` 单次领取动作。
  // 实现住在 `src/claim/control.ts`（HandlerContext 钩子注入）。命令表非穷举，带
  // label/accountLabel 的变体只有面板发。
  /** 各账号 scheduler 状态（holdUntil、最近结果/失败码）+ claim 配置快照。*/
  | { cmd: "getClaimOverview" }
  /** 实时拉该账号的发现层活动清单（billing preview + marketing deliveries）。*/
  | { cmd: "previewClaimPlans"; accountLabel: string }
  /**
   * 发现层活动选择器：内部挑一个可领账号，拉一次两面清单并用当天台账标注状态，
   * 只回选择器要读的字段（名称 / 描述 / 来源 / 优先级 / 时间窗 / 台账状态，不含权益与 raw）。
   * 与 `previewClaimPlans` 同一份上游调用，差别只在「谁来挑账号」与「回多细」。
   */
  | { cmd: "listClaimPlanChoices" }
  /** 手动领取一个活动；结果落 scheduler 状态与当天台账。*/
  | { cmd: "claimNow"; accountLabel: string; planId: string };

/** Successful response envelope. */
type ControlOk =
  | { ok: true; state: "running"; accounts: number; proxyPort: number; loggedIn: boolean }
  | {
      ok: true;
      event: "oauthUrl";
      authorizeUrl: string;
      callbackPort: number;
      /**
       * 本次流程的 id（= `started.state`）。
       *
       * 登录模态拿它轮询 `GET /api/oauth-status`，判断看到的那条状态是不是自己发起
       * 的那一次：第二次 `startOAuth` 会顶掉前一条流程，页面不能把新流程的 `pending`
       * 认成自己的。
       */
      flowId: string;
    }
  | { ok: true; event: "loginOk"; provider: ProviderId }
  | { ok: true; event: "logs"; nextSince: number; lines: string[] }
  | { ok: true; event: "requests"; records: RequestRecord[] }
  | {
      ok: true;
      event: "requestsHistory";
      /** 一页记录，新的在前；页内按 startedAt 倒序、并列按文件序稳定。*/
      requests: RequestRecord[];
      /** 文件里还有没有更早的记录；false 之后面板收起「加载更早」。*/
      hasMore: boolean;
    }
  /** `getUsageStats` 的应答：聚合形状见 `usage-stats.ts`（口径在文件头）。*/
  | { ok: true; event: "usageStats"; stats: UsageStatsStats }
  | { ok: true; event: "quota"; quota: QuotaSnapshot }
  /** `quota` 命令带 `label` 的应答（详情卡刷新）：立即刷新那个账号，不带快照。*/
  | { ok: true; event: "quotaRefreshed"; label?: string }
  /** `quota` 命令带 `labels` 的分级采应答：实际发了哪些、跳过了哪些。*/
  | { ok: true; event: "quotaRefreshScoped"; decision: RefreshQuotaDecision }
  /** 调度/健康的结构化观测（健康状态变化、熔断指示、退避档位）。*/
  | { ok: true; event: "healthObservation"; observation: HealthObservation }
  | { ok: true; event: "shuttingDown" }
  // ---- 账号 / 策略命令面------------------------------------------------
  | { ok: true; event: "accounts"; accounts: AccountSummary[] }
  | { ok: true; event: "accountAdded"; label: string; idPrefix: string; routes: RouteKind[] }
  | { ok: true; event: "accountRemoved"; label: string; aborted: number }
  | { ok: true; event: "accountEnabled"; label: string; enabled: boolean; aborted: number }
  | {
      ok: true;
      event: "accountConcurrency";
      label: string;
      maxConcurrency: number;
      /** 护栏：调大超过阈值只警告，不拒绝（风控参数由用户拍板）。*/
      warning?: "concurrency_above_r11";
    }
  | { ok: true; event: "accountWeight"; label: string; weight: number }
  | { ok: true; event: "accountOverridesReset"; label: string; cleared: boolean }
  | {
      ok: true;
      event: "routingPolicy";
      routing: AccountsRouting;
      stickiness: AccountsStickiness;
      risk: RiskPolicy;
    }
  | { ok: true; event: "riskReport"; report: RiskReport }
  | {
      ok: true;
      event: "accountsExported";
      format: ExportFormat;
      count: number;
      /** `encrypted` / `plain` 的落盘路径；`masked` 不落盘，故缺省。*/
      path?: string;
      /** `inline: true` 时的包内容（JSON 原文，加密模式即加密包）。*/
      payload?: string;
      /** `inline: true` 时建议的浏览器下载文件名（`zcode-accounts-YYYYMMDD-HHmmss.json`）。*/
      filename?: string;
      /** `masked` 的清单（永不回显凭据原文）。*/
      accounts?: MaskedAccount[];
    }
  | { ok: true; event: "accountsImported"; imported: number; labels: string[] }
  // ---- 设置页「服务」组-------------------------------------------------
  | { ok: true; event: "updateCheck"; update: UpdateCheckSummary }
  // ---- 设置页「身份」组-----------------------------------------------
  | {
      ok: true;
      event: "appVersion";
      /** 探测到的版本号；没装客户端或读到的值不合格式时为 `null`。*/
      detected: string | null;
      /** 探测到的客户端文件路径，`detected` 为 `null` 时缺省。*/
      path?: string;
    }
  // ---- 数据面 API key-----------------------------------------------------
  | { ok: true; event: "apiKeys"; apiKeys: ApiKeySummary[] }
  | {
      ok: true;
      event: "apiKeyCreated";
      apiKey: ApiKeySummary;
      /**
       * 完整明文。创建弹窗的「显示一次」仪式用（列表里也能再次显示 /
       * 复制，但那是从 `listApiKeys` 的 `secret` 解密得来的，不走这条应答）。
       */
      key: string;
    }
  | { ok: true; event: "apiKeyEnabled"; apiKey: ApiKeySummary; enabled: boolean }
  | { ok: true; event: "apiKeyDeleted"; id: string }
  | { ok: true; event: "apiKeyUsageReset"; apiKey: ApiKeySummary }
  // ---- 出口代理表--------------------------------------------------------
  //
  // 四条写命令都回整张表：页面拿到就能直接重画，不必再发一次 `listProxies`
  // （不做本地乐观更新：服务端就是那次写入后的真值）。
  | {
      ok: true;
      event: "proxies";
      proxies: ProxySummary[];
      /** `accounts.risk.defaultProxy`；没配时不出现。*/
      defaultProxy?: string;
      /** `removeProxy` 带 `force` 时才有：被改回默认出口的账号 label。*/
      detached?: string[];
    }
  | { ok: true; event: "accountProxy"; label: string; proxy: string }
  // ---- 抢活动控制面------------------------------------------------------
  | { ok: true; event: "claimOverview"; config: ClaimConfigSummary; accounts: ClaimAccountStatus[] }
  | { ok: true; event: "claimPlans"; label: string; plans: ClaimPlansPayload["plans"] }
  | ({ ok: true; event: "claimPlanChoices" } & ClaimPlanChoicesPayload)
  | { ok: true; event: "claimOutcome"; label: string; outcome: ClaimOutcomePayload };

/**
 * `checkUpdate` 的结果（设置页「系统 · 检查更新」）。
 *
 * `status` 是**稳定码**：页面按翻译表译成一句话。`latest` / `notice` 是
 * 技术信息（版本号、容器更新命令或下载链接），按「机器能读的标识不翻译」
 * 原样搬运，页面只负责把它拼进句子。
 */
export interface UpdateCheckSummary {
  status: "update" | "up-to-date" | "skipped" | "unavailable";
  /** 当前运行的版本。*/
  current: string;
  /** 上游最新版本；`unavailable` 时没有。*/
  latest?: string;
  /** 更新提示原文（`status: "update"` 时才有）。*/
  notice?: string;
  /** 发布页 / 下载地址（`status: "update"` 时才有）。*/
  url?: string;
}

/** Failure response envelope. */
export interface ControlError {
  ok: false;
  error: string;
  /**
   * 稳定码之外的原文（只有 `unknown_cmd` 用）：码要能进面板的翻译表，
   * 具体是哪条命令这类细节放这里，不污染码本身。
   */
  message?: string;
}

export type ControlResponse = ControlOk | ControlError;

export interface ControlHandlerResult {
  status: number;
  body: ControlResponse;
}

/** Context passed to `handleControlRequest` for hook wiring + log access. */
export interface HandlerContext {
  onShutdown?: () => Promise<void> | void;
  onQuota?: () => Promise<QuotaSnapshot>;
  /**
   * 控制面「立即刷新」一个账号（账号详情卡的刷新按钮）：采那个账号并写回采样器
   * 的快照缓存，面板回读 `/api/state` 就能看到新数据。缺省 = 回 `quota_unavailable`。
   * 不确定账号是否存在由实现抛错，命令表把错误原文透给客户端（与 onQuota 同规矩）。
   */
  refreshQuota?: (label: string) => Promise<void>;
  /**
   * 顶栏刷新的分级采：由 serve 把采样器 + broker 的分类器接进来。
   * 缺省 = 该入口没有采样器（一次性 CLI 的 dispatcher），回稳定码。
   */
  refreshQuotaScoped?: (labels: string[], focusedLabel: string | undefined) => Promise<RefreshQuotaDecision>;
  /**
   * 额度采样周期（秒，`accounts.quota.pollSeconds`）。
   *
   * 数据龄标注的阈值来源：面板显示「上次采样 X 分钟前」的前提是「超过一个
   * 采样周期」，而这个周期是配置值，面板猜不得。缺省按 `DEFAULT_ACCOUNTS_QUOTA`
   * （300s）——没有接采样器的宿主（CLI dispatcher）本来就没有额度摘要可标。
   */
  quotaPollSeconds?: number;
  /**
   * 手动检查更新（`checkUpdate`）。缺省 = 回 `update_check_unavailable`：
   * 没有接更新检查的入口不该假装查过了。
   */
  onCheckUpdate?: () => Promise<UpdateCheckSummary>;
  /**
   * 生效的客户端版本号（`config.identity.appVersion`）。
   *
   * 登录授权链接的 `app_version` 要跟随它：手写值在设置页可见、在身份头生效，
   * 而登录流程是同一次「客户端身份」的另一处出口，两处不一致就回到 R9 不自洽。
   * 缺省（测试、没有配置的调用方）走 `fallbackAppVersion()`：探测 > 默认。
   */
  identityAppVersion?: string;
  /**
   * 重新探测本机官方客户端版本（`detectAppVersion`）。
   *
   * 缺省用 `identity/app-version.ts` 的真实探测：没有客户端时它自己回 `null`，
   * 与「探测不出来」是同一件事，不需要一条「做不到」的错误码。这里留注入点是因为
   * 测试不能依赖跑用例的机器上装了什么。
   */
  onDetectAppVersion?: () => DetectedAppVersion | null;
  logBuffer: LogBuffer;
  /**
   * 请求记录。缺省 = 没有：`getRequests` 回 `request_store_unavailable`。
   *
   * 它是可选的原因是 CLI 自己建的那一份 dispatcher（`cli/control.ts`）不处理请求
   * （没有 `proxyRequest`，也就没人往里写），给它一个空仓只会让「空列表」看起来
   * 像「最近没有请求」。面板与 `serve` 回环监听的入口都传真的那个实例。
   */
  requests?: RequestStore;
  /**
   * 请求历史分页（`getRequestsHistory`）：读 `requests.jsonl` 的钩子。
   *
   * 缺省 = 没有：回 `request_history_unavailable`。与 `requests` 同一条纪律：CLI
   * 的一次性 dispatcher 刻意不接（读历史用 `logs`，它直接读文件）；serve 的入口
   * 接真的那个。
   */
  requestHistory?: RequestHistoryReader;
  /**
   * 用量统计聚合（`getUsageStats`）：`computeUsageStats` 的透传钩子。
   *
   * 缺省 = 没有：回 `usage_stats_unavailable`。与 `requestHistory` 同一条纪律：
   * CLI 的一次性 dispatcher 刻意不接（它读不到正在跑的实例，也无需在生产外算
   * 报表）；serve 的入口接真的那个。数据源同样是 requests.jsonl，
   * 但与 `requestHistory` 分开成钩子：一个是分页读原始记录，一个是聚合报表。
   */
  usageStats?: UsageStatsReader;
  /** 账号仓：登录/登出/status 的唯一真源。*/
  accounts: AccountManager;
  /** Overrides login-client construction (tests inject offline clients). */
  createLoginClient?: (provider: ProviderId) => OAuthFlowClient;
  /**
   * 登录完成后把 OAuth token 换成 coding-plan 凭据的解析器。
   *
   * 缺省用真的 `KeyResolver`（要打上游 biz API）。留这个注入点与 `createLoginClient`
   * 同一个理由：测试不能碰网络。
   */
  keyResolver?: KeyResolver;
  /**
   * 调度器：运行时热调节 / 路由策略 / 风控报告的唯一写入方。
   *
   * 缺省 = 账号类命令返回 `account_control_unavailable`。不给默认值是**刻意**的：
   * 一个没有 broker 的控制面能改账号仓却改不到调度器，那种"改完没生效"的状态比
   * 明确报错难查得多。
   */
  broker?: Broker;
  /**
   * `accounts.entries[]`：**必须与 `Broker` 拿到的是同一份**。
   *
   * 生效策略（`enabled` / `weight` / `maxConcurrency`）是三方合成的
   * （`RuntimeOverride > entries > 账号 policy`），而 `Broker` 把 entries 当作
   * 私有字段。控制面要展示"此刻真的按什么跑"，只能拿同一份配置自己合一次；
   * 漏传的后果是账号表显示 2、调度器按 4 跑。
   */
  entries?: readonly PolicyEntry[];
  /** 额度采样快照（账号表的额度摘要，只读缓存；不触发任何上游请求）。*/
  quotaSamples?: () => readonly QuotaSample[];
  /**
   * 抢活动控制面。缺省 = 三条命令都回 `claim_unavailable`：没接 claim 的
   * 入口（CLI 的一次性 dispatcher）不该假装读过状态。
   *
   * 三个钩子都返回结果对象而不是抛错：稳定码在 `claim/control.ts`
   * 一处生成，这里不二次包装。
   */
  onClaimOverview?: () => Promise<ClaimHookResult<ClaimOverviewPayload>>;
  /** 实时拉两面活动清单（仅手动/进屏触发；实现侧无缓存）。*/
  onPreviewClaimPlans?: (accountLabel: string) => Promise<ClaimHookResult<ClaimPlansPayload["plans"]>>;
  /**
   * 设置页选择器的选项：内部挑一个可领账号拉一次清单（同样是手动触发）。
   * 缺省回 `claim_unavailable`，与其余三个钩子同一条降级。
   */
  onListClaimPlanChoices?: () => Promise<ClaimHookResult<ClaimPlanChoicesPayload>>;
  /** 手动领取；实现侧负责把结果回灌 scheduler（per-plan hold 联动）。*/
  onClaimNow?: (accountLabel: string, planId: string) => Promise<ClaimHookResult<ClaimOutcomePayload>>;
  /**
   * 数据面 API key 仓。缺省用进程级单例：数据面鉴权与这里必须是同一个
   * 实例，否则页面读到的用量永远停在 0。测试注入自己的实例。
   */
  apiKeys?: ApiKeyManager;
}


/** `exportAccounts` 里格式校验通过后的形态（下面的实现只需要这三个）。*/
export type ExportCommand = Extract<ControlCommand, { cmd: "exportAccounts" }>;

/** `importAccount` 的同理。*/
export type ImportCommand = Extract<ControlCommand, { cmd: "importAccount" }>;

/** `addAccount` 的同理。*/
export type AddCommand = Extract<ControlCommand, { cmd: "addAccount" }>;

/** claim 钩子的结果形状（`claim/control.ts::ClaimHookResult` 的协议侧镜像）。*/
export type ClaimHookResult<T> = { ok: true; value: T } | { ok: false; code: string; message?: string };
