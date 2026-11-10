/**
 * 选号：三种策略 + `withinTier` + 轮转游标。
 *
 * 本模块只做一件事：给同一档路由的候选排出一个顺序，由 `broker.ts` 按顺序占槽
 * （首选满了要不要等，是 `onSaturated` / `stickiness.onSaturated` 的事，不是这里的
 * 事）。所以排序是纯函数，可以独立测；饱和、排队、冷却留在 broker。
 *
 * 排序分三层，各自回答一个问题（`withinTier` × `strategy` 的取值组合见下表）：
 *
 * | 层 | 旋钮 | 回答 |
 * |---|---|---|
 * | 档间 | `routing.order`（broker 消费） | 哪一档先试 |
 * | 档内主序 | `withinTier` | 同一档里先试谁 |
 * | 档内平手 | `strategy` | 主序打平时谁在前 |
 *
 * `withinTier` 的三个取值决定 `strategy` 坐在哪一层：
 *
 * | `withinTier` | 主序 | `strategy` 的位置 |
 * |---|---|---|
 * | `sticky`（默认） | 粘性哈希 | 不参与，哈希给出全序 |
 * | `drain-first` | 已知的按 `expiresAt` 升序在前；未知的排后，彼此按 `strategy` 序 | 平手判据，兼未知组的全序 |
 * | `strategy` | `strategy` | 就是主序 |
 *
 * `sticky` 是强制粘性：按哈希排，`strategy` 不参与，因为哈希给出全序，没有平手可判。
 * `drain-first` 的主序分两段：有采样结果的账号按 `expiresAt` 升序在前，
 * 没有采样结果的排在已知之后、彼此按 `strategy` 序分散。已知账号被烧干或占满之后，
 * 接棒的是散开的未知组：它们拿到流量就会被采样，下一轮排序就有了数据。若未知组
 * 固定成同一个顺序，数据稀疏时流量会一直堆在同一个账号上，采样数据永远补不齐。
 *
 * | `strategy` | 平手时的顺序 | 风控含义 |
 * |---|---|---|
 * | `sticky-hash`（默认） | rendezvous 哈希 `sessionId → account` 排序 | 同一会话永不跨账号 |
 * | `balanced` | 在飞数最少者优先，平手按权重轮转 | **仅在明确接受跨账号漂移时启用** |
 * | `round-robin` | 按权重计数轮转 | 压测/基准用，生产不推荐 |
 *
 * `sticky-hash` 用 rendezvous（最高随机权重）哈希而不是 `hash % n`：后者的映射在
 * 候选集变化时**整体重排**，删一个账号会让所有会话换号；rendezvous 的性质是
 * "只有原本落在这个账号名下的会话重绑"。
 *
 * 权重（`policy.weight`，可运行时调）在三种策略里都生效：
 * - `sticky-hash`：加权 rendezvous（`-w / ln(u)`），权重大 → 分到更多会话；
 * - `balanced` / `round-robin`：加权环，一个权重 5 的账号在环里占 5 格。
 *
 * 权重 ≥ 1 由写入校验保证（`manager.ts::validatePolicy`），所以环长恒 ≥
 * 候选数 ≥ 1，这里不再写"权重为 0 怎么办"的兜底。
 */
import { createHash } from "node:crypto";
import type { RoutingStrategy, WithinTierOrder } from "./routing.js";
import type { Account, RouteKind } from "./types.js";

/**
 * rendezvous 哈希的种子。
 *
 * 混进哈希输入是为了**给算法本身一个版本号**：将来若改哈希形态（换位宽、换公式），
 * 改这个字符串就等于"全体会话重新洗牌"，而不是让新旧两种算法在同一个键空间里
 * 悄悄混着算。
 */
const STICKY_HASH_SEED = "zcode-accounts/sticky-hash/v1";

/** 哈希取前 8 个 hex（32 bit）当随机源。 */
const HASH_HEX_CHARS = 8;

/** 32 bit 的取值空间（`u` 归一化的分母）。 */
const HASH_SPACE = 0x1_0000_0000;

/** 策略读调度状态的口子（broker 注入，避免本模块依赖租约池与覆盖层）。 */
export interface CandidateView {
  /** 生效权重（优先级链算完之后的值）。 */
  weight(account: Account): number;
  /** 该 `(account, route)` 当前在飞数。 */
  inflight(accountId: string, route: RouteKind): number;
  /**
   * 该 `(account, route)` 的额度过期时刻（Unix ms）。
   *
   * `undefined` = 没有采样结果。本模块不自己读额度：采样是后台任务，排序必须是
   * 纯函数。
   */
  expiresAt(accountId: string, route: RouteKind): number | undefined;
}

/** 一次排序的输入。 */
export interface OrderInput {
  /** 档内主序打平时的判据，或 `withinTier: strategy` 时的主序本身。*/
  strategy: RoutingStrategy;
  /** 档内主序：`sticky` 强制粘性，`drain-first` 先看过期时间，`strategy` 交给 `strategy`。*/
  withinTier: WithinTierOrder;
  route: RouteKind;
  /**
   * 粘性键。`undefined` = 本请求推断不出会话身份、不参与粘性：
   * `sticky-hash` 没有哈希输入，退化为 `balanced`（在飞最少者）。
   */
  sessionId?: string;
  /** 轮转位置（`round-robin` / `balanced` 平手），见 {@link StrategyRotation}。 */
  position: number;
}

/**
 * 轮转游标：每条路由一个位置，**只在真的选出账号后推进**。
 *
 * 只推进不预读，是为了让"排队唤醒时重算候选"保持确定性：等待中的请求反复调用
 * 排序函数（每次唤醒一次）不该把轮转位置也一起推走，否则同一批排队者会看到
 * 彼此错位的环，`round-robin` 的分布就不可复现了。
 */
export class StrategyRotation {
  private readonly positions = new Map<RouteKind, number>();

  /** 当前轮转位置（不推进）。 */
  peek(route: RouteKind): number {
    return this.positions.get(route) ?? 0;
  }

  /** 成功选号后推进一格。 */
  advance(route: RouteKind): void {
    this.positions.set(route, this.peek(route) + 1);
  }
}

/**
 * 按策略给候选排序（首选在前）。
 *
 * 纯函数：同样的候选集 + 同样的 `position` 一定给出同样的顺序。broker 靠这一点
 * 在排队唤醒时重复计算而不产生漂移。
 */
export function orderCandidates(
  candidates: readonly Account[],
  input: OrderInput,
  view: CandidateView,
): Account[] {
  // 档内主序交给 `strategy`：这是 `balanced` / `round-robin` 唯一的入口。
  // 与 `sticky` 的差别只在「有 sessionId 时用不用哈希」：`strategy: balanced` 就是
  // 均衡，不因为请求带了粘性键而改判。
  if (input.withinTier === "strategy") {
    return orderByStrategy(candidates, input, view);
  }
  // 档内主序：`drain-first` 把过期时间放在最前，权益会作废的账号先烧；
  // 平手与未知组的全序都交给 `strategy`，所以基线先按 `strategy` 算一遍。
  if (input.withinTier === "drain-first") {
    const baseline = orderByStrategy(candidates, input, view);
    return orderByExpiry(baseline, input, view);
  }
  // `sticky` 是强制粘性：哈希给出全序，`strategy` 不参与。
  // 没有 sessionId 就没有哈希输入（推断不出会话身份的请求不参与粘性），
  // 此时按"在飞最少者"排：粘性无从谈起，均衡是唯一有意义的读法。
  if (input.sessionId === undefined) {
    return orderBalanced(candidates, input, view);
  }
  return orderStickyHash(candidates, input.sessionId, view);
}

/**
 * 按 `strategy` 排序：`withinTier: strategy` 的主序，也是 `drain-first` 的平手基线。
 *
 * 纯函数：同样的候选集与 `position` 一定给出同样的顺序，所以拿它当基线的
 * `orderByExpiry` 也是确定的。
 */
function orderByStrategy(
  candidates: readonly Account[],
  input: OrderInput,
  view: CandidateView,
): Account[] {
  switch (input.strategy) {
    case "sticky-hash":
      // 没有粘性键时 `sticky-hash` 无法算分，退化为均衡。
      if (input.sessionId === undefined) {
        return orderBalanced(candidates, input, view);
      }
      return orderStickyHash(candidates, input.sessionId, view);
    case "balanced":
      return orderBalanced(candidates, input, view);
    case "round-robin":
      return orderWeightedRing(candidates, input.position, view);
  }
}

/**
 * `sticky-hash`：加权 rendezvous 哈希。
 *
 * 每个候选算一个分数 `-w / ln(u)`，`u = (hash(seed, sessionId, accountId) + 0.5) / 2^32`
 * 落在 `(0, 1)`，取分数最高者。两个性质正好是选号要的：
 *
 * - **稳定**：同一 `sessionId` + 同一账号集合 → 同一账号，不需要共享表；
 * - **只影响自己名下**：删掉账号 X 时，只有原本分数最高的是 X 的会话会改判，
 *   其余会话的最高分账号不变（rendezvous 的经典性质）。
 *
 * `+0.5` 是为了把 `u` 从 `[0, 1)` 挪进 `(0, 1)`：`u = 0` 会让 `ln(u) = -Infinity`
 * 把分数算成 0，从而让一个账号永远拿不到会话。
 */
function orderStickyHash(
  candidates: readonly Account[],
  sessionId: string,
  view: CandidateView,
): Account[] {
  return [...candidates]
    .map((account) => ({ account, score: rendezvousScore(sessionId, account, view.weight(account)) }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.account);
}

/**
 * `drain-first`：同一档里先烧最快过期的账号。
 *
 * 排序分两段：已知 `expiresAt` 的账号在前，按过期时间升序；没有采样
 * 结果的排在已知之后，彼此保持 `baseline`（`strategy`）序。
 *
 * 未知仍排在已知之后：把未知当 0 会让一个刚导入、还没采过额度的账号抢在所有账号
 * 前面，而「不知道」不等于「快过期」。未知彼此按 `baseline` 分散，是给
 * 采样闭环留的出路：已知账号被烧干或占满之后，流量按哈希/轮转散到
 * 多个未采样账号上，它们被采样后下一轮就有了过期时间，进已知组参与升序。
 *
 * 入参 `baseline` 是 {@link orderByStrategy} 的产物，即候选集的一个排列；沿它分组，
 * 两个组天然继承 baseline 序，所以过期时间相同的已知账号与整段未知组都是确定、
 * 可复现的。
 */
function orderByExpiry(
  baseline: readonly Account[],
  input: OrderInput,
  view: CandidateView,
): Account[] {
  const known: Array<{ account: Account; expiresAt: number }> = [];
  const unknown: Account[] = [];
  for (const account of baseline) {
    const expiresAt = view.expiresAt(account.id, input.route);
    if (expiresAt === undefined) unknown.push(account);
    else known.push({ account, expiresAt });
  }
  // 稳定排序：过期时间相同的已知账号保持 baseline 里的先后（平手交给 strategy）。
  known.sort((left, right) => compareKnownExpiry(left.expiresAt, right.expiresAt));
  return [...known.map((entry) => entry.account), ...unknown];
}

/**
 * 已知过期时间之间的升序比较。`undefined` 到不了这里：已知与未知由
 * {@link orderByExpiry} 分组处理，分组之后剩下的比较只发生在两个已知值
 * 之间。
 */
function compareKnownExpiry(left: number, right: number): number {
  return left - right;
}

function rendezvousScore(sessionId: string, account: Account, weight: number): number {
  const digest = createHash("sha256")
    .update(`${STICKY_HASH_SEED}\u0000${sessionId}\u0000${account.id}`, "utf-8")
    .digest("hex");
  const u = (Number.parseInt(digest.slice(0, HASH_HEX_CHARS), 16) + 0.5) / HASH_SPACE;
  // u ∈ (0,1) ⇒ ln(u) < 0 ⇒ 分数为正，且权重越大分数越大。
  return -weight / Math.log(u);
}

/**
 * `balanced`：在飞数最少者优先，**平手**按权重环轮转。
 *
 * 平手时用轮转而不是"永远取候选集第一个"：后者在完全空闲的一组账号上会把所有
 * 新会话都压在第一个账号，直到它满了才换，那是最坏的风控分布（单账号突然吃满）。
 *
 * 只有**最少在飞**的那一组用当前轮转位置，其余分组按位置 0 排（它们只是首选满了
 * 之后的溢出顺序，分布不重要）。
 */
function orderBalanced(
  candidates: readonly Account[],
  input: OrderInput,
  view: CandidateView,
): Account[] {
  const groups = new Map<number, Account[]>();
  for (const account of candidates) {
    const load = view.inflight(account.id, input.route);
    const bucket = groups.get(load);
    if (bucket) bucket.push(account);
    else groups.set(load, [account]);
  }

  const ordered: Account[] = [];
  const byLoad = [...groups.entries()].sort((left, right) => left[0] - right[0]);
  for (const [load, group] of byLoad) {
    const position = load === byLoad[0][0] ? input.position : 0;
    ordered.push(...orderWeightedRing(group, position, view));
  }
  return ordered;
}

/**
 * 加权环轮转：权重 5 的账号在环里占 5 格，从 `position` 起依次取，去重后成序。
 *
 * 环内**按权重降序**铺开（`sort` 是稳定排序，同权重保持候选集顺序）：这样位置 0
 * 的第一次选号落在权重最高的账号上（"平手按权重"的直觉读法），而长期比例仍是
 * `weight_i / Σweight`（环是循环的，起点在哪不影响占比）。
 */
function orderWeightedRing(
  candidates: readonly Account[],
  position: number,
  view: CandidateView,
): Account[] {
  const ring: Account[] = [];
  const byWeight = [...candidates].sort((left, right) => view.weight(right) - view.weight(left));
  for (const account of byWeight) {
    const weight = view.weight(account);
    for (let slot = 0; slot < weight; slot++) ring.push(account);
  }

  const start = ((position % ring.length) + ring.length) % ring.length;
  const ordered: Account[] = [];
  const seen = new Set<Account>();
  for (let step = 0; step < ring.length; step++) {
    const account = ring[(start + step) % ring.length];
    if (seen.has(account)) continue;
    seen.add(account);
    ordered.push(account);
  }
  return ordered;
}
