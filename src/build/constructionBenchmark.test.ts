import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { constructDeck } from "./construction.js";
import {
  constructionCardId,
  constructionCases,
  constructionFixture,
  constructionProvenance,
} from "./construction.fixture.js";
import { prepareDeckChange } from "../deck/deckPlan.js";

let fixture: Awaited<ReturnType<typeof constructionFixture>>;
beforeAll(async () => {
  fixture = await constructionFixture();
});
afterAll(async () => {
  await fixture.close();
});

describe("frozen real-card deck construction, providers absent", () => {
  it.each(constructionCases)("$id produces a complete supported strategy reproducibly", (task) => {
    const before = structuredClone(task.request);
    const options = { dataSnapshot: constructionProvenance.frozen_at, name: task.id };
    const result = constructDeck(task.request, fixture.index, options);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe("found");
    expect(result.proposal).not.toBeNull();
    expect(result.validation?.valid).toBe(true);
    expect(result.source.recommendation_providers).toBe("not_used");
    if (task.coverage.includes("theme_first"))
      expect(result.selection.method).toBe("theme_discovery");
    if (task.coverage.includes("explicit_alternatives"))
      expect(result.selection.method).toBe("alternatives");
    if (!result.proposal) throw new Error(`${task.id}: found construction must include a proposal`);
    const prepared = prepareDeckChange(
      result.proposal,
      fixture.index,
      undefined,
      options.dataSnapshot,
    );
    expect(prepared.validation.valid, JSON.stringify(prepared.validation.diagnostics)).toBe(true);
    expect(prepared.validation.legality).toEqual([]);
    const deck = prepared.desired;
    const counts = new Map(deck.cards.map((card) => [card.oracle_id, card.qty]));
    expect(deck.commanders).toHaveLength(task.expected.commanderCount);
    expect(deck.computed_color_identity).toHaveLength(task.expected.colorCount);
    expect(deck.cards.reduce((sum, card) => sum + card.qty, 0) + deck.commanders.length).toBe(100);
    expect(new Set(deck.cards.map((card) => card.oracle_id)).size).toBe(deck.cards.length);
    expect(deck.commanders.every((id) => !counts.has(id))).toBe(true);

    // Independent card inventory assertions prevent a legal 100-basic shell
    // from passing when the builder forgets composition or strategy constraints.
    const nonlands = deck.cards.reduce((sum, entry) => {
      const card = fixture.index.getCard(entry.oracle_id);
      if (!card)
        throw new Error(
          `${task.id}: proposed card is missing from the pinned index: ${entry.oracle_id}`,
        );
      return sum + (/\bLand\b/.test(card.type_line) ? 0 : entry.qty);
    }, 0);
    expect(nonlands).toBeGreaterThanOrEqual(task.expected.minimumNonlands);
    expect(prepared.validation.land_count).toBeGreaterThanOrEqual(36);
    expect(prepared.validation.land_count).toBeLessThanOrEqual(38);
    for (const [role, minimum] of [
      ["ramp", 8],
      ["card_draw", 6],
      ["spot_removal", 5],
    ] as const)
      expect(prepared.validation.role_counts[role] ?? 0, role).toBeGreaterThanOrEqual(minimum);
    for (const card of task.expected.requiredCards)
      expect(
        counts.get(card.oracle_id) ?? 0,
        fixture.index.getCard(card.oracle_id)?.name,
      ).toBeGreaterThanOrEqual(card.qty);
    if (task.expected.companion) {
      expect(deck.companion).toBe(task.expected.companion);
      expect(counts.has(task.expected.companion)).toBe(false);
      expect(deck.commanders).not.toContain(task.expected.companion);
    }
    if (task.coverage.includes("finite_multiplicity"))
      expect(counts.get(constructionCardId("Seven Dwarves"))).toBe(7);
    if (task.id === "obscure-token-sacrifice") {
      // The human-facing plan must explain how the declared creature tokens
      // feed the declared sacrifice outlet, not merely list arbitrary cards.
      const producer = constructionCardId("Goblin Wizardry");
      const consumer = constructionCardId("Ruthless Knave");
      expect(
        result.explanations.game_plan.some(
          (plan) =>
            plan.source_ids.includes(producer) &&
            plan.consumer_ids.includes(consumer) &&
            plan.summary.length > 0,
        ),
      ).toBe(true);
      expect(
        result.explanations.key_dependencies.some(
          (dependency) =>
            dependency.oracle_id === consumer && dependency.provider_ids.includes(producer),
        ),
      ).toBe(true);
    }
    expect(constructDeck(task.request, fixture.index, options).proposal).toEqual(result.proposal);
    expect(task.request).toEqual(before);
  });

  it("pins at least twelve nontrivial tasks covering color counts and special deck rules", () => {
    expect(constructionCases.length).toBeGreaterThanOrEqual(12);
    expect(new Set(constructionCases.map((task) => task.expected.colorCount))).toEqual(
      new Set([0, 1, 2, 3, 4, 5]),
    );
    const coverage = new Set(constructionCases.flatMap((task) => task.coverage));
    for (const required of [
      "empty",
      "partial",
      "theme_first",
      "obscure_commander",
      "legal_partner",
      "legal_background",
      "legal_doctor_companion",
      "supported_companion",
      "finite_multiplicity",
      "any_number_multiplicity",
    ])
      expect(coverage.has(required), required).toBe(true);
    expect(constructionCases.every((task) => task.coverage.includes("providers_absent"))).toBe(
      true,
    );
    expect(
      constructionCases.every(
        (task) => task.expected.minimumNonlands >= 60 && task.expected.requiredCards.length >= 3,
      ),
    ).toBe(true);
    expect(constructionProvenance.source).toBe("https://api.scryfall.com/cards/collection");
    expect(constructionProvenance.frozen_at).toBe("2026-09-09");
  });
});
