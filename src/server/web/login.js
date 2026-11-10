/*
 * login.js — 登录页的运行时。
 *
 * 范围只有三件事：把用户名与密码发出去、成功之后回到首页、失败时说一句「用户名或
 * 密码错误」。不做前端校验（密码规则在服务端）、不做记住密码（cookie 由服务端设，
 * 页面碰不到）。
 *
 * 与面板共用 `app-constants` / `app-state` / `app-dom` / `app-i18n` / `app-theme`
 * 这几块零件，所以两页的术语与配色天然一致。它不读 `/api/*`，
 * 也不订阅事件流：未登录时那些路由一律 401。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var byRole = App.dom.byRole;
  var setText = App.dom.setText;
  var setHidden = App.dom.setHidden;
  var t = App.i18n.t;

  /** 在飞标志：登录按钮按一次就够，重复提交只会多一条 401。*/
  var busy = false;

  function showError(text) {
    /* `hidden` 挂在横幅上，外层 `data-role="login-error"` 是常驻的 live region：
       它一消失，读屏软件就收不到这次变化了（live region 要常驻）。*/
    var banner = byRole("login-error-banner");
    if (banner) setHidden(banner, text === null);
    setText("login-error-text", text === null ? "" : text);
  }

  function setBusy(next) {
    busy = next;
    var submit = byRole("login-submit");
    if (submit) submit.disabled = next;
  }

  function usernameNode() {
    return byRole("login-username");
  }

  function passwordNode() {
    return byRole("login-password");
  }

  /**
   * 提交登录。
   *
   * 401 与网络错误分开说：前者是「用户名或密码错误」，后者是「连不上代理」，
   * 用户要做的事完全不同（重新输入 vs 检查代理是否在跑）。
   */
  function submit() {
    if (busy) return;
    var username = usernameNode() ? usernameNode().value.trim() : "";
    var password = passwordNode() ? passwordNode().value : "";
    if (!username || !password) {
      showError(t("login.error.empty"));
      return;
    }
    showError(null);
    setBusy(true);

    window
      .fetch(C.SESSION_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ username: username, password: password }),
      })
      .then(function (response) {
        if (response.status === C.HTTP_UNAUTHORIZED) {
          showError(t("login.error.invalid"));
          return null;
        }
        if (!response.ok) {
          showError(t("error.network_error"));
          return null;
        }
        /* 换页面而不是 push：登录页不该留在历史里，后退一次又回到它 */
        window.location.replace(C.HOME_PATH);
        return null;
      })
      .catch(function () {
        showError(t("error.network_error"));
      })
      .then(function () {
        setBusy(false);
      });
  }

  function init() {
    App.i18n.load();
    App.i18n.applyLanguage(App.i18n.readLanguage());
    /* 内联防闪烁脚本已经在首帧前写过 `data-theme`；这里再跑一次是为了「没有内联
       脚本」时也能落到正确主题（只是会闪一下，功能不丢）*/
    App.theme.apply(App.theme.read());

    var form = byRole("login-form");
    if (form) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        submit();
      });
    }
    /* 语言切换：这一页没有 `app.js`（它是面板的入口），所以自己绑一次。
       值立刻写进 localStorage，下一次进面板就是同一套语言。*/
    var lang = document.getElementById("prefs-lang");
    if (lang) {
      lang.addEventListener("change", function () {
        App.i18n.setLanguage(lang.value);
      });
    }
    /* 焦点落密码框：用户名已经预填了 `admin`（login.html 的 value），
       登录的人要敲的就是密码。用户名框仍然可改：改过之后凭据照旧发出去，
       服务端认不认是它的事。 */
    var password = passwordNode();
    if (password) password.focus();
  }

  init();
})(window.__zcodeApp = window.__zcodeApp || {});
