/**
 * 设置页（渲染 / 写入 / 热重载提示 / 二次确认 / 四组 / 退出进程 / claim 计划）。
 *
 * 脚手架见 `runtime-harness.ts`。
 */

import { describe, expect, it } from "bun:test";
import { claimOverview, installHarnessHooks, commands, mountSettled, nodes, settingsPayload, statePayload, waitFor } from "./runtime-harness.js";
import type { Harness, PageNode } from "./runtime-harness.js";

installHarnessHooks();

/* ------------------------------------------------------------------------- */
/* 设置页                                                                     */
/* ------------------------------------------------------------------------- */

/** 设置页的写请求（`POST /api/settings` 的 body）。*/
interface SettingsWrite {
  patch: Record<string, unknown>;
  confirm?: boolean;
}

/** 已发出的设置写入。*/
function settingsWrites(harness: Harness): SettingsWrite[] {
  return harness.calls
    .filter((call) => call.url === "/api/settings" && call.method === "POST")
    .map((call) => call.body as SettingsWrite);
}

describe("settings page — rendering", () => {
  it("fills every group from the snapshot", async () => {
    const harness = await mountSettled("/settings", statePayload());

    // 连接
    expect(harness.role("settings-defaultModel")?.value).toBe("glm-5.3");
    expect(harness.role("settings-clientMode")?.value).toBe("enforce");
    expect(harness.role("settings-clientTtl")?.value).toBe("900");
    expect(harness.role("settings-clientMaxSessions")?.value).toBe("1024");

    // 身份：归一开关只读；客户端版本是可编辑输入框
    expect(harness.role("settings-normalize")?.textContent).toBe("开");
    expect(harness.role("settings-appVersion")?.value).toBe("3.17.1");

    // 子系统
    expect(harness.role("settings-highspeed")?.checked).toBe(true);
    expect(harness.role("settings-async")?.checked).toBe(false);
    expect(harness.role("settings-quotaPollSeconds")?.value).toBe("300");
    expect(harness.role("settings-quotaDrainThreshold")?.value).toBe("1");

    // 安全 + 数据
    expect(harness.role("settings-port")?.value).toBe("8080");
    expect(harness.role("settings-host")?.value).toBe("127.0.0.1");
    // 安全组只剩「需要 API key」这一个总开关：key 本身在 `/keys` 页
    expect(harness.role("settings-requireKey")?.checked).toBe(true);
    expect(harness.role("settings-configPath")?.textContent).toBe("config.yaml");
    // 页面里没有任何 proxyApiKey 输入框：明文与配置项都随多 key 一起删掉了
    expect(harness.role("settings-proxyApiKey")).toBeNull();
  });

  it("renders the requireKey switch off when the snapshot says so", async () => {
    const harness = await mountSettled("/settings", statePayload(), {
      settings: settingsPayload({ security: { port: 8080, host: "127.0.0.1", requireKey: false } }),
    });

    expect(harness.role("settings-requireKey")?.checked).toBe(false);
    // 快照里没有任何字段携带 key 原文（key 在 apikeys.json，永远不回页面）
    expect(JSON.stringify(harness.settings)).not.toContain("sk-zcp-");
  });

  it("keeps the locked items (R1 / R2) out of the page", async () => {
    const harness = await mountSettled("/settings", statePayload());
    const view = harness.find('[data-view="settings"]');
    // 身份组里没有设备指纹控件：它是账号属性，设置页不出现。
    for (const node of nodes(view, "input, select, textarea")) {
      const role = node.getAttribute("data-role") ?? "";
      expect(role.includes("deviceMid")).toBe(false);
      expect(role.includes("session")).toBe(false);
    }
    // 也没有"session 隔离"这类开关（R2 是代码不变量，不是配置项）
    const roles = nodes(view, "[data-role]").map((node) => node.getAttribute("data-role") ?? "");
    expect(roles.some((role) => role.includes("isolation"))).toBe(false);
  });
});

describe("settings page — writing", () => {
  it("round-trips the session affinity mode", async () => {
    const harness = await mountSettled("/settings", statePayload());
    harness.settings.connection.mode = "observe";
    harness.change(harness.role("settings-clientMode"), "observe");
    await harness.settle();

    expect(settingsWrites(harness)).toEqual([{ patch: { connection: { mode: "observe" } }, confirm: false }]);
    expect(harness.role("settings-clientMode")?.value).toBe("observe");
  });

  it("round-trips the default model", async () => {
    const harness = await mountSettled("/settings", statePayload());
    harness.settings.connection.defaultModel = "glm-5.3-flash";
    harness.change(harness.role("settings-defaultModel"), "glm-5.3-flash");
    await harness.settle();
    expect(settingsWrites(harness)[0].patch).toEqual({ defaultModel: "glm-5.3-flash" });
  });

  it("round-trips the numeric fields and rejects non-positive values locally", async () => {
    const harness = await mountSettled("/settings", statePayload());

    harness.settings.connection.ttlSeconds = 600;
    harness.change(harness.role("settings-clientTtl"), "600");
    await harness.settle();
    expect(settingsWrites(harness)[0].patch).toEqual({ connection: { ttlSeconds: 600 } });

    harness.settings.subsystems.quotaDrainThreshold = 0.85;
    harness.change(harness.role("settings-quotaDrainThreshold"), "0.85");
    await harness.settle();
    expect(settingsWrites(harness)[1].patch).toEqual({ subsystems: { quotaDrainThreshold: 0.85 } });

    // 0 不是合法值：不发请求，直接红条（服务端同口径）
    harness.change(harness.role("settings-clientMaxSessions"), "0");
    await harness.settle();
    expect(settingsWrites(harness)).toHaveLength(2);
    expect(harness.role("settings-error")?.hasAttribute("hidden")).toBe(false);
    /* 横幅是 live region：读屏器不用重新聚焦也能听到「刚才那步失败了」。 */
    expect(harness.role("settings-error")?.getAttribute("role")).toBe("alert");
    expect(harness.role("settings-notice")?.getAttribute("role")).toBe("status");
  });

  it("round-trips all four subsystem switches", async () => {
    const harness = await mountSettled("/settings", statePayload());
    const fields = [
      ["settings-highspeed", "highspeed"],
      ["settings-mcp", "mcp"],
      ["settings-async", "async"],
      ["settings-claim", "claim"],
    ] as const;

    for (const [role, field] of fields) {
      harness.change(harness.role(role), "", true);
      await harness.settle();
      const write = settingsWrites(harness).pop();
      expect(write?.patch).toEqual({ subsystems: { [field]: true } });
    }
  });

  it("renders the dump switch with its risk copy and configured path", async () => {
    const harness = await mountSettled("/settings", statePayload(), {
      settings: settingsPayload({
        subsystems: {
          highspeed: true,
          mcp: true,
          async: false,
          claim: true,
          dumpEnabled: false,
          dumpPath: "",
          quotaPollSeconds: 300,
          quotaDrainThreshold: 1,
        },
      }),
    });

    // 关闭态 + 默认路径的展示（配置里 path 为空串 → 显示默认位置）
    expect(harness.role("settings-dumpEnabled")?.checked).toBe(false);
    expect(harness.role("settings-dumpPath")?.textContent).toBe("~/.zcode-proxy/dump.jsonl");
    const view = harness.find('[data-view="settings"]');
    expect(view?.textContent).toContain("dump 文件含完整请求体");

    // 配置了自定义路径时显示配置值
    const custom = await mountSettled("/settings", statePayload(), {
      settings: settingsPayload({
        subsystems: {
          highspeed: true,
          mcp: true,
          async: false,
          claim: true,
          dumpEnabled: true,
          dumpPath: "/tmp/debug-dump.jsonl",
          quotaPollSeconds: 300,
          quotaDrainThreshold: 1,
        },
      }),
    });
    expect(custom.role("settings-dumpEnabled")?.checked).toBe(true);
    expect(custom.role("settings-dumpPath")?.textContent).toBe("/tmp/debug-dump.jsonl");
  });

  it("round-trips the dump switch as a subsystems patch", async () => {
    const harness = await mountSettled("/settings", statePayload());
    harness.settings.subsystems.dumpEnabled = true;
    harness.change(harness.role("settings-dumpEnabled"), "", true);
    await harness.settle();
    expect(settingsWrites(harness)).toEqual([{ patch: { subsystems: { dumpEnabled: true } }, confirm: false }]);
    expect(harness.role("settings-dumpEnabled")?.checked).toBe(true);
  });

  it("round-trips the port", async () => {
    const harness = await mountSettled("/settings", statePayload());
    harness.settings.security.port = 9191;
    harness.change(harness.role("settings-port"), "9191");
    await harness.settle();
    expect(settingsWrites(harness)[0].patch).toEqual({ security: { port: 9191 } });
  });

  it("writes a hand-typed app version and blocks a malformed one locally", async () => {
    const harness = await mountSettled("/settings", statePayload(), {
      settings: settingsPayload({
        identity: {
          normalizeClientSystem: true,
          appVersion: "3.17.2",
          appVersionSource: "detected",
          appVersionSourcePath: ["", "Applications", "ZCode.app", "Contents", "Info.plist"].join("/"),
        },
      }),
    });

    harness.change(harness.role("settings-appVersion"), "3.99.0");
    await harness.settle();
    expect(settingsWrites(harness)[0].patch).toEqual({ identity: { appVersion: "3.99.0" } });

    /* 格式不对：不往返一次，当场红条并把输入框退回去 */
    harness.change(harness.role("settings-appVersion"), "3.99");
    await harness.settle();
    expect(settingsWrites(harness)).toHaveLength(1);
    expect(harness.role("settings-error")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("settings-appVersion")?.value).toBe("3.17.2");
  });

  it("clears the manual override by writing an empty value", async () => {
    const harness = await mountSettled("/settings", statePayload(), {
      settings: settingsPayload({
        identity: { normalizeClientSystem: true, appVersion: "3.99.0", appVersionSource: "manual" },
      }),
    });

    harness.change(harness.role("settings-appVersion"), "");
    await harness.settle();
    expect(settingsWrites(harness)[0].patch).toEqual({ identity: { appVersion: "" } });
  });

  it("syncs the app version from the installed client, then saves it", async () => {
    const harness = await mountSettled("/settings", statePayload());
    const infoPlist = ["", "Applications", "ZCode.app", "Contents", "Info.plist"].join("/");
    harness.controlReply = { ok: true, event: "appVersion", detected: "3.17.2", path: infoPlist };
    harness.settings.identity = { normalizeClientSystem: true, appVersion: "3.17.2", appVersionSource: "manual" };

    harness.click(harness.find('[data-action="settings-detect-app-version"]'));
    await harness.settle();

    expect(commands(harness).pop()?.body).toEqual({ cmd: "detectAppVersion" });
    expect(settingsWrites(harness)[0].patch).toEqual({ identity: { appVersion: "3.17.2" } });
    expect(harness.role("settings-appVersion")?.value).toBe("3.17.2");
  });

  it("reports a missing client instead of writing anything on sync", async () => {
    const harness = await mountSettled("/settings", statePayload());
    harness.controlReply = { ok: true, event: "appVersion", detected: null };

    harness.click(harness.find('[data-action="settings-detect-app-version"]'));
    await harness.settle();

    expect(settingsWrites(harness)).toHaveLength(0);
    expect(harness.role("settings-error")?.hasAttribute("hidden")).toBe(false);
  });

  it("spells out which of the three sources the current version came from", async () => {
    const detected = await mountSettled("/settings", statePayload(), {
      settings: settingsPayload({
        identity: {
          normalizeClientSystem: true,
          appVersion: "3.17.2",
          appVersionSource: "detected",
          appVersionSourcePath: ["", "Applications", "ZCode.app"].join("/"),
        },
      }),
    });
    expect(detected.role("settings-appVersionSource")?.textContent).toBe(
      "来源：" + ["", "Applications", "ZCode.app"].join("/"),
    );

    const fallback = await mountSettled("/settings", statePayload());
    expect(fallback.role("settings-appVersionSource")?.textContent).toBe(
      "来源：内置默认（未检测到本机客户端）",
    );

    const manual = await mountSettled("/settings", statePayload(), {
      settings: settingsPayload({
        identity: { normalizeClientSystem: true, appVersion: "3.99.0", appVersionSource: "manual" },
      }),
    });
    expect(manual.role("settings-appVersionSource")?.textContent).toBe("来源：手动指定");
  });
});

describe("settings page — 热重载提示", () => {
  /** 把「已生效」提示的停留时长压到用例可等待的量级（真实值 4s，见 app-constants.js）。*/
  function shortenNoticeTtl(harness: Harness): void {
    const app = (harness.win as unknown as { __zcodeApp?: { const?: { SETTINGS_NOTICE_TTL_MS?: number } } }).__zcodeApp;
    if (app?.const) app.const.SETTINGS_NOTICE_TTL_MS = 30;
  }

  it("flashes a brief 「已生效」 when the write hot-reloaded fields", async () => {
    const harness = await mountSettled("/settings", statePayload());
    shortenNoticeTtl(harness);
    harness.settingsReply = { ok: true, reloaded: ["async"] };

    harness.change(harness.role("settings-async"), "", true);
    await harness.settle();

    expect(harness.role("settings-notice")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("settings-notice-text")?.textContent).toContain("已生效");

    // 短暂提示：到点自己收起，不常驻。
    await waitFor(() => harness.role("settings-notice")?.hasAttribute("hidden") === true, "settings notice auto-hide");
    expect(harness.role("settings-notice")?.hasAttribute("hidden")).toBe(true);
  });

  it("keeps a persistent notice when the change needs a restart", async () => {
    const harness = await mountSettled("/settings", statePayload());
    harness.settingsReply = { ok: true, reloaded: [], restartRequired: ["server.port"] };

    harness.change(harness.role("settings-port"), "9191");
    await harness.settle();

    expect(harness.role("settings-notice")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("settings-notice-text")?.textContent).toContain("重启");

    // C 类的提示是常驻事实，不是短暂状态：等过 TTL 也不会消失。
    // 这条断言间的是“什么都没发生”，没有条件可等——固定等过 TTL 就是它要证的事。
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(harness.role("settings-notice")?.hasAttribute("hidden")).toBe(false);
  });

  it("falls back to a plain saved notice when nothing was reloaded", async () => {
    const harness = await mountSettled("/settings", statePayload());
    harness.settingsReply = { ok: true, reloaded: [], restartRequired: [] };

    harness.change(harness.role("settings-port"), "9191");
    await harness.settle();

    expect(harness.role("settings-notice-text")?.textContent).toBe("已保存。");
  });

  it("explains a written-but-not-applied file instead of the generic error", async () => {
    const harness = await mountSettled("/settings", statePayload());
    harness.settingsReply = { ok: false, error: "config_invalid", fileWritten: true };

    harness.change(harness.role("settings-port"), "9191");
    await harness.settle();

    expect(harness.role("settings-error")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("settings-error-text")?.textContent).toContain("已写入配置文件");
    expect(harness.role("settings-error-text")?.textContent).not.toContain("Config file is malformed");
  });
});

describe("settings page — 二次确认", () => {
  /** 让服务端先回 `confirmation_required`，模拟 L3 拦截。*/
  function requireConfirmation(harness: Harness): void {
    harness.settingsReply = { ok: false, error: "confirmation_required" };
  }

  it("intercepts a non-loopback bind with a modal, then resends with confirm", async () => {
    const harness = await mountSettled("/settings", statePayload());
    requireConfirmation(harness);

    harness.change(harness.role("settings-host"), "0.0.0.0");
    await harness.settle();

    // 第一次只发了一次请求（没有 confirm），并被拦下 → 弹模态，而不是直接写
    expect(settingsWrites(harness)).toEqual([{ patch: { security: { host: "0.0.0.0" } }, confirm: false }]);
    expect(harness.role("confirm-modal")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("confirm-title")?.textContent).toContain("暴露");

    // 确认之后带 confirm: true 重发
    harness.settingsReply = { ok: true };
    harness.settings.security.host = "0.0.0.0";
    harness.click(harness.role("confirm-submit"));
    await harness.settle();

    expect(settingsWrites(harness)[1]).toEqual({ patch: { security: { host: "0.0.0.0" } }, confirm: true });
    expect(harness.role("confirm-modal")?.hasAttribute("hidden")).toBe(true);
  });

  it("intercepts a requireKey change (L3) and can be cancelled", async () => {
    const harness = await mountSettled("/settings", statePayload());
    requireConfirmation(harness);

    // 关掉鉴权是安全降级：服务端要二次确认，页面必须走模态而不是直接发
    harness.change(harness.role("settings-requireKey"), "", false);
    await harness.settle();
    expect(harness.role("confirm-modal")?.hasAttribute("hidden")).toBe(false);

    // 取消：不发第二次请求，开关回到快照值
    harness.click(harness.find('[data-action="close-confirm"]'));
    await harness.settle();
    expect(settingsWrites(harness)).toHaveLength(1);
    expect(harness.role("confirm-modal")?.hasAttribute("hidden")).toBe(true);
    expect(harness.role("settings-requireKey")?.checked).toBe(true);
  });

  it("rolls the control back when Esc dismisses the confirmation", async () => {
    const harness = await mountSettled("/settings", statePayload());
    requireConfirmation(harness);

    harness.change(harness.role("settings-requireKey"), "", false);
    await harness.settle();
    expect(harness.role("confirm-modal")?.hasAttribute("hidden")).toBe(false);

    /* Esc 与「取消」是同一件事：都走 `onCancel` 回滚，控件回到服务端的快照值。
       只关框不回滚会让开关停在一个配置文件里并不存在的值上。 */
    harness.win.document.dispatchEvent(new harness.win.KeyboardEvent("keydown", { key: "Escape" }));
    await harness.settle();
    expect(harness.role("confirm-modal")?.hasAttribute("hidden")).toBe(true);
    expect(settingsWrites(harness)).toHaveLength(1);
    expect(harness.role("settings-requireKey")?.checked).toBe(true);
  });

  it("closes the confirmation on a scrim click through the cancel path", async () => {
    const harness = await mountSettled("/settings", statePayload());
    requireConfirmation(harness);

    harness.change(harness.role("settings-host"), "0.0.0.0");
    await harness.settle();
    expect(harness.role("confirm-modal")?.hasAttribute("hidden")).toBe(false);

    harness.click(harness.role("confirm-scrim"));
    await harness.settle();
    expect(harness.role("confirm-modal")?.hasAttribute("hidden")).toBe(true);
    // 回滚之后再改一次：控件上仍是快照值，没有发第二条「确认」请求。
    expect(settingsWrites(harness).at(-1)).toEqual({ patch: { security: { host: "0.0.0.0" } }, confirm: false });
  });

  it("does not ask twice for a loopback bind", async () => {
    const harness = await mountSettled("/settings", statePayload());
    /* 快照里是 127.0.0.1，改成另一个回环写法。服务端对这组改动不要求确认
       （`settingsPatchNeedsConfirmation` 只拦非回环），所以页面不该弹模态。*/
    harness.change(harness.role("settings-host"), "localhost");
    await harness.settle();

    expect(settingsWrites(harness)).toEqual([{ patch: { security: { host: "localhost" } }, confirm: false }]);
    expect(harness.role("confirm-modal")?.hasAttribute("hidden")).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */
/* 系统（「系统」并入设置页的「服务」组）                                      */
/* ------------------------------------------------------------------------- */

/** 系统组的某个按钮（`data-action` 是页面与命令之间的唯一契约）。*/
function systemAction(harness: Harness, name: string): PageNode | null {
  return harness.find(`[data-action="${name}"]`);
}

/** 点一下系统按钮再等一轮（模态与命令都是异步的）。*/
async function clickSystem(harness: Harness, name: string): Promise<void> {
  const target = systemAction(harness, name);
  if (!target) throw new Error(`missing [data-action="${name}"]`);
  harness.click(target);
  await harness.settle();
}

/** 二次确认模态里的「确认」。*/
async function confirmModal(harness: Harness): Promise<void> {
  harness.click(harness.role("confirm-submit"));
  await harness.settle();
}

describe("settings page — 四层", () => {
  it("keeps the service group down to port, bind address and the API key link", async () => {
    const harness = await mountSettled("/settings", statePayload());

    /* 服务组只剩三个可写字段 + 一个指向 /keys 的文字链接。 */
    expect(harness.role("settings-port")?.value).toBe("8080");
    expect(harness.role("settings-host")?.value).toBe("127.0.0.1");
    expect(harness.role("settings-requireKey")?.checked).toBe(true);

    const settingsView = harness.find('[data-view="settings"]');
    const groups = nodes(settingsView, ".group__title");
    /* 「子系统」组在界面上叫「功能开关」（i18n 键与快照段名仍是 subsystems）；
     * 外观组不在这里（主题与语言在顶栏右侧）。分层只改层级、不改任何标题，
     * 但层级就是 DOM 顺序：主区（连接 / 服务）→ 账户 → 高级区（功能开关 / 身份，
     * 默认收起，收起不等于不在文档里）。 */
    expect(groups.map((node) => node.textContent)).toEqual(["连接", "服务", "账户", "功能开关", "身份"]);
    /* 启停 / 登录 / 检查更新 / 版本都不在设置页了，只剩页脚的「退出进程」。 */
    for (const action of ["system-login-zai", "system-check-update"]) {
      expect(harness.find(`[data-view="settings"] [data-action="${action}"]`)).toBeNull();
    }
    const systemActions = nodes(settingsView, '[data-action^="system-"]').map((node) =>
      node.getAttribute("data-action"),
    );
    expect(systemActions).toEqual(["system-shutdown"]);
  });

  it("puts connection + service in the main tier and folds 功能开关 + 身份 into 高级", async () => {
    const harness = await mountSettled("/settings", statePayload());
    const view = harness.find('[data-view="settings"]');

    /* 主区：连接与服务两组，在 `.settings-grid` 里。 */
    const grid = view?.querySelector(".settings-grid");
    const areas = nodes(grid, "section.group").map((node) => node.getAttribute("data-group"));
    expect(areas).toEqual(["connection", "service"]);

    /* 账户是独立一层（不在网格里）。 */
    expect(nodes(grid, '[data-group="account"]')).toHaveLength(0);
    const account = view?.querySelector('[id="account"]');
    expect(account?.getAttribute("data-group")).toBe("account");

    /* 高级区：默认收起（正文 `hidden`、标题行 `aria-expanded="false"`），里面两组。 */
    const advanced = view?.querySelector(".settings-advanced");
    if (!advanced) throw new Error("missing .settings-advanced");
    expect(advanced.getAttribute("data-collapse-open")).toBe("false");
    expect(advanced.querySelector(".collapse__head")?.getAttribute("aria-expanded")).toBe("false");
    expect(advanced.querySelector("#settings-advanced-body")?.hasAttribute("hidden")).toBe(true);
    const folded = nodes(advanced, "section.group").map((node) => node.getAttribute("data-group"));
    expect(folded).toEqual(["subsystems", "identity"]);
  });

  it("opens and closes 高级 without persisting the state", async () => {
    const harness = await mountSettled("/settings", statePayload());
    const view = harness.find('[data-view="settings"]');
    const head = view?.querySelector("[data-advanced-toggle]");
    const body = harness.find("#settings-advanced-body");
    if (!head || !body) throw new Error("missing the advanced tier");
    const advanced = view?.querySelector(".settings-advanced");

    /* 收起时标题行留一句摘要（「功能开关 · 身份」），展开后它只是复述，不显示。 */
    const summary = advanced?.querySelector(".collapse__summary");
    expect(summary?.textContent).toBe("功能开关 · 身份");

    harness.click(head);
    await harness.settle();
    expect(body.hasAttribute("hidden")).toBe(false);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(advanced?.getAttribute("data-collapse-open")).toBe("true");

    harness.click(head);
    await harness.settle();
    expect(body.hasAttribute("hidden")).toBe(true);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(advanced?.getAttribute("data-collapse-open")).toBe("false");

    /* 状态不落存储：高级区不走 `App.widgets` 那套（那套写 sessionStorage，
       刷新后回到上次状态），页面里也没有 `data-collapse="settings-advanced"`。 */
    expect(harness.win.sessionStorage.getItem("zcode-collapse")).toBeNull();
    expect(harness.find('[data-collapse="settings-advanced"]')).toBeNull();
  });

  it("shows the config path as a read-only line, not as a data group", async () => {
    const harness = await mountSettled("/settings", statePayload());
    expect(harness.role("settings-configPath")?.textContent).toBe("config.yaml");
    expect(harness.find('[data-view="settings"] [data-i18n="settings.group.data"]')).toBeNull();
  });
});

describe("settings page — 退出进程", () => {
  it("puts 退出进程 in the footer, after 检查更新", async () => {
    const harness = await mountSettled("/settings", statePayload());
    const footer = harness.find(".settings-footer");
    if (!footer) throw new Error("missing the settings footer");

    /* 两者都不是配置（写不进 YAML、不参与热重载），所以离开服务组的字段格，
       提到页脚：检查更新在前、一辈子用一次的退出进程在末。 */
    const actions = nodes(footer, "[data-action]").map((node) => node.getAttribute("data-action"));
    expect(actions).toEqual(["account-check-update", "system-shutdown"]);
    /* 版本值与两颗按钮在按钮组里同一档（36px / 6px 圆角 / 8px 组距），
       几何在 settings.css；这里只钉 class 组合，不复制 CSS 取值。 */
    const version = harness.find('[data-role="about-version"]');
    expect(version?.className).toBe("group__readonly settings-footer__value");
    expect(nodes(footer, '[data-role="about-version"]')).toHaveLength(1);
    expect(harness.find('[data-action="system-shutdown"]')?.textContent).toBe("退出");
    /* 危险操作的按钮与账号页的删除同一个 class（danger 系）。 */
    expect(harness.find('[data-action="system-shutdown"]')?.className).toBe("btn btn--danger");

    /* 服务组里不再有它们。 */
    const groups = nodes(harness.find('[data-view="settings"]'), "section.group");
    const service = groups.find((group) => group.getAttribute("data-group") === "service");
    if (!service) throw new Error("missing the service group");
    expect(nodes(service, "[data-action]")).toHaveLength(0);
  });

  it("asks before quitting the process, then sends shutdown (L3, needs confirmation)", async () => {
    const harness = await mountSettled("/settings", statePayload());
    await clickSystem(harness, "system-shutdown");

    // 确认之前一条命令都不许发
    expect(commands(harness)).toHaveLength(0);
    expect(harness.role("confirm-title")?.textContent).toBe("退出这个程序？");
    expect(harness.role("confirm-warn")?.textContent).toBe(
      "要恢复服务，从终端、Docker 或服务管理器重新启动。",
    );
    // 确认模态的 scrim 同样要亮起来（UI 审查 #1）。
    expect(harness.role("confirm-scrim")?.hasAttribute("hidden")).toBe(false);

    await confirmModal(harness);
    expect(harness.role("confirm-scrim")?.hasAttribute("hidden")).toBe(true);
    expect(commands(harness).map((call) => call.body)).toEqual([{ cmd: "shutdown" }]);
  });

  it("sends nothing when the confirmation is cancelled", async () => {
    const harness = await mountSettled("/settings", statePayload());
    await clickSystem(harness, "system-shutdown");
    harness.click(harness.role("confirm-scrim"));
    await harness.settle();

    expect(commands(harness)).toHaveLength(0);
    expect(harness.role("appbar-note")?.hasAttribute("hidden")).toBe(true);
  });

  it("reports the quit in the app bar and stays on the page", async () => {
    const harness = await mountSettled("/settings", statePayload());
    await clickSystem(harness, "system-shutdown");
    await confirmModal(harness);

    /* 不跳转：跳过去也是死链（进程已经没了），页面留在原地说明一句。 */
    expect(harness.navigations).toEqual([]);
    expect(harness.role("appbar-note")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("appbar-note")?.textContent).toBe("已退出，可以关掉这个标签页了。");
  });

  it("surfaces a refused shutdown in the app bar", async () => {
    const harness = await mountSettled("/settings", statePayload());
    harness.controlReply = { ok: false, error: "not_logged_in" };
    await clickSystem(harness, "system-shutdown");
    await confirmModal(harness);

    expect(harness.role("appbar-note")?.textContent).toBe("还没有登录账号。");
  });
});

describe("设置页「账户」组", () => {
  it("renders the account group inside the settings view, with no page of its own", async () => {
    const harness = await mountSettled("/settings", statePayload());

    /* 「我的账户」不是独立页：它并进设置页的「账户」组，页面上没有单独的视图
       或导航项。 */
    expect(harness.find('[data-view="account"]')).toBeNull();
    expect(harness.find('[data-nav="account"]')).toBeNull();
    expect(harness.find('[data-view="settings"]')?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("account-username")?.value).toBe("admin");
    /* 三件事都在「账户」组里（标题是 `settings.group.account`）。 */
    const group = harness.find('[id="account"]');
    expect(group).not.toBeNull();
    expect(nodes(group, "[data-role='account-currentPassword']")).toHaveLength(1);
    expect(nodes(group, "[data-action='account-logout']")).toHaveLength(1);
  });

  it("signs out through the console session and falls back to /login", async () => {
    const harness = await mountSettled("/settings", statePayload());

    harness.click(harness.find('[data-action="account-logout"]'));
    await harness.settle();

    // 登出走的是会话接口，不是控制命令；成功之后整页回登录页。
    expect(harness.calls.some((call) => call.url === "/api/session" && call.method === "DELETE")).toBe(true);
    expect(harness.navigations).toContain("/login");
  });

  it("refuses an empty or mismatched new password before it reaches the server", async () => {
    const harness = await mountSettled("/settings", statePayload());

    harness.click(harness.find('[data-action="account-save-password"]'));
    await harness.settle();
    expect(harness.role("account-error-text")?.textContent).toBe("请填写当前密码与新密码。");

    harness.type(harness.role("account-currentPassword"), "old-password");
    harness.type(harness.role("account-newPassword"), "new-password-1");
    harness.type(harness.role("account-confirmPassword"), "new-password-2");
    harness.click(harness.find('[data-action="account-save-password"]'));
    await harness.settle();
    expect(harness.role("account-error-text")?.textContent).toBe("两次输入的新密码不一致。");

    // 两次都没发出去
    expect(harness.calls.filter((call) => call.url === "/api/password")).toHaveLength(0);
  });

  it("posts the password change and reports it (success and wrong current password)", async () => {
    const harness = await mountSettled("/settings", statePayload());
    harness.type(harness.role("account-currentPassword"), "old-password");
    harness.type(harness.role("account-newPassword"), "new-password-1");
    harness.type(harness.role("account-confirmPassword"), "new-password-1");

    harness.click(harness.find('[data-action="account-save-password"]'));
    await harness.settle();

    const posted = harness.calls.filter((call) => call.url === "/api/password");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toEqual({ currentPassword: "old-password", newPassword: "new-password-1" });
    expect(harness.role("account-notice-text")?.textContent).toBe("密码已修改。");
    // 成功之后三个输入框清空，免得密码留在界面上
    expect(harness.role("account-currentPassword")?.value).toBe("");
    expect(harness.role("account-newPassword")?.value).toBe("");

    // 当前密码错：401 + wrong_password，就地提示，不跳登录页。
    harness.passwordStatus = 401;
    harness.passwordReply = { ok: false, error: "wrong_password" };
    harness.type(harness.role("account-currentPassword"), "bad-password");
    harness.type(harness.role("account-newPassword"), "new-password-2");
    harness.type(harness.role("account-confirmPassword"), "new-password-2");
    harness.click(harness.find('[data-action="account-save-password"]'));
    await harness.settle();
    expect(harness.role("account-error-text")?.textContent).toBe("当前密码不对。");
    expect(harness.navigations).toEqual([]);
  });

  it("submits the password form with Enter", async () => {
    const harness = await mountSettled("/settings", statePayload());
    harness.type(harness.role("account-currentPassword"), "old-password");
    harness.type(harness.role("account-newPassword"), "new-password-1");
    harness.type(harness.role("account-confirmPassword"), "new-password-1");

    const field = harness.role("account-confirmPassword");
    field?.dispatchEvent(new harness.win.KeyboardEvent("keydown", { key: "Enter" }));
    await harness.settle();

    expect(harness.calls.filter((call) => call.url === "/api/password")).toHaveLength(1);
  });

  it("sends checkUpdate from the about section and renders each stable status", async () => {
    const harness = await mountSettled("/settings", statePayload());

    harness.controlReply = {
      ok: true,
      event: "updateCheck",
      update: { status: "update", current: "4.8.8", latest: "v5.0.0", notice: "docker compose pull" },
    };
    harness.click(harness.find('[data-action="account-check-update"]'));
    await harness.settle();
    expect(harness.role("account-notice-text")?.textContent).toBe("有新版本 v5.0.0：docker compose pull");

    harness.controlReply = { ok: true, event: "updateCheck", update: { status: "up-to-date", current: "4.8.8", latest: "v4.8.8" } };
    harness.click(harness.find('[data-action="account-check-update"]'));
    await harness.settle();
    expect(harness.role("account-notice-text")?.textContent).toBe("已是最新版本（v4.8.8）。");

    harness.controlReply = { ok: true, event: "updateCheck", update: { status: "unavailable", current: "4.8.8" } };
    harness.click(harness.find('[data-action="account-check-update"]'));
    await harness.settle();
    expect(harness.role("account-notice-text")?.textContent).toBe("无法检查更新（离线、被拦截，或更新检查已关闭）。");

    expect(commands(harness).map((call) => call.body)).toEqual([
      { cmd: "checkUpdate" },
      { cmd: "checkUpdate" },
      { cmd: "checkUpdate" },
    ]);
  });

  it("reports a failed update check on the page banner", async () => {
    const harness = await mountSettled("/settings", statePayload());
    harness.controlReply = { ok: false, error: "update_check_unavailable" };

    harness.click(harness.find('[data-action="account-check-update"]'));
    await harness.settle();

    expect(harness.role("account-error")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("account-notice")?.hasAttribute("hidden")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 抢活动：设置页的策略、开抢节奏与只读活动清单
// ---------------------------------------------------------------------------

describe("settings — claim overview", () => {
  /** `listClaimPlanChoices` 的应答（发现层清单 + 台账标注）。*/
  const choicesReply = (plans: Record<string, unknown>[], accountLabel = "work") => ({
    ok: true,
    event: "claimPlanChoices",
    accountLabel,
    plans,
  });

  const choiceCalls = (harness: Harness): number =>
    harness.calls.filter((call) => (call.body as { cmd?: string } | null)?.cmd === "listClaimPlanChoices").length;

  const activityRows = (harness: Harness): PageNode[] =>
    [...(harness.role("settings-claimActivities")?.querySelectorAll(".claim-overview__activity") ?? [])];

  it("shows the sorting policy and opening cadence from the state claim snapshot", async () => {
    const harness = await mountSettled("/settings", statePayload({ claim: claimOverview() }), {
      controlReply: choicesReply([]) as never,
    });

    expect(harness.role("settings-claimPolicy")?.textContent).toBe("upstream-priority");
    expect(harness.role("settings-claimCadence")?.textContent).toContain("常态检查：每 300 秒");
    expect(harness.role("settings-claimCadence")?.textContent).toContain("开抢前 180 秒 预热");
    expect(harness.role("settings-claimCadence")?.textContent).toContain("开抢窗口 180 秒");
    harness.close();
  });

  it("renders an unseen activity with its name, three clocks and ledger state, without its id", async () => {
    const now = Math.floor(Date.now() / 1000);
    const plan = {
      planId: "brand-new-campaign-8812",
      name: "全新星云庆典",
      description: "没见过的活动名",
      startsAt: now - 60,
      effectiveAt: now + 3600,
      endsAt: now + 7200,
      ledgerState: "exhausted",
      period: "seasonal_orbit",
      unknownFacet: { nested: "do-not-render" },
      source: "marketing/popup",
    };
    const harness = await mountSettled("/settings", statePayload({ claim: claimOverview() }), {
      controlReply: choicesReply([plan]) as never,
    });

    expect(activityRows(harness)).toHaveLength(1);
    const text = harness.role("settings-claimActivities")?.textContent ?? "";
    expect(text).toContain("全新星云庆典");
    expect(text).toContain("名额已用完");
    expect(text).toContain("权益生效");
    expect(text).toContain("结束");
    expect(text).not.toContain("brand-new-campaign-8812");
    expect(text).not.toContain("do-not-render");
    expect(text).not.toContain("seasonal_orbit");
    expect(text).not.toContain("marketing/popup");
    harness.close();
  });

  it("uses the opening preheat window when deriving an activity's readiness", async () => {
    const now = Math.floor(Date.now() / 1000);
    const plan = { planId: "ac4-ready", name: "预热中的活动", startsAt: now + 60, endsAt: now + 7200 };
    const harness = await mountSettled("/settings", statePayload({ claim: claimOverview() }), {
      controlReply: choicesReply([plan]) as never,
    });
    const row = activityRows(harness)[0];
    expect(row?.textContent).toContain("准备就绪");
    expect(row?.textContent).not.toContain("即将开放");
    harness.close();
  });

  it("fetches the discovery list on entry and on the two refresh paths only", async () => {
    const harness = await mountSettled("/settings", statePayload({ claim: claimOverview() }), {
      controlReply: choicesReply([]) as never,
    });
    expect(choiceCalls(harness)).toBe(1);
    await harness.refresh();
    await harness.settle();
    expect(choiceCalls(harness)).toBe(1);

    harness.click(harness.role("settings-claimRefresh"));
    await harness.settle();
    expect(choiceCalls(harness)).toBe(2);
    (harness.win as unknown as { zcodePanel: { refreshView(): Promise<void> } }).zcodePanel.refreshView();
    await harness.settle();
    expect(choiceCalls(harness)).toBe(3);
    harness.close();
  });

  it("does not fetch the discovery list while another view is active", async () => {
    const harness = await mountSettled("/", statePayload({ claim: claimOverview() }), {
      controlReply: choicesReply([]) as never,
    });
    expect(choiceCalls(harness)).toBe(0);
    harness.close();
  });

  it("keeps the status line honest for an empty list and an upstream failure", async () => {
    const empty = await mountSettled("/settings", statePayload({ claim: claimOverview() }), {
      controlReply: choicesReply([]) as never,
    });
    expect(harness_role_text(empty, "settings-claimActivitiesStatus")).toContain("当前没有发现活动");
    empty.close();

    const failed = await mountSettled("/settings", statePayload({ claim: claimOverview() }), {
      controlReply: { ok: false, error: "claim_rate_limited" } as never,
    });
    expect(harness_role_text(failed, "settings-claimActivitiesStatus")).toContain("活动列表被上游限流");
    failed.close();
  });

  it("maps claim diagnostics to five distinct user-facing reasons", async () => {
    const harness = await mountSettled("/settings", statePayload({ claim: claimOverview() }), {
      controlReply: choicesReply([]) as never,
    });
    const api = (harness.win as unknown as { __zcodeApp: { claimActivityState: { logReasonText(code: string): string } } }).__zcodeApp;
    const reasons = ["empty", "versionGate", "1004", "captcha", "429"].map((code) => api.claimActivityState.logReasonText(code));
    expect(new Set(reasons).size).toBe(5);
    expect(reasons[1]).toContain("版本");
    expect(reasons[2]).toContain("资格");
    expect(reasons[3]).toContain("人工验证");
    expect(reasons[4]).toContain("限流");
    harness.close();
  });

  it("keeps stale plan id editor DOM, writes and the picker dialog out of the page", async () => {
    const harness = await mountSettled("/settings", statePayload({ claim: claimOverview() }), {
      controlReply: choicesReply([]) as never,
    });
    expect(harness.find('[data-dialog="claim-picker"]')).toBeNull();
    expect(harness.role("settings-claimPlanAdd")).toBeNull();
    expect(harness.role("settings-claimPlanChips")).toBeNull();
    expect(harness.find('[data-action="claim-activity-add"]')).toBeNull();
    expect(harness.calls.filter((call) => (call.body as { patch?: unknown } | null)?.patch !== undefined)).toHaveLength(0);
    harness.close();
  });
});

/** 只读文本节点的当前内容；空节点返回空串。*/
function harness_role_text(harness: Harness, role: string): string {
  return harness.role(role)?.textContent ?? "";
}
