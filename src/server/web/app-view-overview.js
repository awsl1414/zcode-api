/*
 * app-view-overview.js — 概览页：指标卡、今日 token 时序缩略、并发曲线，
 * 以及概览页那份只读的账号摘要表。顶栏的运行状态也由这里写（见 `renderServer`）。
 *
 * 输入有两路：`/api/state` 载荷（健康数、在飞、并发上限都是服务端算好的聚合）与
 * `getUsageStats` 控制命令（今日四卡与时序缩略——不在 /api/state 轮询载荷里，
 * 由本视图自己拉，见下方取数节奏）。曲线的峰值是样本里的最大值。
 *
 * 两张图表的空态：图框常驻，没有数据时画基线加一行提示——
 * 「没有数据就不占地方」对图表块改成只收提示行之外的装饰，
 * 基线与提示保留，图不画；账号摘要表仍是「一个账号都没有就不画空表格」。
 * 今日 token 缩略图同一条纪律。
 *
 * 账号摘要表与账号页的表格是两张不同的表：这里只有六列只读信息，账号页那份带
 * 步进器、权重输入与操作按钮。两者数据同源但用途不同，所以各自渲染。
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
  var lookup = App.i18n.lookup;
  var formatUptime = App.format.uptime;
  var compact = App.format.compact;
  var units = App.format.units;

  /* ---- 今日用量：getUsageStats 的取数节奏 -------------------------------- */

  /*
   * 今日四卡与时序缩略的数据源是控制命令 `getUsageStats`（服务端的用量聚合器）：
   * `from` = 本地零点、`to` = 当下。它不在 `/api/state` 轮询载荷里，拉取由
   * 这里自己安排：
   *
   *   - 进概览页（页面加载）后第一拍拉一次；
   *   - 之后跟着 /api/state 的每一拍做**节流重拉**：距上次成功超过 60s 才
   *     真正发命令。今日卡与在飞数同屏，「5 秒内的请求不进卡」比「卡上
   *     一整天不变」难看，但每 5 秒扫一遍 JSONL 也不值得——60s 是两边都
   *     能接受的折中（统计视图才是精确取数的地方，卡片上的「今日」本来
   *     就是报表口径）。
   *   - 只在概览是当前视图时拉（renderState 把载荷分发给所有视图，其它页
   *     上不应发出概览的命令）。
   *   - 失败静默：卡片保持「—」，图表区显示错误提示；下一拍节流到了会重试。
   *     概览页不为了报表再放一条错误横幅（那是统计视图的职责）。
   *   - 顶栏刷新传 `force`：用户按了刷新就是要现在重新算，不节流。
   */
  var USAGE_REFRESH_MS = 60 * 1000;
  /** 最近一次今日聚合（null = 还没拿到）。 */
  var usage = null;
  /** 是否已经拉完过一次（成功或失败）——决定空区显示「加载中」还是结论。 */
  var usageDone = false;
  var usageInFlight = false;
  /** 上次成功拉取的时刻；节流的基准。 */
  var usageAt = 0;

  /** 本地零点（「今天」的起点；数据层按 UTC 取整桶，范围边界归 UI）。 */
  function localDayStart(ms) {
    var d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function refreshUsage(force) {
    if (App.state.activeView !== C.VIEW_OVERVIEW) return;
    if (usageInFlight) return;
    if (!force && usageDone && Date.now() - usageAt < USAGE_REFRESH_MS) return;
    usageInFlight = true;
    return App.api.sendControl({ cmd: "getUsageStats", from: localDayStart(Date.now()), to: Date.now() }).then(function (body) {
      usageInFlight = false;
      usageDone = true;
      if (body && body.ok && body.event === "usageStats" && body.stats) {
        usage = body.stats;
        usageAt = Date.now();
      }
      renderUsage();
    });
  }

  /** 今日四卡：没有数据（还在加载 / 命令失败）时保持「—」。*/
  function renderUsageCards() {
    var totals = usage ? usage.totals : null;
    setText("usage-requests", totals ? compact(totals.requests) : "—");
    setText("usage-tokens", totals ? units(totals.inputTokens + totals.outputTokens) : "—");
    setText("usage-avg-rate", totals && totals.avgTps !== undefined ? totals.avgTps.toFixed(1) + " tok/s" : "—");
    setText("usage-errors", totals ? compact(totals.errorCount) : "—");
  }

  /**
   * 错误数卡下方的阶段分布：今日 `errors[]` 按 `stage` 折叠成一行小字，
   * 每个阶段各是一条链接，跳日志页的请求事件 tab 并把阶段筛选器预置成它
   * （`?stage=`）。可见文字用 `errorCode.*` 的用户词，原始阶段码进 `title`。
   *
   * 没错误就是空：这一行不画占位符（「没有失败」本身就是错误数卡上那个 0）。
   */
  function renderErrorStages() {
    var holder = byRole("usage-error-stages");
    if (!holder) return;
    clear(holder);

    var folded = foldStages(usage ? usage.errors : null);
    for (var i = 0; i < folded.length; i++) {
      /* 分隔符写带空格的「 · 」而不是靠 flex gap：读屏器与 textContent 拿到的是
          「upstream-resp 3 · dispatch 2」这一句，不是「3·dispatch」。*/
      if (i > 0) holder.appendChild(create("span", null, " · "));
      var stage = folded[i].stage;
      var stageLabel = stageText(stage);
      var link = create("a", "card__stage", stageLabel + " " + compact(folded[i].count));
      link.href = logsStageHref(stage);
      /* 实现词只留在 title 与链接参数里；可访问名说清跳到哪里，免得几条链接
         都读成一样的三段英文。 */
      link.title = stage;
      link.setAttribute("aria-label", t("overview.errors.stageLink", { stage: stageLabel, count: compact(folded[i].count) }));
      holder.appendChild(link);
    }
    setHidden(holder, folded.length === 0);
  }

  /** 阶段码 → 用户词；没有对应项时给一句通用词，不把内部码露在可见文案里。*/
  function stageText(stage) {
    var text = lookup("errorCode." + stage);
    if (text !== undefined) return text;
    return t("overview.errors.stage", { stage: t("errorCode.other") });
  }

  /** `errors[]` → 按阶段折叠、按次数降序（概览的阶段链接，不是统计页的分类口径）。*/
  function foldStages(rows) {
    var counts = {};
    var order = [];
    var list = Array.isArray(rows) ? rows : [];
    for (var i = 0; i < list.length; i++) {
      var stage = list[i].stage;
      if (typeof stage !== "string" || stage === "") continue;
      if (counts[stage] === undefined) {
        counts[stage] = 0;
        order.push(stage);
      }
      counts[stage] += list[i].count || 0;
    }
    var folded = [];
    for (var j = 0; j < order.length; j++) folded.push({ stage: order[j], count: counts[order[j]] });
    folded.sort(function (a, b) {
      return b.count - a.count;
    });
    return folded;
  }

  /** 一个阶段 → 日志页的请求事件 tab，预置阶段筛选。*/
  function logsStageHref(stage) {
    return (
      C.ROUTE_PATH_LOGS +
      "?tab=" +
      C.LOG_TAB_REQUESTS +
      "&" +
      C.LOGS_STAGE_QUERY_KEY +
      "=" +
      encodeURIComponent(stage)
    );
  }

  /**
   * 今日 token 时序缩略：今日小时桶的入/出堆叠柱（app-charts.js 自绘，
   * 紧凑高度）。图框常驻：没有数据时画基线（`.chart__plot` 的下边框）加
   * 一行提示——「图上没有东西」不再收起整块框体。空态与加载态共用同一行提示：
   * 拉取中、命令失败、今天还没有请求，三种「图上没有东西」各说各的话。
   * 图例与合计行只在有柱子时出现。
   */
  function renderUsageChart() {
    var holder = byRole("usage-chart");
    var empty = byRole("usage-empty");
    var legend = byRole("usage-legend");
    if (!holder) return;
    clear(holder);

    var hourly = usage && Array.isArray(usage.hourly) ? usage.hourly : [];
    var hasBars = false;
    for (var i = 0; i < hourly.length; i++) {
      if ((hourly[i].inputTokens || 0) + (hourly[i].outputTokens || 0) > 0) hasBars = true;
    }
    holder.appendChild(
      App.charts.stackedBars(hourly, { height: 72, label: usageBucketTitle, tick: units }),
    );
    setHidden(legend, !hasBars);
    setHidden(empty, hasBars);
    renderUsageLinkLabel(hasBars);
    if (hasBars) {
      setText("usage-total", t("overview.usage.total", { value: units(usage.totals.inputTokens + usage.totals.outputTokens) }));
      return;
    }
    /* 三种「图上没有东西」：还没拉完 / 拉失败 / 今天确实还没有请求。 */
    if (!usageDone) empty.textContent = t("overview.usage.loading");
    else if (!usage) empty.textContent = t("overview.usage.error");
    else empty.textContent = t("overview.usage.empty");
  }

  /**
   * 整图链接的可访问名：日期 + 当天合计。
   *
   * `axe:link-name` 报的正是这里——链接内部只有 SVG 的坐标轴刻度，`<svg>` 又是
   * `aria-hidden`，于是链接对读屏器没有名字。名字取真实数据（同一次
   * `getUsageStats` 的合计）；还没有数字时只说日期与「打开统计」，
   * 不拿「今天还没有请求」冒充合计（那时候它可能只是还在加载或已经失败）。
   */
  function renderUsageLinkLabel(hasBars) {
    var link = byRole("usage-link");
    if (!link) return;
    var today = App.format.date(Date.now());
    var vars = { date: today };
    if (hasBars && usage) vars.total = units(usage.totals.inputTokens + usage.totals.outputTokens);
    link.setAttribute("aria-label", t(hasBars ? "overview.usage.linkLabel" : "overview.usage.linkLabelNoTotal", vars));
  }

  /** 缩略图的悬浮提示：本地 HH:00 + 入出两个数（与统计视图的时序同一形态）。*/
  function usageBucketTitle(bucket) {
    var d = new Date(bucket.bucketStart);
    function pad(n) {
      return n < 10 ? "0" + n : String(n);
    }
    return (
      pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":00" +
      " · ↑" + units(bucket.outputTokens || 0) + " ↓" + units(bucket.inputTokens || 0)
    );
  }

  function renderUsage() {
    renderUsageCards();
    renderErrorStages();
    renderUsageChart();
  }

  /**
   * 风控告警稳定码 → 一句话。未知码原样露出。
   *
   * 映射只有这一份：风控横幅与顶栏圆点的 `title` 都从这里取，两处各写一份迟早会
   * 对不上同一个码。
   */
  function alertText(code) {
    var text = lookup("risk.alert." + code);
    return text === undefined ? code : text;
  }

  /**
   * 侧边栏底部的状态区：
   * `● 127.0.0.1:8090 / v5.0.0 · 在飞 3/8 · 2h 14m`。
   *
   * 圆点反映健康，不表示「运行 / 停止」：能看到这一页就说明网关在跑，那个状态永远是
   * 同一个值，不携带信息。降级（有风控告警）转**红**（健康语义只剩
   * 绿 / 红），`title` 里把告警逐条列出来；告警的提醒色留在概览风控横幅上——那是
   * 「要去处理」的提醒，这里是「现在健康不健康」的状态。
   *
   * 地址的主源是 `window.location.host`：浏览器实际用来打开面板的 host:port。
   * 不用 `/api/system` 的 panelAddress 当主源的理由：它把一切非回环绑定规整到
   * 127.0.0.1（`displayHostname`），从局域网另一台机器打开面板的用户会看到一条
   * 自己用不了、也解释不了「IP 怎么变了」的地址；location.host 永远是本会话真实
   * 可用的那个。回退链：location.host 为空（非 http(s) 环境）时用 shell 存下的
   * panelAddress，再不行退回 `:端口`。
   *
   * 侧边栏在每一页都在，而 `app.js` 每次轮询都会把载荷分发给所有视图，所以哪一页
   * 上它都是最新的。`在飞` 的分子分母取 `metrics`：那是后端按整份账号集合算的聚合。
   */
  function renderServer(server, metrics, alerts) {
    var degraded = alerts.length > 0;
    var dot = byRole("server-dot");
    if (dot) {
      dot.className = "status__dot " + (degraded ? "status__dot--danger" : "status__dot--ok");
      dot.title = degraded ? alerts.map(alertText).join(" · ") : "";
    }

    /* 地址值链：本会话真实地址 > 配置的规整地址 > 端口。 */
    var shell = App.shell;
    var address = window.location.host || (shell && shell.panelAddress) || ":" + server.port;
    setText("server-address", address);
    setText("server-version", "v" + server.version);
    setText("server-inflight", metrics.inflight + "/" + metrics.concurrencyLimit);
    setText("server-uptime", formatUptime(server.uptime));
  }

  /**
   * 四个指标卡：账号与健康数来自 `state.accounts`，在飞与上限来自
   * `state.metrics`（全局租约与 `routing.maxTotalInflight`）。
   *
   * 上限取全局那一档而不是把账号的 `maxConcurrency` 加起来：两个数不是一个东西，
   * 加起来那个（12 个账号 × 2）远大于真正拦住请求的 8，而同一个页面上顶栏的
   * `在飞 3/8` 已经说的是后一个。
   */
  function renderMetrics(accounts, metrics) {
    var healthy = 0;
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].health === "ok") healthy += 1;
    }
    setText("metric-accounts", String(accounts.length));
    setText("metric-healthy", String(healthy));
    setText("metric-inflight", String(metrics.inflight));
    setText("metric-limit", String(metrics.concurrencyLimit));
  }

  function renderChart(history) {
    var chart = byRole("chart");
    var empty = byRole("chart-empty");
    var meta = byRole("chart-meta");
    if (!chart) return;
    clear(chart);

    var samples = history || [];
    var values = [];
    var peak = 0;
    for (var i = 0; i < samples.length; i++) {
      var value = samples[i].inflight;
      values.push(value);
      if (value > peak) peak = value;
    }
    var hasSamples = samples.length > 0;

    /* 三种状态分开说：
       - 没采样：图框留在原地画基线，提示行写「还没有采样」；
       - 有采样但峰值 0：收起图框。96px 的框里只有一条基线和孤零零的 0 刻度，
         空白壳子自己不说话；换成一行可点提示，窗长直接写进那句里；
       - 有数据：画柱，柱子顶到峰值的那一根用实心强调，悬浮提示带采样时刻。 */
    if (hasSamples && peak === 0) {
      setHidden(chart, true);
      setHidden(empty, false);
      clear(empty);
      var jump = create("a", "empty-inline__link", t("overview.chart.zeroHint", { count: samples.length }));
      jump.href = C.ROUTE_PATH_LOGS + "?tab=" + C.LOG_TAB_REQUESTS;
      empty.appendChild(jump);
      /* 「峰值 0」已经在那句提示里，这一行整行收起，不重复第二遍。 */
      setHidden(meta, true);
      return;
    }
    setHidden(chart, false);
    chart.appendChild(
      App.charts.bars(values, {
        height: 96,
        label: function (index) {
          var d = new Date(samples[index].at);
          function pad(n) {
            return n < 10 ? "0" + n : String(n);
          }
          return (
            pad(d.getHours()) + ":" + pad(d.getMinutes()) +
            " · " + t("status.inflight") + " " + values[index]
          );
        },
      }),
    );
    if (!hasSamples) {
      /* 没采样：图框留给基线，提示行写纯文本——没什么可看的日志，不拼链接。
         窗长 / 峰值没有数字可报，整行收起。 */
      setHidden(empty, false);
      clear(empty);
      empty.textContent = t("overview.chart.empty");
      setHidden(meta, true);
      return;
    }
    /* 有柱子：提示行收起，窗长 / 峰值两行按采样如实报。 */
    setHidden(empty, true);
    setHidden(meta, false);
    setText("chart-min", t("overview.chart.window", { count: samples.length }));
    setText("chart-max", t("overview.chart.peak", { value: peak }));
  }

  /**
   * 共用出口分组（「N 个账号共用同一出口」）。
   *
   * 按**生效**代理名分组，同组超过 1 个账号就是一条告警。直连也是一组：两个直连的
   * 账号本来就从本机同一个地址出去，上游看到的是「一个 IP，两个账号」，那正是这一栏
   * 想让人看见的事。继承默认代理与运行时覆盖过的账号都算进它生效的那一组。
   */
  function sharedEgress(accounts) {
    var groups = {};
    var order = [];
    for (var i = 0; i < accounts.length; i++) {
      var name = accounts[i].proxy || C.DIRECT_PROXY;
      if (!groups[name]) {
        groups[name] = [];
        order.push(name);
      }
      groups[name].push(accounts[i].label);
    }
    var shared = [];
    for (var j = 0; j < order.length; j++) {
      if (groups[order[j]].length > 1) shared.push({ name: order[j], labels: groups[order[j]] });
    }
    return shared;
  }

  /**
   * 风控告警横幅：有告警才出现，没有就整条收起（不渲染空容器）。
   *
   * 告警从两个来源合成一条：后端算出来的稳定码与页面自己按 `accounts[].proxy`
   * 分出来的共用出口组。两类都用 ` · ` 连起来，横幅只占一行。
   *
   * 每条告警自己带落点——风控码说的是账号层面的事（冷却 / 额度 / deviceMid），
   * 去账号页；共用出口说的是出口配置，同样去账号页——代理没有自己的页面，
   * 它的管理入口是账号页页头的「出口代理」抽屉（`?proxies=1`，账号页进页面时
   * 消费一次并直接展开）。所以横幅本体不再是单条链接，而是把每条告警拼成一条
   * `<a>`（文字部分仍然是同一行，`data-role="risk-text"` 的 textContent 不变）。
   */
  function renderRisk(alerts, accounts) {
    var banner = byRole("risk-banner");
    var holder = byRole("risk-text");
    if (!banner || !holder) return;
    clear(holder);

    var shared = sharedEgress(accounts);
    var items = [];
    for (var i = 0; i < alerts.length; i++) {
      items.push({ text: alertText(alerts[i]), href: C.ROUTE_PATH_ACCOUNTS });
    }
    /* 共用出口是页面自己分出来的（后端只回生效名字，不替页面数分组）：出口名要
       显示成用户认得出的词，直连那一组显示「直连」。*/
    for (var j = 0; j < shared.length; j++) {
      var proxies = App.proxies;
      var label = shared[j].name === C.DIRECT_PROXY
        ? t("proxy.direct")
        : proxies
          ? proxies.optionLabel(shared[j].name)
          : shared[j].name;
      items.push({
        text: t("risk.proxyShared", { count: shared[j].labels.length, proxy: label }),
        href: C.ROUTE_PATH_ACCOUNTS + "?" + C.PROXIES_QUERY_KEY + "=1",
      });
    }

    for (var k = 0; k < items.length; k++) {
      if (k > 0) holder.appendChild(create("span", null, " · "));
      var link = create("a", "banner__item", items[k].text);
      link.href = items[k].href;
      holder.appendChild(link);
    }
    setHidden(banner, items.length === 0);
  }

  /**
   * 抢活动的一行汇总。推荐落点是账号详情大窗（claim 与账号一一对应，大窗
   * 已展示套餐 —— 同源），概览只放一行跳转指引：自动领取在跑就说几个账号在跑，
   * 状态载荷给了下次检查或开抢时刻时一并写出；手动模式 / 已停用各有一句。
   * claim 段缺席（宿主没接）或没有可领账号时整行收起，不画空容器。
   */
  function renderClaimLine(claim) {
    var line = byRole("overview-claim-line");
    if (!line) return;
    if (!claim || claim.accounts.length === 0) {
      setHidden(line, true);
      return;
    }
    var config = claim.config;
    var text;
    if (!config.enabled) text = t("overview.claim.disabled");
    else if (!config.auto) text = t("overview.claim.manual");
    else {
      var running = 0;
      var nextCheck = 0;
      var openingAt = 0;
      for (var i = 0; i < claim.accounts.length; i++) {
        var account = claim.accounts[i];
        if (account.running) running += 1;
        if (typeof account.holdUntilMs === "number" && account.holdUntilMs > Date.now()) {
          if (!nextCheck || account.holdUntilMs < nextCheck) nextCheck = account.holdUntilMs;
        }
        if (typeof account.holdUntil === "number" && account.holdUntil > Date.now()) {
          if (!nextCheck || account.holdUntil < nextCheck) nextCheck = account.holdUntil;
        }
        if (typeof account.openingAt === "number" && account.openingAt > Date.now()) {
          if (!openingAt || account.openingAt < openingAt) openingAt = account.openingAt;
        }
      }
      if (nextCheck > 0) {
        text = t("overview.claim.on.next", { count: running, time: App.format.dateTime(nextCheck) });
      } else if (openingAt > 0) {
        text = t("overview.claim.on.opening", { count: running, time: App.format.dateTime(openingAt) });
      } else {
        text = t("overview.claim.on", { count: running });
      }
    }
    setText("overview-claim-text", text);
    setHidden(line, false);
  }

  /**
   * 概览页的账号摘要（只读六列）。
   *
   * 每一行整行可点，跳 `/accounts?focus=<label>`：读者在这张表里看到的是「8 个账号
   * 里 3 个在冷却」，下一步动作在账号页。跳转带上是哪个账号，那边会把它滚进视野
   * 并高亮两秒（`app-view-accounts.js` 的 `applyFocus`）。
   */
  function renderAccounts(accounts) {
    var body = byRole("accounts-body");
    var table = byRole("accounts-table");
    var empty = byRole("accounts-empty");
    if (!body) return;
    clear(body);

    setHidden(empty, accounts.length > 0);
    setHidden(table, accounts.length === 0);
    /* 空态只建一次入口：表格每拍重画，重复 create 会把键盘焦点甩掉。 */
    if (accounts.length === 0 && empty && !empty.querySelector("[data-role='accounts-empty-action']")) {
      var action = create("a", "empty-inline__link", t("ui.empty.accountSummary.action"));
      action.setAttribute("data-role", "accounts-empty-action");
      action.href = C.ROUTE_PATH_ACCOUNTS;
      empty.appendChild(document.createTextNode(" "));
      empty.appendChild(action);
    }

    for (var i = 0; i < accounts.length; i++) {
      var account = accounts[i];
      var row = document.createElement("tr");
      /* `<tr>` 里放不下 `<a>`（放进去就只有那一格可点），所以行自己当链接：
         `data-href` 给跳转、`tabindex` 让键盘到得了、Enter / 空格走同一条路。 */
      row.setAttribute(
        "data-href",
        C.ROUTE_PATH_ACCOUNTS + "?" + C.FOCUS_QUERY_KEY + "=" + encodeURIComponent(account.label),
      );
      row.setAttribute("tabindex", "0");

      row.appendChild(create("td", null, account.label));

      var kindCell = document.createElement("td");
      kindCell.appendChild(create("span", C.KIND_TAG_CLASS[account.kind] || "tag", t("kind." + account.kind)));
      row.appendChild(kindCell);

      row.appendChild(create("td", "mono", account.routes.join(", ")));

      var healthCell = document.createElement("td");
      /* 二值化：手动停用的账号不是「健康」，别让绿标签盖住事实——
         显示「已停用」，红色（健康语义的异常端）。文字保留具体语义。 */
      if (!account.enabled) {
        healthCell.appendChild(create("span", "tag tag--danger", t("accounts.status.disabled")));
      } else {
        healthCell.appendChild(
          create("span", C.HEALTH_TAG_CLASS[account.health] || "tag", t("health." + account.health)),
        );
      }
      row.appendChild(healthCell);

      row.appendChild(create("td", "num", String(account.inflight)));
      row.appendChild(create("td", "num", String(account.maxConcurrency)));

      body.appendChild(row);
    }
  }

  /* ---- 整行可点 -------------------------------------------------------- */

  /**
   * 账号摘要的点击与回车。
   *
   * 监听挂在 `<tbody>` 上而不是每一行：表格每次载荷到达都整体重画（5 秒一拍），
   * 逐行绑等于每拍新建 N 个闭包。`closest` 从事件发生的那一格往上找行。
   */
  function bindControls() {
    var body = byRole("accounts-body");
    if (!body) return;

    /* `closest` 存在性判断而不是 `instanceof Element`：这段脚本在测试里由
       `new Function` 执行，裸的 `Element` 不是那个 window 上的构造器。 */
    function rowOf(event) {
      var target = event.target;
      return target && typeof target.closest === "function" ? target.closest("tr[data-href]") : null;
    }

    function follow(event) {
      var row = rowOf(event);
      if (!row) return;
      window.location.assign(row.getAttribute("data-href"));
    }

    body.addEventListener("click", follow);
    body.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (!rowOf(event)) return;
      event.preventDefault();
      follow(event);
    });
  }

  function render(state) {
    renderServer(state.server, state.metrics, state.risk.alerts);
    renderMetrics(state.accounts, state.metrics);
    renderChart(state.metrics.inflightHistory);
    renderRisk(state.risk.alerts, state.accounts);
    renderClaimLine(state.claim);
    renderAccounts(state.accounts);
    /* 今日四卡与时序缩略：顺手触发一次节流重拉（首拍必拉，之后 60s
       一次）；数据回来后上面的两个 render* 由回调再跑一遍。 */
    refreshUsage();
    renderUsage();
  }

  /**
   * 顶栏刷新：重拉这一页的两份数据。
   *
   *   `/api/state`  指标卡 / 并发曲线 / 账号摘要 / 侧边栏状态（快的那一份）
   *   今日用量      `getUsageStats`（慢的那一份，走 force 绕过 60s 节流）
   *
   * 两份是并行的：它们本来就没有先后关系，串行只会让按钮多转一会儿。
   */
  function refresh() {
    var pending = App.api.refresh();
    var usagePending = refreshUsage(true);
    return Promise.all([pending, usagePending]);
  }

  App.views.overview = { render: render, refresh: refresh, bindControls: bindControls };
})(window.__zcodeApp = window.__zcodeApp || {});
