/**
 * Card-knowledge tools (spec §5A): card_search, card_get, card_resolve_name,
 * card_printings — registered through the server's ToolDefinition framework, so
 * each inherits data_snapshot stamping and StructuredError→isError mapping.
 *
 * Built against a CardIndex. `deck_id` scoping for card_search (auto id<={deck_ci}
 * + -in_deck) needs the deck store and is deferred to P3.
 */
import { z } from "zod";
import { parseQuery } from "../query/index.js";
import { CardIndex, type SearchOptions } from "../index/index.js";
import { cheapestUsd, defaultUsd } from "../analyze/index.js";
import { StructuredError } from "../types/index.js";
import type { Card } from "../types/index.js";
import type { CollectionStore } from "../collection/index.js";
import { StringOrStringsSchema, resolveCardId, resolveCardIdLenient } from "./resolve.js";
import type { ToolDefinition } from "./registry.js";

function cardSearchTool(
  index: CardIndex,
  collection?: CollectionStore,
  session = "local",
): ToolDefinition {
  return {
    name: "card_search",
    config: {
      title: "Card search",
      description:
        "Search cards with Scryfall query grammar against the local index.\n" +
        'USE: finding candidates by type/color/cost/text, e.g. "t:instant ci<=wu mv<=2 o:draw". NOT: one known card (card_get); resolving a name (card_resolve_name).\n' +
        "FLOW: deck_status/analyze_role_coverage -> card_search -> deck_add.\n" +
        "ARGS: query (Scryfall grammar); order name|mv|price; limit (max 175); cursor (from next_cursor); owned_only:true restricts to the collection (no-op until collection_set).\n" +
        "RETURNS: results[] lean CardRefs (oracle_id, name, mv, ci, type), total, returned, next_cursor.",
      inputSchema: {
        query: z.string(),
        order: z.enum(["name", "mv", "price"]).optional(),
        limit: z.number().int().positive().max(175).optional(),
        cursor: z.string().optional(),
        owned_only: z.boolean().optional(),
      },
    },
    handler: (args) => {
      const node = parseQuery(String(args.query ?? ""));
      const opts: SearchOptions = {};
      if (typeof args.order === "string") opts.order = args.order;
      if (typeof args.limit === "number") opts.limit = args.limit;
      if (typeof args.cursor === "string") opts.cursor = args.cursor;
      // Opt-in owned-collection filter; only restricts when a non-empty
      // collection exists, so it's identical to today when off/unset.
      if (args.owned_only === true && collection && collection.size(session) > 0) {
        opts.oracleIds = [...collection.get(session)];
      }
      const res = index.evaluate(node, opts);
      return {
        content: [{ type: "text", text: `${res.returned} of ${res.total} cards` }],
        structuredContent: {
          total: res.total,
          returned: res.returned,
          next_cursor: res.nextCursor ?? null,
          results: res.results,
        },
      };
    },
  };
}

function cardGetTool(index: CardIndex): ToolDefinition {
  return {
    name: "card_get",
    config: {
      title: "Card get",
      description:
        "Fetch full Card objects by name or oracle_id, singular or array.\n" +
        "USE: reading oracle text/roles/legality/prices for known cards. NOT: browsing (card_search).\n" +
        "FLOW: card_search/deck_get -> card_get -> deck_add.\n" +
        'ARGS: cards: "Sol Ring" | [names or ids] (oracle_ids is a legacy alias); include_printings:true for the heavy printings[] (default lean: each card carries default_usd + cheapest_usd instead).\n' +
        "RETURNS: cards[] (full Card + pricing), missing[] (unresolvable inputs).",
      inputSchema: {
        cards: StringOrStringsSchema.optional(),
        oracle_ids: StringOrStringsSchema.optional(),
        include_printings: z.boolean().optional(),
      },
    },
    handler: (args) => {
      const raw = args.cards ?? args.oracle_ids;
      const entries =
        typeof raw === "string"
          ? [raw]
          : Array.isArray(raw)
            ? raw.filter((x): x is string => typeof x === "string")
            : [];
      // Accept name-or-id: resolve each entry to an oracle_id (unknown/ambiguous stays
      // as the original string and falls through to missing[] — no wholesale batch throw).
      const ids = entries.map((entry) => resolveCardIdLenient(index, entry));
      const includePrintings = args.include_printings === true;
      const cards: Array<
        Partial<Card> & { default_usd: number | null; cheapest_usd: number | null }
      > = [];
      const missing: string[] = [];
      for (const id of ids) {
        const card = index.getCard(id);
        if (!card) {
          missing.push(id);
          continue;
        }
        const pricing = { default_usd: defaultUsd(card), cheapest_usd: cheapestUsd(card) };
        const lean: Partial<Card> = { ...card };
        if (!includePrintings) delete lean.printings; // omit the heavy array by default
        cards.push({ ...lean, ...pricing });
      }
      return {
        content: [{ type: "text", text: `${cards.length} found, ${missing.length} missing` }],
        structuredContent: { cards, missing },
      };
    },
  };
}

function cardResolveNameTool(index: CardIndex): ToolDefinition {
  return {
    name: "card_resolve_name",
    config: {
      title: "Resolve card name",
      description:
        "Resolve one card name to its canonical oracle_id.\n" +
        "USE: explicit disambiguation when a name may be ambiguous. NOT: routine adds — deck_add and card_get accept names directly.\n" +
        "FLOW: (name in hand) -> card_resolve_name -> deck_add.\n" +
        "ARGS: name; exact:true disables the fuzzy fallback.\n" +
        "RETURNS: oracle_id + lean card. Errors: AMBIGUOUS_NAME carries candidates[]; UNKNOWN_CARD carries did-you-mean suggestions[].",
      inputSchema: { name: z.string(), exact: z.boolean().optional() },
    },
    handler: (args) => {
      const name = String(args.name ?? "");
      const matches = index.resolveName(name, { exact: args.exact === true });
      if (matches.length > 1) {
        throw new StructuredError("AMBIGUOUS_NAME", `'${name}' matched ${matches.length} cards`, {
          candidates: matches,
        });
      }
      const only = matches[0];
      if (!only) {
        throw new StructuredError("UNKNOWN_CARD", `no card named '${name}'`, {
          input: name,
          suggestions: index.suggestNames(name),
        });
      }
      return {
        content: [{ type: "text", text: only.name }],
        structuredContent: { oracle_id: only.oracle_id, card: only },
      };
    },
  };
}

function cardPrintingsTool(index: CardIndex): ToolDefinition {
  return {
    name: "card_printings",
    config: {
      title: "Card printings",
      description:
        "List every printing of a card (set, collector number, prices), newest first.\n" +
        "USE: picking a printing or price-shopping one card. NOT: batch pricing (card_get's default_usd/cheapest_usd).\n" +
        "FLOW: card_get -> card_printings -> (choose printing).\n" +
        "ARGS: card (name or oracle_id; oracle_id is a legacy alias).\n" +
        "RETURNS: oracle_id, printings[].",
      inputSchema: { card: z.string().optional(), oracle_id: z.string().optional() },
    },
    handler: (args) => {
      const raw = String(args.card ?? args.oracle_id ?? "");
      const oracleId = resolveCardId(index, raw);
      const card = index.getCard(oracleId);
      if (!card) throw new StructuredError("UNKNOWN_CARD", `unknown oracle_id '${oracleId}'`);
      return {
        content: [{ type: "text", text: `${card.printings.length} printings` }],
        structuredContent: { oracle_id: oracleId, printings: card.printings },
      };
    },
  };
}

/** Build the four card-knowledge tool definitions bound to a CardIndex (+ optional owned collection). */
export function makeCardTools(
  index: CardIndex,
  collection?: CollectionStore,
  session = "local",
): ToolDefinition[] {
  return [
    cardSearchTool(index, collection, session),
    cardGetTool(index),
    cardResolveNameTool(index),
    cardPrintingsTool(index),
  ];
}
