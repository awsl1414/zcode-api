import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DUMP_FILE, UPSTREAM_ERROR_BODY_LIMIT, dumpEnabled, dumpPhase, dumpHeaders, peekResponseBody, redactSecrets, setDumpConfig } from "./dump.js";

/* ------------------------------------------------------------------------- */
/* 三段式路径解析：环境变量 > 配置 path > 配置开启时的默认路径                    */
/* ------------------------------------------------------------------------- */

describe("dump switch", () => {
  let storeDir: string;
  const prevStoreDir = process.env.ZCODE_PROXY_STORE_DIR;
  const prevEnv = process.env.ZCODE_DUMP_UPSTREAM;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "zcode-dump-switch-"));
    process.env.ZCODE_PROXY_STORE_DIR = storeDir;
    delete process.env.ZCODE_DUMP_UPSTREAM;
  });

  afterEach(() => {
    setDumpConfig(null);
    if (prevStoreDir === undefined) delete process.env.ZCODE_PROXY_STORE_DIR;
    else process.env.ZCODE_PROXY_STORE_DIR = prevStoreDir;
    if (prevEnv === undefined) delete process.env.ZCODE_DUMP_UPSTREAM;
    else process.env.ZCODE_DUMP_UPSTREAM = prevEnv;
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("is off by default: no env var and no config means a no-op", () => {
    expect(dumpEnabled()).toBe(false);
    // 没接配置时 dumpPhase 是纯 no-op：什么文件都不写。
    dumpPhase("#w16c-001", "intake", {});
    expect(existsSync(join(storeDir, DUMP_FILE))).toBe(false);
  });

  it("turns on with the config switch and resolves the default path in the store dir", () => {
    setDumpConfig({ enabled: true, path: "" });
    expect(dumpEnabled()).toBe(true);

    dumpPhase("#w16c-001", "intake", { format: "anthropic" });
    const raw = readFileSync(join(storeDir, DUMP_FILE), "utf-8");
    expect(raw).toContain('"#w16c-001"');
    expect(raw).toContain('"intake"');
  });

  it("uses the configured path when logging.dump.path is non-empty", () => {
    const configured = join(storeDir, "elsewhere.jsonl");
    setDumpConfig({ enabled: true, path: configured });
    expect(dumpEnabled()).toBe(true);

    dumpPhase("#w16c-002", "upstream-resp", { status: 200 });
    expect(existsSync(join(storeDir, DUMP_FILE))).toBe(false);
    expect(readFileSync(configured, "utf-8")).toContain('"upstream-resp"');
  });

  it("stays off when the config carries the switch but enabled is false", () => {
    setDumpConfig({ enabled: false, path: join(storeDir, "unused.jsonl") });
    expect(dumpEnabled()).toBe(false);
    dumpPhase("#w16c-003", "intake", {});
    expect(existsSync(join(storeDir, "unused.jsonl"))).toBe(false);
  });

  it("gives the env var precedence over the config (both paths and the off state)", () => {
    const envPath = join(storeDir, "from-env.jsonl");
    const configPath = join(storeDir, "from-config.jsonl");
    process.env.ZCODE_DUMP_UPSTREAM = envPath;

    // 配置关了，env 开着：env 仍然是第一优先级，任一侧开启即启用。
    setDumpConfig({ enabled: false, path: "" });
    expect(dumpEnabled()).toBe(true);
    dumpPhase("#w16c-004", "intake", {});
    expect(existsSync(envPath)).toBe(true);

    // 配置开了另一个路径：写 env 的，不写配置的。
    setDumpConfig({ enabled: true, path: configPath });
    dumpPhase("#w16c-005", "intake", {});
    expect(existsSync(configPath)).toBe(false);
    const raw = readFileSync(envPath, "utf-8");
    expect(raw).toContain('"#w16c-004"');
    expect(raw).toContain('"#w16c-005"');
  });

  it("treats an empty env var as unset and falls through to the config", () => {
    process.env.ZCODE_DUMP_UPSTREAM = "";
    setDumpConfig({ enabled: true, path: "" });
    expect(dumpEnabled()).toBe(true);
    dumpPhase("#w16c-006", "intake", {});
    expect(existsSync(join(storeDir, DUMP_FILE))).toBe(true);
  });
});

describe("dumpHeaders", () => {
  it("masks routing JWT headers regardless of header-name casing", () => {
    const token = "Bearer synthetic.secret.jwt";
    for (const name of ["X-ZCode-Authorization", "x-zcode-authorization", "X-ZCODE-AUTHORIZATION"]) {
      const dumped = dumpHeaders(new Headers({ [name]: token, "content-type": "application/json" }));
      expect(dumped["x-zcode-authorization"]).toBe("Bearer s….jwt (len=27)");
      expect(JSON.stringify(dumped)).not.toContain(token);
      expect(JSON.stringify(dumped)).not.toContain("synthetic.secret.jwt");
      expect(dumped["content-type"]).toBe("application/json");
    }
  });

  it("fully redacts short routing credentials", () => {
    expect(dumpHeaders(new Headers({ "X-ZCode-Authorization": "Bearer x" })))
      .toEqual({ "x-zcode-authorization": "<redacted>" });
  });
});

describe("peekResponseBody", () => {
  it("reads the body without consuming the original response", async () => {
    const resp = new Response("upstream said no");
    expect(await peekResponseBody(resp, 4096)).toBe("upstream said no");
    // 这一条是用例「原响应未被消耗」的单元版本：副本之后原响应还能整段读出来。
    expect(await resp.text()).toBe("upstream said no");
  });

  it("keeps the first `limit` characters and appends the total size", async () => {
    const body = "x".repeat(UPSTREAM_ERROR_BODY_LIMIT + 100);
    const peeked = await peekResponseBody(new Response(body), UPSTREAM_ERROR_BODY_LIMIT);
    expect(peeked).toBe(`${"x".repeat(UPSTREAM_ERROR_BODY_LIMIT)}…(${body.length} bytes total)`);
  });

  it("returns undefined instead of throwing when the body was already used", async () => {
    const resp = new Response("gone");
    await resp.text();
    expect(await peekResponseBody(resp, 4096)).toBeUndefined();
  });
});

describe("redactSecrets", () => {
  it("masks a `Bearer` token echoed back by upstream", () => {
    const redacted = redactSecrets('{"error":"Authorization: Bearer abc.def-ghi_123"}');
    expect(redacted).toContain("Bearer <redacted>");
    expect(redacted).not.toContain("abc.def-ghi_123");
  });

  it("masks an `sk-` key echoed back by upstream", () => {
    const key = `sk-${"a".repeat(32)}`;
    const redacted = redactSecrets(`bad key ${key} supplied`);
    expect(redacted).toBe("bad key sk-<redacted> supplied");
    expect(redacted).not.toContain(key);
  });

  it("leaves ordinary error text alone", () => {
    const text = 'ascii codec can\'t encode character "—" in position 801';
    expect(redactSecrets(text)).toBe(text);
  });
});
