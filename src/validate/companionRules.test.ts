import { describe, it, expect } from "vitest";
import type { Card, Deck } from "../types/index.js";
import { validateCompanion, isCompanionCard, type CardLookup } from "./index.js";

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
  return card({ oracle_id: name, name, oracle_text: `Companion — ${name}'s restriction.` });
}

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

  it("no-ops for a declared companion we do not model", () => {
    const unknown = companion("Some Future Companion");
    const d = deck({ companion: unknown.oracle_id, cards: [{ oracle_id: "a", qty: 1 }] });
    const v = validateCompanion(d, lookupOf(unknown, card({ oracle_id: "a", name: "A", mv: 5 })));
    expect(v).toEqual([]);
  });

  it("Gyruda: passes an all-even deck, flags an odd-MV card", () => {
    const gyruda = companion("Gyruda, Doom of Depths");
    const even = card({ oracle_id: "e", name: "Even", mv: 4 });
    const odd = card({ oracle_id: "o", name: "Odd", mv: 3 });
    const land = card({ oracle_id: "l", name: "Island", type_line: "Basic Land — Island", mv: 0 });

    const ok = deck({
      companion: gyruda.oracle_id,
      cards: [
        { oracle_id: "e", qty: 1 },
        { oracle_id: "l", qty: 1 },
      ],
    });
    expect(validateCompanion(ok, lookupOf(gyruda, even, land))).toEqual([]);

    const bad = deck({ companion: gyruda.oracle_id, cards: [{ oracle_id: "o", qty: 1 }] });
    const v = validateCompanion(bad, lookupOf(gyruda, odd));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: "COMPANION", severity: "error", card: { name: "Odd" } });
  });

  it("Lutri: flags a qty>1 nonland but not multiple basics", () => {
    const lutri = companion("Lutri, the Spellchaser");
    const bolt = card({ oracle_id: "b", name: "Lightning Bolt", type_line: "Instant", mv: 1 });
    const forest = card({
      oracle_id: "f",
      name: "Forest",
      type_line: "Basic Land — Forest",
      mv: 0,
    });

    const bad = deck({ companion: lutri.oracle_id, cards: [{ oracle_id: "b", qty: 2 }] });
    expect(validateCompanion(bad, lookupOf(lutri, bolt))).toHaveLength(1);

    const ok = deck({ companion: lutri.oracle_id, cards: [{ oracle_id: "f", qty: 10 }] });
    expect(validateCompanion(ok, lookupOf(lutri, forest))).toEqual([]);
  });

  it("Jegantha: flags a card with two of the same mana symbol", () => {
    const jegantha = companion("Jegantha, the Wellspring");
    const rr = card({ oracle_id: "rr", name: "Pyrokinesis", mana_cost: "{2}{R}{R}", mv: 4 });
    const fine = card({ oracle_id: "ok", name: "Spell", mana_cost: "{1}{R}{G}", mv: 3 });

    const bad = deck({ companion: jegantha.oracle_id, cards: [{ oracle_id: "rr", qty: 1 }] });
    expect(validateCompanion(bad, lookupOf(jegantha, rr))).toHaveLength(1);

    const ok = deck({ companion: jegantha.oracle_id, cards: [{ oracle_id: "ok", qty: 1 }] });
    expect(validateCompanion(ok, lookupOf(jegantha, fine))).toEqual([]);
  });

  it("Keruga: a land or MV>=3 passes; a cheap nonland fails", () => {
    const keruga = companion("Keruga, the Macrosage");
    const big = card({ oracle_id: "big", name: "Big", mv: 3 });
    const cheap = card({ oracle_id: "c", name: "Cheap", mv: 1 });

    const ok = deck({ companion: keruga.oracle_id, cards: [{ oracle_id: "big", qty: 1 }] });
    expect(validateCompanion(ok, lookupOf(keruga, big))).toEqual([]);

    const bad = deck({ companion: keruga.oracle_id, cards: [{ oracle_id: "c", qty: 1 }] });
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
    const bigSpell = card({ oracle_id: "bs", name: "Big Spell", type_line: "Sorcery", mv: 7 });

    const bad = deck({ companion: lurrus.oracle_id, cards: [{ oracle_id: "bc", qty: 1 }] });
    expect(validateCompanion(bad, lookupOf(lurrus, bigCreature))).toHaveLength(1);

    const ok = deck({ companion: lurrus.oracle_id, cards: [{ oracle_id: "bs", qty: 1 }] });
    expect(validateCompanion(ok, lookupOf(lurrus, bigSpell))).toEqual([]);
  });

  it("Kaheera: flags a creature outside the allowed types, exempts noncreatures", () => {
    const kaheera = companion("Kaheera, the Orphanguard");
    const goblin = card({ oracle_id: "g", name: "Goblin", type_line: "Creature — Goblin", mv: 1 });
    const cat = card({ oracle_id: "k", name: "Cat", type_line: "Creature — Cat", mv: 1 });
    const artifact = card({ oracle_id: "a", name: "Rock", type_line: "Artifact", mv: 2 });

    const bad = deck({ companion: kaheera.oracle_id, cards: [{ oracle_id: "g", qty: 1 }] });
    expect(validateCompanion(bad, lookupOf(kaheera, goblin))).toHaveLength(1);

    const ok = deck({
      companion: kaheera.oracle_id,
      cards: [
        { oracle_id: "k", qty: 1 },
        { oracle_id: "a", qty: 1 },
      ],
    });
    expect(validateCompanion(ok, lookupOf(kaheera, cat, artifact))).toEqual([]);
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
});
