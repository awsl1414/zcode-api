/**
 * AES-256-GCM 编解码器：往返、密钥来源、以及**与上一代实现的密文兼容**。
 *
 * 兼容性用例里的密文是硬编码的常量，由上一代实现生成（`accounts/store.ts` 的
 * WebCrypto 版本与 `apikeys/store.ts` 的 `createCipheriv` 版本），seed 固定为
 * `w17-fixture-seed`。它们钉住三件事：
 *
 * 1. 密钥派生是 `SHA-256(seed)`，不是别的折叠构造。
 * 2. 线格式是 `base64(iv ‖ ciphertext ‖ tag)`，iv 12 字节、tag 16 字节。
 * 3. 两个旧实现产出的字节用同一份新实现都读得开（所以 apikeys 换成异步不需要迁移）。
 *
 * 任何一条走样，用户升级之后账号 / key 会「凭空消失」，所以这几条不许跟着实现改。
 */
import { describe, expect, it } from "bun:test";
import { codecFromSeed, machineCodec } from "./codec.js";

/**
 * 上一代 `accounts/store.ts`（WebCrypto）产出的密文。
 * 明文：`{"version":2,"accounts":[{…label:"work"…}]}`，seed 见 {@link FIXTURE_SEED}。
 */
const WEB_CRYPTO_FIXTURE =
  "acw0bHqVQIAU+v7qgEmrmdpTEPPaB6uMz3Cy41QJYJjzMaP3Np3wmNCfdZcvY41K0LmhTZZdhYExPmumfWNG4MGFwvT9UhboCpvV442lYUz5tuh0o1sLCu5IgXyqsCmJLbsYxc9LAxIcyuWCBCPWSyYBePWS+0zI4/p7r9mGnw4+FcQnBcU7StZe9y5Bqw+U0dWIuXNtbLDaXGU9KX/GBcUTYmU2EnrW3lKAsgNsLo7Dq5mT4qxg42NBBiMBrcRxPFWv2BSe1yR18OcJ2bRNuxbWjMPED5BnzSLcnYTeqnRRQlTx6hgv8Qc7K5ifxniJkJroDtJPahf+yQGnuxVWKxALFyUcjxE/SjlVucmidsqXTu7pXzkjd+1gS6wJOoYG0uAiyYfEkAPFjbLLuP0UyvER+dqNqszftEbQhI7G0pXA+Z9PdmHBKq43fW07fLETLQDL/2pvsG2j4JyECupODAZBbXe9EmdOc2rcq46bP9Tj0Sz7lQCVcIawED5xGV2GVIae2T/7tPFdjIZTXxrIVUXPXVPXJfJOOwxIKXqiOBrZjGwbHu/NwAeB3i++B/Xf2zga/Q==";

/**
 * 上一代 `apikeys/store.ts`（`createCipheriv`）产出的密文。
 * 明文：`{"version":1,"keys":[{…name:"legacy-laptop"…}]}`，同一个 seed。
 */
const NODE_CRYPTO_FIXTURE =
  "2GpY8ZDzJPVipyr5/8E0W98Z0vbc5Y+JI+y9KSrpXpWqoiUy3YqIoAu7Pokfx5C6koZ6ix3TJtzxIDOr9b2G7aAJhJ6LnHvwwwQDU++Qjp64ARSyhVh/cID6ilzQP1LmD+PyV1P3o6Bs57CTWMcrSo2OgAgykfB5KjE5nTp5cy6Fq9e+LZWN7bZnHmY4SH76hpQ6rJ8s7L3xRHCTbCICqch/GNRGUs0Qsl7RLmYJVmJTWLIlhfGgMSaNPIRekBhwTYCf2RuvJ0iAnUO8h4pgp6WLJcJ9zd0ndxjGOuFAXUuGTcyDoYGlp7cTLDSIrgpVIHDHS2bGrBfPVVl19SX/AudDFFN9odczoZJ3UR/yArQwLPzVoepNknemw6T5jAQ+wSpf+vtDD5loN337ntgkbPLuiAJA7/tIM0ngK7qBcgCMifXsLoTISgoYavs8Ysy1SOVi50dSntSEvj1Ug76EKDIvMql+rMa7phoZlYi5BtqLOuke2ReGOFeGFA==";

/** 两个夹具共用的 seed。*/
const FIXTURE_SEED = "w17-fixture-seed";

describe("codec：往返", () => {
  it("decode 读回 encode 写出的明文", async () => {
    const codec = codecFromSeed("round-trip");
    const plaintext = JSON.stringify({ version: 2, accounts: [{ label: "工作" }] });
    const payload = await codec.encode(plaintext);

    expect(payload).not.toContain("工作");
    expect(await codec.decode(payload)).toBe(plaintext);
  });

  it("同一份明文两次加密得到不同密文（IV 随机）", async () => {
    const codec = codecFromSeed("iv-random");
    const first = await codec.encode("same");
    const second = await codec.encode("same");
    expect(first).not.toBe(second);
    expect(await codec.decode(first)).toBe("same");
    expect(await codec.decode(second)).toBe("same");
  });

  it("空字符串也能往返（空仓写出来就是 `\"\"` 之外的东西）", async () => {
    const codec = codecFromSeed("empty");
    expect(await codec.decode(await codec.encode(""))).toBe("");
  });
});

describe("codec：密钥", () => {
  it("别的 seed 解不开", async () => {
    const payload = await codecFromSeed("machine-a").encode("secret");
    await expect(codecFromSeed("machine-b").decode(payload)).rejects.toThrow();
  });

  it("密文被改一个字节就解不开（GCM 认证）", async () => {
    const codec = codecFromSeed("tamper");
    const payload = await codec.encode("secret");
    const bytes = Buffer.from(payload, "base64");
    bytes[bytes.length - 1] ^= 0xff;
    await expect(codec.decode(bytes.toString("base64"))).rejects.toThrow();
  });

  it("载荷太短直接判失败，不交给 WebCrypto", async () => {
    // iv(12) + tag(16) 都放不下的 base64。
    await expect(codecFromSeed("short").decode(Buffer.from("tiny").toString("base64"))).rejects.toThrow(
      "ciphertext is too short",
    );
  });

  it("machineCodec 每次调用现读 ZCODE_PROXY_CREDENTIAL_SECRET", async () => {
    // 码器在模块加载时就造好了，测试却会改环境变量：seed 必须在调用时取，
    // 否则「换 secret 后旧文件解不开」这条会变成「换 secret 后仍然解得开」。
    const codec = machineCodec();
    const previous = process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
    try {
      process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "per-call-a";
      const payload = await codec.encode("secret");
      process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "per-call-b";
      await expect(codec.decode(payload)).rejects.toThrow();
      process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "per-call-a";
      expect(await codec.decode(payload)).toBe("secret");
    } finally {
      if (previous === undefined) delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
      else process.env.ZCODE_PROXY_CREDENTIAL_SECRET = previous;
    }
  });
});

describe("codec：与上一代实现写出的密文兼容", () => {
  it("读得开 WebCrypto 版本（accounts.json / users.json）写的密文", async () => {
    const plain = await codecFromSeed(FIXTURE_SEED).decode(WEB_CRYPTO_FIXTURE);
    expect(JSON.parse(plain)).toMatchObject({
      version: 2,
      accounts: [{ label: "work", enabled: true }],
    });
  });

  it("读得开 createCipheriv 版本（旧的 apikeys.json）写的密文", async () => {
    const plain = await codecFromSeed(FIXTURE_SEED).decode(NODE_CRYPTO_FIXTURE);
    const file = JSON.parse(plain) as { version: number; keys: { name: string; usage: { requests: number } }[] };
    expect(file.version).toBe(1);
    expect(file.keys[0]!.name).toBe("legacy-laptop");
    expect(file.keys[0]!.usage.requests).toBe(7);
  });

  it("两个旧实现的字节布局一致：同一份明文两种密文都能读", async () => {
    // 上面的两条已经各自钉住一种；这条只说「不依赖是谁生成的」，因为线格式只有一种。
    const codec = codecFromSeed(FIXTURE_SEED);
    for (const fixture of [WEB_CRYPTO_FIXTURE, NODE_CRYPTO_FIXTURE]) {
      expect(Buffer.from(fixture, "base64").length).toBeGreaterThan(12 + 16);
      expect(typeof (await codec.decode(fixture))).toBe("string");
    }
  });
});
