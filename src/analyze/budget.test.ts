import { describe, it, expect } from "vitest";
import type { Card, Deck, Printing, Role } from "../types/index.js";
import { budgetPlan, type CardLookup } from "./index.js";
import { wholeDeckBudget } from "./budget.js";

function printing(usd: string): Printing {
  return {
    scryfall_id: usd,
    set: "x",
    set_name: "X",
    collector_number: "1",
    rarity: "common",
    prices: { usd },
  };
}

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

// A budget reprint: default printing is premium ($5.21), cheapest is $0.30.
const RATS = card({
  oracle_id: "o-rats",
  name: "Relentless Rats",
  type_line: "Creature — Rat",
  prices: { usd: "5.21" },
  printings: [printing("5.21"), printing("0.30")],
  roles: ["wincon"] as Role[],
});
// No reprint savings: single printing at its default price.
const SOL = card({
  oracle_id: "o-sol",
  name: "Sol Ring",
  prices: { usd: "1.50" },
  printings: [printing("1.50")],
  roles: ["mana_rock", "ramp"] as Role[],
});
const lookup: CardLookup = (id) => ({ "o-rats": RATS, "o-sol": SOL })[id] ?? null;

describe("budgetPlan (review #10)", () => {
  it("computes default/min-buy totals, reprint savings, drivers, and target gap", () => {
    const plan = budgetPlan(
      [
        { oracle_id: "o-rats", qty: 3 },
        { oracle_id: "o-sol", qty: 1 },
      ],
      lookup,
      { targetUsd: 1.0 },
    );
    expect(plan.default_total_usd).toBe(17.13); // 5.21*3 + 1.50
    expect(plan.min_buy_usd).toBe(2.4); // 0.30*3 + 1.50
    expect(plan.reprint_savings_usd).toBe(14.73); // (5.21-0.30)*3
    expect(plan.reprint_suggestions).toEqual([
      {
        oracle_id: "o-rats",
        name: "Relentless Rats",
        qty: 3,
        default_usd: 5.21,
        cheapest_usd: 0.3,
        savings: 14.73,
      },
    ]);
    // Cost drivers ranked by contribution (cheapest×qty): Sol 1.50 > Rats 0.90.
    expect(plan.cost_drivers.map((d) => d.oracle_id)).toEqual(["o-sol", "o-rats"]);
    expect(plan.cost_drivers[0]).toMatchObject({
      oracle_id: "o-sol",
      contribution: 1.5,
      roles: ["mana_rock", "ramp"],
    });
    expect(plan.target_usd).toBe(1.0);
    expect(plan.over_min_buy_by_usd).toBe(1.4); // 2.40 - 1.00
  });

  it("reports no over-budget gap when there is no target", () => {
    const plan = budgetPlan([{ oracle_id: "o-sol", qty: 1 }], lookup);
    expect(plan.target_usd).toBeNull();
    expect(plan.over_min_buy_by_usd).toBeNull();
    expect(plan.reprint_suggestions).toEqual([]); // Sol Ring has no cheaper printing
  });
});

describe("budgetPlan — owned collection (bl-collection-budget)", () => {
  const entries = [
    { oracle_id: "o-rats", qty: 3 },
    { oracle_id: "o-sol", qty: 1 },
  ];

  it("is off by default: no owned set => acquire figures are null, other fields unchanged", () => {
    const plan = budgetPlan(entries, lookup);
    expect(plan.min_buy_usd).toBe(2.4);
    expect(plan.acquire_usd).toBeNull();
    expect(plan.owned_value_usd).toBeNull();
    expect(plan.over_acquire_by_usd).toBeNull();
  });

  it("zeroes owned cards: acquire_usd counts only un-owned cards", () => {
    // Own Sol Ring (cheapest 1.50) → acquire = just the Rats (0.30×3 = 0.90).
    const plan = budgetPlan(entries, lookup, { owned: new Set(["o-sol"]) });
    expect(plan.min_buy_usd).toBe(2.4); // full-deck floor unchanged
    expect(plan.acquire_usd).toBe(0.9);
    expect(plan.owned_value_usd).toBe(1.5); // min_buy − acquire
  });

  it("reports the over-acquire gap against the target", () => {
    const plan = budgetPlan(entries, lookup, { owned: new Set(["o-sol"]), targetUsd: 0.5 });
    expect(plan.over_acquire_by_usd).toBe(0.4); // acquire 0.90 − 0.50
    expect(plan.over_min_buy_by_usd).toBe(1.9); // 2.40 − 0.50 (unchanged semantics)
  });

  it("owning everything makes acquire_usd zero", () => {
    const plan = budgetPlan(entries, lookup, { owned: new Set(["o-rats", "o-sol"]) });
    expect(plan.acquire_usd).toBe(0);
    expect(plan.owned_value_usd).toBe(2.4);
  });
});

function deck(p: Partial<Deck> = {}): Deck {
  return {
    deck_id: "budget-deck",
    name: "Budget",
    format: "commander",
    commanders: ["o-sol"],
    command_zone_kind: "single",
    cards: [{ oracle_id: "o-rats", qty: 3 }],
    computed_color_identity: [],
    version: 1,
    data_snapshot: "2026-09-08",
    ...p,
  };
}

describe("wholeDeckBudget", () => {
  it("accounts for one commander, quantities, and a companion outside the deck", () => {
    const result = wholeDeckBudget(deck({ companion: "o-sol" }), lookup, { targetUsd: 1 });
    expect(result.library.minor_units.min_buy).toBe(90);
    expect(result.command_zone.minor_units.min_buy).toBe(150);
    expect(result.full_deck.minor_units.min_buy).toBe(240);
    expect(result.full_deck.over_min_buy_by_usd).toBe(1.4);
    expect(result.companion.minor_units.min_buy).toBe(150);
    expect(result.scope).toMatchObject({
      library_quantity: 3,
      command_zone_quantity: 1,
      full_deck_quantity: 4,
      companion_quantity: 1,
      companion_included: false,
      auxiliary_zones: "not_represented",
    });
  });

  it.each(["partner", "background", "doctor_companion"] as const)(
    "prices both %s command-zone slots",
    (kind) => {
      const result = wholeDeckBudget(
        deck({
          commanders: ["o-sol", "o-rats"],
          command_zone_kind: kind,
          cards: [{ oracle_id: "o-sol", qty: 2 }],
        }),
        lookup,
      );
      expect(result.command_zone.minor_units.min_buy).toBe(180);
      expect(result.full_deck.minor_units.min_buy).toBe(480);
      expect(result.scope.command_library_overlap).toEqual(["o-sol"]);
    },
  );

  it("flags duplicate commanders while retaining every stored copy", () => {
    const result = wholeDeckBudget(deck({ commanders: ["o-sol", "o-sol"], cards: [] }), lookup);
    expect(result.full_deck.minor_units.min_buy).toBe(300);
    expect(result.scope.duplicate_commanders).toEqual(["o-sol"]);
  });

  it("covers owned commander copies and keeps an unresolved companion outside the total", () => {
    const result = wholeDeckBudget(
      deck({ commanders: ["o-sol", "o-sol"], companion: "missing" }),
      lookup,
      { owned: new Set(["o-sol"]), targetUsd: 1 },
    );
    expect(result.full_deck.minor_units).toMatchObject({ min_buy: 390, acquire: 90 });
    expect(result.full_deck.coverage.acquire).toMatchObject({
      complete: true,
      excluded_quantity: 2,
    });
    expect(result.full_deck.target_met).toBe(false);
    expect(result.full_deck.acquire_target_met).toBe(true);
    expect(result.companion.coverage.unresolved).toEqual([{ oracle_id: "missing", qty: 1 }]);
  });

  it("includes unresolved commander quantities and never asserts an incomplete target", () => {
    const result = wholeDeckBudget(
      deck({
        commanders: ["missing"],
        cards: [
          { oracle_id: "missing-library", qty: 2 },
          { oracle_id: "o-rats", qty: 3 },
        ],
      }),
      lookup,
      { targetUsd: 100, owned: new Set(["missing"]) },
    );
    expect(result.full_deck.min_buy_usd).toBe(0.9);
    expect(result.full_deck.coverage).toMatchObject({
      complete: false,
      requested_quantity: 6,
      resolved_quantity: 3,
      unresolved: [
        { oracle_id: "missing-library", qty: 2 },
        { oracle_id: "missing", qty: 1 },
      ],
    });
    expect(result.full_deck.over_min_buy_by_usd).toBeNull();
    expect(result.full_deck.target_met).toBeNull();
    expect(result.full_deck.over_acquire_by_usd).toBeNull();
  });
});

describe("budget price evidence", () => {
  it("distinguishes zero USD from missing/invalid prices and tracks each field", () => {
    const cards = [
      card({ oracle_id: "zero", name: "Zero", prices: { usd: "0.00" } }),
      card({
        oracle_id: "invalid",
        name: "Invalid",
        prices: { usd: "-1" },
        printings: [printing("Infinity")],
      }),
      card({ oracle_id: "only-cheapest", name: "Only cheapest", printings: [printing("0.10")] }),
    ];
    const result = budgetPlan(
      cards.map((c) => ({ oracle_id: c.oracle_id, qty: 2 })),
      (id) => cards.find((c) => c.oracle_id === id) ?? null,
      { targetUsd: 100, owned: new Set(["invalid"]) },
    );
    expect(result.minor_units).toEqual({ default_total: 0, min_buy: 20, acquire: 20 });
    expect(result.coverage.default_total).toMatchObject({
      complete: false,
      priced_quantity: 2,
      missing_quantity: 4,
    });
    expect(result.coverage.min_buy).toMatchObject({
      complete: false,
      priced_quantity: 4,
      missing_quantity: 2,
    });
    expect(result.coverage.acquire).toMatchObject({
      complete: true,
      priced_quantity: 4,
      missing_quantity: 0,
      excluded_quantity: 2,
    });
    expect(result.coverage.missing_prices).toEqual([
      { oracle_id: "invalid", name: "Invalid", qty: 2, fields: ["default_total", "min_buy"] },
      { oracle_id: "only-cheapest", name: "Only cheapest", qty: 2, fields: ["default_total"] },
    ]);
    expect(result.target_met).toBeNull();
    expect(result.acquire_target_met).toBe(true);
    expect(result.ownership_basis).toBe("oracle_id_membership_all_copies");
  });

  it("uses cents before multiplying and accumulating", () => {
    const fractional = card({
      oracle_id: "fractional",
      name: "Fractional",
      prices: { usd: "1.005" },
    });
    const result = budgetPlan([{ oracle_id: "fractional", qty: 3 }], () => fractional, {
      targetUsd: 3.03,
    });
    expect(result.minor_units.min_buy).toBe(303);
    expect(result.min_buy_usd).toBe(3.03);
    expect(result.over_min_buy_by_usd).toBe(0);
    expect(result.target_met).toBe(true);
  });

  it("does not turn a dataset snapshot into a price observation timestamp", () => {
    const result = wholeDeckBudget(deck(), lookup);
    expect(result.full_deck.pricing).toMatchObject({
      currency: "USD",
      source: "scryfall",
      data_snapshot: "2026-09-08",
      price_timestamp: null,
    });
    expect(result.full_deck.freshness).toMatchObject({
      status: "unknown",
      price_timestamp: null,
      unknown_quantity: 4,
    });
  });

  it("keeps missing quantities unknown even when observed prices are fresh", () => {
    const result = budgetPlan(
      [
        { oracle_id: "o-sol", qty: 1 },
        { oracle_id: "missing", qty: 2 },
      ],
      lookup,
      { priceTimestamp: "2026-09-08T00:00:00Z", now: Date.parse("2026-09-08T12:00:00Z") },
    );
    expect(result.freshness).toMatchObject({
      status: "unknown",
      unknown_quantity: 2,
      stale_quantity: 0,
    });
  });

  it.each([
    ["2026-09-08T00:00:00Z", "fresh", 0],
    ["2026-09-06T00:00:00Z", "stale", 1],
    ["bad-date", "unknown", 0],
    ["2026-09-10T00:00:00Z", "unknown", 0],
  ])("classifies actual price timestamp %s as %s", (priceTimestamp, status, staleQuantity) => {
    const result = budgetPlan([{ oracle_id: "o-sol", qty: 1 }], lookup, {
      priceTimestamp,
      now: Date.parse("2026-09-08T12:00:00Z"),
      maxAgeMs: 86_400_000,
    });
    expect(result.freshness.status).toBe(status);
    expect(result.freshness.stale_quantity).toBe(staleQuantity);
  });
});
