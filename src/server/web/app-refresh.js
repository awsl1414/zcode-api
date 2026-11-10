/*
 * app-refresh.js — 顶栏刷新：一颗图标按钮，语义是「刷新当前视图的数据」。
 *
 * 为什么收敛到顶栏：刷新在八个视图里的意思几乎一样（「把这一页的数据重新取一次」），
 * 分散到各页时（统计页范围栏、设置页页头、账号页抽屉各有一颗）文案、在途态与
 * 失败处理各不相同，读者每换一页都要重新找一次。所以只留一个入口，位置固定在顶栏
 * 右侧（跨视图不变），含义由 `state.activeView` 决定。
 *
 * 分工：本文件只做**派发与按钮状态**，取数细节留在各视图自己的 `refresh()` 里。
 * 视图模块暴露一个 `refresh()`（返回 Promise 或 null），没有这个出口的视图
 * （聊天）就是「这一页没有服务端数据」，按钮置灰。日志页是唯一按 tab 变的视图
 * （请求事件是拉来的，系统日志是 SSE 实时推送的），所以它多暴露一个
 * `canRefresh()`；没有这个函数的视图默认可刷新。
 *
 * 为什么不把映射表写在 `app.js`：`app.js` 是编排层（选视图、绑事件），把每个视图
 * 的取数入口再抄一遍会让它知道得太多；这里按 `App.views[view].refresh` 查表，
 * 新增视图只要在自己的文件里暴露 `refresh()` 就自动接上，不需要改这张表。
 *
 * 在途态：点击后图标转圈（`.appbar__refresh-icon--spinning`），完成后 800ms 复位。
 * 为什么不是「完成即复位」：本地回环的一拍常常 20ms 就结束，按钮闪一下等于没有
 * 反馈；留 800ms 让「我点到了、它做了」这件事读得出来。转圈期间 `aria-busy`
 * 让读屏器也知道在途。
 *
 * 键盘：`R` 与点击同一条路（输入框 / 文本域 / 下拉 / contenteditable 内不触发，
 * 那里 `r` 是字面字符）。带修饰键的一律不接——那是浏览器或系统的快捷键。
 */
(function (App) {
  "use strict";

  var state = App.state;
  var byRole = App.dom.byRole;
  var t = App.i18n.t;

  /** 完成后图标再转多久（ms）。 */
  var SETTLE_MS = 800;

  /** 一次刷新是否在途（连点只跑一次）。 */
  var busy = false;
  /** 复位计时器（`null` = 没有待复位）。 */
  var settleTimer = null;

  /**
   * 当前视图的刷新出口（没有就返回 `null`）。
   *
   * 视图模块的键与 `state.activeView` 同名（`App.views.overview` 对 `VIEW_OVERVIEW`），
   * 所以查表不需要第二张映射。
   */
  function targetOf(view) {
    var module = App.views[view];
    if (!module || typeof module.refresh !== "function") return null;
    return module;
  }

  /** 当前视图能不能刷新（日志页看 tab，其余看有没有 `refresh()`）。*/
  function canRefresh(view) {
    var module = targetOf(view);
    if (!module) return false;
    if (typeof module.canRefresh === "function") return module.canRefresh() === true;
    return true;
  }

  function button() {
    return byRole("refresh-button");
  }

  /** 图标的在途态（转圈 + `aria-busy`）。*/
  function setSpinning(on) {
    var node = button();
    if (!node) return;
    if (on) node.setAttribute("aria-busy", "true");
    else node.removeAttribute("aria-busy");
    var use = node.querySelector('[data-role="refresh-icon"]');
    var icon = use && use.parentNode ? use.parentNode : null;
    if (!icon) return;
    var base = "appbar__refresh-icon";
    /* 必须走 `setAttribute`：SVG 元素的 `className` 是一个只读的
       `SVGAnimatedString`，赋值在严格模式下直接抛 TypeError（HTML 元素才是字符串），
       真浏览器里就是这么表现出来的——转圈不会画、点击后继逻辑也不会跑。 */
    icon.setAttribute("class", on ? base + " " + base + "--spinning" : base);
  }

  /**
   * 同步按钮的可用态与提示（视图切换 / 日志 tab 切换 / 语言切换都调它）。
   *
   * 置灰不是「坏了」：聊天与日志的系统 tab 上，这一页的数据要么是本地会话
   * （刷新没有意义），要么是 SSE 实时推送（服务端已经在推了）。所以 title 说
   * 「当前页面无需刷新」而不是「不可用」。
   */
  function sync() {
    var node = button();
    if (!node) return;
    var enabled = canRefresh(state.activeView);
    node.disabled = !enabled;
    var text = t(enabled ? "refresh.title" : "refresh.disabled");
    node.setAttribute("title", text);
    node.setAttribute("aria-label", text);
  }

  /** 派发一次刷新：转圈到完成后再留 800ms。 */
  function run() {
    var view = state.activeView;
    var module = targetOf(view);
    if (busy || !module || !canRefresh(view)) return null;
    busy = true;
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer);
      settleTimer = null;
    }
    setSpinning(true);
    var result;
    try {
      result = module.refresh();
    } catch {
      /* 视图的取数抛错不该让按钮永远转下去：当成这一拍失败，照常复位 */
      result = null;
    }
    return Promise.resolve(result)
      .catch(function () {
        return null;
      })
      .then(function () {
        busy = false;
        settleTimer = window.setTimeout(function () {
          settleTimer = null;
          setSpinning(false);
        }, SETTLE_MS);
        return null;
      });
  }

  /* ---- 键盘 ------------------------------------------------------------ */

  /** 焦点在可输入控件里时 `r` 是字面字符，不当快捷键。*/
  function isTypingTarget(target) {
    if (!target) return false;
    var tag = typeof target.tagName === "string" ? target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    return target.isContentEditable === true;
  }

  /**
   * `R` = 刷新当前视图（可选快捷键）。
   *
   * 只接裸 `r` / `R`：带 Ctrl / Cmd / Alt 的组合留给浏览器（Ctrl+R 是整页重载，
   * 它与这里的语义不同，不能抢）。焦点在输入框里也不接——那里 `r` 就是字母。
   */
  function onKeydown(event) {
    if (event.key !== "r" && event.key !== "R") return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    if (!canRefresh(state.activeView)) return;
    event.preventDefault();
    run();
  }

  /**
   * 绑定：按钮点击 + 键盘。
   *
   * 页面有几颗刷新按钮就绑几颗（按 data-role 找，与主题按钮同一纪律）；正常只有
   * 顶栏那一颗。
   */
  function bind() {
    var buttons = document.querySelectorAll('[data-role="refresh-button"]');
    for (var i = 0; i < buttons.length; i++) {
      (function (node) {
        node.addEventListener("click", function () {
          run();
        });
      })(buttons[i]);
    }
    document.addEventListener("keydown", onKeydown);
  }

  App.refresh = {
    bind: bind,
    sync: sync,
    run: run,
  };
})(window.__zcodeApp = window.__zcodeApp || {});
