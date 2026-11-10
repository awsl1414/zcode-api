/**
 * 配置热重载：把重新读出的一份 `ProxyConfig` 就地灌进进程里正在用的那份。
 *
 * 为什么是就地替换而不是换引用：`ProxyConfig` 没有 `readonly` 标注，持有它的地方
 * （`createFetchHandler` 的闭包、各 route options、后台子系统）拿的都是同一个顶层
 * 对象。逐 key 就地赋值之后，所有持有者自动看到新值；换引用（`ConfigRef`）则要改
 * 90 处读取（不值得为热重载付这个改动面）。
 *
 * 粒度是**顶层段**：`identity`、`accounts` 等每段作为整体替换，不做深层 merge
 * （要么整份换要么不换）。`server` 段例外（C 类：改监听要重启）：监听地址与端口
 * 热改要关掉监听再起一个，成本与风险不值，内存保留旧值，把字段名报告给调用方去
 * 提示「需要重启」。
 */
import type { ProxyConfig } from "./types.js";

/**
 * 改了也不热生效、必须重启的字段（C 类）。
 *
 * 键名带段前缀（`server.port`），因为报告给页面的是字段级的事实；reload 本身工作在
 * 顶层段粒度上，跳过整段由 {@link RESTART_SEGMENTS} 从这份清单推导。
 */
export const RESTART_REQUIRED: ReadonlySet<string> = new Set(["server.port", "server.host"]);

/** C 类字段所在的顶层段：reload 时整段跳过赋值，内存保留旧值。*/
const RESTART_SEGMENTS: ReadonlySet<string> = new Set(
  [...RESTART_REQUIRED].map((field) => field.split(".")[0]),
);

/**
 * 结构相等：对象按键集合比（键序无关），数组按序比（`models` / `entries` 的顺序是
 * 语义的一部分），标量用 `===`。两份 `loadConfig` 的产物键集合总是齐全，所以不区分
 * 「键存在但值是 undefined」与「键缺失」。
 */
export function configEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const isArrayA = Array.isArray(a);
  if (isArrayA !== Array.isArray(b)) return false;
  if (isArrayA) {
    const listA = a as unknown[];
    const listB = b as unknown[];
    if (listA.length !== listB.length) return false;
    for (let i = 0; i < listA.length; i++) {
      if (!configEqual(listA[i], listB[i])) return false;
    }
    return true;
  }
  const mapA = a as Record<string, unknown>;
  const mapB = b as Record<string, unknown>;
  const keysA = Object.keys(mapA);
  if (keysA.length !== Object.keys(mapB).length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(mapB, key)) return false;
    if (!configEqual(mapA[key], mapB[key])) return false;
  }
  return true;
}

/**
 * 逐 key 比对并就地替换。返回真正变化的顶层键。
 *
 * C 类段（{@link RESTART_SEGMENTS}）只进清单、不进内存：`target` 保留旧值，页面
 * 显示的新值与监听的旧值之间的差距由 `restart_required` 语义明说，不靠
 * 静默。
 */
export function reloadConfig(target: ProxyConfig, next: ProxyConfig): string[] {
  const changed: string[] = [];
  for (const key of Object.keys(next) as (keyof ProxyConfig)[]) {
    if (configEqual(target[key], next[key])) continue;
    changed.push(key);
    if (RESTART_SEGMENTS.has(key)) continue;
    /* SAFETY: ProxyConfig 没有 index signature，但这里是本模块自己的写入口：key 来自
       Object.keys(next)，赋的值也来自同一份 next，键与值的形状由 ProxyConfig 保证。*/
    (target as unknown as Record<string, unknown>)[key] = next[key];
  }
  return changed;
}

/** reload 的分类结果（响应体的两个清单）。*/
export interface ReloadOutcome {
  /** 本次已热生效的顶层键（A / B 类；内存已更新）。*/
  reloaded: string[];
  /** 需要重启才生效的字段（C 类，dotted 键名；内存保留旧值）。*/
  restartRequired: string[];
}

/**
 * 把 {@link reloadConfig} 的变化清单分成「已热生效」与「需要重启」两组。
 *
 * `server` 段在 reload 里被整段跳过，所以按字段比对 `target`（旧值）与 `next`
 * （新值）找出真正改动的那个，用 dotted 键名报告；其余顶层键原样进 `reloaded`。
 */
export function classifyReload(target: ProxyConfig, next: ProxyConfig, changed: string[]): ReloadOutcome {
  const restartRequired: string[] = [];
  if (changed.includes("server")) {
    if (!configEqual(target.server.port, next.server.port)) restartRequired.push("server.port");
    if (!configEqual(target.server.host, next.server.host)) restartRequired.push("server.host");
  }
  const reloaded = changed.filter((key) => key !== "server");
  return { reloaded, restartRequired };
}
