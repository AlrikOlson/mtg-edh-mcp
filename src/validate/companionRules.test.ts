import { describe, it, expect } from "vitest";
import type { Card, Deck } from "../types/index.js";
import { validateCompanion, isCompanionCard, type CardLookup } from "./index.js";
import {
  companionRuleCoverage,
  companionCharacteristicsUnknown,
  resolveCompanionCondition,
  checkCompanionOverlap,
} from "./companionRules.js";

function card(partial: Partial<Card> & { oracle_id: string; name: string }): Card {
  return {
    mana_cost: "",
    mv: 0,
    colors: [],
    color_identity: [],
    type_line: "Creature — Human",
    oracle_text: "",
    keywords: [],
    legalities: { commander: "legal" },
    prices: {},
    is_commander_eligible: false,
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

/** The companion card itself, declared via deck.companion. */
function companion(name: string): Card {
  return card({
    oracle_id: name,
    name,
    oracle_text: `Companion — ${name}'s restriction.`,
  });
}

describe("companionRuleCoverage", () => {
  it("distinguishes modeled predicates, heuristic restrictions and missing rules", () => {
    expect(companionRuleCoverage(companion("Gyruda, Doom of Depths"))).toBe("supported");
    expect(companionRuleCoverage(companion("Some Future Companion"))).toBe("unmodeled");
    expect(companionRuleCoverage(companion("Zirda, the Dawnwaker"))).toBe("heuristic");
    expect(companionRuleCoverage(companion("Kaheera, the Orphanguard"))).toBe("heuristic");
  });
});
describe("isCompanionCard", () => {
  it("detects companion rules text", () => {
    expect(isCompanionCard(companion("Gyruda, Doom of Depths"))).toBe(true);
    expect(
      isCompanionCard(card({ oracle_id: "x", name: "Sol Ring", oracle_text: "Add CC." })),
    ).toBe(false);
  });
});

describe("validateCompanion", () => {
  it("no-ops when no companion is declared", () => {
    const d = deck({ cards: [{ oracle_id: "a", qty: 1 }] });
    expect(validateCompanion(d, lookupOf(card({ oracle_id: "a", name: "A", mv: 3 })))).toEqual([]);
  });

  it("reports a declared companion we do not model as an unresolved condition, never a silent pass", () => {
    const unknown = companion("Some Future Companion");
    const d = deck({
      companion: unknown.oracle_id,
      cards: [{ oracle_id: "a", qty: 1 }],
    });
    const v = validateCompanion(d, lookupOf(unknown, card({ oracle_id: "a", name: "A", mv: 5 })));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      rule: "COMPANION_CONDITION_UNRESOLVED",
      severity: "error",
      card: { oracle_id: unknown.oracle_id, name: "Some Future Companion" },
    });
    expect(v[0]?.detail).toContain("not modeled");
  });

  it("still says nothing about a declared companion card the lookup does not know", () => {
    const d = deck({ companion: "missing", cards: [{ oracle_id: "a", qty: 1 }] });
    expect(validateCompanion(d, lookupOf(card({ oracle_id: "a", name: "A", mv: 5 })))).toEqual([]);
  });

  it("Gyruda: passes an all-even deck, flags an odd-MV card", () => {
    const gyruda = companion("Gyruda, Doom of Depths");
    const even = card({ oracle_id: "e", name: "Even", mv: 4 });
    const odd = card({ oracle_id: "o", name: "Odd", mv: 3 });
    const land = card({
      oracle_id: "l",
      name: "Island",
      type_line: "Basic Land — Island",
      mv: 0,
    });

    const ok = deck({
      companion: gyruda.oracle_id,
      cards: [
        { oracle_id: "e", qty: 1 },
        { oracle_id: "l", qty: 1 },
      ],
    });
    expect(validateCompanion(ok, lookupOf(gyruda, even, land))).toEqual([]);

    const bad = deck({
      companion: gyruda.oracle_id,
      cards: [{ oracle_id: "o", qty: 1 }],
    });
    const v = validateCompanion(bad, lookupOf(gyruda, odd));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      rule: "COMPANION",
      severity: "error",
      card: { name: "Odd" },
    });
  });

  it("Lutri: flags a qty>1 nonland but not multiple basics", () => {
    const lutri = companion("Lutri, the Spellchaser");
    const bolt = card({
      oracle_id: "b",
      name: "Lightning Bolt",
      type_line: "Instant",
      mv: 1,
    });
    const forest = card({
      oracle_id: "f",
      name: "Forest",
      type_line: "Basic Land — Forest",
      mv: 0,
    });

    const bad = deck({
      companion: lutri.oracle_id,
      cards: [{ oracle_id: "b", qty: 2 }],
    });
    expect(validateCompanion(bad, lookupOf(lutri, bolt))).toHaveLength(1);

    const ok = deck({
      companion: lutri.oracle_id,
      cards: [{ oracle_id: "f", qty: 10 }],
    });
    expect(validateCompanion(ok, lookupOf(lutri, forest))).toEqual([]);
  });

  it("Jegantha: flags a card with two of the same mana symbol", () => {
    const jegantha = companion("Jegantha, the Wellspring");
    const rr = card({
      oracle_id: "rr",
      name: "Pyrokinesis",
      mana_cost: "{2}{R}{R}",
      mv: 4,
    });
    const fine = card({
      oracle_id: "ok",
      name: "Spell",
      mana_cost: "{1}{R}{G}",
      mv: 3,
    });

    const bad = deck({
      companion: jegantha.oracle_id,
      cards: [{ oracle_id: "rr", qty: 1 }],
    });
    expect(validateCompanion(bad, lookupOf(jegantha, rr))).toHaveLength(1);

    const ok = deck({
      companion: jegantha.oracle_id,
      cards: [{ oracle_id: "ok", qty: 1 }],
    });
    expect(validateCompanion(ok, lookupOf(jegantha, fine))).toEqual([]);
  });

  it("Keruga: a land or MV>=3 passes; a cheap nonland fails", () => {
    const keruga = companion("Keruga, the Macrosage");
    const big = card({ oracle_id: "big", name: "Big", mv: 3 });
    const cheap = card({ oracle_id: "c", name: "Cheap", mv: 1 });

    const ok = deck({
      companion: keruga.oracle_id,
      cards: [{ oracle_id: "big", qty: 1 }],
    });
    expect(validateCompanion(ok, lookupOf(keruga, big))).toEqual([]);

    const bad = deck({
      companion: keruga.oracle_id,
      cards: [{ oracle_id: "c", qty: 1 }],
    });
    expect(validateCompanion(bad, lookupOf(keruga, cheap))).toHaveLength(1);
  });

  it("Lurrus: a high-MV permanent fails; a high-MV nonpermanent is exempt", () => {
    const lurrus = companion("Lurrus of the Dream-Den");
    const bigCreature = card({
      oracle_id: "bc",
      name: "Big Creature",
      type_line: "Creature — Beast",
      mv: 5,
    });
    const bigSpell = card({
      oracle_id: "bs",
      name: "Big Spell",
      type_line: "Sorcery",
      mv: 7,
    });

    const bad = deck({
      companion: lurrus.oracle_id,
      cards: [{ oracle_id: "bc", qty: 1 }],
    });
    expect(validateCompanion(bad, lookupOf(lurrus, bigCreature))).toHaveLength(1);

    const ok = deck({
      companion: lurrus.oracle_id,
      cards: [{ oracle_id: "bs", qty: 1 }],
    });
    expect(validateCompanion(ok, lookupOf(lurrus, bigSpell))).toEqual([]);
  });

  it("Kaheera: flags a creature outside the allowed types, exempts noncreatures", () => {
    const kaheera = companion("Kaheera, the Orphanguard");
    const goblin = card({
      oracle_id: "g",
      name: "Goblin",
      type_line: "Creature — Goblin",
      mv: 1,
    });
    const cat = card({
      oracle_id: "k",
      name: "Cat",
      type_line: "Creature — Cat",
      mv: 1,
    });
    const artifact = card({
      oracle_id: "a",
      name: "Rock",
      type_line: "Artifact",
      mv: 2,
    });

    const bad = deck({
      companion: kaheera.oracle_id,
      cards: [{ oracle_id: "g", qty: 1 }],
    });
    // Kaheera's restriction is heuristic (printed subtypes miss changelings), so the
    // condition is reported unresolved and the heuristic is never a certified break.
    expect(validateCompanion(bad, lookupOf(kaheera, goblin)).map((v) => v.rule)).toEqual([
      "COMPANION_CONDITION_UNRESOLVED",
    ]);

    const ok = deck({
      companion: kaheera.oracle_id,
      cards: [
        { oracle_id: "k", qty: 1 },
        { oracle_id: "a", qty: 1 },
      ],
    });
    const v = validateCompanion(ok, lookupOf(kaheera, cat, artifact));
    expect(v.map((x) => x.rule)).toEqual(["COMPANION_CONDITION_UNRESOLVED"]);
    expect(v[0]?.detail).toContain("heuristic");
  });

  it("checks the commanders too, but never the companion card itself", () => {
    const obosh = companion("Obosh, the Preypiercer");
    const oddCmd = card({
      oracle_id: "cmd",
      name: "Odd Commander",
      type_line: "Legendary Creature — Wizard",
      mv: 3,
    });
    const evenCard = card({ oracle_id: "e", name: "Even", mv: 2 });
    // Obosh wants odd MV or land; the even-MV card in the 99 is the only offender.
    const d = deck({
      companion: obosh.oracle_id,
      commanders: ["cmd"],
      cards: [{ oracle_id: "e", qty: 1 }],
    });
    const v = validateCompanion(d, lookupOf(obosh, oddCmd, evenCard));
    expect(v).toHaveLength(1);
    expect(v[0]?.card?.name).toBe("Even");
  });

  it("reports a companion inside the starting deck as an overlap and evaluates that copy like any other starting card", () => {
    const obosh = card({
      oracle_id: "obosh",
      name: "Obosh, the Preypiercer",
      type_line: "Legendary Creature — Hellion Horror",
      oracle_text: "Companion — Each card in your starting deck has an odd mana value.",
      mv: 5,
    });
    const gyruda = card({
      oracle_id: "gyruda",
      name: "Gyruda, Doom of Depths",
      type_line: "Legendary Creature — Demon Kraken",
      oracle_text: "Companion — Each card in your starting deck has an even mana value.",
      mv: 6,
    });
    const inLibrary = deck({
      companion: gyruda.oracle_id,
      commanders: ["obosh"],
      cards: [{ oracle_id: "gyruda", qty: 1 }],
    });
    // Gyruda's condition (even) is broken by Obosh (5); the in-deck Gyruda copy is even and passes.
    expect(
      validateCompanion(inLibrary, lookupOf(obosh, gyruda)).map((v) => [v.rule, v.card?.name]),
    ).toEqual([
      ["COMPANION_DECK_OVERLAP", "Gyruda, Doom of Depths"],
      ["COMPANION", "Obosh, the Preypiercer"],
    ]);
    const asCommander = deck({ companion: "gyruda", commanders: ["gyruda"], cards: [] });
    expect(checkCompanionOverlap(asCommander).map((v) => v.rule)).toEqual([
      "COMPANION_DECK_OVERLAP",
    ]);
    expect(checkCompanionOverlap(deck({ commanders: ["gyruda"] }))).toEqual([]);
  });
});

/** A canonical record whose characteristics are complete unless overridden. */
function withGameplay(
  base: Card,
  overrides: Partial<Card["gameplay"] & object> = {},
  characteristics: Partial<NonNullable<Card["gameplay"]>["characteristics"]> = {},
): Card {
  return {
    ...base,
    gameplay: {
      version: 1,
      source: { scryfall_id: null, oracle_id: base.oracle_id },
      layout: "normal",
      color_identity: [...base.color_identity],
      face_relationship: "single",
      playability: "not_evaluated",
      characteristics: {
        name: base.name,
        mana_cost: base.mana_cost,
        cmc: base.mv,
        type_line: base.type_line,
        oracle_text: base.oracle_text,
        colors: null,
        color_indicator: null,
        power: null,
        toughness: null,
        loyalty: null,
        defense: null,
        keywords: null,
        produced_mana: null,
        printed_name: null,
        printed_text: null,
        printed_type_line: null,
        ...characteristics,
      },
      faces: null,
      related_cards: null,
      ...overrides,
    },
  };
}

describe("companionCharacteristicsUnknown", () => {
  const plain = card({ oracle_id: "p", name: "Plain", mana_cost: "{1}", mv: 1 });

  it("accepts a legacy flat card and a complete single-face record", () => {
    expect(companionCharacteristicsUnknown(plain)).toBe(false);
    expect(companionCharacteristicsUnknown(withGameplay(plain))).toBe(false);
  });

  it("flags changelings, multiface cards and missing canonical characteristics", () => {
    expect(companionCharacteristicsUnknown({ ...plain, oracle_text: "Changeling" })).toBe(true);
    expect(companionCharacteristicsUnknown({ ...plain, type_line: "Sorcery // Land" })).toBe(true);
    expect(
      companionCharacteristicsUnknown(withGameplay(plain, { face_relationship: "modal" })),
    ).toBe(true);
    expect(companionCharacteristicsUnknown(withGameplay(plain, {}, { cmc: null }))).toBe(true);
    expect(companionCharacteristicsUnknown(withGameplay(plain, {}, { mana_cost: null }))).toBe(
      true,
    );
    expect(companionCharacteristicsUnknown(withGameplay(plain, {}, { type_line: null }))).toBe(
      true,
    );
    expect(companionCharacteristicsUnknown(withGameplay(plain, {}, { oracle_text: null }))).toBe(
      true,
    );
  });
});

describe("resolveCompanionCondition", () => {
  const lurrus = companion("Lurrus of the Dream-Den");
  const yorion = companion("Yorion, Sky Nomad");
  const cheap = card({ oracle_id: "cheap", name: "Cheap", mv: 1, mana_cost: "{1}" });

  it("is exact for a supported companion over complete starting characteristics", () => {
    const d = deck({ companion: lurrus.oracle_id, cards: [{ oracle_id: "cheap", qty: 1 }] });
    expect(resolveCompanionCondition(d, lookupOf(lurrus, cheap))).toEqual({ status: "exact" });
  });

  it("names the unmodeled or heuristic coverage as the reason", () => {
    const d = deck({ cards: [{ oracle_id: "cheap", qty: 1 }] });
    expect(
      resolveCompanionCondition(
        { ...d, companion: "future" },
        lookupOf(companion("future"), cheap),
      ),
    ).toMatchObject({ status: "unresolved", reason: "unmodeled" });
    expect(
      resolveCompanionCondition(
        { ...d, companion: "Zirda, the Dawnwaker" },
        lookupOf(companion("Zirda, the Dawnwaker"), cheap),
      ),
    ).toMatchObject({ status: "unresolved", reason: "heuristic" });
  });

  it("names the starting cards whose characteristics are incomplete, except for Yorion's count-only condition", () => {
    const fuzzy = withGameplay(card({ oracle_id: "fuzzy", name: "Fuzzy" }), {}, { cmc: null });
    const d = deck({
      companion: lurrus.oracle_id,
      commanders: ["fuzzy"],
      cards: [
        { oracle_id: "cheap", qty: 1 },
        { oracle_id: "missing", qty: 1 },
      ],
    });
    expect(resolveCompanionCondition(d, lookupOf(lurrus, cheap, fuzzy))).toEqual({
      status: "unresolved",
      reason: "characteristics",
      cards: [{ oracle_id: "fuzzy", name: "Fuzzy" }],
    });
    expect(
      resolveCompanionCondition({ ...d, companion: yorion.oracle_id }, lookupOf(yorion, fuzzy)),
    ).toEqual({ status: "exact" });
  });

  it("reports nothing without a declared or known companion", () => {
    expect(resolveCompanionCondition(deck({}), lookupOf())).toEqual({ status: "exact" });
    expect(resolveCompanionCondition(deck({ companion: "missing" }), lookupOf())).toEqual({
      status: "exact",
    });
  });

  it("is reported by validateCompanion as COMPANION_CONDITION_UNRESOLVED naming the cards, with certain breaks on the readable cards kept", () => {
    const fuzzy = withGameplay(card({ oracle_id: "fuzzy", name: "Fuzzy" }), {}, { cmc: null });
    const big = card({
      oracle_id: "big",
      name: "Big Golem",
      type_line: "Artifact Creature",
      mv: 5,
    });
    const d = deck({
      companion: lurrus.oracle_id,
      cards: [
        { oracle_id: "fuzzy", qty: 1 },
        { oracle_id: "big", qty: 1 },
      ],
    });
    const v = validateCompanion(d, lookupOf(lurrus, fuzzy, big));
    expect(v.map((x) => [x.rule, x.card?.name])).toEqual([
      ["COMPANION", "Big Golem"],
      ["COMPANION_CONDITION_UNRESOLVED", "Lurrus of the Dream-Den"],
    ]);
    expect(v[1]?.detail).toContain("Fuzzy");
  });
});
