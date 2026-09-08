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
import { normalizeStrings, resolveCardIdLenient } from "./resolve.js";
import { READS_LOCAL, mutates } from "./registry.js";
import type { ToolDefinition } from "./registry.js";

/** Resolve name-or-id inputs to owned oracle_ids; unresolved entries are reported, not stored. */
function resolveOwned(index: CardIndex, raw: unknown): { ids: string[]; unresolved: string[] } {
  const entries = normalizeStrings(raw).filter((x): x is string => typeof x === "string");
  const ids: string[] = [];
  const unresolved: string[] = [];
  for (const entry of entries) {
    const id = resolveCardIdLenient(index, entry);
    if (index.getCard(id)) ids.push(id);
    else unresolved.push(entry);
  }
  return { ids, unresolved };
}

/** Mutation-echo view of the collection, capped at the page limit (total is exact). */
function ownedView(collection: CollectionStore, index: CardIndex, session: string) {
  const owned = [...collection.get(session)];
  const page = owned.slice(0, COLLECTION_PAGE_LIMIT);
  return {
    owned_count: owned.length,
    total: owned.length,
    owned: page,
    cards: page.map((id) => ({ oracle_id: id, name: index.getCard(id)?.name })),
  };
}

const CARDS_INPUT = z.union([z.string(), z.array(z.string())]);

const COLLECTION_PAGE_LIMIT = 200;

function collectionSetTool(
  collection: CollectionStore,
  index: CardIndex,
  session: string,
): ToolDefinition {
  return {
    name: "collection_set",
    config: {
      annotations: mutates({ destructive: true, idempotent: true }),
      title: "Set collection",
      description:
        "Replace the owned-card collection.\n" +
        "USE: loading what the user owns before ownership-aware search or budgeting. NOT: adding a few cards (collection_add).\n" +
        "FLOW: (owned list) -> collection_set -> card_search (owned_only) / budget_plan (use_collection).\n" +
        "ARGS: cards: name-or-id, single string or array.\n" +
        "RETURNS: owned_count, total, owned[]/cards[] (echo capped at 200), unresolved[]. Session-scoped; persisted by the server.",
      inputSchema: { cards: CARDS_INPUT },
    },
    handler: (args) => {
      const { ids, unresolved } = resolveOwned(index, args.cards);
      collection.set(ids, session);
      return {
        content: [{ type: "text", text: `collection set to ${ids.length} card(s)` }],
        structuredContent: {
          ...ownedView(collection, index, session),
          unresolved,
        },
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
      annotations: mutates({ destructive: false, idempotent: true }),
      title: "Add to collection",
      description:
        "Add cards to the owned-card collection.\n" +
        "USE: growing the owned set incrementally. NOT: replacing it wholesale (collection_set).\n" +
        "FLOW: collection_get -> collection_add -> card_search (owned_only).\n" +
        "ARGS: cards: name-or-id, single string or array.\n" +
        "RETURNS: owned_count, total, owned[]/cards[] (echo capped at 200), unresolved[].",
      inputSchema: { cards: CARDS_INPUT },
    },
    handler: (args) => {
      const { ids, unresolved } = resolveOwned(index, args.cards);
      collection.add(ids, session);
      return {
        content: [{ type: "text", text: `added ${ids.length} card(s)` }],
        structuredContent: {
          ...ownedView(collection, index, session),
          unresolved,
        },
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
      annotations: READS_LOCAL,
      title: "Get collection",
      description:
        "Read the owned-card collection, paginated.\n" +
        "USE: reviewing what's loaded. NOT: ownership-filtered search (card_search owned_only).\n" +
        "FLOW: collection_set -> collection_get -> (page with cursor).\n" +
        "ARGS: limit (default 200); cursor (from next_cursor).\n" +
        "RETURNS: owned[]/cards[] page, total (exact), next_cursor.",
      inputSchema: {
        limit: z.number().int().positive().max(1000).optional(),
        cursor: z.string().optional(),
      },
    },
    handler: (args) => {
      const limit = typeof args.limit === "number" ? args.limit : COLLECTION_PAGE_LIMIT;
      const offset =
        typeof args.cursor === "string" && /^\d+$/.test(args.cursor) ? Number(args.cursor) : 0;
      const owned = [...collection.get(session)];
      const page = owned.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return {
        content: [
          {
            type: "text",
            text: `${page.length} of ${owned.length} owned card(s)`,
          },
        ],
        structuredContent: {
          owned_count: page.length,
          total: owned.length,
          next_cursor: nextOffset < owned.length ? String(nextOffset) : null,
          owned: page,
          cards: page.map((id) => ({
            oracle_id: id,
            name: index.getCard(id)?.name,
          })),
        },
      };
    },
  };
}

function collectionClearTool(collection: CollectionStore, session: string): ToolDefinition {
  return {
    name: "collection_clear",
    config: {
      annotations: mutates({ destructive: true, idempotent: true }),
      title: "Clear collection",
      description:
        "Empty the owned-card collection for this session.\n" +
        "USE: starting ownership tracking over. NOT: swapping in a new list (collection_set replaces in one call).\n" +
        "FLOW: collection_get -> collection_clear -> collection_set.\n" +
        "ARGS: none.\n" +
        "RETURNS: owned_count 0.",
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
  ].map((def) => {
    if (def.config.annotations?.readOnlyHint !== false) return def;
    return {
      ...def,
      handler: (args, extra) => collection.transaction(() => def.handler(args, extra)),
    };
  });
}
