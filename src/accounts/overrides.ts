/**
 * 运行时账号控制（热调节）与策略优先级链。
 *
 * 优先级**唯一**定义在这里，任何地方都不要自己拼一遍：
 *
 * ```
 * RuntimeOverride  >  config.yaml accounts.entries[]  >  账号自身 policy（缺省值）
 * ```
 *
 * 第三档叫"账号自身 policy"而不是"硬编码默认值"：`AccountManager` 写入时已经
 * 把 `enabled: true` / `weight: 1` / `maxConcurrency: 2` 补齐了（`defaultPolicy`），
 * 所以存储里的值**就是**默认值：用户没写 config entries 时，`auth import` 出来的
 * 账号天然带正确默认，不需要在这里再抄一份。
 *
 * 为什么覆盖层是内存的：调度器只认内存这一份，每次 `policyFor` 现读，所以命令面
 * 改完立即生效，不需要重建任何结构。落盘是另一件事，由 `policy-store.ts` 的 sidecar
 * 负责（`policy.json` 的 `entries` 段），写口只在 `Broker` 的三个 setter 与
 * `resetAccountOverrides` 里，`applyPersistedOverrides` 在启动时把它灌回这张内存表。
 *
 * 于是 `resetAccountOverrides` 的语义是「清内存 + 删落盘那一行」，生效值回落到
 * `config.yaml` 的 `accounts.entries[]`。
 *
 * 命令面（CLI / 面板）挂在 `broker.ts` 上，因为"禁用要等
 * 在飞完成 / force 要中止在飞"必须同时看到账号仓、租约池与健康表；这里只提供
 * 纯数据的覆盖表与优先级解析。
 */
import type { Account, RuntimeOverride } from "./types.js";
import { DEFAULT_MAX_CONCURRENCY, DEFAULT_WEIGHT } from "./types.js";

/**
 * `config.yaml` 的 `accounts.entries[]` 条目。
 *
 * 只声明调度会读的四个字段：`label` 是引用键，其余三项是允许热调节的三个
 * 旋钮。`routes` 也在这份 entries 里，但路由白名单是**写入时**校验的账号属性
 * （`manager.ts` 的六条规则），不参与请求期调度，所以不在这里重复建模，
 * 这里出现第二份白名单就必然出现"配置说能用、账号说不能用"的分歧。
 */
export interface PolicyEntry {
  label: string;
  enabled?: boolean;
  weight?: number;
  maxConcurrency?: number;
  /** 上游 RPM 闸。缺省 = 账号自身 policy 的值；两边都没写 = 不限。*/
  rpmLimit?: number;
  /** 出口代理引用：`accounts.proxies[].name`、`direct`，或省略 = 继承默认。*/
  proxy?: string;
}

/** 一个账号此刻真正生效的旋钮（优先级链的出口）。*/
export interface EffectivePolicy {
  enabled: boolean;
  weight: number;
  maxConcurrency: number;
  /**
   * 每分钟请求数上限；`undefined` = 不限（这个配置项的默认就是"无"）。
   *
   * 它**没有**运行时覆盖层：热调节只把 enabled / weight / maxConcurrency 列为可
   * 热调项，而 RPM 是风控参数，热改一个上限就会在飞请求的配额计算里凭空多出一个
   * 中间态。要改就改配置 + 重启（拿到准信再改，而不是碰运气）。
   */
  rpmLimit?: number;
  /**
   * 生效的出口代理名：`accounts.proxies[].name`、`direct`，
   * 或 `undefined` = 直连。
   *
   * 这里保留名字而不是解析成 URL：解析需要代理表，而优先级链只该回答「用哪一个」。
   * 名字 → `EgressOptions` 的转换在 `accounts/proxies.ts::egressFor`。
   */
  proxy?: string;
}

/**
 * 优先级链：`RuntimeOverride > entries > 账号 policy`。
 *
 * 逐字段取值而不是整块覆盖：用户可以只临时调并发（`setAccountConcurrency`）而不
 * 影响权重与启停；整块覆盖会让一次并发调节把别的手工设置一起抹掉。
 */
export function resolvePolicy(
  account: Account,
  entry: PolicyEntry | undefined,
  override: RuntimeOverride | undefined,
): EffectivePolicy {
  return {
    enabled: override?.enabled ?? entry?.enabled ?? account.enabled,
    weight: override?.weight ?? entry?.weight ?? account.policy.weight ?? DEFAULT_WEIGHT,
    maxConcurrency:
      override?.maxConcurrency ?? entry?.maxConcurrency ?? account.policy.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    // RPM 閘不走运行时覆盖层（见 `EffectivePolicy.rpmLimit`）：只有 entries 与账号
    // policy 两档。两边都没写就是 `undefined` = 不限。
    rpmLimit: entry?.rpmLimit ?? account.policy.rpmLimit,
    // 出口代理：运行时覆盖层可以临时改（`setAccountProxy`），
    // 与 enabled / weight / maxConcurrency 同一条链。`direct` 是值，不是「没写」。
    // 没有「账号 policy」这一档：代理是运行时策略而不是账号身份（同 entries 而不是
    // 账号自身承载绑定，理由相同）。缺省留给 `risk.defaultProxy`。
    proxy: override?.proxy ?? entry?.proxy,
  };
}

/** 覆盖表里一条生效记录（带写入时间，便于面板显示"最近 5 分钟有 N 次启停"）。*/
export interface OverrideRecord {
  label: string;
  override: RuntimeOverride;
  /** Unix ms：这条覆盖是何时写入的。*/
  setAt: number;
}

/**
 * 运行时覆盖表（内存，`RuntimeOverride` 的活实例）。
 *
 * `expiresAt` 到点后 `get()` 直接返回 `undefined` 并清掉条目，回落持久配置不需要
 * 任何定时器，读取时判过期就够了（定时器只会在进程里留下一堆需要 unref 的句柄）。
 */
export class AccountOverrides {
  private readonly byLabel = new Map<string, OverrideRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 当前生效的覆盖。过期即视为不存在（并顺手清理）。*/
  get(label: string): RuntimeOverride | undefined {
    const record = this.byLabel.get(label);
    if (!record) return undefined;
    const expiresAt = record.override.expiresAt;
    if (expiresAt !== undefined && this.now() >= expiresAt) {
      this.byLabel.delete(label);
      return undefined;
    }
    return { ...record.override };
  }

  /** 写入/合并一条覆盖。`undefined` 的字段保持原值（逐字段合并，同 {@link resolvePolicy}）。*/
  set(label: string, patch: RuntimeOverride): RuntimeOverride {
    const current = this.get(label) ?? {};
    const merged: RuntimeOverride = { ...current, ...patch };
    this.byLabel.set(label, { label, override: merged, setAt: this.now() });
    return { ...merged };
  }

  /** 清空某账号的覆盖（`resetAccountOverrides` 的内存一半）。返回是否真的清掉了东西。*/
  clear(label: string): boolean {
    return this.byLabel.delete(label);
  }

  /** 全部生效覆盖的快照（控制面用；已过期的条目不会出现）。*/
  snapshot(): OverrideRecord[] {
    const records: OverrideRecord[] = [];
    for (const record of [...this.byLabel.values()]) {
      const live = this.get(record.label);
      if (live) records.push({ ...record, override: live });
    }
    return records;
  }

  /**
   * 校验并归一一条覆盖的数值（写入时强制，命令面也走这里）。
   *
   * 与 `manager.ts::validatePolicy` 同一套取值域：`weight >= 1` 的整数、
   * `maxConcurrency >= 0` 的整数（0 = 软禁用）、`expiresAt` 必须是未来的时间点。
   * 命令面直接传非法值（面板表单、脚本）时必须报错而不是"尽力修复"。
   */
  static validate(override: RuntimeOverride): void {
    if (override.weight !== undefined && (!Number.isInteger(override.weight) || override.weight < 1)) {
      throw new Error(`override.weight must be an integer >= 1, got ${override.weight}`);
    }
    if (
      override.maxConcurrency !== undefined &&
      (!Number.isInteger(override.maxConcurrency) || override.maxConcurrency < 0)
    ) {
      throw new Error(`override.maxConcurrency must be an integer >= 0, got ${override.maxConcurrency}`);
    }
    if (override.expiresAt !== undefined && !Number.isFinite(override.expiresAt)) {
      throw new Error(`override.expiresAt must be a unix-ms timestamp, got ${override.expiresAt}`);
    }
    if (override.proxy !== undefined && override.proxy.trim() === "") {
      throw new Error("override.proxy must be a non-empty string");
    }
  }
}
