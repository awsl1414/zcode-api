/**
 * 额度的**静态事实**：哪条路由吃哪套额度平面，以及上游哪些业务码表示"额度
 * 耗尽"。额度耗尽码表不是独立白名单，而是由 `signals.ts` 业务码全表的
 * `quota-terminal` 类派生（单一真相）。
 *
 * 为什么单独一个只依赖查表逻辑的文件：这两张表有两个消费者，分居依赖图的两侧，
 *
 * - `quota.ts`（采样侧）：归一快照、判定 drained；
 * - `broker.ts`（请求侧）：上游错误体里的业务码 → `health.markDrained`，以及
 *   "这条路由有没有额度平面"（决定 drained 能否被采样自动解除）。
 *
 * 若把它们放进 `quota.ts`，`broker.ts` 就得 import 采样模块，而采样模块要复用
 * `server/routes-quota.ts` 的采集函数（它又 import 了 `proxy/handler.ts` →
 * `proxy/lease.ts` → `accounts/broker.ts`）。那是一条真实的运行时环，ESM 能活，但
 * 初始化顺序会变成隐式契约。所以纯查表逻辑落在叶子模块里（`signals.ts` 与这里），
 * 两者都不 import 任何运行时消费者，环无从形成。
 */

import type { ProviderFamily, RouteKind } from "./types.js";
import { codesOfKind, kindForBusinessCode } from "./signals.js";

// ---------------------------------------------------------------------------
// 路由 → 额度平面
// ---------------------------------------------------------------------------

/**
 * 额度平面：credits（start-plan 的余额桶）/ coding（coding-plan 的窗口）。
 */
export type QuotaPlane = "credits" | "coding";

/**
 * 路由 → 额度平面。
 *
 * `off-peak` / `highspeed` 是**派生入口**：官方注释明确它们自己不可独立存在，权益
 * 继承 `coding-plan` 母体（派生路由必须与母体共存），所以它们的额度就是母体那套窗口。
 *
 * 返回类型留了 `undefined`：现在四条路由都有额度平面，但“某条路由没有额度概念”
 * 这个可能性仍然需要下游代码能表达，不能靠类型断言掩盖。
 */
export function quotaPlane(route: RouteKind): QuotaPlane | undefined {
  switch (route) {
    case "start-plan":
      return "credits";
    case "coding-plan":
    case "off-peak":
    case "highspeed":
      return "coding";
  }
}

// ---------------------------------------------------------------------------
// 上游「额度耗尽」业务码 → provider
// ---------------------------------------------------------------------------

/**
 * 每家 family 视为"额度耗尽"的业务码集合。
 *
 * **由 `signals.ts` 的业务码全表派生（单一真相）**：额度终态码的
 * 事实来源是全表的 `quota-terminal` 类（对照上游调研的业务码表），这里不再维护独立
 * 白名单——早期只收录了 `1005`/`1113` 两码，`1304`/`1308`/`1309`/`1310`/`1311`/
 * `1316`-`1321` 长期漏判成普通 429 反复冷却重试，并表后这些码
 * 立即判 drained（期望的行为变化，有 `signals.test.ts` 断言背书）。
 *
 * 两家 family 共用同一张表：官方内置模板显示 zai 与 bigmodel 只是同一套网关的
 * 两个域名，业务码一致。真要分叉时改 `signals.ts` 一处：`Record` 的键是
 * `ProviderFamily`，新增 family 会让编译器在这里报缺项。
 */
export const QUOTA_EXHAUSTED_CODES: Record<ProviderFamily, readonly number[]> = {
  zai: codesOfKind("zai", "quota-terminal"),
  bigmodel: codesOfKind("bigmodel", "quota-terminal"),
};

/**
 * 这个业务码是否表示"额度耗尽"。
 *
 * 与全表同一套归一纪律（字符串码先归一成数字；无法归一的码一律**不**判成耗尽）。
 * 错判两侧的代价不对等：漏判只是晚一轮采样才降级，误判会把一个还能用的
 * 账号踢出候选集。
 */
export function isQuotaExhaustedCode(provider: ProviderFamily, code: number | string | undefined): boolean {
  return kindForBusinessCode(provider, code) === "quota-terminal";
}
