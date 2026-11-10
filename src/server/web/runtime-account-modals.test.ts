/**
 * 账号页的模态与抽屉：新增账号 / 登录模态 / 导入导出 / 账号抽屉的
 * claim 区。
 *
 * 脚手架见 `runtime-harness.ts`。
 */

import { describe, expect, it } from "bun:test";
import { installHarnessHooks, account, claimOverview, commands, mountSettled, nodes, openDetail, quota, statePayload } from "./runtime-harness.js";
import type { ControlReply, Harness, PageNode } from "./runtime-harness.js";

installHarnessHooks();

/** 登录授权页（同样拼出来：`src/server/web/` 的「无外部引用」自查只该命中真外链）。*/
const ZAI_AUTHORIZE_URL = ["https:", "", "zcode.z.ai", "oauth/cli/authorize?flow=1"].join("/");

const BIGMODEL_AUTHORIZE_URL = ["https:", "", "bigmodel.cn", "login?flow=1"].join("/");

/**
 * 真实的授权链接长度：`/oauth/cli/init` 回的地址再追上 `redirect_uri` 中转参数后是
 * 269 字节。二维码编码器只支持到版本 10（213 字节）时，这张码画不出来——模态里
 * 只剩下一个白底圆角空框。这里保留一个同量级的长地址作为固定样本。
 */
const LONG_AUTHORIZE_URL =
  "https://chat.z.ai/api/oauth/authorize?client_id=client_P8X5CMWmlaRO9gyO-KSqtg" +
  "&redirect_uri=https%3A%2F%2Fzcode.z.ai%2Fapp%2Foauth%2Flogin%3Fredirect%3Dzcode%253A%252F%252Foauth%252Fcallback%26app_version%3D4.8.8" +
  "&state=6167ab026ede8f0d8bbc6b92c872f24f&response_type=code";

/** 超过编码器上限（版本 15 / 412 字节）的地址：二维码只能画不出来。*/
const OVERLONG_AUTHORIZE_URL = ["https:", "", "zcode.z.ai", "oauth/cli/authorize?" + "x".repeat(500)].join("/");

/** 一个必须被拒绝的授权地址（不是 http/https）。*/
const UNSAFE_AUTHORIZE_URL = ["javascript:", "alert(1)"].join("");

/* ------------------------------------------------------------------------- */
/* 添加账号（四个 tab）                                                        */
/* ------------------------------------------------------------------------- */

describe("add account modal", () => {
  /* 工具栏那个「添加账号」（它不指定 tab，落在默认的登录 tab）。右上角两粒
     「登录 zai / bigmodel」也带 `data-action="open-add"` 但带 `data-add-provider`，
     所以这里用 `:not([data-add-provider])` 取到工具栏那一粒。 */
  function openAdd(harness: Harness): void {
    harness.click(harness.find('[data-action="open-add"]:not([data-add-provider])'));
  }

  /** 已发出的控制命令体（按顺序）。*/
  function bodies(harness: Harness): unknown[] {
    return commands(harness).map((call) => call.body);
  }

  /** 只取 `addAccount` 的那几条：打开模态本身可能先发一条 `startOAuth`（登录是默认 tab）。*/
  function addAccountBodies(harness: Harness): unknown[] {
    return bodies(harness).filter((body) => (body as { cmd?: string }).cmd === "addAccount");
  }

  it("shows the scrim while open and hides it again on close", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    /* scrim 只有 data-role 没有 id：视图层必须用 byRole 取到它，不然遮罩永不
       出现、点外也关不掉（UI 审查 #1，与另外三个模态对齐）。*/
    openAdd(harness);
    expect(harness.role("add-modal")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("add-modal-scrim")?.hasAttribute("hidden")).toBe(false);

    harness.click(harness.find('[data-action="close-add"]'));
    expect(harness.role("add-modal")?.hasAttribute("hidden")).toBe(true);
    expect(harness.role("add-modal-scrim")?.hasAttribute("hidden")).toBe(true);
  });

  it("puts focus inside the dialog, traps Tab and closes on Esc back to the opener", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    const opener = harness.find('[data-action="open-add"]:not([data-add-provider])') as PageNode;
    (opener as unknown as { focus(): void }).focus();
    harness.click(opener);

    const modal = harness.role("add-modal") as unknown as { contains(node: unknown): boolean };
    expect(modal.contains(harness.win.document.activeElement)).toBe(true);
    /* 默认落在登录 tab：焦点给窗里第一个可 Tab 的元素（「登录」那颗 tab）。
       点名的「账号名」只在这两个导入 tab 上可见，登录 tab 下它 `hidden`，
       聚焦它什么也不会发生，所以 dialog 层会跳过并退回第一个可聚焦元素。 */
    /* `[data-add-tab="login"]` 在页面上有两处（空态的「登录」按钮与模态里的
       tab），这里取模态里的那一颗。 */
    const firstTab = nodes(harness.role("add-modal"), "[data-add-tab]")[0];
    const activeAfterOpen = harness.win.document.activeElement;
    expect(activeAfterOpen === (firstTab as unknown)).toBe(true);

    // 切到「粘贴 JWT」：焦点不跟着跳（切 tab 是用户自己的动作），但仍在窗内。
    harness.click(harness.find('[data-add-tab="jwt"]'));
    expect(modal.contains(harness.win.document.activeElement)).toBe(true);

    // 背景（壳）退出 tab 序，窗内最后一个控件按 Tab 绕回第一个。
    const page = harness.win.document.querySelector(".app") as unknown as { hasAttribute(name: string): boolean };
    expect(page.hasAttribute("inert")).toBe(true);

    harness.win.document.dispatchEvent(new harness.win.KeyboardEvent("keydown", { key: "Escape" }));
    expect(harness.role("add-modal")?.hasAttribute("hidden")).toBe(true);
    expect(page.hasAttribute("inert")).toBe(false);
    expect(harness.win.document.activeElement === (opener as unknown)).toBe(true);
  });

  it("keeps Tab inside the add-account dialog (first and last wrap)", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    openAdd(harness);

    const dialog = (harness.win as unknown as { __zcodeApp: { widgets: { dialog: { tabbables(root: unknown): unknown[] } } } })
      .__zcodeApp.widgets.dialog;
    const modal = harness.role("add-modal");
    const list = dialog.tabbables(harness.role("add-modal"));
    expect(list.length).toBeGreaterThan(1);
    const last = list[list.length - 1] as unknown as { focus(): void; dispatchEvent(event: unknown): boolean };
    const first = list[0] as unknown as { dispatchEvent(event: unknown): boolean };
    last.focus();
    const forward = new harness.win.KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    last.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(harness.win.document.activeElement === (first as unknown)).toBe(true);
    expect(modal).not.toBeNull();
  });

  it("disables the submit button while addAccount is in flight", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    openAdd(harness);
    harness.click(harness.find('[data-add-tab="jwt"]'));
    harness.change(harness.role("add-label"), "new-account");
    harness.change(harness.role("add-jwt"), "a.b.c");

    /* 拦住这条控制请求：按钮在「飞着」的那一刻应该已经禁用。计数放在这一层
       而不是命令记录上——被拦下的请求还没走到桩里，`harness.calls` 里看不到它。 */
    let release: (() => void) | undefined;
    let inFlight = 0;
    const realFetch = harness.win.fetch;
    (harness.win as unknown as { fetch: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }) => {
      if (url === "/api/control" && init?.body && (JSON.parse(init.body) as { cmd?: string }).cmd === "addAccount") {
        inFlight += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return realFetch(url, init as never);
    };

    harness.click(harness.role("submit-add"));
    await harness.settle();
    expect(inFlight).toBe(1);
    expect(harness.role("submit-add")?.disabled).toBe(true);

    // 再点一次也不会发第二条命令（按钮已禁用）。
    harness.click(harness.role("submit-add"));
    await harness.settle();
    expect(inFlight).toBe(1);

    release?.();
    await harness.settle();
    expect(addAccountBodies(harness)).toHaveLength(1);
    expect(harness.role("add-modal")?.hasAttribute("hidden")).toBe(true);
  });

  it("opens on the requested tab and switches panels", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    /* tab 条的第一位是登录，也是默认 tab；file / upload 合并成「导入凭据」，
       所以只有三个 tab（模态里）。*/
    const tabStrip = nodes(harness.role("add-modal"), "[data-add-tab]");
    expect(tabStrip.map((node) => node.getAttribute("data-add-tab"))).toEqual([
      "login",
      "credential",
      "jwt",
    ]);

    openAdd(harness);
    expect(harness.role("add-modal")?.hasAttribute("hidden")).toBe(false);
    expect(harness.find('[data-add-panel="login"]')?.hasAttribute("hidden")).toBe(false);

    harness.click(harness.find('[data-add-tab="jwt"]'));

    expect(harness.find('[data-add-panel="jwt"]')?.hasAttribute("hidden")).toBe(false);
    expect(harness.find('[data-add-panel="login"]')?.hasAttribute("hidden")).toBe(true);
    expect(harness.find('[data-add-tab="jwt"]')?.className).toContain("tab--active");
  });

  it("sends addAccount with source: jwt, the pasted token and the chosen provider", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    openAdd(harness);
    harness.click(harness.find('[data-add-tab="jwt"]'));
    harness.change(harness.role("add-label"), "new-account");
    harness.change(harness.role("add-jwt"), "a.b.c");
    harness.click(harness.role("submit-add"));
    await harness.settle();

    /* JWT 的 payload 里没有 provider，所以命令里必须带一个。 */
    expect(addAccountBodies(harness)).toEqual([
      {
        cmd: "addAccount",
        label: "new-account",
        source: "jwt",
        jwt: "a.b.c",
        provider: "zai",
      },
    ]);
    expect(harness.role("add-modal")?.hasAttribute("hidden")).toBe(true);
  });

  it("defaults the provider selector to the first account's provider", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({ accounts: [account({ provider: "bigmodel" })] }),
    );
    harness.click(harness.find('[data-action="open-add"]:not([data-add-provider])'));
    harness.click(harness.find('[data-add-tab="jwt"]'));

    const panel = harness.find('[data-add-panel="jwt"]');
    const select = panel?.querySelector('[data-role="add-provider"]');
    expect(select?.value).toBe("bigmodel");
    // 两个取值都是协议名，不翻译。
    expect(nodes(panel, "option").map((option) => option.textContent)).toEqual(["zai", "bigmodel"]);
  });

  it("sends the manually pasted apiKey pair under the file source", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    harness.click(harness.find('[data-add-tab="credential"]'));
    harness.change(harness.role("add-label"), "manual");
    harness.change(harness.role("add-api-key"), "feedfacefeedfacefeedfacefeedface.pair");
    harness.change(harness.role("add-file-path"), "/tmp/credentials.json");
    harness.click(harness.role("submit-add"));
    await harness.settle();

    /* 手工 key 优先于路径：两条路建的是同一个凭据形状。 */
    expect(commands(harness)[0]?.body).toEqual({
      cmd: "addAccount",
      label: "manual",
      source: "file",
      apiKey: "feedfacefeedfacefeedfacefeedface.pair",
      provider: "zai",
    });
  });

  it("keeps the path import free of a provider override", async () => {
    /* 凭据文件自己带 `oauth:active_provider`，页面的选择器只服务于手工 key 与 JWT。 */
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    harness.click(harness.find('[data-add-tab="credential"]'));
    /* 服务端路径是「导入凭据」里的第二个来源（默认是浏览器选文件），先选中它。 */
    harness.change(harness.find("#add-source-server"), "server");
    harness.change(harness.role("add-label"), "from-file");
    harness.change(harness.role("add-file-path"), "/tmp/credentials.json");
    harness.click(harness.role("submit-add"));
    await harness.settle();

    expect(addAccountBodies(harness)).toEqual([
      { cmd: "addAccount", label: "from-file", source: "file", file: "/tmp/credentials.json" },
    ]);
  });

  it("sends source: file with an explicit path when one is typed", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    openAdd(harness);
    harness.click(harness.find('[data-add-tab="credential"]'));
    harness.change(harness.find("#add-source-server"), "server");
    harness.change(harness.role("add-label"), "from-file");
    harness.change(harness.role("add-file-path"), "/tmp/credentials.json");
    harness.click(harness.role("submit-add"));
    await harness.settle();

    expect(addAccountBodies(harness)).toEqual([
      { cmd: "addAccount", label: "from-file", source: "file", file: "/tmp/credentials.json" },
    ]);
  });

  it("omits the path so the server uses its default credential file", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    openAdd(harness);
    harness.click(harness.find('[data-add-tab="credential"]'));
    harness.change(harness.find("#add-source-server"), "server");
    harness.change(harness.role("add-label"), "from-default");
    harness.click(harness.role("submit-add"));
    await harness.settle();

    expect(addAccountBodies(harness)).toEqual([{ cmd: "addAccount", label: "from-default", source: "file" }]);
  });

  it("requires a label before sending anything", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    harness.click(harness.find('[data-add-tab="jwt"]'));
    harness.click(harness.role("submit-add"));
    await harness.settle();

    expect(commands(harness)).toHaveLength(0);
    expect(harness.role("add-error")?.hasAttribute("hidden")).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* 登录模态                                                                   */
/* ------------------------------------------------------------------------- */

describe("login modal", () => {
  /** 流程 id：页面拿它认领轮询应答，不是自己那条就不算。*/
  const FLOW_ID = "flow-1";

  /** 一次流程的 `startOAuth` 应答：授权地址 + 流程 id + 回调端口。*/
  function oauthReply(provider: "zai" | "bigmodel" = "zai"): ControlReply {
    return {
      ok: true,
      event: "oauthUrl",
      authorizeUrl: provider === "zai" ? ZAI_AUTHORIZE_URL : BIGMODEL_AUTHORIZE_URL,
      callbackPort: 51_234,
      flowId: FLOW_ID,
    };
  }

  /**
   * 从工具栏打开模态（默认就落在登录 tab，并已按默认 provider 发起一条流程），
   * 再点一下登录 tab：它已经是选中态，这一下不应该再发一条 `startOAuth`。
   */
  async function openLoginTab(harness: Harness): Promise<void> {
    harness.click(harness.find('[data-action="open-add"]:not([data-add-provider])'));
    harness.click(nodes(harness.role("add-modal"), '[data-add-tab="login"]')[0] as PageNode);
    await harness.settle();
  }

  /** 推一轮假定时器并等这一轮 fetch 链跑完（一次轮询）。*/
  async function pollOnce(harness: Harness): Promise<void> {
    harness.intervals.tick();
    await harness.settle();
  }

  /** 已经发出的 `/api/oauth-status` 次数。*/
  function polls(harness: Harness): number {
    return harness.calls.filter((call) => call.url === "/api/oauth-status").length;
  }

  /** 已发出的控制命令体（按顺序）。*/
  function sent(harness: Harness): unknown[] {
    return commands(harness).map((call) => call.body);
  }

  it("starts OAuth on the login tab and draws the QR code for the authorize URL", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    harness.controlReply = oauthReply();
    await openLoginTab(harness);

    /* 没有账号时默认 zai，于是开 tab 这一下就是发起 `startOAuth`。*/
    expect(sent(harness)).toEqual([{ cmd: "startOAuth", provider: "zai" }]);
    const qr = harness.role("login-qr");
    expect(qr?.hasAttribute("hidden")).toBe(false);
    /* 二维码是 `App.qr.toSvg` 画的 SVG，不是一张图片，也不是纯文本。*/
    expect(qr?.querySelector("svg")).not.toBeNull();
    /* 链接原文不再渲染：可见的只有一句说明 + 「复制链接」。 */
    expect(harness.role("login-link")).toBeNull();
    expect(harness.role("login-link-row")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("login-status")?.textContent).toBe("等待扫码授权…");
    /* 「添加」与账号名只服务于三个导入 tab；登录在建号前没有可填的字段。*/
    expect(harness.role("submit-add")?.hasAttribute("hidden")).toBe(true);
    expect(harness.role("add-label-row")?.hasAttribute("hidden")).toBe(true);
  });

  it("draws the QR code for a realistic (269-byte) authorize URL", async () => {
    /* 空框 bug 回归：真授权链接 269 字节，编码器上限 213 → `encode` 抛错
       → 容器已经摘了 `hidden` 但里面空无一人，用户看到的就是一个空框。*/
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    harness.controlReply = { ...oauthReply(), authorizeUrl: LONG_AUTHORIZE_URL };
    await openLoginTab(harness);

    const qr = harness.role("login-qr");
    expect(qr?.hasAttribute("hidden")).toBe(false);
    expect(qr?.querySelector("svg")).not.toBeNull();
    /* 版本 12 的边长是 17 + 4 × 12 = 65 格，加两侧各 4 格静区。*/
    expect(qr?.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 73 73");
    /* 链接本身照旧可复制、可打开（二维码只是一条路）。*/
    expect(harness.role("login-link")).toBeNull();
    expect(harness.role("login-open")?.hasAttribute("hidden")).toBe(false);
  });

  it("never leaves an empty QR box when the code cannot be drawn", async () => {
    /* 保险丝：即使链接长到编码器装不下（版本 15 = 412 字节），也只损失
       二维码——容器保持 `hidden`（不占位、不显示白底圆角框），授权链接与
       「打开浏览器」仍然可用。*/
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    harness.controlReply = { ...oauthReply(), authorizeUrl: OVERLONG_AUTHORIZE_URL };
    await openLoginTab(harness);

    const qr = harness.role("login-qr");
    expect(qr?.hasAttribute("hidden")).toBe(true);
    expect(qr?.querySelector("svg")).toBeNull();
    expect(harness.role("login-link-row")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("login-link")).toBeNull();
    expect(harness.role("login-open")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("login-status")?.textContent).toBe("等待扫码授权…");
  });

  it("defaults the provider to the first account and restarts the flow on a switch", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({ accounts: [account({ provider: "bigmodel" })] }),
    );
    harness.controlReply = oauthReply("bigmodel");
    await openLoginTab(harness);
    expect(sent(harness)).toEqual([{ cmd: "startOAuth", provider: "bigmodel" }]);

    const buttons = nodes(harness.role("login-providers"), "[data-login-provider]");
    expect(buttons.map((node) => node.textContent?.trim())).toEqual(["zai（国际）", "bigmodel（国内）"]);
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1]?.className).toContain("login-flow__provider--active");

    /* 点另一个 provider 不是「只换个选中态」，而是换一家去授权：旧二维码作废。*/
    harness.controlReply = oauthReply("zai");
    harness.click(buttons[0] as PageNode);
    await harness.settle();
    expect(sent(harness)).toEqual([
      { cmd: "startOAuth", provider: "bigmodel" },
      { cmd: "startOAuth", provider: "zai" },
    ]);
    /* 链接原文不再渲染：可见的只有一句说明 + 「复制链接」。 */
    expect(harness.role("login-link")).toBeNull();
    expect(harness.role("login-link-row")?.hasAttribute("hidden")).toBe(false);
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
  });

  it("closes the modal and refreshes the list when the flow becomes ready", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    harness.controlReply = oauthReply();
    await openLoginTab(harness);
    /* 第一次轮询要等一个间隔（开 tab 那一下就画二维码，不额外发请求）。*/
    expect(polls(harness)).toBe(0);

    harness.state = statePayload({ accounts: [account({ label: "zai-login" })] });
    harness.oauthStatus = { status: "ready", flowId: FLOW_ID, accountLabel: "zai-login" };
    await pollOnce(harness);

    expect(harness.role("add-modal")?.hasAttribute("hidden")).toBe(true);
    expect(harness.role("accounts-notice-text")?.textContent).toBe("账号 zai-login 已添加。");
    /* 列表已经刷新过了：新账号在表里，且不需要再开一次页面。*/
    expect(harness.rows("page-accounts-body")).toHaveLength(1);

    /* 成功即结束：再推一轮定时器不该再发请求，也不该再弹提示。*/
    const afterReady = polls(harness);
    harness.oauthStatus = { status: "pending", flowId: FLOW_ID };
    await pollOnce(harness);
    expect(polls(harness)).toBe(afterReady);
  });

  it("shows the error and keeps retry when the flow fails", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    harness.controlReply = oauthReply();
    await openLoginTab(harness);

    harness.oauthStatus = { status: "failed", flowId: FLOW_ID, error: "no_matching_oauth_flow" };
    await pollOnce(harness);

    expect(harness.role("login-status")?.textContent).toBe("登录失败：没有可用的登录流程。");
    expect(harness.role("login-status")?.className).toContain("login-flow__status--failed");
    expect(harness.role("login-retry")?.hasAttribute("hidden")).toBe(false);
    /* 那张二维码对应的流程已经不在了，擦掉它：扫一张死码只会白等。*/
    expect(harness.role("login-qr")?.hasAttribute("hidden")).toBe(true);

    const stopped = polls(harness);
    await pollOnce(harness);
    expect(polls(harness)).toBe(stopped);

    /* 重试：同一个 provider 重发一条流程，二维码回来。*/
    harness.controlReply = oauthReply();
    harness.click(harness.role("login-retry"));
    await harness.settle();
    expect(sent(harness)).toEqual([
      { cmd: "startOAuth", provider: "zai" },
      { cmd: "startOAuth", provider: "zai" },
    ]);
    expect(harness.role("login-qr")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("login-retry")?.hasAttribute("hidden")).toBe(true);
  });

  it("treats a flow that the server no longer knows as failed", async () => {
    /* `idle`（被第二条流程顶掉、或 5 分钟 TTL 到期）与 `flowId` 对不上是同一件事：
       等的结果不会来了，报失败而不是一直转圈。*/
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    harness.controlReply = oauthReply();
    await openLoginTab(harness);

    harness.oauthStatus = { status: "idle" };
    await pollOnce(harness);

    expect(harness.role("login-status")?.textContent).toBe("登录失败：没有可用的登录流程。");
    expect(harness.role("login-retry")?.hasAttribute("hidden")).toBe(false);
  });

  it("keeps the scan cards inside the path field cell and the path on one clipped line", async () => {
    /* 扫描结果以前是字段行之外的兄弟节点、靠没定义的 `order-item--stack` 占位：
       卡片冲出字段右边界，长路径把行顶宽。现在卡片在「文件路径」那一格内，
       与输入框同一条左边缘；路径一行截断，完整值在 title 上。 */
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    harness.credentialSources = [
      { path: "/Users/me/.zcode/v2/credentials.json", provider: "bigmodel", valid: true },
    ];
    harness.click(harness.find('[data-action="open-add"]'));
    await harness.settle();
    harness.click(harness.find('[data-add-tab="credential"]'));
    harness.change(harness.find("#add-source-server"), "server");
    await harness.settle();

    const cell = harness.find('[data-add-group="server"]');
    expect(cell?.className).toContain("field-cell");
    expect(cell?.querySelector('[data-role="add-file-path"]')).not.toBeNull();
    const card = cell?.querySelector('[data-role="add-sources"] li');
    expect(card).not.toBeNull();
    expect(card?.className).toContain("order-item--stack");
    const name = card?.querySelector(".order-item__name");
    expect(name?.textContent).toBe("/Users/me/.zcode/v2/credentials.json");
    expect(name?.title).toBe("/Users/me/.zcode/v2/credentials.json");
  });

  it("stops polling once the modal is closed", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    harness.controlReply = oauthReply();
    await openLoginTab(harness);
    await pollOnce(harness);
    expect(polls(harness)).toBe(1);

    harness.click(nodes(harness.role("add-modal"), '[data-action="close-add"]')[0] as PageNode);
    expect(harness.role("add-modal")?.hasAttribute("hidden")).toBe(true);

    /* 定时器已经被清掉：推一轮什么也不会发生，更不会因为「刚好成功」弹提示。*/
    harness.oauthStatus = { status: "ready", flowId: FLOW_ID, accountLabel: "too-late" };
    await pollOnce(harness);
    expect(polls(harness)).toBe(1);
    expect(harness.role("accounts-notice")?.hasAttribute("hidden")).toBe(true);
  });

  it("stops polling when the user switches to another tab", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    harness.controlReply = oauthReply();
    await openLoginTab(harness);
    await pollOnce(harness);

    harness.click(nodes(harness.role("add-modal"), '[data-add-tab="credential"]')[0] as PageNode);
    const stopped = polls(harness);
    await pollOnce(harness);
    expect(polls(harness)).toBe(stopped);
    /* 回到导入 tab 就把「添加」与账号名还回来。*/
    expect(harness.role("submit-add")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("add-label-row")?.hasAttribute("hidden")).toBe(false);
  });

  it("opens the authorize page in a new tab from the login panel", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    harness.controlReply = oauthReply();
    await openLoginTab(harness);
    const opened: string[] = [];
    (harness.win as unknown as { open: (url: string) => unknown }).open = (url: string) => {
      opened.push(url);
      return null;
    };

    harness.click(harness.role("login-open"));

    expect(opened).toEqual([ZAI_AUTHORIZE_URL]);
    /* 打开不等于授权完成：轮询还得继续 */
    expect(harness.role("login-status")?.textContent).toBe("等待扫码授权…");
  });

  it("offers a copy path for the authorize link", async () => {    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    harness.controlReply = oauthReply();
    await openLoginTab(harness);

    expect(harness.role("login-copy-hint")?.hasAttribute("hidden")).toBe(true);
    harness.click(nodes(harness.role("add-modal"), '[data-action="login-copy"]')[0] as PageNode);
    await harness.settle();

    /* 有剪贴板就走剪贴板，没有（或用不了）就选中链接让用户按 Ctrl+C：两条路都给
       一句提示，所以这里只断言「提示出现了」，不断言是哪一条。*/
    const hint = harness.role("login-copy-hint");
    expect(hint?.hasAttribute("hidden")).toBe(false);
    expect(hint?.textContent?.length).toBeGreaterThan(0);
  });

  it("copies the full authorize URL while no URL text is on the page", async () => {
    /* 链接原文从 DOM 里消失了，但复制取的是 `loginFlow.authorizeUrl`（JS 里的值），
       所以复制出来的仍是完整地址。 */
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    harness.controlReply = oauthReply();
    await openLoginTab(harness);

    let copied: string | null = null;
    Object.defineProperty(harness.win.navigator, "clipboard", {
      value: { writeText: (text: string) => { copied = text; return Promise.resolve(); } },
      configurable: true,
    });
    const panel = harness.find('[data-add-panel="login"]');
    expect(panel?.textContent ?? "").not.toContain("client_id");

    harness.click(nodes(harness.role("add-modal"), '[data-action="login-copy"]')[0] as PageNode);
    await harness.settle();

    expect(copied as string | null).toBe(ZAI_AUTHORIZE_URL);
    expect(harness.role("login-copy-hint")?.textContent).toBe("链接已复制。");
  });

  it("opens the empty-state login button straight onto the login tab", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [] }));
    harness.controlReply = oauthReply();
    harness.click(nodes(harness.role("page-accounts-empty"), "[data-add-tab]")[0] as PageNode);
    await harness.settle();

    expect(harness.role("add-modal")?.hasAttribute("hidden")).toBe(false);
    expect(harness.find('[data-add-panel="login"]')?.hasAttribute("hidden")).toBe(false);
    expect(sent(harness)).toEqual([{ cmd: "startOAuth", provider: "zai" }]);
  });
});

describe("accounts page — 导入 / 导出（从设置页搬来）", () => {
  /** 给隐藏的 file input 塞一个文件并触发 change（与聊天附件入口同一形态）。*/
  function pickImportFile(harness: Harness, name: string, text: string): void {
    const input = harness.role("accounts-importFile") as unknown as {
      files: unknown;
      dispatchEvent(event: unknown): boolean;
    };
    const dt = new harness.win.DataTransfer();
    dt.items.add(new harness.win.File([text], name, { type: "application/json" }));
    input.files = dt.files;
    input.dispatchEvent(new harness.win.Event("change"));
  }

  it("sends importAccount with the file content and the password", async () => {
    const harness = await mountSettled("/accounts", statePayload());
    harness.controlReply = { ok: true, event: "accountsImported", imported: 2 };

    /* 不填服务端路径——浏览器选文件，内容读进内存随命令发（服务端不碰磁盘）。 */
    pickImportFile(harness, "export.json", '{"accounts":[]}');
    (harness.role("accounts-importPassword") as PageNode).value = "pw";
    harness.click(harness.find('[data-action="accounts-import"]'));
    await harness.settle();

    expect(commands(harness).pop()?.body).toEqual({
      cmd: "importAccount",
      content: '{"accounts":[]}',
      password: "pw",
    });
    // 导入成功是 toast，不写页内横幅
    expect(harness.role("toast-text")?.textContent).toContain("2");
  });

  it("sends a masked export without a password", async () => {
    const harness = await mountSettled("/accounts", statePayload());
    harness.controlReply = { ok: true, event: "accountsExported", format: "masked", count: 3 };

    harness.change(harness.role("accounts-exportFormat"), "masked");
    harness.click(harness.find('[data-action="accounts-export"]'));
    await harness.settle();

    // 内容返回模式（inline: true）+ 浏览器下载；掩码没有文件产物，只报一句数
    expect(commands(harness).pop()?.body).toEqual({ cmd: "exportAccounts", format: "masked", inline: true });
    expect(harness.role("toast-text")?.textContent).toContain("3");
  });

  it("needs a password for an encrypted export", async () => {
    const harness = await mountSettled("/accounts", statePayload());
    harness.click(harness.find('[data-action="accounts-export"]'));
    await harness.settle();

    // 没密码：不发命令，只提示
    expect(commands(harness)).toHaveLength(0);
    expect(harness.role("accounts-error")?.hasAttribute("hidden")).toBe(false);
  });

  it("gates a plaintext export behind typing EXPORT", async () => {
    const harness = await mountSettled("/accounts", statePayload());
    /* 服务端把整份包放进应答（payload + filename），浏览器落下载，不写
       服务端目录——所以回包里是文件名，没有 /tmp 路径。 */
    harness.controlReply = {
      ok: true,
      event: "accountsExported",
      format: "plain",
      count: 1,
      payload: "{\"accounts\":[]}",
      filename: "zcode-accounts-20261109-120000.json",
    };

    harness.change(harness.role("accounts-exportFormat"), "plain");
    harness.click(harness.find('[data-action="accounts-export"]'));
    await harness.settle();

    // 先弹模态要 EXPORT，命令还没发
    expect(harness.role("confirm-modal")?.hasAttribute("hidden")).toBe(false);
    expect(commands(harness)).toHaveLength(0);

    // 输错：不发命令，提示挂在这一页的横幅上
    (harness.role("confirm-input") as PageNode).value = "export";
    harness.click(harness.role("confirm-submit"));
    await harness.settle();
    expect(commands(harness)).toHaveLength(0);
    expect(harness.role("accounts-error-text")?.textContent).toBe("请输入 EXPORT 以确认明文导出。");

    /* 输对：带上 force: true 发出去；应答里的包落成浏览器下载。 */
    const doc = harness.win.document as unknown as {
      createElement: (tag: string) => PageNode;
    };
    const realCreate = doc.createElement.bind(doc);
    const anchors: PageNode[] = [];
    doc.createElement = (tag: string) => {
      const node = realCreate(tag);
      if (tag.toLowerCase() === "a") anchors.push(node);
      return node;
    };
    const urlScope = harness.win.URL as unknown as {
      createObjectURL: (blob: unknown) => string;
      revokeObjectURL: (url: string) => void;
    };
    const realCreateUrl = urlScope.createObjectURL;
    const realRevokeUrl = urlScope.revokeObjectURL;
    const blobs: Array<{ text(): Promise<string> }> = [];
    urlScope.createObjectURL = (blob: unknown) => {
      blobs.push(blob as { text(): Promise<string> });
      return "blob:w84-export";
    };
    urlScope.revokeObjectURL = () => {};
    try {
      (harness.role("confirm-input") as PageNode).value = "EXPORT";
      harness.click(harness.role("confirm-submit"));
      await harness.settle();
    } finally {
      urlScope.createObjectURL = realCreateUrl;
      urlScope.revokeObjectURL = realRevokeUrl;
      doc.createElement = realCreate;
    }
    expect(commands(harness).pop()?.body).toEqual({
      cmd: "exportAccounts",
      format: "plain",
      inline: true,
      force: true,
    });
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute("download")).toBe("zcode-accounts-20261109-120000.json");
    expect(anchors[0].getAttribute("href")).toBe("blob:w84-export");
    expect(JSON.parse(await blobs[0].text())).toEqual({ accounts: [] });
    expect(harness.role("toast-text")?.textContent).toContain("zcode-accounts-20261109-120000.json");
  });
});

describe("accounts page — login（从设置页搬来）", () => {
  /** `window.open` 的桩：记录被打开的地址。*/
  function recordOpens(harness: Harness): string[] {
    const opened: string[] = [];
    (harness.win as unknown as { open: (url: string) => unknown }).open = (url: string) => {
      opened.push(url);
      return null;
    };
    return opened;
  }

  /**
   * 右上角只剩「出口代理 / 添加账号」：两粒登录快捷按钮已删。添加账号默认落在
   * 登录 tab，服务商按当前账号预选（`openAddModal` 的默认 provider 逻辑）。
   */
  it("opens the add modal on the login tab with the account's provider preselected", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account({ provider: "zai" })] }));
    harness.controlReply = { ok: true, event: "oauthUrl", authorizeUrl: ZAI_AUTHORIZE_URL, flowId: "flow-1" };

    harness.click(harness.find('[data-action="open-add"]'));
    await harness.settle();

    expect(harness.role("add-modal")?.hasAttribute("hidden")).toBe(false);
    expect(harness.find('[data-add-panel="login"]')?.hasAttribute("hidden")).toBe(false);
    /* 预选就是「现在就按这一家发起」：不用再点一次 provider。*/
    expect(commands(harness).map((call) => call.body)).toEqual([{ cmd: "startOAuth", provider: "zai" }]);
    const buttons = nodes(harness.role("login-providers"), "[data-login-provider]");
    expect(buttons.map((node) => node.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    /* 二维码当场就画出来：真授权链接 269 字节，编码器装不下时只剩空框。*/
    expect(harness.role("login-qr")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("login-qr")?.querySelector("svg")).not.toBeNull();
  });

  it("refuses to open a non-http authorization url", async () => {
    const harness = await mountSettled("/accounts", statePayload());
    const opened = recordOpens(harness);
    harness.controlReply = { ok: true, event: "oauthUrl", authorizeUrl: UNSAFE_AUTHORIZE_URL, flowId: "flow-1" };

    /* 现在开新标签页的唯一入口是登录面板里那颗「打开浏览器」。*/
    harness.click(harness.find('[data-action="open-add"]'));
    await harness.settle();
    harness.click(harness.role("login-open"));

    expect(opened).toEqual([]);
    expect(harness.role("login-status")?.textContent).toBe("登录失败：上游没有给出可打开的授权地址。");
  });
});

const CLAIM_NOW_SECONDS = Math.floor(Date.now() / 1000);

/** 一条发现层活动；字段全是可投影的通用事实。*/
function claimPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planId: "weekend-1",
    name: "ZCode Weekend Build",
    description: "周末体验包",
    priority: 9,
    entitlements: [
      {
        entitlementId: "e1",
        showName: "GLM-5.3-Flash",
        meter: "tokens",
        unitType: "token",
        capabilities: [],
        grantUnits: 500_000_000,
        period: "one_time",
        priority: 1,
      },
    ],
    startsAt: CLAIM_NOW_SECONDS - 3600,
    endsAt: CLAIM_NOW_SECONDS + 3600,
    effectiveAt: CLAIM_NOW_SECONDS + 1800,
    source: "marketing/touch",
    ...overrides,
  };
}

function claimPlansReply(plans: Record<string, unknown>[] = [claimPlan()]): ControlReply {
  return {
    ok: true,
    event: "claimPlans",
    label: "work-team",
    plans,
  } as unknown as ControlReply;
}

/** 当前详情窗里按状态分好组的活动行。*/
function claimRows(harness: Harness): PageNode[] {
  return [...(harness.role("account-dialog-body")?.querySelectorAll(".detail__plan[data-claim-state]") ?? [])];
}

function claimButtonOf(row: PageNode | undefined): PageNode | undefined {
  return row?.querySelector(".detail__plan-actions button") ?? undefined;
}

describe("accounts drawer — claim section", () => {
  const mountClaim = async (plans: Record<string, unknown>[] = [claimPlan()], claim = claimOverview()) => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account()], claim }));
    harness.controlReplies = [claimPlansReply(plans)];
    openDetail(harness);
    await harness.settle();
    return harness;
  };

  it("hides the claim section when the state payload has no claim segment", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account()] }));
    openDetail(harness);
    expect(harness.role("account-dialog-body")?.textContent).not.toContain("抢活动");
  });

  it("hides the claim section for accounts without claim capability", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({ accounts: [account()], claim: claimOverview({ accounts: [{ label: "other-account", running: true, holdUntil: 0 }] }) }),
    );
    openDetail(harness);
    expect(harness.role("account-dialog-body")?.textContent).not.toContain("抢活动");
  });

  it("fetches the plan list once on drawer open and renders it (never on poll)", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({ accounts: [account()], claim: claimOverview() }),
    );
    // 打开抽屉 → previewClaimPlans 一次（应答不带 plans 的裸 ok 也不崩渲染）。
    openDetail(harness);
    await harness.settle();
    const commands = harness.calls.filter((call) => call.url === "/api/control").map((call) => (call.body as { cmd?: string }).cmd);
    expect(commands.filter((cmd) => cmd === "previewClaimPlans")).toHaveLength(1);
    expect(harness.role("account-dialog-body")?.textContent).toContain("当前没有可领的活动");

    // 轮询重画（syncDrawer）不再拉列表：refresh 不增加 preview 调用。
    await harness.refresh();
    await harness.settle();
    const after = harness.calls.filter((call) => call.url === "/api/control").map((call) => (call.body as { cmd?: string }).cmd);
    expect(after.filter((cmd) => cmd === "previewClaimPlans")).toHaveLength(1);
  });

  it("shows the running status line and switches to manual mode when auto is off", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({ accounts: [account()], claim: claimOverview() }),
    );
    openDetail(harness);
    await harness.settle();
    expect(harness.role("account-dialog-body")?.textContent).toContain("自动领取中");
    harness.close();

    const manual = await mountSettled(
      "/accounts",
      statePayload({ accounts: [account()], claim: claimOverview({ auto: false }) }),
    );
    openDetail(manual);
    await manual.settle();
    expect(manual.role("account-dialog-body")?.textContent).toContain("手动模式");
  });

  it("shows the hold status with reason (claimed hold → 已领 · 挂起到)", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [account()],
        claim: claimOverview({
          accounts: [
            {
              label: "work-team",
              running: true,
              holdUntil: Date.now() + 600_000,
              planHolds: { "weekend-1": { until: Date.now() + 600_000, reason: "claimed" } },
            },
          ],
        }),
      }),
    );
    openDetail(harness);
    await harness.settle();
    const body = harness.role("account-dialog-body");
    expect(body?.textContent).toContain("已领 · 挂起到");
  });

  it("shows an unseen campaign with its name, clocks, raw period and exhausted state, without its id", async () => {
    const novel = claimPlan({
      planId: "orbit-festival-9917",
      name: "星云投放节",
      startsAt: CLAIM_NOW_SECONDS - 60,
      effectiveAt: CLAIM_NOW_SECONDS + 3600,
      endsAt: CLAIM_NOW_SECONDS + 7200,
      ledgerState: "exhausted",
      entitlements: [
        {
          entitlementId: "orbit-quota",
          showName: "星云额度",
          meter: "tokens",
          unitType: "token",
          grantUnits: 900_000_000,
          period: "seasonal_orbit",
          priority: 1,
        },
      ],
      deliveryFacet: "popup",
      undocumentedField: { internal: "keep-out-of-dom" },
    });
    const harness = await mountClaim([novel]);
    const body = harness.role("account-dialog-body");
    const row = claimRows(harness)[0];
    expect(row?.getAttribute("data-claim-state")).toBe("exhausted");
    expect(body?.textContent).toContain("星云投放节");
    expect(body?.textContent).toContain("权益生效");
    expect(body?.textContent).toContain("结束");
    expect(body?.textContent).toContain("seasonal_orbit");
    expect(body?.textContent).toContain("名额已用完");
    expect(body?.textContent).toContain("名额已用完");
    expect(body?.textContent).not.toContain("orbit-festival-9917");
    expect(body?.textContent).not.toContain("keep-out-of-dom");
    expect(body?.textContent).not.toContain("popup");
    expect(claimButtonOf(row)?.disabled).toBe(true);
    expect(claimButtonOf(row)?.title).toContain("名额已用完");
  });

  it("shows an unseen activity in the claim list without its id or unknown fields", async () => {
    const harness = await mountSettled("/settings", statePayload({ claim: claimOverview() }), {
      controlReply: {
        ok: true,
        event: "claimPlanChoices",
        accountLabel: "work-team",
        plans: [claimPlan({
          planId: "nova-drop-7701",
          name: "星云即时投放",
          effectiveAt: CLAIM_NOW_SECONDS + 3600,
          ledgerState: "exhausted",
          entitlements: [{ showName: "星云额度", grantUnits: 42, unitType: "token", period: "seasonal_orbit" }],
          unknownFacet: { internal: "keep-out-of-dom" },
        })],
      } as never,
    });
    const text = harness.role("settings-claimActivities")?.textContent ?? "";
    expect(text).toContain("星云即时投放");
    expect(text).toContain("名额已用完");
    expect(text).toContain("权益生效");
    expect(text).toContain("结束");
    expect(text).not.toContain("nova-drop-7701");
    expect(text).not.toContain("seasonal_orbit");
    expect(text).not.toContain("keep-out-of-dom");
    harness.close();
  });

  it("derives all eight states with the right claim-button availability", async () => {
    const cases = [
      ["upcoming", { startsAt: CLAIM_NOW_SECONDS + 7200, effectiveAt: undefined, endsAt: CLAIM_NOW_SECONDS + 10800 }, false],
      ["ready", { startsAt: CLAIM_NOW_SECONDS + 60, effectiveAt: undefined, endsAt: CLAIM_NOW_SECONDS + 7200 }, false],
      ["claimable", { startsAt: CLAIM_NOW_SECONDS - 60, effectiveAt: undefined, endsAt: CLAIM_NOW_SECONDS + 7200 }, false],
      ["pendingEffective", { startsAt: CLAIM_NOW_SECONDS - 60, effectiveAt: CLAIM_NOW_SECONDS + 3600, endsAt: CLAIM_NOW_SECONDS + 7200 }, false],
      ["claimed", { ledgerState: "claimed" }, true],
      ["exhausted", { ledgerState: "exhausted" }, true],
      ["manual", { ledgerState: "captcha", lastOutcome: { userAction: "manual-verification" } }, true],
      ["expired", { startsAt: CLAIM_NOW_SECONDS - 7200, endsAt: CLAIM_NOW_SECONDS - 3600, effectiveAt: undefined }, true],
    ] as const;
    for (const [state, overrides, disabled] of cases) {
      const harness = await mountClaim([claimPlan({ planId: "state-" + state, name: "状态 " + state, ...overrides })]);
      const row = claimRows(harness).find((node) => node.getAttribute("data-claim-state") === state);
      expect(row).toBeDefined();
      const button = claimButtonOf(row);
      expect(button?.disabled).toBe(disabled);
      if (disabled) expect(button?.title.length).toBeGreaterThan(0);
      else expect(button?.title).toBe("");
      if (state === "pendingEffective") expect(row?.textContent).toContain("待生效 ·");
      if (state === "manual") expect(row?.textContent).toContain("需要在官方客户端完成验证");
      harness.close();
    }
  });

  it("labels campaign cards with the same claimed state vocabulary", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({
        accounts: [account({
          quota: quota({
            campaigns: [{
              planId: "campaign-owned-1",
              name: "已领的周末活动",
              status: "claimed",
              startsAt: Date.now() - 3600_000,
              endsAt: Date.now() + 3600_000,
              entitlements: [{ showName: "GLM-5.3-Flash", grantUnits: 500_000_000, unitType: "token" }],
              source: "preview",
            }],
          }),
        })],
      }),
    );
    openDetail(harness);
    await harness.settle();
    const campaigns = [...(harness.role("account-dialog-body")?.querySelectorAll(".detail__section") ?? [])]
      .find((section) => section.textContent?.includes("本期活动"));
    expect(campaigns?.textContent).toContain("已领");
    expect(campaigns?.textContent).not.toContain("生效中");
    harness.close();
  });

  it("claimNow sends the existing command, updates the state and refreshes the dialog", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({ accounts: [account()], claim: claimOverview() }),
    );
    harness.controlReplies = [
      claimPlansReply([claimPlan({ effectiveAt: undefined })]),
      { ok: true, event: "claimOutcome", label: "work-team", outcome: { ok: true, planId: "weekend-1" } } as unknown as ControlReply,
      claimPlansReply([claimPlan({ effectiveAt: undefined, ledgerState: "claimed" })]),
    ];
    openDetail(harness);
    await harness.settle();
    const button = claimButtonOf(claimRows(harness)[0]);
    harness.click(button as PageNode);
    await harness.settle();

    const claimCommands = harness.calls
      .filter((call) => call.url === "/api/control")
      .map((call) => call.body as { cmd?: string; accountLabel?: string; planId?: string })
      .filter((body) => body.cmd === "claimNow");
    expect(claimCommands).toEqual([{ cmd: "claimNow", accountLabel: "work-team", planId: "weekend-1" }]);
    expect(harness.role("account-dialog-body")?.textContent).toContain("已领取：ZCode Weekend Build");
    expect(claimRows(harness)[0]?.getAttribute("data-claim-state")).toBe("claimed");
  });

  it("claimNow failure uses a user-facing reason and disables the exhausted button", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({ accounts: [account()], claim: claimOverview() }),
    );
    harness.controlReplies = [
      claimPlansReply([claimPlan({ effectiveAt: undefined })]),
      {
        ok: true,
        event: "claimOutcome",
        label: "work-team",
        outcome: { ok: false, planId: "weekend-1", failureKind: "quota_exhausted", code: 1005, message: "quota" },
      } as unknown as ControlReply,
      claimPlansReply([claimPlan({ effectiveAt: undefined, ledgerState: "exhausted" })]),
    ];
    openDetail(harness);
    await harness.settle();
    harness.click(claimButtonOf(claimRows(harness)[0]) as PageNode);
    await harness.settle();
    const body = harness.role("account-dialog-body");
    expect(body?.textContent).toContain("名额已用完");
    expect(body?.textContent).not.toContain("1005");
    expect(claimRows(harness)[0]?.getAttribute("data-claim-state")).toBe("exhausted");
    expect(claimButtonOf(claimRows(harness)[0])?.disabled).toBe(true);
  });

  it("the refresh button re-fetches the plan list on demand", async () => {
    const harness = await mountSettled(
      "/accounts",
      statePayload({ accounts: [account()], claim: claimOverview() }),
    );
    const previewCalls = (): number =>
      harness.calls.filter((c) => c.body && (c.body as { cmd?: string }).cmd === "previewClaimPlans").length;
    openDetail(harness);
    await harness.settle();
    expect(previewCalls()).toBe(1);

    harness.controlReplies = [claimPlansReply()];
    const body = harness.role("account-dialog-body");
    const refresh = [...nodes(body, "button")].find((node) => node.textContent === "刷新活动") as PageNode;
    harness.click(refresh);
    await harness.settle();
    expect(previewCalls()).toBe(2);
    expect(harness.role("account-dialog-body")?.textContent).toContain("ZCode Weekend Build");
  });
});
