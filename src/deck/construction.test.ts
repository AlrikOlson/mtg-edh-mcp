import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoveryFixture, rawCard } from "../analyze/discovery.fixture.js";
import { ConstructionRequestSchema } from "../types/construction.js";
import type { Deck } from "../types/deck.js";
import { normalizeConstruction } from "./construction.js";

let fixture: Awaited<ReturnType<typeof discoveryFixture>>;
beforeAll(async () => {
  fixture = await discoveryFixture([
    rawCard("Leader", "", {
      oracle_id: "leader-id",
      type_line: "Legendary Creature — Beast",
      cmc: 3,
      prices: { usd: "10.00" },
      color_identity: ["G"],
    }),
    rawCard("Other Leader", "", { type_line: "Legendary Creature — Beast", color_identity: ["G"] }),
    rawCard(
      "Kaheera, the Orphanguard",
      "Companion — Each creature card in your starting deck is a Cat, Elemental, Nightmare, Dinosaur, or Beast.",
      { type_line: "Legendary Creature — Cat Beast", color_identity: ["G"] },
    ),
    rawCard("Masked Vandal", "Changeling", {
      type_line: "Creature — Shapeshifter",
      color_identity: ["G"],
    }),
    rawCard("Unmodeled Copies", "A deck can have up to eleven cards named Unmodeled Copies."),
    rawCard(
      "Bala Ged Recovery // Bala Ged Sanctuary",
      "Return target card from your graveyard to your hand.",
      {
        layout: "modal_dfc",
        type_line: "Sorcery // Land",
        card_faces: [
          {
            name: "Bala Ged Recovery",
            type_line: "Sorcery",
            oracle_text: "Return target card from your graveyard to your hand.",
          },
          { name: "Bala Ged Sanctuary", type_line: "Land", oracle_text: "{T}: Add {G}." },
        ],
      },
    ),
    rawCard("Unknown Mana Cost", "", { mana_cost: null }),
    rawCard(
      "Gyruda, Doom of Depths",
      "Companion — Each card in your starting deck has an even mana value.",
      { type_line: "Legendary Creature — Demon Kraken" },
    ),
    rawCard("Banned Card", "", { legalities: { commander: "banned" } }),
    rawCard("Partner A", "Partner", {
      type_line: "Legendary Creature — Human",
      prices: { usd: "2.00" },
    }),
    rawCard("Partner B", "Partner", {
      type_line: "Legendary Creature — Human",
      prices: { usd: "2.00" },
    }),
    rawCard("Forest", "{T}: Add {G}.", {
      type_line: "Basic Land — Forest",
      cmc: 0,
      color_identity: ["G"],
      prices: { usd: "0.25" },
    }),
    rawCard("Spell", "Draw a card.", { type_line: "Sorcery", prices: { usd: "4.00" } }),
    rawCard("Unknown Price", "Draw a card.", { type_line: "Sorcery" }),
    rawCard(
      "Lurrus of the Dream-Den",
      "Companion — Each permanent card in your starting deck has mana value 2 or less.",
      { type_line: "Legendary Creature — Cat Nightmare", color_identity: ["W", "B"] },
    ),
    rawCard(
      "Yorion, Sky Nomad",
      "Companion — Your starting deck contains at least twenty cards more than the minimum deck size.",
      { type_line: "Legendary Creature — Bird Serpent" },
    ),
  ]);
});
afterAll(async () => fixture.close());
const normalize = (request: unknown, deck?: Deck) =>
  normalizeConstruction(ConstructionRequestSchema.parse(request), fixture.index, deck);
const chosen = { commanders: ["Leader"], budget: { mode: "unbounded" } };
const saved = (): Deck => ({
  deck_id: "saved",
  name: "Seed",
  format: "commander",
  commanders: ["leader-id"],
  command_zone_kind: "single",
  cards: [{ oracle_id: "Forest", qty: 36 }],
  computed_color_identity: ["G"],
  version: 7,
  data_snapshot: "2026-09-08",
});

describe("construction normalization", () => {
  it("resolves exact names and preserves quantity independently of overlapping roles", () => {
    const result = normalize({
      ...chosen,
      cards: [{ oracle_id: "Forest", qty: 36 }],
      roles: {
        ramp: { min: 60, max: 80, strength: "hard" },
        card_draw: { min: 60, max: 80, strength: "hard" },
      },
    });
    expect(result.status).toBe("ready");
    expect(result.specification.command_zone?.commanders).toEqual(["leader-id"]);
    expect(result.specification.seed_cards).toEqual([{ oracle_id: "Forest", qty: 36 }]);
    expect(result.specification.card_accounting).toMatchObject({
      deck_size: 100,
      library_size: 99,
      seed_library_quantity: 36,
      role_memberships_overlap: true,
    });
  });
  it("requires commander and budget choices without inventing defaults", () => {
    const result = normalize({ theme: "Plants" });
    expect(result.status).toBe("needs_choices");
    expect(result.specification.command_zone).toBeNull();
    expect(result.specification.budget.mode).toBe("unspecified");
    expect(result.choices.map((c) => c.path)).toEqual(
      expect.arrayContaining(["/commanders", "/budget"]),
    );
  });
  it("returns every complete alternative and rejects bad pairs locally", () => {
    const result = normalize({
      budget: { mode: "unbounded" },
      command_zone_alternatives: [
        { commanders: ["Partner A", "Partner B"], command_zone_kind: "partner" },
        { commanders: ["Leader", "Partner A"], command_zone_kind: "partner" },
      ],
    });
    expect(result.status).toBe("needs_choices");
    expect(result.specification.command_zone).toBeNull();
    expect(result.specification.command_zone_alternatives.map((c) => c.status)).toEqual([
      "valid",
      "invalid",
    ]);
  });
  it("carries saved provenance and intent without changing the baseline", () => {
    const deck = saved();
    deck.intent = { schema_version: 1, soft: { spend_target_usd: 50 } };
    const before = structuredClone(deck);
    const result = normalize({}, deck);
    expect(result.status).toBe("ready");
    expect(result.specification.source).toMatchObject({
      kind: "saved_deck",
      deck_id: "saved",
      version: 7,
      intent_snapshot: deck.intent,
    });
    expect(result.specification.budget).toMatchObject({ mode: "target", usd: 50 });
    expect(deck).toEqual(before);
  });
  it("does not silently override persisted intent", () => {
    const deck = saved();
    deck.intent = { schema_version: 1, hard: { excluded_cards: ["Spell"] } };
    const result = normalize(
      { budget: { mode: "unbounded" }, intent: { schema_version: 1 } },
      deck,
    );
    expect(result.status).toBe("conflict");
    expect(result.diagnostics.some((d) => d.code === "INTENT_OVERRIDE_CONFLICT")).toBe(true);
  });
  it("supports aspirational locks and detects canonical lock-exclusion conflicts", () => {
    expect(
      normalize({
        ...chosen,
        intent: { schema_version: 1, hard: { locked_cards: [{ oracle_id: "Spell", qty: 1 }] } },
      }).status,
    ).toBe("ready");
    const result = normalize({
      ...chosen,
      intent: {
        schema_version: 1,
        hard: { locked_cards: [{ oracle_id: "Leader", qty: 1 }], excluded_cards: ["leader-id"] },
      },
    });
    expect(result.status).toBe("conflict");
    expect(result.diagnostics.some((d) => d.code === "LOCKED_EXCLUDED")).toBe(true);
  });
  it("keeps unsupported hard requirements unresolved and preferred relaxation explicit", () => {
    const result = normalize({
      ...chosen,
      requirements: [
        { id: "win", text: "Win by turn four", strength: "hard" },
        { id: "fun", text: "Everyone has fun", strength: "preferred" },
      ],
    });
    expect(result.status).toBe("needs_choices");
    expect(result.unresolved_requirements).toHaveLength(2);
    expect(result.specification.preferred_relaxations.map((p) => p.path)).toContain(
      "/requirements/1",
    );
  });
  it("never treats unresolvable references as legal evidence", () => {
    const result = normalize({ ...chosen, commanders: ["Lead"] });
    expect(result.status).toBe("needs_choices");
    expect(result.diagnostics.some((d) => d.code === "UNKNOWN_CARD")).toBe(true);
  });
  it("detects impossible hard ranges and seed edit bounds", () => {
    expect(normalize({ ...chosen, lands: { min: 70, max: 30, strength: "hard" } }).status).toBe(
      "conflict",
    );
    expect(normalize({ ...chosen, cards: [], edit_bounds: { max_additions: 20 } }).status).toBe(
      "conflict",
    );
  });
  it("uses mandatory cards for cap conflicts, retaining missing-price uncertainty", () => {
    expect(normalize({ ...chosen, budget: { mode: "cap", usd: 5 } }).status).toBe("conflict");
    expect(
      normalize({
        ...chosen,
        budget: { mode: "cap", usd: 20 },
        cards: [{ oracle_id: "Spell", qty: 1 }],
      }).status,
    ).toBe("ready");
    const result = normalize({
      ...chosen,
      budget: { mode: "cap", usd: 20 },
      intent: {
        schema_version: 1,
        hard: { locked_cards: [{ oracle_id: "Unknown Price", qty: 1 }] },
      },
    });
    expect(result.status).toBe("needs_choices");
    expect(result.diagnostics.some((d) => d.code === "BUDGET_PRICE_UNKNOWN")).toBe(true);
  });
  it("counts a commander lock once and detects commander-library overlap", () => {
    expect(
      normalize({
        ...chosen,
        intent: {
          schema_version: 1,
          hard: {
            locked_cards: [
              { oracle_id: "leader-id", qty: 1 },
              { oracle_id: "Forest", qty: 99 },
            ],
          },
        },
      }).status,
    ).toBe("ready");
    expect(normalize({ ...chosen, cards: [{ oracle_id: "leader-id", qty: 1 }] }).status).toBe(
      "conflict",
    );
  });
  it("diagnoses budget amount contradictions and preserves incomplete command-zone input", () => {
    expect(normalize({ ...chosen, budget: { mode: "cap" } }).status).toBe("needs_choices");
    expect(normalize({ ...chosen, budget: { mode: "unbounded", usd: 10 } }).status).toBe(
      "conflict",
    );
    const result = normalize({
      commanders: ["Partner A", "Partner B"],
      budget: { mode: "unbounded" },
    });
    expect(result.status).toBe("needs_choices");
    expect(result.specification.requested_command_zone).toEqual({
      commanders: ["Partner A", "Partner B"],
      command_zone_kind: null,
    });
  });
  it("keeps impossible preferred ranges advisory while surfacing blocked hard role support", () => {
    const preferred = normalize({ ...chosen, lands: { min: 70, max: 30, strength: "preferred" } });
    expect(preferred.status).toBe("ready");
    expect(preferred.specification.preferred_relaxations).toHaveLength(1);
    const constrained = normalize({
      ...chosen,
      intent: { schema_version: 1, hard: { locked_cards: [{ oracle_id: "Forest", qty: 99 }] } },
      roles: { card_draw: { min: 1, max: 10, strength: "hard" } },
    });
    expect(constrained.status).toBe("needs_choices");
    expect(constrained.diagnostics.some((d) => d.code === "ROLE_CAPACITY_UNRESOLVED")).toBe(true);
  });
  it("makes hard card dependencies binding and leaves qualitative role adequacy unresolved", () => {
    const request = {
      ...chosen,
      strategy_dependencies: [{ id: "support", strength: "hard", requires_cards: ["Spell"] }],
      intent: { schema_version: 1, hard: { excluded_cards: ["Spell"] } },
    };
    expect(normalize(request).status).toBe("conflict");
    expect(
      normalize({
        ...chosen,
        strategy_dependencies: [{ id: "support", strength: "hard", requires_roles: ["ramp"] }],
      }).status,
    ).toBe("needs_choices");
  });
  it("detects canonical duplicate locks and counts forced identity edits", () => {
    const duplicate = normalize({
      ...chosen,
      intent: {
        schema_version: 1,
        hard: {
          locked_cards: [
            { oracle_id: "Leader", qty: 1 },
            { oracle_id: "leader-id", qty: 1 },
          ],
        },
      },
    });
    expect(duplicate.status).toBe("conflict");
    const constrained = normalize({
      ...chosen,
      cards: [
        { oracle_id: "Forest", qty: 98 },
        { oracle_id: "Spell", qty: 1 },
      ],
      intent: { schema_version: 1, hard: { excluded_cards: ["Spell"], change_limit: 1 } },
    });
    expect(constrained.status).toBe("conflict");
    expect(constrained.diagnostics.some((d) => d.code === "EDIT_BOUND_IMPOSSIBLE")).toBe(true);
  });
  it("does not let rejected alternatives poison a valid option", () => {
    const result = normalize({
      budget: { mode: "unbounded" },
      intent: { schema_version: 1, hard: { excluded_cards: ["Leader"] } },
      command_zone_alternatives: [
        { commanders: ["Leader"], command_zone_kind: "single" },
        { commanders: ["Partner A", "Partner B"], command_zone_kind: "partner" },
      ],
    });
    expect(result.status).toBe("needs_choices");
    expect(result.specification.command_zone_alternatives.map((a) => a.status)).toEqual([
      "invalid",
      "valid",
    ]);
  });
  it("aggregates seed references additively without mutating their quantities", () => {
    const result = normalize({
      ...chosen,
      cards: [
        { oracle_id: "Forest", qty: 20 },
        { oracle_id: "forest", qty: 10 },
      ],
    });
    expect(result.status).toBe("ready");
    expect(result.specification.seed_cards).toEqual([{ oracle_id: "Forest", qty: 30 }]);
  });
  it("keeps saved seed baselines and includes command-zone edits in change bounds", () => {
    const deck = saved();
    deck.cards = [{ oracle_id: "Forest", qty: 99 }];
    deck.intent = { schema_version: 1, hard: { change_limit: 0 } };
    const changed = normalize({ ...chosen, commanders: ["Other Leader"] }, deck);
    expect(changed.status).toBe("conflict");
    expect(changed.diagnostics.find((d) => d.code === "EDIT_BOUND_IMPOSSIBLE")?.message).toContain(
      "At least 2",
    );
    const override = normalize({ ...chosen, cards: [{ oracle_id: "Spell", qty: 99 }] }, deck);
    expect(override.diagnostics.some((d) => d.code === "SAVED_SEED_OVERRIDE_CONFLICT")).toBe(true);
  });
  it("retains compiled hard playgroup policy as explicitly pending evidence", () => {
    const result = normalize({
      ...chosen,
      intent: { schema_version: 1, playgroup: { limits: { infinite_combos: 0 } } },
    });
    expect(result.status).toBe("needs_choices");
    expect(
      result.unresolved_requirements.some(
        (r) => r.id === "playgroup:infinite_combos" && r.strength === "hard",
      ),
    ).toBe(true);
  });
  it("does not turn unresolved favorites or heuristic companion checks into hard conflicts", () => {
    const favorite = normalize({
      ...chosen,
      intent: { schema_version: 1, soft: { favorites: [{ oracle_id: "Does Not Exist", qty: 1 }] } },
    });
    expect(favorite.status).toBe("ready");
    expect(favorite.specification.preferred_relaxations).toHaveLength(1);
    const companion = normalize({
      ...chosen,
      companion: "Kaheera, the Orphanguard",
      intent: {
        schema_version: 1,
        hard: { locked_cards: [{ oracle_id: "Masked Vandal", qty: 1 }] },
      },
    });
    expect(companion.status).toBe("needs_choices");
    expect(companion.diagnostics.some((d) => d.code === "COMPANION")).toBe(false);
  });
  it("surfaces unrecognized bounded-copy syntax rather than accepting NaN limits", () => {
    const result = normalize({
      ...chosen,
      intent: {
        schema_version: 1,
        hard: { locked_cards: [{ oracle_id: "Unmodeled Copies", qty: 20 }] },
      },
    });
    expect(result.status).toBe("needs_choices");
    expect(result.diagnostics.some((d) => d.code === "COPY_LIMIT_UNRESOLVED")).toBe(true);
  });
  it("does not use flattened multiface land types to prove impossible allocation", () => {
    const result = normalize({
      ...chosen,
      lands: { min: 0, max: 0, strength: "hard" },
      intent: {
        schema_version: 1,
        hard: { locked_cards: [{ oracle_id: "Bala Ged Recovery // Bala Ged Sanctuary", qty: 1 }] },
      },
    });
    expect(result.status).toBe("needs_choices");
    expect(result.diagnostics.some((d) => d.code === "LAND_CAPACITY_UNRESOLVED")).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "LAND_CAPACITY_CONFLICT")).toBe(false);
  });
  it("does not treat missing starting characteristics as exact companion proof", () => {
    const result = normalize({
      commanders: ["Partner A"],
      budget: { mode: "unbounded" },
      companion: "Gyruda, Doom of Depths",
      intent: {
        schema_version: 1,
        hard: { locked_cards: [{ oracle_id: "Unknown Mana Cost", qty: 1 }] },
      },
    });
    expect(result.status).toBe("needs_choices");
    expect(result.diagnostics.some((d) => d.code === "COMPANION_CONDITION_UNRESOLVED")).toBe(true);
  });
  it("detects independently illegal mandatory cards before commander selection", () => {
    expect(
      normalize({
        budget: { mode: "unbounded" },
        intent: {
          schema_version: 1,
          hard: { locked_cards: [{ oracle_id: "Banned Card", qty: 1 }] },
        },
      }).status,
    ).toBe("conflict");
    expect(normalize({ budget: { mode: "unbounded" }, companion: "Spell" }).status).toBe(
      "conflict",
    );
  });
  it("keeps companion outside 100 and checks mandatory commander restrictions", () => {
    const result = normalize({ ...chosen, companion: "Lurrus of the Dream-Den" });
    expect(result.status).toBe("conflict");
    expect(result.specification.companion?.outside_deck).toBe(true);
    expect(result.specification.card_accounting).toMatchObject({
      deck_size: 100,
      library_size: 99,
      companion_quantity: 1,
    });
    expect(result.diagnostics.some((d) => d.code === "COMPANION")).toBe(true);
    expect(normalize({ ...chosen, companion: "Yorion, Sky Nomad" }).status).toBe("conflict");
  });
});
