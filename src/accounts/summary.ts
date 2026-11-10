import { randomUUID } from "node:crypto";
import { Broker } from "./broker.js";
import { resolvePolicy } from "./overrides.js";
import type { EffectivePolicy } from "./overrides.js";
import { DIRECT_PROXY, effectiveProxyName } from "./proxies.js";
import { DEFAULT_ACCOUNTS_QUOTA, type QuotaSample } from "./quota.js";
// 套餐类型的派生只看「路由→平面」这张静态表，不碰采样器的运行时。
import { quotaPlane } from "./quota-rules.js";
import { HealthStatus } from "./types.js";
import type { Account, AccountIdentity } from "./types.js";
import type { AccountPlanKind, AccountQuotaSummary, AccountQuotaWindow, AccountSummary, AddCommand, HandlerContext, MaskedAccount, RouteHealthSummary } from "../control/control.js";

// ---------------------------------------------------------------------------
// 账号 / 策略命令面：只做编排，业务全在 `accounts/`
// ---------------------------------------------------------------------------

/** `deviceMid` 掩码保留的字符数（够核对，不够复原）。*/
const DEVICE_MID_PREFIX_CHARS = 8;

/** 账号 id 的展示宽度（与 `accounts/selection.ts::shortId` 同口径：12 位足够肉眼比对）。*/

const ACCOUNT_ID_PREFIX_CHARS = 12;

/** 控制面入参是外部输入（面板 / 脚本）：label 类型不对要报错，不能直接 `.trim()`。*/
export function labelOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 路径入参同上：空串与 `undefined` 都是“没给”。*/
export function pathOf(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 整数 ≥ 0（`maxConcurrency: 0` 是软禁用）。*/
export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** 整数 ≥ 1（权重、队列参数、TTL）。*/
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** 账号 id 前缀（展示用）。*/
export function idPrefix(id: string): string {
  return id.slice(0, ACCOUNT_ID_PREFIX_CHARS);
}

/** 生效策略（运行时覆盖 > entries > 账号 policy；与 `Broker.policyFor` 同一份输入）。*/
export function effectivePolicyOf(account: Account, ctx: HandlerContext): EffectivePolicy {
  const entry = ctx.entries?.find((candidate) => candidate.label === account.label);
  const override = ctx.broker?.overrides.get(account.label);
  return resolvePolicy(account, entry, override);
}

/** 账号表的一行（`listAccounts`）。*/
export function summarizeAccount(
  account: Account,
  broker: Broker,
  ctx: HandlerContext,
  samples: readonly QuotaSample[],
): AccountSummary {
  const policy = effectivePolicyOf(account, ctx);
  // 额度只归一一次：planKindsOf 只看路由，不看 balances，所以归一服务的是 quota
  // 字段本身。
  const quota = quotaSummaryOf(samples, account.id, ctx.quotaPollSeconds ?? DEFAULT_ACCOUNTS_QUOTA.pollSeconds);
  const routeHealth: RouteHealthSummary[] = account.routes.map((route) => {
    const state = broker.health.status(account.id, route);
    return {
      route,
      status: state.status,
      ...(state.until !== undefined ? { until: state.until } : {}),
      ...(state.reason !== undefined ? { reason: state.reason } : {}),
    };
  });
  return {
    idPrefix: idPrefix(account.id),
    label: account.label,
    kind: account.credential.kind,
    provider: account.credential.provider,
    routes: [...account.routes],
    enabled: policy.enabled,
    weight: policy.weight,
    maxConcurrency: policy.maxConcurrency,
    health: aggregateHealth(routeHealth),
    routeHealth,
    inflight: account.routes.reduce((sum, route) => sum + broker.leases.inflight(account.id, route), 0),
    quota: quota,
    // 套餐能力对齐：运行时交集遮蔽，不改写 account.routes（策略变更后下一次 acquire 重算）。
    capabilityBlocks: broker.capability.blockedOf(account),
    planKinds: planKindsOf(account),
    // JWT-only 账号的 apiKey 是空串。页面据此解释「只能跑 start-plan」，
    // 所以这里只回有没有，不回凭据原文。
    hasApiKey: account.credential.apiKey.trim().length > 0,
    ...(policy.rpmLimit !== undefined ? { rpmLimit: policy.rpmLimit } : {}),
    ...(account.credential.kind === "zhipu-account" && account.credential.identity.deviceMid
      ? { deviceMid: maskDeviceMid(account.credential.identity.deviceMid) }
      : {}),
    // 生效出口：优先级链只回答「用哪一个名字」，`risk.defaultProxy` 那一档
    // 只有 broker 知道（`policy.proxy` 里没有它），所以这里拿两侧同一条链拼一次，
    // 缺省就是直连。
    proxy: effectiveProxyName(policy.proxy, broker.risk.defaultProxy) ?? DIRECT_PROXY,
  };
}

/** `X-Device-Mid` 展示用掩码：前 `DEVICE_MID_PREFIX_CHARS` 位，够核对不够复原。*/
function maskDeviceMid(deviceMid: string): string {
  return deviceMid.length <= DEVICE_MID_PREFIX_CHARS
    ? deviceMid
    : deviceMid.slice(0, DEVICE_MID_PREFIX_CHARS);
}

/** 路由级健康的聚合（auth-invalid > drained > cooling > ok：凭据失效最严重且需人工）。*/
function aggregateHealth(routeHealth: readonly RouteHealthSummary[]): HealthStatus {
  if (routeHealth.some((entry) => entry.status === "auth-invalid")) return "auth-invalid";
  if (routeHealth.some((entry) => entry.status === "drained")) return "drained";
  if (routeHealth.some((entry) => entry.status === "cooling")) return "cooling";
  return "ok";
}

/** 账号级套餐类型的固定输出顺序（subscription 在前：订阅是长期态，体验是有限期态）。*/
const PLAN_KIND_ORDER: readonly AccountPlanKind[] = ["subscription", "experience"];

/**
 * 账号级套餐类型：只看**路由 → 平面**这张静态表
 * （`quota-rules.ts::quotaPlane`），不碰采样数据。
 *
 * coding 平面（`coding-plan` 及派生入口 `off-peak` / `highspeed`）是订阅编码
 * 套餐（subscription），credits 平面（`start-plan` 的余额桶）是体验套餐
 * （experience）——订阅/体验的二分在**数据面**：哪套 entitlement 接口确认了
 * 权益，官方从不按桶上的字段判。
 *
 * 不能用 `balances[].period` 推套餐类型：`period` 是 entitlement 的**授予/重置
 * 周期**（daily = 每日重置、one_time = 一次性），官方 e2e mock 的体验套餐就是
 * `period: "daily"`——daily 不等于订阅。按它映射就会把「ZCODE GLOBAL BUILD」
 * 「ZCode Start Plan」（都是 billing/balance 的体验体系）的 daily 桶贴上
 * 「订阅套餐」标签，这是实际发生过的故障。`period` 只作「刷新周期」文案，永不参与
 * 套餐类型派生。
 */
function planKindsOf(account: Account): AccountPlanKind[] {
  const kinds = new Set<AccountPlanKind>();
  for (const route of account.routes) {
    const plane = quotaPlane(route);
    if (plane === "coding") kinds.add("subscription");
    else if (plane === "credits") kinds.add("experience");
  }
  return PLAN_KIND_ORDER.filter((kind) => kinds.has(kind));
}

/**
 * 采样结果 → 账号级额度摘要（`null` = 没采过，不是“零额度”）。
 *
 * `sampledAt` 取该账号全部样本里最新的一份（stale 样本保留旧时刻，正是数据龄
 * 要表达的），配 `pollSeconds` 一起给面板算「上次采样 X 分钟前」：采样龄超过一个
 * 采样周期就标注，免得用户把旧数据当新的。
 */
function quotaSummaryOf(samples: readonly QuotaSample[], accountId: string, pollSeconds: number): AccountQuotaSummary | null {
  const mine = samples.filter((sample) => sample.accountId === accountId);
  if (mine.length === 0) return null;
  const windows: AccountQuotaWindow[] = [];
  let credits: AccountQuotaSummary["credits"];
  let balances: AccountQuotaSummary["balances"] | undefined;
  let plans: AccountQuotaSummary["plans"] | undefined;
  let campaigns: AccountQuotaSummary["campaigns"] | undefined;
  let subscription: AccountQuotaSummary["subscription"];
  let stale = false;
  let sampledAt = 0;
  for (const sample of mine) {
    stale = stale || sample.stale;
    if (sample.sampledAt > sampledAt) sampledAt = sample.sampledAt;
    for (const window of sample.quota?.windows ?? []) {
      windows.push({
        type: window.type,
        // 窗口身份原样搬运：展示层靠 unit/number 区分 5 小时 / 每周 / 工具调用。
        ...(window.unit !== undefined ? { unit: window.unit } : {}),
        ...(window.number !== undefined ? { number: window.number } : {}),
        ...(window.usage !== undefined ? { usage: window.usage } : {}),
        ...(window.remaining !== undefined ? { remaining: window.remaining } : {}),
        ...(window.percentage !== undefined ? { percentage: window.percentage } : {}),
        ...(window.nextResetTime !== undefined ? { nextResetTime: window.nextResetTime } : {}),
      });
    }
    // balances / plans / campaigns 只由 credits 平面的样本携带：coding
    // 样本不设这三段，见到 undefined 不能把已经拿到的套餐数据盖掉。空数组保留——
    // 「平面答了、桶是空」是真实状态（空态文案靠它区分「还没采过」）。
    if (sample.quota?.balances !== undefined) balances = sample.quota.balances;
    if (sample.quota?.plans !== undefined) plans = sample.quota.plans;
    if (sample.quota?.campaigns !== undefined) campaigns = sample.quota.campaigns;
    if (sample.quota?.credits !== undefined) {
      const { remainingUnits, totalUnits, expiresAt } = sample.quota.credits;
      credits = { remainingUnits, totalUnits, ...(expiresAt !== undefined ? { expiresAt } : {}) };
    }
    // 订阅产品只由 coding 平面样本携带。按「见到就覆盖」沿用 credits 三段的
    // 同款纪律：多 coding 路由（含派生入口）写的是同一轮采来的同一份产品，缺字段
    // 的样本不能把已拿到的身份抹掉。sampledAt 复用上面取的最新时刻，不另开时钟。
    if (sample.quota?.subscription !== undefined) subscription = sample.quota.subscription;
  }
  // 空数组不缺省：协议消费方靠「有段没数据」区分「没采过」（quota 为 null）。
  return {
    stale,
    sampledAt,
    pollSeconds,
    windows,
    balances: balances ?? [],
    plans: plans ?? [],
    campaigns: campaigns ?? [],
    ...(credits ? { credits } : {}),
    ...(subscription ? { subscription } : {}),
  };
}

/** 掩码清单的一行：只有 label / provider / routes / 指纹前缀，不含凭据。*/
export function maskAccount(account: Account): MaskedAccount {
  return {
    label: account.label,
    kind: account.credential.kind,
    provider: account.credential.provider,
    routes: [...account.routes],
    idPrefix: idPrefix(account.id),
  };
}

/**
 * 建号用的身份（缺省 PERSONAL：TEAM 的三个 id 必须由导入流程从上游发现，不能猜，
 * 跨 Family 拼接会被上游识别）。
 *
 * `deviceMid` 在这里生成（一账号一指纹）：官方客户端的 deviceMid 是本地随机
 * UUIDv4、装机时生成（`apps/zcode-cli/packages/adapters/src/device/cli-device-mid.ts`），
 * 与登录无关，所以它不能是用户输入项（`AccountIdentityInput` 里没有这个字段）。
 * 刷新同一账号时由 `manager.ts::keepDeviceMid` 沿用旧值。
 */
export function identityOf(cmd: AddCommand): AccountIdentity {
  return { ...(cmd.identity ?? { targetType: "PERSONAL" }), deviceMid: randomUUID() };
}
