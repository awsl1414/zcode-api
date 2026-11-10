/**
 * 请求记录的落盘形态。
 *
 * 为什么要落一份文件，而不是给控制面加一条 `getRequests` 就完事：`RequestStore`
 * 住在 `serve` 进程的内存里，而 `logs` 子命令是**另一个进程**。跨进程读内存不成立，
 * 加命令也不改变这一点：CLI 自己 `createControlDispatcher` 得到的是自己进程里那份
 * 空仓库。所以给 store 一个落盘形态，CLI 直接读文件。
 *
 * 三个读取方，一条写路径：
 *
 *   面板「请求事件」   SSE 的 `request` 事件（内存，实时）
 *   CLI `logs`        直接读这个文件
 *   控制面 `getRequests` 控制命令（内存，与面板同源）
 *
 * 形状是 JSONL，一行一条 `RequestRecord`，与 `dump.ts` 同一个形态（它也是
 * `appendFileSync` 写一行一条）。**不走 `JsonStore`**：那是「整份 JSON 一起读写」，
 * 这里要的是追加；两者不是一回事，硬套只会让每次请求都重写一遍整个仓库。
 *
 * 内容只有阶段名与统计字段，没有请求体（`RequestRecord` 本来就没有 body 字段），
 * 所以可以常开。要看完整报文开 dump。
 *
 * 落盘的四个决定：
 *
 * - **收尾写一次**，不逐阶段写。阶段在请求进行中变化频繁，收尾那一版是完整的；
 *   `RequestStore.notify` 也只在收尾触发（见 `request-record.ts`）。
 * - **全量保留**：文件只追加、永不重写。按容量重写会连历史一起扔掉——面板要翻
 *   「昨天/上周」的请求时就没有数据源。内存仓保持
 *   `REQUEST_STORE_CAPACITY` 条 FIFO 不变，更早的记录靠 `pageRequestHistory` 从
 *   文件尾倒序分页读回（面板的「加载更早」）。append-only 还有一层工程红利：运行
 *   中的读不需要加锁，读到的要么是完整行要么是坏行（坏行跳过）。
 * - 启动时 `hydrate`，重启后面板与 CLI 还能看到上一次运行的历史。**只读尾部**：
 *   文件是全量的，整读会让启动成本随历史涨，内存仓也只要最近 capacity 条。
 * - **坏行跳过，不报错**。判据与 `cli/logs.ts::parseDump` 同一套：进程被杀时最后
 *   一行常常只写了一半，为了一行截断的 JSON 让整个读取方不可用是最糟的时候。
 *
 * - 落盘挂在 `RequestStore.finalize`（「记录不再会变」）上，不挂在 `notify`
 *   （「请求交回客户端了」）上：流式请求的两个时刻差一整个流的时长，挂在 notify
 *   上会让文件里的流式行永远缺 token / 缓存桶 / `stream-end` 阶段（2026-11-08
 *   实机复现过）。append-only 语义不变：还是一行一条、只在收尾写一次、永不重写
 *   —— 变的只是「哪一刻算收尾」。
 *
 * 所有写操作都吞错（与 `dump.ts` 同一条纪律）：落盘失败不能把一次已经处理完的请求
 * 变成错误；失败只记一行日志，且只记第一次（磁盘满时不必每请求刷一行）。
 */
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../log/index.js";
import { getStoreDir } from "../storage/store.js";
import { redactSecrets } from "./dump.js";
import { REQUEST_STORE_CAPACITY, RequestStore } from "./request-record.js";
import type { RequestRecord } from "./request-record.js";

const log = logger("proxy");

/** 倒序读的一块字节数：一页记录远小于它，常规文件几个块就够。*/
const HISTORY_CHUNK_BYTES = 64 * 1024;

/** 单行字节上限：正常记录几 KB；超过就当坏行整行丢弃（防异常巨行撑爆 carry）。*/
const HISTORY_MAX_LINE_BYTES = 1024 * 1024;

/** 存储目录下的文件名（CLI 帮助里也这么写）。*/
export const REQUEST_LOG_FILE = "requests.jsonl";

/**
 * 文件权限：只有本用户可读。
 *
 * 与 dump 同级的要求。这里显式给（dump 走的是 umask 缺省），因为请求记录虽然不含
 * 报文，但仍然有模型、账号 label 与时间，没必要让同机其它用户读到。
 */
export const REQUEST_LOG_MODE = 0o600;

/** 落盘路径。目录判定与四个加密仓共用 `storage/store.ts::getStoreDir`。*/
export function requestLogPath(): string {
  return join(getStoreDir(), REQUEST_LOG_FILE);
}

/** 写失败只报一次：磁盘满 / 只读挂载会持续失败，每请求一行只会把日志淹掉。*/
let warnedWriteFailure = false;

function warnOnce(action: string, path: string, err: unknown): void {
  if (warnedWriteFailure) return;
  warnedWriteFailure = true;
  log.warn(`request log ${action} failed`, { path, message: (err as Error).message });
}

/**
 * 一行文本 → 一条记录；形状不对返回 `null`。
 *
 * 判据只查「这条记录能不能被当作 `RequestRecord` 用」：`reqId` / `startedAt` /
 * `format` / `stages` 缺一样，读取方（CLI 的时间线、面板的表格）就会在渲染时炸。
 * 其余字段都是可选的，缺了不影响。
 *
 * 导出给 `usage-stats.ts` 的聚合扫描用**同一个**坏行判据——历史读出与
 * 聚合扫描对「什么算一条记录」的口径必须一致，两份实现迟早漂移。
 */
export function parseRequestRecord(line: string): RequestRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.reqId !== "string" || record.reqId.length === 0) return null;
  if (typeof record.startedAt !== "number") return null;
  if (typeof record.format !== "string") return null;
  if (!Array.isArray(record.stages)) return null;
  return parsed as RequestRecord;
}

/**
 * 倒序逐行访问一个文本文件。
 *
 * 请求历史是 append-only 的 JSONL，「更早的记录」物理上就在文件的前面，所以历史
 * 分页从**文件尾往前**读：凑满一页就停，永远不整文件载入内存（一个跑了几个月的
 * 实例文件可能几十 MB，整读既慢又占内存）。
 *
 * 实现按块倒着读（`HISTORY_CHUNK_BYTES` 一块），块内的 `\n` 把行切开：`\n` 右边
 * 的段与 carry（更高偏移里已读到的那截行）拼成完整行交给 `visit`，最左 `\n` 之前
 * 的字节留给下一块。行按 utf-8 在**拼完之后**才解码——块边界可能劈开多字节字符，
 * 整行解码才不会出替换符。
 *
 * `visit` 回 true 就停止读取（分页凑满一页 + 确认 hasMore 后不需要再看）。
 *
 * 容错（文件是运行中进程在写的，读取方不持锁）：
 *
 * - 文件不存在 → 一次都不访问（第一次运行是常态，不是错误）；
 * - 读到一半文件被截断/轮转（外部 logrotate；本体是 append-only，不重写文件）→ 读不动
 *   就停，拿到多少算多少，凑不齐的行由调用方的坏行判据兜住；
 * - 单行超过 `HISTORY_MAX_LINE_BYTES` → 整行丢弃。正常记录几 KB，这个上限只是
 *   防一个被写坏的巨行把 carry 撑爆内存。
 */
export function readLinesBackward(
  path: string,
  visit: (line: string) => boolean | void,
  fromOffset?: number,
): void {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  try {
    const size = fstatSync(fd).size;
    let offset = fromOffset === undefined ? size : Math.min(fromOffset, size);
    /** 还没拼完的行：从低偏移到高偏移的几段字节（倒着读，先拿到的是高段）。*/
    let carry: Buffer[] = [];
    let carryBytes = 0;
    /** 巨行保护：超限的行整行丢弃，直到它的收尾 `\n` 出现。*/
    let dropping = false;
    let stop = false;
    while (offset > 0 && !stop) {
      const chunkSize = Math.min(HISTORY_CHUNK_BYTES, offset);
      const buf = Buffer.allocUnsafe(chunkSize);
      let bytesRead = 0;
      try {
        bytesRead = readSync(fd, buf, 0, chunkSize, offset - chunkSize);
      } catch {
        break;
      }
      if (bytesRead <= 0) break;
      offset -= bytesRead;

      let scanEnd = bytesRead;
      while (scanEnd > 0) {
        /* `lastIndexOf` 的 fromIndex 为负时会从尾部重搜（-wrap），scanEnd 到 0 必须
           停：文件第一个字节之前没有行边界了。*/
        const nl = buf.lastIndexOf(0x0a, scanEnd - 1);
        if (nl < 0) break;
        if (dropping) {
          // 超限行在这里收尾：整行丢弃，恢复正常读取。
          dropping = false;
        } else {
          const piece = buf.subarray(nl + 1, scanEnd);
          const line = carry.length === 0 ? piece.toString("utf-8") : Buffer.concat([piece, ...carry]).toString("utf-8");
          if (line.trim().length > 0 && visit(line) === true) {
            stop = true;
            break;
          }
        }
        carry = [];
        carryBytes = 0;
        scanEnd = nl;
      }
      if (stop) break;
      if (dropping) continue;
      const head = buf.subarray(0, scanEnd);
      carry = [head, ...carry];
      carryBytes += head.length;
      if (carryBytes > HISTORY_MAX_LINE_BYTES) {
        carry = [];
        carryBytes = 0;
        dropping = true;
      }
    }
    if (!stop && !dropping && carryBytes > 0) {
      // 文件第一行前面没有 `\n`，它由这里收尾。
      const line = Buffer.concat(carry).toString("utf-8");
      if (line.trim().length > 0) visit(line);
    }
  } catch {
    // 读取期的任何意外（文件被删、权限翻转）都按「到此为止」处理：调用方拿到的
    // 是已经拼出来的那部分，与「文件被外部截断」同一条容错。
  } finally {
    closeSync(fd);
  }
}

/** 倒序分页的内部入参（`limit` 已由调用方钳好）。*/
interface BackwardQuery {
  limit: number;
  before?: number;
  path: string;
}

/**
 * 从文件尾往前收一页记录。返回新的在前的一页 + 还有没有更早的。
 *
 * `before` 是游标：只收 `startedAt <= before` 的记录——边界上的记录会随下一页
 * **重发**（客户端按 `reqId` 去重），而不是被跳过。这是刻意的：同一毫秒收尾的
 * 并列记录可能被上一页的 limit 从中间切断，按 `startedAt < before` 过滤会把
 * 剩下的并列记录永远丢掉；重发 + 去重只多传一条，不丢数据。「同一 startedAt
 * 边界的并列记录按文件序稳定」由倒序读天然满足：每次都是同一份文件序的反转。
 *
 * `hasMore` 是**精确**的：凑满一页后再往前找到下一条在范围内的记录才回 true，
 * 坏行与游标之外的字节都不会让它误报。面板的「加载更早」靠它收起按钮，宁可
 * 多扫一行，不给出会提前收起按钮的假阴性。
 */
function collectBackwardRecords(query: BackwardQuery): { records: RequestRecord[]; hasMore: boolean } {
  const records: RequestRecord[] = [];
  let hasMore = false;
  readLinesBackward(query.path, (line) => {
    const record = parseRequestRecord(line);
    if (record === null) return;
    if (query.before !== undefined && record.startedAt > query.before) return;
    if (records.length < query.limit) {
      records.push(record);
      return;
    }
    hasMore = true;
    return true;
  });
  /*
   * 页内按 startedAt 倒序排（sort 自 ES2019 起稳定，并列成员保持文件序的反转，
   * 即「同一 startedAt 边界的并列记录按文件序稳定」）。落盘是收尾序而 startedAt
   * 是开始时刻，并发请求会让两者在秒级内不一致；页内排一次，表格的时间倒序在
   * 一页之内不倒挂。页的**成员**仍按文件位置取（最近的 limit 条）——不整文件
   * 扫描是硬约束，跨页的秒级倒挂与 CLI `logs` 同一口径，不为此付全读的代价。
   */
  records.sort((a, b) => b.startedAt - a.startedAt);
  return { records, hasMore };
}

/** 历史分页的缺省页大小（面板一屏的量级）。*/
export const REQUEST_HISTORY_PAGE_LIMIT = 100;

/** 历史分页的单页上限：控制面应答的体积钉在这里。*/
export const REQUEST_HISTORY_PAGE_MAX = 500;

/** `pageRequestHistory` 的入参。*/
export interface RequestHistoryQuery {
  /** 游标（Unix ms）：只回 `startedAt <= before` 的记录；缺省从最新开始。*/
  before?: number;
  /** 本页条数；缺省 {@link REQUEST_HISTORY_PAGE_LIMIT}，钳到 {@link REQUEST_HISTORY_PAGE_MAX}。*/
  limit?: number;
  /** 覆盖落盘路径（测试用；生产走 `requestLogPath()`）。*/
  path?: string;
}

/** `getRequestsHistory` 的一页应答。*/
export interface RequestHistoryPage {
  /** 一页记录，新的在前（与 `getRequests` 同向，面板直接往表尾追加）。*/
  requests: RequestRecord[];
  /** 文件里还有没有更早的记录；false 之后面板收起「加载更早」。*/
  hasMore: boolean;
}

/**
 * 请求历史的一页：控制面 `getRequestsHistory` 的数据源。
 *
 * 倒序流式读（见 {@link readLinesBackward}），坏行跳过，`limit` 钳在
 * `[1, REQUEST_HISTORY_PAGE_MAX]`。文件不存在与空文件同义：空页 + `hasMore: false`。
 */
export function pageRequestHistory(query: RequestHistoryQuery = {}): RequestHistoryPage {
  const raw = typeof query.limit === "number" && Number.isFinite(query.limit) ? Math.floor(query.limit) : REQUEST_HISTORY_PAGE_LIMIT;
  const limit = Math.min(Math.max(raw, 1), REQUEST_HISTORY_PAGE_MAX);
  const before = typeof query.before === "number" && Number.isFinite(query.before) ? query.before : undefined;
  const path = query.path ?? requestLogPath();
  const { records, hasMore } = collectBackwardRecords({ limit, before, path });
  return { requests: records, hasMore };
}

/**
 * 防御性脱敏（对照 dump 的纪律）：把记录里所有字符串值过一遍
 * `redactSecrets`（Bearer / sk- 两条正则）。
 *
 * `RequestRecord` 本身不含密钥（落盘的内容里没有报文），这层是「万一有」的兜底：
 * 历史应答要跨进程出门（面板 / 控制命令），打码宁多勿少。逐值深拷贝而不是整行
 * JSON 打码再 parse：那会把数字与布尔也过一遍字符串往返。域类型是 JSON 值树——
 * 输入是 `JSON.parse` 的产物（或同构的对象字面量），输出同构。
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function redactRequestRecord(record: RequestRecord): RequestRecord {
  // 边界在两套类型之间：`RequestRecord`（编译期形状）与 JSON 值树（运行期值）。
  // SAFETY: 运行期值一定是一棵 JSON 树（落盘那侧是 JSON.parse 的产物，内存那侧是
  // 同构字面量——`RequestRecord` 没有函数 / symbol / 循环引用成员），所以两个方向
  // 的转换都不改变运行时值，只是换一套类型视口；出参仍是同构的一棵树。
  return redactJsonValue(record as unknown as JsonValue) as unknown as RequestRecord;
}

function redactJsonValue(value: JsonValue): JsonValue {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (typeof value === "object" && value !== null) {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactJsonValue(item);
    return out;
  }
  return value;
}

/**
 * 追加一条记录。返回是否写入成功。
 *
 * 调用方只在 `RequestStore` 收尾时调它，所以文件里一行就是一次请求，不逐阶段写。
 */
export function appendRequestRecord(record: RequestRecord, path: string = requestLogPath()): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: REQUEST_LOG_MODE });
    return true;
  } catch (err) {
    warnOnce("append", path, err);
    return false;
  }
}

/**
 * 最近 N 条记录，按写入顺序（旧 → 新）返回；`hydrate` 直接吃这个顺序。
 *
 * 走倒序读：文件是全量保留的，整读会让这条路径（CLI `logs`、启动 hydrate）
 * 的成本随历史涨；倒着凑满 N 条就停，结果与整读后取尾部完全一致（都是从最新的
 * 那条往回数 N 条）。
 */
export function readRequestRecords(limit: number = REQUEST_STORE_CAPACITY, path: string = requestLogPath()): RequestRecord[] {
  if (limit <= 0) return [];
  const out: RequestRecord[] = [];
  readLinesBackward(path, (line) => {
    const record = parseRequestRecord(line);
    if (record === null) return;
    out.push(record);
    return out.length >= limit;
  });
  /* 倒序读进来是新的在前；这里与 `hydrate` 的契约都是旧的在前。*/
  return out.toReversed();
}

export interface RequestLogOptions {
  /** 覆盖落盘路径（测试用；生产走 `requestLogPath()`）。*/
  path?: string;
  /** 与内存同一个容量（`REQUEST_STORE_CAPACITY`）。*/
  capacity?: number;
}

/**
 * 建一个「内存 + 文件」两面对齐的 `RequestStore`：启动时灌回历史，收尾时追加。
 *
 * 抽成一个函数是因为两个入口都要这一套（`serve` 与控制面转发）：`hydrate` +
 * `onChange` 订阅两件事抄两遍，漏掉一处就是「一个入口的 CLI 读不到历史」这种只在
 * 特定入口下出现的差异。
 *
 * 两处细节：
 *
 * - 启动只读文件**尾部** capacity 条（`collectBackwardRecords`）：文件是全量保留的，
 *   整读会让启动成本随历史涨，内存仓也只要最近 capacity 条。
 * - onChange 只追加，不触发「超容量重写」。历史全量留在文件里，面板靠
 *   `pageRequestHistory` 分页读；落盘逻辑仍然不塞进 `RequestStore`（存储分层）：
 *   它是内存结构，文件是另一件事。
 */
export function openRequestStore(options: RequestLogOptions = {}): RequestStore {
  const path = options.path ?? requestLogPath();
  const capacity = options.capacity ?? REQUEST_STORE_CAPACITY;
  const store = new RequestStore(capacity);

  const { records } = collectBackwardRecords({ limit: capacity, path });
  store.hydrate(records.toReversed());

  // 落盘挂 finalize（记录完整了），不挂 notify（实时事件，流式时记录还没
  // 跑完统计旁路）。面板 SSE 与记账仍挂在 notify 上，两条订阅互不干扰。
  store.onFinalize((record) => {
    appendRequestRecord(record, path);
  });

  return store;
}
