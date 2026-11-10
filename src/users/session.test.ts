/**
 * 会话表：token 形态、TTL、滑动续期、登出、按用户清理。
 *
 * 全部用注入的 `now`：12 小时的 TTL 不可能靠真的等出来。
 */
import { describe, expect, it } from "bun:test";
import {
  SESSION_COOKIE,
  SESSION_TOKEN_PREFIX,
  SESSION_TTL_MS,
  SessionStore,
  clearedSessionCookie,
  readCookie,
  sessionCookie,
} from "./session.js";

describe("SessionStore", () => {
  it("mints a prefixed, high-entropy token and resolves it to the user", () => {
    const sessions = new SessionStore();
    const token = sessions.create("alice", 1_000);

    expect(token.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);
    // 32 字节的 base64url = 43 个字符。
    expect(token.slice(SESSION_TOKEN_PREFIX.length)).toMatch(/^[\w-]{43}$/);
    expect(sessions.resolve(token, 1_001)?.username).toBe("alice");
  });

  it("never mints the same token twice", () => {
    const sessions = new SessionStore();
    const tokens = new Set(Array.from({ length: 16 }, () => sessions.create("alice")));
    expect(tokens.size).toBe(16);
  });

  it("rejects an unknown or empty token", () => {
    const sessions = new SessionStore();
    expect(sessions.resolve(undefined)).toBeNull();
    expect(sessions.resolve("")).toBeNull();
    expect(sessions.resolve("zcp_sess_not-a-real-token")).toBeNull();
  });

  it("expires after 12 hours and forgets the entry", () => {
    const sessions = new SessionStore();
    const fresh = sessions.create("alice", 0);
    expect(sessions.resolve(fresh, SESSION_TTL_MS - 1)).not.toBeNull();

    // 另一条从头到尾没被用过：正好到 12 小时就失效（上面的 `fresh` 已经续过期了）。
    const stale = sessions.create("bob", 0);
    expect(sessions.resolve(stale, SESSION_TTL_MS)).toBeNull();
    expect(sessions.size).toBe(1);
  });

  it("slides the expiry forward on every accepted request", () => {
    const sessions = new SessionStore();
    const token = sessions.create("alice", 0);

    // 每 11 小时用一次：硬过期是 12 小时，但滑动续期让它一直有效。
    let now = 0;
    for (let i = 0; i < 5; i++) {
      now += SESSION_TTL_MS - 60 * 60 * 1000;
      expect(sessions.resolve(token, now)).not.toBeNull();
    }
    // 最后一次成功在 `now`，所以新的到期时刻是 `now + TTL`；超过它就失效。
    expect(sessions.resolve(token, now + SESSION_TTL_MS)).toBeNull();
  });

  it("destroys one session on logout and all of a user's on a password change", () => {
    const sessions = new SessionStore();
    const first = sessions.create("alice");
    const second = sessions.create("alice");
    const other = sessions.create("bob");

    sessions.destroy(first);
    expect(sessions.resolve(first)).toBeNull();
    expect(sessions.resolve(second)).not.toBeNull();

    expect(sessions.destroyUser("alice")).toBe(1);
    expect(sessions.resolve(second)).toBeNull();
    expect(sessions.resolve(other)?.username).toBe("bob");
  });

  it("drops expired entries when a new session is created", () => {
    const sessions = new SessionStore();
    sessions.create("alice", 0);
    expect(sessions.size).toBe(1);
    sessions.create("bob", SESSION_TTL_MS * 2);
    expect(sessions.size).toBe(1);
  });
});

describe("session cookie", () => {
  it("is HttpOnly, SameSite=Strict, path-wide and not Secure", () => {
    const cookie = sessionCookie("zcp_sess_abc");
    expect(cookie).toBe(`${SESSION_COOKIE}=zcp_sess_abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
    // 面板默认跑在 http 上：加了 Secure 浏览器就不会回传，登录会静默失效。
    expect(cookie).not.toContain("Secure");
  });

  it("clears with the same name and Max-Age=0", () => {
    expect(clearedSessionCookie()).toBe(`${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  });
});

describe("readCookie", () => {
  it("finds the named cookie among others", () => {
    expect(readCookie("theme=dark; session=abc; i18n_lang=zh", "session")).toBe("abc");
  });

  it("is not fooled by the name appearing inside another cookie's value", () => {
    // 正则版 `/session=([^;]+)/` 会在这里匹配到 `session=evil`。
    expect(readCookie("note=session=evil; session=real", "session")).toBe("real");
    expect(readCookie("note=session=evil", "session")).toBeUndefined();
  });

  it("tolerates spaces, missing values and malformed escapes", () => {
    expect(readCookie(" session = abc ", "session")).toBe("abc");
    expect(readCookie("session", "session")).toBeUndefined();
    expect(readCookie("session=abc", "other")).toBeUndefined();
    expect(readCookie("session=%E0%A4%A", "session")).toBeUndefined();
    expect(readCookie(undefined, "session")).toBeUndefined();
    expect(readCookie("", "session")).toBeUndefined();
  });

  it("decodes a percent-encoded value", () => {
    expect(readCookie("session=a%2Fb%3Dc", "session")).toBe("a/b=c");
  });
});
