import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { runDeckQualityBaseline } from "./baseline.js";
import { loadBenchmarkCorpus } from "./corpus.js";
import { priceDeck, type DeckArtifact } from "./graders.js";

const completeSchema = z.object({ complete: z.boolean() });
const observedPlanSchema = z.object({
  default_total_usd: z.number(),
  min_buy_usd: z.number(),
  acquire_usd: z.number().nullable(),
  minor_units: z.object({
    default_total: z.number().int(),
    min_buy: z.number().int(),
    acquire: z.number().int().nullable(),
  }),
  coverage: z.object({
    complete: z.boolean(),
    unresolved: z.array(z.object({ oracle_id: z.string() })),
    missing_prices: z.array(z.object({ oracle_id: z.string() })),
    min_buy: completeSchema,
    default_total: completeSchema,
    acquire: completeSchema.nullable(),
  }),
  pricing: z.object({ data_snapshot: z.string(), price_timestamp: z.null() }),
  freshness: z.object({ status: z.literal("unknown") }),
  target_met: z.boolean().nullable(),
  ownership_basis: z.string().nullable(),
});
const responseSchema = z.object({
  structuredContent: z.object({
    price_scope: z.literal("library"),
    library: observedPlanSchema,
    command_zone: observedPlanSchema,
    full_deck: observedPlanSchema,
    companion: observedPlanSchema,
    scope: z.object({
      full_deck_quantity: z.number(),
      companion_included: z.literal(false),
    }),
  }),
});

afterEach(() => vi.unstubAllGlobals());

it("matches independent whole-deck cents and unknown-price evidence for all 22 frozen decks", async () => {
  const network = vi.fn(() => {
    throw new Error("Whole-deck corpus acceptance must stay offline");
  });
  vi.stubGlobal("fetch", network);
  const corpus = await loadBenchmarkCorpus();
  const report = await runDeckQualityBaseline(corpus);
  expect(report.cases).toHaveLength(22);
  let incompleteDecks = 0;
  let quantityInventoryDifferences = 0;

  for (const scenario of corpus.cases) {
    const observed = report.cases.find((entry) => entry.id === scenario.id);
    if (!observed) throw new Error(`Missing MCP observations for ${scenario.id}`);
    expect(observed.error, scenario.id).toBeUndefined();
    const calls = observed.calls.filter((call) => call.name === "budget_plan");
    expect(calls, scenario.id).toHaveLength(2);
    const budget = responseSchema.parse(calls[0]?.result).structuredContent;
    const acquisition = responseSchema.parse(calls[1]?.result).structuredContent.full_deck;

    // Authored facts, not production pricing helpers, supply the expected cents.
    const artifact: DeckArtifact = {
      commanders: scenario.commanders,
      main: scenario.main,
      ...(scenario.companion ? { companion: scenario.companion } : {}),
      ...(scenario.maybeboard ? { maybeboard: scenario.maybeboard } : {}),
    };
    const expected = priceDeck(artifact, corpus.facts);
    const library = priceDeck({ commanders: [], main: scenario.main }, corpus.facts);
    const commanders = priceDeck({ commanders: scenario.commanders, main: [] }, corpus.facts);
    const full = budget.full_deck;
    const complete = expected.deckPriceCents !== null;
    expect(full.minor_units, scenario.id).toMatchObject({
      default_total: expected.knownDeckPriceCents,
      min_buy: expected.knownDeckPriceCents,
    });
    expect(full.default_total_usd, scenario.id).toBe(expected.knownDeckPriceCents / 100);
    expect(full.min_buy_usd, scenario.id).toBe(expected.knownDeckPriceCents / 100);
    expect(full.coverage, scenario.id).toMatchObject({
      complete,
      default_total: { complete },
      min_buy: { complete },
      unresolved: [],
    });
    expect(
      full.coverage.missing_prices.map((entry) => entry.oracle_id).sort(),
      scenario.id,
    ).toEqual(expected.unknownPriceIds);
    expect(full.target_met, scenario.id).toBe(
      expected.deckPriceCents === null || scenario.budgetCents === undefined
        ? null
        : expected.deckPriceCents <= scenario.budgetCents,
    );
    expect(budget.library.minor_units.min_buy, scenario.id).toBe(library.knownDeckPriceCents);
    expect(budget.command_zone.minor_units.min_buy, scenario.id).toBe(
      commanders.knownDeckPriceCents,
    );
    expect(budget.companion.minor_units.min_buy, scenario.id).toBe(
      expected.companionPriceCents ?? 0,
    );
    expect(budget.scope.full_deck_quantity, scenario.id).toBe(100);
    expect(full.pricing.data_snapshot, scenario.id).toBe(corpus.snapshot);
    if (!complete) incompleteDecks += 1;

    // The current collection API stores membership. Explicitly compare all-copy ownership,
    // without relabeling the independent quantity-inventory grader as supported behavior.
    const membership: Record<string, number> = {};
    for (const entry of [...scenario.main, ...scenario.commanders.map((id) => ({ id, qty: 1 }))]) {
      if ((scenario.owned[entry.id] ?? 0) > 0)
        membership[entry.id] = (membership[entry.id] ?? 0) + entry.qty;
    }
    const memberExpected = priceDeck(artifact, corpus.facts, membership);
    const inventoryExpected = priceDeck(artifact, corpus.facts, scenario.owned);
    expect(acquisition.ownership_basis, scenario.id).toBe("oracle_id_membership_all_copies");
    expect(acquisition.minor_units.acquire, scenario.id).toBe(
      memberExpected.knownAcquirePriceCents,
    );
    expect(acquisition.acquire_usd, scenario.id).toBe(memberExpected.knownAcquirePriceCents / 100);
    expect(acquisition.coverage.acquire?.complete, scenario.id).toBe(
      memberExpected.acquirePriceCents !== null,
    );
    if (memberExpected.acquirePriceCents !== inventoryExpected.acquirePriceCents)
      quantityInventoryDifferences += 1;
  }

  expect(incompleteDecks).toBe(1); // Frozen Atraxa keeps its unpriced Reyhan.
  expect(quantityInventoryDifferences).toBeGreaterThan(0);
  expect(network).not.toHaveBeenCalled();
}, 120_000);
