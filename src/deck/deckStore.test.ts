import { describe, it, expect, vi } from "vitest";
import { DeckStore, type DeckStoreDump } from "./deckStore.js";
import type { UserDataDriver } from "../storage/driver.js";
import type { Deck } from "../types/index.js";

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

function desiredDeck(overrides: Partial<Deck> = {}): Deck {
  return {
    deck_id: "preview-only",
    name: "Complete plan",
    format: "commander",
    commanders: ["commander-a", "commander-b"],
    command_zone_kind: "partner",
    companion: "companion",
    cards: [{ oracle_id: "card", qty: 2, illegal: true }],
    computed_color_identity: ["G", "U"],
    role_overrides: { card: ["ramp"] },
    intent: { schema_version: 1, soft: { strategy: "tokens" } },
    version: 100,
    data_snapshot: "2026-09-09",
    ...overrides,
  };
}

function recordingDriver(): UserDataDriver & { saveDecks: ReturnType<typeof vi.fn> } {
  let persisted: DeckStoreDump = { decks: [], snapshots: [] };
  return {
    transaction: (callback) => callback(),
    afterCommit: (callback) => callback(),
    loadDecks: () => structuredClone(persisted),
    saveDecks: vi.fn((dump: DeckStoreDump) => {
      persisted = structuredClone(dump);
    }),
    getCollection: () => [],
    setCollection: () => {},
  };
}

describe("DeckStore atomic plan commits", () => {
  it("creates a complete deck and receipt with a fresh id, version one and one save", () => {
    const driver = recordingDriver();
    const store = new DeckStore({ driver, newId: () => "allocated" });
    const dirty = vi.fn();
    store.onDirty(dirty);
    const desired = desiredDeck();
    const result = store.transaction(() =>
      store.commitPlan({ plan_id: "plan-a", request_hash: "hash-a", desired }),
    );
    expect(result).toEqual({
      receipt: {
        plan_id: "plan-a",
        request_hash: "hash-a",
        deck: { ...desired, deck_id: "allocated", version: 1 },
      },
      replayed: false,
    });
    expect(driver.saveDecks).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenCalledTimes(1);
    expect(store.listSnapshots("allocated")).toEqual([]);
    desired.name = "Mutated input";
    result.receipt.deck.name = "Mutated result";
    const receipt = store.getPlanReceipt("plan-a");
    expect(receipt?.deck.name).toBe("Complete plan");
    if (!receipt) throw new Error("missing receipt");
    receipt.deck.name = "Mutated read";
    expect(store.get("allocated")?.name).toBe("Complete plan");
    expect(store.getPlanReceipt("plan-a")?.deck.name).toBe("Complete plan");
  });

  it("snapshots all previous state and replaces it in one version bump and durable save", () => {
    const driver = recordingDriver();
    const store = new DeckStore({ driver, newId: () => "deck", newSnapshotId: () => "before" });
    store.create({ name: "Original" });
    const before = store.update("deck", () => desiredDeck({ name: "Before" }));
    driver.saveDecks.mockClear();
    const changed = vi.fn();
    const dirty = vi.fn();
    store.onChange(changed);
    store.onDirty(dirty);
    const desired = desiredDeck({
      name: "After",
      commanders: ["new-commander"],
      command_zone_kind: "single",
      companion: undefined,
      cards: [],
      computed_color_identity: ["R"],
      role_overrides: undefined,
      intent: undefined,
      data_snapshot: "2026-10-01",
    });
    const result = store.commitPlan({
      plan_id: "replace",
      request_hash: "replace-hash",
      deck_id: "deck",
      expected_version: before.version,
      desired,
    });
    expect(result.receipt.deck).toEqual({ ...desired, deck_id: "deck", version: 3 });
    expect(result.receipt.snapshot_id).toBe("before");
    expect(store.getSnapshot("deck", "before")?.deck).toEqual(before);
    expect(driver.saveDecks).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledExactlyOnceWith("deck", 3, "local");
    expect(dirty).toHaveBeenCalledTimes(1);
    expect(store.restore("deck", "before")).toEqual({ ...before, version: 4 });
  });

  it("replays a hydrated receipt after later edits and deletion without writing or notifying", () => {
    const store = storeWithIds("created");
    const input = { plan_id: "replay", request_hash: "hash", desired: desiredDeck() };
    const original = store.commitPlan(input, "alice").receipt;
    store.setName("created", "Later edit", "alice");
    store.delete("created", "alice");
    const driver = recordingDriver();
    const restarted = new DeckStore({ driver });
    restarted.hydrate(JSON.parse(JSON.stringify(store.dump())));
    driver.saveDecks.mockClear();
    const changed = vi.fn();
    const dirty = vi.fn();
    restarted.onChange(changed);
    restarted.onDirty(dirty);
    expect(restarted.commitPlan(input, "alice")).toEqual({ receipt: original, replayed: true });
    expect(restarted.list("alice")).toEqual([]);
    expect(restarted.getPlanReceipt("replay", "bob")).toBeUndefined();
    expect(driver.saveDecks).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(dirty).not.toHaveBeenCalled();
    expect(() =>
      restarted.commitPlan({ ...input, request_hash: "different" }, "alice"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));
  });

  it("checks a replay before the target version and isolates same plan ids across sessions", () => {
    const store = storeWithIds("existing", "bob-deck");
    store.create({ name: "Alice" }, "alice");
    const input = {
      plan_id: "shared-id",
      request_hash: "hash",
      deck_id: "existing",
      expected_version: 1,
      desired: desiredDeck(),
    };
    const original = store.commitPlan(input, "alice");
    store.delete("existing", "alice");
    expect(store.commitPlan(input, "alice")).toEqual({ ...original, replayed: true });
    expect(
      store.commitPlan(
        { plan_id: "shared-id", request_hash: "bob-hash", desired: desiredDeck() },
        "bob",
      ).receipt.deck.deck_id,
    ).toBe("bob-deck");
  });

  it("rejects stale or missing versions and invalid identities without partial mutations", () => {
    const store = storeWithIds("existing");
    store.create({ name: "Before" });
    const before = store.dump();
    const base = { plan_id: "attempt", request_hash: "hash", desired: desiredDeck() };
    for (const expected_version of [undefined, 0, -1, 1.5, 2, NaN, Infinity]) {
      expect(() =>
        store.commitPlan({ ...base, deck_id: "existing", expected_version }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));
    }
    for (const expected_version of [0, 1, NaN]) {
      expect(() => store.commitPlan({ ...base, expected_version })).toThrowError(
        expect.objectContaining({ code: "INVALID_QUERY" }),
      );
    }
    for (const session of ["", "alice\0other"]) {
      expect(() => store.commitPlan(base, session)).toThrowError(
        expect.objectContaining({ code: "INVALID_QUERY" }),
      );
      expect(() => store.getPlanReceipt(base.plan_id, session)).toThrowError(
        expect.objectContaining({ code: "INVALID_QUERY" }),
      );
    }
    for (const plan_id of ["", "plan\0other"]) {
      expect(() => store.commitPlan({ ...base, plan_id })).toThrowError(
        expect.objectContaining({ code: "INVALID_QUERY" }),
      );
    }
    expect(() =>
      store.commitPlan({ ...base, deck_id: "missing", expected_version: 1 }),
    ).toThrowError(expect.objectContaining({ code: "DECK_NOT_FOUND" }));
    expect(store.dump()).toEqual(before);
  });

  it("rolls back the deck, snapshot and receipt and suppresses events when a durable save fails", () => {
    const driver = recordingDriver();
    const store = new DeckStore({ driver, newId: () => "existing" });
    store.create({ name: "Before" });
    const before = store.dump();
    const changed = vi.fn();
    const dirty = vi.fn();
    store.onChange(changed);
    store.onDirty(dirty);
    driver.saveDecks.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() =>
      store.commitPlan({
        plan_id: "fail",
        request_hash: "hash",
        deck_id: "existing",
        expected_version: 1,
        desired: desiredDeck(),
      }),
    ).toThrow("disk full");
    expect(store.dump()).toEqual(before);
    expect(store.getPlanReceipt("fail")).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
    expect(dirty).not.toHaveBeenCalled();
  });

  it("rolls back a nested committed plan when the outer validation transaction throws", () => {
    const store = storeWithIds("existing");
    store.create({ name: "Before" });
    const before = store.dump();
    const changed = vi.fn();
    store.onChange(changed);
    expect(() =>
      store.transaction(() => {
        store.commitPlan({
          plan_id: "nested",
          request_hash: "hash",
          deck_id: "existing",
          expected_version: 1,
          desired: desiredDeck(),
        });
        throw new Error("outer failure");
      }),
    ).toThrow("outer failure");
    expect(store.dump()).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
  });
});
