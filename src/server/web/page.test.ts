/**
 * 页面的**静态产物**测试（三层结构 / 字典完整性 / 样式门禁）。
 *
 * 这一组只看拼出来的字节，不跑浏览器：三层结构有没有走样（样式只在 components.css、
 * token 只在 tokens.css）、两套字典键集合是否相等、页面里用到的每个 `data-i18n` 键
 * 是否都在字典里、有没有硬编码色值与外部引用。行为测试在 `runtime-*.test.ts`。
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PAGE_APP_SCRIPT,
  PAGE_COMPONENTS_CSS,
  PAGE_DICTIONARIES,
  PAGE_TOKENS_CSS,
  LOGIN_PAGE_SCRIPT,
  joinedComponentsCss,
  joinedPageHtml,
  renderLoginPage,
  renderPanelPage,
} from "./page.js";

const WEB_DIR = import.meta.dir;

/** 一个文件里的全部文本（测试直接读源文件，避免再拼一次）。*/
function read(relative: string): string {
  return readFileSync(join(WEB_DIR, relative), "utf8");
}

/**
 * 账号页四个模块的拼文本（主视图 + 套餐卡 / 表格 / 详情窗）。
 *
 * 「视图脚本里引用了哪些文案键 / 类名」这类断言关心的是**整个账号页**，不是某个
 * 文件：拆成四个模块之后，按单个文件读会让断言悄悄变弱（键搬到别的模块里就查
 * 不到了）。
 */
function readAccountsModules(): string {
  return ["app-accounts-plan-cards.js", "app-accounts-table.js", "app-accounts-detail.js", "app-view-accounts.js"]
    .map(read)
    .join("\n");
}

/** 源码里出现的全部十六进制色值（三位、六位、八位写法都算）。*/
const HEX_COLOR = new RegExp("#[0-9a-fA-F]{3,8}\\b", "g");

/**
 * 侧边栏的八项，按出现顺序（没有分组标题，只剩顺序）。代理不在这里：
 * 它并进了账号页抽屉。
 *
 * 顺序就是使用频率：概览每天看，统计与聊天随日常使用跟进，
 * 账号最常操作，路由 / API key 配一次不动，设置偶尔改，日志出问题才看。
 * 聊天不是链接（没有服务端路径，它是一个视图切换按钮）。
 */
const NAV_ITEMS = ["overview", "stats", "chat", "accounts", "routing", "keys", "settings", "logs"];

/** 视图开标签的精确位置（`data-view="X"` 也出现在 CSS 规则里，裸 indexOf 会切到样式上）。 */
function viewStart(html: string, view: string): number {
  const m = html.match(new RegExp(`<div class="page[^"]*" data-view="${view}"`));
  return m && m.index !== undefined ? m.index : -1;
}

describe("page assembly", () => {
  it("joins the split arrays back into the source files byte for byte", () => {
    /* 两个大资源走数组拼接，顺序 = CSS 层叠顺序 / DOM 顺序。
       拼接产物必须等于按数组顺序读到的片段，改了片段顺序或漏掉一项，这里先红。 */
    expect(joinedComponentsCss()).toBe(
      [
        "styles/base.css",
        "styles/components.css",
        "styles/views/logs.css",
        "styles/views/settings.css",
        "styles/views/chat.css",
      ].map(read).join("\n"),
    );
    expect(joinedPageHtml()).toBe(
      [
        "page.html",
        "views/overview.html",
        "views/stats.html",
        "views/accounts.html",
        "views/routing.html",
        "views/keys.html",
        "views/logs.html",
        "views/settings.html",
        "views/chat.html",
        "page-tail.html",
      ].map(read).join("\n"),
    );
    // 拼进页面的就是拼接产物，不是任何一个单独的 import。
    expect(PAGE_COMPONENTS_CSS).toBe(joinedComponentsCss());
    expect(renderPanelPage()).toContain(joinedComponentsCss());
    expect(renderLoginPage()).toContain(joinedComponentsCss());
    // 面板骨架只服务面板页：登录页有自己的模板，不含面板的侧边栏。
    expect(joinedPageHtml()).toContain('<nav class="sidebar"');
    expect(renderLoginPage()).not.toContain('<nav class="sidebar"');
  });

  it("fills every slot and ships no placeholder", () => {
    const html = renderPanelPage();
    expect(html).not.toContain("<!-- THEME-BOOT -->");
    expect(html).not.toContain("<!-- TOKENS -->");
    expect(html).not.toContain("<!-- COMPONENTS -->");
    expect(html).not.toContain("/* I18N */");
    expect(html).not.toContain("/* APP */");
    // 三层与两个脚本都到位了。
    expect(html).toContain(PAGE_TOKENS_CSS.slice(0, 40));
    expect(html).toContain(PAGE_COMPONENTS_CSS.slice(0, 40));
    expect(html).toContain(PAGE_APP_SCRIPT.slice(0, 40));
    // 首屏防闪烁脚本必须在两个 style **之前**。
    expect(html.indexOf('localStorage.getItem("theme")')).toBeLessThan(html.indexOf("--space-1:"));
  });

  it("ships every runtime module, in dependency order", () => {
    /* 拼接顺序就是依赖顺序：常量与状态先就位，工具层其次，请求与事件流再次，
       各视图最后，`app.js` 收尾。顺序错了不会在拼装期报错，只会在浏览器里
       变成 `undefined`，所以在这里逐段核对。*/
    const modules = [
      "app-constants.js",
      "qr.js",
      "app-state.js",
      "app-dom.js",
      "app-format.js",
      "app-i18n.js",
      "app-forms.js",
      "app-chat-attachments.js",
      "app-chat-sessions.js",
      "app-chat-stream.js",
      "app-theme.js",
      "app-sidebar.js",
      "app-widgets.js",
      "app-api.js",
      "app-sse.js",
      "app-confirm.js",
      "app-charts.js",
      "app-claim-state.js",
      "app-view-overview.js",
      "app-view-stats.js",
      "app-accounts-plan-cards.js",
      "app-accounts-table.js",
      "app-accounts-detail.js",
      "app-view-accounts.js",
      "app-view-routing.js",
      "app-view-keys.js",
      "app-view-proxies.js",
      "app-logs-system-stream.js",
      "app-logs-request-table.js",
      "app-view-logs.js",
      "app-view-chat.js",
      "app-view-account.js",
      "app-view-settings.js",
      "app-refresh.js",
      "app-shell.js",
      "app-add-account.js",
      "app.js",
    ];

    let cursor = -1;
    for (const name of modules) {
      const at = PAGE_APP_SCRIPT.indexOf(read(name));
      expect([name, at]).not.toEqual([name, -1]);
      expect([name, at > cursor]).toEqual([name, true]);
      cursor = at;
    }

    /* 拼接不丢字节：长度等于各段之和加分隔换行。*/
    const total = modules.reduce((sum, name) => sum + read(name).length, 0);
    expect(PAGE_APP_SCRIPT.length).toBe(total + modules.length - 1);
  });

  it("keeps the page views and the account table columns", () => {
    const html = renderPanelPage();
    /* 八个视图。`/account` 不是其中之一：「我的账户」并进了设置页的「账户」组，
       那条旧路径也不由面板认领（`panel.ts`），交回代理路由。`chat` 也没有路径：
       它是侧边栏的一个视图，没有服务端路由。
       `stats` 是统计视图：getUsageStats 的报表页。
       `proxies` 不是视图：代理是账号属性的命名字典，降级为账号页的抽屉，
       所以既没有 `data-view` 也没有 `data-nav`。 */
    for (const view of ["overview", "stats", "chat", "accounts", "routing", "keys", "logs", "settings"]) {
      expect(html).toContain(`data-view="${view}"`);
    }
    expect(html).not.toContain('data-view="account"');
    expect(html).not.toContain('data-view="proxies"');
    // 侧边栏的每一页都是真链接（「日志」「设置」曾经是置灰占位）；聊天是按钮
    for (const nav of NAV_ITEMS) {
      expect(html).toContain(`data-nav="${nav}"`);
    }
    expect(html).not.toContain('data-nav="account"');
    // 账号页七列（+ 复选框）：账号 / 路由 / 状态 / 并发 / 调度权重 / 额度 / 操作
    for (const key of [
      "table.account",
      "table.routes",
      "accounts.table.status",
      "accounts.table.concurrency",
      "accounts.table.share",
      "accounts.table.quota",
      "accounts.table.actions",
    ]) {
      expect(html).toContain(`data-i18n="${key}"`);
    }
    // 添加账号三个 tab（「本机文件」与「选择文件」并成「导入凭据」）
    for (const tab of ["credential", "jwt", "login"]) {
      expect(html).toContain(`data-add-tab="${tab}"`);
    }
  });

  it("keeps the dispatch-weight column and the bulk action bar", () => {
    const html = renderPanelPage();
    const css = PAGE_COMPONENTS_CSS;
    const view = readAccountsModules();

    /* 列序：并发 → 调度权重 → 额度。权重紧接并发（同样是“这一行的调度旋钮”），
       而不是仲在额度与代理之间。 */
    const concurrency = html.indexOf('data-i18n="accounts.table.concurrency"');
    const share = html.indexOf('data-i18n="accounts.table.share"');
    const quotaColumn = html.indexOf('data-i18n="accounts.table.quota"');
    expect(concurrency).toBeGreaterThan(-1);
    expect(concurrency).toBeLessThan(share);
    expect(share).toBeLessThan(quotaColumn);

    /* 权重入口从 ⋯ 菜单删掉（不是隐藏）：视图里不再有构造数字输入的代码，
       也没有那条只服务菜单输入的校验文案调用。 */
    expect(view).not.toContain("buildWeightInput");
    expect(view).not.toContain('input.type = "number"');

    /* 批量条默认整条不渲染（`hidden`），动作按 `data-bulk` 分流；八个按钮全在。 */
    expect(html).toContain('data-role="accounts-bulk" hidden');
    for (const action of ["clear", "enable", "disable", "concurrency", "weight", "weight-even", "proxy", "delete"]) {
      expect(html).toContain(`data-bulk="${action}"`);
    }

    /* 组件层有登记，且只用 token：权重按钮与批量条的显隐必须显式压过 display。 */
    expect(css).toContain(".share__value {");
    expect(css).toContain(".share-pop {");
    expect(css).toContain(".bulk-bar {");
    /* 显隐压过组件的 `display` 只有一处来源（`styles/base.css` 的全局 `[hidden]`），
       组件层不再各写一份 `xxx[hidden]`。 */
    expect(css).toContain("[hidden] {\n  display: none !important;\n}");

    /* 列名说调度分配比例，不说“流量”：百分比算的是 `weight / Σweight`，与实测流量无关。 */
    const zh = PAGE_DICTIONARIES.zh as Record<string, string>;
    const en = PAGE_DICTIONARIES.en as Record<string, string>;
    expect(zh["accounts.table.share"]).toBe("调度权重");
    expect(en["accounts.table.share"]).toBe("Dispatch weight");
    expect(zh["accounts.share.note"]).toContain("不是实测流量");
    expect(en["accounts.share.note"]).toContain("not measured traffic");
  });

  it("keeps the row menu to actions only and separates a paused account from a failing one", () => {
    /* ⋯ 菜单只放动作：只读信息行连同它的样式与文案键一起退场，不是隐藏。
       这里按「还剩什么」判，而不是逐条点名退场的键——以后再加只读行，这条也会先红。 */
    const css = PAGE_COMPONENTS_CSS;
    const view = readAccountsModules();
    const zh = PAGE_DICTIONARIES.zh as Record<string, string>;
    const en = PAGE_DICTIONARIES.en as Record<string, string>;
    expect(view).not.toMatch(/menu__field--/);
    expect(css).not.toMatch(/\.menu__field--/);
    for (const dictionary of Object.values(PAGE_DICTIONARIES) as Record<string, string>[]) {
      const menuKeys = Object.keys(dictionary)
        .filter((key) => key.startsWith("accounts.menu."))
        .map((key) => key.slice("accounts.menu.".length))
        .sort();
      expect(menuKeys).toEqual(["enable", "more", "pause", "refreshQuota"]);
    }
    expect(zh["accounts.menu.pause"]).toBe("暂停");
    expect(en["accounts.menu.pause"]).toBe("Pause");
    /* 停用账号进不了任何自动采样，行菜单的这条是它们唯一的入口。 */
    expect(zh["accounts.menu.refreshQuota"]).toBe("刷新额度");
    expect(en["accounts.menu.refreshQuota"]).toBe("Refresh quota");

    /* 状态徽章三档：红只表示系统故障，用户主动停用走中性灰。 */
    expect(css).toContain(".status-badge--muted {");
    expect(css).toContain(".status-badge--muted .status-badge__dot {");
    expect(view).toContain('badge: "status-badge status-badge--muted"');
  });

  it("keeps the account detail window (plan cards, kind tags, refresh, four windows)", () => {
    // 详情是 JS 拼的 DOM，静态层只能看三件事：视图脚本引用了段与刷新的文案键、
    // 卡片的组件类都在 components.css、壳是静态的（`.modal--lg` + 头部 + 体）。
    const view = readAccountsModules();
    for (const key of [
      "accounts.quota.section.plans",
      "accounts.quota.section.windows",
      "accounts.quota.section.campaigns",
      "accounts.quota.available",
      "accounts.quota.noPlans",
      // 套餐卡与窗口的人话名
      "accounts.plan.kind.subscription",
      "accounts.plan.kind.experience",
      "accounts.window.fiveHour",
      "accounts.window.weekly",
      "accounts.window.tool",
      "accounts.quota.more",
      "accounts.quota.open",
      // 分子点名的消歧键（剩 X/Y · 剩 N% · 已用/总量）
      "accounts.quota.remainingPair",
      "accounts.quota.remainingPercent",
      "accounts.quota.usedPair",
      // 官方样式套餐卡（plan.name / 状态词三态 / 刷新周期文案）+ 数据龄
      "accounts.quota.unattributed",
      "accounts.quota.pending",
      "accounts.quota.effectiveAt",
      "accounts.quota.cycle.daily",
      "accounts.quota.cycle.once",
      "accounts.quota.sampledAgo",
      // 体系分区小标题（官方词「体验套餐」/「编程套餐」）
      "accounts.plan.group.experience",
      "accounts.plan.group.coding",
      // 订阅卡的产品信息（状态词 / 形态 / 续期 / 到期 / 计费周期）
      "accounts.quota.subscription.active",
      "accounts.quota.subscription.personal",
      "accounts.quota.subscription.team",
      "accounts.quota.subscription.renew",
      "accounts.quota.subscription.expire",
      "accounts.quota.subscription.cycle",
      "accounts.quota.subscription.unknown",
    ]) {
      expect(view).toContain(key);
    }
    // 状态标签（ok/muted 分配）：生效中/已领取是 ok 系，可领/已过期/待生效是中性。
    expect(view).toContain('"tag tag--ok"');
    expect(view).toContain('"tag"');
    for (const cls of [
      ".detail__section-title",
      ".detail__plan-name",
      ".detail__note--quiet",
      ".plan-cards",
      ".plan-card",
      ".plan-card__bucket",
      ".plan-group",
      ".plan-card__window",
      ".quota-cell",
      ".modal--lg",
      ".modal__close",
    ]) {
      expect(PAGE_COMPONENTS_CSS).toContain(cls);
    }
    // 大窗的壳在 page.html 里（静态），宽度走 token。
    const html = renderPanelPage();
    expect(html).toContain('class="modal modal--lg"');
    expect(html).toContain('data-dialog="account"');
    // 「刷新」按钮住在静态壳的头部（窗体每拍重画，按钮不重建）。
    expect(html).toContain('data-action="accounts-refresh-quota"');
    expect(html).toContain('data-i18n="accounts.quota.refresh"');
    expect(PAGE_TOKENS_CSS).toContain("--layout-modal-lg");
    // 抽屉的宽度 token 与样式不在了（被大模态替换）。
    expect(PAGE_TOKENS_CSS).not.toContain("--layout-drawer-width");
    expect(PAGE_COMPONENTS_CSS).not.toContain(".drawer {");
    // token 数值格式化在 app-format.js（亿/万 · K/M/B 两套单位）。
    const format = read("app-format.js");
    expect(format).toContain("formatUnitsZh");
    expect(format).toContain("formatUnitsEn");
    expect(format).toContain("formatDateTime");
  });

  it("keeps the API key page", () => {
    const html = renderPanelPage();
    // 六列表格：名称 / Key / 今日 / 累计 / 最后使用 / 操作
    // （「状态」列并进了操作列的可点徽章，省下的宽度归「累计」；
    //   「前缀」列升级为 Key 列——掩码 + 显示 / 复制）
    for (const key of [
      "keys.table.name",
      "keys.table.key",
      "keys.table.today",
      "keys.table.total",
      "keys.table.lastUsed",
      "keys.table.actions",
    ]) {
      expect(html).toContain(`data-i18n="${key}"`);
    }
    /* 状态只有一处：表头里不再有「状态」列（徽章在操作列里显示 + 切换）。*/
    expect(html).not.toContain('data-i18n="keys.table.status"');
    /* 操作列定宽：表头带 `col-actions`，宽度是 token。*/
    expect(html).toContain('<th scope="col" class="col-actions" data-i18n="keys.table.actions">');
    expect(PAGE_TOKENS_CSS).toContain("--layout-actions-col: 176px;");
    // 创建流程：输入名称 → 显示一次完整 key → 复制 → 关闭
    for (const role of ["keys-body", "keys-empty", "keys-create-modal", "keys-create-name", "keys-create-key", "keys-copy"]) {
      expect(html).toContain(`data-role="${role}"`);
    }
    // 「API key」按使用频率排在设置之前（平铺顺序，见 NAV_ITEMS）
    expect(html.indexOf('data-nav="keys"')).toBeLessThan(html.indexOf('data-nav="settings"'));
    // 设置页的服务组只剩总开关 + 指向 /keys 的文字链接，没有明文输入框。
    expect(html).toContain('data-role="settings-requireKey"');
    expect(html).not.toContain("settings-proxyApiKey");
    expect(html).toMatch(/<a[^>]*class="link"[^>]*href="\/keys"/);
  });

  it("keeps the proxy dictionary, now inside the accounts-page drawer", () => {
    const html = renderPanelPage();
    /* 代理没有独立视图了：字典表挂在账号页页头「出口代理」按钮打开的抽屉里。
       字段级文案与 data-role / data-action 照旧（抽屉复用同一批渲染函数）。 */
    // 五列表格：名称 / 地址 / 状态 / 使用中 / 操作
    for (const key of [
      "proxies.table.name",
      "proxies.table.url",
      "proxies.table.status",
      "proxies.table.usedBy",
      "proxies.table.actions",
    ]) {
      expect(html).toContain(`data-i18n="${key}"`);
    }
    // 抽屉壳（`data-dialog="proxies"`）+ 新建 / 编辑弹窗：名称 / 地址 / 用户名 / 密码 + 清除密码
    for (const role of [
      "proxies-drawer-body",
      "proxies-body",
      "proxies-empty",
      "proxies-modal",
      "proxies-name",
      "proxies-url",
      "proxies-password",
    ]) {
      expect(html).toContain(`data-role="${role}"`);
    }
    for (const action of ["proxies-open-add", "proxies-submit", "proxies-close", "accounts-open-proxies"]) {
      expect(html).toContain(`data-action="${action}"`);
    }
    /* 抽屉沿用 `.modal--lg` 这套浮层（右侧抽屉已并进大模态，只剩这一套），
       开合投影是 `hidden`。 */
    expect(html).toContain('data-dialog="proxies"');
    expect(html).toContain('data-dialog-scrim="proxies"');
    /* 抽屉里打开的新建 / 编辑弹窗也登记成 dialog（`proxies-form`）：Esc 退层要靠
       这份记录认出「最后打开的是它」。 */
    expect(html).toContain('data-dialog="proxies-form"');
    expect(html).toContain('data-dialog-scrim="proxies-form"');
    /* 层级：#111 的根因是抽屉与弹窗同为 `z-index: 2`，谁在上只看文档序，而抽屉
       必须排在弹窗之后。现在三档写在 tokens 里，抽屉单独压一档。 */
    for (const token of ["--layer-drawer: 1;", "--layer-modal: 2;", "--layer-popover: 30;"]) {
      expect(PAGE_TOKENS_CSS).toContain(token);
    }
    expect(PAGE_COMPONENTS_CSS).toContain('.modal--lg[data-dialog="proxies"] {');
    expect(PAGE_COMPONENTS_CSS).toContain("z-index: var(--layer-drawer)");
    /* 页面里不再有裸的 `z-index: 2`：层级只有一个来源（tokens 的三档）。 */
    expect(PAGE_COMPONENTS_CSS).not.toContain("z-index: 2;");
    // 代理不在侧边栏里了：导航项与视图容器都已删除，路由策略后面直接是 API key。
    expect(html).not.toContain('data-nav="proxies"');
    expect(html.indexOf('data-nav="routing"')).toBeLessThan(html.indexOf('data-nav="keys"'));
    // 账号页多一列代理（下拉）+ 一列旁的风控小字
    expect(html).toContain('data-i18n="accounts.table.proxy"');
    expect(html).toContain('data-i18n="accounts.table.proxyRisk"');
  });

  it("keeps the log page controls", () => {
    const html = renderPanelPage();
    // 实时流 + 账号过滤 + 级别过滤 + 模块过滤 + 暂停/回放 + 搜索 + 连接状态
    for (const role of ["log-lines", "log-account", "log-level", "log-mod", "log-search", "log-pause", "log-conn", "log-conn-dot"]) {
      expect(html).toContain(`data-role="${role}"`);
    }
    expect(html).toContain('data-action="toggle-pause"');
    expect(html).toContain('data-action="clear-logs"');
    // 暂停横幅默认隐藏（暂停时才出现）
    expect(html).toContain('data-role="log-paused"');
  });

  it("keeps the two log tabs and the request-events table", () => {
    const html = renderPanelPage();
    // 两个 tab：请求事件在前（请求是日志页的主内容），默认选中
    for (const tab of ["requests", "system"]) {
      expect(html).toContain(`data-log-tab="${tab}"`);
    }
    /* 全仓 tab 一套契约：容器 `role="tablist"`、按钮 `role="tab"`、选中态 `aria-selected`。 */
    expect(html).toContain('class="tabs" role="tablist" data-role="log-tabs"');
    expect(html).toContain(
      'class="tab tab--active" role="tab" aria-selected="true" data-log-tab="requests" data-i18n="logs.tab.requests"',
    );
    expect(html).toContain('class="tab" role="tab" aria-selected="false" data-log-tab="system"');
    expect(html).not.toContain('class="tab tab--active" data-log-tab="system"');
    // 请求事件表头十四列（时间 / reqId / 请求·端点 / 来源 / 模型 /
    // 状态 / 用时 / 缓存 / 推理强度 / 重试 / tok/s / tokens / key / 错误）
    for (const key of [
      "logs.requests.col.time",
      "logs.requests.col.reqId",
      "logs.requests.col.request",
      "logs.requests.col.source",
      "logs.requests.col.model",
      "logs.requests.col.status",
      "logs.requests.col.latency",
      "logs.requests.col.cache",
      "logs.requests.col.effort",
      "logs.requests.col.attempts",
      "logs.requests.col.tps",
      "logs.requests.col.tokens",
      "logs.requests.col.key",
      "logs.requests.col.error",
    ]) {
      expect(html).toContain(`data-i18n="${key}"`);
    }
    // 旧的「账号」「路由 / 协议」两列已经被 来源 / 请求 取代（替换即删除）
    expect(html).not.toContain('data-i18n="logs.requests.col.account"');
    expect(html).not.toContain('data-i18n="logs.requests.col.route"');
    // 导出 JSON：当前筛选结果落盘
    expect(html).toContain('data-action="export-requests"');
    expect(html).toContain('data-i18n="logs.requests.export"');
    // 筛选器六件：状态 / 账号 / 路由 / 模型 / key / 文本搜索（全维聚合）
    for (const role of ["req-account", "req-route", "req-status", "req-model", "req-key", "req-search"]) {
      expect(html).toContain(`data-role="${role}"`);
    }
    // 两个 tab 各自的内容面板与空的请求事件状态
    for (const role of ["log-filters-system", "log-filters-requests", "log-panel-system", "log-panel-requests", "req-body", "req-empty"]) {
      expect(html).toContain(`data-role="${role}"`);
    }
    // SSE 的 request 事件常量（前端常量表与 handle() 都要有它）
    expect(PAGE_APP_SCRIPT).toContain('SSE_EVENT_REQUEST: "request"');
    expect(PAGE_APP_SCRIPT).toContain("C.SSE_EVENT_REQUEST");
    // getRequests 的初始加载
    expect(PAGE_APP_SCRIPT).toContain('"getRequests"');
  });

  it("gives all three tables the shared actions column and the log toolbar its two groups", () => {
    const html = renderPanelPage();

    /* G-4：三张带操作列的表都钉同一个宽度（`--layout-actions-col`）——
       只给一张表挂 `col-actions` 时，另外两张的列会随内容伸缩。 */
    for (const key of ["accounts.table.actions", "keys.table.actions", "proxies.table.actions"]) {
      expect(html).toContain(`<th scope="col" class="col-actions" data-i18n="${key}">`);
    }

    /* L-2：两个 tab 的筛选行都是「筛选器组 + 搜索 + 动作组」，换行只发生在组之间。 */
    expect(html.match(/class="toolbar__group toolbar__group--fields"/g)).toHaveLength(2);
    expect(html.match(/class="toolbar__group toolbar__group--end"/g)).toHaveLength(2);
    const requestsToolbar = html.slice(
      html.indexOf('data-role="log-filters-requests"'),
      html.indexOf('data-role="log-paused"'),
    );
    const systemToolbar = html.slice(html.indexOf('data-role="log-filters-system"'), html.indexOf('data-role="log-filters-requests"'));
    /* 换行靠 `margin-left: auto`（替换即删除）：`toolbar__spacer` 在换行后把动作组
       推到第二行的最左，正是「暂停 / 清空孤立」的来源。 */
    for (const toolbar of [requestsToolbar, systemToolbar]) {
      expect(toolbar).not.toContain("toolbar__spacer");
      expect(toolbar).toContain("toolbar__group toolbar__group--end");
    }
    /* 动作组三件在同一个组里（导出 / 暂停 / 清空）。 */
    expect(requestsToolbar).toContain('data-action="export-requests"');
    expect(requestsToolbar).toContain('data-action="toggle-pause"');
    expect(requestsToolbar).toContain('data-action="clear-logs"');

    /* 筛选条固定两行——筛选下拉全在第一行（`--fields` 组），搜索框与动作组
       在第二行。搜索框**在 `--fields` 组外**是这一版的结构约定：留在组里就会跟着
       下拉一起按内容宽度折行，正是「key 与搜索分居两行」那类折行的来源。 */
    for (const [name, toolbar, fieldCount] of [
      ["requests", requestsToolbar, 6],
      ["system", systemToolbar, 3],
    ] as const) {
      expect([name, new RegExp(`<div class="toolbar toolbar--filters" data-role="log-filters-${name}"[^>]*>`).test(html)]).toEqual([name, true]);
      const fieldsGroup = toolbar.slice(
        toolbar.indexOf('class="toolbar__group toolbar__group--fields"'),
        toolbar.indexOf('class="field-cell field-cell--inline toolbar__search"'),
      );
      expect([name, fieldsGroup.match(/class="field-cell field-cell--inline"/g)?.length ?? 0]).toEqual([name, fieldCount]);
      expect([name, fieldsGroup.includes('type="search"')]).toEqual([name, false]);
      expect([name, /class="field-cell field-cell--inline toolbar__search"/.test(toolbar)]).toEqual([name, true]);
    }

    /* L-3：缓存 / 推理强度 / 重试三列表头带折叠钩子。 */
    for (const key of ["logs.requests.col.cache", "logs.requests.col.effort", "logs.requests.col.attempts"]) {
      expect(html).toContain(`<th scope="col" class="req__col--extra" data-i18n="${key}">`);
    }
  });

  it("keeps the dump switch in the settings subsystems group", () => {
    const html = renderPanelPage();
    for (const role of ["settings-dumpEnabled", "settings-dumpPath"]) {
      expect(html).toContain(`data-role="${role}"`);
    }
    for (const key of ["settings.dump", "settings.dump.hint", "settings.dump.risk", "settings.dump.path"]) {
      expect(html).toContain(`data-i18n="${key}"`);
    }
    // 风险文案是设置页的原文；dump 经热重载即时生效（writeSettings 更新 dump
    // 快照），提示里说的是「保存后立即生效」。
    expect(html).toContain("dump 文件含完整请求体，可能包含提示词内容。只在排障时开启。");
    expect(html).toContain("保存后立即生效");
  });

  it("moves the restart hint onto the C-class fields", () => {
    const html = renderPanelPage();
    /* 端口与绑定地址是仅有的两类「重启才生效」字段。那句后果说明挂在标签旁的
       「需重启」徽章上（`title`，原文一字不改）：它是后果型提示，常驻位置是结论而不是
       说明段。`data-reload` 也跟着移到徽章上——它一直是这对字段的静态标注。 */
    const restartBadges = [...html.matchAll(/<span class="status-badge status-badge--warn" data-reload="restart"[^>]*>/g)].map(
      (match) => match[0],
    );
    expect(restartBadges).toHaveLength(2);
    for (const badge of restartBadges) expect(badge).toContain("title:settings.restartHint");
    for (const role of ["settings-port", "settings-host"]) {
      /* 徽章在标签里、控件在标签之后：两者的距离按「同一格内」取一段。 */
      const at = html.indexOf(`data-role="${role}"`);
      const field = html.slice(at - 600, at + 300);
      expect([role, field.includes('data-reload="restart"')]).toEqual([role, true]);
    }
    // 全局的「重启后生效」不再存在：顶部的常驻提示只剩环境变量优先级这一句。
    expect(html).not.toContain('data-i18n="settings.restartHint" data-role');
    expect(html).toContain('data-i18n="settings.envHint"');
    expect(html).not.toContain("改动写入配置文件，重启后生效");
  });

  it("rebuilds the appbar as brand + preferences", () => {
    const html = renderPanelPage();
    /* 启停 / 重启三个动作整块删掉：面板跟代理共用一个监听，停掉代理等于把自己也
       停掉，而同一个进程里没有通路再把它拉起来。 */
    expect(html).not.toMatch(/data-action="system-(start|stop|restart)"/);
    /* 装那三个动作的下拉菜单一起删了：没有菜单容器，也没有菜单项与开关。 */
    expect(html).not.toContain('role="menuitem"');
    expect(html).not.toContain("aria-haspopup");
    /* 电源图标只服务于那个菜单，跟着一起删。 */
    expect(html).not.toContain("icon-power");
    /* 「运行中 / 已停止」那一项也删了：能看到这一页就说明网关在跑。 */
    expect(html).not.toContain('data-role="server-state"');
    const appbar = html.slice(html.indexOf('<header class="appbar">'), html.indexOf("</header>"));
    /* 左 = 品牌（自绘 ZCode 图标 + 名字，指回概览）；右 = 主题 + 语言。
       运行状态移去侧边栏底部（单独的用例检查），聊天入口撤出顶栏。 */
    expect(appbar).toContain('class="appbar__brand" href="/"');
    expect(appbar).toContain('class="appbar__logo"');
    expect(appbar).toContain('class="brand-mark__tile"');
    expect(appbar).toContain('class="brand-mark__glyph"');
    expect(appbar).toContain('data-i18n="app.brand"');
    expect(PAGE_COMPONENTS_CSS).toContain(".appbar__brand");
    expect(PAGE_COMPONENTS_CSS).toContain(".brand-mark__tile");
    /* 主题是图标按钮（当前态的图标由 app-theme.js 写 use 的 href）；
       三颗状态图标都在精灵里。语言仍是下拉。 */
    expect(appbar).toContain('data-role="theme-button"');
    expect(appbar).toContain('data-role="lang-select"');
    for (const icon of ["sun", "moon", "monitor"]) {
      expect(html).toContain(`<symbol id="icon-${icon}"`);
    }
    expect(appbar).toContain('href="#icon-monitor"');
    /* 顶栏的品牌仍是唯一的链接；右侧是两个控件组：视图动作（刷新）与本机偏好
       （主题循环 + 语言下拉）——共两颗按钮。最左边还有第三颗：侧边栏折叠。 */
    expect((appbar.match(/<button/g) ?? []).length).toBe(3);
    expect(appbar).toContain('data-role="refresh-button"');
    expect(appbar).toContain('class="appbar__actions"');
    expect(appbar).toContain('href="#icon-refresh-cw"');
    expect((appbar.match(/<a\b/g) ?? []).length).toBe(1);
    expect(appbar).not.toContain("data-role=\"server-dot\"");
    expect(appbar).not.toContain("appbar__status");
    // 登录只在添加账号模态里（账号页右上角只剩「出口代理 / 添加账号」），
    // 检查更新在设置页的「服务」组
    expect(html).not.toContain('data-add-provider="zai"');
    expect(html).not.toContain('data-add-provider="bigmodel"');
    expect(html).not.toContain('data-action="accounts-login-zai"');
    expect(html).not.toContain('data-action="accounts-login-bigmodel"');
    expect(html).toContain(`data-action="account-check-update"`);
    expect(html).not.toContain("system-rotate-token");
    /* 版本 / 地址 / 运行时长删掉了（侧边栏状态区已有），
       所以这些只读行在文档里一个都不剩。 */
    for (const role of [
      "system-version",
      "system-panelAddress",
      "system-proxyAddress",
      "system-uptime",
      "system-proxyState",
    ]) {
      expect(html).not.toContain(`data-role="${role}"`);
    }
    // 动作结果挂在顶栏自己那一行上（「退出进程」写它）
    expect(html).toContain('data-role="appbar-note"');
    // 控制面的凭据是用户名 + 密码，页面里没有任何令牌概念。
    expect(html).not.toContain("system-tokenSource");
    expect(html).not.toContain('id="auth-token"');
    /* 顶栏不设聊天按钮；聊天只在侧边栏。
       （断言用正则拼写，避免把那个旧入口的名字写进仓库——门禁要求它零命中。） */
    expect(html).not.toMatch(/chat[-_]?link/i);
    expect(html).not.toMatch(/syncChat/i);
    expect(html).toContain('data-nav="chat"');
    expect(html).not.toContain('target="_blank" rel="noopener"');
  });

  it("moves 退出进程 and 检查更新 out of the service group into the footer", () => {
    const html = renderPanelPage();
    expect(html).toContain('data-action="system-shutdown"');
    expect(html).toContain('data-i18n="settings.shutdown"');
    expect(html).toContain('data-i18n="settings.shutdown.action"');
    /* 两者不是配置（写不进 YAML、不参与热重载），所以离开服务组的字段格，
       进页脚的系统操作区；顺序不变——检查更新在前，退出进程在末。 */
    const footer = html.slice(html.indexOf('<footer class="settings-footer">'), html.indexOf("</footer>"));
    expect(footer).toContain('data-action="account-check-update"');
    expect(footer).toContain('data-action="system-shutdown"');
    expect(footer).toContain('data-role="about-version"');
    expect(footer.indexOf('data-action="account-check-update"')).toBeLessThan(
      footer.indexOf('data-action="system-shutdown"'),
    );
    /* 服务组里不再有它们：那一组只剩端口 / 绑定地址 / 需要 API key / key 链接。 */
    const service = html.slice(html.indexOf('data-group="service"'), html.indexOf('data-group="account"'));
    expect(service).not.toContain('data-action="account-check-update"');
    expect(service).not.toContain('data-action="system-shutdown"');
    expect(service).not.toContain('data-role="about-version"');
    /* 危险操作的按钮与账号页的删除同一个 class（danger 系）。属性跨行写，
       所以按同一开标签里的两个属性判，不按相邻文本。 */
    const shutdownTag = footer.slice(footer.indexOf('data-action="system-shutdown"') - 200, footer.indexOf('data-action="system-shutdown"'));
    expect(shutdownTag).toContain('class="btn btn--danger"');
  });

  it("keeps the settings page to its five groups", () => {
    const html = renderPanelPage();
    for (const key of [
      "settings.group.connection",
      "settings.group.identity",
      "settings.group.subsystems",
      "settings.group.service",
      "settings.group.account",
    ]) {
      expect(html).toContain(`data-i18n="${key}"`);
    }
    // 外观组：主题与语言在顶栏，设置页没有它。
    expect(html).not.toContain('data-i18n="settings.group.appearance"');
    // 数据组与安全组都不在了：前者进了账号页，后者拆到「我的账户」页与顶栏
    for (const key of ["settings.group.data", "settings.group.security"]) {
      expect(html).not.toContain(`data-i18n="${key}"`);
    }
    // 服务组只剩端口 / 绑定地址 / 需要 API key + 指向 /keys 的链接
    for (const role of ["settings-port", "settings-host", "settings-requireKey"]) {
      expect(html).toContain(`data-role="${role}"`);
    }
    // 当前用户 / 退出登录 / 修改密码已经不在这里了
    for (const role of [
      "settings-username",
      "settings-currentPassword",
      "settings-newPassword",
      "settings-confirmPassword",
    ]) {
      expect(html).not.toContain(`data-role="${role}"`);
    }
    for (const action of ["settings-logout", "settings-change-password"]) {
      expect(html).not.toContain(`data-action="${action}"`);
    }
    // 配置文件路径保留成一行只读展示
    expect(html).toContain('data-role="settings-configPath"');
  });

  it("lays the settings page out in four tiers", () => {
    const html = renderPanelPage();
    /* 用完整开标签定位：`settings-grid` 这个词也出现在路由页的注释里（布局说明
       骨架同源），`indexOf("settings-grid")` 会切到注释上；`data-view="settings"`
       也可能出现在样式选择器里。 */
    const settingsOpen = html.indexOf('<div class="page medium" data-view="settings"');
    expect(settingsOpen).toBeGreaterThan(0);
    const view = html.slice(settingsOpen, viewStart(html, "chat"));
    const at = (needle: string): number => {
      const index = view.indexOf(needle);
      expect([needle, index > -1]).toEqual([needle, true]);
      return index;
    };

    /* 四层的文档顺序：主区（连接 + 服务）→ 账户 → 高级（默认收起）→ 页脚。
       顺序就是常驻度：会被反复改的在首屏，低频配置收在折叠区，系统操作垫底。 */
    const gridAt = at('<div class="settings-grid">');
    const accountAt = at('data-group="account"');
    const advancedAt = at('<section class="settings-advanced');
    const footerAt = at('<footer class="settings-footer">');
    expect(view.indexOf('data-advanced-toggle')).toBeGreaterThan(advancedAt);
    expect(gridAt).toBeLessThan(accountAt);
    expect(accountAt).toBeLessThan(advancedAt);
    expect(advancedAt).toBeLessThan(footerAt);

    /* 主区只有连接与服务。账户与高级区不在这张网格里——它们是各自独立的一层。 */
    const grid = view.slice(gridAt, view.indexOf("</div>", view.indexOf('data-group="service"')));
    expect((grid.match(/<section class="group"/g) ?? []).length).toBe(2);
    for (const area of ["connection", "service"]) {
      expect([area, grid.includes(`data-group="${area}"`)]).toEqual([area, true]);
    }
    for (const area of ["identity", "subsystems", "account"]) {
      expect([area, grid.includes(`data-group="${area}"`)]).toEqual([area, false]);
    }

    /* 账户层：独立一层，仍带 `data-group="account"` 与 id（锚点链接落得准）。 */
    const account = view.slice(accountAt, advancedAt);
    expect(account).toContain('id="account"');
    expect(account).toContain("settings.group.account");

    /* 高级区：默认折叠——`hidden`、`aria-expanded="false"`、`data-collapse-open="false"`
       三者同时写在首帧标记上，不靠 JS 也不闪。里面是功能开关 + 身份两组。
       开合不写进 sessionStorage（运行时不调 `App.widgets.apply` 的那一套），
       由视图自己翻 `hidden`（`app-view-settings.js` 的 `bindAdvancedSection`）。 */
    const advanced = view.slice(advancedAt, footerAt);
    expect(advanced).toContain('aria-expanded="false"');
    expect(advanced).toContain('data-collapse-open="false"');
    expect(advanced).toContain('class="collapse__body" id="settings-advanced-body" hidden');
    expect(advanced).toContain("settings.advanced.title");
    for (const area of ["subsystems", "identity"]) {
      expect([area, advanced.includes(`data-group="${area}"`)]).toEqual([area, true]);
    }
    expect(PAGE_APP_SCRIPT).toContain("data-advanced-toggle");
    expect(PAGE_APP_SCRIPT).not.toMatch(/data-collapse="settings-advanced"/);

    /* 页脚：系统操作两组——左边版本 + 检查更新，右边退出进程。 */
    const footer = view.slice(footerAt, view.indexOf("</footer>"));
    expect(footer).toContain('data-role="about-version"');
    expect(footer).toContain('data-action="account-check-update"');
    expect(footer).toContain('data-action="system-shutdown"');
    expect(footer).toContain("settings-footer__group--end");

    /* 组内是字段格（`.field-grid` + `.field-cell`）：标签在上、控件吃满格。
       全项目只有这一种字段骨架。 */
    expect((view.match(/<div class="group__body field-grid">/g) ?? []).length).toBe(5);
    expect((view.match(/class="field-cell/g) ?? []).length).toBeGreaterThan(20);
    /* 每个带 id 的控件都有 `for=` 指到它的标签（标签在字段格上方，逐格成立）。*/
    const ids = [...view.matchAll(/<(?:input|select)[^>]*id="(settings-[a-z-]+)"/g)].map(
      (match) => match[1] as string,
    );
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect([id, view.includes(`for="${id}"`)]).toEqual([id, true]);
  });

  it("keeps four standing hints and folds the rest into the ⓘ disclosure", () => {
    const html = renderPanelPage();
    const settingsOpen = html.indexOf('<div class="page medium" data-view="settings"');
    const view = html.slice(settingsOpen, viewStart(html, "chat"));

    /* 常驻说明恰好四条：绑定地址、需要 API key、身份归一、额度耗尽阈值。
       判据是后果——这四条改了就要立刻看见后果，其余可以收进图标。 */
    const standing = [...view.matchAll(/<p class="hint(?: hint--clip)?" data-i18n="(settings\.[a-zA-Z.]+)"/g)].map(
      (match) => match[1] as string,
    );
    expect(standing.sort()).toEqual([
      "settings.host.hint",
      "settings.normalizeClientSystem.hint",
      "settings.quotaDrainThreshold.hint",
      "settings.requireKey.hint",
    ]);

    /* 其余说明全部收进 ⓘ：结构是「空 `<summary>`（只有 title / aria-label）+ 细节段」。
       原文照搬：每条降级说明的正文仍在 DOM 里（`.hint-details__more`），不是只留一份
       title——点开要读得到全文。 */
    expect((view.match(/<details class="hint-details hint-details--icon">/g) ?? []).length).toBe(14);
    expect(view).not.toContain('<span class="hint-details__text"');
    /* 空 summary：没有文字子节点，标题靠 `data-i18n-attr` 从同一个键写。 */
    const summaries = [...view.matchAll(/<summary data-i18n-attr="title:(settings\.[a-zA-Z.]+),aria-label:[a-zA-Z.]+"><\/summary>/g)];
    expect(summaries.length).toBe(14);
    const folded = new Set(summaries.map((match) => match[1] as string));
    for (const key of ["settings.defaultModel.hint", "settings.port.hint", "settings.appVersion.hint"]) {
      expect([key, folded.has(key)]).toEqual([key, true]);
      // 同一条文案也作为正文出现在细节段里（只有一份原文，两处引用同一个键）。
      expect([key, view.includes(`data-i18n="${key}"`)]).toEqual([key, true]);
    }
    /* 旧的按长度分档那套退场：不再有 `hint-details--full`，脚本里也没有分档函数。 */
    expect(view).not.toContain("hint-details--full");
    expect(PAGE_APP_SCRIPT).not.toContain("hint-details--full");
    expect(PAGE_APP_SCRIPT).not.toContain("hintUnits");
    expect(PAGE_COMPONENTS_CSS).not.toContain(".hint-details--full");
    /* 组件层有新档的规则：图标格 + 命中区 + 展开箭头。 */
    for (const rule of [".hint-details--icon", ".hint-details--icon > summary::before", ".hint-details--icon[open] > summary::after"]) {
      expect([rule, PAGE_COMPONENTS_CSS.includes(rule)]).toEqual([rule, true]);
    }
  });

  it("sizes the settings layers from tokens and collapses them on narrow screens", () => {
    const css = PAGE_COMPONENTS_CSS;
    const grid = css.slice(css.indexOf(".settings-grid {"), css.indexOf(".settings-grid {") + 400);
    expect(grid).toContain("display: grid");
    /* 主区只有两组：两列等宽，不再有按字段数配对的 `grid-template-areas`。 */
    expect(grid).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(grid).toContain("gap: var(--space-5)");
    expect(grid).toContain("align-items: stretch");
    /* 网格作为 `.page-body` 的 flex 子项不参与压缩（同 `.routing-grid`）。 */
    expect(grid).toContain("flex: 0 0 auto");
    expect(grid).not.toContain("grid-template-areas");
    /* 账户组与高级区同理：它们是 `.page-body` 的直接子项，各自钉成不压缩。 */
    expect(css).toContain("[data-view=\"settings\"] > .page-body > .group {");
    expect(css).toContain(".settings-advanced {");
    /* 窄于 1024px 退化成单列。定位到提到 `.settings-grid` 的那个媒体查询块本身：
       页面里还有别的断点（.metrics 的 900px / 600px），按「第一个」取会误判。 */
    const narrow = [...css.matchAll(/@media \(max-width: 1023px\) \{[\s\S]*?\n\}/g)]
      .map((match) => match[0])
      .find((block) => block.includes(".settings-grid"));
    expect(narrow).toBeDefined();
    expect(narrow).toContain("grid-template-columns: 1fr");
    /* 组内字段格：全项目唯一的 `.field-grid`（两列，≤720px 一列），设置页
       不再有自己的一份骨架。 */
    /* 从行首锚定：`.modal .field-grid` 那条（弹窗收一列）在 base.css 里更早出现。 */
    const fieldGrid = css.slice(
      css.indexOf("\n.field-grid {"),
      css.indexOf("\n.field-grid {") + 200,
    );
    expect(fieldGrid).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    const fieldNarrow = [...css.matchAll(/@media \(max-width: 720px\) \{[\s\S]*?\n\}/g)]
      .map((match) => match[0])
      .find((block) => block.includes(".field-grid"));
    expect(fieldNarrow).toBeDefined();
    expect(fieldNarrow).toContain("grid-template-columns: 1fr");
    /* 功能开关组在 ≥1024px 的高级区里排四列（8 格两行）。 */
    const subsystems = [...css.matchAll(/@media \(min-width: 1024px\) \{[\s\S]*?\n\}/g)]
      .map((match) => match[0])
      .find((block) => block.includes('[data-group="subsystems"]'));
    expect(subsystems).toBeDefined();
    expect(subsystems).toContain("grid-template-columns: repeat(4, minmax(0, 1fr))");
  });

  it("flattens the sidebar to eight items in frequency order", () => {
    const html = renderPanelPage();
    const sidebar = html.slice(html.indexOf('<nav class="sidebar"'), html.indexOf("</nav>"));
    /* 没有分组标题：`.sidebar__label` 与四组文案都从页面与字典里消失了。 */
    expect(sidebar).not.toContain("sidebar__label");
    for (const key of ["nav.group.monitor", "nav.group.manage", "nav.group.system", "nav.group.account"]) {
      expect(html).not.toContain(`data-i18n="${key}"`);
    }
    /* 八项按文档顺序排列。聊天不是链接：它没有服务端路径，是一个视图切换按钮
       （href 为 undefined，其余仍是整页导航的锚点）。统计紧跟概览：概览的今日卡与
       时序缩略都跳它的「今天」范围。代理不占一级导航：它是账号页抽屉里的字典。 */
    const items = [...sidebar.matchAll(/<a class="nav" href="([^"]+)" data-nav="([^"]+)"|<button type="button" class="nav" data-nav="([^"]+)"/g)].map(
      (match): [string, string | null] => [match[2] ?? match[3] ?? "", match[1] ?? null],
    );
    const expected: Array<[string, string | null]> = [
      ["overview", "/"],
      ["stats", "/stats"],
      ["chat", null],
      ["accounts", "/accounts"],
      ["routing", "/routing"],
      ["keys", "/keys"],
      ["settings", "/settings"],
      ["logs", "/logs"],
    ];
    expect(items).toEqual(expected);
  });

  it("gives every sidebar item a token-sized aria-hidden icon", () => {
    const html = renderPanelPage();
    const sidebar = html.slice(html.indexOf('<nav class="sidebar"'), html.indexOf("</nav>"));
    /* 图标：path 数据只出现一次（页面顶部那一份精灵），每个导航项用 `<use>` 引用。
       `network` 精灵符号随代理导航项一起退场。 */
    const slugs = ["layout-grid", "chart-column", "message-square", "users", "git-branch", "key-round", "settings", "scroll-text"];
    for (const slug of slugs) expect(html).toContain(`<symbol id="icon-${slug}"`);
    expect(html).not.toContain('<symbol id="icon-network"');
    expect((sidebar.match(/<svg class="nav__icon"/g) ?? []).length).toBe(8);
    // 图标是装饰：每一处都带 aria-hidden
    for (const match of sidebar.matchAll(/<svg class="nav__icon"([^>]*)>/g)) {
      expect([match[1], (match[1] ?? "").includes('aria-hidden="true"')]).toEqual([match[1], true]);
    }
  });

  it("moves the account page into the settings account tier", () => {
    const html = renderPanelPage();
    expect(html).not.toContain('data-view="account"');
    /* 三件事（用户名 / 改密码 / 退出登录）全在设置页的「账户」组里。
       这一组是独立的一层（不在主网格里），定位从 `id="account"` 起、到
       高级区之前。 */
    const settingsOpen = html.indexOf('<div class="page medium" data-view="settings"');
    const view = html.slice(settingsOpen, viewStart(html, "chat"));
    const accountGroup = view.slice(view.indexOf('id="account"'), view.indexOf('data-advanced-toggle'));
    for (const role of [
      "account-username",
      "account-currentPassword",
      "account-newPassword",
      "account-confirmPassword",
      "account-error",
      "account-notice",
    ]) {
      expect([role, accountGroup.includes(`data-role="${role}"`)]).toEqual([role, true]);
    }
    for (const action of ["account-logout", "account-save-password"]) {
      expect([action, accountGroup.includes(`data-action="${action}"`)]).toEqual([action, true]);
    }
    for (const key of [
      "account.username",
      "account.logout",
      "account.password.current",
      "account.password.new",
      "account.password.confirm",
      "account.password.save",
    ]) {
      expect([key, accountGroup.includes(`data-i18n="${key}"`)]).toEqual([key, true]);
    }
    /* 「改完之后其他设备上的登录会失效」不再常驻一行：收进保存键的 title（同一个键）。 */
    expect(accountGroup).toContain('data-i18n-attr="title:account.password.hint"');
    expect(accountGroup).not.toMatch(/<span class="hint" data-i18n="account\.password\.hint"/);
    /* 检查更新与版本在页脚：它们是这个服务的属性，不是一组独立配置。 */
    expect(html).toContain('data-action="account-check-update"');
    expect(html).toContain('data-role="about-version"');
  });

  it("keeps theme and language in the appbar (theme as an icon button)", () => {
    const html = renderPanelPage();
    const appbar = html.slice(html.indexOf('<header class="appbar">'), html.indexOf("</header>"));
    /* 主题与语言在顶栏右侧；设置页没有第二份触发点。主题是
       三态循环的图标按钮（sun / moon / monitor），语言仍是下拉。 */
    for (const role of ["theme-button", "lang-select"]) {
      expect([role, appbar.includes(`data-role="${role}"`)]).toEqual([role, true]);
    }
    // 按钮里的图标是精灵引用，初始态画「跟随系统」的那颗（monitor）
    expect(appbar).toContain('data-role="theme-icon"');
    expect(appbar).toContain('href="#icon-monitor"');
    // 按钮有可访问的名字（静态兑底「主题」，完整态名由 app-theme.js 按当前态写）
    expect(appbar).toContain('aria-label:prefs.theme');
    expect(appbar).toContain('aria-label:prefs.language');
    // 设置页里不再重复
    const grid = html.slice(html.indexOf('<div class="settings-grid">'), html.indexOf("</main>"));
    expect(grid).not.toContain('settings-theme');
    expect(grid).not.toContain('settings-lang');
  });

  it("keeps the page-level refresh controls folded into the appbar", () => {
    const html = renderPanelPage();
    const appbar = html.slice(html.indexOf('<header class="appbar">'), html.indexOf("</header>"));
    /* 顶栏右侧多了一个动作组：刷新当前视图。图标是精灵引用（Lucide refresh-cw），
       与主题图标同一套形属性（.appbar__theme-icon, .appbar__refresh-icon）。 */
    expect(appbar).toContain('class="appbar__actions"');
    expect(appbar).toContain('data-role="refresh-button"');
    expect(appbar).toContain('data-role="refresh-icon"');
    expect(appbar).toContain('href="#icon-refresh-cw"');
    expect(html).toContain('<symbol id="icon-refresh-cw"');
    // 静态兑底名只有一个（「刷新当前视图」）；置灰态那句只在运行时写
    expect(appbar).toContain("aria-label:refresh.title");
    const zh = PAGE_DICTIONARIES.zh as Record<string, string>;
    for (const key of ["refresh.title", "refresh.disabled"]) {
      expect([key, typeof zh[key]]).toEqual([key, "string"]);
    }
    expect(PAGE_COMPONENTS_CSS).toContain(".appbar__actions");
    expect(PAGE_COMPONENTS_CSS).toContain(".appbar__refresh-icon");
    expect(PAGE_COMPONENTS_CSS).toContain("appbar__refresh-icon--spinning");

    /* 页内重复的刷新入口都并进这一颗按钮：统计页范围栏的「刷新」与
       设置页页头的「重新读取」都不在文档里了。 */
    expect(html).not.toContain('data-role="stats-refresh"');
    expect(html).not.toContain('data-action="reload-settings"');
    const settings = html.slice(viewStart(html, "settings"), viewStart(html, "chat"));
    expect(settings).not.toContain('page-header__actions');
    expect(html).not.toContain('data-i18n="settings.reload"');
  });

  it("assembles the login page with the same three layers and no panel chrome", () => {
    const html = renderLoginPage();
    expect(html).not.toContain("<!-- THEME-BOOT -->");
    expect(html).not.toContain("/* I18N */");
    expect(html).not.toContain("/* LOGIN */");
    expect(html).toContain(PAGE_TOKENS_CSS.slice(0, 40));
    expect(html).toContain(PAGE_COMPONENTS_CSS.slice(0, 40));
    expect(html).toContain(LOGIN_PAGE_SCRIPT.slice(0, 40));
    // 只有用户名、密码、登录按钮与错误行；没有侧边栏，也没有令牌输入框。
    for (const role of ["login-form", "login-username", "login-password", "login-submit", "login-error"]) {
      expect(html).toContain(`data-role="${role}"`);
    }
    expect(html).not.toContain("data-nav=");
    expect(html).not.toContain("auth-token");
  });

  it("keeps the overview down to live data", () => {
    const html = renderPanelPage();
    /* 侧边栏底部的状态区：四项合并，标签退到 title（地址 / 版本 /
       运行时长不再占一行字）。「运行中 / 已停止」那一项不在了：能看到这一页
       就说明网关在跑。 */
    for (const role of ["server-dot", "server-address", "server-version", "server-inflight", "server-uptime"]) {
      expect(html).toContain(`data-role="${role}"`);
    }
    expect(html).not.toContain('data-role="server-port"');
    expect(html).not.toContain('data-role="server-state"');
    /* 「状态」面板整块删掉：五行键值对与那一块 section 都不在了。 */
    expect(html).not.toContain('data-i18n="overview.status.title"');
    for (const role of ["ov-running", "ov-port", "ov-version", "ov-inflight", "ov-uptime"]) {
      expect(html).not.toContain(`data-role="${role}"`);
    }
    /* 八张指标卡：`.metrics` 四等分两行，卡片是 `.card--metric`；
       后四张是 getUsageStats 的「今天」范围。*/
    expect(html).toContain('<div class="metrics">');
    expect((html.match(/card card--metric/g) ?? []).length).toBe(8);
    expect(html).not.toContain("grid--metrics");
    /* 每张卡都是一个链接：整卡可点，不是死数字。前三个去账号页，
       「并发上限」去路由策略页的「队列」组——改它的输入框在那儿；
       三张今日卡（请求 / token / 速率）都去统计视图的「今天」范围。
       错误数卡不是整卡链接（卡里有两组跳转），所以这里只剩七张。 */
    const metrics = html.slice(html.indexOf('<div class="metrics">'), html.indexOf('<section class="panel">'));
    const links = [...metrics.matchAll(/<a class="card card--metric card--link" href="([^"]+)">/g)].map(
      (match) => match[1] as string,
    );
    expect(links).toEqual([
      "/accounts",
      "/accounts",
      "/accounts",
      "/routing",
      "/stats?range=today",
      "/stats?range=today",
      "/stats?range=today",
    ]);
    /* 错误数卡：数字链去日志页的「错误的请求」，下方阶段分布容器在。 */
    expect(metrics).toContain('class="card card--metric card--errors"');
    expect(metrics).toContain('data-role="usage-errors" href="/logs?tab=requests&status=error"');
    expect(metrics).toContain('class="card__stages" data-role="usage-error-stages" hidden');
    /* 整卡可点意味着卡片里不能再套链接：八个 `data-role` 的数值格各出现一次。 */
    for (const role of [
      "metric-accounts",
      "metric-healthy",
      "metric-inflight",
      "metric-limit",
      "usage-requests",
      "usage-tokens",
      "usage-avg-rate",
      "usage-errors",
    ]) {
      expect([role, metrics.includes(`data-role="${role}"`)]).toEqual([role, true]);
    }
    /* 风控横幅：整条不是链接——每条告警自己带落点（风控码 → 账号页，
       共用出口 → 代理页），所以横幅本体是容器，文字容器仍是 `risk-text`。 */
    expect(html).toContain('<div class="banner banner--warn" data-role="risk-banner" hidden>');
    expect(html).toContain('class="banner__items" data-role="risk-text"');
    /* 无数据收缩：两处提示是一行式的 `.empty-inline`，不是带虚线框的 `.empty` */
    for (const role of ["chart-empty", "accounts-empty"]) {
      expect(html).toContain(`class="empty-inline" data-role="${role}"`);
    }
    expect(html).toContain('data-role="chart-meta"');
    /* 风控横幅：有告警才出现，带图标与一行告警文字（每条告警各自可点）*/
    expect(html).toContain('class="banner banner--warn" data-role="risk-banner" hidden');
    expect(html).toContain('data-role="risk-text"');
    expect(html).not.toContain('data-role="risk-alerts"');
  });

  it("centres the login card and labels every input", () => {
    /* 登录页：一张 360px 的卡片居中，两个输入框都是全宽字段。*/
    const html = renderLoginPage();
    expect(html).toContain('<main class="login-page">');
    expect(html).toContain('class="login-card"');
    // 品牌图形：装饰性，不进可读文本（与顶栏品牌同一套自绘 SVG）
    expect(html).toContain('class="login-card__mark"');
    expect(html).toContain('class="brand-mark__tile"');
    expect(html).toContain('class="brand-mark__glyph"');
    expect(html).not.toContain(">Z</span>");
    expect(html).toContain('class="btn btn--primary btn--block"');
    // 语言切换保留（搬到卡片底部），不再有顶栏
    expect(html).toContain('id="prefs-lang"');
    expect(html).not.toContain('class="appbar"');

    /* 可访问性：每个输入框都有一个 `for` 指向自己的 `<label>`。*/
    const ids = [...html.matchAll(/<input[^>]*id="(login-[a-z]+)"/g)].map((match) => match[1] as string);
    expect(ids.sort()).toEqual(["login-password", "login-username"]);
    for (const id of ids) {
      expect([id, html.includes(`<label class="login-field__label" for="${id}"`)]).toEqual([id, true]);
    }
    // 密码管理器靠这两个自动填充提示认出「用户名」与「当前密码」
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain('autocomplete="current-password"');
    /* 用户名预填 admin：控制面只有管理员一个身份，焦点因此直接落在
       密码框（预填值仍可被 autofill / 手填覆盖，密码永远不预填）。 */
    const usernameInput = html.slice(html.indexOf('id="login-username"'), html.indexOf('data-role="login-username"'));
    expect(usernameInput).toContain('value="admin"');
    expect(html).toContain('passwordNode');
    expect(LOGIN_PAGE_SCRIPT).toContain("if (password) password.focus();");
    /* 错误提示是可播报的 live region；`hidden` 挂在里面的横幅上，外层常驻。*/
    expect(html).toContain('data-role="login-error" aria-live="polite"');
    expect(html).toContain('data-role="login-error-banner" hidden');
    expect(LOGIN_PAGE_SCRIPT).toContain('byRole("login-error-banner")');

  });

  it("opens every page with the same shell: page-header above page-body", () => {
    const html = renderPanelPage();
    /* 每个视图 = `.page.<密度档>` 容器，里面**只有两块**：`.page-header`（标题 +
       说明 + 全局动作，固定不动）与 `.page-body`（flow 时自己滚，fill 时交给
       `.fill-region`）。平铺兄弟元素的结构表达不了「哪块固定、哪块滚」。 */
    /* 只抓视图开标签：`data-view="x"` 也可能出现在 CSS 选择器里，
       裸正则会把样式当视图。 */
    const views = [...html.matchAll(/<div class="page[^"]*" data-view="([a-z]+)"/g)].map((m) => m[1] as string);
    expect(views).toEqual(["overview", "stats", "accounts", "routing", "keys", "logs", "settings", "chat"]);
    /** 页面骨架里的注释：可以出现在任意两个元素之间。 */
    const gap: RegExp = /(?:\s|<!--[\s\S]*?-->)/;
    /* fill 模式只有两页：聊天（输入框必须始终可见）与日志（日志流吃掉剩余高度）。
       其余七页是 flow：整页正文在 `.page-body` 里滚，页头不动。 */
    const fill = new Set(["logs", "chat"]);
    for (const view of views) {
      const at = viewStart(html, view);
      const start = at;
      const nextView = html.indexOf('\n          <div class="page', at + 1);
      const window = html.slice(start, nextView < 0 ? html.length : nextView);
      const shell = new RegExp(
        `^<div class="page[^"]*" data-view="[a-z]+"( hidden)?>${gap.source}*` +
          `<header class="page-header">${gap.source}*<div class="page-header__heading">${gap.source}*` +
          `<h1 class="page-title"${gap.source}[\\s\\S]*?</header>${gap.source}*` +
          `<div class="page-body( page-body--fill)?">`,
      );
      expect([view, shell.test(window)]).toEqual([view, true]);
      /* 模式归属写在页面上：fill 只有那两页，多一页就是判据写错了。 */
      expect([view, window.includes('class="page-body page-body--fill"')]).toEqual([view, fill.has(view)]);
      /* 标题不再藏在工具栏里（那样「标题」与「工具栏」就是同一层，规则落不了地）。 */
      expect([view, /class="toolbar">\s*<h1/.test(window)]).toEqual([view, false]);
      /* 横幅在标题之后、在第一块内容之前（不是块之间的补充说明）。 */
      const banner = window.indexOf('<div class="banner');
      const content = window.search(/<section class="panel"|<div class="metrics">|<div class="settings-grid">/);
      if (banner >= 0 && content >= 0) expect([view, banner < content]).toEqual([view, true]);
    }
  });

  it("serves the same document for all page paths", () => {
    // 单套 HTML：视图切换在客户端，服务端每次拼出同样的字节。
    expect(renderPanelPage()).toBe(renderPanelPage());
  });
});

describe("chat view in the panel", () => {
  it("ships the chat view inside the panel document, not as its own page", () => {
    const html = renderPanelPage();
    // 视图容器在面板文档里：PageHeader + 双横幅（错误/提示）+ 会话栏 + 四层下拉 + 对话区。
    expect(html).toContain('data-view="chat" hidden');
    for (const role of [
      "chat-error",
      "chat-error-text",
      "chat-notice",
      "chat-notice-text",
      "chat-sidebar",
      "chat-session-list",
      "chat-session-select",
      "chat-new",
      "chat-new-narrow",
      "chat-delete-narrow",
      "chat-account",
      "chat-route",
      "chat-key",
      "chat-key-row",
      "chat-key-select",
      "chat-key-manual",
      "chat-key-remember",
      "chat-key-apply",
      "chat-key-hint",
      "chat-model",
      "chat-empty",
      "chat-log",
      "chat-form",
      "chat-input",
      "chat-status",
      "chat-stop",
      "chat-send",
      // 选择器区折叠成 CollapsibleSection（标题行带当前组合摘要），
      // 输入区带附件按钮、隐藏 file input 与预览缩略条。
      "chat-selectors-summary",
      "chat-attach",
      "chat-file-input",
      "chat-previews",
    ]) {
      expect(html).toContain(`data-role="${role}"`);
    }
    // 选择器区是 CollapsibleSection（.collapse），不是裸 panel。
    expect(html).toContain('class="collapse chat__settings"');
    expect(html).toContain('data-collapse="chat-selectors"');
    /* 默认收起（摘要在标题行）——展开要占 ~150px，而聊天时它只是配好就不
       动的设置。默认值同时写在 `data-collapse-default`（App.widgets 的真值）与
       初始投影上，首帧不靠 JS 也不闪。*/
    expect(html).toContain('data-collapse-default="closed"');
    expect(html).toContain('data-collapse-open="false"');
    // 附件 file input 接受图片与文本类扩展（类型分流的前置提示，不做硬门禁）。
    const fileInputAt = html.indexOf('class="chat__fileinput"');
    const fileInput = html.slice(fileInputAt, fileInputAt + 600);
    expect(fileInput).toContain("multiple");
    expect(fileInput).toContain("image/");
    // 附件按钮与芯片用的三个 Lucide 图标进精灵（paperclip / image / file-text），
    // 再加新建按钮的 plus——同一个精灵同一套线性画法。
    for (const slug of ["paperclip", "image", "file-text", "plus"]) {
      expect(html).toContain(`<symbol id="icon-${slug}"`);
    }
    // 新建按钮是整宽长方形（居中一个加号），附件按钮带 muted 态的类。
    // 新建按钮在会话列表容器里（与列表项共用同一个内容框，滚动条出现时两者
    // 一起被收窄），所以切片边界是「会话栏」到「列表项的容器」。
    const sidebarAt = html.indexOf('data-role="chat-sidebar"');
    const sidebarHtml = html.slice(sidebarAt, html.indexOf('data-role="chat-session-items"'));
    expect(sidebarHtml).toContain('class="btn chat__new"');
    expect(sidebarHtml).toContain('#icon-plus');
    expect(sidebarHtml).not.toContain('>新建</button>');
    expect(html).toContain('class="btn btn--icon chat__attach"');
    // 运行时带着视图模块（page.ts 的 APP_MODULES）。
    expect(PAGE_APP_SCRIPT).toContain(read("app-view-chat.js").slice(0, 40));
    // 独立页的骨架与占位符不再存在。
    expect(html).not.toContain("/* CHAT */");
  });

  it("covers every chat key the view asks for, in both dictionaries", () => {
    const zh = PAGE_DICTIONARIES.zh as Record<string, string>;
    const en = PAGE_DICTIONARIES.en as Record<string, string>;
    /* 运行时拼出来的句子（角色名 / 状态 / 错误）不在 HTML 里，所以扫一遍脚本里的
       `chat.*` 字面量（旧 chat.test.ts 的字典测试随迁移搬进这里）。*/
    const needed = new Set<string>();
    for (const match of PAGE_APP_SCRIPT.matchAll(/"(chat\.[a-z.]+)"/g)) needed.add(match[1] as string);

    const missing = [...needed].filter((key) => zh[key] === undefined || en[key] === undefined);
    expect(missing).toEqual([]);
    // 独立页专属的键随退场删掉；顶栏按钮的置灰态也不存在了。
    for (const key of ["chat.title", "chat.brand", "system.chat.unavailable"]) {
      expect([key, zh[key] === undefined && en[key] === undefined]).toEqual([key, true]);
    }
  });

  it("styles the chat components from tokens like the rest of the panel", () => {
    const css = PAGE_COMPONENTS_CSS;
    const html = renderPanelPage();
    for (const className of [
      ".chat__log",
      ".chat__msg",
      ".chat__msg--user",
      ".chat__role",
      ".chat__composer",
      // 附件流的三块组件 + 折叠选择器区。
      ".chat__previews",
      ".chat__preview",
      ".chat__preview--file",
      ".chat__preview-remove",
      ".chat__inputrow",
      ".btn--icon",
      ".chat__msg-media",
      ".chat__msg-img",
      ".chat__filechip",
      ".chat__settings-grid",
      ".chat__settings-summary",
    ]) {
      expect([className, css.includes(className)]).toEqual([className, true]);
    }
    // 对话区没有固定高度，它就是 fill 的滚动块（HTML 上带 .fill-region）。
    const log = css.slice(css.indexOf(".chat__log {"), css.indexOf(".chat__msg {"));
    expect(log).not.toContain("height:");
    expect(html).toContain('class="chat__log fill-region"');
    // fill 链：面板是传递高度的容器，网格行高必须能缩小到 0。
    expect(html).toContain('class="chat__layout fill-chain"');
    expect(html).toContain('class="panel chat__panel fill-chain"');
    const layout = css.slice(css.indexOf(".chat__layout {"), css.indexOf(".chat__sidebar {"));
    expect(layout).toContain("grid-template-rows: minmax(0, 1fr)");
    expect(layout).toContain("min-height: 0");
    // 会话栏框体：与右侧面板同一套边界语言（1px --line、8px 圆角）。
    const sidebar = css.slice(css.indexOf(".chat__sidebar {"), css.indexOf(".chat__sidebar-title"));
    expect(sidebar).toContain("border: 1px solid var(--line)");
    expect(sidebar).toContain("border-radius: var(--radius-md)");
    expect(sidebar).toContain("padding: var(--space-5)");
    // 精灵图标走 Lucide 线性画法（fill 关掉、stroke 跟 currentColor），
    // 附件 / 新建按钮 muted 常态 hover 亮起。
    const btnIcon = css.slice(css.indexOf(".btn__icon {"), css.indexOf(".chat__attach"));
    expect(btnIcon).toContain("fill: none");
    expect(btnIcon).toContain("stroke: currentColor");
    const attach = css.slice(css.indexOf(".chat__attach {"), css.indexOf(".chat__new {"));
    expect(attach).toContain("var(--muted)");
    const chatNew = css.slice(css.indexOf(".chat__new {"), css.indexOf(".chat__new:hover"));
    expect(chatNew).toContain("width: 100%");
  });
});

describe("shell space: collapsible sidebar, per-view widths, chat rhythm", () => {
  const html = renderPanelPage();
  const css = PAGE_COMPONENTS_CSS;
  const tokens = PAGE_TOKENS_CSS;

  it("ships both sidebar widths as tokens and a transition between them", () => {
    /* 折叠态 56px 由图标（20）推出来：20 + 两侧各 8 内边距 + 两档余量，
       与 `--layout-sidebar`（232）同一块注释里的理由。 */
    expect(tokens).toContain("--layout-sidebar: 232px;");
    expect(tokens).toContain("--layout-sidebar-collapsed: 56px;");
    const collapsed = css.slice(css.indexOf('html[data-sidebar="collapsed"] .sidebar {'), css.indexOf('html[data-sidebar="collapsed"] .nav {'));
    expect(collapsed).toContain("flex-basis: var(--layout-sidebar-collapsed)");
    expect(collapsed).toContain("width: var(--layout-sidebar-collapsed)");
    /* 平滑不跳：宽度与内边距都走 `--motion-fast`，减少动态偏好下关掉。 */
    const sidebar = css.slice(css.indexOf("\n.sidebar {"), css.indexOf("\n.sidebar__status {"));
    expect(sidebar).toContain("transition: flex-basis var(--motion-fast) ease, width var(--motion-fast) ease");
    /* 减少动态偏好下直接落位——这条必须排在基规则**之后**（同为单类选择器，
       源序决定胜负；写在文件早先的 reduce 块里会被后面的 transition 盖掉）。 */
    const reduceAt = css.lastIndexOf("prefers-reduced-motion: reduce");
    expect(reduceAt).toBeGreaterThan(css.indexOf("\n.sidebar {"));
    expect(css.slice(reduceAt)).toContain(".sidebar {\n    transition: none;");
  });

  it("hides the labels and the status text, and centres the icons when collapsed", () => {
    /* 标签是导航项里的 `<span data-i18n>`（图标是兄弟节点），收起标签不动图标。 */
    expect(css).toContain('html[data-sidebar="collapsed"] .nav > span {');
    const nav = css.slice(css.indexOf('html[data-sidebar="collapsed"] .nav {'), css.indexOf('html[data-sidebar="collapsed"] .nav > span {'));
    expect(nav).toContain("justify-content: center");
    /* 状态区：只留健康圆点（居中），地址与「版本 · 在飞 · 运行时长」收起。 */
    expect(css).toContain('html[data-sidebar="collapsed"] .sidebar__status-address,');
    expect(css).toContain('html[data-sidebar="collapsed"] .sidebar__status-row + .sidebar__status-row {');
  });

  it("puts the toggle in the appbar with both Lucide icons in the sprite", () => {
    for (const slug of ["panel-left-close", "panel-left-open"]) {
      expect(html).toContain(`<symbol id="icon-${slug}"`);
    }
    /* 按钮在品牌之前（顶栏最左侧），两态图标由运行时写 `use` 的 href。 */
    const toggleAt = html.indexOf('data-role="sidebar-toggle"');
    expect(toggleAt).toBeGreaterThan(-1);
    expect(html.indexOf('data-role="sidebar-toggle"')).toBeLessThan(html.indexOf('class="appbar__brand"'));
    const button = html.slice(html.lastIndexOf("<button", toggleAt), toggleAt + 400);
    expect(button).toContain('class="btn btn--icon appbar__sidebar-toggle"');
    expect(button).toContain('aria-controls="sidebar"');
    expect(button).toContain('aria-expanded="true"');
    expect(button).toContain("#icon-panel-left-close");
    /* 图标与顶栏另两颗同一套笔触与尺寸（`--layout-icon`）。漏了这一条，
       `<svg>` 会按默认的 300×150 渲染并默认填黑——不是小一号，是一块黑矩形。 */
    const icon = css.slice(css.indexOf(".appbar__theme-icon,"), css.indexOf(".appbar__refresh-icon--spinning"));
    expect(icon).toContain(".appbar__sidebar-icon");
    expect(icon).toContain("width: var(--layout-icon)");
    expect(icon).toContain("fill: none");
    expect(icon).toContain("stroke: currentColor");
    /* 窄屏（≤720px）侧边栏退场，按钮随之隐藏。选择器两个类（`.btn.appbar__sidebar-toggle`）：
       `.btn.btn--icon` 的 `display: inline-grid` 与它同特异性，单类选择器会被盖掉。 */
    expect(css).toContain(".btn.appbar__sidebar-toggle {\n    display: none;");
  });

  it("persists the state through localStorage, with a boot step before the stylesheets", () => {
    expect(PAGE_APP_SCRIPT).toContain('SIDEBAR_STORAGE_KEY: "zcode-sidebar"');
    expect(PAGE_APP_SCRIPT).toContain('SIDEBAR_ATTR: "data-sidebar"');
    expect(PAGE_APP_SCRIPT).toContain(read("app-sidebar.js").slice(0, 40));
    /* 首屏防闪烁：`data-sidebar` 必须在两个 `<style>` 之前写下（否则刷新会先
       画一帧展开态再横跳 176px）。 */
    const bootAt = html.indexOf('localStorage.getItem("zcode-sidebar")');
    expect(bootAt).toBeGreaterThan(-1);
    expect(bootAt).toBeLessThan(html.indexOf("--space-1:"));
  });

  it("gives every view one content column and caps the components themselves", () => {
    for (const token of ["--layout-content-gutter", "--layout-metric-max", "--layout-field-grid-max", "--layout-reader-max", "--layout-composer-max"]) {
      expect(tokens).toContain(`${token}:`);
    }
    for (const retired of ["--layout-content-max", "--layout-content-wide", "--layout-content-settings", "--layout-content-current", "page--wide", "page--full"]) {
      expect(`${css}\n${tokens}\n${html}`).not.toContain(retired);
    }
    /* 顶栏与内容列的 gutter 同源，页头与正文都吃满这一列。 */
    expect(css).toContain("padding: 0 var(--layout-content-gutter);");
    expect(css).toContain("padding: var(--layout-content-gutter);");
    expect(css).toContain(".page > .page-header,\n.page > .page-body {\n  width: 100%;\n}");
    expect(css).not.toContain("min-width: 1440px");
    /* 没有页面档位之后，动作区的 margin-left: auto 以内容列右缘为参照。 */
    expect(css).toContain(".page-header__actions {\n  display: flex;\n  align-items: center;\n  gap: var(--space-2);\n  margin-left: auto;\n}");
    /* 组件自己的上限：布局网格、四列指标卡、字段控件、图表与长表格、输入区。 */
    expect(css).toContain(".metrics {\n  display: grid;\n  grid-template-columns: repeat(4, minmax(0, min(var(--layout-metric-max), 100%)));");
    for (const selector of [".chart__frame,", "[data-role=\"stats-group-table\"],", "[data-role=\"page-accounts-table\"],", "[data-role=\"keys-table\"],", "[data-role=\"req-table\"],", ".table-scroll {"]) {
      expect(css).toContain(selector);
    }
    expect(css).toContain("max-width: var(--layout-reader-max);");
    expect(css).toContain("max-width: var(--layout-composer-max);");
    expect(css).toContain(".field-grid {\n  max-width: var(--layout-field-grid-max);\n}");
    expect(css).toContain(".settings-grid,\n.routing-grid,\n.stats,\n.stats-cols,\n.chat__layout {\n  width: 100%;\n}");
    /* 热力图不读组件上限：格子缸与月轴仍是 1fr 撑满面板。 */
    expect(css).toContain("repeat(var(--heatmap-cols, 53), minmax(12px, 1fr))");
    /* 八个视图的 .page 只保留密度档，不再声明宽度语义。 */
    const opens = [...html.matchAll(/<div class="page([^"]*)" data-view="([a-z]+)"/g)];
    expect(opens.map((m) => m[2])).toEqual(["overview", "stats", "accounts", "routing", "keys", "logs", "settings", "chat"]);
    for (const match of opens) {
      expect(match[1].trim()).toMatch(/^(comfortable|medium|dense)$/);
      expect(match[1]).not.toContain("page--");
    }
  });

  it("opens up the chat rhythm: 12px between bubbles, 12/16 inside, 240px session rail", () => {
    const log = css.slice(css.indexOf(".chat__log {"), css.indexOf(".chat__msg {"));
    expect(log).toContain("gap: var(--space-3)");
    const msg = css.slice(css.indexOf(".chat__msg {"), css.indexOf(".chat__msg--user {"));
    expect(msg).toContain("padding: var(--space-3) var(--space-4)");
    const layout = css.slice(css.indexOf(".chat__layout {"), css.indexOf(".chat__main {"));
    expect(layout).toContain("grid-template-columns: minmax(180px, 240px) minmax(0, 1fr)");
    /* 三块之间仍然留 --space-5（20px）的呼吸：气泡的行距不能连主布局的格间距。 */
    expect(layout).toContain("gap: var(--space-5)");
  });
});

describe("i18n dictionaries", () => {
  const zh = PAGE_DICTIONARIES.zh as Record<string, string>;
  const en = PAGE_DICTIONARIES.en as Record<string, string>;

  it("carries exactly the same key set in both languages", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it("carries the log/settings segments (logs.requests / settings.dump / reqStatus options) in both languages", () => {
    /* 两套字典的键集合相等是上一条用例的事；这里钉住这几个段真的存在，
       避免以后某个键从两边同时消失（相等性测试对“都没有”无感）。*/
    const groups: Array<[string, string[]]> = [
      ["logs.tab", ["system", "requests"]],
      ["logs.requests.col", ["time", "reqId", "request", "source", "model", "status", "latency", "cache", "effort", "attempts", "tps", "tokens", "key", "error"]],
      ["logs.requests", ["empty", "account.all", "route", "route.all", "status", "model", "model.all", "key", "key.all", "key.none", "search", "searchHint"]],
      ["logs.requests.history", ["more", "loading"]],
      ["settings.dump", ["", "hint", "risk", "path"]],
      ["option.reqStatus", ["all", "2xx", "4xx", "5xx", "error", "pending"]],
    ];
    for (const [prefix, suffixes] of groups) {
      for (const suffix of suffixes) {
        const key = prefix + (suffix ? "." + suffix : "");
        expect([key, typeof zh[key] === "string" && typeof en[key] === "string"]).toEqual([key, true]);
      }
    }
  });

  it("carries the disambiguation keys (分子点名 剩 / 已用) in both languages", () => {
    /* 展示层每个百分比/数量都报出自己的口径——额度格「剩 X/Y」「剩 N%」
       （剩余语义，与条同向）、窗口 title「已用 X / 总量 Y」（显式点名 used/total
       对）。两平面 percentage 语义相反，裸数字会被反向误读。*/
    for (const key of [
      "accounts.quota.remainingPercent",
      "accounts.quota.remainingPair",
      "accounts.quota.usedPair",
    ]) {
      expect([key, typeof zh[key] === "string" && typeof en[key] === "string"]).toEqual([key, true]);
    }
  });

  it("has no empty translation", () => {
    for (const [key, value] of Object.entries(zh)) expect([key, value.trim()]).not.toEqual([key, ""]);
    for (const [key, value] of Object.entries(en)) expect([key, value.trim()]).not.toEqual([key, ""]);
  });

  it("interpolates the same variables in both languages", () => {
    /** `{{var}}` 占位符必须两边一致，否则切换语言就会丢掉数字。*/
    const vars = (text: string): string[] => (text.match(/\{\{\w+\}\}/g) ?? []).slice().sort();
    for (const key of Object.keys(zh)) expect([key, vars(zh[key] as string)]).toEqual([key, vars(en[key] as string)]);
  });

  it("covers every key the page asks for", () => {
    /* HTML 注释里也会出现 `data-i18n` 字样（文档随手写的示例），先剔掉注释再扫。*/
    const html = renderPanelPage().replace(/<!--[\s\S]*?-->/g, "");
    const needed = new Set<string>();
    for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) needed.add(match[1] as string);
    for (const match of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
      for (const pair of (match[1] as string).split(",")) {
        const key = pair.split(":")[1];
        if (key) needed.add(key.trim());
      }
    }
    for (const key of needed) expect([key, zh[key] !== undefined]).toEqual([key, true]);
  });

  it("covers every backend error code the control surface can return", () => {
    // 控制面把失败当成稳定字符串码返回；每个码都必须有翻译，否则会以英文原文露出。
    const controlSource = readFileSync(join(WEB_DIR, "..", "..", "control", "control.ts"), "utf8");
    const codes = new Set<string>();
    for (const match of controlSource.matchAll(/error: "([a-z_]+)"/g)) codes.add(match[1] as string);
    for (const match of controlSource.matchAll(/"([a-z_]+)",\s*\/\/ /g)) codes.add(match[1] as string);
    // `ACCOUNT_ERROR_CODES` 的映射值，以及面板自己产生的码。
    for (const match of controlSource.matchAll(/"[a-z-]+": "([a-z_]+)"/g)) codes.add(match[1] as string);
    codes.add("network_error");
    codes.add("unauthorized");

    const missing = [...codes].filter((code) => zh[`error.${code}`] === undefined);
    expect(missing).toEqual([]);
  });

  it("uses the shared vocabulary for the shared terms", () => {
    const terms = (dictionary: Record<string, string>): string =>
      ["nav.accounts", "nav.routing", "status.inflight", "health.cooling", "accounts.table.quota"]
        .map((key) => dictionary[key])
        .join("|");
    expect(terms(zh)).toBe("账号|路由策略|在飞|冷却|额度");
    expect(terms(en)).toBe("Accounts|Routing|Inflight|Cooling|Quota");
  });
});

describe("styling rules", () => {
  it("keeps the type and density scale in tokens, not in pages", () => {
    const tokens = PAGE_TOKENS_CSS;
    /* 字号五档：正文 15 / 辅助 14 / 微 13 / 区块标题 17 / 页面 26。*/
    for (const line of [
      "--text-display: 26px;",
      "--text-title: 17px;",
      "--text-body: 15px;",
      "--text-meta: 14px;",
      "--text-micro: 13px;",
      "--control-height: 36px;",
      "--tag-height: 22px;",
      "--layout-appbar: 56px;",
      "--layout-sidebar: 232px;",
      "--layout-icon: 20px;",
    ]) {
      expect([line, tokens.includes(line)]).toEqual([line, true]);
    }

    const css = PAGE_COMPONENTS_CSS;
    /* 组件层不许写裸字号：每一处 font-size 都从这五档取。*/
    const bare = [...css.matchAll(/font-size: *\d+px/g)].map((match) => match[0]);
    expect(bare).toEqual([]);
    /* 密集数据表的受控例外只有一个钩子，由 .table--dense 落到 micro 档。*/
    const dense = css.slice(css.indexOf(".table--dense {"), css.indexOf(".table--dense {") + 120);
    expect(dense).toContain("font-size: var(--text-micro)");
    expect(renderPanelPage()).toContain('class="table table--dense" data-role="req-table"');
  });

  it("keeps the in-row control tier and the tag height at one value everywhere", () => {
    const css = PAGE_COMPONENTS_CSS;
    const tokens = PAGE_TOKENS_CSS;

    /* G-3：表格行内控件一律 28px（`--control-height-sm`）——步进器 / 行内下拉 /
       ⋯ 触发键走 `.table` 作用域，`.btn--sm` / `.tag--toggle` 是显式变体。 */
    expect(tokens).toContain("--control-height-sm: 28px;");
    const rowControls = css.slice(css.indexOf(".table .stepper,"), css.indexOf(".table .stepper,") + 140);
    for (const selector of [".table .stepper", ".table .select", ".table .btn--menu"]) {
      expect(rowControls).toContain(selector);
    }
    expect(rowControls).toContain("height: var(--control-height-sm)");
    /* 行内档不能再出现 36px 的旧规则：`.table` 里没有任何 `height: var(--control-height)`。 */
    expect(css).not.toMatch(/\.table [^{]*\{[^}]*height: var\(--control-height\)/);

    /* G-4：三张表共用一个操作列宽 token。 */
    expect(tokens).toContain("--layout-actions-col: 176px;");
    const actionsCol = css.slice(css.indexOf(".table th.col-actions {"), css.indexOf(".table th.col-actions {") + 80);
    expect(actionsCol).toContain("width: var(--layout-actions-col)");

    /* A-1：密集表真的收了——四边 8px + 单元格最小高度 40px（验收区间 40–42）。 */
    const denseCells = css.slice(css.indexOf(".table--dense th,"), css.indexOf(".table--dense th,") + 120);
    expect(denseCells).toContain("padding: var(--space-2)");
    expect(denseCells).toContain("height: 40px");

    /* K-1：标签高度只有一个来源，`.tag` / 状态徽章 / 聊天文件芯片都引它。 */
    for (const selector of [".tag {", ".status-badge {"]) {
      const block = css.slice(css.indexOf(`\n${selector}`), css.indexOf(`\n${selector}`) + 240);
      expect(block).toContain("height: var(--tag-height)");
    }
    /* `.req__effort`：它是标签同族，挂同一个高度（以前靠行盒凑出 21.5px）。 */
    const effort = css.slice(css.indexOf(".req__effort {"), css.indexOf(".req__effort {") + 160);
    expect(effort).toContain("height: var(--tag-height)");

    /* 窄屏的 44px 触摸目标必须按同一条（高特异性的）选择器再压一次。 */
    expect(css).toContain("  .table .stepper,\n  .table .stepper__btn,\n  .table .select,\n  .table .btn--menu,\n  .tag--toggle {\n    height: var(--layout-touch-min);");
    /* 方形控件的宽度也得跟着触摸档走，否则⋯ 会变成 28×44 的窄高条。 */
    expect(css).toContain("  .table .stepper__btn,\n  .table .btn--menu {\n    width: var(--layout-touch-min);");
  });

  it("folds the three request columns at ≤1440 and keeps the toolbar groups whole", () => {
    const css = PAGE_COMPONENTS_CSS;

    /* L-3：折叠只隐藏三列，断点与工具栏的 1440 同一条界线。 */
    const fold = css.slice(css.indexOf("@media (max-width: 1440px)"), css.indexOf("@media (max-width: 1440px)") + 120);
    expect(fold).toContain(".table--dense .req__col--extra");
    expect(fold).toContain("display: none");

    /* L-2：组内 nowrap + 动作组 `margin-left: auto`（不是 `flex: 1` 的 spacer）。 */
    const group = css.slice(css.indexOf("\n.toolbar__group {"), css.indexOf("\n.toolbar__group {") + 200);
    expect(group).toContain("flex-wrap: nowrap");
    const end = css.slice(css.indexOf(".toolbar__group--end {"), css.indexOf(".toolbar__group--end {") + 60);
    expect(end).toContain("margin-left: auto");
    const fields = css.slice(css.indexOf(".toolbar__group--fields {"), css.indexOf(".toolbar__group--fields {") + 120);
    expect(fields).toContain("flex-wrap: wrap");

    /* 筛选条的两行结构由 `.toolbar--filters` 给出，不靠流式换行。
       第一行整行（`flex: 1 1 100%`）、下拉等分（`flex: 1 1 0`）、下拉允许缩到
       0（`min-width: 0`）；≤1200 按三列折行（`calc((100% - 2 * gap) / 3)`）。 */
    const bar = css.slice(css.indexOf(".toolbar--filters > .toolbar__group--fields {"));
    expect(bar.slice(0, 80)).toContain("flex: 1 1 100%");
    expect(bar).toContain(".toolbar--filters > .toolbar__group--fields > .field-cell {\n  flex: 1 1 0;\n  min-width: 0;");
    const narrow = css.slice(css.indexOf("@media (max-width: 1200px)"));
    expect(narrow).toContain(".toolbar--filters > .toolbar__group--fields {");
    expect(narrow).toContain("flex: 1 1 calc((100% - 2 * var(--space-2)) / 3)");
    /* 搜索框在第二行左半边：与下拉同在一行才需要 `flex: 1 1 <basis>`。 */
    expect(bar).toContain(".toolbar--filters > .toolbar__search {");
  });

  it("keeps the overview grid and its empty states on tokens", () => {
    const css = PAGE_COMPONENTS_CSS;
    /* 四等分、space-5 间隔；卡片高度由密度档的内边距给，不写死。
       每列另有可读上限，超宽屏下网格不跟着内容列拉宽。 */
    const metrics = css.slice(css.indexOf("/*\n * 概览页的四张指标卡"), css.indexOf("/*\n * 概览页的四张指标卡") + 500);
    expect(metrics).toContain("grid-template-columns: repeat(4, minmax(0, min(var(--layout-metric-max), 100%)))");
    expect(metrics).toContain("justify-content: start");
    expect(metrics).toContain("var(--space-5)");
    /* 窄屏两条断点 */
    expect(css).toContain("@media (max-width: 900px)");
    expect(css).toContain("@media (max-width: 600px)");
    /* 一行式提示与卡片文字色 */
    expect(css).toContain(".empty-inline");
    expect(css).toContain(".card--metric .card__label");
    /* 风控横幅的图标与导航图标共用笔触属性 */
    expect(css).toContain(".banner__icon");
  });

  it("keeps the shell one-scroll-model: sidebar status is a flex block, not a fixed patch", () => {
    const css = PAGE_COMPONENTS_CSS;
    const at = css.indexOf(".sidebar__status {");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, at + 400);
    /* 状态行是侧边栏 flex 列的最后一块：`margin-top: auto` 占掉多余高度，
       `flex: 0 0 auto` 让它不参与压缩。`position: fixed` 的视口补丁不存在
       （页面已经不滚，不存在“滚到底才看得见”）。 */
    expect(block).toContain("flex: 0 0 auto");
    expect(block).toContain("margin-top: auto");
    expect(block).not.toContain("position: fixed");
    expect(block).not.toContain("z-index");
    /* 侧边栏自己是滚动容器：滚的是这一栏，不是页面。 */
    const sidebar = css.slice(css.indexOf(".sidebar {"), css.indexOf(".sidebar__status {"));
    expect(sidebar).toContain("overflow-y: auto");
    expect(sidebar).toContain("flex-direction: column");
  });

  it("defines the single shell and the two page-body modes", () => {
    const css = PAGE_COMPONENTS_CSS;
    const html = renderPanelPage();
    /* 壳：整页不滚，高度按视口钉死。只给控制面文档挂（`<html class="app-root">`），
       登录页仍然是文档流。 */
    expect(html).toContain('<html lang="zh-CN" class="app-root">');
    expect(css).toContain("html.app-root,\nhtml.app-root > body {\n  height: 100%;\n  overflow: hidden;\n}");
    /* `.app` 不再用 `min-height: 100vh`（那正是文档流滚动的入口）。 */
    const app = css.slice(css.indexOf("\n.app {"), css.indexOf("\n.app__body {"));
    expect(app).not.toContain("min-height: 100vh");
    expect(app).toContain("height: 100%");
    expect(app).toContain("flex-direction: column");
    /* 两种模式：flow 自己滚，fill 把高度交给 .fill-region。 */
    const body = css.slice(css.indexOf("\n.page-body {"), css.indexOf("\n.fill-region {"));
    expect(body).toContain("overflow-y: auto");
    expect(body).toContain("min-height: 0");
    expect(body).toContain(".page-body--fill");
    expect(css).toContain(".fill-region {");
    expect(css).toContain(".fill-chain {");
    /* 日志页的固定 420px 视口随之删除；请求事件表由自己的滚动层接管。 */
    expect(css).not.toContain("--layout-log-height");
    expect(css).not.toContain("--layout-chat-height");
    /* 日志页（fill）：框体传高度、内部那块滚。框体必须是 flex 列，否则
       `flex: 1 1 auto` 落在块级子元素上无效，日志行一多就冲出框体。 */
    expect(html).toContain('class="panel fill-chain log-panel"');
    expect(html).toContain('class="log fill-region"');
    expect(html).toContain('class="table-scroll fill-region"');
    const logPanel = css.slice(css.indexOf(".log-panel {"), css.indexOf(".log-panel {") + 160);
    expect(logPanel).toContain("display: flex");
    expect(logPanel).toContain("flex-direction: column");
  });

  it("fills the log frame and colours the key/value segments", () => {
    const css = PAGE_COMPONENTS_CSS;
    const tokens = PAGE_TOKENS_CSS;

    /* 日志框自己带高度接力（`.fill-region` 之外的双保险）：`flex: 1 1 auto` +
       `min-height: 0`，漏掉后一条时弹性项的默认最小高度是内容高，框会被行数顶出页。 */
    const log = css.slice(css.indexOf("\n.log {"), css.indexOf(".log__line {"));
    expect(log).toContain("flex: 1 1 auto");
    expect(log).toContain("min-height: 0");
    expect(log).not.toContain("max-height");
    /* 没有固定高度：`line-height` / `min-height` 之外不出现 height 声明。 */
    const fixedHeights = [...log.matchAll(/(?:^|[^-])height:/g)].map((match) => match[0]);
    expect(fixedHeights).toEqual([]);

    /* 长行折行 + 续行缩进：结构化行靠第 4 列对齐，整段原文的行靠悬挂缩进。 */
    const line = css.slice(css.indexOf("\n.log__line {"), css.indexOf(".log__line:last-child"));
    expect(line).toContain("white-space: pre-wrap");
    expect(line).toContain("word-break: break-word");
    const plain = css.slice(css.indexOf(".log__line--plain {"), css.indexOf(".log__line--plain {") + 160);
    expect(plain).toContain("text-indent: calc(var(--space-4) * -1)");
    expect(plain).toContain("padding-left: calc(var(--space-2) + var(--space-4))");

    /* 键值分段：键弱（faint）、值深（text）。 */
    const kvKey = css.slice(css.indexOf(".log__kv--key {"), css.indexOf(".log__kv--key {") + 80);
    expect(kvKey).toContain("color: var(--faint)");
    const kvVal = css.slice(css.indexOf(".log__kv--val {"), css.indexOf(".log__kv--val {") + 80);
    expect(kvVal).toContain("color: var(--text)");

    /* 请求表的新列都只引用 token：身份色盘六档 + 中断档徽章 + 四档强度。 */
    for (let index = 1; index <= 6; index++) {
      expect(tokens).toContain(`--identity-${index}:`);
      expect(css).toContain(`background: var(--identity-${index})`);
    }
    /* 身份色盘与 --qr-* 一样只在 :root 定义：不随主题翻转，否则同一账号会变色。 */
    const lightRoot = tokens.slice(tokens.indexOf("\n:root {"), tokens.indexOf("\n:root[data-theme=\"dark\"] {"));
    expect(lightRoot).toContain("--identity-1:");
    const darkRoot = tokens.slice(tokens.indexOf("\n:root[data-theme=\"dark\"] {"));
    expect(darkRoot).not.toContain("--identity-1:");
    expect(darkRoot).not.toContain("--identity-6:");
    expect(css).toContain(".status-badge--aborted");
    expect(css).toContain(".req__effort--high");
    expect(css).toContain(".req__cache-rate");
    expect(css).toContain(".req__aborted::before");
  });

  it("keeps the chart frame, the jump button and the stats grid on tokens", () => {
    const css = PAGE_COMPONENTS_CSS;
    /* 图表公共框：值刻度列（宽度走 token）+ 绘图区（基线用 border，不被 SVG 边缘裁半） */
    expect(css).toContain(".chart__frame");
    expect(css).toContain(".chart__scale");
    expect(css).toContain("flex: 0 0 var(--layout-chart-scale)");
    expect(css).toContain(".chart__tick");
    expect(css).toContain(".tokchart__grid");
    expect(css).toContain("stroke: var(--line-soft)");
    /* 跳转按钮：`<a>` 上的 `.btn` 要抹掉 UA 下划线，箭头与文字同色（currentColor） */
    const jump = css.slice(css.indexOf(".btn--jump {"), css.indexOf(".btn--jump {") + 160);
    expect(jump).toContain("text-decoration: none");
    expect(css).toContain(".btn__icon");
    /* 六维分组表固定列宽；调度三卡固定三列（不跟 auto-fit 折 2+1） */
    expect(css).toContain(".table--fixed");
    expect(css).toContain("table-layout: fixed");
    const triple = css.slice(css.indexOf(".stats--triple {"), css.indexOf(".stats--triple {") + 120);
    expect(triple).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
    /* 调度 + 缓存两块等高（grid 默认 stretch），不再 align-items:start */
    const cols = css.slice(css.indexOf(".stats-cols {"), css.indexOf(".stats-cols {") + 200);
    expect(cols).not.toContain("align-items: start");
  });

  it("buttonizes the overview jump links and keeps the claim row a card link", () => {
    const html = renderPanelPage();
    const overview = html.slice(viewStart(html, "overview"), viewStart(html, "stats"));
    /* 「查看统计」从裸 `.link` 变成跳转按钮（行尾带精灵里的 arrow-right） */
    expect(overview).toContain('class="btn btn--jump" href="/stats?range=today"');
    expect(overview).not.toContain('<a class="link" href="/stats?range=today"');
    expect(overview).toContain('<use href="#icon-arrow-right" />');
    /* claim 行是整行可点的卡片链接，href 在行本身上 */
    expect(overview).toContain('class="card card--link overview-claim" href="/accounts"');
    expect(overview).not.toContain('class="banner banner--link" data-role="overview-claim-line"');
  });

  it("keeps every hex colour inside tokens.css", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(WEB_DIR).filter((entry) => entry.endsWith(".css"))) {
      if (name === "tokens.css") continue;
      const matches = read(name).match(HEX_COLOR);
      if (matches) offenders.push(`${name}: ${matches.join(",")}`);
    }
    // components.css 一个裸色值都不许有；页面与运行时同理。
    expect(offenders).toEqual([]);
    for (const source of [PAGE_APP_SCRIPT, renderPanelPage()]) {
      const stray = source.split(PAGE_TOKENS_CSS).join("").match(HEX_COLOR);
      expect(stray).toBeNull();
    }
  });


  it("never writes visual properties inline (only pure geometry)", () => {
    const html = joinedPageHtml();
    const styles = [...html.matchAll(/style="([^"]*)"/g)].map((match) => match[1] as string);
    for (const style of styles) {
      expect([style, /color|font-size|border-radius|padding|margin|background/.test(style)]).toEqual([style, false]);
    }
  });

  it("defines the components the pages rely on", () => {    const css = PAGE_COMPONENTS_CSS;
    for (const className of [
      ".stepper",
      ".select",
      ".switch",
      ".modal",
      ".modal__body",
      ".modal__footer",
      ".tabs",
      ".tab",
      ".matrix__yes",
      ".empty",
      ".log",
      ".log__line",
    ]) {
      expect([className, css.includes(className)]).toEqual([className, true]);
    }
  });

  it("sizes the new components from tokens only", () => {
    // `--control-height` / `--tag-height` 是尺寸表的唯一来源；新组件必须用它。
    const css = PAGE_COMPONENTS_CSS;
    const stepper = css.slice(css.indexOf(".stepper {"), css.indexOf(".stepper__btn"));
    expect(stepper).toContain("var(--control-height)");
  });

  it("hides the number spinner", () => {
    const css = PAGE_COMPONENTS_CSS;
    /* 两条前缀规则都要在：WebKit 靠 `appearance: none`，Firefox 靠 `textfield`。*/
    expect(css).toContain('input[type="number"]::-webkit-inner-spin-button');
    expect(css).toContain('input[type="number"]::-webkit-outer-spin-button');
    const webkit = css.slice(css.indexOf('input[type="number"]::-webkit-inner-spin-button'));
    expect(webkit.slice(0, 160)).toContain("-webkit-appearance: none");
    expect(css).toContain('input[type="number"] {\n  -moz-appearance: textfield;');
  });

  it("draws one focus ring and only for keyboard focus", () => {
    const css = PAGE_COMPONENTS_CSS;
    const at = css.indexOf("\n:focus-visible {");
    expect(at).toBeGreaterThan(-1);
    const ring = css.slice(at, at + 120);
    expect(ring).toContain("outline: 2px solid var(--accent)");
    expect(ring).toContain("outline-offset: 2px");
    /* 不再有组件自己的 1px 弱轮廓，也不再给 `:focus`（鼠标点击也会命中）画框。*/
    expect(css).not.toContain("outline: 1px");
    expect(css).not.toMatch(/:focus\s*[,{]/);
  });

  it("keeps the switches at one fixed pill size", () => {
    const css = PAGE_COMPONENTS_CSS;
    const input = css.slice(css.indexOf(".switch__input {"), css.indexOf(".switch__input::after"));
    // 40×22 是 tokens.css 里的显式值（不再用间距档拼——上移间距档时
    // 「宽 +一档、高只 +2」的配比会散），半径仍是高度的一半（--radius-lg）。
    expect(input).toContain("width: var(--switch-width)");
    expect(input).toContain("height: var(--switch-height)");
    expect(input).toContain("border-radius: var(--radius-lg)");
    // 滑块吃满内容框、左右各留 1px，选中时贴右边。
    const tokens = PAGE_TOKENS_CSS;
    expect(tokens).toContain("--switch-width: 40px;");
    expect(tokens).toContain("--switch-height: 22px;");
    expect(tokens).toContain("--switch-knob: 18px;");
    expect(tokens).toContain("--radius-lg: 11px;");
  });

  it("limits hint text and truncates long paths with a title", () => {
    const css = PAGE_COMPONENTS_CSS;
    const hint = css.slice(css.indexOf("\n.hint {"), css.indexOf("\n.hint {") + 160);
    expect(hint).toContain("max-width: 42ch");
    /* 长只读值（路径 / 指纹）统一用 `.hint--clip`（一行截断 + title 全值），
       不再有挂在字段行上的专用截断类。 */
    const path = css.slice(css.indexOf(".hint.hint--clip {"), css.indexOf(".hint.hint--clip {") + 200);
    expect(path).toContain("overflow: hidden");
    expect(path).toContain("text-overflow: ellipsis");
    expect(path).toContain("white-space: nowrap");
    // 完整值进 `title`（截断之后鼠标停上去还能读到全路径）
    expect(PAGE_APP_SCRIPT).toContain("node.title = text");
  });

  it("keeps every comment closed, so no rule is swallowed by one", () => {
    /* 真实事故：`.chat__log` 头上那段注释漏了收尾符号，于是整条
       `.chat__log` 规则被**下一个**注释的结尾吞掉——`display: flex` 与 `gap`
       从来没有生效过，表现为「气泡贴在一起」。这种错不报错、不改字节总数，只能
       把注释剔掉后再看规则还在不在。 */
    const css = PAGE_COMPONENTS_CSS;
    /* 注释区间（成对的 `/*` … `*​/`）。 */
    const ranges: Array<[number, number]> = [...css.matchAll(/\/\*[\s\S]*?\*\//g)].map(
      (match) => [match.index ?? 0, (match.index ?? 0) + match[0].length] as [number, number],
    );
    const inComment = (at: number): boolean => ranges.some(([start, end]) => at >= start && at < end);
    /* 行首的选择器行（`xxx {` 单行结尾）落在注释里 = 整条规则被吞。注释正文里
       可以出现 `{`（本文有两处举例），但不会出现在行首或独占一行。 */
    const swallowed = [...css.matchAll(/^[^\n{}]*\{\s*$/gm)]
      .filter((match) => inComment(match.index ?? 0))
      .map((match) => (css.slice(0, match.index ?? 0).match(/\n/g) ?? []).length + 1);
    expect(swallowed).toEqual([]);
    for (const rule of [".chat__log {", ".chat__msg {", ".sidebar {", ".page {"]) {
      expect([rule, css.includes(rule)]).toEqual([rule, true]);
    }
  });

  it("carries the layout values in the shipped page", () => {
    const html = renderPanelPage();
    expect(html).toContain("--layout-content-gutter: var(--space-5)");
    expect(html).toContain("--layout-sidebar: 232px");
    // 单元格大小（标签列宽）也是 token，不在字段行里写裸值
    expect(html).toContain("--layout-field-min: 352px");
  });
});

describe("statistics view", () => {
  const html = renderPanelPage();

  it("keeps the range bar and summary cards of the stats tables", () => {
    // 范围栏：四档；范围值与 app-view-stats.js / app-constants.js 的常量表一致
    for (const range of ["today", "7d", "30d", "all"]) {
      expect(html).toContain(`data-stats-range="${range}"`);
    }
    /* 刷新收敛到顶栏：范围栏没有自己的「刷新」按钮。 */
    expect(html).not.toContain('data-role="stats-refresh"');
    expect(html).not.toContain('data-i18n="stats.refresh"');
    // 总览卡行六张：请求数 / 成功率 / 总 token / 平均首响 / 平均速率 / 错误数
    for (const role of ["stats-requests", "stats-successRate", "stats-tokens", "stats-ttfb", "stats-tps", "stats-errors"]) {
      expect(html).toContain(`data-role="${role}"`);
    }
    // 时序的粒度切换与图表容器；六维分组的六个 tab
    for (const gran of ["hourly", "daily"]) expect(html).toContain(`data-stats-gran="${gran}"`);
    for (const dim of ["account", "route", "model", "apiKey", "protocol", "clientKind"]) {
      expect(html).toContain(`data-stats-dim="${dim}"`);
    }
    // 分组表的七列（首列表头是通用词「维度」，不跟维度名同步）
    for (const key of [
      "stats.dim.columnHeader",
      "stats.col.requests",
      "stats.col.failed",
      "stats.col.successRate",
      "stats.col.tokens",
      "stats.col.avgLatency",
      "stats.col.avgRate",
    ]) {
      expect(html).toContain(`data-i18n="${key}"`);
    }
    // 错误分析 / 调度事件 / 缓存命中率 / 热力图四个区块都在
    for (const role of [
      "stats-kinds",
      "stats-kinds-empty",
      "stats-degraded",
      "stats-cooled",
      "stats-queueTimeout",
      "stats-cache-data",
      "stats-cache-empty",
      "stats-heatmap",
      "stats-heatmap-empty",
      // 热力图：底部月轴 / 格子缸 / tooltip（日期 + Tokens/MCP 两行）
      "heatmap-months",
      "heatmap-grid",
      "heatmap-tip",
      "heatmap-tip-date",
      "heatmap-tip-tokens",
      "heatmap-tip-mcp",
    ]) {
      expect(html).toContain(`data-role="${role}"`);
    }
    // 热力图三档聚合粒度 tab（每日/每周/累计，选中态胶囊）
    for (const gran of ["daily", "weekly", "cumulative"]) {
      expect(html).toContain(`data-heatmap-gran="${gran}"`);
    }
    expect(html).toContain('data-i18n="stats.cache.noData"');
    /* 六维表固定列宽、调度三卡固定三列——切维度 / 换语言时列几何与卡宽不跳。 */
    expect(html).toContain('class="table table--fixed" data-role="stats-group-table"');
    expect(html).toContain('class="stats stats--triple"');
  });

  it("gives both stats table controls the same pill group next to the panel title", () => {
    /* 维度胶囊与「按小时 / 按天」是同一类东西：都切「这张表怎么排」，都贴在 panel
       标题行右侧。两处必须同款（`.tabs--seg`），否则读者会以为其中一组换了整页。
       范围栏仍是页面级 `.tabs`，不参与这一套。 */
    const html = renderPanelPage();
    const statsView = html.slice(viewStart(html, "stats"), viewStart(html, "accounts"));
    expect((statsView.match(/class="tabs tabs--seg"/g) ?? []).length).toBe(2);
    for (const role of ["hourly", "daily"]) {
      expect(statsView).toContain(`data-stats-gran="${role}"`);
    }
    // 六维 tab 与 gran 控件都不再挂页面级下划线样式
    expect(statsView).not.toContain("tabs tabs--filter");
    // 两组的胶囊都在标题行里、且在标题右侧（标题 → 弹性间隔 → 胶囊）
    for (const title of ["stats.series.title", "stats.groups.title"]) {
      const at = statsView.indexOf(`data-i18n="${title}"`);
      expect(at).toBeGreaterThan(-1);
      const row = statsView.slice(at, statsView.indexOf("</div>", at));
      expect(row).toContain('class="toolbar__spacer"');
      expect(row).toContain('class="tabs tabs--seg"');
      expect(row.indexOf("toolbar__spacer")).toBeLessThan(row.indexOf("tabs tabs--seg"));
    }

    /* 胶囊组的尺寸取行内控件那一档，与热力图 tab 等高；选中态不靠描边。 */
    const seg = PAGE_COMPONENTS_CSS.slice(PAGE_COMPONENTS_CSS.indexOf("\n.tabs--seg {"));
    const head = seg.slice(0, seg.indexOf("\n}") + 2);
    expect(head).toContain("border-bottom: 0");
    expect(head).toContain("background: var(--panel-alt)");
    expect(head).toContain("flex-wrap: wrap");
    expect(seg).toContain("height: var(--control-height-sm)");
    expect(seg).toContain(".tabs--seg .tab--active {");
    /* 胶囊不折行：390px 宽实测「账号 / 路由」曾被压成两个竖排的盒子（每颗只剩
       45.9px 宽、44px 高）。一颗胶囊一行字、整组允许折到第二行。 */
    expect(seg).toContain("white-space: nowrap");
    expect(seg).toContain("flex: 0 0 auto");
    /* 页面级 `.tabs` 与账号页筛选共用的 `.tabs--filter` 一个字都没动。 */
    expect(PAGE_COMPONENTS_CSS).toContain(".tabs--filter .tab--active {");
  });

  it("keeps the overview additions on live data", () => {
    // 今日 token 时序缩略：图表容器 + 图例 + 空态；整图链去统计视图的「今天」
    for (const role of ["usage-chart", "usage-empty", "usage-legend", "usage-total"]) {
      expect(html).toContain(`data-role="${role}"`);
    }
    expect(html).toContain('href="/stats?range=today"');
    // 图表与图例的颜色全部走 token（app-charts.js 只画 rect，填色在 components.css）
    expect(PAGE_COMPONENTS_CSS).toContain(".tokchart__in");
    expect(PAGE_COMPONENTS_CSS).toContain(".tokchart__out");
    expect(PAGE_COMPONENTS_CSS).toContain("fill: var(--accent-border)");
    expect(PAGE_COMPONENTS_CSS).toContain("fill: var(--accent)");
    // 热力图色阶五档也是 token（零档 + 四蓝档，--heat-0..4）
    for (const level of [0, 1, 2, 3, 4]) {
      expect(PAGE_COMPONENTS_CSS).toContain(`.heatmap__cell--l${level}`);
    }
    expect(PAGE_COMPONENTS_CSS).toContain("var(--heat-4)");
    /* tooltip 浮层（悬停）与 tab 胶囊（选中态）两个类都在。 */
    for (const rule of [".heatmap__tip", ".heatmap__tab--active", ".heatmap__grid--flat"]) {
      expect(PAGE_COMPONENTS_CSS).toContain(rule);
    }
  });

  it("gives the error breakdown a half-width slot beside the schedule pair", () => {
    /* 下半部分两列、两行内容：左列整高放错误分析，右列竖叠调度事件与缓存命中率。
       错误分析只放 1–3 行短文本，独占整幅宽时右半边是空的。
       断言只看结构位置：类名换了、面板插进别的容器、右列被包成第二层框，都会先红。 */
    const stats = html.slice(viewStart(html, "stats"), viewStart(html, "accounts"));
    const cols = stats.slice(stats.indexOf('<div class="stats-cols">'));
    const colsBody = cols.slice(0, cols.indexOf('<section class="panel heatmap-panel">'));
    expect(colsBody).not.toBe("");

    /* 左列：错误分析是 `.stats-cols` 的第一个格子（它曾整幅独占、在网格之外）。 */
    const firstSection = colsBody.indexOf("<section ");
    expect(firstSection).toBeGreaterThan(-1);
    const firstSectionEnd = colsBody.indexOf(">", firstSection);
    const errorsPanel = colsBody.indexOf('data-i18n="stats.errors.title"');
    expect(errorsPanel).toBeGreaterThan(firstSectionEnd);
    expect(colsBody.slice(firstSection, errorsPanel).match(/<section /g) ?? []).toHaveLength(1);

    /* 右列：纯布局容器，自身不带 `.panel` / `.card`（双层框禁令）——
       框只由里面两块 `.panel` 各画一层。 */
    expect(colsBody).toContain('<div class="stats-side">');
    const side = colsBody.slice(colsBody.indexOf('<div class="stats-side">'));
    expect(side).not.toMatch(/<div class="[^"]*\b(panel|card)\b/);
    const sideTags = [...side.matchAll(/<(section|div) class="([^"]*)"/g)].map((m) => m[2] as string);
    expect(sideTags[0]).toBe("stats-side");
    expect(sideTags[1]).toBe("panel");

    /* 右列的两块顺序：调度事件在前、缓存命中率在后（窄屏单列时也照这个顺序读）。 */
    const schedule = side.indexOf('data-i18n="stats.schedule.title"');
    const cache = side.indexOf('data-i18n="stats.cache.title"');
    expect(schedule).toBeGreaterThan(-1);
    expect(cache).toBeGreaterThan(schedule);

    /* 热力图仍在 `.stats-cols` 之外、保持整幅宽（用户明确要求零改动）。 */
    const heatmap = stats.indexOf('<section class="panel heatmap-panel">');
    expect(heatmap).toBeGreaterThan(-1);
    expect(heatmap).toBeGreaterThan(stats.indexOf('<div class="stats-side">'));
    expect(stats.slice(stats.indexOf('<div class="stats-cols">'), heatmap)).toContain('<div class="stats-side">');
  });

  it("keeps the two-column stats grid stretched and folded to one column on narrow screens", () => {
    /* 两列等高拉伸（grid 默认 stretch，不写 align-items: start）是右列两块面板
       与左列错误分析同高的前提；≤900 单列时三块自然各占一行。 */
    const css = PAGE_COMPONENTS_CSS;
    const cols = css.slice(css.indexOf("\n.stats-cols {"), css.indexOf("\n.stats-cols {") + 240);
    expect(cols).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(cols).toContain("gap: var(--space-5)");
    expect(cols).not.toContain("align-items: start");
    /* 右列只是布局容器：只写排布，不画框。 */
    const side = css.slice(css.indexOf("\n.stats-side {"), css.indexOf("\n.stats-side {") + 240);
    expect(side).toContain("grid-template-rows: auto auto");
    expect(side).toContain("gap: var(--space-5)");
    for (const banned of ["border", "background", "padding", "box-shadow"]) {
      expect(side).not.toContain(banned);
    }
    /* ≤900 的单列规则仍在，且把两列收成一列。 */
    const narrow = css.slice(css.indexOf("@media (max-width: 900px)"));
    expect(narrow.slice(0, narrow.indexOf("@media (max-width: 600px)"))).toContain("grid-template-columns: 1fr");
  });

  it("splits the error bar into name, track and count at half width", () => {
    /* 名字列不再是整幅宽时代的 `minmax(80px, 160px)`：它在半幅面板里会把
       hint 的中文整句折断（末字单独成行）。名字列的上限与 hint 的 42ch 同档，
       横条拿中间的 1fr、次数贴右缘；单分类那一行写满剩余宽，不缩在 160px 里。
       横条的下限写成 48px 而不是裸 1fr：裸 1fr 在 1000px 视口被名字列的
       base size 挤到 0 宽；下限给大了同样会把 hint 折出孤字。 */
    const css = PAGE_COMPONENTS_CSS;
    const bar = css.slice(css.indexOf("\n.hbar {"), css.indexOf("\n.hbar {") + 420);
    expect(bar).toContain("grid-template-columns: minmax(0, 42ch) minmax(48px, 1fr) auto");
    expect(bar).not.toContain("minmax(80px, 160px)");
    const single = css.slice(css.indexOf("\n.hbar--single {"), css.indexOf("\n.hbar--single {") + 160);
    expect(single).toContain("grid-template-columns: minmax(0, 1fr) auto");
    /* hint 的限宽仍与 `.hint` 同档（42ch），不截断、允许正常折行。 */
    const hint = css.slice(css.indexOf("\n.hbar__hint {"), css.indexOf("\n.hbar__hint {") + 200);
    expect(hint).toContain("max-width: 42ch");
  });
});

describe("routing view (two-column grid)", () => {
  const html = renderPanelPage();
  /** 路由视图那一段（从视图容器到下一个视图容器）。*/
  const view = html.slice(viewStart(html, "routing"), viewStart(html, "keys"));

  it("pairs the panels in a two-column grid with the order and matrix spanning both", () => {
    /* 骨架：降级顺序与矩阵横跨两列（前者是竖排优先级列表，后者是宽表），
       中间四块两两成对（调度策略 | 队列、粘性 | 风控）。
       顺序也钉住：网格按 DOM 顺序自动排布，顺序错了配对就错。 */
    expect(view).toContain('<div class="routing-grid">');
    const blocks = [...view.slice(view.indexOf('<div class="routing-grid">')).matchAll(/<section class="([a-z-]+)[^"]*"/g)].map(
      (match) => match[1] as string,
    );
    expect(blocks).toEqual(["panel", "panel", "collapse", "collapse", "collapse", "panel", "panel"]);
    expect((view.match(/class="panel routing-grid__span"/g) ?? []).length).toBe(2);
    const spans = [...view.matchAll(/<section class="([^"]*routing-grid__span[^"]*)"/g)].map((m) => m[1] as string);
    expect(spans).toEqual(["panel routing-grid__span", "panel routing-grid__span"]);
    /* 顺序里第一块是降级顺序、最后一块是矩阵：跨列的两块一头一尾。 */
    expect(view.indexOf("routing.order.title")).toBeLessThan(view.indexOf("routing.policy.title"));
    expect(view.indexOf("routing.matrix.title")).toBeGreaterThan(view.indexOf("routing.risk.title"));
  });

  it("puts the five dispatch-policy fields in a two-column field grid", () => {
    /* 全项目唯一骨架：`.field-grid` > `.field-cell`，标签在上、控件吃满格。
       五个枚举排成 2 + 2 + 1，同一列控件的左边缘是一条竖线（不再按标签宽漂）。 */
    const policyAt = view.indexOf('data-i18n="routing.policy.title"');
    const policy = view.slice(policyAt, view.indexOf('data-i18n="routing.queue.title"'));
    expect(policy).toContain('<div class="field-grid">');
    for (const role of ["routing-mode", "routing-strategy", "routing-saturated", "routing-drained", "routing-authfailed"]) {
      expect([role, policy.includes(`data-role="${role}"`)]).toEqual([role, true]);
    }
    for (const id of ["routing-mode", "routing-strategy", "routing-saturated", "routing-drained", "routing-authfailed"]) {
      expect([id, policy.includes(`<label class="field-cell__label" for="${id}"`)]).toEqual([id, true]);
    }
    // 一列一组的容器不存在了（合并成一个 field-grid）
    expect(policy).not.toContain("policy-row");
    expect(view).not.toContain("policy-row");
    // 说明仍然压在字段网格下面
    expect(policy).toContain('data-i18n="routing.strategy.hint"');

    const css = PAGE_COMPONENTS_CSS;
    const grid = css.slice(css.indexOf("\n.field-grid {"), css.indexOf("\n.field-grid {") + 160);
    expect(grid).toContain("display: grid");
    expect(grid).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(grid).toContain("gap: var(--space-4)");
    /* R-3：五个字段里落单的第五个跨两列——否则它独占左列、右列空一格。 */
    expect(policy).toContain('class="field-cell field-cell--span"');
    expect(policy).toContain('for="routing-authfailed"');
  });

  it("keeps numeric boxes on a content-width档 inside a field cell (R-1)", () => {
    /* 数值框的宽度由值域定（10ch）：吃满两列宽的格子里一根数字框只是留白。
       这条必须写在 `> .field` 的 `width: 100%` 之后，同优先级下后写的生效。 */
    const css = PAGE_COMPONENTS_CSS;
    const rule = css.slice(css.indexOf("\n.field-cell > .field--num {"));
    expect(rule.slice(0, 80)).toContain("width: 10ch");
    expect(css.indexOf(".field-cell > .field--num {")).toBeGreaterThan(
      css.indexOf(".field-cell > .field,\n.field-cell > .select,"),
    );
  });

  it("lays the queue, stickiness and risk fields out inline instead of one per row", () => {
    const queueAt = view.indexOf('data-i18n="routing.queue.title"');
    const stickyAt = view.indexOf('data-i18n="routing.stickiness.title"');
    const riskAt = view.indexOf('data-i18n="routing.risk.title"');
    const matrixAt = view.indexOf('data-i18n="routing.matrix.title"');
    const queue = view.slice(queueAt, stickyAt);
    const sticky = view.slice(stickyAt, riskAt);
    const risk = view.slice(riskAt, matrixAt);
    for (const block of [queue, sticky, risk]) expect(block).toContain('<div class="field-grid">');
    // 队列三字段、粘性四字段（开关横跨两列）、风控一组开关
    expect((queue.match(/class="field field--num"/g) ?? []).length).toBe(3);
    expect((sticky.match(/class="field field--num"/g) ?? []).length).toBe(3);
    expect(sticky).toContain('field-cell field-cell--inline field-cell--span');
    expect(sticky).toContain('for="stickiness-enabled"');
    expect(risk).toContain('field-cell field-cell--inline field-cell--span');
    expect(risk).toContain('for="risk-jitter"');
    /* 风控那一格的说明在控件下方（字段格内）。 */
    expect(risk).toContain('data-i18n="routing.risk.jitterHeartbeat.hint"');
  });

  it("shows each collapse summary only while the section is collapsed", () => {
    /* 摘要复用同一份文案，但只在收起时显示——展开后数字就在字段里。 */
    for (const id of ["routing-queue", "routing-stickiness", "routing-risk"]) {
      expect(view).toContain(`class="collapse collapse--summary-when-closed" data-collapse="${id}"`);
    }
    const css = PAGE_COMPONENTS_CSS;
    const rule = css.slice(css.indexOf(".collapse--summary-when-closed"));
    expect(rule.slice(0, 120)).toContain('[data-collapse-open="true"] .collapse__summary');
    expect(rule.slice(0, 120)).toContain("display: none");
    // 别的折叠区（聊天的选择器组合摘要）不受影响：钩子类只挂在路由页三块上
    expect(html).toContain('class="collapse chat__settings"');
  });

  it("fills the panel with even columns and centers cell text", () => {
    const css = PAGE_COMPONENTS_CSS;
    const block = css.slice(css.indexOf("/* 账号 × 路由矩阵"), css.indexOf("/* 降级顺序列表"));
    /* 表格铺满面板、按列数等分：不再缩成内容宽度、不再按 ch 逐列定宽。 */
    const matrix = css.slice(css.indexOf(".table.matrix {"), css.indexOf(".table.matrix {") + 220);
    expect(matrix).toContain("width: 100%");
    expect(matrix).toContain("table-layout: fixed");
    expect(matrix).not.toContain("margin: 0 auto");
    expect(block).not.toContain("width: auto");
    expect(block).not.toContain("width: 21ch");
    expect(block).not.toContain("width: 14ch");
    /* 矩阵跟随全项目表格契约，块里**不再逐表重复对齐声明**：对齐与纵向中线只在
       基础规则里写一次，矩阵这里出现 `text-align` / `vertical-align` 就是双轨。 */
    expect(block).not.toContain("text-align:");
    expect(block).not.toContain("vertical-align:");
    expect(block).not.toContain("align-items: flex-start");
    expect(block).not.toContain("padding-left");
  });

  it("keeps one table contract: centered cells in the base rule, no per-table overrides", () => {
    const css = PAGE_COMPONENTS_CSS;
    /* 基础规则：单元格文本居中 + 纵向 middle，两件事只有这一处声明。 */
    const baseCells = css.slice(css.indexOf(".table th,\n.table td {"), css.indexOf(".table th,\n.table td {") + 260);
    expect(baseCells).toContain("text-align: center");
    expect(baseCells).toContain("vertical-align: middle");

    /* 逐表覆盖的对齐声明应当是 0 处：除基础规则外，`.table th` / `.table td` 选择器
       不再出现在任何对齐声明里（`.table--dense` 只改内边距与行高，`.table.matrix`
       只改列排布）。匹配只认选择器头（`{` 后面紧跟声明），注释段里的散文不算。 */
    const perTableAlignment = [
      ...css.matchAll(/^\.table[^{}]*\{[^{}]*text-align:[^{}]*\}/gm),
    ].map((match) => match[0]);
    /* 唯一合法的一条是基础 `.table th,\n.table td` 本身。 */
    expect(perTableAlignment.length).toBe(1);
    expect(perTableAlignment[0]).toContain(".table th,\n.table td {");

    /* 盒子级元素显式居中：`text-align` 管不到 flex 盒子，这几条缺一条就会看到
       内容贴着格子左边。 */
    const boxRules: Array<[string, string]> = [
      [".cell-stack {", "align-items: center"],
      [".cell-actions {", "justify-content: center"],
      [".key-cell {", "justify-content: center"],
      [".quota-cell__line {", "justify-content: center"],
      [".usage-tower {", "align-items: center"],
      [".quota-cell {", "align-items: center"],
      [".share__value {", "justify-content: center"],
    ];
    for (const [selector, declaration] of boxRules) {
      const rule = css.slice(css.indexOf(`\n${selector}`), css.indexOf(`\n${selector}`) + 260);
      expect(rule).toContain(declaration);
    }

    /* 逐表密度：基础档 `--space-3` 四边、紧档 `--space-3 --space-2`、密集档
       `--space-2` 四边——距离按表自定，不是全项目一个值。 */
    expect(baseCells).toContain("padding: var(--space-3)");
    const tightCells = css.slice(css.indexOf(".table--tight th,"), css.indexOf(".table--tight th,") + 120);
    expect(tightCells).toContain("padding: var(--space-3) var(--space-2)");
    /* 紧档必须排在基础规则之后：同特异性，后来者胜。 */
    expect(css.indexOf(".table th,\n.table td {")).toBeLessThan(css.indexOf(".table--tight th,"));
    const denseCells = css.slice(css.indexOf(".table--dense th,"), css.indexOf(".table--dense th,") + 120);
    expect(denseCells).toContain("padding: var(--space-2)");
    /* 矩阵沿用基础档，不在这里再声明 padding。 */
    const matrixBlock = css.slice(css.indexOf("/* 账号 × 路由矩阵"), css.indexOf("/* 降级顺序列表"));
    expect(matrixBlock).not.toContain("padding");

    /* 两张多列常规表（概览摘要 6 列 / 账号页 9 列）挂紧档；其余常规表留在基础档。 */
    const html = renderPanelPage();
    expect(html).toContain('class="table table--tight" data-role="accounts-table"');
    expect(html).toContain('class="table table--tight" data-role="page-accounts-table"');
    for (const role of ["keys-table", "proxies-table", "routing-matrix", "stats-group-table"]) {
      expect(html).not.toMatch(new RegExp(`class="table table--tight[^"]*" data-role="${role}"`));
    }
  });

  it("collapses the routing grid to one column with the settings-grid breakpoint (1023)", () => {
    const css = PAGE_COMPONENTS_CSS;
    const media = [...css.matchAll(/@media \(max-width: 1023px\) \{[\s\S]*?\n\}/g)]
      .map((match) => match[0])
      .find((block) => block.includes(".routing-grid"));
    expect(media).toBeDefined();
    expect(media).toContain(".routing-grid {\n    grid-template-columns: 1fr;\n  }");
    /* 基础规则必须写在断点之前，否则同优先级下会把单列盖回两列（踩过）。 */
    expect(css.indexOf(".routing-grid {")).toBeLessThan(css.indexOf(media as string));
    /* flow 页的 .page-body 是 flex 列：网格容器自己不参与压缩，矩阵面板才不会被
       压成一条（实测 42px）。 */
    const base = css.slice(css.indexOf(".routing-grid {"), css.indexOf(".routing-grid {") + 200);
    expect(base).toContain("flex: 0 0 auto");
    /* 手机宽度下字段网格回到一列 */
    const narrow = css.slice(css.indexOf("@media (max-width: 720px)"));
    expect(narrow).toContain(".field-grid {\n    grid-template-columns: 1fr;\n  }");
  });
});

/* ------------------------------------------------------------------------- */
/* 添加账号模态的布局                                                         */
/* ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- */
/* 模态统一接入 dialog：每个模态都有自己的壳与遮罩，开合不再自管 `hidden`         */
/* ------------------------------------------------------------------------- */

describe("every modal is registered as a dialog", () => {
  it("gives each modal a data-dialog shell and a matching scrim", () => {
    const html = renderPanelPage();
    /* 一份实现管全部浮层：账号详情、代理抽屉与表单、添加账号、创建 key、
       删除确认、二次确认、窄屏的「更多」面板。每个 id 都要
       同时有壳与遮罩，否则 Esc / 点外只能关一半。 */
    for (const id of [
      "account",
      "proxies",
      "proxies-form",
      "add",
      "keys-create",
      "delete",
      "confirm",
      "tabbar-more",
    ]) {
      expect(html).toContain(`data-dialog="${id}"`);
      expect(html).toContain(`data-dialog-scrim="${id}"`);
    }
  });

  it("keeps the mobile 更多 panel reachable instead of a dead placeholder", () => {
    const html = renderPanelPage();
    expect(html).toContain('data-role="tabbar-more"');
    expect(html).toContain('data-dialog="tabbar-more"');
    /* 面板里是另外五个视图的入口（统计 / 聊天 / API key / 设置 / 日志）。 */
    const panel = html.slice(html.indexOf('data-dialog="tabbar-more"'), html.indexOf('<!-- 添加账号'));
    for (const nav of ["stats", "chat", "keys", "settings", "logs"]) {
      expect(panel).toContain(`data-nav="${nav}"`);
    }
  });

});

describe("accessible structure of tables, tabs and live regions", () => {
  /* 只看 DOM：内联样式与运行时脚本里的同一批字符串（选择器、注释）不算结构。 */
  const html = renderPanelPage()
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "");

  it("gives all seven data tables a caption and every header a column scope", () => {
    /* 七张表：概览摘要 / 账号 / API key / 请求事件 / 路由矩阵 / 分组统计 / 代理抽屉。
       caption 复用区块已有的文案键，视觉上由 `.table__caption` 收起（留在静态流里，
       绝对定位会把表格行高的亚像素取整改掉，版式跟着动）。 */
    const tables = [...html.matchAll(/<table\b[^>]*>\s*<caption class="table__caption" data-i18n="([^"]+)">/g)].map(
      (match) => match[1],
    );
    expect(tables).toEqual([
      "overview.accounts.title",
      "stats.groups.title",
      "nav.accounts",
      "routing.matrix.title",
      "nav.keys",
      "logs.tab.requests",
      "proxies.drawer.title",
    ]);
    /* 每张表都有 caption；每个 `<th>` 都有 `scope="col"`（含账号表首列的复选框表头）。 */
    expect((html.match(/<table\b/g) ?? []).length).toBe(7);
    expect((html.match(/<caption\b/g) ?? []).length).toBe(7);
    const headers = [...html.matchAll(/<th\b[^>]*>/g)].map((match) => match[0]);
    expect(headers.length).toBeGreaterThan(30);
    expect(headers.filter((tag) => !tag.includes('scope="col"'))).toEqual([]);
    expect(html).toContain('<th scope="col" class="table__check">');
  });

  it("uses one tab contract everywhere: tablist container, tab buttons, aria-selected", () => {
    /* 全仓 tab 只有一套契约（对照添加账号模态已写完整的那条）：
       容器 `role="tablist"`、按钮 `role="tab"`、选中态 `aria-selected`。
       统计页 4 组 + 日志页 1 组，按文档序。 */
    const tablists = [...html.matchAll(/<div class="[^"]*" role="tablist"[^>]*>/g)].map((match) => match[0]);
    expect(tablists).toHaveLength(6);
    /* 每个 tab 按钮都同时有 role 与 aria-selected，没有裸 `aria-selected`。
       账号页的状态筛选（`data-account-filter`）是 `.tabs--filter` 的筛选器，
       不是 tablist 的成员，按设计不带这套属性——所以按键名清单取证。 */
    const tabButtons = [
      ...html.matchAll(/<button type="button" class="(?:tab|heatmap__tab)[^"]*"[^>]*data-(?:stats-range|stats-gran|stats-dim|heatmap-gran|log-tab|add-tab|account-filter)="[^"]*"[^>]*>/g),
    ].map((match) => match[0]);
    expect(tabButtons.length).toBeGreaterThan(20);
    const filterTabs = tabButtons.filter((tag) => tag.includes("data-account-filter="));
    expect(filterTabs).toHaveLength(4);
    expect(filterTabs.map((tag) => tag.includes('role="tab"'))).toEqual([false, false, false, false]);
    const contractTabs = tabButtons.filter((tag) => !tag.includes("data-account-filter="));
    expect(contractTabs.length).toBe(3 + 4 + 2 + 6 + 2 + 3);
    for (const tag of contractTabs) {
      expect([tag, tag.includes('role="tab"')]).toEqual([tag, true]);
      expect([tag, tag.includes('aria-selected="true"') || tag.includes('aria-selected="false"')]).toEqual([tag, true]);
    }
    expect(html).toContain('<div class="tabs" role="tablist" data-role="log-tabs">');
    expect(html).toContain('<div class="heatmap__tabs" role="tablist">');
  });

  it("announces errors and notices through live regions on static banners", () => {
    /* 静态 DOM 只翻 `hidden`：加一个 role 就够，由无到有那一次变化会被读出来。 */
    for (const role of [
      "accounts-error",
      "routing-error",
      "settings-error",
      "stats-error",
      "keys-error",
      "chat-error",
      "add-error",
      "proxies-error",
    ]) {
      expect(html).toMatch(new RegExp(`data-role="${role}" role="alert" hidden`));
    }
    for (const role of ["accounts-notice", "settings-notice", "keys-notice", "chat-notice", "proxies-notice", "log-paused"]) {
      expect(html).toMatch(new RegExp(`data-role="${role}" role="status" hidden`));
    }
  });

  it("keeps the chat stream out of the live region and announces completion instead", () => {
    expect(html).toContain('<div class="chat__log fill-region" data-role="chat-log"></div>');
    expect(html).not.toContain('data-role="chat-log" aria-live');
    expect(html).toContain('<p class="sr-only" data-role="chat-done" aria-live="polite"></p>');
    /* 两份视觉隐藏：表格名（`.table__caption`，留在静态流里）与聊天播报
       （`.sr-only`，绝对定位）。都在组件层（不是 base.css，那份归 X3）。 */
    expect(PAGE_COMPONENTS_CSS).toContain("\n.sr-only {");
    expect(PAGE_COMPONENTS_CSS).toContain("clip-path: inset(50%)");
    expect(PAGE_COMPONENTS_CSS).toContain("\n.table__caption {");
    /* 表格名不进表头高度：caption 一旦绝对定位，行高的亚像素取整会变。 */
    const captionRule = PAGE_COMPONENTS_CSS.slice(PAGE_COMPONENTS_CSS.indexOf("\n.table__caption {"));
    expect(captionRule.slice(0, captionRule.indexOf("}"))).not.toContain("position");
  });

  it("names the icon-only and unlabeled controls", () => {
    /* 搜索框、导出格式下拉与整图链接都要有名字（前两个是静态属性，第三个由视图写）。 */
    expect(html).toContain('aria-label:accounts.search.label');
    expect(html).toContain('data-role="accounts-exportFormat" data-i18n-attr="aria-label:settings.export.format"');
    expect(html).toContain('data-role="usage-link"');
    /* 两个原本硬编码中文的可访问名补上翻译通道。 */
    expect(html).toContain('data-i18n-attr="aria-label:chat.sessions.title" aria-label="会话"');
    expect(html).toMatch(/data-dialog-close="proxies"\s+data-i18n-attr="aria-label:common.close"\s+aria-label="关闭"/);
  });

  it("stops the selected pill from changing weight, so the row no longer shifts", () => {
    /* 选中态只有底色与文字色：字重变化会改盒宽，同排胶囊跟着横移 1–2px。 */
    const seg = PAGE_COMPONENTS_CSS.slice(PAGE_COMPONENTS_CSS.indexOf(".tabs--seg .tab--active {"));
    const segRule = seg.slice(0, seg.indexOf("}"));
    expect(segRule).not.toContain("font-weight");
    const heat = PAGE_COMPONENTS_CSS.slice(PAGE_COMPONENTS_CSS.indexOf(".heatmap__tab--active {"));
    const heatRule = heat.slice(0, heat.indexOf("}"));
    expect(heatRule).not.toContain("font-weight");
  });
});

describe("add-account modal layout", () => {
  const html = renderPanelPage();
  const css = PAGE_COMPONENTS_CSS;
  const tokens = PAGE_TOKENS_CSS;

  it("sits in its own width tier (600px) instead of the standard 560", () => {
    expect(tokens).toContain("--layout-modal-md: 600px");
    /* 模态带 `modal--md`，宽度走 token，不在选择器里写裸值。 */
    expect(html).toContain('class="modal modal--md"');
    const rule = css.slice(css.indexOf(".modal--md {"), css.indexOf(".modal--md {") + 120);
    expect(rule).toContain("width: min(var(--layout-modal-md), 92vw)");
    /* 标准模态那一档不受影响：另外三个模态仍是 560px。 */
    expect(tokens).toContain("--layout-modal-width: 560px");
  });

  it("puts every tab's fields on the one field-cell skeleton, stacked in one column", () => {
    /* 弹窗表单与全项目同一套骨架：`.field-grid` > `.field-cell`，标签在上、
       控件吃满格。弹窗宽 560 / 600px，网格在弹窗内收成一列；旧的 100px 定宽
       标签列（`--layout-modal-label`）已随旧骨架删除。 */
    expect(tokens).not.toContain("--layout-modal-label");
    const stacked = css.slice(css.indexOf("\n.modal .field-grid {"), css.indexOf("\n.modal .field-grid {") + 120);
    expect(stacked).toContain("grid-template-columns: 1fr");
    /* 登录 1 格 + 导入凭据 4 格（来源 / 凭据文件 / 服务端路径 / API key 对 + 出身）
       + 粘贴 JWT 2 格 + 账号名一格。 */
    const modal = html.slice(html.indexOf('data-role="add-modal"'), html.indexOf('data-role="keys-create-modal"'));
    const labels = (modal.match(/class="field-cell__label"/g) ?? []).length;
    expect(labels).toBe(9);
    for (const tab of ["login", "credential", "jwt"]) {
      const panel = modal.slice(modal.indexOf(`data-add-panel="${tab}"`));
      const rows = panel.slice(0, panel.indexOf("data-add-panel=", 10) === -1 ? panel.length : panel.indexOf("data-add-panel=", 10));
      expect([tab, rows.includes('class="field-grid"')]).toEqual([tab, true]);
      expect([tab, rows.includes('class="field-cell')]).toEqual([tab, true]);
    }
    /* 没有「裸 span 当标签」的覆盖规则。 */
    expect(css).not.toContain(".modal [data-add-panel] > .field");
  });

  it("renders the authorize link as a hint plus actions, never the URL itself", () => {
    /* 授权链接不再摊在页面上：那串 query 占六行、没人读它。链接区只剩一句
       「这条链接干什么用」和两个动作（复制 / 在本机打开）；地址留在 JS 的
       `loginFlow.authorizeUrl` 里，复制与打开都从那里取。 */
    const modal = html.slice(html.indexOf('data-role="add-modal"'), html.indexOf('data-role="keys-create-modal"'));
    const login = modal.slice(modal.indexOf('data-add-panel="login"'), modal.indexOf('data-add-panel="credential"'));
    expect(login).toContain('<div class="login-flow__link-row" data-role="login-link-row" hidden>');
    expect(login).toContain('data-i18n="accounts.add.login.linkHint"');
    expect(login).toContain('data-action="login-copy"');
    expect(login).toContain('data-action="login-open"');
    /* 没有承载链接原文的节点，也没有 `<code>` 占位。 */
    expect(login).not.toContain('data-role="login-link"');
    expect(login).not.toContain("<code");
    /* 新增的键在两种语言里都在。 */
    for (const dictionary of [PAGE_DICTIONARIES.zh, PAGE_DICTIONARIES.en] as Array<Record<string, string>>) {
      expect(typeof dictionary["accounts.add.login.linkHint"]).toBe("string");
    }
    /* 链接区不再是「横排一格」：说明与按钮各占一行（侧栏式横排会把说明挤成窄条）。 */
    const row = css.slice(css.indexOf("\n.login-flow__link-row {"), css.indexOf("\n.login-flow__link-row {") + 160);
    expect(row).toContain("flex-direction: column");
  });

  it("keeps hints under the control, never between fields", () => {
    /* 说明一律落在字段格里、控件下方：格子里先有控件（input / select / textarea /
       按钮组），再有 `.hint`。 */
    const modal = html.slice(html.indexOf('data-role="add-modal"'), html.indexOf('data-role="keys-create-modal"'));
    const cells = modal.split('<div class="field-cell').slice(1);
    expect(cells.length).toBe(9);
    /* 说明在**控件之后**：带说明的格子里，第一句 `.hint` 落在控件（输入框 /
       下拉 / 按钮行 / 单选列表）后面，说明不在标签与控件之间。 */
    let cellsWithHint = 0;
    for (const cell of cells) {
      const hintAt = cell.indexOf('class="hint"');
      if (hintAt === -1) continue;
      cellsWithHint += 1;
      const controlAt = Math.max(
        cell.indexOf('class="field'),
        cell.indexOf('class="select"'),
        cell.indexOf('class="row"'),
        cell.indexOf('class="login-flow__providers"'),
        cell.indexOf('class="choice-list"'),
      );
      expect(controlAt).toBeGreaterThan(0);
      expect(hintAt).toBeGreaterThan(controlAt);
    }
    /* 登录（二维码说明）/ 凭据文件 / 服务端路径 / API key 对 / JWT 出身 / 账号名：
       六格带说明。 */
    expect(cellsWithHint).toBe(6);
    /* 其余说明挂在格子之外、是**块级说明**而不是字段说明（说明的第二种位置）：
       链接区的一行说明与复制结果、扫描列表的空态、凭据来源那一格没有 attach。 */
    const standalone = (modal.match(/class="hint/g) ?? []).length - cellsWithHint;
    expect(standalone).toBe(4);
    expect(modal).toContain('class="hint" data-role="add-sources-none"');
    expect(modal).toContain('class="hint" data-role="login-copy-hint"');
    expect(modal).toContain('data-i18n="accounts.add.login.linkHint"');
  });

  it("gives the four tabs equal-width, equal-height 36px controls", () => {
    const rule = css.slice(
      css.indexOf(".modal .field-cell > .field,"),
      css.indexOf(".modal .field-cell > .field,") + 200,
    );
    expect(rule).toContain("width: 100%");
    expect(rule).toContain("height: var(--control-height)");
    /* 多行框只放宽高度，宽度仍吃满格子。 */
    const area = css.slice(css.indexOf(".modal .field-cell > .field--area"), css.indexOf(".modal .field-cell > .field--area") + 80);
    expect(area).toContain("height: auto");
  });

  it("stacks the scan cards inside the path field cell and clips long paths", () => {
    /* `order-item--stack` 以前是个只有名字、没有样式的类：扫描卡片靠 `.order-item`
       的横排规则撑着，长路径把卡片顶出字段右边界。现在两件事都落实：
       卡片自己在字段格里（路径输入框、卡片、「API key 对」同一条左边缘），
       堆叠态是 column，路径一行截断。 */
    const server = html.slice(html.indexOf('data-add-group="server"'), html.indexOf('data-add-panel="jwt"'));
    expect(server).toContain('class="field-cell"');
    expect(server).toContain('data-add-group="server" hidden>');
    expect(server).toContain('data-role="add-sources"');
    expect(server.indexOf('data-role="add-file-path"')).toBeLessThan(server.indexOf('data-role="add-sources"'));
    const stack = css.slice(css.indexOf(".order-item--stack {"), css.indexOf(".order-item--stack {") + 400);
    expect(stack).toContain("flex-direction: column");
    expect(stack).toContain("align-items: stretch");
    const name = css.slice(css.indexOf(".order-item--stack .order-item__name {"), css.indexOf(".order-item--stack .order-item__name {") + 240);
    expect(name).toContain("overflow: hidden");
    expect(name).toContain("text-overflow: ellipsis");
    expect(name).toContain("white-space: nowrap");
    const actions = css.slice(css.indexOf(".order-item--stack .order-item__actions {"), css.indexOf(".order-item--stack .order-item__actions {") + 160);
    expect(actions).toContain("margin-left: 0");
  });

  it("orders the tabs login-first and marks login active", () => {
    /* 只看模态里那条 tab 条：右上角两粒登录按钮也带 data-add-tab。
       两个 indexOf 都从 modalStart 起搜——热力图的 tablist 在文档里
       早于本模态，全文搜会把 strip 截成空。 */
    const modalStart = html.indexOf('data-role="add-modal"');
    const strip = html.slice(modalStart, html.indexOf("</div>", html.indexOf('role="tablist"', modalStart)));
    const tabs = [...strip.matchAll(/class="tab([^"]*)"[^>]*data-add-tab="([a-z]+)"/g)].map((match) => ({
      active: (match[1] as string).includes("tab--active"),
      tab: match[2],
    }));
    expect(tabs.map((entry) => entry.tab)).toEqual(["login", "credential", "jwt"]);
    expect(tabs.filter((entry) => entry.active).map((entry) => entry.tab)).toEqual(["login"]);
  });

  it("leaves the accounts header with just proxies + add-account", () => {
    /* 右上角只剩两颗：「出口代理」（次级）在前、「添加账号」（主动作）在后。
       两粒「登录 zai / 登录 bigmodel」随本批删除——它们只是把模态开到登录 tab
       的快捷方式，而「添加账号」默认就落在登录 tab、服务商按当前账号预选。 */
    /* 从账号视图的开标签起搜：keys 页也有一块 `page-header__actions`，全文搜会切到它。 */
    const accountsAt = html.indexOf('data-view="accounts"');
    const actionsAt = html.indexOf('<div class="page-header__actions">', accountsAt);
    const header = html.slice(actionsAt, html.indexOf("</header>", actionsAt));
    const actions = [...header.matchAll(/data-action="([a-z-]+)"/g)].map((match) => match[1]);
    expect(actions).toEqual(["accounts-open-proxies", "open-add"]);
    expect(header.indexOf('data-action="accounts-open-proxies"')).toBeLessThan(header.indexOf('data-action="open-add"'));
    expect(header).toContain("btn btn--primary");
    expect(html).not.toContain('data-add-provider="');
    expect(html).not.toContain("system.login.zai");
    /* 没有独立的直连流程动作。 */
    expect(html).not.toContain("accounts-login-zai");
    expect(html).not.toContain("accounts-login-bigmodel");
  });
});
