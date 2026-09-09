#!/usr/bin/env node
/**
 * mtg-edh-mcp — executable entrypoint (bin).
 *
 * Selects a transport and boots the server. Default is stdio (local/desktop
 * agents); set `MCP_TRANSPORT=http` (or pass `--http`) for hosted streamable
 * HTTP. `MCP_HTTP_PORT` / `MCP_HTTP_HOST` configure the HTTP bind.
 */
import { fileURLToPath } from "node:url";
import { VersionedStore } from "../ingest/index.js";
import { DEFAULT_DATA_ROOT, freshnessConfigFromEnv } from "../index/index.js";
import { UserDataStore } from "../storage/userData.js";
import { RulesService, RulesStore } from "../rules/index.js";
import { openCardData } from "./cardData.js";
import { autoRefreshDisabled, startScheduler } from "./scheduler.js";
import { startStdio } from "./stdio.js";
import { startHttp } from "./http.js";
import { CLI_HELP, parseCli } from "./cli.js";
import { SERVER_VERSION } from "./createServer.js";
import { runDoctor, runSetup } from "./setup.js";

/**
 * Read the real data_snapshot, open the current version's card index (if one has
 * been built), and open the transactional user-data store. When no index exists yet,
 * indexed tools activate when the first ingestion succeeds (ping still works).
 */
async function boot() {
  const root = process.env.MCP_DATA_DIR ?? DEFAULT_DATA_ROOT;
  const store = new VersionedStore(root);
  const userData = new UserDataStore(root);
  try {
    const data = await openCardData(store);
    // The rules corpus is read from disk only; rules_refresh is the network path.
    const rules = new RulesService(new RulesStore(root));
    await rules.load();
    process.once("exit", () => userData.close());
    return {
      rules,
      cardData: data,
      snapshot: data.snapshot,
      ingest: data.ingest,
      staleness: data.staleness,
      bulkAge: data.bulkAge,
      deckStore: userData.deckStore,
      collection: userData.collection,
      store,
    };
  } catch (error) {
    userData.close();
    throw error;
  }
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
  if (config.mode === "setup" || config.mode === "doctor") {
    const options = {
      env: process.env,
      executable: process.execPath,
      entrypoint: fileURLToPath(import.meta.url),
    };
    const report = config.mode === "setup" ? await runSetup(options) : await runDoctor(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.exitCode;
    return;
  }
  if (config.mode === "restore-user-data") {
    const root = process.env.MCP_DATA_DIR ?? DEFAULT_DATA_ROOT;
    const result = UserDataStore.restore(root, config.backupPath);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const {
    snapshot: cachedSnapshot,
    cardData,
    deckStore,
    collection,
    store,
    ingest,
    staleness,
    bulkAge,
    rules,
  } = await boot();
  const snapshot = cachedSnapshot.provider;
  const freshness = freshnessConfigFromEnv();

  // Freshness scheduler (spec §3): staleness check now + every bulk interval.
  // Idempotent upstream check; opt out with MCP_AUTO_REFRESH=0.
  if (!autoRefreshDisabled()) {
    await startScheduler({ runner: ingest, store, config: freshness, bulkAge });
  }
  if (config.transport === "http") {
    const { port, host } = config;
    const running = await startHttp({
      port,
      host,
      snapshot,
      cardData,
      deckStore,
      collection,
      ingest,
      staleness,
      rules,
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
    await startStdio({
      snapshot,
      cardData,
      deckStore,
      collection,
      ingest,
      staleness,
      rules,
    });
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
