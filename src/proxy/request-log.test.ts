/**
 * 请求记录的落盘（全量保留 + 历史分页）。
 *
 * 每个用例用独立的 `ZCODE_PROXY_STORE_DIR`：真实存储目录里有用户的 `accounts.json`
 * 与 `apikeys.json`，测试绝不能读写它（`accounts/store.test.ts` 记录过那次事故）。
 *
 * 这里钉的是四条契约，CLI 与面板都依赖它们：
 *
 *   一次请求收尾 → 文件里恰好一行，字段与内存里的 record 一致
 *   重启（新 store + 读回）→ `recent(1)` 还是上一次那条
 *   全量保留 → 文件只追加不重写，内存仓只留最近 N 条
 *   坏行 → 跳过，不报错（进程被杀时最后一行常常只写了一半）
 *
 * 历史分页的契约（`readLinesBackward` / `pageRequestHistory`）也在这里：
 * 多页游标推进、hasMore 翻转、坏行与空文件容错、跨块长行、游标边界的并列稳定。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REQUEST_HISTORY_PAGE_LIMIT,
  REQUEST_HISTORY_PAGE_MAX,
  REQUEST_LOG_FILE,
  appendRequestRecord,
  openRequestStore,
  pageRequestHistory,
  readLinesBackward,
  readRequestRecords,
  redactRequestRecord,
  requestLogPath,
} from "./request-log.js";
import { REQUEST_STORE_CAPACITY } from "./request-record.js";
import type { RequestRecord } from "./request-record.js";

const ENV_STORE_DIR = "ZCODE_PROXY_STORE_DIR";

let storeDir = "";
const previous = process.env[ENV_STORE_DIR];

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "zcode-requests-"));
  process.env[ENV_STORE_DIR] = storeDir;
});

afterEach(() => {
  if (previous === undefined) delete process.env[ENV_STORE_DIR];
  else process.env[ENV_STORE_DIR] = previous;
  rmSync(storeDir, { recursive: true, force: true });
});

/** 一条形状与 `proxyRequest` 填出来的一致的记录。*/
function record(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    reqId: "#001",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_002_890,
    format: "anthropic",
    model: "glm-5.3-flash",
    stream: true,
    requestBytes: 12480,
    account: "work-team",
    route: "start-plan",
    queueMs: 16,
    retries: 0,
    upstreamFormat: "anthropic",
    upstreamUrl: "https://zcode.z.ai/api/v1/ultra",
    signed: false,
    headerCount: 41,
    status: 200,
    ttfbMs: 1240,
    totalMs: 2890,
    inputTokens: 2100,
    outputTokens: 179,
    tps: 200,
    contentEncoding: "identity",
    stages: [
      { stage: "intake", atMs: 0, fields: { format: "anthropic", stream: true, bytes: 12480 } },
      { stage: "dispatch", atMs: 18, fields: { account: "work-team", route: "start-plan", queueMs: 16 } },
    ],
    apiKeyId: "0123456789abcdef",
    ...overrides,
  };
}

/** 文件里现在有几行非空行。*/
function lineCount(path: string = requestLogPath()): number {
  return readFileSync(path, "utf-8").split("\n").filter((line) => line.trim().length > 0).length;
}

describe("路径与形状", () => {
  it("落在 `$ZCODE_PROXY_STORE_DIR/requests.jsonl`（与四个加密仓同一个目录判定）", () => {
    expect(requestLogPath()).toBe(join(storeDir, REQUEST_LOG_FILE));
  });

  it("一行一条记录，字段与内存里的一致（含嵌套的 stages）", () => {
    const one = record();
    expect(appendRequestRecord(one)).toBe(true);

    const text = readFileSync(requestLogPath(), "utf-8");
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(one);

    // 文件名在帮助与设计文档里都写过，改它会让人找不到文件。
    expect(REQUEST_LOG_FILE).toBe("requests.jsonl");
  });

  it("文件权限是 0o600（只有本用户可读）", () => {
    appendRequestRecord(record());
    const mode = statSync(requestLogPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("父目录不存在时自己建（首次运行）", () => {
    const nested = join(storeDir, "a", "b", "requests.jsonl");
    expect(appendRequestRecord(record(), nested)).toBe(true);
    expect(lineCount(nested)).toBe(1);
  });
});

describe("读回", () => {
  it("按写入顺序（旧 → 新）返回，`limit` 取最后 N 条", () => {
    for (const id of ["#001", "#002", "#003"]) {
      appendRequestRecord(record({ reqId: id }));
    }
    expect(readRequestRecords(10).map((r) => r.reqId)).toEqual(["#001", "#002", "#003"]);
    expect(readRequestRecords(2).map((r) => r.reqId)).toEqual(["#002", "#003"]);
    expect(readRequestRecords(0)).toEqual([]);
  });

  it("文件不存在时回空数组（第一次运行不是错误）", () => {
    expect(readRequestRecords(REQUEST_STORE_CAPACITY)).toEqual([]);
  });

  it("坏行跳过：半截 JSON / 非 JSON / 形状不对都不影响其余行", () => {
    const good = record({ reqId: "#001" });
    const wrongShape = JSON.stringify({ reqId: "#002", startedAt: "yesterday" });
    writeFileSync(
      requestLogPath(),
      [
        JSON.stringify(good),
        '{"reqId":"#002","startedAt":1700000000000', // 进程被杀时的半行
        "not json at all",
        wrongShape,
        JSON.stringify(record({ reqId: "#003" })),
      ].join("\n") + "\n",
      "utf-8",
    );

    const records = readRequestRecords(10);
    expect(records.map((r) => r.reqId)).toEqual(["#001", "#003"]);
  });
});

describe("openRequestStore", () => {
  it("收尾写一行；重启（新 store 读回）后 recent(1) 还是上一次那条", () => {
    const first = openRequestStore();
    const begun = first.begin({ reqId: "#001", format: "anthropic", apiKeyId: "k1" });
    begun.status = 200;
    begun.model = "glm-5.3-flash";
    begun.totalMs = 2890;
    /* handler 的写法：阶段在过程中填，收尾一次 notify。*/
    begun.stages.push({ stage: "intake", atMs: 0, fields: { bytes: 12480 } });
    /* 落盘挂在 finalize（记录完整了）上，notify 只管实时通知。*/
    first.finalize(begun);

    expect(lineCount()).toBe(1);
    // 落盘的那一行与内存里的 record 完全一致（`RequestRecord` 没有 body 字段，
    // 所以「照原样序列化」就是完整信息，不需要挑字段）。
    const persisted = readFileSync(requestLogPath(), "utf-8").trim().split("\n");
    expect(persisted).toHaveLength(1);
    expect(JSON.parse(persisted[0]!)).toEqual(begun);

    // 「重启」：新进程只有文件，没有上一次的内存。
    const second = openRequestStore();
    const recent = second.recent(1);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.reqId).toBe("#001");
    expect(recent[0]!.status).toBe(200);
    expect(recent[0]!.model).toBe("glm-5.3-flash");
    expect(second.get("#001")?.totalMs).toBe(2890);
    expect(second.get("#001")?.stages).toEqual(begun.stages);
  });

  it("流式记录的落盘延到 finalize：notify（交接）时刻的行不写，用量不缺", () => {
    const store = openRequestStore();
    const one = store.begin({ reqId: "#stream-1", format: "anthropic", apiKeyId: "" });
    one.status = 200;
    one.stream = true;
    /* 交接时刻：只有 intake / upstream-resp，没有 stream-end 与 token。*/
    one.stages.push({ stage: "intake", atMs: 0, fields: {} });
    store.notify(one);
    // 交接时刻没有落盘：文件可能还不存在（第一条记录尚未收尾），存在时也必须是 0 行。
    expect(existsSync(requestLogPath()) ? lineCount() : 0).toBe(0);

    /* 流收尾：observeStream 填用量并登记 stream-end，然后 finalize。*/
    one.inputTokens = 10;
    one.outputTokens = 3;
    one.cacheReadTokens = 1216;
    one.stages.push({ stage: "stream-end", atMs: 100, fields: { tokens: 3 } });
    store.finalize(one);

    expect(lineCount()).toBe(1);
    const persisted = JSON.parse(readFileSync(requestLogPath(), "utf-8").trim());
    expect(persisted.inputTokens).toBe(10);
    expect(persisted.cacheReadTokens).toBe(1216);
    expect(persisted.stages.at(-1)!.stage).toBe("stream-end");
  });

  it("hydrate 不触发落盘（不会把历史复制一份）", () => {
    const first = openRequestStore();
    for (const id of ["#001", "#002"]) {
      const one = first.begin({ reqId: id, format: "anthropic", apiKeyId: "" });
      one.status = 200;
      first.notify(one);
      first.finalize(one);
    }
    expect(lineCount()).toBe(2);

    // 第二次启动：读回两条，文件仍然是两行。
    const second = openRequestStore();
    expect(second.recent(10)).toHaveLength(2);
    expect(lineCount()).toBe(2);
  });

  it("超过容量后文件全量保留（不重写），内存仓只留最近 N 条", () => {
    const capacity = 3;
    const store = openRequestStore({ capacity });
    for (let index = 1; index <= capacity + 2; index++) {
      const id = `#${String(index).padStart(3, "0")}`;
      const one = store.begin({ reqId: id, format: "anthropic", apiKeyId: "" });
      one.status = 200;
      store.notify(one);
      store.finalize(one);
    }

    // 文件五行一条不少（历史靠分页读回，不靠重写丢掉）；
    expect(lineCount()).toBe(capacity + 2);
    // 内存仓与「最近 N 条」的读取方看到的仍是同一批。
    expect(readRequestRecords(capacity).map((r) => r.reqId)).toEqual(["#003", "#004", "#005"]);
    expect(store.recent(capacity).map((r) => r.reqId)).toEqual(["#005", "#004", "#003"]);
    // 更早的那两条还在文件里，分页读得回来。
    expect(pageRequestHistory({ limit: 10 }).requests.map((r) => r.reqId)).toEqual([
      "#005", "#004", "#003", "#002", "#001",
    ]);
  });

  it("默认容量就是 `REQUEST_STORE_CAPACITY`：内存只留 200 条，文件一条不少", () => {
    // 不传 capacity，走的就是 `REQUEST_STORE_CAPACITY`；文件不按它截断。
    const store = openRequestStore();
    for (let index = 1; index <= REQUEST_STORE_CAPACITY + 1; index++) {
      const id = `#${String(index).padStart(3, "0")}`;
      const one = store.begin({ reqId: id, format: "anthropic", apiKeyId: "" });
      store.notify(one);
      store.finalize(one);
    }

    expect(lineCount()).toBe(REQUEST_STORE_CAPACITY + 1);
    const kept = readRequestRecords(REQUEST_STORE_CAPACITY);
    expect(kept).toHaveLength(REQUEST_STORE_CAPACITY);
    // 最旧的 #001 只被内存仓淘汰，文件里还在。
    expect(kept[0]!.reqId).toBe("#002");
    expect(kept[kept.length - 1]!.reqId).toBe("#201");
    expect(store.recent(1)[0]!.reqId).toBe("#201");
  });

  it("启动时文件已经超容量（上一版留下的长文件）：内存取尾部，文件原样保留", () => {
    const path = requestLogPath();
    const limit = 2;
    writeFileSync(
      path,
      [...["#001", "#002", "#003", "#004"].map((id) => JSON.stringify(record({ reqId: id })))].join("\n") + "\n",
      "utf-8",
    );

    const store = openRequestStore({ capacity: limit });
    expect(lineCount()).toBe(4);
    expect(store.recent(10).map((r) => r.reqId)).toEqual(["#004", "#003"]);

    const one = store.begin({ reqId: "#005", format: "anthropic", apiKeyId: "" });
    store.notify(one);
    // 落盘挂在 finalize（同上）。
    store.finalize(one);
    expect(lineCount()).toBe(5);
  });
});

/* ------------------------------------------------------------------------- */
/* 历史分页：readLinesBackward / pageRequestHistory                             */
/* ------------------------------------------------------------------------- */

describe("历史分页（pageRequestHistory）", () => {
  /** 按文件序（旧 → 新）把记录写进文件；startedAt 各不相同。*/
  function seed(ids: readonly string[], overrides: Partial<RequestRecord> = {}): RequestRecord[] {
    const records = ids.map((id, index) =>
      record({ reqId: id, startedAt: 1_700_000_000_000 + index * 1000, ...overrides }),
    );
    writeFileSync(
      requestLogPath(),
      records.map((one) => `${JSON.stringify(one)}\n`).join(""),
      "utf-8",
    );
    return records;
  }

  it("第一页从最新开始，新的在前；hasMore 指出还有没有更早的", () => {
    const records = seed(["#001", "#002", "#003", "#004", "#005"]);

    const page = pageRequestHistory({ limit: 3, path: requestLogPath() });
    expect(page.requests.map((r) => r.reqId)).toEqual(["#005", "#004", "#003"]);
    expect(page.hasMore).toBe(true);
    // 页里的记录就是文件里的那份（不重排字段）。
    expect(page.requests[0]).toEqual(records[4]);
  });

  it("多页游标推进：边界记录随下一页重发，去重后直到 hasMore 翻 false", () => {
    seed(["#001", "#002", "#003", "#004", "#005"]);

    /* 与面板同一套循环：游标 = 已加载里最早一条的 startedAt，按 reqId 去重。*/
    const loaded = new Map<string, number>();
    let before: number | undefined;
    const freshPages: string[][] = [];
    for (let round = 0; round < 10; round += 1) {
      const page = pageRequestHistory({ limit: 2, before, path: requestLogPath() });
      const fresh = page.requests.filter((r) => !loaded.has(r.reqId));
      for (const one of fresh) loaded.set(one.reqId, one.startedAt);
      freshPages.push(fresh.map((r) => r.reqId));
      if (!page.hasMore) break;
      before = Math.min(...page.requests.map((r) => r.startedAt));
    }

    // 每页的去重新增：2 + 1 + 1 + 1（边界记录各重发一次）。
    expect(freshPages).toEqual([["#005", "#004"], ["#003"], ["#002"], ["#001"]]);
    expect(loaded.size).toBe(5);
  });

  it("边界记录确实重发（客户端靠 reqId 去重，服务端不猜客户端有什么）", () => {
    seed(["#001", "#002", "#003"]);
    const first = pageRequestHistory({ limit: 2, path: requestLogPath() });
    expect(first.requests.map((r) => r.reqId)).toEqual(["#003", "#002"]);

    const second = pageRequestHistory({ limit: 2, before: first.requests[1]!.startedAt, path: requestLogPath() });
    // #002 就在游标上：重发，而不是跳过（跳过会丢掉与它同毫秒的并列记录）。
    expect(second.requests.map((r) => r.reqId)).toEqual(["#002", "#001"]);
    expect(second.hasMore).toBe(false);
  });

  it("页数恰好用尽时 hasMore 是 false（不是靠多扫一页猜出来的）", () => {
    seed(["#001", "#002", "#003"]);
    const page = pageRequestHistory({ limit: 3, path: requestLogPath() });
    expect(page.requests).toHaveLength(3);
    expect(page.hasMore).toBe(false);
  });

  it("游标边界是闭的：startedAt == before 的记录随下一页重发（客户端按 reqId 去重）", () => {
    seed(["#001", "#002", "#003"]);
    const boundary = 1_700_000_000_000 + 1000; // #002 的 startedAt
    const page = pageRequestHistory({ limit: 10, before: boundary, path: requestLogPath() });
    expect(page.requests.map((r) => r.reqId)).toEqual(["#002", "#001"]);
  });

  it("同一 startedAt 的并列记录按文件序稳定：整组随下一页重发，顺序不漂移", () => {
    // 四条同毫秒的记录（文件序 a → b → c → d），加两条更早的。
    const tie = 1_700_000_000_000;
    const tied = [
      record({ reqId: "#f", startedAt: tie - 2000 }),
      record({ reqId: "#e", startedAt: tie - 1000 }),
      record({ reqId: "#a", startedAt: tie }),
      record({ reqId: "#b", startedAt: tie }),
      record({ reqId: "#c", startedAt: tie }),
      record({ reqId: "#d", startedAt: tie }),
    ];
    writeFileSync(
      requestLogPath(),
      tied.map((one) => `${JSON.stringify(one)}\n`).join(""),
      "utf-8",
    );

    // 第一页正好切在并列组的最后一条上（游标 = 组的 startedAt）。
    const first = pageRequestHistory({ limit: 4, path: requestLogPath() });
    expect(first.requests.map((r) => r.reqId)).toEqual(["#d", "#c", "#b", "#a"]);
    expect(first.hasMore).toBe(true);

    // 第二页把整组按同一顺序重发，后面跟的是真正的新记录。
    const second = pageRequestHistory({ limit: 5, before: tie, path: requestLogPath() });
    expect(second.requests.map((r) => r.reqId)).toEqual(["#d", "#c", "#b", "#a", "#e"]);
    expect(second.hasMore).toBe(true);

    const third = pageRequestHistory({ limit: 5, before: tie - 1000, path: requestLogPath() });
    expect(third.requests.map((r) => r.reqId)).toEqual(["#e", "#f"]);
    expect(third.hasMore).toBe(false);
  });

  it("坏行跳过：半截 JSON / 非 JSON / 形状不对不占页也不误报 hasMore", () => {
    const lines = [
      JSON.stringify(record({ reqId: "#001", startedAt: 1_700_000_000_000 })),
      '{"reqId":"#002","startedAt":1700000001000', // 进程被杀时的半行
      "not json at all",
      JSON.stringify({ reqId: "#003", startedAt: 1700000002000 }), // 缺 format/stages
      JSON.stringify(record({ reqId: "#004", startedAt: 1_700_000_003_000 })),
      JSON.stringify(record({ reqId: "#005", startedAt: 1_700_000_004_000 })),
    ];
    writeFileSync(requestLogPath(), `${lines.join("\n")}\n`, "utf-8");

    const page = pageRequestHistory({ limit: 2, path: requestLogPath() });
    expect(page.requests.map((r) => r.reqId)).toEqual(["#005", "#004"]);
    expect(page.hasMore).toBe(true);

    const rest = pageRequestHistory({ limit: 2, before: 1_700_000_003_000, path: requestLogPath() });
    expect(rest.requests.map((r) => r.reqId)).toEqual(["#004", "#001"]);
    expect(rest.hasMore).toBe(false);
  });

  it("空文件与不存在的文件都是空页 + hasMore false", () => {
    writeFileSync(requestLogPath(), "", "utf-8");
    expect(pageRequestHistory({ path: requestLogPath() })).toEqual({ requests: [], hasMore: false });

    expect(pageRequestHistory({ path: join(storeDir, "nope.jsonl") })).toEqual({ requests: [], hasMore: false });
  });

  it("缺省 limit 是 100，钳到上限 500", () => {
    const many = Array.from({ length: 505 }, (_, index) =>
      JSON.stringify(record({ reqId: `#${String(index).padStart(4, "0")}`, startedAt: 1_700_000_000_000 + index })),
    );
    writeFileSync(requestLogPath(), `${many.join("\n")}\n`, "utf-8");

    expect(pageRequestHistory({ path: requestLogPath() }).requests).toHaveLength(REQUEST_HISTORY_PAGE_LIMIT);
    expect(pageRequestHistory({ limit: 1000, path: requestLogPath() }).requests).toHaveLength(REQUEST_HISTORY_PAGE_MAX);
    expect(pageRequestHistory({ limit: 0, path: requestLogPath() }).requests).toHaveLength(1); // 钳到 1
  });

  it("跨块长行：行体跨多个 64KB 块也能完整拼回来", () => {
    // 一条带超大 stages 字段的记录（行体约 200KB，横跨 4 个块），前后各一条普通记录。
    const fat = record({
      reqId: "#fat",
      startedAt: 1_700_000_001_000,
      stages: [{ stage: "body", atMs: 1, fields: { blob: "x".repeat(200_000) } }],
    });
    writeFileSync(
      requestLogPath(),
      [
        `${JSON.stringify(record({ reqId: "#001", startedAt: 1_700_000_000_000 }))}\n`,
        `${JSON.stringify(fat)}\n`,
        `${JSON.stringify(record({ reqId: "#002", startedAt: 1_700_000_002_000 }))}\n`,
      ].join(""),
      "utf-8",
    );

    const page = pageRequestHistory({ limit: 10, path: requestLogPath() });
    expect(page.requests.map((r) => r.reqId)).toEqual(["#002", "#fat", "#001"]);
    expect(page.requests[1]!.stages[0]!.fields.blob).toHaveLength(200_000);
  });

  it("文件不带末尾换行时最后一行照收；纯空行不算记录", () => {
    writeFileSync(
      requestLogPath(),
      `\n${JSON.stringify(record({ reqId: "#001" }))}\n\n  \n${JSON.stringify(record({ reqId: "#002" }))}`,
      "utf-8",
    );
    const page = pageRequestHistory({ limit: 10, path: requestLogPath() });
    expect(page.requests.map((r) => r.reqId)).toEqual(["#002", "#001"]);
    expect(page.hasMore).toBe(false);
  });

  it("readLinesBackward 的 fromOffset 只读该偏移之前的字节（外部截断的容错面）", () => {
    const lines = ["#001", "#002", "#003"].map((id) => `${JSON.stringify(record({ reqId: id }))}\n`);
    const prefix = lines[0]! + lines[1]!;
    writeFileSync(requestLogPath(), lines.join(""), "utf-8");

    const seen: string[] = [];
    readLinesBackward(requestLogPath(), (line) => {
      seen.push(JSON.parse(line).reqId);
    }, prefix.length);
    // 只看得到前两行，倒序；#003 在偏移之外。
    expect(seen).toEqual(["#002", "#001"]);
  });
});

describe("防御性脱敏（redactRequestRecord）", () => {
  it("字符串值过 redactSecrets（Bearer / sk-），数字与布尔原样", () => {
    const dirty = record({
      error: "upstream rejected token Bearer abc.def.ghi (key sk-1234567890abcdefghij)",
      upstreamUrl: "https://zcode.z.ai/api/v1/ultra?key=sk-1234567890abcdefghij",
      stages: [{ stage: "upstream-req", atMs: 1, fields: { url: "https://x/?key=sk-1234567890abcdefghij", count: 3, signed: true } }],
    });

    const clean = redactRequestRecord(dirty);
    expect(clean.error).not.toContain("abc.def.ghi");
    expect(clean.error).toContain("<redacted>");
    expect(clean.upstreamUrl).not.toContain("sk-1234567890abcdefghij");
    const fields = clean.stages[0]!.fields as Record<string, string | number | boolean>;
    expect(fields.url).not.toContain("sk-1234567890abcdefghij");
    expect(fields.count).toBe(3);
    expect(fields.signed).toBe(true);
    // 无关字段原样。
    expect(clean.reqId).toBe(dirty.reqId);
    expect(clean.model).toBe(dirty.model);
  });
});
