#!/usr/bin/env node
/**
 * mtg-edh-mcp — executable entrypoint (bin).
 *
 * Selects a transport and boots the server. Default is stdio (local/desktop
 * agents); set `MCP_TRANSPORT=http` (or pass `--http`) for hosted streamable
 * HTTP. `MCP_HTTP_PORT` / `MCP_HTTP_HOST` configure the HTTP bind.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VersionedStore } from "../ingest/index.js";
import { CollectionStore } from "../collection/index.js";
import {
  CardIndex,
  DEFAULT_DATA_ROOT,
  DEFAULT_INDEX_NAME,
  freshnessConfigFromEnv,
  readSnapshot,
} from "../index/index.js";
import { DeckPersister, DeckStore } from "../deck/index.js";
import { cachedSnapshotProvider, type CachedSnapshotProvider } from "./snapshot.js";
import { IngestRunner, type StalenessProvider } from "./dataTools.js";
import { autoRefreshDisabled, bulkAgeMs, startScheduler } from "./scheduler.js";
import { startStdio } from "./stdio.js";
import { startHttp } from "./http.js";
import { CLI_HELP, parseCli } from "./cli.js";
import { SERVER_VERSION } from "./createServer.js";

interface Boot {
  snapshot: CachedSnapshotProvider;
  index?: CardIndex;
  deckStore: DeckStore;
  store: VersionedStore;
}

/**
 * Read the real data_snapshot, open the current version's card index (if one has
 * been built), and create the in-memory deck store. When no index exists yet,
 * the card tools + card:// resource are simply not registered (ping still works).
 */
async function boot(): Promise<Boot> {
  const root = process.env.MCP_DATA_DIR ?? DEFAULT_DATA_ROOT;
  const store = new VersionedStore(root);
  const snapshot = cachedSnapshotProvider((await readSnapshot(store)) ?? undefined);
  const deckStore = new DeckStore();
  // Deck durability (release-deck-persistence): load persisted decks, then
  // write-through on every mutation. One persister on the ONE shared store.
  new DeckPersister(join(root, "decks.json")).attach(deckStore);
  const version = await store.readCurrent();
  if (version) {
    const dbPath = store.filePath(version, DEFAULT_INDEX_NAME);
    if (existsSync(dbPath)) return { snapshot, deckStore, store, index: CardIndex.open(dbPath) };
  }
  return { snapshot, deckStore, store };
}

async function main(): Promise<void> {
  const config = parseCli(process.argv.slice(2), process.env);
  if (config.mode === "help") {
    process.stdout.write(CLI_HELP);
    return;
  }
  if (config.mode === "version") {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  const { snapshot: cachedSnapshot, index, deckStore, store } = await boot();
  const snapshot = cachedSnapshot.provider;
  // One process-wide ingest runner: shared across per-request servers in HTTP
  // mode (same rule as CollectionStore) so polls see the real run state.
  const ingest = new IngestRunner();
  const freshness = freshnessConfigFromEnv();

  // Hot-swap: after any successful ingest (scheduler- or tool-triggered),
  // re-point the open CardIndex + the data_snapshot stamp at the new version.
  // Only possible when we booted WITH an index — the tool closures hold it; a
  // first-ever ingest still needs a reconnect to register the card tools.
  ingest.onSuccess((status) => {
    void (async () => {
      try {
        const version = await store.readCurrent();
        if (!version) return;
        if (index) index.reopen(store.filePath(version, DEFAULT_INDEX_NAME));
        if (status.snapshot) cachedSnapshot.set(status.snapshot);
        console.error(`hot-swapped onto snapshot ${status.snapshot ?? "?"} (${version})`);
      } catch (err) {
        console.error("index hot-swap failed:", err instanceof Error ? err.message : err);
      }
    })();
  });

  // data_status staleness: bulk age vs the configured refresh interval.
  const staleness: StalenessProvider = async () => {
    const age = await bulkAgeMs(store, Date.now());
    return {
      bulk_age_hours: age === null ? null : Math.round((age / 3_600_000) * 10) / 10,
      stale: age !== null && age >= freshness.bulkIntervalMs,
    };
  };

  // Freshness scheduler (spec §3): staleness check now + every bulk interval.
  // Idempotent upstream check; opt out with MCP_AUTO_REFRESH=0.
  if (!autoRefreshDisabled()) {
    await startScheduler({ runner: ingest, store, config: freshness });
  }
  if (config.transport === "http") {
    const { port, host } = config;
    // Shared across all per-request servers — without this, the stateless HTTP
    // transport gave every POST a fresh empty collection (caught by the GUI's
    // Rust e2e round-trip, which acts as the regression test).
    const collection = new CollectionStore();
    const running = await startHttp({
      port,
      host,
      snapshot,
      index,
      deckStore,
      collection,
      ingest,
      staleness,
    });
    console.error(
      `mtg-edh-mcp listening on http://${host.includes(":") ? `[${host}]` : host}:${running.port}/mcp (streamable HTTP)`,
    );
    // Sidecar lifecycle (opt-in): the GUI spawns us with piped stdin; when the
    // GUI dies, stdin closes and we exit — orphan-proof without process groups.
    if (process.env.MCP_WATCH_STDIN === "1") {
      process.stdin.resume();
      process.stdin.on("end", () => process.exit(0));
      process.stdin.on("close", () => process.exit(0));
    }
  } else {
    await startStdio({ snapshot, index, deckStore, ingest, staleness });
    console.error("mtg-edh-mcp serving on stdio");
    // A closed stdin means the client (and the transport) is gone; exit even if
    // background timers would otherwise keep the event loop alive — orphan-proof.
    process.stdin.on("end", () => process.exit(0));
    process.stdin.on("close", () => process.exit(0));
  }
}

main().catch((err: unknown) => {
  console.error(`mtg-edh-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
