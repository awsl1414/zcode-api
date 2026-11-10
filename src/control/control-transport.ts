/**
 * 控制面的传输层：收一个 `POST /control`，交给命令表，写回应答。
 *
 * 这一层只做四件事：回环地址复查（绑定与逐请求复查双保险）、请求行与路径
 * 判断、读 body、把 dispatcher 的返回值序列化。它不认识任何一条命令。
 *
 * 依赖方向：本文件不 import `control.ts`。命令表由调用方作为 `dispatch` 参数传进来
 * （`server/control-listener.ts` 注入装配过的 `handleControl`，`control.ts` 为测试入口
 * 注入 `dispatch`）：本文件反过来 import `control.ts` 取命令表，会和 `control.ts`
 * import 本文件的测试入口形成包级循环，而循环里的模块初始化顺序一旦被 bundler 改写
 * 就是难查的运行时错误。
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { AccountManager } from "../accounts/manager.js";
import { LogBuffer } from "../log/buffer.js";
import type {
  ControlCommand,
  ControlHandlerResult,
  ControlResponse,
  HandlerContext,
} from "./control-types.js";
import type { ControlState } from "./control-views.js";

export interface StartControlOpts {
  port: number;
  state: ControlState;
  /** 账号仓：登录 / 登出 / status 的唯一真源。*/
  accounts: AccountManager;
}

/**
 * 命令表（`control.ts` 的 `dispatch`）的形状。
 *
 * transport 不自己造一个命令表：注入点只有这一处，测试可以不碰监听器直接驱动
 * `handleControlRequest`。
 */
export type ControlDispatch = (
  cmd: ControlCommand,
  state: ControlState,
  ctx: HandlerContext,
) => Promise<ControlResponse>;

/**
 * Start the control listener bound to 127.0.0.1. Resolves once listening.
 *
 * `port` 是**内核实际分配**的那个端口：传入 `port: 0` 时它才是有用的返回值。
 * 调用方要把它写给别人（`server/control-listener.ts` 写端口文件让 CLI 找到进程），
 * 而自己去探测「哪个端口空着」会留一个 bind→close→listen 的竞态窗口。
 */
export function startControlListener(
  opts: StartControlOpts,
  dispatch: ControlDispatch,
): Promise<{ close(): Promise<void>; port: number }> {
  /*
   * 命令表由调用方注入：serve 传的是 `createServeControl()` 包装过的 `handleControl`，
   * 命令语义与它闭包的那份上下文都在那里。这里只填 `HandlerContext` 的必填项，
   * 让这层上下文与命令分发无关。
   */
  const ctx: HandlerContext = { logBuffer: new LogBuffer(), accounts: opts.accounts };
  const server: Server = createServer(async (req, res) => {
    try {
      const result = await handleControlRequest(req, opts.state, ctx, dispatch);
      writeJson(res, result.status, result.body);
    } catch (err) {
      writeJson(res, 500, { ok: false, error: `internal_error: ${(err as Error).message}` });
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : opts.port;
      resolve({
        close: () => new Promise<void>((r) => server.close(() => r())),
        port,
      });
    });
  });
}

export async function handleControlRequest(
  req: IncomingMessage,
  state: ControlState,
  ctx: HandlerContext,
  dispatch: ControlDispatch,
): Promise<ControlHandlerResult> {
  if (!isLoopback(req.socket.remoteAddress)) {
    return { status: 403, body: { ok: false, error: "forbidden: non-loopback remote address" } };
  }

  const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method !== "POST" || parsed.pathname !== "/control") {
    return { status: 404, body: { ok: false, error: `not_found: ${req.method} ${parsed.pathname}` } };
  }

  const body = await readBody(req);
  let cmd: ControlCommand;
  try {
    cmd = JSON.parse(body) as ControlCommand;
  } catch {
    return { status: 400, body: { ok: false, error: "invalid_json" } };
  }

  const result = await dispatch(cmd, state, ctx);
  return { status: 200, body: result };
}

function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * `handleControlRequestForTest` 的账号仓：内存空仓。
 *
 * 那个入口只给"只关心 shutdown"的老用例用，不碰账号；给它一个空仓而不是让它传
 * `undefined`，是为了让 `HandlerContext` 里 `accounts` 保持必填；必填能在编译期
 * 拦住"忘记接线账号仓"的新调用点。
 */
function emptyAccountManager(): AccountManager {
  return new AccountManager({
    load: async () => ({ version: 2, accounts: [] }),
    save: async () => {},
  });
}

/**
 * 两个测试入口：造一个 `HandlerContext`，再走一遍上面的 `handleControlRequest`。
 *
 * 装配放在传输层，命令表由调用方（`control.ts`）传进来，所以本文件仍然不认识
 * 任何一条命令。返回的两个函数与拆分前的签名一致，调用点不用改。
 */
export function createControlTestEntries(dispatch: ControlDispatch): {
  handleControlRequestForTest(
    req: IncomingMessage,
    state: ControlState,
    onShutdown?: () => Promise<void> | void,
  ): Promise<ControlHandlerResult>;
  handleControlRequestWithHooksForTest(
    req: IncomingMessage,
    state: ControlState,
    ctx: HandlerContext,
  ): Promise<ControlHandlerResult>;
} {
  return {
    // Backwards-compatible shape: only `onShutdown` is wired.
    handleControlRequestForTest: (req, state, onShutdown) =>
      handleControlRequest(
        req,
        state,
        { onShutdown, logBuffer: new LogBuffer(), accounts: emptyAccountManager() },
        dispatch,
      ),
    handleControlRequestWithHooksForTest: (req, state, ctx) =>
      handleControlRequest(req, state, ctx, dispatch),
  };
}
