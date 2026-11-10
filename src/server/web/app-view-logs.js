/*
 * app-view-logs.js — 日志页：两个 tab、过滤、暂停、请求记录的
 * 取数与分页、导出，以及两套 tab 的编排。
 *
 * 页面分两个 tab，各有一个渲染模块，本文件只做编排与两者共享的状态：
 *
 *   系统     一行行日志（`log` 事件）→ `app-logs-system-stream.js`：行缓冲、
 *            结构化四列、重复行折叠、连接状态。
 *   请求事件 `RequestRecord` 表格 → `app-logs-request-table.js`：十四列、行内展开、
 *            阶段时间线、表尾「加载更早」。
 *
 * 留在这里的是这张页面上「两侧共享」的那一半：
 *
 *   编排      `App.views.logs` 的导出面（`app.js` 的视图切换与事件绑定入口）、
 *            tab 切换、`enter` 的跳转参数消费。
 *   暂停     一个开关管两个 tab；暂停只停渲染，两边的缓冲都照旧收。
 *   请求记录  数据从哪来、怎么去重、怎么翻页——四条路：
 *              初始加载  `getRequests` 控制命令（进 tab 时拉一次全量）
 *              增量      `request` 事件（`app-sse.js` 转发进来，按 reqId 去重）
 *              历史      「加载更早」：`getRequestsHistory` 从 requests.jsonl
 *                        倒序分页读，结果追加在表尾；JSONL 与内存同源（最近 200
 *                        条两边都有），按 reqId 双向去重
 *              `/api/state` 不参与——它不含请求记录
 *
 * 过滤 / 暂停 / 搜索全部在客户端做：服务端没有
 * 必要为每个页面的过滤条件再扫一遍缓冲区。
 *
 * 系统日志的四个过滤维度是账号 / 级别 / 模块 / 文本。前三者在服务端写的
 * **字段**上比较（`account` / `level` / `mod`），搜索才看行文本：字段比较不会误命中
 * ——搜一个账号名不会连出别的账号那条提到的它。
 *
 * 请求事件的过滤维度是状态 / 账号 / 路由 / 模型 / key / 阶段加一个文本搜索：
 * 账号 / 模型 / key 的下拉选项从**已见记录聚合**（服务端没有「已知清单」可
 * 给，与模块下拉同一思路），路由是稳定枚举，状态按「全部 / 2xx / 4xx / 5xx / 进行中 /
 * 错误」六档，文本搜索子串匹配 reqId / 模型 / 账号 / 路由 / key / 错误。
 *
 * 两条容易搞错的状态：
 *
 *   暂停只停渲染。暂停期间收到的行照旧进缓冲，恢复后一次性补齐，所以事件流不用为
 *   暂停做任何特殊处理。两个 tab 共享同一个暂停开关。
 *   缓冲跨视图保留。离开日志页再回来，刚才的行还在；重画由视图切换负责。清空只清
 *   当前 tab 的视图缓冲（系统：日志行；请求：记录数组），服务端的 `LogBuffer` /
 *   `RequestStore` 都不动。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var byRole = App.dom.byRole;
  var setHidden = App.dom.setHidden;
  var create = App.dom.create;
  var clear = App.dom.clear;
  var t = App.i18n.t;
  var buildOption = App.forms.buildOption;

  /** 两个渲染模块（它们在 `APP_MODULES` 里排在本文件之前）。*/
  var stream = App.logsStream;
  var table = App.logsRequests;
  /** 一个过滤控件的当前值（DOM 就是真值：测试与用户走同一条路径）。*/
  var filterValue = table.filterValue;

  /** 暂停中收到的行不丢：暂停只停渲染，恢复后一次性补齐。*/
  var logsPaused = false;
  /** 当前 tab（`logs.tab.*` 的键后缀）。切 tab 共享过滤器区的位置，各 tab 一套控件。*/
  var activeTab = C.DEFAULT_LOG_TAB;

  /* ---- 请求事件的状态 --------------------------------------------------- */

  /**
   * 已收到的请求记录，新的在前，上限 `REQUEST_ROW_LIMIT`。
   *
   * 元素就是 SSE 帧解析出来的 `RequestRecord`（服务端原样 JSON），渲染时
   * 直接读字段，不做聚合——面板的请求事件 tab 就是这些事件的直接消费面。
   */
  var requestRecords = [];
  /** 按 reqId 的去重索引：重连后 SSE 可能重放同一条，初始加载也可能与增量重叠。*/
  var requestIndex = {};
  /** 请求 tab 是否已经做过初始加载（一次全量，之后靠增量）。*/
  var requestsLoaded = false;
  /**
   * 请求 tab 的六个下拉（状态 / 阶段 / 账号 / 路由 / 模型 / key）的选项快照，按 role
   * 存：选项来自已见记录，集合变了才重建（重建会把用户的选择冲掉）。
   */
  var reqOptionSnapshots = {};

  /**
   * 外部跳转带来的 key 筛选：统计视图的 key 维度行与 keys 页的用量数字
   * 都以 `/logs?tab=requests&key=<id|none>` 的形式带参进来。真值先落在模块变量
   * 里，选中态在每次选项重建时都被钉回去（记录还没进来时下拉里没有这个值，
   * 不能只设一次 select.value——下一拍重建就会把它冲掉）。用户手动改过下拉
   * 之后作废（消费一次）。
   */
  var externalKeyFilter = null;
  /**
   * 外部带来的状态 / 阶段筛选：概览页的错误数卡跳 `status=error`，
   * 错误数卡下方的阶段分布跳 `stage=<stage>`。两者与 `externalKeyFilter`
   * 同一套纪律：真值住模块变量，选项重建后钉回去；用户自己改下拉就作废。
   *
   * 与 key 不同的是状态下拉的选项是**静态枚举**（`initSelects` 里填），页面
   * 启动的时序是「先 applyView（这里读参数）后 applyLanguage（那里填选项）」，
   * 所以 enter 时写 `select.value` 会被后面的重建冲掉——只能靠每次 render 时钉。
   */
  var externalStatusFilter = null;
  var externalStageFilter = null;

  /**
   * 历史段（requests.jsonl 分页读回的记录），新的在前，上限 `REQUESTS_HISTORY_ROW_LIMIT`。
   *
   * 与内存段（`requestRecords`）分两段存：内存段有 SSE 增量与原地替换，历史段只在
   * 分页时追加。渲染先内存段后历史段，两段各自时间倒序、页按时间递减追加，整表
   * 倒序。两段之间按 reqId 双向去重（JSONL 里也有最近 200 条，与内存同源）。
   */
  var historyRecords = [];
  /** 历史段按 reqId 的索引（与 `requestIndex` 同一套账，去重双向查）。*/
  var historyIndex = {};
  /** 分页状态：null = 还没翻过页；false = 服务端说没有更早的（按钮收起）。*/
  var historyHasMore = null;
  var historyLoading = false;
  /**
   * 下一页的游标（`getRequestsHistory` 的 `before`）；null = 从最新开始。
   *
   * 正常情况下每次翻页后重算为两段缓冲里最早一条的 startedAt；一页拉回来全是
   * 重复（同毫秒并列组比 limit 还大时会发生）就减一毫秒强制推进——那种组里没被
   * 拉到的成员只能放弃，但按钮不能卡死。
   */
  var historyCursor = null;
  /** 清空缓冲会让在途的分页应答作废：代数不匹配就丢弃。*/
  var historyLoadSeq = 0;

  /* ---- 系统日志：过滤与重画 ---------------------------------------------- */

  /**
   * 连接状态与暂停按钮的文案。
   *
   * 暂停按钮在两个 tab 的工具栏里各有一份（`log-pause` / `req-pause`），一起落；
   * 两者都是运行时写的文本（不在 `data-i18n` 的静态文案里），语言切换后要重落一遍。
   * 连接状态的两个 DOM 节点归 `app-logs-system-stream.js`（状态住在那边）。
   */
  function renderControls() {
    var roles = ["log-pause", "req-pause"];
    for (var i = 0; i < roles.length; i++) {
      var button = byRole(roles[i]);
      if (button) button.textContent = t(logsPaused ? "logs.resume" : "logs.pause");
    }
    setHidden(byRole("log-paused"), !logsPaused);
    stream.renderConnection();
  }

  /* ---- tab 切换 --------------------------------------------------------- */

  /**
   * 切 tab：切换 tab 的选中态、各 tab 自己的过滤器行与内容面板。
   *
   * 过滤器区在两个 tab 之间共享同一个位置，
   * 每边显示自己的一套控件。首次落到请求事件 tab 时做一次初始加载。
   */
  function selectTab(tab) {
    if (C.LOG_TABS.indexOf(tab) < 0) return;
    activeTab = tab;
    var tabs = document.querySelectorAll("[data-log-tab]");
    for (var i = 0; i < tabs.length; i++) {
      var active = tabs[i].getAttribute("data-log-tab") === tab;
      tabs[i].className = active ? "tab tab--active" : "tab";
      /* 与统计页 / 添加账号同一套 tab 契约：`role="tab"` 在静态 DOM 上，
         这里只翻 `aria-selected`（`aria-selected="false"` 也是有意义的声明）。*/
      tabs[i].setAttribute("aria-selected", active ? "true" : "false");
    }
    setHidden(byRole("log-filters-system"), tab !== "system");
    setHidden(byRole("log-filters-requests"), tab !== "requests");
    setHidden(byRole("log-panel-system"), tab !== "system");
    setHidden(byRole("log-panel-requests"), tab !== "requests");
    if (tab === C.LOG_TAB_REQUESTS && !requestsLoaded) loadRequests();
    render();
  }

  /** 当前 tab 是不是请求事件（渲染入口用它分派）。*/
  function onRequestsTab() {
    return activeTab === C.LOG_TAB_REQUESTS;
  }

  /**
   * 进页面时消费跳转参数：`?tab=requests` 落到请求事件 tab；
   * `?key=<id|none>` 钉住 key 筛选器；`?status=<桶|error>` 钉住状态筛选器；
   * `?stage=<stage>` 钉住阶段筛选器。三个筛选参数都顺带切到请求 tab——
   * 它们只对那张表有意义。参数在系统里没有对应记录时也照钉：选项聚合会把它
   * 注进去（见 syncRequestFilterOptions），表空只是「这条 key / 阶段的记录还
   * 没被拉到」（内存仓只有最近 200 条，更早的在 JSONL 里，点「加载更早」会到）。
   *
   * app.js 的 showView 在进日志页时调一次；本页没有客户端视图切换，
   * 一次消费就够。地址参数不擦除：回退 / 刷新落到同样的筛选，是期望行为。
   */
  function enter() {
    /* 先按 activeTab 重放一次 tab 显隐：请求事件是默认 tab，静态 DOM 里的
       过滤器行 / 面板已经与它一致，但初始加载只有 selectTab 会触发——进页面这
       一拍就把 getRequests 发出去，而不是等用户点一下已经选中的 tab。selectTab
       幂等：请求 tab 已加载过就不会重发，系统 tab 只是重画。 */
    selectTab(activeTab);
    var search = window.location.search;
    if (!search) return;
    var params = new URLSearchParams(search);
    var key = params.get(C.LOGS_KEY_QUERY_KEY);
    if (key) externalKeyFilter = key;
    var status = params.get(C.LOGS_STATUS_QUERY_KEY);
    if (status && C.REQUEST_STATUS_FILTERS.indexOf(status) >= 0) externalStatusFilter = status;
    var stage = params.get(C.LOGS_STAGE_QUERY_KEY);
    if (stage) externalStageFilter = stage;
    var tab = params.get(C.LOGS_TAB_QUERY_KEY);
    var pinned = externalKeyFilter !== null || externalStatusFilter !== null || externalStageFilter !== null;
    if ((tab === C.LOG_TAB_REQUESTS || pinned) && activeTab !== C.LOG_TAB_REQUESTS) {
      selectTab(C.LOG_TAB_REQUESTS);
    }
    /* 切 tab 是幂等的：已经是请求 tab 时 selectTab 不跑，钉入的筛选得自己落一次。 */
    applyExternalFilters();
  }

  /** 一条日志是否通过当前三重字段过滤（账号 / 级别 / 模块）加文本搜索。*/
  function logMatches(entry) {
    var account = filterValue("log-account", C.LOG_ACCOUNT_ALL);
    if (account !== C.LOG_ACCOUNT_ALL && entry.account !== account) return false;

    var level = filterValue("log-level", C.LOG_LEVEL_ALL);
    if (level !== C.LOG_LEVEL_ALL && entry.level !== level) return false;

    var mod = filterValue("log-mod", C.LOG_MOD_ALL);
    if (mod !== C.LOG_MOD_ALL && entry.mod !== mod) return false;

    var needle = filterValue("log-search", "").trim().toLowerCase();
    if (needle && entry.line.toLowerCase().indexOf(needle) < 0) return false;
    return true;
  }

  /** 重画当前 tab（重画比增量维护简单且不会跑偏）。*/
  function render() {
    if (onRequestsTab()) {
      renderRequests(false);
      return;
    }
    /* 先过过滤器再游程编码：折叠是显示层的事，过滤器选中什么就折叠什么。 */
    var entries = stream.entries();
    var visible = [];
    for (var i = 0; i < entries.length; i++) {
      if (logMatches(entries[i])) visible.push(entries[i]);
    }
    stream.render(visible);
  }

  /** 暂停 / 继续：恢复时把暂停期间缓冲的行一次性补上。*/
  function togglePaused() {
    logsPaused = !logsPaused;
    renderControls();
    if (!logsPaused) render();
  }

  /**
   * 清空当前 tab 的视图缓冲（服务端的 `LogBuffer` / `RequestStore` 是别人的日志，
   * 不归页面管）。请求 tab 清完之后 `requestsLoaded` 保持 true：下一次全量要等
   * 用户重开日志页，本会话内只靠增量。历史段一并清空，代数 +1 让在途
   * 的分页应答作废，按钮回到初始态。
   */
  function clearLogs() {
    if (onRequestsTab()) {
      requestRecords = [];
      requestIndex = {};
      historyRecords = [];
      historyIndex = {};
      historyHasMore = null;
      historyLoading = false;
      historyCursor = null;
      historyLoadSeq += 1;
      table.resetExpanded();
      renderRequests(false);
      return;
    }
    stream.clear();
    render();
  }

  /**
   * 系统日志的四个过滤控件：任一变化就重画（不过滤数据，只改哪些行可见）。
   *
   * `input` 与 `change` 都挂：搜索框边打边筛靠 `input`，下拉靠 `change`。
   */
  function bindFilters() {
    var search = byRole("log-search");
    if (search) search.addEventListener("input", render);

    var roles = ["log-account", "log-level", "log-mod"];
    for (var i = 0; i < roles.length; i++) {
      var select = byRole(roles[i]);
      if (select) select.addEventListener("change", render);
    }

    bindRequestFilters();
  }

  /** 系统 tab 收一行（SSE 的 `log` 帧）：入缓冲，没暂停且停在系统 tab 就重画。*/
  function append(entry) {
    stream.append(entry);
    if (!logsPaused && !onRequestsTab()) render();
  }

  /* ---- 请求事件：初始加载 / 增量 ----------------------------------------- */

  /**
   * 初始加载：`getRequests` 拉一次全量（新的在前）。
   *
   * 只在首次落到请求事件 tab 时跑一次；之后的新请求靠 SSE 的 `request` 事件进。
   * 失败不报横幅：控制面的命令失败翻不出更多信息，空状态已经说了
   * 「还没有请求」，下一拍事件到了自然会补上。
   */
  function loadRequests() {
    requestsLoaded = true;
    return App.api.sendControl({ cmd: "getRequests", limit: C.REQUESTS_LOAD_LIMIT }).then(function (body) {
      if (!body || !body.ok || body.event !== "requests" || !Array.isArray(body.records)) return;
      requestRecords = [];
      requestIndex = {};
      /* `recent()` 给的就是新的在前，顺序原样收下 */
      for (var i = 0; i < body.records.length; i++) insertRequest(body.records[i]);
      renderRequests(false);
    });
  }

  /**
   * 收一条请求记录（SSE `request` 事件）。
   *
   * 按 `reqId` 去重：重连后服务端可能重放同一条（内存 store 的 onChange 只推新
   * 记录，但初始加载与增量之间没有顺序保证），已存在的就用新版本**原地替换**——
   * 同一 reqId 的后到版本字段更全（收尾那次才带 status / totalMs）。
   * 超出容量挤掉最旧的（与服务端 `REQUEST_STORE_CAPACITY` 同口径）。
   */
  function appendRequest(record) {
    if (!record || typeof record.reqId !== "string") return;
    var existing = requestIndex[record.reqId];
    if (existing !== undefined) {
      requestRecords[existing] = record;
    } else if (historyIndex[record.reqId] !== undefined) {
      /* 历史段里已有这条（SSE 重连重放）：内存段不再入一份。*/
      return;
    } else {
      requestRecords.unshift(record);
      /* 重算索引比逐项搬移简单：容量 200，一拍一次不值得省 */
      rebuildRequestIndex();
      if (requestRecords.length > C.REQUEST_ROW_LIMIT) requestRecords.length = C.REQUEST_ROW_LIMIT;
    }
    if (logsPaused || !onRequestsTab()) return;
    renderRequests(false);
  }

  function rebuildRequestIndex() {
    requestIndex = {};
    for (var i = 0; i < requestRecords.length; i++) requestIndex[requestRecords[i].reqId] = i;
  }

  /** 上面两条入口共用的落位：初始加载按顺序灌，增量走去重。*/
  function insertRequest(record) {
    if (!record || typeof record.reqId !== "string" || requestIndex[record.reqId] !== undefined) return;
    requestIndex[record.reqId] = requestRecords.length;
    requestRecords.push(record);
  }

  /* ---- 请求历史分页：加载更早 -------------------------------------------- */

  /**
   * 两段缓冲里最早一条的 `startedAt`，作为下一页的游标；两段都空回 null。
   *
   * 用「缓冲里最早」而不是「已渲染最早」：过滤器藏住的行也已经在缓冲里，游标取
   * 渲染后的最早一条会让那些行之间的记录永远翻不到（换个过滤器就是空洞）。
   */
  function oldestBufferedStartedAt() {
    var oldest = null;
    for (var i = 0; i < requestRecords.length; i++) {
      if (oldest === null || requestRecords[i].startedAt < oldest) oldest = requestRecords[i].startedAt;
    }
    for (var j = 0; j < historyRecords.length; j++) {
      if (oldest === null || historyRecords[j].startedAt < oldest) oldest = historyRecords[j].startedAt;
    }
    return oldest;
  }

  /**
   * 翻一页历史。结果追加在历史段尾部（表格的时间倒序延续）；游标上的记录服务端
   * 会重发（同毫秒并列不丢），靠 reqId 去重。加载中禁点；`hasMore: false` 之后
   * 按钮收起。
   */
  function loadRequestHistory() {
    if (historyLoading || historyHasMore === false) return;
    var seq = historyLoadSeq;
    historyLoading = true;
    renderRequests(false);

    var command = { cmd: "getRequestsHistory", limit: C.REQUESTS_HISTORY_PAGE_LIMIT };
    /* 游标跟着缓冲走（两段里最早一条）；historyCursor 只是回退覆盖：一页拉回来
       全是重复（同毫秒并列组比 limit 大）时缓冲游标推不动，减一毫秒硬进——那种
       组里没拉到的成员只能放弃，按钮不能卡死。*/
    var buffered = oldestBufferedStartedAt();
    var cursor = historyCursor !== null && (buffered === null || historyCursor < buffered) ? historyCursor : buffered;
    historyCursor = null;
    if (cursor !== null) command.before = cursor;
    App.api.sendControl(command).then(function (body) {
      historyLoading = false;
      /* 清空（或新一轮翻页）已经作废了这次应答：只恢复按钮，不落行。*/
      if (seq !== historyLoadSeq) {
        renderRequests(false);
        return;
      }
      if (!body || !body.ok || body.event !== "requestsHistory" || !Array.isArray(body.requests)) {
        renderRequests(false);
        return;
      }
      var freshCount = 0;
      for (var i = 0; i < body.requests.length; i++) {
        if (insertHistoryRecord(body.requests[i])) freshCount += 1;
      }
      historyHasMore = body.hasMore === true;
      if (freshCount === 0 && cursor !== null) historyCursor = cursor - 1;
      renderRequests(false);
    });
  }

  /**
   * 历史段落位：与内存段按 reqId 双向去重（同一条只在表格出现一次）。
   * 返回是否真的新增了（调用方统计去重后的增量，驱动游标推进）。
   */
  function insertHistoryRecord(record) {
    if (!record || typeof record.reqId !== "string") return false;
    if (requestIndex[record.reqId] !== undefined || historyIndex[record.reqId] !== undefined) return false;
    historyIndex[record.reqId] = historyRecords.length;
    historyRecords.push(record);
    if (historyRecords.length > C.REQUESTS_HISTORY_ROW_LIMIT) {
      /* 超限丢最旧的（数组尾）：索引重建比逐项搬移简单，与内存段同一笔账。*/
      historyRecords.length = C.REQUESTS_HISTORY_ROW_LIMIT;
      rebuildHistoryIndex();
    }
    return true;
  }

  function rebuildHistoryIndex() {
    historyIndex = {};
    for (var i = 0; i < historyRecords.length; i++) historyIndex[historyRecords[i].reqId] = i;
  }

  /* ---- 请求 tab 的聚合下拉 ---------------------------------------------- */

  /**
   * 一个聚合下拉的重建：选项来自已经收到的记录，集合变了才重建（重建会把用户的
   * 选择冲掉）。
   *
   * 快照按 role 存在同一个对象里：几个下拉共用一套「签名比对 → 重建 → 保留选中」
   * 的纪律，一个函数就够，不需要几份变量与几次拷贝。`seen` 是这一维的取值集合
   * （账号 / 模型 / key 从记录聚合，路由用稳定枚举），顺序取首次出现顺序；
   * 「全部」这一项的文案进了签名，语言切换时才会重建。
   */
  function syncRequestOptions(role, allValue, allLabelKey, seen, optionLabel) {
    var signature = t(allLabelKey) + "\u0000" + seen.join("\u0000");
    var current = reqOptionSnapshots[role] || [];
    if (signature === current.join("\u0000")) return;
    reqOptionSnapshots[role] = [t(allLabelKey)].concat(seen);

    var select = byRole(role);
    if (!select) return;
    var previous = select.value;
    clear(select);
    select.appendChild(buildOption(allValue, t(allLabelKey)));
    /* optionLabel 缺省 = 原值直出（技术标识不翻译）；key 维度用它给
     * 「无归因」上文案（A2 接线），真实 key id 仍原样展示。 */
    for (var i = 0; i < seen.length; i++) {
      select.appendChild(buildOption(seen[i], optionLabel ? optionLabel(seen[i]) : seen[i]));
    }
    /* 选中的值还在就保留，不在了就回到「全部」 */
    select.value = seen.indexOf(previous) >= 0 ? previous : allValue;
  }

  /**
   * 重算请求 tab 的六个下拉。账号 / 模型从记录聚合（内存段 + 历史段：历史
   * 里的账号/模型也要筛得到）；路由是稳定枚举（与 `ROUTE_KINDS` 同源，技术
   * 标识不翻译）；key 把没归因的记录聚合成一个「无归因」选项（`REQUEST_KEY_NONE`）；
   * 阶段是已见记录里出现过的 `failedStage`。
   *
   * 外部跳转带来的 key 筛选（`externalKeyFilter`）在选项集合里注入——记录
   * 还没拉到时下拉里没有它，不注入的话选中态会被重建成「全部」；注入之后每次
   * 重建都把值钉回去，直到用户自己改下拉（change 监听里作废）。
   */
  function syncRequestFilterOptions() {
    var accounts = [];
    /* 模型：占位 `-` 也是一条真实记录的模型值（UNKNOWN_MODEL），照常可筛。 */
    var models = [];
    var keys = [];
    var hasUnattributed = false;
    function collect(record) {
      if (record.account && accounts.indexOf(record.account) < 0) accounts.push(record.account);
      if (record.model && models.indexOf(record.model) < 0) models.push(record.model);
      if (record.apiKeyId) {
        if (keys.indexOf(record.apiKeyId) < 0) keys.push(record.apiKeyId);
      } else {
        hasUnattributed = true;
      }
    }
    for (var i = 0; i < requestRecords.length; i++) collect(requestRecords[i]);
    for (var j = 0; j < historyRecords.length; j++) collect(historyRecords[j]);
    if (hasUnattributed) keys.push(C.REQUEST_KEY_NONE);
    if (externalKeyFilter !== null && keys.indexOf(externalKeyFilter) < 0) keys.push(externalKeyFilter);

    syncRequestOptions("req-account", C.REQUEST_ACCOUNT_ALL, "logs.requests.account.all", accounts);
    syncRequestOptions("req-route", C.REQUEST_ROUTE_ALL, "logs.requests.route.all", C.ROUTE_KINDS);
    syncRequestOptions("req-model", C.REQUEST_MODEL_ALL, "logs.requests.model.all", models);
    /* 「无归因」是聚合保留值，展示文案走 i18n，原始值 `none` 只留在 value 里。 */
    syncRequestOptions("req-key", C.REQUEST_KEY_ALL, "logs.requests.key.all", keys, function (value) {
      return value === C.REQUEST_KEY_NONE ? t("logs.requests.key.none") : value;
    });
    /* 阶段：选项就是已见记录里出现过的 `failedStage`，按首现顺序；
       外部带来的阶段（`?stage=`）即使还没记录也注入，否则选中态会被重建成「全部」。*/
    var stages = collectStages();
    if (externalStageFilter !== null && stages.indexOf(externalStageFilter) < 0) stages.push(externalStageFilter);
    syncRequestOptions("req-stage", C.REQUEST_STAGE_ALL, "logs.requests.stage.all", stages);
    applyExternalFilters();
  }

  /** 已见记录里出现过的阶段（`failedStage`），按首现顺序。*/
  function collectStages() {
    var stages = [];
    function collect(record) {
      var stage = record.failedStage;
      if (typeof stage === "string" && stage !== "" && stages.indexOf(stage) < 0) stages.push(stage);
    }
    for (var i = 0; i < requestRecords.length; i++) collect(requestRecords[i]);
    for (var j = 0; j < historyRecords.length; j++) collect(historyRecords[j]);
    return stages;
  }

  /**
   * 把外部带来的三个筛选（key / 状态 / 阶段）钉回各自下拉。
   *
   * 下拉的选项可能被重建（语言切换、记录聚合、`initSelects`），每次重建后选中
   * 态都会回到第一项。这里在每次选项同步之后重写一遍；用户改了下拉就由 change
   * 监听把对应的外部值作废（消费一次，见 `bindRequestFilters`）。
   */
  function applyExternalFilters() {
    if (externalKeyFilter !== null) {
      var keySelect = byRole("req-key");
      if (keySelect) keySelect.value = externalKeyFilter;
    }
    if (externalStatusFilter !== null) {
      var statusSelect = byRole("req-status");
      if (statusSelect) statusSelect.value = externalStatusFilter;
    }
    if (externalStageFilter !== null) {
      var stageSelect = byRole("req-stage");
      if (stageSelect) stageSelect.value = externalStageFilter;
    }
  }

  /**
   * 公开给 `app.js` 的 `initSelectOptions`（启动与语言切换时重建静态选项）：
   * 状态下拉的选项在 `initSelects` 里重建，重建会把选中态冲回第一项，而那一拍
   * 不一定跟着一次 `renderRequests`——所以把「把外部筛选钉回去」这一步单独露出去。
   */
  function syncExternalFilters() {
    applyExternalFilters();
  }

  /* ---- 请求 tab 的渲染与导出 -------------------------------------------- */

  /**
   * 当前过滤器下的记录（渲染与导出共用的唯一一条路）。
   *
   * 两边共用同一个函数是故意的：「导出的内容 = 你在表里看到的行」是用户唯一能验证
   * 的承诺，两份过滤逻辑一拍不合就会导出看不见（或看不到）的行。行数上限也同一份
   * （`REQUEST_ROW_LIMIT` + 历史段），否则导出的文件会比表格多出几千条。
   */
  function visibleRequests() {
    var cap = C.REQUEST_ROW_LIMIT + Math.min(historyRecords.length, C.REQUESTS_HISTORY_ROW_LIMIT);
    var out = [];
    function emit(record) {
      if (out.length >= cap) return;
      if (!table.requestMatches(record)) return;
      out.push(record);
    }
    for (var i = 0; i < requestRecords.length; i++) emit(requestRecords[i]);
    for (var j = 0; j < historyRecords.length; j++) emit(historyRecords[j]);
    return out;
  }

  /**
   * 重画请求表：记录按当前过滤器算好交给表格模块（内存段在前、历史段在后），
   * 并带上「加载更早」那一行的状态（在途 / 有没有更早）。
   *
   * `forceOptions` 让下拉快照作废：语言切换会改「全部」这一项的文案。
   */
  function renderRequests(forceOptions) {
    if (forceOptions) reqOptionSnapshots = {};
    syncRequestFilterOptions();
    table.render(visibleRequests(), {
      loading: historyLoading,
      hasMore: historyHasMore,
      onLoad: loadRequestHistory,
    });
  }

  /** 文件名里的时刻：`20261109-143005`（本地时间，同一天导两次不会撞名）。*/
  function exportStamp(date) {
    function pad(n) {
      return n < 10 ? "0" + n : String(n);
    }
    return (
      date.getFullYear() +
      pad(date.getMonth() + 1) +
      pad(date.getDate()) +
      "-" +
      pad(date.getHours()) +
      pad(date.getMinutes()) +
      pad(date.getSeconds())
    );
  }

  /** 当前过滤条件（写进导出文件：别人拿到切片能知道它是哪一段）。*/
  function exportFilters() {
    return {
      status: filterValue("req-status", C.REQUEST_STATUS_ALL),
      account: filterValue("req-account", C.REQUEST_ACCOUNT_ALL),
      route: filterValue("req-route", C.REQUEST_ROUTE_ALL),
      model: filterValue("req-model", C.REQUEST_MODEL_ALL),
      key: filterValue("req-key", C.REQUEST_KEY_ALL),
      search: filterValue("req-search", ""),
    };
  }

  /**
   * 导出当前筛选结果。
   *
   * 落的是**记录本身**（`RequestRecord` 原样，含 stages）：文件跟下载目录里的
   * `requests.jsonl` 同名同形，拿 `jq` 一套就能用。外面包一层 `exportedAt` /
   * `filters` / `count` 是为了回答「这份文件是什么时候、按什么条件切的」——记录
   * 里没有这两个事实。
   */
  function exportRequests() {
    var records = visibleRequests();
    var payload = {
      exportedAt: new Date().toISOString(),
      filters: exportFilters(),
      count: records.length,
      records: records,
    };
    App.dom.download(
      C.REQUESTS_EXPORT_PREFIX + "-" + exportStamp(new Date()) + ".json",
      JSON.stringify(payload, null, 2),
      C.REQUESTS_EXPORT_MIME,
    );
  }

  /** 请求 tab 的七个过滤控件：与系统 tab 同一套绑定纪律。*/
  function bindRequestFilters() {
    /* 用户手动改 key 下拉 = 外部带来的筛选被接管：此后选项重建不再钉值。
       这个监听必须排在 render 之前：render 里 syncRequestFilterOptions 会把
       externalKeyFilter 钉回下拉，先作废再渲染才能让这次改动生效。
       状态与阶段是同一套「消费一次」的纪律（`?status=` / `?stage=`）。*/
    var keySelect = byRole("req-key");
    if (keySelect) keySelect.addEventListener("change", function () {
      externalKeyFilter = null;
    });
    var statusSelect = byRole("req-status");
    if (statusSelect) statusSelect.addEventListener("change", function () {
      externalStatusFilter = null;
    });
    var stageSelect = byRole("req-stage");
    if (stageSelect) stageSelect.addEventListener("change", function () {
      externalStageFilter = null;
    });
    var roles = ["req-account", "req-route", "req-status", "req-stage", "req-model", "req-key"];
    for (var i = 0; i < roles.length; i++) {
      var select = byRole(roles[i]);
      if (select) select.addEventListener("change", render);
    }
    var search = byRole("req-search");
    if (search) search.addEventListener("input", render);
  }

  /**
   * 当前 tab 能不能刷新（**只有请求事件 tab 能**）。
   *
   * 系统日志是 SSE 推的（`/api/events` 的 `log` 帧），服务端已经在推了，再拉一次
   * 没有意义——顶栏刷新在这一页因此置灰，而不是默默什么都不做。
   * 请求事件 tab 有一份拉来的初始快照（`getRequests`），值得重拉。
   */
  function canRefresh() {
    return onRequestsTab();
  }

  /**
   * 顶栏刷新：请求事件 tab 重拉 `getRequests`；系统 tab 返回 `null`
   * （顶栏那边由 `canRefresh` 置灰）。
   */
  function refresh() {
    if (!onRequestsTab()) return null;
    return loadRequests();
  }

  /* ---- 插件入口 ---------------------------------------------------------- */

  App.views.logs = {
    setConnection: stream.setConnection,
    renderControls: renderControls,
    append: append,
    appendRequest: appendRequest,
    loadRequests: loadRequests,
    refresh: refresh,
    canRefresh: canRefresh,
    selectTab: selectTab,
    syncAccounts: stream.syncAccounts,
    resetAccounts: function (accounts) {
      stream.resetAccounts(accounts);
      /* 请求 tab 的聚合下拉同样带「全部」文案，语言切换后也要重落 */
      reqOptionSnapshots = {};
      renderRequests(true);
    },
    syncModules: stream.syncModules,
    render: render,
    togglePaused: togglePaused,
    clear: clearLogs,
    /* 导出当前筛选结果：工具栏的 `data-action="export-requests"` 绑到这里。 */
    exportRequests: exportRequests,
    bindFilters: bindFilters,
    enter: enter,
    syncExternalFilters: syncExternalFilters,
  };
})(window.__zcodeApp = window.__zcodeApp || {});
