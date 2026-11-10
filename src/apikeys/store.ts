/**
 * API key 仓：`~/.zcode-proxy/apikeys.json`。
 *
 * 三条结论与 `users/store.ts`、`accounts/store.ts` 相同，实现都在 `src/storage/`
 * 里，这里只留「什么算合法的 key 记录」与用量字段的归一：
 *
 * 1. KDF = SHA-256(seed)，seed 优先取 `ZCODE_PROXY_CREDENTIAL_SECRET`，否则取
 *    `{homedir}-{platform}-{arch}`。用户在三个文件上设同一个环境变量就够。
 * 2. 原子写：临时文件 `0o600` + rename，写到一半断电不会留下半截 JSON。
 * 3. 损坏即空仓：解密失败 / 结构不对只告警并当作「没有 key」，绝不抛异常。
 *
 * 密文统一走 `crypto.subtle`，落盘时机由 `apikeys/manager.ts` 的 `beforeExit` 与
 * `bootstrap.ts` 的关闭路径负责（两处都注释了理由）：`process.on("exit")` 里不允许
 * await，所以不能用「进程退出时同步 flush 一次」。密文格式是
 * `base64(iv ‖ ciphertext ‖ tag)`，旧版本写下的文件照常读得开。
 */
import { join } from "node:path";
import { logger } from "../log/index.js";
import { jsonStore, machineCodec } from "../storage/index.js";
import type { JsonStore } from "../storage/index.js";
import { getStoreDir } from "../storage/store.js";
import { API_KEYS_STORE_VERSION, emptyApiKeysFile, emptyUsage } from "./types.js";
import type { ApiKeyRecord, ApiKeyUsage, ApiKeysFile } from "./types.js";

/** 数据面 key 仓的日志（存储层的降级由 `storage/store.ts` 记）。*/
const log = logger("apikeys");

const API_KEYS_FILE = "apikeys.json";

/** key 文件路径。与账号 / 用户文件同目录（测试用 `ZCODE_PROXY_STORE_DIR` 覆盖）。*/
export function getApiKeysPath(): string {
  return join(getStoreDir(), API_KEYS_FILE);
}

/**
 * 存储后端接口。抽出来的理由与 `users/store.ts` 相同：管理逻辑（校验、吊销、用量
 * 累加）与文件格式是两件事，混在一起测会把每个用例都变成 IO 用例。
 */
export interface ApiKeysStore {
  load(): Promise<ApiKeysFile>;
  save(file: ApiKeysFile): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 非负整数，否则回落 `fallback`（手改坏一个计数不该让整条 key 消失）。*/
function count(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/**
 * 用量结构归一。
 *
 * 计数与日期是**展示数据**，缺了归零即可；因此这里只做归一、不丢弃整条记录（丢弃
 * 等于让那个客户端手里的 key 突然失效，代价远大于「今日计数从 0 开始」）。
 */
function reviveUsage(value: unknown): ApiKeyUsage {
  const raw = isRecord(value) ? value : {};
  const base = emptyUsage(typeof raw.todayDate === "string" ? raw.todayDate : "");
  return {
    ...base,
    requests: count(raw.requests),
    inputTokens: count(raw.inputTokens),
    outputTokens: count(raw.outputTokens),
    errors: count(raw.errors),
    lastUsedAt: typeof raw.lastUsedAt === "number" && Number.isFinite(raw.lastUsedAt) ? raw.lastUsedAt : null,
    todayRequests: count(raw.todayRequests),
  };
}

/**
 * 单条 key 的最低结构检查。
 *
 * `id` / `hash` / `prefix` / `secret` 是**凭据与索引材料**，缺一个就无法校验 /
 * 定位 / 回显，只能丢弃并告警。`secret` 是契约必填字段：缺 = 损坏记录，丢弃重建。
 * 名称与用量缺了可以补（名称补成一个可辨认的占位）。
 */
function reviveRecord(value: unknown): ApiKeyRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (typeof value.hash !== "string" || !value.hash) return null;
  if (typeof value.prefix !== "string" || !value.prefix) return null;
  if (typeof value.secret !== "string" || !value.secret) return null;
  return {
    id: value.id,
    name: typeof value.name === "string" && value.name ? value.name : value.prefix,
    hash: value.hash,
    secret: value.secret,
    prefix: value.prefix,
    enabled: value.enabled !== false,
    createdAt: typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : 0,
    usage: reviveUsage(value.usage),
  };
}

/** 校验解密后的明文结构，返回可用对象（结构损坏则 null）。*/
function reviveApiKeysFile(plain: unknown): ApiKeysFile | null {
  if (!isRecord(plain)) return null;
  if (plain.version !== API_KEYS_STORE_VERSION) return null;
  if (!Array.isArray(plain.keys)) return null;

  const keys: ApiKeyRecord[] = [];
  for (const [index, entry] of plain.keys.entries()) {
    const record = reviveRecord(entry);
    if (record) keys.push(record);
    else log.warn("dropping malformed api key entry", { index, path: getApiKeysPath() });
  }
  return { version: API_KEYS_STORE_VERSION, keys };
}

/** 落盘形状：只写这两个字段。*/
function payloadOf(file: ApiKeysFile): ApiKeysFile {
  return { version: API_KEYS_STORE_VERSION, keys: file.keys };
}

const store: JsonStore<ApiKeysFile> = jsonStore<ApiKeysFile>({
  fileName: API_KEYS_FILE,
  version: API_KEYS_STORE_VERSION,
  codec: machineCodec(),
  fallback: emptyApiKeysFile,
  revive: reviveApiKeysFile,
});

/** 文件存储后端（生产唯一实现）。*/
export const fileApiKeysStore: ApiKeysStore = {
  load: () => store.load(),
  save: (file) => store.save(payloadOf(file)),
};
