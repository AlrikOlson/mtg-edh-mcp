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
import { StructuredError } from "../types/errors.js";
import type { UserDataDriver } from "./driver.js";

const DATABASE_NAME = "user-data.sqlite";
const SCHEMA_VERSION = 1;
const BACKUP_PATTERN = /^user-data-\d{17}-[\da-f-]+\.sqlite$/;
const collectionSchema = z.array(z.string().min(1));
const textRow = z.object({ payload: z.string() });
const collectionRow = z.object({ session_id: z.string().min(1), payload: z.string() });

export interface UserDataStoreOptions {
  /** Failure injection at the final pre-commit boundary, for durability tests. */
  beforeCommit?: () => void;
  /** Number of automatic pre-operation snapshots to retain (default 5, minimum 2). */
  backupRetention?: number;
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
  const db = new Database(join(root, "user-data-lock.sqlite"), { timeout: 1000 });
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
  const db = new Database(join(root, "user-data-lock.sqlite"), { timeout: 5000 });
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

function validateDatabase(db: Database.Database): void {
  if (db.pragma("user_version", { simple: true }) !== SCHEMA_VERSION)
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
}

class SqliteUserDataDriver implements UserDataDriver {
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
      const now = new Date().toISOString().replace(/\D/g, "");
      // Monotonic across processes under BEGIN IMMEDIATE, even within one millisecond.
      const stamp = last && last >= now ? String(BigInt(last) + 1n) : now;
      const target = join(directory, `user-data-${stamp}-${randomUUID()}.sqlite`);
      const pending = `${target}.pending`;
      // Stage and sync the new image before pruning any history. The retained
      // set remains bounded; an interrupted .pending image is never auto-restored.
      try {
        writeAtomic(pending, this.db.serialize());
        while (names.length >= this.retention) {
          const name = names.shift();
          if (name) unlinkSync(join(directory, name));
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
}

export class UserDataStore {
  readonly deckStore: DeckStore;
  readonly collection: CollectionStore;
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
          db?.exec(
            "CREATE TABLE deck_state (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL); CREATE TABLE collections (session_id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
          );
          db?.prepare("INSERT INTO deck_state (id, payload) VALUES (1, ?)").run(
            JSON.stringify(legacy ?? { decks: [], snapshots: [] }),
          );
          db?.prepare(
            "INSERT INTO metadata (key, value) VALUES ('initialized', '1'), ('legacy_decks_imported', ?)",
          ).run(legacy ? "1" : "0");
          db?.pragma(`user_version = ${SCHEMA_VERSION}`);
        }).immediate();
      }
      validateDatabase(db);
      markInitialized(root);
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = FULL");
      const driver = new SqliteUserDataDriver(db, root, options);
      this.db = db;
      this.coordination = coordination;
      this.deckStore = new DeckStore({ driver });
      this.collection = new CollectionStore(driver);
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
      backup = new Database(backupPath, { readonly: true, fileMustExist: true });
      validateDatabase(backup);
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
      return { restoredFrom: resolve(backupPath), ...(preservedPath ? { preservedPath } : {}) };
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
