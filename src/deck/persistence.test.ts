import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeckStore } from "./deckStore.js";
import { DeckPersister } from "./persistence.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deck-persist-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(): string {
  return join(dir, "decks.json");
}

describe("DeckStore dump/hydrate", () => {
  it("round-trips decks + snapshots across sessions", () => {
    const store = new DeckStore();
    const a = store.create({ name: "Alpha" });
    store.create({ name: "Bravo" }, "other-principal");
    store.update(a.deck_id, (d) => ({ ...d, name: "Alpha v2" }));
    const snap = store.snapshot(a.deck_id);

    const clone = new DeckStore();
    clone.hydrate(store.dump());
    expect(clone.get(a.deck_id)?.name).toBe("Alpha v2");
    expect(clone.get(a.deck_id)?.version).toBe(2);
    expect(clone.list("other-principal")).toHaveLength(1);
    expect(clone.list()).toHaveLength(1); // principal isolation preserved
    expect(clone.getSnapshot(a.deck_id, snap.snapshot_id)?.version).toBe(2);
  });
});

describe("DeckPersister", () => {
  it("writes through on create/update/delete/snapshot and reloads at attach", () => {
    const store = new DeckStore();
    const persister = new DeckPersister(file());
    persister.attach(store);

    const deck = store.create({ name: "Karumonix Toxic" });
    store.snapshot(deck.deck_id);
    const doomed = store.create({ name: "Doomed" });
    store.delete(doomed.deck_id);
    persister.close(); // deterministic flush (the timer is debounced)

    // A fresh store + persister on the same file sees exactly the survivors.
    const reborn = new DeckStore();
    new DeckPersister(file()).attach(reborn);
    expect(reborn.get(deck.deck_id)?.name).toBe("Karumonix Toxic");
    expect(reborn.get(doomed.deck_id)).toBeUndefined();
    expect(reborn.listSnapshots(deck.deck_id)).toHaveLength(1);
  });

  it("quarantines a corrupt file instead of blocking boot", () => {
    writeFileSync(file(), "{ not json !!!");
    const store = new DeckStore();
    new DeckPersister(file()).attach(store);
    expect(store.list()).toHaveLength(0);
    expect(existsSync(`${file()}.corrupt`)).toBe(true);
  });

  it("writes atomically (no .tmp left behind) and produces parseable JSON", () => {
    const store = new DeckStore();
    const persister = new DeckPersister(file());
    persister.attach(store);
    store.create({ name: "Atomic" });
    persister.close();
    expect(existsSync(`${file()}.tmp`)).toBe(false);
    const parsed = JSON.parse(readFileSync(file(), "utf8")) as { decks: unknown[] };
    expect(parsed.decks).toHaveLength(1);
  });
});
