import { hasCapableAccount } from "../accounts/capability.js";
import { createQuotaSampler } from "../accounts/quota.js";
import type { Account } from "../accounts/types.js";
import { readOauthStatus } from "../control/control.js";
import { LogBuffer } from "../log/buffer.js";
import { configureLogging, logger, resolveLogFormat } from "../log/index.js";
import type { UpdateCheckSummary } from "../control/control.js";
import { ensureConfigFile } from "../config/edit.js";
import { loadConfig } from "../config/loader.js";
import type { ProxyConfig } from "../config/types.js";
import { shutdownAllHighspeed } from "../highspeed/slots.js";
import { openBrowser } from "../runtime/open-browser.js";
import { checkForUpdate } from "../update/check.js";
import type { UpdateCheckResult } from "../update/check.js";
import {
  createPanelHandler,
  displayHostname,
  panelEntryUrl,
  printAdminPassword,
  printPanelUrl,
  resolvePanelSettings,
} from "./panel.js";
import type { PanelHandler, PanelProxyInfo } from "./panel.js";
import type { SettingsReloadHooks } from "./routes-state.js";
import type { ClaimAutoClaim } from "../claim/runtime.js";
import type { ClaimControlHooks } from "../claim/control.js";
import { activityLedger } from "../claim/ledger.js";
import { UserManager } from "../users/manager.js";
import { SessionStore } from "../users/session.js";
import { getDefaultApiKeyManager } from "../apikeys/manager.js";
import { openRequestStore, pageRequestHistory } from "../proxy/request-log.js";
import { computeUsageStats } from "../proxy/usage-stats.js";
import { setDumpConfig } from "../proxy/dump.js";
import type { RequestStore } from "../proxy/request-record.js";
import { buildServerOptions } from "./server-options.js";
import { startServer } from "./server.js";
import type { ProxyServer } from "./server.js";
import { createProductionBroker, openAccountStore, quotaSnapshot, refreshAccountQuota } from "../accounts/runtime.js";
import { createServeControl } from "./control-surface.js";
import type { ServeControl } from "./control-surface.js";
import { startServeControlListener } from "./control-listener.js";
import type { ServeControlListener } from "./control-listener.js";
import { shortId } from "../accounts/selection.js";
import type { ServeArgs } from "../index.js";
import { VERSION } from "../version.js";

/*
 * 运行期事件的日志。启动横幅与首次运行提示留在 console：那是「必须看见」的终端
 * 输出（logger 只管可归档的结构化日志），而 banner 里没有任何东西需要事后在面板里翻。
 */
const logCaptcha = logger("captcha");
/** 调度事件（能力对齐 / 复采）与账号仓同一个说话人，日志页过滤不分裂。*/
const logAccounts = logger("accounts");
const logClaim = logger("claim");
const logPanel = logger("panel");
const logControl = logger("control");

/**
 * Loopback spellings that keep the panel unexposed (same set the config loader
 * accepts for http:// origins). Anything else was an explicit `panel.host` and
 * gets the startup warning below.
 */
function isLoopbackPanelHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * `checkForUpdate` 的联合 → 控制面的稳定码（设置页「系统 · 检查更新」）。
 *
 * 句子在页面里拼（用户能读的句子翻译，版本号与容器的更新命令保持原文）。
 */
function toUpdateSummary(result: UpdateCheckResult): UpdateCheckSummary {
  switch (result.kind) {
    case "update":
      return {
        status: "update",
        current: result.notice.current,
        latest: result.notice.latest,
        notice: result.notice.text,
        url: result.notice.url,
      };
    case "up-to-date":
      return { status: "up-to-date", current: VERSION, latest: result.latest };
    case "skipped":
      return { status: "skipped", current: VERSION, latest: result.latest };
    case "unavailable":
      return { status: "unavailable", current: VERSION };
  }
}

/**
 * 组好控制面（面板账号密码鉴权的那一层）。面板挂在代理自己的监听上（`server.ts` 先问它），所以这里
 * 返回的是请求处理器，不是监听。
 *
 * 命令表与 `handleControl` 不在这里建：`control-surface.ts` 的 `createServeControl()`
 * 是唯一装配点，CLI 转发用的回环监听（`control-listener.ts`）用的是同一份，两条通道
 * 的命令语义因此不会分叉。面板只拿到那个包装过的 dispatcher。
 *
 * 这里没有代理启停命令：面板由代理自己的监听提供服务，停掉代理就是停掉问它的
 * 那条通道，进程里没有第三方能再把它拉起来。
 *
 * `shutdown` 的时序（先应答再退出）也留在 `createServeControl()` 里：它现在是两条
 * 通道共用的，只有面板走得到的话，CLI 转发过来的 shutdown 会拿到连接重置。
 */
async function buildServePanel(ctx: {
  /** 控制面（命令表 + shutdown 时序 + 账号回同步），与 CLI 转发共用。*/
  control: ServeControl;
  serverRef: { current: ProxyServer | null };
  /** 最后已知的监听端口（见 `serve` 里的同名变量说明）。*/
  portRef: { current: number };
  logBuffer: LogBuffer;
  /** 请求记录。进程里一份，与 `logBuffer` 同寿命。*/
  requests: RequestStore;
  users: UserManager;
  sessions: SessionStore;
  /** 面板地址（`panel.host`，为空时已经跟随 `server.host`）。*/
  hostname: string;
  /**
   * 进程内生效的那份 `ProxyConfig`（就是 `serve` 里传给 `startServer` 的同一个对象）。
   * 设置页写完 YAML 后靠它就地热重载；代理与面板看的是同一份，改完不用
   * 重启。不是模块级单例：从 `serve` 的作用域显式传下来，测试与别的宿主各自注入。
   */
  activeConfig: ProxyConfig;
  /**
   * 进程实际读写的那份配置文件路径。
   *
   * 设置页用它读写配置。在 `serve` 里只解析一次（`args.configPath ??
   * ZCODE_PROXY_CONFIG ?? config.yaml`），面板不再自己算——否则位置参数启动时
   * 面板会去读 `config.yaml`，与实际生效的那份分叉。
   */
  configPath: string;
  /**
   * B 类收尾的注入点：claim 段变化后重启各账号的领取调度器。函数体在
   * `serve` 作用域里（要摸运行组的句柄），由调用方传进来。
   */
  reloadHooks: SettingsReloadHooks;
}): Promise<PanelHandler> {
  const { control, serverRef, logBuffer, requests, users, sessions } = ctx;

  /**
   * `/api/system` 要的代理地址。
   *
   * 面板看不到 `ProxyServer`（句柄在 `serve` 手里），所以由这里注入。通配绑定
   * （`0.0.0.0`）换成回环地址：那才是用户在本机点得开的地址。
   *
   * 没有 `running` 字段：`serve` 形态下面板与代理共用一个监听，能问到这一句就说明
   * 代理在跑。端口在 `startServer` 之前是 0，所以地址可能短暂是 `:0` —
   * 面板这时也还没有对外应答的窗口。没有聊天页地址字段：聊天是面板自己的
   * 视图，顶栏按钮做客户端切换，不需要任何地址。
   */
  function describeProxy(): PanelProxyInfo {
    const host = displayHostname(serverRef.current?.hostname ?? ctx.hostname);
    const port = serverRef.current?.port ?? ctx.portRef.current;
    return {
      address: `${host}:${port}`,
    };
  }

  const handler = createPanelHandler({
    hostname: ctx.hostname,
    getPort: () => serverRef.current?.port ?? ctx.portRef.current,
    /* 面板守卫的是自己的传输层（登录会话），命令语义与 CLI 转发的那条通道共用
       同一个 `handleControl`（`control-surface.ts`）。*/
    handleControl: control.handleControl,
    getProxyInfo: describeProxy,
    users,
    sessions,
    /* 日志页按 `level` / `mod` / `account` 过滤要读结构化条目，所以把缓冲
       直接给面板：`getLogs` 命令只回字符串，页面过滤器拿不到字段。*/
    logBuffer,
    /* `/api/events` 的 `request` 事件订阅这个 store。*/
    requests,
    // 登录模态的轮询口：状态对象在控制面里，面板只拿得到 dispatcher，
    // 所以由这里注入读函数（过期判断在 `readOauthStatus` 里）。
    getOauthStatus: () => readOauthStatus(control.controlState),
    // 设置页的热重载入口：写盘成功后就地替换这份对象，A/B 类字段下一次
    // 请求按新值跑，C 类（端口 / 绑定地址）由响应里的 restartRequired 明说。
    // reloadHooks：claim 段变化后重启 schedulers（B 类收尾，serve 传入）。
    activeConfig: ctx.activeConfig,
    configPath: ctx.configPath,
    reloadHooks: ctx.reloadHooks,
  });
  return handler;
}

export async function serve(args: ServeArgs): Promise<void> {
  /* 配置文件路径只在这里解析一次：位置参数 > `ZCODE_PROXY_CONFIG` >
     默认值。面板拿到的是同一条（`configPath` 注入）—— 设置页与 serve 读写同一份
     文件，不能再各算各的。 */
  const path = args.configPath ?? process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (ensureConfigFile(path)) {
    console.log(`Created ${path} from bundled template.`);
    console.log(`Run: zcode-proxy auth login <zai|bigmodel>\n`);
  }
  const config = loadConfig(path);

  /*
   * dump 开关：把 `logging.dump` 灌进 `proxy/dump.ts` 的进程内配置。
   * 这里是启动快照；运行中的更新走设置页的热重载：`writeSettings` 发现
   * `logging.dump` 变了会再调一次 `setDumpConfig`。loadConfig 总是补齐这一段，
   * `??` 只是给类型上可选拿一个兜底。
   */
  setDumpConfig(config.logging.dump ?? { enabled: false, path: "" });

  // Web panel (issue #58). On by default: the TUI is gone and it is the
  // only graphical control surface left. `--no-panel` and `panel.enabled: false`
  // are the opt-outs. Resolved early so console output from the startup path
  // below is already captured for the panel's Logs card.
  const panelSettings = resolvePanelSettings(config, { disabled: args.noPanel });
  /*
   * 面板的日志缓冲。
   *
   * 这里不再有 monkey-patch console 的「tee」：所有日志都走 `src/log/` 的 logger，
   * 由 logger 直接写这个缓冲区，请求表格（`handler-log.ts`）走自己的
   * `writeRequestLine` 入口，所以不需要劫持 console。
   *
   * 删掉之后**不进缓冲**的东西只有两类，都是刻意的：启动横幅 / 首次运行提示（必须让
   * 终端前的人看见）与面板地址、管理员密码（`panel.ts` 直接写 `process.stdout.write`；
   * 密码一旦进缓冲就等于发给任何登录用户看的日志页）。
   */
  const panelLogBuffer = panelSettings ? new LogBuffer() : null;

  /*
   * 请求记录的实例。
   *
   * 内存一份、文件一份：`openRequestStore` 启动时从 `requests.jsonl`
   * 灌回历史，之后每次请求收尾追加一行。CLI 的 `logs` 读文件，面板的「请求事件」
   * 读内存，两条路看到的必须是同一批请求。
   *
   * 不用 `buildServerOptions` 的进程级单例：那个单例没接落盘，重启之后页面与 CLI
   * 就看不到上一轮的请求了。
   */
  const requests = openRequestStore();

  /*
   * 日志设施接线：级别来自配置，`serve debug` 把它抬到 `debug`
   * （阶段时间线就在那一档），格式来自 `ZCODE_LOG_FORMAT`，缓冲区只在面板开着时
   * 存在（`--no-panel` 时 `buffer` 留空，日志只写终端）。
   *
   * 放在这里是因为必须早于任何业务日志：下面的「没有账号」、面板地址、启动横幅
   * 都要按这个级别与去向输出。logger 走 `process.stdout/stderr.write`，与 console
   * 那层彻底分开，所以这里的 `console.*`（启动横幅）不会被记进缓冲区。
   */
  configureLogging({
    level: args.debug ? "debug" : config.logging.level,
    format: resolveLogFormat(process.env),
    /* 请求表格行只在有终端时写 stdout：serve + 面板、Docker、后台运行都没有
       人看终端，表格行既不打 stdout 也不进缓冲——请求信息只活在请求事件 tab。*/
    requestLines: process.stdout.isTTY === true,
    ...(panelLogBuffer ? { buffer: panelLogBuffer } : {}),
  });

  // 没有账号也启动。
  //
  // 建号本身要在面板里做，所以「没有账号」时退出只会让用户连入口都没有。请求进来时按
  // `no-account` 错误码返回 503，那是既有的语义，不需要新的引导流程。
  const accounts = await openAccountStore();
  const startupAccounts = await accounts.list();
  if (startupAccounts.length === 0) {
    console.warn("No account yet. Open the panel to add one, or run:");
    console.warn("  zcode-proxy auth login zai|bigmodel");
    console.warn("  zcode-proxy auth import [--jwt <token>]");
  }

  // 调试横幅打第一个账号：它只是让日志里出现一份凭据形状的样张，与"哪个账号在
  // 出线"无关（那由调度器按请求决定）。
  const debugAccount = startupAccounts[0];
  if (args.debug && debugAccount) await printDebugBanner(config, path, debugAccount);

  /**
   * 代理句柄的位置。
   *
   * 面板处理器要先于服务器建好（面板挂在那次监听上），所以启动顺序是「先建
   * 处理器、再 `startServer`、最后把句柄填进来」。这期间 `serverRef.current` 是
   * null，读它的地方（`getPort`、`/api/system`）都按回调处理，不会在构造时定格。
   */
  const serverRef: { current: ProxyServer | null } = { current: null };
  /**
   * 最后已知的监听端口。
   *
   * 面板在建监听之前就要回答「服务在哪个端口」，那一刻 `serverRef` 还是空的。`serve`
   * 在 `startServer` 之后写这里，`getPort`、`/api/system` 与 `status` 命令都读它。
   */
  const portRef = { current: 0 };

  // Handles for the background timers started below, so `shutdown` can clear
  // them without the proxy handle being involved.
  let claimScheduler: ClaimAutoClaim | null = null;
  let captchaModule: { shutdownCaptcha: () => void } | null = null;
  // 台账启动时清掉所有窗口都已结束的行；跨自然日由 scheduler 自己再做一次。
  void activityLedger.purgeExpired().catch((err) => logClaim.warn("claim ledger purge failed", { message: (err as Error).message }));
  /**
   * 额度采样。挂在这里而不是 `server.ts`：采样是**后台任务**，不是请求
   * 链路的一部分 —— `createFetchHandler` 要被测试反复构造，把定时器绑在那里等于
   * 每个用例都开一个会打上游的循环。
   */
  // 调度/队列/全局并发来自 `config.accounts`；缺省即 `DEFAULTS` 里那组值。
  //
  // 面板与额度采样器共用这一个 broker：两个实例会各自持有一份策略快照，页面上改的
  // 策略只对其中一个生效。
  // 账号级的运行时覆盖（持久化在账号记录里）在这里灌回内存，见 `createBroker`。
  // 采样器要在 broker 的构造参数里挂分级采分类器，所以先声明一个可变引用，
  // 构造函数只保存闭包（真正调用发生在启动之后，那时引用已填好）。
  let quotaSampler: ReturnType<typeof createQuotaSampler>;
  const broker = await createProductionBroker(accounts, config, {
    // 分级采：决策在采样器（样本龄 / stale / 30s 去重同源），broker 只做转发。
    classifyRefresh: (ids, focused) => quotaSampler.classifyRefresh(ids, focused),
    // 能力对齐生效后落一条调度事件：同一个 logger 说话人，日志页「系统」tab 可见。
    onAlignment: (alignment) => {
      logAccounts.info("capability alignment applied", {
        account: alignment.accountId,
        kinds: alignment.planKinds ?? [],
        blocked: alignment.blocked.map((block) => `${block.route}:${block.reason}`).join(","),
      });
    },
    // 终态码/空流 → 即时复采（与启动探测/分级采共用 sampleNow 的 30s 去重）。
    resample: (id, origin) => quotaSampler.sampleNow(id, origin),
  });
  quotaSampler = createQuotaSampler(config, accounts, broker);

  /*
   * claim 控制面与 claim 运行组都住在 claim/runtime|control 里，而它们
   * 拉起 captcha（happy-dom）。沿用启动纪律：动态 import，未开启的进程不付加载
   * 成本。首次调用时缓存 promise，三个钩子共用同一个 control 对象。
   */
  let claimControlPromise: Promise<ClaimControlHooks> | null = null;
  function claimControl(): Promise<ClaimControlHooks> {
    if (!claimControlPromise) {
      claimControlPromise = import("../claim/control.js").then((m) =>
        m.createClaimControl({
          config,
          accounts,
          ledger: activityLedger,
          // 运行组引用是可变的（热重载整组重建），给 getter 让每次读到的都是活值。
          getAutoClaim: () => claimScheduler,
        }),
      );
      claimControlPromise.catch((err) => logClaim.warn("claim control unavailable", { message: (err as Error).message }));
    }
    return claimControlPromise;
  }
  /** 钩子的降级：claim 模块没加载成（或宿主没接）时回稳定码，不抛。*/
  function claimUnavailable(): { ok: false; code: string } {
    return { ok: false, code: "claim_unavailable" };
  }

  /*
   * 控制面。面板的 `/api/control` 与 CLI 转发用的回环监听共用这一份
   * `handleControl`：命令语义、`shutdown` 的「先应答再退出」、账号回同步只有一处实现。
   *
   * 面板关掉也照样建：CLI 转发不依赖面板，`--no-panel` 的 serve 更需要它（那种部署
   * 根本没有别的入口）。
   */
  const control = await createServeControl({
    portRef,
    shutdown: () => void shutdown(),
    context: {
      /* 面板关掉时没有日志缓冲（日志只写终端），控制面仍然需要一个：给它一个空缓冲，
         而不是让 `getLogs` 有一种「没有上下文」的新错误。*/
      logBuffer: panelLogBuffer ?? new LogBuffer(),
      /* `getRequests` 读的就是代理正在写的那一份。`buildServerOptions` 也拿
         这一份，两处给同一个实例才算「与面板同源」。*/
      requests,
      /* `getRequestsHistory`：面板「加载更早」从 requests.jsonl 倒序分页读。
         `pageRequestHistory` 缺省就是 `requestLogPath()`，透传即可。*/
      requestHistory: pageRequestHistory,
      /* `getUsageStats`：报表聚合从 requests.jsonl 单遍倒序扫，每次现算。
         `computeUsageStats` 的缺省路径同样是 `requestLogPath()`，透传即可。*/
      usageStats: computeUsageStats,
      onQuota: () => quotaSnapshot(config, broker),
      // 账号详情卡的「刷新」：带 label 的 quota 命令走采样器同一条归一路径，
      // 采到的结果写回采样缓存（面板回读 /api/state 就能看到新数据）。
      refreshQuota: (label) => refreshAccountQuota(quotaSampler, accounts, label),
      // 顶栏分级采：页面给的是 label 清单（账号摘要不回显完整 id），这里
      // 逐条解析成账号 id；实际采样统一走 quotaSampler.sampleNow（与复采/启动同入口）。
      refreshQuotaScoped: async (labels, focusedLabel) => {
        const ids: string[] = [];
        const focused = focusedLabel ? (await accounts.getByLabel(focusedLabel))?.id : undefined;
        for (const label of labels) {
          const account = await accounts.getByLabel(label);
          if (account) ids.push(account.id);
        }
        const decision = await broker.refreshQuota(ids, focused, (id) => quotaSampler.sampleNow(id, "panel-refresh"));
        logAccounts.info("quota refresh scoped", {
          sampled: decision.sampled.length,
          skipped: decision.skipped.length,
        });
        return decision;
      },
      // 账号表的额度摘要读采样缓存（只读，不触发上游请求）。这是 serve 路径
      // 的唯一接线点：CLI 侧刻意不接（见 cli/control.ts 的注释）。
      quotaSamples: () => quotaSampler.snapshot(),
      // 数据龄标注的阈值来源：「超过一个采样周期」的"一个采样周期"就是它。
      get quotaPollSeconds() { return quotaSampler.quota.pollSeconds; },
      accounts,
      // 账号 / 策略命令面的唯一写入方是 broker；不传它，控制面能读账号仓
      // 却改不到调度器，`listAccounts` 之类会直接回 `account_control_unavailable`。
      // 与 `openCliControl()` 传同一份 broker 与 entries，两个入口才等价。
      broker,
      // `entries[]` 与 broker 的运行时表按热重载同步，读时取活值。
      get entries() { return config.accounts?.entries ?? []; },
      // 设置页「服务」组：手动检查更新。
      onCheckUpdate: () => checkForUpdate(VERSION, { force: true }).then(toUpdateSummary),
      // 登录授权链接的 `app_version` 跟热重载后的身份段走。
      get identityAppVersion() { return config.identity.appVersion; },
      // 抢活动控制面：动态加载 claim/control，加载失败降级为
      // claim_unavailable。实现与限频纪律见 src/claim/control.ts。
      onClaimOverview: () => claimControl().then((c) => c.getOverview()).catch(claimUnavailable),
      onPreviewClaimPlans: (label) => claimControl().then((c) => c.previewPlans(label)).catch(claimUnavailable),
      onListClaimPlanChoices: () => claimControl().then((c) => c.listPlanChoices()).catch(claimUnavailable),
      onClaimNow: (label, planId) => claimControl().then((c) => c.claimNow(label, planId)).catch(claimUnavailable),
    },
  });
  // `withinTier: drain-first` 要读每条 `(account, route)` 的过期时间，数据在
  // 采样器里。挂在 broker 上而不是让 broker import 采样器，见 `QuotaExpirySource`。

  let panelHandler: PanelHandler | undefined;
  let sessions: SessionStore | undefined;
  if (panelSettings && panelLogBuffer) {
    sessions = new SessionStore();
    const users = new UserManager();
    /*
     * 首次启动生成管理员：没有用户时建 `admin`，密码打印到 stdout 一次。
     * 不走引导页：首次启动的场景只发生在终端里，用户本来就在看 stdout。
     */
    const admin = await users.ensureAdmin();
    if (admin.created && admin.password) printAdminPassword(admin.password);

    panelHandler = await buildServePanel({
      control,
      serverRef,
      portRef,
      logBuffer: panelLogBuffer,
      requests,
      users,
      sessions,
      hostname: panelSettings.host,
      activeConfig: config,
      configPath: path,
      reloadHooks: {
        restartClaim: restartClaimSchedulers,
        setLogLevel: (level) => {
          if (!args.debug) configureLogging({ level });
        },
        syncRuntimeAccounts,
      },
    });
  }

  broker.attachQuotaExpiry(quotaSampler);
  quotaSampler.start();
  // 启动主动探测：每个账号（含停用）的首轮额度采样提前到 0–30s 抖动窗内
  // （相位错峰 + 注入随机源）。停用账号不参与调度、也不会产生活跃记录，周期
  // 采样永远跳开它们，所以启动首轮是它们拿到额度值的唯一自动入口（账号页仍要
  // 展示它们的额度）。与官方「登录后拉额度」同形、零新增独立探测流量；失败不
  // 屏蔽，只有成功拿到 planes 才参与能力对齐。定时器 unref。
  void quotaSampler.probeAtStartup();

  // 预热闸门：有账号的白名单含 start-plan 才预热（没有「全局 plan 标记」这种对象）。
  // 没有「当前账号」这回事：一次请求用哪个账号由调度器决定，所以每个
  // 启用且带 start-plan 路由的账号都要预热自己的池（R3：池按账号分）。
  // 预热列表的筛选在 `captcha.ts::captchaPoolAccounts` 里；这里的 `some` 只为了让
  // 不用 captcha 的部署不加载那个模块。
  const accountList = await accounts.list();
  if (accountList.some((account) => account.enabled && account.routes.includes("start-plan"))) {
    // Pre-solve the captcha token pools in the background so first requests
    // don't pay the full solve latency (in-process happy-dom backend).
    import("../captcha/captcha.js")
      .then(async (m) => {
        captchaModule = m;
        const warm = await m.warmCaptchaPools(config.identity.appVersion, accountList);
        for (const failure of warm.failed) {
          logCaptcha.warn("pool warmup failed", { account: failure.accountId.slice(0, 8), message: failure.message });
        }
      })
      .catch((err) => logCaptcha.error("pool warmup failed", {}, err));
  }
  if (config.claim.enabled && config.claim.auto) {
    import("../claim/runtime.js")
      .then(async (m) => {
        claimScheduler = await m.startAutoClaim(config, accounts, { broker });
        if (!claimScheduler) return;
        logClaim.info("auto claim ON", { pollSeconds: Math.round(config.claim.pollIntervalMs / 1000) });
      })
      .catch((err) => logClaim.error("scheduler failed to start", {}, err));
  }

  /** 热重载时同步 broker 与额度采样器持有的运行时副本。 */
  function syncRuntimeAccounts(accounts: NonNullable<ProxyConfig["accounts"]>): void {
    void broker.applyConfigAccounts(accounts).catch((err) => {
      logAccounts.error("account policy reload failed", {}, err);
    });
    quotaSampler.applyConfigQuota(accounts.quota);
  }

  /*
   * claim 段的 B 类收尾：writeSettings 热重载把 claim 配置换进内存后，
   * 旧 schedulers 还拿着旧的间隔 —— 整组停掉重起，新一轮按新配置
   * 错峰。开关关掉（enabled/auto 任一为 false）时只停不起。
   */
  function restartClaimSchedulers(): void {
    if (claimScheduler) {
      try {
        claimScheduler.stop();
        logClaim.info("auto claim stopped for reload");
      } catch {
        /* already stopped */
      }
      claimScheduler = null;
    }
    if (!(config.claim.enabled && config.claim.auto)) return;
    import("../claim/runtime.js")
      .then(async (m) => {
        claimScheduler = await m.startAutoClaim(config, accounts, { broker });
        if (!claimScheduler) return;
        logClaim.info("auto claim restarted", { pollSeconds: Math.round(config.claim.pollIntervalMs / 1000) });
      })
      .catch((err) => logClaim.error("scheduler failed to restart", {}, err));
  }

  const server = await startServer({
    ...buildServerOptions(config, broker, accounts, args.debug, requests),
    ...(panelHandler ? { panel: panelHandler } : {}),
    ...(sessions ? { sessions } : {}),
  });
  serverRef.current = server;
  portRef.current = server.port;
  const url = `http://${server.hostname}:${server.port}`;
  console.log(`zcode-proxy listening on ${url}`);

  /*
   * CLI 转发用的回环控制监听。端口由内核分配，写进 store 目录的端口
   * 文件里，`zcode-proxy routing set` 这类命令靠它找到这个进程。
   *
   * 起不来只告警，不拦启动：没有它的时候 CLI 退回本地路径，并明确说「下次启动生效」。
   * 那比让整个 serve 因为一个 CLI 便利通道而起不来好。
   */
  let controlListener: ServeControlListener | null = null;
  try {
    controlListener = await startServeControlListener({
      handleControl: control.handleControl,
      state: control.controlState,
      accounts,
    });
    logControl.info("control listener ready", { port: controlListener.port });
  } catch (err) {
    logControl.warn(
      "control listener failed to start; CLI commands fall back to the offline path",
      { message: (err as Error).message },
    );
  }
  if (panelSettings) {
    printPanelUrl({ hostname: panelSettings.host, port: server.port });
    /*
     * 启动时顺手把浏览器叫起来。只在真的有人在终端前面时这么做：容器、CI
     * 和 `docker compose up` 的日志里没有可打开浏览器的桌面会话，那里弹出来的只会
     * 是一条 xdg-open 失败。地址已经打印在上面，无头场景自己复制即可。
     */
    if (process.stdout.isTTY) openBrowser(panelEntryUrl(panelSettings.host, server.port));
    // A non-loopback bind (the Docker bridge case) is safe only as long as the
    // login password stays private and the port stays firewalled past the host
    // that needs it — say so at startup, not only in the docs.
    if (!isLoopbackPanelHost(panelSettings.host)) {
      logPanel.warn(
        "panel reachable on a non-loopback address: anyone who reaches this port and signs in can log out, change settings, or shut down",
        { host: panelSettings.host },
      );
    }
  }

  // 启动横幅报账号表的规模与 label，不报「当前账号」：多账号下出线账号按请求
  // 决定，这里的用途只是确认配置文件与账号仓都读到了。
  if (startupAccounts.length > 0) {
    console.log(`  accounts: ${startupAccounts.length} (${startupAccounts.map((account) => account.label).join(", ")})`);
  }
  console.log(`  models: ${config.models.length} available`);
  // /v1/responses 不横幅：三条入站协议都常开，常开的东西不需要每次宣告
  // （/v1/models 与另两条协议也不打印）。/async/* 才值得报，它有真实的关闭态。
  if (config.async.enabled) {
    // 闸门是"有没有账号能跑 async"，不是"全局 plan 是不是 coding-plan"。
    const asyncCapable = await hasCapableAccount(accounts, "async");
    console.log(asyncCapable
      ? `  /async/v1/*: ON`
      : `  /async/v1/*: OFF (no account holds both the plan JWT and the coding-plan API key)`);
  }
  if (args.debug) console.log(`  debug: ON`);

  // Update notice (issue #60): fire-and-forget — a slow or blocked GitHub must
  // never delay startup, and every failure mode is silent (see update/check.ts).
  // In a container the hint is the compose command: the image cannot self-update.
  void checkForUpdate(VERSION).then((result) => {
    if (result.kind === "update") console.log(`  update: ${result.notice.text}`);
  });

  // Single shutdown path, shared by the signals and the panel's `shutdown`
  // command. It must not depend on `serverRef`: a signal can arrive while the
  // server is still starting up (the handle is filled in after `startServer`),
  // and the timers below keep the event loop alive, so "no proxy handle yet" is
  // not the same as "there is nothing left to do".
  //
  // 面板挂在代理的监听上，所以这里不需要单独关它：`serverRef.stop()` 一关，控制面
  // 与数据面一起消失。
  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    /*
     * 先关控制监听：它的 `close()` 顺手删掉端口文件（`runtime/control-port.ts`）。
     * 信号与面板 / CLI 的 `shutdown` 命令都走这个函数，所以「正常退出」与「被信号
     * 打断」两种结束共用同一处清理。`kill -9` 跑不到这里，那一份由 CLI 自己删。
     */
    if (controlListener) {
      try {
        await controlListener.close();
      } catch {
        /* 监听早就没了 */
      }
      controlListener = null;
    }
    const cleared: string[] = [];
    if (claimScheduler) {
      try {
        claimScheduler.stop();
        cleared.push("auto-claim");
      } catch {
        /* already stopped */
      }
      claimScheduler = null;
    }
    if (captchaModule) {
      try {
        captchaModule.shutdownCaptcha();
        cleared.push("captcha pool");
      } catch {
        /* pool never started */
      }
      captchaModule = null;
    }
    try {
      shutdownAllHighspeed(); // heartbeats are unref'd but stopped explicitly on shutdown
      cleared.push("highspeed");
    } catch {
      /* loop never ignited */
    }
    try {
      quotaSampler.stop(); // sampling loop (unref'd, stopped explicitly)
      cleared.push("quota sampler");
    } catch {
      /* sampler never started */
    }
    if (cleared.length > 0) console.log(`shutdown: cleared ${cleared.join(" + ")} timers`);
    /*
     * 退出前把 API key 的用量落盘：加密是异步的，`process.on("exit")`
     * 里发起的写永远完不成，所以在这一步等它。下面两条分支都会让进程立刻退出，
     * 等待必须发生在它们之前。
     */
    try {
      await getDefaultApiKeyManager().flush();
    } catch (e) {
      // 退出路径上写盘失败已经没地方报告了，留一行日志就好。
      console.error(`shutdown: api key usage flush failed: ${(e as Error).message}`);
    }
    if (serverRef.current) {
      // Closes the listener and exits the process (`stop(true)`).
      serverRef.current.stop(true);
      return;
    }
    console.log("shutdown: proxy already stopped — exiting");
    process.exit(0);
  }

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

/**
 * 启动横幅。provider / plan 都是**账号**的属性，所以这里打印的是
 * 账号自己的 family 与路由白名单，而不是全局配置。
 */
async function printDebugBanner(config: ProxyConfig, path: string, account: Account): Promise<void> {
  const cred = account.credential;
  const credShape = cred.apiKey
    ? `${cred.apiKey.slice(0, 6)}...${cred.apiKey.slice(-4)} (${cred.apiKey.length} chars)`
    : "(none; plan-JWT only)";
  const active = config.providers[cred.provider];
  console.log("=== zcode-proxy DEBUG MODE ===");
  console.log(`  config file: ${path}`);
  console.log(`  server: ${config.server.host}:${config.server.port}`);
  const apiKeys = getDefaultApiKeyManager();
  console.log(`  api keys: ${(await apiKeys.list()).length} (${config.auth.requireKey ? "required" : "not required"})`);
  console.log(`  account: ${account.label} (id ${shortId(account.id)}…)`);
  console.log(`  provider: ${cred.provider}`);
  console.log(`  routes: ${account.routes.join(", ")}`);
  console.log(`  identity: appVersion=${config.identity.appVersion} sourceTitle=${config.identity.sourceTitle} referer=${config.identity.refererOrigin}`);
  console.log(`  client identity: mode=${config.clientIdentity.mode} ttl=${config.clientIdentity.ttlSeconds}s max=${config.clientIdentity.maxSessions}`);
  console.log(`  anthropic base: ${active.anthropicBase}`);
  console.log(`  openai base:    ${active.openaiBase}`);
  console.log(`  credential: ${credShape}`);
  console.log(`  models (${config.models.length}): ${config.models.join(", ")}`);
  console.log(`  log level: ${config.logging.level}`);
  console.log("===============================");
}
