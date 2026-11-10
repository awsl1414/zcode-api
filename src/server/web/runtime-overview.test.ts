/**
 * 概览页与统计页（今日四卡 / 时序缩略 / 跳转 / 共享出口告警 / 空态 / 区块渲染 /
 * 取数 / formatUnits）。
 *
 * 脚手架见 `runtime-harness.ts`。
 */

import { describe, expect, it } from "bun:test";
import { DEFAULT_ACCOUNTS_RISK } from "../../config/types.js";
import type { StatePayload } from "../routes-state.js";
import {
  installHarnessHooks,
  account,
  claimOverview,
  mountSettled,
  nodes,
  statePayload,
  usageCalls,
  usageStatsFixture,
} from "./runtime-harness.js";
import type { Harness, MountOptions } from "./runtime-harness.js";

installHarnessHooks();

describe("overview — 可跳转", () => {
  /** 记下 `window.location.assign` 的目标（整页跳转不该真的把测试带走）。*/
  function recordAssigns(harness: Harness): string[] {
    const targets: string[] = [];
    (harness.win as unknown as { location: { assign: (target: string) => void } }).location.assign = (target) => {
      targets.push(target);
    };
    return targets;
  }

  it("turns every summary row into a link to the matching account row", async () => {
    const harness = await mountSettled(
      "/",
      statePayload({ accounts: [account(), account({ label: "home" })] }),
    );
    const rows = nodes(harness.role("accounts-body"), "tr");

    expect(rows.map((row) => row.getAttribute("data-href"))).toEqual([
      "/accounts?focus=work-team",
      "/accounts?focus=home",
    ]);
    /* 行不是 `<a>`（表格里塞不进去），所以靠 tabindex 进 Tab 顺序。 */
    expect(rows[0]?.getAttribute("tabindex")).toBe("0");

    const targets = recordAssigns(harness);
    harness.click(rows[1] ?? null);
    await harness.settle();
    expect(targets).toEqual(["/accounts?focus=home"]);
  });

  it("follows the row on Enter, so the table is reachable from the keyboard", async () => {
    const harness = await mountSettled("/", statePayload({ accounts: [account()] }));
    const row = nodes(harness.role("accounts-body"), "tr")[0];
    const targets = recordAssigns(harness);

    /* `bubbles: true`：真实键盘事件会冒泡到 `<tbody>`，监听挂在那一层。 */
    row?.dispatchEvent(new harness.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await harness.settle();
    expect(targets).toEqual(["/accounts?focus=work-team"]);
  });
});

describe("overview — shared egress alert", () => {
  it("warns when two accounts share one named proxy", async () => {
    const harness = await mountSettled(
      "/",
      statePayload({
        accounts: [account({ label: "a1", proxy: "home" }), account({ label: "a2", proxy: "home" })],
      }),
    );
    expect(harness.role("risk-text")?.textContent).toContain("2 个账号共用同一出口（home）");
  });

  it("counts direct as an egress too", async () => {
    const harness = await mountSettled(
      "/",
      statePayload({
        accounts: [account({ label: "a1", proxy: "direct" }), account({ label: "a2", proxy: "direct" })],
      }),
    );
    expect(harness.role("risk-text")?.textContent).toContain("2 个账号共用同一出口（直连）");
  });

  it("stays quiet when every account has its own exit", async () => {
    const harness = await mountSettled(
      "/",
      statePayload({
        accounts: [account({ label: "a1", proxy: "home" }), account({ label: "a2", proxy: "direct" })],
      }),
    );
    expect(harness.role("risk-banner")?.hasAttribute("hidden")).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */
/* 概览页：无数据时收缩                                                        */
/* ------------------------------------------------------------------------- */

describe("overview — 无数据时收缩", () => {
  /** 带采样的指标段（曲线与指标卡都读它）。*/
  function metrics(overrides: Partial<StatePayload["metrics"]> = {}): StatePayload["metrics"] {
    return { inflight: 0, concurrencyLimit: 8, queueDepth: 0, sampledAt: 0, inflightHistory: [], ...overrides };
  }

  it("aggregates the four metric cards from the snapshot", async () => {
    const harness = await mountSettled(
      "/",
      statePayload({
        accounts: [
          account({ label: "a1", health: "ok", inflight: 2, maxConcurrency: 4 }),
          account({ label: "a2", health: "cooling", inflight: 1, maxConcurrency: 5 }),
        ],
        metrics: metrics({ inflight: 3, concurrencyLimit: 8 }),
      }),
    );

    expect(harness.role("metric-accounts")?.textContent).toBe("2");
    expect(harness.role("metric-healthy")?.textContent).toBe("1");
    /* 在飞与上限取 `metrics`（全局租约 + R16 的 maxTotalInflight），与顶栏的
       `在飞 3/8` 是同一个数：同一页上「上限」不能一处 8、另一处 9。 */
    expect(harness.role("metric-inflight")?.textContent).toBe("3");
    expect(harness.role("metric-limit")?.textContent).toBe("8");
  });

  it("keeps the account summary to one hint line when there is no account", async () => {
    const harness = await mountSettled("/", statePayload({ accounts: [] }));

    /* 一个账号都没有时不画空表格：六列表头里一行数据都没有，
       占的是一整块面板的高度。 */
    expect(harness.role("accounts-empty")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("accounts-empty")?.textContent).toContain("还没有账号，去账号页添加一个。");
    expect(harness.role("accounts-empty")?.className).toBe("empty-inline");
    /* 空态给可点入口，不只写一句「去账号页」。 */
    const action = harness.find("[data-role='accounts-empty-action']");
    expect(action?.getAttribute("href")).toBe("/accounts");
    expect(action?.textContent).toBe("去账号页添加一个账号");
    expect(harness.role("accounts-table")?.hasAttribute("hidden")).toBe(true);
  });

  it("draws the table and drops the hint once an account exists", async () => {
    const harness = await mountSettled("/", statePayload({ accounts: [account({ label: "work-team" })] }));

    expect(harness.role("accounts-table")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("accounts-empty")?.hasAttribute("hidden")).toBe(true);
    expect(harness.rows("accounts-body")).toHaveLength(1);
  });

  it("keeps the chart frame with the baseline and one hint line when there is no sample", async () => {
    const harness = await mountSettled("/", statePayload());

    /* 空态不收起整个图表——图框常驻，画基线（绘图区下边框）加那行提示；
       峰值 / 窗长行仍收起（没有数据就没有数字）。 */
    expect(harness.role("chart-empty")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("chart-empty")?.className).toBe("empty-inline");
    expect(harness.role("chart-empty")?.textContent).toBe("还没有采样");
    expect(harness.role("chart")?.hasAttribute("hidden")).toBe(false);
    expect(harness.find('[data-role="chart"] .chart__frame')).not.toBeNull();
    expect(nodes(harness.role("chart"), "path")).toHaveLength(0);
    expect(harness.role("chart-meta")?.hasAttribute("hidden")).toBe(true);
  });

  it("draws rounded bars with gridlines, a value scale and both meta lines once samples arrive", async () => {
    const harness = await mountSettled(
      "/",
      statePayload({
        metrics: metrics({
          inflight: 3,
          inflightHistory: [
            { at: 1, inflight: 1 },
            { at: 2, inflight: 3 },
          ],
        }),
      }),
    );

    expect(harness.role("chart-empty")?.hasAttribute("hidden")).toBe(true);
    expect(harness.role("chart-meta")?.hasAttribute("hidden")).toBe(false);
    /* 两根柱（峰值那根实心强调），内部网格线两条（峰值 3 → 轴刻度 1、2）；
       左侧刻度列与网格线同一套数值，基线 0 永远在。 */
    expect(nodes(harness.role("chart"), "path")).toHaveLength(2);
    expect(nodes(harness.role("chart"), ".tokchart__bar--peak")).toHaveLength(1);
    expect(nodes(harness.role("chart"), "line")).toHaveLength(2);
    expect(nodes(harness.role("chart"), ".chart__tick").map((node) => node.textContent)).toEqual(["0", "1", "2"]);
    expect(harness.role("chart-min")?.textContent).toBe("最近 2 次采样");
    expect(harness.role("chart-max")?.textContent).toBe("峰值 3");
  });

  it("drops the frame and says the line stayed flat when every sample is zero", async () => {
    const harness = await mountSettled(
      "/",
      statePayload({
        metrics: metrics({
          inflight: 0,
          inflightHistory: [
            { at: 1, inflight: 0 },
            { at: 2, inflight: 0 },
          ],
        }),
      }),
    );

    /* 有采样但全为 0：96px 的图框里只有基线和孤零零的 0 刻度，空白壳子不画——
       整块换成一行链去请求日志的提示，窗长写进那句里（「峰值 0」不再单列）。 */
    expect(harness.role("chart")?.hasAttribute("hidden")).toBe(true);
    expect(harness.role("chart-empty")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("chart-empty")?.textContent).toBe(
      "最近 2 次采样在飞都是 0 · 去日志看看这段时间有没有请求 →",
    );
    expect(harness.role("chart-meta")?.hasAttribute("hidden")).toBe(true);
  });

  it("hides the risk banner when there is nothing to warn about", async () => {
    const harness = await mountSettled("/", statePayload());

    /* 无告警时横幅里没有任何内容，整条收起。 */
    expect(harness.role("risk-banner")?.hasAttribute("hidden")).toBe(true);
    expect(harness.role("risk-text")?.textContent).toBe("");
  });

  it("fills the banner with the translated alert code when the backend reports one", async () => {
    const harness = await mountSettled(
      "/",
      statePayload({ risk: { alerts: ["account_cooling"], policy: { ...DEFAULT_ACCOUNTS_RISK } } }),
    );

    expect(harness.role("risk-banner")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("risk-text")?.textContent).toBe("有账号处于冷却");
    // 图标是装饰，读屏器跳过
    expect(harness.find('[data-role="risk-banner"] svg')?.getAttribute("aria-hidden")).toBe("true");
  });
});

/* ------------------------------------------------------------------------- */
/* token 数值与时间格式化                                                      */
/* ------------------------------------------------------------------------- */

/** 页面运行时的格式化函数（app-format.js 的真值在 window 里，测试直接调它）。*/
interface FormatApi {
  units(value: number, lang?: string): string;
  dateTime(epochMs: number): string;
  countdown(remainingMs: number): string;
}

function appFormat(harness: Harness): FormatApi {
  return (harness.win as unknown as { __zcodeApp: { format: FormatApi } }).__zcodeApp.format;
}

describe("formatUnits token 数值（亿/万 · K/M/B）", () => {
  it("中文：万/亿两档，取整跨档升档（9999 → 1万）", async () => {
    const harness = await mountSettled("/accounts", statePayload());
    const units = (value: number): string => appFormat(harness).units(value, "zh");
    expect(units(999)).toBe("999");
    expect(units(9999)).toBe("1万");
    expect(units(64_000)).toBe("6.4万");
    expect(units(100_000)).toBe("10万");
    // 差 1 到 1e8 的值，万位取整已够 1e4 万 → 升档成 1亿，不显示 10000万。
    expect(units(99_999_999)).toBe("1亿");
    expect(units(100_000_000)).toBe("1亿");
    expect(units(341_000_000)).toBe("3.41亿");
    expect(units(500_000_000)).toBe("5亿");
    expect(units(-1)).toBe("0");
    harness.close();
  });

  it("英文：K/M/B 三档，取整跨档升档（999999 → 1M，不显示 1000K）", async () => {
    const harness = await mountSettled("/accounts", statePayload());
    const units = (value: number): string => appFormat(harness).units(value, "en");
    expect(units(999)).toBe("999");
    expect(units(999_000)).toBe("999K");
    expect(units(999_999)).toBe("1M");
    expect(units(1_500_000)).toBe("1.5M");
    expect(units(341_000_000)).toBe("341M");
    expect(units(1_200_000_000)).toBe("1.2B");
    harness.close();
  });

  it("不传语言时读面板当前语言（挂载固定 zh）", async () => {
    const harness = await mountSettled("/accounts", statePayload());
    expect(appFormat(harness).units(64_000)).toBe("6.4万");
    harness.close();
  });

  it("dateTime 输出本地 Y/M/D h:m:s（日期段不补零，时刻段补零）", async () => {
    const harness = await mountSettled("/accounts", statePayload());
    const fmt = appFormat(harness);
    // 本地时区构造：断言在任意 TZ 下都成立。
    expect(fmt.dateTime(new Date(2026, 10, 9, 9, 0, 0).getTime())).toBe("2026/11/9 09:00:00");
    expect(fmt.dateTime(new Date(2026, 0, 2, 13, 5, 7).getTime())).toBe("2026/1/2 13:05:07");
    expect(fmt.dateTime(Number.NaN)).toBe("");
    harness.close();
  });

  it("countdown 按相邻两档格式化（如 1h 26m）", async () => {
    const harness = await mountSettled("/accounts", statePayload());
    const countdown = (ms: number): string => appFormat(harness).countdown(ms);
    expect(countdown(3 * 86_400_000 + 6 * 3_600_000)).toBe("3d 6h");
    expect(countdown((2 * 60 + 14) * 60_000)).toBe("2h 14m");
    expect(countdown(26 * 60_000 + 10_000)).toBe("26m 10s");
    expect(countdown(-5)).toBe("0s");
    harness.close();
  });
});

// ---------------------------------------------------------------------------
// 抢活动：概览页的一行汇总
// ---------------------------------------------------------------------------

describe("overview — claim summary line", () => {
  it("counts the running schedulers and links to the accounts page", async () => {
    const harness = await mountSettled(
      "/",
      statePayload({
        accounts: [account()],
        claim: claimOverview({
          accounts: [
            { label: "a", running: true, holdUntil: 0 },
            { label: "b", running: false, holdUntil: 0 },
          ],
        }),
      }),
    );
    const line = harness.role("overview-claim-line");
    expect(line?.hasAttribute("hidden")).toBe(false);
    expect(line?.textContent).toContain("1 个账号自动领取中");
    /* 整行是一张可点卡片（与指标卡同一套 card--link），href 在行本身上。 */
    expect(line?.tagName).toBe("A");
    expect(line?.getAttribute("href")).toBe("/accounts");
  });

  it("adds the next check or opening time only when the state supplies one", async () => {
    const next = Date.now() + 600_000;
    const hold = await mountSettled(
      "/",
      statePayload({
        accounts: [account()],
        claim: claimOverview({ accounts: [{ label: "a", running: true, holdUntil: next }] }),
      }),
    );
    expect(hold.role("overview-claim-text")?.textContent).toContain("下次检查");
    hold.close();

    const openingState = statePayload({
      accounts: [account()],
      claim: claimOverview({ accounts: [{ label: "a", running: true, holdUntil: 0 }] }),
    });
    (openingState.claim!.accounts[0] as unknown as Record<string, unknown>).openingAt = next;
    const opening = await mountSettled("/", openingState);
    expect(opening.role("overview-claim-text")?.textContent).toContain("开抢窗口");
    opening.close();

    const plain = await mountSettled(
      "/",
      statePayload({ accounts: [account()], claim: claimOverview({ accounts: [{ label: "a", running: true, holdUntil: 0 }] }) }),
    );
    expect(plain.role("overview-claim-text")?.textContent).not.toContain("下次检查");
    expect(plain.role("overview-claim-text")?.textContent).not.toContain("开抢窗口");
    plain.close();
  });

  it("shows the manual-mode sentence when auto is off, and hides without claim data", async () => {
    const manual = await mountSettled("/", statePayload({ accounts: [account()], claim: claimOverview({ auto: false }) }));
    expect(manual.role("overview-claim-line")?.textContent).toContain("自动领取未开启");
    manual.close();

    const none = await mountSettled("/", statePayload({ accounts: [account()] }));
    expect(none.role("overview-claim-line")?.hasAttribute("hidden")).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */
/* 统计视图                                                                   */
/* ------------------------------------------------------------------------- */

/** 本地零点（与 app-view-stats.js 的 rangeQuery 同一口径：今天 / 7 天 / 30 天）。*/
function localMidnight(dayOffset = 0): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + dayOffset);
  return start.getTime();
}

/** 统计页的挂载：等待取数完成（范围 + 热力图两条都回来）。*/
async function mountStats(
  path: string,
  options: MountOptions = {},
): Promise<Harness> {
  const harness = await mountSettled(path, statePayload(), options);
  await harness.settle();
  return harness;
}

describe("stats view — 取数", () => {
  it("pulls the today range and the heatmap once on enter", async () => {
    const harness = await mountStats("/stats", { usageStats: { ok: true, event: "usageStats", stats: usageStatsFixture() } });
    const calls = usageCalls(harness);
    expect(calls).toHaveLength(2);
    // 范围命令：from = 本地零点、to ≈ 现在（今天范围）
    expect(calls[0]?.from).toBe(localMidnight());
    expect(calls[0]?.to as number).toBeLessThanOrEqual(Date.now());
    // 热力图命令：from = 364 天前的本地零点
    expect(calls[1]?.from).toBe(localMidnight(-364));
    harness.close();
  });

  it("honors ?range= and falls back to today on an unknown value", async () => {
    const harness = await mountStats("/stats?range=30d");
    expect(usageCalls(harness)[0]?.from).toBe(localMidnight(-29));
    harness.close();

    const fallback = await mountStats("/stats?range=bogus");
    expect(usageCalls(fallback)[0]?.from).toBe(localMidnight());
    fallback.close();
  });

  it("switching the range refetches the range aggregate only (heatmap stays)", async () => {
    const harness = await mountStats("/stats");
    const before = usageCalls(harness).length;
    harness.click(harness.find('[data-stats-range="7d"]'));
    await harness.settle();
    const calls = usageCalls(harness);
    expect(calls).toHaveLength(before + 1);
    expect(calls[calls.length - 1]?.from).toBe(localMidnight(-6));
    // 选中态跟着切，命令失败不影响已选 tab
    expect(harness.find('[data-stats-range="7d"]')?.className).toContain("tab--active");
    harness.close();
  });

  it("the appbar refresh refetches both aggregates", async () => {
    const harness = await mountStats("/stats");
    const before = usageCalls(harness).length;
    harness.click(harness.role("refresh-button"));
    await harness.settle();
    expect(usageCalls(harness)).toHaveLength(before + 2);
    // 在途指示落在顶栏那颗图标上（aria-busy），这一页不再有自己的刷新按钮
    expect(harness.role("refresh-button")?.hasAttribute("disabled")).toBe(false);
    harness.close();
  });

  it("a failed command shows the stable error and keeps the page alive", async () => {
    const harness = await mountStats("/stats", { usageStats: { ok: false, error: "usage_stats_unavailable" } });
    expect(harness.role("stats-error")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("stats-error-text")?.textContent).toBe("用量统计不可用。");
    // 数据块保持占位，不崩溃；顶栏刷新可再试
    expect(harness.role("stats-requests")?.textContent).toBe("—");
    expect(harness.role("refresh-button")?.hasAttribute("disabled")).toBe(false);
    harness.close();
  });
});

describe("stats view — 区块渲染", () => {
  it("renders the summary cards, series and groups from the aggregate", async () => {
    const harness = await mountStats("/stats", { usageStats: { ok: true, event: "usageStats", stats: usageStatsFixture() } });
    expect(harness.role("stats-requests")?.textContent).toBe("6");
    expect(harness.role("stats-successRate")?.textContent).toBe("66.7%");
    expect(harness.role("stats-tokens")?.textContent).toBe("900");
    expect(harness.role("stats-tokens-sub")?.textContent).toBe("↑300 ↓600");
    expect(harness.role("stats-ttfb")?.textContent).toBe("420ms");
    expect(harness.role("stats-tps")?.textContent).toBe("18.4 tok/s");
    expect(harness.role("stats-errors")?.textContent).toBe("2");
    // 时序：两个非空小时桶 = 4 段柱（入 / 出各半；顶段圆角 path、底段方角 rect）；
    // 网格线两条（峰值 600 → 轴刻度 200、400）+ 基线 0；图例与峰值 / 合计可见
    expect(nodes(harness.role("stats-chart"), "path")).toHaveLength(2);
    expect(nodes(harness.role("stats-chart"), "rect")).toHaveLength(2);
    expect(nodes(harness.role("stats-chart"), "line")).toHaveLength(2);
    expect(harness.role("stats-legend")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("stats-chart-peak")?.textContent).toBe("峰值 600");
    expect(harness.role("stats-chart-total")?.textContent).toBe("合计 900");
    // 分组表默认账号维度
    const rows = harness.rows("stats-group-body");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("data-href")).toBeNull();
    harness.close();
  });

  it("toggles hourly/daily and the six dimensions without refetching", async () => {
    const harness = await mountStats("/stats", { usageStats: { ok: true, event: "usageStats", stats: usageStatsFixture() } });
    const before = usageCalls(harness).length;

    harness.click(harness.find('[data-stats-gran="daily"]'));
    await harness.settle();
    expect(harness.find('[data-stats-gran="daily"]')?.className).toContain("tab--active");
    expect(usageCalls(harness)).toHaveLength(before);

    harness.click(harness.find('[data-stats-dim="model"]'));
    await harness.settle();
    /* 表头首列恒为「维度」：切维度只换行内容，不换表头（「这是哪种分组」
       由标题行的维度胶囊说一次）。 */
    expect(harness.role("stats-group-key")?.textContent).toBe("维度");
    expect(harness.rows("stats-group-body")).toHaveLength(1);
    expect(usageCalls(harness)).toHaveLength(before);
    harness.close();
  });

  it("links API-key rows to the log page with the key filter (none for unattributed)", async () => {
    const harness = await mountStats("/stats", { usageStats: { ok: true, event: "usageStats", stats: usageStatsFixture() } });
    harness.click(harness.find('[data-stats-dim="apiKey"]'));
    await harness.settle();
    const rows = nodes(harness.role("stats-group-body"), "tr");
    expect(rows.map((row) => row.getAttribute("data-href"))).toEqual([
      "/logs?tab=requests&key=k001",
      "/logs?tab=requests&key=none",
    ]);

    const targets: string[] = [];
    (harness.win as unknown as { location: { assign: (target: string) => void } }).location.assign = (target) => {
      targets.push(target);
    };
    harness.click(rows[1] ?? null);
    await harness.settle();
    expect(targets).toEqual(["/logs?tab=requests&key=none"]);
    harness.close();
  });

  it("shows the cache hit rate from valid samples and the no-data state without them", async () => {
    const withSamples = await mountStats("/stats", { usageStats: { ok: true, event: "usageStats", stats: usageStatsFixture() } });
    // 读 700 / (输入 100 + 读 700 + 写 200) = 70%（三块都在分母里）
    expect(withSamples.role("stats-cache-data")?.hasAttribute("hidden")).toBe(false);
    expect(withSamples.role("stats-cache-rate")?.textContent).toBe("70%");
    expect(withSamples.role("stats-cache-sub")?.textContent).toContain("有效样本 3");
    // 副行把三块原始数字都露出来：屏幕上的比率必须能手算复核。
    expect(withSamples.role("stats-cache-sub")?.textContent).toContain("输入 100");
    expect(withSamples.role("stats-cache-sub")?.textContent).toContain("读 700");
    expect(withSamples.role("stats-cache-sub")?.textContent).toContain("写 200");
    expect(withSamples.role("stats-cache-empty")?.hasAttribute("hidden")).toBe(true);
    withSamples.close();

    const noSamples = await mountStats("/stats", {
      usageStats: {
        ok: true,
        event: "usageStats",
        stats: { ...usageStatsFixture(), cacheHit: { samples: 0, inputTokens: 0, readTokens: 0, creationTokens: 0, creationSamples: 0 } },
      },
    });
    expect(noSamples.role("stats-cache-data")?.hasAttribute("hidden")).toBe(true);
    expect(noSamples.role("stats-cache-empty")?.hasAttribute("hidden")).toBe(false);
    expect(noSamples.role("stats-cache-empty")?.textContent).toBe("暂无缓存数据");
    noSamples.close();
  });

  it("says writes are not reported instead of rendering a missing bucket as 0", async () => {
    // 真实日志的形状：上游只报 cache_read，一条 cache_creation 都没有。
    // 旧公式 read / (read + 0) 在这里是 100%；新公式必须 < 100%，且写桶说「未上报」。
    const harness = await mountStats("/stats", {
      usageStats: {
        ok: true,
        event: "usageStats",
        stats: {
          ...usageStatsFixture(),
          cacheHit: { samples: 2, inputTokens: 200, readTokens: 1800, creationTokens: 0, creationSamples: 0 },
        },
      },
    });
    // 1800 / (200 + 1800 + 0) = 90%
    expect(harness.role("stats-cache-rate")?.textContent).toBe("90%");
    expect(harness.role("stats-cache-sub")?.textContent).toContain("写 未上报");
    expect(harness.role("stats-cache-sub")?.textContent).not.toContain("写 0");
    harness.close();
  });

  it("renders schedule counters, error bars and the empty states of a bare range", async () => {
    const harness = await mountStats("/stats", { usageStats: { ok: true, event: "usageStats", stats: usageStatsFixture() } });
    expect(harness.role("stats-degraded")?.textContent).toBe("1");
    expect(harness.role("stats-cooled")?.textContent).toBe("2");
    expect(harness.role("stats-queueTimeout")?.textContent).toBe("1");
    // 错误分析只按 errorCode 折叠，两行都有用户词 + hint + 横条。
    const rows = nodes(harness.role("stats-kinds"), ".hbar");
    expect(rows).toHaveLength(2);
    expect(nodes(harness.role("stats-kinds"), ".hbar__hint")).toHaveLength(2);
    expect(rows[0]?.getAttribute("data-error-code")).toBeTruthy();
    expect(nodes(harness.role("stats-kinds"), ".hbar__track")).toHaveLength(2);
    harness.close();

    const empty = await mountStats("/stats", {
      usageStats: { ok: true, event: "usageStats", stats: usageStatsFixture({ withData: false }) },
    });
    expect(empty.role("stats-chart-empty")?.hasAttribute("hidden")).toBe(false);
    expect(empty.role("stats-groups-empty")?.hasAttribute("hidden")).toBe(false);
    expect(empty.role("stats-kinds-empty")?.hasAttribute("hidden")).toBe(false);
    expect(empty.role("stats-cache-empty")?.hasAttribute("hidden")).toBe(false);
    expect(empty.role("stats-degraded")?.textContent).toBe("0");
    empty.close();
  });

  it("renders errorCode user words and hints, with no internal words", async () => {
    /* errorCode → i18n 用户词 + hint。同一码在两语言下都不露内部词。*/
    const harness = await mountStats("/stats", {
      usageStats: {
        ok: true,
        event: "usageStats",
        stats: {
          ...usageStatsFixture(),
          errors: [
            { stage: "upstream-resp", kind: "upstream-rate-limited", count: 8 },
            { stage: "dispatch", kind: "accounts-saturated", count: 3 },
          ],
        },
      },
    });
    const names = nodes(harness.role("stats-kinds"), ".hbar__name").map((node) => node.textContent ?? "");
    expect(names[0]).toContain("上游限流");
    expect(names[0]).toContain("怎么办：上游限流，按 Retry-After 自动恢复");
    expect(names[1]).toContain("并发占满");
    expect(names[1]).toContain("所有账号都在忙，稍后自动恢复");
    expect(harness.role("stats-kinds")?.textContent).not.toContain("all-cooling");
    expect(harness.role("stats-kinds")?.textContent).not.toContain("saturated");
    expect(nodes(harness.role("stats-kinds"), ".hbar__track")).toHaveLength(2);
    /* 切到英文：同一组键换一套用户词 + hint（i18n 全键）。*/
    (harness.win as unknown as { zcodePanel: { setLanguage(language: string): void } }).zcodePanel.setLanguage("en");
    const english = nodes(harness.role("stats-kinds"), ".hbar__name").map((node) => node.textContent ?? "");
    expect(english[0]).toContain("Upstream rate limit");
    expect(english[0]).toContain("What to do: Upstream is rate-limiting; recovery follows Retry-After");
    expect(english[1]).toContain("All accounts busy");
    harness.close();
  });

  it("renders a single errorCode as text instead of a full-width bar (S-2)", async () => {
    /* 只剩一种分类：横条没有对比对象（永远画满整轨），改成「用户词 × 次数」文本。*/
    const harness = await mountStats("/stats", {
      usageStats: {
        ok: true,
        event: "usageStats",
        stats: {
          ...usageStatsFixture(),
          errors: [{ stage: "upstream-req", kind: "upstream-error", count: 8 }],
        },
      },
    });
    const rows = nodes(harness.role("stats-kinds"), ".hbar");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.className).toContain("hbar--single");
    expect(nodes(harness.role("stats-kinds"), ".hbar__track")).toHaveLength(0);
    expect(nodes(harness.role("stats-kinds"), ".hbar__name")[0]?.textContent).toContain("上游出错");
    expect(nodes(harness.role("stats-kinds"), ".hbar__count")[0]?.textContent).toBe("× 8");
    harness.close();
  });

  it("renders the daily heatmap: full columns, Monday-first rows, 5-tier scale", async () => {
    const start = localMidnight(-364);
    const days = Array.from({ length: 365 }, (_, index) => ({
      bucketStart: start + index * 86_400_000,
      tokens: 0,
      mcpCalls: 0,
    }));
    /* 四个非零日分落 daily 绝对档（100 万 / 500 万 / 2000 万）：
       50 万 → l1、200 万 → l2、1000 万 → l3、2500 万 → l4。 */
    days[100].tokens = 500_000;
    days[140].tokens = 2_000_000;
    days[180].tokens = 10_000_000;
    days[200].tokens = 25_000_000;
    days[200].mcpCalls = 3;
    const harness = await mountStats("/stats", {
      heatmapStats: {
        ok: true,
        event: "usageStats",
        stats: { ...usageStatsFixture({ withData: false }), heatmap: { daily: days, weekly: [], cumulative: [] } },
      },
    });
    const grid = harness.role("heatmap-grid");
    const cells = nodes(grid, ".heatmap__cell:not(.heatmap__cell--void)");
    expect(cells).toHaveLength(365);
    /* 行序周一→周日：首列前的 void 数 = 首日的周内偏移（周一起算）。 */
    const leading = (new Date(start).getUTCDay() + 6) % 7;
    const columns = Math.ceil((leading + 365) / 7);
    const voids = nodes(grid, ".heatmap__cell--void");
    expect(voids).toHaveLength(columns * 7 - 365);
    /* 无右侧空白：列数算满 + 列模板 1fr 撑满容器。 */
    expect(grid?.getAttribute("style") || "").toContain(`repeat(${columns}, minmax(12px, 1fr))`);
    /* 5 档色阶：零档浅灰 + 四蓝档，各恰一格（除 l0）。 */
    expect(nodes(grid, ".heatmap__cell--l1")).toHaveLength(1);
    expect(nodes(grid, ".heatmap__cell--l2")).toHaveLength(1);
    expect(nodes(grid, ".heatmap__cell--l3")).toHaveLength(1);
    expect(nodes(grid, ".heatmap__cell--l4")).toHaveLength(1);
    expect(nodes(grid, ".heatmap__cell--l0")).toHaveLength(365 - 4);
    harness.close();
  });

  it("labels months at the bottom aligned to each month's first week column", async () => {
    const start = localMidnight(-364);
    const days = Array.from({ length: 365 }, (_, index) => ({
      bucketStart: start + index * 86_400_000,
      tokens: 1000,
      mcpCalls: 0,
    }));
    const harness = await mountStats("/stats", {
      heatmapStats: {
        ok: true,
        event: "usageStats",
        stats: { ...usageStatsFixture({ withData: false }), heatmap: { daily: days, weekly: [], cumulative: [] } },
      },
    });
    /* 月轴在网格之后（DOM 顺序 = 视觉顺序：月轴在底部）。 */
    const wrap = harness.role("stats-heatmap");
    const kids = nodes(wrap, ":scope > *").map((node) => node.getAttribute("data-role"));
    expect(kids).toEqual(["heatmap-grid", "heatmap-months"]);
    /* 365 天窗口跨 12–13 个月，逐月一个标签（满窗各月间隔 4–5 列，不跳过）。 */
    const months = nodes(harness.role("heatmap-months"), "span");
    expect(months.length).toBeGreaterThanOrEqual(12);
    expect(months.length).toBeLessThanOrEqual(13);
    expect(months[0]?.textContent).toMatch(/月$/);
    /* 首标签落在第 1 列（窗口首日所在列）。 */
    expect(months[0]?.getAttribute("style") || "").toContain("grid-column: 1 / span");
    harness.close();
  });

  it("switches granularity: weekly aggregates into one row, cumulative bins by total", async () => {
    const start = localMidnight(-364);
    const days = Array.from({ length: 365 }, (_, index) => ({
      bucketStart: start + index * 86_400_000,
      tokens: 0,
      mcpCalls: 0,
    }));
    /* 累计：前 30 天每天 100 万（累计 3000 万），后 335 天 0。
       总量 = 3000 万 → 份额档 [0.25, 0.5, 0.75] = [750 万, 1500 万, 2250 万]。 */
    for (let index = 0; index < 30; index++) days[index].tokens = 1_000_000;
    const weekly = Array.from({ length: 53 }, (_, index) => ({
      bucketStart: start + index * 7 * 86_400_000,
      tokens: index === 0 ? 70_000_000 : 0,
      mcpCalls: 0,
    }));
    let running = 0;
    const cumulative = days.map((day) => {
      running += day.tokens;
      return { bucketStart: day.bucketStart, tokens: running, mcpCalls: 0 };
    });
    const harness = await mountStats("/stats", {
      heatmapStats: {
        ok: true,
        event: "usageStats",
        stats: { ...usageStatsFixture({ withData: false }), heatmap: { daily: days, weekly, cumulative } },
      },
    });
    /* 每日 tab 默认：365 日格。 */
    expect(nodes(harness.role("heatmap-grid"), ".heatmap__cell:not(.heatmap__cell--void)")).toHaveLength(365);

    /* 每周 tab：周格聚合，单行（--flat），一格一周；周值 7000 万落 weekly 档
       [700 万, 3500 万, 1.4 亿] 的 l3（≤ 1.4 亿）。 */
    harness.click(harness.find('[data-heatmap-gran="weekly"]'));
    await harness.settle();
    expect(harness.find('[data-heatmap-gran="weekly"]')?.className).toContain("heatmap__tab--active");
    const weekGrid = harness.role("heatmap-grid");
    expect(weekGrid?.className).toContain("heatmap__grid--flat");
    const weekCells = nodes(weekGrid, ".heatmap__cell:not(.heatmap__cell--void)");
    expect(weekCells).toHaveLength(53);
    expect(weekCells[0]?.className).toContain("heatmap__cell--l3");

    /* 累计 tab：总量分档（份额档）。running 单调涨——第 8 天累计 800 万 > 750 万
       进 l2，第 16 天 1600 万 > 1500 万进 l3，第 24 天 2400 万 > 2250 万进 l4。 */
    harness.click(harness.find('[data-heatmap-gran="cumulative"]'));
    await harness.settle();
    const cumGrid = harness.role("heatmap-grid");
    const cumCells = nodes(cumGrid, ".heatmap__cell:not(.heatmap__cell--void)");
    expect(cumCells).toHaveLength(365);
    expect(cumCells[3]?.className).toContain("heatmap__cell--l1"); // 累计 400 万 ≤ 750 万
    expect(cumCells[8]?.className).toContain("heatmap__cell--l2"); // 累计 800 万
    expect(cumCells[16]?.className).toContain("heatmap__cell--l3"); // 累计 1600 万
    expect(cumCells[24]?.className).toContain("heatmap__cell--l4"); // 累计 2400 万
    /* 30 天后不再增长：末格仍是总量档 l4。 */
    expect(cumCells[364]?.className).toContain("heatmap__cell--l4");
    harness.close();
  });

  it("shows the tooltip on hover: date line + Tokens/MCP line", async () => {
    const start = localMidnight(-364);
    const days = Array.from({ length: 365 }, (_, index) => ({
      bucketStart: start + index * 86_400_000,
      tokens: 0,
      mcpCalls: 0,
    }));
    days[50].tokens = 58_650_000;
    days[50].mcpCalls = 2;
    const harness = await mountStats("/stats", {
      heatmapStats: {
        ok: true,
        event: "usageStats",
        stats: { ...usageStatsFixture({ withData: false }), heatmap: { daily: days, weekly: [], cumulative: [] } },
      },
    });
    const tip = harness.role("heatmap-tip");
    expect(tip?.hasAttribute("hidden")).toBe(true);
    const cell = nodes(harness.role("heatmap-grid"), ".heatmap__cell:not(.heatmap__cell--void)")[50];
    cell?.dispatchEvent(new harness.win.MouseEvent("mouseover", { bubbles: true }));
    await harness.settle();
    expect(tip?.hasAttribute("hidden")).toBe(false);
    /* 第一行日期（UTC 桶身份）；第二行「Tokens 消耗 58.65M | MCP 消耗 2次」——
       数值走 M/B 两位小数（units(..., "en")），MCP 次数走 i18n 模板。 */
    expect(harness.role("heatmap-tip-date")?.textContent).toBe(
      new Date(days[50].bucketStart).toISOString().slice(0, 10),
    );
    expect(harness.role("heatmap-tip-tokens")?.textContent).toBe("58.65M");
    expect(harness.role("heatmap-tip-mcp")?.textContent).toBe("2次");
    expect(nodes(tip, ".heatmap__tip-label").map((node) => node.textContent)).toEqual([
      "Tokens 消耗",
      "MCP 消耗",
    ]);
    /* 悬停另一格内容跟着换；mouseleave 收浮层。 */
    const grid = harness.role("heatmap-grid");
    grid?.dispatchEvent(new harness.win.MouseEvent("mouseleave", { bubbles: true }));
    await harness.settle();
    expect(tip?.hasAttribute("hidden")).toBe(true);
    harness.close();
  });

  /* 等价读数通道：每格的可访问名与悬停浮层同一份数据；整张网格
     只有一个 Tab 停靠点（roving tabindex），方向键在格子之间移动，聚焦即开浮层。 */
  it("gives every heatmap cell an accessible name and one roving tab stop", async () => {
    const start = localMidnight(-364);
    const days = Array.from({ length: 365 }, (_, index) => ({
      bucketStart: start + index * 86_400_000,
      tokens: 0,
      mcpCalls: 0,
    }));
    days[50].tokens = 58_650_000;
    days[50].mcpCalls = 2;
    const harness = await mountStats("/stats", {
      heatmapStats: {
        ok: true,
        event: "usageStats",
        stats: { ...usageStatsFixture({ withData: false }), heatmap: { daily: days, weekly: [], cumulative: [] } },
      },
    });
    const grid = harness.role("heatmap-grid");
    const cells = nodes(grid, ".heatmap__cell:not(.heatmap__cell--void)");
    /* 日期 + Tokens + MCP，数值格式与浮层一致（fmtMB）。 */
    const date = new Date(days[50].bucketStart).toISOString().slice(0, 10);
    expect(cells[50]?.getAttribute("aria-label")).toBe(`${date}：Tokens 58.65M，MCP 2 次`);
    expect(cells[49]?.getAttribute("aria-label")).toContain("Tokens 0，MCP 0 次");
    /* roving tabindex：整张网格只有一个 0，其余 -1；首格默认是停靠点。 */
    expect(cells.filter((node) => node.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(cells[0]?.getAttribute("tabindex")).toBe("0");
    expect(cells.filter((node) => node.getAttribute("tabindex") === "-1")).toHaveLength(364);
    /* 容器带 group 角色与色阶说明（五档含义的文字通道在读屏进网格时报出）。 */
    expect(grid?.getAttribute("role")).toBe("group");
    expect(grid?.getAttribute("aria-describedby")).toBe("heatmap-scale");
    expect(harness.find("#heatmap-scale")?.textContent).toContain("色阶");

    /* 聚焦一格：浮层按键盘显示同一份数据，停靠点跟着搬过去。 */
    const tip = harness.role("heatmap-tip");
    cells[50]?.dispatchEvent(new harness.win.FocusEvent("focusin", { bubbles: true }));
    await harness.settle();
    expect(tip?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("heatmap-tip-date")?.textContent).toBe(date);
    expect(cells[50]?.getAttribute("tabindex")).toBe("0");
    expect(cells[0]?.getAttribute("tabindex")).toBe("-1");

    /* 方向键：右移一周（+7 格），浮层内容跟着换。 */
    cells[50]?.dispatchEvent(
      new harness.win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await harness.settle();
    expect(cells[57]?.getAttribute("tabindex")).toBe("0");
    expect(harness.role("heatmap-tip-date")?.textContent).toBe(
      new Date(days[57].bucketStart).toISOString().slice(0, 10),
    );
    /* 焦点离开网格（`relatedTarget` 在网格之外）时浮层收起。 */
    cells[57]?.dispatchEvent(new harness.win.FocusEvent("focusout", { bubbles: true }));
    await harness.settle();
    expect(tip?.hasAttribute("hidden")).toBe(true);
    harness.close();
  });

  it("keeps a heatmap failure off the range banner and shows its own hint", async () => {    const harness = await mountStats("/stats", { heatmapStats: { ok: false, error: "usage_stats_unavailable" } });
    // 范围数据照常渲染
    expect(harness.role("stats-requests")?.textContent).toBe("6");
    expect(harness.role("stats-error")?.hasAttribute("hidden")).toBe(true);
    expect(harness.role("stats-heatmap-empty")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("stats-heatmap-empty-text")?.textContent).toBe("热力图加载失败。");
    harness.close();
  });
});

/* ------------------------------------------------------------------------- */
/* 概览页的今日用量                                                            */
/* ------------------------------------------------------------------------- */

describe("overview — 今日四卡与时序缩略", () => {
  it("fills the four today cards from getUsageStats and links them to the stats view", async () => {
    const harness = await mountSettled("/", {
      ...statePayload(),
    }, { usageStats: { ok: true, event: "usageStats", stats: usageStatsFixture() } });
    expect(harness.role("usage-requests")?.textContent).toBe("6");
    expect(harness.role("usage-tokens")?.textContent).toBe("900");
    expect(harness.role("usage-avg-rate")?.textContent).toBe("18.4 tok/s");
    expect(harness.role("usage-errors")?.textContent).toBe("2");
    // 缩略图：两个非空小时桶 = 4 段柱（顶段圆角 path + 底段 rect）；
    // 合计行与图例可见；图框常驻，刻度列在（token 桶 → 万/亿缩写刻度）
    expect(nodes(harness.role("usage-chart"), "path")).toHaveLength(2);
    expect(nodes(harness.role("usage-chart"), "rect")).toHaveLength(2);
    expect(nodes(harness.role("usage-chart"), ".chart__tick").length).toBeGreaterThan(0);
    expect(harness.role("usage-legend")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("usage-total")?.textContent).toBe("合计 900");
    // 今日卡与缩略图都链去统计视图的「今天」
    const links = [...harness.win.document.querySelectorAll('a[href="/stats?range=today"]')];
    expect(links.length).toBeGreaterThanOrEqual(5);
    harness.close();
  });

  it("throttles the usage fetch to once per minute across /api/state polls", async () => {
    const harness = await mountSettled("/", statePayload());
    const before = usageCalls(harness).length;
    expect(before).toBeGreaterThanOrEqual(1);
    await harness.refresh();
    await harness.settle();
    expect(usageCalls(harness)).toHaveLength(before);
    harness.close();
  });

  /* 整图链接（`axe:link-name`）：图里只有 SVG 刻度，链接的可访问名必须说出
     真实数据（日期 + 当日合计），不是一句与内容无关的通用词。 */
  it("names the whole-chart link after the real daily total", async () => {
    const harness = await mountSettled("/", statePayload(), {
      usageStats: { ok: true, event: "usageStats", stats: usageStatsFixture() },
    });
    const link = harness.role("usage-link");
    const today = new Date();
    const label = link?.getAttribute("aria-label") ?? "";
    expect(label).toContain(((today.getMonth() + 1) + "月" + today.getDate() + "日"));
    expect(label).toContain("合计 900");
    harness.close();

    /* 没有柱子时不说合计（那时可能还在加载或已经失败），只报日期与动作。 */
    const quiet = await mountSettled("/", statePayload(), {
      usageStats: { ok: true, event: "usageStats", stats: usageStatsFixture({ withData: false }) },
    });
    const quietLabel = quiet.role("usage-link")?.getAttribute("aria-label") ?? "";
    expect(quietLabel).toContain("时序图");
    expect(quietLabel).not.toContain("合计");
    quiet.close();
  });

  it("keeps the cards silent and shows the failure hint when the command fails", async () => {    const harness = await mountSettled("/", statePayload(), { usageStats: { ok: false, error: "usage_stats_unavailable" } });
    expect(harness.role("usage-requests")?.textContent).toBe("—");
    expect(harness.role("usage-empty")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("usage-empty")?.textContent).toBe("统计读取失败。");
    harness.close();
  });

  it("shows the quiet empty state when nothing ran today", async () => {
    const harness = await mountSettled("/", statePayload(), {
      usageStats: { ok: true, event: "usageStats", stats: usageStatsFixture({ withData: false }) },
    });
    expect(harness.role("usage-requests")?.textContent).toBe("0");
    expect(harness.role("usage-empty")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("usage-empty")?.textContent).toBe("今天还没有请求。");
    /* 图框常驻——空态画基线，柱子为零。 */
    expect(nodes(harness.role("usage-chart"), "path")).toHaveLength(0);
    expect(nodes(harness.role("usage-chart"), "rect")).toHaveLength(0);
    expect(harness.find('[data-role="usage-chart"] .chart__frame')).not.toBeNull();
    harness.close();
  });
});

/* ------------------------------------------------------------------------- */
/* 概览页的五处跳转 + 日志页的 status / stage 预置                             */
/* ------------------------------------------------------------------------- */

describe("overview — jumps", () => {
  it("links the error card to the failed requests and each stage to its own filter", async () => {
    const harness = await mountSettled("/", statePayload(), {
      usageStats: { ok: true, event: "usageStats", stats: usageStatsFixture() },
    });

    // 错误数卡的数字格是一条链：落点是请求事件 tab + status=error
    expect(harness.role("usage-errors")?.getAttribute("href")).toBe("/logs?tab=requests&status=error");
    // 下方阶段分布：两条折叠后的阶段各是一条链（按次数降序，first = 同数时保留首现序）
    const stages = nodes(harness.role("usage-error-stages"), "a");
    expect(stages.map((node) => node.getAttribute("href"))).toEqual([
      "/logs?tab=requests&stage=upstream-resp",
      "/logs?tab=requests&stage=dispatch",
    ]);
    expect(stages.map((node) => node.textContent)).toEqual(["上游响应 1", "调度 1"]);
    expect(stages.map((node) => node.title)).toEqual(["upstream-resp", "dispatch"]);
    expect(harness.role("usage-error-stages")?.textContent).not.toContain("upstream-resp");
    expect(harness.role("usage-error-stages")?.textContent).not.toContain("dispatch");
    expect(harness.role("usage-error-stages")?.hasAttribute("hidden")).toBe(false);
    harness.close();
  });

  it("keeps raw internal stage codes out of the visible error card copy", async () => {
    const harness = await mountSettled("/", statePayload(), {
      usageStats: {
        ok: true,
        event: "usageStats",
        stats: {
          ...usageStatsFixture(),
          errors: [{ stage: "upstream-req", kind: "upstream-error", count: 2 }],
        },
      },
    });
    const card = harness.role("usage-error-stages");
    expect(card?.textContent).toContain("上游请求 2");
    expect(card?.textContent).not.toContain("upstream-req");
    expect(card?.textContent).not.toContain("upstream-resp");
    const link = nodes(card, "a")[0];
    expect(link?.getAttribute("href")).toContain("stage=upstream-req");
    expect(link?.getAttribute("title")).toBe("upstream-req");
    harness.close();
  });

  it("hides the stage line on a clean day", async () => {
    const harness = await mountSettled("/", statePayload(), {
      usageStats: { ok: true, event: "usageStats", stats: usageStatsFixture({ withData: false }) },
    });
    expect(harness.role("usage-error-stages")?.hasAttribute("hidden")).toBe(true);
    expect(nodes(harness.role("usage-error-stages"), "a")).toHaveLength(0);
    harness.close();
  });

  it("sends the shared-egress alert to the accounts-page proxy drawer and risk codes to accounts", async () => {
    const harness = await mountSettled(
      "/",
      statePayload({
        accounts: [account({ label: "a1", proxy: "home" }), account({ label: "a2", proxy: "home" })],
        risk: { alerts: ["account_cooling"], policy: { ...DEFAULT_ACCOUNTS_RISK } },
      }),
    );
    const items = nodes(harness.role("risk-text"), "a");
    /* 代理没有独立页面：共用出口那条告警落到账号页并带上 `?proxies=1`，
       账号页进页面时消费一次、直接把出口代理抽屉展开。 */
    expect(items.map((node) => node.getAttribute("href"))).toEqual(["/accounts", "/accounts?proxies=1"]);
    expect(items[1]?.textContent).toContain("2 个账号共用同一出口");
    // 横幅本体不再是链接，文字仍然在同一行
    expect(harness.role("risk-banner")?.hasAttribute("href")).toBe(false);
    expect(harness.role("risk-text")?.textContent).toBe("有账号处于冷却 · 2 个账号共用同一出口（home）");
    harness.close();
  });

  it("turns the flat concurrency hint into a link to the request log", async () => {
    const flat = await mountSettled("/", statePayload({ metrics: { inflight: 0, concurrencyLimit: 8, queueDepth: 0, sampledAt: 0, inflightHistory: [{ at: 0, inflight: 0 }, { at: 1, inflight: 0 }] } }));
    const links = nodes(flat.role("chart-empty"), "a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/logs?tab=requests");
    expect(links[0]?.textContent).toBe("最近 2 次采样在飞都是 0 · 去日志看看这段时间有没有请求 →");
    flat.close();

    // 没采样时是纯文本（没什么可看的日志），不是链接
    const empty = await mountSettled("/", statePayload());
    expect(nodes(empty.role("chart-empty"), "a")).toHaveLength(0);
    expect(empty.role("chart-empty")?.textContent).toBe("还没有采样");
    empty.close();
  });
});
