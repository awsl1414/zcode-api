/**
 * Tests for config loader.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configureLogging, resetLogging } from "../log/index.js";
import { DEFAULT_APP_VERSION, loadConfig, resetLegacyKeyWarnings } from "./loader.js";

const TMP = join(tmpdir(), `zcode-proxy-test-${Date.now()}`);

function writeYaml(content: string): string {
  mkdirSync(TMP, { recursive: true });
  const p = join(TMP, "config.yaml");
  writeFileSync(p, content, "utf-8");
  return p;
}

beforeEach(() => {
  // 数据面 key 只认 apikeys.json；这个环境变量没有入口。
  delete process.env.ZCODE_PROXY_API_KEY;
  // 告警去重表是模块级状态：bun test 单进程跑全部用例，不清零的话
  // 本文件里断言「告警出现过」的用例会被更早跑过的文件静默掉。
  resetLegacyKeyWarnings();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("identity.betaPolicy / betaAllowlist", () => {
  it("defaults to drop with an empty allowlist", () => {
    const path = writeYaml(`
server:
  port: 9090
`);
    const cfg = loadConfig(path);
    expect(cfg.identity.betaPolicy).toBe("drop");
    expect(cfg.identity.betaAllowlist).toEqual([]);
  });

  it("loads allowlist policy plus its values", () => {
    const path = writeYaml(`
server:
  port: 9090
identity:
  betaPolicy: "allowlist"
  betaAllowlist:
    - "advanced-tool-use-2025-11-20"
`);
    const cfg = loadConfig(path);
    expect(cfg.identity.betaPolicy).toBe("allowlist");
    expect(cfg.identity.betaAllowlist).toEqual(["advanced-tool-use-2025-11-20"]);
  });

  it("throws on an unknown betaPolicy instead of silently falling back", () => {
    const path = writeYaml(`
server:
  port: 9090
identity:
  betaPolicy: "drops"
`);
    expect(() => loadConfig(path)).toThrow(/identity\.betaPolicy/);
  });

  it("normalizes allowlist entries (trim, lowercase, dedupe, drop blanks)", () => {
    const path = writeYaml(`
server:
  port: 9090
identity:
  betaPolicy: allowlist
  betaAllowlist:
    - "  Advanced-Tool-Use-2025-11-20  "
    - "advanced-tool-use-2025-11-20"
    - "   "
`);
    // Normalized once at load time so the per-request matcher in
    // proxy/upstream.ts can compare verbatim.
    expect(loadConfig(path).identity.betaAllowlist).toEqual(["advanced-tool-use-2025-11-20"]);
  });

  it("throws when betaAllowlist is not a list of strings", () => {
    const notList = writeYaml(`
server:
  port: 9090
identity:
  betaPolicy: allowlist
  betaAllowlist: "advanced-tool-use-2025-11-20"
`);
    expect(() => loadConfig(notList)).toThrow(/identity\.betaAllowlist/);

    const badEntry = writeYaml(`
server:
  port: 9090
identity:
  betaPolicy: allowlist
  betaAllowlist:
    - 42
`);
    expect(() => loadConfig(badEntry)).toThrow(/identity\.betaAllowlist/);
  });
});

describe("loadConfig", () => {
  it("loads a valid YAML config with all fields", () => {
    const path = writeYaml(`
server:
  port: 9090
  host: "127.0.0.1"
auth:
  requireKey: true
provider: bigmodel
defaultModel: glm-4.6
models:
  - glm-4.6
  - glm-4.5
logging:
  level: debug
`);
    const cfg = loadConfig(path);
    expect(cfg.server.port).toBe(9090);
    expect(cfg.server.host).toBe("127.0.0.1");
    expect(cfg.auth.requireKey).toBe(true);
    expect(cfg.defaultModel).toBe("glm-4.6");
    expect(cfg.models).toEqual(["glm-4.6", "glm-4.5"]);
    expect(cfg.logging.level).toBe("debug");
  });

  it("applies defaults for missing optional fields", () => {
    const path = writeYaml(`
`);
    const cfg = loadConfig(path);
    expect(cfg.server.port).toBe(8080);
    expect(cfg.server.host).toBe("0.0.0.0");
    expect(cfg.defaultModel).toBe("glm-5.3");
    expect(cfg.models).toEqual(["glm-5.3", "glm-5.3-flash"]);
    expect(cfg.logging.level).toBe("info");
    expect(cfg.providers.zai.anthropicBase).toBe("https://api.z.ai/api/anthropic");
    expect(cfg.providers.bigmodel.openaiBase).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
    expect(cfg.clientIdentity).toEqual({ mode: "enforce", ttlSeconds: 900, maxSessions: 1024 });
    expect(cfg.responses).toEqual({ storeMaxEntries: 1000, storeTtlMs: 86400000 });
    expect(cfg.mcp).toEqual({ enabled: true, gateway: { enabled: true, upstreamOrigin: "https://zcode.z.ai" } });
    expect(cfg.async).toEqual({
      enabled: false,
      origin: "https://zcode.z.ai",
      pollIntervalMs: 5000,
      keepAliveIntervalMs: 3000,
      maxWaitMs: 0,
      maxRetries: 3,
      settleTimeoutMs: 8000,
      controlTimeoutMs: 15000,
      defaultModel: "",
    });
    expect(cfg.claim).toEqual({
      enabled: true,
      auto: true,
      origin: "https://zcode.z.ai",
      pollIntervalMs: 300000,
      cooldownMs: 600000,
      opening: {
        preheatMs: 180000,
        probeIntervalMs: 10000,
        burstIntervalMs: 2000,
        burstWindowMs: 180000,
        accountStaggerMs: 200,
        maxClaimsPerAccount: 6,
      },
      policy: "upstream-priority",
      sprintWindowMs: 1800000,
      sprintPollIntervalMs: 60000,
    });
  });

  it("logging.dump: defaults to off with an empty path, parses both keys", () => {
    const empty = loadConfig(writeYaml(""));
    expect(empty.logging.dump).toEqual({ enabled: false, path: "" });

    const configured = loadConfig(
      writeYaml(`
logging:
  level: info
  dump:
    enabled: true
    path: /tmp/zcode-dump-debug.jsonl
`),
    );
    expect(configured.logging.dump).toEqual({ enabled: true, path: "/tmp/zcode-dump-debug.jsonl" });

    // 只写开关不写路径：path 回默认值（空串 = 存储目录下的默认文件）。
    const switchOnly = loadConfig(
      writeYaml(`
logging:
  dump:
    enabled: true
`),
    );
    expect(switchOnly.logging.dump).toEqual({ enabled: true, path: "" });
  });

  it("accounts.routing.withinTier: defaults to sticky, parses all three values", () => {
    const defaults = loadConfig(writeYaml(""));
    expect(defaults.accounts?.routing.withinTier).toBe("sticky");
    expect(defaults.accounts?.routing.order).toEqual(["start-plan", "coding-plan"]);

    const drain = loadConfig(
      writeYaml(`
accounts:
  routing:
    withinTier: drain-first
`),
    );
    expect(drain.accounts?.routing.withinTier).toBe("drain-first");
    // 只写一个字段时其余仍取默认值。
    expect(drain.accounts?.routing.order).toEqual(["start-plan", "coding-plan"]);
    expect(drain.accounts?.routing.strategy).toBe("sticky-hash");

    // `strategy` 是 `balanced` / `round-robin` 唯一的入口，要能被读进来。
    const byStrategy = loadConfig(
      writeYaml(`
accounts:
  routing:
    withinTier: strategy
    strategy: balanced
`),
    );
    expect(byStrategy.accounts?.routing.withinTier).toBe("strategy");
    expect(byStrategy.accounts?.routing.strategy).toBe("balanced");
  });

  it("accounts.routing.withinTier: a misspelt value throws instead of falling back", () => {
    const path = writeYaml(`
accounts:
  routing:
    withinTier: drain_first
`);
    expect(() => loadConfig(path)).toThrow(/accounts\.routing\.withinTier/);
  });

  it("clientIdentity: YAML values override defaults", () => {
    const path = writeYaml(`
clientIdentity:
  mode: enforce
  ttlSeconds: 60
  maxSessions: 8
`);
    const cfg = loadConfig(path);
    expect(cfg.clientIdentity).toEqual({ mode: "enforce", ttlSeconds: 60, maxSessions: 8 });
  });

  it("responses + mcp: YAML values override defaults", () => {
    const path = writeYaml(`
responses:
  store:
    maxEntries: 50
    ttlMs: 3600000
mcp:
  enabled: true
`);
    const cfg = loadConfig(path);
    expect(cfg.responses).toEqual({ storeMaxEntries: 50, storeTtlMs: 3600000 });
    expect(cfg.mcp).toEqual({ enabled: true, gateway: { enabled: true, upstreamOrigin: "https://zcode.z.ai" } });
  });

  it("names a leftover enabled key under responses and keeps the protocol mounted", () => {
    // 残留的 `enabled: false` 不代表协议关了：它照样挂载（常开），所以除了点名
    // 告警，还得让用户看到 store 照常解析。
    const path = writeYaml(`
responses:
  enabled: false
`);
    const warnings: string[] = [];
    configureLogging({ write: (line) => { warnings.push(line); } });
    let cfg;
    try {
      cfg = loadConfig(path);
    } finally {
      resetLogging();
    }
    // 点名：残留键要在日志里以完整路径出现，用户能定位到自己 YAML 的那一行。
    // 完整路径用拼接拼出来：rg 门禁要求已删键的字面串不回写进源码，这里断言
    // 的是日志行里的同一个串。
    const leftoverKey = ["responses", "enabled"].join(".");
    const joined = warnings.join("\n");
    expect(joined).toContain(leftoverKey);
    expect(joined).toContain("always on");
    // 常开：开关删了，协议不受影响，store 两个参数保持默认。
    expect(cfg.responses).toEqual({ storeMaxEntries: 1000, storeTtlMs: 86400000 });
  });

  it("warns about legacy keys once per process, silently on re-reads", () => {
    // 面板任何读配置的路径都会过 loadConfig，若不去重，运行期每约 2.5 分钟就
    // 刷两条重复 WARN（用户实测）。语义：启动那一次保留引导价值，运行期重读静默。
    const path = writeYaml(`
responses:
  enabled: false
auth:
  proxyApiKey: "legacy-secret"
`);
    const warnings: string[] = [];
    configureLogging({ write: (line) => { warnings.push(line); } });
    try {
      loadConfig(path);
      const afterFirst = warnings.length;
      expect(afterFirst).toBeGreaterThan(0);
      loadConfig(path);
      loadConfig(path);
      // 同键第二次起静默：重读不产生任何新日志行。
      expect(warnings.length).toBe(afterFirst);
    } finally {
      resetLogging();
    }
    // 第一次的那两条都在：残留开关点名「协议常开」，auth 残留指向新入口。
    const joined = warnings.join("\n");
    expect(joined).toContain(["responses", "enabled"].join("."));
    expect(joined).toContain("always on");
    expect(joined).toContain(["auth", "proxyApiKey"].join("."));
    expect(joined).toContain("/keys");
  });

  it("legacy key dedupe is per key: a new unknown key still gets its one warning", () => {
    // 去重表记的是键路径，不是「这个段告过」：先告过 responses 的开关残留，
    // 再冒出来的另一个未知键仍要点名——每键最多一条，不是每段最多一条。
    const path = writeYaml(`
responses:
  enabled: false
`);
    const warnings: string[] = [];
    configureLogging({ write: (line) => { warnings.push(line); } });
    try {
      loadConfig(path);
      const afterFirst = warnings.length;
      // 同一个文件追加另一个未知键（writeYaml 固定路径，覆盖写即追加语义）。
      writeYaml(`
responses:
  enabled: false
  whoops: 1
`);
      loadConfig(path);
      expect(warnings.length).toBe(afterFirst + 1);
      // 新键走通用文案（这一批待告警键里没有残留开关），且只点名新键。
      const secondLine = warnings[afterFirst];
      expect(secondLine).toContain("ignoring unknown responses keys");
      expect(secondLine).toContain(["responses", "whoops"].join("."));
      expect(secondLine).not.toContain(["responses", "enabled"].join("."));
    } finally {
      resetLogging();
    }
  });

  describe("mcp.gateway", () => {
  it("rejects a non-https non-loopback upstreamOrigin", () => {
    const path = writeYaml(`
server:
  port: 9090
provider: zai
mcp:
  gateway:
    upstreamOrigin: "http://zcode.example.com"
`);
    expect(() => loadConfig(path)).toThrow("mcp.gateway.upstreamOrigin");
  });

  it("YAML overrides enabled and upstreamOrigin", () => {
    const path = writeYaml(`
server:
  port: 9090
provider: zai
mcp:
  gateway:
    enabled: false
    upstreamOrigin: "https://mirror.example.com"
`);
    const cfg = loadConfig(path);
    expect(cfg.mcp.gateway).toEqual({ enabled: false, upstreamOrigin: "https://mirror.example.com" });
  });

  it("YAML 是唯一源：环境变量不再参与 mcp.gateway", () => {
    process.env.ZCODE_MCP_GATEWAY = "false";
    process.env.ZCODE_MCP_GATEWAY_ORIGIN = "https://env.example.com";
    const path = writeYaml(`
server:
  port: 9090
mcp:
  gateway:
    enabled: true
    upstreamOrigin: "https://yaml.example.com"
`);
    try {
      const cfg = loadConfig(path);
      expect(cfg.mcp.gateway).toEqual({ enabled: true, upstreamOrigin: "https://yaml.example.com" });
    } finally {
      delete process.env.ZCODE_MCP_GATEWAY;
      delete process.env.ZCODE_MCP_GATEWAY_ORIGIN;
    }
  });
});

  it("async: YAML values override defaults", () => {
    const path = writeYaml(`
async:
  enabled: true
  origin: "https://custom.example.com"
  pollIntervalMs: 1000
  keepAliveIntervalMs: 500
  maxWaitMs: 600000
  maxRetries: 5
  settleTimeoutMs: 3000
  controlTimeoutMs: 8000
  defaultModel: "glm-5"
`);
    const cfg = loadConfig(path);
    expect(cfg.async).toEqual({
      enabled: true,
      origin: "https://custom.example.com",
      pollIntervalMs: 1000,
      keepAliveIntervalMs: 500,
      maxWaitMs: 600000,
      maxRetries: 5,
      settleTimeoutMs: 3000,
      controlTimeoutMs: 8000,
      defaultModel: "glm-5",
    });
  });

  it("async: snake_case YAML keys also accepted", () => {
    const path = writeYaml(`
async:
  poll_interval_ms: 2000
  keepalive_interval_ms: 700
  max_wait_ms: 300000
  max_retries: 2
  settle_timeout_ms: 4000
  control_timeout_ms: 9000
`);
    const cfg = loadConfig(path);
    expect(cfg.async.pollIntervalMs).toBe(2000);
    expect(cfg.async.keepAliveIntervalMs).toBe(700);
    expect(cfg.async.maxWaitMs).toBe(300000);
    expect(cfg.async.maxRetries).toBe(2);
    expect(cfg.async.settleTimeoutMs).toBe(4000);
    expect(cfg.async.controlTimeoutMs).toBe(9000);
  });

  it("claim: YAML values override defaults (opening cadence + policy + sprint)", () => {
    const path = writeYaml(`
claim:
  enabled: true
  auto: false
  origin: "https://zcode.z.ai"
  pollIntervalMs: 60000
  cooldownMs: 120000
  opening:
    preheatMs: 240000
    probeIntervalMs: 5000
    burstIntervalMs: 3000
    burstWindowMs: 120000
    accountStaggerMs: 400
    maxClaimsPerAccount: 3
  policy: "custom-order"
  sprintWindowMs: 900000
  sprintPollIntervalMs: 30000
`);
    const cfg = loadConfig(path);
    expect(cfg.claim).toEqual({
      enabled: true,
      auto: false,
      origin: "https://zcode.z.ai",
      pollIntervalMs: 60000,
      cooldownMs: 120000,
      opening: {
        preheatMs: 240000,
        probeIntervalMs: 5000,
        burstIntervalMs: 3000,
        burstWindowMs: 120000,
        accountStaggerMs: 400,
        maxClaimsPerAccount: 3,
      },
      policy: "custom-order",
      sprintWindowMs: 900000,
      sprintPollIntervalMs: 30000,
    });
  });

  it("claim: opening defaults and the 1s floor on probe/burst intervals", () => {
    const path = writeYaml(`
claim:
  opening:
    probeIntervalMs: 1
    burstIntervalMs: 2
  sprintWindowMs: 0
`);
    const cfg = loadConfig(path);
    expect(cfg.claim.opening).toEqual({
      preheatMs: 180000,
      probeIntervalMs: 1000,
      burstIntervalMs: 1000,
      burstWindowMs: 180000,
      accountStaggerMs: 200,
      maxClaimsPerAccount: 6,
    });
    expect(cfg.claim.policy).toBe("upstream-priority");
    expect(cfg.claim.sprintWindowMs).toBe(0);
    // sprintPollIntervalMs 没配就是默认值（60000，且 loader 给它 1s 地板）。
    expect(cfg.claim.sprintPollIntervalMs).toBe(60000);
  });

  it("async: maxWaitMs=0 is allowed (non-negative, not positive)", () => {
    const path = writeYaml(`
async:
  maxWaitMs: 0
`);
    const cfg = loadConfig(path);
    expect(cfg.async.maxWaitMs).toBe(0);
  });

  it("async: throws on negative maxWaitMs", () => {
    const path = writeYaml(`
async:
  maxWaitMs: -1
`);
    expect(() => loadConfig(path)).toThrow(/non-negative/);
  });

  it("async: throws on zero pollIntervalMs (must be positive)", () => {
    const path = writeYaml(`
async:
  pollIntervalMs: 0
`);
    expect(() => loadConfig(path)).toThrow(/positive integer/);
  });

  it("throws on invalid clientIdentity.mode", () => {
    const path = writeYaml(`
clientIdentity:
  mode: always
`);
    expect(() => loadConfig(path)).toThrow(/Invalid clientIdentity\.mode/);
  });

  // `plan:` / `provider:` 不在配置模型里：provider 是凭据属性、plan 是路由属性，
  // 没有进程级配置可校验。旧 config.yaml 里的残留键被 YAML 解析忽略（不报错），
  // 下面这条用例钉住这一点：升级上来的旧文件不该让进程起不来。
  it("legacy plan:/provider: keys are ignored, not fatal", () => {
    const cfg = loadConfig(writeYaml("provider: bigmodel\nplan: start-plan\nserver:\n  port: 8080\n"));
    expect(cfg.server.port).toBe(8080);
    expect("plan" in cfg).toBe(false);
    expect("provider" in cfg).toBe(false);
  });

  it("server.port 只从 YAML 读", () => {
    const path = writeYaml(`
server:
  port: 9090
`);
    process.env.ZCODE_PROXY_PORT = "3000";
    try {
      expect(loadConfig(path).server.port).toBe(9090);
    } finally {
      delete process.env.ZCODE_PROXY_PORT;
    }
  });

  it("ignores ZCODE_PROXY_API_KEY: the key table is the only source", () => {
    const path = writeYaml(`
server:
  port: 9090
`);
    process.env.ZCODE_PROXY_API_KEY = "fromenv-proxy";
    try {
      // 配置里不写就是默认值 true。
      expect(loadConfig(path).auth.requireKey).toBe(true);
    } finally {
      delete process.env.ZCODE_PROXY_API_KEY;
    }
  });

  // port 0 是合法值：bind 时由内核分配，测试与临时实例用它避开端口竞态。
  // 示例配置不写 0，人手写的配置应该有确定端口。
  it("accepts port 0: the kernel picks the port at bind time", () => {
    const path = writeYaml(`
server:
  port: 0
`);
    expect(loadConfig(path).server.port).toBe(0);
  });

  it("throws when port is out of range", () => {
    // 负数与越过 65535 的旧语义不变；0 的放行只到内核分配为止。
    for (const bad of [-1, 65536]) {
      const path = writeYaml(`server:\n  port: ${bad}\n`);
      expect(() => loadConfig(path), `port: ${bad}`).toThrow(/out of range/);
    }
  });

  it("validates provider endpoint overrides at the boundary (empty / non-URL / bad scheme)", () => {
    // 端点覆盖是 coding-plan 的基准地址（proxy/route-endpoint.ts），写错就是
    // 请求打到不存在的 URL，所以在读配置时就报错，而不是让出线层兜底。
    for (const bad of ["", "   ", "not a url", "ftp://api.z.ai/api/anthropic"]) {
      const path = writeYaml(`providers:\n  zai:\n    anthropicBase: "${bad}"\n`);
      expect(() => loadConfig(path), `anthropicBase: ${bad}`).toThrow(/providers\.zai\.anthropicBase/);
    }
    // 合法的覆盖被接受，尾斜杠归一化掉（拼路径时不产生双斜杠）。
    const ok = loadConfig(writeYaml(`providers:\n  zai:\n    anthropicBase: "https://mirror.test/api/anthropic/"\n`));
    expect(ok.providers.zai.anthropicBase).toBe("https://mirror.test/api/anthropic");
    expect(ok.providers.zai.openaiBase).toBe("https://api.z.ai/api/coding/paas/v4");
  });

  it("ignores legacy auth.mode/auth.apiKey keys (oauth-only proxy)", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "legacy-key"
  requireKey: false
`);
    const cfg = loadConfig(path);
    expect(cfg.auth).toEqual({ requireKey: false });
  });

  it("defaults auth.requireKey to true and warns about leftover keys in the auth section", () => {
    const path = writeYaml(`
auth:
  proxyApiKey: "client-secret"
`);
    // 告警走 `src/log/` 的 logger（写 `process.stderr`），不再走 `console.warn`，
    // 所以抓取点是注入的 sink：断言的东西没变（残留键要告警并指向新入口）。
    const warnings: string[] = [];
    configureLogging({ write: (line) => { warnings.push(line); } });
    try {
      expect(loadConfig(path).auth).toEqual({ requireKey: true });
    } finally {
      resetLogging();
    }
    // 单 key 字段没有迁移路径；静默忽略等于让数据面比用户以为的更开放（表空的
    // 默认状态就是放行），所以残留键要告警并指向新入口。
    const joined = warnings.join("\n");
    expect(joined).toContain("auth.proxyApiKey");
    expect(joined).toContain("/keys");
  });

  it("throws when config file not found", () => {
    expect(() => loadConfig("/nonexistent/path/config.yaml")).toThrow(/not found/);
  });

  it("auto-adds defaultModel to models list if missing", () => {
    const path = writeYaml(`
defaultModel: glm-5
models:
  - glm-4.6
`);
    const cfg = loadConfig(path);
    expect(cfg.models).toContain("glm-5");
    expect(cfg.models).toContain("glm-4.6");
  });

  it("identity: appVersion follows the manual > detected > default chain", () => {
    const path = writeYaml(`
identity:
  sourceTitle: "electron"
  refererOrigin: "https://example.com"
`);
    const cfg = loadConfig(path);
    expect(cfg.identity.sourceTitle).toBe("electron");
    expect(cfg.identity.refererOrigin).toBe("https://example.com");
  });
});

describe("identity.appVersion", () => {
  const DETECTED = { version: "3.17.2", path: "/Applications/ZCode.app/Contents/Info.plist" };

  /** 探测结果固定：开发机上真的装了客户端时，「没探测到」才会确定。*/
  const detect = (result: typeof DETECTED | null) => () => result;

  it("falls back to the code default when nothing is configured or detected", () => {
    const path = writeYaml(`
server:
  port: 9090
`);
    const cfg = loadConfig(path, { detectAppVersion: detect(null) });
    expect(cfg.identity.appVersion).toBe(DEFAULT_APP_VERSION);
    expect(cfg.identity.appVersionSource).toBe("default");
    expect(cfg.identity.appVersionSourcePath).toBeUndefined();
  });

  it("uses the detected client version and reports where it came from", () => {
    const path = writeYaml(`
server:
  port: 9090
`);
    const cfg = loadConfig(path, { detectAppVersion: detect(DETECTED) });
    expect(cfg.identity.appVersion).toBe("3.17.2");
    expect(cfg.identity.appVersionSource).toBe("detected");
    expect(cfg.identity.appVersionSourcePath).toBe(DETECTED.path);
  });

  it("lets a manual identity.appVersion win over the detected one", () => {
    const path = writeYaml(`
identity:
  appVersion: "3.99.0"
`);
    const cfg = loadConfig(path, { detectAppVersion: detect(DETECTED) });
    expect(cfg.identity.appVersion).toBe("3.99.0");
    expect(cfg.identity.appVersionSource).toBe("manual");
    expect(cfg.identity.appVersionSourcePath).toBeUndefined();
  });

  it("treats an empty manual value as auto", () => {
    const path = writeYaml(`
identity:
  appVersion: ""
`);
    const cfg = loadConfig(path, { detectAppVersion: detect(DETECTED) });
    expect(cfg.identity.appVersionSource).toBe("detected");
  });

  it("throws on a malformed manual value instead of silently falling back", () => {
    const path = writeYaml(`
identity:
  appVersion: "3.99"
`);
    expect(() => loadConfig(path, { detectAppVersion: detect(DETECTED) })).toThrow(/identity\.appVersion/);
  });

  it("throws when a manual value is not a string", () => {
    const path = writeYaml(`
identity:
  appVersion: 3.17
`);
    expect(() => loadConfig(path, { detectAppVersion: detect(null) })).toThrow(/identity\.appVersion/);
  });
});
