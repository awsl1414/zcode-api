/**
 * HTTP client for ZCode's claim plane.
 *
 * The claim plane carries a minimal header set, NOT the identity bundle:
 *   - `GET  {origin}/api/v1/zcode-plan/billing/preview?app_version=&platform=`
 *     headers: `Authorization: Bearer {jwt}` only (omitted entirely when
 *     anonymous), plus `X-Device-Mid` when supplied.
 *   - `GET  {origin}/api/v1/marketing/touch?seq=N` with X-Device-Mid (required,
 *     UUID-parsed) / X-Client-Language / X-ZCode-App-Version / [Authorization].
 *   - `POST {origin}/api/v1/zcode-plan/billing/claim` body `{plan_id}` with
 *     Authorization, Content-Type, optional captcha pair, X-ZCode-App-Version,
 *     X-Platform, [X-Device-Mid].
 *
 * The gateway has rejected preview with biz 3001 unless the request carries a
 * UUID-format `X-Device-Mid`; that header is a deliberate deviation from the
 * minimal bundle set. Marketing is the same-day delivery face, so discovery
 * prefers its fields and merges preview as a supplement.
 *
 * `Retry-After` on preview 429 is exposed as
 * {@link ClaimPreviewError.retryAfterSeconds}; the scheduler uses it instead
 * of a fixed cooldown. The parser lives in `accounts/signals.ts` so both
 * planes read the same RFC 9110 forms.
 */
import type { ClaimablePlan, ClaimDiscovery, ClaimOutcome, PlanEntitlement } from "./types.js";
import { fetchWithEgress, type EgressOptions } from "../proxy/egress.js";
import { parseRetryAfterSeconds } from "../accounts/signals.js";
import { classifyClaimCode } from "./types.js";
import { logger } from "../log/index.js";

const log = logger("claim");

export interface ClaimClientOptions {
  origin: string;
  /** OAuth JWT (`zcodejwttoken`); preview works without it, claim does not. */
  jwt?: string;
  appVersion: string;
  /** `${process.platform}-{arch}` in the real client (`u3()`). */
  platform: string;
  /** UUID-format `X-Device-Mid`, needed by the campaign-gated gateway. */
  deviceMid?: string;
  /** Marketing-face device id (`marketing/touch` uuid.parse's it). */
  marketingDeviceMid?: string;
  /** Marketing-face locale header. Default `zh-CN` (client enum zh-CN|en-US). */
  language?: string;
  /** Per-call timeout in ms. Default `15000` (bundle `ss`). */
  timeoutMs?: number;
  /** DI seam for tests. Default `globalThis.fetch`. */
  fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** This account's egress proxy, fixed at construction time. */
  egress?: EgressOptions;
  /** Observation hook for upstream responses; failures do not interrupt a claim. */
  onUpstreamResp?: (resp: Response) => void | Promise<unknown>;
}

export interface ClaimClient {
  /** Billing-preview face only; the scheduler and the panel read the merged list. */
  getPreviews(signal?: AbortSignal): Promise<ClaimablePlan[]>;
  /**
   * The only discovery entry point: both faces in parallel, merged, with what an
   * empty or partial answer might mean. Every consumer — scheduler, CLI, panel —
   * goes through it, so no caller can silently lose a face.
   */
  discoverActivities(signal?: AbortSignal): Promise<ClaimDiscovery>;
  claim(planId: string, captcha?: { verifyParam: string; region?: string }, signal?: AbortSignal): Promise<ClaimOutcome>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const PREVIEW_FACE = "billing/preview";
const MARKETING_FACE = "marketing/touch";
/**
 * Marketing deliveries wrap `zcode_plan` several levels deep: delivery → face →
 * hero/background → bundle → args → zcode_plan, with button arrays along the way.
 * 12 object levels covers that chain plus one more wrapper; every nesting step
 * (including array elements) counts as one.
 */
const MAX_TRAVERSAL_DEPTH = 12;

export class ClaimPreviewError extends Error {
  readonly status: number;
  readonly code: number | string;
  readonly retryAfterSeconds?: number;
  constructor(message: string, status: number, code: number | string, retryAfterSeconds?: number) {
    super(message);
    this.name = "ClaimPreviewError";
    this.status = status;
    this.code = code;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Keys the normalized model understands. Everything else on a delivery, a rich
 * plan object or an entitlement is preserved in `raw`, so a new field cannot
 * cause the whole delivery to be dropped.
 */
const PLAN_KEYS = new Set([
  "plan_id", "name", "description", "priority", "entitlements",
  "starts_at", "ends_at", "effective_at", "campaign_id", "zcode_plan",
]);
const ENTITLEMENT_KEYS = new Set([
  "entitlement_id", "show_name", "meter", "unit_type", "capabilities",
  "grant_units", "period", "priority", "effective_at",
]);
const DELIVERY_KEYS = new Set([
  "campaign_id", "resource_position", "priority", "banner", "popup", "success_popup",
]);

function extras(record: UnknownRecord, known: Set<string>): UnknownRecord | undefined {
  const out: UnknownRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (!known.has(key)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `0` / missing means immediate; with several entitlements the earliest positive one wins. */
function planEffectiveAt(entitlements: PlanEntitlement[], raw: UnknownRecord): number | undefined {
  const direct = finiteNumber(raw.effective_at);
  const candidates = entitlements
    .map((entitlement) => entitlement.effectiveAt)
    .filter((at): at is number => at !== undefined && at > 0);
  if (direct !== undefined && direct > 0) candidates.push(direct);
  if (candidates.length === 0) return direct === 0 ? undefined : direct;
  return Math.min(...candidates);
}

function parseEntitlement(raw: UnknownRecord): PlanEntitlement | null {
  const entitlementId = stringOrEmpty(raw.entitlement_id);
  if (!entitlementId) return null;
  const entitlement: PlanEntitlement = {
    entitlementId,
    showName: stringOrEmpty(raw.show_name),
    meter: stringOrEmpty(raw.meter),
    unitType: stringOrEmpty(raw.unit_type),
    capabilities: stringArray(raw.capabilities),
    grantUnits: finiteNumber(raw.grant_units) ?? 0,
    period: stringOrEmpty(raw.period),
    priority: finiteNumber(raw.priority) ?? 0,
  };
  const effectiveAt = finiteNumber(raw.effective_at);
  if (effectiveAt !== undefined && effectiveAt !== 0) entitlement.effectiveAt = effectiveAt;
  return entitlement;
}

/**
 * Parse one raw plan without inventing missing values. `source` and
 * `discoveryFaces` come from the caller that knows which face supplied it;
 * `raw` keeps both the original plan object and any delivery-level extras.
 */
function parsePlan(raw: UnknownRecord, source: string, campaignId?: string, deliveryExtras?: unknown): ClaimablePlan | null {
  const planId = stringOrEmpty(raw.plan_id);
  if (!planId) return null;
  const entitlements = (Array.isArray(raw.entitlements) ? raw.entitlements : [])
    .filter(isRecord)
    .flatMap((item) => {
      const entitlement = parseEntitlement(item);
      return entitlement ? [entitlement] : [];
    });
  const plan: ClaimablePlan = {
    planId,
    name: stringOrEmpty(raw.name) || planId,
    description: stringOrEmpty(raw.description),
    priority: finiteNumber(raw.priority) ?? 0,
    entitlements,
    source,
    discoveryFaces: [source],
    raw: { ...raw, ...(deliveryExtras !== undefined ? { deliveryExtras } : {}) },
  };
  const startsAt = finiteNumber(raw.starts_at);
  const endsAt = finiteNumber(raw.ends_at);
  const effectiveAt = planEffectiveAt(entitlements, raw);
  const richCampaignId = stringOrEmpty(raw.campaign_id) || stringOrEmpty(campaignId);
  if (startsAt !== undefined) plan.startsAt = startsAt;
  if (endsAt !== undefined) plan.endsAt = endsAt;
  if (effectiveAt !== undefined) plan.effectiveAt = effectiveAt;
  if (richCampaignId) plan.campaignId = richCampaignId;
  return plan;
}

interface FoundClaimButton {
  planId: string;
  /** Unrecognized keys on the button/action, preserved in the plan's raw. */
  extras?: unknown;
  /** Unrecognized action types seen on this delivery (summary only). */
  actionType: string;
}

/** Walk every nesting level: no host-name whitelist, no fixed face list. */
export function collectClaimButtons(node: unknown, out: FoundClaimButton[], depth = 0): void {
  if (depth > MAX_TRAVERSAL_DEPTH || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectClaimButtons(item, out, depth + 1);
    return;
  }
  const record = node as UnknownRecord;
  const action = isRecord(record.action) ? record.action : undefined;
  if (action && typeof action.type === "string") {
    const args = isRecord(action.args) ? action.args : undefined;
    const planId = stringOrEmpty(args?.plan_id) || stringOrEmpty(record.plan_id);
    if (planId) {
      const unknown: UnknownRecord = {
        action_type: action.type,
        ...(extras(record, new Set(["text", "action", "theme", "buttons"])) ?? {}),
        ...(extras(action, new Set(["type", "args"])) ?? {}),
        ...(args ? (extras(args, new Set(["plan_id"])) ?? {}) : {}),
      };
      out.push({
        planId,
        actionType: action.type,
        ...(Object.keys(unknown).length > 0 ? { extras: unknown } : {}),
      });
    }
  }
  for (const value of Object.values(record)) collectClaimButtons(value, out, depth + 1);
}

/** Rich `zcode_plan` objects anywhere inside a delivery, including nested background args. */
export function collectZcodePlans(node: unknown, out: UnknownRecord[], depth = 0): void {
  if (depth > MAX_TRAVERSAL_DEPTH || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectZcodePlans(item, out, depth + 1);
    return;
  }
  const record = node as UnknownRecord;
  if (isRecord(record.zcode_plan)) out.push(record.zcode_plan as UnknownRecord);
  for (const value of Object.values(record)) collectZcodePlans(value, out, depth + 1);
}

/** Count how many recognized fields/nested facts a plan actually carries. */
function completeness(plan: ClaimablePlan): number {
  let score = plan.entitlements.length * 2;
  if (plan.name !== plan.planId) score += 1;
  if (plan.description) score += 1;
  if (plan.priority !== 0) score += 1;
  for (const key of ["startsAt", "endsAt", "effectiveAt", "campaignId"] as const) {
    if (plan[key] !== undefined) score += 1;
  }
  return score;
}

/** Field-by-field merge: keep whichever face supplied the value, never drop the other face's fields. */
export function mergePlans(faces: { face: string; plans: ClaimablePlan[] }[]): ClaimablePlan[] {
  const merged = new Map<string, ClaimablePlan>();
  const faceOrder = [...new Set(faces.map((face) => face.face))];
  for (const { face, plans } of faces) {
    for (const plan of plans) {
      const current = merged.get(plan.planId);
      if (!current) {
        merged.set(plan.planId, {
          ...plan,
          source: face,
          discoveryFaces: [...new Set([...plan.discoveryFaces, face])],
        });
        continue;
      }
      const preferred = completeness(plan) > completeness(current) ? plan : current;
      const other = preferred === plan ? current : plan;
      const next: ClaimablePlan = {
        ...preferred,
        name: preferred.name !== preferred.planId ? preferred.name : other.name,
        description: preferred.description || other.description,
        priority: preferred.priority !== 0 ? preferred.priority : other.priority,
        entitlements: preferred.entitlements.length >= other.entitlements.length ? preferred.entitlements : other.entitlements,
        source: preferred.source,
        discoveryFaces: [...faceOrder, ...new Set([...current.discoveryFaces, ...plan.discoveryFaces, face])]
          .filter((value, index, all) => all.indexOf(value) === index),
        raw: { ...(isRecord(current.raw) ? current.raw : {}), ...(isRecord(plan.raw) ? plan.raw : {}) },
      };
      for (const key of ["startsAt", "endsAt", "effectiveAt", "campaignId"] as const) {
        const value = preferred[key] ?? other[key];
        if (value !== undefined) (next as unknown as UnknownRecord)[key] = value;
      }
      merged.set(plan.planId, next);
    }
  }
  // Map insertion order is the first face's id order; later faces append.
  return [...merged.values()];
}

function diagnosticReason(err: unknown, face: string): string {
  if (err instanceof ClaimPreviewError) return `${face}: ${err.message}`;
  return `${face}: ${(err as Error).message ?? String(err)}`;
}

function isVersionSignal(reason: string): boolean {
  return /version|版本|3001|app_version/i.test(reason);
}

function isEligibilitySignal(reason: string): boolean {
  return /eligib|资格|1004|login|401/i.test(reason);
}

/** Delivery → plans: buttons are authoritative, rich objects only enrich matching ids. */
function parseMarketingDeliveries(deliveries: unknown[]): ClaimablePlan[] {
  const byId = new Map<string, ClaimablePlan>();
  const unknownSummaries: string[] = [];
  for (const delivery of deliveries) {
    if (!isRecord(delivery)) continue;
    const campaignId = stringOrEmpty(delivery.campaign_id) || undefined;
    const deliveryExtras = extras(delivery, DELIVERY_KEYS);
    const richPlans: UnknownRecord[] = [];
    collectZcodePlans(delivery, richPlans);
    const richById = new Map<string, UnknownRecord>();
    for (const rich of richPlans) {
      const id = stringOrEmpty(rich.plan_id);
      if (id && !richById.has(id)) richById.set(id, rich);
    }
    // Every action with a plan_id is kept: the claim action is the authoritative
    // entry, others describe the same delivery without being discarded.
    const buttons: FoundClaimButton[] = [];
    collectClaimButtons(delivery, buttons);
    const claimButtons: FoundClaimButton[] = [];
    const deliveryUnknowns: UnknownRecord = { ...(deliveryExtras ?? {}) };
    const seenFaces: string[] = [];
    for (const button of buttons) {
      if (button.actionType !== "claim_zcode_plan") {
        unknownSummaries.push(`action type: ${button.actionType}`);
        deliveryUnknowns[`action_type_${button.actionType}`] = button.actionType;
        Object.assign(deliveryUnknowns, button.extras ?? {});
        continue;
      }
      claimButtons.push(button);
    }
    for (const button of claimButtons) {
      const rich = richById.get(button.planId) ?? { plan_id: button.planId };
      const plan = parsePlan(rich, MARKETING_FACE, campaignId, {
        ...deliveryUnknowns,
        ...(button.extras ?? {}),
        ...(typeof delivery.resource_position === "string" ? { resource_position: delivery.resource_position } : {}),
      });
      if (!plan) continue;
      const current = byId.get(button.planId);
      if (current) {
        const merged = mergePlans([
          { face: MARKETING_FACE, plans: [current] },
          { face: MARKETING_FACE, plans: [plan] },
        ])[0];
        byId.set(button.planId, merged);
      } else {
        byId.set(button.planId, plan);
      }
      seenFaces.push(button.planId);
    }
    if (deliveryExtras) unknownSummaries.push(`delivery fields: ${Object.keys(deliveryExtras).join(",")}`);
    if (typeof delivery.resource_position === "string" && !DELIVERY_KEYS.has(delivery.resource_position)) {
      unknownSummaries.push(`resource_position: ${delivery.resource_position}`);
    }
    if (seenFaces.length === 0 && buttons.length > 0) {
      unknownSummaries.push(`action types without claim_zcode_plan: ${buttons.map((b) => b.actionType).join(",")}`);
    }
    for (const rich of richPlans) {
      const unknownPlan = extras(rich, PLAN_KEYS);
      if (unknownPlan) unknownSummaries.push(`plan fields: ${Object.keys(unknownPlan).join(",")}`);
      for (const entitlement of Array.isArray(rich.entitlements) ? rich.entitlements : []) {
        if (!isRecord(entitlement)) continue;
        const unknownEntitlement = extras(entitlement, ENTITLEMENT_KEYS);
        if (unknownEntitlement) unknownSummaries.push(`entitlement fields: ${Object.keys(unknownEntitlement).join(",")}`);
      }
    }
  }
  if (unknownSummaries.length > 0) {
    log.info("unknown marketing delivery facts", { keys: [...new Set(unknownSummaries)] });
  }
  return [...byId.values()];
}

export function createClaimClient(opts: ClaimClientOptions): ClaimClient {
  const origin = opts.origin.replace(/\/+$/, "");
  const jwt = opts.jwt?.trim() || undefined;
  const deviceMid = opts.deviceMid?.trim() || undefined;
  const marketingDeviceMid = opts.marketingDeviceMid?.trim() || undefined;
  const language = opts.language?.trim() || "zh-CN";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  let marketingSeq = 0;

  async function request(
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal },
  ): Promise<{ status: number; json: UnknownRecord | undefined; text: string; retryAfterHeader: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    if (init.signal) {
      if (init.signal.aborted) controller.abort();
      else init.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    let resp: Response;
    try {
      resp = await fetchWithEgress(fetchImpl, `${origin}${path}`, {
        method,
        headers: init.headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      }, opts.egress);
      if (opts.onUpstreamResp) {
        try {
          await opts.onUpstreamResp(resp);
        } catch {
          // Observation is a side channel: it never interrupts discovery.
        }
      }
      const text = await resp.text();
      let json: UnknownRecord | undefined;
      try {
        const parsed: unknown = JSON.parse(text);
        if (isRecord(parsed)) json = parsed;
      } catch { /* non-JSON body surfaced via text */ }
      return { status: resp.status, json, text, retryAfterHeader: resp.headers.get("retry-after") };
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  function unwrapError(json: UnknownRecord | undefined, status: number, text: string): { code: number | string; message: string } {
    const code = json?.code !== undefined ? (json.code as number | string) : status >= 400 ? status : -1;
    const rawMsg = json?.msg ?? json?.message;
    const message = typeof rawMsg === "string" && rawMsg.trim() ? rawMsg.trim() : text.length > 0 && text.length < 200 ? text : `HTTP ${status}`;
    return { code, message };
  }

  async function getPreviews(signal?: AbortSignal): Promise<ClaimablePlan[]> {
    const url = `/api/v1/zcode-plan/billing/preview?app_version=${encodeURIComponent(opts.appVersion)}&platform=${encodeURIComponent(opts.platform)}`;
    const headers: Record<string, string> = jwt ? { Authorization: `Bearer ${jwt}` } : {};
    if (deviceMid) headers["X-Device-Mid"] = deviceMid;
    const { status, json, text, retryAfterHeader } = await request("GET", url, { headers, signal });
    // code 0 with no data means this account has no billing-distributed campaign.
    if (status >= 200 && status < 300 && json?.code === 0 && json?.data === undefined) return [];
    if (status < 200 || status >= 300 || (json?.code !== undefined && json.code !== 0) || json?.data === undefined) {
      const { code, message } = unwrapError(json, status, text);
      const retryAfterSeconds = status === 429 ? parseRetryAfterSeconds(retryAfterHeader, Date.now()) : undefined;
      throw new ClaimPreviewError(`claim preview failed (${code}): ${message}`, status, code, retryAfterSeconds);
    }
    const data = isRecord(json.data) ? json.data : {};
    return (Array.isArray(data.plans) ? data.plans : [])
      .filter(isRecord)
      .flatMap((raw) => {
        const plan = parsePlan(raw, PREVIEW_FACE);
        return plan ? [plan] : [];
      });
  }

  /** Marketing face failures are diagnostics, not a reason to lose the billing face. */
  async function fetchMarketing(signal?: AbortSignal): Promise<ClaimablePlan[]> {
    if (!marketingDeviceMid) return [];
    const headers: Record<string, string> = {
      "X-Device-Mid": marketingDeviceMid,
      "X-Client-Language": language,
      "X-ZCode-App-Version": opts.appVersion,
    };
    if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
    const path = `/api/v1/marketing/touch?seq=${marketingSeq++}`;
    const { status, json, text } = await request("GET", path, { headers, signal });
    if (status < 200 || status >= 300 || (json?.code !== undefined && json.code !== 0)) {
      const { code, message } = unwrapError(json, status, text);
      throw new ClaimPreviewError(`marketing touch failed (${code}): ${message}`, status, code);
    }
    const data = isRecord(json?.data) ? (json.data as UnknownRecord) : {};
    return parseMarketingDeliveries(Array.isArray(data.deliveries) ? data.deliveries : []);
  }

  async function discoverActivities(signal?: AbortSignal): Promise<ClaimDiscovery> {
    // Marketing is the same-day delivery face; its fields win on merge.
    const [marketing, preview] = await Promise.allSettled([
      fetchMarketing(signal),
      getPreviews(signal).catch((err: unknown) => {
        if (err instanceof ClaimPreviewError && err.status === 404) return [];
        throw err;
      }),
    ]);
    const reasons: string[] = [];
    let versionGate = false;
    let eligibility = false;
    const failures: { face: string; err: unknown }[] = [];
    const faces: { face: string; plans: ClaimablePlan[] }[] = [];
    if (marketing.status === "fulfilled") faces.push({ face: MARKETING_FACE, plans: marketing.value });
    else failures.push({ face: MARKETING_FACE, err: marketing.reason });
    if (preview.status === "fulfilled") faces.push({ face: PREVIEW_FACE, plans: preview.value });
    else failures.push({ face: PREVIEW_FACE, err: preview.reason });
    for (const { face, err } of failures) {
      const reason = diagnosticReason(err, face);
      reasons.push(reason);
      log.warn("claim discovery face failed", { face, reason });
      if (err instanceof ClaimPreviewError) {
        if (err.code === 3001 || err.status === 426) versionGate = true;
        if (err.code === 1004 || err.status === 401 || err.status === 403) eligibility = true;
      }
      if (isVersionSignal(reason)) versionGate = true;
      if (isEligibilitySignal(reason)) eligibility = true;
    }
    const activities = mergePlans(faces);
    return {
      activities,
      diagnostics: {
        noDelivery: reasons.length === 0 && activities.length === 0,
        versionGate,
        eligibility,
        reasons,
      },
    };
  }

  return {
    getPreviews,
    discoverActivities,
    async claim(planId: string, captcha?: { verifyParam: string; region?: string }, signal?: AbortSignal): Promise<ClaimOutcome> {
      if (!jwt) return { ok: false, planId, failureKind: "login_required", code: 401, message: "manual_claim_login_required" };
      const headers: Record<string, string> = {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      };
      if (captcha) {
        headers["X-Aliyun-Captcha-Verify-Param"] = captcha.verifyParam;
        if (captcha.region) headers["X-Aliyun-Captcha-Verify-Region"] = captcha.region;
      }
      headers["X-ZCode-App-Version"] = opts.appVersion;
      headers["X-Platform"] = opts.platform;
      if (deviceMid) headers["X-Device-Mid"] = deviceMid;
      const { status, json, text } = await request("POST", "/api/v1/zcode-plan/billing/claim", { body: { plan_id: planId }, headers, signal });
      const data = isRecord(json?.data) ? (json.data as UnknownRecord) : {};
      const plan = isRecord(data.plan) ? (data.plan as UnknownRecord) : undefined;
      const bizCode = json?.code !== undefined ? (json.code as number) : undefined;
      if (status >= 200 && status < 300 && bizCode === 0 && plan) {
        const out: ClaimOutcome = { ok: true, planId };
        const startsAt = finiteNumber(plan.starts_at);
        const endsAt = finiteNumber(plan.ends_at);
        if (startsAt !== undefined) out.startsAt = startsAt;
        if (endsAt !== undefined) out.endsAt = endsAt;
        return out;
      }
      const { code, message } = unwrapError(json, status, text);
      const failureEndsAt = finiteNumber(plan?.ends_at);
      const httpDerived = status >= 400 && bizCode === undefined;
      const classification = classifyClaimCode(code);
      return {
        ok: false,
        planId,
        failureKind: httpDerived ? (status === 401 ? "login_required" : "http_error") : classification.kind,
        code: classification.rawCode ?? code,
        message,
        ...(failureEndsAt !== undefined ? { failureEndsAt } : {}),
      };
    },
  };
}
