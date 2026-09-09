import { afterEach, describe, expect, it } from "vitest";
import { discover } from "./discovery.js";
import { discoveryFixture, rawCard } from "./discovery.fixture.js";
import type { Deck } from "../types/index.js";

let fixture: Awaited<ReturnType<typeof discoveryFixture>>;
afterEach(async () => {
  await fixture?.close();
});
const legendary = { type_line: "Legendary Creature — Human" };
const cards = [
  ...Array.from({ length: 80 }, (_, i) => rawCard("A decoy " + i, "Flying")),
  rawCard("Z draw", "Draw two cards.", { color_identity: ["U"] }),
  rawCard("Z ban", "Draw two cards.", { legalities: { commander: "banned" } }),
  rawCard("Z excluded", "Draw two cards."),
  rawCard("Z red", "Draw two cards.", { color_identity: ["R"] }),
  rawCard("Chief", "Flying", { ...legendary, color_identity: ["U"] }),
  rawCard("Partner draw", "Partner\nWhenever you cast a spell, draw a card.", legendary),
  rawCard("Partner blank", "Partner", legendary),
  rawCard("Grouped", "Partner—Survivors\nDraw a card.", legendary),
  rawCard("Chooser", "Choose a Background\nDraw a card.", legendary),
  rawCard("Background", "Commander creatures you own have vigilance.", {
    type_line: "Legendary Enchantment — Background",
  }),
  rawCard("Doctor", "Whenever you attack, draw a card.", {
    type_line: "Legendary Creature — Time Lord Doctor",
  }),
  rawCard("Companion", "Doctor's companion", legendary),
];
it("requires mechanic evidence as well as an explicit query and handles inherited property names as unknown themes", async () => {
  fixture = await discoveryFixture([
    rawCard("Outlet", "Sacrifice a creature: Scry 1."),
    rawCard("Vanilla", "Flying"),
    rawCard("Artifact outlet", "Sacrifice a creature: Scry 1.", {
      type_line: "Artifact",
    }),
  ]);
  const result = discover(fixture.index, {
    theme: "sacrifice",
    oracle_query: "t:creature",
  });
  expect(result.results.map((r) => r.cards[0]?.name)).toEqual(["Outlet"]);
  expect(discover(fixture.index, { theme: "constructor" }).interpretation.status).toBe(
    "needs_query",
  );
});
const names = (r: ReturnType<typeof discover>) =>
  r.results.map((v) => v.cards.map((c) => c.name).join(" + "));

describe("full installed pool discovery", () => {
  it("recovers late-name matches past 80 decoys with explicit legal, identity and card exclusions", async () => {
    fixture = await discoveryFixture(cards);
    const result = discover(fixture.index, {
      theme: "draw",
      commanders: ["Chief"],
      excluded_cards: ["Z excluded"],
    });
    expect(names(result)).toContain("Z draw");
    expect(names(result)).not.toContain("Z red");
    expect(names(result)).not.toContain("Z ban");
    expect(names(result)).not.toContain("Z excluded");
    expect(result.scanned).toBe(cards.length);
    expect(result.exclusions.counts).toMatchObject({
      legality: 1,
      color_identity: 1,
      excluded_card: 1,
    });
    expect(result.results.find((r) => r.cards[0]?.name === "Z draw")?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "mechanic",
          annotation: expect.objectContaining({
            pattern_id: "effect.draw_cards",
          }),
        }),
      ]),
    );
  });
  it("only returns verified pairs and includes an unmatched legal partner", async () => {
    fixture = await discoveryFixture(cards);
    const result = discover(fixture.index, {
      theme: "draw",
      mode: "commanders",
      include_pairs: true,
    });
    expect(names(result)).toContain("Partner blank + Partner draw");
    expect(names(result)).toContain("Background + Chooser");
    expect(names(result)).toContain("Companion + Doctor");
    expect(names(result).some((n) => n.includes("Grouped + Partner"))).toBe(false);
    expect(result.results.every((r) => r.command_zone_kind !== null)).toBe(true);
  });
  it("reports unsupported themes with an explicit query fallback and does not reinterpret prose", async () => {
    fixture = await discoveryFixture(cards);
    const unknown = discover(fixture.index, { theme: "space opera" });
    expect(unknown.results).toEqual([]);
    expect(unknown.interpretation.status).toBe("needs_query");
    const fallback = discover(fixture.index, {
      theme: "space opera",
      oracle_query: "o:draw",
    });
    expect(fallback.interpretation.status).toBe("text_fallback");
    expect(names(fallback)).toContain("Z draw");
    expect(fallback.results[0]?.matches).toContainEqual({
      kind: "query",
      query: "o:draw",
      oracle_id: fallback.results[0]?.cards[0]?.oracle_id,
    });
  });
  it("reports independently bounded scan, pair search and output truncation deterministically", async () => {
    fixture = await discoveryFixture(cards);
    const request = {
      theme: "draw",
      mode: "commanders" as const,
      limit: 1,
      pair_limit: 1,
    };
    const first = discover(fixture.index, request);
    expect(discover(fixture.index, request)).toEqual(first);
    expect(first.truncation.results).toBe(true);
    expect(first.truncation.pairs).toBe(true);
    const scan = discover(fixture.index, { theme: "draw", scan_limit: 10 });
    expect(scan.scanned).toBe(10);
    expect(scan.truncation.scan).toBe(true);
  });
  it("applies saved intent exclusions and commander constraints without mutating the deck", async () => {
    fixture = await discoveryFixture(cards);
    const deck: Deck = {
      deck_id: "d",
      name: "d",
      format: "commander",
      commanders: ["Chief"],
      command_zone_kind: "single",
      cards: [{ oracle_id: "Z draw", qty: 1 }],
      computed_color_identity: ["U"],
      version: 7,
      data_snapshot: "old",
      intent: {
        schema_version: 1,
        hard: {
          excluded_cards: ["Z excluded"],
          commanders: { allowed: ["Chooser"], required: ["Chooser"] },
        },
      },
    };
    const before = structuredClone(deck);
    expect(names(discover(fixture.index, { theme: "draw" }, deck))).not.toContain("Z draw");
    expect(names(discover(fixture.index, { theme: "draw", mode: "commanders" }, deck))).toEqual([
      "Chooser",
    ]);
    expect(deck).toEqual(before);
  });
  it("rejects invalid selected command zones and unsupported mechanic IDs", async () => {
    fixture = await discoveryFixture(cards);
    expect(() =>
      discover(fixture.index, {
        theme: "draw",
        commanders: ["Chief", "Z draw"],
      }),
    ).toThrow();
    expect(() => discover(fixture.index, { mechanics: ["effect.telepathy"] })).toThrow();
  });
});
