/*
 * app-shell.js — 顶栏与全局命令。
 *
 * 顶栏只剩品牌与本机偏好（主题 / 语言），运行状态在侧边栏底部、
 * 聊天入口在侧边栏；这一层负责的与状态行相关的是：
 *
 *   1. 读一次 `/api/system`：版本（设置页「服务」组的那一行）与 panelAddress
 *      （侧边栏状态区的地址回退值，见 app-view-overview.js 的 renderServer）；
 *   2. 动作结果行 `data-role="appbar-note"`：调用方给一句话，这里负责显示与收起；
 *   3. 三条被别的页调用的命令：退出进程（设置页）、登录（账号页）、检查更新
 *      （设置页的账户组）。一个函数不假定自己出现在哪一页。
 *
 * 面板不放启停代理的按钮：面板挂在代理的监听上，停掉代理就把自己也停掉，
 * 而同一个进程里没有通路把代理再拉起来。服务的生死归进程外的东西管——Ctrl+C、
 * `docker stop`、systemd。
 *
 * 退出进程是 L3 危险动作，先过确认模态。成功后不跳转：进程已经没了，跳过去也是
 * 死链，所以页面留在原地，用顶栏那一行说明可以关掉这个标签页了。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var byRole = App.dom.byRole;
  var setHidden = App.dom.setHidden;
  var t = App.i18n.t;

  /* ---- 顶栏结果行 ------------------------------------------------------ */

  /** 顶栏的一句话（动作结果）。`null` 收起。*/
  function showNote(text) {
    var note = byRole("appbar-note");
    if (!note) return;
    setHidden(note, text === null);
    note.textContent = text === null ? "" : text;
  }

  /* ---- 系统信息与版本行 ------------------------------------------------ */

  /** 读一次 `/api/system`：版本（设置页「服务」组的那一行）。*/
  function loadSystemInfo() {
    return window
      .fetch(C.SYSTEM_PATH, { credentials: "same-origin" })
      .then(function (response) {
        if (response.status === C.HTTP_UNAUTHORIZED) {
          App.api.goToLogin();
          return null;
        }
        return response.json();
      })
      .then(function (body) {
        if (!body) return null;
        syncAboutVersion(body.version);
        /* panelAddress 是侧边栏状态区的**回退**地址源：主源是
           window.location.host——浏览器实际用来打开面板的地址。存在这儿，
           概览视图的 renderServer 取用时不需要再发请求。 */
        App.shell.panelAddress = typeof body.panelAddress === "string" ? body.panelAddress : null;
        return null;
      })
      .catch(function () {
        /* 系统信息是补充信息：这一次取不到就不显示，也不占用任何页面的错误横幅。
           要紧的失败（会话失效、配置文件坏了）由 `/api/state` 与 `/api/settings`
           各自报告，不需要这里再说一遍。*/
        return null;
      });
  }

  /**
   * 设置页「服务」组里的版本行（`data-role="about-version"`）。
   *
   * 版本来自 `/api/system`，与 `/api/state` 的 `server.version` 同源。「我的账户」
   * 页并进设置页时它落在「服务」组：版本是这个服务的属性。
   */
  function syncAboutVersion(version) {
    var node = byRole("about-version");
    if (!node || !version) return;
    node.textContent = version;
  }

  /* ---- 退出进程 -------------------------------------------------------- */

  /**
   * 退出进程（L3 危险动作）：先模态确认，再发 `shutdown`。
   *
   * 应答先于 `process.exit()` 到达（`control-surface.ts` 的 `SHUTDOWN_REPLY_GRACE_MS`），
   * 所以失败还能显示出来 —— 但那已经是这条页面上最后一条能读到的消息了。
   */
  function shutdownProcess() {
    App.confirm.open({
      title: t("system.shutdown.confirmTitle"),
      text: t("system.shutdown.confirmText"),
      warn: t("system.shutdown.confirmWarn"),
      danger: true,
      run: function () {
        App.api.sendControl({ cmd: "shutdown" }).then(function (body) {
          var failure = App.api.commandFailure(body);
          showNote(failure || t("system.shutdown.done"));
        });
      },
    });
  }

  /* ---- 外部地址 -------------------------------------------------------- */

  /** 授权页只可能是这两个协议（登录入口都指向上游的 https 地址）。*/
  var EXTERNAL_PROTOCOLS = { "https:": true, "http:": true };

  /**
   * 校验一个外部地址，可用就返回规范化后的 href，否则返回 `null`。
   *
   * 地址来自上游应答（`startOAuth` 的 `authorizeUrl`），属于不可信输入：只有协议在
   * 白名单里、主机名非空、且能被 `URL` 解析出来的才放行。`javascript:` / `data:`
   * 这类地址一旦被打开，脚本就在新标签页里执行，而页面这一侧没有任何办法确认上游
   * 确实只回了授权页。
   */
  function safeExternalUrl(url) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
    var target;
    try {
      target = new URL(url);
    } catch {
      return null;
    }
    if (EXTERNAL_PROTOCOLS[target.protocol] !== true) return null;
    if (!target.hostname) return null;
    return target.href;
  }

  /** 在新标签页里打开一个通过校验的外部地址（登录用的授权页）。*/
  function openExternalTab(url) {
    var href = safeExternalUrl(url);
    if (href === null) return false;
    // pi-lens-ignore: no-open-redirect-js -- 地址已由 safeExternalUrl 限定为 http(s) 且主机名非空
    window.open(href, "_blank", "noopener");
    return true;
  }

  /* ---- 给别的页面用的命令 ---------------------------------------------- */

  /**
   * 检查更新：`{ failure }` 或 `{ text }`（已经翻成句子）。
   *
   * `checkUpdate` 的稳定状态码到一句话（句子翻译，版本号与容器更新命令
   * 是机器能读的标识，原样拼进来）。
   */
  function checkUpdate() {
    return App.api.sendControl({ cmd: "checkUpdate" }).then(function (body) {
      var failure = App.api.commandFailure(body);
      if (failure) return { failure: failure };
      return { text: updateCheckText(body.update) };
    });
  }

  function updateCheckText(update) {
    if (update.status === "update") {
      return t("system.checkUpdate.available", { version: update.latest, notice: update.notice });
    }
    if (update.status === "skipped") return t("system.checkUpdate.skipped", { version: update.latest });
    if (update.status === "up-to-date") return t("system.checkUpdate.latest", { version: update.latest });
    return t("system.checkUpdate.unavailable");
  }

  /** 动作名到处理函数（`data-action` 在页面里声明，一个按钮一条命令）。*/
  var SHELL_ACTIONS = {
    "system-shutdown": shutdownProcess,
  };

  App.shell = {
    load: loadSystemInfo,
    checkUpdate: checkUpdate,
    actions: SHELL_ACTIONS,
    /* 地址校验 + 开新标签页：登录模态的「打开浏览器」用它，
       两份白名单迟早会漂移。*/
    openExternal: openExternalTab,
    /* `/api/system` 的 panelAddress（侧边栏状态区的地址回退值，load 后就位）。*/
    panelAddress: null,
  };
})(window.__zcodeApp = window.__zcodeApp || {});
