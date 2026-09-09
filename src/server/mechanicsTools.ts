/**
 * Mechanics evidence tool (Commander workshop: strategy and synergy).
 *
 * `card_mechanics` runs the read-time extractor over stored cards and returns
 * supported annotations with exact Oracle spans, the spans it did not model,
 * coverage counts, and the shared role evidence (classifier roles plus an
 * optional deck's corrections). Read-only; never touches legality or the index.
 */
import { z } from "zod";
import { extractMechanics, SUPPORTED_MECHANIC_PATTERNS } from "../analyze/mechanics.js";
import { roleEvidence } from "../analyze/deckRoles.js";
import type { CardIndex } from "../index/index.js";
import type { DeckStore } from "../deck/index.js";
import { MECHANICS_EXTRACTOR_VERSION, StructuredError, type Deck } from "../types/index.js";
import { StringOrStringsSchema, resolveCardIdLenient } from "./resolve.js";
import { READS_LOCAL } from "./registry.js";
import type { ToolDefinition } from "./registry.js";

function cardMechanicsTool(index: CardIndex, store?: DeckStore, session = "local"): ToolDefinition {
  return {
    name: "card_mechanics",
    config: {
      annotations: READS_LOCAL,
      title: "Card mechanics evidence",
      description:
        "Extract supported card mechanics with exact Oracle evidence spans.\n" +
        "USE: reading triggers, costs, effects and permissions (sacrifice, tokens, counters, draw/discard, graveyard, spells, combat, lifegain, landfall). NOT: full text or prices (card_get); role counts (analyze_composition); legality (validate_card).\n" +
        "FLOW: card_get -> card_mechanics -> deck_set_roles.\n" +
        "ARGS: cards: name | [names or oracle_ids]; deck_id (optional deck role corrections); include_unmodeled (default true).\n" +
        "RETURNS: extractor_version, supported_patterns, cards[] {annotations[] (pattern_id, subject, condition, provenance, evidence), unmodeled[], coverage, roles {inferred_roles, effective_roles, role_source}}, missing[].",
      inputSchema: {
        cards: StringOrStringsSchema,
        deck_id: z.string().optional(),
        include_unmodeled: z.boolean().optional(),
      },
      // Keep the established catalog contract: no advertised outputSchema (see card_search).
    },
    handler: (args) => {
      const raw = args.cards;
      const entries =
        typeof raw === "string"
          ? [raw]
          : Array.isArray(raw)
            ? raw.filter((x): x is string => typeof x === "string")
            : [];
      const includeUnmodeled = args.include_unmodeled !== false;
      let overrides: Deck["role_overrides"];
      let deckId: string | null = null;
      if (typeof args.deck_id === "string") {
        deckId = args.deck_id;
        const deck = store?.get(deckId, session);
        if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
        overrides = deck.role_overrides;
      }
      const cards = [];
      const missing: string[] = [];
      let annotationCount = 0;
      let unmodeledCount = 0;
      for (const entry of entries) {
        const id = resolveCardIdLenient(index, entry);
        const card = index.getCard(id);
        if (!card) {
          missing.push(id);
          continue;
        }
        const report = extractMechanics(card);
        annotationCount += report.annotations.length;
        unmodeledCount += report.unmodeled.length;
        cards.push({
          ...report,
          unmodeled: includeUnmodeled ? report.unmodeled : [],
          roles: roleEvidence(card, overrides),
        });
      }
      return {
        content: [
          {
            type: "text",
            text: `${cards.length} found, ${missing.length} missing; ${annotationCount} supported annotation(s), ${unmodeledCount} reported span(s)`,
          },
        ],
        structuredContent: {
          extractor_version: MECHANICS_EXTRACTOR_VERSION,
          supported_patterns: SUPPORTED_MECHANIC_PATTERNS.map((p) => p.id),
          deck_id: deckId,
          role_source_default: "classifier",
          cards,
          missing,
        },
      };
    },
  };
}

/** Build the mechanics tools bound to a CardIndex (+ optional DeckStore for role corrections). */
export function makeMechanicsTools(
  index: CardIndex,
  store?: DeckStore,
  session = "local",
): ToolDefinition[] {
  return [cardMechanicsTool(index, store, session)];
}
