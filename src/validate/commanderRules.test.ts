import { describe, it, expect } from "vitest";
import type { Card, Color, Deck } from "../types/index.js";
import {
  validateCommander,
  checkCommanderEligibility,
  checkMultiCommander,
  isCommanderEligible,
  commanderColorIdentity,
  type CardLookup,
} from "./index.js";

function card(partial: Partial<Card> & { oracle_id: string; name: string }): Card {
  return {
    mana_cost: "",
    mv: 0,
    colors: [],
    color_identity: [],
    type_line: "Legendary Creature — Human",
    oracle_text: "",
    keywords: [],
    legalities: { commander: "legal" },
    prices: {},
    is_commander_eligible: true,
    roles: [],
    printings: [],
    ...partial,
  };
}

function lookupOf(...cards: Card[]): CardLookup {
  const byId = new Map(cards.map((c) => [c.oracle_id, c]));
  return (id) => byId.get(id) ?? null;
}

function deck(partial: Partial<Deck>): Deck {
  return {
    deck_id: "d1",
    name: "T",
    format: "commander",
    commanders: [],
    command_zone_kind: "single",
    cards: [],
    computed_color_identity: [],
    version: 1,
    data_snapshot: "2026-06-27",
    ...partial,
  };
}

describe("isCommanderEligible", () => {
  it("accepts a legendary creature and the server flag, rejects a plain artifact", () => {
    expect(isCommanderEligible(card({ oracle_id: "a", name: "Atraxa" }))).toBe(true);
    expect(
      isCommanderEligible(
        card({
          oracle_id: "s",
          name: "Sol Ring",
          type_line: "Artifact",
          is_commander_eligible: false,
        }),
      ),
    ).toBe(false);
  });

  it("accepts a planeswalker that says it can be your commander", () => {
    const pw = card({
      oracle_id: "pw",
      name: "Rowan",
      type_line: "Legendary Planeswalker — Rowan",
      oracle_text: "Rowan can be your commander.",
      is_commander_eligible: false,
    });
    expect(isCommanderEligible(pw)).toBe(true);
  });

  it("accepts a legendary Vehicle or Spacecraft with a printed power/toughness", () => {
    // Edge of Eternities (rule 903.3): a legendary permanent with a printed
    // P/T box is command-zone eligible. Flag forced false to isolate the path.
    const vehicle = card({
      oracle_id: "par",
      name: "Parhelion II",
      type_line: "Legendary Artifact — Vehicle",
      power: "5",
      toughness: "5",
      is_commander_eligible: false,
    });
    const spacecraft = card({
      oracle_id: "sc",
      name: "Eternal Voyager",
      type_line: "Legendary Artifact — Spacecraft",
      power: "3",
      toughness: "4",
      is_commander_eligible: false,
    });
    expect(isCommanderEligible(vehicle)).toBe(true);
    expect(isCommanderEligible(spacecraft)).toBe(true);
  });

  it("rejects a legendary permanent with no printed power/toughness", () => {
    const artifact = card({
      oracle_id: "lp",
      name: "Legendary Relic",
      type_line: "Legendary Artifact",
      is_commander_eligible: false,
    });
    expect(isCommanderEligible(artifact)).toBe(false);
  });
});

describe("checkCommanderEligibility", () => {
  it("flags a non-eligible card used as a commander", () => {
    const sol = card({
      oracle_id: "s",
      name: "Sol Ring",
      type_line: "Artifact",
      is_commander_eligible: false,
    });
    const v = checkCommanderEligibility(deck({ commanders: ["s"] }), lookupOf(sol));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: "COMMANDER_ELIGIBILITY", severity: "error" });
  });

  it("accepts a legendary Vehicle commander and yields its real color identity", () => {
    const vehicle = card({
      oracle_id: "par",
      name: "Parhelion II",
      type_line: "Legendary Artifact — Vehicle",
      power: "5",
      toughness: "5",
      color_identity: ["W"] as Color[],
      is_commander_eligible: false,
    });
    const d = deck({ commanders: ["par"], command_zone_kind: "single" });
    expect(checkCommanderEligibility(d, lookupOf(vehicle))).toEqual([]);
    // The regression: a rejected commander used to collapse to an empty identity.
    expect(commanderColorIdentity(d, lookupOf(vehicle))).toEqual(["W"]);
  });

  it("exempts a Background enchantment in a Background command zone", () => {
    const bg = card({
      oracle_id: "bg",
      name: "Criminal Past",
      type_line: "Legendary Enchantment — Background",
      is_commander_eligible: false,
    });
    const d = deck({ commanders: ["bg"], command_zone_kind: "background" });
    expect(checkCommanderEligibility(d, lookupOf(bg))).toEqual([]);
  });
});

describe("checkMultiCommander", () => {
  const partnerA = card({
    oracle_id: "pa",
    name: "Tymna the Weaver",
    keywords: ["Partner"],
    oracle_text: "Partner",
  });
  const partnerB = card({
    oracle_id: "pb",
    name: "Thrasios, Triton Hero",
    keywords: ["Partner"],
    oracle_text: "Partner",
  });
  const plain = card({ oracle_id: "pl", name: "Plain Legend" });

  it("passes a single legal commander", () => {
    expect(checkMultiCommander(deck({ commanders: ["pa"] }), lookupOf(partnerA))).toEqual([]);
  });

  it("rejects two commanders in a single command zone", () => {
    const v = checkMultiCommander(deck({ commanders: ["pa", "pb"] }), lookupOf(partnerA, partnerB));
    expect(v[0]).toMatchObject({ rule: "MULTI_COMMANDER" });
  });

  it("accepts two Partner cards in a partner command zone", () => {
    const d = deck({ commanders: ["pa", "pb"], command_zone_kind: "partner" });
    expect(checkMultiCommander(d, lookupOf(partnerA, partnerB))).toEqual([]);
  });

  it("rejects partner + non-partner", () => {
    const d = deck({ commanders: ["pa", "pl"], command_zone_kind: "partner" });
    const v = checkMultiCommander(d, lookupOf(partnerA, plain));
    expect(v[0]).toMatchObject({ rule: "MULTI_COMMANDER" });
  });

  it("accepts a valid Partner with [name] pairing and rejects a mismatched one", () => {
    const pir = card({
      oracle_id: "pir",
      name: "Pir, Imaginative Rascal",
      oracle_text: "Partner with Toothy, Imaginary Friend",
    });
    const toothy = card({
      oracle_id: "too",
      name: "Toothy, Imaginary Friend",
      oracle_text: "Partner with Pir, Imaginative Rascal",
    });
    const d = deck({ commanders: ["pir", "too"], command_zone_kind: "partner" });
    expect(checkMultiCommander(d, lookupOf(pir, toothy))).toEqual([]);

    const wrong = deck({ commanders: ["pir", "pb"], command_zone_kind: "partner" });
    expect(checkMultiCommander(wrong, lookupOf(pir, partnerB))[0]).toMatchObject({
      rule: "MULTI_COMMANDER",
    });
  });

  it("accepts a Choose a Background + Background pairing", () => {
    const cmd = card({
      oracle_id: "wil",
      name: "Wilson, Refined Grizzly",
      oracle_text: "Choose a Background",
    });
    const bg = card({
      oracle_id: "bg",
      name: "Cult of the Pit",
      type_line: "Legendary Enchantment — Background",
      is_commander_eligible: false,
    });
    const d = deck({ commanders: ["wil", "bg"], command_zone_kind: "background" });
    expect(checkMultiCommander(d, lookupOf(cmd, bg))).toEqual([]);
  });

  it("accepts a Time Lord Doctor + Doctor's companion pairing", () => {
    const doctor = card({
      oracle_id: "doc",
      name: "The Tenth Doctor",
      type_line: "Legendary Creature — Time Lord Doctor",
    });
    const companion = card({
      oracle_id: "comp",
      name: "Rose Tyler",
      oracle_text: "Doctor's companion",
    });
    const d = deck({ commanders: ["doc", "comp"], command_zone_kind: "doctor_companion" });
    expect(checkMultiCommander(d, lookupOf(doctor, companion))).toEqual([]);
  });
});

describe("commanderColorIdentity", () => {
  it("unions the commanders' identities in WUBRG order", () => {
    const a = card({ oracle_id: "a", name: "A", color_identity: ["G", "W"] as Color[] });
    const b = card({ oracle_id: "b", name: "B", color_identity: ["U"] as Color[] });
    const d = deck({ commanders: ["a", "b"], command_zone_kind: "partner" });
    expect(commanderColorIdentity(d, lookupOf(a, b))).toEqual(["W", "U", "G"]);
  });
});

describe("validateCommander", () => {
  it("aggregates eligibility + pairing violations", () => {
    const sol = card({
      oracle_id: "s",
      name: "Sol Ring",
      type_line: "Artifact",
      is_commander_eligible: false,
    });
    const plain = card({ oracle_id: "pl", name: "Plain Legend" });
    // Two commanders in a single zone (count) where one is ineligible.
    const d = deck({ commanders: ["s", "pl"], command_zone_kind: "single" });
    const rules = validateCommander(d, lookupOf(sol, plain)).map((v) => v.rule);
    expect(rules).toContain("COMMANDER_ELIGIBILITY");
    expect(rules).toContain("MULTI_COMMANDER");
  });
});
