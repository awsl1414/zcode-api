/*
 * app-view-accounts.js — 账号页的编排层：渲染出口、事件入口、导入导出、删除确认
 * 与顶栏刷新。
 *
 * 这一层只负责「把页面串起来」，具体子系统各归其位：
 *
 *   app-accounts-plan-cards.js   额度模型与套餐卡（卡序列 / 桶行 / 窗口行 / 活动段）
 *   app-accounts-table.js        表格行、筛选搜索、批量条、行尾菜单与占比浮层
 *   app-accounts-detail.js       详情大窗（段序列 / 抢活动 / 逐路由健康）与开窗入口
 *
 * 留在本文件的三件事：
 *
 *   - **`render` 出口**：统计行 → 表格行 → 批量条 → 详情窗同步 → `?focus=` 高亮。
 *     顺序即依赖：行的选择回收要在全选同步之前，窗体重画要在行重建之后。
 *   - **导入 / 导出**：文件内容读成字符串发给服务端；导出走内容返回模式
 *     （`inline: true`）+ 浏览器下载，明文导出先手输 EXPORT。
 *   - **删除确认**与**顶栏刷新**：删除默认 drain，勾了
 *     「强制中断」才发 `drain: false` 且要再点一次；刷新先重拉 `/api/state`，
 *     再按 label 清单让服务端分级采样额度（详情正开着的账号必采）。
 *
 * 写入一律走 `POST /api/control`，成功后立刻回读 `/api/state`，页面不做本地乐观
 * 更新。状态筛选与搜索是纯客户端过滤（归表格模块），不加新命令、不加新筛选维度。
 * 详情窗是 920px 居中大窗（`.modal--lg`），开合与焦点管理在 `App.widgets.dialog`，
 * 窗体每拍重画、服务端新数据原地带回。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var byRole = App.dom.byRole;
  var setHidden = App.dom.setHidden;
  var t = App.i18n.t;

  var table = App.accountsTable;
  var detail = App.accountsDetail;

  /** 删除模态的状态：目标账号（`null` = 模态没开）与「再点一次」是否已就位。*/
  var deleteTarget = null;
  var deleteArmed = false;

  /* ---- 渲染出口 -------------------------------------------------------- */

  /** 用最近一拍载荷重画整页（筛选、搜索、勾选后的即时反馈走这里）。*/
  function redraw() {
    if (App.state.lastState) App.renderState(App.state.lastState);
  }

  function renderAccountsPage(accounts) {
    var tableView = byRole("page-accounts-table");
    var empty = byRole("page-accounts-empty");
    var nomatch = byRole("page-accounts-nomatch");

    table.renderStats(accounts);
    var visible = table.buildRows(accounts);

    setHidden(empty, accounts.length > 0);
    /* 「没有匹配的账号」只在有账号、但被筛选 / 搜索滤空时说：
       0 账号时上面那整块虚线空态已经把话说完了，再挂一行“没有匹配”是同一件事
       说两遍（没有数据就不占地方）。 */
    setHidden(nomatch, accounts.length === 0 || visible.length > 0);
    setHidden(tableView, visible.length === 0);

    table.syncBulkBar(accounts);
    detail.sync(accounts);
    applyFocus();
  }

  /* ---- 从概览页跳过来时指到那一行（`?focus=<label>`）------------------- */

  /** 高亮停留两秒（够读完一行）。*/
  var FOCUS_HIGHLIGHT_MS = 2000;
  /** 地址里的 `focus` 只读一次（之后的轮询不会再改它）。*/
  var focusResolved = false;
  /** 要指出的那一行（`null` = 这一次没有 `?focus=`）。*/
  var focusLabel = null;
  /**
   * 高亮截止时刻（`0` = 还没找到那一行）。
   *
   * 计时从找到那一行开始，不是从页面加载开始：状态载荷有时要到几百毫秒之后才
   * 回来（后端在扫账号仓），从加载起算会让高亮在表格出现之前就过期。
   * 表格每 5 秒重画一次，重画之后按同一段截止时刻补回来。
   */
  var focusDeadline = 0;
  /** 只滚一次：重画时再滚会把用户刚滚到的位置拽回去。*/
  var focusScrolled = false;
  /** 到点重画一次高亮（否则要等下一拍轮询才摘掉）。*/
  var focusTimer = 0;

  /** 地址里的 `focus` 参数（没有就是 `null`）。*/
  function focusLabelFromUrl() {
    var search = window.location.search;
    if (!search) return null;
    var params = new URLSearchParams(search);
    var label = params.get(C.FOCUS_QUERY_KEY);
    return label ? label : null;
  }

  /**
   * 把 `?focus=<label>` 那一行滚进视野并高亮两秒。
   *
   * 概览页的账号摘要每一行都跳到这里。账号可能刚被删掉（概览页那张表是上一拍的
   * 快照），找不到就什么也不做：跳到一个已经不存在的行上没有任何补救办法，
   * 报错只是多一条用户看不懂的红条。被筛选 / 搜索滤掉的行同理：不强制展示。
   *
   * 高亮按截止时刻算而不是「加一次类然后等定时器删」：表格每次载荷到达都会
   * 整体重画（`clear(body)`），一次性加上的类会被下一次重画抹掉。所以这里每拍都
   * 按截止时刻决定加还是不加，并在到点那一刻自己重画一次。
   */
  function applyFocus() {
    if (!focusResolved) {
      focusResolved = true;
      focusLabel = focusLabelFromUrl();
    }
    if (!focusLabel) return;
    var body = byRole("page-accounts-body");
    if (!body) return;

    var rows = body.querySelectorAll("tr[data-account]");

    /* 到点：摘掉高亮并彻底退出。`focusLabel` 清成 `null` 之后这条路径不再参与，
       否则下面那个「到点再来一次」的定时器会每两秒自我续期。 */
    if (focusDeadline !== 0 && Date.now() >= focusDeadline) {
      for (var k = 0; k < rows.length; k++) rows[k].classList.remove("row--focus");
      focusLabel = null;
      return;
    }

    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute("data-account") !== focusLabel) {
        rows[i].classList.remove("row--focus");
        continue;
      }
      /* 计时从找到那一行开始，不是从页面加载开始。 */
      if (focusDeadline === 0) focusDeadline = Date.now() + FOCUS_HIGHLIGHT_MS;
      rows[i].classList.add("row--focus");
      if (!focusScrolled) {
        focusScrolled = true;
        /* `block: "center"`：行落在视口中段，前后文都看得见。 */
        if (typeof rows[i].scrollIntoView === "function") rows[i].scrollIntoView({ block: "center" });
      }
    }

    /* 到点自己重画一次：不依赖下一次轮询（5 秒一拍），高亮才真的是两秒。 */
    if (focusDeadline !== 0 && !focusTimer) {
      focusTimer = window.setTimeout(function () {
        focusTimer = 0;
        applyFocus();
      }, FOCUS_HIGHLIGHT_MS);
    }
  }

  /* ---- 导入 / 导出（复用既有控制命令）----------------------------------- */

  /**
   * 已选中的导入文件（`null` = 还没选）。
   *
   * 存在模块里而不是只读 `<input>`：视图每次轮询都重画表格，但这一格是静态 DOM
   * （`page.html`）；真正需要它跨重画的场景是「选完文件、导一次失败、再点一次导入」
   * —— 那时 `<input>` 里的 `files` 还在，但读它的代码只挂在自己的 change 上。
   * 语言切换后重写的文件名也读这里（见 `renderTransfer`）。
   */
  var importFile = null;

  /** 「选择文件」按钮：代点隐藏的 file input（`display:none` 的框也能被程序点开）。*/
  function pickImportFile() {
    var input = byRole("accounts-importFile");
    if (input && typeof input.click === "function") input.click();
  }

  /**
   * file input 的 change：记下选中的文件并回显名字。
   *
   * `input.value = ""` 不在这里清：清掉之后同一个文件选第二次也能再触发 change，
   * 但也会把 `files` 清空——所以只在用户重选时覆盖，不清空。
   */
  function onImportFilePicked() {
    var input = byRole("accounts-importFile");
    var files = input && input.files ? input.files : null;
    var file = files && files.length > 0 ? files[0] : null;
    if (!file) return;
    importFile = file;
    renderTransfer();
  }

  /**
   * 写导入那一段说明。
   *
   * 一行足够：「未选择文件 / 文件名」与「ZCode 凭据文件或本工具的导出包」说的是
   * 同一件事（选什么文件、选了没有），所以合并成 `<文件状态> · <能导什么>`，
   * 一行截断，全句挂 `title`（长说明折 title）。
   *
   * 它是运行时文本（文件名），所以不走 `data-i18n`（`applyI18n` 会把节点文本直接
   * 换成字典值）；语言切换时由 `App.i18n.applyLanguage` 回头调一次本函数重写。
   */
  function renderTransfer() {
    var name = byRole("accounts-importName");
    if (!name) return;
    var text =
      (importFile ? importFile.name : t("settings.import.noFile")) + " · " + t("settings.import.hint");
    name.textContent = text;
    name.setAttribute("title", text);
  }

  /**
   * 导入：读选中的文件内容发给服务端（内容模式，不传路径）。
   *
   * 不再让用户填服务端路径（他们看不到那个文件系统）。文件内容直接用
   * `File.text()` 读成字符串随命令发出；服务端按内容区分「本工具的导出包」与
   * 「ZCode 凭据文件」，网页不需要知道是哪种。密码只给加密包，没密码就让服务端
   * 回 `import_password_required`（一次往返省掉页面的猜测逻辑）。
   */
  function submitImport() {
    if (!importFile) {
      App.api.showActionError(t("settings.import.fileRequired"));
      return;
    }
    var passwordField = byRole("accounts-importPassword");
    var password = passwordField ? passwordField.value : "";
    var file = importFile;
    readFileText(file, function (text) {
      var cmd = { cmd: "importAccount", content: text };
      if (password) cmd.password = password;

      App.api.dispatch(
        cmd,
        function (body) {
          if (passwordField) passwordField.value = "";
          /* 导入成功后清掉选中：同一份包再导一次只会变成重复账号。 */
          resetImportFile();
          App.widgets.toast.show({
            text: t("settings.import.done", { count: body.imported }),
            durationMs: C.TOAST_NOTICE_MS,
          });
        },
        "accounts",
      );
    });
  }

  /** 清掉已选文件（导入成功之后）。*/
  function resetImportFile() {
    importFile = null;
    var input = byRole("accounts-importFile");
    /* `hidden` 的 input 也要清：留着旧的 `files`，同一个文件再选一次不会触发
       change（浏览器按「值没变」处理），用户会以为按钮坏了。 */
    if (input) input.value = "";
    renderTransfer();
  }

  /**
   * 读一个 `File` 的文字。`File.text()` 是标准 API（Blob 上的）；用 `window.` 前缀
   * 是为了让测试环境解析到 window 上的那份，而不是运行宿主的全局。
   */
  function readFileText(file, done) {
    if (typeof file.text === "function") {
      file.text().then(done, function () {
        App.api.showActionError(t("settings.import.fileUnreadable"));
      });
      return;
    }
    var reader = new window.FileReader();
    reader.onload = function () {
      done(String(reader.result));
    };
    reader.readAsText(file);
  }

  /**
   * 导出：内容返回模式（`inline: true`）+ 浏览器下载。
   *
   * 服务端不再往 `.zcode-proxy/` 写文件（用户还得去翻那个目录），而是把整份包放进
   * 应答：`payload` 是文件原文，`filename` 是服务端按本地时刻拼的名字。加密模式
   * 下 `payload` 就是加密包，密码框照旧。
   */
  function submitExport() {
    var formatField = byRole("accounts-exportFormat");
    var passwordField = byRole("accounts-exportPassword");
    var format = formatField ? formatField.value : C.DEFAULT_EXPORT_FORMAT;
    var password = passwordField ? passwordField.value : "";

    if (format === "encrypted" && !password) {
      App.api.showActionError(t("settings.export.passwordRequired"));
      return;
    }

    var cmd = { cmd: "exportAccounts", format: format, inline: true };
    if (password) cmd.password = password;

    if (format === C.PLAINTEXT_EXPORT_FORMAT) {
      /* 明文导出：先手输 EXPORT，确认后才带 force 发出去 */
      App.confirm.open({
        title: t("settings.export.confirmTitle"),
        text: t("settings.export.confirmText"),
        warn: t("settings.export.confirmWarn"),
        danger: true,
        requiresToken: true,
        run: function () {
          cmd.force = true;
          sendExport(cmd, passwordField);
        },
      });
      return;
    }

    sendExport(cmd, passwordField);
  }

  function sendExport(cmd, passwordField) {
    App.api.dispatch(
      cmd,
      function (body) {
        if (passwordField) passwordField.value = "";
        if (body.payload && body.filename) {
          App.dom.download(body.filename, body.payload, C.ACCOUNTS_EXPORT_MIME);
          App.widgets.toast.show({
            text: t("settings.export.doneFile", { count: body.count, filename: body.filename }),
            durationMs: C.TOAST_NOTICE_MS,
          });
          return;
        }
        /* 掩码模式：没有文件产物（只回清单），所以只说一句数。 */
        App.widgets.toast.show({
          text: t("settings.export.doneMasked", { count: body.count }),
          durationMs: C.TOAST_NOTICE_MS,
        });
      },
      "accounts",
    );
  }

  /* ---- 出口代理抽屉 ---------------------------------------------------- */

  /**
   * 打开出口代理抽屉（页头那颗「出口代理」按钮）。
   *
   * 代理是账号属性的命名字典：它的管理面挂在账号页的浮层里，没有自己的视图。
   * 挂载点就是 `page-tail.html` 里 `data-role="proxies-drawer-body"` 那块——抽屉
   * 打开时由代理模块自己重取一次 `listProxies`（`adopt` 会把整张表接过来并让账号表
   * 重画一次，所以关掉抽屉之后代理列已经是新的，不需要这里再补一次重读）。
   */
  function openProxiesDrawer() {
    App.proxies.mountProxiesDrawer(App.dom.byRole("proxies-drawer-body"));
  }

  /** 地址里的 `?proxies=1` 只消费一次（概览的共用出口告警带着它跳过来）。*/
  var proxiesFromUrlConsumed = false;

  /**
   * 概览「共用出口」告警的落点：账号页 + `?proxies=1`。
   *
   * 代理没有自己的路径，那条告警只能落到账号页并顺手把抽屉打开——否则
   * 链接只是把人丢到账号表，还得再找一次那颗按钮。与 `?focus=` 同一套约定：
   * 只读一次，读过的参数不再参与（之后的轮询与重画都不再打开抽屉）。
   */
  function openProxiesFromUrl() {
    if (proxiesFromUrlConsumed) return;
    proxiesFromUrlConsumed = true;
    var search = window.location.search;
    if (!search) return;
    if (new URLSearchParams(search).get(C.PROXIES_QUERY_KEY) !== "1") return;
    openProxiesDrawer();
  }

  /* ---- 删除账号 -------------------------------------------------------- */

  /** 删除模态的 `data-dialog` id（开合 / Esc / 焦点归还都由 dialog 层管）。*/
  var DELETE_DIALOG_ID = "delete";

  function openDeleteModal(account) {
    deleteTarget = account;
    deleteArmed = false;

    var title = byRole("delete-modal-title");
    if (title) title.textContent = t("accounts.delete.title", { label: account.label });

    var body = byRole("delete-modal-text");
    if (body) body.textContent = t("accounts.delete.body");

    var hint = byRole("delete-modal-hint");
    if (hint) {
      hint.textContent =
        account.inflight > 0 ? t("accounts.delete.inflight", { count: account.inflight }) : t("accounts.delete.drain");
    }

    var force = byRole("delete-force");
    if (force) force.checked = false;
    setDeleteArmed(false);
    setDeleteBusy(false);

    App.widgets.dialog.open(DELETE_DIALOG_ID, {
      /* 来源是行尾 ⋯ 菜单：菜单项在打开确认框时就收起了，收起的菜单项不该接回
         焦点；每次都按 label 现找那一行的 ⋯ 触发按钮（行可能已经被轮询重画换掉）。 */
      fallback: function () {
        return menuButtonFor(account.label);
      },
      onDismiss: closeDeleteModal,
    });
  }

  function closeDeleteModal() {
    deleteTarget = null;
    deleteArmed = false;
    setDeleteBusy(false);
    App.widgets.dialog.close(DELETE_DIALOG_ID);
  }

  /**
   * ⋯ 触发键（焦点归还的落点）。
   *
   * 打开确认框时菜单已经收起，原来的菜单项不再可聚焦；同一条消息的来源按钮
   * 才是用户心里的「我刚才在哪」。行可能已经被轮询重画换掉，所以按 label 现找；
   * label 是用户输入的自由文本，不能拼进选择器（引号 / 方括号都能让
   * `querySelector` 抛错），所以先按属性遍历再比字符串。
   */
  function menuButtonFor(label) {
    var body = byRole("page-accounts-body");
    if (!body) return null;
    var rows = body.querySelectorAll("tr[data-account]");
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute("data-account") !== label) continue;
      return rows[i].querySelector("[data-menu-button]");
    }
    return null;
  }

  /**
   * 删除键的在途态：`removeAccount` 飞着的时候禁用，防连点发两条（第二次回
   * `not_found`，还会把第一次的提示盖掉）。
   */
  function setDeleteBusy(busy) {
    var confirm = byRole("delete-confirm");
    if (!confirm) return;
    confirm.disabled = busy;
    if (busy) confirm.setAttribute("aria-busy", "true");
    else confirm.removeAttribute("aria-busy");
  }

  /**
   * force 的二次确认：勾了「强制中断」之后，确认按钮第一次只换成「再次确认强制删除」，
   * 第二次点击才真的发 `drain: false`。默认（不勾）一次点击即 drain 删除。
   */
  function submitDelete() {
    if (!deleteTarget) return;
    var force = byRole("delete-force");
    var forced = !!force && force.checked;

    if (forced && !deleteArmed) {
      setDeleteArmed(true);
      return;
    }

    var label = deleteTarget.label;
    var cmd = { cmd: "removeAccount", label: label, drain: !forced };
    /* 请求飞着的时候确认键禁用：连点的第二下什么也不发（第二次回 `not_found`，
       还会把第一次的提示盖掉）。命令回来再收框——成功与失败都在页面的横幅上
       有话说，框盖着它反而读不到。 */
    setDeleteBusy(true);
    App.api
      .dispatch(cmd, function (body) {
        App.api.showNotice(
          body.aborted > 0
            ? t("accounts.notice.removedAborted", { label: label, count: body.aborted })
            : t("accounts.notice.removed", { label: label }),
        );
      })
      .then(function () {
        closeDeleteModal();
        return null;
      });
  }

  function setDeleteArmed(armed) {
    deleteArmed = armed;
    var confirm = byRole("delete-confirm");
    if (!confirm) return;
    confirm.textContent = armed ? t("accounts.delete.confirmForce") : t("accounts.delete.confirm");
    confirm.className = armed ? "btn btn--danger" : "btn btn--primary";
  }

  /**
   * 顶栏刷新：账号表来自 `/api/state`，先重拉那份载荷；额度采按
   * 服务端分级决策——详情大窗正开着的账号必采 / stale 账号补采 / 新鲜账号不采，同一账号
   * 30s 去重在 `sampleNow`（与即时复采共用）。
   *
   * 账号摘要只回 `idPrefix`（不回显完整指纹），所以这里把 label 清单交给
   * 服务端按 label 解析成账号 id；详情卡那个「刷新」按钮仍走 `label` 的必采路径
   * （命令形状不变）。两者成功后都由 dispatch 回读 `/api/state`。
   */
  function refresh() {
    var accounts = (App.state.lastState && App.state.lastState.accounts) || [];
    var labels = [];
    for (var i = 0; i < accounts.length; i++) labels.push(accounts[i].label);
    /* 详情窗正开着哪个账号由大窗模块回答（顶栏刷新要交给服务端做必采）。*/
    var focused = detail.focusedLabel() || undefined;
    var pending = App.api.refresh();
    if (labels.length > 0) {
      App.api.dispatch({ cmd: "quota", labels: labels, focusedLabel: focused }, null, "accounts");
    }
    return pending;
  }

  /* ---- 事件绑定 -------------------------------------------------------- */

  function bindControls() {
    /* 表格的全部交互（筛选 / 搜索 / 勾选 / 批量条 / 行委托 / 菜单与占比浮层）
       归表格模块；这里注入它需要的三个动作：开详情窗、开删除确认、整页重画。 */
    table.bind({
      openDialog: detail.openDialogFor,
      openDelete: openDeleteModal,
      redraw: redraw,
    });

    /* 导入的文件入口：按钮代点隐藏的 file input（那个按钮的动作在
       `App.views.accounts.actions`），选择结果走 change 记进模块（`importFile`），
       文件名回显在控件列下方。 */
    var importFileInput = byRole("accounts-importFile");
    if (importFileInput) importFileInput.addEventListener("change", onImportFilePicked);
    /* 「未选择文件」是运行时文本（`applyI18n` 会把它盖掉），这里初始化一次；
       语言切换时由 `App.i18n.applyLanguage` 调 `renderTransfer` 重写。 */
    renderTransfer();
    /* `?proxies=1`（概览的共用出口告警）：进页面就把抽屉展开一次。 */
    openProxiesFromUrl();
  }

  App.views.accounts = {
    render: renderAccountsPage,
    refresh: refresh,
    bindControls: bindControls,
    /** 语言切换时重写运行时文本（已选文件名）。`applyLanguage` 会调它。*/
    renderTransfer: renderTransfer,
    openDelete: openDeleteModal,
    closeDelete: closeDeleteModal,
    submitDelete: submitDelete,
    armDelete: setDeleteArmed,
    actions: {
      /* 页头「出口代理」：打开代理字典抽屉（管理面在本页，代理没有独立视图）。 */
      "accounts-open-proxies": openProxiesDrawer,
      "accounts-import-pick": pickImportFile,
      "accounts-import": submitImport,
      "accounts-export": submitExport,
      /* 大窗头部那个「刷新」：只刷当前展示的账号，命令仍是现有的
         `quota` + label，不新增命令面。 */
      "accounts-refresh-quota": detail.refreshQuota,
      /* 两粒登录按钮不是独立动作——它们是 `data-action="open-add"`，
         把模态开到登录 tab 并预选服务商（见 page.html 的 page-header__actions）。 */
    },
  };
})(window.__zcodeApp = window.__zcodeApp || {});
