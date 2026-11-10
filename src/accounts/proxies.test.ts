/**
 * 出口代理表的校验与优先级链。
 *
 * 四类配置错误必须报错而不是回落：静默直连等于把这个账号的真实地址泄给上游，
 * 是本功能最危险的失败模式。用例逐条钉住这四个失败模式，再加上 `direct` 与「不写」
 * 的区别——没有那个区别，用户想「只让一个账号直连」就无法表达。
 *
 * @see 校验 · 配置面
 */
import { describe, expect, test } from "bun:test";
import {
  DIRECT_PROXY,
  effectiveProxyName,
  egressFor,
  findProxy,
  isDirectProxy,
  resolveEgress,
  resolveEgressFor,
  validateProxies,
  type ProxySpec,
} from "./proxies.js";

const HOME: ProxySpec = { name: "home", url: "http://127.0.0.1:7890" };
const OFFICE: ProxySpec = { name: "office", url: "socks5://10.0.0.5:1080", username: "user", password: "pass" };
const BACKUP: ProxySpec = { name: "backup", url: "http://127.0.0.1:7891", enabled: false };

describe("validateProxies", () => {
  test("accepts a well-formed table and every protocol in the whitelist", () => {
    const proxies: ProxySpec[] = [
      { name: "a", url: "http://127.0.0.1:1" },
      { name: "b", url: "https://proxy.example:8443" },
      { name: "c", url: "socks5://127.0.0.1:1080" },
      { name: "d", url: "socks5h://127.0.0.1:1080" },
    ];
    expect(() => validateProxies(proxies, [{ where: "entries[x].proxy", name: "a" }])).not.toThrow();
  });

  test("rejects a duplicate name", () => {
    expect(() => validateProxies([HOME, { ...HOME, url: "http://127.0.0.1:9999" }], [])).toThrow(
      /duplicate proxy name "home"/,
    );
  });

  test("rejects an empty name", () => {
    expect(() => validateProxies([{ name: "  ", url: "http://127.0.0.1:1" }], [])).toThrow(/non-empty name/);
  });

  test("rejects a url whose protocol is not in the whitelist", () => {
    expect(() => validateProxies([{ name: "weird", url: "socks4://127.0.0.1:1080" }], [])).toThrow(
      /unsupported url/,
    );
    expect(() => validateProxies([{ name: "typo", url: "127.0.0.1:1080" }], [])).toThrow(/unsupported url/);
  });

  test("rejects a reference to a proxy that does not exist", () => {
    expect(() =>
      validateProxies([HOME], [{ where: "accounts.entries[work].proxy", name: "office" }]),
    ).toThrow(/references unknown proxy "office"/);
  });

  test("rejects a reference to a disabled proxy instead of falling back to direct", () => {
    // 这是最关键的一条：降级成直连会静默泄露真实 IP。
    expect(() =>
      validateProxies([HOME, BACKUP], [{ where: "accounts.entries[spare].proxy", name: "backup" }]),
    ).toThrow(/references disabled proxy "backup"/);
  });

  test("rejects a disabled default proxy as well", () => {
    expect(() => validateProxies([BACKUP], [{ where: "accounts.risk.defaultProxy", name: "backup" }])).toThrow(
      /references disabled proxy "backup"/,
    );
  });

  test("ignores 'direct' and undefined references (they never name a row)", () => {
    expect(() =>
      validateProxies([HOME], [
        { where: "accounts.entries[a].proxy", name: DIRECT_PROXY },
        { where: "accounts.entries[b].proxy", name: undefined },
      ]),
    ).not.toThrow();
  });
});

describe("effectiveProxyName / resolveEgress priority chain", () => {
  test("entry beats the default", () => {
    expect(effectiveProxyName("office", "home")).toBe("office");
  });

  test("unset entry inherits the default", () => {
    expect(effectiveProxyName(undefined, "home")).toBe("home");
  });

  test("'direct' explicitly overrides the default", () => {
    // 「不写」继承默认，「direct」明确覆盖：没有这个区别，只让一个账号直连无法表达。
    expect(effectiveProxyName(DIRECT_PROXY, "home")).toBe(DIRECT_PROXY);
    expect(resolveEgress([HOME, OFFICE], DIRECT_PROXY, "home")).toBeUndefined();
    expect(resolveEgress([HOME, OFFICE], undefined, DIRECT_PROXY)).toBeUndefined();
  });

  test("nothing configured means direct", () => {
    expect(effectiveProxyName(undefined, undefined)).toBeUndefined();
    expect(resolveEgress([HOME], undefined, undefined)).toBeUndefined();
  });

  test("resolves a name to url plus credentials", () => {
    expect(resolveEgress([HOME, OFFICE], "office", undefined)).toEqual({
      proxyUrl: "socks5://10.0.0.5:1080",
      username: "user",
      password: "pass",
    });
    // 没有认证字段时不要凭空造空串：那会变成「带空用户名」的代理认证请求。
    expect(resolveEgress([HOME], "home", undefined)).toEqual({ proxyUrl: "http://127.0.0.1:7890" });
  });

  test("still refuses a disabled proxy at resolution time", () => {
    // 校验在加载期跑过一次，这里防的是绕过校验的写入（控制面 / 手改内存）。
    expect(() => egressFor([BACKUP], "backup")).toThrow(/disabled/);
  });
});

describe("resolveEgressFor", () => {
  test("reads the entry, then the default, from config-shaped data", () => {
    const accounts = {
      proxies: [HOME, OFFICE],
      entries: [{ label: "work", proxy: "office" }, { label: "home-only", proxy: DIRECT_PROXY }],
      risk: { defaultProxy: "home" },
    };
    expect(resolveEgressFor(accounts, "work")).toEqual({
      proxyUrl: "socks5://10.0.0.5:1080",
      username: "user",
      password: "pass",
    });
    expect(resolveEgressFor(accounts, "home-only")).toBeUndefined();
    // 不在 entries 里的账号继承默认代理。
    expect(resolveEgressFor(accounts, "unlisted")).toEqual({ proxyUrl: "http://127.0.0.1:7890" });
  });

  test("no accounts config at all means direct", () => {
    expect(resolveEgressFor(undefined, "anything")).toBeUndefined();
  });
});

describe("helpers", () => {
  test("findProxy / isDirectProxy", () => {
    expect(findProxy([HOME, OFFICE], "office")).toBe(OFFICE);
    expect(findProxy([HOME], "nope")).toBeUndefined();
    expect(isDirectProxy(DIRECT_PROXY)).toBe(true);
    expect(isDirectProxy("home")).toBe(false);
  });
});
