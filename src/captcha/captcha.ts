/**
 * Aliyun Captcha V3 front-end -- config fetch + pre-solved token pool.
 *
 * Solving itself lives in captcha-happy.ts (in-process happy-dom solver,
 * production-proven, self-contained: bundled into the single-file release
 * binary -- no external Node.js, no browser, no jsdom). Tokens are minted
 * into a pool (captcha-pool.ts); requests take an already-solved token
 * (sub-ms) while background refills keep the pool warm -- the hot path
 * never waits on a solve.
 *
 * Fingerprint stability: the happy-dom solver's polyfill/guest-patch values
 * are deterministic and STABLE (never randomized) -- Aliyun's risk engine
 * correlates fingerprint stability across requests; randomizing per-solve
 * flags it as `verifyCode: F001`. See captcha-happy.ts.
 *
 * 账号作用域：token 池按 `accountId` 分（`captcha-pool.ts`
 * 的 `Map<accountId, CaptchaTokenPool>`），本模块的每个取 token 入口都必须带
 * 账号。混用一个池会让 A 的流量把 B 的池喂大，两个账号的验证码频率叠成一条
 * 机器特征。配置快照（`cachedConfig` / `lastGoodCfg`）仍是全局的：它是
 * zcode.z.ai 的客户端配置，不是账号属性。
 */
import { shutdownCaptchaSolver } from "./captcha-solver.js";
import { captchaEnvPositiveInt } from "./captcha-env.js";
import {
  configureCaptchaPool,
  prefillCaptchaPool,
  takeCaptchaToken,
  startCaptchaPoolRefill,
  stopCaptchaPool,
  touchCaptchaDemand,
  type CaptchaConfig,
} from "./captcha-pool.js";

const CAPTCHA_HEADER = "x-aliyun-captcha-verify-param";
const REGION_HEADER = "x-aliyun-captcha-verify-region";
const CONFIGS_API = "https://zcode.z.ai/api/v1/client/configs";

interface FetchedCaptchaConfig { enabled: boolean; prefix: string; sceneId: string; region: string; }
// Config snapshot — mirrors the real client's host `getClientConfigs`
// (3.16.3 codingPlanSubscription): 1h TTL (`RRe=3600*1e3`), 15s timeout
// (`Js=15e3`), in-flight request dedup, and NO negative cache — a failed
// response said (absent captcha field included); only SUCCESSFUL fetches
// write it. The old 60s TTL + 15s neg-cache was a self-invented cadence
// refreshing 60× more often than the real client; it manufactured the #002
// "Captcha config unavailable" storm.
let cachedConfig: { value: FetchedCaptchaConfig | null; expiresAt: number } = { value: null, expiresAt: 0 };
let configsFetchInFlight: Promise<FetchedCaptchaConfig | null> | null = null;
// Last successfully fetched config, including an authoritative disable.
// Its region keeps serving pool takes through configs-fetch outages without
// resurrecting a previously enabled config after the server disables it.
let lastGoodCfg: FetchedCaptchaConfig | null = null;

type ConfigsFetch = typeof fetch;
let configsFetch: ConfigsFetch | null = null;
/** Test seam for the configs fetch — production code never calls this. */
export function __setConfigsFetchForTests(impl: ConfigsFetch | null): void {
  configsFetch = impl;
}

/** Test seam: clear the config caches — tests only. `keepLastGood` preserves
 *  the outage-fallback config (simulates snapshot expiry mid-outage). */
export function __resetCaptchaConfigCacheForTests(keepLastGood = false): void {
  cachedConfig = { value: null, expiresAt: 0 };
  configsFetchInFlight = null;
  if (!keepLastGood) lastGoodCfg = null;
}

export function detectCaptchaChallenge(resp: Response): string | null {
  const v = resp.headers.get(CAPTCHA_HEADER);
  return v && v.trim().length > 0 ? v.trim() : null;
}


async function fetchCaptchaConfig(appVersion: string): Promise<FetchedCaptchaConfig | null> {
  if (cachedConfig.expiresAt > Date.now()) return cachedConfig.value;
  if (configsFetchInFlight) return configsFetchInFlight;
  configsFetchInFlight = (async () => {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bound the entire fetch, including the body. A response that sends
      // headers but stalls its JSON must not pin the shared in-flight promise.
      // Override: CAPTCHA_CONFIG_TIMEOUT_MS (mirror timeout 15s).
      const rawTimeoutMs = Number(process.env.CAPTCHA_CONFIG_TIMEOUT_MS || 15_000);
      const cfgTimeoutMs = Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0 ? rawTimeoutMs : 15_000;
      const readConfig = async (): Promise<unknown> => {
        const resp = await (configsFetch ?? fetch)(`${CONFIGS_API}?app_version=${encodeURIComponent(appVersion)}&platform=win32-x64`, { signal: controller.signal });
        if (!resp.ok || controller.signal.aborted) {
          void resp.body?.cancel().catch(() => {});
          throw new Error(`Captcha config request failed (${resp.status})`);
        }
        reader = resp.body?.getReader();
        const chunks: Uint8Array[] = [];
        try {
          if (reader) {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
          }
          return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
        } finally {
          reader?.releaseLock();
          reader = undefined;
        }
      };
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Captcha config request timed out"));
          controller.abort();
          void reader?.cancel().catch(() => {});
        }, cfgTimeoutMs);
      });
      const json = (await Promise.race([readConfig(), timeout])) as { data?: { configs?: { captcha?: FetchedCaptchaConfig } } };
      const cfg = json?.data?.configs?.captcha ?? null;
      // Snapshot write ONLY on a successful fetch (mirror: failures never
      // update the snapshot — the next call retries immediately).
      cachedConfig = { value: cfg, expiresAt: Date.now() + captchaConfigTtlMs() };
      if (cfg) lastGoodCfg = cfg;
      return cfg;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      configsFetchInFlight = null;
    }
  })();
  return configsFetchInFlight;
}

/** Snapshot TTL — mirror `RRe = 3600*1e3`. Override: CAPTCHA_CONFIG_TTL_MS. */
function captchaConfigTtlMs(): number {
  const raw = Number(process.env.CAPTCHA_CONFIG_TTL_MS || 3_600_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 3_600_000;
}

/**
 * Solve backend: in-process happy-dom (captcha-happy.ts) served through the
 * pre-solved token pool. Retries are handled inside the pool
 * (4 attempts with a fresh solve per retry).
 *
 * Returns null when the fetched config DEFINITIVELY disables captcha
 * (`enabled:false`/missing scene) — no captcha headers is then the correct
 * wire shape. THROWS when acquisition failed for unknown reasons (pool
 * exhaustion with no config history) — callers must NOT dispatch a
 * captcha-less request on a throw: the start-plan edge answers those with
 * bare 502s (live 2026-10-23).
 *
 * Pool-first degradation: a configs-fetch outage never strands banked tokens
 * — with a last-good config on record the pool keeps serving (its region
 * rides along); the latest authoritative `enabled:false` remains disabled
 * through outages. Live run #002 burned 47s/16 retries on configs flakiness
 * while the pool still had stock.
 *
 * `accountId` 必需：token 从该账号自己的池里取。
 */
export async function getCaptchaToken(appVersion: string, accountId: string): Promise<{ verifyParam: string; region: string } | null> {
  const cfg = (await fetchCaptchaConfig(appVersion)) ?? lastGoodCfg;
  if (!cfg) throw new Error("Captcha config unavailable");
  if (!cfg.enabled || !cfg.prefix || !cfg.sceneId) return null;
  return { verifyParam: await takeCaptchaToken(cfg, accountId), region: cfg.region };
}

/** 停全部池（进程关闭）。单账号的池由 `captcha-pool.ts::stopCaptchaPoolFor` 停。 */
export function shutdownCaptcha(): void {
  // 两者都是 best-effort：关闭路径上池/solver 可能本来就没启动过。
  try { shutdownCaptchaSolver(); } catch { /* solver never started */ }
  try { stopCaptchaPool(); } catch { /* pool never started */ }
}

/**
 * In-flight request activity (an SSE response still producing): refresh the
 * pool's idle clock without taking a token, so a long stream never decays the
 * pool mid-turn. Cheap and inert pre-pool-start.
 *
 * 按账号转发：要刷新的是该账号自己的池的空闲时钟。
 */
export function noteDemand(accountId: string): void {
  touchCaptchaDemand(accountId);
}

/**
 * Start background pre-solving of one account's token pool (happy backend).
 * Warms only the idle minimum; the pool grows on demand with traffic.
 *
 * 后台补充循环按账号起，首轮相位由 `accountId` 哈希错开，见
 * `captcha-pool.ts::CaptchaTokenPool.startPhaseMs`。
 */
export async function startCaptchaPool(appVersion: string, accountId: string): Promise<void> {
  const cfg = await fetchCaptchaConfig(appVersion);
  if (!cfg || !cfg.enabled) return;
  // 按 start-plan 的 5 并发上限定尺寸：最坏瞬时约 10 次取 token（5 个请求加挑战
  // 重试），95s TTL 下同时流动 8-24 个；15 覆盖这些，再加 F008/过期丢弃与一次
  // pe-storm 补池中断（~30-45s）。并发 3 时每分钟能造 4-6 个，比需求高一个量级。
  // 两个尺寸都是常量，只有上限可以用 `CAPTCHA_POOL_MAX` 调。
  const min = 15;
  const max = captchaEnvPositiveInt("CAPTCHA_POOL_MAX", Math.max(min * 4, 60));
  configureCaptchaPool({ poolSizeMin: min, poolSizeMax: max });
  startCaptchaPoolRefill(cfg as CaptchaConfig, accountId);
  await prefillCaptchaPool(cfg as CaptchaConfig, accountId, min);
}

/** 预热目标账号的最小信息（启动路径不需要整份 `Account`）。*/
export interface CaptchaPoolAccount {
  id: string;
  enabled: boolean;
  routes: readonly string[];
}

/**
 * 会走 start-plan 的账号（启动预热闸门，也是预热列表本身）。
 *
 * 两个条件缺一不可：禁用的账号不出线，没有 `start-plan` 路由的账号永远不会向
 * `zcode.z.ai` 网关发请求。给这两类账号起补池循环只会白烧求解 CPU 与阿里云配额。
 */
export function captchaPoolAccounts(accounts: readonly CaptchaPoolAccount[]): CaptchaPoolAccount[] {
  return accounts.filter((account) => account.enabled && account.routes.includes("start-plan"));
}

/**
 * 启动时给每个 start-plan 账号各预热一个池（池按账号分，不共用）。
 *
 * 为什么不是只预热一个账号：没有「当前账号」这回事，一次请求用哪个账号由调度器
 * 的候选集决定，任何启用且带 `start-plan` 路由的账号都可能被选中。只预热一个，
 * 其余账号的首个请求会打在空池上（空池取 token 要现解，首字节延迟从亚毫秒变成秒级）。
 *
 * 一个账号预热失败不能带走其他账号（`allSettled`）：configs 抽风时全体失败是正常
 * 结果，失败逐个报给调用方，由调用方决定怎么打日志。
 *
 * 返回的 `warmed` 是「启动流程没有抛错」：服务端明示禁用验证码时也计入，那种情况下
 * 无 captcha 头就是正确形态（见 `getCaptchaToken` 的返回值语义）。
 */
export async function warmCaptchaPools(
  appVersion: string,
  accounts: readonly CaptchaPoolAccount[],
): Promise<{ warmed: string[]; failed: { accountId: string; message: string }[] }> {
  const targets = captchaPoolAccounts(accounts);
  const settled = await Promise.allSettled(targets.map((account) => startCaptchaPool(appVersion, account.id)));
  const warmed: string[] = [];
  const failed: { accountId: string; message: string }[] = [];
  settled.forEach((outcome, index) => {
    const accountId = targets[index].id;
    if (outcome.status === "fulfilled") warmed.push(accountId);
    else failed.push({ accountId, message: (outcome.reason as Error)?.message ?? String(outcome.reason) });
  });
  return { warmed, failed };
}

export const RETRY_HEADERS = { PARAM: CAPTCHA_HEADER, REGION: REGION_HEADER };
