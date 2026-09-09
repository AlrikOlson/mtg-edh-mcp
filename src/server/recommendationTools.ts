/** Local ranking with optional, independently sourced provider observations. */
import type { CardIndex } from "../index/index.js";
import type { DeckStore } from "../deck/index.js";
import type { Deck } from "../types/index.js";
import { StructuredError } from "../types/index.js";
import { recommendCards, type RecommendationOptions } from "../analyze/recommendations.js";
import {
  edhrecMetrics,
  type EdhrecCard,
  type EdhrecClient,
  type SourcedCommanderProfile,
} from "../meta/edhrec.js";

const PROFILE_SCAN_LIMIT = 5000;
const OBSERVATIONS_PER_CARD = 8;

/** Resolve each scanned row once, independent of the number of suggestions. */
function resolveProfile(index: CardIndex, profile: SourcedCommanderProfile) {
  const observations = new Map<string, { cards: EdhrecCard[]; count: number }>();
  const coverage = {
    profile_rows: profile.cards.length,
    scanned_rows: Math.min(profile.cards.length, PROFILE_SCAN_LIMIT),
    scan_limit: PROFILE_SCAN_LIMIT,
    scan_truncated: profile.cards.length > PROFILE_SCAN_LIMIT,
    resolved_rows: 0,
    unresolved_rows: 0,
    ambiguous_rows: 0,
  };
  for (const card of profile.cards.slice(0, PROFILE_SCAN_LIMIT)) {
    const matches = index.resolveName(card.name, { exact: true });
    const match = matches.length === 1 ? matches[0] : undefined;
    if (!match) {
      if (matches.length === 0) coverage.unresolved_rows += 1;
      else coverage.ambiguous_rows += 1;
      continue;
    }
    coverage.resolved_rows += 1;
    const observation = observations.get(match.oracle_id) ?? { cards: [], count: 0 };
    observation.count += 1;
    if (observation.cards.length < OBSERVATIONS_PER_CARD) observation.cards.push(card);
    observations.set(match.oracle_id, observation);
  }
  return { observations, coverage };
}

export function recommendationConflict(deck: Deck, expected: unknown) {
  if (typeof expected !== "number" || expected === deck.version) return null;
  return {
    content: [{ type: "text" as const, text: "Deck version conflict" }],
    structuredContent: {
      ok: false,
      conflict: true,
      deck_id: deck.deck_id,
      expected_version: expected,
      current_version: deck.version,
    },
  };
}

export async function contextualRecommendation(
  deck: Deck,
  index: CardIndex,
  store: DeckStore,
  session: string,
  edhrec: EdhrecClient,
  options: RecommendationOptions,
  enrich: boolean,
) {
  const profiles: Array<{
    commander_id: string;
    commander: string;
    profile: SourcedCommanderProfile;
    resolved: ReturnType<typeof resolveProfile>;
  }> = [];
  const providers: Array<{
    commander_id: string;
    commander: string;
    status: "available" | "unavailable";
    source?: SourcedCommanderProfile["source"];
    coverage?: ReturnType<typeof resolveProfile>["coverage"];
    error?: { code: string; message: string };
  }> = [];
  if (enrich) {
    // Observe each commander separately; neither profile establishes partner synergy.
    const observations = await Promise.all(
      deck.commanders.map(async (commander_id) => {
        const card = index.getCard(commander_id);
        if (!card)
          throw new StructuredError("UNKNOWN_CARD", "Commander not installed: " + commander_id);
        try {
          return {
            commander_id,
            commander: card.name,
            profile: await edhrec.profileWithSource(card.name),
          };
        } catch (error) {
          if (!(error instanceof StructuredError) || error.code !== "UPSTREAM_UNAVAILABLE")
            throw error;
          return {
            commander_id,
            commander: card.name,
            error: { code: error.code, message: error.message },
          };
        }
      }),
    );
    for (const observation of observations) {
      if (observation.profile) {
        const resolved = resolveProfile(index, observation.profile);
        profiles.push({ ...observation, profile: observation.profile, resolved });
        providers.push({
          commander_id: observation.commander_id,
          commander: observation.commander,
          status: "available",
          source: observation.profile.source,
          coverage: resolved.coverage,
        });
      } else
        providers.push({
          commander_id: observation.commander_id,
          commander: observation.commander,
          status: "unavailable",
          error: observation.error,
        });
    }
  }
  const current = store.get(deck.deck_id, session);
  if (!current)
    throw new StructuredError("DECK_NOT_FOUND", "Deck was removed during recommendation");
  const conflict = recommendationConflict(current, deck.version);
  if (conflict) return conflict;
  const report = recommendCards(index, deck, options);
  const suggestions = report.suggestions.map((suggestion) => ({
    ...suggestion,
    provider_metrics: profiles.flatMap(({ commander_id, commander, profile, resolved }) => {
      const observation = resolved.observations.get(suggestion.oracle_id);
      return (observation?.cards ?? []).map((card) => ({
        commander_id,
        commander,
        category: card.category,
        metrics: edhrecMetrics(card, profile.source),
        observations_truncated:
          (observation?.count ?? 0) > OBSERVATIONS_PER_CARD || resolved.coverage.scan_truncated,
      }));
    }),
  }));
  return {
    content: [
      {
        type: "text" as const,
        text:
          suggestions.length +
          " locally ranked addition candidate(s); review requirements and tradeoffs before changing the deck.",
      },
    ],
    structuredContent: {
      ...report,
      ok: true,
      deck_id: deck.deck_id,
      deck_version: deck.version,
      rank: "contextual",
      suggestions,
      providers,
      source: {
        kind: "installed_card_index",
        ranking: "local_contextual_heuristic",
        provider_metrics_affect_ranking: false,
      },
      provider_limitations: [
        "Provider observations describe submitted decks for each commander separately, not partner combinations or performance in this deck.",
        "Missing observations are unknown, not measured zero. Synergy, popularity counts and lift retain distinct raw scales.",
        "Local rank is an advisory heuristic, not a win rate, objective power score or verified game sequence.",
      ],
    },
  };
}
