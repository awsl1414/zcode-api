/**
 * `src/log/` 的骨架用例：级别过滤、三种格式的形状、字段保真、缓冲区收到条目。
 *
 * 这四条对应任务给的验收项，每条都从一个真实症状出发：
 *
 *   级别过滤   `warn` 时不该再看到 info。旧代码没有级别，只能靠人删 print。
 *   三种格式   终端人读、紧凑行、JSON 各一份，形状钉住，改版时不会悄悄漂移。
 *   对象保真   `args.join(" ")` 会把对象压成 `[object Object]`，那是要修的症状本身。
 *   缓冲条目   面板按级别/模块过滤，读的必须是字段，不能是 parse 文本行。
 *
 * 时钟钉死（`now()`）而不是断言「差不多现在」：格式与顺序是这里要测的东西，
 * 时间戳是不是真实时间与它们无关。
 */
import { afterEach, describe, expect, it } from "bun:test";
import { LogBuffer } from "./buffer.js";
import { configureLogging, formatLine, logger, resetLogging, writeRequestLine } from "./index.js";
import type { LogWrite } from "./logger.js";
import type { LogLevel, Logger } from "./types.js";

/** 固定时间戳：2026-12-30 12:04:11 本地时区（文本格式断言的是本地钟点）。*/
const FIXED_TS = new Date(2026, 11, 30, 12, 4, 11).getTime();

/** 把输出收进数组，代替终端流。类型直接就是 `LogWrite`，调用方不必转型。*/
function capture(): { lines: { text: string; level: LogLevel }[]; write: LogWrite } {
  const lines: { text: string; level: LogLevel }[] = [];
  return {
    lines,
    write: (text, level) => {
      lines.push({ text, level });
    },
  };
}

/**
 * 一个接在固定时钟与内存 sink 上的 logger。
 *
 * 默认级别 `debug`：格式用例要看到 `debug` 那一档，否则测不到最常用的阶段打点。
 * 级别过滤的用例自己传阈值，不靠这份默认值。
 */
function testLogger(mod: string, sink: { write: LogWrite }, level: LogLevel = "debug"): Logger {
  configureLogging({ level, now: () => FIXED_TS, write: sink.write });
  return logger(mod);
}

afterEach(() => {
  resetLogging();
});

describe("级别过滤", () => {
  it("阈值为 warn 时不输出 info，warn 与 error 照常输出", () => {
    const sink = capture();
    const log = testLogger("proxy", sink, "warn");

    log.debug("d", { reqId: "#001" });
    log.info("i", { reqId: "#001" });
    log.warn("w", { reqId: "#001" });
    log.error("e", { reqId: "#001" });

    expect(sink.lines.map((line) => line.level)).toEqual(["warn", "error"]);
  });

  it("阈值为 error 时只剩 error", () => {
    const sink = capture();
    const log = testLogger("accounts", sink, "error");

    log.warn("w");
    log.error("e");

    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0].level).toBe("error");
  });

  it("threshold 由 levelEnabled 按序比较，不是按字符串", () => {
    const sink = capture();
    const log = testLogger("claim", sink, "debug");

    log.debug("d");
    log.info("i");

    expect(sink.lines).toHaveLength(2);
  });

  it("被滤掉的调用不写终端，也不写缓冲区", () => {
    const buffer = new LogBuffer();
    const sink = capture();
    configureLogging({ buffer });
    const log = testLogger("proxy", sink, "warn");

    log.info("hidden");
    log.warn("shown");

    expect(sink.lines).toHaveLength(1);
    expect(buffer.sinceEntries(0).records).toHaveLength(1);
  });
});

describe("三种格式", () => {
  it("text：`HH:MM:SS LEVEL [mod] msg k=v`", () => {
    const sink = capture();
    configureLogging({ format: "text" });
    const log = testLogger("proxy", sink);

    log.info("stage", { reqId: "#003", stage: "dispatch", account: "work-team", route: "coding-plan", ms: 2 });

    expect(sink.lines[0].text).toBe(
      "12:04:11 INFO  [proxy] stage reqId=#003 stage=dispatch account=work-team route=coding-plan ms=2",
    );
  });

  it("compact：前缀缩成时间 + 级别字母 + 模块", () => {
    const sink = capture();
    configureLogging({ format: "compact" });
    const log = testLogger("proxy", sink);

    log.info("stage", { reqId: "#003", stage: "dispatch" });

    expect(sink.lines[0].text).toBe("12:04:11 I [proxy] stage reqId=#003 stage=dispatch");
  });

  it("json：单行，字段平铺在顶层", () => {
    const sink = capture();
    configureLogging({ format: "json" });
    const log = testLogger("proxy", sink);

    log.info("stage", { reqId: "#003", stage: "dispatch", ms: 2 });

    expect(sink.lines[0].text).toBe(
      `{"ts":${FIXED_TS},"level":"info","mod":"proxy","msg":"stage","reqId":"#003","stage":"dispatch","ms":2}`,
    );
    expect(JSON.parse(sink.lines[0].text)).toEqual({
      ts: FIXED_TS,
      level: "info",
      mod: "proxy",
      msg: "stage",
      reqId: "#003",
      stage: "dispatch",
      ms: 2,
    });
  });

  it("没有字段时不留尾随空格（三种格式一致）", () => {
    const sink = capture();
    configureLogging({ format: "text" });
    const log = testLogger("claim", sink);
    log.info("领取成功");

    expect(sink.lines[0].text).toBe("12:04:11 INFO  [claim] 领取成功");
  });

  it("message 里的字段值带空格时加引号，不会被读成两个字段", () => {
    const sink = capture();
    configureLogging({ format: "text" });
    const log = testLogger("proxy", sink);
    log.debug("conn", { err: "connect ECONNREFUSED 127.0.0.1:443" });

    expect(sink.lines[0].text).toBe(
      '12:04:11 DEBUG [proxy] conn err="connect ECONNREFUSED 127.0.0.1:443"',
    );
  });
});

describe("字段保真", () => {
  it("json 模式下对象字段原样保留，不被压平", () => {
    const sink = capture();
    configureLogging({ format: "json" });
    const log = testLogger("highspeed", sink);

    log.debug("stage", { cardId: "card-1", card: { model: "glm-4.6", expiresAt: 1794000000000 }, nested: { a: [1, 2] } });

    const parsed = JSON.parse(sink.lines[0].text);
    expect(parsed.card).toEqual({ model: "glm-4.6", expiresAt: 1794000000000 });
    expect(parsed.nested).toEqual({ a: [1, 2] });
    expect(sink.lines[0].text).not.toContain("[object Object]");
  });

  it("text 模式下对象渲染成一行 JSON，也不是 [object Object]", () => {
    const sink = capture();
    configureLogging({ format: "text" });
    const log = testLogger("highspeed", sink);

    log.debug("stage", { card: { model: "glm-4.6" } });

    expect(sink.lines[0].text).toContain('card={"model":"glm-4.6"}');
    expect(sink.lines[0].text).not.toContain("[object Object]");
  });

  it("error 的第三个参数：text 只留 message，json 保 name 与 stack", () => {
    const textSink = capture();
    configureLogging({ format: "text" });
    testLogger("proxy", textSink).error("stage", { reqId: "#009" }, new Error("boom"));
    expect(textSink.lines[0].text).toContain("err=");
    expect(textSink.lines[0].text).toContain("boom");
    expect(textSink.lines[0].text).not.toContain("\n");

    const jsonSink = capture();
    configureLogging({ format: "json" });
    testLogger("proxy", jsonSink).error("stage", { reqId: "#009" }, new Error("boom"));
    const parsed = JSON.parse(jsonSink.lines[0].text);
    expect(parsed.err.message).toBe("boom");
    expect(parsed.err.name).toBe("Error");
    expect(typeof parsed.err.stack).toBe("string");
  });

  it("undefined 的字段整条省略", () => {
    const entry = { seq: 1, ts: FIXED_TS, level: "info" as const, mod: "proxy", msg: "m", fields: { a: 1, b: undefined } };
    expect(formatLine(entry, "text")).toBe("12:04:11 INFO  [proxy] m a=1");
    expect(JSON.parse(formatLine(entry, "json")).b).toBeUndefined();
  });
});

describe("LogBuffer 收到结构化条目", () => {
  it("条目带 seq / level / mod / msg / fields，文本行与终端同源", () => {
    const buffer = new LogBuffer();
    const sink = capture();
    configureLogging({ format: "text", buffer });
    const log = testLogger("proxy", sink);

    log.info("stage", { reqId: "#003", stage: "intake", model: "glm-4.6", stream: true, bytes: 42 });

    const { records, nextSince } = buffer.sinceEntries(0);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.line).toBe(sink.lines[0].text);
    expect(record.entry).toEqual({
      seq: record.seq,
      ts: FIXED_TS,
      level: "info",
      mod: "proxy",
      msg: "stage",
      fields: { reqId: "#003", stage: "intake", model: "glm-4.6", stream: true, bytes: 42 },
    });
    // 游标与行号同源：`getLogs` 与 `/events` 用同一个 `nextSince` 做增量。
    expect(nextSince).toBe(buffer.cursor);
    expect(buffer.since(0).lines).toEqual([sink.lines[0].text]);
  });

  it("console tee 的纯文本行与结构化条目共用一个游标，后者的 entry 缺省", () => {
    const buffer = new LogBuffer();
    configureLogging({ format: "text", buffer });
    const log = testLogger("proxy", capture());

    buffer.push("third-party noise");
    log.warn("stage", { reqId: "#004" });

    const { records } = buffer.sinceEntries(0);
    expect(records).toHaveLength(2);
    expect(records[0].line).toBe("third-party noise");
    expect(records[0].entry).toBeUndefined();
    expect(records[1].entry?.mod).toBe("proxy");
    expect(records[1].seq).toBe(1);
  });

  it("没有面板时不报错，只是不落缓冲", () => {
    const sink = capture();
    configureLogging({ format: "text" });
    const log = testLogger("proxy", sink);

    expect(() => log.info("no buffer")).not.toThrow();
    expect(sink.lines).toHaveLength(1);
  });

  it("环形上限生效，条目与文本行一起被挤掉", () => {
    const buffer = new LogBuffer(2);
    configureLogging({ format: "text", buffer });
    const log = testLogger("proxy", capture());

    log.info("one");
    log.info("two");
    log.info("three");

    expect(buffer.since(0).lines).toEqual([
      "12:04:11 INFO  [proxy] two",
      "12:04:11 INFO  [proxy] three",
    ]);
  });
});

/**
 * 请求表格（一行一次请求）的通路。
 *
 * 表格行曾经以 `mod: "request"` 塞进 `LogBuffer`，面板系统 tab 的日志流里就混进了
 * `#mw7223-053 | …` 这样的行，正是这条通路要防的分类 bug。现在表格行的去向只有
 * 终端，而且要 `requestLines` 开着（入口按 `process.stdout.isTTY` 注入）才写；
 * 缓冲区**永不**收表格行，请求信息在面板上只活在请求事件 tab（数据同源
 * `RequestStore`）。
 */
describe("writeRequestLine（请求表格的终端出口）", () => {
  const TABLE_ROW = "| #001 | 12:04:11   | ANT | glm-4.6     | batch  |  200 |     7ms |     - |      - |       - |";

  it("无 TTY（requestLines 关）时不写终端也不进缓冲区", () => {
    const buffer = new LogBuffer();
    const sink = capture();
    // 默认就是关（headless 部署的形状）；显式关一遍钉住语义
    configureLogging({ buffer, write: sink.write, requestLines: false, now: () => FIXED_TS });

    writeRequestLine(TABLE_ROW);

    /* 分类修复的断言：无 TTY 下 LogBuffer 不含表格行，stdout 也没有。请求信息
       只活在 RequestStore（请求事件 tab / requests.jsonl）里。 */
    expect(buffer.snapshot()).toEqual([]);
    expect(sink.lines).toHaveLength(0);
  });

  it("requestLines 开启（有 TTY）时终端拿到原样的一行（不经 logger 的三种格式）", () => {
    const sink = capture();
    configureLogging({ write: sink.write, format: "json", requestLines: true });

    writeRequestLine(TABLE_ROW);

    // 即使全局格式是 json，表格行也不变成 JSON：它有自己的格式约定
    expect(sink.lines[0].text).toBe(TABLE_ROW);
    expect(sink.lines[0].level).toBe("info");
  });

  it("即使 requestLines 开启，缓冲区也不收表格行（系统 tab 不再混请求行）", () => {
    const buffer = new LogBuffer();
    configureLogging({ buffer, requestLines: true, format: "text" });
    const log = testLogger("proxy", capture());

    log.info("stage", { reqId: "#001", stage: "intake" });
    writeRequestLine(TABLE_ROW);

    // 业务日志照旧进缓冲；请求行不进：两条流各回各家
    const { records } = buffer.sinceEntries(0);
    expect(records).toHaveLength(1);
    expect(records[0].entry?.mod).toBe("proxy");
    expect(buffer.snapshot().some((line) => line.includes("#001 |"))).toBe(false);
  });

  it("什么都没配置（无面板、无 sink 注入）时不报错", () => {
    expect(() => writeRequestLine(TABLE_ROW)).not.toThrow();
  });
});
