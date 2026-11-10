/**
 * 请求链路上的租约胶水：`acquire` 的失败映射 + `release` 的挂载时机。
 *
 * 两件事都必须**只写一处**，否则 5 个出线点（handler / responses / async / mcp /
 * claim）会各自实现一遍，而"释放得太早"和"忘了释放"都是沉默的错误：
 *
 * 1. `acquireLease`：把 `broker.acquire()` 的异常折叠成"HTTP 语义 + 人话原因"。
 *    broker 的拒绝分三类：本地状态（凭据坏了、账号不认识，一律 503
 *    `credential_unavailable`）、容量类（队列满 / 排队超时 / 全部冷却，见
 *    {@link httpForBrokerError}）、模型不支持。**不要把容量问题塞进 503**，否则
 *    客户端会把"排队排满了"当成"凭据坏了"去重新登录。
 * 2. `withLeaseRelease`：槽位必须在**真正占用上游的整个期间**持有（含流式输出），
 *    所以释放要挂在响应体上（ReadableStream 的 close / error / cancel），非流式
 *    在 body 读完时；客户端 abort 通过 `clientReq.signal` **立即**释放，不等流
 *    自然结束。挂早了在飞数被低估，正好踩并发风控线；挂晚了槽位泄漏
 *    （账号被永久判饱和）。
 */
import type { AcquireRequest, BrokerErrorCode, Lease } from "../accounts/broker.js";
import { AccountUnavailableError, type Broker } from "../accounts/broker.js";
import { errorCodeOf } from "./error-codes.js";
import type { ErrorCode } from "./error-codes.js";

/**
 * 取租约的结果。
 *
 * `status` / `type` 由 broker 原因码决定（429 / 400 / 503），`retryAfterSeconds`
 * 只有容量类拒绝才有（见 {@link httpForBrokerError} 的 `Retry-After`）。
 * `errorCode` 是**产生点**落下的统一身份：broker 的结构化
 * `AccountUnavailableError.code` 经 `errorCodeOf` 一处映射，三个出口（健康 / 统计 /
 * 展示）只读它，不再猜消息。
 */
export type LeaseAcquisition =
  | { ok: true; lease: Lease }
  | {
      ok: false;
      status: number;
      type: string;
      message: string;
      errorCode: ErrorCode;
      retryAfterSeconds?: number;
    };

/**
 * 取租约，把拒绝原因翻成 HTTP 语义。
 *
 * 非 `AccountUnavailableError`（存储 IO 失败、JSON 解析炸了……）原样抛出：
 * 那不是"没有账号"，把它当成 503 credential_unavailable 会让用户去重登一个
 * 根本没问题的账号。
 */
export async function acquireLease(broker: Broker, request: AcquireRequest): Promise<LeaseAcquisition> {
  try {
    return { ok: true, lease: await broker.acquire(request) };
  } catch (err) {
    if (err instanceof AccountUnavailableError) {
      const { status, type } = httpForBrokerError(err.code);
      // 产生点落码。message 保留原文作 detail，errorCode 是稳定身份。
      const rejected: LeaseAcquisition = { ok: false, status, type, message: err.message, errorCode: errorCodeOf(err.code) ?? "other" };
      if (err.retryAfterSeconds !== undefined) rejected.retryAfterSeconds = err.retryAfterSeconds;
      return rejected;
    }
    throw err;
  }
}

/**
 * broker 原因码 → HTTP 状态。
 *
 * 用 `Record` 而不是 `switch`：新增原因码时这里会直接编译报错（漏映射会变成 500），
 * 而 `switch` 的 `default` 分支会把漏映射静默吐成 503。
 *
 * 三组语义（与 `broker.ts::BrokerErrorCode` 的注释一一对应）：
 * - 本地状态问题 → 503 `credential_unavailable`（客户端改不了，需要人介入）
 * - 暂时性容量问题 → 429 `accounts_saturated` + `Retry-After`（稍后重试即可）
 * - 请求本身不成立 → 400 `model_unsupported`（换模型，不是等）
 */
const BROKER_ERROR_HTTP: Record<BrokerErrorCode, { status: number; type: string }> = {
  "accounts-saturated": { status: 429, type: "accounts_saturated" },
  "queue-timeout": { status: 429, type: "accounts_saturated" },
  "all-accounts-cooling": { status: 429, type: "accounts_saturated" },
  "account-unhealthy": { status: 429, type: "accounts_saturated" },
  // 路由级熔断的快速失败：429 + Retry-After 60，文案见 `broker.routeBrokenError`。
  "route-broken": { status: 429, type: "route_broken" },
  // 额度耗尽（onDrained: stop）沿用 429（等窗口重置）；auth-invalid 是本地
  // 状态问题，客户端改不了 → 503（去重新登录 / 导入凭据）。
  "quota-exhausted": { status: 429, type: "quota_exhausted" },
  "auth-invalid": { status: 503, type: "credential_unavailable" },
  "model-unsupported": { status: 400, type: "model_unsupported" },
  "no-account": { status: 503, type: "credential_unavailable" },
  "account-unknown": { status: 503, type: "credential_unavailable" },
  "account-disabled": { status: 503, type: "credential_unavailable" },
  "route-not-allowed": { status: 503, type: "credential_unavailable" },
};

/** 取某个原因码的 HTTP 语义。*/
export function httpForBrokerError(code: BrokerErrorCode): { status: number; type: string } {
  return BROKER_ERROR_HTTP[code];
}

/**
 * 把 `release` 挂在响应体上：读完 / 出错 / 被取消 / 客户端 abort 都会释放一次。
 *
 * 出口全覆盖，漏一个就是槽位泄漏（账号被永久判饱和）：
 *
 * | 出口 | 触发 |
 * |---|---|
 * | 正常读完 | `pull` 读到 `done` |
 * | 上游/转换异常 | `pull` 抛错 → `controller.error` |
 * | 客户端取消 | `cancel(reason)` |
 * | 客户端 abort | `signal` 的 `abort` 事件（流式不能等它自然结束） |
 *
 * **流式与非流式分开处理**，因为"上游占用期间"的终点不同：
 *
 * - 流式（`text/event-stream`）：上游连接在客户端消费期间一直开着，所以释放必须跟着
 *   客户端的消费节奏走：过早释放会让同一账号在飞数被低估，过晚则槽位泄漏。
 * - 非流式：上游在代理拿到**完整 body** 时就结束了。所以这里把 body 读成内存再释放，
 *   而不是等客户端来读，客户端读不读已经不影响上游占用了。代价是单份 JSON 响应会
 *   在内存里过一手（非流式响应本来就是一次性 JSON，不是长流）。
 *
 * `signal` 必须传 `clientReq.signal`：客户端断开后上游流可能还要等几十秒才报错，
 * 那时才释放等于把槽位借给了空气。
 */
export async function withLeaseRelease(
  resp: Response,
  release: () => void,
  signal?: AbortSignal,
): Promise<Response> {
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    signal?.removeEventListener("abort", releaseOnce);
    release();
  };

  if (signal) {
    // 已经 abort 的请求不会再被消费：立刻释放，不要等流。
    if (signal.aborted) {
      releaseOnce();
      return resp;
    }
    signal.addEventListener("abort", releaseOnce, { once: true });
  }

  if (!resp.body) {
    releaseOnce();
    return resp;
  }

  if (!isEventStream(resp)) {
    // 非流式：读完整份 body 即释放。
    const bytes = await resp.arrayBuffer();
    releaseOnce();
    return new Response(bytes.byteLength === 0 ? null : bytes, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  }

  const reader = resp.body.getReader();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          releaseOnce();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        releaseOnce();
        controller.error(err);
      }
    },
    cancel(reason) {
      releaseOnce();
      return reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}

/** 是不是流式响应（`text/event-stream`，即"占用上游期间包括流式输出"的那种）。*/
function isEventStream(resp: Response): boolean {
  return resp.headers.get("content-type")?.includes("text/event-stream") === true;
}
