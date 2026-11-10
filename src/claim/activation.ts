/**
 * Activation-event reporting for claim eligibility.
 *
 * The upstream grants daily eligibility to accounts that reported a launch and
 * a daily-active event; without both, an otherwise eligible account sees an
 * empty feed or an ineligible rejection. Each event is its own POST with a fresh
 * `event_id` (the upstream deduplicates by it), no auth headers — identity is
 * in the body — and `code === 0` is the only success envelope. One failed event
 * never suppresses the other; the first readable reason is returned instead of
 * thrown, because reporting is a prerequisite, not the claim itself.
 */
import { randomUUID } from "node:crypto";
import { fetchWithEgress, type EgressOptions } from "../proxy/egress.js";
import { logger } from "../log/index.js";

const log = logger("claim");
const EVENT_PATH = "/api/v1/event/report";
const EVENTS = ["app_launch", "app_daily_active"] as const;
const CLIENT_LANGUAGE = "zh-CN";
const SCREEN_RESOLUTION = "2560x1440";
const TIMEOUT_MS = 10_000;

export interface ReportActivationOptions {
  origin: string;
  userId: string;
  deviceMid: string;
  appVersion: string;
  osCategory?: string;
  /** IANA timezone name, or `unknown` when the host cannot provide one. */
  timezone?: string;
  /** OS version; empty when the host cannot provide one. */
  osVersion?: string;
  egress?: EgressOptions;
  timeoutMs?: number;
  fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/** `undefined` = both events accepted; otherwise the first readable failure. */
export type ActivationReport = { ok: true } | { ok: false; reason: string };

function eventBody(event: string, opts: ReportActivationOptions): Record<string, unknown> {
  return {
    event_id: randomUUID(),
    client_timezone: opts.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown"),
    client_language: CLIENT_LANGUAGE,
    element_name: event,
    event_region: "app",
    event_type: "view",
    event_text: "",
    event_extra_detail: {},
    user_id: opts.userId,
    screen_resolution: SCREEN_RESOLUTION,
    app_version: opts.appVersion,
    device_os_category: opts.osCategory ?? process.platform,
    device_os_version: opts.osVersion ?? "",
    device_mid: opts.deviceMid,
    mac_id: "",
    marketing_params: "{}",
  };
}

function failureMessage(payload: Record<string, unknown>, status: number, text: string, code: number | string): string {
  const message = typeof payload.msg === "string" && payload.msg.trim()
    ? payload.msg.trim()
    : typeof payload.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : text.trim() || `HTTP ${status}`;
  return `activation event rejected: ${message} (code ${String(code)})`;
}

export async function reportActivation(opts: ReportActivationOptions): Promise<ActivationReport> {
  const userId = opts.userId.trim();
  if (!userId) return { ok: false, reason: "activation event needs a user id; this credential has none" };
  const origin = opts.origin.replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  let firstReason: string | undefined;
  for (const event of EVENTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_MS);
    try {
      const resp = await fetchWithEgress(fetchImpl, `${origin}${EVENT_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(eventBody(event, opts)),
        signal: controller.signal,
      }, opts.egress);
      const text = await resp.text();
      let payload: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
      } catch { /* non-JSON body is reported via its text */ }
      const code = payload.code !== undefined ? (payload.code as number | string) : resp.status;
      const ok = resp.status >= 200 && resp.status < 300 && code === 0;
      if (!ok) {
        const reason = failureMessage(payload, resp.status, text, code);
        firstReason ??= reason;
        log.warn("activation event failed", { event, reason });
      }
    } catch (err) {
      const reason = `activation event request failed: ${(err as Error).message}`;
      firstReason ??= reason;
      log.warn("activation event failed", { event, reason });
    } finally {
      clearTimeout(timer);
    }
  }
  return firstReason ? { ok: false, reason: firstReason } : { ok: true };
}
