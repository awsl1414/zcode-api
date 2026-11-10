/**
 * 加密 JSON 仓：往返、原子写、五条降级、明文档位（policy.json）。
 *
 * 每个用例一个临时目录（`ZCODE_PROXY_STORE_DIR`），**绝不**碰真实 `~/.zcode-proxy`。
 * 这条规矩来自 2026-09-18 的事故：模块级路径常量让测试在已登录的机器上删掉了真凭据。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codecFromSeed } from "./codec.js";
import { jsonStore } from "./store.js";

const ENV_STORE_DIR = "ZCODE_PROXY_STORE_DIR";

let storeDir = "";
const previous = process.env[ENV_STORE_DIR];

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "zcode-storage-"));
  process.env[ENV_STORE_DIR] = storeDir;
});

afterEach(() => {
  if (previous === undefined) delete process.env[ENV_STORE_DIR];
  else process.env[ENV_STORE_DIR] = previous;
  rmSync(storeDir, { recursive: true, force: true });
});

/** 用例里的最小数据形状：一个版本号加一列条目。*/
interface Sample {
  version: number;
  items: string[];
}

const VERSION = 1;

/** 校验：版本对且 items 是字符串数组。任何一项不对就整份作废。*/
function reviveSample(plain: unknown): Sample | null {
  if (typeof plain !== "object" || plain === null) return null;
  const raw = plain as { version?: unknown; items?: unknown };
  if (raw.version !== VERSION) return null;
  if (!Array.isArray(raw.items)) return null;
  if (!raw.items.every((item) => typeof item === "string")) return null;
  return { version: VERSION, items: raw.items };
}

/** 加密仓（与 accounts / users / apikeys 同一个构造）。*/
function encryptedStore(fileName = "sample.json", seed = "storage-test-seed") {
  return jsonStore<Sample>({
    fileName,
    version: VERSION,
    codec: codecFromSeed(seed),
    fallback: () => ({ version: VERSION, items: [] }),
    revive: reviveSample,
  });
}

/** 明文档（与 policy-store 同一个构造）。*/
function plaintextStore(fileName = "policy.json") {
  return jsonStore<Sample>({
    fileName,
    plaintext: true,
    fallback: () => ({ version: VERSION, items: [] }),
    revive: reviveSample,
  });
}

const pathOf = (fileName: string): string => join(storeDir, fileName);

describe("加密仓：读写", () => {
  it("文件不存在时返回 fallback", async () => {
    expect(await encryptedStore().load()).toEqual({ version: VERSION, items: [] });
  });

  it("save → load 保真", async () => {
    const store = encryptedStore();
    await store.save({ version: VERSION, items: ["a", "b"] });
    expect(await store.load()).toEqual({ version: VERSION, items: ["a", "b"] });
  });

  it("外层是 {version, encrypted} 包装，内容不出现在文件里", async () => {
    await encryptedStore().save({ version: VERSION, items: ["SUPER-SECRET"] });
    const raw = readFileSync(pathOf("sample.json"), "utf-8");
    expect(raw).not.toContain("SUPER-SECRET");

    const wrapper = JSON.parse(raw) as { version: number; encrypted: string };
    expect(wrapper.version).toBe(VERSION);
    expect(typeof wrapper.encrypted).toBe("string");
  });

  it("文件权限 0o600，且不留临时文件", async () => {
    await encryptedStore().save({ version: VERSION, items: ["a"] });
    expect(statSync(pathOf("sample.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(storeDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("目录不存在时自动创建", async () => {
    const nested = join(storeDir, "deep", "nested");
    process.env[ENV_STORE_DIR] = nested;
    try {
      await encryptedStore().save({ version: VERSION, items: ["a"] });
      expect(existsSync(join(nested, "sample.json"))).toBe(true);
    } finally {
      process.env[ENV_STORE_DIR] = storeDir;
    }
  });

  it("clear 删掉文件，再 load 回到 fallback", async () => {
    const store = encryptedStore();
    await store.save({ version: VERSION, items: ["a"] });
    store.clear();
    expect(existsSync(pathOf("sample.json"))).toBe(false);
    expect(await store.load()).toEqual({ version: VERSION, items: [] });
  });

  it("clear 对不存在的文件是空操作", () => {
    expect(() => encryptedStore().clear()).not.toThrow();
  });

  it("describe 只回文件名（换 SQLite 时这条要能回 sqlite:xxx）", () => {
    expect(encryptedStore().describe()).toBe("sample.json");
    expect(plaintextStore("policy.json").describe()).toBe("policy.json");
  });
});

describe("加密仓：降级（一律 fallback，不抛，不删文件）", () => {
  it("文件不是 JSON", async () => {
    writeFileSync(pathOf("sample.json"), "{not json", "utf-8");
    expect(await encryptedStore().load()).toEqual({ version: VERSION, items: [] });
    expect(existsSync(pathOf("sample.json"))).toBe(true);
  });

  it("没有 encrypted 字段", async () => {
    writeFileSync(pathOf("sample.json"), JSON.stringify({ version: VERSION }), "utf-8");
    expect(await encryptedStore().load()).toEqual({ version: VERSION, items: [] });
  });

  it("密钥不对（跨机器拷贝 / 换了 secret）", async () => {
    await encryptedStore("sample.json", "machine-a").save({ version: VERSION, items: ["a"] });
    expect(await encryptedStore("sample.json", "machine-b").load()).toEqual({ version: VERSION, items: [] });
  });

  it("乱码密文与截短的密文", async () => {
    const store = encryptedStore();
    writeFileSync(pathOf("sample.json"), JSON.stringify({ version: VERSION, encrypted: "not-really" }), "utf-8");
    expect(await store.load()).toEqual({ version: VERSION, items: [] });

    writeFileSync(
      pathOf("sample.json"),
      JSON.stringify({ version: VERSION, encrypted: Buffer.from("tiny").toString("base64") }),
      "utf-8",
    );
    expect(await store.load()).toEqual({ version: VERSION, items: [] });
  });

  it("解密成功但结构不合法（版本不认识）→ fallback", async () => {
    const codec = codecFromSeed("storage-test-seed");
    const future = JSON.stringify({ version: 99, items: ["a"] });
    writeFileSync(
      pathOf("sample.json"),
      JSON.stringify({ version: VERSION, encrypted: await codec.encode(future) }),
      "utf-8",
    );
    expect(await encryptedStore().load()).toEqual({ version: VERSION, items: [] });
  });

  it("解密成功但明文不是 JSON → fallback", async () => {
    const codec = codecFromSeed("storage-test-seed");
    writeFileSync(
      pathOf("sample.json"),
      JSON.stringify({ version: VERSION, encrypted: await codec.encode("not json") }),
      "utf-8",
    );
    expect(await encryptedStore().load()).toEqual({ version: VERSION, items: [] });
  });

  it("fallback 每次返回新对象（调用方之间的可变状态不共享）", async () => {
    const store = encryptedStore();
    const first = await store.load();
    first.items.push("mutated");
    expect(await store.load()).toEqual({ version: VERSION, items: [] });
  });
});

describe("明文档位（policy.json 的形态）", () => {
  it("写出来是缩进 JSON + 换行，没有加密包装", async () => {
    const store = plaintextStore();
    await store.save({ version: VERSION, items: ["a"] });

    const raw = readFileSync(pathOf("policy.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual({ version: VERSION, items: ["a"] });
    // 给人读的形状：两空格缩进、末尾换行。手改这份文件是 support 场景的一部分。
    expect(raw).toBe(`${JSON.stringify({ version: VERSION, items: ["a"] }, null, 2)}\n`);
    expect(raw).not.toContain("encrypted");
  });

  it("读得开手写 / 旧的紧凑 JSON", async () => {
    writeFileSync(pathOf("policy.json"), '{"version":1,"items":["a","b"]}', "utf-8");
    expect(await plaintextStore().load()).toEqual({ version: VERSION, items: ["a", "b"] });
  });

  it("写两次格式不变（不会包一层 {version, payload}）", async () => {
    const store = plaintextStore();
    await store.save({ version: VERSION, items: ["a"] });
    const first = readFileSync(pathOf("policy.json"), "utf-8");
    await store.save(await store.load());
    expect(readFileSync(pathOf("policy.json"), "utf-8")).toBe(first);
  });

  it("坏的明文档照样退回 fallback", async () => {
    writeFileSync(pathOf("policy.json"), "{ not json", "utf-8");
    expect(await plaintextStore().load()).toEqual({ version: VERSION, items: [] });
  });
});

describe("构造参数", () => {
  it("加密仓缺 codec 或缺 version 时立刻报错（编程错误，不要留到运行时）", () => {
    expect(() =>
      jsonStore<Sample>({
        fileName: "x.json",
        version: VERSION,
        fallback: () => ({ version: VERSION, items: [] }),
        revive: reviveSample,
      }),
    ).toThrow(/codec is required/);

    expect(() =>
      jsonStore<Sample>({
        fileName: "x.json",
        codec: codecFromSeed("s"),
        fallback: () => ({ version: VERSION, items: [] }),
        revive: reviveSample,
      }),
    ).toThrow(/version is required/);
  });
});
