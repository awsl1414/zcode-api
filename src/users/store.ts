/**
 * 用户仓：`~/.zcode-proxy/users.json`。
 *
 * 三条结论照抄 `accounts/store.ts`，实现都在 `src/storage/` 里，这里只留「什么算
 * 合法的用户记录」：
 *
 * 1. KDF = SHA-256(seed)，seed 优先取 `ZCODE_PROXY_CREDENTIAL_SECRET`，否则取
 *    `{homedir}-{platform}-{arch}`。用户在账号文件上设同一个环境变量就够。
 * 2. 原子写：临时文件 `0o600` + rename，写到一半断电不会留下半截 JSON。
 * 3. 损坏即空仓：解密失败 / 结构不对只告警并当作「没有用户」，绝不抛异常。密钥是
 *    机器相关的，跨机器拷贝必然解不开；把它当致命错误会让面板起不来，而用户只是
 *    「还没建管理员」，下次启动会重新生成一个。
 *
 * 与账号文件唯一的差别是内容：用户表存的是管理员账号，也不做迁移（控制面用户是
 * 5.0 新加的概念，没有历史文件要读）。
 */
import { join } from "node:path";
import { logger } from "../log/index.js";
import { jsonStore, machineCodec } from "../storage/index.js";
import type { JsonStore } from "../storage/index.js";
import { getStoreDir } from "../storage/store.js";
import { USERS_STORE_VERSION, emptyUsersFile } from "./types.js";
import type { UserRecord, UsersFile } from "./types.js";

/** 用户仓的日志（存储层的降级由 `storage/store.ts` 记，这里只记条目自己的问题）。*/
const log = logger("users");

const USERS_FILE = "users.json";

/** 用户文件路径。存储目录与账号文件共用（`ZCODE_PROXY_STORE_DIR` 在测试里覆盖它）。*/
export function getUsersPath(): string {
  return join(getStoreDir(), USERS_FILE);
}

/**
 * 存储后端接口。抽出来的理由与 `accounts/store.ts` 相同：用户管理逻辑（校验、
 * 改密码、幂等）与文件格式是两件事，混在一起测会把每个用例都变成 IO 用例。
 */
export interface UsersStore {
  load(): Promise<UsersFile>;
  save(file: UsersFile): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 单条用户的最低结构检查：缺字段的条目丢弃并告警。*/
function isUserShape(value: unknown): value is UserRecord {
  if (!isRecord(value)) return false;
  if (typeof value.username !== "string" || !value.username) return false;
  if (typeof value.passwordHash !== "string" || !value.passwordHash) return false;
  if (typeof value.salt !== "string" || !value.salt) return false;
  if (typeof value.createdAt !== "number") return false;
  return true;
}

/** 校验解密后的明文结构，返回可用对象（结构损坏则 null）。*/
function reviveUsersFile(plain: unknown): UsersFile | null {
  if (!isRecord(plain)) return null;
  if (plain.version !== USERS_STORE_VERSION) return null;
  if (!Array.isArray(plain.users)) return null;

  const users: UserRecord[] = [];
  for (const [index, entry] of plain.users.entries()) {
    if (isUserShape(entry)) {
      users.push(entry);
    } else {
      log.warn("dropping malformed user entry", { index, path: getUsersPath() });
    }
  }
  return { version: USERS_STORE_VERSION, users };
}

/** 落盘形状：只写这两个字段。*/
function payloadOf(file: UsersFile): UsersFile {
  return { version: USERS_STORE_VERSION, users: file.users };
}

const store: JsonStore<UsersFile> = jsonStore<UsersFile>({
  fileName: USERS_FILE,
  version: USERS_STORE_VERSION,
  codec: machineCodec(),
  fallback: emptyUsersFile,
  revive: reviveUsersFile,
});

/** 文件存储后端（生产唯一实现）。*/
export const fileUsersStore: UsersStore = {
  load: () => store.load(),
  save: (file) => store.save(payloadOf(file)),
};
