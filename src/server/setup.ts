/** Offline setup and diagnostics. Doctor never opens an on-disk SQLite connection. */
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { CardIndex, DEFAULT_INDEX_NAME } from "../index/cardIndex.js";
import { DEFAULT_DATA_ROOT, freshnessConfigFromEnv } from "../index/freshness.js";
import { VersionedStore } from "../ingest/store.js";
import {
  USER_DATA_DATABASE_NAME,
  UserDataStore,
  validateUserDataDatabase,
} from "../storage/userData.js";

export const SUPPORTED_NODE_RANGE = "^22.13.0 || ^24.0.0 || ^26.0.0";
export interface SetupOptions {
  env: Record<string, string | undefined>;
  executable: string;
  entrypoint: string;
  nodeVersion?: string;
  now?: () => number;
}
export interface DiagnosticCheck {
  name: string;
  status: "ok" | "action" | "error";
  message: string;
  fix?: string;
}
export interface DiagnosticReport {
  command: "setup" | "doctor";
  exitCode: 0 | 1 | 2;
  status: "ready" | "needs_action" | "error";
  runtime: { node: string; supportedRange: string; supported: boolean; sqlite: boolean };
  paths: { dataRoot: string; userData: string; pointer: string };
  checks: DiagnosticCheck[];
  nextSteps: string[];
}
export interface SetupReport extends DiagnosticReport {
  clientConfig?: {
    mcpServers: {
      "mtg-edh": {
        command: string;
        args: string[];
        env: { MCP_DATA_DIR: string };
      };
    };
  };
}

function supportedNode(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  return major === 24 || major === 26 || (major === 22 && Number(match[2]) >= 13);
}

function reportFor(command: DiagnosticReport["command"], options: SetupOptions): DiagnosticReport {
  const node = options.nodeVersion ?? process.versions.node;
  const dataRoot = resolve(options.env.MCP_DATA_DIR ?? DEFAULT_DATA_ROOT);
  const report: DiagnosticReport = {
    command,
    exitCode: 0,
    status: "ready",
    runtime: {
      node,
      supportedRange: SUPPORTED_NODE_RANGE,
      supported: supportedNode(node),
      sqlite: false,
    },
    paths: {
      dataRoot,
      userData: join(dataRoot, USER_DATA_DATABASE_NAME),
      pointer: join(dataRoot, "current.json"),
    },
    checks: [],
    nextSteps: [],
  };
  report.checks.push(
    report.runtime.supported
      ? { name: "node", status: "ok", message: "Node.js is supported." }
      : {
          name: "node",
          status: "error",
          message: "Node.js is outside the supported range.",
          fix: "Install a supported Node.js version (24 recommended), then reinstall dependencies.",
        },
  );
  if (options.env.MCP_DATA_DIR !== undefined && options.env.MCP_DATA_DIR.trim() === "") {
    report.checks.push({
      name: "configuration",
      status: "error",
      message: "MCP_DATA_DIR is empty.",
      fix: "Set MCP_DATA_DIR to a non-empty absolute directory path.",
    });
  }
  try {
    const db = new Database(":memory:");
    try {
      db.prepare("SELECT sqlite_version()").get();
    } finally {
      db.close();
    }
    report.runtime.sqlite = true;
    report.checks.push({
      name: "sqlite",
      status: "ok",
      message: "The native SQLite dependency loads.",
    });
  } catch {
    report.checks.push({
      name: "sqlite",
      status: "error",
      message: "The native SQLite dependency could not load.",
      fix: "Reinstall dependencies using this Node.js version; install a native build toolchain if a prebuilt binary is unavailable.",
    });
  }
  return report;
}

function finish<T extends DiagnosticReport>(report: T): T {
  report.exitCode = report.checks.some((check) => check.status === "error")
    ? 1
    : report.checks.some((check) => check.status === "action")
      ? 2
      : 0;
  report.status =
    report.exitCode === 1 ? "error" : report.exitCode === 2 ? "needs_action" : "ready";
  report.nextSteps = [
    ...new Set([
      ...report.nextSteps,
      ...report.checks.flatMap((check) => (check.fix ? [check.fix] : [])),
    ]),
  ];
  return report;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function exists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

/** Idempotent explicit initialization; no client configuration file is written. */
export async function runSetup(options: SetupOptions): Promise<SetupReport> {
  const report: SetupReport = reportFor("setup", options);
  if (finish(report).exitCode === 1) return report;
  try {
    await mkdir(report.paths.dataRoot, { recursive: true, mode: 0o700 });
    const storage = new UserDataStore(report.paths.dataRoot);
    storage.close();
    report.checks.push({
      name: "user_data",
      status: "ok",
      message: "Durable storage is initialized; existing data is preserved.",
    });
    report.clientConfig = {
      mcpServers: {
        "mtg-edh": {
          command: resolve(options.executable),
          args: [resolve(options.entrypoint), "--stdio"],
          env: { MCP_DATA_DIR: report.paths.dataRoot },
        },
      },
    };
    report.nextSteps.push(
      "Merge clientConfig into your MCP client configuration, preserving existing entries, then connect the client.",
      "Call data_status; if card data is missing or stale, call data_ingest and poll data_status until done. Large downloads require network access and several GB of disk space.",
      "Run mtg-edh-mcp doctor with the same MCP_DATA_DIR to verify readiness.",
    );
  } catch {
    report.checks.push({
      name: "user_data",
      status: "error",
      message: "Storage initialization failed; existing user data is preserved.",
      fix: "Check directory permissions and free space. Stop competing processes and run doctor; use restore-user-data with an explicit backup for damaged storage.",
    });
  }
  return finish(report);
}

class UnsettledDatabase extends Error {}

async function hasPendingJournal(filename: string): Promise<boolean> {
  for (const suffix of ["-wal", "-journal"]) {
    try {
      if ((await stat(`${filename}${suffix}`)).size > 0) return true;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
  return false;
}

/**
 * Read a stable, checkpointed image into memory. A readonly SQLite file handle
 * can still create WAL/SHM files, so doctor must not use one. SQLite's documented
 * deserialize workaround changes WAL header bytes only in this private buffer:
 * https://sqlite.org/c3ref/deserialize.html. Pending journals are never ignored.
 */
async function databaseImage(filename: string): Promise<Buffer> {
  if (await hasPendingJournal(filename)) throw new UnsettledDatabase();
  const before = await stat(filename);
  const bytes = await readFile(filename);
  const after = await stat(filename);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    (await hasPendingJournal(filename))
  ) {
    throw new UnsettledDatabase();
  }
  if (bytes.length < 100 || bytes.toString("utf8", 0, 16) !== "SQLite format 3\0") {
    throw new Error("Invalid SQLite header");
  }
  if (bytes[18] === 2 && bytes[19] === 2) {
    bytes[18] = 1;
    bytes[19] = 1;
  }
  return bytes;
}

function databaseFailure(name: string, error: unknown, fix: string): DiagnosticCheck {
  return error instanceof UnsettledDatabase
    ? {
        name,
        status: "action",
        message: "A journal or concurrent write prevents a read-only checkpointed-image check.",
        fix: "Stop all servers and ingestion processes cleanly, then rerun doctor. Preserve journal files; do not delete them.",
      }
    : {
        name,
        status: "error",
        message: "Stored data is unreadable, incomplete, or incompatible.",
        fix,
      };
}

async function inspectUserData(report: DiagnosticReport): Promise<void> {
  try {
    if (!(await exists(report.paths.userData))) {
      const root = report.paths.dataRoot;
      const backups = (await exists(join(root, "backups")))
        ? await readdir(join(root, "backups"))
        : [];
      const initialized =
        (await exists(join(root, "user-data.initialized"))) ||
        backups.some((name) => /^user-data-.*\.sqlite$/.test(name));
      report.checks.push(
        initialized
          ? {
              name: "user_data",
              status: "error",
              message: "Previously initialized user data is missing.",
              fix: "Stop all servers and restore-user-data from an explicit valid backup; preserve the data directory.",
            }
          : {
              name: "user_data",
              status: "action",
              message: "Durable user storage is not initialized.",
              fix: "Run mtg-edh-mcp setup with the same MCP_DATA_DIR; any legacy decks.json will be validated and preserved.",
            },
      );
      return;
    }
    const db = new Database(await databaseImage(report.paths.userData), { readonly: true });
    try {
      validateUserDataDatabase(db);
    } finally {
      db.close();
    }
    report.checks.push({
      name: "user_data",
      status: "ok",
      message: "User-data integrity and schema are valid.",
    });
  } catch (error) {
    report.checks.push(
      databaseFailure(
        "user_data",
        error,
        "Check read permissions; stop all servers and use restore-user-data with an explicit valid backup for damaged storage. Preserve existing files.",
      ),
    );
  }
}

const manifestSchema = z.object({
  version: z.string(),
  snapshot: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  files: z.object({
    oracle_cards: z.object({
      name: z.enum(["oracle_cards.json", "oracle_cards.jsonl"]),
      bytes: z.number().int().positive(),
      updated_at: z.iso.datetime({ offset: true }),
    }),
    default_cards: z.object({
      name: z.enum(["default_cards.json", "default_cards.jsonl"]),
      bytes: z.number().int().positive(),
      updated_at: z.iso.datetime({ offset: true }),
    }),
  }),
});

async function inspectVersion(
  store: VersionedStore,
  version: string,
): Promise<{ snapshot: string; updated: number; cards: number }> {
  const manifest = manifestSchema.parse(await store.readManifest(version));
  if (manifest.version !== version) throw new Error("Manifest identity mismatch");
  for (const file of Object.values(manifest.files)) {
    const info = await stat(store.filePath(version, file.name));
    if (!info.isFile() || info.size !== file.bytes) throw new Error("Incomplete export");
  }
  const bytes = await databaseImage(store.filePath(version, DEFAULT_INDEX_NAME));
  const db = new Database(bytes, { readonly: true });
  try {
    if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("Invalid index");
    z.number().positive().parse(db.prepare("SELECT count(*) FROM printings").pluck().get());
  } finally {
    db.close();
  }
  const index = CardIndex.open(bytes);
  try {
    const cards = index.count();
    if (!cards) throw new Error("Empty card index");
    return {
      snapshot: manifest.snapshot,
      updated: Date.parse(manifest.files.oracle_cards.updated_at),
      cards,
    };
  } finally {
    index.close();
  }
}

async function inspectCards(report: DiagnosticReport, options: SetupOptions): Promise<void> {
  const store = new VersionedStore(report.paths.dataRoot);
  try {
    if (!(await exists(store.pointerPath))) {
      report.checks.push({
        name: "card_data",
        status: "action",
        message: "No published card snapshot exists.",
        fix: "Connect the MCP client, call data_ingest, and poll data_status until done; alternatively run the ingestion CLI with the same MCP_DATA_DIR.",
      });
      return;
    }
    const pointer = await store.readPointer();
    if (!pointer) throw new Error("Invalid current pointer");
    let selected: Awaited<ReturnType<typeof inspectVersion>>;
    let fallback = false;
    try {
      selected = await inspectVersion(store, pointer.version);
    } catch (error) {
      if (!pointer.previous || error instanceof UnsettledDatabase) throw error;
      selected = await inspectVersion(store, pointer.previous);
      fallback = true;
    }
    const age = Math.max(0, (options.now?.() ?? Date.now()) - selected.updated);
    const stale = age >= freshnessConfigFromEnv(options.env).bulkIntervalMs;
    report.checks.push({
      name: "card_data",
      status: stale || fallback ? "action" : "ok",
      message: `${selected.cards} cards in snapshot ${selected.snapshot}; ${fallback ? "using the previous valid snapshot" : "current snapshot valid"}; ${stale ? "stale" : "fresh"}.`,
      ...(stale || fallback
        ? {
            fix: "Call data_ingest and poll data_status until done to publish fresh, validated card data.",
          }
        : {}),
    });
  } catch (error) {
    report.checks.push(
      databaseFailure(
        "card_data",
        error,
        "Check read permissions, then call data_ingest or run the ingestion CLI with the same MCP_DATA_DIR to build a complete snapshot. Existing user data does not need to be deleted.",
      ),
    );
  }
}

/** Diagnose local state only: no networking, directories, locks, migrations, or repairs. */
export async function runDoctor(options: SetupOptions): Promise<DiagnosticReport> {
  const report = reportFor("doctor", options);
  if (finish(report).exitCode === 1) return report;
  try {
    const info = await stat(report.paths.dataRoot);
    if (!info.isDirectory()) throw new Error("Data root is not a directory");
    await access(report.paths.dataRoot, constants.R_OK | constants.W_OK | constants.X_OK);
    report.checks.push({
      name: "data_directory",
      status: "ok",
      message:
        "Data directory exists and permission checks allow reading, writing and traversal (no test file created).",
    });
  } catch (error) {
    report.checks.push(
      hasCode(error, "ENOENT")
        ? {
            name: "data_directory",
            status: "action",
            message: "Data directory does not exist.",
            fix: "Run mtg-edh-mcp setup with the same MCP_DATA_DIR.",
          }
        : {
            name: "data_directory",
            status: "error",
            message: "Data path is not an accessible writable directory.",
            fix: "Choose a persistent directory and grant this user read, write and traversal permissions; then rerun doctor.",
          },
    );
    return finish(report);
  }
  try {
    for (const [name, directory] of [
      [USER_DATA_DATABASE_NAME, false],
      ["user-data-lock.sqlite", false],
      [".refresh-lock.sqlite", false],
      [`${USER_DATA_DATABASE_NAME}-wal`, false],
      [`${USER_DATA_DATABASE_NAME}-shm`, false],
      [`${USER_DATA_DATABASE_NAME}-journal`, false],
      ["versions", true],
      ["backups", true],
    ] as const) {
      const filename = join(report.paths.dataRoot, name);
      if (!(await exists(filename))) continue;
      const info = await stat(filename);
      if (directory ? !info.isDirectory() : !info.isFile()) throw new Error("Invalid storage path");
      await access(filename, constants.R_OK | constants.W_OK | (directory ? constants.X_OK : 0));
    }
    report.checks.push({
      name: "storage_permissions",
      status: "ok",
      message:
        "Existing writable user storage, coordination files, backup and version directories pass permission checks.",
    });
  } catch {
    report.checks.push({
      name: "storage_permissions",
      status: "error",
      message: "An existing storage path has the wrong type or lacks required permissions.",
      fix: "Grant this user read/write access to user-data.sqlite and coordination files, and read/write/traversal access to backups and versions directories; rerun doctor.",
    });
  }
  await inspectUserData(report);
  await inspectCards(report, options);
  return finish(report);
}
