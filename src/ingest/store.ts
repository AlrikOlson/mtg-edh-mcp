/**
 * Versioned on-disk card store (spec §3).
 *
 * Layout under `root/`:
 *   versions/<id>/oracle_cards.jsonl   (legacy versions: oracle_cards.json)
 *   versions/<id>/default_cards.jsonl  (legacy versions: default_cards.json)
 *   versions/<id>/manifest.json
 *   current.json            -> { "version": "<id>" }
 *
 * Atomicity: a new version is built fully under versions/<id>/, then `current.json`
 * is flipped via a temp-write + rename (atomic on the same filesystem). Readers
 * resolve the current version through `current.json`, so they always see either
 * the previous complete version or the new complete one — never a partial load.
 */
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BulkType } from "./scryfall.js";

export interface ManifestFile {
  name: string;
  /** Upstream updated_at this file was downloaded from (idempotency key). */
  updated_at: string;
  bytes: number;
  source_uri: string;
}

export interface Manifest {
  version: string;
  /** ISO date (YYYY-MM-DD) of the card index — the data_snapshot (§3/§11). */
  snapshot: string;
  created_at: string;
  files: Record<BulkType, ManifestFile>;
}

export interface CurrentPointer {
  version: string;
  /** Last validated version before this publication, for explicit recovery. */
  previous?: string;
}

/** One version directory the collector removed, with the bytes it held. */
export interface CollectedVersion {
  version: string;
  bytes: number;
}

/** A version directory the collector left in place although it was not retained. */
export interface SkippedVersion {
  version: string;
  reason: string;
}

/**
 * Outcome of one collection pass over `versions/`: what stayed, what went,
 * what could not be removed, and the abandoned pointer temp files cleared.
 */
export interface VersionCollection {
  retained: string[];
  removed: CollectedVersion[];
  skipped: SkippedVersion[];
  /** Bytes freed by the removed directories (sizes measured before removal). */
  reclaimed_bytes: number;
  /** Abandoned `current.json.*.tmp` files removed. */
  pointer_temps_removed: number;
}

function safeVersion(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(filename);
    else if (entry.isFile()) {
      try {
        total += (await stat(filename)).size;
      } catch {
        /* Removed concurrently; nothing to count. */
      }
    }
  }
  return total;
}

export class VersionedStore {
  readonly root: string;
  readonly versionsDir: string;
  readonly pointerPath: string;

  constructor(root: string) {
    this.root = root;
    this.versionsDir = path.join(root, "versions");
    this.pointerPath = path.join(root, "current.json");
  }

  versionDir(id: string): string {
    return path.join(this.versionsDir, id);
  }

  filePath(id: string, name: string): string {
    return path.join(this.versionDir(id), name);
  }

  /**
   * Path of a staged bulk file, preferring the current JSONL shape
   * (`<type>.jsonl`) over the legacy JSON array (`<type>.json`). Falls back to
   * the legacy path when neither exists, so a missing stage still surfaces as
   * ENOENT at read time.
   */
  async stagedFile(id: string, type: BulkType): Promise<string> {
    const jsonl = this.filePath(id, `${type}.jsonl`);
    try {
      await access(jsonl);
      return jsonl;
    } catch {
      return this.filePath(id, `${type}.json`);
    }
  }

  /** Create an empty version directory ready to receive downloads. */
  async createVersion(id: string): Promise<void> {
    await mkdir(this.versionsDir, { recursive: true });
    await mkdir(this.versionDir(id));
  }

  /** Write an in-memory payload into the version dir, flushed before returning. */
  async writeBytes(id: string, name: string, bytes: Uint8Array): Promise<number> {
    await writeFile(this.filePath(id, name), bytes, { flush: true });
    return bytes.byteLength;
  }

  /** Stream a web ReadableStream into a file inside the version dir. */
  async writeStream(id: string, name: string, body: ReadableStream<Uint8Array>): Promise<number> {
    const dest = this.filePath(id, name);
    const out = createWriteStream(dest, { flush: true });
    await pipeline(Readable.fromWeb(body), out);
    return out.bytesWritten;
  }

  /**
   * Write a version's manifest. The card store writes {@link Manifest}; other
   * versioned corpora sharing this layout (the rules store) write their own
   * manifest shape, so the type is a parameter rather than fixed.
   */
  async writeManifest<M extends { version: string } = Manifest>(
    id: string,
    manifest: M,
  ): Promise<void> {
    await writeFile(this.filePath(id, "manifest.json"), JSON.stringify(manifest, null, 2), {
      encoding: "utf8",
      flush: true,
    });
  }

  async readManifest<M = Manifest>(id: string): Promise<M | null> {
    try {
      return JSON.parse(await readFile(this.filePath(id, "manifest.json"), "utf8")) as M;
    } catch {
      return null;
    }
  }

  /** Resolve the currently published version id, or null if none. */
  async readCurrent(): Promise<string | null> {
    return (await this.readPointer())?.version ?? null;
  }

  /** Read one coherent pointer, accepting legacy {version} records. */
  async readPointer(): Promise<CurrentPointer | null> {
    try {
      const pointer = JSON.parse(await readFile(this.pointerPath, "utf8")) as CurrentPointer;
      if (!safeVersion(pointer.version)) return null;
      return {
        version: pointer.version,
        ...(safeVersion(pointer.previous) && pointer.previous !== pointer.version
          ? { previous: pointer.previous }
          : {}),
      };
    } catch {
      return null;
    }
  }

  /** Atomically flip `current.json` to point at `id` (temp-write + rename). */
  async publish(id: string, previous?: string | null): Promise<void> {
    const prior = previous === undefined ? await this.readCurrent() : previous;
    const pointer: CurrentPointer = { version: id };
    if (prior && prior !== id) pointer.previous = prior;
    const tmp = `${this.pointerPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(pointer), { encoding: "utf8", flag: "wx", flush: true });
      await rename(tmp, this.pointerPath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    // The rename is the commit point. A directory flush is best-effort because
    // some supported filesystems reject it; never report committed data as failed.
    try {
      const directory = await open(this.root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      /* Filesystem does not support directory fsync. */
    }
  }

  /** Delete a version directory (best-effort), e.g. to clean up a failed build. */
  async removeVersion(id: string): Promise<void> {
    await rm(this.versionDir(id), { recursive: true, force: true });
  }

  /** Every version directory name that is a valid version id, oldest first. */
  async listVersions(): Promise<string[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.versionsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && safeVersion(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  /** Total bytes of the regular files under one version directory. */
  async versionBytes(id: string): Promise<number> {
    return directoryBytes(this.versionDir(id));
  }

  /**
   * Remove every version directory not named in `keep`, measuring each before
   * it goes, and clear abandoned pointer temp files. A directory that cannot be
   * removed (held open on a platform that forbids unlinking open files) is
   * reported as skipped, never retried destructively. Callers hold the refresh
   * lease so no concurrent run can be staging into one of these directories.
   */
  async collect(keep: ReadonlySet<string>): Promise<VersionCollection> {
    const result: VersionCollection = {
      retained: [],
      removed: [],
      skipped: [],
      reclaimed_bytes: 0,
      pointer_temps_removed: 0,
    };
    for (const id of await this.listVersions()) {
      if (keep.has(id)) {
        result.retained.push(id);
        continue;
      }
      const bytes = await this.versionBytes(id);
      try {
        await rm(this.versionDir(id), { recursive: true });
      } catch (error) {
        result.skipped.push({
          version: id,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      result.removed.push({ version: id, bytes });
      result.reclaimed_bytes += bytes;
    }
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      names = [];
    }
    const pointerName = path.basename(this.pointerPath);
    for (const name of names) {
      if (!name.startsWith(`${pointerName}.`) || !name.endsWith(".tmp")) continue;
      try {
        await rm(path.join(this.root, name), { force: true });
        result.pointer_temps_removed += 1;
      } catch {
        /* Left for the next pass. */
      }
    }
    return result;
  }

  /** Drop all versions except the current one and the most recent `keep-1` others. */
  async retain(keep = 1): Promise<void> {
    const current = await this.readCurrent();
    let ids: string[];
    try {
      ids = await readdir(this.versionsDir);
    } catch {
      return;
    }
    // Newest first; version ids sort lexicographically by their timestamp prefix.
    const ordered = ids.sort().reverse();
    const retained = new Set<string>();
    if (current) retained.add(current);
    for (const id of ordered) {
      if (retained.size >= keep) break;
      retained.add(id);
    }
    await Promise.all(
      ordered.filter((id) => !retained.has(id)).map((id) => this.removeVersion(id)),
    );
  }
}
