/**
 * `computeUsageStats` 的聚合口径测试。
 *
 * 夹具直接写 JSONL（与 `request-log.test.ts` 同一套写法）：聚合器的输入就是文件，
 * 从「落盘形状」开始测，而不是从内存记录——旧记录无新字段、坏行、跨块长行这些
 * 兼容性问题只存在于文件上。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { computeUsageStats } from "./usage-stats.js";
import type { UsageStatsCacheHit } from "./usage-stats.js";
import type { RequestRecord } from "./request-record.js";
import { ERROR_CODES } from "./error-codes.js";
import type { ErrorCode } from "./error-codes.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "usage-stats-"));
  path = join(dir, "requests.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 最小可用记录：聚合测试只关心统计相关的字段。 */
function record(overrides: Partial<RequestRecord>): RequestRecord {
  return {
    reqId: "#test-001",
    startedAt: 1_700_000_000_000,
    format: "anthropic",
    model: "glm-4.6",
    stream: false,
    requestBytes: 100,
    retries: 0,
    stages: [],
    apiKeyId: "",
    ...overrides,
  };
}

function writeLines(lines: unknown[]): void {
  writeFileSync(path, lines.map((one) => JSON.stringify(one)).join("\n") + "\n", "utf-8");
}

const T0 = 1_700_000_000_000; // 2023-11-14T22:13:20Z
const HOUR = 3_600_000;

describe("computeUsageStats — totals", () => {
  it("sums requests / ok / failed / tokens over the whole file", () => {
    writeLines([
      record({ reqId: "#a", status: 200, inputTokens: 10, outputTokens: 5, ttfbMs: 100, totalMs: 1000, tps: 10 }),
      record({ reqId: "#b", format: "openai", status: 200, inputTokens: 20, outputTokens: 8, ttfbMs: 300, totalMs: 2000, tps: 30, apiKeyId: "k1" }),
      record({ reqId: "#c", status: 502, failedStage: "upstream-resp", error: "upstream returned 502" }),
    ]);
    const stats = computeUsageStats({ path });
    expect(stats.totals.requests).toBe(3);
    expect(stats.totals.ok).toBe(2);
    expect(stats.totals.failed).toBe(1);
    expect(stats.totals.inputTokens).toBe(30);
    expect(stats.totals.outputTokens).toBe(13);
    expect(stats.totals.avgTtfbMs).toBe(200);
    expect(stats.totals.avgTps).toBe(20);
    expect(stats.range.records).toBe(3);
    // 无 from/to：range 用文件里实际的第一条开始 / 最后一条收尾。
    expect(stats.range.from).toBe(T0);
    expect(stats.range.to).toBe(T0);
  });

  it("a status>=400 record without failedStage counts as failed but not in errors[] (models/mcp 口径)", () => {
    writeLines([
      record({ reqId: "#m", status: 404, stages: [{ stage: "route", atMs: 0, fields: { path: "GET /v1/models" } }] }),
    ]);
    const stats = computeUsageStats({ path });
    expect(stats.totals.failed).toBe(1);
    expect(stats.totals.ok).toBe(0);
    expect(stats.errors).toEqual([]);
    expect(stats.totals.errorCount).toBe(0);
  });

  it("averages only over records that have the field (undefined = no sample)", () => {
    writeLines([
      record({ reqId: "#a", status: 200, ttfbMs: 100, totalMs: 1000, tps: 10 }),
      record({ reqId: "#b", status: 200 }), // 全无：直传批量/旧记录形态
    ]);
    const stats = computeUsageStats({ path });
    expect(stats.totals.avgTtfbMs).toBe(100);
    expect(stats.totals.avgTps).toBe(10);
    expect(stats.byAccount[0]).toMatchObject({ key: "-", requests: 2 });
    // #b 无 totalMs/tps：组平均只算 #a。
    expect(stats.byModel[0]).toMatchObject({ key: "glm-4.6", avgTotalMs: 1000, avgTps: 10 });
  });
});

describe("computeUsageStats — time buckets", () => {
  it("buckets hourly by UTC floor(startedAt)", () => {
    writeLines([
      record({ reqId: "#a", startedAt: T0 + 10_000 }),
      record({ reqId: "#b", startedAt: T0 + HOUR + 20_000 }),
      record({ reqId: "#c", startedAt: T0 + HOUR + 30_000, status: 500, failedStage: "upstream-resp", error: "upstream returned 500" }),
    ]);
    const stats = computeUsageStats({ path });
    expect(stats.hourly.map((b) => [b.bucketStart, b.requests, b.ok, b.failed])).toEqual([
      [Math.floor(T0 / HOUR) * HOUR, 1, 1, 0],
      [Math.floor((T0 + HOUR) / HOUR) * HOUR, 2, 1, 1],
    ]);
    // 日桶同构：三条同一天。
    expect(stats.daily).toHaveLength(1);
    expect(stats.daily[0].requests).toBe(3);
  });

  it("zero-fills hourly buckets only when both from and to are given", () => {
    writeLines([
      record({ reqId: "#a", startedAt: T0 + HOUR }),
      record({ reqId: "#b", startedAt: T0 + 3 * HOUR }),
    ]);
    const from = Math.floor(T0 / HOUR) * HOUR;
    const to = from + 3 * HOUR;
    const both = computeUsageStats({ path, from, to });
    expect(both.hourly.map((b) => b.bucketStart)).toEqual([from, from + HOUR, from + 2 * HOUR, from + 3 * HOUR]);
    // #a 落在 from+HOUR、#b 落在 from+3HOUR；from 与 from+2HOUR 是补零的空桶。
    expect(both.hourly[2]).toMatchObject({ requests: 0, ok: 0, failed: 0, inputTokens: 0, cacheHitSamples: 0 });
    expect(both.hourly[1]).toMatchObject({ requests: 1, ok: 1 });
    // 只给一边：只输出有数据的桶。
    const one = computeUsageStats({ path, from });
    expect(one.hourly.map((b) => b.bucketStart)).toEqual([from + HOUR, from + 3 * HOUR]);
    // 两边都不给：同上。
    expect(computeUsageStats({ path }).hourly).toHaveLength(2);
  });

  it("skips zero-fill for pathological ranges (>90 days hourly, >10y daily)", () => {
    writeLines([record({ reqId: "#a", startedAt: T0 + 100 * HOUR })]);
    const from = 1;
    const to = T0 + 200 * HOUR;
    const stats = computeUsageStats({ path, from, to });
    expect(stats.hourly.map((b) => b.bucketStart)).toEqual([Math.floor((T0 + 100 * HOUR) / HOUR) * HOUR]);
  });
});

describe("computeUsageStats — grouping dimensions", () => {
  function fixture(): void {
    writeLines([
      record({ reqId: "#a", account: "work", route: "coding-plan", model: "glm-4.6", apiKeyId: "k1", format: "openai", clientKind: "claude-code", status: 200 }),
      record({ reqId: "#b", account: "work", route: "start-plan", model: "glm-4.6", apiKeyId: "k1", format: "anthropic", clientKind: "zcode", status: 200 }),
      record({ reqId: "#c", account: "home", route: "start-plan", model: "glm-5.2", apiKeyId: "", format: "openai", status: 502, failedStage: "upstream-resp", error: "upstream returned 502" }),
      // 早期失败：没有 account / route（缺值归 "-"）。
      record({ reqId: "#d", account: undefined, route: undefined, model: "-", apiKeyId: "", format: "anthropic", status: 503, failedStage: "dispatch", error: "every candidate account is cooling down" }),
    ]);
  }

  it("groups byAccount / byRoute / byModel / byApiKey / byProtocol / byClientKind", () => {
    fixture();
    const stats = computeUsageStats({ path });
    // 排序：requests 降序，并列按键名升序（"-" 在字母前面）。
    expect(stats.byAccount.map((g) => [g.key, g.requests, g.failed])).toEqual([["work", 2, 0], ["-", 1, 1], ["home", 1, 1]]);
    expect(stats.byRoute.map((g) => [g.key, g.requests])).toEqual([["start-plan", 2], ["-", 1], ["coding-plan", 1]]);
    expect(stats.byModel.map((g) => [g.key, g.requests])).toEqual([["glm-4.6", 2], ["-", 1], ["glm-5.2", 1]]);
    expect(stats.byApiKey.map((g) => [g.key, g.requests])).toEqual([["-", 2], ["k1", 2]]);
    expect(stats.byProtocol.map((g) => [g.key, g.requests])).toEqual([["anthropic", 2], ["openai", 2]]);
    expect(stats.byClientKind.map((g) => [g.key, g.requests])).toEqual([["-", 2], ["claude-code", 1], ["zcode", 1]]);
    // 组行带平均：#c 有 totalMs 才进 avg。
    expect(stats.byRoute.find((g) => g.key === "start-plan")).toMatchObject({ failed: 1 });
  });

  it("sorts groups by requests desc then key asc (deterministic)", () => {
    writeLines([
      record({ reqId: "#a", model: "b-model" }),
      record({ reqId: "#b", model: "a-model" }),
      record({ reqId: "#c", model: "a-model" }),
      record({ reqId: "#d", model: "c-model" }),
    ]);
    const stats = computeUsageStats({ path });
    // 四组各 1 条（无 "-" 组：model 都给了），并列按键名升序。
    expect(stats.byModel.map((g) => g.key)).toEqual(["a-model", "b-model", "c-model"]);
  });
});

describe("computeUsageStats — errors and schedule", () => {
  it("groups by the errorCode written at the source — zero message guessing", () => {
    /* 分类只看 errorCode：同一段被改过的消息文案在不同码下各归各位，
       旧记录缺码落 other，不再有 startsWith/includes 前缀表。*/
    writeLines([
      record({ reqId: "#a", failedStage: "dispatch", errorCode: "queue-timeout", error: "words changed on purpose" }),
      record({ reqId: "#b", failedStage: "dispatch", errorCode: "queue-timeout", error: "no concurrency slot" }),
      record({ reqId: "#c", failedStage: "dispatch", errorCode: "accounts-saturated", error: "every candidate account is at its concurrency limit" }),
      record({ reqId: "#d", failedStage: "upstream-resp", errorCode: "upstream-gateway", error: "upstream returned 500" }),
      record({ reqId: "#e", failedStage: "upstream-resp", errorCode: "upstream-gateway", error: "upstream returned 500" }),
      record({ reqId: "#f", failedStage: "upstream-resp", errorCode: "upstream-auth-rejected", error: "JWT rejected upstream" }),
      record({ reqId: "#g", failedStage: "translate", errorCode: "translate-failed", error: "upstream returned non-JSON body: <html>" }),
      record({ reqId: "#h", failedStage: "translate", error: "legacy record without errorCode" }),
    ]);
    const stats = computeUsageStats({ path });
    // 排序：count 降序，并列按 stage、errorCode 升序。
    expect(stats.errors).toEqual([
      { stage: "dispatch", kind: "queue-timeout", count: 2 },
      { stage: "upstream-resp", kind: "upstream-gateway", count: 2 },
      { stage: "dispatch", kind: "accounts-saturated", count: 1 },
      { stage: "translate", kind: "other", count: 1 },
      { stage: "translate", kind: "translate-failed", count: 1 },
      { stage: "upstream-resp", kind: "upstream-auth-rejected", count: 1 },
    ]);
    expect(stats.totals.errorCount).toBe(8);
    // queueTimeout 读结构化码：队列满不再算进来。
    expect(stats.schedule.queueTimeout).toBe(2);
    expect(stats.schedule.cooled).toBe(0);
    expect(stats.schedule.degraded).toBe(0);
  });

  it("every errorCode in the full table is a valid stats key, and unknown codes fall back", () => {
    writeLines(
      ERROR_CODES.map((code, index) => record({
        reqId: `#${index}`,
        failedStage: "dispatch",
        errorCode: code,
        error: "the same text for every code — classification must not read it",
      })).concat([
        // 外部写坏的值 = 旧记录缺码的同类：other 兜底，不猜。
        { ...record({ reqId: "#bad", failedStage: "dispatch", error: "x" }), errorCode: "made-up" as unknown as ErrorCode },
      ]),
    );
    const stats = computeUsageStats({ path });
    const byCode = new Map(stats.errors.map((row) => [row.kind, row.count]));
    for (const code of ERROR_CODES) expect(byCode.get(code)).toBe(code === "other" ? 2 : 1);
    expect([...byCode.keys()]).not.toContain("made-up");
    expect(stats.totals.errorCount).toBe(ERROR_CODES.length + 1);
  });

  it("extracts degraded/cooled from structured retry events", () => {
    writeLines([
      record({
        reqId: "#a",
        status: 200,
        stages: [
          { stage: "retry", atMs: 10, fields: { event: "auth-rotation", reason: "upstream_401" } },
          { stage: "retry", atMs: 20, fields: { event: "highspeed-fallback", reason: "card-expired" } },
          { stage: "retry", atMs: 30, fields: { event: "ticket-expired" } },
        ],
      }),
    ]);
    const stats = computeUsageStats({ path });
    expect(stats.schedule).toEqual({ degraded: 1, cooled: 1, queueTimeout: 0 });
    // ticket-expired 不是失败也不是降级：不计。
    expect(stats.totals.failed).toBe(0);
  });
});

describe("computeUsageStats — cacheHit (valid-sample semantics)", () => {
  /**
   * 命中率口径：读 / (输入 + 读 + 写)。
   *
   * 数据层不自己算比率（它只累加三个桶），UI 在 `app-view-stats.js::renderCache`
   * 里用同一条式子。测试把它写成一个函数，是为了把「口径」钉在断言里而不是散在
   * 注释里：改口径必须同时改这里。
   */
  function hitRate(hit: UsageStatsCacheHit): number {
    const denominator = hit.inputTokens + hit.readTokens + hit.creationTokens;
    return denominator > 0 ? hit.readTokens / denominator : 0;
  }

  it("counts only records where the upstream reported a cache bucket; 0 is a sample", () => {
    writeLines([
      record({ reqId: "#a", cacheReadTokens: 1216, cacheCreationTokens: 4, inputTokens: 10, status: 200 }),
      record({ reqId: "#b", cacheReadTokens: 0, inputTokens: 20, status: 200 }),
      record({ reqId: "#c", inputTokens: 30, status: 200 }), // 上游没报缓存桶
      record({ reqId: "#d", cacheCreationTokens: 9, inputTokens: 40, status: 200 }), // 只报写桶
    ]);
    const stats = computeUsageStats({ path });
    // 输入只累加读桶在场的两条（#a 10 + #b 20）：#c 没缓存桶、#d 只报写桶，都不进。
    expect(stats.cacheHit).toEqual({ samples: 2, inputTokens: 30, readTokens: 1216, creationTokens: 13, creationSamples: 2 });
    // 旧记录（无新字段）参与 token 统计，不进缓存分母。
    expect(stats.totals.inputTokens).toBe(100);
    // 小时桶同一口径。
    expect(stats.hourly[0]).toMatchObject({ requests: 4, cacheHitSamples: 2, cacheReadTokens: 1216 });
  });

  it("hit rate stays below 100% when no record carries a creation bucket", () => {
    // 真实日志的形状：上游只报 cache_read，cache_creation 一条都没有。
    // 旧公式 read / (read + creation) 在这份数据上恒为 100%（分母只剩读）。
    writeLines([
      record({ reqId: "#a", inputTokens: 100, cacheReadTokens: 900, status: 200 }),
      record({ reqId: "#b", inputTokens: 100, cacheReadTokens: 900, status: 200 }),
    ]);
    const stats = computeUsageStats({ path });
    expect(stats.cacheHit).toEqual({ samples: 2, inputTokens: 200, readTokens: 1800, creationTokens: 0, creationSamples: 0 });
    expect(hitRate(stats.cacheHit)).toBeCloseTo(0.9, 12);
    expect(hitRate(stats.cacheHit)).toBeLessThan(1);
    // 写桶的「未上报」是 `creationSamples = 0` 这个事实，不是 creationTokens = 0 这个数字。
    expect(stats.cacheHit.creationSamples).toBe(0);
  });

  it("counts input + read + creation in the denominator and yields the exact rate", () => {
    writeLines([
      record({ reqId: "#a", inputTokens: 50, cacheReadTokens: 700, cacheCreationTokens: 250, status: 200 }),
      record({ reqId: "#b", inputTokens: 50, cacheReadTokens: 100, cacheCreationTokens: 0, status: 200 }),
    ]);
    const stats = computeUsageStats({ path });
    expect(stats.cacheHit).toEqual({ samples: 2, inputTokens: 100, readTokens: 800, creationTokens: 250, creationSamples: 2 });
    // 读 800 / (输入 100 + 读 800 + 写 250)
    expect(hitRate(stats.cacheHit)).toBeCloseTo(800 / 1150, 12);
  });
});

describe("computeUsageStats — file robustness", () => {
  it("skips bad lines and keeps counting good ones", () => {
    writeFileSync(path, [
      JSON.stringify(record({ reqId: "#a", status: 200, inputTokens: 5 })),
      "{\"reqId\": \"#broken\", \"startedAt\": \"not-a-number\"", // 半行（进程被杀）
      "not json at all",
      JSON.stringify(record({ reqId: "#b", status: 200, inputTokens: 7 })),
    ].join("\n") + "\n", "utf-8");
    const stats = computeUsageStats({ path });
    expect(stats.totals.requests).toBe(2);
    expect(stats.totals.inputTokens).toBe(12);
  });

  it("reads long lines split across chunk boundaries (64KB record)", () => {
    const bigField = "x".repeat(70_000);
    writeLines([
      record({ reqId: "#big", status: 200, error: undefined }),
      // 单行超过 70KB：跨 readLinesBackward 的 64KB 块边界。error 是字符串字段，
      // 巨行保护上限是 1MB，不触发丢弃。
      record({ reqId: "#b", status: 200, stages: [{ stage: "note", atMs: 0, fields: { blob: bigField } }] }),
    ]);
    const stats = computeUsageStats({ path });
    expect(stats.totals.requests).toBe(2);
    expect(stats.byAccount[0].requests).toBe(2);
  });

  it("empty file → empty stats, range without bounds", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "", "utf-8");
    const stats = computeUsageStats({ path });
    expect(stats.totals.requests).toBe(0);
    expect(stats.hourly).toEqual([]);
    expect(stats.daily).toEqual([]);
    expect(stats.range.records).toBe(0);
    expect(stats.range.from).toBeUndefined();
    expect(stats.range.to).toBeUndefined();
  });

  it("missing file → same as empty", () => {
    const stats = computeUsageStats({ path: join(dir, "nope.jsonl") });
    expect(stats.totals.requests).toBe(0);
    expect(stats.cacheHit).toEqual({ samples: 0, inputTokens: 0, readTokens: 0, creationTokens: 0, creationSamples: 0 });
  });
});

describe("computeUsageStats — time range", () => {
  it("filters on startedAt in [from, to] (inclusive both ends) and stops early below from", () => {
    writeLines([
      record({ reqId: "#old", startedAt: T0 - HOUR, endedAt: T0 - HOUR + 1000, status: 200 }),
      record({ reqId: "#edge-in", startedAt: T0, endedAt: T0 + 1000, status: 200 }),
      record({ reqId: "#mid", startedAt: T0 + HOUR, endedAt: T0 + HOUR + 1000, status: 200, inputTokens: 9 }),
      record({ reqId: "#edge-out", startedAt: T0 + 2 * HOUR, endedAt: T0 + 2 * HOUR + 1000, status: 200 }),
    ]);
    const stats = computeUsageStats({ path, from: T0, to: T0 + HOUR });
    expect(stats.range.records).toBe(2);
    expect(stats.range.from).toBe(T0);
    expect(stats.range.to).toBe(T0 + HOUR);
    expect(stats.totals.inputTokens).toBe(9);
    // 开始早于 from、结束晚于 from 的跨界记录：不计（startedAt 口径），也不挡提前停。
    writeLines([
      record({ reqId: "#cross", startedAt: T0 - HOUR, endedAt: T0 + 5000, status: 200 }),
      record({ reqId: "#in", startedAt: T0 + HOUR, endedAt: T0 + HOUR + 10, status: 200, inputTokens: 3 }),
    ]);
    const crossing = computeUsageStats({ path, from: T0 });
    expect(crossing.range.records).toBe(1);
    expect(crossing.totals.inputTokens).toBe(3);
  });

  it("invalid from/to fall back to unbounded (getRequestsHistory 的非法游标纪律)", () => {
    writeLines([record({ reqId: "#a", status: 200 })]);
    expect(computeUsageStats({ path, from: 0 }).range.records).toBe(1);
    expect(computeUsageStats({ path, from: -5 }).range.records).toBe(1);
    expect(computeUsageStats({ path, to: Number.NaN }).range.records).toBe(1);
    expect(computeUsageStats({ path, from: Number.POSITIVE_INFINITY }).range.records).toBe(1);
    expect(computeUsageStats({ path, from: "yesterday" as unknown as number }).range.records).toBe(1);
  });
});

describe("computeUsageStats — old records without the new fields (兼容)", () => {
  it("hydrates old-shape lines: no cache fields, no clientKind, tokens still counted", () => {
    // 直接写旧形状（没有 cacheReadTokens / cacheCreationTokens / clientKind）。
    const oldRecord = {
      reqId: "#old-1",
      startedAt: T0,
      endedAt: T0 + 1000,
      format: "anthropic",
      model: "glm-4.6",
      stream: true,
      requestBytes: 100,
      status: 200,
      inputTokens: 11,
      outputTokens: 3,
      ttfbMs: 50,
      totalMs: 1000,
      tps: 8,
      retries: 0,
      stages: [{ stage: "stream-end", atMs: 1000, fields: { tokens: 3 } }],
      apiKeyId: "",
    };
    writeFileSync(path, JSON.stringify(oldRecord) + "\n", "utf-8");
    const stats = computeUsageStats({ path });
    expect(stats.totals).toMatchObject({ requests: 1, ok: 1, inputTokens: 11, outputTokens: 3 });
    expect(stats.cacheHit).toEqual({ samples: 0, inputTokens: 0, readTokens: 0, creationTokens: 0, creationSamples: 0 });
    // 旧记录没有 clientKind，但 totalMs/tps 在场：组平均照算。
    expect(stats.byClientKind).toEqual([{ key: "-", requests: 1, failed: 0, inputTokens: 11, outputTokens: 3, avgTotalMs: 1000, avgTps: 8 }]);
    expect(stats.hourly[0]).toMatchObject({ requests: 1, cacheHitSamples: 0, cacheReadTokens: 0 });
  });
});

/**
 * 新字段的聚合。每个 describe 对应一个**读取点**：这些断言就是那些字段
 * 「有人读」的证据（「有写入点、零读取点」是审计里最容易漏的形态）。
 */
describe("computeUsageStats — retries", () => {
  it("counts retried records over valid samples only (old records have no upstreamAttempts)", () => {
    writeLines([
      record({ reqId: "#a", upstreamAttempts: 1 }),
      record({ reqId: "#b", upstreamAttempts: 2 }),
      record({ reqId: "#c", upstreamAttempts: 3, retries: 1 }),
      // 旧记录：没有 upstreamAttempts，不进分母。
      record({ reqId: "#d" }),
    ]);
    const stats = computeUsageStats({ path });
    expect(stats.retries).toEqual({ samples: 3, retried: 2, attempts: 6, rotations: 1, rate: 2 / 3 });
    // 「换号」与「尝试」是两个数：这次三条样本里只有一条换了号。
    expect(stats.retries.rotations).toBe(1);
  });

  it("omits rate when there is no sample at all, and treats a non-number as absent", () => {
    writeLines([record({ reqId: "#a" })]);
    const stats = computeUsageStats({ path });
    expect(stats.retries).toEqual({ samples: 0, retried: 0, attempts: 0, rotations: 0 });
    expect(stats.retries.rate).toBeUndefined();

    // 坏行：字段被写成字符串（手改过的文件）。不炸，且不进分母。
    writeFileSync(path, `${JSON.stringify(record({ reqId: "#b", upstreamAttempts: "2" as unknown as number }))}\n`, "utf-8");
    const corrupted = computeUsageStats({ path });
    expect(corrupted.retries.samples).toBe(0);
    expect(corrupted.retries.attempts).toBe(0);
  });
});

describe("computeUsageStats — queue", () => {
  it("averages queueMs and keeps the peak (async ticket waits are hours long)", () => {
    writeLines([
      record({ reqId: "#a", queueMs: 0 }),
      record({ reqId: "#b", queueMs: 30 }),
      record({ reqId: "#c", queueMs: 3 * 3_600_000 }),
      record({ reqId: "#d" }),
    ]);
    const stats = computeUsageStats({ path });
    expect(stats.queue.samples).toBe(3);
    expect(stats.queue.totalMs).toBe(30 + 3 * 3_600_000);
    expect(stats.queue.avgMs).toBe((30 + 3 * 3_600_000) / 3);
    expect(stats.queue.maxMs).toBe(3 * 3_600_000);
  });

  it("omits the derived values when no record carries queueMs", () => {
    writeLines([record({ reqId: "#a" })]);
    const stats = computeUsageStats({ path });
    expect(stats.queue).toEqual({ samples: 0, totalMs: 0 });
    expect(stats.queue.avgMs).toBeUndefined();
    expect(stats.queue.maxMs).toBeUndefined();
  });
});

describe("computeUsageStats — bytes", () => {
  it("sums both sides over their own samples and averages the per-record ratio", () => {
    writeLines([
      // 100 B 请求 / 900 B 响应 → 9x
      record({ reqId: "#a", requestBytes: 100, responseBytes: 900 }),
      // 200 B 请求 / 200 B 响应 → 1x
      record({ reqId: "#b", requestBytes: 200, responseBytes: 200 }),
      // 只观测到请求侧（直传非流式没有 content-length）→ 不进响应分母与比值
      record({ reqId: "#c", requestBytes: 300 }),
    ]);
    const stats = computeUsageStats({ path });
    expect(stats.bytes).toMatchObject({
      requestSamples: 3,
      requestBytes: 600,
      avgRequestBytes: 200,
      responseSamples: 2,
      responseBytes: 1100,
      avgResponseBytes: 550,
      ratioSamples: 2,
    });
    // 先逐条求比再平均：8.9 MB 的请求不会把其余几百条吃掉。
    expect(stats.bytes.ratio).toBe(5);
  });

  it("skips the ratio for an empty request body instead of producing Infinity", () => {
    writeLines([record({ reqId: "#a", requestBytes: 0, responseBytes: 500 })]);
    const stats = computeUsageStats({ path });
    expect(stats.bytes.ratioSamples).toBe(0);
    expect(stats.bytes.ratio).toBeUndefined();
    expect(stats.bytes.responseBytes).toBe(500);
  });
});

describe("computeUsageStats — aborted + byReasoningEffort", () => {
  it("counts client aborts separately from failures and groups by reasoning effort", () => {
    writeLines([
      record({ reqId: "#a", reasoningEffort: "high", status: 200 }),
      record({ reqId: "#b", reasoningEffort: "high", status: 200 }),
      record({ reqId: "#c", clientAborted: true, failedStage: "upstream-req", error: "client aborted", status: 502 }),
      // 旧记录：既没有 reasoningEffort 也没有 clientAborted。
      record({ reqId: "#d", status: 200 }),
    ]);
    const stats = computeUsageStats({ path });
    expect(stats.totals.aborted).toBe(1);
    // 断连不从 failed 里扣除：「上游失败之后客户端又断开」两个事实都成立。
    expect(stats.totals.failed).toBe(1);
    expect(stats.byReasoningEffort.map((g) => [g.key, g.requests])).toEqual([["-", 2], ["high", 2]]);
  });

  it("leaves aborted at 0 when no record carries the flag", () => {
    writeLines([record({ reqId: "#a" })]);
    expect(computeUsageStats({ path }).totals.aborted).toBe(0);
  });
});

describe("computeUsageStats — heatmap", () => {
  /** `/mcp` 记录的判据形状：`countDataPlane` 打的 `route` stage（server.ts）。 */
  function mcpStage(method: string, path: string) {
    return { stage: "route", atMs: 1, fields: { path: `${method} ${path}` } };
  }

  it("folds daily cells with tokens and MCP calls attributed from /mcp route records", () => {
    // T0 是 UTC 22:13，+2h 会跨日——一律从当天零点起排，保证同一日桶。
    const dayStart = Math.floor(T0 / 86_400_000) * 86_400_000;
    writeLines([
      record({ reqId: "#a", startedAt: dayStart + HOUR, inputTokens: 300, outputTokens: 200 }),
      record({ reqId: "#b", startedAt: dayStart + 2 * HOUR, stages: [mcpStage("POST", "/mcp")] }),
      record({ reqId: "#c", startedAt: dayStart + 3 * HOUR, stages: [mcpStage("GET", "/mcp")] }),
      // /v1/models 也是 countDataPlane 记录，但不是 MCP 消耗。
      record({ reqId: "#d", startedAt: dayStart + 4 * HOUR, stages: [mcpStage("GET", "/v1/models")] }),
    ]);
    const { heatmap } = computeUsageStats({ path });
    // 无 from/to 不补零：一个日格。
    expect(heatmap.daily).toHaveLength(1);
    expect(heatmap.daily[0]!.tokens).toBe(500);
    expect(heatmap.daily[0]!.mcpCalls).toBe(2);
    // 累计视图同一格就是总量。
    expect(heatmap.cumulative).toEqual(heatmap.daily);
  });

  it("aggregates weekly cells from Monday UTC and accumulates cumulative cells day by day", () => {
    // 2023-11-13 是周一（UTC 零点）。前三天是周日，归「上一周」。
    const week2mon = 1_699_833_600_000;
    writeLines([
      record({ reqId: "#a", startedAt: week2mon - 86_400_000, inputTokens: 100, outputTokens: 0 }),
      record({ reqId: "#b", startedAt: week2mon + HOUR, inputTokens: 10, outputTokens: 0, stages: [mcpStage("POST", "/mcp")] }),
      record({ reqId: "#c", startedAt: week2mon + 86_400_000 + HOUR, inputTokens: 20, outputTokens: 0, stages: [mcpStage("POST", "/mcp")] }),
    ]);
    const from = week2mon - 86_400_000;
    const to = week2mon + 86_400_000 + HOUR;
    const { heatmap } = computeUsageStats({ path, from, to });
    expect(heatmap.daily.map((c) => c.tokens)).toEqual([100, 10, 20]);
    expect(heatmap.daily.map((c) => c.mcpCalls)).toEqual([0, 1, 1]);
    // 周格：周一起算。周日（前一天）归上周一（week2mon - 7 天），周一周二归本周一。
    expect(heatmap.weekly.map((c) => [c.bucketStart, c.tokens, c.mcpCalls])).toEqual([
      [week2mon - 7 * 86_400_000, 100, 0],
      [week2mon, 30, 2],
    ]);
    // 累计逐日递增。
    expect(heatmap.cumulative.map((c) => c.tokens)).toEqual([100, 110, 130]);
    expect(heatmap.cumulative.map((c) => c.mcpCalls)).toEqual([0, 1, 2]);
  });

  it("zero-fills heatmap cells along with daily buckets when both bounds are given", () => {
    writeLines([record({ reqId: "#a", startedAt: T0, inputTokens: 7, outputTokens: 3 })]);
    const from = Math.floor(T0 / 86_400_000) * 86_400_000;
    const { heatmap } = computeUsageStats({ path, from, to: from + 2 * 86_400_000 });
    expect(heatmap.daily).toHaveLength(3);
    expect(heatmap.daily.map((c) => c.tokens)).toEqual([10, 0, 0]);
    expect(heatmap.cumulative.map((c) => c.tokens)).toEqual([10, 10, 10]);
  });
});
