/**
 * 面板行为测试的共享脚手架。
 *
 * 这里只有「怎么把页面跑起来」和跨视图复用的 fixture，没有任何断言：把真正拼出来的
 * 页面 + 真正的 `app.js` 放进 happy-dom 跑一遍，`fetch` 换成可编程的桩。
 *
 * 拆分的理由：原先单文件 8763 行、63 个 describe，每个 describe 都重新挂一份完整面板
 * DOM，一次全跑要吃 3.6 GB 内存。现在按视图拆成 `runtime-*.test.ts`，每个文件独立
 * 进程，峰值只按一个视图算。**每个测试文件都要在顶层调一次 {@link installHarnessHooks}。**
 *
 * 落在本文件的都是被两个以上视图用到的部分：只有单个视图需要的 fixture 跟着视图走
 * （在对应的 `runtime-*.test.ts` 里）。
 */

import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalWindow } from "happy-dom";
import { PAGE_APP_SCRIPT, renderPanelPage } from "./page.js";
import type { AccountQuotaSummary, AccountSummary } from "../../control/control.js";
import { DEFAULT_ACCOUNTS_ROUTING, DEFAULT_ACCOUNTS_STICKINESS } from "../../accounts/routing.js";
import { DEFAULT_ACCOUNTS_RISK } from "../../config/types.js";
import type { StatePayload } from "../routes-state.js";

/** 存储目录隔离：页面驱动 `setRoutingPolicy` 会落盘，不能写进用户的真实目录。*/
const prevStoreDir = process.env.ZCODE_PROXY_STORE_DIR;

let testStoreDir = "";

/* ------------------------------------------------------------------------- */
/* 测试脚手架                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * 页面里的一个元素。
 *
 * happy-dom 自带一套 `Element` / `Document` 类型，与 TS 的 DOM lib 同名但**不兼容**
 * （两份声明各自带私有 symbol）。逐处强转会让测试充满 `as unknown as`，所以在脚手架
 * 边界只转这一次：这里只声明断言真正用到的成员，其余一律不暴露。
 */
export interface PageNode {
  textContent: string | null;
  className: string;
  colSpan: number;
  tagName: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  title: string;
  click(): void;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  dispatchEvent(event: unknown): boolean;
  querySelector(selector: string): PageNode | null;
  querySelectorAll(selector: string): PageNode[];
}

/** 一次 `fetch` 调用的记录：足够断言「发了什么命令」。*/
export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  /** 凭据模式：key 模式的聊天请求带 `"omit"`（不带面板 Cookie），其余
   * 不设这个字段——fetch 默认 same-origin，Cookie 照旧随同源请求走。*/
  credentials?: string;
}

/** `POST /api/control` 的应答（控制协议：失败也是 200 + `ok:false`）。*/
export interface ControlReply {
  ok: boolean;
  error?: string;
  event?: string;
  aborted?: number;
  /** `accountsImported`。*/
  imported?: number;
  /** `accountsExported`。*/
  format?: string;
  count?: number;
  /** 服务端落盘路径（inline 模式下的老形态，现在回 `payload`）。*/
  path?: string;
  /** 内容返回模式：`payload` 是文件原文，`filename` 是服务端拼的下载名。*/
  payload?: string;
  filename?: string;
  /** `oauthUrl`（登录时新标签页打开的地址）。*/
  authorizeUrl?: string;
  /** `updateCheck`。*/
  update?: {
    status: "update" | "up-to-date" | "skipped" | "unavailable";
    current: string;
    latest?: string;
    notice?: string;
    url?: string;
  };
  /** `appVersion`：探测到的官方客户端版本与路径，没有客户端时 `null`。*/
  detected?: string | null;
  /** `proxies` 事件：整张代理表。*/
  proxies?: Record<string, unknown>[];
  /** `proxies` 事件的默认出口。*/
  defaultProxy?: string;
  /** `listApiKeys` 的应答（聊天视图的 key 下拉读同一份命令）。*/
  apiKeys?: Record<string, unknown>[];
  /** `removeProxy` 带 `force` 时被改回默认出口的账号。*/
  detached?: string[];
  /** `getRequests`：请求记录列表（新的在前）。*/
  records?: RequestRecordFixture[];
  /** `getRequestsHistory`：一页历史（新的在前）与 hasMore。*/
  requests?: RequestRecordFixture[];
  hasMore?: boolean;
  /** `startOAuth` 回的流程 id（登录模态用它认领轮询应答）。*/
  flowId?: string;
  /** `startOAuth` 回的回调端口（页面不读，但应答里有这个字段）。*/
  callbackPort?: number;
}

export interface Harness {
  win: GlobalWindow;
  /**
   * 整页跳转的记录（`window.location.replace` 的桩）。
   *
   * 会话失效之后页面不再露输入框，而是跳回 `/login`，所以断言的对象是
   * 「跳去哪」而不是「显示了什么」。
   */
  navigations: string[];
  /** `/api/events` 的假事件流：测试用 `push` 喂帧，`end` 模拟服务端断开。*/
  events: EventFeed;
  /** `GET /api/settings` 返回的载荷（测试可随时改）。*/
  settings: SettingsPayload;
  /** 下一次 `POST /api/settings` 的应答（默认成功并回写 `settings`）。`reloaded` /
   * `restartRequired` 与服务器写配置的应答同形（哪些字段已热生效、哪些要重启）；
   * 测试用它驱动「已生效 / 需重启」两种提示。*/
  settingsReply: {
    ok: boolean;
    error?: string;
    settings?: SettingsPayload;
    reloaded?: string[];
    restartRequired?: string[];
    fileWritten?: boolean;
  };
  /** 下一次 `/api/events` 请求的状态码（默认 200；用 401 测令牌失效）。*/
  eventsStatus: number;
  calls: Call[];
  /** 当前 `/api/state` 要返回的载荷；测试可以随时改。*/
  state: StatePayload;
  /** 当前 `/api/system` 要返回的载荷（设置页「服务」组的版本行）。*/
  system: SystemPayload;
  /** 下一次 `POST /v1/chat/completions` 的应答（聊天视图）。非 200 时用
   * `error` 当正文；`body` 是测试推的假 SSE 流；`abort` 在请求被中止时触发，
   * 模拟真实 fetch 以 `AbortError` 拒绝。*/
  chat: {
    status: number;
    error?: string;
    body?: ReadableStream<Uint8Array>;
    abort?: () => void;
  };
  /** `listProxies` 要返回的表。页面启动时取一次，所以要在挂载前就位。*/
  proxies: Record<string, unknown>[];
  /** `listProxies` 要返回的默认出口。*/
  defaultProxy: string | undefined;
  /** `listApiKeys` 要返回的表（聊天视图进视图取一次）。*/
  apiKeys: Record<string, unknown>[];
  /** `getUsageStats` 要返回的范围应答（概览与统计页的报表数据）。*/
  usageStats: Record<string, unknown>;
  /** `getUsageStats` 要返回的热力图应答（回看 365 天的那条命令）。*/
  heatmapStats: Record<string, unknown>;
  /** 下一次 `POST /api/control` 的应答（默认成功）。*/
  controlReply: ControlReply;
  /**
   * 按顺序消费的控制应答（用完就回落到 {@link controlReply}）。
   * 「重启」是两条命令（stop → start），两条的应答可能不同。
   */
  controlReplies: ControlReply[];
  /** 下一次 `POST /api/password` 的状态码与应答（默认成功）。*/
  passwordStatus: number;
  passwordReply: Record<string, unknown>;
  /** 当前 `GET /api/oauth-status` 要返回的载荷（登录模态的轮询口）。*/
  oauthStatus: Record<string, unknown>;
  /** 当前 `GET /api/credential-sources` 要返回的扫描结果（添加账号 → 服务端文件）。*/
  credentialSources: Array<{ path: string; provider?: string; valid?: boolean }>;
  /**
   * 假定时器：`window.setInterval` 只登记回调，由 `tick()` 手动推一轮。
   *
   * 登录轮询间隔是 2s（`C.LOGIN_POLL_INTERVAL_MS`），真等一轮会让用例慢两秒；而
   * 「关掉模态之后不再轮询」这条断言必须先推得动定时器、再推不动，才有意义。
   */
  intervals: { live(): number; tick(): void };
  /** 按 `data-role` 找元素。*/
  role(name: string): PageNode | null;
  /** 按选择器找元素（视图 / 模态等用属性选择器定位的节点）。*/
  find(selector: string): PageNode | null;
  /** 某个 `data-role` 容器里的所有行。*/
  rows(name: string): PageNode[];
  /** 触发一次 click。*/
  click(node: PageNode | null): void;
  /** 改动表单值并触发 `change`。*/
  change(node: PageNode | null, value: string, checked?: boolean): void;
  /** 改动文本框并触发 `input`（搜索框是边打边筛）。*/
  type(node: PageNode | null, value: string): void;
  /** 在聊天输入框里敲一次键（Enter 发送）。*/
  key(keyName: string, options?: { shiftKey?: boolean }): void;
  /** 等一轮渲染（只等挂起的 fetch 链，不触发新读取）。*/
  settle(): Promise<void>;
  /** 主动重读一次 `/api/state`（模拟一次轮询，或写后刷新）。*/
  refresh(): Promise<void>;
  close(): void;
}

/** 假事件流：一个浏览器侧看到的 `ReadableStream`，测试往里推 SSE 帧。*/
interface EventFeed {
  /** 已经建立的连接数（重连断言用）。*/
  connections(): number;
  /** 推一个 `event:` + `data:` 帧。*/
  frame(event: string, data: unknown): void;
  /** 推一个心跳注释帧（客户端必须忽略）。*/
  comment(): void;
  /** 服务端关闭流（正常结束 → 客户端应重连）。*/
  end(): void;
  /** 一次新连接的 body（每次 `fetch('/api/events')` 都要一个新的流）。*/
  open(): ReadableStream<Uint8Array>;
}

function createEventFeed(): EventFeed {
  const encoder = new TextEncoder();
  const live: ReadableStreamDefaultController<Uint8Array>[] = [];
  let connections = 0;

  const push = (text: string): void => {
    for (const controller of live) controller.enqueue(encoder.encode(text));
  };

  return {
    connections: () => connections,
    frame: (event: string, data: unknown) => push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    comment: () => push(":\n\n"),
    end: () => {
      for (const controller of live) controller.close();
      live.length = 0;
    },
    open: () => {
      connections += 1;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          live.push(controller);
        },
      });
    },
  };
}

/**
 * `/api/system` 的载荷（形状与 `panel.ts` 的 `PanelSystemInfo` 一致）。
 *
 * 只剩版本与地址：代理侧的聊天页地址字段随独立页一起删掉了，顶栏的聊天按钮
 * 是视图切换，不再需要任何地址。
 */
interface SystemPayload {
  version: string;
  panelAddress: string;
  proxy: { address: string };
}

function systemPayload(overrides: Partial<SystemPayload> = {}): SystemPayload {
  return {
    version: "5.0.0",
    panelAddress: "127.0.0.1:8090",
    proxy: { address: "127.0.0.1:8080" },
    ...overrides,
  };
}

/** `/api/settings` 的载荷（形状与 `routes-state.ts` 的 `SettingsSnapshot` 一致）。*/
export interface SettingsPayload {
  configPath: string;
  models: string[];
  connection: { defaultModel: string; mode: string; ttlSeconds: number; maxSessions: number };
  identity: {
    normalizeClientSystem: boolean;
    appVersion: string;
    appVersionSource: "manual" | "detected" | "default";
    appVersionSourcePath?: string;
  };
  subsystems: {
    highspeed: boolean;
    mcp: boolean;
    async: boolean;
    claim: boolean;
    dumpEnabled: boolean;
    dumpPath: string;
    quotaPollSeconds: number;
    quotaDrainThreshold: number;
  };
  security: { port: number; host: string; requireKey: boolean };
}

export function settingsPayload(overrides: Partial<SettingsPayload> = {}): SettingsPayload {
  return {
    configPath: "config.yaml",
    models: ["glm-5.3", "glm-5.3-flash"],
    connection: { defaultModel: "glm-5.3", mode: "enforce", ttlSeconds: 900, maxSessions: 1024 },
    identity: { normalizeClientSystem: true, appVersion: "3.17.1", appVersionSource: "default" },
    subsystems: {
      highspeed: true,
      mcp: true,
      async: false,
      claim: true,
      dumpEnabled: false,
      dumpPath: "",
      quotaPollSeconds: 300,
      quotaDrainThreshold: 1,
    },
    security: { port: 8080, host: "127.0.0.1", requireKey: true },
    ...overrides,
  };
}

/**
 * 页面 origin。
 *
 * 三段拼起来而不是写成字面量：`src/server/web/` 的「无外部引用」自查必须只命中真正
 * 的外链，测试里的本地回环地址不该出现在那条结果里。
 */
const LOOPBACK_ORIGIN = ["http:", "", "127.0.0.1:8090"].join("/");

/** 一个可用的账号摘要（`AccountSummary` 的必填字段全给齐）。*/
export function account(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    idPrefix: "abcd1234",
    label: "work-team",
    kind: "zhipu-account",
    provider: "zai",
    routes: ["coding-plan"],
    enabled: true,
    weight: 1,
    maxConcurrency: 2,
    health: "ok",
    routeHealth: [{ route: "coding-plan", status: "ok" }],
    inflight: 0,
    quota: null,
    capabilityBlocks: [],
    planKinds: ["subscription"],
    hasApiKey: true,
    proxy: "direct",
    ...overrides,
  };
}

/** 额度摘要（coding 平面看窗口；套餐三段，空数组是合法状态）。*/
export function quota(overrides: Partial<AccountQuotaSummary> = {}): AccountQuotaSummary {
  return {
    stale: false,
    /* 数据龄默认「刚刚采的」：老用例不该被「上次采样 X 分钟前」标注
       刷屏；要验标注的用例自己把 sampledAt 推回过去。 */
    sampledAt: Date.now(),
    pollSeconds: 300,
    windows: [],
    balances: [],
    plans: [],
    campaigns: [],
    ...overrides,
  };
}

export function statePayload(overrides: Partial<StatePayload> = {}): StatePayload {
  return {
    server: { port: 8090, version: "5.0.0", uptime: 120 },
    accounts: [],
    routing: { ...DEFAULT_ACCOUNTS_ROUTING, order: [...DEFAULT_ACCOUNTS_ROUTING.order] },
    stickiness: { ...DEFAULT_ACCOUNTS_STICKINESS },
    risk: { alerts: [], policy: { ...DEFAULT_ACCOUNTS_RISK } },
    metrics: { inflight: 0, concurrencyLimit: 8, queueDepth: 0, sampledAt: 0, inflightHistory: [] },
    ...overrides,
  };
}

/**
 * `getUsageStats` 的应答聚合（`UsageStatsStats`，只给用例用到的字段全值）。
 *
 * 两个小时桶（09:00 与 10:00 UTC）+ 两个分组维度样本，让总览卡、时序图、分组表、
 * 错误分析、调度事件与缓存命中率都有东西可断言；`withData: false` 给全零形状
 * （空态用例）。
 */
export function usageStatsFixture(options: { withData?: boolean; hour?: number } = {}): Record<string, unknown> {
  const withData = options.withData !== false;
  const hour = options.hour ?? 9;
  const hourMs = 3_600_000;
  const bucket = (start: number, input: number, output: number) => ({
    bucketStart: start,
    requests: input + output > 0 ? 3 : 0,
    ok: input + output > 0 ? 2 : 0,
    failed: input + output > 0 ? 1 : 0,
    inputTokens: input,
    outputTokens: output,
    cacheHitSamples: 0,
    cacheReadTokens: 0,
  });
  const group = (key: string, requests: number, failed: number) => ({
    key,
    requests,
    failed,
    inputTokens: requests * 100,
    outputTokens: requests * 50,
    ...(requests > 0 ? { avgTotalMs: 1200, avgTps: 12.5 } : {}),
  });
  return withData
    ? {
        totals: {
          requests: 6,
          ok: 4,
          failed: 2,
          inputTokens: 600,
          outputTokens: 300,
          avgTtfbMs: 420,
          avgTps: 18.4,
          errorCount: 2,
        },
        hourly: [bucket(hour * hourMs, 400, 200), bucket((hour + 1) * hourMs, 200, 100)],
        daily: [{ ...bucket(0, 600, 300), bucketStart: 0 }],
        // 热力图聚合（日 / 周 / 累计 + MCP 计数）。测试里热力图 fixture
        // 通常显式覆盖这一块；这里给一格日格保形状完整。
        heatmap: {
          daily: [{ bucketStart: 0, tokens: 900, mcpCalls: 1 }],
          weekly: [{ bucketStart: 0, tokens: 900, mcpCalls: 1 }],
          cumulative: [{ bucketStart: 0, tokens: 900, mcpCalls: 1 }],
        },
        byAccount: [group("work-team", 4, 1), group("home", 2, 1)],
        byRoute: [group("coding-plan", 6, 2)],
        byModel: [group("glm-5.3", 6, 2)],
        byApiKey: [group("k001", 4, 1), group("-", 2, 1)],
        byProtocol: [group("anthropic", 6, 2)],
        byClientKind: [group("claude-code", 6, 2)],
        errors: [
          { stage: "upstream-resp", kind: "upstream-rate-limited", count: 1 },
          { stage: "dispatch", kind: "queue-timeout", count: 1 },
        ],
        schedule: { degraded: 1, cooled: 2, queueTimeout: 1 },
        // 命中率分母是三块（输入 + 读 + 写）—— 700 / (100 + 700 + 200) = 70%。
        cacheHit: { samples: 3, inputTokens: 100, readTokens: 700, creationTokens: 200, creationSamples: 3 },
        range: { from: 0, to: 0, records: 6 },
      }
    : {
        totals: { requests: 0, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, errorCount: 0 },
        hourly: [],
        daily: [],
        heatmap: { daily: [], weekly: [], cumulative: [] },
        byAccount: [],
        byRoute: [],
        byModel: [],
        byApiKey: [],
        byProtocol: [],
        byClientKind: [],
        errors: [],
        schedule: { degraded: 0, cooled: 0, queueTimeout: 0 },
        cacheHit: { samples: 0, inputTokens: 0, readTokens: 0, creationTokens: 0, creationSamples: 0 },
        range: { records: 0 },
      };
}

const harnesses: Harness[] = [];

/**
 * 起一个页面实例。
 *
 * `path` 决定显示哪个视图（`/`、`/accounts`、`/routing`），与 `panel.ts` 的路由一致。
 */
export interface MountOptions {
  /** 首次 `GET /api/events` 的状态码（默认 200；401 用来测令牌失效）。*/
  eventsStatus?: number;
  /** 首次 `GET /api/settings` 返回的载荷（默认 {@link settingsPayload}）。*/
  settings?: SettingsPayload;
  /** 首次 `GET /api/system` 返回的载荷（默认 {@link systemPayload}）。*/
  system?: SystemPayload;
  /** 控制面会话（聊天视图的探测对象）：默认 admin 在线；给状态码测「没有会话」。*/
  session?: { username?: string } | { status: number };
  /**
   * 首次 `GET /v1/models` 的应答（聊天视图进视图时读，默认两个模型）。
   * `defaultModel` = 非标准字段 `default_model`（生效的 config.defaultModel）。
   * `visionIds` = `architecture.input_modalities: ["text","image"]` 名单；
   * 名单里的 id 视觉可用，其余目录内 id 是 ["text"]（与服务端 handleListModels
   * 同形——模态只在 architecture 块里发，顶层不放）。
   */
  models?: { status: number; ids: string[]; defaultModel?: string; visionIds?: string[] };
  /** 不装假 IndexedDB（window.indexedDB 缺席 = 隐私模式同形）→ 附件降级内存。*/
  noIndexedDB?: boolean;
  /** `listProxies` 返回的表（页面启动时就会取一次）。*/
  proxies?: Record<string, unknown>[];
  /** `listProxies` 返回的默认出口。*/
  defaultProxy?: string;
  /** `listApiKeys` 返回的表（聊天视图的 key 下拉，进视图时取一次）。*/
  apiKeys?: Record<string, unknown>[];
  /** `getUsageStats` 返回的范围聚合（缺省是空统计）。*/
  usageStats?: Record<string, unknown>;
  /** `getUsageStats` 返回的热力图聚合（缺省是空统计）。*/
  heatmapStats?: Record<string, unknown>;
  /** 首次 `POST /api/control` 的应答（默认成功）。日志页默认落在请求事件
   * tab，进页面这一拍就会发 `getRequests`——要在挂载前就位的数据用它给。*/
  controlReply?: ControlReply;
}

function mount(path: string, state: StatePayload, options: MountOptions = {}): Harness {
  const win = new GlobalWindow({ url: LOOPBACK_ORIGIN + path });
  const reads = trackFileReads(win);
  const calls: Call[] = [];
  const node = (value: unknown): PageNode => value as PageNode;
  const maybe = (value: unknown): PageNode | null => (value ? node(value) : null);

  /* 聊天视图的数据源：模型列表与补全端点的应答。对象引用挂在 harness 上，
     用例先进视图再改 `harness.chat.status` 一类字段，驱动下一次应答。*/
  const models = options.models ?? { status: 200, ids: ["glm-5.3", "glm-5.3-flash"] };
  const visionIds = models.visionIds ?? [];
  const chat: Harness["chat"] = { status: 200 };
  const session = options.session
    ? "status" in options.session
      ? { status: options.session.status }
      : { status: 200, username: options.session.username }
    : { status: 200, username: "admin" };

  const events = createEventFeed();
  /** 整页跳转记录：`window.location.replace` 换成桩，断言「跳去哪」。*/
  const navigations: string[] = [];
  (win as unknown as { location: { replace: (target: string) => void } }).location.replace = (target: string) => {
    navigations.push(target);
  };

  /* 假定时器（见 Harness.intervals）：登记回调而不计时，用例用 `tick()` 推进。*/
  const intervals = new Map<number, () => void>();
  let intervalSeq = 0;
  const timerScope = win as unknown as {
    setInterval: (fn: () => void) => number;
    clearInterval: (id: number) => void;
  };
  timerScope.setInterval = (fn: () => void) => {
    intervalSeq += 1;
    intervals.set(intervalSeq, fn);
    return intervalSeq;
  };
  timerScope.clearInterval = (id: number) => {
    intervals.delete(Number(id));
  };

  const harness: Harness = {
    win,
    navigations,
    events,
    eventsStatus: options.eventsStatus ?? 200,
    settings: options.settings ?? settingsPayload(),
    settingsReply: { ok: true },
    calls,
    state,
    system: options.system ?? systemPayload(),
    chat,
    proxies: options.proxies ?? [],
    defaultProxy: options.defaultProxy,
    apiKeys: options.apiKeys ?? [],
    usageStats: options.usageStats ?? { ok: true, event: "usageStats", stats: usageStatsFixture() },
    heatmapStats: options.heatmapStats ?? { ok: true, event: "usageStats", stats: usageStatsFixture() },
    controlReply: options.controlReply ?? { ok: true },
    controlReplies: [],
    passwordStatus: 200,
    passwordReply: { ok: true },
    oauthStatus: { status: "pending", flowId: "flow-1" },
    credentialSources: [],
    intervals: {
      live: () => intervals.size,
      tick: () => {
        for (const callback of [...intervals.values()]) callback();
      },
    },
    role: (name: string) => maybe(win.document.querySelector(`[data-role="${name}"]`)),
    find: (selector: string) => maybe(win.document.querySelector(selector)),
    rows: (name: string) => {
      const body = win.document.querySelector(`[data-role="${name}"]`);
      return body ? (body.querySelectorAll("tr") as unknown as PageNode[]) : [];
    },
    click: (target: PageNode | null) => {
      if (!target) throw new Error("click on a missing element");
      target.click();
    },
    change: (target: PageNode | null, value: string, checked?: boolean) => {
      if (!target) throw new Error("change on a missing element");
      target.value = value;
      if (checked !== undefined) target.checked = checked;
      target.dispatchEvent(new win.Event("change"));
    },
    type: (target: PageNode | null, value: string) => {
      if (!target) throw new Error("input on a missing element");
      target.value = value;
      target.dispatchEvent(new win.Event("input"));
    },
    /** 在聊天输入框里敲一次键（Enter 发送、Shift+Enter 换行）。*/
    key: (keyName: string, keyOptions: { shiftKey?: boolean } = {}) => {
      const input = maybe(win.document.querySelector('[data-role="chat-input"]'));
      if (!input) throw new Error("no composer");
      input.dispatchEvent(new win.KeyboardEvent("keydown", { key: keyName, ...keyOptions }));
    },
    /**
     * 等一轮渲染：先等到没有在途 `FileReader`（附件是**串行**链，链长等于文件数），
     * 再让 then 链与重渲染跑完。
     *
     * 原来是固定的 15ms 睡眠，`attachFiles` 还调两次 = 30ms 预算。串行 FileReader
     * 往返的耗时随文件数与机器负载浮动（附件上限用例塞 9 个文件），全量套件下
     * GC / IO 一挤就超预算（实测 5 跑 1 红）。现在等的是
     * “真的没有待读文件”，不再是一个墙钟预算。
     */
    settle: async () => {
      let quiet = 0;
      for (let tick = 0; tick < 2000; tick++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (reads.pending() === 0) {
          quiet += 1;
          if (quiet >= 3) return;
        } else {
          quiet = 0;
        }
      }
      throw new Error("settle(): FileReader 链没有静默下来（附件处理疑似挂住）");
    },
    refresh: async () => {
      const panel = (win as unknown as { zcodePanel: { refresh(): Promise<void> } }).zcodePanel;
      await panel.refresh();
    },
    close: () => win.close(),
  };

  /* fetch 桩：`/api/state` 读当前 state，`/api/control` 记录命令并回 controlReply。*/
  (win as unknown as { fetch: unknown }).fetch = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; credentials?: string },
  ) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body: unknown = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, headers: init?.headers ?? {}, body, credentials: init?.credentials });
    if (url === "/api/state") return { ok: true, status: 200, json: async () => harness.state };
    if (url === "/api/session") {
      /* GET 回当前登录的人（聊天视图的会话探测也走这条）；DELETE 是登出，回 ok 后
         页面自己跳登录页。*/
      if (method === "DELETE") return { ok: true, status: 200, json: async () => ({ ok: true }) };
      if (session.status !== 200) return { ok: false, status: session.status, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: true, username: session.username ?? "admin" }) };
    }
    if (url === "/v1/models") {
      if (models.status !== 200) {
        return { ok: false, status: models.status, json: async () => ({ error: { message: "models unavailable" } }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          object: "list",
          data: models.ids.map((id) => ({
            id,
            // 模态数组在 OpenRouter 风格的 architecture 块
            // （与服务端 handleListModels 同形）；visionIds 名单视觉可用，其余文本。
            ...(visionIds.includes(id)
              ? { architecture: { input_modalities: ["text", "image"] } }
              : { architecture: { input_modalities: ["text"] } }),
          })),
          /* 服务端广告 defaultModel 时前端把空值选项标成「默认（id）」。
             字段不在（未配置）时保持缺席，前端退回原文案 —— 与真服务端同形。 */
          ...(models.defaultModel ? { default_model: models.defaultModel } : {}),
        }),
      };
    }
    if (url === "/v1/chat/completions") {
      if (chat.status !== 200) {
        return { ok: false, status: chat.status, json: async () => ({ error: { message: chat.error ?? "upstream said no" } }) };
      }
      if (init?.signal && chat.abort) init.signal.addEventListener("abort", chat.abort);
      return { ok: true, status: 200, body: chat.body ?? null };
    }
    if (url === "/api/password") {
      if (method === "POST") {
        return { ok: true, status: harness.passwordStatus, json: async () => harness.passwordReply };
      }
    }
    if (url === "/api/system") return { ok: true, status: 200, json: async () => harness.system };
    if (url === "/api/oauth-status") return { ok: true, status: 200, json: async () => harness.oauthStatus };
    if (url === "/api/credential-sources") {
      return { ok: true, status: 200, json: async () => ({ sources: harness.credentialSources }) };
    }
    if (url === "/api/settings") {
      if (method === "POST") {
        const reply = harness.settingsReply;
        return {
          ok: true,
          status: reply.ok ? 200 : reply.error === "confirmation_required" ? 400 : 503,
          json: async () =>
            reply.ok
              ? { ok: true, settings: harness.settings, reloaded: reply.reloaded ?? [], restartRequired: reply.restartRequired ?? [] }
              : reply,
        };
      }
      return { ok: true, status: 200, json: async () => harness.settings };
    }
    if (url === "/api/events") {
      const status = harness.eventsStatus;
      return { ok: status === 200, status, body: status === 200 ? events.open() : null };
    }
    if ((body as { cmd?: string } | undefined)?.cmd === "listProxies") {
      /* 代理表是页面启动就会取一次的只读命令，答案直接来自挂载参数，不占应答队列
         （否则每个用例都得多排一条）。*/
      const reply: ControlReply = {
        ok: true,
        event: "proxies",
        proxies: harness.proxies,
        ...(harness.defaultProxy ? { defaultProxy: harness.defaultProxy } : {}),
      };
      return { ok: true, status: 200, json: async () => reply };
    }
    if ((body as { cmd?: string } | undefined)?.cmd === "listApiKeys") {
      /* key 表同理：聊天视图进视图取一次的只读命令，直接回挂载参数。*/
      const reply: ControlReply = { ok: true, event: "apiKeys", apiKeys: harness.apiKeys };
      return { ok: true, status: 200, json: async () => reply };
    }
    if ((body as { cmd?: string } | undefined)?.cmd === "getUsageStats") {
      /* 用量统计同理：概览与统计页的报表数据，直接回挂载参数（不占应答
         队列——同一次加载会发两条命令，按 from 区分：回看超过 300 天的是热力图）。*/
      const from = (body as { from?: number }).from;
      const isHeatmap = typeof from === "number" && Date.now() - from > 300 * 86_400_000;
      return { ok: true, status: 200, json: async () => (isHeatmap ? harness.heatmapStats : harness.usageStats) };
    }
    const reply = harness.controlReplies.length > 0 ? harness.controlReplies.shift() : harness.controlReply;
    return { ok: true, status: 200, json: async () => reply };
  };

  /* 语言固定中文：断言里的文案是术语表的中文那一列（happy-dom 默认 en-US）。*/
  win.localStorage.setItem("i18n_lang", "zh");
  /* 附件的图片存储。happy-dom 沒有 IndexedDB；装上假实现后走真实 idb 路径，
     noIndexedDB 的用例不装（window.indexedDB 缺席），覆盖内存降级路径。 */
  if (!options.noIndexedDB) installFakeIndexedDB(win);
  win.document.write(renderPanelPage());
  /* 运行时是一串 IIFE（`page.ts` 按依赖顺序拼接）：在 window 作用域里跑一次，
     等价于浏览器执行那段内联 `<script>`。*/
  new Function("window", "document", PAGE_APP_SCRIPT)(win, win.document);

  harnesses.push(harness);
  return harness;
}

/** 已渲染完一轮的页面。*/
export async function mountSettled(path: string, state: StatePayload, options: MountOptions = {}): Promise<Harness> {
  const harness = mount(path, state, options);
  await harness.settle();
  return harness;
}

/**
 * 只有**写**命令（去掉轮询的 `/api/state`、扫描请求与只读的 `listProxies`）。
 *
 * `listProxies` 是页面启动时取一次的表（账号页的代理列 + 概览的分组 + 出口代理抽屉都用它）。
 * 它是只读的，用例断言的是「用户点了一下发出去什么」，所以这里滤掉它；
 * 出口代理抽屉的用例用 {@link controlBodies} 看全部控制命令。
 */
export function commands(harness: Harness): Call[] {
  return harness.calls.filter(
    (call) =>
      call.url === "/api/control" && (call.body as { cmd?: string } | null)?.cmd !== "listProxies",
  );
}

/** 全部控制命令的请求体（连只读的一起，给出口代理抽屉的用例用）。*/
export function controlBodies(harness: Harness): unknown[] {
  return harness.calls.filter((call) => call.url === "/api/control").map((call) => call.body);
}

/** 选择器的全部匹配（happy-dom 返回 NodeList，不是数组，这里统一成数组）。*/
export function nodes(parent: PageNode | null | undefined, selector: string): PageNode[] {
  return parent ? [...parent.querySelectorAll(selector)] : [];
}

/** 表格某一行的第 `index` 个单元格（0 基）。*/
export function cell(row: PageNode | undefined, index: number): PageNode | undefined {
  return row ? nodes(row, "td")[index] : undefined;
}

/**
 * 点第一行打开详情大窗。
 *
 * 打开是同步的（视图自己重画窗体），返回窗体；断言与旧行内展开共用的
 * `.detail__*` / `.plan-card` 结构都在里面。
 */
export function openDetail(harness: Harness): PageNode {
  harness.click(harness.rows("page-accounts-body")[0] as PageNode);
  const body = harness.role("account-dialog-body");
  if (!body) throw new Error("dialog body missing");
  return body;
}

/** 行尾菜单的两个入口：⋯ 按钮与菜单项。*/
export function menuButton(row: PageNode): PageNode {
  return row.querySelector("[data-menu-button]") as PageNode;
}

/** 进聊天视图并等首拍（会话探测 + 模型列表）完成。*/
export async function mountChat(state: StatePayload, options: MountOptions = {}): Promise<Harness> {
  const harness = await mountSettled("/", state, options);
  harness.click(harness.find('[data-nav="chat"]'));
  await harness.settle();
  return harness;
}

/** 对话区里的消息正文（`.chat__body`）。*/
export function replies(harness: Harness): PageNode[] {
  const log = harness.role("chat-log");
  return log ? log.querySelectorAll(".chat__body") : [];
}

/** 只有发往补全端点的请求。*/
export function completions(harness: Harness): Call[] {
  return harness.calls.filter((call) => call.url === "/v1/chat/completions");
}

/**
 * 等一个条件成立（轮询 + 上限），失败时把“等什么”写进错误。
 *
 * 用于等页面自己的定时器 / 异步链推动的状态（短暂提示到点收起、高亮到点摘掉）。
 * 用固定 `setTimeout(120)` 赌定时器已触发，在全量套件的 GC/IO 压力下是概率性的
 * （同一条原则：等条件，不等预算）。
 */
export async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 一帧 OpenAI 风格的 SSE 增量。*/
export function frame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

/**
 * 在途 `FileReader` 计数器。
 *
 * 附件处理是**串行**的：`onFilesPicked` 把文件逐个 `.then` 起来，每次
 * `attachTextFile` 都 `await readFileAsText`，而 `readAsText` 的 load 事件是一个
 * 真实宏任务。用例原来用固定 15ms 睡眠等这条链，链长随文件数增长（上限用例塞
 * 9 个文件，串行 8 次真实读取）——全量套件下 GC/IO 一挤就超预算，变成概率性
 * 失败。计数在途读取后，`settle()` 能等到"没有待读的文件"，而不是等一个墙钟预算。
 *
 * 只在测试的 window 上换构造器：页面脚本用的是 `new window.FileReader()`，
 * 换掉 `win.FileReader` 就换掉了它看到的那个类。
 */
function trackFileReads(win: GlobalWindow): { pending(): number } {
  type ReadableFileReader = {
    addEventListener(type: string, listener: () => void): void;
    readAsText(file: unknown, encoding?: string): void;
    readAsArrayBuffer(file: unknown): void;
    readAsDataURL(file: unknown): void;
  };
  const Base = win.FileReader as unknown as new () => ReadableFileReader;
  let pending = 0;
  class TrackingFileReader extends Base {
    constructor() {
      super();
      /* load / error / abort 三选一结束一次读取；happy-dom 派发的是 load，
         真实浏览器错误时派发 error。abort 一并兜住，否则取消一次就永久计数。*/
      const settled = (): void => {
        pending = Math.max(0, pending - 1);
      };
      this.addEventListener("load", settled);
      this.addEventListener("error", settled);
      this.addEventListener("abort", settled);
    }

    readAsText(file: unknown, encoding?: string): void {
      pending += 1;
      super.readAsText(file, encoding);
    }

    readAsArrayBuffer(file: unknown): void {
      pending += 1;
      super.readAsArrayBuffer(file);
    }

    readAsDataURL(file: unknown): void {
      pending += 1;
      super.readAsDataURL(file);
    }
  }
  (win as unknown as { FileReader: unknown }).FileReader = TrackingFileReader;
  return { pending: () => pending };
}

/* ---- 附件的脚手架 --------------------------------------------------------- */

/**
 * 极小的 IndexedDB 假实现（happy-dom 没带 IndexedDB）。
 *
 * 只实现 app-chat-attachments.js 实际用到的最小接口：open + onupgradeneeded
 * 建仓、put/get/delete/getAllKeys，request 事件同步派发（本模块每个操作都是
 * 一条独立事务，per-request promise 就够了，不需要 transaction.oncomplete）。
 * 数据存进一个模块级 Map，同一测试文件里的多个 window 共享——持久层语义与
 * 真浏览器一致（同源同库），用例之间不需要隔离：每个用例用自己的库名无法做到
 * （库名是常量），改成在 beforeEach 清空。
 */
interface FakeDb {
  store: Map<string, Blob>;
}

export const fakeDb: FakeDb = { store: new Map() };

function installFakeIndexedDB(win: GlobalWindow): void {
  type RequestLike = {
    result?: unknown;
    error?: unknown;
    onsuccess: ((event?: unknown) => void) | null;
    onerror: ((event?: unknown) => void) | null;
    onupgradeneeded: ((event?: unknown) => void) | null;
  };
  /** open 是异步事件（真实 IDB 在任务队列里派发）：微任务里再触发，调用方
   * 才来得及先挂 onsuccess / onupgradeneeded。put/get 等单步操作保持同步。 */
  const doneOpen = (request: RequestLike, result: unknown): void => {
    request.result = result;
    queueMicrotask(() => {
      if (request.onsuccess) request.onsuccess();
    });
  };
  const failOpen = (request: RequestLike, error: unknown): void => {
    request.error = error;
    queueMicrotask(() => {
      if (request.onerror) request.onerror();
    });
  };
  (win as unknown as { indexedDB: unknown }).indexedDB = {
    open(name: string, version?: number): RequestLike {
      const request: RequestLike = { onsuccess: null, onerror: null, onupgradeneeded: null };
      if (name !== "zcode-proxy-chat") {
        failOpen(request, new Error("unknown db"));
        return request;
      }
      void version;
      doneOpen(request, {
        objectStoreNames: { contains: () => true },
        transaction: () => ({
          objectStore: () => ({
            put(value: Blob, key: string): RequestLike {
              const put: RequestLike = { onsuccess: null, onerror: null, onupgradeneeded: null };
              fakeDb.store.set(key, value);
              doneOpen(put, key);
              return put;
            },
            get(key: string): RequestLike {
              const get: RequestLike = { onsuccess: null, onerror: null, onupgradeneeded: null };
              doneOpen(get, fakeDb.store.get(key));
              return get;
            },
            delete(key: string): RequestLike {
              const del: RequestLike = { onsuccess: null, onerror: null, onupgradeneeded: null };
              fakeDb.store.delete(key);
              doneOpen(del, undefined);
              return del;
            },
            getAllKeys(): RequestLike {
              const all: RequestLike = { onsuccess: null, onerror: null, onupgradeneeded: null };
              doneOpen(all, [...fakeDb.store.keys()]);
              return all;
            },
          }),
        }),
      });
      return request;
    },
  };
}

/** 造一个图片 File（默认 PNG 类型；PNG 魔数前缀让 data URL 形状真实）。
 *  返回 happy-dom 的 File 实例（DOM lib 的 File 与它不兼容，只能这里窄化一次）。*/
export type WinFile = InstanceType<GlobalWindow["File"]>;

/** 把一批文件塞进聊天附件入口并触发 change（happy-dom 支持 files 赋值）。*/
export async function attachFiles(harness: Harness, files: WinFile[]): Promise<void> {
  const input = harness.role("chat-file-input");
  if (!input) throw new Error("no chat-file-input");
  const dt = new harness.win.DataTransfer();
  for (const file of files) dt.items.add(file);
  (input as unknown as { files: unknown }).files = dt.files;
  input.dispatchEvent(new harness.win.Event("change"));
  /* 一次 `settle()` 就够：它等的是「没有在途 FileReader 再静默三个宏任务」，
     串行链多长都能等到（以前是固定 15ms × 2）。*/
  await harness.settle();
}

/* ------------------------------------------------------------------------- */
/* 日志页 · 请求事件 tab                                                        */
/* ------------------------------------------------------------------------- */

/**
 * 一条 `RequestRecord`。形状与 `src/proxy/request-record.ts` 一致；测试里
 * 只填渲染会用到的字段，其余按记录的可选性省略。
 */
export interface RequestRecordFixture {
  reqId: string;
  startedAt: number;
  format: string;
  model: string;
  stream: boolean;
  requestBytes: number;
  retries: number;
  stages: Array<{ stage: string; atMs: number; fields: Record<string, unknown> }>;
  apiKeyId: string;
  account?: string;
  route?: string;
  queueMs?: number;
  status?: number;
  ttfbMs?: number;
  totalMs?: number;
  tps?: number;
  inputTokens?: number;
  outputTokens?: number;
  upstreamUrl?: string;
  failedStage?: string;
  error?: string;
  /** 产生点落下的统一身份（日志页错误列读它取用户词 + hint）。*/
  errorCode?: string;
  /* 日志页消费的四个字段 */
  reasoningEffort?: string;
  upstreamAttempts?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  responseBytes?: number;
  clientAborted?: boolean;
}

/* ------------------------------------------------------------------------- */
/* 出口代理抽屉与账号页的代理列                                                  */
/* ------------------------------------------------------------------------- */

/** `listProxies` 的一行（控制面的 `ProxySummary`）。*/
export function proxyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "home", url: "http://127.0.0.1:7890", hasPassword: false, enabled: true, usedBy: 0, ...overrides };
}

// ---------------------------------------------------------------------------
// 抢活动：账号抽屉的 claim 区块
// ---------------------------------------------------------------------------

/** 状态载荷里的 claim 段（`/api/state` 的可选段）。*/
export function claimOverview(
  overrides: {
    enabled?: boolean;
    auto?: boolean;
    accounts?: NonNullable<StatePayload["claim"]>["accounts"];
  } = {},
): NonNullable<StatePayload["claim"]> {
  return {
    config: {
      enabled: overrides.enabled ?? true,
      auto: overrides.auto ?? true,
      origin: "https://zcode.test",
      pollIntervalMs: 300000,
      cooldownMs: 600000,
      sprintWindowMs: 1800000,
      sprintPollIntervalMs: 60000,
      policy: "upstream-priority",
      opening: {
        preheatMs: 180000,
        probeIntervalMs: 10000,
        burstIntervalMs: 2000,
        burstWindowMs: 180000,
        accountStaggerMs: 200,
        maxClaimsPerAccount: 6,
      },
    },
    accounts:
      overrides.accounts ??
      [{ label: "work-team", running: true, holdUntil: 0 }],
  };
}

/** 范围聚合命令的调用记录（统计页一拍会发两条：范围 + 热力图，按 from 区分）。*/
export function usageCalls(harness: Harness): Array<Record<string, unknown>> {
  return harness.calls
    .filter((call) => call.url === "/api/control")
    .map((call) => call.body as Record<string, unknown>)
    .filter((body) => body.cmd === "getUsageStats");
}

/** 在 `target` 上敲一次键（默认挂在 body，验证全局快捷键）。*/
export function press(
  harness: Harness,
  key: string,
  target?: PageNode | null,
  options: { ctrlKey?: boolean; metaKey?: boolean } = {},
): void {
  const node = target ?? (harness.win.document.body as unknown as PageNode);
  node.dispatchEvent(new harness.win.KeyboardEvent("keydown", { key, bubbles: true, ...options }));
}

/**
 * 每个测试文件在顶层调一次：存储目录隔离 + 关掉本文件挂过的所有页面。
 *
 * 存储目录隔离是必须的：页面驱动 `setRoutingPolicy` 会落盘，不能写进用户的真实目录。
 * `harnesses` 的清理也必须逐文件注册——bun 的 afterEach 作用域是本文件。
 */
export function installHarnessHooks(): void {
  beforeEach(() => {
    testStoreDir = mkdtempSync(join(tmpdir(), "zcode-web-store-"));
    process.env.ZCODE_PROXY_STORE_DIR = testStoreDir;
  });

  afterEach(() => {
    if (prevStoreDir === undefined) delete process.env.ZCODE_PROXY_STORE_DIR;
    else process.env.ZCODE_PROXY_STORE_DIR = prevStoreDir;
    rmSync(testStoreDir, { recursive: true, force: true });
  });

  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.close();
  });
}
