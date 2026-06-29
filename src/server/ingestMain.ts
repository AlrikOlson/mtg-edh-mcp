#!/usr/bin/env node
/**
 * mtg-edh-mcp — one-shot data ingestion CLI (`npm run ingest`).
 *
 * Downloads the Scryfall `oracle_cards` + `default_cards` bulk exports into the
 * versioned store (idempotent on upstream `updated_at`), then builds the local
 * SQLite + FTS card index the server reads. Run this once before first use, and
 * again whenever you want fresher card data. Honors `MCP_DATA_DIR`.
 *
 * Pass `--force` to re-download even when upstream is unchanged.
 */
import { BulkClient, ingestBulk, VersionedStore } from "../ingest/index.js";
import { buildIndex, DEFAULT_DATA_ROOT } from "../index/index.js";

async function main(): Promise<void> {
  const root = process.env.MCP_DATA_DIR ?? DEFAULT_DATA_ROOT;
  const force = process.argv.slice(2).includes("--force");
  const store = new VersionedStore(root);
  const client = new BulkClient();

  console.error(`Ingesting Scryfall bulk data into ${root} ...`);
  const ingest = await ingestBulk({ store, client, force });
  if (ingest.skipped) {
    console.error(`Up to date (snapshot ${ingest.snapshot}); building index if needed.`);
  } else {
    console.error(`Downloaded snapshot ${ingest.snapshot} (version ${ingest.version}).`);
  }

  console.error("Building local card index (SQLite + FTS) ...");
  const built = await buildIndex({ store, version: ingest.version });
  console.error(
    `Done: ${built.cards} cards, ${built.printings} printings → ${built.dbPath} (snapshot ${ingest.snapshot}).`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
