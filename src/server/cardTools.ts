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
import { resolveCardIdLenient } from "./resolve.js";
import type { ToolDefinition } from "./registry.js";

function cardSearchTool(index: CardIndex): ToolDefinition {
  return {
    name: "card_search",
    config: {
      title: "Card search",
      description:
        "Evaluate a Scryfall-grammar query against the local index. Returns lean CardRefs " +
        "(oracle_id, name, mv, ci, type) with total/returned and an opaque next_cursor.",
      inputSchema: {
        query: z.string(),
        order: z.enum(["name", "mv", "price"]).optional(),
        limit: z.number().int().positive().max(175).optional(),
        cursor: z.string().optional(),
      },
    },
    handler: (args) => {
      const node = parseQuery(String(args.query ?? ""));
      const opts: SearchOptions = {};
      if (typeof args.order === "string") opts.order = args.order;
      if (typeof args.limit === "number") opts.limit = args.limit;
      if (typeof args.cursor === "string") opts.cursor = args.cursor;
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
        "Fetch Card objects by oracle_id OR card name (batch). Unresolvable entries are " +
        "reported in missing[]. Lean by default: the full printings[] array is omitted (it " +
        "can overflow large batches) — each card instead carries default_usd (chosen " +
        "printing's price) and cheapest_usd (floor across all printings) for budget-aware " +
        "decisions. Set include_printings:true for the full printings array (or use " +
        "card_printings for one card).",
      inputSchema: { oracle_ids: z.array(z.string()), include_printings: z.boolean().optional() },
    },
    handler: (args) => {
      const raw = args.oracle_ids;
      // Accept name-or-id: resolve each entry to an oracle_id (unknown/ambiguous stays
      // as the original string and falls through to missing[] — no wholesale batch throw).
      const ids = (
        Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []
      ).map((entry) => resolveCardIdLenient(index, entry));
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
        "Resolve a card name to an oracle_id (the anti-hallucination gateway). " +
        "Ambiguous names return AMBIGUOUS_NAME with candidates; unknown names return UNKNOWN_CARD.",
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
      if (!only) throw new StructuredError("UNKNOWN_CARD", `no card named '${name}'`);
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
      description: "All printings (set, collector number, prices) for an oracle_id.",
      inputSchema: { oracle_id: z.string() },
    },
    handler: (args) => {
      const oracleId = String(args.oracle_id ?? "");
      const card = index.getCard(oracleId);
      if (!card) throw new StructuredError("UNKNOWN_CARD", `unknown oracle_id '${oracleId}'`);
      return {
        content: [{ type: "text", text: `${card.printings.length} printings` }],
        structuredContent: { oracle_id: oracleId, printings: card.printings },
      };
    },
  };
}

/** Build the four card-knowledge tool definitions bound to a CardIndex. */
export function makeCardTools(index: CardIndex): ToolDefinition[] {
  return [
    cardSearchTool(index),
    cardGetTool(index),
    cardResolveNameTool(index),
    cardPrintingsTool(index),
  ];
}
