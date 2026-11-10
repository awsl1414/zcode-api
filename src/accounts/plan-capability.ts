/**
 * 账号实际持有套餐 → 可用路由的能力对齐。
 *
 * `Account.routes` 是**用户意图**（配置白名单），不是账号事实：配了 `coding-plan`
 * 不代表这个上游账号真的有订阅。事实只能来自额度采样成功拿到的 entitlement 证据
 * （`QuotaSnapshot.planes`：哪套 entitlement 接口确认了权益）：
 *
 * | 实际持有 | 可用路由 |
 * |---|---|
 * | `subscription` | coding 平面（`coding-plan` / `off-peak` / `highspeed`） |
 * | `experience` | credits 平面（`start-plan`） |
 * | 两者皆无（探测成功但两套平面都没权益） | 全屏蔽 |
 *
 * 三条硬约束：
 *
 * 1. **不改写账号配置**：运行时交集遮蔽，配置里的 `routes` 原样保留（用户重新买
 *    套餐后周期采样一发现变化就自动放开，不需要用户再改一次 YAML）。
 * 2. **探测失败不屏蔽**：`noteProbe` 只在**成功**的结果上调用；失败/凭据缺口/
 *    网络问题传 `undefined`，保留上一次结论（没有结论就不屏蔽），不猜。
 * 3. **跟着路由策略走**：这里不缓存「按当前策略算出的候选」——{@link blockedOf}
 *    每次按传入的账号现算，所以 YAML reload / 面板改 `routing.order` 后下一次
 *    `acquire` 立即按同一份已探测事实重新对齐，无需重探测。
 */
import { quotaPlane } from "./quota-rules.js";
import type { AccountPlanKind } from "../control/control-views.js";
import type { Account, RouteKind } from "./types.js";

/** 一条被屏蔽的路由与它的原因（稳定码，由面板翻译）。*/
export interface CapabilityBlock {
  route: RouteKind;
  reason: "no-subscription" | "no-experience" | "no-plan";
}

/** 一次对齐的结果（落调度事件用）。*/
export interface CapabilityAlignment {
  accountId: string;
  /** 探测到的实际持有；`undefined` = 这次探测没拿到可信事实。*/
  planKinds: readonly AccountPlanKind[] | undefined;
  blocked: CapabilityBlock[];
  /** 与上一次对齐相比有没有变化（没变化不刷事件）。*/
  changed: boolean;
}

/**
 * 按「实际持有」算一个账号被屏蔽的路由。
 *
 * 纯函数：同一份事实在 broker 候选集、面板摘要、对齐事件三处共用，不会出现
 * 「页面说屏蔽了但调度还在派发」这种两份判定的偏差。
 */
export function capabilityBlocksOf(
  account: Pick<Account, "routes">,
  planKinds: readonly AccountPlanKind[] | undefined,
): CapabilityBlock[] {
  // 没有可信事实 = 没对齐 = 不屏蔽（探测失败不屏蔽，见文件头约束 2）。
  if (planKinds === undefined) return [];
  const hasSubscription = planKinds.includes("subscription");
  const hasExperience = planKinds.includes("experience");
  const blocked: CapabilityBlock[] = [];
  for (const route of account.routes) {
    const plane = quotaPlane(route);
    if (plane === "coding" && !hasSubscription) {
      blocked.push({ route, reason: hasExperience || planKinds.length > 0 ? "no-subscription" : "no-plan" });
    } else if (plane === "credits" && !hasExperience) {
      blocked.push({ route, reason: planKinds.length > 0 ? "no-experience" : "no-plan" });
    }
  }
  return blocked;
}

/** 每个账号最近一次成功探测到的套餐事实（进程内，不落盘）。*/
export class PlanCapabilityAlignment {
  private readonly probed = new Map<string, readonly AccountPlanKind[]>();

  /**
   * 记一次探测结果，返回对齐结果。
   *
   * `undefined` 是**没拿到事实**（失败/不完整），此时不改表、不发变化；`[]` 是
   * 「成功探测、两套平面都没有权益」，那是要全屏蔽的真实结论，两者绝不能混。
   */
  noteProbe(account: Account, planKinds: readonly AccountPlanKind[] | undefined): CapabilityAlignment {
    const previous = this.probed.get(account.id);
    if (planKinds !== undefined) this.probed.set(account.id, [...planKinds]);
    const effective = planKinds ?? previous;
    const blocked = capabilityBlocksOf(account, effective);
    const previousBlocks = capabilityBlocksOf(account, previous);
    return {
      accountId: account.id,
      planKinds: effective,
      blocked,
      changed: JSON.stringify(previousBlocks) !== JSON.stringify(blocked),
    };
  }

  /** 这个账号当前被屏蔽的路由（面板账号卡片 / 详情大窗读）。*/
  blockedOf(account: Account): CapabilityBlock[] {
    return capabilityBlocksOf(account, this.probed.get(account.id));
  }

  /** 这条 `(account, route)` 是不是被能力对齐挡住（broker 候选集第三层读）。*/
  isBlocked(account: Account, route: RouteKind): boolean {
    return this.blockedOf(account).some((block) => block.route === route);
  }

  /** 账号删除后清掉事实，避免表跟着账号无限增长（与 HealthEngine.forgetAccount 同纪律）。*/
  forgetAccount(accountId: string): void {
    this.probed.delete(accountId);
  }
}
