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
      "Plan a new or partial 100-card Commander deck from a commander, theme, saved deck or empty request; budget_usd is an optional advisory USD target.",
    argsSchema: {
      commander: z.string().optional().describe("Optional commander card name"),
      theme: z.string().optional().describe("Optional theme or playstyle"),
      deck_id: z
        .string()
        .optional()
        .describe("Optional saved partial deck; retains its versioned intent"),
      budget_usd: z.string().optional().describe("Optional advisory USD target, e.g. '150'"),
    },
  },
  build: (args) => {
    const usd = args.budget_usd?.trim() ? Number(args.budget_usd) : undefined;
    const validBudget = usd !== undefined && Number.isFinite(usd) && usd >= 0;
    const normalization = JSON.stringify({
      ...(args.deck_id ? { deck_id: args.deck_id } : {}),
      request: {
        ...(args.commander ? { commanders: [args.commander] } : {}),
        ...(args.theme ? { theme: args.theme } : {}),
        ...(validBudget ? { budget: { mode: "target", usd } } : {}),
      },
    });
    const budget = validBudget
      ? "\n7. Budget pass (target $" +
        usd +
        "): budget_plan with target_usd; a target is preferred, so ask before treating it as a mandatory cap. Check whole-deck complete price coverage and disclose unknown/stale prices and extra purchase costs."
      : args.budget_usd !== undefined
        ? "\nBudget input is invalid; request a finite nonnegative USD amount or an explicit unbounded choice."
        : "";
    const seed = args.deck_id
      ? "Use the saved partial deck and its intent; preserve protected cards and edit bounds."
      : args.commander
        ? "After choices resolve, deck_create {name} then deck_set_commander {commanders: " +
          JSON.stringify(args.commander) +
          "}."
        : "After a command zone is explicitly selected, deck_create {name} then deck_set_commander with that selection.";
    return (
      "Build a legal 100-card Commander deck" +
      (args.theme ? " with a " + JSON.stringify(args.theme) + " theme" : "") +
      ".\n\nRecipe:\n" +
      "0. construction_spec " +
      normalization +
      " before searching or changing cards. Resolve conflict diagnostics and choices; unsupported hard requirements need a supported reformulation or explicit user decision. Never silently relax mandatory constraints.\n" +
      "1. " +
      seed +
      " If no commander is selected, use card_discover mode commanders for theme-based alternatives, present the choices, and rerun construction_spec with the chosen command zone. Do not invent a budget.\n" +
      "2. meta_recommend for local contributions to the actual deck and saved intent; review interactions, requirements and tradeoffs.\n" +
      "3. deck_add in batches of 10-20 card names; inspect failed[] and verdicts[]. Multiple role memberships never create extra physical copies.\n" +
      "4. deck_status after each batch to check count/100, legality, mana and role gaps.\n" +
      "5. analyze_mana_base, then card_search and deck_add for mana needs. Commanders count inside 100; a declared companion stays outside and has separate restrictions and costs.\n" +
      "6. validate_deck and meta_check_policy for final checks; budget_plan for costs; deck_export to share." +
      budget +
      "\n\n" +
      CONVENTIONS
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
