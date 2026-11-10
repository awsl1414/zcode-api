/**
 * `GET /api/events` 的单元测试。
 *
 * 用假的 `req` / `res` + 手动推进的调度器，逐帧断言 SSE 输出：这样「一拍」是确定的
 * （不用等真实时间，也不用假时钟去骗 `setInterval`），而断开清理也能断言到
 * 「定时器一个不剩」，那正是任务里「客户端断开时清理订阅，不留定时器」这一条。
 *
 * 日志来源用的是**真的** `LogBuffer`（`src/control/control.ts`）而不是另造一份数组：
 * 这条用例同时也是「不新起一套采集」的证据。
 */
import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlCommand, ControlResponse } from "../control/control.js";
import { LogBuffer } from "../log/buffer.js";
import {
  HEARTBEAT_INTERVAL_MS,
  LOG_POLL_INTERVAL_MS,
  logPayloadFor,
  SSE_CONTENT_TYPE,
  SSE_EVENT_LOG,
  SSE_EVENT_STATE,
  SSE_EVENT_REQUEST,
  SSE_RETRY_MS,
  STATE_POLL_INTERVAL_MS,
  logAccountOf,
  logLevelOf,
  openEventStream,
  type IntervalScheduler,
} from "./routes-events.js";
import type { StatePayload, StateResult } from "./routes-state.js";
import { RequestStore } from "../proxy/request-record.js";
import type { RequestRecord } from "../proxy/request-record.js";
import { DEFAULT_ACCOUNTS_ROUTING, DEFAULT_ACCOUNTS_STICKINESS } from "../accounts/routing.js";
import { DEFAULT_ACCOUNTS_RISK } from "../config/types.js";

/* ------------------------------------------------------------------------- */
/* 脚手架                                                                      */
/* ------------------------------------------------------------------------- */

/** 一帧 SSE（`event:` + `data:` 行；`:` 开头的是注释帧）。*/
interface Frame {
  event?: string;
  data?: string;
  retry?: string;
  comment?: boolean;
}

/** 假响应：记录响应头与所有 `write()` 的原文，`close()` 由测试自己 emit。*/
class FakeResponse extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  readonly chunks: string[] = [];

  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  /** 已写出的全部字节。*/
  get body(): string {
    return this.chunks.join("");
  }

  /** 解析成帧列表（`\n\n` 分帧，空段丢弃）。*/
  frames(): Frame[] {
    return this.body
      .split("\n\n")
      .filter((raw) => raw.length > 0)
      .map(parseFrame);
  }

  /** 某个事件名的全部数据帧（已 JSON.parse）。*/
  events(name: string): unknown[] {
    return this.frames()
      .filter((frame) => frame.event === name)
      .map((frame) => JSON.parse(frame.data ?? "null") as unknown);
  }

  asResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

function parseFrame(raw: string): Frame {
  const frame: Frame = {};
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith(":")) {
      frame.comment = true;
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") frame.event = value;
    else if (field === "data") frame.data = value;
    else if (field === "retry") frame.retry = value;
  }
  return frame;
}

/** 手动调度器：`tick(ms)` 推进某个间隔的一拍，`active()` 数还活着的定时器。*/
interface ManualScheduler {
  scheduler: IntervalScheduler;
  tick(ms: number): void;
  active(): number;
}

function manualScheduler(): ManualScheduler {
  const tasks: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  return {
    scheduler: {
      every(ms: number, fn: () => void): () => void {
        const task = { ms, fn, cancelled: false };
        tasks.push(task);
        return () => {
          task.cancelled = true;
        };
      },
    },
    tick(ms: number): void {
      for (const task of tasks) if (task.ms === ms && !task.cancelled) task.fn();
    },
    active(): number {
      return tasks.filter((task) => !task.cancelled).length;
    },
  };
}

/** 一份最小状态载荷（`StatePayload` 的字段全给齐，内容不是本用例的断言对象）。*/
function statePayload(): StatePayload {
  return {
    server: { port: 8090, version: "5.0.0", uptime: 42 },
    accounts: [],
    routing: { ...DEFAULT_ACCOUNTS_ROUTING },
    stickiness: { ...DEFAULT_ACCOUNTS_STICKINESS },
    risk: { alerts: [], policy: { ...DEFAULT_ACCOUNTS_RISK } },
    metrics: { inflight: 0, concurrencyLimit: 8, queueDepth: 0, sampledAt: 1, inflightHistory: [] },
  };
}

/** 让挂起的 promise 链跑完（`pollLogs` / `pollState` 都是 async）。*/
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

interface Harness {
  req: IncomingMessage;
  res: FakeResponse;
  buffer: LogBuffer;
  /** 每次 `getLogs` 收到的 `since`。*/
  since: number[];
  scheduler: ManualScheduler;
  /** 断开（模拟浏览器关标签页）。*/
  disconnect(): void;
  /** 流句柄。*/
  closed(): boolean;
  /** 状态读取的返回值（用例可改成失败）。*/
  stateResult: { current: StateResult };
}

interface HarnessOptions {
  /** 挂上事件流**之前**就已经在缓冲里的行（首拍补历史用的）。*/
  lines?: string[];
  /**
   * 把缓冲**直挂**给事件流（`logs`），而不是走 `getLogs` 命令。
   *
   * 这是面板的真实路径：只有直读缓冲才拿得到结构化条目，`getLogs` 命令
   * 的应答形状已钉成字符串。
   */
  directLogs?: boolean;
  /** 状态取数器的返回值（默认成功）。*/
  stateResult?: StateResult;
  /** 请求记录的持有者。给了它，收尾会推 `request` 事件。*/
  requests?: RequestStore;
}

/**
 * 一个挂好的事件流。
 *
 * `lines` / `stateResult` 必须在挂流**之前**给：`openEventStream` 首拍是立刻跑的，
 * 挂完再往缓冲里推的行属于「下一拍」，不是历史。
 */
function harness(options: HarnessOptions = {}): Harness {
  const req = new EventEmitter() as unknown as IncomingMessage;
  const res = new FakeResponse();
  const buffer = new LogBuffer();
  const since: number[] = [];
  const scheduler = manualScheduler();
  const stateResult: { current: StateResult } = {
    current: options.stateResult ?? { ok: true, state: statePayload() },
  };
  for (const line of options.lines ?? []) buffer.push(line);

  const handleControl = async (cmd: ControlCommand): Promise<ControlResponse> => {
    if (cmd.cmd !== "getLogs") return { ok: false, error: "unknown_cmd" };
    const cursor = typeof cmd.since === "number" ? cmd.since : 0;
    since.push(cursor);
    const { nextSince, lines } = buffer.since(cursor);
    return { ok: true, event: "logs", nextSince, lines: [...lines] };
  };

  const stream = openEventStream(req, res.asResponse(), {
    handleControl,
    ...(options.directLogs ? { logs: buffer } : {}),
    ...(options.requests ? { requests: options.requests } : {}),
    readState: async () => stateResult.current,
    scheduler: scheduler.scheduler,
  });

  return {
    req,
    res,
    buffer,
    since,
    scheduler,
    disconnect: () => res.emit("close"),
    closed: () => stream.closed,
    stateResult,
  };
}

/* ------------------------------------------------------------------------- */
/* 响应头与初始帧                                                              */
/* ------------------------------------------------------------------------- */

describe("openEventStream", () => {
  it("opens a text/event-stream response with retry and no caching", async () => {
    const h = harness();
    await settle();

    expect(h.res.status).toBe(200);
    expect(h.res.headers["content-type"]).toContain(SSE_CONTENT_TYPE);
    expect(h.res.headers["content-type"]).toContain("utf-8");
    // 事件流不能被缓存，也不能被反向代理攒着
    expect(h.res.headers["cache-control"]).toBe("no-store");
    expect(h.res.headers["x-accel-buffering"]).toBe("no");

    const retry = h.res.frames().find((frame) => frame.retry !== undefined);
    expect(retry?.retry).toBe(String(SSE_RETRY_MS));
  });

  it("backfills the log buffer on connect, one frame per line", async () => {
    const h = harness({
      lines: [
        "zcode-proxy listening on http://127.0.0.1:8080",
        "[warn] account=payg cooling for 60s",
        "[error] account=work-team upstream 401",
      ],
    });
    await settle();

    const logs = h.res.events(SSE_EVENT_LOG) as { seq: number; level: string; account?: string; line: string }[];
    expect(logs).toHaveLength(3);
    expect(logs.map((entry) => entry.level)).toEqual(["info", "warn", "error"]);
    expect(logs.map((entry) => entry.account)).toEqual([undefined, "payg", "work-team"]);
    expect(logs.map((entry) => entry.line)).toEqual(h.buffer.snapshot().slice());
    // 序号单调（`LogBuffer` 的游标是 0 基），首行序号 = 总序号 - 行数：
    // 客户端据此给重连后重叠的那一段去重。
    expect(logs.map((entry) => entry.seq)).toEqual([0, 1, 2]);
  });

  it("carries a structured `entry` (and keeps `line`) when the buffer is attached", async () => {
    const h = harness({ directLogs: true });
    // 一条 logger 写的条目（有 mod / level / fields）+ 一条 console tee 抓的纯文本行。
    h.buffer.pushEntry(
      { ts: 1_794_000_000_000, level: "debug", mod: "proxy", msg: "stage", fields: { reqId: "#003", stage: "intake", account: "work-team" } },
      "12:04:11 DEBUG [proxy] stage reqId=#003 stage=intake account=work-team",
    );
    h.buffer.push("[warn] legacy line account=payg");
    h.scheduler.tick(LOG_POLL_INTERVAL_MS);
    await settle();

    const logs = h.res.events(SSE_EVENT_LOG) as { seq: number; level: string; account?: string; mod?: string; line: string; entry?: { mod: string; msg: string } }[];
    expect(logs).toHaveLength(2);

    // 结构化那一行：level / account / mod 都来自字段，`line` 仍然在（读字符串的消费者要它）。
    expect(logs[0].level).toBe("debug");
    expect(logs[0].account).toBe("work-team");
    expect(logs[0].mod).toBe("proxy");
    expect(logs[0].entry?.msg).toBe("stage");
    expect(logs[0].line).toBe("12:04:11 DEBUG [proxy] stage reqId=#003 stage=intake account=work-team");

    // 纯文本那一行：没有条目，按前缀与 `account=` 退化解析。
    expect(logs[1].level).toBe("warn");
    expect(logs[1].account).toBe("payg");
    expect(logs[1].mod).toBeUndefined();
    expect(logs[1].entry).toBeUndefined();
  });

  it("logPayloadFor 从条目取 level/account/mod，从文本行退化解析", () => {
    const fromEntry = logPayloadFor({
      seq: 7,
      line: "12:04:11 ERROR [proxy] error kind=upstream_unreachable",
      entry: { seq: 7, ts: 1, level: "error", mod: "proxy", msg: "error", fields: { reqId: "#009" } },
    });
    expect(fromEntry).toMatchObject({ seq: 7, level: "error", mod: "proxy" });
    expect(fromEntry.entry?.msg).toBe("error");

    // 条目里的 `account` 不是字符串（前端渲染的自由字段）时不硬塞进账号过滤键。
    const oddAccount = logPayloadFor({
      seq: 8,
      line: "x",
      entry: { seq: 8, ts: 1, level: "info", mod: "claim", msg: "tick", fields: { account: 42 } },
    });
    expect(oddAccount.account).toBeUndefined();
  });

  it("sends a full state snapshot as one `state` event", async () => {
    const h = harness();
    await settle();

    const states = h.res.events(SSE_EVENT_STATE) as StatePayload[];
    expect(states).toHaveLength(1);
    expect(states[0].server).toMatchObject({ port: 8090, version: "5.0.0" });
    expect(states[0].metrics).toMatchObject({ concurrencyLimit: 8 });
  });
});

/* ------------------------------------------------------------------------- */
/* 节拍：增量日志 / 状态快照 / 心跳                                            */
/* ------------------------------------------------------------------------- */

describe("openEventStream ticks", () => {
  it("polls logs incrementally with the `since` cursor", async () => {
    const h = harness({ lines: ["first"] });
    await settle();
    expect(h.since).toEqual([0]);

    h.buffer.push("second");
    h.scheduler.tick(LOG_POLL_INTERVAL_MS);
    await settle();

    // 第二拍从上一拍的 nextSince 继续，不会把第一行再发一次
    expect(h.since).toEqual([0, 1]);
    const lines = (h.res.events(SSE_EVENT_LOG) as { seq: number; line: string }[]).map((entry) => entry.line);
    expect(lines).toEqual(["first", "second"]);
  });

  it("throttles state snapshots to the state interval", async () => {
    const h = harness();
    await settle();
    expect(h.res.events(SSE_EVENT_STATE)).toHaveLength(1);

    h.scheduler.tick(LOG_POLL_INTERVAL_MS);
    await settle();
    // 日志拍不该带出状态帧
    expect(h.res.events(SSE_EVENT_STATE)).toHaveLength(1);

    h.scheduler.tick(STATE_POLL_INTERVAL_MS);
    await settle();
    expect(h.res.events(SSE_EVENT_STATE)).toHaveLength(2);
  });

  it("keeps the connection alive with a bare comment frame", async () => {
    const h = harness();
    await settle();
    const before = h.res.frames().length;

    h.scheduler.tick(HEARTBEAT_INTERVAL_MS);
    const frames = h.res.frames();
    expect(frames.length).toBe(before + 1);
    // 心跳就是 `:\n\n`：一个注释帧，客户端必须忽略
    expect(frames[frames.length - 1].comment).toBe(true);
    expect(h.res.body.endsWith(":\n\n")).toBe(true);
  });

  it("skips a failed state read without breaking the stream", async () => {
    const h = harness({ stateResult: { ok: false, error: "account_control_unavailable" } });
    await settle();

    // 失败不发帧（页面另有 /api/state 的错误横幅），但日志与心跳照旧
    expect(h.res.events(SSE_EVENT_STATE)).toHaveLength(0);
    h.buffer.push("still alive");
    h.scheduler.tick(LOG_POLL_INTERVAL_MS);
    await settle();
    expect(h.res.events(SSE_EVENT_LOG)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------- */
/* 断开清理                                                                    */
/* ------------------------------------------------------------------------- */

describe("openEventStream cleanup", () => {
  it("clears every timer when the client disconnects", async () => {
    const h = harness();
    await settle();
    expect(h.scheduler.active()).toBe(3);

    h.scheduler.tick(LOG_POLL_INTERVAL_MS);
    await settle();

    h.disconnect();
    expect(h.closed()).toBe(true);
    expect(h.scheduler.active()).toBe(0);

    // 断开后的拍不会再有输出（没有定时器了，这里显式确认一下）
    const written = h.res.chunks.length;
    h.scheduler.tick(LOG_POLL_INTERVAL_MS);
    h.scheduler.tick(STATE_POLL_INTERVAL_MS);
    h.scheduler.tick(HEARTBEAT_INTERVAL_MS);
    await settle();
    expect(h.res.chunks.length).toBe(written);
  });

  it("also stops on the request side closing, and close() is idempotent", async () => {
    const h = harness();
    await settle();

    h.req.emit("close");
    expect(h.scheduler.active()).toBe(0);

    // 重复关闭不会抛，也不会把已取消的定时器"复活"
    h.req.emit("close");
    h.disconnect();
    expect(h.scheduler.active()).toBe(0);
  });

  it("stops when the response errors (broken pipe while writing)", async () => {
    const h = harness();
    await settle();

    h.res.emit("error", new Error("EPIPE"));
    expect(h.closed()).toBe(true);
    expect(h.scheduler.active()).toBe(0);
  });
});

/* ------------------------------------------------------------------------- */
/* 请求收尾事件                                                                */
/* ------------------------------------------------------------------------- */

/** 一条完整的记录（字段按 `proxyRequest` 收尾时会填齐的那些）。*/
function finishedRecord(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    reqId: "#003",
    startedAt: Date.now() - 2890,
    endedAt: Date.now(),
    format: "anthropic",
    model: "glm-5.3-flash",
    stream: true,
    requestBytes: 12480,
    account: "work-team",
    route: "start-plan",
    retries: 0,
    status: 200,
    ttfbMs: 1240,
    totalMs: 2890,
    outputTokens: 179,
    stages: [{ stage: "intake", atMs: 0, fields: { bytes: 12480 } }],
    apiKeyId: "",
    ...overrides,
  };
}

describe("openEventStream — request 事件", () => {
  it("请求收尾后到达一帧 `request`，载荷就是记录本身", async () => {
    const requests = new RequestStore();
    const h = harness({ requests });
    await settle();

    const record = finishedRecord();
    requests.notify(record);

    const frames = h.res.events(SSE_EVENT_REQUEST) as RequestRecord[];
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(record);
    // 一次通知一帧：`RequestStore.notify` 只在收尾触发，不会逐阶段刷屏。
    requests.notify(finishedRecord({ reqId: "#004" }));
    expect(h.res.events(SSE_EVENT_REQUEST)).toHaveLength(2);
  });

  it("没挂 store 时没有 request 帧（只有 dispatcher 的宿主）", async () => {
    const h = harness();
    await settle();
    const requests = new RequestStore();
    requests.notify(finishedRecord());
    expect(h.res.events(SSE_EVENT_REQUEST)).toHaveLength(0);
  });

  it("断开后退订：之后收尾的请求不再往断开的响应里写", async () => {
    const requests = new RequestStore();
    const h = harness({ requests });
    await settle();

    h.disconnect();
    expect(h.closed()).toBe(true);
    requests.notify(finishedRecord());

    expect(h.res.events(SSE_EVENT_REQUEST)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------- */
/* 行解析                                                                      */
/* ------------------------------------------------------------------------- */

describe("log line parsing", () => {
  it("derives the level from the tee prefix the LogBuffer carries", () => {
    expect(logLevelOf("[error] boom")).toBe("error");
    expect(logLevelOf("[warn] careful")).toBe("warn");
    expect(logLevelOf("plain line")).toBe("info");
    // 前缀必须在行首：正文里出现的 `[error]` 不是级别
    expect(logLevelOf("req 12 debug: saw [error] header")).toBe("info");
  });

  it("extracts the account marker when the line carries one", () => {
    expect(logAccountOf("account=work-team inflight=2/2 200")).toBe("work-team");
    expect(logAccountOf("req 1 highspeed card applied (account=payg model=glm-5.3)")).toBe("payg");
    expect(logAccountOf("zcode-proxy listening on :8080")).toBeUndefined();
    // `accounts=` 这类复合词不是账号标记
    expect(logAccountOf("accounts=3 loaded")).toBeUndefined();
  });
});
