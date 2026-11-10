/**
 * Credential import behind `zcode-proxy auth import`: bring an account in
 * without running the OAuth flow.
 *
 * Two sources share one merge policy.
 *
 * The ZCode desktop credential file (`~/.zcode/v2/credentials.json` by default)
 * is a flat `key -> value` map, which is what a 3.17.1 install actually writes
 * (checked 2026-11-07):
 *
 *   oauth:active_provider          "zai" or "bigmodel"
 *   oauth:<provider>:access_token  OAuth access token, plaintext
 *   oauth:<provider>:user_info     "enc:v1:..." (Electron safeStorage)
 *   project-key-location:v1:[...]  "enc:v1:..." (safeStorage, points at the apiKey)
 *   zcodejwttoken                  plan JWT, carried by the start-plan
 *                                  gateway, /quota, /mcp, claim and async
 *                                  (MCP, async and highspeed also need the
 *                                  apiKey pair, see auth/capabilities.ts)
 *
 * Only the OAuth access token can become a coding-plan apiKey, and it goes
 * through the same `KeyResolver` as the OAuth flow: getCustomerInfo, then the
 * api_keys list, then copy. All three calls are read-only, and an existing
 * `zcode-api-key` entry is reused instead of created. The token is also kept as
 * `Credential.oauthAccessToken`, because `proxy/client-signing.ts` needs it to
 * mint bigmodel's project-access signing JWT.
 *
 * The `enc:v1` values stay encrypted on purpose. Their key lives in the OS
 * keychain, `user_info` only feeds client UI, and `project-key-location` is a
 * cache of what the resolver derives anyway.
 *
 * A pasted plan JWT (`--jwt`) is validated locally. Its payload is
 * `{user_id, sub, token_version, iat}`, with no `exp` claim and no provider
 * field, so the provider falls back to the stored credential or the caller's
 * default.
 *
 * What this module does not do:
 *
 * - Refresh or renew anything. No credential the proxy stores carries a usable
 *   `exp` (the plan JWT has `iat` only and the gateway does not reject by age,
 *   see auth/jwt-age.ts), and neither the login flows nor the token endpoints
 *   expose a refresh token. An expired account shows up as an upstream
 *   401/3012, and re-import or re-login is the only way back.
 * - Carry an expiry. No credential the proxy stores has one (the type has no
 *   `expiresAt` field at all): the login flows and token endpoints never
 *   expose a usable `exp`, and a guessed value would make
 *   `accounts/manager.ts::inferRoutes` reject an account that still works.
 * - Decrypt `enc:v1` blobs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ProviderId } from "../provider/types.js";
import type { Credential } from "./types.js";
import { KeyResolver } from "./resolver.js";
import { inspectJwt } from "./jwt-age.js";

/** Default import source: the ZCode desktop client's credential store. */
export function defaultCredentialsPath(): string {
  return join(homedir(), ".zcode", "v2", "credentials.json");
}

/** Characters of a secret shown in CLI output (prefix only, never the whole value). */
export const SECRET_PREFIX_LENGTH = 12;

export type ImportErrorCode =
  | "usage"
  | "file_unreadable"
  | "file_malformed"
  | "invalid_jwt"
  | "no_credential"
  | "provider_required"
  | "provider_mismatch";

/** Typed failure so the CLI can print one line and exit non-zero without a stack. */
export class ImportError extends Error {
  constructor(readonly code: ImportErrorCode, message: string) {
    super(message);
    this.name = "ImportError";
  }
}

// ---------------------------------------------------------------------------
// Token inspection
// ---------------------------------------------------------------------------

/** What a raw secret string actually is (the three are not interchangeable). */
export type SecretKind = "plan-jwt" | "oauth-access-token" | "api-key-pair" | "unknown";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode a JWT payload without verifying the signature (we never hold the key). */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown;
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify a raw secret.
 *
 * Observed payloads (live, 2026-11-07):
 *   plan JWT          {"user_id","token_version","sub","iat"}
 *   OAuth access tok. {"customer_id","user_channel","user_id","user_key","user_type","username"}
 *   coding-plan key   "{32-hex apiKeyId}.{apiKeySecret}"
 *
 * A `token_use` claim marks a minted `project_access` signing token (5h) rather
 * than an importable account credential, so it is rejected instead of stored.
 */
export function classifySecret(raw: string): SecretKind {
  const token = raw.trim();
  if (!token) return "unknown";

  const parts = token.split(".");
  if (parts.length === 3) {
    const payload = decodeJwtPayload(token);
    if (!payload) return "unknown";
    if (payload.token_use !== undefined) return "unknown";
    if (typeof payload.token_version === "number") return "plan-jwt";
    if (typeof payload.user_key === "string" || payload.customer_id !== undefined) return "oauth-access-token";
    return "unknown";
  }

  // Two non-empty segments are `{apiKeyId}.{apiKeySecret}`, the pair the
  // upstream handshake expects as `Credential.apiKey`/`secret` (see
  // parseSigningCredentialForm in proxy/client-signing.ts). Bare single-segment
  // keys are rejected: neither import source produces one, so accepting any
  // text as a key would only store junk.
  if (parts.length === 2 && parts[0]!.trim() && parts[1]!.trim()) return "api-key-pair";

  return "unknown";
}

// ---------------------------------------------------------------------------
// Source parsing
// ---------------------------------------------------------------------------

/**
 * 上游账号标识（`user_id` / `customer_id` / `user_key`）。
 *
 * 用于凭据指纹的 `apiKey` 兜底：JWT-only 账号的 `apiKey` 是空串，没有它
 * 所有 JWT-only 账号会撞成同一个 id。取值优先级按「账号级稳定度」排：`user_id` 与
 * `customer_id` 是账号级不变值，`user_key` 只在前两者都缺失时兜底。
 *
 * 刻意不读 `sub`：plan JWT 的 `sub` 是客户号，与 OAuth user id 是两回事，不能互换
 * （`mergeCredential` 的旧注释里记的就是这条）。
 */
export function upstreamUserIdOf(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  for (const key of ["user_id", "customer_id", "user_key"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Everything a source can contribute, before provider resolution / merging. */
export interface ParsedSource {
  /** Human-readable origin, echoed in the report. */
  source: string;
  provider?: ProviderId;
  /** `{apiKeyId}.{apiKeySecret}` to use as-is (no network round-trip). */
  apiKeyPair?: string;
  /** OAuth access token to exchange for a coding-plan key via KeyResolver. */
  oauthAccessToken?: string;
  /** Plan JWT (`zcodejwttoken` / `pluginSecret.jwt` / pasted). */
  jwt?: string;
  /** 上游账号标识，取自 token payload。落成 `ZhipuAccountCredential.upstreamUserId`。*/
  userId?: string;
  /** Plan the source claims for this account, when it says so. */
  planHint?: "coding-plan" | "start-plan";
  warnings: string[];
}

function asProvider(value: unknown): ProviderId | undefined {
  return value === "zai" || value === "bigmodel" ? value : undefined;
}

/** Validate a pasted plan JWT. The check is local; only the gateway can tell whether the token still works. */
export function parseJwtSource(raw: string): ParsedSource {
  const jwt = raw.trim();
  if (!jwt) throw new ImportError("invalid_jwt", "No JWT provided.");
  if (classifySecret(jwt) !== "plan-jwt") {
    throw new ImportError(
      "invalid_jwt",
      "That does not look like a ZCode plan JWT (expected three dot-separated segments with a `token_version` payload).",
    );
  }
  if (!inspectJwt(jwt)) {
    throw new ImportError("invalid_jwt", "Plan JWT has no readable `iat` claim, so it was not stored.");
  }
  const userId = inspectJwt(jwt)?.userId;
  return { source: "pasted JWT", jwt, ...(userId ? { userId } : {}), warnings: [] };
}

/**
 * Parse a ZCode credential file. Accepts the flat-map store ZCode 3.x writes
 * and the `pluginSecret` object some builds/exports hand out (same tokens,
 * already paired with an apiKey so no network call is needed).
 */
export function parseZcodeCredentialsFile(
  text: string,
  opts: { source?: string; provider?: ProviderId } = {},
): ParsedSource {
  const source = opts.source ?? "credential file";
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ImportError("file_malformed", `Not valid JSON: ${(e as Error).message}`);
  }
  if (!isPlainObject(raw)) throw new ImportError("file_malformed", "Expected a JSON object.");

  if (isFlatMapStore(raw)) return parseFlatMapStore(raw, source, opts.provider);

  const pluginSecret = isPlainObject(raw.pluginSecret) ? raw.pluginSecret : raw;
  if (typeof pluginSecret.accessToken === "string" || typeof pluginSecret.jwt === "string") {
    return parsePluginSecret(pluginSecret, source);
  }

  throw new ImportError(
    "file_malformed",
    "Unrecognized credential file shape. Expected ZCode's flat `oauth:<provider>:access_token` store or a `pluginSecret` object.",
  );
}

function isFlatMapStore(raw: Record<string, unknown>): boolean {
  if (typeof raw["oauth:active_provider"] === "string") return true;
  return Object.keys(raw).some((key) => /^oauth:[a-z]+:access_token$/.test(key));
}

function parseFlatMapStore(
  raw: Record<string, unknown>,
  source: string,
  requested?: ProviderId,
): ParsedSource {
  const warnings: string[] = [];
  const tokens = new Map<ProviderId, string>();
  for (const [key, value] of Object.entries(raw)) {
    const match = /^oauth:([a-z]+):access_token$/.exec(key);
    if (!match || typeof value !== "string" || !value.trim()) continue;
    const provider = asProvider(match[1]);
    if (provider) tokens.set(provider, value.trim());
  }
  const available = [...tokens.keys()].join(", ");

  // Which provider's token to use, in order of authority: an explicit
  // `--provider`/stored credential, the file's `oauth:active_provider`, then the
  // only provider that has a token. The token MUST belong to the chosen
  // provider: handing zai's resolver a bigmodel token just burns a failing call.
  const active = asProvider(raw["oauth:active_provider"]);
  let provider = requested ?? active;
  if (provider && !tokens.has(provider)) {
    // `oauth:active_provider` is only a hint: a client that logged in with the
    // other provider still leaves its token behind, and refusing outright would
    // make the file look unusable.
    warnings.push(
      `No oauth:${provider}:access_token in the file` + (available ? ` (found: ${available})` : "") + ".",
    );
    provider = requested ? provider : undefined;
  }
  if (!provider) {
    if (tokens.size > 1) {
      throw new ImportError(
        "provider_required",
        `File carries access tokens for ${available}. Pass --provider to pick one.`,
      );
    }
    if (tokens.size === 1) {
      provider = [...tokens.keys()][0]!;
      warnings.push(
        active
          ? `Falling back to "${provider}", the only provider with an access token.`
          : `No oauth:active_provider in the file, inferred provider "${provider}".`,
      );
    }
  }

  const jwtRaw = raw["zcodejwttoken"];
  const rawJwt = typeof jwtRaw === "string" ? jwtRaw.trim() : "";
  const jwt = rawJwt && classifySecret(rawJwt) === "plan-jwt" ? rawJwt : undefined;
  if (rawJwt && !jwt) warnings.push("Ignoring `zcodejwttoken`: it is not a ZCode plan JWT.");

  const oauthAccessToken = provider ? tokens.get(provider) : undefined;
  if (!oauthAccessToken && !jwt) {
    throw new ImportError(
      "no_credential",
      provider
        ? `No oauth:${provider}:access_token and no plan JWT in the file.`
        : "No usable access token or plan JWT in the file.",
    );
  }
  const userId = upstreamUserIdOf(oauthAccessToken ?? jwt ?? "");

  return {
    source,
    ...(provider ? { provider } : {}),
    ...(oauthAccessToken ? { oauthAccessToken } : {}),
    ...(jwt ? { jwt } : {}),
    ...(userId ? { userId } : {}),
    warnings,
  };
}

function parsePluginSecret(raw: Record<string, unknown>, source: string): ParsedSource {
  const warnings: string[] = [];
  let apiKeyPair: string | undefined;
  let oauthAccessToken: string | undefined;

  const accessToken = typeof raw.accessToken === "string" ? raw.accessToken.trim() : "";
  if (accessToken) {
    const kind = classifySecret(accessToken);
    if (kind === "api-key-pair") apiKeyPair = accessToken;
    else if (kind === "oauth-access-token") oauthAccessToken = accessToken;
    else warnings.push("Ignoring `accessToken`: unrecognized secret shape.");
  }

  const jwtRaw = typeof raw.jwt === "string" ? raw.jwt.trim() : "";
  const jwt = jwtRaw && classifySecret(jwtRaw) === "plan-jwt" ? jwtRaw : undefined;
  if (jwtRaw && !jwt) warnings.push("Ignoring `jwt`: not a ZCode plan JWT.");

  const planHint =
    raw.zcodePlan === "start-plan" || raw.zcodePlan === "coding-plan" ? raw.zcodePlan : undefined;
  // `idPrefix` 与客户端自带的 `deviceMid` 都不导入：`metadata.user_id` 由代理用
  // 账号自己的设备指纹 + 会话拼（proxy/trace-headers.ts），而设备指纹在建号时生成
  // （一账号一指纹）。别人的设备 ID 不是这个账号的身份。
  //
  // 上游账号标识（`user_id` / `customer_id` / `user_key`）则**要**导入：JWT-only
  // 账号的 apiKey 是空串，指纹只能靠它区分账号。
  const userId = upstreamUserIdOf(oauthAccessToken ?? jwt ?? "");

  if (!apiKeyPair && !oauthAccessToken && !jwt) {
    throw new ImportError("no_credential", "pluginSecret carries no usable access token or plan JWT.");
  }

  return {
    source,
    ...(apiKeyPair ? { apiKeyPair } : {}),
    ...(oauthAccessToken ? { oauthAccessToken } : {}),
    ...(jwt ? { jwt } : {}),
    ...(userId ? { userId } : {}),
    ...(planHint ? { planHint } : {}),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge an import into the stored credential.
 *
 * Field-wise and apiKey/secret-atomic: a new apiKey never inherits the old
 * secret (they are one pair), and a JWT-only import does not wipe an apiKey the
 * user already had.
 *
 * A provider change is refused instead of silently mixed: provider is part of
 * what makes the endpoints and signing rules line up, and mixing halves of two
 * providers would be cross-family breakage of the kind the risk-control rules
 * forbid (identity ids must all come from one credential). Note the stored file
 * holds **many** accounts (`{version, accounts[]}` in `accounts.json`) — this
 * function merges one credential *entry* and never looks at how many others the
 * file has. `--replace` is the explicit opt-in.
 */
export function mergeCredential(
  existing: Credential | null,
  incoming: Credential,
  opts: { replace?: boolean } = {},
): Credential {
  if (!existing || opts.replace) return { ...incoming };

  if (existing.provider !== incoming.provider) {
    throw new ImportError(
      "provider_mismatch",
      `Stored credential is ${existing.provider} but the import is ${incoming.provider}. ` +
        "Pass --replace to discard the stored credential.",
    );
  }

  const useIncomingKey = Boolean(incoming.apiKey);
  const merged: Credential = {
    provider: incoming.provider,
    apiKey: useIncomingKey ? incoming.apiKey : existing.apiKey,
  };
  const secret = useIncomingKey ? incoming.secret : existing.secret;
  if (secret) merged.secret = secret;

  const jwt = incoming.jwt ?? existing.jwt;
  if (jwt) merged.jwt = jwt;

  const oauthAccessToken = incoming.oauthAccessToken ?? existing.oauthAccessToken;
  if (oauthAccessToken) merged.oauthAccessToken = oauthAccessToken;

  // OAuth-only metadata, never invented by an import: a plan JWT's `sub` is a
  // customer number while `userId` is the OAuth user id, so the two are not
  // interchangeable. The import only ever fills it from `user_id` /
  // `customer_id` / `user_key` claims, never from `sub`.
  const userId = incoming.userId ?? existing.userId;
  if (userId) merged.userId = userId;

  return merged;
}

// ---------------------------------------------------------------------------
// Import entry point
// ---------------------------------------------------------------------------

export interface ImportOptions {
  /** Pasted plan JWT. Mutually exclusive with `file`. */
  jwt?: string;
  /** Credential file path; defaults to `~/.zcode/v2/credentials.json`. */
  file?: string;
  /**
   * 凭据文件的内容（而非路径）。上传 / 粘贴文件时用，优先于 `file`。
   *
   * 有了它，网页端不必把上传的文件先写到临时目录再按路径导入，那条路会在磁盘上
   * 留一份凭据副本（上传文件只读入内存，不落盘）。
   */
  content?: string;
  /** Overrides the provider named by the file / stored credential. */
  provider?: ProviderId;
  /** Caller's fallback provider, used when nothing else names one. */
  defaultProvider: ProviderId;
  /** Replace the stored credential instead of merging into it. */
  replace?: boolean;
  /**
   * 读出"要合并进去的那份凭据"，`null` = 没有既有账号可合并。
   *
   * **存储由调用方注入**：账号落在 `accounts.json`，导入模块不该知道账号存在哪，
   * 也不该自己读写。给一个默认实现就等于在这里藏第二条存储路径，调用方换存储时
   * 会漏掉它。
   */
  load: () => Promise<Credential | null>;
  /** 写回合并结果（由调用方落到账号存储）。*/
  save: (cred: Credential) => Promise<void>;
  /** Injected for tests: file reader (so tests never touch a real HOME). */
  readFile?: (path: string) => string;
  /** Injected for tests: KeyResolver transport. */
  fetchImpl?: typeof fetch;
}

export interface ImportReport {
  source: string;
  provider: ProviderId;
  credential: Credential;
  /** coding-plan traffic can authenticate (`apiKey` present). */
  codingPlanReady: boolean;
  /** start-plan / quota / MCP / claim / async are usable (`jwt` present). */
  startPlanReady: boolean;
  /** 上游账号标识（`user_id` / `customer_id` / `user_key`），同时落成 `upstreamUserId`。 */
  userId?: string;
  /** Plan JWT account (`payload.sub`), shown but never stored as the account id. */
  jwtUserId?: string;
  /** Plan the source claims for the account. */
  planHint?: "coding-plan" | "start-plan";
  warnings: string[];
}

/**
 * Read a source, resolve what it can, merge into the store and report.
 * Never throws for a *partial* import: a stale OAuth token still leaves the
 * plan JWT stored, with a warning. The proxy supports that degraded state:
 * start-plan still works without an apiKey.
 */
export async function importCredential(opts: ImportOptions): Promise<ImportReport> {
  if (opts.jwt && opts.file) throw new ImportError("usage", "Pass either --jwt or --file, not both.");

  const { load, save } = opts;
  // A corrupt/undecryptable store must not block a fresh import.
  const existing = await load().catch(() => null);

  let parsed: ParsedSource;
  if (opts.jwt) {
    parsed = parseJwtSource(opts.jwt);
  } else {
    const path = opts.file ?? defaultCredentialsPath();
    const read = opts.readFile ?? ((file: string) => readFileSync(file, "utf-8"));
    let text: string;
    if (opts.content !== undefined) {
      // 直接给内容：不碰磁盘（上传路径，见 ImportOptions.content）。
      text = opts.content;
    } else {
      try {
        text = read(path);
      } catch (e) {
        throw new ImportError(
          "file_unreadable",
          `Cannot read ${path}: ${(e as Error).message}. Log in to the ZCode client first, or pass --file.`,
        );
      }
    }
    parsed = parseZcodeCredentialsFile(text, { source: path, ...(opts.provider ? { provider: opts.provider } : {}) });
  }

  const warnings = [...parsed.warnings];
  const provider = opts.provider ?? parsed.provider ?? existing?.provider ?? opts.defaultProvider;
  if (!opts.provider && !parsed.provider && !existing?.provider) {
    warnings.push(`Provider not stated by the source, using "${provider}" (override with --provider).`);
  }

  // Refuse a provider change before the OAuth exchange runs: exchanging costs
  // three network calls and `--replace` is the only way past this check anyway.
  if (existing && !opts.replace && existing.provider !== provider) {
    throw new ImportError(
      "provider_mismatch",
      `Stored credential is ${existing.provider} but the import is ${provider}. Pass --replace to discard the stored credential.`,
    );
  }

  let apiKey: string | undefined;
  let secret: string | undefined;
  if (parsed.apiKeyPair) {
    const dot = parsed.apiKeyPair.indexOf(".");
    apiKey = parsed.apiKeyPair.slice(0, dot);
    secret = parsed.apiKeyPair.slice(dot + 1);
  } else if (parsed.oauthAccessToken) {
    try {
      const resolved = await new KeyResolver(opts.fetchImpl ?? fetch).resolveCodingPlanCredential(
        parsed.oauthAccessToken,
        provider,
      );
      apiKey = resolved.apiKey;
      secret = resolved.secret;
    } catch (e) {
      warnings.push(
        `Could not exchange the OAuth access token for a coding-plan key (${(e as Error).message}). ` +
          "The token may be expired. Re-login in ZCode, or import the apiKey directly.",
      );
    }
  }

  const incoming: Credential = { provider, apiKey: apiKey ?? "" };
  if (secret) incoming.secret = secret;
  if (parsed.jwt) incoming.jwt = parsed.jwt;
  // 上游账号标识：指纹的 apiKey 兜底。JWT-only 导入时它是唯一能区分账号的字段。
  if (parsed.userId) incoming.userId = parsed.userId;
  // Mirrors KeyResolver: only bigmodel's signing plane consumes the bare token.
  if (parsed.oauthAccessToken && provider === "bigmodel") incoming.oauthAccessToken = parsed.oauthAccessToken;

  if (!incoming.apiKey && !incoming.jwt) {
    throw new ImportError("no_credential", "Nothing importable: no apiKey could be resolved and no plan JWT was found.");
  }

  const merged = mergeCredential(existing, incoming, { replace: opts.replace === true });
  await save(merged);

  const jwtInfo = merged.jwt ? inspectJwt(merged.jwt) : null;
  return {
    source: parsed.source,
    provider,
    credential: merged,
    codingPlanReady: Boolean(merged.apiKey && merged.apiKey.trim()),
    startPlanReady: Boolean(merged.jwt),
    ...(jwtInfo?.userId ? { jwtUserId: jwtInfo.userId } : {}),
    ...(parsed.planHint ? { planHint: parsed.planHint } : {}),
    warnings,
  };
}

/**
 * CLI-facing rendering. Kept here (not in index.ts) so the wording is under
 * test, because these lines are the only feedback an import gives.
 * Secrets are truncated to a prefix, matching `auth login` / `auth status`.
 */
export function summarizeImport(report: ImportReport): string[] {
  const prefix = (value: string): string => `${value.slice(0, SECRET_PREFIX_LENGTH)}...`;
  const lines = [
    `Imported from ${report.source}`,
    `  Provider: ${report.provider}`,
    report.credential.apiKey
      ? `  API key:  ${prefix(report.credential.apiKey)}`
      : "  API key:  (none; coding-plan requests will be refused locally)",
    report.credential.jwt
      ? `  Plan JWT: ${prefix(report.credential.jwt)}${report.jwtUserId ? ` (user ${report.jwtUserId})` : ""}`
      : "  Plan JWT: (none; start-plan, quota, MCP, claim and async are unavailable)",
  ];
  if (report.codingPlanReady && report.startPlanReady) {
    lines.push("  Usable:   coding-plan + start-plan");
  } else if (report.codingPlanReady) {
    lines.push("  Usable:   coding-plan");
  } else if (report.startPlanReady) {
    lines.push("  Usable:   start-plan only");
  }
  for (const warning of report.warnings) lines.push(`  ⚠ ${warning}`);
  return lines;
}

export function importFromZCodeConfig(provider: ProviderId): Credential {
  const configPath = join(homedir(), ".zcode", "v2", "config.json");
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    console.error(`Cannot read ${configPath}.`);
    console.error("Make sure ZCode is installed and you've logged in at least once.");
    process.exit(1);
  }

  // 与上面的读文件失败同一口径：`~/.zcode/v2/config.json` 是**别人的**文件，格式不对
  // （半写入、手改过、版本不同）不能以一条 `SyntaxError` 栈喷给用户。
  let config: {
    provider?: Record<string, { options?: { apiKey?: string }; enabled?: boolean }>;
  };
  try {
    config = JSON.parse(raw) as typeof config;
  } catch (err) {
    console.error(`Cannot parse ${configPath}: ${(err as Error).message}`);
    console.error("Make sure ZCode is installed and you've logged in at least once.");
    process.exit(1);
  }

  const providerKey = `builtin:${provider}-coding-plan`;
  const entry = config.provider?.[providerKey];
  const apiKey = entry?.options?.apiKey?.trim();

  if (!apiKey) {
    console.error(`No API key for ${providerKey} in ZCode config.`);
    process.exit(1);
  }

  const startPlanKey = `builtin:${provider}-start-plan`;
  const jwt = config.provider?.[startPlanKey]?.options?.apiKey?.trim() || undefined;

  console.log(`Imported from ${configPath}`);
  if (jwt) console.log(`  Start-plan JWT: ${jwt.slice(0, SECRET_PREFIX_LENGTH)}...`);
  return { apiKey, provider, jwt };
}
