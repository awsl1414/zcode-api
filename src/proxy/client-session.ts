/**
 * Local client-session inference for cache-affinity experiments.
 *
 * The resolver stores only hashes and generated IDs. It deliberately avoids
 * prompt markers, response mutation, and full prompt persistence.
 *
 * Lineage keys form a Merkle chain: chain[0] hashes the identity head
 * (format/model/system/developer/tools/tool_choice), chain[i] folds in
 * message i. One O(body) hashing pass per request then yields the exact-node
 * key AND every prefix key, so parent matching at any depth costs a single
 * Map lookup instead of re-stringifying the whole prefix.
 *
 * Both `nodes` and `sessions` are recency-ordered Maps (delete+set on touch):
 * TTL sweeps stop at the first fresh entry and cap eviction pops from the
 * front — O(expired)/O(1) instead of the former full-map scan per request.
 *
 * 一账号一 session 命名空间。
 *
 * 血缘表按 `(accountId, 血缘哈希)` 建键，`sessions` 表同理，复合键用 `\u0000`
 * 分隔（`accounts/types.ts::credentialFingerprint` 已有先例）。推断出的
 * sessionId 会写进 `x-session-id` 和 `metadata.user_id`，而同一会话在账号间
 * 跳变是上游能识别的异常。实测里血缘表没有账号维度时，同一段对话在两个账号下
 * 会拿到同一个 sessionId。
 *
 * `sessionId` 的生成种子也混入 accountId（见 `newSession`），所以两个账号对
 * 同一段对话生成不同的 id。只加复合键、不改生成逻辑是不够的：上游只看得到 id，
 * 同一个 id 挂在不同命名空间下仍然是一个 id。
 *
 * 生成形态对齐上游 `createSessionId` 的 `sess_<uuid>`。前缀写错就永远剥不掉，
 * 会原样漏给上游，细节见 `newSession` 的注释。
 *
 * 容量语义：`maxSessions` 与 `maxSessions *
 * NODES_PER_SESSION_CAP` 是进程内存上限，不是每账号配额。按账号切分会让上限
 * 乘上账号数，而账号数由用户配置决定。淘汰仍是全局 LRU 顺序（recency 有序
 * Map 的前端），只是键多了账号前缀。全局 recency 顺序保证一个账号的条目只会
 * 挤掉最久未用的条目，不会成批清空，也不会挤掉别的账号刚用过的条目。
 *
 * 选号顺序：会话键必须比 accountId 更早存在
 *
 * `proxy/handler.ts` 的顺序是「解析 body → 推断 sessionId → 路由选择 → body 改写
 * → 发出」，而上面的一账号一命名空间要求推断时就有 accountId（键与种子都要它）。
 * 选号要会话键、会话键要账号，这是一个环。
 *
 * 拆成两段就解开了：
 *
 *   `fingerprint()` 账号无关。只算 canonical 血缘链，并给这段对话一个
 *   `conv_<uuid>` 当粘性键；客户端给了会话 id 就直接用那个。不写任何账号维度的表。
 *
 *   `finalize()` 账号相关。拿到租约之后才按 `(accountId, 血缘哈希)` 解析或新建
 *   sessionId，一账号一命名空间的隔离整段落在这一段。
 *
 * 于是「粘性键」与「sessionId」是两个值：前者管选号，后者管出线归因。把两者
 * 当成一个值的前提是推断先于选号；多账号之后这个前提不成立。
 *
 * 另外两种解法为什么不用：
 *
 * - 先选号：`sticky-hash` 的哈希输入就是会话键，先选号只能退化成 `balanced`，
 *   默认的 sticky-hash 选号策略当场没了。
 * - 只用客户端给的 sessionId 当键、不做推断：不发会话头的客户端（`lineage` 的
 *   全部用户）失去粘性，`handler-stickiness.test.ts` 的端到端用例直接红。
 *
 * 代价是下面这张账号无关的 `stickyIndex`（`血缘哈希 → conv_<uuid>`）：只存哈希
 * 与键，不存账号，TTL 与容量跟血缘节点表同口径。
 *
 * `RiskReport.sessions.crossAccount` 的正确表述（`control/control.ts` 同步）：
 * 本进程的血缘表按 `(accountId, 血缘哈希)` 建键、生成 id 也带账号种子，同一个
 * sessionId 不会被两个账号复用，因此该字段恒为 0。它一旦非 0 就是血缘表或粘性表
 * 被打穿的告警，不是装饰性字段。注意 `explicit` 来源的 sessionId 是客户端自己给
 * 的，根本不进这张表，也挡不住客户端自己串号。这一点要在字段注释里写清楚，否则
 * 「恒为 0」会被读成「跨账号不可能发生」。
 */
import nodeCrypto from "node:crypto";
import type { Format } from "../translator/types.js";
import type { ClientIdentityConfig } from "../config/types.js";

export type ClientSessionSource = "none" | "explicit" | "lineage";
export type ClientSessionAction = "off" | "observe" | "enforce";

/**
 * 账号无关的会话指纹：选号之前能算出来的全部信息。
 *
 * 它刻意不含 accountId（`explicit` / `lineage` 都不含），因为 `broker.acquire()`
 * 要在拿到租约之前就拿到粘性键。
 */
export interface SessionFingerprint {
  readonly source: ClientSessionSource;
  /**
   * 粘性键：`explicit` 是客户端给的会话 id，`lineage` 是本进程为这段
   * 对话分配的 `conv_<uuid>`。`none` 没有键，那类请求按策略选号、不写绑定表。
   *
   * 与 sessionId 是两个值：这个键跨轮、跨账号都不变，sessionId 则带账号种子。
   */
  readonly stickyKey?: string;
  /** @internal canonical 血缘链（exact 在末尾）。交给 finalize 复用，避免同一请求
   *  做两次 O(body) 哈希。*/
  readonly chain?: readonly string[];
  /** @internal 显式 trace 上下文（requestId / traceId / queryId / sessionId）。*/
  readonly trace?: ExplicitTraceContext;
}

export interface ClientSessionResult {
  source: ClientSessionSource;
  action: ClientSessionAction;
  confidence: number;
  sessionId?: string;
  upstreamSessionId?: string;
  /** Explicit x-zcode-session-type override (wins over sessionId-prefix derivation). */
  sessionType?: "main" | "subagent" | "other";
  requestId?: string;
  traceId?: string;
  queryId?: string;
}

interface StoredNode {
  sessionId: string;
  upstreamSessionId: string;
  lastSeenAt: number;
}

/** `stickyIndex` 的值：这段对话的粘性键与它的活跃时间（TTL 清扫用）。*/
interface StickyEntry {
  key: string;
  lastSeenAt: number;
}

interface Recency {
  lastSeenAt: number;
}

interface CanonicalRequest {
  model: string;
  head: Record<string, unknown>;
  messages: unknown[];
}

export interface ExplicitTraceContext {
  requestId?: string;
  traceId?: string;
  queryId?: string;
  sessionId?: string;
}

export interface ClientSessionResolver {
  /**
   * 第一段（账号无关）：算出会话指纹，供 `broker.acquire()` 的粘性键使用。
   * 不写任何账号维度的表，可以在选号之前调用。
   *
   * @param body canonical body for lineage hashing — the POST-TRANSLATION
   *   Anthropic-shaped upstream body (session identity aligns with the
   *   upstream conversation, not the client dialect).
   * @param traceBody raw client body for explicit trace-metadata detection
   *   (client attribution intent lives in the client's own body; OpenAI→
   *   Anthropic translation drops foreign metadata fields). When omitted,
   *   `body` is parsed once and shared with lineage hashing.
   */
  fingerprint(req: Request, body: string | undefined, format: Format, model: string, config: ClientIdentityConfig, traceBody?: string): SessionFingerprint;
  /**
   * 第二段（账号相关）：按 `(accountId, 血缘哈希)` 解析或新建 sessionId。
   *
   * @param accountId 账号命名空间。血缘表与会话表的键、生成的 `sessionId` 都带它，
   *   同一段对话在两个账号下必须是两个会话。
   */
  finalize(accountId: string, fingerprint: SessionFingerprint, config: ClientIdentityConfig): ClientSessionResult;
  /** 两段合一。不需要拆开的调用方（测试、纯推断）用它。*/
  resolve(accountId: string, req: Request, body: string | undefined, format: Format, model: string, config: ClientIdentityConfig, traceBody?: string): ClientSessionResult;
}

/**
 * Prefix depths tried for parent matching, shallowest first. Depth 2 is the
 * canonical assistant+user turn append; 3–4 catch tool rounds that append a
 * variable number of messages (e.g. parallel tool results split across user
 * messages). A match at any depth requires the truncated prefix to have been
 * an actually-seen request node, so unrelated conversations never fuse.
 * Depth 1 is deliberately excluded: a bare single-message append is a new
 * conversation (fork isolation, see the forked-continuation test).
 */
const PARENT_DEPTHS = [2, 3, 4] as const;

/** 复合键分隔符（同 `accounts/types.ts::credentialFingerprint` 的写法）。 */
const KEY_SEPARATOR = "\u0000";

function lineageKey(accountId: string, nodeHash: string): string {
  return `${accountId}${KEY_SEPARATOR}${nodeHash}`;
}

function sessionKey(accountId: string, sessionId: string): string {
  return `${accountId}${KEY_SEPARATOR}${sessionId}`;
}

/** Hard cap on lineage nodes independent of the session cap (per-session
 * agentic rounds each store a node; 32× leaves generous headroom before an
 * active session's nodes could be LRU'd out from under it). */
const NODES_PER_SESSION_CAP = 32;

export function createClientSessionResolver(now: () => number = () => Date.now()): ClientSessionResolver {
  const nodes = new Map<string, StoredNode>();
  const sessions = new Map<string, StoredNode>();
  // 账号无关索引（模块注释「选号顺序」）：血缘哈希 → 粘性键。它不存账号，所以
  // 能在选号之前读。同一段对话的所有节点指向同一个 `conv_<uuid>`，于是粘性键
  // 跨轮稳定，而 sessionId 仍然按账号现造。
  const stickyIndex = new Map<string, StickyEntry>();

  /** Re-insert to refresh recency order (Map.set alone keeps the old slot). */
  function touch<K, V>(map: Map<K, V>, key: K, value: V): void {
    map.delete(key);
    map.set(key, value);
  }

  /** Pop oldest-first until under cap (front of a recency-ordered Map). */
  function evictOverCap<K, V>(map: Map<K, V>, cap: number): void {
    while (map.size > cap) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }

  /** Drop expired entries; recency order lets us stop at the first fresh one. */
  function sweepExpired<K, V extends Recency>(map: Map<K, V>, cutoff: number): void {
    for (const [key, entry] of map) {
      if (entry.lastSeenAt >= cutoff) break;
      map.delete(key);
    }
  }

  function remember(accountId: string, nodeHash: string, session: StoredNode, config: ClientIdentityConfig): void {
    // Keep a distinct timestamp per lineage node. Sharing this object across
    // node keys makes their timestamps advance without refreshing each Map
    // position, which breaks the ordered TTL sweep's early-exit invariant.
    const stored = { ...session, lastSeenAt: now() };
    touch(nodes, lineageKey(accountId, nodeHash), stored);
    touch(sessions, sessionKey(accountId, stored.sessionId), stored);
    // Global caps (process memory), global recency order — see the module
    // docblock: a per-account quota would multiply the ceiling by the account
    // count, while the composite key alone already keeps accounts from
    // evicting each other's *recent* entries.
    evictOverCap(sessions, config.maxSessions);
    evictOverCap(nodes, config.maxSessions * NODES_PER_SESSION_CAP);
  }

  /** 把某个血缘节点绑到粘性键上（账号无关，选号前就能做）。*/
  function rememberSticky(nodeHash: string, key: string, config: ClientIdentityConfig): void {
    touch(stickyIndex, nodeHash, { key, lastSeenAt: now() });
    evictOverCap(stickyIndex, config.maxSessions * NODES_PER_SESSION_CAP);
  }

  /** 血缘链上已绑过的粘性键（先看 exact，再看父节点）。*/
  function stickyKeyOf(chain: readonly string[], messageCount: number, config: ClientIdentityConfig): string | undefined {
    const exact = chain[chain.length - 1];
    const hit = stickyIndex.get(exact);
    if (hit) {
      touch(stickyIndex, exact, { ...hit, lastSeenAt: now() });
      return hit.key;
    }
    for (const depth of PARENT_DEPTHS) {
      const k = messageCount - depth;
      if (k < 1) continue;
      const parent = stickyIndex.get(chain[k]);
      if (!parent) continue;
      // 写穿到 exact，与 `finalize` 对血缘节点的做法对称：下一轮就命中 exact，
      // 不必再沿父链找（对话越长，父链匹配越容易越过 4 层）。
      rememberSticky(exact, parent.key, config);
      return parent.key;
    }
    return undefined;
  }

  return {
    fingerprint: fingerprintOf,
    finalize: finalizeOf,
    resolve(accountId, req, body, format, model, config, traceBody) {
      return finalizeOf(accountId, fingerprintOf(req, body, format, model, config, traceBody), config);
    },
  };

  function fingerprintOf(req: Request, body: string | undefined, format: Format, model: string, config: ClientIdentityConfig, traceBody?: string): SessionFingerprint {
    if (config.mode === "off") return { source: "none" };

    const cutoff = now() - config.ttlSeconds * 1000;
    sweepExpired(nodes, cutoff);
    sweepExpired(sessions, cutoff);
    sweepExpired(stickyIndex, cutoff);

    const traceParsed = parseJsonObject(traceBody ?? body);
    const trace = requestTraceContext(req, traceParsed);
    if (trace.sessionId) return { source: "explicit", stickyKey: trace.sessionId, trace };

    const canonical = canonicalize(traceBody === undefined ? traceParsed : parseJsonObject(body), format, model);
    if (!canonical) {
      // 没有可哈希的对话，但客户端给了 trace 头：保留归因字段，没有会话身份
      // 也就没有粘性键。
      if (hasTraceContext(trace)) return { source: "explicit", trace };
      return { source: "none", trace };
    }

    const chain = chainHashes(canonical.head, canonical.messages);
    const known = stickyKeyOf(chain, canonical.messages.length, config);
    if (known) return { source: "lineage", stickyKey: known, chain, trace };

    // 这段对话第一次出现：在这里就把它命名，而不是等拿到账号之后。键必须与
    // 账号无关，否则同一段对话换账号就会换键，粘性跟着失效。
    const minted = newConversationKey();
    rememberSticky(chain[chain.length - 1], minted, config);
    return { source: "lineage", stickyKey: minted, chain, trace };
  }

  function finalizeOf(accountId: string, fingerprint: SessionFingerprint, config: ClientIdentityConfig): ClientSessionResult {
    if (config.mode === "off") return { source: "none", action: "off", confidence: 0 };
    const trace = fingerprint.trace ?? {};
    if (fingerprint.source === "explicit") return explicitResult(trace, config);
    if (fingerprint.source === "none" || !fingerprint.chain || fingerprint.chain.length === 0) {
      return { source: "none", action: config.mode, confidence: 0 };
    }

    const chain = fingerprint.chain;
    const exactHash = chain[chain.length - 1];
    const existing = nodes.get(lineageKey(accountId, exactHash));
    if (existing) {
      remember(accountId, exactHash, existing, config);
      return withTraceContext(result("lineage", config.mode, existing, 0.95), trace);
    }

    for (const depth of PARENT_DEPTHS) {
      const k = chain.length - 1 - depth;
      if (k < 1) continue;
      const parent = nodes.get(lineageKey(accountId, chain[k]));
      if (parent) {
        remember(accountId, exactHash, parent, config);
        return withTraceContext(result("lineage", config.mode, parent, depth === 2 ? 0.9 : 0.85), trace);
      }
    }

    const fresh = newSession(accountId);
    remember(accountId, exactHash, fresh, config);
    return withTraceContext(result("lineage", config.mode, fresh, 0.75), trace);
  }
}

export const defaultClientSessionResolver = createClientSessionResolver();

function result(source: ClientSessionSource, action: ClientSessionAction, node: StoredNode, confidence: number): ClientSessionResult {
  return {
    source,
    action,
    confidence,
    sessionId: node.sessionId,
    upstreamSessionId: node.upstreamSessionId,
  };
}

// Explicit session-id headers, tool-specific before generic (first match wins).
// Evidence (2026-10-11, real-source survey):
// - x-opencode-session            OpenCode harness
// - x-claude-code-session-id      Claude Code 2.1.87+ (gateway protocol; also
//                                 paired with x-app: cli / x-stainless-*)
// - claude-code-session-id        non-x variant some Claude Code SDK clients send
// - x-vscode-sessionid            VSCode family — Google Antigravity sends it
//                                 per app launch (agproxy/Antigravity-Manager 抓包)
// - x-session-id                  generic convention
// - x-parent-session-id           subagent lineage
// - helicone-session-id           Helicone proxy convention
// Not added: x-machine-id (machine-granular — would fuse every conversation of
// a machine into one affinity session); x-claude-code-agent-id/-parent-agent-id
// (agent lineage, not conversation identity). SillyTavern has NO native session
// header (thin-server: its Express backend sends only auth/content-type plus
// user-configured additional headers — users can set x-session-id themselves).
const SESSION_ID_HEADERS = [
  "x-opencode-session",
  "x-claude-code-session-id",
  "claude-code-session-id",
  "x-vscode-sessionid",
  "x-session-id",
  "x-parent-session-id",
  "helicone-session-id",
];

function requestTraceContext(req: Request, parsed: Record<string, unknown> | undefined): ExplicitTraceContext {
  const bodyTrace = metadataTrace(parsed);
  return {
    requestId: firstHeader(req.headers, ["x-request-id", "x-client-request-id"]) ?? bodyTrace.requestId,
    traceId: firstHeader(req.headers, ["x-zcode-trace-id"]) ?? bodyTrace.traceId,
    queryId: firstHeader(req.headers, ["x-query-id"]) ?? bodyTrace.queryId,
    sessionId: firstHeader(req.headers, SESSION_ID_HEADERS)
      ?? bodyTrace.sessionId,
  };
}

function explicitResult(trace: ExplicitTraceContext, config: ClientIdentityConfig): ClientSessionResult {
  return {
    source: "explicit",
    action: config.mode,
    confidence: 1,
    ...(trace.requestId ? { requestId: trace.requestId } : {}),
    ...(trace.traceId ? { traceId: trace.traceId } : {}),
    ...(trace.queryId ? { queryId: trace.queryId } : {}),
    ...(trace.sessionId ? { sessionId: trace.sessionId, upstreamSessionId: trace.sessionId } : {}),
  };
}

function withTraceContext(session: ClientSessionResult, trace: ExplicitTraceContext): ClientSessionResult {
  if (!trace.requestId && !trace.traceId && !trace.queryId) return session;
  return {
    ...session,
    ...(trace.requestId ? { requestId: trace.requestId } : {}),
    ...(trace.traceId ? { traceId: trace.traceId } : {}),
    ...(trace.queryId ? { queryId: trace.queryId } : {}),
  };
}

function hasTraceContext(trace: ExplicitTraceContext): boolean {
  return Boolean(trace.requestId || trace.traceId || trace.queryId || trace.sessionId);
}

function firstHeader(headers: Headers, names: string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value && value.trim()) return value.trim();
  }
  return null;
}

function parseJsonObject(body: string | undefined): Record<string, unknown> | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function metadataTrace(parsed: Record<string, unknown> | undefined): ExplicitTraceContext {
  const metadata = parsed?.metadata;
  if (!metadata || typeof metadata !== "object") return {};
  const meta = metadata as Record<string, unknown>;
  return {
    requestId: stringProperty(meta, ["requestId", "request_id"]),
    traceId: stringProperty(meta, ["traceId", "trace_id"]),
    queryId: stringProperty(meta, ["queryId", "query_id"]),
    sessionId: stringProperty(meta, ["sessionId", "session_id", "conversationId", "conversation_id"]),
  };
}

function stringProperty(obj: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = obj[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function canonicalize(parsed: Record<string, unknown> | undefined, format: Format, fallbackModel: string): CanonicalRequest | null {
  if (!parsed) return null;
  const model = typeof parsed.model === "string" ? parsed.model : fallbackModel;
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  if (messages.length === 0) return null;

  const head = {
    format,
    model,
    system: parsed.system,
    developer: messages.filter((m: unknown) => typeof m === "object" && m !== null && (m as Record<string, unknown>).role === "developer"),
    tools: parsed.tools,
    tool_choice: parsed.tool_choice,
  };
  return { model, head, messages };
}

/**
 * Merkle chain over the conversation: chain[0] covers the identity head,
 * chain[i] folds in message i (index i-1 in `messages`). chain[n] is the
 * exact-request key; chain[k] is the key of "this conversation after k
 * messages" — a prefix that was itself a prior request.
 */
function chainHashes(head: Record<string, unknown>, messages: unknown[]): string[] {
  const chain: string[] = [hashJson(head)];
  for (let i = 0; i < messages.length; i++) {
    chain.push(hashString(`${chain[i]}\n${hashJson(messages[i])}`));
  }
  return chain;
}

/**
 * 这段对话的粘性键。与 sessionId 不同，它不带账号、不带前缀、不发出线：
 * 唯一的消费者是 `broker.acquire({ sessionId })`，用来把同一段对话钉到同一个账号。
 *
 * 形态写成 `conv_<uuid>` 而不是裸 UUID：它一旦出现在日志或风控报告里，得能一眼
 * 看出这不是上游会话 id（`sess_<uuid>`），否则查问题时会把两套 id 当成同一个。
 */
function newConversationKey(): string {
  return `conv_${nodeCrypto.randomUUID()}`;
}

function newSession(accountId: string): StoredNode {
  // 上游形态：`createSessionId` = `sess_${crypto.randomUUID()}`
  // （`apps/zcode-cli/packages/contracts/src/interfaces/shared.ts:31`）。前缀是
  // 必须的：`trace-headers.ts::SESSION_PREFIXES` 把 `sess_` / `subagent_agent_`
  // 从 `x-session-id` 与 `metadata.user_id.session_id` 里剥掉，官方客户端传的
  // 是“内部带前缀、出线不带前缀”的 id。以前这里生成 `ses_`，既不是上游形态，
  // 也永远不会被剥（前缀集里没有它），于是 `ses_xxxx` 原样漏给了上游。
  //
  // 命名空间隔离：accountId 进生成种子，两个账号对同一段对话拿到不同的
  // sessionId。只加复合键而不改生成逻辑是不够的，上游只看得到 id。
  // 种子过 sha256 后重新拼成 UUID 形状（8-4-4-4-12，version 4 / variant 10xx），
  // 保留官方 id 的形状特征，不做“12 位短 id”那种自制形态。
  const upstreamSessionId = nodeCrypto.randomUUID();
  return {
    sessionId: `sess_${namespacedUuid(accountId, upstreamSessionId)}`,
    upstreamSessionId,
    lastSeenAt: 0, // stamped by remember() on the injected clock
  };
}

/**
 * `sha256(accountId \0 seed)` 重新拼成 v4 UUID 形状。
 *
 * 用哈希而不是“改几个字符”：UUID 的 version/variant 半字节是形状约束，
 * 随便改会产出形状不合法的 id；哈希后重新落位既能保持形状，又能让账号维度
 * 真的进到每一个字节里。
 */
function namespacedUuid(accountId: string, seed: string): string {
  const hex = hashString(`${accountId}${KEY_SEPARATOR}${seed}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function hashJson(value: unknown): string {
  return hashString(stableStringify(value));
}

function hashString(value: string): string {
  return nodeCrypto.createHash("sha256").update(value, "utf-8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
