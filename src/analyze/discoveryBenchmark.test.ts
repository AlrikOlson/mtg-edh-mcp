import { afterAll, beforeAll, describe, expect, it } from "vitest";
import corpus from "../../docs/evaluation/discovery-corpus.json" with { type: "json" };
import { discover, type DiscoveryRequest } from "./discovery.js";
import { discoveryFixture, rawCard } from "./discovery.fixture.js";
let fixture: Awaited<ReturnType<typeof discoveryFixture>>;
beforeAll(async () => {
  fixture = await discoveryFixture([
    ...corpus.cards,
    ...Array.from({ length: 240 }, (_, i) => rawCard("A unrelated flying creature " + i, "Flying")),
  ]);
});
afterAll(async () => {
  await fixture.close();
});
describe("frozen full-pool recall at 50, providers absent", () => {
  it.each(corpus.tasks)("$id recovers at least 80% of predefined positives", (task) => {
    const result = discover(fixture.index, task.request satisfies DiscoveryRequest);
    const found = new Set(result.results.flatMap((r) => r.cards.map((c) => c.oracle_id)));
    const recall =
      task.relevant_oracle_ids.filter((id) => found.has(id)).length /
      task.relevant_oracle_ids.length;
    expect(
      recall,
      task.id + ": " + JSON.stringify(result.results.map((r) => r.cards[0]?.name)),
    ).toBeGreaterThanOrEqual(0.8);
    expect(result.truncation.scan).toBe(false);
    expect(result.scanned).toBe(corpus.cards.length + 240);
    expect(
      task.relevant_oracle_ids.some(
        (id) => !new Set<string>(task.provided_profile_oracle_ids).has(id),
      ),
    ).toBe(true);
    expect(result.source.recommendation_providers).toBe("not_used");
  });
  it("discovers recent and less-common commanders by evidence, and a valid thematic pair", () => {
    const cases = [
      {
        request: { theme: "discard", mode: "commanders" as const },
        expected: "Hashaton, Scarab's Fist",
      },
      {
        request: { theme: "tokens", mode: "commanders" as const },
        expected: "Lagomos, Hand of Hatred",
      },
      {
        request: {
          theme: "explore",
          oracle_query: "(o:explore or o:explores)",
          mode: "commanders" as const,
        },
        expected: "Nicanzil, Current Conductor",
      },
    ];
    for (const { request, expected } of cases) {
      const result = discover(fixture.index, request);
      expect(result.results.flatMap((r) => r.cards.map((c) => c.name))).toContain(expected);
    }
    const paired = discover(fixture.index, {
      theme: "scry",
      mode: "commanders",
    });
    expect(paired.results).toContainEqual(
      expect.objectContaining({
        command_zone_kind: "partner",
        cards: [
          expect.objectContaining({ name: "Eligeth, Crossroads Augur" }),
          expect.objectContaining({ name: "Siani, Eye of the Storm" }),
        ],
      }),
    );
  });
  it("freezes at least twelve tasks and includes new commander and independent source provenance", () => {
    expect(corpus.tasks.length).toBeGreaterThanOrEqual(12);
    expect(corpus.source).toBe("https://api.scryfall.com/cards/collection");
    expect(corpus.cards.some((c) => c.name === "Hashaton, Scarab's Fist")).toBe(true);
    expect(corpus.tasks.every((t) => Object.keys(t.source_urls).length >= 3)).toBe(true);
  });
});
