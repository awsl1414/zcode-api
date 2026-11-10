/**
 * 路由策略页与代理页（策略读写往返 / 矩阵派生 / 代理列与默认出口）。
 *
 * 脚手架见 `runtime-harness.ts`。
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountsRouting, AccountsStickiness } from "../../accounts/routing.js";
import { DEFAULT_ACCOUNTS_ROUTING, DEFAULT_ACCOUNTS_STICKINESS } from "../../accounts/routing.js";
import {
  installHarnessHooks,
  account,
  cell,
  commands,
  controlBodies,
  mountSettled,
  nodes,
  proxyRow,
  statePayload,
} from "./runtime-harness.js";
import type { PageNode } from "./runtime-harness.js";

installHarnessHooks();

/* ------------------------------------------------------------------------- */
/* 路由策略页                                                                  */
/* ------------------------------------------------------------------------- */

describe("routing policy page", () => {
  function routingState(overrides: Partial<AccountsRouting> = {}, stickiness: Partial<AccountsStickiness> = {}) {
    return statePayload({
      routing: { ...DEFAULT_ACCOUNTS_ROUTING, order: [...DEFAULT_ACCOUNTS_ROUTING.order], ...overrides },
      stickiness: { ...DEFAULT_ACCOUNTS_STICKINESS, ...stickiness },
    });
  }

  it("renders the order list and back-fills every control from the policy", async () => {
    const harness = await mountSettled("/routing", routingState());

    const items = nodes(harness.role("routing-order"), "li");
    expect(items.map((item) => item.querySelector(".order-item__name")?.textContent)).toEqual([
      "start-plan",
      "coding-plan",
    ]);
    expect(harness.role("routing-mode")?.value).toBe("prefer");
    expect(harness.role("routing-strategy")?.value).toBe("sticky-hash");
    expect(harness.role("routing-saturated")?.value).toBe("wait");
    expect(harness.role("routing-drained")?.value).toBe("fallback");
    expect(harness.role("routing-authfailed")?.value).toBe("rotate");
    expect(harness.role("routing-queueTimeoutMs")?.value).toBe("30000");
    expect(harness.role("routing-maxQueue")?.value).toBe("64");
    expect(harness.role("routing-maxTotalInflight")?.value).toBe("8");
    expect(harness.role("stickiness-ttlSeconds")?.value).toBe("1800");
    expect(harness.role("stickiness-maxSessions")?.value).toBe("4096");
    expect(harness.role("stickiness-overflowAfterMs")?.value).toBe("5000");
    expect(harness.role("stickiness-enabled")?.checked).toBe(true);
  });

  it("round-trips a select change through setRoutingPolicy", async () => {
    const harness = await mountSettled("/routing", routingState());
    harness.change(harness.role("routing-mode"), "only");
    await harness.settle();

    expect(commands(harness)[0]?.body).toEqual({ cmd: "setRoutingPolicy", routing: { mode: "only" } });
    // 成功后刷新一次：页面显示的是服务端回读的值
    harness.state = routingState({ mode: "only" });
    await harness.refresh();
    expect(harness.role("routing-mode")?.value).toBe("only");
  });

  it("round-trips a stickiness change through setRoutingPolicy", async () => {
    const harness = await mountSettled("/routing", routingState());
    harness.change(harness.role("stickiness-enabled"), "", false);
    await harness.settle();
    expect(commands(harness)[0]?.body).toEqual({ cmd: "setRoutingPolicy", stickiness: { enabled: false } });

    harness.change(harness.role("stickiness-ttlSeconds"), "600");
    await harness.settle();
    expect(commands(harness)[1]?.body).toEqual({ cmd: "setRoutingPolicy", stickiness: { ttlSeconds: 600 } });
  });

  it("round-trips the risk switch through setRoutingPolicy", async () => {
    const harness = await mountSettled("/routing", routingState());
    // 默认值来自 accounts.risk.jitterHeartbeat（默认 true）
    expect(harness.role("risk-jitterHeartbeat")?.checked).toBe(true);

    harness.change(harness.role("risk-jitterHeartbeat"), "", false);
    await harness.settle();
    expect(commands(harness)[0]?.body).toEqual({ cmd: "setRoutingPolicy", risk: { jitterHeartbeat: false } });

    // 回读后开关反映服务端的值
    harness.state = statePayload({
      routing: { ...DEFAULT_ACCOUNTS_ROUTING, order: [...DEFAULT_ACCOUNTS_ROUTING.order] },
      stickiness: { ...DEFAULT_ACCOUNTS_STICKINESS },
      risk: { alerts: [], policy: { jitterHeartbeat: false } },
    });
    await harness.refresh();
    expect(harness.role("risk-jitterHeartbeat")?.checked).toBe(false);
  });

  it("rejects a non-numeric queue parameter instead of sending it", async () => {
    const harness = await mountSettled("/routing", routingState());
    harness.change(harness.role("routing-maxQueue"), "-5");
    await harness.settle();

    expect(commands(harness)).toHaveLength(0);
    expect(harness.role("routing-error-text")?.textContent).toContain("队列深度");
  });

  it("moves an order entry up and down, stopping at the boundaries", async () => {
    const harness = await mountSettled("/routing", routingState());
    const items = nodes(harness.role("routing-order"), "li");
    const buttons = nodes(items[0], "button");

    // 第一项「上移」在边界上：不发命令
    harness.click(buttons[0] as PageNode);
    await harness.settle();
    expect(commands(harness)).toHaveLength(0);

    // 第一项「下移」把 start-plan 与 coding-plan 对调
    harness.click(buttons[1] as PageNode);
    await harness.settle();
    expect(commands(harness)[0]?.body).toEqual({
      cmd: "setRoutingPolicy",
      routing: { order: ["coding-plan", "start-plan"] },
    });
  });

  it("badges the first entry as priority with the accent status-badge", async () => {
    const harness = await mountSettled("/routing", routingState());
    const items = nodes(harness.role("routing-order"), "li");
    const badges = nodes(items[0], ".status-badge").concat(nodes(items[1], ".status-badge"));
    expect(badges[0]?.className).toBe("status-badge status-badge--accent");
    expect(badges[0]?.textContent).toBe("优先");
    expect(badges[1]?.className).toBe("status-badge");
    expect(badges[1]?.textContent).toBe("兜底");
  });

  it("groups the order actions in one tight cluster after the badge (紧凑排布)", async () => {
    const harness = await mountSettled("/routing", routingState());
    const items = nodes(harness.role("routing-order"), "li");
    const actions = nodes(items[0], ".order-item__actions");
    // 一行一个按钮组，组内三颗按钮（上移 / 下移 / 移除），不再逐颗拍在行上。
    expect(actions).toHaveLength(1);
    expect(nodes(actions[0], "button")).toHaveLength(3);
    // 徽章留在按钮组之前（序号 + 路由名 + 徽章一组，按钮组靠右）；happy-dom 不支持
    // 相邻兄弟选择器，这里按 DOM 序断言（徽章下标 2，按钮组下标 3）。
    const children = (items[0] as PageNode).querySelectorAll(":scope > *") ?? [];
    expect(children[2]?.className).toContain("status-badge");
    expect(children[3]?.className).toBe("order-item__actions");
  });

  it("removes an order entry with the remove button (a shorter order is a valid patch)", async () => {
    const harness = await mountSettled("/routing", routingState());
    const items = nodes(harness.role("routing-order"), "li");
    // 第三颗按钮是移除（上移 / 下移之后）。
    harness.click(nodes(items[1], "button")[2] as PageNode);
    await harness.settle();
    expect(commands(harness)[0]?.body).toEqual({ cmd: "setRoutingPolicy", routing: { order: ["start-plan"] } });
  });

  it("disables 移除 when only one order entry is left (与权重步进器同一条判据)", async () => {
    const harness = await mountSettled("/routing", routingState());
    harness.state = routingState();
    harness.state.routing.order = ["start-plan"];
    await harness.refresh();

    /* 只剩一条时「移除」直接禁用，并把原因写在 tooltip 上——点得动、点了才报错
       会让用户用一次失败学习一条静态规则。 */
    const remove = nodes(nodes(harness.role("routing-order"), "li")[0], "button")[2] as PageNode;
    expect(remove.disabled).toBe(true);
    expect(remove.title).toBe("至少保留一条路由。");
    /* 禁用态下点击不发命令、也不弹错误横幅（守卫仍在，只是走不到了）。 */
    harness.click(remove);
    await harness.settle();
    expect(commands(harness)).toHaveLength(0);
  });

  it("keeps 移除 clickable while the order still has more than one entry", async () => {
    const harness = await mountSettled("/routing", routingState());
    const remove = nodes(nodes(harness.role("routing-order"), "li")[0], "button")[2] as PageNode;
    expect(remove.disabled).toBe(false);
  });

  it("summarizes queue / stickiness / risk in the collapse heads from current form values", async () => {
    const harness = await mountSettled("/routing", routingState());
    expect(harness.role("routing-queue-summary")?.textContent).toBe("等待上限 30000 · 队列深度 64 · 全局并发上限 8");
    expect(harness.role("routing-stickiness-summary")?.textContent).toBe("TTL 1800 · 会话上限 4096 · 饱和时 等待");
    expect(harness.role("routing-risk-summary")?.textContent).toBe("心跳抖动：开启");

    // 摘要跟表单值联动：改队列深度后立即更新（不等下一拍轮询）。
    harness.change(harness.role("routing-maxQueue"), "32");
    expect(harness.role("routing-queue-summary")?.textContent).toContain("队列深度 32");

    // 粘性停用时摘要打头标注。
    harness.change(harness.role("stickiness-enabled"), "", false);
    expect(harness.role("routing-stickiness-summary")?.textContent).toContain("已停用");

    // 风控开关关掉后摘要变「关闭」。
    harness.change(harness.role("risk-jitterHeartbeat"), "", false);
    expect(harness.role("routing-risk-summary")?.textContent).toBe("心跳抖动：关闭");
  });

  it("keeps collapse state across polls (验收硬项：App.widgets.apply 投影)", async () => {
    const harness = await mountSettled("/routing", routingState());
    const body = harness.find('[data-collapse="routing-queue"] .collapse__body');
    expect(body?.hasAttribute("hidden")).toBe(false);

    harness.click(harness.find('[data-collapse="routing-queue"] [data-collapse-toggle]') as PageNode);
    expect(body?.hasAttribute("hidden")).toBe(true);

    await harness.refresh();
    // 轮询重渲染后折叠状态保持（状态在 widgets 的模块级 Map，不在 DOM 属性里）。
    expect(harness.find('[data-collapse="routing-queue"] .collapse__body')?.hasAttribute("hidden")).toBe(true);
  });

  it("derives the route columns from the accounts' routes and the type column from their summaries", async () => {
    const harness = await mountSettled("/routing", routingState());
    harness.state = routingState();
    harness.state.accounts = [
      account({ label: "work-team", provider: "zai", routes: ["coding-plan", "off-peak"] }),
      account({ label: "personal", provider: "bigmodel", routes: ["start-plan"] }),
    ];
    await harness.refresh();

    const head = nodes(harness.role("routing-matrix-head"), "th");
    // 前两条是账号身份（账号名 + 账号类型），其余是路由列（order ∪ 账号路由，按 ROUTE_KINDS 顺序）
    expect(head.map((cell_) => cell_.textContent)).toEqual([
      "账号",
      "账号类型",
      "coding-plan",
      "start-plan",
      "off-peak",
    ]);

    const rows = nodes(harness.role("routing-matrix-body"), "tr");
    expect(rows).toHaveLength(2);
    expect(nodes(rows[0], "td").map((matrixCell) => matrixCell.textContent)).toEqual([
      "work-team",
      "Z.AI套餐账号",
      "✓",
      "—",
      "✓",
    ]);
    expect(nodes(rows[1], "td").map((matrixCell) => matrixCell.textContent)).toEqual([
      "personal",
      "BigModel套餐账号",
      "—",
      "✓",
      "—",
    ]);
    // 类型词与 AccountSummary.provider 逐行对应，凭据出身只是小字补充。
    expect(nodes(rows[0], "td.matrix__type .tag")[0]?.textContent).toBe("Z.AI");
    expect(nodes(rows[1], "td.matrix__type .tag")[0]?.textContent).toBe("BigModel");
    expect(nodes(rows[0], "td.matrix__type .matrix__kind")[0]?.textContent).toBe("套餐账号");
    expect(nodes(rows[1], "td.matrix__type .matrix__kind")[0]?.textContent).toBe("套餐账号");
    // 表头与 ✓/— 共用同一组路由列类，供全表左对齐与列宽规则定位。
    expect(nodes(harness.role("routing-matrix-head"), "th.matrix__route-head")).toHaveLength(3);
    /* 矩阵每拍重建，动态表头也要带 scope，读屏才知道列归属（静态表由 X2 补齐）。 */
    var heads = nodes(harness.role("routing-matrix-head"), "th");
    expect(heads.length).toBeGreaterThan(0);
    for (var h = 0; h < heads.length; h++) expect(heads[h]?.getAttribute("scope")).toBe("col");
    expect(nodes(rows[0], "td.matrix__route")).toHaveLength(3);
    expect(nodes(rows[1], "td.matrix__route")).toHaveLength(3);
    // 矩阵是只读的：不含任何控件
    expect(nodes(harness.role("routing-matrix"), "button, input, select")).toHaveLength(0);
  });

  it("keeps the type column words in both languages", () => {
    const zh = JSON.parse(readFileSync(join(import.meta.dir, "i18n", "zh.json"), "utf8")) as Record<string, string>;
    const en = JSON.parse(readFileSync(join(import.meta.dir, "i18n", "en.json"), "utf8")) as Record<string, string>;
    const keys = ["routing.matrix.type", "routing.matrix.provider.zai", "routing.matrix.provider.bigmodel"];
    for (const key of keys) {
      expect([key, typeof zh[key] === "string" && typeof en[key] === "string"]).toEqual([key, true]);
    }
    // 运行时拼出来的 `routing.matrix.provider.*` 键两语言都齐。
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it("shows an empty matrix state when there is no account", async () => {
    const harness = await mountSettled("/routing", routingState());
    expect(harness.role("routing-matrix-empty")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("routing-matrix")?.hasAttribute("hidden")).toBe(true);
  });

  it("puts a next step inside the empty matrix, not just a sentence", async () => {
    const harness = await mountSettled("/routing", routingState());
    const action = harness.find('[data-role="routing-matrix-empty-action"]');
    /* 空态是一句话 + 一颗去账号页的链接：同一句「还没有账号」在这里是第三次
       出现，前两次（账号页 / 概览）都给了入口。文案来自
       `ui.empty.routingMatrix.action`，从字典读，不把中文抄进测试。 */
    const label = (harness.win as unknown as { __zcodeApp: { i18n: { t(key: string): string } } }).__zcodeApp.i18n.t(
      "ui.empty.routingMatrix.action",
    );
    expect(action?.textContent).toBe(label);
    expect(action?.getAttribute("href")).toBe("/accounts");
    /* 有账号时整块空态收起，链接跟着一起退场。 */
    harness.state = routingState();
    harness.state.accounts = [account()];
    await harness.refresh();
    expect(harness.role("routing-matrix-empty")?.hasAttribute("hidden")).toBe(true);
  });
});

describe("proxy dictionary drawer", () => {
  /**
   * 打开账号页并展开出口代理抽屉。
   *
   * 代理没有独立视图：字典表挂在账号页页头的「出口代理」按钮后面。
   * 每次进页面这一拍都先发一次 `listProxies`（账号页的代理列要用），开抽屉再发一次；
   * 用例只关心抽屉里的表，所以挂载完直接点那颗按钮。
   */
  async function openDrawer(state: ReturnType<typeof statePayload>, options: Parameters<typeof mountSettled>[2] = {}) {
    const harness = await mountSettled("/accounts", state, options);
    harness.click(harness.find('[data-action="accounts-open-proxies"]'));
    await harness.settle();
    return harness;
  }

  it("renders one row per proxy with the five columns", async () => {
    const harness = await openDrawer(statePayload(), {
      proxies: [proxyRow({ usedBy: 2 }), proxyRow({ name: "office", enabled: false })],
    });

    const rows = harness.rows("proxies-body");
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(nodes(row, "td")).toHaveLength(5);
    expect(cell(rows[0], 0)?.textContent).toContain("home");
    expect(cell(rows[0], 1)?.textContent).toContain("http://127.0.0.1:7890");
    expect(cell(rows[0], 2)?.textContent).toBe("启用");
    expect(cell(rows[0], 3)?.textContent).toBe("2 个账号");
    expect(cell(rows[1], 2)?.textContent).toBe("停用");
    expect(cell(rows[1], 3)?.textContent).toBe("无");
    harness.close();
  });

  it("marks the default exit and never echoes a password", async () => {
    const harness = await openDrawer(statePayload(), {
      proxies: [proxyRow({ name: "office", url: "socks5://user:***@10.0.0.5:1080", hasPassword: true })],
      defaultProxy: "office",
    });

    const row = harness.rows("proxies-body")[0];
    expect(cell(row, 0)?.textContent).toContain("默认");
    expect(cell(row, 1)?.textContent).toContain("***");
    expect(cell(row, 1)?.textContent).toContain("已设密码");
    harness.close();
  });

  it("sends addProxy with the name and url from the modal", async () => {
    const harness = await openDrawer(statePayload());
    harness.click(harness.find('[data-action="proxies-open-add"]'));
    harness.type(harness.role("proxies-name"), "backup");
    harness.type(harness.role("proxies-url"), "http://127.0.0.1:7891");

    harness.controlReply = { ok: true, event: "proxies", proxies: [proxyRow({ name: "backup" })] };
    harness.click(harness.find('[data-action="proxies-submit"]'));
    await harness.settle();

    expect(controlBodies(harness)).toContainEqual({
      cmd: "addProxy",
      name: "backup",
      url: "http://127.0.0.1:7891",
    });
    expect(harness.rows("proxies-body")).toHaveLength(1);
    // 弹窗提交成功后关掉；抽屉仍然开着（管理动作就地完成，不把人踢出去）
    expect(harness.role("proxies-modal")?.hasAttribute("hidden")).toBe(true);
    expect(harness.find('[data-dialog="proxies"]')?.hasAttribute("hidden")).toBe(false);
    harness.close();
  });

  it("puts the actions column on the shared 160px width with 28px buttons", async () => {
    const harness = await openDrawer(statePayload(), { proxies: [proxyRow()] });
    const actions = cell(harness.rows("proxies-body")[0], 4) as PageNode;

    /* 三张表的操作列同宽（`--layout-actions-col`），行内按钮走 `btn--sm`（28px）。
       之前代理页的三个按钮是页面级的 36px `btn`，与 keys 页的行内档差一档。 */
    expect(actions.className).toContain("col-actions");
    const buttons = nodes(actions, "button");
    expect(buttons).toHaveLength(3);
    for (const item of buttons) {
      /* `.btn--sm` 是 `.btn` 的修饰符（高度 28px + `min-width: 0`），不是另一个类族。 */
      expect(item.className).toBe("btn btn--sm");
    }
    harness.close();
  });

  it("asks before disabling a proxy an account still egresses through", async () => {
    const harness = await openDrawer(statePayload({ accounts: [account({ label: "work-team", proxy: "home" })] }), {
      proxies: [proxyRow({ usedBy: 1 })],
    });

    /* 只数写命令：`getUsageStats` 是概览的只读报表，账号页不加载它；共用的夹具也会
       应答这个命令，数「已经发出去了」时得把它排除。 */
    const writes = () => commands(harness).filter((call) => (call.body as { cmd?: string } | null)?.cmd !== "getUsageStats");

    harness.click(nodes(cell(harness.rows("proxies-body")[0], 4), "button")[1] as PageNode);
    await harness.settle();
    // 确认文案里点名受影响的账号，且此时一条写命令都还没发
    expect(harness.role("confirm-text")?.textContent).toContain("work-team");
    expect(writes()).toHaveLength(0);

    harness.click(harness.role("confirm-submit"));
    await harness.settle();
    expect(writes().at(-1)?.body).toEqual({ cmd: "setProxy", name: "home", enabled: false });
    harness.close();
  });

  it("deletes with force once confirmed, and reports the detached accounts", async () => {
    const harness = await openDrawer(statePayload({ accounts: [account({ label: "work-team", proxy: "home" })] }), {
      proxies: [proxyRow({ usedBy: 1 })],
    });

    harness.controlReply = { ok: true, event: "proxies", proxies: [], detached: ["work-team"] };
    harness.click(nodes(cell(harness.rows("proxies-body")[0], 4), "button")[2] as PageNode);
    await harness.settle();
    harness.click(harness.role("confirm-submit"));
    await harness.settle();

    expect(commands(harness).at(-1)?.body).toEqual({ cmd: "removeProxy", name: "home", force: true });
    expect(harness.role("proxies-notice-text")?.textContent).toContain("work-team");
    harness.close();
  });

  it("stacks the add/edit form above the drawer and unwinds one layer per Esc (#111)", async () => {
    /* 抽屉必须排在弹窗之后（它压在账号表的那一层），所以「谁盖谁」不能靠文档序：
       抽屉的层级比弹窗低一档（`--layer-drawer` / `--layer-modal`）。Esc 则按打开的
       先后倒着退——先关刚开出来的弹窗，再按一次才关抽屉。 */
    const harness = await openDrawer(statePayload(), { proxies: [proxyRow()] });
    const drawer = harness.find('[data-dialog="proxies"]');
    const form = harness.role("proxies-modal");
    expect(drawer?.hasAttribute("hidden")).toBe(false);
    expect(form?.hasAttribute("hidden")).toBe(true);

    harness.click(harness.find('[data-action="proxies-open-add"]'));
    await harness.settle();
    expect(form?.hasAttribute("hidden")).toBe(false);
    /* 弹窗自己也是 dialog 的一层：Esc 退层要认得出它，不然会先关掉抽屉、把弹窗
       孤零零地留在遮罩上。 */
    expect(form?.getAttribute("data-dialog")).toBe("proxies-form");

    harness.win.document.dispatchEvent(new harness.win.KeyboardEvent("keydown", { key: "Escape" }));
    expect(form?.hasAttribute("hidden")).toBe(true);
    expect(drawer?.hasAttribute("hidden")).toBe(false);

    harness.win.document.dispatchEvent(new harness.win.KeyboardEvent("keydown", { key: "Escape" }));
    expect(drawer?.hasAttribute("hidden")).toBe(true);
    harness.close();
  });

  it("opens the drawer on ?proxies=1 and re-reads the dictionary once", async () => {
    /* 概览的共享出口告警只给到账号页 + `?proxies=1`（代理没有自己的路径）。 */
    const harness = await mountSettled("/accounts?proxies=1", statePayload(), { proxies: [proxyRow()] });

    expect(harness.find('[data-dialog="proxies"]')?.hasAttribute("hidden")).toBe(false);
    expect(harness.rows("proxies-body")).toHaveLength(1);
    /* 进页面的那次首取与打开抽屉的那次合并成一条（`load` 用 `pending` 收并发），
       所以整页只发一次 `listProxies`——重画与重开都不重发。 */
    const reads = () =>
      controlBodies(harness).filter((body) => (body as { cmd?: string } | null)?.cmd === "listProxies").length;
    expect(reads()).toBe(1);
    harness.close();
  });

  it("closes from the X and leaves the accounts column already showing the new dictionary", async () => {
    const harness = await openDrawer(statePayload({ accounts: [account({ proxy: "home" })] }), {
      proxies: [proxyRow()],
    });
    const proxyOptions = () =>
      nodes(cell(harness.rows("page-accounts-body")[0], 7)?.querySelector("select"), "option").map(
        (option) => option.textContent,
      );
    expect(proxyOptions()).toEqual(["直连", "home"]);

    /* 抽屉里加一条：写命令的应答带回整张新表，`adopt` 直接把账号表的代理列也重画了
       （账号表读的是同一份缓存），所以关掉抽屉之后不需要再补一次 `listProxies`。 */
    harness.click(harness.find('[data-action="proxies-open-add"]'));
    harness.type(harness.role("proxies-name"), "office");
    harness.type(harness.role("proxies-url"), "http://127.0.0.1:7892");
    const readsBefore = controlBodies(harness).filter(
      (body) => (body as { cmd?: string } | null)?.cmd === "listProxies",
    ).length;
    harness.controlReply = { ok: true, event: "proxies", proxies: [proxyRow(), proxyRow({ name: "office" })] };
    harness.click(harness.find('[data-action="proxies-submit"]'));
    await harness.settle();
    expect(proxyOptions()).toEqual(["直连", "home", "office"]);

    harness.click(harness.find('.modal__close[data-dialog-close="proxies"]'));
    await harness.settle();
    expect(harness.find('[data-dialog="proxies"]')?.hasAttribute("hidden")).toBe(true);
    expect(harness.find('[data-dialog-scrim="proxies"]')?.hasAttribute("hidden")).toBe(true);
    // 关闭这一步没有再读字典：整页的 `listProxies` 条数没变，账号列也还是新值。
    expect(
      controlBodies(harness).filter((body) => (body as { cmd?: string } | null)?.cmd === "listProxies").length,
    ).toBe(readsBefore);
    expect(proxyOptions()).toEqual(["直连", "home", "office"]);
    harness.close();
  });
});

/* ------------------------------------------------------------------------- */
/* 路由熔断指示                                                                */
/* ------------------------------------------------------------------------- */

describe("route breaker observation", () => {
  it("keeps the breaker panel hidden when no route is broken", async () => {
    const harness = await mountSettled("/routing", statePayload({ health: { cursor: 0, events: [], breakers: [] } }));
    expect(harness.role("routing-breaker-panel")?.hasAttribute("hidden")).toBe(true);
    harness.close();
  });

  it("shows the breaker status and probe backoff level from /api/state", async () => {
    const harness = await mountSettled(
      "/routing",
      statePayload({
        health: {
          cursor: 3,
          events: [],
          breakers: [{
            route: "start-plan",
            status: "endpoint-broken",
            openedAt: Date.now(),
            probeBackoffs: 2,
            lastEventSeq: 2,
          }],
        },
      }),
    );
    const panel = harness.role("routing-breaker-panel");
    expect(panel?.hasAttribute("hidden")).toBe(false);
    expect(panel?.textContent).toContain("start-plan");
    expect(panel?.textContent).toContain("端点被拒");
    expect(panel?.textContent).toContain("探针退避 2 档");
    harness.close();
  });
});
