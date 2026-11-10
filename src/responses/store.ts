/**
 * In-memory response store for the Responses API's `previous_response_id`.
 *
 * The Responses API is stateful: a client passes `previous_response_id`, and
 * the server is expected to reconstruct the full conversation from that stored
 * response. The upstream here takes a whole conversation per call (Chat
 * Completions), so the proxy keeps the history itself — store each completed
 * response keyed by id, and on the next request prepend the stored `input[]` +
 * `output[]` history so the upstream sees a complete conversation.
 *
 * Backed by a bounded LRU cache with TTL eviction. Process restart drops
 * everything (a known limitation: OpenAI keeps responses for ~30 days, which
 * would need a persistence layer this proxy does not have).
 *
 * Thread-safety: single-process; JS event loop serialises access.
 */

import type { ResponsesInputItem, ResponsesOutputItem, ResponsesUsage } from "../translator/responses-types.js";
import type { RouteKind } from "../accounts/types.js";

/**
 * A stored response entry — enough to reconstruct the next turn's history,
 * plus the `(account, route)` that produced it.
 *
 * `accountId` / `routeKind` are the continuation pin. `previous_response_id` is
 * stateful: the upstream conversation lives on one account, so the next turn
 * must go back to the same `(account, route)`.
 * Re-dispatching it through the scheduler would silently change accounts and
 * break the upstream-side state, along with the risk-control session namespace
 * (sessions are kept per account).
 */
export interface StoredResponse {
  id: string;
  model: string;
  status: "completed" | "incomplete" | "failed";
  input: ResponsesInputItem[];
  output: ResponsesOutputItem[];
  usage?: ResponsesUsage;
  instructions?: string;
  createdAt: number;
  lastAccessedAt: number;
  /** 产出这条响应的账号（`Account.id`，不是 label）。续轮钉号用。*/
  accountId: string;
  /** 产出这条响应的路由：状态化的续轮必须回到同一条路由。*/
  routeKind: RouteKind;
}

export interface ResponseStoreOptions {
  /** Max entries before LRU eviction. Default 1000. */
  maxEntries?: number;
  /** TTL in ms before an entry is considered stale. Default 24h. */
  ttlMs?: number;
}

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Bounded LRU + TTL cache of stored responses. Iteration order = insertion
 * order; `get()` re-inserts to refresh LRU position. Stale entries are evicted
 * lazily on access and proactively on `set()` overflow.
 */
export class ResponseStore {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly map = new Map<string, StoredResponse>();

  constructor(opts: ResponseStoreOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** Store a response. Overwrites on duplicate id. Evicts LRU entries on overflow. */
  set(entry: StoredResponse): void {
    const now = Date.now();
    entry.createdAt = now;
    entry.lastAccessedAt = now;
    if (this.map.has(entry.id)) this.map.delete(entry.id);
    this.map.set(entry.id, entry);
    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
  }

  /**
   * Fetch a stored response. Returns `undefined` when missing or stale.
   * Refreshes LRU position on hit.
   */
  get(id: string): StoredResponse | undefined {
    const entry = this.map.get(id);
    if (!entry) return undefined;
    const now = Date.now();
    if (now - entry.createdAt > this.ttlMs) {
      this.map.delete(id);
      return undefined;
    }
    entry.lastAccessedAt = now;
    // Re-insert at the tail so the LRU eviction touches it last.
    this.map.delete(id);
    this.map.set(id, entry);
    return entry;
  }

  delete(id: string): boolean {
    return this.map.delete(id);
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }
}
