/**
 * Tests for the model catalog.
 */
import { describe, it, expect } from "bun:test";
import { MODELS } from "./models.js";

describe("models", () => {
  it("MODELS contains exactly the 11 pinned coding-plan models", () => {
    expect(MODELS).toHaveLength(11);
    const ids = MODELS.map((m) => m.id);
    // Current-gen defaults lead the advertised list; the rest newest→oldest.
    expect(ids).toEqual([
      "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5",
      "glm-5-turbo", "glm-5v-turbo", "glm-4.7", "glm-4.6", "glm-4.6v",
      "glm-4.5-air",
    ]);
  });

  it("all models have valid id and contextWindow", () => {
    for (const m of MODELS) {
      expect(typeof m.id).toBe("string");
      expect(m.id.length).toBeGreaterThan(0);
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  it("contextWindow + maxOutputTokens match the 3.11.2 catalog per model", () => {
    // Synced against _reverse/models_catalog.json (zai == bigmodel entries).
    const byId = Object.fromEntries(MODELS.map((m) => [m.id, m]));
    expect(byId["glm-4.5-air"]).toMatchObject({ contextWindow: 131_072, maxOutputTokens: 98_304 });
    expect(byId["glm-4.6"]).toMatchObject({ contextWindow: 200_000, maxOutputTokens: 131_072 });
    expect(byId["glm-4.6v"]).toMatchObject({ contextWindow: 131_072, maxOutputTokens: 32_768 });
    expect(byId["glm-4.7"]).toMatchObject({ contextWindow: 200_000, maxOutputTokens: 131_072 });
    expect(byId["glm-5"]).toMatchObject({ contextWindow: 200_000, maxOutputTokens: 64_000 });
    expect(byId["glm-5-turbo"]).toMatchObject({ contextWindow: 200_000, maxOutputTokens: 64_000 });
    expect(byId["glm-5v-turbo"]).toMatchObject({ contextWindow: 200_000, maxOutputTokens: 131_072 });
    expect(byId["glm-5.1"]).toMatchObject({ contextWindow: 200_000, maxOutputTokens: 64_000 });
    expect(byId["glm-5.3"]).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 128_000 });
  });

  it("glm-5.2, glm-5.3 and glm-5.3-flash have 1M context", () => {
    const glm52 = MODELS.find((m) => m.id === "glm-5.2");
    expect(glm52).toBeDefined();
    expect(glm52!.contextWindow).toBe(1_000_000);
    const glm53 = MODELS.find((m) => m.id === "glm-5.3");
    expect(glm53).toBeDefined();
    expect(glm53!.contextWindow).toBe(1_000_000);
    const glm53f = MODELS.find((m) => m.id === "glm-5.3-flash");
    expect(glm53f).toBeDefined();
    expect(glm53f!.contextWindow).toBe(1_000_000);
  });

  it("vision flag: flash + v-suffixed models, glm-5.3 text-only", () => {
    const v = (id: string) => MODELS.find((m) => m.id === id)?.vision;
    expect(v("glm-5.3-flash")).toBe(true);
    expect(v("glm-5v-turbo")).toBe(true);
    expect(v("glm-4.6v")).toBe(true);
    expect(v("glm-5.3")).toBeUndefined();
    expect(v("glm-5.2")).toBeUndefined();
  });
});
