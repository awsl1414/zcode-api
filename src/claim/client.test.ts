/**
 * Tests for `src/claim/client.ts` — mock fetch asserts request shape (URL,
 * query params, headers incl. captcha/version/platform) and canned responses
 * verify discovery parsing, merging and the claim biz-code failure mapping.
 */
import { describe, it, expect, mock } from "bun:test";
import { createClaimClient, ClaimPreviewError, collectClaimButtons, collectZcodePlans, mergePlans } from "./client.js";
import { classifyClaimCode, type ClaimFailureKind, type ClaimablePlan } from "./types.js";

function makeMockFetch(impl: (req: Request, init?: RequestInit) => Promise<Response>): typeof fetch {
  return mock((url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(typeof url === "string" ? url : url.toString(), init);
    return impl(req, init);
  }) as unknown as typeof fetch;
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const PREVIEW_BODY = {
  code: 0,
  data: {
    plans: [
      {
        plan_id: "weekend-free-1024",
        name: "Weekend Free",
        description: "weekend trial",
        priority: 5,
        starts_at: 1783000000,
        ends_at: 1783200000,
        entitlements: [
          {
            entitlement_id: "ent-1",
            show_name: "GLM-5.2",
            meter: "token",
            unit_type: "tokens",
            capabilities: ["chat"],
            grant_units: 100000,
            period: "daily",
            priority: 1,
            effective_at: 1783000500,
          },
          { no_id: "dropped" },
        ],
      },
      { name: "no plan_id — dropped" },
    ],
  },
};

function aPlan(planId: string, extra: Partial<ClaimablePlan> = {}): ClaimablePlan {
  return {
    planId, name: planId, description: "", priority: 0, entitlements: [],
    source: "billing/preview", discoveryFaces: ["billing/preview"], raw: {},
    ...extra,
  };
}

describe("createClaimClient — getPreviews", () => {
  it("fetches preview with app_version + platform query and parses plans/entitlements", async () => {
    let capturedUrl = "";
    const fetchImpl = makeMockFetch((req) => {
      capturedUrl = req.url;
      return Promise.resolve(jsonResp(PREVIEW_BODY));
    });
    const client = createClaimClient({ origin: "https://zcode.z.ai/", jwt: "jwt-1", appVersion: "3.11.2", platform: "win32-x64", fetchImpl });

    const plans = await client.getPreviews();

    expect(capturedUrl).toBe("https://zcode.z.ai/api/v1/zcode-plan/billing/preview?app_version=3.11.2&platform=win32-x64");
    expect(plans).toHaveLength(1);
    const p = plans[0];
    expect(p.planId).toBe("weekend-free-1024");
    expect(p.name).toBe("Weekend Free");
    expect(p.priority).toBe(5);
    expect(p.startsAt).toBe(1783000000);
    expect(p.endsAt).toBe(1783200000);
    // effective_at is hoisted to the plan and stays on the entitlement.
    expect(p.effectiveAt).toBe(1783000500);
    expect(p.source).toBe("billing/preview");
    expect(p.discoveryFaces).toEqual(["billing/preview"]);
    expect(p.entitlements).toHaveLength(1);
    expect(p.entitlements[0]).toEqual({
      entitlementId: "ent-1",
      showName: "GLM-5.2",
      meter: "token",
      unitType: "tokens",
      capabilities: ["chat"],
      grantUnits: 100000,
      period: "daily",
      priority: 1,
      effectiveAt: 1783000500,
    });
  });

  it("sends Authorization only when jwt provided", async () => {
    const auths: (string | null)[] = [];
    const fetchImpl = makeMockFetch((req) => {
      auths.push(req.headers.get("authorization"));
      return Promise.resolve(jsonResp(PREVIEW_BODY));
    });
    const withJwt = createClaimClient({ origin: "https://zcode.z.ai", jwt: "jwt-1", appVersion: "3.11.2", platform: "win32-x64", fetchImpl });
    await withJwt.getPreviews();
    const anon = createClaimClient({ origin: "https://zcode.z.ai", appVersion: "3.11.2", platform: "win32-x64", fetchImpl });
    await anon.getPreviews();
    expect(auths[0]).toBe("Bearer jwt-1");
    expect(auths[1]).toBeNull();
  });

  it("throws on non-zero biz code; code 0 + missing data enumerates as empty", async () => {
    const fetchImpl = makeMockFetch(() => Promise.resolve(jsonResp({ code: 1002, msg: "campaign ended" })));
    const client = createClaimClient({ origin: "https://zcode.z.ai", appVersion: "3.11.2", platform: "win32-x64", fetchImpl });
    await expect(client.getPreviews()).rejects.toThrow("1002");
    const fetchNoData = makeMockFetch(() => Promise.resolve(jsonResp({ code: 0, msg: "", logid: "x" })));
    const client2 = createClaimClient({ origin: "https://zcode.z.ai", appVersion: "3.11.2", platform: "win32-x64", fetchImpl: fetchNoData });
    expect(await client2.getPreviews()).toEqual([]);
  });

  describe("429 Retry-After 3-state", () => {
    async function preview429(headers: Record<string, string>): Promise<ClaimPreviewError> {
      const fetchImpl = makeMockFetch(() =>
        Promise.resolve(new Response(JSON.stringify({ code: 429, msg: "slow down" }), { status: 429, headers })),
      );
      const client = createClaimClient({ origin: "https://zcode.z.ai", appVersion: "3.11.2", platform: "win32-x64", fetchImpl });
      try {
        await client.getPreviews();
        throw new Error("expected ClaimPreviewError");
      } catch (err) {
        if (!(err instanceof ClaimPreviewError)) throw err;
        return err;
      }
    }

    it("delta-seconds form", async () => {
      const err = await preview429({ "retry-after": "90" });
      expect(err.status).toBe(429);
      expect(err.retryAfterSeconds).toBe(90);
    });

    it("HTTP-date form (relative to now)", async () => {
      const at = new Date(Date.now() + 30_000).toUTCString();
      const err = await preview429({ "retry-after": at });
      expect(err.retryAfterSeconds).toBeGreaterThanOrEqual(29);
      expect(err.retryAfterSeconds).toBeLessThanOrEqual(30);
    });

    it("missing header → undefined (caller falls back to cooldownMs)", async () => {
      expect((await preview429({})).retryAfterSeconds).toBeUndefined();
    });

    it("unparseable value → undefined", async () => {
      expect((await preview429({ "retry-after": "not-a-date" })).retryAfterSeconds).toBeUndefined();
    });

    it("non-429 failures never carry retryAfterSeconds", async () => {
      const fetchImpl = makeMockFetch(() => Promise.resolve(new Response("boom", { status: 503 })));
      const client = createClaimClient({ origin: "https://zcode.z.ai", appVersion: "3.11.2", platform: "win32-x64", fetchImpl });
      const err = await client.getPreviews().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(ClaimPreviewError);
      expect((err as ClaimPreviewError).status).toBe(503);
      expect((err as ClaimPreviewError).retryAfterSeconds).toBeUndefined();
    });
  });
});

/** Shape taken from the 1030 campaign capture: three distinct unix-second clocks. */
const TOUCH_1030_WK = {
  code: 0,
  msg: "",
  data: {
    server_time: 1793369478,
    language: "zh-CN",
    deliveries: [{
      campaign_id: "2101141259813175296",
      resource_position: "banner",
      priority: 50,
      banner: {
        buttons: [
          { text: { format: "", content: "" }, action: { type: "close", args: null } },
          { text: { format: "", content: "" }, action: { type: "claim_zcode_plan", args: { plan_id: "zcode-v3-start-plan-1030-wk" } } },
        ],
        background: {
          type: "bundle",
          bundle: { bundle: { src: "https://cdn-zcode.z.ai/marketing/touch/assets/x.zip", sha256: "aa" }, entry: "index.html" },
          args: {
            zcode_plan: {
              plan_id: "zcode-v3-start-plan-1030-wk",
              name: "ZCODE WEEKEND BUILD",
              priority: 101,
              starts_at: 1793358000,
              ends_at: 1793581200,
              entitlements: [{
                entitlement_id: "ent-zcode-v3-start-plan-1030-wk-1",
                show_name: "GLM-5.3-Flash",
                meter: "model_usage",
                unit_type: "token",
                capabilities: ["model:glm-5.3-flash"],
                grant_units: 500000000,
                period: "one_time",
                effective_at: 1793372400,
                priority: 101,
              }],
            },
          },
        },
        success_popup: {
          buttons: [
            { text: { format: "plaintext", content: "模型设置" }, action: { type: "navigate", args: { page: "settings" } } },
          ],
          hero: {
            type: "bundle",
            bundle: { bundle: { src: "https://cdn-zcode.z.ai/marketing/touch/assets/y.zip", sha256: "bb" }, entry: "index.html" },
            args: {
              zcode_plan: {
                plan_id: "zcode-v3-start-plan-1030-wk",
                name: "ZCODE WEEKEND BUILD",
                priority: 101,
                starts_at: 1793358000,
                ends_at: 1793581200,
                entitlements: [{
                  entitlement_id: "ent-zcode-v3-start-plan-1030-wk-1",
                  show_name: "GLM-5.3-Flash",
                  meter: "model_usage",
                  unit_type: "token",
                  capabilities: ["model:glm-5.3-flash"],
                  grant_units: 500000000,
                  period: "one_time",
                  effective_at: 1793372400,
                  priority: 101,
                }],
              },
            },
          },
        },
      },
    }],
  },
};

describe("createClaimClient — marketing/touch discovery", () => {
  const MARKETING_ONLY = { code: 0, data: { deliveries: TOUCH_1030_WK.data.deliveries } };
  const EMPTY_PREVIEW = { code: 0, msg: "", logid: "no-data" };

  function twoFaceFetch(marketing: unknown = MARKETING_ONLY, preview: unknown = EMPTY_PREVIEW): typeof fetch {
    return makeMockFetch((req) => {
      const path = new URL(req.url).pathname;
      return Promise.resolve(jsonResp(path.endsWith("/billing/preview") ? preview : marketing));
    });
  }

  it("1030-wk capture: startsAt / effectiveAt / endsAt are parsed without mixing clocks", async () => {
    const client = createClaimClient({
      origin: "https://zcode.z.ai", jwt: "jwt-9", appVersion: "3.17.2", platform: "win32-x64",
      marketingDeviceMid: "11111111-2222-4333-8444-555555555555", fetchImpl: twoFaceFetch(),
    });
    const { activities } = await client.discoverActivities();
    expect(activities).toHaveLength(1);
    const plan = activities[0];
    expect(plan.planId).toBe("zcode-v3-start-plan-1030-wk");
    expect(plan.startsAt).toBe(1793358000);
    expect(plan.effectiveAt).toBe(1793372400);
    expect(plan.endsAt).toBe(1793581200);
    expect(plan.startsAt! < plan.effectiveAt! && plan.effectiveAt! < plan.endsAt!).toBe(true);
    expect(plan.entitlements[0].effectiveAt).toBe(1793372400);
    expect(plan.campaignId).toBe("2101141259813175296");
    expect(plan.discoveryFaces).toEqual(["marketing/touch"]);
  });

  it("sends the marketing header set with a per-client seq counter", async () => {
    const seen: Array<{ path: string; seq: string | null; dm: string | null; lang: string | null; ver: string | null; auth: string | null }> = [];
    const fetchImpl = makeMockFetch((req) => {
      const u = new URL(req.url);
      seen.push({ path: u.pathname, seq: u.searchParams.get("seq"), dm: req.headers.get("x-device-mid"), lang: req.headers.get("x-client-language"), ver: req.headers.get("x-zcode-app-version"), auth: req.headers.get("authorization") });
      return Promise.resolve(jsonResp(u.pathname.endsWith("/billing/preview") ? EMPTY_PREVIEW : MARKETING_ONLY));
    });
    const client = createClaimClient({
      origin: "https://zcode.z.ai", jwt: "jwt-9", appVersion: "3.17.2", platform: "win32-x64",
      marketingDeviceMid: "11111111-2222-4333-8444-555555555555", fetchImpl,
    });
    await client.discoverActivities();
    await client.discoverActivities();
    const marketing = seen.filter((x) => x.path === "/api/v1/marketing/touch");
    expect(marketing.map((x) => x.seq)).toEqual(["0", "1"]);
    expect(marketing[0].dm).toBe("11111111-2222-4333-8444-555555555555");
    expect(marketing[0].lang).toBe("zh-CN");
    expect(marketing[0].ver).toBe("3.17.2");
    expect(marketing[0].auth).toBe("Bearer jwt-9");
  });

  it("survives a marketing face that cannot run or answers 500", async () => {
    const fetchImpl = makeMockFetch(() => Promise.resolve(new Response("{}", { status: 500 })));
    const client = createClaimClient({ origin: "https://zcode.z.ai", appVersion: "3.17.2", platform: "win32-x64", fetchImpl });
    const anonymous = await client.discoverActivities();
    expect(anonymous.activities).toEqual([]);
    // 没有 marketingDeviceMid 时营销面根本不发请求，只剩预览面的失败原因。
    expect(anonymous.diagnostics.reasons).toHaveLength(1);
    expect(anonymous.diagnostics.reasons[0]).toContain("billing/preview");

    const errClient = createClaimClient({ origin: "https://zcode.z.ai", appVersion: "3.17.2", platform: "win32-x64", marketingDeviceMid: "11111111-2222-4333-8444-555555555555", fetchImpl });
    const bothFailed = await errClient.discoverActivities();
    expect(bothFailed.activities).toEqual([]);
    expect(bothFailed.diagnostics.reasons).toHaveLength(2);
  });

  it("falls back to marketing plans when preview is empty-no-data", async () => {
    const client = createClaimClient({
      origin: "https://zcode.z.ai", jwt: "j", appVersion: "3.17.2", platform: "win32-x64",
      marketingDeviceMid: "11111111-2222-4333-8444-555555555555", fetchImpl: twoFaceFetch(),
    });
    const { activities } = await client.discoverActivities();
    expect(activities.map((p) => p.planId)).toEqual(["zcode-v3-start-plan-1030-wk"]);
  });

  it("discoverActivities merges both faces by planId, marketing first, keeping every face's fields", async () => {
    const preview = {
      code: 0,
      data: {
        plans: [{
          plan_id: "zcode-v3-start-plan-1030-wk",
          name: "Billing-side name",
          description: "only preview has this",
          priority: 4,
        }],
      },
    };
    const client = createClaimClient({
      origin: "https://zcode.z.ai", jwt: "j", appVersion: "3.17.2", platform: "win32-x64",
      marketingDeviceMid: "11111111-2222-4333-8444-555555555555", fetchImpl: twoFaceFetch(MARKETING_ONLY, preview),
    });
    const { activities, diagnostics } = await client.discoverActivities();
    expect(activities).toHaveLength(1);
    expect(activities[0].discoveryFaces.sort()).toEqual(["billing/preview", "marketing/touch"]);
    expect(activities[0].source).toBe("marketing/touch");
    expect(activities[0].name).toBe("ZCODE WEEKEND BUILD");
    expect(activities[0].description).toBe("only preview has this");
    expect(activities[0].startsAt).toBe(1793358000);
    expect(activities[0].effectiveAt).toBe(1793372400);
    expect(activities[0].endsAt).toBe(1793581200);
    expect(activities[0].campaignId).toBe("2101141259813175296");
    expect(diagnostics.noDelivery).toBe(false);
  });

  it("exposes three empty-list diagnostic signals without drawing a conclusion", async () => {
    const noDelivery = createClaimClient({
      origin: "https://zcode.z.ai", appVersion: "3.17.2", platform: "win32-x64",
      marketingDeviceMid: "11111111-2222-4333-8444-555555555555",
      fetchImpl: twoFaceFetch({ code: 0, data: { deliveries: [] } }, EMPTY_PREVIEW),
    });
    expect((await noDelivery.discoverActivities()).diagnostics).toEqual({
      noDelivery: true, versionGate: false, eligibility: false, reasons: [],
    });

    const version = createClaimClient({
      origin: "https://zcode.z.ai", appVersion: "3.17.2", platform: "win32-x64",
      fetchImpl: makeMockFetch((req) => Promise.resolve(jsonResp(
        new URL(req.url).pathname.endsWith("/billing/preview") ? { code: 3001, msg: "app_version too low" } : { code: 0, data: { deliveries: [] } },
      ))),
    });
    const versionDiag = (await version.discoverActivities()).diagnostics;
    expect(versionDiag.versionGate).toBe(true);
    expect(versionDiag.reasons.join(" ")).toContain("app_version too low");

    const ineligible = createClaimClient({
      origin: "https://zcode.z.ai", appVersion: "3.17.2", platform: "win32-x64",
      fetchImpl: makeMockFetch((req) => Promise.resolve(jsonResp(
        new URL(req.url).pathname.endsWith("/billing/preview") ? { code: 1004, msg: "ineligible" } : { code: 0, data: { deliveries: [] } },
      ))),
    });
    expect((await ineligible.discoverActivities()).diagnostics.eligibility).toBe(true);
  });
});

describe("synthetic new activity — unknown fields never drop a delivery", () => {
  const SYNTHETIC = {
    code: 0,
    msg: "",
    data: {
      deliveries: [{
        campaign_id: "campaign-2026-autumn-unknown",
        resource_position: "popup",
        priority: 77,
        experiment_bucket: "novel-field",
        popup: {
          buttons: [
            { action: { type: "dismiss_forever", args: { reason: "later", plan_id: "plan-november-nova-7788" } } },
            { action: { type: "claim_zcode_plan", args: { plan_id: "plan-november-nova-7788", badge: "new" } } },
          ],
          success_popup: {
            buttons: [{
              action: { type: "open_rewards", args: { page: "rewards" } },
              nested: {
                background: {
                  args: {
                    zcode_plan: {
                      plan_id: "plan-november-nova-7788",
                      name: "星云庆典 · 未登记名称",
                      description: "未见过的新活动",
                      priority: 88,
                      starts_at: 1800000000,
                      ends_at: 1800007200,
                      effective_at: 1800003600,
                      entitlements: [{
                        entitlement_id: "ent-nova-1",
                        show_name: "NOVA-QUOTA",
                        meter: "credit_pool",
                        unit_type: "credits",
                        capabilities: ["model:nova"],
                        grant_units: 42,
                        period: "until_next_solstice",
                        priority: 88,
                        effective_at: 1800003600,
                        extra_entitlement_flag: true,
                      }],
                      unknown_plan_shape: { nested: ["kept"] },
                    },
                  },
                },
              },
            }],
          },
        },
      }],
    },
  };

  it("extracts generic facts from success_popup.buttons, keeps unknown fields in raw and records both faces", async () => {
    const preview = {
      code: 0,
      data: {
        plans: [{
          plan_id: "plan-november-nova-7788",
          name: "Billing alias",
          priority: 1,
          description: "billing-only detail",
        }],
      },
    };
    const fetchImpl = makeMockFetch((req) =>
      Promise.resolve(jsonResp(new URL(req.url).pathname.endsWith("/billing/preview") ? preview : SYNTHETIC)),
    );
    const client = createClaimClient({
      origin: "https://zcode.z.ai", jwt: "j", appVersion: "3.17.2", platform: "win32-x64",
      marketingDeviceMid: "11111111-2222-4333-8444-555555555555", fetchImpl,
    });
    const { activities } = await client.discoverActivities();
    expect(activities).toHaveLength(1);
    const plan = activities[0];
    expect(plan.planId).toBe("plan-november-nova-7788");
    expect(plan.name).toBe("星云庆典 · 未登记名称");
    expect(plan.startsAt).toBe(1800000000);
    expect(plan.effectiveAt).toBe(1800003600);
    expect(plan.endsAt).toBe(1800007200);
    expect(plan.entitlements[0].period).toBe("until_next_solstice");
    expect(plan.description).toBe("未见过的新活动");
    expect(plan.discoveryFaces.sort()).toEqual(["billing/preview", "marketing/touch"]);
    expect(JSON.stringify(plan.raw)).toContain("unknown_plan_shape");
    expect(JSON.stringify(plan.raw)).toContain("extra_entitlement_flag");
    expect(JSON.stringify(plan.raw)).toContain("experiment_bucket");
    expect(JSON.stringify(plan.raw)).toContain("resource_position");
    expect(JSON.stringify(plan.raw)).toContain("dismiss_forever");
  });

  it("recursive traversal reaches banner/popup/success_popup/background args without a host whitelist", () => {
    const buttons: { planId: string; actionType: string }[] = [];
    collectClaimButtons(SYNTHETIC.data.deliveries, buttons);
    expect(buttons.map((b) => b.planId)).toContain("plan-november-nova-7788");
    expect(buttons.map((b) => b.actionType)).toContain("dismiss_forever");
    const rich: Record<string, unknown>[] = [];
    collectZcodePlans(SYNTHETIC.data.deliveries, rich);
    expect(rich[0]?.plan_id).toBe("plan-november-nova-7788");
  });

  it("mergePlans keeps the richer face's fields and unions discoveryFaces", () => {
    const merged = mergePlans([
      { face: "marketing/touch", plans: [aPlan("p", { name: "Marketing", startsAt: 1 })] },
      { face: "billing/preview", plans: [aPlan("p", { name: "Billing", endsAt: 2 })] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].startsAt).toBe(1);
    expect(merged[0].endsAt).toBe(2);
    expect(merged[0].discoveryFaces).toEqual(["marketing/touch", "billing/preview"]);
  });
});

describe("classifyClaimCode", () => {
  it("keeps unknown codes verbatim and classifies 3002 as rate_limited", () => {
    expect(classifyClaimCode(9999)).toEqual({ kind: "unknown", rawCode: 9999 });
    expect(classifyClaimCode("not-a-code")).toEqual({ kind: "unknown", rawCode: "not-a-code" });
    expect(classifyClaimCode(3002)).toEqual({ kind: "rate_limited", rawCode: 3002 });
  });
});

describe("createClaimClient — minimal claim-plane header set", () => {
  it("preview sends Authorization ONLY — no identity bundle, no UA, no version/platform headers", async () => {
    const seen: Array<{ path: string; auth: string | null; ua: string | null; version: string | null; platform: string | null }> = [];
    const fetchImpl = makeMockFetch((req) => {
      seen.push({
        path: new URL(req.url).pathname,
        auth: req.headers.get("authorization"),
        ua: req.headers.get("user-agent"),
        version: req.headers.get("x-zcode-app-version"),
        platform: req.headers.get("x-platform"),
      });
      return Promise.resolve(jsonResp(PREVIEW_BODY));
    });
    const client = createClaimClient({ origin: "https://zcode.z.ai", jwt: "jwt-1", appVersion: "3.12.3", platform: "win32-x64", fetchImpl });
    await client.getPreviews();
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe("/api/v1/zcode-plan/billing/preview");
    expect(seen[0].auth).toBe("Bearer jwt-1");
    expect(seen[0].ua).toBeNull();
    expect(seen[0].version).toBeNull();
    expect(seen[0].platform).toBeNull();
  });

  it("claim sends exactly the bundle's 6 headers", async () => {
    let req: Request | undefined;
    let sentHeaders: Record<string, string> | undefined;
    const fetchImpl = makeMockFetch((r, init) => {
      req = r;
      sentHeaders = init?.headers as Record<string, string>;
      return Promise.resolve(jsonResp({ code: 0, data: { plan: { plan_id: "weekend-free-1024", starts_at: 1, ends_at: 2 } } }));
    });
    const client = createClaimClient({ origin: "https://zcode.z.ai", jwt: "jwt-1", appVersion: "3.12.3", platform: "win32-x64", fetchImpl });
    await client.claim("weekend-free-1024", { verifyParam: "cap-param", region: "cn-hangzhou" });
    expect(new URL(req!.url).pathname).toBe("/api/v1/zcode-plan/billing/claim");
    expect(req!.headers.get("authorization")).toBe("Bearer jwt-1");
    expect(req!.headers.get("content-type")).toBe("application/json");
    expect(req!.headers.get("x-aliyun-captcha-verify-param")).toBe("cap-param");
    expect(req!.headers.get("x-aliyun-captcha-verify-region")).toBe("cn-hangzhou");
    expect(req!.headers.get("x-zcode-app-version")).toBe("3.12.3");
    expect(req!.headers.get("x-platform")).toBe("win32-x64");
    expect(req!.headers.get("user-agent")).toBeNull();
    expect(Object.keys(sentHeaders!)).toEqual([
      "Authorization", "Content-Type", "X-Aliyun-Captcha-Verify-Param",
      "X-Aliyun-Captcha-Verify-Region", "X-ZCode-App-Version", "X-Platform",
    ]);
  });

  it("claim without a captcha token omits both captcha headers", async () => {
    let sentHeaders: Record<string, string> | undefined;
    const fetchImpl = makeMockFetch((_r, init) => {
      sentHeaders = init?.headers as Record<string, string>;
      return Promise.resolve(jsonResp({ code: 0, data: { plan: { plan_id: "weekend-free-1024" } } }));
    });
    const client = createClaimClient({ origin: "https://zcode.z.ai", jwt: "jwt-1", appVersion: "3.16.3", platform: "win32-x64", fetchImpl });
    await client.claim("weekend-free-1024");
    expect(Object.keys(sentHeaders!)).toEqual(["Authorization", "Content-Type", "X-ZCode-App-Version", "X-Platform"]);
  });
});

describe("createClaimClient — campaign-gated X-Device-Mid deviation", () => {
  it("preview appends X-Device-Mid after Authorization when deviceMid provided", async () => {
    const seen: Array<{ auth: string | null; mid: string | null; keys: string[] }> = [];
    const fetchImpl = makeMockFetch((req) => {
      seen.push({ auth: req.headers.get("authorization"), mid: req.headers.get("x-device-mid"), keys: [...req.headers.keys()] });
      return Promise.resolve(jsonResp(PREVIEW_BODY));
    });
    const client = createClaimClient({
      origin: "https://zcode.z.ai", jwt: "jwt-1", appVersion: "3.12.3", platform: "win32-x64",
      deviceMid: "0cd664d3-08fb-49c6-ac89-1eab3e630e78", fetchImpl,
    });
    await client.getPreviews();
    expect(seen[0].auth).toBe("Bearer jwt-1");
    expect(seen[0].mid).toBe("0cd664d3-08fb-49c6-ac89-1eab3e630e78");
    expect(seen[0].keys).toEqual(["authorization", "x-device-mid"]);
    const anon = createClaimClient({
      origin: "https://zcode.z.ai", appVersion: "3.12.3", platform: "win32-x64",
      deviceMid: "0cd664d3-08fb-49c6-ac89-1eab3e630e78", fetchImpl,
    });
    await anon.getPreviews();
    expect(seen[1].auth).toBeNull();
    expect(seen[1].keys).toEqual(["x-device-mid"]);
  });

  it("blank deviceMid is treated as absent", async () => {
    const fetchImpl = makeMockFetch((req) => {
      expect(req.headers.get("x-device-mid")).toBeNull();
      return Promise.resolve(jsonResp(PREVIEW_BODY));
    });
    const client = createClaimClient({ origin: "https://zcode.z.ai", jwt: "j", appVersion: "3.12.3", platform: "p", deviceMid: "  ", fetchImpl });
    await client.getPreviews();
  });
});

describe("createClaimClient — claim", () => {
  it("POSTs plan_id with jwt + captcha + version + platform headers", async () => {
    let body = "";
    let url = "";
    const fetchImpl = makeMockFetch(async (req) => {
      url = req.url;
      body = await req.text();
      return jsonResp({ code: 0, data: { plan: { starts_at: 1783000000, ends_at: 1783200000 } } });
    });
    const client = createClaimClient({ origin: "https://zcode.z.ai", jwt: "jwt-1", appVersion: "3.11.2", platform: "linux-x64", fetchImpl });
    const out = await client.claim("weekend-free-1024", { verifyParam: "cap-token", region: "cn-hangzhou" });
    expect(url).toBe("https://zcode.z.ai/api/v1/zcode-plan/billing/claim");
    expect(JSON.parse(body)).toEqual({ plan_id: "weekend-free-1024" });
    expect(out).toEqual({ ok: true, planId: "weekend-free-1024", startsAt: 1783000000, endsAt: 1783200000 });
  });

  it("maps biz codes to failure kinds, surfaces failureEndsAt and keeps unknown codes verbatim", async () => {
    const cases: Array<[number | string, ClaimFailureKind]> = [
      [1001, "not_found"], [1002, "unavailable"], [1003, "already_claimed"],
      [1004, "ineligible"], [1005, "quota_exhausted"], [3001, "invalid_request"],
      [3002, "rate_limited"], [3007, "captcha"], ["brand-new-code", "unknown"], [9999, "unknown"],
    ];
    for (const [code, kind] of cases) {
      const fetchImpl = makeMockFetch(() =>
        Promise.resolve(jsonResp({ code, msg: `biz ${code}`, data: { plan: { ends_at: 1783100000 } } })),
      );
      const client = createClaimClient({ origin: "https://zcode.z.ai", jwt: "jwt-1", appVersion: "3.11.2", platform: "win32-x64", fetchImpl });
      const out = await client.claim("p1", { verifyParam: "t" });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.failureKind).toBe(kind);
        expect(out.code).toBe(code);
        expect(out.failureEndsAt).toBe(1783100000);
      }
    }
  });

  it("derives http_error / login_required from HTTP status without biz code", async () => {
    const fetch500 = makeMockFetch(() => Promise.resolve(jsonResp({ msg: "boom" }, 500)));
    const c1 = createClaimClient({ origin: "https://zcode.z.ai", jwt: "j", appVersion: "3.11.2", platform: "p", fetchImpl: fetch500 });
    const out1 = await c1.claim("p1", { verifyParam: "t" });
    expect(out1.ok).toBe(false);
    if (!out1.ok) expect(out1.failureKind).toBe("http_error");
    const fetch401 = makeMockFetch(() => Promise.resolve(new Response("", { status: 401 })));
    const c2 = createClaimClient({ origin: "https://zcode.z.ai", jwt: "j", appVersion: "3.11.2", platform: "p", fetchImpl: fetch401 });
    const out2 = await c2.claim("p1", { verifyParam: "t" });
    expect(out2.ok).toBe(false);
    if (!out2.ok) expect(out2.failureKind).toBe("login_required");
  });

  it("returns login_required without HTTP call when jwt missing", async () => {
    const fetchImpl = makeMockFetch(() => { throw new Error("should not be called"); });
    const client = createClaimClient({ origin: "https://zcode.z.ai", appVersion: "3.11.2", platform: "p", fetchImpl });
    const out = await client.claim("p1", { verifyParam: "t" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failureKind).toBe("login_required");
  });
});
