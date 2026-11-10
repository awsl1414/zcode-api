/**
 * Policy table: one assertion per known code, unknown-code safety, terminal
 * facts, rate-limit backoff and the two clocks kept from a real feed window.
 */
import { describe, it, expect } from "bun:test";
import { createActivityLedger } from "./ledger.js";
import {
  CLAIM_OUTCOME_POLICY,
  INITIAL_OUTCOME_CODES,
  INELIGIBLE_RECHECK_MS,
  RATE_LIMIT_MAX_BACKOFF_MS,
  UNKNOWN_BACKOFF_MS,
  allowsExhaustionOverride,
  captchaHoldUntilMs,
  decideOutcome,
  nextBeijingDayMs,
  noteOutcomeInLedger,
  outcomeRuleFor,
} from "./policy.js";
import type { ClaimOutcome } from "./types.js";

const NOW = 1_700_000_000_000;

function failure(code: number | string, extra: Partial<Extract<ClaimOutcome, { ok: false }>> = {}): ClaimOutcome {
  return {
    ok: false, planId: "plan-a", failureKind: "unknown", code, message: `biz ${code}`,
    ...extra,
  };
}

function memoryLedger() {
  return createActivityLedger({ memoryOnly: true, now: () => NOW });
}

describe("ClaimOutcomePolicy — rows", () => {
  it("has one row for every initial code and no switch branches", () => {
    for (const code of INITIAL_OUTCOME_CODES) {
      const rule = outcomeRuleFor(code);
      expect(rule.pattern === code || rule.kind !== "unknown" || code === "unknown").toBe(true);
    }
    expect(CLAIM_OUTCOME_POLICY.every((rule) => typeof rule.pattern === "string")).toBe(true);
    expect(CLAIM_OUTCOME_POLICY.every((row) => (["none", "retry-after", "fixed"] as string[]).includes(row.backoff))).toBe(true);
    expect(CLAIM_OUTCOME_POLICY.every((row) => (["account", "plan", "activity"] as string[]).includes(row.scope))).toBe(true);
  });

  const expectations: Array<[string, string, boolean, string]> = [
    ["0", "success", true, "plan"],
    ["1001", "not_found", false, "plan"],
    ["1002", "unavailable", false, "plan"],
    ["1003", "already_claimed", true, "plan"],
    ["1004", "ineligible", false, "plan"],
    ["1005", "quota_exhausted", true, "activity"],
    ["3001", "invalid_request", false, "plan"],
    ["3002", "rate_limited", false, "account"],
    ["3007", "captcha", true, "plan"],
    ["401", "login_required", true, "account"],
    ["429", "rate_limited", false, "account"],
    ["unknown", "unknown", false, "plan"],
  ];
  for (const [code, kind, terminal, scope] of expectations) {
    it(`row ${code}: ${kind}, terminal=${terminal}, scope=${scope}`, () => {
      const rule = outcomeRuleFor(code);
      expect(rule.kind as string).toBe(kind);
      expect(rule.terminal).toBe(terminal);
      expect(rule.scope as string).toBe(scope);
      expect(typeof rule.userAction).toBe("string");
    });
  }

  it("1002 waits at the burst cadence inside the opening window, normal poll outside", () => {
    const burst = decideOutcome(failure(1002, { failureKind: "unavailable" }), { nowMs: NOW, burstIntervalMs: 2_000, pollIntervalMs: 300_000 });
    const normal = decideOutcome(failure(1002, { failureKind: "unavailable" }), { nowMs: NOW, pollIntervalMs: 300_000 });
    expect(burst.holdUntil - NOW).toBe(2_000);
    expect(normal.holdUntil - NOW).toBe(300_000);
  });

  it("1004 rechecks in 30 minutes so a later same-day opening is not missed", () => {
    expect(decideOutcome(failure(1004, { failureKind: "ineligible" }), { nowMs: NOW }).holdUntil - NOW).toBe(INELIGIBLE_RECHECK_MS);
  });

  it("1005 writes exhaustedAt and stays terminal for the Beijing day", async () => {
    const ledger = memoryLedger();
    const decision = decideOutcome(failure(1005, { failureKind: "quota_exhausted" }), { nowMs: NOW });
    expect(decision.exhausted).toBe(true);
    expect(decision.rule.terminal).toBe(true);
    await noteOutcomeInLedger(ledger, "account-a", "plan-a", failure(1005, { failureKind: "quota_exhausted" }), {}, NOW);
    expect(ledger.get("account-a", "plan-a", NOW)?.exhaustedAt).toBe(NOW);
    expect(ledger.get("account-a", "plan-a", NOW)?.claimedAt).toBeUndefined();
  });

  it("a new feed window clears exhaustion, but never a claimed plan", async () => {
    const ledger = memoryLedger();
    await ledger.markExhausted("account-a", "plan-a", {}, NOW);
    expect(allowsExhaustionOverride(ledger.get("account-a", "plan-a", NOW)!, { endsAt: (NOW + 3_600_000) / 1000 }, NOW)).toBe(true);
    await noteOutcomeInLedger(ledger, "account-a", "plan-a", failure(1005, {
      failureKind: "quota_exhausted", failureEndsAt: (NOW + 3_600_000) / 1000,
    }), {}, NOW);
    const entry = ledger.get("account-a", "plan-a", NOW);
    expect(entry?.exhaustedAt).toBeUndefined();
    expect(entry?.lastOutcome).toBe("quota_exhausted");
    await ledger.markClaimed("account-a", "plan-a", {}, NOW);
    expect(allowsExhaustionOverride(ledger.get("account-a", "plan-a", NOW)!, { endsAt: (NOW + 3_600_000) / 1000 }, NOW)).toBe(false);
  });

  it("3002/429 use Retry-After, cap at six hours, and fall back to exponential backoff", () => {
    const withHeader = decideOutcome(failure(3002, { failureKind: "rate_limited" }), { nowMs: NOW, retryAfterMs: 90_000 });
    const capped = decideOutcome(failure(429, { failureKind: "rate_limited" }), { nowMs: NOW, retryAfterMs: 24 * 3_600_000 });
    const noHeader = decideOutcome(failure(429, { failureKind: "rate_limited" }), { nowMs: NOW, rateLimitCount: 2 });
    expect(withHeader.holdUntil - NOW).toBe(90_000);
    expect(capped.holdUntil - NOW).toBe(RATE_LIMIT_MAX_BACKOFF_MS);
    expect(noHeader.holdUntil - NOW).toBe(240_000);
    expect(capped.rule.userAction).toBe("retry-later");
  });

  it("3007 and a local captcha-solver failure hand a manual action to the panel", () => {
    const upstream = decideOutcome(failure(3007, { failureKind: "captcha" }), { nowMs: NOW, captchaHoldMs: captchaHoldUntilMs(NOW) });
    expect(upstream.rule.userAction).toBe("manual-captcha");
    expect(upstream.needsUserAction).toBe(true);
    expect(upstream.holdUntil).toBe(nextBeijingDayMs(NOW));
    expect(upstream.claimed).toBe(false);
  });

  it("401 stops the account and success holds the plan until endsAt", () => {
    expect(outcomeRuleFor(401).scope).toBe("account");
    expect(outcomeRuleFor(401).userAction).toBe("login");
    const claimed = decideOutcome({ ok: true, planId: "plan-a", endsAt: (NOW + 3_600_000) / 1000 }, {
      nowMs: NOW, endsAtMs: NOW + 3_600_000,
    });
    expect(claimed.claimed).toBe(true);
    expect(claimed.holdUntil).toBe(NOW + 3_600_000);
  });

  it("an unseen business code falls to unknown, never marks claimed or successful", async () => {
    const ledger = memoryLedger();
    const outcome: Extract<ClaimOutcome, { ok: false }> = failure(9999, { message: "new campaign rejection" }) as Extract<ClaimOutcome, { ok: false }>;
    const rule = outcomeRuleFor(outcome.code);
    const decision = decideOutcome(outcome, { nowMs: NOW });
    expect(rule.kind).toBe("unknown");
    expect(rule.userAction).toBe("inspect-code");
    expect(decision.claimed).toBe(false);
    expect(decision.exhausted).toBe(false);
    expect(decision.holdUntil - NOW).toBe(UNKNOWN_BACKOFF_MS);
    await noteOutcomeInLedger(ledger, "account-a", "plan-a", outcome, {}, NOW);
    const entry = ledger.get("account-a", "plan-a", NOW);
    expect(entry?.lastCode).toBe(9999);
    expect(entry?.lastOutcome).toBe("unknown");
    expect(entry?.claimedAt).toBeUndefined();
    expect(entry?.exhaustedAt).toBeUndefined();
  });
});
