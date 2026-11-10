/**
 * 账号页的表格与筛选：额度列 / 状态列 / 健康度 / 展开行 / 统计行 / 搜索 /
 * 复选框 / 焦点跳转 / 代理列。
 *
 * 脚手架见 `runtime-harness.ts`。
 * 这一组是整个套件里最重的（表格 37 个 it 每个都挂一份完整面板 DOM），所以行内
 * 动作、模态与抽屉各自另开文件，单跑任何一个都在 2 GB 以内。
 */

import { describe, expect, it } from "bun:test";
import type { StatePayload } from "../routes-state.js";
import {
  installHarnessHooks,
  account,
  cell,
  commands,
  menuButton,
  mountSettled,
  nodes,
  openDetail,
  proxyRow,
  quota,
  statePayload,
  waitFor,
} from "./runtime-harness.js";
import type { ControlReply, Harness, PageNode } from "./runtime-harness.js";

installHarnessHooks();

/* ------------------------------------------------------------------------- */
/* 账号表格                                                                    */
/* ------------------------------------------------------------------------- */

describe("accounts table", () => {
  it("renders one row per account with the nine columns of the table contract", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account(), account({ label: "payg" })] }));
    const rows = harness.rows("page-accounts-body");
    expect(rows).toHaveLength(2);
    // 复选框 / 账号 / 路由 / 状态 / 并发 / 调度权重 / 额度 / 代理 / 操作
    // （调度权重已含在这九列里，不是第十列）
    for (const row of rows) expect(nodes(row, "td")).toHaveLength(9);
    expect(cell(rows[0], 1)?.textContent).toContain("work-team");
    /* 截断后的全名在 `title` 上：账号名走 ellipsis，长 label 被截掉之后只有
       hover 能读全。ID 前缀不并排显示，改由详情大窗的
       `modal__meta` 承载。 */
    expect(cell(rows[0], 1)?.getAttribute("title")).toBe("work-team");
    expect(cell(rows[0], 1)?.querySelector(".mono")).toBeNull();
    // 类型·路由列只剩路由（类型标签整体去掉）——这一列里没有任何 tag。
    const routeCell = cell(rows[0], 2) as PageNode;
    expect(nodes(routeCell, "span.tag")).toHaveLength(0);
    expect(nodes(routeCell, ".cell-stack__route").map((node) => node.textContent)).toEqual(["coding-plan"]);
  });

  it("merges health and inflight into one StatusBadge (`0/2` with the dot)", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({ accounts: [account({ inflight: 1, maxConcurrency: 2 })] }),
    );
    const status = cell(harness.rows("page-accounts-body")[0], 3);
    expect(status?.textContent).toBe("1/2");
    // 健康用语义色，不是主题色；圆点由徽章自己的 __dot 元素画。
    expect(status?.querySelector("span")?.className).toBe("status-badge status-badge--ok");
    expect(status?.querySelector(".status-badge__dot")).not.toBeNull();
  });

  it("puts the row controls of the accounts table on the 28px in-row tier", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account()] }));
    const row = harness.rows("page-accounts-body")[0] as PageNode;

    /* 操作列与 keys / 代理 同宽：`col-actions` 就是 `--layout-actions-col` 的钩子。
       不挂这个类时，⋯ 列的列宽会随内容伸缩。 */
    const actions = cell(row, 8) as PageNode;
    expect(actions.className).toContain("col-actions");
    expect(actions.querySelector("[data-menu-button]")).not.toBeNull();

    /* 并发步进器与代理下拉是行内控件（高度由 `.table .stepper` / `.table .select`
       收到 `--control-height-sm`，CSS 侧钉在 page.test.ts）；这里钉的是它们真的在行里，
       且没有被另一个外层包一层（包了就选不到）。 */
    expect(cell(row, 4)?.querySelector(".stepper")).not.toBeNull();
    expect(cell(row, 7)?.querySelector("select.select")).not.toBeNull();
  });

  it("shows 冷却 for a cooling account and 401 when a route reports auth-failed", async () => {
    const cooling = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [account({ health: "cooling", routeHealth: [{ route: "coding-plan", status: "cooling" }] })],
      }),
    );
    expect(cell(cooling.rows("page-accounts-body")[0], 3)?.textContent).toBe("冷却");
    cooling.close();

    const authFailed = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            health: "cooling",
            routeHealth: [{ route: "coding-plan", status: "cooling", reason: "auth-failed" }],
          }),
        ],
      }),
    );
    // 401 压过冷却：鉴权失败比冷却更急。
    const status = cell(authFailed.rows("page-accounts-body")[0], 3);
    expect(status?.textContent).toBe("401");
    expect(status?.querySelector("span")?.className).toBe("status-badge status-badge--danger");
  });

  it("paints a paused account neutral instead of the failure red", async () => {
    /* 红色只表示「系统出问题了，需要处理」；用户主动停用走 `--muted`。同一条用例
       里放一个真故障做对照，防止以后把两档又揉回一个 class。 */
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [account({ label: "paused", enabled: false }), account({ label: "failing", health: "drained" })],
      }),
    );
    const paused = cell(harness.rows("page-accounts-body")[0], 3);
    expect(paused?.textContent).toBe("已停用");
    expect(paused?.querySelector("span")?.className).toBe("status-badge status-badge--muted");
    expect(paused?.querySelector(".status-badge--danger")).toBeNull();

    const failing = cell(harness.rows("page-accounts-body")[1], 3);
    expect(failing?.textContent).toBe("额度耗尽");
    expect(failing?.querySelector("span")?.className).toBe("status-badge status-badge--danger");
  });

  it("shows the tightest window's remaining percentage per plan kind in the quota column", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            quota: quota({
              windows: [
                { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 68 },
                { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 31.4 },
              ],
            }),
          }),
        ],
      }),
    );
    // percentage 是**已用**占比。最紧的是 68% 已用（剩 32%），
    // 所以这一行写「订阅 剩 32%」——展示端反转，不再把已用占比当剩余量给用户看；
    // 数值点名「剩」（裸「32%」会被读成「已用 32%」）。
    const quotaCell = cell(harness.rows("page-accounts-body")[0], 6);
    expect(quotaCell?.textContent).toBe("订阅剩 32%");
    // 迷你进度条（60-80px）与三档语义色（剩余 32% → 琥珀，过程态例外）。
    expect(quotaCell?.querySelector(".meter")).not.toBeNull();
    expect(quotaCell?.querySelector(".meter__fill")?.className).toBe("meter__fill meter__fill--warn");
    // 条长 = 剩余占比（32%），不是已用占比（68%）。
    expect(quotaCell?.querySelector(".meter__fill")?.getAttribute("style")).toContain("width: 32%");
    expect(quotaCell?.querySelector(".quota-cell__line")).not.toBeNull();
  });

  it("colors the remaining meter green above 50% and red below 20% (三档)", async () => {
    const healthy = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [account({ quota: quota({ windows: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 10 }] }) })],
      }),
    );
    expect(cell(healthy.rows("page-accounts-body")[0], 6)?.querySelector(".meter__fill")?.className).toBe(
      "meter__fill meter__fill--ok",
    );
    healthy.close();

    const low = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [account({ quota: quota({ windows: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 95 }] }) })],
      }),
    );
    expect(cell(low.rows("page-accounts-body")[0], 6)?.querySelector(".meter__fill")?.className).toBe(
      "meter__fill meter__fill--danger",
    );
  });

  it("draws the experience bucket bar at the remaining share and names the numerator (事故回归)", async () => {
    /* 事故现场：体验桶「8647.2万/5亿」（≈17%）时「条长与数字不符」。
       分子是 remainingUnits（剩余），条长 = 剩余占比 17%；但裸「X/Y」被读成
       「已用 X」（=17% 已用、83% 剩余），条长就跟读出来的数字反向对不上。
       回归钉两件事：条长与数字同向（17%），分子点名「剩」。 */
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            planKinds: ["experience"],
            quota: quota({
              balances: [
                {
                  name: "ZCODE WEEKEND BUILD",
                  planId: "wk",
                  period: "one_time",
                  remainingUnits: 86_472_000,
                  totalUnits: 500_000_000,
                  unitType: "token",
                },
              ],
            }),
          }),
        ],
      }),
    );
    const quotaCell = cell(harness.rows("page-accounts-body")[0], 6);
    expect(quotaCell?.textContent).toContain("剩 8647.2万/5亿");
    const fill = quotaCell?.querySelector(".meter__fill");
    // 条长 = 剩余占比（8647.2万/5亿 ≈ 17.3% → 17%），不是 83%。
    expect(fill?.getAttribute("style")).toContain("width: 17%");
    // <20% 剩余 → 红（toneOf 三档按剩余语义取档）。
    expect(fill?.className).toBe("meter__fill meter__fill--danger");
  });

  it("inverts the coding window's used percentage before every meter (100-x 回归)", async () => {
    /* 两平面 percentage 语义相反：coding 窗口 percentage = 已用占比。
       95% 已用 → 一切进条的数都必须是 5% 剩余；漏掉 100-x 的路径会画成 95%——
       已用与剩余差距最大，一眼可判。两条窗口消费路径（额度格最紧窗口 / 详情
       窗口行）都钉住。 */
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            quota: quota({ windows: [{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 95 }] }),
          }),
        ],
      }),
    );
    const quotaCell = cell(harness.rows("page-accounts-body")[0], 6);
    expect(quotaCell?.textContent).toBe("订阅剩 5%");
    expect(quotaCell?.querySelector(".meter__fill")?.getAttribute("style")).toContain("width: 5%");

    const row = openDetail(harness)?.querySelector(".plan-card__window");
    expect(row?.querySelector(".plan-card__window-pct")?.textContent).toBe("5%");
    expect(row?.querySelector(".meter__fill")?.getAttribute("style")).toContain("width: 5%");
  });

  /* 没有采样时写「未采样」而不是 `—`——额度列里的 `—` 会被读成
     「零额度」。`—` 留给「有采样、但桶全过期」那一种（两种不是一回事）。 */
  it("says 未采样 when there is no quota sample (not 0%, not a dash)", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account({ quota: null })] }));
    const quotaCell = cell(harness.rows("page-accounts-body")[0], 6);
    expect(quotaCell?.textContent).toBe("未采样");
    expect(quotaCell?.querySelector(".quota-cell--empty")?.title).toBe("该账号还没有额度采样结果。");
  });

  it("draws one line per plan kind with the balance amounts and a +N for extra plans", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            planKinds: ["subscription", "experience"],
            quota: quota({
              windows: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 60 }],
              plans: [
                { planId: "wk", name: "ZCODE WEEKEND BUILD", status: "active", entitlements: [] },
                { planId: "pro", name: "GLM CODING PRO", status: "active", entitlements: [] },
              ],
              balances: [
                { name: "ZCODE WEEKEND BUILD", planId: "wk", period: "one_time", remainingUnits: 276_000_000, totalUnits: 500_000_000, unitType: "token" },
                { name: "GLM CODING PRO", planId: "pro", period: "daily", remainingUnits: 1, totalUnits: 2, unitType: "token" },
              ],
            }),
          }),
        ],
      }),
    );
    const quotaCell = cell(harness.rows("page-accounts-body")[0], 6);
    // 一个类型一行：订阅走窗口的剩余百分比、体验走全部活桶的剩余/总量（
    // credits 平面的桶恒属体验体系，不再按 period 分行）。单位在列里省略。
    // 两行数值都点名「剩」——分子是 remaining，裸「X/Y」会被读成「已用」。
    expect(nodes(quotaCell, ".quota-cell__line")).toHaveLength(2);
    expect(quotaCell?.textContent).toContain("订阅");
    expect(quotaCell?.textContent).toContain("剩 40%");
    expect(quotaCell?.textContent).toContain("体验");
    expect(quotaCell?.textContent).toContain("剩 2.76亿/5亿");
    // 卡序列 3 张（两个 plan 卡 + 窗口卡），已画 2 行 → +1。
    expect(quotaCell?.textContent).toContain("+1");
  });

  it("counts expired buckets nowhere in the quota column (过期桶不虚增可用额度)", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            planKinds: ["experience"],
            quota: quota({
              balances: [
                { name: "DEAD", period: "one_time", remainingUnits: 500_000_000, totalUnits: 500_000_000, expiresAt: Date.now() - 3_600_000 },
                { name: "LIVE", period: "one_time", remainingUnits: 120_000_000, totalUnits: 200_000_000 },
              ],
            }),
          }),
        ],
      }),
    );
    const text = cell(harness.rows("page-accounts-body")[0], 6)?.textContent ?? "";
    // 活桶 1.2亿 / 总 2亿；过期桶的 5亿既不进剩余也不进分母（数值点名「剩」）。
    expect(text).toContain("剩 1.2亿/2亿");
    expect(text).not.toContain("6.2亿");
  });

  it("opens the detail window on a row click and closes it on the close button", async () => {
    const hourAhead = Date.now() + 3600 * 1000;
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            planKinds: ["experience"],
            routes: ["start-plan"],
            quota: quota({
              plans: [
                {
                  planId: "wk",
                  name: "ZCODE WEEKEND BUILD",
                  status: "active",
                  endsAt: hourAhead,
                  entitlements: [{ showName: "GLM-5.3-Flash", period: "one_time", effectiveAt: 0 }],
                },
              ],
              balances: [
                {
                  name: "GLM-5.3-Flash",
                  planId: "wk",
                  period: "one_time",
                  remainingUnits: 341_000_000,
                  totalUnits: 500_000_000,
                  unitType: "token",
                  expiresAt: Date.now() + 24 * 3600 * 1000,
                },
              ],
            }),
          }),
        ],
      }),
    );
    const detail = openDetail(harness);
    // 居中大窗（`.modal--lg`）开了，遮罩与壳的 `hidden` 都摘掉。
    expect(harness.role("account-dialog-scrim")?.hasAttribute("hidden")).toBe(false);
    expect(harness.find('[data-dialog="account"]')?.hasAttribute("hidden")).toBe(false);
    expect(harness.find('[data-dialog="account"]')?.className).toContain("modal--lg");
    // 标题是账号 label，头部右侧是套餐类型标签 + ID 前缀。
    expect(harness.role("account-dialog-title")?.textContent).toBe("work-team");
    expect(harness.role("account-dialog-meta")?.textContent).toContain("体验套餐");
    expect(harness.role("account-dialog-meta")?.textContent).toContain("abcd1234");

    const text = detail?.textContent ?? "";
    // 套餐卡：类型标签 + 套餐名（plan.name）+ 生效中 + 到期 + 模型桶行。
    expect(text).toContain("我的套餐");
    expect(text).toContain("体验套餐");
    expect(text).toContain("ZCODE WEEKEND BUILD");
    expect(text).toContain("生效中");
    expect(text).toContain("到期");
    expect(text).toContain("GLM-5.3-Flash");
    // 桶行数值：分子点名「剩」，条长 = 剩余占比（68%）。
    expect(text).toContain("剩 3.41亿/5亿");
    const planFill = detail?.querySelector(".plan-card")?.querySelector(".meter__fill");
    expect(planFill?.className).toBe("meter__fill meter__fill--ok");
    // 套餐卡的条长也是剩余占比（68%），不是已用占比（32%）。
    expect(planFill?.getAttribute("style")).toContain("width: 68%");
    // 段级可用合计不计过期桶。
    expect(text).toContain("可用 3.41亿 token");
    // 这个 fixture 没有可领活动，第三段不画空卡。
    expect(text).not.toContain("本期活动");

    // 关闭键收窗（遮罩与壳都回到 hidden）。
    harness.click(harness.find('.modal__close') as PageNode);
    expect(harness.role("account-dialog-scrim")?.hasAttribute("hidden")).toBe(true);
    expect(harness.find('[data-dialog="account"]')?.hasAttribute("hidden")).toBe(true);
  });

  it("opens the window from the quota cell itself (一级披露整格可点)", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({ accounts: [account({ quota: quota({ windows: [{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 40 }] }) })] }),
    );
    const quotaBox = cell(harness.rows("page-accounts-body")[0], 6)?.querySelector("[data-quota-open]");
    harness.click(quotaBox as PageNode);
    expect(harness.find('[data-dialog="account"]')?.hasAttribute("hidden")).toBe(false);
  });

  it("excludes expired buckets from the availability note (过期桶不得虚增可用额度)", async () => {
    // 过期桶仍留在明细里（灰行、不画条），但「可用 X」合计只收活桶——与采样层
    // credits 合计同口径。
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            quota: quota({
              plans: [{ planId: "pack", name: "PACK", status: "active", entitlements: [] }],
              balances: [
                { name: "EXPIRED PACK", planId: "pack", remainingUnits: 500_000_000, totalUnits: 500_000_000, unitType: "token", expiresAt: Date.now() - 3_600_000 },
                { name: "LIVE PACK", planId: "pack", remainingUnits: 120_000_000, totalUnits: 200_000_000, unitType: "token", expiresAt: Date.now() + 3_600_000 },
              ],
            }),
          }),
        ],
      }),
    );
    const detail = openDetail(harness);
    const text = detail?.textContent ?? "";
    // 过期桶行灰显、不画条（余量已经不归它了）。
    const expiredRow = detail?.querySelector(".plan-card__bucket--expired");
    expect(expiredRow?.textContent).toContain("EXPIRED PACK");
    expect(expiredRow?.querySelector(".meter")).toBeNull();
    expect(text).toContain("可用 1.2亿 token");
    expect(text).not.toContain("可用 6.2亿 token");
  });

  it("explains a JWT-only account's start-plan limit in the window", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            routes: ["start-plan"],
            hasApiKey: false,
            routeHealth: [{ route: "start-plan", status: "ok" }],
          }),
        ],
      }),
    );
    const note = openDetail(harness)?.querySelector(".detail__note:not(.detail__note--quiet)");
    expect(note?.textContent).toContain("只能跑 start-plan");
    expect(note?.textContent).toContain("OAuth");
  });

  it("stays quiet when the account holds an apiKey pair or a wider whitelist", async () => {
    /* 有 apiKey 对就不缺材料；白名单多于 start-plan 也不是「只能跑」的状态。*/
    const withKey = await mountSettled(
      "/accounts",
      statePayload({ accounts: [account({ routes: ["start-plan"], hasApiKey: true })] }),
    );
    withKey.click(withKey.rows("page-accounts-body")[0] as PageNode);
    expect(withKey.role("account-dialog-body")?.querySelector(".detail__note:not(.detail__note--quiet)")).toBeNull();
    withKey.close();

    const wider = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [account({ routes: ["coding-plan", "start-plan"], hasApiKey: false })],
      }),
    );
    wider.click(wider.rows("page-accounts-body")[0] as PageNode);
    expect(wider.role("account-dialog-body")?.querySelector(".detail__note:not(.detail__note--quiet)")).toBeNull();
  });

  it("shows a countdown for the 5-hour window and a date for the weekly one (官方重置口径)", async () => {
    /* 5 小时窗的重置时刻固定成「现在 + 2h14m」，断言就是一个稳定的 2h 14m。*/
    const resetIn = Date.now() + 2 * 60 * 60 * 1000 + 14 * 60 * 1000;
    const weeklyReset = Date.now() + 3 * 24 * 60 * 60 * 1000;
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            quota: quota({
              windows: [
                { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 68, nextResetTime: resetIn },
                { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 20, nextResetTime: weeklyReset },
              ],
            }),
          }),
        ],
      }),
    );
    const detail = openDetail(harness);
    const text = detail?.textContent ?? "";
    // 倒计时按相邻两档格式化（「1h 26m 后重置」）——官方 5 小时卡给时刻。
    expect(text).toContain("2h 14m 后重置");
    // 周窗给日期（`11月11日`，见 app-format.js 的 formatDate）：提前几天看到就够。
    const weeklyRow = detail?.querySelectorAll(".plan-card__window")[1];
    expect(weeklyRow?.querySelector(".plan-card__window-reset")?.textContent).toMatch(/^\d+月\d+日$/);
  });

  it("omits the reset text when upstream gives no reset time", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({ quota: quota({ windows: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 68 }] }) }),
        ],
      }),
    );
    const noReset = openDetail(harness);
    expect(noReset?.textContent).not.toContain("重置");
  });

  it("keeps the used/total pair as the window row's tooltip (总量 = usage+remaining 反推)", async () => {
    // 事故现场：周窗已用 4.28亿、余 7200万 → 「已用 4.28亿 / 总量 5亿」。
    // 总量没有上游字段（上游 number 是窗口身份，不是 token 总量），页面由
    // usage+remaining 反推；两者缺一就不算。这对数字进窗口行的 `title`：
    // 官方四格行只放百分比与重置（见官方额度卡截图对照），把这对塞进同一行会把
    // 重置时间挤掉，而它仍是可核对的原始量。分子点名「已用 / 总量」——
    // 行内的百分比与条是剩余语义，裸「X / Y」会被读成同向。
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            quota: quota({
              windows: [
                { type: "TOKENS_LIMIT", unit: 6, number: 1, usage: 4.28e8, remaining: 7.2e7 },
                { type: "TIME_LIMIT", unit: 5, number: 1, usage: 84 },
              ],
            }),
          }),
        ],
      }),
    );
    const rows = openDetail(harness)?.querySelectorAll(".plan-card__window") ?? [];
    expect(rows[0]?.title).toContain("已用 4.28亿 / 总量 5亿");
    // remaining 缺失时总量推不出来，只画 usage 也不行——整对都不出现（没有 title）。
    expect(rows[1]?.title).toBe("");
  });

  it("says so when there is no quota sample yet", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account({ quota: null })] }));
    expect(openDetail(harness)?.textContent).toContain("还没有额度采样");
  });

  it("shows one quiet note instead of empty plan cards when no plan data exists", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({ accounts: [account({ quota: quota({}) })] }),
    );
    const detail = openDetail(harness);
    const text = detail?.textContent ?? "";
    expect(text).toContain("还没有套餐余额");
    expect(text).not.toContain("本期活动");
    // 一张卡都不画（不画空壳）。
    expect(detail?.querySelector(".plan-card")).toBeNull();
  });

  it("keeps the coding-plane windows as a plan card when there are no balance buckets", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            quota: quota({ windows: [{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 68 }] }),
          }),
        ],
      }),
    );
    const detail = openDetail(harness);
    const card = detail?.querySelector(".plan-card");
    // 窗口属于订阅套餐（coding 平面），所以它自成一张「订阅套餐 · 用量窗口」卡。
    expect(card?.textContent).toContain("订阅套餐");
    expect(card?.textContent).toContain("每周剩余");
    expect(card?.querySelector(".plan-card__window")).not.toBeNull();
  });

  it("upgrades the coding-plane window card with the real subscription product", async () => {
    // 同一账号可同时持有体验与编程两套 entitlement。产品名只认
    // subscription/list 采回的 productName；状态词 / 续期 / 到期 / 形态来自同一份
    // 协议字段，窗口行（5h/周额度条）保持不变。
    const renewTime = Date.parse("2026-12-09T09:00:00");
    const expireTime = Date.parse("2027-11-09");
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            quota: quota({
              windows: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 68 }],
              subscription: {
                kind: "personal",
                productId: "coding-plan-pro",
                productName: "GLM Coding Plan Pro",
                status: "VALID",
                inCurrentPeriod: true,
                autoRenew: true,
                billingCycle: "MONTHLY",
                renewTime,
                expireTime,
              },
            }),
          }),
        ],
      }),
    );
    const card = openDetail(harness)?.querySelector(".plan-card");
    expect(card?.querySelector(".plan-card__name")?.textContent).toBe("GLM Coding Plan Pro");
    expect(card?.textContent).toContain("当前期有效");
    expect(card?.textContent).toContain("个人订阅");
    expect(card?.textContent).toContain("续期 12/9 09:00");
    expect(card?.textContent).toContain("到期 11/9 00:00");
    expect(card?.textContent).toContain("计费周期 MONTHLY");
    // 窗口行与额度条一格不少。
    expect(card?.querySelectorAll(".plan-card__window")).toHaveLength(1);
    expect(card?.querySelector(".meter")).not.toBeNull();
    expect(card?.textContent).toContain("5 小时剩余");
  });

  it("keeps three plan cards when two experience plans coexist with one subscription card", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            planKinds: ["subscription", "experience"],
            routes: ["coding-plan", "start-plan"],
            quota: quota({
              plans: [
                { planId: "start", name: "ZCode Start Plan", status: "active", entitlements: [] },
                { planId: "weekend", name: "ZCODE WEEKEND BUILD", status: "active", entitlements: [] },
              ],
              balances: [
                { name: "GLM-5.3", planId: "start", period: "daily", remainingUnits: 1, totalUnits: 2 },
                { name: "GLM-5.3-Flash", planId: "weekend", period: "one_time", remainingUnits: 3, totalUnits: 4 },
              ],
              windows: [{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 68 }],
              subscription: {
                kind: "team",
                productId: "team-product",
                productName: "Team Coding Plan",
                status: "EFFECTIVE",
                memberGrantStatus: "VALID",
                billingCycle: "yearly",
                expireTime: Date.parse("2027-08-25"),
              },
            }),
          }),
        ],
      }),
    );
    const detail = openDetail(harness);
    const cards = detail?.querySelectorAll(".plan-card") ?? [];
    expect(cards).toHaveLength(3);
    expect(detail?.querySelectorAll(".plan-group")).toHaveLength(2); // 分区结构不变
    const groups = detail?.querySelectorAll(".plan-group") ?? [];
    expect(groups[0]?.querySelectorAll(".plan-card")).toHaveLength(2);
    expect(groups[0]?.textContent).toContain("ZCode Start Plan");
    expect(groups[0]?.textContent).toContain("ZCODE WEEKEND BUILD");
    expect(groups[1]?.querySelectorAll(".plan-card")).toHaveLength(1);
    expect(groups[1]?.textContent).toContain("Team Coding Plan");
    expect(groups[1]?.textContent).toContain("团队订阅");
    expect(groups[1]?.textContent).toContain("当前期有效");
    expect(groups[1]?.textContent).toContain("到期 8/25 00:00");
    // 团队接口没有 renewTime：不编造续期日（官方映射恒 null）。
    expect(groups[1]?.textContent).not.toContain("续期");
  });

  it("honestly falls back to the usage-window description when the product probe is unknown", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [account({ quota: quota({ windows: [{ type: "TOKENS_LIMIT", percentage: 42 }] }) })],
      }),
    );
    const card = openDetail(harness)?.querySelector(".plan-card");
    expect(card?.querySelector(".plan-card__name")?.textContent).toBe("用量窗口");
    expect(card?.textContent).toContain("产品信息未采到");
    expect(card?.textContent).toContain("TOKENS_LIMIT");
    expect(card?.querySelector(".meter")).not.toBeNull();
  });

  it("partitions the plans section into 体验套餐/编程套餐 groups when both systems coexist", async () => {
    // 同一账号可同时持有体验套餐（Start Plan）与编程套餐（Coding Plan）：两类卡
    // 并存时分区呈现、各带官方词小标题。分组只动段内渲染，卡片内部不动。
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            planKinds: ["subscription", "experience"],
            routes: ["coding-plan", "start-plan"],
            quota: quota({
              windows: [{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 68 }],
              plans: [{ planId: "start", name: "ZCode Start Plan", status: "active", entitlements: [] }],
              balances: [
                { name: "GLM-5.3", planId: "start", period: "daily", remainingUnits: 1, totalUnits: 2 },
                // 无 plan_id 的桶单独暴露成「未归属额度」卡——它归体验区。
                { name: "ORPHAN", period: "one_time", remainingUnits: 3, totalUnits: 4 },
              ],
            }),
          }),
        ],
      }),
    );
    const detail = openDetail(harness);
    const groups = detail?.querySelectorAll(".plan-group") ?? [];
    expect(groups).toHaveLength(2);
    expect(detail?.querySelectorAll(".plan-group__title")).toHaveLength(2);
    // 小标题用官方词（i18n 新键）：体验区在前、编程区在后。
    expect(groups[0]?.querySelector(".plan-group__title")?.textContent).toBe("体验套餐");
    expect(groups[1]?.querySelector(".plan-group__title")?.textContent).toBe("编程套餐");
    // 体验区 = plans[] 派生的体验卡 +「未归属额度」；编程区 = 订阅窗口卡。
    expect(groups[0]?.querySelectorAll(".plan-card")).toHaveLength(2);
    expect(groups[0]?.textContent).toContain("ZCode Start Plan");
    expect(groups[0]?.textContent).toContain("未归属额度");
    expect(groups[0]?.querySelector(".plan-card__window")).toBeNull();
    expect(groups[1]?.querySelectorAll(".plan-card")).toHaveLength(1);
    // 卡片内部结构不变（只有订阅卡会变）：窗口卡仍是「订阅套餐 · 用量窗口」。
    expect(groups[1]?.querySelector(".plan-card__window")).not.toBeNull();
    expect(groups[1]?.textContent).toContain("订阅套餐");
    expect(groups[1]?.textContent).toContain("用量窗口");
  });

  it("keeps the flat card grid without group titles when only one system is present", async () => {
    // 单体系不加多余层级：小标题只在两体系并存时出现（保持既有视觉）。
    const codingOnly = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            routes: ["coding-plan"],
            quota: quota({ windows: [{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 68 }] }),
          }),
        ],
      }),
    );
    let detail = openDetail(codingOnly);
    expect(detail?.querySelector(".plan-card")).not.toBeNull();
    expect(detail?.querySelector(".plan-cards")).not.toBeNull();
    expect(detail?.querySelector(".plan-groups")).toBeNull();
    expect(detail?.querySelector(".plan-group__title")).toBeNull();
    codingOnly.close();

    // 体验单体系（实证形态）同样平铺。
    const experienceOnly = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            planKinds: ["experience"],
            routes: ["start-plan"],
            quota: quota({
              plans: [{ planId: "start", name: "ZCode Start Plan", status: "active", entitlements: [] }],
              balances: [{ name: "GLM-5.3", planId: "start", period: "daily", remainingUnits: 1, totalUnits: 2 }],
            }),
          }),
        ],
      }),
    );
    detail = openDetail(experienceOnly);
    expect(detail?.querySelectorAll(".plan-card")).toHaveLength(1);
    expect(detail?.querySelector(".plan-groups")).toBeNull();
    expect(detail?.querySelector(".plan-group__title")).toBeNull();
  });

  it("renders the campaigns section with status tags and the entitlement line", async () => {
    const hourAhead = Date.now() + 3600 * 1000;
    const hourAgo = Date.now() - 3600 * 1000;
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            quota: quota({
              campaigns: [
                {
                  planId: "wk-1114",
                  name: "ZCODE WEEKEND BUILD",
                  status: "claimed",
                  startsAt: hourAgo,
                  endsAt: hourAhead,
                  entitlements: [{ showName: "GLM-5.3-Flash", grantUnits: 500_000_000, unitType: "token" }],
                  source: "preview",
                },
              ],
            }),
          }),
        ],
      }),
    );
    const text = openDetail(harness)?.textContent ?? "";
    expect(text).toContain("本期活动");
    expect(text).toContain("官方限时活动");
    expect(text).toContain("已领");
    expect(text).toContain("活动");
    expect(text).toContain("GLM-5.3-Flash 5亿 token");
  });

  it("tags expired plans and buckets 已过期 (render-time check, not just sample-time status)", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            quota: quota({
              balances: [
                { name: "ZCODE WEEKEND BUILD", planId: "wk-0918", remainingUnits: 1, totalUnits: 2, expiresAt: Date.now() - 1000 },
              ],
              plans: [{ planId: "wk-0918", name: "OLD", status: "expired", endsAt: Date.now() - 1000, entitlements: [] }],
            }),
          }),
        ],
      }),
    );
    const detail = openDetail(harness);
    const text = detail?.textContent ?? "";
    // 已过期的套餐卡不再挂「生效中」，卡头有「已过期」+ 过期时间。
    expect(text).not.toContain("生效中");
    expect(text).toContain("已过期");
    expect(detail?.querySelector(".plan-card--expired")).not.toBeNull();
  });

  it("shows 待生效 with the effective time for a plan whose entitlement starts in the future", async () => {
    // 「待生效」不是 plan 状态字段，是 `entitlements[].effective_at > now` 的投影
    // （与官方 resolveStartPlanStatusMetaState 同口径）；显示最近的未来
    // 生效时刻。effectiveAt = 0 是「立即生效」哨兵，不算未来。
    const later = Date.now() + 3 * 3600 * 1000;
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            quota: quota({
              plans: [
                {
                  planId: "zcode-global-build",
                  name: "ZCODE GLOBAL BUILD",
                  status: "active",
                  entitlements: [{ showName: "GLM-5.3", period: "one_time", effectiveAt: later }],
                },
              ],
            }),
          }),
        ],
      }),
    );
    const card = openDetail(harness)?.querySelector(".plan-card");
    expect(card?.textContent).toContain("ZCODE GLOBAL BUILD");
    // 卡头两枚 tag：类型（体验套餐）+ 状态词（待生效）。状态词是最后一个 span。
    expect(card?.querySelector(".plan-card__head .tag")?.textContent).toBe("体验套餐");
    expect(card?.querySelector(".plan-card__head > span:last-of-type")?.textContent).toBe("待生效");
    expect(card?.querySelector(".plan-card__meta")?.textContent).toContain("生效");
    expect(card?.textContent).not.toContain("生效中");
  });

  it("labels the bucket rows with show_name, the remaining pair and the refresh-cycle copy", async () => {
    // 模型桶按 show_name 拆行；数值点名「剩」；重置文案 = period 刷新周期 + expires_at
    // （daily → 「每日重置」，one_time → 「一次性」）。
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            quota: quota({
              plans: [{ planId: "start", name: "ZCode Start Plan", status: "active", entitlements: [] }],
              balances: [
                {
                  name: "GLM-5.3",
                  planId: "start",
                  period: "daily",
                  remainingUnits: 2_000_000,
                  totalUnits: 8_000_000,
                  unitType: "token",
                  expiresAt: Date.now() + 3600 * 1000,
                },
                {
                  name: "GLM-5.3-Flash",
                  planId: "start",
                  period: "one_time",
                  remainingUnits: 1_000_000,
                  totalUnits: 5_000_000,
                  unitType: "token",
                  expiresAt: Date.now() + 7200 * 1000,
                },
              ],
            }),
          }),
        ],
      }),
    );
    const rows = openDetail(harness)?.querySelectorAll(".plan-card__bucket") ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector(".plan-card__bucket-label")?.textContent).toBe("GLM-5.3");
    // 桶行数值点名「剩」；单位进 title（430px 卡列放不下正文带单位，实测截断）。
    expect(rows[0]?.querySelector(".plan-card__bucket-amount")?.textContent).toBe("剩 200万/800万");
    expect(rows[0]?.querySelector(".plan-card__bucket-amount")?.title).toBe("剩 200万/800万 token");
    expect(rows[0]?.querySelector(".plan-card__bucket-reset")?.textContent).toContain("每日重置");
    expect(rows[1]?.querySelector(".plan-card__bucket-label")?.textContent).toBe("GLM-5.3-Flash");
    expect(rows[1]?.querySelector(".plan-card__bucket-reset")?.textContent).toContain("一次性");
    // daily 只报时刻（「每日」已经说了什么时候重置）；one_time 报到期时刻（死线）。
    expect(rows[0]?.querySelector(".plan-card__bucket-reset")?.textContent).toMatch(/^每日重置 \d{2}:\d{2}$/);
    expect(rows[1]?.querySelector(".plan-card__bucket-reset")?.textContent).toMatch(/^一次性 \d+\/\d+ \d{2}:\d{2}$/);
  });

  it("marks data older than one sampling period with 上次采样 X 分钟前", async () => {
    /* 数据龄标注：额度列 tooltip + 套餐段轻量标注；阈值 = 一个采样周期
       （pollSeconds，服务端随摘要下发）。刷新后新载荷的 sampledAt 是新的，标注消失。 */
    const staleQuota = quota({ sampledAt: Date.now() - 8 * 60_000, pollSeconds: 300 });
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            quota: staleQuota,
          }),
        ],
      }),
    );
    // 额度列：tooltip 补一行数据龄。
    const quotaCell = cell(harness.rows("page-accounts-body")[0], 6);
    expect(quotaCell?.querySelector("[data-quota-open]")?.title).toContain("上次采样 8 分钟前");
    // 套餐段：一行轻量标注。
    const detail = openDetail(harness);
    expect(detail?.textContent).toContain("上次采样 8 分钟前");

    // 新鲜数据（采样龄 < 一个采样周期）不标注。
    harness.state = statePayload({ accounts: [account({ quota: quota({}) })] });
    await harness.refresh();
    const fresh = openDetail(harness);
    expect(fresh?.textContent).not.toContain("上次采样");
  });

  it("refresh button re-dispatches the quota command with the label and keeps the card mounted", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [account({ quota: quota({ balances: [{ name: "OLD BUCKET", remainingUnits: 1, totalUnits: 2 }] }) })],
      }),
    );
    const detail = openDetail(harness);
    expect(detail).not.toBeNull();

    // 刷新后服务端会给出新的套餐数据：预置到 state 里，回读时就是它。
    harness.state = statePayload({
      accounts: [
        account({
          quota: quota({
            balances: [{ name: "ZCODE WEEKEND BUILD", remainingUnits: 341_000_000, totalUnits: 500_000_000, unitType: "token" }],
          }),
        }),
      ],
    });
    harness.controlReplies = [{ ok: true, event: "quotaRefreshed" } as unknown as ControlReply];
    /* 刷新在大窗头部（`.modal__actions`），命令面不变。 */
    harness.click(harness.find('.modal__actions [data-action="accounts-refresh-quota"]') as PageNode);
    await harness.settle();

    // 复用现有的 quota 命令，带 label 只刷这个账号。
    const call = commands(harness).find((entry) => (entry.body as { cmd?: string }).cmd === "quota");
    expect(call?.body).toEqual({ cmd: "quota", label: "work-team" });
    // 开合状态跨重画保留（widgets 层持有），窗体显示的是回读后的新数据
    // （服务端是唯一真值）。
    const refreshed = harness.role("account-dialog-body");
    expect(refreshed).not.toBeNull();
    expect(refreshed?.textContent).toContain("ZCODE WEEKEND BUILD");
    expect(refreshed?.textContent).not.toContain("OLD BUCKET");
  });

  it("opens the detail window for a disabled account too (停用不是不能看)", async () => {
    /* 停用只影响调度（不派新请求），详情是只读展示：用户要能看一眼停用账号还剩
       多少额度。这条钉住「enabled 不参与开窗判定」。*/
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            enabled: false,
            quota: quota({ windows: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 40 }] }),
          }),
        ],
      }),
    );
    const detail = openDetail(harness);
    expect(harness.find('[data-dialog="account"]')?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("account-dialog-title")?.textContent).toBe("work-team");
    // 只读展示照旧：额度与状态都在。开窗只拉一次活动预览（只读），不发写命令。
    expect(detail?.textContent).toContain("我的套餐");
    const writes = commands(harness).filter((call) => (call.body as { cmd?: string }).cmd !== "previewClaimPlans");
    expect(writes).toHaveLength(0);
  });

  it("guides the user when there is no account at all", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    expect(harness.role("page-accounts-empty")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("page-accounts-table")?.hasAttribute("hidden")).toBe(true);
    // 引导里有两条入口：登录 / 导入本机文件（登录是主路径；导入在「导入凭据」
    // tab 里，data-add-tab 键跟着改）
    const actions = nodes(harness.role("page-accounts-empty"), "[data-add-tab]");
    expect(actions.map((action) => action.getAttribute("data-add-tab"))).toEqual(["login", "credential"]);
  });

  it("closes the window on Esc, on a scrim click and on the X (三条关闭路径)", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account()] }));
    openDetail(harness);
    expect(harness.find('[data-dialog="account"]')?.hasAttribute("hidden")).toBe(false);

    // Esc：关窗（焦点管理在 widgets 层）。
    harness.win.document.dispatchEvent(new harness.win.KeyboardEvent("keydown", { key: "Escape" }));
    expect(harness.find('[data-dialog="account"]')?.hasAttribute("hidden")).toBe(true);

    // 再开一次，点遮罩也关。
    openDetail(harness);
    harness.click(harness.role("account-dialog-scrim") as PageNode);
    expect(harness.find('[data-dialog="account"]')?.hasAttribute("hidden")).toBe(true);

    // 第三条：X（`.modal__close`）。
    openDetail(harness);
    harness.click(harness.find('.modal__close') as PageNode);
    expect(harness.find('[data-dialog="account"]')?.hasAttribute("hidden")).toBe(true);
  });

  it("sends focus to the close button when the window opens and back to the opener (焦点管理)", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account()] }));
    const opener = harness.find('[data-quota-open]') as PageNode;
    // 键盘路径：焦点先落在额度格（它是个真 button），再按回车 / 点击开窗。
    (opener as unknown as { focus(): void }).focus();
    opener.click();
    // 打开后焦点落在关闭键（键盘用户一步就能出去）。
    const focusedOnOpen = harness.win.document.activeElement;
    expect(focusedOnOpen === (harness.find(".modal__close") as unknown)).toBe(true);
    harness.click(harness.find('.modal__close') as PageNode);
    // 关闭后焦点还给打开它的那个元素。
    expect(harness.win.document.activeElement === (opener as unknown)).toBe(true);
  });

  it("keeps the window open and re-renders its body across polls (跨轮询)", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account()] }));
    openDetail(harness);

    harness.state = statePayload({
      accounts: [
        account({ quota: quota({ windows: [{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 58 }] }) }),
      ],
    });
    await harness.refresh();

    // 窗还开着，体里是新数据（服务端是唯一真值）：58 已用 → 42% 剩余。
    expect(harness.find('[data-dialog="account"]')?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("account-dialog-body")?.textContent).toContain("42%");
  });

  it("keeps keyboard focus on the same control across a poll re-render (焦点身份)", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account()] }));
    openDetail(harness);

    /* 详情窗的体每拍整段重建。焦点停在一个窗内按钮上时，重画之后要回到同一个
       控件（同一位置、同一文案），不能掉到 body，也不能跳到别的动作上。 */
    const dialog = harness.win.document.querySelector('[data-dialog="account"]') as unknown as {
      querySelectorAll(selector: string): ArrayLike<unknown>;
    };
    const before = (dialog.querySelectorAll("button") as unknown as PageNode[])[0] as unknown as {
      textContent: string | null;
      focus(): void;
    };
    before.focus();
    expect(harness.win.document.activeElement === (before as unknown)).toBe(true);

    await harness.refresh();

    const after = (dialog.querySelectorAll("button") as unknown as PageNode[])[0] as unknown as {
      textContent: string | null;
    };
    expect(harness.win.document.activeElement === (after as unknown)).toBe(true);
    expect(harness.win.document.activeElement).not.toBe(harness.win.document.body);
    expect(after.textContent).toBe(before.textContent);
  });

  it("gives every row a keyboard entry (tabindex + Enter) so the dialog has a source", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account()] }));
    const row = harness.rows("page-accounts-body")[0] as unknown as {
      getAttribute(name: string): string | null;
      dispatchEvent(event: unknown): boolean;
      focus(): void;
    };
    expect(row.getAttribute("tabindex")).toBe("0");

    row.focus();
    expect(harness.win.document.activeElement === (row as unknown)).toBe(true);
    row.dispatchEvent(new harness.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(harness.find('[data-dialog="account"]')?.hasAttribute("hidden")).toBe(false);

    /* 关窗把焦点还给那一行（鼠标点行时也是同一条：委托里先把焦点放到行上）。 */
    harness.win.document.dispatchEvent(new harness.win.KeyboardEvent("keydown", { key: "Escape" }));
    expect(harness.win.document.activeElement === (row as unknown)).toBe(true);
  });

  it("closes the window when its account is deleted", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account()] }));
    openDetail(harness);
    harness.state = statePayload({ accounts: [] });
    await harness.refresh();
    expect(harness.find('[data-dialog="account"]')?.hasAttribute("hidden")).toBe(true);
  });

  it("shows per-route health in the drawer (逐路由明细，状态键是 (account, route))", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            routeHealth: [
              { route: "coding-plan", status: "ok" },
              { route: "start-plan", status: "cooling", reason: "rate-limited" },
            ],
          }),
        ],
      }),
    );
    const text = openDetail(harness)?.textContent ?? "";
    expect(text).toContain("路由健康");
    expect(text).toContain("coding-plan");
    expect(text).toContain("正常");
    expect(text).toContain("start-plan");
    expect(text).toContain("冷却");
    expect(text).toContain("限流");
  });

  it("groups the balance buckets into one card per plan (plan_id 分组，卡片名 = plan.name)", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            planKinds: ["experience"],
            routes: ["start-plan"],
            quota: quota({
              plans: [
                { planId: "plan-start", name: "ZCode Start Plan", status: "active", entitlements: [] },
                { planId: "plan-weekend", name: "ZCODE WEEKEND BUILD", status: "active", entitlements: [] },
              ],
              balances: [
                {
                  name: "GLM-5.3",
                  planId: "plan-start",
                  period: "daily",
                  remainingUnits: 100,
                  totalUnits: 200,
                  unitType: "token",
                },
                {
                  name: "GLM-5.3-Flash",
                  planId: "plan-weekend",
                  period: "one_time",
                  remainingUnits: 5,
                  totalUnits: 10,
                  unitType: "token",
                },
                {
                  // 同 plan_id 的第二个桶：进同一张卡，一行一桶，不重复卡名。
                  name: "GLM-5.3-Flash daily",
                  planId: "plan-start",
                  period: "daily",
                  remainingUnits: 1,
                  totalUnits: 2,
                  unitType: "token",
                },
              ],
            }),
          }),
        ],
      }),
    );
    const detail = openDetail(harness);
    const cards = detail?.querySelectorAll(".plan-card") ?? [];
    // 两个 plan = 两张卡（分组只看 plan，不按 planId|period|过期态 拆）。
    expect(cards).toHaveLength(2);
    // 卡片名 = plan.name（不是桶名，也不是 planId）。
    expect(cards[0]?.querySelector(".plan-card__name")?.textContent).toBe("ZCode Start Plan");
    expect(cards[1]?.querySelector(".plan-card__name")?.textContent).toBe("ZCODE WEEKEND BUILD");
    // 套餐卡恒出自 credits 平面 → 「体验套餐」（不按 period 标类型）。
    expect(cards[0]?.querySelector(".plan-card__head .tag")?.textContent).toBe("体验套餐");
    expect(cards[1]?.querySelector(".plan-card__head .tag")?.textContent).toBe("体验套餐");
    // 同 plan 的两个桶合成一张卡、一行一桶（show_name 各一行）。
    expect(cards[0]?.querySelectorAll(".plan-card__bucket")).toHaveLength(2);
    expect(cards[0]?.textContent).toContain("GLM-5.3");
    expect(cards[0]?.textContent).toContain("GLM-5.3-Flash daily");
    // 桶行数值按桶给（剩 X/总量 Y），不再有卡级合计行。
    expect(cards[0]?.textContent).toContain("剩 100/200");
    expect(cards[0]?.textContent).toContain("剩 1/2");
    expect(cards[0]?.querySelectorAll(".plan-card__bucket")).toHaveLength(2);
    expect(cards[1]?.textContent).toContain("GLM-5.3-Flash");
  });

  it("names a planId group after the matching plan when one exists", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            quota: quota({
              balances: [
                { name: "bucket-a", planId: "plan-start", period: "daily", remainingUnits: 1, totalUnits: 2 },
              ],
              plans: [{ planId: "plan-start", name: "ZCode Start Plan", status: "active", entitlements: [] }],
            }),
          }),
        ],
      }),
    );
    const text = openDetail(harness)?.textContent ?? "";
    // 卡名用套餐实例的 name；planId 本身不露给用户。
    expect(text).toContain("ZCode Start Plan");
    expect(text).not.toContain("plan-start");
  });

  it("puts one kind tag on the card head and splits the model buckets by show_name", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            planKinds: ["experience"],
            routes: ["start-plan"],
            quota: quota({
              plans: [{ planId: "plan-start", name: "ZCode Start Plan", status: "active", entitlements: [] }],
              balances: [
                {
                  name: "GLM-5.3",
                  planId: "plan-start",
                  period: "one_time",
                  remainingUnits: 1_800_000,
                  totalUnits: 3_000_000,
                  unitType: "token",
                  capabilities: ["model:glm-5.3"],
                  expiresAt: Date.now() + 24 * 3600 * 1000,
                },
                {
                  name: "GLM-5.3-Flash",
                  planId: "plan-start",
                  period: "one_time",
                  remainingUnits: 900_000,
                  totalUnits: 5_000_000,
                  unitType: "token",
                  capabilities: ["model:glm-5.3-flash"],
                  expiresAt: Date.now() + 24 * 3600 * 1000,
                },
              ],
            }),
          }),
        ],
      }),
    );
    const detail = openDetail(harness);
    const card = detail?.querySelector(".plan-card");
    // 一个 plan → 一张卡，卡头一枚类型标签（体验套餐）。
    expect(detail?.querySelectorAll(".plan-card")).toHaveLength(1);
    expect(card?.querySelector(".plan-card__head .tag")?.textContent).toBe("体验套餐");
    // 模型桶按 show_name 拆行（GLM-5.3 / GLM-5.3-Flash 各一行），不再折叠成「支持 …」。
    const rows = card?.querySelectorAll(".plan-card__bucket") ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector(".plan-card__bucket-label")?.textContent).toBe("GLM-5.3");
    expect(rows[0]?.querySelector(".plan-card__bucket-amount")?.textContent).toBe("剩 180万/300万");
    expect(rows[1]?.querySelector(".plan-card__bucket-label")?.textContent).toBe("GLM-5.3-Flash");
    expect(rows[1]?.querySelector(".plan-card__bucket-amount")?.textContent).toBe("剩 90万/500万");
    // 每桶一条进度条，按各自剩余占比上色（60% → 绿、18% → 红）。
    expect(rows[0]?.querySelector(".meter__fill")?.className).toBe("meter__fill meter__fill--ok");
    expect(rows[1]?.querySelector(".meter__fill")?.className).toBe("meter__fill meter__fill--danger");
    expect(rows[1]?.querySelector(".meter__fill")?.getAttribute("style")).toContain("width: 18%");
  });

  it("grays an expired bucket row and drops its meter (过期桶)", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            planKinds: ["experience"],
            routes: ["start-plan"],
            quota: quota({
              plans: [{ planId: "plan-start", name: "ZCode Start Plan", status: "active", entitlements: [] }],
              balances: [
                {
                  name: "GLM-5.3",
                  planId: "plan-start",
                  period: "one_time",
                  remainingUnits: 1,
                  totalUnits: 2,
                  expiresAt: Date.now() + 3600 * 1000,
                },
                {
                  name: "WEEKEND GRANT",
                  planId: "plan-start",
                  period: "one_time",
                  remainingUnits: 0,
                  totalUnits: 5,
                  expiresAt: Date.now() - 1000,
                },
              ],
            }),
          }),
        ],
      }),
    );
    const detail = openDetail(harness);
    // 同一 plan 的活桶与过期桶同卡并列（分组键是 plan_id）：过期桶灰一行。
    const cards = detail?.querySelectorAll(".plan-card") ?? [];
    expect(cards).toHaveLength(1);
    expect(cards[0]?.querySelectorAll(".plan-card__bucket")).toHaveLength(2);
    const expired = detail?.querySelector(".plan-card__bucket--expired");
    expect(expired?.textContent).toContain("WEEKEND GRANT");
    // 过期不是健康态（二值化）：中性灰行，不用 danger 系。
    expect(expired?.className).not.toContain("danger");
    // 过期桶不画剩余进度条（余量已经不归它了）。
    expect(expired?.querySelector(".meter")).toBeNull();
  });

  it("hides the usage-window section for an account that serves no coding-plane route", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            routes: ["start-plan"],
            // 采集层对每个账号都打 monitor 端点：start-plan 白名单的账号也可能
            // 带回窗口（同凭据的 coding-plan 用量）。展示层按路由滤掉。
            quota: quota({ windows: [{ type: "TOKENS_LIMIT", percentage: 42 }] }),
          }),
        ],
      }),
    );
    const detail = openDetail(harness);
    const text = detail?.textContent ?? "";
    expect(text).not.toContain("用量窗口");
    expect(text).not.toContain("5 小时剩余");
    // 一张窗口卡都不画（不是画一张空卡）。
    expect(detail?.querySelector(".plan-card__window")).toBeNull();
  });

  it("names the four coding-plane windows from unit/number and fails open on the rest", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            routes: ["coding-plan", "start-plan"],
            quota: quota({
              windows: [
                { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 68 },
                { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 20 },
                { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 12 },
                { type: "MCP_USAGE_LIMIT", percentage: 5 },
                { type: "SOMETHING_ELSE", percentage: 5 },
              ],
            }),
          }),
        ],
      }),
    );
    const text = openDetail(harness)?.textContent ?? "";
    expect(text).toContain("用量窗口");
    // 官方四格的前三格：unit=3&number=5 → 5 小时剩余、unit=6 → 每周剩余、
    // TIME_LIMIT → 工具调用（zh-CN.ts 的同名文案）。
    expect(text).toContain("5 小时剩余");
    expect(text).toContain("每周剩余");
    expect(text).toContain("工具调用");
    // 第四格（ZCode MCP）在官方来自 entitlement 快照的独立字段，控制面协议没有；
    // 真出现 MCP_USAGE_LIMIT 时原样显示 type（fail-open），不编造人话名。
    expect(text).toContain("MCP_USAGE_LIMIT");
    expect(text).toContain("SOMETHING_ELSE");
  });

  it("falls back to the raw type when a token window carries no unit/number (fail-open)", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            quota: quota({ windows: [{ type: "TOKENS_LIMIT", percentage: 68 }] }),
          }),
        ],
      }),
    );
    const text = openDetail(harness)?.textContent ?? "";
    // 没有 unit/number 时分不清 5 小时窗与每周窗——不猜，原样显示 type。
    expect(text).toContain("TOKENS_LIMIT");
    expect(text).not.toContain("5 小时剩余");
    expect(text).not.toContain("每周剩余");
  });

  it("shows the derived-plane windows for off-peak / highspeed routes too (额度继承母体)", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({
            routes: ["start-plan", "off-peak"],
            quota: quota({ windows: [{ type: "TOKENS_LIMIT", percentage: 68 }] }),
          }),
        ],
      }),
    );
    expect(openDetail(harness)?.textContent).toContain("用量窗口");
  });
});

/* ------------------------------------------------------------------------- */
/* 统计行 / 状态筛选 / 搜索 / 复选框                                            */
/* ------------------------------------------------------------------------- */

describe("accounts page — stats, filters and search", () => {
  it("renders the four stat cards and the filter counts from the same bucket logic", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({ label: "ok-1", quota: quota({ windows: [{ type: "5h", percentage: 20 }] }) }),
          account({ label: "ok-2", quota: quota({ windows: [{ type: "5h", percentage: 60 }] }) }),
          account({ label: "cooling-1", health: "cooling", routeHealth: [{ route: "coding-plan", status: "cooling" }] }),
          account({ label: "drained-1", health: "drained", routeHealth: [{ route: "coding-plan", status: "drained" }] }),
          account({ label: "paused-1", enabled: false }),
        ],
      }),
    );
    // 总数 5；可用 2（启用的 ok）；异常 1（冷却）；额度耗尽 1；手动停用不进任何桶。
    expect(harness.role("accounts-stat-total")?.textContent).toBe("5");
    expect(harness.role("accounts-stat-available")?.textContent).toBe("2");
    expect(harness.role("accounts-stat-abnormal")?.textContent).toBe("1");
    // 额度占用 = 有采样账号的最紧窗口平均（20+60 除以 2 = 40%）。
    expect(harness.role("accounts-stat-quota")?.textContent).toBe("40%");
    expect(harness.role("accounts-filter-count-all")?.textContent).toBe("5");
    expect(harness.role("accounts-filter-count-available")?.textContent).toBe("2");
    expect(harness.role("accounts-filter-count-abnormal")?.textContent).toBe("1");
    expect(harness.role("accounts-filter-count-drained")?.textContent).toBe("1");
  });

  it("shows a dash for quota usage when no account has a sample", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account({ quota: null })] }));
    expect(harness.role("accounts-stat-quota")?.textContent).toBe("—");
  });

  it("filters the table by status tab without sending anything (client-side only)", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [
          account({ label: "ok-1" }),
          account({ label: "drained-1", health: "drained", routeHealth: [{ route: "coding-plan", status: "drained" }] }),
        ],
      }),
    );
    harness.click(harness.find('[data-account-filter="drained"]') as PageNode);
    await harness.settle();

    const rows = harness.rows("page-accounts-body");
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute("data-account")).toBe("drained-1");
    // 纯客户端过滤：不发命令。
    expect(commands(harness)).toHaveLength(0);

    harness.click(harness.find('[data-account-filter="all"]') as PageNode);
    await harness.settle();
    expect(harness.rows("page-accounts-body")).toHaveLength(2);
  });

  it("searches by label substring and by ID prefix", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [account({ label: "work-team", idPrefix: "abcd1234" }), account({ label: "payg", idPrefix: "ef012345" })],
      }),
    );
    // 名字包含匹配。
    harness.type(harness.role("accounts-search"), "team");
    await harness.settle();
    expect(harness.rows("page-accounts-body")).toHaveLength(1);
    expect(harness.rows("page-accounts-body")[0].getAttribute("data-account")).toBe("work-team");

    // ID 前缀匹配。
    harness.type(harness.role("accounts-search"), "EF01");
    await harness.settle();
    expect(harness.rows("page-accounts-body")).toHaveLength(1);
    expect(harness.rows("page-accounts-body")[0].getAttribute("data-account")).toBe("payg");

    // 非前缀的 ID 片段不命中。
    harness.type(harness.role("accounts-search"), "bcd1234");
    await harness.settle();
    expect(harness.rows("page-accounts-body")).toHaveLength(0);
    // 有账号但被滤空：轻量空态，不是引导注册的空态。
    expect(harness.role("page-accounts-nomatch")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("page-accounts-empty")?.hasAttribute("hidden")).toBe(true);
  });

  it("keeps the checkbox selection across re-renders (state in the module, not the DOM)", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({ accounts: [account(), account({ label: "payg" })] }),
    );
    const row = harness.rows("page-accounts-body")[0] as PageNode;
    const check = row.querySelector('[data-account-check]') as PageNode;
    // 委托监听需要冒泡的 change（浏览器原生 change 会冒泡；脚手架的 Event 默认不冒泡）。
    check.checked = true;
    check.dispatchEvent(new harness.win.Event("change", { bubbles: true }));
    await harness.refresh();

    const reRendered = harness.rows("page-accounts-body")[0] as PageNode;
    expect((reRendered.querySelector('[data-account-check]') as PageNode).checked).toBe(true);
    // 另一行不受影响。
    expect((harness.rows("page-accounts-body")[1].querySelector('[data-account-check]') as PageNode).checked).toBe(false);
  });

  it("selects and clears all visible rows with the header checkbox", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({ accounts: [account(), account({ label: "payg" })] }),
    );
    harness.change(harness.role("accounts-check-all"), "", true);
    await harness.settle();
    for (const row of harness.rows("page-accounts-body")) {
      expect((row.querySelector('[data-account-check]') as PageNode).checked).toBe(true);
    }

    harness.change(harness.role("accounts-check-all"), "", false);
    await harness.settle();
    for (const row of harness.rows("page-accounts-body")) {
      expect((row.querySelector('[data-account-check]') as PageNode).checked).toBe(false);
    }
  });

  it("opens and closes the row menu, and closes it on outside click and Esc", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account()] }));
    const row = harness.rows("page-accounts-body")[0] as PageNode;
    /* 行里现在有两个 `.menu`（⋯ 菜单与调度权重浮层），按 `data-row-menu` 取。*/
    const menu = row.querySelector("[data-row-menu] .menu") as PageNode;
    expect(menu.hasAttribute("hidden")).toBe(true);

    harness.click(menuButton(row));
    expect(menu.hasAttribute("hidden")).toBe(false);

    // 点外收起（点在表头上）。
    harness.click(harness.find('[data-role="page-accounts-table"] thead') as PageNode);
    expect(menu.hasAttribute("hidden")).toBe(true);

    harness.click(menuButton(row));
    harness.win.document.dispatchEvent(new harness.win.KeyboardEvent("keydown", { key: "Escape" }));
    expect(menu.hasAttribute("hidden")).toBe(true);
  });

  it("keeps the row menu to actions only (no read-only credential row)", async () => {
    /* 菜单的心智是「点一下会发生什么」：只剩启停、刷新额度与删除，凭据出身那行整块退场。 */
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account()] }));
    const row = harness.rows("page-accounts-body")[0] as PageNode;
    const menu = row.querySelector("[data-row-menu] .menu") as PageNode;
    expect(menu.querySelector("[class*='__field--readonly']")).toBeNull();
    expect(nodes(menu, ".menu__field")).toHaveLength(0);
    expect(nodes(menu, ".menu__item").map((item) => item.textContent)).toEqual(["暂停", "刷新额度", "删除"]);
  });

  it("keeps the menu open across a poll but rebuilt rows start closed", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account()] }));
    const row = harness.rows("page-accounts-body")[0] as PageNode;
    harness.click(menuButton(row));
    expect((row.querySelector("[data-row-menu] .menu") as PageNode).hasAttribute("hidden")).toBe(false);

    // 行重画后新行默认收起（开合状态不跨重画，与抽屉不同：菜单是一次性形态）。
    await harness.refresh();
    const rebuilt = harness.rows("page-accounts-body")[0] as PageNode;
    expect((rebuilt.querySelector("[data-row-menu] .menu") as PageNode).hasAttribute("hidden")).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */
/* 批量操作                                                                   */
/* ------------------------------------------------------------------------- */

describe("bulk actions", () => {
  /**
   * 勾选若干行。
   *
   * 走真实的 `change` 事件（选择状态住在视图模块里，不是 DOM）：每次勾选都会立即
   * 重画一次，所以每次重新按 label 找行。
   */
  function selectRows(harness: Harness, labels: string[]): void {
    for (const label of labels) {
      const row = harness.find(`tr[data-account="${label}"]`) as PageNode;
      const check = row.querySelector("[data-account-check]") as PageNode;
      check.checked = true;
      check.dispatchEvent(new harness.win.Event("change", { bubbles: true }));
    }
  }

  function bar(harness: Harness): PageNode {
    return harness.role("accounts-bulk") as PageNode;
  }

  function bulkButton(harness: Harness, name: string): PageNode {
    return harness.find(`[data-bulk="${name}"]`) as PageNode;
  }

  function threeAccounts(): StatePayload {
    return statePayload({
      accounts: [account({ label: "a0" }), account({ label: "a1" }), account({ label: "a2" })],
    });
  }

  it("keeps the bar hidden until something is selected, then shows the count", async () => {
    const harness = await mountSettled("/accounts", threeAccounts());
    expect(bar(harness).hasAttribute("hidden")).toBe(true);

    selectRows(harness, ["a0", "a2"]);
    await harness.settle();
    expect(bar(harness).hasAttribute("hidden")).toBe(false);
    expect(harness.role("accounts-bulk-count")?.textContent).toBe("已选 2 项");

    // 清空选择：条消失（不发任何命令）
    harness.click(bulkButton(harness, "clear"));
    await harness.settle();
    expect(bar(harness).hasAttribute("hidden")).toBe(true);
    expect(commands(harness)).toHaveLength(0);
  });

  it("drops the selection when the filter tab changes (看不见的行不该留在名单里)", async () => {
    const harness = await mountSettled("/accounts", threeAccounts());
    selectRows(harness, ["a0", "a1"]);
    expect(harness.role("accounts-bulk-count")?.textContent).toBe("已选 2 项");

    harness.click(harness.find('[data-account-filter="available"]') as PageNode);
    await harness.settle();

    expect(bar(harness).hasAttribute("hidden")).toBe(true);
    for (const row of harness.rows("page-accounts-body")) {
      expect((row.querySelector("[data-account-check]") as PageNode).checked).toBe(false);
    }
  });

  it("drops the selection when the search text changes", async () => {
    const harness = await mountSettled("/accounts", threeAccounts());
    selectRows(harness, ["a0"]);
    harness.type(harness.role("accounts-search"), "a1");
    await harness.settle();
    expect(bar(harness).hasAttribute("hidden")).toBe(true);
  });

  it("select-all fills the bar with every visible row", async () => {
    const harness = await mountSettled("/accounts", threeAccounts());
    harness.change(harness.role("accounts-check-all"), "", true);
    await harness.settle();
    expect(harness.role("accounts-bulk-count")?.textContent).toBe("已选 3 项");
  });

  it("disables the selection through the confirm modal and re-reads the state once", async () => {
    const harness = await mountSettled("/accounts", threeAccounts());
    selectRows(harness, ["a0", "a1"]);
    harness.click(bulkButton(harness, "disable"));

    // 停用是危险动作：先弹确认模态，此时命令还没发
    expect(harness.role("confirm-modal")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("confirm-title")?.textContent).toContain("停用 2 个账号");
    expect(commands(harness)).toHaveLength(0);

    harness.click(harness.role("confirm-submit"));
    await harness.settle();

    expect(commands(harness).map((call) => call.body)).toEqual([
      { cmd: "setAccountEnabled", label: "a0", enabled: false },
      { cmd: "setAccountEnabled", label: "a1", enabled: false },
    ]);
    /* 抖动实测结论：N 条命令只回读一次（不用 dispatch 的逐条回读），
       否则表格会重画 N 次。初始挂载 1 + 收尾 1 = 2。*/
    expect(harness.calls.filter((call) => call.url === "/api/state")).toHaveLength(2);
    // 结果反馈：成功 / 失败计数
    expect(harness.role("accounts-notice-text")?.textContent).toBe("成功 2 / 失败 0");
    // 跑完清空选择，条收起
    expect(bar(harness).hasAttribute("hidden")).toBe(true);
  });

  it("deletes only after the user types DELETE", async () => {
    const harness = await mountSettled("/accounts", threeAccounts());
    selectRows(harness, ["a0"]);
    harness.click(bulkButton(harness, "delete"));

    // 二次输入确认（词与明文导出的 EXPORT 分开）
    expect(harness.role("confirm-modal")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("confirm-token-label")?.textContent).toContain("DELETE");

    (harness.role("confirm-input") as PageNode).value = "delete";
    harness.click(harness.role("confirm-submit"));
    await harness.settle();
    expect(commands(harness)).toHaveLength(0);
    expect(harness.role("accounts-error-text")?.textContent).toBe("请输入 DELETE 以确认删除。");

    (harness.role("confirm-input") as PageNode).value = "DELETE";
    harness.click(harness.role("confirm-submit"));
    await harness.settle();
    // 批量删除不带 force：一律 drain
    expect(commands(harness).map((call) => call.body)).toEqual([{ cmd: "removeAccount", label: "a0", drain: true }]);
    expect(harness.role("accounts-notice-text")?.textContent).toBe("成功 1 / 失败 0");
  });

  it("sets concurrency, weight and proxy for the selection", async () => {
    const harness = await mountSettled("/accounts", threeAccounts(), { proxies: [proxyRow()] });
    selectRows(harness, ["a0", "a1"]);

    (harness.role("accounts-bulk-concurrency") as PageNode).value = "3";
    harness.click(bulkButton(harness, "concurrency"));
    await harness.settle();
    expect(commands(harness).map((call) => call.body)).toEqual([
      { cmd: "setAccountConcurrency", label: "a0", maxConcurrency: 3 },
      { cmd: "setAccountConcurrency", label: "a1", maxConcurrency: 3 },
    ]);

    // 跑完会清空选择：重新勾一次再测下一个动作
    selectRows(harness, ["a0", "a1"]);
    const before = commands(harness).length;
    (harness.role("accounts-bulk-weight") as PageNode).value = "4";
    harness.click(bulkButton(harness, "weight"));
    await harness.settle();
    expect(commands(harness).slice(before).map((call) => call.body)).toEqual([
      { cmd: "setAccountWeight", label: "a0", weight: 4 },
      { cmd: "setAccountWeight", label: "a1", weight: 4 },
    ]);

    selectRows(harness, ["a0", "a1"]);
    const beforeProxy = commands(harness).length;
    harness.change(harness.role("accounts-bulk-proxy"), "home");
    harness.click(bulkButton(harness, "proxy"));
    await harness.settle();
    expect(commands(harness).slice(beforeProxy).map((call) => call.body)).toEqual([
      { cmd: "setAccountProxy", label: "a0", proxy: "home" },
      { cmd: "setAccountProxy", label: "a1", proxy: "home" },
    ]);
  });

  it("refuses an out-of-range concurrency or weight without sending anything", async () => {
    const harness = await mountSettled("/accounts", threeAccounts());
    selectRows(harness, ["a0"]);

    (harness.role("accounts-bulk-concurrency") as PageNode).value = "-1";
    harness.click(bulkButton(harness, "concurrency"));
    await harness.settle();
    expect(commands(harness)).toHaveLength(0);
    expect(harness.role("accounts-error-text")?.textContent).toContain("并发不能为负");

    (harness.role("accounts-bulk-weight") as PageNode).value = "0";
    harness.click(bulkButton(harness, "weight"));
    await harness.settle();
    expect(commands(harness)).toHaveLength(0);
    expect(harness.role("accounts-error-text")?.textContent).toContain("权重至少为");
  });

  it("reports a per-batch success/failure split with a reason summary", async () => {
    const harness = await mountSettled("/accounts", threeAccounts());
    harness.controlReplies = [{ ok: true }, { ok: false, error: "account_not_found" }];
    selectRows(harness, ["a0", "a1"]);
    harness.click(bulkButton(harness, "enable"));
    await harness.settle();

    expect(harness.role("accounts-notice-text")?.textContent).toBe(
      "成功 1 / 失败 1：找不到这个账号。",
    );
  });

  it("shows the failure banner when the whole batch fails", async () => {
    const harness = await mountSettled("/accounts", threeAccounts());
    harness.controlReply = { ok: false, error: "account_not_found" };
    selectRows(harness, ["a0", "a1"]);
    harness.click(bulkButton(harness, "enable"));
    await harness.settle();

    expect(harness.role("accounts-error")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("accounts-error-text")?.textContent).toBe("成功 0 / 失败 2：找不到这个账号。");
  });

  it("equalizes only the selected accounts from the bar", async () => {
    const harness = await mountSettled("/accounts", threeAccounts());
    harness.state = statePayload({
      accounts: [
        account({ label: "a0", weight: 2 }),
        account({ label: "a1", weight: 2 }),
        account({ label: "a2", weight: 4 }),
      ],
    });
    await harness.refresh();
    selectRows(harness, ["a2"]);

    harness.click(bulkButton(harness, "weight-even"));
    await harness.settle();
    /* 只有一个选中账号时它已经是「均分」状态：一条命令都不发。 */
    expect(commands(harness)).toHaveLength(0);
    expect(harness.role("accounts-notice-text")?.textContent).toBe("已经是均分，无需改动。");
  });
});

describe("accounts page — ?focus=<label>", () => {
  it("highlights the row named in the address", async () => {
    const harness = await mountSettled(
      "/accounts?focus=home",
      statePayload({ accounts: [account(), account({ label: "home" })] }),
    );
    const rows = nodes(harness.role("page-accounts-body"), "tr[data-account]");

    expect(rows[1]?.getAttribute("data-account")).toBe("home");
    expect(rows[1]?.className).toContain("row--focus");
    expect(rows[0]?.className).not.toContain("row--focus");
  });

  it("drops the highlight after two seconds and never brings it back", async () => {
    const harness = await mountSettled(
      "/accounts?focus=home",
      statePayload({ accounts: [account(), account({ label: "home" })] }),
    );
    const before = nodes(harness.role("page-accounts-body"), "tr[data-account]");
    expect(before[1]?.className).toContain("row--focus");

    /* 两秒后自己摘掉；之后再轮询一次也不该重新加回来（否则等于永久高亮）。 */
    await waitFor(
      () => nodes(harness.role("page-accounts-body"), "tr[data-account]")[1]?.className.includes("row--focus") === false,
      "focus highlight drops after its TTL",
      5_000,
    );
    const after = nodes(harness.role("page-accounts-body"), "tr[data-account]");
    expect(after[1]?.className).not.toContain("row--focus");

    harness.state = statePayload({ accounts: [account(), account({ label: "home" })] });
    await harness.refresh();
    const polled = nodes(harness.role("page-accounts-body"), "tr[data-account]");
    expect(polled[1]?.className).not.toContain("row--focus");
  });

  it("does nothing when the label is gone (the overview snapshot may be one poll old)", async () => {
    const harness = await mountSettled(
      "/accounts?focus=gone",
      statePayload({ accounts: [account()] }),
    );
    const rows = nodes(harness.role("page-accounts-body"), "tr[data-account]");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.className).not.toContain("row--focus");
    /* 找不到行不报错：页面上不该因为一条过期链接多出一条红条。 */
    expect(harness.role("accounts-error")?.hasAttribute("hidden")).toBe(true);
  });
});

describe("accounts page — proxy column", () => {
  it("offers direct plus every known proxy name, and shows the effective one", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account({ proxy: "office" })] }), {
      proxies: [proxyRow(), proxyRow({ name: "office" })],
    });

    const select = cell(harness.rows("page-accounts-body")[0], 7)?.querySelector("select");
    const labels = nodes(select, "option").map((option) => option.textContent);
    expect(labels).toEqual(["直连", "home", "office"]);
    expect(select?.value).toBe("office");
  });

  it("sends setAccountProxy when the selection changes", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account({ proxy: "home" })] }), {
      proxies: [proxyRow()],
    });

    harness.change(cell(harness.rows("page-accounts-body")[0], 7)?.querySelector("select") ?? null, "direct");
    await harness.settle();
    expect(commands(harness).at(-1)?.body).toEqual({ cmd: "setAccountProxy", label: "work-team", proxy: "direct" });
  });
});

/* ------------------------------------------------------------------------- */
/* 能力对齐 / auth-invalid / 健康状态变化观测                                   */
/* ------------------------------------------------------------------------- */

describe("account observation", () => {
  it("marks auth-invalid accounts red with the re-import guidance", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [account({
          health: "auth-invalid",
          routeHealth: [{ route: "coding-plan", status: "auth-invalid", reason: "auth-failed" }],
        })],
      }),
    );
    const status = cell(harness.rows("page-accounts-body")[0], 3);
    expect(status?.textContent).toBe("凭据失效");
    expect(status?.querySelector("span")?.className).toBe("status-badge status-badge--danger");
    const detail = openDetail(harness);
    expect(detail?.textContent).toContain("凭据失效");
    expect(detail?.textContent).toContain("重新登录或导入凭据");
    harness.close();
  });

  it("shows blocked routes and their reason in the account dialog", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [account({
          capabilityBlocks: [{ route: "coding-plan", reason: "no-subscription" }],
        })],
      }),
    );
    const detail = openDetail(harness);
    expect(detail?.textContent).toContain("套餐能力对齐");
    expect(detail?.textContent).toContain("coding-plan 已屏蔽");
    expect(detail?.textContent).toContain("账号没有订阅套餐");
    harness.close();
  });

  it("renders health transition events with reason/until and hides nothing when absent", async () => {
    const at = Date.now();
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [account()],
        health: {
          cursor: 2,
          breakers: [],
          events: [
            { seq: 1, type: "cooling-enter", route: "coding-plan", reason: "rate-limited", at, until: at + 60_000 },
            { seq: 0, type: "auth-invalid-enter", route: "start-plan", reason: "auth-failed", at: at - 1_000 },
          ],
        },
      }),
    );
    const detail = openDetail(harness);
    expect(detail?.textContent).toContain("健康状态变化");
    expect(detail?.textContent).toContain("进入冷却");
    expect(detail?.textContent).toContain("rate-limited");
    expect(detail?.textContent).toContain("凭据失效");
    harness.close();
  });
});
