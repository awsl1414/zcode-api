import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import net from "node:net";
import { Readable } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createControlDispatcher,
  handleControlRequestForTest,
  handleControlRequestWithHooksForTest,
  type ControlResponse,
  type ControlState,
  type HandlerContext,
} from "./control.js";
import { LogBuffer } from "../log/buffer.js";
import { RequestStore } from "../proxy/request-record.js";
import type { RequestRecord } from "../proxy/request-record.js";
import { BigmodelOAuthClient } from "../auth/oauth.js";
import { AccountManager } from "../accounts/manager.js";
import { accountFor, inMemoryAccounts, zhipuCredential } from "../accounts/testing.js";
import type { BrokerOptions } from "../accounts/broker-options.js";
import type { QuotaSample } from "../accounts/quota.js";
import type { ProxySpec } from "../accounts/proxies.js";
import type { Account } from "../accounts/types.js";
import { pushCrossAccountAlert } from "./control-report.js";
import type { RiskAlert } from "./control-views.js";
import { ApiKeyManager } from "../apikeys/manager.js";
import { memoryApiKeysStore } from "../apikeys/testing.js";
import { codecFromSeed } from "../storage/index.js";

/**
 * 存储目录隔离（与 `accounts/store.test.ts` 同一理由）：`setRoutingPolicy` 会把
 * 策略覆盖落进 `~/.zcode-proxy/policy.json`，不隔离就会把测试值写进用户真实目录，
 * 下次启动代理时带着一份测试残留。`storeDir()` 逐次解析环境变量，所以 beforeEach
 * 设置即可生效。
 */
const prevStoreDir = process.env.ZCODE_PROXY_STORE_DIR;
let testStoreDir = "";

beforeEach(() => {
  testStoreDir = mkdtempSync(join(tmpdir(), "zcode-control-store-"));
  process.env.ZCODE_PROXY_STORE_DIR = testStoreDir;
});

afterEach(() => {
  if (prevStoreDir === undefined) delete process.env.ZCODE_PROXY_STORE_DIR;
  else process.env.ZCODE_PROXY_STORE_DIR = prevStoreDir;
  rmSync(testStoreDir, { recursive: true, force: true });
});

/**
 * 控制面用例的账号仓：内存空仓。`HandlerContext.accounts` 是必填（登录/登出/
 * status 的唯一真源），给空仓是为了让"忘记接线"在编译期就报错。
 */
function emptyAccounts(): AccountManager {
  return new AccountManager({
    load: async () => ({ version: 2, accounts: [] }),
    save: async () => {},
  });
}

function makeStubRequest(opts: {
  method?: string;
  url?: string;
  body?: string;
  remoteAddress?: string;
}): import("node:http").IncomingMessage {
  const body = opts.body ?? "";
  const stream = Readable.from([Buffer.from(body, "utf-8")]) as unknown as import("node:http").IncomingMessage;
  stream.method = opts.method ?? "POST";
  stream.url = opts.url ?? "/control";
  stream.headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) };
  stream.socket = { remoteAddress: opts.remoteAddress ?? "127.0.0.1" } as never;
  return stream;
}

async function post(body: unknown, state: ControlState, ctx?: HandlerContext) {
  const req = makeStubRequest({ body: JSON.stringify(body) });
  return ctx
    ? handleControlRequestWithHooksForTest(req, state, ctx)
    : handleControlRequestForTest(req, state);
}

describe("control surface — protocol basics", () => {
  const baseState: ControlState = {
    proxyPort: 8080,
  };

  it("returns running status for {cmd:status} from loopback", async () => {
    const req = makeStubRequest({
      body: JSON.stringify({ cmd: "status" }),
      remoteAddress: "127.0.0.1",
    });
    const result = await handleControlRequestForTest(req, baseState);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok && "state" in result.body) {
      expect(result.body.state).toBe("running");
      // 空仓：0 个账号，`loggedIn` 为 false。运行状态不再报「哪个是默认账号」。
      expect(result.body.accounts).toBe(0);
      expect(result.body.loggedIn).toBe(false);
      expect(result.body.proxyPort).toBe(8080);
    }
  });

  it("rejects non-loopback remoteAddress with HTTP 403", async () => {
    const req = makeStubRequest({
      body: JSON.stringify({ cmd: "status" }),
      remoteAddress: "192.168.1.5",
    });
    const result = await handleControlRequestForTest(req, baseState);
    expect(result.status).toBe(403);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error).toContain("forbidden");
    }
  });

  it("rejects IPv6 non-loopback (::ffff:8.8.8.8)", async () => {
    const req = makeStubRequest({
      body: JSON.stringify({ cmd: "status" }),
      remoteAddress: "::ffff:8.8.8.8",
    });
    const result = await handleControlRequestForTest(req, baseState);
    expect(result.status).toBe(403);
  });

  it("accepts IPv6 loopback (::1)", async () => {
    const req = makeStubRequest({
      body: JSON.stringify({ cmd: "status" }),
      remoteAddress: "::1",
    });
    const result = await handleControlRequestForTest(req, baseState);
    expect(result.status).toBe(200);
  });

  it("returns 404 for non-/control paths", async () => {
    const req = makeStubRequest({
      url: "/v1/chat/completions",
      body: JSON.stringify({ cmd: "status" }),
    });
    const result = await handleControlRequestForTest(req, baseState);
    expect(result.status).toBe(404);
  });

  it("returns 400 for malformed JSON body", async () => {
    const req = makeStubRequest({ body: "not-json{" });
    const result = await handleControlRequestForTest(req, baseState);
    expect(result.status).toBe(400);
    expect(result.body.ok).toBe(false);
  });

  it("returns error for unknown cmd", async () => {
    const req = makeStubRequest({ body: JSON.stringify({ cmd: "bogus" }) });
    const result = await handleControlRequestForTest(req, baseState);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error).toContain("unknown_cmd");
    }
  });

  it("returns error for deliverOAuthCode without an active flow", async () => {
    const req = makeStubRequest({
      body: JSON.stringify({ cmd: "deliverOAuthCode", provider: "bigmodel", code: "x", state: "y" }),
    });
    const result = await handleControlRequestForTest(req, baseState);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error).toContain("no_matching_oauth_flow");
    }
  });

  it("没有接 onShutdown 的入口发 shutdown 回 shutdown_unavailable", async () => {
    const result = await post({ cmd: "shutdown" }, baseState);
    expect(result.body).toEqual({ ok: false, error: "shutdown_unavailable" });
  });

  it("接了 onShutdown 的入口仍然按命令表语义调用它", async () => {
    let calls = 0;
    const result = await post(
      { cmd: "shutdown" },
      baseState,
      { logBuffer: new LogBuffer(), accounts: emptyAccounts(), onShutdown: () => { calls += 1; } },
    );
    expect(result.body).toEqual({ ok: true, event: "shuttingDown" });
    expect(calls).toBe(1);
  });
});

describe("control surface — getLogs", () => {
  it("returns all lines when since=0", async () => {
    const logBuffer = new LogBuffer();
    logBuffer.push("[INFO] line one");
    logBuffer.push("[INFO] line two");
    const ctx: HandlerContext = { logBuffer, accounts: emptyAccounts() };
    const result = await post({ cmd: "getLogs" }, { proxyPort: 0 }, ctx);
    expect(result.body.ok).toBe(true);
    if (result.body.ok && "lines" in result.body) {
      expect(result.body.lines).toEqual(["[INFO] line one", "[INFO] line two"]);
      expect(result.body.nextSince).toBe(2);
    }
  });

  it("returns only lines after `since`", async () => {
    const logBuffer = new LogBuffer();
    logBuffer.push("a");
    logBuffer.push("b");
    logBuffer.push("c");
    const ctx: HandlerContext = { logBuffer, accounts: emptyAccounts() };
    const result = await post({ cmd: "getLogs", since: 1 }, { proxyPort: 0 }, ctx);
    expect(result.body.ok).toBe(true);
    if (result.body.ok && "lines" in result.body) {
      expect(result.body.lines).toEqual(["b", "c"]);
    }
  });

  it("returns empty when since is at cursor", async () => {
    const logBuffer = new LogBuffer();
    logBuffer.push("only");
    const ctx: HandlerContext = { logBuffer, accounts: emptyAccounts() };
    const result = await post({ cmd: "getLogs", since: 1 }, { proxyPort: 0 }, ctx);
    expect(result.body.ok).toBe(true);
    if (result.body.ok && "lines" in result.body) {
      expect(result.body.lines).toEqual([]);
    }
  });
});

describe("control surface — getRequests", () => {
  /** 一个装了这些请求的 store；`getRequests` 不解释字段，只搬内存里的那份。*/
  function storeWith(ids: readonly string[]): RequestStore {
    const store = new RequestStore();
    for (const id of ids) {
      const one = store.begin({ reqId: id, format: "anthropic", apiKeyId: "" });
      one.status = 200;
      store.notify(one);
    }
    return store;
  }

  it("返回最近 N 条，新的在前（与面板的 request 事件同源）", async () => {
    const requests = storeWith(["#001", "#002", "#003"]);
    const result = await post({ cmd: "getRequests", limit: 2 }, { proxyPort: 0 }, { logBuffer: new LogBuffer(), accounts: emptyAccounts(), requests });

    expect(result.body.ok).toBe(true);
    if (result.body.ok && "records" in result.body) {
      expect(result.body.records.map((one: RequestRecord) => one.reqId)).toEqual(["#003", "#002"]);
    }
  });

  it("缺省是 50 条（面板的请求表一屏放不下更多）", async () => {
    const ids = Array.from({ length: 60 }, (_, index) => `#${String(index + 1).padStart(3, "0")}`);
    const requests = storeWith(ids);
    const result = await post({ cmd: "getRequests" }, { proxyPort: 0 }, { logBuffer: new LogBuffer(), accounts: emptyAccounts(), requests });

    expect(result.body.ok).toBe(true);
    if (result.body.ok && "records" in result.body) {
      expect(result.body.records).toHaveLength(50);
      expect(result.body.records[0]!.reqId).toBe("#060");
    }
  });

  it("没有接 store 的入口（CLI 自己建的那份 dispatcher）回明确错误", async () => {
    const result = await post({ cmd: "getRequests" }, { proxyPort: 0 }, { logBuffer: new LogBuffer(), accounts: emptyAccounts() });
    expect(result.body).toEqual({ ok: false, error: "request_store_unavailable" });
  });
});

describe("control surface — getUsageStats", () => {
  it("没接读函数（CLI 的一次性 dispatcher）回 usage_stats_unavailable", async () => {
    const result = await post({ cmd: "getUsageStats" }, { proxyPort: 0 }, { logBuffer: new LogBuffer(), accounts: emptyAccounts() });
    expect(result.body).toEqual({ ok: false, error: "usage_stats_unavailable" });
  });

  it("接了读函数：from/to 透传，聚合形状原样出门", async () => {
    const seen: Array<{ from?: number; to?: number }> = [];
    const ctx: HandlerContext = {
      logBuffer: new LogBuffer(),
      accounts: emptyAccounts(),
      usageStats: (query) => {
        seen.push(query);
        return {
          totals: { requests: 2, ok: 1, failed: 1, inputTokens: 30, outputTokens: 13, avgTtfbMs: 200, avgTps: 20, errorCount: 1, aborted: 0 },
          hourly: [],
          daily: [],
          heatmap: { daily: [], weekly: [], cumulative: [] },
          byAccount: [{ key: "work", requests: 2, failed: 1, inputTokens: 30, outputTokens: 13 }],
          byRoute: [],
          byModel: [],
          byApiKey: [],
          byProtocol: [],
          byClientKind: [],
          byReasoningEffort: [{ key: "high", requests: 1, failed: 0, inputTokens: 10, outputTokens: 3 }],
          errors: [{ stage: "upstream-resp", kind: "upstream-gateway", count: 1 }],
          schedule: { degraded: 1, cooled: 0, queueTimeout: 0 },
          cacheHit: { samples: 1, inputTokens: 180, readTokens: 1216, creationTokens: 4, creationSamples: 1 },
          retries: { samples: 2, retried: 1, attempts: 3, rate: 0.5, rotations: 1 },
          queue: { samples: 2, totalMs: 40, avgMs: 20, maxMs: 30 },
          bytes: { requestSamples: 2, requestBytes: 300, avgRequestBytes: 150, responseSamples: 1, responseBytes: 900, avgResponseBytes: 900, ratioSamples: 1, ratio: 6 },
          range: { from: 1_700_000_000_000, to: 1_700_000_360_000, records: 2 },
        };
      },
    };
    const result = await post({ cmd: "getUsageStats", from: 1_700_000_000_000, to: 1_700_000_360_000 }, { proxyPort: 0 }, ctx);
    expect(result.body.ok).toBe(true);
    if (result.body.ok && "stats" in result.body) {
      expect(result.body.event).toBe("usageStats");
      expect(result.body.stats.totals).toMatchObject({ requests: 2, failed: 1 });
      expect(result.body.stats.cacheHit).toEqual({ samples: 1, inputTokens: 180, readTokens: 1216, creationTokens: 4, creationSamples: 1 });
      expect(result.body.stats.schedule).toEqual({ degraded: 1, cooled: 0, queueTimeout: 0 });
      // 三个维度与推理强度分组原样出门（两处入口同源，都透传聚合器）。
      expect(result.body.stats.retries).toEqual({ samples: 2, retried: 1, attempts: 3, rate: 0.5, rotations: 1 });
      expect(result.body.stats.queue).toEqual({ samples: 2, totalMs: 40, avgMs: 20, maxMs: 30 });
      expect(result.body.stats.bytes.responseBytes).toBe(900);
      expect(result.body.stats.byReasoningEffort.map((g) => g.key)).toEqual(["high"]);
    }
    expect(seen).toEqual([{ from: 1_700_000_000_000, to: 1_700_000_360_000 }]);
  });

  it("from/to 缺省时按 undefined 透传（合法性判定在聚合器里）", async () => {
    const seen: Array<{ from?: number; to?: number }> = [];
    const ctx: HandlerContext = {
      logBuffer: new LogBuffer(),
      accounts: emptyAccounts(),
      usageStats: (query) => {
        seen.push(query);
        return {
          totals: { requests: 0, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, errorCount: 0, aborted: 0 },
          hourly: [], daily: [], heatmap: { daily: [], weekly: [], cumulative: [] }, byAccount: [], byRoute: [], byModel: [], byApiKey: [], byProtocol: [], byClientKind: [], byReasoningEffort: [],
          errors: [], schedule: { degraded: 0, cooled: 0, queueTimeout: 0 }, cacheHit: { samples: 0, inputTokens: 0, readTokens: 0, creationTokens: 0, creationSamples: 0 },
          retries: { samples: 0, retried: 0, attempts: 0, rotations: 0 }, queue: { samples: 0, totalMs: 0 },
          bytes: { requestSamples: 0, requestBytes: 0, responseSamples: 0, responseBytes: 0, ratioSamples: 0 },
          range: { records: 0 },
        };
      },
    };
    await post({ cmd: "getUsageStats" }, { proxyPort: 0 }, ctx);
    await post({ cmd: "getUsageStats", from: "bad" as unknown as number }, { proxyPort: 0 }, ctx);
    await post({ cmd: "getUsageStats", from: 1 }, { proxyPort: 0 }, ctx);
    expect(seen).toEqual([
      { from: undefined, to: undefined },
      { from: undefined, to: undefined },
      { from: 1, to: undefined },
    ]);
  });
});

describe("control surface — getRequestsHistory", () => {
  /** 一条最小可用的记录（应答形状测试不关心字段，脱敏测试会覆盖）。*/
  function historyRecord(id: string): RequestRecord {
    return {
      reqId: id,
      startedAt: 1_700_000_000_000,
      format: "anthropic",
      model: "glm-5.3-flash",
      stream: true,
      requestBytes: 12480,
      retries: 0,
      stages: [],
      apiKeyId: "",
    };
  }

  /** 接了桩读函数的上下文；`seen` 记录 dispatcher 传给读函数的查询。*/
  function ctxWithReader(page: { requests: RequestRecord[]; hasMore: boolean }, seen: Array<{ before?: number; limit: number }>): HandlerContext {
    return {
      logBuffer: new LogBuffer(),
      accounts: emptyAccounts(),
      requestHistory: (query) => {
        seen.push(query);
        return page;
      },
    };
  }

  it("回一页历史，hasMore 原样透传（新的在前，面板直接往表尾追加）", async () => {
    const seen: Array<{ before?: number; limit: number }> = [];
    const ctx = ctxWithReader({ requests: [historyRecord("#002"), historyRecord("#001")], hasMore: true }, seen);
    const result = await post({ cmd: "getRequestsHistory", before: 1_700_000_000_000, limit: 2 }, { proxyPort: 0 }, ctx);

    expect(result.body.ok).toBe(true);
    if (result.body.ok && "requests" in result.body) {
      expect(result.body.event).toBe("requestsHistory");
      expect(result.body.requests.map((one) => one.reqId)).toEqual(["#002", "#001"]);
      expect(result.body.hasMore).toBe(true);
    }
    // 游标与条数原样透传给读函数（协议与数据源分层）。
    expect(seen).toEqual([{ before: 1_700_000_000_000, limit: 2 }]);
  });

  it("缺省 limit=100，上限收在 500；非法游标（0/负数/非数字）按缺省处理", async () => {
    const seen: Array<{ before?: number; limit: number }> = [];
    const ctx = ctxWithReader({ requests: [], hasMore: false }, seen);

    await post({ cmd: "getRequestsHistory" }, { proxyPort: 0 }, ctx);
    await post({ cmd: "getRequestsHistory", limit: 1000 }, { proxyPort: 0 }, ctx);
    await post({ cmd: "getRequestsHistory", before: 0 }, { proxyPort: 0 }, ctx);
    await post({ cmd: "getRequestsHistory", before: -5 }, { proxyPort: 0 }, ctx);
    await post({ cmd: "getRequestsHistory", before: "yesterday" as unknown as number }, { proxyPort: 0 }, ctx);

    expect(seen).toEqual([
      { before: undefined, limit: 100 },
      { before: undefined, limit: 500 },
      { before: undefined, limit: 100 },
      { before: undefined, limit: 100 },
      { before: undefined, limit: 100 },
    ]);
  });

  it("应答前过防御性打码：Bearer / sk- 出不了门（RequestRecord 本不该有，万一有）", async () => {
    const dirty = historyRecord("#001");
    dirty.error = "rejected Bearer abc.def.ghi";
    dirty.stages = [{ stage: "upstream-req", atMs: 1, fields: { url: "https://x/?key=sk-1234567890abcdefghij" } }];
    const ctx = ctxWithReader({ requests: [dirty], hasMore: false }, []);

    const result = await post({ cmd: "getRequestsHistory" }, { proxyPort: 0 }, ctx);
    expect(result.body.ok).toBe(true);
    if (result.body.ok && "requests" in result.body) {
      const text = JSON.stringify(result.body.requests);
      expect(text).not.toContain("abc.def.ghi");
      expect(text).not.toContain("sk-1234567890abcdefghij");
      expect(text).toContain("<redacted>");
    }
  });

  it("没接读函数的入口（CLI 的一次性 dispatcher）回明确错误", async () => {
    const result = await post({ cmd: "getRequestsHistory" }, { proxyPort: 0 }, { logBuffer: new LogBuffer(), accounts: emptyAccounts() });
    expect(result.body).toEqual({ ok: false, error: "request_history_unavailable" });
  });
});

describe("control surface — quota", () => {
  const state: ControlState = { proxyPort: 0 };
  const snapshot = {
    provider: "bigmodel",
    jwt: null,
    balances: [],
    plans: [],
    claimablePlans: [],
    codingPlan: { level: "max", limits: [{ type: "TIME_LIMIT", remaining: 3894 }] },
    planes: { credits: false, coding: true },
    errors: [],
  };

  it("returns the snapshot from the onQuota hook", async () => {
    const ctx: HandlerContext = {
      accounts: emptyAccounts(),
      logBuffer: new LogBuffer(),
      onQuota: async () => snapshot,
    };
    const result = await post({ cmd: "quota" }, state, ctx);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok && "quota" in result.body) {
      expect(result.body.quota).toEqual(snapshot);
      expect(result.body.quota.codingPlan?.level).toBe("max");
    }
  });

  it("returns quota_unavailable when the hook is missing", async () => {
    const result = await post({ cmd: "quota" }, state);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error).toBe("quota_unavailable");
    }
  });

  it("surfaces hook failures verbatim (not-logged-in message)", async () => {
    const ctx: HandlerContext = {
      accounts: emptyAccounts(),
      logBuffer: new LogBuffer(),
      onQuota: async () => {
        throw new Error("not logged in (run: zcode-proxy auth login)");
      },
    };
    const result = await post({ cmd: "quota" }, state, ctx);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error).toContain("not logged in");
    }
  });
});

describe("control surface — startOAuth callback-port lifecycle", () => {
  /** True when nothing is listening on `port` anymore. */
  async function portIsFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
  }

  it("releases the callback port when the flow is rejected (abandoned login)", async () => {
    // 端口不预探测。回调服务器 bind 0 让内核分配，真实端口从 startOAuth
    // 响应的 callbackPort 读回。探测要先把端口 close 掉才能交给被测流程，
    // 那段空窗里端口可能被抢走，用例就会偶发 EADDRINUSE。
    const state: ControlState = { proxyPort: 0 };
    // Inject the classic (localhost-callback) client: the port-lifecycle
    // guarantee is a callback-flow property; the default bigmodel login is
    // the network-bound poll flow, which binds nothing.
    const ctx: HandlerContext = {
      accounts: emptyAccounts(),
      logBuffer: new LogBuffer(),
      createLoginClient: () => new BigmodelOAuthClient(),
    };

    const started = await post({ cmd: "startOAuth", provider: "bigmodel" }, state, ctx);
    expect(started.body.ok).toBe(true);
    expect(state.activeOauth).toBeDefined();
    if (!started.body.ok || !("callbackPort" in started.body)) return;
    const port = started.body.callbackPort;

    // Simulate the user abandoning the flow: a callback with a bad state
    // rejects every waitForCallback waiter.
    const resp = await fetch(`http://127.0.0.1:${port}/oauth/callback/bigmodel?state=bad&code=x`);
    expect(resp.status).toBe(400);
    await Bun.sleep(50);

    expect(state.activeOauth).toBeUndefined();
    expect(await portIsFree(port)).toBe(true);
  });
});

describe("LogBuffer", () => {
  it("evicts oldest lines past capacity", () => {
    const buf = new LogBuffer(3);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    buf.push("d");
    expect([...buf.snapshot()]).toEqual(["b", "c", "d"]);
    expect(buf.cursor).toBe(4);
  });

  it("since() with stale cursor returns all surviving lines", () => {
    const buf = new LogBuffer(2);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    // "a" was evicted; since=0 still returns only surviving lines.
    const result = buf.since(0);
    expect(result.lines).toEqual(["b", "c"]);
    expect(result.nextSince).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 5.0 账号 / 策略命令面
// ---------------------------------------------------------------------------

/** 一份可离线校验的 plan JWT（`token_version` 载荷 + 可读 `iat`，与真 token 同形）。*/
function planJwt(iat = Math.floor(Date.now() / 1000)): string {
  const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ user_id: "u1", token_version: 1, sub: "s1", iat })}.sig`;
}

/**
 * 成功体的事件判别（用例断言用）。
 *
 * `ControlResponse` 的成功半边包含 `status`（控制面协议定死的 `{state:"running"}`，没有
 * `event`），所以直接读 `res.event` 在类型上不成立；这个谓词把"是哪个事件"收窄到
 * 具体变体，后面就能直接读 `res.accounts` / `res.label`。
 */
function isEvent<E extends ControlEventBody["event"]>(
  res: ControlResponse,
  event: E,
): res is Extract<ControlEventBody, { event: E }> {
  return res.ok && "event" in res && res.event === event;
}

/** 带 `event` 的成功体（`status` 那个变体不在其中）。*/
type ControlEventBody = Extract<Extract<ControlResponse, { ok: true }>, { event: string }>;

/** 内存账号仓 + broker + 进程内 dispatcher（与面板/CLI 同一条路径）。*/
function controlFor(accounts: Account[], options?: BrokerOptions) {
  const { manager, broker } = inMemoryAccounts(accounts, options);
  const state: ControlState = { proxyPort: 0 };
  const ctx: HandlerContext = {
    accounts: manager,
    broker,
    logBuffer: new LogBuffer(),
    ...(options?.entries ? { entries: options.entries } : {}),
  };
  return { manager, broker, dispatch: createControlDispatcher(state, ctx) };
}

/** 一个带独立 `deviceMid` 的账号（R1 的正常形态）。*/
function accountWith(label: string, apiKey: string, deviceMid = "test-device-mid"): Account {
  const credential = zhipuCredential({
    apiKey,
    identity: { targetType: "PERSONAL", deviceMid },
  });
  return accountFor(credential, { label });
}

describe("control — listAccounts", () => {
  it("summarizes every account with health, inflight and effective policy", async () => {
    const { dispatch } = controlFor([
      accountWith("a1", "key-one", "mid-1"),
      accountWith("a2", "key-two", "mid-2"),
    ]);
    const res = await dispatch({ cmd: "listAccounts" });
    expect(res.ok).toBe(true);
    if (!isEvent(res, "accounts")) throw new Error("unexpected shape");
    expect(res.accounts.map((a) => a.label)).toEqual(["a1", "a2"]);
    const [first] = res.accounts;
    expect(first?.kind).toBe("zhipu-account");
    expect(first?.provider).toBe("zai");
    expect(first?.routes).toEqual(["coding-plan"]);
    expect(first?.enabled).toBe(true);
    expect(first?.weight).toBe(1);
    expect(first?.maxConcurrency).toBe(2);
    expect(first?.health).toBe("ok");
    expect(first?.inflight).toBe(0);
    expect(first?.quota).toBeNull();
    // id 前缀是展示用的 12 位（永不回显凭据原文）。
    expect(first?.idPrefix).toHaveLength(12);
  });

  it("shows the config entries value, not the account default (precedence chain)", async () => {
    const { dispatch } = controlFor([accountWith("a1", "key-one")], {
      entries: [{ label: "a1", maxConcurrency: 5, weight: 3 }],
    });
    const res = await dispatch({ cmd: "listAccounts" });
    if (!isEvent(res, "accounts")) throw new Error("unexpected shape");
    expect(res.accounts[0]?.maxConcurrency).toBe(5);
    expect(res.accounts[0]?.weight).toBe(3);
  });

  it("reflects runtime overrides written by setAccountConcurrency", async () => {
    const { dispatch } = controlFor([accountWith("a1", "key-one")]);
    await dispatch({ cmd: "setAccountConcurrency", label: "a1", maxConcurrency: 7 });
    const res = await dispatch({ cmd: "listAccounts" });
    if (!isEvent(res, "accounts")) throw new Error("unexpected shape");
    expect(res.accounts[0]?.maxConcurrency).toBe(7);
  });

  it("returns an empty list for an empty store", async () => {
    const { dispatch } = controlFor([]);
    const res = await dispatch({ cmd: "listAccounts" });
    if (!isEvent(res, "accounts")) throw new Error("unexpected shape");
    expect(res.accounts).toEqual([]);
  });

  it("reports account_control_unavailable without a broker", async () => {
    const state: ControlState = { proxyPort: 0 };
    const dispatch = createControlDispatcher(state, { accounts: emptyAccounts(), logBuffer: new LogBuffer() });
    const res = await dispatch({ cmd: "listAccounts" });
    expect(res).toEqual({ ok: false, error: "account_control_unavailable" });
  });
});

describe("control — listAccounts 套餐三段", () => {
  /** 一个带 balances/plans/campaigns 的采样结果（accounts/quota.ts 归一后的形状）。*/
  function sampleWithPlans(accountId: string): import("../accounts/quota.js").QuotaSample {
    return {
      accountId,
      route: "start-plan",
      sampledAt: 1_720_000_000_000,
      stale: false,
      quota: {
        windows: [],
        credits: { remainingUnits: 341_000_000, totalUnits: 500_000_000, expiresAt: 1_720_086_000_000 },
        balances: [
          {
            name: "GLM-5.3-Flash",
            planId: "wk-1114",
            remainingUnits: 341_000_000,
            totalUnits: 500_000_000,
            unitType: "token",
            expiresAt: 1_720_086_000_000,
          },
        ],
        plans: [
          {
            planId: "wk-1114",
            userPlanId: "up-1114",
            name: "ZCODE WEEKEND BUILD",
            status: "active",
            startsAt: 1_719_993_600_000,
            endsAt: 1_720_086_000_000,
            entitlements: [{ entitlementId: "ent-1", showName: "GLM-5.3-Flash", period: "one_time", effectiveAt: 1_720_014_000_000 }],
          },
        ],
        campaigns: [
          {
            planId: "wk-1114",
            name: "ZCODE WEEKEND BUILD",
            status: "claimed",
            startsAt: 1_719_993_600_000,
            endsAt: 1_720_086_000_000,
            entitlements: [{ showName: "GLM-5.3-Flash", grantUnits: 500_000_000, unitType: "token" }],
            source: "preview",
          },
        ],
      },
    };
  }

  /**
   * 造一个接了采样快照的 dispatcher。样本里的 accountId 统一重映射成建号后的
   * 真实 id（quotaSummaryOf 按 accountId 过滤，fixture 里写死谁的 id 都对不上）。
   */
  async function dispatchWithSamples(samples: readonly import("../accounts/quota.js").QuotaSample[]) {
    const { manager, broker } = inMemoryAccounts([accountWith("a1", "key-one")]);
    const accountId = (await manager.list())[0]!.id;
    const state: ControlState = { proxyPort: 0 };
    const ctx: HandlerContext = {
      accounts: manager,
      broker,
      logBuffer: new LogBuffer(),
      quotaSamples: () => samples.map((sample) => ({ ...sample, accountId })),
    };
    return createControlDispatcher(state, ctx);
  }

  it("额度摘要带套餐三段：桶 / 套餐实例 / 可领活动逐字段透传", async () => {
    const dispatch = await dispatchWithSamples([sampleWithPlans("placeholder")]);
    const res = await dispatch({ cmd: "listAccounts" });
    if (!isEvent(res, "accounts")) throw new Error("unexpected shape");
    const quota = res.accounts[0]?.quota;
    expect(quota?.balances).toHaveLength(1);
    expect(quota?.balances[0]?.name).toBe("GLM-5.3-Flash");
    expect(quota?.balances[0]?.expiresAt).toBe(1_720_086_000_000);
    expect(quota?.balances[0]?.claimedAt).toBeUndefined();
    // 套餐实例（套餐卡数据源）：name / status 原值 / userPlanId / entitlements 都在。
    expect(quota?.plans).toHaveLength(1);
    expect(quota?.plans[0]?.name).toBe("ZCODE WEEKEND BUILD");
    expect(quota?.plans[0]?.userPlanId).toBe("up-1114");
    expect(quota?.plans[0]?.status).toBe("active");
    expect(quota?.plans[0]?.entitlements[0]?.period).toBe("one_time");
    // 可领活动（本期活动段）：本仓状态语义与来源都在。
    expect(quota?.campaigns).toHaveLength(1);
    expect(quota?.campaigns[0]?.status).toBe("claimed");
    expect(quota?.campaigns[0]?.source).toBe("preview");
    // 数据龄：采样时刻与采样周期随摘要下发（面板的「上次采样 X 分钟前」阈值）。
    expect(quota?.sampledAt).toBe(1_720_000_000_000);
    expect(quota?.pollSeconds).toBe(300);
  });

  it("订阅产品逐字段透传：subscription 与 plans/balances/windows 并列，sampledAt 复用", async () => {
    // 采样样本里 coding 平面带订阅产品、start-plan 平面不带（摘要层见 undefined
    // 不覆盖）。字段缺失不编造：团队形态没有 renewTime/inCurrentPeriod 就缺省。
    const accountId = "placeholder";
    const subscriptionSample: import("../accounts/quota.js").QuotaSample = {
      accountId,
      route: "coding-plan",
      sampledAt: 1_720_000_000_000,
      stale: false,
      quota: {
        windows: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 12 }],
        subscription: {
          productId: "team-product",
          productName: "Team Coding Plan",
          status: "EFFECTIVE",
          memberGrantStatus: "VALID",
          billingCycle: "yearly",
          expireTime: 1_756_000_000_000,
          kind: "team",
        },
      },
    };
    const dispatch = await dispatchWithSamples([
      subscriptionSample,
      { accountId, route: "start-plan", sampledAt: 1_719_999_999_000, stale: false, quota: { windows: [] } },
    ]);
    const res = await dispatch({ cmd: "listAccounts" });
    if (!isEvent(res, "accounts")) throw new Error("unexpected shape");
    const quota = res.accounts[0]?.quota;
    expect(quota?.subscription).toEqual({
      productId: "team-product",
      productName: "Team Coding Plan",
      status: "EFFECTIVE",
      memberGrantStatus: "VALID",
      billingCycle: "yearly",
      expireTime: 1_756_000_000_000,
      kind: "team",
    });
    expect(quota?.subscription?.renewTime).toBeUndefined();
    expect(quota?.subscription?.inCurrentPeriod).toBeUndefined();
    expect(quota?.sampledAt).toBe(1_720_000_000_000);
    expect(quota?.windows).toHaveLength(1); // 窗口数据不被产品段冲掉
    expect(quota?.plans).toEqual([]);
    expect(quota?.balances).toEqual([]);
    expect(JSON.stringify(quota)).toContain('"subscription":');
  });

  it("采样结果为空时 balances/plans/campaigns 是空数组：序列化不省略字段", async () => {
    const dispatch = await dispatchWithSamples([
      { accountId: "placeholder", route: "start-plan", sampledAt: 1, stale: false, quota: { windows: [] } },
    ]);
    const res = await dispatch({ cmd: "listAccounts" });
    if (!isEvent(res, "accounts")) throw new Error("unexpected shape");
    expect(res.accounts[0]?.quota?.balances).toEqual([]);
    expect(res.accounts[0]?.quota?.plans).toEqual([]);
    expect(res.accounts[0]?.quota?.campaigns).toEqual([]);
    // 协议回归：JSON 里真的有这三个键（空数组不许被序列化器丢掉）。
    const text = JSON.stringify(res.accounts[0]?.quota);
    expect(text).toContain('"balances":[]');
    expect(text).toContain('"plans":[]');
    expect(text).toContain('"campaigns":[]');
    // 没采到产品身份时 subscription 整个字段缺省（不编造空对象/描述词）。
    expect(text).not.toContain('"subscription":');
  });

  it("没有采样结果的账号额度仍是 null（不是零额度）", async () => {
    const dispatch = await dispatchWithSamples([]);
    const res = await dispatch({ cmd: "listAccounts" });
    if (!isEvent(res, "accounts")) throw new Error("unexpected shape");
    expect(res.accounts[0]?.quota).toBeNull();
  });

  it("窗口行带上 unit/number（窗口周期身份）", async () => {
    // 官方四格（5 小时 / 每周 / 工具调用 / ZCode MCP）靠 (type, unit, number) 区分；
    // 控制面只搬 type 时面板只能叫「Token 窗口」，两行同名。
    const dispatch = await dispatchWithSamples([
      {
        accountId: "placeholder",
        route: "coding-plan",
        sampledAt: 1_720_000_000_000,
        stale: false,
        quota: {
          windows: [
            { type: "TIME_LIMIT", unit: 5, number: 1, usage: 1000, remaining: 972, percentage: 2, nextResetTime: 1_795_491_762_977 },
            { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1 },
            { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 40, nextResetTime: 1_794_365_985_961 },
          ],
        },
      },
    ]);
    const res = await dispatch({ cmd: "listAccounts" });
    if (!isEvent(res, "accounts")) throw new Error("unexpected shape");
    const windows = res.accounts[0]?.quota?.windows ?? [];
    expect(windows.map((w) => [w.type, w.unit, w.number])).toEqual([
      ["TIME_LIMIT", 5, 1],
      ["TOKENS_LIMIT", 3, 5],
      ["TOKENS_LIMIT", 6, 1],
    ]);
    // JSON 里真有这两个键（面板读的是 JSON，不是 TS 对象）。
    expect(JSON.stringify(windows[1])).toContain('"unit":3');
    expect(JSON.stringify(windows[1])).toContain('"number":5');
  });

  it("账号级套餐类型只按路由平面派生，period 不参与", async () => {
    // subscription：coding 平面路由（coding-plan 及派生入口）；
    // experience：start-plan 路由。桶上的 period（授予/重置周期）不推类型——
    // 官方 e2e mock 的体验套餐就是 period: "daily"。
    const { manager, broker } = inMemoryAccounts([
      accountFor(zhipuCredential({ apiKey: "k1", secret: "s1", identity: { targetType: "PERSONAL", deviceMid: "mid-1" } }), {
        label: "dual",
        routes: ["coding-plan", "start-plan"],
      }),
    ]);
    const accountId = (await manager.list())[0]!.id;
    const samples: QuotaSample[] = [
      { accountId, route: "coding-plan", sampledAt: 1, stale: false, quota: { windows: [] } },
      {
        accountId,
        route: "start-plan",
        sampledAt: 1,
        stale: false,
        quota: {
          windows: [],
          balances: [
            { name: "Daily pack", period: "daily", planId: "p-daily", remainingUnits: 10, totalUnits: 10 },
            { name: "Trial", period: "one_time", planId: "p-trial", remainingUnits: 10, totalUnits: 10 },
          ],
        },
      },
    ];
    const dispatch = createControlDispatcher(
      { proxyPort: 0 },
      { accounts: manager, broker, logBuffer: new LogBuffer(), quotaSamples: () => samples },
    );
    const res = await dispatch({ cmd: "listAccounts" });
    if (!isEvent(res, "accounts")) throw new Error("unexpected shape");
    expect(res.accounts[0]?.planKinds).toEqual(["subscription", "experience"]);
  });

  it("实证回归：体验体系的 daily 桶不派生订阅（两张实证卡翻正为「体验」）", async () => {
    // 实证故障：账号 25791793880468642 的「ZCODE GLOBAL BUILD」「ZCode Start Plan」
    // （都是 billing/balance 的体验体系）的 daily 桶被 planKindsOf 的 period 误映射
    // 贴了「订阅套餐」标签。修正后 start-plan 路由 → 只有 experience。
    const { manager, broker } = inMemoryAccounts([
      accountFor(zhipuCredential({ apiKey: "k3", secret: "s3", identity: { targetType: "PERSONAL", deviceMid: "mid-3" } }), {
        label: "evidence",
        routes: ["start-plan"],
      }),
    ]);
    const accountId = (await manager.list())[0]!.id;
    const samples: QuotaSample[] = [
      {
        accountId,
        route: "start-plan",
        sampledAt: 1,
        stale: false,
        quota: {
          windows: [],
          balances: [
            { name: "GLM-5.3", planId: "zcode-global-build", period: "daily", remainingUnits: 6_000_000, totalUnits: 8_000_000 },
            { name: "GLM-5.3-Flash", planId: "zcode-v3-start-plan", period: "daily", remainingUnits: 3_000_000, totalUnits: 5_000_000 },
          ],
        },
      },
    ];
    const dispatch = createControlDispatcher(
      { proxyPort: 0 },
      { accounts: manager, broker, logBuffer: new LogBuffer(), quotaSamples: () => samples },
    );
    const res = await dispatch({ cmd: "listAccounts" });
    if (!isEvent(res, "accounts")) throw new Error("unexpected shape");
    expect(res.accounts[0]?.planKinds).toEqual(["experience"]);
  });

  it("coding 平面账号的 one_time 桶不派生体验（period 两个方向都不推类型）", async () => {
    const { manager, broker } = inMemoryAccounts([
      accountFor(zhipuCredential({ apiKey: "k4", secret: "s4", identity: { targetType: "PERSONAL", deviceMid: "mid-4" } }), {
        label: "coding-only",
        routes: ["coding-plan"],
      }),
    ]);
    const accountId = (await manager.list())[0]!.id;
    const dispatch = createControlDispatcher(
      { proxyPort: 0 },
      {
        accounts: manager,
        broker,
        logBuffer: new LogBuffer(),
        quotaSamples: () => [
          {
            accountId,
            route: "coding-plan",
            sampledAt: 1,
            stale: false,
            quota: { windows: [], balances: [{ name: "Trial", period: "one_time", remainingUnits: 1, totalUnits: 1 }] },
          },
        ],
      },
    );
    const res = await dispatch({ cmd: "listAccounts" });
    if (!isEvent(res, "accounts")) throw new Error("unexpected shape");
    expect(res.accounts[0]?.planKinds).toEqual(["subscription"]);
  });
});

describe("control — quota 立即刷新", () => {
  function dispatchWithRefresh(refreshQuota: (label: string) => Promise<void>) {
    const { manager, broker } = inMemoryAccounts([accountWith("work-team", "key-one")]);
    const state: ControlState = { proxyPort: 0 };
    const ctx: HandlerContext = { accounts: manager, broker, logBuffer: new LogBuffer(), refreshQuota };
    return createControlDispatcher(state, ctx);
  }

  it("带 label：调 refreshQuota 并回 quotaRefreshed（不带快照，面板回读 state）", async () => {
    const refreshed: string[] = [];
    const dispatch = dispatchWithRefresh(async (label) => {
      refreshed.push(label);
    });
    const res = await dispatch({ cmd: "quota", label: " work-team " });
    expect(res).toEqual({ ok: true, event: "quotaRefreshed" });
    // label 先裁剪再查：客户端手滑带空格不应变成「账号不存在」。
    expect(refreshed).toEqual(["work-team"]);
  });

  it("账号不存在：错误原文透出（与 onQuota 同规矩）", async () => {
    const dispatch = dispatchWithRefresh(async () => {
      throw new Error("unknown account: nope");
    });
    const res = await dispatch({ cmd: "quota", label: "nope" });
    expect(res).toEqual({ ok: false, error: "unknown account: nope" });
  });

  it("没接 refreshQuota 钩子：quota_unavailable", async () => {
    const { manager, broker } = inMemoryAccounts([accountWith("work-team", "key-one")]);
    const state: ControlState = { proxyPort: 0 };
    const dispatch = createControlDispatcher(state, { accounts: manager, broker, logBuffer: new LogBuffer() });
    const res = await dispatch({ cmd: "quota", label: "work-team" });
    expect(res).toEqual({ ok: false, error: "quota_unavailable" });
  });

  it("带 labels 走分级采钩子，focusedLabel 原样交给服务端", async () => {
    const calls: Array<{ labels: string[]; focused: string | undefined }> = [];
    const { manager, broker } = inMemoryAccounts([accountWith("work-team", "key-one")]);
    const dispatch = createControlDispatcher({ proxyPort: 0 }, {
      accounts: manager,
      broker,
      logBuffer: new LogBuffer(),
      refreshQuotaScoped: async (labels, focused) => {
        calls.push({ labels, focused });
        return { sampled: ["a"], skipped: [], reason: "focused" };
      },
    });
    const res = await dispatch({ cmd: "quota", labels: ["work-team"], focusedLabel: "work-team" });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ labels: ["work-team"], focused: "work-team" }]);
    if (!isEvent(res, "quotaRefreshScoped")) throw new Error("unexpected shape");
    expect(res.decision.sampled).toEqual(["a"]);
  });

  it("getHealthObservation 是纯内存读，不碰上游", async () => {
    const { manager, broker } = inMemoryAccounts([accountWith("work-team", "key-one")]);
    broker.noteUpstreamSignal((await manager.list())[0]!, "coding-plan", { kind: "rate-limited" });
    const dispatch = createControlDispatcher({ proxyPort: 0 }, { accounts: manager, broker, logBuffer: new LogBuffer() });
    const res = await dispatch({ cmd: "getHealthObservation" });
    if (!isEvent(res, "healthObservation")) throw new Error("unexpected shape");
    expect(res.observation.events[0]?.type).toBe("cooling-enter");
    expect(res.observation.breakers).toEqual([]);
  });
});

describe("control — addAccount", () => {
  it("adds a JWT-only account (start-plan half)", async () => {
    const { dispatch, manager } = controlFor([]);
    const res = await dispatch({ cmd: "addAccount", source: "jwt", label: "jwt-only", jwt: planJwt() });
    expect(res.ok).toBe(true);
    if (!isEvent(res, "accountAdded")) throw new Error("unexpected shape");
    expect(res.label).toBe("jwt-only");
    expect(res.routes).toEqual(["start-plan"]);
    expect(res.idPrefix).toHaveLength(12);
    const stored = await manager.getByLabel("jwt-only");
    expect(stored?.credential.kind).toBe("zhipu-account");
    expect(stored?.credential.kind === "zhipu-account" && stored.credential.jwt).toBeTruthy();
  });

  it("imports from a ZCode credential file without any network call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-p7a-add-"));
    const path = join(dir, "credentials.json");
    writeFileSync(
      path,
      JSON.stringify({ pluginSecret: { accessToken: "feedfacefeedfacefeedfacefeedface.pair", jwt: planJwt() } }),
      "utf-8",
    );
    const { dispatch } = controlFor([]);
    const res = await dispatch({ cmd: "addAccount", source: "file", label: "fromfile", file: path });
    expect(res.ok).toBe(true);
    if (!isEvent(res, "accountAdded")) throw new Error("unexpected shape");
    expect(res.label).toBe("fromfile");
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps TEAM identity when it is complete", async () => {
    const { dispatch, manager } = controlFor([]);
    const res = await dispatch({
      cmd: "addAccount",
      source: "jwt",
      label: "team",
      jwt: planJwt(),
      identity: {
        targetType: "TEAM",
        organizationId: "org-1",
        projectId: "proj-1",
        productId: "prod-1",
      },
    });
    expect(res.ok).toBe(true);
    const stored = await manager.getByLabel("team");
    expect(stored?.credential.kind === "zhipu-account" && stored.credential.identity.organizationId).toBe("org-1");
  });

  it("reports incomplete_team_identity when a TEAM id is missing", async () => {
    const { dispatch } = controlFor([]);
    const res = await dispatch({
      cmd: "addAccount",
      source: "jwt",
      label: "team",
      jwt: planJwt(),
      identity: { targetType: "TEAM", organizationId: "org-1", projectId: "proj-1" },
    });
    expect(res).toEqual({ ok: false, error: "incomplete_team_identity" });
  });

  it("reports duplicate_label for a taken label (no silent rename)", async () => {
    const { dispatch } = controlFor([accountWith("taken", "key-one")]);
    const res = await dispatch({ cmd: "addAccount", source: "jwt", label: "taken", jwt: planJwt() });
    expect(res).toEqual({ ok: false, error: "duplicate_label" });
  });

  it("reports invalid_label for an empty label", async () => {
    const { dispatch } = controlFor([]);
    const res = await dispatch({ cmd: "addAccount", source: "jwt", label: "   ", jwt: planJwt() });
    expect(res).toEqual({ ok: false, error: "invalid_label" });
  });

  it("reports invalid_jwt for a non-JWT secret", async () => {
    const { dispatch } = controlFor([]);
    const res = await dispatch({ cmd: "addAccount", source: "jwt", label: "x", jwt: "not-a-jwt" });
    expect(res).toEqual({ ok: false, error: "invalid_jwt" });
  });

  it("reports invalid_account_source for an unknown source", async () => {
    const { dispatch } = controlFor([]);
    const res = await dispatch({ cmd: "addAccount", source: "ftp" as never, label: "x" });
    expect(res).toEqual({ ok: false, error: "invalid_account_source" });
  });

  it("surfaces an unreadable credential file as import_file_unreadable", async () => {
    const { dispatch } = controlFor([]);
    const res = await dispatch({
      cmd: "addAccount",
      source: "file",
      label: "x",
      file: join(tmpdir(), "zcode-p7a-does-not-exist.json"),
    });
    expect(res).toEqual({ ok: false, error: "import_file_unreadable" });
  });

  it("adds a manually pasted apiKey pair under the file source", async () => {
    const { dispatch, manager } = controlFor([]);
    const res = await dispatch({
      cmd: "addAccount",
      source: "file",
      label: "manual",
      apiKey: "feedfacefeedfacefeedfacefeedface.pair",
      provider: "bigmodel",
    });
    expect(res.ok).toBe(true);
    if (!isEvent(res, "accountAdded")) throw new Error("unexpected shape");
    // 两段 key 就是 coding-plan 那一半，所以默认白名单推得出它。
    expect(res.routes).toEqual(["coding-plan"]);

    const stored = await manager.getByLabel("manual");
    const credential = stored?.credential;
    expect(credential?.provider).toBe("bigmodel");
    expect(credential?.apiKey).toBe("feedfacefeedfacefeedfacefeedface");
    expect(credential?.secret).toBe("pair");
    // 手工建号同样生成自己的指纹（R1）。
    expect(credential?.identity.deviceMid).toBeTruthy();
  });

  it("labels a pasted JWT with the requested provider", async () => {
    // JWT payload 里没有 provider，不指定就会落到默认的 zai。
    const { dispatch, manager } = controlFor([]);
    const res = await dispatch({
      cmd: "addAccount",
      source: "jwt",
      label: "jwt-bigmodel",
      jwt: planJwt(),
      provider: "bigmodel",
    });
    expect(res.ok).toBe(true);
    expect((await manager.getByLabel("jwt-bigmodel"))?.credential.provider).toBe("bigmodel");
  });

  it("rejects a single-segment manual key instead of storing a key that cannot authenticate", async () => {
    const { dispatch, manager } = controlFor([]);
    const res = await dispatch({ cmd: "addAccount", source: "file", label: "x", apiKey: "one-segment-key" });
    expect(res).toEqual({ ok: false, error: "invalid_api_key" });
    expect(await manager.list()).toEqual([]);
  });
});

describe("control — removeAccount", () => {
  it("removes the account and clears its runtime state", async () => {
    const { dispatch, manager, broker } = controlFor([accountWith("a1", "key-one")]);
    await dispatch({ cmd: "setAccountConcurrency", label: "a1", maxConcurrency: 3 });
    const res = await dispatch({ cmd: "removeAccount", label: "a1" });
    expect(res.ok).toBe(true);
    if (!isEvent(res, "accountRemoved")) throw new Error("unexpected shape");
    expect(res.label).toBe("a1");
    expect(res.aborted).toBe(0);
    expect(await manager.list()).toEqual([]);
    // 同名 label 重新导入时不能继承上一个账号的禁用标记/覆盖。
    expect(broker.overrides.get("a1")).toBeUndefined();
  });

  it("reports account_not_found for an unknown label", async () => {
    const { dispatch } = controlFor([accountWith("a1", "key-one")]);
    expect(await dispatch({ cmd: "removeAccount", label: "nope" })).toEqual({
      ok: false,
      error: "account_not_found",
    });
  });

  it("reports invalid_label for a non-string label", async () => {
    const { dispatch } = controlFor([]);
    expect(await dispatch({ cmd: "removeAccount", label: 42 as never })).toEqual({
      ok: false,
      error: "invalid_label",
    });
  });
});

describe("control — setAccountEnabled / concurrency / weight / reset", () => {
  it("disables an account and persists it to the account record", async () => {
    const { dispatch, manager, broker } = controlFor([accountWith("a1", "key-one")]);
    const res = await dispatch({ cmd: "setAccountEnabled", label: "a1", enabled: false });
    if (!isEvent(res, "accountEnabled")) throw new Error("unexpected shape");
    expect(res.enabled).toBe(false);
    expect(broker.overrides.get("a1")?.enabled).toBe(false);
    // 覆盖层只活在进程里；CLI 是一次性进程，所以必须同时落账号记录。
    expect((await manager.getByLabel("a1"))?.enabled).toBe(false);
  });

  it("re-enables an account", async () => {
    const { dispatch, manager } = controlFor([accountWith("a1", "key-one")]);
    await dispatch({ cmd: "setAccountEnabled", label: "a1", enabled: false });
    await dispatch({ cmd: "setAccountEnabled", label: "a1", enabled: true });
    expect((await manager.getByLabel("a1"))?.enabled).toBe(true);
  });

  it("force-disable aborts the in-flight request (force vs drain)", async () => {
    const { dispatch, broker } = controlFor([accountWith("a1", "key-one")]);
    const lease = await broker.acquire({ model: "glm-5.3", sessionId: "s1" });
    const res = await dispatch({ cmd: "setAccountEnabled", label: "a1", enabled: false, force: true });
    if (!isEvent(res, "accountEnabled")) throw new Error("unexpected shape");
    expect(res.aborted).toBe(1);
    expect(lease.signal.aborted).toBe(true);
    lease.release();
  });

  it("drain-disables without aborting the in-flight request", async () => {
    const { dispatch, broker } = controlFor([accountWith("a1", "key-one")]);
    const lease = await broker.acquire({ model: "glm-5.3", sessionId: "s1" });
    const res = await dispatch({ cmd: "setAccountEnabled", label: "a1", enabled: false });
    if (!isEvent(res, "accountEnabled")) throw new Error("unexpected shape");
    expect(res.aborted).toBe(0);
    expect(lease.signal.aborted).toBe(false);
    lease.release();
  });

  it("rejects a non-boolean enabled flag", async () => {
    const { dispatch } = controlFor([accountWith("a1", "key-one")]);
    expect(await dispatch({ cmd: "setAccountEnabled", label: "a1", enabled: "yes" as never })).toEqual({
      ok: false,
      error: "invalid_enabled",
    });
  });

  it("reports account_not_found when enabling an unknown label", async () => {
    const { dispatch } = controlFor([]);
    expect(await dispatch({ cmd: "setAccountEnabled", label: "nope", enabled: true })).toEqual({
      ok: false,
      error: "account_not_found",
    });
  });

  it("sets concurrency and warns above the R11 threshold", async () => {
    const { dispatch, manager } = controlFor([accountWith("a1", "key-one")]);
    const ok = await dispatch({ cmd: "setAccountConcurrency", label: "a1", maxConcurrency: 4 });
    if (!isEvent(ok, "accountConcurrency")) throw new Error("unexpected shape");
    expect(ok.warning).toBeUndefined();
    const warned = await dispatch({ cmd: "setAccountConcurrency", label: "a1", maxConcurrency: 5 });
    if (!isEvent(warned, "accountConcurrency")) throw new Error("unexpected shape");
    expect(warned.warning).toBe("concurrency_above_r11");
    expect((await manager.getByLabel("a1"))?.policy.maxConcurrency).toBe(5);
  });

  it("accepts concurrency 0 (soft disable)", async () => {
    const { dispatch, manager } = controlFor([accountWith("a1", "key-one")]);
    const res = await dispatch({ cmd: "setAccountConcurrency", label: "a1", maxConcurrency: 0 });
    expect(res.ok).toBe(true);
    expect((await manager.getByLabel("a1"))?.policy.maxConcurrency).toBe(0);
  });

  it("rejects a negative concurrency", async () => {
    const { dispatch } = controlFor([accountWith("a1", "key-one")]);
    expect(await dispatch({ cmd: "setAccountConcurrency", label: "a1", maxConcurrency: -1 })).toEqual({
      ok: false,
      error: "invalid_concurrency",
    });
  });

  it("rejects a fractional concurrency", async () => {
    const { dispatch } = controlFor([accountWith("a1", "key-one")]);
    expect(await dispatch({ cmd: "setAccountConcurrency", label: "a1", maxConcurrency: 1.5 })).toEqual({
      ok: false,
      error: "invalid_concurrency",
    });
  });

  it("sets weight and persists it", async () => {
    const { dispatch, manager } = controlFor([accountWith("a1", "key-one")]);
    const res = await dispatch({ cmd: "setAccountWeight", label: "a1", weight: 4 });
    if (!isEvent(res, "accountWeight")) throw new Error("unexpected shape");
    expect(res.weight).toBe(4);
    expect((await manager.getByLabel("a1"))?.policy.weight).toBe(4);
  });

  it("rejects weight 0", async () => {
    const { dispatch } = controlFor([accountWith("a1", "key-one")]);
    expect(await dispatch({ cmd: "setAccountWeight", label: "a1", weight: 0 })).toEqual({
      ok: false,
      error: "invalid_weight",
    });
  });

  it("resets overrides back to the defaults", async () => {
    const { dispatch, manager, broker } = controlFor([accountWith("a1", "key-one")]);
    await dispatch({ cmd: "setAccountConcurrency", label: "a1", maxConcurrency: 6 });
    await dispatch({ cmd: "setAccountWeight", label: "a1", weight: 9 });
    const res = await dispatch({ cmd: "resetAccountOverrides", label: "a1" });
    if (!isEvent(res, "accountOverridesReset")) throw new Error("unexpected shape");
    expect(res.cleared).toBe(true);
    expect(broker.overrides.get("a1")).toBeUndefined();
    const stored = await manager.getByLabel("a1");
    expect(stored?.policy.maxConcurrency).toBe(2);
    expect(stored?.policy.weight).toBe(1);
    expect(stored?.enabled).toBe(true);
  });

  it("reports cleared=false when there was nothing to reset", async () => {
    const { dispatch } = controlFor([accountWith("a1", "key-one")]);
    const res = await dispatch({ cmd: "resetAccountOverrides", label: "a1" });
    if (!isEvent(res, "accountOverridesReset")) throw new Error("unexpected shape");
    expect(res.cleared).toBe(false);
  });
});

describe("control — routing policy", () => {
  it("returns the defaults", async () => {
    const { dispatch } = controlFor([]);
    const res = await dispatch({ cmd: "getRoutingPolicy" });
    if (!isEvent(res, "routingPolicy")) throw new Error("unexpected shape");
    expect(res.routing.order).toEqual(["start-plan", "coding-plan"]);
    // 同档内默认按粘性选号（R10），不是按过期时间。
    expect(res.routing.withinTier).toBe("sticky");
    expect(res.routing.mode).toBe("prefer");
    expect(res.routing.strategy).toBe("sticky-hash");
    expect(res.stickiness.ttlSeconds).toBe(1800);
  });

  it("applies withinTier and returns it in the snapshot", async () => {
    const { dispatch, broker } = controlFor([]);
    const res = await dispatch({ cmd: "setRoutingPolicy", routing: { withinTier: "drain-first" } });
    if (!isEvent(res, "routingPolicy")) throw new Error("unexpected shape");
    expect(res.routing.withinTier).toBe("drain-first");
    expect(broker.routing.withinTier).toBe("drain-first");
  });

  it("applies withinTier: strategy and returns it in the snapshot", async () => {
    const { dispatch, broker } = controlFor([]);
    const res = await dispatch({
      cmd: "setRoutingPolicy",
      routing: { withinTier: "strategy", strategy: "balanced" },
    });
    if (!isEvent(res, "routingPolicy")) throw new Error("unexpected shape");
    expect(res.routing.withinTier).toBe("strategy");
    expect(res.routing.strategy).toBe("balanced");
    expect(broker.routing.withinTier).toBe("strategy");
  });

  it("rejects an unknown withinTier value", async () => {
    const { dispatch, broker } = controlFor([]);
    expect(
      await dispatch({ cmd: "setRoutingPolicy", routing: { withinTier: "expiry" as never } }),
    ).toEqual({ ok: false, error: "invalid_within_tier" });
    expect(broker.routing.withinTier).toBe("sticky");
  });

  it("applies order / mode / strategy and returns the effective policy", async () => {
    const { dispatch, broker } = controlFor([]);
    const res = await dispatch({
      cmd: "setRoutingPolicy",
      routing: { order: ["coding-plan", "start-plan"], mode: "only", strategy: "balanced" },
      stickiness: { enabled: false, ttlSeconds: 600 },
    });
    if (!isEvent(res, "routingPolicy")) throw new Error("unexpected shape");
    expect(res.routing.order).toEqual(["coding-plan", "start-plan"]);
    expect(res.routing.mode).toBe("only");
    expect(broker.routing.strategy).toBe("balanced");
    expect(broker.stickiness.enabled).toBe(false);
    expect(broker.stickiness.ttlSeconds).toBe(600);
  });

  it("rejects an empty order", async () => {
    const { dispatch } = controlFor([]);
    expect(await dispatch({ cmd: "setRoutingPolicy", routing: { order: [] } })).toEqual({
      ok: false,
      error: "invalid_routing_order",
    });
  });

  it("rejects an unknown route in order", async () => {
    const { dispatch } = controlFor([]);
    expect(
      await dispatch({ cmd: "setRoutingPolicy", routing: { order: ["nope" as never] } }),
    ).toEqual({ ok: false, error: "invalid_routing_order" });
  });

  it("rejects an unknown mode and leaves the rest untouched (validate-then-apply)", async () => {
    const { dispatch, broker } = controlFor([]);
    const res = await dispatch({
      cmd: "setRoutingPolicy",
      routing: { order: ["coding-plan"], mode: "sometimes" as never },
    });
    expect(res).toEqual({ ok: false, error: "invalid_routing_mode" });
    expect(broker.routing.order).toEqual(["start-plan", "coding-plan"]);
  });

  it("rejects invalid enum values", async () => {
    const { dispatch } = controlFor([]);
    const cases: [unknown, string][] = [
      [{ strategy: "random" }, "invalid_routing_strategy"],
      [{ onSaturated: "explode" }, "invalid_saturated_action"],
      [{ onDrained: "maybe" }, "invalid_drained_action"],
      [{ onAuthFailed: "downgrade" }, "invalid_auth_failed_action"],
    ];
    for (const [routing, error] of cases) {
      expect(await dispatch({ cmd: "setRoutingPolicy", routing: routing as never })).toEqual({ ok: false, error });
    }
  });

  it("rejects non-positive numbers", async () => {
    const { dispatch } = controlFor([]);
    expect(await dispatch({ cmd: "setRoutingPolicy", routing: { queueTimeoutMs: 0 } })).toEqual({
      ok: false,
      error: "invalid_queue_timeout",
    });
    expect(await dispatch({ cmd: "setRoutingPolicy", routing: { maxQueue: 0 } })).toEqual({
      ok: false,
      error: "invalid_max_queue",
    });
    expect(await dispatch({ cmd: "setRoutingPolicy", routing: { maxTotalInflight: 0 } })).toEqual({
      ok: false,
      error: "invalid_max_total_inflight",
    });
  });

  it("rejects invalid stickiness values", async () => {
    const { dispatch } = controlFor([]);
    expect(await dispatch({ cmd: "setRoutingPolicy", stickiness: { enabled: "yes" as never } })).toEqual({
      ok: false,
      error: "invalid_stickiness_enabled",
    });
    expect(await dispatch({ cmd: "setRoutingPolicy", stickiness: { ttlSeconds: 0 } })).toEqual({
      ok: false,
      error: "invalid_stickiness_ttl",
    });
    expect(await dispatch({ cmd: "setRoutingPolicy", stickiness: { maxSessions: 0 } })).toEqual({
      ok: false,
      error: "invalid_stickiness_max_sessions",
    });
    expect(await dispatch({ cmd: "setRoutingPolicy", stickiness: { onSaturated: "wait" } })).toEqual({
      ok: true,
      event: "routingPolicy",
      routing: expect.anything(),
      stickiness: expect.anything(),
      risk: expect.anything(),
    });
    expect(
      await dispatch({ cmd: "setRoutingPolicy", stickiness: { onSaturated: "nope" as never } }),
    ).toEqual({ ok: false, error: "invalid_stickiness_saturated_action" });
    expect(await dispatch({ cmd: "setRoutingPolicy", stickiness: { overflowAfterMs: 0 } })).toEqual({
      ok: false,
      error: "invalid_overflow_after_ms",
    });
  });

  it("round-trips the risk switch and defaults it from accounts.risk", async () => {
    const { dispatch } = controlFor([]);

    // 没改过时回默认值（accounts.risk.jitterHeartbeat 默认 true）。
    const initial = await dispatch({ cmd: "getRoutingPolicy" });
    if (!isEvent(initial, "routingPolicy")) throw new Error("unexpected shape");
    expect(initial.risk).toEqual({ jitterHeartbeat: true });

    const off = await dispatch({ cmd: "setRoutingPolicy", risk: { jitterHeartbeat: false } });
    if (!isEvent(off, "routingPolicy")) throw new Error("unexpected shape");
    expect(off.risk).toEqual({ jitterHeartbeat: false });

    // 读回来的就是刚写的值（同一个 scheduler 生命周期内一致）。
    const readBack = await dispatch({ cmd: "getRoutingPolicy" });
    if (!isEvent(readBack, "routingPolicy")) throw new Error("unexpected shape");
    expect(readBack.risk).toEqual({ jitterHeartbeat: false });

    // 再打开，并且不影响 routing / stickiness。
    const on = await dispatch({ cmd: "setRoutingPolicy", risk: { jitterHeartbeat: true } });
    if (!isEvent(on, "routingPolicy")) throw new Error("unexpected shape");
    expect(on.risk).toEqual({ jitterHeartbeat: true });
    expect(on.routing.mode).toBe("prefer");
    expect(on.stickiness.enabled).toBe(true);
  });

  it("keeps the risk switch out of the payload when the patch omits it", async () => {
    // 只改 routing 时不产生 risk 覆盖：`risk` 仍是默认快照，不被写空。
    const { dispatch } = controlFor([]);
    const res = await dispatch({ cmd: "setRoutingPolicy", routing: { mode: "only" } });
    if (!isEvent(res, "routingPolicy")) throw new Error("unexpected shape");
    expect(res.risk).toEqual({ jitterHeartbeat: true });
  });

  it("rejects a non-boolean jitterHeartbeat", async () => {
    const { dispatch } = controlFor([]);
    expect(await dispatch({ cmd: "setRoutingPolicy", risk: { jitterHeartbeat: "yes" as never } })).toEqual({
      ok: false,
      error: "invalid_risk_jitter_heartbeat",
    });
  });

  it("reports routing_control_unavailable without a broker", async () => {
    const state: ControlState = { proxyPort: 0 };
    const dispatch = createControlDispatcher(state, { accounts: emptyAccounts(), logBuffer: new LogBuffer() });
    expect(await dispatch({ cmd: "getRoutingPolicy" })).toEqual({
      ok: false,
      error: "routing_control_unavailable",
    });
    expect(await dispatch({ cmd: "setRoutingPolicy", routing: { mode: "only" } })).toEqual({
      ok: false,
      error: "routing_control_unavailable",
    });
  });
});

describe("control — getRiskReport", () => {
  it("flags a shared deviceMid (R1)", async () => {
    // 手改过的账号文件仍可能让两个账号撞同一个指纹（外部输入），所以冲突检查保留。
    const { dispatch } = controlFor([
      accountWith("a1", "key-one", "shared-mid"),
      accountWith("a2", "key-two", "shared-mid"),
      accountWith("a3", "key-three", "own-mid"),
    ]);
    const res = await dispatch({ cmd: "getRiskReport" });
    if (!isEvent(res, "riskReport")) throw new Error("unexpected shape");
    const { report } = res;
    expect(report.deviceMid.accounts).toBe(3);
    expect(report.deviceMid.conflicts).toEqual([{ deviceMid: "shared-mid", labels: ["a1", "a2"] }]);
    expect(report.alerts).toContain("device_mid_shared");
  });

  it("reports independent fingerprints with no alerts", async () => {
    const { dispatch } = controlFor([
      accountWith("a1", "key-one", "mid-1"),
      accountWith("a2", "key-two", "mid-2"),
    ]);
    const res = await dispatch({ cmd: "getRiskReport" });
    if (!isEvent(res, "riskReport")) throw new Error("unexpected shape");
    expect(res.report.deviceMid.accounts).toBe(2);
    expect(res.report.deviceMid.conflicts).toEqual([]);
    expect(res.report.alerts).toEqual([]);
    // R2：跨账号 session 结构上恒为 0（表键是 sessionId）。
    expect(res.report.sessions.crossAccount).toBe(0);
    expect(res.report.sessions.capacity).toBe(4096);
  });

  it("wires the R2 contract: a non-zero crossAccount count becomes an alert", () => {
    // R2 隔离让 crossAccount 结构上恒 0（dispatch 路径测不出非 0），契约「一旦非 0
    // 就告警」单独钉在 pushCrossAccountAlert 里，这里直接测它。
    const alerts: RiskAlert[] = [];
    pushCrossAccountAlert(alerts, 2);
    expect(alerts).toContain("session_cross_account");
    pushCrossAccountAlert(alerts, 1); // 已在就不重复 push
    expect(alerts).toHaveLength(1);
    const idle: RiskAlert[] = [];
    pushCrossAccountAlert(idle, 0); // 恒 0 的常态：不产生告警
    expect(idle).toEqual([]);
  });

  it("reports cooling routes and the concurrency warning", async () => {
    const { dispatch, broker, manager } = controlFor([accountWith("a1", "key-one", "mid-1")]);
    const account = await manager.getByLabel("a1");
    broker.health.apply({ kind: "auth" }, account!.id, "coding-plan");
    await dispatch({ cmd: "setAccountConcurrency", label: "a1", maxConcurrency: 9 });
    const res = await dispatch({ cmd: "getRiskReport" });
    if (!isEvent(res, "riskReport")) throw new Error("unexpected shape");
    expect(res.report.failures[0]?.status).toBe("cooling");
    expect(res.report.failures[0]?.reason).toBe("auth-failed");
    expect(res.report.alerts).toContain("account_cooling");
    expect(res.report.alerts).toContain("concurrency_above_r11");
    expect(res.report.inflight.limit).toBe(8);
  });
});

describe("control — exportAccounts / importAccount", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zcode-p7a-export-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = (): Account[] => [
    accountWith("a1", "key-one", "mid-1"),
    accountWith("a2", "key-two", "mid-2"),
  ];

  it("returns a masked list without touching the disk", async () => {
    const { dispatch } = controlFor(seed());
    const res = await dispatch({ cmd: "exportAccounts", format: "masked" });
    if (!isEvent(res, "accountsExported")) throw new Error("unexpected shape");
    expect(res.path).toBeUndefined();
    expect(res.count).toBe(2);
    expect(res.accounts?.map((a) => a.label)).toEqual(["a1", "a2"]);
    const serialized = JSON.stringify(res);
    // 掩码清单只有指纹前缀，绝不含凭据原文。
    expect(serialized).not.toContain("testsecret");
    expect(serialized).not.toContain("testkey");
  });

  it("requires --force for a plain export", async () => {
    const { dispatch } = controlFor(seed());
    expect(await dispatch({ cmd: "exportAccounts", format: "plain", out: join(dir, "p.json") })).toEqual({
      ok: false,
      error: "plain_export_requires_confirmation",
    });
  });

  it("writes a plain bundle when forced", async () => {
    const { dispatch } = controlFor(seed());
    const path = join(dir, "plain.json");
    const res = await dispatch({ cmd: "exportAccounts", format: "plain", out: path, force: true });
    if (!isEvent(res, "accountsExported")) throw new Error("unexpected shape");
    expect(res.path).toBe(path);
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { kind: string; accounts: unknown[] };
    expect(parsed.kind).toBe("zcode-proxy-accounts");
    expect(parsed.accounts).toHaveLength(2);
    // 导出文件只给本用户。
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("requires a password for an encrypted export", async () => {
    const { dispatch } = controlFor(seed());
    expect(await dispatch({ cmd: "exportAccounts", format: "encrypted", out: join(dir, "e.json") })).toEqual({
      ok: false,
      error: "export_password_required",
    });
  });

  it("writes an encrypted bundle that does not contain the secrets", async () => {
    const { dispatch } = controlFor(seed());
    const path = join(dir, "enc.json");
    const res = await dispatch({ cmd: "exportAccounts", format: "encrypted", out: path, password: "pw" });
    if (!isEvent(res, "accountsExported")) throw new Error("unexpected shape");
    const text = readFileSync(path, "utf-8");
    const parsed = JSON.parse(text) as { encrypted?: boolean; kdf?: { name?: string } };
    expect(parsed.encrypted).toBe(true);
    expect(parsed.kdf?.name).toBe("scrypt");
    expect(text).not.toContain("testsecret");
  });

  it("rejects an unknown export format", async () => {
    const { dispatch } = controlFor(seed());
    expect(await dispatch({ cmd: "exportAccounts", format: "zip" as never })).toEqual({
      ok: false,
      error: "invalid_export_format",
    });
  });

  it("round-trips an encrypted bundle into an empty store", async () => {
    const path = join(dir, "enc.json");
    const source = controlFor(seed());
    await source.dispatch({ cmd: "exportAccounts", format: "encrypted", out: path, password: "pw" });

    const target = controlFor([]);
    const res = await target.dispatch({ cmd: "importAccount", path, password: "pw" });
    if (!isEvent(res, "accountsImported")) throw new Error("unexpected shape");
    expect(res.imported).toBe(2);
    expect(res.labels).toEqual(["a1", "a2"]);
    const stored = await target.manager.list();
    expect(stored.map((a) => a.label).sort()).toEqual(["a1", "a2"]);
    expect(stored[0]?.credential.apiKey).toBe("key-one");
  });

  it("round-trips a plain bundle", async () => {
    const path = join(dir, "plain.json");
    const source = controlFor(seed());
    await source.dispatch({ cmd: "exportAccounts", format: "plain", out: path, force: true });

    const target = controlFor([]);
    const res = await target.dispatch({ cmd: "importAccount", path });
    if (!isEvent(res, "accountsImported")) throw new Error("unexpected shape");
    expect(res.imported).toBe(2);
  });

  /**
   * 旧实现写出的加密导出包必须照常导入。
   *
   * 导出包的 AES 实现从 `node:crypto` 换成了 WebCrypto（项目里只保留一种 AES 实现，
   * 见 `accounts/transfer.ts::gcmKey`）。包格式没动：`salt / iv / tag / data` 各自
   * 一个 base64 字段，KDF 仍是 scrypt。这个夹具由旧实现生成
   * （固定 salt 与 iv，密码 `w17-export-password`），钉住「老包还能导入」。
   */
  const PRE_W17_ENCRYPTED_BUNDLE = {
    kind: "zcode-proxy-accounts",
    version: 1,
    encrypted: true,
    kdf: {
      name: "scrypt",
      cost: 16_384,
      blockSize: 8,
      parallelization: 1,
      salt: "BwcHBwcHBwcHBwcHBwcHBw==",
    },
    iv: "AwMDAwMDAwMDAwMD",
    tag: "ZJnEWiR8VRdyPG5Zm064aw==",
    data: "vQZO77n+AvOgSSAX2/QKub2/nDCdcTcnyRA8pRNxsroS7kxD400OqGv1JIpgM3wlU7HOci4nhMv+UOwTEkVBErvNZVd+/nnp1/Fbv8xJQkUW+lhhUd547ZvrQLb/mWDHLcZo+1jBH5ASqm85IeayxY8Z2GiVJX2QO/pHBjJzudSdYPGNaCSx/zD8gB+bouDgmDD2iOfSgIhAQit09hF6eRLXrGbqAYFahDdUbUwYaaXVmUgO01EgqBcrtps+R0hjXHxtpcNm9JXdCOvVoWJRMxbd/87mTjsiGG2wAloRCrZByT8GDEy76+DztYjaRfrT+u1NcX32tNfypt7tJHzQ7slGnkXY3NpdbyYVeQMGyWJRmhBkFXMwXz0/mQoxfa7MrObKKTACxfZERVLoqouGxMINXptc5agb4/wC1NoeIIbsY2r/hh8gJ5QeqJbeYHckbZXuEwkdkaAQTNROkbcz/PKGpBEpMy0LRQUwwhNK/I0qKBeo0aq/nW8MTqPwA/ToYSD8oQEWnLDvLRn9EH9l1fB8W0c8eiqAlJNicOKKntmxFy2aGWllMNvb1Cc8g4efHA==",
  };

  it("imports an encrypted bundle written by the old implementation", async () => {
    const path = join(dir, "legacy-enc.json");
    writeFileSync(path, JSON.stringify(PRE_W17_ENCRYPTED_BUNDLE), "utf-8");

    const target = controlFor([]);
    const res = await target.dispatch({ cmd: "importAccount", path, password: "w17-export-password" });
    if (!isEvent(res, "accountsImported")) throw new Error("unexpected shape");
    expect(res.imported).toBe(1);
    expect(res.labels).toEqual(["legacy-export"]);

    const stored = await target.manager.list();
    expect(stored[0]?.credential.apiKey).toBe("legacy-api-key");
  });

  it("reports import_password_required for an encrypted bundle without a password", async () => {
    const path = join(dir, "enc.json");
    const source = controlFor(seed());
    await source.dispatch({ cmd: "exportAccounts", format: "encrypted", out: path, password: "pw" });
    const target = controlFor([]);
    expect(await target.dispatch({ cmd: "importAccount", path })).toEqual({
      ok: false,
      error: "import_password_required",
    });
  });

  it("reports import_decrypt_failed for a wrong password", async () => {
    const path = join(dir, "enc.json");
    const source = controlFor(seed());
    await source.dispatch({ cmd: "exportAccounts", format: "encrypted", out: path, password: "pw" });
    const target = controlFor([]);
    expect(await target.dispatch({ cmd: "importAccount", path, password: "wrong" })).toEqual({
      ok: false,
      error: "import_decrypt_failed",
    });
  });

  it("reports import_file_not_found for a missing path", async () => {
    const { dispatch } = controlFor([]);
    expect(await dispatch({ cmd: "importAccount", path: join(dir, "nope.json") })).toEqual({
      ok: false,
      error: "import_file_not_found",
    });
  });

  it("reports import_file_malformed for non-JSON content", async () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "not json{", "utf-8");
    const { dispatch } = controlFor([]);
    expect(await dispatch({ cmd: "importAccount", path })).toEqual({
      ok: false,
      error: "import_file_malformed",
    });
  });

  it("reports import_invalid_bundle for a wrong bundle version", async () => {
    const path = join(dir, "old.json");
    writeFileSync(path, JSON.stringify({ kind: "zcode-proxy-accounts", version: 99, accounts: [] }), "utf-8");
    const { dispatch } = controlFor([]);
    expect(await dispatch({ cmd: "importAccount", path })).toEqual({
      ok: false,
      error: "import_invalid_bundle",
    });
  });

  it("rejects a bundle whose account entry is structurally wrong", async () => {
    const path = join(dir, "broken.json");
    writeFileSync(
      path,
      JSON.stringify({ kind: "zcode-proxy-accounts", version: 1, accounts: [{ label: "x" }] }),
      "utf-8",
    );
    const { dispatch } = controlFor([]);
    expect(await dispatch({ cmd: "importAccount", path })).toEqual({
      ok: false,
      error: "import_invalid_bundle",
    });
  });

  it("falls back to the ZCode credential-store importer for a foreign file", async () => {
    const path = join(dir, "zcode.json");
    writeFileSync(
      path,
      JSON.stringify({ pluginSecret: { accessToken: "feedfacefeedfacefeedfacefeedface.pair", jwt: planJwt() } }),
      "utf-8",
    );
    const { dispatch } = controlFor([]);
    const res = await dispatch({ cmd: "importAccount", path });
    if (!isEvent(res, "accountsImported")) throw new Error("unexpected shape");
    expect(res.imported).toBe(1);
  });

  /* ---- 内容模式（网页的文件选择 / 下载）--------------------------------- */

  it("returns the bundle inline without touching the disk", async () => {
    const { dispatch } = controlFor(seed());
    /* 故意带 `out`：内容模式必须**不写文件**，参数混着给时以 inline 为准。*/
    const res = await dispatch({ cmd: "exportAccounts", format: "plain", force: true, inline: true, out: join(dir, "ignored.json") });
    if (!isEvent(res, "accountsExported")) throw new Error("unexpected shape");
    expect(res.path).toBeUndefined();
    // 文件名：本地时刻的 `zcode-accounts-YYYYMMDD-HHmmss.json`
    expect(res.filename).toMatch(/^zcode-accounts-\d{8}-\d{6}\.json$/);
    const parsed = JSON.parse(res.payload ?? "{}") as { kind: string; accounts: unknown[] };
    expect(parsed.kind).toBe("zcode-proxy-accounts");
    expect(parsed.accounts).toHaveLength(2);
    expect(existsSync(join(dir, "ignored.json"))).toBe(false);
  });

  it("round-trips an inline encrypted bundle through the content mode", async () => {
    const source = controlFor(seed());
    const exported = await source.dispatch({ cmd: "exportAccounts", format: "encrypted", password: "pw", inline: true });
    if (!isEvent(exported, "accountsExported")) throw new Error("unexpected shape");
    const content = exported.payload;
    if (typeof content !== "string") throw new Error("no inline payload");
    expect(content).not.toContain("testsecret");

    const target = controlFor([]);
    const res = await target.dispatch({ cmd: "importAccount", content, password: "pw" });
    if (!isEvent(res, "accountsImported")) throw new Error("unexpected shape");
    expect(res.imported).toBe(2);
    expect(res.labels).toEqual(["a1", "a2"]);
    expect((await target.manager.list())[0]?.credential.apiKey).toBe("key-one");
  });

  it("reports the same import errors for content as for a path", async () => {
    const { dispatch } = controlFor([]);
    expect(await dispatch({ cmd: "importAccount", content: "not json{" })).toEqual({
      ok: false,
      error: "import_file_malformed",
    });
    // 加密包没给密码：内容模式不该因为“没落盘”就漏了这道检查
    const encrypted = await controlFor(seed()).dispatch({
      cmd: "exportAccounts",
      format: "encrypted",
      password: "pw",
      inline: true,
    });
    if (!isEvent(encrypted, "accountsExported")) throw new Error("unexpected shape");
    expect(await dispatch({ cmd: "importAccount", content: encrypted.payload })).toEqual({
      ok: false,
      error: "import_password_required",
    });
  });

  it("imports a ZCode credential store from content, without a path on disk", async () => {
    /* 内容模式的关键：文件根本不存在，但凭据仍能导进来——`auth/import.ts`
       见到 `content` 就不读盘，所以网页上传的东西不必先写临时文件。*/
    const store = JSON.stringify({ pluginSecret: { accessToken: "feedfacefeedfacefeedfacefeedface.pair", jwt: planJwt() } });
    const { dispatch } = controlFor([]);
    const res = await dispatch({ cmd: "importAccount", content: store, path: join(dir, "never-written.json") });
    if (!isEvent(res, "accountsImported")) throw new Error("unexpected shape");
    expect(res.imported).toBe(1);
    expect(existsSync(join(dir, "never-written.json"))).toBe(false);
  });

  it("answers a masked inline export with a list and no payload", async () => {
    const res = await controlFor(seed()).dispatch({ cmd: "exportAccounts", format: "masked", inline: true });
    if (!isEvent(res, "accountsExported")) throw new Error("unexpected shape");
    expect(res.payload).toBeUndefined();
    expect(res.filename).toBeUndefined();
    expect(res.accounts).toHaveLength(2);
  });
});

describe("control — detectAppVersion", () => {
  /** 探测入口注入；`null` 模拟「本机没装官方客户端」。*/
  function detectorFor(result: { version: string; path: string } | null) {
    const state: ControlState = { proxyPort: 0 };
    return createControlDispatcher(state, {
      accounts: emptyAccounts(),
      logBuffer: new LogBuffer(),
      onDetectAppVersion: () => result,
    });
  }

  it("reports the detected version together with the file it came from", async () => {
    const path = ["", "Applications", "ZCode.app", "Contents", "Info.plist"].join("/");
    const res = await detectorFor({ version: "3.17.2", path })({ cmd: "detectAppVersion" });
    expect(res).toEqual({ ok: true, event: "appVersion", detected: "3.17.2", path });
  });

  it("answers detected: null when no client is installed", async () => {
    const res = await detectorFor(null)({ cmd: "detectAppVersion" });
    expect(res).toEqual({ ok: true, event: "appVersion", detected: null });
  });
});

// ---------------------------------------------------------------------------
// 出口代理表（热调节 / UI）
// ---------------------------------------------------------------------------

describe("control — proxies", () => {
  const HOME: ProxySpec = { name: "home", url: "http://127.0.0.1:7890" };
  /** 认证写在 URL 里**同时**有 `password` 字段：两种写法都不许回显。 */
  const OFFICE: ProxySpec = {
    name: "office",
    url: "socks5://user:s3cret@10.0.0.5:1080",
    password: "s3cret",
  };

  /** 一条代理被两个账号用（显式绑定 + 继承默认），第三个直连。 */
  function twoExchange() {
    return controlFor([accountWith("a1", "k1", "m1"), accountWith("a2", "k2", "m2"), accountWith("a3", "k3", "m3")], {
      proxies: [{ ...HOME }, { ...OFFICE }],
      entries: [{ label: "a1", proxy: "home" }, { label: "a2", proxy: "direct" }],
    });
  }

  it("listProxies returns the table with usage counted per effective egress", async () => {
    const { dispatch } = twoExchange();
    const res = await dispatch({ cmd: "listProxies" });
    if (!isEvent(res, "proxies")) throw new Error("unexpected shape");
    expect(res.proxies.map((proxy) => [proxy.name, proxy.enabled, proxy.usedBy])).toEqual([
      ["home", true, 1],
      ["office", true, 0],
    ]);
  });

  it("never echoes a password: it masks the url and answers hasPassword only", async () => {
    const { dispatch } = twoExchange();
    const res = await dispatch({ cmd: "listProxies" });
    if (!isEvent(res, "proxies")) throw new Error("unexpected shape");
    const office = res.proxies.find((proxy) => proxy.name === "office");
    expect(office?.url).toBe("socks5://user:***@10.0.0.5:1080");
    expect(office?.hasPassword).toBe(true);
    expect(res.proxies.find((proxy) => proxy.name === "home")?.hasPassword).toBe(false);
    // 整条应答里都不该出现密码原文（不只是那一个字段）。
    expect(JSON.stringify(res)).not.toContain("s3cret");
  });

  it("addProxy appends a row and returns the whole updated table", async () => {
    const { dispatch, broker } = twoExchange();
    const res = await dispatch({ cmd: "addProxy", name: "backup", url: "http://127.0.0.1:7891" });
    if (!isEvent(res, "proxies")) throw new Error("unexpected shape");
    expect(res.proxies.map((proxy) => proxy.name)).toEqual(["home", "office", "backup"]);
    expect(broker.proxyTable().map((proxy) => proxy.name)).toEqual(["home", "office", "backup"]);
  });

  it("addProxy rejects a duplicate name and an unsupported protocol", async () => {
    const { dispatch } = twoExchange();
    expect(await dispatch({ cmd: "addProxy", name: "home", url: "http://127.0.0.1:1" })).toEqual({
      ok: false,
      error: "duplicate_proxy_name",
    });
    expect(await dispatch({ cmd: "addProxy", name: "typo", url: "127.0.0.1:1080" })).toEqual({
      ok: false,
      error: "invalid_proxy_url",
    });
    expect(await dispatch({ cmd: "addProxy", name: "  ", url: "http://127.0.0.1:1" })).toEqual({
      ok: false,
      error: "invalid_proxy_name",
    });
    // `direct` 是引用语法里的值：叫这个名字的代理永远选不到，所以在边界上拒。
    expect(await dispatch({ cmd: "addProxy", name: "direct", url: "http://127.0.0.1:1" })).toEqual({
      ok: false,
      error: "proxy_name_reserved",
    });
  });

  it("setProxy changes the url and the switch, and returns the updated table", async () => {
    const { dispatch, broker } = twoExchange();
    const res = await dispatch({ cmd: "setProxy", name: "office", url: "socks5h://10.0.0.6:1080", enabled: false });
    if (!isEvent(res, "proxies")) throw new Error("unexpected shape");
    const office = res.proxies.find((proxy) => proxy.name === "office");
    expect(office?.enabled).toBe(false);
    expect(broker.proxyTable().find((proxy) => proxy.name === "office")?.url).toBe("socks5h://10.0.0.6:1080");
  });

  it("setProxy reports proxy_not_found for an unknown name", async () => {
    const { dispatch } = twoExchange();
    expect(await dispatch({ cmd: "setProxy", name: "nope", enabled: true })).toEqual({
      ok: false,
      error: "proxy_not_found",
    });
  });

  it("removeProxy refuses while an account still egresses through it", async () => {
    const { dispatch, broker } = twoExchange();
    expect(await dispatch({ cmd: "removeProxy", name: "home" })).toEqual({ ok: false, error: "proxy_in_use" });
    expect(broker.proxyTable().map((proxy) => proxy.name)).toContain("home");
  });

  it("removeProxy with force detaches the accounts and says which ones", async () => {
    const { dispatch, broker } = twoExchange();
    const res = await dispatch({ cmd: "removeProxy", name: "home", force: true });
    if (!isEvent(res, "proxies")) throw new Error("unexpected shape");
    expect(res.detached).toEqual(["a1"]);
    expect(res.proxies.map((proxy) => proxy.name)).toEqual(["office"]);
    expect(broker.proxyTable().map((proxy) => proxy.name)).toEqual(["office"]);
    // 被断开的账号回落到默认出口（这里没配默认代理 → 直连），不会静默留在半坏状态。
    const accounts = await dispatch({ cmd: "listAccounts" });
    if (!isEvent(accounts, "accounts")) throw new Error("unexpected shape");
    expect(accounts.accounts.find((account) => account.label === "a1")?.proxy).toBe("direct");
  });

  it("setAccountProxy points an account at a name, and at direct", async () => {
    const { dispatch, broker } = twoExchange();
    const moved = await dispatch({ cmd: "setAccountProxy", label: "a3", proxy: "office" });
    expect(moved).toEqual({ ok: true, event: "accountProxy", label: "a3", proxy: "office" });
    expect(broker.proxyTable().length).toBe(2);

    const direct = await dispatch({ cmd: "setAccountProxy", label: "a3", proxy: "direct" });
    expect(direct).toEqual({ ok: true, event: "accountProxy", label: "a3", proxy: "direct" });
    const accounts = await dispatch({ cmd: "listAccounts" });
    if (!isEvent(accounts, "accounts")) throw new Error("unexpected shape");
    expect(accounts.accounts.find((account) => account.label === "a3")?.proxy).toBe("direct");
  });

  it("setAccountProxy rejects an unknown or disabled proxy instead of falling back to direct", async () => {
    // 静默直连会把这个账号的真实地址泄露给上游，是本功能最危险的失败模式。
    const { dispatch } = twoExchange();
    expect(await dispatch({ cmd: "setAccountProxy", label: "a3", proxy: "nope" })).toEqual({
      ok: false,
      error: "proxy_not_found",
    });
    await dispatch({ cmd: "setProxy", name: "office", enabled: false });
    expect(await dispatch({ cmd: "setAccountProxy", label: "a3", proxy: "office" })).toEqual({
      ok: false,
      error: "proxy_disabled",
    });
  });

  it("reports proxy_control_unavailable without a broker", async () => {
    const dispatch = createControlDispatcher({ proxyPort: 0 }, {
      accounts: emptyAccounts(),
      logBuffer: new LogBuffer(),
    });
    expect(await dispatch({ cmd: "listProxies" })).toEqual({ ok: false, error: "proxy_control_unavailable" });
  });
});

// ---------------------------------------------------------------------------
// 抢活动控制面：三条命令的包络与降级
// ---------------------------------------------------------------------------

describe("control surface — claim commands", () => {
  const state: ControlState = { proxyPort: 8080 };

  it("answers claim_unavailable when the hooks are missing (CLI entry)", async () => {
    for (const cmd of [
      { cmd: "getClaimOverview" },
      { cmd: "previewClaimPlans", accountLabel: "work" },
      { cmd: "listClaimPlanChoices" },
      { cmd: "claimNow", accountLabel: "work", planId: "weekend-1" },
    ]) {
      const result = await post(cmd, state);
      expect(result.body.ok).toBe(false);
      if (!result.body.ok) expect(result.body.error).toBe("claim_unavailable");
    }
  });

  it("maps hook results to the envelope (overview / plans / outcome)", async () => {
    const ctx: HandlerContext = {
      accounts: emptyAccounts(),
      logBuffer: new LogBuffer(),
      onClaimOverview: async () => ({
        ok: true,
        value: {
          config: {
            enabled: true,
            auto: true,
            origin: "https://zcode.test",
            pollIntervalMs: 300000,
            cooldownMs: 600000,
            sprintWindowMs: 1800000,
            sprintPollIntervalMs: 60000,
            policy: "upstream-priority",
            opening: {
              preheatMs: 180000,
              probeIntervalMs: 10000,
              burstIntervalMs: 2000,
              burstWindowMs: 180000,
              accountStaggerMs: 200,
              maxClaimsPerAccount: 6,
            },
          },
          accounts: [{ label: "work", running: true, holdUntil: 12345 }],
        },
      }),
      onPreviewClaimPlans: async (label) =>
        label === "work"
          ? { ok: true, value: [{ planId: "weekend-1", name: "Weekend", description: "", priority: 9, entitlements: [], source: "billing/preview", discoveryFaces: ["billing/preview"], raw: {} }] }
          : { ok: false, code: "account_not_found" },
      onClaimNow: async (_label, planId) => ({ ok: true, value: { ok: false, planId, failureKind: "already_claimed", code: 1003, message: "claimed" } }),
    };
    const overview = await post({ cmd: "getClaimOverview" }, state, ctx);
    expect(overview.body.ok).toBe(true);
    if (overview.body.ok && "event" in overview.body && overview.body.event === "claimOverview") {
      expect(overview.body.accounts[0]).toEqual({ label: "work", running: true, holdUntil: 12345 });
    }

    const plans = await post({ cmd: "previewClaimPlans", accountLabel: "work" }, state, ctx);
    expect(plans.body.ok).toBe(true);
    if (plans.body.ok && "event" in plans.body && plans.body.event === "claimPlans") {
      expect(plans.body.label).toBe("work");
      expect(plans.body.plans[0]?.planId).toBe("weekend-1");
    }

    const missing = await post({ cmd: "previewClaimPlans", accountLabel: "ghost" }, state, ctx);
    expect(missing.body).toEqual({ ok: false, error: "account_not_found" });

    const outcome = await post({ cmd: "claimNow", accountLabel: "work", planId: "weekend-1" }, state, ctx);
    expect(outcome.body.ok).toBe(true);
    if (outcome.body.ok && "event" in outcome.body && outcome.body.event === "claimOutcome") {
      expect(outcome.body.label).toBe("work");
      expect(outcome.body.outcome).toMatchObject({ ok: false, failureKind: "already_claimed" });
    }
  });

  it("keeps the hook discipline: failure code in error, detail in message", async () => {
    const ctx: HandlerContext = {
      accounts: emptyAccounts(),
      logBuffer: new LogBuffer(),
      onClaimOverview: async () => ({ ok: false, code: "claim_preview_failed", message: "preview HTTP 500" }),
    };
    const result = await post({ cmd: "getClaimOverview" }, state, ctx);
    expect(result.body).toEqual({ ok: false, error: "claim_preview_failed", message: "preview HTTP 500" });
  });

  it("maps the plan-picker hook to its envelope (listClaimPlanChoices)", async () => {
    const ctx: HandlerContext = {
      accounts: emptyAccounts(),
      logBuffer: new LogBuffer(),
      onListClaimPlanChoices: async () => ({
        ok: true,
        value: {
          accountLabel: "work",
          plans: [{ planId: "weekend-1", name: "Weekend", description: "two days", priority: 9, source: "preview" as const }],
        },
      }),
    };
    const result = await post({ cmd: "listClaimPlanChoices" }, state, ctx);
    expect(result.body).toEqual({
      ok: true,
      event: "claimPlanChoices",
      accountLabel: "work",
      plans: [{ planId: "weekend-1", name: "Weekend", description: "two days", priority: 9, source: "preview" }],
    });
  });

  it("passes the picker hook's stable codes through the same envelope", async () => {
    const ctx: HandlerContext = {
      accounts: emptyAccounts(),
      logBuffer: new LogBuffer(),
      onListClaimPlanChoices: async () => ({ ok: false, code: "claim_rate_limited", message: "preview HTTP 429" }),
    };
    const result = await post({ cmd: "listClaimPlanChoices" }, state, ctx);
    expect(result.body).toEqual({ ok: false, error: "claim_rate_limited", message: "preview HTTP 429" });
  });
});
/* ------------------------------------------------------------------------- */
/* API key 的 secret 往返（控制面应答形状）                                    */
/*                                                                         */
/* 存储层（manager）已有加密往返的单元覆盖；这里钉的是**控制面应答**的两条       */
/* 形状：listApiKeys 的每条摘要带解密后的 secret（页面掩码 / 复制 / 聊天页      */
/* 直接发都靠它），createApiKey 的摘要不带（明文只走应答顶层的 `key`，创建     */
/* 弹窗的一次性仪式）。仓是注入的（HandlerContext.apiKeys），不碰用户文件。    */
/* ------------------------------------------------------------------------- */
describe("api key commands — secret round-trip", () => {
  function ctxWithKeys(): HandlerContext {
    return {
      accounts: emptyAccounts(),
      logBuffer: new LogBuffer(),
      apiKeys: new ApiKeyManager(memoryApiKeysStore(), Date.now, codecFromSeed("w102-control")),
    };
  }

  it("createApiKey's reply carries the plaintext key but no secret on the summary", async () => {
    const ctx = ctxWithKeys();
    const result = await post({ cmd: "createApiKey", name: "laptop" }, { proxyPort: 0 }, ctx);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok && "event" in result.body && result.body.event === "apiKeyCreated") {
      expect(typeof result.body.key).toBe("string");
      expect(result.body.key).toContain("sk-zcp-");
      // 摘要不带 secret：创建的明文只走顶层的 `key`（一次性仪式）。
      expect(result.body.apiKey).not.toHaveProperty("secret");
    }
  });

  it("listApiKeys carries the decrypted secret on every summary", async () => {
    const ctx = ctxWithKeys();
    const created = await post({ cmd: "createApiKey", name: "ci" }, { proxyPort: 0 }, ctx);
    if (!(created.body.ok && "event" in created.body && created.body.event === "apiKeyCreated")) {
      throw new Error("create failed");
    }
    const plaintext = created.body.key as string;

    const listed = await post({ cmd: "listApiKeys" }, { proxyPort: 0 }, ctx);
    expect(listed.body.ok).toBe(true);
    if (listed.body.ok && "event" in listed.body && listed.body.event === "apiKeys") {
      expect(listed.body.apiKeys).toHaveLength(1);
      expect(listed.body.apiKeys[0]?.secret).toBe(plaintext);
    }
  });
});
