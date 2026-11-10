/**
 * 运行时日志行的有界环形缓冲。
 *
 * 日志设施，不是控制面协议：控制面（`control/control.ts`）只通过
 * `HandlerContext.logBuffer` 拿到它，`getLogs` 与 `/events` 的 `log` 事件都读同一个
 * 实例。写入方是 `src/log/index.ts` 的 logger（结构化条目直接进来，终端输出另走
 * 一条路，所以面板拿到的是字段，不再是一行被 `join(" ")` 压平的文本），以及
 * `writeRequestLine`（请求表格那一行，格式归 `handler-log.ts`）。
 *
 * 两种写入都要保留：`push(line)` 收纯文本，`pushEntry(entry)` 收结构化条目。前者
 * 没有 `mod` 与级别字段，面板对它们退化成按前缀猜级别（`routes-events.ts` 的
 * `logLevelOf`）：那是给历史行与任何直接 push 字符串的调用方留的路。
 *
 * 序号单调且与行内容无关：客户端拿 `nextSince` 当游标做增量轮询，重复投递与乱序都
 * 由它兜住。序号由**缓冲**发，不由 logger 发：唯一真源在这里，logger 拿返回的条目。
 */
import type { LogEntry } from "./types.js";

/** 缓冲里的一条记录：文本行总是有，结构化条目只有 logger 写的那部分有。*/
export interface BufferedLog {
  seq: number;
  line: string;
  entry?: LogEntry;
}

/** Bounded ring buffer for runtime log lines with monotonic sequence numbers. */
export class LogBuffer {
  private readonly records: BufferedLog[] = [];
  private readonly capacity: number;
  private nextSeq = 0;

  constructor(capacity = 500) {
    this.capacity = capacity;
  }

  /** 收一行纯文本（没有级别/模块字段的记录，面板对它退化成按前缀猜级别）。*/
  push(line: string): void {
    this.records.push({ seq: this.nextSeq, line });
    this.nextSeq++;
    this.trim();
  }

  /**
   * 收一条结构化条目，返回补齐了 `seq` 的那一份。
   *
   * `line` 用调用方给的终端文本原样存下（`logger.ts` 已经把同一份数据格式化过
   * 一次）：`getLogs` 命令读的还是字符串，不能要求调用方改成解析 JSON。
   */
  pushEntry(entry: Omit<LogEntry, "seq">, line: string): LogEntry {
    const full: LogEntry = { seq: this.nextSeq, ...entry };
    this.records.push({ seq: this.nextSeq, line, entry: full });
    this.nextSeq++;
    this.trim();
    return full;
  }

  private trim(): void {
    if (this.records.length > this.capacity) {
      this.records.splice(0, this.records.length - this.capacity);
    }
  }

  /**
   * Returns lines whose logical sequence number is `>= since`, plus the
   * next-since cursor (use as the next `since` value for incremental polling).
   */
  since(since: number): { nextSince: number; lines: string[] } {
    const { nextSince, records } = this.sliceSince(since);
    return { nextSince, lines: records.map((record) => record.line) };
  }

  /**
   * 与 {@link since} 同游标，但交出记录本身（含结构化条目）。
   *
   * 面板的日志页要按级别与模块过滤，只能读条目；`getLogs` 命令的应答形状已钉住，
   * 仍然只回 `lines`，所以这一条走进程内直读。
   */
  sinceEntries(since: number): { nextSince: number; records: BufferedLog[] } {
    return this.sliceSince(since);
  }

  private sliceSince(since: number): { nextSince: number; records: BufferedLog[] } {
    const baseSeq = Math.max(0, this.nextSeq - this.records.length);
    const wantStart = Math.max(since, baseSeq);
    const offset = wantStart - baseSeq;
    if (offset >= this.records.length) {
      return { nextSince: this.nextSeq, records: [] };
    }
    return { nextSince: this.nextSeq, records: this.records.slice(offset) };
  }

  /** Returns all lines currently in the buffer. */
  snapshot(): readonly string[] {
    return this.records.map((record) => record.line);
  }

  /** Monotonic cursor; safe to expose externally. */
  get cursor(): number {
    return this.nextSeq;
  }
}
