/*
 * app-view-account.js — 设置页的「账户」组：当前登录的人、改密码、
 * 退出登录。
 *
 * 这三件事曾单开一页（`/account`），后来收回设置页：独立一页只为三行字，
 * 导航多一项、顶栏多一处入口，而它们改一次就不动。数据仍走已有的三个接口，没有新增后端：
 *
 *
 *   GET    /api/session   用户名（控制面会话，不是上游账号凭据）
 *   POST   /api/password  改密码（成功后服务端换一条新会话发给这个浏览器）
 *   DELETE /api/session   退出登录，然后跳 `/login`
 *
 * 密码框在页面里先过两道：两个新密码必须一致（服务端只收到一个 `newPassword`，
 * 它没法知道用户是不是打错了一遍），以及空值不发请求。真正的密码错误由服务端回
 * `wrong_password`，翻译之后落在本页的错误横幅上。
 *
 * 「检查更新」的按钮在设置页页脚的「版本」一行里，但处理逻辑仍归本模块：它和
 * 改密码共用账户组的两条横幅（`account-error` / `account-notice`），一个函数不假定
 * 自己画在哪一处。
 */
(function (App) {
  "use strict";

  var byRole = App.dom.byRole;
  var setText = App.dom.setText;
  var setHidden = App.dom.setHidden;
  var t = App.i18n.t;

  /* ---- 渲染 ------------------------------------------------------------ */

  /** 渲染用户名（会话异步到达，`state.username` 为空时先显示 `—`）。*/
  function renderAccount() {
    var input = byRole("account-username");
    /* 只读输入框与可编辑控件同一骨架（同高、同框感）；`.value` 不会像
       `textContent` 那样被 i18n 的整页重写碰掉。 */
    if (input) input.value = App.state.username || "—";
  }

  /**
   * 读一次 `GET /api/session`。
   *
   * 进设置页时重读：在别的标签页改过密码之后，这里的用户名仍是同一个人，但会话
   * 已经是新的了。401 由 `App.api.loadSession` 负责跳登录页。
   */
  function loadAccount() {
    return App.api.loadSession().then(function () {
      renderAccount();
      return null;
    });
  }

  /* ---- 横幅 ------------------------------------------------------------ */

  function showError(text) {
    var banner = byRole("account-error");
    if (!banner) return;
    setHidden(banner, text === null);
    setText("account-error-text", text === null ? "" : text);
  }

  function showNotice(text) {
    var banner = byRole("account-notice");
    if (!banner) return;
    setHidden(banner, text === null);
    setText("account-notice-text", text === null ? "" : text);
  }

  /* ---- 改密码 ---------------------------------------------------------- */

  /** 三个密码框（当前 / 新 / 确认）。*/
  function passwordFields() {
    return {
      current: byRole("account-currentPassword"),
      next: byRole("account-newPassword"),
      confirm: byRole("account-confirmPassword"),
    };
  }

  function clearPasswordFields() {
    var fields = passwordFields();
    if (fields.current) fields.current.value = "";
    if (fields.next) fields.next.value = "";
    if (fields.confirm) fields.confirm.value = "";
  }

  function submitPassword() {
    var fields = passwordFields();
    var current = fields.current ? fields.current.value : "";
    var next = fields.next ? fields.next.value : "";
    var confirm = fields.confirm ? fields.confirm.value : "";
    showNotice(null);
    if (!current || !next) {
      showError(t("account.password.required"));
      return Promise.resolve();
    }
    if (next !== confirm) {
      showError(t("account.password.mismatch"));
      return Promise.resolve();
    }
    return App.api.changePassword(current, next, function (text) {
      if (text !== null) {
        showError(text);
        return;
      }
      clearPasswordFields();
      showError(null);
      showNotice(t("account.password.changed"));
    });
  }

  /** 退出登录（控制面会话，不是上游账号凭据）。成功后跳 `/login`，见 `app-api.js`。*/
  function submitLogout() {
    return App.api.logout();
  }

  /* ---- 检查更新 -------------------------------------------------------- */

  function checkUpdate() {
    showError(null);
    showNotice(null);
    return App.shell.checkUpdate().then(function (result) {
      if (result.failure) {
        showError(result.failure);
        return null;
      }
      showNotice(result.text);
      return null;
    });
  }

  /* ---- 绑定 ------------------------------------------------------------ */

  /** 密码框回车即提交，不必每次都去够按钮。*/
  function bindControls() {
    var fields = passwordFields();
    var list = [fields.current, fields.next, fields.confirm];
    for (var i = 0; i < list.length; i++) {
      if (!list[i]) continue;
      list[i].addEventListener("keydown", function (event) {
        if (event.key !== "Enter") return;
        event.preventDefault();
        submitPassword();
      });
    }
  }

  App.views.account = {
    render: renderAccount,
    load: loadAccount,
    bindControls: bindControls,
    showError: showError,
    showNotice: showNotice,
    actions: {
      "account-logout": submitLogout,
      "account-save-password": submitPassword,
      "account-check-update": checkUpdate,
    },
  };
})(window.__zcodeApp = window.__zcodeApp || {});
