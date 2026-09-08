import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeckStore } from "../deck/deckStore.js";
import { UserDataStore } from "./userData.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), renameSync: vi.fn(actual.renameSync) };
});

let root: string;
let stores: UserDataStore[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "user-data-"));
  stores = [];
});
afterEach(() => {
  for (const store of stores) store.close();
  rmSync(root, { recursive: true, force: true });
});
function open(options: ConstructorParameters<typeof UserDataStore>[1] = {}): UserDataStore {
  const store = new UserDataStore(root, options);
  stores.push(store);
  return store;
}

describe("durable user data", () => {
  it("round-trips all deck fields, snapshots, collections, and sessions immediately", () => {
    const first = open();
    const deck = first.deckStore.create({ name: "Durable" }, "alice");
    const updated = first.deckStore.update(
      deck.deck_id,
      (d) => ({
        ...d,
        companion: "companion",
        role_overrides: { card: ["ramp", "payoff"] },
        cards: [{ oracle_id: "card", qty: 2, illegal: true }],
      }),
      "alice",
    );
    const snap = first.deckStore.snapshot(deck.deck_id, "alice");
    first.collection.set(["card"], "alice");
    first.collection.set(["other"], "bob");
    const second = open();
    expect(second.deckStore.get(deck.deck_id, "alice")).toEqual(updated);
    expect(second.deckStore.getSnapshot(deck.deck_id, snap.snapshot_id, "alice")).toEqual(snap);
    expect(second.deckStore.list("bob")).toEqual([]);
    expect(second.collection.get("alice")).toEqual(new Set(["card"]));
    expect(second.collection.get("bob")).toEqual(new Set(["other"]));
  });

  it("reads fresh state and preserves unrelated concurrent connection writes", () => {
    const a = open();
    const b = open();
    const one = a.deckStore.create({ name: "One" });
    const two = b.deckStore.create({ name: "Two" });
    a.deckStore.setName(one.deck_id, "One new");
    b.deckStore.setName(two.deck_id, "Two new");
    expect(a.deckStore.list().map((d) => d.name)).toEqual(["One new", "Two new"]);
    expect(b.deckStore.get(one.deck_id)?.version).toBe(2);
    a.collection.add(["a"]);
    b.collection.add(["b"]);
    expect(a.collection.get()).toEqual(new Set(["a", "b"]));
  });

  it("rolls back complete mutations and emits nothing on injected commit failure", () => {
    let fail = false;
    const first = open({
      beforeCommit: () => {
        if (fail) throw new Error("disk full");
      },
    });
    const deck = first.deckStore.create({ name: "Before" });
    const listener = vi.fn();
    first.deckStore.onChange(listener);
    fail = true;
    expect(() =>
      first.deckStore.transaction(() => {
        first.deckStore.setName(deck.deck_id, "After");
        first.deckStore.snapshot(deck.deck_id);
        first.deckStore.create({ name: "Partial import" });
        first.collection.add(["undurable"]);
      }),
    ).toThrowError(expect.objectContaining({ code: "STORAGE_ERROR" }));
    expect(listener).not.toHaveBeenCalled();
    expect(first.deckStore.get(deck.deck_id)).toEqual(deck);
    expect(first.deckStore.list()).toHaveLength(1);
    expect(first.deckStore.listSnapshots(deck.deck_id)).toEqual([]);
    expect(first.collection.size()).toBe(0);
    expect(open().deckStore.get(deck.deck_id)).toEqual(deck);
  });

  it("only notifies committed state, and notification failure cannot undo success", () => {
    const first = open();
    const observer = open();
    const deck = first.deckStore.create({ name: "Before" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let observedName: string | undefined;
    first.deckStore.onChange(() => {
      observedName = observer.deckStore.get(deck.deck_id)?.name;
      throw new Error("subscriber gone");
    });
    expect(first.deckStore.setName(deck.deck_id, "After").name).toBe("After");
    expect(observer.deckStore.get(deck.deck_id)?.name).toBe("After");
    expect(observedName).toBe("After");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("makes returned decks and snapshots safe to mutate outside transactions", () => {
    const store = open();
    const deck = store.deckStore.create({ name: "Before" });
    deck.name = "Outside";
    const snapshot = store.deckStore.snapshot(deck.deck_id);
    snapshot.deck.name = "Outside too";
    expect(store.deckStore.get(deck.deck_id)?.name).toBe("Before");
    expect(store.deckStore.getSnapshot(deck.deck_id, snapshot.snapshot_id)?.deck.name).toBe(
      "Before",
    );
  });

  it("rolls in-memory compound mutations back without leaking notification", () => {
    const store = new DeckStore();
    const deck = store.create({ name: "Before" });
    const listener = vi.fn();
    store.onChange(listener);
    expect(() =>
      store.transaction(() => {
        store.setName(deck.deck_id, "After");
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(store.get(deck.deck_id)).toEqual(deck);
    expect(listener).not.toHaveBeenCalled();
  });

  it("defers nested deck notifications until the enclosing collection transaction commits", () => {
    const store = open();
    const deck = store.deckStore.create({ name: "Before" });
    const listener = vi.fn();
    store.deckStore.onChange(listener);
    expect(() =>
      store.collection.transaction(() => {
        store.deckStore.setName(deck.deck_id, "After");
        expect(listener).not.toHaveBeenCalled();
        throw new Error("abort outer transaction");
      }),
    ).toThrow("abort outer transaction");
    expect(listener).not.toHaveBeenCalled();
    expect(store.deckStore.get(deck.deck_id)).toEqual(deck);
    store.collection.transaction(() => {
      store.deckStore.setName(deck.deck_id, "Committed");
      expect(listener).not.toHaveBeenCalled();
    });
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("legacy migration", () => {
  it("validates and migrates exactly once, preserving original bytes and orphan snapshots", () => {
    const old = new DeckStore();
    const deck = old.create({ name: "Legacy" });
    const snapshot = old.snapshot(deck.deck_id);
    old.delete(deck.deck_id);
    old.create({ name: "Survivor" }, "alice");
    const source = JSON.stringify(old.dump(), null, 2);
    writeFileSync(join(root, "decks.json"), source);
    const first = open();
    expect(first.deckStore.getSnapshot(deck.deck_id, snapshot.snapshot_id)).toEqual(snapshot);
    expect(first.deckStore.list("alice")).toHaveLength(1);
    expect(readFileSync(join(root, "decks.json"), "utf8")).toBe(source);
    expect(readFileSync(join(root, "decks.json.migrated"), "utf8")).toBe(source);
    first.deckStore.hydrate({ decks: [], snapshots: [] });
    first.close();
    expect(open().deckStore.list("alice")).toEqual([]);
  });

  it.each([
    "not json",
    JSON.stringify({ decks: [["local\u0000bad", { deck_id: "bad", version: 1 }]], snapshots: [] }),
  ])("refuses malformed migration input without quarantining or starting empty", (input) => {
    writeFileSync(join(root, "decks.json"), input);
    expect(() => open()).toThrowError(expect.objectContaining({ code: "STORAGE_ERROR" }));
    expect(readFileSync(join(root, "decks.json"), "utf8")).toBe(input);
    expect(existsSync(join(root, "user-data.sqlite"))).toBe(false);
  });

  it("rejects duplicate or mismatched keys without dropping legacy records", () => {
    const old = new DeckStore();
    old.create({ name: "Legacy" });
    const dump = old.dump();
    dump.decks.push(...dump.decks);
    writeFileSync(join(root, "decks.json"), JSON.stringify(dump));
    expect(() => open()).toThrow(/duplicate/i);
  });
});

describe("backup and explicit recovery", () => {
  it.each(["missing", "empty", "schema"])(
    "refuses a %s initialized database without silently creating new data",
    (damage) => {
      const store = open();
      store.deckStore.create({ name: "Saved" });
      store.close();
      if (damage === "missing") {
        rmSync(join(root, "user-data.sqlite"));
        rmSync(join(root, "backups"), { recursive: true });
      } else if (damage === "empty") writeFileSync(join(root, "user-data.sqlite"), "");
      else {
        const db = new Database(join(root, "user-data.sqlite"));
        db.exec("DROP TABLE deck_state");
        db.close();
      }
      expect(() => open()).toThrowError(expect.objectContaining({ code: "STORAGE_ERROR" }));
      if (damage === "missing") expect(existsSync(join(root, "user-data.sqlite"))).toBe(false);
    },
  );

  it("bounds automatic pre-write backups and restores with the replaced file retained", () => {
    const first = open({ backupRetention: 3 });
    const deck = first.deckStore.create({ name: "Original" });
    for (let i = 1; i <= 5; i++) first.deckStore.setName(deck.deck_id, `Version ${i}`);
    const backups = readdirSync(join(root, "backups"))
      .filter((name) => name.endsWith(".sqlite"))
      .sort();
    expect(backups).toHaveLength(3);
    const latest = backups.at(-1);
    if (!latest) throw new Error("missing backup");
    const backupPath = join(root, "backups", latest);
    expect(() => UserDataStore.restore(root, backupPath)).toThrow(/stop|active|busy|locked/i);
    first.close();
    const restored = UserDataStore.restore(root, backupPath);
    expect(restored.preservedPath && existsSync(restored.preservedPath)).toBe(true);
    expect(open().deckStore.get(deck.deck_id)?.name).toBe("Version 4");
  });

  it("backup failure prevents write and success notifications", () => {
    const first = open();
    const deck = first.deckStore.create({ name: "Before" });
    rmSync(join(root, "backups"), { recursive: true });
    writeFileSync(join(root, "backups"), "blocked");
    const listener = vi.fn();
    first.deckStore.onChange(listener);
    expect(() => first.deckStore.setName(deck.deck_id, "After")).toThrowError(
      expect.objectContaining({ code: "STORAGE_ERROR" }),
    );
    expect(first.deckStore.get(deck.deck_id)?.name).toBe("Before");
    expect(listener).not.toHaveBeenCalled();
  });

  it("preserves a corrupt database and requires an explicitly selected valid backup", () => {
    const first = open();
    const deck = first.deckStore.create({ name: "Saved" });
    first.deckStore.setName(deck.deck_id, "Later");
    first.close();
    const backup = readdirSync(join(root, "backups"))
      .filter((name) => name.endsWith(".sqlite"))
      .sort()
      .at(-1);
    if (!backup) throw new Error("missing backup");
    writeFileSync(join(root, "user-data.sqlite"), "corrupt original");
    expect(() => open()).toThrowError(expect.objectContaining({ code: "STORAGE_ERROR" }));
    expect(readFileSync(join(root, "user-data.sqlite"), "utf8")).toBe("corrupt original");
    expect(() => UserDataStore.restore(root, join(root, "user-data.sqlite"))).toThrow();
    const report = UserDataStore.restore(root, join(root, "backups", backup));
    expect(report.preservedPath && readFileSync(report.preservedPath, "utf8")).toBe(
      "corrupt original",
    );
    expect(open().deckStore.get(deck.deck_id)?.name).toBe("Saved");
  });

  it("keeps backup history when staging a new snapshot fails", () => {
    const store = open({ backupRetention: 2 });
    const deck = store.deckStore.create({ name: "Saved" });
    store.deckStore.setName(deck.deck_id, "Saved again");
    const before = readdirSync(join(root, "backups")).sort();
    const failure = vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw new Error("injected filesystem I/O failure");
    });
    try {
      expect(() => store.deckStore.setName(deck.deck_id, "Unsaved")).toThrow(/backup failed/);
    } finally {
      failure.mockRestore();
    }
    expect(readdirSync(join(root, "backups")).sort()).toEqual(before);
    expect(store.deckStore.get(deck.deck_id)?.name).toBe("Saved again");
  });

  it("keeps interrupted restore detectable and retryable even without local backups", async () => {
    const store = open();
    const deck = store.deckStore.create({ name: "Saved" });
    store.deckStore.setName(deck.deck_id, "Later");
    store.close();
    const latest = readdirSync(join(root, "backups")).sort().at(-1);
    if (!latest) throw new Error("missing backup");
    const external = join(root, "selected.sqlite");
    writeFileSync(external, readFileSync(join(root, "backups", latest)));
    rmSync(join(root, "backups"), { recursive: true });
    const rename = (await vi.importActual<typeof import("node:fs")>("node:fs")).renameSync;
    const failure = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (
        String(from).includes("user-data-restore-") &&
        !String(from).includes(".tmp-") &&
        String(to).endsWith("user-data.sqlite")
      )
        throw new Error("injected install failure");
      rename(from, to);
    });
    try {
      expect(() => UserDataStore.restore(root, external)).toThrow(/install failure/);
    } finally {
      failure.mockRestore();
    }
    expect(existsSync(join(root, "user-data.sqlite"))).toBe(false);
    expect(readdirSync(root).some((name) => name.includes(".corrupt-"))).toBe(true);
    expect(() => open()).toThrow(/missing/);
    UserDataStore.restore(root, external);
    expect(open().deckStore.get(deck.deck_id)?.name).toBe("Saved");
  });
});
