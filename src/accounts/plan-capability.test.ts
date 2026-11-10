/**
 * 能力对齐：实际持有套餐是硬约束，配置只表达用户意图。
 *
 * 三类账号（只有订阅 / 只有体验 / 都没有）× 策略变更 × 套餐变化全对表；
 * 重点钉住「探测失败不屏蔽」与「不改写 account.routes」。
 */
import { describe, expect, it } from "bun:test";
import { PlanCapabilityAlignment, capabilityBlocksOf } from "./plan-capability.js";
import { accountFor, zhipuCredential } from "./testing.js";
import type { Account, RouteKind } from "./types.js";

const ROUTES: RouteKind[] = ["start-plan", "coding-plan", "off-peak", "highspeed"];

function account(label: string, routes: RouteKind[] = ROUTES): Account {
  return accountFor(zhipuCredential({ apiKey: `key-${label}`, secret: `secret-${label}`, jwt: `jwt-${label}` }), {
    label,
    routes,
  });
}

describe("capabilityBlocksOf（数据面硬约束）", () => {
  it("探测失败（undefined）零屏蔽：不猜", () => {
    expect(capabilityBlocksOf(account("a"), undefined)).toEqual([]);
  });

  it("只有订阅：start-plan 屏蔽，coding 平面三条保留", () => {
    const blocked = capabilityBlocksOf(account("a"), ["subscription"]);
    expect(blocked).toEqual([{ route: "start-plan", reason: "no-experience" }]);
  });

  it("只有体验：coding 平面三条全屏蔽，start-plan 保留", () => {
    const blocked = capabilityBlocksOf(account("a"), ["experience"]);
    expect(blocked).toEqual([
      { route: "coding-plan", reason: "no-subscription" },
      { route: "off-peak", reason: "no-subscription" },
      { route: "highspeed", reason: "no-subscription" },
    ]);
  });

  it("两套权益都没有（探测成功）：全屏蔽且原因都是 no-plan", () => {
    const blocked = capabilityBlocksOf(account("a"), []);
    expect(blocked.map((entry) => entry.route)).toEqual(ROUTES);
    expect(blocked.every((entry) => entry.reason === "no-plan")).toBe(true);
  });

  it("双套餐：零屏蔽", () => {
    expect(capabilityBlocksOf(account("a"), ["subscription", "experience"])).toEqual([]);
  });
});

describe("PlanCapabilityAlignment（跟着路由策略走）", () => {
  it("策略变更不重探测：同一份事实按新的 routes 现算", () => {
    const alignment = new PlanCapabilityAlignment();
    const codingOnly = account("a", ["coding-plan"]);
    alignment.noteProbe(codingOnly, ["experience"]);
    // 面板/YAML 热改把白名单收窄到 start-plan：立即重对齐，不发第二次探测。
    const startOnly = account("a", ["start-plan"]);
    expect(alignment.blockedOf(startOnly)).toEqual([]);
    expect(alignment.isBlocked(startOnly, "start-plan")).toBe(false);
  });

  it("周期采样发现套餐变化：从只有体验变成双套餐，屏蔽自动解除", () => {
    const alignment = new PlanCapabilityAlignment();
    const a = account("a");
    const first = alignment.noteProbe(a, ["experience"]);
    expect(first.changed).toBe(true);
    expect(first.blocked).toHaveLength(3);

    const second = alignment.noteProbe(a, ["subscription", "experience"]);
    expect(second.changed).toBe(true);
    expect(second.blocked).toEqual([]);
    expect(alignment.isBlocked(a, "coding-plan")).toBe(false);
  });

  it("周期采样失败：保留上一次结论，不猜也不屏蔽变化", () => {
    const alignment = new PlanCapabilityAlignment();
    const a = account("a");
    alignment.noteProbe(a, ["experience"]);
    const failed = alignment.noteProbe(a, undefined);
    expect(failed.changed).toBe(false);
    expect(failed.blocked).toHaveLength(3);
  });

  it("同结论重复探测不刷对齐事件（changed=false）", () => {
    const alignment = new PlanCapabilityAlignment();
    const a = account("a");
    alignment.noteProbe(a, ["experience"]);
    expect(alignment.noteProbe(a, ["experience"]).changed).toBe(false);
  });

  it("forgetAccount 清掉事实", () => {
    const alignment = new PlanCapabilityAlignment();
    const a = account("a");
    alignment.noteProbe(a, ["experience"]);
    alignment.forgetAccount(a.id);
    expect(alignment.blockedOf(a)).toEqual([]);
  });
});
