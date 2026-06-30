import { describe, it, expect } from "vitest";
import type { Card, Printing, Role } from "../types/index.js";
import { budgetPlan, type CardLookup } from "./index.js";

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
