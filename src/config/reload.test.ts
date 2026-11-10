/**
 * 配置热重载的单元测试：比对、就地替换、C 类跳过与分类。
 *
 * `reloadConfig` 是纯函数：输入两份 `ProxyConfig`，输出变化的顶层键。这里的夹具
 * 是手写的最小配置（与 `loader.ts` 的产物同形），不落盘。
 */
import { describe, expect, it } from "bun:test";
import { classifyReload, configEqual, reloadConfig, RESTART_REQUIRED } from "./reload.js";
import type { ProxyConfig } from "./types.js";

/** 一份够用的最小配置（loadConfig 产物同形；`accounts` 段对热重载是嵌套对象代表）。*/
function config(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    server: { port: 8080, host: "127.0.0.1" },
    auth: { requireKey: false },
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: {
        anthropicBase: "https://open.bigmodel.cn/api/anthropic",
        openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4",
      },
    },
    defaultModel: "glm-5.3",
    models: ["glm-5.3"],
    identity: {
      appVersion: "3.17.1",
      appVersionSource: "default",
      sourceTitle: "cli",
      refererOrigin: "https://zcode.z.ai",
      betaPolicy: "drop",
      betaAllowlist: [],
    },
    clientIdentity: { mode: "enforce", ttlSeconds: 900, maxSessions: 1024 },
    responses: { storeMaxEntries: 1000, storeTtlMs: 86_400_000 },
    endpointRouting: { enabled: true, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: true },
    highspeed: { enabled: true, origin: "https://zcode.z.ai", models: ["glm-5.3"] },
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
    claim: {
      enabled: true,
      auto: true,
      origin: "https://zcode.z.ai",
      pollIntervalMs: 300_000,
      cooldownMs: 600_000,
      sprintWindowMs: 1_800_000,
      sprintPollIntervalMs: 60_000,
    },
    logging: { level: "info", dump: { enabled: false, path: "" } },
    ...overrides,
  };
}

describe("configEqual", () => {
  it("equals identical structures and differs on nested changes", () => {
    expect(configEqual({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } })).toBe(true);
    expect(configEqual({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 3] } })).toBe(false);
    expect(configEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("compares object keys order-insensitively and array items order-sensitively", () => {
    expect(configEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(configEqual([1, 2], [2, 1])).toBe(false);
    // 键集合不同不算相等（loadConfig 产物键齐全，这条是给手写配置兜底的）。
    expect(configEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });
});

describe("reloadConfig", () => {
  it("reports an A-class change and updates the target in place", () => {
    const target = config();
    const next = config({ async: { ...target.async, enabled: true } });
    const changed = reloadConfig(target, next);
    expect(changed).toEqual(["async"]);
    // 内存里那份立刻是新值：持有者下一次读取就能看到（A 类）。
    expect(target.async.enabled).toBe(true);
  });

  it("reports nothing when both sides agree", () => {
    const target = config();
    const asyncBefore = target.async;
    expect(reloadConfig(target, config())).toEqual([]);
    // 没有变化就不动对象：段还是原来那个引用，持有者不会看到无谓的换代。
    expect(target.async).toBe(asyncBefore);
  });

  it("replaces a nested segment as a whole (either the whole segment or nothing)", () => {
    const target = config();
    const before = target.identity;
    const next = config({
      identity: {
        appVersion: "3.99.0",
        appVersionSource: "manual",
        sourceTitle: "cli",
        refererOrigin: "https://zcode.z.ai",
        betaPolicy: "drop",
        betaAllowlist: [],
      },
    });
    const changed = reloadConfig(target, next);
    expect(changed).toEqual(["identity"]);
    expect(target.identity).toBe(next.identity);
    expect(target.identity).not.toBe(before);
    // 整段替换：旧引用看到的还是旧值（持有旧段的地方不会被悄悄改动）。
    expect(before.appVersion).toBe("3.17.1");
  });

  it("deep-replaces the accounts segment (nested objects)", () => {
    const target = config();
    // SAFETY: 这里只造 AccountsConfig 的一个子集给比对用，routing/stickiness 的
    // 具体形状与热重载无关（reloadConfig 按整段替换，不深入字段）。
    target.accounts = {
      routing: { order: ["coding-plan"] },
      stickiness: { enabled: false, ttlSeconds: 1, maxSessions: 1 },
      quota: { pollSeconds: 300, drainThreshold: 1 },
      risk: { jitterHeartbeat: true },
      entries: [],
    } as unknown as ProxyConfig["accounts"];
    const next = config();
    next.accounts = {
      ...target.accounts,
      quota: { pollSeconds: 120, drainThreshold: 0.85 },
    } as unknown as ProxyConfig["accounts"];
    const changed = reloadConfig(target, next);
    expect(changed).toEqual(["accounts"]);
    expect(target.accounts?.quota.pollSeconds).toBe(120);
    expect(target.accounts?.routing).toBe(next.accounts?.routing);
  });

  it("skips the C-class server segment but still lists it", () => {
    const target = config();
    const next = config({ server: { port: 9090, host: "0.0.0.0" } });
    const changed = reloadConfig(target, next);
    // 出现在清单里：调用方要拿它去分类 restart_required。
    expect(changed).toEqual(["server"]);
    // 内存保留旧值：页面显示新端口、监听也还在旧端口，是「需要重启」而不是假生效。
    expect(target.server).toEqual({ port: 8080, host: "127.0.0.1" });
  });

  it("does not touch RESTART_REQUIRED fields via any path", () => {
    expect([...RESTART_REQUIRED].sort()).toEqual(["server.host", "server.port"].sort());
  });
});

describe("classifyReload", () => {
  it("splits server changes into dotted field names", () => {
    const target = config();
    const next = config({ server: { port: 9090, host: "0.0.0.0" } });
    const changed = reloadConfig(target, next);
    const outcome = classifyReload(target, next, changed);
    // reloadConfig 跳过了整段，target.server 还是旧值，所以两个字段都比对得出变化。
    expect(outcome).toEqual({
      reloaded: [],
      restartRequired: ["server.port", "server.host"],
    });
  });

  it("reports only the field that actually changed", () => {
    const target = config();
    const next = config({ server: { port: 9090, host: "127.0.0.1" } });
    const outcome = classifyReload(target, next, reloadConfig(target, next));
    expect(outcome.restartRequired).toEqual(["server.port"]);
  });

  it("keeps hot keys in reloaded and never mentions server twice", () => {
    const target = config();
    const next = config({ highspeed: { enabled: false, origin: "https://zcode.z.ai", models: ["glm-5.3"] } });
    const outcome = classifyReload(target, next, reloadConfig(target, next));
    expect(outcome).toEqual({ reloaded: ["highspeed"], restartRequired: [] });
  });

  it("classifies a mixed change (B-class + C-class)", () => {
    const target = config();
    const next = config({
      highspeed: { enabled: true, origin: "https://mirror.zcode.z.ai", models: ["glm-5.3"] },
      server: { port: 9090, host: "127.0.0.1" },
    });
    const outcome = classifyReload(target, next, reloadConfig(target, next));
    expect(outcome.reloaded).toEqual(["highspeed"]);
    expect(outcome.restartRequired).toEqual(["server.port"]);
    // B 类进内存、C 类不进：target 里只有 highspeed 是新的。
    expect(target.highspeed.origin).toBe("https://mirror.zcode.z.ai");
    expect(target.server.port).toBe(8080);
  });
});
