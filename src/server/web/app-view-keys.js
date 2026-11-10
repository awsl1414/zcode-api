/*
 * app-view-keys.js — API key 页：数据面凭据的列表、创建、启停与吊销。
 *
 * 数据不走 `/api/state`：key 表只有在人看这一页时才需要，把它塞进每 5 秒一次的轮询
 * 载荷会让每个开着面板的浏览器都不停地搬运一份与它无关的表。所以这一页用控制命令
 * `listApiKeys` 自己取，动作之后重取一次（与 `/api/state` 的「不做本地乐观更新」同一
 * 条规矩，只是数据源换成了命令应答）。
 *
 * 创建流程的模态是「填名字 → 显示完整 key 一次 → 复制 → 关闭」；但那
 * 不是拿到明文的唯一机会（服务端存的是加密后的密文，`listApiKeys` 解密带回），
 * 模态的提示语随之简化——列表里随时可以再显示 / 复制。
 *
 * 掩码显示：Key 列默认 `sk-zcp-a1b2••••••••`，行内「显示 / 隐藏」切换完整值
 * （等宽字体），「复制」走 `navigator.clipboard` + toast 确认；剪贴板不可用（非
 * 安全上下文）就退化成「展开并选中」，用户按一次 Ctrl/Cmd+C（与创建模态 / 添加
 * 账号的降级同一套）。5.0 契约：每条记录必有可解密的 secret，Key 列恒为
 * 「掩码 + 显示 / 复制」两态（损坏记录由服务端丢弃，不会进列表）。
 *
 * 行内控件：操作列三件套（状态徽章 / 归零 / 删除）统一 28px 一档、组内 8px；
 * 启停从 40×22 的开关换成可点的状态徽章——表格行里的开关既没有标签（不知道它控制
 * 什么），与两个 36px 按钮同排时基线也对不上。徽章同时承担「显示状态」与「切换」，
 * 所以表里没有独立的「状态」列：一行里两处说同一件事是重复。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var byRole = App.dom.byRole;
  var setText = App.dom.setText;
  var setHidden = App.dom.setHidden;
  var create = App.dom.create;
  var clear = App.dom.clear;
  var button = App.dom.button;
  var t = App.i18n.t;
  var formatCompact = App.format.compact;

  /** 最近一次 `listApiKeys` 的结果。`null` = 还没取到。*/
  var rows = null;

  /* ---- 掩码 / 显示 ------------------------------------------------------- */

  /**
   * 掩码的形状：前缀（`sk-zcp-` + 4 个随机字符）+ 8 颗圆点。前缀足够认出
   * 「这是我笔记本那个还是 CI 那个」，圆点表示后面还有 43 个字符没有画出来。
   */
  var MASK_TAIL = "••••••••";

  /** 本页生存期内被展开的 key（id → true）。整表重建时读它，刷新后回到掩码态。*/
  var revealed = {};

  /* ---- 相对时间 -------------------------------------------------------- */

  var MINUTE_MS = C.SECONDS_PER_MINUTE * 1000;
  var HOUR_MS = C.SECONDS_PER_HOUR * 1000;
  var DAY_MS = C.SECONDS_PER_DAY * 1000;

  /** 「最后使用」：刚刚 / N 分钟前 / N 小时前 / N 天前。从未用过时说「从未」。*/
  function relativeTime(at) {
    if (typeof at !== "number" || !Number.isFinite(at)) return t("keys.never");
    var delta = Date.now() - at;
    if (delta < MINUTE_MS) return t("keys.relative.now");
    if (delta < HOUR_MS) return t("keys.relative.minutes", { count: Math.floor(delta / MINUTE_MS) });
    if (delta < DAY_MS) return t("keys.relative.hours", { count: Math.floor(delta / HOUR_MS) });
    return t("keys.relative.days", { count: Math.floor(delta / DAY_MS) });
  }

  /* ---- 表格 ------------------------------------------------------------ */

  function usageOf(record) {
    return record.usage || {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      errors: 0,
      lastUsedAt: null,
      todayRequests: 0,
      todayDate: "",
    };
  }

  /**
   * 这把 key 的请求日志地址：跳日志页的请求事件 tab，并把 key 筛选器
   * 带上（app-view-logs.js 的 `enter` 消费）。与统计视图 key 维度行的跳转是
   * 同一条链路（任务把 keys 页的跳转并入本批）。
   */
  function logsHref(keyId) {
    return (
      C.ROUTE_PATH_LOGS +
      "?" + C.LOGS_TAB_QUERY_KEY + "=" + C.LOG_TAB_REQUESTS +
      "&" + C.LOGS_KEY_QUERY_KEY + "=" + encodeURIComponent(keyId)
    );
  }

  function buildRow(record) {
    var usage = usageOf(record);
    var row = document.createElement("tr");
    row.setAttribute("data-api-key", record.id);

    var nameCell = document.createElement("td");
    nameCell.appendChild(create("span", null, record.name));
    nameCell.appendChild(create("span", "faint mono", " " + record.id));
    row.appendChild(nameCell);

    /* Key 列：掩码 + 显示 / 复制。刻意不用 `.cell-actions`——那是操作列
       的钩子（运行时测试按「第一个 .cell-actions」定位操作列），这里用自己的
       `.key-cell`（同一套 28px / 8px 对齐口径）。5.0 契约：记录必有 secret
       （服务端丢弃损坏记录），此处无第三态。 */
    var keyCell = document.createElement("td");
    var keyGroup = create("div", "key-cell");
    keyGroup.appendChild(create("span", "mono key-cell__value", revealed[record.id] ? record.secret : String(record.prefix) + MASK_TAIL));
    keyGroup.appendChild(
      button(t(revealed[record.id] ? "keys.hide" : "keys.show"), "btn btn--sm", function () {
        revealed[record.id] = !revealed[record.id];
        renderKeys();
      }),
    );
    keyGroup.appendChild(
      button(t("keys.copy"), "btn btn--sm", function () {
        copyRecordKey(record);
      }),
    );
    keyCell.appendChild(keyGroup);
    row.appendChild(keyCell);

    var todayCell = document.createElement("td");
    todayCell.className = "num";
    /* 今日 / 累计两个用量数字都链去日志页带 key 筛选：数字是入口，
       下一步动作（看这些请求长什么样）在日志页。 */
    var todayLink = create("a", "link num", formatCompact(usage.todayRequests));
    todayLink.href = logsHref(record.id);
    todayLink.title = t("keys.jumpHint");
    todayCell.appendChild(todayLink);
    row.appendChild(todayCell);

    /* 累计：四个数字用「·」串成一行时，1000px 窗口里这一格比面板还宽，
       把整张表顶出横向滚动条。所以拆成两行塔——请求数一行、token 明细一行——同一格
       窄掉三分之一，行高从 45 涨到约 64px（与账号页额度列的两行塔同一套记法）。 */
    var totalCell = create("td", "num faint");
    var totalLink = create("a", "link usage-tower");
    totalLink.href = logsHref(record.id);
    totalLink.title = t("keys.jumpHint");
    totalLink.appendChild(create("span", null, t("keys.usage.requests", { requests: formatCompact(usage.requests) })));
    totalLink.appendChild(
      create(
        "span",
        "usage-tower__more",
        t("keys.usage.tokens", {
          input: formatCompact(usage.inputTokens),
          output: formatCompact(usage.outputTokens),
          errors: formatCompact(usage.errors),
        }),
      ),
    );
    totalCell.appendChild(totalLink);
    row.appendChild(totalCell);

    var lastUsedCell = document.createElement("td");
    lastUsedCell.className = "faint";
    lastUsedCell.textContent = relativeTime(usage.lastUsedAt);
    row.appendChild(lastUsedCell);

    var actionsCell = create("td", "col-actions");
    var actions = create("div", "cell-actions");
    actions.appendChild(buildEnabledBadge(record));
    var reset = button(t("keys.resetUsage"), "btn btn--sm", function () {
      runCommand({ cmd: "resetApiKeyUsage", id: record.id }, "keys.notice.resetUsage", record.name);
    });
    /* 按钮文案只剩「归零」两个字（与「删除」同宽就不再显得笨重），补全说明进 title。*/
    reset.title = t("keys.resetUsage.title");
    actions.appendChild(reset);
    actions.appendChild(
      button(t("keys.delete"), "btn btn--sm btn--danger-quiet", function () {
        openDeleteModal(record);
      }),
    );
    actionsCell.appendChild(actions);
    row.appendChild(actionsCell);

    return row;
  }

  /**
   * 状态徽章：显示当前状态，点一下切换。
   *
   * 停用不是删除：关掉立刻 401，但 key 还在，名字与用量都保留。样式与出口代理表
   * 的状态列同一套 `tag--ok` / `tag--danger`（二值化：停用也是异常一端，色统一红）。
   */
  /** 行节点（复制降级路径要选中完整值）。id 是十六进制，可以安全拼进选择器。*/
  function rowOf(id) {
    var body = byRole("keys-body");
    return body ? body.querySelector('[data-api-key="' + id + '"] .key-cell__value') : null;
  }

  /**
   * 复制完整 key：优先 `navigator.clipboard` + toast 确认；不可用（或拒
   * 了权限）就展开该行并选中完整值，用户按一次 Ctrl/Cmd+C。两条路给的是同一段
   * 文本，没有必要再弹一个错误框。
   */
  function copyRecordKey(record) {
    var done = function () {
      App.widgets.toast.show({ text: t("keys.copy.copied"), durationMs: C.TOAST_NOTICE_MS });
    };
    var clipboard = window.navigator ? window.navigator.clipboard : null;
    if (clipboard && typeof clipboard.writeText === "function") {
      clipboard.writeText(record.secret).then(done, function () {
        selectRecordKey(record);
      });
      return;
    }
    selectRecordKey(record);
  }

  /** 剪贴板不可用时的降级：展开该行 + 选中完整值文本（添加账号链接的同一套）。*/
  function selectRecordKey(record) {
    revealed[record.id] = true;
    renderKeys();
    var node = rowOf(record.id);
    if (node) {
      try {
        var range = document.createRange();
        range.selectNodeContents(node);
        var selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
      } catch {
        /* 选不中也无所谓：完整值就在单元格里，用户自己拖选 */
      }
    }
    App.widgets.toast.show({ text: t("keys.copy.selectHint"), durationMs: C.TOAST_NOTICE_MS });
  }

  function buildEnabledBadge(record) {
    var enabled = record.enabled === true;
    var badge = button(
      t(enabled ? "keys.status.enabled" : "keys.status.disabled"),
      "tag tag--toggle " + (enabled ? "tag--ok" : "tag--danger"),
      function () {
        runCommand(
          { cmd: "setApiKeyEnabled", id: record.id, enabled: !enabled },
          enabled ? "keys.notice.disabled" : "keys.notice.enabled",
          record.name,
        );
      },
    );
    badge.setAttribute("aria-pressed", enabled ? "true" : "false");
    badge.title = t(enabled ? "keys.status.toggle.disable" : "keys.status.toggle.enable");
    return badge;
  }

  function renderKeys() {
    var body = byRole("keys-body");
    var table = byRole("keys-table");
    var empty = byRole("keys-empty");
    if (!body || rows === null) return;
    clear(body);
    setHidden(empty, rows.length > 0);
    setHidden(table, rows.length === 0);
    for (var i = 0; i < rows.length; i++) body.appendChild(buildRow(rows[i]));
  }

  /* ---- 取数与命令 ------------------------------------------------------ */

  function loadKeys() {
    return App.api.sendControl({ cmd: "listApiKeys" }).then(function (body) {
      if (!body) return null;
      if (!body.ok) {
        showError(App.i18n.errorText(body.error || C.NETWORK_ERROR_CODE));
        return null;
      }
      rows = Array.isArray(body.apiKeys) ? body.apiKeys : [];
      showError(null);
      renderKeys();
      return null;
    });
  }

  /**
   * 发一条命令并在成功后重取列表。
   *
   * `noticeKey` 有值就在横幅里说一句；`name` 是插值变量（用户认得出是哪把 key）。
   */
  function runCommand(cmd, noticeKey, name) {
    return App.api.sendControl(cmd).then(function (body) {
      if (!body) {
        showError(App.i18n.errorText(C.NETWORK_ERROR_CODE));
        return null;
      }
      if (!body.ok) {
        showError(App.i18n.errorText(body.error || C.NETWORK_ERROR_CODE));
        return null;
      }
      if (noticeKey) showNotice(t(noticeKey, { name: name || "" }));
      return loadKeys();
    });
  }

  /* ---- 创建 ------------------------------------------------------------ */

  /** 创建模态的 `data-dialog` id（开合 / Esc / 焦点归还都由 dialog 层管）。*/
  var CREATE_DIALOG_ID = "keys-create";

  function openCreateModal() {
    setHidden(byRole("keys-create-form"), false);
    setHidden(byRole("keys-create-result"), true);
    setHidden(byRole("keys-copy"), true);
    setHidden(byRole("keys-create-error"), true);
    var submit = byRole("keys-submit-create");
    if (submit) setHidden(submit, false);
    var input = byRole("keys-create-name");
    if (input) input.value = "";
    App.widgets.dialog.open(CREATE_DIALOG_ID, {
      /* 名称框是这个模态唯一要填的东西，焦点直接落上去，不用先 Tab 过一遍页脚。 */
      initial: function () {
        return byRole("keys-create-name");
      },
      /* Esc / 遮罩与「关闭」同一条路：连内存里那份明文一起清掉。 */
      onDismiss: closeCreateModal,
    });
  }

  function closeCreateModal() {
    setCreateBusy(false);
    /* 关掉弹窗后不再保留创建应答里的明文；之后页面上的明文都来自 `listApiKeys`
       的解密路径，这条内存里的副本没有存在的理由。 */
    var keyField = byRole("keys-create-key");
    if (keyField) keyField.value = "";
    setHidden(byRole("keys-create-result"), true);
    setHidden(byRole("keys-create-form"), false);
    App.widgets.dialog.close(CREATE_DIALOG_ID);
  }

  /**
   * 创建键的在途态：飞着的时候禁用，防连点建出两把 key（`createApiKey` 没有
   * 幂等键，第二次就是另一把）。
   */
  function setCreateBusy(busy) {
    var submit = byRole("keys-submit-create");
    if (!submit) return;
    submit.disabled = busy;
    if (busy) submit.setAttribute("aria-busy", "true");
    else submit.removeAttribute("aria-busy");
  }

  /** 提交创建：成功后切到「显示一次完整 key」的状态。*/
  function submitCreate() {
    var input = byRole("keys-create-name");
    var name = input ? input.value.trim() : "";
    if (!name) {
      showCreateError(t("keys.create.nameRequired"));
      return Promise.resolve();
    }

    setCreateBusy(true);
    return App.api
      .sendControl({ cmd: "createApiKey", name: name })
      .then(function (body) {
        if (!body) {
          showCreateError(App.i18n.errorText(C.NETWORK_ERROR_CODE));
          return null;
        }
        if (!body.ok) {
          showCreateError(App.i18n.errorText(body.error || C.NETWORK_ERROR_CODE));
          return null;
        }

        setHidden(byRole("keys-create-error"), true);
        setHidden(byRole("keys-create-form"), true);
        setHidden(byRole("keys-create-result"), false);
        setHidden(byRole("keys-copy"), false);
        var submit = byRole("keys-submit-create");
        if (submit) setHidden(submit, true);

        var keyField = byRole("keys-create-key");
        if (keyField) keyField.value = body.key || "";
        showNotice(t("keys.notice.created", { name: name }));
        return loadKeys();
      })
      .then(function () {
        setCreateBusy(false);
        return null;
      });
  }

  /**
   * 复制完整 key。
   *
   * `navigator.clipboard` 在非安全上下文（http + 非回环）里不存在，那就退化成
   * 「选中输入框里的内容」：用户按一次 Ctrl/Cmd+C 也能拿到，比什么都不做好。
   */
  function copyKey() {
    var keyField = byRole("keys-create-key");
    if (!keyField || !keyField.value) return;
    var done = function () {
      showNotice(t("keys.create.copied"));
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(keyField.value).then(done, function () {
          selectKeyField(keyField);
        });
        return;
      }
    } catch {
      /* 剪贴板不可用：走下面的选中路径 */
    }
    selectKeyField(keyField);
  }

  function selectKeyField(keyField) {
    try {
      keyField.focus();
      keyField.select();
    } catch {
      /* 选不中也无所谓：文本就在输入框里，用户自己拖选 */
    }
    showNotice(t("keys.create.selectHint"));
  }

  /* ---- 删除 ------------------------------------------------------------ */

  /**
   * 删除走通用二次确认模态：删除即吊销，用它的客户端下一个请求就 401，
   * 所以要说清楚「影响哪个程序」而不是只问「确定吗」。
   */
  function openDeleteModal(record) {
    App.confirm.open({
      title: t("keys.delete.title", { name: record.name }),
      text: t("keys.delete.text"),
      warn: t("keys.delete.warn"),
      danger: true,
      run: function () {
        runCommand({ cmd: "deleteApiKey", id: record.id }, "keys.notice.deleted", record.name);
      },
    });
  }

  /* ---- 横幅 ------------------------------------------------------------ */

  function showError(text) {
    var banner = byRole("keys-error");
    if (!banner) return;
    setHidden(banner, text === null);
    setText("keys-error-text", text === null ? "" : text);
  }

  function showNotice(text) {
    var banner = byRole("keys-notice");
    if (!banner) return;
    setHidden(banner, text === null);
    setText("keys-notice-text", text === null ? "" : text);
  }

  function showCreateError(text) {
    var node = byRole("keys-create-error");
    if (!node) return;
    node.textContent = text;
    setHidden(node, text === null);
  }

  function bindControls() {
    var input = byRole("keys-create-name");
    if (input) {
      /* 回车即提交：这个框只有一个字段。*/
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          submitCreate();
        }
      });
    }
  }

  App.views.keys = {
    load: loadKeys,
    render: renderKeys,
    /* 顶栏刷新：key 表不在 `/api/state` 的轮询载荷里，重拉就是重发
       `listApiKeys`（与进视图 / 命令成功后同一条路）。 */
    refresh: loadKeys,
    bindControls: bindControls,
    actions: {
      "keys-create": openCreateModal,
      "keys-close-create": closeCreateModal,
      "keys-submit-create": submitCreate,
      "keys-copy": copyKey,
      "keys-dismiss-error": function () {
        showError(null);
      },
    },
  };
})(window.__zcodeApp = window.__zcodeApp || {});
