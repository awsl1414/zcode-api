/**
 * Cross-restart ledger for one account's activity state on one Beijing day.
 *
 * A discovery feed can disappear after the claim; the terminal states (claimed,
 * exhausted) must survive a process restart or the scheduler would ask again.
 * JSONL append-only matches `requests.jsonl`: one bad or half-written line is
 * skipped with a log, never invalidates the other accounts' rows. Each line
 * carries the full row, so the last one wins on replay. Writes go through one
 * process-wide promise chain — two schedulers on the same account append in
 * order instead of interleaving bytes.
 *
 * Only generic facts and timestamps are stored. Delivery payloads (`raw`) stay
 * in memory: they change shape per campaign and are not needed to make a
 * decision after the fact.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getStoreDir } from "../storage/store.js";
import { logger } from "../log/index.js";

const log = logger("claim");
export const ACTIVITY_LEDGER_FILE = "activities.jsonl";

/** Beijing is UTC+8 with no DST; the calendar day is the only bucketing we need. */
export function beijingDayKey(atMs: number): string {
  return new Date(atMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export interface ActivityLedgerEntry {
  accountId: string;
  planId: string;
  day: string;
  discoveredAt?: number;
  alarmAt?: number;
  preparedAt?: number;
  claimedAt?: number;
  effectiveAt?: number;
  expiresAt?: number;
  exhaustedAt?: number;
  lastOutcome?: string;
  lastCode?: number | string;
  holdUntil?: number;
}

export type ActivityLedgerPatch = Partial<Omit<ActivityLedgerEntry, "accountId" | "planId" | "day">>;

/** Facts a display or policy layer can read without interpreting raw timestamps. */
export type ActivityLedgerState = "discovered" | "claimed" | "effective" | "exhausted" | "expired";

export interface ActivityLedger {
  get(accountId: string, planId: string, atMs?: number): ActivityLedgerEntry | undefined;
  upsert(accountId: string, planId: string, patch: ActivityLedgerPatch, atMs?: number): Promise<ActivityLedgerEntry>;
  markClaimed(accountId: string, planId: string, patch?: ActivityLedgerPatch, atMs?: number): Promise<ActivityLedgerEntry>;
  markExhausted(accountId: string, planId: string, patch?: ActivityLedgerPatch, atMs?: number): Promise<ActivityLedgerEntry>;
  forAccount(accountId: string, atMs?: number): ActivityLedgerEntry[];
  purgeExpired(atMs?: number): Promise<number>;
  state(entry: ActivityLedgerEntry | undefined, atMs?: number): ActivityLedgerState | undefined;
}

/** A row whose shape cannot be trusted is skipped, not allowed to drop the file. */
function isEntry(value: unknown): value is ActivityLedgerEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.accountId !== "string" || !row.accountId) return false;
  if (typeof row.planId !== "string" || !row.planId) return false;
  if (typeof row.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.day)) return false;
  const numericKeys: (keyof ActivityLedgerPatch)[] = [
    "discoveredAt", "alarmAt", "preparedAt", "claimedAt", "effectiveAt", "expiresAt", "exhaustedAt", "holdUntil",
  ];
  for (const key of numericKeys) {
    if (row[key] === undefined || row[key] === null) continue;
    if (typeof row[key] !== "number" || !Number.isFinite(row[key])) return false;
  }
  if (row.lastOutcome !== undefined && row.lastOutcome !== null && typeof row.lastOutcome !== "string") return false;
  if (row.lastCode !== undefined && row.lastCode !== null && typeof row.lastCode !== "string" && typeof row.lastCode !== "number") return false;
  return true;
}

function entryKey(entry: Pick<ActivityLedgerEntry, "accountId" | "planId" | "day">): string {
  return `${entry.accountId}\u0000${entry.planId}\u0000${entry.day}`;
}

function ledgerPath(fileName: string): string {
  return join(getStoreDir(), fileName);
}

/** A row is past its use once its hold, expiry and exhaustion windows are all over. */
function isExpired(entry: ActivityLedgerEntry, atMs: number): boolean {
  const boundaries = [entry.expiresAt, entry.exhaustedAt, entry.holdUntil].filter(
    (value): value is number => typeof value === "number",
  );
  return boundaries.length > 0 && boundaries.every((value) => value <= atMs);
}

export interface ActivityLedgerOptions {
  /** Override the file name for isolated tests or deployments. */
  fileName?: string;
  /** In-memory only; no file is read or written. */
  memoryOnly?: boolean;
  now?: () => number;
}

export function createActivityLedger(options: ActivityLedgerOptions = {}): ActivityLedger {
  const fileName = options.fileName ?? ACTIVITY_LEDGER_FILE;
  const memoryOnly = options.memoryOnly === true;
  const now = options.now ?? Date.now;
  // The store dir is overridable at runtime (tests and isolated instances), so
  // resolve the path on each use rather than capturing it at construction.
  const path = (): string => ledgerPath(fileName);
  const entries = new Map<string, ActivityLedgerEntry>();
  let chain: Promise<unknown> = Promise.resolve();

  const currentPath = path();
  if (!memoryOnly && existsSync(currentPath)) {
    try {
      const text = readFileSync(currentPath, "utf-8");
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!isEntry(parsed)) {
            log.warn("skipping unreadable activity ledger row", { file: fileName });
            continue;
          }
          entries.set(entryKey(parsed), { ...parsed });
        } catch {
          log.warn("skipping unreadable activity ledger row", { file: fileName });
        }
      }
    } catch (err) {
      log.warn("activity ledger unreadable", { file: fileName, message: (err as Error).message });
    }
  }

  function append(entry: ActivityLedgerEntry): void {
    if (memoryOnly) return;
    const target = path();
    try {
      appendFileSync(target, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      mkdirSync(dirname(target), { recursive: true });
      appendFileSync(target, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    }
  }

  function write(entry: ActivityLedgerEntry): Promise<ActivityLedgerEntry> {
    entries.set(entryKey(entry), entry);
    const task = chain.then(() => append(entry));
    // A failed append must not leave the queue poisoned for the other accounts.
    chain = task.catch((err: unknown) => {
      log.warn("activity ledger write failed", { file: fileName, message: (err as Error).message });
    });
    return task.then(() => entry, (err: unknown) => {
      log.warn("activity ledger write failed", { file: fileName, message: (err as Error).message });
      return entry;
    });
  }

  function upsert(accountId: string, planId: string, patch: ActivityLedgerPatch, atMs = now()): Promise<ActivityLedgerEntry> {
    const day = beijingDayKey(atMs);
    const previous = entries.get(entryKey({ accountId, planId, day }));
    const entry: ActivityLedgerEntry = {
      ...(previous ?? {}),
      ...patch,
      accountId, planId, day,
    };
    return write(entry);
  }

  return {
    get(accountId, planId, atMs = now()) {
      return entries.get(entryKey({ accountId, planId, day: beijingDayKey(atMs) }));
    },
    upsert,
    markClaimed(accountId, planId, patch = {}, atMs = now()) {
      return upsert(accountId, planId, { ...patch, claimedAt: atMs }, atMs);
    },
    markExhausted(accountId, planId, patch = {}, atMs = now()) {
      return upsert(accountId, planId, { ...patch, exhaustedAt: atMs }, atMs);
    },
    forAccount(accountId, atMs = now()) {
      const day = beijingDayKey(atMs);
      return [...entries.values()].filter((entry) => entry.accountId === accountId && entry.day === day);
    },
    async purgeExpired(atMs = now()) {
      let dropped = 0;
      for (const [key, entry] of entries) {
        if (isExpired(entry, atMs)) {
          entries.delete(key);
          dropped += 1;
        }
      }
      const target = path();
      if (dropped === 0 || memoryOnly || !existsSync(target)) return dropped;
      const keep = [...entries.values()];
      await (chain = chain.then(() => {
        const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
        mkdirSync(dirname(target), { recursive: true });
        const fd = openSync(tmp, "w", 0o600);
        try {
          for (const entry of keep) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
        } finally {
          // `writeFileSync(fd, ...)` does not take ownership of the descriptor.
          closeSync(fd);
        }
        renameSync(tmp, target);
      }).catch((err: unknown) => {
        log.warn("activity ledger rewrite failed", { file: fileName, message: (err as Error).message });
      }));
      return dropped;
    },
    state(entry, atMs = now()) {
      if (!entry) return undefined;
      if (entry.exhaustedAt !== undefined) return "exhausted";
      if (entry.expiresAt !== undefined && entry.expiresAt <= atMs) return "expired";
      if (entry.claimedAt !== undefined) {
        return entry.effectiveAt !== undefined && entry.effectiveAt <= atMs ? "effective" : "claimed";
      }
      return "discovered";
    },
  };
}

/** The process's shared ledger. `getStoreDir()` is read on each call, so tests can isolate it. */
export const activityLedger: ActivityLedger = createActivityLedger();
