/**
 * Tests for `GET /api/state`'s payload builder.
 *
 * The subject is deliberately narrow: this module must **not** re-derive account
 * health, effective concurrency or routing policy — it calls the control
 * dispatcher and passes the answers through. So the tests assert pass-through
 * (`deep equal` against the dispatcher's own objects), the shape of the six
 * top-level sections, and that a failed command surfaces its stable error code
 * instead of a half-filled payload.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountSummary, ControlCommand, ControlResponse, RiskReport } from "../control/control.js";
import { DEFAULT_ACCOUNTS_ROUTING, DEFAULT_ACCOUNTS_STICKINESS } from "../accounts/routing.js";
import { DEFAULT_ACCOUNTS_RISK, type ProxyConfig } from "../config/types.js";
import { configureLogging, currentLogLevel, resetLogging } from "../log/index.js";
import { resetLegacyKeyWarnings } from "../config/loader.js";
import { dumpEnabled, setDumpConfig } from "../proxy/dump.js";
import { loadConfig } from "../config/loader.js";
import {
  INFLIGHT_HISTORY_CAPACITY,
  InflightHistory,
  createStateReader,
  credentialSourceCandidates,
  readSettings,
  scanCredentialSources,
  settingsConfigPath,
  writeSettings,
} from "./routes-state.js";
import pkg from "../../package.json" with { type: "json" };

const NOW = 1_700_000_000_000;

/** One account row, exactly as `listAccounts` reports it. */
function accountSummary(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    idPrefix: "a1b2c3d4e5f6",
    label: "main",
    kind: "zhipu-account",
    provider: "zai",
    routes: ["coding-plan"],
    enabled: true,
    weight: 1,
    maxConcurrency: 2,
    health: "ok",
    routeHealth: [{ route: "coding-plan", status: "ok" }],
    inflight: 1,
    quota: null,
    capabilityBlocks: [],
    planKinds: ["subscription"],
    hasApiKey: true,
    proxy: "direct",
    ...overrides,
  };
}

/** A risk report with no alerts (the six-question field shape). */
function riskReport(overrides: Partial<RiskReport> = {}): RiskReport {
  return {
    deviceMid: { accounts: 1, conflicts: [] },
    sessions: { bound: 0, capacity: 200, crossAccount: 0 },
    inflight: { total: 3, limit: 6, queueDepth: 0, perAccount: [{ label: "main", inflight: 3 }] },
    failures: [],
    alerts: [],
    ...overrides,
  };
}

/** Dispatcher whose four read-only commands answer the state contract shapes. */
function stateDispatcher(replies: Partial<Record<string, ControlResponse>> = {}): (
  cmd: ControlCommand,
) => Promise<ControlResponse> {
  return async (cmd: ControlCommand): Promise<ControlResponse> => {
    const override = replies[cmd.cmd];
    if (override) return override;
    switch (cmd.cmd) {
      case "status":
        return { ok: true, state: "running", accounts: 1, proxyPort: 8091, loggedIn: true };
      case "listAccounts":
        return { ok: true, event: "accounts", accounts: [accountSummary()] };
      case "getRoutingPolicy":
        return {
          ok: true,
          event: "routingPolicy",
          routing: DEFAULT_ACCOUNTS_ROUTING,
          stickiness: DEFAULT_ACCOUNTS_STICKINESS,
          risk: DEFAULT_ACCOUNTS_RISK,
        };
      case "getRiskReport":
        return { ok: true, event: "riskReport", report: riskReport() };
      default:
        return { ok: false, error: "unknown_cmd" };
    }
  };
}

function reader(replies: Partial<Record<string, ControlResponse>> = {}, history?: InflightHistory) {
  return createStateReader(stateDispatcher(replies), { now: () => NOW, version: "9.9.9", ...(history ? { history } : {}) });
}

describe("createStateReader — payload", () => {
  it("answers the six sections of the state contract", async () => {
    const result = await reader().read();
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);

    expect(Object.keys(result.state).sort()).toEqual(
      ["accounts", "metrics", "risk", "routing", "server", "stickiness"].sort(),
    );
    expect(result.state.server).toEqual({ port: 8091, version: "9.9.9", uptime: expect.any(Number) });
    expect(result.state.server.uptime).toBeGreaterThanOrEqual(0);
    expect(result.state.metrics.sampledAt).toBe(NOW);
    // `risk` 段同时带告警（算出来的）与开关（配置里的）。
    expect(result.state.risk).toEqual({ alerts: [], policy: DEFAULT_ACCOUNTS_RISK });
  });

  it("passes accounts, routing, stickiness and alerts through unchanged", async () => {
    const accounts = [accountSummary({ label: "second", health: "cooling", inflight: 0 })];
    const alerts: RiskReport["alerts"] = ["account_cooling", "concurrency_above_r11"];
    const result = await createStateReader(
      stateDispatcher({
        listAccounts: { ok: true, event: "accounts", accounts },
        getRiskReport: { ok: true, event: "riskReport", report: riskReport({ alerts }) },
      }),
      { now: () => NOW, version: "9.9.9" },
    ).read();

    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(result.state.accounts).toEqual(accounts);
    expect(result.state.risk.alerts).toEqual(alerts);
    expect(result.state.routing).toEqual(DEFAULT_ACCOUNTS_ROUTING);
    expect(result.state.stickiness).toEqual(DEFAULT_ACCOUNTS_STICKINESS);
  });

  it("passes the status command's port through unchanged", async () => {
    const result = await createStateReader(
      stateDispatcher({
        status: { ok: true, state: "running", accounts: 1, proxyPort: 0, loggedIn: true },
      }),
      { now: () => NOW, version: "9.9.9" },
    ).read();

    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    /* 没有 `running` 可以推导了：`serve` 形态下这份载荷只可能来自正在跑的代理，
       端口照原样转出去。 */
    expect(result.state.server.port).toBe(0);
    expect(Object.keys(result.state.server).sort()).toEqual(["port", "uptime", "version"]);
  });

  it("takes the global concurrency numbers from the risk report", async () => {
    const result = await createStateReader(
      stateDispatcher({
        getRiskReport: {
          ok: true,
          event: "riskReport",
          report: riskReport({ inflight: { total: 5, limit: 8, queueDepth: 2, perAccount: [] } }),
        },
      }),
      { now: () => NOW, version: "9.9.9" },
    ).read();

    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(result.state.metrics.inflight).toBe(5);
    expect(result.state.metrics.concurrencyLimit).toBe(8);
    expect(result.state.metrics.queueDepth).toBe(2);
  });

  it("defaults the version to the packaged one", async () => {
    const result = await createStateReader(stateDispatcher(), { now: () => NOW }).read();
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(result.state.server.version).toBe(pkg.version);
  });
});

describe("createStateReader — failures", () => {
  const cases: [string, ControlResponse][] = [
    ["status", { ok: false, error: "internal_error: status" }],
    ["listAccounts", { ok: false, error: "account_control_unavailable" }],
    ["getRoutingPolicy", { ok: false, error: "routing_control_unavailable" }],
    ["getRiskReport", { ok: false, error: "account_control_unavailable" }],
  ];

  for (const [command, reply] of cases) {
    it(`surfaces the \`${command}\` error code instead of a half-filled payload`, async () => {
      const result = await reader({ [command]: reply }).read();
      expect(result).toEqual({ ok: false, error: (reply as { error: string }).error });
    });
  }

  it("records no sample when the read fails", async () => {
    const history = new InflightHistory();
    const result = await createStateReader(
      stateDispatcher({ getRiskReport: { ok: false, error: "account_control_unavailable" } }),
      { now: () => NOW, history },
    ).read();
    expect(result.ok).toBe(false);
    expect(history.snapshot()).toEqual([]);
  });
});

describe("createStateReader — claim segment", () => {
  it("carries the claim overview when the dispatcher answers getClaimOverview", async () => {
    const overview: ControlResponse = {
      ok: true,
      event: "claimOverview",
      config: {
        enabled: true,
        auto: true,
        origin: "https://zcode.test",
        pollIntervalMs: 300000,
        cooldownMs: 600000,
        sprintWindowMs: 1800000,
        sprintPollIntervalMs: 60000,
        policy: "upstream-priority",
        opening: {
          preheatMs: 180000,
          probeIntervalMs: 10000,
          burstIntervalMs: 2000,
          burstWindowMs: 180000,
          accountStaggerMs: 200,
          maxClaimsPerAccount: 6,
        },
      },
      accounts: [{ label: "work", running: true, holdUntil: 555 }],
    };
    const result = await reader({ getClaimOverview: overview }).read();
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(result.state.claim).toEqual({ config: overview.config, accounts: overview.accounts });
  });

  it("omits the claim segment when the host has no claim control (not an error)", async () => {
    const result = await reader().read();
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    // 默认 dispatcher 不认识 getClaimOverview（unknown_cmd）——那是「没接」，不是失败。
    expect(result.state.claim).toBeUndefined();
  });

  it("omits the claim segment when the hook answers claim_unavailable", async () => {
    const result = await reader({ getClaimOverview: { ok: false, error: "claim_unavailable" } }).read();
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(result.state.claim).toBeUndefined();
  });
});

describe("createStateReader — inflight history", () => {
  it("appends one sample per read and keeps the timestamps", async () => {
    let clock = NOW;
    const history = new InflightHistory();
    const read = createStateReader(stateDispatcher(), { now: () => clock, history }).read;

    await read();
    clock += 5_000;
    await read();

    expect(history.snapshot()).toEqual([
      { at: NOW, inflight: 3 },
      { at: NOW + 5_000, inflight: 3 },
    ]);
  });

  it("returns the accumulated history in every payload", async () => {
    const history = new InflightHistory();
    const read = createStateReader(stateDispatcher(), { now: () => NOW, history }).read;
    await read();
    const second = await read();

    if (!second.ok) throw new Error(`expected ok, got ${second.error}`);
    expect(second.state.metrics.inflightHistory).toHaveLength(2);
    expect(second.state.metrics.inflightHistory[0]).toEqual({ at: NOW, inflight: 3 });
  });
});

describe("InflightHistory", () => {
  it("drops the oldest sample once the capacity is reached", () => {
    const history = new InflightHistory(2);
    history.record(1, 10);
    history.record(2, 20);
    history.record(3, 30);

    expect(history.snapshot()).toEqual([
      { at: 2, inflight: 20 },
      { at: 3, inflight: 30 },
    ]);
  });

  it("hands out a copy, so callers cannot mutate the buffer", () => {
    const history = new InflightHistory();
    history.record(1, 10);
    const snapshot = history.snapshot();
    snapshot.push({ at: 2, inflight: 20 });
    snapshot[0]!.inflight = 99;

    expect(history.snapshot()).toEqual([{ at: 1, inflight: 10 }]);
  });

  it("defaults to the five-minute window the page polls at", () => {
    expect(INFLIGHT_HISTORY_CAPACITY).toBe(60);
    const history = new InflightHistory();
    for (let i = 0; i < INFLIGHT_HISTORY_CAPACITY + 5; i++) history.record(i, i);
    expect(history.snapshot()).toHaveLength(INFLIGHT_HISTORY_CAPACITY);
  });
});

/* ------------------------------------------------------------------------- */
/* 本机认证文件发现                                                           */
/* ------------------------------------------------------------------------- */

/** `zcodejwttoken` 形状的 OAuth access token（与 `auth/import.test.ts` 同一份样本）。*/
const OAUTH_ACCESS_TOKEN = (() => {
  const b64url = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf-8")
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({
    customer_id: 5241463,
    user_channel: "WEB",
    user_id: 5241463,
    user_key: "k3y",
    user_type: "PERSONAL",
    username: "someone",
  })}.c2ln`;
})();

describe("credentialSourceCandidates", () => {
  it("lists the credential candidates in order and de-duplicates them", () => {
    const candidates = credentialSourceCandidates({}, "/home/someone");
    expect(candidates[0]).toBe(join(homedir(), ".zcode", "v2", "credentials.json"));
    expect(candidates).toContain(join("/home/someone", ".zcode", "credentials.json"));
    expect(candidates).toContain(join("/home/someone", ".config", "zcode", "credentials.json"));
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("puts an explicit ZCODE_DATA_BASE_DIR first", () => {
    const candidates = credentialSourceCandidates({ ZCODE_DATA_BASE_DIR: "/custom/base" }, "/home/someone");
    expect(candidates[0]).toBe(join("/custom/base", "credentials.json"));
  });

  it("only lists %APPDATA% candidates when the variable is set (Windows)", () => {
    expect(credentialSourceCandidates({}, "/home/someone").some((path) => path.includes("AppData"))).toBe(false);
    const withAppData = credentialSourceCandidates({ APPDATA: "/home/someone/AppData/Roaming" }, "/home/someone");
    expect(withAppData).toContain(join("/home/someone/AppData/Roaming", "ZCode", "credentials.json"));
  });
});

describe("scanCredentialSources", () => {
  let dir = "";

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("reports a readable, parsable file as valid with its provider", () => {
    dir = mkdtempSync(join(tmpdir(), "zcode-scan-"));
    const path = join(dir, "credentials.json");
    writeFileSync(path, JSON.stringify({ "oauth:bigmodel:access_token": OAUTH_ACCESS_TOKEN }));

    const [source] = scanCredentialSources({ ZCODE_DATA_BASE_DIR: dir }, dir);
    expect(source).toEqual({ path, valid: true, provider: "bigmodel" });
  });

  it("reports a malformed file as invalid without echoing its content", () => {
    dir = mkdtempSync(join(tmpdir(), "zcode-scan-"));
    const path = join(dir, "credentials.json");
    writeFileSync(path, "{ not json at all");

    const [source] = scanCredentialSources({ ZCODE_DATA_BASE_DIR: dir }, dir);
    expect(source).toEqual({ path, valid: false, error: "file_malformed" });
  });

  it("reports a missing file as unreadable", () => {
    dir = mkdtempSync(join(tmpdir(), "zcode-scan-"));
    const [source] = scanCredentialSources({ ZCODE_DATA_BASE_DIR: dir }, dir);
    expect(source?.valid).toBe(false);
    expect(source?.error).toBe("file_unreadable");
  });

  it("covers every candidate so the panel can list them all", () => {
    dir = mkdtempSync(join(tmpdir(), "zcode-scan-"));
    const sources = scanCredentialSources({ ZCODE_DATA_BASE_DIR: dir }, dir);
    expect(sources.length).toBe(credentialSourceCandidates({ ZCODE_DATA_BASE_DIR: dir }, dir).length);
    expect(new Set(sources.map((source) => source.path)).size).toBe(sources.length);
  });
});

/* ------------------------------------------------------------------------- */
/* 设置面：配置文件路径的解析                                               */
/* ------------------------------------------------------------------------- */

describe("settingsConfigPath", () => {
  it("prefers the injected path over env and the default", () => {
    // 注入值就是 serve 已经解析好的那条（位置参数 > env > 默认），面板不再重算。
    expect(settingsConfigPath({ ZCODE_PROXY_CONFIG: "/etc/zcode.yaml" }, "/srv/my.yaml")).toBe("/srv/my.yaml");
  });

  it("keeps the env override when nothing is injected", () => {
    expect(settingsConfigPath({ ZCODE_PROXY_CONFIG: " /etc/zcode.yaml " })).toBe("/etc/zcode.yaml");
  });

  it("falls back to config.yaml and ignores blank inputs", () => {
    expect(settingsConfigPath({})).toBe("config.yaml");
    expect(settingsConfigPath({ ZCODE_PROXY_CONFIG: "  " }, "  ")).toBe("config.yaml");
  });
});

/* ------------------------------------------------------------------------- */
/* 设置面：配置文件的读写                                                     */
/* ------------------------------------------------------------------------- */

/**
 * 设置面读写的测试。
 *
 * 每个用例用自己的一份临时 `config.yaml`（`ZCODE_PROXY_CONFIG` 之外显式传路径），
 * 断言的是**文件本身**：注释还在、键顺序没被重排、写坏了会回滚。这些是"设置页
 * 不只是把值塞进内存"的全部证据。
 */
describe("settings store", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  /** 写一份最小可用的 config.yaml；返回路径。*/
  function configFile(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "zcode-settings-"));
    dirs.push(dir);
    const path = join(dir, "config.yaml");
    writeFileSync(path, body, "utf8");
    return path;
  }

  const MINIMAL = `# 用户自己的注释：不要被设置页吃掉
server:
  port: 8080
  host: "127.0.0.1"
defaultModel: glm-5.3 # 行尾注释也要保住
`;

  it("reads every group from the config file", () => {
    const path = configFile(MINIMAL);
    const result = readSettings(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.settings.configPath).toBe(path);
    expect(result.settings.connection.defaultModel).toBe("glm-5.3");
    expect(result.settings.connection.mode).toBe("enforce");
    // dump：没配就是关，路径是空串（= 存储目录默认值）。
    expect(result.settings.subsystems.dumpEnabled).toBe(false);
    expect(result.settings.subsystems.dumpPath).toBe("");
    expect(result.settings.subsystems.quotaPollSeconds).toBe(300);
    expect(result.settings.subsystems.quotaDrainThreshold).toBe(1);
    expect(result.settings.security).toEqual({ port: 8080, host: "127.0.0.1", requireKey: true });
    expect(result.settings.identity.appVersion.length).toBeGreaterThan(0);
  });

  it("reads logging.dump from the config file and writes it back", () => {
    const path = configFile(`${MINIMAL}logging:
  level: info
  dump:
    enabled: true
    path: /tmp/zcode-dump-debug.jsonl
`);

    const read = readSettings(path);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.settings.subsystems.dumpEnabled).toBe(true);
    expect(read.settings.subsystems.dumpPath).toBe("/tmp/zcode-dump-debug.jsonl");

    // 写回：开关写到 logging.dump.enabled，注释仍然是用户的
    const written = writeSettings({ subsystems: { dumpEnabled: false } }, { path });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.settings.subsystems.dumpEnabled).toBe(false);
    expect(written.settings.subsystems.dumpPath).toBe("/tmp/zcode-dump-debug.jsonl");
    expect(readFileSync(path, "utf8")).toContain("enabled: false");
    expect(readFileSync(path, "utf8")).toContain("path: /tmp/zcode-dump-debug.jsonl");
  });

  it("rejects a non-boolean dumpEnabled without touching the file", () => {
    const path = configFile(MINIMAL);
    expect(writeSettings({ subsystems: { dumpEnabled: "yes" as never } }, { path })).toEqual({
      ok: false,
      error: "invalid_setting",
    });
    expect(readFileSync(path, "utf8")).toBe(MINIMAL);
  });

  it("reports a missing file and a malformed one with different codes", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-settings-"));
    dirs.push(dir);
    expect(readSettings(join(dir, "nope.yaml"))).toEqual({ ok: false, error: "config_missing" });

    const broken = configFile("server: [unclosed\n  port: oops\n");
    expect(readSettings(broken)).toEqual({ ok: false, error: "config_invalid" });
  });

  it("round-trips every writable group and keeps the user's comments", () => {
    const path = configFile(MINIMAL);

    const written = writeSettings(
      {
        defaultModel: "glm-5.3-flash",
        connection: { mode: "observe", ttlSeconds: 600, maxSessions: 256 },
        subsystems: {
          highspeed: false,
          mcp: false,
          async: true,
          claim: false,
          quotaPollSeconds: 120,
          quotaDrainThreshold: 0.85,
        },
        security: { port: 9090 },
      },
      { path },
    );
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    // 返回的快照就是写完后的真值（页面直接拿它重画）
    expect(written.settings.connection).toEqual({
      defaultModel: "glm-5.3-flash",
      mode: "observe",
      ttlSeconds: 600,
      maxSessions: 256,
      // 补丁没给 reasoning 键时保持原值（这份模板里 reasoning 段是默认值）。
      reasoningMode: "passthrough",
      reasoningEffort: "high",
    });
    expect(written.settings.subsystems).toEqual({
      highspeed: false,
      mcp: false,
      async: true,
      claim: false,
      dumpEnabled: false,
      dumpPath: "",
      quotaPollSeconds: 120,
      quotaDrainThreshold: 0.85,
    });
    expect(written.settings.security.port).toBe(9090);
    expect(written.settings.security.host).toBe("127.0.0.1");

    // 注释与键顺序是用户的文件：一次设置不该把它重排
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# 用户自己的注释：不要被设置页吃掉");
    expect(text).toContain("# 行尾注释也要保住");
  });

  it("removes the two legacy keys on save, keeping comments and other settings", () => {
    const path = configFile(`${MINIMAL}responses:
  enabled: false # 4.x 的灰度开关，残留
  store:
    maxEntries: 50
auth:
  proxyApiKey: "legacy-secret"
  requireKey: false
`);

    // 自愈闭环：保存时剔除残留键，写后的重读不再告警——捕获整个保存窗口
    // 的日志，断言没有 WARN 也没有其它杂音（info 的收尾叙事在 keys 非空时恰好一条）。
    resetLegacyKeyWarnings();
    const logLines: string[] = [];
    configureLogging({ write: (line) => { logLines.push(line); } });
    let written: ReturnType<typeof writeSettings>;
    try {
      written = writeSettings({ security: { port: 9091 } }, { path });
    } finally {
      resetLogging();
    }
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    const text = readFileSync(path, "utf8");
    const legacySwitch = ["responses", "enabled"].join(".");
    const legacyAuthKey = ["auth", "proxyApiKey"].join(".");
    // 两键消失（源文件里不再有键名；被删键自己的行尾注释随键一起走，
    // 不留孤儿——yaml Document 的删除语义，见 removeLegacyConfigPaths）
    expect(text).not.toContain("proxyApiKey");
    expect(text).not.toContain(`${legacySwitch}:`);
    expect(text).not.toContain("# 4.x 的灰度开关，残留");
    // 合法键原样：store 调优参数、requireKey 开关都不是残留
    expect(text).toContain("maxEntries: 50");
    expect(text).toContain("requireKey: false");
    // 别的注释与既有设置不动
    expect(text).toContain("# 用户自己的注释：不要被设置页吃掉");
    expect(text).toContain("defaultModel: glm-5.3");
    // 本次返回的快照正常（页面直接重画）
    expect(written.settings.security.port).toBe(9091);
    expect(written.settings.security.requireKey).toBe(false);
    expect(written.settings.subsystems.dumpEnabled).toBe(false);
    // 收尾叙事：INFO 一条，点名被删的两个键。（保存窗口里的两条 WARN 来自
    // 写盘**前**的 readSettings——本测试重置过去重表，那是该键的第一读；
    // 生产里启动那次读已用掉每键一次的预算，保存窗口不再出 WARN。）
    const joined = logLines.join("\n");
    expect(joined).toContain("removed legacy config keys while saving");
    expect(joined).toContain(legacySwitch);
    expect(joined).toContain(legacyAuthKey);
    expect(joined).toContain("INFO");

    // 自愈闭环：保存之后再读配置（面板的下一次快照 / 重载），不再有这两条 WARN。
    resetLegacyKeyWarnings();
    const afterLines: string[] = [];
    configureLogging({ write: (line) => { afterLines.push(line); } });
    try {
      const reread = readSettings(path);
      expect(reread.ok).toBe(true);
    } finally {
      resetLogging();
    }
    expect(afterLines.join("\n")).not.toContain("WARN");
    expect(afterLines.join("\n")).not.toContain("always on");
  });

  it("a save on a clean config removes nothing and logs no removal", () => {
    // 反向：文件里没有残留键时，保存是纯保存——不加行、不打收尾日志。
    const before = `${MINIMAL}responses:
  store:
    maxEntries: 50
`;
    const path = configFile(before);
    const logLines: string[] = [];
    configureLogging({ write: (line) => { logLines.push(line); } });
    let written: ReturnType<typeof writeSettings>;
    try {
      written = writeSettings({ security: { port: 9091 } }, { path });
    } finally {
      resetLogging();
    }
    expect(written.ok).toBe(true);
    expect(logLines.join("\n")).not.toContain("removed legacy config keys");
    // 除补丁字段外，文件逐字不变
    expect(readFileSync(path, "utf8")).toContain("maxEntries: 50");
    expect(readFileSync(path, "utf8")).not.toContain("removed legacy");
  });

  it("writes the reasoning section and reads it back (mode + effort)", () => {
    const path = configFile(MINIMAL);
    const written = writeSettings(
      { connection: { reasoningMode: "override", reasoningEffort: "low" } },
      { path },
    );
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.settings.connection.reasoningMode).toBe("override");
    expect(written.settings.connection.reasoningEffort).toBe("low");
    // 落盘的键与用户注释都原样（setIn 新建顶层段不重排既有键）
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# 用户自己的注释：不要被设置页吃掉");
    expect(text).toContain("mode: override");
    expect(text).toContain("effort: low");
    // 重读（面板下一次快照的路径）拿回同样的值
    const reread = readSettings(path);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.settings.connection.reasoningMode).toBe("override");
    expect(reread.settings.connection.reasoningEffort).toBe("low");
  });

  it("writing the effort alone lands one key; mode falls back at read time", () => {
    const path = configFile(MINIMAL);
    const written = writeSettings({ connection: { reasoningEffort: "max" } }, { path });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(readFileSync(path, "utf8")).toContain("effort: max");
    expect(readFileSync(path, "utf8")).not.toContain("mode: override");
    // 段里没写 mode 时 loadConfig 的缺省是 passthrough（仅存不参与逻辑）
    expect(written.settings.connection.reasoningMode).toBe("passthrough");
    expect(written.settings.connection.reasoningEffort).toBe("max");
  });

  it("rejects an out-of-enum reasoningMode / reasoningEffort without touching the file", () => {
    const path = configFile(MINIMAL);
    expect(writeSettings({ connection: { reasoningMode: "bogus" as never } }, { path })).toEqual({
      ok: false,
      error: "invalid_setting",
    });
    expect(writeSettings({ connection: { reasoningEffort: "medium" as never } }, { path })).toEqual({
      ok: false,
      error: "invalid_setting",
    });
    expect(readFileSync(path, "utf8")).toBe(MINIMAL);
  });

  it("round-trips identity.appVersion and reports where the value came from", () => {
    const path = configFile(MINIMAL);

    /* 手写：写的是 `x.y.z`，快照回报 manual */
    const manual = writeSettings({ identity: { appVersion: "3.99.0" } }, { path });
    expect(manual.ok).toBe(true);
    if (!manual.ok) return;
    expect(manual.settings.identity.appVersion).toBe("3.99.0");
    expect(manual.settings.identity.appVersionSource).toBe("manual");
    expect(readFileSync(path, "utf8")).toContain("appVersion: 3.99.0");

    /* 清空：退回自动（探测或默认），不是回到上次的手写值 */
    const cleared = writeSettings({ identity: { appVersion: "" } }, { path });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.settings.identity.appVersionSource).not.toBe("manual");
    expect(cleared.settings.identity.appVersion).not.toBe("3.99.0");
  });

  it("rejects a malformed identity.appVersion instead of writing it", () => {
    const path = configFile(MINIMAL);
    expect(writeSettings({ identity: { appVersion: "3.99" } }, { path })).toEqual({
      ok: false,
      error: "invalid_setting",
    });
    expect(readFileSync(path, "utf8")).toBe(MINIMAL);
  });

  it("writes the requireKey switch and echoes the resolved boolean", () => {
    const path = configFile(MINIMAL);
    const written = writeSettings({ security: { requireKey: false } }, { confirm: true, path });
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    // 快照回的是生效值（布尔），不是 key 原文：key 本身在 apikeys.json。
    expect(written.settings.security.requireKey).toBe(false);
    expect(readFileSync(path, "utf8")).toContain("requireKey: false");
  });

  it("requires a second confirmation for the two L3 fields", () => {
    const path = configFile(MINIMAL);

    // 绑定到非回环：没有 confirm 就不写
    expect(writeSettings({ security: { host: "0.0.0.0" } }, { path })).toEqual({
      ok: false,
      error: "confirmation_required",
    });
    expect(readSettings(path).ok && readSettings(path)).toMatchObject({ settings: { security: { host: "127.0.0.1" } } });

    // 带上确认就写
    const confirmed = writeSettings({ security: { host: "0.0.0.0" } }, { confirm: true, path });
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) expect(confirmed.settings.security.host).toBe("0.0.0.0");

    // 数据面鉴权开关同样要确认（关掉它是安全降级）
    expect(writeSettings({ security: { requireKey: false } }, { path })).toEqual({
      ok: false,
      error: "confirmation_required",
    });

    // 值没变就不是 L3：再写一次同样的 true 不需要确认
    expect(writeSettings({ security: { requireKey: true } }, { path }).ok).toBe(true);

    // 回环地址不是 L3：改它不需要确认
    expect(writeSettings({ security: { host: "localhost" } }, { path }).ok).toBe(true);
  });

  it("rejects invalid values without touching the file", () => {
    const path = configFile(MINIMAL);
    const before = readFileSync(path, "utf8");

    const cases = [
      { defaultModel: "   " },
      { connection: { mode: "nope" as never } },
      { connection: { ttlSeconds: 0 } },
      { connection: { maxSessions: -1 } },
      { subsystems: { highspeed: "yes" as never } },
      { subsystems: { quotaPollSeconds: 1.5 } },
      { subsystems: { quotaDrainThreshold: 0 } },
      { security: { port: 70_000 } },
      { security: { host: "  " } },
      { security: { requireKey: "yes" as never } },
    ];
    for (const patch of cases) {
      expect([patch, writeSettings(patch, { path }).ok]).toEqual([patch, false]);
    }
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses a file that would not load, leaving file and memory untouched", () => {
    // 一份能解析、但 `loadConfig` 会拒的配置：`clientIdentity.mode` 是脏值。
    // 补丁本身完全合法，坏的是文件里**别的**那一行 —— 写盘前的那次整份重读就
    // 会拒掉，直接返回 `config_invalid`：文件不动，内存也不动。
    const path = configFile(`server:
  port: 8080
clientIdentity:
  mode: enforce
`);
    const before = readFileSync(path, "utf8");

    // 直接写一个合法补丁：应当成功
    expect(writeSettings({ security: { port: 8081 } }, { path }).ok).toBe(true);
    // 恢复原文件后，人为破坏一行：预写校验拦下，文件保持用户手上的样子
    writeFileSync(path, before.replace("mode: enforce", "mode: broken"), "utf8");
    const broken = readFileSync(path, "utf8");
    const result = writeSettings({ security: { port: 8082 } }, { path });
    expect(result).toEqual({ ok: false, error: "config_invalid" });
    expect(readFileSync(path, "utf8")).toBe(broken);
  });
});

/* ------------------------------------------------------------------------- */
/* 写盘后的热重载                                                              */
/* ------------------------------------------------------------------------- */

describe("settings hot reload", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    // dump 快照是进程级单例：动过它的用例必须清干净。
    setDumpConfig(null);
    resetLogging();
  });

  /** 写一份最小可用的 config.yaml；返回路径。*/
  function configFile(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "zcode-hot-reload-"));
    dirs.push(dir);
    const path = join(dir, "config.yaml");
    writeFileSync(path, body, "utf8");
    return path;
  }

  /**
   * 进程内生效的那份配置（bootstrap 持有物的替身）。
   *
   * 直接用 `loadConfig` 从同一份 YAML 读：手写字面量要么少段（与 reload 出来的
   * 比对处处不等），要么漂移。生产路径里 bootstrap 持有的也是 loadConfig 的产物。
   */
  function activeConfig(path: string): ProxyConfig {
    return loadConfig(path);
  }

  const HOT_YAML = `server:
  port: 8080
  host: "127.0.0.1"
auth:
  requireKey: true
defaultModel: glm-5.3
highspeed:
  enabled: true
  origin: "https://zcode.z.ai"
  models:
    - glm-5.3
async:
  enabled: false
logging:
  level: info
`;

  it("applies an A-class change to the in-memory config and reports it", () => {
    const path = configFile(HOT_YAML);
    const memory = activeConfig(path);

    const result = writeSettings({ subsystems: { highspeed: false } }, { path, activeConfig: memory });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 内存立刻是新值：下一次请求读到的就是它（A 类）。
    expect(memory.highspeed.enabled).toBe(false);
    expect(result.reloaded).toEqual(["highspeed"]);
    expect(result.restartRequired).toEqual([]);
  });

  it("keeps the C-class server segment in memory and reports restart_required", () => {
    const path = configFile(HOT_YAML);
    const memory = activeConfig(path);

    const result = writeSettings({ security: { port: 9090 } }, { path, activeConfig: memory });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 内存保留旧端口：页面显示 9090 的话监听还是 8080，比不更新更糟（C 类）。
    expect(memory.server.port).toBe(8080);
    expect(result.reloaded).toEqual([]);
    expect(result.restartRequired).toEqual(["server.port"]);
    // 文件确实写进去了：重启后随新配置起监听。
    expect(readFileSync(path, "utf8")).toContain("9090");
  });

  it("keeps memory untouched when the file fails validation", () => {
    const path = configFile(HOT_YAML);
    const memory = activeConfig(path);
    // 文件在写补丁之前就是坏的：预写校验拦下，内存与文件都不动。
    writeFileSync(path, "server:\n  port: [unclosed\n", "utf8");
    const before = readFileSync(path, "utf8");

    const result = writeSettings({ subsystems: { mcp: false } }, { path, activeConfig: memory });
    expect(result).toEqual({ ok: false, error: "config_invalid" });
    expect(memory.mcp.enabled).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("stops the highspeed table when a B-class segment changes", () => {
    const path = configFile(HOT_YAML);
    const memory = activeConfig(path);
    const stopped: string[] = [];

    const result = writeSettings(
      { identity: { appVersion: "3.99.0" } },
      { path, activeConfig: memory, reloadHooks: { stopHighspeed: () => stopped.push("highspeed") } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // identity 段热生效：单例的 key 判断会在下次使用时重建。
    expect(memory.identity.appVersion).toBe("3.99.0");
    expect(result.reloaded).toEqual(["identity"]);
    // B 类收尾：卡槽表持有定时器，key 变了旧循环不会自己停，显式停一次。
    expect(stopped).toEqual(["highspeed"]);
  });

  it("does not stop highspeed for an A-class change", () => {
    const path = configFile(HOT_YAML);
    const memory = activeConfig(path);
    let stopped = 0;

    const result = writeSettings(
      { subsystems: { claim: false } },
      { path, activeConfig: memory, reloadHooks: { stopHighspeed: () => (stopped += 1) } },
    );
    expect(result.ok).toBe(true);
    expect(stopped).toBe(0);
  });

  it("restarts the claim schedulers when the claim segment changes (B 类收尾)", () => {
    const path = configFile(HOT_YAML);
    const memory = activeConfig(path);
    const restarted: number[] = [];

    const result = writeSettings(
      { subsystems: { claim: false } },
      { path, activeConfig: memory, reloadHooks: { restartClaim: () => restarted.push(1) } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // claim 段热生效进内存（A/B 类），同时收尾重启 schedulers。
    expect(result.reloaded).toEqual(["claim"]);
    expect(restarted).toEqual([1]);
  });

  it("does not restart claim schedulers for an unrelated change", () => {
    const path = configFile(HOT_YAML);
    const memory = activeConfig(path);
    let restarted = 0;

    const result = writeSettings(
      { subsystems: { mcp: false } },
      { path, activeConfig: memory, reloadHooks: { restartClaim: () => (restarted += 1) } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reloaded).toEqual(["mcp"]);
    expect(restarted).toBe(0);
  });

  it("refreshes the dump snapshot when logging.dump changes", () => {
    const path = configFile(HOT_YAML);
    const memory = activeConfig(path);
    // 启动快照是关（bootstrap 灌进去的那份），YAML 里也是关：一致，不重灌。
    setDumpConfig({ enabled: false, path: "" });
    expect(dumpEnabled()).toBe(false);

    // 写入打开：config 段换了，进程内的快照必须跟着换，否则 dump 永远停在启动值。
    const result = writeSettings({ subsystems: { dumpEnabled: true } }, { path, activeConfig: memory });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(memory.logging.dump?.enabled).toBe(true);
    expect(result.reloaded).toEqual(["logging"]);
    expect(dumpEnabled()).toBe(true);
  });

  it("updates the live log level without re-grabbing the dump snapshot", () => {
    const path = configFile(HOT_YAML);
    const memory = activeConfig(path);
    setDumpConfig({ enabled: true, path: join(tmpdir(), "zcode-hot-reload-dump.jsonl") });
    configureLogging({ level: "info" });

    // Direct YAML edit + writeSettings: the logger reads its threshold from
    // module state, not from the ProxyConfig that reloadConfig replaced.
    writeFileSync(path, readFileSync(path, "utf8").replace(/\n  level: info\n/, "\n  level: error\n"), "utf8");
    const result = writeSettings(
      { subsystems: { quotaPollSeconds: 120 } },
      { path, activeConfig: memory, reloadHooks: { setLogLevel: (level) => configureLogging({ level }) } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(currentLogLevel()).toBe("error");
    expect(result.reloaded).toEqual(["accounts", "logging"]);
    expect(dumpEnabled()).toBe(true);
  });

  it("calls the runtime account-sync hook when the accounts segment changes", () => {
    const path = configFile(HOT_YAML);
    const memory = activeConfig(path);
    const synced: Array<number | undefined> = [];

    const result = writeSettings(
      { subsystems: { quotaPollSeconds: 120 } },
      {
        path,
        activeConfig: memory,
        reloadHooks: { syncRuntimeAccounts: (accounts) => synced.push(accounts.quota.pollSeconds) },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(synced).toEqual([120]);
  });

  it("does not re-grab the dump snapshot when only the log level changed", () => {
    const path = configFile(HOT_YAML);
    const memory = activeConfig(path);
    setDumpConfig({ enabled: true, path: "/tmp/zcode-hot-reload-dump.jsonl" });

    // 只动 logging.level：dump 没变，快照不应被重灌（重灌会把别的调用方设的
    // 状态覆盖掉 —— 它是进程级单例）。
    const result = writeSettings({ subsystems: { quotaPollSeconds: 120 } }, { path, activeConfig: memory });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reloaded).toEqual(["accounts"]);
    expect(dumpEnabled()).toBe(true);
  });

  it("keeps the file and refuses memory when the reread fails (不一致)", () => {
    const path = configFile(HOT_YAML);
    const memory = activeConfig(path);

    const result = writeSettings(
      { security: { port: 9090 } },
      { path, activeConfig: memory, reread: () => { throw new Error("injected"); } },
    );
    // 文件已落盘、内存不收：响应明说 fileWritten，页面提示「已写入但未生效」。
    expect(result).toEqual({ ok: false, error: "config_invalid", fileWritten: true });
    expect(memory.server.port).toBe(8080);
    expect(readFileSync(path, "utf8")).toContain("9090");
  });

  it("leaves hot reload out when the caller has no activeConfig (旧行为)", () => {
    const path = configFile(HOT_YAML);
    const result = writeSettings({ subsystems: { highspeed: false } }, { path });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 没接热重载的宿主：清单为空，文件照写。
    expect(result.reloaded).toEqual([]);
    expect(result.restartRequired).toEqual([]);
    expect(readFileSync(path, "utf8")).toContain("enabled: false");
  });
});
