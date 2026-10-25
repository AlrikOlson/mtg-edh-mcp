import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserDataStore } from "../storage/userData.js";
import type { Deck } from "../types/index.js";
import {
  card,
  face,
  fakeScryfall,
  gameplay,
  lookupOf,
  printing,
  solidPng,
  type FetchCall,
} from "./catalogFixtures.test-support.js";
import { fakeFillerWorkerSource, type FakeFillerMode } from "./fakeFillerWorker.test-support.js";
import { PrintFillerService } from "./filler.js";
import { PRINT_CARDS_XML_FILENAME, PRINT_PROJECT_FILENAME } from "./projectFile.js";
import {
  PRINT_REVIEW_FILENAME,
  PrintOrderService,
  PrintReviewSchema,
  type PrintContext,
  type PrintStatusResult,
  type StartPrintResult,
} from "./service.js";

const COMMANDER = card({
  oracle_id: "cmd",
  name: "Commander",
  printings: [
    printing("cmd-old", "cmd", "1", "2019-01-01"),
    printing("cmd-new", "zzz", "7", "2023-06-01"),
  ],
});
const SOL_RING = card({
  oracle_id: "sol",
  name: "Sol Ring",
  printings: [printing("sol-a", "c21", "263", "2021-04-23"), printing("sol-b", "lea", "270")],
});
const DELVER = card({
  oracle_id: "delver",
  name: "Delver of Secrets",
  gameplay: gameplay("transform", [face(0, "Delver of Secrets"), face(1, "Insectile Aberration")]),
  printings: [printing("delver-isd", "isd", "51", "2011-09-30")],
});
const UNPRINTED = card({ oracle_id: "nop", name: "Unprinted Card", printings: [] });
const LOOKUP = lookupOf(COMMANDER, SOL_RING, DELVER, UNPRINTED);

let scryfallPng: Buffer;
let userPng: Buffer;
let root: string;
let store: UserDataStore;
let calls: FetchCall[];
let services: PrintOrderService[];

beforeEach(async () => {
  scryfallPng ??= await solidPng(745, 1040);
  userPng ??= await solidPng(822, 1122, [20, 20, 20]);
  root = mkdtempSync(join(tmpdir(), "print-service-"));
  store = new UserDataStore(root);
  calls = [];
  services = [];
});
afterEach(async () => {
  for (const service of services) await service.shutdown();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function workerFor(mode: FakeFillerMode): string {
  const path = join(root, `fake-filler-${mode}.cjs`);
  writeFileSync(path, fakeFillerWorkerSource(mode));
  return path;
}

function service(mode: FakeFillerMode | "missing" = "complete"): PrintOrderService {
  const filler = new PrintFillerService({
    jobs: store.print,
    dataRoot: root,
    workerEntry: mode === "missing" ? join(root, "absent", "print-filler.js") : workerFor(mode),
    killGraceMs: 300,
  });
  const instance = new PrintOrderService({
    jobs: store.print,
    filler,
    images: { scryfall: fakeScryfall(scryfallPng, calls) },
  });
  services.push(instance);
  return instance;
}

function saveDeck(principal: string, cards: Array<{ oracle_id: string; qty: number }>): Deck {
  const created = store.deckStore.create({ name: "Proxies" }, principal);
  return store.deckStore.update(
    created.deck_id,
    (deck) => ({ ...deck, commanders: ["cmd"], cards, data_snapshot: "snap-1" }),
    principal,
  );
}

function contextFor(principal: string): PrintContext {
  return {
    deck: (deckId) => store.deckStore.get(deckId, principal) ?? null,
    lookup: LOOKUP,
  };
}

const PRINTABLE = [
  { oracle_id: "sol", qty: 2 },
  { oracle_id: "delver", qty: 1 },
];

function expectKind<T extends { kind: string }, K extends T["kind"]>(
  result: T,
  kind: K,
): Extract<T, { kind: K }> {
  if (result.kind !== kind) throw new Error(`expected ${kind}, got ${JSON.stringify(result)}`);
  return result as Extract<T, { kind: K }>;
}

async function statusOf(
  instance: PrintOrderService,
  principal: string,
  jobId: string,
): Promise<Extract<PrintStatusResult, { kind: "status" }>> {
  return expectKind(await instance.status(principal, contextFor(principal), jobId), "status");
}

async function waitForStatus(
  instance: PrintOrderService,
  jobId: string,
  wanted: string,
): Promise<Extract<PrintStatusResult, { kind: "status" }>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const current = await statusOf(instance, "alice", jobId);
    if (current.job.status === wanted) return current;
    if (Date.now() > deadline)
      throw new Error(`job never reached ${wanted}: ${current.job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("PrintOrderService", () => {
  it("prepares a job with a reviewable preview and names the card that has no image", async () => {
    const instance = service();
    const deck = saveDeck("alice", [...PRINTABLE, { oracle_id: "nop", qty: 1 }]);
    const prepared = expectKind(
      await instance.prepare("alice", contextFor("alice"), { deck_id: deck.deck_id }),
      "prepared",
    );
    expect(prepared.created).toBe(true);
    expect(prepared.job.status).toBe("prepared");
    expect(prepared.job.deck_version).toBe(deck.version);
    expect(prepared.job.manifest.total).toBe(5);
    expect(prepared.review.complete).toBe(false);
    // The default printing is chosen, fetched once per face and persisted on the job.
    expect(prepared.review.slots.map((slot) => [slot.slot, slot.name, slot.front?.kind])).toEqual([
      [1, "Commander", "printing"],
      [2, "Sol Ring", "printing"],
      [3, "Sol Ring", "printing"],
      [4, "Delver of Secrets", "printing"],
      [5, "Unprinted Card", undefined],
    ]);
    expect(prepared.review.slots[3]).toMatchObject({
      back: { kind: "printing", scryfall_id: "delver-isd" },
      front_ready: true,
      back_ready: true,
    });
    expect(prepared.job.images["2"]).toEqual({
      front: { kind: "printing", scryfall_id: "sol-a" },
      back: null,
    });
    expect(calls.map((c) => `${c.scryfall_id}:${c.face}`).sort()).toEqual([
      "cmd-new:front",
      "delver-isd:back",
      "delver-isd:front",
      "sol-a:front",
    ]);
    expect(prepared.review.attention).toEqual([
      expect.objectContaining({
        kind: "no_printing",
        slots: [5],
        face: "front",
        ref: "nop",
        name: "Unprinted Card",
        message: expect.stringContaining("Unprinted Card"),
      }),
    ]);
    const onDisk = PrintReviewSchema.parse(
      JSON.parse(readFileSync(join(prepared.job.job_dir, PRINT_REVIEW_FILENAME), "utf8")),
    );
    expect(onDisk.attention).toEqual(prepared.review.attention);

    // Preparing the same deck version again returns the open job, not a duplicate.
    const again = expectKind(
      await instance.prepare("alice", contextFor("alice"), { deck_id: deck.deck_id }),
      "prepared",
    );
    expect(again.created).toBe(false);
    expect(again.job.job_id).toBe(prepared.job.job_id);
    expect(store.print.list("alice")).toHaveLength(1);
  });

  it("refuses to start while attention items remain, with the same reason, and writes no project", async () => {
    const instance = service();
    const deck = saveDeck("alice", [...PRINTABLE, { oracle_id: "nop", qty: 1 }]);
    const prepared = expectKind(
      await instance.prepare("alice", contextFor("alice"), { deck_id: deck.deck_id }),
      "prepared",
    );
    const refused = expectKind(
      await instance.start("alice", contextFor("alice"), prepared.job.job_id),
      "attention",
    );
    expect(refused.review.attention).toEqual(prepared.review.attention);
    expect(refused.job.status).toBe("prepared");
    expect(existsSync(join(prepared.job.job_dir, PRINT_PROJECT_FILENAME))).toBe(false);
    const status = await statusOf(instance, "alice", prepared.job.job_id);
    expect(status.attention).toEqual(expect.arrayContaining(prepared.review.attention));
  });

  it("updates one card's printing and the card back, and status reflects it with the deck version still pinned", async () => {
    const instance = service();
    const deck = saveDeck("alice", PRINTABLE);
    const prepared = expectKind(
      await instance.prepare("alice", contextFor("alice"), { deck_id: deck.deck_id }),
      "prepared",
    );
    expect(prepared.review.complete).toBe(true);
    const cardBack = join(root, "back.png");
    writeFileSync(cardBack, userPng);
    const updated = expectKind(
      await instance.update("alice", contextFor("alice"), prepared.job.job_id, {
        images: { "2": { front: { kind: "printing", scryfall_id: "sol-b" } } },
        settings: { card_back: { kind: "file", path: cardBack }, foil: true },
      }),
      "updated",
    );
    expect(updated.job.images["2"]).toEqual({
      front: { kind: "printing", scryfall_id: "sol-b" },
      back: null,
    });
    expect(updated.job.images["3"]).toEqual({
      front: { kind: "printing", scryfall_id: "sol-a" },
      back: null,
    });
    expect(updated.job.settings).toMatchObject({ foil: true, card_back: { kind: "file" } });
    expect(updated.review.card_back).toMatchObject({ ref: { kind: "file" }, ready: true });
    expect(updated.review.complete).toBe(true);
    expect(calls.filter((c) => c.scryfall_id === "sol-b")).toHaveLength(1);

    const status = await statusOf(instance, "alice", prepared.job.job_id);
    expect(status.job.deck_version).toBe(deck.version);
    expect(status.deck).toEqual({
      pinned_version: deck.version,
      live_version: deck.version,
      state: "current",
    });
    expect(status.notices).toEqual([]);
    expect(status.review?.slots[1]).toMatchObject({
      front: { kind: "printing", scryfall_id: "sol-b" },
      front_ready: true,
    });
    expect(status.review?.card_back.ready).toBe(true);

    // The preset remembers explicit choices only when asked.
    expect(store.print.getPreset("alice").printings).toEqual({});
    await instance.update("alice", contextFor("alice"), prepared.job.job_id, {
      images: { "2": { front: { kind: "printing", scryfall_id: "sol-b" } } },
      settings: { stock: "(M31) Linen" },
      remember: true,
    });
    expect(store.print.getPreset("alice")).toMatchObject({
      printings: { sol: { kind: "printing", scryfall_id: "sol-b" } },
      stock: "(M31) Linen",
      foil: true,
    });
  });

  it("reports a deck that moved on after prepare as a drift notice while the job keeps the reviewed contents", async () => {
    const instance = service();
    const deck = saveDeck("alice", PRINTABLE);
    const prepared = expectKind(
      await instance.prepare("alice", contextFor("alice"), { deck_id: deck.deck_id }),
      "prepared",
    );
    store.deckStore.update(
      deck.deck_id,
      (live) => ({ ...live, cards: [{ oracle_id: "sol", qty: 1 }] }),
      "alice",
    );
    const status = await statusOf(instance, "alice", prepared.job.job_id);
    expect(status.deck).toEqual({
      pinned_version: deck.version,
      live_version: deck.version + 1,
      state: "moved_on",
    });
    expect(status.notices[0]).toMatch(/moved on/);
    expect(status.job.manifest.cards).toHaveLength(4);
    expect(status.job.manifest.total).toBe(4);

    // An explicit version pin that no longer matches is a conflict, not a job.
    const conflict = await instance.prepare("alice", contextFor("alice"), {
      deck_id: deck.deck_id,
      expected_version: deck.version,
    });
    expect(conflict).toEqual({
      kind: "conflict",
      deck_id: deck.deck_id,
      expected_version: deck.version,
      current_version: deck.version + 1,
    });
  });

  it("keeps jobs invisible to another principal", async () => {
    const instance = service();
    const deck = saveDeck("alice", PRINTABLE);
    const prepared = expectKind(
      await instance.prepare("alice", contextFor("alice"), { deck_id: deck.deck_id }),
      "prepared",
    );
    expect(await instance.prepare("bob", contextFor("bob"), { deck_id: deck.deck_id })).toEqual({
      kind: "deck_not_found",
      deck_id: deck.deck_id,
    });
    expect(await instance.status("bob", contextFor("bob"), prepared.job.job_id)).toEqual({
      kind: "not_found",
    });
    expect(await instance.update("bob", contextFor("bob"), prepared.job.job_id, {})).toEqual({
      kind: "not_found",
    });
    expect(await instance.start("bob", contextFor("bob"), prepared.job.job_id)).toEqual({
      kind: "not_found",
    });
    expect(instance.list("bob")).toEqual([]);
    expect(instance.list("alice").map((job) => job.job_id)).toEqual([prepared.job.job_id]);
    expect(store.print.get("alice", prepared.job.job_id)?.status).toBe("prepared");
  });

  it("starts a reviewed job in the background and reports progress, completion and the retained files", async () => {
    const instance = service("complete");
    const deck = saveDeck("alice", PRINTABLE);
    const prepared = expectKind(
      await instance.prepare("alice", contextFor("alice"), { deck_id: deck.deck_id }),
      "prepared",
    );
    const started = expectKind(
      await instance.start("alice", contextFor("alice"), prepared.job.job_id),
      "started",
    );
    expect(started.job.status).toBe("starting");
    expect(existsSync(join(prepared.job.job_dir, PRINT_PROJECT_FILENAME))).toBe(true);
    expect(existsSync(join(prepared.job.job_dir, PRINT_CARDS_XML_FILENAME))).toBe(true);

    const filled = await waitForStatus(instance, prepared.job.job_id, "filled");
    expect(filled.job.progress).toEqual({ slots_filled: 6, slots_total: 6 });
    expect(filled.fill).toMatchObject({ ssid: "FAKESSID", review_url: null });
    expect(filled.evidence).toMatchObject({
      job_dir: prepared.job.job_dir,
      project: join(prepared.job.job_dir, PRINT_PROJECT_FILENAME),
      cards_xml: join(prepared.job.job_dir, PRINT_CARDS_XML_FILENAME),
    });
    expect(filled.attention).toEqual([]);
    // A second start while the browser is held is busy, and a filled job cannot restart.
    const second = saveDeck("alice", [{ oracle_id: "sol", qty: 1 }]);
    const other = expectKind(
      await instance.prepare("alice", contextFor("alice"), { deck_id: second.deck_id }),
      "prepared",
    );
    expect(await instance.start("alice", contextFor("alice"), other.job.job_id)).toEqual({
      kind: "busy",
    });
    await instance.shutdown();
    expect(await instance.start("alice", contextFor("alice"), prepared.job.job_id)).toEqual({
      kind: "invalid_status",
      status: "filled",
    });
  });

  it("reports a failed fill with its step, evidence paths and instructions, and retries it in place", async () => {
    const instance = service("fail");
    const deck = saveDeck("alice", PRINTABLE);
    const prepared = expectKind(
      await instance.prepare("alice", contextFor("alice"), { deck_id: deck.deck_id }),
      "prepared",
    );
    expectKind(await instance.start("alice", contextFor("alice"), prepared.job.job_id), "started");
    const failed = await waitForStatus(instance, prepared.job.job_id, "failed");
    expect(failed.job.failure).toEqual({
      step: "place_front",
      message: "dnImg3_0_0 is not a slot any more",
    });
    expect(failed.fill?.instructions).toContain("continue by hand");
    // Evidence the worker wrote is reported only when it exists.
    expect(failed.evidence.screenshot).toBeUndefined();
    writeFileSync(join(prepared.job.job_dir, "failure-place_front.png"), userPng);
    writeFileSync(join(prepared.job.job_dir, "fill-state.json"), "{}");
    const evidenced = await statusOf(instance, "alice", prepared.job.job_id);
    expect(evidenced.evidence.screenshot).toBe(
      join(prepared.job.job_dir, "failure-place_front.png"),
    );
    expect(evidenced.evidence.fill_state).toBe(join(prepared.job.job_dir, "fill-state.json"));

    await instance.shutdown();
    const retried = expectKind(
      await instance.start("alice", contextFor("alice"), prepared.job.job_id),
      "started",
    );
    expect(retried.job.status).toBe("starting");
    expect(store.print.list("alice")).toHaveLength(1);
  });

  it("surfaces a missing filler as attention on status and refuses to start with it", async () => {
    const instance = service("missing");
    const deck = saveDeck("alice", PRINTABLE);
    const prepared = expectKind(
      await instance.prepare("alice", contextFor("alice"), { deck_id: deck.deck_id }),
      "prepared",
    );
    const status = await statusOf(instance, "alice", prepared.job.job_id);
    expect(status.attention).toEqual([
      expect.objectContaining({
        kind: "worker_missing",
        message: expect.stringContaining("print-filler.js"),
      }),
    ]);
    const result: StartPrintResult = await instance.start(
      "alice",
      contextFor("alice"),
      prepared.job.job_id,
    );
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(expectKind(result, "unavailable").attention[0]).toMatchObject({
      kind: "worker_missing",
    });
    // The project was written and the job is reviewed, ready for a later start.
    expect(existsSync(join(prepared.job.job_dir, PRINT_PROJECT_FILENAME))).toBe(true);
    expect(store.print.get("alice", prepared.job.job_id)?.status).toBe("reviewed");
  });
});
