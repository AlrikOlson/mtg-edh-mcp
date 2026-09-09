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
import { access, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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

function safeVersion(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
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
