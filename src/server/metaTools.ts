/**
 * EDHREC enrichment tools (spec §5E): meta_commander_profile, meta_themes,
 * meta_recommendations. Each reads EDHREC via an injected {@link EdhrecClient}
 * (cached + degrading through the CacheStore), and meta_recommendations grounds
 * the suggestions against the deck — resolving names to oracle_ids, filtering to
 * the deck's color identity, excluding cards already in the deck.
 */
import { z } from "zod";
import { StructuredError } from "../types/index.js";
import type { Role } from "../types/index.js";
import type { CardIndex } from "../index/index.js";
import type { DeckStore } from "../deck/index.js";
import { cheapestUsd } from "../analyze/index.js";
import type { EdhrecClient, SpellbookClient, GameChangersClient } from "../meta/index.js";
import { classifyBracket } from "../meta/index.js";
import type { ToolDefinition } from "./registry.js";

const round2 = (n: number): number => Math.round(n * 100) / 100;

function metaCommanderProfileTool(edhrec: EdhrecClient): ToolDefinition {
  return {
    name: "meta_commander_profile",
    config: {
      title: "Commander profile (EDHREC)",
      description:
        "EDHREC average-deck profile for a commander: top cards by category with inclusion " +
        "and synergy, plus themes. Live data via EDHREC, cached; degrades when upstream is down.",
      inputSchema: { commander: z.string() },
    },
    handler: async (args) => {
      const commander = String(args.commander ?? "");
      const profile = await edhrec.profile(commander);
      return {
        content: [
          { type: "text", text: `${profile.cards.length} cards, ${profile.themes.length} themes` },
        ],
        structuredContent: { commander, ...profile },
      };
    },
  };
}

function metaThemesTool(edhrec: EdhrecClient): ToolDefinition {
  return {
    name: "meta_themes",
    config: {
      title: "Commander themes (EDHREC)",
      description:
        "The themes/archetypes EDHREC associates with a SPECIFIC commander (per-commander, " +
        "not a global list) — pass the commander's name in `commander` (required).",
      inputSchema: { commander: z.string().min(1, "commander name is required") },
    },
    handler: async (args) => {
      const commander = String(args.commander ?? "");
      const themes = await edhrec.themes(commander);
      return {
        content: [{ type: "text", text: themes.join(", ") || "(no themes)" }],
        structuredContent: { commander, themes },
      };
    },
  };
}

function metaRecommendationsTool(
  store: DeckStore,
  index: CardIndex,
  edhrec: EdhrecClient,
  session: string,
): ToolDefinition {
  return {
    name: "meta_recommendations",
    config: {
      title: "Recommendations (EDHREC)",
      description:
        "EDHREC 'what fits next' for a deck: the commander's top cards, resolved to oracle_ids, " +
        "filtered to the deck's color identity, excluding cards already in the deck. Optional " +
        "exclude_lands. Unresolved names are reported, not dropped.",
      inputSchema: {
        deck_id: z.string(),
        exclude_lands: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    handler: async (args) => {
      const deckId = String(args.deck_id ?? "");
      const excludeLands = args.exclude_lands === true;
      const limit = typeof args.limit === "number" ? args.limit : 50;
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);

      const commanderId = deck.commanders[0];
      const commanderCard = commanderId ? index.getCard(commanderId) : null;
      if (!commanderCard) {
        throw new StructuredError(
          "INELIGIBLE_COMMANDER",
          `deck '${deckId}' has no resolvable commander`,
        );
      }

      const profile = await edhrec.profile(commanderCard.name);
      const identity = new Set(deck.computed_color_identity.map((c) => c.toUpperCase()));
      const inDeck = new Set<string>([...deck.commanders, ...deck.cards.map((e) => e.oracle_id)]);

      const recommendations: Record<string, unknown>[] = [];
      const unresolved: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      for (const card of profile.cards) {
        const matches = index.resolveName(card.name, { exact: true });
        const ref = matches.length === 1 ? matches[0] : undefined;
        if (!ref) {
          unresolved.push({
            name: card.name,
            reason: matches.length === 0 ? "UNKNOWN_CARD" : "AMBIGUOUS_NAME",
          });
          continue;
        }
        if (inDeck.has(ref.oracle_id) || seen.has(ref.oracle_id)) continue;
        const offColor = ref.ci.some((c) => c !== "C" && !identity.has(c));
        if (offColor) continue;
        if (excludeLands && /\bLand\b/.test(ref.type)) continue;
        seen.add(ref.oracle_id);
        recommendations.push({
          oracle_id: ref.oracle_id,
          name: ref.name,
          synergy: card.synergy,
          inclusion: card.inclusion,
          category: card.category,
        });
        if (recommendations.length >= limit) break;
      }

      return {
        content: [
          {
            type: "text",
            text: `${recommendations.length} recommendations (${unresolved.length} unresolved)`,
          },
        ],
        structuredContent: {
          deck_id: deckId,
          commander: commanderCard.name,
          recommendations,
          unresolved,
        },
      };
    },
  };
}

function metaMissingStaplesTool(
  store: DeckStore,
  index: CardIndex,
  edhrec: EdhrecClient,
  session: string,
): ToolDefinition {
  return {
    name: "meta_missing_staples",
    config: {
      title: "Missing staples (EDHREC)",
      description:
        "Diff a deck against its commander's typical EDHREC list: the in-identity cards NOT in the " +
        "deck, ranked by inclusion (EDHREC's prevalence figure — higher = run by more typical decks; " +
        "it is a raw figure, not a normalized %). Distinct from meta_recommendations ('what fits') — " +
        "this is 'what conspicuous staples are you missing'. Optional min_inclusion threshold, " +
        "exclude_lands, limit. Unresolved names are reported, not dropped.",
      inputSchema: {
        deck_id: z.string(),
        min_inclusion: z.number().nonnegative().optional(),
        exclude_lands: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    handler: async (args) => {
      const deckId = String(args.deck_id ?? "");
      const minInclusion = typeof args.min_inclusion === "number" ? args.min_inclusion : 0;
      const excludeLands = args.exclude_lands === true;
      const limit = typeof args.limit === "number" ? args.limit : 25;
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);

      const commanderId = deck.commanders[0];
      const commanderCard = commanderId ? index.getCard(commanderId) : null;
      if (!commanderCard) {
        throw new StructuredError(
          "INELIGIBLE_COMMANDER",
          `deck '${deckId}' has no resolvable commander`,
        );
      }

      const profile = await edhrec.profile(commanderCard.name);
      const identity = new Set(deck.computed_color_identity.map((c) => c.toUpperCase()));
      const inDeck = new Set<string>([...deck.commanders, ...deck.cards.map((e) => e.oracle_id)]);

      const missing: Array<{
        oracle_id: string;
        name: string;
        inclusion: number;
        synergy: number;
        category: string;
      }> = [];
      const unresolved: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      for (const card of profile.cards) {
        const inclusion = card.inclusion ?? 0;
        const synergy = card.synergy ?? 0;
        if (inclusion < minInclusion) continue;
        const matches = index.resolveName(card.name, { exact: true });
        const ref = matches.length === 1 ? matches[0] : undefined;
        if (!ref) {
          unresolved.push({
            name: card.name,
            reason: matches.length === 0 ? "UNKNOWN_CARD" : "AMBIGUOUS_NAME",
          });
          continue;
        }
        if (inDeck.has(ref.oracle_id) || seen.has(ref.oracle_id)) continue;
        if (ref.ci.some((c) => c !== "C" && !identity.has(c))) continue;
        if (excludeLands && /\bLand\b/.test(ref.type)) continue;
        seen.add(ref.oracle_id);
        missing.push({
          oracle_id: ref.oracle_id,
          name: ref.name,
          inclusion,
          synergy,
          category: card.category,
        });
      }
      // Rank by prevalence (inclusion) desc; deterministic oracle_id tiebreak.
      missing.sort((a, b) => b.inclusion - a.inclusion || a.oracle_id.localeCompare(b.oracle_id));
      const top = missing.slice(0, limit);

      return {
        content: [
          {
            type: "text",
            text: `${top.length} missing staple(s) for ${commanderCard.name} (${unresolved.length} unresolved)`,
          },
        ],
        structuredContent: {
          deck_id: deckId,
          commander: commanderCard.name,
          missing: top,
          unresolved,
        },
      };
    },
  };
}

interface SwapCandidate {
  oracle_id: string;
  name: string;
  roles: Role[];
  cheapest: number;
}

function metaBudgetSwapsTool(
  store: DeckStore,
  index: CardIndex,
  edhrec: EdhrecClient,
  session: string,
): ToolDefinition {
  return {
    name: "meta_budget_swaps",
    config: {
      title: "Budget swaps (EDHREC)",
      description:
        "Suggest cheaper functional REPLACEMENTS for a deck's most expensive cards: candidates are " +
        "drawn from the commander's EDHREC profile (in color identity, not already in the deck), and " +
        "a swap is proposed when a candidate shares a functional role and is cheaper (by cheapest " +
        "printing). Reports per-swap savings + the projected min-buy. Pass target_usd to stop once " +
        "the floor is under budget. Heuristic + advisory: role match is coarse (shares any role, not " +
        "semantic equivalence) and prices are conservative local-index floors — review before swapping. " +
        "For zero-change reprint savings (no swaps) use budget_plan.",
      inputSchema: {
        deck_id: z.string(),
        target_usd: z.number().nonnegative().optional(),
        limit: z.number().int().positive().max(50).optional(),
      },
    },
    handler: async (args) => {
      const deckId = String(args.deck_id ?? "");
      const target = typeof args.target_usd === "number" ? args.target_usd : null;
      const limit = typeof args.limit === "number" ? args.limit : 10;
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);

      const commanderId = deck.commanders[0];
      const commanderCard = commanderId ? index.getCard(commanderId) : null;
      if (!commanderCard) {
        throw new StructuredError(
          "INELIGIBLE_COMMANDER",
          `deck '${deckId}' has no resolvable commander`,
        );
      }

      const profile = await edhrec.profile(commanderCard.name);
      const identity = new Set(deck.computed_color_identity.map((c) => c.toUpperCase()));
      const inDeck = new Set<string>([...deck.commanders, ...deck.cards.map((e) => e.oracle_id)]);

      // Candidate pool: priced, in-identity, not-in-deck cards from the EDHREC profile.
      const candidates: SwapCandidate[] = [];
      const seenCand = new Set<string>();
      for (const pc of profile.cards) {
        const matches = index.resolveName(pc.name, { exact: true });
        const ref = matches.length === 1 ? matches[0] : undefined;
        if (!ref || inDeck.has(ref.oracle_id) || seenCand.has(ref.oracle_id)) continue;
        if (ref.ci.some((c) => c !== "C" && !identity.has(c))) continue;
        const full = index.getCard(ref.oracle_id);
        if (!full) continue;
        const cheap = cheapestUsd(full);
        if (cheap === null) continue;
        seenCand.add(ref.oracle_id);
        candidates.push({
          oracle_id: ref.oracle_id,
          name: ref.name,
          roles: [...full.roles],
          cheapest: cheap,
        });
      }

      // Deck cost drivers (cheapest × qty), most expensive first.
      const drivers: Array<{
        oracle_id: string;
        name: string;
        roles: readonly Role[];
        cheapest: number;
        qty: number;
        contribution: number;
      }> = [];
      let deckMinBuy = 0;
      for (const e of deck.cards) {
        const full = index.getCard(e.oracle_id);
        if (!full) continue;
        const cheap = cheapestUsd(full) ?? 0;
        deckMinBuy += cheap * e.qty;
        drivers.push({
          oracle_id: full.oracle_id,
          name: full.name,
          roles: full.roles,
          cheapest: cheap,
          qty: e.qty,
          contribution: cheap * e.qty,
        });
      }
      drivers.sort(
        (a, b) => b.contribution - a.contribution || a.oracle_id.localeCompare(b.oracle_id),
      );

      const swaps: Record<string, unknown>[] = [];
      const usedCand = new Set<string>();
      let savings = 0;
      for (const d of drivers) {
        if (swaps.length >= limit) break;
        if (target !== null && deckMinBuy - savings <= target) break;
        let best: (SwapCandidate & { shared: Role[] }) | null = null;
        for (const c of candidates) {
          if (usedCand.has(c.oracle_id) || c.cheapest >= d.cheapest) continue;
          const shared = c.roles.filter((r) => d.roles.includes(r));
          if (shared.length === 0) continue;
          if (
            !best ||
            c.cheapest < best.cheapest ||
            (c.cheapest === best.cheapest && c.oracle_id.localeCompare(best.oracle_id) < 0)
          ) {
            best = { ...c, shared };
          }
        }
        if (!best) continue;
        usedCand.add(best.oracle_id);
        savings += (d.cheapest - best.cheapest) * d.qty;
        swaps.push({
          out: {
            oracle_id: d.oracle_id,
            name: d.name,
            cheapest_usd: round2(d.cheapest),
            qty: d.qty,
          },
          in: { oracle_id: best.oracle_id, name: best.name, cheapest_usd: round2(best.cheapest) },
          roles_matched: best.shared,
          savings: round2((d.cheapest - best.cheapest) * d.qty),
        });
      }

      return {
        content: [
          {
            type: "text",
            text: `${swaps.length} budget swap(s); min buy $${round2(deckMinBuy)} → $${round2(deckMinBuy - savings)}`,
          },
        ],
        structuredContent: {
          deck_id: deckId,
          commander: commanderCard.name,
          swaps,
          current_min_buy_usd: round2(deckMinBuy),
          projected_min_buy_usd: round2(deckMinBuy - savings),
          target_usd: target,
        },
      };
    },
  };
}

function metaCombosTool(
  store: DeckStore,
  index: CardIndex,
  spellbook: SpellbookClient,
  session: string,
): ToolDefinition {
  return {
    name: "meta_combos",
    config: {
      title: "Combos (Commander Spellbook)",
      description:
        "Combos reachable from a deck (pieces, result, steps) via Commander Spellbook. " +
        "Returns combos fully present in the deck; set include_almost to also return combos " +
        "that are one card away. Each combo carries its source and confidence.",
      inputSchema: { deck_id: z.string(), include_almost: z.boolean().optional() },
    },
    handler: async (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);

      const commanderNames = deck.commanders
        .map((id) => index.getCard(id)?.name)
        .filter((n): n is string => typeof n === "string");
      const cardNames = deck.cards
        .map((e) => index.getCard(e.oracle_id)?.name)
        .filter((n): n is string => typeof n === "string");

      const results = await spellbook.findMyCombos(commanderNames, cardNames);
      const combos = [
        ...results.included,
        ...(args.include_almost === true ? results.almostIncluded : []),
      ];
      return {
        content: [
          {
            type: "text",
            text: `${results.included.length} included, ${results.almostIncluded.length} almost`,
          },
        ],
        structuredContent: {
          deck_id: deckId,
          combos,
          included_count: results.included.length,
          almost_count: results.almostIncluded.length,
        },
      };
    },
  };
}

function metaClassifyBracketTool(
  store: DeckStore,
  index: CardIndex,
  gameChangers: GameChangersClient,
  session: string,
): ToolDefinition {
  return {
    name: "meta_classify_bracket",
    config: {
      title: "Classify bracket",
      description:
        "Classify a deck into the official Commander brackets (1 Exhibition … 5 cEDH) and " +
        "report what pushes it up: Game Changers, fast mana, tutors, mass land denial. The " +
        "Game Changers list is fetched live (never hardcoded). cEDH (5) is not auto-assigned.",
      inputSchema: { deck_id: z.string() },
    },
    handler: async (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const set = await gameChangers.list();
      const result = classifyBracket(deck, (id) => index.getCard(id), set);
      return {
        content: [{ type: "text", text: `bracket ${result.bracket}: ${result.rationale}` }],
        structuredContent: { deck_id: deckId, ...result },
      };
    },
  };
}

/** Build the enrichment tools bound to a DeckStore + CardIndex + EDHREC/Spellbook/GameChangers clients. */
export function makeMetaTools(
  store: DeckStore,
  index: CardIndex,
  edhrec: EdhrecClient,
  spellbook: SpellbookClient,
  gameChangers: GameChangersClient,
  session = "local",
): ToolDefinition[] {
  return [
    metaCommanderProfileTool(edhrec),
    metaThemesTool(edhrec),
    metaRecommendationsTool(store, index, edhrec, session),
    metaMissingStaplesTool(store, index, edhrec, session),
    metaBudgetSwapsTool(store, index, edhrec, session),
    metaCombosTool(store, index, spellbook, session),
    metaClassifyBracketTool(store, index, gameChangers, session),
  ];
}
