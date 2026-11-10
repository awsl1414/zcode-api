import { existsSync } from "node:fs";
import { toAuthCredential } from "../accounts/manager.js";
import { accountDeviceMid } from "../accounts/device-mid.js";
import { loadConfig } from "../config/loader.js";
import { openAccountStore } from "../accounts/runtime.js";

export async function claimCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? "now";
  if (sub !== "list" && sub !== "now") {
    console.error("Usage: zcode-proxy claim [list|now]");
    process.exit(1);
  }
  const path = process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (!existsSync(path)) {
    console.error(`Config file not found: ${path} (run serve once or create it).`);
    process.exit(1);
  }
  const config = loadConfig(path);
  try {
    const { runClaimCli } = await import("../claim/runtime.js");
    await runClaimCli(config, await openAccountStore(), sub);
  } catch (err) {
    console.error(`claim failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

/**
 * `quota` subcommand — print the live quota snapshot: per-model credit buckets
 * (billing plane) and coding-plan usage windows (monitor plane). Reuses
 * collectQuotaSnapshot (same path GET /quota serves).
 */
export async function quotaCommand(): Promise<void> {
  const path = process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (!existsSync(path)) {
    console.error(`Config file not found: ${path} (run serve once or create it).`);
    process.exit(1);
  }
  const config = loadConfig(path);
  try {
    const { collectQuotaSnapshot } = await import("../server/routes-quota.js");
    const accounts = await openAccountStore();
    // 额度命令只打一个账号的额度（CLI 一次性输出）。没有默认账号概念之后取第一个
    // 启用的账号；要逐账号看额度用 `auth account list`（它带每账号额度摘要）。
    const account = (await accounts.list()).find((candidate) => candidate.enabled);
    if (!account) {
      console.error("Not logged in. Run: zcode-proxy auth login <zai|bigmodel>");
      process.exit(1);
    }
    const snap = await collectQuotaSnapshot(
      config,
      toAuthCredential(account.credential),
      // 额度平面是账号级的：billing 网关要求稳定的 X-Device-Mid，所以用
      // 这个账号自己的指纹，不是某个进程级全局值。
      accountDeviceMid(account) ?? "",
    );
    if (snap.balances.length === 0) {
      console.log("No balance windows reported by the billing endpoint.");
    }
    for (const b of snap.balances) {
      const exp = b.expiresAt ? ` · expires ${fmtQuotaExpiry(b.expiresAt)}` : "";
      console.log(`  ${b.showName || "(unnamed)"}: ${b.remainingUnits.toLocaleString("en-US")} / ${b.totalUnits.toLocaleString("en-US")} units${exp}`);
    }
    if (snap.codingPlan) {
      const { level, limits } = snap.codingPlan;
      if (limits.length === 0) {
        console.log("No coding-plan usage windows reported by the monitor endpoint.");
      }
      for (const l of limits) {
        const tier = level ? ` (${level})` : "";
        // Mirror of the official panel: remaining only. Upstream `unit`/`number` are
        // the window's period identity (unit=3&number=5 → 5h, unit=6 → weekly,
        // live TIME_LIMIT row: remaining=3894, number=1) — not a comparable total;
        // 总量要由 usage+remaining 反推，这里只报 remaining，不装总量。
        const identity =
          l.unit !== undefined || l.number !== undefined
            ? ` [window unit=${l.unit ?? "-"}×number=${l.number ?? "-"}]`
            : "";
        const amount =
          l.remaining !== undefined
            ? `${l.remaining.toLocaleString("en-US")}${identity} remaining`
            : "no usage numbers reported";
        const reset = l.nextResetTime !== undefined ? ` · resets ${fmtQuotaExpiry(l.nextResetTime)}` : "";
        console.log(`  coding-plan${tier}: [${l.type}] ${amount}${reset}`);
      }
    }
    for (const plan of snap.claimablePlans) {
      const grants = plan.entitlements
        .map((e) => `${e.showName || plan.name}: ${(e.grantUnits ?? 0).toLocaleString("en-US")} ${e.unitType}`)
        .join("; ");
      console.log(`  claimable: ${plan.name}${grants ? ` (${grants})` : ""}`);
    }
    for (const err of snap.errors) console.error(`  ⚠ ${err}`);
    if (snap.errors.length > 0) process.exitCode = 1;
  } catch (err) {
    console.error(`quota query failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

/** `YYYY-MM-DD HH:mm` local time; `expiresAt` may be seconds or milliseconds. */
function fmtQuotaExpiry(expiresAt: number): string {
  const d = new Date(expiresAt > 1e12 ? expiresAt : expiresAt * 1000);
  if (Number.isNaN(d.getTime())) return String(expiresAt);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
