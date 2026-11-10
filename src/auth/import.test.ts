/**
 * Credential import tests — parsing, classification, merge policy and the
 * two source flows. No real filesystem or network: the file reader, the store
 * and the resolver transport are all injected.
 */
import { describe, it, expect } from "bun:test";
import {
  classifySecret,
  defaultCredentialsPath,
  importCredential,
  ImportError,
  mergeCredential,
  parseJwtSource,
  parseZcodeCredentialsFile,
  summarizeImport,
} from "./import.js";
import type { Credential } from "./types.js";

// --- fixtures (payloads mirror live tokens, signatures are dummies) ---------

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf-8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const fakeJwt = (payload: Record<string, unknown>): string =>
  `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.c2ln`;

/** Issue time baked into the fixture tokens (2026-11-05T00:00:00Z). */
const FIXTURE_ISSUED_AT = 1_793_836_800;

/** `zcodejwttoken` shape: user_id / sub / token_version / iat, no exp. */
const PLAN_JWT = fakeJwt({
  user_id: "40651765947496863",
  sub: "40651765947496863",
  token_version: 0,
  iat: FIXTURE_ISSUED_AT,
});

/** bigmodel OAuth access token shape: customer_id / user_key / user_id, no sub. */
const OAUTH_TOKEN = fakeJwt({
  customer_id: 5241463,
  user_channel: "WEB",
  user_id: 5241463,
  user_key: "k3y",
  user_type: "PERSONAL",
  username: "someone",
});

/** coding-plan key pair, as `pluginSecret.accessToken`. */
const API_KEY_PAIR = "bc5628c5df3540399b10e5fddda658de.2crdkNuLNyVf8pRj";

const jsonResponse = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const bigmodelResolverFetch = (): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/biz/customer/getCustomerInfo")) {
      return jsonResponse({
        code: 200,
        data: {
          organizations: [
            {
              organizationName: "默认机构(496863)",
              organizationId: "org-1",
              projects: [{ projectName: "默认项目", projectId: "proj-1" }],
            },
          ],
        },
      });
    }
    if (url.includes("/api_keys/copy/")) {
      return jsonResponse({ code: 200, data: { secretKey: "secretval" } });
    }
    if (url.endsWith("/api_keys")) {
      return jsonResponse({ code: 200, data: [{ name: "zcode-api-key", apiKey: "keyid" }] });
    }
    return jsonResponse({ code: 404, msg: `unexpected ${url}` }, 404);
  }) as unknown as typeof fetch;

const failingFetch = (status = 401): typeof fetch =>
  (async () => jsonResponse({ code: status, msg: "token expired" }, status)) as unknown as typeof fetch;

const captureStore = () => {
  const state: { saved: Credential | null } = { saved: null };
  return {
    state,
    save: async (cred: Credential) => {
      state.saved = cred;
    },
  };
};

// --- classification --------------------------------------------------------

describe("classifySecret", () => {
  it("recognizes a plan JWT", () => {
    expect(classifySecret(PLAN_JWT)).toBe("plan-jwt");
    expect(classifySecret(`  ${PLAN_JWT}  `)).toBe("plan-jwt");
  });

  it("recognizes a bigmodel OAuth access token", () => {
    expect(classifySecret(OAUTH_TOKEN)).toBe("oauth-access-token");
  });

  it("recognizes a coding-plan key pair", () => {
    expect(classifySecret(API_KEY_PAIR)).toBe("api-key-pair");
  });

  it("rejects minted project-access tokens (they are 5h signing tokens, not accounts)", () => {
    const minted = fakeJwt({ token_use: "project_access", api_key: "keyid" });
    expect(classifySecret(minted)).toBe("unknown");
  });

  it("rejects garbage, bare keys and empty input", () => {
    expect(classifySecret("")).toBe("unknown");
    expect(classifySecret("not-a-token")).toBe("unknown");
    expect(classifySecret("onlyonepart.definitely.not.a.payload")).toBe("unknown");
  });
});

// --- source parsing --------------------------------------------------------

describe("parseJwtSource", () => {
  it("accepts a plan JWT", () => {
    const parsed = parseJwtSource(PLAN_JWT);
    expect(parsed.jwt).toBe(PLAN_JWT);
    expect(parsed.provider).toBeUndefined();
    expect(parsed.warnings).toEqual([]);
  });

  it("rejects an OAuth token pasted as a JWT", () => {
    expect(() => parseJwtSource(OAUTH_TOKEN)).toThrow(ImportError);
    expect(() => parseJwtSource(OAUTH_TOKEN)).toThrow(/plan JWT/);
  });

  it("rejects a JWT without iat", () => {
    expect(() => parseJwtSource(fakeJwt({ sub: "x", token_version: 0 }))).toThrow(/iat/);
  });

  it("rejects empty input", () => {
    expect(() => parseJwtSource("  ")).toThrow(ImportError);
  });
});

describe("parseZcodeCredentialsFile — flat map store", () => {
  const file = JSON.stringify({
    "oauth:active_provider": "bigmodel",
    "oauth:bigmodel:access_token": OAUTH_TOKEN,
    "oauth:bigmodel:user_info": "enc:v1:AAAA",
    "project-key-location:v1:%5B%22https%3A%2F%2Fbigmodel.cn%22%5D": "enc:v1:BBBB",
    zcodejwttoken: PLAN_JWT,
  });

  it("picks provider, OAuth token and plan JWT; leaves enc:v1 blobs alone", () => {
    const parsed = parseZcodeCredentialsFile(file, { source: "creds.json" });
    expect(parsed.source).toBe("creds.json");
    expect(parsed.provider).toBe("bigmodel");
    expect(parsed.oauthAccessToken).toBe(OAUTH_TOKEN);
    expect(parsed.jwt).toBe(PLAN_JWT);
    expect(parsed.apiKeyPair).toBeUndefined();
    expect(parsed.warnings).toEqual([]);
  });

  it("infers the provider when only one token is present and active_provider is missing", () => {
    const parsed = parseZcodeCredentialsFile(JSON.stringify({ "oauth:zai:access_token": OAUTH_TOKEN }));
    expect(parsed.provider).toBe("zai");
    expect(parsed.warnings.join(" ")).toMatch(/inferred provider "zai"/);
  });

  it("asks for --provider when several providers are present instead of guessing", () => {
    const file = JSON.stringify({
      "oauth:zai:access_token": OAUTH_TOKEN,
      "oauth:bigmodel:access_token": OAUTH_TOKEN,
      zcodejwttoken: PLAN_JWT,
    });
    expect(() => parseZcodeCredentialsFile(file)).toThrow(/Pass --provider/);
    try {
      parseZcodeCredentialsFile(file);
    } catch (err) {
      expect((err as ImportError).code).toBe("provider_required");
    }
  });

  it("uses the requested provider's token when --provider is given", () => {
    const file = JSON.stringify({
      "oauth:active_provider": "zai",
      "oauth:zai:access_token": OAUTH_TOKEN,
      "oauth:bigmodel:access_token": "bigmodel-token",
    });
    const parsed = parseZcodeCredentialsFile(file, { provider: "bigmodel" });
    expect(parsed.provider).toBe("bigmodel");
    expect(parsed.oauthAccessToken).toBe("bigmodel-token");
    expect(parsed.warnings).toEqual([]);
  });

  it("does not hand one provider's token to another provider", () => {
    const parsed = parseZcodeCredentialsFile(
      JSON.stringify({ "oauth:zai:access_token": OAUTH_TOKEN, zcodejwttoken: PLAN_JWT }),
      { provider: "bigmodel" },
    );
    // The zai token must not be used for a bigmodel exchange.
    expect(parsed.oauthAccessToken).toBeUndefined();
    expect(parsed.provider).toBe("bigmodel");
    expect(parsed.warnings.join(" ")).toMatch(/No oauth:bigmodel:access_token in the file/);
    expect(parsed.warnings.join(" ")).toMatch(/found: zai/);
    expect(parsed.jwt).toBe(PLAN_JWT);
  });

  it("falls back to the only provider with a token when active_provider names the other one", () => {
    const parsed = parseZcodeCredentialsFile(
      JSON.stringify({ "oauth:active_provider": "zai", "oauth:bigmodel:access_token": OAUTH_TOKEN }),
    );
    expect(parsed.provider).toBe("bigmodel");
    expect(parsed.oauthAccessToken).toBe(OAUTH_TOKEN);
    expect(parsed.warnings.join(" ")).toMatch(/No oauth:zai:access_token/);
    expect(parsed.warnings.join(" ")).toMatch(/Falling back to "bigmodel"/);
  });

  it("rejects a file with neither token nor JWT", () => {
    expect(() =>
      parseZcodeCredentialsFile(JSON.stringify({ "oauth:active_provider": "zai", "oauth:zai:user_info": "enc:v1:x" })),
    ).toThrow(/No usable access token/);
  });

  it("rejects malformed JSON and unknown shapes", () => {
    expect(() => parseZcodeCredentialsFile("{oops")).toThrow(/Not valid JSON/);
    expect(() => parseZcodeCredentialsFile(JSON.stringify({ hello: "world" }))).toThrow(/Unrecognized credential file shape/);
    expect(() => parseZcodeCredentialsFile(JSON.stringify(["a"]))).toThrow(/Expected a JSON object/);
  });
});

describe("parseZcodeCredentialsFile — pluginSecret", () => {
  const pluginSecret = {
    accessToken: API_KEY_PAIR,
    deviceMid: "9a04f249-7c02-4f23-91ac-7ee1ee9fdd06",
    idPrefix: "zcode-user-",
    jwt: PLAN_JWT,
    userId: "48721765504090043",
    zcodePlan: "start-plan",
  };

  it("takes the apiKey pair and plan JWT without any network call", () => {
    const parsed = parseZcodeCredentialsFile(JSON.stringify({ pluginSecret }));
    expect(parsed.apiKeyPair).toBe(API_KEY_PAIR);
    expect(parsed.jwt).toBe(PLAN_JWT);
    expect(parsed.planHint).toBe("start-plan");
    expect(parsed.oauthAccessToken).toBeUndefined();
    expect(parsed.provider).toBeUndefined();
    expect(parsed.warnings).toEqual([]);
  });

  it("also accepts the pluginSecret object at the top level", () => {
    const parsed = parseZcodeCredentialsFile(JSON.stringify(pluginSecret));
    expect(parsed.apiKeyPair).toBe(API_KEY_PAIR);
    expect(parsed.planHint).toBe("start-plan");
  });

  it("treats an OAuth token in `accessToken` as the resolver seed", () => {
    const parsed = parseZcodeCredentialsFile(JSON.stringify({ pluginSecret: { accessToken: OAUTH_TOKEN } }));
    expect(parsed.oauthAccessToken).toBe(OAUTH_TOKEN);
    expect(parsed.apiKeyPair).toBeUndefined();
  });
});

// --- merge policy ----------------------------------------------------------

describe("mergeCredential", () => {
  const existing: Credential = { provider: "zai", apiKey: "old", secret: "olds", jwt: "old-jwt" };

  it("keeps the stored apiKey when the import only carries a JWT", () => {
    const merged = mergeCredential(existing, { provider: "zai", apiKey: "", jwt: PLAN_JWT });
    expect(merged).toEqual({ provider: "zai", apiKey: "old", secret: "olds", jwt: PLAN_JWT });
  });

  it("keeps the stored JWT when the import only carries a key", () => {
    const merged = mergeCredential(existing, { provider: "zai", apiKey: "new", secret: "news" });
    expect(merged).toEqual({ provider: "zai", apiKey: "new", secret: "news", jwt: "old-jwt" });
  });

  it("never pairs a new apiKey with the old secret", () => {
    const merged = mergeCredential(existing, { provider: "zai", apiKey: "new" });
    expect(merged.apiKey).toBe("new");
    expect(merged.secret).toBeUndefined();
  });

  it("carries userId from the stored credential (imports never invent it)", () => {
    const merged = mergeCredential({ provider: "zai", apiKey: "old", userId: "u-1" }, { provider: "zai", apiKey: "new" });
    expect(merged.userId).toBe("u-1");
  });

  it("refuses to mix providers without --replace", () => {
    expect(() => mergeCredential(existing, { provider: "bigmodel", apiKey: "k" })).toThrow(ImportError);
    try {
      mergeCredential(existing, { provider: "bigmodel", apiKey: "k" });
    } catch (err) {
      expect((err as ImportError).code).toBe("provider_mismatch");
      expect((err as Error).message).toMatch(/--replace/);
    }
  });

  it("replaces the whole credential with --replace", () => {
    expect(mergeCredential(existing, { provider: "bigmodel", apiKey: "k" }, { replace: true })).toEqual({
      provider: "bigmodel",
      apiKey: "k",
    });
  });

  it("carries no expiry field at all (the type has none)", () => {
    const merged = mergeCredential(
      { provider: "zai", apiKey: "old" },
      { provider: "zai", apiKey: "" , jwt: PLAN_JWT },
    );
    // 凭据没有 `would-expire-at` 这一列：任何导入路径都不产生它，所以合并结果
    // 也不该多出键来（面板/调度器都不看它，`inferRoutes` 只看账号仓那份）。
    expect(Object.keys(merged).sort()).toEqual(["apiKey", "jwt", "provider"]);
  });
});

// --- orchestration ---------------------------------------------------------

describe("importCredential — pasted JWT", () => {
  it("imports offline and merges into an existing apiKey", async () => {
    const store = captureStore();
    let fetched = 0;
    const report = await importCredential({
      jwt: PLAN_JWT,
      defaultProvider: "bigmodel",
      load: async () => ({ provider: "bigmodel", apiKey: "keyid.secretval" }),
      save: store.save,
      fetchImpl: (async () => {
        fetched += 1;
        return jsonResponse({});
      }) as unknown as typeof fetch,
    });

    expect(fetched).toBe(0);
    expect(report.provider).toBe("bigmodel");
    expect(report.codingPlanReady).toBe(true);
    expect(report.startPlanReady).toBe(true);
    expect(report.jwtUserId).toBe("40651765947496863");
    // 上游账号标识随 plan JWT 一起落盘（JWT-only 账号的指纹靠它区分）。
    expect(store.state.saved).toEqual({
      provider: "bigmodel",
      apiKey: "keyid.secretval",
      jwt: PLAN_JWT,
      userId: "40651765947496863",
    });
  });

  it("falls back to the default provider with a warning when nothing else names one", async () => {
    const store = captureStore();
    const report = await importCredential({
      jwt: PLAN_JWT,
      defaultProvider: "zai",
      load: async () => null,
      save: store.save,
    });
    expect(report.provider).toBe("zai");
    expect(report.codingPlanReady).toBe(false);
    expect(report.startPlanReady).toBe(true);
    expect(report.warnings.join(" ")).toMatch(/Provider not stated/);
  });

  it("rejects an OAuth token passed to --jwt", async () => {
    await expect(
      importCredential({ jwt: OAUTH_TOKEN, defaultProvider: "zai", load: async () => null, save: async () => {} }),
    ).rejects.toThrow(/plan JWT/);
  });

  it("refuses --jwt together with --file", async () => {
    await expect(
      importCredential({ jwt: PLAN_JWT, file: "x.json", defaultProvider: "zai", load: async () => null, save: async () => {} }),
    ).rejects.toThrow(/either --jwt or --file/);
  });
});

describe("importCredential — ZCode credential file", () => {
  const flatMap = JSON.stringify({
    "oauth:active_provider": "bigmodel",
    "oauth:bigmodel:access_token": OAUTH_TOKEN,
    zcodejwttoken: PLAN_JWT,
  });

  it("exchanges the OAuth token for the coding-plan key and keeps the signing seed", async () => {
    const store = captureStore();
    const report = await importCredential({
      file: "credentials.json",
      defaultProvider: "zai",
      readFile: () => flatMap,
      load: async () => null,
      save: store.save,
      fetchImpl: bigmodelResolverFetch(),
    });

    expect(report.provider).toBe("bigmodel");
    expect(report.credential.apiKey).toBe("keyid.secretval");
    expect(report.credential.oauthAccessToken).toBe(OAUTH_TOKEN);
    expect(report.credential.jwt).toBe(PLAN_JWT);
    expect(report.codingPlanReady).toBe(true);
    expect(store.state.saved).toEqual(report.credential);
  });

  it("still imports the plan JWT when the OAuth token is dead", async () => {
    const store = captureStore();
    const report = await importCredential({
      file: "credentials.json",
      defaultProvider: "zai",
      readFile: () => flatMap,
      load: async () => null,
      save: store.save,
      fetchImpl: failingFetch(401),
    });

    expect(report.codingPlanReady).toBe(false);
    expect(report.startPlanReady).toBe(true);
    expect(report.warnings.join(" ")).toMatch(/Could not exchange the OAuth access token/);
    expect(store.state.saved?.apiKey).toBe("");
    expect(store.state.saved?.jwt).toBe(PLAN_JWT);
  });

  it("imports a pluginSecret file with no network at all", async () => {
    const store = captureStore();
    let fetched = 0;
    const report = await importCredential({
      file: "plugin.json",
      replace: true,
      defaultProvider: "zai",
      readFile: () =>
        JSON.stringify({
          pluginSecret: { accessToken: API_KEY_PAIR, jwt: PLAN_JWT, zcodePlan: "start-plan", idPrefix: "zcode-user-" },
        }),
      load: async () => ({ provider: "zai", apiKey: "old" }),
      save: store.save,
      fetchImpl: (async () => {
        fetched += 1;
        return jsonResponse({});
      }) as unknown as typeof fetch,
    });

    expect(fetched).toBe(0);
    expect(report.credential).toEqual({
      provider: "zai",
      apiKey: "bc5628c5df3540399b10e5fddda658de",
      secret: "2crdkNuLNyVf8pRj",
      jwt: PLAN_JWT,
      userId: "40651765947496863",
    });
    expect(report.planHint).toBe("start-plan");
  });

  it("does not store oauthAccessToken for zai (only bigmodel's signing plane uses it)", async () => {
    const store = captureStore();
    const zaiFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/auth/z/login")) return jsonResponse({ access_token: "biz-token" });
      if (url.includes("/api/biz/customer/getCustomerInfo")) {
        return jsonResponse({
          code: 200,
          data: {
            organizations: [
              {
                organizationName: "默认机构",
                organizationId: "org-1",
                projects: [{ projectName: "默认项目", projectId: "proj-1" }],
              },
            ],
          },
        });
      }
      if (url.includes("/api_keys/copy/")) return jsonResponse({ code: 200, data: { secretKey: "sec2" } });
      if (url.endsWith("/api_keys") && method === "POST") {
        return jsonResponse({ code: 200, data: { apiKey: "zai-keyid" } });
      }
      if (url.endsWith("/api_keys")) return jsonResponse({ code: 200, data: [] });
      return jsonResponse({ code: 404 }, 404);
    }) as unknown as typeof fetch;

    const report = await importCredential({
      file: "credentials.json",
      provider: "zai",
      defaultProvider: "zai",
      readFile: () => JSON.stringify({ "oauth:zai:access_token": OAUTH_TOKEN }),
      load: async () => null,
      save: store.save,
      fetchImpl: zaiFetch,
    });

    expect(report.credential.provider).toBe("zai");
    expect(report.credential.oauthAccessToken).toBeUndefined();
    expect(report.credential.jwt).toBeUndefined();
    expect(report.startPlanReady).toBe(false);
  });

  it("refuses a provider change before spending the OAuth exchange", async () => {
    let fetched = 0;
    const attempt = importCredential({
      file: "credentials.json",
      defaultProvider: "zai",
      readFile: () => flatMap,
      load: async () => ({ provider: "zai", apiKey: "stored" }),
      save: async () => {},
      fetchImpl: (async () => {
        fetched += 1;
        return jsonResponse({}, 500);
      }) as unknown as typeof fetch,
    });
    await expect(attempt).rejects.toThrow(/--replace/);
    expect(fetched).toBe(0);
  });

  it("refuses to overwrite another provider's stored credential", async () => {
    await expect(
      importCredential({
        file: "credentials.json",
        defaultProvider: "zai",
        readFile: () => flatMap,
        load: async () => ({ provider: "zai", apiKey: "stored" }),
        save: async () => {},
        fetchImpl: bigmodelResolverFetch(),
      }),
    ).rejects.toThrow(/--replace/);
  });

  it("reports an unreadable file instead of crashing", async () => {
    try {
      await importCredential({
        file: "/nonexistent/credentials.json",
        defaultProvider: "zai",
        load: async () => null,
        save: async () => {},
      });
      throw new Error("expected failure");
    } catch (err) {
      expect(err).toBeInstanceOf(ImportError);
      expect((err as ImportError).code).toBe("file_unreadable");
      expect((err as Error).message).toMatch(/Cannot read/);
    }
  });
});

describe("summarizeImport", () => {
  it("states exactly which half of the credential is usable", () => {
    const lines = summarizeImport({
      source: "pasted JWT",
      provider: "zai",
      credential: { provider: "zai", apiKey: "", jwt: PLAN_JWT },
      codingPlanReady: false,
      startPlanReady: true,
      jwtUserId: "40651765947496863",
      warnings: ["something to know"],
    });
    const text = lines.join("\n");
    expect(text).toContain("Imported from pasted JWT");
    expect(text).toContain("API key:  (none");
    expect(text).toContain("user 40651765947496863");
    expect(text).toContain("Usable:   start-plan only");
    expect(text).toContain("⚠ something to know");
  });

  it("truncates secrets to a prefix", () => {
    const lines = summarizeImport({
      source: "credential file",
      provider: "bigmodel",
      credential: { provider: "bigmodel", apiKey: "abcdefghijklmnop.secret", jwt: PLAN_JWT },
      codingPlanReady: true,
      startPlanReady: true,
      warnings: [],
    });
    expect(lines.join("\n")).not.toContain("secret");
    expect(lines.join("\n")).toContain("abcdefghijkl...");
    expect(lines.join("\n")).toContain("Usable:   coding-plan + start-plan");
  });
});

describe("defaultCredentialsPath", () => {
  it("points at ZCode's store", () => {
    expect(defaultCredentialsPath().endsWith("/.zcode/v2/credentials.json")).toBe(true);
  });
});
