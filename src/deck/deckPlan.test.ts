import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoveryFixture, rawCard } from "../analyze/discovery.fixture.js";
import { DeckPlanRequestSchema } from "../types/deckPlan.js";
import type { Deck } from "../types/deck.js";
import { prepareDeckChange } from "./deckPlan.js";

let fixture: Awaited<ReturnType<typeof discoveryFixture>>;
beforeAll(async () => {
  fixture = await discoveryFixture([
    rawCard("Leader", "", {
      oracle_id: "leader-id",
      type_line: "Legendary Creature — Beast",
      color_identity: ["G"],
      prices: { usd: "10.00" },
    }),
    rawCard("Other Leader", "", {
      type_line: "Legendary Creature — Beast",
      color_identity: ["G"],
      prices: { usd: "1.00" },
    }),
    rawCard("Forest", "{T}: Add {G}.", {
      type_line: "Basic Land — Forest",
      cmc: 0,
      color_identity: ["G"],
      prices: { usd: "0.25" },
    }),
    rawCard("Spell", "Draw a card.", { type_line: "Sorcery", prices: { usd: "4.00" } }),
    rawCard("Unknown Price", "Draw a card.", { type_line: "Sorcery" }),
    rawCard("Not Legal", "", { legalities: { commander: "not_legal" } }),
    rawCard("Seven Dwarves", "A deck can have up to seven cards named Seven Dwarves."),
    rawCard(
      "Kaheera, the Orphanguard",
      "Companion — Each creature card in your starting deck is a Cat, Elemental, Nightmare, Dinosaur, or Beast.",
      { type_line: "Legendary Creature — Cat Beast", color_identity: ["G"] },
    ),
    rawCard("Bala Ged Recovery // Bala Ged Sanctuary", "", {
      layout: "modal_dfc",
      type_line: "Sorcery // Land",
      card_faces: [
        { name: "Bala Ged Recovery", type_line: "Sorcery" },
        { name: "Bala Ged Sanctuary", type_line: "Land" },
      ],
    }),
  ]);
});
afterAll(async () => fixture.close());
const inventory = (forest = 99) => [{ oracle_id: "Forest", qty: forest }];
const base = (): Deck => ({
  deck_id: "saved",
  name: "Saved",
  format: "commander",
  commanders: ["leader-id"],
  command_zone_kind: "single",
  cards: inventory(),
  computed_color_identity: ["G"],
  version: 7,
  data_snapshot: "old",
});
const prepare = (request: Record<string, unknown>, deck?: Deck) =>
  prepareDeckChange(
    DeckPlanRequestSchema.parse({
      request: {
        commanders: ["Leader"],
        budget: { mode: "unbounded" },
        cards: inventory(),
        ...request,
      },
    }),
    fixture.index,
    deck,
    "current",
  );
const codes = (result: ReturnType<typeof prepare>) =>
  result.validation.diagnostics.map((d) => d.code);

describe("deck change desired-state validation", () => {
  it("requires an exact desired inventory at the boundary", () => {
    expect(DeckPlanRequestSchema.safeParse({ request: {} }).success).toBe(false);
  });
  it("prepares a complete legal deck without mutating the saved deck", () => {
    const saved = base();
    const before = structuredClone(saved);
    const result = prepare({ cards: [...inventory(98), { oracle_id: "Spell", qty: 1 }] }, saved);
    expect(result.validation.valid).toBe(true);
    expect(result.validation.edits).toEqual({ additions: 1, removals: 1, changes: 2 });
    expect(result.desired).toMatchObject({
      deck_id: "saved",
      name: "Saved",
      version: 8,
      data_snapshot: "current",
      commanders: ["leader-id"],
    });
    expect(saved).toEqual(before);
  });
  it("rejects incomplete whole decks even when normalization is ready", () => {
    const result = prepare({ cards: inventory(98) });
    expect(result.validation.normalization.status).toBe("ready");
    expect(result.validation.valid).toBe(false);
    expect(result.validation.legality.some((v) => v.rule === "CARD_COUNT")).toBe(true);
  });
  it.each([
    { id: "Not Legal", qty: 1, code: "FORMAT_ILLEGAL" },
    { id: "Not Indexed", qty: 1, code: "UNKNOWN_CARD" },
    { id: "Seven Dwarves", qty: 8, code: "COPY_LIMIT_EXCEEDED" },
  ])("blocks full-inventory uncertainty or violations for $id", ({ id, qty, code }) => {
    const result = prepare({ cards: [...inventory(99 - qty), { oracle_id: id, qty }] });
    expect(result.validation.valid).toBe(false);
    expect(codes(result)).toContain(code);
  });
  it("enforces saved locked/excluded cards and refuses an intent replacement", () => {
    const saved = base();
    saved.intent = {
      schema_version: 1,
      hard: { locked_cards: [{ oracle_id: "Forest", qty: 99 }], excluded_cards: ["Spell"] },
    };
    const result = prepare(
      { cards: [...inventory(98), { oracle_id: "Spell", qty: 1 }], intent: { schema_version: 1 } },
      saved,
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "INTENT_OVERRIDE_CONFLICT",
        "LOCKED_CARD_MISSING",
        "EXCLUDED_CARD_PRESENT",
      ]),
    );
    expect(result.desired.intent).toEqual(saved.intent);
  });
  it("counts a swap as two edits and preserves saved role overrides", () => {
    const saved = base();
    saved.intent = { schema_version: 1, hard: { change_limit: 1 } };
    saved.role_overrides = { Spell: [] };
    const result = prepare(
      {
        cards: [...inventory(98), { oracle_id: "Spell", qty: 1 }],
        roles: { card_draw: { min: 1, max: 1, strength: "hard" } },
      },
      saved,
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining(["EDIT_BOUND_EXCEEDED", "ROLE_RANGE_UNMET"]),
    );
    expect(result.desired.role_overrides).toEqual(saved.role_overrides);
  });
  it("checks the full deck budget including commander prices and blocks missing prices under a cap", () => {
    expect(codes(prepare({ budget: { mode: "cap", usd: 30 } }))).toContain("BUDGET_CAP_EXCEEDED");
    const unknown = prepare({
      budget: { mode: "cap", usd: 100 },
      cards: [...inventory(98), { oracle_id: "Unknown Price", qty: 1 }],
    });
    expect(codes(unknown)).toContain("BUDGET_PRICE_UNKNOWN");
    expect(unknown.validation.valid).toBe(false);
  });
  it("keeps a missed preferred budget target advisory", () => {
    const result = prepare({ budget: { mode: "target", usd: 1 } });
    expect(result.validation.valid).toBe(true);
    expect(codes(result)).toContain("BUDGET_TARGET_UNMET");
  });
  it("fails closed for unsupported hard requirements and companion conditions", () => {
    const unsupported = prepare({
      requirements: [{ id: "win", text: "Always win by turn four", strength: "hard" }],
    });
    expect(unsupported.validation.valid).toBe(false);
    const companion = prepare({ companion: "Kaheera, the Orphanguard" });
    expect(companion.validation.valid).toBe(false);
    expect(codes(companion)).toContain("COMPANION_CONDITION_UNRESOLVED");
  });
  it("checks final land counts and does not guess a multiface counting policy", () => {
    expect(codes(prepare({ lands: { min: 35, max: 40, strength: "hard" } }))).toContain(
      "LAND_RANGE_UNMET",
    );
    const result = prepare({
      cards: [...inventory(98), { oracle_id: "Bala Ged Recovery // Bala Ged Sanctuary", qty: 1 }],
      lands: { min: 0, max: 99, strength: "hard" },
    });
    expect(codes(result)).toContain("LAND_COUNT_UNRESOLVED");
    expect(result.validation.land_count).toBeNull();
  });
  it("permits a legal promotion from the old library into the command zone", () => {
    const saved = base();
    saved.cards = [...inventory(98), { oracle_id: "Other Leader", qty: 1 }];
    const result = prepare(
      { commanders: ["Other Leader"], cards: [...inventory(98), { oracle_id: "Leader", qty: 1 }] },
      saved,
    );
    expect(result.validation.valid).toBe(true);
    expect(result.validation.edits).toEqual({ additions: 2, removals: 2, changes: 4 });
  });
  it("can repair an unknown source card by removing it from the desired inventory", () => {
    const saved = base();
    saved.cards = [...inventory(98), { oracle_id: "No Longer Indexed", qty: 1 }];
    const result = prepare({}, saved);
    expect(result.validation.valid).toBe(true);
    expect(result.validation.edits).toEqual({ additions: 1, removals: 1, changes: 2 });
  });
  it("requires every hard strategy ingredient in the final inventory", () => {
    const result = prepare({
      strategy_dependencies: [{ id: "draw", strength: "hard", requires_cards: ["Spell"] }],
    });
    expect(result.validation.valid).toBe(false);
    expect(codes(result)).toContain("STRATEGY_CARD_MISSING");
  });
  it("preserves unresolved preferred requirements without blocking a legal inventory", () => {
    const result = prepare({
      requirements: [{ id: "theme", text: "Tell a woodland story", strength: "preferred" }],
    });
    expect(result.validation.valid).toBe(true);
    expect(result.validation.normalization.unresolved_requirements).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "theme", strength: "preferred" })]),
    );
  });
  it("keeps unknown preferred strategy ingredients advisory while hard ingredients block", () => {
    const dependency = { id: "wish", requires_cards: ["Not Indexed"] };
    const preferred = prepare({
      strategy_dependencies: [{ ...dependency, strength: "preferred" }],
    });
    expect(preferred.validation.valid).toBe(true);
    expect(preferred.validation.normalization.choices).toEqual([]);
    expect(preferred.validation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNKNOWN_CARD", severity: "advisory" }),
      ]),
    );
    const hard = prepare({ strategy_dependencies: [{ ...dependency, strength: "hard" }] });
    expect(hard.validation.valid).toBe(false);
    expect(hard.validation.normalization.choices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/strategy_dependencies/0/requires_cards/0" }),
      ]),
    );
  });
});
