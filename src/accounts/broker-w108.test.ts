/**
 * broker 接线：候选集能力对齐层 + 终态码/空流即时复采 + 分级采转发。
 *
 * 覆盖「跟着路由策略走」与「一个机制两处用」（分级采既给面板也给能力对齐）。
 */
import { describe, expect, it } from "bun:test";
import type { CapabilityAlignment } from "./plan-capability.js";
import { accountFor, inMemoryAccounts, zhipuCredential } from "./testing.js";
import type { RouteKind } from "./types.js";

function fullAccount(label = "a", routes: RouteKind[] = ["start-plan", "coding-plan"]) {
  return accountFor(zhipuCredential({ apiKey: `key-${label}`, secret: `s-${label}`, jwt: `jwt-${label}` }), {
    label,
    routes,
  });
}

describe("候选集第三 b 层：实际套餐能力", () => {
  it("只有体验权益时 coding-plan 不派发，配置里的 routes 一个字都不改", async () => {
    const account = fullAccount();
    const { manager, broker } = inMemoryAccounts([account], { routing: { order: ["start-plan", "coding-plan"] } });
    const alignment = broker.capability.noteProbe(account, ["experience"]);
    broker.notePlanProbe(account, alignment, "test");

    const lease = await broker.acquire();
    expect(lease.route).toBe("start-plan");
    lease.release();
    // 运行时交集遮蔽：用户意图原样保留，套餐买回来周期采样一发现就自动放开。
    expect((await manager.get(account.id))?.routes).toEqual(["start-plan", "coding-plan"]);

    const promoted = broker.capability.noteProbe(account, ["subscription", "experience"]);
    broker.notePlanProbe(account, promoted, "test");
    const coding = await broker.acquire({ pinnedRoute: "coding-plan" });
    expect(coding.route).toBe("coding-plan");
    coding.release();
  });

  it("路由策略变更立即按已探测事实重对齐（不重探测）", async () => {
    const account = fullAccount();
    const { broker } = inMemoryAccounts([account], { routing: { order: ["start-plan"] } });
    broker.capability.noteProbe(account, ["experience"]);
    const lease = await broker.acquire();
    expect(lease.route).toBe("start-plan");
    lease.release();

    broker.routing.order = ["coding-plan"];
    await expect(broker.acquire()).rejects.toThrow();
  });

  it("对齐变化才落调度事件，重复结论不刷事件", async () => {
    const account = fullAccount();
    const events: CapabilityAlignment[] = [];
    const { broker } = inMemoryAccounts([account], {
      onAlignment: (alignment) => events.push(alignment),
    });
    broker.notePlanProbe(account, broker.capability.noteProbe(account, ["experience"]), "startup");
    broker.notePlanProbe(account, broker.capability.noteProbe(account, ["experience"]), "periodic");
    expect(events).toHaveLength(1);
    expect(events[0]!.blocked.map((block) => block.route)).toContain("coding-plan");
  });
});

describe("终态码/空流即时复采", () => {
  it("quota-terminal 与 empty-stream 各触发一次；其它信号不触发", async () => {
    const account = fullAccount();
    const calls: string[] = [];
    const { broker } = inMemoryAccounts([account], {
      resample: async (id, origin) => {
        calls.push(`${id}:${origin}`);
        return null;
      },
    });
    broker.noteUpstreamSignal(account, "coding-plan", { kind: "quota-terminal" });
    broker.noteUpstreamSignal(account, "start-plan", { kind: "empty-stream" });
    broker.noteUpstreamSignal(account, "coding-plan", { kind: "rate-limited" });
    broker.noteUpstreamSignal(account, "coding-plan", { kind: "success" });
    // fire-and-forget：让注入回调的 promise 微任务落地。
    await Promise.resolve();
    expect(calls).toEqual([`${account.id}:signal:quota-terminal`, `${account.id}:signal:empty-stream`]);
  });
});

describe("顶栏分级采转发", () => {
  it("只采分类器选中的账号；sampleNow 去重命中记 skipped", async () => {
    const a = fullAccount("a");
    const b = fullAccount("b");
    const sampled: string[] = [];
    const { broker } = inMemoryAccounts([a, b], {
      classifyRefresh: (ids, focused) => (focused ? [focused] : [ids[0]!]),
    });
    const decision = await broker.refreshQuota([a.id, b.id], undefined, async (id) => {
      sampled.push(id);
      return null; // 模拟 30s 去重
    });
    expect(sampled).toEqual([a.id]);
    expect(decision.sampled).toEqual([]);
    expect(decision.skipped).toEqual([a.id, b.id]);

    const focused = await broker.refreshQuota([a.id, b.id], b.id, async (id) => {
      sampled.push(id);
      return [{ accountId: id }] as never;
    });
    expect(focused.sampled).toEqual([b.id]);
    expect(focused.skipped).toEqual([a.id]);
  });
});
