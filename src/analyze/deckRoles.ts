/** Deck-local advisory role corrections. The shared card index stays immutable. */
import type { Card, Deck, Role } from "../types/index.js";
import type { CardLookup } from "./stats.js";

export function effectiveRoles(card: Card, overrides?: Deck["role_overrides"]): readonly Role[] {
  return overrides && Object.hasOwn(overrides, card.oracle_id)
    ? (overrides[card.oracle_id] ?? [])
    : card.roles;
}

export function roleEvidence(card: Card, overrides?: Deck["role_overrides"]) {
  return {
    inferred_roles: [...card.roles],
    effective_roles: [...effectiveRoles(card, overrides)],
    role_source:
      overrides && Object.hasOwn(overrides, card.oracle_id)
        ? ("user_override" as const)
        : ("classifier" as const),
  };
}

/** Overlay only copied cards; raw lookups must still feed rules validation. */
export function deckRoleLookup(deck: Deck, lookup: CardLookup): CardLookup {
  return (oracleId) => {
    const card = lookup(oracleId);
    if (!card || !deck.role_overrides || !Object.hasOwn(deck.role_overrides, oracleId)) {
      return card;
    }
    return { ...card, roles: [...effectiveRoles(card, deck.role_overrides)] };
  };
}

/** Compact evidence for aggregate reports; entries replace the classifier's roles. */
export function deckRoleProvenance(deck: Deck) {
  if (!deck.role_overrides || Object.keys(deck.role_overrides).length === 0) return {};
  return {
    role_source_default: "classifier" as const,
    role_overrides: deck.role_overrides ?? {},
  };
}
