/**
 * 端到端并发与切换的用例（验收口径：「并发压测不超限，abort 不泄漏槽位」）。
 *
 * 这里不再直接调 broker，而是走 `proxyRequest` 的真实链路，断言**每个账号的在飞数
 * 与请求分布**，以及三条切换在 HTTP 层的表现：
 *
 * 1. 两个账号、N 个并发：每账号并发不超过自己的上限，且两个账号都被用到
 * 2. 超出容量：429 `accounts_saturated` + `Retry-After`
 * 3. auth-failed：401 冷却该 (account, route) 并换同路由另一个账号，**不降级**
 * 4. 一次请求最多换一次号；已经回写字节的流式请求不再换号
 *
 * @see 三种切走 · 换号一次 · 并发与租约
 */
import { describe, expect, it } from "bun:test";
import { proxyRequest } from "./handler.js";
import { accountFor, inMemoryAccounts, zhipuCredential } from "../accounts/testing.js";
import { defaultPolicy } from "../accounts/types.js";
import type { Account, Credential, RouteKind } from "../accounts/types.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";

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
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, sprintWindowMs: 1800000, sprintPollIntervalMs: 60000 },
  logging: { level: "info" },
};

const ANTHROPIC_OK = JSON.stringify({
  id: "msg_ok",
  type: "message",
  role: "assistant",
  model: "glm-4.6",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

function credential(tag: string): Credential {
  // 账号 id = 凭据指纹：不同 apiKey 才是不同账号。
  return zhipuCredential({ apiKey: `key-${tag}`, secret: `secret-${tag}`, jwt: `jwt-${tag}` });
}

function account(label: string, maxConcurrency: number, routes: RouteKind[] = ["coding-plan"]): Account {
  return accountFor(credential(label), {
    label,
    routes,
    policy: defaultPolicy({ maxConcurrency }),
  });
}

function clientReq(): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-4.6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });
}

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 上游调用记录：按 apiKey 归到账号（凭据不同 = 账号不同）。*/
interface Call {
  apiKey: string;
  at: number;
}

describe("端到端并发：每账号并发不超限", () => {
  it("两个账号各 2 并发，6 个并发请求：峰值不超限且两个账号都被用到", async () => {
    const a = account("a", 2);
    const b = account("b", 2);
    const { broker } = inMemoryAccounts([a, b], {
      routing: { order: ["coding-plan"], maxTotalInflight: 8, queueTimeoutMs: 5_000 },
    });

    const calls: Call[] = [];
    const inflight = new Map<string, number>();
    const peak = new Map<string, number>();

    const fetchImpl = (async (req: Request) => {
      const apiKey = req.headers.get("x-api-key") ?? "unknown";
      calls.push({ apiKey, at: Date.now() });
      const current = (inflight.get(apiKey) ?? 0) + 1;
      inflight.set(apiKey, current);
      peak.set(apiKey, Math.max(peak.get(apiKey) ?? 0, current));
      await tick(40); // 模拟上游耗时，让并发窗口重叠
      inflight.set(apiKey, (inflight.get(apiKey) ?? 1) - 1);
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        proxyRequest(clientReq(), "anthropic", {
          config: CONFIG,
          broker,
          fetchImpl,
          endpointRouting: null,
          clientSigning: null,
          highspeed: null,
        }),
      ),
    );

    // 全部成功（容量 4，队列 64，超出的两个排队后拿到槽）。
    for (const resp of responses) {
      expect(resp.status).toBe(200);
      await resp.text();
    }

    // 每账号峰值 ≤ 自己的上限。
    for (const [apiKey, value] of peak) {
      expect(value, `peak concurrency for ${apiKey}`).toBeLessThanOrEqual(2);
    }
    // 两个账号都被用到，说明选号真的在分配，而不是全压在一个账号上。
    expect(peak.size).toBe(2);
    // 全部 6 次上游调用，且收尾后槽位全部归还（不泄漏）。
    expect(calls.length).toBe(6);
    expect(broker.leases.totalInflight()).toBe(0);
    expect(broker.leases.queueDepth()).toBe(0);
  });

  it("全局上限：账号各自调大也突不破 maxTotalInflight", async () => {
    const a = account("a", 8);
    const b = account("b", 8);
    const { broker } = inMemoryAccounts([a, b], {
      routing: { order: ["coding-plan"], maxTotalInflight: 1, onSaturated: "wait", queueTimeoutMs: 20 },
    });

    const held = await broker.acquire({});
    expect(broker.leases.totalInflight()).toBe(1);

    // 全局只剩 0：另一个账号即使上限 8 也占不到。
    const resp = await proxyRequest(clientReq(), "anthropic", {
      config: CONFIG,
      broker,
      fetchImpl: (async () => new Response(ANTHROPIC_OK)) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    });
    expect(resp.status).toBe(429);
    expect(resp.headers.get("retry-after")).toBe("1");
    const body = (await resp.json()) as { error: { type: string } };
    expect(body.error.type).toBe("accounts_saturated");
    held.release();
  });

  it("客户端 abort：立即释放槽位，不泄漏", async () => {
    const solo = account("solo", 1);
    const { broker } = inMemoryAccounts([solo], {
      routing: { order: ["coding-plan"], queueTimeoutMs: 20 },
    });

    const controller = new AbortController();
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      signal: controller.signal,
    });

    let releaseUpstream: (() => void) | undefined;
    const fetchImpl = (async () => {
      // 挂住不返回，模拟上游仍在生成
      await new Promise<void>((resolve) => {
        releaseUpstream = resolve;
      });
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const pending = proxyRequest(req, "anthropic", {
      config: CONFIG,
      broker,
      fetchImpl,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    });

    await tick(20);
    expect(broker.leases.totalInflight()).toBe(1);

    controller.abort();
    await tick(20);
    // abort 之后槽位必须已经归还（不等上游自然结束）。
    expect(broker.leases.totalInflight()).toBe(0);

    releaseUpstream?.();
    await pending.catch(() => undefined);
  });
});

describe("auth-failed：冷却换号、一次为限、不降级", () => {
  it("第一个账号 401 → 冷却并换同路由第二个账号重发，客户端拿到 200", async () => {
    const a = account("a", 2);
    const b = account("b", 2);
    const { broker } = inMemoryAccounts([a, b], {
      routing: { order: ["coding-plan"], onSaturated: "wait" },
    });

    const seenKeys: string[] = [];
    const fetchImpl = (async (req: Request) => {
      const apiKey = req.headers.get("x-api-key") ?? "";
      seenKeys.push(apiKey);
      // 第一个出线的账号返回 401（凭据被上游拒绝）。
      if (apiKey.startsWith("key-a.")) {
        return new Response(JSON.stringify({ error: { type: "authentication_error" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const resp = await proxyRequest(clientReq(), "anthropic", {
      config: CONFIG,
      broker,
      fetchImpl,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    });

    expect(resp.status).toBe(200);
    await resp.text();
    // 换号：两次上游调用，第二次是另一个账号。
    expect(seenKeys.length).toBe(2);
    expect(seenKeys[0]!.startsWith("key-a.")).toBe(true);
    expect(seenKeys[1]!.startsWith("key-b.")).toBe(true);
    // 冷却生效：a 的 coding-plan 已不可用，槽位全部归还。
    expect(broker.health.isAvailable(a.id, "coding-plan")).toBe(false);
    expect(broker.leases.totalInflight()).toBe(0);
  });

  it("两个账号都 401：最多换一次号，客户端拿到上游 401（不轮询试号）", async () => {
    const a = account("a", 2);
    const b = account("b", 2);
    const { broker } = inMemoryAccounts([a, b], {
      routing: { order: ["coding-plan"], onSaturated: "wait" },
    });

    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { type: "authentication_error" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const resp = await proxyRequest(clientReq(), "anthropic", {
      config: CONFIG,
      broker,
      fetchImpl,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    });

    expect(resp.status).toBe(401);
    await resp.text();
    // 两个账号各试一次 = 换号一次，绝不再多。
    expect(calls).toBe(2);
    expect(broker.leases.totalInflight()).toBe(0);
  });

  it("流式已发出首字节后不再换号", async () => {
    const a = account("a", 2);
    const { broker } = inMemoryAccounts([a], {
      routing: { order: ["coding-plan"], onSaturated: "wait" },
    });

    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      // 200 + 一段 SSE，然后流中断；首字节已经发给客户端，不允许再换号重试。
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start"}\n\n'));
          controller.error(new Error("upstream died mid-stream"));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.6", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }),
    });

    const resp = await proxyRequest(req, "anthropic", {
      config: CONFIG,
      broker,
      fetchImpl,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    });

    expect(resp.status).toBe(200);
    await resp.text().catch(() => undefined);
    // 只有一次上游调用：首字节之后不换号。
    expect(calls).toBe(1);
    expect(broker.leases.totalInflight()).toBe(0);
  });
});

describe("429 语义：容量问题与凭据问题不混档", () => {
  it("没有账号 → 503 credential_unavailable（不是 429）", async () => {
    const { broker } = inMemoryAccounts([]);
    const resp = await proxyRequest(clientReq(), "anthropic", {
      config: CONFIG,
      broker,
      fetchImpl: (async () => new Response(ANTHROPIC_OK)) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    });
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error: { type: string } };
    expect(body.error.type).toBe("credential_unavailable");
  });

  it("模型不支持 → 400 model_unsupported", async () => {
    // start-plan 账号 + glm-5.3（这条路由明确不支持）。
    const trial = accountFor(credential("trial"), {
      label: "trial",
      routes: ["start-plan"],
      policy: defaultPolicy(),
    });
    const { broker } = inMemoryAccounts([trial], { routing: { order: ["start-plan"] } });

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    const resp = await proxyRequest(req, "anthropic", {
      config: CONFIG,
      broker,
      fetchImpl: (async () => new Response(ANTHROPIC_OK)) as unknown as typeof fetch,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { type: string } };
    expect(body.error.type).toBe("model_unsupported");
  });
});
