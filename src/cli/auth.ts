import { enrollCredential } from "../accounts/enroll.js";
import { toAuthCredential } from "../accounts/manager.js";
import { usableSurfaces } from "../auth/capabilities.js";
import { ImportError, SECRET_PREFIX_LENGTH, defaultCredentialsPath, importCredential, importFromZCodeConfig, summarizeImport } from "../auth/import.js";
import { inspectJwt } from "../auth/jwt-age.js";
import { BigmodelOAuthClient, LOGIN_TIMEOUT_MS, createPollOAuthClient, parsePastedCallbackUrl } from "../auth/oauth.js";
import type { OAuthResult } from "../auth/oauth.js";
import { KeyResolver } from "../auth/resolver.js";
import type { Credential } from "../auth/types.js";
import type { ProviderId } from "../provider/types.js";
import { openBrowser } from "../runtime/open-browser.js";
import { boldIfTTY, pasteLoginInstructions, readPastedLine } from "../runtime/paste-login.js";
import { openAccountStore } from "../accounts/runtime.js";
import { accountsPathForDisplay, findAccountForProvider } from "../accounts/selection.js";
import { accountCommand } from "./account.js";
import { cliFailure } from "./control.js";
import { ensureConfigFile } from "../config/edit.js";
import { fallbackAppVersion, loadConfig } from "../config/loader.js";

/**
 * 配置是 CLI 各子命令的输入（provider 端点、额度/领取的 origin 都从它读），所以首次
 * 运行时先按模板建出来，与 `serve` 同一套（provider / plan 不写进配置）。
 *
 * 这里也不生成 `identity.deviceMid`：指纹是账号属性，建号时生成。
 */
function ensureConfigReady(): void {
  const path = process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (ensureConfigFile(path)) console.log(`Created ${path} from bundled template.`);
}

/**
 * 登录授权链接里的 `app_version`。
 *
 * 读过配置就用生效值（手写 > 探测 > 默认）；配置写坏了不该拦住登录——登录是为了
 * 能修账号，而这个版本号只影响链接上的一个参数，不参与鉴权。
 */
function loginAppVersion(): string {
  const path = process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  try {
    return loadConfig(path).identity.appVersion;
  } catch {
    return fallbackAppVersion();
  }
}

export function authCommand(args: string[]): void {
  const sub = args[0];

  if (sub === "login") {
    authLogin(args.slice(1));
  } else if (sub === "import") {
    // Fully self-contained error handling (typed ImportError → one-line message),
    // so a floating rejection can never escape this synchronous dispatcher.
    void authImport(args.slice(1)).catch((err: unknown) => {
      console.error(`Import failed: ${(err as Error).message}`);
      process.exitCode = 1;
    });
  } else if (sub === "status") {
    void authStatus().catch((err: unknown) => {
      console.error(`Status failed: ${(err as Error).message}`);
      process.exitCode = 1;
    });
  } else if (sub === "account") {
    // 账号命令族：全部走 control dispatcher，与面板同一份语义。
    void accountCommand(args.slice(1)).catch(cliFailure("auth account"));
  } else {
    console.error("Usage: zcode-proxy auth <login|import|status|account>");
    process.exit(1);
  }
}

async function authLogin(args: string[]): Promise<void> {
  const provider = args[0] as ProviderId | undefined;
  const importMode = args.includes("--import");
  // Headless paste login: --paste flag or ZCODE_OAUTH_PASTE=1 (docker-friendly).
  const pasteMode =
    args.includes("--paste") || /^(1|true|yes)$/i.test(process.env.ZCODE_OAUTH_PASTE ?? "");
  // `--label <name>` 给账号起名（CLI 建号入口）。缺省取 provider，
  // 撞名自动递增（accounts/enroll.ts）。
  const labelFlag = args.indexOf("--label");
  const label = labelFlag >= 0 ? args[labelFlag + 1] : undefined;

  if (!provider || (provider !== "zai" && provider !== "bigmodel")) {
    console.error("Usage: zcode-proxy auth login <zai|bigmodel> [--import] [--paste] [--label <name>]");
    process.exit(1);
  }
  if (labelFlag >= 0 && (!label || label.startsWith("--"))) {
    console.error("--label needs a value.");
    process.exit(1);
  }
  if (pasteMode && provider !== "bigmodel") {
    console.error("--paste applies to the bigmodel auth-code flow only.");
    console.error("zai login is server-mediated (no localhost callback) and already works headless.");
    process.exit(1);
  }

  ensureConfigReady();

  const mode = importMode ? "(import)" : pasteMode ? "(OAuth, paste)" : "(OAuth)";
  console.log(`Logging in: ${provider} ${mode}\n`);

  let cred: Credential;

  if (importMode) {
    cred = importFromZCodeConfig(provider);
  } else {
    const { accessToken, userId, jwt } = await runOAuth(provider, pasteMode);
    console.log("\nResolving API key...");
    const resolver = new KeyResolver();
    cred = await resolver.resolveCodingPlanCredential(accessToken, provider, userId);
    if (jwt) cred.jwt = jwt;
  }

  // 登录落成**账号**：凭据进账号仓，不再覆盖进程里那唯一一份凭据。
  const accounts = await openAccountStore();
  const account = await enrollCredential(accounts, cred, label ? { label } : {});
  console.log(`\nLogged in as ${provider}.`);
  console.log(`  Account: ${account.label} (${account.routes.join(", ")})`);
  console.log(`  API Key: ${cred.apiKey.substring(0, SECRET_PREFIX_LENGTH)}...`);
  if (cred.userId) console.log(`  User ID: ${cred.userId}`);
  console.log(`  Stored:  ${accountsPathForDisplay()}`);
}

/**
 * `auth import`: bring an existing ZCode account in without re-running OAuth.
 *
 * Two sources (auth/import.ts holds the parsing and merge rules):
 *   --jwt <token>   a pasted plan JWT, handled offline; start-plan and the
 *                   control plane work, coding-plan does not
 *   [--file <path>] ZCode's credential store (default
 *                   ~/.zcode/v2/credentials.json), whose OAuth access token is
 *                   exchanged for the coding-plan key
 *
 * The command reports and then performs its writes: the credential is merged
 * into the encrypted store, and provider/plan go back to config.yaml when the
 * import changes them. A JWT-only credential can only run start-plan.
 */
async function authImport(args: string[]): Promise<void> {
  // Accept both `--flag value` and `--flag=value`; JWTs are long and get pasted
  // with `=` as often as with a space.
  const argv: string[] = [];
  for (const arg of args) {
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (eq > 0) argv.push(arg.slice(0, eq), arg.slice(eq + 1));
    else argv.push(arg);
  }

  let jwt: string | undefined;
  let file: string | undefined;
  let provider: ProviderId | undefined;
  let replace = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      printImportHelp();
      return;
    } else if (arg === "--replace") {
      replace = true;
      continue;
    } else if (arg === "--jwt" || arg === "--file" || arg === "--provider") {
      const value = argv[++i];
      if (!value) {
        console.error(`${arg} needs a value.`);
        printImportHelp();
        process.exitCode = 1;
        return;
      }
      if (arg === "--jwt") jwt = value;
      else if (arg === "--file") file = value;
      else if (value === "zai" || value === "bigmodel") provider = value;
      else {
        console.error(`Unknown provider "${value}". Expected zai or bigmodel.`);
        process.exitCode = 1;
        return;
      }
    } else {
      console.error(`Unknown option: ${arg}`);
      printImportHelp();
      process.exitCode = 1;
      return;
    }
  }

  if (jwt && file) {
    console.error("Pass either --jwt or --file, not both.");
    process.exitCode = 1;
    return;
  }

  // Same bootstrap as `auth login`: a usable config file must exist before the
  // provider and plan can be read and synced.
  // 配置仍然要先建出来，但导入本身不读写配置里的 provider / plan。
  ensureConfigReady();

  const accounts = await openAccountStore();

  let report;
  try {
    report = await importCredential({
      ...(jwt ? { jwt } : {}),
      ...(file ? { file } : {}),
      ...(provider ? { provider } : {}),
      replace,
      defaultProvider: (await accounts.list())[0]?.credential.provider ?? "zai",
      // 存储由调用方注入：合并目标是"同 provider 的那个账号"，写回则落成
      // 账号。`import.ts` 只负责解析/合并，不碰任何存储细节。
      load: async () => {
        const mergeTarget = await findAccountForProvider(accounts, provider);
        return mergeTarget ? toAuthCredential(mergeTarget.credential) : null;
      },
      save: async (cred) => {
        await enrollCredential(accounts, cred);
      },
    });
  } catch (err) {
    if (err instanceof ImportError) {
      console.error(`Import failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  for (const line of summarizeImport(report)) console.log(line);
  console.log(`  Stored:  ${accountsPathForDisplay()}`);

  // 不往 config.yaml 写 provider / plan：账号自己带 provider，
  // 路由白名单由凭据能力推断（accounts/manager.ts::inferRoutes，与 report 的
  // codingPlanReady / startPlanReady 同一套判定）。全局配置不需要与凭据能力对齐，
  // 所以导入只落账号记录。
}

function printImportHelp(): void {
  console.log(`Usage:
  zcode-proxy auth import [--file <path>] [--provider <zai|bigmodel>] [--replace]
  zcode-proxy auth import --jwt <token> [--provider <zai|bigmodel>] [--replace]

Import an existing ZCode account instead of running OAuth:

  --file <path>   ZCode credential store to read
                  (default: ${defaultCredentialsPath()})
                  Its OAuth access token is exchanged for the coding-plan API
                  key; the file's plan JWT is imported alongside it.
  --jwt <token>   A plan JWT pasted directly, handled offline. It covers
                  start-plan, /quota and claim. coding-plan, /mcp, /async and
                  highspeed also need the API key half.
  --provider      zai | bigmodel, overrides what the source names
  --replace       discard the stored credential instead of merging into it
`);
}

/**
 * `auth status` — 逐个账号报告凭据两半是否齐全、能跑哪些 surface。
 *
 * 没有"当前 plan"可打印：能跑什么由**该账号的路由白名单 + 凭据
 * 能力**决定，所以对每个账号调 `usableSurfaces(cred, routes)`（与请求期同一张表）。
 */
async function authStatus(): Promise<void> {
  const accounts = await openAccountStore();
  const list = await accounts.list();
  if (list.length === 0) {
    console.log("Not logged in.");
    console.log("Run: zcode-proxy auth login <zai|bigmodel>");
    return;
  }
  console.log(`Accounts: ${list.length}`);
  for (const account of list) {
    const cred = toAuthCredential(account.credential);
    console.log(`  ${account.label} — ${cred.provider}, routes: ${account.routes.join(", ")}${account.enabled ? "" : " [disabled]"}`);
    // A JWT-only credential is a legitimate state (`auth import --jwt`), so show
    // which half is present instead of printing an empty key prefix.
    console.log(
      cred.apiKey
        ? `    API Key: ${cred.apiKey.substring(0, SECRET_PREFIX_LENGTH)}...`
        : "    API Key: (none; coding-plan requests are refused, run `zcode-proxy auth import`)",
    );
    if (cred.jwt) {
      const info = inspectJwt(cred.jwt);
      const age = info ? `, issued ${Math.round(info.ageHours)}h ago` : "";
      console.log(`    Plan JWT: ${cred.jwt.substring(0, SECRET_PREFIX_LENGTH)}...${age}`);
    } else {
      console.log("    Plan JWT: (none)");
    }
    console.log(`    Usable:  ${usableSurfaces(cred, account.routes).join(", ") || "(none)"}`);
  }
  console.log(`  Store:   ${accountsPathForDisplay()}`);
}

async function runOAuth(provider: ProviderId, pasteMode: boolean): Promise<OAuthResult> {
  if (provider === "bigmodel" && pasteMode) {
    const oauth = new BigmodelOAuthClient();
    return runPasteLogin(oauth);
  }

  // Both providers use the server-mediated poll login (ZCode 3.12.3 default):
  // the browser never calls back here — open the URL on ANY device and the
  // flow completes server-side while we poll.
  const oauth = createPollOAuthClient(provider, loginAppVersion());
  const result = await oauth.authorize((url) => {
    console.log("Open this URL to authorize (any device/browser works):\n");
    console.log(`  ${url}\n`);
    console.log("Waiting for authorization... (expires in 300s)\n");
    console.log(
      "After you authorize, the browser may report it cannot open a zcode:// link —\n" +
        "that is expected and safe to ignore; the login completes here automatically.\n",
    );
    openBrowser(url);
  });
  return result;
}

/**
 * Headless bigmodel login (`auth login bigmodel --paste`): the localhost
 * callback server is still bound — it defines the redirect port and the
 * browser can never reach it from inside a container anyway — but instead of
 * waiting on it, the user pastes the redirected URL back. The exact
 * `started.callbackUrl` string is used BOTH as the authorize `redirect` param
 * and as the exchange `redirect_uri` (the token endpoint requires them to
 * match), so the pair stays consistent by construction.
 */
async function runPasteLogin(oauth: BigmodelOAuthClient): Promise<OAuthResult> {
  const started = await oauth.start();
  try {
    console.log(pasteLoginInstructions(started.authorizeUrl, started.callbackUrl, LOGIN_TIMEOUT_MS));
    openBrowser(started.authorizeUrl);
    process.stdout.write("\n" + boldIfTTY("Paste the FULL redirected URL here, then press Enter:") + "\n> ");
    const pasted = await readPastedLine(LOGIN_TIMEOUT_MS);
    const code = parsePastedCallbackUrl(pasted, started.state);
    console.log("\nExchanging authorization code...");
    const tokens = await oauth.exchangeCode(code, started.callbackUrl, started.state);
    return { accessToken: tokens.accessToken, provider: "bigmodel", userId: tokens.userId, jwt: tokens.jwt };
  } finally {
    await oauth.close();
  }
}
