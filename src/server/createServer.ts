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
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/server";
import type { CardIndex } from "../index/index.js";
import type { DeckStore } from "../deck/index.js";
import { CollectionStore } from "../collection/index.js";
import { CacheStore, EdhrecClient, SpellbookClient, GameChangersClient } from "../meta/index.js";
import { registerTool, registerTools, type ToolDefinition } from "./registry.js";
import { staticSnapshotProvider, type SnapshotProvider } from "./snapshot.js";
import { BUILTIN_TOOLS } from "./tools.js";
import { makeCardTools } from "./cardTools.js";
import { makeMechanicsTools } from "./mechanicsTools.js";
import { makeCollectionTools } from "./collectionTools.js";
import { makeDeckTools } from "./deckTools.js";
import { makeValidateTools } from "./validateTools.js";
import { makeAnalyzeTools } from "./analyzeTools.js";
import { makeMetaTools } from "./metaTools.js";
import { IngestRunner, makeDataTools, type StalenessProvider } from "./dataTools.js";
import { makeCardRulingsTools, makeRulesTools } from "./rulesTools.js";
import { RulesService, RulesStore } from "../rules/index.js";
import { DEFAULT_DATA_ROOT } from "../index/index.js";
import type { CardDataSource } from "./cardData.js";
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
  /** Shared live source: installs first-ingest capabilities without restarting. */
  cardData?: CardDataSource;
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
  /**
   * Shared rules/rulings corpus behind rules_* and card_rulings. Like the
   * ingest runner, HTTP mode MUST pass one instance across per-request servers.
   * Default-constructed (unloaded, `unavailable`) so the tools always exist.
   */
  rules?: RulesService;
}

/** Construct a fully wired (but not yet connected) MCP server. */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const snapshot = options.snapshot ?? staticSnapshotProvider();
  const session = options.session ?? "local";
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const source = options.cardData;
  const index = source ? source.index : options.index;
  const collection = options.collection ?? new CollectionStore();
  const edhrec = options.edhrec ?? new EdhrecClient(new CacheStore());
  const spellbook = options.spellbook ?? new SpellbookClient(new CacheStore());
  const gameChangers = options.gameChangers ?? new GameChangersClient(new CacheStore());
  const rules =
    options.rules ??
    new RulesService(new RulesStore(process.env.MCP_DATA_DIR ?? DEFAULT_DATA_ROOT));

  // SDK capabilities cannot first be registered after a transport connects.
  // Resource templates read the live source; workflow prompts stay disabled
  // until their indexed tools have been installed.
  registerResources(server, {
    index,
    getIndex: source ? () => source.index : undefined,
    deckStore: options.deckStore,
    collection: index || source ? collection : undefined,
    session,
    subscriptions: options.resourceSubscriptions,
  });
  const prompts =
    options.deckStore && (index || source) ? registerPrompts(server, Boolean(index)) : [];
  const deckTools = options.deckStore
    ? makeDeckTools(options.deckStore, index, snapshot, session)
    : [];
  const indexedTools = (current: CardIndex): ToolDefinition[] => [
    ...makeCardTools(current, collection, session),
    ...makeMechanicsTools(current, options.deckStore, session),
    ...makeCardRulingsTools(rules, current),
    ...makeCollectionTools(collection, current, session),
    ...(options.deckStore
      ? [
          ...makeValidateTools(options.deckStore, current, session),
          ...makeAnalyzeTools(options.deckStore, current, session, collection, snapshot),
          ...makeMetaTools(
            options.deckStore,
            current,
            edhrec,
            spellbook,
            gameChangers,
            session,
            snapshot,
          ),
        ]
      : []),
  ];
  const dataTools = makeDataTools({
    hasIndex: () => Boolean(source ? source.index : index),
    runner: options.ingest ?? new IngestRunner(),
    staleness: options.staleness,
  });
  registerTools(
    server,
    [
      ...BUILTIN_TOOLS,
      ...dataTools,
      ...makeRulesTools(rules),
      ...deckTools,
      ...(index ? indexedTools(index) : []),
      ...(options.tools ?? []),
    ],
    snapshot,
  );

  if (source && !index) {
    const unsubscribe = source.onReady((firstIndex) => {
      const registered: RegisteredTool[] = [];
      try {
        const replacements = options.deckStore
          ? makeDeckTools(options.deckStore, firstIndex, snapshot, session)
          : [];
        // Prepare every fallible SDK registration before publishing the snapshot.
        // Calls are behind the snapshot barrier; disabled tools stay out of lists.
        for (const def of indexedTools(firstIndex)) {
          const handle = registerTool(server, def, snapshot);
          registered.push(handle);
          handle.disable();
        }
        return {
          commit() {
            // Registry wrappers read these definition objects at invocation time.
            // Keep the original registered deck tools, now bound to the live index.
            // makeDeckTools always returns the same fixed catalog in the same
            // order, with or without an index, so both entries exist at every i.
            for (let i = 0; i < deckTools.length; i += 1) {
              deckTools[i]!.handler = replacements[i]!.handler;
            }
            for (const handle of registered) handle.enable();
            for (const prompt of prompts) prompt.enable();
          },
          dispose() {
            for (const handle of registered) handle.remove();
          },
        };
      } catch (error) {
        for (const handle of registered) handle.remove();
        throw error;
      }
    });
    // Stateless HTTP creates one server per request, so closed requests must
    // never retain a subscription in the shared source while ingest runs.
    const previousOnClose = server.server.onclose?.bind(server.server);
    server.server.onclose = () => {
      unsubscribe();
      previousOnClose?.();
    };
  }
  return server;
}
