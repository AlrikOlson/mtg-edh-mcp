import { describe, it, expect } from "vitest";
import { mapScryfallCard } from "../index/map.js";
import { rawCard } from "../analyze/discovery.fixture.js";
import { validateCommander, isCommanderEligible } from "./commanderRules.js";
import type { Card, Deck } from "../types/index.js";
function validate(cards: Card[], kind: Deck["command_zone_kind"]) {
  return validateCommander(
    {
      deck_id: "",
      name: "",
      format: "commander",
      commanders: cards.map((c) => c.oracle_id),
      command_zone_kind: kind,
      cards: [],
      computed_color_identity: [],
      version: 0,
      data_snapshot: "",
    },
    (id) => cards.find((c) => c.oracle_id === id) ?? null,
  );
}
describe("discovery commander safety", () => {
  it("rejects the same canonical partner twice", () => {
    const c = mapScryfallCard(rawCard("A", "Partner", { type_line: "Legendary Creature — Human" }));
    expect(validate([c, c], "partner")).not.toEqual([]);
  });
  it("does not borrow legendary type or Partner from a back face", () => {
    const c = mapScryfallCard(
      rawCard("Front // Back", "", {
        layout: "transform",
        type_line: "Artifact // Legendary Creature — Human",
        card_faces: [
          { name: "Front", type_line: "Artifact", oracle_text: "Draw a card." },
          {
            name: "Back",
            type_line: "Legendary Creature — Human",
            oracle_text: "Partner",
            power: "3",
            toughness: "3",
          },
        ],
      }),
    );
    expect(isCommanderEligible(c)).toBe(false);
    const front = mapScryfallCard(
      rawCard("Other Front // Back", "", {
        layout: "transform",
        type_line: "Legendary Creature — Human // Legendary Creature — Human",
        card_faces: [
          {
            name: "Other Front",
            type_line: "Legendary Creature — Human",
            oracle_text: "Draw a card.",
          },
          {
            name: "Back",
            type_line: "Legendary Creature — Human",
            oracle_text: "Partner",
          },
        ],
      }),
    );
    const p = mapScryfallCard(
      rawCard("Partner", "Partner", {
        type_line: "Legendary Creature — Human",
      }),
    );
    expect(validate([front, p], "partner")).not.toEqual([]);
  });
  it("rejects a noncreature Doctor companion even if it can be a sole commander", () => {
    const doctor = mapScryfallCard(
      rawCard("Doctor", "", {
        type_line: "Legendary Creature — Time Lord Doctor",
      }),
    );
    const fake = mapScryfallCard(
      rawCard("Fake", "Doctor's companion\nFake can be your commander.", {
        type_line: "Legendary Planeswalker — Fake",
      }),
    );
    expect(validate([doctor, fake], "doctor_companion")).not.toEqual([]);
  });
});
