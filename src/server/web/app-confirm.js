/*
 * app-confirm.js — 二次确认模态。
 *
 * 一个通用对话框：标题、正文、可选警示句、可选输入框（明文导出要求手输 EXPORT）。
 * 顶栏（退出进程）、设置页（绑定地址、代理鉴权）与账号页（明文导出）都用它，
 * 所以它不认识「哪一类操作」，只认调用方给的 `options`。
 *
 * 开合、Esc、遮罩与焦点归还都交给 `App.widgets.dialog`（`data-dialog="confirm"`）：
 * 这一层的取消路径是 `onCancel` 回滚，所以 Esc 与「取消」键必须走同一条路——
 * 只翻 `hidden` 会让调用方的控件停在服务端并不认可的值上。
 *
 * 哪些改动算 L3 由服务端定义（`routes-state.ts`）：页面先发一次，服务端回
 * `confirmation_required` 时才走到这里，页面不会和它跑偏。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var byRole = App.dom.byRole;
  var setText = App.dom.setText;
  var t = App.i18n.t;

  var DIALOG_ID = "confirm";

  /** 待确认的动作（模态里的「确认」会跑它）。*/
  var confirmAction = null;

  /**
   * 待重输的确认词由调用方给（`options.token`），默认回明文导出那一套（EXPORT）。
   *
   * 这个模态一度只服务明文导出，词写死在 `submitConfirm` 里。批量删除也要
   * 一个手输确认词，所以词与被拒文案改成调用方给：两处共用同一个护栏，但谁都
   * 不该把对方的文案借走。
   */
  function openConfirm(options) {
    confirmAction = options;
    setText("confirm-title", options.title);
    setText("confirm-text", options.text);

    var warn = byRole("confirm-warn");
    if (warn) {
      warn.textContent = options.warn || "";
      App.dom.setHidden(warn, !options.warn);
    }

    var row = byRole("confirm-input-row");
    App.dom.setHidden(row, !options.requiresToken);
    var input = byRole("confirm-input");
    if (input) input.value = "";
    var tokenLabel = byRole("confirm-token-label");
    if (tokenLabel) tokenLabel.textContent = options.tokenLabel || t("settings.export.confirmToken");

    var submit = byRole("confirm-submit");
    if (submit) submit.className = options.danger ? "btn btn--confirm-danger" : "btn btn--primary";

    App.widgets.dialog.open(DIALOG_ID, { onDismiss: cancelConfirm });
  }

  /**
   * 关掉模态，不带回调。
   *
   * 「确认」路径走这里：动作马上要执行，调用方不需要「撤销界面」。
   */
  function closeConfirm() {
    confirmAction = null;
    App.widgets.dialog.close(DIALOG_ID);
  }

  /**
   * 取消：关掉模态并通知调用方把控件恢复成服务端的值。
   *
   * 为什么需要这一步：页面把控件改成了用户想改的新值才发出请求，服务端回
   * `confirmation_required` 时那次改动**并没有落盘**。取消之后控件必须回到快照值，
   * 否则开关停在新位置，而配置文件里还是旧值（「看起来关了，其实没关」）。
   *
   * Esc / 遮罩 / 关闭键都由 dialog 层转到这里（`open` 的 `onDismiss`），所以
   * 它们与「取消」键是同一条路。
   */
  function cancelConfirm() {
    var action = confirmAction;
    /* 先清状态再关：关闭时 dialog 层跑的是同一个 `onDismiss`，不清就会递归一次。 */
    confirmAction = null;
    App.widgets.dialog.close(DIALOG_ID);
    if (action && action.onCancel) action.onCancel();
  }

  function submitConfirm() {
    var action = confirmAction;
    if (!action) return;

    if (action.requiresToken) {
      var input = byRole("confirm-input");
      var typed = input ? input.value.trim() : "";
      if (typed !== (action.token || C.PLAINTEXT_EXPORT_TOKEN)) {
        /* 输错的那个词留在弹框里，提示挂在当前页的动作横幅上（导出 / 批量删除都在
           账号页，所以出口是同一个）。 */
        App.api.showActionError(action.tokenError || t("settings.export.tokenMismatch"));
        return;
      }
    }
    closeConfirm();
    action.run();
  }

  App.confirm = { open: openConfirm, close: closeConfirm, cancel: cancelConfirm, submit: submitConfirm };
})(window.__zcodeApp = window.__zcodeApp || {});
