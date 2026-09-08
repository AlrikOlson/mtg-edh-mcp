import { describe, expect, it } from "vitest";
import { DeckStore } from "./deckStore.js";
import { parseDeckStoreDump } from "./persistence.js";

describe("deck persistence validation", () => {
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
});
