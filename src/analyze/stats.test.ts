import { describe, it, expect } from "vitest";
import type { Card, Color, DeckCardEntry, Role } from "../types/index.js";
import {
  analyzeCurve,
  analyzeComposition,
  analyzeStats,
  cheapestUsd,
  defaultUsd,
  type CardLookup,
} from "./index.js";

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

const SOL = card({
  oracle_id: "o-sol",
  name: "Sol Ring",
  mv: 1,
  type_line: "Artifact",
  mana_cost: "{1}",
  roles: ["ramp", "mana_rock"] as Role[],
  prices: { usd: "1.50" },
});
const FOREST = card({
  oracle_id: "o-forest",
  name: "Forest",
  mv: 0,
  type_line: "Basic Land — Forest",
  color_identity: ["G"] as Color[],
  roles: ["land"] as Role[],
  prices: { usd: "0.10" },
});
const COUNTER = card({
  oracle_id: "o-counter",
  name: "Counterspell",
  mv: 2,
  type_line: "Instant",
  mana_cost: "{U}{U}",
  color_identity: ["U"] as Color[],
  roles: ["counterspell"] as Role[],
  prices: { usd: "1.00" },
});

const lookup: CardLookup = (id) =>
  ({ "o-sol": SOL, "o-forest": FOREST, "o-counter": COUNTER })[id] ?? null;

// 1 Sol Ring + 4 Forest + 1 Counterspell = 6 cards.
const DECK: DeckCardEntry[] = [
  { oracle_id: "o-sol", qty: 1 },
  { oracle_id: "o-forest", qty: 4 },
  { oracle_id: "o-counter", qty: 1 },
];

describe("analyzeCurve", () => {
  it("buckets mana value quantity-weighted", () => {
    expect(analyzeCurve(DECK, lookup)).toEqual({ buckets: { "0": 4, "1": 1, "2": 1 }, total: 6 });
  });
  it("excludes lands when asked", () => {
    expect(analyzeCurve(DECK, lookup, { exclude_lands: true })).toEqual({
      buckets: { "1": 1, "2": 1 },
      total: 2,
    });
  });
  it("filters by role", () => {
    expect(analyzeCurve(DECK, lookup, { role: "ramp" })).toEqual({ buckets: { "1": 1 }, total: 1 });
  });
  it("filters by color identity", () => {
    expect(analyzeCurve(DECK, lookup, { color: "U" })).toEqual({ buckets: { "2": 1 }, total: 1 });
  });
});

describe("analyzeComposition", () => {
  it("counts by type and by role, quantity-weighted", () => {
    const r = analyzeComposition(DECK, lookup);
    expect(r.total).toBe(6);
    expect(r.by_type).toEqual({ Artifact: 1, Land: 4, Instant: 1 });
    expect(r.by_role).toEqual({ ramp: 1, mana_rock: 1, land: 4, counterspell: 1 });
  });
});

describe("analyzeStats", () => {
  it("computes exact counts, averages, pips, and price", () => {
    const r = analyzeStats(DECK, lookup);
    expect(r.total_cards).toBe(6);
    expect(r.nonland_cards).toBe(2);
    expect(r.avg_mv).toBe(0.5); // (1 + 0*4 + 2) / 6
    expect(r.avg_mv_nonland).toBe(1.5); // (1 + 2) / 2
    expect(r.color_pips).toEqual({ W: 0, U: 2, B: 0, R: 0, G: 0 });
    expect(r.total_price_usd).toBe(2.9); // 1.50 + 4*0.10 + 1.00
  });
});

describe("cheapest-printing pricing + min buy (review #4)", () => {
  // A budget reprint whose default/chosen price is a premium printing, but whose
  // cheapest printing is far lower (the Relentless Rats situation).
  const RAT = card({
    oracle_id: "o-rat",
    name: "Relentless Rats",
    mv: 4,
    type_line: "Creature — Rat",
    mana_cost: "{3}{B}",
    color_identity: ["B"] as Color[],
    prices: { usd: "5.21" }, // default = a premium printing
    printings: [
      {
        scryfall_id: "p1",
        set: "a",
        set_name: "A",
        collector_number: "1",
        rarity: "common",
        prices: { usd: "5.21" },
      },
      {
        scryfall_id: "p2",
        set: "b",
        set_name: "B",
        collector_number: "2",
        rarity: "common",
        prices: { usd: "0.30" },
      },
      {
        scryfall_id: "p3",
        set: "c",
        set_name: "C",
        collector_number: "3",
        rarity: "common",
        prices: {},
      }, // unpriced
    ],
  });

  it("cheapestUsd picks the lowest priced printing; defaultUsd is the chosen price", () => {
    expect(defaultUsd(RAT)).toBe(5.21);
    expect(cheapestUsd(RAT)).toBe(0.3);
  });

  it("falls back to the default price when no printing carries a price", () => {
    const noPrintings = card({ oracle_id: "o-x", name: "X", prices: { usd: "2.00" } });
    expect(cheapestUsd(noPrintings)).toBe(2);
    const unpriced = card({ oracle_id: "o-y", name: "Y", prices: {} });
    expect(cheapestUsd(unpriced)).toBeNull();
    expect(defaultUsd(unpriced)).toBeNull();
  });

  it("analyze_stats reports a default total AND a much lower min-buy total", () => {
    const lookup2: CardLookup = (id) => (id === "o-rat" ? RAT : null);
    const r = analyzeStats([{ oracle_id: "o-rat", qty: 10 }], lookup2);
    expect(r.total_price_usd).toBe(52.1); // 10 * 5.21 (default)
    expect(r.min_buy_usd).toBe(3); // 10 * 0.30 (cheapest)
  });
});

describe("price parsing and minor-unit totals", () => {
  it.each(["-1", "Infinity", "NaN", "", " ", "not a price", "0x10"])(
    "rejects invalid USD %s",
    (usd) => {
      const invalid = card({ oracle_id: "invalid", name: "Invalid", prices: { usd } });
      expect(defaultUsd(invalid)).toBeNull();
      expect(cheapestUsd(invalid)).toBeNull();
    },
  );

  it("accumulates rounded minor units, including repeated fractional-cent prices", () => {
    const fractional = card({
      oracle_id: "fractional",
      name: "Fractional",
      prices: { usd: "1.005" },
    });
    const stats = analyzeStats([{ oracle_id: "fractional", qty: 3 }], () => fractional);
    expect(stats.total_price_usd).toBe(3.03);
    expect(stats.min_buy_usd).toBe(3.03);
  });
});
