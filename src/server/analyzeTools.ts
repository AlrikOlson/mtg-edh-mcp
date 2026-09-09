/**
 * Deck analysis tools (spec §5D): analyze_curve, analyze_composition,
 * analyze_stats. Exact, quantity-weighted aggregates over a deck — they exist
 * because LLMs miscount. Each resolves the deck via the store and card data via
 * the index, then calls the pure analyzers (src/analyze). Advisory only.
 */
import { z } from "zod";
import { effectiveRoleTargets } from "../deck/intent.js";
import { wholeDeckBudget } from "../analyze/budget.js";
import { analyzeStrategy } from "../analyze/strategy.js";
import { manaModelOverrideSchema, modelDeckMana } from "../analyze/manaModel.js";
import { staticSnapshotProvider, type SnapshotProvider } from "./snapshot.js";
import { ROLES, StructuredError } from "../types/index.js";
import { deckRoleLookup, deckRoleProvenance } from "../analyze/deckRoles.js";
import type { Card, Color, Role } from "../types/index.js";
import type { CardIndex } from "../index/index.js";
import type { DeckStore } from "../deck/index.js";
import type { CollectionStore } from "../collection/index.js";
import {
  analyzeCurve,
  analyzeComposition,
  analyzeStats,
  analyzeManaBase,
  analyzeRoleCoverage,
  simulateDeck,
  type RoleBands,
  type SimOptions,
  type BudgetOptions,
} from "../analyze/index.js";
import { validateCore, validateCommander, validateCompanion } from "../validate/index.js";
import { deckVitals, formatVitals } from "./vitals.js";
import { READS_LOCAL } from "./registry.js";
import type { ToolDefinition } from "./registry.js";

/** Offline strategy evidence is scoped to a saved deck and never mutates it. */
function analyzeStrategyTool(store: DeckStore, index: CardIndex, session: string): ToolDefinition {
  return {
    name: "analyze_strategy",
    config: {
      annotations: READS_LOCAL,
      title: "Analyze deck strategy",
      description:
        "Explain supported engines and dependencies in the actual deck.\n" +
        "USE: game plans, fragile support and deliberate niche builds. NOT: legality (validate_deck) or provider combo evidence (meta_combos).\n" +
        "FLOW: deck_get_intent -> analyze_strategy -> card_discover.\n" +
        "ARGS: deck_id; expected_version optionally checks the read.\n" +
        "RETURNS: nodes, edges with Oracle evidence, dependencies, bottlenecks, redundancy, recovery_options, conflicts, win_condition_requirements, game_plan, declared_intent, coverage, deck_version. Conditional advisory catalog; unknown interactions stay explicit; no win rates.",
      inputSchema: {
        deck_id: z.string().min(1),
        expected_version: z.number().int().nonnegative().optional(),
      },
    },
    handler: (args) => {
      const deck = store.get(String(args.deck_id), session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${args.deck_id}'`);
      if (typeof args.expected_version === "number" && args.expected_version !== deck.version) {
        return {
          content: [{ type: "text", text: "Deck version conflict" }],
          structuredContent: {
            ok: false,
            conflict: true,
            deck_id: deck.deck_id,
            expected_version: args.expected_version,
            current_version: deck.version,
          },
        };
      }
      const report = analyzeStrategy(deck, (id) => index.getCard(id));
      return {
        content: [
          {
            type: "text",
            text: `${deck.name}: ${report.edges.length} candidate support links; inspect requirements and coverage before planning.`,
          },
        ],
        structuredContent: { ok: true, ...report },
      };
    },
  };
}

const COLOR_ENUM = ["W", "U", "B", "R", "G"] as const;

/** Omit recommendation lists from zone summaries and general statistics. */
function budgetReport(budget: ReturnType<typeof wholeDeckBudget>, detailed = false) {
  const summarize = (plan: typeof budget.full_deck) => ({
    default_total_usd: plan.default_total_usd,
    min_buy_usd: plan.min_buy_usd,
    acquire_usd: plan.acquire_usd,
    owned_value_usd: plan.owned_value_usd,
    target_usd: plan.target_usd,
    target_met: plan.target_met,
    acquire_target_met: plan.acquire_target_met,
    over_min_buy_by_usd: plan.over_min_buy_by_usd,
    over_acquire_by_usd: plan.over_acquire_by_usd,
    minor_units: plan.minor_units,
    coverage: plan.coverage,
    pricing: plan.pricing,
    freshness: plan.freshness,
    ownership_basis: plan.ownership_basis,
  });
  return {
    library: summarize(budget.library),
    command_zone: summarize(budget.command_zone),
    full_deck: detailed ? budget.full_deck : summarize(budget.full_deck),
    companion: summarize(budget.companion),
    scope: budget.scope,
  };
}

function budgetSummary(budget: ReturnType<typeof wholeDeckBudget>): string {
  const full = budget.full_deck;
  const acquire =
    full.acquire_usd === null
      ? ""
      : `; estimated new spending USD ${full.acquire_usd} (collection membership covers all copies)`;
  return (
    `full-deck estimated value USD ${full.default_total_usd}, cheapest-printing estimate USD ${full.min_buy_usd}` +
    ` (library ${budget.library.min_buy_usd}, command zone ${budget.command_zone.min_buy_usd}); companion ${budget.companion.min_buy_usd} separate` +
    `${full.coverage.complete ? "" : "; incomplete price coverage — known subtotals only"}${acquire}; price freshness ${full.freshness.status}; excludes fees, tax and shipping`
  );
}

function analyzeCurveTool(store: DeckStore, index: CardIndex, session: string): ToolDefinition {
  return {
    name: "analyze_curve",
    config: {
      annotations: READS_LOCAL,
      title: "Analyze mana curve",
      description:
        "Compute the deck's quantity-weighted mana-value histogram.\n" +
        "USE: curve-shape questions, incl. filtered views by role/color. NOT: the one-call overview (deck_status includes the curve).\n" +
        "FLOW: deck_status -> analyze_curve -> deck_remove.\n" +
        "ARGS: deck_id; exclude_lands; role (functional role); color W|U|B|R|G.\n" +
        "RETURNS: buckets {0..6, 7+}, total.",
      inputSchema: {
        deck_id: z.string(),
        exclude_lands: z.boolean().optional(),
        role: z.enum(ROLES).optional(),
        color: z.enum(COLOR_ENUM).optional(),
      },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const lookup = deckRoleLookup(deck, (id) => index.getCard(id));
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
        structuredContent: {
          deck_id: deckId,
          ...result,
          ...deckRoleProvenance(deck),
        },
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
      annotations: READS_LOCAL,
      title: "Analyze composition",
      description:
        "Count deck cards by card type and functional role, quantity-weighted.\n" +
        "USE: type/role breakdowns. NOT: gaps vs target bands (analyze_role_coverage).\n" +
        "FLOW: deck_status -> analyze_composition -> card_search.\n" +
        "ARGS: deck_id.\n" +
        "RETURNS: by_type, by_role, total.",
      inputSchema: { deck_id: z.string() },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const lookup = deckRoleLookup(deck, (id) => index.getCard(id));
      const result = analyzeComposition(deck.cards, lookup);
      return {
        content: [{ type: "text", text: `${result.total} cards` }],
        structuredContent: {
          deck_id: deckId,
          ...result,
          ...deckRoleProvenance(deck),
        },
      };
    },
  };
}

function analyzeStatsTool(
  store: DeckStore,
  index: CardIndex,
  session: string,
  snapshot: SnapshotProvider,
): ToolDefinition {
  return {
    name: "analyze_stats",
    config: {
      annotations: READS_LOCAL,
      title: "Analyze stats",
      description:
        "Compute exact deck stats: counts, average mana value, color pips, prices.\n" +
        "USE: precise numbers for tuning (LLMs miscount — this doesn't). NOT: the one-call overview (deck_status).\n" +
        "FLOW: deck_status -> analyze_stats -> budget_plan.\n" +
        "ARGS: deck_id.\n" +
        "RETURNS: total_cards, nonland_cards, avg_mv, avg_mv_nonland, color_pips, total_price_usd and min_buy_usd (library compatibility); budget.full_deck, command_zone, companion and coverage. USD estimates exclude fees, tax and shipping.",
      inputSchema: { deck_id: z.string() },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const lookup = (id: string): Card | null => index.getCard(id);
      const result = analyzeStats(deck.cards, lookup);
      const budget = wholeDeckBudget(deck, lookup, {
        dataSnapshot: snapshot(),
        limit: 0,
      });
      return {
        content: [
          {
            type: "text",
            text: `${result.total_cards} library cards, avg MV ${result.avg_mv}; ${budgetSummary(budget)}`,
          },
        ],
        structuredContent: {
          deck_id: deckId,
          version: deck.version,
          ...result,
          price_scope: "library",
          budget: budgetReport(budget),
        },
      };
    },
  };
}

function analyzeManaBaseTool(store: DeckStore, index: CardIndex, session: string): ToolDefinition {
  return {
    name: "analyze_mana_base",
    config: {
      annotations: READS_LOCAL,
      title: "Analyze mana base",
      description:
        "Inspect supported mana costs, source alternatives, conditions and quantity coverage.\n" +
        "USE: mana-base planning with per-card evidence and explicit uncertainty. NOT: castability or sequencing probabilities.\n" +
        "FLOW: deck_status -> analyze_mana_base -> card_search (t:land).\n" +
        "ARGS: deck_id; threshold (heuristic source floor, default 10); expected_version; overrides (bounded per-face assumptions, reason required).\n" +
        "RETURNS: mana_model (library), command_zone_mana_model, deck_version; costs, source choices and supported/unsupported/unresolved/overridden quantities. Existing source/land counts have summary_basis=legacy_heuristic; they do not prove simultaneous mana or availability.",
      inputSchema: {
        deck_id: z.string(),
        threshold: z.number().int().positive().optional(),
        expected_version: z.number().int().nonnegative().optional(),
        overrides: z.array(manaModelOverrideSchema).max(200).optional(),
      },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const lookup = (id: string): Card | null => index.getCard(id);
      if (typeof args.expected_version === "number" && args.expected_version !== deck.version) {
        return {
          content: [{ type: "text", text: "Deck version conflict" }],
          structuredContent: {
            ok: false,
            conflict: true,
            deck_id: deckId,
            expected_version: args.expected_version,
            current_version: deck.version,
          },
        };
      }
      const overrides = z
        .array(manaModelOverrideSchema)
        .max(200)
        .parse(args.overrides ?? []);
      const options = { identity: deck.computed_color_identity, overrides };
      const report = analyzeManaBase(deck.cards, lookup, {
        ...options,
        threshold: typeof args.threshold === "number" ? args.threshold : undefined,
      });
      const commandZone = modelDeckMana(
        deck.commanders.map((oracle_id) => ({ oracle_id, qty: 1 })),
        lookup,
        options,
      );
      return {
        content: [
          {
            type: "text",
            text: `${report.total_lands} heuristic lands; mana model: ${report.mana_model.coverage.supported_quantity} supported, ${report.mana_model.coverage.unsupported_quantity} unsupported, ${report.mana_model.coverage.unresolved_quantity} unresolved, ${report.mana_model.coverage.overridden_quantity} assumed library cards. Source counts do not prove payment or availability.`,
          },
        ],
        structuredContent: {
          deck_id: deckId,
          deck_version: deck.version,
          ...report,
          command_zone_mana_model: commandZone,
          companion_scope: "outside companion excluded from library and command-zone models",
        },
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
      annotations: READS_LOCAL,
      title: "Analyze role coverage",
      description:
        "Compare functional-role counts against target bands (under/ok/over).\n" +
        "USE: finding what the deck lacks (ramp, draw, removal...). NOT: EDHREC suggestions (meta_recommend).\n" +
        "FLOW: deck_status -> analyze_role_coverage -> card_search.\n" +
        "ARGS: deck_id; bands {role: {min, max}} (saved intent over Commander defaults otherwise).\n" +
        "RETURNS: gaps[] {role, have, want_min, want_max, status}. Advisory — never feeds validate_deck.",
      inputSchema: {
        deck_id: z.string(),
        bands: z.record(z.string(), z.object({ min: z.number(), max: z.number() })).optional(),
      },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const lookup = deckRoleLookup(deck, (id) => index.getCard(id));
      const bands =
        args.bands && typeof args.bands === "object"
          ? (args.bands as RoleBands)
          : effectiveRoleTargets(deck);
      const result = analyzeRoleCoverage(deck.cards, lookup, bands);
      const under = result.gaps.filter((g) => g.status === "under").length;
      return {
        content: [{ type: "text", text: `${under} role(s) under target` }],
        structuredContent: {
          deck_id: deckId,
          ...result,
          ...deckRoleProvenance(deck),
        },
      };
    },
  };
}

/** Cap for the violations echoed by deck_status (full counts always reported). */
const STATUS_ERROR_CAP = 20;

function deckStatusTool(
  store: DeckStore,
  index: CardIndex,
  session: string,
  snapshot: SnapshotProvider,
): ToolDefinition {
  return {
    name: "deck_status",
    config: {
      annotations: READS_LOCAL,
      title: "Deck status (one-call dashboard)",
      description:
        "Report the deck's full standing in one offline call.\n" +
        "USE: orient after edits. NOT: power bracket (meta_classify_bracket) or the full card list (deck_get).\n" +
        "FLOW: deck_add/deck_import -> deck_status -> card_search/meta_recommend.\n" +
        "ARGS: deck_id.\n" +
        "RETURNS: vitals (card_count/100, land_count, color_identity, legal, version); legality (errors capped at " +
        `${STATUS_ERROR_CAP}, exact error_count/warning_count); curve (buckets, avg_mv); mana (sources_by_color, ` +
        "under_supported, summary_basis=legacy_heuristic, model_coverage for library; details in analyze_mana_base); roles (below-band gaps); price (total_usd/min_buy_usd library compatibility; full_deck, command_zone, companion and price coverage).",
      inputSchema: { deck_id: z.string() },
      // Preserve the existing no-outputSchema contract; see card_search.
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const lookup = (id: string): Card | null => index.getCard(id);

      const vitals = deckVitals(deck, index);
      const violations = [
        ...validateCore(deck, lookup),
        ...validateCommander(deck, lookup),
        ...validateCompanion(deck, lookup),
      ];
      const errors = violations.filter((v) => v.severity === "error");
      const warnings = violations.filter((v) => v.severity === "warning");
      const curve = analyzeCurve(deck.cards, lookup);
      const stats = analyzeStats(deck.cards, lookup);
      const budget = wholeDeckBudget(deck, lookup, {
        dataSnapshot: snapshot(),
        limit: 0,
      });
      const mana = analyzeManaBase(deck.cards, lookup, {
        identity: deck.computed_color_identity,
      });
      const coverage = analyzeRoleCoverage(
        deck.cards,
        deckRoleLookup(deck, lookup),
        effectiveRoleTargets(deck),
      );
      const gaps = coverage.gaps.filter((g) => g.status === "under");

      const gapNote =
        gaps.length > 0
          ? `gaps: ${gaps.map((g) => `${g.role} ${g.have}/${g.want_min}`).join(", ")}`
          : "no role gaps";
      return {
        content: [
          {
            type: "text",
            text:
              `${deck.name} — ${formatVitals(vitals)}\n` +
              `curve avg ${stats.avg_mv} (nonland ${stats.avg_mv_nonland}); heuristic mana under-supported: ${
                mana.under_supported.join("") || "none"
              }\n` +
              `${gapNote}; ${budgetSummary(budget)}`,
          },
        ],
        structuredContent: {
          deck_id: deckId,
          name: deck.name,
          version: deck.version,
          vitals,
          legality: {
            ok: errors.length === 0,
            errors: errors.slice(0, STATUS_ERROR_CAP),
            error_count: errors.length,
            warning_count: warnings.length,
          },
          curve: {
            buckets: curve.buckets,
            avg_mv: stats.avg_mv,
            avg_mv_nonland: stats.avg_mv_nonland,
          },
          mana: {
            sources_by_color: mana.sources,
            under_supported: mana.under_supported,
            summary_basis: mana.summary_basis,
            model_scope: mana.model_scope,
            model_coverage: mana.mana_model.coverage,
          },
          roles: { gaps, ...deckRoleProvenance(deck) },
          price: {
            total_usd: stats.total_price_usd,
            min_buy_usd: stats.min_buy_usd,
            price_scope: "library",
            ...budgetReport(budget),
          },
        },
      };
    },
  };
}

function simulateDeckTool(store: DeckStore, index: CardIndex, session: string): ToolDefinition {
  return {
    name: "simulate_deck",
    config: {
      annotations: READS_LOCAL,
      title: "Simulate deck (goldfish)",
      description:
        "Goldfish the deck: Monte Carlo opening hands and early turns, deterministic per seed.\n" +
        "USE: keepable/mulligan rates and opening-hand SHAPES (mulligan-guide material). NOT: combat, interaction, turn-to-win; land counts (analyze_mana_base).\n" +
        "FLOW: deck_status -> simulate_deck -> analyze_mana_base.\n" +
        "ARGS: deck_id; trials (max 100000); seed (fixed seed = identical results); on_the_play; hand_size; max_turns.\n" +
        "RETURNS: keepable_rate, dead_on_arrival_rate, opening_land_distribution, scenarios " +
        "(hand-shape rates from type lines + roles: textbook, land_light_mulligan, " +
        "two_lands_no_accel_mulligan, lean_and_accelerated, explosive, top_heavy_trap, " +
        "playable_no_accel, flood), lands-by-turn.",
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
      const lookup = deckRoleLookup(deck, (id) => index.getCard(id));
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
        structuredContent: {
          deck_id: deckId,
          ...result,
          ...deckRoleProvenance(deck),
        },
      };
    },
  };
}

function budgetPlanTool(
  store: DeckStore,
  index: CardIndex,
  session: string,
  collection: CollectionStore | undefined,
  snapshot: SnapshotProvider,
): ToolDefinition {
  return {
    name: "budget_plan",
    config: {
      annotations: READS_LOCAL,
      title: "Budget plan",
      description:
        "Plan the deck toward a price target with zero card changes.\n" +
        "USE: reprint savings, cost drivers, over-budget gap, acquire cost vs the owned collection. NOT: replacement suggestions (meta_budget_swaps).\n" +
        "FLOW: analyze_stats -> budget_plan -> meta_budget_swaps.\n" +
        "ARGS: deck_id; target_usd; limit (max 100); use_collection:true for acquire_usd (needs collection_set).\n" +
        "RETURNS: full_deck (library + commanders), library, command_zone, companion (separate), coverage and freshness. Top-level min_buy_usd/default_total_usd/acquire_usd retain library scope; use full_deck.target_met and full_deck.acquire_usd. USD estimates exclude fees, tax and shipping; collection membership covers all copies.",
      inputSchema: {
        deck_id: z.string(),
        target_usd: z.number().nonnegative().optional(),
        limit: z.number().int().positive().max(100).optional(),
        use_collection: z.boolean().optional(),
      },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const lookup = deckRoleLookup(deck, (id) => index.getCard(id));
      const opts: BudgetOptions = { dataSnapshot: snapshot() };
      if (typeof args.target_usd === "number") opts.targetUsd = args.target_usd;
      if (typeof args.limit === "number") opts.limit = args.limit;
      // Opt-in collection awareness: zero out cards already owned in this session.
      if (args.use_collection === true && collection && collection.size(session) > 0) {
        opts.owned = collection.get(session);
      }
      const budget = wholeDeckBudget(deck, lookup, opts);
      const full = budget.full_deck;
      const gap =
        full.target_usd === null
          ? ""
          : full.target_met === null
            ? "; full-deck target unknown"
            : `; full-deck estimated gap ${full.over_min_buy_by_usd}`;
      return {
        content: [
          {
            type: "text",
            text: `${budgetSummary(budget)}${gap}`,
          },
        ],
        structuredContent: {
          deck_id: deckId,
          version: deck.version,
          ...budget.library,
          price_scope: "library",
          ...budgetReport(budget, true),
          ...deckRoleProvenance(deck),
        },
      };
    },
  };
}

/** Build the deck-analysis tools bound to a DeckStore + CardIndex (both required), scoped to a session. */
export function makeAnalyzeTools(
  store: DeckStore,
  index: CardIndex,
  session = "local",
  collection?: CollectionStore,
  snapshot: SnapshotProvider = staticSnapshotProvider(),
): ToolDefinition[] {
  return [
    analyzeStrategyTool(store, index, session),
    analyzeCurveTool(store, index, session),
    analyzeCompositionTool(store, index, session),
    analyzeStatsTool(store, index, session, snapshot),
    analyzeManaBaseTool(store, index, session),
    analyzeRoleCoverageTool(store, index, session),
    deckStatusTool(store, index, session, snapshot),
    simulateDeckTool(store, index, session),
    budgetPlanTool(store, index, session, collection, snapshot),
  ];
}
