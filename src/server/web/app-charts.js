/*
 * app-charts.js — SVG 自绘图表（堆叠柱、单系柱、网格线 / 圆角柱顶 / 值刻度）。
 *
 * 零构建链纪律下不引入 chart 库：这里的全部图形就是原生 SVG 图元，由
 * `document.createElementNS` 逐个搭出来。输入是用量统计的时间桶形状
 * （`{bucketStart, inputTokens, outputTokens}`，空桶已由数据层补零）或一列单系
 * 数值（概览并发曲线也走同一套几何），输出一个 `.chart__frame` 容器——
 * 左侧值刻度列 + 右侧绘图区（`<svg>`），调用方自己塞进容器并负责空态提示
 * （本模块只画「基线」，提示行是视图的事）。
 *
 * 颜色不在这里写：图元只带 class（`.tokchart__in` / `.tokchart__out` /
 * `.tokchart__bar(--peak)` / `.tokchart__grid`），填色归 components.css 的
 * token——明暗两套主题各取各的蓝，图例（`.legend__swatch`）与柱子共享同一组
 * 类名色值。
 *
 * 为什么 viewBox 固定 600 宽 + `preserveAspectRatio="none"`：桶数随范围变化
 * （今天 24 个小时桶、7 天 168 个、30 天 720 个），让浏览器把同一份几何横向拉伸
 * 到容器宽，JS 不用读布局（offsetWidth 在每次重渲染时才稳定，首帧拿不到）。
 * 文字不进 SVG（非等比拉伸会把字拉变形）——值刻度画在 SVG 外面的
 * `.chart__scale` 列里（HTML 定位，纵向比例与 SVG 一致：两者的高度都是
 * options.height），峰值与合计仍由调用方写在 `.chart__meta` 行；每根柱的悬浮
 * 提示走 `<title>`（浏览器原生 tooltip）。
 *
 * 图表规范（本文件落地的三条）：
 *   - 水平网格线：基线（0）由 `.chart__plot` 的 border 画，内部刻度线由 SVG
 *     `<line>` 画；刻度取「把峰值包进 3–4 段的整值」（computeAxis 的 1/2/5 阶梯），
 *     于是图上总有 2–3 条内部横线、每条线在左侧刻度列有对应数值；
 *   - 柱宽 / 间距比例统一：柱宽 = 桶宽 × (1 − GAP_RATIO)，与桶数无关；桶很少
 *     （「全部」范围只命中过一两个小时）时桶宽会大到离谱，所以另有一道上限
 *     MAX_BAR，柱子在桶位内居中（单柱也还是柱子，不是一块色墙）；
 *   - 柱顶圆角 2px：顶段柱用带圆角的 `<path>`（底段仍是方角 `<rect>`——柱底
 *     坐在基线上，圆了会漏缝）。
 */
(function (App) {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  /** viewBox 宽度。只有比例有意义：rect 宽度按桶数均分，浏览器负责拉伸。 */
  var VIEW_WIDTH = 600;
  /** 柱与柱之间的缝占一份桶宽的比例：桶再多也读得出分界。 */
  var GAP_RATIO = 0.3;
  /** 有数据但小到画不出来时的最小高度（viewBox 单位，约等于渲染后的 1px）。 */
  var MIN_BAR = 1;
  /** 柱顶圆角半径：viewBox 纵向 1:1，渲染出来就是 2px。 */
  var CORNER_RADIUS = 2;
  /**
   * 单根柱的宽度上限（viewBox 单位，约合常见容器宽下的 24–40px）：桶位比它宽时
   * 柱子居中、两侧留白。桶数 ≥ 约 34 时这条从不生效（24 小时桶的桶宽已小于它），
   * 只有「全部」范围这种不补零、可能只有一两个桶的图会走到。
   */
  var MAX_BAR = 24;
  /** 网格线目标段数：把峰值向上包进 3–4 段（基线 + 2–3 条内部刻度线）。 */
  var AXIS_SPAN = 4;

  /**
   * 峰值 → 刻度轴。返回 `{max, ticks}`：max ≥ peak 是绘图区的满刻度（柱高按它
   * 归一），ticks 是内部网格线的值（升序，不含 0——基线由 CSS border 画）。
   *
   * 1/2/5 阶梯：step 取「≥ peak/段数」的最小整值档，柱形不会为凑整而压得
   * 太矮（max 最多比峰值大一段的 1/4）。
   */
  function computeAxis(peak) {
    if (!(peak > 0)) return { max: 1, ticks: [] };
    var raw = peak / AXIS_SPAN;
    var magnitude = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / magnitude;
    var unit = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    var step = unit * magnitude;
    var count = Math.ceil(peak / step - 1e-9);
    var ticks = [];
    for (var i = 1; i < count; i++) ticks.push(i * step);
    return { max: count * step, ticks: ticks };
  }

  /** 刻度值 → 默认文案：整数原样，小数留一位（并发曲线峰值 1 时会出 0.5）。 */
  function defaultTickText(value) {
    return value % 1 === 0 ? String(value) : String(Math.round(value * 10) / 10);
  }

  /**
   * 组一个图表框：值刻度列 + 绘图区。
   *
   * 刻度列与 SVG 的高度都由调用方给（frame 的内联 height 是纯几何值），
   * 两者的纵向比例天然一致：刻度 span 的 `bottom` 百分比就是该值占满刻度的比例。
   * 基线（0）永远有一格——空态时它是图上唯一的标记（空态画基线 + 提示）。
   */
  function buildFrame(height, axis, tickText) {
    var format = typeof tickText === "function" ? tickText : defaultTickText;
    var root = document.createElement("div");
    root.className = "chart__frame";
    root.style.height = height + "px";
    root.setAttribute("aria-hidden", "true");

    var scale = document.createElement("div");
    scale.className = "chart__scale";
    appendTick(scale, 0, format(0));
    for (var i = 0; i < axis.ticks.length; i++) {
      appendTick(scale, axis.ticks[i] / axis.max, format(axis.ticks[i]));
    }

    var plot = document.createElement("div");
    plot.className = "chart__plot";
    root.appendChild(scale);
    root.appendChild(plot);
    return { root: root, plot: plot };
  }

  /** 一格刻度：span 的底边贴在对应网格线上（标签在线的上方，恰好压住线）。 */
  function appendTick(scale, fraction, text) {
    var span = document.createElement("span");
    span.className = "chart__tick";
    span.style.bottom = fraction * 100 + "%";
    span.textContent = text;
    scale.appendChild(span);
  }

  function svgRoot(height) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + VIEW_WIDTH + " " + height);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "tokchart");
    svg.setAttribute("aria-hidden", "true");
    return svg;
  }

  /**
   * 一份桶宽 → 柱子的 `{width, inset}`：扣掉缝，再按 MAX_BAR 封顶。
   * 封顶后 inset 仍按桶宽算，柱子在自己的桶位里居中（横轴不歪）。
   */
  function barMetrics(slot) {
    var inner = Math.min(slot * (1 - GAP_RATIO), MAX_BAR);
    return { width: inner, inset: (slot - inner) / 2 };
  }

  /** 内部网格线（不含基线）：横向整线，纵向 1:1 拉伸所以笔画就是 1px。 */
  function appendGrid(svg, height, axis) {
    for (var i = 0; i < axis.ticks.length; i++) {
      var line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", "0");
      line.setAttribute("x2", String(VIEW_WIDTH));
      line.setAttribute("y1", String(height - (axis.ticks[i] / axis.max) * height));
      line.setAttribute("y2", String(height - (axis.ticks[i] / axis.max) * height));
      line.setAttribute("class", "tokchart__grid");
      svg.appendChild(line);
    }
  }

  /**
   * 顶段柱的圆角路径：只有顶上两个角是圆的（半径最小取到柱宽的一半与柱高，
   * 窄柱 / 矮柱不画出不存在的弧），底段柱仍走方角 rect。
   */
  function topRoundedPath(x, y, width, height) {
    var r = Math.min(CORNER_RADIUS, width / 2, height);
    return (
      "M" + x + " " + (y + height) +
      " L" + x + " " + (y + r) +
      " Q" + x + " " + y + " " + (x + r) + " " + y +
      " L" + (x + width - r) + " " + y +
      " Q" + (x + width) + " " + y + " " + (x + width) + " " + (y + r) +
      " L" + (x + width) + " " + (y + height) +
      " Z"
    );
  }

  /** 一根柱段（path 或 rect）：高度 ≤ 0 跳过（纯输入或纯输出的桶只有半根）。
   *  `tooltip` 是调用方当场算好的提示文案；不传就没有 `<title>`。 */
  function appendSegment(svg, x, y, width, height, className, rounded, tooltip) {
    if (height <= 0) return;
    var node;
    if (rounded) {
      node = document.createElementNS(SVG_NS, "path");
      node.setAttribute("d", topRoundedPath(x, y, width, height));
    } else {
      node = document.createElementNS(SVG_NS, "rect");
      node.setAttribute("x", String(x));
      node.setAttribute("y", String(y));
      node.setAttribute("width", String(width));
      node.setAttribute("height", String(height));
    }
    node.setAttribute("class", className);
    if (tooltip) {
      var title = document.createElementNS(SVG_NS, "title");
      title.textContent = tooltip;
      node.appendChild(title);
    }
    svg.appendChild(node);
  }

  /**
   * 画一张入/出堆叠柱图。
   *
   * `buckets`：时间桶数组（按桶起点升序）。`options.height`：viewBox 高度；
   * `options.label(bucket)`：每根柱的 `<title>` 提示文案；`options.tick(value)`：
   * 刻度数值的文案（token 桶传 token 缩写，缺省是纯数字）。
   *
   * 堆叠顺序：输入在下、输出在上——输入是请求的「底座」，输出是长在它上面的
   * 部分，与日志页 tokens 列「↑ 出 / ↓ 入」的两行顺序互补不冲突（图例注明）。
   * 空桶（0 填充出来的）整段留白：时间轴的「这里没有请求」本身就是信息。
   */
  function stackedBars(buckets, options) {
    var height = options && options.height ? options.height : 160;
    var peak = 0;
    for (var i = 0; i < buckets.length; i++) {
      var total = (buckets[i].inputTokens || 0) + (buckets[i].outputTokens || 0);
      if (total > peak) peak = total;
    }
    var axis = computeAxis(peak);
    var frame = buildFrame(height, axis, options && options.tick);
    var svg = svgRoot(height);
    appendGrid(svg, height, axis);

    var width = buckets.length > 0 ? VIEW_WIDTH / buckets.length : 0;
    var bar = barMetrics(width);
    var inner = bar.width;
    var inset = bar.inset;
    for (var j = 0; j < buckets.length; j++) {
      var bucket = buckets[j];
      var input = bucket.inputTokens || 0;
      var output = bucket.outputTokens || 0;
      if (input <= 0 && output <= 0) continue;
      var hIn = (input / axis.max) * height;
      var hOut = (output / axis.max) * height;
      /* 不到 1px 的柱补到 1px：补在顶段（输出）上，圆角仍落在顶段。 */
      if (hIn + hOut < MIN_BAR) hOut = MIN_BAR - hIn;
      var x = j * width + inset;
      var tooltip = options && typeof options.label === "function" ? options.label(bucket) : null;
      /* 输出在上：只有顶段（有输出时是输出段，纯输入桶是输入段）带圆角。 */
      if (hOut > 0) {
        appendSegment(svg, x, height - hIn - hOut, inner, hOut, "tokchart__out", true, tooltip);
        appendSegment(svg, x, height - hIn, inner, hIn, "tokchart__in", false, tooltip);
      } else {
        appendSegment(svg, x, height - hIn, inner, hIn, "tokchart__in", true, tooltip);
      }
    }
    frame.plot.appendChild(svg);
    return frame.root;
  }

  /**
   * 画一张单系柱图（概览并发曲线）。
   *
   * `values`：一列数值（顺序即横轴）；空位（0）留白。`options.height` /
   * `options.label(index, value)`（悬浮提示）/ `options.tick(value)` 同堆叠柱。
   * 峰值柱以实心强调（`.tokchart__bar--peak`），其余柱用浅一档的蓝——与堆叠柱
   * 的入 / 出两档同一色相系。
   */
  function bars(values, options) {
    var height = options && options.height ? options.height : 160;
    var peak = 0;
    for (var i = 0; i < values.length; i++) {
      if (values[i] > peak) peak = values[i];
    }
    var axis = computeAxis(peak);
    var frame = buildFrame(height, axis, options && options.tick);
    var svg = svgRoot(height);
    appendGrid(svg, height, axis);

    var width = values.length > 0 ? VIEW_WIDTH / values.length : 0;
    var bar = barMetrics(width);
    var inner = bar.width;
    var inset = bar.inset;
    for (var j = 0; j < values.length; j++) {
      var value = values[j];
      if (!(value > 0)) continue;
      var h = Math.max(MIN_BAR, (value / axis.max) * height);
      var x = j * width + inset;
      var className = value === peak ? "tokchart__bar tokchart__bar--peak" : "tokchart__bar";
      var tooltip = options && typeof options.label === "function" ? options.label(j, value) : null;
      appendSegment(svg, x, height - h, inner, h, className, true, tooltip);
    }
    frame.plot.appendChild(svg);
    return frame.root;
  }

  App.charts = { stackedBars: stackedBars, bars: bars };
})(window.__zcodeApp = window.__zcodeApp || {});
