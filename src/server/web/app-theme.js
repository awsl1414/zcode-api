/*
 * app-theme.js — 主题三态：`system` / `light` / `dark`。
 *
 * `system` 模式下不写 `data-theme` 属性，由 tokens.css 的
 * `@media (prefers-color-scheme: dark)` 接手。这是结构性的取舍：系统主题变化时浏览器
 * 自己重算，页面不需要监听 `matchMedia`（跟随系统就是实时的）。`light` / `dark` 时
 * 才写死属性去覆盖媒体查询。
 *
 * 优先级：localStorage > prefers-color-scheme > light。
 *
 * 顶栏的主题控件是图标按钮（Lucide sun / moon / monitor，
 * 点击在「跟随系统 → 浅色 → 深色」之间循环）。按钮一次只画当前态的那颗图标、
 * title 提示当前态，两件事都由 syncThemeButton 写——`applyTheme`（含首次进入
 * 页面）与语言切换（app-i18n 的 applyLanguage 调 `App.theme.sync`）都会走到它。
 */
(function (App) {
  "use strict";

  var C = App.const;

  function readThemeMode() {
    var stored = App.store.read(C.THEME_STORAGE_KEY);
    return C.THEME_MODES.indexOf(stored) >= 0 ? stored : C.DEFAULT_THEME_MODE;
  }

  /**
   * 同步顶栏的主题按钮：图标指到当前态的那颗精灵 symbol，title /
   * aria-label 写成「主题 · 当前态」。
   *
   * 文案走 `lookup` 而不是 `t`：字典缺失时回 `undefined`，按钮保持 HTML 里的
   * 兑底 aria-label（data-i18n-attr 的「主题」），而不是把键名露出来。
   * 绑定按 data-role 找，页面上有几只就同步几只（与旧的下拉同步同一纪律）。
   */
  function syncThemeButton() {
    if (!App.i18n || !App.i18n.lookup) return;
    var mode = readThemeMode();
    var base = App.i18n.lookup("prefs.theme");
    var label = App.i18n.lookup("prefs.theme.mode." + mode);
    var icon = C.THEME_ICONS[mode] || "monitor";
    var buttons = document.querySelectorAll('[data-role="theme-button"]');
    for (var i = 0; i < buttons.length; i++) {
      var use = buttons[i].querySelector('[data-role="theme-icon"]') || buttons[i].querySelector("use");
      if (use) use.setAttribute("href", "#icon-" + icon);
      if (base !== undefined && label !== undefined) {
        var text = base + " · " + label;
        buttons[i].setAttribute("title", text);
        buttons[i].setAttribute("aria-label", text);
      }
    }
  }

  function applyTheme(mode) {
    var root = document.documentElement;
    if (mode === "system") root.removeAttribute(C.THEME_ATTR);
    else root.setAttribute(C.THEME_ATTR, mode);
    syncThemeButton();
  }

  function setThemeMode(mode) {
    var next = C.THEME_MODES.indexOf(mode) >= 0 ? mode : C.DEFAULT_THEME_MODE;
    App.store.write(C.THEME_STORAGE_KEY, next);
    applyTheme(next);
  }

  App.theme = { read: readThemeMode, apply: applyTheme, set: setThemeMode, sync: syncThemeButton };
})(window.__zcodeApp = window.__zcodeApp || {});
