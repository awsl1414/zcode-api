/**
 * 会话粘性表：`sessionId → { accountId, routeKind }`。
 *
 * 表里只有**绑定**，没有账号与健康状态：一条绑定"还有没有效"必须由调用方
 * （`broker.ts`）用账号仓、路由白名单、健康表一起判；本模块只回答"这个会话上次
 * 落在谁身上"，不做第二份真相。失效判定因此分成两层：
 *
 * | 失效条件 | 谁判 | 怎么判 |
 * |---|---|---|
 * | TTL 到期 | 本模块 | 滑动 TTL：`lastSeenAt` 超过 `ttlSeconds` 即失效 |
 * | 容量超限 | 本模块 | LRU 淘汰最久未用的绑定 |
 * | 账号禁用 / 删除 | broker | 绑定里的 `accountId` 不在账号仓 / `enabled=false` |
 * | `(account, route)` 健康失败 | broker | `HealthEngine.isAvailable()` |
 *
 * **TTL 是滑动的**（每次命中刷新），不是从绑定时刻起算的绝对期限：长对话（几十轮
 * tool call）中途失联会让上游缓存与上下文全部重来，而要限制的是**闲置**会话
 * 占表。容量上限（LRU）才是真正的资源闸门。
 *
 * `overflow` 不改写绑定：broker 只在"本次请求**新建**了绑定"
 * 时写表，溢出路径一律不写，于是下次请求仍然回到原账号。
 */
import {
  DEFAULT_STICKINESS_MAX_SESSIONS,
  DEFAULT_STICKINESS_TTL_SECONDS,
} from "./routing.js";
import type { RouteKind } from "./types.js";

/** 一条绑定的对外形状。 */
export interface StickyBinding {
  accountId: string;
  routeKind: RouteKind;
}

/** 表内记录：对外形状 + 最近一次命中的时间（TTL 用）。 */
interface StoredBinding extends StickyBinding {
  lastSeenAt: number;
}

/** 表参数。`now` 注入是为了测试直接跨过 TTL 窗口，不用真的等 30 分钟。 */
export interface StickinessTableOptions {
  /** 会话粘性 TTL（秒），对应 `stickiness.ttlSeconds`。 */
  ttlSeconds?: number;
  /** 表容量上限（LRU），对应 `stickiness.maxSessions`。 */
  maxSessions?: number;
  now?: () => number;
}

/**
 * 内存粘性表（动态状态不落盘）。
 *
 * 用**recency 有序的 Map**（命中时 delete + set 把它挪到队尾）：
 *
 * - TTL 清扫从队首开始，遇到第一条还新鲜的记录就停（O(过期数)）；
 * - 容量淘汰从队首弹（O(1)），不用每次全表扫描找最久未用的那条。
 */
export class StickinessTable {
  private readonly entries = new Map<string, StoredBinding>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(options: StickinessTableOptions = {}) {
    this.ttlMs = (options.ttlSeconds ?? DEFAULT_STICKINESS_TTL_SECONDS) * MS_PER_SECOND;
    this.maxSessions = options.maxSessions ?? DEFAULT_STICKINESS_MAX_SESSIONS;
    this.now = options.now ?? Date.now;
  }

  /**
   * 查绑定（命中即刷新 TTL 与 LRU 位置）。过期绑定当场删掉并返回 `undefined`。
   * 过期不是"没有绑定"之外的另一种状态，调用方只关心"能不能用"。
   */
  get(sessionId: string): StickyBinding | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    const now = this.now();
    if (now - entry.lastSeenAt > this.ttlMs) {
      this.entries.delete(sessionId);
      return undefined;
    }
    this.touch(sessionId, { ...entry, lastSeenAt: now });
    return { accountId: entry.accountId, routeKind: entry.routeKind };
  }

  /** 写绑定（覆盖旧值），并按容量 LRU 淘汰。 */
  bind(sessionId: string, accountId: string, routeKind: RouteKind): void {
    this.touch(sessionId, { accountId, routeKind, lastSeenAt: this.now() });
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** 解绑。返回是否真的删掉了一条。 */
  unbind(sessionId: string): boolean {
    return this.entries.delete(sessionId);
  }

  /**
   * 丢掉某个账号名下的**全部**绑定（禁用 / 并发设 0 时粘性绑定解绑）。
   *
   * 只在"整个账号不可用"时用。单条 `(account, route)` 冷却不走这里，那时只该
   * 解绑那一条路由的会话，让 broker 用健康判定逐条失效即可（状态键是
   * `(account, route)`，不是账号）。
   *
   * 返回清掉的条数，供控制面回报。
   */
  forgetAccount(accountId: string): number {
    let cleared = 0;
    for (const [sessionId, entry] of [...this.entries]) {
      if (entry.accountId !== accountId) continue;
      this.entries.delete(sessionId);
      cleared += 1;
    }
    return cleared;
  }

  /** 当前绑定条数（控制面 / 用例）。 */
  size(): number {
    return this.entries.size;
  }

  /** 命中：先删再插，把它挪到 recency 队尾。 */
  private touch(sessionId: string, entry: StoredBinding): void {
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
  }
}

/** 毫秒 → 秒（`ttlSeconds` 是配置单位，表内统一用毫秒）。 */
const MS_PER_SECOND = 1_000;
