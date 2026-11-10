import type { AccountSource, ControlCommand, ExportFormat } from "../control/control.js";
import { defaultCredentialsPath } from "../auth/import.js";
import type { ProviderId } from "../provider/types.js";
import { flagValue, runControl, splitFlagArgs } from "./control.js";
import { JSON_FLAG, printUsageError } from "./shared.js";

/** `auth account export` 的默认格式：加密包（明文导出需显式 `force`）。*/
const DEFAULT_EXPORT_FORMAT: ExportFormat = "encrypted";

/** `zcode-proxy auth account <sub>`。*/
export async function accountCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const json = args.includes(JSON_FLAG);
  const argv = splitFlagArgs(args.slice(1).filter((arg) => arg !== JSON_FLAG));

  switch (sub) {
    case "list":
      await runControl({ cmd: "listAccounts" }, json);
      return;

    case "add": {
      const parsed = parseAccountAddArgs(argv);
      if (!parsed.ok) return printUsageError("auth account add", parsed.error, printAccountHelp);
      const command: ControlCommand = {
        cmd: "addAccount",
        label: parsed.label,
        source: parsed.source,
        ...(parsed.file !== undefined ? { file: parsed.file } : {}),
        ...(parsed.jwt !== undefined ? { jwt: parsed.jwt } : {}),
        ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
      };
      await runControl(command, json);
      return;
    }

    case "enable":
    case "disable": {
      const label = argv[0];
      if (label === undefined) return printUsageError(`auth account ${sub}`, "label_required", printAccountHelp);
      const force = argv.includes("--force");
      await runControl(
        { cmd: "setAccountEnabled", label, enabled: sub === "enable", ...(force ? { force } : {}) },
        json,
      );
      return;
    }

    case "concurrency":
    case "weight": {
      const label = argv[0];
      const raw = argv[1];
      if (label === undefined || raw === undefined) {
        return printUsageError(`auth account ${sub}`, "label_and_value_required", printAccountHelp);
      }
      const value = Number(raw);
      if (!Number.isInteger(value)) return printUsageError(`auth account ${sub}`, "invalid_number", printAccountHelp);
      await runControl(
        sub === "concurrency"
          ? { cmd: "setAccountConcurrency", label, maxConcurrency: value }
          : { cmd: "setAccountWeight", label, weight: value },
        json,
      );
      return;
    }

    case "remove": {
      const label = argv[0];
      if (label === undefined) return printUsageError("auth account remove", "label_required", printAccountHelp);
      // `--force` = 不等在飞结束（删除默认 drain）。
      const force = argv.includes("--force");
      await runControl({ cmd: "removeAccount", label, drain: !force }, json);
      return;
    }

    case "export": {
      const parsed = parseAccountExportArgs(argv);
      if (!parsed.ok) return printUsageError("auth account export", parsed.error, printAccountHelp);
      const command: ControlCommand = {
        cmd: "exportAccounts",
        format: parsed.format,
        ...(parsed.out !== undefined ? { out: parsed.out } : {}),
        ...(parsed.password !== undefined ? { password: parsed.password } : {}),
        ...(parsed.force ? { force: true } : {}),
      };
      await runControl(command, json);
      return;
    }

    case "import": {
      const path = argv[0];
      if (path === undefined) return printUsageError("auth account import", "path_required", printAccountHelp);
      const passwordFlag = argv.indexOf("--password");
      const password = passwordFlag >= 0 ? flagValue(argv, passwordFlag + 1) : null;
      if (passwordFlag >= 0 && password === null) {
        return printUsageError("auth account import", "missing_value:--password", printAccountHelp);
      }
      await runControl(
        { cmd: "importAccount", path, ...(password !== null ? { password } : {}) },
        json,
      );
      return;
    }

    default:
      printAccountHelp();
      process.exitCode = 1;
      return;
  }
}

function printAccountHelp(): void {
  console.log(`Usage:
  zcode-proxy auth account list
  zcode-proxy auth account add --label <name> (--file <path> | --jwt <token>)
  zcode-proxy auth account enable|disable <label> [--force]
  zcode-proxy auth account concurrency <label> <n>
  zcode-proxy auth account weight <label> <n>
  zcode-proxy auth account remove <label> [--force]
  zcode-proxy auth account export [--encrypted|--plain|--masked] [--out <path>] [--password <pw>] [--force]
  zcode-proxy auth account import <path> [--password <pw>]

Every subcommand accepts --json for machine-readable output.

  --file <path>   ZCode credential file (default: ${defaultCredentialsPath()})
  --jwt <token>   A plan JWT pasted directly (start-plan only)
  --force         enable/disable/remove without draining in-flight requests
  --plain         export credentials in clear text (also needs --force)
  --encrypted     export an AES-GCM bundle (default; needs --password)
  --masked        print a label/provider/routes/fingerprint list (no secrets)`);
}

// ---------------------------------------------------------------------------
// 子命令参数解析（纯函数，导出给用例：参数错误不该需要建账号仓才能验证）
// ---------------------------------------------------------------------------

/** `auth account add` 的解析结果。*/
export type ParsedAccountAdd =
  | {
      ok: true;
      label: string;
      source: AccountSource;
      file?: string;
      jwt?: string;
      provider?: ProviderId;
    }
  | { ok: false; error: string };

/**
 * 解析 `auth account add`。
 *
 * 两个来源互斥（`--file` / `--jwt`）：它们最终落到同一个凭据形状上，同时给两个只会
 * 让"到底用了哪个"变成猜测，所以直接拒。手工 `{apiKeyId}.{secret}` 凭据走
 * `--file`（`auth/import.ts` 认这个形态），没有单独的 `--api-key` 入口。
 */
export function parseAccountAddArgs(rawArgs: readonly string[]): ParsedAccountAdd {
  const args = splitFlagArgs(rawArgs);
  let label: string | undefined;
  let file: string | undefined;
  let jwt: string | undefined;
  let provider: ProviderId | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (
      arg === "--label" ||
      arg === "--file" ||
      arg === "--jwt" ||
      arg === "--provider"
    ) {
      const value = flagValue(args, i + 1);
      if (value === null) return { ok: false, error: `missing_value:${arg}` };
      i += 1;
      if (arg === "--label") label = value;
      else if (arg === "--file") file = value;
      else if (arg === "--jwt") jwt = value;
      else if (arg === "--provider") {
        if (value !== "zai" && value !== "bigmodel") return { ok: false, error: "invalid_provider" };
        provider = value;
      }
      continue;
    }
    return { ok: false, error: `unknown_option:${arg}` };
  }

  const sources = [file, jwt].filter((value) => value !== undefined);
  if (sources.length === 0) return { ok: false, error: "source_required" };
  if (sources.length > 1) return { ok: false, error: "conflicting_sources" };
  if (label === undefined || label.trim().length === 0) return { ok: false, error: "label_required" };

  return {
    ok: true,
    label: label.trim(),
    source: file !== undefined ? "file" : "jwt",
    ...(file !== undefined ? { file } : {}),
    ...(jwt !== undefined ? { jwt } : {}),
    ...(provider !== undefined ? { provider } : {}),
  };
}

/** `auth account export` 的解析结果。*/
export type ParsedAccountExport =
  | { ok: true; format: ExportFormat; out?: string; password?: string; force: boolean }
  | { ok: false; error: string };

/** 解析 `auth account export`：三种格式互斥，缺省 `encrypted`。*/
export function parseAccountExportArgs(rawArgs: readonly string[]): ParsedAccountExport {
  const args = splitFlagArgs(rawArgs);
  let format: ExportFormat | undefined;
  let out: string | undefined;
  let password: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--encrypted" || arg === "--plain" || arg === "--masked") {
      const next: ExportFormat = arg === "--plain" ? "plain" : arg === "--masked" ? "masked" : "encrypted";
      if (format !== undefined && format !== next) return { ok: false, error: "conflicting_formats" };
      format = next;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--out" || arg === "--password") {
      const value = flagValue(args, i + 1);
      if (value === null) return { ok: false, error: `missing_value:${arg}` };
      i += 1;
      if (arg === "--out") out = value;
      else password = value;
      continue;
    }
    return { ok: false, error: `unknown_option:${arg}` };
  }

  return {
    ok: true,
    format: format === undefined ? DEFAULT_EXPORT_FORMAT : format,
    ...(out !== undefined ? { out } : {}),
    ...(password !== undefined ? { password } : {}),
    force,
  };
}
