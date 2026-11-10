/**
 * 请求链路侧的租约胶水：并发与租约、兜底、能力矩阵。
 *
 * 两件事，两类用例：
 *
 * 1. `withLeaseRelease` 的**四个出口**全覆盖；漏一个就是槽位泄漏（账号被永久判
 *    饱和）。流式三个出口（close / error / cancel）+ 客户端 abort + 非流式读完。
 * 2. `acquireLease` 的**错误映射**：容量问题必须 429（带 `Retry-After`），模型不支持
 *    400，本地状态 503。混档会让客户端做错事。
 *
 * @see 并发与租约 · 兜底 · 能力矩阵
 */
import { describe, expect, it } from "bun:test";
import { acquireLease, httpForBrokerError, withLeaseRelease } from "./lease.js";
import { AccountUnavailableError, type Broker } from "../accounts/broker.js";
import { brokerFor, inMemoryAccounts, zhipuCredential } from "../accounts/testing.js";
import { errorResponse } from "./http-io.js";

/** 计数的 release。*/
function counter(): { release: () => void; count: () => number } {
  let calls = 0;
  return { release: () => (calls += 1), count: () => calls };
}

/** 造一个 SSE 响应（`withLeaseRelease` 走流式分支）。*/
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("withLeaseRelease — 流式三个出口", () => {
  it("正常读完（close）→ 释放一次", async () => {
    const { release, count } = counter();
    const wrapped = await withLeaseRelease(sseResponse(["a", "b"]), release);
    expect(await wrapped.text()).toBe("ab");
    expect(count()).toBe(1);
  });

  it("上游流抛错（error）→ 释放一次", async () => {
    const { release, count } = counter();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("upstream reset"));
      },
    });
    const wrapped = await withLeaseRelease(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      release,
    );

    await expect(wrapped.text()).rejects.toThrow();
    expect(count()).toBe(1);
  });

  it("客户端取消（cancel）→ 释放一次", async () => {
    const { release, count } = counter();
    // 永不结束的流：客户端取消是唯一的终点。
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
      },
    });
    const wrapped = await withLeaseRelease(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      release,
    );

    const reader = wrapped.body!.getReader();
    await reader.read(); // 消费一块，让流真正跑起来
    await reader.cancel("client went away");
    expect(count()).toBe(1);
  });
});

describe("withLeaseRelease — 非流式与 abort", () => {
  it("非流式：body 读完后释放（不必等客户端消费）", async () => {
    const { release, count } = counter();
    const resp = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const wrapped = await withLeaseRelease(resp, release);

    // 关键：调用返回时就已经释放了：上游在代理拿到完整 body 时就结束了。
    expect(count()).toBe(1);
    expect(await wrapped.json()).toEqual({ ok: true });
    expect(count()).toBe(1);
  });

  it("非流式：保留状态码与头部（压缩字节原样透传）", async () => {
    const { release } = counter();
    const resp = new Response("body", {
      status: 201,
      headers: { "content-type": "application/json", "x-request-id": "req_1" },
    });
    const wrapped = await withLeaseRelease(resp, release);
    expect(wrapped.status).toBe(201);
    expect(wrapped.headers.get("x-request-id")).toBe("req_1");
    expect(wrapped.headers.get("content-type")).toBe("application/json");
  });

  it("没有 body：立即释放", async () => {
    const { release, count } = counter();
    const wrapped = await withLeaseRelease(new Response(null, { status: 204 }), release);
    expect(wrapped.status).toBe(204);
    expect(count()).toBe(1);
  });

  it("客户端 abort：立即释放，不等流自然结束", async () => {
    const { release, count } = counter();
    const controller = new AbortController();
    // 永不结束的流：只有 abort 能让它释放。
    const body = new ReadableStream<Uint8Array>({ start() {} });
    await withLeaseRelease(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      release,
      controller.signal,
    );

    expect(count()).toBe(0);
    controller.abort();
    expect(count()).toBe(1);
  });

  it("已经 abort 的请求：直接释放，不挂流", async () => {
    const { release, count } = counter();
    const controller = new AbortController();
    controller.abort();
    await withLeaseRelease(sseResponse(["x"]), release, controller.signal);
    expect(count()).toBe(1);
  });

  it("重复出口只释放一次（幂等）", async () => {
    const { release, count } = counter();
    const controller = new AbortController();
    const wrapped = await withLeaseRelease(sseResponse(["a"]), release, controller.signal);
    await wrapped.text();
    controller.abort(); // 流结束后再 abort 不得重复释放
    expect(count()).toBe(1);
  });
});

describe("acquireLease — 错误映射", () => {
  it("容量类拒绝 → 429 accounts_saturated + Retry-After", () => {
    expect(httpForBrokerError("accounts-saturated")).toEqual({ status: 429, type: "accounts_saturated" });
    expect(httpForBrokerError("all-accounts-cooling")).toEqual({ status: 429, type: "accounts_saturated" });
    expect(httpForBrokerError("account-unhealthy")).toEqual({ status: 429, type: "accounts_saturated" });
  });

  it("模型不支持 → 400（换模型，不是等）", () => {
    expect(httpForBrokerError("model-unsupported")).toEqual({ status: 400, type: "model_unsupported" });
  });

  it("本地状态问题 → 503 credential_unavailable", () => {
    for (const code of ["no-account", "account-unknown", "account-disabled", "route-not-allowed"] as const) {
      expect(httpForBrokerError(code)).toEqual({ status: 503, type: "credential_unavailable" });
    }
  });

  it("成功路径返回租约", async () => {
    const { broker } = brokerFor(zhipuCredential());
    const acquired = await acquireLease(broker, {});
    expect(acquired.ok).toBe(true);
    if (acquired.ok) acquired.lease.release();
  });

  it("队列超时 → 429，且把 Retry-After 秒数带出来", async () => {
    const solo = zhipuCredential({ apiKey: "solo-key" });
    const { broker } = inMemoryAccounts(
      [
        {
          id: "solo",
          label: "solo",
          credential: solo,
          routes: ["coding-plan"],
          enabled: true,
          policy: { weight: 1, maxConcurrency: 1 },
        },
      ],
      { routing: { order: ["coding-plan"], onSaturated: "wait", queueTimeoutMs: 20 } },
    );

    const held = await broker.acquire({});
    const acquired = await acquireLease(broker, {});
    expect(acquired.ok).toBe(false);
    if (!acquired.ok) {
      expect(acquired.status).toBe(429);
      expect(acquired.type).toBe("accounts_saturated");
      expect(acquired.retryAfterSeconds).toBe(1);
    }
    held.release();
  });

  it("非 AccountUnavailableError 原样抛出（不伪装成 503）", async () => {
    const broken = {
      acquire: async () => {
        throw new Error("store IO exploded");
      },
    } as unknown as Broker;

    await expect(acquireLease(broken, {})).rejects.toThrow("store IO exploded");
  });

  it("AccountUnavailableError 在产生点落 errorCode", async () => {
    const failing = {
      acquire: async () => {
        throw new AccountUnavailableError("model-unsupported", "nope");
      },
    } as unknown as Broker;

    const acquired = await acquireLease(failing, {});
    expect(acquired).toEqual({ ok: false, status: 400, type: "model_unsupported", message: "nope", errorCode: "model-unsupported" });
    if (!acquired.ok) {
      const body = (await errorResponse(acquired.status, acquired.type, acquired.message, undefined, acquired.errorCode).json()) as { error: { code: string } };
      expect(body.error.code).toBe("model-unsupported");
    }
  });
});
