import { describe, it, expect, vi } from "vitest";
import { DeckStore } from "./deckStore.js";

function storeWithIds(...ids: string[]): DeckStore {
  let i = 0;
  return new DeckStore({ newId: () => ids[i++] ?? `id-${i}` });
}

describe("DeckStore lifecycle", () => {
  it("creates, gets, lists, and deletes decks", () => {
    const store = storeWithIds("d1", "d2");
    const a = store.create({ name: "Atraxa" });
    expect(a).toMatchObject({ deck_id: "d1", name: "Atraxa", format: "commander", version: 1 });
    store.create({ name: "Goblins" });

    expect(store.get("d1")?.name).toBe("Atraxa");
    expect(
      store
        .list()
        .map((d) => d.deck_id)
        .sort(),
    ).toEqual(["d1", "d2"]);
    expect(store.delete("d1")).toBe(true);
    expect(store.get("d1")).toBeUndefined();
    expect(store.list()).toHaveLength(1);
  });

  it("isolates decks by session", () => {
    const store = storeWithIds("d1", "d2");
    store.create({ name: "Mine" }, "alice");
    store.create({ name: "Yours" }, "bob");
    expect(store.list("alice").map((d) => d.name)).toEqual(["Mine"]);
    expect(store.get("d1", "bob")).toBeUndefined();
  });
});

describe("DeckStore mutation + notification", () => {
  it("bumps version and emits onChange on update", () => {
    const store = storeWithIds("d1");
    store.create({ name: "Atraxa" });
    const listener = vi.fn();
    store.onChange(listener);

    const updated = store.setName("d1", "Atraxa Superfriends");
    expect(updated.version).toBe(2);
    expect(updated.name).toBe("Atraxa Superfriends");
    expect(listener).toHaveBeenCalledWith("d1", 2, "local");

    store.setName("d1", "Atraxa v3");
    expect(store.get("d1")?.version).toBe(3);
  });

  it("stops notifying after unsubscribe", () => {
    const store = storeWithIds("d1");
    store.create({ name: "X" });
    const listener = vi.fn();
    const off = store.onChange(listener);
    off();
    store.setName("d1", "Y");
    expect(listener).not.toHaveBeenCalled();
  });

  it("throws DECK_NOT_FOUND when updating an unknown deck", () => {
    const store = new DeckStore();
    expect(() => store.setName("nope", "X")).toThrowError(
      expect.objectContaining({ code: "DECK_NOT_FOUND" }),
    );
  });

  it("threads a declared companion through update, snapshot, and restore", () => {
    const store = storeWithIds("d1");
    store.create({ name: "Lutri deck" });

    store.update("d1", (d) => ({ ...d, companion: "o-lutri" }));
    expect(store.get("d1")?.companion).toBe("o-lutri");

    const snap = store.snapshot("d1");
    store.update("d1", (d) => ({ ...d, companion: undefined }));
    expect(store.get("d1")?.companion).toBeUndefined();

    store.restore("d1", snap.snapshot_id);
    expect(store.get("d1")?.companion).toBe("o-lutri");
  });
});
