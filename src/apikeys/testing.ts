/**
 * 测试用的内存 key 仓。
 *
 * 与 `accounts/testing.ts` 同一个角色：管理逻辑（校验、吊销、用量累加）与文件格式是
 * 两件事，混在一起测会把每个用例都变成 IO 用例。生产实现是 `store.ts` 的
 * `fileApiKeysStore`，与本文件只共享 `ApiKeysStore` 接口（异步，与真实仓一致）。
 */
import { emptyApiKeysFile } from "./types.js";
import type { ApiKeysFile } from "./types.js";
import type { ApiKeysStore } from "./store.js";

/** 一份内存里的 key 文件（`snapshot()` 让用例直接看落盘内容）。*/
export function memoryApiKeysStore(): ApiKeysStore & { snapshot(): ApiKeysFile } {
  let file = emptyApiKeysFile();
  return {
    load: async () => file,
    save: async (next) => {
      file = next;
    },
    snapshot: () => file,
  };
}
