/**
 * Deck vitals (ergonomics overhaul C2): the lean state block attached to every
 * deck mutation response so an agent never needs a follow-up deck_get to learn
 * where the deck stands. Composes the same pure validators validate_deck uses
 * (error-severity only for `legal`), so `legal` here always agrees with the
 * authoritative gate. Cheap by construction: one pass over ≤~100 entries
 * against the local index.
 */
import type { CardIndex } from "../index/index.js";
import type { Card, Color, Deck } from "../types/index.js";
import { validateCore, validateCommander, validateCompanion } from "../validate/index.js";

export interface DeckVitals {
  /** Quantity-weighted card count INCLUDING the command zone (target: exactly 100). */
  card_count: number;
  land_count: number;
  color_identity: readonly (Color | "C")[] | readonly Color[];
  commander_count: number;
  /** True iff a full validate_deck would report zero error-severity violations. */
  legal: boolean;
  /** Error-severity violation count (warnings excluded). */
  violation_count: number;
  version: number;
}

const LAND_RE = /\bLand\b/;

/** Compute the vitals block for a deck against the card index. */
export function deckVitals(deck: Deck, index: CardIndex | undefined): DeckVitals {
  const lookup = (id: string): Card | null => index?.getCard(id) ?? null;
  let cardTotal = 0;
  let landCount = 0;
  for (const entry of deck.cards) {
    cardTotal += entry.qty;
    const card = lookup(entry.oracle_id);
    if (card && LAND_RE.test(card.type_line)) landCount += entry.qty;
  }
  const errors = index
    ? [
        ...validateCore(deck, lookup),
        ...validateCommander(deck, lookup),
        ...validateCompanion(deck, lookup),
      ].filter((v) => v.severity === "error")
    : [];
  return {
    card_count: cardTotal + deck.commanders.length,
    land_count: landCount,
    color_identity: deck.computed_color_identity,
    commander_count: deck.commanders.length,
    legal: index ? errors.length === 0 : true,
    violation_count: errors.length,
    version: deck.version,
  };
}

/** One-line human/model-readable vitals summary for text content blocks. */
export function formatVitals(v: DeckVitals): string {
  const ci = v.color_identity.length > 0 ? v.color_identity.join("") : "C";
  const legality = v.legal ? "legal" : `${v.violation_count} violation(s)`;
  return `${v.card_count}/100 cards, ${v.land_count} lands, ${ci}, ${legality}, v${v.version}`;
}
