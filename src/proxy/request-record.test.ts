/**
 * `RequestRecord` / `RequestStore` / `printRow(record)` 的用例。
 *
 * 三条要紧的事各有一组：
 *
 * 1. **记录是请求的一等公民**：一次请求结束后 `recent(1)` 拿到的是完整的一条（阶段、
 *    调度、出线、响应、归因都在里面），不是从日志行拼回来的视图。
 * 2. **换号重放不切出第二条请求**：`retries` 加一，`recent` 里仍然只有一条。
 * 3. **表格形状钉住了**：`renderRow` 除账号列之外，与重构前的
 *    `printRow` 逐字节相同。基线有两层：旧实现原样抄下来、入参还是九个位置参数的
 *    `legacyTableRow` / `legacyCompactRow`（挖掉账号列就该与它们一模一样），以及三个
 *    用例各自的固定期望字符串（连账号列长什么样一起钉住）。抄一份而不是「看着像对就对」
 *    的理由：这一行是用户每天在终端里读的东西，列宽差一个空格也算改了行为。
 */
import { describe, expect, it } from "bun:test";
import { REQUEST_STORE_CAPACITY, RequestStore, addStage, failStage, markClientAborted, nextReqId, noteUpstreamAttempt, peekBody } from "./request-record.js";
import type { RequestRecord } from "./request-record.js";
import { HEADER_ROW, HEADER_RULE, renderRow } from "./handler-log.js";
import { proxyRequest } from "./handler.js";
import { accountFor, inMemoryAccounts, zhipuCredential } from "../accounts/testing.js";
import { defaultPolicy } from "../accounts/types.js";
import type { Account, Credential, RouteKind } from "../accounts/types.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";

const IDENTITY: ProxyIdentity = {
  appVersion: "test-1.0.0",
  appVersionSource: "default",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
  betaPolicy: "drop",
  betaAllowlist: [],
};

const CONFIG: ProxyConfig = {
  server: { port: 8080, host: "0.0.0.0" },
  auth: { requireKey: false },
  providers: {
    zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
    bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
  },
  defaultModel: "glm-4.6",
  models: ["glm-4.6"],
  identity: IDENTITY,
  clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
  responses: { storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false },
  highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
  mcp: { enabled: true, gateway: { enabled: true, upstreamOrigin: "https://zcode.z.ai" } },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, sprintWindowMs: 1800000, sprintPollIntervalMs: 60000 },
  logging: { level: "info" },
};

const ANTHROPIC_OK = JSON.stringify({
  id: "msg_record",
  type: "message",
  role: "assistant",
  model: "glm-4.6",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 7, output_tokens: 3 },
});

function credential(tag: string): Credential {
  return zhipuCredential({ apiKey: `key-${tag}`, secret: `secret-${tag}`, jwt: `jwt-${tag}` });
}

function account(label: string, routes: RouteKind[] = ["coding-plan"]): Account {
  return accountFor(credential(label), { label, routes, policy: defaultPolicy({ maxConcurrency: 2 }) });
}

function clientReq(): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-4.6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });
}

function okFetch(): typeof fetch {
  return (async () => new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

function emptyRecord(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    reqId: "#001",
    startedAt: 0,
    format: "anthropic",
    model: "glm-4.6",
    stream: false,
    requestBytes: 0,
    retries: 0,
    stages: [],
    apiKeyId: "",
    ...overrides,
  };
}

// ──────────────────────────────────────────────
// 旧实现的副本（重构前的 `printRow`，九个位置参数）。只作基线，别改。
//
// 它们没有账号列（那时候还不存在这个列），所以不能直接拿来比：新输出挖掉账号格之后
// 才应该与它们逐字节相同。保留原样是基线证据，改了就不是「旧实现」了。
// ──────────────────────────────────────────────

function legacyFmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

function legacyLocalTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function legacyTableRow(
  reqId: string,
  format: "anthropic" | "openai",
  model: string,
  stream: boolean,
  status: number,
  started: number,
  headersAt: number,
  tokens: number,
  avgTps: number,
  streamEndAt: number,
): string {
  const tag = format === "anthropic" ? "ANT" : "OAI";
  const mode = stream ? "stream" : "batch";
  const ts = legacyLocalTime(started);
  const ttfb = `${headersAt - started}ms`;
  const total = streamEndAt > started ? `${streamEndAt - started}ms` : "-";
  const tok = tokens > 0 ? String(tokens) : "-";
  const tps = avgTps > 0 ? avgTps.toFixed(1) : "-";
  return `| ${reqId.padEnd(4)} | ${ts.padEnd(10)} | ${tag} | ${model.padEnd(11)} | ${mode.padEnd(6)} | ${String(status).padStart(4)} | ${ttfb.padStart(7)} | ${tok.padStart(5)} | ${tps.padStart(6)} | ${total.padStart(7)} |`;
}

function legacyCompactRow(
  reqId: string,
  format: "anthropic" | "openai",
  model: string,
  stream: boolean,
  status: number,
  started: number,
  headersAt: number,
  tokens: number,
  avgTps: number,
  streamEndAt: number,
): string {
  const tag = format === "anthropic" ? "ANT" : "OAI";
  const mode = stream ? "stream" : "batch";
  const ttfbMs = headersAt - started;
  const totalMs = streamEndAt > started ? streamEndAt - started : ttfbMs;
  const ttfbStr = legacyFmtMs(ttfbMs);
  const tokStr = tokens > 0 ? `${tokens}tok` : "";
  const tpsStr = avgTps > 0 ? `${avgTps.toFixed(0)}t/s` : "";
  const parts = [reqId, tag, model, String(status), mode];
  if (stream && streamEndAt > started) {
    parts.push(`${ttfbStr}→${legacyFmtMs(totalMs)}`);
  } else {
    parts.push(ttfbStr);
  }
  if (tokStr) parts.push(tokStr);
  if (tpsStr) parts.push(tpsStr);
  return parts.join(" ");
}

describe("RequestStore", () => {
  it("returns recent records newest first and evicts FIFO past the capacity", () => {
    const store = new RequestStore(3);
    for (const id of ["#001", "#002", "#003", "#004"]) {
      store.begin({ reqId: id, format: "anthropic", apiKeyId: "" });
    }

    expect(store.recent(10).map((record) => record.reqId)).toEqual(["#004", "#003", "#002"]);
    // 最老的那条已经被淘汰：按 reqId 也取不到，上限是有意的。
    expect(store.get("#001")).toBeUndefined();
    expect(store.get("#004")?.reqId).toBe("#004");
    expect(store.recent(0)).toEqual([]);
  });

  it("defaults to the named capacity constant", () => {
    const store = new RequestStore();
    for (let i = 0; i < REQUEST_STORE_CAPACITY + 5; i += 1) {
      store.begin({ reqId: `#${i}`, format: "openai", apiKeyId: "" });
    }
    expect(store.recent(REQUEST_STORE_CAPACITY + 100)).toHaveLength(REQUEST_STORE_CAPACITY);
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    const store = new RequestStore();
    const seen: string[] = [];
    const off = store.onChange((record) => seen.push(record.reqId));

    const record = store.begin({ reqId: "#001", format: "anthropic", apiKeyId: "" });
    store.notify(record);
    off();
    store.notify(record);

    expect(seen).toEqual(["#001"]);
  });

  it("keeps a throwing subscriber from breaking the others", () => {
    const store = new RequestStore();
    const seen: string[] = [];
    store.onChange(() => {
      throw new Error("subscriber blew up");
    });
    store.onChange((record) => seen.push(record.reqId));

    const record = store.begin({ reqId: "#001", format: "anthropic", apiKeyId: "" });
    expect(() => store.notify(record)).not.toThrow();
    expect(seen).toEqual(["#001"]);
  });

  it("records stages with a request-relative offset and failure facts in one place", () => {
    const record = emptyRecord({ startedAt: Date.now() - 50 });
    addStage(record, "intake", { bytes: 12 });
    failStage(record, "captcha", "solver exploded");

    expect(record.stages.map((stage) => stage.stage)).toEqual(["intake", "captcha"]);
    expect(record.stages[0]!.atMs).toBeGreaterThanOrEqual(50);
    // 失败同时落两处：汇总表读 failedStage / error，时间线读那一条阶段。
    expect(record.failedStage).toBe("captcha");
    expect(record.error).toBe("solver exploded");
    expect(record.stages[1]!.fields).toEqual({ error: "solver exploded" });
  });

  it("peekBody answers the shape and degrades to the placeholder", () => {
    expect(peekBody('{"model":"glm-4.6","stream":true}')).toEqual({ model: "glm-4.6", stream: true });
    expect(peekBody('{"messages":[]}')).toEqual({ model: "-", stream: false });
    expect(peekBody("not json")).toEqual({ model: "-", stream: false });
    expect(peekBody(undefined)).toEqual({ model: "-", stream: false });
  });

  it("peekBody carries reasoningEffort from the same parse", () => {
    // 三套协议的词汇都在 `reasoning-effort.ts` 里收敛，peekBody 只负责把它搭出来
    // （与 model/stream 共用一次 JSON.parse，见函数注释）。
    expect(peekBody('{"model":"glm-5.3","reasoning_effort":"high"}')).toEqual({ model: "glm-5.3", stream: false, reasoningEffort: "high" });
    expect(peekBody('{"model":"glm-5.3","thinking":{"type":"enabled","budget_tokens":8000}}')).toEqual({ model: "glm-5.3", stream: false, reasoningEffort: "low" });
    expect(peekBody('{"reasoning":{"effort":"medium"}}')).toEqual({ model: "-", stream: false, reasoningEffort: "medium" });
    // 没表达意图时整键省略：记录上不落一个无意义的默认值。
    expect(peekBody('{"model":"glm-4.6"}')).not.toHaveProperty("reasoningEffort");
  });

  it("noteUpstreamAttempt / markClientAborted keep the request fields honest", () => {
    const record = emptyRecord();
    // 首次调用就把 undefined 变成 1（“一次都没出线”与“出线一次”是两个事实）。
    noteUpstreamAttempt(record);
    expect(record.upstreamAttempts).toBe(1);
    noteUpstreamAttempt(record);
    expect(record.upstreamAttempts).toBe(2);
    // clientAborted 只落 true，从不写 false（旧记录没有这个键）。
    markClientAborted(record);
    expect(record.clientAborted).toBe(true);
    expect(emptyRecord().clientAborted).toBeUndefined();
  });
});

describe("hydrate 旧记录（兼容）", () => {
  it("hydrates records that lack the newer fields without rewriting them", () => {
    const store = new RequestStore();
    // 旧版落盘的一行：没有 reasoningEffort / upstreamAttempts / responseBytes /
    // clientAborted。hydrate 不做字段校验，原样收下；读的人自己按“缺省”处理。
    const old = emptyRecord({ reqId: "#old-1", requestBytes: 100, retries: 0 });
    store.hydrate([old]);
    const hydrated = store.get("#old-1")!;
    expect(hydrated).toBe(old);
    expect(hydrated.reasoningEffort).toBeUndefined();
    expect(hydrated.upstreamAttempts).toBeUndefined();
    expect(hydrated.responseBytes).toBeUndefined();
    expect(hydrated.clientAborted).toBeUndefined();
  });
});

describe("printRow(record) 的表格形状", () => {
  // 三个用例的 startedAt 相同。时刻按本地时区渲染，所以期望值里不能用写死的时间，
  // 用同一个基准算一次再拼进模板。
  const STARTED = 1_700_000_000_000;
  const TS = legacyLocalTime(STARTED);

  /**
   * 把新输出里的账号格挖掉（`Time` 之后的那一格，连同它的分隔符），剩下的就是旧实现。
   *
   * 前缀宽度 = `| ` + reqId(9) + ` | ` + time(10) + ` | ` = 27；账号格 9 加它后面的
   * ` | ` 共 12。两种宽度的真值都在 `handler-log.ts` 里，这里只用来验证「除账号列外
   * 逐字节相同」。
   */
  const ACCOUNT_CELL_START = 27;
  const ACCOUNT_CELL_END = ACCOUNT_CELL_START + 9 + 3;

  function withoutAccountColumn(row: string): string {
    return row.slice(0, ACCOUNT_CELL_START) + row.slice(ACCOUNT_CELL_END);
  }

  /** compact 是空格分隔的，账号是第二个字段。*/
  function withoutCompactAccount(row: string): string {
    const [reqId, , ...rest] = row.split(" ");
    return [reqId, ...rest].join(" ");
  }

  /** 三种典型行：批量成功、流式带用量、失败（没有 token）。三种都带账号。
   *
   * reqId 用 11 字符形状（`#a1b2cd-007`）：这样 `padEnd(11)` 在两边都是空操作，
   * 「挖掉账号列等于旧实现」的基线只衡量账号列本身。
   */
  const cases: { name: string; record: RequestRecord; table: string; compact: string }[] = [
    {
      name: "批量成功",
      record: emptyRecord({ reqId: "#a1b2cd-007", startedAt: STARTED, status: 200, ttfbMs: 42, outputTokens: 8, account: "work-team" }),
      table: `| #a1b2cd-007 | ${TS}   | work-team | ANT | glm-4.6     | batch  |  200 |    42ms |     8 |      - |       - |`,
      compact: "#a1b2cd-007 work-team ANT glm-4.6 200 batch 42ms 8tok",
    },
    {
      name: "流式带用量与总耗时",
      record: emptyRecord({
        reqId: "#a1b2cd-123",
        startedAt: STARTED,
        format: "openai",
        stream: true,
        status: 200,
        ttfbMs: 1234,
        totalMs: 65_000,
        outputTokens: 512,
        tps: 12.34,
        account: "work-team",
      }),
      table: `| #a1b2cd-123 | ${TS}   | work-team | OAI | glm-4.6     | stream |  200 |  1234ms |   512 |   12.3 | 65000ms |`,
      compact: "#a1b2cd-123 work-team OAI glm-4.6 200 stream 1.2s→1m5s 512tok 12t/s",
    },
    {
      name: "失败：没有 token，也没有结束时刻",
      record: emptyRecord({ reqId: "#a1b2cd-099", startedAt: STARTED, status: 503, ttfbMs: 5, account: "work-team" }),
      table: `| #a1b2cd-099 | ${TS}   | work-team | ANT | glm-4.6     | batch  |  503 |     5ms |     - |      - |       - |`,
      compact: "#a1b2cd-099 work-team ANT glm-4.6 503 batch 5ms",
    },
  ];

  for (const testCase of cases) {
    it(`table: ${testCase.name}`, () => {
      const r = testCase.record;
      const legacy = legacyTableRow(
        r.reqId,
        r.format,
        r.model,
        r.stream,
        r.status ?? 0,
        r.startedAt,
        r.startedAt + (r.ttfbMs ?? 0),
        r.outputTokens ?? 0,
        r.tps ?? 0,
        r.totalMs !== undefined ? r.startedAt + r.totalMs : 0,
      );
      // 基线一：挖掉账号格之后与旧实现逐字节相同。
      expect(withoutAccountColumn(renderRow(r, false))).toBe(legacy);
      // 基线二：固定期望值，连账号列的位置与左对齐一起钉住。
      expect(renderRow(r, false)).toBe(testCase.table);
    });

    it(`compact: ${testCase.name}`, () => {
      const r = testCase.record;
      const legacy = legacyCompactRow(
        r.reqId,
        r.format,
        r.model,
        r.stream,
        r.status ?? 0,
        r.startedAt,
        r.startedAt + (r.ttfbMs ?? 0),
        r.outputTokens ?? 0,
        r.tps ?? 0,
        r.totalMs !== undefined ? r.startedAt + r.totalMs : 0,
      );
      expect(withoutCompactAccount(renderRow(r, true))).toBe(legacy);
      expect(renderRow(r, true)).toBe(testCase.compact);
    });
  }
});

/** 一行的列数：`|` 的个数减掉首尾两个空片（`|` 数量必须与列数一致）。*/
function columnCount(headerOrRow: string): number {
  return headerOrRow.split("|").length - 2;
}

describe("账号列：这次请求去了哪个账号", () => {
  const STARTED = 1_700_000_000_000;

  function row(account?: string): string {
    return renderRow(
      emptyRecord({ reqId: "#001", startedAt: STARTED, status: 200, ttfbMs: 42, outputTokens: 8, account }),
      false,
    );
  }

  it("有账号时在 Time 之后、Fmt 之前出现 label", () => {
    const line = row("work-team");
    expect(line).toContain("| work-team | ANT |");
    const cells = line.slice(1, -1).split("|");
    expect(cells[0]!.trim()).toBe("#001");
    expect(cells[1]!.trim()).toBe(legacyLocalTime(STARTED));
    expect(cells[2]!.trim()).toBe("work-team");
    expect(cells[3]!.trim()).toBe("ANT");
  });

  it("没有账号时那一格是 -，不编造值", () => {
    expect(row(undefined)).toContain("| -         | ANT |");
  });

  it("超长 label 只留前 9 个字符，且不加省略号", () => {
    const line = row("a-very-long-account-label");
    expect(line).toContain("| a-very-lo | ANT |");
    // 截断而不是撑破：整行宽度仍与表头一致。
    expect(line.length).toBe(HEADER_ROW.length);
    expect(line).not.toContain("…");
  });

  it("compact 带账号：账号在 reqId 之后", () => {
    const line = renderRow(
      emptyRecord({ reqId: "#001", startedAt: STARTED, status: 200, ttfbMs: 42, outputTokens: 8, account: "work-team" }),
      true,
    );
    expect(line).toBe("#001 work-team ANT glm-4.6 200 batch 42ms 8tok");
  });

  it("compact 没有账号时也是 -", () => {
    const line = renderRow(
      emptyRecord({ reqId: "#001", startedAt: STARTED, status: 200, ttfbMs: 42, outputTokens: 8 }),
      true,
    );
    expect(line).toBe("#001 - ANT glm-4.6 200 batch 42ms 8tok");
  });

  it("compact 不截断长 label：空格分隔，列宽没有意义", () => {
    const line = renderRow(
      emptyRecord({
        reqId: "#001",
        startedAt: STARTED,
        status: 200,
        ttfbMs: 42,
        outputTokens: 8,
        account: "a-very-long-account-label",
      }),
      true,
    );
    expect(line).toBe("#001 a-very-long-account-label ANT glm-4.6 200 batch 42ms 8tok");
  });

  it("表头有 Acct，分隔线的宽度与列宽一致", () => {
    expect(HEADER_ROW).toContain("| Acct      |");
    // 11 列 = 12 个 `|`。行与表头的列数必须相同，否则渲染错位。
    expect(columnCount(HEADER_ROW)).toBe(11);
    expect(columnCount(HEADER_RULE)).toBe(11);
    expect(columnCount(row("work-team"))).toBe(11);
    expect(columnCount(renderRow(emptyRecord({ startedAt: STARTED }), false))).toBe(11);
    // 分隔线每格 = 列宽 + 左右各一个空格。逐格对齐，Acct 那格是 11 个破折号。
    const headerCells = HEADER_ROW.slice(1, -1).split("|");
    const ruleCells = HEADER_RULE.slice(1, -1).split("|");
    expect(ruleCells.map((cell) => cell.length)).toEqual(headerCells.map((cell) => cell.length));
    expect(ruleCells[2]).toBe("-----------");
    // 表头那一格是 Acct（与设计稿和既有的 Stat / Tok 同一套缩写）。
    expect(HEADER_ROW.length).toBe(row("work-team").length);
  });
});

describe("reqId 跨重启唯一", () => {
  const STARTED = 1_700_000_000_000;
  /** `#` + 6 位 base36 进程标识 + `-` + 3 位进程内序号。*/
  const REQ_ID_SHAPE = /^#[0-9a-z]{6}-\d{3}$/;

  it("两次调用的形状都是 #xxxxxx-NNN，序号递增", () => {
    const first = nextReqId();
    const second = nextReqId();
    expect(first).toMatch(REQ_ID_SHAPE);
    expect(second).toMatch(REQ_ID_SHAPE);
    // 同一个进程里前缀相同，只有序号在动。
    expect(prefixOf(first)).toBe(prefixOf(second));
    expect(serialOf(second)).toBe(serialOf(first) + 1);
    expect(first.length).toBe(11);
  });

  it("同一进程内 id 不重复", () => {
    const ids = Array.from({ length: 500 }, () => nextReqId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("表格里 reqId 那一格宽 13（含两侧空格），与表头列数一致", () => {
    const line = renderRow(emptyRecord({ reqId: nextReqId(), startedAt: STARTED, status: 200, ttfbMs: 42 }), false);
    // 首格 = ` ` + reqId(11) + ` `，与表头的 `#` 那一格同宽。
    const reqIdCell = line.split("|")[1]!;
    expect(reqIdCell.length).toBe(13);
    expect(reqIdCell.startsWith(" #")).toBe(true);
    expect(reqIdCell.endsWith(" ")).toBe(true);
    // 列数一致 + 整行宽度与表头相同：11 字符的 id 不占用后面的列。
    expect(columnCount(line)).toBe(columnCount(HEADER_ROW));
    expect(line.length).toBe(HEADER_ROW.length);
    expect(HEADER_ROW.split("|")[1]!.length).toBe(13);
  });

  it("compact 形态原样包含完整 reqId", () => {
    const reqId = nextReqId();
    const line = renderRow(emptyRecord({ reqId, startedAt: STARTED, status: 200, ttfbMs: 42 }), true);
    expect(line.startsWith(`${reqId} `)).toBe(true);
    expect(line.split(" ")[0]).toBe(reqId);
  });
});

/** `#a1b2-001` → `#a1b2`。*/
function prefixOf(reqId: string): string {
  return reqId.slice(0, reqId.indexOf("-"));
}

/** `#a1b2-001` → 1。*/
function serialOf(reqId: string): number {
  return Number(reqId.slice(reqId.indexOf("-") + 1));
}

describe("proxyRequest 填 RequestRecord", () => {
  it("leaves one complete record behind after a finished request", async () => {
    const { broker } = inMemoryAccounts([account("a")], { routing: { order: ["coding-plan"], onSaturated: "wait" } });
    const requests = new RequestStore();

    const resp = await proxyRequest(clientReq(), "anthropic", {
      config: CONFIG,
      broker,
      requests,
      apiKeyId: "key-id-1",
      fetchImpl: okFetch(),
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    });
    expect(resp.status).toBe(200);
    await resp.text();

    const recent = requests.recent(1);
    expect(recent).toHaveLength(1);
    const record = recent[0]!;
    // 入站
    expect(record.format).toBe("anthropic");
    expect(record.model).toBe("glm-4.6");
    expect(record.stream).toBe(false);
    expect(record.requestBytes).toBeGreaterThan(0);
    // 调度
    expect(record.account).toBe("a");
    expect(record.route).toBe("coding-plan");
    expect(typeof record.queueMs).toBe("number");
    expect(record.retries).toBe(0);
    // 出线
    expect(record.upstreamFormat).toBe("anthropic");
    expect(record.upstreamUrl).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(typeof record.signed).toBe("boolean");
    expect(record.headerCount).toBeGreaterThan(0);
    // 响应
    expect(record.status).toBe(200);
    expect(typeof record.ttfbMs).toBe("number");
    expect(typeof record.totalMs).toBe("number");
    expect(record.contentEncoding).toBe("identity");
    // 归因与收尾
    expect(record.apiKeyId).toBe("key-id-1");
    expect(typeof record.endedAt).toBe("number");
    expect(record.failedStage).toBeUndefined();
    // 阶段时间线齐全且有序
    expect(record.stages.map((stage) => stage.stage)).toEqual([
      "intake",
      "dispatch",
      "session",
      "route-facts",
      "body",
      "highspeed",
      "upstream-req",
      "upstream-resp",
    ]);
    for (const stage of record.stages) expect(stage.atMs).toBeGreaterThanOrEqual(0);
  });

  it("reuses one record across an auth-failed rotation and counts it as one retry", async () => {
    const { broker } = inMemoryAccounts([account("a"), account("b")], {
      routing: { order: ["coding-plan"], onSaturated: "wait" },
    });
    const requests = new RequestStore();

    const seenKeys: string[] = [];
    const fetchImpl = (async (req: Request) => {
      const apiKey = req.headers.get("x-api-key") ?? "";
      seenKeys.push(apiKey);
      if (apiKey.startsWith("key-a.")) {
        return new Response(JSON.stringify({ error: { type: "authentication_error" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const resp = await proxyRequest(clientReq(), "anthropic", {
      config: CONFIG,
      broker,
      requests,
      fetchImpl,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    });
    expect(resp.status).toBe(200);
    await resp.text();

    // 两次上游调用 = 换号一次。
    expect(seenKeys).toHaveLength(2);
    // 用户看到的是「一次请求」，所以只有一条记录。
    expect(requests.recent(10)).toHaveLength(1);
    const record = requests.recent(1)[0]!;
    expect(record.retries).toBe(1);
    expect(record.account).toBe("b");
    expect(record.status).toBe(200);
    expect(record.stages.filter((stage) => stage.stage === "retry")).toHaveLength(1);
    expect(record.stages.find((stage) => stage.stage === "retry")?.fields.event).toBe("auth-rotation");
    expect(record.stages.find((stage) => stage.stage === "retry")?.fields.reason).toBe("upstream_401");
  });

  it("records the failing stage and reason when the request never reaches upstream", async () => {
    const { broker } = inMemoryAccounts([], { routing: { order: ["coding-plan"], onSaturated: "wait" } });
    const requests = new RequestStore();

    const resp = await proxyRequest(clientReq(), "anthropic", {
      config: CONFIG,
      broker,
      requests,
      fetchImpl: okFetch(),
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
    });

    // 没有账号可出线：503 no-account，失败阶段是 dispatch。
    expect(resp.status).toBe(503);
    await resp.text();
    const record = requests.recent(1)[0]!;
    expect(record.failedStage).toBe("dispatch");
    expect(record.error).toBeTruthy();
    expect(record.status).toBe(503);
    expect(record.endedAt).toBeDefined();
  });

  it("records a failed stage for a rejected upstream credential", async () => {
    const { broker } = inMemoryAccounts([account("a", ["start-plan"])], {
      routing: { order: ["start-plan"], onSaturated: "wait" },
    });
    const requests = new RequestStore();

    // start-plan 的 JWT 被上游拒：一个明确的失败阶段，而不是一条无声的 401。
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { type: "authentication_error" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    const resp = await proxyRequest(clientReq(), "anthropic", {
      config: CONFIG,
      broker,
      requests,
      fetchImpl,
      endpointRouting: null,
      clientSigning: null,
      highspeed: null,
      captcha: {
        RETRY_HEADERS: { PARAM: "x-aliyun-captcha-verify-param", REGION: "x-aliyun-captcha-verify-region" },
        getCaptchaToken: async () => ({ verifyParam: "tok", region: "cn" }),
        detectCaptchaChallenge: () => null,
      },
    });

    expect(resp.status).toBe(401);
    await resp.text();
    const record = requests.recent(1)[0]!;
    expect(record.failedStage).toBe("upstream-resp");
    expect(record.error).toContain("JWT");
    expect(record.status).toBe(401);
  });
});
