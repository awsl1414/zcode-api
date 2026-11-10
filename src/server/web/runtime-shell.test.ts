/**
 * 外壳：侧边栏、顶栏（主题按钮 / 刷新派发与快捷键 / 无生命周期控件）、
 * i18n 运行时与错误码渲染。
 *
 * 脚手架见 `runtime-harness.ts`。
 */

import { describe, expect, it } from "bun:test";
import { DEFAULT_ACCOUNTS_RISK } from "../../config/types.js";
import {
  installHarnessHooks,
  account,
  cell,
  controlBodies,
  mountChat,
  mountSettled,
  nodes,
  openDetail,
  press,
  proxyRow,
  quota,
  statePayload,
  usageCalls,
} from "./runtime-harness.js";
import type { Harness, PageNode } from "./runtime-harness.js";

installHarnessHooks();

/* ------------------------------------------------------------------------- */
/* 错误码 → 文案                                                              */
/* ------------------------------------------------------------------------- */

describe("error rendering", () => {
  it("translates a known control error code", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account()] }));
    harness.controlReply = { ok: false, error: "invalid_concurrency" };
    const buttons = nodes(cell(harness.rows("page-accounts-body")[0], 4), "button");
    harness.click(buttons[1] as PageNode);
    await harness.settle();

    expect(harness.role("accounts-error-text")?.textContent).toBe("并发必须是非负整数；0 表示软禁用。");
  });

  it("falls back to the raw code for an unknown one", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account()] }));
    harness.controlReply = { ok: false, error: "some_brand_new_code" };
    const buttons = nodes(cell(harness.rows("page-accounts-body")[0], 4), "button");
    harness.click(buttons[1] as PageNode);
    await harness.settle();

    expect(harness.role("accounts-error-text")?.textContent).toBe("some_brand_new_code");
  });

  it("shows routing failures on the routing page banner", async () => {
    const harness = await mountSettled("/routing", statePayload());
    harness.controlReply = { ok: false, error: "invalid_routing_order" };
    harness.change(harness.role("routing-mode"), "only");
    await harness.settle();

    expect(harness.role("routing-error")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("routing-error-text")?.textContent).toContain("降级顺序非法");
  });
});

/* ------------------------------------------------------------------------- */
/* i18n 运行时                                                                 */
/* ------------------------------------------------------------------------- */

describe("i18n runtime", () => {
  it("re-renders the tables in the other language without reloading", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account({ health: "cooling" })] }));
    expect(cell(harness.rows("page-accounts-body")[0], 3)?.textContent).toBe("冷却");

    (harness.win as unknown as { zcodePanel: { setLanguage(language: string): void } }).zcodePanel.setLanguage("en");
    await harness.settle();
    expect(cell(harness.rows("page-accounts-body")[0], 3)?.textContent).toBe("Cooling");
    expect(harness.win.document.documentElement.lang).toBe("en");
  });
});

describe("sidebar — 状态区", () => {
  it("writes address, version, inflight and uptime into the sidebar status block", async () => {
    const harness = await mountSettled(
      "/settings",
      statePayload({
        server: { port: 8080, version: "5.0.0", uptime: 8040 },
        metrics: { inflight: 3, concurrencyLimit: 8, queueDepth: 0, sampledAt: 0, inflightHistory: [] },
      }),
    );

    /* 状态在侧边栏底部，不在顶栏。地址是浏览器实际用的 host:port
       （harness 的 origin 是 127.0.0.1:8090）；端口带 `:` 的旧形态不再有。 */
    expect(harness.role("server-address")?.textContent).toBe("127.0.0.1:8090");
    expect(harness.role("server-version")?.textContent).toBe("v5.0.0");
    expect(harness.role("server-inflight")?.textContent).toBe("3/8");
    expect(harness.role("server-uptime")?.textContent).toBe("2h 14m");
    expect(harness.role("server-address")?.getAttribute("title")).toBe("地址");
  });

  it("falls back to the /api/system panelAddress when the page has no usable host", async () => {
    const harness = await mountSettled("/settings", statePayload());
    /* 回退链：location.host 为空（非 http(s) 环境）时，用 loadSystemInfo 存下的
       panelAddress（happy-dom 的 location.host 不是普通赋值能改的，用
       defineProperty 模拟）。 */
    const location = harness.win.location as unknown as Record<string, unknown>;
    Object.defineProperty(location, "host", { value: "", configurable: true });
    harness.state = statePayload({ server: { port: 8443, version: "5.0.0", uptime: 10 } });
    await harness.refresh();
    expect(harness.role("server-address")?.textContent).toBe("127.0.0.1:8090");
  });

  it("drops the 运行中 / 已停止 field: the page only loads while the gateway runs", async () => {
    const harness = await mountSettled("/settings", statePayload());
    /* 那个字段永远是同一个值，不携带信息。 */
    expect(harness.role("server-state")).toBeNull();
    expect(harness.role("server-address")?.textContent).toBe("127.0.0.1:8090");
  });

  it("turns the dot into a health indicator: green without alerts", async () => {
    const harness = await mountSettled("/settings", statePayload());
    const dot = harness.role("server-dot");

    expect(dot?.className).toContain("status__dot--ok");
    expect(dot?.className).not.toContain("status__dot--danger");
    expect(dot?.getAttribute("title")).toBeFalsy();
  });

  it("turns the dot into a health indicator: red with the alert list in the title (二值化)", async () => {
    const harness = await mountSettled(
      "/settings",
      statePayload({
        risk: {
          alerts: ["account_cooling", "concurrency_above_r11"],
          policy: { ...DEFAULT_ACCOUNTS_RISK },
        },
      }),
    );
    const dot = harness.role("server-dot");

    expect(dot?.className).toContain("status__dot--danger");
    expect(dot?.className).not.toContain("status__dot--warn");
    /* 告警码 → 人话的映射与风控横幅共用一份（`alertText`），不在这里另写一份。 */
    expect(dot?.getAttribute("title")).toBe("有账号处于冷却 · 并发超过 R11 默认值");
  });

  it("follows the alerts across a poll", async () => {
    const harness = await mountSettled("/settings", statePayload());
    expect(harness.role("server-dot")?.className).toContain("status__dot--ok");

    harness.state = statePayload({
      risk: { alerts: ["account_drained"], policy: { ...DEFAULT_ACCOUNTS_RISK } },
    });
    await harness.refresh();
    expect(harness.role("server-dot")?.className).toContain("status__dot--danger");
  });

  it("keeps the status block out of the appbar", async () => {
    const harness = await mountSettled("/settings", statePayload());

    /* 状态区是侧边栏的子元素，不占顶栏；顶栏最左是侧边栏折叠钮，
       往右是品牌、动作结果行、顶栏刷新、主题循环按钮与语言下拉。
       按钮里的图标 use 也带 data-role。 */
    const appbar = harness.win.document.querySelector(".appbar") as unknown as PageNode;
    expect(nodes(appbar, "[data-role]").map((node) => node.getAttribute("data-role"))).toEqual([
      "sidebar-toggle",
      "sidebar-icon",
      "appbar-note",
      "refresh-button",
      "refresh-icon",
      "theme-button",
      "theme-icon",
      "lang-select",
    ]);
    const sidebar = harness.win.document.querySelector(".sidebar") as unknown as PageNode;
    expect(sidebar.querySelector('[data-role="server-dot"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-role="server-address"]')).not.toBeNull();
  });

  it("drops the version / address / uptime rows that the settings page used to repeat", async () => {
    const harness = await mountSettled("/settings", statePayload());

    /* 这四行与概览页重复，删掉；顶栏已经显示版本与端口。 */
    expect(harness.role("system-version")).toBeNull();
    expect(harness.role("system-panelAddress")).toBeNull();
    expect(harness.role("system-proxyAddress")).toBeNull();
    expect(harness.role("system-uptime")).toBeNull();
    expect(harness.role("system-proxyState")).toBeNull();
    expect(harness.role("system-tokenSource")).toBeNull();
  });
});

describe("appbar — 主题图标按钮的三态循环", () => {
  it("cycles system → light → dark → system, swapping the icon and the title with the mode", async () => {
    const harness = await mountSettled("/settings", statePayload());
    const button = harness.role("theme-button");
    const icon = harness.role("theme-icon");

    /* 初始态：跟随系统 → monitor 图标，title 提示当前态（语言固定中文）。 */
    expect(icon?.getAttribute("href")).toBe("#icon-monitor");
    expect(button?.getAttribute("title")).toBe("主题 · 跟随系统");
    expect(button?.getAttribute("aria-label")).toBe("主题 · 跟随系统");

    harness.click(button);
    expect(harness.win.document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(icon?.getAttribute("href")).toBe("#icon-sun");
    expect(button?.getAttribute("title")).toBe("主题 · 浅色");

    harness.click(button);
    expect(harness.win.document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(icon?.getAttribute("href")).toBe("#icon-moon");
    expect(button?.getAttribute("title")).toBe("主题 · 深色");

    harness.click(button);
    /* system 模式不写 data-theme，交给 prefers-color-scheme。 */
    expect(harness.win.document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(icon?.getAttribute("href")).toBe("#icon-monitor");
    harness.close();
  });

  it("persists the picked mode across a reload and retitles on a language switch", async () => {
    const harness = await mountSettled("/settings", statePayload());
    harness.click(harness.role("theme-button"));
    expect(harness.win.localStorage.getItem("theme")).toBe("light");
    expect((harness.win as unknown as { __zcodeApp: { theme: { read(): string } } }).__zcodeApp.theme.read()).toBe("light");

    /* 语言切到英文：按钮的 title 随字典重写（applyLanguage → App.theme.sync），
       选中态本身不动。 */
    (harness.win as unknown as { zcodePanel: { setLanguage(lang: string): void } }).zcodePanel.setLanguage("en");
    expect(harness.role("theme-button")?.getAttribute("title")).toBe("Theme · Light");
    expect(harness.win.document.documentElement.getAttribute("data-theme")).toBe("light");
    harness.close();
  });
});

describe("viewport — 安全区", () => {
  it("adds viewport-fit=cover so the tabbar's safe-area padding resolves", async () => {
    const harness = await mountSettled("/", statePayload());
    const meta = harness.win.document.querySelector('meta[name="viewport"]');
    /* `env(safe-area-inset-bottom)` 只在 `viewport-fit=cover` 下有非零值；两者
       必须成对（模板里的 meta 归骨架那条线，运行时补开关是这里）。 */
    expect(meta?.getAttribute("content")).toContain("viewport-fit=cover");
    /* 幂等：再跑一次不会叠出第二个开关。 */
    expect(meta?.getAttribute("content")?.match(/viewport-fit=cover/g)).toHaveLength(1);
    harness.close();
  });
});

describe("appbar — no lifecycle controls", () => {
  it("leaves 退出进程 as the only system-level action on the page", async () => {
    const harness = await mountSettled("/settings", statePayload());

    /* 面板挂在代理的监听上，停掉代理就把自己也停掉，而同一个进程里没有通路把它
       拉起来。启停代理的入口整块不在了，剩下的系统级动作只有退出进程。 */
    const systemActions = nodes(harness.find("body"), '[data-action^="system-"]').map((node) =>
      node.getAttribute("data-action"),
    );
    expect(systemActions).toEqual(["system-shutdown"]);
  });

  it("has no dropdown left in the app bar", async () => {
    const harness = await mountSettled("/settings", statePayload());

    /* 下拉只为那个菜单存在：开关带 `aria-haspopup`，列表带 `role="menu"`。 */
    expect(harness.find("[aria-haspopup]")).toBeNull();
    expect(harness.find('[role="menu"]')).toBeNull();
  });
});

describe("sidebar — 平铺的八项", () => {
  /** 一项的文字（图标的空白先压掉）。*/
  function text(node: PageNode): string {
    return (node.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  /** 侧边栏的导航项：`[data-nav, href, 文字]`，按出现顺序。聊天没有 href。*/
  function sidebarItems(harness: Harness): Array<[string, string | null, string]> {
    const sidebar = harness.win.document.querySelector(".sidebar") as unknown as PageNode;
    return nodes(sidebar, "[data-nav]").map((link) => [
      link.getAttribute("data-nav") ?? "",
      link.getAttribute("href"),
      text(link),
    ]);
  }

  it("lists the eight pages in frequency order, with no group labels", async () => {
    const harness = await mountSettled("/", statePayload());
    /* 代理不在导航里：它是账号属性的命名字典，管理面是账号页的抽屉，
       所以「路由策略」后面直接是 API key。 */
    const expected: Array<[string, string | null, string]> = [
      ["overview", "/", "概览"],
      ["stats", "/stats", "统计"],
      ["chat", null, "聊天"],
      ["accounts", "/accounts", "账号"],
      ["routing", "/routing", "路由策略"],
      ["keys", "/keys", "API key"],
      ["settings", "/settings", "设置"],
      ["logs", "/logs", "日志"],
    ];
    expect(sidebarItems(harness)).toEqual(expected);
    /* 分组标题整块删掉：侧边栏的直接子元素里是八个导航项（七个 `<a>` + 聊天的
       `<button>`；统计是 `<a>`）加底部的状态区。*/
    const sidebar = harness.win.document.querySelector(".sidebar") as unknown as PageNode;
    expect(nodes(sidebar, ":scope > *").map((node) => node.className.replace(" nav--active", ""))).toEqual([
      ...Array(8).fill("nav"),
      "sidebar__status",
    ]);
  });

  it("gives every item an aria-hidden icon from the shared sprite", async () => {
    const harness = await mountSettled("/", statePayload());
    const sidebar = harness.win.document.querySelector(".sidebar") as unknown as PageNode;

    for (const link of nodes(sidebar, "[data-nav]")) {
      const icon = link.querySelector("svg.nav__icon");
      expect([link.getAttribute("data-nav"), icon !== null]).toEqual([link.getAttribute("data-nav"), true]);
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
      /* 图标引用页面顶部那一份精灵里的 symbol，path 数据不重复。 */
      expect(icon?.querySelector("use")?.getAttribute("href")).toMatch(/^#icon-/);
    }
  });

  it("keeps the mobile tabbar at three destinations plus a working 更多", async () => {
    const harness = await mountSettled("/", statePayload());
    const tabbar = harness.win.document.querySelector(".tabbar") as unknown as PageNode;
    const items = nodes(tabbar, ".tabbar__item");
    expect(items.map((node) => node.getAttribute("data-nav"))).toEqual(["overview", "accounts", "routing", null]);
    /* 「更多」是一颗真按钮（不是占位）：在手机上它是其余五个视图的唯一入口。 */
    const more = harness.role("tabbar-more") as PageNode;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(more.getAttribute("aria-controls")).toBe("tabbar-more-panel");
  });

  it("opens the 更多 panel with the five remaining views and closes it on Esc", async () => {
    const harness = await mountSettled("/", statePayload());
    const panel = harness.find('[data-dialog="tabbar-more"]') as PageNode;
    expect(panel.hasAttribute("hidden")).toBe(true);

    harness.click(harness.role("tabbar-more"));
    expect(panel.hasAttribute("hidden")).toBe(false);
    expect(harness.role("tabbar-more")?.getAttribute("aria-expanded")).toBe("true");
    expect(nodes(panel, "[data-tabbar-more]").map((node) => node.getAttribute("data-nav"))).toEqual([
      "stats",
      "chat",
      "keys",
      "settings",
      "logs",
    ]);

    harness.win.document.dispatchEvent(new harness.win.KeyboardEvent("keydown", { key: "Escape" }));
    expect(panel.hasAttribute("hidden")).toBe(true);
    expect(harness.role("tabbar-more")?.getAttribute("aria-expanded")).toBe("false");
    // 还焦点：来源就是那颗「更多」。
    expect(harness.win.document.activeElement === (harness.role("tabbar-more") as unknown)).toBe(true);
  });

  it("closes the 更多 panel after the chat item switches the view", async () => {
    const harness = await mountSettled("/", statePayload());
    const panel = harness.find('[data-dialog="tabbar-more"]') as PageNode;
    harness.click(harness.role("tabbar-more"));
    harness.click(panel.querySelector('[data-nav="chat"]') as PageNode);
    await harness.settle();
    expect(panel.hasAttribute("hidden")).toBe(true);
    expect(harness.find('[data-view="chat"]')?.hasAttribute("hidden")).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* 顶栏刷新                                                                   */
/* ------------------------------------------------------------------------- */

/** 打到一个 URL 的请求数（只看 URL，不看方法）。*/
function hits(harness: Harness, url: string): number {
  return harness.calls.filter((call) => call.url === url).length;
}

describe("appbar refresh — 按视图派发", () => {
  it("refetches /api/state and today's usage on the overview", async () => {
    const harness = await mountSettled("/", statePayload());
    const stateBefore = hits(harness, "/api/state");
    const usageBefore = usageCalls(harness).length;

    expect(harness.role("refresh-button")?.hasAttribute("disabled")).toBe(false);
    expect(harness.role("refresh-button")?.title).toBe("刷新当前视图");

    harness.click(harness.role("refresh-button"));
    await harness.settle();

    expect(hits(harness, "/api/state")).toBe(stateBefore + 1);
    /* 用量那一拍不受 60s 节流限制：按了刷新就是要现在重新算。 */
    expect(usageCalls(harness)).toHaveLength(usageBefore + 1);
    harness.close();
  });

  it("greys the button out on the chat view (no server data)", async () => {
    const harness = await mountChat(statePayload());
    const button = harness.role("refresh-button");
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe("当前页面无需刷新");
    harness.close();
  });

  it("follows the log tab: requests can refresh, the system tab cannot", async () => {
    const harness = await mountSettled("/logs", statePayload());
    /* 请求事件 tab 是默认 tab，也是拉来的数据 → 进页面就可刷新。 */
    expect(harness.role("refresh-button")?.disabled).toBe(false);
    expect(harness.role("refresh-button")?.title).toBe("刷新当前视图");

    const before = controlBodies(harness).filter(
      (body) => (body as { cmd?: string } | null)?.cmd === "getRequests",
    ).length;
    harness.click(harness.role("refresh-button"));
    await harness.settle();
    const after = controlBodies(harness).filter(
      (body) => (body as { cmd?: string } | null)?.cmd === "getRequests",
    ).length;
    expect(after).toBe(before + 1);

    /* 系统 tab 是 SSE 实时推送，刷新没有意义 → 置灰 + 说明（可用态跟着 tab 走，
       不需要重新进页面）。 */
    harness.click(harness.find('[data-log-tab="system"]'));
    expect(harness.role("refresh-button")?.disabled).toBe(true);
    expect(harness.role("refresh-button")?.title).toBe("当前页面无需刷新");

    /* 切回请求事件 tab：又可用。 */
    harness.click(harness.find('[data-log-tab="requests"]'));
    expect(harness.role("refresh-button")?.disabled).toBe(false);
    harness.close();
  });

  it("rereads the config file on the settings view", async () => {
    const harness = await mountSettled("/settings", statePayload());
    const before = hits(harness, "/api/settings");
    harness.click(harness.role("refresh-button"));
    await harness.settle();
    expect(hits(harness, "/api/settings")).toBe(before + 1);
    harness.close();
  });

  it("refetches the key table on the keys view", async () => {
    const harness = await mountSettled("/keys", statePayload(), { apiKeys: [] });
    const before = controlBodies(harness).filter(
      (body) => (body as { cmd?: string } | null)?.cmd === "listApiKeys",
    ).length;
    harness.click(harness.role("refresh-button"));
    await harness.settle();
    const after = controlBodies(harness).filter(
      (body) => (body as { cmd?: string } | null)?.cmd === "listApiKeys",
    ).length;
    expect(after).toBe(before + 1);
    harness.close();
  });

  it("refetches the proxy dictionary when the drawer opens", async () => {
    /* 代理表是只读命令，只在两处重取：
       账号页进页面（`applyView` 的 accounts 分支）与抽屉打开。开抽屉这一次是用户
       明确在看这张表，必须拿到新值。 */
    const harness = await mountSettled("/accounts", statePayload(), { proxies: [proxyRow()] });
    const before = controlBodies(harness).filter(
      (body) => (body as { cmd?: string } | null)?.cmd === "listProxies",
    ).length;
    harness.click(harness.find('[data-action="accounts-open-proxies"]'));
    await harness.settle();
    const after = controlBodies(harness).filter(
      (body) => (body as { cmd?: string } | null)?.cmd === "listProxies",
    ).length;
    expect(after).toBe(before + 1);
    /* 抽屉是 `hidden` 投影的浮层：打开之后壳与遮罩都不再带 hidden。 */
    expect(harness.find('[data-dialog="proxies"]')?.hasAttribute("hidden")).toBe(false);
    expect(harness.find('[data-dialog-scrim="proxies"]')?.hasAttribute("hidden")).toBe(false);
    harness.close();
  });

  it("reloads the account list and applies the scoped quota refresh", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({ accounts: [account({ quota: quota({ windows: [{ type: "TOKENS_LIMIT", percentage: 40, nextResetTime: Date.now() + 60_000 }] }) })] }),
    );
    const stateBefore = hits(harness, "/api/state");

    /* 抽屉关着：先重拉账号表，再发一次带 labels 的分级采命令（服务端决定采谁）。
       两条命令各自成功后都会回读 /api/state，所以这一拍是 +2 而非 +1。 */
    harness.click(harness.role("refresh-button"));
    await harness.settle();
    expect(hits(harness, "/api/state")).toBe(stateBefore + 2);
    const scoped = controlBodies(harness).filter(
      (body) => (body as { cmd?: string } | null)?.cmd === "quota",
    );
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toEqual({ cmd: "quota", labels: ["work-team"] });

    /* 抽屉开着：focusedLabel 是详情账号（必采），命令形状仍是一份 labels 清单。 */
    openDetail(harness);
    harness.click(harness.role("refresh-button"));
    await harness.settle();
    const quotaCalls = controlBodies(harness).filter(
      (body) => (body as { cmd?: string } | null)?.cmd === "quota",
    );
    expect(quotaCalls).toHaveLength(2);
    expect(quotaCalls[1]).toEqual({ cmd: "quota", labels: ["work-team"], focusedLabel: "work-team" });
    harness.close();
  });

  it("spins while in flight and resets the icon 800ms after settling", async () => {
    const harness = await mountSettled("/", statePayload());
    harness.click(harness.role("refresh-button"));
    /* 点击是同步转圈：此刻在途。 */
    expect(harness.role("refresh-button")?.getAttribute("aria-busy")).toBe("true");
    /* 断言的是 **class 属性**：SVG 元素的 `className` 是只读的 SVGAnimatedString，
       赋值在真浏览器的严格模式下会抛 TypeError，所以实现必须走 setAttribute。 */
    expect(harness.find(".appbar__refresh-icon")?.getAttribute("class")).toContain("spinning");
    await harness.settle();
    /* 取数落地后仍然转一会儿（800ms 反馈窗），再复位。 */
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(harness.role("refresh-button")?.hasAttribute("aria-busy")).toBe(false);
    expect(harness.find(".appbar__refresh-icon")?.getAttribute("class")).toBe("appbar__refresh-icon");
    harness.close();
  });
});

describe("appbar refresh — 键盘快捷键", () => {
  it("refreshes on a bare R and ignores R inside an input", async () => {
    const harness = await mountSettled("/accounts", statePayload());
    const before = hits(harness, "/api/state");

    press(harness, "r");
    await harness.settle();
    expect(hits(harness, "/api/state")).toBe(before + 1);

    /* 在搜索框里敲 r：那是字面字符，不触发刷新。 */
    const afterTyping = hits(harness, "/api/state");
    press(harness, "r", harness.role("accounts-search"));
    await harness.settle();
    expect(hits(harness, "/api/state")).toBe(afterTyping);

    /* 修饰键组合留给浏览器：Ctrl+R 是整页重载，抢过来就变成「按了没反应」。 */
    press(harness, "r", null, { ctrlKey: true });
    await harness.settle();
    expect(hits(harness, "/api/state")).toBe(afterTyping);

    /* 大写 R（shift 未按下时键值仍是 R）走同一条路。 */
    press(harness, "R");
    await harness.settle();
    expect(hits(harness, "/api/state")).toBe(afterTyping + 1);
    harness.close();
  });

  it("does nothing when the view has no refresh (chat)", async () => {
    const harness = await mountChat(statePayload());
    const before = hits(harness, "/api/state");
    press(harness, "r");
    await harness.settle();
    expect(hits(harness, "/api/state")).toBe(before);
    harness.close();
  });
});
