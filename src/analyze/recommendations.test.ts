import { afterEach, describe, expect, it } from "vitest";
import type { Deck } from "../types/index.js";
import { discoveryFixture, rawCard } from "./discovery.fixture.js";
import { recommendCards } from "./recommendations.js";

let fixture: Awaited<ReturnType<typeof discoveryFixture>>;
afterEach(async () => {
  await fixture?.close();
});
const chief = rawCard("Chief", "Sacrifice a creature: Scry 1.", {
  type_line: "Legendary Creature — Human",
  color_identity: ["W", "B"],
});
function deck(patch: Partial<Deck> = {}): Deck {
  return {
    deck_id: "recommend-probe",
    name: "Synthetic recommendation probes",
    format: "commander",
    commanders: ["Chief"],
    command_zone_kind: "single",
    cards: [],
    computed_color_identity: ["W", "B"],
    version: 7,
    data_snapshot: "2026-09-08",
    ...patch,
  };
}
const names = (result: ReturnType<typeof recommendCards>) => result.suggestions.map((s) => s.name);
const tokens = (name: string, extra = {}) =>
  rawCard(name, "Create two 1/1 white Soldier creature tokens.", {
    type_line: "Sorcery",
    ...extra,
  });

describe("offline contextual recommendations", () => {
  it("ranks the full bounded pool after more than 50 alphabetical decoys and preserves state", async () => {
    fixture = await discoveryFixture([
      chief,
      ...Array.from({ length: 80 }, (_, i) => rawCard(`A decoy ${i}`, "Flying")),
      tokens("Z supply"),
    ]);
    const current = deck();
    const before = structuredClone(current);
    const result = recommendCards(fixture.index, current, { limit: 1 });
    expect(names(result)).toEqual(["Z supply"]);
    expect(result.coverage.scanned).toBe(82);
    expect(result.suggestions[0]?.evidence.strategy_links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "token_sacrifice", source: "Z supply", target: "Chief" }),
      ]),
    );
    expect(result.suggestions[0]?.tradeoffs.length).toBeGreaterThan(0);
    expect(result.suggestions[0]?.uncertainty.length).toBeGreaterThan(0);
    expect(recommendCards(fixture.index, current, { limit: 1 })).toEqual(result);
    expect(current).toEqual(before);
  });
  it("enforces legal identity, explicit exclusions, existing cards and land filters", async () => {
    fixture = await discoveryFixture([
      chief,
      tokens("Good"),
      tokens("Banned", { legalities: { commander: "banned" } }),
      tokens("Blue", { color_identity: ["U"] }),
      tokens("Excluded"),
      tokens("Present"),
      tokens("Land", { type_line: "Land" }),
    ]);
    const current = deck({
      cards: [{ oracle_id: "Present", qty: 1 }],
      intent: { schema_version: 1, hard: { excluded_cards: ["Excluded"] } },
    });
    const result = recommendCards(fixture.index, current);
    expect(names(result)).toEqual(["Good"]);
    expect(result.exclusions.counts).toMatchObject({
      legality: 1,
      color_identity: 1,
      excluded_card: 1,
      already_in_deck: 2,
      land: 1,
    });
  });
  it("checks one-card additions against locks, commander constraints and change limits", async () => {
    fixture = await discoveryFixture([chief, tokens("Required"), tokens("Other")]);
    expect(
      names(
        recommendCards(
          fixture.index,
          deck({
            intent: {
              schema_version: 1,
              hard: { locked_cards: [{ oracle_id: "Required", qty: 1 }] },
            },
          }),
        ),
      ),
    ).toEqual(["Required"]);
    expect(
      recommendCards(
        fixture.index,
        deck({ intent: { schema_version: 1, hard: { change_limit: 0 } } }),
      ).suggestions,
    ).toEqual([]);
    expect(
      recommendCards(
        fixture.index,
        deck({ intent: { schema_version: 1, hard: { commanders: { required: ["Other"] } } } }),
      ).suggestions,
    ).toEqual([]);
  });
  it("makes progress on multiple missing protected cards while retaining every outstanding requirement", async () => {
    fixture = await discoveryFixture([
      chief,
      tokens("First required"),
      tokens("Second required"),
      tokens("Unrelated"),
    ]);
    const current = deck({
      intent: {
        schema_version: 1,
        hard: {
          locked_cards: [
            { oracle_id: "First required", qty: 1 },
            { oracle_id: "Second required", qty: 1 },
          ],
        },
      },
    });
    const result = recommendCards(fixture.index, current);
    expect(names(result)).toEqual(["First required", "Second required"]);
    expect(
      result.metadata.policy.baseline_findings.filter(
        (f) => f.category === "locked_cards" && f.status === "fail",
      ),
    ).toHaveLength(2);
    for (const candidate of result.suggestions) {
      const failures = candidate.evidence.policy_findings.filter(
        (f) => f.category === "locked_cards" && f.status === "fail",
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]?.cards[0]?.oracle_id).not.toBe(candidate.oracle_id);
      expect(candidate.uncertainty.join(" ")).toContain("protected-card requirements remain unmet");
    }
    const conflicting = deck({
      intent: {
        schema_version: 1,
        hard: { ...current.intent?.hard, commanders: { required: ["First required"] } },
      },
    });
    expect(recommendCards(fixture.index, conflicting).suggestions).toEqual([]);
  });
  it("rejects a prospective companion restriction violation and exposes partial companion coverage", async () => {
    fixture = await discoveryFixture([
      chief,
      tokens("Expensive", { cmc: 5, type_line: "Creature" }),
      tokens("Cheap", { cmc: 2, type_line: "Creature" }),
      rawCard(
        "Lurrus of the Dream-Den",
        "Companion — Each permanent card in your starting deck has mana value 2 or less.",
        { type_line: "Legendary Creature — Cat Nightmare" },
      ),
    ]);
    const result = recommendCards(fixture.index, deck({ companion: "Lurrus of the Dream-Den" }));
    expect(names(result)).toEqual(["Cheap"]);
    expect(result.exclusions.counts.companion).toBe(1);
    expect(result.metadata.companion.status).toBe("partial");
  });
  it("checks supported prospective policy failures and reports unsupported package checks as unknown", async () => {
    fixture = await discoveryFixture([chief, tokens("Armageddon"), tokens("Good")]);
    const result = recommendCards(
      fixture.index,
      deck({
        intent: {
          schema_version: 1,
          playgroup: { limits: { mass_land_denial: 0, infinite_combos: 0 } },
        },
      }),
    );
    expect(names(result)).toEqual(["Good"]);
    expect(result.exclusions.counts.policy).toBe(1);
    expect(result.suggestions[0]?.uncertainty.join(" ")).toContain("infinite_combos");
  });
  it("does not turn unsupported filtered triggers or shared role labels into a mechanical link", async () => {
    fixture = await discoveryFixture([
      rawCard("Chief", "Whenever a nontoken creature you control dies, draw a card.", {
        type_line: "Legendary Creature — Human",
      }),
      rawCard("Outlet", "Sacrifice a creature: Scry 1."),
      tokens("Tokens"),
    ]);
    const current = deck({ role_overrides: { Outlet: ["card_draw"], Tokens: ["card_draw"] } });
    for (const candidate of recommendCards(fixture.index, current).suggestions)
      expect(candidate.evidence.strategy_links).toEqual([]);
  });
  it("reports query filtering, unsupported declared strategy and scan/output truncation", async () => {
    fixture = await discoveryFixture([
      chief,
      tokens("A supply"),
      tokens("B supply"),
      tokens("Z supply"),
    ]);
    const result = recommendCards(
      fixture.index,
      deck({ intent: { schema_version: 1, soft: { strategy: "space opera" } } }),
      { limit: 1, scan_limit: 2, oracle_query: "t:sorcery" },
    );
    expect(result.coverage.scan_truncated).toBe(true);
    expect(result.coverage.results_truncated).toBe(true);
    expect(result.metadata.theme.status).toBe("unsupported");
    expect(result.suggestions[0]?.evidence.query).toEqual({
      query: "t:sorcery",
      oracle_id: "A supply",
    });
  });
  it("keeps prices and provider evidence explicitly unknown without inventing a budget or popularity score", async () => {
    fixture = await discoveryFixture([chief, tokens("Unknown Price")]);
    const result = recommendCards(
      fixture.index,
      deck({ intent: { schema_version: 1, soft: { spend_target_usd: 20 } } }),
    );
    expect(result.suggestions[0]?.budget_impact.status).toBe("unknown");
    expect(result.suggestions[0]?.budget_impact.candidate_usd).toBeNull();
    expect(result.metadata.recommendation_providers).toBe("not_used");
  });
});

it("returns an explicit tradeoff when a recommended land supplies a commander", async () => {
  fixture = await discoveryFixture([chief, tokens("Token land", { type_line: "Land" })]);
  const result = recommendCards(fixture.index, deck(), { exclude_lands: false });
  expect(result.suggestions[0]?.tradeoffs.length).toBeGreaterThan(0);
});

it("retains up to 100 ranked results and keeps public scores equal to their components", async () => {
  fixture = await discoveryFixture([
    chief,
    ...Array.from({ length: 75 }, (_, i) => tokens(`Supply ${i}`)),
  ]);
  const result = recommendCards(fixture.index, deck(), { limit: 100 });
  expect(result.suggestions).toHaveLength(75);
  expect(result.coverage.results_truncated).toBe(false);
  for (const candidate of result.suggestions)
    expect(candidate.score).toBe(
      Object.values(candidate.score_breakdown).reduce((a, b) => a + b, 0),
    );
});

it("preserves a zero-score supported theme result and shows that a full deck requires a cut", async () => {
  fixture = await discoveryFixture([
    rawCard("Chief", "Flying", { type_line: "Legendary Creature — Human" }),
    tokens("Large theme card", { cmc: 5 }),
    rawCard("Land", "", { type_line: "Basic Land — Plains", cmc: 0 }),
  ]);
  const result = recommendCards(fixture.index, deck({ cards: [{ oracle_id: "Land", qty: 99 }] }), {
    theme: "tokens",
  });
  expect(result.suggestions[0]?.score).toBe(0);
  expect(result.suggestions[0]?.tradeoffs.join(" ")).toContain(
    "requires a separately evaluated cut",
  );
});
