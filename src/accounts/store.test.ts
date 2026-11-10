/**
 * v2 账号存储的用例：加密、原子写、损坏容错。
 *
 * 5.0 不迁移 v1 凭据（不做兼容，启动即空账号），相关用例已随实现一起删除。
 *
 * 每个用例都跑在独立的临时目录里（`ZCODE_PROXY_STORE_DIR`）。**绝不能**碰真实的
 * `~/.zcode-proxy`：auth/store 那边记过一次事故 —— 模块级路径常量让测试写到真实
 * 用户目录，在已登录机器上跑测试把用户凭据删了（2026-09-18）。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { fileAccountsStore, getAccountsPath, getStoreDir } from "./store.js";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNTS_STORE_VERSION, emptyAccountsFile } from "./types.js";
import type { Account } from "./types.js";

const TEST_SECRET = "store-test-secret";

let storeDir: string;

function useTempStore(): void {
  storeDir = mkdtempSync(join(tmpdir(), "zcode-accounts-test-"));
  process.env.ZCODE_PROXY_STORE_DIR = storeDir;
  process.env.ZCODE_PROXY_CREDENTIAL_SECRET = TEST_SECRET;
}

function dropTempStore(): void {
  delete process.env.ZCODE_PROXY_STORE_DIR;
  delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  rmSync(storeDir, { recursive: true, force: true });
}

function sampleAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "a".repeat(64),
    label: "work",
    credential: {
      kind: "zhipu-account",
      provider: "zai",
      apiKey: "apiKeyId-SUPER-SECRET-VALUE",
      secret: "secret-SUPER-SECRET-VALUE",
      jwt: "jwt.token.value",
      identity: { targetType: "PERSONAL", deviceMid: "device-1" },
    },
    routes: ["coding-plan"],
    enabled: true,
    policy: { weight: 1, maxConcurrency: 2 },
    ...overrides,
  };
}

beforeEach(useTempStore);
afterEach(dropTempStore);

/** 解密 {@link encryptWithCurrentKey} 的输出（同一把密钥，AES-GCM）。*/
async function decryptWithCurrentKey(payload: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const seed = process.env.ZCODE_PROXY_CREDENTIAL_SECRET ?? "";
  const keyBytes = new Uint8Array(createHash("sha256").update(seed, "utf-8").digest());
  const ab = new ArrayBuffer(keyBytes.byteLength);
  new Uint8Array(ab).set(keyBytes);
  const key = await crypto.subtle.importKey("raw", ab, { name: "AES-GCM" }, false, ["decrypt"]);
  const combined = Buffer.from(payload, "base64");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: combined.subarray(0, 12) },
    key,
    combined.subarray(12),
  );
  return new TextDecoder().decode(plaintext);
}

// ---------------------------------------------------------------------------

describe("路径与环境变量", () => {
  it("ZCODE_PROXY_STORE_DIR 覆盖存储目录（按调用求值）", () => {
    expect(getStoreDir()).toBe(storeDir);
    expect(getAccountsPath()).toBe(join(storeDir, "accounts.json"));
  });

  it("环境变量在模块加载后设置依然生效", () => {
    const other = mkdtempSync(join(tmpdir(), "zcode-accounts-alt-"));
    process.env.ZCODE_PROXY_STORE_DIR = other;
    try {
      expect(getAccountsPath()).toBe(join(other, "accounts.json"));
    } finally {
      process.env.ZCODE_PROXY_STORE_DIR = storeDir;
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("读写往返", () => {
  it("文件不存在 → 空仓", async () => {
    const file = await fileAccountsStore.load();
    expect(file).toEqual(emptyAccountsFile());
  });

  it("save → load 保真（含 policy / enabled / 多路由）", async () => {
    const account = sampleAccount({ routes: ["coding-plan", "start-plan"], enabled: false });
    await fileAccountsStore.save({ version: ACCOUNTS_STORE_VERSION, accounts: [account] });

    const loaded = await fileAccountsStore.load();
    expect(loaded.version).toBe(2);
    expect(loaded.accounts).toHaveLength(1);
    expect(loaded.accounts[0]).toEqual(account);
  });

  it("多个账号按写入顺序读回", async () => {
    const a = sampleAccount({ id: "a".repeat(64), label: "a" });
    const b = sampleAccount({ id: "b".repeat(64), label: "b" });
    await fileAccountsStore.save({ version: ACCOUNTS_STORE_VERSION, accounts: [a, b] });
    const loaded = await fileAccountsStore.load();
    expect(loaded.accounts.map((account) => account.label)).toEqual(["a", "b"]);
  });

  it("4.x 文件里的 activeId 被忽略，其余照常读回（不做迁移）", async () => {
    const account = sampleAccount();
    const legacy = JSON.stringify({
      version: ACCOUNTS_STORE_VERSION,
      activeId: account.id,
      accounts: [account],
    });
    writeFileSync(getAccountsPath(), JSON.stringify({ version: 2, encrypted: await encryptWithCurrentKey(legacy) }), "utf-8");

    const loaded = await fileAccountsStore.load();
    expect(loaded.accounts.map((account) => account.label)).toEqual([account.label]);
    expect(Object.keys(loaded).sort()).toEqual(["accounts", "version"]);
  });

  it("写回时不再产生 activeId 字段（密文里也没有）", async () => {
    await fileAccountsStore.save({ version: ACCOUNTS_STORE_VERSION, accounts: [sampleAccount()] });
    const wrapper = JSON.parse(readFileSync(getAccountsPath(), "utf-8")) as { encrypted: string };
    const plain = await decryptWithCurrentKey(wrapper.encrypted);
    expect(plain).not.toContain("activeId");
  });

});

describe("加密与原子写", () => {
  it("落盘是密文：明文凭据不出现在文件里", async () => {
    await fileAccountsStore.save({
      version: ACCOUNTS_STORE_VERSION,
      accounts: [sampleAccount()],
    });
    const raw = readFileSync(getAccountsPath(), "utf-8");

    expect(raw).not.toContain("SUPER-SECRET-VALUE");
    expect(raw).not.toContain("work"); // label 也在密文里
    const wrapper = JSON.parse(raw) as { version: number; encrypted: string };
    expect(wrapper.version).toBe(ACCOUNTS_STORE_VERSION);
    expect(typeof wrapper.encrypted).toBe("string");
    expect(wrapper.encrypted.length).toBeGreaterThan(0);
  });

  it("文件权限 0o600", async () => {
    await fileAccountsStore.save({ version: ACCOUNTS_STORE_VERSION, accounts: [sampleAccount()] });
    const mode = statSync(getAccountsPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("原子写不留临时文件", async () => {
    await fileAccountsStore.save({ version: ACCOUNTS_STORE_VERSION, accounts: [sampleAccount()] });
    const leftovers = readdirSync(storeDir).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("重复保存覆盖而不是追加", async () => {
    await fileAccountsStore.save({ version: ACCOUNTS_STORE_VERSION, accounts: [sampleAccount({ label: "one" })] });
    await fileAccountsStore.save({ version: ACCOUNTS_STORE_VERSION, accounts: [sampleAccount({ label: "two" })] });
    const loaded = await fileAccountsStore.load();
    expect(loaded.accounts.map((account) => account.label)).toEqual(["two"]);
  });

  it("目录不存在时自动创建", async () => {
    const nested = join(storeDir, "deep", "nested");
    process.env.ZCODE_PROXY_STORE_DIR = nested;
    try {
      await fileAccountsStore.save({ version: ACCOUNTS_STORE_VERSION, accounts: [sampleAccount()] });
      expect(existsSync(join(nested, "accounts.json"))).toBe(true);
    } finally {
      process.env.ZCODE_PROXY_STORE_DIR = storeDir;
    }
  });
});

/**
 * 旧实现写出的文件必须照常读得开。
 *
 * 密文是硬编码的常量，由上一版实现（`accounts/store.ts` 的 WebCrypto 版本）
 * 用 seed `w17-fixture-seed` 生成。这条用例存在的理由只有一个：加密与 KDF 抽到
 * `src/storage/` 之后，用户已有的 `accounts.json` 不能变成「未登录」。
 */
describe("旧实现生成的文件仍能解密", () => {
  /** 旧版 accounts.json：`{"version":2,"accounts":[{label:"work",…}]}` 的密文。*/
  const OLD_ACCOUNTS_CIPHERTEXT =
    "acw0bHqVQIAU+v7qgEmrmdpTEPPaB6uMz3Cy41QJYJjzMaP3Np3wmNCfdZcvY41K0LmhTZZdhYExPmumfWNG4MGFwvT9UhboCpvV442lYUz5tuh0o1sLCu5IgXyqsCmJLbsYxc9LAxIcyuWCBCPWSyYBePWS+0zI4/p7r9mGnw4+FcQnBcU7StZe9y5Bqw+U0dWIuXNtbLDaXGU9KX/GBcUTYmU2EnrW3lKAsgNsLo7Dq5mT4qxg42NBBiMBrcRxPFWv2BSe1yR18OcJ2bRNuxbWjMPED5BnzSLcnYTeqnRRQlTx6hgv8Qc7K5ifxniJkJroDtJPahf+yQGnuxVWKxALFyUcjxE/SjlVucmidsqXTu7pXzkjd+1gS6wJOoYG0uAiyYfEkAPFjbLLuP0UyvER+dqNqszftEbQhI7G0pXA+Z9PdmHBKq43fW07fLETLQDL/2pvsG2j4JyECupODAZBbXe9EmdOc2rcq46bP9Tj0Sz7lQCVcIawED5xGV2GVIae2T/7tPFdjIZTXxrIVUXPXVPXJfJOOwxIKXqiOBrZjGwbHu/NwAeB3i++B/Xf2zga/Q==";

  it("读得开旧实现写出的密文（label / 凭据 / policy 都还在）", async () => {
    const saved = process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "w17-fixture-seed";
    try {
      writeFileSync(
        getAccountsPath(),
        JSON.stringify({ version: 2, encrypted: OLD_ACCOUNTS_CIPHERTEXT }),
        "utf-8",
      );

      const loaded = await fileAccountsStore.load();
      expect(loaded.accounts).toHaveLength(1);
      const account = loaded.accounts[0]!;
      expect(account.label).toBe("work");
      expect(account.enabled).toBe(true);
      expect(account.routes).toEqual(["coding-plan"]);
      expect(account.credential.apiKey).toBe("fixture-api-key-value");
      expect(account.credential.secret).toBe("fixture-secret-value");
      expect(account.policy).toEqual({ weight: 1, maxConcurrency: 2 });

      // 读回来之后再存一次，仍然是同一个账号（不是「只读兼容」）。
      await fileAccountsStore.save(loaded);
      expect((await fileAccountsStore.load()).accounts[0]!.label).toBe("work");
    } finally {
      if (saved === undefined) delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
      else process.env.ZCODE_PROXY_CREDENTIAL_SECRET = saved;
    }
  });
});

describe("损坏容错（一律降级为「未登录」，不抛异常）", () => {
  it("文件不是 JSON", async () => {
    writeFileSync(getAccountsPath(), "not json at all", "utf-8");
    expect(await fileAccountsStore.load()).toEqual(emptyAccountsFile());
    expect(existsSync(getAccountsPath())).toBe(true); // 不删坏文件，留给用户自己恢复
  });

  it("没有 encrypted 字段", async () => {
    writeFileSync(getAccountsPath(), JSON.stringify({ version: 2 }), "utf-8");
    expect(await fileAccountsStore.load()).toEqual(emptyAccountsFile());
  });

  it("密文被别的密钥加密（跨机器拷贝 / secret 变了）", async () => {
    const saved = process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "someone-elses-secret";
    await fileAccountsStore.save({ version: ACCOUNTS_STORE_VERSION, accounts: [sampleAccount()] });
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = saved;
    expect(await fileAccountsStore.load()).toEqual(emptyAccountsFile());
  });

  it("乱码密文", async () => {
    writeFileSync(getAccountsPath(), JSON.stringify({ encrypted: "bm90LXJlYWxseS1jaXBoZXJ0ZXh0" }), "utf-8");
    expect(await fileAccountsStore.load()).toEqual(emptyAccountsFile());
  });

  it("版本不认识（未来格式）→ 空仓而不是瞎解析", async () => {
    // 模拟一个未来版本写的文件：外层 version: 3，密文里也是 3。
    const future = JSON.stringify({ version: 3, accounts: [sampleAccount()] });
    const encrypted = await encryptWithCurrentKey(future);
    writeFileSync(getAccountsPath(), JSON.stringify({ version: 3, encrypted }), "utf-8");
    expect(await fileAccountsStore.load()).toEqual(emptyAccountsFile());
  });

  it("单条账号结构损坏 → 丢弃该条，其余可用", async () => {
    const good = sampleAccount({ label: "good" });
    const encrypted = await encryptWithCurrentKey(
      JSON.stringify({ version: 2, accounts: [good, { id: "broken" }] }),
    );
    writeFileSync(getAccountsPath(), JSON.stringify({ version: 2, encrypted }), "utf-8");
    const loaded = await fileAccountsStore.load();
    expect(loaded.accounts).toHaveLength(1);
    expect(loaded.accounts[0]!.label).toBe("good");
  });
});

/** 用当前密钥加密一段明文，用来构造任意"半合法"文件。*/
async function encryptWithCurrentKey(plaintext: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const seed = process.env.ZCODE_PROXY_CREDENTIAL_SECRET ?? "";
  const keyBytes = new Uint8Array(createHash("sha256").update(seed, "utf-8").digest());
  const ab = new ArrayBuffer(keyBytes.byteLength);
  new Uint8Array(ab).set(keyBytes);
  const key = await crypto.subtle.importKey("raw", ab, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return Buffer.from(combined).toString("base64");
}

// ---------------------------------------------------------------------------

