import { createBrotliDecompress } from "node:zlib";
import { writeRequestLine } from "../log/index.js";
import { dumpEnabled, dumpPhase } from "./dump.js";
import { addStage, markClientAborted, markZeroOutput } from "./request-record.js";
import type { RequestRecord } from "./request-record.js";
import { StreamMetrics } from "./stream-metrics.js";
import { AnthropicStreamError } from "../translator/sse-translator.js";
import type { AnthropicUsage } from "../translator/types.js";
import type { UpstreamEvent } from "./upstream-error.js";

let headerPrinted = false;

/** Format a unix-ms timestamp as local HH:MM:SS in the host's timezone (not UTC). */
function localTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

const DEBUG_BODY_PREVIEW = 200;

const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "cookie", "set-cookie", "proxy-authorization"]);

function redactHeaderVal(key: string, val: string): string {
  const k = key.toLowerCase();
  if (!SENSITIVE_HEADERS.has(k)) return val;
  if (k === "authorization") {
    const sp = val.indexOf(" ");
    return sp > 0 ? `${val.slice(0, sp)} <redacted>` : "<redacted>";
  }
  if (val.length <= 10) return "<redacted>";
  return `${val.slice(0, 6)}...${val.slice(-4)}`;
}

export function formatHeaderPairs(headers: Headers): string {
  const pairs: string[] = [];
  for (const [k, v] of headers.entries()) {
    pairs.push(`${k}=${redactHeaderVal(k, v)}`);
  }
  return pairs.join(" ");
}

export function formatResponseHeaders(headers: Headers): string {
  const interesting = [
    "content-type",
    "content-encoding",
    "content-length",
    "x-request-id",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-tokens-remaining",
  ];
  const pairs: string[] = [];
  for (const h of interesting) {
    const v = headers.get(h);
    if (v) pairs.push(`${h}=${v}`);
  }
  return pairs.length > 0 ? pairs.join(" ") : "(no notable headers)";
}

export function previewBody(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= DEBUG_BODY_PREVIEW) return flat;
  return `${flat.slice(0, DEBUG_BODY_PREVIEW)}…(${flat.length} bytes total)`;
}

const COMPACT_LOG = process.env.ZCODE_LOG_FORMAT === "compact";

/**
 * 账号列的宽度。9 个字符装得下 `work-team` 这种常见 label，再宽就会把
 * Model 与耗时列挤出 80 列的终端。
 */
const ACCOUNT_COL_WIDTH = 9;

/**
 * `reqId` 列的宽度。
 *
 * `#mw6rua-001` 是 11 个字符：`#` + 6 位进程标识 + `-` + 3 位序号。加进程前缀之前
 * 这一格是 4（`#001`），旧的 `padEnd(4)` 会把表格撑破 —— 差值直接反映到后面的列上。
 */
const REQ_ID_COL_WIDTH = 11;

/**
 * 没有账号时那一格显示 `-`：`/v1/models`、`/mcp` 这类路径不经过调度。
 */
const ACCOUNT_MISSING = "-";

/**
 * 账号 label 截到列宽。label 由用户起，可能很长；截断比撑破表格好。
 *
 * 不加省略号：9 个字符已经很窄，`…` 会吃掉一个真实字符，而账号名靠前几位区分。
 * 与 `Model` 列一样左对齐补空格：它是 label，不是数值。
 */
function accountCell(account: string | undefined): string {
  if (!account) return ACCOUNT_MISSING.padEnd(ACCOUNT_COL_WIDTH);
  const shown = account.length > ACCOUNT_COL_WIDTH ? account.slice(0, ACCOUNT_COL_WIDTH) : account;
  return shown.padEnd(ACCOUNT_COL_WIDTH);
}

/**
 * 表头两行。
 *
 * 账号列放在 `Time` 之后：一次请求先要问「去了哪个账号」，再看状态码。
 * 分隔线每格的破折号数是「列宽 + 2」（左右各一个空格），所以 `Acct` 那格是 11 个；
 * `|` 的数量必须与列数一致，否则渲染错位。
 *
 * `#` 那一格宽度 11：`#mw6rua-001` 是 `#` + 6 位进程标识 + `-` + 3 位序号。
 */
export const HEADER_ROW =
  "| #           | Time       | Acct      | Fmt | Model       | Mode   | Stat |    TTFB |   Tok |  tok/s |   Total |";
export const HEADER_RULE =
  "|-------------|------------|-----------|-----|-------------|--------|------|---------|-------|--------|---------|";

function printHeader(): void {
  if (headerPrinted) return;
  headerPrinted = true;
  if (COMPACT_LOG) return;
  writeRequestLine(HEADER_ROW);
  writeRequestLine(HEADER_RULE);
}

/**
 * 一行请求的日志。
 *
 * 表格格式归本文件，去向归 `writeRequestLine`
 * （`src/log/index.ts`）：只在有终端时写 stdout，**不落 `LogBuffer`**——往缓冲里
 * 塞表格行会让面板「系统」tab 的日志流里混进请求行。终端表格（有 TTY）与面板
 * 请求事件 tab（`RequestRecord`）是仅有的两个读者。
 *
 * 入参是整条记录：九个位置参数换成一个对象之后，加字段只动记录，不动这里。
 * 记录里缺的字段按「不知道」渲染成 `-`。
 */
export function printRow(record: RequestRecord): void {
  printHeader();
  writeRequestLine(renderRow(record, COMPACT_LOG));
}

/**
 * 把记录渲染成一行（不带换行，不写去向）。
 *
 * 表格与紧凑两种形状都在这里，`compact` 由 `ZCODE_LOG_FORMAT` 在模块加载时定下。
 * 抽成纯函数的理由只有一个：两种形状都得能被断言（`request-record.test.ts` 拿旧
 * 实现当基线逐字节比）。
 */
export function renderRow(record: RequestRecord, compact: boolean): string {
  const tag = record.format === "anthropic" ? "ANT" : "OAI";
  const mode = record.stream ? "stream" : "batch";
  const status = record.status ?? 0;
  // 批量请求在收尾那一刻还没有「结束时刻」（body 刚读完，响应还没写完），表格的
  // Total 列在那时是 `-`；`record.totalMs` 要到流结束或请求收尾才补上。
  const totalMs = record.totalMs ?? 0;
  const ttfbMs = record.ttfbMs ?? 0;
  const tokens = record.outputTokens ?? 0;
  const avgTps = record.tps ?? 0;

  if (compact) {
    const shownTotalMs = totalMs > 0 ? totalMs : ttfbMs;
    const ttfbStr = fmtMs(ttfbMs);
    const tokStr = tokens > 0 ? `${tokens}tok` : "";
    const tpsStr = avgTps > 0 ? `${avgTps.toFixed(0)}t/s` : "";
    // compact 是空格分隔的，列宽没有意义，所以账号直接取原值（不截断、不补空格）：
    // 它给人扫一眼，长 label 就长着。没有账号时用 `-`，与表格同一套「不知道」的写法。
    const acct = record.account ?? ACCOUNT_MISSING;
    const parts = [record.reqId, acct, tag, record.model, String(status), mode];
    if (record.stream && totalMs > 0) {
      parts.push(`${ttfbStr}→${fmtMs(shownTotalMs)}`);
    } else {
      parts.push(ttfbStr);
    }
    if (tokStr) parts.push(tokStr);
    if (tpsStr) parts.push(tpsStr);
    return parts.join(" ");
  }

  const ts = localTime(record.startedAt);
  const ttfb = `${ttfbMs}ms`;
  const total = totalMs > 0 ? `${totalMs}ms` : "-";
  const tok = tokens > 0 ? String(tokens) : "-";
  const tps = avgTps > 0 ? avgTps.toFixed(1) : "-";
  return `| ${record.reqId.padEnd(REQ_ID_COL_WIDTH)} | ${ts.padEnd(10)} | ${accountCell(record.account)} | ${tag} | ${record.model.padEnd(11)} | ${mode.padEnd(6)} | ${String(status).padStart(4)} | ${ttfb.padStart(7)} | ${tok.padStart(5)} | ${tps.padStart(6)} | ${total.padStart(7)} |`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

/**
 * 把翻译器内部的 Anthropic usage 快照观察接到请求记录的缓存桶上。
 *
 * 给 `anthropicSseToOpenaiSse` 的第三个参数用（handler.ts 与 responses-handler.ts
 * 两个翻译流式出口共用）。为什么需要它：OpenAI 的 usage 形状装不下
 * cache_creation 桶（strict-schema 客户端拒未知成员，anthropicUsageToOpenAI
 * 有意不镜像），翻译流上那个桶只能从翻译器还没丢的 Anthropic 快照拿。
 *
 * 覆盖语义与 sse-translator 的 usage 合并一致：快照字段是绝对值，后到的覆盖
 * 先到的（上游在 `message_start` 报一次、`message_delta` 再报一次，最后一次是
 * 终值）。在场即有效：`undefined` 不写（保持「上游没报」的语义），0 写。
 */
export function observeAnthropicUsage(record: RequestRecord): (usage: AnthropicUsage) => void {
  return (usage) => {
    if (usage.cache_read_input_tokens !== undefined) record.cacheReadTokens = usage.cache_read_input_tokens;
    if (usage.cache_creation_input_tokens !== undefined) record.cacheCreationTokens = usage.cache_creation_input_tokens;
  };
}

/**
 * 压缩流解析旁路的解压器（只为信号解析服务，见 `observeStream` 文件头）。
 *
 * - gzip / deflate / zstd：`DecompressionStream`（Web 标准，写端背压、读端可异步迭代）。
 *   Bun 1.4.4 实测支持这三种；**br 不支持**（构造即 TypeError）。
 * - br：`node:zlib` 的流式 Brotli 解码（async 迭代与 Web 流同形）。
 *
 * 返回 `null` = 该 coding 解不了（调用方放弃空流判定，不误判）。`write`/`finish`
 * 的拒绝由调用方吞掉并置 `parseViable = false`；node 流的错误事件在这里兜掉
 * （未处理的 `'error'` 事件会掀翻进程），泵的迭代以拒绝收场、同样落进调用方的 catch。
 */
function createInflater(coding: string): {
  write(chunk: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  abort(): void;
  output: AsyncIterable<Uint8Array>;
} | null {
  const kind = coding.split(",")[0]?.trim().toLowerCase() ?? "";
  if (kind === "" || kind === "identity") return null;
  if (kind === "gzip" || kind === "x-gzip" || kind === "deflate" || kind === "zstd") {
    let ds: DecompressionStream;
    try {
      ds = new DecompressionStream(kind as "gzip");
    } catch {
      return null;
    }
    const writer = ds.writable.getWriter();
    return {
      // SAFETY: `Uint8Array<ArrayBufferLike>` → `BufferSource`：TS 的 DOM 泛型要求
      // `ArrayBuffer` 底座（拒 SharedArrayBuffer），运行时的写入语义一致。
      write: (chunk) => writer.write(chunk as unknown as BufferSource),
      finish: () => writer.close(),
      abort: () => {
        void writer.abort().catch(() => {});
      },
      output: ds.readable as unknown as AsyncIterable<Uint8Array>,
    };
  }
  if (kind === "br") {
    const transform = createBrotliDecompress();
    transform.on("error", () => {
      // 有意吞错：坏数据由泵的迭代拒绝收场，这里只挡住未处理 'error' 事件。
    });
    return {
      write: async (chunk) => {
        transform.write(chunk);
      },
      finish: async () => {
        transform.end();
      },
      abort: () => {
        transform.destroy();
      },
      output: transform as unknown as AsyncIterable<Uint8Array>,
    };
  }
  return null;
}

/**
 * 旁路统计一条 SSE：读完就填 record 的用量与耗时，并打那一行表格。
 *
 * 入参是记录本身：TTFB / 总耗时 / token / tps 全是这个请求的属性，不该再作为六个
 * 位置参数传一遍。首块到达才算 TTFB（客户端的第一个字节），所以我们在这里把
 * `record.ttfbMs` 从「响应头到达」改写成「首块到达」。
 *
 * `onSignal` 是流层的**上游信号旁路**，检测也只在这一处
 * （所有流式出口共用同一个观察点）：
 *
 * - SSE `type:"error"` 帧 → `stream-error`（inline 发；翻译路径的 error 帧以
 *   `AnthropicStreamError` 异常形态出现，catch 里归同一信号）；
 * - 流干净结束且 0 输出事件（连 `message_start` 都没有，[DONE] 不算）→ `empty-stream`
 *   + `record.zeroOutput`；
 * - 流读失败 → `stream-interrupted`；**客户端主动断开不发**（`signal.aborted`：
 *   账号无辜），只落 `clientAborted`。
 *
 * 信号经回调送回 handler 侧的 `observeUpstream`——译码器与统计旁路都不直接碰
 * broker（依赖方向：本文件不 import accounts 运行时）。
 */
export function observeStream(
  record: RequestRecord,
  body: ReadableStream<Uint8Array>,
  /** 流走完（或失败）之后调一次：在飞记账、用量记账都在这里。*/
  onEnd?: () => void,
  /** 流读到错误时触发一次（挂卡流中断 → 作废卡）。*/
  onFailure?: () => void,
  /**
   * 记录完整（token / 缓存桶 / `stream-end` 阶段已落）之后调一次——
   * `RequestStore.finalize` 的触发点。调用方传 `() => requests.finalize(record)`；
   * 缺省 = 调用方在交接后自己收尾（非流式路径不走 observeStream，不用这个参数）。
   */
  onFinal?: () => void,
  /**
   * 这条流的 abort 信号（与上游 fetch 用的同一个：`lease.signal` 跟随客户端
   * abort）。
   *
   * 用它区分“流读失败因为客户端断开”与“流读失败因为上游断流”：后者是上游故障，
   * 前者是客户端自己取消的（`record.clientAborted`）。不传就只归因到上游失败。
   */
  signal?: AbortSignal,
  /** 流层上游信号旁路（见文件头）。缺省 = 不观测（纯统计用法）。*/
  onSignal?: (event: UpstreamEvent) => void,
): void {
  // 翻译路径（OpenAI 入站）读的是已解压的 SSE，按未压缩处理；直传路径读的是上游
  // 原样的字节，压缩与否看记录里那个 `contentEncoding`。这里反推而不是再从调用方
  // 多传一个参数：那个事实已经在记录上了。
  const contentEncoding = record.format === "openai" ? null : (record.contentEncoding ?? "identity");
  const compressed = contentEncoding !== null && contentEncoding !== "identity";
  const reqId = record.reqId;
  const requestSentAt = record.startedAt;
  const dumpOn = dumpEnabled();
  const sampleDecoder = new TextDecoder();
  const metrics = new StreamMetrics();
  let sseBuffer = "";
  let firstChunkAt = 0;
  let lastChunkAt = 0;
  let totalBytes = 0;
  let firstBytesSample = "";
  /** 流读到错误（上游断流或客户端取消）——`clientAborted` 归因的前提。*/
  let streamFailed = false;
  /** 流里出过输出事件（message_start / 翻译 chunk）——空流判定的反面。*/
  let sawOutput = false;
  /** 流里出过 error 帧——抑制空流判定（错误流不是「空流」）。*/
  let sawErrorFrame = false;

  /** 信号旁路出口（回调异常不得影响统计与流本身）。*/
  const emitSignal = (event: UpstreamEvent): void => {
    if (!onSignal) return;
    try {
      onSignal(event);
    } catch {
      // 有意吞错：观测失败不能把一条已经在收尾的流变成错误。
    }
  };

  function parseSse(text: string, receivedAt: number): void {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        // 信号旁路：SSE error 帧 inline 发 stream-error——
        // BigModel `[1302][…]` 前缀的业务码提取在 signals.ts::signalFromStreamError，
        // 这里只负责把帧递出去。译码器不碰 broker，信号从这条旁路送回 observeUpstream。
        const type = (j as { type?: string }).type;
        if (type === "error") {
          sawErrorFrame = true;
          const err = (j as { error?: { type?: string; message?: string } }).error;
          emitSignal({ type: "stream-error", frameType: err?.type, message: err?.message });
        } else if (type === "message_start" || (j as { object?: string }).object === "chat.completion.chunk") {
          // 原始 Anthropic 流看 message_start；翻译流的第一个 chunk 带
          // object:"chat.completion.chunk"（上游事件已被译码器折掉 type）。
          sawOutput = true;
        }
        metrics.observe(j, receivedAt);
      } catch {
        // 有意吞错（这类旁路吞错必须注明原因）：这里只是**统计旁路**，一行不是 JSON
        // （注释行、心跳、半截块）就跳过该行。把统计失败抛出去会杀掉整条 SSE。
      }
    }
  }

  /** 行边界解析入口（未压缩主循环与解压泵共用：攒到整行才交给 parseSse）。*/
  function parseDecoded(text: string): void {
    sseBuffer += text;
    const idx = sseBuffer.lastIndexOf("\n");
    if (idx >= 0) {
      parseSse(sseBuffer.slice(0, idx), lastChunkAt);
      sseBuffer = sseBuffer.slice(idx + 1);
    }
  }

  // ── 压缩流的解析旁路（解压只为解析，字节口径仍是压缩态）──
  // 实测空流是 zstd/br 压缩的 passthrough 流（ttfb≈total、0 events），
  // 对压缩流不解析就永远看不见「连 message_start 都没有」。解压器建不起来（不支持
  // 的 coding）或中途失败 → `parseViable = false`，放弃空流判定——宁可漏检不误判。
  let parseViable = !compressed;
  const inflater = compressed && contentEncoding !== null ? createInflater(contentEncoding) : null;
  let pumpDone: Promise<void> = Promise.resolve();
  if (inflater) {
    parseViable = true;
    pumpDone = (async () => {
      const inflateDecoder = new TextDecoder();
      try {
        for await (const chunk of inflater.output) {
          parseDecoded(inflateDecoder.decode(chunk, { stream: true }));
        }
        parseDecoded(inflateDecoder.decode());
      } catch {
        // 有意吞错：解压失败只放弃解析，不影响统计与透传。
        parseViable = false;
      }
    })();
  }

  (async () => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lastChunkAt = performance.now();
        if (firstChunkAt === 0) firstChunkAt = Date.now();
        // 字节数**常开**累计（不能只在 dump 下算：`totalBytes` 那个数字本来只
        // 服务 dump 一行，而 `record.responseBytes` 是常驻统计事实，与 dump
        // 开关无关）。
        if (value) totalBytes += value.byteLength;
        if (dumpOn && value) {
          if (firstBytesSample.length < 4096) {
            firstBytesSample += sampleDecoder.decode(value.slice(0, 4096 - firstBytesSample.length), { stream: true });
          }
        }
        if (!compressed) {
          parseDecoded(decoder.decode(value, { stream: true }));
        } else if (inflater && value) {
          // 喂解压泵（Web 写端带背压；node 流写入即返回，错误由泵的 try/catch 兜）。
          await inflater.write(value).catch(() => {
            parseViable = false;
          });
        }
      }
      if (inflater) {
        await inflater.finish().catch(() => {
          parseViable = false;
        });
      }
    } catch (err) {
      // 有意吞错：上游流中断或客户端取消时，错误已经由 `pull` 的
      // `controller.error` 传给客户端；这里只负责收尾统计，重抛只会多一条未处理拒绝。
      // 挂卡流中断还要把这张卡作废（onFailure 自带幂等：无卡即空转）。
      streamFailed = true;
      inflater?.abort();
      try { onFailure?.(); } catch {
        // 有意吞错：作废卡失败不能影响收尾统计。
      }
      // 流中断 → transport 信号（进路由级 gateway streak，不冷却账号）。
      // 客户端主动断开**不发信号**（signal.aborted：账号无辜）——流读失败与
      // 「客户端取消」在读端长得一模一样，只有这个信号能区分（clientAborted 同源）。
      if (!signal?.aborted) {
        if (err instanceof AnthropicStreamError) {
          // 翻译路径的 error 帧以异常形态到达（译码器 throw）——归 stream-error，
          // 与原始流 inline 解析出的 error 帧同一信号形状。
          sawErrorFrame = true;
          emitSignal({ type: "stream-error", frameType: err.code, message: err.message });
        } else {
          emitSignal({ type: "stream-interrupted", detail: (err as Error).message });
        }
      }
    }
    await pumpDone;
    // 尾帧冲洗：EOF 后 sseBuffer 里不足一行的文本（正常流最后一行常不带换行）。
    if (!streamFailed && parseViable && sseBuffer) parseSse(sseBuffer, lastChunkAt);
    // 空流软拒绝：干净结束且零输出事件（连 message_start 都没有；[DONE] 与
    // error 帧不算输出）。客户端主动断开的半截流不是空流（clientAborted 域）；
    // 解压失败的压缩流放弃判定（parseViable=false，宁可漏检不误判）。
    if (!streamFailed && !signal?.aborted && parseViable && !sawOutput && !sawErrorFrame) {
      markZeroOutput(record);
      emitSignal({ type: "empty-stream", detail: "stream ended with 0 output events (no message_start)" });
    }
    const endAt = Date.now();
    // Stream finished (or failed): the request is no longer in flight. Fired
    // exactly once from this reader loop — the single point that observes
    // SSE completion for every streaming response path.
    try { onEnd?.(); } catch {
      // 有意吞错：`onEnd` 是 captcha 池 / highspeed 抽卡的空闲记账，
      // 它的失败不能影响日志行与统计（那才是排障时唯一能看到的东西）。
    }
    const totalMs = endAt - requestSentAt;
    // 首块到达才是客户端的 TTFB；一个字节都没读到（上游立刻断流）就退化成收尾时刻。
    const ttfbMs = (firstChunkAt > 0 ? firstChunkAt : endAt) - requestSentAt;
    const tokens = metrics.tokens;
    const avgTps = metrics.tokensPerSecond;
    record.ttfbMs = ttfbMs;
    record.totalMs = totalMs;
    record.inputTokens = metrics.inputTokens;
    record.outputTokens = tokens;
    record.tps = avgTps;
    // 流式响应体字节数（旁路读到的就是客户端拿到的那一份，见 `responseBytes`
    // 字段注释里的口径）。一个字节都没读到（上游立刻断流）就落 0：那是“确实 0 字节”，
    // 不是“没观测”。
    record.responseBytes = totalBytes;
    // “流读到错误 + 信号已 abort”= 客户端自己断开，不是上游故障。只在读失败
    // 时归因：流正常读完而客户端紧接着断开（常见于最后一帧后的立刻取消）不应该
    // 把一次成功请求标成被取消。
    if (streamFailed && signal?.aborted) markClientAborted(record);
    // 缓存桶只在「上游真的报了」时落（在场即有效，0 也是有效样本）：
    // undefined 表示整个流里没出现过任何一个缓存桶，不是 0 命中。
    if (metrics.cacheReadTokens !== undefined) record.cacheReadTokens = metrics.cacheReadTokens;
    if (metrics.cacheCreationTokens !== undefined) record.cacheCreationTokens = metrics.cacheCreationTokens;
    // 阶段 stream-end：流结束时的用量与耗时。token 数只来自上游的 `usage`
    // （`StreamMetrics`），所以它同时是「上游到底报没报 usage」的凭证。不在字段里
    // 重复报整段请求的速度：`totalMs` 与 `tokens` 都在，读的人自己就能算。
    addStage(record, "stream-end", { tokens, tps: avgTps, ttfbMs, totalMs });
    printRow(record);
    // 记录此刻才完整 —— 落盘（finalize）在用量落定之后，而不是响应交回时。
    try { onFinal?.(); } catch {
      // 有意吞错：落盘失败不能影响已经完成的统计与日志行。
    }
    // 用量记账在日志行之后：它只是记账，不应该影响（也不可能回滚）已经打出去的日志。
    try { onEnd?.(); } catch {
      // 有意吞错：记账失败不能把一条已经正常结束的流变成错误（客户端
      // 早已读到全部字节，这里没有任何可回滚的动作）。
    }
    if (dumpOn) {
      dumpPhase(reqId, "stream-end", {
        status: record.status,
        contentEncoding,
        compressed,
        totalBytes,
        tokensObserved: tokens,
        generationMs: metrics.generationMs,
        tokensPerSecond: avgTps,
        ttfbMs,
        totalMs,
        firstBytesSample: firstBytesSample.length > 0 ? firstBytesSample.slice(0, 4096) : "(empty stream)",
      });
    }
  })().catch(() => {});
}
