/**
 * 并发租约与有界队列。
 *
 * 槽位池的键是 `(accountId, routeKind)`，不是账号：同一份凭据的
 * `coding-plan` 与 `start-plan` 打的是不同上游端点、吃的是不同套餐额度，共用一个
 * 计数器会把两条路由的并发互相挤掉。
 *
 * 五条硬约束，逐条对应代码：
 *
 * 1. **槽位在整个上游占用期间持有**（含流式输出）。所以 `release` 必须挂在响应体上
 *    （`proxy/lease.ts::withLeaseRelease`），不能在 handler 返回时释放，挂早了
 *    在飞数被低估，正好踩并发上限的风控线。
 * 2. **全局上限** `routing.maxTotalInflight` 由本模块统一执行：账号级调大
 *    不可能突破它，因为每一次占槽都要过 `totalLimit` 这一关。
 * 3. **队列有界**（`routing.maxQueue`）：满了直接抛 `queue-full`，上层映射 429，
 *    不排队：无界队列会把内存和用户耐心一起耗光，而排队本身不改变上游能力。
 * 4. **等待有超时**（`routing.queueTimeoutMs`）：超时抛 `queue-timeout`，上层 429
 *    带 `Retry-After`。
 * 5. **排队期间不占槽，只计队列深度**：`inflight` 只在 `tryAcquire` 成功后
 *    加一，等待者只是 `waiters` 里的一条记录。
 *
 * 热调节的语义：
 *
 * | 操作 | 在飞 | 排队者 |
 * |---|---|---|
 * | 调大并发 | 不打断 | `notifyCapacity()` 立即唤醒，重算候选后占槽 |
 * | 调小并发 | **不打断**（本模块从不碰已在飞的计数） | 不被驱逐，只是新槽位释放得更慢 |
 * | 并发设 0 / 禁用 | 不打断（软禁用）或 `forceRelease` 中止 | 唤醒后重算候选 → 转移同路由其他账号；无可用账号则等超时 429 |
 *
 * 上限本身**不存在这里**：`limit` / `totalLimit` 由调用方（`broker.ts`）按当前生效
 * 策略算好传进来。这样"运行时改并发"只需要改覆盖层，不需要同步两份计数器；也让
 * 等待者每次被唤醒都按**最新**上限判定，而不是入队时的旧快照（调小之后
 * 排队者必须按新上限继续等）。
 */
import type { RouteKind } from "./types.js";
import { DEFAULT_MAX_QUEUE, DEFAULT_QUEUE_TIMEOUT_MS } from "./routing.js";

/**
 * 队列被拒的原因码，供上层映射 HTTP 语义。
 *
 * `queue-full` 与 `queue-timeout` 都是 429 `accounts_saturated`，分开是为了让日志
 * 与面板能回答"是队列太短还是账号太慢"：这两个数字调的方向正好相反。
 */
export type LeaseRejectionCode = "queue-full" | "queue-timeout" | "aborted";

/** 取不到槽位。上层（`proxy/lease.ts`）把它翻成 429 + `Retry-After`。*/
export class LeaseRejectedError extends Error {
  constructor(
    readonly code: LeaseRejectionCode,
    message: string,
    /** 建议客户端多久后重试（秒），映射成 `Retry-After`。*/
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = "LeaseRejectedError";
  }
}

/** 一次占槽请求的输入。上限由调用方按当前生效策略算好（见文件头）。*/
export interface SlotRequest {
  accountId: string;
  route: RouteKind;
  /** 该 `(account, route)` 的并发上限。`0` = 软禁用（`setAccountConcurrency(0)`）。*/
  limit: number;
  /** 全局在飞上限。*/
  totalLimit: number;
  /** 客户端 abort：排队时立即退出，占槽后立即释放。*/
  signal?: AbortSignal;
}

/**
 * 一个已占用的槽位。
 *
 * `signal` 是**租约自己的** AbortSignal：force 禁用会 abort 它，调用方把它
 * 接到上游 fetch 上，正在飞的请求当场断流（这是 force 与 drain 的唯一区别）。
 * 它同时跟随调用方给的 `signal`（客户端断开 → 立即释放）。
 */
export interface SlotLease {
  readonly accountId: string;
  readonly route: RouteKind;
  readonly signal: AbortSignal;
  /** 幂等：重复调用不重复计数。*/
  release(): void;
}

/** 队列参数。做成函数是因为它们可以运行时改（每处现读配置）。*/
export interface QueueLimits {
  maxQueue(): number;
  queueTimeoutMs(): number;
}

/** 未注入配置时的队列参数（内置默认值）。*/
export const DEFAULT_QUEUE_LIMITS: QueueLimits = {
  maxQueue: () => DEFAULT_MAX_QUEUE,
  queueTimeoutMs: () => DEFAULT_QUEUE_TIMEOUT_MS,
};

/** 一条排队记录。*/
interface Waiter {
  /**
   * 重算候选并尝试占槽。**每次被唤醒都会重新调用**，所以：
   * - 上限调大 → 这次调用就会成功（调大时立即唤醒）；
   * - 账号被禁用 → 候选集里已经没有它，自动转移到同路由其他账号；
   * - 上限调小 → 这次调用失败，继续等（不驱逐）。
   *
   * 返回值是"占到的东西"（`broker.ts` 用它携带选中的账号）；`null` = 没占到。
   */
  attempt(): unknown | null;
  /** 占到时回填（方法语法是有意的：参数双向变体让泛型 `T` 能直接挂上来）。*/
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
  cleanup(): void;
}

/** 槽位池键。`\u0000` 分隔，账号 id 与路由名里都不会出现 NUL。*/
function poolKey(accountId: string, route: RouteKind): string {
  return `${accountId}\u0000${route}`;
}

/**
 * 租约管理器：槽位计数 + 有界队列 + 唤醒。
 *
 * 它**不认识账号**（不知道权重、不知道谁被禁用），只知道"哪个池里现在几个在飞"。
 * 选谁、为什么选它，是 `broker.ts` 的事；这里只负责"能不能占、占不到怎么等"。
 * 这条边界让排队逻辑可以独立测试（不构造账号仓），也让 broker 的候选集逻辑不用
 * 关心定时器。
 */
export class LeaseManager {
  /** 每个 `(account, route)` 的在飞数。没有条目 = 0。*/
  private readonly inflightByPool = new Map<string, number>();
  /** 全部在飞的租约，供 force 禁用按账号中止。*/
  private readonly active = new Set<SlotLease>();
  /** 每份租约的 abort 控制器（`SlotLease.signal` 的来源）。*/
  private readonly controllers = new Map<SlotLease, AbortController>();
  private readonly waiters: Waiter[] = [];
  private inflightTotal = 0;

  constructor(private readonly limits: QueueLimits = DEFAULT_QUEUE_LIMITS) {}

  /** 某 `(account, route)` 的在飞数（控制面/候选集过滤用）。*/
  inflight(accountId: string, route: RouteKind): number {
    return this.inflightByPool.get(poolKey(accountId, route)) ?? 0;
  }

  /** 全局在飞数（全局并发上限的执行值，控制面「全局并发与队列深度」）。*/
  totalInflight(): number {
    return this.inflightTotal;
  }

  /** 队列深度。*/
  queueDepth(): number {
    return this.waiters.length;
  }

  /**
   * 非阻塞占槽：有槽立刻占，没有返回 `null`。
   *
   * 返回 `null` 的三种原因（调用方不需要区分，候选集计算时已经知道是哪种）：
   * 该池到上限、全局到上限、`limit === 0`（软禁用）。
   */
  tryAcquire(request: SlotRequest): SlotLease | null {
    if (request.signal?.aborted) return null;
    if (request.limit <= 0) return null;
    if (this.inflightTotal >= request.totalLimit) return null;
    const key = poolKey(request.accountId, request.route);
    const current = this.inflightByPool.get(key) ?? 0;
    if (current >= request.limit) return null;

    this.inflightByPool.set(key, current + 1);
    this.inflightTotal += 1;

    const controller = new AbortController();
    let released = false;
    let detachExternal: (() => void) | undefined;

    const lease: SlotLease = {
      accountId: request.accountId,
      route: request.route,
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        detachExternal?.();
        this.inflightByPool.set(key, Math.max(0, (this.inflightByPool.get(key) ?? 0) - 1));
        this.inflightTotal -= 1;
        this.active.delete(lease);
        this.controllers.delete(lease);
        // 释放即"可能有余量"：唤醒排队者重算候选。
        this.drain();
      },
    };

    // 客户端 abort：立即释放，不等流自然结束。排队路径由 wait() 处理。
    const external = request.signal;
    if (external) {
      const onAbort = (): void => {
        controller.abort(new Error("client aborted"));
        lease.release();
      };
      external.addEventListener("abort", onAbort, { once: true });
      detachExternal = () => external.removeEventListener("abort", onAbort);
    }

    this.active.add(lease);
    this.controllers.set(lease, controller);
    return lease;
  }

  /**
   * 排队等待一个槽位（队列有界 + 等待超时；排队期间不占槽）。
   *
   * 先试一次 `attempt`：有空槽就不进队列（绝大多数请求走这条路，队列只是故障时
   * 的缓冲）。真的没槽才入队，并按 `maxQueue` 判满、按 `queueTimeoutMs` 判超时。
   *
   * `attempt` 返回非 `null` 即视为"占到"，返回值由调用方决定（`broker.ts` 用它
   * 携带"这次选中的账号"，因为唤醒后可能换成了同路由的另一个账号）。
   */
  wait<T>(attempt: () => T | null, signal?: AbortSignal): Promise<T> {
    const immediate = attempt();
    if (immediate !== null) return Promise.resolve(immediate);

    if (signal?.aborted) {
      return Promise.reject(new LeaseRejectedError("aborted", "client aborted while waiting for a slot", 1));
    }

    const maxQueue = this.limits.maxQueue();
    if (this.waiters.length >= maxQueue) {
      return Promise.reject(
        new LeaseRejectedError(
          "queue-full",
          `concurrency queue is full (maxQueue=${maxQueue})`,
          retryAfterSeconds(this.limits.queueTimeoutMs()),
        ),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = this.limits.queueTimeoutMs();
      const waiter: Waiter = {
        attempt: () => attempt(),
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timer: setTimeout(() => {
          this.settle(waiter);
          reject(
            new LeaseRejectedError(
              "queue-timeout",
              `no concurrency slot became available within ${timeoutMs}ms`,
              retryAfterSeconds(timeoutMs),
            ),
          );
        }, timeoutMs),
        cleanup: () => {},
      };

      if (signal) {
        const onAbort = (): void => {
          this.settle(waiter);
          reject(new LeaseRejectedError("aborted", "client aborted while waiting for a slot", 1));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
      }

      this.waiters.push(waiter);
    });
  }

  /**
   * 立即唤醒排队者（调大并发、重新启用、禁用转移都走这里）。
   *
   * 唤醒 = 让每个排队者**重算候选**再试一次；失败就继续等（不驱逐）。这是"调大
   * 立即生效"和"禁用后转移同路由其他账号"共用的唯一机制。
   */
  notifyCapacity(): void {
    this.drain();
  }

  /**
   * force 禁用（`setAccountEnabled(label, false, { drain: false })`）：
   * 立即中止该账号的在飞请求并释放槽位。
   *
   * 返回值 = 被中止的在飞数，供控制面回报"强制断开了几个请求"。abort 会让接到
   * `SlotLease.signal` 上的上游 fetch 当场失败，客户端收到半截流，这正是 force
   * 与 drain 的区别，所以 force 必须由用户显式选择。
   */
  forceRelease(accountId: string): number {
    const victims = [...this.active].filter((lease) => lease.accountId === accountId);
    for (const lease of victims) {
      this.controllers.get(lease)?.abort(new Error(`account "${accountId}" force-disabled`));
      lease.release();
    }
    return victims.length;
  }

  /** 唤醒一轮排队者：能占就占，占不到留着等下一次。*/
  private drain(): void {
    if (this.waiters.length === 0) return;
    // 快照遍历：attempt 成功时 settle 会从数组里摘掉自己，直接遍历原数组会跳项。
    for (const waiter of [...this.waiters]) {
      if (!this.waiters.includes(waiter)) continue;
      let lease: unknown | null;
      try {
        lease = waiter.attempt();
      } catch (err) {
        // 重算候选本身炸了（存储 IO 等）：让这个排队者带着原因失败，不要静默重排。
        this.settle(waiter);
        waiter.reject(err as Error);
        continue;
      }
      if (lease !== null) {
        this.settle(waiter);
        waiter.resolve(lease);
      }
    }
  }

  /** 出队并清掉定时器/监听（幂等：已被摘掉的 waiter 再调无副作用）。*/
  private settle(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.cleanup();
  }
}

/** 毫秒 → 秒的换算（`Retry-After` 的单位是秒）。*/
const MS_PER_SECOND = 1_000;

/** `Retry-After` 的最小值（秒）：0 会被部分客户端当成"立刻重试"，反而加剧拥塞。*/
const MIN_RETRY_AFTER_SECONDS = 1;

/**
 * 排队超时/队列满时的 `Retry-After`（秒）。
 *
 * 用 `queueTimeoutMs` 而不是猜一个固定值：它表达的是"我们这个进程愿意为一个请求
 * 等多久"，客户端按同样的节奏回来最可能刚好接上。
 */
function retryAfterSeconds(waitMs: number): number {
  return Math.max(MIN_RETRY_AFTER_SECONDS, Math.ceil(waitMs / MS_PER_SECOND));
}
