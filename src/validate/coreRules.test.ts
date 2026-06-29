import { describe, it, expect } from "vitest";
import type { Card, Color, Deck, DeckCardEntry } from "../types/index.js";
import {
  validateCore,
  checkCardCount,
  checkSingleton,
  checkColorIdentity,
  checkBanlist,
  type CardLookup,
} from "./index.js";

/** Build a full Card with sensible defaults; override what a test cares about. */
function card(partial: Partial<Card> & { oracle_id: string; name: string }): Card {
  return {
    mana_cost: "",
    mv: 0,
    colors: [],
    color_identity: [],
    type_line: "Artifact",
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

/** A lookup over a fixed set of cards. */
function lookupOf(...cards: Card[]): CardLookup {
  const byId = new Map(cards.map((c) => [c.oracle_id, c]));
  return (id) => byId.get(id) ?? null;
}

function deck(partial: Partial<Deck>): Deck {
  return {
    deck_id: "d1",
    name: "Test",
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

/** N distinct singleton entries, oracle ids c0..c(N-1). */
function fillerEntries(n: number): DeckCardEntry[] {
  return Array.from({ length: n }, (_, i) => ({ oracle_id: `c${i}`, qty: 1 }));
}

describe("checkCardCount", () => {
  it("passes at exactly 100 including the command zone", () => {
    const d = deck({ commanders: ["cmd"], cards: fillerEntries(99) });
    expect(checkCardCount(d)).toEqual([]);
  });

  it("flags a deck one short of 100 with the delta", () => {
    const d = deck({ commanders: ["cmd"], cards: fillerEntries(98) }); // 1 + 98 = 99
    const v = checkCardCount(d);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: "CARD_COUNT", severity: "error" });
    expect(v[0]?.detail).toContain("99");
    expect(v[0]?.detail).toContain("short");
  });

  it("flags a deck one over 100", () => {
    const d = deck({ commanders: ["cmd"], cards: fillerEntries(100) }); // 1 + 100 = 101
    const v = checkCardCount(d);
    expect(v[0]?.detail).toContain("over");
  });
});

describe("checkSingleton", () => {
  const sol = card({ oracle_id: "o-sol", name: "Sol Ring" });
  const plains = card({ oracle_id: "o-plains", name: "Plains", type_line: "Basic Land — Plains" });
  const rats = card({
    oracle_id: "o-rats",
    name: "Relentless Rats",
    type_line: "Creature — Rat",
    oracle_text: "A deck can have any number of cards named Relentless Rats.",
  });
  const allowlisted = card({
    oracle_id: "o-pp",
    name: "Persistent Petitioners",
    type_line: "Creature — Advisor",
    oracle_text: "", // text doesn't grant — relies on the curated allowlist
  });
  const lookup = lookupOf(sol, plains, rats, allowlisted);

  it("flags a non-exempt card with qty > 1", () => {
    const v = checkSingleton(deck({ cards: [{ oracle_id: "o-sol", qty: 4 }] }), lookup);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: "SINGLETON", severity: "error" });
    expect(v[0]?.card).toEqual({ oracle_id: "o-sol", name: "Sol Ring" });
  });

  it("allows many basic lands", () => {
    expect(checkSingleton(deck({ cards: [{ oracle_id: "o-plains", qty: 37 }] }), lookup)).toEqual(
      [],
    );
  });

  it("allows a card whose oracle text grants any number (regex fallback)", () => {
    expect(checkSingleton(deck({ cards: [{ oracle_id: "o-rats", qty: 30 }] }), lookup)).toEqual([]);
  });

  it("allows a curated any-number card even without matching text", () => {
    expect(checkSingleton(deck({ cards: [{ oracle_id: "o-pp", qty: 18 }] }), lookup)).toEqual([]);
  });
});

describe("checkColorIdentity", () => {
  const offColor = card({
    oracle_id: "o-bolt",
    name: "Lightning Bolt",
    color_identity: ["R"] as Color[],
  });
  const onColor = card({
    oracle_id: "o-counter",
    name: "Counterspell",
    color_identity: ["U"] as Color[],
  });
  const lookup = lookupOf(offColor, onColor);

  it("flags a card whose identity is outside the deck identity", () => {
    const d = deck({
      computed_color_identity: ["U"] as Color[],
      cards: [{ oracle_id: "o-bolt", qty: 1 }],
    });
    const v = checkColorIdentity(d, lookup);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: "COLOR_IDENTITY", severity: "error" });
    expect(v[0]?.detail).toContain("R");
  });

  it("accepts an in-identity card", () => {
    const d = deck({
      computed_color_identity: ["U"] as Color[],
      cards: [{ oracle_id: "o-counter", qty: 1 }],
    });
    expect(checkColorIdentity(d, lookup)).toEqual([]);
  });
});

describe("checkBanlist", () => {
  const banned = card({
    oracle_id: "o-recur",
    name: "Recurring Nightmare",
    legalities: { commander: "banned" },
  });
  const legal = card({ oracle_id: "o-sol", name: "Sol Ring", legalities: { commander: "legal" } });
  const lookup = lookupOf(banned, legal);

  it("flags a card banned in Commander, derived from legalities only", () => {
    const v = checkBanlist(deck({ cards: [{ oracle_id: "o-recur", qty: 1 }] }), lookup);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: "BANLIST", severity: "error" });
    expect(v[0]?.card?.name).toBe("Recurring Nightmare");
  });

  it("does not flag a legal card", () => {
    expect(checkBanlist(deck({ cards: [{ oracle_id: "o-sol", qty: 1 }] }), lookup)).toEqual([]);
  });

  it("also checks commanders for bans", () => {
    const v = checkBanlist(deck({ commanders: ["o-recur"] }), lookup);
    expect(v).toHaveLength(1);
  });
});

describe("validateCore", () => {
  it("aggregates violations across all four rules", () => {
    const banned = card({
      oracle_id: "o-recur",
      name: "Recurring Nightmare",
      color_identity: ["B"] as Color[],
      legalities: { commander: "banned" },
    });
    const lookup = lookupOf(banned);
    const d = deck({
      computed_color_identity: ["U"] as Color[],
      cards: [{ oracle_id: "o-recur", qty: 2 }], // count short, singleton, off-color, banned
    });
    const rules = validateCore(d, lookup).map((v) => v.rule);
    expect(rules).toContain("CARD_COUNT");
    expect(rules).toContain("SINGLETON");
    expect(rules).toContain("COLOR_IDENTITY");
    expect(rules).toContain("BANLIST");
  });
});
