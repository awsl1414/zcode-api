/**
 * 每账号卡槽的用例：两个账号各持独立卡槽互不影响、账号删除/禁用
 * 时卡槽停、心跳按 accountId 错峰。
 */
import { describe, expect, it, afterEach } from "bun:test";
import { HighspeedSlots, heartbeatPhaseOffset } from "./slots.js";
import { highspeedAuthFrom } from "./manager.js";
import { accountFor, inMemoryAccounts, zhipuCredential } from "../accounts/testing.js";

const ORIGIN = "https://zcode.z.ai";
const MODELS = ["glm-5.3", "glm-5.2", "glm-5.1"];

function accountA() {
  return accountFor(zhipuCredential({ jwt: "jwt-a", apiKey: "keyA", secret: "secA" }), { label: "alpha" });
}
function accountB() {
  return accountFor(zhipuCredential({ provider: "bigmodel", jwt: "jwt-b", apiKey: "keyB" }), { label: "beta" });
}

/** 抽卡 mock：卡 ID 由 Authorization 派生 → 一眼能看出是哪张卡槽抽到的。*/
function drawMock(drawn: string[], clock: { now: number }) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith("/api/v1/highspeed/draw")) {
      return new Response(JSON.stringify({
        code: 0, msg: "success",
        data: { card_id: "hsc_x", prompt_tokens: 1, completion_tokens: 2, duration_seconds: 3 },
      }), { status: 200 });
    }
    const headers = new Headers(init?.headers);
    const jwt = headers.get("authorization")?.replace("Bearer ", "") ?? "?";
    drawn.push(jwt);
    const body = JSON.parse(String(init?.body)) as { task_id: string; model: string };
    return new Response(JSON.stringify({
      code: 0,
      msg: "success",
      data: {
        card: {
          card_id: `hsc_${jwt}`,
          task_id: body.task_id,
          provider: "builtin:zai-coding-plan",
          model: body.model,
          issued_at: clock.now,
          expires_at: clock.now + 300_000,
        },
        next_draw_at: clock.now + 120_000,
      },
    }), { status: 200 });
  }) as unknown as typeof fetch;
}

async function until(cond: () => boolean): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return cond();
}

const created: HighspeedSlots[] = [];
afterEach(() => {
  for (const slots of created.splice(0)) slots.stopAll();
});

function makeSlots(fetchImpl: typeof fetch, clock: { now: number }, jitterHeartbeat = false): HighspeedSlots {
  const slots = new HighspeedSlots({
    origin: ORIGIN,
    models: MODELS,
    jitterHeartbeat,
    retryMs: 2,
    fetchImpl,
    now: () => clock.now,
    random: () => 0.5, // 抖动项归零，相位只由哈希决定（用例要可重复）
  });
  created.push(slots);
  return slots;
}

describe("HighspeedSlots（每账号独立卡槽）", () => {
  it("两个账号同时活跃时各持独立卡槽，互不影响", async () => {
    const clock = { now: 1_000_000 };
    const drawn: string[] = [];
    const slots = makeSlots(drawMock(drawn, clock), clock);
    const a = accountA();
    const b = accountB();

    const managerA = slots.forAccount(a);
    const managerB = slots.forAccount(b);
    expect(managerA).not.toBe(managerB);
    expect(managerA.accountId).toBe(a.id);
    expect(managerB.accountId).toBe(b.id);

    managerA.onRequest("glm-5.3", "task-a", highspeedAuthFrom(a)!);
    managerB.onRequest("glm-5.3", "task-b", highspeedAuthFrom(b)!);
    expect(await until(() => managerA.activeCard() !== null && managerB.activeCard() !== null)).toBeTrue();

    // 各自的卡来自各自的账号（互不抢卡：派生权益必须继承同账号母体）
    expect(managerA.activeCard()?.cardId).toBe("hsc_jwt-a");
    expect(managerB.activeCard()?.cardId).toBe("hsc_jwt-b");
    expect(drawn).toContain("jwt-a");
    expect(drawn).toContain("jwt-b");

    // 丢掉 A 的卡不影响 B
    managerA.dropCard("test");
    await new Promise((r) => setTimeout(r, 5));
    expect(managerB.activeCard()?.cardId).toBe("hsc_jwt-b");
  });

  it("同一账号重复取卡槽返回同一个实例（不重复点燃循环）", () => {
    const clock = { now: 1_000_000 };
    const slots = makeSlots(drawMock([], clock), clock);
    const account = accountA();
    expect(slots.forAccount(account)).toBe(slots.forAccount(account));
    expect(slots.accountIds()).toEqual([account.id]);
  });

  it("账号被禁用 / 删除后其卡槽停止（reconcile）", async () => {
    const clock = { now: 1_000_000 };
    const drawn: string[] = [];
    const slots = makeSlots(drawMock(drawn, clock), clock);
    const a = accountA();
    const b = accountB();
    slots.forAccount(a).onRequest("glm-5.3", "task-a", highspeedAuthFrom(a)!);
    slots.forAccount(b).onRequest("glm-5.3", "task-b", highspeedAuthFrom(b)!);
    expect(await until(() => drawn.length >= 2)).toBeTrue();

    // A 被禁用：只回收 A 的卡槽，B 原样保留
    slots.reconcile([{ ...a, enabled: false }, b]);
    expect(slots.accountIds()).toEqual([b.id]);

    const afterStop = drawn.filter((jwt) => jwt === "jwt-a").length;
    await new Promise((r) => setTimeout(r, 20));
    expect(drawn.filter((jwt) => jwt === "jwt-a").length).toBe(afterStop); // A 的循环确实停了
  });

  it("stopAccount 幂等：没实例时返回 false", () => {
    const clock = { now: 1_000_000 };
    const slots = makeSlots(drawMock([], clock), clock);
    expect(slots.stopAccount("nobody")).toBeFalse();
    const a = accountA();
    slots.forAccount(a);
    expect(slots.stopAccount(a.id)).toBeTrue();
    expect(slots.stopAccount(a.id)).toBeFalse();
    expect(slots.accountIds()).toEqual([]);
  });

  it("账号仓写入后通知观察者 → 被删账号的卡槽当场回收", async () => {
    const clock = { now: 1_000_000 };
    const slots = makeSlots(drawMock([], clock), clock);
    const a = accountA();
    const b = accountB();
    const { manager } = inMemoryAccounts([a, b]);
    manager.onChange((list) => slots.reconcile(list));
    slots.forAccount(a);
    slots.forAccount(b);
    expect(slots.accountIds().sort()).toEqual([a.id, b.id].sort());

    await manager.remove(a.id);
    expect(slots.accountIds()).toEqual([b.id]);
  });

  it("账号被禁用（update enabled:false）同样回收卡槽", async () => {
    const clock = { now: 1_000_000 };
    const slots = makeSlots(drawMock([], clock), clock);
    const a = accountA();
    const { manager } = inMemoryAccounts([a]);
    manager.onChange((list) => slots.reconcile(list));
    slots.forAccount(a);
    await manager.update(a.id, { enabled: false });
    expect(slots.accountIds()).toEqual([]);
  });

  it("设备指纹按账号取，没有全局兜底值", async () => {
    const clock = { now: 1_000_000 };
    // 抽卡请求头里的 X-Device-Mid 就是账号指纹（没有全局值可回落）。
    const seen: Record<string, string | null> = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const jwt = headers.get("authorization")?.replace("Bearer ", "") ?? "?";
      seen[jwt] = headers.get("x-device-mid");
      return new Response(JSON.stringify({ code: 0, msg: "success", data: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const slots = new HighspeedSlots({
      origin: ORIGIN,
      models: MODELS,
      jitterHeartbeat: false,
      retryMs: 2,
      fetchImpl,
      now: () => clock.now,
    });
    created.push(slots);
    const own = accountFor(zhipuCredential({ jwt: "jwt-own", identity: { targetType: "PERSONAL", deviceMid: "device-own" } }));
    const other = accountFor(zhipuCredential({ jwt: "jwt-other", apiKey: "keyF", identity: { targetType: "PERSONAL", deviceMid: "device-other" } }));
    const managerOwn = slots.forAccount(own);
    const managerOther = slots.forAccount(other);
    // 抽卡循环由请求点燃（`onRequest`），没有请求就不会抽卡。
    managerOwn.onRequest("glm-5.3", "task-own", highspeedAuthFrom(own)!);
    managerOther.onRequest("glm-5.3", "task-other", highspeedAuthFrom(other)!);
    await until(() => seen["jwt-own"] !== undefined && seen["jwt-other"] !== undefined);
    expect(seen["jwt-own"]).toBe("device-own");
    expect(seen["jwt-other"]).toBe("device-other");
  });
});

describe("heartbeatPhaseOffset（心跳错峰）", () => {
  it("同一账号相位稳定，不同账号相位不同，且都落在 [0, interval] 内", () => {
    const interval = 1_000;
    const first = heartbeatPhaseOffset("account-a", interval, () => 0.5);
    expect(heartbeatPhaseOffset("account-a", interval, () => 0.5)).toBe(first); // 确定性
    const offsets = new Set(["account-a", "account-b", "account-c", "account-d"].map((id) => heartbeatPhaseOffset(id, interval, () => 0.5)));
    expect(offsets.size).toBeGreaterThan(1); // 不是同拍
    for (const offset of offsets) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThanOrEqual(interval);
    }
  });

  it("抖动幅度不超过心跳间隔的 ±10%", () => {
    const interval = 1_000;
    const base = heartbeatPhaseOffset("account-a", interval, () => 0.5);
    const low = heartbeatPhaseOffset("account-a", interval, () => 0);
    const high = heartbeatPhaseOffset("account-a", interval, () => 1);
    expect(base - low).toBeLessThanOrEqual(interval * 0.1);
    expect(high - base).toBeLessThanOrEqual(interval * 0.1);
  });

  it("jitterHeartbeat 关闭时不偏移（首抽即发）", async () => {
    const clock = { now: 1_000_000 };
    const drawn: string[] = [];
    const slots = makeSlots(drawMock(drawn, clock), clock, false);
    const a = accountA();
    slots.forAccount(a).onRequest("glm-5.3", "task-a", highspeedAuthFrom(a)!);
    expect(drawn.length).toBe(1); // 同步点燃，无相位延迟
  });

  it("jitterHeartbeat 打开时首抽被推迟（不同账号不同拍）", async () => {
    const clock = { now: 1_000_000 };
    const drawn: string[] = [];
    const slots = makeSlots(drawMock(drawn, clock), clock, true);
    const a = accountA();
    slots.forAccount(a).onRequest("glm-5.3", "task-a", highspeedAuthFrom(a)!);
    expect(drawn.length).toBe(0); // 相位未到（retryMs=2 时偏移可能为 0，见下一行兜底）
    expect(await until(() => drawn.length >= 1)).toBeTrue();
  });
});
