/**
 * Addressable read-only resources (spec §2/§4): card://{oracle_id} and
 * deck://{deck_id}. Deck mutations notify subscribers via resourceUpdated.
 *
 * McpServer has no built-in subscribe handling, so we advertise the
 * resources.subscribe capability, track subscribed URIs via Subscribe/Unsubscribe
 * request handlers, and bridge DeckStore.onChange to server.sendResourceUpdated.
 */
import {
  type McpServer,
  ResourceTemplate,
  ProtocolErrorCode,
  ProtocolError,
} from "@modelcontextprotocol/server";
import { StructuredError } from "../types/index.js";
import type { CardIndex } from "../index/index.js";
import type { DeckStore } from "../deck/index.js";
import type { CollectionStore } from "../collection/index.js";

export interface ResourceDeps {
  index?: CardIndex;
  /** Live first-run source; declares resource capabilities before connecting. */
  getIndex?: () => CardIndex | undefined;
  deckStore?: DeckStore;
  collection?: CollectionStore;
  session?: string;
  subscriptions?: boolean;
}

function firstVar(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** Register card:// and deck:// resources (and deck subscription wiring) on a server. */
export function registerResources(server: McpServer, deps: ResourceDeps): void {
  const { index, deckStore, collection, session = "local", subscriptions = true } = deps;

  if (index || deps.getIndex) {
    server.registerResource(
      "card",
      new ResourceTemplate("card://{oracle_id}", { list: undefined }),
      {
        title: "Card",
        description: "Canonical card object by oracle_id.",
        mimeType: "application/json",
      },
      (uri, variables) => {
        const oracleId = firstVar(variables.oracle_id);
        const card = (deps.getIndex?.() ?? index)?.getCard(oracleId);
        if (!card) throw new StructuredError("UNKNOWN_CARD", `unknown oracle_id '${oracleId}'`);
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(card) }],
        };
      },
    );
  }

  if (deckStore) {
    server.registerResource(
      "deck",
      new ResourceTemplate("deck://{deck_id}", { list: undefined }),
      { title: "Deck", description: "Current decklist by deck_id.", mimeType: "application/json" },
      (uri, variables) => {
        const deckId = firstVar(variables.deck_id);
        const deck = deckStore.get(deckId, session);
        if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(deck) }],
        };
      },
    );

    if (subscriptions) {
      server.server.registerCapabilities({ resources: { subscribe: true } });
      const subscribed = new Set<string>();
      server.server.setRequestHandler("resources/subscribe", (request) => {
        const prefix = "deck://";
        const uri = request.params.uri;
        const deckId = uri.startsWith(prefix) ? uri.slice(prefix.length) : "";
        if (!deckId || !deckStore.get(deckId, session)) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown deck resource");
        }
        subscribed.add(uri);
        return {};
      });
      server.server.setRequestHandler("resources/unsubscribe", (request) => {
        subscribed.delete(request.params.uri);
        return {};
      });
      const unsubscribe = deckStore.onChange((deckId, _version, changedSession) => {
        const uri = `deck://${deckId}`;
        // Modern stdio owns subscriptions/listen at the serving entry and
        // filters these notifications there; legacy uses the explicit URI set.
        const modern = server.server.getNegotiatedProtocolVersion() === "2026-07-28";
        if (changedSession === session && (modern || subscribed.has(uri))) {
          // A client may disconnect while a notification is in flight.
          void server.server.sendResourceUpdated({ uri }).catch(() => undefined);
        }
      });
      const previousOnClose = server.server.onclose?.bind(server.server);
      server.server.onclose = () => {
        subscribed.clear();
        unsubscribe();
        previousOnClose?.();
      };
    }
  }

  if (collection) {
    server.registerResource(
      "collection",
      new ResourceTemplate("collection://{session}", { list: undefined }),
      {
        title: "Collection",
        description: "Owned-card collection (oracle_ids) for a session.",
        mimeType: "application/json",
      },
      (uri, variables) => {
        const sessionId = firstVar(variables.session) || "local";
        if (sessionId !== session) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown collection resource");
        }
        const owned = [...collection.get(session)];
        const currentIndex = deps.getIndex?.() ?? index;
        const body = {
          session: sessionId,
          owned_count: owned.length,
          owned,
          ...(currentIndex
            ? {
                cards: owned.map((id) => ({ oracle_id: id, name: currentIndex.getCard(id)?.name })),
              }
            : {}),
        };
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body) }],
        };
      },
    );
  }
}
