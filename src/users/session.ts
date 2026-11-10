/**
 * 控制面会话：内存里的 `sessionToken → {username, expiresAt}`。
 *
 * 不落盘是刻意的：会话语义就是「这次运行期间有效」，进程重启后重新登录一次即可。
 * 落盘反而要求处理「文件里的会话比进程还老」「多进程抢同一个文件」这些与需求无关
 * 的问题。
 *
 * token 带 `zcp_sess_` 前缀，因为它在浏览器与日志里会和 `sk-zcp-…` 这类数据面
 * key 混在一起出现，前缀是唯一能一眼分辨「这是人的会话还是程序的 key」的线索。
 */
import { randomBytes } from "node:crypto";

/** 会话 Cookie 的名字。*/
export const SESSION_COOKIE = "session";

/** 会话 token 的前缀（日志里认得出的依据，见文件头）。*/
export const SESSION_TOKEN_PREFIX = "zcp_sess_";

/** token 的随机部分：32 字节 = 256 位。*/
const SESSION_TOKEN_ENTROPY_BYTES = 32;

/** 会话有效期：12 小时。每次请求滑动续期。*/
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** 一条会话。*/
export interface Session {
  username: string;
  /** 到期时刻（Unix ms）。每次成功校验都往后推一个 TTL。*/
  expiresAt: number;
}

/**
 * 从 Cookie 头里取一个值。
 *
 * 不用正则：`/session=([^;]+)/` 会在别的 cookie 值里出现 `session=` 时误匹配
 * （例如 `note=session=abc`），而 cookie 头是客户端完全可控的字符串。逐段切开
 * 再比对名字，行为就是确定的。
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        // 非法的百分号转义：这一段不是我们能用的值，当作没带。
        return undefined;
      }
    }
  }
  return undefined;
}

/** 会话 token → `Set-Cookie` 的值。
 *
 * 不加 `Secure`：面板默认跑在 http（回环或内网），加了 `Secure` 浏览器根本不会
 * 回传这个 cookie，登录会静默失效。`HttpOnly` 挡住脚本读取，`SameSite=Strict`
 * 挡住跨站请求带 cookie。
 */
export function sessionCookie(token: string, maxAgeMs: number = SESSION_TTL_MS): string {
  const maxAge = Math.floor(maxAgeMs / 1000);
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

/** 登出用的 `Set-Cookie`：同名、立即过期。*/
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * 会话表。
 *
 * `resolve` 同时负责滑动续期：一次请求被接受，就把到期时间推后一个 TTL。这让
 * 「正在用面板的人不会被 12 小时硬性踢出」，而不活动超过 TTL 的会话仍然过期。
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  /** 当前会话数（测试与诊断用）。*/
  get size(): number {
    return this.sessions.size;
  }

  /** 新建一条会话，返回它的 token。*/
  create(username: string, now: number = Date.now()): string {
    this.prune(now);
    const token = `${SESSION_TOKEN_PREFIX}${randomBytes(SESSION_TOKEN_ENTROPY_BYTES).toString("base64url")}`;
    this.sessions.set(token, { username, expiresAt: now + SESSION_TTL_MS });
    return token;
  }

  /** 校验 token 并续期。过期 / 未知一律返回 `null`。*/
  resolve(token: string | undefined, now: number = Date.now()): Session | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= now) {
      this.sessions.delete(token);
      return null;
    }
    session.expiresAt = now + SESSION_TTL_MS;
    return session;
  }

  /** 删掉一条会话（登出）。*/
  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  /** 删掉某个用户的全部会话（改密码后旧会话不该继续有效）。返回删掉的条数。*/
  destroyUser(username: string): number {
    let removed = 0;
    for (const [token, session] of this.sessions) {
      if (session.username !== username) continue;
      this.sessions.delete(token);
      removed++;
    }
    return removed;
  }

  /** 清掉所有已过期的会话（`create` 时顺手调用，避免表只增不减）。*/
  prune(now: number = Date.now()): void {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}
