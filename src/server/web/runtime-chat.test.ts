/**
 * 聊天视图：模型选择、key 归因、发送与流、附件、多会话。
 *
 * 脚手架见 `runtime-harness.ts`。
 */

import { describe, expect, it } from "bun:test";
import { GlobalWindow } from "happy-dom";
import {
  installHarnessHooks,
  account,
  attachFiles,
  completions,
  fakeDb,
  frame,
  mountChat,
  mountSettled,
  nodes,
  replies,
  statePayload,
  waitFor,
} from "./runtime-harness.js";
import type { Harness, PageNode, WinFile } from "./runtime-harness.js";
import { PAGE_APP_SCRIPT } from "./page.js";

installHarnessHooks();

/* ---- 聊天视图的脚手架 ----------------------------------------------------- */

/** 可编程的假 SSE 流：测试自己决定什么时候推一帧、什么时候收尾。*/
interface FakeStream {
  stream: ReadableStream<Uint8Array>;
  push(text: string): void;
  close(): void;
  /** 让读取端以 `AbortError` 失败：模拟真实 fetch 在中止时拒绝。*/
  fail(): void;
}

function createStream(): FakeStream {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (text) => controller?.enqueue(encoder.encode(text)),
    close: () => controller?.close(),
    fail: () => {
      try {
        controller?.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
      } catch {
        /* 流已经收尾：中止来得比流晚，没有要做的 */
      }
    },
  };
}

function imageFile(win: GlobalWindow, name = "pic.png", size = 16): WinFile {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(Math.max(0, size - 8)).fill(0),
  ]);
  return new win.File([bytes], name, { type: "image/png" }) as WinFile;
}

/** 造一个文本 File。*/
function textFile(win: GlobalWindow, name: string, text: string): WinFile {
  return new win.File([text], name, { type: "text/plain" }) as WinFile;
}

/** 预览条里的芯片（图片缩略图与文件芯片都在）。*/
function previewChips(harness: Harness): PageNode[] {
  const strip = harness.role("chat-previews");
  return strip ? nodes(strip, ".chat__preview") : [];
}

/** 当前发往补全端点的最后一条请求体里的 messages。*/
function lastMessages(harness: Harness): Array<Record<string, unknown>> {
  const last = completions(harness).at(-1);
  const body = last?.body as { messages?: Array<Record<string, unknown>> } | undefined;
  return body?.messages ?? [];
}

/* ------------------------------------------------------------------------- */
/* 聊天视图：单会话基础 + 多会话与层级选择                                      */
/* ------------------------------------------------------------------------- */

describe("chat view — model picker", () => {
  it("fills the picker from /v1/models with 服务端默认 first and selects it", async () => {
    const harness = await mountChat(statePayload(), { session: { status: 404 } });
    const select = harness.role("chat-model");

    expect([...(select?.querySelectorAll("option") ?? [])].map((option) => option.textContent)).toEqual([
      "服务端默认",
      "glm-5.3",
      "glm-5.3-flash",
    ]);
    // 空选择 = 服务端默认：进视图不替用户挑一个模型。
    expect(select?.value).toBe("");
    // 没选 key 就不带 Authorization（面板会话 Cookie 随同源请求走）。
    expect(harness.calls.filter((call) => call.url === "/v1/models")[0]?.headers.authorization).toBeUndefined();
  });

  it("labels 服务端默认 with the advertised default_model", async () => {
    // /v1/models 广告了 default_model（生效的 config.defaultModel）：空值选项显示
    // 实际将用的模型，不再是神秘值。
    const harness = await mountChat(statePayload(), {
      session: { status: 404 },
      models: { status: 200, ids: ["glm-5.3", "glm-5.3-flash"], defaultModel: "glm-5.3-flash" },
    });
    const select = harness.role("chat-model");
    expect([...(select?.querySelectorAll("option") ?? [])].map((option) => option.textContent)).toEqual([
      "默认（glm-5.3-flash）",
      "glm-5.3",
      "glm-5.3-flash",
    ]);
    // 选项 value 仍是空串：发送行为不变（body 不带 model），注入在服务端主链路。
    expect(select?.value).toBe("");
  });

  it("keeps the plain 服务端默认 label when /v1/models carries no default_model", async () => {
    // 拿不到 default_model（未配置 / 旧版本）：维持原文案，不造一个空的「默认（）」。
    const harness = await mountChat(statePayload(), {
      session: { status: 404 },
      models: { status: 200, ids: ["glm-5.3"] },
    });
    const first = harness.role("chat-model")?.querySelectorAll("option")[0];
    expect(first?.textContent).toBe("服务端默认");
  });

  it("omits model from the body while 服务端默认 is selected and sends it once chosen", async () => {
    const harness = await mountChat(statePayload());
    const stream = createStream();
    harness.chat.body = stream.stream;

    harness.type(harness.role("chat-input"), "hello");
    harness.key("Enter");
    await harness.settle();
    stream.push(frame("Hello"));
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();

    // 空选择：body 没有 model 字段（不发空串——那会让上游收到一个坏值）。
    expect(completions(harness)[0]?.body).toEqual({ messages: [{ role: "user", content: "hello" }], stream: true });

    const second = createStream();
    harness.chat.body = second.stream;
    harness.change(harness.role("chat-model"), "glm-5.3-flash");
    harness.type(harness.role("chat-input"), "again");
    harness.key("Enter");
    await harness.settle();
    second.close();
    await harness.settle();

    expect(completions(harness)[1]?.body).toEqual({
      model: "glm-5.3-flash",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "again" },
      ],
      stream: true,
    });
  });

  it("says so when the model list cannot be read", async () => {
    const harness = await mountChat(statePayload(), {
      session: { status: 404 },
      models: { status: 401, ids: [] },
    });

    // 401 是「凭据不被接受」，要改的是 key 选择。
    expect(harness.role("chat-error")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("chat-error-text")?.textContent).toContain("代理要求 API key");
  });

  it("brings the paste row up when the model list answers 401 with a live session", async () => {
    const harness = await mountChat(statePayload(), {
      session: { username: "admin" },
      models: { status: 401, ids: [] },
    });

    // key 行（下拉）常驻可见（它是归因工具）；401 后手动粘贴行必须请回来，
    // 不然错误横幅指向一个 display:none 的输入框（UI 审查 #2，截图 35）。
    expect(harness.role("chat-key-row")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("chat-key-hint")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("chat-key-manual")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("chat-error-text")?.textContent).toContain("代理要求 API key");
  });

  it("re-reads the key list on re-entry but reads models only once", async () => {
    const harness = await mountChat(statePayload());
    // 真正的重进走历史回退（popstate → showView → enter()）：聊天没有路径，侧边栏
    // 的其它项是整页链接，点它们不会在本页重新 enter。
    await harness.win.history.back();
    await harness.settle();
    harness.click(harness.find('[data-nav="chat"]'));
    await harness.settle();

    // 模型清单只拉一次；key 表每次进视图重取——key 页随时可能
    // 建 / 吊销 key，聊天页的下拉不该比 key 页旧。没有会话探针。
    expect(harness.calls.filter((call) => call.url === "/api/session")).toHaveLength(1);
    expect(harness.calls.filter((call) => call.url === "/v1/models")).toHaveLength(1);
    expect(
      harness.calls.filter((call) => call.url === "/api/control" && (call.body as { cmd?: string })?.cmd === "listApiKeys"),
    ).toHaveLength(2);
  });
});

describe("chat view — key choice", () => {
  it("keeps the key dropdown visible while the panel session is alive and rides the cookie by default", async () => {
    const harness = await mountChat(statePayload(), { session: { username: "admin" } });

    // key 下拉常驻可见：它是归因工具，面板会话可用也不能收起来。
    expect(harness.role("chat-key-row")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("chat-key-hint")?.hasAttribute("hidden")).toBe(false);
    // 手动粘贴行收着；默认选择 = 面板会话，不带 Authorization。
    expect(harness.role("chat-key-manual")?.hasAttribute("hidden")).toBe(true);
    expect(harness.role("chat-key-select")?.value).toBe("");
    expect(harness.calls.filter((call) => call.url === "/v1/models")[0]?.headers.authorization).toBeUndefined();
  });

  it("reveals the paste row after a 401 and sends the pasted key", async () => {
    const harness = await mountChat(statePayload(), { session: { username: "admin" } });
    expect(harness.role("chat-key-manual")?.hasAttribute("hidden")).toBe(true);

    harness.change(harness.role("chat-model"), "glm-5.3");
    harness.chat.status = 401;
    harness.type(harness.role("chat-input"), "hello");
    harness.key("Enter");
    await harness.settle();

    // 死路解除：横幅照报，粘贴行请回来了（Cookie 过期或 requireKey，用户得贴 key）。
    expect(harness.role("chat-error-text")?.textContent).toContain("代理要求 API key");
    expect(harness.role("chat-key-manual")?.hasAttribute("hidden")).toBe(false);

    // 贴上 key、点「使用」：粘贴本身就是一次显式的 key 选择，重发必须带它。
    harness.chat.status = 200;
    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-key"), "recovered-key");
    harness.click(harness.role("chat-key-apply"));
    await harness.settle();
    harness.key("Enter");
    await harness.settle();

    const sent = completions(harness);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.headers.authorization).toBe("Bearer recovered-key");
    stream.close();
    await harness.settle();
  });

  it("keeps the key controls usable when there never was a session", async () => {
    const harness = await mountChat(statePayload(), {
      session: { status: 404 },
      models: { status: 401, ids: [] },
    });

    // 会话不在：key 行与粘贴入口都可用，401 不该把它们藏起来。
    expect(harness.role("chat-key-row")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("chat-key-manual")?.hasAttribute("hidden")).toBe(false);
  });
});

describe("chat view — send and stream", () => {
  it("posts the message to the proxy's OpenAI endpoint and streams the reply", async () => {
    const harness = await mountChat(statePayload());
    harness.change(harness.role("chat-model"), "glm-5.3");
    const stream = createStream();
    harness.chat.body = stream.stream;

    harness.type(harness.role("chat-input"), "hello");
    harness.key("Enter");
    await harness.settle();

    // 请求形状：走代理自己的 OpenAI 兼容端点，带 model 与 stream。
    expect(completions(harness)[0]?.body).toEqual({
      model: "glm-5.3",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    // 用户消息立刻出现在对话区，输入框清空。
    expect(replies(harness)[0]?.textContent).toBe("hello");
    expect(harness.role("chat-input")?.value).toBe("");
    // 在飞时露出停止按钮。
    expect(harness.role("chat-stop")?.hasAttribute("hidden")).toBe(false);

    stream.push(frame("Hel"));
    await harness.settle();
    expect(replies(harness)[1]?.textContent).toBe("Hel");

    stream.push(frame("lo"));
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();

    expect(replies(harness)[1]?.textContent).toBe("Hello");
    expect(harness.role("chat-stop")?.hasAttribute("hidden")).toBe(true);
    expect(harness.role("chat-error")?.hasAttribute("hidden")).toBe(true);
    /* 消息区不挂 aria-live；收尾只往 chat-done 的 sr-only live region 播一句。 */
    expect(harness.role("chat-log")?.getAttribute("aria-live")).toBeNull();
    expect(harness.role("chat-done")?.textContent).toBe("回复完成");
  });

  it("keeps the finished reply in the history for the next turn", async () => {
    const harness = await mountChat(statePayload());
    harness.change(harness.role("chat-model"), "glm-5.3");
    const first = createStream();
    harness.chat.body = first.stream;

    harness.type(harness.role("chat-input"), "one");
    harness.key("Enter");
    await harness.settle();
    first.push(frame("first answer"));
    first.push("data: [DONE]\n\n");
    first.close();
    await harness.settle();

    const second = createStream();
    harness.chat.body = second.stream;
    harness.type(harness.role("chat-input"), "two");
    harness.key("Enter");
    await harness.settle();

    expect(completions(harness)[1]?.body).toEqual({
      model: "glm-5.3",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "two" },
      ],
      stream: true,
    });
    second.close();
    await harness.settle();
  });

  it("submits from the composer form as well as Enter", async () => {
    const harness = await mountChat(statePayload());
    const stream = createStream();
    harness.chat.body = stream.stream;

    harness.type(harness.role("chat-input"), "from the form");
    harness.role("chat-form")?.dispatchEvent(new harness.win.Event("submit", { cancelable: true }));
    await harness.settle();

    expect(completions(harness)).toHaveLength(1);
    stream.close();
    await harness.settle();
  });

  it("treats Shift+Enter as a newline, not a send", async () => {
    const harness = await mountChat(statePayload());
    harness.type(harness.role("chat-input"), "line one");
    harness.key("Enter", { shiftKey: true });
    await harness.settle();

    expect(completions(harness)).toHaveLength(0);
    expect(harness.role("chat-input")?.value).toBe("line one");
  });

  it("refuses to send an empty message", async () => {
    const harness = await mountChat(statePayload());
    harness.key("Enter");
    await harness.settle();

    expect(completions(harness)).toHaveLength(0);
    expect(harness.role("chat-error-text")?.textContent).toBe("消息不能为空。");
  });

  it("stops the stream when the stop button is pressed", async () => {
    const harness = await mountChat(statePayload());
    const stream = createStream();
    harness.chat.abort = stream.fail;
    harness.chat.body = stream.stream;

    harness.type(harness.role("chat-input"), "long answer");
    harness.key("Enter");
    await harness.settle();
    stream.push(frame("partial"));
    await harness.settle();

    harness.role("chat-stop")?.click();
    await harness.settle();

    // 已经收到的部分留在会话里；停止按钮收起，状态写明是用户停的。
    expect(replies(harness)[1]?.textContent).toBe("partial");
    expect(harness.role("chat-stop")?.hasAttribute("hidden")).toBe(true);
    expect(harness.role("chat-status")?.textContent).toBe("已停止");
    expect(harness.role("chat-error")?.hasAttribute("hidden")).toBe(true);
  });

  it("drops the empty reply bubble when the stream is stopped before any token", async () => {
    const harness = await mountChat(statePayload());
    const stream = createStream();
    harness.chat.abort = stream.fail;
    harness.chat.body = stream.stream;

    harness.type(harness.role("chat-input"), "hello");
    harness.key("Enter");
    await harness.settle();
    harness.role("chat-stop")?.click();
    await harness.settle();

    // 一个字都没到：不要留一条空回复，输入框也不该被清掉的那句话丢掉。
    expect([...replies(harness)].map((node) => node.textContent)).toEqual(["hello"]);
    expect(harness.role("chat-empty")?.hasAttribute("hidden")).toBe(true);
  });
});

describe("chat view — error reporting", () => {
  it("explains a 401 and hands the message back to the composer", async () => {
    const harness = await mountChat(statePayload());
    harness.change(harness.role("chat-model"), "glm-5.3");
    harness.chat.status = 401;

    harness.type(harness.role("chat-input"), "hello");
    harness.key("Enter");
    await harness.settle();

    expect(harness.role("chat-error")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("chat-error-text")?.textContent).toContain("代理要求 API key");
    // 这一轮撤回：气泡删掉、正文还给输入框，用户改完 key 能直接重发。
    expect(replies(harness)).toHaveLength(0);
    expect(harness.role("chat-input")?.value).toBe("hello");

    // 401 把手动粘贴行请回来：贴上 key、点「使用」，粘贴就是一次显式的 key 选择。
    expect(harness.role("chat-key-manual")?.hasAttribute("hidden")).toBe(false);
    harness.chat.status = 200;
    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-key"), "recovered-key");
    harness.click(harness.role("chat-key-apply"));
    await harness.settle();
    harness.key("Enter");
    await harness.settle();
    expect(completions(harness)[1]?.body).toEqual({
      model: "glm-5.3",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    expect(completions(harness)[1]?.headers.authorization).toBe("Bearer recovered-key");
    stream.close();
    await harness.settle();
  });

  it("keeps the upstream message out of the banner and only speaks the action", async () => {
    const harness = await mountChat(statePayload());
    harness.chat.status = 502;
    harness.chat.error = "upstream unreachable";
    /* 视图用的是页面全局 `console`（happy-dom 把它代理到进程的那一个），
       所以在这一层拦截。 */
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };

    try {
      harness.type(harness.role("chat-input"), "hello");
      harness.key("Enter");
      await harness.settle();
    } finally {
      console.error = original;
    }

    /* 横幅只说「哪一步失败了」+ 状态码；上游原文不进用户可见文本（它可能带着
       请求体片段与内部报文），原始信息走控制台与日志页。 */
    const text = harness.role("chat-error-text")?.textContent ?? "";
    expect(text).toContain("502");
    expect(text).not.toContain("upstream unreachable");
    expect(logged.some((args) => args.some((arg) => String(arg).includes("upstream unreachable")))).toBe(true);
    expect(replies(harness)).toHaveLength(0);
  });

  it("never passes an upstream message into a chat error key", () => {
    /* 字典里的 `{{message}}` 槽位由 i18n 负责去掉；这一条钉的是**调用方**：
       视图不再往 `chat.error.*` 里塞 `message`，所以模板有没有槽位都不会有
       原文落进横幅（上游原文不该出现在用户可见文本里）。 */
    expect(PAGE_APP_SCRIPT).not.toMatch(/chat\.error\.[a-zA-Z]+",\s*\{[^}]*message:/);
  });
});

/* ------------------------------------------------------------------------- */
/* 聊天多会话：localStorage 持久、切换隔离、在飞收尾、护栏                      */
/* ------------------------------------------------------------------------- */

/** localStorage 里 `zcode-chat-sessions` 的一份载荷。*/
function sessionsPayload(sessions: unknown[]): string {
  return JSON.stringify({ version: 1, sessions });
}

/** 一条存储里的会话（形状与视图的 sanitizeSession 输入对齐）。*/
function storedSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "s-seed",
    title: "",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    messages: [],
    choices: { account: "", route: "", model: "", key: "" },
    ...overrides,
  };
}

/** 当前 localStorage 里的会话数组（断言持久化用）。*/
function storedSessions(harness: Harness): Array<Record<string, unknown>> {
  const raw = harness.win.localStorage.getItem("zcode-chat-sessions");
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { sessions?: Array<Record<string, unknown>> };
  return parsed.sessions ?? [];
}

/** 存储里第 `sessionIndex` 条会话的第 `messageIndex` 条消息（形状由调用方断言）。*/
function storedSessionAt(harness: Harness, sessionIndex: number, messageIndex: number): unknown {
  const session = storedSessions(harness)[sessionIndex];
  const messages = session && Array.isArray(session.messages) ? (session.messages as unknown[]) : [];
  return messages[messageIndex];
}

/** 会话列表里的条目（列表按 updatedAt 降序）。*/
function sessionItems(harness: Harness): PageNode[] {
  return nodes(harness.role("chat-session-list"), ".chat__session");
}

function sessionTitle(harness: Harness, index: number): string | null {
  const item = sessionItems(harness)[index];
  return item ? (item.querySelector(".chat__session-title")?.textContent ?? null) : null;
}

describe("chat sessions", () => {
  it("creates a first session on entry and saves a finished exchange to localStorage", async () => {
    const harness = await mountChat(statePayload());

    // 进视图就有一个干净的会话（标题空着，展示为「新会话」）。
    expect(sessionItems(harness)).toHaveLength(1);
    expect(sessionTitle(harness, 0)).toBe("新会话");

    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-input"), "hello");
    harness.key("Enter");
    await harness.settle();
    stream.push(frame("Hello"));
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();

    // 收尾后落盘：消息、标题（首条消息截 20 字）、时间戳都在。
    const stored = storedSessions(harness);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hello" },
    ]);
    expect(stored[0]?.title).toBe("hello");
    expect(typeof stored[0]?.createdAt).toBe("number");
    expect(sessionTitle(harness, 0)).toBe("hello");
  });

  it("reuses the current empty session instead of stacking a new one (dedupe)", async () => {
    const harness = await mountChat(statePayload());

    // 进视图就有一条干净会话；当前选中的就是它。
    expect(sessionItems(harness)).toHaveLength(1);
    expect(sessionItems(harness)[0]?.getAttribute("data-current")).toBe("true");

    // 连点新建：不再攒出第二第三条「新会话」——聚焦现有空会话。存储也
    // 不动（空会话本来就没落盘，「有内容才写」）。
    harness.click(harness.role("chat-new"));
    await harness.settle();
    harness.click(harness.role("chat-new"));
    await harness.settle();
    expect(sessionItems(harness)).toHaveLength(1);
    expect(storedSessions(harness)).toHaveLength(0);
    expect(sessionItems(harness)[0]?.getAttribute("data-current")).toBe("true");
    // 空态还在：没有被切走，输入框重新拿到焦点。
    expect(harness.role("chat-empty")?.hasAttribute("hidden")).toBe(false);
    expect(harness.win.document.activeElement?.getAttribute("data-role")).toBe("chat-input");

    // 发出第一条消息后，新建才真的建新会话（去重只针对空会话）。
    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-input"), "first");
    harness.key("Enter");
    await harness.settle();
    stream.push(frame("ok"));
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();

    harness.click(harness.role("chat-new"));
    await harness.settle();
    expect(sessionItems(harness)).toHaveLength(2);
    expect(sessionItems(harness)[0]?.getAttribute("data-current")).toBe("true");
    expect(storedSessions(harness)).toHaveLength(2);
  });

  it("isolates messages between sessions", async () => {
    const harness = await mountChat(statePayload());
    const first = createStream();
    harness.chat.body = first.stream;
    harness.type(harness.role("chat-input"), "one");
    harness.key("Enter");
    await harness.settle();
    first.push(frame("first answer"));
    first.push("data: [DONE]\n\n");
    first.close();
    await harness.settle();

    // 新会话：对话区是空的；发消息只带这个会话自己的历史（无状态协议，多会话只是
    // 前端管理多份数组）。
    harness.click(harness.role("chat-new"));
    await harness.settle();
    expect(harness.role("chat-empty")?.hasAttribute("hidden")).toBe(false);

    const second = createStream();
    harness.chat.body = second.stream;
    harness.type(harness.role("chat-input"), "two");
    harness.key("Enter");
    await harness.settle();
    second.push(frame("second answer"));
    second.push("data: [DONE]\n\n");
    second.close();
    await harness.settle();

    expect(completions(harness)[1]?.body).toEqual({
      messages: [{ role: "user", content: "two" }],
      stream: true,
    });

    // 切回第一个会话：它的历史原样回来。
    harness.click(sessionItems(harness)[1] ?? null);
    await harness.settle();
    expect(nodes(harness.role("chat-log"), ".chat__body").map((node) => node.textContent)).toEqual([
      "one",
      "first answer",
    ]);
  });

  it("reverts the derived title when the first exchange fails and rolls back", async () => {
    const harness = await mountChat(statePayload());
    harness.chat.status = 502;

    harness.type(harness.role("chat-input"), "注定失败的开场白");
    harness.key("Enter");
    await harness.settle();

    // 这一轮被撤回：会话回到空，从首条消息派生的标题也一并退场（否则列表里挂着
    // 一句没人问过的话）。
    expect(replies(harness)).toHaveLength(0);
    expect(sessionTitle(harness, 0)).toBe("新会话");
  });

  it("aborts the in-flight stream when switching sessions and keeps the partial in the old one", async () => {
    const harness = await mountChat(statePayload());
    const stream = createStream();
    harness.chat.abort = stream.fail;
    harness.chat.body = stream.stream;

    harness.type(harness.role("chat-input"), "long answer");
    harness.key("Enter");
    await harness.settle();
    stream.push(frame("partial"));
    await harness.settle();

    // 切到新会话：在飞的流先被中止，收尾链走完才换数据。
    harness.click(harness.role("chat-new"));
    await harness.settle();

    // busy 复位；新会话是空的。
    expect(harness.role("chat-stop")?.hasAttribute("hidden")).toBe(true);
    expect(harness.role("chat-empty")?.hasAttribute("hidden")).toBe(false);

    // 切回来：已收到的部分留在旧会话里（不是被切换吞掉）。列表按 updatedAt 降序
    //（同毫秒并列时保持存储序），所以按标题找旧会话，不按位置。
    const oldItem = sessionItems(harness).find(
      (item) => item.querySelector(".chat__session-title")?.textContent === "long answer",
    );
    harness.click(oldItem ?? null);
    await harness.settle();
    expect(nodes(harness.role("chat-log"), ".chat__body").map((node) => node.textContent)).toEqual([
      "long answer",
      "partial",
    ]);
    const stored = storedSessions(harness).find((session) =>
      JSON.stringify(session.messages ?? []).includes("long answer"),
    );
    expect(stored?.messages).toEqual([
      { role: "user", content: "long answer" },
      { role: "assistant", content: "partial" },
    ]);
  });

  it("survives a reload: sessions and their choice snapshots come back from localStorage", async () => {
    const first = await mountChat(statePayload());
    const stream = createStream();
    first.chat.body = stream.stream;
    first.type(first.role("chat-input"), "persist me");
    first.key("Enter");
    await first.settle();
    stream.push(frame("persisted"));
    stream.push("data: [DONE]\n\n");
    stream.close();
    await first.settle();
    // 选择快照随会话存：换个模型再走。
    first.change(first.role("chat-model"), "glm-5.3-flash");

    const raw = first.win.localStorage.getItem("zcode-chat-sessions") ?? "";
    expect(raw).toContain("persist me");

    // 第二个「页面」：同一份 localStorage（刷新语义）。
    const second = await mountSettled("/", statePayload());
    second.win.localStorage.setItem("zcode-chat-sessions", raw);
    second.click(second.find('[data-nav="chat"]'));
    await second.settle();

    expect(nodes(second.role("chat-log"), ".chat__body").map((node) => node.textContent)).toEqual([
      "persist me",
      "persisted",
    ]);
    expect(sessionTitle(second, 0)).toBe("persist me");
    expect(second.role("chat-model")?.value).toBe("glm-5.3-flash");
  });

  it("falls back to a fresh store when the saved value is corrupted", async () => {
    const harness = await mountSettled("/", statePayload());
    harness.win.localStorage.setItem("zcode-chat-sessions", "{not json at all");
    harness.click(harness.find('[data-nav="chat"]'));
    await harness.settle();

    // 损坏的值当没存过：落到一个干净的新会话，发送照常工作、照常落盘。
    expect(sessionItems(harness)).toHaveLength(1);
    expect(sessionTitle(harness, 0)).toBe("新会话");

    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-input"), "hello");
    harness.key("Enter");
    await harness.settle();
    stream.push(frame("Hi"));
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();

    expect(storedSessions(harness)).toHaveLength(1);
    expect(storedSessions(harness)[0]?.messages).toHaveLength(2);

    // 版本号不认识也当没存过（将来改结构时的退路）。
    const second = await mountSettled("/", statePayload());
    second.win.localStorage.setItem(
      "zcode-chat-sessions",
      JSON.stringify({ version: 99, sessions: [storedSession()] }),
    );
    second.click(second.find('[data-nav="chat"]'));
    await second.settle();
    expect(sessionItems(second)).toHaveLength(1);

    // 信封合法但条目坏了：坏条目丢弃、好条目保留且坏消息被滤掉。
    const third = await mountSettled("/", statePayload());
    third.win.localStorage.setItem(
      "zcode-chat-sessions",
      sessionsPayload([
        null,
        42,
        storedSession({ messages: [{ role: "user", content: "kept" }, { role: 42, content: 7 }, "junk"] }),
      ]),
    );
    third.click(third.find('[data-nav="chat"]'));
    await third.settle();
    expect(sessionItems(third)).toHaveLength(1);
    expect(nodes(third.role("chat-log"), ".chat__body").map((node) => node.textContent)).toEqual(["kept"]);
  });

  it("refuses to send past the per-session message cap and says so", async () => {
    const harness = await mountSettled("/", statePayload());
    const messages = Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: `m${i}`,
    }));
    harness.win.localStorage.setItem("zcode-chat-sessions", sessionsPayload([storedSession({ messages })]));
    harness.click(harness.find('[data-nav="chat"]'));
    await harness.settle();

    harness.type(harness.role("chat-input"), "one more");
    harness.key("Enter");
    await harness.settle();

    expect(completions(harness)).toHaveLength(0);
    expect(harness.role("chat-error-text")?.textContent).toContain("200");
    expect(harness.role("chat-error-text")?.textContent).toContain("新建");
  });

  it("warns to delete old sessions when the store approaches the browser quota", async () => {
    const harness = await mountChat(statePayload());
    // 软上限是常量（app-constants），测试把它拧小来驱动同一条逻辑，不真灬 5MB。
    (harness.win as unknown as { __zcodeApp: { const: { CHAT_STORAGE_SOFT_LIMIT: number } } }).__zcodeApp.const.
      CHAT_STORAGE_SOFT_LIMIT = 64;

    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-input"), "hello");
    harness.key("Enter");
    await harness.settle();
    stream.push(frame("Hello"));
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();

    expect(harness.role("chat-notice")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("chat-notice-text")?.textContent).toContain("删除旧会话");
    // 只提醒不拦截：消息照常落库。
    expect(storedSessions(harness)[0]?.messages).toHaveLength(2);
  });

  it("makes each session item a keyboard target: Tab focus, Enter switches, F2 renames", async () => {
    const harness = await mountChat(statePayload());
    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-input"), "first");
    harness.key("Enter");
    await harness.settle();
    stream.push(frame("ok"));
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();
    harness.click(harness.role("chat-new"));
    await harness.settle();
    expect(sessionItems(harness)).toHaveLength(2);

    /* 会话项自己是一行按键（`role="button"` + `tabindex="0"`）：宽屏下它是切换
       会话的唯一入口，以前只能鼠标点。 */
    const second = sessionItems(harness)[1] as unknown as {
      focus(): void;
      dispatchEvent(event: unknown): boolean;
      getAttribute(name: string): string | null;
    };
    const secondId = second.getAttribute("data-session-id");
    expect(second.getAttribute("role")).toBe("button");
    expect(second.getAttribute("tabindex")).toBe("0");

    second.focus();
    expect(harness.win.document.activeElement === (second as unknown)).toBe(true);
    second.dispatchEvent(new harness.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await harness.settle();
    /* 切换之后列表按 updatedAt 重排：现在当前的那条必须是被按下的那一条。 */
    const current = sessionItems(harness).find((item) => item.getAttribute("data-current") === "true");
    expect(current?.getAttribute("data-session-id")).toBe(secondId);

    // F2 与双击标题同义：原位输入框出现，焦点在里面。
    const focusedItem = sessionItems(harness).find(
      (item) => item.getAttribute("data-session-id") === secondId,
    ) as unknown as { dispatchEvent(event: unknown): boolean };
    focusedItem.dispatchEvent(new harness.win.KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    await harness.settle();
    const rename = harness.role("chat-session-list")?.querySelector(".chat__rename");
    expect(rename).not.toBeNull();
    expect(harness.win.document.activeElement === (rename as unknown)).toBe(true);
  });

  it("returns focus to the session item after a rename", async () => {
    const harness = await mountChat(statePayload());
    harness.type(harness.role("chat-input"), "keep");
    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.key("Enter");
    await harness.settle();
    stream.push(frame("ok"));
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();

    const titleNode = sessionItems(harness)[0]?.querySelector(".chat__session-title") ?? null;
    titleNode?.dispatchEvent(new harness.win.Event("dblclick"));
    await harness.settle();
    const rename = harness.role("chat-session-list")?.querySelector(".chat__rename") ?? null;
    harness.type(rename, "renamed");
    rename?.dispatchEvent(new harness.win.KeyboardEvent("keydown", { key: "Enter" }));
    await harness.settle();

    expect(sessionTitle(harness, 0)).toBe("renamed");
    /* 输入框在提交后就没了：焦点回到这一条会话项，而不是 body。 */
    expect(harness.win.document.activeElement === (sessionItems(harness)[0] as unknown)).toBe(true);
  });

  it("titles a session from its first message and renames it on double click", async () => {
    const harness = await mountChat(statePayload());
    const stream = createStream();
    harness.chat.body = stream.stream;

    harness.type(harness.role("chat-input"), "这是一条会被截断的标题消息，因为超过二十个字了");
    harness.key("Enter");
    await harness.settle();
    stream.push(frame("ok"));
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();

    // 标题 = 首条用户消息的前 20 字 + 省略号。
    expect(sessionTitle(harness, 0)).toBe("这是一条会被截断的标题消息，因为超过二十…");

    // 双击标题 → 原位输入框；Enter 提交。
    const titleNode = sessionItems(harness)[0]?.querySelector(".chat__session-title") ?? null;
    titleNode?.dispatchEvent(new harness.win.Event("dblclick"));
    await harness.settle();
    const rename = harness.role("chat-session-list")?.querySelector(".chat__rename") ?? null;
    expect(rename).not.toBeNull();
    harness.type(rename, "排查账号 A");
    rename?.dispatchEvent(new harness.win.KeyboardEvent("keydown", { key: "Enter" }));
    await harness.settle();

    expect(sessionTitle(harness, 0)).toBe("排查账号 A");
    expect(storedSessions(harness)[0]?.title).toBe("排查账号 A");
  });

  it("deletes a session outright, without a confirm, and falls back to the most recent one", async () => {
    const harness = await mountChat(statePayload());
    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-input"), "keep me");
    harness.key("Enter");
    await harness.settle();
    stream.push(frame("kept"));
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();

    // 新建一个空会话（更新时间最新，排在列表第一），删它。
    harness.click(harness.role("chat-new"));
    await harness.settle();
    expect(sessionItems(harness)).toHaveLength(2);

    const deleteButton = nodes(sessionItems(harness)[0] ?? null, ".chat__session-delete")[0] ?? null;
    harness.click(deleteButton);
    await harness.settle();

    /* 不弹二次确认——删了就删了，反悔入口是同一条 toast 里的「撤销」。*/
    expect(harness.role("confirm-modal")?.hasAttribute("hidden")).toBe(true);
    expect(harness.role("toast")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("toast-text")?.textContent).toContain("已删除会话");
    expect(harness.role("toast-action")?.hasAttribute("hidden")).toBe(false);

    // 落回有内容的那条；存储里也只剩一条。
    expect(sessionItems(harness)).toHaveLength(1);
    expect(nodes(harness.role("chat-log"), ".chat__body").map((node) => node.textContent)).toEqual([
      "keep me",
      "kept",
    ]);
    expect(storedSessions(harness)).toHaveLength(1);
  });

  it("restores the deleted session from the undo toast and clears it", async () => {
    const harness = await mountChat(statePayload());
    harness.type(harness.role("chat-input"), "undo me");
    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.key("Enter");
    await harness.settle();
    stream.push(frame("ok"));
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();

    // 再建一条空会话，删掉它——它是当前会话，删除后落回有内容的那条。
    harness.click(harness.role("chat-new"));
    await harness.settle();
    const emptyId = sessionItems(harness)[0]?.getAttribute("data-session-id") ?? "";
    harness.click(nodes(sessionItems(harness)[0] ?? null, ".chat__session-delete")[0] ?? null);
    await harness.settle();
    expect(sessionItems(harness)).toHaveLength(1);

    // 点「撤销」：会话回到列表，存储里也回来了，toast 收起。
    harness.click(harness.role("toast-action"));
    await harness.settle();
    expect(sessionItems(harness)).toHaveLength(2);
    expect(sessionItems(harness).map((item) => item.getAttribute("data-session-id"))).toContain(emptyId);
    expect(storedSessions(harness)).toHaveLength(2);
    expect(harness.role("toast")?.hasAttribute("hidden")).toBe(true);
  });

  it("commits the delete when the undo window closes", async () => {
    const harness = await mountChat(statePayload());
    harness.type(harness.role("chat-input"), "gone");
    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.key("Enter");
    await harness.settle();
    stream.push(frame("ok"));
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();

    harness.click(harness.role("chat-new"));
    await harness.settle();
    /* 撤销窗口缩短到 20ms：等条件成立而不是等 5 秒墙钟（见 waitFor 的注释）。
       "条子露出来" 那个断言放在上一条用例（默认 5s 窗口）里——20ms 的窗口在
       `settle()` 这一往返里可能已经到点了。*/
    (harness.win as unknown as { __zcodeApp: { const: { CHAT_UNDO_MS: number } } }).__zcodeApp.const.CHAT_UNDO_MS = 20;
    harness.click(nodes(sessionItems(harness)[0] ?? null, ".chat__session-delete")[0] ?? null);
    await harness.settle();

    await waitFor(() => harness.role("toast")?.hasAttribute("hidden") === true, "undo toast hides itself");
    /* 窗口关闭后撤销入口失效：再点一次也不会把会话放回来（动作只在窗口内有效）。*/
    harness.click(harness.role("toast-action"));
    await harness.settle();
    expect(sessionItems(harness)).toHaveLength(1);
    expect(storedSessions(harness)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------- */
/* 聊天层级选择：账号 → 套餐 → 模型 → key，每会话一份快照                       */
/* ------------------------------------------------------------------------- */

describe("chat selectors", () => {
  const accountsState = () =>
    statePayload({
      accounts: [
        account({ label: "work-team", routes: ["coding-plan", "start-plan"] }),
        account({ label: "offpeak-only", routes: ["off-peak"] }),
        account({ label: "disabled", routes: ["coding-plan"], enabled: false }),
      ],
    });

  it("defaults every layer to its empty choice", async () => {
    const harness = await mountChat(accountsState());
    expect(harness.role("chat-account")?.value).toBe("");
    expect(harness.role("chat-route")?.value).toBe("");
    expect(harness.role("chat-model")?.value).toBe("");
    expect(harness.role("chat-key-select")?.value).toBe("");
    // 未选账号：套餐下拉是全部四条 ROUTE_KINDS（协议值不翻译，与日志页同一约定）。
    expect([...(harness.role("chat-route")?.querySelectorAll("option") ?? [])].map((option) => option.value)).toEqual([
      "",
      "coding-plan",
      "start-plan",
      "off-peak",
      "highspeed",
    ]);
  });

  it("narrows the plan dropdown to the chosen account's routes and excludes disabled accounts", async () => {
    const harness = await mountChat(accountsState());
    const accountOptions = [...(harness.role("chat-account")?.querySelectorAll("option") ?? [])].map(
      (option) => option.value,
    );
    expect(accountOptions).toEqual(["", "work-team", "offpeak-only"]);

    harness.change(harness.role("chat-account"), "work-team");
    await harness.settle();

    // 联动：套餐下拉只剩该账号允许的路由；选择重置回「按策略」。
    expect([...(harness.role("chat-route")?.querySelectorAll("option") ?? [])].map((option) => option.value)).toEqual([
      "",
      "coding-plan",
      "start-plan",
    ]);
    expect(harness.role("chat-route")?.value).toBe("");

    // 切到另一个账号：重置后选项跟着换。
    harness.change(harness.role("chat-account"), "offpeak-only");
    await harness.settle();
    expect([...(harness.role("chat-route")?.querySelectorAll("option") ?? [])].map((option) => option.value)).toEqual([
      "",
      "off-peak",
    ]);
    expect(harness.role("chat-route")?.value).toBe("");
  });

  it("keeps each session's choice snapshot and restores it on switch", async () => {
    const harness = await mountChat(accountsState());
    harness.change(harness.role("chat-account"), "work-team");
    harness.change(harness.role("chat-route"), "start-plan");
    harness.change(harness.role("chat-model"), "glm-5.3-flash");

    // 第一条会话先落一条消息：空会话上点「新建」会去重而不创建，
    // 第二个会话要有内容才真的长出来。
    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-input"), "seed");
    harness.key("Enter");
    await harness.settle();
    stream.push(frame("ok"));
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();

    harness.click(harness.role("chat-new"));
    await harness.settle();

    // 新会话继承当前选择（测试矩阵里「只改一个维度」从这里开始）。
    expect(harness.role("chat-account")?.value).toBe("work-team");
    expect(harness.role("chat-route")?.value).toBe("start-plan");
    expect(harness.role("chat-model")?.value).toBe("glm-5.3-flash");

    // 第二个会话换组合：切账号 → 套餐重置到「按策略」。
    harness.change(harness.role("chat-account"), "offpeak-only");
    await harness.settle();
    expect(harness.role("chat-account")?.value).toBe("offpeak-only");
    expect(harness.role("chat-route")?.value).toBe("");

    // 切回第一个会话：它的「账号×套餐×模型」组合原样回来。
    harness.click(sessionItems(harness)[1] ?? null);
    await harness.settle();
    expect(harness.role("chat-account")?.value).toBe("work-team");
    expect(harness.role("chat-route")?.value).toBe("start-plan");
    expect(harness.role("chat-model")?.value).toBe("glm-5.3-flash");
  });

  it("sends the explicit routing headers only when a choice is made", async () => {
    const harness = await mountChat(accountsState());
    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-input"), "hello");
    harness.key("Enter");
    await harness.settle();
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();

    // 空选择：不带 X-ZCode-Account / X-ZCode-Route（调度器按策略选号选档）。测试
    // 只看这两条**路由**头：聊天页还带 X-ZCode-Client 自报头（`client-kind.ts`
    // 的 panel 判定），它在每个请求上都发，不是路由选择的一部分。
    const bare = completions(harness)[0]?.headers ?? {};
    expect(Object.keys(bare).filter((name) => /^x-zcode-(account|route)$/i.test(name))).toEqual([]);

    harness.change(harness.role("chat-account"), "work-team");
    harness.change(harness.role("chat-route"), "start-plan");
    const second = createStream();
    harness.chat.body = second.stream;
    harness.type(harness.role("chat-input"), "again");
    harness.key("Enter");
    await harness.settle();
    second.push("data: [DONE]\n\n");
    second.close();
    await harness.settle();

    const headers = completions(harness)[1]?.headers ?? {};
    expect(headers["X-ZCode-Account"]).toBe("work-team");
    expect(headers["X-ZCode-Route"]).toBe("start-plan");
  });

  it("drops a saved choice that is no longer valid instead of sending it", async () => {
    const harness = await mountSettled("/", accountsState());
    harness.win.localStorage.setItem(
      "zcode-chat-sessions",
      sessionsPayload([
        storedSession({
          choices: { account: "gone-account", route: "highspeed", model: "glm-9", key: "key-gone" },
        }),
      ]),
    );
    harness.click(harness.find('[data-nav="chat"]'));
    await harness.settle();

    // 全部回落「空选择」，并写回会话：下一轮请求不再带失效的头 / 字段。
    expect(harness.role("chat-account")?.value).toBe("");
    expect(harness.role("chat-route")?.value).toBe("");
    expect(harness.role("chat-model")?.value).toBe("");
    expect(harness.role("chat-key-select")?.value).toBe("");
    expect(storedSessions(harness)[0]?.choices).toEqual({ account: "", route: "", model: "", key: "" });
  });
});

/* ------------------------------------------------------------------------- */
/* 聊天 key 归因：listApiKeys 解密带回 secret，选中即发                         */
/*                                                                         */
/* 存储层存密文，listApiKeys 应答带回解密后的 secret——选已管理的 key           */
/* 直接发，粘贴行只剩「手动输入」入口；旧 key（无密文可解）提示重新生成。        */
/* ------------------------------------------------------------------------- */

describe("chat key attribution", () => {
  const keyRows = [
    {
      id: "key-a",
      name: "laptop",
      prefix: "zc-a1",
      enabled: true,
      secret: "zc-a1-full-secret",
    },
    { id: "key-b", name: "ci", prefix: "zc-b2", enabled: false },
  ];


  it("lists panel session, managed keys and the manual entry; disabled keys are unselectable", async () => {
    const harness = await mountChat(statePayload(), { apiKeys: keyRows });
    const options = [...(harness.role("chat-key-select")?.querySelectorAll("option") ?? [])];
    expect(options.map((option) => option.textContent)).toEqual([
      "面板会话（默认）",
      "laptop (zc-a1…)",
      "ci (zc-b2…)",
      "手动输入…",
    ]);
    expect(options[2]?.disabled).toBe(true);
  });

  it("sends a managed key directly from the stored secret — no paste row", async () => {
    const harness = await mountChat(statePayload(), { apiKeys: keyRows });

    // 选中 key-a：secret 已在应答里 → 不弹粘贴行，不要求任何输入。
    harness.change(harness.role("chat-key-select"), "key-a");
    await harness.settle();
    expect(harness.role("chat-key-manual")?.hasAttribute("hidden")).toBe(true);

    // 模型列表请求已经带完整值（keyFor 直接从 keyRows 取 secret）。
    expect(harness.calls.filter((call) => call.url === "/v1/models").at(-1)?.headers.authorization).toBe(
      "Bearer zc-a1-full-secret",
    );

    // 本机不存任何副本：localStorage 里没有 zcode-chat-keys（粘贴时代的桶不再被写入）。
    expect(harness.win.localStorage.getItem("zcode-chat-keys")).toBeNull();

    // 聊天请求带完整值 → 用量真实归因到 key-a（apiKeyId）。
    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-input"), "hello");
    harness.key("Enter");
    await harness.settle();
    expect(completions(harness)[0]?.headers.authorization).toBe("Bearer zc-a1-full-secret");
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();
  });

  it("keeps the manual paste path alive: paste + remember lands in localStorage", async () => {
    const harness = await mountChat(statePayload(), { apiKeys: keyRows });

    // 手动输入是唯一还走粘贴行的入口；占位符不再点名某把 key（它只服务手动输入）。
    harness.change(harness.role("chat-key-select"), "manual");
    await harness.settle();
    expect(harness.role("chat-key-manual")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("chat-key")?.getAttribute("placeholder")).toContain("手动输入");

    harness.type(harness.role("chat-key"), "zc-ff-never-seen");
    harness.click(harness.role("chat-key-apply"));
    await harness.settle();

    // 前缀命中不了任何已管理 key：留在 manual 桶。
    expect(JSON.parse(harness.win.localStorage.getItem("zcode-chat-keys") ?? "{}")).toEqual({
      manual: "zc-ff-never-seen",
    });
    expect(harness.role("chat-key-manual")?.hasAttribute("hidden")).toBe(true);
    expect(harness.calls.filter((call) => call.url === "/v1/models").at(-1)?.headers.authorization).toBe(
      "Bearer zc-ff-never-seen",
    );
  });

  it("keeps an ephemeral paste out of localStorage when 记住此 key is unchecked", async () => {
    const harness = await mountChat(statePayload(), { apiKeys: keyRows });
    harness.change(harness.role("chat-key-select"), "manual");
    harness.change(harness.role("chat-key-remember"), "", false);
    harness.type(harness.role("chat-key"), "zc-a1-ephemeral");
    harness.click(harness.role("chat-key-apply"));
    await harness.settle();

    // 本页生存期内生效（请求带它），但不落盘：刷新之后得重新粘。
    // 前缀命中 key-a：归到它名下，但只在内存里。
    expect(harness.win.localStorage.getItem("zcode-chat-keys")).toBeNull();
    expect(harness.calls.filter((call) => call.url === "/v1/models").at(-1)?.headers.authorization).toBe(
      "Bearer zc-a1-ephemeral",
    );
  });


  it("associates a remembered manual paste with its key by prefix", async () => {
    const harness = await mountChat(statePayload(), { apiKeys: keyRows });
    harness.change(harness.role("chat-key-select"), "manual");
    await harness.settle();

    harness.type(harness.role("chat-key"), "zc-a1-pasted-full");
    harness.click(harness.role("chat-key-apply"));
    await harness.settle();

    // 前缀唯一命中 key-a：落到它的名下，下拉也切过去（manual 桶不留这份）。
    expect(harness.role("chat-key-select")?.value).toBe("key-a");
    expect(JSON.parse(harness.win.localStorage.getItem("zcode-chat-keys") ?? "{}")).toEqual({
      "key-a": "zc-a1-pasted-full",
    });
  });
});

/* ------------------------------------------------------------------------- */
/* 聊天 key 归因 — Cookie 处理                                                  */
/*                                                                         */
/* 鉴权优先级是会话 Cookie > Bearer key，而同源 fetch 总是自动带               */
/* Cookie：登录着的面板里选 key 发请求，服务端仍把用量归因到面板会话            */
/*（apiKeyId 为空），选中的 key 只被当成真伪测试。修复在前端：key 模式的       */
/* 聊天请求带 `credentials: "omit"`——Cookie 不随请求走，服务端没有会话可认，    */
/* 就按 Bearer key 鉴权并把用量记到那把 key 头上。会话模式保持同源 Cookie，     */
/* `/v1/models` 不动。归因本体（apiKeyId 记到 key / 空串）是服务端语义，        */
/* server.test.ts 已有覆盖；这里的 mock 链路只到 fetch init 为止，断言的正是    */
/* 产生归因差异的那个请求形状。                                              */
/* ------------------------------------------------------------------------- */

describe("chat key attribution — cookie handling", () => {
  /* secret 随 listApiKeys 带回，选已管理 key 不经过粘贴行。 */
  const keyRows = [{ id: "key-a", name: "laptop", prefix: "zc-a1", enabled: true, secret: "zc-a1-full-secret" }];

  it("sends key-mode chat requests without credentials so the usage can attribute to the key", async () => {
    const harness = await mountChat(statePayload(), { apiKeys: keyRows });
    harness.change(harness.role("chat-key-select"), "key-a");
    await harness.settle();

    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-input"), "hello");
    harness.key("Enter");
    await harness.settle();

    const sent = completions(harness);
    expect(sent).toHaveLength(1);
    // 不带 Cookie（omit）→ 服务端没有会话可认 → 按 Bearer key 鉴权并归因到 key。
    expect(sent[0]?.credentials).toBe("omit");
    expect(sent[0]?.headers.authorization).toBe("Bearer zc-a1-full-secret");
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();
  });

  it("keeps the panel session's chat requests on the same-origin cookie", async () => {
    const harness = await mountChat(statePayload());
    const stream = createStream();
    harness.chat.body = stream.stream;

    // 会话模式（默认）：不带 credentials 字段——fetch 默认 same-origin，Cookie
    // 照旧随请求走，用量归因到面板会话（apiKeyId 空串）。
    harness.type(harness.role("chat-input"), "hello");
    harness.key("Enter");
    await harness.settle();

    expect(completions(harness)[0]?.credentials).toBeUndefined();
    expect(completions(harness)[0]?.headers.authorization).toBeUndefined();
    // omit 只属于 key 模式的聊天请求：面板的其它请求（/api/state 的 same-origin、
    // /v1/models 等）一个都不带它。
    expect(harness.calls.every((call) => call.credentials !== "omit")).toBe(true);
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();
  });

  it("keeps /v1/models riding the cookie even in key mode", async () => {
    const harness = await mountChat(statePayload(), { apiKeys: keyRows });
    harness.change(harness.role("chat-key-select"), "key-a");
    await harness.settle();

    // 选 key 触发的重拉还是老形状：带 Authorization 但不带 omit——它不涉归因。
    const models = harness.calls.filter((call) => call.url === "/v1/models");
    expect(models.length).toBeGreaterThan(0);
    expect(models.at(-1)?.headers.authorization).toBe("Bearer zc-a1-full-secret");
    expect(models.at(-1)?.credentials).toBeUndefined();
  });

  it("keeps the 401 paste-row downgrade working when a key-mode request is rejected", async () => {
    const harness = await mountChat(statePayload(), { apiKeys: keyRows });
    // 选已管理的 key（secret 直接发）；401 后粘贴行仍作为兑底请回来，
    // 兑底固定落在「手动输入」，不点名某把 key。
    harness.change(harness.role("chat-key-select"), "key-a");
    await harness.settle();
    harness.chat.status = 401;
    harness.type(harness.role("chat-input"), "hello");
    harness.key("Enter");
    await harness.settle();

    expect(completions(harness)[0]?.credentials).toBe("omit");
    expect(harness.role("chat-error-text")?.textContent).toContain("代理要求 API key");
    expect(harness.role("chat-key-manual")?.hasAttribute("hidden")).toBe(false);

    // 贴上有效 key 重发：还是 omit（仍像外部客户端那样发），这次被接受。
    harness.chat.status = 200;
    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-key"), "zc-a1-fresh");
    harness.click(harness.role("chat-key-apply"));
    await harness.settle();
    harness.key("Enter");
    await harness.settle();

    const sent = completions(harness);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.credentials).toBe("omit");
    expect(sent[1]?.headers.authorization).toBe("Bearer zc-a1-fresh");
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();
  });
});

/* ------------------------------------------------------------------------- */
/* 聊天附件：图片 / 文件上传、预览条、IndexedDB 存储、能力提示、请求体         */
/* ------------------------------------------------------------------------- */

describe("chat attachments — composer and preview strip", () => {
  it("attaches an image, shows it in the preview strip and drops it on remove", async () => {
    const harness = await mountChat(statePayload());
    expect(harness.role("chat-previews")?.hasAttribute("hidden")).toBe(true);

    await attachFiles(harness, [imageFile(harness.win, "shot.png")]);
    const chips = previewChips(harness);
    expect(chips).toHaveLength(1);
    expect(chips[0]?.title).toBe("shot.png");
    expect(harness.role("chat-previews")?.hasAttribute("hidden")).toBe(false);
    // 图片进了存储层（假 idb 的仓里有一条 blob）。
    expect(fakeDb.store.size).toBe(1);

    // 单张删除：芯片消失，blob 一并清掉（此刻没有任何消息引用它）。
    const remove = chips[0]?.querySelector(".chat__preview-remove") ?? null;
    harness.click(remove);
    await harness.settle();
    expect(previewChips(harness)).toHaveLength(0);
    expect(harness.role("chat-previews")?.hasAttribute("hidden")).toBe(true);
    expect(fakeDb.store.size).toBe(0);
  });

  it("routes by type: text files become chips, binaries are rejected with a banner", async () => {
    const harness = await mountChat(statePayload());

    await attachFiles(harness, [textFile(harness.win, "notes.md", "# 标题\n内容")]);
    expect(previewChips(harness)).toHaveLength(1);
    expect(fakeDb.store.size).toBe(0); // 文本不走图片存储

    await attachFiles(harness, [imageFile(harness.win, "evidence.bin", 64)]);
    // .bin 扩展名 + image/* 类型仍按 mime 认成图片——分类是 mime 优先。
    expect(previewChips(harness)).toHaveLength(2);
  });

  it("rejects a non-image non-text file with an explicit unsupported banner", async () => {
    const harness = await mountChat(statePayload());

    await attachFiles(harness, [new harness.win.File([new Uint8Array([0, 1, 2, 3])], "blob.bin", { type: "application/octet-stream" })]);
    expect(previewChips(harness)).toHaveLength(0);
    expect(harness.role("chat-error")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("chat-error-text")?.textContent).toContain("blob.bin");
    expect(harness.role("chat-error-text")?.textContent).toContain("不支持");
  });

  it("enforces the per-message attachment cap", async () => {
    const harness = await mountChat(statePayload());
    const files: WinFile[] = [];
    for (let i = 0; i < 9; i++) files.push(textFile(harness.win, `f${i}.txt`, "x"));
    await attachFiles(harness, files);
    expect(previewChips(harness)).toHaveLength(8);
    expect(harness.role("chat-error-text")?.textContent).toContain("8");
  });
});

describe("chat attachments — send with images", () => {
  it("sends the image as an OpenAI image_url part and keeps base64 out of localStorage", async () => {
    const harness = await mountChat(statePayload());
    await attachFiles(harness, [imageFile(harness.win, "shot.png")]);

    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-input"), "看这张图");
    harness.key("Enter");
    await harness.settle();
    await harness.settle();
    stream.push(frame("看到了"));
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();

    // 请求体：文本块在前，image_url 块在后（data URL 来自 idb 里的 blob）。
    const messages = lastMessages(harness);
    expect(messages).toHaveLength(1);
    const parts = messages[0]?.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts[0]?.type).toBe("text");
    expect(parts[0]?.text).toBe("看这张图");
    expect(parts[1]?.type).toBe("image_url");
    expect(parts[1]?.image_url?.url).toMatch(/^data:image\/png;base64,/);

    // 存储护栏：消息里只有引用 + 缩略图（happy-dom 无画布 → thumb 为 null），
    // 整张图的 base64 绝不进 localStorage。
    const raw = harness.win.localStorage.getItem("zcode-chat-sessions") ?? "";
    const stored = JSON.parse(raw).sessions[0].messages[0];
    expect(stored.content).toBe("看这张图");
    expect(stored.attachments).toHaveLength(1);
    expect(stored.attachments[0].kind).toBe("image");
    expect(stored.attachments[0].id).toMatch(/^img/);
    expect(stored.attachments[0].thumb).toBeNull();
    expect(raw).not.toContain("base64");

    // 预览条清空；气泡里带图片芯片。
    expect(previewChips(harness)).toHaveLength(0);
    const media = nodes(harness.role("chat-log"), ".chat__msg-media");
    expect(media).toHaveLength(1);
    expect(nodes(media[0], "a.chat__msg-imglink")).toHaveLength(1);
  });

  it("re-sends the image on the next turn by rebuilding the content array from refs", async () => {
    const harness = await mountChat(statePayload());
    await attachFiles(harness, [imageFile(harness.win, "shot.png")]);
    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-input"), "first");
    harness.key("Enter");
    await harness.settle();
    await harness.settle();
    stream.push(frame("ok"));
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();

    // 第二轮纯文本追问：历史里带图的那条仍按引用重建（无状态协议全量重发）。
    const second = createStream();
    harness.chat.body = second.stream;
    harness.type(harness.role("chat-input"), "放大一点");
    harness.key("Enter");
    await harness.settle();
    await harness.settle();
    second.push("data: [DONE]\n\n");
    second.close();
    await harness.settle();

    const messages = lastMessages(harness);
    expect(messages).toHaveLength(3);
    const firstParts = messages[0]?.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(Array.isArray(firstParts)).toBe(true);
    expect(firstParts.some((part) => part.type === "image_url")).toBe(true);
    expect(messages[1]?.content).toBe("ok");
    expect(messages[2]?.content).toBe("放大一点");
  });

  it("restores the attachments to the preview strip when the send is rolled back", async () => {
    const harness = await mountChat(statePayload());
    await attachFiles(harness, [imageFile(harness.win, "shot.png")]);
    harness.chat.status = 502;
    harness.type(harness.role("chat-input"), "注定失败");
    harness.key("Enter");
    await harness.settle();
    await harness.settle();

    // 撤回：气泡删掉、正文与附件都回到输入区；blob 不删（引用还在预览条手里）。
    expect(harness.role("chat-input")?.value).toBe("注定失败");
    expect(previewChips(harness)).toHaveLength(1);
    expect(fakeDb.store.size).toBe(1);
    expect(storedSessions(harness)[0]?.messages).toHaveLength(0);

    // 改好了重发：同一张图（同一 id）随新消息再走一遍。
    harness.chat.status = 200;
    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.key("Enter");
    await harness.settle();
    await harness.settle();
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();
    const parts = lastMessages(harness)[0]?.content as Array<{ type: string }>;
    expect(parts.some((part) => part.type === "image_url")).toBe(true);
  });
});

describe("chat attachments — files, vision banner and idb", () => {
  it("injects a text file's content into the message with the [文件: name] annotation", async () => {
    const harness = await mountChat(statePayload());
    await attachFiles(harness, [textFile(harness.win, "foo.ts", "const a = 1;")]);

    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-input"), "看看这个文件");
    harness.key("Enter");
    await harness.settle();
    await harness.settle();
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();

    const messages = lastMessages(harness);
    const parts = messages[0]?.content as Array<{ type: string; text?: string }>;
    expect(parts[0]?.type).toBe("text");
    expect(parts[0]?.text).toBe("看看这个文件\n\n[文件: foo.ts]\nconst a = 1;");

    // 存的是文本（文本正文的口径，进 localStorage）；气泡里是文件芯片。
    const stored = storedSessionAt(harness, 0, 0) as { attachments?: Array<Record<string, unknown>> } | undefined;
    expect(stored?.attachments?.[0]).toEqual({ kind: "file", name: "foo.ts", text: "const a = 1;" });
    const chips = nodes(harness.role("chat-log"), ".chat__filechip");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toContain("foo.ts");
  });

  it("blocks sending with a banner when the chosen model is known text-only", async () => {
    const harness = await mountChat(statePayload({}), {
      models: { status: 200, ids: ["glm-5.3", "glm-5.3-flash"], visionIds: ["glm-5.3-flash"] },
    });
    await attachFiles(harness, [imageFile(harness.win, "shot.png")]);
    harness.change(harness.role("chat-model"), "glm-5.3");

    harness.type(harness.role("chat-input"), "看图");
    harness.key("Enter");
    await harness.settle();

    // 提示横幅 + 不发。
    expect(completions(harness)).toHaveLength(0);
    expect(harness.role("chat-notice")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("chat-notice-text")?.textContent).toContain("glm-5.3");
    expect(harness.role("chat-notice-text")?.textContent).toContain("不支持图片");

    // 切到视觉模型：同一张图照常发送。
    harness.change(harness.role("chat-model"), "glm-5.3-flash");
    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.key("Enter");
    await harness.settle();
    await harness.settle();
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();
    expect(completions(harness)).toHaveLength(1);
  });

  it("fails open when no model is chosen and none is advertised", async () => {
    const harness = await mountChat(statePayload());
    await attachFiles(harness, [imageFile(harness.win, "shot.png")]);

    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-input"), "看图");
    harness.key("Enter");
    await harness.settle();
    await harness.settle();
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();

    // 模型空选择 + 无 default_model 广告：未知 → 放行（目录内文本模型的拦截只在已知时发生）。
    expect(completions(harness)).toHaveLength(1);
  });

  it("blocks on the advertised default model when the picker is left empty", async () => {
    const harness = await mountChat(statePayload(), {
      models: { status: 200, ids: ["glm-5.3"], defaultModel: "glm-5.3" },
    });
    await attachFiles(harness, [imageFile(harness.win, "shot.png")]);

    harness.type(harness.role("chat-input"), "看图");
    harness.key("Enter");
    await harness.settle();

    // 空选择 = 服务端默认（广告值 glm-5.3，已知文本）：同样拦。
    expect(completions(harness)).toHaveLength(0);
    expect(harness.role("chat-notice-text")?.textContent).toContain("glm-5.3");
  });

  it("survives a reload: image refs come back and the blob is served from idb again", async () => {
    const first = await mountChat(statePayload());
    await attachFiles(first, [imageFile(first.win, "shot.png")]);
    const stream = createStream();
    first.chat.body = stream.stream;
    first.type(first.role("chat-input"), "persist");
    first.key("Enter");
    await first.settle();
    await first.settle();
    stream.push("data: [DONE]\n\n");
    stream.close();
    await first.settle();
    const raw = first.win.localStorage.getItem("zcode-chat-sessions") ?? "";
    const storedId = ((JSON.parse(raw) as { sessions?: Array<{ messages?: Array<{ attachments?: Array<{ id?: string }> }> }> }).sessions?.[0]?.messages?.[0]?.attachments?.[0]?.id) ?? "";
    expect(storedId).toMatch(/^img/);
    expect(fakeDb.store.has(storedId)).toBe(true);

    // 第二个「页面」（刷新语义）：同一份 localStorage + 同一个假 idb。
    const second = await mountSettled("/", statePayload());
    second.win.localStorage.setItem("zcode-chat-sessions", raw);
    second.click(second.find('[data-nav="chat"]'));
    await second.settle();
    await second.settle();

    // 气泡恢复（附件区在）；孤儿剪除没有把还被引用的图删掉。
    expect(nodes(second.role("chat-log"), ".chat__msg-media")).toHaveLength(1);
    expect(fakeDb.store.has(storedId)).toBe(true);
  });

  it("prunes orphan blobs on entry and removes a deleted session's images", async () => {
    // 孤儿：直接往假 idb 塞一条没有任何会话引用的 blob。
    fakeDb.store.set("img-orphan", new Blob(["x"]));
    const harness = await mountChat(statePayload());
    await attachFiles(harness, [imageFile(harness.win, "shot.png")]);
    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-input"), "keep");
    harness.key("Enter");
    await harness.settle();
    await harness.settle();
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();
    expect(fakeDb.store.size).toBe(1); // 孤儿已在进视图时被剪掉

    // 删除会话：会话里的图在撤销窗口**关闭之后**才随会话一起清理（窗口内
    // 还要能撤销，先剪图会让撤销回来的消息只剩「图片已不在」的占位）。
    harness.click(harness.role("chat-new"));
    await harness.settle();
    const keepItem = sessionItems(harness).find(
      (item) => item.querySelector(".chat__session-title")?.textContent === "keep",
    );
    /* 撤销窗口缩短到 400ms：窗口内那个「图还没被剪」的断言需要窗口至少活得比
       一次 settle 久（20ms 会与调度抢时间），而 400ms 仍远小于 5s。 */
    (harness.win as unknown as { __zcodeApp: { const: { CHAT_UNDO_MS: number } } }).__zcodeApp.const.CHAT_UNDO_MS = 400;
    const deleteButton = keepItem ? nodes(keepItem, ".chat__session-delete")[0] ?? null : null;
    harness.click(deleteButton);
    await harness.settle();
    // 窗口内：会话已从列表消失，图还在（能撤销）。
    expect(fakeDb.store.size).toBe(1);
    await waitFor(() => fakeDb.store.size === 0, "the undo window closes and the image is pruned");
  });

  it("degrades to page-lifetime memory when IndexedDB is unavailable", async () => {
    // noIndexedDB 挂载：window 没有 indexedDB（隐私模式的同形环境）→ 附件模块
    // 走内存降级。模块的降级标志在首个 idb 操作时定型，所以必须在进视图之前
    // 就决定环境，不能事后换掉 indexedDB（模块已缓存连接）。
    const harness = await mountChat(statePayload(), { noIndexedDB: true });

    await attachFiles(harness, [imageFile(harness.win, "shot.png")]);
    expect(previewChips(harness)).toHaveLength(1);
    // 降级提示一次；blob 不在假 idb 里（在内存桶里）。
    expect(harness.role("chat-notice")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("chat-notice-text")?.textContent).toContain("仅当前页面有效");

    // 发送照常：内存桶里的 blob 照样能转 data URL。
    const stream = createStream();
    harness.chat.body = stream.stream;
    harness.type(harness.role("chat-input"), "see this");
    harness.key("Enter");
    await harness.settle();
    await harness.settle();
    stream.push("data: [DONE]\n\n");
    stream.close();
    await harness.settle();
    const parts = lastMessages(harness)[0]?.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.some((part) => part.type === "image_url")).toBe(true);
  });
});

describe("chat view entry", () => {
  it("switches to the chat view from the sidebar button, without navigation or a new tab", async () => {
    const harness = await mountSettled("/", statePayload());

    // 顶栏不设 `target="_blank"` 的外链，也没有第二个聊天入口，
    // 聊天只在侧边栏（视图切换按钮）。
    const item = harness.find('[data-nav="chat"]');
    expect(item?.tagName).toBe("BUTTON");
    expect(item?.getAttribute("data-action")).toBe("show-chat");
    expect(item?.getAttribute("href")).toBeNull();
    expect(item?.getAttribute("target")).toBeNull();
    // 顶栏里没有任何聊天入口。
    const appbar = harness.win.document.querySelector(".appbar") as unknown as PageNode;
    expect(appbar.querySelector('[data-nav="chat"]')).toBeNull();

    harness.click(harness.find('[data-nav="chat"]'));
    await harness.settle();

    // 地址不变（没有 hash 路由就不引入），切的是容器与侧边栏选中态。
    expect(harness.win.location.pathname).toBe("/");
    expect(harness.find('[data-view="chat"]')?.hasAttribute("hidden")).toBe(false);
    expect(harness.find('[data-view="overview"]')?.hasAttribute("hidden")).toBe(true);
    expect(harness.find('[data-nav="chat"]')?.className).toContain("nav--active");
    expect(harness.find('[data-nav="overview"]')?.className).not.toContain("nav--active");
  });

  it("returns to the previous view on browser back, and forward returns to chat", async () => {
    const harness = await mountSettled("/", statePayload());
    harness.click(harness.find('[data-nav="chat"]'));
    await harness.settle();
    expect(harness.find('[data-view="chat"]')?.hasAttribute("hidden")).toBe(false);

    await harness.win.history.back();
    await harness.settle();
    expect(harness.find('[data-view="overview"]')?.hasAttribute("hidden")).toBe(false);
    expect(harness.find('[data-view="chat"]')?.hasAttribute("hidden")).toBe(true);

    await harness.win.history.forward();
    await harness.settle();
    expect(harness.find('[data-view="chat"]')?.hasAttribute("hidden")).toBe(false);
  });

  it("makes no chat requests until the view is entered, then lands on the empty choices", async () => {
    const harness = await mountSettled("/", statePayload());
    // 进视图之前不发任何聊天请求：模型列表是进视图才读的。
    expect(harness.calls.filter((call) => call.url === "/v1/models")).toHaveLength(0);

    harness.click(harness.find('[data-nav="chat"]'));
    await harness.settle();

    // 首拍：模型清单 + key 清单；没有会话探针（probeSession 已移除）。
    expect(harness.calls.filter((call) => call.url === "/v1/models")).toHaveLength(1);
    expect(
      harness.calls.some((call) => call.url === "/api/control" && (call.body as { cmd?: string })?.cmd === "listApiKeys"),
    ).toBe(true);
    expect(harness.calls.filter((call) => call.url === "/api/session")).toHaveLength(1);
    // 四个下拉都落在「空选择」：自动调度 / 按策略 / 服务端默认 / 面板会话。
    expect(harness.role("chat-account")?.value).toBe("");
    expect(harness.role("chat-route")?.value).toBe("");
    expect(harness.role("chat-model")?.value).toBe("");
    expect(harness.role("chat-key-select")?.value).toBe("");
  });

  it("keeps the chat requests away until the view is entered", async () => {
    const harness = await mountSettled("/", statePayload());
    expect(harness.calls.some((call) => call.url === "/api/session")).toBe(true);
    expect(harness.calls.some((call) => call.url === "/v1/models")).toBe(false);
  });
});
