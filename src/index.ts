/**
 * Entry point — resolve the invocation (serve vs classic CLI) and hand off.
 *
 * The heavy lifting lives next to what it serves: `server/bootstrap.ts` for the
 * serve/panel lifecycle, `cli/*` for the subcommands. This file keeps only the
 * entry wiring: argv parsing, subcommand dispatch, and `printHelp`.
 */
import net from "node:net";

// Process-wide Happy Eyeballs: z.ai/alicdn CDN IPv6 answers are intermittently
// blackholed and Node's fetch (undici) does not race address families, so a
// v6-first DNS answer wedges outbound requests (captcha config/solves end in a
// persistent 503 on IPv6-preferring networks; NOTEPAD「3.17.1 增补」). Node-only
// API; Bun's node:net shim ignores it and carries its own connect behavior.
try {
  if (typeof net.setDefaultAutoSelectFamily === "function") {
    net.setDefaultAutoSelectFamily(true);
    if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === "function") {
      net.setDefaultAutoSelectFamilyAttemptTimeout(250);
    }
  }
} catch { /* never fatal */ }

import { serve } from "./server/bootstrap.js";
import { authCommand } from "./cli/auth.js";
import { claimCommand, quotaCommand } from "./cli/claim.js";
import { logsCommandAsync } from "./cli/logs.js";
import { cliFailure } from "./cli/control.js";
import { printHelp } from "./cli/shared.js";
import { riskCommand, routingCommand } from "./cli/routing.js";
import { VERSION } from "./version.js";

/**
 * 子命令的公共字面量，**必须**声明在 `main()` 调用之前。
 *
 * `main()` 在模块顶部同步执行，而模块其余常量要等模块求值结束才初始化，那时再读
 * 就是 TDZ（`config/edit.ts::ensureDeviceMidInConfig` 的注释里记录过同一个坑）。
 * 只有**同步路径**（参数解析）会读到的常量才留在这里；`--json` 是 CLI 子命令的
 * 字面量，放在 `cli/shared.ts`，渲染层的常量留在 `cli/render.ts`。
 */
const NO_PANEL_FLAG = "--no-panel";

/** `serve` 的 debug 开关（`zcode-proxy debug` / `serve debug` 两种写法都认）。*/
const DEBUG_TOKEN = "debug";

if (require.main === module) main();

export interface ServeArgs {
  configPath?: string;
  debug: boolean;
  /** `--no-panel`: skip the web panel for this start (headless / Docker). */
  noPanel: boolean;
}

/**
 * Parse `serve` subcommand arguments. The token `debug` toggles debug mode,
 * `--no-panel` disables the web panel, and any other token is treated as the
 * config path. Order-independent:
 *   []                     → { debug: false, noPanel: false }
 *   ["debug"]              → { debug: true, noPanel: false }
 *   ["--no-panel"]         → { debug: false, noPanel: true }
 *   ["my.yaml"]            → { configPath: "my.yaml", debug: false, noPanel: false }
 *   ["debug","x.yaml"]     → { configPath: "x.yaml", debug: true, noPanel: false }
 *   ["x.yaml","debug"]     → { configPath: "x.yaml", debug: true, noPanel: false }
 */
export function parseServeArgs(args: readonly string[]): ServeArgs {
  return {
    configPath: args.find((a) => a !== DEBUG_TOKEN && a !== NO_PANEL_FLAG),
    debug: args.includes(DEBUG_TOKEN),
    noPanel: args.includes(NO_PANEL_FLAG),
  };
}

function main(): void {
  try {
    runCli();
  } catch (err) {
    process.stderr.write(`zcode-proxy: uncaught error: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  }
}

/**
 * 一次启动的走向：`serve`（默认面）还是一条 CLI 子命令。
 *
 * **裸调用就是 serve**：`zcode-proxy`、`zcode-proxy debug`、`zcode-proxy my.yaml`、
 * `zcode-proxy --no-panel` 全部落到 serve + 网页面板；`tui` 不是别名，会走 CLI
 * 分派并得到明确的"已移除"错误。
 * 只有显式的 `--cli` 前缀回到经典子命令分派（裸 `--cli` = serve）。
 */
export type Invocation =
  | { kind: "serve"; args: ServeArgs }
  | { kind: "cli"; args: string[] };

/** `*.yaml` / `*.yml` 也是 serve 的简写：直接给配置文件路径就是启动服务，
 *  不必先写 `serve`（`zcode-proxy config.yaml`）。*/
function isConfigPathToken(token: string): boolean {
  return token.endsWith(".yaml") || token.endsWith(".yml");
}

export function resolveInvocation(argv: readonly string[]): Invocation {
  const [first] = argv;
  if (first === "--cli") return { kind: "cli", args: argv.slice(1) };
  if (first === undefined || first === DEBUG_TOKEN || first === NO_PANEL_FLAG || isConfigPathToken(first)) {
    return { kind: "serve", args: parseServeArgs(argv) };
  }
  return { kind: "cli", args: [...argv] };
}

function runCli(): void {
  const invocation = resolveInvocation(process.argv.slice(2));
  if (invocation.kind === "serve") {
    void serve(invocation.args);
    return;
  }
  dispatchCli(invocation.args);
}

/** Classic CLI dispatch — subcommand routing where bare = serve. */
function dispatchCli(args: string[]): void {
  const cmd = args[0] ?? "serve";

  if (cmd === "auth") {
    authCommand(args.slice(1));
  } else if (cmd === "claim") {
    void claimCommand(args.slice(1));
  } else if (cmd === "quota") {
    void quotaCommand();
  } else if (cmd === "logs") {
    // 按请求追溯：读的是 dump 文件，所以一次性进程里也能用（见 cli/logs.ts 文件头）。
    void logsCommandAsync(args.slice(1));
  } else if (cmd === "routing") {
    void routingCommand(args.slice(1)).catch(cliFailure("routing"));
  } else if (cmd === "risk") {
    void riskCommand(args.slice(1)).catch(cliFailure("risk"));
  } else if (cmd === "tui") {
    // 终端界面已移除，网页面板接管了它的全部功能。这里必须**明确报错**而不是静默
    // 退回 serve：静默会让「我以为我在 TUI 里」变成一句跑完就没的日志。
    console.error(
      "The terminal UI was removed in 5.0. Use `zcode-proxy` for the web panel,\n" +
        "or `zcode-proxy --cli <cmd>` for the classic CLI.",
    );
    process.exit(1);
  } else if (cmd === "serve" || cmd === DEBUG_TOKEN || cmd === NO_PANEL_FLAG || isConfigPathToken(cmd)) {
    const serveArgs = cmd === "serve" ? parseServeArgs(args.slice(1)) : parseServeArgs(args);
    void serve(serveArgs);
  } else if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(`zcode-proxy ${VERSION}`);
  } else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
  } else {
    console.error(`Unknown command: ${cmd}\n`);
    printHelp();
    process.exit(1);
  }
}
