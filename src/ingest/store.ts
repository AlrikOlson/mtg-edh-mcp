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
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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

interface CurrentPointer {
  version: string;
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
    await mkdir(this.versionDir(id), { recursive: true });
  }

  /** Stream a web ReadableStream into a file inside the version dir. */
  async writeStream(id: string, name: string, body: ReadableStream<Uint8Array>): Promise<number> {
    const dest = this.filePath(id, name);
    const out = createWriteStream(dest);
    await pipeline(Readable.fromWeb(body), out);
    return out.bytesWritten;
  }

  async writeManifest(id: string, manifest: Manifest): Promise<void> {
    await writeFile(this.filePath(id, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  }

  async readManifest(id: string): Promise<Manifest | null> {
    try {
      return JSON.parse(await readFile(this.filePath(id, "manifest.json"), "utf8")) as Manifest;
    } catch {
      return null;
    }
  }

  /** Resolve the currently published version id, or null if none. */
  async readCurrent(): Promise<string | null> {
    try {
      const pointer = JSON.parse(await readFile(this.pointerPath, "utf8")) as CurrentPointer;
      return pointer.version;
    } catch {
      return null;
    }
  }

  /** Atomically flip `current.json` to point at `id` (temp-write + rename). */
  async publish(id: string): Promise<void> {
    const tmp = `${this.pointerPath}.${id}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: id } satisfies CurrentPointer), "utf8");
    await rename(tmp, this.pointerPath);
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
