/**
 * Bundled config template — inlined as a string constant so it compiles into
 * the single-file binary (`bun build --compile`) without requiring a sidecar
 * `config.example.yaml` file at runtime.
 *
 * Source of truth: config.example.yaml at repo root, which this file mirrors
 * byte for byte. `ensureConfigFile` writes this string on first start, so any
 * drift between the two shows up as a first-start config that documents keys
 * differently from the one in the repo.
 */

export const EXAMPLE_CONFIG_YAML: string = `server:
  port: 8080
  host: "0.0.0.0"

auth:
  # Whether the data plane requires an API key. The keys themselves live in
  # ~/.zcode-proxy/apikeys.json, managed at
  # /keys in the panel: each one has a name, its own usage counters and a
  # disable switch, so nothing about them belongs in this file.
  #
  # With this on and no key created yet, the proxy stays open: a first start
  # must be usable before the panel has been visited once.
  requireKey: true

  # Upstream credentials come from \`auth login\` / \`auth import\` and live in the
  # encrypted account store (~/.zcode-proxy/accounts.json). There is no path
  # override: the store is the only source.

# Start-plan captcha controls (environment variables only, milliseconds):
# CAPTCHA_ACQUIRE_BUDGET_MS=45000 bounds initial acquisition and retry backoff.
# Expiry returns 503 without forwarding; client abort stops waiting immediately.
# CAPTCHA_CONFIG_TIMEOUT_MS=15000 covers config headers AND the complete body.
# CAPTCHA_CONFIG_TTL_MS=3600000 caches successful snapshots only. Refresh errors
# preserve the last known config, including an explicit disabled state.
# Non-numeric, non-finite, or non-positive values use the defaults above.

# Endpoint overrides per provider family (optional; the defaults below are the
# official endpoints). Accounts carry their own provider and routes now, so
# there is no top-level \`provider:\` / \`plan:\` any more — an account's credential
# says which family it is, and the route a request resolves to says which
# endpoint, auth shape and layers apply.
providers:
  zai:
    anthropicBase: "https://api.z.ai/api/anthropic"
    openaiBase: "https://api.z.ai/api/coding/paas/v4"
  bigmodel:
    anthropicBase: "https://open.bigmodel.cn/api/anthropic"
    openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4"

# Default model used when a client request omits \`model\`.
defaultModel: glm-5.3

# Informational model list surfaced in the startup output and the panel; any
# other model id still forwards upstream (no whitelist enforcement).
models:
  - glm-5.3
  - glm-5.3-flash

# Configurable identity headers injected on every upstream request to mimic the
# ZCode desktop client (User-Agent, X-Title, X-ZCode-Agent, HTTP-Referer).
# The app version follows the officially installed client: leave appVersion
# empty to detect it, or pin it by hand when the detection reads the wrong
# client. Runtime platform headers (X-Platform, X-Os-Category, X-Os-Version)
# are detected dynamically and are not configured here. All fields below are
# optional; YAML overrides the built-in defaults.
identity:
  # ZCode client version. Empty = probe the client installed on this machine;
  # when nothing is found the built-in default applies. A hand-written value
  # must be x.y.z. Pinning is only safe when this machine really has that
  # version: a version upstream has never seen reads as a forgery.
  appVersion: ""
  # X-Title suffix → "Z Code@{sourceTitle}". Default "cli".
  sourceTitle: "cli"
  # HTTP-Referer URL. Default "https://zcode.z.ai".
  refererOrigin: "https://zcode.z.ai"
  # Client \`anthropic-beta\` handling.
  # "drop" (default) sends no anthropic-beta at all: the official ZCode client
  # sends none unless tool search is on, while Claude Code sends a dozen —
  # including \`claude-code-20250219\` and \`oauth-2025-04-20\`, which name the
  # client outright, against a \`User-Agent: ZCode/…\`. "allowlist" keeps only
  # the values listed in betaAllowlist (case-insensitive, blank entries never
  # produce an empty header). An invalid value is rejected at load time.
  betaPolicy: "drop"
  # Only consulted when betaPolicy is "allowlist". The single beta the official
  # ZCode CLI ever sends is advanced-tool-use-2025-11-20 (tool-search path).
  betaAllowlist: []

# Local client-session inference for upstream session affinity.
# "enforce" (default) forwards a stable x-session-id for inferred sessions
# (cache affinity + closer to the official client, whose signing template
# always carries a session id). "observe" logs inferred sessions in debug
# mode without changing upstream x-session-id. "off" disables inference.
clientIdentity:
  mode: enforce
  ttlSeconds: 900
  maxSessions: 1024

# Reasoning-effort control: what the proxy does with each request's reasoning
# settings. "passthrough" (default) leaves the client's own thinking /
# output_config untouched, so the client decides. "override"
# rewrites every reasoning model's request to the configured tier,
# regardless of what the client asked for:
#   - glm-5.3 / glm-5.3-flash: "low"/"high"/"max" set the paired
#     output_config.effort + thinking.budget_tokens; "off" sends
#     thinking disabled (glm-5.3-flash honors it; plain glm-5.3 cannot
#     truly disable thinking upstream, same as an explicit disable today).
#   - other reasoning models (glm-5.2/5.1/5/4.x): thinking enabled with the
#     tier budget, or disabled.
#   - non-reasoning models are left untouched.
# "effort" is inert while mode is "passthrough" (kept so switching modes
# keeps the tier you picked). Hot-reloads without a restart.
reasoning:
  mode: "passthrough"
  effort: "high"

# Responses API (/v1/responses) — Codex CLI / OpenAI Agents SDK endpoint.
# Always on: the three inbound protocols are all first-class citizens, and an
# inbound protocol is a commitment to callers, not a subsystem with a switch.
# Requests are translated through Chat
# Completions to the Anthropic-format upstream (both plans post Anthropic
# upstream).
responses:
  # /v1/responses is a stateful protocol: a caller continues a turn with
  # previous_response_id, so the proxy has to keep the previous response around
  # for a while. These two values tune that in-memory cache (cleared on
  # restart). Not exposed in the panel — tuning parameters, not decisions.
  store:
    maxEntries: 1000
    ttlMs: 86400000

# Official plugin-MCP aggregate (tianyancha / Wind / 同花顺 iFinD ...).
# ONE /mcp endpoint exposes every plugin's tools, namespaced {plugin}__{tool}
# (streamable HTTP JSON-RPC: initialize / ping / tools list & call). GET /mcp
# returns a human-readable catalogue; DELETE /mcp closes the cached upstream
# plugin sessions. Outbound calls hit Z.AI's official gateway with your
# OAuth login injected — inbound callers authenticate with a data-plane API
# key from the panel's /keys page.
# Requires a coding-plan credential: the upstream gateway rejects
# identity-only auth (JSON-RPC 3101), so start-plan requests fail with 400
# \`mcp_plan_unsupported\`.
# The server table ships with the build (scripts/regen-mcp-catalogue.ts).
# The relay spends your paid data entitlements, so create an API key before
# exposing this endpoint (CORS headers are only emitted once the key table is
# non-empty).
mcp:
  # Subsystem flag the panel reports and writes (Settings page). The \`/mcp\`
  # route itself is registered when \`gateway.enabled\` below is on.
  enabled: true
  gateway:
    enabled: true
    # \`\${ZCODE_BASE_URL}\` substituted into plugin .mcp.json URLs.
    # Production default per the desktop bundle (\`jee\`); the
    # chatglm.site variant is the TEST env origin.
    upstreamOrigin: https://zcode.z.ai

# Async (off-peak / "idle plan") bridge.
# When enabled, exposes POST /async/v1/messages and /async/v1/chat/completions
# that route through ZCode's off-peak ticket-queue backend — free compute when
# the GLM cluster has idle capacity. The proxy holds the connection open with
# SSE keepalives during queue wait, forwards the LLM stream once a ticket is
# ready, and auto-retries on ticket-expired (up to maxRetries).
#
# IMPORTANT: off-peak needs the JWT captured by \`auth login\`. A credential
# without a JWT makes the route return 400 \`async_credentials_unavailable\`.
# Off-peak is a coding-plan feature: when a request resolves to a start-plan
# route, the /async/* routes return 400 \`async_plan_unsupported\` even when
# enabled: true.
async:
  enabled: false
  origin: "https://zcode.z.ai"
  pollIntervalMs: 5000
  keepAliveIntervalMs: 3000
  # Maximum total wait for ticket to become ready, in ms. 0 = unlimited.
  maxWaitMs: 0
  maxRetries: 3
  settleTimeoutMs: 8000
  controlTimeoutMs: 15000
  # Optional model override; empty uses the request's \`model\`.
  defaultModel: ""

# Claim activities discovered at runtime from the merged billing preview and
# marketing deliveries. There is no static plan-id list: a new campaign enters
# the flow as soon as its delivery carries plan_id and a time window.
# Claiming opens at \`starts_at\`; the entitlement may become usable later at
# \`effective_at\`, so the two clocks are kept separate.
#
# IMPORTANT: requires a logged-in credential (claim uses the JWT from
# \`auth login\`), and identity.appVersion must be >= the campaign's minimum
# client version or the server rejects with \`ineligible\` — an app_version
# below the floor can also surface as a silently empty preview list
# (measured floor 3.14.0 for the 2026-09 campaign; the built-in appVersion
# "3.17.2" satisfies it).
claim:
  # On by default: the scheduler polls the merged activity list (billing preview
  # + marketing deliveries) every 5 min and idles until a campaign goes live
  # (404 preview = nothing to claim).
  # \`false\` = CLI-only (\`zcode-proxy claim [list|now]\` still works).
  enabled: true
  # Auto-claim in the background while serving. \`false\` = CLI-only
  # (\`zcode-proxy claim\` still works when \`enabled: true\`).
  auto: true
  origin: "https://zcode.z.ai"
  # Preview poll cadence (5 min default).
  pollIntervalMs: 300000
  # Backoff after failed attempts (10 min default); quota_exhausted /
  # already_claimed back off to the server-provided next window instead;
  # preview 429 backs off to the server's Retry-After.
  cooldownMs: 600000
  # Short window around an activity's starts_at: preheat probes the feed, then
  # bursts at the opening time. Probe and burst intervals are floored at 1s.
  opening:
    preheatMs: 180000
    probeIntervalMs: 10000
    burstIntervalMs: 2000
    burstWindowMs: 180000
    accountStaggerMs: 200
    maxClaimsPerAccount: 6
  # Sorting key for discovered activities. Open string, not an activity-type
  # enum; the scheduler reads it when it orders the runtime catalogue.
  policy: "upstream-priority"
  # Last-sprint threshold in ms: when the selected target has started and
  # ends within this window, polling speeds up to sprintPollIntervalMs to catch
  # late quota releases. 0 disables the sprint. Default 1800000 (30 min).
  sprintWindowMs: 1800000
  # Poll cadence during the last-sprint window (floored at 1s). Default 60000.
  sprintPollIntervalMs: 60000

# Server-controlled upstream URL remapping (mirrors the ZCode client's
# ProviderEndpointRoutingService). The proxy periodically fetches
# {origin}/api/v1/agent/configs and rewrites matching upstream URLs per the
# returned proxyEndpoint.mapping table (currently the coding-plan Anthropic
# endpoints -> zcode.z.ai ultra endpoints). Fail-open: any fetch/parse error
# keeps the original URLs.
endpointRouting:
  enabled: true
  origin: "https://zcode.z.ai"

# Client request signing V4 (mirrors the ZCode 3.15.1 static signing rule).
# When enabled, coding-plan requests are always signed: handshake against
# {provider}/api/paas/c1f3a7e2/v2/client, Ed25519 signature + proof-of-work
# headers on every request, fail-open retry ladder (two 401 VERIFY rejections
# -> permanent unsigned bypass). Start-plan and off-peak paths are never
# signed (the old agent/configs codingPlanSignature gate is gone on both
# sides).
clientSigning:
  enabled: true

# HighSpeed 加速卡 (official current shape: Coding Plan subscriber benefit,
# server-side random draw). Enabled by default, matching the official client
# (which has no toggle): the first eligible coding-plan request ignites a
# background draw loop (POST {origin}/api/v1/highspeed/draw at ~1/s, the
# measured token-bucket refill rate; server next_draw_at is ignored on a miss).
# On a hit, the request is rerouted from coding-plan to the highspeed route
# (zcode.z.ai/api/v1/highspeed/anthropic) with the Coding Plan dual-JWT auth
# set + X-Highspeed-Card-ID and stays unsigned. The model is never rewritten
# (official: "accelerating only swaps the endpoint, not the model"). Each
# account owns its own card slot; the loop self-extinguishes 5 minutes after
# the last eligible request; account unavailability (503/3404) is
# negative-cached 10min, HTTP 429 backs off 5s. task_id reuses the local
# client-session affinity inference.
highspeed:
  enabled: true
  origin: "https://zcode.z.ai"
  models: ["glm-5.3", "glm-5.2", "glm-5.1"]

# Account scheduling (5.0 multi-account).
# Everything here is optional: an account with no policy
# entry runs with enabled: true / weight: 1 / maxConcurrency: 2, and these
# routing defaults apply. Concurrency is per (account, route): a slot is
# held for the whole time the upstream is occupied, including a streaming
# response.
accounts:
  routing:
    # Entitlement urgency, not route priority: order[0] is burned first, and
    # a tier with no candidate hands over to the next one.
    # start-plan leads because its trial quota expires, while the paid
    # coding-plan window just resets.
    order: ["start-plan", "coding-plan"]
    # How accounts are picked inside one tier. This is the tier-local
    # order, and it decides where strategy sits:
    #   sticky      (default, R10) rendezvous hash; one session never migrates
    #               between accounts, and strategy is overridden
    #   drain-first known-expiry accounts first, ascending expiresAt;
    #               accounts with no quota sample yet come after them and
    #               spread by strategy order
    #   strategy    the tier-local order is strategy itself; use this to make
    #               balanced / round-robin take effect
    withinTier: sticky
    # prefer = degrade when a tier is unusable | only = order[0] only
    mode: prefer
    # tier-local order / tie-break (see withinTier above):
    # sticky-hash (default, R10) | balanced | round-robin
    strategy: sticky-hash
    # wait (default, R12) | overflow (rotate to another account)
    onSaturated: wait
    # fallback | stop
    onDrained: fallback
    # rotate = same-route rotate, never degrade
    onAuthFailed: rotate
    # bounded wait; expiry answers 429 + Retry-After
    queueTimeoutMs: 30000
    # queue depth cap; overflow answers 429 immediately
    maxQueue: 64
    # global in-flight cap (R16): per-account raises cannot breach it
    maxTotalInflight: 8

  stickiness:
    # session -> (account, route) affinity
    enabled: true
    ttlSeconds: 1800
    maxSessions: 4096
    # wait | overflow | wait-then-overflow
    onSaturated: wait
    overflowAfterMs: 5000

  # Quota sampling. Both keys are optional: the sampler runs with the
  # defaults below when this section is absent.
  quota:
    # Sampling period in seconds (R14). Each account is sampled on its own
    # hash-derived phase plus ±5% jitter, so N accounts never heartbeat in
    # lockstep (R13). Idle accounts are skipped; drained ones keep being
    # sampled so recovery is noticed (R14).
    pollSeconds: 300
    # Used-share of a window (0..1) at or above which the (account, route) is
    # marked drained and leaves the candidate set. 1.0 = 100%.
    drainThreshold: 1.0

  # Named egress proxies (R17). One row per exit; an account points at a
  # *name*, so editing a url once re-points every account that uses it. A proxy
  # that is still referenced can only be removed with --force, and a disabled
  # one is refused rather than bypassed: falling back to direct would leak this
  # machine's address. Protocols: http:// https:// socks5:// socks5h://
  # (socks5h resolves DNS at the proxy, socks5 resolves it here).
  proxies:
    - name: home
      url: "http://127.0.0.1:7890"
    # - name: office
    #   url: "socks5://10.0.0.5:1080"
    #   username: "user"
    #   password: <proxy-password>
    # - name: backup
    #   url: "http://127.0.0.1:7891"
    #   enabled: false      # written out, not used until enabled again

  # Risk-control switches. R1 (one device fingerprint per account) and
  # R2 (session namespace isolation) are code invariants, not switches, so
  # they are deliberately absent here.
  risk:
    # R13 heartbeat jitter: each account's highspeed draw loop starts at a
    # hash-derived phase plus ±10% jitter, so N accounts never draw in lockstep
    # (synchronised heartbeats are a machine fingerprint). Only turn this off
    # for debugging.
    jitterHeartbeat: true
    # Where accounts go when their own entry says nothing (precedence:
    # entries[].proxy > this > direct). Omit for direct; write \`direct\` to say
    # it out loud. One named exit shared by several accounts is exactly what the
    # overview's "N accounts share one egress" alert is for.
    # defaultProxy: home

  # Per-account overrides, keyed by label (the same key the
  # X-ZCode-Account header uses). Precedence: runtime override >
  # entries[] > the account's own policy. enabled, weight and
  # maxConcurrency are all hot-reloadable at runtime.
  entries:
    # - label: work-team
    #   proxy: home        # a name from accounts.proxies, or \`direct\`
    #   enabled: true
    #   weight: 2
    #   maxConcurrency: 4   # > 4 trips the risk warning (R11: 2)
    #   rpmLimit: 60        # upstream requests/minute; over the cap counts as
    #                       # saturated (queue/overflow), never an upstream 429
    # - label: personal-start
    #   enabled: true
    #   weight: 1
    #   maxConcurrency: 2
    #
    # 这里不写 \`routes\`：账号自己能走哪些 route 是账号属性（导入时从凭据和订阅
    # 得出），不在进程级策略里覆盖。

logging:
  level: info
  # 请求上下文记录：把每个上游请求的完整上下文（含请求/响应体）写进
  # 调试文件，一行一个阶段。风险：dump 文件含完整请求体，可能包含提示词内容，
  # 只在排障时开启。开关改这里要重启进程才生效（面板设置页同一条提示）。
  # 环境变量 ZCODE_DUMP_UPSTREAM 优先于这一段（排障时临时打开不用改文件）。
  dump:
    enabled: false
    path: ""        # 空 = <storeDir>/dump.jsonl（默认 ~/.zcode-proxy/dump.jsonl）

# Web panel, the graphical control surface. It is mounted on the proxy's own
# listener, so one published port is enough
# (Docker: \`-p 8080:8080\`). Access goes through the login page; the URL
# carries no token. \`--no-panel\` turns it off for one start.
panel:
  enabled: true
  # Empty = follow server.host. Set a loopback address to keep the control
  # surface local while the proxy itself listens on 0.0.0.0.
  host: ""
`;
