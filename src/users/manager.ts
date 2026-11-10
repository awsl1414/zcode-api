/**
 * 用户管理：建管理员、改密码、校验密码。
 *
 * 密码哈希的五个参数直接 import 自 `accounts/transfer.ts`：账号导出包的 scrypt 与
 * 面板密码的 scrypt 是同一套强度，不另定义一份（两份常量迟早会漂移，而漂移的方向
 * 通常是把新的那份调弱）。
 *
 * 校验一律走 `timingSafeEqual`，并且「用户不存在」与「密码错」返回同一个结果：
 * 登录页也只说「用户名或密码错误」，不告诉试探者哪一半错了。
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import {
  SCRYPT_BLOCK_SIZE,
  SCRYPT_COST,
  SCRYPT_KEY_BYTES,
  SCRYPT_PARALLELIZATION,
  SCRYPT_SALT_BYTES,
} from "../accounts/transfer.js";
import { fileUsersStore } from "./store.js";
import type { UsersStore } from "./store.js";
import type { UserRecord } from "./types.js";

/** 首次启动生成的管理员用户名。*/
export const DEFAULT_ADMIN_USERNAME = "admin";

/** 首次启动生成的密码长度（字符）。*/
export const ADMIN_PASSWORD_LENGTH = 16;

/**
 * 生成密码用的字母表：base64url 去掉容易看错的字符（`0`/`O`、`1`/`l`/`I`、`-`/`_`）。
 *
 * 这个密码只出现一次，用户要手抄到登录框里，抄错一位就是一个「用户名或密码错误」
 * 的死循环。base64url 的字符集本身没问题，问题只在那几个字形。
 */
const PASSWORD_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 新密码的最短长度。低于这个值就是空密码的同义词。*/
export const MIN_PASSWORD_LENGTH = 8;

/** 用户名允许的字符：字母、数字、点、下划线、连字符。*/
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** 生成一个 16 字符的随机密码（无歧义字符，见 {@link PASSWORD_ALPHABET}）。*/
export function generateAdminPassword(length: number = ADMIN_PASSWORD_LENGTH): string {
  let password = "";
  // 一次取 32 字节够填 16 个字符；取不满就再抽一轮，概率可以忽略但不写死假设。
  while (password.length < length) {
    for (const byte of randomBytes(32)) {
      // 256 不是字母表长度的整数倍，直接取模会让前几个字符略偏。这里用拒绝采样：
      // 落在尾部的那几个值丢掉，分布才是均匀的。
      const limit = Math.floor(256 / PASSWORD_ALPHABET.length) * PASSWORD_ALPHABET.length;
      if (byte >= limit) continue;
      password += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      if (password.length === length) break;
    }
  }
  return password;
}

/** scrypt(密码, salt) → 十六进制。参数与账号导出包同源。*/
export function hashPassword(password: string, salt: Buffer): string {
  return scryptSync(password, salt, SCRYPT_KEY_BYTES, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
  }).toString("hex");
}

/** 新 salt（base64）。*/
export function newSalt(): string {
  return randomBytes(SCRYPT_SALT_BYTES).toString("base64");
}

/** 常数时间比较两个十六进制哈希。*/
function hashMatches(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** 写操作的结果：成功，或一个稳定错误码（页面按码查翻译表，查不到就原样显示码）。*/
export type UserWriteResult = { ok: true } | { ok: false; error: string };

/** 首次启动的结果。`created` 为 false 时 `password` 是 `null`（已有用户，不必打印）。*/
export interface EnsureAdminResult {
  created: boolean;
  username: string;
  password: string | null;
}

/**
 * 用户仓。
 *
 * 与 `AccountManager` 的差别是这里不做缓存：用户表只在登录、改密码、首次启动时被
 * 读写，一次磁盘往返换来「改密码立刻生效」是划算的。
 */
export class UserManager {
  constructor(private readonly store: UsersStore = fileUsersStore) {}

  /** 全部用户（密码哈希也在里面，调用方不得把它发到页面）。*/
  async list(): Promise<UserRecord[]> {
    const file = await this.store.load();
    return file.users;
  }

  /** 是否已有用户（首次启动的判断依据）。*/
  async hasUsers(): Promise<boolean> {
    return (await this.list()).length > 0;
  }

  /** 找一个用户（不改动任何状态）。*/
  async find(username: string): Promise<UserRecord | null> {
    const users = await this.list();
    return users.find((user) => user.username === username) ?? null;
  }

  /**
   * 校验用户名 + 密码。
   *
   * 用户不存在时仍然算一次哈希（用一个固定的假记录），让两条路径的耗时接近：
   * 否则「用户不存在」会明显更快，等于把用户名枚举送出去。
   */
  async verify(username: string, password: string): Promise<boolean> {
    const users = await this.list();
    const user = users.find((entry) => entry.username === username);
    if (!user) {
      hashPassword(password, Buffer.from(newSalt(), "base64"));
      return false;
    }
    return hashMatches(user.passwordHash, hashPassword(password, Buffer.from(user.salt, "base64")));
  }

  /** 建一个用户。用户名重复、密码太短、用户名非法都回稳定错误码。*/
  async create(username: string, password: string): Promise<UserWriteResult> {
    const name = username.trim();
    if (!USERNAME_PATTERN.test(name)) return { ok: false, error: "invalid_username" };
    if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, error: "invalid_password" };

    const users = await this.list();
    if (users.some((user) => user.username === name)) return { ok: false, error: "duplicate_username" };

    const salt = newSalt();
    users.push({
      username: name,
      passwordHash: hashPassword(password, Buffer.from(salt, "base64")),
      salt,
      createdAt: Date.now(),
    });
    await this.store.save({ version: 1, users });
    return { ok: true };
  }

  /**
   * 改密码：先验当前密码，再换新 salt 与新哈希。
   *
   * 换 salt 是必须的：同一 salt 下两次密码的哈希会暴露「新旧密码是否相同」之外
   * 更多的信息，而重新生成 salt 的成本只是一次随机数。
   */
  async changePassword(username: string, currentPassword: string, nextPassword: string): Promise<UserWriteResult> {
    if (nextPassword.length < MIN_PASSWORD_LENGTH) return { ok: false, error: "invalid_password" };
    if (!(await this.verify(username, currentPassword))) return { ok: false, error: "wrong_password" };

    const users = await this.list();
    const index = users.findIndex((user) => user.username === username);
    if (index < 0) return { ok: false, error: "wrong_password" };

    const salt = newSalt();
    users[index] = {
      ...users[index]!,
      passwordHash: hashPassword(nextPassword, Buffer.from(salt, "base64")),
      salt,
    };
    await this.store.save({ version: 1, users });
    return { ok: true };
  }

  /**
   * 首次启动：没有用户就建一个 `admin`，并回传一次明文密码。
   *
   * 不做引导页：首次启动的场景只发生在终端里，用户本来就在看 stdout，而多一层
   * 「创建管理员」的 UI 要多维护一套状态（密码强度提示、二次输入、失败重试），
   * 收益只是把同一件事换个地方做。
   */
  async ensureAdmin(): Promise<EnsureAdminResult> {
    if (await this.hasUsers()) {
      return { created: false, username: DEFAULT_ADMIN_USERNAME, password: null };
    }
    const password = generateAdminPassword();
    const result = await this.create(DEFAULT_ADMIN_USERNAME, password);
    if (!result.ok) {
      // 用户名与密码都是本模块生成的，走到这里只可能是磁盘写不进去。
      throw new Error(`cannot create the default admin: ${result.error}`);
    }
    return { created: true, username: DEFAULT_ADMIN_USERNAME, password };
  }
}
