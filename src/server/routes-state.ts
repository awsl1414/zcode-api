/**
 * `GET /api/state` 的载荷：面板概览页一次读齐的账号、路由、风控与并发数据。
 *
 * 这个模块只做**取数与拼装**，不重算任何业务：
 *
 *   /api/state → control dispatcher（`status` / `listAccounts` /
 *                `getRoutingPolicy` / `getRiskReport`）→ 一份 JSON
 *
 * 为什么走 dispatcher 而不是直接读 `AccountManager` + `Broker`：
 * `src/control/control.ts` 的命令表是**跨进程契约**，CLI、
 * CLI 与网页三个入口共用同一份 `dispatch`。绕过它另写一份「读账号、算健康、
 * 合成生效并发」的逻辑，等于把生效并发值的三方合成（`RuntimeOverride > entries >
 * 账号 policy`）实现第二遍：两份实现迟早对不上，账号表显示 2、调度器按 4 跑。
 * 所以这里只调命令，聚合/翻译/上色留给页面。
 *
 * 唯一属于本模块的状态是**并发曲线的历史采样**：`inflight` 是瞬时值，曲线需要
 * 时间序列，而现有控制面没有任何历史。采样点由每次 `/api/state` 读取时落一个，
 * 环形缓冲固定容量（页面按 5s 轮询，60 个点即最近 5 分钟），不额外开定时器，
 * 没人看页面时不采样，也就不存在「后台空转」。
 */
import type {
  AccountSummary,
  ClaimAccountStatus,
  ClaimConfigSummary,
  ClaimOverviewPayload,
  ControlCommand,
  ControlResponse,
  RiskAlert,
  RiskPolicy,
  RiskReport,
} from "../control/control.js";
import type { HealthObservation } from "../accounts/health-observation.js";
import type { AccountsRouting, AccountsStickiness } from "../accounts/routing.js";
import type { ProviderId } from "../provider/types.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { defaultCredentialsPath, parseZcodeCredentialsFile } from "../auth/import.js";
import { LEGACY_CONFIG_PATHS, loadConfigQuiet } from "../config/loader.js";
import { classifyReload, configEqual, reloadConfig } from "../config/reload.js";
import type { DumpConfig, ProxyConfig, ReasoningMode, ReasoningEffortChoice } from "../config/types.js";
import { REASONING_MODES, REASONING_EFFORTS } from "../config/types.js";
import { shutdownAllHighspeed } from "../highspeed/slots.js";
import { isValidAppVersion } from "../identity/app-version.js";
import { logger } from "../log/index.js";
import { setDumpConfig } from "../proxy/dump.js";
import pkg from "../../package.json" with { type: "json" };

/**
 * 配置写路径的日志。挂 `config` 而不是 `panel`：这里说的都是 config.yaml 的事，
 * 与 `config/loader.ts` 的告警同一个说话人，用户在日志里看到的是同一段叙事。
 */
const log = logger("config");

/**
 * 并发曲线的采样容量。
 *
 * 60 不是随便取的：页面轮询间隔是 5s（`app.js` 的 `POLL_INTERVAL_MS`），
 * 60 × 5s = 5 分钟，正好是「看最近几分钟有没有堆积」这个问题的量级。
 */
export const INFLIGHT_HISTORY_CAPACITY = 60;

/** 一个并发采样点。`at` 是毫秒时间戳（与 `Date.now()` 同源）。*/
export interface StateSample {
  at: number;
  inflight: number;
}

/**
 * `server` 段：进程与代理的运行态（面板概览页顶部的「状态条」）。
 *
 * 没有 `running`：`serve` 形态下面板挂在代理的监听上，能读到这份载荷就说明代理在
 * 跑，那个布尔值永远是同一个：能看到这页就说明网关在跑。状态条上的圆点回答的是别的问句——有没有
 * 风控告警，见 `risk.alerts`。
 */
export interface StateServer {
  /** 代理监听端口。*/
  port: number;
  version: string;
  /** 进程已运行秒数（页面自己格式化成 h/m/s）。*/
  uptime: number;
}

/** `metrics` 段：全局并发与曲线（面板概览页的「并发曲线」）。*/
export interface StateMetrics {
  inflight: number;
  concurrencyLimit: number;
  queueDepth: number;
  sampledAt: number;
  inflightHistory: StateSample[];
}

/**
 * `/api/state` 的完整载荷。字段顺序与控制面契约一致：
 * `server` / `accounts` / `routing` / `stickiness` / `risk` / `metrics`，
 * 末尾是可选的 `claim` 段（抢活动控制面接了才有）。
 */
export interface StatePayload {
  server: StateServer;
  accounts: AccountSummary[];
  routing: AccountsRouting;
  stickiness: AccountsStickiness;
  /**
   * `risk.alerts` 是**算出来的告警**（从调度器与采样器现算）；`risk.policy` 是
   * **配置里的开关**（`accounts.risk` 段）。两者同名不同物，放在一个段里是因为页面的「风控」区块
   * 同时显示它们，而接口只多了一个字段（后端契约向后兼容）。
   */
  risk: { alerts: RiskAlert[]; policy: RiskPolicy };
  metrics: StateMetrics;
  /**
   * 调度/健康观测：健康状态变化事件 + 路由熔断指示 + 退避档位。
   * 控制面没接 broker 的宿主（一次性 CLI 的纯本地 reader）整段缺席，页面隐藏区块。
   */
  health?: HealthObservation;
  /**
   * 抢活动的状态段（可选）：`getClaimOverview` 答得上来才带。宿主没接
   * claim 钩子（CLI 的一次性 dispatcher、旧测试桩）时整段缺席，页面对应的
   * 区块隐藏 —— 缺席是「没接」，不是「没有活动」。
   */
  claim?: ClaimOverviewPayload;
}

/** 读取结果：要么整份状态，要么一个稳定错误码（页面按码翻译成一句话）。*/
export type StateResult = { ok: true; state: StatePayload } | { ok: false; error: string };

/** 与 `panel.ts` 的 `ControlDispatcher` 同形；此处独立声明避免循环导入。*/
export type StateDispatcher = (cmd: ControlCommand) => Promise<ControlResponse>;

/**
 * `control.ts` 把「命令 → 应答变体」的对应关系放在未导出的 `ControlOk` 联合里。
 * 这里镜像**用得到的那几个变体**，只在类型层把 `ok: true` 的宽联合收窄到具体形状；
 * 不做运行时字段校验：协议保证的东西再查一遍就是不可达的兜底分支。
 */
type StatusReply = { ok: true; state: "running"; proxyPort: number };
type AccountsReply = { ok: true; event: "accounts"; accounts: AccountSummary[] };
type PolicyReply = {
  ok: true;
  event: "routingPolicy";
  routing: AccountsRouting;
  stickiness: AccountsStickiness;
  risk: RiskPolicy;
};
type RiskReply = { ok: true; event: "riskReport"; report: RiskReport };
type HealthReply = { ok: true; event: "healthObservation"; observation: HealthObservation };
type ClaimOverviewReply = { ok: true; event: "claimOverview"; config: ClaimConfigSummary; accounts: ClaimAccountStatus[] };

/**
 * 并发曲线的环形缓冲。
 *
 * 容量是构造参数而不是常量引用，测试要能用一个很小的容量验证「挤掉最旧的点」。
 */
export class InflightHistory {
  private readonly samples: StateSample[] = [];

  constructor(private readonly capacity: number = INFLIGHT_HISTORY_CAPACITY) {}

  /** 落一个采样点；超出容量时丢最旧的那个。*/
  record(at: number, inflight: number): void {
    this.samples.push({ at, inflight });
    while (this.samples.length > this.capacity) this.samples.shift();
  }

  /**
   * 快照：逐条拷贝，调用方拿到的是只读视图，改它不会影响缓冲，也不会让上一份
   * 已经发出去的 JSON 在序列化前被改掉。
   */
  snapshot(): StateSample[] {
    return this.samples.map((sample) => ({ at: sample.at, inflight: sample.inflight }));
  }
}

export interface StateReaderOptions {
  /** 版本号；默认取 `package.json`（与 CLI / 发布包同一处真源）。*/
  version?: string;
  /** 时钟注入点（测试用固定时间，生产用 `Date.now`）。*/
  now?: () => number;
  /** 曲线缓冲注入点（测试用小容量）。*/
  history?: InflightHistory;
}

/** `GET /api/state` 的取数器；一个面板实例一个（曲线要跨请求累积）。*/
export interface StateReader {
  read(): Promise<StateResult>;
}

/**
 * 构造取数器。
 *
 * 一次 `read()` 打四个只读命令，任何一个失败就把**那个命令的错误码**原样返回
 * （`account_control_unavailable` / `routing_control_unavailable` …），由页面显示。
 * 不吞错、不返回半份状态：概览页把「账号为空」和「账号读不到」显示成同一件事的话，
 * 用户会以为账号被删了。
 */
export function createStateReader(handleControl: StateDispatcher, options: StateReaderOptions = {}): StateReader {
  const version = options.version ?? pkg.version;
  const now = options.now ?? Date.now;
  const history = options.history ?? new InflightHistory();

  return {
    async read(): Promise<StateResult> {
      const [statusRes, accountsRes, policyRes, riskRes, claimRes, healthRes] = await Promise.all([
        handleControl({ cmd: "status" }),
        handleControl({ cmd: "listAccounts" }),
        handleControl({ cmd: "getRoutingPolicy" }),
        handleControl({ cmd: "getRiskReport" }),
        // 纯内存读：scheduler 状态 + claim 配置快照，不碰上游。宿主没接
        // claim 钩子时它回 claim_unavailable —— 那不是这次读的失败，claim 段
        // 缺席即可，不能让整份状态跟着失败。
        handleControl({ cmd: "getClaimOverview" }).catch(() => null),
        // 健康状态变化/熔断也是纯内存读；命令表不认它的宿主（一次性 CLI）整段缺席。
        handleControl({ cmd: "getHealthObservation" }).catch(() => null),
      ]);

      if (!statusRes.ok) return { ok: false, error: statusRes.error };
      if (!accountsRes.ok) return { ok: false, error: accountsRes.error };
      if (!policyRes.ok) return { ok: false, error: policyRes.error };
      if (!riskRes.ok) return { ok: false, error: riskRes.error };

      const status = statusRes as StatusReply;
      const accounts = accountsRes as AccountsReply;
      const policy = policyRes as PolicyReply;
      const risk = riskRes as RiskReply;
      const claimReply = claimRes && claimRes.ok && "event" in claimRes ? (claimRes as ClaimOverviewReply) : null;
      const healthReply = healthRes && healthRes.ok && "event" in healthRes ? (healthRes as HealthReply) : null;
      const sampledAt = now();
      history.record(sampledAt, risk.report.inflight.total);

      return {
        ok: true,
        state: {
          server: {
            port: status.proxyPort,
            version,
            uptime: Math.round(process.uptime()),
          },
          accounts: accounts.accounts,
          routing: policy.routing,
          stickiness: policy.stickiness,
          risk: { alerts: risk.report.alerts, policy: policy.risk },
          metrics: {
            inflight: risk.report.inflight.total,
            concurrencyLimit: risk.report.inflight.limit,
            queueDepth: risk.report.inflight.queueDepth,
            sampledAt,
            inflightHistory: history.snapshot(),
          },
          ...(claimReply ? { claim: { config: claimReply.config, accounts: claimReply.accounts } } : {}),
          ...(healthReply ? { health: healthReply.observation } : {}),
        },
      };
    },
  };
}

/* ------------------------------------------------------------------------- */
/* 本机认证文件发现                                                          */
/* ------------------------------------------------------------------------- */

/**
 * 一条候选凭据文件的探测结果。
 *
 * 只回显**路径、平台、有效性**：凭据原文、掩码、指纹一律不出现在这里（响应里
 * 只回显掩码与指纹，不回显凭据原文；指纹已由 `listAccounts` 的 `idPrefix`
 * 承担，这里连指纹都不需要，列表只用来选路径）。
 */
export interface CredentialSource {
  /** 候选文件的绝对路径。*/
  path: string;
  /** 文件存在、可读、且能被 `auth/import.ts` 解析成一份凭据。*/
  valid: boolean;
  /** 文件里解析出的平台（解析成功时才有）。*/
  provider?: ProviderId;
  /** 探测失败的原因码（`file_unreadable` / `file_malformed`），失败时才有。*/
  error?: string;
}

/**
 * 候选路径（按平台惯例列出，按顺序去重）。
 *
 * 顺序有意义：`ZCODE_DATA_BASE_DIR` 是显式覆盖，排最前；`~/.zcode/v2` 是 ZCode 4.x
 * 的现有默认；其后是各平台的历史/备用位置。用户手动指定 `--file` 或页面里填路径时
 * 不经过这里。
 */
export function credentialSourceCandidates(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const override = (env.ZCODE_DATA_BASE_DIR ?? "").trim();
  const candidates = [
    override ? join(override, "credentials.json") : "",
    defaultCredentialsPath(),
    join(home, ".zcode", "credentials.json"),
    join(home, "Library", "Application Support", "ZCode", "credentials.json"),
    join(home, "Library", "Application Support", "zcode", "credentials.json"),
    join(home, ".config", "ZCode", "credentials.json"),
    join(home, ".config", "zcode", "credentials.json"),
  ];
  /* Windows 的 `%APPDATA%` 只在设了变量时才有意义；没设就不列这一档。*/
  const appData = (env.APPDATA ?? "").trim();
  if (appData) {
    candidates.push(join(appData, "ZCode", "credentials.json"));
    candidates.push(join(appData, "zcode", "credentials.json"));
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of candidates) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
  }
  return unique;
}

/**
 * 探测一份候选文件：存在 → 可读 → 能解析出凭据。
 *
 * **只读**：`readFileSync` 不写、不改、不移动源文件；解析失败只记错误码，不记录
 * 文件内容（日志只记路径与错误码，凭据原文不进日志）。
 */
export function probeCredentialSource(path: string): CredentialSource {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    /* 文件不存在 / 无权限：两种情况对用户是同一件事（这个候选不可用）*/
    return { path, valid: false, error: "file_unreadable" };
  }
  try {
    const parsed = parseZcodeCredentialsFile(text, { source: path });
    if (parsed.provider) return { path, valid: true, provider: parsed.provider };
    return { path, valid: true };
  } catch {
    return { path, valid: false, error: "file_malformed" };
  }
}

/**
 * 扫描全部候选路径。
 *
 * 只在页面打开「添加账号 · 本机文件」时调用，搜索结果不缓存。同步 IO 是
 * 有意的：这是本地小文件（几十 KB）且只在一次点击里发生，异步化只会让调用方多一层
 * 状态；与 `auth/import.ts` 的 `readFileSync` 同一口径。
 */
export function scanCredentialSources(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): CredentialSource[] {
  return credentialSourceCandidates(env, home).map(probeCredentialSource);
}

/* ------------------------------------------------------------------------- */
/* 设置面：配置文件的读与写                                                   */
/* ------------------------------------------------------------------------- */

/**
 * 设置页绑定的是**配置文件**（`config.yaml`），同时负责把写好的配置灌回进程内存
 * （即配置热重载）。
 *
 * 为什么写文件：配置的唯一真源是 YAML（网页、CLI、YAML 三个入口改的都是它，而
 * `server` / `auth` / `providers` / `identity` / `clientIdentity` 与子系统
 * 开关全部归设置页）。写文件是「改了就在那里」：CLI、下次启动、别的入口都读它。
 *
 * 写完之后不再止步于文件：调用方经 {@link SettingsWriteOptions.activeConfig}
 * 把进程里生效的那份 `ProxyConfig`（`bootstrap.ts` 持有的启动快照）传进来，本模块
 * 重新加载、逐段比对、就地替换。代价按字段区分（按热重载成本分三类）：A 类（子系统开关、
 * 会话参数）下一次读取自然生效；B 类（identity / endpointRouting / clientSigning /
 * highspeed 的单例段）生效之外要停掉持有定时器的 highspeed 卡槽表；C 类（端口 /
 * 绑定地址）不热生效，响应里带 `restartRequired` 让页面明说。
 *
 * 本模块只做四件事：把补丁校验成合法值（严格校验，不静默兜底）、写回 YAML
 * （保住注释）、整份重读验证、按变化清单热重载并分类回报。校验不过就不落盘。
 */

/** 配置路径的环境变量（与 `src/server/bootstrap.ts` 的 serve 入口同一个）。*/
export const SETTINGS_CONFIG_ENV = "ZCODE_PROXY_CONFIG";
/** 没有覆盖时的配置路径（相对当前工作目录，与 serve 一致）。*/
export const DEFAULT_CONFIG_PATH = "config.yaml";

/**
 * 回环绑定的三种写法。
 *
 * 与 `panel.ts` 的 `isLoopbackHost` 同源同值：那边回答"面板自己绑定在哪"，这里回答
 * "这次改动会不会把控制面暴露到网络"（改到非回环要二次确认）。两个问题同一个判断，
 * 所以谓词只有一份实现（{@link isLoopbackBindHost}），`panel.ts` 复用它。
 */
const LOOPBACK_BIND_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "::1"];

/** 这个绑定地址是否只对本机可见。*/
export function isLoopbackBindHost(host: string): boolean {
  return LOOPBACK_BIND_HOSTS.includes(host);
}

/**
 * 身份归一开关的环境变量。
 *
 * 名字与 `src/proxy/system-prompt.ts` 的 `NORMALIZE_CLIENT_SYSTEM_ENV` 逐字一致，
 * 那边是**当前唯一**的消费者（这个开关只按环境变量实现）。设置页只能如实显示它的
 * 生效值；把开关接进配置面需要改 `config/loader.ts` 与 `proxy/system-prompt.ts`，
 * 不在本模块的边界内。
 */
export const NORMALIZE_CLIENT_SYSTEM_ENV = "ZCODE_NORMALIZE_CLIENT_SYSTEM";

/** 环境变量里表示"关闭"的取值（与 `proxy/system-prompt.ts` 同一组）。*/
const NORMALIZE_OFF_VALUES = new Set(["0", "false", "no"]);

/** 身份归一的**生效值**（未设置 = 开）。*/
function normalizeClientSystemEffective(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[NORMALIZE_CLIENT_SYSTEM_ENV];
  if (raw === undefined) return true;
  return !NORMALIZE_OFF_VALUES.has(raw.trim().toLowerCase());
}

/** `clientIdentity.mode` 的三个取值（与 `config/types.ts` 的联合类型同源）。*/
export const CLIENT_IDENTITY_MODES = ["off", "observe", "enforce"] as const;
export type ClientIdentityMode = (typeof CLIENT_IDENTITY_MODES)[number];

/** 连接组（设置页的「连接」）。*/
export interface SettingsConnection {
  /** 客户端没给 `model` 时用的默认模型。*/
  defaultModel: string;
  /** 会话亲和模式（`clientIdentity.mode`）。*/
  mode: ClientIdentityMode;
  ttlSeconds: number;
  maxSessions: number;
  /**
   * 推理强度（`reasoning` 段）：透传 = 客户端说了算；覆盖 = 按档位改写。
   * `effort` 在透传下仅存不参与逻辑（页面禁用档位控件但保留已选值）。
   */
  reasoningMode: ReasoningMode;
  reasoningEffort: ReasoningEffortChoice;
}

/** 身份组（设置页的「身份」）。*/
export interface SettingsIdentity {
  /** 身份归一的生效值（`identity.normalizeClientSystem`，当前由环境变量控制）。*/
  normalizeClientSystem: boolean;
  /** 生效的客户端版本号（优先级：手动 > 探测 > 默认）。*/
  appVersion: string;
  /** 这个值是哪来的，页面据此选一句来源说明。*/
  appVersionSource: "manual" | "detected" | "default";
  /** 探测到时给出路径，让用户核对读的是哪个客户端。*/
  appVersionSourcePath?: string;
}

/** 子系统组（设置页的「子系统」）。*/
export interface SettingsSubsystems {
  highspeed: boolean;
  mcp: boolean;
  async: boolean;
  claim: boolean;
  /**
   * 请求上下文记录（`logging.dump.enabled`）：把每个请求的完整上下文
   * （含请求/响应体）写进调试文件。默认关；开启写明风险文案。
   */
  dumpEnabled: boolean;
  /** dump 文件路径（`logging.dump.path`）。空串 = 存储目录下的默认文件。*/
  dumpPath: string;
  /** 额度轮询周期（秒，`accounts.quota.pollSeconds`）。*/
  quotaPollSeconds: number;
  /** drained 判定阈值（`accounts.quota.drainThreshold`，1 = 100%）。*/
  quotaDrainThreshold: number;
}

/** 安全组（设置页的「安全」）。*/
export interface SettingsSecurity {
  port: number;
  host: string;
  /**
   * 数据面要不要校验 API key（`auth.requireKey`）。
   *
   * key 本身不在这里：它们有名称、各自有启停与用量，全部住在 `apikeys.json`，
   * 由 `/keys` 页管理。这一项只是那个总开关，所以可以如实回显布尔值。
   */
  requireKey: boolean;
}

/**
 * 设置页的整份快照。
 *
 * 两处没有开关，是刻意的：
 *   - R1（一账号一 deviceMid）/ R2（session 隔离）不是配置项，是代码不变量；
 *   - `identity.normalizeClientSystem` 目前没有配置文件消费者，只能如实显示生效值
 *     （见 {@link NORMALIZE_CLIENT_SYSTEM_ENV}）。
 *
 * `identity.appVersion` 有开关。它参与 `identityCacheKey`：热重载换掉
 * `identity` 段之后，下一次用到身份头的请求按新 key 重建单例（B 类：需要重建单例）；
 * highspeed 卡槽表属于同一类，一并停掉重建。
 */
export interface SettingsSnapshot {
  /** 这份快照读的是哪个文件（相对路径按当前工作目录解析）。*/
  configPath: string;
  /** 可选的模型 id（`defaultModel` 下拉用）。*/
  models: string[];
  connection: SettingsConnection;
  identity: SettingsIdentity;
  subsystems: SettingsSubsystems;
  security: SettingsSecurity;
}

/**
 * 一次设置写入的补丁。每段可选：没给的字段保持原值。
 *
 * 形状与页面上的分组一一对应（`connection` / `subsystems` / `security`），
 * 这样页面不用知道 YAML 的键名，服务端也不用解析"哪个控件对应哪个键"。
 */
export interface SettingsPatch {
  defaultModel?: string;
  connection?: {
    mode?: ClientIdentityMode;
    ttlSeconds?: number;
    maxSessions?: number;
    reasoningMode?: ReasoningMode;
    reasoningEffort?: ReasoningEffortChoice;
  };
  identity?: { appVersion?: string };
  subsystems?: {
    highspeed?: boolean;
    mcp?: boolean;
    async?: boolean;
    claim?: boolean;
    dumpEnabled?: boolean;
    dumpPath?: string;
    quotaPollSeconds?: number;
    quotaDrainThreshold?: number;
  };
  security?: { port?: number; host?: string; requireKey?: boolean };
}

/** 读结果：整份快照，或一个稳定错误码（页面按码翻译）。*/
export type SettingsResult = { ok: true; settings: SettingsSnapshot } | { ok: false; error: string };

/**
 * 写结果：写后的快照加上热重载的两个清单，或一个稳定错误码。
 *
 * `reloaded` 是本次已热生效的顶层键，`restartRequired` 是需要重启才生效的字段
 * （C 类：`server.port` / `server.host`，改监听要重启）。调用方没有传 {@link SettingsWriteOptions.activeConfig}
 * （测试、或宿主没接热重载）时两个清单都是空数组。
 */
export type SettingsWriteResult =
  | { ok: true; settings: SettingsSnapshot; reloaded: string[]; restartRequired: string[] }
  | {
      ok: false;
      error: string;
      /**
       * 配置已落盘、但内存没有收下（写盘后的 `loadConfig` 校验失败）。
       * 这个不一致要在页面上明说：文件里的新值要等用户修正后重启才生效。
       */
      fileWritten?: boolean;
    };

/**
 * 热重载收尾的注入点。缺省实现是生产路径：dump 快照走
 * `setDumpConfig`（进程内开关的显式入口），B 类收尾走 `shutdownAllHighspeed`。
 * 测试用 spy 断言「收尾真的发生了」而不碰进程级单例。
 */
export interface SettingsReloadHooks {
  /** dump 快照更新（缺省 `setDumpConfig`）。*/
  setDump?: (next: DumpConfig | null) => void;
  /** B 类收尾：停掉 highspeed 卡槽表（缺省 `shutdownAllHighspeed`）。*/
  stopHighspeed?: () => void;
  /**
   * 日志阈值（A 类热重载）。`serve debug` 启动时把阈值抬到 debug，保存设置时
   * 沿用这一档；其它启动形态按配置文件里的级别更新 logger。缺省不动 logger，
   * 测试与独立宿主仍然可以自己注入。
   */
  setLogLevel?: (level: ProxyConfig["logging"]["level"]) => void;
  /**
   * `accounts` 段热重载：把重新读出的运行时策略灌进 broker 与额度采样器。
   * 两者都在构造时复制了配置段，单靠原地替换 `activeConfig` 改不到它们。
   * 缺省不动运行时对象（测试、独立宿主）。
   */
  syncRuntimeAccounts?: (accounts: NonNullable<ProxyConfig["accounts"]>) => void;
  /**
   * B 类收尾：重启各账号的领取调度器。claim 段的热生效不是「下次请求读新值」
   * 就完事 —— scheduler 持有定时器与 per-plan hold，间隔变了旧循环不会
   * 自己停。缺省无动作：没接 claim 运行组的宿主（测试、非 serve 入口）不装这个钩子。
   */
  restartClaim?: () => void;
}

/**
 * 配置文件路径：注入值 > `ZCODE_PROXY_CONFIG` > `config.yaml`。
 *
 * 为什么要有注入值：`serve` 用位置参数启动（`zcode-proxy my.yaml`）时，进程读的
 * 是 `my.yaml`，而本函数只认环境变量的话，设置页会 503 `config_missing`，
 * 且保存会打到另一个文件。修法与 `activeConfig` 同一个注入模式：入口把自己实际
 * 解析出来的那条路径（`args.configPath ?? env ?? 默认`）显式传进来，面板与 serve
 * 从此不可能分叉。注入值排第一位不是新增优先级：它本身就是上游那条解析式的结果，
 * 再按 env 重算一遍反而会在「两者都设」时把面板领到 serve 没读的文件上。
 *
 * 不传（测试、独立宿主）时行为与以前完全一致：env 覆盖 → 默认值。
 */
export function settingsConfigPath(env: NodeJS.ProcessEnv = process.env, injected?: string): string {
  const resolved = (injected ?? "").trim();
  if (resolved) return resolved;
  const override = (env[SETTINGS_CONFIG_ENV] ?? "").trim();
  return override || DEFAULT_CONFIG_PATH;
}

/** 正整数（端口 / 秒数 / 会话上限这类）。*/
function isPositiveIntegerValue(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** 正实数（`drainThreshold` 这类比例）。*/
function isPositiveNumberValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * 校验补丁里的每个字段（枚举写错即报错，不静默兜底）。
 *
 * 返回错误码而不是抛异常：控制面把失败当协议的一部分（`{ok:false,error}`）。
 */
export function validateSettingsPatch(patch: SettingsPatch): string | null {
  if (patch.defaultModel !== undefined && (typeof patch.defaultModel !== "string" || patch.defaultModel.trim() === "")) {
    return "invalid_setting";
  }

  const connection = patch.connection;
  if (connection) {
    if (connection.mode !== undefined && !CLIENT_IDENTITY_MODES.includes(connection.mode)) return "invalid_setting";
    if (connection.ttlSeconds !== undefined && !isPositiveIntegerValue(connection.ttlSeconds)) return "invalid_setting";
    if (connection.maxSessions !== undefined && !isPositiveIntegerValue(connection.maxSessions)) return "invalid_setting";
    // 推理强度：两个枚举都对照真源清单校验（与 loadConfig 的 resolveEnum
    // 同口径——非法值就地拒绝，不静默兜底）。
    if (connection.reasoningMode !== undefined && !REASONING_MODES.includes(connection.reasoningMode)) {
      return "invalid_setting";
    }
    if (connection.reasoningEffort !== undefined && !REASONING_EFFORTS.includes(connection.reasoningEffort)) {
      return "invalid_setting";
    }
  }

  const subsystems = patch.subsystems;
  if (subsystems) {
    for (const key of ["highspeed", "mcp", "async", "claim", "dumpEnabled"] as const) {
      if (subsystems[key] !== undefined && typeof subsystems[key] !== "boolean") return "invalid_setting";
    }
    if (subsystems.dumpPath !== undefined && typeof subsystems.dumpPath !== "string") return "invalid_setting";
    if (subsystems.quotaPollSeconds !== undefined && !isPositiveIntegerValue(subsystems.quotaPollSeconds)) {
      return "invalid_setting";
    }
    if (subsystems.quotaDrainThreshold !== undefined && !isPositiveNumberValue(subsystems.quotaDrainThreshold)) {
      return "invalid_setting";
    }
  }

  const identity = patch.identity;
  if (identity) {
    /* 空串 = 退回自动探测，所以它是合法值；非空就必须是 x.y.z */
    if (identity.appVersion !== undefined) {
      if (typeof identity.appVersion !== "string") return "invalid_setting";
      const trimmed = identity.appVersion.trim();
      if (trimmed !== "" && !isValidAppVersion(trimmed)) return "invalid_setting";
    }
  }

  const security = patch.security;
  if (security) {
    if (security.port !== undefined && (!isPositiveIntegerValue(security.port) || security.port > 65535)) {
      return "invalid_setting";
    }
    if (security.host !== undefined && (typeof security.host !== "string" || security.host.trim() === "")) {
      return "invalid_setting";
    }
    if (security.requireKey !== undefined && typeof security.requireKey !== "boolean") return "invalid_setting";
  }

  return null;
}

/**
 * 这个补丁是否碰了需要二次确认的危险配置（L3）。
 *
 * 只有两条：把绑定地址改到非回环（控制面暴露到网络）、改数据面鉴权开关。
 * 端口是 L1，改了不需要确认。
 *
 * 鉴权开关只在**值真的变了**时才要确认：关掉它是安全降级，打开它是收紧，两者都
 * 值得一次显式点击；而「打开开关但表里没有 key」时实际仍是放行（表空即放行），
 * 页面要能解释这一点，所以文案里指明 key 在哪里建。
 */
export function settingsPatchNeedsConfirmation(patch: SettingsPatch, current?: SettingsSnapshot): boolean {
  const security = patch.security;
  if (!security) return false;
  if (security.host !== undefined) {
    const next = security.host.trim();
    const unchanged = current !== undefined && next === current.security.host;
    if (!unchanged && !isLoopbackBindHost(next)) return true;
  }
  if (security.requireKey !== undefined) {
    return current === undefined || security.requireKey !== current.security.requireKey;
  }
  return false;
}

/**
 * 把补丁写进 YAML 文档。
 *
 * 用 `parseDocument` 而不是"读成对象再 stringify"：用户在 `config.yaml` 里写下的
 * 注释与键顺序是**他们自己的文件**，一次设置把它重排成另一副样子是不可接受的
 * （与 `config/edit.ts::writePanelToken` 的"targeted edit"同一个立场）。
 */
function applySettingsPatch(doc: ReturnType<typeof parseDocument>, patch: SettingsPatch): void {
  if (patch.defaultModel !== undefined) doc.setIn(["defaultModel"], patch.defaultModel.trim());

  const identity = patch.identity;
  if (identity) {
    if (identity.appVersion !== undefined) {
      /* 写空串而不是删键：用户在 `config.yaml` 里看得见这一行是「自动」，
         而键被删掉之后没人能确认它是没配还是被清掉了 */
      doc.setIn(["identity", "appVersion"], identity.appVersion.trim());
    }
  }

  const connection = patch.connection;
  if (connection) {
    if (connection.mode !== undefined) doc.setIn(["clientIdentity", "mode"], connection.mode);
    if (connection.ttlSeconds !== undefined) doc.setIn(["clientIdentity", "ttlSeconds"], connection.ttlSeconds);
    if (connection.maxSessions !== undefined) doc.setIn(["clientIdentity", "maxSessions"], connection.maxSessions);
    if (connection.reasoningMode !== undefined) doc.setIn(["reasoning", "mode"], connection.reasoningMode);
    if (connection.reasoningEffort !== undefined) doc.setIn(["reasoning", "effort"], connection.reasoningEffort);
  }

  const subsystems = patch.subsystems;
  if (subsystems) {
    if (subsystems.highspeed !== undefined) doc.setIn(["highspeed", "enabled"], subsystems.highspeed);
    if (subsystems.mcp !== undefined) doc.setIn(["mcp", "enabled"], subsystems.mcp);
    if (subsystems.async !== undefined) doc.setIn(["async", "enabled"], subsystems.async);
    if (subsystems.claim !== undefined) doc.setIn(["claim", "enabled"], subsystems.claim);
    if (subsystems.dumpEnabled !== undefined) doc.setIn(["logging", "dump", "enabled"], subsystems.dumpEnabled);
    if (subsystems.dumpPath !== undefined) doc.setIn(["logging", "dump", "path"], subsystems.dumpPath.trim());
    if (subsystems.quotaPollSeconds !== undefined) {
      doc.setIn(["accounts", "quota", "pollSeconds"], subsystems.quotaPollSeconds);
    }
    if (subsystems.quotaDrainThreshold !== undefined) {
      doc.setIn(["accounts", "quota", "drainThreshold"], subsystems.quotaDrainThreshold);
    }
  }

  const security = patch.security;
  if (security) {
    if (security.port !== undefined) doc.setIn(["server", "port"], security.port);
    if (security.host !== undefined) doc.setIn(["server", "host"], security.host.trim());
    if (security.requireKey !== undefined) doc.setIn(["auth", "requireKey"], security.requireKey);
  }
}

/**
 * 写盘前把已从配置模型删除的残留键剔出文档（`LEGACY_CONFIG_PATHS` 清单同源）。
 *
 * 为什么只剔「已知清单里的键」而不趁写盘把一切未知键都清掉：未知键可能是
 * 「打错了字」，悄悄删掉等于把用户的输入吞了；而清单里的键是**已经从配置模型
 * 里删除**的，留着只有害处——每次读配置都告警（进程内每键只告一次），
 * 用户却还是得手改 YAML。写盘是用户主动操作的时机，顺手把垃圾收掉，之后
 * `writeSettings` 的重读（loadConfig）自然不再告警。
 *
 * 为什么不在读路径做：读配置绝不改用户文件（CLI / 启动读配置是纯读）；只有
 * 「用户在面板保存」这一条写路径有权动文件。
 *
 * 用 yaml 的 `deleteIn` 删叶子键：注释与兄弟键原样保留；被删键自己的行尾注释
 * 随键一起消失（那是它的一部分，留下来反而成了孤儿），独立的前置注释块按
 * yaml 的归属规则重挂到下一个兄弟上。不回退到字符串替换。
 * 返回被删的键路径（点串），空数组 = 文件里没有残留。
 */
function removeLegacyConfigPaths(doc: ReturnType<typeof parseDocument>): string[] {
  const removed: string[] = [];
  for (const path of LEGACY_CONFIG_PATHS) {
    if (doc.getIn(path) === undefined) continue;
    doc.deleteIn(path);
    removed.push(path.join("."));
  }
  return removed;
}

/** 把生效配置摊成页面要的形状。*/
function settingsSnapshotOf(config: ProxyConfig, path: string): SettingsSnapshot {
  /* `loadConfig` 总是补齐 `accounts`（见 `config/types.ts` 的字段注释），所以这里
     不需要"没配策略"的兜底分支。*/
  const accounts = config.accounts as NonNullable<ProxyConfig["accounts"]>;
  return {
    configPath: path,
    models: [...config.models],
    connection: {
      defaultModel: config.defaultModel,
      mode: config.clientIdentity.mode,
      ttlSeconds: config.clientIdentity.ttlSeconds,
      maxSessions: config.clientIdentity.maxSessions,
      /* `loadConfig` 总是补齐 `reasoning` 段，手写配置省略时这里也是真值。*/
      reasoningMode: config.reasoning?.mode ?? "passthrough",
      reasoningEffort: config.reasoning?.effort ?? "high",
    },
    identity: {
      normalizeClientSystem: normalizeClientSystemEffective(),
      appVersion: config.identity.appVersion,
      appVersionSource: config.identity.appVersionSource,
      /* `undefined` 在 JSON 里整键消失，页面只需要判有没有路径 */
      appVersionSourcePath: config.identity.appVersionSourcePath,
    },
    subsystems: {
      highspeed: config.highspeed.enabled,
      mcp: config.mcp.enabled,
      async: config.async.enabled,
      claim: config.claim.enabled,
      dumpEnabled: config.logging.dump?.enabled ?? false,
      dumpPath: config.logging.dump?.path ?? "",
      quotaPollSeconds: accounts.quota.pollSeconds,
      quotaDrainThreshold: accounts.quota.drainThreshold,
    },
    security: {
      port: config.server.port,
      host: config.server.host,
      requireKey: config.auth.requireKey,
    },
  };
}

/**
 * 读设置：整份 `config.yaml` 解析成配置，再摊成页面快照。
 *
 * 读的是**生效值**（`loadConfig` 会合并 `ZCODE_*` 环境变量），所以页面显示的是
 * "进程下次启动会用的值"；环境变量覆盖时，写 YAML 不会改变显示。这是事实，不是 bug
 * （页面用 `settings.envHint` 说明）。
 */
export function readSettings(path: string = settingsConfigPath()): SettingsResult {
  let config: ProxyConfig;
  try {
    config = loadConfigQuiet(path);
  } catch {
    /* 文件不存在 ≠ 文件写坏了：前者给用户"去建一个"的动作，后者给"去改一行"的动作 */
    return { ok: false, error: existsSync(path) ? "config_invalid" : "config_missing" };
  }
  return { ok: true, settings: settingsSnapshotOf(config, path) };
}

export interface SettingsWriteOptions {
  /** L3 变更的二次确认（页面在模态里点过"确认"才带 true）。*/
  confirm?: boolean;
  /** 配置文件路径（默认 {@link settingsConfigPath}）。*/
  path?: string;
  /**
   * 进程内生效的那份 `ProxyConfig`（`bootstrap.ts` 在 serve 里持有的启动快照）。
   * 给了它，写盘成功后就地热重载；不传（测试、或宿主没接）则只写文件，
   * 不碰任何运行时状态。从调用链显式传入，不用模块级单例：测试要能各自注入
   * 自己的那份。
   */
  activeConfig?: ProxyConfig;
  /** dump 快照与 B 类收尾的注入点；缺省用真实现（见 {@link SettingsReloadHooks}）。*/
  reloadHooks?: SettingsReloadHooks;
  /**
   * 写盘后的整份重读。缺省就是 `loadConfig(path)`；只给测试注入：补丁字段在写入前
   * 已全部校验过，公开路径上写盘后校验失败是防御分支（文件被并发改动这类竞态），
   * 唯一的触发方式就是替换这个函数。
   */
  reread?: (path: string) => ProxyConfig;
}

/**
  * B 类段：这些段热生效靠「下次使用时按新值重建」——`identity` 与
  * `endpointRouting` 的单例按 `identityCacheKey` 换新，`clientSigning` 每请求读开关。
  * 例外是 `highspeed`：卡槽表持有定时器与在飞的卡，`slotsKey` 变了旧循环不会自己停
  * （开关关掉时 `getDefaultHighspeedSlots` 直接回 null，连 key 都不比），所以 B 类
  * 有变化就显式停一次（保守做法），下一次合格请求按新配置重建。
  */
const B_CLASS_STOPS_HIGHSPEED: ReadonlySet<string> = new Set([
    "identity",
    "endpointRouting",
    "clientSigning",
    "highspeed",
]);

/**
  * 写设置：校验 → 写 YAML → 整份重读验证 → 热重载进程内配置并分类回报。
  *
  * 三个里程碑，各自的失败语义不同：
  *
  * - **写盘前**校验不过（补丁非法、文件缺失或已坏）：不落盘，返回错误码，内存与
  *   文件都保持原样。
  * - **写盘后**重读失败（`loadConfig` 拒绝整份配置）：文件已经落盘，内存不收。
  *   这个不一致是刻意的：YAML 是用户自己的文件，写坏了要用户去修，回滚等于把
  *   刚才的设置悄悄抹掉；而内存里那份启动快照至少让代理按已知行为继续跑。响应带
  *   `fileWritten: true`，页面提示「文件已写入但未生效，请检查后修正」。
  * - **重读成功**：就地替换 {@link SettingsWriteOptions.activeConfig}，
  *   dump 快照与 highspeed 卡槽表按变化清单收尾，`reloaded` / `restartRequired`
  *   分类回报。
  */
export function writeSettings(patch: SettingsPatch, options: SettingsWriteOptions = {}): SettingsWriteResult {
    const path = options.path ?? settingsConfigPath();

    const invalid = validateSettingsPatch(patch);
    if (invalid) return { ok: false, error: invalid };

    const current = readSettings(path);
    if (!current.ok) return { ok: false, error: current.error };

    if (options.confirm !== true && settingsPatchNeedsConfirmation(patch, current.settings)) {
        return { ok: false, error: "confirmation_required" };
    }

    const original = readFileSync(path, "utf8");
    const doc = parseDocument(original);
    if (doc.errors.length > 0) return { ok: false, error: "config_invalid" };

    applySettingsPatch(doc, patch);
    const removedLegacy = removeLegacyConfigPaths(doc);
    if (removedLegacy.length > 0) {
      /* 收尾叙事替代 WARN 循环：残留键删掉之后，重读与后续保存都不再提它们。 */
      log.info("removed legacy config keys while saving", { keys: removedLegacy });
    }
    writeFileSync(path, doc.toString(), "utf8");

    let next: ProxyConfig;
    try {
        next = (options.reread ?? loadConfigQuiet)(path);
    } catch {
        /* 文件已落盘、内存不收（见函数头的不一致说明）。旧值留在内存里是安全侧：
              代理继续按启动时的行为跑，新值等用户修正文件后重启再来。 */
        return { ok: false, error: "config_invalid", fileWritten: true };
    }

    if (options.activeConfig === undefined) {
        /* 宿主没接热重载（测试、独立调用）：只回写盘结果，不碰任何运行时状态。 */
        return { ok: true, settings: settingsSnapshotOf(next, path), reloaded: [], restartRequired: [] };
    }

    const activeConfig = options.activeConfig;
    const hooks = options.reloadHooks ?? {};
    /* dump 快照：进程内的开关在 `proxy/dump.ts` 的模块变量里，config
          段替换不会自动传进去。比较用 `configEqual` 而不是看 `logging` 键：`logging.level`
          变了 dump 没变时不必重灌。 */
    const prevDump = activeConfig.logging.dump;
    const prevLogLevel = activeConfig.logging.level;
    const changed = reloadConfig(activeConfig, next);
    const { reloaded, restartRequired } = classifyReload(activeConfig, next, changed);

    if (prevLogLevel !== next.logging.level) hooks.setLogLevel?.(next.logging.level);
    if (!configEqual(prevDump, next.logging.dump)) {
        (hooks.setDump ?? setDumpConfig)(next.logging.dump ?? { enabled: false, path: "" });
    }
    if (reloaded.includes("accounts")) {
        const accounts = next.accounts as NonNullable<ProxyConfig["accounts"]>;
        hooks.syncRuntimeAccounts?.(accounts);
    }
    if (reloaded.some((key) => B_CLASS_STOPS_HIGHSPEED.has(key))) {
        (hooks.stopHighspeed ?? shutdownAllHighspeed)();
    }
    /* claim 段的 B 类收尾：重启 schedulers —— 重启即重新错峰 + 重新 hold
       （per-plan hold 是内存状态，重建后重新学：已领过的计划再问一次上游会拿到
       already_claimed 的下个窗口，代价是一次被拒的 claim POST，换来的是实现零
       状态搬移）。*/
    if (reloaded.includes("claim")) {
        hooks.restartClaim?.();
    }

    return { ok: true, settings: settingsSnapshotOf(next, path), reloaded, restartRequired };
}
