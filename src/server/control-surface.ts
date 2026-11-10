/**
 * `serve` 的控制面装配：命令表 + `shutdown` 的「先应答再退出」包装 + 账号回同步。
 *
 * 这份 `handleControl` 有两个消费者：面板在 `/api/control` 上用它（与代理同端口，
 * 会话 cookie 鉴权），CLI 转发用的独立回环监听也用它（`server/control-listener.ts`）。
 * 两条通道的鉴权模型不同，命令语义必须一致，所以装配只有一处。
 *
 * 为什么 `shutdown` 要在这里包一层：它是唯一一条结束进程的命令。在命令里直接退出会
 * 把应答截断，CLI 拿到的是连接重置，用户看到的是「命令失败了，其实已经生效」。
 * 所以先回 `shuttingDown`，过 `SHUTDOWN_REPLY_GRACE_MS` 再走与 SIGINT / SIGTERM
 * 同一条退出路径。裸命令表里没有这个包装（`control/control.ts` 的 `onShutdown`
 * 是同步关服务器），那是给不等应答的内部调用方准备的。
 *
 * 其余成功命令之后回同步账号仓：面板或 CLI 可能在 serve 跑着的时候登录 / 登出，
 * `accounts.json` 才是唯一真源，而 `Broker` 通过 `AccountManager` 读账号（后者有缓存）。
 * 每条命令之后比对一次指纹，变了就让缓存失效。`accounts.json` 靠这个机制跟上磁盘；
 * `policy.json` 一旦没有对应的机制，CLI 改的策略就不生效（`createBroker` 那一侧同样要接）。
 */
import { createControlDispatcher } from "../control/control.js";
import type { ControlState, HandlerContext } from "../control/control.js";
import { credentialFingerprint } from "../accounts/types.js";
import { logger } from "../log/index.js";
import type { ControlDispatcher } from "./panel.js";

/** 运行期事件的日志（账号回同步）。 */
const logAccounts = logger("accounts");

/** `shutdown` 的应答在退出前留出的时间（毫秒）。 */
export const SHUTDOWN_REPLY_GRACE_MS = 50;

/** 端口号的活值容器：面板处理器先于 `startServer` 建好，这一刻端口还不存在。 */
export interface PortRef {
  current: number;
}

export interface ServeControl {
  /** `status` 命令要的活端口，同时是登录轮询状态（`readOauthStatus`）的宿主。 */
  controlState: ControlState;
  /** 面板 `/api/control` 与 CLI 转发共用的入口，见文件头。 */
  handleControl: ControlDispatcher;
}

export interface ServeControlOpts {
  /** 命令表的依赖（账号仓 / broker / 日志缓冲 / 请求记录 / 额度与登录的钩子）。 */
  context: HandlerContext;
  portRef: PortRef;
  /** 走完整个进程的退出路径（与信号同一个）。 */
  shutdown: () => void;
}

/**
 * 建控制面。异步只为一件事：构造时记下账号仓的指纹，作为「磁盘变了没有」的基线。
 */
export async function createServeControl(opts: ServeControlOpts): Promise<ServeControl> {
  const { context, portRef } = opts;

  /*
   * `status` 命令的端口号是 getter 而不是快照：面板处理器必须先于 `startServer` 建好
   * （面板挂在那次监听上），构造这一刻端口还是 0。`serve` 在 `startServer` 之后写
   * `portRef.current`，协议那一侧读到的是活值。
   */
  const controlState: ControlState = {
    get proxyPort() {
      return portRef.current;
    },
  };

  const dispatchControl = createControlDispatcher(controlState, context);

  const accountsFingerprint = async (): Promise<string> => JSON.stringify(await context.accounts.list());
  let authFingerprint = await accountsFingerprint();
  /** 每个账号的凭据指纹（排除 jwt 轮换的字段），用来认「谁刚重新登录/导入」。*/
  const credentialFingerprints = new Map<string, string>();
  for (const entry of await context.accounts.list()) {
    credentialFingerprints.set(entry.id, credentialFingerprint(entry.credential));
  }

  /**
   * CLI `auth login/import` 是另一个进程写的 `accounts.json`，运行中的
   * serve 只看得到磁盘变化、看不到那次 `enrollCredential` 回调。这里按凭据指纹认
   * 出被刷新的账号，补调 broker 的 resetAuthInvalid（同一条恢复入口）。
   */
  async function syncCredentialRefresh(broker: HandlerContext["broker"]): Promise<void> {
    if (!broker) return;
    for (const entry of await context.accounts.list()) {
      const fingerprint = credentialFingerprint(entry.credential);
      const previous = credentialFingerprints.get(entry.id);
      credentialFingerprints.set(entry.id, fingerprint);
      if (previous !== undefined && previous !== fingerprint) {
        broker.resetAuthInvalid(entry);
      }
    }
  }

  async function syncAuthWithDisk(): Promise<void> {
    const fingerprint = await accountsFingerprint();
    if (fingerprint === authFingerprint) return;
    authFingerprint = fingerprint;
    await context.accounts.reload();
    await syncCredentialRefresh(context.broker);
    logAccounts.info("account store changed on disk, reloaded");
  }

  /**
   * 面板与 CLI 的共同入口。
   *
   * 每条成功命令之后回同步一次账号仓，所以后台登录会在一条命令的往返之内落地。
   * 删除运行中代理正在用的账号不再顺手停掉它：调度器下一个请求自己报 `no-account`，
   * 与「账号仓本来就是空的」时启动的那个 503 是同一个。
   */
  const handleControl: ControlDispatcher = async (cmd) => {
    if (cmd.cmd === "shutdown") {
      setTimeout(opts.shutdown, SHUTDOWN_REPLY_GRACE_MS);
      return { ok: true, event: "shuttingDown" };
    }
    const res = await dispatchControl(cmd);
    if (!res.ok) return res;
    await syncAuthWithDisk();
    return res;
  };

  return { controlState, handleControl };
}
