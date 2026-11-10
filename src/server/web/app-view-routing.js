/*
 * app-view-routing.js — 路由策略页：选号顺序、分行的调度策略、队列与
 * 粘性参数、风控开关（后三组收进 CollapsibleSection，标题行带当前值的
 * 摘要），以及只读的「账号 × 路由」矩阵。
 *
 * 写入统一走 `setRoutingPolicy` 一条命令，分组只是补丁的形状（`routing` /
 * `stickiness` / `risk`），服务端按段合并。
 *
 * 数字控件非法时先拒并回滚显示，不发命令：一次往返换一个红条不如当场说清楚。回滚
 * 靠的是重画整页，所以这里要用最近一次 `/api/state` 载荷，不能用输入框里的值。
 *
 * 两处 UI 纪律：
 *   - 折叠区（队列 / 粘性 / 风控）的开合状态在 `App.widgets` 的模块级 Map，每拍
 *     轮询重渲染后调 `App.widgets.apply()` 投影回来；摘要文案由本视图按**当前
 *     表单值**拼，改值后立刻联动（不等下一拍）。
 *   - 摘要读 DOM 控件值而不是 state：渲染时控件刚按 state 回填，两者一致；用户
 *     改值时 change 处理器里再刷一次，摘要跟着输入框走。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var state = App.state;
  var byRole = App.dom.byRole;
  var create = App.dom.create;
  var clear = App.dom.clear;
  var button = App.dom.button;
  var t = App.i18n.t;
  var forms = App.forms;

  /* ---- 选号顺序 -------------------------------------------------------- */

  /** 顺序列表：上移 / 下移 / 移除（拖拽还没做，现在按钮就够）。*/
  function renderOrder(routing) {
    var list = byRole("routing-order");
    if (!list) return;
    clear(list);

    for (var i = 0; i < routing.order.length; i++) {
      list.appendChild(buildOrderItem(routing.order.length, i, routing.order[i]));
    }
  }

  function buildOrderItem(length, index, name) {
    var item = create("li", "order-item");
    item.appendChild(create("span", "order-item__index", String(index + 1)));
    item.appendChild(create("span", "order-item__name", name));
    /* 档位徽章：第一项「优先」用主题色，其余中性。
       徽章贴着路由名（序号 + 路由名 + 徽章一组），按钮组单独靠右。 */
    item.appendChild(create("span", rankBadgeClass(index), rankLabel(length, index)));
    /* 三颗按钮收进 order-item__actions（组内间距 8px，整体靠右），
       不再逐个拍在行上——见 components.css 的紧凑排布注释。
     *
     * 「移除」在下界（只剩一条）时直接禁用，与权重步进器到 1 时禁用 `−` 同一判据：
     * 点得动、点了才报错，是让用户用一次失败学习一条静态规则。
     * `removeOrder` 里的守卫保留着——它是服务端同口径的最后一道（命令面也能被
     * 别处的调用触达）。 */
    var actions = create("span", "order-item__actions");
    actions.appendChild(
      button(t("routing.order.up"), "btn", function () {
        moveOrder(index, -1);
      }),
    );
    actions.appendChild(
      button(t("routing.order.down"), "btn", function () {
        moveOrder(index, 1);
      }),
    );
    var remove = button(t("routing.order.remove"), "btn", function () {
      removeOrder(index);
    });
    remove.disabled = length <= 1;
    if (remove.disabled) remove.title = t("routing.order.last");
    actions.appendChild(remove);
    item.appendChild(actions);
    return item;
  }

  /**
   * 顺序标签：第一项「优先」、最后一项「兜底」、中间「降级」
   * 单元素时它就是唯一一项，标「优先」。
   */
  function rankLabel(length, index) {
    if (index === 0) return t("routing.order.priority");
    if (index === length - 1) return t("routing.order.fallback");
    return t("routing.order.degrade");
  }

  /** 徽章配色：只有「优先」用主题色（参考图的形态），兜底 / 降级保持中性。*/
  function rankBadgeClass(index) {
    return index === 0 ? "status-badge status-badge--accent" : "status-badge";
  }

  function moveOrder(index, delta) {
    var order = state.lastState.routing.order;
    var target = index + delta;
    /* 边界：不在合法位置就不发命令（首项不能再上移）*/
    if (target < 0 || target >= order.length) return;
    var next = order.slice();
    var moved = next[index];
    next[index] = next[target];
    next[target] = moved;
    App.api.dispatch({ cmd: "setRoutingPolicy", routing: { order: next } });
  }

  /**
   * 把一档从顺序里移除：`setRoutingPolicy` 接受更短的 order（服务端只要求非空且
   * 都是合法路由），所以这是既有命令面里的既有能力，不需要新命令。空顺序服务端
   * 会拒（`invalid_routing_order`），页面同口径先拒，顺手说清楚为什么。
   */
  function removeOrder(index) {
    var order = state.lastState.routing.order;
    if (order.length <= 1) {
      App.api.showActionError(t("routing.order.last"));
      return;
    }
    var next = order.slice();
    next.splice(index, 1);
    App.api.dispatch({ cmd: "setRoutingPolicy", routing: { order: next } });
  }

  /* ---- 折叠区摘要 -------------------------------------------------------- */

  /** 摘要里的字段标签走一套短键（表单行里的全称带单位，摘要是另一回事）。*/
  function summaryPart(label, value) {
    return label + " " + value;
  }

  /** 数值控件的当前显示值；空串（还没回填）按 0 处理，下一拍会重画。*/
  function numberValue(role) {
    var input = byRole(role);
    var value = input ? Number(input.value) : 0;
    return isFinite(value) ? value : 0;
  }

  /** 下拉的当前显示文案（用选项文字，不用枚举值：摘要给人读）。*/
  function selectLabel(role) {
    var select = byRole(role);
    if (!select || select.selectedIndex < 0) return "";
    return select.options[select.selectedIndex].text;
  }

  /** 队列区摘要：等待上限 N · 队列深度 N · 全局并发上限 N。*/
  function queueSummaryText() {
    return [
      summaryPart(t("routing.summary.queueTimeout"), numberValue("routing-queueTimeoutMs")),
      summaryPart(t("routing.summary.maxQueue"), numberValue("routing-maxQueue")),
      summaryPart(t("routing.summary.maxTotalInflight"), numberValue("routing-maxTotalInflight")),
    ].join(" · ");
  }

  /** 粘性区摘要：已停用时打头，之后 TTL / 会话上限 / 饱和时策略。*/
  function stickinessSummaryText() {
    var enabledInput = byRole("stickiness-enabled");
    var parts = [];
    if (enabledInput && !enabledInput.checked) parts.push(t("routing.summary.disabled"));
    parts.push(
      summaryPart(t("routing.summary.ttl"), numberValue("stickiness-ttlSeconds")),
      summaryPart(t("routing.summary.maxSessions"), numberValue("stickiness-maxSessions")),
      summaryPart(t("routing.summary.onSaturated"), selectLabel("stickiness-onSaturated")),
    );
    return parts.join(" · ");
  }

  /** 风控区摘要：心跳抖动：开启 / 关闭（冒号在键里，英文用半角）。*/
  function riskSummaryText() {
    var input = byRole("risk-jitterHeartbeat");
    return t("routing.summary.risk", { state: t(input && input.checked ? "routing.summary.on" : "routing.summary.off") });
  }

  /** 三个摘要一起刷：渲染收尾与每个控件 change 后各调一次。*/
  function updateSummaries() {
    var queue = byRole("routing-queue-summary");
    if (queue) queue.textContent = queueSummaryText();
    var stickiness = byRole("routing-stickiness-summary");
    if (stickiness) stickiness.textContent = stickinessSummaryText();
    var risk = byRole("routing-risk-summary");
    if (risk) risk.textContent = riskSummaryText();
  }

  /* ---- 渲染 ------------------------------------------------------------ */

  function renderRouting(routing, stickiness, riskPolicy, accounts) {
    renderOrder(routing);    forms.setSelectValue("routing-mode", routing.mode);
    forms.setSelectValue("routing-strategy", routing.strategy);
    forms.setSelectValue("routing-saturated", routing.onSaturated);
    forms.setSelectValue("routing-drained", routing.onDrained);
    forms.setSelectValue("routing-authfailed", routing.onAuthFailed);
    forms.setNumberValue("routing-queueTimeoutMs", routing.queueTimeoutMs);
    forms.setNumberValue("routing-maxQueue", routing.maxQueue);
    forms.setNumberValue("routing-maxTotalInflight", routing.maxTotalInflight);
    forms.setChecked("stickiness-enabled", stickiness.enabled);
    forms.setNumberValue("stickiness-ttlSeconds", stickiness.ttlSeconds);
    forms.setNumberValue("stickiness-maxSessions", stickiness.maxSessions);
    forms.setSelectValue("stickiness-onSaturated", stickiness.onSaturated);
    forms.setNumberValue("stickiness-overflowAfterMs", stickiness.overflowAfterMs);
    /* 风控开关（accounts.risk）：只有 jitterHeartbeat 进了配置面。
       理由是 proxyPerAccount 的代理层还没落地，没有消费者的开关是伪配置。*/
    forms.setChecked("risk-jitterHeartbeat", riskPolicy.jitterHeartbeat);
    renderMatrix(routing, accounts);
    renderBreakers();
    /* 摘要随表单值联动；折叠状态跨轮询持久（验收硬项）：本页的折叠区壳是
       静态 DOM，这里仍然投影一次，壳被外层重写时也不会丢状态。 */
    updateSummaries();
    App.widgets.apply();
  }

  /**
   * 账号 × 路由矩阵：只读。
   *
   * 列分两组：账号身份（账号名 + 账号类型）与路由能力（✓/—）。路由列 =
   * 账号路由的并集 ∪ `routing.order`（顺序先按 order，再按 `ROUTE_KINDS` 补全），
   * 这样即使某个路由没出现在 order 里（账号收窄白名单后才会有）也不会少一列。
   * 「账号类型」不来自 routes：主标签是 `AccountSummary.provider`（zai / bigmodel），
   * 补充一行是 `kind`（凭据出身）；两者都是 `/api/state` 透出的真实字段，不猜分类。
   */
  function matrixColumns(routing, accounts) {
    var columns = [];
    var i;
    var j;
    for (i = 0; i < routing.order.length; i++) {
      if (columns.indexOf(routing.order[i]) < 0) columns.push(routing.order[i]);
    }
    for (i = 0; i < accounts.length; i++) {
      for (j = 0; j < accounts[i].routes.length; j++) {
        if (columns.indexOf(accounts[i].routes[j]) < 0) columns.push(accounts[i].routes[j]);
      }
    }
    columns.sort(function (a, b) {
      return C.ROUTE_KINDS.indexOf(a) - C.ROUTE_KINDS.indexOf(b);
    });
    return columns;
  }

  /** 类型词：provider 是协议里的二值枚举，缺值时露协议值而不是猜一个分类。*/
  function accountType(account) {
    var provider = account.provider || "—";
    var label = t("routing.matrix.provider." + provider);
    return label === "routing.matrix.provider." + provider ? provider : label;
  }

  /** 身份列的内层盒子：`<td>` 不能 `display: flex`（会从表格布局里掉出来）。*/
  function accountTypeCell(account) {
    var cell = document.createElement("td");
    cell.className = "matrix__type";
    var stack = create("div", "cell-stack");
    stack.appendChild(create("span", "tag", accountType(account)));
    /* 凭据出身只在账号大窗 / ⋯ 菜单里有完整解释；这里一行小字补足类型的另一半，
       不把 JWT-only 的能力说明搬进矩阵（那是账号表的事，会把矩阵撑成账号表）。*/
    stack.appendChild(create("span", "faint matrix__kind", t("kind." + account.kind)));
    cell.appendChild(stack);
    return cell;
  }

  function renderMatrix(routing, accounts) {
    var head = byRole("routing-matrix-head");
    var body = byRole("routing-matrix-body");
    var empty = byRole("routing-matrix-empty");
    var table = byRole("routing-matrix");
    if (!head || !body) return;
    clear(head);
    clear(body);

    App.dom.setHidden(empty, accounts.length > 0);
    App.dom.setHidden(table, accounts.length === 0);
    /* 矩阵空态带下一步：这一句「还没有账号」在概览摘要里是第三次出现，前两处
       已经给了入口，这里同样给。空态节点是静态 DOM，按钮只
       追加一次（每拍重建会让键盘焦点在空态上丢失）。 */
    renderMatrixEmptyAction(empty, accounts.length);

    var columns = matrixColumns(routing, accounts);
    var headRow = document.createElement("tr");
    /* 运行时拼的表头同样带 scope：静态表由 X2 补齐，矩阵每拍重建，漏了就又
       只剩读屏器猜列归属。三个固定列与动态路由列一视同仁。 */
    function headCell(className, label) {
      var th = create("th", className, label);
      th.setAttribute("scope", "col");
      return th;
    }
    headRow.appendChild(headCell("matrix__account-head", t("routing.matrix.account")));
    headRow.appendChild(headCell("matrix__type-head", t("routing.matrix.type")));
    for (var c = 0; c < columns.length; c++) headRow.appendChild(headCell("matrix__route-head mono", columns[c]));
    head.appendChild(headRow);

    for (var i = 0; i < accounts.length; i++) {
      var row = document.createElement("tr");
      row.appendChild(create("td", "matrix__account", accounts[i].label));
      row.appendChild(accountTypeCell(accounts[i]));
      for (var j = 0; j < columns.length; j++) {
        var allowed = accounts[i].routes.indexOf(columns[j]) >= 0;
        row.appendChild(
          create("td", "matrix__route " + (allowed ? "matrix__yes" : "matrix__no"), t(allowed ? "routing.matrix.yes" : "routing.matrix.no")),
        );
      }
      body.appendChild(row);
    }
  }

  /**
   * 矩阵空态里的「去账号页」链接。
   *
   * 链接不是按钮：它只改变位置（整页导航到 `/accounts`），不写任何东西。
   */
  function renderMatrixEmptyAction(empty, count) {
    if (!empty || count > 0) return;
    var action = empty.querySelector('[data-role="routing-matrix-empty-action"]');
    if (!action) {
      action = create("a", "empty-inline__link", t("ui.empty.routingMatrix.action"));
      action.setAttribute("data-role", "routing-matrix-empty-action");
      action.href = C.ROUTE_PATH_ACCOUNTS;
      empty.appendChild(document.createTextNode(" "));
      empty.appendChild(action);
    }
    action.textContent = t("ui.empty.routingMatrix.action");
  }

  /**
   * 路由级熔断指示。
   *
   * 数据来自 `/api/state.health.breakers`（`HealthEngine.onTransition` 的结构化
   * 快照）。熔断是路由级状态、与账号 × 路由矩阵的 ✓/— 正交，所以独占一段而不是
   * 往矩阵里加列；没熔断时整段隐藏（没有数据就不占地方）。
   * 退避窗口显示的是「失败翻了几档」，真实到期时刻留在引擎里（页面不猜时钟）。
   */
  function renderBreakers() {
    var panel = byRole("routing-breaker-panel");
    var list = byRole("routing-breaker-list");
    if (!panel || !list) return;
    clear(list);
    var observation = state.lastState && state.lastState.health;
    var breakers = observation && observation.breakers ? observation.breakers : [];
    App.dom.setHidden(panel, breakers.length === 0);
    for (var i = 0; i < breakers.length; i++) {
      var breaker = breakers[i];
      var row = create("div", "detail__item");
      row.appendChild(create("span", "mono", breaker.route));
      row.appendChild(create("span", "status-badge status-badge--danger",
        t("routing.breaker.status." + breaker.status)));
      row.appendChild(create("span", "faint", t("routing.breaker.backoff", { count: breaker.probeBackoffs })));
      row.appendChild(create("span", "faint", t("routing.breaker.openedAt", { time: App.format.dateTime(breaker.openedAt) })));
      list.appendChild(row);
    }
  }

  /* ---- 控件绑定 -------------------------------------------------------- */

  function bindRoutingControls() {
    var fieldMap = [
      ["routing-mode", "routing", "mode"],
      ["routing-strategy", "routing", "strategy"],
      ["routing-saturated", "routing", "onSaturated"],
      ["routing-drained", "routing", "onDrained"],
      ["routing-authfailed", "routing", "onAuthFailed"],
      ["stickiness-onSaturated", "stickiness", "onSaturated"],
    ];
    var i;
    for (i = 0; i < fieldMap.length; i++) {
      bindSelect(fieldMap[i][0], fieldMap[i][1], fieldMap[i][2]);
    }

    var numberMap = [
      ["routing-queueTimeoutMs", "routing", "queueTimeoutMs", "routing.queueTimeoutMs.title"],
      ["routing-maxQueue", "routing", "maxQueue", "routing.maxQueue.title"],
      ["routing-maxTotalInflight", "routing", "maxTotalInflight", "routing.maxTotalInflight.title"],
      ["stickiness-ttlSeconds", "stickiness", "ttlSeconds", "routing.stickiness.ttlSeconds"],
      ["stickiness-maxSessions", "stickiness", "maxSessions", "routing.stickiness.maxSessions"],
      ["stickiness-overflowAfterMs", "stickiness", "overflowAfterMs", "routing.stickiness.overflowAfterMs"],
    ];
    for (i = 0; i < numberMap.length; i++) {
      bindNumber(numberMap[i][0], numberMap[i][1], numberMap[i][2], numberMap[i][3]);
    }

    bindSwitch("stickiness-enabled", "stickiness", "enabled");
    bindSwitch("risk-jitterHeartbeat", "risk", "jitterHeartbeat");
  }

  function bindSelect(role, section, field) {
    var select = byRole(role);
    if (!select) return;
    select.addEventListener("change", function () {
      var patch = {};
      patch[field] = select.value;
      applyPolicy(section, patch);
    });
  }

  function bindNumber(role, section, field, labelKey) {
    var input = byRole(role);
    if (!input) return;
    input.addEventListener("change", function () {
      var next = Number(input.value);
      if (!forms.isNonNegativeInteger(next)) {
        App.api.showActionError(t("routing.invalidNumber", { field: t(labelKey) }));
        App.renderState(state.lastState);
        return;
      }
      var patch = {};
      patch[field] = next;
      applyPolicy(section, patch);
    });
  }

  function bindSwitch(role, section, field) {
    var input = byRole(role);
    if (!input) return;
    input.addEventListener("change", function () {
      var patch = {};
      patch[field] = input.checked;
      applyPolicy(section, patch);
    });
  }

  function applyPolicy(section, patch) {
    var cmd = { cmd: "setRoutingPolicy" };
    cmd[section] = patch;
    App.api.dispatch(cmd);
    /* 摘要跟着输入框走：命令还在路上时摘要先动，服务端拒绝会重画回真值。 */
    updateSummaries();
  }

  /**
   * 顶栏刷新：这一页的输入就是 `/api/state` 里的 `routing` / `stickiness` /
   * `risk` 三段，重拉那份载荷就等于重读当前策略（命令成功后的回读也走这条路）。
   */
  function refresh() {
    return App.api.refresh();
  }

  App.views.routing = { render: renderRouting, refresh: refresh, bindControls: bindRoutingControls };
})(window.__zcodeApp = window.__zcodeApp || {});
