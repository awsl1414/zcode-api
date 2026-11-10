/*
 * app-i18n.js — 查表、插值、批量应用，以及语言切换。
 *
 * 两套字典由服务端塞进 `<script type="application/json" id="i18n-dicts">`，页面自己
 * 查表（不引入 i18n 库）。缺键时保留元素里原本写着的中文原文，这是增量翻译
 * 表的降级路径：漏一条不该让界面出现空块或裸键名。
 *
 * 语言优先级：localStorage > navigator.language > en。
 *
 * 切换语言时不止要重跑静态文案，还要重跑那些运行时拼出来的文本：下拉选项、
 * 日志连接状态、暂停按钮、设置页的只读值、账号表格。所以 `applyLanguage` 会在最后
 * 通知各视图重画一次，调用点集中在这里，视图之间不用互相知道对方的存在。
 */
(function (App) {
  "use strict";

  var C = App.const;
  var byId = App.dom.byId;
  var store = App.store;

  var dicts = {};
  var language = C.DEFAULT_LANGUAGE;

  function readDicts() {
    var node = byId("i18n-dicts");
    try {
      return JSON.parse(node.textContent || "{}");
    } catch {
      /* 字典是拼装期写进去的常量；解析不出来就当作「没有翻译」，
         页面回退到 html 里写好的中文原文（与缺键时同一个降级思路）*/
      return {};
    }
  }

  /** 查表：当前语言，兜底语言（en），最后 `undefined`（交给原文）。*/
  function lookup(key) {
    var current = dicts[language] || {};
    if (Object.prototype.hasOwnProperty.call(current, key)) return current[key];
    var fallback = dicts[C.DEFAULT_LANGUAGE] || {};
    if (Object.prototype.hasOwnProperty.call(fallback, key)) return fallback[key];
    return undefined;
  }

  function interpolate(text, vars) {
    if (!vars) return text;
    return text.replace(C.INTERPOLATION, function (match, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match;
    });
  }

  /** 运行时拼出来的文案（表格、告警）：缺键时把键本身露出来，便于定位。*/
  function t(key, vars) {
    var value = lookup(key);
    return interpolate(value === undefined ? key : value, vars);
  }

  /**
   * 后端错误码到文案。
   *
   * 有翻译就用翻译，没有就把码原文露出来。技术上可诊断，也好补键。
   */
  function errorText(code) {
    var value = lookup("error." + code);
    return value === undefined ? code : value;
  }

  /** `data-i18n-vars="count:3,name:x"`，逐元素的插值变量。*/
  function readVars(node) {
    var raw = node.getAttribute(C.VARS_ATTR);
    if (!raw) return null;
    var vars = {};
    var pairs = raw.split(",");
    for (var i = 0; i < pairs.length; i++) {
      var parts = pairs[i].split(":");
      if (parts.length !== 2) continue;
      vars[parts[0].trim()] = parts[1].trim();
    }
    return vars;
  }

  /**
   * 批量应用翻译。
   *
   * 缺键时保留元素里原本写着的文案（页面里的中文原文）。翻译表是增量的，漏一条
   * 不该让界面出现空块或裸键名。
   */
  function applyI18n(root) {
    var scope = root || document;

    var texts = scope.querySelectorAll("[data-i18n]");
    for (var i = 0; i < texts.length; i++) {
      var value = lookup(texts[i].getAttribute("data-i18n"));
      if (value === undefined) continue;
      texts[i].textContent = interpolate(value, readVars(texts[i]));
    }

    var attrs = scope.querySelectorAll("[data-i18n-attr]");
    for (var j = 0; j < attrs.length; j++) {
      var node = attrs[j];
      var vars = readVars(node);
      var pairs = node.getAttribute("data-i18n-attr").split(",");
      for (var k = 0; k < pairs.length; k++) {
        var parts = pairs[k].split(":");
        if (parts.length !== 2) continue;
        var attrValue = lookup(parts[1].trim());
        if (attrValue === undefined) continue;
        node.setAttribute(parts[0].trim(), interpolate(attrValue, vars));
      }
    }
  }

  function readLanguage() {
    var stored = store.read(C.LANGUAGE_STORAGE_KEY);
    if (C.LANGUAGES.indexOf(stored) >= 0) return stored;
    var preferred = (window.navigator.language || "").toLowerCase();
    return preferred.indexOf("zh") === 0 ? "zh" : C.DEFAULT_LANGUAGE;
  }

  /**
   * 语言下拉（面板顶栏右侧一只；登录页另有一只自己的，那页没有顶栏，
   * 仍用 `prefs-lang` 这个 id 在自己的脚本里绑）。
   *
   * 同步按 data-role 找：顶栏这一只随语言切换要立刻反映新值，不能只靠
   * applyI18n 重写 option 文案。
   */
  function syncLanguageSelect() {
    var selects = document.querySelectorAll('[data-role="lang-select"]');
    for (var i = 0; i < selects.length; i++) selects[i].value = language;
    var legacy = byId("prefs-lang");
    if (legacy) legacy.value = language;
  }

  /** 应用语言但不写存储（首屏检测用）；用户手动切换走 {@link setLanguage}。*/
  function applyLanguage(next) {
    language = C.LANGUAGES.indexOf(next) >= 0 ? next : C.DEFAULT_LANGUAGE;
    document.documentElement.setAttribute("lang", C.HTML_LANG[language]);
    syncLanguageSelect();
    applyI18n(document);
    /* 下面四步重跑的是运行时拼出来的文本（下拉选项 / 日志连接状态 / 设置页只读值 /
       整页状态）。它们是面板的视图，聊天页没有，所以逐个判存在：这个模块是两页
       共用的，不能假定当前页面有哪几个视图。*/
    if (App.initSelectOptions) App.initSelectOptions();
    if (App.views.logs) App.views.logs.renderControls();
    /* 聊天视图的下拉默认项 / key 选项 / 会话列表也是运行时拼的，随语言重画。 */
    if (App.views.chat) App.views.chat.renderChrome();
    if (App.views.settings) App.views.settings.render();
    /* 设置页的抢套餐策略值与活动清单是运行时拼的（数值、活动名、空态），
       `render()` 只管快照投影，这一句把它们按新语言重写一次。 */
    if (App.views.settings && App.views.settings.syncRuntimeText) App.views.settings.syncRuntimeText();
    /* 设置页说明行的「短句完整 / 长句折起」：分档看的是**当前语言**下的
       文案长度（中文 16 字的一句话，英文是 62 字），所以它必须在 applyI18n 之后重算。 */
    if (App.views.settings && App.views.settings.syncHints) App.views.settings.syncHints();
    /* 统计视图的表格、卡行与热力图 title 也是运行时拼的，随语言重画：
       render() 只投影模块状态，没有数据时安全地回到加载 / 空态。 */
    if (App.views.stats) App.views.stats.render();
    /* 账号页的「已选文件名」是运行时文本：它是用户选的文件，不在字典里，
       但「未选择文件」那一半边要跟着语言换。 */
    if (App.views.accounts && App.views.accounts.renderTransfer) App.views.accounts.renderTransfer();
    /* 主题按钮的 title / aria-label 是运行时拼的（「主题 · 跟随系统」），
       随语言重写；applyI18n 先跑（会重写静态的兑底 aria-label），这一步在它
       之后把完整提示写回去。 */
    if (App.theme && App.theme.sync) App.theme.sync();
    /* 顶栏刷新的 title / aria-label 也是运行时拼的（「刷新当前视图」/
       「当前页面无需刷新」），与主题按钮同一条理由：applyI18n 先写静态兑底，
       这里按当前视图（以及日志页的 tab）把真正的那句写回去。 */
    if (App.refresh && App.refresh.sync) App.refresh.sync();
    /* 侧边栏折叠：折叠态的导航 tooltip 取的就是刚才被重写的标签文字，
       按钮提示语（折叠 / 展开侧边栏）也是运行时拼的。与主题按钮同一条理由，
       排在 applyI18n 之后。 */
    if (App.sidebar && App.sidebar.sync) App.sidebar.sync();
    /* 登录面板的状态行是运行时拼的（带错误明细），不走 `data-i18n`，所以要重画一次 */
    if (App.views.add) App.views.add.renderStatus();
    /* 添加账号模态里「未选择文件」那句同理：它是运行时文本，字典里那一半要跟着语言换。 */
    if (App.views.add && App.views.add.renderCredentialFile) App.views.add.renderCredentialFile();
    if (App.renderState) App.renderState(App.state.lastState);
  }

  function setLanguage(next) {
    store.write(C.LANGUAGE_STORAGE_KEY, C.LANGUAGES.indexOf(next) >= 0 ? next : C.DEFAULT_LANGUAGE);
    applyLanguage(next);
  }

  /** 首屏：把服务端塞进来的字典读进来（`init` 只调这一次）。*/
  function load() {
    dicts = readDicts();
  }

  App.i18n = {
    load: load,
    t: t,
    lookup: lookup,
    errorText: errorText,
    readLanguage: readLanguage,
    /** 当前语言（formatUnits 这类按语言分单位的格式化函数读它）。*/
    language: function () {
      return language;
    },
    applyLanguage: applyLanguage,
    setLanguage: setLanguage,
  };
})(window.__zcodeApp = window.__zcodeApp || {});
