import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserDataStore } from "../storage/userData.js";
import type { Deck } from "../types/index.js";
import { buildPrintManifest, type PrintManifest } from "./manifest.js";
import {
  DEFAULT_PRINT_PRESET,
  PRINT_JOB_STATUSES,
  deckDrift,
  isOpenPrintJobStatus,
  type PrintJobRecord,
} from "./jobStore.js";

let root: string;
let stores: UserDataStore[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "print-jobs-"));
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

/** A saved deck with two copies of one card, one of another and one commander. */
function saveDeck(store: UserDataStore, principal: string): Deck {
  const created = store.deckStore.create({ name: "Proxies" }, principal);
  return store.deckStore.update(
    created.deck_id,
    (deck) => ({
      ...deck,
      commanders: ["cmdr"],
      cards: [
        { oracle_id: "alpha", qty: 2 },
        { oracle_id: "beta", qty: 1 },
      ],
    }),
    principal,
  );
}

function manifestOf(deck: Deck): PrintManifest {
  const result = buildPrintManifest(deck, () => null);
  if (result.kind !== "manifest") throw new Error("expected a manifest");
  return result.manifest;
}

function expectJob(job: PrintJobRecord | null): PrintJobRecord {
  if (!job) throw new Error("expected a job");
  return job;
}

describe("print job store", () => {
  it("creates a job pinned to the reviewed deck and reads it back after reopening", () => {
    const first = open();
    const deck = saveDeck(first, "alice");
    const manifest = manifestOf(deck);
    const { job, created } = first.print.create({ principal: "alice", manifest });
    expect(created).toBe(true);
    expect(job.status).toBe("prepared");
    expect(job.deck_id).toBe(deck.deck_id);
    expect(job.deck_version).toBe(deck.version);
    expect(job.data_snapshot).toBe(deck.data_snapshot);
    expect(job.manifest).toEqual(manifest);
    expect(job.job_dir).toBe(join(root, "print-jobs", job.job_id));
    expect(job.project_name).toBe(`mtg-edh-print-${job.job_id.slice(0, 8)}`);
    expect(job.settings).toEqual({
      stock: DEFAULT_PRINT_PRESET.stock,
      foil: DEFAULT_PRINT_PRESET.foil,
      card_back: null,
    });
    expect(Object.keys(job.images)).toEqual(manifest.cards.map((card) => String(card.slot)));
    first.close();
    const second = open();
    expect(second.print.get("alice", job.job_id)).toEqual(job);
    expect(second.print.list("alice").map((entry) => entry.job_id)).toEqual([job.job_id]);
  });

  it("reuses the open job for the same deck version and starts a new one once it is terminal", () => {
    const store = open();
    const deck = saveDeck(store, "alice");
    const manifest = manifestOf(deck);
    const original = store.print.create({ principal: "alice", manifest }).job;
    expect(
      store.print.update("alice", original.job_id, {
        settings: { foil: true },
      }),
    ).toMatchObject({ kind: "updated" });
    const retried = store.print.create({ principal: "alice", manifest });
    expect(retried.created).toBe(false);
    expect(retried.job.job_id).toBe(original.job_id);
    expect(retried.job.job_dir).toBe(original.job_dir);
    expect(retried.job.project_name).toBe(original.project_name);
    expect(retried.job.settings.foil).toBe(true);
    expect(store.print.findOpen("alice", deck.deck_id, deck.version)?.job_id).toBe(original.job_id);
    expect(store.print.transition("alice", original.job_id, "cancelled")).toMatchObject({
      kind: "updated",
      job: { status: "cancelled" },
    });
    const fresh = store.print.create({ principal: "alice", manifest });
    expect(fresh.created).toBe(true);
    expect(fresh.job.job_id).not.toBe(original.job_id);
    expect(store.print.list("alice").map((job) => job.job_id)).toEqual([
      fresh.job.job_id,
      original.job_id,
    ]);
  });

  it("hides jobs across principals", () => {
    const store = open();
    const deck = saveDeck(store, "alice");
    const job = store.print.create({ principal: "alice", manifest: manifestOf(deck) }).job;
    expect(store.print.get("bob", job.job_id)).toBeNull();
    expect(store.print.list("bob")).toEqual([]);
    expect(store.print.findOpen("bob", deck.deck_id, deck.version)).toBeNull();
    expect(store.print.update("bob", job.job_id, { settings: { foil: true } })).toEqual({
      kind: "not_found",
    });
    expect(store.print.transition("bob", job.job_id, "cancelled")).toEqual({ kind: "not_found" });
    expect(store.print.get("alice", job.job_id)).toEqual(job);
    // Another principal preparing the same deck id gets their own job.
    const other = store.print.create({ principal: "bob", manifest: manifestOf(deck) });
    expect(other.created).toBe(true);
    expect(other.job.job_id).not.toBe(job.job_id);
  });

  it("keeps a stored job unchanged when the deck moves on and reports the drift", () => {
    const store = open();
    const deck = saveDeck(store, "alice");
    const job = store.print.create({ principal: "alice", manifest: manifestOf(deck) }).job;
    expect(deckDrift(job, deck)).toEqual({
      pinned_version: deck.version,
      live_version: deck.version,
      state: "current",
    });
    const moved = store.deckStore.update(
      deck.deck_id,
      (d) => ({ ...d, cards: [{ oracle_id: "gamma", qty: 1 }] }),
      "alice",
    );
    const stored = expectJob(store.print.get("alice", job.job_id));
    expect(stored).toEqual(job);
    expect(stored.manifest.cards.map((card) => card.oracle_id)).toEqual([
      "cmdr",
      "alpha",
      "alpha",
      "beta",
    ]);
    expect(deckDrift(stored, moved)).toEqual({
      pinned_version: deck.version,
      live_version: moved.version,
      state: "moved_on",
    });
    expect(deckDrift(stored, null)).toEqual({
      pinned_version: deck.version,
      live_version: null,
      state: "deleted",
    });
    // A newer version prepares as its own job; the older one stays readable.
    const next = store.print.create({ principal: "alice", manifest: manifestOf(moved) });
    expect(next.created).toBe(true);
    expect(store.print.get("alice", job.job_id)).toEqual(job);
  });

  it("persists the print preset and applies it to the next prepare", () => {
    const first = open();
    const deck = saveDeck(first, "alice");
    expect(first.print.getPreset("alice")).toEqual(DEFAULT_PRINT_PRESET);
    const preset = first.print.setPreset("alice", {
      printings: { alpha: { kind: "printing", scryfall_id: "alpha-promo" } },
      card_back: { kind: "file", path: "/art/back.png" },
      stock: "(M31) Linen",
      foil: true,
    });
    expect(preset).toEqual({
      printings: { alpha: { kind: "printing", scryfall_id: "alpha-promo" } },
      card_back: { kind: "file", path: "/art/back.png" },
      stock: "(M31) Linen",
      foil: true,
    });
    first.close();
    const second = open();
    expect(second.print.getPreset("alice")).toEqual(preset);
    expect(second.print.getPreset("bob")).toEqual(DEFAULT_PRINT_PRESET);
    const job = second.print.create({ principal: "alice", manifest: manifestOf(deck) }).job;
    expect(job.settings).toEqual({
      stock: "(M31) Linen",
      foil: true,
      card_back: { kind: "file", path: "/art/back.png" },
    });
    const bySlot = (oracleId: string) =>
      job.manifest.cards.filter((card) => card.oracle_id === oracleId).map((card) => card.slot);
    for (const slot of bySlot("alpha"))
      expect(job.images[String(slot)]).toEqual({
        front: { kind: "printing", scryfall_id: "alpha-promo" },
        back: null,
      });
    for (const slot of [...bySlot("cmdr"), ...bySlot("beta")])
      expect(job.images[String(slot)]).toEqual({ front: null, back: null });
    // Explicit choices at prepare time win over the preset.
    second.print.transition("alice", job.job_id, "cancelled");
    const explicit = second.print.create({
      principal: "alice",
      manifest: manifestOf(deck),
      settings: { foil: false },
      images: { "1": { front: { kind: "file", path: "/art/cmdr.png" }, back: null } },
    }).job;
    expect(explicit.settings).toEqual({
      stock: "(M31) Linen",
      foil: false,
      card_back: { kind: "file", path: "/art/back.png" },
    });
    expect(explicit.images["1"]).toEqual({
      front: { kind: "file", path: "/art/cmdr.png" },
      back: null,
    });
    // Preset patches merge per key; null removes a preferred printing.
    const merged = second.print.setPreset("alice", {
      printings: { alpha: null, beta: { kind: "printing", scryfall_id: "beta-alt" } },
      foil: false,
    });
    expect(merged).toEqual({
      printings: { beta: { kind: "printing", scryfall_id: "beta-alt" } },
      card_back: { kind: "file", path: "/art/back.png" },
      stock: "(M31) Linen",
      foil: false,
    });
  });

  it("enforces the status machine and locks the reviewed contents while filling", () => {
    const store = open();
    const deck = saveDeck(store, "alice");
    const job = store.print.create({ principal: "alice", manifest: manifestOf(deck) }).job;
    const id = job.job_id;
    expect(PRINT_JOB_STATUSES.filter(isOpenPrintJobStatus)).toEqual([
      "prepared",
      "reviewed",
      "starting",
      "filling",
    ]);
    expect(store.print.transition("alice", id, "filling")).toEqual({
      kind: "invalid_transition",
      from: "prepared",
      to: "filling",
    });
    expect(store.print.transition("alice", id, "reviewed")).toMatchObject({
      kind: "updated",
      job: { status: "reviewed" },
    });
    // Changing artwork after review sends the job back for review.
    expect(
      store.print.update("alice", id, {
        images: { "2": { front: { kind: "printing", scryfall_id: "alpha-x" }, back: null } },
      }),
    ).toMatchObject({ kind: "updated", job: { status: "prepared" } });
    expect(expectJob(store.print.get("alice", id)).images["2"]).toEqual({
      front: { kind: "printing", scryfall_id: "alpha-x" },
      back: null,
    });
    expect(store.print.update("alice", id, { images: { "2": null } })).toMatchObject({
      kind: "updated",
      job: { images: { "2": { front: null, back: null } } },
    });
    expect(
      store.print.update("alice", id, { images: { "99": { front: null, back: null } } }),
    ).toEqual({ kind: "unknown_slot", slot: 99 });
    store.print.transition("alice", id, "reviewed");
    expect(store.print.transition("alice", id, "starting")).toMatchObject({ kind: "updated" });
    expect(
      store.print.transition("alice", id, "filling", {
        progress: { slots_filled: 0, slots_total: 4 },
      }),
    ).toMatchObject({ kind: "updated", job: { progress: { slots_filled: 0, slots_total: 4 } } });
    expect(store.print.update("alice", id, { settings: { foil: true } })).toEqual({
      kind: "locked",
      status: "filling",
    });
    expect(
      store.print.transition("alice", id, "failed", {
        failure: { step: "upload", message: "selector not found" },
      }),
    ).toMatchObject({ kind: "updated", job: { status: "failed" } });
    // A failed job is retried in place: same job, same project name.
    expect(store.print.transition("alice", id, "starting")).toMatchObject({
      kind: "updated",
      job: { status: "starting", failure: null, project_name: job.project_name },
    });
    store.print.transition("alice", id, "filling");
    expect(store.print.transition("alice", id, "filled")).toMatchObject({
      kind: "updated",
      job: { status: "filled" },
    });
    for (const status of PRINT_JOB_STATUSES) {
      expect(store.print.transition("alice", id, status)).toEqual({
        kind: "invalid_transition",
        from: "filled",
        to: status,
      });
    }
    expect(store.print.update("alice", id, { settings: { foil: true } })).toEqual({
      kind: "locked",
      status: "filled",
    });
    expect(store.print.findOpen("alice", deck.deck_id, deck.version)).toBeNull();
  });

  it("writes under the user-data transaction and backup discipline", () => {
    let fail = false;
    const store = open({
      beforeCommit: () => {
        if (fail) throw new Error("disk full");
      },
    });
    const deck = saveDeck(store, "alice");
    const manifest = manifestOf(deck);
    const before = readdirSync(join(root, "backups")).length;
    fail = true;
    expect(() => store.print.create({ principal: "alice", manifest })).toThrowError(
      expect.objectContaining({ code: "STORAGE_ERROR" }),
    );
    expect(store.print.list("alice")).toEqual([]);
    fail = false;
    const job = store.print.create({ principal: "alice", manifest }).job;
    expect(readdirSync(join(root, "backups")).length).toBeGreaterThan(before);
    expect(existsSync(job.job_dir)).toBe(false);
    // A deck write and a print write share one transaction and one backup.
    const count = readdirSync(join(root, "backups")).length;
    store.deckStore.transaction(() => {
      store.deckStore.setName(deck.deck_id, "Renamed", "alice");
      store.print.transition("alice", job.job_id, "reviewed");
    });
    expect(readdirSync(join(root, "backups")).length).toBe(count + 1);
    expect(store.print.get("alice", job.job_id)?.status).toBe("reviewed");
  });

  it("refuses a database holding a malformed job instead of guessing", () => {
    const store = open();
    const deck = saveDeck(store, "alice");
    const job = store.print.create({ principal: "alice", manifest: manifestOf(deck) }).job;
    store.close();
    const db = new Database(join(root, "user-data.sqlite"));
    db.prepare("UPDATE print_jobs SET payload = ? WHERE job_id = ?").run(
      JSON.stringify({ job_id: job.job_id }),
      job.job_id,
    );
    db.close();
    // Startup validation covers print rows exactly as it covers decks and collections.
    expect(() => open()).toThrowError(expect.objectContaining({ code: "STORAGE_ERROR" }));
  });
});
