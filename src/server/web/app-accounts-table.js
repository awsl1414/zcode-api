/*
 * app-accounts-table.js — 账号表格：行、列、行内控件、批量条与行尾菜单。
 *
 * 一行九格（复选框 / 账号 / 路由 / 状态 / 并发 / 调度权重 / 额度 / 代理 / 操作）
 * 由 `buildAccountRow` 拼装，每格的形态理由写在各自的构造函数块头。表格的行为
 * 约定：
 *
 *   - **筛选与搜索是纯客户端状态**（`activeFilter` / `searchText`）：「可见行」
 *     只影响建行与全选框，不改变载荷顺序，也不发任何命令。
 *   - **选择集合按 label 记**（`selectedLabels`）：行每拍重画，DOM 上的勾选态
 *     只是这份集合的投影；账号删除后由 `buildRows` 回收。
 *   - **批量动作串行发号、收尾只回读一次**（`runBatch`）：逐条 `dispatch` 会让
 *     整表闪 N 下，用例「bulk actions」钉住回读次数。
 *   - **行尾菜单与占比浮层是 document 级委托**（`bind` 绑一次），行重画不需要
 *     重绑；开合状态里只有占比浮层跨重画存活（`openShareLabel`），因为它承载的
 *     权重步进器每点一下就要整表重画一次。
 *
 * 只消费账户载荷与 `App.accountsPlans` 的派生值（额度百分比 / 数据龄）；套餐卡
 * 的 DOM 归 `app-accounts-plan-cards.js`，详情大窗归 `app-accounts-detail.js`。
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
  var formatUnits = App.format.units;
  var isPositiveInteger = App.forms.isPositiveInteger;
  var isNonNegativeInteger = App.forms.isNonNegativeInteger;
  /** `dispatch` 的行内失败出口（见 app-api.js 的 `showTargetError`）。*/
  var ROW_TARGET_PREFIX = C.ROW_TARGET_PREFIX;

  /** 套餐派生（百分比换算、额度条、数据龄）只有一份，来自套餐卡模块。*/
  var plans = App.accountsPlans;
  /** 大窗 / 删除确认 / 整页重画都在 `bind` 时注入（表格不依赖主视图与各弹层的状态）。*/
  var hooks = { openDialog: null, redraw: null, openDelete: null };

  /** 复选框选中集合（label → true）。批量操作自己管选择，不经过表格的行渲染。*/
  var selectedLabels = {};
  /**
   * 打开着的调度权重浮层的账号 label（`null` = 都没开）。
   *
   * 与行尾 ⋯ 菜单不同，这个浮层要**跨重画**存活：浮层里的 `[−] 权重 N [+]`
   * 每点一下发一条命令并回读 `/api/state`，整表重画之后浮层必须还在（否则调一档
   * 就要重新点开一次）。开合仍由 document 委托（`closeMenus`）统一收口。
   */
  var openShareLabel = null;
  /**
   * 正在等额度采样返回的账号（label → true）。
   *
   * 采样要打一次上游，几秒内可能连续点几下；同一账号的命令在途时把这一行的 ⋯
   * 置灰，用户能看见「已经点了」。命令返回（成功或失败）后清掉，行重画时
   * `buildCellMenu` 也按它恢复禁用态——不然轮询重画会把置灰抹掉。
   */
  var refreshingLabels = {};
  /** 状态筛选（all / available / abnormal / drained）与搜索词。纯客户端状态。*/
  var activeFilter = "all";
  var searchText = "";
  /**
   * 行内失败提示（label → `{ text, until }`）。
   *
   * 控件失败时挂在**那一行**上，不挂页顶横幅：长表格里页顶那条横幅不在视野内，
   * 用户会以为刚才没点中。提示随下一拍重画自然消失（`until` 到期后 `buildRows`
   * 不再画它），所以不需要关闭按钮；同一行的新失败覆盖旧的。
   */
  var rowFailures = {};

  /* ---- 状态 / 筛选的派生 ------------------------------------------------- */

  /**
   * 状态列：健康与在飞合并成一条（状态徽标 + 骨架图的 `● 2/2`）。
   *
   * 徽章自带 `__dot` 圆点，文案只留 `0/2`。配色三档，判据只有一条：
   * **红色只表示「系统出问题了，需要处理」；用户主动关掉的东西不是故障。**
   *
   *   - `--ok`：启用中并在跑；
   *   - `--danger`：需要人工处理的故障（凭据失效 / 401 / 额度耗尽 / 冷却）；
   *   - `--muted`：用户主动停用。
   *
   * 琥珀不算健康语义；停用与故障同红时，扫视时分不清「我关的」和「出问题了」。
   */
  function statusOf(account) {
    /* 手动停用优先：它是用户的选择，不是系统故障，所以走中性档而不是红色。 */
    if (!account.enabled) {
      return { text: t("accounts.status.disabled"), badge: "status-badge status-badge--muted" };
    }
    /* 凭据失效需要人工动作，优先级高于一切自动冷却（自动冷却会自己恢复，它不会）。 */
    if (account.health === "auth-invalid") {
      return { text: t("accounts.status.authInvalid"), badge: "status-badge status-badge--danger" };
    }
    /* 401 次优先：鉴权失败比冷却更值得马上看见（它是 rotate 的触发原因）。*/
    for (var i = 0; i < account.routeHealth.length; i++) {
      if (account.routeHealth[i].reason === "auth-failed") {
        return { text: t("accounts.status.authFailed"), badge: "status-badge status-badge--danger" };
      }
    }
    if (account.health === "drained") {
      return { text: t("accounts.status.drained"), badge: "status-badge status-badge--danger" };
    }
    if (account.health === "cooling") {
      return { text: t("accounts.status.cooling"), badge: "status-badge status-badge--danger" };
    }
    return {
      text: t("accounts.status.inflight", { inflight: account.inflight, limit: account.maxConcurrency }),
      badge: "status-badge status-badge--ok",
    };
  }

  /**
   * 筛选桶（统计卡与状态 tab 共用同一套口径）：
   *   停用 → 只出现在「全部」（有意暂停不是故障）；
   *   401 / 冷却 → 异常；额度耗尽 → 耗尽；其余启用中 → 可用。
   *
   * 不匹配徽章的 class 字符串（那是渲染层的内部拼写，配色二值化后「红」不再唯一
   * 对应一个桶），直接按同一份事实（enabled / routeHealth / health）判。
   */
  function bucketOf(account) {
    if (!account.enabled) return "all";
    if (account.health === "auth-invalid") return "abnormal";
    for (var i = 0; i < account.routeHealth.length; i++) {
      if (account.routeHealth[i].reason === "auth-failed") return "abnormal";
    }
    if (account.health === "drained") return "drained";
    if (account.health === "cooling") return "abnormal";
    return "available";
  }

  /**
   * 额度百分比：取最紧的那个窗口（用掉最多的），因为用户关心的是「还有多少余量」。
   * 没有采样（`quota === null`，不代表「零额度」）或窗口没给百分比时返回
   * `null`，页面显示 `—`。
   *
   * 返回的是**已用**占比（上游 `percentage` 的原义）——它只喂「额度占用」
   * 统计位（标签说的就是占用，语义对得上），**不进任何条**；条的入口见
   * `buildMeter` 的剩余语义契约（两平面 percentage 语义相反，
   * 任何进条的百分比都要先归一成剩余）。
   */
  function quotaPercentOf(quota) {
    if (!quota) return null;
    var highest = null;
    for (var i = 0; i < quota.windows.length; i++) {
      var percentage = quota.windows[i].percentage;
      if (typeof percentage === "number" && (highest === null || percentage > highest)) highest = percentage;
    }
    return highest === null ? null : Math.round(highest);
  }
  /* ---- 统计行 ------------------------------------------------------------ */

  /** 四个统计位：总数 / 可用 / 异常 / 额度占用（有采样的账号取最紧窗口的平均）。*/
  function renderStats(accounts) {
    var counts = { available: 0, abnormal: 0, drained: 0 };
    var quotaSum = 0;
    var quotaSamples = 0;
    for (var i = 0; i < accounts.length; i++) {
      var bucket = bucketOf(accounts[i]);
      if (counts[bucket] !== undefined) counts[bucket]++;
      var percent = quotaPercentOf(accounts[i].quota);
      if (percent !== null) {
        quotaSum += percent;
        quotaSamples++;
      }
    }
    setText("accounts-stat-total", String(accounts.length));
    setText("accounts-stat-available", String(counts.available));
    setText("accounts-stat-abnormal", String(counts.abnormal));
    setText("accounts-stat-quota", quotaSamples > 0 ? Math.round(quotaSum / quotaSamples) + "%" : "—");
    setText("accounts-filter-count-all", String(accounts.length));
    setText("accounts-filter-count-available", String(counts.available));
    setText("accounts-filter-count-abnormal", String(counts.abnormal));
    setText("accounts-filter-count-drained", String(counts.drained));
  }
  /* ---- 表格行 ------------------------------------------------------------ */

  /** 并发步进器：`−` / 数字 / `+`（0 表示软禁用，负数直接拒）。*/
  function buildStepper(account) {
    var stepper = create("span", "stepper");
    stepper.appendChild(
      button("−", "stepper__btn", function () {
        stepConcurrency(account, -C.CONCURRENCY_STEP);
      }),
    );
    var value = create(
      "span",
      account.maxConcurrency === C.MIN_CONCURRENCY ? "stepper__value stepper__value--soft-off" : "stepper__value",
      String(account.maxConcurrency),
    );
    stepper.appendChild(value);
    stepper.appendChild(
      button("+", "stepper__btn", function () {
        stepConcurrency(account, C.CONCURRENCY_STEP);
      }),
    );
    return stepper;
  }

  /**
   * 行内失败提示的写入口（页顶横幅保留作汇总，这一条贴在出问题的那一行）。
   *
   * `text` 为 `null` 时清掉该行的提示。到期由 `buildRows` 按 `until` 判断：下一拍
   * 重画时过期的提示不再画出来，所以不需要额外的定时器，也不会在行重建后悬着。
   */
  function showRowFailure(label, text) {
    if (!label) return;
    if (text === null) {
      delete rowFailures[label];
    } else {
      rowFailures[label] = { text: text, until: Date.now() + C.ROW_FAILURE_TTL_MS };
      /* 页顶横幅保留作汇总（它是跨行、跨动作的唯一出口，桌面宽屏上仍在视野内）；
         行内那条解决的是「长表格里横幅看不见」。两者不是二选一。 */
      App.api.showActionError(text);
    }
    if (App.state.lastState) App.renderState(App.state.lastState);
  }

  /** 这一行当前该不该画失败提示（过期的顺手回收）。*/
  function rowFailureOf(label) {
    var note = rowFailures[label];
    if (!note) return null;
    if (Date.now() >= note.until) {
      delete rowFailures[label];
      return null;
    }
    return note.text;
  }

  function stepConcurrency(account, delta) {
    var next = account.maxConcurrency + delta;
    /* 下界在页面先拒（服务端 `isNonNegativeInteger` 同口径）：0 合法，负数不发送 */
    if (next < C.MIN_CONCURRENCY) {
      showRowFailure(account.label, t("accounts.concurrency.negative"));
      return;
    }
    /* 失败挂在**这一格**上（`target` 带 label），不挂页顶横幅：用户在第 12 行
       改并发，提示出现在视野之外的页顶等于没给反馈。见 `showTargetError`。 */
    App.api.dispatch({ cmd: "setAccountConcurrency", label: account.label, maxConcurrency: next }, null, ROW_TARGET_PREFIX + account.label);
  }

  /* ---- 调度权重（weight 的唯一有意义口径） -------------------------------- */

  /*
   * 为什么显示占比而不是权重：调度器三套策略用的都是**比例**，不是绝对值——
   * sticky-hash 是加权 rendezvous（`-weight / ln(u)` 取最大，scheduler.ts:243），
   * balanced / round-robin 按权重铺环（`for slot < weight`，scheduler.ts:296）。
   * 于是只有 `weight / Σweight` 有意义：全部账号填同一个数字等于均分，填 1 与填 5
   * 是同一个分布。菜单里一个裸数字输入回答不了「填多少、改变了什么」，所以把它搬成
   * 列，显示归一化后的百分比。
   *
   * 列名叫「调度权重」而不是「流量占比」：这个百分比是调度器**分配请求**的比例，
   * 与实测流量无关（真实流量看统计页）。同一时刻它是全部账号的权重份额，加起来 100%。
   */

  /** 分母：**全部账号**的权重之和（不是可见行、也不是启用行）。 */
  function totalWeight(accounts) {
    var sum = 0;
    for (var i = 0; i < accounts.length; i++) {
      var weight = accounts[i].weight;
      if (typeof weight === "number" && weight > 0) sum += weight;
    }
    return sum;
  }

  /**
   * 占比文案：一位小数，整数不带 `.0`（`12.5%` / `50%` / `100%`）。
   *
   * 8 个等权账号 → 12.5% 是**正确预期**（等权 = 均分），不是舍入误差。
   */
  function sharePercent(weight, total) {
    if (!(total > 0) || !(weight > 0)) return "—";
    var percent = Math.round((weight / total) * 1000) / 10;
    return (percent % 1 === 0 ? String(percent) : percent.toFixed(1)) + "%";
  }

  /** 权重步进器：`−` / 数字 / `+`，一档 1，下界 1（到 1 时 `−` 直接禁用）。*/
  function buildWeightStepper(account) {
    var stepper = create("span", "stepper");
    var minus = button("−", "stepper__btn", function () {
      stepWeight(account, -1);
    });
    minus.disabled = account.weight <= C.MIN_WEIGHT;
    stepper.appendChild(minus);
    stepper.appendChild(create("span", "stepper__value", String(account.weight)));
    stepper.appendChild(
      button("+", "stepper__btn", function () {
        stepWeight(account, 1);
      }),
    );
    return stepper;
  }

  function stepWeight(account, delta) {
    var next = account.weight + delta;
    /* 下界在页面先拒（服务端 `isPositiveInteger` 同口径）：1 是合法的最小值。
       `−` 在 1 时已经禁用（`buildWeightStepper`），但走到这条路径的越界值不能
       无声消失——步进器点了像没反应是这里以前的行为。 */
    if (!isPositiveInteger(next)) {
      showRowFailure(account.label, t("ui.feedback.weightOutOfRange", { min: C.MIN_WEIGHT }));
      return;
    }
    App.api.dispatch({ cmd: "setAccountWeight", label: account.label, weight: next }, null, ROW_TARGET_PREFIX + account.label);
  }

  /**
   * 调度权重列：百分比（可点）+ 小浮层（权重步进器 / 实际占比 / 均分 / 口径说明）。
   *
   * 浮层复用行尾菜单的那套外壳（`.menu` + `[data-menu-cell]` 定位原点 + document
   * 级委托）：同一时刻只开一个，点外 / Esc 收起的行为与 ⋯ 菜单一致，不另造浮层。
   * 弹开状态记在 `openShareLabel` 上，所以回读触发的整表重画不会把它收掉。
   */
  function buildShareCell(account, total) {
    /* 与行尾⋯ 菜单共用 `.cell-menu`（定位原点 + 右对齐），不用另起一个只当钩子的类：
       区分靠 `data-share-cell` / `data-row-menu` 两个属性。 */
    var cell = create("td", "cell-menu");
    cell.setAttribute("data-menu-cell", account.label);
    cell.setAttribute("data-share-cell", "");

    var value = button(sharePercent(account.weight, total), "share__value", function () {});
    value.setAttribute("data-share-button", "");
    value.setAttribute("aria-expanded", "false");
    value.setAttribute("aria-label", t("accounts.share.open", { label: account.label }));
    cell.appendChild(value);

    var pop = create("div", "menu share-pop");
    pop.setAttribute("hidden", "");
    pop.setAttribute("tabindex", "-1");

    var field = create("div", "menu__field");
    field.appendChild(create("span", null, t("accounts.weight")));
    field.appendChild(buildWeightStepper(account));
    pop.appendChild(field);

    pop.appendChild(create("div", "menu__note", t("accounts.share.actual", { percent: sharePercent(account.weight, total) })));

    pop.appendChild(
      button(t("accounts.share.even"), "menu__item", function () {
        evenWeights(allAccounts());
      }),
    );

    pop.appendChild(create("div", "menu__note menu__note--quiet", t("accounts.share.note")));
    cell.appendChild(pop);

    if (openShareLabel === account.label) {
      pop.removeAttribute("hidden");
      value.setAttribute("aria-expanded", "true");
    }
    return cell;
  }

  /** 最近一次载荷里的账号（浮层里的「均分」按它算全部账号）。*/
  function allAccounts() {
    return (App.state.lastState && App.state.lastState.accounts) || [];
  }
  /* ---- 批量操作 --------------------------------------------------------- */

  /** 选中的账号（按载荷顺序；被删 / 被筛掉的 label 在重画时已回收）。*/
  function selectedAccounts(accounts) {
    var picked = [];
    for (var i = 0; i < accounts.length; i++) {
      if (selectedLabels[accounts[i].label] === true) picked.push(accounts[i]);
    }
    return picked;
  }

  /** 清空选择集合（切筛选 / 改搜索 / 批量跑完都走这里，重画由调用方负责）。*/
  function clearSelection() {
    selectedLabels = {};
  }

  /**
   * 批量执行：前端循环调用**现有的单条命令**，全部跑完后只回读一次 `/api/state`。
   *
   * 不用 `App.api.dispatch` 的原因（实测结论）：它在每条命令成功后各回读一次，
   * N 条命令 = N 次 `/api/state` + N 次整表 `clear()` 重建。八个账号勾选后停用，
   * 稳定复现「表格连着闪八下」；这里改用 `sendControl` 串行发、收尾一次
   * `refresh()`，同样的命令序列只重画一次（用例 `bulk actions` 钉住这个次数）。
   *
   * 串行而不是并行：控制面各自读改写同一个账号仓，并发发号只多不少竞态；几个账号
   * 的回环往返可以忽略（每次 < 1ms 的量级）。
   */
  function runBatch(accounts, buildCmd) {
    var ok = 0;
    var failures = [];
    var chain = Promise.resolve();
    for (var i = 0; i < accounts.length; i++) {
      chain = chain.then(
        (function (account) {
          return function () {
            return App.api.sendControl(buildCmd(account)).then(function (body) {
              if (body && body.ok) {
                ok++;
                return;
              }
              failures.push(body ? App.i18n.errorText(body.error) : t("error." + C.NETWORK_ERROR_CODE));
            });
          };
        })(accounts[i]),
      );
    }
    return chain
      .then(function () {
        clearSelection();
        return App.api.refresh();
      })
      .then(function () {
        reportBatch(ok, failures);
      });
  }

  /** 批量结果反馈：「成功 N / 失败 M」+ 失败原因摘要（去重，最多三条）。*/
  function reportBatch(ok, failures) {
    if (ok + failures.length === 0) return;
    if (failures.length === 0) {
      App.api.showNotice(t("accounts.bulk.done", { ok: ok, failed: 0 }));
      return;
    }
    var text = t("accounts.bulk.done.reasons", {
      ok: ok,
      failed: failures.length,
      reasons: uniqueReasons(failures),
    });
    /* 一个都没成就是整批失败，走错误横幅；部分成功留在提示横幅（动作有效果可看）。*/
    if (ok === 0) App.api.showActionError(text);
    else App.api.showNotice(text);
  }

  function uniqueReasons(reasons) {
    var seen = [];
    for (var i = 0; i < reasons.length && seen.length < 3; i++) {
      if (seen.indexOf(reasons[i]) < 0) seen.push(reasons[i]);
    }
    return seen.join(" · ");
  }

  /**
   * 均分：把给定账号的权重设成同一个值——取这批账号当前权重的最小值（下界 1）。
   *
   * 为什么不是写死 1：目标只是「比例相等」，任何共同值都等价，取最小值让改动条数
   * 最少（本来就最小的那些账号不必发命令），也不拆掉用户原来那套数量级的习惯。
   * 已经是同一个值时一条命令都不发（不然 8 个账号会给用户 8 条无意义的回读）。
   */
  function evenWeights(accounts) {
    if (accounts.length === 0) return;
    var target = accounts[0].weight;
    for (var i = 1; i < accounts.length; i++) {
      if (accounts[i].weight < target) target = accounts[i].weight;
    }
    if (!isPositiveInteger(target)) target = C.MIN_WEIGHT;
    var changed = [];
    for (var j = 0; j < accounts.length; j++) {
      if (accounts[j].weight !== target) changed.push(accounts[j]);
    }
    if (changed.length === 0) {
      App.api.showNotice(t("accounts.bulk.nochange"));
      return;
    }
    return runBatch(changed, function (account) {
      return { cmd: "setAccountWeight", label: account.label, weight: target };
    });
  }

  /** 批量条的动作分发（按钮由 `data-bulk` 标记，事件在 `bindControls` 里委托）。*/
  function runBulkAction(name) {
    var picked = selectedAccounts(allAccounts());
    if (picked.length === 0) return;

    if (name === "clear") {
      clearSelection();
      hooks.redraw();
      return;
    }
    if (name === "enable") {
      return runBatch(picked, function (account) {
        return { cmd: "setAccountEnabled", label: account.label, enabled: true };
      });
    }
    if (name === "disable") {
      openBulkDisable(picked);
      return;
    }
    if (name === "concurrency") {
      var concurrency = readBulkNumber("accounts-bulk-concurrency");
      if (!isNonNegativeInteger(concurrency)) {
        App.api.showActionError(t("accounts.concurrency.negative"));
        return;
      }
      return runBatch(picked, function (account) {
        return { cmd: "setAccountConcurrency", label: account.label, maxConcurrency: concurrency };
      });
    }
    if (name === "weight") {
      var weight = readBulkNumber("accounts-bulk-weight");
      if (!isPositiveInteger(weight)) {
        App.api.showActionError(t("accounts.weight.invalid", { min: C.MIN_WEIGHT }));
        return;
      }
      return runBatch(picked, function (account) {
        return { cmd: "setAccountWeight", label: account.label, weight: weight };
      });
    }
    if (name === "weight-even") {
      return evenWeights(picked);
    }
    if (name === "proxy") {
      var select = byRole("accounts-bulk-proxy");
      var proxy = select ? select.value : "";
      if (!proxy) return;
      return runBatch(picked, function (account) {
        return { cmd: "setAccountProxy", label: account.label, proxy: proxy };
      });
    }
    if (name === "delete") openBulkDelete(picked);
  }
  /** 批量条里的数字输入（空串 → `NaN`，交给同一个校验函数拒掉）。*/
  function readBulkNumber(role) {
    var input = byRole(role);
    var raw = input ? String(input.value).trim() : "";
    return raw === "" ? Number.NaN : Number(raw);
  }

  /** 停用是危险动作（断了这一批的流量），走确认模态而不是原生 confirm。*/
  function openBulkDisable(picked) {
    App.confirm.open({
      title: t("accounts.bulk.disable.title", { count: picked.length }),
      text: t("accounts.bulk.disable.text", { count: picked.length }),
      warn: t("accounts.bulk.disable.warn"),
      danger: true,
      run: function () {
        runBatch(picked, function (account) {
          return { cmd: "setAccountEnabled", label: account.label, enabled: false };
        });
      },
    });
  }

  /**
   * 批量删除：确认模态 + 手输 DELETE（与明文导出同一个护栏形态）。
   *
   * 不带 `force`：批量删 N 个账号时「中断在飞请求」不是一个该顺手给的选项，
   * 一律 drain（不掐在飞请求），要强制中断就单个账号走行尾菜单。
   */
  function openBulkDelete(picked) {
    App.confirm.open({
      title: t("accounts.bulk.delete.title", { count: picked.length }),
      text: t("accounts.bulk.delete.text", { count: picked.length }),
      warn: t("accounts.bulk.delete.warn"),
      danger: true,
      requiresToken: true,
      token: C.BULK_DELETE_TOKEN,
      tokenLabel: t("accounts.bulk.delete.tokenLabel", { token: C.BULK_DELETE_TOKEN }),
      tokenError: t("accounts.bulk.delete.tokenMismatch", { token: C.BULK_DELETE_TOKEN }),
      run: function () {
        runBatch(picked, function (account) {
          return { cmd: "removeAccount", label: account.label, drain: true };
        });
      },
    });
  }

  /**
   * 批量条的显隐与计数（每拍重画都同步一次）。
   *
   * 只在有选择时出现：没有选择时它是七个用不了的按钮，占着筛选行下方一整条。
   */
  function syncBulkBar(accounts) {
    var bar = byRole("accounts-bulk");
    if (!bar) return;
    var count = selectedAccounts(accounts).length;
    setHidden(bar, count === 0);
    setText("accounts-bulk-count", t("accounts.bulk.selected", { count: count }));
    syncBulkProxy();
  }

  /** 最近一次铺进批量条下拉的选项键（代理名单 + 语言）。*/
  var bulkProxyKey = null;

  /**
   * 批量条的代理下拉：选项与行内下拉同源（直连 + 代理表）。
   *
   * 只在名单或语言变了时重建：每拍重画都重建会把用户刚选的那一项打回去，
   * 而这个下拉是「先选、再点设置」的两步动作，中间隔一次轮询就会失效。
   */
  function syncBulkProxy() {
    var select = byRole("accounts-bulk-proxy");
    if (!select) return;
    var proxies = App.proxies;
    var known = proxies ? proxies.names() : null;
    var options = [C.DIRECT_PROXY].concat(known || []);
    var key = options.join("\u0000") + "\u0000" + App.i18n.language();
    if (key === bulkProxyKey) return;
    var current = select.value;
    bulkProxyKey = key;
    clear(select);
    for (var i = 0; i < options.length; i++) {
      var option = document.createElement("option");
      option.value = options[i];
      option.textContent = proxies ? proxies.optionLabel(options[i]) : options[i];
      select.appendChild(option);
    }
    if (options.indexOf(current) >= 0) select.value = current;
  }

  /**
   * 代理列：`直连` + 代理表里的每一项，写回 `setAccountProxy`。
   *
   * 显示名字而不是 URL：多账号共用一个出口时，名字才是「同一组」的标识。当前生效值
   * 不在表里时（代理表还没取到，或引用的是一个已被删掉的名字）额外补一项，否则下拉
   * 会显示成「直连」，看起来像已经改成直连了。
   */
  function buildProxySelect(account) {
    var current = account.proxy || C.DIRECT_PROXY;
    var proxies = App.proxies;
    var known = proxies ? proxies.names() : null;
    var options = [C.DIRECT_PROXY].concat(known || []);
    if (options.indexOf(current) < 0) options.push(current);

    var select = document.createElement("select");
    select.className = "select";
    select.setAttribute("aria-label", t("accounts.table.proxy"));
    for (var i = 0; i < options.length; i++) {
      var option = document.createElement("option");
      option.value = options[i];
      option.textContent = proxies ? proxies.optionLabel(options[i]) : options[i];
      select.appendChild(option);
    }
    select.value = current;
    select.addEventListener("change", function () {
      App.api.dispatch({ cmd: "setAccountProxy", label: account.label, proxy: select.value });
    });
    return select;
  }

  /**
   * 行尾菜单：⋯ 按钮收起低频操作。菜单随行重建（hidden 落在 DOM 上），
   * 开合由 document 级委托处理（见 bindControls）——重渲染天然安全。
   *
   * 菜单只放**动作**：启停（文案随状态切换）、刷新额度、删除（进确认模态）。菜单的
   * 心智是「点一下会发生什么」，点不动的身份信息不该混进来——它需要额外的「只读」
   * 标签解释自己为什么点不动。凭据出身（`kind`）对用户也没有决策价值（当前只有
   * 一个取值），所以这里没有它的一席之地。
   *
   * 权重搬到了表格列，导出不是行级操作（它导出整张表），留在页面自己的
   * 「导入 / 导出」组。
   *
   * 为什么这里要有一条「刷新额度」：停用账号永远进不了自动采样（启动探测跳过
   * 停用账号，周期采样只采不健康或最近派发过的账号），额度列会一直显示「未采样」。
   * 那两条规则都是在防定时全量探测，不该为了看一眼余额放开；所以补一条用户显式
   * 触发的通道，走 `quota` + label 的必采路径，只采这一次。启用中的账号同样受益
   * （不必等一个采样周期）。
   */
  function buildCellMenu(account) {
    /* 操作列与 keys / 代理 页同宽（`col-actions` = `--layout-actions-col`）。
       不给这个类时 ⋯ 按钮随内容伸缩，三张表的操作列宽度各不相同。 */
    var cell = create("td", "cell-menu col-actions");
    cell.setAttribute("data-menu-cell", account.label);
    /* `data-row-menu` 只给测试与读代码的人一个稳定选择器：同一行里现在有两个
       `.menu`（本行的 ⋯ 菜单与调度权重浮层），单看类名分不清谁是谁。 */
    cell.setAttribute("data-row-menu", "");

    var open = button("⋯", "btn btn--menu", function () {});
    open.setAttribute("data-menu-button", "");
    /* 不用 haspopup 语义：那承诺 role="menu"，这里的是 disclosure（aria-expanded）。
       page.test.ts 的 appbar 用例钉住全文档没有这个属性。 */
    open.setAttribute("aria-expanded", "false");
    open.setAttribute("aria-label", t("accounts.menu.more"));
    open.disabled = refreshingLabels[account.label] === true;
    cell.appendChild(open);

    var menu = create("div", "menu");
    menu.setAttribute("hidden", "");
    /* 菜单是「打开之后焦点先落在第一项」的浮层：`tabindex="-1"` 让壳自己可被
       程序聚焦（菜单里一项都没有时），但不进 Tab 序——Tab 从菜单项继续走。 */
    menu.setAttribute("tabindex", "-1");

    var toggle = button(account.enabled ? t("accounts.menu.pause") : t("accounts.menu.enable"), "menu__item", function () {});
    toggle.setAttribute("data-menu-action", "toggle-enabled");
    menu.appendChild(toggle);

    var refresh = button(t("accounts.menu.refreshQuota"), "menu__item", function () {});
    refresh.setAttribute("data-menu-action", "refresh-quota");
    refresh.disabled = refreshingLabels[account.label] === true;
    menu.appendChild(refresh);

    var remove = button(t("accounts.delete"), "menu__item menu__item--danger", function () {});
    remove.setAttribute("data-menu-action", "delete");
    menu.appendChild(remove);

    cell.appendChild(menu);
    return cell;
  }

  /**
   * 刷新额度：复用现有的 `quota` + label 命令（控制面的必采路径，与详情大窗那颗
   * 「刷新」同一个入口），成功后 `dispatch` 自己回读 `/api/state`，额度列随下一拍
   * 重画拿到新样本。
   *
   * 在途时把这一行的 ⋯ 置灰并重画一次（行是整表重建的，只改按钮不会把禁用态
   * 传出去）；失败给一行错误提示，不阻断——额度采样失败（网络 / 上游拒绝）不该
   * 影响其它操作。
   */
  function refreshQuota(account) {
    var label = account.label;
    refreshingLabels[label] = true;
    hooks.redraw();
    App.api
      .dispatch({ cmd: "quota", label: label }, null, "accounts")
      .then(function () {
        delete refreshingLabels[label];
        /* 重画一次把 ⋯ 恢复：成功后 `dispatch` 已经回读过 `/api/state`（那次重画
           时置灰还在），失败时没有回读，这里两种都覆盖。 */
        hooks.redraw();
      });
  }
  /* ---- 额度列（行内一级披露）---------------------------------------------- */

  /**
   * 额度列：按套餐类型分行（最多两行，一个类型一行），每行 = 短标签 + 额度 +
   * 60-80px 迷你条；卡序列超过已画行数时尾巴挂「+N」。整格可点开详情大窗
   * （`data-quota-open`，由 tbody 的 click 委托接住）。
   *
   * 为什么是「类型分行」而不是「套餐分行」：一列只有 ~160px，三个套餐各占一行
   * 会把这个格子撑得比账号名还高；而用户扫这一列时要回答的是「哪类套餐快没了」，
   * 类型就是那个粒度。具体到哪个套餐，开窗看（那是二级披露）。
   */
  function buildQuotaCell(account) {
    var cell = document.createElement("td");
    /* 整格是一个真 `<button>`（不是一个带 click 监听的 div）：行本身不可聚焦，
       键盘用户只能靠这个入口打开详情窗，而浮层的「关窗把焦点还回去」也要求
       来源元素是可聚焦的。子节点全是 span——button 的内容模型是 phrasing
       content，放 div 是非法 HTML。 */
    var box = document.createElement("button");
    box.type = "button";
    box.className = "quota-cell quota-cell--open";
    box.setAttribute("data-quota-open", account.label);
    /* 数据龄：数据比一个采样周期旧时，tooltip 补一行「上次采样 X 分钟前」
       （额度列空间紧，走 tooltip；详情大窗的套餐段走轻量标注）。 */
    var age = plans.sampleAgeNote(account.quota);
    box.title = t("accounts.quota.open", { label: account.label }) + (age ? "\n" + age : "");

    var lines = quotaLinesOf(account);
    if (lines.length === 0) {
      /* 没有采样时不画 `—`——那个字符在额度列里读成「零额度」。
         有采样但没有可画的行（桶全过期）才留 `—`，两者不是一回事。 */
      var empty = create(
        "span",
        "quota-cell--empty",
        account.quota ? t("accounts.quota.none") : t("accounts.quota.unsampled"),
      );
      if (!account.quota) empty.title = t("accounts.quota.unsampled.hint");
      box.appendChild(empty);
    }
    for (var i = 0; i < lines.length; i++) {
      var line = create("span", "quota-cell__line");
      /* 顺序是「类型标签 → 迷你条 → 数值」：条紧跟在标签后面，两行的条起点
         因此对齐成一条竖线，扫一眼就能比出哪个套餐更紧；数值跟在条尾。 */
      line.appendChild(create("span", "quota-cell__kind", lines[i].label));
      if (lines[i].percent !== null) line.appendChild(plans.buildMeter(lines[i].percent));
      line.appendChild(create("span", "quota-cell__amount", lines[i].text));
      box.appendChild(line);
    }
    var extra = quotaExtraCount(account, lines.length);
    if (extra > 0) box.appendChild(create("span", "quota-cell__more", t("accounts.quota.more", { count: extra })));
    cell.appendChild(box);
    return cell;
  }

  /**
   * 额度列的分行内容（一个套餐类型一行）。
   *
   *   - 订阅：coding 平面窗口里最紧那一个的剩余百分比（速率是用户当下最关心的）；
   *     没有窗口时不拿余额桶顶——credits 平面的桶**恒属体验体系**，
   *     按 `period === "daily"` 把它们画进「订阅」行会让同一笔额度出现在两处。
   *   - 体验：余额桶的剩余/总量合计（全部活桶，不按 period 分组）。
   *
   * 两行的数值都**点名剩余**（「剩 N%」/「剩 X/Y」）：列里没有语义标签，
   * 裸数字会被读成「已用」，迷你条（剩余语义）就跟读出来的数字对不上。
   * 过期桶不进任何合计：全过期时该类型这一行就不出现，而不是画
   * 一行 0。派生类型为空（`planKinds` 是空数组）时也返回空，由调用方显示 `—`。
   */
  function quotaLinesOf(account) {
    var quota = account.quota;
    if (!quota) return [];
    var kinds = account.planKinds || [];
    var lines = [];
    for (var i = 0; i < kinds.length; i++) {
      if (kinds[i] === "subscription") {
        if (plans.servesCodingPlane(account.routes) && quota.windows.length > 0) {
          var tightest = tightestRemaining(quota.windows);
          if (tightest !== null) {
            lines.push({
              label: t("accounts.quota.kind.subscription"),
              text: t("accounts.quota.remainingPercent", { value: Math.round(tightest) }),
              percent: tightest,
            });
          }
        }
      } else if (kinds[i] === "experience") {
        var balances = balanceLine(quota.balances, t("accounts.quota.kind.experience"));
        if (balances) lines.push(balances);
      }
    }
    return lines;
  }

  /** 活余额桶的「剩余/总量」行（过期桶不计入合计）。*/
  function balanceLine(balances, label) {
    var now = Date.now();
    var remaining = 0;
    var total = 0;
    var seen = false;
    for (var i = 0; i < balances.length; i++) {
      var balance = balances[i];
      if (plans.balanceExpired(balance, now)) continue;
      remaining += balance.remainingUnits;
      total += balance.totalUnits;
      seen = true;
    }
    if (!seen) return null;
    return {
      label: label,
      /* 列宽只有一列文字的距离：单位在这里省掉（「剩 2.76亿 / 5亿」已经能读），
         完整值（含 token）在卡上。分子点名「剩」：这行的分子是
         remainingUnits（剩余），裸「X/Y」会被读成「已用 X」，迷你条（= 剩余
         占比）就跟读出来的数字反向对不上——实测量到的「条长与数字不符」就是它。 */
      text: t("accounts.quota.remainingPair", { value: formatUnits(remaining), total: formatUnits(total) }),
      percent: total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : null,
    };
  }

  /** 一组窗口里最紧的剩余百分比（取最小；缺 percentage 的窗口不参与）。*/
  function tightestRemaining(windows) {
    var lowest = null;
    for (var i = 0; i < windows.length; i++) {
      var percent = plans.remainingPercentOf(windows[i]);
      if (percent === null) continue;
      if (lowest === null || percent < lowest) lowest = percent;
    }
    return lowest;
  }

  /** 「+N」：卡序列比已画的行多几个（没画出的那一部分才是 N）。*/
  function quotaExtraCount(account, linesShown) {
    var cards = plans.planCardsOf(account).length;
    if (cards <= linesShown) return 0;
    return cards - linesShown;
  }

  /** 点行开抽屉 / 点控件不切：行点击的统一守卫（菜单 / 复选框 / 下拉 / 输入框）。*/
  function clickTargetsControl(target) {
    var node = target;
    while (node && node.tagName !== "TR") {
      if (node.tagName === "BUTTON" || node.tagName === "INPUT" || node.tagName === "SELECT") return true;
      /* 整块动作单元（⋯ 菜单 / 占比浮层）：点它的内边距或说明文字也不该开抽屉。*/
      if (node.getAttribute && (node.getAttribute("data-menu") || node.getAttribute("data-menu-cell"))) return true;
      node = node.parentNode;
    }
    return false;
  }
  function buildAccountRow(account, total) {
    var row = document.createElement("tr");
    row.setAttribute("data-account", account.label);
    row.setAttribute("data-dialog-row", "");
    /* 行自己可聚焦：点击 / Enter / 空格都开详情大窗，而关窗的「还焦点」要求来源
       是一个能接焦点的元素。额度格那颗按钮仍是等价的键盘入口（它先拿到焦点），
       两条路通向同一个窗。 */
    row.setAttribute("tabindex", "0");

    var checkCell = document.createElement("td");
    checkCell.className = "table__check";
    var check = document.createElement("input");
    check.type = "checkbox";
    check.setAttribute("data-account-check", "");
    check.checked = selectedLabels[account.label] === true;
    check.setAttribute("aria-label", t("accounts.check", { label: account.label }));
    checkCell.appendChild(check);
    row.appendChild(checkCell);

    var nameCell = document.createElement("td");
    nameCell.className = "cell-account";
    /* 账号列只显示备注名。ID 前缀是低频身份信息（平时按 label 认账号，排障才
       看 ID），两段并排既占宽、又让这列读成两个字。
       截断后的全名必须在 `title` 上——`title` 以前放的是 idPrefix，长 label 被
       ellipsis 截掉之后用户再也读不到全名。前缀改由详情大窗
       的 `modal__meta` 承载（`.cell-account__label` 的省略号仍在）。 */
    nameCell.appendChild(create("span", "cell-account__label", account.label));
    nameCell.title = account.label;
    row.appendChild(nameCell);

    var kindCell = document.createElement("td");
    /* 这一列显示的是**套餐类型**（体验 / 订阅 / 双套餐，由 `planKinds`
       派生），不是凭据出身。`kind`（zhipu-account = 套餐账号）在进行尾 ⋯ 菜单，
       同时作为这枚标签的 `title`——它不是主信息，但也不能丢。
       类型与路由**竖排**（类型一行、每条路由一行）。并排时 `coding-plan ·
       start-plan` 一行为把列撑到 ~200px，而它只是两个短词。
       类型标签整体去掉，这一列只留路由（用户口径：「只展示 start-plan 或者
       coding plan」）。类型（体验 / 订阅 / 双套餐）不是调度信息，同一件事在详情大窗
       的套餐卡头上已经按 planId 正确表达；表格里多一枚标签只让人以为它是另一种账号。 */
    var kindBox = create("div", "cell-stack");
    var routes = account.routes || [];
    if (routes.length === 0) {
      /* 没有任何路由（旧载荷 / 刚建号还没派路由）：不画空格子。*/
      kindBox.appendChild(create("span", "cell-stack__route mono faint", "—"));
    } else {
      for (var r = 0; r < routes.length; r++) {
        kindBox.appendChild(create("span", "cell-stack__route mono faint", routes[r]));
      }
    }
    kindCell.appendChild(kindBox);
    row.appendChild(kindCell);

    var status = statusOf(account);
    var statusCell = document.createElement("td");
    statusCell.appendChild(create("span", status.badge));
    statusCell.firstChild.appendChild(create("span", "status-badge__dot"));
    statusCell.firstChild.appendChild(create("span", null, status.text));
    row.appendChild(statusCell);

    var concurrencyCell = document.createElement("td");
    concurrencyCell.appendChild(buildStepper(account));
    row.appendChild(concurrencyCell);

    /* 调度权重列：在并发之后、额度之前（同为「这一行的调度旋钮」）。 */
    row.appendChild(buildShareCell(account, total));

    row.appendChild(buildQuotaCell(account));

    /* 代理列放在额度之后、操作之前：它和并发步进器一样，是「这一行的运行时配置」，
       放在只读的状态与额度后面读起来更顺。 */
    var proxyCell = document.createElement("td");
    proxyCell.appendChild(buildProxySelect(account));
    row.appendChild(proxyCell);

    row.appendChild(buildCellMenu(account));

    return row;
  }

  /**
   * 一行的行内失败提示：紧跟在该行下面的一整条 `<tr>`，文字走 danger 色。
   *
   * 为什么是独立的一行而不是塞进某一格：它说的是「刚才对这个账号的那一下没成」，
   * 不属于并发 / 权重 / 代理任何一格；账号表单行里再挤一行字会把 9 列的行高撑开。
   * `colSpan` 取整行，读屏器顺着行读下来就是一句完整的话。
   */
  function buildFailureRow(label, text) {
    var row = create("tr", "account-row-error");
    row.setAttribute("data-row-error", label);
    row.setAttribute("role", "status");
    var cell = document.createElement("td");
    cell.colSpan = 9;
    cell.textContent = text;
    row.appendChild(cell);
    return row;
  }

  /* ---- 可见行与渲染出口（主视图的 render 调这里）------------------------ */

  /** 筛选 + 搜索后的可见账号（顺序保持载荷序）。*/
  function visibleAccounts(accounts) {
    var query = searchText.trim().toLowerCase();
    var visible = [];
    for (var i = 0; i < accounts.length; i++) {
      var account = accounts[i];
      if (activeFilter !== "all" && bucketOf(account) !== activeFilter) continue;
      if (query && account.label.toLowerCase().indexOf(query) < 0 && account.idPrefix.toLowerCase().indexOf(query) !== 0) {
        continue;
      }
      visible.push(account);
    }
    return visible;
  }

  /**
   * 按载荷重建整张表：先回收已删账号的选择记录，再按可见行建行、同步全选框。
   *
   * 行的重建是「全表 `clear()` 再逐行 append」：行内状态（勾选 / 浮层开合）都在
   * 模块里，重建是安全的，也是选择记录唯一的回收点。
   *
   * 返回可见行，主视图靠它决定空态与表格的显隐。
   */
  function buildRows(accounts) {
    var body = byRole("page-accounts-body");
    var visible = visibleAccounts(accounts);
    if (!body) return visible;
    clear(body);

    // 清掉已删账号的选择记录（重画是唯一的回收点：账号没了，记录留着也无意义）。
    var live = {};
    for (var i = 0; i < accounts.length; i++) live[accounts[i].label] = true;
    for (var label in selectedLabels) {
      if (!live[label]) delete selectedLabels[label];
    }

    var total = totalWeight(accounts);
    for (var j = 0; j < visible.length; j++) {
      body.appendChild(buildAccountRow(visible[j], total));
      var failure = rowFailureOf(visible[j].label);
      if (failure) body.appendChild(buildFailureRow(visible[j].label, failure));
    }
    syncCheckAll(visible);
    return visible;
  }

  /* ---- 事件绑定（document / tbody 级委托，行重画不需要重绑）------------- */

  /**
   * 绑定一次就够：`tbody` 与批量条都是静态节点，行的重建不影响委托。
   *
   * 三个入口由主视图注入：`openDialog`（点行 / 点额度格开详情窗）、
   * `openDelete`（行尾菜单的删除确认）、`redraw`（筛选 / 搜索 / 勾选后的即时
   * 重画）。表格因此不需要知道大窗、确认模态与整页编排的状态。
   */
  function bind(injected) {
    hooks.openDialog = injected.openDialog;
    hooks.redraw = injected.redraw;
    hooks.openDelete = injected.openDelete;

    /* 状态筛选：点击 tab 切换 activeFilter（纯客户端），重画由下一次轮询触发太慢，
       直接用最近一次载荷重画。**切 tab 先清空选择**：跨筛选保留的选中项
       是看不见的行，批量动作会误伤它们。 */
    var filter = byRole("accounts-filter");
    if (filter) {
      filter.addEventListener("click", function (event) {
        var tab = event.target && event.target.closest ? event.target.closest("[data-account-filter]") : null;
        if (!tab) return;
        activeFilter = tab.getAttribute("data-account-filter") || "all";
        clearSelection();
        var tabs = filter.querySelectorAll("[data-account-filter]");
        for (var i = 0; i < tabs.length; i++) {
          tabs[i].className = tabs[i] === tab ? "tab tab--active" : "tab";
        }
        hooks.redraw();
      });
    }

    /* 搜索：边打边筛（与日志页的搜索同一交互），词也留在模块里跨重画。改词同样
       清空选择——理由同上：看不见的行不该留在批量动作的名单里。 */
    var search = byRole("accounts-search");
    if (search) {
      search.addEventListener("input", function () {
        searchText = search.value;
        clearSelection();
        hooks.redraw();
      });
    }

    /* 批量操作条：按钮是静态的，绑定一次就够；动作按 `data-bulk` 分发。 */
    var bulk = byRole("accounts-bulk");
    if (bulk) {
      bulk.addEventListener("click", function (event) {
        var action = event.target && event.target.closest ? event.target.closest("[data-bulk]") : null;
        if (!action) return;
        runBulkAction(action.getAttribute("data-bulk") || "");
      });
    }

    /* 行复选框（tbody 委托；tbody 本身不重建）与全选框。 */
    var tbody = byRole("page-accounts-body");
    if (tbody) {
      tbody.addEventListener("change", function (event) {
        var target = event.target;
        if (!target || !target.getAttribute || target.getAttribute("data-account-check") === null) return;
        var row = target.closest ? target.closest("tr[data-account]") : null;
        if (!row) return;
        if (target.checked) selectedLabels[row.getAttribute("data-account")] = true;
        else delete selectedLabels[row.getAttribute("data-account")];
        /* 立即重画：批量条的计数与显隐就在这一次选择上变（不等下一拍轮询，5s 的
           延迟会让“已选 N 项”看上去没反应）。 */
        hooks.redraw();
      });
      /* 点行开大窗（居中窗）：控件上的点击不切（否则一调
         并发就开窗）。额度格整格可点（一级披露），它在行内也算一个入口，
         所以放在控件守卫之前——格子里没有任何控件。

         行本身也是键盘入口（`tabindex="0"` + Enter / 空格，与概览摘要行同一套）：
         鼠标点行时先让行自己拿到焦点，关窗的「还焦点」才有东西可还，否则
         `document.activeElement` 是 `<body>`，还回去等于把键盘用户丢回文档开头。 */
      tbody.addEventListener("click", function (event) {
        var quotaOpen = event.target && event.target.closest ? event.target.closest("[data-quota-open]") : null;
        if (quotaOpen) {
          if (typeof quotaOpen.focus === "function") quotaOpen.focus();
          hooks.openDialog(quotaOpen.getAttribute("data-quota-open"));
          return;
        }
        if (event.target && clickTargetsControl(event.target)) return;
        var row = event.target && event.target.closest ? event.target.closest("tr[data-account]") : null;
        if (!row) return;
        if (typeof row.focus === "function") row.focus();
        hooks.openDialog(row.getAttribute("data-account"));
      });
      tbody.addEventListener("keydown", function (event) {
        if (event.key !== "Enter" && event.key !== " ") return;
        var row = event.target && event.target.closest ? event.target.closest("tr[data-account]") : null;
        if (!row) return;
        /* 行内控件自己处理自己的键：焦点在复选框 / 按钮 / 下拉上时 Enter 与空格
           是它们的，不是「开窗」。 */
        if (event.target !== row) return;
        event.preventDefault();
        hooks.openDialog(row.getAttribute("data-account"));
      });
    }
    var checkAll = byRole("accounts-check-all");
    if (checkAll) {
      checkAll.addEventListener("change", function () {
        var accounts = (App.state.lastState && App.state.lastState.accounts) || [];
        var visible = visibleAccounts(accounts);
        for (var i = 0; i < visible.length; i++) {
          if (checkAll.checked) selectedLabels[visible[i].label] = true;
          else delete selectedLabels[visible[i].label];
        }
        hooks.redraw();
      });
    }

    /* 行尾菜单与调度权重浮层：document 级委托（按钮开合、动作执行、点外收起、Esc 收起）。
       两者都是 `[data-menu-cell]` 里的 `.menu`，`closeMenus` 同时收口，保证同一时刻
       只开一个浮层。 */
    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== "function") return;
      var shareButton = target.closest("[data-share-button]");
      if (shareButton) {
        toggleSharePopover(shareButton.closest("[data-menu-cell]"));
        return;
      }
      var buttonNode = target.closest("[data-menu-button]");
      if (buttonNode) {
        var cell = buttonNode.closest("[data-menu-cell]");
        toggleMenu(cell);
        return;
      }
      var action = target.closest("[data-menu-action]");
      if (action) {
        var menuCell = action.closest("[data-menu-cell]");
        runMenuAction(menuCell ? menuCell.getAttribute("data-menu-cell") : null, action.getAttribute("data-menu-action"));
        closeMenus();
        return;
      }
      if (!target.closest("[data-menu-cell]")) closeMenus();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeMenusWithFocus();
    });
    /* 菜单是 `position: fixed` 定位的：位置只在打开那一刻算一次，所以容器
       滚一下（表格在 `.page-body` 里滚）或窗口变尺寸就得把它收回去——否则它会
       悬在原来的坐标上，指向另一行。`capture: true` 才能听见滚动容器自己的
       scroll（scroll 不冒泡）。 */
    window.addEventListener("scroll", closeMenus, true);
    window.addEventListener("resize", closeMenus);
  }

  /**
   * 开合一行菜单：同一时间只开一个（开新的先收旧的）。
   *
   * 打开时按触发按钮的 `getBoundingClientRect` 把它钉成 `position: fixed`（见
   * `placeMenu`）：菜单以前在 `<td>` 里 `position: absolute`，会被表格容器的
   * `overflow: auto` 裁掉——最后一行或贴近滚动边缘时，⋯ 菜单整个看不见（实机
   * 复现）。portal 到 `body` 也能解决裁切，但那样每行菜单的 DOM 会离开自己的
   * 行，行的重画 / 事件委托 / `[data-menu-cell]` 选择器都得跟着改一套；`fixed` 只
   * 换定位方式，DOM 归属不变。
   */
  function toggleMenu(cell) {
    if (!cell) return;
    var menu = cell.querySelector(".menu");
    if (!menu) return;
    /* 已经开着就收（连同焦点一起还回去）。 */
    if (!menu.hasAttribute("hidden")) {
      closeMenusWithFocus();
      return;
    }
    closeMenus();
    /* 先改投影再量位置：`hidden` 还挂着的时候 `getBoundingClientRect` 是 0。 */
    menu.removeAttribute("hidden");
    placeMenu(cell, menu);
    var trigger = cell.querySelector("[data-menu-button]");
    if (trigger) trigger.setAttribute("aria-expanded", "true");
    /* 菜单本身不进 tab 序（`tabindex="-1"` 的浮层），先把焦点推到第一个菜单项上，
       键盘用户才能连着选。`.menu__item` 在行里也带 `data-menu-action`，这里只挑
       能接焦点的那些。 */
    var items = menu.querySelectorAll(".menu__item");
    for (var i = 0; i < items.length; i++) {
      if (items[i].disabled === true) continue;
      if (typeof items[i].focus === "function") items[i].focus();
      break;
    }
  }

  /** 菜单与视口 / 触发按钮之间的间距（纯几何值，不受间距档约束）。*/
  var MENU_GAP = 4;
  /** 菜单靠边时留出的空隙：贴看屏幕边读不出阴影，也容易点不到。*/
  var MENU_VIEWPORT_MARGIN = 8;

  /**
   * 把已打开的菜单钉到触发按钮旁边。
   *
   * 三条约束：右边缘与按钮对齐（菜单宽 176px，比按钮宽得多，向右展开会跑出
   * 列外）；下面放不下就翻到按钮上方；上下都放不下时靠底边对齐（宁可盖住触发
   * 按钮，也不要半个菜单在视口外）。坐标取整后写行内样式：这是几何，不是主题值。
   */
  function placeMenu(cell, menu) {
    var trigger = cell.querySelector("[data-menu-button]");
    if (!trigger) return;
    var rect = trigger.getBoundingClientRect();
    menu.classList.add("menu--fixed");
    /* 先归零再量：菜单还带着上一次打开时的 left/top，量出来的宽高会被裁。 */
    menu.style.left = "0px";
    menu.style.top = "0px";
    var size = menu.getBoundingClientRect();
    var viewportWidth = window.innerWidth || 0;
    var viewportHeight = window.innerHeight || 0;

    var left = rect.right - size.width;
    var maxLeft = viewportWidth - size.width - MENU_VIEWPORT_MARGIN;
    if (maxLeft > MENU_VIEWPORT_MARGIN && left > maxLeft) left = maxLeft;
    if (left < MENU_VIEWPORT_MARGIN) left = MENU_VIEWPORT_MARGIN;

    var top = rect.bottom + MENU_GAP;
    if (top + size.height > viewportHeight - MENU_VIEWPORT_MARGIN) {
      var above = rect.top - size.height - MENU_GAP;
      top =
        above >= MENU_VIEWPORT_MARGIN
          ? above
          : Math.max(MENU_VIEWPORT_MARGIN, viewportHeight - size.height - MENU_VIEWPORT_MARGIN);
    }

    menu.style.left = Math.round(left) + "px";
    menu.style.top = Math.round(top) + "px";
  }

  /**
   * 开合调度权重浮层。
   *
   * 与 `toggleMenu` 分开只因为弹开状态要跨重画存活（`openShareLabel`），收起则走
   * 同一个 `closeMenus`：点外 / Esc / 开另一个浮层都会把两样一起收掉。
   */
  function toggleSharePopover(cell) {
    if (!cell) return;
    var pop = cell.querySelector(".share-pop");
    if (!pop) return;
    var opening = pop.hasAttribute("hidden");
    closeMenus();
    if (opening) {
      openShareLabel = cell.getAttribute("data-menu-cell");
      pop.removeAttribute("hidden");
      var trigger = cell.querySelector("[data-share-button]");
      if (trigger) trigger.setAttribute("aria-expanded", "true");
    }
  }

  function closeMenus() {
    /* 占比浮层的弹开状态也在这里收口：它记在模块里（重画要恢复），所以只收 DOM
       的话下一次轮询会把它重新打开。 */
    openShareLabel = null;
    var open = document.querySelectorAll("[data-menu-cell] .menu:not([hidden])");
    for (var i = 0; i < open.length; i++) {
      open[i].setAttribute("hidden", "");
      /* 固定定位的类与坐标一起收：下次打开重新算，不该带着上一行的位置出现。*/
      if (open[i].classList && open[i].classList.remove) open[i].classList.remove("menu--fixed");
      open[i].style.left = "";
      open[i].style.top = "";
      var cell = open[i].closest("[data-menu-cell]");
      var trigger = cell ? cell.querySelector("[data-menu-button], [data-share-button]") : null;
      if (trigger) trigger.setAttribute("aria-expanded", "false");
    }
  }

  /**
   * Esc 收起菜单，并把焦点还给触发它的那颗 ⋯。
   *
   * 收起之后菜单项不在 tab 序里了，焦点若留在那里就会掉到 `<body>`；用户心里
   * 的「我刚才在哪」是那颗 ⋯，不是文档开头。点外收起与点另一个浮层收起不还
   * 焦点：那些手势本身已经把视线带到别处，抢回来只会挡住用户正在点的东西。
   *
   * 顺序是**先把焦点移出去、再收菜单**：反过来时浏览器会在下一次布局里对
   * 「刚被藏起来的焦点元素」做一次 focus fixup，把焦点挪到 `<body>`，覆盖掉
   * 这里的还焦点。
   */
  function closeMenusWithFocus() {
    var hadOpen = document.querySelectorAll("[data-menu-cell] .menu:not([hidden])").length > 0;
    var active = document.activeElement;
    var cell = active && active.closest ? active.closest("[data-menu-cell]") : null;
    if (hadOpen && cell) {
      var trigger = cell.querySelector("[data-menu-button], [data-share-button]");
      if (trigger && typeof trigger.focus === "function") trigger.focus();
    }
    closeMenus();
  }

  /**
   * 菜单动作：启停走既有命令（默认 drain）、刷新额度走 `quota` + label、删除进
   * 既有确认模态。
   */
  function runMenuAction(label, action) {
    if (!label) return;
    var accounts = (App.state.lastState && App.state.lastState.accounts) || [];
    var account = null;
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].label === label) {
        account = accounts[i];
        break;
      }
    }
    if (!account) return;
    if (action === "toggle-enabled") {
      App.api.dispatch({ cmd: "setAccountEnabled", label: account.label, enabled: !account.enabled }, function (body) {
        if (body.aborted > 0) App.api.showNotice(t("accounts.notice.aborted", { count: body.aborted }));
      });
      return;
    }
    if (action === "refresh-quota") {
      refreshQuota(account);
      return;
    }
    if (action === "delete") hooks.openDelete(account);
  }

  /** 全选框与行复选框的一致性：全部选中才亮，部分选中不亮（不引第三态）。*/
  function syncCheckAll(visible) {
    var all = byRole("accounts-check-all");
    if (!all) return;
    var checked = visible.length > 0;
    for (var i = 0; i < visible.length; i++) {
      if (selectedLabels[visible[i].label] !== true) {
        checked = false;
        break;
      }
    }
    all.checked = checked;
  }

  App.accountsTable = {
    /* 渲染出口：重建行（含选择回收与全选同步），返回可见行。*/
    buildRows: buildRows,
    /* 行内失败出口：`app-api.js` 的 `showTargetError` 认 `ROW_TARGET_PREFIX` 时
       转到这里（控件失败贴在那一行下面，不挂页顶横幅）。*/
    showRowFailure: showRowFailure,
    /* 统计行与批量条：每拍随载荷刷新。*/
    renderStats: renderStats,
    syncBulkBar: syncBulkBar,
    /* 事件绑定：三个注入的入口（开窗 / 删除确认 / 整页重画）。*/
    bind: bind,
  };
})(window.__zcodeApp = window.__zcodeApp || {});
