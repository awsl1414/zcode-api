/**
 * 页面的**行为**测试：把真正拼出来的页面 + 真正的 `app.js` 放进 happy-dom 跑一遍。
 *
 * 为什么不用「把渲染函数导出再单测」那条路：页面的逻辑住在浏览器脚本里（零构建链，
 * 见 `app.js` 文件头），导出就得把同一份逻辑写成 Node 模块再抄一遍。这里让测试驱动
 * **最终产物**：`document.write(renderPanelPage())` 拿到真实 DOM，再把 `app.js` 原文
 * 在 window 作用域里执行一次，`fetch` 换成可编程的桩，断言的就是用户看到的东西。
 *
 * 用例按视图拆到 `runtime-*.test.ts`（每个文件独立进程，单文件的内存峰值
 * 只按一个视图算）；共享脚手架在 `runtime-harness.ts`。
 *
 * 覆盖账号页的交互契约：状态合并列 / 额度百分比 / 展开行 / 步进器边界 /
 * 删除默认 drain 与 force 二次确认 / 路由策略读写往返 / 矩阵派生。
 */

import { describe, expect, it } from "bun:test";
import { installHarnessHooks, mountSettled, statePayload } from "./runtime-harness.js";

installHarnessHooks();

/* ------------------------------------------------------------------------- */
/* 视图切换                                                                    */
/* ------------------------------------------------------------------------- */

describe("page views", () => {
  it("shows the accounts view at /accounts and hides the others", async () => {
    const harness = await mountSettled("/accounts", statePayload());
    expect(harness.role("page-accounts-body")).not.toBeNull();
    expect(harness.find('[data-view="accounts"]')?.hasAttribute("hidden")).toBe(false);
    expect(harness.find('[data-view="overview"]')?.hasAttribute("hidden")).toBe(true);
    expect(harness.find('[data-view="routing"]')?.hasAttribute("hidden")).toBe(true);
  });

  it("shows the routing view at /routing and marks the nav item current", async () => {
    const harness = await mountSettled("/routing", statePayload());
    expect(harness.find('[data-view="routing"]')?.hasAttribute("hidden")).toBe(false);
    const nav = harness.find('[data-nav="routing"]');
    expect(nav?.className).toContain("nav--active");
    expect(nav?.getAttribute("aria-current")).toBe("page");
  });

  it("falls back to the overview at /", async () => {
    const harness = await mountSettled("/", statePayload());
    expect(harness.find('[data-view="overview"]')?.hasAttribute("hidden")).toBe(false);
    expect(harness.find('[data-nav="overview"]')?.className).toContain("nav--active");
  });
});
