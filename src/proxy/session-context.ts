/**
 * Session context resolution and header-emission policy.
 *
 * Both coding-plan and start-plan call the same resolver. The config decides
 * whether inferred lineage is only observed or is forwarded upstream.
 */
import type { ProxyConfig } from "../config/types.js";
import type { RouteKind } from "../accounts/types.js";
import type { Format } from "../translator/types.js";
import {
  defaultClientSessionResolver,
  type ClientSessionAction,
  type ClientSessionResolver,
  type ClientSessionResult,
  type ClientSessionSource,
  type SessionFingerprint,
} from "./client-session.js";

export interface ResolveSessionContextInput {
  /**
   * 账号命名空间，必需参数。血缘表与会话表都按它分键，生成的
   * sessionId 也把账号混进种子，同一段对话在两个账号下必须是两个会话。
   *
   * 它要求调用方先拿到租约，所以选号用的粘性键不从这里出，而是
   * {@link inferSessionFingerprint}（账号无关，见 `client-session.ts` 的
   * 「选号顺序」）。
   */
  accountId: string;
  clientReq: Request;
  /** Canonical body for lineage hashing — post-translation Anthropic shape. */
  body: string | undefined;
  /** Raw client body for explicit trace-metadata detection (defaults to `body`). */
  traceBody?: string;
  upstreamFormat: Format;
  model: string;
  config: ProxyConfig;
  resolver?: ClientSessionResolver;
  /**
   * 选号前算好的指纹（`inferSessionFingerprint`）。传了就不重算血缘链，
   * 同一请求只做一次 O(body) 哈希。
   */
  fingerprint?: SessionFingerprint;
}

/** `inferSessionFingerprint` 的输入：除 accountId 之外与解析会话完全相同。*/
export type SessionFingerprintInput = Omit<ResolveSessionContextInput, "accountId" | "fingerprint">;

export interface SessionHeaderContext {
  source?: ClientSessionSource;
  action: ClientSessionAction;
  sessionId?: string;
  upstreamSessionId?: string;
  /** Explicit x-zcode-session-type override (wins over sessionId-prefix derivation). */
  sessionType?: "main" | "subagent" | "other";
  requestId?: string;
  traceId?: string;
  queryId?: string;
}

export function resolveSessionContext(input: ResolveSessionContextInput): ClientSessionResult | undefined {
  if (input.config.clientIdentity.mode === "off") return undefined;
  const resolver = input.resolver ?? defaultClientSessionResolver;
  const fingerprint = input.fingerprint
    ?? resolver.fingerprint(input.clientReq, input.body, input.upstreamFormat, input.model, input.config.clientIdentity, input.traceBody);
  return resolver.finalize(input.accountId, fingerprint, input.config.clientIdentity);
}

/**
 * 选号用的会话指纹：推断必须发生在路由改写之前，而选号又比 sessionId 早。
 *
 * 它只算账号无关的那一半：canonical 血缘链 + 粘性键。`accountId` 进不来，
 * 也不需要进来，这正是「选号要会话键、会话键要账号」那个环被解开的地方。
 *
 * 返回的 `stickyKey` 就是 `broker.acquire({ sessionId })` 的入参：
 *
 * - `explicit` / `lineage` → 有键，参与粘性；
 * - `none` → `undefined`，按策略选号、不写绑定表（推断失败的会话
 *   每次都是新身份，强行粘性会把互不相关的对话串到同一个账号上）；
 * - 只有 trace 头、没有会话头的请求同样没有键：`requestId` 是单次请求的归因，
 *   不是对话的键。
 *
 * 会话推断关闭（`clientIdentity.mode = "off"`）时返回 `undefined`。
 */
export function inferSessionFingerprint(input: SessionFingerprintInput): SessionFingerprint | undefined {
  if (input.config.clientIdentity.mode === "off") return undefined;
  const resolver = input.resolver ?? defaultClientSessionResolver;
  return resolver.fingerprint(input.clientReq, input.body, input.upstreamFormat, input.model, input.config.clientIdentity, input.traceBody);
}

/**
 * Exact trace headers are emitted for start-plan (never signed, so the client's
 * own trace context must survive verbatim) and whenever the client gave us an
 * explicit/enforced session context. The condition reads the route this request
 * resolved to (`lease.route`), not a process-global `plan`.
 */
export function shouldUseExactTraceHeaders(
  route: RouteKind,
  session?: SessionHeaderContext,
): boolean {
  return route === "start-plan" || hasExplicitTraceHeaders(session) || shouldForwardSessionId(session);
}

export function shouldForwardSessionId(session?: SessionHeaderContext): boolean {
  return session?.source === "explicit" || session?.action === "enforce";
}

export function sessionIdForHeader(session?: SessionHeaderContext): string | undefined {
  if (!session || !shouldForwardSessionId(session)) return undefined;
  return session.upstreamSessionId ?? session.sessionId;
}

function hasExplicitTraceHeaders(session?: SessionHeaderContext): boolean {
  return Boolean(session?.requestId || session?.traceId || session?.queryId);
}
