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
import { BulkClient, VersionedStore } from "../ingest/index.js";
import { DEFAULT_DATA_ROOT } from "../index/index.js";
import { refreshSnapshot } from "../index/refresh.js";

async function main(): Promise<void> {
  const root = process.env.MCP_DATA_DIR ?? DEFAULT_DATA_ROOT;
  const force = process.argv.slice(2).includes("--force");
  const store = new VersionedStore(root);
  const client = new BulkClient();

  console.error(`Ingesting Scryfall bulk data into ${root} ...`);
  const result = await refreshSnapshot({
    store,
    client,
    force,
    onPhase: (phase) => {
      if (phase === "build")
        console.error("Building and validating the staged SQLite + FTS index ...");
    },
  });
  console.error(
    result.skipped
      ? `Up to date: reused ${result.cards} cards (snapshot ${result.snapshot}); no rebuild.`
      : `Done: ${result.cards} cards, ${result.printings} printings → ${result.dbPath} (snapshot ${result.snapshot}).`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
