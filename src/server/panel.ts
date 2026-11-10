/**
 * Web panel — the graphical control surface (issue #58, on by default).
 *
 * The TUI is gone, and inside Docker there is no terminal to render one
 * into anyway. This module exposes the *existing* control protocol
 * (`src/control/control.ts`) through the proxy's own HTTP listener. It adds no
 * new state and no new upstream calls:
 *
 *   browser → panel → POST /api/control → in-process dispatcher
 *
 * The dispatcher is `createControlDispatcher()` from `src/control/control.ts`:
 * the same command semantics `POST /control` serves, called directly instead of
 * over a second loopback HTTP port. Opening such a port would mean an
 * unauthenticated path to `removeAccount` / `shutdown` for anything
 * that can reach loopback, so the panel does not do it.
 *
 * ## 为什么没有自己的端口
 *
 * 面板不自己开端口，也不用 URL 令牌。独立监听加 URL 令牌在 Docker 里 `-p 8080:8080`
 * 之后用户拿不到令牌（它只出现在容器内的 stdout 里），而令牌进 URL 又会留在浏览器
 * 历史、代理日志和 `Referer` 头里。所以面板挂在代理自己的
 * 监听上（一个端口就够），凭据是用户名 + 密码，登录后拿会话 Cookie。
 *
 * 因此本模块导出的是一个请求处理器，由 `server.ts` 在路由之前调用；返回
 * `false` 表示「这条请求不是面板的」，交回代理。
 *
 * ## 鉴权面
 *
 *   GET  /login            登录页（唯一不需要会话的页面）
 *   POST /api/session      {username, password} → Set-Cookie: session=…
 *   GET  /api/session      当前登录状态（未登录 401）
 *   DELETE /api/session    登出，清 cookie
 *   POST /api/password     改密码（要会话）
 *   GET  /api/oauth-status 最近一次登录流程的进度（登录模态轮询）
 *   GET  /、/accounts、…            有会话就渲染，没有就 302 到 /login
 *   /api/*（其余）         要会话，没有就 401
 *
 * Cookie 属性是 `HttpOnly; SameSite=Strict; Path=/`，不加 `Secure`：面板默认
 * 跑在 http（回环或内网），加了 `Secure` 浏览器根本不会回传，登录会静默失效。
 *
 * 回环检查（`req.socket.remoteAddress`）只在面板绑定到回环地址时启用。面板跟随
 * `server.host`（Docker 里是 `0.0.0.0`）时这一步没有意义：那时挡住未授权访问的
 * 是登录页，这也是取消 URL 令牌的原因：令牌没法安全地暴露给网络，密码可以。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlCommand, ControlResponse, OAuthStatus } from "../control/control.js";
import type { ProxyConfig } from "../config/types.js";
import pkg from "../../package.json" with { type: "json" };
import { renderLoginPage, renderPanelPage } from "./web/page.js";
import {
  createStateReader,
  isLoopbackBindHost,
  readSettings,
  scanCredentialSources,
  settingsConfigPath,
  writeSettings,
  type SettingsPatch,
  type SettingsReloadHooks,
} from "./routes-state.js";
import { openEventStream } from "./routes-events.js";
import type { LogBuffer } from "../log/buffer.js";
import type { RequestStore } from "../proxy/request-record.js";
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  readCookie,
  sessionCookie,
  type Session,
  type SessionStore,
} from "../users/session.js";
import type { UserManager } from "../users/manager.js";

/** 登录页路径（重定向目标，也是唯一免鉴权的页面）。*/
export const LOGIN_PATH = "/login";

/**
 * 面板认领的页面路径。
 *
 * 不含 `/chat`：聊天是面板侧边栏的一个视图，没有独立页；那条路径交回代理路由
 * （数据面），打过去就是 404。
 *
 * 不含 `/proxies`：代理是账号属性的命名字典，管理面是账号页的抽屉。那条路径
 * 交回代理路由——留一个「路由还在、视图没了、落到概览」的壳就是兼容残留。
 *
 * 同理不含 `/account`：那一页并进了设置页的「账户」组，旧路径没有第二个身份。
 */
const PAGE_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/panel",
  LOGIN_PATH,
  "/accounts",
  "/routing",
  "/keys",
  "/logs",
  "/settings",
  "/stats",
]);

/** Control commands are small JSON documents; anything bigger is a mistake. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * `/api/control` 的上限：**命令本身**很小，但 `importAccount.content` 是用户选的
 * 那个文件（本工具的导出包 / ZCode 凭据文件）原文，几十个账号的包就可能过 64KB。
 *
 * 为它单独给一档，而不是把这整条通道放大：登录 / 改密码 / 设置补丁都是小文档，
 * 它们继续用 {@link MAX_BODY_BYTES}。512KB 够装几百个账号的导出包（一个账号约
 * 1KB，加密后 base64 再 ×1.34），同时仍然是个「错得很离谱才会撞到」的数字。
 */
const CONTROL_BODY_BYTES = 512 * 1024;

/**
 * 设置写入里属于"请求本身写错了"的错误码（400）。
 *
 * 其余（`config_missing` / `config_invalid`）是环境问题（503）：请求没写错，
 * 是机器上那个文件不在或坏了 —— 页面给的动作完全不同（改输入 vs 去修文件）。
 */
const SETTINGS_WRITE_CLIENT_ERRORS = new Set(["invalid_setting", "confirmation_required"]);

/**
 * Remote address spellings that are the local machine. `::ffff:127.0.0.1` is what
 * Node reports for an IPv4 client on a dual-stack listener.
 */
const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

/** 绑到通配地址（`0.0.0.0` / `::`）时打印与展示用的地址。*/
const DISPLAY_LOOPBACK_HOST = "127.0.0.1";

/**
 * In-process control dispatch: `POST /api/control` hands the parsed command to
 * this and returns whatever the control protocol answers, unchanged.
 */
export type ControlDispatcher = (cmd: ControlCommand) => Promise<ControlResponse>;

/**
 * 面板运行态。
 *
 * 没有聊天页地址字段：聊天是面板自己的视图，顶栏按钮做客户端切换，不需要
 * 任何地址。
 */
export interface PanelProxyInfo {
  /** `host:port`，展示用（通配绑定已换成回环地址）。*/
  address: string;
}

/** `GET /api/system` 的载荷（设置页「服务」组的版本行）。*/
export interface PanelSystemInfo {
  /** 面板的版本（与 `GET /api/state` 的 `server.version` 同源）。*/
  version: string;
  /** 面板自己的 `host:port`（与代理同端口）。*/
  panelAddress: string;
  proxy: PanelProxyInfo;
}

export interface PanelOptions {
  /** 解析后的面板地址（`panel.host` 或 `server.host`）：展示与回环检查都用它。*/
  hostname: string;
  /** 面板所在监听的实时端口（代理启动后才知道，`port: 0` 时由内核分配）。*/
  getPort: () => number;
  /** In-process dispatcher backing `POST /api/control`. */
  handleControl: ControlDispatcher;
  /**
   * 进程内生效的那份 `ProxyConfig`（`bootstrap.ts` 在 serve 里持有的启动快照）。
   *
   * 设置页写完 `config.yaml` 后由它做就地热重载：设置页改的不再是「重启
   * 后才生效的文件」，A / B 类字段下一次请求就按新值跑。不传（测试、独立宿主）时
   * 写入只落盘，响应里的 `reloaded` / `restartRequired` 为空，页面退回「已保存」
   * 的中性文案。
   */
  activeConfig?: ProxyConfig;
  /**
   * 进程正在用的那份配置文件路径。
   *
   * `serve` 用位置参数启动（`zcode-proxy my.yaml`）时，启动读的是 `my.yaml`，而
   * `settingsConfigPath()` 只认 `ZCODE_PROXY_CONFIG`：设置页于是报「找不到配置文件」
   * （503 `config_missing`），就算能写也会写到 `config.yaml`——面板与进程读写的不是
   * 同一份。
   *
   * 与 `activeConfig` 同一个注入思路：入口（`bootstrap.ts::serve`）把自己实际用的
   * 那条路径传进来，这里不再自己猜。不传（测试、独立宿主）时退回到
   * `settingsConfigPath()` 的 env / 默认值行为，语义不变。
   */
  configPath?: string;
  /**
   * B 类收尾的注入点：claim 段变化后重启各账号的领取调度器。
   *
   * `bootstrap.ts` 传进来的是 serve 作用域里的 restart 函数（stop 旧组 + 按
   * 新配置重起）。不传（测试、独立宿主）时 claim 段照旧热替换进内存，只是没有
   * 运行组可重启 —— 与 `activeConfig` 缺省时「只落盘」是同一类降级。
   */
  reloadHooks?: SettingsReloadHooks;
  /**
   * 代理地址。面板看不到 `ProxyServer`（句柄在 `serve` 手里），所以由入口注入；
   * 面板自己去猜端口会在「面板端口 ≠ 代理端口」的部署里猜错。
   */
  getProxyInfo: () => PanelProxyInfo;
  /** 用户表（登录、改密码）。*/
  users: UserManager;
  /** 会话表（内存，进程重启即失效）。*/
  sessions: SessionStore;
  /**
   * 最近一次 OAuth 流程的状态（`GET /api/oauth-status`）。
   *
   * 面板只拿得到 dispatcher，拿不到状态对象（它在 `control-surface.ts` 的
   * `createServeControl()` 里，而且可变），所以由入口注入 `readOauthStatus`。已经过期的按「没有」返回，面板不重复
   * 做 TTL 判断。
   */
  getOauthStatus: () => OAuthStatus | undefined;
  /**
   * 日志缓冲。
   *
   * `/api/events` 的日志事件从这里读**结构化条目**：只有条目带 `level` / `mod` /
   * `account` 字段，页面的过滤器才不用去 parse 文本行。`getLogs` 命令仍然只回
   * 字符串，两个消费者各取所需。
   */
  logBuffer?: LogBuffer;
  /**
   * 请求记录。`/api/events` 的 `request` 事件从它订阅；不传则没有请求
   * 事件（面板不装、或者宿主没有请求链路时）。
   */
  requests?: RequestStore;
}

/**
 * 面板的请求处理器。
 *
 * 返回 `true` 表示这条请求已经由面板应答完，代理不要再碰它；`false` 表示路径不属于
 * 面板（`/v1/*`、`/mcp`、`/quota`…），交回 `server.ts` 的代理路由。
 */
export type PanelHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/** Fully resolved panel settings; only produced when the panel should run. */
export interface PanelSettings {
  /** 面板接受访问的地址（`panel.host` 为空时跟随 `server.host`）。*/
  host: string;
}

export interface PanelSettingsOptions {
  /** `--no-panel`：这次启动不要面板（命令行显式选择，压过配置文件）。*/
  disabled?: boolean;
}

/**
 * 解析面板配置。
 *
 * 返回 `null` 表示面板不该启动：`--no-panel`，或 `panel.enabled: false`。没有端口
 * 可以解析：面板挂在代理的监听上（见文件头）。
 */
export function resolvePanelSettings(
  config: ProxyConfig,
  options: PanelSettingsOptions = {},
): PanelSettings | null {
  // 缺省值与 `config/loader.ts` 的 DEFAULTS 一致：面板默认开，`host` 空串表示
  // 跟随 `server.host`。手写配置（测试）不必先补一个 `panel` 段。
  const enabled = config.panel?.enabled ?? true;
  if (options.disabled === true || !enabled) return null;
  const host = (config.panel?.host ?? "").trim() || config.server.host;
  return { host };
}

/**
 * 绑定地址 → 用户能点的地址。
 *
 * 回环绑定（`127.0.0.1` / `localhost` / `::1`）原样返回；通配绑定（`0.0.0.0` / `::`）
 * 不是能直接打开的地址，换成 {@link DISPLAY_LOOPBACK_HOST}。
 */
export function displayHostname(bindHost: string): string {
  return isLoopbackHost(bindHost) ? bindHost : DISPLAY_LOOPBACK_HOST;
}

/** 面板地址（启动时打印的那一行）。没有令牌，也就没有查询串。*/
export function panelEntryUrl(hostname: string, port: number): string {
  return `http://${displayHostname(hostname)}:${port}/`;
}

export interface PanelUrlPrintOptions {
  hostname: string;
  port: number;
  /** 落点；缺省 `process.stdout.write`（测试注入收集器）。*/
  write?: (text: string) => void;
}

/**
 * 把面板地址打到终端。
 *
 * 不走 logger：`LogBuffer` 就是 `getLogs` 与 `/api/events` 的日志来源，而启动地址
 * 属于「打印给终端前的人看」的启动横幅，不该出现在日志页里。地址本身不再
 * 是秘密（令牌已经取消），这里只保持那条路径一致。
 */
export function printPanelUrl(options: PanelUrlPrintOptions): void {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  write(`panel: ${panelEntryUrl(options.hostname, options.port)}\n`);
}

/**
 * 首次启动的管理员密码打印（只打印到 stdout 这一次）。
 *
 * 与地址同理，不走 `console.log`：密码会进 `LogBuffer`，而那个缓冲区的内容
 * 就是日志页展示给任何登录用户看的东西。
 */
export function printAdminPassword(password: string, write?: (text: string) => void): void {
  const out = write ?? ((text: string) => process.stdout.write(text));
  out("panel: admin password (shown once, change it in Settings):\n");
  out(`        ${password}\n`);
}

/** First value of a possibly-repeated request header. */
function headerValue(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * True when the panel is bound to an address only the local machine can reach.
 * Exported for the tests that pin the peer check's decision table.
 *
 * Delegates to `routes-state.ts` so one list serves both questions (panel bind
 * vs. "would this settings change expose the control plane").
 */
export function isLoopbackHost(host: string): boolean {
  return isLoopbackBindHost(host);
}

/**
 * True when the peer of this request is the local machine. Exported for the
 * tests that pin the peer check's decision table.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.includes(address);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
  });
  res.end(html);
}

/** 302 到面板内的某个路径（`Location` 用相对路径，反代下也不会指错主机）。*/
function redirectTo(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

/** 302 到登录页。*/
function redirectToLogin(res: ServerResponse): void {
  redirectTo(res, LOGIN_PATH);
}

/**
 * Read the request body, rejecting anything above `limit` ({@link MAX_BODY_BYTES} by
 * default; `/api/control` raises it to {@link CONTROL_BODY_BYTES} for the import payload).
 * The oversized case keeps draining the socket before answering: replying
 * while the client is still writing can reset the connection and lose the 413.
 * Returns `null` when the body is too large.
 */
async function readBody(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > limit) {
      tooLarge = true;
      continue;
    }
    chunks.push(buf);
  }
  return tooLarge ? null : Buffer.concat(chunks).toString("utf8");
}

/** 解析 JSON 请求体；不是对象或解析失败都回 `null`。*/
function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 读一个字符串字段（去空白；不是字符串就当没给）。*/
function stringField(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 写操作的同源检查（CSRF）。
 *
 * `SameSite=Strict` 已经挡住跨站表单，这一层挡的是「同站但不同源」的页面（例如同一
 * 台机器上另一个端口上的页面）。浏览器对 POST/DELETE 一定会带 `Origin`，命令行的
 * `curl` 不带；没有 `Origin` 就放行，否则脚本化调用全部失效。
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = headerValue(req.headers.origin);
  if (origin === undefined) return true;
  const host = headerValue(req.headers.host);
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Build the panel request handler.
 *
 * `page` is assembled once: the document is a pure function of the embedded assets,
 * so every request gets the same bytes without re-running the fill-in.
 */
export function createPanelHandler(opts: PanelOptions): PanelHandler {
  const page = renderPanelPage();
  const loginPage = renderLoginPage();
  // One reader per panel: the inflight history has to accumulate across polls.
  const stateReader = createStateReader(opts.handleControl);
  /* 设置页读写的那条路径：入口注入的优先（= serve 正在用的那条），没人注入
     才回到 env / `config.yaml`。用函数而不是常量：不注入时“读 env”仍与以前一样是
     请求时的事（测试会在进程生命周期里改 env）。 */
  const settingsPath = () => settingsConfigPath(process.env, opts.configPath);
  // Re-check the peer on every request (second layer, same as `control.ts`).
  // Skipped for a non-loopback bind — there the login page is the gate.
  const checkPeer = isLoopbackHost(opts.hostname);

  /** 当前请求的会话（没有就是 `null`）。 */
  const sessionOf = (req: IncomingMessage): Session | null =>
    opts.sessions.resolve(readCookie(headerValue(req.headers.cookie), SESSION_COOKIE));

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";

    const isApi = path === "/api" || path.startsWith("/api/");
    const isPage = PAGE_PATHS.has(path);
    if (!isApi && !isPage && path !== "/healthz") return false;

    if (checkPeer && !isLoopbackAddress(req.socket.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: "forbidden: non-loopback remote address" });
      return true;
    }

    // Liveness probe: no session needed (it reveals nothing).
    if (method === "GET" && path === "/healthz") {
      sendJson(res, 200, { ok: true, service: "zcode-panel" });
      return true;
    }

    // 登录页：唯一免会话的页面。已经登录的人再看它没有意义，送回首页。
    if (path === LOGIN_PATH && method === "GET") {
      if (sessionOf(req)) {
        res.writeHead(302, { location: "/", "cache-control": "no-store" });
        res.end();
        return true;
      }
      sendHtml(res, loginPage);
      return true;
    }

    // ---- 会话 ----------------------------------------------------------
    if (path === "/api/session") {
      if (method === "POST") {
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: "cross_origin" });
          return true;
        }
        const body = await readBody(req);
        if (body === null) {
          sendJson(res, 413, { ok: false, error: "request_too_large" });
          return true;
        }
        const payload = parseJsonObject(body);
        if (!payload) {
          sendJson(res, 400, { ok: false, error: "invalid_json" });
          return true;
        }
        const username = stringField(payload, "username");
        const password = typeof payload.password === "string" ? payload.password : "";
        // 用户名与密码错给同一个答案：试探者不该知道哪一半对了。
        if (!username || !password || !(await opts.users.verify(username, password))) {
          sendJson(res, 401, { ok: false, error: "invalid_credentials" });
          return true;
        }
        const token = opts.sessions.create(username);
        res.setHeader("set-cookie", [sessionCookie(token)]);
        sendJson(res, 200, { ok: true, username });
        return true;
      }
      if (method === "GET") {
        const session = sessionOf(req);
        if (!session) {
          sendJson(res, 401, { ok: false, error: "unauthorized" });
          return true;
        }
        sendJson(res, 200, { ok: true, username: session.username });
        return true;
      }
      if (method === "DELETE") {
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: "cross_origin" });
          return true;
        }
        opts.sessions.destroy(readCookie(headerValue(req.headers.cookie), SESSION_COOKIE));
        res.setHeader("set-cookie", [clearedSessionCookie()]);
        sendJson(res, 200, { ok: true });
        return true;
      }
      sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }

    // ---- 页面 ----------------------------------------------------------
    if (method === "GET" && PAGE_PATHS.has(path)) {
      if (!sessionOf(req)) {
        redirectToLogin(res);
        return true;
      }
      sendHtml(res, page);
      return true;
    }

    // ---- 其余 /api/*：一律要会话 ---------------------------------------
    const session = sessionOf(req);
    if (!session) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return true;
    }
    if (method !== "GET" && !sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "cross_origin" });
      return true;
    }

    if (path === "/api/password") {
      if (method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method_not_allowed" });
        return true;
      }
      const body = await readBody(req);
      if (body === null) {
        sendJson(res, 413, { ok: false, error: "request_too_large" });
        return true;
      }
      const payload = parseJsonObject(body);
      if (!payload) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return true;
      }
      const currentPassword = typeof payload.currentPassword === "string" ? payload.currentPassword : "";
      const newPassword = typeof payload.newPassword === "string" ? payload.newPassword : "";
      const result = await opts.users.changePassword(session.username, currentPassword, newPassword);
      if (!result.ok) {
        const status = result.error === "wrong_password" ? 401 : 400;
        sendJson(res, status, { ok: false, error: result.error });
        return true;
      }
      /*
       * 改密码之后旧会话一律作废：别处的浏览器不该在密码已经换掉之后继续用着
       * 一条 12 小时的会话。当前这个浏览器立刻换一条新的，用户不会被打回登录页。
       */
      opts.sessions.destroyUser(session.username);
      const token = opts.sessions.create(session.username);
      res.setHeader("set-cookie", [sessionCookie(token)]);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (path === "/api/system") {
      if (method !== "GET") {
        sendJson(res, 405, { ok: false, error: "method_not_allowed" });
        return true;
      }
      const system: PanelSystemInfo = {
        version: pkg.version,
        panelAddress: `${displayHostname(opts.hostname)}:${opts.getPort()}`,
        proxy: opts.getProxyInfo(),
      };
      sendJson(res, 200, system);
      return true;
    }

    if (path === "/api/state") {
      if (method !== "GET") {
        sendJson(res, 405, { ok: false, error: "method_not_allowed" });
        return true;
      }
      const result = await stateReader.read();
      // A failed read is the command's own stable error code, not a
      // half-filled payload: the page must not show "0 accounts" when what it
      // actually got was "cannot read accounts".
      if (!result.ok) {
        sendJson(res, 503, { ok: false, error: result.error });
        return true;
      }
      sendJson(res, 200, result.state);
      return true;
    }

    if (path === "/api/oauth-status") {
      if (method !== "GET") {
        sendJson(res, 405, { ok: false, error: "method_not_allowed" });
        return true;
      }
      /*
       * 登录模态的轮询口。四个形状都是 200：`idle` 表示没有流程（或者
       * 那一条已经过期），其余三个带 `flowId`，页面用它区分「自己发起的那次」与
       * 「别人刚发起的一次」。
       */
      const status = opts.getOauthStatus();
      if (status === undefined) {
        sendJson(res, 200, { status: "idle" });
        return true;
      }
      if (status.phase === "ready") {
        sendJson(res, 200, { status: "ready", flowId: status.flowId, accountLabel: status.accountLabel });
        return true;
      }
      if (status.phase === "failed") {
        sendJson(res, 200, { status: "failed", flowId: status.flowId, error: status.error });
        return true;
      }
      sendJson(res, 200, { status: "pending", flowId: status.flowId });
      return true;
    }

    if (path === "/api/events") {
      if (method !== "GET") {
        sendJson(res, 405, { ok: false, error: "method_not_allowed" });
        return true;
      }
      // The stream owns the response from here: no `sendJson`, no `res.end`. Its
      // three tickers are cleared when the client goes away (`req`/`res` close).
      openEventStream(req, res, {
        handleControl: opts.handleControl,
        ...(opts.logBuffer ? { logs: opts.logBuffer } : {}),
        ...(opts.requests ? { requests: opts.requests } : {}),
        readState: () => stateReader.read(),
      });
      return true;
    }

    if (path === "/api/settings") {
      if (method !== "GET" && method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method_not_allowed" });
        return true;
      }
      if (method === "GET") {
        // 读的是配置文件（`readSettings` 会合并 `ZCODE_*` 环境变量），不是进程内存
        // 里的那份快照：页面上显示的就是"下次启动会用的值"。
        const result = readSettings(settingsPath());
        if (!result.ok) {
          sendJson(res, 503, { ok: false, error: result.error });
          return true;
        }
        sendJson(res, 200, result.settings);
        return true;
      }

      const body = await readBody(req);
      if (body === null) {
        sendJson(res, 413, { ok: false, error: "request_too_large" });
        return true;
      }
      let patch: SettingsPatch;
      let confirm: boolean;
      const payload = parseJsonObject(body);
      if (!payload || typeof payload.patch !== "object" || payload.patch === null) {
        sendJson(res, 400, { ok: false, error: "invalid_setting" });
        return true;
      }
      patch = payload.patch as SettingsPatch;
      // L3 变更的二次确认由页面在模态里收集，服务端只认这个布尔
      confirm = payload.confirm === true;

      const result = writeSettings(patch, {
        confirm,
        path: settingsPath(),
        activeConfig: opts.activeConfig,
        ...(opts.reloadHooks ? { reloadHooks: opts.reloadHooks } : {}),
      });
      if (!result.ok) {
        // 校验类失败是 400（请求本身的错），文件类失败是 503（环境不允许）。
        // `fileWritten` 是第三种：文件已经落盘、内存没收下，页面要
        // 把这个不一致说明白，而不是当成一次普通的失败。undefined 经 JSON
        // 序列化后整键消失，未落盘的失败不会带这个字段。
        const status = SETTINGS_WRITE_CLIENT_ERRORS.has(result.error) ? 400 : 503;
        sendJson(res, status, { ok: false, error: result.error, fileWritten: result.fileWritten });
        return true;
      }
      // 热重载清单：页面按它选「已生效」还是「需要重启才生效」。
      sendJson(res, 200, {
        ok: true,
        settings: result.settings,
        reloaded: result.reloaded,
        restartRequired: result.restartRequired,
      });
      return true;
    }

    if (path === "/api/credential-sources") {
      if (method !== "GET") {
        sendJson(res, 405, { ok: false, error: "method_not_allowed" });
        return true;
      }
      // Read-only scan of the local credential files. No credential content
      // ever leaves this handler: `CredentialSource` carries path + validity only.
      sendJson(res, 200, { sources: scanCredentialSources() });
      return true;
    }

    if (path !== "/api/control") {
      sendJson(res, 404, { ok: false, error: `not_found: ${method} ${path}` });
      return true;
    }
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }

    // `/api/control` 把上限抬到 CONTROL_BODY_BYTES：`importAccount.content` 是用户
    // 选的文件原文，不再是一条小命令。
    const body = await readBody(req, CONTROL_BODY_BYTES);
    if (body === null) {
      sendJson(res, 413, { ok: false, error: "request_too_large" });
      return true;
    }

    const payload = parseJsonObject(body);
    if (!payload || typeof payload.cmd !== "string") {
      sendJson(res, 400, { ok: false, error: "invalid_command" });
      return true;
    }

    try {
      // Same envelope semantics as the control listener: a failed command is a
      // 200 with `{ok:false,error}`, so the page can render the reason verbatim.
      // SAFETY: the dispatcher switches on `cmd.cmd` and validates every other
      // field per command (`src/control/control.ts`), so a payload whose `cmd` is
      // a string is exactly the shape it accepts; nothing here trusts the rest.
      const result = await opts.handleControl(payload as unknown as ControlCommand);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: `internal_error: ${(err as Error).message}` });
    }
    return true;
  };

  return handle;
}
