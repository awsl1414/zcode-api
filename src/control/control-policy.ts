/**
 * 路由策略的校验与应用（`getRoutingPolicy` / `setRoutingPolicy` 的实现侧）。
 *
 * 这里是唯一改 `broker.routing` / `broker.stickiness` / `broker.risk` 的地方。
 * 散在 `dispatch` 的 case 里时，每加一条策略字段都要在「校验」「应用」「落盘」三处
 * 各写一遍，漏一处就变成「命令回了 ok 但策略没生效」。
 *
 * 校验一律查 `accounts/routing.ts` 的常量表（枚举合法值只有那一份），不在本文件另
 * 抄字面量：抄一份之后，加一个枚举值就只改到了其中一处。
 */
import type { Broker } from "../accounts/broker.js";
import { mergePolicyOverrides } from "../accounts/policy-store.js";
import { isRouteKind } from "../accounts/routes.js";
import { DRAINED_ACTIONS, ROUTING_MODES, ROUTING_STRATEGIES, SATURATED_ACTIONS, STICKINESS_SATURATED_ACTIONS, WITHIN_TIER_ORDERS } from "../accounts/routing.js";
import type { AccountsRouting, AccountsStickiness } from "../accounts/routing.js";
import { isPositiveInteger } from "../accounts/summary.js";
import type {
  ControlError,
  RiskPolicy,
  RiskPolicyPatch,
  RoutingPolicyPatch,
  StickinessPolicyPatch,
} from "./control-types.js";

/**
 * 风控开关的进程级运行时覆盖（与路由策略同一套思路：覆盖只活在进程里）。
 *
 * 为什么不放在 `Broker` 上：`routing` / `stickiness` 是调度器自己的参数，它每次现读；
 * 而 `accounts.risk` 的消费者是加速卡抽卡循环（`highspeed/slots.ts` 的错峰相位），
 * 不在调度器里。按 broker 实例挂一张覆盖表，控制面就能在「同一个调度器」的生命周期内
 * 读写同一份值，进程重启后回到配置里的 `accounts.risk`（与运行时覆盖的语义一致）。
 */
/* 风控开关挂在 broker 上（`broker.risk`），不再用模块级 WeakMap：
 * highspeed 的抽卡循环也要读它，WeakMap 只有本模块能看见。*/

/** 当前生效的风控开关：运行时覆盖优先，否则 `accounts.risk` 的默认值。*/
function riskPolicyOf(broker: Broker): RiskPolicy {
  return broker.risk;
}

/** 当前生效的策略快照（副本：调用方改它不会动到调度器）。*/
export function routingSnapshot(broker: Broker): {
  routing: AccountsRouting;
  stickiness: AccountsStickiness;
  risk: RiskPolicy;
} {
  return {
    routing: { ...broker.routing, order: [...broker.routing.order] },
    stickiness: { ...broker.stickiness },
    risk: riskPolicyOf(broker),
  };
}

/**
 * 校验并应用一条路由策略补丁（CLI / 网页 / YAML 三处改的是同一套字段）。
 *
 * 先校验后应用：补丁是一组字段，逐字段“改一个算一个”会让一次非法请求留下半套
 * 新策略（例如 order 已改、mode 被拒），而用户看到的是失败，那比直接拒掉更难查。
 *
 * 粘性表的 `ttlSeconds` / `maxSessions` 是建表时参数（内存结构不支持热改容量），
 * 所以本命令改的是“生效配置”，运行中的表要重建才按新容量淘汰。
 */
export async function applyRoutingPolicy(
  broker: Broker,
  routing: RoutingPolicyPatch | undefined,
  stickiness: StickinessPolicyPatch | undefined,
  risk: RiskPolicyPatch | undefined,
): Promise<ControlError | null> {
  const rejected = validateRoutingPolicy(routing, stickiness, risk);
  if (rejected) return rejected;

  if (routing) {
    if (routing.order !== undefined) broker.routing.order = [...routing.order];
    if (routing.withinTier !== undefined) broker.routing.withinTier = routing.withinTier;
    if (routing.mode !== undefined) broker.routing.mode = routing.mode;
    if (routing.strategy !== undefined) broker.routing.strategy = routing.strategy;
    if (routing.onSaturated !== undefined) broker.routing.onSaturated = routing.onSaturated;
    if (routing.onDrained !== undefined) broker.routing.onDrained = routing.onDrained;
    if (routing.onAuthFailed !== undefined) broker.routing.onAuthFailed = routing.onAuthFailed;
    if (routing.queueTimeoutMs !== undefined) broker.routing.queueTimeoutMs = routing.queueTimeoutMs;
    if (routing.maxQueue !== undefined) broker.routing.maxQueue = routing.maxQueue;
    if (routing.maxTotalInflight !== undefined) broker.routing.maxTotalInflight = routing.maxTotalInflight;
  }
  if (stickiness) {
    if (stickiness.enabled !== undefined) broker.stickiness.enabled = stickiness.enabled;
    if (stickiness.ttlSeconds !== undefined) broker.stickiness.ttlSeconds = stickiness.ttlSeconds;
    if (stickiness.maxSessions !== undefined) broker.stickiness.maxSessions = stickiness.maxSessions;
    if (stickiness.onSaturated !== undefined) broker.stickiness.onSaturated = stickiness.onSaturated;
    if (stickiness.overflowAfterMs !== undefined) broker.stickiness.overflowAfterMs = stickiness.overflowAfterMs;
  }
  if (risk) {
    // 逐字段合并到已有的运行时覆盖上（缺省字段保持原值）。
    if (risk.jitterHeartbeat !== undefined) broker.risk.jitterHeartbeat = risk.jitterHeartbeat;
  }
  // 落盘（持久化覆盖 > config.yaml > 默认值）。只写本次补丁里**显式给了值**
  // 的字段，`mergePolicyOverrides` 会与已有覆盖合并，改一次 order 不会冲掉上次的 strategy。
  await mergePolicyOverrides({
    ...(routing ? { routing } : {}),
    ...(stickiness ? { stickiness } : {}),
    ...(risk ? { risk } : {}),
  });
  return null;
}

/**
 * 补丁的逐字段校验（枚举一律查 `routing.ts` 的常量表，不在这里另抄一份字面量）。
 *
 * 拆成 routing / stickiness 两半而不是一长串 `if`：两段的字段来源、默认值与合法值
 * 表分居 `routing.ts` 的两个 interface，混在一起读容易漏字段。
 */
function validateRoutingPolicy(
  routing: RoutingPolicyPatch | undefined,
  stickiness: StickinessPolicyPatch | undefined,
  risk: RiskPolicyPatch | undefined,
): ControlError | null {
  return validateRoutingFields(routing) ?? validateStickinessFields(stickiness) ?? validateRiskFields(risk);
}

/** `accounts.risk` 的字段校验（布尔开关；写错类型直接拒，不给静默兜底）。*/
function validateRiskFields(risk: RiskPolicyPatch | undefined): ControlError | null {
  if (risk && risk.jitterHeartbeat !== undefined && typeof risk.jitterHeartbeat !== "boolean") {
    return { ok: false, error: "invalid_risk_jitter_heartbeat" };
  }
  return null;
}

/** `accounts.routing` 的字段校验。*/
function validateRoutingFields(routing: RoutingPolicyPatch | undefined): ControlError | null {
  if (routing) {
    if (routing.order !== undefined) {
      const order = routing.order;
      // 空 order 会让"降级顺序"失去意义，`mode: only` 更会直接没有候选（broker 构造
      // 时也会抛），所以在这里就拒。
      if (!Array.isArray(order) || order.length === 0 || !order.every((kind) => isRouteKind(kind))) {
        return { ok: false, error: "invalid_routing_order" };
      }
    }
    if (routing.mode !== undefined && !ROUTING_MODES.includes(routing.mode)) {
      return { ok: false, error: "invalid_routing_mode" };
    }
    if (routing.withinTier !== undefined && !WITHIN_TIER_ORDERS.includes(routing.withinTier)) {
      return { ok: false, error: "invalid_within_tier" };
    }
    if (routing.strategy !== undefined && !ROUTING_STRATEGIES.includes(routing.strategy)) {
      return { ok: false, error: "invalid_routing_strategy" };
    }
    if (routing.onSaturated !== undefined && !SATURATED_ACTIONS.includes(routing.onSaturated)) {
      return { ok: false, error: "invalid_saturated_action" };
    }
    if (routing.onDrained !== undefined && !DRAINED_ACTIONS.includes(routing.onDrained)) {
      return { ok: false, error: "invalid_drained_action" };
    }
    // `onAuthFailed` 只有一个合法值（401/403 只换号、不降级），所以写成显式判断。
    if (routing.onAuthFailed !== undefined && routing.onAuthFailed !== "rotate") {
      return { ok: false, error: "invalid_auth_failed_action" };
    }
    if (routing.queueTimeoutMs !== undefined && !isPositiveInteger(routing.queueTimeoutMs)) {
      return { ok: false, error: "invalid_queue_timeout" };
    }
    if (routing.maxQueue !== undefined && !isPositiveInteger(routing.maxQueue)) {
      return { ok: false, error: "invalid_max_queue" };
    }
    if (routing.maxTotalInflight !== undefined && !isPositiveInteger(routing.maxTotalInflight)) {
      return { ok: false, error: "invalid_max_total_inflight" };
    }
  }
  return null;
}

/** `accounts.stickiness` 的字段校验。*/
function validateStickinessFields(stickiness: StickinessPolicyPatch | undefined): ControlError | null {
  if (stickiness) {
    if (stickiness.enabled !== undefined && typeof stickiness.enabled !== "boolean") {
      return { ok: false, error: "invalid_stickiness_enabled" };
    }
    if (stickiness.ttlSeconds !== undefined && !isPositiveInteger(stickiness.ttlSeconds)) {
      return { ok: false, error: "invalid_stickiness_ttl" };
    }
    if (stickiness.maxSessions !== undefined && !isPositiveInteger(stickiness.maxSessions)) {
      return { ok: false, error: "invalid_stickiness_max_sessions" };
    }
    if (
      stickiness.onSaturated !== undefined &&
      !STICKINESS_SATURATED_ACTIONS.includes(stickiness.onSaturated)
    ) {
      return { ok: false, error: "invalid_stickiness_saturated_action" };
    }
    if (stickiness.overflowAfterMs !== undefined && !isPositiveInteger(stickiness.overflowAfterMs)) {
      return { ok: false, error: "invalid_overflow_after_ms" };
    }
  }
  return null;
}
