/**
 * 控制面的只读聚合视图（`listAccounts` / `getRiskReport` / `listProxies` 的实现侧）。
 *
 * 这一层的共同点是**只读**：把调度器与账号仓的瞬时状态算成一个可以渲染的形状，不
 * 改任何东西。写侧在 `control.ts` 的命令表与 `control-policy.ts`。
 *
 * 错误码映射（`accountCommandError` / `proxyCommandError`）也在这：它们把领域异常翻
 * 成稳定码，属于「命令结果怎么表达」，与本文件同一条只读语义；写侧的命令
 * 直接调用它们。
 */
import { AccountUnavailableError } from "../accounts/broker.js";
import type { Broker } from "../accounts/broker.js";
import { AccountError } from "../accounts/manager.js";
import type { AccountErrorCode } from "../accounts/manager.js";
import { DEFAULT_PROXY_ENABLED, ProxyError } from "../accounts/proxies.js";
import type { ProxyErrorCode, ProxySpec } from "../accounts/proxies.js";
import { effectivePolicyOf } from "../accounts/summary.js";
import type { PlanAccount } from "../accounts/transfer.js";
import type { Account } from "../accounts/types.js";
import { getDefaultApiKeyManager } from "../apikeys/manager.js";
import type { ApiKeyManager } from "../apikeys/manager.js";
import type { ControlError, ControlResponse, HandlerContext } from "./control-types.js";
import type { ProxySummary, RiskAlert, RiskReport } from "./control-views.js";

/**
 * 并发默认值是 2，护栏阈值是“超过 4 要警告”。
 *
 * 4 不是另一个默认值，而是“真实用户并发上限”的经验上界：超过它就值得让用户知道
 * 自己在偏离风控默认（软约束可调，但要显式确认）。
 */
export const R11_CONCURRENCY_WARN_THRESHOLD = 4;

/**
 * 控制面用的 key 仓。
 *
 * 缺省落到进程级单例，与 `server.ts` 的数据面鉴权是同一个实例（用量才看得见）。
 * 注入口留给测试：一个用例不该写进用户真实的 `apikeys.json`。
 */
export function apiKeysOf(ctx: HandlerContext): ApiKeyManager {
  return ctx.apiKeys ?? getDefaultApiKeyManager();
}

// ---------------------------------------------------------------------------
// 出口代理表
// ---------------------------------------------------------------------------

/**
 * 代理表的整张快照。
 *
 * 「使用中」按**生效出口**数，不是按 `entries[]` 里的显式引用数：继承了
 * `risk.defaultProxy` 的账号也算在用（它们和显式指向的账号从同一个 IP 出线），
 * 运行时覆盖过的同理。概览的「共用同一出口」告警用的是同一套分组。
 */
export async function proxiesReply(ctx: HandlerContext): Promise<ControlResponse> {
  const broker = ctx.broker;
  if (!broker) return { ok: false, error: "proxy_control_unavailable" };
  const accounts = await ctx.accounts.list();
  const usedBy = new Map<string, number>();
  for (const account of accounts) {
    const name = broker.accountProxyName(account);
    usedBy.set(name, (usedBy.get(name) ?? 0) + 1);
  }
  const proxies: ProxySummary[] = broker.proxyTable().map((proxy) => ({
    name: proxy.name,
    url: maskProxyUrl(proxy),
    hasPassword: proxy.password !== undefined && proxy.password !== "",
    // 缺省启用：只有显式 `false` 才是停用。
    enabled: (proxy.enabled ?? DEFAULT_PROXY_ENABLED) !== false,
    usedBy: usedBy.get(proxy.name) ?? 0,
  }));
  const defaultProxy = broker.risk.defaultProxy;
  return {
    ok: true,
    event: "proxies",
    proxies,
    ...(defaultProxy !== undefined ? { defaultProxy } : {}),
  };
}

/**
 * 地址里的密码打码（页面显示的是打完码的 URL）。
 *
 * 只动 userinfo 里的密码段，主机与端口原样留着：那是用户要核对的东西。写在 URL 里的
 * 密码与单独存在 `password` 字段里的密码都会经过这里，所以两种写法都不回显。
 */
function maskProxyUrl(proxy: ProxySpec): string {
  // 只匹配「scheme://user:password@」这一段：`user` 允许为空（`http://:p@host`），
  // 但必须有冒号，否则 `http://user@host` 这种只有用户名、没有密码的地址会被
  // 无谓地打上 `***`。
  return proxy.url.replace(
    /^([a-zA-Z][\w+.-]*:\/\/)([^/@:]*):[^/@]*@/,
    (_match, scheme: string, user: string) => `${scheme}${user}:***@`,
  );
}

/**
 * `ProxyError` 的稳定码映射（每个码都要能映射到 i18n 键）。
 *
 * 与 `accountCommandError` 同一条规矩：不是代理域的异常照旧抛（那是 bug，HTTP 层会把
 * 它变成 500 + `internal_error`）；把一个 bug 伪装成正常拒绝会让日志里什么都不剩。
 */
const PROXY_ERROR_CODES: Record<ProxyErrorCode, string> = {
  "empty-name": "invalid_proxy_name",
  "duplicate-name": "duplicate_proxy_name",
  "reserved-name": "proxy_name_reserved",
  "unsupported-url": "invalid_proxy_url",
  "unknown-proxy": "proxy_not_found",
  "disabled-proxy": "proxy_disabled",
  "in-use": "proxy_in_use",
};

export function proxyCommandError(err: unknown): ControlError {
  if (err instanceof ProxyError) return { ok: false, error: PROXY_ERROR_CODES[err.code] };
  throw err;
}

/**
 * `AccountError` 的稳定码映射（每个码都要能映射到 i18n 键）。
 *
 * 用 `Record` 而不是原样透传，是为了让“新增一个 `AccountErrorCode`”在编译期就逼着
 * 这里同步，漏映射的码会直接以 kebab-case 原文露给客户端。
 */
const ACCOUNT_ERROR_CODES: Record<AccountErrorCode, string> = {
  "empty-label": "empty_label",
  "duplicate-label": "duplicate_label",
  "empty-routes": "empty_routes",
  "unknown-route": "unknown_route",
  "unusable-credential": "unusable_credential",
  "credential-kind-mismatch": "credential_kind_mismatch",
  "missing-derivation": "missing_derivation",
  "missing-jwt": "missing_jwt",
  "missing-api-key-pair": "missing_api_key_pair",
  "incomplete-team-identity": "incomplete_team_identity",
  "invalid-policy": "invalid_policy",
  "not-found": "account_not_found",
};

/**
 * 把账号域异常翻成稳定错误码。
 *
 * 不是账号域的异常**照旧抛**（不是吞掉）：那是真的 bug，HTTP 层会把它变成 500 +
 * `internal_error`，而“把 bug 伪装成一个正常拒绝”会让日志里什么都不剩。
 */
export function accountCommandError(err: unknown): ControlError {
  if (err instanceof AccountError) return { ok: false, error: ACCOUNT_ERROR_CODES[err.code] };
  if (err instanceof AccountUnavailableError) {
    // 只有 `account-unknown` 会从控制面命令冒出来：其余原因码都要求请求链路。
    return { ok: false, error: err.code === "account-unknown" ? "account_not_found" : err.code };
  }
  throw err;
}

/**
 * 风控可见性报告（控制面必须能回答的六问）。
 *
 * 每条都是**现算**：不缓存、不落盘（动态状态不落盘），因为冷却与在飞数都是
 * 瞬时事实，一份缓存下来的报告只会比页面晚一拍地骗人。
 */
export function buildRiskReport(broker: Broker, accounts: readonly Account[], ctx: HandlerContext): RiskReport {
  // R1 适用于所有账号：凭据只剩套餐一类，每个账号都有身份面。
  const identified = accounts.filter(
    (account): account is PlanAccount => account.credential.kind === "zhipu-account",
  );
  const byDeviceMid = new Map<string, string[]>();
  for (const account of identified) {
    const deviceMid = account.credential.identity.deviceMid;
    const labels = byDeviceMid.get(deviceMid);
    if (labels) labels.push(account.label);
    else byDeviceMid.set(deviceMid, [account.label]);
  }
  const conflicts = [...byDeviceMid.entries()]
    .filter(([, labels]) => labels.length > 1)
    .map(([deviceMid, labels]) => ({ deviceMid, labels }));

  const failures: RiskReport["failures"] = [];
  const perAccount: { label: string; inflight: number }[] = [];
  const alerts: RiskAlert[] = [];
  for (const account of accounts) {
    let inflight = 0;
    for (const route of account.routes) {
      inflight += broker.leases.inflight(account.id, route);
      const state = broker.health.status(account.id, route);
      if (state.status === "ok") continue;
      failures.push({
        label: account.label,
        route,
        status: state.status,
        ...(state.reason !== undefined ? { reason: state.reason } : {}),
        ...(state.until !== undefined ? { until: state.until } : {}),
      });
      const alert: RiskAlert = state.status === "drained" ? "account_drained" : "account_cooling";
      if (!alerts.includes(alert)) alerts.push(alert);
    }
    perAccount.push({ label: account.label, inflight });
    if (effectivePolicyOf(account, ctx).maxConcurrency > R11_CONCURRENCY_WARN_THRESHOLD) {
      if (!alerts.includes("concurrency_above_r11")) alerts.push("concurrency_above_r11");
    }
  }

  if (conflicts.length > 0) alerts.push("device_mid_shared");

  const report: RiskReport = {
    deviceMid: { accounts: identified.length, conflicts },
    sessions: {
      bound: broker.bindings.size(),
      capacity: broker.stickiness.maxSessions,
      // 恒为 0 的依据见 `RiskReport.sessions.crossAccount` 的注释（血缘表按账号分键 +
      // sessionId 生成种子带账号）。
      crossAccount: 0,
    },
    inflight: {
      total: broker.leases.totalInflight(),
      limit: broker.routing.maxTotalInflight,
      queueDepth: broker.leases.queueDepth(),
      perAccount,
    },
    failures,
    alerts,
  };
  pushCrossAccountAlert(report.alerts, report.sessions.crossAccount);
  return report;
}

/**
 * R2 的可观测契约：`crossAccount` 今天结构上恒 0（依据见
 * `RiskReport.sessions.crossAccount` 的注释），但「一旦非 0 就浮成告警」必须钉在
 * 代码里而不是注释里——血缘/粘性表将来被打穿时面板不许沉默。单独成函数是为了让
 * 这条契约本身可测，也让 buildRiskReport 的接线只有一行。
 */
export function pushCrossAccountAlert(alerts: RiskAlert[], crossAccount: number): void {
  if (crossAccount > 0 && !alerts.includes("session_cross_account")) {
    alerts.push("session_cross_account");
  }
}
