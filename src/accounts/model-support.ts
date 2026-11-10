/**
 * `(route, model)` 能力判定：这条路由能不能服务这个模型。
 *
 * 与 `capability.ts` 的分工：那边回答"这个账号能不能跑某个 surface"（控制面 / 启动
 * 日志用，没有请求上下文），这边回答"这次请求的 model 能不能走这条路由"（请求期
 * 候选集过滤用）。两者粒度不同，所以没有合并。
 *
 * **只拦明确的反面事实。** 项目不做模型白名单：`config.example.yaml` 明确写着
 * 「any other model id still forwards upstream (no whitelist enforcement)」，而
 * `RouteSpec.modelIds` 是官方 builtin 的**广告面**清单，不是排他白名单（上游实际
 * 支持的模型比清单多）。把 `modelIds` 当白名单用会立刻误伤：`coding-plan` 的清单里
 * 没有 `glm-5.2`，而它在 coding-plan 上是能用的。
 *
 * 所以这里只编码一条官方 builtin 配置钉死的排除规则：
 *
 * > `start-plan` 不支持 `glm-5.3`。
 *
 * 这条事实是整个"优先 start-plan"策略成立的前提：请求 `glm-5.3` 时 start-plan 直接
 * 出局、落到 coding-plan，并且**不做模型改写**（把 `glm-5.3` 改写成 `glm-5.3-flash`
 * 塞进 start-plan 会静默降低输出质量）。
 */
import { getRouteSpec, ROUTE_KINDS } from "./routes.js";
import type { RouteKind } from "./types.js";

/**
 * `modelIds` 是**排他**清单的路由。
 *
 * 只剩 `start-plan`：模型集来自官方 builtin 配置的完整枚举，官方明确
 * 列出「不含 `GLM-5.3`」。
 *
 * 其余路由的清单只是广告面（见文件头）。
 */
const EXCLUSIVE_MODEL_ROUTES: ReadonlySet<RouteKind> = new Set<RouteKind>(["start-plan"]);

/**
 * 套餐模型全集（所有 `plan-catalog` 路由的 `modelIds` 并集），**由路由表派生**。
 *
 * 用途：区分"这个 model id 我们认识，只是这条路由不提供"（拦）与"这个 model id 我们
 * 不认识"（放行，无白名单，与 config.example.yaml 的立场一致）。派生而不是
 * 手抄，是为了新增套餐模型时不需要改两处。
 */
const PLAN_CATALOG_MODELS: ReadonlySet<string> = collectPlanCatalogModels();
function collectPlanCatalogModels(): ReadonlySet<string> {
  const models = new Set<string>();
  for (const kind of ROUTE_KINDS) {
    const spec = getRouteSpec(kind);
    if (spec.models !== "plan-catalog" || spec.modelIds === null) continue;
    for (const id of spec.modelIds) models.add(id);
  }
  return models;
}

/**
 * 这条路由能不能服务这个模型。
 *
 * 模型 id 大小写归一（官方目录写 `GLM-5.3`，内部统一小写）。
 */
export function routeSupportsModel(route: RouteKind, model: string): boolean {
  if (!EXCLUSIVE_MODEL_ROUTES.has(route)) return true;
  const spec = getRouteSpec(route);
  if (spec.modelIds === null) return true;
  const normalized = model.trim().toLowerCase();
  if (spec.modelIds.includes(normalized)) return true;
  // 认识但不在这条路由的清单里 → 明确不支持；不认识的 model id 放行（无白名单）。
  return !PLAN_CATALOG_MODELS.has(normalized);
}
