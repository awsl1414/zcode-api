/**
 * Upstream traffic dumper — used for debugging "JSON request body" issues.
 *
 * Activated by env `ZCODE_DUMP_UPSTREAM=<path>` or the config switch
 * `logging.dump.enabled` (wired through the settings page): every proxied
 * request emits one JSONL line per phase, so the full request→response timeline
 * can be inspected offline. Inactive (no-op) when neither is on.
 *
 * Path resolution is three-tier, re-evaluated on **every** write:
 *
 *   1. env `ZCODE_DUMP_UPSTREAM` — the original entry point, unchanged;
 *   2. config `logging.dump.path` (non-empty string);
 *   3. config on without a path → the default file in the storage dir.
 *
 * The config side is a **startup snapshot** injected by the serve entry
 * (`setDumpConfig`): the settings page edits config.yaml, and the change takes
 * effect on the next restart — the same discipline as `settings.restartHint`.
 * Re-reading `dumpPath()` per write is what makes tests able to flip the switch
 * within one process (bun test shares module instances across files).
 *
 * Phase names **are** the logger's stage names, so a
 * timeline read from the dump and one read from the terminal speak the same
 * vocabulary:
 *
 *   intake        the client request as it arrived. 注意：body 没带 `model` 且
 *                 `config.defaultModel` 非空时，这里记的已是注入后的形状（决策
 *                 口径见 `default-model.ts` 文件头）—— dump 描述的是实际出线的
 *                 形状；原始客户端字节可用 `requestBytes` 与注入后的长度差还原。
 *   upstream-req  the request about to be sent. Emitted twice on purpose: once
 *                 after body transform (pre-routing URL), once on the wire
 *                 (routed URL + post-signing headers). The second one carries
 *                 `signed`, which is how you tell them apart.
 *   upstream-resp the first response bytes (status + TTFB)
 *   upstream-error-body  an upstream failure's response body. Error-only:
 *                 emitted solely for non-SSE responses with status >= 400, because
 *                 that body is where the reason lives and we used to drop it.
 *   stream-end    usage and timing once the SSE stream finished
 *
 * The dump stays deliberately larger than the logger: it keeps full bodies and
 * header sets, which the logger must not write (credentials would leak).
 *
 * Design constraints:
 * - Must NEVER affect request handling — all FS work is try/catch'd.
 * - Sensitive header values (Authorization / x-api-key / captcha tokens /
 *   proxy secrets) are masked to `abcd1234…wxyz` so fingerprints are visible
 *   while credentials stay redacted.
 * - Bodies are JSON.parsed and re-stringified when possible (for readability);
 *   otherwise emitted as the raw string.
 *
 * The dump file is line-oriented JSON (JSONL); each line is self-contained:
 *
 *   {"ts":"2026-07-31T12:00:00.000Z","reqId":"#001","phase":"intake", ...}
 *
 * Pair lines by `reqId` to reconstruct a full request timeline.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { DumpConfig } from "../config/types.js";
import { getStoreDir } from "../storage/store.js";

/** dump 文件在存储目录下的默认文件名（`~/.zcode-proxy/dump.jsonl`）。*/
export const DUMP_FILE = "dump.jsonl";

/**
 * 进程内的 dump 配置（`config.yaml` 的 `logging.dump`）。
 *
 * `null` = 没接配置（默认状态，包括所有直接调 `proxyRequest` 的测试）：此时只有
 * 环境变量能打开 dump。
 */
let dumpConfig: DumpConfig | null = null;

/**
 * 灌入 dump 配置。只在启动时调一次（`serve` 入口），之后不再更新：
 * 设置页改的是 `config.yaml`，重启后才生效（与 `settings.restartHint`
 * 同一条纪律，dump 不做热生效）。
 *
 * 测试用它注入配置；用完必须清（`bun test` 同进程跑所有文件，残留会让别的用例
 * 的 dump 悄悄打开）。
 */
export function setDumpConfig(next: DumpConfig | null): void {
  dumpConfig = next;
}

/**
 * 目标文件在每次写入时现算（三段式优先级）：环境变量 > 配置 `path` >
 * 配置开启时的默认路径。不缓存成模块常量是为了让配置开关在一次进程里可测
 * （`bun test` 同进程跑所有文件，模块只加载一次），也让「改配置要重启」的语义
 * 落在 setDumpConfig 的调用时机上，而不是这里。
 *
 * env 为空串按未设处理：它不表达任何「路径」，落到配置那一档继续解析。
 */
function dumpPath(): string | null {
  const env = process.env.ZCODE_DUMP_UPSTREAM;
  if (env !== undefined && env.trim() !== "") return env.trim();
  if (!dumpConfig || !dumpConfig.enabled) return null;
  const configured = dumpConfig.path.trim();
  return configured !== "" ? configured : join(getStoreDir(), DUMP_FILE);
}

/** Header names whose values must be masked before dumping. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-zcode-authorization",
  "x-api-key",
  "proxy-authorization",
  "proxy-api-key",
  "x-zcode-captcha-verify-param",
  "x-zcode-captcha-verify-region",
  "cookie",
]);

function maskHeaderValue(key: string, value: string): string {
  if (!SENSITIVE_HEADERS.has(key.toLowerCase())) return value;
  if (value.length <= 12) return "<redacted>";
  return `${value.slice(0, 8)}…${value.slice(-4)} (len=${value.length})`;
}

/** Convert a Headers object to a plain object with sensitive values masked. */
export function dumpHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of headers.entries()) {
    out[k] = maskHeaderValue(k, v);
  }
  return out;
}

/**
 * 一份报文落到 dump 里的形态：能解析成 JSON 就给结构化值（对象、数组、标量都可能
 * ——取决于上游发了什么），解析不了就原样字符串，没有报文就是 `undefined`。
 */
export type DumpBodyValue = string | number | boolean | null | undefined | DumpBodyValue[] | { [key: string]: DumpBodyValue };

/** Try to parse body as JSON for pretty emission; fall back to raw string. */
export function dumpBody(body: string | undefined | null): DumpBodyValue {
  if (body === undefined || body === null) return undefined;
  if (body.length === 0) return "";
  try {
    /* `JSON.parse` 回 any：这里就是边界，收窄到上面的域类型之后，下游拿到的
       要么是合法 JSON 值，要么是原始字符串，不会再有 unknown 泄出去。 */
    return JSON.parse(body) as DumpBodyValue;
  } catch {
    return body;
  }
}

interface DumpLine {
  ts: string;
  reqId: string;
  phase: string;
  [k: string]: unknown;
}

/**
 * Append one dump line. No-op when neither the env var nor the config switch is
 * active. All errors are swallowed — dumping must never break request
 * handling.
 */
export function dumpPhase(reqId: string, phase: string, data: Record<string, unknown>): void {
  const path = dumpPath();
  if (!path) return;
  try {
    const line: DumpLine = {
      ts: new Date().toISOString(),
      reqId,
      phase,
      ...data,
    };
    appendFileSync(path, JSON.stringify(line) + "\n", "utf-8");
  } catch {
    // intentional swallow — see header comment
  }
}

/** True when dumping is active (env var or config switch). Cheap check
 *  used to gate per-phase logic in handler. */
export function dumpEnabled(): boolean {
  return dumpPath() !== null;
}

/** 上游错误响应体的读取上限：够看到报错文案，不至于把大响应读进内存。*/
export const UPSTREAM_ERROR_BODY_LIMIT = 4096;

/**
 * 上游错误体里如果回显了凭据，打码后再落盘。
 *
 * 这是防回显，不是通用脱敏：只认最可能被上游原样抄回来的两种形态
 * （`Authorization: Bearer …` 与 `sk-…`）。真实的密钥不止这两种写法，
 * 覆盖面靠的是「响应体本来就不该带凭据」，不是这里的规则表。
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-<redacted>");
}

/**
 * 读一份响应体的前 `limit` 个字符，**不消耗原响应**。
 *
 * 用 `clone()` 在副本上读：原响应还要透传给客户端，直接 `text()` 会把流读干，
 * 客户端拿到空响应。副本读完就 cancel，别让 tee 的另一半一直挂着。
 *
 * 只给错误响应调用（非 SSE、状态码 >= 400）。SSE 上 clone 会把整条流缓冲
 * 进内存，正常响应则不值得为诊断复制一份。
 *
 * 失败一律返回 `undefined`：dump 不能影响请求处理（文件头的纪律）。`clone()` 在
 * 响应体已被读过时会抛 `TypeError`，那说明这条时间线没法再看正文，不是请求的错。
 */
export async function peekResponseBody(resp: Response, limit: number): Promise<string | undefined> {
  let copy: Response | undefined;
  try {
    copy = resp.clone();
    const text = await copy.text();
    const head = text.length > limit ? `${text.slice(0, limit)}…(${text.length} bytes total)` : text;
    return redactSecrets(head);
  } catch {
    return undefined;
  } finally {
    // 副本已经读完，cancel 只是把 tee 的另一半收干净；失败也吞掉。
    void copy?.body?.cancel().catch(() => undefined);
  }
}
