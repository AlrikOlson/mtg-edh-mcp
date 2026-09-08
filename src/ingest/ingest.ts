/**
 * Bulk ingestion orchestrator (spec §3).
 *
 * Resolves the oracle_cards + default_cards bulk entries, and — unless they are
 * unchanged since the last run (idempotency, keyed on upstream `updated_at`) —
 * downloads both into a fresh version directory and writes a manifest. This
 * stage never publishes or deletes versions: refreshSnapshot owns index
 * validation and publication. Failed stages remain available for diagnosis.
 */
import { StructuredError } from "../types/errors.js";
import { randomUUID } from "node:crypto";
import { BULK_TYPES, BulkClient, type BulkDataEntry, type BulkType } from "./scryfall.js";
import { VersionedStore, type Manifest, type ManifestFile } from "./store.js";

export interface IngestOptions {
  store: VersionedStore;
  client: BulkClient;
  /** Re-download even if upstream updated_at is unchanged. */
  force?: boolean;
  /** Injectable clock for the version id + created_at (deterministic tests). */
  clock?: () => Date;
}

export interface IngestResult {
  version: string;
  /** data_snapshot (ISO date) derived from the oracle_cards bulk updated_at. */
  snapshot: string;
  /** True when upstream was unchanged and nothing was re-downloaded. */
  skipped: boolean;
  files: readonly BulkType[];
}

function fileName(type: BulkType, jsonl: boolean): string {
  return jsonl ? `${type}.jsonl` : `${type}.json`;
}

function versionId(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
}

function unchanged(manifest: Manifest, entries: Record<BulkType, BulkDataEntry>): boolean {
  return BULK_TYPES.every((type) => manifest.files[type].updated_at === entries[type].updated_at);
}

export async function ingestBulk(options: IngestOptions): Promise<IngestResult> {
  const { store, client, force = false } = options;
  const clock = options.clock ?? (() => new Date());

  // Resolve both bulk entries up front (rate-limited inside the client).
  const oracle = await client.getEntry("oracle_cards");
  const defaultCards = await client.getEntry("default_cards");
  const entries: Record<BulkType, BulkDataEntry> = {
    oracle_cards: oracle,
    default_cards: defaultCards,
  };

  // Idempotency: skip when the published version already matches upstream.
  const currentId = await store.readCurrent();
  if (!force && currentId) {
    const currentManifest = await store.readManifest(currentId);
    if (currentManifest && unchanged(currentManifest, entries)) {
      return {
        version: currentId,
        snapshot: currentManifest.snapshot,
        skipped: true,
        files: BULK_TYPES,
      };
    }
  }

  const id = versionId(clock());
  const snapshot = oracle.updated_at.slice(0, 10);
  await store.createVersion(id);

  try {
    const files = {} as Record<BulkType, ManifestFile>;
    for (const type of BULK_TYPES) {
      const entry = entries[type];
      const { body, download } = await client.openBulkStream(entry);
      const name = fileName(type, download.jsonl);
      const bytes = await store.writeStream(id, name, body);
      files[type] = {
        name,
        updated_at: entry.updated_at,
        bytes,
        source_uri: download.uri,
      };
    }

    const manifest: Manifest = {
      version: id,
      snapshot,
      created_at: clock().toISOString(),
      files,
    };
    await store.writeManifest(id, manifest);
  } catch (err) {
    // Keep the failed stage for recovery; the published pointer is untouched.
    throw err instanceof StructuredError
      ? err
      : new StructuredError("UPSTREAM_UNAVAILABLE", "Bulk ingestion failed", {
          reason: err instanceof Error ? err.message : String(err),
        });
  }

  return { version: id, snapshot, skipped: false, files: BULK_TYPES };
}
