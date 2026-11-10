/**
 * 每账号卡槽。
 *
 * 为什么卡槽必须按账号拆：加速卡是对**某个账号** Coding Plan 权益的抽取（官方
 * 「Highspeed 与 Off-Peak Provider 是当前 Coding Plan 连接的派生执行入口，不拥有
 * 独立权益」）。进程级单实例会让两个账号互相抢卡：B 的请求拿 A 的卡去打网关，
 * 结果是 401/3402，然后 A 的卡被丢掉重抽。派生权益必须继承同账号母体，落在卡槽
 * 这一层就是「一个 accountId 一个 `HighspeedManager`」。
 *
 * 生命周期：
 *
 * | 事件 | 动作 |
 * |---|---|
 * | 账号首次出线 | `forAccount()` 懒创建（抽卡循环此时才可能点燃） |
 * | 账号被禁用 / 删除 | `reconcile()` → `stop()` 对应实例并从表里摘除 |
 * | 进程关闭 | `stopAll()`（定时器都 unref 过，但显式停一次更干净） |
 *
 * 心跳错峰：N 个账号各跑一个 ~1s 抽卡循环，如果同拍启动，
 * 上游看到的是「一台机器上 N 个客户端在同一毫秒抽卡」，这是机器特征。所以每个账号的
 * 首抽相位由 `accountId` 的哈希决定（`heartbeatPhaseOffset`），并叠加 ±10% 抖动。
 * 开关挂在 `accounts.risk.jitterHeartbeat`（默认 true）上：关掉即全部从 0 相位
 * 开始（只给排障用，正常部署不要关：那正是错峰要避免的形态）。
 */
import { createHash } from "node:crypto";
import { accountDeviceMid } from "../accounts/device-mid.js";
import type { Account } from "../accounts/types.js";
import type { AccountManager } from "../accounts/manager.js";
import { HighspeedManager } from "./manager.js";
import type { EgressOptions } from "../proxy/egress.js";
import { logger } from "../log/index.js";

/** 加速卡槽的日志。卡槽状态变化（drawn / miss / cooldown / dropped / idle-stopped）每种只报一次。*/
const log = logger("highspeed");

/** 抖动幅度：心跳间隔的 ±10%（哈希相位之外的随机量，避免相位本身可预测）。 */
const JITTER_SPAN_RATIO = 0.1;

/**
 * 账号的抽卡相位偏移。
 *
 * 三段合起来才是「错峰 + 抖动」：
 * 1. `sha256(accountId)` 的高 32 位取模心跳间隔：**确定性**相位，同一账号每次
 *    启动落在同一相位，账号之间稳定错开（纯随机相位会在进程重启后偶尔撞在一起）；
 * 2. ±10% 心跳间隔的抖动：让"相位固定"这件事本身也不可预测；
 * 3. 结果夹到 `[0, intervalMs]`，保证首抽最多推迟一个心跳，不会饿死首个请求。
 */
export function heartbeatPhaseOffset(
  accountId: string,
  intervalMs: number,
  random: () => number = Math.random,
): number {
  const digest = createHash("sha256").update(accountId, "utf-8").digest();
  const phase = digest.readUInt32BE(0) % intervalMs;
  const span = Math.round(intervalMs * JITTER_SPAN_RATIO);
  const jitter = Math.round((random() * 2 - 1) * span);
  return Math.min(intervalMs, Math.max(0, phase + jitter));
}

/** 一个账号的卡槽配置（与 `highspeed` 配置段同源）。 */
export interface HighspeedSlotsOptions {
  origin: string;
  /** 可抽卡的模型家族前缀（`highspeed.models`）。 */
  models: string[];
  /** `accounts.risk.jitterHeartbeat`（默认 true）。 */
  jitterHeartbeat: boolean;
  /** 心跳间隔（毫秒）。生产 = `DRAW_RETRY_MS`；测试注入小值。 */
  retryMs?: number;
  /** 测试缝：注入 fetch / 时钟 / 随机源。 */
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: () => number;
  onEvent?: (message: string) => void;
}

/**
 * `Map<accountId, HighspeedManager>`。
 *
 * 只做"谁有卡槽 + 卡槽何时死"，不参与路由判定：请求侧拿到 `HighspeedManager`
 * 之后照旧 `isEligibleModel` / `activeCardFor`，出线切换在 `proxy/handler.ts`。
 */
export class HighspeedSlots {
  private readonly managers = new Map<string, HighspeedManager>();
  private readonly options: HighspeedSlotsOptions;
  private readonly intervalMs: number;

  constructor(options: HighspeedSlotsOptions) {
    this.options = options;
    this.intervalMs = options.retryMs ?? 1_000;
  }

  /**
   * 该账号的卡槽（懒创建）。`origin`/`models` 由构造参数决定，与账号无关。
   *
   * `egress` 是这个账号的出口代理：抽卡也是向 zcode 上游发请求，从本机
   * IP 出去就等于把「这个账号在用什么代理」这件事漏了（代理可按账号配置，所有出线点
   * 都要走它）。
   * 实例按 accountId 缓存，所以换代理要 `stopAccount` 之后重建。
   */
  forAccount(account: Account, egress?: EgressOptions): HighspeedManager {
    const existing = this.managers.get(account.id);
    if (existing) return existing;
    const manager = new HighspeedManager({
      accountId: account.id,
      origin: this.options.origin,
      models: this.options.models,
      egress,
      // 一账号一 deviceMid：指纹只能来自账号自己。没有兜底值，
      // 全局值会让 N 个账号向网关报告同一台设备。`api-key` 凭据没有身份面，
      // 抽卡请求就不带这个头。
      deviceMid: accountDeviceMid(account) ?? undefined,
      startDelayMs: this.options.jitterHeartbeat
        ? heartbeatPhaseOffset(account.id, this.intervalMs, this.options.random)
        : 0,
      // 三个可选注入项直接传：`HighspeedManager` 内部用 `??` 补默认值，
      // 传 undefined 与不传等价。
      retryMs: this.options.retryMs,
      fetchImpl: this.options.fetchImpl,
      now: this.options.now,
      onEvent: (message) => this.options.onEvent?.(`account=${account.label} ${message}`),
    });
    this.managers.set(account.id, manager);
    return manager;
  }

  /** 停掉某账号的卡槽（账号删除 / 禁用）。返回是否真的有实例被停。 */
  stopAccount(accountId: string): boolean {
    const manager = this.managers.get(accountId);
    if (!manager) return false;
    manager.stop();
    this.managers.delete(accountId);
    this.options.onEvent?.(`account=${accountId.slice(0, 8)} highspeed: card slot stopped`);
    return true;
  }

  /**
   * 按当前账号表对账：**已删除或已禁用**的账号不再持有卡槽。
   *
   * 由 `bindHighspeedSlots` 挂在账号仓的写后回调上：账号的启用状态只有账号仓
   * 知道，卡槽不猜（读一个可能已经过期的快照去决定要不要停定时器，比不停更糟）。
   */
  reconcile(accounts: readonly Account[]): void {
    const alive = new Set(accounts.filter((account) => account.enabled).map((account) => account.id));
    for (const accountId of [...this.managers.keys()]) {
      if (!alive.has(accountId)) this.stopAccount(accountId);
    }
  }

  /** 当前持有卡槽的账号（控制面展示 / 测试断言用）。 */
  accountIds(): string[] {
    return [...this.managers.keys()];
  }

  /** 停掉全部卡槽（进程关闭）。 */
  stopAll(): void {
    for (const manager of this.managers.values()) manager.stop();
    this.managers.clear();
  }
}

/** 账号级设备指纹：`api-key` 凭据没有身份面，返回 `null`，抽卡请求不带这个头。*/

// ---------------------------------------------------------------------------
// 进程级单例（配置 key 变化即重建）
// ---------------------------------------------------------------------------
/**
 * 进程级卡槽表。
 *
 * 注意这是**卡槽表的单例**，不是"单卡槽"：每个账号在表里各有自己的
 * `HighspeedManager`。要删除的是 3.15.1 那种「进程内一个 manager
 * 一份卡」的 `getDefaultHighspeedManager` 单例路径，不是「进程里只有一份表」。
 */
let defaultSlots: HighspeedSlots | null = null;
let defaultSlotsKey = "";

/** 卡槽表构造参数（`ProxyConfig` 的子集，方便测试注入）。 */
export interface HighspeedSlotsConfig {
  highspeed: { enabled: boolean; origin: string; models: string[] };
  accounts?: { risk: { jitterHeartbeat: boolean } };
}

/** 配置指纹：`highspeed` 段变了就重建整张表（旧表的定时器全部停掉）。 */
function slotsKey(config: HighspeedSlotsConfig, runtimeJitter: boolean | undefined): string {
  return [
    config.highspeed.origin,
    config.highspeed.models.join(","),
    // 运行时覆盖参与指纹：`setRoutingPolicy` 改了抖动开关，下一轮取表要重建，
    // 否则新值要等重启才生效。
    runtimeJitter ?? jitterHeartbeatOf(config),
  ].join("\n");
}

/** `accounts.risk.jitterHeartbeat`（默认 true；缺省段按默认值跑）。 */
function jitterHeartbeatOf(config: HighspeedSlotsConfig): boolean {
  return config.accounts?.risk.jitterHeartbeat ?? true;
}

/**
 * 进程级卡槽表；`highspeed.enabled` 为 false 时返回 null（整条加速链路关掉）。
 */
export function getDefaultHighspeedSlots(
  config: HighspeedSlotsConfig,
  /** `broker.risk.jitterHeartbeat` 的运行时值；缺省回落到 `config.accounts.risk`。*/
  runtimeJitter?: boolean,
): HighspeedSlots | null {
  if (!config.highspeed.enabled) return null;
  const key = slotsKey(config, runtimeJitter);
  if (!defaultSlots || key !== defaultSlotsKey) {
    defaultSlots?.stopAll();
    defaultSlots = new HighspeedSlots({
      origin: config.highspeed.origin,
      models: config.highspeed.models,
      jitterHeartbeat: runtimeJitter ?? jitterHeartbeatOf(config),
      // 卡槽状态变化（drawn / miss / cooldown / dropped / idle-stopped）在线上是静默的，
      // 每种只报一次，且带上账号 label。
      onEvent: (message) => log.info("card slot event", { message }),
    });
    defaultSlotsKey = key;
  }
  return defaultSlots;
}

/**
 * 把卡槽表挂到账号仓的写后回调上。
 *
 * 账号删除 / 禁用是**账号仓**的动作（CLI 与控制面都落到 `AccountManager`），
 * 所以监听它的写后快照是最省事也最不容易漏的一条路径：调用方不需要记住"删完账号
 * 还要去停卡槽"。回调只在**写成功之后**触发，读失败不会误停定时器。
 *
 * 卡槽表是懒创建的，所以这里监听的是"默认表存在就同步"：第一个请求之前没有定时器，
 * 也就没有需要停的东西。
 */
export function bindHighspeedSlots(accounts: AccountManager): void {
  accounts.onChange((list) => {
    defaultSlots?.reconcile(list);
  });
}

/**
 * 停掉全部抽卡循环（serve-mode 关闭路径，与 claim / captcha 同批）。
 *
 * 定时器都是 unref 的，正常退出不需要它；但 `docker stop` 之后进程还要跑收尾
 * （写日志、关面板），在飞的 draw fetch 会把这段时间拖长，所以显式停一次。
 */
export function shutdownAllHighspeed(): void {
  defaultSlots?.stopAll();
  defaultSlots = null;
  defaultSlotsKey = "";
}
