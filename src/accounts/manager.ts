/**
 * 账号管理：增删改查 + 路由白名单校验 + 凭据能力推断。
 *
 * 这里是「校验规则（写入时强制）」的唯一执行点。规则**必须**在写入时强制，
 * 不能留到出线时：一条非法组合（比如没有 apiKey 对的 coding-plan）如果只是等到
 * 请求时才发现，用户看到的是上游 401，而那句 401 不会告诉他"你的白名单配错了"。
 *
 * 规则与代码的对应关系（`validateAccount` / `validateRoute`）：
 *
 * 1. 按量计费凭据的路由只能是它自己那条：该凭据类型已随那条路由一起删除，
 *    编号留着空位
 * 2. `credential.kind === "zhipu-account"` → `routes ⊆ [coding-plan, start-plan, off-peak, highspeed]`
 * 3. `off-peak` / `highspeed` 只在 `routes` 含 `coding-plan` 时合法
 * 4. `start-plan` 要求 `credential.jwt`
 * 5. `coding-plan` 要求 `credential.apiKey` 且 `secret`（zai）
 * 6. `identity.targetType === "TEAM"` 要求 organizationId + projectId + productId
 *
 * 第 2-5 条**不硬编码在 if 里**，一律读 `routes.ts` 的 `RouteSpec.requires` /
 * `derivesFrom`：路由表是静态事实的唯一真源，把要求写两遍迟早会有一遍忘记改。
 * 第 6 条是账号级的，路由表表达不了，单独一段。
 */
import { credentialCapabilities } from "../auth/capabilities.js";
import type { Credential as AuthCredential } from "../auth/types.js";
import { getRouteSpec, isRouteKind, ROUTE_KINDS } from "./routes.js";
import { fileAccountsStore } from "./store.js";
import type { AccountsStore } from "./store.js";
import {
  ACCOUNTS_STORE_VERSION,
  credentialFingerprint,
  defaultPolicy,
} from "./types.js";
import type {
  Account,
  AccountPolicy,
  AccountsFile,
  Credential,
  RouteKind,
} from "./types.js";

/** 校验/操作失败的机器可读原因，供 CLI 与面板映射成人话。*/
export type AccountErrorCode =
  | "empty-label"
  | "duplicate-label"
  | "empty-routes"
  | "unknown-route"
  | "unusable-credential"
  | "credential-kind-mismatch"
  | "missing-derivation"
  | "missing-jwt"
  | "missing-api-key-pair"
  | "incomplete-team-identity"
  | "invalid-policy"
  | "not-found";

/** 带原因码的账号错误。CLI 只打印 message，面板/API 用 code 分流。*/
export class AccountError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

// ---------------------------------------------------------------------------
// 凭据能力推断
// ---------------------------------------------------------------------------

/**
 * v2 凭据折回 `auth/capabilities.ts` 的入参形状。
 *
 * 为什么不把那份能力表抄一遍：它同时编码了"哪个面需要 apiKey 对 / 哪个面需要
 * JWT"的实证（coding-plan 与 MCP / async / highspeed 要 pair，start-plan 与
 * quota / claim 要 JWT），抄一份等于以后两个地方各自漂移。这里只做一次结构
 * 转换（纯函数，不落盘、不缓存）。
 *
 * 导出给请求链路用（`proxy/handler.ts` 等）：它们拿到的租约里是 v2 凭据，而
 * 出线层（签名、加速卡、MCP、endpoint routing）用的是 `auth/types.ts` 的
 * `Credential` 形状。请求链路拿到的是 v2 凭据，形状不同，必须在这里转一次，
 * **只转一处**，否则两份转换迟早漂移。
 */
export function toAuthCredential(credential: Credential): AuthCredential {
  const converted: AuthCredential = {
    apiKey: credential.apiKey,
    provider: credential.provider,
  };
  if (credential.secret) converted.secret = credential.secret;
  if (credential.jwt) converted.jwt = credential.jwt;
  if (credential.oauthAccessToken) converted.oauthAccessToken = credential.oauthAccessToken;
  return converted;
}

/**
 * apiKey 对是否齐全（规则 5）。
 *
 * zai 必须 `{apiKey}.{secret}` 两段（上游 `x-api-key` + `Bearer {apiKey}.{secret}`）；
 * bigmodel 存在单 key 账号，secret 可缺省（auth/types.ts `credentialString`）。
 */
function hasCompleteApiKeyPair(credential: Credential): boolean {
  if (!credential.apiKey.trim()) return false;
  if (credential.provider === "zai") return Boolean(credential.secret);
  return true;
}

/**
 * 由凭据推断默认路由白名单：默认值可以由凭据能力推断出来，用户只能收窄。
 *
 * 只推断**能直接用的**路由：
 *
 * - `zhipu-account` → 有完整 apiKey 对给 `coding-plan`，有 JWT 给 `start-plan`。
 * - 派生路由（`off-peak` / `highspeed`）**默认不给**：它们各自还有额外准入
 *   （票券队列 / 真的持卡），默认打开等于把请求倒进必然失败的通道。要用的账号
 *   在配置里显式加（`config.example.yaml` 里就是这么写的）。
 *
 * 推断结果保证能过校验：规则 5 在这里就按"完整 apiKey 对"判定，避免推出一条
 * 过不了自己校验的 coding-plan。
 */
export function inferRoutes(credential: Credential): RouteKind[] {
  if (credential.expiresAt !== undefined && Date.now() >= credential.expiresAt) {
    raise("unusable-credential", "credential is expired; re-import or log in again");
  }

  const capabilities = credentialCapabilities(toAuthCredential(credential));
  const routes: RouteKind[] = [];
  if (capabilities.codingPlan && hasCompleteApiKeyPair(credential)) routes.push("coding-plan");
  if (capabilities.startPlan) routes.push("start-plan");

  if (routes.length === 0) {
    raise(
      "unusable-credential",
      "credential can authenticate nothing: it has neither a complete apiKey pair nor a plan JWT",
    );
  }
  return routes;
}

/** 抛错并返回 `never`，让调用点能写成三元/箭头函数形式。*/
function raise(code: AccountErrorCode, message: string): never {
  throw new AccountError(code, message);
}

// ---------------------------------------------------------------------------
// 校验（六条规则）
// ---------------------------------------------------------------------------

/**
 * 路由白名单归一：丢弃重复、按 {@link ROUTE_KINDS} 的稳定顺序排序。
 *
 * `routes` 是集合语义（"允许哪些路由"），重复与顺序都不表达用户意图，所以
 * 归一是安全的；但**未知字符串必须报错**，那是配置写错或拼错，静默丢弃会让
 * 用户以为白名单生效了。
 */
export function normalizeRoutes(routes: readonly RouteKind[]): RouteKind[] {
  for (const route of routes) {
    if (!isRouteKind(route)) {
      raise("unknown-route", `unknown route "${String(route)}"`);
    }
  }
  const set = new Set(routes);
  return ROUTE_KINDS.filter((kind) => set.has(kind));
}

/** 单条路由对单份凭据是否合法（规则 1-5，全部读路由表）。*/
function validateRoute(credential: Credential, route: RouteKind, routes: readonly RouteKind[]): void {
  const spec = getRouteSpec(route);

  // 规则 1 + 2：路由要求的凭据类别必须与凭据一致。两条规则是同一件事的两个
  // 方向，所以由路由表的 `requires.credentialKind` 一次判定。
  if (spec.requires.credentialKind !== credential.kind) {
    raise(
      "credential-kind-mismatch",
      `route "${route}" needs a "${spec.requires.credentialKind}" credential, but this account holds "${credential.kind}"`,
    );
  }

  // 规则 3：派生路由必须与母体共存（官方 last-known-good 作用域）。
  if (spec.derivesFrom && !routes.includes(spec.derivesFrom)) {
    raise(
      "missing-derivation",
      `route "${route}" is derived from "${spec.derivesFrom}"; add "${spec.derivesFrom}" to this account's routes`,
    );
  }

  // 规则 4。
  if (spec.requires.jwt && !(credential.kind === "zhipu-account" && credential.jwt)) {
    raise("missing-jwt", `route "${route}" needs the plan JWT, but the credential has none`);
  }

  // 规则 5。
  if (spec.requires.apiKeyPair && !hasCompleteApiKeyPair(credential)) {
    raise(
      "missing-api-key-pair",
      credential.provider === "zai"
        ? `route "${route}" needs the apiKey pair (apiKey + secret), but the credential is incomplete`
        : `route "${route}" needs an apiKey, but the credential has none`,
    );
  }
}

/** 规则 6：TEAM 身份必须带齐三个 id（且必须来自同一凭据，由导入时保证）。*/
function validateIdentity(credential: Credential): void {
  if (credential.kind !== "zhipu-account") return;
  const { identity } = credential;
  if (identity.targetType !== "TEAM") return;

  const missing = (["organizationId", "projectId", "productId"] as const).filter(
    (field) => !identity[field]?.trim(),
  );
  if (missing.length > 0) {
    raise(
      "incomplete-team-identity",
      `TEAM identity needs ${missing.join(" + ")}, but ${missing.length} of them are missing`,
    );
  }
}

/**
 * 凭据必须至少有一个能区分账号的字段。
 *
 * 账号 id 是凭据指纹，而指纹刻意排除会轮换的 `jwt` / `oauthAccessToken`（
 * `types.ts::credentialFingerprint`）。JWT-only 凭据的 `apiKey` 是空串，所以它的
 * 指纹完全靠 `upstreamUserId`（`user_id` / `customer_id`）支撑；两者都空时，任何两份
 * 这样的凭据都算出同一个 id，第二个导入会**静默覆盖**第一个。用户看到的是
 * 「导入了 N 个免费账号，实际只有 1 个」。这不是兜底能解决的问题：那份凭据本身
 * 就无法回答「这是哪个上游账号」，所以写入时就拒绝。
 */
function validateFingerprintInputs(credential: Credential): void {
  if (credential.kind !== "zhipu-account") return;
  if (credential.apiKey.trim() || credential.upstreamUserId?.trim()) return;
  raise(
    "unusable-credential",
    "credential cannot identify an upstream account: it has neither an apiKey nor an upstream user id",
  );
}

/** 策略取值范围。`maxConcurrency: 0` 合法，那是软禁用。*/
function validatePolicy(policy: AccountPolicy): void {
  if (!Number.isInteger(policy.weight) || policy.weight < 1) {
    raise("invalid-policy", `policy.weight must be an integer >= 1, got ${policy.weight}`);
  }
  if (!Number.isInteger(policy.maxConcurrency) || policy.maxConcurrency < 0) {
    raise("invalid-policy", `policy.maxConcurrency must be an integer >= 0, got ${policy.maxConcurrency}`);
  }
  if (policy.rpmLimit !== undefined && (!Number.isInteger(policy.rpmLimit) || policy.rpmLimit < 1)) {
    raise("invalid-policy", `policy.rpmLimit must be an integer >= 1, got ${policy.rpmLimit}`);
  }
}

/**
 * 写入时的全量校验（六条规则 + 结构完整性）。不合法即抛
 * {@link AccountError}，绝不"尽力修复"后落盘：一份被悄悄改过的白名单比一份明确
 * 报错的配置危险得多。
 *
 * 只读不写，返回 void；归一（label 去空格、routes 排序、policy 补默认）由调用方
 * 先做完再交给它，这样"校验"与"归一"的边界对读代码的人是清楚的。
 */
export function validateAccount(account: Account): void {
  if (!account.label.trim()) {
    raise("empty-label", "account label must not be empty");
  }

  const routes = account.routes;
  if (routes.length === 0) {
    raise("empty-routes", `account "${account.label}" allows no routes`);
  }
  // normalizeRoutes 在归一之后仍要跑一遍未知值检查：调用方可能绕过归一直接
  // 构造 Account（配置反序列化、测试）。
  normalizeRoutes(routes);

  for (const route of routes) {
    validateRoute(account.credential, route, routes);
  }

  validateIdentity(account.credential);
  validateFingerprintInputs(account.credential);
  validatePolicy(account.policy);
}

// ---------------------------------------------------------------------------
// 管理者
// ---------------------------------------------------------------------------

/** 新建账号的入参；`routes` 缺省 = 按凭据能力推断。*/
export interface NewAccount {
  label: string;
  credential: Credential;
  routes?: readonly RouteKind[];
  enabled?: boolean;
  policy?: Partial<AccountPolicy>;
}

/**
 * 局部更新。每一项都可省；省掉 = 保持原值。
 *
 * 换凭据会改变指纹，因此**账号 id 会跟着变**（id 就是凭据指纹）。
 */
export interface AccountPatch {
  label?: string;
  credential?: Credential;
  routes?: readonly RouteKind[];
  enabled?: boolean;
  policy?: Partial<AccountPolicy>;
}

/**
 * 账号管理者：内存缓存 + 每次写成功才更新缓存。
 *
 * 存储后端注入（默认 {@link fileAccountsStore}）：6 条规则的用例不该被文件 IO
 * 拖慢或污染真实用户目录。写成功后才替换缓存，是为了让写失败时内存与磁盘不
 * 分叉；否则进程内看起来"保存成功"，重启后配置全丢。
 */
export class AccountManager {
  private file: AccountsFile | null = null;
  /** 写后回调（**纯增量**观察口：不改变任何读写契约）。*/
  private readonly changeListeners: ((accounts: readonly Account[]) => void)[] = [];
  /** 人工恢复凭据的观察口（auth login/import 成功后清 auth-invalid）。*/
  private readonly credentialListeners: ((account: Account) => void)[] = [];

  constructor(private readonly store: AccountsStore = fileAccountsStore) {}

  /**
   * 订阅「账号表写成功之后」的快照（每账号 highspeed 卡槽的生命周期跟着它走）。
   *
   * 为什么需要它：账号删除 / 禁用是**账号仓**的动作，而依附在账号上的后台循环
   * （`highspeed/slots.ts` 的抽卡循环）必须跟着停；否则被删账号的循环还会按
   * `IDLE_MS` 再抽五分钟卡，等于替一个已经不存在的账号烧 draw 配额。
   * 让每个调用方自己记得「删完账号还要去停卡槽」是漏点，所以把通知放在唯一的写
   * 入口上。它只增加一个观察口：所有既有方法的签名、返回值与副作用一概不变。
   *
   * 只在 `persist()` 成功之后触发：写失败时内存与磁盘都没变，任何基于新表的动作
   * 都不该发生。回调抛错被吞掉（观察者不该把一次成功的写入变成失败）。
   */
  onChange(listener: (accounts: readonly Account[]) => void): void {
    this.changeListeners.push(listener);
  }

  /**
   * 订阅「凭据被重新登录 / 导入」这件事（auth-invalid 的唯一人工恢复入口）。
   *
   * `auth-invalid` 不再自动冷却重试，必须由人工动作放回 ok；健康表自己看不见
   * 「用户刚重新导入了凭据」——那是账号仓的动作。接线放在账号仓而不是每个
   * 登录/导入调用点，是因为入口有四个（CLI login / CLI import / 面板 OAuth 两路
   * / 导入导出包），漏接一个就等于留一条永久卡死的账号。
   *
   * 触发条件刻意收窄到 {@link enrollCredential}：只有它代表「凭据重新认证」；
   * `add` / `update` 里的策略调整、改 label、换代理都不是重新登录。回调由
   * {@link enrollCredential} 在写入成功后调用，见 `enroll.ts`。
   */
  onCredentialRefreshed(listener: (account: Account) => void): void {
    this.credentialListeners.push(listener);
  }

  /** 通知人工恢复（内部入口，只由 `enrollCredential` 调用）。*/
  notifyCredentialRefreshed(account: Account): void {
    for (const listener of this.credentialListeners) {
      try {
        listener(account);
      } catch {
        // 观察者失败不能把一次成功的重新登录变成失败（同 onChange 纪律）。
      }
    }
  }

  /** 丢掉内存缓存，下次读重新落盘读取。*/
  async reload(): Promise<void> {
    this.file = null;
  }

  /** 全部账号（快照副本，调用方改它不会影响存储）。*/
  async list(): Promise<Account[]> {
    const file = await this.current();
    return file.accounts.map(cloneAccount);
  }

  async get(id: string): Promise<Account | null> {
    const file = await this.current();
    const found = file.accounts.find((account) => account.id === id);
    return found ? cloneAccount(found) : null;
  }

  /** 按 label 查（配置与 `X-ZCode-Account` 都用 label）。*/
  async getByLabel(label: string): Promise<Account | null> {
    const wanted = label.trim();
    const file = await this.current();
    const found = file.accounts.find((account) => account.label === wanted);
    return found ? cloneAccount(found) : null;
  }

  /**
   * 新增账号。同一凭据重复 `add` 是幂等的（凭据指纹即账号 id）。
   *
   * 重导入只刷新**凭据**（JWT 会轮换），`label` / `enabled` / `policy` / `routes`
   * 属用户配置，不被重导入重置；否则用户辛苦调好的并发与白名单会被一次
   * `auth import` 抹掉。显式传入 `routes` 时按传入的算。
   *
   * `deviceMid` 也在保留之列：官方客户端的 deviceMid 是**装机时**定的、
   * 与登录无关（`apps/zcode-cli/packages/adapters/src/device/cli-device-mid.ts`
   * 首次启动生成后写 `telemetry-state.json`，此后永不改变）。重新登录换指纹等于
   * 告诉上游「这个账号换设备了」，比共用指纹更糟。
   */
  async add(input: NewAccount): Promise<Account> {
    const routes = normalizeRoutes(input.routes ?? inferRoutes(input.credential));
    const candidate: Account = {
      id: credentialFingerprint(input.credential),
      label: input.label.trim(),
      credential: input.credential,
      routes,
      enabled: input.enabled ?? true,
      policy: defaultPolicy(input.policy),
    };
    validateAccount(candidate);

    const file = await this.current();
    const existingIndex = file.accounts.findIndex((account) => account.id === candidate.id);

    const existing = existingIndex >= 0 ? file.accounts[existingIndex] : undefined;
    if (existing) {
      const refreshed: Account = {
        ...existing,
        credential: keepDeviceMid(existing.credential, candidate.credential),
        routes: input.routes ? candidate.routes : existing.routes,
      };
      validateAccount(refreshed);
      const accounts = [...file.accounts];
      accounts[existingIndex] = refreshed;
      await this.persist({ ...file, accounts });
      return cloneAccount(refreshed);
    }

    this.assertLabelFree(file, candidate.label, candidate.id);
    const accounts = [...file.accounts, candidate];
    await this.persist({ ...file, accounts });
    return cloneAccount(candidate);
  }

  /** 局部更新。合并后整体重新校验，任何一条规则被违反都拒绝落盘。*/
  async update(id: string, patch: AccountPatch): Promise<Account> {
    const file = await this.current();
    const index = file.accounts.findIndex((account) => account.id === id);
    const existing = index >= 0 ? file.accounts[index] : undefined;
    if (!existing) {
      raise("not-found", `no account with id "${id}"`);
    }

    // 换凭据也保留原 `deviceMid`（理由见 `add` 的注释）：`enrollCredential`
    // 刷新同一账号时也走这条路。
    const credential = keepDeviceMid(existing.credential, patch.credential ?? existing.credential);
    const routes = nextRoutes(patch, existing, credential);

    const updated: Account = {
      id: credentialFingerprint(credential),
      label: (patch.label ?? existing.label).trim(),
      credential,
      routes,
      enabled: patch.enabled ?? existing.enabled,
      policy: patch.policy ? defaultPolicy({ ...existing.policy, ...patch.policy }) : existing.policy,
    };
    validateAccount(updated);
    this.assertLabelFree(file, updated.label, id);

    const accounts = [...file.accounts];
    accounts[index] = updated;
    await this.persist({ ...file, accounts });
    return cloneAccount(updated);
  }

  /** 删除账号。*/
  async remove(id: string): Promise<boolean> {
    const file = await this.current();
    const accounts = file.accounts.filter((account) => account.id !== id);
    if (accounts.length === file.accounts.length) return false;
    await this.persist({ ...file, accounts });
    return true;
  }

  private async current(): Promise<AccountsFile> {
    if (!this.file) this.file = await this.store.load();
    return this.file;
  }

  private async persist(file: AccountsFile): Promise<void> {
    const next: AccountsFile = { ...file, version: ACCOUNTS_STORE_VERSION };
    await this.store.save(next);
    this.file = next;
    for (const listener of this.changeListeners) {
      try {
        listener(next.accounts);
      } catch {
        // 有意吞错：观察者（卡槽回收）失败不能把一次成功的账号写入变成失败。
      }
    }
  }

  private assertLabelFree(file: AccountsFile, label: string, selfId: string): void {
    const clash = file.accounts.find((account) => account.label === label && account.id !== selfId);
    if (clash) {
      raise("duplicate-label", `label "${label}" is already used by another account`);
    }
  }
}

/**
 * 更新后的白名单。
 *
 * 显式传入就用传入的；**换了凭据且没传**时按新凭据能力重新推断；旧白名单
 * 可能整条都不再合法（换 provider 后 `coding-plan` 的出线形态变了），沿用会让
 * 整次更新被自己的校验拒掉。
 */
function nextRoutes(patch: AccountPatch, existing: Account, credential: Credential): RouteKind[] {
  if (patch.routes) return normalizeRoutes(patch.routes);
  if (patch.credential) return normalizeRoutes(inferRoutes(credential));
  return existing.routes;
}

/** 深拷贝一份账号，避免调用方直接改到缓存里的对象。*/
function cloneAccount(account: Account): Account {
  return {
    ...account,
    credential: cloneCredential(account.credential),
    routes: [...account.routes],
    policy: { ...account.policy },
  };
}

/** 凭据深拷贝：`identity` 是嵌套对象，浅拷会让调用方改到缓存里的 `deviceMid`。*/
function cloneCredential(credential: Credential): Credential {
  if (credential.kind !== "zhipu-account") return { ...credential };
  return { ...credential, identity: { ...credential.identity } };
}

/**
 * 刷新凭据时保留账号原有的 `deviceMid`。
 *
 * 官方语义是「装机时定的」，重新登录在官方那里根本不涉及设备；换指纹等于告诉
 * 上游「这个账号换设备了」，比共用指纹更糟。所以刷新只覆盖凭据本身（JWT 会轮换），
 * 身份里的 `deviceMid` 一律沿用旧的。
 *
 * 凭据只有一种形态，所以这里不需要按 kind 判别。
 */
function keepDeviceMid(existing: Credential, incoming: Credential): Credential {
  return {
    ...incoming,
    identity: { ...incoming.identity, deviceMid: existing.identity.deviceMid },
  };
}
