/**
 * Addressable read-only resources (spec §2/§4): card://{oracle_id} and
 * deck://{deck_id}. Deck mutations notify subscribers via resourceUpdated.
 *
 * McpServer has no built-in subscribe handling, so we advertise the
 * resources.subscribe capability, track subscribed URIs via Subscribe/Unsubscribe
 * request handlers, and bridge DeckStore.onChange to server.sendResourceUpdated.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { StructuredError } from "../types/index.js";
import type { CardIndex } from "../index/index.js";
import type { DeckStore } from "../deck/index.js";

export interface ResourceDeps {
  index?: CardIndex;
  deckStore?: DeckStore;
}

function firstVar(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** Register card:// and deck:// resources (and deck subscription wiring) on a server. */
export function registerResources(server: McpServer, deps: ResourceDeps): void {
  const { index, deckStore } = deps;

  if (index) {
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
        const card = index.getCard(oracleId);
        if (!card) throw new StructuredError("UNKNOWN_CARD", `unknown oracle_id '${oracleId}'`);
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(card) }],
        };
      },
    );
  }

  if (deckStore) {
    server.server.registerCapabilities({ resources: { subscribe: true } });

    const subscribed = new Set<string>();
    server.server.setRequestHandler(SubscribeRequestSchema, (request) => {
      subscribed.add(request.params.uri);
      return {};
    });
    server.server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
      subscribed.delete(request.params.uri);
      return {};
    });

    server.registerResource(
      "deck",
      new ResourceTemplate("deck://{deck_id}", { list: undefined }),
      { title: "Deck", description: "Current decklist by deck_id.", mimeType: "application/json" },
      (uri, variables) => {
        const deckId = firstVar(variables.deck_id);
        const deck = deckStore.get(deckId);
        if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(deck) }],
        };
      },
    );

    const unsubscribe = deckStore.onChange((deckId) => {
      const uri = `deck://${deckId}`;
      if (subscribed.has(uri)) void server.server.sendResourceUpdated({ uri });
    });
    const previousOnClose = server.server.onclose?.bind(server.server);
    server.server.onclose = () => {
      unsubscribe();
      previousOnClose?.();
    };
  }
}
