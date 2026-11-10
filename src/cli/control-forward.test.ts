/**
 * CLI 命令转发到运行中的 `serve`。
 *
 * 要钉住的是行为而不是实现：「改了不生效还报成功」这件事只有在**真的有一个进程**
 * 持有状态时才测得出来。所以每个用例都起一个真的回环控制监听（`control-listener.ts`）
 * 加一个内存账号仓 / broker（`inMemoryAccounts`），再从 CLI 侧发命令，最后断言那个
 * 监听背后的 broker 变没变。
 *
 * 五条失败分类也在这里：没有端口文件、端口不通、端口被别的服务占了、应答超时、
 * `shutdown` 的应答与退出顺序。每一条都对应一个用户会遇到的场景。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountFor, inMemoryAccounts, zhipuCredential } from "../accounts/testing.js";
import { LogBuffer } from "../log/buffer.js";
import { controlPortPath, readControlPort, writeControlPort } from "../runtime/control-port.js";
import type { ControlResponse } from "../control/control.js";
import { startServeControlListener } from "../server/control-listener.js";
import type { ServeControlListener } from "../server/control-listener.js";
import { createServeControl } from "../server/control-surface.js";
import { FORWARD_TIMEOUT_MS, runControl } from "./control.js";

let storeDir: string;
let previous: string | undefined;
let previousConfig: string | undefined;
/** 每个用例自己关监听；这里再兜一层，失败时也不会把套接字漏到下一个用例。 */
const openListeners: ServeControlListener[] = [];

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "zcode-control-forward-"));
  previous = process.env.ZCODE_PROXY_STORE_DIR;
  process.env.ZCODE_PROXY_STORE_DIR = storeDir;
  /* 配置文件也要隔离：本地路径的 CLI 读 `ZCODE_PROXY_CONFIG ?? config.yaml`，
     仓库根目录里出现一份真配置（例如开发者自己起 serve 用的）时，一次性 broker
     会带着配置里的同名代理起来，addProxy 的重复名检查就变成环境相关的假失败。 */
  previousConfig = process.env.ZCODE_PROXY_CONFIG;
  process.env.ZCODE_PROXY_CONFIG = join(storeDir, "absent-config.yaml");
});

afterEach(async () => {
  while (openListeners.length > 0) {
    const listener = openListeners.pop();
    await listener?.close().catch(() => {});
  }
  if (previous === undefined) delete process.env.ZCODE_PROXY_STORE_DIR;
  else process.env.ZCODE_PROXY_STORE_DIR = previous;
  if (previousConfig === undefined) delete process.env.ZCODE_PROXY_CONFIG;
  else process.env.ZCODE_PROXY_CONFIG = previousConfig;
  rmSync(storeDir, { recursive: true, force: true });
});

/** 一个「运行中的 serve」：内存账号仓 + broker + 真的控制监听。 */
async function startLiveServe(options: { shutdown?: () => void } = {}) {
  const { manager, broker } = inMemoryAccounts([accountFor(zhipuCredential(), { label: "a1" })]);
  const control = await createServeControl({
    portRef: { current: 0 },
    shutdown: options.shutdown ?? (() => {}),
    context: { accounts: manager, broker, logBuffer: new LogBuffer() },
  });
  const listener = await startServeControlListener({
    handleControl: control.handleControl,
    state: control.controlState,
    accounts: manager,
  });
  openListeners.push(listener);
  return { broker, manager, listener };
}

/** 捕获 CLI 的输出（`runControl` 的所有渲染都走 console）。 */
function captureConsole(): { text(): string; restore(): void } {
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const record = (...args: unknown[]): void => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  console.log = record;
  console.error = record;
  return {
    text: () => lines.join("\n"),
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}

/** 跑一条命令并返回它打印的东西。 */
async function runAndCapture(
  command: Parameters<typeof runControl>[0],
  json = false,
  options?: { forwardTimeoutMs?: number },
): Promise<string> {
  const captured = captureConsole();
  try {
    await runControl(command, json, options);
  } finally {
    captured.restore();
  }
  return captured.text();
}

/** 一个刚被释放的端口：文件存在、连得上会立刻 ECONNREFUSED。 */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** 收一个请求但永远不应答：模拟挂死（GC 停顿、SIGSTOP）的进程。 */
async function hangingServer(): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer(() => {
    /* 故意不回应 */
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function postControl(port: number, command: unknown): Promise<{ status: number; body: ControlResponse }> {
  const res = await fetch(`http://127.0.0.1:${port}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  return { status: res.status, body: (await res.json()) as ControlResponse };
}

describe("runControl — 转发到运行中的进程", () => {
  it("写命令改的是运行中进程的 broker，不是一次性进程自己的", async () => {
    const { broker, manager } = await startLiveServe();
    expect(broker.routing.strategy).toBe("sticky-hash");

    const output = await runAndCapture({ cmd: "setRoutingPolicy", routing: { strategy: "round-robin" } });

    // 运行中的那个 broker（额度采样器与面板读的就是它）真的变了。
    expect(broker.routing.strategy).toBe("round-robin");
    // policy.json 是 serve 侧写的：CLI 进程里那份 broker 根本没被建出来。
    const persisted = JSON.parse(readFileSync(join(storeDir, "policy.json"), "utf-8")) as {
      routing: { strategy: string };
    };
    expect(persisted.routing.strategy).toBe("round-robin");
    // 转发成功就不该出现「下次启动生效」的说明。
    expect(output).not.toContain("没有正在运行的实例");
    // 命令确实走了控制面（label 仍然在账号仓里，说明是同一个对象活着）。
    expect((await manager.list()).map((account) => account.label)).toEqual(["a1"]);
  });

  it("读命令拿到的是运行中进程的状态，不是磁盘上的状态", async () => {
    const { broker } = await startLiveServe();
    // 只在内存里改，policy.json 根本不存在：一次性进程会读到默认值 sticky-hash。
    broker.routing.strategy = "round-robin";
    expect(existsSync(join(storeDir, "policy.json"))).toBe(false);

    const output = await runAndCapture({ cmd: "getRoutingPolicy" }, true);
    const parsed = JSON.parse(output) as { routing: { strategy: string } };

    expect(parsed.routing.strategy).toBe("round-robin");
  });
});

describe("runControl — 没有运行中的进程", () => {
  it("没有端口文件时退回本地路径，并说明改动下次启动才生效", async () => {
    expect(readControlPort()).toBeNull();

    const output = await runAndCapture({ cmd: "setRoutingPolicy", routing: { mode: "only" } });

    expect(output).toContain("没有正在运行的实例");
    expect(output).toContain("改动已写入 policy.json，下次启动生效。");
    // 落盘照旧：先改配置再启动是正常用法，不能因为进程没跑就拒绝写。
    const persisted = JSON.parse(readFileSync(join(storeDir, "policy.json"), "utf-8")) as {
      routing: { mode: string };
    };
    expect(persisted.routing.mode).toBe("only");
  });

  it("本地读命令说的是「读的是文件」，不声称已经生效", async () => {
    const output = await runAndCapture({ cmd: "getRoutingPolicy" });

    expect(output).toContain("以上读的是本地文件，不是运行中进程的状态。");
    expect(output).not.toContain("下次启动生效");
  });

  it("本地路径只改内存的命令明说自己不会保留", async () => {
    // 出口代理表住在 broker 里，没有落盘（`accounts/proxies.ts` 的热调节面）：
    // 一次性进程加完就退出，这一行说明是用户唯一的线索。
    const output = await runAndCapture({ cmd: "addProxy", name: "home", url: "http://127.0.0.1:8080" });

    expect(output).toContain("这条命令只作用在当前进程上，退出后不会保留。");
  });

  it("本地路径的 shutdown 回明确失败，不假装进程退出了", async () => {
    const exitCode = process.exitCode;
    try {
      const output = await runAndCapture({ cmd: "shutdown" }, true);
      expect(JSON.parse(output)).toEqual({ ok: false, error: "shutdown_unavailable" });
      expect(output).not.toContain("shuttingDown");
    } finally {
      process.exitCode = exitCode ?? 0;
    }
  });

  it("端口文件存在但端口不通：退回本地，并删掉陈旧文件", async () => {
    const port = await closedPort();
    writeControlPort(port);

    const output = await runAndCapture({ cmd: "setRoutingPolicy", routing: { mode: "only" } });

    expect(output).toContain("下次启动生效");
    expect(readControlPort()).toBeNull();
    expect(existsSync(controlPortPath())).toBe(false);
  });

  it("端口被别的服务占了（应答不是 JSON）：退回本地，但不动端口文件", async () => {
    const other = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not the control protocol");
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", () => resolve()));
    const { port } = other.address() as AddressInfo;
    writeControlPort(port);

    try {
      const output = await runAndCapture({ cmd: "getRoutingPolicy" });
      expect(output).toContain("以上读的是本地文件");
      // 对面活着，端口文件不是陈旧的：删掉它会让下一条命令失去线索。
      expect(readControlPort()).toBe(port);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it("陈旧的端口文件不会让 CLI 挂死（超时以内退回本地）", async () => {
    const hanging = await hangingServer();
    writeControlPort(hanging.port);

    const startedAt = Date.now();
    try {
      const output = await runAndCapture({ cmd: "getRoutingPolicy" }, false, { forwardTimeoutMs: 100 });
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(output).toContain("以上读的是本地文件");
      expect(readControlPort()).toBeNull();
    } finally {
      await hanging.close();
    }
  });

  it("默认超时是 5 秒", () => {
    expect(FORWARD_TIMEOUT_MS).toBe(5000);
  });
});

describe("控制监听的端口文件", () => {
  it("监听成功写端口文件，close 之后删掉", async () => {
    const { listener } = await startLiveServe();
    expect(readControlPort()).toBe(listener.port);

    await listener.close();
    openListeners.length = 0;

    expect(readControlPort()).toBeNull();
    expect(existsSync(controlPortPath())).toBe(false);
  });

  it("close 不会删掉另一个 serve 的端口文件", async () => {
    const { listener } = await startLiveServe();
    const otherPort = listener.port === 65535 ? 1 : listener.port + 1;
    writeControlPort(otherPort);

    await listener.close();
    openListeners.length = 0;

    expect(readControlPort()).toBe(otherPort);
  });
});

describe("控制监听的 shutdown 时序", () => {
  it("先应答再退出（走的是包装过的 handleControl）", async () => {
    let shutdownCalls = 0;
    const { listener } = await startLiveServe({ shutdown: () => { shutdownCalls += 1; } });

    const reply = await postControl(listener.port, { cmd: "shutdown" });

    // 应答已经到手，退出还没开始。
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, event: "shuttingDown" });
    expect(shutdownCalls).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(shutdownCalls).toBe(1);
  });

  it("命令结果照原样回给调用方（非法策略回稳定错误码）", async () => {
    const { broker, listener } = await startLiveServe();

    const reply = await postControl(listener.port, { cmd: "setRoutingPolicy", routing: { strategy: "nope" } });

    expect(reply.body).toEqual({ ok: false, error: "invalid_routing_strategy" });
    expect(broker.routing.strategy).toBe("sticky-hash");
  });
});
