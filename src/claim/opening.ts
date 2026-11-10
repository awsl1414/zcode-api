/**
 * Opening-window alarms. A limited drop opens at `startsAt`, so the normal
 * five-minute poll phase is too coarse: the first claim request has to go out
 * at that second. Preheat starts at `T - preheatMs` (or the remaining time when
 * discovery happens later), probes the feed, and prepares one captcha token per
 * account. Accounts use a deterministic millisecond stagger inside this window;
 * the normal poll keeps its sha256 phase.
 *
 * `startsAt` drives claiming, `effectiveAt` drives when the grant becomes
 * usable. The scheduler and the ledger read both clocks separately.
 */
import type { ClaimOpeningConfig } from "../config/types.js";
import type { ClaimablePlan } from "./types.js";

export const DEFAULT_OPENING: ClaimOpeningConfig = {
  preheatMs: 180_000,
  probeIntervalMs: 10_000,
  burstIntervalMs: 2_000,
  burstWindowMs: 180_000,
  accountStaggerMs: 200,
  maxClaimsPerAccount: 6,
};

export type OpeningPhase = "idle" | "preheat" | "burst" | "done";

export interface OpeningAlarm {
  planId: string;
  startsAt: number;
  /** Unix ms; the grant's separate clock, when the feed supplies one. */
  effectiveAtMs?: number;
  expiresAtMs?: number;
  /** `T - preheatMs`, compressed to `nowMs` when preheat starts late. */
  preheatAtMs: number;
  /** `T + staggerMs`; the first claim request goes out at this instant. */
  claimAtMs: number;
  /** Hard stop for retries: `T + burstWindowMs`. */
  burstEndsAtMs: number;
  staggerMs: number;
  phase: OpeningPhase;
  preparedAtMs?: number;
  claims: number;
  /** Reason the window ended, for the panel's system stream. */
  reason?: string;
}

export interface OpeningOptions {
  config?: ClaimOpeningConfig;
  /** Stable ordinal for this account among accounts sharing an egress. */
  accountIndex?: number;
  now?: () => number;
}

/** Millisecond phase for one account; it never uses the five-minute hash phase. */
export function openingStaggerMs(accountIndex: number, config: ClaimOpeningConfig = DEFAULT_OPENING): number {
  return Math.max(0, accountIndex) * Math.max(0, config.accountStaggerMs);
}

/** A plan with no `startsAt`, or one already open, claims on the next tick. */
export function needsPreheat(plan: ClaimablePlan, nowMs: number): boolean {
  return plan.startsAt !== undefined
    && plan.startsAt * 1000 > nowMs + 1
    && (plan.endsAt === undefined || plan.endsAt * 1000 > nowMs);
}

/**
 * One alarm per known `startsAt`. A feed that appears after `T` still creates
 * an alarm whose preheat is compressed to now, so a late delivery can be
 * retried inside the burst window.
 */
export function openingAlarms(
  plans: readonly ClaimablePlan[],
  nowMs: number,
  options: OpeningOptions = {},
): OpeningAlarm[] {
  const config = options.config ?? DEFAULT_OPENING;
  const staggerMs = openingStaggerMs(options.accountIndex ?? 0, config);
  const alarms: OpeningAlarm[] = [];
  for (const plan of plans) {
    if (plan.startsAt === undefined) continue;
    const startsMs = plan.startsAt * 1000;
    const endsMs = plan.endsAt !== undefined ? plan.endsAt * 1000 : undefined;
    if (endsMs !== undefined && endsMs <= nowMs) continue;
    const preheatAtMs = Math.max(nowMs, startsMs - Math.min(config.preheatMs, Math.max(0, startsMs - nowMs)));
    alarms.push({
      planId: plan.planId,
      startsAt: plan.startsAt,
      ...(plan.effectiveAt !== undefined ? { effectiveAtMs: plan.effectiveAt * 1000 } : {}),
      ...(endsMs !== undefined ? { expiresAtMs: endsMs } : {}),
      preheatAtMs,
      claimAtMs: startsMs + staggerMs,
      burstEndsAtMs: Math.max(startsMs + staggerMs, startsMs + config.burstWindowMs),
      staggerMs,
      phase: nowMs >= startsMs + staggerMs ? "burst" : "preheat",
      claims: 0,
    });
  }
  return alarms.sort((a, b) => a.claimAtMs - b.claimAtMs || a.planId.localeCompare(b.planId));
}

/** `T - N` registration: returns the earliest preheat wake for future plans. */
export function nextPreheatWake(alarms: readonly OpeningAlarm[], nowMs: number): number | undefined {
  const future = alarms
    .filter((alarm) => alarm.phase !== "done" && alarm.preheatAtMs > nowMs)
    .map((alarm) => alarm.preheatAtMs)
    .sort((a, b) => a - b);
  return future[0];
}

/**
 * Wake candidates from the opening channel. `computeNextWake` takes the min of
 * these and the normal poll wake; a rate-limit hold extends the wake without
 * deleting the alarm.
 */
export function openingWakes(
  alarms: readonly OpeningAlarm[],
  nowMs: number,
  options: { config?: ClaimOpeningConfig; rateLimitedUntilMs?: number } = {},
): number[] {
  const config = options.config ?? DEFAULT_OPENING;
  const blockedUntil = Math.max(nowMs, options.rateLimitedUntilMs ?? 0);
  const wakes: number[] = [];
  for (const alarm of alarms) {
    if (alarm.phase === "done") continue;
    const probeEnd = Math.min(alarm.claimAtMs, alarm.burstEndsAtMs);
    const probeStart = Math.max(alarm.preheatAtMs, blockedUntil);
    if (probeStart > nowMs && probeStart < probeEnd) wakes.push(probeStart);
    for (let at = probeStart + config.probeIntervalMs; at < probeEnd; at += config.probeIntervalMs) {
      if (at > nowMs && at > blockedUntil) wakes.push(at);
    }
    if (alarm.burstEndsAtMs > nowMs) {
      if (alarm.claimAtMs > nowMs && alarm.claimAtMs > blockedUntil) wakes.push(alarm.claimAtMs);
      const retryStart = Math.max(blockedUntil, alarm.claimAtMs);
      if (retryStart > nowMs && retryStart <= alarm.burstEndsAtMs) wakes.push(retryStart);
      for (let at = retryStart + config.burstIntervalMs; at <= alarm.burstEndsAtMs; at += config.burstIntervalMs) {
        wakes.push(at);
      }
    }
  }
  return [...new Set(wakes)].filter((at) => at > nowMs).sort((a, b) => a - b);
}

/** The earliest opening wake, or `undefined`; the caller takes `Math.min`. */
export function computeNextWake(
  normalWake: number,
  alarms: readonly OpeningAlarm[],
  nowMs: number,
  options: { config?: ClaimOpeningConfig; rateLimitedUntilMs?: number } = {},
): number {
  const preheat = nextPreheatWake(alarms, nowMs);
  const wakes = openingWakes(alarms, nowMs, options);
  return Math.min(normalWake, preheat ?? Number.POSITIVE_INFINITY, wakes[0] ?? Number.POSITIVE_INFINITY);
}

/** Phase at a given instant. A rate-limited account returns to `burst` after its hold. */
export function phaseAt(alarm: OpeningAlarm, nowMs: number): OpeningPhase {
  if (alarm.phase === "done") return "done";
  if (nowMs < alarm.preheatAtMs) return "idle";
  if (nowMs < alarm.claimAtMs) return "preheat";
  if (nowMs <= alarm.burstEndsAtMs) return "burst";
  return "done";
}

export interface OpeningProgress {
  phase: OpeningPhase;
  /** True when this tick may send a claim POST. */
  claimAllowed: boolean;
  /** True when preheat should probe the feed and prepare a captcha token. */
  prepare: boolean;
  reason?: string;
}

/**
 * One tick of an alarm. The burst stops at `burstWindowMs` or
 * `maxClaimsPerAccount`; neither limit removes the alarm from the ledger.
 */
export function advanceOpening(
  alarm: OpeningAlarm,
  nowMs: number,
  config: ClaimOpeningConfig = DEFAULT_OPENING,
): OpeningProgress {
  const phase = phaseAt(alarm, nowMs);
  if (phase === "done") {
    alarm.phase = "done";
    alarm.reason ??= nowMs > alarm.burstEndsAtMs
      ? "opening burst window ended; back to normal polling"
      : "claim request cap reached; back to normal polling";
    return { phase, claimAllowed: false, prepare: false, reason: alarm.reason };
  }
  if (phase === "idle") return { phase, claimAllowed: false, prepare: false };
  if (phase === "preheat") {
    alarm.phase = "preheat";
    const prepare = alarm.preparedAtMs === undefined;
    if (prepare) alarm.preparedAtMs = nowMs;
    return { phase, claimAllowed: false, prepare };
  }
  if (alarm.claims >= config.maxClaimsPerAccount) {
    alarm.phase = "done";
    alarm.reason = "claim request cap reached; back to normal polling";
    return { phase: "done", claimAllowed: false, prepare: false, reason: alarm.reason };
  }
  alarm.phase = "burst";
  return { phase, claimAllowed: true, prepare: false };
}

/** The number of claims already sent in this window, for the request cap. */
export function recordOpeningClaim(alarm: OpeningAlarm): void {
  alarm.claims += 1;
}
