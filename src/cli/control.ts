import { existsSync } from "node:fs";
import { createControlDispatcher } from "../control/control.js";
import { readControlPort, removeControlPort } from "../runtime/control-port.js";
import { LogBuffer } from "../log/buffer.js";
import type { ControlCommand, ControlResponse, ControlState } from "../control/control.js";
import { loadConfig } from "../config/loader.js";
import { createBroker, openAccountStore } from "../accounts/runtime.js";
import { printAccountsTable, printExportResult } from "./render.js";
import { printRiskReport, printRoutingPolicy } from "./routing.js";

/** `--flag=value` 拆成 `--flag value`：JWT / 路径这类长值两种写法都常见。*/
export function splitFlagArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (eq > 0) out.push(arg.slice(0, eq), arg.slice(eq + 1));
    else out.push(arg);
  }
  return out;
}

/** 取 `--flag` 后面的值；缺值返回 `null`（调用方转成 `missing_value`）。*/
export function flagValue(args: readonly string[], index: number): string | null {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) return null;
  return value;
}

/** 子命令的失败出口（异步链路上的兜底打印：一行原因 + 非零退出码）。*/
export function cliFailure(scope: string): (err: unknown) => void {
  return (err: unknown) => {
    console.error(`${scope} failed: ${(err as Error).message}`);
    process.exitCode = 1;
  };
}

/**
 * 没有运行中的进程时用的控制面上下文（`forwardToRunning` 回了 `null` 才走到这里）。
 *
 * 与 `serve` 用**同一个** dispatcher，所以两个入口的语义一致。但它的 broker
 * 是这一秒才造出来的：进程退出就没了。`routing set` 这种命令在这里只能把值写进
 * `policy.json`，改不到任何正在跑的调度器（状态在那个进程的内存里）。所以
 * `runControl` 先在**运行中的进程**里执行命令，只有那里没有进程时才退回
 * 这份 dispatcher，并在输出末尾说明「下次启动生效」。
 *
 * 刻意不接 `quotaSamples`：额度采样是长驻进程的后台循环，一次性进程里没有缓存；
 * 为了填满一列而在 `account list` 里对每个账号打一次
 * 上游额度端点，正好是采样设计要消除的"定时全量探测"。查额度用 `zcode-proxy quota`。
 */
async function openCliControl(): Promise<(cmd: ControlCommand) => Promise<ControlResponse>> {
  const path = process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  // 没有 config.yaml 也能用：`Broker` 的构造参数全可选，缺省即 `DEFAULTS` 里那组值。
  const config = existsSync(path) ? loadConfig(path) : null;
  const accounts = await openAccountStore();
  const broker = await createBroker(accounts, config);
  const state: ControlState = {
    proxyPort: 0,
  };
  return createControlDispatcher(state, {
    accounts,
    broker,
    // 必须与 broker 拿到的是同一份 entries：生效策略是三方合成的。
    entries: config?.accounts?.entries ?? [],
    logBuffer: new LogBuffer(),
    // 登录授权链接的 `app_version` 跟随生效的客户端版本〔`undefined` = 探测〕
    identityAppVersion: config?.identity.appVersion,
    /*
     * 请求记录（`getRequests`）刻意不接：这是一次性进程，不处理任何
     * 请求，没有 `proxyRequest` 往里写。给它一个空仓只会让 `getRequests` 回一个空
     * 列表，而那看起来像「最近没有请求」。读请求记录用 `logs`，它直接读
     * `requests.jsonl`（`proxy/request-log.ts`）。
     */
  });
}

/**
 * 转发超时。进程挂死（GC 停顿、断点、被 SIGSTOP）时 CLI 不能跟着挂死。
 *
 * 5 秒是个折中：比任何一条控制命令的正常耗时都长一个数量级（最慢的是
 * `addAccount` 的凭据解析，那也不打上游），又短到用户会认为「这条命令失败了」
 * 而不是「终端卡了」。
 */
export const FORWARD_TIMEOUT_MS = 5000;

/**
 * 把命令发给正在运行的 `serve` 进程。
 *
 * 返回 `null` 表示「没有运行中的进程」，调用方退回本地一次性 dispatcher。网络层的
 * 失败一律不抛：进程没跑是常态，不是错误。
 *
 * 为什么不能先探测再发：协议只有 `POST /control`（`control/control-transport.ts`），
 * 没有任何一条 GET 能用来判断「对面活着」。所以直接发目标命令，`ECONNREFUSED` 就是
 * 「进程没跑」的答案。
 *
 * 失败分类：
 *
 *   端口文件不存在 / 内容不是端口号   → null（什么都不删）
 *   连不上（ECONNREFUSED）或超时     → 删掉陈旧的端口文件，再 null
 *   应答不是 JSON                    → null，但**不删**端口文件
 *   HTTP 400 / 500 但 body 是 JSON   → 原样返回（那是真实的命令结果）
 *
 * 第三种是「端口被别的服务占了」：对面活着，只是说的不是这套协议。第四条是
 * 「命令本身失败」（`invalid_routing_order` 之类），本地路径给不出这个答案，必须
 * 让用户看到。
 */
export async function forwardToRunning(
  command: ControlCommand,
  timeoutMs: number = FORWARD_TIMEOUT_MS,
): Promise<ControlResponse | null> {
  const port = readControlPort();
  if (port === null) return null;

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    /*
     * 连不上。端口文件是上一次运行留下的：`kill -9` 时进程没有机会清理，而留着一个
     * 死端口只会让下一条命令再等满一次超时。
     */
    removeControlPort();
    return null;
  }

  try {
    return (await res.json()) as ControlResponse;
  } catch {
    return null;
  }
}

/**
 * 跑一条控制面命令并渲染结果。`ok: false` 一律非零退出码（脚本据此判断）。
 *
 * 先试转发：改存储的命令只有交给持有状态的那个进程才会生效。读
 * 命令同样值得转发：运行中进程有真实在飞数、健康冷却与粘性表，一次性进程只有一份
 * 刚造出来的 broker。
 *
 * `options.forwardTimeoutMs` 只给用例用（把超时压到毫秒级，不必等满 5 秒）。
 */
export async function runControl(
  command: ControlCommand,
  json: boolean,
  options: { forwardTimeoutMs?: number } = {},
): Promise<void> {
  const forwarded = await forwardToRunning(command, options.forwardTimeoutMs);
  const res = forwarded ?? (await (await openCliControl())(command));
  if (!res.ok) {
    if (json) console.log(JSON.stringify(res, null, 2));
    else console.error(`error: ${res.error}`);
    process.exitCode = 1;
    return;
  }
  renderControlOk(res, json);
  if (forwarded === null && !json) printOfflineNote(command);
}

/**
 * 本地路径末尾的那行说明。
 *
 * 进程没跑时命令仍然要能落盘（先改配置再启动是正常用法），但一次性 broker 对任何
 * 命令都是假的。这一行存在的唯一理由，是不让「报告成功」继续骗人：写命令只落到了
 * 文件，读命令读的是文件加一个刚造出来的调度器。
 */
function printOfflineNote(command: ControlCommand): void {
  const target = OFFLINE_TARGET[command.cmd];
  if (target === null) {
    console.log("note: 没有正在运行的实例；以上读的是本地文件，不是运行中进程的状态。");
    return;
  }
  if (target === "process") {
    console.log("note: 没有正在运行的实例；这条命令只作用在当前进程上，退出后不会保留。");
    return;
  }
  console.log(`note: 没有正在运行的实例；改动已写入 ${target}，下次启动生效。`);
}

/**
 * 本地路径下一条命令落到哪里。
 *
 * 用的是全量 `Record`，所以 `ControlCommand` 加一条命令时编译器会要求在这里表态。
 * 漏一条的后果是它拿到「读」的说明，而那正是这次要修的谎话。
 *
 *   `null`          只读（读本地文件；进程在跑时转发过去就能拿到真实状态）
 *   `"process"`     只改当前进程的内存（一次性进程里等于什么都没留下）
 *   文件名          落在这份文件里，下次启动生效
 */
const OFFLINE_TARGET: Readonly<Record<ControlCommand["cmd"], string | "process" | null>> = {
  status: null,
  startOAuth: "process",
  deliverOAuthCode: "process",
  getLogs: null,
  getRequests: null,
  getRequestsHistory: null,
  getUsageStats: null,
  quota: null,
  getHealthObservation: null,
  shutdown: "process",
  listAccounts: null,
  addAccount: "accounts.json",
  removeAccount: "accounts.json",
  setAccountEnabled: "accounts.json",
  setAccountConcurrency: "accounts.json",
  setAccountWeight: "accounts.json",
  resetAccountOverrides: "accounts.json",
  getRoutingPolicy: null,
  setRoutingPolicy: "policy.json",
  getRiskReport: null,
  exportAccounts: null,
  importAccount: "accounts.json",
  checkUpdate: null,
  detectAppVersion: null,
  listApiKeys: null,
  createApiKey: "apikeys.json",
  setApiKeyEnabled: "apikeys.json",
  deleteApiKey: "apikeys.json",
  resetApiKeyUsage: "apikeys.json",
  listProxies: null,
  addProxy: "process",
  setProxy: "process",
  removeProxy: "process",
  setAccountProxy: "policy.json",
  // 四条 claim 命令：都只对运行中的进程有意义（scheduler 状态、实时
  // preview、hold 联动都在进程内存里）。一次性进程的本地路径没有对应物
  // （`zcode-proxy claim list|now` 是独立实现），按「只读」表态 —— 离线时
  // openCliControl 造的一次性 dispatcher 会回 claim_unavailable，这行说明
  // 不会说谎。
  getClaimOverview: null,
  previewClaimPlans: "process",
  listClaimPlanChoices: "process",
  claimNow: "process",
};

/** `ControlResponse` 的成功半边（`ControlOk` 未导出，用 `Extract` 取）。*/
export type ControlOkBody = Extract<ControlResponse, { ok: true }>;

/**
 * 成功结果的渲染：一个 `switch` 覆盖本阶段所有命令事件。
 *
 * `status` 的成功体是唯一没有 `event` 的变体（面板协议里的 `{state:"running"}`），所以
 * 先按 `in` 收窄一次；其余不归这些子命令管的事件落到 `default` 原样打成 JSON。
 */
function renderControlOk(res: ControlOkBody, json: boolean): void {
  if (json || !("event" in res)) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  switch (res.event) {
    case "accounts":
      printAccountsTable(res.accounts);
      return;
    case "accountAdded":
      console.log(`account added: ${res.label} (id ${res.idPrefix}…, routes: ${res.routes.join(", ")})`);
      return;
    case "accountRemoved":
      console.log(`account removed: ${res.label}${abortedNote(res.aborted)}`);
      return;
    case "accountEnabled":
      console.log(`account ${res.enabled ? "enabled" : "disabled"}: ${res.label}${abortedNote(res.aborted)}`);
      return;
    case "accountConcurrency":
      console.log(`account concurrency: ${res.label} → ${res.maxConcurrency}`);
      if (res.warning !== undefined) console.warn(`  ⚠ ${res.warning}`);
      return;
    case "accountWeight":
      console.log(`account weight: ${res.label} → ${res.weight}`);
      return;
    case "accountOverridesReset":
      console.log(`account overrides reset: ${res.label}${res.cleared ? "" : " (nothing to reset)"}`);
      return;
    case "routingPolicy":
      printRoutingPolicy(res.routing, res.stickiness);
      return;
    case "riskReport":
      printRiskReport(res.report);
      return;
    case "accountsExported":
      printExportResult(res);
      return;
    case "accountsImported":
      console.log(`imported ${res.imported} account(s): ${res.labels.join(", ") || "(none)"}`);
      return;
    default:
      console.log(JSON.stringify(res, null, 2));
      return;
  }
}

/** force 禁用/删除时被中止的在飞请求数（只有它非零才值得打一行）。*/
function abortedNote(aborted: number): string {
  return aborted > 0 ? ` (${aborted} in-flight request(s) aborted)` : "";
}
