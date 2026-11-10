/**
 * Upstream request builder — constructs the forwarded HTTP request.
 *
 * **Anthropic-only egress**: every route posts an Anthropic-format body (since
 * PR #34, 2026-08-29 — start-plan's old OpenAI gateway is retired), and the
 * pay-as-you-go route that was the last OpenAI-egress consumer is gone too.
 * OpenAI clients are translated to Anthropic before this builder is called, so
 * there is no format knob left to carry.
 *
 * **`route` semantics**: the third auth-relevant fact is the route this request
 * resolved to (`accounts/broker.ts` → `lease.route`), not a process-global
 * `plan`. The route decides the *endpoint*
 * (the caller resolves `baseUrl` from `accounts/routes.ts`) and the *auth
 * shape* (start-plan → Bearer plan JWT; coding-plan family → dual
 * `x-api-key` + `Authorization: Bearer {apiKey}.{secret}`).
 *
 * **`layers` semantics**: identity headers, attribution headers and the
 * inferred `x-session-id` are not always on. They are mounted from the
 * route's `LayerFlags` (`accounts/routes.ts`):
 *
 * | flag             | true →                                   | false → |
 * |------------------|------------------------------------------|---------|
 * | `impersonation`  | ZCode identity headers + SDK UA suffix   | no identity headers |
 * | `traceHeaders`   | `x-request-id` / `x-zcode-*` attribution | none |
 * | `sessionAffinity`| inferred `x-session-id` / `x-query-id`   | none |
 *
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import type { LayerFlags, RouteKind } from "../accounts/types.js";
import { getRouteSpec } from "../accounts/routes.js";
import type { Credential } from "../auth/types.js";
import type { ProxyIdentity } from "../config/types.js";
import { credentialString } from "../auth/types.js";
import { buildLlmIdentityHeaders } from "./identity.js";
import { buildZcodeTraceHeaders } from "./trace-headers.js";
import { sessionIdForHeader, shouldUseExactTraceHeaders } from "./session-context.js";

export interface UpstreamClientSession {
  source?: "none" | "explicit" | "lineage";
  action: "off" | "observe" | "enforce";
  sessionId?: string;
  upstreamSessionId?: string;
  /** Explicit x-zcode-session-type override (wins over sessionId-prefix derivation). */
  sessionType?: "main" | "subagent" | "other";
  requestId?: string;
  traceId?: string;
  queryId?: string;
}

export type UpstreamHeaderPair = [string, string];

const ANTHROPIC_VERSION = "2023-06-01";

/** The one client header we forward, lowercased — see `PASSTHROUGH_HEADERS`. */
const ANTHROPIC_BETA_HEADER = "anthropic-beta";

/** Separator the Fetch API and every Anthropic client use between beta values. */
const ANTHROPIC_BETA_SEPARATOR = ",";

/**
 * SDK UA suffix the real client appends to its User-Agent on LLM calls
 * (bundle `Cm` merges `ai-sdk/anthropic/${k0o}` into the UA; k0o = "3.0.81").
 * Only the LLM request path carries it — control-plane fetches (endpoint
 * routing, signing gate, claim/billing) keep the bare `ZCode/…` UA.
 */
const ANTHROPIC_SDK_UA = "ai-sdk/anthropic/3.0.81";

/** Whether this route authenticates with the plan JWT instead of the apiKey pair. */
export function routeUsesPlanJwt(route: RouteKind): boolean {
  return route === "start-plan";
}

/**
/**
 * Build the upstream URL from the route's base URL.
 *
 * `baseUrl` is resolved by the caller from the route table
 * (`accounts/routes.ts::routeBaseUrl`, overridable per family by
 * `config.providers`); this builder only appends the Anthropic messages path.
 * start-plan's gateway is just `ROUTE_SPECS["start-plan"].baseUrl` like every
 * other route, so the route table is the single source of endpoints.
 */
export function buildUpstreamURL(baseUrl: string): string {
  return `${baseUrl}/v1/messages`;
}

/**
 * Build auth + identity + trace headers for the upstream LLM request.
 *
 * Auth scheme is a route fact, not a wire-format detail:
 * - coding-plan family → `x-api-key: {cred}` AND
 *   `Authorization: Bearer {cred}` (dual headers, bundle `ebo`) +
 *   `anthropic-version`
 * - start-plan        → `Authorization: Bearer {jwt}` + `anthropic-version`
 *
 * Identity headers come from `buildLlmIdentityHeaders` (bundle 3.12.3 `g6n`
 * shape); the User-Agent carries the `ai-sdk/anthropic` SDK suffix (bundle
 * `Cm`/`k0o`).
 *
 * Trace/attribution headers mirror the bundle's `Bdt`
 * ("createModelRequestAttributionHeaders") when an explicit/enforced trace
 * context exists. Default enforce mode forwards the inferred conversation
 * session id; sessions without a resolvable id fall back to a synthesized
 * one (coding-plan must always carry x-session-id — signing requires it).
 */
export function buildAuthHeaders(
  cred: Credential,
  identity: ProxyIdentity,
  route: RouteKind,
  clientSession?: UpstreamClientSession,
): Record<string, string> {
  const layers = getRouteSpec(route).layers;
  const usePlanJwt = routeUsesPlanJwt(route) && Boolean(cred.jwt);
  const credStr = usePlanJwt ? cred.jwt! : credentialString(cred);
  const base: Record<string, string> = {};

  // 仿冒面（`impersonation`）：身份头 + SDK UA 后缀。
  if (layers.impersonation) {
    // LLM requests mirror the bundle's 3.12.3 source-headers builder (`g6n`,
    // no wrapper) — language/timezone always sent with "unknown" fallback,
    // X-ZCode-Agent inline 8th before the platform headers, no X-Device-Mid.
    // Context/control-plane fetches use buildIdentityHeaders (`TV`).
    Object.assign(base, buildLlmIdentityHeaders(identity));
    // Bundle `Cm`/`k0o`: the anthropic SDK merges its identity into the UA —
    // real LLM requests arrive as `ZCode/{ver} ai-sdk/anthropic/3.0.81`.
    base["User-Agent"] = `${base["User-Agent"]} ${ANTHROPIC_SDK_UA}`;
  }

  // 归因面（`traceHeaders` + `sessionAffinity`）。
  if (layers.traceHeaders) {
    Object.assign(base, buildTraceHeaders(route, layers, clientSession));
  }

  // 鉴权形态是路由事实，不由 wire format 推导。
  if (usePlanJwt) {
    base["authorization"] = `Bearer ${cred.jwt}`;
  } else {
    // Bundle `ebo` (coding-plan): x-api-key from the SDK config AND
    // `Authorization: Bearer {credential}` from the custom-header merge —
    // both headers, same value.
    base["x-api-key"] = credStr;
    base["authorization"] = `Bearer ${credStr}`;
  }
  base["anthropic-version"] = ANTHROPIC_VERSION;

  return base;
}

function buildTraceHeaders(
  route: RouteKind,
  layers: LayerFlags,
  clientSession?: UpstreamClientSession,
): Record<string, string> {
  if (shouldUseExactTraceHeaders(route, clientSession)) {
    // Degenerate bodies (lineage failed) and requestId-only requests resolve
    // to an exact context with NO session id — coding-plan would then ship
    // without x-session-id and signing would skip (client-signing requires
    // it), violating the "coding-plan 必签" invariant. Synthesize like the
    // fallback branch; routes that never sign (start-plan / off-peak /
    // highspeed) keep the omission.
    //
    // 这条件是 `layers.signing` 而不是 `sessionAffinity`：合成的唯一用处是喂签名
    // （client-signing 必须有 sessionId），而"要不要推断 session"是另一件事。
    const sessionId = sessionIdForHeader(clientSession)
      ?? (layers.signing ? crypto.randomUUID() : undefined);
    return buildZcodeTraceHeaders({
      requestId: clientSession?.requestId,
      traceId: clientSession?.traceId,
      queryId: clientSession?.queryId,
      sessionId,
      ...(clientSession?.sessionType ? { sessionType: clientSession.sessionType } : {}),
    });
  }

  const headers: Record<string, string> = {
    "x-request-id": crypto.randomUUID(),
    // ZCode 3.9.1 attributes every model request; a forwarded conversation turn is the main-agent loop.
    "x-zcode-session-type": "main",
    "x-zcode-trace-id": crypto.randomUUID(),
  };
  // 会话亲和（`sessionAffinity`）：推断一份 query/session id 一起发。
  if (layers.sessionAffinity) {
    headers["x-query-id"] = crypto.randomUUID();
    headers["x-session-id"] = crypto.randomUUID();
  }
  return headers;
}

/**
 * Apply `identity.betaPolicy` to the client's raw `anthropic-beta` value.
 *
 * Why this is not a pass-through: Claude Code ships a dozen betas on
 * `/v1/messages`, and two of them
 * (`claude-code-20250219`, `oauth-2025-04-20`) state outright which client is
 * calling — while the request carries `User-Agent: ZCode/…`. The official
 * ZCode CLI sends **no** beta unless tool search is on (then exactly
 * `advanced-tool-use-2025-11-20`), so mirroring it means sending none.
 *
 * Returns the value to ship, or `""` when nothing survives (the caller then
 * omits the header entirely — a present-but-blank header is itself a shape no
 * real client produces).
 *
 * Comparison is case-insensitive on both sides: header names are already
 * lowercased by the Fetch API, and the loader normalizes `betaAllowlist`
 * entries to lowercase, so only the client's values need downcasing here.
 */
function filterAnthropicBeta(value: string, identity: ProxyIdentity): string {
  if (identity.betaPolicy === "drop") return "";
  const allowed = new Set(identity.betaAllowlist);
  return value
    .split(ANTHROPIC_BETA_SEPARATOR)
    .map((beta) => beta.trim())
    // Blank entries (`""` from an empty header, `"a,,b"`, `" , "`) would
    // otherwise rejoin as empty header values.
    .filter((beta) => beta !== "" && allowed.has(beta.toLowerCase()))
    .join(ANTHROPIC_BETA_SEPARATOR);
}

/**
 * Client headers that may reach the upstream wire, keyed by lowercased name,
 * each with the filter that decides what actually ships.
 *
 * This is an explicit allowlist: client auth, routing auth, trace and V4
 * signing headers are never forwarded — their trusted values are rebuilt in
 * `buildAuthHeaders`. `anthropic-beta` is the only entry, and it is filtered
 * rather than copied.
 */
const PASSTHROUGH_HEADERS: ReadonlyArray<readonly [string, (value: string, identity: ProxyIdentity) => string]> = [
  [ANTHROPIC_BETA_HEADER, filterAnthropicBeta],
];

function collectPassthroughHeaders(
  req: Request,
  identity: ProxyIdentity,
): Record<string, string> {
  const result: Record<string, string> = {};
  // `Headers.get` is case-insensitive, so `Anthropic-Beta` / `ANTHROPIC-BETA`
  // from the client all land on the same entry.
  for (const [name, filter] of PASSTHROUGH_HEADERS) {
    const raw = req.headers.get(name);
    if (raw === null) continue;
    const value = filter(raw, identity);
    if (value !== "") result[name] = value;
  }
  return result;
}

export function buildUpstreamHeaderPairs(
  clientReq: Request,
  cred: Credential,
  identity: ProxyIdentity,
  route: RouteKind,
  extraHeaders?: Record<string, string>,
  clientSession?: UpstreamClientSession,
): UpstreamHeaderPair[] {
  // Forward the client's Accept-Encoding so the upstream compresses only when
  // the client can decode it. Hardcoding "gzip" broke clients (e.g. some Tauri
  // builds) that send `accept-encoding: identity` and cannot auto-decompress.
  const clientAcceptEncoding = clientReq.headers.get("accept-encoding") ?? "gzip";
  return [
    ["content-type", "application/json"],
    ["accept-encoding", clientAcceptEncoding],
    ...Object.entries(collectPassthroughHeaders(clientReq, identity)),
    ...Object.entries(buildAuthHeaders(cred, identity, route, clientSession)),
    ...Object.entries(extraHeaders ?? {}),
  ];
}

export function buildUpstreamRequest(
  clientReq: Request,
  baseUrl: string,
  cred: Credential,
  body: string | undefined,
  identity: ProxyIdentity,
  route: RouteKind,
  extraHeaders?: Record<string, string>,
  clientSession?: UpstreamClientSession,
): Request {
  const url = buildUpstreamURL(baseUrl);
  const headerPairs = buildUpstreamHeaderPairs(clientReq, cred, identity, route, extraHeaders, clientSession);

  const init: RequestInit = {
    method: "POST",
    headers: Object.fromEntries(headerPairs),
  };

  if (body !== undefined) {
    init.body = body;
  }

  return new Request(url, init);
}
