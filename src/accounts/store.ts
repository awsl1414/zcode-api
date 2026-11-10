/**
 * v2 账号仓：`~/.zcode-proxy/accounts.json`。
 *
 * 加密、密钥派生、原子写都在 `src/storage/` 里：四个仓（账号 / 用户 / API key /
 * 策略）共用同一套 AES-256-GCM 与「临时文件 + rename」，任何一处改了 KDF
 * 其余三处不跟，用户的数据就互相解不开。这个文件只剩「账号文件里什么算合法」。
 *
 * 三条既有结论（理由写在 `src/storage/codec.ts` 与 `src/storage/store.ts`）：
 *
 * 1. KDF = SHA-256(seed)，seed 优先取 `ZCODE_PROXY_CREDENTIAL_SECRET`，否则取
 *    `{homedir}-{platform}-{arch}`。
 * 2. 原子写：临时文件 `0o600` + rename，写到一半断电不会留下半截 JSON。
 * 3. 损坏即空仓：解密失败 / 结构不对只告警并当作「没有账号」，绝不抛异常。密钥是
 *    机器相关的，重导一次凭据就好；把它当致命错误会让代理起不来。
 *
 * 文件里只有一份密文，装的是整个 `{version, accounts}` 对象：账号是互相引用的整体，
 * 逐条加密既无法保证一致性，也会泄露账号数量。外层留 `version: 2` 明文，密文里再放
 * 一遍：外层那份让未来的格式升级能在不解密的情况下判断「这是不是我能读的文件」。
 *
 * 账号只从 `accounts.json` 加载，启动即空账号；没有别的凭据来源。
 */
import { join } from "node:path";
import { logger } from "../log/index.js";
import { jsonStore, machineCodec } from "../storage/index.js";
import type { JsonStore } from "../storage/index.js";
import { getStoreDir } from "../storage/store.js";
import { ACCOUNTS_STORE_VERSION, emptyAccountsFile } from "./types.js";
import type { Account, AccountsFile } from "./types.js";

/**
 * 账号仓的日志。存储层的降级由 `storage/store.ts` 记（`store: "accounts.json"`），
 * 这里只记账号条目自己的问题。
 */
const log = logger("accounts");

const ACCOUNTS_FILE = "accounts.json";

/**
 * 存储目录。实现搬到了 `src/storage/store.ts`（四个仓共用一份判定），这里重新导出
 * 是为了不让 `accounts/transfer.ts` 与既有调用方改 import。
 */
export { getStoreDir };

/** v2 账号文件路径。*/
export function getAccountsPath(): string {
  return join(getStoreDir(), ACCOUNTS_FILE);
}

/**
 * 存储后端接口。
 *
 * 抽出这个接口不是为了「将来换数据库」（JSON 就够用），而是为了让
 * manager 的单测不必碰磁盘：账号管理逻辑（校验、推断、幂等）与文件格式是两件
 * 事，混在一起测会把六条规则的用例变成 IO 用例。
 */
export interface AccountsStore {
  load(): Promise<AccountsFile>;
  save(file: AccountsFile): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 单条账号的最低结构检查。
 *
 * 只查「能不能当账号用」（id / label / credential / routes / policy 在位），不做
 * 语义校验：语义校验在写入时已经强制过，读取时再跑一遍会让一个历史遗留的
 * 不合规条目把整个文件读废。结构都不对的条目直接丢弃并告警，因为把它交给调度只会
 * 炸在更远的地方。
 */
function isAccountShape(value: unknown): value is Account {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || !value.id) return false;
  if (typeof value.label !== "string" || !value.label) return false;
  if (typeof value.enabled !== "boolean") return false;
  if (!Array.isArray(value.routes)) return false;
  if (!isRecord(value.credential) || typeof value.credential.kind !== "string") return false;
  if (!isRecord(value.policy)) return false;
  return true;
}

/** 校验解密后的明文结构，返回可用对象（结构损坏则 null）。*/
function reviveAccountsFile(plain: unknown): AccountsFile | null {
  if (!isRecord(plain)) return null;
  if (plain.version !== ACCOUNTS_STORE_VERSION) return null;
  if (!Array.isArray(plain.accounts)) return null;

  const accounts: Account[] = [];
  for (const [index, entry] of plain.accounts.entries()) {
    if (isAccountShape(entry)) {
      accounts.push(entry);
    } else {
      log.warn("dropping malformed account entry", { index, path: getAccountsPath() });
    }
  }
  return { version: ACCOUNTS_STORE_VERSION, accounts };
}

/** 落盘形状：只写这两个字段，读到的历史杂项（4.x 的 `activeId`）不会带回去。*/
function payloadOf(file: AccountsFile): AccountsFile {
  return { version: ACCOUNTS_STORE_VERSION, accounts: file.accounts };
}

const store: JsonStore<AccountsFile> = jsonStore<AccountsFile>({
  fileName: ACCOUNTS_FILE,
  version: ACCOUNTS_STORE_VERSION,
  codec: machineCodec(),
  fallback: emptyAccountsFile,
  revive: reviveAccountsFile,
});

/** 文件存储后端（生产唯一实现）。*/
export const fileAccountsStore: AccountsStore = {
  load: () => store.load(),
  save: (file) => store.save(payloadOf(file)),
};
