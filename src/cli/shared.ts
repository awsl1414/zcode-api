import { VERSION } from "../version.js";
/**
 * 子命令的公共字面量，**必须**声明在 `main()` 调用之前。
 *
 * `main()` 在模块顶部同步执行，而模块其余常量要等模块求值结束才初始化 —— 那时再读
 * 就是 TDZ（`ensureDeviceMidInConfig` 的注释里记录过同一个坑）。只有**同步路径**
 * （参数解析）会读到的常量才需要放在这里，渲染层的常量留在各自附近。
 */
export const JSON_FLAG = "--json";

/** 参数错误的统一出口：一行原因 + 用法，非零退出码。*/
export function printUsageError(scope: string, error: string, help: () => void): void {
  console.error(`${scope}: ${error}`);
  help();
  process.exitCode = 1;
}

export function printHelp(): void {
  console.log(`zcode-proxy ${VERSION}

Usage:
  zcode-proxy                       Start the proxy + web panel (default):
                                    prints the panel URL + one-time admin
                                    password (first boot), opens it
  zcode-proxy [debug] [config.yaml] Same, with debug diagnostics / custom config
  zcode-proxy --no-panel            Start the proxy only (no web panel)
  zcode-proxy serve [--no-panel] [config.yaml]
                                    Start the proxy server
  zcode-proxy serve debug [config.yaml]
                                    Start with verbose per-request diagnostics
  zcode-proxy --cli                 Classic CLI mode (bare --cli = serve)
  zcode-proxy auth login <provider> Login via OAuth (provider: zai | bigmodel)
  zcode-proxy auth login <provider> --import
                                    Import API key from ~/.zcode/v2/config.json
  zcode-proxy auth import [--file <path>] [--provider <zai|bigmodel>] [--replace]
                                    Import an existing ZCode account from its
                                    credential store (default
                                    ~/.zcode/v2/credentials.json): the OAuth
                                    token becomes the coding-plan API key
  zcode-proxy auth import --jwt <token>
                                    Import a pasted plan JWT (start-plan,
                                    quota and claim; MCP, async and highspeed
                                    also need the coding-plan API key)
  zcode-proxy auth status           Show the account table
  zcode-proxy auth account list     List accounts (label/kind/routes/health/inflight/quota)
  zcode-proxy auth account add --label <name> (--file <path>|--jwt <token>)
                                    Add an account without re-running OAuth
  zcode-proxy auth account enable|disable <label> [--force]
                                    Hot-enable / hot-disable (--force aborts in-flight)
  zcode-proxy auth account concurrency <label> <n>
                                    Set the per-account concurrency limit (0 = soft off)
  zcode-proxy auth account weight <label> <n>
                                    Set the selection weight
  zcode-proxy auth account remove <label> [--force]
                                    Remove an account (drains in-flight by default)
  zcode-proxy auth account export [--encrypted|--plain|--masked] [--out <path>]
                                    Export accounts (encrypted by default; --plain needs --force)
  zcode-proxy auth account import <path> [--password <pw>]
                                    Import an export bundle or a ZCode credential file
  zcode-proxy routing show          Show the routing / stickiness policy
  zcode-proxy routing set --order a,b,c [--within-tier sticky|drain-first|strategy]
                                    Change the routing policy (also --mode prefer|only,
                                    --strategy, --on-saturated, --on-drained,
                                    --queue-timeout-ms, --max-queue,
                                    --max-total-inflight, --sticky, --sticky-ttl, ...)
  zcode-proxy risk report           Risk-control report (deviceMid, sessions, inflight)
  zcode-proxy claim [list|now]      List / claim weekend-plan trial packages
  zcode-proxy quota                 Show plan quota (per-model remaining/total)
  zcode-proxy logs --req <reqId>    Print every phase of one request (reads the dump)
  zcode-proxy logs --last <n>       One summary line for the n most recent requests
  zcode-proxy logs --failed         Only the failed requests, with the failing phase
  zcode-proxy version               Show version
  zcode-proxy help                  Show this help

Examples:
  zcode-proxy                       Proxy + web panel: accounts, routing, logs
  zcode-proxy debug                 Same, with per-request diagnostics
  zcode-proxy --no-panel            Headless: proxy only (Docker / no browser)
  zcode-proxy serve debug           CLI: start with extra debug logging
  zcode-proxy auth login bigmodel   OAuth login for Bigmodel
  zcode-proxy auth login bigmodel --import
                                    Import existing key from ZCode config
  zcode-proxy auth import           Import account from ZCode credential store
  zcode-proxy auth import --jwt …   Import a pasted plan JWT
  zcode-proxy auth status           Check if logged in
  zcode-proxy auth account list     See every account and its live state
  zcode-proxy routing show          See the current routing policy
  zcode-proxy risk report           Check deviceMid independence and inflight
`);
}
