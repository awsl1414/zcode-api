import { describe, expect, it, afterEach } from "bun:test";
import {
  HighspeedManager,
  applyHighspeedCardHeaders,
  highspeedAuthFrom,
  highspeedAuthHeaders,
  isHighspeedFailure,
  type HighspeedAuth,
} from "./manager.js";
import type { UpstreamHeaderPair } from "../proxy/upstream.js";
import { zhipuCredential, accountFor } from "../accounts/testing.js";

/** PERSONAL 账号鉴权（身份从账号读）。*/
const AUTH: HighspeedAuth = {
  jwt: "test-jwt",
  codingPlanAuth: "testkey.testsecret",
  family: "zai",
  identity: { targetType: "PERSONAL" },
};
const TEAM_AUTH: HighspeedAuth = {
  jwt: "team-jwt",
  codingPlanAuth: "teamkey.teamsecret",
  family: "bigmodel",
  identity: { targetType: "TEAM", organizationId: "org-1", projectId: "proj-1" },
};
const DRAW_URL = "https://zcode.z.ai/api/v1/highspeed/draw";
const SESSION_TASK = "11111111-2222-3333-4444-555555555555";

interface DrawCall { url: string; method: string; body: Record<string, unknown>; headers: Headers; }

function drawResponse(card: Record<string, unknown> | null, nextDrawAt?: number): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data: { card, next_draw_at: nextDrawAt ?? 0 } }), { status: 200 });
}

function healthyResponse(cardId = "hsc_test_1"): Response {
  return new Response(JSON.stringify({
    code: 0,
    msg: "success",
    data: { card_id: cardId, prompt_tokens: 11, completion_tokens: 22, duration_seconds: 3 },
  }), { status: 200 });
}

function hitCard(now: number, model = "glm-5.3"): Record<string, unknown> {
  return { card_id: "hsc_test_1", task_id: SESSION_TASK, provider: "builtin:zai-coding-plan", model, issued_at: now, expires_at: now + 300_000 };
}

/** Live managers registry — afterEach stops every heartbeat timer. */
const live: HighspeedManager[] = [];
afterEach(() => {
  for (const m of live.splice(0)) m.stop();
});

function makeManager(
  fetchImpl: typeof fetch,
  clock: { now: number },
  opts: { retryMs?: number; onEvent?: (message: string) => void } = {},
): HighspeedManager {
  const manager = new HighspeedManager({
    accountId: "account-test",
    origin: "https://zcode.z.ai",
    models: ["glm-5.3", "glm-5.2", "glm-5.1"],
    fetchImpl,
    now: () => clock.now,
    retryMs: opts.retryMs ?? 2,
    onEvent: opts.onEvent,
  });
  live.push(manager);
  return manager;
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

/** Poll until cond() holds or ~1s elapses (real-timer tests). */
async function until(cond: () => boolean): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return cond();
}

/** 抽卡请求（POST draw）与健康检查（GET …/healthy）分开计数。*/
function isDraw(url: string): boolean {
  return url.endsWith("/api/v1/highspeed/draw");
}

describe("HighspeedManager", () => {
  it("refreshes the idle window during held-card traffic before rejection", async () => {
    const clock = { now: 1_000_000 };
    let draws = 0;
    const manager = makeManager((async (input: RequestInfo | URL) => {
      if (!isDraw(String(input))) return healthyResponse();
      draws++;
      return drawResponse({ ...hitCard(clock.now), expires_at: clock.now + 900_000 });
    }) as unknown as typeof fetch, clock);
    manager.onRequest("glm-5.2", SESSION_TASK, AUTH);
    expect(await until(() => manager.activeCard() !== null)).toBe(true);
    await settle();
    clock.now += 301_000;
    manager.onRequest("glm-5.2", SESSION_TASK, AUTH);
    expect(draws).toBe(1);
    manager.dropCard("upstream_rejected");
    expect(await until(() => draws === 2)).toBe(true);
  });

  it("draws on the first eligible request and holds the single card slot", async () => {
    const clock = { now: 1_000_000 };
    const calls: DrawCall[] = [];
    const manager = makeManager((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}, headers: new Headers(init?.headers) });
      return isDraw(url) ? drawResponse(hitCard(clock.now)) : healthyResponse();
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.1", SESSION_TASK, AUTH);
    await settle();
    const card = manager.activeCard();
    expect(card?.cardId).toBe("hsc_test_1");
    expect(card?.model).toBe("glm-5.3");

    // second eligible request while holding → no new draw
    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    await settle();
    expect(calls.filter((c) => isDraw(c.url)).length).toBe(1);

    // draw request shape: Coding Plan dual JWT + account identity + body fields
    const draw = calls.filter((c) => isDraw(c.url))[0]!;
    expect(draw.url).toBe(DRAW_URL);
    expect(draw.method).toBe("POST");
    expect(draw.headers.get("authorization")).toBe("Bearer test-jwt");
    expect(draw.headers.get("x-bigmodel-authorization")).toBe("Bearer testkey.testsecret");
    // PERSONAL 账号只带 Target-Type，不带 TEAM 的两个头
    expect(draw.headers.get("bigmodel-target-type")).toBe("PERSONAL");
    expect(draw.headers.get("bigmodel-organization")).toBeNull();
    expect(draw.headers.get("bigmodel-project")).toBeNull();
    expect(draw.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(draw.body.task_id).toBe(SESSION_TASK);
    expect(draw.body.provider).toBe("builtin:zai-coding-plan");
    // 抽卡 body 的 model 就是请求模型，没有任何改写
    expect(draw.body.model).toBe("glm-5.1");
    // deviceMid omitted when not provided (makeManager passes none)
    expect(draw.headers.get("x-device-mid")).toBeNull();
  });

  it("sends the four TEAM identity headers on draw and card requests", async () => {
    const clock = { now: 1_000_000 };
    const calls: DrawCall[] = [];
    const manager = makeManager((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}, headers: new Headers(init?.headers) });
      return isDraw(url) ? drawResponse(hitCard(clock.now, "glm-5.3")) : healthyResponse();
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, TEAM_AUTH);
    expect(await until(() => manager.activeCard() !== null)).toBeTrue();

    const draw = calls.find((c) => isDraw(c.url))!;
    expect(draw.headers.get("bigmodel-target-type")).toBe("TEAM");
    expect(draw.headers.get("bigmodel-organization")).toBe("org-1");
    expect(draw.headers.get("bigmodel-project")).toBe("proj-1");
    expect(draw.body.provider).toBe("builtin:bigmodel-coding-plan");

    // 加速推理侧用同一套头 + 卡 ID（官方：两条路径同一套鉴权中间件）
    const pairs = applyHighspeedCardHeaders([["content-type", "application/json"]], manager.activeCard()!, TEAM_AUTH);
    expect(pairs.find(([k]) => k === "Bigmodel-Target-Type")?.[1]).toBe("TEAM");
    expect(pairs.find(([k]) => k === "Bigmodel-Organization")?.[1]).toBe("org-1");
    expect(pairs.find(([k]) => k === "Bigmodel-Project")?.[1]).toBe("proj-1");
    expect(pairs.find(([k]) => k === "X-Highspeed-Card-ID")?.[1]).toBe("hsc_test_1");
  });

  it("sends X-Device-Mid on draws when provided (activity-gate 3001 fix, live 2026-10-12)", async () => {
    const clock = { now: 1_000_000 };
    const calls: DrawCall[] = [];
    const manager = new HighspeedManager({
      accountId: "account-device",
      origin: "https://zcode.z.ai",
      models: ["glm-5.3"],
      deviceMid: "  e6e1ef31-b69a-496b-8428-ae909abc8904  ",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}, headers: new Headers(init?.headers) });
        return isDraw(url) ? drawResponse(hitCard(clock.now)) : healthyResponse();
      }) as unknown as typeof fetch,
      now: () => clock.now,
    });
    live.push(manager);
    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    await settle();
    const draw = calls.find((c) => isDraw(c.url))!;
    expect(draw.headers.get("x-device-mid")).toBe("e6e1ef31-b69a-496b-8428-ae909abc8904");
  });

  it("draws synchronously on ignite: the first fetch starts before any await", () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const manager = makeManager((async () => {
      fetches++;
      return drawResponse(null);
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    expect(fetches).toBe(1); // fired within onRequest, not on a timer
  });

  it("defers the first draw by the account's phase offset (heartbeat stagger)", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const manager = new HighspeedManager({
      accountId: "account-phased",
      origin: "https://zcode.z.ai",
      models: ["glm-5.3"],
      startDelayMs: 20,
      retryMs: 5,
      fetchImpl: (async () => {
        fetches++;
        return drawResponse(null);
      }) as unknown as typeof fetch,
      now: () => clock.now,
    });
    live.push(manager);
    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    expect(fetches).toBe(0); // 相位未到：循环已点燃但首抽推迟
    expect(await until(() => fetches >= 1)).toBeTrue();
  });

  it("retries at the heartbeat cadence after a miss — server next_draw_at is ignored", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const manager = makeManager((async () => {
      fetches++;
      return drawResponse(null, clock.now + 120_000);
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    expect(await until(() => fetches >= 3)).toBeTrue(); // ≥3 tries without new requests
  });

  it("stops the loop 5 minutes after the last eligible request (idle self-extinguish)", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const events: string[] = [];
    const manager = makeManager((async () => {
      fetches++;
      return drawResponse(null);
    }) as unknown as typeof fetch, clock, { onEvent: (m) => events.push(m) });

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    expect(await until(() => fetches >= 2)).toBeTrue();
    clock.now += 5 * 60_000 + 1; // idle window closed
    expect(await until(() => events.some((m) => m.includes("idle-stopped")))).toBeTrue();
    const fetchesAtStop = fetches;
    clock.now += 60_000;
    await settle();
    expect(fetches).toBe(fetchesAtStop); // loop is dead — no more draws
  });

  it("noteActivity (in-flight stream still producing) extends the idle window — no self-extinguish mid-stream", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const events: string[] = [];
    const manager = makeManager((async () => {
      fetches++;
      return drawResponse(null);
    }) as unknown as typeof fetch, clock, { onEvent: (m) => events.push(m) });

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    expect(await until(() => fetches >= 2)).toBeTrue();
    // 4 minutes into a long stream the SSE is still producing — that is
    // activity, not idle: the stream-end touch re-arms the 5min window.
    clock.now += 4 * 60_000;
    manager.noteActivity();
    clock.now += 4 * 60_000 + 1; // 8min after the request, 4min+1ms after the touch
    await settle();
    expect(events.some((m) => m.includes("idle-stopped"))).toBeFalse(); // re-armed — loop alive
    expect(fetches).toBeGreaterThanOrEqual(2); // still drawing
    // Only a real gap past the TOUCHED window stops it.
    clock.now += 60_000 + 2; // >5min since the touch
    expect(await until(() => events.some((m) => m.includes("idle-stopped")))).toBeTrue();
    const fetchesAtStop = fetches;
    clock.now += 60_000;
    await settle();
    expect(fetches).toBe(fetchesAtStop); // loop dead — noteActivity never re-ignites
    manager.noteActivity(); // inert on a stopped loop: extends loopUntil but draws nothing
    clock.now += 60_000;
    await settle();
    expect(fetches).toBe(fetchesAtStop);
  });

  it("re-ignites after idle-stop when a new request arrives", async () => {
    const clock = { now: 1_000_000 };
    const manager = makeManager((async (input: RequestInfo | URL) =>
      isDraw(String(input)) ? drawResponse(hitCard(clock.now)) : healthyResponse()) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    await settle();
    expect(manager.activeCard()?.cardId).toBe("hsc_test_1");

    // card expires, loop had stopped; 10 idle minutes pass
    clock.now += 295_000;
    expect(manager.activeCard()).toBeNull();
    clock.now += 10 * 60_000;
    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    await settle();
    expect(manager.activeCard()?.cardId).toBe("hsc_test_1"); // re-ignited and drew again
  });

  it("keeps redrawing after the card expires mid-idle-window", async () => {
    const clock = { now: 1_000_000 };
    let draws = 0;
    const manager = makeManager((async (input: RequestInfo | URL) => {
      if (!isDraw(String(input))) return healthyResponse();
      draws++;
      return draws <= 4
        ? drawResponse(null)
        : drawResponse(hitCard(clock.now));
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    expect(await until(() => manager.activeCard()?.cardId === "hsc_test_1")).toBeTrue(); // hit on the 5th draw
    const drawsAtFirstHit = draws;

    clock.now += 295_000; // 5s left — under the minimum-remaining guard
    expect(manager.activeCard()).toBeNull();
    manager.onRequest("glm-5.3", SESSION_TASK, AUTH); // re-ignite inside idle window (sub-min card must not block)
    expect(await until(() => draws > drawsAtFirstHit && manager.activeCard()?.cardId === "hsc_test_1")).toBeTrue();
    expect(draws).toBeGreaterThan(drawsAtFirstHit); // fresh draws actually fired past the first hit
  });

  it("blocks only the rejected model on draw 400 and keeps the account drawable (2026-10-14 flash finding)", async () => {
    const clock = { now: 1_000_000 };
    let calls = 0;
    const manager = makeManager((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!isDraw(String(input))) return healthyResponse();
      calls++;
      const body = JSON.parse(String(init?.body)) as { model: string };
      return body.model === "glm-5.3-flash"
        ? new Response(JSON.stringify({ code: 3001, msg: "parameter error", logid: "x" }), { status: 400 })
        : drawResponse(hitCard(clock.now, body.model));
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3-flash", SESSION_TASK, AUTH);
    await settle();
    expect(calls).toBe(1); // one probe draw sufficed to learn the rejection

    manager.onRequest("glm-5.3-flash", SESSION_TASK, AUTH); // blocked — no refetch
    await settle();
    expect(calls).toBe(1);

    // the account itself is fine: another model draws and hits normally
    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    expect(await until(() => manager.activeCard()?.cardId === "hsc_test_1")).toBeTrue();
    expect(calls).toBe(2);
  });

  it("treats a card whose model differs from the request as invalid and drops it", async () => {
    const clock = { now: 1_000_000 };
    let draws = 0;
    const manager = makeManager((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!isDraw(String(input))) return healthyResponse();
      draws++;
      const requested = (JSON.parse(String(init?.body)) as { model: string }).model;
      // 第一次故意回一张**别的**模型的卡（上游回错卡 / 会话模型已切换）
      return drawResponse(hitCard(clock.now, draws === 1 ? "glm-5.3" : requested));
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.1", SESSION_TASK, AUTH);
    expect(await until(() => manager.activeCard() !== null)).toBeTrue();
    expect(manager.activeCard()?.model).toBe("glm-5.3");

    // 卡上 model 与请求 model 不一致 = 无效卡，直接丢弃（绝不改写 body 去迁就它）
    expect(manager.activeCardFor("glm-5.1")).toBeNull();
    expect(manager.activeCard()).toBeNull();

    // 丢弃后按请求模型重抽；一致才可用
    expect(await until(() => manager.activeCardFor("glm-5.1") !== null)).toBeTrue();
    expect(draws).toBeGreaterThanOrEqual(2);
  });

  it("matches card models case-insensitively (官方目录写 GLM-5.3)", async () => {
    const clock = { now: 1_000_000 };
    const manager = makeManager((async (input: RequestInfo | URL) =>
      isDraw(String(input)) ? drawResponse(hitCard(clock.now, "GLM-5.3")) : healthyResponse()) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    expect(await until(() => manager.activeCard() !== null)).toBeTrue();
    expect(manager.activeCardFor("glm-5.3")?.cardId).toBe("hsc_test_1");
  });

  it("health-checks the card on obtain and again at expiry — statistics only", async () => {
    const clock = { now: 1_000_000 };
    const healthy: string[] = [];
    let draws = 0;
    const manager = makeManager((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!isDraw(url)) {
        healthy.push(url);
        return healthyResponse();
      }
      draws++;
      return draws === 1 ? drawResponse(hitCard(clock.now)) : drawResponse(null);
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    expect(await until(() => manager.usageOf("hsc_test_1") !== undefined)).toBeTrue();
    // 官方路径：GET {origin}/api/v1/highspeed/{cardId}/healthy
    expect(healthy[0]).toBe("https://zcode.z.ai/api/v1/highspeed/hsc_test_1/healthy");
    expect(manager.usageOf("hsc_test_1")?.completionTokens).toBe(22);
    expect(manager.usageOf("hsc_test_1")?.promptTokens).toBe(11);

    // 卡到期：再查一次（官方在卡到期后补采卡级用量）
    clock.now += 300_001;
    expect(manager.activeCard()).toBeNull();
    expect(await until(() => healthy.length === 2)).toBeTrue();
  });

  it("ignores health-check failures — the card still works (statistics only)", async () => {
    const clock = { now: 1_000_000 };
    const events: string[] = [];
    const manager = makeManager((async (input: RequestInfo | URL) => {
      if (!isDraw(String(input))) throw new Error("healthy endpoint down");
      return drawResponse(hitCard(clock.now));
    }) as unknown as typeof fetch, clock, { onEvent: (m) => events.push(m) });

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    expect(await until(() => manager.activeCard()?.cardId === "hsc_test_1")).toBeTrue();
    await settle();
    expect(manager.usageOf("hsc_test_1")).toBeUndefined(); // 没有采到用量，但卡照常可用
    expect(events.some((m) => m.includes("health check failed"))).toBeTrue();
  });

  it("backs off 5s on HTTP 429, then resumes the heartbeat (2026-10-14 calibrated)", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const manager = makeManager((async () => {
      fetches++;
      return new Response("", { status: 429 });
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.1", SESSION_TASK, AUTH);
    await settle();
    const atTwo = fetches;
    clock.now += 2_000; // inside the 5s backoff
    await settle();
    expect(fetches).toBe(atTwo); // no retries while backing off

    clock.now += 4_000; // past backoff
    expect(await until(() => fetches > atTwo)).toBeTrue();
  });

  it("negative-caches account unavailability (503 / biz 3404) for 10 minutes", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const manager = makeManager((async () => {
      fetches++;
      return new Response(JSON.stringify({ code: 3404, msg: "highspeed is temporarily unavailable" }), { status: 503 });
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.2", SESSION_TASK, AUTH);
    await settle();
    const atTwo = fetches;
    // Stay inside the idle window across both clock jumps so the gate under
    // test is the negative cache, not the idle self-extinguish.
    clock.now += 120_000;
    manager.onRequest("glm-5.2", SESSION_TASK, AUTH);
    await settle();
    expect(fetches).toBe(atTwo); // still negative-cached

    clock.now += 8 * 60_000 + 1_000; // past 10min negative cache
    manager.onRequest("glm-5.2", SESSION_TASK, AUTH);
    expect(await until(() => fetches > atTwo)).toBeTrue();
  });

  it("draws with the latest request's model after a mid-loop model change", async () => {
    const clock = { now: 1_000_000 };
    const bodies: Record<string, unknown>[] = [];
    const manager = makeManager((async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return drawResponse(null);
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    manager.onRequest("glm-5.2", SESSION_TASK, AUTH); // newer params win
    await until(() => bodies.length >= 3);
    expect(bodies.slice(1).every((b) => b.model === "glm-5.2")).toBeTrue();
    expect(bodies[0]!.model).toBe("glm-5.3");
  });

  it("deduplicates concurrent draws into a single fetch", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const manager = makeManager((async (input: RequestInfo | URL) => {
      // 健康检查走同一个 fetch，不算抽卡次数
      if (!isDraw(String(input))) return healthyResponse();
      fetches++;
      await new Promise((r) => setTimeout(r, 10));
      return drawResponse(hitCard(clock.now));
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    manager.onRequest("glm-5.3", "another-task", AUTH);
    manager.onRequest("glm-5.3", "third-task", AUTH);
    await settle();
    await settle();
    expect(fetches).toBe(1);
  });

  it("drops the card on upstream failure and redraws immediately", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const manager = makeManager((async (input: RequestInfo | URL) => {
      if (!isDraw(String(input))) return healthyResponse();
      fetches++;
      return drawResponse(hitCard(clock.now));
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    await settle();
    expect(manager.activeCard()).toBeDefined();

    manager.dropCard("upstream_rejected");
    await settle();
    expect(await until(() => manager.activeCard()?.cardId === "hsc_test_1")).toBeTrue();
    expect(fetches).toBeGreaterThanOrEqual(2);
  });

  it("redraws with the current account's auth after a cross-account card rejection", async () => {
    const clock = { now: 1_000_000 };
    const calls: DrawCall[] = [];
    const authA: HighspeedAuth = { jwt: "jwt-account-a", codingPlanAuth: "keyA.secret", family: "zai", identity: { targetType: "PERSONAL"  } };
    const authB: HighspeedAuth = { jwt: "jwt-account-b", codingPlanAuth: "keyB.secret", family: "bigmodel", identity: { targetType: "PERSONAL"  } };
    const manager = makeManager((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}, headers: new Headers(init?.headers) });
      return isDraw(url) ? drawResponse(hitCard(clock.now)) : healthyResponse();
    }) as unknown as typeof fetch, clock);

    // account A ignites the loop and holds the card
    manager.onRequest("glm-5.3", SESSION_TASK, authA);
    await settle();
    expect(manager.activeCard()?.cardId).toBe("hsc_test_1");

    // credential switch: B's requests early-return while the card is held —
    // `latest` must still move to B so the redraw uses B's auth
    manager.onRequest("glm-5.3", SESSION_TASK, authB);
    await settle();
    expect(calls.filter((c) => isDraw(c.url)).length).toBe(1); // held card suppresses drawing

    // upstream rejects B's use of A's card → selectionFallback redraw
    manager.dropCard("upstream_rejected");
    expect(await until(() => calls.filter((c) => isDraw(c.url)).length >= 2)).toBeTrue();
    const redraw = calls.filter((c) => isDraw(c.url))[1]!;
    expect(redraw.headers.get("authorization")).toBe("Bearer jwt-account-b");
    expect(redraw.headers.get("x-bigmodel-authorization")).toBe("Bearer keyB.secret");
    expect(redraw.body.provider).toBe("builtin:bigmodel-coding-plan");
  });

  it("skips drawing without a JWT and matches only configured model prefixes", () => {
    let fetches = 0;
    const manager = makeManager((async () => {
      fetches++;
      return drawResponse(null);
    }) as unknown as typeof fetch, { now: 1_000_000 });

    manager.onRequest("glm-5.3", SESSION_TASK, { ...AUTH, jwt: "  " });
    expect(fetches).toBe(0);

    expect(manager.isEligibleModel("glm-5.3")).toBeTrue();
    expect(manager.isEligibleModel("GLM-5.3-Flash")).toBeTrue();
    expect(manager.isEligibleModel("glm-4.6")).toBeFalse();
    expect(manager.isEligibleModel(undefined)).toBeFalse();
    manager.onRequest("glm-4.6", SESSION_TASK, AUTH);
    expect(fetches).toBe(0);
  });

  it("surfaces idle-stop exactly once via onEvent", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const events: string[] = [];
    const manager = makeManager((async () => {
      fetches++;
      return drawResponse(null);
    }) as unknown as typeof fetch, clock, { onEvent: (m) => events.push(m) });

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    await until(() => fetches >= 1);
    clock.now += 5 * 60_000 + 1;
    expect(await until(() => events.filter((m) => m.includes("idle-stopped")).length === 1)).toBeTrue();
    clock.now += 60_000;
    await settle();
    expect(events.filter((m) => m.includes("idle-stopped")).length).toBe(1); // no repeat
  });
});

describe("highspeed helpers", () => {
  it("applyHighspeedCardHeaders swaps the coding-plan dual auth and appends the card set", () => {
    const pairs: UpstreamHeaderPair[] = [
      ["content-type", "application/json"],
      ["x-api-key", "testkey.testsecret"],
      ["authorization", "Bearer testkey.testsecret"],
    ];
    const out = applyHighspeedCardHeaders(pairs, {
      cardId: "hsc_1", taskId: "t", model: "glm-5.3", issuedAt: 0, expiresAt: 1,
    }, AUTH);
    expect(out.find(([k]) => k.toLowerCase() === "x-api-key")?.[1]).toBe("test-jwt");
    expect(out.find(([k]) => k.toLowerCase() === "authorization")?.[1]).toBe("Bearer test-jwt");
    expect(out.find(([k]) => k === "X-Bigmodel-Authorization")?.[1]).toBe("Bearer testkey.testsecret");
    expect(out.find(([k]) => k === "Bigmodel-Target-Type")?.[1]).toBe("PERSONAL");
    // PERSONAL 不带 TEAM 的两个头
    expect(out.find(([k]) => k === "Bigmodel-Organization")).toBeUndefined();
    expect(out.find(([k]) => k === "Bigmodel-Project")).toBeUndefined();
    expect(out.find(([k]) => k === "X-Highspeed-Card-ID")?.[1]).toBe("hsc_1");
    // 追加三个头（X-Bigmodel-Authorization / Target-Type / 卡 ID）：Authorization 是
    // **替换**而不是追加，否则线上会出现 `Bearer x, Bearer x`。
    expect(out.length).toBe(pairs.length + 3);
    expect(out.filter(([k]) => k.toLowerCase() === "authorization").length).toBe(1);
  });

  it("highspeedAuthHeaders normalises the Bearer prefixes and emits TEAM org/project", () => {
    expect(highspeedAuthHeaders({ ...AUTH, jwt: "Bearer already" })).toMatchObject({
      "Authorization": "Bearer already",
      "Bigmodel-Target-Type": "PERSONAL",
    });
    const team = highspeedAuthHeaders(TEAM_AUTH);
    expect(team["Authorization"]).toBe("Bearer team-jwt");
    expect(team["X-Bigmodel-Authorization"]).toBe("Bearer teamkey.teamsecret");
    expect(team["Bigmodel-Organization"]).toBe("org-1");
    expect(team["Bigmodel-Project"]).toBe("proj-1");
  });

  it("isHighspeedFailure treats any non-2xx as a fallback trigger (official spec)", async () => {
    expect(await isHighspeedFailure(new Response("nope", { status: 401 }))).toBeTrue();
    expect(await isHighspeedFailure(new Response(JSON.stringify({ code: 3402, msg: "highspeed_card_expired" }), { status: 400 }))).toBeTrue();
    expect(await isHighspeedFailure(new Response("", { status: 429 }))).toBeTrue();
    expect(await isHighspeedFailure(new Response("boom", { status: 503 }))).toBeTrue();
    expect(await isHighspeedFailure(new Response("data: hi\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }))).toBeFalse();
  });

  it("highspeedAuthFrom reads the identity off the account", () => {
    const personal = accountFor(zhipuCredential({ jwt: "jwt-1" }));
    expect(highspeedAuthFrom(personal)).toEqual({
      jwt: "jwt-1",
      codingPlanAuth: "testkey.testsecret",
      family: "zai",
      identity: { targetType: "PERSONAL", organizationId: undefined, projectId: undefined },
    });

    const team = accountFor(zhipuCredential({
      provider: "bigmodel",
      apiKey: "teamkey",
      secret: undefined,
      jwt: "team-jwt",
      identity: { targetType: "TEAM", organizationId: "org-9", projectId: "proj-9", productId: "prod-9", deviceMid: "test-device-mid" },
    }));
    expect(highspeedAuthFrom(team)).toEqual({
      jwt: "team-jwt",
      codingPlanAuth: "teamkey",
      family: "bigmodel",
      identity: { targetType: "TEAM", organizationId: "org-9", projectId: "proj-9" },
    });

    // 缺 JWT
    expect(highspeedAuthFrom(accountFor(zhipuCredential({ jwt: undefined })))).toBeNull();
    // zai 缺 secret（apiKey 对不完整）
    expect(highspeedAuthFrom(accountFor(zhipuCredential({ secret: undefined })))).toBeNull();
  });
});
