/**
 * Wiring between the claim subsystem and the rest of the proxy: builds one
 * scheduler **per account** from a loaded `ProxyConfig` + `AccountManager`
 * (serve path) and implements the one-shot CLI flow
 * (`zcode-proxy claim [list|now]`).
 */
import type { AccountManager } from "../accounts/manager.js";
import { toAuthCredential } from "../accounts/manager.js";
import { accountSupportsSurface } from "../accounts/capability.js";
import { accountDeviceMid } from "../accounts/device-mid.js";
import type { Account } from "../accounts/types.js";
import type { Broker } from "../accounts/broker.js";
import type { ProxyConfig } from "../config/types.js";
import type { ClaimablePlan, ClaimDiscovery, ClaimOutcome } from "./types.js";
import type { Credential } from "../auth/types.js";
import { credentialString } from "../auth/types.js";
import { createClaimClient, ClaimPreviewError } from "./client.js";
import { reportActivation } from "./activation.js";
import { upstreamUserIdOf } from "../auth/import.js";
import { activityLedger } from "./ledger.js";
import { resolveEgressFor } from "../accounts/proxies.js";
import type { EgressOptions } from "../proxy/egress.js";
// claim 出线的账号级观测（账号级观测点：额度终态码 / 限流对账号健康的反馈）。
import { observeClaimUpstream } from "../proxy/upstream-error.js";
import { ClaimScheduler, type ClaimSchedulerStatus } from "./scheduler.js";
import { createClaimRateLimitWindow, rateLimitEgressKey, type ClaimRateLimitWindow } from "./rate-limit.js";
import { getCaptchaToken } from "../captcha/captcha.js";
import { getDefaultEndpointRouting, requiresClaimCaptcha } from "../proxy/endpoint-routing.js";
import { logger } from "../log/index.js";

/**
 * 领取子系统的日志。
 *
 * 后台循环（每个账号一个 scheduler）与一次性 CLI 是两件事：循环的每一拍都是运行时
 * 事件，走 logger；`runClaimCli` 的输出是命令结果，留在 `console.log`
 * （用户主动跑一条命令、期望看到结果，那是输出不是日志）。
 */
const log = logger("claim");

/** `${process.platform}-${process.arch}` — mirrors the client's `TH()`. */
function claimPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * 这次领取要不要验证码。
 *
 * `egress` 是**该账号的出口**：这个判定要拉 zcode 的 agent-configs，那是
 * 一次上游请求。不传的话它会从本机 IP 出去，而紧接着的领取请求走代理 —— 同一个账号
 * 的两件事走了两条线，风控视角下是异常。
 */
function claimCaptchaRequired(
  config: ProxyConfig,
  resolveCredential: () => Promise<Credential | null>,
  egress: EgressOptions | undefined,
): Promise<boolean> {
  const routing = getDefaultEndpointRouting(config);
  if (!routing) return Promise.resolve(true);
  return resolveCredential()
    .then((cred) => routing.getRequestVerificationConfig(cred ? credentialString(cred) : undefined, egress))
    .then((cfg) => requiresClaimCaptcha(cfg))
    .catch(() => true);
}

/**
 * 一个账号的领取连线（client 造法 + captcha 门 + token 池），自动调度与手动领取
 * （`claimNow`）共用 —— 同一 client、同一 captcha 池、同一出口，两条路在
 * 上游看到的是同一个身份。
 *
 * `deps` 是注入点（测试不碰网络：替 `fetchImpl` / 直接给 captcha 的两个门）。
 */
export interface ClaimActionDeps {
  /** DI seam (`createClaimClient` 的同名参数）。*/
  fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** captcha 门替身。缺省用真实的 agent-configs 判定（`claimCaptchaRequired`）。*/
  captchaRequired?: () => Promise<boolean> | boolean;
  /** captcha token 池替身。缺省用该账号自己的池（`getCaptchaToken`）。*/
  getCaptcha?: () => Promise<{ verifyParam: string; region?: string }>;
  /** 激活上报替身，测试不碰网络；失败只返回可读原因。 */
  reportActivationImpl?: typeof reportActivation;
  /** 同出口账号的稳定序号；开抢窗口按它排毫秒级相位。 */
  accountIndex?: number;
  /** broker（观测落点 + 健康闸）。给了就把 claim 出线接进统一观测链路
   * （`observeClaimUpstream`）；不给 = 纯 CLI 用法，不观测。
   */
  broker?: Broker;
}

/**
 * claim 选号跳过 `drained` / `auth-invalid` 账号（读 health 表）。
 *
 * 账号级聚合：配置的任一路由处于这两种状态就跳过——claim 是机会主义动作，宁可
 * 少领一轮也不为一个健康存疑的账号发请求（状态可能由数据面的终态码/认证信号落下，
 * 也可能由 claim 自己的出线观测落下，来源无关，闸门只看健康表）。
 */
export function accountHealthBlocked(broker: Pick<Broker, "health">, account: Account): boolean {
  for (const route of account.routes) {
    const status = broker.health.status(account.id, route).status;
    if (status === "drained" || status === "auth-invalid") return true;
  }
  return false;
}

/**
 * 一个账号的激活上报。资格事件在探测之前发，失败只是日志里的可读原因。
 * `userId` 取账号自己的上游标识，`deviceMid` 取该账号的指纹，出线口与
 * 该账号的领取请求一致；三个值都不从别的账号借。
 */
export function accountActivationReport(
  config: ProxyConfig,
  account: Account,
  report: typeof reportActivation = reportActivation,
): Promise<{ ok: boolean; reason?: string }> {
  const cred = toAuthCredential(account.credential);
  const userId = account.credential.upstreamUserId ?? upstreamUserIdOf(cred.jwt ?? cred.oauthAccessToken ?? "") ?? "";
  return report({
    origin: config.claim.origin,
    userId,
    deviceMid: accountDeviceMid(account) ?? "",
    appVersion: config.identity.appVersion,
    egress: egressForAccount(config, account),
  }).then((result) => result.ok ? { ok: true } : { ok: false, reason: result.reason });
}
/** 手动/单发领取的两件事：两面合并的枚举 + 一次领取（含 captcha 门）。*/
export interface ClaimActions {
  discoverActivities(): Promise<ClaimDiscovery>;
  claim(planId: string): Promise<ClaimOutcome>;
}

/**
 * 为一个账号造一套一次性领取动作。
 *
 * 与 {@link createClaimRuntime} 同源（同一份连线），但不启动循环：面板的
 * `previewClaimPlans` / `claimNow` 每次调用造一套，用完即弃 —— 无状态，不需要
 * 与调度器共享实例（hold 联动走 `noteOutcome`）。
 */
export function buildClaimActions(config: ProxyConfig, account: Account, deps: ClaimActionDeps = {}): ClaimActions {
  const cred = toAuthCredential(account.credential);
  const deviceMid = accountDeviceMid(account) ?? undefined;
  const egress = egressForAccount(config, account);
  const client = createClaimClient({
    origin: config.claim.origin,
    jwt: cred.jwt,
    appVersion: config.identity.appVersion,
    platform: claimPlatform(),
    deviceMid,
    marketingDeviceMid: deviceMid,
    egress,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    // claim 出线 → 统一观测点的账号级半边（额度终态码/限流码 → 账号健康）。
    ...(deps.broker ? { onUpstreamResp: (resp: Response) => observeClaimUpstream(deps.broker!, account, resp) } : {}),
  });
  return {
    discoverActivities: () => client.discoverActivities(),
    async claim(planId: string): Promise<ClaimOutcome> {
      let captchaRequired = true;
      if (deps.captchaRequired) {
        captchaRequired = await deps.captchaRequired();
      } else {
        try {
          captchaRequired = await claimCaptchaRequired(config, async () => cred, egress);
        } catch {
          captchaRequired = true;
        }
      }
      let captcha: { verifyParam: string; region?: string } | undefined;
      if (captchaRequired) {
        captcha = deps.getCaptcha
          ? await deps.getCaptcha()
          : await (async () => {
              const token = await getCaptchaToken(config.identity.appVersion, account.id);
              if (!token) throw new Error("captcha config flipped to disabled between gate and mint");
              return { verifyParam: token.verifyParam, region: token.region || undefined };
            })();
      }
      return client.claim(planId, captcha);
    },
  };
}

/**
 * 一个账号的自动领取运行时（等价的 surface 是 `claim`）。
 *
 * 领取用的是账号自己的 JWT 与身份指纹，所以运行时按账号建：每个具备 claim 能力
 * 的账号各起一个循环，互不干扰。批量自动领号是风控高危行为，运行时在面板
 * 概览页按「有多少个账号在自动领取」提示，不是一个可以关掉的开关。
 *
 * `rateLimit` 是该账号所在出口的共享限流窗口（`startAutoClaim` 按出口分组
 * 后传入）：同出口的账号一人撞 429 全组推迟。缺省 = 不联动（CLI 单发路径）。
 */
export function createClaimRuntime(
  config: ProxyConfig,
  account: Account,
  rateLimit?: ClaimRateLimitWindow,
  broker?: Broker,
  deps: ClaimActionDeps = {},
): ClaimScheduler {
  const cred = toAuthCredential(account.credential);
  // 一账号一指纹：领取用的是**账号自己的** JWT 与设备指纹，没有全局
  // 兜底，那会让 N 个账号在网关侧是同一台机器。`api-key` 凭据没有身份面，
  // 此时不发 X-Device-Mid（它本来也领不了：claim 需要 plan JWT）。
  const deviceMid = accountDeviceMid(account) ?? undefined;
  // 出口代理：领取是账号级动作，必须从这个账号的出口出去。
  // 长寿命限制：实例在创建时固定代理，运行时改配置要重建（同 `resolveEgress` 注释）。
  const egress = egressForAccount(config, account);
  return new ClaimScheduler({
    accountId: account.id,
    accountIndex: deps.accountIndex,
    rateLimit,
    ledger: activityLedger,
    reportActivation: () => accountActivationReport(config, account, deps.reportActivationImpl),
    getJwt: async () => cred.jwt,
    preflight: async () => {
      await claimCaptchaRequired(config, async () => cred, egress);
      if (broker && accountHealthBlocked(broker, account)) {
        throw new Error("account health gate is closed");
      }
    },
    createClient: (jwt) =>
      createClaimClient({
        origin: config.claim.origin,
        jwt,
        appVersion: config.identity.appVersion,
        platform: claimPlatform(),
        deviceMid,
        marketingDeviceMid: deviceMid,
        egress,
        // claim 出线 → 统一观测点的账号级半边（同 buildClaimActions）。
        ...(broker ? { onUpstreamResp: (resp: Response) => observeClaimUpstream(broker, account, resp) } : {}),
      }),
    // claim 选号跳过 drained / auth-invalid 账号（读 health 表）。
    ...(broker ? { accountBlocked: () => accountHealthBlocked(broker, account) } : {}),
    getCaptcha: async () => {
      // token 从该账号自己的池里取：领取是一次账号级动作，用别的账号的
      // 池就是把两个账号的验证码频率叠成一条机器特征。
      const token = await getCaptchaToken(config.identity.appVersion, account.id);
      if (!token) throw new Error("captcha config flipped to disabled between gate and mint");
      return { verifyParam: token.verifyParam, region: token.region || undefined };
    },
    captchaRequired: () => claimCaptchaRequired(config, async () => cred, egress),
    config: {
      pollIntervalMs: config.claim.pollIntervalMs,
      cooldownMs: config.claim.cooldownMs,
      sprintWindowMs: config.claim.sprintWindowMs,
      sprintPollIntervalMs: config.claim.sprintPollIntervalMs,
      ...(config.claim.opening ? { opening: config.claim.opening } : {}),
    },
    // 把 scheduler 的级别带过来——`debug` 的那几条（「没有可领的计划」）
    // 默认级别下连缓冲区都不进，日志页才不会被 claim tick 浸没。
    log: (message, level, fields) =>
      level === "debug"
        ? log.debug("claim tick", { account: account.label, message, ...fields })
        : log.info("claim tick", { account: account.label, message, ...fields }),
  });
}

/**
 * 自动领取只需「起」和「停」两件事（`ClaimScheduler` 满足它）。
 *
 * 抽成接口是为了让 `startAutoClaim` 的账号选择 / 失败隔离能被单测覆盖，而不必真的
 * 启定时器去打上游（每个 scheduler 一起就会立即轮一次 preview）。
 *
 * `status` / `noteOutcome` 是可选的观察面：`getClaimOverview` 读状态、
 * `claimNow` 回灌手动结果。注入的假 scheduler 不实现它们时，控制面按「没有状态」
 * 与「不联动」降级 —— 接口保持最小，测试替身不用跟着长。
 */
export interface ClaimRuntimeHandle {
  start(): void;
  stop(): void;
  /** 运行时状态快照（`getClaimOverview` 控制命令按账号读它）。*/
  status?: () => ClaimSchedulerStatus;
  /**
   * 领取结果回灌：落 per-plan hold + 最近结果，联动 `holdUntil`（下一拍
   * `computeNextWake` 重算）。手动领取经它把结果交给自动循环。
   */
  noteOutcome?: (outcome: ClaimOutcome, target?: { plan?: ClaimablePlan; endsAt?: number }) => void;
}

/** 一个账号的领取运行时条目（账号 label 用于日志与面板区分是谁在领）。*/
export interface ClaimRuntimeEntry {
  readonly accountId: string;
  readonly label: string;
  readonly scheduler: ClaimRuntimeHandle;
}

/**
 * 自动领取的运行组（进程退出时 `stop()` 全部停掉）。
 *
 * 不直接返回单个 `ClaimScheduler`：多账号下每个账号一个 scheduler，而调用方
 * （`index.ts` 的 shutdown）只需要"全停"这个动作。
 */
export interface ClaimAutoClaim {
  readonly runtimes: readonly ClaimRuntimeEntry[];
  stop(): void;
}

/** `startAutoClaim` 的注入点（测试用：替掉真实 scheduler，避开网络与定时器）。*/
export interface ClaimRuntimeDeps {
  createRuntime?: (
    config: ProxyConfig,
    account: Account,
    rateLimit?: ClaimRateLimitWindow,
    broker?: Broker,
    deps?: ClaimActionDeps,
  ) => ClaimRuntimeHandle;
  log?: (message: string) => void;
  /**
   * broker（统一观测点的落点 + 健康闸）。serve 路径必传（bootstrap 把
   * `createBroker` 的实例递进来）；测试不传 = 不观测、不设闸。
   */
  broker?: Broker;
}

/**
 * 选出要起自动领取的账号。
 *
 * 全部 `enabled` 且凭据具备 claim 能力（plan JWT）的账号，每个账号
 * 一个 scheduler。没有「默认账号」可以只给它起循环：账号表为空时结果为空，调用方
 * 返回 null。
 */
export function autoClaimAccounts(all: readonly Account[]): Account[] {
  return all.filter((account) => account.enabled && accountSupportsSurface(account, "claim"));
}

/**
 * 启动自动领取。没有可领的账号时返回 null（调用方只记一行日志）。
 *
 * 多账号：每个账号一个 scheduler，各自独立 cooldown，领取结果落回各自账号
 * （`createClaimRuntime` 用的是账号自己的 JWT 与 deviceMid）。单个账号起不来
 * 不影响其他账号，但会打一行日志，静默少一个账号的领取循环比失败更难查。
 *
 * 限流联动：共享限流窗口按**出口**分组（上游按 IP 限流，不同代理的限流域
 * 互不相干；直连账号共享本机 IP 归同一窗口）。首拍错峰相位在各 scheduler 内部
 * 按 accountId 的 sha256 落位。
 */
export async function startAutoClaim(
  config: ProxyConfig,
  accounts: AccountManager,
  deps: ClaimRuntimeDeps = {},
): Promise<ClaimAutoClaim | null> {
  const targets = autoClaimAccounts(await accounts.list());
  if (targets.length === 0) return null;

  const create = deps.createRuntime ?? createClaimRuntime;
  const tick = deps.log ?? ((message: string): void => log.info("claim tick", { message }));
  const windows = new Map<string, ClaimRateLimitWindow>();
  const indices = new Map<string, number>();
  const runtimes: ClaimRuntimeEntry[] = [];
  for (const account of targets) {
    try {
      // 出口 → 窗口分组键（同键共享一个窗口）：代理 URL 即身份（凭据不进键）。
      const egressKey = rateLimitEgressKey(egressForAccount(config, account)?.proxyUrl);
      let window = windows.get(egressKey);
      if (!window) {
        window = createClaimRateLimitWindow();
        windows.set(egressKey, window);
      }
      const index = indices.get(egressKey) ?? 0;
      indices.set(egressKey, index + 1);
      const scheduler = create(config, account, window, deps.broker, { accountIndex: index });
      scheduler.start();
      runtimes.push({ accountId: account.id, label: account.label, scheduler });
    } catch (err) {
      tick(`account ${account.label}: auto-claim not started (${(err as Error).message})`);
    }
  }
  return {
    runtimes,
    stop(): void {
      for (const runtime of runtimes) runtime.scheduler.stop();
    },
  };
}

const FAILURE_LABELS: Record<string, string> = {
  not_found: "plan does not exist",
  unavailable: "campaign ended or not claimable yet",
  already_claimed: "already claimed on this account",
  ineligible: "account or client version not eligible (needs appVersion >= campaign minimum)",
  quota_exhausted: "daily claim quota exhausted",
  invalid_request: "invalid request",
  captcha: "captcha verification failed",
  login_required: "not logged in",
  http_error: "HTTP error",
  unknown: "unknown failure",
};

/** One-shot CLI: `list` prints previews; `now` claims the target plan. */
export async function runClaimCli(config: ProxyConfig, accounts: AccountManager, mode: "list" | "now"): Promise<void> {
  // 一次性 CLI 领取只针对一个账号：取第一个启用且带 plan JWT 的。要逐个账号领，
  // 后台循环已经按账号各起一个（`startAutoClaim`），CLI 不需要重复那套编排。
  const account = (await accounts.list()).find(
    (candidate) => candidate.enabled && candidate.credential.kind === "zhipu-account" && candidate.credential.jwt,
  );
  const cred = account ? toAuthCredential(account.credential) : null;
  const jwt = cred?.jwt;
  if (!account || !cred || !jwt) {
    console.error("Claim requires a logged-in account with a plan JWT. Run: zcode-proxy auth login <zai|bigmodel>");
    process.exit(1);
  }
  const deviceMid = accountDeviceMid(account) ?? undefined;
  const client = createClaimClient({
    origin: config.claim.origin,
    jwt,
    appVersion: config.identity.appVersion,
    platform: claimPlatform(),
    deviceMid,
    marketingDeviceMid: deviceMid,
    egress: egressForAccount(config, account),
  });

  let discovery: ClaimDiscovery;
  try {
    discovery = await client.discoverActivities();
  } catch (err) {
    if (err instanceof ClaimPreviewError && err.status === 404) {
      console.log("No claimable plans: the campaign endpoint is not deployed yet (404).");
      console.log("Weekend campaigns typically go live shortly before the window — keep the proxy");
      console.log("serving with claim.enabled, or re-run this command later.");
      return;
    }
    throw err;
  }
  const plans = discovery.activities;
  if (plans.length === 0) {
    console.log("No claimable plans right now.");
    return;
  }
  printPlans(plans);

  if (mode === "list") return;

  const target = [...plans].sort((a, b) => b.priority - a.priority)[0];
  if (target.planId !== plans[0].planId) console.log(`Claiming configured plan: ${target.planId}`);

  const captchaRequired = await claimCaptchaRequired(config, async () => cred, egressForAccount(config, account));
  let captcha: { verifyParam: string; region?: string } | undefined;
  if (captchaRequired) {
    const token = await getCaptchaToken(config.identity.appVersion, account.id);
    if (!token) throw new Error("captcha config flipped to disabled between gate and mint");
    captcha = { verifyParam: token.verifyParam, region: token.region || undefined };
  }
  const outcome = await client.claim(target.planId, captcha);
  printOutcome(outcome);
  if (!outcome.ok) process.exit(1);
}

function printPlans(plans: ClaimablePlan[]): void {
  console.log(`Claimable plans (${plans.length}):`);
  for (const p of plans) {
    const window = [fmtTime(p.startsAt), fmtTime(p.endsAt)].filter(Boolean).join(" → ");
    const source = p.source === "banner" ? "  [banner]" : "";
    console.log(`  - ${p.planId}  "${p.name}"  priority=${p.priority}${window ? `  ${window}` : ""}${source}`);
    for (const e of p.entitlements) {
      const quota = e.grantUnits > 0 ? ` ${e.grantUnits} ${e.unitType}` : "";
      const activate = e.effectiveAt !== undefined ? ` (activates ${new Date(e.effectiveAt * 1000).toISOString()})` : "";
      console.log(`      · ${e.showName || e.entitlementId}${quota}${activate}`);
    }
  }
}

function printOutcome(outcome: ClaimOutcome): void {
  if (outcome.ok) {
    console.log(`\nClaimed: ${outcome.planId}`);
    if (outcome.startsAt !== undefined) console.log(`  activates: ${new Date(outcome.startsAt * 1000).toISOString()}`);
    if (outcome.endsAt !== undefined) console.log(`  expires:   ${new Date(outcome.endsAt * 1000).toISOString()}`);
    if (outcome.startsAt === undefined && outcome.endsAt === undefined) console.log("  active immediately");
    return;
  }
  const label = FAILURE_LABELS[outcome.failureKind] ?? FAILURE_LABELS.unknown;
  console.error(`\nClaim failed: ${label} (code ${String(outcome.code)}) — ${outcome.message}`);
  if (outcome.failureEndsAt !== undefined) {
    console.error(`  retry window opens: ${new Date(outcome.failureEndsAt * 1000).toISOString()}`);
  }
}

function fmtTime(sec: number | undefined): string {
  return sec === undefined ? "" : new Date(sec * 1000).toISOString();
}

/**
 * 某账号在 `config.accounts` 里的生效代理。
 *
 * 领取只有 `ProxyConfig` 与 `Account`，拿不到 broker，所以走纯函数
 * `resolveEgress`：优先级链与请求链路同源（`entries[].proxy` > `risk.defaultProxy`
 * > 直连），只是读不到运行时覆盖层（`setAccountProxy` 的结果要重建实例才生效）。
 */
function egressForAccount(config: ProxyConfig, account: Account): EgressOptions | undefined {
  return resolveEgressFor(config.accounts, account.label);
}
