/**
 * 用户文件：加密落盘、损坏即空仓、原子写。
 *
 * 每个用例用独立的 `ZCODE_PROXY_STORE_DIR`：真实存储目录里可能有用户的 `users.json`，
 * 测试绝不能读写它（`accounts/store.test.ts` 记录过那次事故）。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileUsersStore, getUsersPath } from "./store.js";
import { UserManager, hashPassword, newSalt } from "./manager.js";

const ENV_STORE_DIR = "ZCODE_PROXY_STORE_DIR";

let storeDir = "";
const previous = process.env[ENV_STORE_DIR];

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "zcode-users-store-"));
  process.env[ENV_STORE_DIR] = storeDir;
});

afterEach(() => {
  if (previous === undefined) delete process.env[ENV_STORE_DIR];
  else process.env[ENV_STORE_DIR] = previous;
  rmSync(storeDir, { recursive: true, force: true });
});

/** 一份可直接写入的用户记录。*/
function record(username = "admin") {
  const salt = newSalt();
  return {
    username,
    passwordHash: hashPassword("hunter2hunter2", Buffer.from(salt, "base64")),
    salt,
    createdAt: 1_700_000_000_000,
  };
}

describe("users store", () => {
  it("lives next to accounts.json in the store directory", () => {
    expect(getUsersPath()).toBe(join(storeDir, "users.json"));
  });

  it("returns an empty store when the file does not exist", async () => {
    expect(await fileUsersStore.load()).toEqual({ version: 1, users: [] });
  });

  it("round-trips a user and writes it encrypted", async () => {
    const user = record();
    await fileUsersStore.save({ version: 1, users: [user] });

    expect(await fileUsersStore.load()).toEqual({ version: 1, users: [user] });

    // 落盘的是密文：明文密码哈希与用户名都不该出现在文件里。
    const raw = readFileSync(getUsersPath(), "utf-8");
    expect(raw).not.toContain(user.passwordHash);
    expect(raw).not.toContain(user.salt);
    expect(raw).not.toContain("admin");
    expect(JSON.parse(raw)).toMatchObject({ version: 1, encrypted: expect.any(String) });
  });

  it("keeps the file private (0o600)", async () => {
    await fileUsersStore.save({ version: 1, users: [record()] });
    expect(statSync(getUsersPath()).mode & 0o777).toBe(0o600);
  });

  it("treats an unreadable or undecryptable file as empty instead of throwing", async () => {
    writeFileSync(getUsersPath(), "{not json", "utf8");
    expect(await fileUsersStore.load()).toEqual({ version: 1, users: [] });

    writeFileSync(getUsersPath(), JSON.stringify({ version: 1, encrypted: "bm90LWEtY2lwaGVy" }), "utf8");
    expect(await fileUsersStore.load()).toEqual({ version: 1, users: [] });

    // 结构不对（没有密文载荷）同样是空仓。
    writeFileSync(getUsersPath(), JSON.stringify({ version: 1 }), "utf8");
    expect(await fileUsersStore.load()).toEqual({ version: 1, users: [] });
  });

  it("drops malformed entries but keeps the readable ones", async () => {
    const good = record("alice");
    await fileUsersStore.save({ version: 1, users: [good, { username: "broken" } as never] });
    expect(await fileUsersStore.load()).toEqual({ version: 1, users: [good] });
  });

  it("keeps the file readable across a save after a corrupt read", async () => {
    writeFileSync(getUsersPath(), "garbage", "utf8");
    const users = new UserManager();
    expect(await users.hasUsers()).toBe(false);

    await users.create("alice", "hunter2hunter2");
    expect(existsSync(getUsersPath())).toBe(true);
    expect(await users.verify("alice", "hunter2hunter2")).toBe(true);
  });

  it("lets the file-backed manager persist across instances (restart)", async () => {
    const first = new UserManager();
    await first.create("alice", "hunter2hunter2");

    const second = new UserManager();
    expect(await second.verify("alice", "hunter2hunter2")).toBe(true);
  });
});
