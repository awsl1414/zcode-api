/**
 * Types for the claim subsystem: activities discovered at runtime, not a fixed
 * catalogue. Delivery shapes keep growing, so unknown fields stay in `raw` and
 * every string-valued facet stays a string — an enum here would silently drop a
 * new campaign before any decision code sees it.
 */

/** One entitlement inside a claimable plan (normalized from snake_case upstream). */
export interface PlanEntitlement {
  entitlementId: string;
  showName: string;
  meter: string;
  unitType: string;
  capabilities: string[];
  grantUnits: number;
  period: string;
  priority: number;
  /** Unix seconds when this entitlement activates. */
  effectiveAt?: number;
}

/** A claimable activity from either discovery face. */
export interface ClaimablePlan {
  planId: string;
  name: string;
  description: string;
  priority: number;
  entitlements: PlanEntitlement[];
  /** Unix seconds when claiming opens. */
  startsAt?: number;
  /** Unix seconds when the activity closes. */
  endsAt?: number;
  /**
   * Unix seconds when the granted entitlement becomes usable. Hoisted from the
   * entitlements: with several entitlements the earliest positive `effective_at`
   * wins, because that is when any part of the grant first becomes usable;
   * `0` or absent means immediate, so no timestamp is stored. Claiming still
   * follows `startsAt` — the 19:00 / 23:00 split is two separate clocks.
   */
  effectiveAt?: number;
  /** Which face supplied this shape (`marketing/touch`, `billing/preview`, …). */
  source: string;
  /** Every face where this planId appeared, deduplicated. */
  discoveryFaces: string[];
  campaignId?: string;
  /** Unrecognized delivery fields; kept in memory and logged as a summary, never persisted. */
  raw: unknown;
}

/** Empty-list diagnostics for callers that can distinguish the three causes. */
export interface ClaimDiscoveryDiagnostics {
  /** Both faces answered but listed no activity. */
  noDelivery: boolean;
  /** A face reported a version-related rejection. */
  versionGate: boolean;
  /** A face reported an eligibility-related rejection. */
  eligibility: boolean;
  /** Readable reasons from failed faces, before any conclusion is drawn. */
  reasons: string[];
}

/** Result of one discovery pass: the merged activities plus what an empty list might mean. */
export interface ClaimDiscovery {
  activities: ClaimablePlan[];
  diagnostics: ClaimDiscoveryDiagnostics;
}

export type ClaimFailureKind =
  | "not_found"
  | "unavailable"
  | "already_claimed"
  | "ineligible"
  | "quota_exhausted"
  | "invalid_request"
  | "rate_limited"
  | "captcha"
  | "login_required"
  | "http_error"
  | "unknown";

export type ClaimOutcome =
  | { ok: true; planId: string; startsAt?: number; endsAt?: number }
  | { ok: false; planId: string; failureKind: ClaimFailureKind; code: number | string; message: string; failureEndsAt?: number };

/** A classified biz code. Unknown codes keep the original value for the policy table. */
export interface ClaimCodeClassification {
  kind: ClaimFailureKind;
  /** The code exactly as received, including unparseable strings and `undefined`. */
  rawCode: number | string | undefined;
}

/** Map a server biz code to the client failure kind. */
export function classifyClaimCode(code: number | string | undefined): ClaimCodeClassification {
  const rawCode = code;
  switch (typeof code === "string" ? Number.parseInt(code, 10) : code) {
    case 1001: return { kind: "not_found", rawCode };
    case 1002: return { kind: "unavailable", rawCode };
    case 1003: return { kind: "already_claimed", rawCode };
    case 1004: return { kind: "ineligible", rawCode };
    case 1005: return { kind: "quota_exhausted", rawCode };
    case 3001: return { kind: "invalid_request", rawCode };
    case 3002: return { kind: "rate_limited", rawCode };
    case 3007: return { kind: "captcha", rawCode };
    case 401: return { kind: "login_required", rawCode };
    default: return { kind: "unknown", rawCode };
  }
}
