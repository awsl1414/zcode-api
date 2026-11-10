/**
 * Auto-claim scheduler: one instance per account. Policy rows decide what a
 * claim result means and how long to hold; the opening channel turns any known
 * `startsAt` into an alarm that preheats before the drop and sends the first
 * claim at `T` (plus this account's millisecond stagger).
 *
 * Normal polling keeps the sha256 phase. Opening alarms use the ordinal phase,
 * so several accounts on one egress do not land minutes apart. Upstream 429s
 * extend the wake through the shared egress window and keep the alarm; a retry
 * goes out after the hold if the burst window is still open.
 *
 * Results (auto and manual) go through `noteOutcome`, which writes the
 * cross-restart ledger and the per-plan hold. Discovery facts, alarms, claimed
 * and exhausted states survive restarts. All timers are unref'd so a shutdown
 * can stop the group without a dangling handle holding the process open.
 */
import { createHash } from "node:crypto";
import type { ClaimFailureKind, ClaimDiscovery, ClaimOutcome, ClaimablePlan } from "./types.js";
import { ClaimPreviewError } from "./client.js";
import { createActivityLedger, type ActivityLedger } from "./ledger.js";
import type { ClaimRateLimitWindow } from "./rate-limit.js";
import type { LogLevel } from "../log/types.js";
import {
  captchaHoldUntilMs,
  decideOutcome,
  nextBeijingDayMs,
  noteOutcomeInLedger,
  outcomeRule,
  type OutcomeDecision,
} from "./policy.js";
import {
  DEFAULT_OPENING,
  advanceOpening,
  computeNextWake,
  openingAlarms,
  recordOpeningClaim,
  type OpeningAlarm,
  type OpeningPhase,
} from "./opening.js";
import type { ClaimOpeningConfig } from "../config/types.js";

export interface ClaimGateway {
  /** Merged enumeration: billing preview + marketing deliveries. Required: a
   * gateway without it would silently see one face and claim on half the facts. */
  discoverActivities(): Promise<ClaimDiscovery>;
  /** `captcha` omitted → claim without captcha headers. */
  claim(planId: string, captcha?: { verifyParam: string; region?: string }): Promise<ClaimOutcome>;
}

interface ClaimSchedulerConfig {
  pollIntervalMs: number;
  cooldownMs: number;
  /** End-of-window cadence, independent of the opening channel. */
  sprintWindowMs: number;
  sprintPollIntervalMs: number;
  opening?: ClaimOpeningConfig;
}

export interface ClaimSchedulerDeps {
  /** Account id: normal-poll phase and ledger key. */
  accountId?: string;
  /** Stable ordinal among accounts sharing an egress; opening phase source. */
  accountIndex?: number;
  rateLimit?: ClaimRateLimitWindow;
  getJwt(): Promise<string | undefined>;
  createClient(jwt: string): ClaimGateway;
  getCaptcha(): Promise<{ verifyParam: string; region?: string }>;
  captchaRequired?: () => Promise<boolean> | boolean;
  reportActivation?(): Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
  /** Health gate; a blocked account sends no requests this tick. */
  accountBlocked?: () => boolean;
  /** Account health/JWT/egress check during preheat. */
  preflight?(): Promise<void> | void;
  config: ClaimSchedulerConfig;
  ledger?: ActivityLedger;
  /** Structured fields let the panel show a user-facing reason without parsing log text. */
  log?: (message: string, level?: LogLevel, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

export type TickResult =
  | { action: "skipped_hold" }
  | { action: "stopped" }
  | { action: "idle" }
  | { action: "claimed"; planId: string; startsAt?: number; endsAt?: number }
  | { action: "failed"; outcome: Extract<ClaimOutcome, { ok: false }>; holdMs: number }
  | { action: "error"; message: string; holdMs: number; holdSource?: "retry-after" | "cooldown" };

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export type ClaimHoldReason = "claimed" | ClaimFailureKind;
export interface ClaimPlanHold {
  until: number;
  reason: ClaimHoldReason;
  /** Policy hint for the panel; undefined for the pre-policy shape. */
  userAction?: string;
}

export type ClaimWaitReason =
  | "waiting-start"
  | "per-plan-hold"
  | "not-listed"
  | "no-plans"
  | "not-deployed"
  | "expired"
  | "preheat"
  | "rate-limit"
  | "opening-window-ended";

export interface ClaimLastTick {
  at: number;
  action: TickResult["action"];
  source: "auto" | "manual";
  planId?: string;
  failureKind?: ClaimFailureKind;
  code?: number | string;
  message?: string;
  startsAt?: number;
  endsAt?: number;
  holdSource?: "retry-after" | "cooldown";
  waitReason?: ClaimWaitReason;
  reason?: string;
  userAction?: string;
}

export interface ClaimAlarmView {
  planId: string;
  startsAt: number;
  effectiveAtMs?: number;
  expiresAtMs?: number;
  preheatAtMs: number;
  claimAtMs: number;
  burstEndsAtMs: number;
  staggerMs: number;
  phase: OpeningPhase;
  preparedAtMs?: number;
  claims: number;
  reason?: string;
}

export interface ClaimSchedulerStatus {
  stopped: boolean;
  holdUntilMs: number;
  phaseMs: number;
  /** Deterministic millisecond phase used inside opening windows. */
  openingPhaseMs?: number;
  planHolds: Record<string, ClaimPlanHold>;
  /** Registered opening alarms, including their next claim and preheat times. */
  alarms?: ClaimAlarmView[];
  /** Earliest scheduled next check, including policy holds and alarms. */
  nextCheckAtMs?: number;
  nextOpeningAtMs?: number;
  last?: ClaimLastTick;
}

interface OutcomeTarget {
  plan?: ClaimablePlan;
  alarm?: OpeningAlarm;
  endsAt?: number;
  startsAt?: number;
  effectiveAt?: number;
}

export class ClaimScheduler {
  private stopped = false;
  private holdUntil = 0;
  private readonly planHolds = new Map<string, ClaimPlanHold>();
  private readonly alarms = new Map<string, OpeningAlarm>();
  /** The last `failure_ends_at` seen for a plan, by planId. */
  private readonly failureWindows = new Map<string, number>();
  private readonly rateLimitCounts = new Map<string, number>();
  /** One captcha token minted during preheat for this account. */
  private preheatedCaptcha: { verifyParam: string; region?: string } | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  /** Structured fields let the panel show a user-facing reason without parsing log text. */
  private readonly log: (message: string, level?: LogLevel, fields?: Record<string, unknown>) => void;
  private readonly ledger: ActivityLedger;
  private readonly phaseMs: number;
  private readonly openingPhaseMs: number;
  private readonly opening: ClaimOpeningConfig;
  private last: ClaimLastTick | null = null;
  private lastWaitReason: ClaimWaitReason | undefined = undefined;
  private lastReason: string | undefined = undefined;
  private lastUserAction: string | undefined = undefined;
  private activationReported = false;
  private lastPurgeDay = "";

  constructor(private readonly deps: ClaimSchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.ledger = deps.ledger ?? createActivityLedger();
    this.phaseMs = deps.accountId
      ? createHash("sha256").update(deps.accountId, "utf-8").digest().readUInt32BE(0) % Math.max(1, deps.config.pollIntervalMs)
      : 0;
    this.opening = deps.config.opening ?? DEFAULT_OPENING;
    this.openingPhaseMs = deps.accountIndex === undefined
      ? 0
      : deps.accountIndex * Math.max(0, this.opening.accountStaggerMs);
  }

  isStopped(): boolean { return this.stopped; }
  staggerPhaseMs(): number { return this.phaseMs; }
  /** Deterministic millisecond phase used inside opening windows. */
  openingStaggerMs(): number { return this.openingPhaseMs; }
  holdUntilMs(): number { return this.holdUntil; }
  /** Account id as the ledger key; tests may omit it. */
  private get accountId(): string { return this.deps.accountId ?? "default"; }

  status(): ClaimSchedulerStatus {
    const planHolds: Record<string, ClaimPlanHold> = {};
    for (const [planId, hold] of this.planHolds) planHolds[planId] = { ...hold };
    const alarms: ClaimAlarmView[] = [...this.alarms.values()].map((alarm) => ({
      planId: alarm.planId,
      startsAt: alarm.startsAt,
      ...(alarm.effectiveAtMs !== undefined ? { effectiveAtMs: alarm.effectiveAtMs } : {}),
      ...(alarm.expiresAtMs !== undefined ? { expiresAtMs: alarm.expiresAtMs } : {}),
      preheatAtMs: alarm.preheatAtMs,
      claimAtMs: alarm.claimAtMs,
      burstEndsAtMs: alarm.burstEndsAtMs,
      staggerMs: alarm.staggerMs,
      phase: alarm.phase,
      ...(alarm.preparedAtMs !== undefined ? { preparedAtMs: alarm.preparedAtMs } : {}),
      claims: alarm.claims,
      ...(alarm.reason !== undefined ? { reason: alarm.reason } : {}),
    }));
    const upcoming = alarms
      .filter((alarm) => alarm.phase !== "done" && alarm.claimAtMs > this.now())
      .map((alarm) => Math.min(alarm.preheatAtMs, alarm.claimAtMs));
    return {
      stopped: this.stopped,
      holdUntilMs: this.holdUntil,
      phaseMs: this.phaseMs,
      openingPhaseMs: this.openingPhaseMs,
      planHolds,
      alarms,
      nextCheckAtMs: this.holdUntil > this.now() ? this.holdUntil : undefined,
      ...(upcoming.length > 0 ? { nextOpeningAtMs: Math.min(...upcoming) } : {}),
      ...(this.last ? { last: { ...this.last } } : {}),
    };
  }

  start(): void {
    if (this.stopped) return;
    // Once per Beijing day; the ledger file keeps only live rows.
    void this.ledger.purgeExpired(this.now()).catch(() => {});
    // A known `startsAt` may fall inside the normal five-minute phase, so the
    // first discovery uses the millisecond opening phase. The first normal poll
    // still starts at the account's sha256 phase through `holdUntil`.
    this.holdUntil = Math.max(this.holdUntil, this.now() + this.phaseMs);
    this.scheduleNext(this.openingPhaseMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<TickResult> {
    if (this.deps.accountBlocked?.()) {
      this.last = { at: this.now(), source: "auto", action: "skipped_hold" };
      return { action: "skipped_hold" };
    }
    const result = await this.tickOnce();
    this.last = { at: this.now(), source: "auto", ...this.summarize(result) };
    return result;
  }

  /**
   * The single write path for claim results, manual and automatic alike: per-plan
   * hold, ledger facts, policy userAction and the alarm's request count. A plan
   * claimed from the panel is therefore not claimed again by the loop.
   *
   * A caller that has the activity itself passes `plan`, which carries the clocks
   * the policy needs; one that only knows the outcome leaves it out and the alarm
   * registered for that plan supplies the start time.
   */
  noteOutcome(outcome: ClaimOutcome, target?: OutcomeTarget): void {
    if (target?.plan) {
      this.setHoldAndLedger(outcome, target);
      return;
    }
    this.setHoldAndLedger(outcome, { ...target, alarm: target?.startsAt !== undefined ? this.alarms.get(outcome.planId) : undefined });
    this.last = {
      at: this.now(),
      source: "manual",
      action: outcome.ok ? "claimed" : "failed",
      planId: outcome.planId,
      ...(outcome.ok
        ? {
            ...(outcome.startsAt !== undefined ? { startsAt: outcome.startsAt } : {}),
            ...(outcome.endsAt !== undefined ? { endsAt: outcome.endsAt } : {}),
          }
        : {
            failureKind: outcome.failureKind,
            code: outcome.code,
            message: outcome.message,
            reason: outcomeRule(outcome).reason,
            userAction: outcomeRule(outcome).userAction,
          }),
    };
  }

  private summarize(result: TickResult): Omit<ClaimLastTick, "at" | "source"> {
    if (result.action === "claimed") {
      return { action: result.action, planId: result.planId, ...(result.startsAt !== undefined ? { startsAt: result.startsAt } : {}), ...(result.endsAt !== undefined ? { endsAt: result.endsAt } : {}) };
    }
    if (result.action === "failed") {
      const rule = outcomeRule(result.outcome);
      return {
        action: result.action,
        planId: result.outcome.planId,
        failureKind: result.outcome.failureKind,
        code: result.outcome.code,
        message: result.outcome.message,
        reason: rule.reason,
        userAction: rule.userAction,
      };
    }
    if (result.action === "error") {
      return { action: result.action, message: result.message, ...(result.holdSource !== undefined ? { holdSource: result.holdSource } : {}) };
    }
    if (result.action === "idle") {
      return {
        action: result.action,
        ...(this.lastWaitReason !== undefined ? { waitReason: this.lastWaitReason } : {}),
        ...(this.lastReason !== undefined ? { reason: this.lastReason } : {}),
        ...(this.lastUserAction !== undefined ? { userAction: this.lastUserAction } : {}),
      };
    }
    return { action: result.action };
  }

  /** One probe→decision→claim cycle. Discovery always runs before a claim. */
  private async tickOnce(): Promise<TickResult> {
    if (this.stopped) return { action: "stopped" };
    const nowMs = this.now();
    this.adoptSharedRateLimit(nowMs);
    await this.purgeOnce(nowMs);
    await this.reportActivationOnce();

    let jwt: string | undefined;
    try { jwt = await this.deps.getJwt(); }
    catch (err) { return this.errorBackoff(`credential resolution failed: ${(err as Error).message}`); }
    if (!jwt) return this.errorBackoff("no JWT available (oauth login pending)");

    const client = this.deps.createClient(jwt);
    let discovery: ClaimDiscovery;
    try {
      discovery = await client.discoverActivities();
    } catch (err) {
      if (err instanceof ClaimPreviewError && err.status === 404) {
        return this.holdIdle(nowMs, nowMs + this.deps.config.pollIntervalMs, "campaign endpoint not deployed (404)", "not-deployed");
      }
      if (err instanceof ClaimPreviewError && err.status === 429) return this.rateLimitedBackoff(err, nowMs);
      return this.errorBackoff(`discovery failed: ${(err as Error).message}`);
    }
    const diagnostics = discovery.diagnostics;
    if (diagnostics.reasons.length > 0) {
      this.log(`claim: discovery face failed — ${diagnostics.reasons.join("; ")}`);
    }

    const all = discovery.activities;
    const nowSec = Math.floor(nowMs / 1000);
    const live = all.filter((p) => p.endsAt === undefined || p.endsAt > nowSec);
    if (live.length === 0) {
      const reason = all.length > 0 ? "all plans expired" : "no activities in feed";
      // Empty lists get the normal 30-minute cadence all day, never a long hold.
      const diagnostic = this.emptyFeedDiagnostics(diagnostics);
      return this.holdIdle(nowMs, nowMs + this.deps.config.pollIntervalMs, reason, "no-plans", "debug",
        diagnostic.logReason, "wait", diagnostic.reason);
    }
    this.registerAlarms(live, nowMs);
    this.noteDiscovery(live, nowMs);

    const opening = await this.openingTick(live, nowMs, client);
    if (opening) return opening;
    return await this.normalTick(live, nowMs, client);
  }

  /** Empty-feed diagnostics and captcha skips carry the same reason codes as the policy table. */
  private emptyFeedDiagnostics(diagnostics: ClaimDiscovery["diagnostics"]): { reason?: string; logReason?: string } {
    if (diagnostics.versionGate) return { reason: "versionGate", logReason: "app version below the campaign floor" };
    if (diagnostics.eligibility) return { reason: "1004", logReason: "account not eligible for today's feed" };
    if (diagnostics.noDelivery) return { reason: "empty", logReason: "no delivery in either discovery face" };
    return {};
  }

  /** One alarm per `startsAt`, with both time clocks in the ledger. */
  private registerAlarms(live: ClaimablePlan[], nowMs: number): void {
    const seen = new Set<string>();
    for (const plan of live) {
      if (plan.startsAt === undefined) continue;
      seen.add(plan.planId);
      const existing = this.alarms.get(plan.planId);
      if (existing && existing.startsAt === plan.startsAt && existing.phase !== "done") continue;
      if (existing && existing.startsAt === plan.startsAt && existing.phase === "done") continue;
      const alarm = openingAlarms([plan], nowMs, {
        config: this.opening,
        accountIndex: this.deps.accountIndex ?? 0,
      })[0];
      if (alarm) this.alarms.set(plan.planId, alarm);
    }
    for (const planId of [...this.alarms.keys()]) {
      if (!seen.has(planId) && this.alarms.get(planId)?.phase === "preheat") this.alarms.delete(planId);
    }
    const ledgerNow = nowMs;
    for (const alarm of this.alarms.values()) {
      void this.ledger.upsert(this.accountId, alarm.planId, {
        discoveredAt: ledgerNow,
        alarmAt: alarm.startsAt * 1000,
        ...(alarm.effectiveAtMs !== undefined ? { effectiveAt: alarm.effectiveAtMs } : {}),
        ...(alarm.expiresAtMs !== undefined ? { expiresAt: alarm.expiresAtMs } : {}),
      }, ledgerNow).catch(() => {});
    }
  }

  /** Record the presence of a new feed, and let a new window override exhaustion. */
  private noteDiscovery(live: ClaimablePlan[], nowMs: number): void {
    for (const plan of live) {
      const entry = this.ledger.get(this.accountId, plan.planId, nowMs);
      const endsMs = plan.endsAt !== undefined ? plan.endsAt * 1000 : undefined;
      const newStartMs = plan.startsAt !== undefined ? plan.startsAt * 1000 : undefined;
      const newWindow = entry?.exhaustedAt !== undefined && entry.claimedAt === undefined
        && ((newStartMs !== undefined && newStartMs > entry.exhaustedAt)
          || (this.failureWindows.get(plan.planId) ?? 0) * 1000 > entry.exhaustedAt);
      const patch: Record<string, number | string> = {
        discoveredAt: nowMs,
        ...(plan.startsAt !== undefined ? { alarmAt: plan.startsAt * 1000 } : {}),
        ...(plan.effectiveAt !== undefined ? { effectiveAt: plan.effectiveAt * 1000 } : {}),
        ...(endsMs !== undefined ? { expiresAt: endsMs } : {}),
      };
      if (newWindow) {
        this.planHolds.delete(plan.planId);
        this.log(`claim: new feed window for ${plan.planId} — clearing today's exhaustion`);
        void this.ledger.upsert(this.accountId, plan.planId, {
          exhaustedAt: undefined,
          claimedAt: undefined,
          holdUntil: undefined,
          lastOutcome: undefined,
          lastCode: undefined,
        }, nowMs).then(() => this.ledger.upsert(this.accountId, plan.planId, patch, nowMs)).catch(() => {});
        continue;
      }
      void this.ledger.upsert(this.accountId, plan.planId, patch, nowMs).catch(() => {});
    }
  }

  /**
   * Preheat: probe the feed, confirm the captcha gate/version, mint one token
   * for this account, and leave the JWT/egress/health preflight complete. No
   * claim POST leaves before `claimAtMs`.
   */
  private async openingTick(
    live: ClaimablePlan[],
    nowMs: number,
    client: ClaimGateway,
  ): Promise<TickResult | null> {
    const candidates = live.filter((plan) => this.alarms.has(plan.planId));
    let prepared = false;
    for (const plan of candidates) {
      const alarm = this.alarms.get(plan.planId)!;
      const progress = advanceOpening(alarm, nowMs, this.opening);
      if (progress.prepare) {
        prepared = true;
        try { await this.deps.preflight?.(); }
        catch (err) { this.log(`claim: opening preflight failed — ${(err as Error).message}`); }
        if (this.deps.captchaRequired) {
          try {
            if (await this.deps.captchaRequired() && !this.preheatedCaptcha) {
              this.preheatedCaptcha = await this.deps.getCaptcha();
            }
          } catch (err) {
            // The same policy as an upstream 3007: local solver failures hold
            // the plan until manual action or the next Beijing day.
            const failure: ClaimOutcome = {
              ok: false, planId: plan.planId, failureKind: "captcha", code: 3007,
              message: `local captcha solve failed: ${(err as Error).message}`,
            };
            const decision = this.setHoldAndLedger(failure, { plan, alarm });
            this.log(`claim: ${decision.rule.reason} — ${failure.message}`, "info", { reason: "captcha" });
            this.last = { at: nowMs, source: "auto", action: "failed", planId: plan.planId, failureKind: "captcha", code: 3007, message: failure.message };
            return { action: "failed", outcome: failure as Extract<ClaimOutcome, { ok: false }>, holdMs: Math.max(0, decision.holdUntil - nowMs) };
          }
        }
        void this.ledger.upsert(this.accountId, plan.planId, { preparedAt: nowMs }, nowMs).catch(() => {});
        this.log(`claim: opening ${plan.planId} preheat ready; first claim at ${new Date(alarm.claimAtMs).toISOString()}`);
      }
      if (progress.claimAllowed && nowMs >= (this.deps.rateLimit?.untilMs ?? 0)
        && (!this.isHeld(plan.planId, nowMs) || this.planHolds.get(plan.planId)?.reason === "unavailable")) {
        const blocked = this.isTerminal(plan, nowMs);
        if (!blocked) {
          this.lastReason = undefined;
          this.lastUserAction = undefined;
          return this.claimTarget(plan, nowMs, client, alarm);
        }
      }
      if (progress.reason) this.log(`claim: ${progress.reason}`);
    }
    if (prepared) {
      this.holdUntil = computeNextWake(nowMs + this.deps.config.pollIntervalMs, [...this.alarms.values()], nowMs, {
        config: this.opening,
        ...(this.deps.rateLimit ? { rateLimitedUntilMs: this.deps.rateLimit.untilMs } : {}),
      });
      this.lastWaitReason = "preheat";
      this.lastReason = "opening preheat; captcha token ready before the drop";
      return { action: "idle" };
    }
    return null;
  }

  /** Normal poll: one claim per tick, highest priority, policy-driven hold. */
  private async normalTick(live: ClaimablePlan[], nowMs: number, client: ClaimGateway): Promise<TickResult> {
    const active = live.filter((p) => p.startsAt === undefined || p.startsAt <= Math.floor(nowMs / 1000));
    const target = this.pickTarget(active, nowMs);
    const wake = this.computeNormalWake(nowMs, live);
    const nextWake = computeNextWake(wake, [...this.alarms.values()], nowMs, {
      config: this.opening,
      ...(this.deps.rateLimit ? { rateLimitedUntilMs: this.deps.rateLimit.untilMs } : {}),
    });
    if (!target) return this.holdIdle(
      nowMs, nextWake, this.idleReason(live, active, nowMs), this.idleWaitReason(active, nowMs),
      "info", this.lastReason, this.lastUserAction,
    );
    const blocked = this.isTerminal(target, nowMs);
    if (blocked) {
      return this.holdIdle(nowMs, nextWake, this.lastReason ?? "terminal state for today", "per-plan-hold", "info", this.lastReason, this.lastUserAction);
    }
    return this.claimTarget(target, nowMs, client);
  }

  /** Discovery already ran in this tick, so the first opening request is claim. */
  private async claimTarget(
    target: ClaimablePlan,
    nowMs: number,
    client: ClaimGateway,
    alarm?: OpeningAlarm,
  ): Promise<TickResult> {
    let captchaRequired = true;
    if (this.deps.captchaRequired) {
      try { captchaRequired = await this.deps.captchaRequired(); }
      catch { captchaRequired = true; }
    }
    let captcha: { verifyParam: string; region?: string } | undefined;
    if (captchaRequired) {
      try { captcha = this.preheatedCaptcha ?? await this.deps.getCaptcha(); }
      catch (err) {
        // A local solver failure has the same policy meaning as upstream 3007:
        // stop retrying this plan and hand a manual action to the panel.
        const failure: ClaimOutcome = {
          ok: false, planId: target.planId, failureKind: "captcha", code: 3007,
          message: `local captcha solve failed: ${(err as Error).message}`,
        };
        const decision = this.setHoldAndLedger(failure, { plan: target, alarm });
        this.log(`claim: ${decision.rule.reason} — ${failure.message}`, "info", { reason: "captcha" });
        return { action: "failed", outcome: failure as Extract<ClaimOutcome, { ok: false }>, holdMs: Math.max(0, decision.holdUntil - nowMs) };
      }
    }
    if (alarm) recordOpeningClaim(alarm);
    let outcome: ClaimOutcome;
    try { outcome = await client.claim(target.planId, captcha); }
    catch (err) { return this.errorBackoff(`claim request failed: ${(err as Error).message}`); }

    const decision = this.setHoldAndLedger(outcome, { plan: target, alarm });
    this.log(`claim: ${decision.rule.reason} (${outcome.ok ? 0 : outcome.code})${outcome.ok ? "" : ` — ${outcome.message}`}`,
      "info", outcome.ok ? undefined : { reason: String(outcome.code) });
    if (decision.rule.kind === "login_required") this.stop();
    const nextWake = computeNextWake(nowMs + this.deps.config.pollIntervalMs, [...this.alarms.values()], nowMs, {
      config: this.opening,
      ...(this.deps.rateLimit ? { rateLimitedUntilMs: this.deps.rateLimit.untilMs } : {}),
    });
    // A terminal row keeps its own hold; a retryable one uses the earlier of
    // the policy backoff and the next opening wake.
    this.holdUntil = decision.rule.terminal && decision.holdUntil > nowMs
      ? decision.holdUntil
      : Math.min(decision.holdUntil, nextWake);
    if (outcome.ok) {
      return { action: "claimed", planId: outcome.planId, ...(outcome.startsAt !== undefined ? { startsAt: outcome.startsAt } : {}), ...(outcome.endsAt !== undefined ? { endsAt: outcome.endsAt } : {}) };
    }
    return { action: "failed", outcome, holdMs: Math.max(0, decision.holdUntil - nowMs) };
  }

  /** All outcome writes: per-plan hold, policy hint and cross-restart facts. */
  private setHoldAndLedger(outcome: ClaimOutcome, target: OutcomeTarget = {}): OutcomeDecision {
    const nowMs = this.now();
    const endsAtMs = target.plan?.endsAt !== undefined
      ? target.plan.endsAt * 1000
      : outcome.ok && outcome.endsAt !== undefined ? outcome.endsAt * 1000 : target.endsAt !== undefined ? target.endsAt * 1000 : undefined;
    const decision = decideOutcome(outcome, {
      nowMs,
      burstIntervalMs: target.alarm ? this.opening.burstIntervalMs : undefined,
      pollIntervalMs: this.deps.config.pollIntervalMs,
      sprintIntervalMs: target.plan && this.inSprint(target.plan, nowMs) ? this.deps.config.sprintPollIntervalMs : undefined,
      rateLimitCount: this.rateLimitCounts.get(outcome.planId) ?? 0,
      ...(endsAtMs !== undefined ? { endsAtMs } : {}),
      captchaHoldMs: captchaHoldUntilMs(nowMs),
      serverWindow: !outcome.ok && outcome.failureEndsAt !== undefined && outcome.failureEndsAt * 1000 > nowMs,
    });
    if (!outcome.ok && outcome.failureEndsAt !== undefined) {
      this.failureWindows.set(outcome.planId, outcome.failureEndsAt);
    }
    if (decision.rule.kind === "rate_limited") {
      this.rateLimitCounts.set(outcome.planId, (this.rateLimitCounts.get(outcome.planId) ?? 0) + 1);
      this.deps.rateLimit?.reportLimited(decision.holdUntil);
    }
    const hold: ClaimPlanHold = {
      until: decision.rule.terminal && decision.holdUntil <= nowMs
        ? Math.max(nextBeijingDayMs(nowMs), endsAtMs ?? 0)
        : decision.holdUntil,
      reason: outcome.ok ? "claimed" : outcome.failureKind,
      userAction: decision.rule.userAction,
    };
    this.planHolds.set(outcome.planId, hold);
    this.lastReason = decision.rule.reason;
    this.lastUserAction = decision.rule.userAction;
    const alarm = target.alarm ?? this.alarms.get(outcome.planId);
    const patch: Record<string, number | string> = {
      lastOutcome: outcome.ok ? "claimed" : outcome.failureKind,
      ...(outcome.ok ? {} : { lastCode: outcome.code }),
      holdUntil: decision.holdUntil,
      ...(alarm ? { alarmAt: alarm.startsAt * 1000 } : {}),
      ...(target.plan?.effectiveAt !== undefined ? { effectiveAt: target.plan.effectiveAt * 1000 } : {}),
      ...(target.effectiveAt !== undefined ? { effectiveAt: target.effectiveAt * 1000 } : {}),
      ...(endsAtMs !== undefined ? { expiresAt: endsAtMs } : {}),
      ...(alarm?.preparedAtMs !== undefined ? { preparedAt: alarm.preparedAtMs } : {}),
    };
    void noteOutcomeInLedger(this.ledger, this.accountId, outcome.planId, outcome, patch, nowMs).catch(() => {});
    if (decision.claimed) {
      this.ledger.markClaimed(this.accountId, outcome.planId, { lastOutcome: "claimed" }, nowMs).catch(() => {});
    }
    if (decision.exhausted) {
      this.ledger.markExhausted(this.accountId, outcome.planId, { lastOutcome: "quota_exhausted", ...(outcome.ok ? {} : { lastCode: outcome.code }) }, nowMs).catch(() => {});
    }
    return decision;
  }

  /** A terminal ledger row outlives a feed that disappears after the claim. */
  private isTerminal(plan: ClaimablePlan, nowMs: number): boolean {
    const entry = this.ledger.get(this.accountId, plan.planId, nowMs);
    if (entry?.claimedAt !== undefined || entry?.exhaustedAt !== undefined) {
      this.lastReason = entry.claimedAt !== undefined ? "already claimed on this account" : "activity quota exhausted for today";
      this.lastUserAction = entry.claimedAt !== undefined ? "none" : "wait";
      const hold = this.planHolds.get(plan.planId);
      if (!hold || hold.until <= nowMs) {
        this.planHolds.set(plan.planId, { until: Math.max(nextBeijingDayMs(nowMs), entry.expiresAt ?? 0), reason: entry.claimedAt !== undefined ? "claimed" : "quota_exhausted" });
      }
      return true;
    }
    return false;
  }

  private pickTarget(active: ClaimablePlan[], nowMs: number): ClaimablePlan | null {
    const claimable = active.filter((p) => !this.isHeld(p.planId, nowMs));
    return [...claimable].sort((a, b) => b.priority - a.priority)[0] ?? null;
  }

  private isHeld(planId: string, nowMs: number): boolean {
    const hold = this.planHolds.get(planId);
    return hold !== undefined && hold.until > nowMs;
  }

  private computeNormalWake(nowMs: number, live: ClaimablePlan[]): number {
    let wake = Number.POSITIVE_INFINITY;
    const target = this.pickTarget(this.activeOf(live, nowMs), nowMs);
    if (target) wake = Math.min(wake, nowMs + this.cadenceFor(target, nowMs));
    for (const p of live) {
      if (p.startsAt === undefined || this.isHeld(p.planId, nowMs)) continue;
      const startsMs = p.startsAt * 1000;
      if (startsMs > nowMs) wake = Math.min(wake, startsMs);
    }
    for (const [planId, hold] of this.planHolds) {
      if (hold.until <= nowMs) { this.planHolds.delete(planId); continue; }
      wake = Math.min(wake, hold.until);
    }
    if (!Number.isFinite(wake)) wake = nowMs + this.deps.config.pollIntervalMs;
    return wake;
  }

  private activeOf(live: ClaimablePlan[], nowMs: number): ClaimablePlan[] {
    const nowSec = Math.floor(nowMs / 1000);
    return live.filter((p) => p.startsAt === undefined || p.startsAt <= nowSec);
  }

  private inSprint(target: { endsAt?: number }, nowMs: number): boolean {
    const cfg = this.deps.config;
    if (cfg.sprintWindowMs <= 0 || target.endsAt === undefined) return false;
    const remainingMs = target.endsAt * 1000 - nowMs;
    return remainingMs > 0 && remainingMs < cfg.sprintWindowMs;
  }

  private cadenceFor(target: ClaimablePlan, nowMs: number): number {
    return this.inSprint(target, nowMs) ? this.deps.config.sprintPollIntervalMs : this.deps.config.pollIntervalMs;
  }

  /** 429 backoff: Retry-After, shared egress window, alarm preserved. */
  private rateLimitedBackoff(err: ClaimPreviewError, nowMs: number): TickResult {
    const retryAfterMs = err.retryAfterSeconds !== undefined ? err.retryAfterSeconds * 1000 : undefined;
    const holdMs = Math.min(retryAfterMs ?? this.deps.config.cooldownMs, 6 * 3_600_000);
    const source = retryAfterMs !== undefined ? "retry-after" as const : "cooldown" as const;
    this.deps.rateLimit?.reportLimited(nowMs + holdMs);
    this.holdUntil = nowMs + holdMs;
    this.lastReason = "rate limited; keeping the opening alarm and retrying after the window";
    this.lastUserAction = "retry-later";
    this.lastWaitReason = "rate-limit";
    this.log(`claim: discovery rate-limited (429) — retry in ${Math.round(holdMs / 1000)}s (${source})`, "info", { reason: "429" });
    return { action: "error", message: "discovery rate-limited (429)", holdMs, holdSource: source };
  }

  private adoptSharedRateLimit(nowMs: number): void {
    const window = this.deps.rateLimit;
    if (!window || window.untilMs <= nowMs) return;
    const phase = this.openingAlarmsActive(nowMs) ? this.openingPhaseMs : this.phaseMs;
    const candidate = window.untilMs + phase;
    if (candidate <= this.holdUntil) return;
    this.log(`claim: shared rate-limit window until ${new Date(window.untilMs).toISOString()} — holding ${Math.round((candidate - nowMs) / 1000)}s`, "info", { reason: "429" });
    this.holdUntil = candidate;
  }

  private openingAlarmsActive(nowMs: number): boolean {
    for (const alarm of this.alarms.values()) {
      if (alarm.phase !== "done" && alarm.preheatAtMs <= nowMs && alarm.burstEndsAtMs > nowMs) return true;
    }
    return false;
  }

  private errorBackoff(message: string): TickResult {
    const holdMs = this.deps.config.cooldownMs;
    this.holdUntil = this.now() + holdMs;
    this.log(`claim: ${message}; retry in ${Math.round(holdMs / 1000)}s (cooldown)`);
    return { action: "error", message, holdMs, holdSource: "cooldown" };
  }

  private holdIdle(
    nowMs: number,
    wake: number,
    reason: string,
    waitReason: ClaimWaitReason,
    level: LogLevel = "info",
    logReason?: string,
    userAction?: string,
    reasonCode?: string,
  ): TickResult {
    this.holdUntil = wake;
    this.lastWaitReason = waitReason;
    this.lastReason = logReason;
    this.lastUserAction = userAction;
    if (logReason) this.log(`claim: ${logReason}`, level, reasonCode ? { reason: reasonCode } : undefined);
    this.log(`claim: hold ${Math.round((wake - nowMs) / 1000)}s — ${reason}`, level, reasonCode ? { reason: reasonCode } : undefined);
    return { action: "idle" };
  }

  private idleReason(live: ClaimablePlan[], active: ClaimablePlan[], nowMs: number): string {
    if (active.length === 0) {
      const next = live
        .filter((p) => !this.isHeld(p.planId, nowMs) && p.startsAt !== undefined && p.startsAt * 1000 > nowMs)
        .map((p) => p.startsAt as number)
        .sort((a, b) => a - b)[0];
      return next !== undefined ? `waits for the next plan to start at ${new Date(next * 1000).toISOString()}` : "no claimable plan right now";
    }
    const held = [...this.planHolds.values()].map((hold) => hold.until).filter((until) => until > nowMs).sort((a, b) => a - b)[0];
    return held !== undefined
      ? `claimable plans are on per-plan hold until ${new Date(held).toISOString()}`
      : "no claimable plan in the current feed";
  }

  private idleWaitReason(active: ClaimablePlan[], nowMs: number): ClaimWaitReason {
    if (active.length === 0) return "waiting-start";
    const claimable = active.filter((p) => !this.isHeld(p.planId, nowMs));
    if (claimable.length === 0) return "per-plan-hold";
    return "not-listed";
  }

  /** Eligibility reporting runs before the first probe, once per scheduler. */
  private async reportActivationOnce(): Promise<void> {
    if (this.activationReported || !this.deps.reportActivation) return;
    this.activationReported = true;
    try {
      const result = await this.deps.reportActivation();
      if (!result.ok) this.log(`claim: activation report failed — ${result.reason ?? "unknown reason"}`);
    } catch (err) {
      this.log(`claim: activation report failed — ${(err as Error).message}`);
    }
  }

  /** Purge at startup and on each Beijing day change; no per-tick rewrite. */
  private async purgeOnce(nowMs: number): Promise<void> {
    const day = new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 10);
    if (day === this.lastPurgeDay) return;
    this.lastPurgeDay = day;
    await this.ledger.purgeExpired(nowMs).catch(() => {});
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    const delay = Math.min(Math.max(0, delayMs), MAX_TIMEOUT_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.scheduleNext(this.nextDelay()));
    }, delay);
    // Node/Bun timer handles carry unref(); a stopped scheduler must not hold the process.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private nextDelay(): number {
    const remaining = this.holdUntil - this.now();
    return remaining > 0 ? remaining : this.deps.config.pollIntervalMs;
  }
}
