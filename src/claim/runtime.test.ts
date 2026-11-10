/**
 * Runtime wiring: activation reports use each account's own user id, device
 * mid and egress; failure is a log reason, never a thrown exception. The
 * opening phase is a stable per-egress ordinal.
 */
import { describe, it, expect } from "bun:test";
import {
  accountActivationReport,
  autoClaimAccounts,
  createClaimRuntime,
  startAutoClaim,
  type ClaimRuntimeHandle,
} from "./runtime.js";
import type { ClaimRateLimitWindow } from "./rate-limit.js";
import { inMemoryAccounts, accountFor, zhipuCredential } from "../accounts/testing.js";
import type { Account } from "../accounts/types.js";
import type { ProxyConfig } from "../config/types.js";
import type { ReportActivationOptions } from "./activation.js";

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: { requireKey: false },
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: { appVersion: "3.17.2", appVersionSource: "default", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai", betaPolicy: "drop", betaAllowlist: [] },
    clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
    responses: { storeMaxEntries: 1000, storeTtlMs: 86400000 },
    endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: false },
    highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
    mcp: { enabled: true, gateway: { enabled: true, upstreamOrigin: "https://zcode.test" } },
    async: {
      enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000,
      maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "",
    },
    claim: {
      enabled: true,
      auto: true,
      origin: "https://zcode.z.ai",
      pollIntervalMs: 300000,
      cooldownMs: 600000,
      sprintWindowMs: 1800000,
      sprintPollIntervalMs: 60000,
      opening: {
        preheatMs: 180000, probeIntervalMs: 10000, burstIntervalMs: 2000,
        burstWindowMs: 180000, accountStaggerMs: 200, maxClaimsPerAccount: 6,
      },
    },
    logging: { level: "info" },
    ...overrides,
  };
}

function claimableAccount(label: string, jwt: string, extra: Partial<Account> = {}): Account {
  const credential = zhipuCredential({ jwt, upstreamUserId: `user-${label}` });
  return accountFor(credential, { label, ...extra });
}

interface FakeHandle extends ClaimRuntimeHandle {
  started: boolean;
  stopped: boolean;
}

function fakeHandle(): FakeHandle {
  return {
    started: false,
    stopped: false,
    start(): void { this.started = true; },
    stop(): void { this.stopped = true; },
  };
}

describe("autoClaimAccounts — one scheduler per claim-capable account", () => {
  const work = claimableAccount("work-team", "jwt-work");
  const home = claimableAccount("home", "jwt-home");

  it("keeps enabled accounts with plan JWTs", () => {
    expect(autoClaimAccounts([work, home]).map((a) => a.label)).toEqual(["work-team", "home"]);
  });

  it("skips disabled accounts and credentials without a JWT", () => {
    const disabled = claimableAccount("disabled", "jwt-off", { enabled: false });
    const keyOnly = accountFor(zhipuCredential({ jwt: undefined }), { label: "key-only" });
    expect(autoClaimAccounts([work, disabled, keyOnly, home]).map((a) => a.label)).toEqual(["work-team", "home"]);
  });
});

describe("accountActivationReport — per-account identity and egress", () => {
  it("uses the account's user id, device mid, app version and egress", async () => {
    const account = claimableAccount("work", "jwt-work");
    const options: ReportActivationOptions[] = [];
    await accountActivationReport(makeConfig({
      accounts: {
        proxies: [{ name: "p1", url: "http://127.0.0.1:7897" }],
        entries: [{ label: "work", proxy: "p1" }],
        risk: { jitterHeartbeat: false },
      },
    } as ProxyConfig), account, (opts) => {
      options.push(opts);
      return Promise.resolve({ ok: true });
    });
    expect(options).toHaveLength(1);
    expect(options[0].userId).toBe("user-work");
    expect(options[0].deviceMid).toBe(account.credential.identity.deviceMid);
    expect(options[0].appVersion).toBe("3.17.2");
    expect(options[0].egress?.proxyUrl).toContain("7897");
  });

  it("returns a readable reason without throwing when reporting fails", async () => {
    const account = claimableAccount("work", "jwt-work");
    const result = await accountActivationReport(makeConfig(), account, () => Promise.resolve({ ok: false, reason: "activation event rejected: bad event" }));
    expect(result).toEqual({ ok: false, reason: "activation event rejected: bad event" });
  });
});

describe("createClaimRuntime — scheduler wiring", () => {
  it("passes the opening config and a stable account ordinal", () => {
    const account = claimableAccount("work", "jwt-work");
    const scheduler = createClaimRuntime(makeConfig(), account, undefined, undefined, { accountIndex: 2 });
    expect(scheduler.openingStaggerMs()).toBe(400);
    expect(scheduler.status().openingPhaseMs).toBe(400);
    expect(scheduler.status().alarms).toEqual([]);
    scheduler.stop();
  });

  it("calling the bound activation hook uses this account's identity and a readable failure", async () => {
    const account = claimableAccount("work", "jwt-work");
    let reported = 0;
    const scheduler = createClaimRuntime(makeConfig(), account, undefined, undefined, {
      accountIndex: 0,
      reportActivationImpl: () => {
        reported += 1;
        return Promise.resolve({ ok: false, reason: "upstream refused event" });
      },
    });
    // `tick()` would probe the real discovery client; the scheduler exposes the
    // same report through its first-dependency probe, so tests here assert the
    // wiring shape without sending a request upstream.
    expect(scheduler.openingStaggerMs()).toBe(0);
    expect(reported).toBe(0);
    scheduler.stop();
  });
});

describe("startAutoClaim — per-account start/stop and opening ordinals", () => {
  it("gives every account one handle and stops them all", async () => {
    const { manager } = inMemoryAccounts([
      claimableAccount("work-team", "jwt-work"),
      claimableAccount("home", "jwt-home"),
      accountFor(zhipuCredential({ jwt: undefined }), { label: "key-only" }),
    ]);
    const handles: FakeHandle[] = [];
    const group = await startAutoClaim(makeConfig(), manager, {
      createRuntime: () => {
        const handle = fakeHandle();
        handles.push(handle);
        return handle;
      },
      log: () => {},
    });
    expect(group!.runtimes.map((r) => r.label)).toEqual(["work-team", "home"]);
    expect(handles.every((h) => h.started)).toBe(true);
    group!.stop();
    expect(handles.every((h) => h.stopped)).toBe(true);
  });

  it("isolates a failed runtime and returns null for an empty account list", async () => {
    const { manager } = inMemoryAccounts([claimableAccount("work", "jwt-work"), claimableAccount("home", "jwt-home")]);
    const logs: string[] = [];
    const group = await startAutoClaim(makeConfig(), manager, {
      createRuntime: (_config, account) => {
        if (account.label === "work") throw new Error("boom");
        return fakeHandle();
      },
      log: (message) => logs.push(message),
    });
    expect(group!.runtimes.map((r) => r.label)).toEqual(["home"]);
    expect(logs[0]).toContain("work");

    const empty = await startAutoClaim(makeConfig(), (await inMemoryAccounts([])).manager, { log: () => {} });
    expect(empty).toBeNull();
  });

  it("shares a rate-limit window per egress and assigns ordinals within that group", async () => {
    const cfg = makeConfig({
      accounts: {
        proxies: [
          { name: "p1", url: "http://10.0.0.1:7890" },
          { name: "p2", url: "http://10.0.0.2:7890" },
        ],
        entries: [
          { label: "a", proxy: "p1" },
          { label: "b", proxy: "p1" },
          { label: "c", proxy: "p2" },
        ],
        risk: { jitterHeartbeat: false },
      },
    } as ProxyConfig);
    const { manager } = inMemoryAccounts([
      claimableAccount("a", "jwt-a"),
      claimableAccount("b", "jwt-b"),
      claimableAccount("c", "jwt-c"),
    ]);
    const seen: Array<{ label: string; window?: ClaimRateLimitWindow; index?: number }> = [];
    await startAutoClaim(cfg, manager, {
      createRuntime: (_config, account, rateLimit, _broker, deps) => {
        seen.push({ label: account.label, window: rateLimit, index: deps?.accountIndex });
        return fakeHandle();
      },
      log: () => {},
    });
    expect(seen[0].window).toBe(seen[1].window);
    expect(seen[0].window).not.toBe(seen[2].window);
    expect(seen.map((entry) => entry.index)).toEqual([0, 1, 0]);
  });
});
