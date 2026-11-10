import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __resetCaptchaWorkerDispatchForTest,
  __setBundleDirForTest,
  __setInProcessSolverForTest,
  resolveWorkerEntryCandidates,
  solveViaWorkerOrInProcess,
  stopCaptchaWorkers,
} from "./captcha-worker-dispatch.js";

// The dispatch layer must degrade, not fail, when the worker path is
// unusable. Worker mode is exercised with a REAL worker_threads round trip
// against a canned fixture entry (no happy-dom, no network); the fallback
// cases substitute the in-process solver through the test seam. Neither
// captcha-solver.js nor captcha-happy.js is module-mocked here: those mocks
// are process-wide in Bun and leak partial export surfaces into later test
// files (order-dependent across platforms).
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-worker-"));
const fixturePath = path.join(fixtureDir, "fixture-worker.mjs");
fs.writeFileSync(
  fixturePath,
  [
    'import { parentPort } from "node:worker_threads";',
    "if (!parentPort) throw new Error('fixture requires parent port');",
    "parentPort.on('message', (m) => {",
    "  parentPort.postMessage({ id: m.id, ok: true, param: `fixture-param:${m.scene}:${m.region}` });",
    "});",
  ].join("\n"),
  "utf8",
);

describe("captcha worker dispatch (worker / in-process)", () => {
  // NOTE: fixtureDir outlives this describe — later describes reuse
  // fixturePath for the env-resolution test; cleanup is file-level below.
  //
  // bundleDir is pinned to null so these cases see a compiled-binary layout
  // (env + file asset only): a source checkout has a real
  // captcha-worker-entry.ts beside the dispatch module, and picking it up
  // here would spawn the live happy-dom solver instead of the fixture.
  beforeEach(() => __setBundleDirForTest(null));
  afterAll(() => {
    __setInProcessSolverForTest(null);
    __setBundleDirForTest(undefined);
  });

  test("solves via a real worker when the entry asset resolves", async () => {
    mock.module("./captcha-worker-asset.js", () => ({ default: fixturePath }));
    __resetCaptchaWorkerDispatchForTest();
    const param = await solveViaWorkerOrInProcess({ scene: "sc1", region: "rg1", prefix: "pf1" });
    expect(param).toBe("fixture-param:sc1:rg1");
  });

  test("falls back to in-process solving when the entry is unavailable", async () => {
    mock.module("./captcha-worker-asset.js", () => ({ default: null }));
    __setInProcessSolverForTest(
      async (opts) => `inproc-param:${opts.scene}`,
    );
    __resetCaptchaWorkerDispatchForTest();
    const param = await solveViaWorkerOrInProcess({ scene: "sc2", region: "rg2", prefix: "pf2" });
    expect(param).toBe("inproc-param:sc2");
  });

  test("an unloadable worker entry degrades to in-process solving", async () => {
    // A path that cannot be loaded as a worker module (a directory) surfaces
    // as an async module-not-found 'error' — it must fall back, not reject.
    mock.module("./captcha-worker-asset.js", () => ({ default: fixtureDir }));
    __setInProcessSolverForTest(
      async (opts) => `inproc-param:${opts.scene}`,
    );
    __resetCaptchaWorkerDispatchForTest();
    const param = await solveViaWorkerOrInProcess({ scene: "sc3", region: "rg3", prefix: "pf3" });
    expect(param).toBe("inproc-param:sc3");
  });
});

describe("resolveWorkerEntryCandidates (pure)", () => {
  test("env path first, then the source sibling; whitespace-only env is ignored", () => {
    expect(
      resolveWorkerEntryCandidates({ envPath: "/data/files/worker.mjs", bundleDir: "/data/files/bundle" }),
    ).toEqual([
      "/data/files/worker.mjs",
      path.join("/data/files/bundle", "captcha-worker-entry.ts"),
    ]);
    expect(resolveWorkerEntryCandidates({ bundleDir: "/b" })).toEqual([
      path.join("/b", "captcha-worker-entry.ts"),
    ]);
    expect(resolveWorkerEntryCandidates({ envPath: "   " })).toEqual([]);
    expect(resolveWorkerEntryCandidates({ bundleDir: null })).toEqual([]);
    expect(resolveWorkerEntryCandidates({})).toEqual([]);
  });

  test("an env path shifts the sibling down instead of replacing it", () => {
    expect(resolveWorkerEntryCandidates({ bundleDir: "/x", envPath: "/env/w.mjs" })).toEqual([
      "/env/w.mjs",
      path.join("/x", "captcha-worker-entry.ts"),
    ]);
  });
});

describe("sibling entry probe (source layout)", () => {
  // A source checkout ships captcha-worker-entry.ts beside the dispatch
  // module; the probe must pick it up and run it as TypeScript.
  const tsOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-ts-"));
  const tsFixture = [
    'import { parentPort } from "node:worker_threads";',
    "// A type annotation here: loading this file at all proves Bun parsed it",
    "// as TypeScript, which is what makes the source-run entry viable.",
    'const tag: string = "fixture-ts";',
    "if (!parentPort) throw new Error('ts fixture requires parent port');",
    "parentPort.on('message', (m: { id: number; scene: string }) => {",
    "  parentPort.postMessage({ id: m.id, ok: true, param: `${tag}:${m.scene}` });",
    "});",
  ].join("\n");
  fs.writeFileSync(path.join(tsOnlyDir, "captcha-worker-entry.ts"), tsFixture, "utf8");

  afterEach(() => {
    delete process.env.ZCODE_CAPTCHA_WORKER;
    __setBundleDirForTest(undefined);
  });
  afterAll(() => {
    try { fs.rmSync(tsOnlyDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结果 */ }
  });

  test("the source .ts entry is used when the build asset is absent", async () => {
    mock.module("./captcha-worker-asset.js", () => ({ default: null }));
    __setBundleDirForTest(tsOnlyDir);
    __resetCaptchaWorkerDispatchForTest();
    const param = await solveViaWorkerOrInProcess({ scene: "src", region: "rg", prefix: "pf" });
    expect(param).toBe("fixture-ts:src");
  });
});

describe("entry resolution", () => {
  const saved = {
    worker: process.env.ZCODE_CAPTCHA_WORKER,
  };
  // Compiled-binary layout again: no sibling entries to pick up by accident.
  beforeEach(() => __setBundleDirForTest(null));
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v as string;
    }
    __setInProcessSolverForTest(null);
    __setBundleDirForTest(undefined);
    __resetCaptchaWorkerDispatchForTest();
  });

  test("ZCODE_CAPTCHA_WORKER wins over the bundled asset", async () => {
    process.env.ZCODE_CAPTCHA_WORKER = fixturePath;
    mock.module("./captcha-worker-asset.js", () => ({ default: null }));
    __resetCaptchaWorkerDispatchForTest();
    const param = await solveViaWorkerOrInProcess({ scene: "env", region: "rg", prefix: "pf" });
    expect(param).toBe("fixture-param:env:rg");
  });
});

describe("warm worker pool", () => {
  const saved = {
    warm: process.env.ZCODE_CAPTCHA_WARM_WORKERS,
    worker: process.env.ZCODE_CAPTCHA_WORKER,
  };
  const warmDir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-warm-"));
  const markerPath = path.join(warmDir, "spawns.txt");
  const warmFixture = path.join(warmDir, "warm-worker.mjs");
  fs.writeFileSync(
    warmFixture,
    [
      'import { parentPort } from "node:worker_threads";',
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(markerPath)}, "spawn\\n");`,
      "if (!parentPort) throw new Error('warm fixture requires parent port');",
      "parentPort.on('message', (m) => {",
      "  parentPort.postMessage({ id: m.id, ok: true, param: `warm:${m.scene}` });",
      "});",
    ].join("\n"),
    "utf8",
  );
  const spawnCount = (): number =>
    fs.existsSync(markerPath)
      ? fs.readFileSync(markerPath, "utf8").split("\n").filter((l) => l === "spawn").length
      : 0;

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v as string;
    }
    __setBundleDirForTest(undefined);
    stopCaptchaWorkers();
  });
  afterAll(() => {
    try { fs.rmSync(warmDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结果 */ }
  });

  test("reuses one persistent worker across solves; stopCaptchaWorkers forces a respawn", async () => {
    __setBundleDirForTest(null);
    process.env.ZCODE_CAPTCHA_WORKER = warmFixture;
    process.env.ZCODE_CAPTCHA_WARM_WORKERS = "1";
    mock.module("./captcha-worker-asset.js", () => ({ default: null }));
    __resetCaptchaWorkerDispatchForTest();

    const a = await solveViaWorkerOrInProcess({ scene: "w1", region: "r", prefix: "p" });
    const b = await solveViaWorkerOrInProcess({ scene: "w2", region: "r", prefix: "p" });
    expect(a).toBe("warm:w1");
    expect(b).toBe("warm:w2");
    // Both solves were served by the SAME persistent worker.
    expect(spawnCount()).toBe(1);

    stopCaptchaWorkers();
    const c = await solveViaWorkerOrInProcess({ scene: "w3", region: "r", prefix: "p" });
    expect(c).toBe("warm:w3");
    // The pool was emptied -> the next solve had to spawn a fresh worker.
    expect(spawnCount()).toBe(2);
  });
});

// File-level cleanup: runs after every describe above, so shared fixtures
// stay alive for the whole file.
afterAll(() => {
  __setInProcessSolverForTest(null);
  stopCaptchaWorkers();
  try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结果 */ }
});
