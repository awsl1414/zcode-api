/**
 * 建号路径的用例：
 *
 * - 每个账号在建号那一刻拿到自己的 `deviceMid`，两个不同 JWT 就是两个账号；
 * - 重新 enroll 同一账号保留原 `deviceMid`（官方语义是「装机时定的」，重新登录不换设备）；
 * - `apiKey` 与 `upstreamUserId` 都为空的凭据被 `validateAccount` 拒绝，因为它无法回答
 *   「这是哪个上游账号」，放进去只会让两个账号撞同一个指纹。
 *
 * 存储用内存后端（`AccountsStore` 注入），不碰真实 `~/.zcode-proxy`。
 */
import { describe, it, expect } from "bun:test";
import { AccountError, AccountManager, validateAccount } from "./manager.js";
import { enrollCredential, toAccountCredential } from "./enroll.js";
import { buildAccountCredential } from "./transfer.js";
import type { AccountsStore } from "./store.js";
import { emptyAccountsFile } from "./types.js";
import type { Account, AccountsFile, Credential } from "./types.js";
import { LogBuffer } from "../log/buffer.js";
import type { AddCommand, HandlerContext } from "../control/control.js";
import type { Credential as AuthCredential } from "../auth/types.js";

/** 内存存储：建号用例不该碰磁盘，更不该写真实用户目录。*/
class MemoryStore implements AccountsStore {
  private file: AccountsFile = emptyAccountsFile();

  async load(): Promise<AccountsFile> {
    return structuredClone(this.file);
  }

  async save(next: AccountsFile): Promise<void> {
    this.file = structuredClone(next);
  }
}

/** 一个能落盘的 plan JWT（`token_version` + 可读 `iat`），`user_id` 用来区分账号。*/
function planJwt(userId: string): string {
  const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ user_id: userId, token_version: 1, sub: "s1", iat: Math.floor(Date.now() / 1000) })}.sig`;
}

/** JWT-only 凭据（`auth import --jwt` 的产物形状）。*/
function jwtOnlyCredential(userId: string, jwt = planJwt(userId)): AuthCredential {
  return { provider: "zai", apiKey: "", jwt, userId };
}

function managerFor(): AccountManager {
  return new AccountManager(new MemoryStore());
}

/** `addAccount` 走控制面时用的最小 ctx：这条路径只读 provider 与账号仓。*/
function ctxFor(manager: AccountManager): HandlerContext {
  return { accounts: manager, logBuffer: new LogBuffer() };
}

function deviceMidOf(account: Account): string | undefined {
  return account.credential.kind === "zhipu-account" ? account.credential.identity.deviceMid : undefined;
}

describe("enrollCredential — JWT-only 账号各自独立", () => {
  it("两个不同 JWT 建出两个账号（不是互相覆盖）", async () => {
    const manager = managerFor();
    const first = await enrollCredential(manager, jwtOnlyCredential("user-a"));
    const second = await enrollCredential(manager, jwtOnlyCredential("user-b"));

    // 指纹的 apiKey 是空串，能区分它们的只有 upstreamUserId。
    expect(first.id).not.toBe(second.id);
    expect((await manager.list()).length).toBe(2);
    expect(second.label).not.toBe(first.label);
  });

  it("重新 enroll 同一账号保留原 deviceMid（设备身份由建号时定）", async () => {
    const manager = managerFor();
    const first = await enrollCredential(manager, jwtOnlyCredential("user-a"));
    const deviceMid = deviceMidOf(first);
    expect(deviceMid).toBeTruthy();

    // 同一账号换了一枚 JWT（真实场景：重新登录）。指纹不变 → 同一条账号记录。
    const again = await enrollCredential(manager, jwtOnlyCredential("user-a", planJwt("user-a")));
    expect(again.id).toBe(first.id);
    expect(deviceMidOf(again)).toBe(deviceMid);
    expect((await manager.list()).length).toBe(1);
  });

  it("不同账号拿到不同的 deviceMid（一账号一指纹）", async () => {
    const manager = managerFor();
    const first = await enrollCredential(manager, jwtOnlyCredential("user-a"));
    const second = await enrollCredential(manager, jwtOnlyCredential("user-b"));
    expect(deviceMidOf(first)).not.toBe(deviceMidOf(second));
  });

  it("toAccountCredential 把 AuthCredential.userId 落成 upstreamUserId", () => {
    const credential = toAccountCredential(jwtOnlyCredential("user-a"));
    expect(credential.upstreamUserId).toBe("user-a");
    expect(credential.identity.deviceMid).toBeTruthy();
  });
});

describe("buildAccountCredential — 建号路径都填 upstreamUserId", () => {
  it("source: jwt 从 payload 的 user_id 填 upstreamUserId", async () => {
    const manager = managerFor();
    const cmd: AddCommand = { cmd: "addAccount", source: "jwt", label: "free-1", jwt: planJwt("user-a") };
    const built = await buildAccountCredential(cmd, ctxFor(manager));
    if (!built.ok) throw new Error(`unexpected error ${built.error}`);
    const credential = built.credential;
    if (credential.kind !== "zhipu-account") throw new Error("expected a zhipu-account credential");
    expect(credential.upstreamUserId).toBe("user-a");
    expect(credential.apiKey).toBe("");
    expect(credential.identity.deviceMid).toBeTruthy();
  });

});

describe("validateAccount — 无法区分账号的凭据被拒（边界）", () => {
  it("apiKey 与 upstreamUserId 都为空的 zhipu-account 被拒", () => {
    const credential: Credential = {
      kind: "zhipu-account",
      provider: "zai",
      apiKey: "",
      jwt: planJwt("user-a"),
      identity: { targetType: "PERSONAL", deviceMid: "mid-1" },
    };
    const account: Account = {
      id: "id-1",
      label: "unusable",
      credential,
      routes: ["start-plan"],
      enabled: true,
      policy: { weight: 1, maxConcurrency: 2 },
    };
    expect(() => validateAccount(account)).toThrow(AccountError);
    try {
      validateAccount(account);
    } catch (err) {
      expect((err as AccountError).code).toBe("unusable-credential");
    }
  });

  it("补上 upstreamUserId 后同一个账号通过", () => {
    const credential: Credential = {
      kind: "zhipu-account",
      provider: "zai",
      apiKey: "",
      jwt: planJwt("user-a"),
      upstreamUserId: "user-a",
      identity: { targetType: "PERSONAL", deviceMid: "mid-1" },
    };
    const account: Account = {
      id: "id-1",
      label: "usable",
      credential,
      routes: ["start-plan"],
      enabled: true,
      policy: { weight: 1, maxConcurrency: 2 },
    };
    expect(() => validateAccount(account)).not.toThrow();
  });
});
