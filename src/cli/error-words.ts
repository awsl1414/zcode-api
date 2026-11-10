/**
 * CLI 的错误用户词（面板 i18n 的 CLI 侧消费层）。
 *
 * 与网页面板**同源**：直接读 `server/web/i18n/{zh,en}.json` 的
 * `errorCode.<code>` / `.hint` 两组键，不另写一份 CLI 词表——分类学或文案变化时
 * 三个出口（健康 / 统计 / 展示）永远一致，终端与面板也永远同词同 hint。
 *
 * 语言只由 `ZCODE_CLI_LANG` 决定（`zh` / `en`；缺省 zh，与面板的中文原文一致）。
 * 不猜系统 locale：CLI 输出要能被脚本稳定解析，宿主语言不该悄悄改文案。
 */
import zhDictionary from "../server/web/i18n/zh.json" with { type: "json" };
import enDictionary from "../server/web/i18n/en.json" with { type: "json" };
import type { ErrorCode } from "../proxy/error-codes.js";

type Dictionary = Record<string, string>;

const DICTS: Record<"zh" | "en", Dictionary> = {
  zh: zhDictionary as Dictionary,
  en: enDictionary as Dictionary,
};

function activeDictionary(): Dictionary {
  return DICTS[process.env.ZCODE_CLI_LANG === "en" ? "en" : "zh"];
}

/** errorCode → 用户词（面板 `errorCode.<code>` 的同一个键）。*/
export function errorUserWord(code: ErrorCode): string {
  return activeDictionary()[`errorCode.${code}`] ?? `errorCode.${code}`;
}

/** errorCode → hint（面板 `errorCode.<code>.hint` 的同一个键）。*/
export function errorUserHint(code: ErrorCode): string {
  return activeDictionary()[`errorCode.${code}.hint`] ?? "";
}

/**
 * 一行给用户看的失败摘要：`用户词（怎么办：hint）`。
 *
 * detail 原文不在这里：它由 `record.error` 在 `reason=` 上单独保留（排障用）。
 */
export function errorUserLine(code: ErrorCode): string {
  const hint = errorUserHint(code);
  return hint === "" ? errorUserWord(code) : `${errorUserWord(code)}（${activeDictionary()["errorCode.hintPrefix"] ?? ""}${hint}）`;
}
