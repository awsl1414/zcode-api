/**
 * app-widgets 的行为测试：CollapsibleSection 的开合与状态持久。
 *
 * 组件类在 components.css，行为在 app-widgets.js。这里的验收点是任务钉死的硬项：
 * **折叠状态必须跨重渲染保持**——面板每 5 秒轮询 `/api/state`，账号 / 日志这类
 * 视图会整表重画 DOM，状态若落在 DOM 属性上就丢了。本组用例模拟这条链路：
 * 点击 → 折叠 → 换一份新 DOM → `apply()` → 仍是折叠。
 *
 * DOM 全部用 createElement 拼（textContent 填文字，不走 innerHTML）；happy-dom 的
 * Element 与 TS DOM lib 的类型不兼容（同 `runtime-harness.ts` 的理由），在断言边界只转
 * 这一次。
 */
import { describe, expect, it } from "bun:test";
import { GlobalWindow } from "happy-dom";
import widgetsSource from "./app-widgets.js" with { type: "text" };

const ORIGIN = "http://127.0.0.1:8791";

/** 断言真正用到的成员（与 `runtime-harness.ts` 的 PageNode 同一思路）。*/
interface Node {
  click(): void;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

interface Mounted {
  win: GlobalWindow;
  widgets: {
    isCollapsed(id: string): boolean;
    setCollapsed(id: string, value: boolean): void;
    toggle(id: string): void;
    apply(root?: unknown): void;
    handleToggle(target: unknown): void;
  };
}

const node = (value: unknown): Node => value as Node;
const maybe = (value: unknown): Node | null => (value ? node(value) : null);

/**
 * 拼一个折叠区（与 components.css 注释里的结构契约一致），挂到 body 上。
 *
 * `rebuild` 时的语义与轮询重渲染相同：整段丢掉，换一份状态属性全默认的新节点。
 */
function buildSection(win: GlobalWindow, options: { defaultClosed?: boolean; rebuild?: boolean } = {}): void {
  if (options.rebuild) win.document.querySelector('[data-collapse="queue"]')?.remove();
  const doc = win.document;
  const root = doc.createElement("section");
  root.className = "collapse";
  root.setAttribute("data-collapse", "queue");
  if (options.defaultClosed) root.setAttribute("data-collapse-default", "closed");
  else root.setAttribute("data-collapse-open", "true");

  const head = doc.createElement("button");
  head.type = "button";
  head.className = "collapse__head";
  head.setAttribute("data-collapse-toggle", "");
  head.setAttribute("aria-expanded", "true");
  head.setAttribute("aria-controls", "queue-body");
  const title = doc.createElement("span");
  title.className = "collapse__title";
  title.textContent = "队列";
  const summary = doc.createElement("span");
  summary.className = "collapse__summary";
  summary.textContent = "队列深度 64";
  head.appendChild(title);
  head.appendChild(summary);

  const body = doc.createElement("div");
  body.className = "collapse__body";
  body.id = "queue-body";
  const text = doc.createElement("p");
  text.textContent = "内容";
  body.appendChild(text);

  root.appendChild(head);
  root.appendChild(body);
  doc.body.appendChild(root);
}

/** 起一个窗口、灌入折叠区、在 window 作用域里执行一次模块原文。*/
function mount(options: { defaultClosed?: boolean; seedStorage?: string } = {}): Mounted {
  const win = new GlobalWindow({ url: ORIGIN });
  if (options.seedStorage !== undefined) win.sessionStorage.setItem("zcode-collapse", options.seedStorage);
  buildSection(win, { defaultClosed: options.defaultClosed });
  new Function("window", "document", widgetsSource)(win, win.document);
  const widgets = (win as unknown as { __zcodeApp: { widgets: Mounted["widgets"] } }).__zcodeApp.widgets;
  return { win, widgets };
}

const bodyOf = (win: GlobalWindow) => maybe(win.document.querySelector('[data-collapse="queue"] .collapse__body'));
const headOf = (win: GlobalWindow) => maybe(win.document.querySelector('[data-collapse="queue"] .collapse__head'));
const rootOf = (win: GlobalWindow) => maybe(win.document.querySelector('[data-collapse="queue"]'));

describe("collapsible section — toggle", () => {
  it("starts open by default and collapses on a click on the head", () => {
    const { win, widgets } = mount();
    // 默认状态：没有记录 → 展开（首屏不依赖任何调用）
    expect(widgets.isCollapsed("queue")).toBe(false);
    expect(bodyOf(win)?.hasAttribute("hidden")).toBe(false);

    headOf(win)?.click();

    expect(widgets.isCollapsed("queue")).toBe(true);
    expect(bodyOf(win)?.hasAttribute("hidden")).toBe(true);
    expect(headOf(win)?.getAttribute("aria-expanded")).toBe("false");
    expect(rootOf(win)?.getAttribute("data-collapse-open")).toBe("false");
  });

  it("toggles back open and keeps aria-expanded in sync", () => {
    const { win, widgets } = mount();
    widgets.setCollapsed("queue", true);
    widgets.toggle("queue");
    expect(widgets.isCollapsed("queue")).toBe(false);
    expect(bodyOf(win)?.hasAttribute("hidden")).toBe(false);
    expect(headOf(win)?.getAttribute("aria-expanded")).toBe("true");
  });

  it("honours data-collapse-default=\"closed\" for ids with no stored state", () => {
    const { win, widgets } = mount({ defaultClosed: true });
    widgets.apply();
    expect(widgets.isCollapsed("queue")).toBe(true);
    expect(bodyOf(win)?.hasAttribute("hidden")).toBe(true);
    // 点一下就回展开：默认值只管「没有记录」的那一次
    headOf(win)?.click();
    expect(widgets.isCollapsed("queue")).toBe(false);
  });
});

describe("collapsible section — persistence (the acceptance hard item)", () => {
  it("keeps the collapsed state across a full DOM re-render + apply()", () => {
    const { win, widgets } = mount();
    headOf(win)?.click();
    expect(widgets.isCollapsed("queue")).toBe(true);

    // 模拟轮询重渲染：整段 DOM 换成一份全新的节点（状态属性全部回默认展开）
    buildSection(win, { rebuild: true });
    expect(bodyOf(win)?.hasAttribute("hidden")).toBe(false); // 新 DOM 回到默认
    widgets.apply();
    expect(bodyOf(win)?.hasAttribute("hidden")).toBe(true); // Map 里的状态投影回来
    expect(headOf(win)?.getAttribute("aria-expanded")).toBe("false");
  });

  it("persists to sessionStorage and restores it on a fresh module instance", () => {
    const first = mount();
    first.widgets.setCollapsed("queue", true);
    const stored = first.win.sessionStorage.getItem("zcode-collapse");
    expect(JSON.parse(stored ?? "{}")).toEqual({ queue: true });

    // 新「页面」：新窗口 + 新模块作用域，sessionStorage 里带着上一次的值
    const second = mount({ seedStorage: stored ?? "{}" });
    second.widgets.apply();
    expect(second.widgets.isCollapsed("queue")).toBe(true);
    expect(bodyOf(second.win)?.hasAttribute("hidden")).toBe(true);
  });

  it("survives a broken sessionStorage payload (falls back to defaults)", () => {
    const { widgets } = mount({ seedStorage: "{not-json" });
    expect(widgets.isCollapsed("queue")).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* Dialog：居中大窗的开合状态、关闭语义与焦点管理                                */
/* ------------------------------------------------------------------------- */

/**
 * 与折叠区同一条纪律：开合真值在模块级 Map，DOM 的 `hidden` 只是投影。用例模拟
 * 轮询链路（点击 → 打开 → 换一份新 DOM → apply() → 仍开）与三条关闭路径（关闭键 /
 * 遮罩 / Esc），以及焦点管理（开时记住来源、关时还回去）。
 *
 * 这一段以前测的是 Drawer（右侧抽屉，投影是 `data-drawer-open`）；账号详情换成
 * 居中大模态后，投影改成 `hidden`（与页面里其它浮层同一个标记），所以断言也改成
 * 「壳与遮罩的 `hidden`」。
 */
interface DialogOpenOptions {
  onDismiss?: () => void;
  fallback?: () => unknown;
  initial?: () => unknown;
}

interface DialogMounted extends Mounted {
  dialog: {
    open(id: string, options?: DialogOpenOptions): void;
    close(id: string): void;
    dismiss(id: string): void;
    isOpen(id: string): boolean;
    apply(): void;
    captureFocus(root: unknown): string | null;
    restoreFocus(root: unknown, signature: string | null): void;
    tabbables(root: unknown): unknown[];
  };
}

/** 拼一个大窗壳（与 components.css 注释里的结构契约一致）。*/
function buildDialog(win: GlobalWindow, options: { rebuild?: boolean } = {}): void {
  if (options.rebuild) {
    win.document.querySelector('[data-dialog="account"]')?.remove();
    win.document.querySelector('[data-dialog-scrim="account"]')?.remove();
  }
  const doc = win.document;
  const scrim = doc.createElement("div");
  scrim.className = "modal-scrim";
  scrim.setAttribute("data-dialog-scrim", "account");
  scrim.setAttribute("data-dialog-close", "account");
  scrim.setAttribute("hidden", "");

  const root = doc.createElement("div");
  root.className = "modal modal--lg";
  root.setAttribute("data-dialog", "account");
  root.setAttribute("hidden", "");
  const close = doc.createElement("button");
  close.type = "button";
  close.className = "modal__close";
  close.setAttribute("data-dialog-close", "account");
  root.appendChild(close);
  const body = doc.createElement("div");
  body.className = "modal__body";
  root.appendChild(body);

  doc.body.appendChild(scrim);
  doc.body.appendChild(root);
}

function mountDialog(options: { seedStorage?: string } = {}): DialogMounted {
  const win = new GlobalWindow({ url: ORIGIN });
  if (options.seedStorage !== undefined) win.sessionStorage.setItem("zcode-collapse", options.seedStorage);
  buildSection(win);
  buildDialog(win);
  new Function("window", "document", widgetsSource)(win, win.document);
  const app = (win as unknown as { __zcodeApp: { widgets: DialogMounted["widgets"] & { dialog: DialogMounted["dialog"] } } }).__zcodeApp.widgets;
  return { win, widgets: app, dialog: app.dialog };
}

const dialogRootOf = (win: GlobalWindow) => maybe(win.document.querySelector('[data-dialog="account"]'));
const dialogScrimOf = (win: GlobalWindow) => maybe(win.document.querySelector('[data-dialog-scrim="account"]'));
const dialogCloseOf = (win: GlobalWindow) => maybe(win.document.querySelector('[data-dialog="account"] .modal__close'));

/** 当前焦点元素（unknown：happy-dom 与 DOM lib 的类型不兼容，断言只比身份）。*/
const activeElementOf = (win: GlobalWindow): unknown => win.document.activeElement;

describe("dialog — open / close projection", () => {
  it("starts closed, opens on open() and projects the state onto the DOM", () => {
    const { win, dialog } = mountDialog();
    expect(dialog.isOpen("account")).toBe(false);
    expect(dialogRootOf(win)?.hasAttribute("hidden")).toBe(true);
    expect(dialogScrimOf(win)?.hasAttribute("hidden")).toBe(true);

    dialog.open("account");
    expect(dialog.isOpen("account")).toBe(true);
    expect(dialogRootOf(win)?.hasAttribute("hidden")).toBe(false);
    expect(dialogScrimOf(win)?.hasAttribute("hidden")).toBe(false);
    // 焦点管理：关闭键拿到焦点，键盘用户一步就能出去。
    expect(activeElementOf(win)).toBe(dialogCloseOf(win));
  });

  it("keeps the open state across a full DOM rebuild + apply()", () => {
    const { win, dialog } = mountDialog();
    dialog.open("account");

    // 模拟轮询重渲染：壳换成新节点（投影回默认关闭），apply() 把 Map 投影回去。
    buildDialog(win, { rebuild: true });
    expect(dialogRootOf(win)?.hasAttribute("hidden")).toBe(true);
    dialog.apply();
    expect(dialogRootOf(win)?.hasAttribute("hidden")).toBe(false);
    expect(dialogScrimOf(win)?.hasAttribute("hidden")).toBe(false);
  });

  it("closes on the close button, restores focus to the opener", () => {
    const { win, dialog } = mountDialog();
    const opener = win.document.querySelector('[data-collapse="queue"] .collapse__head') as unknown as {
      focus(): void;
    };
    opener.focus();
    dialog.open("account");
    expect(activeElementOf(win)).toBe(dialogCloseOf(win));

    dialogCloseOf(win)?.click();
    expect(dialog.isOpen("account")).toBe(false);
    expect(dialogRootOf(win)?.hasAttribute("hidden")).toBe(true);
    expect(activeElementOf(win)).toBe(opener);
  });

  it("closes on the scrim click and on Esc (delegated at document level)", () => {
    const { win, dialog } = mountDialog();
    dialog.open("account");

    dialogScrimOf(win)?.click();
    expect(dialog.isOpen("account")).toBe(false);

    dialog.open("account");
    win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
    expect(dialog.isOpen("account")).toBe(false);
  });

  it("unwinds stacked layers one per Esc, topmost first (#111)", () => {
    /* 浮层可以叠（抽屉里点「添加代理」再开一个弹窗）。Esc 一次只退一层，先关最后
       打开的那个——不是一口气全关，否则底下那层跟着消失，用户回不到抽屉。 */
    const { win, dialog } = mountDialog();
    buildDialog(win);
    const drawer = win.document.createElement("div");
    drawer.className = "modal modal--lg";
    drawer.setAttribute("data-dialog", "proxies");
    drawer.setAttribute("hidden", "");
    win.document.body.appendChild(drawer);

    dialog.open("proxies");
    dialog.open("account");
    win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
    expect(dialog.isOpen("account")).toBe(false);
    expect(dialog.isOpen("proxies")).toBe(true);

    win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
    expect(dialog.isOpen("proxies")).toBe(false);
    expect(drawer.hasAttribute("hidden")).toBe(true);
  });

  it("is idempotent about repeated open() and ignores unknown ids", () => {
    const { win, dialog } = mountDialog();
    const opener = win.document.createElement("button");
    win.document.body.appendChild(opener);
    opener.focus();

    dialog.open("account");
    // 重复 open：不重记来源焦点（否则来源会被窗内的元素覆盖）。
    dialog.open("account");
    dialog.close("account");
    expect(activeElementOf(win)).toBe(opener);

    // 未知 id：静默无操作（不抛错）。
    expect(() => dialog.open("missing")).not.toThrow();
    expect(dialog.isOpen("missing")).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* 撤销条（Toast）：删除会话的「先删 + 5 秒可撤销」                              */
/* ------------------------------------------------------------------------- */

interface ToastMounted extends Mounted {
  toast: {
    show(options: { text: string; actionLabel?: string; action?: () => void; durationMs?: number; onExpire?: () => void }): void;
    hide(): void;
  };
}

/** 拼一个撤销条（与 page.html / components.css 的结构契约一致）。*/
function buildToast(win: GlobalWindow): void {
  const doc = win.document;
  const root = doc.createElement("div");
  root.className = "toast";
  root.setAttribute("data-role", "toast");
  root.setAttribute("hidden", "");
  const text = doc.createElement("span");
  text.setAttribute("data-role", "toast-text");
  root.appendChild(text);
  const action = doc.createElement("button");
  action.type = "button";
  action.className = "btn toast__action";
  action.setAttribute("data-role", "toast-action");
  action.setAttribute("hidden", "");
  root.appendChild(action);
  doc.body.appendChild(root);
}

function mountToast(): ToastMounted {
  const win = new GlobalWindow({ url: ORIGIN });
  buildSection(win);
  buildToast(win);
  new Function("window", "document", widgetsSource)(win, win.document);
  const app = (win as unknown as { __zcodeApp: { widgets: ToastMounted["widgets"] & { toast: ToastMounted["toast"] } } }).__zcodeApp.widgets;
  return { win, widgets: app, toast: app.toast };
}

const toastRootOf = (win: GlobalWindow) => maybe(win.document.querySelector('[data-role="toast"]'));
const toastTextOf = (win: GlobalWindow) => win.document.querySelector('[data-role="toast-text"]')?.textContent ?? null;
const toastActionOf = (win: GlobalWindow) => maybe(win.document.querySelector('[data-role="toast-action"]'));

describe("toast — the undo strip", () => {
  it("starts hidden, shows text plus an action, and hides again", () => {
    const { win, toast } = mountToast();
    expect(toastRootOf(win)?.hasAttribute("hidden")).toBe(true);

    toast.show({ text: "已删除会话「x」", actionLabel: "撤销" });

    expect(toastRootOf(win)?.hasAttribute("hidden")).toBe(false);
    expect(toastTextOf(win)).toBe("已删除会话「x」");
    expect(toastActionOf(win)?.hasAttribute("hidden")).toBe(false);
    expect(win.document.querySelector('[data-role="toast-action"]')?.textContent).toBe("撤销");

    toast.hide();
    expect(toastRootOf(win)?.hasAttribute("hidden")).toBe(true);
  });

  it("runs the action once on click and then hides itself", () => {
    const { win, toast } = mountToast();
    let runs = 0;
    toast.show({ text: "t", actionLabel: "撤销", action: () => (runs += 1) });

    toastActionOf(win)?.click();
    expect(runs).toBe(1);
    expect(toastRootOf(win)?.hasAttribute("hidden")).toBe(true);

    // 第二次点击不再触发（条子已经收起，动作只属于那一次窗口）。
    toastActionOf(win)?.click();
    expect(runs).toBe(1);
  });

  it("expires after the window without running the action, but tells the caller", async () => {
    const { win, toast } = mountToast();
    let runs = 0;
    let expired = 0;
    toast.show({
      text: "t",
      actionLabel: "撤销",
      action: () => (runs += 1),
      durationMs: 20,
      onExpire: () => (expired += 1),
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(toastRootOf(win)?.hasAttribute("hidden")).toBe(true);
    expect(runs).toBe(0);
    expect(expired).toBe(1);
  });

  it("replaces the previous strip without firing its onExpire", () => {
    const { win, toast } = mountToast();
    let firstExpired = 0;
    toast.show({ text: "first", actionLabel: "撤销", durationMs: 5000, onExpire: () => (firstExpired += 1) });
    toast.show({ text: "second", durationMs: 5000 });

    expect(toastTextOf(win)).toBe("second");
    expect(firstExpired).toBe(0);
    toast.hide();
  });

  it("hides the action when the caller does not pass one", () => {
    const { win, toast } = mountToast();
    toast.show({ text: "只有文案" });
    expect(toastActionOf(win)?.hasAttribute("hidden")).toBe(true);
    toast.hide();
  });
});

/* ------------------------------------------------------------------------- */
/* Dialog：背景 inert、Tab 钳制、取消路径与焦点归还的分支                        */
/* ------------------------------------------------------------------------- */

/** 壳之外的一块页面主体（与真正的面板同形：浮层是 `<body>` 的兄弟）。*/
function buildPageBody(win: GlobalWindow): { app: unknown; opener: unknown } {
  const doc = win.document;
  const app = doc.createElement("div");
  app.className = "app";
  const opener = doc.createElement("button");
  opener.type = "button";
  opener.textContent = "打开";
  app.appendChild(opener);
  doc.body.insertBefore(app, doc.body.firstChild);
  return { app, opener };
}

/** 壳里补两个可 Tab 的控件（Tab 钳制要有首尾才测得出来）。*/
function addDialogControls(win: GlobalWindow): { first: unknown; last: unknown } {
  const root = win.document.querySelector('[data-dialog="account"]') as unknown as {
    appendChild(node: unknown): void;
  };
  const doc = win.document;
  const body = doc.querySelector('[data-dialog="account"] .modal__body') as unknown as {
    appendChild(node: unknown): void;
  };
  const first = doc.createElement("button");
  first.type = "button";
  body.appendChild(first);
  const last = doc.createElement("button");
  last.type = "button";
  root.appendChild(last);
  return { first, last };
}

const focused = (win: GlobalWindow): unknown => win.document.activeElement;
const keydown = (win: GlobalWindow, key: string, shiftKey = false) =>
  win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key, shiftKey, cancelable: true }));
const focusOf = (node: unknown) => (node as { focus(): void }).focus();
/** 从一个具体节点派发 keydown（真实浏览器里按键来自焦点元素）。happy-dom 的
 *  节点类型与 DOM lib 不兼容，签名收成 unknown。*/
const pressOn = (node: unknown, event: unknown): boolean =>
  (node as { dispatchEvent(input: unknown): boolean }).dispatchEvent(event);

describe("dialog — focus trap and background inert", () => {
  it("freezes everything outside the open layer and thaws it on close", () => {
    const { win, dialog } = mountDialog();
    const { app } = buildPageBody(win);
    const inertAttr = () => (app as { hasAttribute(name: string): boolean }).hasAttribute("inert");

    expect(inertAttr()).toBe(false);
    dialog.open("account");
    expect(inertAttr()).toBe(true);
    // 壳与遮罩自己不能跟着被冻：它们就是这一层。
    expect(dialogRootOf(win)?.hasAttribute("inert")).toBe(false);
    expect(dialogScrimOf(win)?.hasAttribute("inert")).toBe(false);

    dialog.close("account");
    expect(inertAttr()).toBe(false);
  });

  it("keeps Tab inside the dialog: last wraps to first, first wraps back on Shift+Tab", () => {
    const { win, dialog } = mountDialog();
    addDialogControls(win);
    dialog.open("account");
    /* 文档序里第一个可 Tab 的是关闭键（它在头部），最后一个是补在壳尾的那颗。 */
    const first = dialogCloseOf(win);
    const root = win.document.querySelector('[data-dialog="account"]') as unknown as {
      lastElementChild: unknown;
    };
    const last = root.lastElementChild;

    /* 按键从当前焦点元素派发（真实浏览器的路径）：窗内监听器跑完并拦下默认
       Tab，焦点绕回另一端。 */
    focusOf(last);
    const forward = new win.KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    pressOn(last, forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(focused(win)).toBe(first);

    const backward = new win.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true });
    pressOn(first, backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(focused(win)).toBe(last);
  });

  it("pulls focus into the dialog when it starts on the background", () => {
    const { win, dialog } = mountDialog();
    const { opener } = buildPageBody(win);
    focusOf(opener);
    dialog.open("account");
    const root = win.document.querySelector('[data-dialog="account"]') as unknown as {
      contains(node: unknown): boolean;
    };
    expect(root.contains(focused(win))).toBe(true);
  });

  it("unfreezes the background once the last stacked layer closes", () => {
    const { win, dialog } = mountDialog();
    const { app } = buildPageBody(win);
    buildDialog(win);
    const drawer = win.document.createElement("div");
    drawer.setAttribute("data-dialog", "proxies");
    drawer.setAttribute("hidden", "");
    win.document.body.appendChild(drawer);

    dialog.open("proxies");
    dialog.open("account");
    expect((app as { hasAttribute(n: string): boolean }).hasAttribute("inert")).toBe(true);

    dialog.close("account");
    // 还开着一层：背景仍然冻着。
    expect((app as { hasAttribute(n: string): boolean }).hasAttribute("inert")).toBe(true);
    dialog.close("proxies");
    expect((app as { hasAttribute(n: string): boolean }).hasAttribute("inert")).toBe(false);
  });
});

describe("dialog — cancel path and focus return", () => {
  it("runs onDismiss for Esc, the scrim click and [data-dialog-close]", () => {
    const { win, dialog } = mountDialog();
    let cancelled = 0;
    dialog.open("account", { onDismiss: () => (cancelled += 1) });
    keydown(win, "Escape");
    expect(dialog.isOpen("account")).toBe(false);
    expect(cancelled).toBe(1);

    dialog.open("account", { onDismiss: () => (cancelled += 1) });
    dialogScrimOf(win)?.click();
    expect(dialog.isOpen("account")).toBe(false);
    expect(cancelled).toBe(2);

    dialog.open("account", { onDismiss: () => (cancelled += 1) });
    dialogCloseOf(win)?.click();
    expect(dialog.isOpen("account")).toBe(false);
    /* 关闭键也是取消：二次确认框的「关闭」与 Esc 必须做同一件事，否则控件会
       停在没落盘的值上。 */
    expect(cancelled).toBe(3);
  });

  it("does not run onDismiss on a programmatic close", () => {
    const { dialog } = mountDialog();
    let cancelled = 0;
    dialog.open("account", { onDismiss: () => (cancelled += 1) });
    dialog.close("account");
    expect(cancelled).toBe(0);
  });

  it("returns focus to the fallback when the opener is gone (poll re-render)", () => {
    const { win, dialog } = mountDialog();
    const { app } = buildPageBody(win);
    const doc = win.document;
    const opener = doc.createElement("button");
    (app as unknown as { appendChild(n: unknown): void }).appendChild(opener);
    focusOf(opener);

    dialog.open("account", { fallback: () => app });
    // 轮询重画把来源换掉了：旧节点脱离文档。
    (app as unknown as { removeChild(n: unknown): void }).removeChild(opener);
    expect(opener.isConnected).toBe(false);

    dialog.close("account");
    expect(focused(win)).toBe(app);
  });

  it("prefers the live opener over the fallback", () => {
    const { win, dialog } = mountDialog();
    const { app, opener } = buildPageBody(win);
    focusOf(opener);
    dialog.open("account", { fallback: () => app });
    dialog.close("account");
    expect(focused(win)).toBe(opener);
  });

  it("never parks focus on <body> when there is nothing to return to", () => {
    const { win, dialog } = mountDialog();
    dialog.open("account");
    dialog.close("account");
    expect(focused(win)).not.toBe(win.document.body);
  });
});

describe("dialog — focus across body re-renders", () => {
  it("captures a control's identity and puts focus back after the body is rebuilt", () => {
    const { win, dialog } = mountDialog();
    dialog.open("account");
    const body = win.document.querySelector('[data-dialog="account"] .modal__body') as unknown as {
      appendChild(n: unknown): void;
      querySelectorAll(sel: string): ArrayLike<unknown>;
      firstChild: unknown;
      removeChild(n: unknown): void;
    };
    const doc = win.document;
    const makeButton = (label: string) => {
      const button = doc.createElement("button");
      button.textContent = label;
      return button;
    };

    body.appendChild(makeButton("刷新"));
    const rebuild = () => {
      const list = body.querySelectorAll("button");
      for (let i = 0; i < list.length; i++) body.removeChild(list[i]);
      /* 同一份数据重画：顺序与文案都不变，节点全是新的。 */
      body.appendChild(makeButton("刷新"));
    };

    const first = body.querySelectorAll("button")[0];
    focusOf(first);
    const mark = dialog.captureFocus(body);
    expect(mark).not.toBeNull();

    rebuild();
    expect(focused(win)).toBe(win.document.body);
    dialog.restoreFocus(body, mark);
    const restored = body.querySelectorAll("button")[0];
    expect(focused(win)).toBe(restored);
    expect(restored).not.toBe(first);
  });

  it("leaves focus alone when the user already moved it elsewhere", () => {
    const { win, dialog } = mountDialog();
    dialog.open("account");
    const body = win.document.querySelector('[data-dialog="account"] .modal__body') as unknown as {
      appendChild(n: unknown): void;
    };
    const button = win.document.createElement("button");
    body.appendChild(button);
    focusOf(button);
    const mark = dialog.captureFocus(body);

    const { opener } = buildPageBody(win);
    focusOf(opener);
    dialog.restoreFocus(body, mark);
    expect(focused(win)).toBe(opener);
  });
});
