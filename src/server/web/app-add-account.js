/*
 * app-add-account.js — 添加账号模态（登录 + 两个导入来源）。
 *
 * 三个 tab：`login` / `credential` / `jwt`。两条导入路最后都归到同一条
 * `addAccount` 命令：
 *
 *   - `credential`（`source: "file"`）：手工 key 对 / 浏览器选的文件的**内容** /
 *     服务端路径，优先级依次递减。浏览器选的文件用 `content` 发（服务端不碰磁盘），
 *     不是 JSON 对象的内容（例如一份 .txt 里就一行 JWT）按 JWT 原文发；
 *   - `jwt`（`source: "jwt"`）：粘贴的 JWT 原文。
 *
 * 「本机路径」与「浏览器选文件」读的是同一种文件，只差“在哪台机器上读”，而「本机」
 * 指的是**跑代理的那台机器**——对浏览器用户是一句误导。所以合成一个 tab，内部用
 * radio 选来源，浏览器选文件是主路径（推荐且默认）。
 *
 * 手工 key 对挂在 `credential` tab 下而不是另开一个 tab：它和凭据文件导入落到同一个
 * 凭据形状（`auth/import.ts` 的 `api-key-pair` 分支），分两个入口只会让用户
 * 多猜一次该走哪个。
 *
 * provider 选择器只在需要它的两个入口生效：手工 key 对与粘贴 JWT。凭据文件自己带着
 * `oauth:active_provider`，那里选 provider 只会覆盖掉文件里的事实（所以不随文件发）。
 *
 * 本机认证文件的扫描是只读列表，选中一行就把路径填进输入框。扫描结果是外部输入
 * （文件可能不存在或读不了），失败时留空列表加「手动填路径」提示，不弹错误框挡住
 * 添加流程。它现在只在选中「使用服务端文件」时发生。
 *
 * 登录 tab 是唯一一条异步、跨请求的路径：`startOAuth` 拿授权地址，页面画二维码并
 * 轮询 `GET /api/oauth-status`，成功后由控制面建号、页面只负责刷新列表。轮询的生命
 * 周期见 `loginTimer` 那一段的注释。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var state = App.state;
  var byRole = App.dom.byRole;
  var setText = App.dom.setText;
  var setHidden = App.dom.setHidden;
  var create = App.dom.create;
  var clear = App.dom.clear;
  var button = App.dom.button;
  var t = App.i18n.t;
  var errorText = App.i18n.errorText;

  /** 模态的 `data-dialog` id（开合 / Esc / 焦点都由 dialog 层管）。*/
  var ADD_DIALOG_ID = "add";

  /** 当前选中的 tab（提交时决定命令带 `content` / `file` / `jwt`）。*/
  var addTab = C.DEFAULT_ADD_TAB;

  /**
   * 「导入凭据」tab 里的两个来源：`browser`（默认，浏览器选的 `File`）与
   * `server`（代理主机上的路径）。
   */
  var CREDENTIAL_SOURCE_BROWSER = "browser";
  var CREDENTIAL_SOURCE_SERVER = "server";
  var credentialSource = CREDENTIAL_SOURCE_BROWSER;

  /**
   * 浏览器里选中的凭据文件（`null` = 没选）。
   *
   * 与账号页的导入同一个做法：文件内容在提交时才读（`File.text()`），只进内存，
   * 不写临时文件；命令带的是 `content`（服务端不碰磁盘）。
   */
  var addFile = null;

  /* ---- 登录流程的状态 --------------------------------------------------- */

  /**
   * 当前这次登录流程（`null` 表示没有）。
   *
   * 两个字段都要留着：`flowId` 用来认领轮询应答（第二次 `startOAuth` 会顶掉前一条
   * 流程，别人的 `pending` 不能当成自己的），`authorizeUrl` 是二维码与复制按钮的
   * 唯一来源。
   */
  var loginFlow = null;

  /**
   * 登录轮询的定时器 id（`null` 表示没在轮询）。
   *
   * 生命周期只有三条出口，全部走 `stopLoginPolling`：流程结束（ready / failed）、
   * 模态关闭、以及切走登录 tab。关掉模态还在轮询是明确的 bug：白花请求，而且成功
   * 时会突然关掉一个用户已经放弃的弹窗。
   */
  var loginTimer = null;

  /** 登录面板的相位（`C.LOGIN_PHASE`），语言切换要按它重画状态行。*/
  var loginPhase = C.LOGIN_PHASE.IDLE;
  /** 失败时的错误文案（`accounts.add.login.status.failed` 的 `{{error}}`）。*/
  var loginError = "";

  /**
   * 已经发出的 `startOAuth` 次数。
   *
   * 应答回来时对一次：用户在命令飞行中又点了一次 provider、或者关掉了模态，先前那次
   * 应答就不能再画二维码、也不能再开轮询。
   */
  var loginAttempt = 0;

  /**
   * 本次进入登录 tab 是否已经发过 `startOAuth`。
   *
   * 它把“切到登录 tab”与“重复点当前 tab”分开：前者要发起流程，后者什么都不应发生
   * （否则每点一下就发一条 `startOAuth`，后一条会把正在等的那条顶掉）。失败后重试
   * 走的是自己的按钮，不靠这个标记。
   */
  var loginRequested = false;

  function handleOpenAdd(event) {
    var node = event.currentTarget;
    /* 打开入口只带 tab（账号页右上角「添加账号」不带任何属性）：服务商按当前账号
       预选，由 `openAddModal` 的默认 provider 逻辑负责。 */
    openAddModal(node.getAttribute("data-add-tab") || C.DEFAULT_ADD_TAB);
  }

  /**
   * 打开模态。`tab` 缺省是登录（`C.DEFAULT_ADD_TAB`）。
   *
   * `provider` 参数保留给「从别处按某个服务商直接开始授权」的调用方；页面右上角的
   * 两粒登录快捷按钮已经删除，现在唯一的调用方（`handleOpenAdd`）不传它，服务商
   * 按当前账号预选（`markLoginProvider(provider || firstProvider())`）。
   */
  function openAddModal(tab, provider) {
    showAddError(null);
    initProviderSelects();
    /* 登录的默认 provider 取当前账号那一家的（理由见 firstProvider）：每次打开
       都按账号表重新定一次，上次留下的选择不该跨一次打开活下来。没带 provider 就
       先铺默认值，带了的由下面 selectAddTab 直接发起那一家。*/
    markLoginProvider(provider || firstProvider());
    var next = C.ADD_TABS.indexOf(tab) >= 0 ? tab : C.DEFAULT_ADD_TAB;
    selectAddTab(next, provider || null);
    /* 开合、Esc、遮罩与焦点归还都交给 `App.widgets.dialog`。焦点落在「账号名」：
       登录 tab 会自动发一条 `startOAuth`，但真正要用户动手的是导入那两页；
       落在名称框既解释了「这个框是干嘛的」，也不会让扫码流程抢走第一个 Tab。*/
    App.widgets.dialog.open(ADD_DIALOG_ID, {
      initial: function () {
        return byRole("add-label");
      },
      /* 取消路径（Esc / 遮罩 / 关闭键）与「取消」键同一条：停轮询、作废在飞的
         `startOAuth`，面板回初始态。 */
      onDismiss: closeAddModal,
    });
  }

  function closeAddModal() {
    /* 关模态就是放弃这次登录：停轮询、作废在飞的那次 `startOAuth`，面板回到初始态，
       下次打开要重新发起一条流程（旧二维码对应的流程可能已经被顶掉或过期）。*/
    cancelLogin();
    resetLoginPanel();
    setSubmitBusy(false);
    App.widgets.dialog.close(ADD_DIALOG_ID);
  }

  /**
   * 提交键的在途态：请求飞着的时候禁用，防连点发出两条 `addAccount`。
   *
   * 与聊天发送 / 登录页同一形态（`disabled` + `aria-busy`），文案不动——按钮换成
   * 「添加中」会让它在窄屏上换行，而禁用态本身已经说明了「这一下已经算数」。
   */
  function setSubmitBusy(busy) {
    var submit = byRole("submit-add");
    if (!submit) return;
    submit.disabled = busy;
    if (busy) submit.setAttribute("aria-busy", "true");
    else submit.removeAttribute("aria-busy");
  }

  /**
   * 切 tab。`forceProvider` 是「打开时就指定了服务商」的那条路径带来的：它的语义
   * 是「现在就按这一家开始授权」，所以即使已经停在登录 tab（上一次流程还在跑）也要
   * 按它重发一条；其它情况只在“刚进 tab 且本回合还没发起过”时自动开始。
   */
  function selectAddTab(tab, forceProvider) {
    var next = C.ADD_TABS.indexOf(tab) >= 0 ? tab : C.DEFAULT_ADD_TAB;
    var leavingLogin = addTab === "login" && next !== "login";
    addTab = next;
    var tabs = document.querySelectorAll("[data-add-tab]");
    for (var i = 0; i < tabs.length; i++) {
      var active = tabs[i].getAttribute("data-add-tab") === addTab;
      tabs[i].className = "tab" + (active ? " tab--active" : "");
      tabs[i].setAttribute("aria-selected", active ? "true" : "false");
    }
    var panels = document.querySelectorAll("[data-add-panel]");
    for (var j = 0; j < panels.length; j++) {
      setHidden(panels[j], panels[j].getAttribute("data-add-panel") !== addTab);
    }
    /* 「添加」与账号名只服务于三个导入 tab：登录走控制面的 `startOAuth`，自己建号，
       在那里显示一个提交按钮只会让人以为还要点一下。*/
    setHidden(byRole("add-label-row"), addTab === "login");
    setHidden(byRole("submit-add"), addTab === "login");

    /* 登录流程跟着 tab 走：切走就停轮询；切回来（或第一次打开）就按选中的 provider
       发起一条新流程。这样用户看到的二维码永远是当前这条流程的。*/
    if (leavingLogin) {
      cancelLogin();
      resetLoginPanel();
    }
    if (addTab === "login") {
      if (forceProvider) chooseLoginProvider(forceProvider);
      else if (!loginRequested) chooseLoginProvider(selectedLoginProvider());
    }
    /* 「已选文件名」是运行时文本（`applyI18n` 会把它盖掉），所以不走 `data-i18n`；
       每次打开模态重写一次（上次关闭时的文件名不该跨一次打开活下来）。*/
    renderAddFileName();
    setCredentialSource(credentialSource);
    /* 本机认证文件的扫描跟着 tab 与来源走：它是一次 GET、结果不缓存，
       每次选中「使用服务端文件」重扫与以前每次开模态重扫是同一个代价。 */
    if (addTab === "credential" && credentialSource === CREDENTIAL_SOURCE_SERVER) loadCredentialSources();
  }

  /* ---- 导入凭据：来源与文件 --------------------------------------------- */

  /** 切来源（`browser` / `server`）：只改两块面板的可见性与扫描时机。*/
  function setCredentialSource(next) {
    credentialSource = next === CREDENTIAL_SOURCE_SERVER ? CREDENTIAL_SOURCE_SERVER : CREDENTIAL_SOURCE_BROWSER;
    var groups = document.querySelectorAll("[data-add-group]");
    for (var i = 0; i < groups.length; i++) {
      setHidden(groups[i], groups[i].getAttribute("data-add-group") !== credentialSource);
    }
    /* 服务端路径只在选中这一来源时扫描：没被选中的路不该发请求。 */
    if (addTab === "credential" && credentialSource === CREDENTIAL_SOURCE_SERVER) loadCredentialSources();
  }

  /** 「已选文件」那一行：文件名，没选就是那句「未选择文件」。*/
  function renderAddFileName() {
    var node = byRole("add-file-name");
    if (!node) return;
    node.textContent = addFile ? addFile.name : t("settings.import.noFile");
    node.setAttribute("title", addFile ? addFile.name : "");
  }

  /** file input 的 change：记下选中的文件并回显名字。*/
  function onAddFilePicked() {
    var input = byRole("add-file-picker");
    var files = input && input.files ? input.files : null;
    var file = files && files.length > 0 ? files[0] : null;
    if (!file) return;
    addFile = file;
    renderAddFileName();
  }

  /** 清掉已选文件（提交成功 / 重置表单时）。*/
  function resetAddFile() {
    addFile = null;
    var input = byRole("add-file-picker");
    /* 旧的 `files` 也要清：不清的话同一个文件再选一次不会触发 change（浏览器按
       「值没变」处理），用户会以为「选择文件」没反应。 */
    if (input) input.value = "";
    renderAddFileName();
  }

  /* ---- 本机认证文件 ---------------------------------------------------- */

  function loadCredentialSources() {
    var list = byRole("add-sources");
    if (!list) return;
    window
      .fetch(C.CREDENTIAL_SOURCES_PATH, { credentials: "same-origin" })
      .then(function (response) {
        if (!response.ok) return null;
        return response.json();
      })
      .then(function (body) {
        if (!body || !body.sources) return;
        renderCredentialSources(body.sources);
      })
      .catch(function () {
        /* 网络失败：留空列表加「手动填路径」提示，不阻塞添加流程 */
      });
  }

  function renderCredentialSources(sources) {
    var list = byRole("add-sources");
    var none = byRole("add-sources-none");
    if (!list) return;
    clear(list);

    var valid = 0;
    for (var i = 0; i < sources.length; i++) {
      if (!sources[i].valid) continue;
      valid += 1;
      list.appendChild(buildSourceItem(sources[i]));
    }
    setHidden(none, valid > 0);
  }

  /**
   * 一条扫描结果：**路径独占一行**，徽章与「使用」在下一行靠右（`order-item--stack`
   * 即这条排布）。同一行排时路径会被挤成两行、按钮折到第三行。
   */
  function buildSourceItem(source) {
    var item = create("li", "order-item order-item--stack");
    var name = create("span", "order-item__name", source.path);
    /* 路径在卡片里被裁成一行，完整值挂 title（同 `.hint--clip` 的口径）。 */
    name.title = source.path;
    item.appendChild(name);
    var actions = create("span", "order-item__actions");
    actions.appendChild(create("span", "tag tag--ok", t("accounts.add.file.valid")));
    if (source.provider) actions.appendChild(create("span", "tag", source.provider));
    actions.appendChild(
      button(t("accounts.add.file.use"), "btn", function () {
        var field = byRole("add-file-path");
        if (field) field.value = source.path;
      }),
    );
    item.appendChild(actions);
    return item;
  }

  /* ---- provider（凭据出身）---------------------------------------------- */

  /**
   * 两个 provider 选择器都填上选项：手工 key 对（file tab）与粘贴 JWT。
   *
   * 选项文字直接用协议值 `zai` / `bigmodel`：它们是凭据字段的取值，不是人读的
   * 句子，不参翻译（机器能读的标识不翻）。
   *
   * 默认取当前账号的 provider：用户正在用的那个就是最可能的答案，而 JWT 的
   * payload 里没有 provider 可查。
   */
  function initProviderSelects() {
    var selects = document.querySelectorAll('[data-role="add-provider"]');
    var preferred = firstProvider();
    for (var i = 0; i < selects.length; i++) {
      var select = selects[i];
      clear(select);
      for (var j = 0; j < C.PROVIDER_IDS.length; j++) {
        var id = C.PROVIDER_IDS[j];
        var option = document.createElement("option");
        option.value = id;
        option.textContent = id;
        select.appendChild(option);
      }
      select.value = preferred;
    }
  }

  /**
   * 新建账号时下拉框的默认 provider：账号表里第一个账号的 provider，表为空时用
   * 默认 family。没有「当前账号」可以跟随（出线账号由调度器按请求决定）。
   */
  function firstProvider() {
    var accounts = (state.lastState && state.lastState.accounts) || [];
    return accounts.length > 0 ? accounts[0].provider : C.DEFAULT_PROVIDER;
  }

  /** 某个 tab 面板里那个选择器的值（面板里没有就是 `null`）。*/
  function providerOf(panelName) {
    var panel = document.querySelector('[data-add-panel="' + panelName + '"]');
    if (!panel) return null;
    var select = panel.querySelector('[data-role="add-provider"]');
    return select ? select.value : null;
  }

  /* ---- 登录 ------------------------------------------------------------- */

  /**
   * 登录 tab 里两个 provider 按钮。
   *
   * 登录的 provider 必须由用户选：它决定这次去哪家拿授权（`startOAuth` 的入参），
   * 不像 JWT 那样只能从已有账号猜（payload 里没有 provider 字段）。
   */
  function loginProviderButtons() {
    return document.querySelectorAll("[data-login-provider]");
  }

  /** 当前选中的 provider 按钮的值；一个都没选中时回到默认值。*/
  function selectedLoginProvider() {
    var buttons = loginProviderButtons();
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].getAttribute("aria-pressed") === "true") {
        return buttons[i].getAttribute("data-login-provider");
      }
    }
    return firstProvider();
  }

  /**
   * 选中一个 provider 并发起登录。
   *
   * 选中态与「哪一家在授权」是同一件事，所以点一下既改样式也发起流程：两者分开会让
   * 用户猜「我选好了，接下来点哪里」。
   */
  function chooseLoginProvider(provider) {
    markLoginProvider(provider);
    startLogin(provider);
  }

  /** 只改选中态，不发命令（打开模态时铺默认值用）。*/
  function markLoginProvider(provider) {
    var buttons = loginProviderButtons();
    for (var i = 0; i < buttons.length; i++) {
      var active = buttons[i].getAttribute("data-login-provider") === provider;
      buttons[i].setAttribute("aria-pressed", active ? "true" : "false");
      buttons[i].className = "login-flow__provider" + (active ? " login-flow__provider--active" : "");
    }
  }

  /**
   * 发起一条登录流程：`startOAuth` 回授权地址，之后才画二维码、开轮询。
   *
   * 没拿到地址就没有可展示、可等待的东西，所以地址是「流程已开始」的唯一信号。
   */
  function startLogin(provider) {
    stopLoginPolling();
    loginFlow = null;
    loginRequested = true;
    loginAttempt += 1;
    var attempt = loginAttempt;
    renderLoginQr(null);
    renderLoginLink(null);
    setLoginPhase(C.LOGIN_PHASE.IDLE, "");

    App.api.sendControl({ cmd: "startOAuth", provider: provider }).then(function (body) {
      /* 这条应答已经过期：用户又点了一次 provider，或者关掉了模态（`loginAttempt`
         在那两处都会加一）。再画二维码就会让两串流程的界面互相覆盖。*/
      if (attempt !== loginAttempt) return null;
      var failure = App.api.commandFailure(body);
      if (failure) {
        failLogin(failure);
        return null;
      }
      loginFlow = { flowId: body.flowId, authorizeUrl: body.authorizeUrl };
      renderLoginQr(body.authorizeUrl);
      renderLoginLink(body.authorizeUrl);
      setLoginPhase(C.LOGIN_PHASE.PENDING, "");
      startLoginPolling();
      return null;
    });
  }

  /**
   * 终止当前流程：停轮询、作废在飞的那次 `startOAuth` 应答。
   *
   * 不动面板上的东西（二维码 / 状态行），那由 `resetLoginPanel` 与 `failLogin` 分工。
   */
  function cancelLogin() {
    loginAttempt += 1;
    stopLoginPolling();
    loginFlow = null;
  }

  function startLoginPolling() {
    stopLoginPolling();
    loginTimer = window.setInterval(pollLogin, C.LOGIN_POLL_INTERVAL_MS);
  }

  function stopLoginPolling() {
    if (loginTimer === null) return;
    window.clearInterval(loginTimer);
    loginTimer = null;
  }

  /**
   * 发一次轮询，按应答切换相位。
   *
   * 三个判断都要做：
   *   1. 这条应答属于现在这个面板吗。轮询是异步的，回来的时候流程可能已经被关掉、
   *      被切走 tab，或者被下一次 `startOAuth` 顶掉；那就直接丢掉，不再往界面上写。
   *   2. `flowId` 必须是本次流程的。第二次 `startOAuth` 会顶掉前一条，别人的
   *      `pending` 不能认成自己的；`idle` 不带 `flowId`（被顶掉，或 5 分钟 TTL
   *      到期），两种情况结论一样：等的结果不会来了，报失败让用户重试。
   *   3. 401 走整页跳转（会话过期），这里只负责把轮询停掉。
   *
   * 单次网络失败不清空界面：轮询本来就会再发一次，一次抖动不该把二维码擦掉。
   */
  function pollLogin() {
    if (loginFlow === null) {
      stopLoginPolling();
      return null;
    }
    var flowId = loginFlow.flowId;
    return window
      .fetch(C.OAUTH_STATUS_PATH, { credentials: "same-origin" })
      .then(function (response) {
        if (response.status === C.HTTP_UNAUTHORIZED) {
          cancelLogin();
          App.api.goToLogin();
          return null;
        }
        if (!response.ok) return null;
        return response.json();
      })
      .then(function (body) {
        if (!body) return null;
        if (loginFlow === null || loginFlow.flowId !== flowId) return null;
        if (body.flowId !== flowId) {
          failLogin(errorText(C.LOGIN_ERROR_NO_FLOW));
          return null;
        }
        if (body.status === C.LOGIN_PHASE.READY) return finishLogin(body.accountLabel);
        if (body.status === C.LOGIN_PHASE.FAILED) {
          failLogin(errorText(body.error));
        }
        return null;
      });
  }

  /**
   * 成功：停轮询、刷新账号列表、关模态、报一句。
   *
   * 刷新在关之前：那一次 `/api/state` 往返期间状态行停在「授权成功，正在建号…」，
   * 关掉之后弹窗不在了、列表里已经能看到新账号，不会留下「关完了但列表还是空的」
   * 那一段空窗。
   */
  function finishLogin(label) {
    cancelLogin();
    setLoginPhase(C.LOGIN_PHASE.READY, "");
    App.api.showNotice(t("accounts.add.login.success", { label: label }));
    return App.api.refresh().then(function () {
      closeAddModal();
      return null;
    });
  }

  /** 失败：停轮询、擦掉那张已经无效的二维码，保留 provider 选择与「重试」。*/
  function failLogin(text) {
    cancelLogin();
    renderLoginQr(null);
    renderLoginLink(null);
    setLoginPhase(C.LOGIN_PHASE.FAILED, text);
  }

  /** 面板回到「还没开始」：二维码、链接、错误都清掉，下次进 tab 重新发起。*/
  function resetLoginPanel() {
    loginRequested = false;
    renderLoginQr(null);
    renderLoginLink(null);
    showCopyHint(null);
    setLoginPhase(C.LOGIN_PHASE.IDLE, "");
  }

  /**
   * 二维码容器：`qr.js` 生成一段 SVG，颜色走 `currentColor`，所以黑白来自
   * `.login-flow__qr` 上的 `--qr-bg` / `--qr-fg`（扫码器需要的黑白对比度）。
   *
   * 字符串用 `DOMParser` 解析成节点再插入，不走 `innerHTML`：两者都是「字符串
   * 进 DOM」，但前者不经过 HTML 解析器，也就不存在把文本当标签执行的那条路。
   *
   * 空框事故的根因在这里：先 `setHidden(false)` 再画时，画不出来
   * （编码器装不下这条授权链接、或 XML 解析失败）那个白底圆角容器已经显示出来了，
   * 里面什么都没有——用户看到的就是服务商按钮下面那个空框。所以顺序反过来：
   * **先拿到画好的节点，成功了再摘 `hidden`**；失败就保持隐藏（容器不占位），
   * 授权链接与「打开浏览器」仍然在下面可用，不把登录逼死在扫码这一条路上。
   */
  function renderLoginQr(url) {
    var box = byRole("login-qr");
    if (!box) return;
    clear(box);
    if (url === null) {
      setHidden(box, true);
      return;
    }
    var svg = null;
    try {
      svg = new window.DOMParser().parseFromString(App.qr.toSvg(url), "image/svg+xml").documentElement;
    } catch {
      /* 编码器装不下这条链接（或解析器报错）：下面统一按「没画出来」处理。*/
      svg = null;
    }
    /* 解析失败时 `documentElement` 可能是 `<parsererror>`：两个条件都过不去。*/
    if (!svg || svg.nodeName.toLowerCase() !== "svg") {
      setHidden(box, true);
      return;
    }
    box.appendChild(document.importNode(svg, true));
    setHidden(box, false);
  }

  /**
   * 授权链接区：一行说明 + 「复制链接」/「打开浏览器」，只在拿到地址后出现。
   *
   * 链接原文不进 DOM：那串 `client_id=…&redirect_uri=…` 占六行、把弹窗撑长，
   * 而读者要的是「在别处完成授权」这个动作，不是这段 query。地址留在
   * `loginFlow.authorizeUrl` 里，复制与打开都从那里取。
   */
  function renderLoginLink(url) {
    setHidden(byRole("login-link-row"), url === null);
    setHidden(byRole("login-open"), url === null);
  }

  function showCopyHint(text) {
    var hint = byRole("login-copy-hint");
    if (!hint) return;
    hint.textContent = text === null ? "" : text;
    setHidden(hint, text === null);
  }

  /**
   * 复制授权链接：优先 `navigator.clipboard`。
   *
   * 剪贴板不可用（非安全上下文、用户拒了权限）时不再有「页面上选中链接」这条
   * 退路——链接原文已经不在 DOM 里。这时只把地址回显在提示行上，用户自己复制：
   * 那句话里有完整地址，不隐藏失败。
   */
  function copyLoginLink() {
    if (!loginFlow) return;
    var clipboard = window.navigator ? window.navigator.clipboard : null;
    if (clipboard && typeof clipboard.writeText === "function") {
      clipboard.writeText(loginFlow.authorizeUrl).then(
        function () {
          showCopyHint(t("accounts.add.login.copied"));
        },
        showCopyFallback,
      );
      return;
    }
    showCopyFallback();
  }

  /** 剪贴板不可用：把地址原样写在提示行，用户手动选中复制。*/
  function showCopyFallback() {
    if (!loginFlow) return;
    showCopyHint(t("accounts.add.login.selectHint", { url: loginFlow.authorizeUrl }));
  }

  /** 在新的标签页里打开授权页（同一个地址校验器，见 `app-shell.js`）。*/
  function openLoginUrl() {
    if (!loginFlow) return;
    if (App.shell.openExternal(loginFlow.authorizeUrl)) return;
    failLogin(errorText(C.SYSTEM_ERROR_UNUSABLE_URL));
  }

  /** 重试：同一个 provider 重发一次 `startOAuth`（旧流程已经作废）。*/
  function retryLogin() {
    startLogin(selectedLoginProvider());
  }

  /**
   * 相位变化后的唯一绘制入口。
   *
   * 状态行不走 `data-i18n`：它的文案带错误明细，是运行时拼的。语言切换由
   * `app-i18n.js` 回叫 `renderLoginStatus` 重画（那个文件里写了两页的视图不假定
   * 存在）。
   */
  function setLoginPhase(phase, error) {
    loginPhase = phase;
    loginError = error || "";
    renderLoginStatus();
  }

  /**
   * 登录失败的文案。
   *
   * 服务端把失败原因当字符串透传（`panel.ts` 的 `/api/oauth-status` 里 `error`
   * 就是 `Error.message`），其中两种是 OAuth 客户端自己写的固定英文
   * （`src/auth/oauth.ts` 的超时 / 失败两句）。它们不是错误码，`errorText` 查不到，
   * 于是就以英文原文出现在中文界面里。这里把这两句翻成字典；其余（上游回的原话、
   * 网络错误）保持原样透出——那些带上下文，翻了反而丢信息。
   */
  var LOGIN_FAILURE_KEYS = {
    "Authorization timed out. Please retry login.": "accounts.add.login.error.timeout",
    "Authorization failed. Please retry login.": "accounts.add.login.error.failed",
  };

  function loginFailureText(message) {
    var key = LOGIN_FAILURE_KEYS[message];
    return key ? t(key) : message;
  }

  function renderLoginStatus() {
    var node = byRole("login-status");
    if (!node) return;
    var text =
      loginPhase === C.LOGIN_PHASE.FAILED
        ? t("accounts.add.login.status.failed", { error: loginFailureText(loginError) })
        : t("accounts.add.login.status." + loginPhase);
    node.textContent = text;
    node.className =
      "login-flow__status" +
      (loginPhase === C.LOGIN_PHASE.FAILED ? " login-flow__status--failed" : "") +
      (loginPhase === C.LOGIN_PHASE.READY ? " login-flow__status--ready" : "");
    /* 重试只在失败时出现：成功会关模态，等待中重试等于自己把自己的流程顶掉。*/
    setHidden(byRole("login-retry"), loginPhase !== C.LOGIN_PHASE.FAILED);
  }

  /* ---- 提交 ------------------------------------------------------------ */

  function bindAddForm() {
    /* 凭据文件：选择结果记进模块（`addFile`），名字回显在按钮后面。
       读内容发生在提交那一刻（`submitAdd`），只读一次。 */
    var picker = byRole("add-file-picker");
    if (picker) picker.addEventListener("change", onAddFilePicked);

    /* 来源二选一：radio 的 change 同时改面板可见性，扫服务端文件也在这一步触发。 */
    var sources = document.querySelectorAll('[data-role="add-credential-sources"] input');
    for (var s = 0; s < sources.length; s++) {
      sources[s].addEventListener("change", function (event) {
        setCredentialSource(event.currentTarget.value);
      });
    }

    /* 登录的 provider 按钮：点一下就切选中态并发起流程（见 chooseLoginProvider）。*/
    var providers = loginProviderButtons();
    for (var i = 0; i < providers.length; i++) {
      providers[i].addEventListener("click", function (event) {
        chooseLoginProvider(event.currentTarget.getAttribute("data-login-provider"));
      });
    }
  }

  /**
   * 提交「添加」。
   *
   * 三个 tab 对应三条来源：
   *
   *   - `credential`：`source: "file"`。优先级依次是**手工 key 对 → 浏览器选的文件的
   *     内容 → 服务端路径**（前两者落在同一个凭据形状上，与导入/添加的旧口径一致）；
   *   - `jwt`：`source: "jwt"`，粘贴的 JWT 原文；
   *   - `login`：不发命令（登录由 `startOAuth` 建号）。
   */
  function submitAdd() {
    var labelField = byRole("add-label");
    var label = labelField ? labelField.value.trim() : "";
    if (!label) {
      showAddError(t("accounts.add.labelRequired"));
      return;
    }

    var cmd = { cmd: "addAccount", label: label };

    if (addTab === "credential") {
      cmd.source = "file";
      var keyField = byRole("add-api-key");
      var apiKey = keyField ? keyField.value.trim() : "";
      var provider = providerOf("credential");
      if (apiKey) {
        /* 填了手工 key 就用它，文件与路径都不再参与。 */
        cmd.apiKey = apiKey;
        if (provider) cmd.provider = provider;
        sendAdd(cmd, label);
        return;
      }
      if (credentialSource === CREDENTIAL_SOURCE_BROWSER) {
        if (!addFile) {
          showAddError(t("accounts.add.credential.fileRequired"));
          return;
        }
        var file = addFile;
        readCredentialText(file, function (text) {
          /* 纯文本 JWT 粘进一份 .txt 也能用（浏览器选文件这条路保留了这个便利）：
             不是 JSON 文件就当 JWT 原文发。ZCode 凭据文件与导出包都是 JSON 对象，
             以 `{` 开头。 */
          if (text.trim().charAt(0) === "{") {
            cmd.content = text;
            sendAdd(cmd, label);
            return;
          }
          var jwtCmd = { cmd: "addAccount", label: label, source: "jwt", jwt: text.trim() };
          var jwtProvider = providerOf("credential");
          if (jwtProvider) jwtCmd.provider = jwtProvider;
          sendAdd(jwtCmd, label);
        });
        return;
      }
      var pathField = byRole("add-file-path");
      var path = pathField ? pathField.value.trim() : "";
      if (path) cmd.file = path;
      /* 不在这里带 `provider`：凭据文件自己带 `oauth:active_provider`，页面那个
         选择器只服务于手工 key 与 JWT。 */
      sendAdd(cmd, label);
      return;
    }

    if (addTab === "jwt") {
      var jwtField = byRole("add-jwt");
      var jwt = jwtField ? jwtField.value.trim() : "";
      if (!jwt) {
        showAddError(t("accounts.add.jwtRequired"));
        return;
      }
      cmd.source = "jwt";
      cmd.jwt = jwt;
      var jwtOnlyProvider = providerOf("jwt");
      if (jwtOnlyProvider) cmd.provider = jwtOnlyProvider;
    }

    sendAdd(cmd, label);
  }

  /**
   * 发 `addAccount`：成功关模态 + 重置，失败挂在模态里的错误行上。
   *
   * 在途期间提交键禁用（`setSubmitBusy`）：慢网络下连点会发两条，第二次要么
   * 顶掉第一次的提示，要么多建一个账号。
   */
  function sendAdd(cmd, label) {
    setSubmitBusy(true);
    App.api
      .dispatch(
        cmd,
        function () {
          closeAddModal();
          resetAddForm();
          App.api.showNotice(t("accounts.notice.added", { label: label }));
        },
        "add",
      )
      .then(function () {
        setSubmitBusy(false);
        return null;
      });
  }

  /**
   * 读一个 `File` 的文字。`File.text()` 是标准 API；用 `window.` 前缀是为了让测试
   * 环境解析到 window 上的那份，而不是运行宿主的全局（同账号页的导入）。
   */
  function readCredentialText(file, done) {
    if (typeof file.text === "function") {
      file.text().then(done, function () {
        showAddError(t("accounts.add.credential.fileUnreadable"));
      });
      return;
    }
    var reader = new window.FileReader();
    reader.onload = function () {
      done(String(reader.result));
    };
    reader.readAsText(file);
  }

  function resetAddForm() {
    var roles = ["add-label", "add-file-path", "add-api-key", "add-jwt"];
    for (var i = 0; i < roles.length; i++) {
      var field = byRole(roles[i]);
      if (field) field.value = "";
    }
    resetAddFile();
    setCredentialSource(CREDENTIAL_SOURCE_BROWSER);
    var browserRadio = byRole("add-source-browser");
    if (browserRadio) browserRadio.checked = true;
    initProviderSelects();
  }

  function showAddError(text) {
    var banner = byRole("add-error");
    if (!banner) return;
    setHidden(banner, text === null);
    setText("add-error-text", text === null ? "" : text);
  }

  App.views.add = {
    open: openAddModal,
    openFrom: handleOpenAdd,
    close: closeAddModal,
    selectTab: selectAddTab,
    bindForm: bindAddForm,
    submit: submitAdd,
    showError: showAddError,
    copyLink: copyLoginLink,
    openLoginUrl: openLoginUrl,
    retryLogin: retryLogin,
    renderStatus: renderLoginStatus,
    /** 语言切换时重写「未选择文件」那句（`applyLanguage` 会调）。*/
    renderCredentialFile: renderAddFileName,
  };
})(window.__zcodeApp = window.__zcodeApp || {});
