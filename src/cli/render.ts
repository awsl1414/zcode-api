import type { AccountQuotaSummary, AccountQuotaWindow, AccountSummary, MaskedAccount } from "../control/control.js";
import type { ControlOkBody } from "./control.js";

// ---------------------------------------------------------------------------
// 账号 / 路由 / 风控子命令
//
// 三条命令族（`auth account *` / `routing *` / `risk report`）**全部**走
// `createControlDispatcher`：它们是同一份命令表的第三个入口（另两个是回环的
// `POST /control` 与网页面板），所以 CLI 能做的事、面板也能做，
// 不存在"某个操作只有 CLI 有"的分叉。
//
// 本段只有**编排与渲染**：参数解析、表格化输出、退出码。业务逻辑一律在
// `accounts/`（校验、热调节、策略、额度），错误码由 control 层给出稳定字符串。
// ---------------------------------------------------------------------------

/** 机器可读输出的开关（脚本可编排）。*/
/**
 * 终端显示宽度里算 2 列的字符区间（CJK 全角、假名、韩文、全角标点）。
 *
 * 表格里既有英文列（label / kind / routes）又有中文列（状态 / 在飞 / 额度，
 * 与面板翻译表同一组词），只按 `String.length` 对齐会让中文列错位一半。
 */
const WIDE_CHAR_PATTERN =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** 表格列间距。*/
export const TABLE_GAP = "  ";

/** 没有值可显示的占位符。*/
const EMPTY_CELL = "—";

/** `risk report` 段内字段名的对齐宽度（最长的是 `crossAccount:`）。*/
export const RISK_FIELD_WIDTH = 14;

/** 账号表的表头（与面板账号页同列的 label / kind / routes / 状态 / 在飞 / 额度）。*/
const ACCOUNT_TABLE_HEADERS = ["LABEL", "KIND", "ROUTES", "状态", "在飞", "额度"] as const;

/** 导出成功事件（`printExportResult` 用）。*/
type ExportResult = Extract<ControlOkBody, { event: "accountsExported" }>;

/** 终端显示宽度（CJK 全角算 2 列）。*/
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += WIDE_CHAR_PATTERN.test(char) ? 2 : 1;
  return width;
}

/** 按显示宽度右侧补空格（表格对齐）。*/
export function padTo(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/** 通用表格渲染：按每列最大显示宽度对齐，行内不换行。*/
function printTable(headers: readonly string[], rows: readonly (readonly string[])[]): void {
  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index] ?? ""))),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, index) => padTo(cell, widths[index] ?? 0)).join(TABLE_GAP).trimEnd();
  console.log(line(headers));
  for (const row of rows) console.log(line(row));
}

/** 账号表的「状态」列：启停优先于健康（禁用账号的冷却与否不重要）。*/
function accountStatusCell(account: AccountSummary): string {
  if (!account.enabled) return "已禁用";
  if (account.health === "auth-invalid") return "凭据失效";
  if (account.health === "drained") return "额度耗尽";
  if (account.health === "cooling") return "冷却";
  return "ok";
}

/** 账号表的「额度」列：`remaining` 优先（无歧义），否则用 `percentage`。*/
function quotaCell(quota: AccountQuotaSummary | null): string {
  if (quota === null) return EMPTY_CELL;
  const parts: string[] = [];
  if (quota.credits !== undefined) {
    parts.push(`${quota.credits.remainingUnits}/${quota.credits.totalUnits}`);
  }
  for (const window of quota.windows) parts.push(`${window.type} ${windowUsage(window)}`);
  return parts.length > 0 ? parts.join(" ") : EMPTY_CELL;
}

/**
 * 单个额度窗口的用量表述。
 *
 * `remaining` 优先（无歧义）；否则报上游 `percentage`——契约是 **0..100 的已用百分数**
 * （官方展示端 `100 - percentage` 反转成剩余，见 `accounts/quota.ts::PERCENT_SCALE`）。
 * 早先用 `<= 1 ? *100 : value` 猜刻度，于是 `percentage: 1`（1% 已用）被打成
 * 「100%」；同一个误读在判定层造成了 drained 误判。现在一律按百分数直读。
 */
function windowUsage(window: AccountQuotaWindow): string {
  if (window.remaining !== undefined) return `${window.remaining} left`;
  if (window.percentage === undefined) return "n/a";
  return `${Math.round(Math.max(0, Math.min(100, window.percentage)))}%`;
}

/** `auth account list` 的表格。*/
export function printAccountsTable(accounts: readonly AccountSummary[]): void {
  if (accounts.length === 0) {
    console.log("No accounts. Add one: zcode-proxy auth account add --label <name> --jwt <token>");
    return;
  }
  const rows = accounts.map((account) => [
    account.label,
    account.kind,
    account.routes.join(","),
    accountStatusCell(account),
    `${account.inflight}/${account.maxConcurrency}`,
    quotaCell(account.quota),
  ]);
  printTable(ACCOUNT_TABLE_HEADERS, rows);
  // 一次性进程没有采样缓存（见 `openCliControl`）：只在整列都空时说一句，避免噪音。
  if (accounts.every((account) => account.quota === null)) {
    console.log("note: 额度 needs the sampling loop (long-running process); use `zcode-proxy quota`.");
  }
}

/** 导出结果：加密/明文打路径，掩码清单打表格（永不回显凭据原文）。*/
export function printExportResult(res: ExportResult): void {
  if (res.path !== undefined) {
    console.log(`exported ${res.count} account(s) → ${res.path}`);
    return;
  }
  printMaskedTable(res.accounts ?? []);
}

/** 掩码清单表格（label / provider / routes / 指纹前缀）。*/
function printMaskedTable(accounts: readonly MaskedAccount[]): void {
  if (accounts.length === 0) {
    console.log("No accounts.");
    return;
  }
  printTable(
    ["LABEL", "KIND", "PROVIDER", "ROUTES", "ID"],
    accounts.map((account) => [account.label, account.kind, account.provider, account.routes.join(","), account.idPrefix]),
  );
}
