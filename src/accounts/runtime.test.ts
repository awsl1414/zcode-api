/**
 * `createBroker` 的三层合并用例。
 *
 * 优先级链只有一条：
 *
 * ```
 * 持久化覆盖（policy.json） > config.yaml 的 accounts 段 > 内置默认值
 * ```
 *
 * 这一组用例专门钉住「中间那层可以空、最上面那层不能跟着消失」。`cli/control.ts`
 * 在没有 config.yaml 时给 `createBroker` 传 `null`，而用户改过的策略就写在
 * `policy.json` 里。若这条路径整块跳过读文件，`routing show` 就会显示内置默认值。
 *
 * @see 策略持久化走 sidecar
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ACCOUNTS_RISK } from "../config/types.js";
import type { AccountsConfig, AccountsRisk, ProxyConfig } from "../config/types.js";
import { writePolicyOverrides } from "./policy-store.js";
import { DEFAULT_ACCOUNTS_QUOTA } from "./quota.js";
import { DEFAULT_ACCOUNTS_ROUTING, DEFAULT_ACCOUNTS_STICKINESS } from "./routing.js";
import type { AccountsRouting, AccountsStickiness } from "./routing.js";
import { DEFAULT_BROKER_OPTIONS, brokerOptionsFromConfig } from "./broker-options.js";
import { createBroker, readPersistedPolicy } from "./runtime.js";
import { accountFor, inMemoryAccounts, zhipuCredential } from "./testing.js";
import type { Account, RouteKind } from "./types.js";

/**
 * 每个用例一个临时 store 目录：这组用例真的读 `policy.json`，**绝不能**落到真实的
 * `~/.zcode-proxy`。
 */
let storeDir = "";
const prevStoreDir = process.env.ZCODE_PROXY_STORE_DIR;

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "zcode-broker-layers-"));
  process.env.ZCODE_PROXY_STORE_DIR = storeDir;
});

afterEach(() => {
  if (prevStoreDir === undefined) delete process.env.ZCODE_PROXY_STORE_DIR;
  else process.env.ZCODE_PROXY_STORE_DIR = prevStoreDir;
  rmSync(storeDir, { recursive: true, force: true });
});

const ROUTES: RouteKind[] = ["start-plan", "coding-plan"];

function solo(): Account {
  return accountFor(zhipuCredential({ apiKey: "key-solo", secret: "secret-solo", jwt: "jwt-solo" }), {
    label: "solo",
    routes: ROUTES,
  });
}

/** 一份 config.yaml 的 `accounts` 段：缺省项按内置默认值补齐，只覆盖用例关心的字段。*/
function accountsConfig(
  overrides: {
    routing?: Partial<AccountsRouting>;
    stickiness?: Partial<AccountsStickiness>;
    risk?: Partial<AccountsRisk>;
  } = {},
): AccountsConfig {
  return {
    routing: { ...DEFAULT_ACCOUNTS_ROUTING, order: [...DEFAULT_ACCOUNTS_ROUTING.order], ...overrides.routing },
    stickiness: { ...DEFAULT_ACCOUNTS_STICKINESS, ...overrides.stickiness },
    quota: { ...DEFAULT_ACCOUNTS_QUOTA },
    risk: { ...DEFAULT_ACCOUNTS_RISK, ...overrides.risk },
    entries: [],
  };
}

/**
 * 一份带 `accounts` 段的 `ProxyConfig`。
 *
 * `createBroker` 只读 `config.accounts`（其余段是请求链路的），所以这里只填那一段再
 * 断言成完整类型：把十几段与本组用例无关的默认值抄进来只会让断言变模糊。
 */
function configWith(
  overrides: Parameters<typeof accountsConfig>[0] = {},
): ProxyConfig {
  return { accounts: accountsConfig(overrides) } as unknown as ProxyConfig;
}

describe("createBroker 的三层合并（优先级链）", () => {
  it("config 为 null 时仍读 policy.json 的 routing", async () => {
    // 用户删了 config.yaml，但 policy.json 里还留着他显式改过的值。
    await writePolicyOverrides({ routing: { order: ["coding-plan"], mode: "only" } });

    const { manager } = inMemoryAccounts([solo()]);
    const broker = await createBroker(manager, null);

    expect(broker.routing.order).toEqual(["coding-plan"]);
    expect(broker.routing.mode).toBe("only");
    // sidecar 只存改过的字段，其余仍是内置默认值：不该因为读了一次文件就丢字段。
    expect(broker.routing.strategy).toBe(DEFAULT_ACCOUNTS_ROUTING.strategy);
    expect(broker.routing.maxQueue).toBe(DEFAULT_ACCOUNTS_ROUTING.maxQueue);
  });

  it("config 为 null 时账号级覆盖（entries）仍生效", async () => {
    await writePolicyOverrides({ entries: { solo: { maxConcurrency: 4 } } });

    const { manager } = inMemoryAccounts([solo()]);
    const broker = await createBroker(manager, null);

    expect(broker.overrides.get("solo")).toEqual({ maxConcurrency: 4 });
  });

  it("config 存在时持久化覆盖赢过 config.yaml", async () => {
    await writePolicyOverrides({ routing: { order: ["coding-plan"] } });

    const { manager } = inMemoryAccounts([solo()]);
    const broker = await createBroker(manager, configWith({ routing: { order: ["start-plan"] } }));

    expect(broker.routing.order).toEqual(["coding-plan"]);
  });

  it("config 存在、policy 没写的字段保留 config.yaml 的值（不是内置默认值）", async () => {
    await writePolicyOverrides({ routing: { order: ["coding-plan"] } });

    const { manager } = inMemoryAccounts([solo()]);
    const broker = await createBroker(
      manager,
      configWith({ routing: { maxQueue: 7, onSaturated: "overflow" } }),
    );

    expect(broker.routing.order).toEqual(["coding-plan"]);
    expect(broker.routing.maxQueue).toBe(7);
    expect(broker.routing.onSaturated).toBe("overflow");
  });

  it("用例注入的 options 赢过持久化覆盖", async () => {
    await writePolicyOverrides({ routing: { order: ["coding-plan"] } });

    const { manager } = inMemoryAccounts([solo()]);
    const broker = await createBroker(manager, null, { routing: { order: ["start-plan"] } });

    expect(broker.routing.order).toEqual(["start-plan"]);
  });

  it("空 store + null config 就是内置默认值", async () => {
    const { manager } = inMemoryAccounts([solo()]);
    const broker = await createBroker(manager, null);

    expect(broker.routing).toEqual(DEFAULT_ACCOUNTS_ROUTING);
    expect(broker.stickiness).toEqual(DEFAULT_ACCOUNTS_STICKINESS);
    expect(broker.risk).toEqual(DEFAULT_ACCOUNTS_RISK);
  });

  it("readPersistedPolicy 只读 sidecar，不碰 config", async () => {
    await writePolicyOverrides({ stickiness: { overflowAfterMs: 1234 } });

    expect(await readPersistedPolicy()).toEqual({ stickiness: { overflowAfterMs: 1234 } });
  });

  it("中间那层的两种空法走同一条路：没有 accounts 段就是内置默认值", () => {
    // 没有 config.yaml：`cli/control.ts` 传 null，落到这里。
    expect(brokerOptionsFromConfig(undefined)).toEqual(DEFAULT_BROKER_OPTIONS);
    // 有 config.yaml 但没写 `accounts`：同一件事，只是空在上面一层。
    expect(brokerOptionsFromConfig(accountsConfig({ routing: { maxQueue: 7 } })).routing).toEqual({
      ...DEFAULT_ACCOUNTS_ROUTING,
      maxQueue: 7,
    });
  });
});
