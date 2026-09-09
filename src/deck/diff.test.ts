import { describe, expect, it } from "vitest";
import { DeckStore } from "./deckStore.js";
import { diffDecks } from "./diff.js";

describe("complete deck diffs", () => {
  it("reports zone, identity, role and legality-flag changes with aggregate quantities", () => {
    const store = new DeckStore();
    const original = store.create({ name: "Complete diff" });
    const before = {
      ...original,
      companion: "companion-old",
      cards: [
        { oracle_id: "same", qty: 1 },
        { oracle_id: "same", qty: 2 },
      ],
      role_overrides: { same: ["ramp" as const] },
    };
    const after = {
      ...original,
      version: 2,
      commanders: ["same"],
      cards: [{ oracle_id: "same", qty: 3, illegal: true }],
      computed_color_identity: ["U" as const],
      data_snapshot: "new-data",
      role_overrides: { same: ["card_draw" as const] },
    };
    const diff = diffDecks(before, after);
    expect(diff.cards).toMatchObject({ added: [], removed: [], changed: [] });
    expect(diff.metadata).toMatchObject({
      companion: { from: "companion-old", to: null },
      commanders: { from: [], to: ["same"] },
      computed_color_identity: { from: [], to: ["U"] },
      data_snapshot: { from: "", to: "new-data" },
      role_overrides: { from: before.role_overrides, to: after.role_overrides },
    });
    expect(diff.cards).toHaveProperty("flags", [
      { oracle_id: "same", from_illegal: false, to_illegal: true },
    ]);
  });
});

describe("deck intent diffs", () => {
  it("reports intent additions, modifications and removals", () => {
    const store = new DeckStore();
    const original = store.create({ name: "Intent" });
    const first = store.update(original.deck_id, (deck) => ({
      ...deck,
      intent: {
        schema_version: 1,
        soft: { strategy: "tokens" },
      },
    }));
    expect(diffDecks(original, first).metadata.intent).toEqual({
      from: null,
      to: first.intent,
    });
    const changed = store.update(original.deck_id, (deck) => ({
      ...deck,
      intent: {
        schema_version: 1,
        soft: { strategy: "combat" },
      },
    }));
    expect(diffDecks(first, changed).metadata.intent).toEqual({
      from: first.intent,
      to: changed.intent,
    });
    expect(diffDecks(first, original).metadata.intent).toEqual({
      from: first.intent,
      to: null,
    });
  });

  it("compares intent structurally without depending on object key insertion order", () => {
    const store = new DeckStore();
    const original = store.create({ name: "Intent" });
    const first = store.update(original.deck_id, (deck) => ({
      ...deck,
      intent: {
        schema_version: 1,
        soft: { strategy: "tokens", goals: ["win"] },
      },
    }));
    const second = store.update(original.deck_id, (deck) => ({
      ...deck,
      intent: {
        soft: { goals: ["win"], strategy: "tokens" },
        schema_version: 1,
      },
    }));
    expect(diffDecks(first, second).metadata).not.toHaveProperty("intent");
    expect(diffDecks(original, original).metadata).not.toHaveProperty("intent");
  });
});
