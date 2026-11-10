/**
 * 页面拼装：面板与登录页的服务端出口。
 *
 * 两个页面共用这一套拼装：控制面（`page.html`）与登录页（`login.html`）。它们共用
 * 同一份 token 与同一份组件类，所以两页的配色与尺寸不会漂移。聊天不是独立页，它是
 * 面板侧边栏的一个视图，随面板文档一起拼装。
 *
 * 三层各有各的文件，页面本身不含样式：
 *
 *   tokens.css      只有 `:root` 变量（浅色 + 深色）
 *   styles/*.css    只有组件类，全部引用 token（按视图分片段，见下方拼接数组）
 *   page.html + views/*.html + page-tail.html  页面骨架，只组合组件
 *
 * 内嵌资源不能靠 `<link>` 或 `@import`（页面要跟着单文件可执行产物走，零构建链、
 * 零构建链），所以在服务端把三层**拼成一个 HTML**：骨架里的占位符换成对应资源的
 * 原文，一次拼好、按字符串发出去。浏览器侧没有任何加载步骤。
 *
 * 拼装是纯函数：同样的输入永远得到同样的字节，因此可以在测试里逐条断言
 * （token 完整性、无硬编码色值、无外链…）。
 *
 * 运行时脚本也不是一个文件：`APP_MODULES` 把十几个职责单一的模块按依赖顺序拼成
 * 一段（零构建链、不改成 ES module），顺序错了不会在拼装期报错，所以 `page.test.ts`
 * 逐段核对顺序与完整性。
 *
 * 组件样式与页面骨架按职责分片段：`styles/base.css`、`styles/components.css`、
 * `styles/views/*.css` 装样式，`views/*.html` 装视图，`page.html` 是壳与侧边栏，
 * `page-tail.html` 是文档收尾。入口不是单个 import，而是 `COMPONENT_CSS_PARTS` /
 * `PAGE_HTML_PARTS` 两个数组：数组顺序 = CSS 层叠顺序 / DOM 顺序，顺序错了拼装期不
 * 报错，所以 `page.test.ts` 逐段核对顺序与完整性。
 */
import pageHead from "./page.html" with { type: "text" };
import overviewHtml from "./views/overview.html" with { type: "text" };
import statsHtml from "./views/stats.html" with { type: "text" };
import accountsHtml from "./views/accounts.html" with { type: "text" };
import routingHtml from "./views/routing.html" with { type: "text" };
import keysHtml from "./views/keys.html" with { type: "text" };
import logsHtml from "./views/logs.html" with { type: "text" };
import settingsHtml from "./views/settings.html" with { type: "text" };
import chatHtml from "./views/chat.html" with { type: "text" };
import pageTail from "./page-tail.html" with { type: "text" };
import loginTemplate from "./login.html" with { type: "text" };
import tokensCss from "./tokens.css" with { type: "text" };
import baseCss from "./styles/base.css" with { type: "text" };
import componentsCssParts from "./styles/components.css" with { type: "text" };
import logsCss from "./styles/views/logs.css" with { type: "text" };
import settingsCss from "./styles/views/settings.css" with { type: "text" };
import chatCss from "./styles/views/chat.css" with { type: "text" };
import themeBootScript from "./theme-boot.js" with { type: "text" };
import appConstants from "./app-constants.js" with { type: "text" };
import appQr from "./qr.js" with { type: "text" };
import appState from "./app-state.js" with { type: "text" };
import appDom from "./app-dom.js" with { type: "text" };
import appFormat from "./app-format.js" with { type: "text" };
import appI18n from "./app-i18n.js" with { type: "text" };
import appForms from "./app-forms.js" with { type: "text" };
import appChatAttachments from "./app-chat-attachments.js" with { type: "text" };
import appChatSessions from "./app-chat-sessions.js" with { type: "text" };
import appChatStream from "./app-chat-stream.js" with { type: "text" };
import appTheme from "./app-theme.js" with { type: "text" };
import appSidebar from "./app-sidebar.js" with { type: "text" };
import appWidgets from "./app-widgets.js" with { type: "text" };
import appApi from "./app-api.js" with { type: "text" };
import appSse from "./app-sse.js" with { type: "text" };
import appConfirm from "./app-confirm.js" with { type: "text" };
import appCharts from "./app-charts.js" with { type: "text" };
import appViewOverview from "./app-view-overview.js" with { type: "text" };
import appViewStats from "./app-view-stats.js" with { type: "text" };
import appAccountsPlanCards from "./app-accounts-plan-cards.js" with { type: "text" };
import appAccountsTable from "./app-accounts-table.js" with { type: "text" };
import appAccountsDetail from "./app-accounts-detail.js" with { type: "text" };
import appViewAccounts from "./app-view-accounts.js" with { type: "text" };
import appViewRouting from "./app-view-routing.js" with { type: "text" };
import appViewKeys from "./app-view-keys.js" with { type: "text" };
import appViewProxies from "./app-view-proxies.js" with { type: "text" };
import appLogsSystemStream from "./app-logs-system-stream.js" with { type: "text" };
import appLogsRequestTable from "./app-logs-request-table.js" with { type: "text" };
import appViewLogs from "./app-view-logs.js" with { type: "text" };
import appViewChat from "./app-view-chat.js" with { type: "text" };
import appViewAccount from "./app-view-account.js" with { type: "text" };
import appViewSettings from "./app-view-settings.js" with { type: "text" };
import appClaimState from "./app-claim-state.js" with { type: "text" };
import appRefresh from "./app-refresh.js" with { type: "text" };
import appShell from "./app-shell.js" with { type: "text" };
import appAddAccount from "./app-add-account.js" with { type: "text" };
import appEntry from "./app.js" with { type: "text" };
import loginScript from "./login.js" with { type: "text" };
import zhDictionary from "./i18n/zh.json" with { type: "json" };
import enDictionary from "./i18n/en.json" with { type: "json" };

/**
 * 运行时脚本的拼接顺序，就是依赖顺序。
 *
 * 每个文件都是一个独立 IIFE，通过挂在 `window.__zcodeApp` 上的命名空间通信：常量与
 * 状态先就位，工具层（DOM / 格式化 / i18n / 表单 / 主题 / 组件行为）其次，请求与
 * 事件流再次，各视图最后，`app.js` 收尾（它负责 `init()`，可以调用前面所有模块）。
 *
 * 前面定义的东西后面能用，反过来不行。唯一的例外是视图反过来调 `App.renderState`
 * 与 `App.shell.*`，那是在事件回调里发生的，此时全部脚本已经执行完毕。
 *
 * `qr.js` 排在常量之后：它自带常量，只往 `App.qr` 上挂两个函数，与其它模块无依赖。
 *
 * 聊天视图的三类零件：`app-chat-attachments.js`（图片 blob 存储层）→
 * `app-chat-sessions.js`（会话状态与持久化）→ `app-chat-stream.js`（请求体组装与
 * SSE 解析）→ `app-view-chat.js`（编排、DOM、事件）。前三块是那个视图的零件，
 * 都排在视图模块之前：视图在定义期就取它们的命名空间（`App.chatSessions` /
 * `App.chatStream`），不是等事件回调里再取。
 */
const APP_MODULES = [
  appConstants,
  appQr,
  appState,
  appDom,
  appFormat,
  appI18n,
  appForms,
  appChatAttachments,
  appChatSessions,
  appChatStream,
  appTheme,
  appSidebar,
  appWidgets,
  appApi,
  appSse,
  appConfirm,
  appCharts,
  appClaimState,
  appViewOverview,
  appViewStats,
  /* 账号页的三个子系统：套餐卡 → 表格 → 详情窗，主视图编排收尾。*/
  appAccountsPlanCards,
  appAccountsTable,
  appAccountsDetail,
  appViewAccounts,
  appViewRouting,
  appViewKeys,
  appViewProxies,
  /* 日志页的两个渲染模块排在视图模块之前：`app-view-logs.js` 在加载时就取
     `App.logsStream` / `App.logsRequests`（系统 tab 的日志流、请求表），
     它们在自身的 IIFE 里挂到 `window.__zcodeApp` 上。 */
  appLogsSystemStream,
  appLogsRequestTable,
  appViewLogs,
  appViewChat,
  appViewAccount,
  appViewSettings,
  appRefresh,
  appShell,
  appAddAccount,
  appEntry,
];

/**
 * 拼好的运行时脚本。
 *
 * 模块之间用换行分隔：每个文件自己以 `/*` 开头、以 `})();` 结尾，不加分隔符也能跑，
 * 但换行让出错时的行号与单个源文件对得上（浏览器报的行号是拼接后的）。
 */
const appScript = APP_MODULES.join("\n");

/**
 * 登录页的运行时。
 *
 * 与面板同一组零件，只换最后一层：未登录时页面能做的只有「提交用户名与密码」，
 * 没有视图、没有事件流、也没有任何 `/api/*` 读取。
 */
const LOGIN_MODULES = [appConstants, appState, appDom, appI18n, appTheme, loginScript];

/** 拼好的登录页运行时（同上：换行保留源文件行号）。*/
const loginScriptText = LOGIN_MODULES.join("\n");

/**
 * `bun-types` 把 `*.html` 声明成 Bun 的 `HTMLBundle`（它的默认 loader），但上面显式
 * 写了 `with { type: "text" }`，走的是 text loader，运行时就是一个字符串。这里只做
 * 一次类型收窄，把 `@types/bun` 的默认假设和本文件的显式选择对齐。
 *
 * SAFETY: Bun 按 import attribute 选 loader，`type: "text"` 的 `.html` 导入结果
 * 是 string（已用 `bun -e` 实测：`typeof === "string"`）；`HTMLBundle` 只是默认
 * loader 的类型，TS 看不到 import attribute 对 loader 的选择。
 */
const head = pageHead as unknown as string;

/**
 * SAFETY: 同上，理由一样：八个视图片段与文件尾也走 `with { type: "text" }`。
 */
const overview = overviewHtml as unknown as string;
const stats = statsHtml as unknown as string;
const accounts = accountsHtml as unknown as string;
const routing = routingHtml as unknown as string;
const keys = keysHtml as unknown as string;
const logs = logsHtml as unknown as string;
const settings = settingsHtml as unknown as string;
const chat = chatHtml as unknown as string;
const tail = pageTail as unknown as string;

/**
 * SAFETY: 同上面那次收窄，理由一样：`login.html` 的导入也写了 `with { type: "text" }`，
 * Bun 按 import attribute 选 loader，所以运行时是 string；`HTMLBundle` 只是默认
 * loader 的类型，TS 看不到 import attribute 对 loader 的选择。
 */
const loginPageTemplate = loginTemplate as unknown as string;

/**
 * 组件样式的拼接片段，**顺序 = CSS 层叠顺序**（后出现的片段压过前面的）。
 *
 * 片段按源序分文件：`base.css`（骨架与基础组件）、`styles/components.css`（通用组件）、
 * `styles/views/logs.css`（日志）、`styles/views/settings.css`（设置与表单）、
 * `styles/views/chat.css`（聊天）。层叠靠源序决胜负，顺序错一个位置就是另一套样式，
 * 而拼接期不会报错——所以顺序契约写在这里，`page.test.ts` 核对拼接产物与按序
 * 读到的片段逐字节相同。
 *
 * 两个页面（面板 / 登录页）共用这一份：它们本来就是同一套组件类。
 */
const COMPONENT_CSS_PARTS: readonly string[] = [
  baseCss,
  componentsCssParts,
  logsCss,
  settingsCss,
  chatCss,
];

/**
 * 面板骨架的拼接片段，**顺序 = DOM 顺序**。
 *
 * 八个 `data-view` 视图块各占 `views/*.html` 里的一项，按原 DOM 顺序排列。
 * 登录页模板（`login.html`）不参与这个数组。`page.html` 是文件头（壳与侧边栏，
 * 到概览视图之前），`page-tail.html` 是最后一个视图之后的收尾
 * （`</main>` 闭合、移动端 tabbar、浮层、字典与脚本占位、`</body></html>`）。
 * 数组顺序就是原文件的字节顺序。
 *
 * 代理没有自己的视图片段：它是账号页抽屉里的字典表，骨架在
 * `page-tail.html` 的浮层区。
 */
const PAGE_HTML_PARTS: readonly string[] = [
  head,
  overview,
  stats,
  accounts,
  routing,
  keys,
  logs,
  settings,
  chat,
  tail,
];

/**
 * 拼好的组件样式与面板骨架。
 *
 * 单片段时 `[x].join("\n") === x`，与拆分前**逐字节一致**；多片段时片段之间补一个
 * 换行，片段文件自己的首尾换行因此成为唯一的分隔来源。
 */
const componentsCssText = COMPONENT_CSS_PARTS.join("\n");
const pageHtmlText = PAGE_HTML_PARTS.join("\n");

/** `page.html` 里的五个占位符。改占位符要同时改这里和 `page.html` 的注释。*/
const THEME_BOOT_SLOT = "<!-- THEME-BOOT -->";
const TOKENS_SLOT = "<!-- TOKENS -->";
const COMPONENTS_SLOT = "<!-- COMPONENTS -->";
const I18N_SLOT = "/* I18N */";
const APP_SLOT = "/* APP */";

/** `login.html` 的五个占位符（前四个与面板同名，最后一个不同）。*/
const LOGIN_SLOT = "/* LOGIN */";

/** 两套字典：单套 HTML，前端拿两份 JSON 自己查表；不生成两套页面。*/
export const PAGE_DICTIONARIES = { zh: zhDictionary, en: enDictionary } as const;

/** 内联进页面的样式与脚本原文（测试要单独校验，所以一并导出）。*/
export const PAGE_TOKENS_CSS = tokensCss;

/**
 * 组件样式 = `COMPONENT_CSS_PARTS` 的拼接产物（不是任何一个源文件）。
 *
 * 它是组件样式的唯一真值：由 `COMPONENT_CSS_PARTS` 拼出，改样式时改对应片段。
 * 消费方按「一段 CSS 文本」用。
 */
export const PAGE_COMPONENTS_CSS = componentsCssText;
export const PAGE_APP_SCRIPT = appScript;
export const LOGIN_PAGE_SCRIPT = loginScriptText;

/** 拼接产物本身：测试按它核对片段顺序与完整性。*/
export function joinedComponentsCss(): string {
  return componentsCssText;
}

/** 面板骨架的拼接产物（同上）。*/
export function joinedPageHtml(): string {
  return pageHtmlText;
}

/**
 * 把两套字典塞进 `<script type="application/json">`。
 *
 * `<` 一律转成 `\u003c`：字典里万一出现 `</script` 就会提前结束脚本块，而 HTML 的
 * 分词规则不允许这种字符出现在 script 数据里。JSON 的 `\u003c` 转义对 `JSON.parse`
 * 完全等价，所以这只是把「不可能」变成「结构上不可能」。
 */
function dictionariesJson(): string {
  return JSON.stringify(PAGE_DICTIONARIES).replace(/</g, "\\u003c");
}

/** 替换一次占位符，并断言确实替换到了（占位符是拼装契约的一部分）。*/
function fill(source: string, slot: string, content: string): string {
  if (!source.includes(slot)) throw new Error(`page.html is missing the ${slot} slot`);
  return source.replace(slot, () => content);
}

/**
 * 拼出完整的页面 HTML。
 *
 * 顺序有意义：`THEME-BOOT` 在 `<head>` 里、**早于**两个 `<style>`，否则首屏会先按
 * 默认色板画一帧再翻色（防闪烁）。
 */
export function renderPanelPage(): string {
  const withTheme = fill(pageHtmlText, THEME_BOOT_SLOT, themeBootScript);
  const withTokens = fill(withTheme, TOKENS_SLOT, tokensCss);
  const withComponents = fill(withTokens, COMPONENTS_SLOT, componentsCssText);
  const withDictionaries = fill(withComponents, I18N_SLOT, dictionariesJson());
  return fill(withDictionaries, APP_SLOT, appScript);
}

/**
 * 拼出登录页 HTML（`panel.ts` 的 `GET /login`）。
 *
 * 与面板走同一套三层结构：同一份 token、同一份组件类、同一份字典。登录页
 * 不需要任何新样式源，所以未登录时看到的那一页与登录之后是同一个视觉体系。
 */
export function renderLoginPage(): string {
  const withTheme = fill(loginPageTemplate, THEME_BOOT_SLOT, themeBootScript);
  const withTokens = fill(withTheme, TOKENS_SLOT, tokensCss);
  const withComponents = fill(withTokens, COMPONENTS_SLOT, componentsCssText);
  const withDictionaries = fill(withComponents, I18N_SLOT, dictionariesJson());
  return fill(withDictionaries, LOGIN_SLOT, loginScriptText);
}
