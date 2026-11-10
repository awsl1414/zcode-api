/*
 * app-logs-request-table.js — 日志页「请求事件」tab 的十四列表格：行、展开详情、
 * 阶段时间线、表尾的「加载更早」。
 *
 * 数据是 `RequestRecord`（服务端原样 JSON）：渲染时直接读字段，不做聚合。
 * 记录怎么来、怎么去重、怎么分页、过滤什么，都在 `app-view-logs.js`——它把当前
 * 可见的记录算好传进来（`render` 的 `visible`），本模块只负责把它们画成 DOM。
 * 这样「表格里看到的行」与「导出的行」共用同一条过滤路径，两处不会走偏。
 *
 * 十四列：缓存命中率 / 推理强度 / 重试三列在 ≤1440 的窗口里折叠进**展开行**
 * （`.req__meta`）——表格列装不下的字段进展开行是同一套机制，不是另起一套
 * 隐藏逻辑。折叠状态只由视口宽决定（`C.REQUEST_FOLD_MEDIA`），展开行与「加载更早」
 * 行的 `colSpan` 跟着算（`requestColumnSpan`）。
 *
 * 缓存列的口径（与统计页对齐）：分母是**本条记录**的 `input + read +
 * creation`，不是只看 read + creation。上游的 `input_tokens` 只是「没命中缓存的
 * 那部分」，prompt 总量 = 三者之和；只看后两项会让写桶缺席时（上游常态，实测
 * `cache_creation_input_tokens` 从不下发）命中率恒为 100%。
 *
 * 错误列：用户词 + hint 都由 `errorCode` 查 i18n 得到；
 * `record.error` 原文（detail）只进 title 与展开行，不参与分类也不参与展示词。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var byRole = App.dom.byRole;
  var setHidden = App.dom.setHidden;
  var create = App.dom.create;
  var clear = App.dom.clear;
  var t = App.i18n.t;

  /** 当前展开的请求（reqId）；一次只展开一行，再点一次收起。*/
  var expandedReqId = null;

  /* ---- 过滤口径 ---------------------------------------------------------- */

  /**
   * 一个过滤控件的当前值（DOM 就是真值：测试与用户走同一条路径）。
   *
   * 系统 tab 的四个过滤器用同一条规则（`app-view-logs.js` 的 `logMatches` 按它取值）。
   */
  function filterValue(role, fallback) {
    var node = byRole(role);
    return node && typeof node.value === "string" ? node.value : fallback;
  }

  /** key 过滤值的匹配：`none` 是「无归因」的聚合一维，不对应任何真实 id。*/
  function keyMatches(record, filter) {
    if (filter === C.REQUEST_KEY_ALL) return true;
    if (filter === C.REQUEST_KEY_NONE) return !record.apiKeyId;
    return record.apiKeyId === filter;
  }

  /** 请求事件的一条记录是否通过当前过滤（状态 / 账号 / 路由 / 模型 / key / 阶段 / 搜索）。*/
  function requestMatches(record) {
    var status = filterValue("req-status", C.REQUEST_STATUS_ALL);
    if (status !== C.REQUEST_STATUS_ALL) {
      /* 「错误」是失败并集，其余四档纯按状态码：一个失败的 500 同时命中两档。 */
      if (status === C.REQUEST_STATUS_ERROR_KEY) {
        if (!requestFailed(record)) return false;
      } else if (requestStatusBucket(record) !== status) {
        return false;
      }
    }

    var account = filterValue("req-account", C.REQUEST_ACCOUNT_ALL);
    if (account !== C.REQUEST_ACCOUNT_ALL && record.account !== account) return false;

    var route = filterValue("req-route", C.REQUEST_ROUTE_ALL);
    if (route !== C.REQUEST_ROUTE_ALL && record.route !== route) return false;

    var model = filterValue("req-model", C.REQUEST_MODEL_ALL);
    if (model !== C.REQUEST_MODEL_ALL && record.model !== model) return false;

    var key = filterValue("req-key", C.REQUEST_KEY_ALL);
    if (!keyMatches(record, key)) return false;

    /* 阶段：就是失败现场 `failedStage` 本身，没失败的记录没有这一维。*/
    var stage = filterValue("req-stage", C.REQUEST_STAGE_ALL);
    if (stage !== C.REQUEST_STAGE_ALL && record.failedStage !== stage) return false;

    var needle = filterValue("req-search", "").trim().toLowerCase();
    if (needle && requestSearchText(record).indexOf(needle) < 0) return false;
    return true;
  }

  /** 文本搜索的语料：一行能拼下的标识都算——找一条请求通常是从任意一角下手。*/
  function requestSearchText(record) {
    return [
      record.reqId,
      record.model,
      record.account,
      record.route,
      record.format,
      record.apiKeyId,
      record.error,
    ]
      .filter(function (part) {
        return typeof part === "string" && part !== "";
      })
      .join("\n")
      .toLowerCase();
  }

  /**
   * 状态过滤的六档桶。「错误」不看状态码，看 `error` / `failedStage`——
   * 它是「这条请求真的失败了」的并集（在 intake 就挂掉的请求没有状态码，也要有
   * 地方可筛）；其余四档纯按状态码分段：没状态码是「进行中」，<400 进 2xx
   * （上游 API 网关不发 3xx，真发生了也归成功族），<500 是 4xx，其余 5xx。
   * 两条口径不互斥：一个带 failedStage 的 500 同时命中「错误」与「5xx」——
   * 使用者挑哪个透镜都能看到它。
   */
  function requestStatusBucket(record) {
    if (typeof record.status !== "number") return C.REQUEST_STATUS_PENDING_KEY;
    if (record.status < 400) return C.REQUEST_STATUS_OK_KEY;
    if (record.status < 500) return C.REQUEST_STATUS_CLIENT_ERROR_KEY;
    return C.REQUEST_STATUS_SERVER_ERROR_KEY;
  }

  /** 「错误」桶的成员：失败发生在某个阶段（`failedStage`），或带错误说明。*/
  function requestFailed(record) {
    return record.failedStage !== undefined || typeof record.error === "string";
  }

  /* ---- 单元格 ------------------------------------------------------------ */

  /** 状态码桶 → 徽章配色（2xx 绿 / 4xx 橙 / 5xx 红；「错误」「进行中」另算）。*/
  var STATUS_KIND_BY_BUCKET = {};
  STATUS_KIND_BY_BUCKET[C.REQUEST_STATUS_OK_KEY] = "ok";
  STATUS_KIND_BY_BUCKET[C.REQUEST_STATUS_CLIENT_ERROR_KEY] = "warn";
  STATUS_KIND_BY_BUCKET[C.REQUEST_STATUS_SERVER_ERROR_KEY] = "danger";

  /**
   * 状态列的 StatusBadge：2xx 绿 / 4xx 橙 / 5xx 红 / 进行中琥珀。
   * 配色跟状态码走（失败了但拿到状态码的，代码是什么色就是什么色）；带失败
   * 标记却没有状态码的（intake 就挂了）给 danger 的 ✗；都没有才是「进行中」。
   *
   * 多一档：客户端断开（`clientAborted`）且没拿到状态码时是 `--aborted` 与
   * 「断开」——它不是上游失败，也不是还在路上（那个请求已经结束了）。
   */
  function statusBadge(record) {
    var kind;
    var text;
    if (typeof record.status === "number") {
      kind = STATUS_KIND_BY_BUCKET[requestStatusBucket(record)] || "ok";
      text = String(record.status);
    } else if (record.clientAborted) {
      kind = "aborted";
      text = t("logs.requests.aborted");
    } else if (requestFailed(record)) {
      kind = "danger";
      text = "✗";
    } else {
      kind = "pending";
      text = C.REQUEST_STATUS_PENDING;
    }
    var badge = create("span", C.REQUEST_STATUS_BADGE_CLASS[kind]);
    badge.appendChild(create("span", "status-badge__dot"));
    badge.appendChild(create("span", null, text));
    return badge;
  }

  /**
   * 时间列：本地 HH:MM:SS；跨天的记录补上日期（`MM-DD `）——请求日志一开就是
   * 一夜，隔天早上「07:57:59」不知道是哪天的。
   */
  function formatRequestTime(ms) {
    if (typeof ms !== "number") return "-";
    var d = new Date(ms);
    var now = new Date();
    var sameDay =
      d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return App.logsStream.localTime(ms);
    function pad(n) {
      return n < 10 ? "0" + n : String(n);
    }
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + App.logsStream.localTime(ms);
  }

  /** 毫秒 → `118ms` / `2.9s` / `1m20s`（与终端表格同一套数字）。*/
  function fmtMs(ms) {
    if (ms < 1000) return ms + "ms";
    if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
    return Math.floor(ms / 60000) + "m" + Math.floor((ms % 60000) / 1000) + "s";
  }

  /**
   * 用时列的两行：总用时一行、首响一行（大字总用时、小字首响）。
   * 两个都没有 = 还没收到上游的任何字节。
   */
  function durationCell(record) {
    var td = document.createElement("td");
    var total = typeof record.totalMs === "number" ? record.totalMs : undefined;
    var ttfb = typeof record.ttfbMs === "number" ? record.ttfbMs : undefined;
    if (total === undefined && ttfb === undefined) {
      td.textContent = "-";
      return td;
    }
    td.appendChild(create("div", "req__ms-main", total !== undefined ? fmtMs(total) : "-"));
    if (ttfb !== undefined) {
      td.appendChild(create("div", "req__ms-sub", "ttfb " + fmtMs(ttfb)));
    }
    return td;
  }

  /** 速率列：`tps` 一位小数（tok/s），没有统计到就「-」。*/
  function fmtTps(tps) {
    return typeof tps === "number" && tps > 0 ? tps.toFixed(1) : "-";
  }

  /**
   * tokens 列的两行：↑ 产出 / ↓ 输入。复用 `App.format.compact`（≥1000 缩写）：
   * 流式请求的 token 数是六位数，逐位显示会把这一列撑开。
   */
  function tokensCell(record) {
    var td = document.createElement("td");
    var hasInput = typeof record.inputTokens === "number";
    var hasOutput = typeof record.outputTokens === "number";
    if (!hasInput && !hasOutput) {
      td.textContent = "-";
      return td;
    }
    if (hasOutput) td.appendChild(create("div", "req__tok", "↑" + App.format.compact(record.outputTokens)));
    if (hasInput) td.appendChild(create("div", "req__tok req__tok--in", "↓" + App.format.compact(record.inputTokens)));
    return td;
  }

  /**
   * 错误列的展示码：`errorCode` 是服务端按失败现场分类打的标；没有它的记录
   * → `other`（诚实兜底，不猜消息文案）。
   */
  function errorCodeOf(record) {
    return typeof record.errorCode === "string" && record.errorCode !== "" ? record.errorCode : "other";
  }

  /** 展开行的失败说明：用户词 + detail 原文（detail 是排障用的，不是用户词）。*/
  function errorDetailLine(record) {
    return "✗ " + t("errorCode." + errorCodeOf(record)) + " " + (typeof record.error === "string" ? record.error : "");
  }

  /**
   * 端点路径：`record.upstreamUrl` 的 path 部分（「请求」列的第二行）。
   *
   * 为什么取上游而不是入站路径：这一列要回答的是「这次打到哪个端点」——端点改写
   * （`endpoint-routing.ts` 把 anthropic 端点改到 `/api/v1/ultra*`）之后，入站
   * `/v1/messages` 已经说明不了这一点。没走到出线的记录（绝大多数失败出口）没有
   * `upstreamUrl`，退回 `-`：猜一个不如留空。
   */
  function endpointPath(record) {
    if (typeof record.upstreamUrl !== "string" || record.upstreamUrl === "") return "-";
    var withoutQuery = record.upstreamUrl.split("?")[0].split("#")[0];
    var match = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)$/i.exec(withoutQuery);
    return match ? match[1] : withoutQuery;
  }

  /**
   * 账号名 → 身份色点下标（1..`REQUEST_IDENTITY_DOTS`）。
   *
   * 用确定性哈希而不是「第几个见到的账号」：后者会随拉到的记录顺序变，刷新一次
   * 同一个账号就换色，色点就从「标识」退化成「噪音」。字符串哈希取模在同一台机器
   * 上永远给同一个值，两个页签也对得上。
   */
  function identityDotIndex(label) {
    var hash = 0;
    for (var i = 0; i < label.length; i++) {
      hash = (hash * 31 + label.charCodeAt(i)) % 1000003;
    }
    return (hash % C.REQUEST_IDENTITY_DOTS) + 1;
  }

  /**
   * 请求列：两行——流式/批量与路由、端点路径。
   *
   * 「账号」列与它是同一轮重组出来的：账号 → 来源（色点 + 名），路由·协议 →
   * 请求（形态 + 路由 + 端点路径），再加缓存 / 推理强度 / 重试三列，总共十四列。
   * 协议（anthropic / openai）仍在展开头里写着，不需要在表里再占一行。
   */
  function requestCell(record) {
    var td = document.createElement("td");
    var head = create("div", "req__req-head");
    head.appendChild(
      create(
        "span",
        record.stream ? "req__req-mode req__req-mode--stream" : "req__req-mode",
        t(record.stream ? "logs.requests.mode.stream" : "logs.requests.mode.batch"),
      ),
    );
    if (record.route) head.appendChild(create("span", "req__req-route", record.route));
    td.appendChild(head);
    var path = create("div", "req__req-path", endpointPath(record));
    if (record.upstreamUrl) path.setAttribute("title", record.upstreamUrl);
    td.appendChild(path);
    return td;
  }

  /**
   * 来源列：色点 + 账号名。
   *
   * 色点只负责「同一个账号看起来是同一种颜色」（`identityDotIndex`），不携带任何
   * 健康 / 状态语义：那一类信息在状态列与账号页，这里染成红绿会让人误读（语义色只说明状态）。
   */
  function sourceCell(record) {
    var td = document.createElement("td");
    if (!record.account) {
      td.textContent = "-";
      return td;
    }
    var wrap = create("div", "req__source");
    wrap.appendChild(create("span", "req__source-dot req__source-dot--" + identityDotIndex(record.account)));
    wrap.appendChild(create("span", "req__source-name", record.account));
    td.appendChild(wrap);
    return td;
  }

  /**
   * 三列是否折叠：≤1440 时缓存 / 推理强度 / 重试进展开行。
   *
   * 判定只读视口宽，不读 DOM（`display: none` 在 happy-dom 里也不参与布局）：
   * 浏览器都有 `matchMedia`，没有就退成「不折叠」（宽屏行为）。
   */
  function extraColumnsFolded() {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(C.REQUEST_FOLD_MEDIA).matches;
  }

  /**
   * 展开行 / 表尾行要跨的列数：折叠后少三列。
   *
   * 折叠是 CSS 做的（`display: none`），表里实际只有十一列，所以 `colSpan` 不能
   * 继续写十四——那是靠浏览器截断余量才能看对，而截断行为不在规范的可依赖面上。
   */
  function requestColumnSpan() {
    return C.REQUEST_COLUMN_COUNT - (extraColumnsFolded() ? C.REQUEST_FOLDED_COLUMN_COUNT : 0);
  }

  /**
   * 缓存列（口径与统计页对齐）：命中率一行、命中/写入一行。
   *
   * 分母是**本条记录**的 `input + read + creation`（见文件头的口径说明）。三个桶
   * 都是**在场即有效**（`undefined` 是上游没报，`0` 是明确零命中）；read 与
   * creation 都不在场时整格是 `-`，分母为 0 时给 `0%`。
   */
  function cacheCell(record) {
    /* 这一列在 ≤1440 折叠（`req__col--extra`），CSS 隐藏它。*/
    var td = document.createElement("td");
    td.className = "req__col--extra";
    var read = record.cacheReadTokens;
    var creation = record.cacheCreationTokens;
    var input = record.inputTokens;
    var hasRead = typeof read === "number";
    var hasCreation = typeof creation === "number";
    var hasInput = typeof input === "number";
    if (!hasRead && !hasCreation) {
      td.textContent = "-";
      return td;
    }
    var denominator = (hasRead ? read : 0) + (hasCreation ? creation : 0) + (hasInput ? input : 0);
    var rate = denominator > 0 ? (hasRead ? read : 0) / denominator : 0;
    var rateNode = create("div", "req__cache-rate", Math.round(rate * 100) + "%");
    rateNode.setAttribute("title", t("logs.requests.cache.hint"));
    td.appendChild(rateNode);
    /* 副行里不在场的那个桶给 `-` 而不是 `0`：`0/0` 看起来像「两个桶都报了零」，
       而实际往往是「上游只报了命中的那个」。 */
    td.appendChild(
      create(
        "div",
        "req__cache-split",
        (hasRead ? App.format.compact(read) : "-") + "/" + (hasCreation ? App.format.compact(creation) : "-"),
      ),
    );
    return td;
  }

  /**
   * 缓存列的一行摘要：`72% · 1.2万 / 4千`，给折叠后的展开行用。
   *
   * 口径与 `cacheCell` 逐字一致（命中率 + 命中/写入两个桶）：两个渲染点读同一组字段，
   * 一份算式拆成两处就迟早对不上。两个桶都不在场时返回 `undefined`（那一项整项不画），
   * 与格子里的 `-` 同一个含义。
   */
  function cacheSummary(record) {
    var read = record.cacheReadTokens;
    var creation = record.cacheCreationTokens;
    var hasRead = typeof read === "number";
    var hasCreation = typeof creation === "number";
    if (!hasRead && !hasCreation) return undefined;
    var denominator = (hasRead ? read : 0) + (hasCreation ? creation : 0);
    var rate = denominator > 0 ? (hasRead ? read : 0) / denominator : 0;
    var split = (hasRead ? App.format.compact(read) : "-") + "/" + (hasCreation ? App.format.compact(creation) : "-");
    return Math.round(rate * 100) + "% · " + split;
  }

  /**
   * 推理强度列：`reasoningEffort` 一枚小片（关 / 低 / 中 / 高）。
   *
   * 客户端没表达思考意图的请求没有这个键，也没有「关」这个值——两种都是 `undefined`，
   * 统一显示 `-`，不拿「关」冒充「没说」。未知取值（上游多一档）也退成 `-`，
   * 不在面板上硬猜。
   */
  function effortCell(record) {
    /* ≤1440 折叠列，值在展开行的「推理强度」一项里。*/
    var td = document.createElement("td");
    td.className = "req__col--extra";
    var effort = record.reasoningEffort;
    if (typeof effort !== "string" || !Object.prototype.hasOwnProperty.call(C.REQUEST_EFFORT_CLASS, effort)) {
      td.textContent = "-";
      return td;
    }
    td.appendChild(create("span", C.REQUEST_EFFORT_CLASS[effort], t("logs.requests.effort." + effort)));
    return td;
  }

  /**
   * 重试列：`upstreamAttempts > 1` 才有值（`×3`）。
   *
   * 与展开行的「换号」（`retries`）分工：那个数换了几次号，这个数上游被打了几次
   * （连接重试 / 加速卡退回 / captcha / 换号都算）。一次成功的请求恒为 1，所以
   * `-` 是常态。字段缺席时同样给 `-`。
   */
  function attemptsCell(record) {
    /* ≤1440 折叠列（`-` 也一样占位：折叠是整列一起走，不是逐格判断）。*/
    var attempts = record.upstreamAttempts;
    var td;
    if (typeof attempts !== "number" || attempts <= 1) td = cell("-");
    else td = cell("×" + attempts);
    td.className = "req__col--extra";
    return td;
  }

  /** 客户端断开的标记：与上游失败分开，中性格而不是 danger。*/
  function abortedMark() {
    var mark = create("span", "req__aborted", t("logs.requests.aborted"));
    mark.setAttribute("title", t("logs.requests.aborted.hint"));
    return mark;
  }

  /**
   * 状态列：状态码徽章 + 客户端断开标记。
   *
   * 有状态码就按状态码上色（2xx 绿 / 4xx 橙 / 5xx 红）——即使这一轮是客户端断的，
   * 上游确实回过那个码，两个事实都要看得见，所以断开另挂一枚中性标记。没有状态码
   * 又断了（还没出线或刚出线就断）时，整格就是「断开」：那不是「进行中」，也不是
   * 上游失败。
   */
  function statusCell(record) {
    var td = document.createElement("td");
    td.appendChild(statusBadge(record));
    if (record.clientAborted && typeof record.status === "number") td.appendChild(abortedMark());
    return td;
  }

  function cell(text) {
    var td = document.createElement("td");
    td.textContent = String(text);
    return td;
  }

  /* ---- 行与展开详情 ------------------------------------------------------ */

  /**
   * 表格的一行：十四列。整行可点，点开是阶段时间线。
   *
   * 失败的行加 `req__row--error`（行内标识用 danger 系）：不是给整个行染红底，而是
   * 让 reqId 一眼看得出这一行有问题（danger 系留给失败）。客户端断开的行
   * 走 `--aborted`（中性）：abort 时上游那条 fetch 也报错，但它不是「上游失败」，
   * 这正是 `clientAborted` 字段要分开的两件事。
   */
  function requestRow(record) {
    var row = document.createElement("tr");
    row.setAttribute("data-req-id", record.reqId);
    row.className = "req__row";
    if (record.clientAborted) row.className += " req__row--aborted";
    else if (record.failedStage !== undefined) row.className += " req__row--error";

    var time = document.createElement("td");
    /* 时间列是一列同宽的数字（HH:MM:SS），补 tabular-nums 之后
       上下行的秒数才对得齐。 */
    time.className = "req__time";
    time.textContent = formatRequestTime(record.startedAt);
    row.appendChild(time);

    var reqId = document.createElement("td");
    reqId.className = "req__id";
    reqId.textContent = record.reqId;
    row.appendChild(reqId);

    row.appendChild(requestCell(record));
    row.appendChild(sourceCell(record));
    row.appendChild(cell(record.model || C.REQUEST_UNKNOWN_MODEL));
    row.appendChild(statusCell(record));
    row.appendChild(durationCell(record));
    row.appendChild(cacheCell(record));
    row.appendChild(effortCell(record));
    row.appendChild(attemptsCell(record));
    var tpsCell = cell(fmtTps(record.tps));
    /* 速率列同样是一列数字（`12.5` / `-`），等宽对齐才比得出来。 */
    tpsCell.className = "req__tps";
    row.appendChild(tpsCell);
    row.appendChild(tokensCell(record));

    var key = document.createElement("td");
    key.className = "req__key";
    key.textContent = record.apiKeyId ? record.apiKeyId : "—";
    row.appendChild(key);

    var error = document.createElement("td");
    if (requestFailed(record)) {
      var code = errorCodeOf(record);
      var word = create("div", "req__error", t("errorCode." + code));
      word.setAttribute("title", typeof record.error === "string" ? record.error : "");
      error.appendChild(word);
      error.appendChild(create("div", "req__error-hint", t("errorCode." + code + ".hint")));
    } else {
      error.textContent = "-";
    }
    row.appendChild(error);

    row.addEventListener("click", function () {
      toggleExpand(record.reqId);
    });
    return row;
  }

  /** 点一行：展开它（收起之前展开的那个）；再点一次收起。*/
  function toggleExpand(reqId) {
    expandedReqId = expandedReqId === reqId ? null : reqId;
    App.views.logs.render();
  }

  /** 收起展开行（清空视图缓冲时用：记录没了，展开的锚点也不该留着）。*/
  function resetExpanded() {
    expandedReqId = null;
  }

  /**
   * 展开行的头：`#w16c-003  work-team · start-plan · anthropic · glm-5.3-flash · 200 · 2.9s`。
   *
   * 每段都可有可无（字段缺失就跳过），分隔符统一是 ` · `；状态还是 `…` 时照写。
   */
  function expandHead(record) {
    var parts = [record.reqId];
    if (record.account) parts.push(record.account);
    if (record.route) parts.push(record.route);
    if (record.format) parts.push(record.format);
    if (record.model && record.model !== C.REQUEST_UNKNOWN_MODEL) parts.push(record.model);
    parts.push(typeof record.status === "number" ? String(record.status) : C.REQUEST_STATUS_PENDING);
    if (typeof record.totalMs === "number" || typeof record.ttfbMs === "number") {
      parts.push(fmtMs(typeof record.totalMs === "number" ? record.totalMs : record.ttfbMs));
    }
    return parts.join(" · ");
  }

  /**
   * 展开行的元信息：表格列放不下的字段（key 归因 / 上游地址 / 换号 / 上游尝试次数 /
   * 排队 / 推理强度 / 请求体与响应体）与转储提示。一项是一对 `k: v`，字段缺失就
   * 整项跳过。
   *
   * 四个字段是后补进来的：它们要么是「为什么慢」的直接原因（排队、尝试次数），
   * 要么是「客户端到底要了什么」（推理强度），表格列宽装不下，放在展开行里正好。
   */
  function expandMeta(record) {
    var holder = create("div", "req__meta");
    function item(labelKey, value) {
      if (value === undefined || value === null || value === "") return;
      var item = create("span", "req__meta-item");
      item.appendChild(create("span", "req__meta-k", t(labelKey) + ": "));
      item.appendChild(create("span", "req__meta-v", String(value)));
      holder.appendChild(item);
    }
    function bytes(value) {
      return typeof value === "number" && value > 0 ? value + " B" : undefined;
    }
    item("logs.requests.detail.key", record.apiKeyId || undefined);
    item("logs.requests.detail.upstream", record.upstreamUrl);
    item("logs.requests.detail.effort", record.reasoningEffort);
    /* 面板覆盖命中的档位（undefined = 透传或不在作用范围，整项不出现）。
       显示原词（low/high/max/off）——四个值本身就是最短的说明，不另做映射。 */
    item("logs.requests.detail.effortOverride", record.reasoningEffortOverride);
    item("logs.requests.detail.retries", record.retries ? String(record.retries) : undefined);
    item("logs.requests.detail.attempts", typeof record.upstreamAttempts === "number" ? String(record.upstreamAttempts) : undefined);
    /* 缓存：≤1440 时「缓存」那一列折叠进这里，宽屏上它在行里、这里不重复。*/
    if (extraColumnsFolded()) item("logs.requests.col.cache", cacheSummary(record));
    item("logs.requests.detail.queue", typeof record.queueMs === "number" ? fmtMs(record.queueMs) : undefined);
    item("logs.requests.detail.bytes", bytes(record.requestBytes));
    item("logs.requests.detail.responseBytes", bytes(record.responseBytes));
    if (holder.childNodes.length === 0) return null;
    holder.appendChild(create("span", "req__dump-hint", t("logs.requests.detail.dumpHint")));
    return holder;
  }

  /**
   * 一个阶段一行：`✓ intake  0ms  anthropic · stream · 12480 bytes`。
   *
   * 摘要是「人话」不是字段罗列（日志页的可用性优先于字段完整），每个阶段认自己的
   * 字段；认不出的阶段退回 `key=value`（与 CLI `formatStageLine` 同一套词表），
   * 这样服务端加阶段不会让页面显示空白。
   */
  function stageLine(stage, failed) {
    var row = create("div", failed ? "req__stage req__stage--error" : "req__stage");
    row.appendChild(create("span", "req__stage-mark", failed ? "✗" : "✓"));
    row.appendChild(create("span", "req__stage-name", stage.stage));
    row.appendChild(create("span", "req__stage-at", stage.atMs + "ms"));
    row.appendChild(create("span", "req__stage-detail", stageSummary(stage)));
    return row;
  }

  /** 字段摘要的连接符：段与段之间一个 ` · `。*/
  function joinParts(parts) {
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === undefined || parts[i] === null || parts[i] === "") continue;
      out.push(String(parts[i]));
    }
    return out.join(" · ");
  }

  /**
   * 阶段字段 → 一行摘要。字段优先级按「读的人先想问什么」排，
   * 值缺失的段直接跳过。
   */
  function stageSummary(stage) {
    var f = stage.fields || {};
    switch (stage.stage) {
      case "intake":
        return joinParts([f.format, f.stream ? "stream" : "batch", typeof f.bytes === "number" ? f.bytes + " bytes" : undefined]);
      case "dispatch":
        /* 空格分隔的三段 key=value，与终端同一形态。*/
        return [
          f.account ? "account=" + f.account : undefined,
          f.route ? "route=" + f.route : undefined,
          typeof f.queueMs === "number" ? "queue=" + f.queueMs + "ms" : undefined,
        ].filter(function (part) {
          return part !== undefined;
        }).join(" ");
      case "session":
        return joinParts([
          f.source ? "source=" + f.source : undefined,
          typeof f.confidence === "number" ? f.confidence.toFixed(2) : undefined,
          f.sessionId && f.sessionId !== "-" ? String(f.sessionId) : undefined,
        ]);
      case "route-facts":
        return joinParts([
          f.upstreamFormat,
          f.impersonation ? "impersonation" : undefined,
          f.signing ? "signing" : undefined,
          f.captcha ? "captcha" : undefined,
          f.highspeed ? "highspeed" : undefined,
        ]);
      case "body":
        return joinParts([
          typeof f.transformBytes === "number" ? "transform " + f.transformBytes + " bytes" : undefined,
          f.injectZcodeSystem ? "system-prompt" : undefined,
        ]);
      case "highspeed":
        return f.applied ? "card " + (f.cardId || "-") : "no card";
      case "upstream-req":
        return joinParts([
          typeof f.url === "string" ? f.url : undefined,
          typeof f.headerCount === "number" ? f.headerCount + " headers" : undefined,
          f.signed ? "signed" : "unsigned",
        ]);
      case "upstream-resp":
        return joinParts([
          typeof f.status === "number" ? "status " + f.status : undefined,
          typeof f.ttfbMs === "number" ? "ttfb " + f.ttfbMs + "ms" : undefined,
          f.contentEncoding && f.contentEncoding !== "identity" ? String(f.contentEncoding) : undefined,
        ]);
      case "stream-end":
        return joinParts([
          typeof f.tokens === "number" ? f.tokens + " tokens" : undefined,
          typeof f.tps === "number" && f.tps > 0 ? f.tps.toFixed(1) + " t/s" : undefined,
        ]);
      case "retry":
        return joinParts([
          f.reason ? "reason=" + f.reason : undefined,
          f.nextAccount ? "next=" + f.nextAccount : undefined,
          f.nextRoute ? "route=" + f.nextRoute : undefined,
        ]);
      case "translate":
      case "intake-failed":
      case "handler":
        return typeof f.error === "string" ? f.error : joinParts([f.error]);
      default:
        /* 认不出的阶段：`key=value` 罗列（CLI 的时间线同一形态），保证新阶段
           至少可读，而不是空白。*/
        var parts = [];
        for (var key in f) {
          if (!Object.prototype.hasOwnProperty.call(f, key)) continue;
          if (f[key] === undefined || f[key] === null) continue;
          parts.push(key + "=" + (typeof f[key] === "object" ? JSON.stringify(f[key]) : String(f[key])));
        }
        return parts.join(" ");
    }
  }

  /**
   * 展开行：头部 + 元信息 + 阶段时间线（+ 失败请求末尾的错误行）。
   *
   * 时间线直接读 `record.stages`（服务端按发生顺序登记）；失败阶段的那一行
   * 拿 `✗` 与 danger 色，末尾再补一行 `error` 说明原因。
   */
  function expandRow(record) {
    var tr = document.createElement("tr");
    tr.setAttribute("data-req-detail", record.reqId);
    var td = document.createElement("td");
    td.colSpan = requestColumnSpan();
    td.className = "req__detail";

    td.appendChild(create("div", "req__detail-head", expandHead(record)));

    var meta = expandMeta(record);
    if (meta) td.appendChild(meta);

    var stages = Array.isArray(record.stages) ? record.stages : [];
    for (var i = 0; i < stages.length; i++) {
      var failed = stages[i].stage === record.failedStage;
      td.appendChild(stageLine(stages[i], failed));
    }
    if (record.failedStage !== undefined && record.error) {
      td.appendChild(create("div", "req__stage req__stage--error", errorDetailLine(record)));
    }

    tr.appendChild(td);
    return tr;
  }

  /**
   * 表尾的「加载更早」行。`historyHasMore === false` 之后整行收起；
   * 加载中禁点（按钮 disabled，文案换成「加载中」）。行每次随重画重建，点击
   * 监听也随之重挂，分页状态与取数都在 `app-view-logs.js`（这里只拿状态画）。
   */
  function historyRow(state) {
    var tr = document.createElement("tr");
    tr.className = "req__history";
    var td = document.createElement("td");
    td.colSpan = requestColumnSpan();
    var button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.setAttribute("data-action", "load-requests-history");
    button.disabled = state.loading;
    button.textContent = t(state.loading ? "logs.requests.history.loading" : "logs.requests.history.more");
    button.addEventListener("click", state.onLoad);
    td.appendChild(button);
    tr.appendChild(td);
    if (state.hasMore === false) tr.setAttribute("hidden", "");
    return tr;
  }

  /**
   * 重画请求表：记录由调用方按当前过滤器算好（`visible`），这里只铺 DOM。
   *
   * 空表时「加载更早」仍然在：视图缓冲被清空后，它就是把文件里的历史拉回来的入口。
   */
  function render(visible, historyState) {
    var holder = byRole("req-body");
    if (!holder) return;
    clear(holder);

    for (var i = 0; i < visible.length; i++) {
      holder.appendChild(requestRow(visible[i]));
      if (visible[i].reqId === expandedReqId) holder.appendChild(expandRow(visible[i]));
    }

    holder.appendChild(historyRow(historyState));
    setHidden(byRole("req-empty"), visible.length > 0);
  }

  App.logsRequests = {
    filterValue: filterValue,
    requestMatches: requestMatches,
    render: render,
    resetExpanded: resetExpanded,
  };
})(window.__zcodeApp = window.__zcodeApp || {});
