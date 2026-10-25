/** Durable personal data; never rebuild or silently discard user-owned state. */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { DeckStore } from "../deck/deckStore.js";
import type { DeckStoreDump } from "../deck/deckStore.js";
import { parseDeckStoreDump } from "../deck/persistence.js";
import { CollectionStore } from "../collection/collectionStore.js";
import {
  OPEN_PRINT_JOB_STATUSES,
  PrintJobRecordSchema,
  PrintJobStore,
  PrintPresetSchema,
} from "../print/jobStore.js";
import { StructuredError } from "../types/errors.js";
import type { PrintDataDriver, PrintJobRow, UserDataDriver } from "./driver.js";

export const USER_DATA_DATABASE_NAME = "user-data.sqlite";
const DATABASE_NAME = USER_DATA_DATABASE_NAME;
/**
 * Schema history. Version 1: deck_state, collections, metadata. Version 2 adds
 * print_jobs and print_presets (chunk print-job-store). A version-1 database or
 * backup still validates and migrates once on open, after a pre-migration
 * backup; a database from a newer schema is refused.
 */
const SCHEMA_VERSION = 2;
const SUPPORTED_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1, 2]);
const VERSION_1_SCHEMA_SQL =
  "CREATE TABLE deck_state (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL); CREATE TABLE collections (session_id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)";
const OPEN_STATUS_LIST = OPEN_PRINT_JOB_STATUSES.map((status) => `'${status}'`).join(", ");
/** Version 2: one open job per principal, deck and version is a database invariant. */
const VERSION_2_SCHEMA_SQL =
  "CREATE TABLE print_jobs (job_id TEXT PRIMARY KEY, principal TEXT NOT NULL, deck_id TEXT NOT NULL, deck_version INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL); " +
  "CREATE INDEX print_jobs_principal ON print_jobs (principal, created_at, job_id); " +
  `CREATE UNIQUE INDEX print_jobs_open ON print_jobs (principal, deck_id, deck_version) WHERE status IN (${OPEN_STATUS_LIST}); ` +
  "CREATE TABLE print_presets (principal TEXT PRIMARY KEY, payload TEXT NOT NULL)";
/** Per-job directories (`<root>/print-jobs/<job_id>`) hold print images, the project file and filler evidence. */
export const PRINT_JOBS_DIRECTORY = "print-jobs";
const BACKUP_PATTERN = /^user-data-\d{17}-[\da-f-]+\.sqlite$/;
const collectionSchema = z.array(z.string().min(1));
const textRow = z.object({ payload: z.string() });
const collectionRow = z.object({
  session_id: z.string().min(1),
  payload: z.string(),
});

export interface UserDataStoreOptions {
  /** Failure injection at the final pre-commit boundary, for durability tests. */
  beforeCommit?: () => void;
  /**
   * Minimum number of automatic pre-operation snapshots to retain by recency
   * (default 5, minimum 2). Older snapshots also survive while they are the
   * newest of their hour (for a day) or of their day (for a week), so a burst
   * of mutations cannot erase every recovery point from before the burst.
   */
  backupRetention?: number;
  /** Injectable clock for the backup stamps and retention buckets (tests). */
  now?: () => Date;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Epoch ms of a backup file name's 17-digit UTC stamp, or null for a foreign name. */
function backupStampMs(name: string): number | null {
  const digits = name.slice("user-data-".length, "user-data-".length + 17);
  if (!/^\d{17}$/.test(digits)) return null;
  const n = (from: number, length: number) => Number(digits.slice(from, from + length));
  return Date.UTC(n(0, 4), n(4, 2) - 1, n(6, 2), n(8, 2), n(10, 2), n(12, 2), n(14, 3));
}

/**
 * The backups to keep out of `names`: the newest `minimum` by stamp, plus the
 * newest of each hour bucket younger than a day and of each day bucket younger
 * than a week. Deterministic given the clock, so two processes agree.
 */
export function retainedBackups(
  names: readonly string[],
  nowMs: number,
  minimum: number,
): Set<string> {
  const stamped = names
    .map((name) => ({ name, at: backupStampMs(name) }))
    .filter((entry): entry is { name: string; at: number } => entry.at !== null)
    .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  const keep = new Set<string>(stamped.slice(0, Math.max(0, minimum)).map((entry) => entry.name));
  const buckets = new Set<string>();
  for (const entry of stamped) {
    const age = nowMs - entry.at;
    const bucket =
      age < DAY_MS
        ? `hour:${Math.floor(entry.at / HOUR_MS)}`
        : age < 7 * DAY_MS
          ? `day:${Math.floor(entry.at / DAY_MS)}`
          : null;
    if (bucket === null || buckets.has(bucket)) continue;
    buckets.add(bucket);
    keep.add(entry.name);
  }
  return keep;
}

export interface RestoreUserDataResult {
  restoredFrom: string;
  preservedPath?: string;
}

function storageError(context: string, error: unknown): StructuredError<"STORAGE_ERROR"> {
  return new StructuredError(
    "STORAGE_ERROR",
    `${context}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function syncDirectory(directory: string): void {
  // Node cannot open/fsync a directory handle on Windows. Regular snapshot
  // files are still fsynced; SQLite FULL covers the authoritative commit.
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Write a complete snapshot and its directory entry before acknowledging it. */
function writeAtomic(path: string, bytes: Uint8Array): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Shared schema read keeps a real SHARED lock until close; no per-startup DDL. */
function openCoordination(root: string, exclusive: boolean): Database.Database {
  const db = new Database(join(root, "user-data-lock.sqlite"), {
    timeout: 1000,
  });
  try {
    db.pragma("journal_mode = DELETE");
    db.exec(exclusive ? "BEGIN EXCLUSIVE" : "BEGIN; SELECT count(*) FROM sqlite_schema");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** RESERVED serializes initializers while remaining compatible with live SHARED leases. */
function openStartupGate(root: string): Database.Database {
  const db = new Database(join(root, "user-data-lock.sqlite"), {
    timeout: 5000,
  });
  try {
    db.exec("BEGIN IMMEDIATE");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function markInitialized(root: string): void {
  const marker = join(root, "user-data.initialized");
  if (!existsSync(marker)) writeAtomic(marker, Buffer.from("1\n"));
}

function loadDecks(db: Database.Database): DeckStoreDump {
  const row = textRow.parse(db.prepare("SELECT payload FROM deck_state WHERE id = 1").get());
  return parseDeckStoreDump(JSON.parse(row.payload));
}

function schemaVersion(db: Database.Database): number {
  return z
    .number()
    .int()
    .parse(db.pragma("user_version", { simple: true }));
}

/** Accepts every supported schema version so a version-1 backup can still be selected. */
export function validateUserDataDatabase(db: Database.Database): void {
  const version = schemaVersion(db);
  if (!SUPPORTED_SCHEMA_VERSIONS.has(version))
    throw new Error("unsupported or incomplete user-data schema; select a backup to restore");
  if (db.pragma("integrity_check", { simple: true }) !== "ok")
    throw new Error("SQLite integrity check failed");
  loadDecks(db);
  for (const value of db.prepare("SELECT session_id, payload FROM collections").all()) {
    const row = collectionRow.parse(value);
    collectionSchema.parse(JSON.parse(row.payload));
  }
  z.object({ value: z.literal("1") }).parse(
    db.prepare("SELECT value FROM metadata WHERE key = 'initialized'").get(),
  );
  if (version >= 2) {
    for (const value of db.prepare("SELECT payload FROM print_jobs").all())
      PrintJobRecordSchema.parse(JSON.parse(textRow.parse(value).payload));
    for (const value of db.prepare("SELECT payload FROM print_presets").all())
      PrintPresetSchema.parse(JSON.parse(textRow.parse(value).payload));
  }
}

class SqliteUserDataDriver implements UserDataDriver, PrintDataDriver {
  private active = false;
  private changed = false;
  private notifications: Array<() => void> = [];
  private readonly retention: number;

  constructor(
    private readonly db: Database.Database,
    private readonly root: string,
    private readonly options: UserDataStoreOptions,
  ) {
    this.retention = options.backupRetention ?? 5;
    if (!Number.isSafeInteger(this.retention) || this.retention < 2)
      throw new Error("backupRetention must be an integer of at least 2");
  }

  transaction<T>(callback: () => T): T {
    if (this.active) return callback();
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw storageError(
        "Cannot lock user data for writing; retry when other writers finish",
        error,
      );
    }
    this.active = true;
    this.changed = false;
    this.notifications = [];
    let result: T;
    try {
      result = callback();
      if (result instanceof Promise) throw new Error("User data transactions must be synchronous");
      if (this.changed) {
        try {
          this.options.beforeCommit?.();
        } catch (error) {
          throw storageError("User data commit failed; no changes saved", error);
        }
      }
      try {
        this.db.exec("COMMIT");
      } catch (error) {
        throw storageError("User data commit failed; no changes saved", error);
      }
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      this.notifications = [];
      throw error;
    } finally {
      this.active = false;
    }
    const notifications = this.notifications;
    this.notifications = [];
    for (const notify of notifications) notify();
    return result;
  }

  afterCommit(callback: () => void): void {
    if (this.active) this.notifications.push(callback);
    else callback();
  }

  private beforeWrite(): void {
    if (!this.active) throw new Error("User data write requires a transaction");
    if (this.changed) return;
    try {
      const directory = join(this.root, "backups");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const names = readdirSync(directory)
        .filter((name) => BACKUP_PATTERN.test(name))
        .sort();
      const last = names.at(-1)?.slice("user-data-".length, "user-data-".length + 17);
      const clock = this.options.now?.() ?? new Date();
      const now = clock.toISOString().replace(/\D/g, "");
      // Monotonic across processes under BEGIN IMMEDIATE, even within one millisecond.
      const stamp = last && last >= now ? String(BigInt(last) + 1n) : now;
      const target = join(directory, `user-data-${stamp}-${randomUUID()}.sqlite`);
      const pending = `${target}.pending`;
      // Stage and sync the new image before pruning any history. The retained
      // set remains bounded; an interrupted .pending image is never auto-restored.
      try {
        writeAtomic(pending, this.db.serialize());
        const keep = retainedBackups(names, clock.getTime(), this.retention - 1);
        for (const name of names) {
          if (!keep.has(name)) unlinkSync(join(directory, name));
        }
        renameSync(pending, target);
        syncDirectory(directory);
      } finally {
        if (existsSync(pending)) unlinkSync(pending);
      }
      this.changed = true;
    } catch (error) {
      throw storageError("Automatic user-data backup failed; no changes saved", error);
    }
  }

  loadDecks(): DeckStoreDump {
    try {
      return loadDecks(this.db);
    } catch (error) {
      throw storageError("Cannot read user data; stop servers and restore a backup", error);
    }
  }

  saveDecks(dump: DeckStoreDump): void {
    try {
      const payload = JSON.stringify(parseDeckStoreDump(dump));
      this.beforeWrite();
      this.db.prepare("UPDATE deck_state SET payload = ? WHERE id = 1").run(payload);
    } catch (error) {
      if (error instanceof StructuredError) throw error;
      throw storageError("Cannot save decks; no changes saved", error);
    }
  }

  getCollection(sessionId: string): string[] {
    try {
      const value = this.db
        .prepare("SELECT payload FROM collections WHERE session_id = ?")
        .get(sessionId);
      return value ? collectionSchema.parse(JSON.parse(textRow.parse(value).payload)) : [];
    } catch (error) {
      throw storageError("Cannot read collection", error);
    }
  }

  setCollection(sessionId: string, oracleIds: readonly string[]): void {
    try {
      z.string().min(1).parse(sessionId);
      const payload = JSON.stringify(collectionSchema.parse(oracleIds));
      this.beforeWrite();
      this.db
        .prepare(
          "INSERT INTO collections (session_id, payload) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET payload = excluded.payload",
        )
        .run(sessionId, payload);
    } catch (error) {
      if (error instanceof StructuredError) throw error;
      throw storageError("Cannot save collection; no changes saved", error);
    }
  }

  /** Raise a version-1 database to version 2 inside one transaction, after the usual backup. */
  migrate(): void {
    this.transaction(() => {
      if (schemaVersion(this.db) !== 1) return;
      try {
        this.beforeWrite();
        this.db.exec(VERSION_2_SCHEMA_SQL);
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      } catch (error) {
        if (error instanceof StructuredError) throw error;
        throw storageError("User-data schema migration failed; the database is unchanged", error);
      }
    });
  }

  getPrintJob(principal: string, jobId: string): unknown {
    return this.readPrint("Cannot read print job", () =>
      this.payloadOf(
        this.db
          .prepare("SELECT payload FROM print_jobs WHERE job_id = ? AND principal = ?")
          .get(jobId, principal),
      ),
    );
  }

  findOpenPrintJob(principal: string, deckId: string, deckVersion: number): unknown {
    return this.readPrint("Cannot read print job", () =>
      this.payloadOf(
        this.db
          .prepare(
            `SELECT payload FROM print_jobs WHERE principal = ? AND deck_id = ? AND deck_version = ? AND status IN (${OPEN_STATUS_LIST})`,
          )
          .get(principal, deckId, deckVersion),
      ),
    );
  }

  listPrintJobs(principal: string, limit: number): unknown[] {
    return this.readPrint("Cannot list print jobs", () =>
      this.db
        .prepare(
          "SELECT payload FROM print_jobs WHERE principal = ? ORDER BY created_at DESC, job_id DESC LIMIT ?",
        )
        .all(principal, z.number().int().positive().parse(limit))
        .map((value) => this.payloadOf(value)),
    );
  }

  insertPrintJob(row: PrintJobRow): void {
    try {
      this.beforeWrite();
      this.db
        .prepare(
          "INSERT INTO print_jobs (job_id, principal, deck_id, deck_version, status, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          row.job_id,
          row.principal,
          row.deck_id,
          row.deck_version,
          row.status,
          row.created_at,
          row.updated_at,
          JSON.stringify(row.payload),
        );
    } catch (error) {
      if (error instanceof StructuredError) throw error;
      throw storageError("Cannot create print job; nothing was saved", error);
    }
  }

  updatePrintJob(
    principal: string,
    jobId: string,
    status: string,
    updatedAt: string,
    payload: unknown,
  ): boolean {
    try {
      this.beforeWrite();
      const result = this.db
        .prepare(
          "UPDATE print_jobs SET status = ?, updated_at = ?, payload = ? WHERE job_id = ? AND principal = ?",
        )
        .run(status, updatedAt, JSON.stringify(payload), jobId, principal);
      return result.changes === 1;
    } catch (error) {
      if (error instanceof StructuredError) throw error;
      throw storageError("Cannot save print job; the previous state is kept", error);
    }
  }

  getPrintPreset(principal: string): unknown {
    return this.readPrint("Cannot read print preset", () =>
      this.payloadOf(
        this.db.prepare("SELECT payload FROM print_presets WHERE principal = ?").get(principal),
      ),
    );
  }

  setPrintPreset(principal: string, payload: unknown): void {
    try {
      this.beforeWrite();
      this.db
        .prepare(
          "INSERT INTO print_presets (principal, payload) VALUES (?, ?) ON CONFLICT(principal) DO UPDATE SET payload = excluded.payload",
        )
        .run(principal, JSON.stringify(payload));
    } catch (error) {
      if (error instanceof StructuredError) throw error;
      throw storageError("Cannot save print preset; no changes saved", error);
    }
  }

  private payloadOf(value: unknown): unknown {
    return value === undefined ? null : JSON.parse(textRow.parse(value).payload);
  }

  private readPrint<T>(context: string, body: () => T): T {
    try {
      return body();
    } catch (error) {
      throw storageError(context, error);
    }
  }
}

export class UserDataStore {
  readonly deckStore: DeckStore;
  readonly collection: CollectionStore;
  readonly print: PrintJobStore;
  private readonly db: Database.Database;
  private readonly coordination: Database.Database;

  constructor(root: string, options: UserDataStoreOptions = {}) {
    let coordination: Database.Database;
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      coordination = openCoordination(root, false);
    } catch (error) {
      throw storageError("Cannot open user-data coordination lock", error);
    }
    let db: Database.Database | undefined;
    let startupGate: Database.Database | undefined;
    try {
      startupGate = openStartupGate(root);
      const databasePath = join(root, DATABASE_NAME);
      const existed = existsSync(databasePath);
      if (existed && statSync(databasePath).size === 0)
        throw new Error("user-data.sqlite is empty; select a backup to restore");
      if (!existed && existsSync(join(root, "user-data.initialized")))
        throw new Error("initialized user-data.sqlite is missing; select a backup to restore");
      const backupsPath = join(root, "backups");
      if (
        !existed &&
        existsSync(backupsPath) &&
        readdirSync(backupsPath).some((name) => BACKUP_PATTERN.test(name))
      )
        throw new Error(
          "user-data.sqlite is missing but backups exist; select a backup to restore",
        );
      const legacyPath = join(root, "decks.json");
      let legacy: DeckStoreDump | undefined;
      if (!existed && existsSync(legacyPath)) {
        const bytes = readFileSync(legacyPath);
        legacy = parseDeckStoreDump(JSON.parse(bytes.toString("utf8")));
        const preserved = `${legacyPath}.migrated`;
        if (existsSync(preserved)) {
          if (!readFileSync(preserved).equals(bytes))
            throw new Error(
              "decks.json differs from its preserved migration source; restore or reconcile explicitly",
            );
        } else writeAtomic(preserved, bytes);
      }
      db = new Database(databasePath, { timeout: 5000 });
      if (!existed) {
        db.pragma("journal_mode = WAL");
        db.pragma("synchronous = FULL");
        db.transaction(() => {
          if (db?.pragma("user_version", { simple: true }) === SCHEMA_VERSION) return;
          db?.exec(`${VERSION_1_SCHEMA_SQL}; ${VERSION_2_SCHEMA_SQL}`);
          db?.prepare("INSERT INTO deck_state (id, payload) VALUES (1, ?)").run(
            JSON.stringify(legacy ?? { decks: [], snapshots: [] }),
          );
          db?.prepare(
            "INSERT INTO metadata (key, value) VALUES ('initialized', '1'), ('legacy_decks_imported', ?)",
          ).run(legacy ? "1" : "0");
          db?.pragma(`user_version = ${SCHEMA_VERSION}`);
        }).immediate();
      }
      validateUserDataDatabase(db);
      markInitialized(root);
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = FULL");
      const driver = new SqliteUserDataDriver(db, root, options);
      if (schemaVersion(db) < SCHEMA_VERSION) {
        driver.migrate();
        validateUserDataDatabase(db);
      }
      this.db = db;
      this.coordination = coordination;
      this.deckStore = new DeckStore({ driver });
      this.collection = new CollectionStore(driver);
      this.print = new PrintJobStore(driver, { jobRoot: join(root, PRINT_JOBS_DIRECTORY) });
    } catch (error) {
      db?.close();
      coordination.close();
      throw storageError(
        "Cannot open durable user data; existing files are preserved. Stop all servers and explicitly restore a valid backup",
        error,
      );
    } finally {
      startupGate?.close();
    }
  }

  close(): void {
    if (this.db.open) this.db.close();
    if (this.coordination.open) this.coordination.close();
  }

  static restore(root: string, backupPath: string): RestoreUserDataResult {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    let coordination: Database.Database;
    try {
      coordination = openCoordination(root, true);
    } catch (error) {
      throw storageError(
        "Stop all servers using this data root before restoring; an active process holds the user-data lock",
        error,
      );
    }
    let backup: Database.Database | undefined;
    let installed = false;
    try {
      const databasePath = join(root, DATABASE_NAME);
      if (resolve(backupPath) === resolve(databasePath))
        throw new Error("restore source must be a separate backup file");
      backup = new Database(backupPath, {
        readonly: true,
        fileMustExist: true,
      });
      validateUserDataDatabase(backup);
      const bytes = backup.serialize();
      backup.close();
      backup = undefined;
      // Fully stage the validated replacement before moving the original aside.
      const staged = join(root, `user-data-restore-${randomUUID()}.sqlite`);
      writeAtomic(staged, bytes);
      markInitialized(root);
      let preservedPath: string | undefined;
      try {
        if (existsSync(databasePath)) {
          preservedPath = `${databasePath}.corrupt-${Date.now()}-${randomUUID()}`;
          renameSync(databasePath, preservedPath);
        }
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          const sidecar = `${databasePath}${suffix}`;
          if (existsSync(sidecar))
            renameSync(
              sidecar,
              `${preservedPath ?? `${databasePath}.corrupt-${randomUUID()}`}${suffix}`,
            );
        }
        renameSync(staged, databasePath);
        installed = true;
        syncDirectory(root);
      } finally {
        if (existsSync(staged)) unlinkSync(staged);
      }
      return {
        restoredFrom: resolve(backupPath),
        ...(preservedPath ? { preservedPath } : {}),
      };
    } catch (error) {
      throw storageError(
        installed
          ? "Restored user-data.sqlite, but directory sync failed; originals and backups are preserved"
          : "User-data restore failed; originals and backups are preserved",
        error,
      );
    } finally {
      backup?.close();
      coordination.close();
    }
  }
}
