/**
 * MCP prompts (ergo-prompts): the deck-building workflows as first-class,
 * server-advertised artifacts. Each prompt returns one user message containing
 * a concrete tool recipe with the caller's arguments interpolated — a client
 * that surfaces prompts gets the whole loop without reading any docs.
 *
 * Prompt texts reference ONLY tools that exist (rot-proofed by
 * prompts.test.ts the same way descriptions.test.ts pins FLOW lines).
 * MCP prompt arguments are strings on the wire; numeric args are documented
 * as numeric strings.
 */
import { z } from "zod";
import type { McpServer, RegisteredPrompt } from "@modelcontextprotocol/server";

/** A data-first prompt definition: config for prompts/list, build() for prompts/get. */
export interface PromptDefinition {
  name: string;
  config: {
    title: string;
    description: string;
    argsSchema: Record<string, z.ZodString | z.ZodOptional<z.ZodString>>;
  };
  build: (args: Record<string, string | undefined>) => string;
}

const CONVENTIONS =
  "Conventions: every card input accepts names (singular or array) — check failed[] on " +
  "each mutation for typos (it carries did-you-mean suggestions) instead of pre-resolving; " +
  "trust the vitals block on every mutation response (card_count/100, lands, identity, " +
  "legality, version) instead of re-reading the deck.";

const buildCommanderDeck: PromptDefinition = {
  name: "build_commander_deck",
  config: {
    title: "Build a Commander deck",
    description:
      "The full build recipe for a new 100-card Commander deck around a commander, " +
      "optionally steered by a theme and a budget (budget_usd, numeric string).",
    argsSchema: {
      commander: z.string().describe("Commander card name, e.g. 'Atraxa, Praetors' Voice'"),
      theme: z.string().optional().describe("Optional theme/archetype, e.g. 'counters'"),
      budget_usd: z.string().optional().describe("Optional budget in USD, e.g. '150'"),
    },
  },
  build: (args) => {
    const theme = args.theme ? ` with a '${args.theme}' theme` : "";
    const budget = args.budget_usd
      ? `\n7. Budget pass (target \u0024${args.budget_usd}): budget_plan with target_usd for ` +
        "zero-change reprint savings, then meta_budget_swaps for out/in replacements until " +
        "budget_plan.full_deck.target_met or meta_budget_swaps.target_met is true with complete price coverage. Disclose unknown/stale price freshness and extra purchase costs."
      : "";
    return (
      `Build a legal 100-card Commander deck around ${args.commander}${theme}.\n\n` +
      "Recipe:\n" +
      `1. deck_create {name} then deck_set_commander {commanders: "${args.commander}"} — by name; the response's computed_color_identity scopes everything after.\n` +
      "2. meta_recommend for local contributions to the actual deck and saved intent; optional provider: 'edhrec' adds separate population metrics. Review interactions, requirements and tradeoffs before adding suggestion oracle_ids.\n" +
      "3. deck_add in batches of 10-20 card NAMES (mixing recommendation ids is fine); read verdicts[] for per-card legality and failed[] for typos.\n" +
      "4. deck_status after each batch — one offline call for count/100, legality, curve, mana coverage, and role gaps; steer the next batch at whatever it flags.\n" +
      "5. Mana pass: analyze_mana_base for under-supported colors, then card_search (t:land plus identity filters) and deck_add basics with {card, qty}.\n" +
      "6. validate_deck for the authoritative gate; deck_export to share." +
      budget +
      `\n\n${CONVENTIONS}`
    );
  },
};

const tuneDeck: PromptDefinition = {
  name: "tune_deck",
  config: {
    title: "Tune an existing deck",
    description: "The tuning loop for an existing deck: find gaps, swap cards, re-check.",
    argsSchema: {
      deck_id: z.string().describe("The deck to tune"),
    },
  },
  build: (args) => {
    return (
      `Tune deck ${args.deck_id}.\n\n` +
      "Recipe:\n" +
      `1. deck_status {deck_id: "${args.deck_id}"} — vitals, legality, curve, mana coverage, and below-band role gaps in one call.\n` +
      "2. For each role gap: meta_recommend for local contextual candidates and tradeoffs, or card_search by role-shaped queries. Explicit rank: 'inclusion' browses EDHREC popularity.\n" +
      "3. Swap: deck_remove the weakest card in the role, deck_add the replacement (names are fine); the vitals on each response track where you stand.\n" +
      "4. deck_status again; repeat until no gaps and legality is clean.\n" +
      "5. meta_classify_bracket for the power-level read after tuning.\n\n" +
      CONVENTIONS
    );
  },
};

const fitBudget: PromptDefinition = {
  name: "fit_budget",
  config: {
    title: "Fit a deck to a budget",
    description:
      "The cost-cutting recipe: reprint savings first (no deck changes), then role-matched swaps.",
    argsSchema: {
      deck_id: z.string().describe("The deck to fit"),
      target_usd: z.string().describe("Target budget in USD, e.g. '100'"),
    },
  },
  build: (args) => {
    return (
      `Fit deck ${args.deck_id} under \u0024${args.target_usd}.\n\n` +
      "Recipe:\n" +
      `1. budget_plan {deck_id: "${args.deck_id}", target_usd: ${args.target_usd}} — reprint_savings_usd costs ZERO deck changes (buy cheaper printings); check full_deck.over_min_buy_by_usd for the remaining gap; full_deck.target_met is unknown when required prices are missing.\n` +
      "2. If still over: meta_budget_swaps with the same target_usd — role-matched cheaper replacements with per-swap savings; apply each via deck_remove + deck_add.\n" +
      "3. deck_status to confirm the deck is still legal and shaped right; price.full_deck.min_buy_usd includes commanders; compare only with complete required coverage and disclose unknown/stale prices. Companion costs are separate; estimates exclude fees, tax and shipping.\n\n" +
      CONVENTIONS
    );
  },
};

/** The advertised prompt catalog. */
export const PROMPT_DEFINITIONS: readonly PromptDefinition[] = [
  buildCommanderDeck,
  tuneDeck,
  fitBudget,
];

/** Register the prompt catalog against the server. */
export function registerPrompts(server: McpServer, enabled = true): RegisteredPrompt[] {
  return PROMPT_DEFINITIONS.map((def) => {
    const registered = server.registerPrompt(
      def.name,
      { ...def.config, argsSchema: z.object(def.config.argsSchema) },
      (args: Record<string, string | undefined>) => ({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: def.build(args ?? {}) },
          },
        ],
      }),
    );
    if (!enabled) registered.disable();
    return registered;
  });
}
