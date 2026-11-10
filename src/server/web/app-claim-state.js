/*
 * app-claim-state.js — 活动展示状态：从时间窗、台账和领取结果推导出八种用户词。
 *
 * 时间字段是 unix 秒；状态载荷里的调度时刻是 unix ms。状态只用于展示与按钮可用性，
 * 不改变领取命令。`ledgerState`、`policy.userAction` 与 `period` 都是开放串：认得的
 * 值给对应展示，没认出的值按通用事实推导，不把未知活动丢掉或标成未知类型。
 */
(function (App) {
  "use strict";

  var t = App.i18n.t;
  var dateTime = App.format.dateTime;

  var STATE_ORDER = [
    "upcoming", "ready", "claimable", "pendingEffective",
    "claimed", "exhausted", "manual", "expired",
  ];
  /** 终态标签的颜色与账号详情窗、本期活动卡片一致。*/
  var TAG_CLASS = {
    claimed: "tag tag--ok",
    exhausted: "tag",
    manual: "tag",
    expired: "tag",
  };

  /** 领取在这些状态下禁用；`title` 说清原因。*/
  var DISABLED = {
    claimed: "accounts.claim.state.disabled.claimed",
    exhausted: "accounts.claim.state.disabled.exhausted",
    manual: "accounts.claim.state.disabled.manual",
    expired: "accounts.claim.state.disabled.expired",
  };

  /** 有限数字的时间值；字符串 / NaN 都当作没给。*/
  function time(value) {
    return typeof value === "number" && isFinite(value) ? value : undefined;
  }

  /** 台账状态与结果动作的归一化：大小写、连字符与下划线等价。*/
  function normalized(value) {
    return typeof value === "string" ? value.toLowerCase().replace(/[-_\s]/g, "") : "";
  }

  /** 策略表里的 `userAction` 是开放串；终态与人工验证动作都能直接落到展示。*/
  function stateFromUserAction(action) {
    var key = normalized(action);
    if (key.indexOf("captcha") >= 0 || key.indexOf("manual") >= 0) return "manual";
    if (key === "claimed" || key === "alreadyclaimed") return "claimed";
    if (key === "exhausted" || key === "quotaexhausted") return "exhausted";
    if (key === "expired") return "expired";
    return null;
  }

  function stateFromLedger(ledgerState) {
    var key = normalized(ledgerState);
    if (key === "exhausted") return "exhausted";
    if (key === "expired") return "expired";
    if (key === "claimed" || key === "claimedearlier") return "claimed";
    if (key === "effective") return "pendingEffective";
    if (key === "captcha" || key.indexOf("manual") >= 0) return "manual";
    return null;
  }

  function stateFromOutcome(outcome) {
    if (!outcome) return null;
    var fromPolicy = stateFromUserAction(
      outcome.userAction || outcome.policyUserAction || (outcome.policy && outcome.policy.userAction),
    );
    if (fromPolicy) return fromPolicy;
    var key = normalized(outcome.failureKind || outcome.lastOutcome);
    if (key === "quotaexhausted" || key.indexOf("exhausted") >= 0) return "exhausted";
    if (key === "captcha" || key.indexOf("captcha") >= 0 || key.indexOf("manual") >= 0) return "manual";
    if (key === "alreadyclaimed" || key === "claimed") return "claimed";
    if (key === "expired" || key === "unavailable") return "expired";
    return null;
  }

  function holdForPlan(row, planId) {
    if (!row || !row.planHolds) return null;
    var holds = row.planHolds;
    return Object.prototype.hasOwnProperty.call(holds, planId) ? holds[planId] : null;
  }

  /**
   * 一条活动的展示状态。判定顺序：台账与最近结果 → 时间窗 → 预热 → 待生效 →
   * 可领。已经领过的活动仍显示「已领」，即便时间窗已过。
   */
  function stateOf(plan, row, outcome, now) {
    var at = typeof now === "number" ? now : Date.now();
    var ledger = stateFromLedger(plan && plan.ledgerState);
    if (ledger) return ledger;

    var fromResult = stateFromOutcome(outcome);
    if (fromResult) return fromResult;
    var hold = holdForPlan(row, plan && plan.planId);
    var holdReason = stateFromOutcome({ failureKind: hold && hold.reason });
    if (holdReason) return holdReason;
    if (stateFromUserAction(row && row.userAction)) return stateFromUserAction(row.userAction);
    if (stateFromUserAction(plan && plan.userAction)) return stateFromUserAction(plan.userAction);

    var starts = time(plan && plan.startsAt);
    var effective = time(plan && plan.effectiveAt);
    var ends = time(plan && plan.endsAt);
    var nowSec = at / 1000;
    var opening = row && row.config && row.config.opening ? row.config.opening : {};
    var preheatMs = time(opening.preheatMs);
    if (preheatMs === undefined) preheatMs = 180000;

    if (ends !== undefined && ends <= nowSec) return "expired";
    if (starts !== undefined && starts > nowSec) {
      return starts * 1000 - at <= preheatMs ? "ready" : "upcoming";
    }
    if (effective !== undefined && effective > nowSec) return "pendingEffective";
    return "claimable";
  }

  function label(state, plan) {
    if (state === "pendingEffective" && time(plan && plan.effectiveAt) !== undefined) {
      return t("accounts.claim.state.pendingEffective.at", { time: dateTime(plan.effectiveAt * 1000) });
    }
    return t("accounts.claim.state." + state);
  }

  /** 状态标签之外的一句可操作提示（人工验证 / 名额耗尽）。*/
  function hint(state) {
    if (state === "manual") return t("accounts.claim.state.manual.hint");
    if (state === "exhausted") return t("accounts.claim.state.exhausted.hint");
    return "";
  }

  /** 开领 / 权益生效 / 结束三个时间分别显示；缺失的时刻不占位。*/
  function windowLines(plan) {
    var lines = [];
    var starts = time(plan && plan.startsAt);
    var effective = time(plan && plan.effectiveAt);
    var ends = time(plan && plan.endsAt);
    if (starts !== undefined) lines.push(t("accounts.claim.window.claim", { time: dateTime(starts * 1000) }));
    if (effective !== undefined) lines.push(t("accounts.claim.window.effective", { time: dateTime(effective * 1000) }));
    if (ends !== undefined) lines.push(t("accounts.claim.window.end", { time: dateTime(ends * 1000) }));
    return lines;
  }

  /** 设置页的一行时间窗摘要；没有时间字段时为空串。*/
  function windowText(plan) {
    var lines = windowLines(plan);
    return lines.length > 0 ? lines.join(" · ") : "";
  }

  /** 领取按钮是否禁用，以及禁用时的 title 文案。*/
  function disabledReason(state) {
    return DISABLED[state] ? t(DISABLED[state]) : "";
  }

  /** 三处面板共用同一套标签 class，终态不会各画一种颜色。*/
  function tagClass(state) {
    return TAG_CLASS[state] || "tag";
  }

  /** 权益摘要：`period` 是上游自由串，原样显示；缺字段不编造。*/
  function entitlementText(entitlement) {
    var parts = [];
    var name = entitlement && (entitlement.showName || entitlement.entitlementId);
    if (name) parts.push(String(name));
    if (entitlement && typeof entitlement.grantUnits === "number") {
      var amount = App.format.units(entitlement.grantUnits);
      if (entitlement.unitType) amount += " " + entitlement.unitType;
      parts.push(amount);
    }
    if (entitlement && entitlement.meter) parts.push(String(entitlement.meter));
    if (entitlement && entitlement.period) parts.push(String(entitlement.period));
    return parts.join(" · ");
  }

  /**
   * 日志诊断码 → 用户可读的原因。原始码仍留在日志正文里；面板拿到结构化原因时
   * 可调用这里换成用户词，日志生成逻辑不归它管。
   */
  var LOG_REASONS = {
    "empty": "logs.claim.reason.empty",
    "noDelivery": "logs.claim.reason.empty",
    "no_delivery": "logs.claim.reason.empty",
    "versionGate": "logs.claim.reason.versionGate",
    "version_gate": "logs.claim.reason.versionGate",
    "ineligible": "logs.claim.reason.ineligible",
    "1004": "logs.claim.reason.ineligible",
    "captcha": "logs.claim.reason.captcha",
    "3007": "logs.claim.reason.captcha",
    "rateLimited": "logs.claim.reason.rateLimited",
    "rate_limited": "logs.claim.reason.rateLimited",
    "429": "logs.claim.reason.rateLimited",
    "3002": "logs.claim.reason.rateLimited",
  };

  function logReasonText(code) {
    var key = LOG_REASONS[typeof code === "string" ? code : String(code)];
    return key ? t(key) : t("logs.claim.reason.unknown");
  }

  /** 失败结果 → 用户词；没有对应项时用通用句，不露裸错误码。*/
  function outcomeText(outcome) {
    var key = normalized(outcome && (outcome.failureKind || outcome.lastOutcome));
    if (key === "unavailable" || key === "notfound") return t("accounts.claim.result.unavailable");
    if (key === "ineligible") return t("accounts.claim.result.ineligible");
    if (key === "ratelimited") return t("accounts.claim.result.rateLimited");
    if (key === "loginrequired") return t("accounts.claim.result.loginRequired");
    if (key === "quotaexhausted") return t("accounts.claim.state.exhausted.hint");
    if (key === "captcha") return t("accounts.claim.state.manual.hint");
    if (key === "alreadyclaimed") return t("accounts.claim.state.disabled.claimed");
    return t("accounts.claim.result.unknown");
  }

  App.claimActivityState = {
    order: STATE_ORDER,
    stateOf: stateOf,
    label: label,
    hint: hint,
    windowLines: windowLines,
    windowText: windowText,
    disabledReason: disabledReason,
    tagClass: tagClass,
    entitlementText: entitlementText,
    outcomeText: outcomeText,
    logReasonText: logReasonText,
  };
})(window.__zcodeApp = window.__zcodeApp || {});
