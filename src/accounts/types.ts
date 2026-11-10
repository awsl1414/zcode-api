/**
 * 账号体系的三层模型类型：Credential / Account / Route。
 *
 * 端点、协议、鉴权、仿冒层、签名、captcha、加速卡、额度、
 * 模型能力**全部是路由的属性**，不是账号的属性。账号只是一份凭据 + 一组允许
 * 的路由白名单。所以没有进程级的全局「套餐」「provider」配置：同一进程里每个
 * 账号各走自己的路由。
 */
import type { ProviderId } from "../provider/types.js";
import { createHash } from "node:crypto";

/**
 * 上游 Family。与 `provider/types.ts` 的 `ProviderId` 是同一集合，这里取别名
 * 而不是重新声明字面量，避免两处漂移（`RouteSpec.baseUrl` 是按 family 建模的，
 * 新增 family 时编译器会在路由表里报缺项）。
 */
export type ProviderFamily = ProviderId;

/** 身份作用域。TEAM 必须带齐 organizationId / projectId / productId。 */
export type TargetType = "PERSONAL" | "TEAM";

/**
 * 账号身份。
 *
 * `deviceMid` 是**一账号一指纹**：`X-Device-Mid` 是官方遥测的
 * 设备标识，跨账号共用 = 一机多号。**没有全局兜底**：官方客户端的
 * deviceMid 是本地随机 UUIDv4、装机时生成、服务端不签发，所以「每个账号 = 一台
 * 虚拟设备」才是正确模型。建号时生成，此后永不改变（重新登录也不换，换指纹
 * 等于告诉上游「这个账号换设备了」，比共用指纹更糟）。
 */
export interface AccountIdentity {
  targetType: TargetType;
  /** TEAM 必填。*/
  organizationId?: string;
  /** TEAM 必填。*/
  projectId?: string;
  /** TEAM 必填。*/
  productId?: string;
  /** 一账号一指纹。建号时生成（`randomUUID`），此后永不改变。*/
  deviceMid: string;
}

/**
 * 套餐账号凭据：`zhipu-account`（官方 `ProviderAccess` 的第二种 type）。
 *
 * 一个凭据可以同时持有 apiKey 对与 plan JWT：apiKey 对喂 coding-plan 与 MCP /
 * async / highspeed，JWT 喂 start-plan / off-peak / quota / claim。能开哪条路由
 * 由 {@link RouteSpec.requires} 决定，不由这里决定。
 */
export interface ZhipuAccountCredential {
  kind: "zhipu-account";
  provider: ProviderFamily;
  /** `{apiKeyId}.{secret}` 的前半，或 bigmodel 的整串 key。JWT-only 导入时为空串。*/
  apiKey: string;
  /** Z.AI 必填；bigmodel 单 key 账号可缺省（见 auth/types.ts `credentialString`）。*/
  secret?: string;
  /** zcode plan JWT（`zcodejwttoken`），start-plan / off-peak / quota / claim 用。*/
  jwt?: string;
  /**
   * 原始 OAuth access token（bigmodel）。3.15.1 起的 project-access-token 平面
   * 用它铸造签名 JWT（`project_access`，5h）。API-key 导入与老登录没有这个值。
   */
  oauthAccessToken?: string;
  /**
   * 上游账号标识（`user_id` / `customer_id`）。
   *
   * 存在的唯一理由：JWT-only 账号的 `apiKey` 是空串，而 `jwt` 被指纹排除，
   * 于是所有 JWT-only 账号指纹相同、互相覆盖。指纹用它兜底 `apiKey`。
   * 必须稳定：`user_id` / `customer_id` 是账号级不变值。
   */
  upstreamUserId?: string;
  identity: AccountIdentity;
  /**
   * Unix ms：凭据的过期时间点。
   *
   * **当前没有任何写入点**：登录与导入都拿不到可信的 `exp`（plan JWT 只有 `iat`，
   * 网关也不按年龄拒），猜一个值只会把还能用的账号判死（`auth/import.ts`）。
   * 字段与 `manager.ts::inferRoutes` 的到期判定留着是为了**已落盘**的文件
   * （历史账号 / 手工编辑）能照样被拦住；`auth/types.ts` 的凭据形状里没有这一列，
   * 判定只在这一处。
   */
  expiresAt?: number;
}

export type Credential = ZhipuAccountCredential;

/**
 * 凭据类别。
 *
 * 只剩一个值是因为按量计费的独立 key 凭据已随那条路由删除：
 * 项目只服务套餐凭据。类型留着而不是把字面量内联到各处，是因为它同时
 * 出现在对外协议字段里（`control/control.ts` 的 `AccountSummary.kind` /
 * `MaskedAccount.kind`），字段本身要留着才能保持协议形状不变；留一个恒定值字段
 * 的代价小于改网页侧的解析。
 */
export type CredentialKind = "zhipu-account";

/**
 * 路由种类。
 *
 * `off-peak` / `highspeed` 是**派生入口**：官方注释明确它们不是独立套餐，权益
 * 继承 `coding-plan` 的母体，请求期鉴权分别来自票券与加速卡 JWT。所以它们
 * 自己不可独立存在（不在白名单里同时给出母体就是非法组合）。
 */
export type RouteKind = "coding-plan" | "start-plan" | "off-peak" | "highspeed";

/**
 * 出线协议。
 *
 * 只剩 Anthropic 一种：`openai-chat-completions` 只被按量计费那条路由使用，
 * 它已删除。字段留着是因为它是路由表里的显式事实，新增
 * 出线协议时改这里而不是在请求链路里加分支。
 */
export type ApiType = "anthropic-messages";

/**
 * 出线前要叠加的仿冒/准入层。
 *
 * 每一项都对应一个真实子系统；`NO_LAYERS` 是「这条路由不开某层」的显式写法
 * （派生路由与 `zcodeClientLayers` 的基底都从它派生）。
 */
export interface LayerFlags {
  /** ZCode 仿冒头 + system prompt 三块注入（proxy/identity.ts、system-prompt.ts）。*/
  impersonation: boolean;
  /** 客户端签名 V4 + PoW（proxy/client-signing.ts）。*/
  signing: boolean;
  /** start-plan 验证码（captcha/captcha*.ts）。*/
  captcha: boolean;
  /** 加速卡可挂（highspeed/manager.ts）。*/
  highspeed: boolean;
  /** x-session-id 推断（proxy/session-context.ts）。*/
  sessionAffinity: boolean;
  /** 归因头（proxy/trace-headers.ts）。*/
  traceHeaders: boolean;
}

/** 路由对凭据的要求。*/
export interface RouteRequires {
  credentialKind: CredentialKind;
  /** 需要 `{apiKey}.{secret}` 对。*/
  apiKeyPair: boolean;
  /** 需要 plan JWT。*/
  jwt: boolean;
  /** 需要 TEAM 身份。*/
  team: boolean;
}

/**
 * 计费口径。只剩套餐额度：`payg` 随按量计费路由一起删除。
 *
 * 字段留着而不是删掉，是为了让「这条路由不消耗免费额度」这种新事实有一个显式
 * 位置可写，而不是藏进某个 if。
 */
export type Billing = "plan";

/** 模型目录来源（能力判定的依据之一）。只剩套餐目录（`api-catalog` 随按量平面删除）。*/
export type ModelCatalog = "plan-catalog";

/**
 * 路由的**静态事实**。内置在代码里（`routes.ts`），不接受用户自由拼装，
 * 自由组合能拼出上游会 3012/401 的非法组合。
 */
export interface RouteSpec {
  kind: RouteKind;
  apiType: ApiType;
  /** 按 family 分列；`start-plan` / `off-peak` / `highspeed` 两家同为 zcode.z.ai。*/
  baseUrl: Record<ProviderFamily, string>;
  layers: LayerFlags;
  requires: RouteRequires;
  /** 派生路由的母体（只有 `coding-plan`）。*/
  derivesFrom?: RouteKind;
  billing: Billing;
  /** 模型集来源。*/
  models: ModelCatalog;
  /**
   * 代理是否**代填** ZCode 三块 system prompt。
   *
   * 这为什么是路由事实而不是 `layers.impersonation` 的一部分：`impersonation`
   * 回答的是「这条路由要不要穿 ZCode 客户端身份面」，**穿法与网关有关**，
   * zcode.z.ai 网关（start-plan）做内容检查，看不到身份块直接回 3012
   * 「method not allowed」，所以必须由代理代填；coding-plan 走 family 端点，客户端的
   * system 原文本身就是仿冒面，代理再覆盖一遍只会改变出线字节（无收益、有回归风险）。
   * 把它写成显式事实，handler 里就不需要 `route === "start-plan"` 这种判断。
   *
   * 不变式：`layers.impersonation === false` 时本字段必须为 `false`。不开仿冒层的
   * 路由不得携带任何仿冒面注入，system prompt 三块属其中一项（`routes.ts` 建表时校验）。
   */
  injectsZcodeSystemPrompt: boolean;
  /**
   * 显式模型集（内部统一小写 id，比对上产前先归一）。
   *
   * `models` 这个目录标签不足以表达 `start-plan` 的限制（它**不含** `glm-5.3`，
   * 而 `plan-catalog` 含），所以在路由表里钉一份显式清单。`null` 表示该路由
   * 的模型集只能来自目录。
   */
  modelIds: readonly string[] | null;
}

/** 账号策略。*/
export interface AccountPolicy {
  /** 选号权重，默认 1。*/
  weight: number;
  /** 单账号并发上限，默认 2（风控优先：真实用户并发通常 ≤ 2）。*/
  maxConcurrency: number;
  /** 可选上游 RPM 闸。*/
  rpmLimit?: number;
}

/** 风控优先的默认并发上限。*/
export const DEFAULT_MAX_CONCURRENCY = 2;
/** 默认权重。*/
export const DEFAULT_WEIGHT = 1;

/** 每个账号拿一份新的 policy 对象，避免共用可变默认值。*/
export function defaultPolicy(overrides: Partial<AccountPolicy> = {}): AccountPolicy {
  return { weight: DEFAULT_WEIGHT, maxConcurrency: DEFAULT_MAX_CONCURRENCY, ...overrides };
}

/**
 * 账号：一份凭据 + 一组允许的路由白名单。
 *
 * `id` 是凭据指纹（`manager.ts::credentialFingerprint`），所以重导入同一凭据是
 * 幂等的；`label` 是用户可改的配置引用键。
 */
export interface Account {
  id: string;
  label: string;
  credential: Credential;
  /** 路由白名单：默认由凭据能力推断，可收窄，但必须过写入校验的六条规则。*/
  routes: RouteKind[];
  enabled: boolean;
  policy: AccountPolicy;
}

/**
 * 运行时覆盖层：优先于 config.yaml 的 entries。
 *
 * `expiresAt` 到点自动回落到持久配置。
 */
export interface RuntimeOverride {
  enabled?: boolean;
  maxConcurrency?: number;
  weight?: number;
  /**
   * 出口代理引用：`accounts.proxies[].name` 或 `direct`。
   *
   * 它可以热调（`setAccountProxy`）并与其它旋钮一样落盘（`policy.json`），
   * 所以它是覆盖层字段而不是账号属性：绑定关系是运行时策略，不是账号身份。
   */
  proxy?: string;
  /** Unix ms。到点自动回落到持久配置。*/
  expiresAt?: number;
}

/**
 * 健康状态：`ok` 可用，`cooling` 冷却中，`drained` 额度耗尽，
 * `auth-invalid` 凭据失效需人工 re-import（连续 auth 失败升级而来，
 * 不再自动冷却循环）。
 *
 * 路由级熔断（`endpoint-broken` / `gateway-broken）不在这里：那是 broker 层
 * breaker 表的 {@link RouteBreakerStatus}，与账号×路由的健康正交。
 */
export type HealthStatus = "ok" | "cooling" | "drained" | "auth-invalid";

/**
 * 健康原因，用于控制面回答「每个账号最近失败原因」。
 *
 * `fair-usage` 是上游 1313 的风控标记（长冷却），`endpoint` 是路由端点形态拒绝，
 * `empty-stream` 是上游返回 200 却不出内容（软拒绝）；`transport` 为路由级故障保留
 * （探针 / 网关证据）。
 */
export type HealthReason =
  | "auth-failed"
  | "rate-limited"
  | "fair-usage"
  | "drained"
  | "transport"
  | "endpoint"
  | "empty-stream";

/**
 * 路由级熔断状态：broker 层 breaker 表的值，键是
 * `RouteKind`，与账号级 {@link HealthStatus} 正交——路由端点被拒不惩罚账号，
 * 账号故障也不熔断路由。
 */
export type RouteBreakerStatus = "endpoint-broken" | "gateway-broken";

/**
 * 额度窗口（coding-plan 的 5h/周 TOKENS_LIMIT、TIME_LIMIT）。
 *
 * 字段语义对齐上游（`packages/shared/src/usage-quota.ts` `UsageQuotaLimit`）：
 * 官方 UI 的窗口「已用 X / 总量 Y」里总量没有上游字段，由 usage+remaining 反推。
 * 把上游 `number`（窗口周期身份：unit=3&number=5 → 5 小时窗）误标成
 * `total` 会造成「4.28 亿已用 / number=5 相除恒 ≥ 1」，额度充足却恒判耗尽，
 * 所以这里不再携带 total。
 */
export interface QuotaWindow {
  type: string;
  /**
   * 上游 `unit`：窗口周期身份的一部分，与 `number` 一起决定官方 UI 的窗口名
   * （unit=3 & number=5 → 5 小时窗、unit=6 → 每周窗、unit=5 & number=1 → 每月工具调用）。
   *
   * **不是总量**：把 `number` 当 token 总量（4.28 亿/5 恒 ≥ 1）会恒判耗尽。这两个字段
   * 原样透传到控制面，只做窗口身份（`findCodingPlanQuotaLimit(type, unit, number)`
   * 那套查表），不参与 drained 判定。
   */
  unit?: number;
  /** 上游 `number`：窗口周期身份的计数（5 小时窗 = 5、每月工具窗 = 1、每周 = 1）。*/
  number?: number;
  /**
   * 上游 `usage`：**token 窗**的已用量（`TIME_LIMIT` 里它是该窗口的总量上限，
   * 已用数是上游的 `currentValue`——两种 type 同名不同义，见 `accounts/quota.ts::usedFraction`）。
   */
  usage?: number;
  /**
   * 上游直接给的剩余量（coding 平面 `limits[].remaining`）。
   *
   * 额度耗尽判定里「`remaining <= 0`」这一条判的就是它：`usage` / `percentage` 缺失时只能靠它
   * 判耗尽（`TIME_LIMIT` 的工具调用窗口就是这种形态），所以必须原样保留。
   */
  remaining?: number;
  /**
   * 上游 `percentage`：**已使用占比**，契约刻度是 0-100 的百分数（官方展示端
   * `100 - percentage` 反转成剩余，`normalizeUsagePercentage` 只做 `clamp(0,100)`）。
   * 归一成 0..1 比例在 `accounts/quota.ts::usedFraction`。
   */
  percentage?: number;
  nextResetTime?: number;
}

/** start-plan 的 credits 平面。*/
export interface QuotaCredits {
  remainingUnits: number;
  totalUnits: number;
  /**
   * 这些余额里最早到期的时刻（Unix ms）；上游没给 `expires_at` 时缺省。
   *
   * 只统计还有余量的 bucket：已烧完的 bucket 什么时候到期与调度无关。
   */
  expiresAt?: number;
}

/**
 * 动态状态：**不落盘**，状态键是 `(accountId, routeKind)`，不是账号。
 *
 * 这里只定义形状；采集与判定在 `quota.ts` / `health.ts`。
 */
export interface RouteState {
  inflight: number;
  queueDepth: number;
  health: {
    status: HealthStatus;
    until?: number;
    reason?: HealthReason;
  };
  quota?: {
    windows: QuotaWindow[];
    credits?: QuotaCredits;
    sampledAt: number;
  };
  highspeedCard?: { cardId: string; model: string; expiresAt: number };
}

/**
 * 调度请求。
 *
 * `sessionId` 是粘性键，`requestedAccount` 来自 `X-ZCode-Account: <label>`，
 * `pinnedAccountId` 用于 Responses 续轮钉号。broker 只读 account 相关字段。
 *
 * 没有 `surface` 字段：调用方在进 broker 之前就用 `auth/capabilities.ts`
 * 的 `checkSurface` 判过「这条 surface 需要的凭据半与路由」，gate 比"把 surface 带进
 * 调度器再路由"更严格；带进来只多一个写入而无读取的字段。
 */
export interface DispatchRequest {
  model: string;
  sessionId: string;
  /** label（不是 id）：配置与请求头都用 label。*/
  requestedAccount?: string;
  pinnedAccountId?: string;
  pinnedRoute?: RouteKind;
}

/** 存储文件的格式版本，整体加密后落盘。*/
export const ACCOUNTS_STORE_VERSION = 2;

/**
 * `~/.zcode-proxy/accounts.json` 解密后的内容。
 *
 * 账号表里没有「默认账号」这个字段：每个请求由谁出线是调度器的决定，
 * 不存在一个账号比其他账号更「当前」。「有没有账号」看 `accounts.length`。
 *
 * 文件里多余的未知字段读的时候直接忽略（`store.ts::reviveAccountsFile` 不校验
 * 多余字段），写回时不会产生它们。
 */
export interface AccountsFile {
  version: typeof ACCOUNTS_STORE_VERSION;
  accounts: Account[];
}

/** 空存储（无账号）。每次返回新对象。*/
export function emptyAccountsFile(): AccountsFile {
  return { version: ACCOUNTS_STORE_VERSION, accounts: [] };
}

/**
 * 凭据指纹 → 账号 id。
 *
 * 指纹里**只放能识别「这是哪个上游账号」的稳定字段**，刻意排除三类会轮换的值：
 *
 * - `jwt` / `oauthAccessToken`：重新登录就换，签名 JWT 甚至 5h 就过期。
 *   把它们算进指纹，「重新导入同一账号」就会变成一个新账号，配置里的 label 引用
 *   与额度/粘性历史全部断掉。
 * - `secret`：同一 apiKeyId 可能被重置 secret，但账号还是那个账号。
 * - `deviceMid`：那是「这个账号用哪台设备」（一账号一指纹，可再生），
 *   不是账号身份本身。
 *
 * `upstreamUserId` 参与并且**兜底** `apiKey`：JWT-only 账号的 apiKey 是空串（
 * `transfer.ts::credentialFromJwt`），只按 apiKey 算指纹会让所有 JWT-only 账号
 * 撞成同一个 id，第二个导入直接覆盖第一个（实测过的 bug）。它本身是账号级
 * 不变值（`user_id` / `customer_id`），所以不违反上面「只放稳定字段」的原则。
 * 两者都为空时指纹仍会碰撞，因为那种凭据本身就无法区分账号，由
 * `manager.ts::validateAccount` 在写入时拒绝，而不是在这里「尽量兜底」。
 *
 * 放在 types.ts 是因为「id 就是指纹」属于模型定义，store 与 manager 都要用；
 * 放在任一边都会逼出跨模块循环依赖。`node:crypto` 是 Bun 原生支持的 API，
 * 不违反 Bun-only 的约束。
 */
export function credentialFingerprint(credential: Credential): string {
  const parts = [
    "zhipu-account",
    credential.provider,
    credential.apiKey.trim() || credential.upstreamUserId?.trim() || "",
    credential.identity.targetType,
    credential.identity.organizationId ?? "",
    credential.identity.projectId ?? "",
    credential.identity.productId ?? "",
  ];
  // \u0000 分隔：字段值里不会出现 NUL，避免 "ab"+"c" 与 "a"+"bc" 撞成同一指纹。
  return createHash("sha256").update(parts.join("\u0000"), "utf-8").digest("hex");
}
