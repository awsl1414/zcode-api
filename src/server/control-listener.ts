/**
 * `serve` 的回环控制监听：本机 CLI 与运行中进程之间的唯一通道。
 *
 * 为什么不走面板那条 `/api/control`：面板要登录会话，CLI 拿不到 cookie。给面板加一条
 * 免会话的路径会把「控制面永不无鉴权暴露」这条约束破掉。
 *
 * 所以复用控制面已有的传输层（`control/control-transport.ts::startControlListener`）：
 * 绑 127.0.0.1、每请求复查 `remoteAddress`、只认 `POST /control`、错误语义现成。
 * 这条回环校验就是新通道的全部鉴权依据，不要在这里加令牌或会话。
 *
 * 命令表接的是 `createServeControl()` 那个**包装过的** `handleControl`，不是裸的
 * 命令表：`shutdown` 要先应答再退出，成功命令之后要回同步账号仓。接裸命令表的话
 * CLI 的 `shutdown` 会拿到连接重置。
 *
 * 端口由内核分配，监听成功后写进 store 目录的端口文件（`runtime/control-port.ts`），
 * CLI 靠它找到这个进程；`close()` 时删掉，进程被 `kill -9` 时由 CLI 自己删。
 *
 * 只在 `serve` 起：这是 serve 进程自己的控制通道，别处起第二个会让「谁在监听」
 * 变成运行期猜谜。
 */
import { startControlListener as startTransportControlListener } from "../control/control-transport.js";
import type { ControlDispatch } from "../control/control-transport.js";
import type { AccountManager } from "../accounts/manager.js";
import type { ControlCommand, ControlResponse } from "../control/control-types.js";
import type { ControlState } from "../control/control-views.js";
import { readControlPort, removeControlPort, writeControlPort } from "../runtime/control-port.js";

export interface ServeControlListenerOpts {
  /** `createServeControl()` 的 `handleControl`（包装过的那个，见文件头）。 */
  handleControl: (cmd: ControlCommand) => Promise<ControlResponse>;
  state: ControlState;
  accounts: AccountManager;
}

export interface ServeControlListener {
  port: number;
  close(): Promise<void>;
}

/**
 * 起监听并写端口文件。监听失败直接抛。
 *
 * 端口交给内核分配（`port: 0`），传输层把**实际绑定的那个**回给我们 —— 自己去
 * 「先 bind 一个、关掉、再用它 listen」会留一个竞态窗口，而那个窗口的失败表现是
 * 启动时偶发的 `EADDRINUSE`，最难查。
 *
 * 调用方（`server/bootstrap.ts`）把失败降级成一条告警：没有这个监听时 CLI 退回本地
 * 路径并明说「下次启动生效」，那比让 serve 起不来好。
 */
export async function startServeControlListener(
  opts: ServeControlListenerOpts,
): Promise<ServeControlListener> {
  /*
   * 命令语义在 `createServeControl()` 包装过的 `handleControl` 里：它闭包了自己的
   * 上下文（账号仓、broker、日志缓冲、请求记录），`dispatch` 只转发命令。传输层负责
   * HTTP 与回环复查，按 `StartControlOpts` 构造的 `HandlerContext` 不参与命令分发。
   */
  const dispatch: ControlDispatch = (cmd) => opts.handleControl(cmd);

  const listener = await startTransportControlListener(
    { port: 0, state: opts.state, accounts: opts.accounts },
    dispatch,
  );
  const port = listener.port;
  writeControlPort(port);
  return {
    port,
    close: async () => {
      await listener.close();
      // 只在文件还是自己的端口时才删：另一个 serve 已经接手同一个 store 目录
      // 的情况下，删掉别人的端口文件会让 CLI 找不到活着的那个进程。
      if (readControlPort() === port) removeControlPort();
    },
  };
}
