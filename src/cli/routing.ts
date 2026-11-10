import type { AccountsRouting, AccountsStickiness, DrainedAction, RoutingMode, RoutingStrategy, SaturatedAction, StickinessSaturatedAction, WithinTierOrder } from "../accounts/routing.js";
import type { RouteKind } from "../accounts/types.js";
import type { ControlCommand, RiskReport, RoutingPolicyPatch, StickinessPolicyPatch } from "../control/control.js";
import { flagValue, runControl, splitFlagArgs } from "./control.js";
import { RISK_FIELD_WIDTH, TABLE_GAP, displayWidth, padTo } from "./render.js";
import { JSON_FLAG, printUsageError } from "./shared.js";

/** `routing show` / `routing set` 的输出：一行一个字段，便于 diff 与 grep。*/
export function printRoutingPolicy(routing: AccountsRouting, stickiness: AccountsStickiness): void {
  const rows: [string, string][] = [
    ["routing.order", routing.order.join(", ")],
    ["routing.withinTier", routing.withinTier],
    ["routing.mode", routing.mode],
    ["routing.strategy", routing.strategy],
    ["routing.onSaturated", routing.onSaturated],
    ["routing.onDrained", routing.onDrained],
    ["routing.onAuthFailed", routing.onAuthFailed],
    ["routing.queueTimeoutMs", String(routing.queueTimeoutMs)],
    ["routing.maxQueue", String(routing.maxQueue)],
    ["routing.maxTotalInflight", String(routing.maxTotalInflight)],
    ["stickiness.enabled", String(stickiness.enabled)],
    ["stickiness.ttlSeconds", String(stickiness.ttlSeconds)],
    ["stickiness.maxSessions", String(stickiness.maxSessions)],
    ["stickiness.onSaturated", stickiness.onSaturated],
    ["stickiness.overflowAfterMs", String(stickiness.overflowAfterMs)],
  ];
  const width = Math.max(...rows.map(([key]) => displayWidth(key)));
  for (const [key, value] of rows) console.log(`${padTo(key, width)}${TABLE_GAP}${value}`);
}

/** `risk report` 的输出：四段 + 告警（控制面必须能回答的六问）。*/
export function printRiskReport(report: RiskReport): void {
  const { deviceMid, sessions, inflight, failures } = report;
  /** 段内一行：`key` 按显示宽度右侧补空格（不手写对齐，中文键也不会错位）。*/
  const field = (key: string, value: string): void => console.log(`  ${padTo(key, RISK_FIELD_WIDTH)}${value}`);

  console.log("deviceMid (R1)");
  field("accounts:", String(deviceMid.accounts));
  for (const conflict of deviceMid.conflicts) {
    field("conflict:", `${conflict.deviceMid} <- ${conflict.labels.join(", ")}`);
  }

  console.log("sessions (R2)");
  field("bound:", `${sessions.bound}/${sessions.capacity}`);
  field("crossAccount:", String(sessions.crossAccount));

  console.log("inflight (R16)");
  field("total:", `${inflight.total}/${inflight.limit} (queue: ${inflight.queueDepth})`);
  for (const entry of inflight.perAccount) field(`${entry.label}:`, String(entry.inflight));

  if (failures.length > 0) {
    console.log("failures");
    for (const failure of failures) {
      const reason = failure.reason === undefined ? "" : ` (${failure.reason})`;
      console.log(`  ${failure.label} ${failure.route}: ${failure.status}${reason}`);
    }
  }
  console.log(`alerts: ${report.alerts.join(", ") || "(none)"}`);
}

/** `zcode-proxy routing <show|set>`。*/
export async function routingCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const json = args.includes(JSON_FLAG);
  const argv = splitFlagArgs(args.slice(1).filter((arg) => arg !== JSON_FLAG));

  if (sub === "show") {
    await runControl({ cmd: "getRoutingPolicy" }, json);
    return;
  }
  if (sub === "set") {
    const parsed = parseRoutingSetArgs(argv);
    if (!parsed.ok) return printUsageError("routing set", parsed.error, printRoutingHelp);
    const command: ControlCommand = {
      cmd: "setRoutingPolicy",
      ...(Object.keys(parsed.routing).length > 0 ? { routing: parsed.routing } : {}),
      ...(Object.keys(parsed.stickiness).length > 0 ? { stickiness: parsed.stickiness } : {}),
    };
    await runControl(command, json);
    return;
  }
  printRoutingHelp();
  process.exitCode = 1;
}

/** `zcode-proxy risk <report>`。*/
export async function riskCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const json = args.includes(JSON_FLAG);
  if (sub === "report") {
    await runControl({ cmd: "getRiskReport" }, json);
    return;
  }
  console.error("Usage: zcode-proxy risk report");
  process.exitCode = 1;
}

function printRoutingHelp(): void {
  console.log(`Usage:
  zcode-proxy routing show
  zcode-proxy routing set [--order a,b,c] [--within-tier sticky|drain-first|strategy]
                          [--mode prefer|only] [--strategy sticky-hash|balanced|round-robin]
                          [--on-saturated wait|overflow] [--on-drained fallback|stop]
                          [--queue-timeout-ms <n>] [--max-queue <n>] [--max-total-inflight <n>]
                          [--sticky on|off] [--sticky-ttl <n>] [--sticky-on-saturated wait|overflow|wait-then-overflow]
                          [--sticky-overflow-ms <n>]

Every subcommand accepts --json for machine-readable output.`);
}

/** `routing set` 的解析结果。*/
export type ParsedRoutingSet =
  | { ok: true; routing: RoutingPolicyPatch; stickiness: StickinessPolicyPatch }
  | { ok: false; error: string };

/**
 * 解析 `routing set`。
 *
 * 枚举与数字**只做拆分与类型转换**，合法性一律由 control 层用 `routing.ts` 的常量表
 * 判（唯一真源）：CLI 里再抄一份枚举，就是给"CLI 接受、面板拒绝"埋点。
 */
export function parseRoutingSetArgs(rawArgs: readonly string[]): ParsedRoutingSet {
  const args = splitFlagArgs(rawArgs);
  const routing: RoutingPolicyPatch = {};
  const stickiness: StickinessPolicyPatch = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--order") {
      const value = flagValue(args, i + 1);
      if (value === null) return { ok: false, error: "missing_value:--order" };
      i += 1;
      const order = value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      if (order.length === 0) return { ok: false, error: "missing_value:--order" };
      routing.order = order as RouteKind[];
      continue;
    }
    if (arg === "--mode" || arg === "--strategy" || arg === "--on-saturated" || arg === "--on-drained" || arg === "--sticky-on-saturated" || arg === "--within-tier") {
      const value = flagValue(args, i + 1);
      if (value === null) return { ok: false, error: `missing_value:${arg}` };
      i += 1;
      if (arg === "--mode") routing.mode = value as RoutingMode;
      else if (arg === "--strategy") routing.strategy = value as RoutingStrategy;
      else if (arg === "--on-saturated") routing.onSaturated = value as SaturatedAction;
      else if (arg === "--on-drained") routing.onDrained = value as DrainedAction;
      else if (arg === "--within-tier") routing.withinTier = value as WithinTierOrder;
      else stickiness.onSaturated = value as StickinessSaturatedAction;
      continue;
    }
    if (arg === "--sticky") {
      const value = flagValue(args, i + 1);
      if (value === null) return { ok: false, error: "missing_value:--sticky" };
      i += 1;
      if (value !== "on" && value !== "off") return { ok: false, error: "invalid_value:--sticky" };
      stickiness.enabled = value === "on";
      continue;
    }
    if (
      arg === "--queue-timeout-ms" ||
      arg === "--max-queue" ||
      arg === "--max-total-inflight" ||
      arg === "--sticky-ttl" ||
      arg === "--sticky-overflow-ms"
    ) {
      const raw = flagValue(args, i + 1);
      if (raw === null) return { ok: false, error: `missing_value:${arg}` };
      i += 1;
      const value = Number(raw);
      if (!Number.isInteger(value)) return { ok: false, error: `invalid_number:${arg}` };
      if (arg === "--queue-timeout-ms") routing.queueTimeoutMs = value;
      else if (arg === "--max-queue") routing.maxQueue = value;
      else if (arg === "--max-total-inflight") routing.maxTotalInflight = value;
      else if (arg === "--sticky-ttl") stickiness.ttlSeconds = value;
      else stickiness.overflowAfterMs = value;
      continue;
    }
    return { ok: false, error: `unknown_option:${arg}` };
  }

  if (Object.keys(routing).length === 0 && Object.keys(stickiness).length === 0) {
    return { ok: false, error: "nothing_to_set" };
  }
  return { ok: true, routing, stickiness };
}
