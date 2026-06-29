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
  simulateDeck,
  budgetPlan,
  type RoleBands,
  type SimOptions,
  type BudgetOptions,
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

function analyzeCurveTool(store: DeckStore, index: CardIndex, session: string): ToolDefinition {
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
      const deck = store.get(deckId, session);
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

function analyzeCompositionTool(
  store: DeckStore,
  index: CardIndex,
  session: string,
): ToolDefinition {
  return {
    name: "analyze_composition",
    config: {
      title: "Analyze composition",
      description: "Quantity-weighted counts by card type and by functional role for a deck.",
      inputSchema: { deck_id: z.string() },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId, session);
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

function analyzeStatsTool(store: DeckStore, index: CardIndex, session: string): ToolDefinition {
  return {
    name: "analyze_stats",
    config: {
      title: "Analyze stats",
      description:
        "Exact deck stats: card counts, average mana value (overall + nonland), color-pip " +
        "distribution, total USD price (default printings) and min_buy_usd (sum of each " +
        "card's cheapest printing). (EDHREC rank summary is not yet available.)",
      inputSchema: { deck_id: z.string() },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const lookup = (id: string): Card | null => index.getCard(id);
      const result = analyzeStats(deck.cards, lookup);
      return {
        content: [
          {
            type: "text",
            text: `${result.total_cards} cards, avg MV ${result.avg_mv}, $${result.total_price_usd} (min buy $${result.min_buy_usd})`,
          },
        ],
        structuredContent: { deck_id: deckId, ...result },
      };
    },
  };
}

function analyzeManaBaseTool(store: DeckStore, index: CardIndex, session: string): ToolDefinition {
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
      const deck = store.get(deckId, session);
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

function analyzeRoleCoverageTool(
  store: DeckStore,
  index: CardIndex,
  session: string,
): ToolDefinition {
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
      const deck = store.get(deckId, session);
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

function simulateDeckTool(store: DeckStore, index: CardIndex, session: string): ToolDefinition {
  return {
    name: "simulate_deck",
    config: {
      title: "Simulate deck (goldfish)",
      description:
        "Monte Carlo goldfish over N seeded games: opening-hand keepable/mulligan/dead-on-arrival " +
        "rates, average opening lands, lands-by-turn, and turn-to-first-castable-spell. Deterministic " +
        "for a fixed seed. Advisory + mana/curve-focused: it measures hand quality and castability, " +
        "NOT combat, interaction, or expected damage / turn-to-win.",
      inputSchema: {
        deck_id: z.string(),
        trials: z.number().int().positive().max(100000).optional(),
        seed: z.number().int().optional(),
        on_the_play: z.boolean().optional(),
        hand_size: z.number().int().positive().max(20).optional(),
        max_turns: z.number().int().positive().max(50).optional(),
      },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const lookup = (id: string): Card | null => index.getCard(id);
      const opts: SimOptions = {};
      if (typeof args.trials === "number") opts.trials = args.trials;
      if (typeof args.seed === "number") opts.seed = args.seed;
      if (typeof args.on_the_play === "boolean") opts.onThePlay = args.on_the_play;
      if (typeof args.hand_size === "number") opts.handSize = args.hand_size;
      if (typeof args.max_turns === "number") opts.maxTurns = args.max_turns;
      const result = simulateDeck(deck.cards, lookup, opts);
      return {
        content: [
          {
            type: "text",
            text:
              `${result.trials} trials: ${Math.round(result.keepable_rate * 100)}% keepable, ` +
              `${Math.round(result.dead_on_arrival_rate * 100)}% dead-on-arrival, first spell ~T${result.avg_turn_to_first_spell ?? "n/a"}`,
          },
        ],
        structuredContent: { deck_id: deckId, ...result },
      };
    },
  };
}

function budgetPlanTool(store: DeckStore, index: CardIndex, session: string): ToolDefinition {
  return {
    name: "budget_plan",
    config: {
      title: "Budget plan",
      description:
        "Plan a deck toward a price target: default vs min-buy (cheapest-printing) totals, total " +
        "reprint_savings (buy the cheap printing — no deck change), ranked reprint_suggestions, and " +
        "cost_drivers (the priciest cards by cheapest×qty, with roles, to consider cutting). Pass " +
        "target_usd for the over-budget gap. Figures are local-index price floors (conservative for " +
        "bulk commons), advisory only. Functional replacements are a separate concern.",
      inputSchema: {
        deck_id: z.string(),
        target_usd: z.number().nonnegative().optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const lookup = (id: string): Card | null => index.getCard(id);
      const opts: BudgetOptions = {};
      if (typeof args.target_usd === "number") opts.targetUsd = args.target_usd;
      if (typeof args.limit === "number") opts.limit = args.limit;
      const plan = budgetPlan(deck.cards, lookup, opts);
      const gap =
        plan.over_min_buy_by_usd !== null ? `, $${plan.over_min_buy_by_usd} over target` : "";
      return {
        content: [
          {
            type: "text",
            text: `min buy $${plan.min_buy_usd} (default $${plan.default_total_usd}); reprint savings $${plan.reprint_savings_usd}${gap}`,
          },
        ],
        structuredContent: { deck_id: deckId, ...plan },
      };
    },
  };
}

/** Build the deck-analysis tools bound to a DeckStore + CardIndex (both required), scoped to a session. */
export function makeAnalyzeTools(
  store: DeckStore,
  index: CardIndex,
  session = "local",
): ToolDefinition[] {
  return [
    analyzeCurveTool(store, index, session),
    analyzeCompositionTool(store, index, session),
    analyzeStatsTool(store, index, session),
    analyzeManaBaseTool(store, index, session),
    analyzeRoleCoverageTool(store, index, session),
    simulateDeckTool(store, index, session),
    budgetPlanTool(store, index, session),
  ];
}
