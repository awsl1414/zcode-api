/*
 * app-widgets.js — 公共组件层的行为辅助。
 *
 * 组件类在 components.css，这里只放**行为**：目前只有 CollapsibleSection 的
 * 开合与状态持久。视图自己拼折叠区的 HTML（结构见 components.css 的
 * `.collapse` 注释），摘要文案也由各视图自己填——本模块只负责三件事：
 *
 *   1. 开合：点击标题行切换 body 的 `hidden` 与 `aria-expanded`；
 *   2. 持久：展开状态记在**模块级 Map**（key = `data-collapse` 的 id），并同步
 *      到 sessionStorage 兜底——刷新页面、跨标签页会话都能回到上一次的状态；
 *   3. 跨重渲染：`/api/state` 每 5 秒轮询，账号 / 日志这类视图会整表重画 DOM。
 *      状态不能落在 DOM 属性上（重渲染就丢），而是落在 Map 里；视图重建 DOM
 *      后调一次 `App.widgets.apply()`，把 Map 投影回新节点。
 *
 * 点击绑定用 document 级事件委托：视图随时增删折叠区都不需要重新绑，重渲染
 * 天然安全。默认状态：没有记录时展开（`data-collapse-default="closed"` 的区块
 * 反之），所以首次渲染不依赖本模块的调用顺序。
 *
 * 账号详情用的是 Dialog（居中大窗）：与
 * 折叠区同一条纪律——开合状态的真值在模块级 Map，DOM 只是投影，`apply()` 把 Map
 * 投影回节点；关闭语义（关闭键、遮罩、Esc）与焦点管理（开时记住来源焦点、关时
 * 还回去）也收在这里，视图只调 `open()` / `close()`。状态不落 DOM：窗体重画每拍
 * 轮询都会换一条路径（视图重画体，壳不动），但开合属性不能靠节点自持。
 *
 * 这一层是**全仓模态的唯一实现**：账号详情、出口代理抽屉、添加账号、创建 key、
 * 删除账号、二次确认与设置页的活动选择器都登记成 `data-dialog`。被它管住的三件
 * 事缺一不可——背景 `inert` 且 Tab 在窗内首尾钳制、Esc / 遮罩 / 关闭键走同一条
 * 取消路径、关闭后焦点回到来源（来源没了就落到这一层给的替代落点）。各自翻
 * `hidden` 的浮层迟早会缺其中之一，所以这里不再提供第二种开合方式。
 *
 * 投影用 `hidden` 属性而不是自造的 data 属性：页面已经用
 * `hidden` 表达所有浮层的可见性（`.modal[hidden]`、滚动锁的 `:has(.modal:not([hidden]))`），
 * 两套开合标记只会多一处要同步的地方。
 *
 * Toast（撤销条）：删除会话是「先删 + 5 秒可撤销」，反悔入口
 * 需要一个与滚动位置无关的浮条。它是最轻的一类浮层——不遮罩、不锁滚动、
 * 不抢焦点——所以也收在这里（模块持有唯一真值，DOM 是投影），与折叠区、
 * 大窗共用同一条纪律。
 */
(function (App) {
  "use strict";

  /** sessionStorage 里的键；值是 `{ [id]: boolean }`，true = 折叠。*/
  var STORAGE_KEY = "zcode-collapse";

  /** 展开状态的唯一真值（key = data-collapse 的 id）。DOM 是它的投影。*/
  var collapsed = new Map();

  /* 启动时从 sessionStorage 恢复一次（本次会话内 Map 自己就是真值）。*/
  (function restore() {
    var raw;
    try {
      raw = window.sessionStorage.getItem(STORAGE_KEY);
    } catch {
      return; /* 隐私模式读不到就算了：Map 仍然是本次会话的真值 */
    }
    if (!raw) return;
    try {
      var data = JSON.parse(raw);
      for (var key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) collapsed.set(key, data[key] === true);
      }
    } catch {
      /* 保存的值坏了就当没有：全部回到默认展开 */
    }
  })();

  function persist() {
    try {
      var data = {};
      collapsed.forEach(function (value, key) {
        data[key] = value;
      });
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* 隐私模式存不进去：本次会话仍有 Map 兜底 */
    }
  }

  /** 无记录时的默认状态：`data-collapse-default="closed"` 反向，其余展开。*/
  function defaultCollapsed(root) {
    return (root.getAttribute("data-collapse-default") || "open") === "closed";
  }

  /**
   * 一段折叠区的当前状态：模块级 Map 有记录就用记录，没有落到默认值。
   *
   * 默认值只在「从未交互」时参与：第一次点击会先落 Map（见 `handleToggle`），
   * 之后永远以 Map 为准。
   */
  function stateOf(root) {
    var id = root.getAttribute("data-collapse");
    if (collapsed.has(id)) return collapsed.get(id) === true;
    return defaultCollapsed(root);
  }

  /**
   * 一段折叠区现在是否折叠：先查 DOM 根（无记录时落在默认值），查不到再查 Map。
   *
   * 语义是「用户现在看到的开合」，不是「Map 里存了什么」——从未交互过的
   * `data-collapse-default="closed"` 区块，答案也是折叠。
   */
  function isCollapsed(id) {
    var root = document.querySelector('[data-collapse="' + id + '"]');
    if (root) return stateOf(root);
    return collapsed.get(id) === true;
  }

  /** 把一条 id 的状态投影回 DOM（body 的 hidden / 头部的 aria-expanded）。*/
  function applySection(id) {
    var root = document.querySelector('[data-collapse="' + id + '"]');
    if (!root) return;
    var body = root.querySelector(".collapse__body");
    var head = root.querySelector(".collapse__head");
    var value = stateOf(root);
    if (body) {
      if (value) body.setAttribute("hidden", "");
      else body.removeAttribute("hidden");
    }
    if (head) head.setAttribute("aria-expanded", value ? "false" : "true");
    root.setAttribute("data-collapse-open", value ? "false" : "true");
  }

  function setCollapsed(id, value) {
    collapsed.set(id, value === true);
    persist();
    applySection(id);
  }

  function toggle(id) {
    setCollapsed(id, !isCollapsed(id));
  }

  /**
   * 把当前状态投影到一段（或整个文档的）折叠区上。
   *
   * 视图重渲染后调它；没有记录的 id 落到默认状态（`data-collapse-default`）。
   */
  function apply(root) {
    var scope = root || document;
    var roots = scope.querySelectorAll("[data-collapse]");
    for (var i = 0; i < roots.length; i++) applySection(roots[i].getAttribute("data-collapse"));
  }

  /**
   * 事件委托的入口（`document` 上的 click 落到 `[data-collapse-toggle]` 时走这里）。
   */
  function handleToggle(target) {
    if (!target || typeof target.closest !== "function") return;
    var root = target.closest("[data-collapse]");
    if (!root) return;
    var id = root.getAttribute("data-collapse");
    if (!id) return;
    if (!collapsed.has(id)) collapsed.set(id, defaultCollapsed(root));
    toggle(id);
  }

  document.addEventListener("click", function (event) {
    var node = event.target && typeof event.target.closest === "function" ? event.target.closest("[data-collapse-toggle]") : null;
    if (node) handleToggle(node);
  });

  /* ---- Dialog：浮层（账号详情、代理抽屉与全部模态） ------------------------- */

  /**
   * 开合状态的唯一真值（key = data-dialog 的 id）。DOM 的 `hidden` 是它的投影。
   *
   * 与折叠区不同，大窗不需要 sessionStorage 兜底：它是会话内的一次性形态
   * （「正在看这个账号的详情」），刷新页面后回到关着才是对的。
   */
  var dialogs = new Map();

  /** 关闭时把焦点还给的那个元素（key = id；缺省表示没有要还的）。*/
  var dialogReturnFocus = new Map();

  /**
   * 被「取消」时要跑的回调（key = id）。Esc、遮罩与关闭键都算取消。
   *
   * 二次确认框靠它把没落盘的值回滚回去；添加账号靠它停掉登录轮询。只关框不跑
   * 回调会让界面停在一个服务端并不认可的状态上。
   */
  var dialogDismiss = new Map();

  /**
   * 来源焦点已经消失时的替代落点（key = id，返回一个元素或 `null`）。
   *
   * 典型的两种情况：行尾菜单收起后那个菜单项不在 tab 序里了；账号表每拍轮询
   * 整表重画，打开的详情窗关掉时原来那一行已经换成新节点。回退到 `<body>`
   * 等于把键盘用户丢回文档开头，所以宁可多问一次「这一层该回哪」。
   */
  var dialogReturnFallback = new Map();

  /** 打开时先试的那个元素（key = id，返回元素或 `null`）。*/
  var dialogInitialFocus = new Map();

  /**
   * 因为浮层打开而被标上 `inert` 的节点。
   *
   * 每次开合都先整批摘掉再重算：浮层会叠（抽屉里再开一个弹窗），「哪一块还活着」
   * 只由当前开着的那些浮层与它们的遮罩决定，不靠调用方自己加减计数。
   */
  var inerted = [];

  function dialogRoot(id) {
    return document.querySelector('[data-dialog="' + id + '"]');
  }

  function dialogScrim(id) {
    return document.querySelector('[data-dialog-scrim="' + id + '"]');
  }

  /** 把一条 id 的开合状态投影回 DOM（壳与遮罩的 `hidden`）。*/
  function applyDialog(id) {
    var root = dialogRoot(id);
    var open = dialogs.get(id) === true;
    if (root) {
      if (open) root.removeAttribute("hidden");
      else root.setAttribute("hidden", "");
    }
    var scrim = dialogScrim(id);
    if (scrim) {
      if (open) scrim.removeAttribute("hidden");
      else scrim.setAttribute("hidden", "");
    }
  }

  /** 现在开着的、有壳的浮层（按打开先后）。*/
  function openDialogIds() {
    var ids = [];
    dialogs.forEach(function (open, id) {
      if (open) ids.push(id);
    });
    return ids;
  }

  /* ---- 焦点陷阱：背景 inert + 窗内 Tab 首尾钳制 --------------------------- */

  /**
   * 能进 tab 序的元素。选择器只列原生可聚焦的那些；`[tabindex]` 里负值要排除，
   * 否则行尾菜单（`position: fixed` 但 `tabindex="-1"`）会被算进陷阱里。
   */
  var FOCUSABLE_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "[tabindex]",
  ].join(", ");

  /** 一个元素现在能不能被 Tab 到（可见、没禁用、没被 `inert` 挡住）。*/
  function isTabbable(node) {
    if (!node || node.disabled === true) return false;
    if (typeof node.getAttribute === "function") {
      var index = node.getAttribute("tabindex");
      if (index !== null && Number(index) < 0) return false;
      if (node.getAttribute("type") === "hidden") return false;
      if (node.getAttribute("aria-hidden") === "true") return false;
    }
    /* `hidden` 与祖先上的 `inert` 都不该进 tab 序：`offsetParent` 在 happy-dom 里
       恒为 null，所以这两条用属性判断，不靠布局。 */
    if (typeof node.closest === "function" && node.closest("[hidden], [inert]")) return false;
    return true;
  }

  /** 一个浮层壳里可 Tab 的元素（文档序）。*/
  function tabbablesIn(root) {
    if (!root) return [];
    var all = root.querySelectorAll(FOCUSABLE_SELECTOR);
    var out = [];
    for (var i = 0; i < all.length; i++) if (isTabbable(all[i])) out.push(all[i]);
    return out;
  }

  /**
   * 把焦点送进刚打开的浮层。
   *
   * 优先用调用方点名的元素（添加账号的名称框、代理表单的名称框），否则用关闭键
   * ——它是每个模态都有的那一颗，也是「怎么出去」的答案；再否则取壳里第一个可
   * Tab 的元素，最后才退回壳本身（壳带 `tabindex="-1"`，见 `ensureFocusable`）。
   */
  function focusInto(id) {
    var root = dialogRoot(id);
    if (!root) return;
    var preferred = typeof dialogInitialFocus.get(id) === "function" ? dialogInitialFocus.get(id)() : null;
    /* 点名的那颗也要过一遍可用性：它可能落在当前 tab 的隐藏面板里（添加账号
       的「账号名」只在两个导入 tab 上可见），聚焦一个 `hidden` 的元素没有任何
       效果，焦点会留在外面。 */
    var target = preferred && root.contains(preferred) && isTabbable(preferred) ? preferred : null;
    if (!target) {
      var closeButton = root.querySelector(".modal__close");
      if (isTabbable(closeButton)) target = closeButton;
    }
    if (!target) {
      var list = tabbablesIn(root);
      target = list.length > 0 ? list[0] : null;
    }
    if (!target) target = ensureFocusable(root);
    if (target && typeof target.focus === "function") target.focus();
  }

  /**
   * 让壳自己成为 Tab 的出口。
   *
   * 一个既没有关闭键、也没有可聚焦控件的浮层（理论上不会出现）如果连壳都不可
   * 聚焦，焦点就只能留在背景上——那正是要修的问题。`tabindex="-1"` 只加在壳上，
   * 不改变 Tab 顺序。
   */
  function ensureFocusable(root) {
    if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
    return root;
  }

  /**
   * 把浮层之外的页面主体标成 `inert`。
   *
   * 做法是沿每个浮层节点往上走到 `<body>`，把这条路径上的兄弟节点全部冻结：
   * 模态直接挂在 `<body>` 下时冻结的就是整块 `.app`（顶栏 / 侧栏 / 视图 / 底部
   * tab 一起退出 tab 序与读屏树）；浮层挂得更深时（窄屏的「更多」面板住在 `.app`
   * 里）也只冻它同一层的兄弟，不冻装它的祖先。
   *
   * 开着的每一层都参与计算，所以叠层时下层的壳不会被上层的路径顺手冻掉。
   * 脚本与样式节点没有可聚焦的东西，跳过不碰。
   */
  function applyInert() {
    for (var i = 0; i < inerted.length; i++) inerted[i].removeAttribute("inert");
    inerted = [];
    var open = openDialogIds();
    if (open.length === 0) return;

    var layers = [];
    for (var j = 0; j < open.length; j++) {
      var root = dialogRoot(open[j]);
      if (root) layers.push(root);
      var scrim = dialogScrim(open[j]);
      if (scrim) layers.push(scrim);
    }
    if (layers.length === 0) return;

    /* 路径上的节点（从浮层到 <body> 之间）都保持可用。 */
    var onPath = new Set();
    for (var k = 0; k < layers.length; k++) {
      var node = layers[k];
      while (node && node !== document.body && node !== document.documentElement) {
        onPath.add(node);
        node = node.parentElement;
      }
    }

    /* 只冻结路径的兄弟，不下探到浮层自己里面：浮层的后代是它要交互的东西。 */
    onPath.forEach(function (branch) {
      var parent = branch.parentElement;
      if (!parent) return;
      var children = parent.children;
      for (var m = 0; m < children.length; m++) {
        var child = children[m];
        if (onPath.has(child)) continue;
        var tag = child.tagName;
        if (tag === "SCRIPT" || tag === "STYLE") continue;
        child.setAttribute("inert", "");
        inerted.push(child);
      }
    });
  }

  /**
   * Tab 在打开着的浮层里首尾钳制。
   *
   * 用 `keydown` 的 Tab 而不是 `focusin` 兜底：背景已经 `inert`，Tab 走不到外面；
   * 这里补的是「停在最后一个可聚焦元素上时按 Tab 要绕回第一个」这一圈，读屏与
   * 键盘用户才不会以为窗里只有这一截。
   *
   * 只接最上面那一层：叠层时焦点属于上层，下层不该抢。
   */
  window.addEventListener(
    "keydown",
    function (event) {
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
      var open = openDialogIds();
      if (open.length === 0) return;
      var root = dialogRoot(open[open.length - 1]);
      if (!root) return;
      var list = tabbablesIn(root);
      if (list.length === 0) {
        /* 窗里没有可聚焦的东西：焦点不许留在外面，停在壳上。 */
        event.preventDefault();
        ensureFocusable(root).focus();
        return;
      }
      var active = document.activeElement;
      if (!root.contains(active)) {
        /* 焦点不在窗里（刚打开、或壳里还没有可聚焦的东西）：第一下 Tab 把它送进来。 */
        event.preventDefault();
        (event.shiftKey ? list[list.length - 1] : list[0]).focus();
        return;
      }
      if (!event.shiftKey && active === list[list.length - 1]) {
        event.preventDefault();
        list[0].focus();
      } else if (event.shiftKey && active === list[0]) {
        event.preventDefault();
        list[list.length - 1].focus();
      }
    },
    true,
  );

  /**
   * 打开浮层：记下来源焦点（通常是触发打开的那一行 / 那个单元格），把焦点送进
   * 壳里，并冻结背景。
   *
   * 重复 open 是幂等的：只投影，不重记来源焦点（否则来源会被窗内的元素覆盖）。
   *
   * `options`（都可选）：
   *   `onDismiss`  Esc / 遮罩 / 关闭键关掉时跑（二次确认的取消回滚就在这里）；
   *   `fallback`   来源焦点已消失时的替代落点（返回元素或 `null`）；
   *   `initial`    打开时先试这个元素，拿不到再按首个可聚焦元素处理。
   */
  function openDialog(id, options) {
    if (!dialogRoot(id)) return;
    var opts = options || {};
    if (dialogs.get(id) !== true) {
      dialogs.set(id, true);
      dialogReturnFocus.set(id, document.activeElement);
    }
    if (typeof opts.onDismiss === "function") dialogDismiss.set(id, opts.onDismiss);
    else dialogDismiss.delete(id);
    if (typeof opts.fallback === "function") dialogReturnFallback.set(id, opts.fallback);
    else dialogReturnFallback.delete(id);
    if (typeof opts.initial === "function") dialogInitialFocus.set(id, opts.initial);
    else dialogInitialFocus.delete(id);

    applyDialog(id);
    applyInert();
    focusInto(id);
  }

  function isDialogOpen(id) {
    return dialogs.get(id) === true;
  }

  /**
   * 关掉一层浮层。`reason` 是 `"dismiss"` 时走取消路径（跑 `onDismiss`）。
   *
   * 焦点归还的对象优先级：来源元素（仍在文档里、仍可聚焦）→ `fallback()` 给的
   * 替代落点 → 什么都不做。**不回退到 `<body>`**：那等于把键盘用户丢回文档开头。
   */
  function closeDialogWith(id, reason) {
    var wasOpen = dialogs.get(id) === true;
    var callback = dialogDismiss.get(id) || null;
    dialogs.set(id, false);
    dialogDismiss.delete(id);
    applyDialog(id);
    applyInert();

    var back = dialogReturnFocus.get(id);
    var fallback = dialogReturnFallback.get(id);
    dialogReturnFocus.delete(id);
    dialogReturnFallback.delete(id);
    dialogInitialFocus.delete(id);

    var target = usableReturnTarget(back) ? back : null;
    if (!target && typeof fallback === "function") {
      var alternative = fallback();
      if (usableReturnTarget(alternative)) target = alternative;
    }
    if (reason === "dismiss" && wasOpen && callback) callback();
    if (target && typeof target.focus === "function") target.focus();
  }

  /**
   * 还焦点之前确认那个节点还在文档里、还能接焦点。
   *
   * 收起 / 藏起来的来源不算数：行尾菜单的菜单项在确认框打开的那一刻就被
   * `closeMenus` 收走了（它还在 DOM 里，但整个菜单 `hidden`），焦点交给它等于
   * 丢进一个看不见的子树。被关掉的浮层自己里面的元素同理（浮层里再开一层时），
   * `hidden` 也一并挡掉。
   */
  function usableReturnTarget(node) {
    if (!node || typeof node.focus !== "function") return false;
    if (node === document.body || node === document.documentElement) return false;
    if (node.isConnected === false) return false;
    if (typeof node.closest === "function" && node.closest("[inert], [hidden]")) return false;
    return true;
  }

  /** 关闭浮层（程序化关闭：提交成功、账号被删、上一层自己收口）。*/
  function closeDialog(id) {
    closeDialogWith(id, "close");
  }

  /** 取消：关掉浮层并跑它的 `onDismiss`。*/
  function dismissDialog(id) {
    closeDialogWith(id, "dismiss");
  }

  /**
   * 关闭最近打开的、仍开着的那一个（Esc 的语义）。
   *
   * 为什么不是「全关」：浮层可以叠（出口代理抽屉里点「添加代理」会再开一个弹窗），
   * Esc 是一层一层往回退——先关最上面那个，再按一次才轮到下面那个。按 Map 的插入
   * 顺序取最后一个仍开着的，就是「最上面」：叠层的先后与打开的先后一致。
   */
  function closeTopDialog() {
    var open = openDialogIds();
    if (open.length > 0) dismissDialog(open[open.length - 1]);
  }

  /**
   * 关闭语义的事件委托（document 级，一次绑定）：
   *   - 点击 `[data-dialog-close]`：属性有值就关那个 id，没有就关最近的壳；
   *   - 按 Esc：关掉最上面那一层（叠了多个浮层时一次退一层，见 `closeTopDialog`）。
   *
   * 两者都是「取消」：二次确认框的 Esc 与「取消」键走同一条回滚路径。
   */
  function handleDialogDismiss(target) {
    if (!target || typeof target.closest !== "function") return false;
    var node = target.closest("[data-dialog-close]");
    if (!node) return false;
    var id = node.getAttribute("data-dialog-close");
    if (!id) {
      var root = node.closest("[data-dialog]");
      id = root ? root.getAttribute("data-dialog") : null;
    }
    if (id) dismissDialog(id);
    return true;
  }

  document.addEventListener("click", function (event) {
    if (event.target && typeof event.target.closest === "function") handleDialogDismiss(event.target);
  });

  /*
   * Esc 只在 window 的捕获阶段接：一次只退一层，所以要赶在别的 Esc 处理器之前
   * 决定「这一下算谁的」。
   *
   * 浮层的 Esc 处理器有两家（本文件的 dialog、`app-accounts-table.js` 的行尾菜单），
   * Esc 的取消路径也挂在 document 上。捕获阶段先跑，如果这一下有浮层要关，就
   * `stopPropagation` 把冒泡阶段整个掐掉——不会再顺带关掉底下的菜单，也不会一次
   * 关掉两层。没有浮层可关时什么也不做，事件照常往下走（行尾菜单因此收得到 Esc）。
   */
  window.addEventListener(
    "keydown",
    function (event) {
      if (event.key !== "Escape") return;
      if (openDialogIds().length === 0) return;
      event.stopPropagation();
      closeTopDialog();
    },
    true,
  );

  /**
   * 让焦点在重画之后回到同一个控件上（`syncDialog` 那类「每拍整段重建」的地方）。
   *
   * 身份不是节点（重画就换掉了），而是「第几个可 Tab 的元素」：详情窗的段序列
   * 每拍按同一份数据拼，顺序稳定，所以第 n 个就是用户刚才站的那个位置；叠上
   * 段内的文字（按钮文案 / 可访问名）再比一次，段落增减时不会把焦点甩到别的动作上。
   */
  function focusSignature(node, list) {
    if (!node || typeof node.getAttribute !== "function") return null;
    var role = node.getAttribute("data-role") || "";
    var name = node.getAttribute("aria-label") || "";
    var text = (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
    return [list.indexOf(node), node.tagName, role, name, text].join("\u0001");
  }

  /** 记下当前焦点身份（不在 `root` 里就回 `null`）。*/
  function captureFocus(root) {
    if (!root) return null;
    var active = document.activeElement;
    if (!active || active === document.body || !root.contains(active)) return null;
    return focusSignature(active, tabbablesIn(root));
  }

  /** 重画之后按身份把焦点放回去（记不到、或对不上就什么也不做）。*/
  function restoreFocus(root, signature) {
    if (!root || !signature) return;
    var active = document.activeElement;
    /* 重画期间焦点已经被别的东西接走（关窗、用户点了别处）：不抢回来。 */
    if (active && active !== document.body && !root.contains(active)) return;
    var list = tabbablesIn(root);
    for (var i = 0; i < list.length; i++) {
      if (focusSignature(list[i], list) === signature) {
        list[i].focus();
        return;
      }
    }
  }

  /* ---- 撤销条（Toast） ------------------------------------------------- */

  /**
   * 一条短文案 + 一个可选动作的底部浮条，到点自己收起。
   *
   * 真值仍然只有一份（模块级 `toastState`），DOM 是它的投影：同一时刻只有一条，
   * 后开的先顶掉前一条。与折叠区 / 大窗同一条纪律：视图只调 `show()` / `hide()`，
   * 不自己写 overlay、不自己拿定时器。
   *
   * 超时只收起条子，**不**代跑动作——动作是用户的选择，超时就是「算了」。
   * 但超时要告诉调用方一声（`onExpire`）：聊天页靠它把撤销窗口内暂缓的图片
   * 清理补上。若条子被下一条顶掉，`onExpire` 不跑——调用方自己先收口。
   *
   * 参数：`{ text, actionLabel, action, durationMs, onExpire }`。
   */
  var toastState = null;

  function toastNode() {
    return document.querySelector('[data-role="toast"]');
  }

  function hideToast() {
    if (toastState && toastState.timer !== null) window.clearTimeout(toastState.timer);
    toastState = null;
    var node = toastNode();
    if (!node) return;
    node.hidden = true;
  }

  function applyToast() {
    var node = toastNode();
    if (!node) return;
    if (!toastState) {
      node.hidden = true;
      return;
    }
    var text = node.querySelector('[data-role="toast-text"]');
    var action = node.querySelector('[data-role="toast-action"]');
    if (text) text.textContent = toastState.text;
    if (action) {
      if (toastState.actionLabel) {
        action.textContent = toastState.actionLabel;
        action.hidden = false;
      } else {
        action.hidden = true;
      }
    }
    node.hidden = false;
  }

  function showToast(options) {
    var opts = options || {};
    hideToast();
    toastState = {
      text: typeof opts.text === "string" ? opts.text : "",
      actionLabel: typeof opts.actionLabel === "string" ? opts.actionLabel : "",
      /* 动作只能点一次：跑完就收条（同一次点击不再触发第二次）。 */
      action: typeof opts.action === "function" ? opts.action : null,
      onExpire: typeof opts.onExpire === "function" ? opts.onExpire : null,
      timer: null,
    };
    var duration = typeof opts.durationMs === "number" && opts.durationMs > 0 ? opts.durationMs : 0;
    if (duration > 0) {
      toastState.timer = window.setTimeout(function () {
        var expire = toastState ? toastState.onExpire : null;
        hideToast();
        if (expire) expire();
      }, duration);
    }
    applyToast();
  }

  /** 点撤销条里的动作键（事件委托绑一次，条子重画不需要重绑）。 */
  function handleToastAction(target) {
    if (!target || typeof target.closest !== "function") return false;
    if (!target.closest('[data-role="toast-action"]')) return false;
    var action = toastState ? toastState.action : null;
    hideToast();
    if (action) action();
    return true;
  }

  document.addEventListener("click", function (event) {
    handleToastAction(event.target);
  });

  App.widgets = {
    isCollapsed: isCollapsed,
    setCollapsed: setCollapsed,
    toggle: toggle,
    apply: apply,
    dialog: {
      open: openDialog,
      close: closeDialog,
      dismiss: dismissDialog,
      isOpen: isDialogOpen,
      apply: function () {
        var ids = Array.from(dialogs.keys());
        for (var i = 0; i < ids.length; i++) applyDialog(ids[i]);
        applyInert();
      },
      handleDismiss: handleDialogDismiss,
      /* 重画整段内容的地方（详情窗每拍重建体）用它把焦点留在同一个控件上。*/
      captureFocus: captureFocus,
      restoreFocus: restoreFocus,
      /* Tab 序里的元素（测试与视图判断「窗里还有没有可聚焦的东西」用）。*/
      tabbables: tabbablesIn,
    },
    toast: {
      show: showToast,
      hide: hideToast,
      apply: applyToast,
    },
  };
})(window.__zcodeApp = window.__zcodeApp || {});
