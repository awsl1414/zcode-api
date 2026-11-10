import type { ProviderId } from "../provider/types.js";
import { AccountManager } from "./manager.js";
import { getAccountsPath } from "./store.js";
import type { Account } from "./types.js";

/**
 * 找出"导入应该合并进去"的账号。
 *
 * 给了 `--provider` 就找该 family 的第一个账号；没给就找账号表里的第一个。
 * 找不到就返回 null，由 `import.ts` 用 `defaultProvider` 兜底并新建账号。
 */
export async function findAccountForProvider(accounts: AccountManager, provider: ProviderId | undefined): Promise<Account | null> {
  const list = await accounts.list();
  if (provider) {
    const match = list.find((account) => account.credential.provider === provider);
    return match ?? null;
  }
  return list[0] ?? null;
}

/**
 * 账号 id 的展示宽度。
 *
 * id 是 64 位十六进制的凭据指纹（`accounts/types.ts::credentialFingerprint`），
 * 全打印会把日志行撑爆且没有人靠它区分账号；12 位足够在面板/日志里肉眼比对，
 * 又不会像 6 位那样在多账号时频繁撞前缀。
 */
const ACCOUNT_ID_DISPLAY_CHARS = 12;

/** 截断成可读的账号 id（只用于展示，绝不用于查找）。*/
export function shortId(id: string): string {
  return id.slice(0, ACCOUNT_ID_DISPLAY_CHARS);
}

/** 账号仓路径（`auth` 子命令的 "Stored:" 行）。*/
export function accountsPathForDisplay(): string {
  return getAccountsPath();
}
