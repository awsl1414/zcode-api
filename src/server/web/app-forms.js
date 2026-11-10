/*
 * app-forms.js — 表单控件的读写与静态选项初始化。
 *
 * 页面上几十个下拉 / 数字框 / 开关走的是同一套动作：按 `data-role` 取节点、把服务端
 * 的值写进去、把用户的值读出来。写进去的时候有个共同的约束：用户正在编辑的控件
 * 不能被轮询覆盖，否则输入框会在他打字的中途自己跳回旧值。`document.activeElement`
 * 是判断这件事的唯一可靠信号，所以这层判断收在这里，各视图不必各写一遍。
 *
 * 整数校验与服务端同口径（`isPositiveInteger` / `isNonNegativeInteger`）：页面先拒是
 * 为了省一次往返，服务端仍然会拒，两边的判据必须一致。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var byRole = App.dom.byRole;
  var clear = App.dom.clear;
  var t = App.i18n.t;

  /** 一个 `<option>`（值加文案）。*/
  function buildOption(value, label) {
    var option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }

  /** 枚举到下拉：选项文案走 `option.<group>.<value>`，值就是服务端的枚举值。*/
  function fillSelect(role, group, values) {
    var select = byRole(role);
    if (!select) return;
    clear(select);
    for (var i = 0; i < values.length; i++) {
      select.appendChild(buildOption(values[i], t("option." + group + "." + values[i])));
    }
  }

  /**
   * 静态选项只建一次（语言切换时重建）。
   *
   * 每次轮询都重建会把用户正在展开的原生下拉合上，也会丢焦点，所以选项内容与
   * 服务端数据无关的这几个下拉，只在启动与切换语言时填。
   */
  function initSelects() {
    fillSelect("routing-mode", "mode", C.ROUTING_MODE_OPTIONS);
    fillSelect("routing-strategy", "strategy", C.ROUTING_STRATEGY_OPTIONS);
    fillSelect("routing-saturated", "saturated", C.SATURATED_OPTIONS);
    fillSelect("routing-drained", "drained", C.DRAINED_OPTIONS);
    fillSelect("routing-authfailed", "authFailed", C.AUTH_FAILED_OPTIONS);
    fillSelect("stickiness-onSaturated", "stickinessSaturated", C.STICKINESS_SATURATED_OPTIONS);
    fillSelect("log-level", "logLevel", C.LOG_LEVEL_FILTERS);
    fillSelect("req-status", "reqStatus", C.REQUEST_STATUS_FILTERS);
    fillSelect("settings-clientMode", "clientIdentityMode", C.CLIENT_IDENTITY_MODE_OPTIONS);
    fillSelect("settings-reasoningMode", "reasoningMode", C.REASONING_MODE_OPTIONS);
    fillSelect("settings-reasoningEffort", "reasoningEffort", C.REASONING_EFFORT_OPTIONS);
    fillSelect("accounts-exportFormat", "exportFormat", C.EXPORT_FORMATS);
    var exportFormat = byRole("accounts-exportFormat");
    if (exportFormat) exportFormat.value = C.DEFAULT_EXPORT_FORMAT;
  }

  function setSelectValue(role, value) {
    var select = byRole(role);
    if (select && select.value !== String(value)) select.value = String(value);
  }

  /** 数字字段：用户正在编辑时不要被轮询覆盖。*/
  function setNumberValue(role, value) {
    var input = byRole(role);
    if (!input) return;
    if (document.activeElement === input) return;
    if (input.value !== String(value)) input.value = String(value);
  }

  function setChecked(role, checked) {
    var input = byRole(role);
    if (input && input.checked !== checked) input.checked = checked;
  }

  function isPositiveInteger(value) {
    return typeof value === "number" && isFinite(value) && Math.floor(value) === value && value >= C.MIN_WEIGHT;
  }

  function isNonNegativeInteger(value) {
    return typeof value === "number" && isFinite(value) && Math.floor(value) === value && value >= 0;
  }

  App.forms = {
    buildOption: buildOption,
    initSelects: initSelects,
    setSelectValue: setSelectValue,
    setNumberValue: setNumberValue,
    setChecked: setChecked,
    isPositiveInteger: isPositiveInteger,
    isNonNegativeInteger: isNonNegativeInteger,
  };
})(window.__zcodeApp = window.__zcodeApp || {});
