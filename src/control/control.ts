/**
 * 控制面的命令表：一条命令做什么。
 *
 * 命令表的分发语义、登录/账号收口的三个辅助、进程内 dispatcher 与测试入口都在
 * 这；协议形状在 `control-types.ts` / `control-views.ts`，HTTP 在
 * `control-transport.ts`，策略写侧在 `control-policy.ts`，只读聚合在
 * `control-report.ts`。依赖是单向的，其余五个都不 import 本文件；`dispatch` 从这里
 * 注入传输层与测试入口，理由见 `control-transport.ts` 文件头。
 *
 * 命令表是控制面契约：网页面板、CLI 转发、`serve` 的回环监听三个消费者都按
 * `ControlCommand` 发请求，加一条命令要三处同步（都在本仓内，改完一起过测试）。
 */
import { enrollCredential } from "../accounts/enroll.js";
import { AccountManager } from "../accounts/manager.js";
import { buildAccountCredential, exportAccounts, importAccounts } from "../accounts/transfer.js";
import { DEFAULT_MAX_CONCURRENCY, DEFAULT_WEIGHT } from "../accounts/types.js";
import type { Account } from "../accounts/types.js";
import {
  idPrefix,
  isNonNegativeInteger,
  isPositiveInteger,
  labelOf,
  summarizeAccount,
} from "../accounts/summary.js";
import { AuthCodeOAuthClient, createPollOAuthClient } from "../auth/oauth.js";
import type { OAuthFlowClient } from "../auth/oauth.js";
import { KeyResolver } from "../auth/resolver.js";
import type { Credential } from "../auth/types.js";
import { detectInstalledApp } from "../identity/app-version.js";
import { applyRoutingPolicy, routingSnapshot } from "./control-policy.js";
import {
  R11_CONCURRENCY_WARN_THRESHOLD,
  accountCommandError,
  apiKeysOf,
  buildRiskReport,
  proxiesReply,
  proxyCommandError,
} from "./control-report.js";
import { createControlTestEntries } from "./control-transport.js";
import type {
  ControlCommand,
  ControlResponse,
  HandlerContext,
} from "./control-types.js";
import { DEFAULT_REQUESTS_LIMIT } from "./control-types.js";
import { OAUTH_STATUS_TTL_MS } from "./control-views.js";
import type { ControlState, OAuthStatus } from "./control-views.js";
import { logger } from "../log/index.js";
import { redactRequestRecord, REQUEST_HISTORY_PAGE_LIMIT, REQUEST_HISTORY_PAGE_MAX } from "../proxy/request-log.js";

/**
 * 控制面的日志。
 *
 * 只记运行期事件（登录流程结束、代理删除后的残留引用），不记命令应答本身：
 * 那些走 `ControlResponse`，是协议不是日志。
 */
const log = logger("control");

/**
 * 类型与常量经本文件再导出：调用方按 `control/control.js` 一处 import 就能拿到
 * 命令表与全部协议类型，不用逐个记住它们各自住在哪个文件。
 */
export * from "./control-types.js";
export * from "./control-views.js";
/** `accounts/transfer.ts` 从这里拿它，实现已搬到 `control-report.ts`。*/
export { accountCommandError } from "./control-report.js";

/**
 * 读当前流程状态，超过 {@link OAUTH_STATUS_TTL_MS} 的按「没有」处理。
 *
 * 只有轮询接口读它：面板注入这个函数而不是自己去读 `ControlState`（状态对象在
 * `bootstrap.ts` 手里），过期判断因此只有一处。
 */
export function readOauthStatus(state: ControlState, now: number = Date.now()): OAuthStatus | undefined {
  const status = state.oauthStatus;
  if (status === undefined) return undefined;
  return now - status.updatedAt > OAUTH_STATUS_TTL_MS ? undefined : status;
}

/**
 * Build an in-process dispatcher for the control protocol: identical command
 * semantics to `POST /control`, but no listener and no loopback check — the
 * caller owns its transport and must guard it (token, origin, size limits).
 *
 * Embedders that already expose their own authenticated HTTP surface (the
 * `serve` web panel) use this instead, so a reachable panel does not also open
 * a second, unauthenticated port that can run removeAccount / shutdown.
 */
export function createControlDispatcher(
  state: ControlState,
  ctx: HandlerContext,
): (cmd: ControlCommand) => Promise<ControlResponse> {
  return (cmd) => dispatch(cmd, state, ctx);
}

/**
 * 两个测试入口（旧签名）。装配在 `control-transport.ts`：它做的是「造一个
 * `HandlerContext`，走一遍 handleControlRequest」，命令表由这里注入。
 */
export const { handleControlRequestForTest, handleControlRequestWithHooksForTest } =
  createControlTestEntries(dispatch);

/**
 * 授权回调地址的端口：空地址回 0（轮询式登录没有本地回调，两处同义），
 * 地址不带显式端口回 80（https 默认），地址本身解析不了也回 0——内置客户端
 * 的 callbackUrl 是自己刚拼好的合法地址，这条分支只防注入客户端给了坏值。
 */
function parseCallbackPort(callbackUrl: string): number {
  if (callbackUrl === "") return 0;
  try {
    return Number(new URL(callbackUrl).port) || 80;
  } catch {
    return 0;
  }
}

async function dispatch(
  cmd: ControlCommand,
  state: ControlState,
  ctx: HandlerContext,
): Promise<ControlResponse> {
  switch (cmd.cmd) {
    case "status": {
      // 运行状态，不是「哪个账号是默认」：多账号下后者不存在。`loggedIn`
      // 的含义是「至少有一个账号」，面板的登录门槛读它。
      const count = (await ctx.accounts.list().catch(() => [])).length;
      return {
        ok: true,
        state: "running",
        accounts: count,
        proxyPort: state.proxyPort,
        loggedIn: count > 0,
      };
    }

    case "startOAuth": {
      // Tear down any previous in-flight flow so its callback port is released.
      if (state.activeOauth) {
        await state.activeOauth.client.close().catch(() => {});
        state.activeOauth = undefined;
      }
      // 上一条流程已经关掉，它的状态也不再代表任何在飞的东西：页面下一次轮询拿到
      // `idle`，而不是一条已经死掉的 `pending`。`start()` 抛错时同样保持 `idle`。
      state.oauthStatus = undefined;
      // Both providers use the server-mediated poll login (ZCode 3.12.3
      // default) — no local callback; the flow completes server-side.
      const client: OAuthFlowClient = ctx.createLoginClient
        ? ctx.createLoginClient(cmd.provider)
        : createPollOAuthClient(cmd.provider, ctx.identityAppVersion);
      const started = await client.start();
      const callbackPort = parseCallbackPort(started.callbackUrl);
      state.activeOauth = {
        client,
        callbackUrl: started.callbackUrl,
        state: started.state,
      };
      const startedAt = Date.now();
      state.oauthStatus = { flowId: started.state, phase: "pending", startedAt, updatedAt: startedAt };
      client.complete(started).then(async (tokens) => {
        const resolver = ctx.keyResolver ?? new KeyResolver();
        const cred: Credential = await resolver.resolveCodingPlanCredential(tokens.accessToken, cmd.provider, tokens.userId);
        if (tokens.jwt) cred.jwt = tokens.jwt;
        const account = await upsertAccount(ctx.accounts, cred, cmd.provider);
        settleOauthStatus(state, started.state, { phase: "ready", accountLabel: account.label });
        log.info("oauth completed", { provider: cmd.provider });
      }).catch((err: unknown) => {
        // Timeouts / rejections are expected when the user abandons the
        // browser; the login modal shows this message.
        const message = (err as Error)?.message ?? String(err);
        settleOauthStatus(state, started.state, { phase: "failed", error: message });
        log.warn("oauth flow ended without success", { message });
      }).finally(() => {
        // MUST run on rejection too — otherwise the callback port leaks until
        // process death.
        void client.close().catch(() => {});
        if (state.activeOauth?.state === started.state) state.activeOauth = undefined;
      });
      return {
        ok: true,
        event: "oauthUrl",
        authorizeUrl: started.authorizeUrl,
        callbackPort,
        flowId: started.state,
      };
    }

    case "deliverOAuthCode": {
      const active = state.activeOauth;
      // Code delivery only applies to callback-based (auth-code) flows — the
      // Z.AI cli login completes via server polling and has no code to deliver.
      if (!(active?.client instanceof AuthCodeOAuthClient) || active.state !== cmd.state) {
        return { ok: false, error: "no_matching_oauth_flow" };
      }
      try {
        const { accessToken, userId, jwt } = await active.client.exchangeCode(
          cmd.code,
          active.callbackUrl,
          cmd.state,
        );
        const resolver = ctx.keyResolver ?? new KeyResolver();
        const cred: Credential = await resolver.resolveCodingPlanCredential(accessToken, cmd.provider, userId);
        if (jwt) cred.jwt = jwt;
        const account = await upsertAccount(ctx.accounts, cred, cmd.provider);
        settleOauthStatus(state, cmd.state, { phase: "ready", accountLabel: account.label });
        state.activeOauth = undefined;
        await active.client.close().catch(() => {});
        return { ok: true, event: "loginOk", provider: cmd.provider };
      } catch (err) {
        // 这条流程的 `complete()` 还在等回调，最终会以超时 reject；终态写一次就够，
        // `settleOauthStatus` 只在相位还是 `pending` 时才写。
        settleOauthStatus(state, cmd.state, { phase: "failed", error: (err as Error).message });
        state.activeOauth = undefined;
        await active.client.close().catch(() => {});
        return { ok: false, error: `oauth_exchange_failed: ${(err as Error).message}` };
      }
    }

    case "getLogs": {
      const since = typeof cmd.since === "number" ? cmd.since : 0;
      const { nextSince, lines } = ctx.logBuffer.since(since);
      return { ok: true, event: "logs", nextSince, lines: [...lines] };
    }

    case "getRequests": {
      // 读内存，与面板的 `request` 事件同源（三个读取方之一）。CLI 不走这条路：
      // 它是另一个进程，读不到这里的 store，所以读 `requests.jsonl`（`cli/logs.ts`）。
      if (!ctx.requests) return { ok: false, error: "request_store_unavailable" };
      const limit = isPositiveInteger(cmd.limit) ? cmd.limit : DEFAULT_REQUESTS_LIMIT;
      return { ok: true, event: "requests", records: ctx.requests.recent(limit) };
    }

    case "getRequestsHistory": {
      // 数据源是 requests.jsonl（全量保留），不是内存仓：内存只有最近
      // REQUEST_STORE_CAPACITY 条，「昨天/上周」的记录只能从这里翻。CLI 不接这个
      // 钩子（与 getRequests 同一条纪律），读历史用 `logs`。
      if (!ctx.requestHistory) return { ok: false, error: "request_history_unavailable" };
      const limit = isPositiveInteger(cmd.limit)
        ? Math.min(cmd.limit, REQUEST_HISTORY_PAGE_MAX)
        : REQUEST_HISTORY_PAGE_LIMIT;
      // 游标是时间戳：0 / 负数 / 非有限数都不是合法的 startedAt，按缺省（最新）处理。
      const before =
        typeof cmd.before === "number" && Number.isFinite(cmd.before) && cmd.before > 0 ? cmd.before : undefined;
      const page = await ctx.requestHistory({ before, limit });
      // 防御性打码（对照 dump 的纪律）：记录本不该有密钥，出门前过一遍正则。
      return {
        ok: true,
        event: "requestsHistory",
        requests: page.requests.map(redactRequestRecord),
        hasMore: page.hasMore,
      };
    }

    case "getUsageStats": {
      // 数据源同样是 requests.jsonl：单遍倒序流式聚合，每次现算，不落缓存。
      // CLI 不接这个钩子（与 getRequestsHistory 同一条纪律）；serve 的入口透传
      // `computeUsageStats`。`from` / `to` 的合法性判定在聚合器里
      // （非有限数 / ≤ 0 按缺省不限处理），dispatcher 只透传。
      if (!ctx.usageStats) return { ok: false, error: "usage_stats_unavailable" };
      const from = typeof cmd.from === "number" ? cmd.from : undefined;
      const to = typeof cmd.to === "number" ? cmd.to : undefined;
      const stats = await ctx.usageStats({ from, to });
      // 统计里只有账号 label 这类用户自起的引用名（与 listAccounts 同级暴露），
      // 没有凭据或报文，不需要过 redactRequestRecord 那一层。
      return { ok: true, event: "usageStats", stats };
    }

    case "quota": {
      // 带 `labels`：顶栏刷新的分级采，走同一个 sampleNow 入口与 30s 去重。
      // 带 `label`：控制面「立即刷新」那个账号（详情卡的刷新按钮，必采路径）。
      // 两者都不带快照——面板成功后自己回读 /api/state，数据从那侧更新。
      const label = typeof cmd.label === "string" ? cmd.label.trim() : "";
      if (Array.isArray(cmd.labels)) {
        if (!ctx.refreshQuotaScoped) return { ok: false, error: "quota_unavailable" };
        const focused = typeof cmd.focusedLabel === "string" ? cmd.focusedLabel.trim() : undefined;
        const decision = await ctx.refreshQuotaScoped(cmd.labels, focused);
        return { ok: true, event: "quotaRefreshScoped", decision };
      }
      if (label !== "") {
        if (!ctx.refreshQuota) return { ok: false, error: "quota_unavailable" };
        try {
          await ctx.refreshQuota(label);
          return { ok: true, event: "quotaRefreshed" };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      }
      // Snapshot build hits both upstream quota planes (billing + monitor);
      // a failure (e.g. not logged in) surfaces verbatim as the envelope error
      // so the app can render 点按重试 instead of an empty card.
      if (!ctx.onQuota) return { ok: false, error: "quota_unavailable" };
      try {
        const quota = await ctx.onQuota();
        return { ok: true, event: "quota", quota };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }

    case "getHealthObservation": {
      // 健康状态变化事件/熔断指示的纯内存读（同一批事件也落进 LogBuffer，
      // 这里给页面的是结构化字段，不用解析日志行）。没有 broker 的宿主回缺段而非空造。
      const broker = ctx.broker;
      if (!broker) return { ok: false, error: "account_control_unavailable" };
      return { ok: true, event: "healthObservation", observation: broker.healthEvents.snapshot() };
    }

    case "shutdown": {
      // 进程退出的时序在 `server/control-surface.ts`：先应答，再走与信号同一条路径。
      // 没接 `onShutdown` 的入口（CLI 的一次性 dispatcher）停不了进程，回成功会让
      // 调用方以为已经停了。
      if (!ctx.onShutdown) return { ok: false, error: "shutdown_unavailable" };
      await ctx.onShutdown();
      return { ok: true, event: "shuttingDown" };
    }

    // ---- 设置页「服务」组------------------------------------------------

    case "checkUpdate": {
      if (!ctx.onCheckUpdate) return { ok: false, error: "update_check_unavailable" };
      return { ok: true, event: "updateCheck", update: await ctx.onCheckUpdate() };
    }

    // ---- 设置页「身份」组------------------------------------------------

    case "detectAppVersion": {
      const detected = (ctx.onDetectAppVersion ?? detectInstalledApp)();
      return detected
        ? { ok: true, event: "appVersion", detected: detected.version, path: detected.path }
        : { ok: true, event: "appVersion", detected: null };
    }

    // ---- 账号 / 策略命令面----------------------------------------------

    case "listAccounts": {
      const broker = ctx.broker;
      if (!broker) return { ok: false, error: "account_control_unavailable" };
      const accounts = await ctx.accounts.list();
      const samples = ctx.quotaSamples ? ctx.quotaSamples() : [];
      return {
        ok: true,
        event: "accounts",
        accounts: accounts.map((account) => summarizeAccount(account, broker, ctx, samples)),
      };
    }

    case "addAccount": {
      const label = labelOf(cmd.label);
      if (!label) return { ok: false, error: "invalid_label" };
      const built = await buildAccountCredential(cmd, ctx);
      if (!built.ok) return built;
      try {
        // `add` 而不是 `enrollCredential`：label 由用户显式给出，撞名必须报错（
        // `duplicate_label`）而不是静默改成 `name-2`。同一凭据重复导入仍幂等（
        // id 是凭据指纹）。
        const account = await ctx.accounts.add({
          label,
          credential: built.credential,
          ...(cmd.routes ? { routes: cmd.routes } : {}),
        });
        return {
          ok: true,
          event: "accountAdded",
          label: account.label,
          idPrefix: idPrefix(account.id),
          routes: account.routes,
        };
      } catch (err) {
        return accountCommandError(err);
      }
    }

    case "removeAccount": {
      const label = labelOf(cmd.label);
      if (!label) return { ok: false, error: "invalid_label" };
      const account = await ctx.accounts.getByLabel(label);
      if (!account) return { ok: false, error: "account_not_found" };
      let aborted = 0;
      if (ctx.broker) {
        // 删除默认 drain（只停止派发，等在飞自然结束）；`drain: false` 才中止在飞。
        aborted = (
          await ctx.broker.setAccountEnabled(account.label, false, { drain: cmd.drain !== false })
        ).aborted;
        // 账号没了，它的动态状态 / 粘性 / 覆盖也不该留着：否则同名 label 重新导入时会
        // 继承上一个账号的禁用标记与冷却状态。
        ctx.broker.health.forgetAccount(account.id);
        ctx.broker.activity.forget(account.id);
        await ctx.broker.forgetAccountOverrides(account.label);
      }
      await ctx.accounts.remove(account.id);
      return { ok: true, event: "accountRemoved", label: account.label, aborted };
    }

    case "setAccountEnabled": {
      const broker = ctx.broker;
      if (!broker) return { ok: false, error: "account_control_unavailable" };
      const label = labelOf(cmd.label);
      if (!label) return { ok: false, error: "invalid_label" };
      if (typeof cmd.enabled !== "boolean") return { ok: false, error: "invalid_enabled" };
      const account = await ctx.accounts.getByLabel(label);
      if (!account) return { ok: false, error: "account_not_found" };
      try {
        const { aborted } = await broker.setAccountEnabled(account.label, cmd.enabled, {
          drain: cmd.force !== true,
        });
        // 持久化到账号记录（不是 config.yaml）：运行时覆盖只活在进程里，而
        // CLI 是一次性进程；不写回记录的话，`auth account disable` 一出进程就失效。
        // 账号自身的 `enabled` 正是优先级链的第三档，写它就是改"重启后的默认值"。
        await ctx.accounts.update(account.id, { enabled: cmd.enabled });
        return { ok: true, event: "accountEnabled", label: account.label, enabled: cmd.enabled, aborted };
      } catch (err) {
        return accountCommandError(err);
      }
    }

    case "setAccountConcurrency": {
      const broker = ctx.broker;
      if (!broker) return { ok: false, error: "account_control_unavailable" };
      const label = labelOf(cmd.label);
      if (!label) return { ok: false, error: "invalid_label" };
      if (!isNonNegativeInteger(cmd.maxConcurrency)) return { ok: false, error: "invalid_concurrency" };
      const account = await ctx.accounts.getByLabel(label);
      if (!account) return { ok: false, error: "account_not_found" };
      try {
        await broker.setAccountConcurrency(account.label, cmd.maxConcurrency);
        await ctx.accounts.update(account.id, { policy: { maxConcurrency: cmd.maxConcurrency } });
      } catch (err) {
        return accountCommandError(err);
      }
      // 超过并发阈值只警告（风控参数由用户拍板），不阻断。
      return {
        ok: true,
        event: "accountConcurrency",
        label,
        maxConcurrency: cmd.maxConcurrency,
        ...(cmd.maxConcurrency > R11_CONCURRENCY_WARN_THRESHOLD
          ? { warning: "concurrency_above_r11" as const }
          : {}),
      };
    }

    case "setAccountWeight": {
      const broker = ctx.broker;
      if (!broker) return { ok: false, error: "account_control_unavailable" };
      const label = labelOf(cmd.label);
      if (!label) return { ok: false, error: "invalid_label" };
      if (!isPositiveInteger(cmd.weight)) return { ok: false, error: "invalid_weight" };
      const account = await ctx.accounts.getByLabel(label);
      if (!account) return { ok: false, error: "account_not_found" };
      try {
        await broker.setAccountWeight(account.label, cmd.weight);
        await ctx.accounts.update(account.id, { policy: { weight: cmd.weight } });
      } catch (err) {
        return accountCommandError(err);
      }
      return { ok: true, event: "accountWeight", label: account.label, weight: cmd.weight };
    }

    case "resetAccountOverrides": {
      const broker = ctx.broker;
      if (!broker) return { ok: false, error: "account_control_unavailable" };
      const label = labelOf(cmd.label);
      if (!label) return { ok: false, error: "invalid_label" };
      const account = await ctx.accounts.getByLabel(label);
      if (!account) return { ok: false, error: "account_not_found" };
      try {
        const cleared = await broker.resetAccountOverrides(account.label);
        // 覆盖层是内存的，清掉之后生效值回落到"账号自身的 policy"。而
        // `setAccount*` 已经把那几个值落到账号记录上了，所以"复位"必须把记录也搬回
        // 默认值，否则用户清完覆盖看到的还是上次那个数字，等于命令没生效。
        await ctx.accounts.update(account.id, {
          enabled: true,
          policy: { weight: DEFAULT_WEIGHT, maxConcurrency: DEFAULT_MAX_CONCURRENCY },
        });
        return { ok: true, event: "accountOverridesReset", label: account.label, cleared };
      } catch (err) {
        return accountCommandError(err);
      }
    }

    case "getRoutingPolicy": {
      const broker = ctx.broker;
      if (!broker) return { ok: false, error: "routing_control_unavailable" };
      const snapshot = routingSnapshot(broker);
      return { ok: true, event: "routingPolicy", ...snapshot };
    }

    case "setRoutingPolicy": {
      const broker = ctx.broker;
      if (!broker) return { ok: false, error: "routing_control_unavailable" };
      const rejected = await applyRoutingPolicy(broker, cmd.routing, cmd.stickiness, cmd.risk);
      if (rejected) return rejected;
      const snapshot = routingSnapshot(broker);
      return { ok: true, event: "routingPolicy", ...snapshot };
    }

    case "getRiskReport": {
      const broker = ctx.broker;
      if (!broker) return { ok: false, error: "account_control_unavailable" };
      const accounts = await ctx.accounts.list();
      return { ok: true, event: "riskReport", report: buildRiskReport(broker, accounts, ctx) };
    }

    case "exportAccounts":
      return exportAccounts(cmd, ctx);

    case "importAccount":
      return importAccounts(cmd, ctx);

    // ---- 数据面 API key----------------------------------------------------
    case "listApiKeys":
      return { ok: true, event: "apiKeys", apiKeys: await apiKeysOf(ctx).list() };

    case "createApiKey": {
      const created = await apiKeysOf(ctx).create(typeof cmd.name === "string" ? cmd.name : "");
      if (!created.ok) return { ok: false, error: created.error };
      // 应答里的摘要不带 secret（ApiKeySummary 的规矩，见 control-types.ts）；明文
      // 走顶层的 `key`——创建弹窗的「显示一次」仪式。之后要明文走 `listApiKeys`
      // 的解密路径。
      return { ok: true, event: "apiKeyCreated", apiKey: created.record, key: created.key ?? "" };
    }

    case "setApiKeyEnabled": {
      if (typeof cmd.enabled !== "boolean") return { ok: false, error: "invalid_enabled" };
      const updated = await apiKeysOf(ctx).setEnabled(cmd.id, cmd.enabled);
      if (!updated.ok) return { ok: false, error: updated.error };
      return { ok: true, event: "apiKeyEnabled", apiKey: updated.record, enabled: cmd.enabled };
    }

    case "deleteApiKey": {
      const removed = await apiKeysOf(ctx).remove(cmd.id);
      if (!removed.ok) return { ok: false, error: removed.error };
      return { ok: true, event: "apiKeyDeleted", id: removed.id };
    }

    case "resetApiKeyUsage": {
      const reset = await apiKeysOf(ctx).resetUsage(cmd.id);
      if (!reset.ok) return { ok: false, error: reset.error };
      return { ok: true, event: "apiKeyUsageReset", apiKey: reset.record };
    }

    // ---- 出口代理表（热调节 / UI）-------------------------------------------

    case "listProxies":
      return proxiesReply(ctx);

    case "addProxy": {
      const broker = ctx.broker;
      if (!broker) return { ok: false, error: "proxy_control_unavailable" };
      const name = labelOf(cmd.name);
      if (!name) return { ok: false, error: "invalid_proxy_name" };
      if (typeof cmd.url !== "string") return { ok: false, error: "invalid_proxy_url" };
      try {
        broker.addProxy({
          name,
          url: cmd.url,
          ...(typeof cmd.username === "string" ? { username: cmd.username } : {}),
          ...(typeof cmd.password === "string" ? { password: cmd.password } : {}),
        });
      } catch (err) {
        // 代理域异常 → 稳定码；其余照旧抛（HTTP 层变成 500 + internal_error）。
        return proxyCommandError(err);
      }
      return proxiesReply(ctx);
    }

    case "setProxy": {
      const broker = ctx.broker;
      if (!broker) return { ok: false, error: "proxy_control_unavailable" };
      const name = labelOf(cmd.name);
      if (!name) return { ok: false, error: "invalid_proxy_name" };
      if (cmd.enabled !== undefined && typeof cmd.enabled !== "boolean") {
        return { ok: false, error: "invalid_enabled" };
      }
      if (cmd.url !== undefined && typeof cmd.url !== "string") {
        return { ok: false, error: "invalid_proxy_url" };
      }
      try {
        broker.updateProxy(name, {
          ...(typeof cmd.url === "string" ? { url: cmd.url } : {}),
          ...(typeof cmd.enabled === "boolean" ? { enabled: cmd.enabled } : {}),
          ...(typeof cmd.username === "string" ? { username: cmd.username } : {}),
          ...(typeof cmd.password === "string" ? { password: cmd.password } : {}),
        });
      } catch (err) {
        // 代理域异常 → 稳定码；其余照旧抛（HTTP 层变成 500 + internal_error）。
        return proxyCommandError(err);
      }
      return proxiesReply(ctx);
    }

    case "removeProxy": {
      const broker = ctx.broker;
      if (!broker) return { ok: false, error: "proxy_control_unavailable" };
      const name = labelOf(cmd.name);
      if (!name) return { ok: false, error: "invalid_proxy_name" };
      const force = cmd.force === true;
      let detached: string[] = [];
      try {
        detached = (await broker.removeProxy(name, force)).detached;
      } catch (err) {
        // 代理域异常 → 稳定码；其余照旧抛（HTTP 层变成 500 + internal_error）。
        return proxyCommandError(err);
      }
      // config.yaml 里的引用改不掉（那个文件没有写入口）：被 force 断开的账号
      // 在 YAML 里仍然指向这个名字，下次启动会在加载期报 unknown proxy。
      if (detached.length > 0) {
        log.warn("removed proxy may still be referenced by config.yaml", { proxy: name, accounts: detached });
      }
      const reply = await proxiesReply(ctx);
      // `force` 时把被改回默认的账号带回去：页面要拿它说「哪些账号换了出口」，
      // 而静默改出口是这里最危险的动作。
      if (!force || reply.ok !== true || !("event" in reply) || reply.event !== "proxies") return reply;
      return { ...reply, detached };
    }

    case "setAccountProxy": {
      const broker = ctx.broker;
      if (!broker) return { ok: false, error: "proxy_control_unavailable" };
      const label = labelOf(cmd.label);
      if (!label) return { ok: false, error: "invalid_label" };
      if (typeof cmd.proxy !== "string") return { ok: false, error: "invalid_proxy_name" };
      const account = await ctx.accounts.getByLabel(label);
      if (!account) return { ok: false, error: "account_not_found" };
      try {
        await broker.setAccountProxy(account.label, cmd.proxy);
      } catch (err) {
        // 代理域异常 → 稳定码；其余照旧抛（HTTP 层变成 500 + internal_error）。
        return proxyCommandError(err);
      }
      return { ok: true, event: "accountProxy", label: account.label, proxy: cmd.proxy.trim() };
    }

    // ---- 抢活动控制面---------------------------------------------------
    //
    // 实现在 `src/claim/control.ts`（钩子注入，缺省 = 没接 claim 的入口回
    // `claim_unavailable`）。钩子返回结果对象而不是抛错：稳定码在 claim 侧一处
    // 生成，这里只把它变成包络 —— 码不在这份文件里出现第二份定义，page.test
    // 的错误码扫描也因此不会漏接（`error.claim_*` 的翻译键在字典里成对）。

    case "getClaimOverview": {
      if (!ctx.onClaimOverview) return { ok: false, error: "claim_unavailable" };
      const result = await ctx.onClaimOverview();
      if (!result.ok) return claimHookError(result);
      return { ok: true, event: "claimOverview", config: result.value.config, accounts: result.value.accounts };
    }

    case "previewClaimPlans": {
      if (!ctx.onPreviewClaimPlans) return { ok: false, error: "claim_unavailable" };
      const result = await ctx.onPreviewClaimPlans(cmd.accountLabel);
      if (!result.ok) return claimHookError(result);
      return { ok: true, event: "claimPlans", label: cmd.accountLabel, plans: result.value };
    }

    case "listClaimPlanChoices": {
      if (!ctx.onListClaimPlanChoices) return { ok: false, error: "claim_unavailable" };
      const result = await ctx.onListClaimPlanChoices();
      if (!result.ok) return claimHookError(result);
      return { ok: true, event: "claimPlanChoices", ...result.value };
    }

    case "claimNow": {
      if (!ctx.onClaimNow) return { ok: false, error: "claim_unavailable" };
      const result = await ctx.onClaimNow(cmd.accountLabel, cmd.planId);
      if (!result.ok) return claimHookError(result);
      return { ok: true, event: "claimOutcome", label: cmd.accountLabel, outcome: result.value };
    }

    default:
      /* 稳定码 + 原文分离：码收窄成纯 `unknown_cmd`，命令名放 `message`。
       * 带后缀的串（`unknown_cmd: getFoo`）会让面板的 `errorText`（按 `error.` + 整串
       * 查表）必然 miss，`error.unknown_cmd` 的文案永远出不来；客户端只展示 `error`，
       * 不加后缀也不丢信息（message 对它是多余的未知字段，命令行脚本要细节时读它）。
       */
      return {
        ok: false,
        error: "unknown_cmd",
        message: `unknown command: ${(cmd as { cmd: string }).cmd}`,
      };
  }
}

/**
 * 把登录结果登记成账号。
 *
 * 单点收口：两条登录路径（server-poll 与 auth-code 回调）必须落到同一份
 * 账号语义上，否则同一次登录会因为走了哪条路而落成不同形态的账号。
 */
function upsertAccount(accounts: AccountManager, cred: Credential, label: string): Promise<Account> {
  return enrollCredential(accounts, cred, { label });
}

/**
 * 把当前流程写到终态（成功或失败）。
 *
 * 只在「还是同一次流程、而且还没结束」时生效。第二次 `startOAuth` 会关掉上一条
 * 流程，它的 `complete()` 随后 reject；没有这个判断，迟到的 `failed` 会盖掉新流程
 * 的 `pending`，页面就把一次正在跑的登录显示成失败。
 */
function settleOauthStatus(
  state: ControlState,
  flowId: string,
  outcome: { phase: "ready"; accountLabel: string } | { phase: "failed"; error: string },
): void {
  const current = state.oauthStatus;
  if (current?.flowId !== flowId || current.phase !== "pending") return;
  state.oauthStatus = { flowId, ...outcome, startedAt: current.startedAt, updatedAt: Date.now() };
}

/**
 * claim 钩子的失败 → 包络：稳定码进 `error`，细节进 `message`
 * （同一条纪律 —— 码要能进面板的翻译表，细节不污染码本身）。
 */
function claimHookError(result: { ok: false; code: string; message?: string }): { ok: false; error: string; message?: string } {
  return { ok: false, error: result.code, ...(result.message !== undefined ? { message: result.message } : {}) };
}

