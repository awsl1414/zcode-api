/**
 * Tests for `rate-limit.ts`: one window per egress, reports only extend the
 * hold, and a rate-limited outcome keeps the opening alarm for the retry.
 */
import { describe, it, expect } from "bun:test";
import { createClaimRateLimitWindow, rateLimitEgressKey } from "./rate-limit.js";
import { createActivityLedger } from "./ledger.js";
import { computeNextWake, DEFAULT_OPENING, openingAlarms, recordOpeningClaim, advanceOpening } from "./opening.js";
import { ClaimScheduler } from "./scheduler.js";
import type { ClaimablePlan, ClaimOutcome } from "./types.js";

describe("shared rate-limit window", () => {
  it("only pushes the window later and groups direct egress as one IP", () => {
    const window = createClaimRateLimitWindow();
    window.reportLimited(1_000);
    window.reportLimited(500);
    expect(window.untilMs).toBe(1_000);
    expect(rateLimitEgressKey(undefined)).toBe("direct");
    expect(rateLimitEgressKey("http://10.0.0.1:7890")).toBe("http://10.0.0.1:7890");
    expect(rateLimitEgressKey("  ")).toBe("direct");
  });
});

describe("opening alarm survives a rate-limit hold", () => {
  const START = 1793358000;
  const T = START * 1000;

  it("wakes after the shared window instead of dropping the alarm", () => {
    const plan: ClaimablePlan = {
      planId: "p", name: "p", description: "", priority: 1, entitlements: [],
      source: "marketing/touch", discoveryFaces: ["marketing/touch"], raw: {},
      startsAt: START, endsAt: START + 3600,
    };
    const alarms = openingAlarms([plan], T - 1_000);
    const window = createClaimRateLimitWindow();
    window.reportLimited(T + 12_000);
    const wake = computeNextWake(T + 300_000, alarms, T, { config: DEFAULT_OPENING, rateLimitedUntilMs: window.untilMs });
    expect(wake).toBeGreaterThanOrEqual(T + 12_000);
    expect(wake).toBeLessThanOrEqual(T + 14_000);
    expect(alarms[0].phase).not.toBe("done");
  });

  it("the retry after a 3002 still uses the millisecond phase, not sha256", async () => {
    const window = createClaimRateLimitWindow();
    let now = T - DEFAULT_OPENING.preheatMs;
    const ledger = createActivityLedger({ memoryOnly: true, now: () => now });
    const seen: number[] = [];
    const scheduler = new ClaimScheduler({
      accountId: "peer-b",
      accountIndex: 1,
      rateLimit: window,
      ledger,
      getJwt: () => Promise.resolve("jwt"),
      createClient: () => ({
        discoverActivities: () => Promise.resolve({
          activities: [{
            planId: "p", name: "p", description: "", priority: 1, entitlements: [],
            source: "marketing/touch", discoveryFaces: ["marketing/touch"], raw: {},
            startsAt: START, endsAt: START + 3600,
          }],
          diagnostics: { noDelivery: false, versionGate: false, eligibility: false, reasons: [] },
        }),
        claim: (planId: string): Promise<ClaimOutcome> => {
          seen.push(now);
          return Promise.resolve(seen.length === 1
            ? { ok: false, planId, failureKind: "rate_limited", code: 3002, message: "slow down" }
            : { ok: true, planId });
        },
      }),
      getCaptcha: () => Promise.resolve({ verifyParam: "cap" }),
      captchaRequired: async () => true,
      config: { pollIntervalMs: 300_000, cooldownMs: 600_000, sprintWindowMs: 0, sprintPollIntervalMs: 60_000, opening: DEFAULT_OPENING },
      now: () => now,
    });
    now = T + 200;
    expect((await scheduler.tick()).action).toBe("failed");
    expect(window.untilMs).toBe(T + 60_200);
    expect(scheduler.openingStaggerMs()).toBe(200);
    now = T + 60_200;
    expect((await scheduler.tick()).action).toBe("claimed");
    expect(seen).toEqual([T + 200, T + 60_200]);
  });

  it("the per-account claim cap closes the burst and reports why", () => {
    const plan: ClaimablePlan = {
      planId: "p", name: "p", description: "", priority: 1, entitlements: [],
      source: "marketing/touch", discoveryFaces: ["marketing/touch"], raw: {},
      startsAt: START, endsAt: START + 3600,
    };
    const alarm = openingAlarms([plan], T)[0];
    for (let i = 0; i < DEFAULT_OPENING.maxClaimsPerAccount; i += 1) {
      expect(advanceOpening(alarm, T + 2_000 * i, DEFAULT_OPENING).claimAllowed).toBe(true);
      recordOpeningClaim(alarm);
    }
    const afterCap = advanceOpening(alarm, T + 12_000, DEFAULT_OPENING);
    expect(afterCap.phase).toBe("done");
    expect(afterCap.reason).toContain("cap reached");
  });
});
