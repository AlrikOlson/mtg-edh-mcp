/**
 * Freshness, price refresh & snapshot provenance (spec §3/§11).
 *
 * - `readSnapshot` resolves the data_snapshot (ISO date) from the current
 *   version's manifest — the value stamped on every tool response.
 * - `refreshPrices` re-downloads default_cards and UPDATEs only the printings
 *   prices in the existing index, with no rebuild of the cards table or FTS.
 * - `FreshnessConfig` makes the bulk (~12h) and price (~daily) cadence
 *   configurable; the operational scheduler consumes it.
 */
import { rm } from "node:fs/promises";
import Database from "better-sqlite3";
import { BulkClient, VersionedStore, streamCardArray } from "../ingest/index.js";
import { StructuredError } from "../types/index.js";
import { DEFAULT_INDEX_NAME } from "./cardIndex.js";
import { extractPrinting, type ScryfallCardRaw } from "./map.js";

type Db = InstanceType<typeof Database>;

/** Default on-disk root for the versioned card store. */
export const DEFAULT_DATA_ROOT = "data/cards";

/** Resolve the data_snapshot (ISO date) of a version, or null if none exists. */
export async function readSnapshot(
  store: VersionedStore,
  version?: string,
): Promise<string | null> {
  const resolved = version ?? (await store.readCurrent());
  if (!resolved) return null;
  const manifest = await store.readManifest(resolved);
  return manifest?.snapshot ?? null;
}

/** Refresh cadence (spec §3): bulk every ~12h, prices ~daily. */
export interface FreshnessConfig {
  bulkIntervalMs: number;
  priceIntervalMs: number;
}

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_FRESHNESS: FreshnessConfig = {
  bulkIntervalMs: TWELVE_HOURS_MS,
  priceIntervalMs: ONE_DAY_MS,
};

/** Build a FreshnessConfig from env (MCP_BULK_INTERVAL_MS / MCP_PRICE_INTERVAL_MS). */
export function freshnessConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): FreshnessConfig {
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    bulkIntervalMs: num(env.MCP_BULK_INTERVAL_MS, DEFAULT_FRESHNESS.bulkIntervalMs),
    priceIntervalMs: num(env.MCP_PRICE_INTERVAL_MS, DEFAULT_FRESHNESS.priceIntervalMs),
  };
}

export interface RefreshPricesOptions {
  store: VersionedStore;
  client: BulkClient;
  /** Version to refresh; defaults to the store's current published version. */
  version?: string;
  /** Index file name within the version dir (default index.sqlite). */
  dbName?: string;
}

export interface RefreshPricesResult {
  version: string;
  /** Number of printing rows whose prices changed. */
  updated: number;
}

/**
 * Price-only refresh: update the printings table's prices from a fresh
 * default_cards download, leaving the cards table + FTS index untouched. Note:
 * oracle-level Card.prices is refreshed on a full bulk rebuild, not here.
 */
export async function refreshPrices(options: RefreshPricesOptions): Promise<RefreshPricesResult> {
  const { store, client, dbName = DEFAULT_INDEX_NAME } = options;
  const version = options.version ?? (await store.readCurrent());
  if (!version) {
    throw new Error("refreshPrices: no version specified and the store has no current version");
  }

  // Stream the fresh default_cards to a temp file alongside the index.
  const entry = await client.getEntry("default_cards");
  const { body, download } = await client.openBulkStream(entry);
  const tmpName = download.jsonl ? "default_cards.refresh.jsonl" : "default_cards.refresh.json";
  await store.writeStream(version, tmpName, body);
  const tmpPath = store.filePath(version, tmpName);

  const db: Db = new Database(store.filePath(version, dbName));
  let updated = 0;
  try {
    const update: Database.Statement<[string, string, string]> = db.prepare(
      "UPDATE printings SET prices = ? WHERE oracle_id = ? AND scryfall_id = ?",
    );
    db.exec("BEGIN");
    for await (const raw of streamCardArray<ScryfallCardRaw>(tmpPath)) {
      const printing = extractPrinting(raw);
      if (!printing) continue;
      const result = update.run(printing.prices, printing.oracle_id, printing.scryfall_id);
      updated += result.changes;
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // no active transaction
    }
    throw err instanceof StructuredError
      ? err
      : new StructuredError("UPSTREAM_UNAVAILABLE", "Price refresh failed", {
          reason: err instanceof Error ? err.message : String(err),
        });
  } finally {
    db.close();
    await rm(tmpPath, { force: true });
  }

  return { version, updated };
}
