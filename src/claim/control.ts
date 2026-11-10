/**
 * claim 的控制面：`getClaimOverview` / `previewClaimPlans` / `claimNow` /
 * `listClaimPlanChoices` 四条控制命令的实现，面板（`/api/control`）与 CLI 转发
 * 共用同一份 dispatcher。
 *
 * 命令实现住在这里而不是 `control/control.ts`：命令表是跨进程契约，那边只做分发
 * 与包络；领取的领域逻辑（client 造法、captcha 门、hold 联动）在 `claim/` 里。
 * `control.ts` 经由 `HandlerContext` 的可选钩子进来，不 import 本文件。
 *
 * `getClaimOverview` 纯内存读，可随面板轮询；`previewClaimPlans` 与
 * `listClaimPlanChoices` 实时调该账号的发现层，仅手动/进屏触发，永不定时轮询；
 * `claimNow` 单次动作，结果与自动循环走同一份 `noteOutcome` 回灌语义。
 *
 * `claimNow` 是 L2 写命令、无需二次确认：重复领取被上游 `already_claimed` 拒掉，
 * 最坏结果只是多一次被拒的请求；它不改代理行为，只给账号加额度。
 */
import { accountSupportsSurface } from "../accounts/capability.js";
import type { AccountManager } from "../accounts/manager.js";
import type { ClaimOpeningConfig, ProxyConfig } from "../config/types.js";
import type { Account } from "../accounts/types.js";
import type { ClaimablePlan, ClaimOutcome } from "./types.js";
import { ClaimPreviewError, createClaimClient } from "./client.js";
import { buildClaimActions, type ClaimActions, type ClaimAutoClaim } from "./runtime.js";
import type { ClaimSchedulerStatus } from "./scheduler.js";
import { activityLedger, type ActivityLedger, type ActivityLedgerState } from "./ledger.js";
import { decideOutcome, noteOutcomeInLedger, outcomeRuleFor } from "./policy.js";

/** 钩子结果：`ok:false` 携带稳定码（面板翻译表按它出文案）。*/
export type ClaimHookResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message?: string };

export interface ClaimOverviewPayload {
  config: ClaimConfigSummary;
  accounts: ClaimAccountStatus[];
}

/** 配置快照（面板只读展示）。 */
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

export interface ClaimAccountStatus {
  label: string;
  running: boolean;
  stopped?: boolean;
  holdUntil?: number;
  planHolds?: Record<string, ClaimAccountPlanHold>;
  /** 台账状态与下一次检查/开抢时刻；每行不再只报瞬时 scheduler 状态。 */
  ledgerState?: ActivityLedgerState;
  nextCheckAt?: number;
  openingAt?: number;
  userAction?: string;
  alarms?: ClaimSchedulerStatus["alarms"];
  last?: ClaimAccountLastTick;
}

export interface ClaimAccountPlanHold {
  until: number;
  reason: string;
  userAction?: string;
}

export interface ClaimAccountLastTick {
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

/** 设置页活动选择器的一个选项：发现层字段 + 台账状态，绝不含 `raw`。 */
export interface ClaimPlanChoice {
  planId: string;
  name: string;
  description?: string;
  source?: string;
  priority?: number;
  startsAt?: number;
  endsAt?: number;
  effectiveAt?: number;
  /** 今天该账号在这个活动上的台账状态；没有记录时不出现。 */
  ledgerState?: ActivityLedgerState;
  /** 策略表给面板的用户动作；没有记录时不出现。 */
  userAction?: string;
}

export interface ClaimPlanChoicesPayload {
  accountLabel?: string;
  plans: ClaimPlanChoice[];
}

export interface ClaimControlDeps {
  config: ProxyConfig;
  accounts: AccountManager;
  getAutoClaim(): ClaimAutoClaim | null;
  /** 领取动作的造法（注入点，测试替身）：缺省用真的 `buildClaimActions`。 */
  buildActions?: (config: ProxyConfig, account: Account) => ClaimActions;
  /** 发现层注入点：缺省按账号自己的凭据、版本与出口造 client。 */
  discover?: (config: ProxyConfig, account: Account) => Promise<ClaimDiscoveryLike>;
  /** 台账注入点：缺省用进程共享的落盘台账。 */
  ledger?: ActivityLedger;
  /** 当前时间注入点（测试用）。 */
  now?: () => number;
}

/** 发现层的最小面：只取合并后的活动清单。 */
export interface ClaimDiscoveryLike {
  activities: ClaimablePlan[];
}

export interface ClaimControlHooks {
  getOverview(): Promise<ClaimHookResult<ClaimOverviewPayload>>;
  previewPlans(accountLabel: string): Promise<ClaimHookResult<ClaimablePlan[]>>;
  listPlanChoices(): Promise<ClaimHookResult<ClaimPlanChoicesPayload>>;
  claimNow(accountLabel: string, planId: string): Promise<ClaimHookResult<ClaimOutcome>>;
}

/** 默认发现层：与该账号的其它 claim 请求用同一份凭据、版本与出口。 */
function defaultDiscovery(opts: {
  origin: string;
  appVersion: string;
  platform: string;
  jwt?: string;
  deviceMid?: string;
  egress?: unknown;
}): Promise<ClaimDiscoveryLike> {
  return createClaimClient({
    origin: opts.origin,
    jwt: opts.jwt,
    appVersion: opts.appVersion,
    platform: opts.platform,
    deviceMid: opts.deviceMid,
    marketingDeviceMid: opts.deviceMid,
    ...(opts.egress ? { egress: opts.egress as never } : {}),
  }).discoverActivities();
}

function claimCapableAccount(accounts: Awaited<ReturnType<AccountManager["list"]>>, label: string) {
  return accounts.find((account) => account.label === label && accountSupportsSurface(account, "claim"));
}

/** 任挑一个可领账号；停用账号排在后面。 */
function pickClaimAccount(accounts: Awaited<ReturnType<AccountManager["list"]>>) {
  const capable = accounts.filter((account) => accountSupportsSurface(account, "claim"));
  return capable.find((account) => account.enabled) ?? capable[0];
}

/** 活动 → 选择器选项：只留选择器要读的字段，空描述不占位。 */
function toChoice(plan: ClaimablePlan, ledgerState?: ActivityLedgerState): ClaimPlanChoice {
  return {
    planId: plan.planId,
    name: plan.name,
    ...(plan.description ? { description: plan.description } : {}),
    ...(plan.source !== undefined ? { source: plan.source } : {}),
    ...(typeof plan.priority === "number" ? { priority: plan.priority } : {}),
    ...(typeof plan.startsAt === "number" ? { startsAt: plan.startsAt } : {}),
    ...(typeof plan.endsAt === "number" ? { endsAt: plan.endsAt } : {}),
    ...(typeof plan.effectiveAt === "number" ? { effectiveAt: plan.effectiveAt } : {}),
    ...(ledgerState !== undefined ? { ledgerState } : {}),
  };
}

/** 上游失败 → 稳定码：preview 的 HTTP 状态是唯一能区分的信号。 */
function previewError(err: unknown): { ok: false; code: string; message?: string } {
  if (err instanceof ClaimPreviewError) {
    return {
      ok: false,
      code: err.status === 429 ? "claim_rate_limited" : "claim_preview_failed",
      ...(err.status !== undefined ? { message: `preview HTTP ${err.status}` } : {}),
    };
  }
  return { ok: false, code: "claim_preview_failed", message: (err as Error).message };
}

const DEFAULT_OPENING: ClaimOpeningConfig = {
  preheatMs: 180000,
  probeIntervalMs: 10000,
  burstIntervalMs: 2000,
  burstWindowMs: 180000,
  accountStaggerMs: 200,
  maxClaimsPerAccount: 6,
};

export function createClaimControl(deps: ClaimControlDeps): ClaimControlHooks {
  const { config, accounts, getAutoClaim } = deps;
  const buildActions = deps.buildActions ?? buildClaimActions;
  const ledger = deps.ledger ?? activityLedger;
  const now = deps.now ?? Date.now;
  const discover = deps.discover ?? ((cfg: ProxyConfig, account: Account) => defaultDiscovery({
    origin: cfg.claim.origin,
    appVersion: cfg.identity.appVersion,
    platform: `${process.platform}-${process.arch}`,
    jwt: account.credential.kind === "zhipu-account" ? account.credential.jwt : undefined,
    deviceMid: account.credential.identity.deviceMid,
    egress: undefined,
  }));

  function schedulerFor(accountId: string): ClaimSchedulerStatus | null {
    const entry = getAutoClaim()?.runtimes.find((runtime) => runtime.accountId === accountId);
    if (!entry || typeof entry.scheduler.status !== "function") return null;
    return entry.scheduler.status();
  }

  function toRow(account: Account, running: boolean, status: ClaimSchedulerStatus | null, atMs: number): ClaimAccountStatus {
    if (!status) {
      const row: ClaimAccountStatus = { label: account.label, running: false };
      const entries = ledger.forAccount(account.id, atMs);
      const state = entries.find((entry) => ledger.state(entry, atMs) !== undefined);
      if (state) row.ledgerState = ledger.state(state, atMs);
      return row;
    }
    const planHolds: Record<string, ClaimAccountPlanHold> = {};
    for (const [planId, hold] of Object.entries(status.planHolds)) {
      planHolds[planId] = { until: hold.until, reason: hold.reason, ...(hold.userAction ? { userAction: hold.userAction } : {}) };
    }
    const last = status.last;
    const entries = ledger.forAccount(account.id, atMs);
    const state = entries.find((entry) => ledger.state(entry, atMs) !== undefined);
    const row: ClaimAccountStatus = {
      label: account.label,
      running,
      ...(status.stopped ? { stopped: true } : {}),
      holdUntil: status.holdUntilMs,
      planHolds,
      ...(state ? { ledgerState: ledger.state(state, atMs) } : {}),
      ...(status.nextCheckAtMs !== undefined
        ? { nextCheckAt: status.nextCheckAtMs }
        : {}),
      ...(status.nextOpeningAtMs !== undefined ? { openingAt: status.nextOpeningAtMs } : {}),
      ...(status.alarms ? { alarms: status.alarms } : {}),
      ...(last ? { userAction: last.userAction } : {}),
      ...(last
        ? {
            last: {
              at: last.at,
              action: last.action,
              source: last.source,
              ...(last.planId !== undefined ? { planId: last.planId } : {}),
              ...(last.failureKind !== undefined ? { failureKind: last.failureKind } : {}),
              ...(last.code !== undefined ? { code: last.code } : {}),
              ...(last.message !== undefined ? { message: last.message } : {}),
              ...(last.startsAt !== undefined ? { startsAt: last.startsAt } : {}),
              ...(last.endsAt !== undefined ? { endsAt: last.endsAt } : {}),
              ...(last.holdSource !== undefined ? { holdSource: last.holdSource } : {}),
              ...(last.waitReason !== undefined ? { waitReason: last.waitReason } : {}),
              ...(last.reason !== undefined ? { reason: last.reason } : {}),
              ...(last.userAction !== undefined ? { userAction: last.userAction } : {}),
            },
          }
        : {}),
    };
    return row;
  }

  async function getOverview(): Promise<ClaimHookResult<ClaimOverviewPayload>> {
    const list = await accounts.list();
    const auto = getAutoClaim();
    const atMs = now();
    const rows: ClaimAccountStatus[] = [];
    for (const account of list) {
      if (!accountSupportsSurface(account, "claim")) continue;
      rows.push(toRow(account, auto?.runtimes.some((r) => r.accountId === account.id) === true, schedulerFor(account.id), atMs));
    }
    const claim = config.claim;
    return {
      ok: true,
      value: {
        config: {
          enabled: claim.enabled,
          auto: claim.auto,
          origin: claim.origin,
          pollIntervalMs: claim.pollIntervalMs,
          cooldownMs: claim.cooldownMs,
          sprintWindowMs: claim.sprintWindowMs,
          sprintPollIntervalMs: claim.sprintPollIntervalMs,
          policy: claim.policy ?? "upstream-priority",
          opening: claim.opening ?? DEFAULT_OPENING,
        },
        accounts: rows,
      },
    };
  }

  async function previewPlans(accountLabel: string): Promise<ClaimHookResult<ClaimablePlan[]>> {
    const account = claimCapableAccount(await accounts.list(), accountLabel);
    if (!account) return { ok: false, code: "account_not_found" };
    try {
      const { activities } = await buildActions(config, account).discoverActivities();
      return { ok: true, value: activities };
    } catch (err) {
      return previewError(err);
    }
  }

  /** 选项集合来自发现层；台账只提供当天的状态标注，不过滤、不凭空造选项。 */
  async function listPlanChoices(): Promise<ClaimHookResult<ClaimPlanChoicesPayload>> {
    const account = pickClaimAccount(await accounts.list());
    if (!account) return { ok: true, value: { plans: [] } };
    try {
      const result = await discover(config, account);
      const atMs = now();
      const plans = result.activities.map((plan) => {
        const entry = ledger.get(account.id, plan.planId, atMs);
        return {
          ...toChoice(plan, ledger.state(entry, atMs)),
          ...(entry?.lastOutcome ? { userAction: outcomeRuleFor(entry.lastCode ?? entry.lastOutcome).userAction } : {}),
        };
      });
      return { ok: true, value: { accountLabel: account.label, plans } };
    } catch (err) {
      return previewError(err);
    }
  }

  /** 手动结果写台账 + policy hold，并用同一个 `noteOutcome` 回灌自动循环。 */
  async function noteOutcome(account: Account, target: ClaimablePlan, outcome: ClaimOutcome): Promise<void> {
    const atMs = now();
    const decision = decideOutcome(outcome, {
      nowMs: atMs,
      pollIntervalMs: config.claim.pollIntervalMs,
      ...(target.endsAt !== undefined ? { endsAtMs: target.endsAt * 1000 } : {}),
    });
    await noteOutcomeInLedger(ledger, account.id, target.planId, outcome, {
      ...(target.startsAt !== undefined ? { alarmAt: target.startsAt * 1000 } : {}),
      ...(target.effectiveAt !== undefined ? { effectiveAt: target.effectiveAt * 1000 } : {}),
      ...(target.endsAt !== undefined ? { expiresAt: target.endsAt * 1000 } : {}),
      holdUntil: decision.holdUntil,
    }, atMs);
    const entry = getAutoClaim()?.runtimes.find((runtime) => runtime.accountId === account.id);
    if (entry && typeof entry.scheduler.noteOutcome === "function") {
      entry.scheduler.noteOutcome(outcome, { plan: target });
    }
  }

  async function claimNow(accountLabel: string, planId: string): Promise<ClaimHookResult<ClaimOutcome>> {
    const account = claimCapableAccount(await accounts.list(), accountLabel);
    if (!account) return { ok: false, code: "account_not_found" };
    if (typeof planId !== "string" || planId.trim() === "") return { ok: false, code: "claim_plan_not_listed" };
    const actions = buildActions(config, account);

    // 双面 plan 校验：先确认目标在当前可领列表里，不在就不发 claim POST。
    let plans: ClaimablePlan[];
    try {
      plans = (await actions.discoverActivities()).activities;
    } catch (err) {
      return previewError(err);
    }
    const target = plans.find((plan) => plan.planId === planId.trim());
    if (!target) return { ok: false, code: "claim_plan_not_listed" };

    let outcome: ClaimOutcome;
    try {
      outcome = await actions.claim(target.planId);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const code = /captcha/i.test(message) ? "claim_captcha_unavailable" : "claim_request_failed";
      return { ok: false, code, ...(message ? { message } : {}) };
    }
    await noteOutcome(account, target, outcome);
    return { ok: true, value: outcome };
  }

  return { getOverview, previewPlans, listPlanChoices, claimNow };
}
