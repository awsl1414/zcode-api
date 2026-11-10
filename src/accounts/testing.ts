/**
 * 测试夹具：内存版账号仓 + `AccountManager` + `Broker`。
 *
 * **只给测试用**（生产代码不 import 它，所以不会进编译产物）。
 *
 * 为什么不走 `AccountManager.add()`：那是**写入时**校验的入口（凭据类型、路由白名单、
 * TEAM 身份那六条规则），
 * 而请求链路的用例要测的恰恰是"账号已经躺在存储里"之后的行为，包括那些写入时
 * 根本不让落的非法组合（例如 JWT-only 凭据却带着 coding-plan 路由，用来验证
 * `checkSurface` 的运行时拦截）。直接构造 `AccountsFile` 并注入一个只读 store，
 * 就是"手改文件"这件事的等价物，也正是运行时必须兜住的情形。
 */
import { AccountManager } from "./manager.js";
import type { AccountsStore } from "./store.js";
import { Broker } from "./broker.js";
import type { BrokerOptions } from "./broker-options.js";
import { ACCOUNTS_STORE_VERSION, credentialFingerprint, defaultPolicy } from "./types.js";
import type { Account, AccountsFile, Credential, RouteKind } from "./types.js";

/** 一份 `zhipu-account` 凭据（默认 PERSONAL 身份）。*/
export function zhipuCredential(
  overrides: Partial<Extract<Credential, { kind: "zhipu-account" }>> = {},
): Extract<Credential, { kind: "zhipu-account" }> {
  return {
    kind: "zhipu-account",
    provider: "zai",
    apiKey: "testkey",
    secret: "testsecret",
    identity: { targetType: "PERSONAL", deviceMid: "test-device-mid" },
    ...overrides,
  };
}

/** 由凭据指纹算 id，避免每个用例手写 sha256。*/
export function accountFor(
  credential: Credential,
  overrides: Partial<Omit<Account, "credential">> = {},
): Account {
  return {
    id: credentialFingerprint(credential),
    label: "test",
    credential,
    routes: ["coding-plan"] as RouteKind[],
    enabled: true,
    policy: defaultPolicy(),
    ...overrides,
  };
}

/** 只读 store：`save` 只更新内存快照，测试不落盘。*/
function memoryStore(initial: AccountsFile): AccountsStore {
  let file = initial;
  return {
    load: async () => ({ ...file, accounts: file.accounts.map((a) => ({ ...a })) }),
    save: async (next) => {
      file = next;
    },
  };
}

export interface InMemoryAccounts {
  manager: AccountManager;
  broker: Broker;
}

/**
 * 用一组账号建一个可用的 `AccountManager` + `Broker`。
 *
 * `options` 注入调度参数（`routing` / `entries` / `now` / `leases`），并发与热调节的
 * 用例靠它把上限、队列、时钟压到可测的尺度。
 */
export function inMemoryAccounts(
  accounts: Account[],
  _options?: BrokerOptions,
): InMemoryAccounts {
  const file: AccountsFile = {
    version: ACCOUNTS_STORE_VERSION,
    accounts,
  };
  const manager = new AccountManager(memoryStore(file));
  return { manager, broker: new Broker(manager, _options) };
}

/** 单账号便捷入口：一份凭据 + 路由白名单 → broker。*/
export function brokerFor(
  credential: Credential,
  routes: RouteKind[] = ["coding-plan"],
  options?: BrokerOptions,
): InMemoryAccounts {
  return inMemoryAccounts([accountFor(credential, { routes })], options);
}
