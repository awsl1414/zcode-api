/**
 * API key 管理：创建、吊销、校验、用量累加。
 *
 * 与 `users/manager.ts` 的结构相同（同一套 store 注入、同一套结果码），差别在两件事：
 *
 * 1. 校验走 hash 的 `timingSafeEqual`，不是字符串相等。`find(k => k.hash === h)`
 *    在「前缀对上了」与「完全不对」之间会出现可测的耗时差，公网部署里那是一条把
 *    key 逐字节试出来的旁路（`server.ts` 的旧 `checkProxyKey` 也出于同一理由用了
 *    常数时间比较）。
 * 2. 用量攒批落盘。数据面每个请求都会产生一次用量，逐请求写文件等于把每个 LLM
 *    调用都变成一次「读文件 + 解密 + 加密 + 写文件 + rename」。所以用量只改内存，
 *    攒够 {@link USAGE_FLUSH_REQUEST_THRESHOLD} 条或过了
 *    {@link USAGE_FLUSH_INTERVAL_MS} 才写一次；进程退出时由入口 flush 一次。
 *
 * 文件只在第一次访问时读一次（{@link ApiKeyManager.loadFile}）。刻意不做「每次请求
 * 重读文件」：这个文件只有本模块写，跨进程同时改不再是支持场景（账号文件同理）。
 *
 * 存储是异步的（`storage/codec.ts` 用 WebCrypto），所以读文件的那几个方法都返回
 * Promise。内存表仍然是「读一次、之后只改内存」，只有第一次访问会真的碰磁盘。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { logger } from "../log/index.js";
import { machineCodec } from "../storage/index.js";
import type { Codec } from "../storage/index.js";
import { fileApiKeysStore } from "./store.js";
import type { ApiKeysStore } from "./store.js";
import {
  API_KEY_ENTROPY_BYTES,
  API_KEY_ID_HEX_CHARS,
  API_KEY_NAME_MAX_LENGTH,
  API_KEY_PREFIX,
  API_KEY_VISIBLE_CHARS,
  emptyUsage,
} from "./types.js";
import type { ApiKeyRecord, ApiKeySummary, ApiKeyUsage, ApiKeysFile, DataPlaneObserver } from "./types.js";
import type { RequestRecord } from "../proxy/request-record.js";

/**
 * 攒够多少条用量就落盘。
 *
 * 20 是「一次写盘摊到 20 个请求」与「崩溃时最多丢 20 条计数」之间的取舍：数据面
 * 请求来得密（agent 一次任务几十上百次调用），20 条通常在几秒内就攒满。
 */
export const USAGE_FLUSH_REQUEST_THRESHOLD = 20;

/**
 * 用量落盘的最长间隔（毫秒）。
 *
 * 低频部署（一个 key 一晚上几次请求）攒不满阈值，靠这个定时器兜底，否则计数会一直
 * 停在内存里等到进程退出。30s 与面板轮询间隔（5s）同量级，用户看到的数字足够新。
 */
const USAGE_FLUSH_INTERVAL_MS = 30_000;

/** 仓的日志。只记落盘失败：用量记账本身不该让一次已经完成的请求变成错误。*/
const log = logger("apikeys");

/** 一次创建 / 变更的结果：成功回摘要（创建时额外回一次完整 key），失败回稳定错误码。*/
export type ApiKeyResult = { ok: true; record: ApiKeySummary; key?: string } | { ok: false; error: string };

/** `sha256(明文)` 的十六进制串。*/
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf-8").digest("hex");
}

/** 索引：hash 的前 {@link API_KEY_ID_HEX_CHARS} 位（够短且不必保密）。*/
export function apiKeyIdOf(hash: string): string {
  return hash.slice(0, API_KEY_ID_HEX_CHARS);
}

/** 展示用前缀：`sk-zcp-a1b2`。省略号由界面补，数据里不留装饰字符。*/
export function apiKeyPrefixOf(key: string): string {
  return `${API_KEY_PREFIX}${key.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + API_KEY_VISIBLE_CHARS)}`;
}

/** 生成一把新 key：`sk-zcp-` + 32 字节 base64url。*/
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(API_KEY_ENTROPY_BYTES).toString("base64url")}`;
}

/**
 * 本地日期（`YYYY-MM-DD`）。
 *
 * 用 `getFullYear/getMonth/getDate` 而不是 `toISOString`：今天是哪一天是用户时区的
 * 事，「今日请求数」在 UTC+8 的机器上按 UTC 归零会差 8 小时。
 */
export function localDateString(at: number = Date.now()): string {
  const date = new Date(at);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 记录 → 对外摘要：**不含 hash**；`secret` 由 `list` 在需要明文的路径上单独附上。*/
export function summarizeApiKey(record: ApiKeyRecord): ApiKeySummary {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    enabled: record.enabled,
    createdAt: record.createdAt,
    usage: { ...record.usage },
  };
}

/**
 * 跨天归零。
 *
 * 只在「今天」这个字段上做：累计请求数是历史，不随日期变化。归零发生在读写两个方向
 * （`list` 与累加都先过一遍），所以面板上看到的「今日」不会停在前一天的旧值上。
 */
function rollUsage(usage: ApiKeyUsage, today: string): ApiKeyUsage {
  if (usage.todayDate === today) return usage;
  return { ...usage, todayDate: today, todayRequests: 0 };
}

/** API key 仓。*/
export class ApiKeyManager implements DataPlaneObserver {
  /** 内存里的文件：首次访问时从存储读一次，之后所有读写都针对它。*/
  private file: ApiKeysFile | null = null;
  /**
   * 正在进行的首次读取。
   *
   * 读文件是异步的，两个并发调用（第一个请求的鉴权与用量收尾）不能各自读一遍：
   * 后读完的那份会覆盖前一份，而前一份上已经累加过的用量就丢了。
   */
  private loading: Promise<ApiKeysFile> | null = null;
  /** 写盘的串行链（见 {@link persist}）。*/
  private writes: Promise<void> = Promise.resolve();
  /** 自上次落盘以来累加的用量条数（攒批的计数器）。*/
  private pendingUsage = 0;
  /** 攒批的定时器（`unref`：它不该拖住进程退出）。*/
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: ApiKeysStore = fileApiKeysStore,
    /** 时钟注入：跨天与「最后使用」的用例要能把时间拨走。*/
    private readonly now: () => number = Date.now,
    /**
     * `secret` 字段的编解码器：创建时加密、`list` 需要回明文时解密。
     * 默认 `machineCodec()`——与整份文件的加密同一把机器派生密钥，安全等级相同
     * （理由见 `types.ts` 文件头）。测试注入 `codecFromSeed` 以得到确定性的往返。
     */
    private readonly codec: Codec = machineCodec(),
  ) {}

  /** 全部 key（摘要形态，按创建时间升序）。跨天归零在这里生效。
   *
   * `list` 是唯一解密的路径：控制面 `listApiKeys` 的应答要带明文（页面掩码 /
   * 复制 / 聊天页直接发都靠它），逐条 `codec.decode`。解不开（换过
   * `ZCODE_PROXY_CREDENTIAL_SECRET` / 文件被换）= 记录损坏（`secret` 必须可解），
   * 丢弃并告警：不留「能鉴权不能回显」的僵尸记录，重建 key 即可。
   * 读盘本身仍不解密（`store.load` 只拿密文），不用 key 页 / 聊天页
   * 的时候一个 AES 都不用付。
   */
  async list(): Promise<ApiKeySummary[]> {
    const today = localDateString(this.now());
    const keys = (await this.loadFile()).keys;
    const summaries: ApiKeySummary[] = [];
    for (const record of keys) {
      record.usage = rollUsage(record.usage, today);
      const summary = summarizeApiKey(record);
      try {
        summary.secret = await this.codec.decode(record.secret);
      } catch {
        console.warn(`[apikeys] dropping corrupt key record ${record.id}: secret decode failed`);
        continue;
      }
      summaries.push(summary);
    }
    return summaries.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 是否一把 key 都没有。数据面闸门据此决定「表空即放行」。*/
  async isEmpty(): Promise<boolean> {
    return (await this.loadFile()).keys.length === 0;
  }

  /**
   * 建一把 key，返回一次完整明文。
   *
   * 落盘两份材料：hash（鉴权）+ 密文（面板再次显示 / 复制用）；返回值里的
   * 明文仍是「只此一次」的仪式（创建弹窗），之后页面上看到 / 复制的明文都从
   * `list` 解密得来。用户关掉这个弹窗之后不会丢 key 了，但创建那一刻的完整展示
   * 保留——它是「key 已生成」的确认。
   */
  async create(name: string): Promise<ApiKeyResult> {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, error: "empty_api_key_name" };
    if (trimmed.length > API_KEY_NAME_MAX_LENGTH) return { ok: false, error: "invalid_api_key_name" };

    const file = await this.loadFile();
    if (file.keys.some((record) => record.name === trimmed)) {
      return { ok: false, error: "duplicate_api_key_name" };
    }

    const key = generateApiKey();
    const hash = hashApiKey(key);
    const record: ApiKeyRecord = {
      id: apiKeyIdOf(hash),
      name: trimmed,
      hash,
      secret: await this.codec.encode(key),
      prefix: apiKeyPrefixOf(key),
      enabled: true,
      createdAt: this.now(),
      usage: emptyUsage(localDateString(this.now())),
    };
    file.keys.push(record);
    await this.saveNow();
    return { ok: true, record: summarizeApiKey(record), key };
  }

  /** 启停一把 key。禁用的语义是「立刻 401」，不是「删掉记录」。*/
  async setEnabled(id: string, enabled: boolean): Promise<ApiKeyResult> {
    const record = await this.find(id);
    if (!record) return { ok: false, error: "api_key_not_found" };
    record.enabled = enabled;
    await this.saveNow();
    return { ok: true, record: summarizeApiKey(record) };
  }

  /** 删掉一把 key。删除即吊销：下一个请求立刻 401。*/
  async remove(id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const file = await this.loadFile();
    const index = file.keys.findIndex((record) => record.id === id);
    if (index < 0) return { ok: false, error: "api_key_not_found" };
    file.keys.splice(index, 1);
    await this.saveNow();
    return { ok: true, id };
  }

  /** 用量归零（累计与今日都清，`lastUsedAt` 也清：它记的是「上一轮统计」的使用）。*/
  async resetUsage(id: string): Promise<ApiKeyResult> {
    const record = await this.find(id);
    if (!record) return { ok: false, error: "api_key_not_found" };
    record.usage = emptyUsage(localDateString(this.now()));
    await this.saveNow();
    return { ok: true, record: summarizeApiKey(record) };
  }

  /**
   * 校验一把明文 key，返回它对应的记录（没有 / 禁用 / 不对都回 `null`）。
   *
   * 比较是 `timingSafeEqual`：先按 id 定位（id 就是 hash 的前缀，找不找得到不泄露
   * 秘密），再在常数时间里比完整 hash。禁用的 key 与「不存在」返回同一个结果，
   * 调用方也只回一个 401。
   */
  async authenticate(presented: string): Promise<ApiKeyRecord | null> {
    const key = presented.trim();
    if (!key) return null;
    const hash = hashApiKey(key);
    const record = await this.find(apiKeyIdOf(hash));
    if (!record || !record.enabled) return null;
    const expected = Buffer.from(record.hash, "hex");
    const actual = Buffer.from(hash, "hex");
    if (expected.length !== actual.length) return null;
    return timingSafeEqual(expected, actual) ? record : null;
  }

  /**
   * 用量通知（{@link DataPlaneObserver}）：只改内存，不写盘。
   *
   * 从记录里只读四个字段（key、状态码、两个 token 数），其余一概不看。
   * `apiKeyId` 为空（会话 cookie / 表空放行）或指向一条已经不存在的 key 时静默忽略：
   * 用户刚删掉一把 key，而它上一个请求的收尾才到，这不是错误。
   */
  async onRequestEnd(record: RequestRecord): Promise<void> {
    if (!record.apiKeyId) return;
    const found = await this.find(record.apiKeyId);
    if (!found) return;

    const now = this.now();
    const usage = rollUsage(found.usage, localDateString(now));
    usage.requests += 1;
    usage.todayRequests += 1;
    if ((record.status ?? 0) >= 400) usage.errors += 1;
    const inputTokens = record.inputTokens ?? 0;
    const outputTokens = record.outputTokens ?? 0;
    if (inputTokens > 0) usage.inputTokens += Math.floor(inputTokens);
    if (outputTokens > 0) usage.outputTokens += Math.floor(outputTokens);
    usage.lastUsedAt = now;
    usage.todayDate = localDateString(now);
    found.usage = usage;

    this.pendingUsage += 1;
    if (this.pendingUsage >= USAGE_FLUSH_REQUEST_THRESHOLD) {
      // 记账失败不能把一次已经完成的代理请求变成错误（调用方不接这个 Promise 的值）。
      await this.flush().catch((e: unknown) => log.warn("usage flush failed", { message: (e as Error).message }));
      return;
    }
    this.scheduleFlush();
  }

  /**
   * 把攒着的用量写下去。
   *
   * 没有待写内容时直接返回，退出路径因此不会多一次无意义的磁盘往返。返回值是
   * **写完之后**才解决：`bootstrap.ts` 的关闭路径要在退出前等它。
   */
  async flush(): Promise<void> {
    this.clearFlushTimer();
    const pending = this.pendingUsage;
    if (pending === 0) return;
    await this.persist();
    // 写盘期间新到的用量还没进这份文件，计数只减掉这次写进去的那些。
    this.pendingUsage -= pending;
  }

  /** 丢弃缓存（测试与「文件被外部替换」的极端场景用）。*/
  reload(): void {
    this.clearFlushTimer();
    this.pendingUsage = 0;
    this.file = null;
    this.loading = null;
  }

  /** 首次访问时读一次（并发的调用共享同一次读，见 {@link loading}）。*/
  private async loadFile(): Promise<ApiKeysFile> {
    if (this.file) return this.file;
    this.loading ??= this.store.load().then((file) => {
      this.file = file;
      this.loading = null;
      return file;
    });
    return this.loading;
  }

  private async find(id: string): Promise<ApiKeyRecord | null> {
    return (await this.loadFile()).keys.find((record) => record.id === id) ?? null;
  }

  /**
   * 落盘，并把写盘串起来。
   *
   * 串行是必需的：内存表是同一个可变对象，两次并发写（攒批 flush 与一次结构性变更）
   * 各自快照一次内容，谁最后 rename 谁说了算。中间夹着 await，所以「后发起的写」不
   * 一定「后完成」，串起来才有确定的顺序。
   */
  private async persist(): Promise<void> {
    const file = await this.loadFile();
    const next = this.writes.then(() => this.store.save(file));
    // 链上保留一个不 reject 的尾巴，否则一次写失败会让后续所有写都跟着失败。
    this.writes = next.catch(() => {});
    await next;
  }

  /** 结构性变更（创建 / 启停 / 删除 / 归零）立刻落盘，不等攒批。*/
  private async saveNow(): Promise<void> {
    this.clearFlushTimer();
    const pending = this.pendingUsage;
    await this.persist();
    this.pendingUsage -= pending;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    const timer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((e: unknown) => log.warn("usage flush failed", { message: (e as Error).message }));
    }, USAGE_FLUSH_INTERVAL_MS);
    // 定时器不该拖住进程退出：入口会在关闭路径上显式 flush 一次（见单例的注释）。
    timer.unref?.();
    this.flushTimer = timer;
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}

/**
 * 进程级单例。
 *
 * 数据面鉴权（`server.ts`）与控制面命令（`control/control.ts`）必须是同一个实例：
 * 两份实例各自持有一份内存表，控制面读到的用量会永远停在 0，而创建 / 删除也只有一份
 * 能看见。与 `getDefaultClientSigning()` / `getDefaultHighspeedSlots()` 同一模式，
 * 测试通过构造参数注入自己的实例。
 */
let defaultManager: ApiKeyManager | null = null;

/** 取进程级单例（首次调用时创建，并挂上退出时的 flush）。*/
export function getDefaultApiKeyManager(): ApiKeyManager {
  if (!defaultManager) {
    const manager = new ApiKeyManager();
    defaultManager = manager;
    /*
     * 退出前把攒着的用量落盘。
     *
     * 挂 `beforeExit` 而不是 `exit`：`exit` 回调里不能 await，而加密现在是异步的
     * （WebCrypto），在那里发起的写永远完不成。`beforeExit` 在事件循环排空时触发，
     * 那时挂上去的 Promise 还能跑完。
     *
     * 显式 `process.exit()`（面板 shutdown、SIGTERM）不触发 `beforeExit`，那条路
     * 由 `bootstrap.ts` 的关闭路径先 `await flush()` 再退出。
     */
    process.once("beforeExit", () => {
      manager.flush().catch((e: unknown) => {
        // 退出路径上写盘失败已经没地方报告了，只留一行日志；抛出去只会把退出码变成
        // 异常退出，反而掩盖真正的退出原因。
        log.warn("usage flush on exit failed", { message: (e as Error).message });
      });
    });
  }
  return defaultManager;
}
