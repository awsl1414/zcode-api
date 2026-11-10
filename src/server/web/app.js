/*
 * app.js — 页面运行时的入口：按 `location.pathname` 选视图、绑定事件、启动轮询与
 * 事件流，并把一份状态载荷分发给各视图。
 *
 * 这一层只做编排，不做渲染。页面拆成多个文件之后，模块之间靠挂在 `window.__zcodeApp`
 * 上的命名空间通信，拼接顺序就是依赖顺序（见 `page.ts`）：本文件排最后，所以它
 * 可以调用前面所有模块，而前面那些模块只在自己被调用时才回头找这里的 `renderState`。
 *
 * 分发是这一层的核心职责：`/api/state` 的轮询结果与 `state` 事件是同一份载荷，
 * 谁先到都走 `renderState`，视图不会看到两份不一致的输入。
 *
 * 两条优先级链（文档里唯一的两处「谁覆盖谁」）：
 *   主题：localStorage > prefers-color-scheme > light
 *   语言：localStorage > navigator.language > en
 */
(function (App) {
  "use strict";

  var C = App.const;
  var state = App.state;
  var byRole = App.dom.byRole;
  var setHidden = App.dom.setHidden;
  var t = App.i18n.t;

  /* ---- 视图选择 -------------------------------------------------------- */

  function readView() {
    var path = window.location.pathname;
    if (path === C.ROUTE_PATH_ACCOUNTS) return C.VIEW_ACCOUNTS;
    if (path === C.ROUTE_PATH_ROUTING) return C.VIEW_ROUTING;
    if (path === C.ROUTE_PATH_KEYS) return C.VIEW_KEYS;
    if (path === C.ROUTE_PATH_LOGS) return C.VIEW_LOGS;
    if (path === C.ROUTE_PATH_SETTINGS) return C.VIEW_SETTINGS;
    if (path === C.ROUTE_PATH_STATS) return C.VIEW_STATS;
    /* `/` 与 `/panel` 都是概览：panel.ts 只把这几条路径映射到本文档。
       `/proxies` 不存在（代理并进账号页抽屉）：它落到代理路由，回 404。 */
    return C.VIEW_OVERVIEW;
  }

  /**
   * 显隐一个视图（容器与侧边栏的选中态），并让每页按需取自己的数据。
   *
   * 从 `applyView` 拆出来是因为聊天视图没有路径：页面加载时按 pathname
   * 选视图（`applyView`），侧边栏的「聊天」则客户端直切（`switchToChat`），
   * 两条路都要做同一套显隐与取数。
   */
  function showView(view) {
    state.activeView = view;
    var views = document.querySelectorAll("[data-view]");
    for (var i = 0; i < views.length; i++) {
      setHidden(views[i], views[i].getAttribute("data-view") !== state.activeView);
    }
    var navs = document.querySelectorAll("[data-nav]");
    for (var j = 0; j < navs.length; j++) {
      var active = navs[j].getAttribute("data-nav") === state.activeView;
      navs[j].className = navs[j].className.replace(/\s*nav--active|\s*tabbar__item--active/g, "");
      navs[j].className += active
        ? (navs[j].className.indexOf("tabbar__item") === 0 ? " tabbar__item--active" : " nav--active")
        : "";
      if (active) navs[j].setAttribute("aria-current", "page");
      else navs[j].removeAttribute("aria-current");
    }
    /* 日志页是唯一需要长连接的视图：进页面才订阅，离开就断开（不留一条后台流）*/
    App.sse.sync();
    /* 缓冲是跨视图保留的（回到日志页仍能看到刚才的行），所以每次应用视图都重画一次 */
    App.views.logs.render();
    /* 设置页每次进来都重新读一遍配置文件（它可能被别的入口改过）。「账户」组在同一页里，
       所以顺带读一次当前登录的人（改密码之后用户名不变，但会话可能已经换过）。*/
    if (state.activeView === C.VIEW_SETTINGS) {
      App.api.loadSettings();
      if (App.state.lastState) App.views.settings.adoptClaimOverview(App.state.lastState.claim);
      App.views.account.load();
    }
    /* API key 页同理：key 表不在 `/api/state` 的轮询载荷里，进页面才取一次 */
    if (state.activeView === C.VIEW_KEYS) App.views.keys.load();
    /* 统计页同理：报表数据只在这里拉（进视图一次，含热力图）。
       之后的切范围 / 刷新都是视图自己的动作，不回到这里。 */
    if (state.activeView === C.VIEW_STATS) App.views.stats.enter();
    /* 日志页：外部带进来的筛选参数（统计视图的 key 行 / keys 页的用量
       链接）在进页面时消费一次——跳转链接形如 /logs?tab=requests&key=<id>。 */
    if (state.activeView === C.VIEW_LOGS) App.views.logs.enter();
    /* 代理表同理，而且账号页的代理下拉也读它：进这一页时重取一次 */
    if (state.activeView === C.VIEW_ACCOUNTS) App.proxies.load();
    /* 聊天视图：第一次进入时做独立页时代 init() 的那套初始化（绑事件、
       探会话、读模型列表）。视图本身没有路径，进不进由 switchToChat 决定。 */
    if (state.activeView === C.VIEW_CHAT) App.views.chat.enter();
    /* 顶栏刷新：可用态跟着视图走（聊天 / 日志的系统 tab 置灰）。
       排在所有 `enter` 之后：日志页的 enter 会切 tab，而 tab 决定能不能刷。 */
    App.refresh.sync();
  }

  function applyView() {
    showView(readView());
  }

  /* ---- 聊天视图切换 ---------------------------------------------------- */

  /**
   * pushState 条目里的标记：前进方向靠它认出「这一条历史是聊天」。
   *
   * 回退方向不需要它：聊天切换从不改 pathname，落回旧条目时按 pathname 重读
   * 就是切之前的视图。
   */
  var CHAT_HISTORY_FLAG = "zcodePanelChatView";

  /**
   * 切到聊天视图（侧边栏项，顶栏没有第二个入口）。
   *
   * 独立页时代这是 `target="_blank"` 的外链；现在它与侧边栏同一个行为：显隐容器，
   * 不新开标签页。`pushState` 压一条同地址的历史，让浏览器回退能回到切之前的
   * 视图、前进对称地回到聊天——地址不变，所以不引入面板本来没有的 hash 路由。
   */
  function switchToChat() {
    if (state.activeView === C.VIEW_CHAT) return;
    showView(C.VIEW_CHAT);
    var entry = {};
    entry[CHAT_HISTORY_FLAG] = true;
    window.history.pushState(entry, "", window.location.href);
  }

  function onPopState(event) {
    var st = event.state;
    showView(st && st[CHAT_HISTORY_FLAG] === true ? C.VIEW_CHAT : readView());
  }

  /* ---- 移动端「更多」入口 ---------------------------------------------- */

  /**
   * 窄屏 tabbar 的第四格：打开装着另外五个视图的面板。
   *
   * 面板本身就是一层浮层（`data-dialog="tabbar-more"`），Esc / 点外 / 焦点归还由
   * `App.widgets.dialog` 管；这里只负责开合投影与 `aria-expanded`。选路径的锚点
   * 是整页导航，不需要在这里收尾；选「聊天」的那颗按钮走 `show-chat`，视图切完
   * 之后要把面板收起来（否则它盖在刚切到的视图上）。
   */
  function toggleTabbarMore() {
    if (App.widgets.dialog.isOpen("tabbar-more")) {
      App.widgets.dialog.close("tabbar-more");
      syncTabbarMore(false);
      return;
    }
    App.widgets.dialog.open("tabbar-more", {
      fallback: function () {
        return byRole("tabbar-more");
      },
      /* Esc / 遮罩关掉这一层时也把触发键的展开态收回去（`close` 那一路由
         `closeTabbarMore` 自己同步）。 */
      onDismiss: function () {
        syncTabbarMore(false);
      },
    });
    syncTabbarMore(true);
  }

  /** 面板里点了某一项：收面板（不还焦点：视图已经换了，视线跟着走）。*/
  function closeTabbarMore() {
    if (!App.widgets.dialog.isOpen("tabbar-more")) return;
    App.widgets.dialog.close("tabbar-more");
    syncTabbarMore(false);
  }

  /** 触发键的 `aria-expanded` 是开合状态的投影。*/
  function syncTabbarMore(open) {
    var trigger = byRole("tabbar-more");
    if (trigger) trigger.setAttribute("aria-expanded", open ? "true" : "false");
  }


  /**
   * 主题图标按钮与语言下拉的绑定（放在顶栏右侧而不是设置页的「外观」组）。
   *
   * 主题是图标按钮（不是三选下拉），点击在「跟随系统 → 浅色 → 深色」之间
   * 循环——三态的名字与图标由 `App.theme.sync` 写（它也会被 applyTheme 与语言
   * 切换调到）。语言仍是下拉：两个偏好里只有主题是「循环切换」的语义。
   * 绑定按 data-role 找，页面上有几只就绑几只；`App.theme.set` 与
   * `App.i18n.setLanguage` 的逻辑没动。
   */
  function bindPrefsControls() {
    var themeButtons = document.querySelectorAll('[data-role="theme-button"]');
    for (var i = 0; i < themeButtons.length; i++) {
      (function (button) {
        button.addEventListener("click", function () {
          var modes = C.THEME_MODES;
          var next = (modes.indexOf(App.theme.read()) + 1) % modes.length;
          App.theme.set(modes[next]);
        });
      })(themeButtons[i]);
    }

    var langSelects = document.querySelectorAll('[data-role="lang-select"]');
    for (var j = 0; j < langSelects.length; j++) {
      (function (select) {
        select.addEventListener("change", function () {
          App.i18n.setLanguage(select.value);
        });
      })(langSelects[j]);
    }
  }

  /* ---- 事件绑定 -------------------------------------------------------- */

  function bindEvents() {
    bindPrefsControls();
    bindPageActions();
    bindTabbarMore();
    /* 侧边栏折叠：顶栏左上角那一颗。绑定放在这里（而不是在 app-sidebar.js
       里自动跑）：初始化顺序只有 `app.js` 知道。 */
    App.sidebar.bind();
    /* 顶栏刷新：按钮点击 + `R` 快捷键。绑定放在这里（而不是在 app-refresh
       自己的文件里自动跑）：初始化顺序只有 `app.js` 知道。 */
    App.refresh.bind();
  }

  /** 窄屏「更多」：触发按钮与面板里的每一项。*/
  function bindTabbarMore() {
    var trigger = byRole("tabbar-more");
    if (trigger) trigger.addEventListener("click", toggleTabbarMore);
    /* 「更多」面板里的聊天项是视图切换（`show-chat`），其余是整页导航的锚点：
     * 两者点完都不该让面板继续盖着。`show-chat` 的处理器在 `bindPageActions` 里
     * 也调一次 `closeTabbarMore`（那里才是「什么都切完了」的时点），这里只补锚点
     * 那一路——HTML 的点击在导航之前同步跑，收面板不会挡住跳转。 */
    var panel = document.querySelector('[data-dialog="tabbar-more"]');
    if (!panel) return;
    panel.addEventListener("click", function (event) {
      var item = event.target && event.target.closest ? event.target.closest("a[data-tabbar-more]") : null;
      if (item) closeTabbarMore();
    });
  }

  /**
   * `data-action` 的绑定表。
   *
   * 一个按钮一条命令，动作名写在 `page.html` 里。分派放在这里是为了让「页面上有
   * 哪些按钮」和「每个按钮做什么」只有一处对应关系。
   */
  function bindPageActions() {
    var actions = document.querySelectorAll("[data-action]");
    for (var i = 0; i < actions.length; i++) {
      var node = actions[i];
      var action = node.getAttribute("data-action");
      if (action === "open-add") node.addEventListener("click", App.views.add.openFrom);
      else if (action === "close-add") node.addEventListener("click", App.views.add.close);
      else if (action === "submit-add") node.addEventListener("click", App.views.add.submit);
      /* 登录 tab：复制授权链接 / 在新标签页打开它 / 重发一次流程 */
      else if (action === "login-copy") node.addEventListener("click", App.views.add.copyLink);
      else if (action === "login-open") node.addEventListener("click", App.views.add.openLoginUrl);
      else if (action === "login-retry") node.addEventListener("click", App.views.add.retryLogin);
      else if (action === "dismiss-accounts-error") node.addEventListener("click", function () { App.api.showActionError(null); });
      else if (action === "dismiss-routing-error") node.addEventListener("click", function () { App.api.showActionError(null); });
      else if (action === "submit-delete") node.addEventListener("click", App.views.accounts.submitDelete);
      else if (action === "close-delete") node.addEventListener("click", App.views.accounts.closeDelete);
      else if (action === "toggle-pause") node.addEventListener("click", App.views.logs.togglePaused);
      else if (action === "clear-logs") node.addEventListener("click", App.views.logs.clear);
      /* 导出当前筛选结果：请求事件 tab 的工具栏。绑定不看可见性——在系统 tab
         下它藏在 `[hidden]` 里，点不到。 */
      else if (action === "export-requests") node.addEventListener("click", App.views.logs.exportRequests);
      /* API key 页：创建 / 复制 / 关闭 / 关闭错误横幅 */
      else if (Object.prototype.hasOwnProperty.call(App.views.keys.actions, action)) {
        node.addEventListener("click", App.views.keys.actions[action]);
      }
      /* 代理抽屉：新建 / 编辑 / 关闭 / 关闭错误横幅。抽屉自己挂在账号页上，
         但它管的是同一份字典表，动作表与之前同一形状。 */
      else if (Object.prototype.hasOwnProperty.call(App.proxies.actions, action)) {
        node.addEventListener("click", App.proxies.actions[action]);
      }
      else if (action === "dismiss-settings-error") node.addEventListener("click", function () { App.views.settings.showError(null); });
      /* 账号页的导入 / 导出与两个登录按钮（从设置页搬过来的）*/
      else if (Object.prototype.hasOwnProperty.call(App.views.accounts.actions, action)) {
        node.addEventListener("click", App.views.accounts.actions[action]);
      }
      else if (action === "close-confirm") node.addEventListener("click", App.confirm.cancel);
      else if (action === "submit-confirm") node.addEventListener("click", App.confirm.submit);
      /* 聊天视图切换：侧边栏项一个入口（顶栏按钮已撤，同一个动作
         不需要两个按钮）。 */
      else if (action === "show-chat") node.addEventListener("click", function () {
        switchToChat();
        /* 「更多」面板里的聊天项：视图切完把面板收起，否则它盖在刚切到的视图上。 */
        closeTabbarMore();
      });
      /* 顶栏层级的命令（设置页的「退出进程」）。 */
      else if (Object.prototype.hasOwnProperty.call(App.shell.actions, action)) {
        node.addEventListener("click", App.shell.actions[action]);
      }
      /* 「我的账户」页：退出登录 / 改密码 / 检查更新 */
      else if (Object.prototype.hasOwnProperty.call(App.views.account.actions, action)) {
        node.addEventListener("click", App.views.account.actions[action]);
      }
      /* 设置页剩下的那个动作：从系统同步客户端版本 */
      else if (Object.prototype.hasOwnProperty.call(App.views.settings.actions, action)) {
        node.addEventListener("click", App.views.settings.actions[action]);
      }
    }

    /* tab 条在模态里：选择器的范围要跟着收窄。账号页空状态的两个按钮也带
       `data-add-tab`（它们只是“打开模态并落在哪个 tab”），把它们的点击也绑到
       `selectTab` 会让一次点击跑两遍流程（登录 tab 于是发两条 `startOAuth`，
       后一条把前一条顶掉）。*/
    var addModal = byRole("add-modal");
    var tabs = addModal ? addModal.querySelectorAll("[data-add-tab]") : [];
    for (var k = 0; k < tabs.length; k++) {
      tabs[k].addEventListener("click", function (event) {
        App.views.add.selectTab(event.currentTarget.getAttribute("data-add-tab"));
      });
    }

    /* 日志页的两个 tab：与添加账号的 tab 同一套模式，动作就是 tab 的键。
       切完 tab 要同步顶栏刷新：请求事件 tab 能拉、系统 tab 由 SSE 推、置灰。*/
    var logTabs = document.querySelectorAll("[data-log-tab]");
    for (var m = 0; m < logTabs.length; m++) {
      logTabs[m].addEventListener("click", function (event) {
        App.views.logs.selectTab(event.currentTarget.getAttribute("data-log-tab"));
        App.refresh.sync();
      });
    }

    App.views.overview.bindControls();
    App.views.stats.bindControls();
    App.views.accounts.bindControls();
    App.views.routing.bindControls();
    App.views.account.bindControls();
    App.views.keys.bindControls();
    App.proxies.bindControls();
    App.views.add.bindForm();
    App.views.logs.bindFilters();
    App.views.settings.bindControls();

    /* 折叠区（CollapsibleSection）：首屏静态 DOM 也要回放持久化的开合
       状态。视图重渲染后各自再调 `App.widgets.apply()`，这里只负责首屏。 */
    App.widgets.apply(document);

    /* 勾掉「强制中断」就把二次确认退回一步：不勾 force 的删除一次点击即 drain。*/
    var deleteForce = byRole("delete-force");
    if (deleteForce) {
      deleteForce.addEventListener("change", function () {
        App.views.accounts.armDelete(false);
      });
    }
  }

  /* ---- 状态分发 -------------------------------------------------------- */

  /**
   * 静态选项与账号下拉的初始化。
   *
   * 语言切换也要重跑一次：下拉的选项文案是运行时拼的，不重建就会停在旧语言。
   */
  function initSelectOptions() {
    App.forms.initSelects();
    /* 账号下拉的「全部」文案随语言变，强制重建一次（枚举重建会丢掉当前选择，
       `syncAccounts` 会把选择按 label 恢复）*/
    App.views.logs.resetAccounts(state.lastState ? state.lastState.accounts : []);
    /* 状态下拉刚被重建，选中态回到了第一项：外部带来的 `?status=` 在这一拍
       钉回去（阶段下拉下次 `renderRequests` 时会自己钉）。*/
    App.views.logs.syncExternalFilters();
  }

  /** 一份状态载荷分发给所有视图（`/api/state` 与 `state` 事件共用这一条路）。*/
  function renderState(next) {
    if (!next) return;
    App.views.overview.render(next);
    App.views.settings.adoptClaimOverview(next.claim);
    App.views.accounts.render(next.accounts);
    App.views.routing.render(next.routing, next.stickiness, next.risk.policy, next.accounts);
    /* 账号下拉的选项来自 `state.accounts`（账号页增删后这里立刻跟上）*/
    App.views.logs.syncAccounts(next.accounts);
    /* 聊天视图的账号下拉同理：选择快照里的账号被删 / 禁用后要跟美地回落。 */
    App.views.chat.syncAccounts(next.accounts);
  }

  /* ---- 启动 ------------------------------------------------------------ */

  /**
   * 给面板补 `viewport-fit=cover`。
   *
   * `page.html` 的 `<meta name="viewport">` 归另一条线（页面骨架），这里在运行时
   * 把开关补上：没有它，`env(safe-area-inset-*)` 恒为 0，`.tabbar` 的安全区留白
   * 就永远读不到——两者是成对的。已经写着的不重复补（幂等），登录页走自己的
   * 模板，这段只服务面板。
   */
  function ensureViewportFit() {
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    var content = meta.getAttribute("content") || "";
    if (content.indexOf("viewport-fit=") >= 0) return;
    meta.setAttribute("content", content + ", viewport-fit=cover");
  }

  function init() {
    ensureViewportFit();
    App.i18n.load();
    applyView();
    App.i18n.applyLanguage(App.i18n.readLanguage());
    /* 内联防闪烁脚本已经在首帧前写过 `data-theme`；这里再跑一次是为了
       「没有内联脚本」时也能落到正确主题（只是会闪一下，功能不丢）*/
    App.theme.apply(App.theme.read());
    /* 侧边栏折叠同理：`theme-boot.js` 已在首屏前落过一次，这一拍负责
       「内联脚本没跑」的降级路径，并把按钮 / tooltip 的文案写上去。 */
    App.sidebar.apply(App.sidebar.read());
    bindEvents();
    /* 聊天视图的历史整合：回退/前进在视图之间移动（见 switchToChat）。 */
    window.addEventListener("popstate", onPopState);
    /* 会话在服务端：页面不持有任何凭据，只读一次当前登录的人。 */
    App.api.loadSession().then(function () {
      App.views.account.render();
      return null;
    });
    App.api.refresh();
    App.shell.load();
    /* 代理表（命名出口字典）不在 `/api/state` 里：账号页的代理列、批量条的下拉与
       概览的共用出口分组都读它，进任何一页都可能用到，所以启动时取一次。
       它挂在账号页的抽屉里，抽屉打开时由抽屉自己再取一次新表。 */
    App.proxies.load();
    window.setInterval(App.api.refresh, C.POLL_INTERVAL_MS);
  }

  /* 给测试与外部调用方用的最小接口：切换与刷新都要能外部驱动 */
  window.zcodePanel = {
    refresh: App.api.refresh,
    /* 顶栏刷新：与点那颗图标按钮同一条路（按当前视图派发），
       实机验证与测试都用它驱动，不用去伪造一次点击。 */
    refreshView: function () {
      return App.refresh.run();
    },
    setLanguage: App.i18n.setLanguage,
    setTheme: App.theme.set,
    t: t,
    view: function () {
      return state.activeView;
    },
  };

  App.initSelectOptions = initSelectOptions;
  App.renderState = renderState;

  init();
})(window.__zcodeApp = window.__zcodeApp || {});
