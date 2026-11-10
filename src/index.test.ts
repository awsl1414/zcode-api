/**
 * Tests for the exported pure functions (`parseServeArgs`, `resolveInvocation`)
 * plus the startup behaviour of the real entry: a bare invocation means serve
 * + web panel, and the terminal UI is gone.
 */
import { describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseServeArgs,
  resolveInvocation,
} from "./index.js";
import { parseAccountAddArgs, parseAccountExportArgs } from "./cli/account.js";
import { parseRoutingSetArgs } from "./cli/routing.js";

describe("parseServeArgs", () => {
  it("returns debug=false with no args", () => {
    expect(parseServeArgs([])).toEqual({ configPath: undefined, debug: false, noPanel: false });
  });

  it("returns debug=true with lone 'debug' token", () => {
    expect(parseServeArgs(["debug"])).toEqual({ configPath: undefined, debug: true, noPanel: false });
  });

  it("treats a single non-debug token as the config path", () => {
    expect(parseServeArgs(["my.yaml"])).toEqual({ configPath: "my.yaml", debug: false, noPanel: false });
  });

  it("accepts 'debug' before the config path", () => {
    expect(parseServeArgs(["debug", "custom.yaml"])).toEqual({
      configPath: "custom.yaml",
      debug: true,
      noPanel: false,
    });
  });

  it("accepts 'debug' after the config path (order-independent)", () => {
    expect(parseServeArgs(["custom.yaml", "debug"])).toEqual({
      configPath: "custom.yaml",
      debug: true,
      noPanel: false,
    });
  });

  it("is case-sensitive — only lowercase 'debug' toggles the flag", () => {
    expect(parseServeArgs(["DEBUG"])).toEqual({ configPath: "DEBUG", debug: false, noPanel: false });
  });

  // `--no-panel` 是 serve 的参数，不是配置路径。
  it("reads --no-panel as a flag, not as the config path", () => {
    expect(parseServeArgs(["--no-panel"])).toEqual({
      configPath: undefined,
      debug: false,
      noPanel: true,
    });
  });

  it("combines --no-panel with a config path and debug, in any order", () => {
    const expected = { configPath: "custom.yaml", debug: true, noPanel: true };
    expect(parseServeArgs(["--no-panel", "custom.yaml", "debug"])).toEqual(expected);
    expect(parseServeArgs(["debug", "custom.yaml", "--no-panel"])).toEqual(expected);
  });
});

describe("resolveInvocation", () => {
  // **裸调用就是 serve + 网页面板**，不是某个交互界面。
  it("routes a bare invocation to serve with the panel on", () => {
    expect(resolveInvocation([])).toEqual({
      kind: "serve",
      args: { configPath: undefined, debug: false, noPanel: false },
    });
  });

  it("keeps the retired tui-style argument shapes on the serve path", () => {
    for (const argv of [["debug"], ["custom.yaml"], ["custom.yml"], ["--no-panel"]]) {
      expect(resolveInvocation(argv).kind).toBe("serve");
    }
  });

  it("passes --no-panel through to serve", () => {
    expect(resolveInvocation(["--no-panel"])).toEqual({
      kind: "serve",
      args: { configPath: undefined, debug: false, noPanel: true },
    });
  });

  it("sends --cli to the classic dispatcher, bare --cli = serve", () => {
    expect(resolveInvocation(["--cli"])).toEqual({ kind: "cli", args: [] });
    expect(resolveInvocation(["--cli", "serve"])).toEqual({ kind: "cli", args: ["serve"] });
    expect(resolveInvocation(["--cli", "auth", "status"])).toEqual({
      kind: "cli",
      args: ["auth", "status"],
    });
  });

  // `tui` 不再是别名：它走 CLI 分派，由 dispatchCli 打印「已移除」并 exit(1)。
  it("does not treat tui as a serve alias", () => {
    expect(resolveInvocation(["tui"])).toEqual({ kind: "cli", args: ["tui"] });
    expect(resolveInvocation(["--cli", "tui"])).toEqual({ kind: "cli", args: ["tui"] });
  });

  it("leaves other subcommands on the CLI path", () => {
    expect(resolveInvocation(["auth", "login", "zai"]).kind).toBe("cli");
    expect(resolveInvocation(["quota"]).kind).toBe("cli");
    // 不认识的第一个词同样落到 CLI 分派，由 dispatchCli 打印用法并非零退出。
    expect(resolveInvocation(["nosuchcmd"]).kind).toBe("cli");
  });
});

// ---------------------------------------------------------------------------
// 5.0 CLI 子命令的参数解析
//
// 只测纯函数：参数错误（缺参、互斥、未知选项）必须在建账号仓之前就被拒，
// 这样脚本拿到的是非零退出码 + 一行原因，而不是一个连不上上游的堆栈。
// ---------------------------------------------------------------------------

describe("parseAccountAddArgs", () => {
  it("parses a JWT source", () => {
    expect(parseAccountAddArgs(["--label", "work", "--jwt", "a.b.c"])).toEqual({
      ok: true,
      label: "work",
      source: "jwt",
      jwt: "a.b.c",
    });
  });

  it("parses a file source with a provider", () => {
    expect(parseAccountAddArgs(["--label", "work", "--file", "/tmp/c.json", "--provider", "bigmodel"])).toEqual({
      ok: true,
      label: "work",
      source: "file",
      file: "/tmp/c.json",
      provider: "bigmodel",
    });
  });

  it("accepts the --flag=value form", () => {
    expect(parseAccountAddArgs(["--label=work", "--jwt=t.t.t"])).toEqual({
      ok: true,
      label: "work",
      source: "jwt",
      jwt: "t.t.t",
    });
  });

  it("requires a label", () => {
    expect(parseAccountAddArgs(["--jwt", "a.b.c"])).toEqual({ ok: false, error: "label_required" });
    expect(parseAccountAddArgs(["--label", "  ", "--jwt", "a.b.c"])).toEqual({
      ok: false,
      error: "label_required",
    });
  });

  it("requires a source", () => {
    expect(parseAccountAddArgs(["--label", "work"])).toEqual({ ok: false, error: "source_required" });
  });

  it("rejects two sources at once", () => {
    expect(parseAccountAddArgs(["--label", "w", "--jwt", "a.b.c", "--file", "/tmp/c.json"])).toEqual({
      ok: false,
      error: "conflicting_sources",
    });
  });

  it("rejects a missing value", () => {
    expect(parseAccountAddArgs(["--label"])).toEqual({ ok: false, error: "missing_value:--label" });
    expect(parseAccountAddArgs(["--label", "w", "--jwt"])).toEqual({
      ok: false,
      error: "missing_value:--jwt",
    });
  });

  it("rejects an unknown option", () => {
    expect(parseAccountAddArgs(["--label", "w", "--jwt", "a.b.c", "--bogus"])).toEqual({
      ok: false,
      error: "unknown_option:--bogus",
    });
  });

  it("rejects an unknown provider", () => {
    expect(parseAccountAddArgs(["--label", "w", "--jwt", "a.b.c", "--provider", "nope"])).toEqual({
      ok: false,
      error: "invalid_provider",
    });
  });
});

describe("parseAccountExportArgs", () => {
  it("defaults to the encrypted format", () => {
    expect(parseAccountExportArgs([])).toEqual({ ok: true, format: "encrypted", force: false });
  });

  it("parses each format flag", () => {
    expect(parseAccountExportArgs(["--plain"])).toEqual({ ok: true, format: "plain", force: false });
    expect(parseAccountExportArgs(["--masked"])).toEqual({ ok: true, format: "masked", force: false });
    expect(parseAccountExportArgs(["--encrypted"])).toEqual({ ok: true, format: "encrypted", force: false });
  });

  it("parses out, password and force", () => {
    expect(parseAccountExportArgs(["--encrypted", "--out", "/tmp/a.json", "--password", "pw", "--force"])).toEqual({
      ok: true,
      format: "encrypted",
      out: "/tmp/a.json",
      password: "pw",
      force: true,
    });
  });

  it("rejects conflicting formats", () => {
    expect(parseAccountExportArgs(["--plain", "--masked"])).toEqual({
      ok: false,
      error: "conflicting_formats",
    });
  });

  it("rejects a missing value and an unknown option", () => {
    expect(parseAccountExportArgs(["--out"])).toEqual({ ok: false, error: "missing_value:--out" });
    expect(parseAccountExportArgs(["--nope"])).toEqual({ ok: false, error: "unknown_option:--nope" });
  });
});

describe("parseRoutingSetArgs", () => {
  it("splits the order list", () => {
    expect(parseRoutingSetArgs(["--order", "coding-plan,start-plan"])).toEqual({
      ok: true,
      routing: { order: ["coding-plan", "start-plan"] },
      stickiness: {},
    });
  });

  it("parses every routing enum", () => {
    const parsed = parseRoutingSetArgs([
      "--mode", "only",
      "--strategy", "balanced",
      "--on-saturated", "overflow",
      "--on-drained", "stop",
    ]);
    expect(parsed).toEqual({
      ok: true,
      routing: { mode: "only", strategy: "balanced", onSaturated: "overflow", onDrained: "stop" },
      stickiness: {},
    });
  });

  it("parses the numeric and stickiness flags", () => {
    const parsed = parseRoutingSetArgs([
      "--queue-timeout-ms", "1000",
      "--max-queue", "8",
      "--max-total-inflight", "4",
      "--sticky", "off",
      "--sticky-ttl", "600",
      "--sticky-on-saturated", "overflow",
      "--sticky-overflow-ms", "250",
    ]);
    expect(parsed).toEqual({
      ok: true,
      routing: { queueTimeoutMs: 1000, maxQueue: 8, maxTotalInflight: 4 },
      stickiness: { enabled: false, ttlSeconds: 600, onSaturated: "overflow", overflowAfterMs: 250 },
    });
  });

  it("parses --within-tier", () => {
    expect(parseRoutingSetArgs(["--within-tier", "drain-first"])).toEqual({
      ok: true,
      routing: { withinTier: "drain-first" },
      stickiness: {},
    });
  });

  it("rejects an empty invocation", () => {
    expect(parseRoutingSetArgs([])).toEqual({ ok: false, error: "nothing_to_set" });
  });

  it("rejects a non-numeric value", () => {
    expect(parseRoutingSetArgs(["--max-queue", "many"])).toEqual({
      ok: false,
      error: "invalid_number:--max-queue",
    });
  });

  it("rejects a bad --sticky value", () => {
    expect(parseRoutingSetArgs(["--sticky", "maybe"])).toEqual({
      ok: false,
      error: "invalid_value:--sticky",
    });
  });

  it("rejects a missing value and an unknown option", () => {
    expect(parseRoutingSetArgs(["--order"])).toEqual({ ok: false, error: "missing_value:--order" });
    expect(parseRoutingSetArgs(["--order", ","])).toEqual({ ok: false, error: "missing_value:--order" });
    expect(parseRoutingSetArgs(["--bogus", "x"])).toEqual({ ok: false, error: "unknown_option:--bogus" });
  });
});

// ---------------------------------------------------------------------------
// 启动行为：跑真正的入口，而不是在进程内伪造分派。
//
// 这些用例**不会**碰网络：每个入口都在「没有账号」这道闸门上退出，早于
// `startServer` / 额度采样 / 更新检查。环境被压到最小（临时 store + 临时
// config + 临时 HOME），所以绝不写真实 `~/.zcode-proxy`。
// ---------------------------------------------------------------------------

const ENTRY = join(import.meta.dir, "index.ts");

interface EntryResult {
  code: number;
  stdout: string;
  stderr: string;
  /** serve 实际监听的端口（从 "zcode-proxy listening on" 行解析）。非 serve 入口为 undefined。*/
  port?: number;
}

interface EntrySandbox {
  dir: string;
  configPath: string;
  env: Record<string, string>;
}

/** 一次启动的沙箱：临时 HOME / store / config，且把面板相关的 env 清干净。*/
function makeSandbox(): EntrySandbox {
  const dir = mkdtempSync(join(tmpdir(), "zcode-entry-"));
  const configPath = join(dir, "config.yaml");
  const env: Record<string, string> = {
    HOME: dir,
    PATH: process.env.PATH ?? "",
    ZCODE_PROXY_CONFIG: configPath,
    ZCODE_PROXY_STORE_DIR: join(dir, "store"),
    // 更新检查是唯一会在启动路径上打网络的子系统；关掉它，用例就与网络无关。
    ZCODE_UPDATE_CHECK: "off",
  };
  return { dir, configPath, env };
}

async function runEntry(argv: readonly string[], sandbox: EntrySandbox): Promise<EntryResult> {
  const proc = Bun.spawn([process.execPath, ENTRY, ...argv], {
    cwd: join(import.meta.dir, ".."),
    env: sandbox.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * 一份能真正启动的配置：端口写 0 让内核在 bind 时分配，回环绑定，并且关掉
 * 会自动打上游的两个子系统。`serve` 不再因为「没有账号」退出，所以这些用例必须
 * 真的把监听起起来再关掉，不能靠进程自己退。
 *
 * 端口不在测试里先探测：探测在 close 回调里把端口还给内核，serve 真正
 * listen 之前有空窗，别的进程可能把它抢走，表现为偶发 EADDRINUSE。真实端口由
 * `runServeUntil` 从「zcode-proxy listening on」行解析回来。
 */
function writeServeConfig(sandbox: EntrySandbox): void {
  writeFileSync(
    sandbox.configPath,
    [
      "server:",
      "  port: 0",
      '  host: "127.0.0.1"',
      "defaultModel: glm-5.3",
      "claim:",
      "  enabled: false",
      "  auto: false",
      "",
    ].join("\n"),
    "utf8",
  );
}

/**
 * 跑一次 `serve`，等到某个标记出现在输出里，再发 SIGTERM 收尾。
 *
 * 「没有账号」不是退出条件，所以用例的判据从「进程退出码」变成
 * 「进程起得来、打印了该打印的东西、收到信号后干净退出」。
 */
async function runServeUntil(
  argv: readonly string[],
  sandbox: EntrySandbox,
  marker: string,
): Promise<EntryResult> {
  const proc = Bun.spawn([process.execPath, ENTRY, ...argv], {
    cwd: join(import.meta.dir, ".."),
    env: sandbox.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let stdout = "";
  let stderr = "";
  const pumps = [
    (async () => {
      for await (const chunk of proc.stdout) stdout += Buffer.from(chunk).toString("utf8");
    })(),
    (async () => {
      for await (const chunk of proc.stderr) stderr += Buffer.from(chunk).toString("utf8");
    })(),
  ];

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !`${stdout}${stderr}`.includes(marker)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // 信号处理器是 serve 启动的最后一步（bootstrap.ts 里 startServer、控制监听、
  // 启动横幅都走完才装），监听行打印之后还有几毫秒的窗口。标记一出现就 SIGTERM
  // 可能撞上「处理器还没装上」，进程按默认行为死掉（exit 143），负载越重窗口越宽，
  // 表现为偶发失败。这里留一段宽限等启动真正走完；它不掩盖任何断言，
  // 只是不把信号发在半启动的进程上。
  await new Promise((resolve) => setTimeout(resolve, 300));
  proc.kill("SIGTERM");
  const code = await proc.exited;
  await Promise.all(pumps);

  // YAML 写的是 port: 0，真实端口从监听行解析回来。host 可能是 0.0.0.0，
  // `\S+` 把它一并吃掉。解析失败不报错：非 serve 入口本来就没有这一行。
  const listen = /zcode-proxy listening on \S+:(\d+)/.exec(stdout);
  return {
    code,
    stdout,
    stderr,
    port: listen ? Number(listen[1]) : undefined,
  };
}

describe("startup behaviour", () => {
  it("starts without any account and prints the three ways to add one", async () => {
    const sandbox = makeSandbox();
    try {
      writeServeConfig(sandbox);
      const result = await runServeUntil([], sandbox, "zcode-proxy listening on");

      // 无账号不再退出：代理与面板都起来了，提示只说「去哪建号」。
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("No account yet");
      expect(result.stderr).toContain("zcode-proxy auth login zai|bigmodel");
      expect(result.stderr).toContain("zcode-proxy auth import [--jwt <token>]");
      expect(result.stderr).not.toContain("Shutting down");
      expect(result.stdout).toContain("zcode-proxy listening on");
      // 端口由内核分配；这里钉住监听行的解析真的拿到了它（正整数且非 0）。
      expect(Number.isInteger(result.port)).toBe(true);
      expect(result.port).toBeGreaterThan(0);

      // 面板跟着启动：地址一行，加上只打印一次的管理员密码（16 个字符，无歧义字母表）。
      expect(result.stdout).toContain("panel: http://127.0.0.1:");
      expect(result.stdout).toContain("panel: admin password (shown once, change it in Settings):");
      const password = /panel: admin password \(shown once, change it in Settings\):\n {8}(\S+)/.exec(result.stdout);
      expect(password?.[1]).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{16}$/);
      // 管理员落盘到临时 store，不碰真实的 ~/.zcode-proxy。
      expect(existsSync(join(sandbox.env.ZCODE_PROXY_STORE_DIR ?? "", "users.json"))).toBe(true);
    } finally {
      rmSync(sandbox.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("--no-panel starts the proxy without a panel or an admin account", async () => {
    const sandbox = makeSandbox();
    try {
      writeServeConfig(sandbox);
      const result = await runServeUntil(["--no-panel"], sandbox, "zcode-proxy listening on");

      expect(result.code).toBe(0);
      expect(Number.isInteger(result.port)).toBe(true);
      expect(result.port).toBeGreaterThan(0);
      expect(result.stderr).toContain("No account yet");
      // 面板关掉 = 不打印地址，也不建管理员（没有面板就没有登录的地方）。
      expect(result.stdout).not.toContain("panel:");
      expect(existsSync(join(sandbox.env.ZCODE_PROXY_STORE_DIR ?? "", "users.json"))).toBe(false);
    } finally {
      rmSync(sandbox.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("--cli serve still works (classic dispatch, not an unknown command)", async () => {
    const sandbox = makeSandbox();
    try {
      writeServeConfig(sandbox);
      const result = await runServeUntil(["--cli", "serve", "--no-panel"], sandbox, "zcode-proxy listening on");
      expect(result.code).toBe(0);
      expect(Number.isInteger(result.port)).toBe(true);
      expect(result.port).toBeGreaterThan(0);
      expect(result.stderr).toContain("No account yet");
      expect(result.stderr).not.toContain("Unknown command");
    } finally {
      rmSync(sandbox.dir, { recursive: true, force: true });
    }
  }, 30_000);

  // `tui` 不是别名，也不是静默忽略：两个入口都必须是明确的错误。
  for (const argv of [["tui"], ["--cli", "tui"]]) {
    it(`rejects the removed TUI command (${argv.join(" ")}) with an explicit error`, async () => {
      const sandbox = makeSandbox();
      try {
        const result = await runEntry(argv, sandbox);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("terminal UI was removed");
        expect(result.stderr).toContain("Use `zcode-proxy` for the web panel");
        expect(result.stderr).not.toContain("Not logged in");
      } finally {
        rmSync(sandbox.dir, { recursive: true, force: true });
      }
    });
  }

  it("help documents the new default and --no-panel, and no longer advertises a TUI", async () => {
    const sandbox = makeSandbox();
    try {
      const result = await runEntry(["--help"], sandbox);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("--no-panel");
      expect(result.stdout).toContain("web panel");
      expect(result.stdout).not.toContain("Interactive terminal UI");
      expect(result.stdout).not.toContain("Terminal UI");
    } finally {
      rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});
