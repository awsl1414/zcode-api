import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPersistedOverride,
  mergePolicyOverrides,
  persistAccountOverride,
  readPolicyOverrides,
  writePolicyOverrides,
} from "./policy-store.js";

/** 每个用例一个临时 store 目录：绝不碰真实 `~/.zcode-proxy`。*/
let dir: string;
/**
 * sidecar 的路径。
 *
 * 文件名是**契约的一部分**（「删掉坏文件就回到 config.yaml 基线」这条恢复路径对
 * 用户说的是 `~/.zcode-proxy/policy.json`），所以这里写死而不是从模块借一个 getter。
 */
const policyPath = (): string => join(dir, "policy.json");
const prev = process.env.ZCODE_PROXY_STORE_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zcode-policy-"));
  process.env.ZCODE_PROXY_STORE_DIR = dir;
});

afterEach(() => {
  if (prev === undefined) delete process.env.ZCODE_PROXY_STORE_DIR;
  else process.env.ZCODE_PROXY_STORE_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("policy-store：运行时策略覆盖", () => {
  it("没有文件时返回空覆盖，不抛", async () => {
    expect(await readPolicyOverrides()).toEqual({});
  });

  it("写入后读回同一份", async () => {
    await writePolicyOverrides({ routing: { strategy: "balanced" } });
    expect((await readPolicyOverrides()).routing).toEqual({ strategy: "balanced" });
  });

  it("合并而不是覆盖：两次补丁都留住", async () => {
    await mergePolicyOverrides({ routing: { strategy: "balanced" } });
    await mergePolicyOverrides({ routing: { maxQueue: 99 } });
    expect((await readPolicyOverrides()).routing).toEqual({ strategy: "balanced", maxQueue: 99 });
  });

  it("routing / stickiness / risk 三段互不干扰", async () => {
    await mergePolicyOverrides({ routing: { mode: "only" } });
    await mergePolicyOverrides({ stickiness: { ttlSeconds: 600 } });
    await mergePolicyOverrides({ risk: { jitterHeartbeat: false } });
    const policy = await readPolicyOverrides();
    expect(policy.routing).toEqual({ mode: "only" });
    expect(policy.stickiness).toEqual({ ttlSeconds: 600 });
    expect(policy.risk).toEqual({ jitterHeartbeat: false });
  });

  it("损坏的 JSON 退回空覆盖（策略不是启动硬依赖）", async () => {
    writeFileSync(policyPath(), "{ not json", "utf-8");
    expect(await readPolicyOverrides()).toEqual({});
  });

  it("文件里的杂项字段被丢掉，只认已知段", async () => {
    writeFileSync(
      policyPath(),
      JSON.stringify({ routing: { mode: "only" }, bogus: 1, risk: { other: true } }),
      "utf-8",
    );
    const policy = await readPolicyOverrides();
    expect(policy.routing).toEqual({ mode: "only" });
    expect(policy.risk).toBeUndefined();
    expect((policy as Record<string, unknown>).bogus).toBeUndefined();
  });
});

/**
 * 文件格式契约。
 *
 * `policy.json` 走 `jsonStore({ plaintext: true })`，写出的字节必须与旧实现一致：一份裸的
 * `{routing, stickiness, risk, entries}`，两空格缩进、末尾换行，**不包**
 * `{version, payload}`。这两个方向都要钉住：旧文件读得开，写过之后格式不变。
 */
describe("policy-store：文件格式与旧文件兼容", () => {
  /** 旧实现写出的 sidecar（手写的样子：缩进随便，字段顺序随便）。*/
  const LEGACY_POLICY = `{
  "routing": { "strategy": "balanced", "order": ["coding-plan"] },
  "stickiness": { "ttlSeconds": 600 },
  "risk": { "jitterHeartbeat": false },
  "entries": { "work": { "maxConcurrency": 4, "weight": 2 } }
}
`;

  it("读得开旧的明文 sidecar（无包装）", async () => {
    writeFileSync(policyPath(), LEGACY_POLICY, "utf-8");
    const policy = await readPolicyOverrides();
    expect(policy.routing).toEqual({ strategy: "balanced", order: ["coding-plan"] });
    expect(policy.stickiness).toEqual({ ttlSeconds: 600 });
    expect(policy.risk).toEqual({ jitterHeartbeat: false });
    expect(policy.entries).toEqual({ work: { maxConcurrency: 4, weight: 2 } });
  });

  it("写一次之后格式不变：裸对象、两空格缩进、末尾换行、没有 version/encrypted", async () => {
    writeFileSync(policyPath(), LEGACY_POLICY, "utf-8");
    await mergePolicyOverrides({ routing: { maxQueue: 99 } });

    const raw = readFileSync(policyPath(), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // 顶层就是那四段，没有被包一层。
    expect(parsed.version).toBeUndefined();
    expect(parsed.encrypted).toBeUndefined();
    expect(parsed.payload).toBeUndefined();
    expect(Object.keys(parsed).sort()).toEqual(["entries", "risk", "routing", "stickiness"]);
    // 与旧实现的写出字节完全一致：`JSON.stringify(policy, null, 2) + "\n"`。
    expect(raw).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  });

  it("写两次字节稳定（不累积格式漂移）", async () => {
    await mergePolicyOverrides({ routing: { strategy: "balanced" } });
    const first = readFileSync(policyPath(), "utf-8");
    await mergePolicyOverrides({ routing: { strategy: "balanced" } });
    expect(readFileSync(policyPath(), "utf-8")).toBe(first);
  });
});

describe("policy-store：账号级覆盖（跨重启持久化）", () => {
  it("persistAccountOverride 逐字段合并，不抹掉同账号的其他字段", async () => {
    await persistAccountOverride("work", { maxConcurrency: 4 });
    await persistAccountOverride("work", { weight: 3 });
    expect((await readPolicyOverrides()).entries).toEqual({ work: { maxConcurrency: 4, weight: 3 } });
  });

  it("账号级覆盖按 label 分条，改一个不动另一个", async () => {
    await persistAccountOverride("work", { maxConcurrency: 4 });
    await persistAccountOverride("home", { enabled: false });
    expect((await readPolicyOverrides()).entries).toEqual({
      work: { maxConcurrency: 4 },
      home: { enabled: false },
    });
  });

  it("全局策略与账号级覆盖互不清除（同一个文件的两段）", async () => {
    await mergePolicyOverrides({ routing: { strategy: "balanced" } });
    await persistAccountOverride("work", { maxConcurrency: 4 });
    await mergePolicyOverrides({ stickiness: { ttlSeconds: 600 } });
    const policy = await readPolicyOverrides();
    expect(policy.routing).toEqual({ strategy: "balanced" });
    expect(policy.stickiness).toEqual({ ttlSeconds: 600 });
    expect(policy.entries).toEqual({ work: { maxConcurrency: 4 } });
  });

  it("clearPersistedOverride 只删这一个 label，删空后 entries 整段消失", async () => {
    await persistAccountOverride("work", { maxConcurrency: 4 });
    await persistAccountOverride("home", { weight: 3 });
    await clearPersistedOverride("work");
    expect((await readPolicyOverrides()).entries).toEqual({ home: { weight: 3 } });

    await clearPersistedOverride("home");
    expect((await readPolicyOverrides()).entries).toBeUndefined();
  });

  it("清一个不存在的 label 不写文件", async () => {
    await writePolicyOverrides({ routing: { mode: "only" } });
    const before = readFileSync(policyPath(), "utf-8");
    await clearPersistedOverride("ghost");
    expect(readFileSync(policyPath(), "utf-8")).toBe(before);
  });

  it("proxy 引用能落盘并原样读回", async () => {
    await persistAccountOverride("work-team", { proxy: "office" });
    const read = await readPolicyOverrides();
    expect(read.entries?.["work-team"]).toEqual({ proxy: "office" });
  });

  it("空的 proxy 值被丢掉", async () => {
    await persistAccountOverride("work-team", { proxy: "  " });
    expect((await readPolicyOverrides()).entries?.["work-team"]).toBeUndefined();
  });

  it("文件里 entries 的坏字段与坏条目被丢掉，不让启动失败", async () => {
    writeFileSync(
      policyPath(),
      JSON.stringify({
        entries: {
          good: { maxConcurrency: 4, weight: 2 },
          bad: { maxConcurrency: -1, weight: 0.5, enabled: "yes" },
          junk: "nope",
          "": { maxConcurrency: 1 },
        },
      }),
      "utf-8",
    );
    expect((await readPolicyOverrides()).entries).toEqual({ good: { maxConcurrency: 4, weight: 2 } });
  });
});
