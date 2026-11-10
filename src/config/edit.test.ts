import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureConfigFile } from "./edit.js";

describe("ensureConfigFile", () => {
  test("creates the file from the bundled template once, then is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-ensure-config-"));
    const path = join(dir, "config.yaml");
    try {
      expect(ensureConfigFile(path)).toBe(true);
      const created = readFileSync(path, "utf-8");
      // 模板没有顶层 provider/plan：账号自带 provider、路由自带 plan。
      expect(created).toContain("providers:");
      expect(created).not.toContain("\nprovider:");
      // 面板走登录页，模板里没有口令字段：只剩开关与绑定。
      expect(created).toContain("panel:");
      expect(created).not.toContain("token:");
      // Second call: already exists → no rewrite (returns false, content kept)
      const before = readFileSync(path, "utf-8");
      expect(ensureConfigFile(path)).toBe(false);
      expect(readFileSync(path, "utf-8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
