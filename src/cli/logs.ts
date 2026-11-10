/**
 * `zcode-proxy logs` — 按请求追溯一次请求的完整时间线。
 *
 * 三条用法：
 *
 *   zcode-proxy logs --req '#a1b2-003'   这一次请求的全部阶段
 *   zcode-proxy logs --last 10      最近 10 次请求的一行摘要
 *   zcode-proxy logs --failed       只列失败的，带失败阶段
 *
 * 默认数据源是 `requests.jsonl`（`proxy/request-log.ts`）：一行一条
 * `RequestRecord`，常开、只有统计字段。CLI 是独立进程，读不到 `serve` 进程里的
 * `RequestStore`，也不该为此开一个控制面端口去搬内存；落一份文件让读取方直接读。
 *
 * `--file <path>` 仍然读 dump（`proxy/dump.ts` 的 JSONL）。两者用途不同：
 *
 *   requests.jsonl   常开，一次请求一条：状态码、耗时、阶段名与统计字段
 *   dump             `ZCODE_DUMP_UPSTREAM` 开启时才有，一个阶段一行，含完整报文
 *
 * 所以默认路径是前者，要看请求体才显式给 `--file`。两条来源的阶段名共用一套词表
 * （`intake` / `dispatch` / `upstream-req` / `upstream-resp` / `stream-end` …），
 * 读出来的时间线可以互相对照。
 *
 * 读取都不连运行中的进程：CLI 读文件，两个进程之间没有通路。
 */
import { readFileSync } from "node:fs";
import type { RequestRecord, RequestStage } from "../proxy/request-record.js";
import { REQUEST_STORE_CAPACITY, UNKNOWN_MODEL } from "../proxy/request-record.js";
import { readRequestRecords, requestLogPath } from "../proxy/request-log.js";
import { cliFailure, flagValue, splitFlagArgs } from "./control.js";
import { printUsageError } from "./shared.js";
import { errorUserLine } from "./error-words.js";
import { isErrorCode } from "../proxy/error-codes.js";

/** dump 文件里的一行。`phase` 之外全是该阶段的字段。*/
export interface DumpLine {
  ts: string;
  reqId: string;
  phase: string;
  [key: string]: unknown;
}

/** 一次请求的摘要（`--last` / `--failed` 的一行）。两种数据源共用这个形状。*/
export interface RequestSummary {
  reqId: string;
  /** 首行的时间戳原文（ISO）。*/
  startedAt: string;
  model?: string;
  status?: number;
  ttfbMs?: number;
  totalMs?: number;
  tokens?: number;
  /**
   * 失败发生在哪个阶段。缺省 = 这次请求没有失败。
   *
   * dump 来源：判定优先看上游状态码（`upstream-resp` / `stream-end` 的 `status`），
   * 没有上游应答时取最后出现的那个阶段，它就是断点。记录来源：直接读
   * `RequestRecord.failedStage`，那是 handler 的 `failStage` 写下的同一件事。
   */
  failedPhase?: string;
  /** 一句话原因（状态码，或「没有上游应答」）；detail 原文，不是用户词。*/
  failure?: string;
  /** 产生点落下的 errorCode → 用户词 + hint（面板 i18n 的 CLI 侧消费层）。*/
  errorUserLine?: string;
  /**
   * 上游被尝试了几次（`RequestRecord.upstreamAttempts`）。缺省 = 旧记录或
   * 没走到出线；> 1 时摘要行会额外打一个 `attempts=`。
   */
  attempts?: number;
  /** 客户端自己断开（与「上游失败」不同的失败归属）。*/
  aborted?: boolean;
}

/** 摘要行里字段值的截断长度（`--req` 的详细视图另有口径）。*/
const SUMMARY_FIELD_CHARS = 120;

/**
 * 解析 JSONL。坏行整行跳过。
 *
 * 有意吞错：dump 是排障产物，进程被杀时最后一行常常只写了一半；为了一行
 * 截断的 JSON 让整个命令报错，等于在最需要它的时候不可用。`request-log.ts` 的读取
 * 用同一套判据。
 */
export function parseDump(text: string): DumpLine[] {
  const out: DumpLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isDumpLine(parsed)) continue;
      out.push(parsed);
    } catch {
      // 见上：半行 / 非 JSON 行跳过。
    }
  }
  return out;
}

function isDumpLine(value: unknown): value is DumpLine {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.ts === "string" && typeof record.reqId === "string" && typeof record.phase === "string";
}

/**
 * 按 `reqId` 分组，保持**首次出现**的顺序。
 *
 * 时间顺序不靠排序：dump 是 append-only 的，写入顺序就是发生顺序，而 ISO 时间戳只
 * 精确到毫秒，同一毫秒内的几条重排会把「先 intake 后 upstream-resp」打乱。
 */
export function groupByRequest(lines: readonly DumpLine[]): Map<string, DumpLine[]> {
  const groups = new Map<string, DumpLine[]>();
  for (const line of lines) {
    const existing = groups.get(line.reqId);
    if (existing) existing.push(line);
    else groups.set(line.reqId, [line]);
  }
  return groups;
}

/** 从一行里取数字字段（dump 的字段是 `unknown`）。*/
function numberOf(line: DumpLine | undefined, key: string): number | undefined {
  const value = line?.[key];
  return typeof value === "number" ? value : undefined;
}

/** 从 `intake` / `upstream-req` 的 body 里取 model（dump 已经把 JSON 解析回来了）。*/
function modelOf(lines: readonly DumpLine[]): string | undefined {
  for (const line of lines) {
    const body = line.body;
    if (typeof body === "object" && body !== null) {
      const model = (body as Record<string, unknown>).model;
      if (typeof model === "string") return model;
    }
  }
  return undefined;
}

/** dump 的分组 → 摘要。*/
export function summarizeRequest(reqId: string, lines: readonly DumpLine[]): RequestSummary {
  const summary: RequestSummary = { reqId, startedAt: lines[0]?.ts ?? "" };
  const model = modelOf(lines);
  if (model !== undefined) summary.model = model;

  // 阶段名与 logger 的 stage 一致；`upstream-req` 会出现两次（改写过一次、上线又一次），
  // 这里只关心上游有没有应答，所以只找 `upstream-resp` / `stream-end`。
  const upstreamIn = lines.find((line) => line.phase === "upstream-resp");
  const streamSummary = lines.find((line) => line.phase === "stream-end");
  const status = numberOf(upstreamIn, "status") ?? numberOf(streamSummary, "status");
  if (status !== undefined) summary.status = status;
  const ttfbMs = numberOf(upstreamIn, "ttfbMs") ?? numberOf(streamSummary, "ttfbMs");
  if (ttfbMs !== undefined) summary.ttfbMs = ttfbMs;
  const totalMs = numberOf(streamSummary, "totalMs");
  if (totalMs !== undefined) summary.totalMs = totalMs;
  const tokens = numberOf(streamSummary, "tokensObserved");
  if (tokens !== undefined) summary.tokens = tokens;

  if (status !== undefined && status >= 400) {
    summary.failedPhase = upstreamIn ? "upstream-resp" : "stream-end";
    summary.failure = `HTTP ${status}`;
  } else if (status === undefined) {
    // 没有上游应答：断点就是最后记下的那个阶段（可能是 intake，也可能是
    // upstream-req，后者说明请求已经构造好但没发出去）。
    const last = lines[lines.length - 1];
    summary.failedPhase = last?.phase ?? "intake";
    summary.failure = "no upstream response";
  }
  return summary;
}

/**
 * `RequestRecord` → 摘要。
 *
 * 字段来源是处理过程中填进去的那几个，不需要再判断「断在哪一步」：`failedStage`
 * 就是 handler 的 `failStage` 记下的位置。
 */
export function summarizeRecord(record: RequestRecord): RequestSummary {
  const summary: RequestSummary = {
    reqId: record.reqId,
    startedAt: new Date(record.startedAt).toISOString(),
  };
  if (record.model !== UNKNOWN_MODEL) summary.model = record.model;
  if (record.status !== undefined) summary.status = record.status;
  if (record.ttfbMs !== undefined) summary.ttfbMs = record.ttfbMs;
  if (record.totalMs !== undefined) summary.totalMs = record.totalMs;
  if (record.outputTokens !== undefined) summary.tokens = record.outputTokens;
  // 重试率/断连归属在摘要行上只打「异常值」：`1` 次尝试是常态，打出来只会
  // 把每一行都变长；`aborted` 是排障的第一问，所以总是打。
  if (typeof record.upstreamAttempts === "number" && record.upstreamAttempts > 1) {
    summary.attempts = record.upstreamAttempts;
  }
  if (record.clientAborted === true) summary.aborted = true;
  if (record.failedStage !== undefined) {
    summary.failedPhase = record.failedStage;
    summary.failure = record.error
      ?? (record.status !== undefined ? `HTTP ${record.status}` : "no upstream response");
    // 旧记录缺 errorCode → `other`（诚实兜底，不猜 error 文案）。
    summary.errorUserLine = errorUserLine(isErrorCode(record.errorCode) ? record.errorCode : "other");
  }
  return summary;
}

/** ISO 时间戳 → `HH:MM:SS`（与 logger 的文本格式同一口径）。*/
function clockOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** 一个字段值的展示形态：长值截断，对象压成一行 JSON。*/
function renderValue(value: unknown, limit = SUMMARY_FIELD_CHARS): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "";
  return text.length <= limit ? text : `${text.slice(0, limit)}…(${text.length} chars)`;
}

/** dump 的 `--req` 一行：`12:04:11 intake model=glm-4.6 …`。*/
export function formatTimelineLine(line: DumpLine): string {
  const parts: string[] = [clockOf(line.ts), line.phase];
  for (const [key, value] of Object.entries(line)) {
    if (key === "ts" || key === "reqId" || key === "phase") continue;
    if (value === undefined) continue;
    parts.push(`${key}=${renderValue(value)}`);
  }
  return parts.join(" ");
}

/** `--last` / `--failed` 的一行摘要。两种数据源共用。*/
export function formatSummaryLine(summary: RequestSummary): string {
  const parts = [summary.reqId, clockOf(summary.startedAt)];
  if (summary.model !== undefined) parts.push(summary.model);
  parts.push(summary.status !== undefined ? String(summary.status) : "no-response");
  if (summary.ttfbMs !== undefined) parts.push(`ttfb=${summary.ttfbMs}ms`);
  if (summary.totalMs !== undefined) parts.push(`total=${summary.totalMs}ms`);
  if (summary.tokens !== undefined) parts.push(`${summary.tokens}tok`);
  if (summary.attempts !== undefined) parts.push(`attempts=${summary.attempts}`);
  if (summary.aborted === true) parts.push("client-aborted");
  if (summary.failedPhase !== undefined) {
    parts.push(`failed=${summary.failedPhase}`, `reason=${summary.failure ?? "-"}`);
    if (summary.errorUserLine !== undefined) parts.push(`error=${summary.errorUserLine}`);
  }
  return parts.join(" ");
}

/**
 * 记录来源的 `--req` 头部：`#a1b2-003 12:04:11 anthropic glm-5.3-flash 200 …`。
 *
 * 摘要行不满足这里的需求：看时间线的人要先知道这次请求走的是哪条协议、归到哪个
 * 账号、哪个路由，那些字段在摘要里没有位置。
 */
export function formatRecordHead(record: RequestRecord): string {
  const parts = [record.reqId, clockOf(new Date(record.startedAt).toISOString()), record.format];
  if (record.model !== UNKNOWN_MODEL) parts.push(record.model);
  parts.push(record.status !== undefined ? String(record.status) : "no-response");
  if (record.account !== undefined) parts.push(`account=${record.account}`);
  if (record.route !== undefined) parts.push(`route=${record.route}`);
  if (record.stream) parts.push("stream");
  // 详细视图新增的五项（`--req` 是「这一次请求到底经历了什么」，它们各有消费者
  // 但都不在摘要行上：强度/重试/排队/字节）。省略而不是打 `-` 的口径与其余字段一致。
  if (record.reasoningEffort !== undefined) parts.push(`effort=${record.reasoningEffort}`);
  if (typeof record.upstreamAttempts === "number") parts.push(`attempts=${record.upstreamAttempts}`);
  if (typeof record.queueMs === "number") parts.push(`queue=${record.queueMs}ms`);
  if (typeof record.requestBytes === "number" && record.requestBytes > 0) parts.push(`req=${record.requestBytes}B`);
  if (typeof record.responseBytes === "number") parts.push(`resp=${record.responseBytes}B`);
  if (record.ttfbMs !== undefined) parts.push(`ttfb=${record.ttfbMs}ms`);
  if (record.totalMs !== undefined) parts.push(`total=${record.totalMs}ms`);
  if (record.outputTokens !== undefined) parts.push(`${record.outputTokens}tok`);
  if (record.clientAborted === true) parts.push("client-aborted");
  if (record.failedStage !== undefined) {
    parts.push(`failed=${record.failedStage}`);
    parts.push(`error=${errorUserLine(isErrorCode(record.errorCode) ? record.errorCode : "other")}`);
  }
  return parts.join(" ");
}

/**
 * 记录来源的一个阶段：`12:04:11 +18ms dispatch account=… route=…`。
 *
 * `atMs` 是相对请求开始的毫秒数（`addStage` 算好的），它才是「这一步花了多久」的
 * 直接答案；`clockOf` 只是让多个请求的时间线能对到同一根钟上。
 */
export function formatStageLine(record: RequestRecord, stage: RequestStage): string {
  const parts: string[] = [
    clockOf(new Date(record.startedAt).toISOString()),
    `+${stage.atMs}ms`,
    stage.stage,
  ];
  for (const [key, value] of Object.entries(stage.fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${renderValue(value)}`);
  }
  return parts.join(" ");
}

/** `--req` 从记录渲染的完整视图（头 + 每个阶段一行）。*/
export function formatRecordTimeline(record: RequestRecord): string[] {
  const lines = [formatRecordHead(record)];
  for (const stage of record.stages) lines.push(`  ${formatStageLine(record, stage)}`);
  return lines;
}

/**
 * 显式给的 dump 文件。
 *
 * 三种返回：路径（给了 `--file <path>`）、`null`（没给，调用方用默认的
 * `requests.jsonl`）、`{ error }`（给了 `--file` 却没跟值）。中间那个 `null` 是
 * 关键：它表示「这次不读 dump」，而不是「读失败」。
 */
export function resolveDumpFile(args: readonly string[]): string | null | { error: string } {
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--file") continue;
    const value = flagValue(args, index + 1);
    if (value === null) return { error: "--file needs a path" };
    return value;
  }
  return null;
}

/** 三条子命令之一。`--last` 的条数与 `--req` 的 id 在这里就校验掉。*/
export type LogsQuery =
  | { kind: "req"; reqId: string }
  | { kind: "last"; count: number }
  | { kind: "failed" };

/** 参数 → 查询。不合法时回 `{ error }`，调用方负责打印用法。*/
export function parseLogsQuery(args: readonly string[]): { query: LogsQuery } | { error: string } {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--req") {
      const reqId = flagValue(args, index + 1);
      if (reqId === null) return { error: "--req needs a request id (for example #a1b2-003)" };
      return { query: { kind: "req", reqId } };
    }
    if (arg === "--last") {
      const raw = flagValue(args, index + 1);
      const count = raw === null ? 0 : Number.parseInt(raw, 10);
      if (!Number.isFinite(count) || count <= 0) return { error: "--last needs a positive count" };
      return { query: { kind: "last", count } };
    }
    if (arg === "--failed") return { query: { kind: "failed" } };
  }
  return { error: `unknown arguments: ${args.join(" ")}` };
}

/**
 * 用法。用函数而不是常量：默认路径来自 `ZCODE_PROXY_STORE_DIR`，模块加载时求值会
 * 把「按当前环境算出来的路径」钉死在帮助文本里（测试与以环境变量切换存储目录的
 * 部署都会看到一条错的路径）。
 */
function usage(): string {
  return `Usage:
  zcode-proxy logs --req <reqId>      Print every stage of one request
  zcode-proxy logs --last <n>         One summary line for the n most recent requests
  zcode-proxy logs --failed           Only the failed requests, with the failing stage

Options:
  --file <path>                       Read a dump file instead of requests.jsonl

Default source: ${requestLogPath()} (one JSONL line per request, always on).

--file reads a dump file: the JSONL that ZCODE_DUMP_UPSTREAM=<path> produces, one line
per phase, with full request and response bodies. That is the file to open when you
need the payload; the default source only has timings, status codes and stage names.`;
}

/** dump 来源：解析 → 分组 → 按查询渲染。*/
function renderDumpSource(text: string, path: string, query: LogsQuery): void {
  const groups = groupByRequest(parseDump(text));
  if (query.kind === "req") {
    const lines = groups.get(query.reqId);
    if (!lines) {
      printUsageError("logs", `request ${query.reqId} is not in ${path}`, () => console.log(usage()));
      return;
    }
    for (const line of lines) console.log(formatTimelineLine(line));
    return;
  }
  const summaries = [...groups.entries()].map(([reqId, lines]) => summarizeRequest(reqId, lines));
  if (query.kind === "last") {
    for (const summary of summaries.slice(-query.count)) console.log(formatSummaryLine(summary));
    return;
  }
  for (const summary of summaries) {
    if (summary.failedPhase !== undefined) console.log(formatSummaryLine(summary));
  }
}

/** 记录来源：读 `requests.jsonl` → 按查询渲染。*/
function renderRecordSource(records: readonly RequestRecord[], path: string, query: LogsQuery): void {
  if (query.kind === "req") {
    const record = records.find((candidate) => candidate.reqId === query.reqId);
    if (!record) {
      // 找不到时给出下一步：记录只留最近 200 条，更早的那次可能还在 dump 里。
      printUsageError(
        "logs",
        `request ${query.reqId} is not in ${path} (records keep the last ${REQUEST_STORE_CAPACITY}; it may still be in a dump file, pass --file <path>)`,
        () => console.log(usage()),
      );
      return;
    }
    for (const line of formatRecordTimeline(record)) console.log(line);
    return;
  }
  if (query.kind === "last") {
    for (const record of records.slice(-query.count)) console.log(formatSummaryLine(summarizeRecord(record)));
    return;
  }
  for (const record of records) {
    if (record.failedStage === undefined) continue;
    console.log(formatSummaryLine(summarizeRecord(record)));
  }
}

/**
 * 子命令入口。
 *
 * 退出码语义与其余 CLI 一致：参数错误 / 读不到文件 / 请求不在数据源里 = 1，正常
 * （包括「没有失败请求」而一行没打）时退出码是 0：那是查询结果为空，不是失败，
 * 脚本不该因此中断。
 */
export function logsCommand(rawArgs: readonly string[]): void {
  const args = splitFlagArgs(rawArgs);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsageError("logs", "nothing to do", () => console.log(usage()));
    return;
  }

  const parsed = parseLogsQuery(args);
  if ("error" in parsed) {
    printUsageError("logs", parsed.error, () => console.log(usage()));
    return;
  }

  const dump = resolveDumpFile(args);
  if (typeof dump === "object" && dump !== null) {
    printUsageError("logs", dump.error, () => console.log(usage()));
    return;
  }

  if (dump !== null) {
    let text: string;
    try {
      text = readFileSync(dump, "utf-8");
    } catch (err) {
      printUsageError("logs", `cannot read ${dump}: ${(err as Error).message}`, () => console.log(usage()));
      return;
    }
    renderDumpSource(text, dump, parsed.query);
    return;
  }

  const path = requestLogPath();
  const records = readRequestRecords(REQUEST_STORE_CAPACITY, path);
  /*
   * 文件不存在时 `readRequestRecords` 回空数组，与「有文件但一条都没有」在这里是
   * 同一件事。`--req` 需要一份能读的源，所以那一支给提示；`--last` / `--failed`
   * 的「什么都没有」是合法结果，安静退出。
   */
  if (records.length === 0 && parsed.query.kind === "req") {
    printUsageError(
      "logs",
      `no request records at ${path} (the proxy writes them on every request; for a dump file pass --file <path>)`,
      () => console.log(usage()),
    );
    return;
  }
  renderRecordSource(records, path, parsed.query);
}

/** `cli/index.ts` 的异步壳：与其余子命令同形的 catch 出口。*/
export async function logsCommandAsync(args: readonly string[]): Promise<void> {
  try {
    logsCommand(args);
  } catch (err) {
    cliFailure("logs")(err);
  }
}
