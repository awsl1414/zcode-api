/**
 * 人工恢复与观测接线：重新登录/导入凭据 → auth-invalid
 * 回 ok；健康状态变化事件结构化落盘；路由熔断观测；socks5 代理前缀告警。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureLogging, resetLogging } from "../log/index.js";
import { resetLegacyKeyWarnings, warnUnsupportedProxyProtocol } from "../config/loader.js";
import { observeHealth } from "./health-observation.js";
import { HealthEngine } from "./health.js";
import { enrollCredential } from "./enroll.js";
import { createProductionBroker } from "./runtime.js";
import { AccountManager } from "./manager.js";
import type { AccountsStore } from "./store.js";
import type { AccountsFile, Credential } from "./types.js";
import { credentialFingerprint } from "./types.js";

function memoryStore(): AccountsStore {
  let file: AccountsFile = { version: 2, accounts: [] };
  return {
    load: async () => structuredClone(file),
    save: async (next) => {
      file = structuredClone(next);
    },
  };
}

function authCredential(jwt: string): Parameters<typeof enrollCredential>[1] {
  return {
    provider: "zai",
    apiKey: "key",
    secret: "secret",
    jwt,
    userId: "user-1",
  } as Parameters<typeof enrollCredential>[1];
}

let storeDir = "";
const prev = process.env.ZCODE_PROXY_STORE_DIR;
beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "zcode-w108-"));
  process.env.ZCODE_PROXY_STORE_DIR = storeDir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.ZCODE_PROXY_STORE_DIR;
  else process.env.ZCODE_PROXY_STORE_DIR = prev;
  rmSync(storeDir, { recursive: true, force: true });
  resetLogging();
  resetLegacyKeyWarnings();
});

describe("auth-invalid 人工恢复", () => {
  it("enrollCredential 刷新同一账号 → resetAuthInvalid 清状态，成功信号才清计数", async () => {
    const accounts = new AccountManager(memoryStore());
    const broker = await createProductionBroker(accounts, null);
    const added = await enrollCredential(accounts, authCredential("jwt-first"));
    for (let i = 0; i < 3; i++) broker.noteUpstreamSignal(added, "coding-plan", { kind: "auth" });
    expect(broker.health.status(added.id, "coding-plan").status).toBe("auth-invalid");

    await enrollCredential(accounts, authCredential("jwt-refreshed"));
    expect(broker.health.status(added.id, "coding-plan").status).toBe("ok");
    // resetAuthInvalid 不清 auth-failed 计数：坏凭据再报一次 auth 立刻重新升级。
    broker.noteUpstreamSignal(added, "coding-plan", { kind: "auth" });
    expect(broker.health.status(added.id, "coding-plan").status).toBe("auth-invalid");
  });

  it("CLI 进程写盘：control-surface 的指纹回同步也走同一条恢复（由 syncCredentialRefresh 覆盖）", async () => {
    // 指纹排除轮换的 jwt，所以「同一账号换 JWT」不会误判成新建账号。
    const a: Credential = {
      kind: "zhipu-account",
      provider: "zai",
      apiKey: "key",
      jwt: "jwt-a",
      identity: { targetType: "PERSONAL", deviceMid: "mid" },
    };
    expect(credentialFingerprint({ ...a, jwt: "jwt-b" })).toBe(credentialFingerprint(a));
  });
});

describe("observeHealth", () => {
  it("状态变化逐条带 seq，熔断开/关与探针退避档位可查", () => {
    const clock = { now: 1_700_000_000_000 };
    const health = new HealthEngine(() => clock.now, () => 0.5);
    const observed = observeHealth(health);
    health.apply({ kind: "rate-limited" }, "acc", "coding-plan");
    for (let i = 0; i < 3; i++) {
      health.apply({ kind: "endpoint-shape" }, `acc-${i}`, "start-plan");
    }
    const opened = observed.snapshot();
    expect(opened.events[0]!.type).toBe("breaker-open");
    expect(opened.events[0]!.seq).toBeGreaterThan(opened.events[1]!.seq);
    expect(opened.breakers).toHaveLength(1);
    expect(opened.breakers[0]!.status).toBe("endpoint-broken");

    health.noteProbeResult("start-plan", false);
    expect(observed.snapshot().breakers[0]!.probeBackoffs).toBe(1);
    health.noteProbeResult("start-plan", false);
    expect(observed.snapshot().breakers[0]!.probeBackoffs).toBe(2);

    health.resetBreaker("start-plan");
    expect(observed.snapshot().breakers).toEqual([]);
    observed.stop();
  });

  it("事件表有界（最近 50 条），不随进程无限增长", () => {
    const health = new HealthEngine(() => 1_700_000_000_000, () => 0.5);
    const observed = observeHealth(health);
    for (let i = 0; i < 80; i++) health.markDrained(`acc-${i}`, "start-plan");
    expect(observed.snapshot().events).toHaveLength(50);
    observed.stop();
  });
});

describe("socks5 代理前缀告警", () => {
  it("socks5:// 只告警一次并给出同端口 http:// 提示；http:// 不告警", () => {
    const lines: string[] = [];
    configureLogging({ write: (line) => { lines.push(line); } });
    expect(warnUnsupportedProxyProtocol({ https_proxy: "socks5://127.0.0.1:7897" })).toEqual(["https_proxy"]);
    expect(warnUnsupportedProxyProtocol({ https_proxy: "socks5://127.0.0.1:7897" })).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("http://127.0.0.1");
    expect(warnUnsupportedProxyProtocol({ https_proxy: "http://127.0.0.1:7897" })).toEqual([]);
  });
});
