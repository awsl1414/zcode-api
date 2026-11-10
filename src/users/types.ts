/**
 * 控制面用户：能登录网页面板的人。
 *
 * 与数据面凭据（`apikeys.json`）是两套东西：
 * 用户表回答「谁在改配置」，API key 回答「哪个程序在发请求」。把两者合成一个
 * 令牌，就会出现「想给某个客户端单独发一个 key，就得把面板密码也告诉它」。
 *
 * 存储形态与 `accounts/types.ts` 同构：整个文件一起加密，外层留一个明文版本号
 * 让未来的格式升级能在不解密的情况下判断「这是不是我能读的文件」。
 */

/** 用户文件的结构版本（外层与密文内各留一份，理由见 `accounts/store.ts`）。*/
export const USERS_STORE_VERSION = 1;

/** 一个控制面用户。*/
export interface UserRecord {
  username: string;
  /**
   * scrypt(密码, salt) 的十六进制串。
   *
   * 参数与账号导出包同源（`accounts/transfer.ts` 的五个常量），不另立一套：
   * 同一台机器上两种密码保护不该有强弱之分。
   */
  passwordHash: string;
  /** scrypt 的 salt（base64）。每条用户独立生成，改密码时换新值。*/
  salt: string;
  createdAt: number;
}

/** `~/.zcode-proxy/users.json` 的明文形态。*/
export interface UsersFile {
  version: typeof USERS_STORE_VERSION;
  users: UserRecord[];
}

/** 空仓（文件不存在 / 解不开 / 结构损坏时都落到这里）。*/
export function emptyUsersFile(): UsersFile {
  return { version: USERS_STORE_VERSION, users: [] };
}
