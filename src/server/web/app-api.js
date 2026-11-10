/*
 * app-api.js — 请求层：`fetch` 封装、会话失效处理、控制命令与设置补丁的发送。
 *
 * 页面所有写入都走这里，服务端是唯一真值：命令成功之后立刻重读 `/api/state`，不做
 * 本地乐观更新（并发 / 权重都是热调，回读一次最省心）。
 *
 * 三种失败各有各的出口，收在本文件里是为了让「哪类失败挂在哪个横幅上」只有一个
 * 定义：
 *
 *   401                整页跳转到 `/login`（`goToLogin`），不重试
 *   `/api/state` 非 200 状态条（`showStateError`），码原样露出
 *   命令失败           账号页 / 路由策略页的横幅（`showActionError`）、设置页横幅、
 *                      添加账号模态里的错误行，按 `dispatch` 的 `target` 分流
 *
 * 会话过期走整页跳转而不是在页面里弹一个输入框：控制面现在只有用户名 + 密码这一种
 * 登录方式，页面上没有任何地方能收它。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var state = App.state;
  var byId = App.dom.byId;
  var byRole = App.dom.byRole;
  var setText = App.dom.setText;
  var setHidden = App.dom.setHidden;
  var t = App.i18n.t;
  var errorText = App.i18n.errorText;

  /* ---- 会话与状态横幅 -------------------------------------------------- */

  /**
   * 会话失效：整页跳回登录页。
   *
   * `replace` 而不是 `assign`：失效的页面不该留在历史里，否则用户按一次后退又回到
   * 一个所有字段都是「—」的页面。
   */
  function goToLogin() {
    window.location.replace(C.LOGIN_PATH);
  }

  /** 读当前登录的人（设置页显示用）。401 说明会话已经没了。*/
  function loadSession() {
    return window
      .fetch(C.SESSION_PATH, { credentials: "same-origin" })
      .then(function (response) {
        if (response.status === C.HTTP_UNAUTHORIZED) {
          goToLogin();
          return null;
        }
        return response.json();
      })
      .then(function (body) {
        if (body && body.username) state.username = body.username;
        return body;
      })
      .catch(function () {
        return null;
      });
  }

  function showStateError(code) {
    var banner = byId("state-banner");
    var node = byRole("state-error");
    if (!banner || !node) return;
    if (code === null) {
      setHidden(banner, true);
      node.textContent = "";
      return;
    }
    node.textContent = t("state.error", { error: code });
    setHidden(banner, false);
  }

  /**
   * 变更类错误的出口。
   *
   * 账号页与路由策略页各有自己的横幅，同一时刻只显示一条：挂哪一条由当前视图决定，
   * 所以这个函数读 `activeView`，调用方不用传。
   */
  function showActionError(text) {
    var isRouting = state.activeView === C.VIEW_ROUTING;
    var banner = byRole(isRouting ? "routing-error" : "accounts-error");
    if (!banner) return;
    setHidden(banner, text === null);
    setText(isRouting ? "routing-error-text" : "accounts-error-text", text === null ? "" : text);
  }

  function showNotice(text) {
    var banner = byRole("accounts-notice");
    if (!banner) return;
    setHidden(banner, text === null);
    setText("accounts-notice-text", text === null ? "" : text);
  }

  /* ---- 状态读取 -------------------------------------------------------- */

  function refresh() {
    return window
      .fetch(C.STATE_PATH, { credentials: "same-origin" })
      .then(function (response) {
        if (response.status === C.HTTP_UNAUTHORIZED) {
          goToLogin();
          return null;
        }
        if (!response.ok) {
          return response
            .json()
            .then(function (body) {
              showStateError(body && body.error ? body.error : String(response.status));
              return null;
            })
            .catch(function () {
              showStateError(String(response.status));
              return null;
            });
        }
        return response.json();
      })
      .then(function (next) {
        if (!next) return;
        showStateError(null);
        state.lastState = next;
        App.renderState(next);
      })
      .catch(function () {
        showStateError(C.NETWORK_ERROR_CODE);
      });
  }

  /* ---- 控制命令 -------------------------------------------------------- */

  /**
   * 发一条控制命令，回它的应答（`null` 表示网络或令牌失败）。
   *
   * 与 `dispatch` 的区别：这里不自动刷新。调用方按自己的先后关系发多条命令
   * （例如登录之后还要重读 `/api/system`），中间插一次刷新既没必要也会打乱顺序。
   */
  function sendControl(cmd) {
    return window
      .fetch(C.CONTROL_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(cmd),
      })
      .then(function (response) {
        if (response.status === C.HTTP_UNAUTHORIZED) {
          goToLogin();
          return null;
        }
        return response.json();
      })
      .catch(function () {
        return null;
      });
  }

  /** 控制应答到错误文案；成功回 `null`（`ok:false` 的码要翻译）。*/
  function commandFailure(body) {
    if (!body) return t("error." + C.NETWORK_ERROR_CODE);
    if (body.ok) return null;
    return errorText(body.error ? body.error : C.NETWORK_ERROR_CODE);
  }

  /**
   * 发一条控制命令并在成功后刷新。
   *
   * 成功时先跑 `onOk`（用应答里的 `aborted` 之类提示用户），再 `refresh()`。
   * 失败时把稳定错误码翻成文案显示出来，未知码原样露出；`target` 决定
   * 提示挂在哪个横幅上。
   */
  function dispatch(cmd, onOk, target) {
    return window
      .fetch(C.CONTROL_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(cmd),
      })
      .then(function (response) {
        if (response.status === C.HTTP_UNAUTHORIZED) {
          goToLogin();
          return null;
        }
        return response.json();
      })
      .then(function (body) {
        if (!body) return null;
        if (!body.ok) {
          showTargetError(target, errorText(body.error));
          return null;
        }
        if (onOk) onOk(body);
        return refresh();
      })
      .catch(function () {
        showTargetError(target, t("error." + C.NETWORK_ERROR_CODE));
      });
  }

  /**
   * 失败出口按 `target` 分流。
   *
   * 固定档位是整块面上的横幅（添加账号模态、设置页、当前视图的页顶）；
   * `ROW_TARGET_PREFIX + label` 是**行内**出口（账号表某一格），交给表格模块
   * 自己画——页顶横幅在长表格里根本不在视野内，用户分不清「没点中」还是
   * 「被拒了」。
   */
  function showTargetError(target, text) {
    if (target === "add") App.views.add.showError(text);
    else if (target === "settings") App.views.settings.showError(text);
    else if (typeof target === "string" && target.indexOf(C.ROW_TARGET_PREFIX) === 0) {
      App.accountsTable.showRowFailure(target.slice(C.ROW_TARGET_PREFIX.length), text);
    } else showActionError(text);
  }

  /* ---- 设置页的读写 ---------------------------------------------------- */

  function loadSettings() {
    return window
      .fetch(C.SETTINGS_PATH, { credentials: "same-origin" })
      .then(function (response) {
        if (response.status === C.HTTP_UNAUTHORIZED) {
          goToLogin();
          return null;
        }
        return response.json();
      })
      .then(function (body) {
        if (!body) return;
        if (body.ok === false) {
          App.views.settings.showError(errorText(body.error));
          return;
        }
        App.views.settings.adopt(body);
      })
      .catch(function () {
        App.views.settings.showError(t("error." + C.NETWORK_ERROR_CODE));
      });
  }

  /**
   * 发一个设置补丁。
   *
   * 二次确认的判定在服务端：页面先把改动发过去，服务端认为需要确认时回
   * `confirmation_required`，页面再用模态问一次并带 `confirm: true` 重发。这样
   * 「哪些改动是 L3」只有一份定义（`routes-state.ts`），页面不会和它跑偏。
   */
  function writeSettingsPatch(patch, confirm) {
    return window
      .fetch(C.SETTINGS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ patch: patch, confirm: confirm === true }),
      })
      .then(function (response) {
        if (response.status === C.HTTP_UNAUTHORIZED) {
          goToLogin();
          return null;
        }
        return response.json();
      })
      .then(function (body) {
        if (!body) return;
        if (!body.ok) {
          if (body.error === "confirmation_required" && confirm !== true) {
            App.views.settings.confirmPatch(patch);
            return;
          }
          if (body.error === "config_invalid" && body.fileWritten) {
            /* 文件已落盘但内存没收下：不是「写失败」，页面要说的
               是「已写入但未生效」，动作是去修文件，不是重试一次。 */
            App.views.settings.showError(t("settings.writtenNotApplied"));
          } else {
            App.views.settings.showError(errorText(body.error));
          }
          App.views.settings.restore();
          return;
        }
        App.views.settings.adopt(body.settings);
        /* 热重载的结果分三种说：C 类字段要重启，A / B 类已生效
           （短暂提示），两边都空 = 没有实际变化或宿主没接热重载，只说已保存。 */
        var restartRequired = body.restartRequired || [];
        if (restartRequired.length > 0) {
          App.views.settings.showNotice(t("settings.saved.restart"));
        } else if ((body.reloaded || []).length > 0) {
          App.views.settings.flashNotice(t("settings.saved.effective"));
        } else {
          App.views.settings.showNotice(t("settings.saved"));
        }
      })
      .catch(function () {
        App.views.settings.showError(t("error." + C.NETWORK_ERROR_CODE));
      });
  }

  /* ---- 会话写操作 ------------------------------------------------------ */

  /**
   * 登出：清服务端会话与 Cookie，然后回到登录页。
   *
   * 失败也照样跳转：服务端删不掉会话时，Cookie 已经不再被这个浏览器持有，用户看到
   * 的效果仍然是「退出了」。
   */
  function logout() {
    return window
      .fetch(C.SESSION_PATH, { method: "DELETE", credentials: "same-origin" })
      .catch(function () {
        return null;
      })
      .then(function () {
        window.location.replace(C.LOGIN_PATH);
        return null;
      });
  }

  /**
   * 改密码。
   *
   * 成功之后服务端会换一条新会话并发回 Cookie（旧会话全部作废），所以这里不需要
   * 重新登录。失败时把稳定错误码翻成文案，`onError` 负责挂到设置页的横幅上。
   */
  function changePassword(currentPassword, newPassword, onError) {
    return window
      .fetch(C.PASSWORD_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ currentPassword: currentPassword, newPassword: newPassword }),
      })
      .then(function (response) {
        if (response.status === C.HTTP_UNAUTHORIZED) {
          /* 401 有两种：会话没了（跳登录页），或当前密码错（就地提示）。 */
          return response
            .json()
            .then(function (body) {
              if (body && body.error === "wrong_password") {
                onError(t("error.wrong_password"));
                return null;
              }
              goToLogin();
              return null;
            })
            .catch(function () {
              goToLogin();
              return null;
            });
        }
        return response.json().then(function (body) {
          if (!body || body.ok !== true) {
            onError(errorText(body && body.error ? body.error : C.NETWORK_ERROR_CODE));
            return null;
          }
          onError(null);
          return body;
        });
      })
      .catch(function () {
        onError(t("error." + C.NETWORK_ERROR_CODE));
      });
  }

  App.api = {
    refresh: refresh,
    loadSession: loadSession,
    logout: logout,
    changePassword: changePassword,
    sendControl: sendControl,
    commandFailure: commandFailure,
    dispatch: dispatch,
    loadSettings: loadSettings,
    writeSettingsPatch: writeSettingsPatch,
    goToLogin: goToLogin,
    showActionError: showActionError,
    showNotice: showNotice,
  };
})(window.__zcodeApp = window.__zcodeApp || {});
