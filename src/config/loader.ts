/**
 * YAML 是用户配置的唯一源，环境变量只喂宿主注入的运行时上下文。
 */
import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import type { ClientIdentityConfig, ProxyConfig, ProviderEndpoints, ProxyIdentity, ResponsesConfig, McpConfig, AsyncConfig, EndpointRoutingConfig, ClientSigningConfig, HighspeedConfig, ClaimConfig, AccountsConfig, AccountsEntryConfig, AccountsRisk, PanelConfig, DumpConfig, ReasoningConfig } from "./types.js";
import { BETA_POLICIES, DEFAULT_ACCOUNTS_RISK, REASONING_MODES, REASONING_EFFORTS } from "./types.js";
import {
  AUTH_FAILED_ACTIONS,
  DEFAULT_ACCOUNTS_ROUTING,
  DEFAULT_ACCOUNTS_STICKINESS,
  DEFAULT_MAX_QUEUE,
  DEFAULT_MAX_TOTAL_INFLIGHT,
  DEFAULT_QUEUE_TIMEOUT_MS,
  DRAINED_ACTIONS,
  ROUTING_MODES,
  ROUTING_STRATEGIES,
  SATURATED_ACTIONS,
  STICKINESS_SATURATED_ACTIONS,
  WITHIN_TIER_ORDERS,
  type AccountsRouting,
  type AccountsStickiness,
} from "../accounts/routing.js";
import { isRouteKind } from "../accounts/routes.js";
import { DEFAULT_ACCOUNTS_QUOTA, type AccountsQuota } from "../accounts/quota.js";
import { validateProxies, type ProxySpec } from "../accounts/proxies.js";
import type { RouteKind } from "../accounts/types.js";
import { detectInstalledApp, isValidAppVersion, type DetectedAppVersion } from "../identity/app-version.js";
import { logger } from "../log/index.js";

/** 配置加载的日志。启动期就要能打，所以这里不依赖 `configureLogging` 是否已跑过。*/
const log = logger("config");

/**
 * 已删除配置键的权威清单：告警文案的选择（`resolveResponsesConfig` 的「协议
 * 常开」提示）与面板写路径的自愈（`routes-state.ts::writeSettings` 保存时剔除）
 * 从同一份事实出发——告警哪些键、清掉哪些键，不许两处各记一遍。
 *
 * 段/键拆开写而不写点串：已删键的完整字面串不回写进源码（rg 扫点串的门禁，见
 * `loader.test.ts` 对残留键断言的注释）；测试里的完整路径用 `join(".")` 拼出来。
 *
 * 只收「键已从配置模型里删除」的残留：现在还存在的键（`auth.requireKey`、
 * `responses.store.*`）永远不进这张表。
 */
export const LEGACY_CONFIG_PATHS: readonly string[][] = [
  ["responses", "enabled"],
  ["auth", "proxyApiKey"],
];

/** [section, key, ...] 是否命中 {@link LEGACY_CONFIG_PATHS} 里的已知残留键。*/
function isLegacyConfigPath(path: readonly string[]): boolean {
  return LEGACY_CONFIG_PATHS.some(
    (legacy) => legacy.length === path.length && legacy.every((segment, i) => segment === path[i]),
  );
}

/**
 * 已告警过哪些残留键路径（进程生命周期，每键只告一次）。
 *
 * 面板任何读配置的路径（设置页快照、账号命令、热重载重读）都会过一遍
 * `loadConfig`，每次重读都把残留键告警打一遍就是刷屏（用户实测：面板日志每约
 * 2.5 分钟重复两条）。启动那一次保留引导价值，运行期重读不再重复——每键最多
 * 一条，靠这张表兑现。测试用 {@link resetLegacyKeyWarnings} 归零。
 */
const legacyKeysWarned = new Set<string>();

/**
 * 从待告警清单里滤掉本进程已经打过的键路径，剩下的就地标记后返回；空数组 =
 * 全部告过，调用方静默。返回非空才打日志是两处告警点的共同形状，所以「标记」
 * 收在这一个函数里，调用方不会出现「打了日志却没标记」的漏配。
 */
function takeUnwarnedLegacyKeys(paths: string[]): string[] {
  const pending = paths.filter((path) => !legacyKeysWarned.has(path));
  for (const path of pending) legacyKeysWarned.add(path);
  return pending;
}

/** 测试归零入口（socks5 warn 也归零：注入内存 sink 的用例要能重新断言一条）。*/
export function resetLegacyKeyWarnings(): void {
  legacyKeysWarned.clear();
  proxyWarningsWarned = false;
}

/**
 * 进程级出线代理的 socks5 前缀告警只打一次。
 *
 * Bun 的 fetch 不认 `socks5://`（`UnsupportedProxyProtocol`），而 `https_proxy` 这类
 * 环境变量会被它读作全局出线代理——于是额度采样/启动探测的失败被 `fetchBilling`
 * 吞成一条 `code: -1`，面板上看不到「为什么全挂」。同端口换 `http://` 即恢复
 * （实测，见全局工具记忆），所以这里只 warn，**不改 fetch 行为、不替用户改环境**。
 */
let proxyWarningsWarned = false;
const PROXY_ENV_NAMES = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "ALL_PROXY", "all_proxy"] as const;

/** 检测并告警（导出给 loader 测试直接钉住；重复调用只打一条）。*/
export function warnUnsupportedProxyProtocol(env: NodeJS.ProcessEnv = process.env): string[] {
  if (proxyWarningsWarned) return [];
  const unsupported = PROXY_ENV_NAMES.filter((name) => {
    const value = env[name];
    return typeof value === "string" && /^socks5(h)?:\/\//i.test(value.trim());
  });
  if (unsupported.length === 0) return [];
  proxyWarningsWarned = true;
  log.warn("proxy env uses socks5 which Bun fetch does not support", {
    variables: unsupported.join(", "),
    hint: "use http://127.0.0.1:<port> on the same proxy port instead; quota sampling will fail otherwise",
  });
  return unsupported;
}

/**
 * 环境变量入口：目前**空**。
 *
 * 数据面凭据现在全部在 `apikeys.json`，由面板 `/keys` 管理。想加新条目之前先
 * 回答一句：为什么不让用户改 config.yaml？
 */

/**
 * Wire fingerprint fallback — used when this machine has no official client to
 * read the version from. It follows the
 * mirror snapshot, so it lags the official release for as long as the snapshot
 * is stale; that is exactly why the detector exists.
 */
export const DEFAULT_APP_VERSION = "3.17.2";

/**
 * 版本号的兜底入口：探测本机客户端，探测不到才用代码默认值（优先级链的后两档）。
 *
 * 登录流程需要这个入口：`auth login` 可以在没有完整配置的场景下跑（容器里首次
 * 登录），而它同样要把版本号放进授权链接的 `app_version`。读过配置的调用方应该
 * 直接用 `config.identity.appVersion`，那条链路还包含手写值。
 */
export function fallbackAppVersion(detect: () => DetectedAppVersion | null = detectInstalledApp): string {
  return detect()?.version ?? DEFAULT_APP_VERSION;
}

const DEFAULTS = {
  PORT: 8080,
  HOST: "0.0.0.0",
  DEFAULT_MODEL: "glm-5.3",
  MODELS: ["glm-5.3", "glm-5.3-flash"],
  LOG_LEVEL: "info" as const,
  /** dump 默认关、默认路径空（= 存储目录下的默认文件）。*/
  DUMP_ENABLED: false,
  DUMP_PATH: "",
  ZAI_ANTHROPIC_BASE: "https://api.z.ai/api/anthropic",
  ZAI_OPENAI_BASE: "https://api.z.ai/api/coding/paas/v4",
  BIGMODEL_ANTHROPIC_BASE: "https://open.bigmodel.cn/api/anthropic",
  BIGMODEL_OPENAI_BASE: "https://open.bigmodel.cn/api/coding/paas/v4",
  SOURCE_TITLE: "cli",
  REFERER_ORIGIN: "https://zcode.z.ai",
  /**
   * Default `identity.betaPolicy`: "drop". The official ZCode CLI
   * sends no `anthropic-beta` unless tool search is on, so sending none is
   * what mirrors it — and it is the risk-first choice either way.
   */
  BETA_POLICY: "drop" as const,
  /** Default `identity.betaAllowlist`: empty — nothing to keep under `drop`. */
  BETA_ALLOWLIST: [] as string[],
  CLIENT_IDENTITY_MODE: "enforce" as const,
  CLIENT_IDENTITY_TTL_SECONDS: 900,
  CLIENT_IDENTITY_MAX_SESSIONS: 1024,
  /** 推理强度默认透传：客户端说了算，零行为变化。effort 仅存不参与逻辑。*/
  REASONING_MODE: "passthrough" as const,
  REASONING_EFFORT: "high" as const,
  RESPONSES_STORE_MAX_ENTRIES: 1000,
  RESPONSES_STORE_TTL_MS: 24 * 60 * 60 * 1000,
  MCP_ENABLED: true,
  MCP_GATEWAY_ENABLED: true,
  /** 面板默认开；`host` 空串 = 跟随 `server.host`。*/
  PANEL_ENABLED: true,
  PANEL_HOST: "",
  /** 数据面默认校验 API key；表里一把 key 都没有时仍然放行。*/
  REQUIRE_KEY: true,
  // Production default for `${ZCODE_BASE_URL}` in plugin .mcp.json URLs (glm
  // bundle `jee`; the `sYe` fallback "https://zcode.chatglm.site" is the TEST
  // env origin — NOT for production traffic. 3.14.3 `p1`/`air`).
  MCP_GATEWAY_ORIGIN: "https://zcode.z.ai",
  ASYNC_ENABLED: false,
  ASYNC_ORIGIN: "https://zcode.z.ai",
  ASYNC_POLL_INTERVAL_MS: 5000,
  ASYNC_KEEPALIVE_INTERVAL_MS: 3000,
  ASYNC_MAX_WAIT_MS: 0,
  ASYNC_MAX_RETRIES: 3,
  ASYNC_SETTLE_TIMEOUT_MS: 8000,
  ASYNC_CONTROL_TIMEOUT_MS: 15000,
  ASYNC_DEFAULT_MODEL: "",
  CLAIM_ENABLED: true,
  CLAIM_AUTO: true,
  CLAIM_ORIGIN: "https://zcode.z.ai",
  CLAIM_POLL_INTERVAL_MS: 300000,
  CLAIM_COOLDOWN_MS: 600000,
  CLAIM_OPENING_PREHEAT_MS: 3 * 60_000,
  CLAIM_OPENING_PROBE_INTERVAL_MS: 10_000,
  CLAIM_OPENING_BURST_INTERVAL_MS: 2_000,
  CLAIM_OPENING_BURST_WINDOW_MS: 3 * 60_000,
  CLAIM_OPENING_ACCOUNT_STAGGER_MS: 200,
  CLAIM_OPENING_MAX_CLAIMS_PER_ACCOUNT: 6,
  CLAIM_POLICY: "upstream-priority",
  CLAIM_SPRINT_WINDOW_MS: 1_800_000,
  CLAIM_SPRINT_POLL_INTERVAL_MS: 60_000,
  ENDPOINT_ROUTING_ENABLED: true,
  ENDPOINT_ROUTING_ORIGIN: "https://zcode.z.ai",
  CLIENT_SIGNING_ENABLED: true,
  HIGHSPEED_ENABLED: true,
  HIGHSPEED_ORIGIN: "https://zcode.z.ai",
  HIGHSPEED_MODELS: ["glm-5.3", "glm-5.2", "glm-5.1"],
};

/**
 * Load and validate proxy configuration from a YAML file, applying env overrides.
 * @throws Error if file not found or required fields are invalid.
 */
export interface LoadConfigOptions {
  /**
   * 本机客户端版本探测。测试用它把探测结果固定下来：开发机上确实装了
   * 官方客户端时，真实探测会让「没探测到」那一条用例失去确定性。
   */
  detectAppVersion?: () => DetectedAppVersion | null;
  /** 只给设置页的重复读：跳过启动期 once-only 的 socks5 提示。*/
  quiet?: boolean;
}

/**
 * 读配置用于设置页快照 / 写盘校验时的**静默变体**。
 *
 * socks5 提示是启动期的事：一次 `serve` 的 `loadConfig` 打一条就够了。设置页每次
 * 打开、每次保存都会 `readSettings` → `loadConfig`，若在那里也打，日志页会被同一
 * 条提示刷屏（残留键告警踩过的坑）。这个入口只给 `routes-state.ts` 的读写校验
 * 用，不改变任何解析与默认值。
 */
export function loadConfigQuiet(path: string, options: LoadConfigOptions = {}): ProxyConfig {
  return loadConfig(path, { ...options, quiet: true });
}

export function loadConfig(path: string, options: LoadConfigOptions = {}): ProxyConfig {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parse(raw) ?? {};

  // --- server ---
  const port = resolvePort(parsed?.server?.port);
  const host = typeof parsed?.server?.host === "string" ? parsed.server.host : DEFAULTS.HOST;

  // --- auth ---
  const auth = resolveAuthConfig(parsed?.auth);

  // --- providers ---
  const zai = resolveProviderEndpoints("zai", parsed?.providers?.zai, {
    anthropicBase: DEFAULTS.ZAI_ANTHROPIC_BASE,
    openaiBase: DEFAULTS.ZAI_OPENAI_BASE,
  });
  const bigmodel = resolveProviderEndpoints("bigmodel", parsed?.providers?.bigmodel, {
    anthropicBase: DEFAULTS.BIGMODEL_ANTHROPIC_BASE,
    openaiBase: DEFAULTS.BIGMODEL_OPENAI_BASE,
  });

  // --- models ---
  const defaultModel = typeof parsed?.defaultModel === "string" ? parsed.defaultModel : DEFAULTS.DEFAULT_MODEL;
  const models = Array.isArray(parsed?.models) ? parsed.models : [...DEFAULTS.MODELS];

  // --- logging ---
  const logLevel = resolveLogLevel(parsed?.logging?.level);
  const dump = resolveDumpConfig(parsed?.logging?.dump);

  // --- identity ---
  const identity = resolveIdentity({
    sourceTitleYaml: parsed?.identity?.sourceTitle,
    refererYaml: parsed?.identity?.refererOrigin,
    betaPolicyYaml: parsed?.identity?.betaPolicy,
    betaAllowlistYaml: parsed?.identity?.betaAllowlist,
    appVersionYaml: parsed?.identity?.appVersion,
    detectAppVersion: options.detectAppVersion ?? detectInstalledApp,
  });

  const clientIdentity = resolveClientIdentity(parsed?.clientIdentity);
  const reasoning = resolveReasoningConfig(parsed?.reasoning);
  const panel = resolvePanelConfig(parsed?.panel);
  const responses = resolveResponsesConfig(parsed?.responses);
  const mcp = resolveMcpConfig(parsed?.mcp);
  const asyncCfg = resolveAsyncConfig(parsed?.async);
  const claimCfg = resolveClaimConfig(parsed?.claim);
  const accountsCfg = resolveAccountsConfig(parsed?.accounts);
  const endpointRouting = resolveEndpointRoutingConfig(parsed?.endpointRouting);
  const clientSigning = resolveClientSigningConfig(parsed?.clientSigning);
  const highspeed = resolveHighspeedConfig(parsed?.highspeed);

  const config: ProxyConfig = {
    server: { port, host },
    auth,
    panel,
    providers: { zai, bigmodel },
    defaultModel,
    models,
    identity,
    clientIdentity,
    reasoning,
    responses,
    endpointRouting,
    clientSigning,
  highspeed,
    mcp,
    async: asyncCfg,
    claim: claimCfg,
    accounts: accountsCfg,
    logging: { level: logLevel, dump },
  };

  validate(config);
  // 只在启动期那一次加载成功后告警；设置页/测试频繁重读走 `quiet`。
  if (!options.quiet) warnUnsupportedProxyProtocol();
  return config;
}

/**
 * 解析一家的端点覆盖，并在**边界**上校验（空串 / 非法 URL 直接报错）。
 *
 * 为什么在这里校验而不是让出线层兜底：`providers.*.anthropicBase` 是
 * `proxy/route-endpoint.ts` 里 `coding-plan` 的基准地址，一旦是空串或拼错，
 * 请求会打到一个不存在的 URL 上，用户看到的是莫名其妙的 502/404；而配置里
 * 那个错字谁都不会去怀疑。校验放在读配置这一步，错误就指向用户自己写的那一行。
 *
 * 默认值来自 `DEFAULTS`（与路由表 `accounts/routes.ts` 的官方端点逐字一致），
 * 所以"没写"永远是合法的，只有"写了但不合法"才会抛。
 */
function resolveProviderEndpoints(
  family: string,
  raw: unknown,
  defaults: ProviderEndpoints,
): ProviderEndpoints {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    anthropicBase: resolveBaseUrl(obj.anthropicBase, defaults.anthropicBase, `providers.${family}.anthropicBase`),
    openaiBase: resolveBaseUrl(obj.openaiBase, defaults.openaiBase, `providers.${family}.openaiBase`),
  };
}

/** 端点基址：缺省用默认值；写了就必须是 http(s) 绝对 URL（路径可以有，那是端点自身的一部分）。*/
function resolveBaseUrl(raw: unknown, fallback: string, name: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`${name} must be a non-empty URL string`);
  }
  const value = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} "${value}" is not a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${name} must use http: or https: scheme (got ${parsed.protocol})`);
  }
  return value.replace(/\/+$/, "");
}

function resolveClientIdentity(raw: unknown): ClientIdentityConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const mode = resolveClientIdentityMode(obj.mode);
  const ttlSeconds = resolvePositiveInt(obj.ttlSeconds, DEFAULTS.CLIENT_IDENTITY_TTL_SECONDS, "clientIdentity.ttlSeconds");
  const maxSessions = resolvePositiveInt(obj.maxSessions, DEFAULTS.CLIENT_IDENTITY_MAX_SESSIONS, "clientIdentity.maxSessions");
  return { mode, ttlSeconds, maxSessions };
}

function resolveClientIdentityMode(raw: unknown): ClientIdentityConfig["mode"] {
  if (raw === undefined || raw === null) return DEFAULTS.CLIENT_IDENTITY_MODE;
  if (raw === "off" || raw === "observe" || raw === "enforce") return raw;
  throw new Error(`Invalid clientIdentity.mode "${String(raw)}": must be "off", "observe", or "enforce"`);
}

/**
 * `reasoning` 段：推理强度透传/覆盖。两个键都是枚举，写错即抛（与
 * `resolveEnum` 的风控口径一致——静默回落会让「以为在覆盖」变成「悄悄透传」）。
 * `mode: passthrough` 时 `effort` 仅存不参与逻辑，但仍校验合法值：设置页写盘
 * 的值不该带着非法状态躺在配置里。
 */
function resolveReasoningConfig(raw: unknown): ReasoningConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    mode: resolveEnum(obj.mode, REASONING_MODES, DEFAULTS.REASONING_MODE, "reasoning.mode"),
    effort: resolveEnum(obj.effort, REASONING_EFFORTS, DEFAULTS.REASONING_EFFORT, "reasoning.effort"),
  };
}

/** `responses` 段认识的键：协议常开，段里只剩 store 两个调优参数。*/
const RESPONSES_KEYS = ["store"] as const;

function resolveResponsesConfig(raw: unknown): ResponsesConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  // 残留的开关键点名告警而不是静默忽略：用户写 `enabled: false` 时多半以为
  // 协议真的关了，而它照样挂着，得让对方知道语义。文案按**这次真正要打的键**
  // 选（去重之后可能只剩一部分）：命中 LEGACY_CONFIG_PATHS 才提「协议常开」，
  // 别的未知键走通用文案。
  const unknown = Object.keys(obj).filter((key) => !RESPONSES_KEYS.includes(key as (typeof RESPONSES_KEYS)[number]));
  const pending = takeUnwarnedLegacyKeys(unknown.map((key) => `responses.${key}`));
  if (pending.length > 0) {
    const hitLegacySwitch = pending.some((path) => isLegacyConfigPath(path.split(".")));
    log.warn(
      hitLegacySwitch
        ? "the enabled key under responses is gone: /v1/responses is always on; remove it from config.yaml"
        : "ignoring unknown responses keys",
      { keys: pending },
    );
  }
  const storeRaw = obj.store && typeof obj.store === "object" ? obj.store as Record<string, unknown> : {};
  return {
    storeMaxEntries: resolvePositiveInt(storeRaw.maxEntries, DEFAULTS.RESPONSES_STORE_MAX_ENTRIES, "responses.store.maxEntries"),
    storeTtlMs: resolvePositiveInt(storeRaw.ttlMs, DEFAULTS.RESPONSES_STORE_TTL_MS, "responses.store.ttlMs"),
  };
}

function resolveMcpConfig(raw: unknown): McpConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const gwRaw = obj.gateway && typeof obj.gateway === "object" ? obj.gateway as Record<string, unknown> : {};
  const gwOrigin = (typeof gwRaw.upstreamOrigin === "string" ? gwRaw.upstreamOrigin : DEFAULTS.MCP_GATEWAY_ORIGIN).trim()
    || DEFAULTS.MCP_GATEWAY_ORIGIN;
  validateOrigin(gwOrigin, "mcp.gateway.upstreamOrigin");
  return {
    enabled: resolveBool(obj.enabled, DEFAULTS.MCP_ENABLED),
    gateway: {
      enabled: resolveBool(gwRaw.enabled, DEFAULTS.MCP_GATEWAY_ENABLED),
      upstreamOrigin: gwOrigin,
    },
  };
}

function resolveAsyncConfig(raw: unknown): AsyncConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};

  const origin = (typeof obj.origin === "string" ? obj.origin : DEFAULTS.ASYNC_ORIGIN).trim() || DEFAULTS.ASYNC_ORIGIN;
  validateOrigin(origin, "async.origin");

  return {
    enabled: resolveBool(obj.enabled, DEFAULTS.ASYNC_ENABLED),
    origin,
    pollIntervalMs: resolvePositiveInt(obj.pollIntervalMs ?? obj.poll_interval_ms, DEFAULTS.ASYNC_POLL_INTERVAL_MS, "async.pollIntervalMs"),
    keepAliveIntervalMs: resolvePositiveInt(obj.keepAliveIntervalMs ?? obj.keepalive_interval_ms, DEFAULTS.ASYNC_KEEPALIVE_INTERVAL_MS, "async.keepAliveIntervalMs"),
    maxWaitMs: resolveNonNegativeInt(obj.maxWaitMs ?? obj.max_wait_ms, DEFAULTS.ASYNC_MAX_WAIT_MS, "async.maxWaitMs"),
    maxRetries: resolveNonNegativeInt(obj.maxRetries ?? obj.max_retries, DEFAULTS.ASYNC_MAX_RETRIES, "async.maxRetries"),
    settleTimeoutMs: resolvePositiveInt(obj.settleTimeoutMs ?? obj.settle_timeout_ms, DEFAULTS.ASYNC_SETTLE_TIMEOUT_MS, "async.settleTimeoutMs"),
    controlTimeoutMs: resolvePositiveInt(obj.controlTimeoutMs ?? obj.control_timeout_ms, DEFAULTS.ASYNC_CONTROL_TIMEOUT_MS, "async.controlTimeoutMs"),
    defaultModel: typeof obj.defaultModel === "string" ? obj.defaultModel : DEFAULTS.ASYNC_DEFAULT_MODEL,
  };
}

function validateOrigin(origin: string, name: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`${name} "${origin}" is not a valid URL`);
  }
  // Scheme allowlist: only http/https. Other schemes (ftp:, file:, etc.) rejected.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${name} must use http: or https: scheme (got ${parsed.protocol})`);
  }
  // Cleartext HTTP only for loopback (dev/mock mode). Real off-peak backend requires
  // HTTPS — cleartext would leak the JWT + coding-plan API key to any network observer.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const isLoopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  if (parsed.protocol === "http:" && !isLoopback) {
    throw new Error(`${name} http:// is only allowed for loopback hosts (got ${hostname}). Use https:// for remote origins.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain userinfo`);
  }
  if (parsed.hash) {
    throw new Error(`${name} must not contain a fragment`);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(`${name} must not contain a path (got "${parsed.pathname}"); clients append their own paths`);
  }
  if (parsed.search) {
    throw new Error(`${name} must not contain a query string`);
  }
}

function resolveEndpointRoutingConfig(raw: unknown): EndpointRoutingConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const origin = (typeof obj.origin === "string" ? obj.origin : DEFAULTS.ENDPOINT_ROUTING_ORIGIN).trim()
    || DEFAULTS.ENDPOINT_ROUTING_ORIGIN;
  validateOrigin(origin, "endpointRouting.origin");
  return {
    enabled: resolveBool(obj.enabled, DEFAULTS.ENDPOINT_ROUTING_ENABLED),
    origin,
  };
}

/**
 * `auth` 段认识的键（多出来的那个按「旧配置残留」告警，见下）。*/
const AUTH_KEYS = ["requireKey"] as const;

/**
 * `auth` 段：只剩「要不要校验」这一个开关。
 *
 * 多出来的键一律**忽略并告警**：静默忽略等于让数据面比用户以为的更开放（表空的
 * 默认状态就是放行），一句告警至少指得着新入口。不提具体键名——这段配置只认识
 * `requireKey`，任何别的键都是残留，维护一张历史键表没有意义。
 */
function resolveAuthConfig(raw: unknown): ProxyConfig["auth"] {
  const section = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const unknown = Object.keys(section).filter((key) => !AUTH_KEYS.includes(key as (typeof AUTH_KEYS)[number]));
  // 接进程级去重（takeUnwarnedLegacyKeys）——启动打一次，重读不再刷屏。
  const pending = takeUnwarnedLegacyKeys(unknown.map((key) => `auth.${key}`));
  if (pending.length > 0) {
    log.warn(
      "ignoring unknown auth keys; data-plane keys live in apikeys.json now, create one in the panel at /keys",
      { keys: pending },
    );
  }
  return { requireKey: resolveBool(section.requireKey, DEFAULTS.REQUIRE_KEY) };
}

/**
 * `panel` 段：只有开关与绑定。
 *
 * 没有环境变量入口：一个开关只能有一个写入口。`--no-panel` 是启动参数，不是配置
 * 源，它由调用方在解析之后覆盖（`resolvePanelSettings` 的 `disabled`）。
 *
 * 默认开：面板是唯一能看的控制面，新装用户不该先发现一个环境变量才能用上它。
 */
function resolvePanelConfig(raw: unknown): PanelConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    enabled: resolveBool(obj.enabled, DEFAULTS.PANEL_ENABLED),
    host: typeof obj.host === "string" ? obj.host.trim() : DEFAULTS.PANEL_HOST,
  };
}

function resolveClientSigningConfig(raw: unknown): ClientSigningConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    enabled: resolveBool(obj.enabled, DEFAULTS.CLIENT_SIGNING_ENABLED),
  };
}

function resolveHighspeedConfig(raw: unknown): HighspeedConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const origin = (typeof obj.origin === "string" ? obj.origin : DEFAULTS.HIGHSPEED_ORIGIN).trim()
    || DEFAULTS.HIGHSPEED_ORIGIN;
  validateOrigin(origin, "highspeed.origin");
  const models = Array.isArray(obj.models)
    ? obj.models.filter((m): m is string => typeof m === "string" && m.trim().length > 0).map((m) => m.trim())
    : DEFAULTS.HIGHSPEED_MODELS;
  return {
    enabled: resolveBool(obj.enabled, DEFAULTS.HIGHSPEED_ENABLED),
    origin,
    models,
  };
}

function resolveBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw === "true" || raw === "1";
  return fallback;
}

function resolvePositiveInt(raw: unknown, fallback: number, name: string): number {
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function resolveNonNegativeInt(raw: unknown, fallback: number, name: string): number {
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return n;
}

/** Resolve port from raw value (YAML or env), defaulting to 8080. */
function resolvePort(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULTS.PORT;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n)) {
    throw new Error("server.port must be a valid number");
  }
  return n;
}

/** Resolve log level with fallback. */
function resolveLogLevel(raw: unknown): "debug" | "info" | "warn" | "error" {
  const levels = ["debug", "info", "warn", "error"] as const;
  if (typeof raw === "string" && (levels as readonly string[]).includes(raw)) {
    return raw as "debug" | "info" | "warn" | "error";
  }
  return DEFAULTS.LOG_LEVEL;
}

/**
 * `logging.dump`：开关加可选路径。
 *
 * 不校验路径内容：文件路径没有像 URL 那样的协议白名单可查，写什么由 dump 自己
 * 在打开文件时兜（打开失败只吞错，见 `proxy/dump.ts` 的纪律）。空串与缺省都是
 * 「用存储目录下的默认文件」。
 */
function resolveDumpConfig(raw: unknown): DumpConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    enabled: resolveBool(obj.enabled, DEFAULTS.DUMP_ENABLED),
    path: typeof obj.path === "string" ? obj.path.trim() : DEFAULTS.DUMP_PATH,
  };
}

interface IdentityInputs {
  sourceTitleYaml?: string;
  refererYaml?: string;
  betaPolicyYaml?: unknown;
  betaAllowlistYaml?: unknown;
  /** `identity.appVersion` 的手写值；空串与缺省都是「自动」。*/
  appVersionYaml?: unknown;
  /** 版本探测入口（测试注入）。缺省读本机文件系统。*/
  detectAppVersion: () => DetectedAppVersion | null;
}

/** Resolve identity fields (YAML > detected client > default).
 *
 * `appVersion` 是唯一有优先级链的字段：手写值 > 本机探测值 >
 * `DEFAULT_APP_VERSION`。探测结果跟着本机装的官方客户端走，代码里的常量只是
 * 兜底。
 *
 * 每个账号的 device 指纹在这里没有任何入口：它属于账号，不属于进程级
 * 身份。*/
function resolveIdentity(inp: IdentityInputs): ProxyIdentity {
  const sourceTitle = (inp.sourceTitleYaml ?? DEFAULTS.SOURCE_TITLE).trim()
    || DEFAULTS.SOURCE_TITLE;

  const refererOrigin = (inp.refererYaml ?? DEFAULTS.REFERER_ORIGIN).trim()
    || DEFAULTS.REFERER_ORIGIN;

  // 写错即抛，不静默回落：`betaPolicy: drops` 会悄悄变成「一条 beta
  // 都不发」之外的语义，而这个方案只有一个安全默认值，不该猜用户想说什么。
  const betaPolicy = resolveEnum(inp.betaPolicyYaml, BETA_POLICIES, DEFAULTS.BETA_POLICY, "identity.betaPolicy");
  const betaAllowlist = resolveBetaAllowlist(inp.betaAllowlistYaml);
  return {
    ...resolveAppVersion(inp.appVersionYaml, inp.detectAppVersion),
    sourceTitle,
    refererOrigin,
    betaPolicy,
    betaAllowlist,
  };
}

/**
 * `identity.appVersion` 的优先级链。
 *
 * 手写值格式不对就抛，不静默回落到探测值：用户写错之后默默拿另一个号出线，比
 * 直接起不来难查得多。空串与缺省的语义都是「自动」，所以清空输入框就能退出手动
 * 指定。
 */
function resolveAppVersion(
  raw: unknown,
  detect: () => DetectedAppVersion | null,
): Pick<ProxyIdentity, "appVersion" | "appVersionSource" | "appVersionSourcePath"> {
  if (raw !== undefined && raw !== null && typeof raw !== "string") {
    throw new Error(`identity.appVersion must be a string in x.y.z form (got ${typeof raw})`);
  }
  const manual = typeof raw === "string" ? raw.trim() : "";
  if (manual !== "") {
    if (!isValidAppVersion(manual)) {
      throw new Error(`identity.appVersion "${manual}" must be x.y.z (three numeric parts)`);
    }
    return { appVersion: manual, appVersionSource: "manual" };
  }

  const detected = detect();
  if (detected) {
    return { appVersion: detected.version, appVersionSource: "detected", appVersionSourcePath: detected.path };
  }
  return { appVersion: DEFAULT_APP_VERSION, appVersionSource: "default" };
}

/**
 * `identity.betaAllowlist`：逐条规范化成小写、去掉首尾空白与空项、
 * 按大小写不敏感去重。
 *
 * 归一化放在读配置这一步，出线层（`proxy/upstream.ts`）就能直接做集合比对，
 * 不必在每请求的循环里反复 trim/lowercase。写错类型（字符串而非数组、数组里
 * 塞数字）直接抛：白名单是风控开关，静默忽略一个拼错的元素等于让用户以为它
 * 在生效。
 */
function resolveBetaAllowlist(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [...DEFAULTS.BETA_ALLOWLIST];
  if (!Array.isArray(raw)) {
    throw new Error("identity.betaAllowlist must be a list of strings");
  }
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new Error(`identity.betaAllowlist entries must be strings (got ${typeof entry})`);
    }
    const normalized = entry.trim().toLowerCase();
    if (normalized !== "") seen.add(normalized);
  }
  return [...seen];
}

/**
 * `accounts` 段。
 *
 * 四层：`routing`（调度 / 队列 / 全局并发）、`stickiness`（粘性参数）、`quota`
 * （额度采样）、`risk`（风控开关：`jitterHeartbeat` + 命名代理表的
 * `defaultProxy`）、`entries`（按 label 的策略覆盖）。缺失一律回落实现模块的默认值（`accounts/routing.ts` /
 * `accounts/quota.ts` / `config/types.ts::DEFAULT_ACCOUNTS_RISK`）："只导入账号、
 * 不写策略也能跑"。
 *
 * 写错就抛，不静默回落：`onSaturated: overflo` 这种拼写错误如果被悄悄当成 `wait`，
 * 用户会以为自己在溢出而实际上在排队，风控语义完全反了（R12）。
 */
function resolveAccountsConfig(raw: unknown): AccountsConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const proxies = resolveProxies(obj.proxies);
  const entries = resolveAccountEntries(obj.entries);
  const risk = resolveAccountsRisk(obj.risk);
  // 引用校验放在三块都解析完之后：代理名、条目引用、默认值分属三处，任何一处
  // 单独校验都看不到「引用了已停用的代理」这种跨块错误。
  validateProxies(proxies, [
    ...entries.map((entry) => ({ where: `accounts.entries[${entry.label}].proxy`, name: entry.proxy })),
    { where: "accounts.risk.defaultProxy", name: risk.defaultProxy },
  ]);
  return {
    routing: resolveAccountsRouting(obj.routing),
    stickiness: resolveAccountsStickiness(obj.stickiness),
    quota: resolveAccountsQuota(obj.quota),
    risk,
    entries,
    proxies,
  };
}

/**
 * `accounts.proxies[]`：命名出口代理表。
 *
 * 只在这里做**形状**校验（类型、非空、可选的认证字段）；协议白名单与引用完整性
 * 交给 `accounts/proxies.ts::validateProxies`，因为那里同时看得到 `entries[]` 与
 * `risk.defaultProxy`，一处实现避免两处规则漂移。
 */
function resolveProxies(raw: unknown): ProxySpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("accounts.proxies must be a list");

  const proxies: ProxySpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") throw new Error("accounts.proxies[] must be an object");
    const obj = item as Record<string, unknown>;
    if (typeof obj.name !== "string" || obj.name.trim() === "") {
      throw new Error("accounts.proxies[].name must be a non-empty string");
    }
    const name = obj.name.trim();
    if (typeof obj.url !== "string" || obj.url.trim() === "") {
      throw new Error(`accounts.proxies[${name}].url must be a non-empty string`);
    }
    const proxy: ProxySpec = { name, url: obj.url.trim() };
    if (obj.username !== undefined) {
      if (typeof obj.username !== "string") throw new Error(`accounts.proxies[${name}].username must be a string`);
      proxy.username = obj.username;
    }
    if (obj.password !== undefined) {
      if (typeof obj.password !== "string") throw new Error(`accounts.proxies[${name}].password must be a string`);
      proxy.password = obj.password;
    }
    if (obj.enabled !== undefined) {
      proxy.enabled = resolveOptionalBool(obj.enabled, true, `accounts.proxies[${name}].enabled`);
    }
    proxies.push(proxy);
  }
  return proxies;
}

/**
 * `accounts.risk`：风控开关。当前只解析 `jitterHeartbeat`。
 *
 * 严格校验而非 `resolveBool` 的宽容归一：风控开关的取值直接决定“N 个账号是否
 * 同拍抽卡”，把一个拼错的字符串悄悄当成 `true`（或当成 `false`）都是在拿风控换
 * 省事（枚举写错即抛，不给静默兜底）。
 */
function resolveAccountsRisk(raw: unknown): AccountsRisk {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const risk: AccountsRisk = { ...DEFAULT_ACCOUNTS_RISK };
  const value = obj.jitterHeartbeat ?? obj.jitter_heartbeat;
  if (value !== undefined && value !== null) {
    if (typeof value !== "boolean") {
      throw new Error("accounts.risk.jitterHeartbeat must be a boolean");
    }
    risk.jitterHeartbeat = value;
  }
  const defaultProxy = obj.defaultProxy ?? obj.default_proxy;
  if (defaultProxy !== undefined && defaultProxy !== null) {
    if (typeof defaultProxy !== "string" || defaultProxy.trim() === "") {
      throw new Error("accounts.risk.defaultProxy must be a non-empty string");
    }
    risk.defaultProxy = defaultProxy.trim();
  }
  return risk;
}

/**
 * `accounts.quota`：额度采样周期与 drained 阈值。
 *
 * 两项都是 L2 运维旋钮，可缺省：
 * - `pollSeconds` 默认 300（R14）。写小了等于把探测频率提上去，所以不提供"调成 0
 *   就是实时"这种语义，下界是 1 秒；
 * - `drainThreshold` 是**已用比例**（默认 1.0 = 100%），必须允许小数，有人会把
 *   它调到 0.95 提前降级。
 */
function resolveAccountsQuota(raw: unknown): AccountsQuota {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    pollSeconds: resolvePositiveInt(
      obj.pollSeconds ?? obj.poll_seconds,
      DEFAULT_ACCOUNTS_QUOTA.pollSeconds,
      "accounts.quota.pollSeconds",
    ),
    drainThreshold: resolvePositiveFloat(
      obj.drainThreshold ?? obj.drain_threshold,
      DEFAULT_ACCOUNTS_QUOTA.drainThreshold,
      "accounts.quota.drainThreshold",
    ),
  };
}

function resolveAccountsRouting(raw: unknown): AccountsRouting {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    order: resolveRoutingOrder(obj.order),
    withinTier: resolveEnum(
      obj.withinTier ?? obj.within_tier,
      WITHIN_TIER_ORDERS,
      DEFAULT_ACCOUNTS_ROUTING.withinTier,
      "accounts.routing.withinTier",
    ),
    mode: resolveEnum(obj.mode, ROUTING_MODES, DEFAULT_ACCOUNTS_ROUTING.mode, "accounts.routing.mode"),
    strategy: resolveEnum(
      obj.strategy,
      ROUTING_STRATEGIES,
      DEFAULT_ACCOUNTS_ROUTING.strategy,
      "accounts.routing.strategy",
    ),
    onSaturated: resolveEnum(
      obj.onSaturated ?? obj.on_saturated,
      SATURATED_ACTIONS,
      DEFAULT_ACCOUNTS_ROUTING.onSaturated,
      "accounts.routing.onSaturated",
    ),
    onDrained: resolveEnum(
      obj.onDrained ?? obj.on_drained,
      DRAINED_ACTIONS,
      DEFAULT_ACCOUNTS_ROUTING.onDrained,
      "accounts.routing.onDrained",
    ),
    onAuthFailed: resolveEnum(
      obj.onAuthFailed ?? obj.on_auth_failed,
      AUTH_FAILED_ACTIONS,
      DEFAULT_ACCOUNTS_ROUTING.onAuthFailed,
      "accounts.routing.onAuthFailed",
    ),
    queueTimeoutMs: resolvePositiveInt(
      obj.queueTimeoutMs ?? obj.queue_timeout_ms,
      DEFAULT_QUEUE_TIMEOUT_MS,
      "accounts.routing.queueTimeoutMs",
    ),
    maxQueue: resolvePositiveInt(obj.maxQueue ?? obj.max_queue, DEFAULT_MAX_QUEUE, "accounts.routing.maxQueue"),
    maxTotalInflight: resolvePositiveInt(
      obj.maxTotalInflight ?? obj.max_total_inflight,
      DEFAULT_MAX_TOTAL_INFLIGHT,
      "accounts.routing.maxTotalInflight",
    ),
  };
}

/** 降级顺序。**不排序、不补全**：顺序就是权益紧迫度，只去重（重复项会让降级多跑一轮）。*/
function resolveRoutingOrder(raw: unknown): RouteKind[] {
  if (raw === undefined || raw === null) return [...DEFAULT_ACCOUNTS_ROUTING.order];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("accounts.routing.order must be a non-empty list of route kinds");
  }
  const order: RouteKind[] = [];
  for (const item of raw) {
    if (!isRouteKind(item)) {
      throw new Error(`accounts.routing.order contains an unknown route: ${String(item)}`);
    }
    if (!order.includes(item)) order.push(item);
  }
  return order;
}

function resolveAccountsStickiness(raw: unknown): AccountsStickiness {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    enabled: resolveOptionalBool(obj.enabled, DEFAULT_ACCOUNTS_STICKINESS.enabled, "accounts.stickiness.enabled"),
    ttlSeconds: resolvePositiveInt(
      obj.ttlSeconds ?? obj.ttl_seconds,
      DEFAULT_ACCOUNTS_STICKINESS.ttlSeconds,
      "accounts.stickiness.ttlSeconds",
    ),
    maxSessions: resolvePositiveInt(
      obj.maxSessions ?? obj.max_sessions,
      DEFAULT_ACCOUNTS_STICKINESS.maxSessions,
      "accounts.stickiness.maxSessions",
    ),
    onSaturated: resolveEnum(
      obj.onSaturated ?? obj.on_saturated,
      STICKINESS_SATURATED_ACTIONS,
      DEFAULT_ACCOUNTS_STICKINESS.onSaturated,
      "accounts.stickiness.onSaturated",
    ),
    overflowAfterMs: resolvePositiveInt(
      obj.overflowAfterMs ?? obj.overflow_after_ms,
      DEFAULT_ACCOUNTS_STICKINESS.overflowAfterMs,
      "accounts.stickiness.overflowAfterMs",
    ),
  };
}

/**
 * `accounts.entries[]`。
 *
 * 只校验、不补默认值：`enabled` / `weight` / `maxConcurrency` 缺省 = "跟随账号自身
 * policy"（`overrides.ts::resolvePolicy` 的优先级链），在这里补成具体值会把"用户
 * 没写"与"用户写了默认值"混成一件事。
 */
function resolveAccountEntries(raw: unknown): AccountsEntryConfig[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("accounts.entries must be a list");

  const entries: AccountsEntryConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") throw new Error("accounts.entries[] must be an object");
    const obj = item as Record<string, unknown>;
    if (typeof obj.label !== "string" || obj.label.trim() === "") {
      throw new Error("accounts.entries[].label must be a non-empty string");
    }
    const label = obj.label.trim();
    if (entries.some((entry) => entry.label === label)) {
      throw new Error(`accounts.entries has a duplicate label "${label}"`);
    }

    const entry: AccountsEntryConfig = { label };
    if (obj.enabled !== undefined) {
      entry.enabled = resolveOptionalBool(obj.enabled, true, `accounts.entries[${label}].enabled`);
    }
    if (obj.weight !== undefined) {
      entry.weight = resolveMinInt(obj.weight, 1, `accounts.entries[${label}].weight`);
    }
    if (obj.maxConcurrency !== undefined) {
      entry.maxConcurrency = resolveMinInt(obj.maxConcurrency, 0, `accounts.entries[${label}].maxConcurrency`);
    }
    // 上游 RPM 閘：`0` 在这里无意义（被闸死），下界取 1。
    if (obj.rpmLimit !== undefined) {
      entry.rpmLimit = resolveMinInt(obj.rpmLimit, 1, `accounts.entries[${label}].rpmLimit`);
    }
    // 出口代理引用：名字或 `direct`，存在性由 `validateProxies` 校验。
    if (obj.proxy !== undefined) {
      if (typeof obj.proxy !== "string" || obj.proxy.trim() === "") {
        throw new Error(`accounts.entries[${label}].proxy must be a non-empty string`);
      }
      entry.proxy = obj.proxy.trim();
    }
    entries.push(entry);
  }
  return entries;
}

/** 枚举取值：写错必须报错，不能静默回落（风控语义相反时最难排查，见 {@link resolveAccountsConfig}）。*/
function resolveEnum<T extends string>(raw: unknown, allowed: readonly T[], fallback: T, name: string): T {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "string" && (allowed as readonly string[]).includes(raw)) return raw as T;
  throw new Error(`${name} "${String(raw)}" is invalid; expected one of: ${allowed.join(", ")}`);
}

/** 可选布尔：缺省用默认值，写了就必须是布尔（`"true"` / `"false"` 也接受，与 env 口径一致）。*/
function resolveOptionalBool(raw: unknown, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === "false") return raw === "true";
  throw new Error(`${name} must be a boolean`);
}

/** 可选整数（带下界）：`weight >= 1`、`maxConcurrency >= 0`（0 = 软禁用）。*/
function resolveMinInt(raw: unknown, min: number, name: string): number {
  const value = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return value;
}

/**
 * 可选正浮点数（`accounts.quota.drainThreshold` 这类比例旋钮，默认 1.0）。
 *
 * 不用 {@link resolveMinInt}：比例必须是小数。下界是开区间 0：`0` 会让任何一次
 * 采样都判定耗尽（`fraction >= 0` 恒真），把全部账号一起判死。
 */
function resolvePositiveFloat(raw: unknown, fallback: number, name: string): number {
  if (raw === undefined || raw === null) return fallback;
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function resolveClaimConfig(raw: unknown): ClaimConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};

  const origin = (typeof obj.origin === "string" ? obj.origin : DEFAULTS.CLAIM_ORIGIN).trim() || DEFAULTS.CLAIM_ORIGIN;
  validateOrigin(origin, "claim.origin");
  const openingRaw = obj.opening && typeof obj.opening === "object" ? obj.opening as Record<string, unknown> : {};
  const policy = typeof obj.policy === "string" && obj.policy.trim() ? obj.policy.trim() : DEFAULTS.CLAIM_POLICY;

  return {
    enabled: resolveBool(obj.enabled, DEFAULTS.CLAIM_ENABLED),
    auto: resolveBool(obj.auto, DEFAULTS.CLAIM_AUTO),
    origin,
    pollIntervalMs: resolvePositiveInt(obj.pollIntervalMs ?? obj.poll_interval_ms, DEFAULTS.CLAIM_POLL_INTERVAL_MS, "claim.pollIntervalMs"),
    cooldownMs: resolvePositiveInt(obj.cooldownMs ?? obj.cooldown_ms, DEFAULTS.CLAIM_COOLDOWN_MS, "claim.cooldownMs"),
    // Probe and burst hit the feed directly; a 1s floor keeps a typo from
    // saturating the upstream rate-limit window.
    opening: {
      preheatMs: resolveNonNegativeInt(openingRaw.preheatMs ?? openingRaw.preheat_ms, DEFAULTS.CLAIM_OPENING_PREHEAT_MS, "claim.opening.preheatMs"),
      probeIntervalMs: Math.max(1_000, resolvePositiveInt(openingRaw.probeIntervalMs ?? openingRaw.probe_interval_ms, DEFAULTS.CLAIM_OPENING_PROBE_INTERVAL_MS, "claim.opening.probeIntervalMs")),
      burstIntervalMs: Math.max(1_000, resolvePositiveInt(openingRaw.burstIntervalMs ?? openingRaw.burst_interval_ms, DEFAULTS.CLAIM_OPENING_BURST_INTERVAL_MS, "claim.opening.burstIntervalMs")),
      burstWindowMs: resolveNonNegativeInt(openingRaw.burstWindowMs ?? openingRaw.burst_window_ms, DEFAULTS.CLAIM_OPENING_BURST_WINDOW_MS, "claim.opening.burstWindowMs"),
      accountStaggerMs: resolveNonNegativeInt(openingRaw.accountStaggerMs ?? openingRaw.account_stagger_ms, DEFAULTS.CLAIM_OPENING_ACCOUNT_STAGGER_MS, "claim.opening.accountStaggerMs"),
      maxClaimsPerAccount: resolvePositiveInt(openingRaw.maxClaimsPerAccount ?? openingRaw.max_claims_per_account, DEFAULTS.CLAIM_OPENING_MAX_CLAIMS_PER_ACCOUNT, "claim.opening.maxClaimsPerAccount"),
    },
    policy,
    // 冲刺阈值允许 0（= 关闭冲刺）；冲刺间隔钉 1s 地板：它直接对着上游轮询，
    // 更小的值就是限流自讨（纪律恰是不打满限流窗口）。
    sprintWindowMs: resolveNonNegativeInt(obj.sprintWindowMs ?? obj.sprint_window_ms, DEFAULTS.CLAIM_SPRINT_WINDOW_MS, "claim.sprintWindowMs"),
    sprintPollIntervalMs: Math.max(1_000, resolvePositiveInt(obj.sprintPollIntervalMs ?? obj.sprint_poll_interval_ms, DEFAULTS.CLAIM_SPRINT_POLL_INTERVAL_MS, "claim.sprintPollIntervalMs")),
  };
}

function validate(config: ProxyConfig): void {
  // port 0 是合法值：bind 时由内核分配（server.ts 读回 server.address().port），
  // 测试与临时实例用它避开「探测端口在 close 后被抢」的竞态。
  // 示例配置（config.example.yaml / template.ts）不写 0：人手写的配置应该是
  // 确定端口，0 是测试与脚本的表达。
  if (config.server.port < 0 || config.server.port > 65535) {
    throw new Error(`server.port ${config.server.port} is out of range (0-65535, 0 = let the kernel pick)`);
  }

  if (!config.models.includes(config.defaultModel)) {
    // defaultModel not in the models list — add it automatically
    config.models.push(config.defaultModel);
  }
}
