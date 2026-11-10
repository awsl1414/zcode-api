/**
 * HighSpeed 加速卡管理，按官方当前形态实现，一个账号一个卡槽实例。
 *
 * 官方证据（只读参考官方 ZCode 客户端仓库）：抽卡走 `POST /api/v1/highspeed/draw`，
 * 加速推理走 `/api/v1/highspeed/anthropic/v1/messages`，两者共用一套鉴权中间件。
 * 契约汇总见 `docs/research/upstream-risk-control.md` 的 8.1 节。代码依据：
 *
 * - `packages/services/src/highspeed/highspeedCardService.ts` 的
 *   `buildHighspeedCodingPlanAuthHeaders` / `buildHighspeedTurnExecution`
 * - `packages/shared/src/highspeed.ts` 的 `HIGHSPEED_DRAW_PROVIDER_IDS`
 * - `config/provider/zcode-builtin.json` 的 `account:zai-highspeed-card` /
 *   `account:bigmodel-highspeed-card`
 *
 * 与 3.15.1 镜像版的三处实质差异：
 *
 * 1. **挂卡 = 切路由**：命中卡后出线路由从 `coding-plan` 切到 `highspeed`
 *    （`accounts/routes.ts` 已钉好的 baseUrl `https://zcode.z.ai/api/v1/highspeed/anthropic`），
 *    不再往 coding-plan 的 URL 上加头。切路由发生在请求侧
 *    （`proxy/handler.ts`），本模块只回答「有没有可用的卡」。
 * 2. **不改写模型**：`model` 保持客户端请求值；卡上 model 与请求 model 不一致
 *    时这张卡对本次请求无效并被丢弃（官方原文「加速只换端点
 *    不换模型，`model` 必须与卡绑定 model 一致」）。
 * 3. **身份从账号读**：`Bigmodel-Target-Type` 与 TEAM 的
 *    `Bigmodel-Organization` / `Bigmodel-Project` 来自
 *    `Account.credential.identity`，不再硬编码 `PERSONAL`。
 *
 * 抽卡/加速的鉴权配方两处**逐字相同**（官方 `buildHighspeedCodingPlanAuthHeaders`
 * 注释：draw 与加速推理走同一个 `/api/v1/highspeed/` 网关、同一套鉴权中间件）：
 * `Authorization: Bearer <zcode JWT>` + `X-Bigmodel-Authorization: Bearer
 * <coding-plan 业务 JWT>` + `Bigmodel-Target-Type`(+TEAM 两个头)。加速推理只是
 * 额外附带 `X-Highspeed-Card-ID`。
 *
 * **明确保留的偏差**：官方是「每消息
 * inline 抽一次卡、miss 尊重 `next_draw_at`」，我们是「后台 ~1s 循环、忽略
 * `next_draw_at`」。理由是抽卡窗口的价值在请求活跃期，等 2min 冷却等于放弃加速。
 * 配套约束：`IDLE_MS` 自熄（只在有活跃请求时抽）、每账号独立卡槽 + 心跳错峰
 * （`highspeed/slots.ts`）、`429` 退避 5s、`503/3404` 负缓存 10min。
 */
import { randomUUID } from "node:crypto";
import type { UpstreamHeaderPair } from "../proxy/upstream.js";
import type { Account, AccountIdentity, ProviderFamily } from "../accounts/types.js";

const DRAW_PATH = "/api/v1/highspeed/draw";
/**
 * 健康检查前缀。官方 `highspeedHttpTransport.healthy` 用
 * `new URL(`${encodeURIComponent(cardId)}/healthy`, healthyBaseUrl)`，而
 * `packages/services/src/node.ts` 把 `healthyBaseUrl` 拼成
 * `${origin}/api/v1/highspeed/`，合起来就是本路径。
 */
const HEALTHY_PATH = "/api/v1/highspeed";
/** Measured admitted-draw tail reaches ~5.6s (2026-10-14 probe); official transport timeout is 20s. */
const DRAW_TIMEOUT_MS = 10_000;
/** 健康检查是纯统计旁路：短预算，失败也不影响请求。 */
const HEALTHY_TIMEOUT_MS = 5_000;
/** Heartbeat cadence of the draw loop ≈ measured token-bucket refill (1/s). */
const DRAW_RETRY_MS = 1_000;
/** Stop drawing this long after the last eligible request (idle self-extinguish). */
const IDLE_MS = 5 * 60_000;
/** Negative cache after account-level unavailability (503 / biz 3404). */
const UNAVAILABLE_MS = 10 * 60_000;
/**
 * Backoff after an HTTP 429 (2026-10-14 live probe: the sustainable ceiling is
 * ≈1 draw/s and even ~1/s trips sporadic 429s; the bucket refills at ~1s
 * level, so a long pause only burns draw chances during active traffic).
 */
const RATE_LIMIT_BACKOFF_MS = 5_000;
/** Cooldown after transport failure (network / timeout). */
const TRANSPORT_FAILURE_MS = 60_000;
/** Skip applying a card with less than this left on its window. */
const CARD_MIN_REMAINING_MS = 10_000;
/**
 * 健康检查统计的保留条数。卡级用量只是展示数据，
 * 按卡 ID 保留最近若干条即可；无界 Map 会让一个长跑进程按抽卡次数涨内存。
 */
const MAX_USAGE_ENTRIES = 16;

import { fetchWithEgress, type EgressOptions } from "../proxy/egress.js";

export interface HighspeedCard {
  cardId: string;
  taskId: string;
  model: string;
  issuedAt: number;
  expiresAt: number;
}

/**
 * 账号身份面。取自 `Account.credential.identity`
 * （`accounts/types.ts::AccountIdentity` 的子集）。
 *
 * TEAM 时 `organizationId` / `projectId` 必填。这条不是这里的校验责任：
 * `accounts/manager.ts::validateIdentity` 在**导入时**就拦住了
 * 缺 id 的 TEAM 凭据，所以下游按契约直接用（边界校验一次，不写不可达兜底）。
 */
export interface HighspeedIdentity {
  targetType: AccountIdentity["targetType"];
  organizationId?: string;
  projectId?: string;
}

export interface HighspeedAuth {
  /** zcode plan JWT (`Credential.jwt`) — required for both draw and card headers. */
  jwt: string;
  /** Coding-plan credential string for X-Bigmodel-Authorization. */
  codingPlanAuth: string;
  /** Provider family of the active coding plan. */
  family: ProviderFamily;
  /** 账号身份（PERSONAL / TEAM + TEAM 的组织与项目）。 */
  identity: HighspeedIdentity;
}

/** 卡级用量（官方 `HighspeedCardUsage`，健康检查的返回值）。 */
export interface HighspeedCardUsage {
  cardId: string;
  promptTokens: number;
  completionTokens: number;
  durationSeconds: number;
  /** 采样时刻（Unix ms）：统计口径，参与业务判定。 */
  sampledAt: number;
}

interface DrawResponseBody {
  code?: unknown;
  msg?: unknown;
  data?: { card?: DrawCardWire | null };
}

interface DrawCardWire {
  card_id?: unknown;
  task_id?: unknown;
  provider?: unknown;
  model?: unknown;
  issued_at?: unknown;
  expires_at?: unknown;
}

interface HealthyResponseBody {
  code?: unknown;
  msg?: unknown;
  data?: {
    card_id?: unknown;
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    duration_seconds?: unknown;
  };
}

interface LatestDrawRequest {
  model: string;
  taskId: string;
  auth: HighspeedAuth;
}

/**
 * Coding Plan 双 JWT + 账号身份头（官方 `buildHighspeedCodingPlanAuthHeaders`）。
 *
 * 抽卡与加速推理**必须**用同一个函数产出这套头：两条路径走同一个网关、同一套
 * 鉴权中间件，任何一处少头都会被判成 `401 auth_failed`（官方注释里的历史 bug）。
 */
export function highspeedAuthHeaders(auth: HighspeedAuth): Record<string, string> {
  const jwt = auth.jwt.trim();
  const codingPlan = auth.codingPlanAuth.trim();
  return {
    "Authorization": /^Bearer\s/iu.test(jwt) ? jwt : `Bearer ${jwt}`,
    // 接口契约要求 Bearer 前缀；凭据库可能存裸 token，官方同样归一化。
    "X-Bigmodel-Authorization": /^Bearer\s/iu.test(codingPlan) ? codingPlan : `Bearer ${codingPlan}`,
    "Bigmodel-Target-Type": auth.identity.targetType,
    // TEAM 的两个头：导入时保证非空（见 HighspeedIdentity 注释）。
    ...(auth.identity.targetType === "TEAM"
      ? {
        "Bigmodel-Organization": auth.identity.organizationId!,
        "Bigmodel-Project": auth.identity.projectId!,
      }
      : {}),
  };
}

/** 模型 id 比较：大小写与首尾空白无关（官方目录写 `GLM-5.3`，内部统一小写）。 */
function sameModel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export class HighspeedManager {
  /** 卡槽所属账号。日志与统计用它区分是谁的卡。 */
  readonly accountId: string;
  private readonly origin: string;
  private readonly models: string[];
  private readonly deviceMid: string | undefined;
  private readonly fetchImpl: typeof fetch;
  /** 出线代理：抽卡与探活都走它。*/
  private readonly egress: EgressOptions | undefined;
  private readonly now: () => number;
  /** Heartbeat interval — production default 1s; tests inject small values. */
  private readonly retryMs: number;
  /**
   * 首抽相位偏移。由 `highspeed/slots.ts` 按 accountId
   * 哈希算出来，保证 N 个账号的抽卡循环不同拍；同步心跳是机器特征。
   */
  private readonly startDelayMs: number;
  private readonly notedKeys = new Set<string>();
  onEvent?: (message: string) => void;

  private card: HighspeedCard | null = null;
  /** 抽到卡时用的鉴权（卡到期健康检查要用它签名）。 */
  private cardAuth: HighspeedAuth | null = null;
  private unavailableUntil = 0;
  /**
   * Models the draw endpoint rejected at parameter level (live 2026-10-14:
   * `glm-5.3-flash` → HTTP 400 biz 3001 "parameter error" while `glm-5.3`
   * passes on the same account). Per-model, deliberately NOT the account-level
   * negative cache — a rejected model must not silence draws for the rest of
   * the catalogue.
   */
  private readonly drawBlockedUntil = new Map<string, number>();
  /** Earliest next draw attempt (429 / transport backoff gate). */
  private nextAttemptAt = 0;
  /** Loop deadline = last eligible request + IDLE_MS. */
  private loopUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private drawInFlight: Promise<void> | null = null;
  /** Most recent eligible request — the loop always draws with these params. */
  private latest: LatestDrawRequest | null = null;
  /** 卡级用量（仅统计）。 */
  private readonly usages = new Map<string, HighspeedCardUsage>();

  constructor(opts: {
    /** 卡槽所属账号 id（`Map<accountId, HighspeedManager>` 的键）。 */
    accountId: string;
    /** 该账号的出口代理。缺省 = 直连。*/
    egress?: EgressOptions;
    origin: string;
    models: string[];
    /** Injected as X-Device-Mid (deliberate deviation, activity compatibility).
     * Historical 3001 observations also included unsupported models (flash);
     * the code alone does not establish that device identity is missing.
     * 一账号一指纹，所以由调用方传入**该账号**的值。 */
    deviceMid?: string;
    /** 首抽相位偏移（心跳错峰）。缺省 0 = 请求到即抽。 */
    startDelayMs?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
    retryMs?: number;
    onEvent?: (message: string) => void;
  }) {
    this.accountId = opts.accountId;
    this.origin = opts.origin.replace(/\/+$/u, "");
    this.models = opts.models.map((m) => m.trim().toLowerCase()).filter(Boolean);
    this.deviceMid = opts.deviceMid?.trim() || undefined;
    this.startDelayMs = Math.max(0, opts.startDelayMs ?? 0);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.egress = opts.egress;
    this.now = opts.now ?? Date.now;
    this.retryMs = opts.retryMs ?? DRAW_RETRY_MS;
    this.onEvent = opts.onEvent;
  }

  /** Prefix match against the configured eligible families (glm-5.3/5.2/5.1 …). */
  isEligibleModel(model: string | undefined): boolean {
    if (!model) return false;
    const m = model.trim().toLowerCase();
    return this.models.some((prefix) => m === prefix || m.startsWith(`${prefix}-`));
  }

  /**
   * Fire-and-forget draw trigger — call on every eligible coding-plan request.
   * Stamps the idle window with the latest request params and (re)ignites the
   * background loop. While a card is held nothing is drawn (single slot per
   * account); concurrent draws deduplicate into one in-flight
   * request.
   */
  onRequest(model: string, sessionTaskId: string | undefined, auth: HighspeedAuth): void {
    if (!this.isEligibleModel(model)) return;
    const now = this.now();
    // draw 端点参数级拒绝的模型不再点燃（每次 TTL 窗口省一次 400 探测）
    const blockedUntil = this.drawBlockedUntil.get(model.trim().toLowerCase());
    if (blockedUntil !== undefined) {
      if (now < blockedUntil) return;
      this.drawBlockedUntil.delete(model.trim().toLowerCase());
    }
    this.expireCard(now);
    // Refresh latest before the held-card early return below: a card drawn for
    // another model/task must not block re-ignition, and dropCard() redraws
    // from `latest` — which must carry the current request's params.
    this.latest = { model, taskId: sessionTaskId ?? randomUUID(), auth };
    // Held-card traffic is still activity: rejection must be able to redraw
    // within five minutes of this request, not only of the original draw.
    this.loopUntil = now + IDLE_MS;
    // an unusable card (< CARD_MIN_REMAINING_MS) must not block re-ignition —
    // requests during those last seconds go out uncarded anyway, and holding
    // the slot would stall the loop until full expiry
    if (this.card && this.card.expiresAt - now >= CARD_MIN_REMAINING_MS) return;
    this.ensureLoop();
  }

  /**
   * In-flight request activity (an SSE response still producing): extend the
   * idle window WITHOUT re-stamping model/auth params — a stream that has
   * been generating for minutes is not "idle", so a turn that ends inside
   * the window must not let the draw loop idle-stop right after it. Fires at
   * stream end: a stream longer than IDLE_MS still lets tick() stop the loop
   * mid-flight. Never ignites a stopped loop; the next real request does that
   * via onRequest.
   */
  noteActivity(): void {
    this.loopUntil = this.now() + IDLE_MS;
  }

  /** The active card, or null when outside the window (expiry-checked). */
  activeCard(): HighspeedCard | null {
    const now = this.now();
    this.expireCard(now);
    if (!this.card) return null;
    if (this.card.expiresAt - now < CARD_MIN_REMAINING_MS) return null;
    return this.card;
  }

  /**
   * 可用于**本次请求模型**的卡。
   *
   * 官方语义：加速只换端点不换模型，`model` 必须与卡绑定 model
   * 一致。不一致 = 这张卡对本次请求无效（视为无效卡并丢弃，
   * 绝不偷偷把 body 的 model 改成卡上的 model），丢弃后 `dropCard` 在空闲窗口
   * 内立即按新模型重抽。
   */
  activeCardFor(model: string): HighspeedCard | null {
    const card = this.activeCard();
    if (!card) return null;
    if (sameModel(card.model, model)) return card;
    this.dropCard(`model-mismatch card=${card.model} request=${model}`);
    return null;
  }

  /** Drop the card after an upstream failure (official selectionFallback). */
  dropCard(reason: string): void {
    if (!this.card) return;
    this.card = null;
    this.cardAuth = null;
    this.onEvent?.(`highspeed: card dropped (${reason})`);
    // Mid-idle-window restart: while the session is still active a replacement
    // card is redrawn immediately (first draw fires synchronously).
    if (this.now() < this.loopUntil) this.ensureLoop();
  }

  /** Stop the draw loop (account removed / disabled / shutdown). Idempotent, no-throw. */
  stop(): void {
    this.stopTimer();
  }

  /** 卡级用量快照（仅统计；未采到返回 undefined）。 */
  usageOf(cardId: string): HighspeedCardUsage | undefined {
    return this.usages.get(cardId);
  }

  private expireCard(now: number): void {
    if (!this.card) return;
    if (this.card.expiresAt > now) return;
    const expiring = this.card;
    const auth = this.cardAuth;
    this.card = null;
    this.cardAuth = null;
    this.onEvent?.(`highspeed: card ${expiring.cardId} expired`);
    // 卡到期时再查一次用量（官方在卡到期后补采卡级 TPS）。
    if (auth) void this.checkHealthy(expiring, auth);
  }

  /** Ignite the loop if it is not running. First draw fires after `startDelayMs`. */
  private ensureLoop(): void {
    if (this.timer) return;
    const latest = this.latest;
    if (!latest) return;
    if (!latest.auth.jwt.trim()) {
      this.noteOnce("no-jwt", "credential has no zcode JWT — highspeed disabled until re-login");
      return;
    }
    if (this.drawInFlight) {
      // In-flight draw with a stopped timer (idle-stop raced a request):
      // re-arm the heartbeat; tick() applies the gates.
      this.arm();
      return;
    }
    if (this.startDelayMs > 0) {
      // 心跳错峰：首个请求仍然立即点燃循环，只是首抽按账号相位推迟
      // （≤ 一个心跳间隔），N 个账号因此不会同拍打 draw。
      this.arm(this.startDelayMs);
      return;
    }
    void this.tick();
  }

  /** One loop beat: gate checks, maybe draw, re-arm. */
  private tick(): void {
    const now = this.now();
    this.expireCard(now);
    // same sub-min-remaining rule as onRequest: an unusable card must not
    // stop the loop — the replacement draw fires while the old one winds down
    if (this.card && this.card.expiresAt - now >= CARD_MIN_REMAINING_MS) {
      this.stopTimer();
      return;
    }
    if (now >= this.loopUntil) {
      this.stopTimer();
      this.onEvent?.("highspeed: draw loop idle-stopped (5min without eligible requests)");
      return;
    }
    if (this.drawInFlight || now < this.nextAttemptAt || now < this.unavailableUntil) {
      this.arm();
      return;
    }
    const latest = this.latest;
    if (!latest || !latest.auth.jwt.trim()) {
      this.stopTimer();
      return;
    }
    // 同 onRequest 的模型闸：被 draw 端点参数级拒绝的模型不再发 fetch，
    // 空转等 latest 换模型（新请求）或空闲窗口关闭（idle-stop）。
    const latestBlockedUntil = this.drawBlockedUntil.get(latest.model.trim().toLowerCase());
    if (latestBlockedUntil !== undefined) {
      if (this.now() < latestBlockedUntil) {
        this.arm();
        return;
      }
      this.drawBlockedUntil.delete(latest.model.trim().toLowerCase());
    }
    const promise = this.draw(latest.model, latest.taskId, latest.auth)
      .catch(() => {
        // draw() never throws (all outcomes map to backoff windows); network
        // throws land here as an extra guard.
        this.nextAttemptAt = this.now() + TRANSPORT_FAILURE_MS;
      })
      .finally(() => {
        if (this.drawInFlight === promise) this.drawInFlight = null;
      });
    this.drawInFlight = promise;
    this.arm();
  }

  /** Re-arm the heartbeat. unref'd: the loop never keeps the process alive. */
  private arm(delayMs: number = this.retryMs): void {
    this.stopTimer();
    const timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delayMs);
    timer.unref?.();
    this.timer = timer;
  }

  private stopTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async draw(model: string, taskId: string, auth: HighspeedAuth): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DRAW_TIMEOUT_MS);
    timer.unref?.();
    let status = 0;
    let body: DrawResponseBody | null = null;
    try {
      const resp = await fetchWithEgress(this.fetchImpl, `${this.origin}${DRAW_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...highspeedAuthHeaders(auth),
          "x-request-id": randomUUID(),
          ...(this.deviceMid ? { "X-Device-Mid": this.deviceMid } : {}),
        },
        body: JSON.stringify({
          task_id: taskId,
          provider: `builtin:${auth.family}-coding-plan`,
          model,
        }),
        redirect: "manual",
        signal: controller.signal,
      }, this.egress);
      status = resp.status;
      try {
        body = await resp.json() as DrawResponseBody;
      } catch {
        body = null;
      }
    } catch {
      this.nextAttemptAt = this.now() + TRANSPORT_FAILURE_MS;
      this.noteOnce("transport", "highspeed draw failed (network/timeout) — retrying later");
      return;
    } finally {
      clearTimeout(timer);
    }

    const now = this.now();
    const wireCode = typeof body?.code === "number" ? body.code : null;
    const wireMsg = typeof body?.msg === "string" ? body.msg.slice(0, 60) : "";
    if (status === 429) {
      this.nextAttemptAt = now + RATE_LIMIT_BACKOFF_MS;
      this.noteOnce("429", "highspeed draw rate-limited (429) — backing off 5s");
      return;
    }
    if (status !== 200 || !body) {
      if (status === 400) {
        // Parameter-level rejection — the ACCOUNT is fine (same account, same
        // recipe: glm-5.3 draws 200-miss where glm-5.3-flash 400s, live
        // 2026-10-14). Block only this model; never the account-level cache.
        this.drawBlockedUntil.set(model.trim().toLowerCase(), now + UNAVAILABLE_MS);
        this.noteOnce(
          `draw400-${model}`,
          `draw rejected (HTTP 400${wireCode !== null ? ` code=${wireCode}` : ""}${wireMsg ? ` ${wireMsg}` : ""}) — model ${model} ineligible for draw, skipping it`,
        );
      } else {
        this.unavailableUntil = now + UNAVAILABLE_MS;
        this.noteOnce(`http${status}`, `highspeed draw unavailable (HTTP ${status}${wireCode !== null ? ` code=${wireCode}` : ""}${wireMsg ? ` ${wireMsg}` : ""}) — negative-cached 10min`);
      }
      return;
    }
    const code = wireCode;
    if (code !== 0) {
      // 3404 = account-level "highspeed temporarily unavailable" (live 2026-10-10).
      // Any other business code is treated the same: negative-cache, never spin.
      this.unavailableUntil = now + UNAVAILABLE_MS;
      this.noteOnce(`biz${code}`, `highspeed draw rejected (code=${code} ${String(body.msg ?? "").slice(0, 60)}) — negative-cached 10min`);
      return;
    }
    // Deliberate deviation: `next_draw_at` is ignored on a miss — the loop
    // retries at the heartbeat cadence until the idle window closes.
    const wire = body.data?.card;
    if (wire && typeof wire.card_id === "string" && wire.card_id
      && typeof wire.model === "string" && wire.model
      && typeof wire.expires_at === "number" && wire.expires_at > now) {
      this.card = {
        cardId: wire.card_id,
        taskId: typeof wire.task_id === "string" ? wire.task_id : taskId,
        model: wire.model,
        issuedAt: typeof wire.issued_at === "number" ? wire.issued_at : now,
        expiresAt: wire.expires_at,
      };
      this.cardAuth = auth;
      this.stopTimer();
      this.onEvent?.(`highspeed: card drawn (${this.card.cardId.slice(0, 12)}… model=${this.card.model} window=${Math.round((this.card.expiresAt - now) / 1000)}s)`);
      // 拿到卡后立刻查一次卡级用量（统计用，失败不影响请求）。
      void this.checkHealthy(this.card, auth);
    } else {
      this.noteOnce("miss", "highspeed draw miss (card=null) — retrying at max rate");
    }
  }

  /**
   * `GET {origin}/api/v1/highspeed/{cardId}/healthy`（官方
   * `highspeedHttpTransport.healthy`）。
   *
   * 纯统计旁路：失败只记一行事件，**绝不影响**请求链路（官方注释同样把它定位成
   * 卡级 TPS 采样，不是可用性判定）。
   */
  private async checkHealthy(card: HighspeedCard, auth: HighspeedAuth): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTHY_TIMEOUT_MS);
    timer.unref?.();
    try {
      const resp = await fetchWithEgress(
        this.fetchImpl,
        `${this.origin}${HEALTHY_PATH}/${encodeURIComponent(card.cardId)}/healthy`,
        {
          method: "GET",
          headers: { ...highspeedAuthHeaders(auth), "x-request-id": randomUUID() },
          redirect: "manual",
          signal: controller.signal,
        },
        this.egress,
      );
      if (!resp.ok) {
        this.noteOnce(`healthy-http${resp.status}`, `health check failed (HTTP ${resp.status}) for ${card.cardId.slice(0, 12)}…`);
        return;
      }
      const body = await resp.json() as HealthyResponseBody;
      const data = body.data;
      if (body.code !== 0 || !data) {
        this.noteOnce(`healthy-biz${String(body.code)}`, `health check rejected (code=${String(body.code)}) for ${card.cardId.slice(0, 12)}…`);
        return;
      }
      if (typeof data.prompt_tokens !== "number" || typeof data.completion_tokens !== "number"
        || typeof data.duration_seconds !== "number") {
        this.noteOnce("healthy-shape", `health check returned an unexpected payload for ${card.cardId.slice(0, 12)}…`);
        return;
      }
      this.recordUsage({
        cardId: card.cardId,
        promptTokens: data.prompt_tokens,
        completionTokens: data.completion_tokens,
        durationSeconds: data.duration_seconds,
        sampledAt: this.now(),
      });
    } catch {
      this.noteOnce("healthy-transport", `health check failed (network/timeout) for ${card.cardId.slice(0, 12)}…`);
    } finally {
      clearTimeout(timer);
    }
  }

  private recordUsage(usage: HighspeedCardUsage): void {
    this.usages.set(usage.cardId, usage);
    while (this.usages.size > MAX_USAGE_ENTRIES) {
      const oldest = this.usages.keys().next();
      if (oldest.done === true) return;
      this.usages.delete(oldest.value);
    }
  }

  private noteOnce(key: string, message: string): void {
    if (this.notedKeys.has(key)) return;
    this.notedKeys.add(key);
    this.onEvent?.(`highspeed: ${message}`);
  }
}

/**
 * Apply the official highspeed card auth shape to upstream header pairs
 * (official `buildHighspeedTurnExecution` requestAuth): the coding-plan dual
 * `x-api-key`/`Authorization` values are replaced by the zcode JWT, and the
 * Coding Plan 双 JWT + 账号身份头 + 卡 ID are appended.
 *
 * 注意调用方同时必须把出线路由切到 `highspeed`：这组头只对
 * `zcode.z.ai/api/v1/highspeed/anthropic` 有效，挂在 coding-plan 的 URL 上会被
 * 上游当成普通请求而缺权益（官方 401 回归）。
 */
export function applyHighspeedCardHeaders(
  pairs: UpstreamHeaderPair[],
  card: HighspeedCard,
  auth: HighspeedAuth,
): UpstreamHeaderPair[] {
  const bare = auth.jwt.startsWith("Bearer ") ? auth.jwt.slice(7).trim() : auth.jwt;
  const bearer = `Bearer ${bare}`;
  const swapped = pairs.map(([name, value]): UpstreamHeaderPair => {
    const lower = name.toLowerCase();
    // official requestAuth: apiKey slot (SDK x-api-key) carries the bare JWT,
    // the Authorization header carries the Bearer form
    if (lower === "x-api-key") return [name, bare];
    if (lower === "authorization") return [name, bearer];
    return [name, value];
  });
  return [
    ...swapped,
    // `Authorization` 已经在上面换过（双头里它换成 zcode JWT 的 Bearer 形式），
    // 这里再追加一份会让线上的 Authorization 变成 `Bearer a, Bearer a`。
    // 官方是整体**替换** requestAuth.headers，我们是在已有头集合上追加，所以只需
    // 追加“新出现”的那几个（X-Bigmodel-Authorization / Target-Type / TEAM 两个头）。
    ...Object.entries(highspeedAuthHeaders(auth))
      .filter(([name]) => name.toLowerCase() !== "authorization"),
    ["X-Highspeed-Card-ID", card.cardId],
  ];
}

/**
 * 加速请求失败 → 退回原 session 模型（官方原文
 * 「任一次 Highspeed 请求失败时——卡过期的 HTTP 400 / provider_code=3402、鉴权失败、
 * 限流、5xx、网络错误、超时、流中断等**任何失败**——…切回发送前的原始 session 模型」）。
 *
 * 所以这里判的是"失败"而不是"卡被拒"：`3402`（卡过期）与 `401/403`（鉴权）只是
 * 最常见的两种，`429` / `5xx` / 其他 4xx 一样退回。`2xx` 不算失败（含 SSE 正常
 * 开流；开流之后的流中断只能在读到错误时作废卡，无法重放已回写的字节）。
 */
export function isHighspeedFailure(resp: Response): boolean {
  return !resp.ok;
}

/**
 * Credential → HighspeedAuth（身份从账号读）。
 *
 * 返回 null = 这个账号开不了加速：
 * - `api-key` 凭据没有 plan JWT，抽卡与加速都过不了鉴权（`requires.jwt`）；
 * - 缺 JWT = 只能走 start-plan / 导入不全，官方 highspeed 需要 zcode JWT；
 * - 缺 apiKey 对（zai 必须有 secret，bigmodel 单 key 可省）= coding-plan 权益无法校验。
 */
export function highspeedAuthFrom(account: Account): HighspeedAuth | null {
  const cred = account.credential;
  if (cred.kind !== "zhipu-account") return null;
  if (!cred.jwt?.trim() || !cred.apiKey.trim()) return null;
  if (cred.provider === "zai" && !cred.secret?.trim()) return null;
  return {
    jwt: cred.jwt,
    codingPlanAuth: cred.secret ? `${cred.apiKey}.${cred.secret}` : cred.apiKey,
    family: cred.provider,
    // AccountIdentity 是 HighspeedIdentity 的超集（多 deviceMid / productId），
    // 这里只取官方那三个头需要的字段。
    identity: {
      targetType: cred.identity.targetType,
      organizationId: cred.identity.organizationId,
      projectId: cred.identity.projectId,
    },
  };
}
