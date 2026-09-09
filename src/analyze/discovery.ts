/** Bounded, provider-independent retrieval. Scores describe matches, never deck quality. */
import { z } from "zod";
import type { CardIndex } from "../index/index.js";
import { parseQuery } from "../query/index.js";
import { compilePlaygroupPolicy } from "../meta/playgroupPolicy.js";
import { extractMechanics, SUPPORTED_MECHANIC_PATTERNS } from "./mechanics.js";
import {
  commanderColorIdentity,
  isCommanderEligible,
  isLegendaryBackground,
  validateCommander,
  commanderPairingCandidate,
} from "../validate/commanderRules.js";
import {
  StructuredError,
  MECHANICS_EXTRACTOR_VERSION,
  type Card,
  type CardRef,
  type Color,
  type CommandZoneKind,
  type Deck,
  type MechanicAnnotation,
} from "../types/index.js";

export const DISCOVERY_VERSION = "1.0.0";
/** Transparent expansions, intentionally broader than precise deck contribution. */
export const DISCOVERY_THEMES: Readonly<Record<string, readonly string[]>> = {
  sacrifice: [
    "cost.sacrifice_self",
    "cost.sacrifice_permanent",
    "trigger.sacrifice",
    "trigger.dies",
  ],
  tokens: ["effect.create_token", "trigger.token_created"],
  counters: [
    "effect.put_counters",
    "effect.enters_with_counters",
    "effect.proliferate",
    "trigger.counters_placed",
  ],
  draw: ["effect.draw_cards", "trigger.draw"],
  discard: ["cost.discard_cards", "effect.discard_cards", "trigger.discard"],
  graveyard: [
    "effect.return_from_graveyard",
    "permission.cast_from_graveyard",
    "effect.mill",
    "trigger.leaves_graveyard",
  ],
  spellcast: ["trigger.cast_spell"],
  combat: ["trigger.attacks", "trigger.blocks", "trigger.combat_damage_player"],
  lifegain: ["effect.gain_life", "trigger.lifegain"],
  landfall: ["trigger.landfall"],
  scry: ["effect.scry"],
  mill: ["effect.mill"],
};
const patterns = new Set(SUPPORTED_MECHANIC_PATTERNS.map((p) => p.id));
const id = z.string().trim().min(1).max(256);
export const DiscoveryRequestSchema = z
  .object({
    theme: z.string().trim().min(1).max(200).optional(),
    mechanics: z.array(id).max(32).optional(),
    oracle_query: z.string().trim().min(1).max(2000).optional(),
    mode: z.enum(["cards", "commanders"]).default("cards"),
    commanders: z.array(id).min(1).max(2).optional(),
    command_zone_kind: z.enum(["single", "partner", "background", "doctor_companion"]).optional(),
    color_identity: z
      .array(z.enum(["W", "U", "B", "R", "G"]))
      .max(5)
      .optional(),
    excluded_cards: z.array(id).max(1000).default([]),
    max_mana_value: z.number().finite().nonnegative().max(1000).optional(),
    include_pairs: z.boolean().default(true),
    limit: z.number().int().min(1).max(50).default(50),
    scan_limit: z.number().int().min(1).max(100000).default(50000),
    pair_limit: z.number().int().min(1).max(100000).default(50000),
  })
  .strict();
export type DiscoveryRequest = z.input<typeof DiscoveryRequestSchema>;
type Match =
  | { kind: "mechanic"; annotation: MechanicAnnotation }
  | { kind: "query"; query: string; oracle_id: string };
interface Candidate {
  card: Card;
  matches: Match[];
  score: number;
  evidence_truncated: boolean;
}
export interface DiscoveryResult {
  cards: CardRef[];
  command_zone_kind: CommandZoneKind | null;
  color_identity: Color[];
  score: number;
  matches: Match[];
  evidence_truncated: boolean;
}
const kinds: readonly CommandZoneKind[] = ["single", "partner", "background", "doctor_companion"];
const ALL = { kind: "and", clauses: [] } as const;
const ref = (card: Card): CardRef => ({
  oracle_id: card.oracle_id,
  name: card.name,
  mv: card.mv,
  ci: card.color_identity.length ? card.color_identity : ["C"],
  type: card.type_line,
});
function zone(cards: readonly Card[], kind: CommandZoneKind): Deck {
  return {
    deck_id: "",
    name: "",
    format: "commander",
    commanders: cards.map((c) => c.oracle_id),
    command_zone_kind: kind,
    cards: [],
    computed_color_identity: [],
    version: 0,
    data_snapshot: "",
  };
}
function legalZone(cards: readonly Card[], specified?: CommandZoneKind): CommandZoneKind | null {
  if (cards.some((c) => c.legalities.commander !== "legal")) return null;
  const lookup = (id: string) => cards.find((c) => c.oracle_id === id) ?? null;
  for (const kind of specified ? [specified] : kinds) {
    if (validateCommander(zone(cards, kind), lookup).length === 0) return kind;
  }
  return null;
}
const compare = (a: DiscoveryResult, b: DiscoveryResult): number =>
  b.score - a.score ||
  a.cards
    .map((c) => c.name)
    .join("\0")
    .localeCompare(b.cards.map((c) => c.name).join("\0")) ||
  a.cards
    .map((c) => c.oracle_id)
    .join("\0")
    .localeCompare(b.cards.map((c) => c.oracle_id).join("\0"));

/** Internal reuse of the bounded card scan; public discovery keeps its retrieval semantics. */
export interface DiscoveryScorer {
  score(card: Card): { score: number; exclusion?: string };
}

/** Reads one synchronous index generation; no remote clients or mutable deck operations. */
export function discover(
  index: CardIndex,
  input: DiscoveryRequest,
  deck?: Deck,
  contextual?: DiscoveryScorer,
) {
  const request = DiscoveryRequestSchema.parse(input);
  if (request.mode === "commanders" && (request.commanders || request.command_zone_kind))
    throw new StructuredError(
      "INVALID_QUERY",
      "Use mode:cards with a selected command zone, or mode:commanders to discover choices.",
    );
  if (request.command_zone_kind && !request.commanders && !deck)
    throw new StructuredError("INVALID_QUERY", "command_zone_kind requires selected commanders.");
  for (const pattern of request.mechanics ?? []) {
    if (!patterns.has(pattern))
      throw new StructuredError("INVALID_QUERY", "Unsupported mechanic: " + pattern);
  }
  const theme = request.theme?.toLowerCase();
  const expansion =
    theme && Object.hasOwn(DISCOVERY_THEMES, theme) ? DISCOVERY_THEMES[theme] : undefined;
  const requestedPatterns = new Set([...(expansion ?? []), ...(request.mechanics ?? [])]);
  const query = request.oracle_query ? parseQuery(request.oracle_query) : undefined;
  const interpretation = {
    theme: request.theme ?? null,
    status:
      theme && !expansion
        ? query
          ? "text_fallback"
          : requestedPatterns.size
            ? "mechanic_fallback"
            : "needs_query"
        : requestedPatterns.size || query
          ? "supported"
          : "needs_query",
    patterns: [...requestedPatterns],
    oracle_query: request.oracle_query ?? null,
    combination:
      "Any requested mechanic matches; an explicit query is an additional required filter.",
    uncertainty:
      "Theme expansions are retrieval heuristics. Matching text does not establish synergy, playability, or deck quality.",
    fallback:
      'Supply oracle_query using local card_search grammar, e.g. o:explore or o:"land card" t:creature.',
  };
  const policy = compilePlaygroupPolicy(deck?.intent);
  const hard = policy.construction;
  const excluded = new Set([...request.excluded_cards, ...(hard.excluded_cards ?? [])]);
  const selectedIds =
    request.mode === "cards" ? (request.commanders ?? deck?.commanders ?? []) : [];
  const selected = selectedIds.map((id) => {
    const card = index.getCard(id);
    if (!card)
      throw new StructuredError("UNKNOWN_CARD", "Selected commander is not installed: " + id);
    return card;
  });
  const selectedKind = selected.length
    ? legalZone(
        selected,
        request.command_zone_kind ?? (request.commanders ? undefined : deck?.command_zone_kind),
      )
    : null;
  if (selected.length && !selectedKind)
    throw new StructuredError(
      "INELIGIBLE_COMMANDER",
      "The selected command zone is not legal in the installed snapshot.",
    );
  const selectedIdentity = selected.length
    ? commanderColorIdentity({ commanders: selectedIds }, (id) => index.getCard(id))
    : undefined;
  const colorLimits = [
    request.color_identity,
    hard.commanders?.color_identity,
    selectedIdentity,
  ].filter((value): value is Color[] => value !== undefined);
  const existing = new Set(
    request.mode === "cards"
      ? [
          ...(deck?.cards.map((c) => c.oracle_id) ?? []),
          ...selectedIds,
          ...(deck?.companion ? [deck.companion] : []),
        ]
      : [],
  );
  const counts: Record<string, number> = {};
  const samples: Array<{ oracle_id: string; name: string; reason: string }> = [];
  let exclusionTotal = 0;
  const exclude = (card: Card, reason: string) => {
    counts[reason] = (counts[reason] ?? 0) + 1;
    exclusionTotal += 1;
    if (samples.length < 20) samples.push({ oracle_id: card.oracle_id, name: card.name, reason });
  };
  const result: DiscoveryResult[] = [];
  let total = 0;
  const add = (cs: Candidate[], kind: CommandZoneKind | null) => {
    const ordered = [...cs].sort((a, b) => a.card.name.localeCompare(b.card.name));
    const ids = ordered.map((c) => c.card.oracle_id);
    if (kind && (hard.commanders?.required ?? []).some((id) => !ids.includes(id))) {
      counts.required_commander = (counts.required_commander ?? 0) + 1;
      return;
    }
    const colors = commanderColorIdentity(
      { commanders: ids },
      (id) => ordered.find((c) => c.card.oracle_id === id)?.card ?? null,
    );
    const candidate: DiscoveryResult = {
      cards: ordered.map((c) => ref(c.card)),
      command_zone_kind: kind,
      color_identity: colors,
      score: ordered.reduce((sum, c) => sum + c.score, 0),
      matches: ordered.flatMap((c) => c.matches),
      evidence_truncated: ordered.some((c) => c.evidence_truncated),
    };
    if (!candidate.score) return;
    total += 1;
    result.push(candidate);
    result.sort(compare);
    if (result.length > request.limit) result.pop();
  };
  let scanned = 0;
  const installed = index.evaluate({ kind: "and", clauses: [] }, { limit: 1 }).total;
  let cursor: string | undefined;
  let scanTruncated = false;
  const pairCandidates: Candidate[] = [];
  if (interpretation.status !== "needs_query" || contextual) {
    do {
      const page = index.evaluate(
        { ...ALL, clauses: [] },
        {
          limit: Math.min(175, request.scan_limit - scanned),
          cursor,
          order: "name",
        },
      );
      const queryIds =
        query && page.results.length
          ? new Set(
              index
                .evaluate(query, {
                  oracleIds: page.results.map((c) => c.oracle_id),
                  limit: 175,
                })
                .results.map((c) => c.oracle_id),
            )
          : undefined;
      for (const item of page.results) {
        scanned += 1;
        const card = index.getCard(item.oracle_id);
        if (!card) continue;
        if (card.legalities.commander !== "legal") {
          exclude(card, "legality");
          continue;
        }
        if (
          colorLimits.some((colors) => card.color_identity.some((color) => !colors.includes(color)))
        ) {
          exclude(card, "color_identity");
          continue;
        }
        if (excluded.has(card.oracle_id)) {
          exclude(card, "excluded_card");
          continue;
        }
        if (existing.has(card.oracle_id)) {
          exclude(card, "already_in_deck");
          continue;
        }
        if (request.max_mana_value !== undefined && card.mv > request.max_mana_value) {
          exclude(card, "mana_value");
          continue;
        }
        if (
          request.mode === "commanders" &&
          hard.commanders?.allowed !== undefined &&
          !hard.commanders.allowed.includes(card.oracle_id)
        ) {
          exclude(card, "commander_allowed");
          continue;
        }
        if (
          request.mode === "commanders" &&
          !isCommanderEligible(card) &&
          !isLegendaryBackground(card)
        ) {
          exclude(card, "commander_eligibility");
          continue;
        }
        const report = requestedPatterns.size ? extractMechanics(card) : undefined;
        const annotations =
          report?.annotations.filter((a) => requestedPatterns.has(a.pattern_id)) ?? [];
        const queryMatch = queryIds?.has(card.oracle_id) ?? true;
        const contextualScore = queryMatch ? contextual?.score(card) : undefined;
        const score = contextualScore
          ? contextualScore.score
          : queryMatch && (!requestedPatterns.size || annotations.length > 0)
            ? new Set(annotations.map((a) => a.pattern_id)).size * 10 + (query ? 1 : 0)
            : 0;
        const matches: Match[] = queryMatch
          ? annotations.slice(0, 8).map((annotation) => ({ kind: "mechanic", annotation }))
          : [];
        if (queryMatch && request.oracle_query)
          matches.push({
            kind: "query",
            query: request.oracle_query,
            oracle_id: card.oracle_id,
          });
        const candidate = {
          card,
          matches,
          score,
          evidence_truncated: annotations.length > 8,
        };
        if (!score)
          exclude(
            card,
            contextualScore?.exclusion ?? (queryMatch ? "no_supported_match" : "query"),
          );
        if (request.mode === "cards") {
          if (score) add([candidate], null);
        } else {
          if (score && legalZone([card])) add([candidate], "single");
          if (request.include_pairs && commanderPairingCandidate(card))
            pairCandidates.push(candidate);
        }
      }
      cursor = page.nextCursor;
      if (scanned >= request.scan_limit) {
        scanTruncated = !!cursor;
        break;
      }
    } while (cursor);
  }
  // Matching members first prevents unrelated combinations consuming the pair budget.
  pairCandidates.sort((a, b) => b.score - a.score || a.card.name.localeCompare(b.card.name));
  let pairChecks = 0;
  let pairsTruncated = false;
  outer: for (let i = 0; i < pairCandidates.length; i += 1) {
    const a = pairCandidates[i];
    if (!a || !a.score) break;
    for (let j = i + 1; j < pairCandidates.length; j += 1) {
      const b = pairCandidates[j];
      if (!b) continue;
      if (pairChecks >= request.pair_limit) {
        pairsTruncated = true;
        break outer;
      }
      pairChecks += 1;
      const kind = legalZone([a.card, b.card]);
      if (kind) add([a, b], kind);
      else counts.invalid_pair = (counts.invalid_pair ?? 0) + 1;
    }
  }
  return {
    discovery_version: DISCOVERY_VERSION,
    extractor_version: MECHANICS_EXTRACTOR_VERSION,
    mode: request.mode,
    interpretation,
    source: {
      kind: "installed_card_index",
      recommendation_providers: "not_used",
    },
    deck_id: deck?.deck_id ?? null,
    deck_version: deck?.version ?? null,
    selected_command_zone: selectedKind
      ? {
          commanders: selectedIds,
          kind: selectedKind,
          color_identity: selectedIdentity,
        }
      : null,
    constraints: {
      color_limits: colorLimits,
      excluded_cards: [...excluded],
      max_mana_value: request.max_mana_value ?? null,
      construction: hard,
    },
    policy: {
      status: "not_evaluated",
      declared: policy.declared,
      next_tool: "meta_check_policy",
    },
    results: result,
    total_matches: total,
    returned: result.length,
    installed,
    scanned,
    pair_checks: pairChecks,
    limits: {
      results: request.limit,
      scan: request.scan_limit,
      pairs: request.pair_limit,
      evidence_per_card: 8,
      exclusion_samples: 20,
    },
    exclusions: {
      counts,
      samples,
      samples_truncated: exclusionTotal > samples.length,
      note: "Card counts use the first exclusion; invalid_pair and required_commander count configurations. Unmatched cards may still support a matching partner.",
    },
    truncation: {
      scan: scanTruncated,
      pairs: pairsTruncated,
      results: total > result.length,
    },
    limitations: [
      "Coverage is limited to the installed snapshot and declared mechanics; absence is not proof of irrelevance.",
      "Pair scores sum member matches; an unmatched legal partner is included without a synergy claim.",
      "Locked quantities, change limits, playgroup/package restrictions and advisory preferences require whole-deck evaluation.",
      "Color-choice commanders use only their stored identity; pregame color choices are not inferred.",
    ],
  };
}
