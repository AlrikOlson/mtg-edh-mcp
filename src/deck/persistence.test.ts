import { describe, expect, it } from "vitest";
import { DeckStore } from "./deckStore.js";
import { parseDeckStoreDump } from "./persistence.js";

describe("deck persistence validation", () => {
  it("round-trips intent and snapshots, restores it, and accepts legacy absence", () => {
    const store = new DeckStore();
    const deck = store.create({ name: "Intent" });
    const legacy = store.dump();
    expect(parseDeckStoreDump(legacy).decks[0]?.[1]).not.toHaveProperty("intent");
    const updated = store.update(deck.deck_id, (d) => ({
      ...d,
      intent: {
        schema_version: 1,
        hard: { locked_cards: [{ oracle_id: "pet", qty: 1 }] },
        soft: { strategy: "tokens", spend_target_usd: 50 },
        unsupported: ["Guarantee a win"],
      },
    }));
    const snapshot = store.snapshot(deck.deck_id);
    const clone = new DeckStore();
    clone.hydrate(parseDeckStoreDump(JSON.parse(JSON.stringify(store.dump()))));
    expect(clone.get(deck.deck_id)?.intent).toEqual(updated.intent);
    clone.update(deck.deck_id, (d) => ({ ...d, intent: undefined }));
    expect(clone.restore(deck.deck_id, snapshot.snapshot_id).intent).toEqual(updated.intent);
  });

  it("rejects malformed persisted intent including future schema versions", () => {
    const store = new DeckStore();
    store.create({ name: "Intent" });
    for (const intent of [{ schema_version: 2 }, { schema_version: 1, hard: { mystery: true } }]) {
      const dump = store.dump();
      const entry = dump.decks[0];
      if (!entry) throw new Error("missing deck");
      Object.assign(entry[1], { intent });
      expect(() => parseDeckStoreDump(dump)).toThrow();
    }
  });

  it("round-trips deck content, role overrides and snapshots across sessions", () => {
    const store = new DeckStore();
    const deck = store.create({ name: "Alpha" });
    store.create({ name: "Bravo" }, "other-principal");
    store.update(deck.deck_id, (d) => ({ ...d, role_overrides: { card: ["ramp"] } }));
    store.snapshot(deck.deck_id);
    const dump = parseDeckStoreDump(JSON.parse(JSON.stringify(store.dump())));
    const clone = new DeckStore();
    clone.hydrate(dump);
    expect(clone.dump()).toEqual(store.dump());
  });

  it("rejects mismatched deck keys, snapshot versions and unknown role values", () => {
    const store = new DeckStore();
    const deck = store.create({ name: "Alpha" });
    store.snapshot(deck.deck_id);
    const dump = store.dump();
    const entry = dump.decks[0];
    if (!entry) throw new Error("missing deck");
    entry[0] = "local\0wrong";
    expect(() => parseDeckStoreDump(dump)).toThrow(/key/);
    const snapshotDump = store.dump();
    const snapshot = snapshotDump.snapshots[0];
    if (!snapshot) throw new Error("missing snapshot");
    snapshot[1].version++;
    expect(() => parseDeckStoreDump(snapshotDump)).toThrow(/version/);
    const invalid = JSON.stringify(store.dump()).replace(
      '"name":"Alpha"',
      '"name":"Alpha","role_overrides":{"card":["unknown"]}',
    );
    expect(() => parseDeckStoreDump(JSON.parse(invalid))).toThrow();
  });

  it("preserves legacy dumps without receipt fields and round-trips committed receipts", () => {
    const legacy = { decks: [], snapshots: [] };
    expect(parseDeckStoreDump(legacy)).toEqual(legacy);
    expect(parseDeckStoreDump(legacy)).not.toHaveProperty("plan_receipts");
    const store = new DeckStore({ newId: () => "existing", newSnapshotId: () => "before" });
    const deck = store.create({ name: "Before" }, "alice");
    const input = {
      plan_id: "persisted-plan",
      request_hash: "hash",
      deck_id: deck.deck_id,
      expected_version: deck.version,
      desired: { ...deck, name: "After" },
    };
    const committed = store.commitPlan(input, "alice");
    const parsed = parseDeckStoreDump(JSON.parse(JSON.stringify(store.dump())));
    expect(parsed.plan_receipts).toEqual([["alice\0persisted-plan", committed.receipt]]);
    const restored = new DeckStore();
    restored.hydrate(parsed);
    expect(restored.commitPlan(input, "alice")).toEqual({ ...committed, replayed: true });
    expect(restored.getSnapshot(deck.deck_id, "before", "alice")?.deck).toEqual(deck);
  });

  it("rejects receipt identity mismatches, duplicate keys, invalid payloads and unknown fields", () => {
    const store = new DeckStore({ newId: () => "allocated" });
    const desired = new DeckStore().create({ name: "Preview" });
    store.commitPlan({ plan_id: "plan", request_hash: "hash", desired }, "alice");
    const dump = store.dump();
    const entry = dump.plan_receipts?.[0];
    if (!entry) throw new Error("missing receipt");
    for (const key of ["alice\0wrong", "\0plan", "alice\0extra\0plan"]) {
      expect(() => parseDeckStoreDump({ ...dump, plan_receipts: [[key, entry[1]]] })).toThrow(
        /receipt key/,
      );
    }
    expect(() => parseDeckStoreDump({ ...dump, plan_receipts: [entry, entry] })).toThrow(
      /duplicate plan receipt/,
    );
    for (const patch of [
      { plan_id: "" },
      { plan_id: "bad\0plan" },
      { request_hash: "" },
      { snapshot_id: "" },
      { deck: { ...entry[1].deck, version: 0 } },
      { unknown: true },
    ]) {
      expect(() =>
        parseDeckStoreDump({
          ...dump,
          plan_receipts: [[entry[0], { ...entry[1], ...patch }]],
        }),
      ).toThrow();
    }
  });
});
