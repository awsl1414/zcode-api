/**
 * broker 的显式指定用例（label / 钉 id / 钉路由）。
 *
 * 重点不在"能返回账号"，而在**不静默改道**：显式指定（label / 钉住 id / 钉住
 * 路由）出问题时必须报错，因为静默改道会让 `X-ZCode-Account` 这个头变成"建议"
 * 而不是"要求"。
 *
 * @see 选号顺序 · 租约
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountUnavailableError, Broker } from "./broker.js";
import type { BrokerErrorCode } from "./broker.js";
import { AccountManager } from "./manager.js";
import { writePolicyOverrides } from "./policy-store.js";
import type { AccountsStore } from "./store.js";
import { emptyAccountsFile } from "./types.js";
import type { AccountsFile, Credential } from "./types.js";
import { DEFAULT_ACCOUNTS_QUOTA } from "./quota.js";
import { DEFAULT_ACCOUNTS_ROUTING, DEFAULT_ACCOUNTS_STICKINESS } from "./routing.js";
import type { AccountsRouting, AccountsStickiness } from "./routing.js";
import { DEFAULT_ACCOUNTS_RISK, type AccountsConfig, type AccountsRisk, type ProxyConfig } from "../config/types.js";

class MemoryStore implements AccountsStore {
  constructor(private file: AccountsFile = emptyAccountsFile()) {}
  async load(): Promise<AccountsFile> {
    return structuredClone(this.file);
  }
  async save(next: AccountsFile): Promise<void> {
    this.file = structuredClone(next);
  }
}

const ZAI_FULL: Credential = {
  kind: "zhipu-account",
  provider: "zai",
  apiKey: "apiKeyId0001",
  secret: "secret0001",
  jwt: "plan.jwt.token",
  identity: { targetType: "PERSONAL" , deviceMid: "test-device-mid" },
};

function expectBrokerError(fn: () => Promise<unknown>, code: BrokerErrorCode): Promise<void> {
  return fn().then(
    () => {
      throw new Error(`expected AccountUnavailableError(${code})`);
    },
    (e: unknown) => {
      expect(e).toBeInstanceOf(AccountUnavailableError);
      expect((e as AccountUnavailableError).code).toBe(code);
    },
  );
}

describe("Broker.acquire — 默认账号", () => {
  let manager: AccountManager;
  let broker: Broker;

  beforeEach(() => {
    manager = new AccountManager(new MemoryStore());
    broker = new Broker(manager);
  });

  // 路由由 `routing.order` 决定，不取"白名单第一条"：
  // 这份凭据同时支持 coding-plan 与 start-plan，默认 order 里 start-plan 优先。
  it("按 routing.order 选路由（默认 start-plan 优先），并带回该账号的凭据", async () => {
    const added = await manager.add({ label: "work", credential: ZAI_FULL });
    const lease = await broker.acquire();

    expect(lease.account.id).toBe(added.id);
    expect(lease.credential).toEqual(ZAI_FULL);
    expect(lease.route).toBe("start-plan"); // 默认 order: start-plan → coding-plan
  });

  it("没有账号时明确报 no-account", async () => {
    await expectBrokerError(() => broker.acquire(), "no-account");
  });

  it("release 幂等：重复调用不重复计数（无槽位泄漏）", async () => {
    await manager.add({ label: "work", credential: ZAI_FULL });
    const lease = await broker.acquire();
    expect(broker.leases.inflight(lease.account.id, lease.route)).toBe(1);
    lease.release();
    lease.release();
    expect(broker.leases.inflight(lease.account.id, lease.route)).toBe(0);
    expect(broker.leases.totalInflight()).toBe(0);
  });

  it("租约里的账号是快照，改它不影响存储", async () => {
    const added = await manager.add({ label: "work", credential: ZAI_FULL });
    const lease = await broker.acquire();
    lease.account.label = "mutated";
    expect((await manager.get(added.id))?.label).toBe("work");
  });
});

describe("Broker.acquire — 显式指定", () => {
  let manager: AccountManager;
  let broker: Broker;

  beforeEach(async () => {
    manager = new AccountManager(new MemoryStore());
    broker = new Broker(manager);
  });

  it("按 label 指定（X-ZCode-Account）", async () => {
    await manager.add({ label: "work", credential: ZAI_FULL });
    const trial = await manager.add({
      label: "trial",
      // JWT-only：apiKey 为空，指纹只能靠 upstreamUserId。
      credential: { ...ZAI_FULL, apiKey: "", secret: undefined, jwt: "jwt-trial", upstreamUserId: "user-trial" },
    });

    const lease = await broker.acquire({ requestedAccount: "trial" });
    expect(lease.account.id).toBe(trial.id);
    expect(lease.route).toBe("start-plan");
  });

  it("label 不存在 → account-unknown（不静默落到默认账号）", async () => {
    await manager.add({ label: "work", credential: ZAI_FULL });
    await expectBrokerError(() => broker.acquire({ requestedAccount: "nope" }), "account-unknown");
  });

  it("按 id 钉住（Responses 续轮）", async () => {
    const first = await manager.add({ label: "work", credential: ZAI_FULL });
    await manager.add({ label: "payg", credential: { ...ZAI_FULL, apiKey: "second-key", secret: "second-secret" } });

    const lease = await broker.acquire({ pinnedAccountId: first.id });
    expect(lease.account.id).toBe(first.id);
  });

  it("钉住的 id 不存在 → account-unknown", async () => {
    await manager.add({ label: "work", credential: ZAI_FULL });
    await expectBrokerError(() => broker.acquire({ pinnedAccountId: "missing" }), "account-unknown");
  });

  it("被禁用的账号被显式指定 → account-disabled（不是悄悄换一个）", async () => {
    const added = await manager.add({ label: "work", credential: ZAI_FULL });
    await manager.update(added.id, { enabled: false });
    await manager.add({ label: "payg", credential: { ...ZAI_FULL, apiKey: "second-key", secret: "second-secret" } });

    await expectBrokerError(() => broker.acquire({ requestedAccount: "work" }), "account-disabled");
  });
});

describe("Broker.acquire — 路由钉住", () => {
  it("钉住白名单内的路由则用它", async () => {
    const manager = new AccountManager(new MemoryStore());
    const broker = new Broker(manager);
    await manager.add({ label: "work", credential: ZAI_FULL, routes: ["coding-plan", "start-plan"] });

    const lease = await broker.acquire({ pinnedRoute: "start-plan" });
    expect(lease.route).toBe("start-plan");
  });

  it("钉住白名单外的路由 → route-not-allowed", async () => {
    const manager = new AccountManager(new MemoryStore());
    const broker = new Broker(manager);
    await manager.add({ label: "work", credential: ZAI_FULL, routes: ["coding-plan"] });

    await expectBrokerError(() => broker.acquire({ pinnedRoute: "start-plan" }), "route-not-allowed");
  });

  it("只开 start-plan 的账号默认路由就是 start-plan", async () => {
    const manager = new AccountManager(new MemoryStore());
    const broker = new Broker(manager);
    await manager.add({ label: "trial", credential: ZAI_FULL, routes: ["start-plan"] });

    const lease = await broker.acquire();
    expect(lease.route).toBe("start-plan");
  });

  // X-ZCode-Route 头：label 钉住 + 路由钉住的组合。broker 侧本来就能表达
  // （requestedAccount 与 pinnedRoute 各自进 AcquireRequest），这两个用例把组合语义
  // 钉在调度器层，请求头那一层（proxy/handler-route-header.test.ts）只测传递。
  it("label 钉住 + 路由钉住：落在指定账号的指定路由上", async () => {
    const manager = new AccountManager(new MemoryStore());
    const broker = new Broker(manager);
    const single = await manager.add({ label: "single", credential: ZAI_FULL, routes: ["coding-plan"] });
    const multi = await manager.add({ label: "multi", credential: { ...ZAI_FULL, apiKey: "second-key", secret: "second-secret" }, routes: ["coding-plan", "start-plan"] });

    const lease = await broker.acquire({ requestedAccount: "multi", pinnedRoute: "start-plan" });
    expect(lease.account.id).toBe(multi.id);
    expect(lease.route).toBe("start-plan");
    expect(lease.account.id).not.toBe(single.id);
  });

  it("label 钉住的账号不允许该路由 → route-not-allowed（不静默改道）", async () => {
    const manager = new AccountManager(new MemoryStore());
    const broker = new Broker(manager);
    await manager.add({ label: "single", credential: ZAI_FULL, routes: ["coding-plan"] });
    await manager.add({ label: "multi", credential: { ...ZAI_FULL, apiKey: "second-key", secret: "second-secret" }, routes: ["coding-plan", "start-plan"] });

    await expectBrokerError(() => broker.acquire({ requestedAccount: "single", pinnedRoute: "start-plan" }), "route-not-allowed");
  });
});

/** 一份配置形状的 `accounts` 段（缺省项按内置默认值补齐）。 */
function accountsSection(overrides: {
  routing?: Partial<AccountsRouting>;
  stickiness?: Partial<AccountsStickiness>;
  risk?: Partial<AccountsRisk>;
  entries?: AccountsConfig["entries"];
  proxies?: AccountsConfig["proxies"];
} = {}): NonNullable<ProxyConfig["accounts"]> {
  return {
    routing: { ...DEFAULT_ACCOUNTS_ROUTING, order: [...DEFAULT_ACCOUNTS_ROUTING.order], ...overrides.routing },
    stickiness: { ...DEFAULT_ACCOUNTS_STICKINESS, ...overrides.stickiness },
    quota: { ...DEFAULT_ACCOUNTS_QUOTA },
    risk: { ...DEFAULT_ACCOUNTS_RISK, ...overrides.risk },
    entries: overrides.entries ?? [],
    ...(overrides.proxies ? { proxies: overrides.proxies } : {}),
  };
}

describe("Broker.applyConfigAccounts — 配置热重载", () => {
  // `applyConfigAccounts` 真的读 policy.json：每个用例一个临时目录，绝不落到
  // 真实的 ~/.zcode-proxy（那里的覆盖会让断言跟着本机的使用记录漂移）。
  let previousStoreDir: string | undefined;
  let storeDir = "";

  beforeEach(() => {
    previousStoreDir = process.env.ZCODE_PROXY_STORE_DIR;
    storeDir = mkdtempSync(join(tmpdir(), "zcode-broker-reload-"));
    process.env.ZCODE_PROXY_STORE_DIR = storeDir;
  });

  afterEach(() => {
    if (previousStoreDir === undefined) delete process.env.ZCODE_PROXY_STORE_DIR;
    else process.env.ZCODE_PROXY_STORE_DIR = previousStoreDir;
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("把 config 里的 routing / entries / proxies 灌进运行时对象", async () => {
    const manager = new AccountManager(new MemoryStore());
    const broker = new Broker(manager);
    const next = accountsSection({
      routing: { order: ["coding-plan", "start-plan"], withinTier: "strategy", strategy: "balanced" },
      entries: [{ label: "a1", weight: 3 }],
      proxies: [{ name: "home", url: "http://127.0.0.1:7890" }],
    });

    await broker.applyConfigAccounts(next);

    expect(broker.routing.order).toEqual(["coding-plan", "start-plan"]);
    expect(broker.routing.withinTier).toBe("strategy");
    expect(broker.routing.strategy).toBe("balanced");
    // 配置里没动的字段保持原值（热重载是逐字段合并，不是整段重建）。
    expect(broker.routing.maxQueue).toBe(64);
    expect(broker.proxyTable().map((proxy) => proxy.name)).toEqual(["home"]);
  });

  it("policy.json 的显式覆盖赢过热重载进来的配置", async () => {
    await writePolicyOverrides({ routing: { order: ["start-plan"] } });
    const manager = new AccountManager(new MemoryStore());
    const broker = new Broker(manager);

    await broker.applyConfigAccounts(accountsSection({ routing: { order: ["coding-plan"] } }));

    expect(broker.routing.order).toEqual(["start-plan"]);
  });
});

describe("Broker.applyConfigAccounts — 代理表合并", () => {
  it("保留只活在内存里的运行期代理行", async () => {
    const manager = new AccountManager(new MemoryStore());
    const broker = new Broker(manager);
    broker.addProxy({ name: "runtime-only", url: "http://127.0.0.1:7891" });

    await broker.applyConfigAccounts(accountsSection({ proxies: [{ name: "home", url: "http://127.0.0.1:7890" }] }));

    expect(broker.proxyTable().map((proxy) => proxy.name)).toEqual(["home", "runtime-only"]);
  });
});
