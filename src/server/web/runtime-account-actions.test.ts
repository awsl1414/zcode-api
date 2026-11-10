/**
 * 账号页的行内动作：并发步进器 / 流量占比 / 启停开关 / 删除 / 批量操作。
 *
 * 与 `runtime-accounts.test.ts` 分开是为了内存：那一组每个 it 都挂一份完整面板 DOM，
 * 单跑都在 2 GB 以内。脚手架见 `runtime-harness.ts`。
 */

import { describe, expect, it } from "bun:test";
import type { StatePayload } from "../routes-state.js";
import { installHarnessHooks, account, cell, commands, menuButton, mountSettled, nodes, quota, statePayload } from "./runtime-harness.js";
import type { ControlReply, Harness, PageNode } from "./runtime-harness.js";

installHarnessHooks();

/* ------------------------------------------------------------------------- */
/* 并发步进器                                                                  */
/* ------------------------------------------------------------------------- */

describe("concurrency stepper", () => {
  /** 步进器里的两个按钮（`−` / `+`）与数值（复选框列在并发之前，索引 +1）。*/
  function stepper(harness: Harness): { minus: PageNode; plus: PageNode; value: PageNode } {
    const target = cell(harness.rows("page-accounts-body")[0], 4);
    const buttons = nodes(target, "button");
    return {
      minus: buttons[0] as PageNode,
      plus: buttons[1] as PageNode,
      value: target?.querySelector(".stepper__value") as PageNode,
    };
  }

  it("sends +1 / -1 as setAccountConcurrency", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account({ maxConcurrency: 2 })] }));
    const { plus, minus } = stepper(harness);

    harness.click(plus);
    await harness.settle();
    harness.click(minus);
    await harness.settle();

    expect(commands(harness).map((call) => call.body)).toEqual([
      { cmd: "setAccountConcurrency", label: "work-team", maxConcurrency: 3 },
      { cmd: "setAccountConcurrency", label: "work-team", maxConcurrency: 1 },
    ]);
    // 写入成功后立即刷新服务端真值：1 次首读 + 2 次写后刷新
    expect(harness.calls.filter((call) => call.url === "/api/state")).toHaveLength(3);
  });

  it("allows 0 (soft-disable) and marks it as such", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account({ maxConcurrency: 1 })] }));
    harness.click(stepper(harness).minus);
    await harness.settle();

    expect(commands(harness)[0]?.body).toEqual({
      cmd: "setAccountConcurrency",
      label: "work-team",
      maxConcurrency: 0,
    });

    // 服务端回读到 0 之后，页面用告警色标出「软禁用」
    harness.state = statePayload({ accounts: [account({ maxConcurrency: 0 })] });
    await harness.refresh();
    expect(stepper(harness).value.textContent).toBe("0");
    expect(stepper(harness).value.className).toBe("stepper__value stepper__value--soft-off");
  });

  it("refuses to send a negative concurrency and explains why (页顶 + 行内两处)", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account({ maxConcurrency: 0 })] }));
    harness.click(stepper(harness).minus);
    await harness.settle();

    // 一条命令都不发：负数是页面先拒的（服务端 `isNonNegativeInteger` 同口径）。
    expect(commands(harness)).toHaveLength(0);
    /* 页顶横幅保留作汇总，出问题的那一行下面再贴一条：长表格里横幅不在视野内，
       只有行内那条才能说明「是这一行被拒了」。 */
    expect(harness.role("accounts-error")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("accounts-error-text")?.textContent).toContain("并发不能为负");
    const rowError = harness.find('[data-row-error="work-team"]');
    expect(rowError?.textContent).toContain("并发不能为负");
  });

  it("lets the inline row note expire instead of leaving it to be dismissed", async () => {
    /* 提示的寿命是一拍轮询（`ROW_FAILURE_TTL_MS`）：它没有关闭按钮，到期后下一次
       重画就不再画出来。把 TTL 拧成 0 驱动同一条逻辑，不等真时钟。 */
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account({ maxConcurrency: 0 })] }));
    (harness.win as unknown as { __zcodeApp: { const: { ROW_FAILURE_TTL_MS: number } } }).__zcodeApp.const.ROW_FAILURE_TTL_MS = 0;
    harness.click(stepper(harness).minus);
    await harness.settle();

    expect(commands(harness)).toHaveLength(0);
    /* 已经过期的提示不会被画出来；页顶横幅仍在（它要人看见）。 */
    expect(harness.find('[data-row-error="work-team"]')).toBeNull();
    expect(harness.role("accounts-error")?.hasAttribute("hidden")).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* 流量占比（weight 的唯一有意义口径）                                         */
/* ------------------------------------------------------------------------- */

describe("traffic share", () => {
  /** 某行里流量占比列的百分比按钮。*/
  function shareButton(row: PageNode | undefined): PageNode {
    return row?.querySelector("[data-share-button]") as PageNode;
  }

  /** 点开某行的占比浮层，返回浮层。*/
  function openPopover(harness: Harness, row: PageNode): PageNode {
    harness.click(shareButton(row));
    return row.querySelector(".share-pop") as PageNode;
  }

  /** 一行一个账号，权重按数组给。*/
  function weightsState(weights: number[]): StatePayload {
    return statePayload({
      accounts: weights.map((weight, index) => account({ label: `a${index}`, weight })),
    });
  }

  function shares(harness: Harness): (string | null)[] {
    return [...harness.rows("page-accounts-body")].map((row) => shareButton(row).textContent);
  }

  it("shows weight normalized over all accounts (8 equal accounts → 12.5% each)", async () => {
    /* 任务书里点名的那条：全部账号同档 = 均分，12.5% 是**正确预期**，不是舍入 bug。*/
    const harness = await mountSettled("/accounts", weightsState([1, 1, 1, 1, 1, 1, 1, 1]));
    expect(shares(harness)).toEqual(["12.5%", "12.5%", "12.5%", "12.5%", "12.5%", "12.5%", "12.5%", "12.5%"]);
  });

  it("recomputes every row when one weight changes (share = weight ÷ Σ all weights)", async () => {
    const harness = await mountSettled("/accounts", weightsState([1, 1, 1, 1]));
    const row = harness.rows("page-accounts-body")[0] as PageNode;
    const pop = openPopover(harness, row);
    expect(pop.hasAttribute("hidden")).toBe(false);

    // 权重 1 → 2：服务端真值跟着变（回读时拿到的就是它）
    harness.state = weightsState([2, 1, 1, 1]);
    harness.click(nodes(pop, ".stepper__btn")[1] as PageNode);
    await harness.settle();

    expect(commands(harness).at(-1)?.body).toEqual({ cmd: "setAccountWeight", label: "a0", weight: 2 });
    // 2 / (2+1+1+1) = 40%，其余各 20%：改一个，全表联动。
    expect(shares(harness)).toEqual(["40%", "20%", "20%", "20%"]);
  });

  it("keeps the popover open across the re-read it triggers, and lowers/raises by one", async () => {
    const harness = await mountSettled("/accounts", weightsState([1, 1, 1, 1]));
    const pop = openPopover(harness, harness.rows("page-accounts-body")[0] as PageNode);
    // 下界 1：`−` 直接禁用，不发命令（服务端 isPositiveInteger 同口径）
    expect((nodes(pop, ".stepper__btn")[0] as PageNode).disabled).toBe(true);

    harness.state = weightsState([2, 1, 1, 1]);
    harness.click(nodes(pop, ".stepper__btn")[1] as PageNode);
    await harness.settle();

    /* 浮层里的步进器每点一下就要回读一次，整表重画之后浮层必须还在（弹开状态
       记在视图模块里），否则调一档就得重新点开一次。 */
    const reopened = harness.rows("page-accounts-body")[0]?.querySelector(".share-pop") as PageNode;
    expect(reopened.hasAttribute("hidden")).toBe(false);
    expect(reopened.querySelector(".stepper__value")?.textContent).toBe("2");

    // 再点一下变成 3，占比跟着重算（3 / (3+1+1+1) = 50%）
    harness.state = weightsState([3, 1, 1, 1]);
    harness.click(nodes(reopened, ".stepper__btn")[1] as PageNode);
    await harness.settle();
    expect(commands(harness).at(-1)?.body).toEqual({ cmd: "setAccountWeight", label: "a0", weight: 3 });
    expect(shares(harness)[0]).toBe("50%");
  });

  it("says why the weight stepper refused to go below 1 (越界不再静默)", async () => {
    const harness = await mountSettled("/accounts", weightsState([1]));
    const row = harness.rows("page-accounts-body")[0] as PageNode;
    const pop = openPopover(harness, row);
    const minus = nodes(pop, ".stepper__btn")[0] as PageNode;
    /* 到 1 时 `−` 直接禁用（与并发步进器到 0 同一判据）；再点一次不发命令。 */
    expect(minus.disabled).toBe(true);
    harness.click(minus);
    await harness.settle();
    expect(commands(harness)).toHaveLength(0);
  });

  it("shows the actual share and states the formula in the popover", async () => {
    const harness = await mountSettled("/accounts", weightsState([1, 3]));
    const pop = openPopover(harness, harness.rows("page-accounts-body")[0] as PageNode);
    expect(pop.textContent).toContain("实际占比 25%");
    expect(pop.textContent).toContain("占比 = 本账号权重 ÷ 全部账号权重之和");
  });

  it("closes on Esc and on an outside click, and does not open the drawer", async () => {
    const harness = await mountSettled("/accounts", weightsState([1, 2]));
    const row = harness.rows("page-accounts-body")[0] as PageNode;
    const pop = openPopover(harness, row);
    // 点开占比不弹详情窗（控件上的点击不切行，守卫；详情是大窗）
    expect(harness.find('[data-dialog="account"]')?.hasAttribute("hidden")).toBe(true);

    harness.click(harness.find('[data-role="page-accounts-table"] thead') as PageNode);
    expect(pop.hasAttribute("hidden")).toBe(true);

    harness.click(shareButton(harness.rows("page-accounts-body")[0] as PageNode));
    harness.win.document.dispatchEvent(new harness.win.KeyboardEvent("keydown", { key: "Escape" }));
    expect((harness.rows("page-accounts-body")[0]?.querySelector(".share-pop") as PageNode).hasAttribute("hidden")).toBe(
      true,
    );
    // 收起之后不再自己弹开（弹开状态随 closeMenus 一起清掉）
    await harness.refresh();
    expect((harness.rows("page-accounts-body")[0]?.querySelector(".share-pop") as PageNode).hasAttribute("hidden")).toBe(
      true,
    );
  });

  it("equalizes every account to the smallest current weight in one batch", async () => {
    /* 均分 = 把全部账号设成同一个值（取当前最小值，下界 1）：比例相等，改动条数最少。*/
    const harness = await mountSettled("/accounts", weightsState([1, 2, 3]));
    const pop = openPopover(harness, harness.rows("page-accounts-body")[0] as PageNode);
    harness.click(nodes(pop, ".menu__item")[0] as PageNode);
    await harness.settle();

    // 本来就已经是 1 的 a0 不发命令，只改 a1 / a2
    expect(commands(harness).map((call) => call.body)).toEqual([
      { cmd: "setAccountWeight", label: "a1", weight: 1 },
      { cmd: "setAccountWeight", label: "a2", weight: 1 },
    ]);
    /* 批量收尾只回读一次（不是每条命令一次）：初始挂载 1 次 + 收尾 1 次 = 2 次。*/
    expect(harness.calls.filter((call) => call.url === "/api/state")).toHaveLength(2);
  });

  it("says so when weights are already equal", async () => {
    const harness = await mountSettled("/accounts", weightsState([2, 2]));
    const pop = openPopover(harness, harness.rows("page-accounts-body")[0] as PageNode);
    harness.click(nodes(pop, ".menu__item")[0] as PageNode);
    await harness.settle();

    expect(commands(harness)).toHaveLength(0);
    expect(harness.role("accounts-notice-text")?.textContent).toBe("已经是均分，无需改动。");
  });

  it("no longer carries a weight input in the row menu", async () => {
    const harness = await mountSettled("/accounts", weightsState([1]));
    const row = harness.rows("page-accounts-body")[0] as PageNode;
    expect(row.querySelector("[data-row-menu] input")).toBeNull();
    // 菜单里只剩动作三项，「刷新额度」也在其中
    expect(nodes(row.querySelector("[data-row-menu] .menu"), ".menu__item").map((item) => item.textContent)).toEqual([
      "暂停",
      "刷新额度",
      "删除",
    ]);
  });
});

/* ------------------------------------------------------------------------- */
/* 启停                                                                        */
/* ------------------------------------------------------------------------- */

describe("enabled switch", () => {
  it("sends setAccountEnabled from the row menu's pause item (菜单收纳)", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account({ enabled: true })] }));
    const row = harness.rows("page-accounts-body")[0] as PageNode;
    harness.click(menuButton(row));
    const item = row.querySelector('[data-menu-action="toggle-enabled"]') as PageNode;
    expect(item?.textContent).toBe("暂停");
    harness.click(item);
    await harness.settle();

    // 关闭不带 force：服务端按 drain 处理
    expect(commands(harness)[0]?.body).toEqual({ cmd: "setAccountEnabled", label: "work-team", enabled: false });
  });

  it("tells the user how many inflight requests were aborted", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account({ enabled: true })] }));
    harness.controlReply = { ok: true, event: "accountEnabled", aborted: 2 };
    const row = harness.rows("page-accounts-body")[0] as PageNode;
    harness.click(menuButton(row));
    harness.click(row.querySelector('[data-menu-action="toggle-enabled"]') as PageNode);
    await harness.settle();

    expect(harness.role("accounts-notice")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("accounts-notice-text")?.textContent).toContain("2");
  });
});

/* ------------------------------------------------------------------------- */
/* 刷新额度（停用账号的唯一采样入口）                                          */
/* ------------------------------------------------------------------------- */

describe("row menu — refresh quota", () => {
  /** 打开第一行的 ⋯ 菜单并点「刷新额度」。*/
  function clickRefresh(harness: Harness): void {
    const row = harness.rows("page-accounts-body")[0] as PageNode;
    harness.click(menuButton(row));
    harness.click(row.querySelector('[data-menu-action="refresh-quota"]') as PageNode);
  }

  it("samples a disabled account once through the quota + label path", async () => {
    /* 停用账号进不了任何自动采样（启动探测跳过、周期采样看健康与活跃度），
       行菜单是它唯一的入口：发的是详情大窗那颗「刷新」同款的 quota + label。*/
    const harness = await mountSettled(
      "/accounts",
      statePayload({ accounts: [account({ enabled: false, quota: null })] }),
    );
    harness.state = statePayload({
      accounts: [
        account({
          enabled: false,
          quota: quota({ windows: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 40 }] }),
        }),
      ],
    });
    harness.controlReply = { ok: true, event: "quotaRefreshed" } as ControlReply;
    clickRefresh(harness);
    await harness.settle();

    expect(commands(harness).map((call) => call.body)).toEqual([{ cmd: "quota", label: "work-team" }]);
    // 成功后 dispatch 自己回读 /api/state，额度列从「未采样」换成数值
    // （最紧窗口 40% 已用 → 剩 60%）。
    const quotaCell = cell(harness.rows("page-accounts-body")[0], 6);
    expect(quotaCell?.textContent).not.toBe("未采样");
    expect(quotaCell?.textContent).toContain("剩 60%");
  });

  it("disables the row's ⋯ while the sample is in flight and restores it afterwards", async () => {
    /* 一次采样要打上游，几秒内连点会发多条命令（30s 去重会吃掉重复采样，但用户
       看不见反馈）。在途时置灰，返回后恢复。*/
    let release: (() => void) | undefined;
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account({ quota: null })] }));
    /* 拦下这一次控制请求，让采样停在「在途」上。*/
    const fetch = harness.win.fetch;
    (harness.win as unknown as { fetch: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }) => {
      if (url === "/api/control" && init?.body && (JSON.parse(init.body) as { cmd?: string }).cmd === "quota") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return fetch(url, init);
    };

    clickRefresh(harness);
    await harness.settle();
    const mid = harness.rows("page-accounts-body")[0]?.querySelector("[data-menu-button]") as PageNode;
    expect(mid.disabled).toBe(true);

    release?.();
    await harness.settle();
    const after = harness.rows("page-accounts-body")[0]?.querySelector("[data-menu-button]") as PageNode;
    expect(after.disabled).toBe(false);
  });

  it("surfaces a failed sample as a banner and keeps the row usable", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account({ quota: null })] }));
    harness.controlReply = { ok: false, error: "quota_unavailable" } as ControlReply;
    clickRefresh(harness);
    await harness.settle();

    expect(harness.role("accounts-error")?.hasAttribute("hidden")).toBe(false);
    expect(harness.role("accounts-error-text")?.textContent).toBe("额度不可用。");
    // 失败之后 ⋯ 恢复可点（不把这一行卡在禁用态上）。
    const button = harness.rows("page-accounts-body")[0]?.querySelector("[data-menu-button]") as PageNode;
    expect(button.disabled).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* 删除：默认 drain / force 二次确认                                          */
/* ------------------------------------------------------------------------- */

describe("delete account", () => {
  /** 从行尾菜单打开删除模态（⋯ 菜单收纳低频操作），返回确认按钮。*/
  function openDelete(harness: Harness): PageNode {
    const row = harness.rows("page-accounts-body")[0] as PageNode;
    harness.click(menuButton(row));
    harness.click(row.querySelector('[data-menu-action="delete"]') as PageNode);
    return harness.role("delete-confirm") as PageNode;
  }

  it("drains by default: one click sends drain: true", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account({ inflight: 1 })] }));
    const confirm = openDelete(harness);
    expect(harness.role("delete-modal")?.hasAttribute("hidden")).toBe(false);

    harness.click(confirm);
    await harness.settle();

    expect(commands(harness)[0]?.body).toEqual({ cmd: "removeAccount", label: "work-team", drain: true });
    expect(harness.role("delete-modal")?.hasAttribute("hidden")).toBe(true);
  });

  it("closes on Esc and returns focus to the row's ⋯ button", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account()] }));
    const row = harness.rows("page-accounts-body")[0] as PageNode;
    const trigger = menuButton(row);
    openDelete(harness);
    expect(harness.role("delete-modal")?.hasAttribute("hidden")).toBe(false);

    harness.win.document.dispatchEvent(new harness.win.KeyboardEvent("keydown", { key: "Escape" }));
    expect(harness.role("delete-modal")?.hasAttribute("hidden")).toBe(true);
    expect(commands(harness)).toHaveLength(0);
    // 来源是 ⋯ 菜单：菜单项已经收起，焦点落回同一行的触发按钮（不是 body）。
    const currentTrigger = menuButton(harness.rows("page-accounts-body")[0] as PageNode);
    expect(harness.win.document.activeElement === (currentTrigger as unknown)).toBe(true);
    expect(harness.win.document.activeElement).not.toBe(harness.win.document.body);
    expect(trigger).not.toBeNull();
  });

  it("keeps the confirm button disabled while removeAccount is in flight", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account()] }));
    const confirm = openDelete(harness);

    let release: (() => void) | undefined;
    let inFlight = 0;
    const realFetch = harness.win.fetch;
    (harness.win as unknown as { fetch: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }) => {
      if (url === "/api/control" && init?.body && (JSON.parse(init.body) as { cmd?: string }).cmd === "removeAccount") {
        inFlight += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return realFetch(url, init as never);
    };

    harness.click(confirm);
    await harness.settle();
    expect(inFlight).toBe(1);
    expect(harness.role("delete-confirm")?.disabled).toBe(true);
    // 再点一次不会发第二条（按钮已禁用，模态还开着）。
    harness.click(harness.role("delete-confirm"));
    await harness.settle();
    expect(inFlight).toBe(1);

    release?.();
    await harness.settle();
    expect(harness.role("delete-modal")?.hasAttribute("hidden")).toBe(true);
    expect(commands(harness).map((call) => (call.body as { cmd?: string }).cmd)).toEqual(["removeAccount"]);
  });

  it("warns about inflight requests before deleting", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account({ inflight: 3 })] }));
    openDelete(harness);
    expect(harness.role("delete-modal-hint")?.textContent).toContain("3");
  });

  it("needs a second confirmation to force (drain: false)", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account()] }));
    const confirm = openDelete(harness);

    // 勾上「强制中断」后第一次点击只升级按钮，不发命令
    harness.change(harness.role("delete-force"), "", true);
    harness.click(confirm);
    await harness.settle();
    expect(commands(harness)).toHaveLength(0);
    expect(harness.role("delete-confirm")?.textContent).toBe("再次确认强制删除");
    expect(harness.role("delete-confirm")?.className).toBe("btn btn--danger");

    // 第二次点击才真的强制删除
    harness.click(harness.role("delete-confirm"));
    await harness.settle();
    expect(commands(harness)[0]?.body).toEqual({ cmd: "removeAccount", label: "work-team", drain: false });
  });

  it("disarms the confirm button when force is unticked again", async () => {
    const harness = await mountSettled("/accounts", statePayload({ accounts: [account()] }));
    const confirm = openDelete(harness);
    harness.change(harness.role("delete-force"), "", true);
    harness.click(confirm);
    await harness.settle();
    expect(harness.role("delete-confirm")?.textContent).toBe("再次确认强制删除");

    harness.change(harness.role("delete-force"), "", false);
    expect(harness.role("delete-confirm")?.textContent).toBe("删除");
  });
});
