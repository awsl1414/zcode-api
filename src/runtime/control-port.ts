/**
 * 运行中 `serve` 进程的控制端口。
 *
 * 为什么需要这个文件：CLI 改策略时改的是一份**自己的** broker
 * （`cli/control.ts::openCliControl()`），进程退出后那份 broker 就没了；而运行中的
 * `serve` 只在 `createBroker()` 里读一次 `policy.json`，之后永不重读。于是
 * `routing set` 打印成功、`routing show` 显示新值，线上行为一点没变，而且没有任何
 * 线索指向真正的原因。
 * 命令只有交给持有状态的那个进程执行才算生效，所以 CLI 得先找到那个进程。
 *
 * 端口文件就放在 store 目录（`<storeDir>/control.port` 这一行）：一行十进制端口号，
 * 权限 0o600。写 / 读 / 删各一个函数，别处不要自己拼路径，否则改名时一定会漏一处。
 *
 * 端口由内核分配（`listen(0)`），所以每次启动的值都不同。写死一个端口会和用户机器上
 * 的其它服务撞车，而撞车那一刻的报错发生在启动阶段，与「我想改路由策略」毫无关系。
 *
 * 不用 PID 文件：CLI 唯一需要的东西是端口。PID 还得再回答「这个进程是不是我们的」，
 * 那件事在换用户、跑在容器里、PID 被复用之后都是错的。
 *
 * 三种清理时机（正常退出 / 监听关闭 / CLI 连不上）在 `removeControlPort` 的注释里
 * 逐条写了，不要只看一处。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getStoreDir } from "../storage/store.js";

/**
 * 端口文件的路径。
 *
 * 只有这一个函数拼路径。写 / 读 / 删三处都调它，用例也调它，所以改名只需要改这里
 * （下面那三个函数就是「谁在管这个文件」的完整名单）。
 */
export function controlPortPath(): string {
  return join(getStoreDir(), "control.port");
}

/** 写端口文件（监听成功之后调用一次）。 */
export function writeControlPort(port: number): void {
  const path = controlPortPath();
  mkdirSync(dirname(path), { recursive: true });
  // 临时文件 + rename：CLI 可能正好在这一次写的同时启动，半截内容会被当成
  // 「端口文件坏了」。`mode` 只在创建时生效，所以再显式设一次权限。
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${port}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * 读端口文件。文件不存在、读不了、内容不是 1..65535 的十进制数，一律回 `null`。
 *
 * 返回 `null` 的语义是「没有可用的控制端口」，调用方（`cli/control.ts`）因此退回本地
 * 路径。这里不删文件：删除是调用方对「连不上」这个事实的判断，读函数只读。
 */
export function readControlPort(): number | null {
  const path = controlPortPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * 删端口文件。
 *
 * 三个调用点：进程正常退出（`server/bootstrap.ts::shutdown`，SIGINT / SIGTERM 与面板
 * 的 shutdown 命令都走它）、监听关闭（`server/control-listener.ts` 的 `close()`）、
 * CLI 发现端口连不上。第三个是必须的：`kill -9` 时前两个都跑不到，端口文件会留在
 * 那里，下一条 CLI 命令就会先去连一个死端口。
 */
export function removeControlPort(): void {
  const path = controlPortPath();
  try {
    unlinkSync(path);
  } catch {
    /* 本来就不在（第一次运行、或另一个进程已经删了） */
  }
}
