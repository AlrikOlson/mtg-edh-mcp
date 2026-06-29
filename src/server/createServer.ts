/**
 * Server core assembly (spec §2).
 *
 * Builds an {@link McpServer}, registers the built-in tools plus any extras
 * through the registration framework (so every tool inherits data_snapshot
 * stamping + structured-error mapping), and returns it ready to `connect` to a
 * transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CardIndex } from "../index/index.js";
import type { DeckStore } from "../deck/index.js";
import { CacheStore, EdhrecClient, SpellbookClient, GameChangersClient } from "../meta/index.js";
import { registerTools, type ToolDefinition } from "./registry.js";
import { staticSnapshotProvider, type SnapshotProvider } from "./snapshot.js";
import { BUILTIN_TOOLS } from "./tools.js";
import { makeCardTools } from "./cardTools.js";
import { makeDeckTools } from "./deckTools.js";
import { makeValidateTools } from "./validateTools.js";
import { makeAnalyzeTools } from "./analyzeTools.js";
import { makeMetaTools } from "./metaTools.js";
import { registerResources } from "./resources.js";

export const SERVER_NAME = "mtg-edh-mcp";
export const SERVER_VERSION = "0.0.0";

export interface CreateServerOptions {
  /** Supplies the data_snapshot stamped on every response. Defaults to a placeholder. */
  snapshot?: SnapshotProvider;
  /** When provided, the card-knowledge tools (§5A) + card:// resource use it. */
  index?: CardIndex;
  /** When provided, the deck:// resource + subscription updates use it. */
  deckStore?: DeckStore;
  /** EDHREC enrichment client (tests inject one with a fake fetcher). Default-constructed. */
  edhrec?: EdhrecClient;
  /** Commander Spellbook combo client (tests inject one with a fake fetcher). Default-constructed. */
  spellbook?: SpellbookClient;
  /** Game Changers list client for bracket classification (tests inject a fake). Default-constructed. */
  gameChangers?: GameChangersClient;
  /** Extra tools to register alongside the built-ins (used by tests + later engines). */
  tools?: readonly ToolDefinition[];
}

/** Construct a fully wired (but not yet connected) MCP server. */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const snapshot = options.snapshot ?? staticSnapshotProvider();
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  // Resources (capabilities) must be registered before the transport connects.
  registerResources(server, { index: options.index, deckStore: options.deckStore });
  const cardTools = options.index ? makeCardTools(options.index) : [];
  const deckTools = options.deckStore
    ? makeDeckTools(options.deckStore, options.index, snapshot)
    : [];
  // Validation tools need both a deck store (to read decks) and an index (to look up cards).
  const validateTools =
    options.deckStore && options.index ? makeValidateTools(options.deckStore, options.index) : [];
  const analyzeTools =
    options.deckStore && options.index ? makeAnalyzeTools(options.deckStore, options.index) : [];
  // Enrichment needs the index (name resolution) + deck store (deck context).
  const edhrec = options.edhrec ?? new EdhrecClient(new CacheStore());
  const spellbook = options.spellbook ?? new SpellbookClient(new CacheStore());
  const gameChangers = options.gameChangers ?? new GameChangersClient(new CacheStore());
  const metaTools =
    options.deckStore && options.index
      ? makeMetaTools(options.deckStore, options.index, edhrec, spellbook, gameChangers)
      : [];
  registerTools(
    server,
    [
      ...BUILTIN_TOOLS,
      ...cardTools,
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
