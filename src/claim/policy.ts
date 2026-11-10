/**
 * Claim outcomes as data. A new upstream code adds one row here; the scheduler
 * keeps reading the same fields, so a new campaign never needs a new branch.
 *
 * Exact numeric and string codes are the pattern, plus `status:<number>` for
 * transport statuses. `classifyClaimCode` supplies the failure-kind fallback
 * when a code has no row, which lands unknown codes on the `unknown` row.
 */
import type { ActivityLedger, ActivityLedgerPatch } from "./ledger.js";
import { beijingDayKey } from "./ledger.js";
import { classifyClaimCode, type ClaimFailureKind, type ClaimOutcome } from "./types.js";

export type ClaimRetry = "never" | "burst" | "poll" | "short";
export type ClaimBackoff = "none" | "retry-after" | "fixed";
export type ClaimScope = "account" | "plan" | "activity";
/** Panel-facing hints. AC3 maps these to text; the scheduler only carries them. */
export type ClaimUserAction =
  | "none"
  | "wait"
  | "check-later"
  | "retry-later"
  | "manual-captcha"
  | "login"
  | "inspect-code";

export interface ClaimOutcomeRule {
  /** Exact code (`0`, `1005`), `status:<number>`, a failure kind, or `"unknown"`. */
  pattern: string;
  kind: ClaimFailureKind | "success";
  retry: ClaimRetry;
  backoff: ClaimBackoff;
  /** A terminal row is written to the ledger and closes the Beijing day. */
  terminal: boolean;
  userAction: ClaimUserAction;
  scope: ClaimScope;
  /** Fixed hold before rechecking this outcome. */
  waitMs?: number;
  /** Upper bound for Retry-After backoff in ms. */
  maxWaitMs?: number;
  /** Log line that distinguishes this outcome in the panel's system stream. */
  reason: string;
}

export const INELIGIBLE_RECHECK_MS = 30 * 60_000;
export const UNKNOWN_BACKOFF_MS = 60_000;
export const INVALID_REQUEST_BACKOFF_MS = 10 * 60_000;
export const RATE_LIMIT_MAX_BACKOFF_MS = 6 * 3_600_000;
export const RATE_LIMIT_BASE_BACKOFF_MS = 60_000;

/**
 * `scope` says whose clock the hold lives on: one plan, one account's whole
 * rate-limit window, or the activity itself (exhaustion applies to every account
 * on that day). `terminal` rows also survive a process restart via the ledger.
 *
 * `1002` retries at the burst cadence only inside an opening window; the normal
 * poll cadence takes over outside it. `1005` writes `exhaustedAt` for the day.
 */
export const CLAIM_OUTCOME_POLICY: readonly ClaimOutcomeRule[] = [
  { pattern: "0", kind: "success", retry: "never", backoff: "none", terminal: true, userAction: "none", scope: "plan", reason: "claimed" },
  { pattern: "1001", kind: "not_found", retry: "poll", backoff: "fixed", waitMs: 30 * 60_000, terminal: false, userAction: "wait", scope: "plan", reason: "plan does not exist" },
  { pattern: "1002", kind: "unavailable", retry: "burst", backoff: "fixed", waitMs: 2_000, terminal: false, userAction: "wait", scope: "plan", reason: "not open yet; keep waiting in the opening window" },
  { pattern: "1003", kind: "already_claimed", retry: "never", backoff: "none", terminal: true, userAction: "none", scope: "plan", reason: "already claimed on this account" },
  { pattern: "1004", kind: "ineligible", retry: "short", backoff: "fixed", waitMs: INELIGIBLE_RECHECK_MS, terminal: false, userAction: "check-later", scope: "plan", reason: "not eligible yet; check again later today" },
  { pattern: "1005", kind: "quota_exhausted", retry: "never", backoff: "none", terminal: true, userAction: "none", scope: "activity", reason: "activity quota exhausted for today" },
  { pattern: "3001", kind: "invalid_request", retry: "poll", backoff: "fixed", waitMs: INVALID_REQUEST_BACKOFF_MS, terminal: false, userAction: "inspect-code", scope: "plan", reason: "invalid request" },
  { pattern: "3002", kind: "rate_limited", retry: "burst", backoff: "retry-after", maxWaitMs: RATE_LIMIT_MAX_BACKOFF_MS, terminal: false, userAction: "retry-later", scope: "account", reason: "rate limited; keep the alarm and retry after the window" },
  { pattern: "status:429", kind: "rate_limited", retry: "burst", backoff: "retry-after", maxWaitMs: RATE_LIMIT_MAX_BACKOFF_MS, terminal: false, userAction: "retry-later", scope: "account", reason: "rate limited; keep the alarm and retry after the window" },
  { pattern: "429", kind: "rate_limited", retry: "burst", backoff: "retry-after", maxWaitMs: RATE_LIMIT_MAX_BACKOFF_MS, terminal: false, userAction: "retry-later", scope: "account", reason: "rate limited; keep the alarm and retry after the window" },
  { pattern: "3007", kind: "captcha", retry: "never", backoff: "none", terminal: true, userAction: "manual-captcha", scope: "plan", reason: "manual captcha verification needed" },
  { pattern: "401", kind: "login_required", retry: "never", backoff: "none", terminal: true, userAction: "login", scope: "account", reason: "login required; scheduler stopped" },
  { pattern: "unknown", kind: "unknown", retry: "short", backoff: "fixed", waitMs: UNKNOWN_BACKOFF_MS, terminal: false, userAction: "inspect-code", scope: "plan", reason: "unknown code; inspect the raw code and message" },
  { pattern: "http_error", kind: "http_error", retry: "short", backoff: "fixed", waitMs: UNKNOWN_BACKOFF_MS, terminal: false, userAction: "inspect-code", scope: "plan", reason: "HTTP error; inspect the raw code and message" },
];

const BY_PATTERN = new Map(CLAIM_OUTCOME_POLICY.map((rule) => [rule.pattern, rule]));
const UNKNOWN_RULE = BY_PATTERN.get("unknown")!;

/** One row per initial code, in the order callers and tests read them. */
export const INITIAL_OUTCOME_CODES = [
  "0", "1001", "1002", "1003", "1004", "1005", "3001", "3002", "3007", "401", "429", "unknown",
] as const;

/** Exact match first, then the classified failure kind, then `unknown`. */
export function outcomeRuleFor(code: number | string | undefined, kind?: ClaimFailureKind): ClaimOutcomeRule {
  const normalized = typeof code === "number" ? String(code) : code?.trim();
  if (normalized !== undefined && normalized !== "") {
    const exact = BY_PATTERN.get(normalized);
    if (exact) return exact;
  }
  const derived = kind ?? classifyClaimCode(code).kind;
  return BY_PATTERN.get(derived) ?? UNKNOWN_RULE;
}

export function outcomeRule(outcome: ClaimOutcome): ClaimOutcomeRule {
  return outcome.ok ? outcomeRuleFor(0) : outcomeRuleFor(outcome.code, outcome.failureKind);
}

/** Next Beijing midnight, in unix ms. Captcha holds last until then at most. */
export function nextBeijingDayMs(nowMs: number): number {
  const shifted = nowMs + 8 * 3_600_000;
  const midnight = Math.floor(shifted / 86_400_000) * 86_400_000 + 86_400_000;
  return midnight - 8 * 3_600_000;
}

/** Captcha failures hold the plan until manual action or the next natural day. */
export function captchaHoldUntilMs(nowMs: number): number {
  return nextBeijingDayMs(nowMs) - nowMs;
}

/**
 * Write one outcome row. Claims and exhaustion go through the ledger's own
 * mark helpers so terminal facts survive a restart; unknown codes write only
 * `lastOutcome`, `lastCode` and `holdUntil`, never a success or terminal fact.
 * `failureEndsAt` from the feed opens a new window by clearing exhaustion.
 */
export async function noteOutcomeInLedger(
  ledger: ActivityLedger,
  accountId: string,
  planId: string,
  outcome: ClaimOutcome,
  patch: ActivityLedgerPatch = {},
  nowMs: number = Date.now(),
): Promise<void> {
  const rule = outcomeRule(outcome);
  const base: ActivityLedgerPatch = {
    ...patch,
    lastOutcome: outcome.ok ? "claimed" : outcome.failureKind,
    ...(outcome.ok ? {} : { lastCode: outcome.code }),
  };
  const reopened = !outcome.ok && outcome.failureEndsAt !== undefined
    && outcome.failureEndsAt * 1000 > nowMs;
  if (!outcome.ok && outcome.failureEndsAt !== undefined) {
    const existing = ledger.get(accountId, planId, nowMs);
    if (existing?.exhaustedAt !== undefined && existing.claimedAt === undefined
      && outcome.failureEndsAt * 1000 > existing.exhaustedAt) {
      // `undefined` is a clear in the ledger's upsert; replaying the newest row
      // must not restore an exhaustion that the feed has superseded.
      base.exhaustedAt = undefined;
      base.holdUntil = undefined;
    }
  }
  await ledger.upsert(accountId, planId, base, nowMs);
  if (rule.kind === "success") {
    await ledger.markClaimed(accountId, planId, { lastOutcome: "claimed" }, nowMs);
  } else if (rule.kind === "quota_exhausted" && !reopened) {
    await ledger.markExhausted(accountId, planId, { lastOutcome: "quota_exhausted", ...(outcome.ok ? {} : { lastCode: outcome.code }) }, nowMs);
  }
}

/** A new feed window can override today's exhaustion, but not a claimed plan. */
export function allowsExhaustionOverride(
  entry: { claimedAt?: number; exhaustedAt?: number },
  plan: { startsAt?: number; endsAt?: number },
  nowMs: number,
): boolean {
  if (entry.claimedAt !== undefined || entry.exhaustedAt === undefined) return false;
  if (beijingDayKey(entry.exhaustedAt) !== beijingDayKey(nowMs)) return false;
  const startsMs = plan.startsAt !== undefined ? plan.startsAt * 1000 : undefined;
  const endsMs = plan.endsAt !== undefined ? plan.endsAt * 1000 : undefined;
  return (startsMs !== undefined && startsMs > entry.exhaustedAt)
    || (endsMs !== undefined && endsMs > entry.exhaustedAt && endsMs > nowMs);
}

export interface OutcomeContext {
  nowMs: number;
  /** Retry-After in ms; absent headers use exponential backoff. */
  retryAfterMs?: number;
  /** Number of previous rate limits for this account and plan. */
  rateLimitCount?: number;
  /** Inside the opening burst, `1002` retries at this cadence. */
  burstIntervalMs?: number;
  /** Outside the opening window, hold until the next normal poll. */
  pollIntervalMs?: number;
  /** End-of-window sprint cadence when a retry is allowed. */
  sprintIntervalMs?: number;
  /** An upstream `failure_ends_at` window overriding exhaustion. */
  serverWindowMs?: number;
  /** A new feed window overriding exhaustion. */
  serverWindow?: boolean;
  endsAtMs?: number;
  /** Captcha failures wait until manual action or the next Beijing day. */
  captchaHoldMs?: number;
}

function rateLimitHoldMs(ctx: OutcomeContext): number {
  if (ctx.retryAfterMs !== undefined && Number.isFinite(ctx.retryAfterMs)) {
    return Math.min(Math.max(0, ctx.retryAfterMs), RATE_LIMIT_MAX_BACKOFF_MS);
  }
  const step = Math.max(0, ctx.rateLimitCount ?? 0);
  return Math.min(RATE_LIMIT_BASE_BACKOFF_MS * 2 ** Math.min(step, 8), RATE_LIMIT_MAX_BACKOFF_MS);
}

export interface OutcomeDecision {
  rule: ClaimOutcomeRule;
  /** Unix ms of the next attempt; terminal rows hold to their window boundary. */
  holdUntil: number;
  /** True when the ledger's exhaustedAt must be written. */
  exhausted: boolean;
  /** True when the ledger's claimedAt must be written. */
  claimed: boolean;
  /** True when policy.userAction needs to reach the panel. */
  needsUserAction: boolean;
  /** True when an upstream window overrides the row's terminal behavior. */
  reopened: boolean;
}

/**
 * Resolve one outcome into a hold and the ledger facts it produces. Unknown
 * codes never set `claimed` or `exhausted` and keep the raw code in `lastCode`.
 * A server `failureEndsAt` wins for terminal rows; it is the upstream's next
 * window, and a new window can override an exhaustion record.
 */
export function decideOutcome(outcome: ClaimOutcome, ctx: OutcomeContext): OutcomeDecision {
  const rule = outcomeRule(outcome);
  const claimed = rule.kind === "success";
  const exhausted = rule.kind === "quota_exhausted";
  const serverWindowMs = ctx.serverWindowMs ?? (!outcome.ok && outcome.failureEndsAt !== undefined
    ? outcome.failureEndsAt * 1000
    : undefined);
  const reopened = ctx.serverWindow === true || (serverWindowMs !== undefined && serverWindowMs > ctx.nowMs);
  let holdUntil = ctx.nowMs;
  if (!rule.terminal || (rule.kind === "quota_exhausted" && reopened)) {
    if (rule.backoff === "retry-after") holdUntil += rateLimitHoldMs(ctx);
    else if (rule.kind === "unavailable") {
      holdUntil += ctx.burstIntervalMs ?? ctx.sprintIntervalMs ?? ctx.pollIntervalMs ?? UNKNOWN_BACKOFF_MS;
    } else holdUntil += rule.waitMs ?? UNKNOWN_BACKOFF_MS;
  } else if (rule.kind === "captcha") {
    holdUntil += ctx.captchaHoldMs ?? nextBeijingDayMs(ctx.nowMs) - ctx.nowMs;
  } else if (claimed && ctx.endsAtMs !== undefined && ctx.endsAtMs > ctx.nowMs) {
    holdUntil = Math.min(ctx.endsAtMs, ctx.nowMs + 24 * 3_600_000);
  } else if (serverWindowMs !== undefined && serverWindowMs > ctx.nowMs) {
    holdUntil = Math.min(serverWindowMs, ctx.nowMs + 24 * 3_600_000);
  }
  return {
    rule,
    holdUntil,
    claimed,
    exhausted: exhausted && !reopened,
    reopened,
    needsUserAction: rule.userAction === "manual-captcha" || rule.userAction === "inspect-code" || rule.userAction === "login",
  };
}
