/**
 * 存储抽象的唯一入口。
 *
 * 调用方（四个仓的薄壳）只从这里拿两样东西：编解码器与 JSON 仓。将来接 SQLite
 * 时新增 `src/storage/sqlite-store.ts` 导出同一个 `JsonStore<T>`，把仓的构造行换掉
 * 即可，接口与调用方都不动。
 *
 * 设计依据：本文件的实现约束与对应测试。
 */
export type { Codec } from "./codec.js";
export { codecFromSeed, machineCodec } from "./codec.js";
export type { JsonStore, JsonStoreOptions } from "./store.js";
export { getStoreDir, jsonStore } from "./store.js";
