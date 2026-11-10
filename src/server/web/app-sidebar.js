/*
 * app-sidebar.js — 侧边栏折叠。
 *
 * 一件事：把「展开 232px / 折叠 56px」这个二态写成 `<html data-sidebar>`，并持久化。
 * 视觉全在 `components.css` 的折叠块里，这一层只管三样东西：
 *
 *   1. 状态投影：`<html data-sidebar="collapsed|expanded">`（`SIDEBAR_ATTR`）。
 *      首屏那一拍不是这里写的——`theme-boot.js` 在样式表之前就把 localStorage 里
 *      的值写上去了（理由与主题同一条：不写就会先画一帧展开态，再横跳 176px）。
 *      这里在 `init()` 里再跑一次，是给「内联脚本没跑」的降级路径收尾。
 *
 *   2. 折叠态的 tooltip：文字标签被 CSS 收起，剩下八个图标，悬停要知道自己是谁。
 *      用原生 `title` 而不是自绘气泡：侧边栏是 `overflow-y: auto` 的滚动容器，
 *      另一轴会被裁（CSS 规范），自绘气泡必然被栏边切掉。
 *
 *   3. 顶栏那颗按钮的两态：图标（panel-left-close / panel-left-open）、
 *      `title` / `aria-label`（「折叠侧边栏」/「展开侧边栏」）与 `aria-expanded`。
 *      文案随语言变，所以 `App.i18n.applyLanguage` 会回头调 `sync()`。
 *
 * 为什么状态挂在 `<html>` 而不是按钮或侧边栏上：能改的不止一处（按钮、将来的
 * 快捷键、窄屏的降级），而 CSS 需要一个「全局唯一真值」的选择器根。挂在
 * documentElement 上手写起来是 `html[data-sidebar="collapsed"] .sidebar`，
 * 与主题的 `html[data-theme="dark"]` 同一套写法。
 *
 * 窄屏（≤720px）侧边栏整体退场、换成底部 tabbar，按钮在 CSS 里一起隐藏；
 * 状态照旧存着，回到宽屏时还是用户上次选的那一档。
 */
(function (App) {
  "use strict";

  var C = App.const;

  /** 折叠态的取值（`SIDEBAR_MODES` 的两项，localStorage 里存的字面量）。*/
  function readSidebar() {
    var stored = App.store.read(C.SIDEBAR_STORAGE_KEY);
    return C.SIDEBAR_MODES.indexOf(stored) >= 0 ? stored : C.SIDEBAR_EXPANDED;
  }

  /** 当前投影出来的那一档（读 DOM，不读 localStorage：以画面为准）。*/
  function isCollapsed() {
    return document.documentElement.getAttribute(C.SIDEBAR_ATTR) === C.SIDEBAR_COLLAPSED;
  }

  /**
   * 同步导航项的 `title`：只有折叠态写。
   *
   * 展开态标签就在图标右边，再挂一个一模一样的 tooltip 是纯噪声；折叠态它是
   * 唯一的说明。文字取自导航项里的 `<span data-i18n>`（i18n 改的也是那一处），
   * 所以语言切换之后要重跑一次（`sync()`）。
   */
  function syncNavTitles() {
    var collapsed = isCollapsed();
    var navs = document.querySelectorAll(".sidebar [data-nav]");
    for (var i = 0; i < navs.length; i++) {
      var label = navs[i].querySelector("span");
      var text = label && label.textContent ? label.textContent.replace(/\s+/g, " ").trim() : "";
      if (collapsed && text) navs[i].setAttribute("title", text);
      else navs[i].removeAttribute("title");
    }
  }

  /**
   * 同步顶栏折叠按钮（图标 / 提示 / `aria-expanded`）。
   *
   * 文案走 `lookup` 而不是 `t`：字典缺失时回 `undefined`，按钮保留 HTML 里的
   * 兑底 aria-label（「折叠侧边栏」），而不是把键名露出来——与主题按钮同一纪律。
   */
  function syncToggle() {
    var collapsed = isCollapsed();
    var label = App.i18n.lookup(collapsed ? "sidebar.expand" : "sidebar.collapse");
    var buttons = document.querySelectorAll('[data-role="sidebar-toggle"]');
    for (var i = 0; i < buttons.length; i++) {
      var use = buttons[i].querySelector('[data-role="sidebar-icon"]');
      if (use) {
        use.setAttribute("href", collapsed ? "#icon-panel-left-open" : "#icon-panel-left-close");
      }
      buttons[i].setAttribute("aria-expanded", collapsed ? "false" : "true");
      if (label !== undefined) {
        buttons[i].setAttribute("title", label);
        buttons[i].setAttribute("aria-label", label);
      }
    }
  }

  /** 写投影（不碰存储）：`init()` 用它把持久化的一档落到第一屏。*/
  function applySidebar(mode) {
    document.documentElement.setAttribute(
      C.SIDEBAR_ATTR,
      mode === C.SIDEBAR_COLLAPSED ? C.SIDEBAR_COLLAPSED : C.SIDEBAR_EXPANDED,
    );
    syncToggle();
    syncNavTitles();
  }

  /** 用户动作：写存储再写投影。*/
  function setSidebar(mode) {
    var next = mode === C.SIDEBAR_COLLAPSED ? C.SIDEBAR_COLLAPSED : C.SIDEBAR_EXPANDED;
    App.store.write(C.SIDEBAR_STORAGE_KEY, next);
    applySidebar(next);
  }

  function toggleSidebar() {
    setSidebar(isCollapsed() ? C.SIDEBAR_EXPANDED : C.SIDEBAR_COLLAPSED);
  }

  /** 绑定顶栏按钮（按 data-role 找，页面上有几只就绑几只）。*/
  function bindToggle() {
    var buttons = document.querySelectorAll('[data-role="sidebar-toggle"]');
    for (var i = 0; i < buttons.length; i++) buttons[i].addEventListener("click", toggleSidebar);
  }

  /** 语言切换后重写提示与 tooltip（`applyI18n` 先跑，静态兑底已被它写过一遍）。*/
  function syncSidebar() {
    syncToggle();
    syncNavTitles();
  }

  App.sidebar = {
    read: readSidebar,
    apply: applySidebar,
    bind: bindToggle,
    sync: syncSidebar,
  };
})(window.__zcodeApp = window.__zcodeApp || {});
