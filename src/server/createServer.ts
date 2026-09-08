/**
 * Server core assembly (spec §2).
 *
 * Builds an {@link McpServer}, registers the built-in tools plus any extras
 * through the registration framework (so every tool inherits data_snapshot
 * stamping + structured-error mapping), and returns it ready to `connect` to a
 * transport.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CardIndex } from "../index/index.js";
import type { DeckStore } from "../deck/index.js";
import { CollectionStore } from "../collection/index.js";
import { CacheStore, EdhrecClient, SpellbookClient, GameChangersClient } from "../meta/index.js";
import { registerTools, type ToolDefinition } from "./registry.js";
import { staticSnapshotProvider, type SnapshotProvider } from "./snapshot.js";
import { BUILTIN_TOOLS } from "./tools.js";
import { makeCardTools } from "./cardTools.js";
import { makeCollectionTools } from "./collectionTools.js";
import { makeDeckTools } from "./deckTools.js";
import { makeValidateTools } from "./validateTools.js";
import { makeAnalyzeTools } from "./analyzeTools.js";
import { makeMetaTools } from "./metaTools.js";
import { IngestRunner, makeDataTools, type StalenessProvider } from "./dataTools.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

export const SERVER_NAME = "mtg-edh-mcp";

/**
 * Resolve the package version for serverInfo by walking up from this module to
 * the nearest package.json that names this package — works from src/ (dev,
 * vitest) and from the bundled dist/ alike. Falls back to 0.0.0 only if the
 * package.json is genuinely unreachable.
 */
function readPackageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === SERVER_NAME && typeof pkg.version === "string") return pkg.version;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

export const SERVER_VERSION = readPackageVersion();

export interface CreateServerOptions {
  /** Supplies the data_snapshot stamped on every response. Defaults to a placeholder. */
  snapshot?: SnapshotProvider;
  /** When provided, the card-knowledge tools (§5A) + card:// resource use it. */
  index?: CardIndex;
  /** When provided, the deck:// resource + subscription updates use it. */
  deckStore?: DeckStore;
  /** Owned-card collection (spec §12); default-constructed so the collection_* tools always exist. */
  collection?: CollectionStore;
  /** EDHREC enrichment client (tests inject one with a fake fetcher). Default-constructed. */
  edhrec?: EdhrecClient;
  /** Commander Spellbook combo client (tests inject one with a fake fetcher). Default-constructed. */
  spellbook?: SpellbookClient;
  /** Game Changers list client for bracket classification (tests inject a fake). Default-constructed. */
  gameChangers?: GameChangersClient;
  /**
   * Principal/session key that scopes deck state (spec §2/§11). Decks are isolated
   * per session in the shared {@link DeckStore}; card data stays shared read-only.
   * The HTTP transport resolves this per request from a principal header; stdio
   * (and tests without a session) use the single default "local" session.
   */
  session?: string;
  /** Resource subscriptions require a persistent transport; disabled for stateless HTTP. */
  resourceSubscriptions?: boolean;
  /** Extra tools to register alongside the built-ins (used by tests + later engines). */
  tools?: readonly ToolDefinition[];
  /**
   * Shared ingest runner behind data_status/data_ingest. Like {@link CollectionStore},
   * HTTP mode MUST pass one instance shared across per-request servers, or every
   * poll would see a fresh idle runner. Default-constructed so the tools always exist.
   */
  ingest?: IngestRunner;
  /** When provided, data_status reports bulk-data age + a stale flag. */
  staleness?: StalenessProvider;
}

/** Construct a fully wired (but not yet connected) MCP server. */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const snapshot = options.snapshot ?? staticSnapshotProvider();
  // Per-principal deck scope; card data is shared read-only across sessions.
  const session = options.session ?? "local";
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  // Optional owned-card collection (spec §12); off by default — card_search only
  // consults it on owned_only. Default-constructed so collection_* always exist.
  const collection = options.collection ?? new CollectionStore();
  // Resources (capabilities) must be registered before the transport connects.
  registerResources(server, {
    index: options.index,
    deckStore: options.deckStore,
    collection: options.index ? collection : undefined,
    session,
    subscriptions: options.resourceSubscriptions,
  });
  // Workflow prompts (ergo-prompts): only meaningful when decks can be built.
  if (options.index && options.deckStore) {
    registerPrompts(server);
  }
  const cardTools = options.index ? makeCardTools(options.index, collection, session) : [];
  const collectionTools = options.index
    ? makeCollectionTools(collection, options.index, session)
    : [];
  const deckTools = options.deckStore
    ? makeDeckTools(options.deckStore, options.index, snapshot, session)
    : [];
  // Validation tools need both a deck store (to read decks) and an index (to look up cards).
  const validateTools =
    options.deckStore && options.index
      ? makeValidateTools(options.deckStore, options.index, session)
      : [];
  const analyzeTools =
    options.deckStore && options.index
      ? makeAnalyzeTools(options.deckStore, options.index, session, collection)
      : [];
  // Enrichment needs the index (name resolution) + deck store (deck context).
  const edhrec = options.edhrec ?? new EdhrecClient(new CacheStore());
  const spellbook = options.spellbook ?? new SpellbookClient(new CacheStore());
  const gameChangers = options.gameChangers ?? new GameChangersClient(new CacheStore());
  const metaTools =
    options.deckStore && options.index
      ? makeMetaTools(options.deckStore, options.index, edhrec, spellbook, gameChangers, session)
      : [];
  // Data-lifecycle tools are registered unconditionally — they are the path OUT
  // of the no-index state, so they cannot be gated on the index existing.
  const dataTools = makeDataTools({
    hasIndex: Boolean(options.index),
    runner: options.ingest ?? new IngestRunner(),
    staleness: options.staleness,
  });
  registerTools(
    server,
    [
      ...BUILTIN_TOOLS,
      ...dataTools,
      ...cardTools,
      ...collectionTools,
      ...deckTools,
      ...validateTools,
      ...analyzeTools,
      ...metaTools,
      ...(options.tools ?? []),
    ],
    snapshot,
  );
  return server;
}
