<div align="center">

[中文版](README.md) | [英文版](README_EN.md)

# ZCode Proxy

**Plug your GLM coding plan into every AI coding tool.**

A small utility that runs on your own computer. Coding plans from Z.AI / Bigmodel
(personal / trial plans) normally only work inside the official client — ZCode Proxy
turns them into standard OpenAI / Anthropic APIs on your machine, so Claude Code,
Codex, Silly Tavern … can all use your plan quota directly.

[Quick Start](#-quick-start) · [Connect Your Tools](#-connect-your-coding-tools) · [FAQ](#-faq)

</div>

---

## What You Get

- 🧩 **One endpoint, three formats** — OpenAI, Anthropic and Responses (Codex-specific) APIs are all served on local `127.0.0.1:8080`; give each tool whichever format it speaks.
- 🖥️ **Built-in web dashboard** — after launch, manage everything in the browser: accounts, routing policy, quota, live logs, settings. The panel shares the proxy's port, prints an admin password once on the first start, and follows the proxy's bind address by default; set `panel.host` to `127.0.0.1` to keep it local.
- 💬 **Web chat included** — the panel's sidebar "Chat" view is a local ChatGPT-style chat page for trying out models; no extra port, no second address.
- 🌙 **Off-peak channel & plan grabber** (optional) — a free-quota channel for off-peak hours and automatic claiming of limited trial plans are both built in.
- 🔌 **In-plan MCP aggregate endpoint** — official ZCode plugin MCPs (Tianyancha / Wind / iFinD…) are merged behind a **single** `/mcp` endpoint (streamable HTTP, tools namespaced `{plugin}__{tool}` — clients configure just one MCP server; requires a coding-plan login, `GET /mcp` in a browser shows the catalogue).
- 🪟 **Cross-platform** — Windows / macOS / Linux run from one codebase; can also be compiled into a single-file executable or deployed with Docker.

## 🚀 Quick Start

### Step 1: download the latest exe from [GitHub Releases](https://github.com/awsl1414/zcode-api/releases)

Yep, that's it. It really is that simple.

The proxy starts right away and prints the panel address plus a one-time admin password (it also opens your browser when there is a desktop session):

```text
zcode-proxy listening on http://127.0.0.1:8080
panel: http://127.0.0.1:8080/
panel: admin password (shown once, change it in Settings):
        Xk9mP2vL8nQ4wR7t
```

The panel shares port 8080 with the proxy; opening it gives you the login page (user `admin`, the password above). Change it in Settings once signed in.

The panel's sidebar has eight views: **Overview** (proxy state / port / in-flight / risk alerts), **Stats** (usage aggregates and a 365-day heatmap), **Accounts** (the account table plus add / edit / enable / disable / remove, all hot), **Routing** (order / mode / strategy / stickiness / risk switches), **API keys**, **Logs** (SSE stream, filters by account and level, search), **Settings** (login / logout, update check, password change, per-field writes back to `config.yaml`) and **Chat**. The egress proxy table is not a page of its own: it lives in a drawer on the Accounts view. Chat is a sidebar view, not its own page. There is no start-stop-proxy button in the panel: it shares the proxy's listener, so stopping it there would stop the panel too — stop the process with Ctrl+C or your process manager.

> Want a purely headless run (no browser / no TTY)? Use `zcode-proxy --cli serve`. `--no-panel` turns off the panel and keeps the proxy running, which suits a machine whose accounts are already set up; do not use it in a container, where the panel is how accounts and API keys get created. The old terminal TUI was removed in 5.0; `zcode-proxy tui` now fails with an explicit error.

## 🔌 Connect Your Coding Tools

Once the proxy is running, the local address is **`http://127.0.0.1:8080`**. Your tools only need two changes: the **API endpoint** and the **model name**.

About the "API Key": create one key per client on the panel's API keys page (`/keys`) and paste it into your tool — it is shown once. While no key exists yet the data plane does not verify, so anything (e.g. `sk-1234`) works.

<details>
<summary><b>Claude Code</b> (click to expand)</summary>

```bash
# macOS / Linux
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_AUTH_TOKEN=sk-1234
export ANTHROPIC_MODEL=glm-5.3
claude
```

```powershell
# Windows PowerShell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8080"
$env:ANTHROPIC_AUTH_TOKEN = "sk-1234"
$env:ANTHROPIC_MODEL = "glm-5.3"
claude
```

</details>

<details>
<summary><b>Codex CLI</b> (uses the Responses API)</summary>

Edit `~/.codex/config.toml`:

```toml
model_provider = "zcode"
model = "glm-5.3"

[model_providers.zcode]
name = "ZCode Proxy"
base_url = "http://127.0.0.1:8080/v1"
wire_api = "responses"
env_key = "ZCODE_API_KEY"   # any non-empty value works, unless you've set a proxy key
```

</details>

<details>
<summary><b>Other OpenAI-compatible tools</b> (Cherry Studio, Kilo Code, Cline, LobeChat…)</summary>

In your tool's "Custom Provider" section, fill in:

| Setting | Value |
|--------|-----|
| API address (Base URL) | `http://127.0.0.1:8080/v1` |
| API Key | Your proxy key (anything, if unset) |
| Model | `glm-5.3`, `glm-5.3-flash` — see the model table below |

Anthropic-format tools (e.g. some Claude clients) should use `http://127.0.0.1:8080` as the address; the proxy handles the `/v1/messages` path automatically.

</details>

Want to try it manually first? Sign in to the panel and open the sidebar's "Chat" view, or use curl:

```bash
curl http://127.0.0.1:8080/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "glm-5.3-flash",
  "messages": [{"role": "user", "content": "Hello!"}]
}'
```

<details>
<summary><b>Docker Deployment</b></summary>

The image is multi-arch (amd64 / arm64), runs as uid 1000 (the image's `bun` user) by default, and accepts any uid/gid. Its multi-stage build ships only the application bundle and captcha worker, with all features retained and no `node_modules`, sources, tests, or additional build tools in the runtime layer. The panel is mounted on the proxy's own listener, so publishing `8080` is enough.

```bash
docker compose up -d                  # docker-compose.yml in the repo root; replace the seed first
docker compose logs zcode-proxy       # find the admin password line
```

The container starts as root; the entrypoint gives `/data` and `/home/bun` to `PUID:PGID`, then drops privileges for the proxy itself. The default is `1000:1000` (the image's `bun` user); set the two variables to use another uid:

```bash
docker run -d --name zcode-proxy -p 8080:8080 \
  -v "$(pwd)/data:/data" \
  -e PUID=1001 -e PGID=1001 \
  -e ZCODE_PROXY_CREDENTIAL_SECRET="a-fixed-random-string-only-you-know" \
  ghcr.io/awsl1414/zcode-proxy:latest
```

To keep the container off root entirely, use `--user 1001:1001` (`user:` in compose) instead. That route does not change ownership, so `./data` must already be writable by that uid or startup fails; `PUID`/`PGID` are then ignored with a one-line notice. An `/home/bun` this uid cannot write only disables the captcha script disk cache, so each start re-downloads it; solving still works. Neither route needs an `/etc/passwd` entry for the uid. Do not change `HOME`: the default store encryption seed is derived from the home path, so a different value makes existing accounts and keys undecryptable.

The first start looks like this (the password is printed once; after you change it in the panel it never appears again):

```text
Created /data/config.yaml from bundled template.
Run: zcode-proxy auth login <zai|bigmodel>

No account yet. Open the panel to add one, or run:
  zcode-proxy auth login zai|bigmodel
  zcode-proxy auth import [--jwt <token>]
panel: admin password (shown once, change it in Settings):
        Xk9mP2vL8nQ4wR7t
zcode-proxy listening on http://0.0.0.0:8080
panel: http://127.0.0.1:8080/
09:41:07 W [panel] panel reachable on a non-loopback address: anyone who reaches this port and signs in can log out, change settings, or shut down host=0.0.0.0
  models: 2 available
  /async/v1/*: ON        # only printed when async.enabled is on
```

The `panel: http://127.0.0.1:8080/` line is a loopback address, which only opens in a browser on the Docker host; from elsewhere use `http://<host>:8080/`.

Open `http://<host>:8080/`, sign in as `admin` with that password, then:

1. Add an account on the **Accounts** page (log in to Z.AI / bigmodel there, or import an existing credential). The proxy starts without any account; requests answer 503 `no-account` until one exists.
2. Create a key on the **API keys** page and paste it into your clients. Before the first key exists the data plane does not verify, so anything works in the meantime.

No compose file needed either:

```bash
docker run -d --name zcode-proxy -p 8080:8080 \
  -v "$(pwd)/data:/data" \
  -e ZCODE_PROXY_CREDENTIAL_SECRET="a-fixed-random-string-only-you-know" \
  ghcr.io/awsl1414/zcode-proxy:latest
```

The compose file (this is `docker-compose.yml` in the repo):

```yaml
services:
  zcode-proxy:
    image: ghcr.io/awsl1414/zcode-proxy:latest
    ports:
      - "8080:8080"
    volumes:
      - ./data:/data
    environment:
      # uid/gid of the proxy process; defaults to 1000:1000.
      PUID: "1000"
      PGID: "1000"
      # Encryption seed for the account files. Changing it loses every imported account.
      ZCODE_PROXY_CREDENTIAL_SECRET: "replace-with-a-fixed-random-string"
    restart: unless-stopped
```

`./data` is the whole install's storage directory: `config.yaml` (written on first start), `accounts.json`, `apikeys.json`, `users.json`, `policy.json`, plus the runtime-written `requests.jsonl` (request log), `activities.jsonl` (claim ledger) and `control.port`. Backups, machine moves and migrations copy this one directory.

Files inside `./data` are owned by `PUID:PGID`. If you back it up with a tool that preserves ownership, such as `rsync`, chown the host directory to the same ids first.

`ZCODE_PROXY_CREDENTIAL_SECRET` is the encryption seed for those files. Set it once and never change it: a different value makes every imported account and every existing key unreadable. It does not live in `config.yaml`, because that would store the secret in plaintext in the config file.

The port lives in `data/config.yaml` under `server.port` (the template ships 8080). Changing it means changing the compose `ports` too, since the in-container listener follows the YAML. The image carries a `HEALTHCHECK` against `/healthz`, the control surface's unauthenticated probe, so creating an API key does not turn it into a 401; with `--no-panel` that path answers nothing and the container reports unhealthy.

</details>

<details>
<summary><b>Configuration & Environment Variables</b> (works out of the box either way)</summary>

The config file is `config.yaml` in the process's working directory (auto-generated on first start; see [`config.example.yaml`](config.example.yaml) for fully commented options); in a container `ZCODE_PROXY_CONFIG` points it at `/data/config.yaml`. **There is one place to configure things: `config.yaml`, or the panel's Settings page** (the panel writes back to that file). Environment variables are for process-level overrides, not user configuration, so ports, switches and origins all live in `config.yaml`.

The env vars the runtime reads are none of them user configuration:

| Env variable | Default | Description |
|----------|------|------|
| `ZCODE_PROXY_CONFIG` | `config.yaml` | Config file path (a start argument: the YAML is not known yet; `/data/config.yaml` in the image) |
| `ZCODE_PROXY_STORE_DIR` | `~/.zcode-proxy` | Storage directory: accounts, API keys, control-surface users and account policies all land here (`/data` in the image) |
| `ZCODE_PROXY_CREDENTIAL_SECRET` | machine-specific | Encryption seed for those store files (fix it when migrating across machines / using Docker) |
| `PUID` / `PGID` | `1000` / `1000` | Read by the image entrypoint only: the uid/gid the proxy drops to inside the container |
| `ZCODE_LOG_FORMAT` | desktop table | Set to `compact` for single-line logs (narrow screens and `docker logs`; the image already sets it) |
| `ZCODE_ENV` | production | `test` reports the client release channel as test; irrelevant on desktop |
| `ZCODE_UPDATE_CHECK` / `ZCODE_UPDATE_SKIP` | on / none | Disable the "new version" check / comma-separated tags to mute, e.g. `v5.0.0,v5.0.1` |
| `HTTP_PROXY` / `HTTPS_PROXY` | none | System proxy, used by captcha solving and upstream requests |
| `CAPTCHA_POOL_MAX` / `CAPTCHA_SOLVE_CONCURRENCY` / `CAPTCHA_CPU_LIMIT_PCT` | `60` / `3` / `100` | Captcha pool ceiling, solve concurrency, CPU ceiling (lower them on weak hardware) |

A few more are process-level overrides, usually irrelevant for desktop deployments: `ZCODE_IDENTITY_*` (explicitly overrides outbound identity headers; defaults to the machine's real values), `ZCODE_DUMP_UPSTREAM` / `CAPTCHA_DEBUG` / `CAPTCHA_DEBUG_BODIES` (troubleshooting), `CAPTCHA_ACQUIRE_BUDGET_MS` / `CAPTCHA_CONFIG_TIMEOUT_MS` / `CAPTCHA_CONFIG_TTL_MS` (captcha acquisition budget and config fetch limits, default 45s / 15s / 1h), `ZCODE_CAPTCHA_WORKER` / `ZCODE_CAPTCHA_WARM_WORKERS` (worker path and warm-pool size for compiled builds), `MCP_AGGREGATE_TOOLS_TTL_MS` (`/mcp` tool cache, 5 minutes by default) and `ZCODE_OAUTH_PASTE` (same as `auth login --paste`).

The plan type (`plan`: `coding-plan` personal / `start-plan` trial) is a property of the **account**: it is derived from the credential and its subscription at import time, and no process-level policy overrides it. Changing plans therefore means changing accounts: re-import on the panel's Accounts page (remove, then add) or with the `zcode-proxy auth account` command family; it takes effect immediately.

The panel is on by default and shares the proxy's **own port** (`panel.enabled` turns it on or off in `config.yaml`, `panel.host` changes the address it answers on, and `--no-panel` only affects one start) — it shows status and quota, manages accounts, edits the routing policy, logs in and out, and tails the live logs (the MCP catalogue lives on the data plane at `GET /mcp`, not in the panel). Access goes through a login page: the first start prints an admin password once in the terminal (user `admin`), you can change it in Settings, and the session lives in the server process with a sliding 12-hour expiry. Commands are dispatched in process, so no extra control port is opened. SIGTERM/SIGINT and the panel's own shutdown clear the background timers (auto-claim, captcha pool) before exiting. Logging out from the page only ends the panel session and leaves the upstream account and credentials unaffected.

**Update notice**: on startup the proxy asks GitHub once for the latest release, printing at most one extra log line (the panel's Settings page can re-check manually). It never blocks startup and never affects the proxy: offline, blocked, rate-limited or unexpected answers are ignored silently. A manual check always answers — "already on the latest version" or "check unavailable". Container images are immutable, so the hint names the pull command of the **detected runtime** (Docker: `docker compose pull && docker compose up -d`, Podman: `podman compose pull && podman compose up -d`; when the runtime cannot be told apart it just says "pull the new image and recreate the container") rather than replacing files in place (release artifacts carry no checksums yet, so automatic download-and-replace is not offered). Set `ZCODE_UPDATE_CHECK=off` to disable the check, or `ZCODE_UPDATE_SKIP=v5.0.0` to mute a single tag.

**Reaching the panel from Docker**: the panel is mounted on the proxy's own listener, so `-p 8080:8080` is enough. Open `http://<host>:8080/` and you get the login page; the admin password is in the first start's `docker logs`. After signing in, the panel and the proxy share one port and one session.

Outside a container, to keep the control surface local while the proxy stays reachable, set `panel.host` to `127.0.0.1` in `config.yaml`: the proxy still binds `0.0.0.0`, but the panel only answers local requests. Do not do that in a container, where the host would no longer reach the panel.

</details>

<details>
<summary><b>Advanced: Off-peak Channel & Auto Plan Claiming</b></summary>

**Off-peak channel (`/async/*`)** — a free compute channel the official service opens during off-peak hours (e.g. late night). Requests queue up for a ticket first and are automatically sent to the model once their turn arrives (great for non-urgent batch jobs). Enable it with `async.enabled: true` in `config.yaml`; note that it's one-shot with no conversation memory — for multi-turn chats, include the history in the request.

**Weekend/trial plan auto-claiming (claim)** — enabled by default. The proxy probes the official limited-plan campaign every 5 minutes (`claim.pollIntervalMs`), preheats ahead of an opening and bursts the moment it goes live; set `claim.auto: false` to stop the background job, or `claim.enabled: false` to turn the whole thing off. Manual run: `bun run src/index.ts claim`.

**Quota display (quota)** — accounts are sampled in the background every `accounts.quota.pollSeconds` (300 by default), plus one probe round at startup, so quota refreshes on its own after login; the appbar refresh button and the `r` key trigger an immediate re-sample for the current view. Data comes from two upstream planes: trial/credits-plan buckets (`billing/balance`, remaining / total units, expiry) and individual coding-plan usage windows (`/api/monitor/usage/quota/limit`, same endpoint the official usage panel reads — 5-hour / weekly window **remaining** and reset time. Upstream `number` is not a total comparable with remaining, so like the CLI only remaining is shown, and a bar is drawn only when upstream reports a percentage). CLI: `bun run src/index.ts quota` (HTTP: `GET /quota`).

</details>

## 🧮 Available Models

The table below is for reference only:

| Model | Context | Max Output |
|------|--------|----------|
| `glm-5.3`  | 1M | 128K |
| `glm-5.3-flash` (vision) | 1M | 128K |

## ❓ FAQ

**Startup says "No account yet" / requests return 503?**
The proxy starts without an account; requests then fail with the `no-account` code (503). Log in with `bun run src/index.ts auth login zai` (or bigmodel), or add an account on the panel's Accounts view. Logging in once is enough; credentials are stored encrypted.

**Port 8080 is already taken?**
Change `server.port` in `config.yaml` (or use the panel's Settings page, which writes back to the same file).

**My tool can't connect / gets a 401?**
Your tool must send one of the keys created on the panel's API keys page. While no key exists the data plane does not verify anything; once a key exists, **all routes** (including `/health`) except the panel's own session (a browser signed in to the panel) require one, and a disabled key gets the same 401 as a wrong one.

**Do I need to log in again after switching computers or reinstalling the OS?**
Yes. Credentials are encrypted with machine-bound information. To migrate across machines, set the same `ZCODE_PROXY_CREDENTIAL_SECRET` on both sides, then copy the whole `~/.zcode-proxy/` directory (accounts, keys and control-surface users live there).

**No browser on my server — how do I log in?**
Just log in directly: `bun run src/index.ts auth login zai` (or bigmodel). The login link can be opened in any device's browser; after you authorize, the local side completes automatically (no callback page needed). If you prefer a manual exchange, there's also a paste mode: `auth login bigmodel --paste` — paste back the full URL you're redirected to.

**I already logged in with the ZCode client. Do I have to authorize again?**
No. `bun run src/index.ts auth import` reads `~/.zcode/v2/credentials.json`, exchanges the OAuth token inside for the coding-plan API key, and imports the plan JWT along with it. If that exchange fails you still end up with the JWT, which covers start-plan, quota and claim; MCP, async and highspeed also need the coding-plan key. With only a JWT in hand, paste it: `auth import --jwt <token>`. Importing does not renew anything, so re-import or log in again once the credential stops working.

**What does it actually do in the background?**
It's a "translator + courier": it translates the standard requests from your tools into the same requests the official client sends, forwards them, and translates the responses back as-is. All traffic stays between your machine and the official servers — it never passes through any third party.

## 🛠️ Development

```bash
bun test            # run tests
bun x tsc --noEmit  # type check
bun run dev         # start the panel in dev mode
```

For architecture and implementation details, see the comments inside the source files under [`src/`](src/).

## Privacy

The proxy runs fully locally: **no telemetry, no analytics, and no outbound
reporting of any kind**. Nothing about your usage, device, or configuration
leaves your machine; debug/dump logs auto-redact API keys, JWTs, and proxy
keys.

## License

Copyright (c) 2026 awsl1414 and the ZCode Proxy contributors.

This project is an independent derivative of [TriDefender/zcode-api](https://github.com/TriDefender/zcode-api): 5.0 restructured it substantially (multi-account scheduling, a web panel, a three-protocol gateway) and is maintained in its own repository rather than tracking the upstream. The upstream copyright and license notice are kept below and in [LICENSE](LICENSE), as CC BY-NC-SA 4.0 attribution requires.

This project uses **[Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)](https://creativecommons.org/licenses/by-nc-sa/4.0/)**. [LICENSE](LICENSE) contains the unmodified official standard text, preceded by the project's copyright and license notice.

- **NonCommercial**: copying, sharing and adapting are permitted without a license fee when complying with the license. Uses primarily intended for commercial advantage or monetary compensation are not permitted.
- **Attribution and notices**: when sharing the original or adaptations, retain attribution and supplied original copyright, license and disclaimer notices as required by the license, link to the license, and indicate modifications.
- **ShareAlike**: publicly shared adaptations must use the same or a compatible license as permitted by CC BY-NC-SA 4.0. Do not impose additional legal terms or technical measures restricting the licensed rights.

**Scope limits**: CC BY-NC-SA 4.0 does not require software source disclosure, cannot strictly guarantee a ban on closed-source distribution, and has no network-service source disclosure requirement. This project adds no such custom restrictions. CC [recommends against its licenses for software](https://creativecommons.org/faq/#can-i-apply-a-creative-commons-license-to-software); this project chooses its noncommercial, attribution and ShareAlike conditions. Independent tool outputs containing no licensed Project material are not automatically covered merely because the tool was used.

Third-party components retain their own licenses. This license covers only material the rights holders may offer on these terms; valid earlier MIT grants are not retroactively revoked. This is a summary; see [LICENSE](LICENSE) and the [official legal code](https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.en) for the complete terms.

## Protocol and maintenance notes

Responses hosted search tools are not executed by this proxy.
