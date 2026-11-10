/*
 * app-view-settings.js — 设置页：四层配置、补丁提交、二次确认。
 *
 * 读写的是配置文件（`GET/POST /api/settings`）：读回生效值，写回 YAML。形状与页面
 * 分组一一对应（connection / identity / subsystems / security），页面不需要知道 YAML
 * 键名。页面不做本地乐观更新：每次写入后都用服务端回来的快照重画，所以「改失败了
 * 但界面显示成功」不会发生。
 *
 * 这一页只管「系统怎么跑」。三件事不在这里：
 *   当前登录用户 / 退出登录 / 修改密码  → 「我的账户」页（`app-view-account.js`）
 *   导入 / 导出                        → 账号页（`app-view-accounts.js`）
 *   登录                                → 账号页（`app-shell.js`）
 *
 * 页脚里的「检查更新」与「退出进程」不是配置写入，而是发给控制面的命令，处理函数
 * 也在 `app-shell.js`：它们的结果不落配置，写回来也没有可读的值。「自动抢套餐」
 * 段的策略、节奏与当前活动是状态载荷的只读视图，清单按需从控制面拉取。
 *
 * 身份组里归一开关只读（由环境变量控制）；客户端版本可编辑：留空 =
 * 自动探测本机安装的官方客户端，手填写入 `identity.appVersion`。设备指纹是账号
 * 属性，不在设置页。代理鉴权明文永不回显：输入框只用来设新值，读回后清空。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var byRole = App.dom.byRole;
  var setText = App.dom.setText;
  var setHidden = App.dom.setHidden;
  var clear = App.dom.clear;
  var t = App.i18n.t;
  var forms = App.forms;
  var buildOption = App.forms.buildOption;

  /** 最近一次 `/api/settings` 的载荷。`null` = 还没读到。*/
  var settingsSnapshot = null;
  /** 默认模型下拉的选项快照（模型集合变了才重建）。*/
  var settingsModelOptions = [];
  /** 短暂提示的收起计时器；`null` = 没有在等的。*/
  var noticeTimer = null;

  /* ---- 渲染 ------------------------------------------------------------ */

  /** 渲染整张设置页（值全部来自服务端）。*/
  function renderSettings() {
    var snapshot = settingsSnapshot;
    if (!snapshot) return;

    syncSettingsModels(snapshot.models);
    forms.setSelectValue("settings-defaultModel", snapshot.connection.defaultModel);
    forms.setSelectValue("settings-clientMode", snapshot.connection.mode);
    forms.setNumberValue("settings-clientTtl", snapshot.connection.ttlSeconds);
    forms.setNumberValue("settings-clientMaxSessions", snapshot.connection.maxSessions);
    // 推理强度：值 + 档位控件随模式联动（透传 = 仅存，控件禁用）。
    forms.setSelectValue("settings-reasoningMode", snapshot.connection.reasoningMode);
    forms.setSelectValue("settings-reasoningEffort", snapshot.connection.reasoningEffort);
    syncReasoningEffortEnabled(snapshot.connection.reasoningMode);

    var normalize = byRole("settings-normalize");
    if (normalize) {
      /* 二值化：开 / 关都是合法配置，不是健康状态——开给绿，关用中性，
         琥珀不再出现在这里（它只留给过程态与提醒）。 */
      normalize.className = snapshot.identity.normalizeClientSystem ? "tag tag--ok" : "tag";
      normalize.textContent = t(snapshot.identity.normalizeClientSystem ? "settings.on" : "settings.off");
    }
    /* 版本号是文本框：用户正在编辑时不要覆盖（同绑定地址的理由）*/
    var appVersion = byRole("settings-appVersion");
    if (appVersion && document.activeElement !== appVersion && appVersion.value !== snapshot.identity.appVersion) {
      appVersion.value = snapshot.identity.appVersion;
    }
    setPathText("settings-appVersionSource", appVersionSourceText(snapshot.identity));

    forms.setChecked("settings-highspeed", snapshot.subsystems.highspeed);
    forms.setChecked("settings-mcp", snapshot.subsystems.mcp);
    forms.setChecked("settings-async", snapshot.subsystems.async);
    forms.setChecked("settings-claim", snapshot.subsystems.claim);
    renderClaimOverview();
    /* dump 开关：开关之外，文件路径也一并展示（配置值，空 = 默认位置）。
       路径走 `setPathText`——字段格只有一列宽，路径按宽度截断，全值进 title。*/
    forms.setChecked("settings-dumpEnabled", snapshot.subsystems.dumpEnabled);
    setPathText("settings-dumpPath", snapshot.subsystems.dumpPath || C.DUMP_DEFAULT_PATH_DISPLAY);
    forms.setNumberValue("settings-quotaPollSeconds", snapshot.subsystems.quotaPollSeconds);
    forms.setNumberValue("settings-quotaDrainThreshold", snapshot.subsystems.quotaDrainThreshold);

    forms.setNumberValue("settings-port", snapshot.security.port);
    /* 绑定地址是文本框：用户正在编辑时不要覆盖（同 `setNumberValue` 的理由）*/
    var host = byRole("settings-host");
    if (host && document.activeElement !== host && host.value !== snapshot.security.host) {
      host.value = snapshot.security.host;
    }
    /* 数据面鉴权总开关：key 本身在 `/keys` 页，这里只有这一个布尔值。*/
    forms.setChecked("settings-requireKey", snapshot.security.requireKey);

    setText("settings-configPath", snapshot.configPath);
  }

  /** 版本号来源的一句话（三种来源各自的文案）。*/
  function appVersionSourceText(identity) {
    if (identity.appVersionSource === "detected") {
      return t("settings.appVersion.source.detected", { path: identity.appVersionSourcePath || "—" });
    }
    if (identity.appVersionSource === "manual") return t("settings.appVersion.source.manual");
    return t("settings.appVersion.source.default");
  }

  /**
   * 写一段可能很长的只读文本（目前只有客户端版本的来源路径）。
   *
   * 显示时按控件宽度截断（`.hint--clip`），完整值同步写进 `title`，
   * 鼠标停上去就能读到全路径（长路径不再压在按钮下面露半句）。
   */
  function setPathText(role, text) {
    var node = byRole(role);
    if (!node) return;
    node.textContent = text;
    node.title = text;
    /* 截断发生在 `.hint--clip` 那个盒子上（里面的 `<span>` 是行内，
       不参与截断），所以 title 也得挂在它上面——否则鼠标停在省略号那一段读不到全值。 */
    var clip = node.closest ? node.closest(".hint--clip") : null;
    if (clip) clip.title = text;
  }

  /**
   * 「从系统同步」：探测 → 填进输入框 → 写入 YAML。
   *
   * 写入这一步不能省：探测结果只用 `writeSettingsPatch` 才算进了配置文件，否则
   * 页面显示的是个没保存的值，重启之后又变回去了。写入后服务端回来的快照会把
   * 来源改成 `manual`，因为那个值现在是手写进 YAML 的。
   */
  function syncAppVersion() {
    return App.api.dispatch(
      { cmd: "detectAppVersion" },
      function (body) {
        if (!body.detected) {
          showSettingsError(t("settings.appVersion.notDetected"));
          return;
        }
        var input = byRole("settings-appVersion");
        if (input) input.value = body.detected;
        showSettingsError(null);
        App.api.writeSettingsPatch({ identity: { appVersion: body.detected } });
      },
      "settings",
    );
  }

  /** models 变了才重建默认模型下拉（每拍重建会把用户的选择冲掉）。*/
  function syncSettingsModels(models) {
    var signature = models.join("\u0000");
    if (signature === settingsModelOptions.join("\u0000")) return;
    settingsModelOptions = models.slice();

    var select = byRole("settings-defaultModel");
    if (!select) return;
    var previous = select.value;
    clear(select);
    for (var i = 0; i < models.length; i++) select.appendChild(buildOption(models[i], models[i]));
    if (models.indexOf(previous) >= 0) select.value = previous;
  }

  /** 接受一份新的服务端快照（成功读 / 成功写都走这里）。*/
  function adopt(snapshot) {
    settingsSnapshot = snapshot;
    showSettingsError(null);
    renderSettings();
  }

  /** 撤销界面上的半截编辑：用最后一份快照重画。*/
  function restore() {
    if (settingsSnapshot) renderSettings();
  }

  /* ---- 控件绑定 -------------------------------------------------------- */

  function bindSettingsControls() {
    bindAdvancedSection();
    bindAppVersion();
    bindSettingsSelect("settings-defaultModel", function (value) {
      return { defaultModel: value };
    });
    bindSettingsSelect("settings-clientMode", function (value) {
      return { connection: { mode: value } };
    });
    // 推理强度：模式切换同时联动档位控件的可用性；档位在透传下仅存
    // （服务端不校验组合语义，两键独立提交，切换模式不丢已选档位）。
    bindSettingsSelect("settings-reasoningMode", function (value) {
      syncReasoningEffortEnabled(value);
      return { connection: { reasoningMode: value } };
    });
    bindSettingsSelect("settings-reasoningEffort", function (value) {
      return { connection: { reasoningEffort: value } };
    });

    bindSettingsNumber("settings-clientTtl", "settings.clientIdentityTtl", false, function (value) {
      return { connection: { ttlSeconds: value } };
    });
    bindSettingsNumber("settings-clientMaxSessions", "settings.clientIdentityMaxSessions", false, function (value) {
      return { connection: { maxSessions: value } };
    });
    bindSettingsNumber("settings-quotaPollSeconds", "settings.quotaPollSeconds", false, function (value) {
      return { subsystems: { quotaPollSeconds: value } };
    });
    /* drained 阈值是比例（0 到 1 之间的小数），不能用整数校验 */
    bindSettingsNumber("settings-quotaDrainThreshold", "settings.quotaDrainThreshold", true, function (value) {
      return { subsystems: { quotaDrainThreshold: value } };
    });
    bindSettingsNumber("settings-port", "settings.port", false, function (value) {
      return { security: { port: value } };
    });

    bindSettingsSwitch("settings-highspeed", "highspeed");
    bindSettingsSwitch("settings-mcp", "mcp");
    bindSettingsSwitch("settings-async", "async");
    bindSettingsSwitch("settings-claim", "claim");
    bindClaimActivities();
    bindSettingsSwitch("settings-dumpEnabled", "dumpEnabled");

    var host = byRole("settings-host");
    if (host) {
      host.addEventListener("change", function () {
        var next = host.value.trim();
        if (!next) {
          showSettingsError(t("settings.invalidHost"));
          restore();
          return;
        }
        if (settingsSnapshot && next === settingsSnapshot.security.host) return;
        App.api.writeSettingsPatch({ security: { host: next } });
      });
    }

    bindSettingsSwitch("settings-requireKey", "requireKey", "security");
  }

  /**
   * 版本号输入框：失焦时提交。
   *
   * 格式在页面里先拦一次（服务端也会拦，但一次往返换一个红条不如当场说清楚），
   * 空串合法，它的语义是「退回自动探测」。
   */
  function bindAppVersion() {
    var input = byRole("settings-appVersion");
    if (!input) return;
    input.addEventListener("change", function () {
      var next = input.value.trim();
      if (next !== "" && !/^\d+\.\d+\.\d+$/.test(next)) {
        showSettingsError(t("settings.appVersion.invalid"));
        restore();
        return;
      }
      if (settingsSnapshot && next === settingsSnapshot.identity.appVersion) return;
      App.api.writeSettingsPatch({ identity: { appVersion: next } });
    });
  }

  function bindSettingsSelect(role, toPatch) {
    var select = byRole(role);
    if (!select) return;
    select.addEventListener("change", function () {
      App.api.writeSettingsPatch(toPatch(select.value));
    });
  }

  /**
   * 档位控件随模式联动：透传 = 客户端说了算，档位不参与逻辑，控件禁用；
   * 覆盖 = 档位可编辑。值本身两态下都保存（`mode: passthrough` 时 `effort` 仅存
   * 不生效），所以这里只动 `disabled`，不清值——切回覆盖时不丢已选档位。
   */
  function syncReasoningEffortEnabled(mode) {
    var select = byRole("settings-reasoningEffort");
    if (select) select.disabled = mode !== "override";
  }

  /* ---- 自动抢套餐：只读状态 ------------------------------------------- */

  /** 最近一次 `/api/state` 里的 claim 段；缺席时收起整段。*/
  var claimOverviewSnapshot = null;
  /** 活动清单缓存：加载 / 就绪 / 失败三态。*/
  var claimActivities = { status: "idle" };
  /** 进设置页后已经拉过清单，避免视图切换与轮询重复打 billing 面。*/
  var claimActivitiesFetched = false;

  function bindClaimActivities() {
    var button = byRole("settings-claimRefresh");
    if (button) button.addEventListener("click", function () { loadClaimActivities(); });
  }

  /** 状态载荷到达时更新只读配置；活动清单只在进页与手动刷新时拉。*/
  function adoptClaimOverview(claim) {
    claimOverviewSnapshot = claim || null;
    renderClaimOverview();
    var enteringSettings = App.state.activeView === C.VIEW_SETTINGS;
    if (!enteringSettings) claimActivitiesFetched = false;
    if (enteringSettings && claim && !claimActivitiesFetched) {
      claimActivitiesFetched = true;
      loadClaimActivities();
    }
  }

  /**
   * 清单来自 `listClaimPlanChoices`，选项集合由发现层给出。面板只读名称、
   * 时间窗与台账标注，未知字段不会进入 DOM。
   */
  function loadClaimActivities() {
    claimActivities = { status: "loading" };
    renderClaimActivities();
    return App.api.sendControl({ cmd: "listClaimPlanChoices" }).then(function (body) {
      if (!body) {
        claimActivities = { status: "error", text: t("error.network_error") };
      } else if (body.ok && Array.isArray(body.plans)) {
        claimActivities = { status: "ready", plans: body.plans };
      } else if (body.ok) {
        claimActivities = { status: "ready", plans: [] };
      } else {
        claimActivities = { status: "error", text: App.i18n.errorText(body.error) };
      }
      renderClaimActivities();
      return null;
    });
  }

  /** 排序键与开抢节奏来自状态载荷；控制面没接时整段收起。*/
  function renderClaimOverview() {
    var root = byRole("settings-claimPolicy");
    var claim = claimOverviewSnapshot;
    if (!root || !claim || !claim.config) return;
    var config = claim.config;
    var opening = config.opening || {};
    root.textContent = config.policy || t("settings.claim.policy.none");
    var cadence = byRole("settings-claimCadence");
    if (!cadence) return;
    clear(cadence);
    var entries = [
      ["settings.claim.cadence.poll", config.pollIntervalMs],
      ["settings.claim.cadence.preheat", opening.preheatMs],
      ["settings.claim.cadence.probe", opening.probeIntervalMs],
      ["settings.claim.cadence.burst", opening.burstIntervalMs],
      ["settings.claim.cadence.burstWindow", opening.burstWindowMs],
    ];
    for (var i = 0; i < entries.length; i++) {
      if (typeof entries[i][1] !== "number") continue;
      cadence.appendChild(
        App.dom.create("span", "claim-overview__cadence-item", t(entries[i][0], { value: t("settings.claim.cadence.seconds", { value: (entries[i][1] / 1000).toFixed(0) }) })),
      );
    }
  }

  /** 只读活动行：状态、活动名、时间窗；名称由发现层给出，标识不入画面。*/
  function renderClaimActivities() {
    var list = byRole("settings-claimActivities");
    var status = byRole("settings-claimActivitiesStatus");
    if (!list || !status) return;
    clear(list);
    var plans = claimActivities.status === "ready" ? claimActivities.plans : [];
    for (var i = 0; i < plans.length; i++) {
      list.appendChild(buildClaimActivity(plans[i]));
    }
    setHidden(status, plans.length > 0);
    if (claimActivities.status === "loading" || claimActivities.status === "idle") {
      status.textContent = t("settings.claim.activities.loading");
    } else if (claimActivities.status === "error") {
      status.textContent = claimActivities.text || "";
    } else {
      status.textContent = t("settings.claim.activities.empty");
    }
  }

  function buildClaimActivity(plan) {
    var item = App.dom.create("li", "claim-overview__activity");
    var head = App.dom.create("div", "claim-overview__activity-head");
    var name = typeof plan.name === "string" && plan.name ? plan.name : t("settings.claim.activities.unnamed");
    var state = App.claimActivityState.stateOf(plan, claimOverviewSnapshot ? { config: claimOverviewSnapshot.config } : undefined);
    head.appendChild(App.dom.create("span", "claim-overview__activity-name", name));
    head.appendChild(App.dom.create("span", App.claimActivityState.tagClass(state), App.claimActivityState.label(state, plan)));
    item.appendChild(head);
    var windowText = App.claimActivityState.windowText(plan);
    if (windowText) item.appendChild(App.dom.create("span", "claim-overview__activity-window", windowText));
    return item;
  }

  /**
   * 数字控件：非法值先拒（服务端也会拒，但一次往返换一个红条不如当场说清楚）。
   * `allowFloat` 给比例型字段（`drainThreshold`）用。
   */
  function bindSettingsNumber(role, labelKey, allowFloat, toPatch) {
    var input = byRole(role);
    if (!input) return;
    input.addEventListener("change", function () {
      var value = Number(input.value);
      var valid = allowFloat ? isFinite(value) && value > 0 : forms.isPositiveInteger(value);
      if (!valid) {
        showSettingsError(t("settings.invalidNumber", { field: t(labelKey) }));
        restore();
        return;
      }
      App.api.writeSettingsPatch(toPatch(value));
    });
  }

  /**
   * 开关：`group` 选择补丁落在哪一段（缺省 `subsystems`）。
   *
   * 安全组的那一个（`requireKey`）走同一套：页面不关心 YAML 键名，只关心「这个开关
   * 属于哪一段」，与服务端 `SettingsPatch` 的形状一一对应。
   */
  function bindSettingsSwitch(role, field, group) {
    var input = byRole(role);
    if (!input) return;
    input.addEventListener("change", function () {
      var section = {};
      section[field] = input.checked;
      var patch = {};
      patch[group || "subsystems"] = section;
      App.api.writeSettingsPatch(patch);
    });
  }

  /* ---- 二次确认 -------------------------------------------------------- */

  /**
   * 为某个补丁弹确认框（服务端回了 `confirmation_required` 之后）。
   *
   * 文案按补丁里的 L3 字段选：绑定地址，或数据面鉴权开关（开 / 关）。
   */
  function confirmPatch(patch) {
    var security = patch.security || {};
    var options;
    if (security.host !== undefined) {
      options = {
        title: t("settings.host.confirmTitle"),
        text: t("settings.host.confirmText", { host: security.host }),
        warn: t("settings.host.confirmWarn"),
        danger: false,
        run: function () {
          App.api.writeSettingsPatch(patch, true);
        },
        onCancel: restore,
      };
    } else {
      var required = security.requireKey === true;
      options = {
        title: t(required ? "settings.requireKey.confirmOnTitle" : "settings.requireKey.confirmOffTitle"),
        text: t(required ? "settings.requireKey.confirmOnText" : "settings.requireKey.confirmOffText"),
        warn: t("settings.requireKey.confirmWarn"),
        danger: !required,
        run: function () {
          App.api.writeSettingsPatch(patch, true);
        },
        onCancel: restore,
      };
    }
    App.confirm.open(options);
  }

  /* ---- 设置页的横幅 ---------------------------------------------------- */

  function showSettingsError(text) {
    var banner = byRole("settings-error");
    if (!banner) return;
    setHidden(banner, text === null);
    setText("settings-error-text", text === null ? "" : text);
  }

  function showSettingsNotice(text) {
    var banner = byRole("settings-notice");
    if (!banner) return;
    setHidden(banner, text === null);
    setText("settings-notice-text", text === null ? "" : text);
  }

  /**
   * 短暂提示：A / B 类保存成功后「已生效」只停留几秒，到点自己收起。
   * 新的一次 flash 会重置计时器，连改几个字段不会互相覆盖掉前一条。
   */
  function flashSettingsNotice(text) {
    showSettingsNotice(text);
    if (noticeTimer !== null) window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(function () {
      noticeTimer = null;
      showSettingsNotice(null);
    }, C.SETTINGS_NOTICE_TTL_MS);
  }

  /**
   * 顶栏刷新：重读配置文件（`/api/settings`）。
   *
   * 走 `App.api.loadSettings`：文件
   * 可能被别的入口改过（手改 YAML / CLI），所以重读是这一页唯一有意义的「刷新」。
   */
  function refresh() {
    loadClaimActivities();
    return App.api.loadSettings();
  }

  /* ---- 高级区 ---------------------------------------------------------- */

  /**
   * 高级区（功能开关 + 身份）的开合。
   *
   * 与 `App.widgets` 那套折叠区不同，这里**不持久化**：高级区每次进页面都是收起的，
   * 状态只活在这次 DOM 上。折叠区那套把开合写进 sessionStorage，刷新后回到上次的
   * 状态——那是路由页 / 聊天页要的语义，设置页要的是相反的。
   *
   * 静态标记默认收起（`hidden` + `aria-expanded="false"` + `data-collapse-open="false"`），
   * 首帧不靠 JS 也不闪；这里只负责点击后的翻转，箭头朝向由 `data-collapse-open`
   * 驱动（样式在 `styles/views/settings.css`）。
   */
  function bindAdvancedSection() {
    var toggle = document.querySelector("[data-advanced-toggle]");
    if (!toggle) return;
    toggle.addEventListener("click", function () {
      var root = toggle.closest(".settings-advanced");
      var body = document.getElementById("settings-advanced-body");
      if (!root || !body) return;
      var open = body.hasAttribute("hidden");
      if (open) body.removeAttribute("hidden");
      else body.setAttribute("hidden", "");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      root.setAttribute("data-collapse-open", open ? "true" : "false");
    });
  }

  /** 语言切换后重画运行时拼出来的策略值与活动清单。*/
  function syncRuntimeText() {
    renderClaimOverview();
    renderClaimActivities();
  }

  App.views.settings = {
    render: renderSettings,
    refresh: refresh,
    adopt: adopt,
    restore: restore,
    confirmPatch: confirmPatch,
    bindControls: bindSettingsControls,
    showError: showSettingsError,
    showNotice: showSettingsNotice,
    flashNotice: flashSettingsNotice,
    syncRuntimeText: syncRuntimeText,
    adoptClaimOverview: adoptClaimOverview,
    refreshClaimActivities: loadClaimActivities,
    actions: {
      "settings-detect-app-version": syncAppVersion,
    },
  };
})(window.__zcodeApp = window.__zcodeApp || {});
