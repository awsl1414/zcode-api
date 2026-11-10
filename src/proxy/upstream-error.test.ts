/**
 * 统一观测点的回归。
 *
 * 一个用例一件事，全部对着最终形态钉住：
 *
 * - **信封业务码**：502 + `{"code":1005}` 信封 → drained（5xx 信封形态，全状态码解析）；
 * - **SSE 帧业务码**：200 + SSE `[1302][…]` error 帧 → rate-limited 冷却（来源②，流层回传）；
 * - **connect 失败**：×3 → gateway-broken，**不冷却账号**；
 * - **弱信号阈值**：404×3 不熔、404×5 熔；405 强信号 ×3 即熔；
 * - **流中断**：→ transport；客户端主动断开不发信号；
 * - **空流**：→ empty-stream 10min（非流式非 Message 信封 + 流式 0 events +
 *   zstd/br 压缩流形态——实测空流是压缩的 passthrough）；
 * - **熔断闭环**：快速失败（429 + Retry-After 60 + 文案）→ 探针放行（`lease.probe`）
 *   → 2xx 恢复 / 失败翻倍且不冷却账号；
 * - **单次归因**：403+3007 只产生一次 auth 迁移（双报路径已删）；403+1313
 *   fair-usage 压过 auth（查表优先）。
 *
 * 解析/分类的单元真源在 `accounts/signals.test.ts` 与 `accounts/health.test.ts`；
 * 这里测的是**接线**：handler/流旁路/观测点/引擎一路通到底。
 *
 * @see 业务码终态分类 · 统一观测点
 */
import { describe, expect, it } from "bun:test";
import { gzipSync } from "node:zlib";
import { proxyRequest } from "./handler.js";
import { observeUpstream } from "./upstream-error.js";
import { observeStream } from "./handler-log.js";
import { RequestStore, type RequestRecord } from "./request-record.js";
import { accountFor, inMemoryAccounts, zhipuCredential } from "../accounts/testing.js";
import type { Account } from "../accounts/types.js";
import type { HealthTransition } from "../accounts/health.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { errorCodeOf, signalKindOfErrorCode } from "./error-codes.js";
import type { ErrorCode } from "./error-codes.js";
import type { UpstreamSignalKind } from "../accounts/signals.js";

const IDENTITY: ProxyIdentity = {
  appVersion: "test-1.0.0",
  appVersionSource: "default",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
  betaPolicy: "drop",
  betaAllowlist: [],
};

const CONFIG: ProxyConfig = {
  server: { port: 8080, host: "0.0.0.0" },
  auth: { requireKey: false },
  providers: {
    zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
    bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
  },
  defaultModel: "glm-4.6",
  models: ["glm-4.6"],
  identity: IDENTITY,
  clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
  responses: { storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false },
  highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
  mcp: { enabled: true, gateway: { enabled: true, upstreamOrigin: "https://zcode.z.ai" } },
  async: {
    enabled: false,
    origin: "https://zcode.z.ai",
    pollIntervalMs: 5000,
    keepAliveIntervalMs: 3000,
    maxWaitMs: 0,
    maxRetries: 3,
    settleTimeoutMs: 8000,
    controlTimeoutMs: 15000,
    defaultModel: "",
  },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, sprintWindowMs: 1800000, sprintPollIntervalMs: 60000 },
  logging: { level: "info" },
};

function account(label = "solo"): Account {
  return accountFor(zhipuCredential({ apiKey: `key-${label}`, secret: `secret-${label}`, jwt: `jwt-${label}` }), {
    label,
    routes: ["coding-plan"],
  });
}

function clientReq(body: Record<string, unknown> = { model: "glm-4.6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const NO_LAYERS = { endpointRouting: null, clientSigning: null, highspeed: null } as const;

/** 轮询等待流旁路/观测的异步收尾（observeStream 是 fire-and-forget 的旁路循环）。*/
async function waitFor(cond: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 固定时钟（探针窗口的断言靠它跨过时间，不真的 sleep）。*/
function fixedClock(start = 1_720_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

describe("5xx 信封业务码", () => {
  it("502 + {\"code\":1005} → quota-terminal → drained，响应原样透传", async () => {
    const solo = account();
    const { broker } = inMemoryAccounts([solo], { routing: { order: ["coding-plan"] } });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ code: 1_005, msg: "exceed quota limit" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const resp = await proxyRequest(clientReq(), "anthropic", { config: CONFIG, broker, fetchImpl, ...NO_LAYERS });

    expect(resp.status).toBe(502);
    expect(await resp.text()).toContain("exceed quota limit");
    expect(broker.health.status(solo.id, "coding-plan").status).toBe("drained");
  });
});

describe("200 + SSE error 帧业务码（来源②）", () => {
  it("SSE [1302] 帧 → rate-limited 冷却（BigModel 前缀提取，真源 signals.ts）", async () => {
    const solo = account();
    const { broker } = inMemoryAccounts([solo], { routing: { order: ["coding-plan"] } });
    const sse = `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"[1302][11][rid-x]"}}\n\n`;
    const fetchImpl = (async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;

    const resp = await proxyRequest(clientReq({ model: "glm-4.6", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }),
      "anthropic", { config: CONFIG, broker, fetchImpl, ...NO_LAYERS });
    await resp.text();

    await waitFor(() => broker.health.status(solo.id, "coding-plan").status === "cooling", "rate-limited cooling");
    const state = broker.health.status(solo.id, "coding-plan");
    expect(state.reason).toBe("rate-limited");
  });
});

describe("connect 失败 → gateway-broken，不冷却账号", () => {
  it("connect ×3 → 路由熔断（gateway-broken），账号健康不变", async () => {
    const solo = account();
    const { broker } = inMemoryAccounts([solo], { routing: { order: ["coding-plan"] } });
    const fetchImpl = (async () => {
      throw new Error("Unable to connect. Is the computer able to access the internet?");
    }) as unknown as typeof fetch;

    for (let i = 0; i < 3; i += 1) {
      const resp = await proxyRequest(clientReq(), "anthropic", { config: CONFIG, broker, fetchImpl, ...NO_LAYERS });
      await resp.text();
      expect(resp.status).toBe(502);
    }

    expect(broker.health.isRouteBroken("coding-plan")).toBe(true);
    // 路由级故障不惩罚账号。
    expect(broker.health.status(solo.id, "coding-plan").status).toBe("ok");
  }, 20_000);
});

describe("404 弱信号阈值", () => {
  it("404×3 不熔、404×5 熔；405 强信号 ×3 即熔", async () => {
    const accounts = [account("a1"), account("a2"), account("a3"), account("a4"), account("a5")];
    const { broker } = inMemoryAccounts(accounts, { routing: { order: ["coding-plan"] } });
    const resp404 = () => new Response("not found", { status: 404 });

    for (const a of accounts.slice(0, 3)) {
      await observeUpstream(broker, { account: a, route: "coding-plan" }, resp404());
    }
    expect(broker.health.isRouteBroken("coding-plan")).toBe(false);

    for (const a of accounts.slice(3)) {
      await observeUpstream(broker, { account: a, route: "coding-plan" }, resp404());
    }
    // 5 个不同账号的弱信号 → 熔断。
    expect(broker.health.isRouteBroken("coding-plan")).toBe(true);

    // 405 强信号：换个路由重新计数，3 个不同账号即熔。
    for (const a of accounts.slice(0, 3)) {
      await observeUpstream(broker, { account: a, route: "start-plan" }, new Response("", { status: 405 }));
    }
    expect(broker.health.isRouteBroken("start-plan")).toBe(true);
  });
});

describe("流中断 → transport；客户端主动断开不发", () => {
  const encoder = new TextEncoder();
  const recordOf = (): RequestRecord =>
    new RequestStore().begin({ reqId: "#test-001", format: "anthropic", apiKeyId: "" });

  it("流读失败（非客户端断开）→ stream-interrupted", async () => {
    const record = recordOf();
    const events: unknown[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {}\n\n"));
        controller.error(new Error("socket reset mid-stream"));
      },
    });
    observeStream(record, body, undefined, undefined, undefined, undefined, (e) => events.push(e));
    await waitFor(() => events.length > 0, "stream-interrupted event");
    expect(events[0]).toMatchObject({ type: "stream-interrupted" });
  });

  it("客户端主动断开（signal.aborted）→ 不发信号", async () => {
    const record = recordOf();
    const events: unknown[] = [];
    const controller = new AbortController();
    controller.abort();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("client cancelled"));
      },
    });
    observeStream(record, body, undefined, undefined, undefined, controller.signal, (e) => events.push(e));
    // 给旁路循环一个收尾的机会，然后确认什么都没发。
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([]);
    expect(record.clientAborted).toBe(true);
  });
});

describe("空流 → empty-stream 10min", () => {
  it("非流式：200 + 非 Message 信封（无业务码）→ empty-stream 冷却 + zeroOutput 标记", async () => {
    const solo = account();
    const { broker } = inMemoryAccounts([solo], { routing: { order: ["coding-plan"] } });
    const requests = new RequestStore();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ foo: "bar" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const resp = await proxyRequest(clientReq(), "openai", { config: CONFIG, broker, fetchImpl, requests, ...NO_LAYERS });

    expect(resp.status).toBe(502);
    expect(await resp.text()).toContain("translation_failed");
    const state = broker.health.status(solo.id, "coding-plan");
    expect(state.status).toBe("cooling");
    expect(state.reason).toBe("empty-stream");
    expect(state.until! - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(state.until! - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 1_000);
    const record = requests.recent(1)[0]!;
    expect(record.zeroOutput).toBe(true);
  });

  it("流式：200 + 0 events（连 message_start 都没有）→ empty-stream + zeroOutput", async () => {
    const solo = account();
    const { broker } = inMemoryAccounts([solo], { routing: { order: ["coding-plan"] } });
    const requests = new RequestStore();
    const sse = ": keepalive\n\ndata: [DONE]\n\n";
    const fetchImpl = (async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;

    const resp = await proxyRequest(clientReq({ model: "glm-4.6", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }),
      "anthropic", { config: CONFIG, broker, fetchImpl, requests, ...NO_LAYERS });
    await resp.text();

    await waitFor(() => broker.health.status(solo.id, "coding-plan").reason === "empty-stream", "empty-stream cooling");
    const record = requests.recent(1)[0]!;
    expect(record.zeroOutput).toBe(true);
  });

  it("压缩流（实测形态 zstd/br 的 gzip 同族）：解压解析后同样判空", async () => {
    const record = new RequestStore().begin({ reqId: "#test-002", format: "anthropic", apiKeyId: "" });
    record.contentEncoding = "gzip";
    const events: unknown[] = [];
    // gzip 压缩的空流：只有 [DONE]，零输出事件——不看解压字节就永远看不见 0 events。
    const compressed = gzipSync(Buffer.from("data: [DONE]\n\n"));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(compressed));
        controller.close();
      },
    });
    observeStream(record, body, undefined, undefined, undefined, undefined, (e) => events.push(e));
    await waitFor(() => events.length > 0, "empty-stream event on compressed stream");
    expect(events[0]).toMatchObject({ type: "empty-stream" });
    expect(record.zeroOutput).toBe(true);
  });
});

describe("熔断闭环：快速失败 + 被动探针", () => {
  it("熔断期 429+Retry-After 60 快速失败；探针 2xx 恢复路由，失败翻倍且不冷却账号", async () => {
    const clock = fixedClock();
    const accounts = [account("a1"), account("a2"), account("a3")];
    const { broker } = inMemoryAccounts(accounts, { routing: { order: ["coding-plan"] }, now: clock.now });
    const events: HealthTransition[] = [];
    broker.health.onTransition((e) => events.push(e));

    // 405 ×3 不同账号 → endpoint-broken。
    for (const a of accounts) {
      await observeUpstream(broker, { account: a, route: "coding-plan" }, new Response("", { status: 405 }), clock.now());
    }
    expect(broker.health.isRouteBroken("coding-plan")).toBe(true);

    // 快速失败：429 + Retry-After 60 + 文案（不打上游、不占槽）。
    const fetchImpl = (async () => {
      throw new Error("must not reach upstream while breaker open");
    }) as unknown as typeof fetch;
    const resp = await proxyRequest(clientReq(), "anthropic", { config: CONFIG, broker, fetchImpl, ...NO_LAYERS });
    expect(resp.status).toBe(429);
    expect(resp.headers.get("retry-after")).toBe("60");
    expect(await resp.text()).toContain("熔断中");

    // 探针到期：放行一个真实请求（lease.probe 标记）。
    clock.advance(200_000);
    const probeLease = await broker.acquire({});
    expect(probeLease.probe).toBe(true);
    // 探针结果只回 noteProbeResult：2xx = 路由恢复。
    await observeUpstream(broker, probeLease, new Response("{}", { status: 200 }), clock.now());
    probeLease.release();
    expect(broker.health.isRouteBroken("coding-plan")).toBe(false);
    const next = await broker.acquire({});
    expect(next.probe).toBeUndefined();
    next.release();

    // 失败路径：重新熔断 → 探针放行 → 405 → 退避翻倍，账号依旧无辜。
    for (const a of accounts) {
      await observeUpstream(broker, { account: a, route: "coding-plan" }, new Response("", { status: 405 }), clock.now());
    }
    expect(broker.health.isRouteBroken("coding-plan")).toBe(true);
    clock.advance(200_000);
    const failedProbe = await broker.acquire({});
    expect(failedProbe.probe).toBe(true);
    await observeUpstream(broker, failedProbe, new Response("", { status: 405 }), clock.now());
    failedProbe.release();
    expect(broker.health.isRouteBroken("coding-plan")).toBe(true);
    expect(events.some((e) => e.type === "probe-result" && e.ok === false)).toBe(true);
    for (const a of accounts) {
      expect(broker.health.status(a.id, "coding-plan").status).toBe("ok");
    }
  });
});

describe("单次归因：查表优先，不重复迁移", () => {
  it("403+3007 只产生一次 auth 迁移（双报路径已删，observeUpstream 是唯一入口）", async () => {
    const solo = account();
    const { broker } = inMemoryAccounts([solo], { routing: { order: ["coding-plan"] } });
    const events: HealthTransition[] = [];
    broker.health.onTransition((e) => events.push(e));

    const resp = new Response(JSON.stringify({ code: 3_007, msg: "security check" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
    const observed = await observeUpstream(broker, { account: solo, route: "coding-plan" }, resp);

    expect(observed.signal.kind).toBe("auth");
    const authEnters = events.filter((e) => e.type === "cooling-enter" && e.reason === "auth-failed");
    expect(authEnters.length).toBe(1);
    expect(broker.health.status(solo.id, "coding-plan").status).toBe("cooling");
  });

  it("403+1313：查表优先（fair-usage 压过 auth）→ reason=fair-usage 30min，不换号不计 auth", async () => {
    const solo = account();
    const { broker } = inMemoryAccounts([solo], { routing: { order: ["coding-plan"] } });
    const events: HealthTransition[] = [];
    broker.health.onTransition((e) => events.push(e));

    const resp = new Response(JSON.stringify({ code: 1_313, msg: "fair usage restriction" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
    const observed = await observeUpstream(broker, { account: solo, route: "coding-plan" }, resp);

    // 判定读信号：kind 是 fair-usage（不是 auth）→ handler 不会走换号分支。
    expect(observed.signal.kind).toBe("fair-usage");
    const state = broker.health.status(solo.id, "coding-plan");
    expect(state.status).toBe("cooling");
    expect(state.reason).toBe("fair-usage");
    expect(state.until! - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(state.until! - Date.now()).toBeLessThanOrEqual(30 * 60_000 + 1_000);
    expect(events.some((e) => e.reason === "auth-failed")).toBe(false);
  });
});

describe("端到端：响应层观测在真实链路里生效", () => {
  it("上游 429 带 Retry-After=2：冷却 2 秒 + 后置抖动，客户端仍拿到原样 429", async () => {
    const solo = account();
    const { broker } = inMemoryAccounts([solo], { routing: { order: ["coding-plan"] } });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "2" },
      })) as unknown as typeof fetch;

    const resp = await proxyRequest(clientReq(), "anthropic", { config: CONFIG, broker, fetchImpl, ...NO_LAYERS });

    expect(resp.status).toBe(429);
    expect(await resp.text()).toContain("rate_limit_error");
    const state = broker.health.status(solo.id, "coding-plan");
    expect(state.status).toBe("cooling");
    expect(state.reason).toBe("rate-limited");
    expect(state.until! - Date.now()).toBeLessThanOrEqual(2_400);
    expect(state.until! - Date.now()).toBeGreaterThan(0);
    expect(broker.leases.totalInflight()).toBe(0);
  });

  it("auth 信号换号一次后成功：第二个账号出线，第一个进 auth 冷却（且只冷一次）", async () => {
    const a1 = account("a1");
    const a2 = account("a2");
    const { broker } = inMemoryAccounts([a1, a2], { routing: { order: ["coding-plan"] } });
    const events: HealthTransition[] = [];
    broker.health.onTransition((e) => events.push(e));
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ code: 3_007, msg: "security check" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const resp = await proxyRequest(clientReq(), "anthropic", { config: CONFIG, broker, fetchImpl, ...NO_LAYERS });
    await resp.text();

    expect(calls).toBe(2);
    expect(resp.status).toBe(200);
    // 换号恰好一次：一个账号 auth 冷却、另一个 ok（谁先谁后由策略决定，不钉死）。
    const cooled = [a1, a2].filter((a) => broker.health.status(a.id, "coding-plan").reason === "auth-failed");
    const ok = [a1, a2].filter((a) => broker.health.status(a.id, "coding-plan").status === "ok");
    expect(cooled.length).toBe(1);
    expect(ok.length).toBe(1);
    // 双报已删：auth 迁移恰好一次（不是冷却 + 换号各记一次）。
    expect(events.filter((e) => e.reason === "auth-failed").length).toBe(1);
  });

  it("额度终态码：判 drained 且不换号（三种切走分离），下一请求本地 429", async () => {
    const solo = account();
    const { broker } = inMemoryAccounts([solo], {
      routing: { order: ["coding-plan"], queueTimeoutMs: 20 },
    });
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: 1_113, msg: "余额不足" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const first = await proxyRequest(clientReq(), "anthropic", { config: CONFIG, broker, fetchImpl, ...NO_LAYERS });
    await first.text();
    // quota-terminal 是 drained 域，不进 auth 换号分支：上游只被打一次。
    expect(calls).toBe(1);
    expect(broker.health.status(solo.id, "coding-plan").status).toBe("drained");

    const second = await proxyRequest(clientReq(), "anthropic", { config: CONFIG, broker, fetchImpl, ...NO_LAYERS });
    expect(second.status).toBe(429);
    const body = (await second.json()) as { error: { type: string } };
    expect(body.error.type).toBe("accounts_saturated");
    expect(calls).toBe(1);
  });
});

/**
 * 健康出口：每个上游族 errorCode 在 `observeUpstream` 产生点同源落下。
 *
 * 信号 → HealthEngine 的动作由 `accounts/health.test.ts` 钉住；这里只钉「同一个身份给三个出口」：
 * `observation.errorCode` 必须等于 `errorCodeOf(signal.kind)`，且反查回原 kind。
 */
describe("observeUpstream 产生点落 errorCode", () => {
  const cases: Array<{ name: string; input: Parameters<typeof observeUpstream>[2]; kind: UpstreamSignalKind; code: ErrorCode }> = [
    { name: "429 无码 → rate-limited", input: new Response("", { status: 429 }), kind: "rate-limited", code: "upstream-rate-limited" },
    { name: "403+1313 → fair-usage", input: new Response('{"code":1313}', { status: 403 }), kind: "fair-usage", code: "upstream-fair-usage" },
    { name: "401 → auth", input: new Response("", { status: 401 }), kind: "auth", code: "upstream-auth-rejected" },
    { name: "502+1005 → quota-terminal", input: new Response('{"code":1005}', { status: 502 }), kind: "quota-terminal", code: "upstream-quota-terminal" },
    { name: "405 → endpoint-shape", input: new Response("", { status: 405 }), kind: "endpoint-shape", code: "upstream-endpoint-shape" },
    { name: "500 → gateway", input: new Response("", { status: 500 }), kind: "gateway", code: "upstream-gateway" },
    { name: "400 无码 → model-level", input: new Response("", { status: 400 }), kind: "model-level", code: "upstream-model-level" },
    { name: "connect-failed → gateway", input: { type: "connect-failed", detail: "no route" }, kind: "gateway", code: "upstream-gateway" },
    { name: "stream-interrupted → transport", input: { type: "stream-interrupted", detail: "cut" }, kind: "transport", code: "upstream-transport" },
    { name: "empty-stream → empty-stream", input: { type: "empty-stream", detail: "0 events" }, kind: "empty-stream", code: "upstream-empty-stream" },
    { name: "SSE [1302] → rate-limited", input: { type: "stream-error", message: "[1302][rate]" }, kind: "rate-limited", code: "upstream-rate-limited" },
  ];

  for (const one of cases) {
    it(one.name, async () => {
      const { broker } = inMemoryAccounts([account("a")], { routing: { order: ["coding-plan"] } });
      const a = (await broker.acquire({})).account;
      const observation = await observeUpstream(broker, { account: a, route: "coding-plan" }, one.input);
      expect(observation.signal.kind).toBe(one.kind);
      expect(observation.errorCode).toBe(one.code);
      expect(errorCodeOf(observation.signal.kind)).toBe(one.code);
      expect(signalKindOfErrorCode(one.code)).toBe(one.kind);
    });
  }

  it("2xx 成功不落 errorCode（成功不是错误）", async () => {
    const { broker } = inMemoryAccounts([account("a")], { routing: { order: ["coding-plan"] } });
    const a = (await broker.acquire({})).account;
    const observation = await observeUpstream(broker, { account: a, route: "coding-plan" }, new Response("{}", { status: 200 }));
    expect(observation.signal.kind).toBe("success");
    expect(observation.errorCode).toBeUndefined();
  });
});
