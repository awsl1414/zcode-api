/**
 * 一份加密 JSON 文件的读写。
 *
 * 四个仓（账号 / 用户 / API key / 策略）除了「什么算合法」之外，读写流程一模一样：
 * 整份文件加密、临时文件 `0o600` + rename、任何一步失败都退回空值只告警。这四处
 * 各写一遍的后果不是行数，是**失败语义会漂**：一处删掉坏文件、另一处保留，用户遇到
 * 的问题就变成「有时候能恢复」。
 *
 * 接口刻意与「文件」无关（`describe()` 而不是 `path()`）：将来要加 SQLite 时新增
 * `src/storage/sqlite-store.ts`，返回同一个 `JsonStore<T>`，调用方只换构造那一行。
 *
 * 三条降级，前提都是「损坏即空仓」——坏数据从不阻断启动，也从不删文件：
 *
 * 1. 文件不存在 → `fallback()`。这是常态，不是错误。
 * 2. 读不了 / 不是 JSON / 没有密文载荷 / 解不开 → 告警 + `fallback()`，**不删文件**。
 *    坏文件可能是「用户把文件拷到了另一台机器」或「env secret 变了」，留着才能恢复。
 * 3. 解密出来但结构不对（`revive` 返回 null）→ 告警 + `fallback()`。
 *
 * `fallback` 是函数不是值：每次返回新对象，调用方拿到的那份不会有第二个调用方
 * 共享同一个可变数组。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { logger } from "../log/index.js";
import type { Codec } from "./codec.js";

/** 存储层的日志。每条降级都要留痕：它们是「数据莫名消失」的唯一线索。*/
const log = logger("storage");

/**
 * 存储目录覆盖。生产固定 `~/.zcode-proxy`；这个缝是给测试用的：模块级路径常量
 * 会把测试钉到真实用户目录，在已登录的机器上跑测试会删掉真凭据（2026-09-18 的
 * 事故）。按调用取值，模块加载后再设环境变量也生效。
 */
const ENV_STORE_DIR = "ZCODE_PROXY_STORE_DIR";

/**
 * 存储目录（每次调用重新解析，见 {@link ENV_STORE_DIR}）。
 *
 * 所有仓共用这一个目录判定，改位置只改这里。
 */
export function getStoreDir(): string {
  return process.env[ENV_STORE_DIR]?.trim() || join(homedir(), ".zcode-proxy");
}

/** 一份 JSON 文件的读写。换后端（SQLite）只换实现，不换这个形状。*/
export interface JsonStore<T> {
  load(): Promise<T>;
  save(value: T): Promise<void>;
  /** 删除文件（回到「没有这份数据」）。*/
  clear(): void;
  /** 给人看的标识（日志与错误信息用），例如 `accounts.json`。*/
  describe(): string;
}

export interface JsonStoreOptions<T> {
  /** 存储目录下的文件名。路径细节不出这个模块。*/
  fileName: string;
  /**
   * 外层明文档位（加密包装里的 `version`）。
   *
   * 它让未来的格式升级能在**不解密**的情况下判断「这是不是我能读的文件」。
   * 加密的仓必填；`plaintext` 的仓不写外层包装，因此也不需要它。
   */
  version?: number;
  /** 加解密。`plaintext: true` 时不需要。*/
  codec?: Codec;
  /** 读失败时的空值。每次调用返回新对象，不要共享可变状态。*/
  fallback: () => T;
  /** 校验解密后的结构，不合法返回 null。每个仓的「什么算合法」不同。*/
  revive: (plain: unknown) => T | null;
  /**
   * 明文档位。
   *
   * 只给 `policy.json` 用：它存的是策略，没有凭据，加密只会让「删掉坏文件就回到
   * config.yaml 基线」这条恢复路径变得不可读。明文档按人读得懂的缩进写。
   */
  plaintext?: boolean;
}

/**
 * 基于单个 JSON 文件的存储。
 *
 * 整个 `T` 一起加密（不逐条加密，避免泄露条目数量）。写入走
 * {@link writeAtomically}，读取的降级见文件头。
 */
export function jsonStore<T>(options: JsonStoreOptions<T>): JsonStore<T> {
  const plaintext = options.plaintext === true;
  const codec = options.codec;
  if (!plaintext && codec === undefined) {
    throw new Error(`jsonStore(${options.fileName}): codec is required unless plaintext`);
  }
  if (!plaintext && options.version === undefined) {
    throw new Error(`jsonStore(${options.fileName}): version is required unless plaintext`);
  }

  const describe = (): string => options.fileName;
  const filePath = (): string => join(getStoreDir(), options.fileName);

  /**
   * 读出**明文 JSON 文本**：明文档直接返回文件内容，加密的仓先解开外层包装。
   *
   * 返回 null 表示「读不到」，具体原因已经写过告警。刻意不抛异常：调用方只需要
   * 「有内容」或「没内容」两种结果。
   */
  async function readPlaintext(path: string): Promise<string | null> {
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (e) {
      log.warn("ignoring unreadable store", { store: describe(), path, message: (e as Error).message });
      return null;
    }

    if (plaintext) return raw;

    let wrapper: unknown;
    try {
      wrapper = JSON.parse(raw);
    } catch (e) {
      log.warn("ignoring unreadable store", { store: describe(), path, message: (e as Error).message });
      return null;
    }
    if (typeof wrapper !== "object" || wrapper === null || typeof (wrapper as { encrypted?: unknown }).encrypted !== "string") {
      log.warn("ignoring store without encrypted payload", { store: describe(), path });
      return null;
    }

    try {
      return await codec!.decode((wrapper as { encrypted: string }).encrypted);
    } catch (e) {
      // 密钥是机器相关的（{homedir}-{platform}-{arch}），跨机器拷贝或重装系统必然
      // 解不开。当成「没有数据」，不阻断启动。
      log.warn("ignoring undecryptable store", { store: describe(), path, message: (e as Error).message });
      return null;
    }
  }

  return {
    describe,

    async load(): Promise<T> {
      const path = filePath();
      if (!existsSync(path)) return options.fallback();

      const text = await readPlaintext(path);
      if (text === null) return options.fallback();

      let plain: unknown;
      try {
        plain = JSON.parse(text);
      } catch (e) {
        log.warn("ignoring unreadable store", { store: describe(), path, message: (e as Error).message });
        return options.fallback();
      }

      const value = options.revive(plain);
      if (value === null) {
        log.warn("ignoring store with unexpected structure", { store: describe(), path });
        return options.fallback();
      }
      return value;
    },

    async save(value: T): Promise<void> {
      const path = filePath();
      let contents: string;
      if (plaintext) {
        // 明文档按人读得懂的缩进写，末尾留换行：用户会用编辑器打开它。
        contents = `${JSON.stringify(value, null, 2)}\n`;
      } else {
        const encrypted = await codec!.encode(JSON.stringify(value));
        contents = JSON.stringify({ version: options.version, encrypted });
      }
      writeAtomically(path, contents);
    },

    clear(): void {
      const path = filePath();
      if (existsSync(path)) unlinkSync(path);
    },
  };
}

/**
 * 原子写：临时文件 `0o600` + rename。
 *
 * 写到一半断电不会留下半截 JSON 把用户所有数据弄丢。文件名带 pid 与时间戳，避免
 * 同目录下的并发进程互相踩临时文件（多实例同时改同一份数据不在目标里，但踩掉对方
 * 的临时文件会让 rename 拿到别人的内容）。
 */
function writeAtomically(target: string, contents: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, target);
}
