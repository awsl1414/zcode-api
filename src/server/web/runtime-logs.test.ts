/**
 * 日志页（实时事件流 / 过滤暂停搜索 / 结构化列 / 请求事件 tab / 预设）。
 *
 * 脚手架见 `runtime-harness.ts`。
 */

import { describe, expect, it } from "bun:test";
import { installHarnessHooks, account, commands, mountSettled, nodes, statePayload } from "./runtime-harness.js";
import type { Harness, PageNode, RequestRecordFixture } from "./runtime-harness.js";

installHarnessHooks();

/* ------------------------------------------------------------------------- */
/* 日志页                                                                     */
/* ------------------------------------------------------------------------- */

/** 渲染出来的日志行（`.log__line`）。*/
function logLines(harness: Harness): PageNode[] {
  return nodes(harness.role("log-lines"), ".log__line");
}

/** 一个 `log` 事件（服务端已标好级别与账号；`mod` 与 `entry` 只有结构化条目才有）。*/
function logEvent(seq: number, line: string, level = "info", account?: string, mod?: string, entry?: Record<string, unknown>): unknown {
  const payload: Record<string, unknown> = { seq, level, line };
  if (account) payload.account = account;
  if (mod) payload.mod = mod;
  if (entry) payload.entry = entry;
  return payload;
}

/**
 * 系统日志 tab 上的页面（默认落在请求事件 tab）：像用户一样点一下
 * 「系统」，后续喂的行才会在这一拍画出来（请求 tab 上 `append` 只入缓冲）。
 */
async function mountSystemLogs(
  state: ReturnType<typeof statePayload> = statePayload(),
  options: Parameters<typeof mountSettled>[2] = {},
): Promise<Harness> {
  const harness = await mountSettled("/logs", state, options);
  harness.click(harness.find('[data-log-tab="system"]'));
  return harness;
}

describe("logs page — event stream", () => {
  it("serves the logs view at /logs and subscribes only there", async () => {
    const other = await mountSettled("/accounts", statePayload());
    expect(other.events.connections()).toBe(0);

    const harness = await mountSettled("/logs", statePayload());
    expect(harness.find('[data-view="logs"]')?.hasAttribute("hidden")).toBe(false);
    expect(harness.find('[data-view="overview"]')?.hasAttribute("hidden")).toBe(true);
    expect(harness.find('[data-nav="logs"]')?.getAttribute("aria-current")).toBe("page");
    // 进页面就订一条流（不多开）
    expect(harness.events.connections()).toBe(1);
    expect(harness.calls.some((call) => call.url === "/api/events")).toBe(true);
  });

  it("renders log lines with the level classes and ignores heartbeats", async () => {
    const harness = await mountSystemLogs();
    harness.events.comment();
    harness.events.frame("log", logEvent(0, "zcode-proxy listening on :8090"));
    harness.events.frame("log", logEvent(1, "[warn] account=payg cooling 60s", "warn", "payg"));
    harness.events.frame("log", logEvent(2, "[error] account=work-team 401", "error", "work-team"));
    await harness.settle();

    const lines = logLines(harness);
    expect(lines.map((line) => line.textContent)).toEqual([
      "zcode-proxy listening on :8090",
      "[warn] account=payg cooling 60s",
      "[error] account=work-team 401",
    ]);
    // 级别 → 语义色：错误/警告各有自己的类，普通行只有「整段原文」的
    // 悬挂缩进修饰（续行缩进，行首不动）
    expect(lines[0].className).toBe("log__line log__line--plain");
    expect(lines[1].className).toBe("log__line log__line--warn log__line--plain");
    expect(lines[2].className).toBe("log__line log__line--error log__line--plain");
    // 有内容就不再显示空状态
    expect(harness.role("log-empty")?.hasAttribute("hidden")).toBe(true);
  });

  it("shows the empty state until the first line arrives", async () => {
    const harness = await mountSystemLogs();
    expect(harness.role("log-empty")?.hasAttribute("hidden")).toBe(false);
    harness.events.frame("log", logEvent(0, "hello"));
    await harness.settle();
    expect(harness.role("log-empty")?.hasAttribute("hidden")).toBe(true);
  });

  it("reports the three connection states", async () => {
    const harness = await mountSettled("/logs", statePayload());
    expect(harness.role("log-conn")?.textContent).toBe("已连接");
    expect(harness.role("log-conn-dot")?.className).toContain("status__dot--ok");

    // 服务端正常关闭流 → 客户端进入重连（而不是显示「断开」）
    harness.events.end();
    await harness.settle();
    expect(harness.role("log-conn")?.textContent).toBe("重连中");
    expect(harness.role("log-conn-dot")?.className).toContain("status__dot--warn");
  });

  it("gives up and redirects to /login on 401 instead of retrying forever", async () => {
    const harness = await mountSettled("/logs", statePayload(), { eventsStatus: 401 });

    // 会话没了：状态是「断开」（不是「重连中」：重连一万次也还是 401），一条流都
    // 没建起来，而且整页跳回登录页（页面里已经没有令牌输入框了）。
    expect(harness.role("log-conn")?.textContent).toBe("断开");
    expect(harness.role("log-conn-dot")?.className).toContain("status__dot--danger");
    expect(harness.events.connections()).toBe(0);
    expect(harness.navigations).toContain("/login");
  });

  it("builds the account filter from the state snapshot", async () => {
    const harness = await mountSettled(
      "/logs",
      statePayload({ accounts: [account({ label: "work-team" }), account({ label: "payg" })] }),
    );
    const select = harness.role("log-account");
    const options = nodes(select, "option");
    expect(options.map((option) => option.value)).toEqual(["", "work-team", "payg"]);
    expect(options.map((option) => option.textContent)).toEqual(["全部账号", "work-team", "payg"]);

    // `state` 事件也能刷新这个下拉（不必等 /api/state 轮询）
    harness.events.frame("state", statePayload({ accounts: [account({ label: "fresh" })] }));
    await harness.settle();
    expect(nodes(harness.role("log-account"), "option").map((option) => option.value)).toEqual(["", "fresh"]);
  });
});

describe("logs page — filtering, pause and search", () => {
  /** 三条不同账号 / 级别的日志，作为过滤的基数。*/
  async function mountWithLines(): Promise<Harness> {
    const harness = await mountSystemLogs(statePayload({ accounts: [account({ label: "work-team" }), account({ label: "payg" })] }));
    harness.events.frame("log", logEvent(0, "account=work-team 200 ok", "info", "work-team"));
    harness.events.frame("log", logEvent(1, "account=payg cooling 60s", "warn", "payg"));
    harness.events.frame("log", logEvent(2, "upstream 500 failed", "error"));
    await harness.settle();
    expect(logLines(harness)).toHaveLength(3);
    return harness;
  }

  it("filters by account on the client", async () => {
    const harness = await mountWithLines();
    harness.change(harness.role("log-account"), "payg");
    expect(logLines(harness).map((line) => line.textContent)).toEqual(["account=payg cooling 60s"]);

    harness.change(harness.role("log-account"), "");
    expect(logLines(harness)).toHaveLength(3);
  });

  it("filters by level on the client", async () => {
    const harness = await mountWithLines();
    harness.change(harness.role("log-level"), "error");
    expect(logLines(harness).map((line) => line.textContent)).toEqual(["upstream 500 failed"]);

    harness.change(harness.role("log-level"), "warn");
    expect(logLines(harness).map((line) => line.textContent)).toEqual(["account=payg cooling 60s"]);
  });

  it("combines account and level filters", async () => {
    const harness = await mountWithLines();
    harness.change(harness.role("log-account"), "work-team");
    harness.change(harness.role("log-level"), "error");
    // work-team 的日志没有 error 级别的那一条 → 空列表 + 空状态
    expect(logLines(harness)).toHaveLength(0);
    expect(harness.role("log-empty")?.hasAttribute("hidden")).toBe(false);
  });

  it("builds the module filter from the entries it has seen", async () => {
    const harness = await mountSystemLogs();
    // 一个没有任何模块选项的空下拉（服务端没有"已知模块"清单）
    expect(nodes(harness.role("log-mod"), "option").map((option) => option.value)).toEqual([""]);

    harness.events.frame("log", logEvent(0, "12:04:11 DEBUG [proxy] stage", "debug", undefined, "proxy"));
    harness.events.frame("log", logEvent(1, "12:04:12 INFO [claim] tick", "info", undefined, "claim"));
    harness.events.frame("log", logEvent(2, "12:04:13 INFO [proxy] done", "info", undefined, "proxy"));
    await harness.settle();

    // 顺序取首次出现；重复的模块只出现一次
    expect(nodes(harness.role("log-mod"), "option").map((option) => option.value)).toEqual(["", "proxy", "claim"]);
    expect(nodes(harness.role("log-mod"), "option").map((option) => option.textContent)).toEqual([
      "全部模块",
      "proxy",
      "claim",
    ]);
  });

  it("filters by module on the client, and keeps the selection across updates", async () => {
    const harness = await mountSystemLogs();
    harness.events.frame("log", logEvent(0, "12:04:11 DEBUG [proxy] stage", "debug", undefined, "proxy"));
    harness.events.frame("log", logEvent(1, "12:04:12 INFO [claim] tick", "info", undefined, "claim"));
    await harness.settle();

    harness.change(harness.role("log-mod"), "claim");
    expect(logLines(harness).map((line) => line.textContent)).toEqual(["12:04:12 INFO [claim] tick"]);

    // 新到一条 proxy 日志：选项集合没变，用户的选择不能被冲掉
    harness.events.frame("log", logEvent(2, "12:04:13 DEBUG [proxy] stage", "debug", undefined, "proxy"));
    await harness.settle();
    expect(harness.role("log-mod")?.value).toBe("claim");
    expect(logLines(harness)).toHaveLength(1);
  });

  it("renders a `debug` entry without a fourth colour", async () => {
    const harness = await mountSystemLogs();
    harness.events.frame("log", logEvent(0, "12:04:11 DEBUG [proxy] stage", "debug", undefined, "proxy"));
    await harness.settle();

    // 级别过滤认得 `debug`，但它与 info 同一套配色
    expect(logLines(harness)[0].className).toBe("log__line log__line--plain");
    harness.change(harness.role("log-level"), "debug");
    expect(logLines(harness)).toHaveLength(1);
    harness.change(harness.role("log-level"), "warn");
    expect(logLines(harness)).toHaveLength(0);
  });

  it("searches the line text, ignoring case", async () => {
    const harness = await mountWithLines();
    harness.type(harness.role("log-search"), "FAILED");
    expect(logLines(harness).map((line) => line.textContent)).toEqual(["upstream 500 failed"]);

    harness.type(harness.role("log-search"), "  cooling  ");
    expect(logLines(harness).map((line) => line.textContent)).toEqual(["account=payg cooling 60s"]);

    harness.type(harness.role("log-search"), "");
    expect(logLines(harness)).toHaveLength(3);
  });

  it("keeps buffering while paused and flushes on resume", async () => {
    const harness = await mountWithLines();

    harness.click(harness.role("log-pause"));
    // 暂停：横幅出现，按钮变「继续」
    expect(harness.role("log-paused")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("log-pause")?.textContent).toBe("继续");

    harness.events.frame("log", logEvent(3, "arrived while paused"));
    await harness.settle();
    // 暂停期间不重画：新行还在缓冲里，没画出来
    expect(logLines(harness)).toHaveLength(3);

    harness.click(harness.role("log-pause"));
    await harness.settle();
    // 恢复：暂停期间缓冲的那一行补齐
    expect(logLines(harness).map((line) => line.textContent)).toContain("arrived while paused");
    expect(logLines(harness)).toHaveLength(4);
    expect(harness.role("log-pause")?.textContent).toBe("暂停");
    expect(harness.role("log-paused")?.hasAttribute("hidden")).toBe(true);
  });

  it("clears the buffer on demand", async () => {
    const harness = await mountWithLines();
    const systemClear = nodes(harness.find('[data-role="log-filters-system"]'), '[data-action="clear-logs"]');
    harness.click(systemClear[0] as PageNode);
    expect(logLines(harness)).toHaveLength(0);
    expect(harness.role("log-empty")?.hasAttribute("hidden")).toBe(false);
  });
});

/**
 * 基准时刻：今天本地 12:00:00。
 *
 * 必须用「今天」而不能钉一个日历日：时间列的跨天判断是相对当下（昨天的记录补
 * 日期段），钉死日期会让断言在除当天之外的每一天都多出一段前缀。
 */
const BASE_TIME = new Date().setHours(12, 0, 0, 0);

/** 一条成功请求（stages 齐全，供展开用）。*/
function okRecord(overrides: Partial<RequestRecordFixture> = {}): RequestRecordFixture {
  return {
    reqId: "#w16c-001",
    startedAt: BASE_TIME,
    format: "anthropic",
    model: "glm-5.3-flash",
    stream: true,
    requestBytes: 12480,
    retries: 0,
    account: "work-team",
    route: "start-plan",
    queueMs: 16,
    status: 200,
    ttfbMs: 1240,
    totalMs: 2900,
    tps: 200.4,
    inputTokens: 12480,
    outputTokens: 179296,
    apiKeyId: "",
    stages: [
      { stage: "intake", atMs: 0, fields: { format: "anthropic", model: "glm-5.3-flash", stream: true, bytes: 12480 } },
      { stage: "dispatch", atMs: 18, fields: { account: "work-team", route: "start-plan", queueMs: 16 } },
      { stage: "body", atMs: 21, fields: { transformBytes: 15620, injectZcodeSystem: true } },
      { stage: "upstream-req", atMs: 23, fields: { headerCount: 41, signed: false } },
      { stage: "upstream-resp", atMs: 1263, fields: { status: 200, ttfbMs: 1240, contentEncoding: "gzip" } },
      { stage: "stream-end", atMs: 2890, fields: { tokens: 179296, tps: 200.4, ttfbMs: 1240, totalMs: 2890 } },
    ],
    ...overrides,
  };
}

/** 一条失败请求（failedStage 上的那条 stage 就是失败现场）。*/
function failedRecord(overrides: Partial<RequestRecordFixture> = {}): RequestRecordFixture {
  return okRecord({
    reqId: "#w16c-002",
    status: 500,
    ttfbMs: 1240,
    totalMs: 1263,
    failedStage: "upstream-resp",
    error: "upstream said ascii codec can't encode",
    errorCode: "upstream-gateway",
    stages: [
      { stage: "intake", atMs: 0, fields: { format: "anthropic", stream: true, bytes: 12480 } },
      { stage: "upstream-resp", atMs: 1263, fields: { status: 500, ttfbMs: 1240, contentEncoding: "gzip" } },
    ],
    ...overrides,
  });
}

/** 初始加载后请求 tab 里的行（`data-req-id` 标在 <tr> 上）。*/
function reqRows(harness: Harness): PageNode[] {
  return nodes(harness.role("req-body"), "tr[data-req-id]");
}

/** 展开行（一次最多一条）。*/
function reqDetail(harness: Harness): PageNode | null {
  return harness.find("[data-req-detail]");
}

/** 切到请求事件 tab 并等到初始加载完成（默认就是它，挂载时用应答夹具把
 *  初始加载的数据就位——进页面那一拍就会发 `getRequests`）。*/
async function openRequestsTab(records: RequestRecordFixture[] = []): Promise<Harness> {
  const harness = await mountSettled("/logs", statePayload(), {
    controlReply: { ok: true, event: "requests", records },
  });
  return harness;
}

/**
 * 系统日志的结构化条目：logger 写的行在 SSE 载荷里带完整 `entry`
 * （`ts` / `level` / `mod` / `msg` / `fields`），页面按 时间 / 级别 / 模块 / 正文
 * 四列渲染，不再猜前缀。
 */
function structuredEvent(seq: number, ts: number, level: string, mod: string, msg: string, fields?: Record<string, unknown>): unknown {
  const parts = [`${localClockOf(ts)} ${level.toUpperCase()} [${mod}] ${msg}`];
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value !== undefined) parts.push(`${key}=${String(value)}`);
  }
  return logEvent(seq, parts.join(" "), level, undefined, mod, { seq, ts, level, mod, msg, fields });
}

/** 测试里的本地 HH:MM:SS（与页面的 `localTime` 同一口径）。*/
function localClockOf(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

describe("logs page — structured log columns and duplicate collapse", () => {
  it("shows five distinct claim reasons without repeating the generic idle line", async () => {
    const harness = await mountSystemLogs();
    const codes = ["empty", "versionGate", "1004", "captcha", "429"];
    const ts = new Date(2026, 0, 1, 12, 4, 11).getTime();
    for (let i = 0; i < codes.length; i++) {
      harness.events.frame("log", structuredEvent(i, ts + i, "info", "claim", "claim tick", { account: "work-team", msg: `case ${i}`, reason: codes[i] }));
    }
    await harness.settle();

    const lines = logLines(harness);
    expect(lines).toHaveLength(5);
    const reasons = lines.map((line) => line.getAttribute("data-claim-reason"));
    expect(reasons).toEqual(codes);
    const words = lines.map((line) => line.querySelector(".log__msg")?.textContent ?? "");
    expect(new Set(words).size).toBe(5);
    expect(words.every((word) => !word.includes("no claimable plans"))).toBe(true);
    expect(words[0]).toContain("当前没有发现活动");
    expect(words[1]).toContain("客户端版本");
    expect(words[2]).toContain("暂不符合资格");
    expect(words[3]).toContain("人工验证");
    expect(words[4]).toContain("限流");
    harness.close();
  });

  it("renders structured entries as four aligned columns and plain lines as-is", async () => {
    const harness = await mountSystemLogs();
    const ts = new Date(2026, 0, 1, 12, 4, 11).getTime();
    // 结构化条目：时间 / 级别 / 模块 / 正文 四列；fields 平铺在正文后面
    harness.events.frame("log", structuredEvent(0, ts, "info", "proxy", "stage", { reqId: "#001" }));
    // 没有条目的行（历史行 / console tee 残余）：原文一段，不拆列
    harness.events.frame("log", logEvent(1, "12:04:12 INFO [claim] tick", "info"));
    await harness.settle();

    const lines = logLines(harness);
    expect(lines[0].querySelector(".log__time")?.textContent).toBe("12:04:11");
    expect(lines[0].querySelector(".log__level")?.textContent).toBe("INFO");
    expect(lines[0].querySelector(".log__mod")?.textContent).toBe("[proxy]");
    expect(lines[0].querySelector(".log__msg")?.textContent).toBe("stage reqId=#001");
    expect(lines[1].querySelector(".log__time")).toBeNull();
    expect(lines[1].textContent).toBe("12:04:12 INFO [claim] tick");
  });

  it("collapses consecutive identical entries into one line with a ×N badge", async () => {
    const harness = await mountSystemLogs();
    const ts = new Date(2026, 0, 1, 12, 4, 11).getTime();
    // config WARN 每秒刷屏（用户截图的场景）：同一条目连打四拍，中间夹一条不同的
    harness.events.frame("log", structuredEvent(0, ts, "warn", "config", "retrying quota poll"));
    harness.events.frame("log", structuredEvent(1, ts + 1000, "warn", "config", "retrying quota poll"));
    harness.events.frame("log", structuredEvent(2, ts + 2000, "warn", "config", "retrying quota poll"));
    harness.events.frame("log", structuredEvent(3, ts + 3000, "info", "proxy", "recovered"));
    harness.events.frame("log", structuredEvent(4, ts + 4000, "warn", "config", "retrying quota poll"));
    await harness.settle();

    // 三个连续 run：×3（前两段合并）、recovered、×1；折叠只影响显示，缓冲里五条都在
    const lines = logLines(harness);
    expect(lines).toHaveLength(3);
    expect(lines[0].querySelector(".log__repeat")?.textContent).toBe("×3");
    // 折叠行取组内最后一行（时间戳最新、最有代表性）
    expect(lines[0].querySelector(".log__time")?.textContent).toBe("12:04:13");
    expect(lines[0].getAttribute("title")).toContain("3");
    expect(lines[1].textContent).toContain("recovered");
    expect(lines[2].querySelector(".log__repeat")).toBeNull();

    // 点击展开：整组原样回到三行（数据没丢），再点收起
    harness.click(lines[0]);
    await harness.settle();
    const expanded = logLines(harness);
    expect(expanded).toHaveLength(5);
    expect(expanded[0].querySelector(".log__time")?.textContent).toBe("12:04:11");

    harness.click(expanded[0]);
    await harness.settle();
    expect(logLines(harness)).toHaveLength(3);
  });

  it("collapses plain (entry-less) lines by their timestamp-stripped content", async () => {
    const harness = await mountSystemLogs();
    // 同一句话在第 0 秒和第 1 秒打出：去时间戳后是同一条日志
    harness.events.frame("log", logEvent(0, "12:04:11 WARN [config] hot reload failed"));
    harness.events.frame("log", logEvent(1, "12:04:12 WARN [config] hot reload failed"));
    harness.events.frame("log", logEvent(2, "12:04:13 INFO [proxy] other"));
    await harness.settle();

    const lines = logLines(harness);
    expect(lines).toHaveLength(2);
    expect(lines[0].querySelector(".log__repeat")?.textContent).toBe("×2");
    expect(lines[0].textContent).toContain("12:04:12 WARN [config] hot reload failed");
  });

  it("clears only the active tab's view buffer (LogBuffer / RequestStore untouched)", async () => {
    const harness = await openRequestsTab([okRecord()]);
    expect(reqRows(harness)).toHaveLength(1);

    // 请求 tab 的清空：只清视图缓冲（暂停按钮同在工具栏里，行为与系统 tab 共享）
    const clearButtons = nodes(harness.find('[data-role="log-filters-requests"]'), '[data-action="clear-logs"]');
    harness.click(clearButtons[clearButtons.length - 1] as PageNode);
    await harness.settle();
    expect(reqRows(harness)).toHaveLength(0);
    expect(harness.role("req-empty")?.hasAttribute("hidden")).toBe(false);

    // 系统 tab 的清空照旧：只清日志缓冲
    harness.click(harness.find('[data-log-tab="system"]'));
    harness.events.frame("log", logEvent(0, "hello system"));
    await harness.settle();
    const systemClear = nodes(harness.find('[data-role="log-filters-system"]'), "button");
    harness.click(systemClear[systemClear.length - 1] as PageNode);
    await harness.settle();
    expect(logLines(harness)).toHaveLength(0);
  });

  it("colours the key=value segments of a structured body", async () => {
    const harness = await mountSystemLogs();
    const ts = new Date(2026, 0, 1, 12, 4, 11).getTime();
    /* 与 logger 的 text 格式同形：带空格的值会被加引号（`renderValue`），所以这条
       行的 message 是一整段带引号的字符串——分段必须把它当一个值，不能按空白切。 */
    harness.events.frame(
      "log",
      structuredEvent(0, ts, "info", "claim", "claim tick", {
        account: "work-team",
        message: '"claim: hold 300s — no claimable plans"',
      }),
    );
    await harness.settle();

    const body = logLines(harness)[0].querySelector(".log__msg") as PageNode;
    // 键 → 弱色层、值 → 正文层（着色只加 span，不改文本）
    expect(nodes(body, ".log__kv--key").map((nodeName) => nodeName.textContent)).toEqual(["account=", "message="]);
    expect(nodes(body, ".log__kv--val").map((nodeName) => nodeName.textContent)).toEqual([
      "work-team",
      '"claim: hold 300s — no claimable plans"',
    ]);
    expect(body.textContent).toBe('claim tick account=work-team message="claim: hold 300s — no claimable plans"');
    // 两个键值对 = 4 个分段（键、值各一个）
    expect(nodes(body, ".log__kv")).toHaveLength(4);
  });
});

describe("logs page — request events tab", () => {
  it("renders two tabs, opens on the requests view and swaps the filter rows", async () => {
    const harness = await mountSettled("/logs", statePayload());
    // 两个 tab，请求事件在前且默认选中（请求事件是这一页的主内容）
    const tabs = nodes(harness.role("log-tabs"), "[data-log-tab]");
    expect(tabs.map((tab) => tab.getAttribute("data-log-tab"))).toEqual(["requests", "system"]);
    expect(harness.find('[data-log-tab="requests"]')?.className).toContain("tab--active");
    expect(harness.role("log-filters-requests")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("log-filters-system")?.hasAttribute("hidden")).toBe(true);
    expect(harness.role("log-panel-system")?.hasAttribute("hidden")).toBe(true);
    expect(harness.role("log-panel-requests")?.hasAttribute("hidden")).toBe(false);

    /* 全仓 tab 一套契约：`role="tab"` + `aria-selected`（不允许裸属性）。
       切换后选中的那颗是 `true`，另一颗显式 `false`。 */
    expect(tabs.map((tab) => tab.getAttribute("role"))).toEqual(["tab", "tab"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false"]);

    harness.click(harness.find('[data-log-tab="system"]'));
    expect(harness.find('[data-log-tab="system"]')?.className).toContain("tab--active");
    expect(harness.find('[data-log-tab="system"]')?.getAttribute("aria-selected")).toBe("true");
    expect(harness.find('[data-log-tab="requests"]')?.getAttribute("aria-selected")).toBe("false");
    expect(harness.role("log-filters-system")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("log-filters-requests")?.hasAttribute("hidden")).toBe(true);
    expect(harness.role("log-panel-requests")?.hasAttribute("hidden")).toBe(true);

    // 切走再切回：缓冲的日志还在（同一次挂载里先喂一行再切回来）
    harness.events.frame("log", logEvent(0, "hello system"));
    await harness.settle();
    harness.click(harness.find('[data-log-tab="requests"]'));
    harness.click(harness.find('[data-log-tab="system"]'));
    expect(logLines(harness).map((line) => line.textContent)).toEqual(["hello system"]);
  });

  it("loads the full list once via getRequests when the requests tab opens (默认就是它)", async () => {
    // 默认 tab 就是请求事件：初始加载在进页面这一拍发出，应答要在挂载前就位。
    const harness = await mountSettled("/logs", statePayload(), {
      controlReply: { ok: true, event: "requests", records: [okRecord(), failedRecord()] },
    });

    expect(commands(harness).map((call) => call.body)).toEqual([{ cmd: "getRequests", limit: 200 }]);
    const rows = reqRows(harness);
    expect(rows).toHaveLength(2);
    // 初始加载的顺序就是记录顺序（服务端 `recent()` 已按新的在前排好）
    expect(rows[0]?.getAttribute("data-req-id")).toBe("#w16c-001");

    // 再切走再切回：不重复拉（初始加载一次，之后靠增量）
    harness.click(harness.find('[data-log-tab="system"]'));
    harness.click(harness.find('[data-log-tab="requests"]'));
    await harness.settle();
    expect(commands(harness).filter((call) => (call.body as { cmd?: string }).cmd === "getRequests")).toHaveLength(1);
  });

  it("renders the fourteen columns (plus cache, effort and retries)", async () => {
    const harness = await openRequestsTab([okRecord()]);
    const head = nodes(harness.find('[data-role="req-table"] thead'), "th");
    expect(head.map((th) => th.textContent)).toEqual([
      "时间",
      "reqId",
      "请求 / 端点",
      "来源",
      "模型",
      "状态",
      "用时",
      "缓存",
      "推理强度",
      "重试",
      "tok/s",
      "tokens",
      "key",
      "错误",
    ]);

    const cells = nodes(reqRows(harness)[0], "td");
    expect(cells).toHaveLength(14);
    expect(cells[0]?.textContent).toBe("12:00:00"); // 本地 HH:MM:SS，与终端表格同口径
    expect(cells[1]?.textContent).toBe("#w16c-001");
    // 请求两行：流式/批量 + 路由，下面是这次真正打的端点路径（upstreamUrl 的 path）
    expect(cells[2]?.querySelector(".req__req-mode")?.textContent).toBe("流式");
    expect(cells[2]?.querySelector(".req__req-mode")?.className).toContain("req__req-mode--stream");
    expect(cells[2]?.querySelector(".req__req-route")?.textContent).toBe("start-plan");
    expect(cells[2]?.querySelector(".req__req-path")?.textContent).toBe("-"); // 夹具没有 upstreamUrl
    // 来源：账号名 + 身份色点（确定性下标，六档）
    expect(cells[3]?.querySelector(".req__source-name")?.textContent).toBe("work-team");
    expect(cells[3]?.querySelector(".req__source-dot")?.className).toMatch(/req__source-dot--[1-6]/);
    expect(cells[4]?.textContent).toBe("glm-5.3-flash");
    // 状态：StatusBadge（组件层），2xx 绿
    expect(cells[5]?.querySelector(".status-badge--ok")).not.toBeNull();
    expect(cells[5]?.textContent).toBe("200");
    // 用时两行：总用时大字、首响小字（fmtMs 口径）
    expect(cells[6]?.querySelector(".req__ms-main")?.textContent).toBe("2.9s");
    expect(cells[6]?.querySelector(".req__ms-sub")?.textContent).toBe("ttfb 1.2s");
    // 缓存：夹具没报缓存桶 → `-`（「上游没报」不能显示成 0%）
    expect(cells[7]?.textContent).toBe("-");
    // 推理强度：夹具没带 reasoningEffort → `-`（「没说」不是「关」）
    expect(cells[8]?.textContent).toBe("-");
    // 重试：upstreamAttempts 不在场 → `-`
    expect(cells[9]?.textContent).toBe("-");
    expect(cells[10]?.textContent).toBe("200.4"); // tps 一位小数
    // tokens 两行：↑ 产出 / ↓ 输入，≥1000 走 App.format.compact 缩写
    expect(cells[11]?.querySelector(".req__tok")?.textContent).toBe("↑179k");
    expect(cells[11]?.querySelector(".req__tok--in")?.textContent).toBe("↓12k");
    expect(cells[12]?.textContent).toBe("—"); // 无归因 → —
    expect(cells[13]?.textContent).toBe("-"); // 无错误 → -
  });

  it("fills cache hit rate, reasoning effort, retries and the endpoint path", async () => {
    const harness = await openRequestsTab([
      okRecord({
        reqId: "#w16c-020",
        stream: false,
        route: "coding-plan",
        upstreamUrl: "https://zcode.z.ai/api/v1/ultra/v1/messages?beta=true",
        cacheReadTokens: 12480,
        cacheCreationTokens: 3120,
        reasoningEffort: "high",
        upstreamAttempts: 3,
        queueMs: 640,
        responseBytes: 20480,
      }),
    ]);
    const cells = nodes(reqRows(harness)[0], "td");

    // 请求：批量 + 路由，端点路径去掉 origin 与 query（完整 URL 在 title 里）
    expect(cells[2]?.querySelector(".req__req-mode")?.textContent).toBe("批量");
    expect(cells[2]?.querySelector(".req__req-mode")?.className).not.toContain("--stream");
    expect(cells[2]?.querySelector(".req__req-route")?.textContent).toBe("coding-plan");
    const path = cells[2]?.querySelector(".req__req-path");
    expect(path?.textContent).toBe("/api/v1/ultra/v1/messages");
    expect(path?.getAttribute("title")).toContain("?beta=true");

    // 缓存：本条记录的命中率 read ÷ (input + read + creation)（与统计页同口径）。
    // 夹具的默认 input=12480 / read=12480 / creation=3120 → 12480/28080 ≈ 44%。
    // 副行是 read/creation。
    expect(cells[7]?.querySelector(".req__cache-rate")?.textContent).toBe("44%");
    expect(cells[7]?.querySelector(".req__cache-split")?.textContent).toBe("12k/3.1k");
    expect(cells[7]?.querySelector(".req__cache-rate")?.getAttribute("title")).toContain("cache read");

    // 推理强度：四档小片
    expect(cells[8]?.querySelector(".req__effort--high")?.textContent).toBe("高");

    // 重试：只有 >1 才有值
    expect(cells[9]?.textContent).toBe("×3");

    // 展开行补上表格装不下的字段（推理强度 / 尝试次数 / 排队 / 响应体）
    harness.click(reqRows(harness)[0] as PageNode);
    const meta = reqDetail(harness)?.querySelector(".req__meta");
    expect(meta?.textContent).toContain("推理强度: high");
    expect(meta?.textContent).toContain("上游尝试: 3");
    expect(meta?.textContent).toContain("排队: 640ms");
    expect(meta?.textContent).toContain("响应体: 20480 B");
  });

  it("folds cache / effort / attempts into the row expansion at ≤1440", async () => {
    /* happy-dom 的窗口宽 1024（<1440），所以 `matchMedia(C.REQUEST_FOLD_MEDIA)` 命中：
       三列进展开行，展开行与表尾行按十一列算 `colSpan`。 */
    const harness = await openRequestsTab([
      okRecord({
        reqId: "#w16c-040",
        cacheReadTokens: 12480,
        cacheCreationTokens: 3120,
        reasoningEffort: "high",
        upstreamAttempts: 3,
      }),
    ]);
    const cells = nodes(reqRows(harness)[0], "td");

    /* 三列仍在 DOM 里（折叠是 CSS 的 `display: none`，不是删列），且带折叠钩子：
       缓存 / 推理强度 / 重试。 */
    for (const index of [7, 8, 9]) expect(cells[index]?.className).toBe("req__col--extra");
    expect(cells[6]?.className).not.toContain("req__col--extra");
    expect(cells[10]?.className).not.toContain("req__col--extra");

    /* 折叠后表里只有十一列：展开行跨十一，不再写十四（写十四只能靠浏览器截断
       余量才看对）。 */
    harness.click(reqRows(harness)[0] as PageNode);
    expect(reqDetail(harness)?.querySelector("td")?.colSpan).toBe(11);
    expect(harness.role("req-body")?.querySelector(".req__history td")?.colSpan).toBe(11);

    /* 缓存的值不丢：展开行的元信息里逐项给出（口径与格子同一份）。 */
    const meta = reqDetail(harness)?.querySelector(".req__meta");
    expect(meta?.textContent).toContain("缓存: 80% · 12k/3.1k");
  });

  it("marks a client abort apart from an upstream failure", async () => {
    const abortedWithoutStatus: RequestRecordFixture = {
      ...okRecord({ reqId: "#w16c-030" }),
      status: undefined,
      clientAborted: true,
      failedStage: "stream-end",
      error: "client aborted",
    };
    const abortedWithStatus = okRecord({
      reqId: "#w16c-031",
      status: 200,
      clientAborted: true,
      failedStage: "stream-end",
    });
    const harness = await openRequestsTab([abortedWithoutStatus, abortedWithStatus]);
    const rows = reqRows(harness);

    // 没有状态码又断了：整格是「断开」的中性徽章，不是「进行中」也不是上游失败
    const first = rows.find((row) => row.getAttribute("data-req-id") === "#w16c-030") as PageNode;
    const firstStatus = nodes(first, "td")[5] as PageNode;
    expect(firstStatus.querySelector(".status-badge--aborted")?.textContent).toBe("断开");
    expect(firstStatus.querySelector(".status-badge--pending")).toBeNull();
    expect(firstStatus.querySelector(".status-badge--danger")).toBeNull();
    // 行标识也不染红（clientAborted 不是「上游失败」）
    expect(first.className).toContain("req__row--aborted");
    expect(first.className).not.toContain("req__row--error");

    // 拿到过状态码又断了：状态码照旧上色，另挂一枚中性「断开」标记
    const second = rows.find((row) => row.getAttribute("data-req-id") === "#w16c-031") as PageNode;
    const secondStatus = nodes(second, "td")[5] as PageNode;
    expect(secondStatus.querySelector(".status-badge--ok")?.textContent).toBe("200");
    expect(secondStatus.querySelector(".req__aborted")?.textContent).toBe("断开");
    expect(secondStatus.querySelector(".req__aborted")?.getAttribute("title")).toContain("不是上游失败");
  });

  it("exports the currently filtered records as a JSON download", async () => {
    const harness = await openRequestsTab([
      okRecord({ reqId: "#w16c-040" }),
      failedRecord({ reqId: "#w16c-041" }),
    ]);
    const doc = harness.win.document as unknown as {
      createElement: (tag: string) => PageNode;
    };
    const realCreate = doc.createElement.bind(doc);
    const anchors: PageNode[] = [];
    doc.createElement = (tag: string) => {
      const node = realCreate(tag);
      if (tag.toLowerCase() === "a") anchors.push(node);
      return node;
    };
    const urlScope = harness.win.URL as unknown as {
      createObjectURL: (blob: unknown) => string;
      revokeObjectURL: (url: string) => void;
    };
    const realCreateUrl = urlScope.createObjectURL;
    const realRevokeUrl = urlScope.revokeObjectURL;
    const blobs: Array<{ text(): Promise<string> }> = [];
    const revoked: string[] = [];
    urlScope.createObjectURL = (blob: unknown) => {
      blobs.push(blob as { text(): Promise<string> });
      return "blob:w80-export";
    };
    urlScope.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
    try {
      // 先按状态筛成 2xx，再导出：文件内容必须与表里看到的行一致
      harness.change(harness.role("req-status"), "2xx");
      harness.click(harness.find('[data-action="export-requests"]') as PageNode);
      await harness.settle();
    } finally {
      urlScope.createObjectURL = realCreateUrl;
      urlScope.revokeObjectURL = realRevokeUrl;
      doc.createElement = realCreate;
    }

    expect(blobs).toHaveLength(1);
    expect(anchors).toHaveLength(1);
    // 文件名带时刻（下载目录里能按名字排序找），href 是这次创建的 blob
    expect(anchors[0].getAttribute("download")).toMatch(/^zcode-requests-\d{8}-\d{6}\.json$/);
    expect(anchors[0].getAttribute("href")).toBe("blob:w80-export");

    const file = JSON.parse(await blobs[0].text()) as {
      exportedAt: string;
      filters: Record<string, string>;
      count: number;
      records: RequestRecordFixture[];
    };
    expect(file.count).toBe(1);
    expect(file.records.map((record) => record.reqId)).toEqual(["#w16c-040"]);
    expect(file.filters.status).toBe("2xx");
    expect(typeof file.exportedAt).toBe("string");
  });

  it("prefixes the date on records from another calendar day", async () => {
    // 跨天：时间列补上日期（MM-DD HH:MM:SS）——日志开一夜，隔天早上的
    // 「07:57:59」不知道是哪天的。基准时间 2026-01-01，拿一个前一天的时刻。
    const yesterday = new Date(BASE_TIME);
    yesterday.setDate(yesterday.getDate() - 1);
    const harness = await openRequestsTab([okRecord({ reqId: "#w16c-011", startedAt: yesterday.getTime() })]);
    const cells = nodes(reqRows(harness)[0], "td");
    const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
    expect(cells[0]?.textContent).toBe(
      `${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())} ${pad(yesterday.getHours())}:${pad(yesterday.getMinutes())}:${pad(yesterday.getSeconds())}`,
    );
  });

  it("fills the missing fields with the placeholders", async () => {
    const pending: RequestRecordFixture = {
      ...okRecord({ reqId: "#w16c-010" }),
      account: undefined,
      route: undefined,
      status: undefined,
      ttfbMs: undefined,
      totalMs: undefined,
      tps: undefined,
      inputTokens: undefined,
      outputTokens: undefined,
      model: "-",
    };
    const harness = await openRequestsTab([pending]);
    const cells = nodes(reqRows(harness)[0], "td");
    expect(cells[3]?.textContent).toBe("-"); // 来源无账号 → -
    expect(cells[2]?.querySelector(".req__req-route")).toBeNull(); // 路由无 → 不渲染这一段
    expect(cells[2]?.querySelector(".req__req-path")?.textContent).toBe("-"); // 端点没走到 → -
    expect(cells[4]?.textContent).toBe("-"); // 模型占位 → -
    expect(cells[5]?.querySelector(".status-badge--pending")).not.toBeNull(); // 进行中
    expect(cells[5]?.textContent).toBe("…");
    expect(cells[6]?.textContent).toBe("-"); // 用时无 → -
    expect(cells[7]?.textContent).toBe("-"); // 缓存没报 → -
    expect(cells[8]?.textContent).toBe("-"); // 推理强度没说 → -
    expect(cells[9]?.textContent).toBe("-"); // 尝试次数无 → -
    expect(cells[10]?.textContent).toBe("-"); // 速度无 → -
    expect(cells[11]?.textContent).toBe("-"); // tokens 无 → -
    expect(cells[12]?.textContent).toBe("—"); // 无归因 → —
    expect(cells[13]?.textContent).toBe("-"); // 错误无 → -
  });

  it("marks a failed request with the danger status and the failed row", async () => {
    const harness = await openRequestsTab([failedRecord()]);
    const row = reqRows(harness)[0] as PageNode;
    expect(row.className).toContain("req__row--error");
    const badge = nodes(row, "td")[5] as PageNode;
    expect(badge.querySelector(".status-badge--danger")).not.toBeNull();
    expect(badge.textContent).toBe("500");
    expect(nodes(row, "td")[13]?.textContent).toContain("连接失败");
    expect(nodes(row, "td")[13]?.textContent).toContain("网络或上游网关异常");
  });

  it("expands a row into the stage timeline and collapses it on a second click", async () => {
    const harness = await openRequestsTab([okRecord()]);
    harness.click(reqRows(harness)[0] as PageNode);

    const detail = reqDetail(harness);
    expect(detail).not.toBeNull();
    // 头行：reqId · 账号 · 路由 · 协议 · 模型 · 状态 · 总耗时
    expect(detail?.querySelector(".req__detail-head")?.textContent).toBe(
      "#w16c-001 · work-team · start-plan · anthropic · glm-5.3-flash · 200 · 2.9s",
    );
    // 元信息：表格列放不下的字段 + 转储提示
    const meta = detail?.querySelector(".req__meta");
    expect(meta?.textContent).toContain("12480 B");
    expect(meta?.textContent).toContain("请求上下文记录");
    const stages = nodes(detail, ".req__stage-name");
    expect(stages).toHaveLength(6);
    // 每个阶段一行人话：✓ + 阶段名 + atMs + 摘要（格式有测试钉住）
    const lines = nodes(detail, ".req__stage");
    expect(lines[0]?.textContent).toContain("intake");
    expect(lines[0]?.textContent).toContain("anthropic · stream · 12480 bytes");
    expect(lines[1]?.textContent).toContain("account=work-team route=start-plan queue=16ms");
    expect(lines[2]?.textContent).toContain("transform 15620 bytes · system-prompt");
    expect(lines[3]?.textContent).toContain("41 headers · unsigned");
    expect(lines[4]?.textContent).toContain("status 200 · ttfb 1240ms · gzip");
    expect(lines[5]?.textContent).toContain("179296 tokens · 200.4 t/s");
    // ✓ 标记
    expect(nodes(detail, ".req__stage-mark").every((mark) => mark.textContent === "✓")).toBe(true);

    harness.click(reqRows(harness)[0] as PageNode);
    expect(reqDetail(harness)).toBeNull();
  });

  it("marks the failedStage row with ✗ and appends the error text at the end", async () => {
    const harness = await openRequestsTab([failedRecord()]);
    harness.click(reqRows(harness)[0] as PageNode);

    const detail = reqDetail(harness);
    expect(detail).not.toBeNull();
    // 两个阶段（intake / upstream-resp），时间线按发生顺序
    const names = nodes(detail, ".req__stage-name");
    expect(names.map((name) => name.textContent)).toEqual(["intake", "upstream-resp"]);
    // failedStage 的那一行：✗ + danger 色 + 相对时刻
    const failedLines = nodes(detail, ".req__stage--error");
    expect(failedLines.length).toBe(2); // failedStage 行 + 末尾的 error 行
    const failedLine = failedLines[0] as PageNode;
    expect(failedLine.querySelector(".req__stage-mark")?.textContent).toBe("✗");
    expect(failedLine.textContent).toContain("upstream-resp");
    expect(failedLine.textContent).toContain("1263ms");
    // 末尾的错误行：failedStage 的 error 原文
    const last = failedLines[failedLines.length - 1] as PageNode;
    expect(last.textContent).toContain("连接失败");
    expect(last.textContent).toContain("ascii codec");
  });

  it("inserts SSE request events at the top and dedupes by reqId", async () => {
    const harness = await openRequestsTab([okRecord()]);
    expect(reqRows(harness)).toHaveLength(1);

    // 新请求：插到行首
    harness.events.frame("request", failedRecord());
    await harness.settle();
    let rows = reqRows(harness);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("data-req-id")).toBe("#w16c-002");

    // 同一 reqId 重放（重连后的重复推送）：原地替换，不新增一行
    harness.events.frame("request", failedRecord({ totalMs: 1300 }));
    await harness.settle();
    rows = reqRows(harness);
    expect(rows).toHaveLength(2);
    expect(nodes(rows[0] as PageNode, "td")[6]?.querySelector(".req__ms-main")?.textContent).toBe("1.3s");
  });

  it("filters by status, account, route, model, key and search text", async () => {
    const harness = await openRequestsTab([
      okRecord(),
      failedRecord(),
      okRecord({ reqId: "#w16c-003", account: "payg", route: "coding-plan", status: 401, model: "glm-5.3" }),
    ]);
    expect(reqRows(harness)).toHaveLength(3);

    // 状态六档：三个桶按状态码分段，「错误」是失败并集，进行中是没状态码
    harness.change(harness.role("req-status"), "2xx");
    expect(reqRows(harness).map((row) => row.getAttribute("data-req-id"))).toEqual(["#w16c-001"]);
    harness.change(harness.role("req-status"), "4xx");
    expect(reqRows(harness).map((row) => row.getAttribute("data-req-id"))).toEqual(["#w16c-003"]);
    harness.change(harness.role("req-status"), "5xx");
    expect(reqRows(harness).map((row) => row.getAttribute("data-req-id"))).toEqual(["#w16c-002"]);
    harness.change(harness.role("req-status"), "error");
    // failedRecord 带 failedStage；401 的那条只是状态码，不算失败
    expect(reqRows(harness).map((row) => row.getAttribute("data-req-id"))).toEqual(["#w16c-002"]);
    harness.change(harness.role("req-status"), "pending");
    expect(reqRows(harness)).toHaveLength(0);
    harness.change(harness.role("req-status"), "all");
    expect(reqRows(harness)).toHaveLength(3);

    harness.change(harness.role("req-account"), "payg");
    expect(reqRows(harness).map((row) => row.getAttribute("data-req-id"))).toEqual(["#w16c-003"]);
    harness.change(harness.role("req-account"), "");

    harness.change(harness.role("req-route"), "coding-plan");
    expect(reqRows(harness).map((row) => row.getAttribute("data-req-id"))).toEqual(["#w16c-003"]);
    harness.change(harness.role("req-route"), "");

    harness.change(harness.role("req-model"), "glm-5.3");
    expect(reqRows(harness).map((row) => row.getAttribute("data-req-id"))).toEqual(["#w16c-003"]);
    harness.change(harness.role("req-model"), "");

    // key 过滤：三条都无归因 → 聚合出一个「无归因」选项
    harness.change(harness.role("req-key"), "none");
    expect(reqRows(harness)).toHaveLength(3);
    harness.change(harness.role("req-key"), "all");

    // 文本搜索认 reqId（大小写不敏感）
    harness.type(harness.role("req-search"), "W16C-002");
    expect(reqRows(harness).map((row) => row.getAttribute("data-req-id"))).toEqual(["#w16c-002"]);
    harness.type(harness.role("req-search"), "");
    expect(reqRows(harness)).toHaveLength(3);
  });

  it("aggregates the account / model / key filter options from seen records", async () => {
    const harness = await openRequestsTab([
      okRecord(),
      okRecord({ reqId: "#w16c-004", account: "payg", model: "glm-5.3", apiKeyId: "a1b2c3d4e5f60718" }),
    ]);
    // 账号与模型按首次出现顺序；key 把没归因的聚合成一个「无归因」选项
    expect(nodes(harness.role("req-account"), "option").map((option) => option.textContent)).toEqual([
      "全部账号",
      "work-team",
      "payg",
    ]);
    expect(nodes(harness.role("req-model"), "option").map((option) => option.textContent)).toEqual([
      "全部模型",
      "glm-5.3-flash",
      "glm-5.3",
    ]);
    expect(nodes(harness.role("req-key"), "option").map((option) => option.value)).toEqual([
      "all",
      "a1b2c3d4e5f60718",
      "none",
    ]);
    // 「无归因」选项的文案走 i18n，原始值 `none` 只留在 value 里
    expect(nodes(harness.role("req-key"), "option").map((option) => option.textContent)).toEqual([
      "全部 key",
      "a1b2c3d4e5f60718",
      "无归因",
    ]);
    // 路由仍是稳定枚举（技术标识不翻译）
    expect(nodes(harness.role("req-route"), "option").map((option) => option.value)).toEqual([
      "",
      "coding-plan",
      "start-plan",
      "off-peak",
      "highspeed",
    ]);
  });

  it("keeps at most 200 rows, matching the server capacity", async () => {
    const records: RequestRecordFixture[] = [];
    for (let i = 0; i < 205; i++) {
      records.push(okRecord({ reqId: `#bulk-${String(i).padStart(3, "0")}`, startedAt: BASE_TIME + i * 1000 }));
    }
    // 修到 205 条（超过 REQUEST_ROW_LIMIT）：最新的 200 条留下，最旧的 5 条丢弃
    records.reverse();
    const harness = await openRequestsTab(records);
    expect(reqRows(harness)).toHaveLength(200);
    // 最新的一条（#bulk-204）在行首，最旧的 #bulk-000 已被挤掉
    expect(reqRows(harness)[0]?.getAttribute("data-req-id")).toBe("#bulk-204");
  });

  it("shows the empty state until a record arrives", async () => {
    const harness = await openRequestsTab([]);
    expect(harness.role("req-empty")?.hasAttribute("hidden")).toBe(false);
    harness.events.frame("request", okRecord());
    await harness.settle();
    expect(harness.role("req-empty")?.hasAttribute("hidden")).toBe(true);
  });

  /* ---- 加载更早 ------------------------------------------------------- */

  /** 表尾的「加载更早」行。*/
  function historyRow(harness: Harness): PageNode | null {
    return harness.find("tr.req__history");
  }

  /** 「加载更早」按钮。*/
  function historyButton(harness: Harness): PageNode | null {
    return harness.find('[data-action="load-requests-history"]');
  }

  it("loads an earlier page onto the tail with the buffered oldest as cursor", async () => {
    const harness = await openRequestsTab([okRecord({ reqId: "#h-003", startedAt: BASE_TIME })]);
    // 初始状态：按钮在表尾（空缓冲时也在，它是清空后的恢复入口）。
    expect(historyButton(harness)).not.toBeNull();
    expect(historyRow(harness)?.hasAttribute("hidden")).toBe(false);

    harness.controlReply = {
      ok: true,
      event: "requestsHistory",
      hasMore: true,
      requests: [
        okRecord({ reqId: "#h-002", startedAt: BASE_TIME - 1000 }),
        okRecord({ reqId: "#h-001", startedAt: BASE_TIME - 2000 }),
      ],
    };
    harness.click(historyButton(harness));
    await harness.settle();

    // 历史行追加在表尾（时间倒序延续），不是插到行首。
    expect(reqRows(harness).map((row) => row.getAttribute("data-req-id"))).toEqual(["#h-003", "#h-002", "#h-001"]);
    // 游标 = 发命令时缓冲里最早一条的 startedAt（内存段只有 #h-003）。
    const call = commands(harness).find((item) => (item.body as { cmd?: string }).cmd === "getRequestsHistory");
    expect(call?.body).toEqual({ cmd: "getRequestsHistory", limit: 100, before: BASE_TIME });
  });

  it("walks multiple pages: cursor advances to the oldest loaded record", async () => {
    const harness = await openRequestsTab([okRecord({ reqId: "#h-004", startedAt: BASE_TIME })]);
    harness.controlReplies = [
      { ok: true, event: "requestsHistory", hasMore: true, requests: [okRecord({ reqId: "#h-003", startedAt: BASE_TIME - 1000 })] },
      { ok: true, event: "requestsHistory", hasMore: false, requests: [okRecord({ reqId: "#h-002", startedAt: BASE_TIME - 2000 })] },
    ];
    harness.click(historyButton(harness));
    await harness.settle();
    harness.click(historyButton(harness));
    await harness.settle();

    expect(reqRows(harness).map((row) => row.getAttribute("data-req-id"))).toEqual(["#h-004", "#h-003", "#h-002"]);
    const bodies = commands(harness)
      .map((item) => item.body as { cmd?: string; before?: number })
      .filter((body) => body.cmd === "getRequestsHistory");
    // 第二次游标 = 第一页之后缓冲里最早一条（含重发的去重后）的 startedAt。
    expect(bodies[1]?.before).toBe(BASE_TIME - 1000);
  });

  it("dedupes history pages against the memory segment and collapses the button on hasMore=false", async () => {
    const harness = await openRequestsTab([okRecord({ reqId: "#h-002", startedAt: BASE_TIME })]);
    // 首页含游标上的重发（#h-002 就在缓冲里）。
    harness.controlReply = {
      ok: true,
      event: "requestsHistory",
      hasMore: false,
      requests: [okRecord({ reqId: "#h-002", startedAt: BASE_TIME }), okRecord({ reqId: "#h-001", startedAt: BASE_TIME - 1000 })],
    };
    harness.click(historyButton(harness));
    await harness.settle();

    // 重发的不重复渲染；新的一条在尾部。
    expect(reqRows(harness).map((row) => row.getAttribute("data-req-id"))).toEqual(["#h-002", "#h-001"]);
    // hasMore=false：整行收起，按钮点不到。
    expect(historyRow(harness)?.hasAttribute("hidden")).toBe(true);
  });

  it("disables the button while a page is in flight and ignores stale replies after clear", async () => {
    const harness = await openRequestsTab([]);
    harness.controlReplies = [
      { ok: true, event: "requestsHistory", hasMore: true, requests: [okRecord({ reqId: "#h-009", startedAt: BASE_TIME - 5000 })] },
    ];
    harness.click(historyButton(harness));
    // fetch 桩是异步的：点击这一刻就进入加载态（禁点 + 文案）。
    expect(historyButton(harness)?.hasAttribute("disabled")).toBe(true);
    expect(historyButton(harness)?.textContent).toBe("加载中…");
    // 加载中再点不重发。
    harness.click(historyButton(harness));
    await harness.settle();
    expect(reqRows(harness)).toHaveLength(1);
    expect(commands(harness).filter((item) => (item.body as { cmd?: string }).cmd === "getRequestsHistory")).toHaveLength(1);
  });

  it("applies the filters to history rows and aggregates their options", async () => {
    const harness = await openRequestsTab([okRecord({ reqId: "#h-002", startedAt: BASE_TIME, account: "work-team" })]);
    harness.controlReply = {
      ok: true,
      event: "requestsHistory",
      hasMore: false,
      requests: [okRecord({ reqId: "#h-001", startedAt: BASE_TIME - 1000, account: "old-team", model: "glm-4.6" })],
    };
    harness.click(historyButton(harness));
    await harness.settle();
    expect(reqRows(harness)).toHaveLength(2);

    // 过滤维对历史行同样生效（渲染层过滤，无需分页协同）。
    harness.change(harness.role("req-account"), "old-team");
    expect(reqRows(harness).map((row) => row.getAttribute("data-req-id"))).toEqual(["#h-001"]);
    harness.change(harness.role("req-account"), "");

    // 历史段的账号 / 模型也进了下拉选项（选项聚合源含历史段）。
    const options = nodes(harness.role("req-account"), "option").map((option) => option.value);
    expect(options).toContain("old-team");
    expect(options).toContain("work-team");
  });

  it("clear resets the history segment and brings the button back", async () => {
    const harness = await openRequestsTab([okRecord({ reqId: "#h-002" })]);
    harness.controlReply = {
      ok: true,
      event: "requestsHistory",
      hasMore: false,
      requests: [okRecord({ reqId: "#h-001", startedAt: BASE_TIME - 1000 })],
    };
    harness.click(historyButton(harness));
    await harness.settle();
    expect(reqRows(harness)).toHaveLength(2);
    expect(historyRow(harness)?.hasAttribute("hidden")).toBe(true);

    const clearButtons = nodes(harness.find('[data-role="log-filters-requests"]'), '[data-action="clear-logs"]');
    harness.click(clearButtons[clearButtons.length - 1] as PageNode);
    await harness.settle();
    expect(reqRows(harness)).toHaveLength(0);
    // 清空后按钮回到初始态：可见，可再把文件里的历史拉回来。
    expect(historyRow(harness)?.hasAttribute("hidden")).toBe(false);
  });
});

describe("logs page — request events i18n", () => {
  it("fills the status filter with the six buckets and re-translates on switch", async () => {
    const harness = await mountSettled("/logs", statePayload());
    // 状态下拉在请求 tab 的过滤器行里，选项是静态枚举（中文首屏）
    expect(nodes(harness.role("req-status"), "option").map((option) => option.textContent)).toEqual([
      "全部状态",
      "2xx",
      "4xx",
      "5xx",
      "进行中",
      "错误",
    ]);
    expect(harness.find('[data-log-tab="requests"]')?.textContent).toBe("请求事件");

    // 切语言立即生效，选项文案重建
    const panel = (harness.win as unknown as { zcodePanel: { setLanguage(lang: string): void } }).zcodePanel;
    panel.setLanguage("en");
    expect(nodes(harness.role("req-status"), "option").map((option) => option.textContent)).toEqual([
      "All statuses",
      "2xx",
      "4xx",
      "5xx",
      "In flight",
      "Errors",
    ]);
    expect(harness.find('[data-log-tab="requests"]')?.textContent).toBe("Requests");
  });
});

/* ------------------------------------------------------------------------- */
/* 跳转：日志页接外部 key 筛选 / keys 页的用量链接                               */
/* ------------------------------------------------------------------------- */

describe("logs page — external key filter", () => {
  it("lands on the requests tab with the key filter applied from ?key=", async () => {
    const harness = await mountSettled("/logs?key=k001", statePayload());
    // enter() 把请求事件 tab 打开（初始加载吃到默认空应答），记录走 SSE 进
    expect(harness.find('[data-log-tab="requests"]')?.className).toContain("tab--active");
    harness.events.frame("request", okRecord({ reqId: "#k-1", apiKeyId: "k001" }));
    harness.events.frame("request", okRecord({ reqId: "#k-2", apiKeyId: "k002" }));
    await harness.settle();

    expect(harness.role("req-key")?.value).toBe("k001");
    expect(reqRows(harness).map((row) => row.getAttribute("data-req-id"))).toEqual(["#k-1"]);
    harness.close();
  });

  it("maps ?key=none to the unattributed aggregate value", async () => {
    const harness = await mountSettled("/logs?key=none", statePayload());
    harness.events.frame("request", okRecord({ reqId: "#k-3", apiKeyId: "" }));
    harness.events.frame("request", okRecord({ reqId: "#k-4", apiKeyId: "k002" }));
    await harness.settle();

    expect(harness.role("req-key")?.value).toBe("none");
    expect(reqRows(harness).map((row) => row.getAttribute("data-req-id"))).toEqual(["#k-3"]);
    harness.close();
  });

  it("releases the pin when the user picks another value in the key select", async () => {
    const harness = await mountSettled("/logs?key=k001", statePayload());
    harness.events.frame("request", okRecord({ reqId: "#k-1", apiKeyId: "k001" }));
    harness.events.frame("request", okRecord({ reqId: "#k-2", apiKeyId: "k002" }));
    await harness.settle();
    expect(reqRows(harness)).toHaveLength(1);

    // 用户改成「全部」：外部筛选作废，之后选项重建不再钉回 k001
    harness.change(harness.role("req-key"), "all");
    await harness.settle();
    expect(reqRows(harness)).toHaveLength(2);
    harness.close();
  });
});

describe("logs page — ?status= and ?stage= presets", () => {
  it("presets the status filter from ?status=error", async () => {
    const harness = await mountSettled("/logs?status=error", statePayload());
    expect(harness.find('[data-log-tab="requests"]')?.className).toContain("tab--active");
    harness.events.frame("request", okRecord({ reqId: "#e-1" }));
    harness.events.frame("request", failedRecord({ reqId: "#e-2" }));
    await harness.settle();

    expect(harness.role("req-status")?.value).toBe("error");
    expect(reqRows(harness).map((row) => row.getAttribute("data-req-id"))).toEqual(["#e-2"]);
    harness.close();
  });

  it("presets the stage filter from ?stage= and aggregates the options from records", async () => {
    const harness = await mountSettled("/logs?stage=dispatch", statePayload());
    harness.events.frame("request", failedRecord({ reqId: "#d-1", failedStage: "dispatch", error: "every candidate account is cooling down" }));
    harness.events.frame("request", failedRecord({ reqId: "#d-2", failedStage: "upstream-resp" }));
    harness.events.frame("request", okRecord({ reqId: "#d-3" }));
    await harness.settle();

    expect(harness.role("req-stage")?.value).toBe("dispatch");
    expect(reqRows(harness).map((row) => row.getAttribute("data-req-id"))).toEqual(["#d-1"]);
    /* 选项来自已见记录（首现顺序；记录数组新的在前，所以 upstream-resp 先出现）
       + 「全部阶段」。 */
    const labels = nodes(harness.role("req-stage"), "option").map((option) => option.value);
    expect(labels).toEqual(["all", "upstream-resp", "dispatch"]);
    harness.close();
  });

  it("releases the stage pin when the user picks another value", async () => {
    const harness = await mountSettled("/logs?stage=dispatch", statePayload());
    harness.events.frame("request", failedRecord({ reqId: "#d-1", failedStage: "dispatch", error: "cooling down" }));
    harness.events.frame("request", failedRecord({ reqId: "#d-2", failedStage: "upstream-resp" }));
    await harness.settle();
    expect(reqRows(harness)).toHaveLength(1);

    harness.change(harness.role("req-stage"), "all");
    await harness.settle();
    expect(reqRows(harness)).toHaveLength(2);
    harness.close();
  });
});
