/*
 * app-logs-system-stream.js — 日志页「系统」tab 的日志流：行缓冲、连接状态、
 * 结构化列与重复行折叠。
 *
 * 数据来自 SSE 的 `log` 帧（`app-sse.js` 按 `SSE_EVENT_LOG` 转进 `append`）。
 * 面板不自己拉日志：服务端的 `LogBuffer` 推什么，这里画什么。
 *
 * 本模块只管系统 tab 的日志行。请求事件表在 `app-logs-request-table.js`；两个
 * tab 共用的开关（暂停、当前 tab）与过滤在 `app-view-logs.js`——它读过滤控件、
 * 把可见条目算好传进 `render`，所以本模块不认识任何过滤控件。
 *
 * 结构化条目按 时间 / 级别 / 模块 / 正文 四列对齐（字段来自条目本身，前端不再猜），
 * 连续相同内容（去时间戳后）折叠成一行 + ×N 徽章——config WARN 每秒刷屏就是它
 * 治的。折叠只影响显示：缓冲原样保留全部条目，点击折叠行可展开。
 *
 * 行数上限与服务端 `LogBuffer` 同值（`LOG_LINE_LIMIT`）：DOM 节点数必须有上限，
 * 否则开一夜就是十万行。
 *
 * 信噪比：长行自动折行（续行缩进对齐），正文里的 `key=value` 分段着色
 * （键弱、值深）；`claim tick` 的「没有可领的计划」已在采集侧降为 DEBUG
 * （`claim/scheduler.ts` 的 `holdIdle`），面板不需要额外过滤。
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
  var buildOption = App.forms.buildOption;

  /** 已收到的日志条目（已解析，非原始 SSE 帧），环形上限 `LOG_LINE_LIMIT`。*/
  var logEntries = [];
  /** 当前事件流的连接状态（`logs.conn.*` 的键后缀）。*/
  var logConnState = C.LOG_CONN_CONNECTING;
  /** 账号下拉的当前选项快照：只有账号集合变了才重建（重建会把用户的选择冲掉）。*/
  var logAccountOptions = [];
  /** 模块下拉的当前选项快照：模块来自已收到的条目，集合变了才重建。*/
  var logModuleOptions = [];
  /**
   * 已展开的重复行组（重复折叠的出口）。
   *
   * key 是组内**第一条**的 `seq`：seq 单调，重渲染不漂移；缓冲把那条挤掉之后组
   * 自然散掉，落回默认折叠。折叠只影响显示，不过滤数据。
   */
  var expandedLogRuns = {};

  /**
   * 收一行日志。
   *
   * 暂停只停渲染（主文件按暂停开关决定要不要紧接着重画），行照旧进缓冲；超出容量
   * 挤掉最旧的（与 `LogBuffer` 同口径）。`entry`（结构化条目）原样保留：渲染的
   * 时间 / 级别 / 模块三列与重复折叠的去时间戳键都从它来，没有它的行（早期日志、
   * console tee 的历史行）退回原文。
   */
  function append(entry) {
    logEntries.push({
      seq: entry.seq,
      level: normalizeLogLevel(entry.level),
      account: entry.account || C.LOG_ACCOUNT_ALL,
      /* `mod` 只有结构化条目才有（logger 写的行）。早期日志与 console tee 抓的
         行没有模块，归到「全部」里按级别与文本过滤即可。*/
      mod: entry.mod || C.LOG_MOD_ALL,
      line: entry.line,
      entry: entry.entry,
    });
    if (logEntries.length > C.LOG_LINE_LIMIT) logEntries.splice(0, logEntries.length - C.LOG_LINE_LIMIT);
  }

  /** 当前缓冲。主文件按它过过滤器；只读，不要替换或改写这个数组。*/
  function entries() {
    return logEntries;
  }

  /**
   * 级别归一：四个级别原样保留，未知值当 info（不造第五条颜色档，语义色只说明状态）。
   *
   * `debug` 必须单独认出来：阶段打点全落在这一档，若把它归成 info，级别过滤器上
   * 的「调试」就永远选不出东西（而且选 info 时反而会把 debug 一起显示）。
   */
  function normalizeLogLevel(level) {
    return level === "debug" || level === "warn" || level === "error" ? level : "info";
  }

  /* ---- 连接状态 ---------------------------------------------------------- */

  /** 记下连接状态并落到 DOM。只有一个地方写这个状态，避免两处显示对不上。*/
  function setConnection(next) {
    logConnState = next;
    renderConnection();
  }

  /** 连接状态到圆点加文案（`logs.conn.*`）。语言切换后由主文件的 renderControls 再落一遍。*/
  function renderConnection() {
    var dot = byRole("log-conn-dot");
    if (dot) dot.className = C.LOG_CONN_DOT_CLASS[logConnState];
    setText("log-conn", t("logs.conn." + logConnState));
  }

  /* ---- 系统 tab 的两个下拉 ---------------------------------------------- */

  /** 账号下拉：账号集合变了才重建（每拍重建会把用户选中的项冲掉）。*/
  function syncAccounts(accounts) {
    var labels = [];
    for (var i = 0; i < accounts.length; i++) labels.push(accounts[i].label);

    var signature = labels.join("\u0000");
    if (signature === logAccountOptions.join("\u0000")) return;
    logAccountOptions = labels;

    var select = byRole("log-account");
    if (!select) return;
    var previous = select.value;
    clear(select);
    select.appendChild(buildOption(C.LOG_ACCOUNT_ALL, t("logs.account.all")));
    for (var j = 0; j < labels.length; j++) select.appendChild(buildOption(labels[j], labels[j]));
    /* 选中的账号还在就保留，不在了就回到「全部」 */
    select.value = labels.indexOf(previous) >= 0 ? previous : C.LOG_ACCOUNT_ALL;
  }

  /** 选项快照作废后强制重建（语言切换会改「全部」这一项文案）。*/
  function resetAccounts(accounts) {
    logAccountOptions = [];
    syncAccounts(accounts);
  }

  /**
   * 模块下拉：选项来自已经收到的条目。
   *
   * 服务端没有一份"已知模块"清单（模块是代码里的字符串，加一个新模块不该要改面板），
   * 所以按已见集合重建。顺序取首次出现顺序：调试时人脑里的顺序就是时间顺序。
   * 「全部模块」这一项的文案进了签名，语言切换时才会重建。
   */
  function syncModules() {
    var signature = t("logs.mod.all") + "\u0000";
    var seen = [];
    for (var i = 0; i < logEntries.length; i++) {
      var mod = logEntries[i].mod;
      if (!mod || seen.indexOf(mod) >= 0) continue;
      seen.push(mod);
    }
    signature += seen.join("\u0000");
    if (signature === logModuleOptions.join("\u0000")) return;
    logModuleOptions = [t("logs.mod.all")].concat(seen);

    var select = byRole("log-mod");
    if (!select) return;
    var previous = select.value;
    clear(select);
    select.appendChild(buildOption(C.LOG_MOD_ALL, t("logs.mod.all")));
    for (var j = 0; j < seen.length; j++) select.appendChild(buildOption(seen[j], seen[j]));
    /* 选中的模块还在就保留，不在了就回到「全部」 */
    select.value = seen.indexOf(previous) >= 0 ? previous : C.LOG_MOD_ALL;
  }

  /* ---- 结构化列与重复折叠 ------------------------------------------------- */

  /**
   * 结构化条目的正文：把服务端已经拼好的行前缀（`HH:MM:SS LEVEL [mod] `）剥掉，
   * 剩下的部分与终端一字不差。前缀认两种形状（text 的全拼级别、compact 的单字母），
   * 认不出的行（json 格式、历史行）退回原文——显示上多一截前缀，好过丢内容。
   */
  function lineBody(line) {
    /* 级别标签定宽（text 格式 `WARN ` 补齐 5 字符），所以 level 与 `[mod]` 之间
       可能是两个空格；compact 是单字母 + 一个空格。`+` 都兜住。 */
    var match = /^\d{2}:\d{2}:\d{2} +(?:DEBUG|INFO|WARN|ERROR|D|I|W|E) +\[[^\]]*\] ?/.exec(line);
    return match ? line.slice(match[0].length) : line;
  }

  /**
   * 重复折叠的键：「去时间戳后的内容」。结构化条目直接用字段拼（级别 + 模块 +
   * 正文），纯文本行剥掉行首的钟点——同一句话在第 0 秒和第 1 秒打出是同一条日志，
   * 只差在时间戳上。
   */
  function repeatKey(item) {
    if (item.entry) return [item.level, item.mod, lineBody(item.line)].join("\u0000");
    return item.line.replace(/^\d{2}:\d{2}:\d{2} /, "");
  }

  /**
   * 正文里的键值对分段（「信噪比」的那一半）。
   *
   * 键压成第三层文字、值提到正文色（`.log__kv--*` 在 `styles/views/logs.css`）：
   * `claim tick account=work-team message="claim: hold 300s — no claimable plans"`
   * 这种行里只有值在变，键每次都一样，把键弱化之后一眼看到的就是「哪个账号、
   * 什么原因」。
   *
   * 认两种值形态：带引号的整段（含转义引号）与非空的连续非空白。前者必须单独
   * 认——`message="claim: hold 300s"` 里有空格，按空白切会把一句原因拆成好几个
   * 「键=值」的碎片。匹配不上的部分原样当文本节点插入（没有 `innerHTML`，日志正文
   * 永远不经 HTML 解析）。
   */
  var KV_PATTERN = /([A-Za-z_][A-Za-z0-9_.-]*)=("(?:[^"\\]|\\.)*"|\S*)/g;

  function appendSegments(holder, text) {
    KV_PATTERN.lastIndex = 0;
    var last = 0;
    var match;
    while ((match = KV_PATTERN.exec(text)) !== null) {
      if (match.index > last) holder.appendChild(document.createTextNode(text.slice(last, match.index)));
      holder.appendChild(create("span", "log__kv log__kv--key", match[1] + "="));
      holder.appendChild(create("span", "log__kv log__kv--val", match[2]));
      last = match.index + match[0].length;
    }
    if (last === 0) {
      holder.textContent = text;
      return;
    }
    if (last < text.length) holder.appendChild(document.createTextNode(text.slice(last)));
  }

  /** Add a structured claim reason as a user word; the raw line stays intact. */
  function appendClaimReason(row, body, reason) {
    var label = t("logs.claim.reason.label") + "=" + App.claimActivityState.logReasonText(reason);
    body.appendChild(create("span", "log__kv log__kv--key", label));
    body.appendChild(document.createTextNode(" "));
    body.appendChild(create("span", "log__kv log__kv--val", "(" + reason + ")"));
    row.setAttribute("data-claim-reason", String(reason));
  }

  /**
   * 一行日志的 DOM。结构化条目按 时间 / 级别 / 模块 / 正文 四列对齐
   * （tabular 时间列，模块弱化）；没有条目的行退回原文一段。
   *
   * 正文里的 `key=value` 分段着色；整段原文的行加 `--plain` 拿悬挂缩进
   * （续行不会顶回行首，与结构化行的第 4 列对齐是同一个目的）。
   */
  function logLineNode(item) {
    var row = create("div", C.LOG_LINE_CLASS[item.level]);
    if (item.entry && typeof item.entry.ts === "number") {
      row.className += " log__row";
      var time = create("span", "log__time", localTime(item.entry.ts));
      var level = create("span", "log__level log__level--" + item.level, item.level.toUpperCase());
      var mod = create("span", "log__mod", "[" + item.mod + "]");
      var body = create("span", "log__msg");
      appendSegments(body, lineBody(item.line));
      var reason = item.entry && item.entry.fields && item.entry.fields.reason;
      if (typeof reason === "string") appendClaimReason(row, body, reason);
      row.appendChild(time);
      row.appendChild(level);
      row.appendChild(mod);
      row.appendChild(body);
      return row;
    }
    row.className += " log__line--plain";
    row.textContent = item.line;
    return row;
  }

  /**
   * 渲染一段连续相同内容的条目（重复折叠）。
   *
   * 一组只显示最后一行（时间戳最新、最有代表性）+ ×N 徽章；点开（`expandedLogRuns`）
   * 就整组原样展开——折叠只影响显示，不过滤数据。返回占用的显示行数。
   *
   * 点击后的重画走日志页的渲染入口（`App.views.logs.render`）：过滤与 tab 分派在
   * 那边，这里只改折叠状态。
   */
  function renderLogRun(holder, visible, start, length) {
    var firstSeq = String(visible[start].seq);
    if (length <= 1 || expandedLogRuns[firstSeq]) {
      for (var i = 0; i < length; i++) {
        var node = logLineNode(visible[start + i]);
        if (length > 1) {
          node.className += " log__line--repeat";
          node.addEventListener("click", function (seq) {
            return function () {
              delete expandedLogRuns[seq];
              App.views.logs.render();
            };
          }(firstSeq));
        }
        holder.appendChild(node);
      }
      return length;
    }
    var row = logLineNode(visible[start + length - 1]);
    row.className += " log__line--repeat";
    row.setAttribute("title", t("logs.repeat.hint", { count: length }));
    row.appendChild(create("span", "log__repeat", "×" + length));
    row.addEventListener("click", function (seq) {
      return function () {
        expandedLogRuns[seq] = true;
        App.views.logs.render();
      };
    }(firstSeq));
    holder.appendChild(row);
    return 1;
  }

  /**
   * 重画整块日志（最多 `LOG_LINE_LIMIT` 行；重画比增量维护简单且不会跑偏）。
   *
   * `visible` 是主文件按当前四个过滤控件筛过的条目；游程编码只对可见行做——
   * 折叠是显示层的事，过滤器选中什么就折叠什么。
   */
  function render(visible) {
    syncModules();
    var holder = byRole("log-lines");
    if (!holder) return;
    var empty = byRole("log-empty");
    clear(holder);

    var shown = 0;
    var index = 0;
    while (index < visible.length) {
      var start = index;
      var key = repeatKey(visible[index]);
      index += 1;
      while (index < visible.length && repeatKey(visible[index]) === key) index += 1;
      shown += renderLogRun(holder, visible, start, index - start);
    }
    setHidden(empty, shown > 0);
    /* 空态不是死胡同：没有日志时把下一步请出来——「去请求事件看记录」。
       这句话在空态里是唯一可点的东西，所以它是一颗真按钮（走 tab 切换，
       与工具栏的 tab 同一条路），不是一句提示。 */
    renderEmptyAction(empty, shown);
    /* 跟随到底部：用户要的就是最新那一行。暂停是往上翻的出口，暂停时不重画，
       也就不抢滚动位置。*/
    holder.scrollTop = holder.scrollHeight;
  }

  /**
   * 系统日志空态里的那颗「下一步」。
   *
   * 只在空态可见时挂上去；有日志时整块空态本来就被 `hidden` 收掉了。按钮只在
   * 第一次渲染时建（`data-role="log-empty-action"`），之后只刷新文案——重画每拍
   * 都跑，反复重建按钮会让键盘焦点在空态上丢失。
   */
  function renderEmptyAction(empty, shown) {
    if (!empty || shown > 0) return;
    var action = empty.querySelector('[data-role="log-empty-action"]');
    if (!action) {
      action = App.dom.button(t("ui.empty.logsSystem.action"), "btn btn--sm", function () {
        App.views.logs.selectTab(C.LOG_TAB_REQUESTS);
      });
      action.setAttribute("data-role", "log-empty-action");
      empty.appendChild(action);
    }
    action.textContent = t("ui.empty.logsSystem.action");
  }

  /** 清空视图缓冲（服务端的 `LogBuffer` 是别人的日志，不归页面管）。*/
  function clearLogs() {
    logEntries = [];
  }

  /**
   * 本地 HH:MM:SS（与终端表格同一口径：`handler-log.ts` 的 `localTime`）。
   *
   * 两个 tab 共用这一份：系统日志行的时间列与请求表的时间列（
   * `app-logs-request-table.js` 的 `formatRequestTime`）是同一个口径，拆成两份
   * 迟早对不上。
   */
  function localTime(ms) {
    var d = new Date(ms);
    function pad(n) {
      return n < 10 ? "0" + n : String(n);
    }
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  App.logsStream = {
    append: append,
    entries: entries,
    render: render,
    setConnection: setConnection,
    renderConnection: renderConnection,
    syncAccounts: syncAccounts,
    resetAccounts: resetAccounts,
    syncModules: syncModules,
    clear: clearLogs,
    localTime: localTime,
  };
})(window.__zcodeApp = window.__zcodeApp || {});
