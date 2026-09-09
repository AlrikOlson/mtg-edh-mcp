import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoveryFixture } from "./discovery.fixture.js";
import { recommendCards } from "./recommendations.js";
import { preferenceCards, preferenceCases, preferenceName } from "./recommendations.fixture.js";

let fixture: Awaited<ReturnType<typeof discoveryFixture>>;
beforeAll(async () => {
  fixture = await discoveryFixture(preferenceCards);
});
afterAll(async () => {
  await fixture?.close();
});

describe("frozen contextual preference benchmark, providers absent", () => {
  it("agrees with at least 80% of 44 explicit contrasting deck/candidate decisions", () => {
    const misses: string[] = [];
    let agreed = 0;
    for (const scenario of preferenceCases) {
      // A fixed-pair query isolates ranking from retrieval. Neither candidate's
      // text, score, nor result position is used to choose the expected winner.
      const names = [scenario.preferred, scenario.other].map(preferenceName);
      const result = recommendCards(fixture.index, scenario.deck, {
        oracle_query: names.map((name) => `name:"${name}"`).join(" or "),
        limit: 2,
      });
      const preferred = result.suggestions.find((card) => card.oracle_id === scenario.preferred);
      const other = result.suggestions.find((card) => card.oracle_id === scenario.other);
      expect(preferred, scenario.id + " preferred candidate must be retrieved").toBeDefined();
      expect(other, scenario.id + " contrasting candidate must be retrieved").toBeDefined();
      if (preferred && other && preferred.score > other.score) agreed += 1;
      else
        misses.push(
          `${scenario.id}: ${names[0]} (${preferred?.score}) <= ${names[1]} (${other?.score}). ${scenario.rationale}`,
        );
    }
    const agreement = agreed / preferenceCases.length;
    console.info(
      `Contextual preference agreement: ${agreed}/${preferenceCases.length} (${(agreement * 100).toFixed(1)}%).`,
      misses.length ? `Misses:\n${misses.join("\n")}` : "No fixed-case disagreements.",
    );
    expect(
      agreement,
      `${agreed}/${preferenceCases.length} fixed preferences agreed.\n${misses.join("\n")}`,
    ).toBeGreaterThanOrEqual(0.8);
  });

  it("keeps the frozen corpus broad and uniquely identified", () => {
    expect(preferenceCases).toHaveLength(44);
    expect(new Set(preferenceCases.map((scenario) => scenario.id)).size).toBe(44);
    expect(
      new Set(
        preferenceCases.map(({ deck, preferred, other }) =>
          JSON.stringify({ deck, preferred, other }),
        ),
      ).size,
    ).toBe(44);
    expect(new Set(preferenceCases.map((scenario) => scenario.family)).size).toBe(14);
    for (const scenario of preferenceCases) {
      expect(scenario.preferred).not.toBe(scenario.other);
      const present = new Set([
        ...scenario.deck.commanders,
        ...scenario.deck.cards.map((card) => card.oracle_id),
      ]);
      expect(present.has(scenario.preferred), scenario.id).toBe(false);
      expect(present.has(scenario.other), scenario.id).toBe(false);
    }
  });
});
