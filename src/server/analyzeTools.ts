/**
 * Deck analysis tools (spec §5D): analyze_curve, analyze_composition,
 * analyze_stats. Exact, quantity-weighted aggregates over a deck — they exist
 * because LLMs miscount. Each resolves the deck via the store and card data via
 * the index, then calls the pure analyzers (src/analyze). Advisory only.
 */
import { z } from "zod";
import { StructuredError } from "../types/index.js";
import type { Card, Color, Role } from "../types/index.js";
import type { CardIndex } from "../index/index.js";
import type { DeckStore } from "../deck/index.js";
import {
  analyzeCurve,
  analyzeComposition,
  analyzeStats,
  analyzeManaBase,
  analyzeRoleCoverage,
  type RoleBands,
} from "../analyze/index.js";
import type { ToolDefinition } from "./registry.js";

const ROLE_ENUM = [
  "ramp",
  "mana_rock",
  "mana_dork",
  "land",
  "fixing",
  "card_draw",
  "card_advantage",
  "tutor",
  "spot_removal",
  "board_wipe",
  "counterspell",
  "protection",
  "recursion",
  "graveyard_hate",
  "stax",
  "combo_piece",
  "payoff",
  "wincon",
  "utility",
] as const;
const COLOR_ENUM = ["W", "U", "B", "R", "G"] as const;

function analyzeCurveTool(store: DeckStore, index: CardIndex): ToolDefinition {
  return {
    name: "analyze_curve",
    config: {
      title: "Analyze mana curve",
      description:
        "Quantity-weighted mana-value histogram for a deck (buckets 0..6, 7+). Optional " +
        "filters: exclude_lands, role, color.",
      inputSchema: {
        deck_id: z.string(),
        exclude_lands: z.boolean().optional(),
        role: z.enum(ROLE_ENUM).optional(),
        color: z.enum(COLOR_ENUM).optional(),
      },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const lookup = (id: string): Card | null => index.getCard(id);
      const result = analyzeCurve(deck.cards, lookup, {
        exclude_lands: args.exclude_lands === true,
        role: typeof args.role === "string" ? (args.role as Role) : undefined,
        color: typeof args.color === "string" ? (args.color as Color) : undefined,
      });
      return {
        content: [
          {
            type: "text",
            text: `${result.total} cards across ${Object.keys(result.buckets).length} buckets`,
          },
        ],
        structuredContent: { deck_id: deckId, ...result },
      };
    },
  };
}

function analyzeCompositionTool(store: DeckStore, index: CardIndex): ToolDefinition {
  return {
    name: "analyze_composition",
    config: {
      title: "Analyze composition",
      description: "Quantity-weighted counts by card type and by functional role for a deck.",
      inputSchema: { deck_id: z.string() },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const lookup = (id: string): Card | null => index.getCard(id);
      const result = analyzeComposition(deck.cards, lookup);
      return {
        content: [{ type: "text", text: `${result.total} cards` }],
        structuredContent: { deck_id: deckId, ...result },
      };
    },
  };
}

function analyzeStatsTool(store: DeckStore, index: CardIndex): ToolDefinition {
  return {
    name: "analyze_stats",
    config: {
      title: "Analyze stats",
      description:
        "Exact deck stats: card counts, average mana value (overall + nonland), color-pip " +
        "distribution, and total USD price. (EDHREC rank summary is not yet available.)",
      inputSchema: { deck_id: z.string() },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const lookup = (id: string): Card | null => index.getCard(id);
      const result = analyzeStats(deck.cards, lookup);
      return {
        content: [
          {
            type: "text",
            text: `${result.total_cards} cards, avg MV ${result.avg_mv}, $${result.total_price_usd}`,
          },
        ],
        structuredContent: { deck_id: deckId, ...result },
      };
    },
  };
}

function analyzeManaBaseTool(store: DeckStore, index: CardIndex): ToolDefinition {
  return {
    name: "analyze_mana_base",
    config: {
      title: "Analyze mana base",
      description:
        "Per-color source counts (lands + mana rocks/dorks), tapped vs untapped land split, " +
        "fixing density, and which of the deck's colors look under-supported. 'Any color' " +
        "sources count toward each color in the deck's identity.",
      inputSchema: { deck_id: z.string(), threshold: z.number().int().positive().optional() },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const lookup = (id: string): Card | null => index.getCard(id);
      const report = analyzeManaBase(deck.cards, lookup, {
        identity: deck.computed_color_identity,
        threshold: typeof args.threshold === "number" ? args.threshold : undefined,
      });
      return {
        content: [
          {
            type: "text",
            text: `${report.total_lands} lands; under-supported: ${report.under_supported.join("") || "none"}`,
          },
        ],
        structuredContent: { deck_id: deckId, ...report },
      };
    },
  };
}

function analyzeRoleCoverageTool(store: DeckStore, index: CardIndex): ToolDefinition {
  return {
    name: "analyze_role_coverage",
    config: {
      title: "Analyze role coverage",
      description:
        "Quantity-weighted functional-role counts vs target bands, reporting under/ok/over " +
        "gaps. Bands are configurable; sensible Commander defaults are used otherwise. " +
        "Advisory only — this does not feed validate_deck.",
      inputSchema: {
        deck_id: z.string(),
        bands: z.record(z.string(), z.object({ min: z.number(), max: z.number() })).optional(),
      },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const lookup = (id: string): Card | null => index.getCard(id);
      const bands =
        args.bands && typeof args.bands === "object" ? (args.bands as RoleBands) : undefined;
      const result = analyzeRoleCoverage(deck.cards, lookup, bands);
      const under = result.gaps.filter((g) => g.status === "under").length;
      return {
        content: [{ type: "text", text: `${under} role(s) under target` }],
        structuredContent: { deck_id: deckId, ...result },
      };
    },
  };
}

/** Build the deck-analysis tools bound to a DeckStore + CardIndex (both required). */
export function makeAnalyzeTools(store: DeckStore, index: CardIndex): ToolDefinition[] {
  return [
    analyzeCurveTool(store, index),
    analyzeCompositionTool(store, index),
    analyzeStatsTool(store, index),
    analyzeManaBaseTool(store, index),
    analyzeRoleCoverageTool(store, index),
  ];
}
