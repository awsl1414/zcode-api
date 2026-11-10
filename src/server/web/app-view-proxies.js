/*
 * app-view-proxies.js — 代理字典：命名出口代理表的增删改查，挂在账号页的抽屉里。
 *
 * 代理不是主实体，是账号属性「出口」的命名字典：账号行的代理下拉与批量条
 * 都按名字引用它，所以它没有自己的视图、没有 `/proxies` 路径，而是账号页页头
 * 「出口代理」按钮打开的一个管理抽屉。本模块仍然是一个独立职责（一张表的 CRUD +
 * 引用检查），只是挂载方式从「视图」换成了 {@link mountProxiesDrawer}。
 *
 * 代理表不进 `/api/state`：这份表只在人看这两处时才需要（抽屉与账号页的代理列），
 * 塞进每 5 秒一次的轮询载荷里只是让每个开着的浏览器反复搬一份不变的配置。所以页面
 * 用控制命令 `listProxies` 自己取，写命令的应答直接带回整张新表，拿来重画即可——
 * 与 `/api/state` 的「不做本地乐观更新」同一条规矩，只是真值来自命令应答。
 *
 * 密码永不回显：服务端只回 `hasPassword`，所以编辑弹窗里密码框留空表示
 * 「保持不变」，要清掉它得显式勾「清除密码」。这不是多余的一步：一个回显不出来的
 * 字段没法用「不修改」来表达，空串在服务端表示清除。
 *
 * 删除 / 停用一条仍被引用的代理会改变那些账号的出口，所以两者都走二次确认，并在
 * 确认文案里列出受影响的账号。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var setHidden = App.dom.setHidden;
  var create = App.dom.create;
  var clear = App.dom.clear;
  var button = App.dom.button;
  var t = App.i18n.t;
  var errorText = App.i18n.errorText;

  /** 抽屉壳的 `data-dialog` id（开合状态由 `App.widgets.dialog` 持有）。*/
  var DRAWER_ID = "proxies";
  /**
   * 新建 / 编辑弹窗的 `data-dialog` id。
   *
   * 它与抽屉各自登记在 `App.widgets.dialog` 里，不是自己翻 `hidden`：叠层时 Esc 要
   * 一次退一层（先关这个弹窗，再关抽屉），而「哪一层最后打开」只有 dialog 记录得
   * 到。`proxies-close`（取消 / 遮罩）仍然走本模块的 `closeModal`，把编辑目标一并
   * 清掉——直接点关闭键时两条路都要收尾。
   */
  var FORM_ID = "proxies-form";

  /** 最近一次取到的表。`null` = 还没取到（账号页的下拉据此决定能不能列全）。*/
  var rows = null;
  /** `accounts.risk.defaultProxy`；没配时是 `undefined`。*/
  var defaultProxy = undefined;
  /** 正在进行的取数（`init` 与进账号页各调一次，靠它合并）。*/
  var pending = null;
  /** 弹窗的编辑目标；`null` = 新建。*/
  var editing = null;

  /**
   * 抽屉的内容容器（`page-tail.html` 的 `proxies-drawer-body`）。
   *
   * 表 / 横幅 / 空态都挂在这块里，所以查找先收在它里面；找不到时回落到全文档——
   * 新建 / 编辑弹窗与二次确认不在抽屉体内（它们是模块级的浮层，排在 page-tail 末尾，
   * 文档序才保证确认框盖在最上层）。`mountProxiesDrawer(container)` 的参数因此
   * 真的决定「抽屉」的范围，而不是一个只为签名好看的装饰。
   */
  var root = null;

  /** 先找抽屉体内，再回落到全文档。*/
  function byRole(role) {
    var selector = "[" + C.ROLE_ATTR + '="' + role + '"]';
    if (root) {
      var scoped = root.querySelector(selector);
      if (scoped) return scoped;
    }
    return document.querySelector(selector);
  }

  /** 同 {@link byRole}，但只写文本（找不到就什么也不做）。*/
  function setText(role, text) {
    var node = byRole(role);
    if (node) node.textContent = text;
  }

  /* ---- 给其它视图用的读口 ---------------------------------------------- */

  /** 已知的代理名；`null` = 还没取到。*/
  function names() {
    if (rows === null) return null;
    return rows.map(function (row) {
      return row.name;
    });
  }

  /** 下拉里一项的文案：直连用翻译后的词，代理用名字（名字是用户自己起的）。*/
  function optionLabel(name) {
    return name === C.DIRECT_PROXY ? t("proxy.direct") : name;
  }

  /** 此刻生效出口是这条代理的账号 label（确认文案与概览告警共用同一套分组）。*/
  function accountsUsing(name) {
    var state = App.state.lastState;
    var labels = [];
    if (!state || !state.accounts) return labels;
    for (var i = 0; i < state.accounts.length; i++) {
      if ((state.accounts[i].proxy || C.DIRECT_PROXY) === name) labels.push(state.accounts[i].label);
    }
    return labels;
  }

  /* ---- 取数与应答 ------------------------------------------------------ */

  function load() {
    if (pending !== null) return pending;
    pending = App.api.sendControl({ cmd: "listProxies" }).then(function (body) {
      pending = null;
      if (!body) {
        showError(t("error." + C.NETWORK_ERROR_CODE));
        return null;
      }
      if (!body.ok) {
        showError(errorText(body.error ? body.error : C.NETWORK_ERROR_CODE));
        return null;
      }
      adopt(body);
      return null;
    });
    return pending;
  }

  /** 把一份应答里的整张表接过来并重画（写命令的成功应答也是这个形状）。*/
  function adopt(body) {
    rows = Array.isArray(body.proxies) ? body.proxies : [];
    defaultProxy = body.defaultProxy;
    showError(null);
    render();
    /* 账号页的代理列与概览的分组读的是这份缓存，所以表一变就让它们重画一次。
       这里不会再发命令（`render` 只读 `rows`），因此没有回环。*/
    if (App.state.lastState) App.renderState(App.state.lastState);
  }

  /* ---- 表格 ------------------------------------------------------------ */

  /** 启停状态标签（二值化：停用也是异常一端，色统一红，文字不变）。 */
  function statusTag(row) {
    return row.enabled
      ? { text: t("proxies.status.enabled"), className: "tag tag--ok" }
      : { text: t("proxies.status.disabled"), className: "tag tag--danger" };
  }

  function buildRow(row) {
    var tr = document.createElement("tr");
    tr.setAttribute("data-proxy", row.name);

    /* 名称：默认出口在名字后面补一句，否则「谁在走它」要靠数一列才看得出来 */
    var nameCell = document.createElement("td");
    nameCell.appendChild(create("span", null, row.name));
    if (row.name === defaultProxy) nameCell.appendChild(create("span", "tag tag--accent", t("proxies.default")));
    tr.appendChild(nameCell);

    var urlCell = document.createElement("td");
    urlCell.appendChild(create("span", "mono", row.url));
    /* 密码只回答「有没有」：编辑框里它是空的，用户要知道自己配过什么得看这一行 */
    if (row.hasPassword) urlCell.appendChild(create("span", "faint", " " + t("proxies.hasPassword")));
    tr.appendChild(urlCell);

    var status = statusTag(row);
    var statusCell = document.createElement("td");
    statusCell.appendChild(create("span", status.className, status.text));
    tr.appendChild(statusCell);

    var usedCell = document.createElement("td");
    usedCell.className = "num";
    usedCell.appendChild(
      create("span", null, row.usedBy === 0 ? t("proxies.usedBy.none") : t("proxies.usedBy", { count: row.usedBy })),
    );
    tr.appendChild(usedCell);

    /* 操作列挂 `col-actions`（`--layout-actions-col` 定宽），行内按钮走行内
       控件档 `btn--sm`（28px）——三张带操作列的表（账号 / keys / 代理）现在同宽同高。 */
    var actionsCell = document.createElement("td");
    actionsCell.className = "col-actions";
    var actions = create("div", "cell-actions");
    actions.appendChild(
      button(t("proxies.edit"), "btn btn--sm", function () {
        openModal(row);
      }),
    );
    actions.appendChild(
      button(t(row.enabled ? "proxies.disable" : "proxies.enable"), "btn btn--sm", function () {
        requestToggle(row);
      }),
    );
    actions.appendChild(
      button(t("proxies.delete"), "btn btn--sm", function () {
        requestRemove(row);
      }),
    );
    actionsCell.appendChild(actions);
    tr.appendChild(actionsCell);

    return tr;
  }

  function render() {
    var body = byRole("proxies-body");
    var table = byRole("proxies-table");
    var empty = byRole("proxies-empty");
    if (!body || rows === null) return;
    clear(body);
    setHidden(empty, rows.length > 0);
    setHidden(table, rows.length === 0);
    for (var i = 0; i < rows.length; i++) body.appendChild(buildRow(rows[i]));
  }

  /* ---- 启停与删除 ------------------------------------------------------ */

  /**
   * 停用（或重新启用）一条代理。
   *
   * 停用一条仍被引用的代理会让那些账号的下一个请求直接报错（`egressFor` 拒绝回落），
   * 所以要先把受影响的账号列出来问一次。启用不需要确认。
   */
  function requestToggle(row) {
    if (row.enabled === false) {
      send({ cmd: "setProxy", name: row.name, enabled: true }, null);
      return;
    }
    var affected = accountsUsing(row.name);
    if (affected.length === 0) {
      send({ cmd: "setProxy", name: row.name, enabled: false }, null);
      return;
    }
    App.confirm.open({
      title: t("proxies.disable.title", { name: row.name }),
      text: t("proxies.disable.text", { accounts: affected.join(", ") }),
      warn: t("proxies.disable.warn"),
      danger: true,
      run: function () {
        send({ cmd: "setProxy", name: row.name, enabled: false }, null);
      },
    });
  }

  /**
   * 删除一条代理。
   *
   * 被引用时服务端拒绝（`proxy_in_use`），只有确认之后才带 `force` 再发一次：force
   * 会把那些账号改回默认出口，应答里的 `detached` 就是要告诉用户的那件事。
   */
  function requestRemove(row) {
    var affected = accountsUsing(row.name);
    App.confirm.open({
      title: t("proxies.delete.title", { name: row.name }),
      text:
        affected.length > 0
          ? t("proxies.delete.inUse", { accounts: affected.join(", ") })
          : t("proxies.delete.text"),
      warn: affected.length > 0 ? t("proxies.delete.warn", { count: affected.length }) : undefined,
      danger: true,
      run: function () {
        send({ cmd: "removeProxy", name: row.name, force: affected.length > 0 }, function (body) {
          if (body.detached && body.detached.length > 0) {
            showNotice(t("proxies.notice.detached", { accounts: body.detached.join(", ") }));
          }
        });
      },
    });
  }

  /* ---- 新建 / 编辑 ----------------------------------------------------- */

  function openModal(row) {
    editing = row === undefined ? null : row;
    setText("proxies-modal-title", t(editing ? "proxies.edit.title" : "proxies.add.title"));
    var name = byRole("proxies-name");
    var url = byRole("proxies-url");
    var username = byRole("proxies-username");
    var password = byRole("proxies-password");
    var clearPassword = byRole("proxies-clear-password");
    showModalError(null);
    if (name) {
      name.value = editing ? editing.name : "";
      /* 名字是引用键（账号与默认出口都按它找），改名等于换一条代理，不做隐式重命名 */
      name.disabled = editing !== null;
    }
    if (url) url.value = editing ? editing.url.replace(/\*\*\*/, "") : "";
    if (username) username.value = "";
    if (password) password.value = "";
    if (clearPassword) clearPassword.checked = false;
    /* 「清除密码」只对真的设过密码的代理有意义 */
    setHidden(byRole("proxies-clear-row"), !(editing && editing.hasPassword));
    App.widgets.dialog.open(FORM_ID);
    if (name && !editing) name.focus();
  }

  function closeModal() {
    editing = null;
    App.widgets.dialog.close(FORM_ID);
    showModalError(null);
  }

  function fieldValue(role) {
    var node = byRole(role);
    return node ? node.value.trim() : "";
  }

  function submitModal() {
    var name = editing ? editing.name : fieldValue("proxies-name");
    var url = fieldValue("proxies-url");
    if (!name) {
      showModalError(t("proxies.error.nameRequired"));
      return Promise.resolve();
    }
    if (!url && !editing) {
      showModalError(t("proxies.error.urlRequired"));
      return Promise.resolve();
    }

    var cmd;
    if (editing) {
      cmd = { cmd: "setProxy", name: name };
      /* 打码过的地址回填过弹窗，用户没改就不发：把 `***` 当密码写回去会把代理弄坏 */
      if (url && url !== editing.url.replace(/\*\*\*/, "")) cmd.url = url;
      appendSecret(cmd, "username", fieldValue("proxies-username"));
      var password = fieldValue("proxies-password");
      var clearPassword = byRole("proxies-clear-password");
      if (password) cmd.password = password;
      else if (clearPassword && clearPassword.checked) cmd.password = "";
    } else {
      cmd = { cmd: "addProxy", name: name, url: url };
      appendSecret(cmd, "username", fieldValue("proxies-username"));
      appendSecret(cmd, "password", fieldValue("proxies-password"));
    }

    return send(cmd, function () {
      closeModal();
      showNotice(t(editing ? "proxies.notice.saved" : "proxies.notice.added", { name: name }));
    });
  }

  /** 认证字段留空 = 保持原值（服务端把空串当「清掉」，所以这里不发空串）。*/
  function appendSecret(cmd, key, value) {
    if (value) cmd[key] = value;
  }

  /* ---- 命令出口 -------------------------------------------------------- */

  /**
   * 发一条写命令。
   *
   * 成功应答里就有整张新表，所以这里不重取，直接用应答重画；`onOk` 在
   * `adopt` 之前跑，因为它可能要关掉弹窗。
   */
  function send(cmd, onOk) {
    return App.api.sendControl(cmd).then(function (body) {
      if (!body) {
        showError(t("error." + C.NETWORK_ERROR_CODE));
        return null;
      }
      if (!body.ok) {
        showError(errorText(body.error ? body.error : C.NETWORK_ERROR_CODE));
        return null;
      }
      showNotice(null);
      if (onOk) onOk(body);
      if (Array.isArray(body.proxies)) adopt(body);
      return null;
    });
  }

  /* ---- 横幅 ------------------------------------------------------------ */

  function showError(text) {
    var banner = byRole("proxies-error");
    if (!banner) return;
    setHidden(banner, text === null);
    setText("proxies-error-text", text === null ? "" : text);
  }

  function showModalError(text) {
    var node = byRole("proxies-modal-error");
    if (!node) return;
    node.textContent = text === null ? "" : text;
    setHidden(node, text === null);
  }

  function showNotice(text) {
    var banner = byRole("proxies-notice");
    if (!banner) return;
    setHidden(banner, text === null);
    setText("proxies-notice-text", text === null ? "" : text);
  }

  /** 名字框的 Enter 提交。绑定一次就够：`mountProxiesDrawer` 会被反复调用。*/
  function bindControls() {
    var name = byRole("proxies-name");
    if (!name || name.getAttribute("data-enter-bound") === "1") return;
    name.setAttribute("data-enter-bound", "1");
    name.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        submitModal();
      }
    });
  }

  /* ---- 抽屉 ------------------------------------------------------------ */

  /**
   * 把代理字典挂到账号页的抽屉上（`page-tail.html` 的 `proxies-drawer-body`）。
   *
   * 这只是换挂载方式，渲染函数（列表 / 增删改 / 启停 / 受影响账号）整体保留：
   * 抽屉开着的时候它是一张可管理的表，关着的时候它只是 `rows` 这份缓存，账号页的
   * 代理列与概览的共用出口分组照旧读 {@link names} / {@link optionLabel}。
   *
   * 每次打开都重发一次 `listProxies`（`load` 的 `pending` 合并并发）：字典表不在
   * 轮询载荷里，打开这一幕就是唯一该拿到新表的时刻。
   */
  function mountProxiesDrawer(container) {
    root = container || root;
    bindControls();
    App.widgets.dialog.open(DRAWER_ID);
    render();
    return load();
  }

  /*
   * 模块级的读口与命令出口。
   *
   * 为什么挂在 `App.proxies` 而不是 `App.views.proxies`：它已经没有视图了（没有
   * `data-view` 容器、没有 `/proxies` 路径、不参与 `applyView` 的取数分支）。
   * 账号表格、批量条与概览横幅仍按老名字读 `names()` / `optionLabel()`——那几个
   * 读口与写命令的口径没变，只是宿主从「视图注册表」挪到了独立命名空间。
   */
  App.proxies = {
    load: load,
    render: render,
    mountProxiesDrawer: mountProxiesDrawer,
    names: names,
    optionLabel: optionLabel,
    bindControls: bindControls,
    actions: {
      "proxies-open-add": function () {
        openModal(undefined);
      },
      "proxies-close": closeModal,
      "proxies-submit": submitModal,
      "proxies-dismiss-error": function () {
        showError(null);
      },
    },
  };
})(window.__zcodeApp = window.__zcodeApp || {});
