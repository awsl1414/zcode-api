import { describe, expect, it } from "bun:test";
import { createHmac, hkdfSync } from "node:crypto";
import {
  ClientSigningManager,
  sendWithClientSigning,
} from "./client-signing.js";
import type { UpstreamHeaderPair } from "./upstream.js";

const CRED = "testkey.testsecret";
const API_KEY_ID = "testkey";
const API_KEY_SECRET = "testsecret";
const GATE_URL = "https://zcode.z.ai/api/v1/agent/configs";
const HANDSHAKE_URL = "https://api.z.ai/api/paas/c1f3a7e2/v2/client";
const LLM_URL = "https://api.z.ai/api/coding/paas/v4/chat/completions";
const STARTPLAN_URL = "https://zcode.z.ai/api/v1/zcode-plan/chat/completions";
const OFFPEAK_URL = "https://zcode.z.ai/api/v1/off-peak/anthropic/v1/messages";

const BASE_PAIRS: UpstreamHeaderPair[] = [
  ["content-type", "application/json"],
  ["x-session-id", "sess-123"],
  ["authorization", `Bearer ${CRED}`],
];

function hkdf(secret: string, info: string): Uint8Array<ArrayBuffer> {
  const derived = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("WD_CLIENT_SIGN_KDF_SALT", "utf8"), Buffer.from(info, "utf8"), 32));
  const out = new Uint8Array(derived.length);
  out.set(derived);
  return out;
}

function pair(pairs: UpstreamHeaderPair[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return pairs.find(([k]) => k.toLowerCase() === lower)?.[1];
}

interface HandshakeFixture {
  publicKeyRaw: Uint8Array<ArrayBuffer>;
  cipherB64: string;
}

async function buildHandshakeFixture(secret = API_KEY_SECRET, apiKeyId = API_KEY_ID): Promise<HandshakeFixture> {
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));

  // server plaintext is base64(pkcs8 DER), not the raw DER bytes (bundle: wSt(new TextDecoder().decode(plain)))
  let pkcs8Binary = "";
  for (const b of pkcs8) pkcs8Binary += String.fromCharCode(b);
  const plainBytes = new TextEncoder().encode(btoa(pkcs8Binary));

  const aesKeyBits = hkdf(secret, "ed25519_priv");
  const aesKey = await crypto.subtle.importKey("raw", new Uint8Array(aesKeyBits), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(apiKeyId), tagLength: 128 },
    aesKey,
    plainBytes,
  ));
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv);
  combined.set(encrypted, iv.length);
  let binary = "";
  for (const b of combined) binary += String.fromCharCode(b);
  return { publicKeyRaw, cipherB64: btoa(binary) };
}

interface MockCalls {
  handshakes: { url: string; body: Record<string, unknown>; auth: string }[];
}

// No gate branch on purpose: any fetch of GATE_URL hits the "unexpected fetch"
// throw — a regression guard proving the 3.15.1 static rule never probes
// agent/configs from the signing path.
function signingFetchFixture(fixture: HandshakeFixture, calls: MockCalls): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === HANDSHAKE_URL) {
      calls.handshakes.push({
        url,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        auth: new Headers(init?.headers).get("authorization") ?? "",
      });
      return new Response(JSON.stringify({ code: 200, data: { privateCipher: fixture.cipherB64 } }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe("ClientSigningManager.sign", () => {
  it("signs a coding-plan request (3.15.1 static rule — no agent/configs gate) with a verifiable Ed25519 signature and proof of work", async () => {
    const fixture = await buildHandshakeFixture();
    const calls: MockCalls = { handshakes: [] };
    const manager = new ClientSigningManager({ fetchImpl: signingFetchFixture(fixture, calls) });

    const signed = await manager.sign(LLM_URL, BASE_PAIRS, { credential: CRED, appVersion: "3.8.1" });

    expect(calls.handshakes.length).toBe(1);
    expect(signed.length).toBe(BASE_PAIRS.length + 6);
    expect(pair(signed, "X-App-Id")).toBe("zcode");
    expect(pair(signed, "X-Client-Version")).toBe("3.8.1");
    expect(pair(signed, "X-Client-Nonce")).toMatch(/^[0-9a-f]{32}$/);
    expect(pair(signed, "X-Client-Ts")).toMatch(/^\d+$/);

    // handshake body: sig = base64(HMAC(HKDF(secret, getSignKey_hmac), "get_sign_key\n{apiKeyId}\n{ts}\n{nonce}"))
    // (3.12.3 bundle `XJe.performHandshake`: newline-joined fields — raw \n inside the
    // template literal — base64 output; live-verified 2026-09-18, space-join is rejected)
    const hs = calls.handshakes[0];
    expect(hs.body.apiKey).toBe(CRED);
    expect(hs.auth).toBe(CRED);
    const nonce = String(hs.body.nonce);
    const expectedMac = createHmac("sha256", Buffer.from(hkdf(API_KEY_SECRET, "getSignKey_hmac")))
      .update(`get_sign_key\n${API_KEY_ID}\n${String(hs.body.ts)}\n${nonce}`)
      .digest("base64");
    expect(hs.body.sig).toBe(expectedMac);

    // business signature verifies with the handshake public key
    // (bundle `sendSigned`: "{apiKeyId}\n{ts}\n{clientVersion}\n{sessionId}\n{nonce}")
    const verifyKey = await crypto.subtle.importKey("raw", fixture.publicKeyRaw, "Ed25519", false, ["verify"]);
    const message = `${API_KEY_ID}\n${pair(signed, "X-Client-Ts")}\n3.8.1\nsess-123\n${pair(signed, "X-Client-Nonce")}`;
    const sigBytes = Uint8Array.from(atob(pair(signed, "X-Client-Sig")!), (ch) => ch.charCodeAt(0));
    const verified = await crypto.subtle.verify("Ed25519", verifyKey, sigBytes, new TextEncoder().encode(message));
    expect(verified).toBeTrue();

    // proof of work: 32 hex chars, digest has 8 leading zero bits under the recomputed seed
    // (bundle `vQt`: newline-joined challenge "{apiKeyId}\n{appId}\n{sessionId}\n{ts}" and answer hash "{seed}\n{answer}")
    const pow = pair(signed, "X-Client-Pow")!;
    expect(pow).toMatch(/^[0-9a-f]{32}$/);
    const seedDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${API_KEY_ID}\nzcode\nsess-123\n${pair(signed, "X-Client-Ts")}`));
    const seed = Buffer.from(seedDigest).toString("hex").slice(0, 32);
    const powDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${seed}\n${pow}`)));
    expect(powDigest.byteLength).toBe(32);
    expect(powDigest[0]).toBe(0);
  });

  it("never fetches /api/v1/agent/configs (the 3.12.3–3.14.4 codingPlanSignature gate is gone)", async () => {
    const fixture = await buildHandshakeFixture();
    const fetched: string[] = [];
    const manager = new ClientSigningManager({
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        fetched.push(url);
        if (url === HANDSHAKE_URL) {
          return new Response(JSON.stringify({ code: 200, data: { privateCipher: fixture.cipherB64 } }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch,
    });
    const signed = await manager.sign(LLM_URL, BASE_PAIRS, { credential: CRED, appVersion: "3.8.1" });
    expect(pair(signed, "X-Client-Sig")).toBeDefined();
    expect(fetched).toEqual([HANDSHAKE_URL]);
    expect(fetched.some((u) => u === GATE_URL)).toBeFalse();
  });

  it("re-emits the session id in canonical X-Session-Id form after X-Client-Sig on signed requests", async () => {
    const fixture = await buildHandshakeFixture();
    const calls: MockCalls = { handshakes: [] };
    const manager = new ClientSigningManager({ fetchImpl: signingFetchFixture(fixture, calls) });
    const signed = await manager.sign(LLM_URL, BASE_PAIRS, { credential: CRED, appVersion: "3.8.1" });

    const canonical = signed.filter(([k]) => k === "X-Session-Id");
    expect(canonical).toEqual([["X-Session-Id", "sess-123"]]);
    expect(signed.some(([k]) => k === "x-session-id")).toBeFalse();
    const sigIndex = signed.findIndex(([k]) => k === "X-Client-Sig");
    const sessionIndex = signed.findIndex(([k]) => k === "X-Session-Id");
    expect(sessionIndex).toBe(sigIndex + 1);
  });

  it("reuses the handshake key across sign() calls (one handshake total)", async () => {
    const fixture = await buildHandshakeFixture();
    const calls: MockCalls = { handshakes: [] };
    const manager = new ClientSigningManager({ fetchImpl: signingFetchFixture(fixture, calls) });
    await manager.sign(LLM_URL, BASE_PAIRS, { credential: CRED, appVersion: "3.8.1" });
    await manager.sign(LLM_URL, BASE_PAIRS, { credential: CRED, appVersion: "3.8.1" });
    await manager.sign(LLM_URL, BASE_PAIRS, { credential: CRED, appVersion: "3.8.1" });
    expect(calls.handshakes.length).toBe(1);
  });

  it("never signs exempt paths (start-plan gateway, off-peak)", async () => {
    const fixture = await buildHandshakeFixture();
    const calls: MockCalls = { handshakes: [] };
    const manager = new ClientSigningManager({ fetchImpl: signingFetchFixture(fixture, calls) });
    for (const url of [STARTPLAN_URL, OFFPEAK_URL, "https://api.z.ai/api/v1/zcode-plan/chat/completions/"]) {
      const signed = await manager.sign(url, BASE_PAIRS, { credential: CRED, appVersion: "3.8.1" });
      expect(signed).toBe(BASE_PAIRS);
    }
    expect(calls.handshakes.length).toBe(0);
  });

  it("hard-throws for separator-less credentials (5.0 contract: corrupt, no legacy exemption)", async () => {
    const fixture = await buildHandshakeFixture();
    const calls: MockCalls = { handshakes: [] };
    const manager = new ClientSigningManager({ fetchImpl: signingFetchFixture(fixture, calls) });
    await expect(
      manager.sign(LLM_URL, BASE_PAIRS, { credential: "bigmodelkeyonly", appVersion: "3.8.1" }),
    ).rejects.toThrow("no {apiKeyId}.{apiKeySecret} separator");
    expect(calls.handshakes.length).toBe(0);
  });

  it("skips signing when no x-session-id header is present", async () => {
    const fixture = await buildHandshakeFixture();
    const calls: MockCalls = { handshakes: [] };
    const manager = new ClientSigningManager({ fetchImpl: signingFetchFixture(fixture, calls) });
    const noSession = BASE_PAIRS.filter(([k]) => k !== "x-session-id");
    const signed = await manager.sign(LLM_URL, noSession, { credential: CRED, appVersion: "3.8.1" });
    expect(signed).toBe(noSession);
    expect(calls.handshakes.length).toBe(0);
  });

  it("fails open when the handshake endpoint errors", async () => {
    const manager = new ClientSigningManager({
      fetchImpl: (async () => {
        throw new Error("handshake unreachable");
      }) as unknown as typeof fetch,
    });
    const signed = await manager.sign(LLM_URL, BASE_PAIRS, { credential: CRED, appVersion: "3.8.1" });
    expect(signed).toBe(BASE_PAIRS);
  });
});

describe("ClientSigningManager.isVerifyFailure", () => {
  const manager = new ClientSigningManager();

  it("matches 401 envelopes carrying VERIFY codes in msg/reason/data/error", async () => {
    for (const body of [
      { msg: "VERIFY_SIGNATURE_INVALID" },
      { reason: "VERIFY_APIKEY_EXPIRED" },
      { data: { reason: "VERIFY_SIGNATURE_INVALID" } },
      { error: { message: "VERIFY_SIGNATURE_INVALID" } },
    ]) {
      const resp = new Response(JSON.stringify(body), { status: 401 });
      expect(await manager.isVerifyFailure(resp)).toBeTrue();
    }
  });

  it("rejects other 401s, non-401s, and non-JSON bodies", async () => {
    expect(await manager.isVerifyFailure(new Response('{"msg":"bad key"}', { status: 401 }))).toBeFalse();
    expect(await manager.isVerifyFailure(new Response('{"msg":"VERIFY_SIGNATURE_INVALID"}', { status: 403 }))).toBeFalse();
    expect(await manager.isVerifyFailure(new Response("plain text", { status: 401 }))).toBeFalse();
  });
});

describe("sendWithClientSigning", () => {
  function verify401(): Response {
    return new Response(JSON.stringify({ msg: "VERIFY_SIGNATURE_INVALID" }), { status: 401 });
  }

  it("returns the first successful response without retries", async () => {
    const fixture = await buildHandshakeFixture();
    const calls: MockCalls = { handshakes: [] };
    const manager = new ClientSigningManager({ fetchImpl: signingFetchFixture(fixture, calls) });
    const sends: UpstreamHeaderPair[][] = [];
    const resp = await sendWithClientSigning(manager, {
      url: LLM_URL,
      headerPairs: BASE_PAIRS,
      credential: CRED,
      appVersion: "3.8.1",
      send: async (pairs) => {
        sends.push(pairs);
        return new Response("ok", { status: 200 });
      },
    });
    expect(resp.status).toBe(200);
    expect(sends.length).toBe(1);
    expect(pair(sends[0], "X-Client-Sig")).toBeDefined();
  });

  it("re-handshakes and retries once after a VERIFY 401", async () => {
    const fixture = await buildHandshakeFixture();
    const calls: MockCalls = { handshakes: [] };
    const manager = new ClientSigningManager({ fetchImpl: signingFetchFixture(fixture, calls) });
    const sends: UpstreamHeaderPair[][] = [];
    const resp = await sendWithClientSigning(manager, {
      url: LLM_URL,
      headerPairs: BASE_PAIRS,
      credential: CRED,
      appVersion: "3.8.1",
      send: async (pairs) => {
        sends.push(pairs);
        if (sends.length > 1) return new Response("ok", { status: 200 });
        // Yield real time before the 401: the retry re-sign must land in a
        // later millisecond than the first, or the X-Client-Ts inequality
        // below races (Date.now() is ms-granular; all-microtask mocks can
        // otherwise complete both signs within the same ms).
        await new Promise((r) => setTimeout(r, 2));
        return verify401();
      },
    });
    expect(resp.status).toBe(200);
    expect(sends.length).toBe(2);
    expect(pair(sends[0], "X-Client-Ts")).not.toBe(pair(sends[1], "X-Client-Ts"));
    expect(calls.handshakes.length).toBe(2);
  });

  it("falls back to unsigned after two VERIFY 401s and bypasses future signing", async () => {
    const fixture = await buildHandshakeFixture();
    const calls: MockCalls = { handshakes: [] };
    const manager = new ClientSigningManager({ fetchImpl: signingFetchFixture(fixture, calls) });
    const sends: UpstreamHeaderPair[][] = [];
    const resp = await sendWithClientSigning(manager, {
      url: LLM_URL,
      headerPairs: BASE_PAIRS,
      credential: CRED,
      appVersion: "3.8.1",
      send: async (pairs) => {
        sends.push(pairs);
        return verify401();
      },
    });
    expect(resp.status).toBe(401);
    expect(sends.length).toBe(3);
    expect(pair(sends[2], "X-Client-Sig")).toBeUndefined();
    expect(sends[2].length).toBe(BASE_PAIRS.length);

    const afterBypass = await manager.sign(LLM_URL, BASE_PAIRS, { credential: CRED, appVersion: "3.8.1" });
    expect(afterBypass).toBe(BASE_PAIRS);
  });

  it("sends as-is when the manager is null (feature disabled)", async () => {
    let sendCalls = 0;
    const resp = await sendWithClientSigning(null, {
      url: LLM_URL,
      headerPairs: BASE_PAIRS,
      credential: CRED,
      appVersion: "3.8.1",
      send: async (pairs) => {
        sendCalls++;
        expect(pairs).toBe(BASE_PAIRS);
        return new Response("ok", { status: 200 });
      },
    });
    expect(resp.status).toBe(200);
    expect(sendCalls).toBe(1);
  });

  it("does not apply the retry ladder when the request was never signed (exempt path)", async () => {
    const fixture = await buildHandshakeFixture();
    const calls: MockCalls = { handshakes: [] };
    const manager = new ClientSigningManager({ fetchImpl: signingFetchFixture(fixture, calls) });
    const sends: UpstreamHeaderPair[][] = [];
    const resp = await sendWithClientSigning(manager, {
      url: STARTPLAN_URL,
      headerPairs: BASE_PAIRS,
      credential: CRED,
      appVersion: "3.8.1",
      send: async (pairs) => {
        sends.push(pairs);
        return new Response(JSON.stringify({ msg: "VERIFY_SIGNATURE_INVALID" }), { status: 401 });
      },
    });
    expect(resp.status).toBe(401);
    expect(sends.length).toBe(1);
    expect(calls.handshakes.length).toBe(0);
  });
});

describe("poW nonce/format details", () => {
  it("nonce uses crypto randomness (two signs differ)", async () => {
    const fixture = await buildHandshakeFixture();
    const calls: MockCalls = { handshakes: [] };
    const manager = new ClientSigningManager({ fetchImpl: signingFetchFixture(fixture, calls) });
    const a = await manager.sign(LLM_URL, BASE_PAIRS, { credential: CRED, appVersion: "3.8.1" });
    const b = await manager.sign(LLM_URL, BASE_PAIRS, { credential: CRED, appVersion: "3.8.1" });
    expect(pair(a, "X-Client-Nonce")).not.toBe(pair(b, "X-Client-Nonce"));
  });
});

// ── 3.15.1 project-access-token plane (bigmodel OAuth, `FSr` dual form) ──

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function makeProjectJwt(apiKey: string, expSeconds: number): string {
  return `${b64url({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })}.${b64url({ token_use: "project_access", api_key: apiKey, exp: expSeconds })}.sig`;
}
const OAUTH = "oauth-es512-token";
const JWT_CRED = makeProjectJwt("testkey", Math.floor(Date.now() / 1000) + 3600);
const JWT_URL = "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions";

describe("project-access JWT signing form (bigmodel OAuth)", () => {
  it("parses the JWT form: apiKeyId from the api_key claim, handshake body field accessToken, Bearer auth", async () => {
    // privateCipher must be encrypted under the JWT (the signing secret), AAD = api_key claim
    const fixture = await buildHandshakeFixture(JWT_CRED, "testkey");
    const calls: MockCalls = { handshakes: [] };
    const manager = new ClientSigningManager({
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === JWT_URL) throw new Error("LLM request must not leak into signing fetch");
        if (url.endsWith("/api/paas/c1f3a7e2/v2/client")) {
          calls.handshakes.push({
            url,
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
            auth: new Headers(init?.headers).get("authorization") ?? "",
          });
          return new Response(JSON.stringify({ code: 200, data: { privateCipher: fixture.cipherB64 } }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch,
    });

    const signed = await manager.sign(JWT_URL, BASE_PAIRS, { credential: JWT_CRED, appVersion: "3.8.1" });
    expect(pair(signed, "X-Client-Sig")).toBeDefined();
    const hs = calls.handshakes[0]!;
    // FSr semantics: body field switches to accessToken, auth = Bearer JWT
    expect(Object.keys(hs.body)).toContain("accessToken");
    expect(hs.body.accessToken).toBe(JWT_CRED);
    expect(hs.auth).toBe(`Bearer ${JWT_CRED}`);
    expect(hs.body.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("mints a project JWT via getCustomerInfo + access_tokens (bare vs Bearer auth split), then signs", async () => {
    const mintedJwt = makeProjectJwt("testkey", Math.floor(Date.now() / 1000) + 3600);
    const fixture = await buildHandshakeFixture(mintedJwt, "testkey");
    const calls: MockCalls = { handshakes: [] };
    const mintUrls: string[] = [];
    const mintAuths: string[] = [];
    const manager = new ClientSigningManager({
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        if (url.endsWith("/api/biz/customer/getCustomerInfo")) {
          mintUrls.push(url); mintAuths.push(auth);
          // bare token (no Bearer) on bigmodel getCustomerInfo
          expect(auth).toBe(OAUTH);
          return new Response(JSON.stringify({ code: 200, data: { organizations: [{ organizationId: "org-1", projects: [{ projectId: "proj-1", projectType: "1" }] }] } }), { status: 200 });
        }
        if (url.includes("/api_keys/testkey/access_tokens")) {
          mintUrls.push(url); mintAuths.push(auth);
          // Bearer form on access_tokens
          expect(auth).toBe(`Bearer ${OAUTH}`);
          /* 铸 Project JWT 用的 `clientVersion` 与签名请求的 appVersion 同一份 */
          expect(JSON.parse(String(init?.body))).toEqual({ clientType: "zcode", clientVersion: "3.8.1" });
          return new Response(JSON.stringify({ code: 200, data: { accessToken: mintedJwt } }), { status: 200 });
        }
        if (url.endsWith("/api/paas/c1f3a7e2/v2/client")) {
          calls.handshakes.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown>, auth: new Headers(init?.headers).get("authorization") ?? "" });
          return new Response(JSON.stringify({ code: 200, data: { privateCipher: fixture.cipherB64 } }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch,
    });

    const signed = await manager.sign(JWT_URL, BASE_PAIRS, {
      credential: CRED, appVersion: "3.8.1", oauthAccessToken: OAUTH, provider: "bigmodel",
    });
    expect(pair(signed, "X-Client-Sig")).toBeDefined();
    expect(mintUrls.some((u) => u.includes("/api_keys/testkey/access_tokens"))).toBeTrue();
    // minted JWT form handshake: accessToken body field
    expect(Object.keys(calls.handshakes[0]!.body)).toContain("accessToken");
  });

  it("negative-caches mint failures (one mint attempt per cooldown window)", async () => {
    let mints = 0;
    const manager = new ClientSigningManager({
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/access_tokens")) { mints++; return new Response(JSON.stringify({ code: 404 }), { status: 200 }); }
        if (url.includes("getCustomerInfo")) return new Response(JSON.stringify({ code: 200, data: { organizations: [{ organizationId: "org-1", projects: [{ projectId: "p1" }] }] } }), { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch,
    });
    const cred = { credential: CRED, appVersion: "3.8.1", oauthAccessToken: OAUTH, provider: "bigmodel" as const };
    await manager.sign(JWT_URL, BASE_PAIRS, cred);
    await manager.sign(JWT_URL, BASE_PAIRS, cred);
    expect(mints).toBe(1); // negative cache: no re-mint inside the window
  });
});

/**
 * 签名状态按凭据隔离。
 *
 * 修复前的两处单槽状态：
 * - `projectJwt` 只存一个 → 两个 bigmodel 账号来回抖动，每次请求都重新铸 JWT；
 * - `mintNegUntil` 只存一个时间戳 → 一个账号铸造失败，所有账号被负缓存 60 秒。
 *
 * 两个用例分别用「铸造次数」和「另一个账号仍能铸」来钉住这两条。
 */
describe("project-access JWT slots per credential", () => {
  const CRED_A = "keyA.secretA";
  const CRED_B = "keyB.secretB";
  const OAUTH_A = "oauth-token-a";
  const OAUTH_B = "oauth-token-b";
  const EXP = Math.floor(Date.now() / 1000) + 3600;

  /** 按 apiKeyId 分槽的铸造 + 握手桩，计数每次 access_tokens 调用。 */
  async function makeTwoAccountFixture(options: { failFor?: string } = {}) {
    const jwtA = makeProjectJwt("keyA", EXP);
    const jwtB = makeProjectJwt("keyB", EXP);
    const fixtureA = await buildHandshakeFixture(jwtA, "keyA");
    const fixtureB = await buildHandshakeFixture(jwtB, "keyB");
    const mints: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/api/biz/customer/getCustomerInfo")) {
        return new Response(JSON.stringify({
          code: 200,
          data: { organizations: [{ organizationId: "org-1", projects: [{ projectId: "proj-1", projectType: "1" }] }] },
        }), { status: 200 });
      }
      if (url.includes("/access_tokens")) {
        const apiKeyId = /\/api_keys\/([^/]+)\/access_tokens/.exec(url)?.[1] ?? "?";
        mints.push(apiKeyId);
        if (options.failFor === apiKeyId) return new Response(JSON.stringify({ code: 404 }), { status: 200 });
        return new Response(JSON.stringify({ code: 200, data: { accessToken: apiKeyId === "keyA" ? jwtA : jwtB } }), { status: 200 });
      }
      if (url.endsWith("/api/paas/c1f3a7e2/v2/client")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const fixture = body.accessToken === jwtA ? fixtureA : fixtureB;
        return new Response(JSON.stringify({ code: 200, data: { privateCipher: fixture.cipherB64 } }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    return { fetchImpl, mints };
  }

  const credA = { credential: CRED_A, appVersion: "3.8.1", oauthAccessToken: OAUTH_A, provider: "bigmodel" as const };
  const credB = { credential: CRED_B, appVersion: "3.8.1", oauthAccessToken: OAUTH_B, provider: "bigmodel" as const };

  it("两个账号交替请求不互相踢（每个凭据只铸一次）", async () => {
    const { fetchImpl, mints } = await makeTwoAccountFixture();
    const manager = new ClientSigningManager({ fetchImpl });

    // A → B → A → B：单槽实现会在这里铸 4 次（每次都丢掉对方的缓存）
    for (const cred of [credA, credB, credA, credB]) {
      const signed = await manager.sign(JWT_URL, BASE_PAIRS, cred);
      expect(pair(signed, "X-Client-Sig")).toBeDefined();
    }

    expect(mints).toEqual(["keyA", "keyB"]);
  });

  it("一个账号铸造失败不影响另一个账号（负缓存不串）", async () => {
    const { fetchImpl, mints } = await makeTwoAccountFixture({ failFor: "keyA" });
    const manager = new ClientSigningManager({ fetchImpl });

    // A 铸不出来 → 负缓存只记在 keyA 名下，签名 fail-open 走 apiKey 形态
    await manager.sign(JWT_URL, BASE_PAIRS, credA);
    expect(mints).toEqual(["keyA"]);

    // B 必须还能铸（单时间戳实现会让这里也被冻结 60 秒）
    await manager.sign(JWT_URL, BASE_PAIRS, credB);
    expect(mints).toEqual(["keyA", "keyB"]);

    // A 仍在自己的冷却窗口里：不再重复铸
    await manager.sign(JWT_URL, BASE_PAIRS, credA);
    expect(mints).toEqual(["keyA", "keyB"]);
  });
});

/**
 * 每账号出口代理（出线点与缓存 key）。
 *
 * 代理维度在注入了 `fetchImpl` 的用例里观察不到：`egress.ts::fetchVia` 对注入的
 * fetch 原样调用、不套 dispatcher。所以这里用一个**非法代理 URL**做探针：
 * `egressForOptions` 在发请求之前就抛，只有握手确实把 `egress` 交给了出线层，
 * 才会出现「一次 fetch 都没发、请求 fail-open 未签名」的结果。
 */
describe("ClientSigningManager × 账号代理", () => {
  const PROXY_A = { proxyUrl: "http://127.0.0.1:7890" };
  const PROXY_B = { proxyUrl: "http://127.0.0.1:7891" };

  it("握手走调用方给的代理：非法代理 URL 让握手在出线层失败、请求未签名", async () => {
    const fixture = await buildHandshakeFixture();
    const calls: MockCalls = { handshakes: [] };
    const manager = new ClientSigningManager({ fetchImpl: signingFetchFixture(fixture, calls) });

    const unsigned = await manager.sign(
      LLM_URL,
      BASE_PAIRS,
      { credential: CRED, appVersion: "3.8.1" },
      { proxyUrl: "not-a-proxy-url" },
    );
    expect(pair(unsigned, "X-Client-Sig")).toBeUndefined();
    // 出线层在发请求之前拒了代理 URL，握手一次都没发出去
    expect(calls.handshakes.length).toBe(0);

    const signed = await manager.sign(LLM_URL, BASE_PAIRS, { credential: CRED, appVersion: "3.8.1" });
    expect(pair(signed, "X-Client-Sig")).toBeDefined();
    expect(calls.handshakes.length).toBe(1);
  });

  it("同一凭据的两台出口各占一槽：换代理要重新握手，不命中旧代理的材料", async () => {
    const fixture = await buildHandshakeFixture();
    const calls: MockCalls = { handshakes: [] };
    const manager = new ClientSigningManager({ fetchImpl: signingFetchFixture(fixture, calls) });
    const cred = { credential: CRED, appVersion: "3.8.1" };

    expect(pair(await manager.sign(LLM_URL, BASE_PAIRS, cred, PROXY_A), "X-Client-Sig")).toBeDefined();
    expect(calls.handshakes.length).toBe(1);

    // 同一代理再来一次：命中缓存，不重复握手
    expect(pair(await manager.sign(LLM_URL, BASE_PAIRS, cred, PROXY_A), "X-Client-Sig")).toBeDefined();
    expect(calls.handshakes.length).toBe(1);

    // 换到另一台代理：新槽，重新握手
    expect(pair(await manager.sign(LLM_URL, BASE_PAIRS, cred, PROXY_B), "X-Client-Sig")).toBeDefined();
    expect(calls.handshakes.length).toBe(2);
  });

  it("invalidate / setBypass 打在带代理的那一槽上", async () => {
    const fixture = await buildHandshakeFixture();
    const calls: MockCalls = { handshakes: [] };
    const manager = new ClientSigningManager({ fetchImpl: signingFetchFixture(fixture, calls) });
    const cred = { credential: CRED, appVersion: "3.8.1" };

    await manager.sign(LLM_URL, BASE_PAIRS, cred, PROXY_A);
    expect(calls.handshakes.length).toBe(1);

    // 失效另一台代理的槽：A 的私钥材料不该被丢掉
    manager.invalidate(LLM_URL, CRED, PROXY_B);
    expect(pair(await manager.sign(LLM_URL, BASE_PAIRS, cred, PROXY_A), "X-Client-Sig")).toBeDefined();
    expect(calls.handshakes.length).toBe(1);

    // 失效 A 的槽：下一次必须重新握手
    manager.invalidate(LLM_URL, CRED, PROXY_A);
    expect(pair(await manager.sign(LLM_URL, BASE_PAIRS, cred, PROXY_A), "X-Client-Sig")).toBeDefined();
    expect(calls.handshakes.length).toBe(2);

    // B 是独立的一槽（这里才第一次握手）
    expect(pair(await manager.sign(LLM_URL, BASE_PAIRS, cred, PROXY_B), "X-Client-Sig")).toBeDefined();
    expect(calls.handshakes.length).toBe(3);

    // 免签标记也按代理分：A 免签，B 照旧签名
    manager.setBypass(LLM_URL, CRED, PROXY_A);
    expect(pair(await manager.sign(LLM_URL, BASE_PAIRS, cred, PROXY_A), "X-Client-Sig")).toBeUndefined();
    expect(calls.handshakes.length).toBe(3);
    expect(pair(await manager.sign(LLM_URL, BASE_PAIRS, cred, PROXY_B), "X-Client-Sig")).toBeDefined();
    expect(calls.handshakes.length).toBe(3);
  });
});
