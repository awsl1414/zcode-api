/**
 * broker 的构造参数形状与「配置 → 参数」的纯映射。
 *
 * 三层策略里 config.yaml 这一层单独住在这里：持久化覆盖（`policy.json`）更优先，
 * 由 `runtime.ts::createBroker` 叠在返回值上；`Broker` 构造函数把缺省项回落到
 * `DEFAULT_BROKER_OPTIONS`。调度器本身不读配置文件，所以本文件没有运行时依赖：只有
 * 类型与三条 `Partial` 合并。
 */
import { DEFAULT_ACCOUNTS_RISK, type AccountsConfig, type AccountsRisk } from "../config/types.js";
import type { AccountOverrides, PolicyEntry } from "./overrides.js";
import type { ProxySpec } from "./proxies.js";
import type { HealthEngine } from "./health.js";
import type { ActivityClock } from "./activity.js";
import type { RpmGate } from "./rpm.js";
import type { LeaseManager } from "./lease.js";
import type { StickinessTable } from "./stickiness.js";
import type { CapabilityAlignment } from "./plan-capability.js";
import type { RuntimeOverride } from "./types.js";
import {
  DEFAULT_ACCOUNTS_ROUTING,
  DEFAULT_ACCOUNTS_STICKINESS,
  type AccountsRouting,
  type AccountsStickiness,
} from "./routing.js";

/**
 * 账号级覆盖的落盘口。
 *
 * 抽成接口是为了让单测能注入一个空实现，不去写真实用户目录；生产缺省走
 * `policy-store.ts`，与 `routing` / `stickiness` / `risk` 共用同一份 `policy.json`。
 */
export interface OverrideStore {
  /** 写一条覆盖。返回的 Promise 解决之后才算落盘（命令面要能说「已经存了」）。*/
  set(label: string, patch: RuntimeOverride): Promise<void>;
  clear(label: string): Promise<void>;
}

/**
 * broker 的构造参数。
 *
 * 全部可选：`new Broker(manager)` 必须是合法的（测试与单账号用例大量这么
 * 写），此时按内置默认值跑，即"只导入账号、不写策略也能跑"。
 */
export interface BrokerOptions {
  /** `accounts.routing`。缺省项回落内置默认值。*/
  routing?: Partial<AccountsRouting>;
  /** `accounts.stickiness`。缺省项回落内置默认值。*/
  stickiness?: Partial<AccountsStickiness>;
  /** `accounts.risk`。缺省项回落默认值（心跳抖动默认开）。*/
  risk?: Partial<AccountsRisk>;
  /** `accounts.entries[]`：按 label 引用的策略覆盖，优先级低于 RuntimeOverride。*/
  entries?: readonly PolicyEntry[];
  /**
   * `accounts.proxies[]`：命名出口代理表。
   *
   * 传可变数组而不是只读快照：控制面 `addProxy` / `setProxy` / `removeProxy`
   * 就地改它，下一个请求立刻看到新地址。*/
  proxies?: ProxySpec[];
  /** 运行时覆盖表。注入共享实例后，命令面与调度看到的是同一份。*/
  overrides?: AccountOverrides;
  /** 账号级覆盖的落盘口。缺省写 `policy.json`。*/
  overrideStore?: OverrideStore;
  /** 健康表（账号×路由的健康状态）。*/
  health?: HealthEngine;
  /** 最近活跃时钟。注入共享实例后，额度采样器看到的是同一份。*/
  activity?: ActivityClock;
  /** 上游 RPM 闸。注入共享实例后，控制面能读窗口占用。*/
  rpm?: RpmGate;
  /** 租约池。注入共享实例后，控制面能读队列深度。*/
  leases?: LeaseManager;
  /** 粘性表。注入共享实例后，控制面能读/清绑定。*/
  bindings?: StickinessTable;
  /** 时钟注入（测试跨过冷却窗口用）。*/
  now?: () => number;
  /** 面板顶栏/账号页的分级采决策；缺省 = 没有采样器（一次性 CLI/测试）。*/
  classifyRefresh?: (accountIds: readonly string[], focusedId: string | undefined) => string[];
  /** 套餐能力对齐生效时的调度事件回调。*/
  onAlignment?: (alignment: CapabilityAlignment) => void;
  /**
   * 终态码/空流即时复采：由 serve 注入采样器的 `sampleNow`。同一个
   * 入口自带 30s 去重，claim 的多路由上报与一次风暴里的多条终态信号不放大特征。
   */
  resample?: (accountId: string, origin: string) => Promise<unknown>;
}

/**
 * 内置默认值：策略的第三层，也是「什么都没配」时的全部内容。
 *
 * 只装 `routing` / `stickiness` / `risk`。`entries` / `proxies` 没有「默认值」这一说
 * （空表就是没有），而且它们是控制面**就地改**的可变数组，放进常量会让两个 broker
 * 共享同一个出口代理表。
 *
 * `Broker` 的构造函数用同一批常量做回落，所以 `new Broker(accounts)` 与
 * `new Broker(accounts, DEFAULT_BROKER_OPTIONS)` 等价。命令面改 `order` 时整个换数组
 * （`applyRoutingPolicy`），不会就地改写这里的常量。
 */
export const DEFAULT_BROKER_OPTIONS: BrokerOptions = {
  routing: { ...DEFAULT_ACCOUNTS_ROUTING, order: [...DEFAULT_ACCOUNTS_ROUTING.order] },
  stickiness: { ...DEFAULT_ACCOUNTS_STICKINESS },
  risk: { ...DEFAULT_ACCOUNTS_RISK },
};

/**
 * 从 `ProxyConfig.accounts` 造 broker 参数。这是三层策略里 config.yaml 那一层，只读配置。
 *
 * 不碰文件系统：持久化覆盖（`policy.json`）是第三层，由 `runtime.ts::createBroker` 叠。
 *
 * `accounts` 在类型上可选：`loadConfig` 总会补齐，但测试里手写的
 * `ProxyConfig` 字面量不一定写这一段，`cli/control.ts` 在没有 config.yaml 时传 `null`。
 * 「没有 accounts 段」与「没有 config.yaml」是同一件事（这一层是空的），所以两者都
 * 回落到内置默认值，而不是让调用方各自决定要不要绕过这一层。
 *
 * 返回的 `routing` / `stickiness` / `risk` 可能是 `DEFAULT_BROKER_OPTIONS` 里那几个对象
 * 本身，调用方当只读用（`createBroker` 拿到后立即展开成新对象）。
 */
export function brokerOptionsFromConfig(accounts: AccountsConfig | undefined): BrokerOptions {
  if (!accounts) return DEFAULT_BROKER_OPTIONS;
  return {
    routing: { ...DEFAULT_BROKER_OPTIONS.routing, ...accounts.routing },
    stickiness: { ...DEFAULT_BROKER_OPTIONS.stickiness, ...accounts.stickiness },
    risk: { ...DEFAULT_BROKER_OPTIONS.risk, ...accounts.risk },
    entries: accounts.entries,
    proxies: accounts.proxies,
  };
}
