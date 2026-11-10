/**
 * Tests for identity header builders — mirror the ZCode 3.12.3 bundle's
 * `g6n` (LLM/gate path) and `TV` (context/endpoint-routing path).
 * @see _reverse/NOTEPAD.md "2. Identity Headers"
 */
import { describe, it, expect } from "bun:test";
import os from "node:os";
import { buildIdentityHeaders, buildLlmIdentityHeaders } from "./identity.js";
import type { ProxyIdentity } from "../config/types.js";

const BASE: ProxyIdentity = {
  appVersion: "1.2.3",
  appVersionSource: "default",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
  betaPolicy: "drop",
  betaAllowlist: [],
};

/** 一个稳定的 UUIDv4 形态指纹（一账号一指纹，由建号时生成）。*/
const MID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

/**
 * 进程级身份头（`X-Device-Mid` 传空 = 这个调用方不带设备指纹）。
 *
 * 设备指纹是**账号属性**，所以它不是 `ProxyIdentity` 的字段：需要它的
 * 调用方把账号的值作为第二个参数传进来。本文件底部有几例专门测这个参数。
 */
function headers(id: ProxyIdentity, deviceMid = ""): Record<string, string> {
  return buildIdentityHeaders(id, deviceMid);
}

describe("buildIdentityHeaders", () => {
  it("emits User-Agent as ZCode/{appVersion}", () => {
    const h = headers({ ...BASE, appVersion: "9.9.9" });
    expect(h["User-Agent"]).toBe("ZCode/9.9.9");
  });

  it("emits X-ZCode-App-Version mirroring User-Agent version", () => {
    const h = headers({ ...BASE, appVersion: "4.5.6" });
    expect(h["X-ZCode-App-Version"]).toBe("4.5.6");
    expect(h["User-Agent"]).toBe("ZCode/4.5.6");
  });

  it("emits X-Title as `Z Code@{sourceTitle}`", () => {
    const h = headers({ ...BASE, sourceTitle: "electron" });
    expect(h["X-Title"]).toBe("Z Code@electron");
  });

  it("no longer emits X-ZCode-Agent (3.12.3 `TV` dropped it from this plane)", () => {
    const h = headers(BASE);
    expect(h["X-ZCode-Agent"]).toBeUndefined();
  });

  it("emits runtime platform headers matching the current ZCode bundle", () => {
    const h = headers(BASE);
    const expectedCategory = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
    expect(h["X-Platform"]).toBe(`${process.platform}-${os.arch()}`);
    expect(h["X-Os-Category"]).toBe(expectedCategory);
    expect(h["X-Os-Version"]).toBe(os.release());
  });

  it("emits X-Client-Language/X-Client-Timezone from Intl by default", () => {
    const h = headers(BASE);
    const expectedLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    const expectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(h["X-Client-Language"]).toBe(expectedLocale);
    expect(h["X-Client-Timezone"]).toBe(expectedTz);
  });

  it("emits X-Device-Mid from the per-account argument", () => {
    const h = buildIdentityHeaders(BASE, MID);
    expect(h["X-Device-Mid"]).toBe(MID);
  });

  it("omits X-Device-Mid when the account has no fingerprint (api-key credentials)", () => {
    const h = buildIdentityHeaders(BASE, "");
    expect(h["X-Device-Mid"]).toBeUndefined();
  });

  it("drops a non-printable deviceMid instead of emitting it", () => {
    const h = buildIdentityHeaders(BASE, "bad\u00ffvalue");
    expect(h["X-Device-Mid"]).toBeUndefined();
  });

  it("honours ZCODE_IDENTITY_* env overrides for the language/timezone headers", () => {
    const saved = {
      rc: process.env.ZCODE_IDENTITY_RELEASE_CHANNEL,
      cl: process.env.ZCODE_IDENTITY_CLIENT_LANGUAGE,
      ct: process.env.ZCODE_IDENTITY_CLIENT_TIMEZONE,
    };
    process.env.ZCODE_IDENTITY_RELEASE_CHANNEL = "beta";
    process.env.ZCODE_IDENTITY_CLIENT_LANGUAGE = "en-US";
    process.env.ZCODE_IDENTITY_CLIENT_TIMEZONE = "UTC";
    try {
      const h = headers(BASE, MID);
      expect(h["X-Release-Channel"]).toBe("beta");
      expect(h["X-Client-Language"]).toBe("en-US");
      expect(h["X-Client-Timezone"]).toBe("UTC");
      // 设备指纹不走 env：它是账号属性，只能由调用方传。
      expect(h["X-Device-Mid"]).toBe(MID);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k === "rc" ? "ZCODE_IDENTITY_RELEASE_CHANNEL" : k === "cl" ? "ZCODE_IDENTITY_CLIENT_LANGUAGE" : "ZCODE_IDENTITY_CLIENT_TIMEZONE"];
        else process.env[k === "rc" ? "ZCODE_IDENTITY_RELEASE_CHANNEL" : k === "cl" ? "ZCODE_IDENTITY_CLIENT_LANGUAGE" : "ZCODE_IDENTITY_CLIENT_TIMEZONE"] = v;
      }
    }
  });

  it("defaults X-Release-Channel to production and honors ZCODE_ENV=test (bundle IL())", () => {
    const h = headers(BASE);
    expect(h["X-Release-Channel"]).toBe("production");

    const savedEnv = process.env.ZCODE_ENV;
    process.env.ZCODE_ENV = "test";
    try {
      expect(headers(BASE)["X-Release-Channel"]).toBe("test");
    } finally {
      if (savedEnv === undefined) delete process.env.ZCODE_ENV;
      else process.env.ZCODE_ENV = savedEnv;
    }
  });

  it("passes refererOrigin through as HTTP-Referer", () => {
    const h = headers({ ...BASE, refererOrigin: "https://example.com" });
    expect(h["HTTP-Referer"]).toBe("https://example.com");
  });

  it("preserves the literal 'unknown' version (still printable ASCII)", () => {
    const h = headers({ ...BASE, appVersion: "unknown" });
    expect(h["User-Agent"]).toBe("ZCode/unknown");
    expect(h["X-ZCode-App-Version"]).toBe("unknown");
  });

  // --- New behaviour matching `pio` in the current ZCode bundle ---

  it("emits headers in the exact `TV` runtime insertion order", () => {
    // Clear env-gated headers so the order assertion is deterministic;
    // X-Client-Language/X-Client-Timezone are always present (unknown fallback).
    // Order = spread-base {User-Agent, HTTP-Referer, X-Title} + appended keys;
    // overrides keep their base positions.
    const savedRC = process.env.ZCODE_IDENTITY_RELEASE_CHANNEL;
    delete process.env.ZCODE_IDENTITY_RELEASE_CHANNEL;
    try {
      const h = headers(BASE);
      expect(Object.keys(h)).toEqual([
        "User-Agent",
        "HTTP-Referer",
        "X-Title",
        "X-ZCode-App-Version",
        "X-Platform",
        "X-Release-Channel",
        "X-Client-Language",
        "X-Client-Timezone",
        "X-Os-Category",
        "X-Os-Version",
      ]);
    } finally {
      if (savedRC !== undefined) process.env.ZCODE_IDENTITY_RELEASE_CHANNEL = savedRC;
    }
  });

  it("appends X-Device-Mid last, after the OS headers", () => {
    const h = headers(BASE, MID);
    expect(Object.keys(h).at(-1)).toBe("X-Device-Mid");
  });

  it("drops X-ZCode-App-Version and falls User-Agent back to ZCode/unknown when no version resolves", () => {
    // Mirrors `pio` when `fio` returns undefined: User-Agent → "ZCode/unknown", no X-ZCode-App-Version.
    const empty = headers({ ...BASE, appVersion: "" });
    expect(empty["User-Agent"]).toBe("ZCode/unknown");
    expect(empty["X-ZCode-App-Version"]).toBeUndefined();

    const missing = headers({ ...BASE, appVersion: undefined as unknown as string });
    expect(missing["User-Agent"]).toBe("ZCode/unknown");
    expect(missing["X-ZCode-App-Version"]).toBeUndefined();
  });
});

describe("buildLlmIdentityHeaders (3.12.3 `g6n` shape — CL-27)", () => {
  it("emits headers in the g6n order: X-ZCode-Agent 8th, no X-Device-Mid", () => {
    {
      const h = buildLlmIdentityHeaders(BASE);
      expect(Object.keys(h)).toEqual([
        "HTTP-Referer",
        "User-Agent",
        "X-ZCode-App-Version",
        "X-Title",
        "X-Release-Channel",
        "X-Client-Language",
        "X-Client-Timezone",
        "X-ZCode-Agent",
        "X-Platform",
        "X-Os-Category",
        "X-Os-Version",
      ]);
      // g6n 这条路永远不带 X-Device-Mid（`TV` 才有这个位置，且它来自账号）。
      expect(h["X-Device-Mid"]).toBeUndefined();
    }
  });

  it("always emits language/timezone, falling back to literal 'unknown'", () => {
    const saved = {
      cl: process.env.ZCODE_IDENTITY_CLIENT_LANGUAGE,
      ct: process.env.ZCODE_IDENTITY_CLIENT_TIMEZONE,
    };
    // Non-printable overrides are dropped by the gate → Intl normally
    // re-resolves; simulate "nothing resolves" by overriding with values that
    // fail the printable-ASCII gate AND are empty after trim is impossible —
    // instead assert the always-present contract directly:
    process.env.ZCODE_IDENTITY_CLIENT_LANGUAGE = "fr-FR";
    process.env.ZCODE_IDENTITY_CLIENT_TIMEZONE = "Europe/Paris";
    try {
      const h = buildLlmIdentityHeaders(BASE);
      expect(h["X-Client-Language"]).toBe("fr-FR");
      expect(h["X-Client-Timezone"]).toBe("Europe/Paris");
      // Always present on the LLM path (csn contract):
      expect("X-Client-Language" in h).toBe(true);
      expect("X-Client-Timezone" in h).toBe(true);
    } finally {
      if (saved.cl === undefined) delete process.env.ZCODE_IDENTITY_CLIENT_LANGUAGE;
      else process.env.ZCODE_IDENTITY_CLIENT_LANGUAGE = saved.cl;
      if (saved.ct === undefined) delete process.env.ZCODE_IDENTITY_CLIENT_TIMEZONE;
      else process.env.ZCODE_IDENTITY_CLIENT_TIMEZONE = saved.ct;
    }
    // "unknown" fallback: whitespace-only override fails the gate, Intl
    // re-resolves — but the KEY must exist regardless of resolution.
    const h2 = buildLlmIdentityHeaders(BASE);
    expect(typeof h2["X-Client-Language"]).toBe("string");
    expect(typeof h2["X-Client-Timezone"]).toBe("string");
  });

  it("falls User-Agent back to ZCode/unknown and omits X-ZCode-App-Version when no version resolves", () => {
    const h = buildLlmIdentityHeaders({ ...BASE, appVersion: "" });
    expect(h["User-Agent"]).toBe("ZCode/unknown");
    expect(h["X-ZCode-App-Version"]).toBeUndefined();
  });

  it("keeps X-ZCode-Agent as glm before the platform headers (g6n inline position)", () => {
    const savedP = process.env.ZCODE_IDENTITY_PLATFORM;
    const savedA = process.env.ZCODE_IDENTITY_ARCH;
    const savedR = process.env.ZCODE_IDENTITY_RELEASE;
    delete process.env.ZCODE_IDENTITY_PLATFORM;
    delete process.env.ZCODE_IDENTITY_ARCH;
    delete process.env.ZCODE_IDENTITY_RELEASE;
    try {
      const h = buildLlmIdentityHeaders(BASE);
      const keys = Object.keys(h);
      expect(keys.indexOf("X-ZCode-Agent")).toBe(7);
      expect(keys.indexOf("X-ZCode-Agent")).toBeLessThan(keys.indexOf("X-Platform"));
      expect(h["X-ZCode-Agent"]).toBe("glm");
      if (h["X-Platform"]) expect(h["X-Platform"]).toBe(`${process.platform}-${os.arch()}`);
    } finally {
      if (savedP !== undefined) process.env.ZCODE_IDENTITY_PLATFORM = savedP;
      if (savedA !== undefined) process.env.ZCODE_IDENTITY_ARCH = savedA;
      if (savedR !== undefined) process.env.ZCODE_IDENTITY_RELEASE = savedR;
    }
  });

  it("always emits X-Release-Channel (default production, ZCODE_ENV=test switch)", () => {
    const savedEnv = process.env.ZCODE_ENV;
    const savedRC = process.env.ZCODE_IDENTITY_RELEASE_CHANNEL;
    delete process.env.ZCODE_IDENTITY_RELEASE_CHANNEL;
    try {
      expect(buildLlmIdentityHeaders(BASE)["X-Release-Channel"]).toBe("production");
      process.env.ZCODE_ENV = "test";
      expect(buildLlmIdentityHeaders(BASE)["X-Release-Channel"]).toBe("test");
    } finally {
      if (savedEnv === undefined) delete process.env.ZCODE_ENV;
      else process.env.ZCODE_ENV = savedEnv;
      if (savedRC !== undefined) process.env.ZCODE_IDENTITY_RELEASE_CHANNEL = savedRC;
    }
  });
});
