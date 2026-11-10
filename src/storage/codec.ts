/**
 * AES-256-GCM 编解码器：加密 + base64 包装。
 *
 * 为什么单独一份：账号 / 用户 / API key 三个仓共享同一套加密，密文格式
 * （`base64(iv ‖ ciphertext ‖ tag)`）必须三处一致——任何一处改了另两处不跟，
 * 用户的数据就互相解不开。历史上的多实现（同步 `node:crypto` + 异步
 * `crypto.subtle`）已统一到 `crypto.subtle` 一份。
 *
 * 选异步 `crypto.subtle`：它是 Web 标准，Bun 与 Node 都有，三个仓里已经有
 * 两个用它。同步实现唯一的收益是能在 `process.on("exit")` 里落盘，而那个场景的
 * 真实需求由 `apikeys/manager.ts` 的 `beforeExit` 与 `bootstrap.ts` 的关闭路径
 * 覆盖了（见那两处注释）。
 *
 * 不做密钥缓存：每次 `encode` / `decode` 的代价是一次 SHA-256，可以忽略；缓存会
 * 引入「seed 变了但缓存没更新」的坑，而 seed 是读环境变量的（测试与容器都会改）。
 *
 * 密钥 = SHA-256(seed)，seed 优先取 `ZCODE_PROXY_CREDENTIAL_SECRET`，否则取
 * `{homedir}-{platform}-{arch}`。seed 按调用取值，理由同
 * `ZCODE_PROXY_STORE_DIR`：模块加载之后再设环境变量也要生效。
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";

/** 加密 / 解密一对。每次调用自己派生密钥，实例不持有秘密。*/
export interface Codec {
  encode(plaintext: string): Promise<string>;
  decode(payload: string): Promise<string>;
}

/**
 * 存储用的环境变量。两处都读它：这里是凭据加密的 seed，`store.ts` 那边是目录覆盖。
 *
 * 同一个变量管两件事是有意的：用户只记一个名字，搬到别的机器上时要么两样都带、
 * 要么两样都不带，不会出现「凭据带走了但解不开」这种半套状态。
 */
const ENV_SECRET = "ZCODE_PROXY_CREDENTIAL_SECRET";

/** AES-GCM 的 IV 长度（字节）。12 是 GCM 的标准长度，也是 WebCrypto 的推荐值。*/
const IV_BYTES = 12;

/**
 * GCM 认证标签的长度（字节）。
 *
 * 16 = 128 位，WebCrypto 的默认值（`tagLength` 缺省 128）。解密前显式检查密文长度
 * 不少于 iv + tag：截短的载荷不该走到 `subtle.decrypt` 里再报一个含糊的错误。
 */
const TAG_BYTES = 16;

/**
 * 机器派生的编解码器。
 *
 * 安全边界：默认种子下，同一用户的进程本就能重新派生（`0o600` 只挡别的用户）。
 * 真正的收益在显式设置 `ZCODE_PROXY_CREDENTIAL_SECRET` 的部署：那把密钥有完整的
 * 32 字节扩散，换机器拷贝文件也解不开。
 */
export function machineCodec(): Codec {
  return {
    encode: (plaintext) => encryptGcm(machineSeed(), plaintext),
    decode: (payload) => decryptGcm(machineSeed(), payload),
  };
}

/** 测试注入：指定 seed。生产代码用 {@link machineCodec}。*/
export function codecFromSeed(seed: string): Codec {
  return {
    encode: (plaintext) => encryptGcm(seed, plaintext),
    decode: (payload) => decryptGcm(seed, payload),
  };
}

/** 当前的机器种子（每次调用重新取值，见文件头）。*/
function machineSeed(): string {
  return process.env[ENV_SECRET] ?? `${homedir()}-${process.platform}-${process.arch}`;
}

/** AES-GCM 密钥 = SHA-256(seed)。*/
async function deriveKey(seed: string): Promise<CryptoKey> {
  const digest = createHash("sha256").update(seed, "utf-8").digest();
  // 拷进普通 ArrayBuffer：bun-types 把 Uint8Array 标成 ArrayBufferLike，
  // 不能直接当 BufferSource 传。
  const ab = new ArrayBuffer(digest.byteLength);
  new Uint8Array(ab).set(digest);
  return crypto.subtle.importKey("raw", ab, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** AES-GCM 加密，输出 `base64(iv ‖ ciphertext ‖ tag)`。*/
async function encryptGcm(seed: string, plaintext: string): Promise<string> {
  const key = await deriveKey(seed);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return Buffer.from(combined).toString("base64");
}

/**
 * 解密 {@link encryptGcm} 的输出。
 *
 * 密钥不对、密文被改、载荷太短都会抛异常：调用方（`store.ts`）把它降级成
 * 「空仓 + 一条告警」，而不是让代理起不来。
 */
async function decryptGcm(seed: string, payload: string): Promise<string> {
  const combined = Buffer.from(payload, "base64");
  if (combined.length < IV_BYTES + TAG_BYTES) throw new Error("ciphertext is too short");
  const key = await deriveKey(seed);
  const iv = combined.subarray(0, IV_BYTES);
  const data = combined.subarray(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(plaintext);
}
