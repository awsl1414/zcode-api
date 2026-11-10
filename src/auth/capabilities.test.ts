/**
 * The requirement table every authenticated surface gates on
 * (`auth/capabilities.ts`). These are the rules the request paths, `/mcp`,
 * `/async`, the web panel and `auth status` all read, so a change here is a
 * change everywhere.
 */
import { describe, it, expect } from "bun:test";
import { checkSurface, credentialCapabilities, usableSurfaces } from "./capabilities.js";
import type { Credential } from "./types.js";

/** apiKey and plan JWT (a full `auth import` from the credential file). */
const both: Credential = { provider: "zai", apiKey: "id.secret", jwt: "jwt" };
/** coding-plan key only (a `--import` of an API key). */
const keyOnly: Credential = { provider: "zai", apiKey: "id.secret" };
/** plan JWT only (`auth import --jwt`). */
const jwtOnly: Credential = { provider: "zai", apiKey: "", jwt: "jwt" };

describe("checkSurface", () => {
  it("requires the apiKey pair for coding-plan", () => {
    expect(checkSurface("coding-plan", jwtOnly, "coding-plan").ok).toBe(false);
    expect(checkSurface("coding-plan", keyOnly, "coding-plan").ok).toBe(true);
  });

  it("requires the plan JWT for start-plan", () => {
    expect(checkSurface("start-plan", keyOnly, "start-plan").ok).toBe(false);
    expect(checkSurface("start-plan", jwtOnly, "start-plan").ok).toBe(true);
  });

  it("keeps /mcp and highspeed on coding-plan, needing both halves", () => {
    expect(checkSurface("mcp", both, "start-plan").ok).toBe(false);
    expect(checkSurface("mcp", jwtOnly, "coding-plan").ok).toBe(false);
    expect(checkSurface("mcp", both, "coding-plan").ok).toBe(true);
    expect(checkSurface("highspeed", keyOnly, "coding-plan").ok).toBe(false);
    expect(checkSurface("highspeed", both, "coding-plan").ok).toBe(true);
  });

  it("lets /async need both halves but no particular plan", () => {
    expect(checkSurface("async", jwtOnly, "coding-plan").ok).toBe(false);
    expect(checkSurface("async", keyOnly, "start-plan").ok).toBe(false);
    expect(checkSurface("async", both, "start-plan").ok).toBe(true);
  });

  it("lets /quota and claim run on a JWT alone, on either plan", () => {
    expect(checkSurface("quota", jwtOnly, "start-plan").ok).toBe(true);
    expect(checkSurface("claim", jwtOnly, "coding-plan").ok).toBe(true);
  });

  it("names the missing half in the message", () => {
    const asyncCheck = checkSurface("async", jwtOnly, "coding-plan");
    expect(asyncCheck.ok).toBe(false);
    if (!asyncCheck.ok) expect(asyncCheck.message).toMatch(/coding-plan API key/);

    const startPlanCheck = checkSurface("start-plan", keyOnly, "start-plan");
    expect(startPlanCheck.ok).toBe(false);
    if (!startPlanCheck.ok) expect(startPlanCheck.message).toMatch(/plan JWT/);
  });

  it("names the route mismatch instead of a credential problem", () => {
    const check = checkSurface("mcp", both, "start-plan");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toMatch(/runs on route "coding-plan"/);
  });

  it("reports not logged in", () => {
    const check = checkSurface("quota", null, "coding-plan");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toMatch(/Not logged in/);
  });
});

describe("usableSurfaces", () => {
  it("lists exactly what the credential and the account's route whitelist allow", () => {
    // 没有全局 plan，第二个参数是**账号的路由白名单**。
    expect(usableSurfaces(jwtOnly, ["start-plan"])).toEqual(["start-plan", "quota", "claim"]);
    expect(usableSurfaces(both, ["coding-plan", "start-plan"])).toEqual([
      "coding-plan",
      "start-plan",
      "mcp",
      "async",
      "quota",
      "claim",
      "highspeed",
    ]);
    expect(usableSurfaces(null, ["coding-plan"])).toEqual([]);
  });

  it("route-bound surfaces drop out when the whitelist does not include their route", () => {
    // 只有 start-plan 白名单：coding-plan / mcp / highspeed 都不在其中。
    expect(usableSurfaces(both, ["start-plan"])).toEqual(["start-plan", "async", "quota", "claim"]);
  });
});

describe("credentialCapabilities", () => {
  it("summarizes the two halves without looking at the plan", () => {
    expect(credentialCapabilities(jwtOnly)).toEqual({ codingPlan: false, startPlan: true });
    expect(credentialCapabilities(keyOnly)).toEqual({ codingPlan: true, startPlan: false });
    expect(credentialCapabilities(null)).toEqual({ codingPlan: false, startPlan: false });
  });
});
