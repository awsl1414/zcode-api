/**
 * Targeted YAML config editing helpers shared by the CLI entries (serve /
 * auth login) and the web panel.
 *
 * 面板令牌的读写随控制面登录一起删除：控制面的凭据是 `users.json`
 * 里的用户名与密码，配置文件里不再存任何口令，所以这个文件只剩「建配置文件」一件事。
 */
import { existsSync, writeFileSync } from "node:fs";
import { EXAMPLE_CONFIG_YAML } from "./template.js";

/**
 * Create the config file from the bundled template when missing.
 * Shared by the CLI entries (serve / auth login) — they used to each
 * hand-roll this block. Returns true when the file was
 * created, false when it already existed.
 *
 * **`updateConfigYaml` is gone**: it existed only to write the
 * top-level `provider` / `plan` keys, and neither exists any more — the family
 * belongs to the account's credential and the plan to the resolved route
 * (`accounts/broker.ts`). Runtime account edits (enable / weight /
 * concurrency) go to the accounts store, never back into config.yaml.
 */
export function ensureConfigFile(path: string): boolean {
  if (existsSync(path)) return false;
  writeFileSync(path, EXAMPLE_CONFIG_YAML, "utf-8");
  return true;
}
