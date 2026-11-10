/**
 * 日志的类型面：级别、字段、条目、logger 接口。
 *
 * 为什么单独一个文件：`buffer.ts`（环形缓冲）只认 `LogEntry`，`logger.ts`（格式化）
 * 只认 `LogFields`，而 `index.ts`（进程级默认 logger）两者都要用。类型放在最底层，
 * 三个模块之间不会为了一个 interface 互相 import 实现。
 *
 * `LogFields` 有几个具名字段（`reqId` / `account` / `route` / `status` /
 * `durationMs`）：它们是被面板过滤、被 `logs` 子命令按请求聚合的键，写错一个字母
 * 就等于丢了一维检索条件，所以类型上钉住。其余键开放，模块可以带自己的上下文
 * （`stage` / `cardId` / `signed` …），但**阶段打点的字段名是全仓同一张表**：日志页
 * 的筛选器、`request-record.ts` 的时间线与阶段摘要都按 stage 名和字段名取值，新增
 * 阶段或改字段名要先看这三处消费方。
 */

/** 四个级别，由低到高。`config.yaml` 的 `logging.level` 取其一。*/
export type LogLevel = "debug" | "info" | "warn" | "error";

/** 一条日志的字段。具名的是检索键，其余是模块自带的上下文。*/
export interface LogFields {
  account?: string;
  route?: string;
  reqId?: string;
  status?: number;
  durationMs?: number;
  [key: string]: unknown;
}

/** 落进 `LogBuffer` 的结构化条目（面板按字段过滤，不再 parse 文本行）。*/
export interface LogEntry {
  seq: number;
  /** Unix 毫秒。文本格式渲染成 `HH:MM:SS`，JSON 格式原样保留数字。*/
  ts: number;
  level: LogLevel;
  /** 模块名，出现在每行的 `[mod]` 里（`proxy` / `accounts` / `claim` …）。*/
  mod: string;
  msg: string;
  fields?: Record<string, unknown>;
}

/** 三种输出格式，来源是 `ZCODE_LOG_FORMAT`（见 `logger.ts::resolveLogFormat`）。*/
export type LogFormat = "text" | "compact" | "json";

/**
 * 一个模块的 logger。
 *
 * 四个方法都按 `logging.level` 过滤，过滤发生在**格式化之前**：被滤掉的调用不
 * 拼字符串，也不写缓冲区。
 *
 * `error` 多一个 `err` 参数：错误对象不是字段（它的栈是多行的），单独走一条通道，
 * 这样文本格式里能压成一行，JSON 格式里能保住栈。
 */
export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields, err?: unknown): void;
}
