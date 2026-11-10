/**
 * 路由 → 出线基准地址。
 *
 * 端点**是路由的属性**：路由表 `accounts/routes.ts` 是官方端点的唯一真源。
 * `config.provider`（全局选一家）与 `config.providers`（两家各两个 base）在
 * 路由化之后只剩一个合法用途：**覆盖某一家自己的端点**。
 *
 * 所以这里只允许覆盖 `coding-plan` 的 anthropic base：
 *
 * - `coding-plan` 的官方 base 就是 `api.z.ai/api/anthropic` /
 *   `open.bigmodel.cn/api/anthropic` —— 与 `config.providers[family].anthropicBase`
 *   的默认值逐字相同，覆盖它等于"这家网关换个地址"，语义清楚。
 * - `start-plan` / `off-peak` / `highspeed` 三家同在 `zcode.z.ai` 网关下，不是任何
 *   一家的 family 端点，没有对应的覆盖键；拿 `providers` 去改它们只会拼出上游
 *   不认的地址。
 *
 * 覆盖保留的另一个理由：测试与自建镜像需要一个把 coding-plan 流量指向本地 mock
 * 的口子（`config.test.yaml` 之外的用例都在用它）。
 */
import type { ProviderFamily, RouteKind } from "../accounts/types.js";
import { getRouteSpec } from "../accounts/routes.js";
import type { ProxyConfig } from "../config/types.js";

/**
 * 该路由在某 family 下的出线基准地址（无尾斜杠）。
 *
 * 不做"空串就回落"的兜底：`config/loader.ts::resolveBaseUrl` 已经在读配置时把
 * 空串/非法 URL 挡掉了，所以这里拿到的值按契约就是可用的（规则：边界处校验一次，
 * 往下游不再猜）。
 */
export function routeUpstreamBaseUrl(
  route: RouteKind,
  family: ProviderFamily,
  providers: ProxyConfig["providers"],
): string {
  if (route === "coding-plan") return providers[family].anthropicBase;
  return getRouteSpec(route).baseUrl[family];
}
