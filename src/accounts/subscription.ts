/**
 * Coding Plan 订阅产品采样：补上「哪套产品、当前期是否有效、什么时候续期」
 * 这条独立数据面，与额度窗口（`/api/monitor/usage/quota/limit`）正交。
 *
 * 官方契约（路径与行号均相对官方 ZCode 仓库）：
 *
 * | 形态 | 接口 | 当前期判据 | 身份材料 |
 * |---|---|---|---|
 * | 个人 | `GET /api/biz/subscription/list`（`packages/services/src/usage-stats/providers/bigmodelSubscriptionProvider.ts:23-25`；列表筛选 `bigmodelUsageQuotaMapper.ts:90-115`；当前期判定 `codingPlanEntitlement.ts:45-56`） | `status=VALID` + `inCurrentPeriod=true`，且 `productId`/`productName` 含 coding | 个人 API Key（PAT 三段式，去 `Bearer` 前缀，`codingPlanProviderAvailability.ts:373-383`） |
 * | 团队 | `GET /api/biz/team/subscribe/product/querySubscribeDetail`（`packages/services/src/bigmodel/codingPlanEntitlement.ts:106-117`；**不是 POST**——官方源码与 `docs/ui/settings-model-provider-two-column-layout.md:49` 同口径） | `hasSubscription=true` + `status=EFFECTIVE` + `memberGrantStatus=VALID`（`:119-131`） | OAuth access token + `bigmodel-organization` / `bigmodel-project`（`:112-116`）；`Authorization` 按 family 分流：zai `Bearer`，bigmodel 裸传（`bigmodelSubscriptionProvider.ts:27-35`） |
 *
 * 时间字段的形态由官方给出，归一**只做可证据化的一步**：
 *
 * - 个人 `nextRenewTime` / `valid` 是本地日期时间字符串，
 *   `parseBigModelLocalDateTime`（`bigmodelUsageQuotaMapper.ts:148-158`）归一成 ISO 再转 Unix ms；
 *   `autoRenew` 为真时 `nextRenewTime` 是下次扣费（renewTime），否则它是当前权益结束时间
 *   （expireTime）；`valid` 尾部日期是权威到期边界（`:117-146`）。
 * - 团队 `subscribeEndTime` 是订阅结束日期字符串（e2e fixture
 *   `packages/desktop/test/e2e/fixtures/entitlement-presentation.ts:118`），
 *   `subscribePeriod` 是计费周期（官方映射为 `billingCycle`，
 *   `bigmodelSubscriptionProvider.ts:37-47`）；团队接口没有续期字段，`renewTime` 不编造。
 *
 * 凭据分流只看账号 `identity` 事实（TEAM 身份必须带齐 org/project 两个 id）：TEAM 且
 * org/project 齐、并且
 * 账号确实存了 `oauthAccessToken` 才查团队端点；**缺团队上下文/缺业务 token 一律不猜**，
 * 退回个人端点，个人 PAT 也缺则 `unknown`。失败与不认识的状态同样 `unknown`——采样层
 * 不编造产品名，展示层退回「用量窗口」描述词，额度窗口数据一个字节都不丢（与额度
 * 采样的 stale 纪律一致：临时故障沿用上次结果）。
 *
 * 本模块**只负责一次 HTTP 采样与归一**，没有定时器、没有缓存、没有独立探测流量：
 * 调用方是 `quota.ts::QuotaSampler.sampleAccount` 的同一个串行 tick（恢复路径零新增
 * 流量这条原则的体现）。
 */
import { buildIdentityHeaders } from "../proxy/identity.js";
import { fetchWithEgress, type EgressOptions } from "../proxy/egress.js";
import { credentialString } from "../auth/types.js";
import type { ProxyConfig } from "../config/types.js";
import { accountDeviceMid } from "./device-mid.js";
import type { Account } from "./types.js";
import { logger } from "../log/index.js";

/** 账号子系统的日志：与额度采样同一个 tag，故障排查不换频道。*/
const log = logger("accounts");

/** 官方个人订阅列表路径（`bigmodelSubscriptionProvider.ts:24`）。*/
const PERSONAL_SUBSCRIPTION_PATH = "/api/biz/subscription/list";
/** 官方团队订阅详情路径（`codingPlanEntitlement.ts:108`；方法 GET，见 `:110`）。*/
const TEAM_SUBSCRIPTION_PATH = "/api/biz/team/subscribe/product/querySubscribeDetail";

/** 上游成功 envelope：沿用官方 `readSuccessfulData`（`codingPlanEntitlement.ts:58-69`）。*/
interface SubscriptionEnvelope {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: unknown;
}

/**
 * 归一后的订阅产品（控制面 `AccountQuotaSummary.subscription` 的形状）。
 *
 * 字段一律标上游原值：`status` 不收窄成枚举（服务端契约文档不在客户端仓，
 * 保持原值比猜一套枚举安全），`kind` 只回答「这次问的是哪个官方端点」，不推断权益归属。
 * 时间统一为 Unix ms；上游没给就是缺省，展示层自己不猜。
 */
export interface AccountQuotaSubscription {
  /** 商品 id（个人 `productId` / 团队 `productId`）。*/
  productId?: string;
  /** 面向用户的产品名（卡片标题；官方 `productName`，没有就不造词）。*/
  productName?: string;
  /** 当前期状态原值（个人 `VALID` / 团队 `EFFECTIVE`；团队还有 `memberGrantStatus`）。*/
  status?: string;
  /** 团队成员授权状态原值（仅团队形态，官方 `codingPlanEntitlement.ts:21-29`）。*/
  memberGrantStatus?: string;
  /** 计费周期（个人 `billingCycle` / 团队 `subscribePeriod` 的小写，官方映射 `:43`）。*/
  billingCycle?: string;
  /** 当前权益到期时刻（Unix ms；个人 `valid` 尾部 / 非自动续费的 `nextRenewTime`，团队 `subscribeEndTime`）。*/
  expireTime?: number;
  /** 下次续费时刻（Unix ms；仅自动续费的个人订阅 `nextRenewTime`，`:117-126`）。*/
  renewTime?: number;
  /** 是否自动续费（个人 `autoRenew`，`bigmodelUsageQuotaMapper.ts:125`）。*/
  autoRenew?: boolean;
  /** 是否处于当前订阅期（个人 `inCurrentPeriod`，当前期筛选的硬条件）。*/
  inCurrentPeriod?: boolean;
  /** 采样形态：personal = subscription/list，team = querySubscribeDetail。*/
  kind: "personal" | "team";
}

/** 一次订阅产品采样的结果；`unknown` 表示这份结果不该对外发布产品身份。*/
export type SubscriptionProbe =
  | { kind: "known"; subscription: AccountQuotaSubscription }
  | { kind: "unknown"; reason: string };

/** 采样依赖：配置、账号、`fetchImpl` 注入、每账号出口代理注入（探针不碰网络也走同一条链）。*/
export interface SubscriptionProbeOptions {
  config: ProxyConfig;
  fetchImpl?: typeof fetch;
  egress?: EgressOptions;
}

/**
 * 官方业务接口 host：从 `providers[family].openaiBase` 取 origin。
 *
 * 与额度 coding 平面同源（`routes-quota.ts::codingOrigin`）：个人/团队订阅接口
 * 挂在 `api.z.ai` / `open.bigmodel.cn`（或 `bigmodel.cn`）这套业务 host 上，
 * 不复用 `claim.origin`（那是 zcode.z.ai 的 start-plan 计费网关）。
 */
function subscriptionOrigin(config: ProxyConfig, account: Account): string | null {
  try {
    return new URL(config.providers[account.credential.provider].openaiBase).origin;
  } catch {
    return null;
  }
}

/** `readSuccessfulData` 的本仓同构版（`codingPlanEntitlement.ts:58-69`）：业务码只认缺省 / 0 / 200。*/
function readData(payload: SubscriptionEnvelope): unknown {
  if (payload.success === false) return undefined;
  if (payload.code !== undefined && payload.code !== 0 && payload.code !== 200) return undefined;
  return payload.data;
}

/** 非空字符串（官方 `readNonEmptyString` 同口径）；空白串一律当没给。*/
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** 官方 `parseBigModelLocalDateTime`（`bigmodelUsageQuotaMapper.ts:148-158`）→ Unix ms。*/
function localDateTimeMs(value: unknown): number | undefined {
  const trimmed = text(value);
  if (!trimmed) return undefined;
  const normalized = trimmed.includes("T") || !trimmed.includes(" ") ? trimmed : trimmed.replace(" ", "T");
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : undefined;
}

/** `valid` 形如「2026-01-01 至 2027-01-01」：官方取最后一个日期（`:142-146`）。*/
function validPeriodEndMs(value: unknown): number | undefined {
  const matches = text(value)?.match(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?/g);
  return localDateTimeMs(matches?.at(-1));
}

/** Coding 商品身份：`productId` / `productName` 含 coding（官方 `codingPlanEntitlement.ts:37-43`）。*/
function isCodingProduct(entry: Record<string, unknown>): boolean {
  return [entry.productId, entry.productName].some(
    (field) => typeof field === "string" && field.toLowerCase().includes("coding"),
  );
}

/**
 * 个人 `subscription/list` 归一：只取 `status=VALID` + `inCurrentPeriod=true` 的
 * Coding 条目（官方 `pickCurrentSubscriptionFromList` → `isActivePersonalCodingPlan`）。
 *
 * 列表里的异构商品不是失败：官方逐条解析、无关条目不遮蔽有效权益
 * （`codingPlanEntitlement.ts:86-95`）；找不到当前期只回 unknown，不把过期条目
 * 伪装成在产品。
 */
export function normalizePersonalSubscription(payload: unknown): SubscriptionProbe {
  const data = readData((payload ?? {}) as SubscriptionEnvelope);
  if (!Array.isArray(data)) return { kind: "unknown", reason: "subscription/list: missing data[]" };
  for (const item of data) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (!isCodingProduct(entry)) continue;
    if (entry.status !== "VALID" || entry.inCurrentPeriod !== true) continue;
    const productId = text(entry.productId);
    const productName = text(entry.productName);
    if (!productId && !productName) continue;
    const autoRenew = entry.autoRenew === true || entry.autoRenew === 1;
    const nextRenewTime = localDateTimeMs(entry.nextRenewTime);
    const subscription: AccountQuotaSubscription = {
      ...(productId ? { productId } : {}),
      ...(productName ? { productName } : {}),
      status: text(entry.status),
      inCurrentPeriod: true,
      autoRenew,
      kind: "personal",
      ...(text(entry.billingCycle) ? { billingCycle: text(entry.billingCycle) } : {}),
      // 自动续费时 nextRenewTime 是续费扣费；非自动续费时它是权益结束时间，
      // 官方明确「避免 UI 同时显示续费和到期两个互斥含义」（mapper :128-139）。
      ...(nextRenewTime !== undefined
        ? autoRenew
          ? { renewTime: nextRenewTime }
          : { expireTime: nextRenewTime }
        : {}),
    };
    const validEnd = validPeriodEndMs(entry.valid);
    if (validEnd !== undefined && subscription.expireTime === undefined) subscription.expireTime = validEnd;
    return { kind: "known", subscription };
  }
  return { kind: "unknown", reason: "subscription/list: no VALID current-period coding subscription" };
}

/**
 * 团队 `querySubscribeDetail` 归一：`hasSubscription` + `EFFECTIVE` + `VALID`
 * 三条件同时成立才确认当前权益（官方 `codingPlanEntitlement.ts:119-131`）。
 *
 * `EXPIRED` / `UNASSIGNED` / 未验证状态都不发布产品身份：失败与无权益在展示层
 * 同样退回描述词卡，不把「曾经买过」读成「现在有效」。
 */
export function normalizeTeamSubscription(payload: unknown): SubscriptionProbe {
  const data = readData((payload ?? {}) as SubscriptionEnvelope);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { kind: "unknown", reason: "querySubscribeDetail: missing data" };
  }
  const entry = data as Record<string, unknown>;
  if (
    entry.hasSubscription !== true ||
    entry.status !== "EFFECTIVE" ||
    entry.memberGrantStatus !== "VALID"
  ) {
    return { kind: "unknown", reason: "querySubscribeDetail: no effective team entitlement" };
  }
  const end = localDateTimeMs(entry.subscribeEndTime);
  const period = text(entry.subscribePeriod)?.toLowerCase();
  return {
    kind: "known",
    subscription: {
      ...(text(entry.productId) ? { productId: text(entry.productId) } : {}),
      ...(text(entry.productName) ? { productName: text(entry.productName) } : {}),
      status: text(entry.status),
      memberGrantStatus: text(entry.memberGrantStatus),
      ...(period ? { billingCycle: period } : {}),
      // 团队接口没有续期字段（官方映射 renewTime: null，bigmodelSubscriptionProvider.ts:45）。
      ...(end !== undefined ? { expireTime: end } : {}),
      kind: "team",
    },
  };
}

/** 团队身份事实：TEAM 且组织 / 项目两个 id 齐（三个 id 的完整性在写入时校验）。
 * 缺任一项都不猜团队接口。*/
function teamIdsOf(account: Account): { organizationId: string; projectId: string } | undefined {
  const identity = account.credential.identity;
  if (identity.targetType !== "TEAM") return undefined;
  const organizationId = identity.organizationId?.trim();
  const projectId = identity.projectId?.trim();
  return organizationId && projectId ? { organizationId, projectId } : undefined;
}

/**
 * 采一个账号的订阅产品（一次 HTTP GET；零独立定时器）。
 *
 * 失败/缺凭据/坏 envelope/不认识的当前期状态全部 `unknown`（fail-open，与额度
 * 采样同一条纪律）；
 * 调用方保留上一次成功的产品身份，只把样本标 stale。
 */
export async function sampleSubscription(
  account: Account,
  options: SubscriptionProbeOptions,
): Promise<SubscriptionProbe> {
  const origin = subscriptionOrigin(options.config, account);
  if (!origin) return { kind: "unknown", reason: "subscription: invalid provider origin" };
  const teamIds = teamIdsOf(account);
  const businessToken = account.credential.oauthAccessToken?.trim();
  const personalKey = credentialString(account.credential).trim().replace(/^Bearer\s+/i, "");
  const isTeam = teamIds !== undefined && businessToken !== undefined && businessToken !== "";
  if (!isTeam && !personalKey) return { kind: "unknown", reason: "subscription: missing personal API key" };

  const url = `${origin}${isTeam ? TEAM_SUBSCRIPTION_PATH : PERSONAL_SUBSCRIPTION_PATH}`;
  // 身份头与额度采样同源（都是「这个账号发出去的请求」，设备指纹按账号取）。业务面与 claim
  // 计费面一样不带 X-ZCode-Agent（`proxy/identity.ts:22` 起官方已删）。
  const headers: Record<string, string> = {
    ...buildIdentityHeaders(options.config.identity, accountDeviceMid(account) ?? ""),
    Accept: "application/json",
  };
  if (isTeam) {
    // 官方 family 分流（bigmodelSubscriptionProvider.ts:33）；团队上下文头见 :112-116。
    headers.Authorization = account.credential.provider === "zai" ? `Bearer ${businessToken}` : businessToken!;
    headers["bigmodel-organization"] = teamIds!.organizationId;
    headers["bigmodel-project"] = teamIds!.projectId;
  } else {
    headers.Authorization = personalKey;
  }
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const resp = await fetchWithEgress(fetchImpl, url, { method: "GET", headers }, options.egress);
    if (!resp.ok) return { kind: "unknown", reason: `subscription: HTTP ${resp.status}` };
    const payload = await resp.json() as SubscriptionEnvelope;
    const result = isTeam ? normalizeTeamSubscription(payload) : normalizePersonalSubscription(payload);
    // 业务失败 envelope 的 msg 是排障线索；不外抛，也不把上游文案当产品名。
    if (result.kind === "unknown" && payload.msg) {
      log.warn("subscription product unknown", { account: account.label, message: payload.msg });
    }
    return result;
  } catch (err) {
    log.warn("subscription sampling failed", { account: account.label, message: (err as Error).message });
    return { kind: "unknown", reason: `subscription: ${(err as Error).message}` };
  }
}
