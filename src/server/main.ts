#!/usr/bin/env node
/**
 * mtg-edh-mcp — executable entrypoint (bin).
 *
 * Selects a transport and boots the server. Default is stdio (local/desktop
 * agents); set `MCP_TRANSPORT=http` (or pass `--http`) for hosted streamable
 * HTTP. `MCP_HTTP_PORT` / `MCP_HTTP_HOST` configure the HTTP bind.
 */
import { existsSync } from "node:fs";
import { VersionedStore } from "../ingest/index.js";
import { CollectionStore } from "../collection/index.js";
import { CardIndex, DEFAULT_DATA_ROOT, DEFAULT_INDEX_NAME, readSnapshot } from "../index/index.js";
import { DeckStore } from "../deck/index.js";
import { cachedSnapshotProvider, type SnapshotProvider } from "./snapshot.js";
import { startStdio } from "./stdio.js";
import { startHttp } from "./http.js";

function useHttp(argv: readonly string[], env: Record<string, string | undefined>): boolean {
  return env.MCP_TRANSPORT === "http" || argv.includes("--http");
}

interface Boot {
  snapshot: SnapshotProvider;
  index?: CardIndex;
  deckStore: DeckStore;
}

/**
 * Read the real data_snapshot, open the current version's card index (if one has
 * been built), and create the in-memory deck store. When no index exists yet,
 * the card tools + card:// resource are simply not registered (ping still works).
 */
async function boot(): Promise<Boot> {
  const store = new VersionedStore(process.env.MCP_DATA_DIR ?? DEFAULT_DATA_ROOT);
  const snapshot = cachedSnapshotProvider((await readSnapshot(store)) ?? undefined).provider;
  const deckStore = new DeckStore();
  const version = await store.readCurrent();
  if (version) {
    const dbPath = store.filePath(version, DEFAULT_INDEX_NAME);
    if (existsSync(dbPath)) return { snapshot, deckStore, index: CardIndex.open(dbPath) };
  }
  return { snapshot, deckStore };
}

async function main(): Promise<void> {
  const { snapshot, index, deckStore } = await boot();
  if (useHttp(process.argv.slice(2), process.env)) {
    const port = process.env.MCP_HTTP_PORT ? Number(process.env.MCP_HTTP_PORT) : 3000;
    const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
    // Shared across all per-request servers — without this, the stateless HTTP
    // transport gave every POST a fresh empty collection (caught by the GUI's
    // Rust e2e round-trip, which acts as the regression test).
    const collection = new CollectionStore();
    const running = await startHttp({ port, host, snapshot, index, deckStore, collection });
    console.error(`mtg-edh-mcp listening on http://${host}:${running.port} (streamable HTTP)`);
    // Sidecar lifecycle (opt-in): the GUI spawns us with piped stdin; when the
    // GUI dies, stdin closes and we exit — orphan-proof without process groups.
    if (process.env.MCP_WATCH_STDIN === "1") {
      process.stdin.resume();
      process.stdin.on("end", () => process.exit(0));
      process.stdin.on("close", () => process.exit(0));
    }
  } else {
    await startStdio({ snapshot, index, deckStore });
    console.error("mtg-edh-mcp serving on stdio");
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
