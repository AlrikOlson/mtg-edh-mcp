import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoveryFixture, rawCard } from "../analyze/discovery.fixture.js";
import { ConstructionRequestSchema } from "../types/construction.js";
import type { Deck } from "../types/deck.js";
import { constructDeck } from "./construction.js";

let fixture: Awaited<ReturnType<typeof discoveryFixture>>;
beforeAll(async () => {
  fixture = await discoveryFixture([
    rawCard("Leader", "Whenever you draw a card, you gain 1 life.", {
      type_line: "Legendary Creature — Human",
      color_identity: ["G"],
      prices: { usd: "2.00" },
    }),
    rawCard("Forest", "{T}: Add {G}.", {
      type_line: "Basic Land — Forest",
      cmc: 0,
      color_identity: ["G"],
      prices: { usd: "0.10" },
    }),
    rawCard("Draw", "Draw a card.", { type_line: "Sorcery", prices: { usd: "0.20" } }),
    rawCard("Unknown", "Draw a card.", { type_line: "Sorcery" }),
    rawCard("Expensive", "Draw a card.", { type_line: "Sorcery", prices: { usd: "100.00" } }),
    rawCard("Foreign", "Draw a card.", { color_identity: ["U"], prices: { usd: "0.01" } }),
    rawCard("Forbidden", "Draw a card.", {
      legalities: { commander: "banned" },
      prices: { usd: "0.01" },
    }),
  ]);
});
afterAll(async () => fixture.close());
const request = (overrides: Record<string, unknown> = {}) =>
  ConstructionRequestSchema.parse({
    commanders: ["Leader"],
    budget: { mode: "unbounded" },
    ...overrides,
  });
const run = (overrides: Record<string, unknown> = {}, options = {}) =>
  constructDeck(request(overrides), fixture.index, { dataSnapshot: "pinned", ...options });
const saved = (): Deck => ({
  deck_id: "saved",
  name: "Saved",
  format: "commander",
  commanders: ["Leader"],
  command_zone_kind: "single",
  cards: [{ oracle_id: "Forest", qty: 99 }],
  computed_color_identity: ["G"],
  version: 3,
  data_snapshot: "pinned",
});

describe("bounded complete deck construction", () => {
  it("constructs and validates exactly 100 cards, including the requested nonland role", () => {
    const result = run({
      lands: { min: 98, max: 98, strength: "hard" },
      roles: { card_draw: { min: 1, max: 1, strength: "hard" } },
      budget: { mode: "cap", usd: 12 },
    });
    expect(result.status).toBe("found");
    expect(result.validation?.valid).toBe(true);
    expect(result.proposal?.request.cards).toEqual([
      { oracle_id: "Draw", qty: 1 },
      { oracle_id: "Forest", qty: 98 },
    ]);
    expect(result.validation?.budget.min_buy_usd).toBe(12);
  });
  it("keeps locks and explicit strategy ingredients while excluding illegal and foreign cards", () => {
    const result = run({
      intent: {
        schema_version: 1,
        hard: {
          excluded_cards: ["Unknown", "Expensive"],
          locked_cards: [{ oracle_id: "Forest", qty: 98 }],
        },
      },
      strategy_dependencies: [{ id: "draw-engine", strength: "hard", requires_cards: ["Draw"] }],
    });
    expect(result.status).toBe("found");
    expect(result.proposal?.request.cards).toEqual([
      { oracle_id: "Draw", qty: 1 },
      { oracle_id: "Forest", qty: 98 },
    ]);
  });
  it("returns proof only for contradictory mandatory constraints", () => {
    const result = run({
      intent: {
        schema_version: 1,
        hard: { locked_cards: [{ oracle_id: "Draw", qty: 1 }], excluded_cards: ["Draw"] },
      },
    });
    expect(result.status).toBe("proven_conflict");
    expect(result.proposal).toBeNull();
  });
  it("never equates a node bound with infeasibility", () => {
    const result = run({}, { search: { node_limit: 1 } });
    expect(result.status).toBe("search_exhausted");
    expect(result.proposal).toBeNull();
    expect(result.search.truncation.nodes).toBe(true);
  });
  it("keeps unknown hard-budget prices unresolved instead of zero", () => {
    const result = run({
      budget: { mode: "cap", usd: 100 },
      intent: { schema_version: 1, hard: { locked_cards: [{ oracle_id: "Unknown", qty: 1 }] } },
    });
    expect(result.status).toBe("search_exhausted");
    expect(result.diagnostics.some((d) => d.code === "BUDGET_PRICE_UNKNOWN")).toBe(true);
  });
  it("preserves a saved baseline and honors one exact two-copy swap", () => {
    const base = saved();
    const before = structuredClone(base);
    const result = run(
      {
        lands: { min: 98, max: 98, strength: "hard" },
        strategy_dependencies: [{ id: "draw", strength: "hard", requires_cards: ["Draw"] }],
        edit_bounds: { max_changes: 2 },
      },
      { base },
    );
    expect(result.status).toBe("found");
    expect(result.validation?.edits).toEqual({ additions: 1, removals: 1, changes: 2 });
    expect(base).toEqual(before);
  });
  it("returns deterministic complete output for the same snapshot and request", () => {
    expect(run()).toEqual(run());
  });
  it("leaves hard free-text strategy requirements unresolved", () => {
    const result = run({
      requirements: [{ id: "win", text: "Win consistently on turn four", strength: "hard" }],
    });
    expect(result.status).toBe("search_exhausted");
    expect(result.normalization.unresolved_requirements.map((r) => r.id)).toContain("win");
  });
  it("repairs a removable seed commander overlap without claiming an impossible request", () => {
    const result = run({
      cards: [
        { oracle_id: "Leader", qty: 1 },
        { oracle_id: "Forest", qty: 98 },
      ],
    });
    expect(result.status).toBe("found");
    expect(result.proposal?.request.cards.some((entry) => entry.oracle_id === "Leader")).toBe(
      false,
    );
  });
  it("explains unsupported theme-only searches without claiming infeasibility", () => {
    const result = constructDeck(
      ConstructionRequestSchema.parse({ theme: "unmodeled theme", budget: { mode: "unbounded" } }),
      fixture.index,
      { dataSnapshot: "pinned" },
    );
    expect(result.status).toBe("search_exhausted");
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.code === "CONSTRUCTION_THEME_UNRESOLVED"),
    ).toBe(true);
  });
  it("charges rejected inventory expansions against the node bound", () => {
    const constraints = {
      cards: [
        { oracle_id: "Draw", qty: 1 },
        { oracle_id: "Forest", qty: 98 },
      ],
      intent: { schema_version: 1, hard: { locked_cards: [{ oracle_id: "Forest", qty: 98 }] } },
      roles: { card_draw: { min: 0, max: 0, strength: "hard" } },
    };
    expect(run(constraints).status).toBe("found");
    const bounded = run(constraints, { search: { node_limit: 1 } });
    expect(bounded.status).toBe("search_exhausted");
    expect(bounded.search.nodes).toBe(1);
    expect(bounded.search.truncation.nodes).toBe(true);
  });
  it("accounts for theme discovery separately from the inventory search", () => {
    const result = constructDeck(
      ConstructionRequestSchema.parse({ theme: "draw", budget: { mode: "unbounded" } }),
      fixture.index,
      { dataSnapshot: "pinned" },
    );
    expect(result.status).toBe("found");
    expect(result.search.scanned).toBe(fixture.index.count());
    expect(result.search.discovery).toMatchObject({
      scanned: fixture.index.count(),
      pair_checks: 0,
      limits: { scan: 50000, pairs: 10000 },
    });
  });
  it("keeps a valid long construction theme semantic instead of throwing a narrower discovery schema error", () => {
    const result = constructDeck(
      ConstructionRequestSchema.parse({ theme: "x".repeat(201), budget: { mode: "unbounded" } }),
      fixture.index,
      { dataSnapshot: "pinned" },
    );
    expect(result.status).toBe("search_exhausted");
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.code === "CONSTRUCTION_THEME_UNRESOLVED"),
    ).toBe(true);
  });
});
