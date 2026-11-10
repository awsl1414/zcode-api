/**
 * 登录页的行为测试。
 *
 * 和 `runtime-*.test.ts` 同一条路子：把真正拼出来的登录页放进 happy-dom，再执行
 * `page.ts` 拼好的登录运行时（常量 / 状态 / DOM / i18n / 主题 + `login.js`），
 * `fetch` 换成桩。断言的是用户看到的那几件事：密码错了说一句、连不上说另一句、
 * 成功之后整页跳走。
 *
 * 这一页不读 `/api/*`，所以桩只有一条 `/api/session`。
 */
import { afterEach, describe, expect, it } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { LOGIN_PAGE_SCRIPT, renderLoginPage } from "./page.js";

/** 登录页里会被断言到的成员（happy-dom 的 Element 与 TS 的 DOM lib 不兼容）。*/
interface Node {
  textContent: string | null;
  value: string;
  disabled: boolean;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

interface Harness {
  /** 一次 `POST /api/session` 的应答（默认 200）。*/
  sessionStatus: number;
  calls: Call[];
  navigations: string[];
  /** 拼好的文档（`document.write` 之后的那一份）。*/
  document: Document;
  role(name: string): Node | null;
  /** 填好用户名与密码，然后提交表单。*/
  submit(username: string, password: string): void;
  /** 改语言下拉，等价于用户选了一下。*/
  pickLanguage(value: string): void;
  /**
   * 等一轮提交落地。
   *
   * 给 `predicate` 时就轮询到它成立（上限 2s）：登录只有一条
   * `submit → fetch('/api/session') → 渲染/跳转` 的链，用固定 5ms 睡眠赌它跑完是
   * 墙钟预算（全量套件下 GC/IO 一挤就可能不够，同一条原则：等条件，不等预算）。
   */
  settle(predicate?: () => boolean): Promise<void>;
  close(): void;
}

const windows: GlobalWindow[] = [];

afterEach(() => {
  while (windows.length > 0) windows.pop()?.close();
});

/** happy-dom 的类型与 TS 的 DOM lib 不同名同构，脚手架边界只转这一次。*/
type Win = {
  document: Document;
  localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  location: { replace(target: string): void };
  Event: new (name: string) => unknown;
  fetch: unknown;
};

function mount(): Harness {
  const win = new GlobalWindow({ url: "http://127.0.0.1:8099/login" }) as unknown as Win;
  const calls: Call[] = [];
  const navigations: string[] = [];

  /* 整页跳转记录：`location.replace` 换成桩，断言「跳去哪」。*/
  win.location.replace = (target: string) => {
    navigations.push(target);
  };

  const harness: Harness = {
    sessionStatus: 200,
    calls,
    navigations,
    document: win.document,
    role: (name: string) => win.document.querySelector(`[data-role="${name}"]`) as Node | null,
    submit: (username: string, password: string) => {
      const user = win.document.querySelector('[data-role="login-username"]') as unknown as Node | null;
      const pass = win.document.querySelector('[data-role="login-password"]') as unknown as Node | null;
      const form = win.document.querySelector('[data-role="login-form"]') as unknown as {
        dispatchEvent(event: unknown): boolean;
      } | null;
      if (!user || !pass || !form) throw new Error("login form is incomplete");
      user.value = username;
      pass.value = password;
      form.dispatchEvent(new win.Event("submit"));
    },
    pickLanguage: (value: string) => {
      const select = win.document.getElementById("prefs-lang") as unknown as {
        value: string;
        dispatchEvent(event: unknown): boolean;
      } | null;
      if (!select) throw new Error("language select is missing");
      select.value = value;
      select.dispatchEvent(new win.Event("change"));
    },
    settle: async (predicate?: () => boolean) => {
      const deadline = Date.now() + 2_000;
      for (;;) {
        /* 先让出一轮宏任务：即使 predicate 在提交前就已成立（例如“没有发请求”），
           也要等页面自己那条 promise 链跑过一次再下结论。 */
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (predicate === undefined || predicate()) return;
        if (Date.now() >= deadline) throw new Error("login settle(): condition never held");
      }
    },
    close: () => (win as unknown as GlobalWindow).close(),
  };

  win.fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url !== "/api/session") throw new Error(`unexpected fetch ${url}`);
    const status = harness.sessionStatus;
    return { ok: status === 200, status, json: async () => ({ ok: status === 200 }) };
  };

  /* 语言固定中文：断言里的文案取自中文原文（happy-dom 默认 en-US）。*/
  win.localStorage.setItem("i18n_lang", "zh");
  win.document.write(renderLoginPage());
  /* 运行时是一串 IIFE（`page.ts` 按依赖顺序拼接）：在 window 作用域里跑一次，
     等价于浏览器执行那段内联 `<script>`。*/
  new Function("window", "document", LOGIN_PAGE_SCRIPT)(win, win.document);

  windows.push(win as unknown as GlobalWindow);
  return harness;
}

describe("login page", () => {
  it("associates both inputs with a label and keeps the error line as a live region", () => {
    const harness = mount();
    /* 可访问性要求：`<label for>` 指到 `<input id>`，点标签就能聚焦。*/
    for (const [id, name] of [
      ["login-username", "用户名"],
      ["login-password", "密码"],
    ] as const) {
      const input = harness.document.querySelector(`#${id}`);
      expect(input?.getAttribute("autocomplete")).toBe(
        id === "login-username" ? "username" : "current-password",
      );
      expect(harness.document.querySelector(`label[for="${id}"]`)?.textContent).toBe(name);
    }
    /* 错误行是常驻的 live region（`hidden` 挂在里面那条横幅上）。*/
    expect(harness.role("login-error")?.getAttribute("aria-live")).toBe("polite");
    expect(harness.role("login-error")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("login-error-banner")?.hasAttribute("hidden")).toBe(true);
  });

  it("refuses an empty form without reaching the server", async () => {
    const harness = mount();
    harness.submit("", "");
    await harness.settle(() => harness.role("login-error-banner")?.hasAttribute("hidden") === false);
    expect(harness.calls).toEqual([]);
    expect(harness.role("login-error-banner")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("login-error-text")?.textContent).toBe("请填写用户名与密码。");
  });

  it("prefetches the admin name and puts the caret in the password field", () => {
    const harness = mount();
    /* 用户名框带着默认值 admin：控制面只有管理员一个身份，预填之后
       登录要敲的就只是密码。它不是禁写值：autofill / 用户手填都会盖掉。 */
    expect(harness.role("login-username")?.value).toBe("admin");
    expect(harness.role("login-username")?.getAttribute("value")).toBe("admin");
    expect(harness.role("login-username")?.getAttribute("autocomplete")).toBe("username");
    /* 密码不预填，且焦点已经在它身上（预填了名字就不必让用户先跳一下）。 */
    expect(harness.role("login-password")?.value).toBe("");
    expect(harness.document.activeElement?.getAttribute("data-role")).toBe("login-password");
  });

  it("says «wrong username or password» on 401 and stays on the page", async () => {
    const harness = mount();
    harness.sessionStatus = 401;
    harness.submit("admin", "nope");
    await harness.settle(() => harness.role("login-error-text")?.textContent === "用户名或密码错误。");
    expect(harness.calls[0]?.url).toBe("/api/session");
    expect(harness.calls[0]?.body).toEqual({ username: "admin", password: "nope" });
    expect(harness.role("login-error-text")?.textContent).toBe("用户名或密码错误。");
    expect(harness.navigations).toEqual([]);
  });

  it("goes home on success and remembers the chosen language", async () => {
    const harness = mount();
    harness.submit("admin", "secret");
    await harness.settle(() => harness.navigations.length === 1);
    /* 换页面而不是 push：登录页不该留在历史里。*/
    expect(harness.navigations).toEqual(["/"]);
    harness.pickLanguage("en");
    expect((windows[windows.length - 1] as unknown as Win).localStorage.getItem("i18n_lang")).toBe("en");
  });
});
