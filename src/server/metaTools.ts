/**
 * EDHREC enrichment tools (spec §5E, consolidated in ergo-meta): five
 * non-overlapping tools — meta_commander_profile (the raw profile),
 * meta_recommend (cards to ADD, ranked by synergy or inclusion),
 * meta_budget_swaps (cheaper REPLACEMENTS), meta_combos (Spellbook),
 * meta_classify_bracket (power verdict). All deck-grounded suggestions flow
 * through one shared profile-filter pipeline: resolve profile names to
 * oracle_ids, filter to the deck's color identity, exclude cards already in
 * the deck, report unresolved names. Each reads live data via injected
 * clients (cached + degrading through the CacheStore).
 */
import { z } from "zod";
import { StructuredError } from "../types/index.js";
import type { CardRef, Deck, Role } from "../types/index.js";
import type { CardIndex } from "../index/index.js";
import type { DeckStore } from "../deck/index.js";
import { cheapestUsd } from "../analyze/index.js";
import type {
  EdhrecClient,
  SpellbookClient,
  GameChangersClient,
  BracketCombo,
} from "../meta/index.js";
import { classifyBracket } from "../meta/index.js";

/**
 * Resolve a deck's reachable two-card Commander Spellbook combos to bracket
 * combos (oracle_id pieces), for classifyBracket. Degrades to [] when Spellbook
 * is unavailable — the bracket still computes from Game Changers / MLD / extra
 * turns. The live fetch stays here (the tool layer); classifyBracket stays pure.
 */
async function deckTwoCardCombos(
  deck: Deck,
  index: CardIndex,
  spellbook: SpellbookClient,
): Promise<BracketCombo[]> {
  try {
    const named = [...deck.commanders, ...deck.cards.map((e) => e.oracle_id)]
      .map((id) => ({ id, name: index.getCard(id)?.name }))
      .filter((x): x is { id: string; name: string } => typeof x.name === "string");
    const idByName = new Map(named.map((x) => [x.name, x.id]));
    const commanderNames = deck.commanders
      .map((id) => index.getCard(id)?.name)
      .filter((n): n is string => typeof n === "string");
    const results = await spellbook.findMyCombos(
      commanderNames,
      named.map((x) => x.name),
    );
    const out: BracketCombo[] = [];
    for (const combo of results.included) {
      if (combo.pieces.length !== 2) continue;
      const pieces = combo.pieces
        .map((n) => idByName.get(n))
        .filter((x): x is string => typeof x === "string");
      if (pieces.length === 2) out.push({ pieces });
    }
    return out;
  } catch {
    return [];
  }
}
import { READS_LIVE } from "./registry.js";
import type { ToolDefinition } from "./registry.js";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A deck-grounded candidate from the commander's EDHREC profile. */
interface ProfileCandidate {
  oracle_id: string;
  name: string;
  synergy: number;
  inclusion: number;
  category: string;
  /** Lean ref (type line for land filtering, ci already checked). */
  ref: CardRef;
}

/** Resolve the deck's primary commander card or throw INELIGIBLE_COMMANDER. */
function requireCommander(deck: Deck, index: CardIndex, deckId: string) {
  const commanderId = deck.commanders[0];
  const commanderCard = commanderId ? index.getCard(commanderId) : null;
  if (!commanderCard) {
    throw new StructuredError(
      "INELIGIBLE_COMMANDER",
      `deck '${deckId}' has no resolvable commander`,
    );
  }
  return commanderCard;
}

/**
 * The shared profile-filter pipeline (used by meta_recommend and
 * meta_budget_swaps): resolve each profile card name to an oracle_id
 * (exact), keep in-identity cards not already in the deck, optionally drop
 * lands, and report unresolved/ambiguous names instead of dropping them.
 * Preserves EDHREC profile order (its synergy ordering).
 */
function profileCandidates(
  deck: Deck,
  index: CardIndex,
  profile: {
    cards: Array<{ name: string; synergy?: number; inclusion?: number; category: string }>;
  },
  options: { excludeLands?: boolean } = {},
): { candidates: ProfileCandidate[]; unresolved: Record<string, unknown>[] } {
  const identity = new Set(deck.computed_color_identity.map((c) => c.toUpperCase()));
  const inDeck = new Set<string>([...deck.commanders, ...deck.cards.map((e) => e.oracle_id)]);
  const candidates: ProfileCandidate[] = [];
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
    if (ref.ci.some((c) => c !== "C" && !identity.has(c))) continue;
    if (options.excludeLands && /\bLand\b/.test(ref.type)) continue;
    seen.add(ref.oracle_id);
    candidates.push({
      oracle_id: ref.oracle_id,
      name: ref.name,
      synergy: card.synergy ?? 0,
      inclusion: card.inclusion ?? 0,
      category: card.category,
      ref,
    });
  }
  return { candidates, unresolved };
}

const PROFILE_CARD_LIMIT = 50;

function metaCommanderProfileTool(edhrec: EdhrecClient): ToolDefinition {
  return {
    name: "meta_commander_profile",
    config: {
      annotations: READS_LIVE,
      title: "Commander profile (EDHREC)",
      description:
        "Fetch a commander's EDHREC average-deck profile.\n" +
        "USE: raw meta context for a commander (top cards + themes). NOT: deck-grounded suggestions (meta_recommend).\n" +
        "FLOW: deck_set_commander -> meta_commander_profile -> meta_recommend.\n" +
        "ARGS: commander (name); limit (default 50).\n" +
        "RETURNS: cards[] {name, inclusion, synergy, category}, total_cards (full profile size), themes[]. Live EDHREC, cached; degrades when upstream is down.",
      inputSchema: {
        commander: z.string(),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    handler: async (args) => {
      const commander = String(args.commander ?? "");
      const limit = typeof args.limit === "number" ? args.limit : PROFILE_CARD_LIMIT;
      const profile = await edhrec.profile(commander);
      return {
        content: [
          { type: "text", text: `${profile.cards.length} cards, ${profile.themes.length} themes` },
        ],
        structuredContent: {
          commander,
          ...profile,
          cards: profile.cards.slice(0, limit),
          total_cards: profile.cards.length,
        },
      };
    },
  };
}

const RECOMMEND_LIMIT = 25;

function metaRecommendTool(
  store: DeckStore,
  index: CardIndex,
  edhrec: EdhrecClient,
  session: string,
): ToolDefinition {
  return {
    name: "meta_recommend",
    config: {
      annotations: READS_LIVE,
      title: "Recommend cards (EDHREC)",
      description:
        "Suggest cards to add from the commander's EDHREC profile, grounded against the deck.\n" +
        "USE: rank:synergy (default) for 'what fits next'; rank:inclusion (+min_inclusion) for 'what staples am I missing'. NOT: cheaper replacements (meta_budget_swaps); offline gap analysis (deck_status).\n" +
        "FLOW: deck_set_commander/deck_status -> meta_recommend -> deck_add.\n" +
        "ARGS: deck_id; rank synergy|inclusion; min_inclusion; exclude_lands; limit (default 25, max 100).\n" +
        "RETURNS: suggestions[] {oracle_id, name, synergy, inclusion, category} — in identity, not already present, ready for deck_add; unresolved[]. Live EDHREC, cached; degrades when down.",
      inputSchema: {
        deck_id: z.string(),
        rank: z.enum(["synergy", "inclusion"]).optional(),
        min_inclusion: z.number().nonnegative().optional(),
        exclude_lands: z.boolean().optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    handler: async (args) => {
      const deckId = String(args.deck_id ?? "");
      const rank = args.rank === "inclusion" ? "inclusion" : "synergy";
      const minInclusion = typeof args.min_inclusion === "number" ? args.min_inclusion : 0;
      const limit = typeof args.limit === "number" ? args.limit : RECOMMEND_LIMIT;
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const commanderCard = requireCommander(deck, index, deckId);

      const profile = await edhrec.profile(commanderCard.name);
      const { candidates, unresolved } = profileCandidates(deck, index, profile, {
        excludeLands: args.exclude_lands === true,
      });

      let pool = candidates.filter((c) => c.inclusion >= minInclusion);
      if (rank === "inclusion") {
        // Prevalence desc; deterministic oracle_id tiebreak.
        pool = [...pool].sort(
          (a, b) => b.inclusion - a.inclusion || a.oracle_id.localeCompare(b.oracle_id),
        );
      }
      const suggestions = pool.slice(0, limit).map((c) => ({
        oracle_id: c.oracle_id,
        name: c.name,
        synergy: c.synergy,
        inclusion: c.inclusion,
        category: c.category,
      }));

      return {
        content: [
          {
            type: "text",
            text: `${suggestions.length} ${rank}-ranked suggestion(s) for ${commanderCard.name} (${unresolved.length} unresolved)`,
          },
        ],
        structuredContent: {
          deck_id: deckId,
          commander: commanderCard.name,
          rank,
          suggestions,
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
      annotations: READS_LIVE,
      title: "Budget swaps (EDHREC)",
      description:
        "Suggest cheaper functional replacements for the deck's most expensive cards.\n" +
        "USE: cutting cost via out/in swaps from the commander's EDHREC profile. NOT: additions (meta_recommend); zero-change reprint savings (budget_plan).\n" +
        "FLOW: budget_plan -> meta_budget_swaps -> deck_remove.\n" +
        "ARGS: deck_id; target_usd (stop once under budget); limit (default 10, max 50).\n" +
        "RETURNS: swaps[] {out, in, roles_matched, savings}, current_min_buy_usd, projected_min_buy_usd. Heuristic role match + local price floors — review before swapping.",
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
      const commanderCard = requireCommander(deck, index, deckId);

      const profile = await edhrec.profile(commanderCard.name);
      // Candidate pool: the shared profile pipeline, narrowed to priced cards.
      const candidates: SwapCandidate[] = [];
      for (const pc of profileCandidates(deck, index, profile).candidates) {
        const full = index.getCard(pc.oracle_id);
        if (!full) continue;
        const cheap = cheapestUsd(full);
        if (cheap === null) continue;
        candidates.push({
          oracle_id: pc.oracle_id,
          name: pc.name,
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
      annotations: READS_LIVE,
      title: "Combos (Commander Spellbook)",
      description:
        "Find combos reachable from the deck via Commander Spellbook.\n" +
        "USE: what the deck can assemble (pieces, result, steps). NOT: bracket impact (meta_classify_bracket counts combos itself).\n" +
        "FLOW: deck_status -> meta_combos -> deck_add.\n" +
        "ARGS: deck_id; include_almost:true for one-card-away combos; limit (default 20).\n" +
        "RETURNS: combos[] (with source + confidence), included_count, almost_count (exact totals).",
      inputSchema: {
        deck_id: z.string(),
        include_almost: z.boolean().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    handler: async (args) => {
      const deckId = String(args.deck_id ?? "");
      const limit = typeof args.limit === "number" ? args.limit : 20;
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
      ].slice(0, limit);
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
  spellbook: SpellbookClient,
  session: string,
): ToolDefinition {
  return {
    name: "meta_classify_bracket",
    config: {
      annotations: READS_LIVE,
      title: "Classify bracket",
      description:
        "Classify the deck into the official Commander brackets (1 Exhibition … 5 cEDH).\n" +
        "USE: power-level conversations and pod matching. NOT: legality (validate_deck); offline stats (deck_status).\n" +
        "FLOW: deck_status -> meta_classify_bracket -> deck_remove.\n" +
        "ARGS: deck_id.\n" +
        "RETURNS: bracket, rationale, pushers (Game Changers, fast mana, tutors, mass land denial, two-card combos, extra turns). Live Game Changers list + Spellbook (degrades gracefully); cEDH (5) never auto-assigned.",
      inputSchema: { deck_id: z.string() },
    },
    handler: async (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const set = await gameChangers.list();
      const combos = await deckTwoCardCombos(deck, index, spellbook);
      const result = classifyBracket(deck, (id) => index.getCard(id), set, combos);
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
    metaRecommendTool(store, index, edhrec, session),
    metaBudgetSwapsTool(store, index, edhrec, session),
    metaCombosTool(store, index, spellbook, session),
    metaClassifyBracketTool(store, index, gameChangers, spellbook, session),
  ];
}
