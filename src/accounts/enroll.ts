/**
 * 把一次登录 / 导入拿到的凭据登记成账号。
 *
 * 凭据是**账号的一部分**，不是进程级的一份全局状态，所以登录要回答两个问题：
 *
 * 1. **这是哪个账号？** 账号 id 是凭据指纹（`types.ts::credentialFingerprint`），
 *    所以重复登录同一账号是幂等的 `update`，不是新建。刷新时只覆盖凭据本身
 *    （JWT 会轮换），`label` / `routes` / `enabled` / `policy` 是用户配置，一律
 *    保留，否则一次重新登录就把用户调好的并发与白名单抹掉了。
 * 2. **叫什么名字？** `label` 是配置与 `X-ZCode-Account` 的引用键，必须唯一且稳定。
 *    默认取 provider（`zai` / `bigmodel`），撞名时按 `zai-2`、`zai-3` 递增；用户
 *    可以用 `auth login --label` 指定。
 *
 * 身份作用域这里只能给 `PERSONAL`：TEAM 的 organizationId / projectId / productId
 * 要从上游 `getCustomerInfo` 发现，那是导入流程的活，不能在这里猜，
 * 猜错就是跨 Family 拼接。
 *
 * `deviceMid` 在这里生成（一账号一指纹）：官方客户端的 deviceMid 是本地
 * 随机 UUIDv4、装机时生成、服务端不签发，所以「每个账号 = 一台虚拟设备」。
 * 重新登录时 `toAccountCredential` 会再生成一个新的，但 `manager.add` / `update` 的
 * 刷新分支会保留账号原有的那个，因为换指纹等于告诉上游「这个账号换设备了」。
 */
import { randomUUID } from "node:crypto";
import type { AccountManager } from "./manager.js";
import type { Account, Credential as AccountCredential, ZhipuAccountCredential } from "./types.js";
import { credentialFingerprint } from "./types.js";
import type { Credential as AuthCredential } from "../auth/types.js";

/** v1/auth 平面的凭据 → v2 账号凭据（`zhipu-account` + PERSONAL 身份）。*/
export function toAccountCredential(cred: AuthCredential): ZhipuAccountCredential {
  const converted: ZhipuAccountCredential = {
    kind: "zhipu-account",
    provider: cred.provider,
    apiKey: cred.apiKey,
    identity: { targetType: "PERSONAL", deviceMid: randomUUID() },
  };
  if (cred.secret) converted.secret = cred.secret;
  if (cred.jwt) converted.jwt = cred.jwt;
  if (cred.oauthAccessToken) converted.oauthAccessToken = cred.oauthAccessToken;
  // 指纹的 apiKey 兜底：JWT-only 账号的 apiKey 是空串，没有它就会与
  // 其它 JWT-only 账号撞成同一个 id。
  if (cred.userId) converted.upstreamUserId = cred.userId;
  return converted;
}

/**
 * 登记（新建或刷新）一个账号，返回落盘后的账号。
 *
 * `label` 缺省取 provider；撞名递增。**不做静默改名**以外的"智能匹配"：两个不同
 * 凭据永远是两个账号（id 不同），这是"重导入幂等"与"多账号"之间的分界线。
 */
export async function enrollCredential(
  manager: AccountManager,
  cred: AuthCredential,
  opts: { label?: string; routes?: Account["routes"] } = {},
): Promise<Account> {
  const credential: AccountCredential = toAccountCredential(cred);
  const id = credentialFingerprint(credential);

  const existing = await manager.get(id);
  if (existing) {
    // 只刷新凭据；显式传了 routes 才动白名单。
    const refreshed = await manager.update(id, {
      credential,
      ...(opts.routes ? { routes: opts.routes } : {}),
    });
    // auth-invalid 的唯一自动恢复是人工重新登录/导入凭据（引擎的
    // resetAuthInvalid 只清状态、不清 auth-failed 计数——计数仍只由 success 清零）。
    manager.notifyCredentialRefreshed(refreshed);
    return refreshed;
  }

  const label = await uniqueLabel(manager, opts.label?.trim() || credential.provider);
  const added = await manager.add({
    label,
    credential,
    ...(opts.routes ? { routes: opts.routes } : {}),
  });
  manager.notifyCredentialRefreshed(added);
  return added;
}

/**
 * 取一个未被占用的 label：`base`、`base-2`、`base-3`…
 *
 * 与 `AccountManager.add` 的 `duplicate-label` 校验配套：这里先让开，是因为
 * "导入第二个 zai 账号"是完全正常的操作，不该让用户为了一个名字去改配置。
 */
async function uniqueLabel(manager: AccountManager, base: string): Promise<string> {
  const taken = new Set((await manager.list()).map((account) => account.label));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
