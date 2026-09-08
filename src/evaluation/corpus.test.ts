import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadBenchmarkCorpus, type BenchmarkCorpus } from "./corpus.js";

function factFor(corpus: BenchmarkCorpus, id: string) {
  const fact = corpus.facts[id];
  if (!fact) throw new Error(`Corpus references missing card fact ${id}`);
  return fact;
}

describe("authored Commander quality corpus", () => {
  it("pins at least twenty coherent complete decks with independent card facts", async () => {
    const corpus = await loadBenchmarkCorpus();
    expect(corpus.cases.length).toBeGreaterThanOrEqual(20);
    expect(new Set(corpus.cases.map((entry) => entry.id)).size).toBe(corpus.cases.length);
    for (const entry of corpus.cases) {
      expect(entry.main.reduce((sum, card) => sum + card.qty, entry.commanders.length)).toBe(100);
      const colors = new Set(entry.commanders.flatMap((id) => factFor(corpus, id).colors));
      for (const card of entry.main) {
        const fact = factFor(corpus, card.id);
        expect(fact, `${entry.id}: missing ${card.id}`).toBeDefined();
        expect(fact.legal).toBe(true);
        expect(fact.colors.every((color) => colors.has(color))).toBe(true);
        expect(card.qty).toBeLessThanOrEqual(fact.maxCopies ?? Infinity);
      }
      const lands = entry.main.reduce(
        (sum, card) => sum + (factFor(corpus, card.id).roles.includes("land") ? card.qty : 0),
        0,
      );
      expect(lands).toBeGreaterThanOrEqual(28);
      expect(lands).toBeLessThanOrEqual(42);
      for (const theme of entry.theme) {
        expect(
          entry.main.reduce(
            (sum, card) =>
              sum + (factFor(corpus, card.id).roles.includes(theme.role) ? card.qty : 0),
            0,
          ),
        ).toBeGreaterThanOrEqual(theme.min);
      }
    }
  });

  it("covers color counts, request states, bounded copies, paired commanders and limitations", async () => {
    const corpus = await loadBenchmarkCorpus();
    expect(
      new Set(
        corpus.cases.map(
          (entry) => new Set(entry.commanders.flatMap((id) => factFor(corpus, id).colors)).size,
        ),
      ),
    ).toEqual(new Set([0, 1, 2, 3, 4, 5]));
    expect(new Set(corpus.cases.map((entry) => entry.split))).toEqual(
      new Set(["calibration", "holdout"]),
    );
    expect(corpus.cases.some((entry) => entry.startingMain.length === 0)).toBe(true);
    expect(
      corpus.cases.some(
        (entry) => entry.startingMain.length > 0 && entry.startingMain.length < entry.main.length,
      ),
    ).toBe(true);
    expect(corpus.cases.filter((entry) => entry.expectedPair).length).toBeGreaterThanOrEqual(3);
    expect(corpus.cases.some((entry) => !entry.supported)).toBe(true);
    expect(
      Object.values(corpus.facts).find((card) => card.name === "Seven Dwarves")?.maxCopies,
    ).toBe(7);
    expect(Object.values(corpus.facts).find((card) => card.name === "Nazgûl")?.maxCopies).toBe(9);
    expect(corpus.cases.some((entry) => entry.tags.includes("provider-absence-simulated"))).toBe(
      true,
    );
    expect(corpus.sources.oracleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(corpus.oracleCards.length).toBe(Object.keys(corpus.facts).length);
  });

  it("pins independent integer price facts to the actual selected printing", async () => {
    const corpus = await loadBenchmarkCorpus();
    const printingSchema = z.object({
      oracle_id: z.string(),
      prices: z.object({ usd: z.string().nullable() }),
    });
    for (const raw of corpus.oracleCards) {
      const printing = printingSchema.parse(raw);
      const expected =
        printing.prices.usd === null ? null : Math.round(Number(printing.prices.usd) * 100);
      expect(factFor(corpus, printing.oracle_id).priceCents).toBe(expected);
    }
  });
});
