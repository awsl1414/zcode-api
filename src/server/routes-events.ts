/**
 * `GET /api/events`：面板的 SSE 事件流。
 *
 * 两条事件：
 *
 *   event: log     data: { seq, level, account?, line }   一行运行日志
 *   event: state   data: <StatePayload>                   整份状态快照（节流）
 *
 * **不新起一套采集**（任务硬约束）。两个来源都是既有的取数函数，本模块只做搬运：
 *
 *   log   ← `getLogs` 命令（`LogBuffer.since()` 的增量游标，`src/control/control.ts`），
 *           也就是 `console.log` 的 tee 缓冲；面板与 CLI 读的是同一份
 *   state ← `createStateReader()`（`src/server/routes-state.ts`，一次读四个只读命令）
 *
 * 为什么 state 发整份快照而不是增量：`/api/state` 的载荷已经是从命令聚合出来的
 * 派生量（健康、在飞、额度），增量要维护"哪一段变了"的影子状态，而服务端并没有
 * 这样一份状态可对照；那样做等于把生效值的三方合成再实现一遍（`routes-state.ts`
 * 文件头拒绝过一次）。节流版整份快照的代价是每拍几 KB，换来的是"页面看到的永远是
 * 同一份真值"。
 *
 * 生命周期（这是本模块唯一属于自己的状态）：一个连接 = 三个定时器 + 一个日志游标。
 * `close()` 幂等，客户端断开（`req`/`res` 的 `close`）时全部清掉，**不留定时器**
 * （进程退出也不能被 SSE 的 ticker 挂住：所有定时器 `unref()`）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlCommand, ControlResponse } from "../control/control.js";
import type { BufferedLog, LogBuffer } from "../log/buffer.js";
import type { LogEntry } from "../log/types.js";
import type { RequestStore } from "../proxy/request-record.js";
import type { StateResult } from "./routes-state.js";

/** `content-type`：SSE 的唯一正确值（连同 `charset` 一起给，避免浏览器猜）。*/
export const SSE_CONTENT_TYPE = "text/event-stream";

/**
 * 事件名。页面的 `switch` 与这里的常量必须一一对应（只认这两个）。
 *
 * `request` 是第三个事件：载荷是一条 `RequestRecord`。
 */
export const SSE_EVENT_LOG = "log";
export const SSE_EVENT_STATE = "state";
export const SSE_EVENT_REQUEST = "request";

/**
 * 心跳注释间隔。
 *
 * 15s 的来源是「连接不要被中间设备掐掉」：反向代理与内核的 TCP 空闲超时常见的
 * 起点是 60s，四分之一个周期足够安全，又不会让每连接产生无意义的流量。
 */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * 日志增量轮询间隔。
 *
 * 1s 是「人能察觉到的即时」与「不值得更密」的交界：`LogBuffer.since()` 是一次内存
 * 数组切片，成本可忽略，而更密只会让同一行分多拍发出（人类读不过来）。
 */
export const LOG_POLL_INTERVAL_MS = 1_000;

/**
 * 状态快照的节流间隔。
 *
 * 5s 与页面既有的 `/api/state` 轮询（`app.js` 的 `POLL_INTERVAL_MS`）同拍：两条
 * 通路读的是同一个取数器，间隔不同只会让页面的数字来回跳。
 */
export const STATE_POLL_INTERVAL_MS = 5_000;

/**
 * `retry:` 帧的毫秒值（SSE 标准字段）。
 *
 * 内置页面用 `fetch` 自己控制退避（它要带 `Authorization` 头，`EventSource` 给不了），
 * 这个字段是给任何**标准** SSE 客户端的：断线后按 3s 重连，而不是浏览器默认的 3s
 * 之外的实现细节。
 */
export const SSE_RETRY_MS = 3_000;

/**
 * 心跳注释行（SSE 里以 `:` 开头的行就是注释，客户端必须忽略）。
 *
 * 帧尾是两个换行：一个 `:\n` 只是半帧，客户端的行解析器会一直等下去。
 */
const SSE_COMMENT_FRAME = ":\n\n";

/** 日志级别（语义色的三档，再加 `debug`；`log` 事件的 `level` 字段取值）。*/
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * 文本行前缀 → 级别。
 *
 * 只用于**没有结构化条目**的记录（`LogBuffer.push()` 收的纯文本）：console 镜像的
 * 形态（`console.error` 补 `[error] `、`console.warn` 补 `[warn] `）。logger 写的行
 * 都有条目，走 `entry.level`，这条退化路径只留给历史行与
 * 任何直接 push 字符串的调用方。
 *
 * 这是**唯一**一处级别知识，浏览器只消费 `level` 字段，不再自己解析前缀。
 */
const LOG_LEVEL_PREFIXES: readonly (readonly [string, LogLevel])[] = [
  ["[error] ", "error"],
  ["[warn] ", "warn"],
];

/**
 * 日志行里的账号标记：`account=<label>`。
 *
 * 约定来自既有日志（`proxy/handler.ts` 的 `account=${lease.account.label}`、
 * `highspeed/slots.ts` 的 `account=${account.label}`）。取到就带上，取不到就省略。
 * 没有账号的全局日志（启动、加载配置）本来就是全局的，不该硬塞一个账号。
 */
const LOG_ACCOUNT_PATTERN = /(?:^|[\s(])account=([^\s,)]+)/;

/** 从一行日志里取级别；不带前缀的一律 info。*/
export function logLevelOf(line: string): LogLevel {
  for (const [prefix, level] of LOG_LEVEL_PREFIXES) {
    if (line.startsWith(prefix)) return level;
  }
  return "info";
}

/** 从一行日志里取账号标记；没有就返回 `undefined`（JSON 里整键省略）。*/
export function logAccountOf(line: string): string | undefined {
  const match = LOG_ACCOUNT_PATTERN.exec(line);
  return match ? match[1] : undefined;
}

/** 一条 `log` 事件的载荷。`seq` 是 `LogBuffer` 的单调序号（客户端去重/排序用）。*/
export interface LogEventPayload {
  seq: number;
  level: LogLevel;
  /** 省略（不是空串）表示这行日志不与某个账号绑定。*/
  account?: string;
  /** 模块名（`proxy` / `accounts` …）。只有结构化条目知道它，纯文本行没有。*/
  mod?: string;
  /**
   * 渲染好的文本行。
   *
   * 保留它是因为 `getLogs` 命令读的是字符串：改成结构化条目是一次破坏性协议
   * 改动，那一侧要跟着发版。页面两者都有时优先读 `entry`。
   */
  line: string;
  /** 结构化条目。logger 写的行才有；`LogBuffer.push()` 的纯文本行没有。*/
  entry?: LogEntry;
}

/**
 * 一条缓冲记录 → 一帧 `log` 事件。
 *
 * 级别/账号优先从条目取（那是字段），没有条目才退回解析文本行（历史行、以及任何
 * 直接 `push()` 字符串的调用方只有字符串）。两条路径的 `level` 与 `account` 语义
 * 必须一致，否则页面上的过滤器会在新旧日志上表现不一样。
 */
export function logPayloadFor(record: BufferedLog): LogEventPayload {
  const entry = record.entry;
  const level: LogLevel = entry ? entry.level : logLevelOf(record.line);
  const account = entry
    ? (typeof entry.fields?.account === "string" ? entry.fields.account : undefined)
    : logAccountOf(record.line);
  const payload: LogEventPayload = { seq: record.seq, level, line: record.line };
  /* 整键省略而不是 `account: undefined`：`JSON.stringify` 会丢掉 undefined，
     但类型上也保持一致：「这行不属于任何账号」是一条信息，不是空字符串。*/
  if (account !== undefined) payload.account = account;
  if (entry) {
    payload.mod = entry.mod;
    payload.entry = entry;
  }
  return payload;
}

/**
 * 定时器注入点。
 *
 * 生产走 {@link SYSTEM_SCHEDULER}；测试注入一个手动推进的调度器，这样「一拍」是
 * 确定的，不用等真实时间，也不用假时钟去骗 `setInterval`。
 */
export interface IntervalScheduler {
  /** 每 `ms` 毫秒跑一次 `fn`；返回取消函数。*/
  every(ms: number, fn: () => void): () => void;
}

/**
 * 默认调度器：`setInterval` + **`unref()`**。
 *
 * `unref()` 是硬要求：SSE 的 ticker 只服务于一个已经连上的浏览器，进程该退出时
 * 不能因为它多活（与 `claim/`、`highspeed/` 的后台定时器同一口径）。
 */
export const SYSTEM_SCHEDULER: IntervalScheduler = {
  every(ms: number, fn: () => void): () => void {
    const timer = setInterval(fn, ms);
    timer.unref();
    return () => clearInterval(timer);
  },
};

/** 取数器：与 `panel.ts` 的 `ControlDispatcher` 同形（此处独立声明避免循环导入）。*/
export type EventsDispatcher = (cmd: ControlCommand) => Promise<ControlResponse>;

export interface EventStreamOptions {
  /** `getLogs` 的入口（进程内 dispatcher，与 `/api/control` 同一份）。*/
  handleControl: EventsDispatcher;
  /**
   * 进程内的日志缓冲。
   *
   * 给了它就直读条目（面板要按 `level` / `mod` / `account` 过滤，只有字段能做到）；
   * 不给则退回 `getLogs` 的纯文本行，那条路保留给「只有 dispatcher」的调用方
   * （测试、以及任何将来不装面板的宿主）。
   */
  logs?: LogBuffer;
  /**
   * 请求记录。给了它，每次请求收尾推一帧 `request` 事件。
   *
   * 事件源是 `RequestStore.onChange` 而不是轮询：`notify` 本来就是一次内存广播，
   * 再给 SSE 造一个「有没有新记录」的游标等于自己把变更通知重写一遍。
   */
  requests?: RequestStore;
  /** `/api/state` 的取数器（同一个实例：并发曲线的采样要跨请求累积）。*/
  readState: () => Promise<StateResult>;
  /** 定时器注入点（测试用）。*/
  scheduler?: IntervalScheduler;
}

/** 一个已挂上的事件流。`close()` 幂等。*/
export interface EventStream {
  close(): void;
  readonly closed: boolean;
}

/**
 * `control.ts` 把「命令 → 应答变体」的对应关系放在未导出的联合里。这里只镜像
 * `getLogs` 那一个变体，把 `ok: true` 的宽联合收窄到具体形状；不做运行时字段校验，
 * 协议保证的东西再查一遍就是不可达的兜底分支。
 */
type LogsReply = { ok: true; event: "logs"; nextSince: number; lines: string[] };

/** 写一帧 `event:` + `data:`（JSON 单行：`data` 里不能出现裸换行，否则会被拆帧）。*/
function writeEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * 挂上一个事件流：写响应头、推一帧初始状态、按三个节拍持续发送。
 *
 * 返回的句柄由调用方（`panel.ts`）持有，但触发清理的是 `req` / `res` 的
 * `close` 事件：客户端断开的那一刻，Node 比调用方更早知情。
 */
export function openEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  options: EventStreamOptions,
): EventStream {
  const scheduler = options.scheduler ?? SYSTEM_SCHEDULER;

  res.writeHead(200, {
    "content-type": `${SSE_CONTENT_TYPE}; charset=utf-8`,
    "cache-control": "no-store",
    // 反向代理默认会攒够一块再转发；显式关掉它，事件才能一行一行到浏览器。
    "x-accel-buffering": "no",
    connection: "keep-alive",
  });
  res.write(`retry: ${SSE_RETRY_MS}\n\n`);

  let closed = false;
  /** `LogBuffer` 的增量游标（0 = 连接时先补上缓冲区里的历史行）。*/
  let logCursor = 0;

  /**
   * 一次日志增量。
   *
   * `closed` 的判断是**可达**的，不是兜底：一拍已经进了 `await`，客户端在等待期间
   * 断开时 `close()` 会先跑，随后这个 `await` 恢复；不拦这一下就会往断开的响应
   * 里写。
   */
  async function pollLogs(): Promise<void> {
    if (closed) return;
    if (options.logs) {
      const { nextSince, records } = options.logs.sinceEntries(logCursor);
      if (closed) return;
      for (const record of records) writeEvent(res, SSE_EVENT_LOG, logPayloadFor(record));
      logCursor = nextSince;
      return;
    }
    const reply = await options.handleControl({ cmd: "getLogs", since: logCursor });
    if (closed || !reply.ok) return;
    const logs = reply as LogsReply;
    /* `since(cursor)` 回的是"序号 ≥ cursor 的行"，首行的序号就是总序号减去行数：
       这个偏移让每行都带上自己的 `seq`，客户端据此去重（重连后可能重叠一段）。*/
    const firstSeq = logs.nextSince - logs.lines.length;
    for (let index = 0; index < logs.lines.length; index++) {
      const line = logs.lines[index];
      const payload: LogEventPayload = { seq: firstSeq + index, level: logLevelOf(line), line };
      const account = logAccountOf(line);
      /* 整键省略而不是 `account: undefined`：`JSON.stringify` 会丢掉 undefined，
         但类型上也保持一致：「这行不属于任何账号」是一条信息，不是空字符串。*/
      if (account !== undefined) payload.account = account;
      writeEvent(res, SSE_EVENT_LOG, payload);
    }
    logCursor = logs.nextSince;
  }

  /** 一份状态快照；读失败就不发（页面另有 `/api/state` 的错误横幅，流不重复造一套）。*/
  async function pollState(): Promise<void> {
    if (closed) return;
    const result = await options.readState();
    if (closed || !result.ok) return;
    writeEvent(res, SSE_EVENT_STATE, result.state);
  }

  function heartbeat(): void {
    if (closed) return;
    res.write(SSE_COMMENT_FRAME);
  }

  function close(): void {
    if (closed) return;
    closed = true;
    stopRequests();
    stopLogs();
    stopState();
    stopHeartbeat();
  }

  /*
   * 请求收尾：一帧 `request`，载荷就是 `RequestRecord` 本身。
   *
   * 订阅而不是轮询：`notify` 本来就只在收尾发生一次，再造一个「有没有新记录」的
   * 游标等于把变更通知重写一遍。断开后仍可能有一两个在飞请求走到 `notify`，所以
   * 回调里还要看 `closed`：往断开的响应里写会抛 EPIPE。
   */
  const stopRequests = options.requests
    ? options.requests.onChange((record) => {
        if (closed) return;
        writeEvent(res, SSE_EVENT_REQUEST, record);
      })
    : () => {};

  /* 四个节拍：请求事件 / 日志增量 / 状态快照 / 心跳注释。取消函数交给 `close()`。*/
  const stopLogs = scheduler.every(LOG_POLL_INTERVAL_MS, () => void pollLogs());
  const stopState = scheduler.every(STATE_POLL_INTERVAL_MS, () => void pollState());
  const stopHeartbeat = scheduler.every(HEARTBEAT_INTERVAL_MS, heartbeat);

  /* 首拍立即发：连上就能看到缓冲区里的日志与当前状态，而不是先等 1s / 5s。*/
  void pollLogs();
  void pollState();

  req.on("close", close);
  res.on("close", close);
  /* 断开的 socket 再写会抛 EPIPE；没有监听器时那是个未捕获错误（真的会崩进程）。*/
  res.on("error", close);

  return {
    close,
    get closed(): boolean {
      return closed;
    },
  };
}
