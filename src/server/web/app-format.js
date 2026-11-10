/*
 * app-format.js — 把服务端给的秒数 / 毫秒数写成界面上的一句短文本。
 *
 * 这里的格式化函数都被不止一处用到（运行时长在概览与设置页各显示一次，额度重置
 * 倒计时与套餐详情卡在账号页），所以单列。单位一律取整到最小可读档位，不补零、
 * 不带多余小数：这些数字是给人扫一眼的，不是给机器解析的。
 */
(function (App) {
  "use strict";

  var C = App.const;

  /*
   * 数值缩写的进位与档位（token 数）。
   *
   * 中文走万进制（万 = 1e4、亿 = 1e8），英文走 SI 前缀（K/M/B）。UNIT_FLOOR 是
   * 「不缩写」的下限：小于它的数字原样显示，999K 那种三位数缩写反而更难读。
   * 万/亿之间隔着 ×1e4，K/M/B 之间隔着 ×1e3，所以「够 1 档才进位」的判据
   * （parseFloat ≥ 进位）在两套单位里都要单独写。
   */
  var UNIT_FLOOR = 1000;
  var KILO = 1000;
  var MEGA = 1000000;
  var GIGA = 1000000000;
  var WAN = 10000;
  var YI = 100000000;

  /** 运行时长：`2h 5m` / `5m 30s` / `30s`。*/
  function formatUptime(totalSeconds) {
    var seconds = Math.max(0, Math.floor(totalSeconds));
    var minutes = Math.floor(seconds / C.SECONDS_PER_MINUTE);
    var hours = Math.floor(minutes / C.MINUTES_PER_HOUR);
    if (hours > 0) return hours + "h " + (minutes % C.MINUTES_PER_HOUR) + "m";
    if (minutes > 0) return minutes + "m " + (seconds % C.SECONDS_PER_MINUTE) + "s";
    return seconds + "s";
  }

  /** 倒计时：相邻两档（`3d 6h` / `1h 26m` / `26m 10s`），额度窗口重置用。*/
  function formatCountdown(remainingMs) {
    var seconds = Math.max(0, Math.round(remainingMs / 1000));
    var days = Math.floor(seconds / C.SECONDS_PER_DAY);
    if (days > 0) return days + "d " + Math.floor((seconds % C.SECONDS_PER_DAY) / C.SECONDS_PER_HOUR) + "h";
    var hours = Math.floor(seconds / C.SECONDS_PER_HOUR);
    if (hours > 0) return hours + "h " + Math.floor((seconds % C.SECONDS_PER_HOUR) / C.SECONDS_PER_MINUTE) + "m";
    var minutes = Math.floor(seconds / C.SECONDS_PER_MINUTE);
    if (minutes > 0) return minutes + "m " + (seconds % C.SECONDS_PER_MINUTE) + "s";
    return seconds + "s";
  }

  /**
   * 大数缩写：`999` / `1.2k` / `34k` / `1.2m`。
   *
   * 用在 API key 的用量列：token 数是七位数，逐位显示会把表格撑开，而这一列
   * 是给人扫一眼「谁用得多」的。千位以下不缩写，因为那才是绝大多数 key 的日常。
   *
   * 进位与 `formatUnits` 同一条判据：**取整后够上一档就升档**。少了这一步，
   * 跳档边界会写出四位数（`999999` → `1000k`、`999999999` → `1000.0m`），
   * 同一列相邻值位数翻倍，读起来像两种量级。k 的三位数档不进位（`999k` 仍是
   * 三个数字位），只处理「取整后变成 1000」的那一格。
   */
  function formatCompact(value) {
    var n = Number(value);
    if (!isFinite(n) || n < 0) n = 0;
    if (n < 1000) return String(Math.floor(n));
    if (n < 10000) return (n / 1000).toFixed(1) + "k";
    if (n < 1000000) {
      var kilo = Math.round(n / 1000);
      /* 999999 → 1000k：取整够 1000 就交给 m 那一档（那里再按同一条判据进位）。 */
      if (kilo < 1000) return kilo + "k";
    }
    var mega = (n / 1000000).toFixed(1);
    if (parseFloat(mega) >= 1000) return trimDecimalZeros((n / GIGA).toFixed(1)) + "g";
    return trimDecimalZeros(mega) + "m";
  }

  /** 负数 / 非有限值都按 0 处理：套餐量是计数，页面不该显示 NaN。*/
  function normalizedCount(value) {
    var n = Number(value);
    if (!isFinite(n) || n < 0) return 0;
    return n;
  }

  /** 只剥小数部分的尾零：`10.0` → `10`、`6.40` → `6.4`；整数段一个零都不动。*/
  function trimDecimalZeros(text) {
    if (text.indexOf(".") < 0) return text;
    return text.replace(/0+$/, "").replace(/\.$/, "");
  }

  /**
   * token 数的中文单位：万 / 亿。
   *
   * 先按万取一位小数；取整后够 1 亿就升到亿（两位小数）。9999 取整成 1.0万，
   * 所以进位前的边界值显示成「1万」而不是「9999」。
   */
  function formatUnitsZh(value) {
    var n = normalizedCount(value);
    if (n < UNIT_FLOOR) return String(Math.round(n));
    var wan = (n / WAN).toFixed(1);
    if (parseFloat(wan) >= WAN) return trimDecimalZeros((n / YI).toFixed(2)) + "亿";
    return trimDecimalZeros(wan) + "万";
  }

  /**
   * token 数的英文单位：K / M / B。
   *
   * K 一位小数，M/B 两位；取整后够上一档就升档（999999 → 1M，不显示 1000K）。
   */
  function formatUnitsEn(value) {
    var n = normalizedCount(value);
    if (n < UNIT_FLOOR) return String(Math.round(n));
    var kilo = (n / KILO).toFixed(1);
    if (parseFloat(kilo) >= KILO) {
      var mega = (n / MEGA).toFixed(2);
      if (parseFloat(mega) >= KILO) return trimDecimalZeros((n / GIGA).toFixed(2)) + "B";
      return trimDecimalZeros(mega) + "M";
    }
    return trimDecimalZeros(kilo) + "K";
  }

  /**
   * token 数 → 当前语言的缩写（中文 亿/万，英文 K/M/B）。
   *
   * `lang` 给测试与调用方显式钉语言用；缺省读面板当前语言（i18n 模块没就位时
   * 退回默认语言，app-format 比 app-i18n 先拼）。
   */
  function formatUnits(value, lang) {
    var language = lang || (App.i18n && App.i18n.language ? App.i18n.language() : C.DEFAULT_LANGUAGE);
    return language === "zh" ? formatUnitsZh(value) : formatUnitsEn(value);
  }

  /**
   * 时间戳 → `2026/11/9 09:00:00`（本地时区）。
   *
   * 日期段不补零（套餐到期不是表格列，宽一点没关系），时刻段补零：时分秒对齐才
   * 好扫。无效时间戳回空串，调用方直接跳过那一行。
   */
  function formatDateTime(epochMs) {
    var date = new Date(epochMs);
    if (isNaN(date.getTime())) return "";
    var pad = function (n) {
      return (n < 10 ? "0" : "") + n;
    };
    return (
      date.getFullYear() +
      "/" +
      (date.getMonth() + 1) +
      "/" +
      date.getDate() +
      " " +
      pad(date.getHours()) +
      ":" +
      pad(date.getMinutes()) +
      ":" +
      pad(date.getSeconds())
    );
  }

  /** 月份缩写（英文日期用）：与 `Intl.DateTimeFormat(en, {month:"short"})` 的取值一致。*/
  var MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /** 星期的单字中文（热力图左侧那一列：`日` / `一` / …）。*/
  var WEEKDAYS_ZH = ["日", "一", "二", "三", "四", "五", "六"];
  /** 星期缩写（英文）：同 `Intl.DateTimeFormat(en, {weekday:"short"})`。*/
  var WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  /**
   * 月份标签（热力图底部月轴）：中文 `1月`、英文 `Jan`。
   *
   * 不写进 i18n 字典：月份名不是「一句话」，而是一张与语言绑定的常量表，
   * 与下面的星期表、上面的 `MONTHS_EN` 同一类——字典里放 24 个 `stats.heatmap.*`
   * 键只会让增量翻译表更难维护。语言取值走 `currentLanguage()`，与 `formatDate` 同一条路。
   */
  function formatMonth(monthIndex) {
    var index = ((Math.floor(monthIndex) % 12) + 12) % 12;
    return currentLanguage() === "zh" ? index + 1 + "月" : MONTHS_EN[index];
  }

  /**
   * 星期标签（热力图左侧）：`0` = 周日 … `6` = 周六，
   * 中文单字（`一`）、英文三字母（`Mon`）。
   */
  function formatWeekday(dayIndex) {
    var index = ((Math.floor(dayIndex) % 7) + 7) % 7;
    return currentLanguage() === "zh" ? WEEKDAYS_ZH[index] : WEEKDAYS_EN[index];
  }

  /**
   * 时间戳 → 日期：中文 `11月11日`、英文 `Nov 11`。
   *
   * 官方额度卡的周 / 月窗口重置就是这个口径（`formatQuotaResetTime` 的 `date`
   * 档：`{ month: "short", day: "numeric" }`）。不在这里写死中文——语言从 i18n
   * 模块读，与 `formatUnits` 同一条路。
   */
  function formatDate(epochMs) {
    var date = new Date(epochMs);
    if (isNaN(date.getTime())) return "";
    if (currentLanguage() === "zh") return date.getMonth() + 1 + "月" + date.getDate() + "日";
    return MONTHS_EN[date.getMonth()] + " " + date.getDate();
  }

  /**
   * 时间戳 → `11/9 09:00`：套餐卡头的到期时刻。
   *
   * 不画年份：套餐卡的“到期”都在一年内（官方额度卡的周 / 日窗口同日径），四位
   * 年份会把卡头挤到折行；要绝对时刻时开 ⌅ → 本期活动里有完整的 `formatDateTime`。
   */
  function formatShortDateTime(epochMs) {
    var date = new Date(epochMs);
    if (isNaN(date.getTime())) return "";
    var pad = function (n) {
      return (n < 10 ? "0" : "") + n;
    };
    return date.getMonth() + 1 + "/" + date.getDate() + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  /**
   * 时间戳 → 时刻 `23:59`：daily 桶的「每日重置」只报时刻——它每天重置，
   * 日期是冗余的。无效时间戳回空串。
   */
  function formatClock(epochMs) {
    var date = new Date(epochMs);
    if (isNaN(date.getTime())) return "";
    var pad = function (n) {
      return (n < 10 ? "0" : "") + n;
    };
    return pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  /** 当前语言（i18n 模块未就位时退回默认语言，与 `formatUnits` 同一条退化）。*/
  function currentLanguage() {
    return App.i18n && App.i18n.language ? App.i18n.language() : C.DEFAULT_LANGUAGE;
  }

  App.format = {
    uptime: formatUptime,
    countdown: formatCountdown,
    compact: formatCompact,
    units: formatUnits,
    dateTime: formatDateTime,
    date: formatDate,
    month: formatMonth,
    weekday: formatWeekday,
    shortDateTime: formatShortDateTime,
    clock: formatClock,
  };
})(window.__zcodeApp = window.__zcodeApp || {});
