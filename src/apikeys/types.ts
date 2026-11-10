/**
 * 数据面 API key：程序访问代理时用的凭据。
 *
 * 与 `users/types.ts` 的控制面用户是两套东西：用户回答「谁在改配置」，API key 回答
 * 「哪个程序在发请求」。共用一个令牌就会出现「想给服务器的 CI 发一个 key，就得把面板
 * 密码也告诉它」。
 *
 * 一个 key 存两份材料：`hash`（`sha256(key)`，鉴权用）+ `secret`（AES-256-GCM
 * 密文，面板展示 / 复制用）。只存 hash 不够：面板要求「key 可复制 + 默认掩码显示」，
 * 能复制就必须能还原明文。明文不直接落盘是因为任何能读文件的东西都能拿到全部 key。
 * 而本项目的整份 `apikeys.json` 本来就过 `machineCodec()`（同一把机器派生密钥加密
 * `accounts.json` / `users.json` / `apikeys.json` 的整份文件），key 明文再加密一层
 * 的安全等级与账号凭据**完全相同**：能读这些文件的人，本来就能读到账号的上游凭据。
 * hash 保留是因为鉴权路径只需要比较（`manager.authenticate` 的
 * `timingSafeEqual`），不碰密文、不解密，密文对它零影响。
 */

import type { RequestRecord } from "../proxy/request-record.js";

/** key 文件的结构版本（外层与密文内各留一份，理由见 `accounts/store.ts`）。*/
export const API_KEYS_STORE_VERSION = 1;

/**
 * key 的固定前缀。
 *
 * `sk-` 是各家客户端都认的形状，`zcp` 是 zcode-proxy：日志里一眼能分辨这是本地数据面
 * 的 key，而不是上游的 `sk-...`。控制面会话 token 的 `zcp_sess_` 前缀是同一个
 * 思路：它和数据面 key 会一起出现在日志里，前缀用来分辨人还是程序。
 */
export const API_KEY_PREFIX = "sk-zcp-";

/** 随机部分的字节数。32 字节 = 256 位，base64url 编码后 43 个字符。*/
export const API_KEY_ENTROPY_BYTES = 32;

/** `id` 取 `sha256(key)` 十六进制的前这么多位。16 位 = 64 位索引空间，够用且短。*/
export const API_KEY_ID_HEX_CHARS = 16;

/**
 * 展示用前缀里保留的随机字符数。
 *
 * 4 个字符（16 位）已经足够区分「手里这几个 key」，再多就接近可暴力枚举的范围了。
 */
export const API_KEY_VISIBLE_CHARS = 4;

/** 名称长度上限。超出就是误输入（粘贴错行），不是「起了个长名字」。*/
export const API_KEY_NAME_MAX_LENGTH = 64;

/** 单个 key 的累计用量（请求数 / token / 错误 / 最近使用 / 今日滚动）。*/
export interface ApiKeyUsage {
  /** 累计请求数。*/
  requests: number;
  /** 累计输入 / 输出 token（从上游响应的 `usage` 字段取）。*/
  inputTokens: number;
  outputTokens: number;
  /** 累计错误数（HTTP 状态码 >= 400 的数据面请求）。*/
  errors: number;
  /** 最后一次使用时刻（Unix ms）；从未用过为 `null`。*/
  lastUsedAt: number | null;
  /** 今日请求数（按本地日期滚动，跨天自动归零）。*/
  todayRequests: number;
  /** 今日日期（`YYYY-MM-DD`），用来判断要不要把 `todayRequests` 归零。*/
  todayDate: string;
}

/** 一条 API key。*/
export interface ApiKeyRecord {
  /** `sha256(key)` 的前 {@link API_KEY_ID_HEX_CHARS} 位，用作索引。*/
  id: string;
  /** 用户起的名字，如 "claude-code-笔记本"。*/
  name: string;
  /**
   * `sha256(key)` 的完整十六进制串。鉴权的唯一依据（`timingSafeEqual`，见
   * `manager.authenticate`），与下面的密文双份并存的理由见文件头。
   */
  hash: string;
  /**
   * key 明文的 AES-256-GCM 密文（`machineCodec().encode`）。
   *
   * 面板「显示 / 复制」与聊天页「选已管理 key 直接发」都从它解开明文。只在创建时
   * 加密一次；读盘本身不解密，`list`（控制面 `listApiKeys` 的应答路径）在需要回
   * 明文时才逐条 decode。5.0 契约：必填且必须可解密——缺 / 解不开 = 损坏记录，
   * 加载或 list 时丢弃并告警（`store.reviveRecord` / `manager.list`）。
   */
  secret: string;
  /** 展示用前缀，如 "sk-zcp-a1b2"（界面自己补省略号）。*/
  prefix: string;
  enabled: boolean;
  createdAt: number;
  usage: ApiKeyUsage;
}

/** `~/.zcode-proxy/apikeys.json` 的明文形态。*/
export interface ApiKeysFile {
  version: typeof API_KEYS_STORE_VERSION;
  keys: ApiKeyRecord[];
}

/**
 * 发到页面 / 控制面的 key 摘要：**没有 hash**。
 *
 * 单独一个类型而不是直接发 `ApiKeyRecord`：hash 是密码学材料，没有理由离开服务端。
 * 应答里出现过什么，就等于对外承诺了什么，所以连 hash 的存在都不发。
 *
 * `secret` 只在 `listApiKeys` 的应答里出现（已解密的完整明文）。`create` /
 * `setEnabled` / `resetUsage` 的应答不带它：创建的明文走应答顶层的 `key` 字段
 * （只此一次的仪式保留），后两个动作没有理由带。
 */
export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  createdAt: number;
  usage: ApiKeyUsage;
  /** 解密后的完整 key（仅 `listApiKeys` 携带；其他应答形状不设此字段）。*/
  secret?: string;
}

/** 空仓（文件不存在 / 解不开 / 结构损坏时都落到这里）。*/
export function emptyApiKeysFile(): ApiKeysFile {
  return { version: API_KEYS_STORE_VERSION, keys: [] };
}

/** 一份全新的用量（`todayDate` 由调用方给，日期口径在 `manager.ts`）。*/
export function emptyUsage(todayDate: string): ApiKeyUsage {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    errors: 0,
    lastUsedAt: null,
    todayRequests: 0,
    todayDate,
  };
}

/**
 * 一次数据面请求结束时的用量通知（采集点在请求收尾）。
 *
 * 实现方是 `apikeys/manager.ts`；调用方是 `proxy/handler.ts` 的收尾收口。handler 不
 * 持有 key 状态，它手上只有那条 `RequestRecord`：归因哪条 key、状态码与 token 数都在
 * 里面，所以传整条记录。以后要加一个统计维度时，不用再改一次这个签名。
 */
export interface DataPlaneObserver {
  /**
   * 记账。
   *
   * 返回 Promise 是因为仓要读文件（`apikeys/manager.ts`）：实现自己吞掉失败，记账
   * 失败不能让一次已经完成的代理请求变成错误。调用方 `void` 掉这个 Promise。
   */
  onRequestEnd(record: RequestRecord): void | Promise<void>;
}
