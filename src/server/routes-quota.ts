/**
 * GET /quota — live quota snapshot from both upstream quota planes.
 *
 * Two planes, mirroring the official desktop panel's split (`getSnapshotForRequest`):
 *  - credits plane: `zcode-plan/billing/balance` + `billing/preview` on the
 *    configured claim origin with the stored OAuth plan JWT and the desktop
 *    identity fingerprint (start-plan/trial credit buckets);
 *  - coding plane: `GET {coding origin}/api/monitor/usage/quota/limit` with the
 *    stored coding-plan API key in `authorization` (bundle `wK`/`Z_`+`md`) —
 *    the windowed usage limits of individual coding plans (`data.limits[]`,
 *    TOKENS_LIMIT = prompt windows; TIME_LIMIT = tool-call window).
 *
 * The billing gateway requires a stable `X-Device-Mid`, so the identity
 * fingerprint of **the account being sampled** is forwarded unchanged (each
 * account is its own virtual device).
 *
 * 额度是账号级的，所以响应只按账号分组：
 * `accounts[]` 里的每一项是那个账号自己采集的快照（一个账号的上游失败只落在它
 * 自己的 `errors[]` / `stale` 里，不影响其他账号）。
 *
 * 逐账号采集直接读账号仓，**不**为每个账号取租约：额度查询是控制面一次性调用，
 * 为 N 个账号占 N 次槽只会把并发槽借给一个不推理的请求（槽位只在真正占用上游时持有）。
 *
 * @see _reverse/NOTEPAD.md "coding-plan 用量平面" (chain extracted from
 *      zcode.z.ai desktop bundle `getSnapshotForQuery`/`BigModelUsageQuotaProvider`)
 */
import os from "node:os";
import { buildIdentityHeaders, normalizePrintableHeaderValue } from "../proxy/identity.js";
import { inspectJwt } from "../auth/jwt-age.js";
import { credentialString, type Credential } from "../auth/types.js";
import type { ProxyConfig } from "../config/types.js";
import type { Broker } from "../accounts/broker.js";
import { toAuthCredential, type AccountManager } from "../accounts/manager.js";
import { accountDeviceMid } from "../accounts/device-mid.js";
import type { Account, RouteKind } from "../accounts/types.js";
import { acquireLease } from "../proxy/lease.js";
import { fetchWithEgress, type EgressOptions } from "../proxy/egress.js";
import { resolveEgressFor } from "../accounts/proxies.js";
import { errorResponse } from "../proxy/http-io.js";

/**
 * One usage window from the coding-plan monitor plane (`limits[]` entry).
 *
 * 字段语义与官方类型逐一对齐（`packages/shared/src/usage-quota.ts`
 * `UsageQuotaLimit` + `packages/services/src/usage-stats/providers/
 * bigmodelUsageQuotaMapper.ts::normalizeLimits`），上游出处随字段注明：
 *
 * - `type` 服务端自定义。已知等价集（`packages/ui/src/lib/
 *   codingPlanQuotaPresentation.ts`）：`TOKENS_LIMIT`（token 窗）≡ `CREDIT_LIMIT`
 *   （zai team plan，unit/number 语义一致，仅枚举名不同）；`TIME_LIMIT` = 每月
 *   工具调用配额（`remaining` 数的是调用次数，不是 token）。未知 type（含官方
 *   合成的 `MCP_USAGE_LIMIT`）**原样保留**——采集层不做语义裁剪，判定层
 *   （`accounts/quota.ts::evaluateDrain`）对每条窗口套的是整张平面统一的契约
 *   （percentage = 已用占比、remaining = 剩余量），与官方展示端
 *   `getQuotaRemainingPercentage` 对任意 limit 生效是同一口径。
 * - `unit` / `number` 是**窗口周期身份**，不是总量：unit=3 & number=5 → 5 小时窗、
 *   unit=6 → 每周窗、unit=5 & number=1 → 每月（TIME_LIMIT）。官方 UI 的窗口
 *   「已用 X / 总量 Y」里总量没有上游字段，由 usage+remaining 反推——把
 *   `number` 当成 token 总量（`total`）会直接读错窗口，这两个字段因此保持
 *   上游原名原语义，不再重命名。
 * - `percentage` 是**已使用占比**（0-100），官方展示端负责反转成剩余
 *   （`getQuotaRemainingPercentage`：100 - percentage）。
 */
interface QuotaCodingLimit {
  type: string;
  /** 上游 `unit`：窗口周期身份的枚举值（数字，官方 `UsageQuotaLimit.unit: number`）。*/
  unit?: number;
  /** 上游 `number`：窗口周期身份的计数（5 小时窗 = 5、每月工具窗 = 1）。*/
  number?: number;
  /** 上游 `usage`：窗口已用量（token 数 / 工具调用次数）。*/
  usage?: number;
  /** 上游 `remaining`：窗口剩余量（TIME_LIMIT 数调用次数）。*/
  remaining?: number;
  /** 上游 `percentage`：已使用占比（0-100）。*/
  percentage?: number;
  /** Epoch seconds or milliseconds, as upstream sends it (both seen in the wild). */
  nextResetTime?: number;
}

interface QuotaPlanEntry {
  planId: string;
  name: string;
  description?: string;
  /** 活动起止（Unix 秒，上游 snake_case 为主、camelCase 别名都收）。营销活动才有；
   *  秒/毫秒两种刻度都发过，归一到毫秒在 `accounts/quota.ts`。*/
  startsAt?: number;
  endsAt?: number;
  entitlements: Array<{
    /** 上游 `entitlement_id`：权益身份（与 balance 桶反查链同源）。*/
    entitlementId?: string;
    showName: string;
    grantUnits: number;
    unitType: string;
    effectiveAt?: number;
    /** 授予/重置周期（daily / one_time）：只作「刷新周期」文案，不参与订阅/体验判定。*/
    period?: string;
  }>;
}

/**
 * 一个套餐实例（`billing/balance` 载荷的 `plans[]`，官方 `zaiStartPlanBilling.ts::
 * ZaiStartPlanPlan` 的逐字段对齐）。它是官方三层结构（plans 实例 / balances 桶 /
 * entitlements 权益）的实例层：设置页的套餐卡按 `plan_id` 从这里取卡片名与状态，
 * 「待生效」= entitlement 的 `effective_at` 在未来。
 */
interface QuotaPlanInstance {
  /** 上游 `user_plan_id`：用户套餐实例身份（同商品多实例时区分归属）。*/
  userPlanId?: string;
  /** 上游 `plan_id`：套餐商品身份（套餐卡的分组键）。*/
  planId: string;
  /** 面向用户的套餐名（卡片标题，如「ZCode Start Plan」「ZCODE GLOBAL BUILD」）。*/
  name: string;
  /**
   * 上游 `status` 原值（实测 `active` / `expired`）。不收窄成枚举：服务端契约
   * 文档不在客户端仓，未知取值原样透传；「已过期」的展示判定叠
   * `ends_at` 已过（官方 `normalizeStartPlanExpiry` 同款强制归一）。
   */
  status?: string;
  /** 生效时刻（Unix 秒，刻度归一在 `accounts/quota.ts`）。*/
  startsAt?: number;
  /** 过期时刻（Unix 秒）。*/
  endsAt?: number;
  entitlements: Array<{
    /** 上游 `entitlement_id`：权益身份（桶反查 period 的钥匙）。*/
    entitlementId?: string;
    showName: string;
    /** 授予/重置周期（daily / one_time）：只作「刷新周期」文案，不参与订阅/体验判定。*/
    period?: string;
    /** 权益生效时刻（Unix 秒；`0` = 立即生效哨兵，未来值 = 「待生效」）。*/
    effectiveAt?: number;
  }>;
}

/**
 * credits 平面的一个余额桶（`billing/balance` 的 `balances[]` 逐字段对齐官方
 * `zaiStartPlanBilling.ts::ZaiStartPlanBalanceEnvelope` + 官方 provider 的
 * `normalizeZaiStartPlanBalanceLimits` 归一口径）：
 *
 * - 剩余只信 **`remaining_units`**：官方注释明确 `available_units` 会再扣除进行中
 *   请求的 `reserved_units`，不能当「剩余」兜底——解析层不读 `available_units`。
 * - `expires_at` 是桶的真实重置/到期边界（官方：服务端契约保证每个桶都带），与
 *   coding 平面的 `nextResetTime` 是两个平面的两个概念。
 * - 归属链：`bucket → (user_plan_id | plan_id) → plans[] → entitlements[]（按
 *   entitlement_id 命中）→ period`。`period` 是**授予/重置周期**（daily = 每日
 *   重置、one_time = 一次性），只作「刷新周期」文案——官方从不用它判订阅/体验
 *   （那二分在数据面，credits 平面恒为体验体系）。
 */
interface QuotaBalanceEntry {
  showName: string;
  /** 上游 `bucket_id`：桶身份（官方用它做提醒去重）。*/
  bucketId?: string;
  /** 上游 `plan_id`：桶归属的套餐商品（官方设置页按它分组套餐卡）。*/
  planId?: string;
  /** 上游 `user_plan_id`：用户套餐实例身份（同商品多实例时区分归属）。*/
  userPlanId?: string;
  /** 上游 `entitlement_id`：桶挂的权益，period 反查链的钥匙。*/
  entitlementId?: string;
  /** 归属 entitlement 的周期类型（上游 `plans[].entitlements[].period`，如 daily / one_time）。*/
  period?: string;
  remainingUnits: number;
  totalUnits: number;
  usedUnits: number;
  /** 上游 `available_units`：扣掉进行中请求预留后的可用量（不作「剩余」展示，语义完整透传）。*/
  availableUnits?: number;
  /** 上游 `reserved_units`：进行中请求的预留量（解释「可用 ≠ 剩余」）。*/
  reservedUnits?: number;
  /** 上游 `meter`：计量面（如 `model_usage`，官方 StartPlanCard 以它筛可展示权益）。*/
  meter?: string;
  unitType?: string;
  /** 上游 `capabilities` 原样（如 `model:glm-5.3-flash`）；去前缀是官方展示层的事。*/
  capabilities?: string[];
  /** 桶到期/刷新边界（上游 `expires_at`，秒/毫秒两种刻度都发过，归一在 `accounts/quota.ts`）。*/
  expiresAt?: number;
  /** 桶的当前授予周期边界（上游 `period_start`，「待生效/生效中」过滤与提醒去重键用）。*/
  periodStart?: number;
  /** 桶的当前授予周期边界（上游 `period_end`）。*/
  periodEnd?: number;
}

interface QuotaCodingPlan {
  /** Plan tier string from upstream (e.g. `"max"`); null when unreported. */
  level: string | null;
  limits: QuotaCodingLimit[];
}

export interface QuotaSnapshot {
  provider: string;
  /**
   * Stored start-plan JWT age (informational). The token has no `exp` and is
   * not rejected by age — an 8-day-old JWT still serves billing/balance. Only
   * a real 401/3012 from the billing gateway indicates re-login is needed,
   * which surfaces in `errors`.
   */
  jwt: { ageHours: number; issuedAt: number } | null;
  balances: QuotaBalanceEntry[];
  /**
   * 已持有的套餐实例（`billing/balance` 载荷的 `plans[]`，三层结构 plans 实例 /
   * balances 桶 / entitlements 权益里的实例层）。套餐卡的卡片名（`plan.name`）与状态词（待生效/生效中/已过期）都
   * 从这里投影；`balances[]` 的桶按 `plan_id` 归属到这些实例上。
   */
  plans: QuotaPlanInstance[];
  claimablePlans: QuotaPlanEntry[];
  /**
   * Coding-plan monitor plane snapshot; null when the endpoint failed or was
   * unreachable — the official panel tolerates the same way (quota: null).
   */
  codingPlan: QuotaCodingPlan | null;
  /**
   * 两套平面各自是否取到了数据。
   *
   * 额度采样（`accounts/quota.ts`）**按平面**判 stale：coding 平面挂了不能
   * 让 start-plan 的 credits 结果一起被标脏，反之亦然。用 `errors[]` 里的字符串
   * 前缀去猜这件事太脆，所以由采集层直接回答。
   *
   * - `credits`：只有凭据带 plan JWT 且 `billing/balance` 返回成功 envelope 时才为真；
   * - `coding`：只有 monitor 端点成功返回时才为真。
   */
  planes: { credits: boolean; coding: boolean };
  errors: string[];
}

/**
 * 一个账号的 credits 平面摘要（`billing/balance` + `billing/preview`）。
 *
 * 没有 plan JWT 的账号（coding-plan 单凭据）不是错误：`available: false` 加空数组
 * 就是它的真实状态，它的额度在 `windows` 里。
 */
export interface QuotaCreditsEntry {
  available: boolean;
  balances: QuotaBalanceEntry[];
  /** 已持有的套餐实例（`billing/balance` 的 `plans[]`）。*/
  plans: QuotaPlanInstance[];
  claimablePlans: QuotaPlanEntry[];
}

/**
 * `/quota` 响应里的单账号条目（逐账号采集）。
 *
 * `stale` 只描述**这个账号**：任一平面 / 端点失败即置位（采样失败保留上一次结果、
 * 标 stale）。一个账号的上游挂了不会把其他账号也标脏，也不会让整份响应失败。
 * 失败原因落在它自己的 `errors[]` 里。
 */
export interface QuotaAccountEntry {
  /** 账号 label（配置与 `X-ZCode-Account` 都用它）。*/
  label: string;
  /** 主路由 = 白名单首条（`normalizeRoutes` 按 `ROUTE_KINDS` 稳定排序）。*/
  plan: RouteKind;
  /** coding 平面的窗口（`limits[]`）；start-plan 账号为空数组。*/
  windows: QuotaCodingLimit[];
  credits: QuotaCreditsEntry;
  stale: boolean;
  errors: string[];
}

/**
 * `GET /quota` 的响应体：只有逐账号分组。
 *
 * 顶层不带 4.x 的单账号快照字段：额度是账号级的，一份「这次租约命中哪个账号」的
 * 快照只会让消费者分不清手上这份是谁的额度。单账号时 `accounts` 只有一项。
 */
export interface QuotaReport {
  accounts: QuotaAccountEntry[];
}

/** Query one billing/monitor URL, tolerating per-endpoint failures. */
async function fetchBilling(
  origin: string,
  path: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  egress?: EgressOptions,
): Promise<{ code?: number; msg?: string; data?: unknown; success?: unknown } | null> {
  try {
    // 额度查询也走账号的出口：从本机 IP 查这个账号的额度，等于把
    // 「这个 IP 上有几个账号」直接告诉计费网关。
    const resp = await fetchWithEgress(fetchImpl, `${origin.replace(/\/+$/, "")}${path}`, { headers }, egress);
    const text = await resp.text();
    try {
      return JSON.parse(text) as { code?: number; msg?: string; data?: unknown; success?: unknown };
    } catch {
      return { code: resp.status, msg: text.slice(0, 120) };
    }
  } catch (e) {
    return { code: -1, msg: String(e).slice(0, 120) };
  }
}

/** Mirror of the bundle's `$_` (isSuccessfulBigModelEnvelope): `success !== false` and code absent/0/200. */
function isSuccessfulEnvelope(e: { code?: number; success?: unknown }): boolean {
  return e.success !== false && (e.code === undefined || e.code === 0 || e.code === 200);
}

/** Coding origin per stored credential's provider — `https://api.z.ai` / `https://open.bigmodel.cn`. */
function codingOrigin(config: ProxyConfig, provider: Credential["provider"]): string | null {
  try {
    return new URL(config.providers[provider].openaiBase).origin;
  } catch {
    return null;
  }
}

/**
 * Normalize one upstream limit entry, mirroring the official `normalizeLimits`
 * (`bigmodelUsageQuotaMapper.ts`)：只要有非空 `type` 就保留——没有数字载荷的行也是
 * 真实窗口（只有周期身份），判定层对它们自然是无害的（无 percentage / remaining
 * 就不触发任何条件）。type 缺失的行才丢弃（官方同款 filter）。
 *
 * 与官方的一处本地放宽：官方 mapper 只收 `typeof === "number"`，这里对数字字段
 * 保留字符串协同（`toFiniteNumber`）——上游实测发过字符串刻度的时间戳/数值
 * （见下方测试），协同是官方严格版的超集，垃圾值仍进不来。
 */
function parseCodingLimit(e: any): QuotaCodingLimit | null {
  if (typeof e?.type !== "string" || e.type.trim() === "") return null;
  const unit = toFiniteNumber(e.unit);
  const number = toFiniteNumber(e.number);
  const usage = toFiniteNumber(e.usage);
  const remaining = toFiniteNumber(e.remaining);
  const pct = toFiniteNumber(e.percentage);
  const reset = toFiniteNumber(e.next_reset_time ?? e.nextResetTime);
  return {
    type: e.type.trim(),
    ...(unit !== undefined ? { unit } : {}),
    ...(number !== undefined ? { number } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(pct !== undefined ? { percentage: pct } : {}),
    ...(reset !== undefined ? { nextResetTime: reset } : {}),
  };
}

/** Coerce an upstream value to a finite number, or undefined (never NaN — JSON.stringify would emit null). */
function toFiniteNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 上游 `readNonEmptyString`（官方 provider 同名函数的同构拷贝）：trim 后非空才收，
 * 否则 `null`。回 `null` 而不是 `undefined` 是刻意的——归属匹配里
 * `candidate.plan_id === planId` 用 `===`，undefined 与 null 不相等，缺字段的桶
 * 不会意外命中同样缺字段的套餐（官方同款防误配）。
 */
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * 桶的 `period` 归属（官方 `normalizeZaiStartPlanBalanceLimits` 同一套反查）：
 * 桶 →（优先 `user_plan_id`，缺了退 `plan_id`）→ `plans[]` 套餐实例 →
 * `entitlements[]` 里 `entitlement_id` 命中项 → `period`。
 *
 * daily = 每日重置授予、one_time = 一次性授予（授予/重置周期，不是订阅标记——
 * 官方从不用 period 判订阅/体验）；找不到归属时返回 undefined
 * （官方对无归属桶走 `warnOnUnattributedStartPlanBuckets` 告警，我们采集层不注水
 * 日志，period 缺省即「归属未知」，不虚构）。`plans` 是 balance 载荷里的套餐实例
 * 列表（套餐卡的数据源），不是 preview 的可领套餐——两个平面各有各的 plans[]。
 */
function balancePeriodOf(plans: any[], balance: any): string | undefined {
  const userPlanId = readNonEmptyString(balance.user_plan_id ?? balance.userPlanId);
  const planId = readNonEmptyString(balance.plan_id ?? balance.planId);
  const entitlementId = readNonEmptyString(balance.entitlement_id ?? balance.entitlementId);
  const plan = plans.find((candidate: any) =>
    userPlanId && readNonEmptyString(candidate.user_plan_id)
      ? readNonEmptyString(candidate.user_plan_id) === userPlanId
      : candidate.plan_id === planId,
  );
  const entitlements = Array.isArray(plan?.entitlements) ? plan.entitlements : [];
  const period = entitlements.find(
    (entry: any) => readNonEmptyString(entry?.entitlement_id) === entitlementId,
  )?.period;
  return readNonEmptyString(period) ?? undefined;
}

/**
 * Build the quota snapshot. Exported for tests.
 *
 * 凭据由调用方给（路由层从 `broker.acquire()` 的租约里取）。这里不再自己
 * 读存储：一个"额度查询"模块不该知道账号存在哪，否则它会永远只查同一个账号的
 * 那份额度。
 *
 * `deviceMid` 同理是**账号级**的：额度是账号的额度，billing 网关看到的
 * 设备指纹也必须是这个账号自己的，否则 N 个账号在网关侧就是同一台机器。`api-key`
 * 凭据没有身份面（R6），调用方传空串，那时不发 `X-Device-Mid`。
 */
export async function collectQuotaSnapshot(
  config: ProxyConfig,
  cred: Credential,
  deviceMid: string,
  fetchImpl: typeof fetch = fetch,
  egress?: EgressOptions,
): Promise<QuotaSnapshot> {
  const jwtInfo = cred.jwt ? inspectJwt(cred.jwt) : null;
  const jwt = jwtInfo
    ? { ageHours: Number(jwtInfo.ageHours.toFixed(2)), issuedAt: jwtInfo.iat }
    : null;
  const identity = config.identity;
  const idHeaders = buildIdentityHeaders(identity, deviceMid);
  // The claim client drops X-ZCode-Agent for zcode.z.ai control-plane calls;
  // the billing gateway follows the same precedent.
  delete idHeaders["X-ZCode-Agent"];
  const headers: Record<string, string> = { ...idHeaders, authorization: `Bearer ${cred.jwt}`, Accept: "application/json" };
  // Billing fingerprint is reconstructed from the observed claim-client format
  // (`${platform}-${arch}`). Reuses identity.ts's env-override normalization
  // (same ZCODE_IDENTITY_PLATFORM/ARCH overrides the proxy headers use); empty
  // or non-printable overrides fall back to the real values — an empty override
  // must not yield `-x64`/`linux-`.
  // NOTE: ProxyIdentity has no platform/arch fields — do not read them off `identity`.
  const platform = `${normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_PLATFORM) ?? process.platform}-${normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_ARCH) ?? os.arch()}`;
  const origin = config.claim.origin || "https://zcode.z.ai";
  const appVersion = identity.appVersion;

  const errors: string[] = [];
  // Credits plane needs the plan JWT; a coding-plan account without one still
  // gets its monitor-plane limits below instead of a dead snapshot.
  let balance: Awaited<ReturnType<typeof fetchBilling>> = null;
  let preview: Awaited<ReturnType<typeof fetchBilling>> = null;
  if (cred.jwt) {
    [balance, preview] = await Promise.all([
      fetchBilling(origin, `/api/v1/zcode-plan/billing/balance?app_version=${encodeURIComponent(appVersion)}&platform=${encodeURIComponent(platform)}`, headers, fetchImpl, egress),
      fetchBilling(origin, `/api/v1/zcode-plan/billing/preview?app_version=${encodeURIComponent(appVersion)}&platform=${encodeURIComponent(platform)}`, headers, fetchImpl, egress),
    ]);
    if (balance && !isSuccessfulEnvelope(balance)) errors.push(`balance: ${balance.code} ${balance.msg ?? ""}`.trim());
    if (preview && !isSuccessfulEnvelope(preview)) errors.push(`preview: ${preview.code} ${preview.msg ?? ""}`.trim());
  } else {
    errors.push("balance: no plan JWT — credits plane unavailable (re-login to capture it)");
  }

  // Coding plane: same contract the official usage panel uses for individual
  // coding plans (`authorization` = the raw API key, personal scope — no team
  // headers, no `?type=2`). Failures degrade to null like the official
  // `fetchQuota().catch(() => null)`, never killing the credits data.
  let codingPlan: QuotaCodingPlan | null = null;
  const cOrigin = codingOrigin(config, cred.provider);
  if (cOrigin) {
    const cEnvelope = await fetchBilling(cOrigin, "/api/monitor/usage/quota/limit", {
      authorization: credentialString(cred),
      accept: "application/json",
    }, fetchImpl, egress);
    if (cEnvelope && isSuccessfulEnvelope(cEnvelope)) {
      const d = (cEnvelope.data ?? {}) as { level?: unknown; limits?: unknown };
      codingPlan = {
        level: typeof d.level === "string" && d.level.trim() !== "" ? d.level.trim() : null,
        limits: (Array.isArray(d.limits) ? d.limits : []).map(parseCodingLimit).filter((l): l is QuotaCodingLimit => l !== null),
      };
    } else {
      errors.push(`coding: ${cEnvelope ? `${cEnvelope.code} ${cEnvelope.msg ?? ""}`.trim() : "request failed"}`);
    }
  }

  const balances: QuotaBalanceEntry[] = [];
  const balanceData = (balance?.data ?? {}) as { balances?: any[]; server_time?: number; plans?: any[] };
  // balance 载荷的 `plans[]` 是套餐实例（官方 `ZaiStartPlanPlan`），两处消费：
  // period 归属从它的 entitlements[] 反查（官方 normalizeZaiStartPlanBalanceLimits
  // 同源）；实例本身透传给套餐卡（卡片名 / 状态词）。preview 的可领套餐
  // 是另一份列表，两者不混。
  const balancePlans = Array.isArray(balanceData.plans) ? balanceData.plans : [];
  const plans: QuotaPlanInstance[] = [];
  for (const p of balancePlans) {
    const planId = readNonEmptyString(p.plan_id ?? p.planId);
    if (planId === null) continue;
    const userPlanId = readNonEmptyString(p.user_plan_id ?? p.userPlanId);
    const status = readNonEmptyString(p.status);
    plans.push({
      ...(userPlanId !== null ? { userPlanId } : {}),
      planId,
      name: String(p.name ?? planId),
      ...(status !== null ? { status } : {}),
      ...(toFiniteNumber(p.starts_at ?? p.startsAt) !== undefined
        ? { startsAt: toFiniteNumber(p.starts_at ?? p.startsAt) as number }
        : {}),
      ...(toFiniteNumber(p.ends_at ?? p.endsAt) !== undefined
        ? { endsAt: toFiniteNumber(p.ends_at ?? p.endsAt) as number }
        : {}),
      entitlements: (Array.isArray(p.entitlements) ? p.entitlements : []).map((e: any) => {
        const entitlementId = readNonEmptyString(e?.entitlement_id ?? e?.entitlementId);
        const period = readNonEmptyString(e?.period);
        return {
          ...(entitlementId !== null ? { entitlementId } : {}),
          showName: String(e?.show_name ?? e?.showName ?? ""),
          ...(period !== null ? { period } : {}),
          ...(toFiniteNumber(e?.effective_at ?? e?.effectiveAt) !== undefined
            ? { effectiveAt: toFiniteNumber(e?.effective_at ?? e?.effectiveAt) as number }
            : {}),
        };
      }),
    });
  }
  for (const b of Array.isArray(balanceData.balances) ? balanceData.balances : []) {
    // unitType/expiresAt camelCase aliases observed live alongside snake_case;
    // accept both so neither casing drops the field. 归属字段同理双刻度（官方载荷
    // 主发 snake_case）。
    const expiresAt = toFiniteNumber(b.expires_at ?? b.expiresAt);
    const periodStart = toFiniteNumber(b.period_start ?? b.periodStart);
    const periodEnd = toFiniteNumber(b.period_end ?? b.periodEnd);
    const unitType = b.unit_type ?? b.unitType;
    const capabilities = Array.isArray(b.capabilities)
      ? b.capabilities.map((capability: unknown) => String(capability)).filter((capability: string) => capability.trim().length > 0)
      : undefined;
    const period = balancePeriodOf(balancePlans, b);
    const bucketId = readNonEmptyString(b.bucket_id ?? b.bucketId);
    const planId = readNonEmptyString(b.plan_id ?? b.planId);
    const userPlanId = readNonEmptyString(b.user_plan_id ?? b.userPlanId);
    const entitlementId = readNonEmptyString(b.entitlement_id ?? b.entitlementId);
    const meter = readNonEmptyString(b.meter);
    balances.push({
      showName: String(b.show_name ?? ""),
      // 剩余只信 remaining_units：available_units 扣除了进行中请求的 reserved_units，
      // 不能当「剩余」（官方 provider 注释同款约束）。
      remainingUnits: toFiniteNumber(b.remaining_units ?? b.remainingUnits) ?? 0,
      totalUnits: toFiniteNumber(b.total_units ?? b.totalUnits) ?? 0,
      usedUnits: toFiniteNumber(b.used_units ?? b.usedUnits) ?? 0,
      ...(toFiniteNumber(b.available_units ?? b.availableUnits) !== undefined
        ? { availableUnits: toFiniteNumber(b.available_units ?? b.availableUnits) as number }
        : {}),
      ...(toFiniteNumber(b.reserved_units ?? b.reservedUnits) !== undefined
        ? { reservedUnits: toFiniteNumber(b.reserved_units ?? b.reservedUnits) as number }
        : {}),
      ...(bucketId !== null ? { bucketId } : {}),
      ...(planId !== null ? { planId } : {}),
      ...(userPlanId !== null ? { userPlanId } : {}),
      ...(entitlementId !== null ? { entitlementId } : {}),
      ...(period !== undefined ? { period } : {}),
      ...(meter !== null ? { meter } : {}),
      ...(unitType ? { unitType: String(unitType) } : {}),
      ...(capabilities !== undefined && capabilities.length > 0 ? { capabilities } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(periodStart !== undefined ? { periodStart } : {}),
      ...(periodEnd !== undefined ? { periodEnd } : {}),
    });
  }

  const claimablePlans: QuotaPlanEntry[] = [];
  const previewData = (preview?.data ?? {}) as { plans?: any[] };
  for (const p of Array.isArray(previewData.plans) ? previewData.plans : []) {
    claimablePlans.push({
      planId: String(p.plan_id ?? ""),
      name: String(p.name ?? p.plan_id ?? ""),
      ...(p.description ? { description: String(p.description) } : {}),
      // 活动起止：领取客户端（claim/client.ts）证实 preview 载荷在营销活动上带
      // starts_at/ends_at（Unix 秒），这里原样收下，刻度归一交给采样层。
      ...(toFiniteNumber(p.starts_at ?? p.startsAt) !== undefined
        ? { startsAt: toFiniteNumber(p.starts_at ?? p.startsAt) as number }
        : {}),
      ...(toFiniteNumber(p.ends_at ?? p.endsAt) !== undefined
        ? { endsAt: toFiniteNumber(p.ends_at ?? p.endsAt) as number }
        : {}),
      entitlements: (Array.isArray(p.entitlements) ? p.entitlements : []).map((e: any) => ({
        ...(readNonEmptyString(e.entitlement_id ?? e.entitlementId) !== null
          ? { entitlementId: readNonEmptyString(e.entitlement_id ?? e.entitlementId) as string }
          : {}),
        showName: String(e.show_name ?? ""),
        grantUnits: toFiniteNumber(e.grant_units ?? e.grantUnits) ?? 0,
        unitType: String(e.unit_type ?? e.unitType ?? "token"),
        ...(toFiniteNumber(e.effective_at ?? e.effectiveAt) !== undefined
          ? { effectiveAt: toFiniteNumber(e.effective_at ?? e.effectiveAt) as number }
          : {}),
        ...(readNonEmptyString(e.period) !== null ? { period: readNonEmptyString(e.period) as string } : {}),
      })),
    });
  }

  return {
    provider: cred.provider,
    jwt,
    balances,
    plans,
    claimablePlans,
    codingPlan,
    planes: {
      // 没有 plan JWT 就没问过 credits 平面（上面直接记一条 error 跳过请求），
      // 所以这里也不能声称取到了数据。
      credits: cred.jwt !== undefined && balance !== null && isSuccessfulEnvelope(balance),
      coding: codingPlan !== null,
    },
    errors,
  };
}

/**
 * Handle GET /quota — JSON snapshot with the proxy error envelope on failure.
 *
 * 额度是账号级的，每个启用账号各采一份。租约只做两件事：没有可用账号
 * 时直接 503，以及给 broker 会命中的那个账号一份已解析好的出口。这里不占并发槽
 * （额度查询是一次性控制面调用，与推理无关）。
 */
export async function handleQuota(
  config: ProxyConfig,
  broker: Broker,
  accounts: AccountManager,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const acquired = await acquireLease(broker, {});
  if (!acquired.ok) {
    return errorResponse(503, "quota_unavailable", `quota query failed: ${acquired.message}`, undefined, acquired.errorCode);
  }
  const lease = acquired.lease;
  lease.release();
  const primary = lease.account;
  try {
    const enabled = (await accounts.list()).filter((account) => account.enabled);
    // 每账号独立采集：`Promise.all` 只是并发发起，结果按账号各自落条目。
    const collected = await Promise.all(
      enabled.map(async (account) => ({
        account,
        snapshot: await collectQuotaSnapshot(
          config,
          toAuthCredential(account.credential),
          accountDeviceMid(account) ?? "",
          fetchImpl,
          // 每个账号用自己的出口查自己的额度：租约命中的账号拿租约里现算的那份，
          // 其余按配置解析（长寿命缓存的实例同理，见 proxies.ts::resolveEgress）。
          account.id === primary.id
            ? lease.egress
            : resolveEgressFor(config.accounts, account.label),
        ),
      })),
    );
    const report: QuotaReport = {
      accounts: collected.map((item) => quotaAccountEntry(item.account, item.snapshot)),
    };
    return new Response(JSON.stringify(report, null, 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return errorResponse(503, "quota_unavailable", `quota query failed: ${(e as Error).message}`, undefined, "other");
  }
}

/** 把一份快照折成响应里的单账号条目。*/
function quotaAccountEntry(account: Account, snapshot: QuotaSnapshot): QuotaAccountEntry {
  // `codingPlan === null` 是 coding 平面没取到数据，此时窗口就是空的，
  // 不是"没有额度"，`errors` 里写着原因。
  const windows = snapshot.codingPlan === null ? [] : snapshot.codingPlan.limits;
  return {
    label: account.label,
    plan: account.routes[0],
    windows,
    credits: {
      available: snapshot.planes.credits,
      balances: snapshot.balances,
      plans: snapshot.plans,
      claimablePlans: snapshot.claimablePlans,
    },
    stale: snapshot.errors.length > 0,
    errors: snapshot.errors,
  };
}
