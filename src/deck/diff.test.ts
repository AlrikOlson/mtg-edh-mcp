import { describe, expect, it } from "vitest";
import { DeckStore } from "./deckStore.js";
import { diffDecks } from "./diff.js";

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
    expect(diffDecks(original, first).metadata.intent).toEqual({ from: null, to: first.intent });
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
    expect(diffDecks(first, original).metadata.intent).toEqual({ from: first.intent, to: null });
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
