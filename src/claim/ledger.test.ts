/** Ledger: Beijing-day keys, restart recovery, concurrent writes and bad rows. */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beijingDayKey, createActivityLedger, ACTIVITY_LEDGER_FILE } from "./ledger.js";

let dir: string;
const OLD_STORE_DIR = process.env.ZCODE_PROXY_STORE_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zcode-ledger-"));
  process.env.ZCODE_PROXY_STORE_DIR = dir;
});

afterEach(() => {
  if (OLD_STORE_DIR === undefined) delete process.env.ZCODE_PROXY_STORE_DIR;
  else process.env.ZCODE_PROXY_STORE_DIR = OLD_STORE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("beijingDayKey", () => {
  it("rolls over at Beijing midnight, not UTC midnight", () => {
    // 2026-01-01 16:00 UTC = 2026-01-02 00:00 Beijing.
    expect(beijingDayKey(Date.UTC(2026, 0, 1, 15, 59, 59))).toBe("2026-01-01");
    expect(beijingDayKey(Date.UTC(2026, 0, 1, 16, 0, 0))).toBe("2026-01-02");
  });
});

describe("createActivityLedger", () => {
  const at = Date.UTC(2026, 10, 11, 4, 0, 0);

  it("upserts, marks claimed/exhausted and keeps accounts isolated", async () => {
    const ledger = createActivityLedger({ fileName: "ledger-a.jsonl" });
    await ledger.upsert("account-1", "plan-a", { discoveredAt: at }, at);
    await ledger.markClaimed("account-1", "plan-a", { effectiveAt: at + 3600_000 }, at);
    await ledger.markExhausted("account-2", "plan-a", {}, at);
    expect(ledger.get("account-1", "plan-a", at)?.claimedAt).toBe(at);
    expect(ledger.get("account-2", "plan-a", at)?.claimedAt).toBeUndefined();
    expect(ledger.get("account-2", "plan-a", at)?.exhaustedAt).toBe(at);
    expect(ledger.forAccount("account-1", at)).toHaveLength(1);
    expect(ledger.forAccount("account-3", at)).toHaveLength(0);
    expect(ledger.state(ledger.get("account-1", "plan-a", at), at)).toBe("claimed");
    expect(ledger.state(ledger.get("account-1", "plan-a", at), at + 3600_000)).toBe("effective");
    expect(ledger.state(ledger.get("account-2", "plan-a", at), at)).toBe("exhausted");
  });

  it("survives a process restart and never persists raw delivery fields", async () => {
    const first = createActivityLedger({ fileName: "ledger-b.jsonl" });
    await first.upsert("account-1", "plan-a", { discoveredAt: at, lastOutcome: "raw-should-not-be-here" }, at);
    await first.markClaimed("account-1", "plan-a", {}, at);
    const second = createActivityLedger({ fileName: "ledger-b.jsonl" });
    const entry = second.get("account-1", "plan-a", at);
    expect(entry?.claimedAt).toBe(at);
    expect(entry?.discoveredAt).toBe(at);
    const text = readFileSync(join(dir, "ledger-b.jsonl"), "utf-8");
    expect(text).not.toContain('"raw"');
    expect(text.split("\n").filter(Boolean).length).toBe(2);
  });

  it("serializes concurrent writers from different schedulers without dropping updates", async () => {
    const ledger = createActivityLedger({ fileName: "ledger-c.jsonl" });
    await Promise.all([
      ledger.upsert("account-1", "plan-a", { alarmAt: 1 }, at),
      ledger.upsert("account-1", "plan-b", { alarmAt: 2 }, at),
      ledger.upsert("account-2", "plan-a", { alarmAt: 3 }, at),
    ]);
    expect(ledger.forAccount("account-1", at)).toHaveLength(2);
    expect(ledger.forAccount("account-2", at)).toHaveLength(1);
    const lines = readFileSync(join(dir, "ledger-c.jsonl"), "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("skips bad rows with a log and keeps the other accounts' rows", () => {
    const path = join(dir, "ledger-d.jsonl");
    writeFileSync(path, [
      "{this is not json",
      JSON.stringify({ accountId: "broken", planId: "p", day: "not-a-day" }),
      JSON.stringify({ accountId: "keep", planId: "p", day: beijingDayKey(at), claimedAt: at }),
    ].join("\n") + "\n");
    const ledger = createActivityLedger({ fileName: "ledger-d.jsonl" });
    expect(ledger.get("keep", "p", at)?.claimedAt).toBe(at);
    expect(ledger.get("broken", "p", at)).toBeUndefined();
  });

  it("purges expired rows and rewrites a readable file", async () => {
    const ledger = createActivityLedger({ fileName: "ledger-e.jsonl" });
    await ledger.upsert("a", "expired", { expiresAt: at, exhaustedAt: at }, at);
    await ledger.upsert("a", "live", { expiresAt: at + 100_000 }, at);
    expect(await ledger.purgeExpired(at + 1)).toBe(1);
    expect(ledger.get("a", "expired", at)).toBeUndefined();
    expect(ledger.get("a", "live", at)).toBeDefined();
    const lines = readFileSync(join(dir, "ledger-e.jsonl"), "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).planId).toBe("live");
  });

  it("uses the shared store directory and the default file name", async () => {
    const ledger = createActivityLedger();
    await ledger.markClaimed("a", "p", {}, at);
    expect(readFileSync(join(dir, ACTIVITY_LEDGER_FILE), "utf-8")).toContain('"planId":"p"');
  });
});
