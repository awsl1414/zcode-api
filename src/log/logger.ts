/**
 * logger 的实现：级别过滤、三种格式化、终端输出。
 *
 * 为什么不再劫持 `console`：面板的日志页一度靠 monkey-patch `console.log` 抓行，
 * 那带来三个问题：第三方库（happy-dom 的警告、Bun 的提示）混进缓冲、
 * `args.join(" ")` 把对象压成 `[object Object]`、`--no-panel` 时缓冲恒空。logger
 * 自己把结构化条目写进 `LogBuffer`，终端输出走 `process.stdout/stderr.write`，
 * 与 console 那层噪音解耦。
 *
 * 三种格式的分工：
 *
 *   text     人读的默认形态。`12:04:11 INFO  [proxy] stage reqId=#a1b2-003 ms=2
 *   compact  前缀最短：`12:04:11 I [proxy] …`。一行一次请求的概览、窄终端、日志文件。
 *   json     单行 JSON，字段平铺在顶层。给 grep / jq / 日志采集用，对象字段原样保留。
 *
 * 格式由 `ZCODE_LOG_FORMAT` 选（`json` / `compact`，其余一律 text），级别由
 * `config.yaml` 的 `logging.level` 定（默认 `info`）。两者都是**每次输出时读**，
 * 运行时改级别对已经取到 logger 的模块立刻生效。
 */
import type { LogBuffer } from "./buffer.js";
import type { LogEntry, LogFields, LogFormat, LogLevel, Logger } from "./types.js";

/** 级别从低到高。过滤比较的是这个序，不是字符串。*/
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** 文本格式的级别标签（等宽，`padEnd(LEVEL_LABEL_WIDTH)` 后补一个空格对齐）。*/
const LEVEL_LABEL: Record<LogLevel, string> = { debug: "DEBUG", info: "INFO", warn: "WARN", error: "ERROR" };

/** 紧凑格式的级别字母。*/
const LEVEL_LETTER: Record<LogLevel, string> = { debug: "D", info: "I", warn: "W", error: "E" };

/**
 * 级别标签的固定宽度。
 *
 * 取自最长那个（`DEBUG` / `ERROR`，五个字符）：定宽是为了让 `[mod]` 在连续几十行里
 * 落在同一列，肉眼扫级别时不用逐行找。
 */
const LEVEL_LABEL_WIDTH = 5;

/** `level` 是否达到阈值（`threshold` 及以上才输出）。*/
export function levelEnabled(level: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[threshold];
}

/**
 * `ZCODE_LOG_FORMAT` → 格式。
 *
 * 环境变量的值不是它认识的那两个就按 `text` 处理：写错一个值不该让进程的日志
 * 全部静音或喷成 JSON，那只会让「我明明设了变量」变成一条查不到的线索。
 */
export function resolveLogFormat(env: Record<string, string | undefined> = process.env): LogFormat {
  const raw = env.ZCODE_LOG_FORMAT;
  return raw === "json" || raw === "compact" ? raw : "text";
}

/** 格式化成 `HH:MM:SS`（宿主机时区，与 `handler-log.ts` 的请求行同一口径）。*/
function localClock(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * 一个字段值在文本/紧凑格式里的写法。
 *
 * 对象与数组一律 `JSON.stringify`：`args.join(" ")` 时代它们会变成
 * `[object Object]`，那正是新 logger 要修掉的东西。带空格或等号的字符串加引号，
 * 否则 `msg=a b` 这种值会让人误读成两个字段。
 */
function renderValue(value: unknown): string {
  if (typeof value === "string") {
    return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null) return "null";
  if (value === undefined) return "";
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

/** `k=v k=v` 片段。`undefined` 的键整条省略（与 `JSON.stringify` 同口径）。*/
function renderFields(fields: Record<string, unknown> | undefined): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${renderValue(value)}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/**
 * 错误对象 → 字段。
 *
 * 文本格式只用 `message`（栈是多行的，一行日志里塞不下），JSON 格式保 `name` 与
 * `stack`：查一个「为什么 503」时，栈往往比 message 有用。
 */
function errorFields(err: unknown): Record<string, unknown> | undefined {
  if (err === undefined) return undefined;
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

/** 一条日志 → 终端文本（三种格式的唯一实现点）。*/
export function formatLine(entry: LogEntry, format: LogFormat): string {
  if (format === "json") {
    // 字段平铺在顶层：`{"ts":…,"level":"info","mod":"proxy","msg":"stage",…}`。
    // 不套一层 `fields`，这样 `jq .reqId` 就能取到，采集端不用知道我们的嵌套约定。
    const { ts, level, mod, msg, fields } = entry;
    return JSON.stringify({ ts, level, mod, msg, ...fields });
  }
  const clock = localClock(entry.ts);
  const prefix = format === "compact"
    ? `${clock} ${LEVEL_LETTER[entry.level]} [${entry.mod}]`
    : `${clock} ${LEVEL_LABEL[entry.level].padEnd(LEVEL_LABEL_WIDTH)} [${entry.mod}]`;
  return `${prefix} ${entry.msg}${renderFields(entry.fields)}`;
}

/** 终端去向。级别决定流：`warn` / `error` 走 stderr，其余走 stdout。*/
export type LogWrite = (line: string, level: LogLevel) => void;

/** 默认终端去向：直接写流，绕过 console（面板的 tee 抓不到，避免重复入缓冲）。*/
export const writeToStream: LogWrite = (line, level) => {
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

/**
 * 一处日志的去向与当前配置。`index.ts` 持有一个可变的实现，`logger()` 的每个方法
 * 在**调用时**读它，所以运行时改级别 / 挂上缓冲区对已经取到的 logger 立即生效。
 */
export interface LogOutput {
  level(): LogLevel;
  format(): LogFormat;
  write: LogWrite;
  /** 结构化条目的落点。`undefined` = 没有面板（`--no-panel`），只写终端。*/
  buffer?(): LogBuffer | undefined;
  /** 时钟。测试可以钉死，让 `time` 断言不靠真实时间。*/
  now(): number;
}

/** 按模块造一个 logger。同一个模块重复调用得到行为一致的对象（轻量，不做缓存）。*/
export function createLogger(mod: string, output: LogOutput): Logger {
  const emit = (level: LogLevel, msg: string, fields: LogFields | undefined, err?: unknown): void => {
    if (!levelEnabled(level, output.level())) return;
    const merged: Record<string, unknown> = { ...fields };
    if (err !== undefined) merged.err = errorFields(err);
    const ts = output.now();
    const format = output.format();
    // 同一条数据格式化一次，两处一起用：缓冲里存下的文本行就是终端上那一行
    // （`getLogs` 的消费者读 `lines`，不能要求它们解析 JSON），面板读条目做过滤。
    const body: Omit<LogEntry, "seq"> = { ts, level, mod, msg, fields: merged };
    const line = formatLine({ seq: 0, ...body }, format);
    output.buffer?.()?.pushEntry(body, line);
    output.write(line, level);
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields, err) => emit("error", msg, fields, err),
  };
}
