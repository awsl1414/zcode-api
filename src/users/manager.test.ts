/**
 * 用户管理：首次启动的管理员、建号、校验、改密码。
 *
 * 密码哈希的参数断言是字面量：`hashPassword` 必须与 `accounts/transfer.ts` 导出的
 * 那五个常量一致（N=16384 / r=8 / p=1 / salt 16 字节 / key 32 字节）。写成字面量而不是
 * 再 import 一次，是因为这条用例要防的正是「有人把常量改小了却以为只影响导出包」。
 */
import { describe, expect, it } from "bun:test";
import { scryptSync } from "node:crypto";
import {
  ADMIN_PASSWORD_LENGTH,
  DEFAULT_ADMIN_USERNAME,
  MIN_PASSWORD_LENGTH,
  UserManager,
  generateAdminPassword,
  hashPassword,
  newSalt,
} from "./manager.js";
import { emptyUsersFile } from "./types.js";
import type { UsersStore } from "./store.js";

/** 内存用户仓：管理逻辑与文件格式是两件事。*/
function memoryStore(): UsersStore & { snapshot(): ReturnType<typeof emptyUsersFile> } {
  let file = emptyUsersFile();
  return {
    load: async () => file,
    save: async (next) => {
      file = next;
    },
    snapshot: () => file,
  };
}

describe("generateAdminPassword", () => {
  it("returns 16 characters from an unambiguous alphabet", () => {
    const password = generateAdminPassword();
    expect(password).toHaveLength(ADMIN_PASSWORD_LENGTH);
    // 0/O、1/l/I 与 base64url 的 `-`/`_` 都不出现：这个密码要手抄一次。
    expect(password).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{16}$/);
  });

  it("does not repeat itself", () => {
    const generated = new Set(Array.from({ length: 32 }, () => generateAdminPassword()));
    expect(generated.size).toBe(32);
  });
});

describe("hashPassword", () => {
  it("uses the same scrypt parameters as the accounts export bundle", () => {
    const salt = Buffer.from("0123456789abcdef", "utf8");
    const expected = scryptSync("correct horse", salt, 32, { N: 16_384, r: 8, p: 1 }).toString("hex");
    expect(hashPassword("correct horse", salt)).toBe(expected);
    // 32 字节 = 64 个十六进制字符（`SCRYPT_KEY_BYTES`）。
    expect(hashPassword("correct horse", salt)).toHaveLength(64);
  });

  it("produces a different hash for a different salt", () => {
    const password = "same password";
    expect(hashPassword(password, Buffer.from(newSalt(), "base64")))
      .not.toBe(hashPassword(password, Buffer.from(newSalt(), "base64")));
  });
});

describe("UserManager.create / verify", () => {
  it("stores a salted hash, never the password", async () => {
    const store = memoryStore();
    const users = new UserManager(store);
    expect(await users.create("alice", "hunter2hunter2")).toEqual({ ok: true });

    const record = (await users.find("alice"))!;
    expect(record.username).toBe("alice");
    expect(record.passwordHash).not.toContain("hunter2");
    expect(record.salt.length).toBeGreaterThan(0);
    expect(record.createdAt).toBeGreaterThan(0);
  });

  it("verifies the right password and rejects the wrong one", async () => {
    const users = new UserManager(memoryStore());
    await users.create("alice", "hunter2hunter2");
    expect(await users.verify("alice", "hunter2hunter2")).toBe(true);
    expect(await users.verify("alice", "hunter2hunter3")).toBe(false);
  });

  it("rejects an unknown user with the same answer as a wrong password", async () => {
    const users = new UserManager(memoryStore());
    await users.create("alice", "hunter2hunter2");
    expect(await users.verify("nobody", "hunter2hunter2")).toBe(false);
  });

  it("refuses a duplicate username, a short password and an illegal username", async () => {
    const users = new UserManager(memoryStore());
    await users.create("alice", "hunter2hunter2");
    expect(await users.create("alice", "another-password")).toEqual({ ok: false, error: "duplicate_username" });
    expect(await users.create("bob", "x".repeat(MIN_PASSWORD_LENGTH - 1))).toEqual({ ok: false, error: "invalid_password" });
    expect(await users.create("has space", "hunter2hunter2")).toEqual({ ok: false, error: "invalid_username" });
  });
});

describe("UserManager.changePassword", () => {
  it("requires the current password", async () => {
    const users = new UserManager(memoryStore());
    await users.create("alice", "hunter2hunter2");
    expect(await users.changePassword("alice", "wrong", "brand-new-password")).toEqual({
      ok: false,
      error: "wrong_password",
    });
    expect(await users.verify("alice", "hunter2hunter2")).toBe(true);
  });

  it("rotates the salt along with the hash", async () => {
    const users = new UserManager(memoryStore());
    await users.create("alice", "hunter2hunter2");
    const before = (await users.find("alice"))!;

    expect(await users.changePassword("alice", "hunter2hunter2", "brand-new-password")).toEqual({ ok: true });
    const after = (await users.find("alice"))!;

    expect(after.salt).not.toBe(before.salt);
    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect(await users.verify("alice", "brand-new-password")).toBe(true);
    expect(await users.verify("alice", "hunter2hunter2")).toBe(false);
  });

  it("rejects a new password below the minimum length", async () => {
    const users = new UserManager(memoryStore());
    await users.create("alice", "hunter2hunter2");
    expect(await users.changePassword("alice", "hunter2hunter2", "short")).toEqual({
      ok: false,
      error: "invalid_password",
    });
  });
});

describe("UserManager.ensureAdmin (first start)", () => {
  it("creates admin with a generated password when the store is empty", async () => {
    const users = new UserManager(memoryStore());
    const result = await users.ensureAdmin();

    expect(result.created).toBe(true);
    expect(result.username).toBe(DEFAULT_ADMIN_USERNAME);
    expect(result.password).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{16}$/);
    expect(await users.verify(DEFAULT_ADMIN_USERNAME, result.password as string)).toBe(true);
  });

  it("is a no-op once a user exists, and returns no password", async () => {
    const store = memoryStore();
    const users = new UserManager(store);
    await users.create("alice", "hunter2hunter2");

    const result = await users.ensureAdmin();
    expect(result.created).toBe(false);
    expect(result.password).toBeNull();
    // 没有多造一个 admin：仓里仍然只有 alice。
    expect(store.snapshot().users.map((user) => user.username)).toEqual(["alice"]);
  });
});
