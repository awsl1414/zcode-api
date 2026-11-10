/**
 * 账号管理者的用例：CRUD、能力推断，以及校验规则。
 *
 * 六条规则单独成组，因为它们的价值是**写入时就拒掉非法组合**。每条规则给一个
 * 反例（必须抛对应错误码）和一个正例（同形状但去掉违规点后必须通过）——
 * 只测反例的话，一个"永远抛错"的实现也能全绿。
 *
 * @see 校验规则
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  AccountError,
  AccountManager,
  inferRoutes,
  normalizeRoutes,
  validateAccount,
} from "./manager.js";
import type { AccountErrorCode, NewAccount } from "./manager.js";
import type { AccountsStore } from "./store.js";
import { emptyAccountsFile } from "./types.js";
import type { Account, AccountsFile, Credential, RouteKind } from "./types.js";

/** 内存存储后端：六条规则的用例不该碰磁盘。*/
class MemoryStore implements AccountsStore {
  writes = 0;
  constructor(private file: AccountsFile = emptyAccountsFile()) {}

  async load(): Promise<AccountsFile> {
    return structuredClone(this.file);
  }

  async save(next: AccountsFile): Promise<void> {
    this.file = structuredClone(next);
    this.writes += 1;
  }

  snapshot(): AccountsFile {
    return structuredClone(this.file);
  }
}

/** 写入必失败的存储，用来验证"写失败不改内存"。*/
class FailingStore implements AccountsStore {
  async load(): Promise<AccountsFile> {
    return emptyAccountsFile();
  }

  async save(): Promise<void> {
    throw new Error("disk full");
  }
}

const ZAI_PAIR: Credential = {
  kind: "zhipu-account",
  provider: "zai",
  apiKey: "apiKeyId0001",
  secret: "secret0001",
  identity: { targetType: "PERSONAL", deviceMid: "test-device-mid" },
};

/** 完整凭据：apiKey 对 + plan JWT。*/
const ZAI_FULL: Credential = { ...ZAI_PAIR, jwt: "plan.jwt.token" };

/** 第二个账号的完整凭据（apiKey 对与 `ZAI_FULL` 不同，指纹因此不同）。*/
const ZAI_SECOND: Credential = { ...ZAI_FULL, apiKey: "apiKeyId0002", secret: "secret0002" };

/**
 * JWT-only（`auth import --jwt` 的产物）。
 *
 * `upstreamUserId` 是这个形态的必需项：apiKey 为空、jwt 不进指纹，账号身份只能靠
 * payload 的 `user_id`。真实导入路径会填它，所以夹具也要填。
 */
const ZAI_JWT_ONLY: Credential = {
  kind: "zhipu-account",
  provider: "zai",
  apiKey: "",
  jwt: "plan.jwt.token",
  upstreamUserId: "user-0001",
  identity: { targetType: "PERSONAL", deviceMid: "test-device-mid" },
};

/** 期望抛出带指定 code 的 AccountError。*/
function expectAccountError(fn: () => unknown, code: AccountErrorCode): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(AccountError);
  expect((caught as AccountError).code).toBe(code);
}

async function expectAccountErrorAsync(fn: () => Promise<unknown>, code: AccountErrorCode): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(AccountError);
  expect((caught as AccountError).code).toBe(code);
}

function accountOf(overrides: Partial<Account> = {}): Account {
  return {
    id: "id-1",
    label: "work",
    credential: ZAI_FULL,
    routes: ["coding-plan"],
    enabled: true,
    policy: { weight: 1, maxConcurrency: 2 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("能力推断 inferRoutes（复用 auth/capabilities.ts）", () => {
  it("apiKey 对推 coding-plan", () => {
    expect(inferRoutes(ZAI_PAIR)).toEqual(["coding-plan"]);
  });

  it("JWT-only 推 start-plan（start-plan 只认 JWT）", () => {
    expect(inferRoutes(ZAI_JWT_ONLY)).toEqual(["start-plan"]);
  });

  it("两者都有时给 coding-plan + start-plan（路由表顺序）", () => {
    expect(inferRoutes(ZAI_FULL)).toEqual(["coding-plan", "start-plan"]);
  });

  it("派生路由不默认开（各需额外准入：票券 / 持卡）", () => {
    expect(inferRoutes(ZAI_FULL)).not.toContain("off-peak");
    expect(inferRoutes(ZAI_FULL)).not.toContain("highspeed");
  });

  it("zai 缺 secret 不推 coding-plan（规则 5 前置），只剩 start-plan", () => {
    const noSecret: Credential = { kind: "zhipu-account", provider: "zai", apiKey: "k", identity: { targetType: "PERSONAL", deviceMid: "test-device-mid" }, jwt: "j" };
    expect(inferRoutes(noSecret)).toEqual(["start-plan"]);
  });

  it("bigmodel 单 key 也推 coding-plan（secret 可缺省）", () => {
    const bigmodel: Credential = {
      kind: "zhipu-account",
      provider: "bigmodel",
      apiKey: "bm-key",
      identity: { targetType: "PERSONAL", deviceMid: "test-device-mid" },
    };
    expect(inferRoutes(bigmodel)).toEqual(["coding-plan"]);
  });

  it("什么都认证不了 → unusable-credential", () => {
    const empty: Credential = { kind: "zhipu-account", provider: "zai", apiKey: "", identity: { targetType: "PERSONAL", deviceMid: "test-device-mid" } };
    expectAccountError(() => inferRoutes(empty), "unusable-credential");
  });

  it("已过期的凭据不再推断可用路由", () => {
    const expired: Credential = { ...ZAI_PAIR, expiresAt: Date.now() - 1000 };
    expectAccountError(() => inferRoutes(expired), "unusable-credential");
  });
});

describe("白名单归一 normalizeRoutes", () => {
  it("去重并按 ROUTE_KINDS 稳定顺序排列", () => {
    const messy: RouteKind[] = ["highspeed", "coding-plan", "highspeed", "start-plan"];
    expect(normalizeRoutes(messy)).toEqual(["coding-plan", "start-plan", "highspeed"]);
  });

  it("保留空数组（空白的判定交给 validateAccount，避免两处抛错）", () => {
    expect(normalizeRoutes([])).toEqual([]);
  });

  it("未知路由报错，不静默丢弃", () => {
    expectAccountError(() => normalizeRoutes(["coding-plan", "glm-5.3" as RouteKind]), "unknown-route");
  });
});

describe("规则 2：zhipu-account 的路由 ⊆ 四条套餐路由", () => {
  it("反例：不存在的路由被拒", () => {
    expectAccountError(
      () => validateAccount(accountOf({ credential: ZAI_FULL, routes: ["nope" as RouteKind] })),
      "unknown-route",
    );
  });

  it("正例：zhipu-account 挂四条套餐路由全通过", () => {
    expect(() =>
      validateAccount(
        accountOf({ credential: ZAI_FULL, routes: ["coding-plan", "start-plan", "off-peak", "highspeed"] }),
      ),
    ).not.toThrow();
  });
});

describe("规则 3：off-peak / highspeed 必须与 coding-plan 共存", () => {
  it("反例：off-peak 单独存在被拒", () => {
    expectAccountError(
      () => validateAccount(accountOf({ credential: ZAI_FULL, routes: ["off-peak"] })),
      "missing-derivation",
    );
  });

  it("反例：highspeed 单独存在被拒", () => {
    expectAccountError(
      () => validateAccount(accountOf({ credential: ZAI_FULL, routes: ["highspeed"] })),
      "missing-derivation",
    );
  });

  it("正例：coding-plan + off-peak + highspeed 通过", () => {
    expect(() =>
      validateAccount(accountOf({ credential: ZAI_FULL, routes: ["coding-plan", "off-peak", "highspeed"] })),
    ).not.toThrow();
  });
});

describe("规则 4：start-plan 需要 plan JWT", () => {
  it("反例：没有 JWT 的凭据挂 start-plan 被拒", () => {
    expectAccountError(
      () => validateAccount(accountOf({ credential: ZAI_PAIR, routes: ["start-plan"] })),
      "missing-jwt",
    );
  });

  it("正例：带 JWT 通过", () => {
    expect(() => validateAccount(accountOf({ credential: ZAI_FULL, routes: ["start-plan"] }))).not.toThrow();
  });
});

describe("规则 5：coding-plan 需要 apiKey 且 secret（zai）", () => {
  it("反例：zai 缺 secret 被拒（上游会 401）", () => {
    const noSecret: Credential = { kind: "zhipu-account", provider: "zai", apiKey: "k", identity: { targetType: "PERSONAL", deviceMid: "test-device-mid" } };
    expectAccountError(
      () => validateAccount(accountOf({ credential: noSecret, routes: ["coding-plan"] })),
      "missing-api-key-pair",
    );
  });

  it("反例：apiKey 为空被拒", () => {
    expectAccountError(
      () => validateAccount(accountOf({ credential: ZAI_JWT_ONLY, routes: ["coding-plan"] })),
      "missing-api-key-pair",
    );
  });

  it("正例：bigmodel 单 key（无 secret）通过", () => {
    const bigmodel: Credential = {
      kind: "zhipu-account",
      provider: "bigmodel",
      apiKey: "bm-key",
      identity: { targetType: "PERSONAL", deviceMid: "test-device-mid" },
    };
    expect(() => validateAccount(accountOf({ credential: bigmodel, routes: ["coding-plan"] }))).not.toThrow();
  });
});

describe("规则 6：TEAM 身份三个 id 必须齐全", () => {
  const teamBase: Credential = {
    kind: "zhipu-account",
    provider: "zai",
    apiKey: "k",
    secret: "s",
    identity: { targetType: "TEAM", organizationId: "org-1", projectId: "proj-1" , deviceMid: "test-device-mid" },
  };

  it("反例：缺 productId 被拒", () => {
    expectAccountError(
      () => validateAccount(accountOf({ credential: teamBase, routes: ["coding-plan"] })),
      "incomplete-team-identity",
    );
  });

  it("反例：三个都缺时报全部缺失项", () => {
    const bare: Credential = { ...teamBase, identity: { targetType: "TEAM" , deviceMid: "test-device-mid" } };
    let message = "";
    try {
      validateAccount(accountOf({ credential: bare, routes: ["coding-plan"] }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("organizationId");
    expect(message).toContain("projectId");
    expect(message).toContain("productId");
  });

  it("正例：三个 id 齐全通过", () => {
    const complete: Credential = {
      ...teamBase,
      identity: { targetType: "TEAM", organizationId: "org-1", projectId: "proj-1", productId: "prod-1" , deviceMid: "test-device-mid" },
    };
    expect(() => validateAccount(accountOf({ credential: complete, routes: ["coding-plan"] }))).not.toThrow();
  });

  it("PERSONAL 不要求任何 id", () => {
    expect(() => validateAccount(accountOf({ credential: ZAI_PAIR, routes: ["coding-plan"] }))).not.toThrow();
  });
});

describe("结构完整性校验", () => {
  it("空白名单被拒（无从出线）", () => {
    expectAccountError(() => validateAccount(accountOf({ routes: [] })), "empty-routes");
  });

  it("空 label 被拒", () => {
    expectAccountError(() => validateAccount(accountOf({ label: "   " })), "empty-label");
  });

  it("weight < 1 / maxConcurrency < 0 / rpmLimit < 1 被拒", () => {
    expectAccountError(
      () => validateAccount(accountOf({ policy: { weight: 0, maxConcurrency: 2 } })),
      "invalid-policy",
    );
    expectAccountError(
      () => validateAccount(accountOf({ policy: { weight: 1, maxConcurrency: -1 } })),
      "invalid-policy",
    );
    expectAccountError(
      () => validateAccount(accountOf({ policy: { weight: 1, maxConcurrency: 2, rpmLimit: 0 } })),
      "invalid-policy",
    );
  });

  it("maxConcurrency: 0 合法（软禁用）", () => {
    expect(() =>
      validateAccount(accountOf({ policy: { weight: 1, maxConcurrency: 0 } })),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("AccountManager 增删改查", () => {
  let store: MemoryStore;
  let manager: AccountManager;

  beforeEach(() => {
    store = new MemoryStore();
    manager = new AccountManager(store);
  });

  it("add 推断路由、补默认策略并落盘", async () => {
    const account = await manager.add({ label: "work", credential: ZAI_FULL });
    expect(account.routes).toEqual(["coding-plan", "start-plan"]);
    expect(account.enabled).toBe(true);
    expect(account.policy).toEqual({ weight: 1, maxConcurrency: 2 });
    expect(account.id).toHaveLength(64); // sha256 hex
    expect(store.writes).toBe(1);
    expect(store.snapshot().accounts).toHaveLength(1);
  });

  it("落盘的账号表只有 version 与 accounts（没有默认账号字段）", async () => {
    const first = await manager.add({ label: "work", credential: ZAI_FULL });
    expect(Object.keys(store.snapshot()).sort()).toEqual(["accounts", "version"]);
    expect(store.snapshot().accounts[0]!.id).toBe(first.id);
  });

  it("list / get / getByLabel 返回副本（改它不影响存储）", async () => {
    const added = await manager.add({ label: "work", credential: ZAI_FULL });
    const listed = await manager.list();
    expect(listed).toHaveLength(1);
    listed[0]!.label = "mutated";
    expect((await manager.get(added.id))?.label).toBe("work");
    expect((await manager.getByLabel("work"))?.id).toBe(added.id);
    expect(await manager.getByLabel("nope")).toBeNull();
    expect(await manager.get("nope")).toBeNull();
  });

  it("重导入同一凭据幂等：不新增账号、保留 label/enabled/policy", async () => {
    const added = await manager.add({ label: "work", credential: ZAI_PAIR });
    await manager.update(added.id, { enabled: false, policy: { maxConcurrency: 5 } });

    const reimported = await manager.add({ label: "ignored", credential: ZAI_PAIR });

    expect(reimported.id).toBe(added.id);
    expect(reimported.label).toBe("work"); // 用户改过的 label 不被重导入覆盖
    expect(reimported.enabled).toBe(false);
    expect(reimported.policy.maxConcurrency).toBe(5);
    expect(store.snapshot().accounts).toHaveLength(1);
  });

  it("重导入刷新凭据（JWT 会轮换）", async () => {
    const added = await manager.add({ label: "work", credential: ZAI_JWT_ONLY });
    const refreshed: Credential = { ...ZAI_JWT_ONLY, jwt: "plan.jwt.token.v2" };
    const reimported = await manager.add({ label: "work", credential: refreshed });
    expect(reimported.id).toBe(added.id);
    const credential = reimported.credential;
    if (credential.kind !== "zhipu-account") throw new Error("expected a zhipu-account credential");
    expect(credential.jwt).toBe("plan.jwt.token.v2");
  });

  it("label 重复被拒", async () => {
    await manager.add({ label: "work", credential: ZAI_FULL });
    await expectAccountErrorAsync(() => manager.add({ label: "work", credential: ZAI_SECOND }), "duplicate-label");
  });

  it("add 会 trim label", async () => {
    const added = await manager.add({ label: "  work  ", credential: ZAI_FULL });
    expect(added.label).toBe("work");
  });

  it("update 局部更新 label / routes / enabled", async () => {
    const added = await manager.add({ label: "work", credential: ZAI_FULL });
    const updated = await manager.update(added.id, { label: "home", routes: ["start-plan"] });
    expect(updated.label).toBe("home");
    expect(updated.routes).toEqual(["start-plan"]);
    expect(updated.id).toBe(added.id); // 凭据没变 → id 不变
    expect((await manager.getByLabel("home"))?.id).toBe(added.id);
  });

  it("update 换凭据 → id 跟着指纹变", async () => {
    const added = await manager.add({ label: "work", credential: ZAI_FULL });
    // 换一个真正的不同账号（apiKey 不同），指纹才会变。
    const otherAccount: Credential = { ...ZAI_FULL, apiKey: "apiKeyId0002", secret: "secret0002" };
    const updated = await manager.update(added.id, { credential: otherAccount });
    expect(updated.id).not.toBe(added.id);
    expect(await manager.get(added.id)).toBeNull();
    expect((await manager.get(updated.id))?.label).toBe("work");
  });

  it("只换 JWT 不改 id（指纹刻意排除会轮换的 token，否则重导会变成新账号）", async () => {
    const added = await manager.add({ label: "work", credential: ZAI_PAIR });
    const rotated: Credential = { ...ZAI_PAIR, jwt: "fresh.plan.jwt" };
    const updated = await manager.update(added.id, { credential: rotated });
    expect(updated.id).toBe(added.id);
    expect(store.snapshot().accounts[0]!.id).toBe(added.id);
  });

  it("update 换凭据且没给 routes 时按新能力重新推断（旧白名单会非法）", async () => {
    const added = await manager.add({ label: "trial", credential: ZAI_JWT_ONLY });
    expect(added.routes).toEqual(["start-plan"]);
    const updated = await manager.update(added.id, { credential: ZAI_FULL });
    expect(updated.routes).toEqual(["coding-plan", "start-plan"]);
  });

  it("update 不存在的账号 → not-found", async () => {
    await expectAccountErrorAsync(() => manager.update("missing", { enabled: false }), "not-found");
  });

  it("update 违反六条规则时拒绝落盘（同路由拆除母体）", async () => {
    const added = await manager.add({ label: "work", credential: ZAI_FULL, routes: ["coding-plan", "off-peak"] });
    await expectAccountErrorAsync(() => manager.update(added.id, { routes: ["off-peak"] }), "missing-derivation");
    // 落盘内容保持原样
    expect(store.snapshot().accounts[0]!.routes).toEqual(["coding-plan", "off-peak"]);
  });

  it("remove 删掉账号，重复删返回 false", async () => {
    const added = await manager.add({ label: "work", credential: ZAI_FULL });
    expect(await manager.remove(added.id)).toBe(true);
    expect(await manager.list()).toHaveLength(0);
    expect(store.snapshot().accounts).toHaveLength(0);
    expect(await manager.remove(added.id)).toBe(false);
  });

  it("写失败时内存缓存不分叉（避免重启后丢配置）", async () => {
    const failing = new AccountManager(new FailingStore());
    await expect(failing.add({ label: "work", credential: ZAI_FULL })).rejects.toThrow("disk full");
    expect(await failing.list()).toHaveLength(0);
  });

  it("跨实例读取：新 manager 能从同一存储读回账号", async () => {
    const added = await manager.add({ label: "work", credential: ZAI_FULL });
    const reopened = new AccountManager(store);
    const listed = await reopened.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(added.id);
  });
});

describe("add 的入参校验", () => {
  it("显式白名单也要过六条规则（可收窄，不可非法）", async () => {
    const manager = new AccountManager(new MemoryStore());
    const narrowed: NewAccount = { label: "work", credential: ZAI_FULL, routes: ["coding-plan"] };
    expect((await manager.add(narrowed)).routes).toEqual(["coding-plan"]);

    const illegal: NewAccount = { label: "bad", credential: ZAI_FULL, routes: ["nope" as RouteKind] };
    await expectAccountErrorAsync(() => manager.add(illegal), "unknown-route");
  });

  it("显式空白名单被拒", async () => {
    const manager = new AccountManager(new MemoryStore());
    await expectAccountErrorAsync(
      () => manager.add({ label: "work", credential: ZAI_FULL, routes: [] }),
      "empty-routes",
    );
  });

  it("多路由顺序被归一（配置里写乱的顺序不影响行为）", async () => {
    const manager = new AccountManager(new MemoryStore());
    const added = await manager.add({
      label: "work",
      credential: ZAI_FULL,
      routes: ["start-plan", "coding-plan"],
    });
    expect(added.routes).toEqual(["coding-plan", "start-plan"]);
  });
});
