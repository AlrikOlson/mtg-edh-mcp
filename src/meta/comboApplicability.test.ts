import { describe, expect, it } from "vitest";
import { mapScryfallCard } from "../index/map.js";
import type { Deck } from "../types/index.js";
import { parseCombos } from "./spellbook.js";
import { evaluateCombo, spellbookDeckQuery } from "./comboApplicability.js";

const a = mapScryfallCard({ oracle_id: "a", name: "Alpha", layout: "normal" });
const b = mapScryfallCard({
  oracle_id: "b",
  name: "Front // Back",
  layout: "modal_dfc",
  card_faces: [
    { name: "Front", oracle_text: "" },
    { name: "Back", oracle_text: "" },
  ],
});
const cards = [a, b];
const resolver = {
  getCard: (id: string) => cards.find((c) => c.oracle_id === id) ?? null,
  resolveName: (name: string) => cards.filter((c) => c.name.toLowerCase() === name.toLowerCase()),
};
const deck = (patch: Partial<Deck> = {}): Deck => ({
  deck_id: "d",
  name: "Test",
  format: "commander",
  commanders: ["a"],
  command_zone_kind: "single",
  cards: [{ oracle_id: "b", qty: 1 }],
  computed_color_identity: [],
  version: 1,
  data_snapshot: "2026-09-08",
  ...patch,
});
const ingredient = (name = "Alpha", patch: Record<string, unknown> = {}) => ({
  card: { name, oracleId: name === "Alpha" ? "a" : "b" },
  quantity: 1,
  zoneLocations: ["B"],
  battlefieldCardState: "",
  exileCardState: "",
  libraryCardState: "",
  graveyardCardState: "",
  mustBeCommander: false,
  usedFace: null,
  ...patch,
});
function combo(uses: unknown[] = [ingredient()], patch: Record<string, unknown> = {}) {
  const parsed = parseCombos({
    results: {
      included: [
        {
          id: "1-2",
          status: "OK",
          uses,
          requires: [],
          produces: [{ feature: { name: "Infinite mana" }, quantity: 1 }],
          manaNeeded: "",
          manaValueNeeded: 0,
          easyPrerequisites: "",
          notablePrerequisites: "",
          description: "Repeat.",
          notes: "",
          ...patch,
        },
      ],
      almostIncluded: [],
    },
  });
  const value = parsed.included[0];
  if (!value) throw new Error("missing fixture");
  return value;
}
describe("combo applicability", () => {
  it("separates listed cards and configuration from execution and starting state", () => {
    const result = evaluateCombo(
      combo([
        ingredient("Alpha", {
          battlefieldCardState: "Untapped",
          manaNeeded: "{2}",
        }),
      ]),
      deck(),
      resolver,
    );
    expect(result).toMatchObject({
      listed_pieces_present: "satisfied",
      deck_configuration: "satisfied",
      setup_prerequisites: "unknown",
      executable_now: "unknown",
    });
  });
  it("requires a designated commander, not merely a card in the library", () => {
    const result = evaluateCombo(
      combo([ingredient("Alpha", { mustBeCommander: true })]),
      deck({ commanders: [], cards: [{ oracle_id: "a", qty: 1 }] }),
      resolver,
    );
    expect(result.listed_pieces_present).toBe("satisfied");
    expect(result.deck_configuration).toBe("unsatisfied");
    expect(result.ingredients[0]?.commander_requirement).toBe("unsatisfied");
  });
  it("checks an exclusively command-zone starting requirement", () => {
    const result = evaluateCombo(
      combo([ingredient("Alpha", { zoneLocations: ["C"] })]),
      deck({ commanders: [], cards: [{ oracle_id: "a", qty: 1 }] }),
      resolver,
    );
    expect(result.deck_configuration).toBe("unsatisfied");
  });
  it("keeps empty or unsupported starting-zone evidence unknown", () => {
    for (const zoneLocations of [[], ["future-zone"]]) {
      expect(
        evaluateCombo(combo([ingredient("Alpha", { zoneLocations })]), deck(), resolver)
          .deck_configuration,
      ).toBe("unknown");
    }
  });

  it("counts missing copies and does not double-count a commander also stored in the library", () => {
    const result = evaluateCombo(
      combo([ingredient("Alpha", { quantity: 2 })]),
      deck({ cards: [{ oracle_id: "a", qty: 1 }] }),
      resolver,
    );
    expect(result.listed_pieces_present).toBe("unsatisfied");
    expect(result.ingredients[0]).toMatchObject({
      available_quantity: 1,
      missing_quantity: 1,
    });
  });
  it("aggregates repeated requirements for the same canonical physical card", () => {
    const result = evaluateCombo(combo([ingredient(), ingredient()]), deck(), resolver);
    expect(result.listed_pieces_present).toBe("unsatisfied");
    expect(result.issues).toContain("insufficient_quantity:a");
  });
  it("maps provider one-based faces to canonical face evidence without granting playability", () => {
    const result = evaluateCombo(
      combo([ingredient("Front // Back", { usedFace: 2 })]),
      deck(),
      resolver,
    );
    expect(result.ingredients[0]).toMatchObject({
      face_requirement: "satisfied",
      face: { face_index: 1, source_path: "/card_faces/1", name: "Back" },
    });
    expect(result.executable_now).toBe("unknown");
    expect(
      evaluateCombo(combo([ingredient("Front // Back", { usedFace: 3 })]), deck(), resolver)
        .deck_configuration,
    ).toBe("unsatisfied");
  });
  it("leaves missing templates unresolved even when the provider labels a combo included", () => {
    const result = evaluateCombo(
      combo([ingredient()], {
        requires: [
          {
            template: {
              id: 8,
              name: "Any sacrifice outlet",
              scryfallQuery: "o:sacrifice",
            },
            quantity: 1,
          },
        ],
      }),
      deck(),
      resolver,
    );
    expect(result.listed_pieces_present).toBe("satisfied");
    expect(result.deck_configuration).toBe("unknown");
    expect(result.issues).toContain("templates_not_evaluated");
  });
  it("keeps missing ingredient evidence unknown rather than defaulting quantity or commander flags", () => {
    const result = evaluateCombo(combo([{ card: { name: "Alpha" } }]), deck(), resolver);
    expect(result.listed_pieces_present).toBe("unknown");
    expect(result.deck_configuration).toBe("unknown");
  });
  it("distinguishes unknown cards from known absent cards and preserves almost evidence", () => {
    const unknown = evaluateCombo(
      combo([
        ingredient("Missing", {
          card: { name: "Missing", oracleId: "missing" },
        }),
      ]),
      deck(),
      resolver,
    );
    expect(unknown.listed_pieces_present).toBe("unknown");
    expect(unknown.issues).toContain("unresolved_card:Missing");
    const absent = evaluateCombo(
      combo([ingredient("Front // Back")]),
      deck({ cards: [] }),
      resolver,
    );
    expect(absent.listed_pieces_present).toBe("unsatisfied");
  });
  it("does not claim missing face data or example variants are ready", () => {
    const missingFaces = {
      ...resolver,
      getCard: (id: string) => {
        const card = resolver.getCard(id);
        return card ? { ...card, gameplay: null } : null;
      },
    };
    expect(
      evaluateCombo(combo([ingredient("Front // Back", { usedFace: 2 })]), deck(), missingFaces)
        .deck_configuration,
    ).toBe("unknown");
    expect(
      evaluateCombo(
        combo([ingredient()], { status: "E", easyPrerequisites: null }),
        deck(),
        resolver,
      ).deck_configuration,
    ).toBe("unknown");
  });
});
describe("Spellbook deck query", () => {
  it("keeps large imported quantities compact", () => {
    const result = spellbookDeckQuery(
      deck({ cards: [{ oracle_id: "b", qty: 1000000 }] }),
      resolver,
    );
    expect(result.cards).toEqual([{ card: "Front // Back", quantity: 1000000 }]);
  });
  it("preserves quantities, excludes commander duplicates and reports unresolved deck identities", () => {
    expect(
      spellbookDeckQuery(
        deck({
          cards: [
            { oracle_id: "a", qty: 1 },
            { oracle_id: "b", qty: 3 },
            { oracle_id: "missing", qty: 2 },
          ],
        }),
        resolver,
      ),
    ).toEqual({
      commanders: [{ card: "Alpha", quantity: 1 }],
      cards: [{ card: "Front // Back", quantity: 3 }],
      unresolved_oracle_ids: ["missing"],
    });
  });
});
