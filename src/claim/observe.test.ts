/**
 * claim 出线接进统一观测点 + 选号跳过不健康账号。
 *
 * 两件事：
 *
 * 1. **出线观测**（`observeClaimUpstream` 的接线半边）：活动接口回额度终态码
 *    （实测形态 502 + `{"code":1005}`）→ 该账号的**全部路由**判 drained：
 *    claim 平面报的是账号面事实，不是某条路由的事。
 * 2. **选号跳过**：账号处于 `drained` / `auth-invalid` 时调度器这一拍不发请求
 *    （claim 不为这些账号发请求），健康恢复后自动回来。
 *
 * claim 自有的 rate-limit（活动频率限制，`rate-limit.ts` 共享窗口）保持独立——
 * 活动调度域不进账号健康域（HTTP 429 活动限流不落健康，见
 * `upstream-error.ts::CLAIM_HEALTH_KINDS`）。
 *
 * @see 统一观测点 · 恢复矩阵
 */
import { describe, expect, it } from "bun:test";
import { accountHealthBlocked, buildClaimActions } from "./runtime.js";
import { ClaimScheduler } from "./scheduler.js";
import type { ClaimGateway } from "./scheduler.js";
import { inMemoryAccounts, accountFor, zhipuCredential } from "../accounts/testing.js";
import type { Account } from "../accounts/types.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";

const IDENTITY: ProxyIdentity = {
  appVersion: "test-1.0.0",
  appVersionSource: "default",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
  betaPolicy: "drop",
  betaAllowlist: [],
};

const CONFIG: ProxyConfig = {
  server: { port: 8080, host: "0.0.0.0" },
  auth: { requireKey: false },
  providers: {
    zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
    bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
  },
  defaultModel: "glm-4.6",
  models: ["glm-4.6"],
  identity: IDENTITY,
  clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
  responses: { storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false },
  highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
  mcp: { enabled: true, gateway: { enabled: true, upstreamOrigin: "https://zcode.z.ai" } },
  async: {
    enabled: false,
    origin: "https://zcode.z.ai",
    pollIntervalMs: 5000,
    keepAliveIntervalMs: 3000,
    maxWaitMs: 0,
    maxRetries: 3,
    settleTimeoutMs: 8000,
    controlTimeoutMs: 15000,
    defaultModel: "",
  },
  claim: { enabled: true, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, sprintWindowMs: 1800000, sprintPollIntervalMs: 60000 },
  logging: { level: "info" },
};

function claimAccount(): Account {
  return accountFor(zhipuCredential({ apiKey: "key-g4", secret: "secret-g4", jwt: "jwt-g4" }), {
    label: "claim-solo",
    routes: ["coding-plan", "start-plan"],
  });
}

describe("claim 出线终态码 → drained（账号级，全路由）", () => {
  it("活动接口 502 + {\"code\":1005} → 该账号全部路由 drained", async () => {
    const account = claimAccount();
    const { broker } = inMemoryAccounts([account], { routing: { order: ["coding-plan"] } });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ code: 1_005, msg: "exceed quota limit" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const actions = buildClaimActions(CONFIG, account, {
      fetchImpl,
      captchaRequired: () => false,
      broker,
    });
    // 领取自身按既有语义抛 ClaimPreviewError；健康反馈在抛出前已经落表。
    await actions.discoverActivities().catch(() => undefined);

    expect(broker.health.status(account.id, "coding-plan").status).toBe("drained");
    expect(broker.health.status(account.id, "start-plan").status).toBe("drained");
  });
});

describe("claim 选号跳过 drained / auth-invalid 账号（读 health 表）", () => {
  it("health 闸：drained / auth-invalid 跳过；ok / cooling 不跳", () => {
    const account = claimAccount();
    const { broker } = inMemoryAccounts([account]);
    expect(accountHealthBlocked(broker, account)).toBe(false);
    broker.health.markDrained(account.id, "coding-plan");
    expect(accountHealthBlocked(broker, account)).toBe(true);
    broker.health.markOk(account.id, "coding-plan");
    broker.health.apply({ kind: "auth" }, account.id, "start-plan");
    broker.health.apply({ kind: "auth" }, account.id, "start-plan");
    broker.health.apply({ kind: "auth" }, account.id, "start-plan");
    // 3 次 auth → auth-invalid。
    expect(broker.health.status(account.id, "start-plan").status).toBe("auth-invalid");
    expect(accountHealthBlocked(broker, account)).toBe(true);
    broker.health.resetAuthInvalid(account.id, "start-plan");
    broker.health.apply({ kind: "rate-limited", retryAfterSeconds: 60 }, account.id, "coding-plan");
    // 冷却不挡 claim（那是容量事实，不是账号终态）。
    expect(accountHealthBlocked(broker, account)).toBe(false);
  });

  it("调度器闸：被挡的账号这一拍不发请求，恢复后下一拍照常", async () => {
    const account = claimAccount();
    const { broker } = inMemoryAccounts([account], { routing: { order: ["coding-plan"] } });
    let created = 0;
    const gateway: ClaimGateway = {
      discoverActivities: async () => ({ activities: [], diagnostics: { noDelivery: true, versionGate: false, eligibility: false, reasons: [] } }),
      claim: async (planId) => ({ ok: true, planId }),
    };
    const scheduler = new ClaimScheduler({
      accountId: account.id,
      getJwt: async () => "jwt-g4",
      createClient: () => {
        created += 1;
        return gateway;
      },
      getCaptcha: async () => ({ verifyParam: "x" }),
      captchaRequired: () => false,
      accountBlocked: () => accountHealthBlocked(broker, account),
      config: { pollIntervalMs: 300_000, cooldownMs: 600_000, sprintWindowMs: 0, sprintPollIntervalMs: 60_000 },
      log: () => {},
    });

    broker.health.markDrained(account.id, "coding-plan");
    const blocked = await scheduler.tick();
    expect(blocked.action).toBe("skipped_hold");
    expect(created).toBe(0);

    broker.health.markOk(account.id, "coding-plan");
    const resumed = await scheduler.tick();
    expect(resumed.action).not.toBe("skipped_hold");
    expect(created).toBe(1);
    scheduler.stop();
  });
});
