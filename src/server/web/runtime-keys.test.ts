/**
 * API key 页（用量链接与行内动作）。
 *
 * 脚手架见 `runtime-harness.ts`。
 */

import { describe, expect, it } from "bun:test";
import { installHarnessHooks, cell, commands, mountSettled, nodes, statePayload } from "./runtime-harness.js";
import type { Call, Harness, PageNode } from "./runtime-harness.js";

installHarnessHooks();

describe("keys page — usage links to the log page", () => {
  it("wraps the today and total usage numbers in links carrying the key filter", async () => {
    const harness = await mountSettled("/keys", statePayload(), {
      apiKeys: [
        { id: "k001", name: "laptop", prefix: "sk-zcp-abc", enabled: true, usage: { requests: 12, inputTokens: 100, outputTokens: 200, errors: 1, lastUsedAt: null, todayRequests: 3, todayDate: "" } },
      ],
    });

    const links = [...harness.win.document.querySelectorAll('a[href="/logs?tab=requests&key=k001"]')];
    expect(links).toHaveLength(2);
    expect(links[0]?.textContent).toBe("3");
    expect(links[1]?.textContent).toContain("12 次");
    harness.close();
  });
});

/* ------------------------------------------------------------------------- */
/* keys 页的行内控件（状态徽章 / 归零 / 删除 + 两行累计塔）                          */
/* ------------------------------------------------------------------------- */

describe("keys row actions", () => {
  /** 一行 key：默认给一份长到能把「累计」列顶宽的真实用量。*/
  function apiKey(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "k001",
      name: "laptop",
      prefix: "sk-zcp-abc",
      enabled: true,
      usage: {
        requests: 18412,
        inputTokens: 60_512_345,
        outputTokens: 10_204_881,
        errors: 106,
        lastUsedAt: null,
        todayRequests: 214,
        todayDate: "",
      },
      ...overrides,
    };
  }

  /** 第一行的操作组（`td.cell-actions > .cell-actions`）。*/
  function actionsOf(harness: Harness): PageNode {
    const row = harness.rows("keys-body")[0] as PageNode;
    return row.querySelector("td .cell-actions") as PageNode;
  }

  /** 这一页进入时自己会取一次 `listApiKeys`；用例只看「点一下发出去了什么」。*/
  function writes(harness: Harness): Call[] {
    return commands(harness).filter(
      (call) => (call.body as { cmd?: string } | null)?.cmd !== "listApiKeys",
    );
  }

  it("shows the state as a badge that toggles the key off in one click", async () => {
    const harness = await mountSettled("/keys", statePayload(), { apiKeys: [apiKey()] });
    const badge = nodes(actionsOf(harness), ":scope > *")[0] as PageNode;

    expect(badge.textContent).toBe("启用");
    expect(badge.className).toBe("tag tag--toggle tag--ok");
    /* 徽章同时是控件：状态进 `aria-pressed`，解释进 `title`（开关时代靠 aria-label，
       徽章的可见文字就是状态，所以不再重复一遍）。*/
    expect(badge.getAttribute("aria-pressed")).toBe("true");
    expect(badge.title).toBe("点击停用这把 key：客户端下一个请求会收到 401，key 本身与用量都保留");

    harness.click(badge);
    await harness.settle();
    expect(writes(harness)[0]?.body).toEqual({ cmd: "setApiKeyEnabled", id: "k001", enabled: false });
    harness.close();
  });

  it("renders a disabled key as a danger badge that re-enables it", async () => {
    const harness = await mountSettled("/keys", statePayload(), { apiKeys: [apiKey({ enabled: false })] });
    const badge = nodes(actionsOf(harness), ":scope > *")[0] as PageNode;

    expect(badge.textContent).toBe("停用");
    expect(badge.className).toBe("tag tag--toggle tag--danger");
    expect(badge.getAttribute("aria-pressed")).toBe("false");
    expect(badge.title).toBe("点击重新启用这把 key");

    harness.click(badge);
    await harness.settle();
    expect(writes(harness)[0]?.body).toEqual({ cmd: "setApiKeyEnabled", id: "k001", enabled: true });
    harness.close();
  });

  it("puts the three row controls on the 28px tier, 归零 shrunk to two characters", async () => {
    const harness = await mountSettled("/keys", statePayload(), { apiKeys: [apiKey()] });
    const actions = actionsOf(harness);
    const parts = nodes(actions, ":scope > *");
    expect(parts.map((node) => node.textContent)).toEqual(["启用", "归零", "删除"]);

    const reset = parts[1] as PageNode;
    expect(reset.className).toBe("btn btn--sm");
    /* 标题把「归零」省下的两个字说回来（“用量”进了 title）。*/
    expect(reset.title).toBe("把累计与今日的用量清零（请求日志不受影响）");

    /* 危险动作必须与旁边的「归零」一眼分得开：安静的危险色，不是实心红块。*/
    const remove = parts[2] as PageNode;
    expect(remove.className).toBe("btn btn--sm btn--danger-quiet");

    harness.click(reset);
    await harness.settle();
    expect(writes(harness)[0]?.body).toEqual({ cmd: "resetApiKeyUsage", id: "k001" });
    harness.close();
  });

  it("still routes delete through the shared confirm modal", async () => {
    const harness = await mountSettled("/keys", statePayload(), { apiKeys: [apiKey()] });
    harness.click(nodes(actionsOf(harness), ":scope > *")[2] as PageNode);
    await harness.settle();

    expect(harness.role("confirm-modal")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("confirm-title")?.textContent).toBe("删除 laptop？");
    /* 没有任何写命令被发出去：删除只在确认之后才发生。*/
    expect(writes(harness)).toHaveLength(0);
    harness.close();
  });

  it("splits the lifetime usage into a two-line tower inside one log link", async () => {
    const harness = await mountSettled("/keys", statePayload(), { apiKeys: [apiKey()] });
    const row = harness.rows("keys-body")[0] as PageNode;
    /* 列序（没有「状态」列）：名称 / 前缀 / 今日 / 累计 / 最后使用 / 操作 */
    expect(nodes(row, "td")).toHaveLength(6);
    const tower = (cell(row, 3) as PageNode).querySelector(".usage-tower") as PageNode;
    expect(tower.tagName).toBe("A");
    expect(tower.getAttribute("href")).toBe("/logs?tab=requests&key=k001");
    const lines = nodes(tower, ":scope > *");
    expect(lines.map((node) => node.textContent)).toEqual(["18k 次", "入 60.5m · 出 10.2m · 错 106"]);
    /* 第二行降一档字号（`.usage-tower__more`），两行同宽才不把列顶宽。*/
    expect((lines[1] as PageNode).className).toBe("usage-tower__more");
    harness.close();
  });
});

/* ------------------------------------------------------------------------- */
/* Key 列的掩码 / 显示 / 复制（存储层存密文，listApiKeys 解密带回）               */
/*                                                                         */
/* 默认掩码 `sk-zcp-a1b2••••••••`；「显示 / 隐藏」切换完整值（等宽字体）；        */
/* 「复制」走 navigator.clipboard + toast 确认，剪贴板不可用就展开并选中（降级     */
/* 路径借道同一颗 toast）。5.0 契约：每条记录必有 secret，Key 列没有第三态。      */
/* ------------------------------------------------------------------------- */
describe("keys page — mask, reveal, copy", () => {
  /** 一把带密文的 key（生产形态：manager.create 落盘，listApiKeys 解密带回）。*/
  function secretKey(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "k101",
      name: "laptop",
      prefix: "sk-zcp-a1b2",
      enabled: true,
      secret: "sk-zcp-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y",
      usage: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        errors: 0,
        lastUsedAt: null,
        todayRequests: 0,
        todayDate: "",
      },
      ...overrides,
    };
  }

  /** Key 列（第二个 td）的整格。*/
  function keyCellOf(harness: Harness): PageNode {
    return cell(harness.rows("keys-body")[0] as PageNode, 1) as PageNode;
  }

  /** Key 列格内组（`.key-cell`）与它的三件（值 / 显示 / 复制）。*/
  function partsOf(harness: Harness): PageNode[] {
    return nodes(keyCellOf(harness), "span, button");
  }

  function stubClipboard(harness: Harness): { written: string[] } {
    const written: string[] = [];
    Object.defineProperty(harness.win.navigator, "clipboard", {
      value: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
      configurable: true,
    });
    return { written };
  }

  it("masks the key by default and never puts the plaintext in the DOM", async () => {
    const harness = await mountSettled("/keys", statePayload(), { apiKeys: [secretKey()] });
    expect(keyCellOf(harness).textContent).toContain("sk-zcp-a1b2••••••••");
    expect(keyCellOf(harness).textContent).not.toContain("sk-zcp-a1b2c3d4");
    harness.close();
  });

  it("reveals the full value on 显示 and hides it again on 隐藏", async () => {
    const harness = await mountSettled("/keys", statePayload(), { apiKeys: [secretKey()] });
    const parts = partsOf(harness);
    expect(parts.map((node) => node.textContent)).toEqual(["sk-zcp-a1b2••••••••", "显示", "复制"]);

    harness.click(parts[1] as PageNode);
    await harness.settle();
    const revealedParts = partsOf(harness);
    expect(revealedParts[0]?.textContent).toBe("sk-zcp-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y");
    expect(revealedParts[0]?.className).toContain("mono");
    expect(revealedParts.map((node) => node.textContent)).toEqual([
      "sk-zcp-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y",
      "隐藏",
      "复制",
    ]);

    // 切回掩码：明文从 DOM 里消失（本页生存期内的展开状态不落任何存储）。
    harness.click(revealedParts[1] as PageNode);
    await harness.settle();
    expect(keyCellOf(harness).textContent).toContain("sk-zcp-a1b2••••••••");
    expect(keyCellOf(harness).textContent).not.toContain("sk-zcp-a1b2c3d4");
    harness.close();
  });

  it("copies the full key to the clipboard and confirms with a toast", async () => {
    const harness = await mountSettled("/keys", statePayload(), { apiKeys: [secretKey()] });
    const clipboard = stubClipboard(harness);

    harness.click(partsOf(harness)[2] as PageNode);
    await harness.settle();

    expect(clipboard.written).toEqual(["sk-zcp-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y"]);
    const toast = harness.role("toast");
    expect(toast?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("toast-text")?.textContent).toBe("已复制到剪贴板。");
    harness.close();
  });

  it("falls back to reveal + select when the clipboard is unavailable", async () => {
    const harness = await mountSettled("/keys", statePayload(), { apiKeys: [secretKey()] });
    // 剪贴板缺席（非安全上下文同形）：defineProperty 一个没有 writeText 的值。
    Object.defineProperty(harness.win.navigator, "clipboard", { value: {}, configurable: true });

    harness.click(partsOf(harness)[2] as PageNode);
    await harness.settle();

    // 降级 = 展开该行 + 选中完整值文本 + 同一颗 toast 说「按 Ctrl/Cmd+C」。
    expect(keyCellOf(harness).textContent).toContain("sk-zcp-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y");
    const selection = harness.win.getSelection();
    expect(selection?.toString()).toBe("sk-zcp-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y");
    expect(harness.role("toast-text")?.textContent).toBe("已选中完整 key，按 Ctrl/Cmd+C 复制。");
    harness.close();
  });

});
