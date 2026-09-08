import { describe, expect, it } from "vitest";
import type { BenchmarkCase, BenchmarkEntry, BenchmarkFact } from "./corpus.js";
import { loadBenchmarkCorpus } from "./corpus.js";
import { gradeClaims, gradeDeck, priceDeck, type DeckArtifact } from "./graders.js";

const fact = (id: string, extra: Partial<BenchmarkFact> = {}): BenchmarkFact => ({
  id,
  name: id,
  colors: ["R"],
  maxCopies: 1,
  commander: false,
  legal: true,
  priceCents: 10,
  roles: [],
  ...extra,
});
const facts = {
  leader: fact("leader", { commander: true, priceCents: 203 }),
  mountain: fact("mountain", { maxCopies: null, priceCents: 3 }),
  dwarves: fact("dwarves", { maxCopies: 7, priceCents: 17, roles: ["dwarf"] }),
  blue: fact("blue", { colors: ["U"] }),
  banned: fact("banned", { legal: false }),
  unknownPrice: fact("unknownPrice", { priceCents: null }),
  companion: fact("companion", { priceCents: 71 }),
};
const scenario: BenchmarkCase = {
  id: "grader-contract",
  prompt: "Retain seven dwarves; finish at $20 including commander.",
  tags: ["quantity"],
  split: "calibration",
  request: "build",
  supported: true,
  commanders: ["leader"],
  main: [
    { id: "mountain", qty: 92 },
    { id: "dwarves", qty: 7 },
  ],
  startingMain: [{ id: "dwarves", qty: 7 }],
  protected: ["dwarves"],
  owned: { dwarves: 2, mountain: 90 },
  theme: [{ role: "dwarf", min: 7 }],
  budgetCents: 2000,
  maybeboard: [{ id: "blue", qty: 1 }],
};
const artifact = (): DeckArtifact =>
  structuredClone({
    commanders: scenario.commanders,
    main: scenario.main,
    maybeboard: scenario.maybeboard,
  });

function mainEntry(deck: DeckArtifact, index: number): BenchmarkEntry {
  const entry = deck.main[index];
  if (!entry) throw new Error(`Expected fixture main entry ${index}`);
  return entry;
}

it("grades complete corpus targets, retaining explicit unknown-price budget failures", async () => {
  const corpus = await loadBenchmarkCorpus();
  const failed = [];
  for (const target of corpus.cases) {
    const result = gradeDeck(target, corpus.facts, {
      commanders: target.commanders,
      main: target.main,
      ...(target.companion ? { companion: target.companion } : {}),
      ...(target.maybeboard ? { maybeboard: target.maybeboard } : {}),
    });
    if (target.tags.includes("unknown-price")) {
      expect(target.budgetCents, target.id).toBeDefined();
      expect(
        result.failures.map((failure) => failure.code),
        target.id,
      ).toEqual(["BUDGET"]);
      expect(result.failures[0]?.detail, target.id).toContain("cost unknown");
    } else if (!result.passed) failed.push({ id: target.id, failures: result.failures });
  }
  expect(failed).toEqual([]);
});

describe("independent artifact grader", () => {
  it("accepts the authored reference and counts main plus commander only", () => {
    expect(gradeDeck(scenario, facts, artifact())).toEqual({ passed: true, failures: [] });
  });
  it.each([
    [
      "card count",
      (a: DeckArtifact) => {
        mainEntry(a, 0).qty -= 1;
      },
      "CARD_COUNT",
    ],
    [
      "fractional quantity",
      (a: DeckArtifact) => {
        mainEntry(a, 0).qty = 92.5;
      },
      "QUANTITY",
    ],
    [
      "wrong command zone",
      (a: DeckArtifact) => {
        a.commanders = ["dwarves"];
      },
      "COMMAND_ZONE",
    ],
    [
      "off-color card",
      (a: DeckArtifact) => {
        mainEntry(a, 0).qty--;
        a.main.push({ id: "blue", qty: 1 });
      },
      "COLOR_IDENTITY",
    ],
    [
      "banned card",
      (a: DeckArtifact) => {
        mainEntry(a, 0).qty--;
        a.main.push({ id: "banned", qty: 1 });
      },
      "LEGALITY",
    ],
    [
      "seventh-copy boundary",
      (a: DeckArtifact) => {
        mainEntry(a, 0).qty--;
        mainEntry(a, 1).qty++;
      },
      "COPY_LIMIT",
    ],
    [
      "split-entry cap evasion",
      (a: DeckArtifact) => {
        mainEntry(a, 0).qty--;
        a.main.push({ id: "dwarves", qty: 1 });
      },
      "COPY_LIMIT",
    ],
    [
      "protected card removal",
      (a: DeckArtifact) => {
        mainEntry(a, 0).qty++;
        mainEntry(a, 1).qty--;
      },
      "PROTECTED",
    ],
    [
      "maybeboard laundering",
      (a: DeckArtifact) => {
        a.maybeboard = [];
      },
      "MAYBEBOARD",
    ],
    [
      "unresolved card",
      (a: DeckArtifact) => {
        mainEntry(a, 0).qty--;
        a.main.push({ id: "invented", qty: 1 });
      },
      "UNKNOWN_CARD",
    ],
  ] as const)("rejects plausible corruption: %s", (_name, mutate, code) => {
    const answer = artifact();
    mutate(answer);
    expect(gradeDeck(scenario, facts, answer).failures.map((f) => f.code)).toContain(code);
  });
  it("rejects lost theme independently of the protected-card constraint", () => {
    const answer = artifact();
    answer.main = [{ id: "mountain", qty: 99 }];
    const result = gradeDeck({ ...scenario, protected: [] }, facts, answer);
    expect(result.failures.map((f) => f.code)).toContain("THEME");
  });
  it.each([7, 9])("enforces finite copy cap %i at its exact boundary", (cap) => {
    const cappedFacts = { ...facts, dwarves: { ...facts.dwarves, maxCopies: cap } };
    const atCap = artifact();
    atCap.main = [
      { id: "mountain", qty: 99 - cap },
      { id: "dwarves", qty: cap },
    ];
    const capScenario = { ...scenario, protected: [], theme: [] };
    expect(gradeDeck(capScenario, cappedFacts, atCap).passed).toBe(true);
    mainEntry(atCap, 0).qty--;
    mainEntry(atCap, 1).qty++;
    expect(
      gradeDeck(capScenario, cappedFacts, atCap).failures.map((failure) => failure.code),
    ).toContain("COPY_LIMIT");
  });
  it("counts same-name aliases together and catches commander copies in main", () => {
    const answer = artifact();
    mainEntry(answer, 0).qty--;
    answer.main.push({ id: "leader", qty: 1 });
    expect(gradeDeck(scenario, facts, answer).failures.map((f) => f.code)).toContain("COPY_LIMIT");
    const alias = artifact();
    mainEntry(alias, 0).qty--;
    alias.main.push({ id: "alias", qty: 1 });
    expect(
      gradeDeck(
        scenario,
        { ...facts, alias: fact("alias", { name: "dwarves", maxCopies: 7 }) },
        alias,
      ).failures.map((f) => f.code),
    ).toContain("COPY_LIMIT");
  });
  it("uses authored pairs and outside-deck companion zones", () => {
    const paired: BenchmarkCase = {
      ...scenario,
      commanders: ["leader", "companion"],
      expectedPair: ["leader", "companion"],
      main: [
        { id: "mountain", qty: 91 },
        { id: "dwarves", qty: 7 },
      ],
    };
    expect(
      gradeDeck(paired, facts, {
        commanders: paired.commanders,
        main: paired.main,
        maybeboard: paired.maybeboard,
      }).passed,
    ).toBe(true);
    const withCompanion = { ...scenario, companion: "companion" };
    expect(gradeDeck(withCompanion, facts, { ...artifact(), companion: "companion" }).passed).toBe(
      true,
    );
    expect(gradeDeck(withCompanion, facts, artifact()).failures.map((f) => f.code)).toContain(
      "COMPANION_ZONE",
    );
  });
});

describe("independent cents, owned quantities and claimed output", () => {
  it("prices every copy plus commander and subtracts only owned copies", () => {
    expect(priceDeck(artifact(), facts, scenario.owned)).toEqual({
      deckPriceCents: 598,
      acquirePriceCents: 294,
      companionPriceCents: 0,
      knownDeckPriceCents: 598,
      knownAcquirePriceCents: 294,
      unknownPriceIds: [],
    });
  });
  it("keeps optional companion cost outside the deck total", () => {
    expect(
      priceDeck({ ...artifact(), companion: "companion" }, facts, scenario.owned),
    ).toMatchObject({
      deckPriceCents: 598,
      acquirePriceCents: 294,
      companionPriceCents: 71,
    });
  });
  it("never turns excess owned copies into a credit", () => {
    expect(
      priceDeck(artifact(), facts, { dwarves: 500, mountain: 500, leader: 5 }).acquirePriceCents,
    ).toBe(0);
  });
  it("keeps incomplete prices unknown, including free-acquisition owned unknowns", () => {
    const answer = artifact();
    mainEntry(answer, 0).qty--;
    answer.main.push({ id: "unknownPrice", qty: 1 });
    expect(priceDeck(answer, facts, { ...scenario.owned, unknownPrice: 1 })).toMatchObject({
      deckPriceCents: null,
      acquirePriceCents: 291,
      unknownPriceIds: ["unknownPrice"],
    });
    expect(gradeClaims(scenario, facts, answer, { deckPriceCents: 595 }).passed).toBe(false);
  });
  it.each([
    ["omitted commander", { deckPriceCents: 395 }, "DECK_PRICE"],
    ["all owned quantities zeroed", { acquirePriceCents: 203 }, "ACQUIRE_PRICE"],
    ["one cent rounding drift", { deckPriceCents: 599 }, "DECK_PRICE"],
    ["count includes maybeboard", { totalCards: 101 }, "CLAIMED_COUNT"],
    ["made-up theme count", { themeCounts: { dwarf: 8 } }, "CLAIMED_THEME"],
  ] as const)("rejects plausible claim mutation: %s", (_name, claims, code) => {
    expect(gradeClaims(scenario, facts, artifact(), claims).failures.map((f) => f.code)).toContain(
      code,
    );
  });
  it("rejects an asserted legal verdict despite plausible count and price", () => {
    const answer = artifact();
    mainEntry(answer, 0).qty--;
    answer.main.push({ id: "blue", qty: 1 });
    expect(
      gradeClaims(scenario, facts, answer, { legal: true }).failures.map((f) => f.code),
    ).toContain("CLAIMED_LEGALITY");
  });
  it("does not let collection savings satisfy a full-deck budget", () => {
    expect(
      gradeDeck({ ...scenario, budgetCents: 400 }, facts, artifact()).failures.map((f) => f.code),
    ).toContain("BUDGET");
    expect(
      gradeDeck({ ...scenario, request: "acquisition", budgetCents: 400 }, facts, artifact())
        .passed,
    ).toBe(true);
  });
});
