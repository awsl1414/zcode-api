/*
 * app-view-stats.js — 统计视图：`getUsageStats` 的报表页。
 *
 * 数据只有一个来源：控制命令 `getUsageStats`（`src/proxy/usage-stats.ts` 的聚合，
 * 应答形状见 `src/control/control-types.ts` 的 `UsageStatsStats`）。取数节奏是
 * 「进视图拉一次，切范围重拉，刷新按钮重拉」——**无轮询**：这个页面回答的是
 * 「过去用了多少」，5 秒一拍的实时轮询既没必要，也要反复扫 JSONL。
 *
 * 两次拉取：
 *   范围聚合  今天 / 7 天 / 30 天 / 全部（`from` / `to` 由这里换算，本地零点起算）
 *   热力图    固定回看 365 天的热力图聚合（日/周/累计三档粒度 + MCP 计数，
 *             与范围无关，只在进视图与点刷新时拉）
 * 两条命令互不等待地发出去（同一次 `load` 里先后发出），各自的失败各自显示。
 *
 * 区块（任务表）：
 *   范围栏（今天 / 7 天 / 30 天 / 全部 + 刷新）、总览卡行（请求数 / 成功率 /
 *   总 token / 平均首响 / 平均速率 / 错误数）、token 时序（按小时 / 按天切换，
 *   入/出堆叠柱，app-charts.js 自绘）、六维分组（账号 / 路由 / 模型 /
 *   API key / 协议 / 客户端；标题行右侧的胶囊切维度，表头首列恒为「维度」）、
 *   错误分析（阶段分布 + 错误类型，条形）、调度事件
 *   （降级 / 冷却 / 排队超时三计数卡）、缓存命中率（有效样本口径）、
 *   365 天热力图（对齐官方特写：每日 / 每周 / 累计三档粒度，官方蓝色系
 *   色阶 + 底部月轴 + 悬停 tooltip）。
 *
 * 跳转（查询参数，与 `/accounts?focus=` 同一机制——面板的视图
 * 就是几条真实路径，没有 hash 路由）：API key 维度的行跳
 * `/logs?tab=requests&key=<id>`（`-` 那行跳 `key=none`，即「无归因」），日志页
 * 把这两个参数消费进自己的筛选器（app-view-logs.js 的 `enter`）。
 *
 * 缓存命中率的口径：`cacheHit.samples` = 有缓存读桶的记录数（
 * 有效样本口径，旧 JSONL 记录不进分母）。命中率 = **读 / (输入 + 读 + 写)**，三块
 * 都只来自有效样本：上游的 `input_tokens` 是没命中缓存的那部分输入（prompt 总量
 * = 输入 + 读 + 写），分母只取「读 + 写」是错的——真实日志里上游一条写桶
 * 都没报，于是分母只剩读、比率恒 100%（一个永远 100% 的比率不是比率）。写桶缺席
 * 时副行说「写 未上报」（`creationSamples === 0`），不把缺席渲染成「写 0」。样本数
 * 为 0 时显示「暂无缓存数据」而不是 0%。原始三块数字在副行如实露出，方便手算复核。
 *
 * 空态 / 加载态 / 错误态：命令失败 → 顶部横幅（错误码翻文案，数据保留旧值）；
 * 范围无数据 → 时序 / 分组 / 错误各自的空行（时序的图框常驻，画基线加提示行）
 * + 调度计数为 0（0 是调度器的事实）；JSONL 全空与「该范围没有请求」是
 * 同一种空（数据层对「全部」范围没有补零桶，图表没有非零柱就是空）。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var byRole = App.dom.byRole;
  var setText = App.dom.setText;
  var setHidden = App.dom.setHidden;
  var create = App.dom.create;
  var clear = App.dom.clear;
  var t = App.i18n.t;
  var errorText = App.i18n.errorText;
  var compact = App.format.compact;
  var units = App.format.units;

  /** 热力图固定回看的天数（365 天，含今天）。 */
  var HEATMAP_DAYS = 365;
  /**
   * 色阶分档阈值（单位 = token 总量，入 + 出）。三档聚合粒度各一套：
   *
   *   每日（daily）      绝对档 [100 万, 500 万, 2000 万]（绝对量级：
   *                      分档跨时间可比，不看窗口峰值——只有一天有数据时相对档
   *                      会让那天永远最深，读不出「这天是 20 万还是 2000 万」）。
   *   每周（weekly）     日档 × 7（周聚合值 ≈ 日值 × 7，同一把尺乘天数）。
   *   累计（cumulative） 总量分档：按**占区间总量的份额**取档（25% / 50% /
   *                      75%）——累计值单调涨到总量，绝对档会把左半边全压在
   *                      浅档，按份额分档才看得出积累进度。
   *
   * 每套都是 5 档：0 = l0（浅灰），(0, t1] = l1，(t1, t2] = l2，(t2, t3] = l3，
   * > t3 = l4。色值走 token（--heat-0..4，官方蓝色系，采样自官方热力图）。
   */
  var HEATMAP_TIERS = {
    daily: [1000000, 5000000, 20000000],
    weekly: [7000000, 35000000, 140000000],
    cumulative: [0.25, 0.5, 0.75],
  };
  /** 当前热力图聚合粒度（tab 三档）。 */
  var heatGran = "daily";
  /**
   * 键盘焦点停在哪一格（roving tabindex 的锚点，格子序号）。
   *
   * -1 = 还没定位过，重画后停在第 0 格。切粒度 / 切范围后格子数会变，锚点由
   * `syncHeatTabIndex` 夹到合法范围内，不会指到不存在的格子。
   */
  var heatAnchor = -1;

  /**
   * 六个分组维度。`field` 是 `getUsageStats` 应答里的键；`mono` 决定键名列是否等宽字体
   * （模型 id / key id / 协议名 / 客户端标识是技术值，账号 label 与路由名不是）；
   * `jump` = 行整行可点去日志页（目前只有 API key 一维：那是日志页唯一接了
   * 外部筛选参数的维度）。
   */
  var DIMENSIONS = [
    { id: "account", field: "byAccount", mono: false, jump: false },
    { id: "route", field: "byRoute", mono: false, jump: false },
    { id: "model", field: "byModel", mono: true, jump: false },
    { id: "apiKey", field: "byApiKey", mono: true, jump: true },
    { id: "protocol", field: "byProtocol", mono: true, jump: false },
    { id: "clientKind", field: "byClientKind", mono: true, jump: false },
  ];

  /**
   * 视图状态。全部住在模块变量里（DOM 是投影，重渲染不丢）：这个视图不在
   * `/api/state` 轮询路径上，`render` 只被自己的取数回调与语言切换调用。
   */
  var stats = null; // 当前范围的聚合
  var heatmap = null; // 365 天的聚合（只喂热力图）
  var heatmapError = false; // 热力图那条命令失败（与范围聚合互不影响）
  var loading = false; // 范围聚合在途
  var loadError = null; // 范围聚合的失败文案；null = 没有错误
  var range = C.DEFAULT_STATS_RANGE;
  var gran = "hourly"; // 时序粒度：hourly | daily
  var dim = "account"; // 当前分组 tab（DIMENSIONS 的 id）
  /** 作废在途应答的代数：切范围 / 点刷新 +1，旧应答回来时对不上号就丢弃。 */
  var loadSeq = 0;

  /* ---- 地址参数 ---------------------------------------------------------- */

  /** 地址里的一个查询参数（没有就是 `null`）。与 app-view-accounts 的 `focus` 同一读法。*/
  function queryParam(name) {
    var search = window.location.search;
    if (!search) return null;
    var value = new URLSearchParams(search).get(name);
    return value ? value : null;
  }

  /* ---- 范围与请求 -------------------------------------------------------- */

  /**
   * 范围键 → `{from, to}`。「天」按**本地零点**切（用户问的是「我今天用了多少」，
   * 不是「UTC 今天」）；`to` 取当下，让数据层把最后一桶补到当前小时 / 当天，
   * 时序图的横轴是连续的。「全部」不带边界：数据层从最早一条扫起，不补零。
   */
  function rangeQuery(which) {
    if (which === "all") return {};
    var start = new Date();
    start.setHours(0, 0, 0, 0);
    if (which === "7d") start.setDate(start.getDate() - 6);
    else if (which === "30d") start.setDate(start.getDate() - 29);
    return { from: start.getTime(), to: Date.now() };
  }

  /** 热力图的查询：本地零点回看 364 天（加上今天正好 365 个日桶）。 */
  function heatmapQuery() {
    var start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (HEATMAP_DAYS - 1));
    return { from: start.getTime(), to: Date.now() };
  }

  /** API key 维度的一行 → 日志页的跳转地址（`-` = 无归因，落到 `key=none`）。*/
  function logsHref(key) {
    var value = key === "-" ? C.REQUEST_KEY_NONE : key;
    return C.ROUTE_PATH_LOGS + "?tab=" + C.LOG_TAB_REQUESTS + "&" + C.LOGS_KEY_QUERY_KEY + "=" + encodeURIComponent(value);
  }

  /**
   * 取数（进视图 / 切范围 / 顶栏刷新都走这里）。
   *
   * `withHeatmap` = 是否连热力图一起重拉：切范围不用（热力图与范围无关），
   * 进视图与顶栏刷新要。两条命令在同一次同步执行里先后发出（测试的应答
   * 顺序由此确定）；应答按 `loadSeq` 对号，被更新的加载作废。
   *
   * 返回 `Promise`：顶栏刷新靠它判断这一拍什么时侯结束（图标转圈到
   * 取数落地）。被更新的加载作废时也正常 resolve——对调用方来说「这一拍完了」。
   */
  function load(withHeatmap) {
    var seq = loadSeq + 1;
    loadSeq = seq;
    loading = true;
    loadError = null;
    render();

    var query = rangeQuery(range);
    var command = { cmd: "getUsageStats" };
    if (query.from !== undefined) command.from = query.from;
    if (query.to !== undefined) command.to = query.to;
    var rangeCall = App.api.sendControl(command);
    var heatCall = withHeatmap === true ? sendHeatmap() : null;
    return Promise.all([rangeCall, heatCall]).then(function (results) {
      if (seq !== loadSeq) return;
      loading = false;

      var body = results[0];
      if (!body) loadError = errorText(C.NETWORK_ERROR_CODE);
      else if (!body.ok) loadError = errorText(body.error || C.NETWORK_ERROR_CODE);
      else if (body.event === "usageStats" && body.stats) stats = body.stats;
      else loadError = errorText(C.NETWORK_ERROR_CODE);

      if (heatCall) {
        heatmapError = false;
        var heatBody = results[1];
        if (heatBody && heatBody.ok && heatBody.event === "usageStats" && heatBody.stats) heatmap = heatBody.stats;
        else heatmapError = true;
      }
      render();
    });
  }

  function sendHeatmap() {
    var query = heatmapQuery();
    return App.api.sendControl({ cmd: "getUsageStats", from: query.from, to: query.to });
  }

  /* ---- 格式化 ------------------------------------------------------------ */

  /** 毫秒 → `340ms` / `1.2s` / `1m20s`（与日志页用时列同一套档位）。*/
  function fmtMs(ms) {
    if (ms < 1000) return Math.round(ms) + "ms";
    if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
    return Math.floor(ms / 60000) + "m" + Math.round((ms % 60000) / 1000) + "s";
  }

  /** 占比 → `98.5%`（一位小数，整数不带小数点）；分母为 0 回「—」。*/
  function percent(part, total) {
    if (!total || total <= 0) return "—";
    var pct = (part / total) * 100;
    if (pct >= 99.95) return "100%";
    var rounded = Math.round(pct * 10) / 10;
    var text = rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1);
    return text + "%";
  }

  /** 桶起点 → 本地 `MM-DD HH:00`（小时桶）或本地 `MM-DD`（日桶）。*/
  function bucketLabel(bucket) {
    var d = new Date(bucket.bucketStart);
    function pad(n) {
      return n < 10 ? "0" + n : String(n);
    }
    var day = pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    if (gran !== "hourly") return day;
    return day + " " + pad(d.getHours()) + ":00";
  }

  /** 日桶起点 → UTC 日期（热力图格子的 title：桶身份就是 UTC 日，标签跟着桶走）。*/
  function utcDate(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  /* ---- 渲染 -------------------------------------------------------------- */

  function render() {
    renderStatus();
    renderTabs();
    renderSummary();
    renderSeries();
    renderGroups();
    renderErrors();
    renderSchedule();
    renderCache();
    renderHeatmap();
  }

  /** 顶部三件：错误横幅、加载行。*/
  function renderStatus() {
    var banner = byRole("stats-error");
    setHidden(banner, loadError === null);
    setText("stats-error-text", loadError === null ? "" : loadError);
    /* 只有「还没有任何数据」的加载才整行提示：切范围时旧数据留在原地（比闪一下
       空屏诚实）。在途标记落到顶栏那颗刷新按钮上（转圈 + aria-busy），
       这一页不再有自己的刷新按钮。 */
    setHidden(byRole("stats-loading"), !(loading && stats === null));
  }

  /** 三组 tab 的选中态（范围 / 粒度 / 分组维度）。选中值都住在模块变量里。*/
  function renderTabs() {
    markTab("[data-stats-range]", "data-stats-range", range);
    markTab("[data-stats-gran]", "data-stats-gran", gran);
    markTab("[data-stats-dim]", "data-stats-dim", dim);
    markHeatTabs();
  }

  /**
   * 一组 tab 的选中态。
   *
   * 全仓 tab 只有一套契约（与添加账号模态那条 `role="tablist"` 一致）：
   * 容器 `role="tablist"`、按钮 `role="tab"`、选中态写 `aria-selected`。
   * 静态 DOM 已经带上这三样，这里只翻转 `aria-selected`——`role` 是结构，
   * 不随点击变。
   */
  function markTab(selector, attr, value) {
    var tabs = document.querySelectorAll(selector);
    for (var i = 0; i < tabs.length; i++) {
      var active = tabs[i].getAttribute(attr) === value;
      tabs[i].className = active ? "tab tab--active" : "tab";
      tabs[i].setAttribute("aria-selected", active ? "true" : "false");
    }
  }

  /** 热力图粒度 tab 的选中态（胶囊类，见 components.css `.heatmap__tab`）。*/
  function markHeatTabs() {
    var tabs = document.querySelectorAll("[data-heatmap-gran]");
    for (var i = 0; i < tabs.length; i++) {
      var active = tabs[i].getAttribute("data-heatmap-gran") === heatGran;
      tabs[i].className = active ? "heatmap__tab heatmap__tab--active" : "heatmap__tab";
      tabs[i].setAttribute("aria-selected", active ? "true" : "false");
    }
  }

  /** 总览卡行（六张）。没有数据（还在加载 / 刚失败）时各卡是「—」。*/
  function renderSummary() {
    var totals = stats ? stats.totals : null;
    setText("stats-requests", totals ? compact(totals.requests) : "—");
    setText("stats-successRate", totals ? percent(totals.ok, totals.requests) : "—");
    setText("stats-tokens", totals ? units(totals.inputTokens + totals.outputTokens) : "—");
    setText("stats-tokens-sub", totals ? "↑" + units(totals.outputTokens) + " ↓" + units(totals.inputTokens) : "");
    setText("stats-ttfb", totals && totals.avgTtfbMs !== undefined ? fmtMs(totals.avgTtfbMs) : "—");
    setText("stats-tps", totals && totals.avgTps !== undefined ? totals.avgTps.toFixed(1) + " tok/s" : "—");
    setText("stats-errors", totals ? compact(totals.errorCount) : "—");
  }

  /** token 时序：按当前粒度重画。图框常驻：没有柱子时画基线，提示行只在
   *  已拿到应答且范围内没有请求时出现；图例与峰值 / 合计行只在有柱子时出现。*/
  function renderSeries() {
    var holder = byRole("stats-chart");
    var empty = byRole("stats-chart-empty");
    var legend = byRole("stats-legend");
    var meta = byRole("stats-chart-meta");
    if (!holder) return;
    clear(holder);

    var buckets = stats ? (gran === "hourly" ? stats.hourly : stats.daily) : [];
    var hasBars = false;
    var peak = 0;
    var total = 0;
    for (var i = 0; i < buckets.length; i++) {
      var value = (buckets[i].inputTokens || 0) + (buckets[i].outputTokens || 0);
      total += value;
      if (value > 0) hasBars = true;
      if (value > peak) peak = value;
    }
    holder.appendChild(App.charts.stackedBars(buckets, { height: 160, label: bucketTitle, tick: units }));
    /* 两句空话分开说：范围内真没请求 = 「还没有请求」；
       有请求但全失败、一个 token 也没有 = 「还没有 token 数据」。一律报
       「没有请求」会与顶部卡片上的请求数直接矛盾。 */
    if (!hasBars && stats) {
      var requestCount = stats.totals ? stats.totals.requests : 0;
      setText("stats-chart-empty-text", t(requestCount > 0 ? "stats.series.emptyTokens" : "stats.series.empty"));
    }
    /* stats 还没到（首拍 / 加载中）时空态不出现——顶部有整行的加载提示。 */
    setHidden(empty, hasBars || stats === null);
    setHidden(legend, !hasBars);
    setHidden(meta, !hasBars);
    if (!hasBars) return;

    setText("stats-chart-peak", t("stats.series.peak", { value: units(peak) }));
    setText("stats-chart-total", t("stats.series.total", { value: units(total) }));
  }

  /** 柱子的悬浮提示：本地时间 + 入出两个数。*/
  function bucketTitle(bucket) {
    var inTok = units(bucket.inputTokens || 0);
    var outTok = units(bucket.outputTokens || 0);
    return bucketLabel(bucket) + " · ↑" + outTok + " ↓" + inTok;
  }

  /** 六维分组表：行形状全部一致。表头首列恒为「维度」（`stats.dim.columnHeader`），
   *  不跟当前维度名同步——「这是哪种分组」由标题行的维度胶囊说一次。*/
  function renderGroups() {
    var dimension = dimensionOf(dim);
    var body = byRole("stats-group-body");
    var table = byRole("stats-group-table");
    var empty = byRole("stats-groups-empty");
    if (!body) return;
    clear(body);

    var rows = stats && Array.isArray(stats[dimension.field]) ? stats[dimension.field] : [];
    var has = stats !== null && rows.length > 0;
    setHidden(table, !has);
    setHidden(empty, has || stats === null);
    for (var i = 0; i < rows.length; i++) body.appendChild(groupRow(dimension, rows[i]));
  }

  function dimensionOf(id) {
    for (var i = 0; i < DIMENSIONS.length; i++) {
      if (DIMENSIONS[i].id === id) return DIMENSIONS[i];
    }
    return DIMENSIONS[0];
  }

  /** 分组的一行：键 / 请求 / 失败 / 成功率 / token / 均延迟 / 均速率。*/
  function groupRow(dimension, row) {
    var tr = document.createElement("tr");

    var keyCell = document.createElement("td");
    if (dimension.mono) keyCell.className = "mono";
    keyCell.textContent = row.key;
    /* 表格是固定列宽（.table--fixed），超出首列的长键（模型 id）视觉上截断
       ——完整值放 title 里，不靠悬停行尾的跳转提示去猜。 */
    keyCell.title = row.key;
    tr.appendChild(keyCell);

    tr.appendChild(numCell(compact(row.requests)));
    tr.appendChild(numCell(compact(row.failed)));
    tr.appendChild(numCell(percent(row.requests - row.failed, row.requests)));

    var tokens = document.createElement("td");
    tokens.className = "num";
    tokens.textContent = "↑" + units(row.outputTokens) + " ↓" + units(row.inputTokens);
    tr.appendChild(tokens);

    tr.appendChild(numCell(row.avgTotalMs !== undefined ? fmtMs(row.avgTotalMs) : "—"));
    tr.appendChild(numCell(row.avgTps !== undefined ? row.avgTps.toFixed(1) : "—"));

    if (dimension.jump) {
      /* 整行可点（与概览账号摘要同一套形状语义：`data-href` + tabindex）。 */
      tr.setAttribute("data-href", logsHref(row.key));
      tr.setAttribute("tabindex", "0");
      tr.setAttribute("title", t("stats.groups.jumpHint"));
    }
    return tr;
  }

  function numCell(text) {
    var td = document.createElement("td");
    td.className = "num";
    td.textContent = String(text);
    return td;
  }

  /**
   * 错误分析：`errors[]` 按 errorCode 折叠，一行一个错误身份。
   *
   * `kind` 就是产生点落下的稳定键（统计层零二次分类），展示层只查 i18n：
   * `errorCode.<code>` = 用户词、`errorCode.<code>.hint` = 怎么办。只有这一个
   * 透视：阶段（dispatch / saturated / all-cooling）是技术标识，不是用户词。
   * 横条宽度按最大次数归一（单分类不画条，单一取值画成满格反而看不出量级）。
   */
  function renderErrors() {
    var holder = byRole("stats-kinds");
    var empty = byRole("stats-kinds-empty");
    if (!holder) return;
    clear(holder);

    var rows = foldErrors();
    var has = stats !== null && rows.length > 0;
    setHidden(empty, has || stats === null);
    if (!has) return;

    var max = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].count > max) max = rows[i].count;
    }
    for (var j = 0; j < rows.length; j++) {
      holder.appendChild(errorRow(rows[j].name, rows[j].count, max, rows.length === 1));
    }
  }

  /** `errors[]`（stage × errorCode × count）→ 按 errorCode 折叠、次数降序。*/
  function foldErrors() {
    var counts = {};
    var order = [];
    var rows = stats ? stats.errors : [];
    for (var i = 0; i < rows.length; i++) {
      var code = typeof rows[i].kind === "string" ? rows[i].kind : "other";
      if (counts[code] === undefined) {
        counts[code] = 0;
        order.push(code);
      }
      counts[code] += rows[i].count || 0;
    }
    var folded = [];
    for (var j = 0; j < order.length; j++) folded.push({ name: order[j], count: counts[order[j]] });
    folded.sort(function (a, b) {
      return b.count - a.count;
    });
    return folded;
  }

  /**
   * 一行错误：用户词 + hint + 次数（hint 在名字下，跟着当前语言换）。
   * `code` 是内部键，只作 data 属性给排障用，不出现在可见文案里。
   */
  function errorRow(code, count, max, single) {
    var row = create("div", single ? "hbar hbar--single hbar--error" : "hbar hbar--error");
    row.setAttribute("data-error-code", code);
    var name = create("span", "hbar__name", t("errorCode." + code));
    name.appendChild(create("span", "hbar__hint", t("errorCode.hintPrefix") + t("errorCode." + code + ".hint")));
    row.appendChild(name);
    if (!single) {
      var track = create("span", "hbar__track");
      var fill = create("span", "hbar__fill");
      fill.style.width = max > 0 ? Math.max(2, Math.round((count / max) * 100)) + "%" : "0%";
      track.appendChild(fill);
      row.appendChild(track);
    }
    row.appendChild(create("span", "hbar__count num", "\u00d7 " + compact(count)));
    return row;
  }

  /** 调度事件三计数卡：0 是有意义的事实（调度器没做这些动作），照常显示。*/
  function renderSchedule() {
    var schedule = stats ? stats.schedule : null;
    setText("stats-degraded", schedule ? compact(schedule.degraded) : "—");
    setText("stats-cooled", schedule ? compact(schedule.cooled) : "—");
    setText("stats-queueTimeout", schedule ? compact(schedule.queueTimeout) : "—");
  }

  /**
   * 缓存命中率：读 / (读 + 写)，都只来自有效样本（见文件头口径说明）。
   * 样本数为 0 时整块收起，显示「暂无缓存数据」——不是 0%：「上游没报过缓存」
   * 与「缓存全没命中」是两回事。
   */
  function renderCache() {
    var data = byRole("stats-cache-data");
    var empty = byRole("stats-cache-empty");
    if (!data) return;
    var hit = stats ? stats.cacheHit : null;
    var has = hit !== null && hit.samples > 0;
    setHidden(data, !has);
    setHidden(empty, has || stats === null);
    if (!has) return;

    /* 口径：读 / (输入 + 读 + 写)。写桶缺席（`creationSamples === 0`）不当成
       0 写——真实数据里上游就是不报这个桶，把它当 0 会把分母弄成「读 + 0」。 */
    var inputTokens = hit.inputTokens || 0;
    var denominator = inputTokens + hit.readTokens + hit.creationTokens;
    var rate = denominator > 0 ? hit.readTokens / denominator : 0;
    setText("stats-cache-rate", percent(hit.readTokens, denominator));
    var fill = byRole("stats-cache-fill");
    if (fill) fill.style.width = Math.round(rate * 100) + "%";
    setText(
      "stats-cache-sub",
      t("stats.cache.samples", { count: compact(hit.samples) }) +
        " · " +
        t("stats.cache.input", { value: units(inputTokens) }) +
        " · " +
        t("stats.cache.read", { value: units(hit.readTokens) }) +
        " · " +
        (hit.creationSamples === 0
          ? t("stats.cache.creationMissing")
          : t("stats.cache.creation", { value: units(hit.creationTokens) })),
    );
  }

  /**
   * 热力图渲染（对齐官方 BigModel 特写）：tab 三档聚合粒度切换
   * （每日 = 日格、每周 = 周格聚合、累计 = 总量分档），网格 + 底部月轴 +
   * 悬停 tooltip。
   *
   * 几何（对照特写图）：
   *   - 列 = 周，列数按时间范围算满（`leading + 天数` 向上取整到周），列宽
   *     `minmax(12px, 1fr)` **撑满容器**——格子固定 12px 居中时，53 列铺不满
   *     宽卡，两侧留白；列模板由 JS 写 inline（纯几何值，不受间距档约束），
   *     格子缸与月轴各写一份同值模板才对得齐。
   *   - 行 = 周一→周日（第一桶的周内偏移 = `(getUTCDay() + 6) % 7` 决定首列
   *     前补几个 void；行序按官方口径从周一起算）。
   *   - 尾部补齐 void，矩形右侧不断裂。
   *   - 月轴在**底部**，标签落在各月首周列（月变化日所在列），
   *     窗口首日也算一个标签起点。
   *
   * tooltip（悬停浮层，非 title）：第一行日期、第二行「Tokens 消耗 X | MCP
   * 消耗 Y次」。Tokens 用 M/B 两位小数（`units(value, "en")`——官方特写就是
   * 58.65M 这个格式，不走中文万/亿）；MCP 次数来自数据层 `heatmap` 的格值
   * （`/mcp` 端点请求归因，usage-stats.ts）。日格日期 = 该日（UTC），周格 =
   * 周一到周日范围，累计格 = 该日（值为截至当日累计）。
   *
   * 数据是 `stats.heatmap`（usage-stats.ts 的日 / 周 / 累计三数组），三个 tab
   * 共用一次取数，切换只重渲染。
   */
  function renderHeatmap() {
    var wrap = byRole("stats-heatmap");
    var empty = byRole("stats-heatmap-empty");
    var grid = byRole("heatmap-grid");
    if (!wrap || !grid) return;
    /* 重画会换掉全部格子节点。焦点正落在某格里（语言切换 / 顶栏刷新会走到这里）
       时先记下它的序号，画完再还回去——否则焦点掉到 `body`，键盘用户得从
       页面顶部重新 Tab。 */
    var hadFocus = grid.contains(document.activeElement);
    clear(grid);
    clear(byRole("heatmap-months"));
    hideHeatTip();

    if (heatmap === null) {
      setText("stats-heatmap-empty-text", heatmapError ? t("stats.heatmap.error") : t("stats.loading"));
      setHidden(empty, false);
      setHidden(wrap, true);
      return;
    }
    setHidden(empty, true);
    setHidden(wrap, false);

    var cells = heatCells();
    if (cells.length === 0) {
      setText("stats-heatmap-empty-text", t("stats.heatmap.error"));
      setHidden(empty, false);
      setHidden(wrap, true);
      return;
    }

    var weekly = heatGran === "weekly";
    var leading = weekly ? 0 : (new Date(cells[0].bucketStart).getUTCDay() + 6) % 7;
    var columns = weekly ? cells.length : Math.ceil((leading + cells.length) / 7);
    var template = "repeat(" + columns + ", minmax(12px, 1fr))";
    grid.style.gridTemplateColumns = template;
    grid.className = weekly ? "heatmap__grid heatmap__grid--flat" : "heatmap__grid";

    /* 累计视图的分档基准 = 区间总量（份额分档，见 HEATMAP_TIERS）。 */
    var total = 0;
    if (heatGran === "cumulative") {
      total = cells[cells.length - 1].tokens;
    }

    var i;
    for (i = 0; i < leading; i++) grid.appendChild(create("span", "heatmap__cell heatmap__cell--void"));
    for (i = 0; i < cells.length; i++) {
      grid.appendChild(heatCell(cells[i], weekly, total));
    }
    var tail = columns * (weekly ? 1 : 7) - (leading + cells.length);
    for (i = 0; i < tail; i++) grid.appendChild(create("span", "heatmap__cell heatmap__cell--void"));

    renderHeatMonths(cells, leading, weekly, template);
    syncHeatTabIndex(grid);
    if (hadFocus) {
      var restored = grid.querySelectorAll('.heatmap__cell[data-heat-date]')[heatFocusIndex()];
      if (restored) restored.focus();
    }
  }

  /** 当前 tab 对应的格值数组（`stats.heatmap` 的日 / 周 / 累计三份）。*/
  function heatCells() {
    var heat = heatmap && heatmap.heatmap;
    if (!heat) return [];
    if (heatGran === "weekly") return Array.isArray(heat.weekly) ? heat.weekly : [];
    if (heatGran === "cumulative") return Array.isArray(heat.cumulative) ? heat.cumulative : [];
    return Array.isArray(heat.daily) ? heat.daily : [];
  }

  /**
   * 一格：色阶档（`levelOf`）+ 键盘 / 读屏的等价读数。
   *
   * 三个 dataset 值是**同一份数据**的两条通道：悬停浮层读它们渲染富文本，
   * `aria-label` 直接把它们拼成一句（`ui.heatmap.cellLabel`）。格子不带
   * `title`——原生 tooltip 会跟浮层双弹。`tabindex` 由 `syncHeatTabIndex`
   * 统一维护（roving tabindex：整张网格只有一个 Tab 停靠点）。
   */
  function heatCell(cell, weekly, total) {
    var span = create("span", "heatmap__cell heatmap__cell--l" + levelOf(cell, total));
    var date = heatDateLabel(cell, weekly);
    span.setAttribute("data-heat-date", date);
    span.setAttribute("data-heat-tokens", String(cell.tokens));
    span.setAttribute("data-heat-mcp", String(cell.mcpCalls));
    span.setAttribute("aria-label", heatCellLabel(date, cell));
    return span;
  }

  /** 格子的可访问名：日期 + Tokens + MCP（数值口径与悬停浮层同一套格式）。*/
  function heatCellLabel(date, cell) {
    return t("ui.heatmap.cellLabel", {
      date: date,
      tokens: fmtMB(Number(cell.tokens) || 0),
      mcp: Number(cell.mcpCalls) || 0,
    });
  }

  /**
   * roving tabindex：几百个格子里只有一格进 Tab 序。
   *
   * 每格都带 `tabindex="0"` 的话，键盘用户要按几百次 Tab 才能越过这张图。
   * 记一个模块级的 `heatAnchor`（格子序号），重画后把 `tabindex="0"` 还给
   * 同一格；没有记录（首次进入）时停在第 0 格。方向键移动时只改这两个属性，
   * 不重画网格。
   */
  function heatFocusIndex() {
    return heatAnchor < 0 ? 0 : heatAnchor;
  }

  function syncHeatTabIndex(grid) {
    var cells = grid.querySelectorAll('.heatmap__cell[data-heat-date]');
    if (cells.length === 0) return;
    var anchor = Math.min(heatFocusIndex(), cells.length - 1);
    for (var i = 0; i < cells.length; i++) {
      cells[i].setAttribute("tabindex", i === anchor ? "0" : "-1");
    }
  }

  /** 方向键在格子之间移动：跨度为整列（7 行），左右 = ±1 列，上下 = ±1 行。*/
  function moveHeatFocus(grid, cell, event) {
    var cells = Array.prototype.slice.call(grid.querySelectorAll('.heatmap__cell[data-heat-date]'));
    var current = cells.indexOf(cell);
    if (current < 0) return;
    var next = current;
    if (event.key === "ArrowRight") next = current + 7;
    else if (event.key === "ArrowLeft") next = current - 7;
    else if (event.key === "ArrowDown") next = current + 1;
    else if (event.key === "ArrowUp") next = current - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = cells.length - 1;
    else return;
    /* 每周 / 累计视图是一行，上下键没有意义（行列都只剩 1 行）：不搬。 */
    if (heatGran !== "daily" && (event.key === "ArrowUp" || event.key === "ArrowDown")) return;
    event.preventDefault();
    if (next < 0 || next >= cells.length) return;
    heatAnchor = next;
    syncHeatTabIndex(grid);
    cells[next].focus();
    showHeatTip(cells[next]);
  }

  /** tooltip 第一行的日期：日 / 累计格 = 该日（UTC），周格 = 周一到周日范围。*/
  function heatDateLabel(cell, weekly) {
    if (!weekly) return utcDate(cell.bucketStart);
    return utcDate(cell.bucketStart) + " – " + utcDate(cell.bucketStart + 6 * 86_400_000);
  }

  /**
   * 底部月轴：标签落在各月首周列（月变化日所在的周列），窗口首日也算一个
   * 起点。列模板与格子缸同值（同一个 `template` 字符串），标签用 inline
   * `gridColumn` 定位（列号是数据算出来的，纯几何值）。相邻标签列距
   * < 2 时跳过（窗口首月只剩几天时防重叠；满窗各月间隔 4–5 列，全标）。
   */
  function renderHeatMonths(cells, leading, weekly, template) {
    var holder = byRole("heatmap-months");
    if (!holder) return;
    holder.style.gridTemplateColumns = template;

    var marks = [];
    var previousMonth = -1;
    for (var i = 0; i < cells.length; i++) {
      var month = new Date(cells[i].bucketStart).getUTCMonth();
      if (month === previousMonth) continue;
      previousMonth = month;
      marks.push({ month: month, column: weekly ? i : Math.floor((leading + i) / 7) });
    }

    for (var j = 0; j < marks.length; j++) {
      var next = j + 1 < marks.length ? marks[j + 1].column : (weekly ? cells.length : Math.ceil((leading + cells.length) / 7));
      var span = next - marks[j].column;
      if (span < 2) continue;
      var label = create("span", "heatmap__month", App.format.month(marks[j].month));
      label.style.gridColumn = marks[j].column + 1 + " / span " + span;
      holder.appendChild(label);
    }
  }

  /**
   * tooltip 的 Tokens 大数格式（M/B 两位小数，如 58.65M）：官方特写就是这个
   * 格式——不走中文万/亿，也不像 `units` 那样 trim 尾零（「两位小数」是格式
   * 本身，58.60M 就是 58.60M）。小于 1K 直接取整。
   */
  function fmtMB(value) {
    if (!(value > 0)) return "0";
    if (value >= 1e9) return (value / 1e9).toFixed(2) + "B";
    if (value >= 1e6) return (value / 1e6).toFixed(2) + "M";
    return String(Math.round(value));
  }

  /**
   * 悬停 tooltip：格子的三个 dataset 值拼成特写图的两行格式。Tokens 走
   * `fmtMB`（M/B 两位小数），MCP 次数走 i18n 模板（「次」是中文量词，英文
   * 模板不带）。
   */
  function showHeatTip(cell) {
    var tip = byRole("heatmap-tip");
    var panel = tip && tip.parentElement;
    if (!tip || !panel) return;
    setText("heatmap-tip-date", cell.getAttribute("data-heat-date") || "");
    setText("heatmap-tip-tokens", fmtMB(Number(cell.getAttribute("data-heat-tokens")) || 0));
    setText("heatmap-tip-mcp", t("stats.heatmap.tip.mcpValue", { count: cell.getAttribute("data-heat-mcp") || "0" }));
    setHidden(tip, false);

    /* 定位：格子上方居中（放不下就翻到下方），横向钳在卡片内。纯几何 inline。 */
    var cellRect = cell.getBoundingClientRect();
    var panelRect = panel.getBoundingClientRect();
    var tipRect = tip.getBoundingClientRect();
    var left = cellRect.left - panelRect.left + cellRect.width / 2 - tipRect.width / 2;
    var top = cellRect.top - panelRect.top - tipRect.height - 8;
    if (top < 0) top = cellRect.bottom - panelRect.top + 8;
    left = Math.max(4, Math.min(left, panelRect.width - tipRect.width - 4));
    tip.style.left = Math.round(left) + "px";
    tip.style.top = Math.round(top) + "px";
  }

  function hideHeatTip() {
    var tip = byRole("heatmap-tip");
    if (tip) setHidden(tip, true);
  }

  /**
   * 格值 → 色阶档（5 档：0 / l1..l4），阈值按聚合粒度取（`HEATMAP_TIERS`）：
   * 每日 / 每周是绝对 token 档（跨时间可比），累计是**占区间总量的份额**档
   * （`total` = 区间总量；累计值单调涨到总量，绝对档会把左半边全压浅档）。
   */
  function levelOf(cell, total) {
    var value = cell.tokens;
    if (!(value > 0)) return 0;
    var tiers = HEATMAP_TIERS[heatGran] || HEATMAP_TIERS.daily;
    var metric = heatGran === "cumulative" ? (total > 0 ? value / total : 0) : value;
    for (var level = 1; level <= tiers.length; level++) {
      if (metric <= tiers[level - 1]) return level;
    }
    return tiers.length + 1;
  }

  /* ---- 事件绑定 ---------------------------------------------------------- */

  /** 整行可点的分组行（只有 API key 维度）：click 与 Enter / 空格走同一条路。*/
  function followRow(event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") return;
    var row = target.closest("tr[data-href]");
    if (!row) return;
    window.location.assign(row.getAttribute("data-href"));
  }

  function bindControls() {
    bindTabs("[data-stats-range]", "data-stats-range", function (value) {
      if (C.STATS_RANGES.indexOf(value) < 0 || value === range) return;
      range = value;
      /* 切范围只重拉范围聚合：热力图固定 365 天，与范围无关。 */
      load(false);
    });
    bindTabs("[data-stats-gran]", "data-stats-gran", function (value) {
      if (value !== "hourly" && value !== "daily") return;
      gran = value;
      renderTabs();
      renderSeries();
    });
    bindTabs("[data-stats-dim]", "data-stats-dim", function (value) {
      var dimension = dimensionOf(value);
      if (dimension.id !== value) return;
      dim = value;
      renderTabs();
      renderGroups();
    });
    /* 热力图三档粒度：数据一次拉全（heatmap 含日/周/累计三数组），切 tab 只
       重渲染网格。选中态跟着切（胶囊：heatmap__tab--active）。 */
    bindTabs("[data-heatmap-gran]", "data-heatmap-gran", function (value) {
      if (value !== "daily" && value !== "weekly" && value !== "cumulative") return;
      heatGran = value;
      markHeatTabs();
      renderHeatmap();
    });

    /* tooltip：网格上事件委托（格子几百个，不逐格绑）。mouseleave 收浮层。
       键盘走同一份数据：`focusin` 开浮层、`focusout`（焦点离开网格）收，
       方向键在格子之间移动由 `moveHeatFocus` 负责。 */
    var grid = byRole("heatmap-grid");
    if (grid) {
      grid.addEventListener("mouseover", function (event) {
        var target = event.target;
        if (!target || typeof target.closest !== "function") return;
        var cell = target.closest(".heatmap__cell[data-heat-date]");
        if (cell) showHeatTip(cell);
      });
      grid.addEventListener("mouseleave", hideHeatTip);
      grid.addEventListener("focusin", function (event) {
        var target = event.target;
        if (!target || typeof target.closest !== "function") return;
        var cell = target.closest(".heatmap__cell[data-heat-date]");
        if (!cell) return;
        heatAnchor = Array.prototype.indexOf.call(
          grid.querySelectorAll(".heatmap__cell[data-heat-date]"),
          cell,
        );
        syncHeatTabIndex(grid);
        showHeatTip(cell);
      });
      grid.addEventListener("focusout", function (event) {
        var next = event.relatedTarget;
        if (next && grid.contains(next)) return;
        hideHeatTip();
      });
      grid.addEventListener("keydown", function (event) {
        var target = event.target;
        if (!target || typeof target.closest !== "function") return;
        var cell = target.closest(".heatmap__cell[data-heat-date]");
        if (cell) moveHeatFocus(grid, cell, event);
      });
    }

    var body = byRole("stats-group-body");
    if (body) {
      body.addEventListener("click", followRow);
      body.addEventListener("keydown", function (event) {
        if (event.key !== "Enter" && event.key !== " ") return;
        var target = event.target;
        if (!target || typeof target.closest !== "function" || !target.closest("tr[data-href]")) return;
        event.preventDefault();
        followRow(event);
      });
    }
  }

  /** 一组 tab 的通用绑定：点击取属性值交给回调（值合法性由回调把关）。*/
  function bindTabs(selector, attr, onPick) {
    var tabs = document.querySelectorAll(selector);
    for (var i = 0; i < tabs.length; i++) {
      (function (tab) {
        tab.addEventListener("click", function () {
          onPick(tab.getAttribute(attr));
        });
      })(tabs[i]);
    }
  }

  /* ---- 入口 -------------------------------------------------------------- */

  /**
   * 进视图（app.js 的 showView 在 VIEW_STATS 时调）：读 `?range=`（非法值落回
   * 默认），然后第一次取数（连热力图）。
   */
  function enter() {
    var requested = queryParam(C.STATS_RANGE_QUERY_KEY);
    if (requested && C.STATS_RANGES.indexOf(requested) >= 0) range = requested;
    load(true);
  }

  /**
   * 顶栏刷新：按**当前范围**重拉（连热力图，与进视图同一拍）。
   *
   * 刷新只在顶栏（一个刷新动作只有一个入口）。范围本身不变——用户选的是范围，
   * 不是「重选一次」。
   */
  function refresh() {
    return load(true);
  }

  App.views.stats = { enter: enter, render: render, refresh: refresh, bindControls: bindControls };
})(window.__zcodeApp = window.__zcodeApp || {});
