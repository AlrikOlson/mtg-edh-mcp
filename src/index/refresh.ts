/** The shared CLI/server refresh transaction: stage, validate, prepare, publish. */
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { BulkClient, ingestBulk, VersionedStore, type VersionCollection } from "../ingest/index.js";
import { StructuredError } from "../types/errors.js";
import { buildIndex, CardIndex, DEFAULT_INDEX_NAME } from "./cardIndex.js";

export interface RefreshSnapshotResult {
  version: string;
  snapshot: string;
  dbPath: string;
  cards: number;
  printings: number;
  skipped: boolean;
  /**
   * The collection pass that followed this run while the lease was still held:
   * every version directory other than the pointer's current and previous is
   * removed. Absent only when the pass itself failed, which never fails the run.
   */
  collection?: VersionCollection;
}

/** Preparation may fail; commit must synchronously install already prepared state. */
export interface PreparedActivation {
  commit(): void;
  dispose(): void;
}

export type RefreshCheckpoint =
  "after-download" | "during-build" | "before-publish" | "after-publish";

export interface RefreshSnapshotOptions {
  store: VersionedStore;
  client: BulkClient;
  force?: boolean;
  onPhase?: (phase: "download" | "build") => void;
  prepareActivation?: (
    snapshot: RefreshSnapshotResult,
  ) => PreparedActivation | Promise<PreparedActivation>;
  /** Operational test seam: checkpoints run only at the named deterministic boundaries. */
  checkpoint?: (phase: RefreshCheckpoint) => void | Promise<void>;
}

export interface OpenSnapshot extends Omit<RefreshSnapshotResult, "skipped"> {
  index: CardIndex;
}

/** Validate all staged artifacts, including legacy JSON-array export manifests. */
async function openVersion(store: VersionedStore, version: string): Promise<OpenSnapshot> {
  const manifest = await store.readManifest(version);
  if (!manifest || manifest.version !== version || !/^\d{4}-\d{2}-\d{2}$/.test(manifest.snapshot)) {
    throw new Error(`Snapshot ${version} has no matching manifest`);
  }
  for (const type of ["oracle_cards", "default_cards"] as const) {
    const file = manifest.files?.[type];
    if (!file || ![`${type}.json`, `${type}.jsonl`].includes(file.name)) {
      throw new Error(`Snapshot ${version} has no ${type} export`);
    }
    const info = await stat(store.filePath(version, file.name));
    if (!info.isFile() || info.size === 0 || info.size !== file.bytes) {
      throw new Error(`Snapshot ${version} has an incomplete ${type} export`);
    }
  }
  const dbPath = store.filePath(version, DEFAULT_INDEX_NAME);
  const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
  let cards: number;
  let printings: number;
  try {
    if (probe.pragma("quick_check", { simple: true }) !== "ok") {
      throw new Error(`Snapshot ${version} failed SQLite quick_check`);
    }
    cards = (probe.prepare("SELECT count(*) AS n FROM cards").get() as { n: number }).n;
    printings = (probe.prepare("SELECT count(*) AS n FROM printings").get() as { n: number }).n;
    if (cards === 0) throw new Error(`Snapshot ${version} has an empty card index`);
    if (printings === 0) throw new Error(`Snapshot ${version} has an empty printing index`);
  } finally {
    probe.close();
  }
  // Opening prepares every statement used by the serving layer, catching schema
  // incompatibility before the current pointer can change.
  const index = CardIndex.open(dbPath);
  return { version, snapshot: manifest.snapshot, dbPath, cards, printings, index };
}

/**
 * Resolve the pointer once and pair the selected index with its own manifest.
 * Only its explicit previous version is eligible for fallback; abandoned stages
 * are never promoted by directory ordering. No valid snapshot means first-run.
 */
export async function openCurrentSnapshot(store: VersionedStore): Promise<OpenSnapshot | null> {
  const pointer = await store.readPointer();
  if (!pointer) return null;
  for (const version of [pointer.version, pointer.previous]) {
    if (!version) continue;
    try {
      return await openVersion(store, version);
    } catch {
      /* Try the known predecessor. */
    }
  }
  return null;
}

/**
 * Take the one-per-data-root refresh lease. SQLite owns the OS lock and
 * releases it on process death, so there are no stale PID files to reclaim.
 * The coordination database must stay at this stable path and is never deleted.
 * Closing the returned handle releases the lease.
 */
async function acquireLease(store: VersionedStore): Promise<Database.Database> {
  await mkdir(store.root, { recursive: true });
  const lease = new Database(path.join(store.root, ".refresh-lock.sqlite"), { timeout: 0 });
  try {
    lease.exec("BEGIN IMMEDIATE");
  } catch (err) {
    lease.close();
    if ((err as { code?: string }).code === "SQLITE_BUSY") {
      throw new StructuredError(
        "UPSTREAM_UNAVAILABLE",
        "A card-data refresh is already running for this data directory",
        {
          reason: "The refresh coordination lock is held by another run; retry after it finishes.",
        },
      );
    }
    throw err;
  }
  return lease;
}

/**
 * Remove every version directory the published pointer does not name as
 * current or previous. Must run under the lease: no other process can then be
 * staging a new directory, so anything unnamed is either superseded or an
 * abandoned stage. With no readable pointer nothing is removed. A refresh also
 * keeps the version that was published when it started (`alsoKeep`), so a
 * rebuild of an unusable current version leaves its files for one more
 * generation instead of deleting them in the same run that replaced them.
 */
async function collectUnderLease(
  store: VersionedStore,
  alsoKeep: string | null = null,
): Promise<VersionCollection> {
  const pointer = await store.readPointer();
  const keep = new Set<string>();
  if (alsoKeep) keep.add(alsoKeep);
  if (!pointer) {
    return {
      retained: await store.listVersions(),
      removed: [],
      skipped: [],
      reclaimed_bytes: 0,
      pointer_temps_removed: 0,
    };
  }
  keep.add(pointer.version);
  if (pointer.previous) keep.add(pointer.previous);
  return store.collect(keep);
}

/**
 * Collect stale versions on demand (the `prune` command) without ingesting.
 * Refuses while a refresh holds the lease, exactly like a competing refresh.
 */
export async function collectStaleVersions(store: VersionedStore): Promise<VersionCollection> {
  const lease = await acquireLease(store);
  try {
    return await collectUnderLease(store);
  } finally {
    lease.close();
  }
}

/** The collection pass that ends every refresh; its failure never fails a committed run. */
async function collectAfterRun(
  store: VersionedStore,
  result: RefreshSnapshotResult,
  startedWith: string | null,
): Promise<RefreshSnapshotResult> {
  try {
    return { ...result, collection: await collectUnderLease(store, startedWith) };
  } catch {
    return result;
  }
}

/** One refresh per data root, across processes; see {@link acquireLease}. */
export async function refreshSnapshot(
  options: RefreshSnapshotOptions,
): Promise<RefreshSnapshotResult> {
  const { store, client, checkpoint, prepareActivation } = options;
  const lease = await acquireLease(store);
  try {
    const pointerVersion = await store.readCurrent();
    const current = await openCurrentSnapshot(store);
    let previous: string | null = null;
    let existing: RefreshSnapshotResult | undefined;
    if (current) {
      previous = current.version;
      const { index, ...info } = current;
      existing = { ...info, skipped: true };
      index.close();
    }
    options.onPhase?.("download");
    const staged = await ingestBulk({
      store,
      client,
      force: options.force === true || !existing || existing.version !== pointerVersion,
    });
    if (staged.skipped && existing) {
      const prepared = await prepareActivation?.(existing);
      prepared?.commit();
      return collectAfterRun(store, existing, pointerVersion);
    }

    await checkpoint?.("after-download");
    options.onPhase?.("build");
    await buildIndex({
      store,
      version: staged.version,
      onCardInserted: async (cards) => {
        if (cards === 1) await checkpoint?.("during-build");
      },
    });
    const candidate = await openVersion(store, staged.version);
    const { index, ...info } = candidate;
    index.close();
    const result: RefreshSnapshotResult = { ...info, skipped: false };
    let prepared: PreparedActivation | undefined;
    let committed = false;
    try {
      prepared = await prepareActivation?.(result);
      await checkpoint?.("before-publish");
      await store.publish(result.version, previous);
      // No await between publication and installing the paired index/snapshot.
      committed = true;
      prepared?.commit();
    } finally {
      if (!committed) prepared?.dispose();
    }
    // Diagnostic hooks cannot turn a committed publication into a failed run.
    try {
      await checkpoint?.("after-publish");
    } catch {
      /* Already committed. */
    }
    return collectAfterRun(store, result, pointerVersion);
  } finally {
    // Closing also rolls back an active coordination transaction. This database
    // carries no card data; rollback is only the release of the writer lease.
    lease.close();
  }
}
