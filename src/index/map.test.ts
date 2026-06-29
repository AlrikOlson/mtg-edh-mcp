import { describe, it, expect } from "vitest";
import { isCommanderEligible, mapScryfallCard } from "./map.js";
import type { ScryfallCardRaw } from "../ingest/scryfallTypes.js";

describe("isCommanderEligible (ingest heuristic)", () => {
  it("accepts a legendary creature (subsumed by the printed-P/T path)", () => {
    expect(isCommanderEligible("Legendary Creature — Elf", "", "1", "1")).toBe(true);
  });

  it("accepts a legendary Vehicle / Spacecraft with a printed power/toughness", () => {
    expect(isCommanderEligible("Legendary Artifact — Vehicle", "", "5", "5")).toBe(true);
    expect(isCommanderEligible("Legendary Artifact — Spacecraft", "", "3", "4")).toBe(true);
  });

  it("rejects a legendary permanent with no printed power/toughness", () => {
    expect(isCommanderEligible("Legendary Artifact", "")).toBe(false);
    expect(isCommanderEligible("Legendary Enchantment", "")).toBe(false);
  });

  it("accepts anything whose text says it can be your commander", () => {
    expect(
      isCommanderEligible("Legendary Planeswalker — Rowan", "Rowan can be your commander."),
    ).toBe(true);
  });
});

describe("mapScryfallCard sets is_commander_eligible", () => {
  function raw(partial: Partial<ScryfallCardRaw> & { name: string }): ScryfallCardRaw {
    return { oracle_id: partial.name, ...partial };
  }

  it("flags a legendary Vehicle with a printed power/toughness", () => {
    const card = mapScryfallCard(
      raw({
        name: "Parhelion II",
        type_line: "Legendary Artifact — Vehicle",
        power: "5",
        toughness: "5",
        color_identity: ["W"],
      }),
    );
    expect(card.is_commander_eligible).toBe(true);
    expect(card.color_identity).toEqual(["W"]);
  });

  it("does not flag a legendary artifact with no printed power/toughness", () => {
    const card = mapScryfallCard(raw({ name: "Legendary Relic", type_line: "Legendary Artifact" }));
    expect(card.is_commander_eligible).toBe(false);
  });
});
