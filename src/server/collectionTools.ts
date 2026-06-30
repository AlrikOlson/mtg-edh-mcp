/**
 * Collection tools (spec §12): collection_set / collection_add / collection_get /
 * collection_clear — manage the optional, session-scoped set of cards a user owns.
 *
 * Ownership is membership by oracle_id (no quantities). Inputs accept card names
 * or oracle_ids (resolved leniently); entries that don't resolve to a real card
 * are reported in unresolved[] rather than stored. Off-by-default: nothing in the
 * core build depends on a collection — card_search only consults it when asked.
 */
import { z } from "zod";
import type { CardIndex } from "../index/index.js";
import type { CollectionStore } from "../collection/index.js";
import { resolveCardIdLenient } from "./resolve.js";
import type { ToolDefinition } from "./registry.js";

/** Resolve name-or-id inputs to owned oracle_ids; unresolved entries are reported, not stored. */
function resolveOwned(index: CardIndex, raw: unknown): { ids: string[]; unresolved: string[] } {
  const entries = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  const ids: string[] = [];
  const unresolved: string[] = [];
  for (const entry of entries) {
    const id = resolveCardIdLenient(index, entry);
    if (index.getCard(id)) ids.push(id);
    else unresolved.push(entry);
  }
  return { ids, unresolved };
}

function ownedView(collection: CollectionStore, index: CardIndex, session: string) {
  const owned = [...collection.get(session)];
  return {
    owned_count: owned.length,
    owned,
    cards: owned.map((id) => ({ oracle_id: id, name: index.getCard(id)?.name })),
  };
}

const CARDS_INPUT = z.array(z.string());

function collectionSetTool(
  collection: CollectionStore,
  index: CardIndex,
  session: string,
): ToolDefinition {
  return {
    name: "collection_set",
    config: {
      title: "Set collection",
      description:
        "Replace the owned-card collection with these cards (by oracle_id or name). " +
        "Unresolvable entries are reported in unresolved[]. The collection is optional and " +
        "only used when card_search is called with owned_only:true.",
      inputSchema: { cards: CARDS_INPUT },
    },
    handler: (args) => {
      const { ids, unresolved } = resolveOwned(index, args.cards);
      collection.set(ids, session);
      return {
        content: [{ type: "text", text: `collection set to ${ids.length} card(s)` }],
        structuredContent: { ...ownedView(collection, index, session), unresolved },
      };
    },
  };
}

function collectionAddTool(
  collection: CollectionStore,
  index: CardIndex,
  session: string,
): ToolDefinition {
  return {
    name: "collection_add",
    config: {
      title: "Add to collection",
      description: "Add cards (by oracle_id or name) to the owned-card collection.",
      inputSchema: { cards: CARDS_INPUT },
    },
    handler: (args) => {
      const { ids, unresolved } = resolveOwned(index, args.cards);
      collection.add(ids, session);
      return {
        content: [{ type: "text", text: `added ${ids.length} card(s)` }],
        structuredContent: { ...ownedView(collection, index, session), unresolved },
      };
    },
  };
}

function collectionGetTool(
  collection: CollectionStore,
  index: CardIndex,
  session: string,
): ToolDefinition {
  return {
    name: "collection_get",
    config: {
      title: "Get collection",
      description: "Return the owned-card collection (oracle_ids + names).",
      inputSchema: {},
    },
    handler: () => {
      const view = ownedView(collection, index, session);
      return {
        content: [{ type: "text", text: `${view.owned_count} card(s) owned` }],
        structuredContent: view,
      };
    },
  };
}

function collectionClearTool(collection: CollectionStore, session: string): ToolDefinition {
  return {
    name: "collection_clear",
    config: {
      title: "Clear collection",
      description: "Empty the owned-card collection for this session.",
      inputSchema: {},
    },
    handler: () => {
      collection.clear(session);
      return {
        content: [{ type: "text", text: "collection cleared" }],
        structuredContent: { owned_count: 0, owned: [], cards: [] },
      };
    },
  };
}

/** Build the collection tools bound to a CollectionStore + CardIndex, scoped to a session. */
export function makeCollectionTools(
  collection: CollectionStore,
  index: CardIndex,
  session = "local",
): ToolDefinition[] {
  return [
    collectionSetTool(collection, index, session),
    collectionAddTool(collection, index, session),
    collectionGetTool(collection, index, session),
    collectionClearTool(collection, session),
  ];
}
