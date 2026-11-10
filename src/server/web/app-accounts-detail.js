/*
 * app-accounts-detail.js — 账号详情大窗（`.modal--lg` 居中模态）与抢活动段。
 *
 * 窗体内容 = 段序列：套餐卡（归 `app-accounts-plan-cards.js`）→ 本期活动 →
 * 抢活动 → 逐路由健康 → 能力对齐 → 健康状态变化事件 → JWT-only 说明。窗体是**每拍
 * 重画**的：`/api/state` 带回新数据就重建体，壳（头部 / 关闭键 / 刷新按钮）不动，
 * 所以刷新按钮不会在鼠标停上去的时候被换掉。开合与焦点管理在
 * `App.widgets.dialog`（状态在模块级 Map，轮询重画不丢）。
 *
 * 这里只记「展示的是谁」（`dialogLabel`）：账号被删后下一拍重画把窗一起收掉。
 *
 * **抢活动段的限频纪律**：状态行来自 `/api/state` 的 claim 段（纯内存读，每拍
 * 自动更新）；活动列表走 `previewClaimPlans`，**只在进屏与手动刷新时拉，
 * 永不轮询**——billing 面限频，与 quota 命令同一条纪律。结果缓存在本模块的 Map
 * 里，窗体重画从缓存渲染，不再发请求。活动状态由时间窗、台账与结果动作推导，
 * 八种状态共用 `App.claimActivityState`。
 *
 * 点行 / 点额度格开窗的入口是 `openDialogFor(label)`：主视图把它交给表格的
 * document 委托，表格因此不需要知道大窗的状态。
 */
(function (App) {
  "use strict";

  var byRole = App.dom.byRole;
  var create = App.dom.create;
  var clear = App.dom.clear;
  var button = App.dom.button;
  var t = App.i18n.t;
  var formatDateTime = App.format.dateTime;

  /** 套餐段与类型标签的实现在套餐卡模块。*/
  var plans = App.accountsPlans;
  var activityState = App.claimActivityState;

  /**
   * 大窗正在展示的账号 label（`null` = 没开）。
   *
   * 开合状态在 `App.widgets.dialog`（跨轮询持久、Esc / 遮罩 / 关闭键都在那里）；
   * 这里只记「展示的是谁」，窗体每拍重画时按它找回账号。账号被删后下一拍重画
   * 会把窗一起收掉。
   */
  var dialogLabel = null;
  /** 最近一次窗体重画用的账号行（preview/claim 异步回包重画时复用）。*/
  var lastDialogAccount = null;

  /**
   * 详情大窗的段序列：套餐卡 → 本期活动 → 抢活动 → 路由健康。
   *
   * 用量窗口在订阅套餐卡里，不单独成段：它与套餐是同一件事的两个面
   * （额度由套餐授予、窗口是它的限速）。
   */
  function buildDetailSections(account) {
    var sections = [];
    var quota = account.quota;
    if (!quota) {
      sections.push(create("div", "detail__note detail__note--quiet", t("accounts.quota.empty")));
    } else {
      sections.push(plans.buildPlansSection(account));
      if (quota.campaigns.length > 0) sections.push(plans.buildCampaignsSection(quota.campaigns));
      if (quota.stale) sections.push(create("div", "detail__note", t("accounts.quota.stale")));
    }
    var claim = buildClaimSection(account);
    if (claim) sections.push(claim);
    var health = buildRouteHealthSection(account);
    if (health) sections.push(health);
    /* 能力对齐（配置 ∩ 实际套餐）与健康状态变化事件是调度层的可解释面。 */
    var capability = buildCapabilitySection(account);
    if (capability) sections.push(capability);
    sections.push(buildHealthEventsSection());
    var note = jwtOnlyNote(account);
    if (note) sections.push(note);
    return sections;
  }

  /* ---- 详情卡的各段：路由健康 / 能力对齐 / 健康状态变化事件 -------------- */

  /** 详情卡里逐路由的健康段：状态键是 (account, route)，不是账号。*/
  function buildRouteHealthSection(account) {
    if (!account.routeHealth || account.routeHealth.length === 0) return null;
    var section = create("div", "detail__section");
    section.appendChild(plans.sectionTitle(t("accounts.routeHealth.title"), null));
    for (var i = 0; i < account.routeHealth.length; i++) {
      var health = account.routeHealth[i];
      var item = create("span", "detail__item");
      item.appendChild(create("span", "mono", health.route));
      item.appendChild(create("span", healthBadgeClass(health.status), healthStatusText(health)));
      if (health.reason) item.appendChild(create("span", "faint", t("accounts.routeHealth.reason." + health.reason)));
      if (health.status === "auth-invalid") {
        item.appendChild(create("span", "status-badge status-badge--danger", t("accounts.healthEvents.fix")));
      }
      if (typeof health.until === "number" && health.status !== "ok") {
        item.appendChild(
          create("span", "faint", t("accounts.routeHealth.until", { time: formatDateTime(health.until) })),
        );
      }
      section.appendChild(item);
    }
    return section;
  }

  /** 逐路由健康的状态标签：二值化——冷却也是异常一端，色统一红（文字不变）。*/
  function healthBadgeClass(status) {
    if (status === "auth-invalid") return "status-badge status-badge--danger";
    if (status === "drained") return "status-badge status-badge--danger";
    if (status === "cooling") return "status-badge status-badge--danger";
    return "status-badge status-badge--ok";
  }

  function healthStatusText(health) {
    if (health.status === "auth-invalid") return t("accounts.status.authInvalid");
    if (health.status === "drained") return t("accounts.status.drained");
    if (health.status === "cooling") return t("accounts.status.cooling");
    return t("accounts.routeHealth.ok");
  }

  /**
   * 账号实际持有套餐是硬约束。这里显示的是**被运行时遮蔽**的配置路由
   * （不改写 account.routes），原因码来自服务端对齐层，页面只翻译。
   * 没有屏蔽时也留一行中性说明，避免「探测过但没变化」被误读成「没探测」。
   */
  function buildCapabilitySection(account) {
    var blocks = account.capabilityBlocks || [];
    var section = create("div", "detail__section");
    section.appendChild(plans.sectionTitle(t("accounts.capability.title"), null));
    if (blocks.length === 0) {
      section.appendChild(create("div", "detail__item", t("accounts.capability.none")));
      return section;
    }
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var item = create("div", "detail__item");
      item.appendChild(create("span", "mono", t("accounts.capability.blocked", { route: block.route })));
      item.appendChild(create("span", "faint", t("accounts.capability.reason." + block.reason)));
      section.appendChild(item);
    }
    return section;
  }

  /**
   * 健康状态变化事件（onTransition）的结构化快照。
   * 事件倒序、只显示最近 5 条；auth-invalid 附带人工恢复引导，
   * 熔断/退避详情在路由页。没有事件时一行空态，不画空列表。
   */
  function buildHealthEventsSection() {
    var section = create("div", "detail__section");
    section.appendChild(plans.sectionTitle(t("accounts.healthEvents.title"), null));
    var payload = App.state.lastState && App.state.lastState.health;
    var events = payload && payload.events ? payload.events : [];
    if (events.length === 0) {
      section.appendChild(create("div", "detail__item", t("accounts.healthEvents.empty")));
      return section;
    }
    for (var i = 0; i < events.length && i < 5; i++) {
      var event = events[i];
      var item = create("div", "detail__item");
      item.appendChild(create("span", "mono", formatDateTime(event.at)));
      item.appendChild(create("span", null, t("accounts.healthEvents.type." + event.type)));
      if (event.route) item.appendChild(create("span", "faint", event.route));
      if (event.reason) item.appendChild(create("span", "faint", event.reason));
      if (event.until) item.appendChild(create("span", "faint", t("accounts.routeHealth.until", { time: formatDateTime(event.until) })));
      if (event.type === "auth-invalid-enter") {
        item.appendChild(create("span", "status-badge status-badge--danger", t("accounts.healthEvents.fix")));
      }
      section.appendChild(item);
    }
    return section;
  }

  /** 详情卡里的「刷新」：复用 quota 控制命令，带 label 只刷这个账号。成功后
   *  dispatch 自己回读 /api/state，抽屉体重画时新数据原地带回。*/
  function refreshQuota(label) {
    App.api.dispatch({ cmd: "quota", label: label }, null, "accounts");
  }

  /**
   * JWT-only 账号的限制说明。
   *
   * 只显示 `routes: ["start-plan"]` 会让用户以为是配置问题，实际是凭据里缺 apiKey
   * 对：四条路由只有 start-plan 不要求它。所以只在「白名单只有 start-plan 且没有
   * apiKey」时补一句，说清楚缺什么、怎么补。
   */
  function jwtOnlyNote(account) {
    if (account.hasApiKey) return null;
    if (account.routes.length !== 1 || account.routes[0] !== "start-plan") return null;
    return create("div", "detail__note", t("accounts.jwtOnly"));
  }

  /** 按 label 从最近一拍载荷里找账号并开窗（行点击与额度格点击共用入口）。*/
  function openDialogFor(label) {
    if (!label) return;
    var accounts = (App.state.lastState && App.state.lastState.accounts) || [];
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].label === label) {
        openAccountDialog(accounts[i]);
        return;
      }
    }
  }

  /** 点行 / 点额度列开窗：记住展示谁、重画窗体、把开合交给 widgets（焦点也在那里）。*/
  function openAccountDialog(account) {
    dialogLabel = account.label;
    renderDialogBody(account);
    App.widgets.dialog.open("account");
    /* 限频纪律：previewClaimPlans 仅在进屏（开窗）时拉一次。每拍轮询的
       syncDialog 不拉 —— 列表的手动刷新靠段头上的「刷新活动」按钮。*/
    fetchClaimPreview(account.label);
  }

  /** 每拍轮询后同步大窗：开着就按最新载荷重画体；账号没了就把它收掉。*/
  function syncDialog(accounts) {
    if (!App.widgets.dialog.isOpen("account")) return;
    var account = null;
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].label === dialogLabel) {
        account = accounts[i];
        break;
      }
    }
    if (!account) {
      dialogLabel = null;
      App.widgets.dialog.close("account");
      return;
    }
    renderDialogBody(account);
  }

  /**
   * 窗体 = 壳的头部（标题 / 类型 / ID 前缀）+ 四段（套餐卡 / 本期活动 / 抢活动 /
   * 路由健康）。壳是静态的，只改三项文本节点，所以重画不重建头部（刷新按钮也就
   * 不会在鼠标悬停的时候被换掉）。
   */
  function renderDialogBody(account) {
    lastDialogAccount = account;
    var title = byRole("account-dialog-title");
    if (title) title.textContent = account.label;
    var meta = byRole("account-dialog-meta");
    if (meta) {
      clear(meta);
      for (var i = 0; i < account.planKinds.length; i++) {
        var tag = plans.planKindTag(account.planKinds[i]);
        if (tag) meta.appendChild(tag);
      }
      meta.appendChild(create("span", "mono", account.idPrefix));
    }
    var body = byRole("account-dialog-body");
    if (!body) return;
    /* 体是整段重建的（每拍轮询都会走这里）：先记下焦点在哪个控件上，重画完再放
       回去。身份按「第几个可 Tab 的元素 + 标签」算，不按节点——节点每一拍都换。*/
    var focusMark = App.widgets.dialog.captureFocus(body);
    clear(body);
    var sections = buildDetailSections(account);
    for (var j = 0; j < sections.length; j++) body.appendChild(sections[j]);
    App.widgets.dialog.restoreFocus(body, focusMark);
  }

  /* ---- 抢活动段 ----------------------------------------------------------- */

  /*
   * 数据来源与限频纪律：
   *   - 账号的调度状态行：随 `/api/state` 的 claim 段每拍自动来（纯内存读，
   *     无上游请求），窗体重画时从 `App.state.lastState.claim` 现找；
   *   - 活动列表：`previewClaimPlans` 实时拉发现层清单，**仅进屏（开抽屉）与
   *     手动刷新触发，永不轮询** ——
   *     billing 面限频，与 quota 命令同一条纪律（AGENTS.md）。结果缓存在本
   *     模块的 Map 里，窗体每拍重画从缓存渲染，不再发请求。
   */

  /** 活动列表缓存：label → { status: "loading"|"ready"|"error", plans?, text? }。*/
  var claimPreviews = {};
  /** 最近一次手动领取的反馈：label → { ok, text }（渲染在段尾）。*/
  var claimResults = {};
  /** 最近一次领取影响的活动：label → { planId, outcome }（按台账更新状态）。*/
  var claimOutcomes = {};

  /** 状态载荷里的 claim 段（缺席 = 宿主没接 claim 控制面，区块整体不画）。*/
  function claimState() {
    return App.state.lastState && App.state.lastState.claim;
  }

  function claimRowFor(claim, label) {
    if (!claim) return null;
    for (var i = 0; i < claim.accounts.length; i++) {
      if (claim.accounts[i].label === label) return claim.accounts[i];
    }
    return null;
  }

  /**
   * 状态行文案：
   *   已停止 / 已停止·重新登录 / 手动模式 / 自动领取中 /
   *   已领·挂起到 T / 等待活动开始·T / 限流冷却至 T / 挂起到 T。
   */
  function claimStatusText(row) {
    var claim = claimState();
    if (!claim || !row) return t("accounts.claim.status.stopped");
    if (!claim.config.enabled) return t("accounts.claim.status.stopped");
    if (!claim.config.auto) return t("accounts.claim.status.manual");
    if (!row.running) return t("accounts.claim.status.stopped");
    if (row.stopped) return t("accounts.claim.status.stoppedLogin");
    var holdUntil = typeof row.holdUntil === "number" ? row.holdUntil : 0;
    if (holdUntil <= Date.now()) return t("accounts.claim.status.auto");
    // 挂起的原因按结构化字段判：已领（per-plan hold）> 限流（Retry-After）>
    // 等待开始（waitReason）> 其余（冷却 / 配置列表未命中）。
    if (claimedHold(row) !== null) return t("accounts.claim.status.hold.claimed", { time: formatDateTime(holdUntil) });
    if (row.last && row.last.action === "error" && row.last.holdSource === "retry-after") {
      return t("accounts.claim.status.hold.rateLimited", { time: formatDateTime(holdUntil) });
    }
    if (row.last && row.last.action === "idle" && row.last.waitReason === "waiting-start") {
      return t("accounts.claim.status.hold.start", { time: formatDateTime(holdUntil) });
    }
    return t("accounts.claim.status.hold", { time: formatDateTime(holdUntil) });
  }

  /** 有没有一条「已领」hold（成功 claimed 或上游 already_claimed）。*/
  function claimedHold(row) {
    var holds = row.planHolds || {};
    for (var planId in holds) {
      if (!Object.prototype.hasOwnProperty.call(holds, planId)) continue;
      var hold = holds[planId];
      if (hold.reason === "claimed" || hold.reason === "already_claimed") return hold;
    }
    return null;
  }

  /** 状态徽标的配色：挂起是过程态（中性），停止/手动也是中性；领取中绿色。*/
  function claimStatusBadge(row) {
    var claim = claimState();
    if (claim && claim.config.enabled && claim.config.auto && row && row.running && !row.stopped) {
      var holdUntil = typeof row.holdUntil === "number" ? row.holdUntil : 0;
      // 挂起 ≠ 异常：等窗口是调度器的正常节奏（状态机里的等待态），中性色。
      if (holdUntil > Date.now()) return "tag";
      return "tag tag--ok";
    }
    return "tag";
  }

  /** 拉活动列表（进屏与手动刷新唯一入口；永不轮询）。*/
  function fetchClaimPreview(label) {
    claimPreviews[label] = { status: "loading" };
    return App.api
      .sendControl({ cmd: "previewClaimPlans", accountLabel: label })
      .then(function (body) {
        if (!body) {
          claimPreviews[label] = { status: "error", text: t("error.network_error") };
        } else if (body.ok && Array.isArray(body.plans)) {
          claimPreviews[label] = { status: "ready", plans: body.plans };
        } else if (body.ok) {
          /* 应答形状不对（服务端不会发生；防注入旧桩）：当空列表处理，不崩渲染。 */
          claimPreviews[label] = { status: "ready", plans: [] };
        } else {
          claimPreviews[label] = { status: "error", text: App.i18n.errorText(body.error) };
        }
        redrawDialogIfOpen(label);
        return null;
      });
  }

  /**
   * 手动领取（单次动作）。回包带台账结果时先更新该活动的展示状态，再走
   * `/api/state` 回灌，让状态行与台账标注跟上服务端真值。失败文案按结果动作
   * 给一句用户词，不露裸错误码。
   */
  function claimNow(label, planId, planName) {
    App.api
      .sendControl({ cmd: "claimNow", accountLabel: label, planId: planId })
      .then(function (body) {
        var outcome = body && body.ok ? body.outcome : null;
        claimOutcomes[label] = { planId: planId, outcome: outcome };
        if (!body) {
          claimResults[label] = { ok: false, text: t("error.network_error") };
        } else if (outcome && outcome.ok) {
          claimResults[label] = {
            ok: true,
            text:
              typeof outcome.effectiveAt === "number"
                ? t("accounts.claim.result.claimedAt", { plan: planName || t("settings.claim.activities.unnamed"), time: formatDateTime(outcome.effectiveAt * 1000) })
                : t("accounts.claim.result.claimed", { plan: planName || t("settings.claim.activities.unnamed") }),
          };
        } else if (outcome) {
          claimResults[label] = { ok: false, text: activityState.outcomeText(outcome) };
        } else {
          claimResults[label] = { ok: false, text: App.i18n.errorText(body.error) };
        }
        redrawDialogIfOpen(label);
        App.api.refresh().then(function () {
          fetchClaimPreview(label);
          return null;
        });
        return null;
      });
  }

  /** 大窗还开着同一账号时重画窗体（预览/领取的异步回包落进画面）。*/
  function redrawDialogIfOpen(label) {
    if (!App.widgets.dialog.isOpen("account") || dialogLabel !== label) return;
    var claim = claimState();
    var row = claimRowFor(claim, label);
    var account = lastDialogAccount || (row ? { label: label } : null);
    if (!account) return;
    renderDialogBody(account);
  }

  /** 大窗里的抢活动段：状态行 + 按状态分组的活动 + 最近领取反馈。*/
  function buildClaimSection(account) {
    var claim = claimState();
    if (!claim) return null; // 宿主没接 claim 控制面：整段不画。
    var row = claimRowFor(claim, account.label);
    if (!row) return null; // 不可领的凭据（没有 plan JWT）：不画空段。

    var section = create("div", "detail__section");
    section.appendChild(plans.sectionTitle(t("accounts.claim.title"), null));

    // 状态行：徽标 + 一句话（+ 最近一次结果）。
    var status = create("span", "detail__item");
    status.appendChild(create("span", claimStatusBadge(row), claimStatusText(row)));
    var last = row.last;
    if (last && last.action === "claimed") {
      status.appendChild(create("span", "faint", t("accounts.claim.last.claimed", { plan: planNameOf(last.planId) })));
    } else if (last && last.action === "failed" && last.failureKind) {
      status.appendChild(create("span", "faint", t("accounts.claim.last.failed", { kind: activityState.outcomeText(last) })));
    }
    section.appendChild(status);

    // 活动列表：进屏拉一次 + 手动刷新（永不轮询，preview 面限频）。
    var listHead = create("div", "detail__section-title");
    listHead.appendChild(create("span", null, t("accounts.claim.plans.title")));
    listHead.appendChild(create("span", "detail__section-note", t("accounts.claim.state.group")));
    listHead.appendChild(button(t("accounts.claim.plans.refresh"), "btn", function () { fetchClaimPreview(account.label); }));
    section.appendChild(listHead);

    var preview = claimPreviews[account.label];
    if (!preview || preview.status === "loading") {
      section.appendChild(create("div", "detail__note detail__note--quiet", t("accounts.claim.plans.loading")));
    } else if (preview.status === "error") {
      section.appendChild(create("div", "detail__note", preview.text));
    } else if (preview.plans.length === 0) {
      section.appendChild(create("div", "detail__note detail__note--quiet", t("accounts.claim.plans.empty")));
    } else {
      var groups = groupClaimPlans(account.label, preview.plans, row, claim);
      for (var i = 0; i < activityState.order.length; i++) {
        var group = groups[activityState.order[i]];
        if (!group || group.length === 0) continue;
        var heading = create("div", "detail__claim-group", activityState.label(activityState.order[i]));
        heading.setAttribute("data-claim-state", activityState.order[i]);
        section.appendChild(heading);
        for (var j = 0; j < group.length; j++) {
          section.appendChild(buildClaimPlanRow(account.label, group[j], group[j].state));
        }
      }
    }

    var result = claimResults[account.label];
    if (result) {
      section.appendChild(create("div", result.ok ? "detail__note detail__note--quiet" : "detail__note", result.text));
    }
    return section;
  }

  /** 状态行里的活动名：只从缓存清单里找，找不到就不显示裸标识。*/
  function planNameOf(planId) {
    for (var label in claimPreviews) {
      if (!Object.prototype.hasOwnProperty.call(claimPreviews, label)) continue;
      var preview = claimPreviews[label];
      if (!Array.isArray(preview.plans)) continue;
      for (var i = 0; i < preview.plans.length; i++) {
        if (preview.plans[i].planId === planId) return preview.plans[i].name || "";
      }
    }
    return "";
  }

  /** 按八种状态分桶；列表顺序沿用发现层，组内不做二次排序。*/
  function groupClaimPlans(label, list, row, claim) {
    var groups = {};
    var outcome = claimOutcomes[label];
    for (var i = 0; i < list.length; i++) {
      var plan = list[i];
      var result = outcome && outcome.planId === plan.planId ? outcome.outcome : null;
      var state = activityState.stateOf(plan, withClaimConfig(row, claim), result);
      if (!groups[state]) groups[state] = [];
      groups[state].push({ plan: plan, state: state });
    }
    return groups;
  }

  /** 开抢窗口的预热时长参与「准备就绪」推导；配置来自状态载荷。*/
  function withClaimConfig(row, claim) {
    var merged = {};
    for (var key in row) {
      if (Object.prototype.hasOwnProperty.call(row, key)) merged[key] = row[key];
    }
    merged.config = claim.config;
    return merged;
  }

  /** 一条活动：名称 + 状态标签 + 时间窗 + 权益摘要 + 领取按钮。*/
  function buildClaimPlanRow(label, entry, state) {
    var plan = entry.plan;
    var row = create("div", "detail__plan");
    row.setAttribute("data-claim-state", state);
    var head = create("div", "detail__plan-head");
    var name = typeof plan.name === "string" && plan.name ? plan.name : t("settings.claim.activities.unnamed");
    head.appendChild(create("span", "detail__plan-name", name));
    head.appendChild(create("span", state === "claimed" ? "tag tag--ok" : "tag", activityState.label(state, plan)));
    row.appendChild(head);

    if (plan.description) row.appendChild(create("div", "detail__plan-line", plan.description));
    var windows = activityState.windowLines(plan);
    for (var i = 0; i < windows.length; i++) {
      row.appendChild(create("div", "detail__plan-line", windows[i]));
    }
    var entitlements = Array.isArray(plan.entitlements) ? plan.entitlements : [];
    for (var j = 0; j < entitlements.length; j++) {
      var text = activityState.entitlementText(entitlements[j]);
      if (text) row.appendChild(create("div", "detail__plan-line", text));
    }
    var hint = activityState.hint(state);
    if (hint) row.appendChild(create("div", "detail__note detail__note--quiet", hint));

    var actions = create("div", "detail__plan-actions");
    var claimButton = button(t("accounts.claim.plans.claim"), "btn", function () {
      claimNow(label, plan.planId, name);
    });
    var reason = activityState.disabledReason(state);
    if (reason) {
      claimButton.disabled = true;
      claimButton.title = reason;
    }
    actions.appendChild(claimButton);
    row.appendChild(actions);
    return row;
  }

  App.accountsDetail = {
    /* 开窗入口：按 label 从最近一拍载荷里找账号（点行 / 点额度格）。*/
    openDialogFor: openDialogFor,
    /* 每拍同步：开着就重画体，账号没了就收窗。*/
    sync: syncDialog,
    /* 只刷当前展示账号的额度（窗头那颗「刷新」）。*/
    refreshQuota: function () {
      if (dialogLabel) refreshQuota(dialogLabel);
    },
    /* 顶栏刷新要把「详情正开着谁」交给服务端做必采决策。*/
    focusedLabel: function () {
      return App.widgets.dialog.isOpen("account") ? dialogLabel : null;
    },
  };
})(window.__zcodeApp = window.__zcodeApp || {});
