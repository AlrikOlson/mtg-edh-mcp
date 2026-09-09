import { afterEach, describe, expect, it, vi } from "vitest";
import { discoveryFixture, rawCard } from "../analyze/discovery.fixture.js";
import { DeckStore } from "../deck/index.js";
import { CacheStore, EdhrecClient } from "../meta/index.js";
import { contextualRecommendation } from "./recommendationTools.js";

let fixture: Awaited<ReturnType<typeof discoveryFixture>>;
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture?.close();
});

async function enriched(cardviews: Array<{ name: string; synergy?: number }>) {
  fixture = await discoveryFixture([
    rawCard("Chief", "Whenever you gain life, draw a card.", {
      type_line: "Legendary Creature — Human",
    }),
    rawCard("Supply", "You gain 3 life.", { type_line: "Sorcery" }),
    rawCard("Plain", "{T}: Add {C}.", { type_line: "Artifact" }),
  ]);
  const store = new DeckStore({ newId: () => "d" });
  store.create({ name: "d", commanders: ["Chief"], computedColorIdentity: [] });
  const deck = store.get("d");
  if (!deck) throw new Error("Missing fixture deck");
  const client = new EdhrecClient(new CacheStore(), {
    fetchJson: async () => ({
      container: { json_dict: { cardlists: [{ header: "Test", cardviews }] } },
    }),
  });
  const resolve = vi.spyOn(fixture.index, "resolveName");
  const response = await contextualRecommendation(
    deck,
    fixture.index,
    store,
    "local",
    client,
    { limit: 25 },
    true,
  );
  if (!("suggestions" in response.structuredContent)) throw new Error("Unexpected conflict");
  return { report: response.structuredContent, resolve };
}

describe("bounded optional recommendation enrichment", () => {
  it("resolves provider rows once across multiple recommendations and reports unresolved rows", async () => {
    const { report, resolve } = await enriched([
      { name: "Supply", synergy: 0.1 },
      { name: "Plain", synergy: 0.8 },
      { name: "Missing from index" },
    ]);
    expect(report.suggestions).toHaveLength(2);
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(report.providers[0]).toMatchObject({
      coverage: { profile_rows: 3, scanned_rows: 3, scan_truncated: false, unresolved_rows: 1 },
    });
    expect(report.suggestions.every((candidate) => candidate.provider_metrics.length === 1)).toBe(
      true,
    );
  });

  it("bounds profile scanning and duplicate observations with explicit incomplete coverage", async () => {
    const { report, resolve } = await enriched([
      ...Array.from({ length: 5001 }, () => ({ name: "Supply", synergy: 0.1 })),
      { name: "Plain", synergy: 0.8 },
    ]);
    expect(resolve).toHaveBeenCalledTimes(5000);
    expect(report.providers[0]).toMatchObject({
      coverage: {
        profile_rows: 5002,
        scanned_rows: 5000,
        scan_limit: 5000,
        scan_truncated: true,
        unresolved_rows: 0,
      },
    });
    const supply = report.suggestions.find((candidate) => candidate.oracle_id === "Supply");
    expect(supply?.provider_metrics).toHaveLength(8);
    expect(
      supply?.provider_metrics.every((observation) => observation.observations_truncated),
    ).toBe(true);
    expect(
      report.suggestions.find((candidate) => candidate.oracle_id === "Plain")?.provider_metrics,
    ).toEqual([]);
  });
});
