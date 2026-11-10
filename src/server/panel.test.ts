/**
 * 控制面测试：登录会话、页面鉴权、`/api/*` 的 401、以及「面板只认领自己
 * 的路径」这条挂载契约。
 *
 * 面板不再是独立监听，所以这里用 `createServer` 把 `createPanelHandler` 包一层：
 * 断言的是真实的 HTTP 语义（状态码、`Set-Cookie`、`Location`），而不是直接调函数。
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOGIN_PATH,
  createPanelHandler,
  displayHostname,
  isLoopbackAddress,
  isLoopbackHost,
  panelEntryUrl,
  printAdminPassword,
  printPanelUrl,
  resolvePanelSettings,
  type PanelHandler,
  type PanelProxyInfo,
} from "./panel.js";
import { SETTINGS_CONFIG_ENV } from "./routes-state.js";
import { startServer, type ProxyServer } from "./server.js";
import { RequestStore } from "../proxy/request-record.js";
import { loadConfig } from "../config/loader.js";
import { configureLogging, logger, resetLogging, writeRequestLine } from "../log/index.js";
import {
  OAUTH_STATUS_TTL_MS,
  createControlDispatcher,
  readOauthStatus,
  type ControlCommand,
  type ControlResponse,
  type ControlState,
} from "../control/control.js";
import { LogBuffer } from "../log/buffer.js";
import { OAuthFlowClient, type OAuthFlowStart, type OAuthFlowTokens } from "../auth/oauth.js";
import type { KeyResolver } from "../auth/resolver.js";
import { inMemoryAccounts } from "../accounts/testing.js";
import { UserManager } from "../users/manager.js";
import { SessionStore, SESSION_COOKIE } from "../users/session.js";
import { emptyUsersFile } from "../users/types.js";
import type { UsersStore } from "../users/store.js";
import type { ProxyConfig } from "../config/types.js";

const ADMIN = "admin";
const ADMIN_PASSWORD = "TestPassword123";

/** 内存用户仓：登录逻辑与文件格式是两件事，这里只测前者。*/
function memoryUsers(): UsersStore {
  let file = emptyUsersFile();
  return {
    load: async () => file,
    save: async (next) => {
      file = next;
    },
  };
}

/** 面板默认看到的代理地址（`getProxyInfo` 的注入点；面板挂在代理的监听上，所以没有 `running`）。*/
const PROXY_INFO: PanelProxyInfo = {
  address: "127.0.0.1:8080",
};

/** 一份最小 `ProxyConfig`（`resolvePanelSettings` 只读 `server` 与 `panel`）。*/
function configWith(panel: { enabled?: boolean; host?: string } | undefined, host = "0.0.0.0"): ProxyConfig {
  const base = {
    server: { port: 8080, host },
    auth: { requireKey: false },
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-5.3",
    models: ["glm-5.3"],
    identity: { appVersion: "3.17.1", appVersionSource: "default", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai", betaPolicy: "drop" as const, betaAllowlist: [] },
    clientIdentity: { mode: "enforce" as const, ttlSeconds: 900, maxSessions: 1024 },
    responses: { storeMaxEntries: 1000, storeTtlMs: 86400000 },
    mcp: { enabled: true, gateway: { enabled: true, origin: "https://zcode.z.ai" } },
    async: { enabled: false },
    claim: { enabled: true, auto: true },
    accounts: { routing: {}, stickiness: {}, quota: {}, risk: {}, entries: [] },
    logging: { level: "info" as const },
    endpointRouting: { enabled: true, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: true },
    highspeed: { enabled: true, origin: "https://zcode.z.ai", models: [] },
  } as unknown as ProxyConfig;
  if (panel !== undefined) {
    base.panel = { enabled: panel.enabled ?? true, host: panel.host ?? "" };
  }
  return base;
}

/* ------------------------------------------------------------------------- */
/* 测试脚手架                                                                  */
/* ------------------------------------------------------------------------- */

interface PanelHarness {
  url: string;
  sessions: SessionStore;
  users: UserManager;
  /** 控制面状态（用例直接改 `oauthStatus` 模拟过期一类的时间）。*/
  state: ControlState;
  close(): Promise<void>;
  /** 登录并回 `set-cookie` 的值（`session=…`）。*/
  login(username?: string, password?: string): Promise<string>;
}

/**
 * 假登录客户端：`start` 立刻回授权地址与 flowId，`complete` 挂在 `succeed` / `fail` 上。
 *
 * `control.ts` 的 `finally` 会调 `close()`，所以 `finished` 就是「这一次流程真的走完
 * 了」的信号：`.then` / `.catch` 里的状态写入已经在它之前完成。
 */
class FakeLoginClient extends OAuthFlowClient {
  private readonly outcome: Promise<OAuthFlowTokens>;
  private resolveOutcome!: (tokens: OAuthFlowTokens) => void;
  private rejectOutcome!: (err: Error) => void;
  private markFinished!: () => void;
  readonly finished: Promise<void>;

  constructor(readonly flowId: string) {
    super("zai", fetch);
    this.outcome = new Promise<OAuthFlowTokens>((resolve, reject) => {
      this.resolveOutcome = resolve;
      this.rejectOutcome = reject;
    });
    this.finished = new Promise<void>((resolve) => {
      this.markFinished = resolve;
    });
  }

  start(): Promise<OAuthFlowStart> {
    return Promise.resolve({
      authorizeUrl: "https://zcode.z.ai/api/v1/oauth/app/login?flow=1",
      callbackUrl: "",
      state: this.flowId,
    });
  }

  complete(): Promise<OAuthFlowTokens> {
    return this.outcome;
  }

  async close(): Promise<void> {
    this.markFinished();
  }

  succeed(): void {
    this.resolveOutcome({ accessToken: "fake-access-token", userId: "user-1" });
  }

  fail(message: string): void {
    this.rejectOutcome(new Error(message));
  }
}

/**
 * 假凭据解析：真的 `KeyResolver` 要打 api.z.ai 的 biz API（登录完成后换 coding-plan
 * key），用例不能碰网络。
 */
function fakeKeyResolver(): KeyResolver {
  return {
    resolveCodingPlanCredential: async (_accessToken: string, provider: string) => ({
      // `coding-plan` 路线要求完整的 apiKey 对（`apiKey` + `secret`），少一半会被
      // `AccountManager` 判成 unusable-credential。
      apiKey: "fake-api-key",
      secret: "fake-secret",
      provider,
      userId: "user-1",
    }),
  } as unknown as KeyResolver;
}

const openPanels: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(openPanels.splice(0).map((close) => close().catch(() => {})));
});

/** 起一个只挂面板的 HTTP 监听（面板本身返回 false 的路径在这里就是 404）。*/
async function startPanel(options: {
  hostname?: string;
  configPath?: string;
  handleControl?: (cmd: ControlCommand) => Promise<ControlResponse>;
  /** 注入的登录客户端工厂（`startOAuth` 用假 client，不碰网络）。*/
  loginClient?: () => OAuthFlowClient;
  /** 注入的凭据解析（缺省的真 `KeyResolver` 会打上游）。*/
  keyResolver?: KeyResolver;
  /**
   * 注入日志缓冲（`/api/events` 的结构化日志来源）。
   *
   * 不注入时面板走 `getLogs` 命令那条老路（纯文本行），所以既有用例不受影响；
   * 注入后走的是 `serve` 的真实路径：面板直读缓冲拿条目。
   */
  logBuffer?: LogBuffer;
} = {}): Promise<PanelHarness> {
  const users = new UserManager(memoryUsers());
  await users.create(ADMIN, ADMIN_PASSWORD);
  const sessions = new SessionStore();

  /*
   * 默认用真的 dispatcher（空账号仓）：`/api/state` 一次要问四条命令
   * （status / listAccounts / getRoutingPolicy / getRiskReport），拿桩函数假装
   * 会漏掉「状态读取失败」与「命令失败」这两条完全不同的路径。
   */
  const { manager, broker } = inMemoryAccounts([]);
  const state: ControlState = { proxyPort: 8080 };
  const logBuffer = options.logBuffer ?? new LogBuffer();
  const dispatcher = createControlDispatcher(state, {
    logBuffer,
    accounts: manager,
    broker,
    ...(options.loginClient ? { createLoginClient: options.loginClient } : {}),
    ...(options.keyResolver ? { keyResolver: options.keyResolver } : {}),
  });
  const handleControl = options.handleControl ?? ((cmd: ControlCommand) => dispatcher(cmd));

  const handler: PanelHandler = createPanelHandler({
    hostname: options.hostname ?? "127.0.0.1",
    getPort: () => 8080,
    handleControl,
    getProxyInfo: () => PROXY_INFO,
    users,
    sessions,
    getOauthStatus: () => readOauthStatus(state),
    ...(options.logBuffer ? { logBuffer: options.logBuffer } : {}),
    /* serve 注入的那条配置路径（位置参数启动）。不传时面板回到
       env / 默认值，既有用例不受影响。 */
    ...(options.configPath ? { configPath: options.configPath } : {}),
  });

  const server: Server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (handled) return;
      // 面板不认领的路径：真实部署里交给代理，这里用 404 表示「没被面板处理」。
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ handled: false }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
  };
  openPanels.push(close);

  const harness: PanelHarness = {
    url,
    sessions,
    users,
    state,
    close,
    login: async (username = ADMIN, password = ADMIN_PASSWORD) => {
      const response = await fetch(`${url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      expect(response.status).toBe(200);
      const cookie = response.headers.get("set-cookie") ?? "";
      expect(cookie).toContain(`${SESSION_COOKIE}=`);
      // 只留 `name=value`，属性部分不参与回传。
      return cookie.split(";")[0] as string;
    },
  };
  return harness;
}

/** 带 Cookie 的 GET。*/
function getWith(url: string, cookie?: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (cookie) headers.cookie = cookie;
  return fetch(url, { ...init, headers, redirect: "manual" });
}

/** 带 Cookie 的 POST JSON。*/
function postWith(url: string, cookie: string | undefined, body: unknown, method = "POST"): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return fetch(url, { method, headers, body: JSON.stringify(body), redirect: "manual" });
}

/* ------------------------------------------------------------------------- */
/* 配置解析                                                                    */
/* ------------------------------------------------------------------------- */

describe("resolvePanelSettings", () => {
  it("is on by default and follows server.host when panel.host is empty", () => {
    expect(resolvePanelSettings(configWith({ host: "" }, "0.0.0.0"))).toEqual({ host: "0.0.0.0" });
    expect(resolvePanelSettings(configWith({ host: "" }, "127.0.0.1"))).toEqual({ host: "127.0.0.1" });
  });

  it("keeps an explicit panel.host, trimmed", () => {
    expect(resolvePanelSettings(configWith({ host: " 127.0.0.1 " }, "0.0.0.0"))).toEqual({ host: "127.0.0.1" });
  });

  it("returns null for panel.enabled: false and for --no-panel", () => {
    expect(resolvePanelSettings(configWith({ enabled: false }))).toBeNull();
    expect(resolvePanelSettings(configWith({ enabled: true }), { disabled: true })).toBeNull();
  });

  it("treats a config without a panel section as the default (on, follow server.host)", () => {
    expect(resolvePanelSettings(configWith(undefined, "0.0.0.0"))).toEqual({ host: "0.0.0.0" });
  });
});

describe("panel address helpers", () => {
  it("prints a loopback address even for a wildcard bind, with no token", () => {
    expect(panelEntryUrl("0.0.0.0", 8080)).toBe("http://127.0.0.1:8080/");
    expect(panelEntryUrl("127.0.0.1", 8080)).toBe("http://127.0.0.1:8080/");
    expect(displayHostname("::")).toBe("127.0.0.1");
  });

  it("prints the panel address to the terminal, never through console.log", () => {
    const printed: string[] = [];
    printPanelUrl({ hostname: "127.0.0.1", port: 8080, write: (text) => printed.push(text) });
    expect(printed.join("")).toBe("panel: http://127.0.0.1:8080/\n");
  });

  it("prints the first-start admin password exactly once, in the documented shape", () => {
    const printed: string[] = [];
    printAdminPassword("Xk9mP2vL8nQ4wR7t", (text) => printed.push(text));
    expect(printed.join("")).toBe(
      "panel: admin password (shown once, change it in Settings):\n        Xk9mP2vL8nQ4wR7t\n",
    );
  });
});

/* ------------------------------------------------------------------------- */
/* 登录与会话                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * 侧边栏的每一条路径（`page.html` 的 `data-view` 与 `panel.ts` 的 `PAGE_PATHS` 同口径）。
 *
 * 「未登录必须 302」与「登录后必须 200」两条断言共用它：两条清单各写一份时漏过
 * 两回（一侧漏掉 `/proxies`，另一侧漏掉新页）。两处共用一份就不再有可能
 * “新加一页只补了一边”。
 *
 * `/proxies` 已从两处一起删掉：代理没有独立页（管理面是账号页的抽屉），`panel.ts` 的
 * `PAGE_PATHS` 也不认这条路径，所以两条循环随之少一条。
 */
const SIDEBAR_PATHS = ["/", "/accounts", "/routing", "/keys", "/logs", "/settings", "/stats"] as const;

describe("page auth", () => {
  it("redirects every page route to /login without a session", async () => {
    const panel = await startPanel();
    /* `/panel` 也由面板认领，所以一并覆盖；其余路径用侧边栏那份清单。*/
    for (const path of ["/panel", ...SIDEBAR_PATHS]) {
      const response = await getWith(`${panel.url}${path}`);
      expect([path, response.status]).toEqual([path, 302]);
      expect([path, response.headers.get("location")]).toEqual([path, LOGIN_PATH]);
    }
  });

  it("serves the login page without a session", async () => {
    const panel = await startPanel();
    const response = await getWith(`${panel.url}/login`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain('data-role="login-form"');
    expect(html).toContain('data-role="login-username"');
    expect(html).toContain('data-role="login-password"');
  });

  it("renders the shell once logged in, and sends a logged-in visitor away from /login", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();

    const page = await getWith(`${panel.url}/accounts`, cookie);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-view="accounts"');

    const login = await getWith(`${panel.url}/login`, cookie);
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/");
  });

  it("keeps the account controls reachable on the settings page", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();

    const page = await getWith(`${panel.url}/settings`, cookie);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('data-view="settings"');
    expect(html).toContain('data-role="account-username"');
    expect(html).toContain('data-action="account-save-password"');
  });

  it("serves the panel shell at every sidebar path", async () => {
    // 侧边栏里的每一条都必须有服务端路由。漏一条时页面会 404，而导航还在 —— 用户
    // 点进去只有空白，很难从代码里看出来（加 /proxies 那页时就漏过一次白名单）。
    const panel = await startPanel();
    const cookie = await panel.login();
    for (const path of SIDEBAR_PATHS) {
      const page = await getWith(`${panel.url}${path}`, cookie);
      expect([path, page.status]).toEqual([path, 200]);
    }
  });

  it("leaves every retired page path to the proxy routes", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();

    // `/chat` 是面板里的视图但没有独立页；`/proxies` 并进了账号页的抽屉；
    // `/account` 并进了设置页的「账户」组。三条都不由面板认领：请求落到代理
    // 路由（这里的桩回 404 表示「没被面板处理」），不为已删页面留壳。
    for (const path of ["/chat", "/proxies", "/account"]) {
      const response = await getWith(`${panel.url}${path}`, cookie);
      expect([path, response.status]).toEqual([path, 404]);
      expect(await response.json()).toEqual({ handled: false });
    }
  });

  it("retires /chat: the panel no longer claims it, and /api/system carries no chat address", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();

    // 聊天是面板侧边栏的一个视图，独立页不存在：面板不认领
    // 这条路径，请求落到代理路由（这里的桩回 404 表示「没被面板处理」）。
    const response = await getWith(`${panel.url}/chat`, cookie);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ handled: false });

    // 代理侧的地址字段恰好只剩 address：旧聊天入口字段不能留在 /api/system 里。
    const system = (await (await getWith(`${panel.url}/api/system`, cookie)).json()) as {
      proxy: Record<string, unknown>;
    };
    expect(Object.keys(system.proxy).sort()).toEqual(["address"]);
    expect(system.proxy.address).toBe("127.0.0.1:8080");
  });

  it("answers the liveness probe without a session", async () => {
    const panel = await startPanel();
    const response = await getWith(`${panel.url}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "zcode-panel" });
  });
});

describe("POST /api/session", () => {
  it("rejects a wrong password with 401 and no cookie", async () => {
    const panel = await startPanel();
    const response = await postWith(`${panel.url}/api/session`, undefined, {
      username: ADMIN,
      password: "not-the-password",
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({ ok: false, error: "invalid_credentials" });
    expect(panel.sessions.size).toBe(0);
  });

  it("gives the same answer for an unknown user as for a wrong password", async () => {
    const panel = await startPanel();
    const unknown = await postWith(`${panel.url}/api/session`, undefined, {
      username: "nobody",
      password: ADMIN_PASSWORD,
    });
    const wrong = await postWith(`${panel.url}/api/session`, undefined, {
      username: ADMIN,
      password: "nope-nope",
    });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
  });

  it("sets an HttpOnly, SameSite=Strict cookie on success, and that cookie opens /api/state", async () => {
    const panel = await startPanel();
    const response = await postWith(`${panel.url}/api/session`, undefined, {
      username: ADMIN,
      password: ADMIN_PASSWORD,
    });
    expect(response.status).toBe(200);
    const raw = response.headers.get("set-cookie") ?? "";
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Strict");
    expect(raw).toContain("Path=/");
    // 不加 Secure：面板默认跑在 http 上，加了浏览器就不会回传。
    expect(raw).not.toContain("Secure");
    const token = raw.split(";")[0] ?? "";
    expect(token.startsWith(`${SESSION_COOKIE}=zcp_sess_`)).toBe(true);

    const state = await getWith(`${panel.url}/api/state`, token);
    expect(state.status).toBe(200);
  });

  it("answers GET with the current user and 401 without a session", async () => {
    const panel = await startPanel();
    const anonymous = await getWith(`${panel.url}/api/session`);
    expect(anonymous.status).toBe(401);

    const cookie = await panel.login();
    const current = await getWith(`${panel.url}/api/session`, cookie);
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({ ok: true, username: ADMIN });
  });

  it("rejects malformed bodies and oversized ones", async () => {
    const panel = await startPanel();
    const malformed = await fetch(`${panel.url}/api/session`, { method: "POST", body: "{" });
    expect(malformed.status).toBe(400);

    const huge = await fetch(`${panel.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: ADMIN, password: "x".repeat(70 * 1024) }),
    });
    expect(huge.status).toBe(413);
  });

  it("answers 405 for methods it does not implement", async () => {
    const panel = await startPanel();
    const response = await fetch(`${panel.url}/api/session`, { method: "PUT" });
    expect(response.status).toBe(405);
  });
});

describe("DELETE /api/session", () => {
  it("clears the cookie and invalidates the session", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();
    expect(panel.sessions.size).toBe(1);

    const response = await getWith(`${panel.url}/api/session`, cookie, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(panel.sessions.size).toBe(0);

    const state = await getWith(`${panel.url}/api/state`, cookie);
    expect(state.status).toBe(401);
    const page = await getWith(`${panel.url}/`, cookie);
    expect(page.status).toBe(302);
  });
});

/* ------------------------------------------------------------------------- */
/* /api/* 的鉴权面                                                             */
/* ------------------------------------------------------------------------- */

describe("panel /api requires a session", () => {
  it("answers 401 on every authenticated route without a cookie", async () => {
    const panel = await startPanel();
    for (const path of ["/api/state", "/api/system", "/api/settings", "/api/credential-sources", "/api/events", "/api/oauth-status"]) {
      const response = await getWith(`${panel.url}${path}`);
      expect([path, response.status]).toEqual([path, 401]);
    }
    const control = await postWith(`${panel.url}/api/control`, undefined, { cmd: "status" });
    expect(control.status).toBe(401);
  });

  it("answers 404 for an unknown /api path once authenticated", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();
    const response = await getWith(`${panel.url}/api/nope`, cookie);
    expect(response.status).toBe(404);
  });
});

describe("panel /api/control", () => {
  it("dispatches a real command in process and returns its envelope verbatim", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();
    const response = await postWith(`${panel.url}/api/control`, cookie, { cmd: "status" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      state: "running",
      accounts: 0,
      proxyPort: 8080,
      loggedIn: false,
    });
  });

  it("keeps a failed command as 200 + ok:false", async () => {
    const panel = await startPanel({
      handleControl: async () => ({ ok: false, error: "unsupported_in_test" }),
    });
    const cookie = await panel.login();
    const response = await postWith(`${panel.url}/api/control`, cookie, { cmd: "checkUpdate" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, error: "unsupported_in_test" });
  });

  it("rejects a non-command payload before dispatch", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();
    const response = await postWith(`${panel.url}/api/control`, cookie, { nope: true });
    expect(response.status).toBe(400);
  });

  /**
   * `/api/control` 的请求体上限单独一档。
   *
   * 导入命令带的是**用户选中的文件内容**（`importAccount.content`），几十个账号的
   * 导出包就可能过 64KB；而登录 / 改密码 / 设置补丁仍只收小文档。这里钉住两件事：
   * 过 64KB 的控制命令能到 dispatcher，超 512KB 仍是 413。
   */
  it("accepts a large import payload but still caps the body", async () => {
    const seen: string[] = [];
    const panel = await startPanel({
      handleControl: async (cmd) => {
        seen.push(cmd.cmd);
        return { ok: true, event: "accountsImported", imported: 0, labels: [] };
      },
    });
    const cookie = await panel.login();

    const content = "x".repeat(100 * 1024);
    const ok = await postWith(`${panel.url}/api/control`, cookie, { cmd: "importAccount", content });
    expect(ok.status).toBe(200);
    expect(seen).toEqual(["importAccount"]);

    const tooBig = await postWith(`${panel.url}/api/control`, cookie, {
      cmd: "importAccount",
      content: "x".repeat(600 * 1024),
    });
    expect(tooBig.status).toBe(413);
  });

  it("runs a real dispatcher end to end (no second listener)", async () => {
    const { manager, broker } = inMemoryAccounts([]);
    const state: ControlState = { proxyPort: 8080 };
    const dispatcher = createControlDispatcher(state, {
      logBuffer: new LogBuffer(),
      accounts: manager,
      broker,
    });
    const panel = await startPanel({ handleControl: (cmd) => dispatcher(cmd) });
    const cookie = await panel.login();
    const response = await postWith(`${panel.url}/api/control`, cookie, { cmd: "status" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("panel /api/state", () => {
  it("returns the dispatcher's payload to an authenticated caller", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();
    const response = await getWith(`${panel.url}/api/state`, cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { server: { version: string } };
    expect(typeof body.server.version).toBe("string");
  });

  it("answers GET only", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();
    const response = await postWith(`${panel.url}/api/state`, cookie, {});
    expect(response.status).toBe(405);
  });
});

describe("panel /api/system", () => {
  it("reports the panel address and the injected proxy info, with no token field", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();
    const response = await getWith(`${panel.url}/api/system`, cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.panelAddress).toBe("127.0.0.1:8080");
    expect(body.proxy).toEqual(PROXY_INFO);
    expect(body.tokenSource).toBeUndefined();
    expect(typeof body.version).toBe("string");
  });
});

describe("panel /api/oauth-status", () => {
  /** 起一条流程：登录 → `startOAuth` → 返回 `startOAuth` 的应答体。*/
  async function startFlow(
    panel: PanelHarness,
    cookie: string,
    provider: "zai" | "bigmodel" = "zai",
  ): Promise<Record<string, unknown>> {
    const response = await postWith(`${panel.url}/api/control`, cookie, { cmd: "startOAuth", provider });
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  async function readStatus(panel: PanelHarness, cookie: string): Promise<Record<string, unknown>> {
    const response = await getWith(`${panel.url}/api/oauth-status`, cookie);
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  it("answers idle when no flow has started yet", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();
    expect(await readStatus(panel, cookie)).toEqual({ status: "idle" });
  });

  it("answers pending with the flowId that startOAuth returned", async () => {
    const client = new FakeLoginClient("flow-pending");
    const panel = await startPanel({ loginClient: () => client });
    const cookie = await panel.login();

    const started = await startFlow(panel, cookie);
    expect(started.ok).toBe(true);
    expect(started.event).toBe("oauthUrl");
    expect(started.flowId).toBe("flow-pending");

    expect(await readStatus(panel, cookie)).toEqual({ status: "pending", flowId: "flow-pending" });
  });

  it("answers ready with the new account's label once the flow completes", async () => {
    const client = new FakeLoginClient("flow-ready");
    const panel = await startPanel({ loginClient: () => client, keyResolver: fakeKeyResolver() });
    const cookie = await panel.login();
    await startFlow(panel, cookie);

    client.succeed();
    await client.finished;

    expect(await readStatus(panel, cookie)).toEqual({
      status: "ready",
      flowId: "flow-ready",
      accountLabel: "zai",
    });
  });

  it("answers failed with the reason when the flow rejects", async () => {
    const client = new FakeLoginClient("flow-failed");
    const panel = await startPanel({ loginClient: () => client });
    const cookie = await panel.login();
    await startFlow(panel, cookie);

    client.fail("Authorization timed out. Please retry login.");
    await client.finished;

    expect(await readStatus(panel, cookie)).toEqual({
      status: "failed",
      flowId: "flow-failed",
      error: "Authorization timed out. Please retry login.",
    });
  });

  it("falls back to idle once the status is older than the TTL", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();
    const stale = Date.now() - OAUTH_STATUS_TTL_MS - 1;
    panel.state.oauthStatus = {
      flowId: "flow-stale",
      phase: "ready",
      accountLabel: "zai",
      startedAt: stale,
      updatedAt: stale,
    };

    expect(await readStatus(panel, cookie)).toEqual({ status: "idle" });
  });

  it("keeps showing the newest flow when a superseded one fails late", async () => {
    const first = new FakeLoginClient("flow-first");
    const second = new FakeLoginClient("flow-second");
    const clients = [first, second];
    let next = 0;
    const panel = await startPanel({ loginClient: () => clients[next++] });
    const cookie = await panel.login();

    await startFlow(panel, cookie);
    expect(await startFlow(panel, cookie)).toMatchObject({ flowId: "flow-second" });

    // 被顶掉的第一次流程以失败收场：那条迟到的 `failed` 不能盖掉第二次的 `pending`。
    first.fail("flow was superseded");
    await first.finished;

    expect(await readStatus(panel, cookie)).toEqual({ status: "pending", flowId: "flow-second" });
  });

  it("answers GET only", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();
    const response = await postWith(`${panel.url}/api/oauth-status`, cookie, {});
    expect(response.status).toBe(405);
  });
});

describe("panel /api/settings", () => {
  /** 一个临时配置目录：设置写入会改文件，绝不能碰仓库里的 config.yaml。*/
  function tempConfig(): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "zcode-panel-config-"));
    const path = join(dir, "config.yaml");
    writeFileSync(path, 'server:\n  port: 8080\n  host: "127.0.0.1"\ndefaultModel: glm-5.3\n', "utf8");
    const previous = process.env[SETTINGS_CONFIG_ENV];
    process.env[SETTINGS_CONFIG_ENV] = path;
    return {
      path,
      cleanup: () => {
        if (previous === undefined) delete process.env[SETTINGS_CONFIG_ENV];
        else process.env[SETTINGS_CONFIG_ENV] = previous;
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it("reads the snapshot and writes a patch", async () => {
    const config = tempConfig();
    try {
      const panel = await startPanel();
      const cookie = await panel.login();

      const read = await getWith(`${panel.url}/api/settings`, cookie);
      expect(read.status).toBe(200);

      const write = await postWith(`${panel.url}/api/settings`, cookie, { patch: { security: { port: 9090 } } });
      expect(write.status).toBe(200);
      const body = (await write.json()) as { ok: boolean; settings: { security: { port: number } } };
      expect(body.ok).toBe(true);
      expect(body.settings.security.port).toBe(9090);
    } finally {
      config.cleanup();
    }
  });

  it("answers a bad patch with 400 and a missing file with 503", async () => {
    const config = tempConfig();
    try {
      const panel = await startPanel();
      const cookie = await panel.login();
      const bad = await postWith(`${panel.url}/api/settings`, cookie, { patch: { security: { port: 0 } } });
      expect(bad.status).toBe(400);

      rmSync(config.path);
      const missing = await getWith(`${panel.url}/api/settings`, cookie);
      expect(missing.status).toBe(503);
    } finally {
      config.cleanup();
    }
  });

  /**
   * 以位置参数启动（`zcode-proxy my.yaml`）时，设置页必须读写
   * **那一份**，而不是 env / `config.yaml`。
   *
   * 复现路径：env 指向一份“别的”文件（在位置参数启动时那只是环境里的默认值），
   * 面板拿到 serve 注入的路径。两者都从 env 出发时 READ 会读 env 那份、WRITE 也写到
   * env 那份。
   */
  it("binds reads and writes to the injected positional config path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-panel-positional-"));
    const positional = join(dir, "my.yaml");
    const fromEnv = join(dir, "config.yaml");
    writeFileSync(positional, 'server:\n  port: 18080\n  host: "127.0.0.1"\ndefaultModel: glm-5.3\n', "utf8");
    writeFileSync(fromEnv, 'server:\n  port: 28080\n  host: "127.0.0.1"\ndefaultModel: glm-5.3\n', "utf8");
    const previous = process.env[SETTINGS_CONFIG_ENV];
    process.env[SETTINGS_CONFIG_ENV] = fromEnv;
    try {
      const panel = await startPanel({ configPath: positional });
      const cookie = await panel.login();

      const read = await getWith(`${panel.url}/api/settings`, cookie);
      expect(read.status).toBe(200);
      const snapshot = (await read.json()) as { configPath: string; security: { port: number } };
      // 设置页「配置文件 · …」那行的显示源就是这一句。
      expect(snapshot.configPath).toBe(positional);
      expect(snapshot.security.port).toBe(18080);

      const write = await postWith(`${panel.url}/api/settings`, cookie, { patch: { security: { port: 18090 } } });
      expect(write.status).toBe(200);
      // 写进位置参数那份，env 那份一个字节都不动。
      expect(readFileSync(positional, "utf8")).toContain("18090");
      expect(readFileSync(fromEnv, "utf8")).toContain("28080");
    } finally {
      if (previous === undefined) delete process.env[SETTINGS_CONFIG_ENV];
      else process.env[SETTINGS_CONFIG_ENV] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("panel /api/credential-sources", () => {
  it("answers GET only and never returns credential content", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();
    const response = await getWith(`${panel.url}/api/credential-sources`, cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sources: unknown[] };
    expect(Array.isArray(body.sources)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("accessToken");

    const wrongMethod = await postWith(`${panel.url}/api/credential-sources`, cookie, {});
    expect(wrongMethod.status).toBe(405);
  });
});

/* ------------------------------------------------------------------------- */
/* 改密码                                                                      */
/* ------------------------------------------------------------------------- */

describe("POST /api/password", () => {
  it("rejects a wrong current password without touching the stored hash", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();
    const response = await postWith(`${panel.url}/api/password`, cookie, {
      currentPassword: "wrong-one",
      newPassword: "AnotherPassword123",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "wrong_password" });
    expect(await panel.users.verify(ADMIN, ADMIN_PASSWORD)).toBe(true);
  });

  it("rejects a new password below the minimum length", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();
    const response = await postWith(`${panel.url}/api/password`, cookie, {
      currentPassword: ADMIN_PASSWORD,
      newPassword: "short",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "invalid_password" });
  });

  it("changes the password, keeps this browser signed in and drops the other sessions", async () => {
    const panel = await startPanel();
    const first = await panel.login();
    const second = await panel.login();
    expect(panel.sessions.size).toBe(2);

    const response = await postWith(`${panel.url}/api/password`, first, {
      currentPassword: ADMIN_PASSWORD,
      newPassword: "AnotherPassword123",
    });
    expect(response.status).toBe(200);
    const renewed = (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
    expect(renewed.startsWith(`${SESSION_COOKIE}=zcp_sess_`)).toBe(true);

    // 旧会话全部作废：第一条请求用的 cookie 已经不是新会话，第二条同理。
    expect(await (await getWith(`${panel.url}/api/state`, first)).status).toBe(401);
    expect(await (await getWith(`${panel.url}/api/state`, second)).status).toBe(401);
    // 换来的新会话可用。
    expect(await (await getWith(`${panel.url}/api/state`, renewed)).status).toBe(200);

    // 新密码能登录，旧密码不能。
    expect(await panel.users.verify(ADMIN, "AnotherPassword123")).toBe(true);
    expect(await panel.users.verify(ADMIN, ADMIN_PASSWORD)).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* 挂载契约与回环检查                                                          */
/* ------------------------------------------------------------------------- */

describe("panel path ownership", () => {
  it("returns false (leaves the path to the proxy) for non-panel routes", async () => {
    const panel = await startPanel();
    for (const path of ["/v1/models", "/health", "/mcp", "/quota"]) {
      const response = await getWith(`${panel.url}${path}`);
      expect([path, response.status]).toEqual([path, 404]);
      expect(await response.json()).toEqual({ handled: false });
    }
  });
});

describe("panel peer check", () => {
  it("accepts the loopback spellings a local client produces", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it("only enforces the peer check for a loopback panel host", async () => {
    // 回环绑定：请求本来就来自回环，放行。
    const loopback = await startPanel({ hostname: "127.0.0.1" });
    expect((await getWith(`${loopback.url}/login`)).status).toBe(200);

    // 非回环绑定（Docker 的 0.0.0.0）：不做回环检查，登录页就是那道门。
    const exposed = await startPanel({ hostname: "0.0.0.0" });
    expect((await getWith(`${exposed.url}/login`)).status).toBe(200);
  });

  it("knows which spellings are loopback binds", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* CSRF                                                                        */
/* ------------------------------------------------------------------------- */

describe("panel write requests are same-origin", () => {
  it("rejects a cross-origin write and allows a same-origin one", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();

    const cross = await fetch(`${panel.url}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "http://evil.example" },
      body: JSON.stringify({ cmd: "status" }),
    });
    expect(cross.status).toBe(403);

    const same = await fetch(`${panel.url}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: panel.url },
      body: JSON.stringify({ cmd: "status" }),
    });
    expect(same.status).toBe(200);
  });

  it("allows a request without an Origin header (curl and scripts)", async () => {
    const panel = await startPanel();
    const cookie = await panel.login();
    const response = await postWith(`${panel.url}/api/control`, cookie, { cmd: "status" });
    expect(response.status).toBe(200);
  });
});

/**
 * 日志页的数据源。
 *
 * 日志由 logger 直接写 `LogBuffer`，不靠 monkey-patch console。请求表格行从这条
 * 通路里摘了出去：`writeRequestLine` 不落缓冲（否则面板系统 tab 会混进请求行），
 * 请求信息只活在请求事件 tab（数据同源 `RequestStore`，走 `request` 事件与
 * `getRequests`）。这一组用例守的是：面板仍然看得见运行日志，而表格行不再出现在
 * 日志流里。
 */
describe("panel /api/events carries the log buffer", () => {
  /** 读 SSE 直到收到 `count` 帧 `event: log`（首拍会立即补缓冲里的历史行）。*/
  async function readLogFrames(url: string, cookie: string, count: number): Promise<string> {
    const response = await fetch(url, { headers: { cookie, accept: "text/event-stream" } });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      // 首拍是立刻跑的（`openEventStream` 挂完就 `void pollLogs()`），所以有行的
      // 情况下第一个 chunk 就够了；这里的循环只是兜住分帧。
      for (let index = 0; index < 64; index++) {
        if ((text.match(/event: log/g) ?? []).length >= count) break;
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }
    return text;
  }

  it("keeps request-table rows out of the log stream", async () => {
    const logBuffer = new LogBuffer();
    const panel = await startPanel({ logBuffer });
    const cookie = await panel.login();

    // 与生产同一条通路：logger 写业务日志，handler-log 写请求行。
    try {
      configureLogging({ buffer: logBuffer });
      logger("proxy").info("stage", { reqId: "#001", stage: "intake", account: "work-team" });
      writeRequestLine("| #001 | 12:04:11   | ANT | glm-4.6     | batch  |  200 |     7ms |     - |      - |       - |");
    } finally {
      resetLogging();
    }

    const text = await readLogFrames(`${panel.url}/api/events`, cookie, 1);

    // 业务日志：结构化条目带 mod 与字段。
    expect(text).toContain('"mod":"proxy"');
    expect(text).toContain('"stage":"intake"');
    expect(text).toContain('"account":"work-team"');
    // 请求表格行不进缓冲：`log` 事件里没有它。
    expect(text).not.toContain('"mod":"request"');
    expect(text).not.toContain("| #001 | 12:04:11");
    // `line` 仍然在：`getLogs` 的消费者读它，结构化改造不能拿掉。
    expect(text).toContain('"line":');
  });

  it("logs written before the page connected are still delivered (buffer, not a live tap)", async () => {
    const logBuffer = new LogBuffer();
    try {
      configureLogging({ buffer: logBuffer });
      logger("accounts").info("account store changed on disk, reloaded");
    } finally {
      resetLogging();
    }
    const panel = await startPanel({ logBuffer });
    const cookie = await panel.login();

    const text = await readLogFrames(`${panel.url}/api/events`, cookie, 1);

    // 缓冲区是环形历史，不是 console 的实时镜像：连上之前的行也在。
    expect(text).toContain("account store changed on disk");
    expect(text).toContain('"mod":"accounts"');
  });
});

/* ------------------------------------------------------------------------- */
/* 设置写入的热重载 E2E                                                     */
/* ------------------------------------------------------------------------- */

/** `GET /async/v1/*` 的挂载判断（server.ts 每请求读 `config.async.enabled`）。*/

describe("settings write hot-reloads the running proxy", () => {
  const dirs: string[] = [];
  const servers: ProxyServer[] = [];
  /** `SETTINGS_CONFIG_ENV` 的原值：settingsConfigPath() 读它，用例结束时必须还回去。*/
  let previousEnv: string | undefined;

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) await server.close();
    }
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    if (previousEnv === undefined) delete process.env[SETTINGS_CONFIG_ENV];
    else process.env[SETTINGS_CONFIG_ENV] = previousEnv;
  });

  /**
   * 起一个完整的 serve 形态：面板与代理共用同一个监听，共享同一个 `config`
   * 对象（bootstrap 的拓扑）。账号仓是空的 —— async 的挂载闸门
   * （`hasCapableAccount`）因此每次都答「没有」，这正是可观察的行为差异。
   */
  async function startWired(yaml: string): Promise<{ url: string; cookie: string; config: ProxyConfig; configPath: string }> {
    const dir = mkdtempSync(join(tmpdir(), "zcode-w32-e2e-"));
    dirs.push(dir);
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, yaml, "utf8");
    previousEnv = process.env[SETTINGS_CONFIG_ENV];
    process.env[SETTINGS_CONFIG_ENV] = configPath;

    const config = loadConfig(configPath);
    const { manager, broker } = inMemoryAccounts([]);
    const users = new UserManager(memoryUsers());
    await users.create(ADMIN, ADMIN_PASSWORD);
    const sessions = new SessionStore();
    const { createControlDispatcher } = await import("../control/control.js");
    const dispatcher = createControlDispatcher({ proxyPort: 0 }, { logBuffer: new LogBuffer(), accounts: manager, broker });

    const panelHandler = createPanelHandler({
      hostname: "127.0.0.1",
      getPort: () => 0,
      handleControl: (cmd) => dispatcher(cmd),
      getProxyInfo: () => PROXY_INFO,
      users,
      sessions,
      getOauthStatus: () => undefined,
      // 热重载的关键接线：面板拿到的就是代理正在用的那份对象（bootstrap 同款）。
      activeConfig: config,
    });

    const server = await startServer({
      config,
      broker,
      accounts: manager,
      // 出线不会被走到：用例只打 /async/v1/health 与面板，这个桩只是让签名成立。
      fetchImpl: Object.assign(
        async (_request: RequestInfo | URL, _init?: RequestInit): Promise<Response> => new Response("{}", { status: 200 }),
        { preconnect: () => {} },
      ),
      requests: new RequestStore(),
      panel: panelHandler,
    });
    servers.push(server);

    const login = await postWith(`${serverUrl(server)}/api/session`, undefined, {
      username: ADMIN,
      password: ADMIN_PASSWORD,
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    return { url: serverUrl(server), cookie, config, configPath };
  }

  function serverUrl(server: ProxyServer): string {
    return `http://127.0.0.1:${server.port}`;
  }

  const ASYNC_ON_YAML = `server:
  port: 0
  host: "127.0.0.1"
auth:
  requireKey: false
defaultModel: glm-5.3
async:
  enabled: true
`;

  it("unmounts /async/v1/* on the next request after flipping async.enabled off", async () => {
    const wired = await startWired(ASYNC_ON_YAML);

    // async 开着、但没有能跑 async 的账号：挂载闸门用 400 明说，而不是 404。
    // 数据面的错误形状是 `{error:{type,message}}`，与控制面的 `{ok:false}` 不同。
    const before = await getWith(`${wired.url}/async/v1/health`);
    expect(before.status).toBe(400);
    expect(await before.json()).toMatchObject({ error: { type: "async_plan_unsupported" } });

    // 面板改设置（不重启）：响应里的清单说明 async 已热生效。
    const write = await postWith(`${wired.url}/api/settings`, wired.cookie, {
      patch: { subsystems: { async: false } },
    });
    expect(write.status).toBe(200);
    const body = (await write.json()) as { ok: boolean; reloaded: string[]; restartRequired: string[] };
    expect(body.ok).toBe(true);
    expect(body.reloaded).toEqual(["async"]);
    expect(body.restartRequired).toEqual([]);

    // 同一个监听、同一份 config 对象：下一个请求已经按新值走（A 类）。
    const after = await getWith(`${wired.url}/async/v1/health`);
    expect(after.status).toBe(404);
    expect(wired.config.async.enabled).toBe(false);
  });

  it("re-mounts /async/v1/* the same way when the flag flips back on", async () => {
    const wired = await startWired(ASYNC_ON_YAML);

    const off = await postWith(`${wired.url}/api/settings`, wired.cookie, {
      patch: { subsystems: { async: false } },
    });
    expect(off.status).toBe(200);
    expect((await getWith(`${wired.url}/async/v1/health`)).status).toBe(404);

    const on = await postWith(`${wired.url}/api/settings`, wired.cookie, {
      patch: { subsystems: { async: true } },
    });
    expect(on.status).toBe(200);
    const again = await getWith(`${wired.url}/async/v1/health`);
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: { type: "async_plan_unsupported" } });
  });

  it("reports restart_required for the port and keeps the listener on the old one", async () => {
    const wired = await startWired(ASYNC_ON_YAML);
    const oldPort = servers[0]?.port;
    expect(typeof oldPort).toBe("number");

    const write = await postWith(`${wired.url}/api/settings`, wired.cookie, {
      patch: { security: { port: 59999 } },
    });
    expect(write.status).toBe(200);
    const body = (await write.json()) as { ok: boolean; reloaded: string[]; restartRequired: string[] };
    expect(body.reloaded).toEqual([]);
    expect(body.restartRequired).toEqual(["server.port"]);

    // C 类不热生效：旧监听原样服务，内存里的端口也没换。
    expect(wired.config.server.port).not.toBe(59999);
    const probe = await getWith(`${wired.url}/health`);
    expect(probe.status).toBe(200);
  });
});
