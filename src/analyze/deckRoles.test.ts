import { describe, expect, it } from "vitest";
import type { Card, Deck } from "../types/index.js";
import { deckRoleLookup, effectiveRoles, roleEvidence } from "./deckRoles.js";

const CARD: Card = Object.freeze({
  oracle_id: "o-card",
  name: "An artifact",
  mana_cost: "{1}",
  mv: 1,
  colors: [],
  color_identity: [],
  type_line: "Artifact",
  oracle_text: "{T}: Add {C}.",
  keywords: [],
  legalities: { commander: "legal" as const },
  prices: {},
  is_commander_eligible: false,
  roles: Object.freeze(["ramp", "mana_rock"] as const),
  printings: [],
});
const DECK: Deck = {
  deck_id: "d",
  name: "D",
  format: "commander",
  commanders: [],
  command_zone_kind: "single",
  cards: [{ oracle_id: "o-card", qty: 1 }],
  computed_color_identity: [],
  version: 1,
  data_snapshot: "",
};
const lookup = (id: string) => (id === CARD.oracle_id ? CARD : null);

describe("deck role lookup", () => {
  it("keeps classifier provenance when the deck has no correction", () => {
    expect(effectiveRoles(CARD)).toBe(CARD.roles);
    expect(roleEvidence(CARD)).toEqual({
      inferred_roles: ["ramp", "mana_rock"],
      effective_roles: ["ramp", "mana_rock"],
      role_source: "classifier",
    });
    expect(deckRoleLookup(DECK, lookup)("o-card")).toBe(CARD);
  });

  it("replaces even empty overrides on copied cards without mutating defaults or role state", () => {
    const deck: Deck = { ...DECK, role_overrides: { "o-card": [] } };
    const corrected = deckRoleLookup(deck, lookup)("o-card");
    expect(corrected).not.toBe(CARD);
    expect(corrected).toEqual({ ...CARD, roles: [] });
    expect(roleEvidence(CARD, deck.role_overrides)).toEqual({
      inferred_roles: ["ramp", "mana_rock"],
      effective_roles: [],
      role_source: "user_override",
    });
    expect(corrected?.roles).not.toBe(deck.role_overrides?.["o-card"]);
    expect(CARD.roles).toEqual(["ramp", "mana_rock"]);
    expect(deckRoleLookup(deck, lookup)("missing")).toBeNull();
  });

  it("does not treat inherited object properties as user corrections", () => {
    const card = { ...CARD, oracle_id: "constructor" };
    expect(effectiveRoles(card, {})).toEqual(CARD.roles);
    expect(roleEvidence(card, {}).role_source).toBe("classifier");
  });
});
