/** Activation-event reporting: two events, no throw, first failure reason only. */
import { describe, it, expect } from "bun:test";
import { reportActivation } from "./activation.js";

function makeFetch(impl: (req: Request) => Response | Promise<Response>): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(typeof url === "string" ? url : url.toString(), init);
    return Promise.resolve(impl(req));
  }) as unknown as typeof fetch;
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const base = {
  origin: "https://zcode.z.ai/",
  userId: "user-42",
  deviceMid: "11111111-2222-4333-8444-555555555555",
  appVersion: "3.17.2",
  timezone: "Asia/Shanghai",
  osCategory: "darwin",
  osVersion: "",
};

describe("reportActivation", () => {
  it("posts app_launch and app_daily_active with fresh ids and no auth headers", async () => {
    const bodies: Record<string, unknown>[] = [];
    const headers: Array<Record<string, string | null>> = [];
    const fetchImpl = makeFetch((req) => {
      headers.push({ auth: req.headers.get("authorization"), device: req.headers.get("x-device-mid") });
      return req.json().then((parsed: unknown) => {
        bodies.push(parsed as Record<string, unknown>);
        return jsonResp({ code: 0, msg: "" });
      });
    });
    const result = await reportActivation({ ...base, fetchImpl });
    expect(result).toEqual({ ok: true });
    expect(bodies.map((b) => b.element_name)).toEqual(["app_launch", "app_daily_active"]);
    expect(bodies[0]?.event_id).not.toBe(bodies[1]?.event_id);
    expect(bodies[0]?.user_id).toBe("user-42");
    expect(bodies[0]?.device_mid).toBe(base.deviceMid);
    expect(bodies[0]?.app_version).toBe("3.17.2");
    expect(headers.every((h) => h.auth === null && h.device === null)).toBe(true);
  });

  it("reports both events even when the first fails, returning one readable reason", async () => {
    const seen: string[] = [];
    const fetchImpl = makeFetch((req) => {
      const body = req.clone().json() as unknown as Promise<Record<string, unknown>>;
      return body.then((parsed) => {
        seen.push(String(parsed.element_name));
        return seen.length === 1 ? jsonResp({ code: 5001, msg: "bad event" }, 200) : jsonResp({ code: 0 });
      });
    });
    const result = await reportActivation({ ...base, fetchImpl });
    expect(seen).toEqual(["app_launch", "app_daily_active"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("bad event");
  });

  it("returns a reason without a request when the account has no user id", async () => {
    let calls = 0;
    const fetchImpl = makeFetch(() => { calls += 1; return jsonResp({ code: 0 }); });
    const result = await reportActivation({ ...base, userId: "  ", fetchImpl });
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it("turns a network failure into a reason, never an exception", async () => {
    const fetchImpl = makeFetch(() => { throw new Error("connection reset"); });
    const result = await reportActivation({ ...base, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("connection reset");
  });
});
