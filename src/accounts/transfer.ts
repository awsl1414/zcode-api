import { randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ImportError, classifySecret, defaultCredentialsPath, importCredential, parseJwtSource } from "../auth/import.js";
import { inspectJwt } from "../auth/jwt-age.js";
import type { ProviderId } from "../provider/types.js";
import { enrollCredential, toAccountCredential } from "./enroll.js";
import { AccountError, validateAccount } from "./manager.js";
import { getStoreDir } from "./store.js";
import type { Account, Credential as AccountCredential } from "./types.js";
import { identityOf, isPositiveInteger, maskAccount, pathOf } from "./summary.js";
import { accountCommandError } from "../control/control.js";
import type { AddCommand, ControlError, ControlResponse, ExportCommand, HandlerContext, ImportCommand } from "../control/control.js";
import { logger } from "../log/index.js";

/** 账号子系统的日志：调度、额度采样、导入导出。*/
const log = logger("accounts");

/** 导出文件权限：凭据密文/明文都只给本用户。*/
const EXPORT_FILE_MODE = 0o600;

/**
 * scrypt 参数（导出包用 AES-GCM，密钥由用户密码经 scrypt 派生）。
 *
 * 导出而不是留在本文件：控制面用户密码（`users/manager.ts`）用的是同一套参数。
 * 同一台机器上两种密码保护不该有强弱之分，两份常量迟早会漂移，而漂移的方向
 * 通常是把新写的那份调弱。
 */
export const SCRYPT_COST = 16_384;

export const SCRYPT_BLOCK_SIZE = 8;

export const SCRYPT_PARALLELIZATION = 1;

export const SCRYPT_SALT_BYTES = 16;

export const SCRYPT_KEY_BYTES = 32;

/** AES-GCM 的 IV 长度（字节）。*/
const GCM_IV_BYTES = 12;

/**
 * GCM 认证标签的长度（字节）。
 *
 * 导出包里 tag 是单独一个字段（`tag`），而 WebCrypto 的 `encrypt` 把它拼在密文末尾，
 * 所以加密后按这个长度切一刀、解密前再拼回去。16 = 128 位，是 WebCrypto 的默认值，
 * 也是这份格式从 4.x 就在用的长度。
 */
const GCM_TAG_BYTES = 16;

/** 导出包的格式标记与版本（导入时靠它区分“我们的包”与 ZCode 凭据文件）。*/
const EXPORT_BUNDLE_KIND = "zcode-proxy-accounts";

const EXPORT_BUNDLE_VERSION = 1;

/** 没有指定 `--out` / `out` 时的导出文件名前缀（落在存储目录里）。*/
const EXPORT_FILE_PREFIX = "accounts-export";

/**
 * 浏览器下载的文件名前缀：`zcode-accounts-YYYYMMDD-HHmmss.json`。
 *
 * 与日志页的 `zcode-requests-*` 同一套命名（`app-constants.js`
 * `REQUESTS_EXPORT_PREFIX`）：前缀统一，下载目录里能按名字找到；时刻是**本地时间**
 * （`toISOString` 的 UTC 会让晚上导出的文件看起来是第二天）。
 */
const INLINE_FILE_PREFIX = "zcode-accounts";

/** `zhipu-account` 凭据：套餐账号（coding-plan / start-plan 及派生入口）。*/
type PlanCredential = Extract<AccountCredential, { kind: "zhipu-account" }>;

/** 带身份面的账号（`deviceMid` 一账号一指纹的检查只针对这类）。*/
export type PlanAccount = Account & { credential: PlanCredential };

/** `addAccount` 的凭据构造结果。*/
type CredentialResult = { ok: true; credential: AccountCredential } | ControlError;

/** 导出包的明文形态（加密时整体作为 GCM 明文）。*/
interface AccountsBundle {
  kind: typeof EXPORT_BUNDLE_KIND;
  version: typeof EXPORT_BUNDLE_VERSION;
  exportedAt: number;
  accounts: Account[];
}

/** 加密导出包（AES-256-GCM；密钥由密码 + salt 经 scrypt 派生）。*/
interface EncryptedBundle {
  kind: typeof EXPORT_BUNDLE_KIND;
  version: typeof EXPORT_BUNDLE_VERSION;
  encrypted: true;
  kdf: { name: "scrypt"; cost: number; blockSize: number; parallelization: number; salt: string };
  iv: string;
  tag: string;
  data: string;
}

/**
 * `addAccount` 的凭据构造。
 *
 * 两种来源最终都落到同一个凭据形状上，白名单默认由凭据能力推断，
 * 控制面不自己算“这个 key 能开哪条路由”，那是 `manager.ts::inferRoutes` 的事。
 *
 * `file` 有两种输入：凭据文件（路径或内容）与手工粘贴的 `{apiKeyId}.{secret}`。
 * 两者产出同一个形状（`auth/import.ts` 的 `api-key-pair` 分支），所以没有单独的
 * 来源值（删掉的是按量计费的 key，这个不是）。
 */
export async function buildAccountCredential(cmd: AddCommand, ctx: HandlerContext): Promise<CredentialResult> {
  if (cmd.source === "file") {
    return cmd.apiKey ? credentialFromApiKeyPair(cmd, await manualKeyProvider(cmd, ctx)) : credentialFromFile(cmd, ctx);
  }
  if (cmd.source === "jwt") return credentialFromJwt(cmd);
  return { ok: false, error: "invalid_account_source" };
}

/**
 * 手工 key 的 provider：显式给的 → 第一个账号的 → 默认 family。
 *
 * `{apiKeyId}.{secret}` 里没有 provider（两家都长这样），所以它只能来自用户选择
 * 或账号表里已有的账号。凭据文件那条路不用它：文件自己带着
 * `oauth:active_provider`。
 */
async function manualKeyProvider(cmd: AddCommand, ctx: HandlerContext): Promise<ProviderId> {
  return cmd.provider ?? await firstAccountProvider(ctx) ?? DEFAULT_PROVIDER;
}

/**
 * `source: "file"` 的手工 key：`{apiKeyId}.{secret}` 整串。
 *
 * 与 `auth/import.ts` 的 `api-key-pair` 分支同一套拆分规则（第一个点号切两段），
 * 所以两条入口建出来的账号在指纹、鉴权头上完全一致。单段 key 不接受：上游的
 * apiKey form 要两段，收下它只会变成一个 401 账号。
 */
function credentialFromApiKeyPair(cmd: AddCommand, provider: ProviderId): CredentialResult {
  const raw = cmd.apiKey?.trim();
  if (!raw || classifySecret(raw) !== "api-key-pair") return { ok: false, error: "invalid_api_key" };
  const dot = raw.indexOf(".");
  const credential: PlanCredential = {
    kind: "zhipu-account",
    provider,
    apiKey: raw.slice(0, dot),
    secret: raw.slice(dot + 1),
    identity: identityOf(cmd),
  };
  return { ok: true, credential };
}

/**
 * `source: "file"`：走 `auth/import.ts` 的解析与 OAuth 换 key。
 *
 * `load: () => null` + 空 `save` 是刻意的：这个命令是“新增一个账号”，不是“把凭据
 * 合并进已有的那个”。合并规则（同 provider 合并、provider 不一致就拒）属于
 * `auth import` 的语义，不能因为走控制面就静默变成“覆盖现有账号”。
 */
async function credentialFromFile(cmd: AddCommand, ctx: HandlerContext): Promise<CredentialResult> {
  const path = pathOf(cmd.file) ?? defaultCredentialsPath();
  let report;
  try {
    report = await importCredential({
      file: path,
      ...(cmd.content !== undefined ? { content: cmd.content } : {}),
      ...(cmd.provider ? { provider: cmd.provider } : {}),
      defaultProvider: (await firstAccountProvider(ctx)) ?? DEFAULT_PROVIDER,
      load: async () => null,
      save: async () => {},
    });
  } catch (err) {
    if (err instanceof ImportError) return { ok: false, error: `import_${err.code}` };
    throw err;
  }
  const credential = toAccountCredential(report.credential);
  // 文件导入不携带身份作用域（TEAM 的三个 id 要从上游发现才拿得到），
  // 用户显式给了才覆盖；`deviceMid` 永远由代理生成，不进协议。
  if (cmd.identity) credential.identity = identityOf(cmd);
  return { ok: true, credential };
}

/** `source: "jwt"`：粘贴的 plan JWT，离线校验（只能开 start-plan 那半边）。*/
function credentialFromJwt(cmd: AddCommand): CredentialResult {
  const raw = cmd.jwt?.trim();
  if (!raw) return { ok: false, error: "invalid_jwt" };
  try {
    // 只做校验：`parseJwtSource` 回答“这是不是一个能落盘的 plan JWT”（`token_version`
    // 载荷 + 可读 `iat`），结果里的 `jwt` 就是上面那个 `raw`，不必再搬一次。
    parseJwtSource(raw);
  } catch (err) {
    if (err instanceof ImportError) return { ok: false, error: "invalid_jwt" };
    throw err;
  }
  // JWT-only 账号的 `apiKey` 是空串，而 `jwt` 被指纹排除，所以账号身份只能靠
  // payload 的 `user_id`。它确实是账号级不变值，不属于“会轮换的值”。
  const upstreamUserId = inspectJwt(raw)?.userId;
  const credential: PlanCredential = {
    kind: "zhipu-account",
    provider: cmd.provider ?? DEFAULT_PROVIDER,
    apiKey: "",
    // `raw` 已经过 `parseJwtSource` 的离线校验（`token_version` + 可读 `iat`），
    // 直接用它而不是回读 `parsed.jwt`（那个字段在类型上可缺省）。
    jwt: raw,
    ...(upstreamUserId ? { upstreamUserId } : {}),
    identity: identityOf(cmd),
  };
  return { ok: true, credential };
}

/**
 * 导出。`masked` 不落盘，只回清单 —— 掩码清单的用途是审计，不是备份。
 *
 * 两种产物形态：
 *
 * - `inline: true`：**不碰磁盘**，整份包放进应答（`payload` + `filename`），由浏览器
 *   用 Blob + `<a download>` 落进用户的下载目录。网页走这条：服务端文件系统的路径
 *   对浏览器用户是不可见的，让用户去 `.zcode-proxy/` 里翻文件不是一次「导出」。
 * - 缺省（CLI 的 `out` 路径模式）：写服务端文件并回 `path`。`auth account export --out`
 *   与备份脚本要的是一个确定的落点，那条路的语义不能因为网页改了而变。
 */
export async function exportAccounts(cmd: ExportCommand, ctx: HandlerContext): Promise<ControlResponse> {
  const format = cmd.format;
  if (format !== "encrypted" && format !== "plain" && format !== "masked") {
    return { ok: false, error: "invalid_export_format" };
  }
  const accounts = await ctx.accounts.list();
  if (format === "masked") {
    return {
      ok: true,
      event: "accountsExported",
      format,
      count: accounts.length,
      accounts: accounts.map(maskAccount),
    };
  }

  // 明文导出需要二次确认（网页输 EXPORT、CLI 带 --force）。
  if (format === "plain" && cmd.force !== true) {
    return { ok: false, error: "plain_export_requires_confirmation" };
  }
  const password = typeof cmd.password === "string" ? cmd.password : "";
  if (format === "encrypted" && password.length === 0) {
    return { ok: false, error: "export_password_required" };
  }

  const bundle = buildBundle(accounts);
  const payload =
    format === "encrypted"
      ? JSON.stringify(await encryptBundle(bundle, password), null, 2)
      : JSON.stringify(bundle, null, 2);
  if (cmd.inline === true) {
    return {
      ok: true,
      event: "accountsExported",
      format,
      count: accounts.length,
      payload,
      filename: inlineExportFileName(new Date()),
    };
  }
  const path = pathOf(cmd.out) ?? defaultExportPath();
  writeExportFile(path, payload);
  return { ok: true, event: "accountsExported", format, count: accounts.length, path };
}

/**
 * 导入。两种输入靠文件内容区分，不靠扩展名：
 *
 * - 我们的导出包（`kind: "zcode-proxy-accounts"`，加密或明文）→ 逐账号写入；
 * - 其他 = ZCode 官方凭据文件 → 交给 `auth/import.ts` 的既有规则。
 *
 * 内容从哪来也是两条路：
 *
 * - `content`（网页）：浏览器 `<input type="file">` 读到的原文，**不落盘**
 *   （上传内容只读入内存）。服务端文件系统的路径对浏览器用户不可见，所以网页不能
 *   靠 `path` 说「哪个文件」。给了 `content` 时 `path` 只用于日志与来源标签。
 * - `path`（CLI）：`auth account import <path>` 与脚本继续按路径读。
 */
export async function importAccounts(cmd: ImportCommand, ctx: HandlerContext): Promise<ControlResponse> {
  const path = pathOf(cmd.path) ?? defaultCredentialsPath();
  const content = typeof cmd.content === "string" ? cmd.content : undefined;
  let text: string;
  if (content !== undefined) {
    text = content;
  } else {
    try {
      text = readFileSync(path, "utf-8");
    } catch (err) {
      // 路径不存在 / 不可读对用户是同一件事；原因进日志（不含凭据内容）。
      log.error("cannot read import file", { path, message: (err as Error).message }, err);
      return { ok: false, error: "import_file_not_found" };
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "import_file_malformed" };
  }
  if (isRecord(raw) && raw.kind === EXPORT_BUNDLE_KIND) {
    return importBundle(raw, cmd.password, ctx);
  }
  // 官方凭据文件：同样按内容交给 `auth/import.ts`，不把上传的东西先写进临时目录
  // （那份临时文件会是一份没人清理的凭据副本）。
  return importZcodeStore({ path, ...(content !== undefined ? { content } : {}) }, ctx);
}

/** 导入我们自己的导出包：**先全量校验再写**，不留半套。*/
async function importBundle(
  raw: Record<string, unknown>,
  password: string | undefined,
  ctx: HandlerContext,
): Promise<ControlResponse> {
  const decoded = await decodeBundle(raw, password);
  if (!decoded.ok) return decoded;

  for (const account of decoded.accounts) {
    try {
      // 写入时校验是唯一执行点，导入不能绕过它；先跑一遍全部条目，任何一条
      // 不合规就整包拒，避免“导入了一半”这种要用户去猜的状态。
      validateAccount(account);
    } catch (err) {
      return accountCommandError(err);
    }
  }

  const labels: string[] = [];
  for (const account of decoded.accounts) {
    const saved = await ctx.accounts.add({
      label: account.label,
      credential: account.credential,
      routes: account.routes,
      enabled: account.enabled,
      policy: account.policy,
    });
    labels.push(saved.label);
  }
  return { ok: true, event: "accountsImported", imported: labels.length, labels };
}

/** 导出包的解码（加密 → 解密；明文 → 结构检查）。*/
type DecodeResult = { ok: true; accounts: Account[] } | ControlError;

async function decodeBundle(raw: Record<string, unknown>, password: string | undefined): Promise<DecodeResult> {
  let plain: unknown = raw;
  if (raw.encrypted === true) {
    const wrapper = encryptedBundleOf(raw);
    if (!wrapper) return { ok: false, error: "import_invalid_bundle" };
    if (!password) return { ok: false, error: "import_password_required" };
    try {
      plain = JSON.parse(await decryptBundle(wrapper, password));
    } catch {
      // 密码错 / 密文被改 / 不是同一套 KDF 参数：对调用方都是同一件事。
      return { ok: false, error: "import_decrypt_failed" };
    }
  }
  if (!isRecord(plain) || plain.version !== EXPORT_BUNDLE_VERSION || !Array.isArray(plain.accounts)) {
    return { ok: false, error: "import_invalid_bundle" };
  }
  const accounts: Account[] = [];
  for (const entry of plain.accounts) {
    if (!isExportedAccount(entry)) return { ok: false, error: "import_invalid_bundle" };
    accounts.push(entry);
  }
  return { ok: true, accounts };
}

/** 加密包的字段检查（缺 KDF 参数的包既解不开也说不清，直接当非法包）。*/
function encryptedBundleOf(raw: Record<string, unknown>): EncryptedBundle | null {
  const kdf = raw.kdf;
  if (!isRecord(kdf)) return null;
  if (kdf.name !== "scrypt") return null;
  if (!isPositiveInteger(kdf.cost) || !isPositiveInteger(kdf.blockSize) || !isPositiveInteger(kdf.parallelization)) {
    return null;
  }
  if (typeof kdf.salt !== "string" || typeof raw.iv !== "string") return null;
  if (typeof raw.tag !== "string" || typeof raw.data !== "string") return null;
  return {
    kind: EXPORT_BUNDLE_KIND,
    version: EXPORT_BUNDLE_VERSION,
    encrypted: true,
    kdf: {
      name: "scrypt",
      cost: kdf.cost,
      blockSize: kdf.blockSize,
      parallelization: kdf.parallelization,
      salt: kdf.salt,
    },
    iv: raw.iv,
    tag: raw.tag,
    data: raw.data,
  };
}

/**
 * ZCode 官方凭据文件的导入（委托给 `auth/import.ts`，不在这里重写解析）。
 *
 * 来源有两种形态，与 `auth/import.ts::ImportOptions` 一一对应：
 *
 * - `content`：文件原文（网页 `<input type="file">`）。`importCredential` 见到它
 *   就不读磁盘，`path` 退化为「来源标签」（错误信息与 `source` 字段里那个名字）；
 * - 只有 `path`：CLI 按路径读（既有行为）。
 */
async function importZcodeStore(
  source: { path: string; content?: string },
  ctx: HandlerContext,
): Promise<ControlResponse> {
  const created: Account[] = [];
  try {
    await importCredential({
      file: source.path,
      ...(source.content !== undefined ? { content: source.content } : {}),
      defaultProvider: (await firstAccountProvider(ctx)) ?? DEFAULT_PROVIDER,
      load: async () => null,
      save: async (cred) => {
        created.push(await enrollCredential(ctx.accounts, cred));
      },
    });
  } catch (err) {
    if (err instanceof ImportError) return { ok: false, error: `import_${err.code}` };
    if (err instanceof AccountError) return accountCommandError(err);
    throw err;
  }
  return { ok: true, event: "accountsImported", imported: created.length, labels: created.map((a) => a.label) };
}

/** 导出包本体（`exportedAt` 只用于人看，导入时不读）。*/
function buildBundle(accounts: readonly Account[]): AccountsBundle {
  return {
    kind: EXPORT_BUNDLE_KIND,
    version: EXPORT_BUNDLE_VERSION,
    exportedAt: Date.now(),
    accounts: accounts.map((account) => ({ ...account, routes: [...account.routes] })),
  };
}

/**
 * 账号表里第一个账号的 provider（没有账号时为 null）。
 *
 * 「新建账号没给 provider」时拿它当缺省值。没有「默认账号」这个概念，
 * 取第一个与用户在账号页看到的顺序一致。
 */
async function firstAccountProvider(ctx: HandlerContext): Promise<ProviderId | null> {
  const [first] = await ctx.accounts.list();
  return first ? first.credential.provider : null;
}

/**
 * 下载用的文件名：`zcode-accounts-YYYYMMDD-HHmmss.json`，本地时间。
 *
 * 时区取自 `at`（进程本地时区）。秒级精度足够：同一秒内连点两次导出，浏览器自己会
 * 加 `(1)`，与日志页的导出同一条口径。
 */
function inlineExportFileName(at: Date): string {
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${INLINE_FILE_PREFIX}-${stamp}.json`;
}

/** 默认导出路径：存储目录下的时间戳文件（与 `accounts.json` 同处，便于一起备份）。*/
function defaultExportPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(getStoreDir(), `${EXPORT_FILE_PREFIX}-${stamp}.json`);
}

/** 写导出文件：`0o600` + 建目录（凭据文件只给本用户）。*/
function writeExportFile(path: string, payload: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, payload, { mode: EXPORT_FILE_MODE });
}

/**
 * 把 scrypt 派生出的原始字节变成 WebCrypto 的 AES-GCM 密钥。
 *
 * 用 `crypto.subtle` 而不是 `node:crypto` 的同步 cipher API：项目里只保留一种
 * AES 实现，存储层（`src/storage/codec.ts`）与这里就不会有两套需要同时正确的东西。
 * KDF 仍是 scrypt，参数由导出包自己声明，旧包照常读得开。
 */
async function gcmKey(raw: Buffer): Promise<CryptoKey> {
  const ab = new ArrayBuffer(raw.byteLength);
  new Uint8Array(ab).set(raw);
  return crypto.subtle.importKey("raw", ab, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** 加密：AES-256-GCM，密钥 = scrypt(密码, salt)。*/
async function encryptBundle(bundle: AccountsBundle, password: string): Promise<EncryptedBundle> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await gcmKey(
    scryptSync(password, salt, SCRYPT_KEY_BYTES, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
    }),
  );
  const iv = randomBytes(GCM_IV_BYTES);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: GCM_TAG_BYTES * 8 },
      key,
      new TextEncoder().encode(JSON.stringify(bundle)),
    ),
  );
  const data = sealed.subarray(0, sealed.length - GCM_TAG_BYTES);
  const tag = sealed.subarray(sealed.length - GCM_TAG_BYTES);
  return {
    kind: EXPORT_BUNDLE_KIND,
    version: EXPORT_BUNDLE_VERSION,
    encrypted: true,
    kdf: {
      name: "scrypt",
      cost: SCRYPT_COST,
      blockSize: SCRYPT_BLOCK_SIZE,
      parallelization: SCRYPT_PARALLELIZATION,
      salt: salt.toString("base64"),
    },
    iv: iv.toString("base64"),
    tag: Buffer.from(tag).toString("base64"),
    data: Buffer.from(data).toString("base64"),
  };
}

/** 解密：KDF 参数从包里读（导出时的参数就是它自己声明的那套）。密码错则抛。*/
async function decryptBundle(wrapper: EncryptedBundle, password: string): Promise<string> {
  const key = await gcmKey(
    scryptSync(password, Buffer.from(wrapper.kdf.salt, "base64"), SCRYPT_KEY_BYTES, {
      N: wrapper.kdf.cost,
      r: wrapper.kdf.blockSize,
      p: wrapper.kdf.parallelization,
    }),
  );
  const data = Buffer.from(wrapper.data, "base64");
  const tag = Buffer.from(wrapper.tag, "base64");
  const sealed = new Uint8Array(data.length + tag.length);
  sealed.set(data, 0);
  sealed.set(tag, data.length);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(wrapper.iv, "base64"), tagLength: GCM_TAG_BYTES * 8 },
    key,
    sealed,
  );
  return new TextDecoder().decode(plaintext);
}

/** 没给 provider 时的默认 family（`zai`）。*/
const DEFAULT_PROVIDER: ProviderId = "zai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 导出包里的一条是否够得上“账号”（只查结构，语义交给 `validateAccount`）。
 *
 * 与 `store.ts::isAccountShape` 同一套字段：手改过的包不能让下游在 `validateAccount`
 * 里以 `TypeError` 的形式炸掉（那会变成 500，而它其实是一个输入错误）。
 */
function isExportedAccount(value: unknown): value is Account {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || !value.id) return false;
  if (typeof value.label !== "string" || !value.label) return false;
  if (typeof value.enabled !== "boolean") return false;
  if (!Array.isArray(value.routes)) return false;
  if (!isRecord(value.credential) || typeof value.credential.kind !== "string") return false;
  if (!isRecord(value.policy)) return false;
  return true;
}
