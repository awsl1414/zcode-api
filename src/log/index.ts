/**
 * 进程级默认 logger：模块按名字取 logger，配置由入口注入一次。
 *
 * 为什么需要统一 logger：直接写 `console.*` 没有级别、没有模块名、没有结构化字段。
 * 面板只能靠 monkey-patch `console` 抓行，于是第三方库的输出混进缓冲，对象被
 * `join(" ")` 压成 `[object Object]`，`--no-panel` 时缓冲恒空。
 * 统一 logger 把三件事分开：**谁在说**（`mod`）、**说得多重要**（`level`）、
 * **说了什么字段**（`fields`）。终端与面板读的是同一条数据。
 *
 * 为什么这里是**可变**的模块状态：`logger("proxy")` 在模块顶层取一次（每个请求
 * 都造一个新对象没有必要），而级别与缓冲区要等 `serve` 读完配置、装好面板之后才
 * 知道。所以 `logger()` 返回的每个方法在调用时读当前配置，两个时机就解耦了。
 *
 * 注入点（`configureLogging`）由 `server/bootstrap.ts` 调用：
 *
 *   level    `config.logging.level`，`serve debug` 时抬到 `debug`
 *   format   `ZCODE_LOG_FORMAT`
 *   buffer   面板的 `LogBuffer`；`--no-panel` 时不传，日志只写终端
 *
 * 这里不劫持 `console`：logger 走 `process.stdout/stderr.write`，与 console 那层
 * 彻底分开。
 *
 * 请求表格是唯一保留自己格式的日志，它的去向只有终端，并且**只在有终端时写
 * stdout**（`requestLines`，由入口按 `process.stdout.isTTY` 注入），**永不进
 * `LogBuffer`**。表格行若以 `mod: "request"` 落缓冲，面板「系统」tab 的日志流里
 * 就会混进 `#mw7223-053 | …` 这样的表格行——请求信息与运行日志搅在一起。两类数据
 * 各回各家：
 *
 *   运行日志 → `LogBuffer`（系统 tab / getLogs）
 *   请求事实 → `RequestStore`（请求事件 tab / getRequests / requests.jsonl）
 *
 * 不把 `RequestRecord` 塞进 `LogBuffer`，两者并列而不嵌套；无 TTY（serve 带
 * 面板、Docker、后台）时终端根本没有人在看，连 stdout 都不写。
 */
import { LogBuffer } from "./buffer.js";
import { createLogger, resolveLogFormat, writeToStream } from "./logger.js";
import type { LogOutput, LogWrite } from "./logger.js";
import type { LogFormat, LogLevel, Logger } from "./types.js";

/** 默认级别（`config/loader.ts` 的 DEFAULTS 同值：`info`）。*/
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/**
 * 进程级去向。
 *
 * 可变字段由 {@link configureLogging} 写，`logger()` 造出的对象在每次输出时读，
 * 所以运行中改级别对已取到的 logger 立刻生效（面板改配置后不用重启进程）。
 */
const state = {
  level: DEFAULT_LOG_LEVEL as LogLevel,
  format: resolveLogFormat(process.env),
  buffer: undefined as LogBuffer | undefined,
  /**
   * 请求表格行是否写终端。只有看得到终端的运行才开：入口（`bootstrap.ts`）
   * 按 `process.stdout.isTTY` 注入；默认关 = 无 TTY 的
   * headless 部署里表格行既不打 stdout 也不进缓冲。
   */
  requestLines: false,
  now: () => Date.now(),
  write: writeToStream as LogWrite,
};

/** 已经造过的 logger，按模块名缓存（同一模块重复取是同一行为，不重复分配）。*/
const loggers = new Map<string, Logger>();

const output: LogOutput = {
  level: () => state.level,
  format: () => state.format,
  write: (line, level) => state.write(line, level),
  buffer: () => state.buffer,
  now: () => state.now(),
};

/**
 * 按模块取 logger；`mod` 出现在每行的 `[mod]` 里。
 *
 * 模块名用「子系统」粒度（`proxy` / `accounts` / `auth` / `claim`），不是文件名：
 * 面板的模块过滤要的是「这次请求链路 vs 这个后台循环」，一个文件一个模块会把它
 * 变成几十个选项。
 */
export function logger(mod: string): Logger {
  let cached = loggers.get(mod);
  if (!cached) {
    cached = createLogger(mod, output);
    loggers.set(mod, cached);
  }
  return cached;
}

/**
 * 请求日志（一行一次请求）的出口。
 *
 * 表格与 compact 是「一行一次请求」的独立格式，不并入业务日志格式。去向只有终端
 * （见文件头）：`requestLines` 开着时原样写出，**不加时间戳前缀** —— 表格自己有
 * Time 列，加前缀会把列错开。缓冲区永不接收表格行：面板系统 tab 混进请求行就是
 * 那条错路导致的，请求信息在面板上只活在请求事件 tab（数据同源 `RequestStore`）。
 * `getLogs` 的消费者同样不该收到表格行——请求视图走 `getRequests`。
 *
 * 关掉时不写也不报错：无 TTY 的部署里这一行只是静默消失，请求事实仍在
 * `requests.jsonl` 与 `RequestStore` 里。
 */
export function writeRequestLine(line: string): void {
  if (!state.requestLines) return;
  state.write(line, "info");
}

/** `configureLogging` 的补丁。只给要改的字段，其余保持不变。*/
export interface LoggingPatch {
  level?: LogLevel;
  format?: LogFormat;
  /** `undefined` 明确的含义是「没有面板缓冲」，与「不改」用缺省键区分。*/
  buffer?: LogBuffer;
  /** 请求表格行是否写终端：有 TTY 才开，默认关。*/
  requestLines?: boolean;
  now?: () => number;
  write?: LogWrite;
}

/**
 * 注入进程级配置。由 `server/bootstrap.ts` 在读完配置、装好面板之后调用一次；
 * 测试也用它（钉死时钟、换成内存 sink、挂一个 `LogBuffer` 断言条目）。
 */
export function configureLogging(patch: LoggingPatch): void {
  if (patch.level !== undefined) state.level = patch.level;
  if (patch.format !== undefined) state.format = patch.format;
  if (patch.buffer !== undefined) state.buffer = patch.buffer;
  if (patch.requestLines !== undefined) state.requestLines = patch.requestLines;
  if (patch.now !== undefined) state.now = patch.now;
  if (patch.write !== undefined) state.write = patch.write;
}

/** 当前日志阈值（`configureLogging` 的写入点，热重载后的读回断言用）。 */
export function currentLogLevel(): LogLevel {
  return state.level;
}

/**
 * 回到「默认 logger 刚加载时」的样子：级别 `info`、格式随环境变量、无缓冲、写流。
 *
 * 存在的理由只有一个：`bun test` 在同一个进程里跑上百个文件，某个用例改了全局
 * 级别后不还原，会让后面的用例按 `debug` 打满输出（或者反过来全静音）。测试用
 * `afterEach(resetLogging)`，不是生产 API。
 */
export function resetLogging(): void {
  state.level = DEFAULT_LOG_LEVEL;
  state.format = resolveLogFormat(process.env);
  state.buffer = undefined;
  state.requestLines = false;
  state.now = () => Date.now();
  state.write = writeToStream;
}

export { formatLine, levelEnabled, resolveLogFormat } from "./logger.js";
export type { BufferedLog } from "./buffer.js";
export type { LogEntry, LogFields, LogFormat, LogLevel, Logger } from "./types.js";
