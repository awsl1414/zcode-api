/**
 * API key 管理：创建、吊销、校验、用量累加与攒批落盘。
 *
 * 每个用例用独立的内存 store（管理逻辑与文件格式是两件事），只有一个用例用
 * `ZCODE_PROXY_STORE_DIR` 验证真实文件往返：那一条把「内存里对、落盘后也对」钉住，
 * 其余用例不该为它付 IO 成本。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  USAGE_FLUSH_REQUEST_THRESHOLD,
  apiKeyIdOf,
  apiKeyPrefixOf,
  generateApiKey,
  hashApiKey,
  localDateString,
  summarizeApiKey,
  ApiKeyManager,
} from "./manager.js";
import { memoryApiKeysStore } from "./testing.js";
import { fileApiKeysStore } from "./store.js";
import { codecFromSeed } from "../storage/index.js";
import { API_KEYS_STORE_VERSION, API_KEY_PREFIX } from "./types.js";
import type { ApiKeysStore } from "./store.js";
import type { ApiKeyRecord } from "./types.js";
import type { RequestRecord } from "../proxy/request-record.js";

/**
 * 一条请求记录的最小形状（只填记账看得的四个字段）。
 *
 * 记账方只读 `apiKeyId` / `status` / 两个 token 数，其余字段用占位值：拿真记录反而
 * 会把「记账逻辑只依赖这四个」这件事遮住。
 */
function recordFor(apiKeyId: string, status: number, inputTokens: number, outputTokens: number): RequestRecord {
  return {
    reqId: "#000",
    startedAt: 0,
    format: "anthropic",
    model: "glm-4.6",
    stream: false,
    requestBytes: 0,
    retries: 0,
    status,
    inputTokens,
    outputTokens,
    stages: [],
    apiKeyId,
  };
}

/** 计数用的 store：用量攒批的断言要看「写了几次」。*/
function countingStore(): ApiKeysStore & { writes: number } {
  const inner = memoryApiKeysStore();
  const store = {
    writes: 0,
    load: () => inner.load(),
    save: async (file: Parameters<ApiKeysStore["save"]>[0]) => {
      store.writes += 1;
      await inner.save(file);
    },
  };
  return store;
}

/** 建一把 key 并返回它的明文（测试里到处要用）。*/
async function createKey(manager: ApiKeyManager, name = "claude-code-laptop"): Promise<string> {
  const created = await manager.create(name);
  if (!created.ok || !created.key) throw new Error(`create failed: ${created.ok ? "no key" : created.error}`);
  return created.key;
}

const ENV_STORE_DIR = "ZCODE_PROXY_STORE_DIR";

describe("key material", () => {
  it("generates sk-zcp- + 32 random bytes as base64url", async () => {
    const key = generateApiKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    // 32 字节 base64url = 43 个字符（无填充）。
    expect(key.slice(API_KEY_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateApiKey()).not.toBe(key);
  });

  it("derives the id from the hash prefix and the display prefix from the key", async () => {
    const key = generateApiKey();
    const hash = hashApiKey(key);
    expect(hash).toHaveLength(64);
    expect(apiKeyIdOf(hash)).toBe(hash.slice(0, 16));
    expect(apiKeyPrefixOf(key)).toBe(`${API_KEY_PREFIX}${key.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + 4)}`);
  });

  it("formats today as a local YYYY-MM-DD (not UTC)", async () => {
    // 本地 2026-11-07 23:30：UTC 可能已经是 11-08，但「今日」按本地算。
    const at = new Date(2026, 10, 7, 23, 30, 0).getTime();
    expect(localDateString(at)).toBe("2026-11-07");
  });
});

describe("ApiKeyManager.create", () => {
  it("returns the full key once and stores its hash plus an encrypted copy", async () => {
    const store = memoryApiKeysStore();
    const manager = new ApiKeyManager(store);
    const created = await manager.create("claude-code-laptop");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.key!.startsWith(API_KEY_PREFIX)).toBe(true);
    // 摘要里没有任何 hash 字段（对外只有 id / 名字 / 前缀 / 用量）。
    expect(created.record).not.toHaveProperty("hash");
    expect(created.record.name).toBe("claude-code-laptop");
    expect(created.record.enabled).toBe(true);

    const stored = store.snapshot().keys[0]!;
    expect(stored.hash).toBe(hashApiKey(created.key!));
    expect(stored.prefix).toBe(apiKeyPrefixOf(created.key!));
    // 密文与 hash 双份并存；密文不是明文，也不含明文的形状。
    expect(stored.secret.length).toBeGreaterThan(0);
    expect(stored.secret).not.toBe(created.key!);
    expect(stored.secret).not.toContain(created.key!);
  });

  it("lists the decrypted secret for the panel but never the hash", async () => {
    const manager = new ApiKeyManager(memoryApiKeysStore(), Date.now, codecFromSeed("w102-list"));
    const key = await createKey(manager);

    const listed = await manager.list();
    expect(listed).toHaveLength(1);
    // 面板要能展示 / 复制：list 带回解密后的完整明文。
    expect(listed[0]!.secret).toBe(key);
    // hash 是密码学材料，仍然不离开服务端；前缀照旧用于认人。
    expect(JSON.stringify(listed)).not.toContain("hash");
    expect(listed[0]!.prefix).toBe(apiKeyPrefixOf(key));
  });

  it("drops a stored record without secret (5.0 contract: corrupt, not legacy)", async () => {
    const store = memoryApiKeysStore();
    const manager = new ApiKeyManager(store, Date.now, codecFromSeed("w102-legacy"));
    await createKey(manager);

    // 手工破坏记录（删 secret）：5.0 契约下这是损坏数据，不是「旧版本 key」。
    const file = store.snapshot();
    delete (file.keys[0] as Partial<ApiKeyRecord>).secret;
    await store.save(file);
    manager.reload();

    const listed = await manager.list();
    expect(listed).toHaveLength(0);
  });

  it("drops the record when the ciphertext no longer decrypts (seed changed)", async () => {
    const store = memoryApiKeysStore();
    const first = new ApiKeyManager(store, Date.now, codecFromSeed("seed-a"));
    await createKey(first);

    // 同一份文件换一把密钥读：解不开 = 存储密钥不匹配，记录损坏 → 丢弃并告警。
    const second = new ApiKeyManager(store, Date.now, codecFromSeed("seed-b"));
    const listed = await second.list();
    expect(listed).toHaveLength(0);
  });

  it("rejects an empty name, an over-long name and a duplicate name", async () => {
    const manager = new ApiKeyManager(memoryApiKeysStore());
    expect((await manager.create("   "))).toEqual({ ok: false, error: "empty_api_key_name" });
    expect((await manager.create("x".repeat(65)))).toEqual({ ok: false, error: "invalid_api_key_name" });

    await createKey(manager, "ci-server");
    expect((await manager.create("ci-server"))).toEqual({ ok: false, error: "duplicate_api_key_name" });
  });
});

describe("ApiKeyManager.authenticate", () => {
  it("accepts the right key and rejects a wrong one", async () => {
    const manager = new ApiKeyManager(memoryApiKeysStore());
    const key = await createKey(manager);

    expect(((await manager.authenticate(key))?.prefix)).toBe(apiKeyPrefixOf(key));
    expect((await manager.authenticate("sk-zcp-" + "A".repeat(43)))).toBeNull();
    expect((await manager.authenticate(""))).toBeNull();
    expect((await manager.authenticate("   "))).toBeNull();
  });

  it("rejects a disabled key even though the record still exists", async () => {
    const manager = new ApiKeyManager(memoryApiKeysStore());
    const key = await createKey(manager);
    const id = (await manager.list())[0]!.id;

    expect(((await manager.setEnabled(id, false))).ok).toBe(true);
    expect((await manager.authenticate(key))).toBeNull();
    // 记录还在：禁用是「立刻 401」，不是删除（名字与用量都保留）。
    expect((await manager.list())[0]!.enabled).toBe(false);

    expect(((await manager.setEnabled(id, true))).ok).toBe(true);
    expect((await manager.authenticate(key))).not.toBeNull();
  });

  it("does not accept a key whose record was deleted", async () => {
    const manager = new ApiKeyManager(memoryApiKeysStore());
    const key = await createKey(manager);
    const id = (await manager.list())[0]!.id;
    expect((await manager.remove(id))).toEqual({ ok: true, id });
    expect((await manager.authenticate(key))).toBeNull();
    expect(await manager.list()).toHaveLength(0);
  });

  it("reports unknown ids instead of silently doing nothing", async () => {
    const manager = new ApiKeyManager(memoryApiKeysStore());
    await createKey(manager);
    expect((await manager.setEnabled("nope", false))).toEqual({ ok: false, error: "api_key_not_found" });
    expect((await manager.remove("nope"))).toEqual({ ok: false, error: "api_key_not_found" });
    expect((await manager.resetUsage("nope"))).toEqual({ ok: false, error: "api_key_not_found" });
  });
});

describe("usage accumulation", () => {
  it("counts requests, tokens and errors, and remembers the last use", async () => {
    let now = 1_700_000_000_000;
    const manager = new ApiKeyManager(memoryApiKeysStore(), () => now);
    const key = await createKey(manager);
    const id = (await manager.authenticate(key))!.id;

    await manager.onRequestEnd(recordFor(id, 200, 120, 30));
    now += 1000;
    await manager.onRequestEnd(recordFor(id, 500, 10, 0));

    const usage = (await manager.list())[0]!.usage;
    expect(usage.requests).toBe(2);
    expect(usage.todayRequests).toBe(2);
    expect(usage.inputTokens).toBe(130);
    expect(usage.outputTokens).toBe(30);
    // 错误按状态码算：>= 400 记一次。
    expect(usage.errors).toBe(1);
    expect(usage.lastUsedAt).toBe(now);
  });

  it("ignores requests with no key and unknown keys", async () => {
    const manager = new ApiKeyManager(memoryApiKeysStore());
    await createKey(manager);
    await manager.onRequestEnd(recordFor("", 200, 1, 1));
    await manager.onRequestEnd(recordFor("deleted-a-moment-ago", 200, 1, 1));
    expect((await manager.list())[0]!.usage.requests).toBe(0);
  });

  it("rolls todayRequests back to zero across a day boundary and keeps the totals", async () => {
    let now = new Date(2026, 10, 7, 23, 0, 0).getTime();
    const manager = new ApiKeyManager(memoryApiKeysStore(), () => now);
    const key = await createKey(manager);
    const id = (await manager.authenticate(key))!.id;

    await manager.onRequestEnd(recordFor(id, 200, 5, 5));
    expect((await manager.list())[0]!.usage.todayRequests).toBe(1);
    expect((await manager.list())[0]!.usage.todayDate).toBe("2026-11-07");

    // 跨天：下一次读列表时今日归零，累计不变。
    now = new Date(2026, 10, 8, 0, 5, 0).getTime();
    const nextDay = (await manager.list())[0]!.usage;
    expect(nextDay.todayRequests).toBe(0);
    expect(nextDay.requests).toBe(1);
    expect(nextDay.todayDate).toBe("2026-11-08");

    // 新的一天再记一次：今日从 1 开始，累计到 2。
    await manager.onRequestEnd(recordFor(id, 200, 0, 0));
    expect((await manager.list())[0]!.usage.todayRequests).toBe(1);
    expect((await manager.list())[0]!.usage.requests).toBe(2);
  });

  it("resets usage without touching the key itself", async () => {
    const manager = new ApiKeyManager(memoryApiKeysStore());
    const key = await createKey(manager);
    const id = (await manager.authenticate(key))!.id;
    await manager.onRequestEnd(recordFor(id, 200, 10, 10));

    const reset = await manager.resetUsage(id);
    expect(reset.ok).toBe(true);
    const usage = (await manager.list())[0]!.usage;
    expect(usage.requests).toBe(0);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.lastUsedAt).toBeNull();
    // key 仍然能用（归零只清计数）
    expect((await manager.authenticate(key))).not.toBeNull();
  });
});

describe("usage flush strategy", () => {
  it("does not touch the file on every request", async () => {
    const store = countingStore();
    const manager = new ApiKeyManager(store);
    const key = await createKey(manager);
    const id = (await manager.authenticate(key))!.id;
    const writesAfterCreate = store.writes;

    // 阈值以内只改内存：一次写盘都没有。
    for (let i = 0; i < USAGE_FLUSH_REQUEST_THRESHOLD - 1; i += 1) {
      await manager.onRequestEnd(recordFor(id, 200, 1, 1));
    }
    expect(store.writes).toBe(writesAfterCreate);

    // 攒满阈值立刻落盘一次。
    await manager.onRequestEnd(recordFor(id, 200, 1, 1));
    expect(store.writes).toBe(writesAfterCreate + 1);
  });

  it("flushes explicitly (the process-exit path) and is a no-op when nothing is pending", async () => {
    const store = countingStore();
    const manager = new ApiKeyManager(store);
    const key = await createKey(manager);
    const id = (await manager.authenticate(key))!.id;
    const writesAfterCreate = store.writes;

    await manager.onRequestEnd(recordFor(id, 200, 1, 1));
    await manager.flush();
    expect(store.writes).toBe(writesAfterCreate + 1);

    // 没有新的用量时再 flush 不写盘（退出路径不该多一次无意义的磁盘往返）。
    await manager.flush();
    expect(store.writes).toBe(writesAfterCreate + 1);
  });

  it("structural changes (create / enable / delete / reset) persist immediately", async () => {
    const store = countingStore();
    const manager = new ApiKeyManager(store);
    const key = await createKey(manager);
    const id = (await manager.authenticate(key))!.id;
    const afterCreate = store.writes;

    expect(((await manager.setEnabled(id, false))).ok).toBe(true);
    expect(store.writes).toBe(afterCreate + 1);

    expect(((await manager.resetUsage(id))).ok).toBe(true);
    expect(store.writes).toBe(afterCreate + 2);

    expect(((await manager.remove(id))).ok).toBe(true);
    expect(store.writes).toBe(afterCreate + 3);
  });
});

describe("round-trip through the encrypted file", () => {
  let storeDir = "";
  const previous = process.env[ENV_STORE_DIR];
  const previousSecret = process.env.ZCODE_PROXY_CREDENTIAL_SECRET;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "zcode-apikeys-manager-"));
    process.env[ENV_STORE_DIR] = storeDir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env[ENV_STORE_DIR];
    else process.env[ENV_STORE_DIR] = previous;
    if (previousSecret === undefined) delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
    else process.env.ZCODE_PROXY_CREDENTIAL_SECRET = previousSecret;
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("survives a restart: a fresh manager verifies the same key and sees its usage", async () => {
    const first = new ApiKeyManager();
    const key = await createKey(first, "ci-server");
    const id = (await first.authenticate(key))!.id;
    await first.onRequestEnd(recordFor(id, 200, 100, 40));
    await first.flush();

    // 「重启」= 新实例重新从文件读
    const second = new ApiKeyManager();
    expect((await second.authenticate(key))?.name).toBe("ci-server");
    const usage = (await second.list())[0]!.usage;
    expect(usage.requests).toBe(1);
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(40);
    // 文件里是加密的：hash 与密文都不以明文出现
    expect((await fileApiKeysStore.load()).keys[0]!.hash).toBe(hashApiKey(key));
    // 密文跟着文件走，「重启」后新实例解得回明文（面板复制就靠这条链）。
    expect((await fileApiKeysStore.load()).keys[0]!.secret).not.toContain(key);
    expect((await second.list())[0]!.secret).toBe(key);
  });

  it("summarize keeps the usage snapshot independent of the stored record", async () => {
    const manager = new ApiKeyManager(memoryApiKeysStore());
    const created = await manager.create("laptop");
    if (!created.ok) return;
    const copy = summarizeApiKey({
      id: "x",
      name: "laptop",
      hash: "ab",
      secret: "",
      prefix: "sk-zcp-abcd",
      enabled: true,
      createdAt: 1,
      usage: { requests: 0, inputTokens: 0, outputTokens: 0, errors: 0, lastUsedAt: null, todayRequests: 0, todayDate: "" },
    });
    copy.usage.requests = 99;
    expect(created.record.usage.requests).toBe(0);
  });

  it("starts empty when the file was written by another machine's seed", async () => {
    await fileApiKeysStore.save({ version: API_KEYS_STORE_VERSION, keys: [] });
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "another-machine";
    const manager = new ApiKeyManager();
    expect(await manager.isEmpty()).toBe(true);
  });
});
