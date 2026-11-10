/**
 * `logs` 子命令的解析与展示用例。
 *
 * 测的是纯函数（解析 / 分组 / 摘要 / 格式化），加上四个「数据源」用例：`logsCommand`
 * 把「读哪份文件 → 渲染」串起来，串错了只有真跑一次才看得出来。
 *
 * 两条数据源都在这里钉住：默认的 `requests.jsonl`（`--last` / `--failed` / `--req`）
 * 与显式 `--file` 的 dump。后者要防的是「改了默认路径，顺手把 dump 能力删了」。
 *
 * 三条判定规则值得单独测，因为它们是「失败断在哪一步」这个结论的全部依据：
 *
 *   上游状态码 ≥ 400  失败阶段是 `upstream-resp`（它有 status）
 *   完全没有上游应答  失败阶段是最后出现的阶段（断点就在那里）
 *   有应答且 2xx      没有失败阶段
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DumpLine } from "./logs.js";
import {
  formatRecordHead,
  formatRecordTimeline,
  formatStageLine,
  formatSummaryLine,
  formatTimelineLine,
  groupByRequest,
  logsCommand,
  parseDump,
  parseLogsQuery,
  resolveDumpFile,
  summarizeRecord,
  summarizeRequest,
} from "./logs.js";
import { appendRequestRecord, requestLogPath } from "../proxy/request-log.js";
import type { RequestRecord } from "../proxy/request-record.js";

/** 一行 dump（字段真的按 `dump.ts::dumpPhase` 的形状写）。*/
function line(reqId: string, phase: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: "2026-07-31T12:00:00.000Z", reqId, phase, ...extra });
}

describe("parseDump", () => {
  it("解析 JSONL，跳过空行与半行（进程被杀时最后一行常常是断的）", () => {
    const text = [
      line("#001", "intake", { method: "POST", url: "/v1/messages" }),
      "",
      '{"ts":"2026-07-31T12:00:01.000Z","reqId":"#001","phase":"upstream-resp","status":200',
      line("#001", "stream-end", { status: 200, tokensObserved: 5 }),
    ].join("\n");

    const parsed = parseDump(text);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((entry) => entry.phase)).toEqual(["intake", "stream-end"]);
  });

  it("跳过形状不对的对象（不是 dump 行）", () => {
    const text = [
      JSON.stringify({ hello: "world" }),
      JSON.stringify({ ts: 1, reqId: "#001", phase: "intake" }),
      line("#001", "intake"),
    ].join("\n");

    expect(parseDump(text)).toHaveLength(1);
  });
});

describe("groupByRequest", () => {
  it("保持首次出现的顺序，而不是按时间戳重排", () => {
    const lines: DumpLine[] = parseDump([
      line("#002", "intake"),
      line("#001", "intake"),
      line("#002", "upstream-resp", { status: 200 }),
    ].join("\n"));

    const groups = groupByRequest(lines);
    expect([...groups.keys()]).toEqual(["#002", "#001"]);
    expect(groups.get("#002")).toHaveLength(2);
  });
});

describe("summarizeRequest", () => {
  it("2xx：没有失败阶段，带上 ttfb / total / tokens", () => {
    const lines = parseDump([
      line("#003", "intake", { body: { model: "glm-4.6" } }),
      line("#003", "upstream-resp", { status: 200, ttfbMs: 12 }),
      line("#003", "stream-end", { status: 200, tokensObserved: 42, ttfbMs: 12, totalMs: 900 }),
    ].join("\n"));

    const summary = summarizeRequest("#003", lines);
    expect(summary.model).toBe("glm-4.6");
    expect(summary.status).toBe(200);
    expect(summary.ttfbMs).toBe(12);
    expect(summary.totalMs).toBe(900);
    expect(summary.tokens).toBe(42);
    expect(summary.failedPhase).toBeUndefined();
    expect(summary.failure).toBeUndefined();
  });

  it("上游 5xx：失败阶段是 upstream-resp，原因带状态码", () => {
    const lines = parseDump([
      line("#004", "intake", { body: { model: "glm-4.6" } }),
      line("#004", "upstream-req"),
      line("#004", "upstream-resp", { status: 502, ttfbMs: 7 }),
    ].join("\n"));

    const summary = summarizeRequest("#004", lines);
    expect(summary.failedPhase).toBe("upstream-resp");
    expect(summary.failure).toBe("HTTP 502");
  });

  it("完全没有上游应答：断点就是最后出现的阶段", () => {
    const lines = parseDump([
      line("#005", "intake", { body: { model: "glm-4.6" } }),
      line("#005", "upstream-req"),
    ].join("\n"));

    const summary = summarizeRequest("#005", lines);
    expect(summary.failedPhase).toBe("upstream-req");
    expect(summary.failure).toBe("no upstream response");
    expect(summary.status).toBeUndefined();
  });

  it("连 intake 都没有（只有一行）：失败阶段仍是那一行", () => {
    const summary = summarizeRequest("#006", parseDump(line("#006", "upstream-req")).slice(0, 1));
    expect(summary.failedPhase).toBe("upstream-req");
  });
});

describe("格式化", () => {
  it("--req 一行：钟点 + 阶段 + 字段，长值截断并注明原长", () => {
    const rendered = formatTimelineLine({
      ts: new Date(2026, 6, 31, 12, 0, 3).toISOString(),
      reqId: "#003",
      phase: "intake",
      method: "POST",
      body: { model: "glm-4.6", messages: new Array(50).fill({ role: "user", content: "hi" }) },
    });

    expect(rendered.startsWith("12:00:03 intake method=POST ")).toBe(true);
    expect(rendered).toContain("body={");
    expect(rendered).toMatch(/…\(\d+ chars\)$/);
    // reqId 已经在标题里，逐行不再重复（否则整列都是同一个值）。
    expect(rendered).not.toContain("reqId=");
  });

  it("--last 一行：id 钟点 model 状态 ttfb total tokens", () => {
    const rendered = formatSummaryLine({
      reqId: "#003",
      startedAt: new Date(2026, 6, 31, 12, 0, 0).toISOString(),
      model: "glm-4.6",
      status: 200,
      ttfbMs: 12,
      totalMs: 900,
      tokens: 42,
    });

    expect(rendered).toBe("#003 12:00:00 glm-4.6 200 ttfb=12ms total=900ms 42tok");
  });

  it("--failed 一行：没有状态码时报 no-response，并带上失败阶段与原因", () => {
    const rendered = formatSummaryLine({
      reqId: "#005",
      startedAt: new Date(2026, 6, 31, 12, 0, 0).toISOString(),
      model: "glm-4.6",
      failedPhase: "upstream-req",
      failure: "no upstream response",
    });

    expect(rendered).toBe("#005 12:00:00 glm-4.6 no-response failed=upstream-req reason=no upstream response");
  });
});

describe("resolveDumpFile", () => {
  it("只认显式 --file；没给就回 null，调用方改用 requests.jsonl", () => {
    expect(resolveDumpFile(["--file", "/tmp/explicit.jsonl"])).toBe("/tmp/explicit.jsonl");
    expect(resolveDumpFile(["--last", "3"])).toBeNull();
  });

  it("--file 缺值时明确报错（不是静默降级到默认数据源）", () => {
    const resolved = resolveDumpFile(["--file"]);
    expect(resolved !== null && typeof resolved === "object" && resolved.error).toContain("--file needs a path");
  });
});

describe("parseLogsQuery", () => {
  it("三条子命令各自的形状", () => {
    expect(parseLogsQuery(["--req", "#003"])).toEqual({ query: { kind: "req", reqId: "#003" } });
    expect(parseLogsQuery(["--last", "3"])).toEqual({ query: { kind: "last", count: 3 } });
    expect(parseLogsQuery(["--failed"])).toEqual({ query: { kind: "failed" } });
  });

  it("缺值与非法条数不给默认值（否则 --last 会静默打出一行）", () => {
    expect("error" in parseLogsQuery(["--req"])).toBe(true);
    expect("error" in parseLogsQuery(["--last"])).toBe(true);
    expect("error" in parseLogsQuery(["--last", "0"])).toBe(true);
    expect("error" in parseLogsQuery(["--nope"])).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */
/* RequestRecord 数据源                                                      */
/* ------------------------------------------------------------------------- */

/** 一条记录（字段按 `proxyRequest` 实际会填的那些）。*/
function record(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    reqId: "#003",
    startedAt: new Date(2026, 6, 31, 12, 0, 0).getTime(),
    format: "anthropic",
    model: "glm-4.6",
    stream: true,
    requestBytes: 12480,
    retries: 0,
    status: 200,
    ttfbMs: 1240,
    totalMs: 2890,
    outputTokens: 179,
    stages: [],
    apiKeyId: "",
    ...overrides,
  };
}

describe("summarizeRecord", () => {
  it("成功的一次：状态、耗时、token 来自记录本身", () => {
    const summary = summarizeRecord(record());
    expect(summary.reqId).toBe("#003");
    expect(summary.model).toBe("glm-4.6");
    expect(summary.status).toBe(200);
    expect(summary.ttfbMs).toBe(1240);
    expect(summary.totalMs).toBe(2890);
    expect(summary.tokens).toBe(179);
    expect(summary.failedPhase).toBeUndefined();
  });

  it("失败的一次：failedStage 与 error 原样搬过来", () => {
    const summary = summarizeRecord(record({ status: 502, failedStage: "upstream-resp", error: "HTTP 502" }));
    expect(summary.failedPhase).toBe("upstream-resp");
    expect(summary.failure).toBe("HTTP 502");
  });

  it("没有状态码时写 no-response，原因缺省按「没有上游应答」解释", () => {
    const summary = summarizeRecord(record({ status: undefined, failedStage: "dispatch", error: undefined }));
    expect(summary.status).toBeUndefined();
    expect(summary.failure).toBe("no upstream response");
    expect(formatSummaryLine(summary)).toContain("no-response");
  });

  it("模型占位符不进摘要（`-` 是 peekBody 的缺失值，不是模型名）", () => {
    expect(summarizeRecord(record({ model: "-" })).model).toBeUndefined();
  });
});

describe("--req 的记录视图", () => {
  it("头部带协议、账号、路由与耗时", () => {
    const head = formatRecordHead(record({ account: "work-team", route: "start-plan" }));
    expect(head.startsWith("#003 12:00:00 anthropic glm-4.6 200 ")).toBe(true);
    expect(head).toContain("account=work-team");
    expect(head).toContain("route=start-plan");
    expect(head).toContain("ttfb=1240ms");
    expect(head).toContain("total=2890ms");
  });

  it("阶段行显示 atMs（相对请求开始）与字段", () => {
    const one = record();
    const line = formatStageLine(one, { stage: "dispatch", atMs: 18, fields: { account: "work-team", queueMs: 16 } });
    expect(line).toBe("12:00:00 +18ms dispatch account=work-team queueMs=16");
  });

  it("完整视图：一行头 + 每个阶段一行，阶段按记录里的顺序", () => {
    const lines = formatRecordTimeline(
      record({
        stages: [
          { stage: "intake", atMs: 0, fields: { bytes: 12480 } },
          { stage: "dispatch", atMs: 18, fields: { queueMs: 16 } },
        ],
      }),
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]!.startsWith("#003 ")).toBe(true);
    expect(lines[1]).toContain("intake bytes=12480");
    expect(lines[2]).toContain("+18ms dispatch");
  });

  it("失败阶段在时间线里也能看到（failStage 同时写 stages 与 failedStage）", () => {
    const lines = formatRecordTimeline(
      record({
        status: 502,
        failedStage: "upstream-resp",
        error: "HTTP 502",
        stages: [{ stage: "upstream-resp", atMs: 1263, fields: { error: "HTTP 502" } }],
      }),
    );
    expect(lines[0]).toContain("failed=upstream-resp");
    expect(lines[1]).toContain("upstream-resp");
    expect(lines[1]).toContain("error=HTTP 502");
  });
});

/* ------------------------------------------------------------------------- */
/* 子命令与数据源（默认读 requests.jsonl，--file 读 dump）                     */
/* ------------------------------------------------------------------------- */

const ENV_STORE_DIR = "ZCODE_PROXY_STORE_DIR";

/**
 * 收集 `console.log` 的一行行输出（CLI 命令结果是输出，不是日志）。
 *
 * 用法错误走 `printUsageError`：原因在 stderr、帮助在 stdout（输出与日志的分界），
 * 所以断言错误文案的用例要在 `captureErrors` 那一侧看。
 */
function captureLogs(run: () => void): string[] {
  const out: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    out.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    run();
  } finally {
    console.log = original;
  }
  return out;
}

/** 收集 `console.error`（`printUsageError` 的原因行）。*/
function captureErrors(run: () => void): string[] {
  const out: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    out.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    run();
  } finally {
    console.error = original;
  }
  return out;
}

describe("logsCommand 默认数据源", () => {
  let storeDir = "";
  const previousStoreDir = process.env[ENV_STORE_DIR];

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "zcode-logs-"));
    process.env[ENV_STORE_DIR] = storeDir;
  });

  afterEach(() => {
    if (previousStoreDir === undefined) delete process.env[ENV_STORE_DIR];
    else process.env[ENV_STORE_DIR] = previousStoreDir;
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("--last 3 从 requests.jsonl 读，只打最近三条", () => {
    for (const id of ["#001", "#002", "#003", "#004"]) {
      appendRequestRecord(record({ reqId: id, status: 200, totalMs: 100 }));
    }

    const out = captureLogs(() => logsCommand(["--last", "3"]));
    expect(out).toHaveLength(3);
    expect(out[0]!.startsWith("#002 ")).toBe(true);
    expect(out[2]!.startsWith("#004 ")).toBe(true);
    expect(out[0]).toContain("200");
  });

  it("--failed 只列 failedStage 有值的", () => {
    appendRequestRecord(record({ reqId: "#001" }));
    appendRequestRecord(record({ reqId: "#002", status: 502, failedStage: "upstream-resp", error: "HTTP 502" }));

    const out = captureLogs(() => logsCommand(["--failed"]));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("#002");
    expect(out[0]).toContain("failed=upstream-resp");
    expect(out[0]).toContain("reason=HTTP 502");
  });

  it("--req 打阶段时间线（atMs 与阶段字段）", () => {
    appendRequestRecord(
      record({
        reqId: "#003",
        stages: [
          { stage: "intake", atMs: 0, fields: { bytes: 12480 } },
          { stage: "upstream-resp", atMs: 1263, fields: { status: 200, ttfbMs: 1240 } },
        ],
      }),
    );

    const out = captureLogs(() => logsCommand(["--req", "#003"]));
    expect(out).toHaveLength(3);
    expect(out[2]).toContain("+1263ms upstream-resp");
    expect(out[2]).toContain("status=200");
  });

  it("--req 找不到时提示 --file（记录只留最近 200 条，更早的可能在 dump 里）", () => {
    appendRequestRecord(record({ reqId: "#001" }));
    const before = process.exitCode;
    try {
      const out = captureLogs(() => logsCommand(["--req", "#999"]));
      expect(out.join("\n")).toContain("--file");
    } finally {
      // `printUsageError` 会设 process.exitCode = 1；把它赋回 undefined（或 delete）
      // 在 Bun 1.4.4 都不清除退出码（全量测试会 0 fail 但 exit 1）。显式归零。
      process.exitCode = before ?? 0;
    }
  });

  it("--file 仍然读 dump（同一套阶段名，另一种来源）", () => {
    const dumpPath = join(storeDir, "dump.jsonl");
    writeFileSync(
      dumpPath,
      [
        line("#001", "intake", { body: { model: "glm-4.6" } }),
        line("#001", "upstream-resp", { status: 200, ttfbMs: 12 }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const out = captureLogs(() => logsCommand(["--req", "#001", "--file", dumpPath]));
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("intake");
    expect(out[1]).toContain("upstream-resp");
  });

  it("--file 指向不存在的文件时明确报错（而不是静默用默认源）", () => {
    const before = process.exitCode;
    try {
      const errors = captureErrors(() =>
        captureLogs(() => logsCommand(["--last", "3", "--file", join(storeDir, "nope.jsonl")])),
      );
      expect(errors.join("\n")).toContain("cannot read");
    } finally {
      process.exitCode = before ?? 0;
    }
  });

  it("默认路径就是 requestLogPath()（与写盘那一侧同一个目录判定）", () => {
    appendRequestRecord(record({ reqId: "#007" }));
    const out = captureLogs(() => logsCommand(["--req", "#007"]));
    expect(out[0]).toContain("#007");
    expect(requestLogPath()).toBe(join(storeDir, "requests.jsonl"));
  });
});

/**
 * 新字段的读取点（`logs --req` 头部 / `--last` 摘要行）。
 *
 * 这两处是这些字段的**排障消费方**：面板那一列由页面渲染，CLI 是现在就能读的
 * 那一个读者。字段缺失时一律省略（不打 `-`），与其余字段同一口径。
 */
describe("请求字段的排障视图", () => {
  it("--req 头部带推理强度、尝试次数、排队耗时、请求/响应字节", () => {
    const head = formatRecordHead(
      record({
        reasoningEffort: "high",
        upstreamAttempts: 2,
        queueMs: 37,
        requestBytes: 512,
        responseBytes: 4096,
      }),
    );
    expect(head).toContain("effort=high");
    expect(head).toContain("attempts=2");
    expect(head).toContain("queue=37ms");
    expect(head).toContain("req=512B");
    expect(head).toContain("resp=4096B");
  });

  it("--req 头部在旧记录（无新字段）上不打印任何新项", () => {
    const head = formatRecordHead(record());
    expect(head).not.toContain("effort=");
    expect(head).not.toContain("attempts=");
    expect(head).not.toContain("queue=");
    expect(head).not.toContain("resp=");
    // requestBytes 是必填字段，仍然会打。
    expect(head).toContain("req=12480B");
  });

  it("--req 头部标出客户端断开（区别于上游失败）", () => {
    const head = formatRecordHead(record({ clientAborted: true, status: 502, failedStage: "upstream-req", error: "client aborted" }));
    expect(head).toContain("client-aborted");
    expect(head).toContain("failed=upstream-req");
  });

  it("--last 摘要只在尝试次数大于 1 时打 attempts，断连总是打", () => {
    const quiet = formatSummaryLine(summarizeRecord(record({ upstreamAttempts: 1 })));
    expect(quiet).not.toContain("attempts=");
    expect(quiet).not.toContain("client-aborted");

    const retried = formatSummaryLine(summarizeRecord(record({ upstreamAttempts: 3 })));
    expect(retried).toContain("attempts=3");

    const aborted = formatSummaryLine(summarizeRecord(record({ clientAborted: true })));
    expect(aborted).toContain("client-aborted");
  });
});
