/**
 * getCaptchaToken acquisition semantics:
 * pool-first degradation through configs-fetch outages (banked tokens are
 * never stranded by a flaky configs endpoint), fresh authoritative disable
 * beats the pool, and a strict throw only when no config history exists.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { bindCaptchaPools } from "../accounts/runtime.js";
import { accountFor, inMemoryAccounts, zhipuCredential } from "../accounts/testing.js";

const solveMock = mock(async () => "t".repeat(64));

mock.module("./captcha-solver.js", () => ({
  runCaptchaSolve: solveMock,
  shutdownCaptchaSolver: () => {},
  setCaptchaSolverConcurrency: () => {},
  captchaSolverConcurrency: () => 2,
  CAPTCHA_NODE_DIR: "/tmp",
}));

const captcha = await import("./captcha.js");
// 池入口（captcha-pool.ts）单独取：captcha.ts 只做配置快照 + 取 token，
// 按账号停池 / 池实例断言这些入口在池模块上。mock.module 已先注册，所以这里
// 拿到的是同一个被 mock 过 solver 的实例。
const pools = await import("./captcha-pool.js");

const ENABLED_BODY = JSON.stringify({
  data: { configs: { captcha: { enabled: true, prefix: "no8xfe", sceneId: "11xygtvd", region: "sgp" } } },
});
const DISABLED_BODY = JSON.stringify({
  data: { configs: { captcha: { enabled: false, prefix: "no8xfe", sceneId: "11xygtvd", region: "sgp" } } },
});
const jsonResp = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "application/json" } });

describe("getCaptchaToken — pool-first degradation", () => {
  beforeEach(() => {
    solveMock.mockClear();
    captcha.__resetCaptchaConfigCacheForTests();
  });
  afterEach(() => {
    captcha.__setConfigsFetchForTests(null);
    try { captcha.shutdownCaptcha(); } catch { /* pool never started */ }
  });

  it("serves tokens through a configs-fetch outage instead of stranding the pool", async () => {
    // Live regression (2026-10-23 #002): configs endpoint flaked for ~45s and
    // 16 acquisition retries burned the whole budget while the pool had stock.
    let outage = false;
    captcha.__setConfigsFetchForTests((async () => {
      if (outage) throw new Error("network blip");
      return jsonResp(ENABLED_BODY);
    }) as unknown as typeof fetch);

    const first = await captcha.getCaptchaToken("test-1.0.0", "acct-test");
    expect(first?.region).toBe("sgp");
    expect(first?.verifyParam.length).toBeGreaterThan(0);

    // The 1h config snapshot expires mid-outage — the refresh now fails.
    outage = true;
    captcha.__resetCaptchaConfigCacheForTests(true); // keep lastGood
    const second = await captcha.getCaptchaToken("test-1.0.0", "acct-test");
    expect(second).not.toBeNull(); // pool-first: banked token still served
    expect(second?.region).toBe("sgp"); // region from the last-good config
  });

  it("an authoritative disable beats banked tokens and survives the next refresh outage", async () => {
    let disabled = false;
    let outage = false;
    captcha.__setConfigsFetchForTests(
      (async () => {
        if (outage) throw new Error("network blip");
        return jsonResp(disabled ? DISABLED_BODY : ENABLED_BODY);
      }) as unknown as typeof fetch,
    );

    expect(await captcha.getCaptchaToken("test-1.0.0", "acct-test")).not.toBeNull();
    disabled = true;
    captcha.__resetCaptchaConfigCacheForTests(true); // see the fresh config now
    expect(await captcha.getCaptchaToken("test-1.0.0", "acct-test")).toBeNull(); // no headers is the correct shape
    outage = true;
    captcha.__resetCaptchaConfigCacheForTests(true);
    expect(await captcha.getCaptchaToken("test-1.0.0", "acct-test")).toBeNull(); // never resurrect the old enabled config
  });

  it("no config history + outage → strict throw (never dispatch captcha-less)", async () => {
    captcha.__setConfigsFetchForTests(
      (async () => {
        throw new Error("network blip");
      }) as unknown as typeof fetch,
    );
    await expect(captcha.getCaptchaToken("test-1.0.0", "acct-test")).rejects.toThrow("Captcha config unavailable");
  });
});

describe("fetchCaptchaConfig cadence — real-client mirror", () => {
  beforeEach(() => {
    solveMock.mockClear();
    captcha.__resetCaptchaConfigCacheForTests();
  });
  afterEach(() => {
    captcha.__setConfigsFetchForTests(null);
    try { captcha.shutdownCaptcha(); } catch { /* pool never started */ }
  });

  it("1h snapshot: repeated acquisitions share ONE configs fetch", async () => {
    let fetches = 0;
    captcha.__setConfigsFetchForTests((async () => {
      fetches++;
      return jsonResp(ENABLED_BODY);
    }) as unknown as typeof fetch);

    await captcha.getCaptchaToken("test-1.0.0", "acct-test");
    await captcha.getCaptchaToken("test-1.0.0", "acct-test");
    await captcha.getCaptchaToken("test-1.0.0", "acct-test");
    expect(fetches).toBe(1); // snapshot served from cache (mirror RRe=1h)
  });

  it("NO negative cache: a failed refresh retries the fetch on the very next call", async () => {
    let fail = true;
    let fetches = 0;
    captcha.__setConfigsFetchForTests((async () => {
      fetches++;
      if (fail) throw new Error("network blip");
      return jsonResp(ENABLED_BODY);
    }) as unknown as typeof fetch);

    // Old behavior neg-cached the failure for 15s; the mirror (host
    // getClientConfigs) leaves no failure marker — the next call refetches.
    await expect(captcha.getCaptchaToken("test-1.0.0", "acct-test")).rejects.toThrow("Captcha config unavailable");
    expect(fetches).toBe(1);
    fail = false;
    const token = await captcha.getCaptchaToken("test-1.0.0", "acct-test");
    expect(token).not.toBeNull();
    expect(fetches).toBe(2);
  });

  it("HTTP errors cancel their bodies and never poison the 1h snapshot", async () => {
    for (const status of [429, 503]) {
      captcha.__resetCaptchaConfigCacheForTests();
      let fetches = 0;
      let cancelled = false;
      captcha.__setConfigsFetchForTests((async () => {
        fetches++;
        if (fetches > 1) return jsonResp(DISABLED_BODY);
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ code: status, message: "temporary failure" })));
          },
          cancel() { cancelled = true; },
        }), { status, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch);

      await expect(captcha.getCaptchaToken("test-1.0.0", "acct-test")).rejects.toThrow("Captcha config unavailable");
      expect(cancelled).toBe(true);
      expect(await captcha.getCaptchaToken("test-1.0.0", "acct-test")).toBeNull();
      expect(fetches).toBe(2);
    }
  });

  it("a stalled JSON body times out, cancels its reader, and releases shared acquisitions", async () => {
    const savedTimeout = process.env.CAPTCHA_CONFIG_TIMEOUT_MS;
    process.env.CAPTCHA_CONFIG_TIMEOUT_MS = "20";
    let fetches = 0;
    let cancelled = false;
    let fetchSignal: AbortSignal | null | undefined;
    let stalledBody: ReadableStream<Uint8Array> | undefined;
    try {
      captcha.__setConfigsFetchForTests((async (_url: RequestInfo | URL, init?: RequestInit) => {
        fetches++;
        if (fetches > 1) return jsonResp(DISABLED_BODY);
        fetchSignal = init?.signal;
        stalledBody = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode('{"data":')); },
          cancel() { cancelled = true; },
        });
        return new Response(stalledBody, { headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch);

      const results = await Promise.allSettled([
        captcha.getCaptchaToken("test-1.0.0", "acct-test"),
        captcha.getCaptchaToken("test-1.0.0", "acct-test"),
      ]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(fetches).toBe(1);
      expect(fetchSignal?.aborted).toBe(true);
      expect(cancelled).toBe(true);
      expect(stalledBody?.locked).toBe(false);
      expect(await captcha.getCaptchaToken("test-1.0.0", "acct-test")).toBeNull();
      expect(fetches).toBe(2);
    } finally {
      if (savedTimeout === undefined) delete process.env.CAPTCHA_CONFIG_TIMEOUT_MS;
      else process.env.CAPTCHA_CONFIG_TIMEOUT_MS = savedTimeout;
    }
  });

  it("in-flight dedup: concurrent acquisitions share one configs fetch", async () => {
    let fetches = 0;
    captcha.__setConfigsFetchForTests((async () => {
      fetches++;
      await new Promise((r) => setTimeout(r, 40));
      return jsonResp(ENABLED_BODY);
    }) as unknown as typeof fetch);

    const [a, b] = await Promise.all([
      captcha.getCaptchaToken("test-1.0.0", "acct-test"),
      captcha.getCaptchaToken("test-1.0.0", "acct-test"),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(fetches).toBe(1); // mirror clientConfigRequest dedup
  });
});

/**
 * 按账号分池。
 *
 * 断言的是「池的作用域是 accountId」这件事本身：池实例按账号懒创建、一个账号的
 * 库存不进另一个账号的池、生命周期入口按账号停。修复前的缺陷是「模块级
 * `const pool = new CaptchaTokenPool()`，所有 start-plan 账号共用一个池」。
 * 共用的后果不是功能坏掉，而是 A 的流量把 B 的池喂大、两个账号的验证码频率叠成
 * 一条机器特征。
 */
describe("captcha 池按账号隔离", () => {
  const enabledFetch = (async () => jsonResp(ENABLED_BODY)) as unknown as typeof fetch;
  const CFG = { enabled: true, prefix: "no8xfe", sceneId: "11xygtvd", region: "sgp" };

  beforeEach(() => {
    solveMock.mockClear();
    captcha.__resetCaptchaConfigCacheForTests();
  });
  afterEach(() => {
    captcha.__setConfigsFetchForTests(null);
    try { captcha.shutdownCaptcha(); } catch { /* pool never started */ }
  });

  it("两个账号各取 token 来自不同的池", async () => {
    captcha.__setConfigsFetchForTests(enabledFetch);

    expect(pools.__captchaPoolForTests("acct-a")).toBeUndefined();
    const a = await captcha.getCaptchaToken("test-1.0.0", "acct-a");
    expect(a?.verifyParam.length).toBeGreaterThan(0);
    // 只有 acct-a 的池被创建，分池 = 按需创建，不是启动时给每个账号发一个
    expect(pools.__captchaPoolForTests("acct-b")).toBeUndefined();

    const b = await captcha.getCaptchaToken("test-1.0.0", "acct-b");
    expect(b?.verifyParam.length).toBeGreaterThan(0);

    const poolA = pools.__captchaPoolForTests("acct-a");
    const poolB = pools.__captchaPoolForTests("acct-b");
    expect(poolA).toBeDefined();
    expect(poolB).toBeDefined();
    expect(poolA).not.toBe(poolB);
  });

  it("预热一个账号的池不会给另一个账号备货", async () => {
    captcha.__setConfigsFetchForTests(enabledFetch);
    // 先让 acct-b 的池存在（count 0 = 只建池，不预热）
    await pools.prefillCaptchaPool(CFG, "acct-b", 0);
    const poolB = pools.__captchaPoolForTests("acct-b")!;
    expect(poolB.stats().ready).toBe(0);

    // acct-a 走完整启动路径（configure + 后台补充 + 预热）
    await captcha.startCaptchaPool("test-1.0.0", "acct-a");
    const poolA = pools.__captchaPoolForTests("acct-a")!;

    expect(poolA.stats().ready).toBeGreaterThan(0);
    expect(poolB.stats().ready).toBe(0); // 库存没跨账号
    // 补充循环的相位已算（0..interval，由 accountId 哈希决定）
    expect(poolA.startPhaseMs).toBeGreaterThanOrEqual(0);
  });

  it("stopCaptchaPoolFor 只停指定账号的池，stopCaptchaPool 停全部", async () => {
    captcha.__setConfigsFetchForTests(enabledFetch);
    await pools.prefillCaptchaPool(CFG, "acct-a", 0);
    await pools.prefillCaptchaPool(CFG, "acct-b", 0);

    expect(pools.stopCaptchaPoolFor("acct-a")).toBe(true);
    expect(pools.__captchaPoolForTests("acct-a")).toBeUndefined();
    expect(pools.__captchaPoolForTests("acct-b")).toBeDefined();
    // 幂等：再停一次没有池可停
    expect(pools.stopCaptchaPoolFor("acct-a")).toBe(false);

    pools.stopCaptchaPool();
    expect(pools.__captchaPoolForTests("acct-b")).toBeUndefined();
  });

  it("bindCaptchaPools：账号被禁用 / 删除后，它的池在写后回调里停掉", async () => {
    captcha.__setConfigsFetchForTests(enabledFetch);
    const keep = accountFor(zhipuCredential({ apiKey: "keep", secret: "keep-secret", jwt: "jwt-keep" }), { label: "keep", routes: ["start-plan"] });
    const gone = accountFor(zhipuCredential({ apiKey: "gone", secret: "gone-secret", jwt: "jwt-gone" }), { label: "gone", routes: ["start-plan"] });
    const { manager } = inMemoryAccounts([keep, gone]);
    bindCaptchaPools(manager);

    await pools.prefillCaptchaPool(CFG, keep.id, 0);
    await pools.prefillCaptchaPool(CFG, gone.id, 0);
    expect(pools.__captchaPoolForTests(keep.id)).toBeDefined();
    expect(pools.__captchaPoolForTests(gone.id)).toBeDefined();

    // 禁用：池随写后回调停掉（否则补池循环会替一个不出线的账号继续烧 CPU）。
    await manager.update(gone.id, { enabled: false });
    expect(pools.__captchaPoolForTests(gone.id)).toBeUndefined();
    expect(pools.__captchaPoolForTests(keep.id)).toBeDefined();

    // 删除：同样停。
    await pools.prefillCaptchaPool(CFG, keep.id, 0);
    await manager.remove(keep.id);
    expect(pools.__captchaPoolForTests(keep.id)).toBeUndefined();
  });
});

/**
 * 启动预热的选择：只给「启用且路由含 start-plan」的账号起补池循环。
 *
 * 为什么不是只预热默认账号：请求用哪个账号由调度器决定，任何
 * 启用且带 `start-plan` 路由的账号都可能被选中。只预热一个，其余账号的首个请求
 * 会打在空池上，首字节延迟从亚毫秒变成一次现解。
 */
describe("启动预热：按账号、按路由筛选", () => {
  beforeEach(() => {
    solveMock.mockClear();
    captcha.__resetCaptchaConfigCacheForTests();
    captcha.__setConfigsFetchForTests((async () => jsonResp(ENABLED_BODY)) as unknown as typeof fetch);
    try { captcha.shutdownCaptcha(); } catch { /* pool never started */ }
  });
  afterEach(() => {
    captcha.__setConfigsFetchForTests(null);
    try { captcha.shutdownCaptcha(); } catch { /* pool never started */ }
  });

  it("只预热启用且带 start-plan 路由的账号", async () => {
    const startA = accountFor(zhipuCredential({ apiKey: "sa", secret: "s" }), { label: "sa", routes: ["start-plan"] });
    const startB = accountFor(zhipuCredential({ apiKey: "sb", secret: "s" }), { label: "sb", routes: ["start-plan"] });
    const coding = accountFor(zhipuCredential({ apiKey: "cp", secret: "s" }), { label: "cp", routes: ["coding-plan"] });
    const disabled = accountFor(zhipuCredential({ apiKey: "off", secret: "s" }), { label: "off", routes: ["start-plan"], enabled: false });

    const warm = await captcha.warmCaptchaPools("test-1.0.0", [startA, startB, coding, disabled]);

    expect(warm.failed).toEqual([]);
    expect(new Set(warm.warmed)).toEqual(new Set([startA.id, startB.id]));
    expect(pools.__captchaPoolForTests(startA.id)).toBeDefined();
    expect(pools.__captchaPoolForTests(startB.id)).toBeDefined();
    // 不会走 start-plan 的账号（无路由 / 已禁用）不付这个启动成本
    expect(pools.__captchaPoolForTests(coding.id)).toBeUndefined();
    expect(pools.__captchaPoolForTests(disabled.id)).toBeUndefined();
  });

  it("没有账号会走 start-plan 时什么都不预热（不建池、不求解）", async () => {
    const coding = accountFor(zhipuCredential({ apiKey: "cp2", secret: "s" }), { label: "cp2", routes: ["coding-plan"] });
    const disabled = accountFor(zhipuCredential({ apiKey: "off2", secret: "s" }), { label: "off2", routes: ["start-plan"], enabled: false });

    const warm = await captcha.warmCaptchaPools("test-1.0.0", [coding, disabled]);

    expect(warm.warmed).toEqual([]);
    expect(warm.failed).toEqual([]);
    expect(pools.__captchaPoolForTests(coding.id)).toBeUndefined();
    expect(pools.__captchaPoolForTests(disabled.id)).toBeUndefined();
    expect(solveMock.mock.calls.length).toBe(0);
  });
});
