import { describe, it, expect } from "vitest";
import type { Card, DeckCardEntry } from "../types/index.js";
import { simulateDeck, type CardLookup } from "./index.js";

function card(p: Partial<Card> & { oracle_id: string; name: string }): Card {
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
    ...p,
  };
}

/** Build a library of `lands` basic lands + `spells` creatures (mv alternates 1,2). */
function fixture(lands: number, spells: number): { entries: DeckCardEntry[]; lookup: CardLookup } {
  const cards = new Map<string, Card>();
  const entries: DeckCardEntry[] = [];
  for (let i = 0; i < lands; i += 1) {
    const id = `l${i}`;
    cards.set(
      id,
      card({ oracle_id: id, name: `Forest ${i}`, mv: 0, type_line: "Basic Land — Forest" }),
    );
    entries.push({ oracle_id: id, qty: 1 });
  }
  for (let i = 0; i < spells; i += 1) {
    const id = `s${i}`;
    cards.set(
      id,
      card({ oracle_id: id, name: `Bear ${i}`, mv: (i % 2) + 1, type_line: "Creature — Bear" }),
    );
    entries.push({ oracle_id: id, qty: 1 });
  }
  const lookup: CardLookup = (id) => cards.get(id) ?? null;
  return { entries, lookup };
}

describe("simulateDeck (goldfish)", () => {
  it("is deterministic for a fixed seed (run-twice deepEqual)", () => {
    const { entries, lookup } = fixture(38, 61); // ~99-card singleton deck
    const a = simulateDeck(entries, lookup, { trials: 500, seed: 7 });
    const b = simulateDeck(entries, lookup, { trials: 500, seed: 7 });
    expect(b).toEqual(a);
  });

  it("produces exact stats for a known fixture + seed", () => {
    const { entries, lookup } = fixture(17, 16);
    const r = simulateDeck(entries, lookup, { trials: 200, seed: 42, maxTurns: 5 });
    expect(r).toMatchObject({
      trials: 200,
      keepable_rate: 0.89,
      mulligan_rate: 0.11,
      dead_on_arrival_rate: 0.11,
      avg_opening_lands: 3.715,
      lands_by_turn: { 1: 1, 2: 1.985, 3: 2.945, 4: 3.89, 5: 4.795 },
      first_spell_rate: 1,
      avg_turn_to_first_spell: 1.16,
    });
    // The new shape/distribution fields partition the same trials.
    const distSum = Object.values(r.opening_land_distribution).reduce((s, v) => s + v, 0);
    const scenarioSum = Object.values(r.scenarios).reduce((s, v) => s + v, 0);
    expect(round1(distSum)).toBe(1);
    expect(round1(scenarioSum)).toBe(1);
  });

  it("a different seed gives a different (still valid) result", () => {
    const { entries, lookup } = fixture(17, 16);
    const a = simulateDeck(entries, lookup, { trials: 200, seed: 42, maxTurns: 5 });
    const b = simulateDeck(entries, lookup, { trials: 200, seed: 99, maxTurns: 5 });
    expect(b).not.toEqual(a);
    for (const r of [a, b]) {
      expect(r.keepable_rate).toBeGreaterThanOrEqual(0);
      expect(r.keepable_rate).toBeLessThanOrEqual(1);
      expect(round1(r.mulligan_rate + r.keepable_rate)).toBe(1);
    }
  });

  it("lands-by-turn is non-decreasing (≤ one land drop per turn)", () => {
    const { entries, lookup } = fixture(40, 59);
    const r = simulateDeck(entries, lookup, { trials: 300, seed: 3, maxTurns: 8 });
    for (let t = 2; t <= 8; t += 1) {
      expect(r.lands_by_turn[t]!).toBeGreaterThanOrEqual(r.lands_by_turn[t - 1]!);
      expect(r.lands_by_turn[t]! - r.lands_by_turn[t - 1]!).toBeLessThanOrEqual(1.0001);
    }
  });

  it("classifies opening-hand shapes from roles, not names", () => {
    const cards = new Map<string, Card>();
    const entries: DeckCardEntry[] = [];
    const put = (id: string, c: Card, qty: number): void => {
      cards.set(id, c);
      entries.push({ oracle_id: id, qty });
    };
    put("land", card({ oracle_id: "land", name: "Forest", type_line: "Basic Land — Forest" }), 36);
    // A 1mv rock: accel AND fast mana (Sol Ring-shaped), by role — the name is deliberately unhelpful.
    put(
      "rock",
      card({
        oracle_id: "rock",
        name: "Totally Not A Land Vault",
        mv: 1,
        roles: ["mana_rock", "ramp"],
      }),
      10,
    );
    // Expensive payoffs: no accel role, mv 7.
    put(
      "bomb",
      card({ oracle_id: "bomb", name: "Big Dragon", mv: 7, type_line: "Creature — Dragon" }),
      53,
    );
    const lookup: CardLookup = (id) => cards.get(id) ?? null;
    const r = simulateDeck(entries, lookup, { trials: 2000, seed: 5 });

    // With 10 fast rocks, every non-mulligan bucket should appear, including
    // explosive; and with only 7-drops as spells, the no-accel 3-4 land hands
    // must all land in top_heavy_trap, never playable_no_accel.
    expect(r.scenarios.textbook).toBeGreaterThan(0);
    expect(r.scenarios.explosive).toBeGreaterThan(0);
    expect(r.scenarios.top_heavy_trap).toBeGreaterThan(0);
    expect(r.scenarios.playable_no_accel).toBe(0);
    expect(r.scenarios.other).toBe(0);

    // Cheap spells instead of bombs: the same no-accel hands become playable.
    cards.set("bomb", card({ oracle_id: "bomb", name: "Bear", mv: 2, type_line: "Creature" }));
    const cheap = simulateDeck(entries, lookup, { trials: 2000, seed: 5 });
    expect(cheap.scenarios.top_heavy_trap).toBe(0);
    expect(cheap.scenarios.playable_no_accel).toBeGreaterThan(0);
  });

  it("a land-light deck mulligans more and is more dead-on-arrival than a balanced one", () => {
    const balanced = fixture(38, 61);
    const landLight = fixture(12, 87);
    const b = simulateDeck(balanced.entries, balanced.lookup, { trials: 500, seed: 11 });
    const l = simulateDeck(landLight.entries, landLight.lookup, { trials: 500, seed: 11 });
    expect(l.keepable_rate).toBeLessThan(b.keepable_rate);
    expect(l.dead_on_arrival_rate).toBeGreaterThan(b.dead_on_arrival_rate);
  });
});

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
