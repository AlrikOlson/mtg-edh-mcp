import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StructuredError } from "../types/errors.js";
import type { Card, CardFace, CardGameplay, Deck, Printing } from "../types/index.js";
import type { CardLookup } from "../validate/index.js";
import type { CommunityCandidate, CommunityImageSource } from "./community.js";
import { readImageDimensions } from "./imagePrep.js";
import {
  defaultPrinting,
  resolvePrintImages,
  type FaceImageFetcher,
  type PrintImageResolution,
  type ResolvePrintImagesInput,
} from "./imageSelector.js";
import type { PrintImageRef, PrintSlotImages } from "./jobStore.js";
import { buildPrintManifest, type PrintManifest } from "./manifest.js";

// ---- catalog fixtures (same shape as manifest.test.ts) ----

function face(index: number, name: string): CardFace {
  return {
    face_index: index,
    source_path: index === 0 && name === "" ? "" : `/card_faces/${index}`,
    oracle_id: null,
    characteristics: {
      name,
      mana_cost: null,
      cmc: null,
      type_line: null,
      oracle_text: null,
      colors: null,
      color_indicator: null,
      power: null,
      toughness: null,
      loyalty: null,
      defense: null,
      keywords: null,
      produced_mana: null,
      printed_name: null,
      printed_text: null,
      printed_type_line: null,
    },
  };
}

function gameplay(
  relationship: CardGameplay["face_relationship"],
  faces: readonly CardFace[] | null,
): CardGameplay {
  return {
    version: 1,
    source: { scryfall_id: null, oracle_id: null },
    layout: relationship,
    color_identity: null,
    face_relationship: relationship,
    playability: "not_evaluated",
    characteristics: face(0, "").characteristics,
    faces,
    related_cards: null,
  };
}

function printing(
  scryfall_id: string,
  set: string,
  collector_number: string,
  released_at?: string,
): Printing {
  return {
    scryfall_id,
    set,
    set_name: set.toUpperCase(),
    collector_number,
    rarity: "rare",
    prices: {},
    ...(released_at === undefined ? {} : { released_at }),
  };
}

function card(partial: Partial<Card> & { oracle_id: string; name: string }): Card {
  return {
    mana_cost: "",
    mv: 0,
    colors: [],
    color_identity: [],
    type_line: "Creature — Human",
    oracle_text: "",
    keywords: [],
    legalities: { commander: "legal" },
    prices: {},
    is_commander_eligible: false,
    roles: [],
    printings: [],
    gameplay: gameplay("single", [face(0, partial.name)]),
    ...partial,
  };
}

function lookupOf(...cards: Card[]): CardLookup {
  const byId = new Map(cards.map((c) => [c.oracle_id, c]));
  return (id) => byId.get(id) ?? null;
}

function deck(partial: Partial<Deck>): Deck {
  return {
    deck_id: "deck-1",
    name: "Print me",
    format: "commander",
    commanders: ["cmd"],
    command_zone_kind: "single",
    cards: [],
    computed_color_identity: [],
    version: 3,
    data_snapshot: "snap-1",
    ...partial,
  };
}

function manifestOf(d: Deck, lookup: CardLookup): PrintManifest {
  const result = buildPrintManifest(d, lookup);
  if (result.kind !== "manifest") throw new Error("expected a manifest");
  return result.manifest;
}

const COMMANDER = card({
  oracle_id: "cmd",
  name: "Commander",
  printings: [
    printing("cmd-old", "cmd", "1", "2019-01-01"),
    printing("cmd-new", "zzz", "7", "2023-06-01"),
    printing("cmd-new-earlier-set", "aaa", "2", "2023-06-01"),
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
const NO_PRINTINGS = card({ oracle_id: "nop", name: "Unprinted Card", printings: [] });

// ---- image fixtures ----

async function solidPng(
  width: number,
  height: number,
  rgb: [number, number, number],
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

let scryfallPng: Buffer;
let root: string;
let jobDir: string;

beforeEach(async () => {
  scryfallPng ??= await solidPng(745, 1040, [0, 0, 0]);
  root = mkdtempSync(join(tmpdir(), "print-images-"));
  jobDir = join(root, "job");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface FetchCall {
  scryfall_id: string;
  face: "front" | "back";
}

/** A fake of LiveScryfallClient.getCardImage recording every call. */
function fakeScryfall(
  calls: FetchCall[],
  behaviour: (call: FetchCall) => Promise<Uint8Array> = () => Promise.resolve(scryfallPng),
): FaceImageFetcher {
  return {
    getCardImage: (scryfall_id, options) => {
      const call: FetchCall = { scryfall_id, face: options?.face ?? "front" };
      calls.push(call);
      return behaviour(call);
    },
  };
}

function imagesFor(manifest: PrintManifest, chosen: Record<string, Partial<PrintSlotImages>> = {}) {
  const images: Record<string, PrintSlotImages> = {};
  const physical = [
    ...manifest.cards,
    ...(manifest.extras.companion ? [manifest.extras.companion] : []),
  ];
  for (const c of physical) {
    images[String(c.slot)] = { front: null, back: null, ...chosen[String(c.slot)] };
  }
  return images;
}

function input(
  manifest: PrintManifest,
  lookup: CardLookup,
  overrides: Partial<ResolvePrintImagesInput> = {},
): ResolvePrintImagesInput {
  return {
    manifest,
    images: imagesFor(manifest),
    card_back: null,
    job_dir: jobDir,
    lookup,
    ...overrides,
  };
}

function slot(resolution: PrintImageResolution, n: number) {
  const value = resolution.slots[String(n)];
  if (!value) throw new Error(`no slot ${n} in the resolution`);
  return value;
}

describe("defaultPrinting", () => {
  it("prefers the newest release, then the alphabetically first set code, then the collector number", () => {
    expect(defaultPrinting(COMMANDER)?.scryfall_id).toBe("cmd-new-earlier-set");
    expect(
      defaultPrinting(
        card({
          oracle_id: "x",
          name: "X",
          printings: [
            printing("x-10", "set", "10", "2020-01-01"),
            printing("x-2", "set", "2", "2020-01-01"),
          ],
        }),
      )?.scryfall_id,
    ).toBe("x-2");
  });

  it("puts printings without a release date last and returns null without printings", () => {
    expect(defaultPrinting(SOL_RING)?.scryfall_id).toBe("sol-a");
    expect(defaultPrinting(NO_PRINTINGS)).toBeNull();
  });

  it("does not depend on catalog order", () => {
    const reversed = card({ ...COMMANDER, printings: [...COMMANDER.printings].reverse() });
    expect(defaultPrinting(reversed)?.scryfall_id).toBe(defaultPrinting(COMMANDER)?.scryfall_id);
  });
});

describe("resolvePrintImages with catalog printings", () => {
  it("prepares one 822 x 1122 file per face from the default printing, caches the Scryfall bytes per id and records the choice", async () => {
    const lookup = lookupOf(COMMANDER, SOL_RING);
    const manifest = manifestOf(deck({ cards: [{ oracle_id: "sol", qty: 2 }] }), lookup);
    const calls: FetchCall[] = [];

    const resolution = await resolvePrintImages(input(manifest, lookup), {
      scryfall: fakeScryfall(calls),
    });

    expect(resolution.complete).toBe(true);
    expect(resolution.attention).toEqual([]);
    expect(Object.keys(resolution.slots)).toEqual(["1", "2", "3"]);
    // Two copies of Sol Ring share one fetch; the commander is fetched once.
    expect(calls).toEqual([
      { scryfall_id: "cmd-new-earlier-set", face: "front" },
      { scryfall_id: "sol-a", face: "front" },
    ]);

    const commander = slot(resolution, 1);
    expect(commander.chosen).toEqual({
      front: { kind: "printing", scryfall_id: "cmd-new-earlier-set" },
      back: null,
    });
    expect(commander.front?.treatment).toBe("bled");
    expect(commander.front?.path).toBe(join(jobDir, "images", "slot-001-front.png"));
    expect(await readImageDimensions(await readBytes(commander.front?.path))).toEqual({
      width: 822,
      height: 1122,
    });
    expect(commander.back).toBeNull();
    expect(slot(resolution, 2).front?.path).toBe(join(jobDir, "images", "slot-002-front.png"));
    expect(slot(resolution, 3).front?.source).toEqual({ kind: "printing", scryfall_id: "sol-a" });

    expect(readdirSync(join(jobDir, "cache", "scryfall")).sort()).toEqual([
      "cmd-new-earlier-set.png",
      "sol-a.png",
    ]);

    // A second resolve reuses the cache and fetches nothing.
    const again: FetchCall[] = [];
    const second = await resolvePrintImages(input(manifest, lookup), {
      scryfall: fakeScryfall(again),
    });
    expect(again).toEqual([]);
    expect(second.complete).toBe(true);
  });

  it("honours the slot's chosen printing over the default and refuses a printing that is not of that card", async () => {
    const lookup = lookupOf(COMMANDER, SOL_RING);
    const manifest = manifestOf(deck({ cards: [{ oracle_id: "sol", qty: 1 }] }), lookup);
    const calls: FetchCall[] = [];
    const chosen = imagesFor(manifest, {
      "1": { front: { kind: "printing", scryfall_id: "cmd-old" } },
      "2": { front: { kind: "printing", scryfall_id: "delver-isd" } },
    });

    const resolution = await resolvePrintImages(input(manifest, lookup, { images: chosen }), {
      scryfall: fakeScryfall(calls),
    });

    expect(calls).toEqual([{ scryfall_id: "cmd-old", face: "front" }]);
    expect(slot(resolution, 1).front?.source).toEqual({ kind: "printing", scryfall_id: "cmd-old" });
    expect(slot(resolution, 2).front).toBeNull();
    expect(resolution.complete).toBe(false);
    expect(resolution.attention).toEqual([
      expect.objectContaining({
        kind: "printing_mismatch",
        slot: 2,
        face: "front",
        ref: "sol",
        message: expect.stringContaining("delver-isd"),
      }),
    ]);
  });

  it("resolves a transform card to a front and a back from the same printing", async () => {
    const lookup = lookupOf(COMMANDER, DELVER);
    const manifest = manifestOf(deck({ cards: [{ oracle_id: "delver", qty: 1 }] }), lookup);
    const calls: FetchCall[] = [];

    const resolution = await resolvePrintImages(input(manifest, lookup), {
      scryfall: fakeScryfall(calls),
    });

    expect(calls).toContainEqual({ scryfall_id: "delver-isd", face: "front" });
    expect(calls).toContainEqual({ scryfall_id: "delver-isd", face: "back" });
    const delver = slot(resolution, 2);
    expect(delver.chosen).toEqual({
      front: { kind: "printing", scryfall_id: "delver-isd" },
      back: { kind: "printing", scryfall_id: "delver-isd" },
    });
    expect(delver.front?.path).toBe(join(jobDir, "images", "slot-002-front.png"));
    expect(delver.back?.path).toBe(join(jobDir, "images", "slot-002-back.png"));
    expect(existsSync(join(jobDir, "cache", "scryfall", "delver-isd-back.png"))).toBe(true);
    expect(resolution.complete).toBe(true);
  });

  it("uses the default printing's back face when the front is a user file", async () => {
    const lookup = lookupOf(COMMANDER, DELVER);
    const manifest = manifestOf(deck({ cards: [{ oracle_id: "delver", qty: 1 }] }), lookup);
    const front = join(root, "delver-front.png");
    writeFileSync(front, await solidPng(822, 1122, [10, 20, 30]));
    const calls: FetchCall[] = [];

    const resolution = await resolvePrintImages(
      input(manifest, lookup, {
        images: imagesFor(manifest, { "2": { front: { kind: "file", path: front } } }),
      }),
      { scryfall: fakeScryfall(calls) },
    );

    const delver = slot(resolution, 2);
    expect(delver.front?.treatment).toBe("as_is");
    expect(delver.back?.source).toEqual({ kind: "printing", scryfall_id: "delver-isd" });
    expect(calls.filter((c) => c.scryfall_id === "delver-isd")).toEqual([
      { scryfall_id: "delver-isd", face: "back" },
    ]);
  });

  it("reports a Scryfall miss as no_image, an outage as source_unavailable, and keeps resolving the other faces", async () => {
    const lookup = lookupOf(COMMANDER, SOL_RING, DELVER);
    const manifest = manifestOf(
      deck({
        cards: [
          { oracle_id: "sol", qty: 1 },
          { oracle_id: "delver", qty: 1 },
        ],
      }),
      lookup,
    );

    const resolution = await resolvePrintImages(input(manifest, lookup), {
      scryfall: fakeScryfall([], (call) => {
        if (call.scryfall_id === "sol-a")
          return Promise.reject(new StructuredError("UNKNOWN_CARD", "no such printing"));
        if (call.face === "back")
          return Promise.reject(
            new StructuredError("UPSTREAM_UNAVAILABLE", "Scryfall returned 503", { status: 503 }),
          );
        return Promise.resolve(scryfallPng);
      }),
    });

    expect(slot(resolution, 1).front).not.toBeNull();
    expect(slot(resolution, 2).front).toBeNull();
    expect(slot(resolution, 3).front).not.toBeNull();
    expect(slot(resolution, 3).back).toBeNull();
    expect(resolution.complete).toBe(false);
    expect(resolution.attention).toEqual([
      expect.objectContaining({ kind: "no_image", slot: 2, face: "front", ref: "sol" }),
      expect.objectContaining({ kind: "source_unavailable", slot: 3, face: "back", ref: "delver" }),
    ]);
    // Nothing is cached for a failed fetch.
    expect(existsSync(join(jobDir, "cache", "scryfall", "sol-a.png"))).toBe(false);
  });

  it("treats a 422 for a face Scryfall cannot serve as no_image for that face only", async () => {
    const lookup = lookupOf(COMMANDER, DELVER);
    const manifest = manifestOf(deck({ cards: [{ oracle_id: "delver", qty: 1 }] }), lookup);
    const resolution = await resolvePrintImages(input(manifest, lookup), {
      scryfall: fakeScryfall([], (call) =>
        call.face === "back"
          ? Promise.reject(
              new StructuredError("UPSTREAM_UNAVAILABLE", "Scryfall returned 422", { status: 422 }),
            )
          : Promise.resolve(scryfallPng),
      ),
    });
    expect(slot(resolution, 2).front).not.toBeNull();
    expect(resolution.attention).toEqual([
      expect.objectContaining({ kind: "no_image", slot: 2, face: "back", ref: "delver" }),
    ]);
  });

  it("flags a card without printings and an unknown card instead of guessing", async () => {
    const lookup = lookupOf(COMMANDER, NO_PRINTINGS);
    const manifest = manifestOf(
      deck({
        cards: [
          { oracle_id: "nop", qty: 1 },
          { oracle_id: "ghost", qty: 1 },
        ],
      }),
      lookup,
    );
    const calls: FetchCall[] = [];
    const resolution = await resolvePrintImages(input(manifest, lookup), {
      scryfall: fakeScryfall(calls),
    });
    expect(calls).toEqual([{ scryfall_id: "cmd-new-earlier-set", face: "front" }]);
    expect(resolution.attention).toEqual([
      expect.objectContaining({ kind: "no_printing", slot: 2, face: "front", ref: "nop" }),
      expect.objectContaining({ kind: "no_printing", slot: 3, face: "front", ref: "ghost" }),
    ]);
  });
});

describe("resolvePrintImages with user files", () => {
  it("copies a print-ready local file as-is, flags an undersized one, and flags a missing or unreadable one", async () => {
    const lookup = lookupOf(COMMANDER, SOL_RING);
    const manifest = manifestOf(deck({ cards: [{ oracle_id: "sol", qty: 3 }] }), lookup);
    const ready = join(root, "ready.jpg");
    writeFileSync(
      ready,
      await sharp(await solidPng(900, 1200, [1, 2, 3]))
        .jpeg()
        .toBuffer(),
    );
    const small = join(root, "small.png");
    writeFileSync(small, await solidPng(745, 1040, [1, 2, 3]));
    const text = join(root, "notes.txt");
    writeFileSync(text, "not an image");
    const calls: FetchCall[] = [];

    const resolution = await resolvePrintImages(
      input(manifest, lookup, {
        images: imagesFor(manifest, {
          "2": { front: { kind: "file", path: ready } },
          "3": { front: { kind: "file", path: small } },
          "4": { front: { kind: "file", path: join(root, "missing.png") } },
        }),
      }),
      { scryfall: fakeScryfall(calls) },
    );

    const readySlot = slot(resolution, 2);
    expect(readySlot.front).toMatchObject({
      treatment: "as_is",
      width: 900,
      height: 1200,
      path: join(jobDir, "images", "slot-002-front.jpg"),
      source: { kind: "file", path: ready },
    });
    expect(readySlot.chosen.front).toEqual({ kind: "file", path: ready });
    expect(slot(resolution, 3).front).toBeNull();
    expect(slot(resolution, 4).front).toBeNull();
    expect(resolution.attention).toEqual([
      expect.objectContaining({
        kind: "undersized_image",
        slot: 3,
        face: "front",
        message: expect.stringContaining("745 x 1040"),
      }),
      expect.objectContaining({ kind: "unreadable_file", slot: 4, face: "front" }),
    ]);
    // A user file never triggers a Scryfall fetch for that face.
    expect(calls.map((c) => c.scryfall_id)).toEqual(["cmd-new-earlier-set"]);

    const unreadable = await resolvePrintImages(
      input(manifest, lookup, {
        images: imagesFor(manifest, { "2": { front: { kind: "file", path: text } } }),
      }),
      { scryfall: fakeScryfall([]) },
    );
    expect(unreadable.attention).toContainEqual(
      expect.objectContaining({ kind: "unreadable_file", slot: 2 }),
    );
  });

  it("prepares the chosen card back the same way and leaves the printer default alone when none is chosen", async () => {
    const lookup = lookupOf(COMMANDER);
    const manifest = manifestOf(deck({}), lookup);
    const back = join(root, "back.png");
    writeFileSync(back, await solidPng(822, 1122, [40, 40, 40]));

    const withBack = await resolvePrintImages(
      input(manifest, lookup, { card_back: { kind: "file", path: back } }),
      { scryfall: fakeScryfall([]) },
    );
    expect(withBack.card_back).toMatchObject({
      treatment: "as_is",
      path: join(jobDir, "images", "card-back.png"),
    });

    const calls: FetchCall[] = [];
    const printedBack = await resolvePrintImages(
      input(manifest, lookup, { card_back: { kind: "printing", scryfall_id: "sol-b" } }),
      { scryfall: fakeScryfall(calls) },
    );
    expect(calls).toContainEqual({ scryfall_id: "sol-b", face: "front" });
    expect(printedBack.card_back?.treatment).toBe("bled");

    const none = await resolvePrintImages(input(manifest, lookup), { scryfall: fakeScryfall([]) });
    expect(none.card_back).toBeNull();
    expect(none.attention).toEqual([]);
  });
});

describe("resolvePrintImages with the community source", () => {
  function community(
    search: (name: string) => Promise<CommunityCandidate[]>,
    download: (id: string) => Promise<Uint8Array> = () => Promise.resolve(scryfallPng),
  ): CommunityImageSource {
    return { search, download };
  }
  const candidate = (id: string, name: string): CommunityCandidate => ({
    id,
    name,
    source: "Drive",
    dpi: 800,
    size: 1,
    extension: "png",
  });

  it("uses a single exact-name community match only when the catalog has no printing, and records it as the choice", async () => {
    const lookup = lookupOf(COMMANDER, NO_PRINTINGS);
    const manifest = manifestOf(deck({ cards: [{ oracle_id: "nop", qty: 1 }] }), lookup);
    const searched: string[] = [];
    const downloaded: string[] = [];

    const resolution = await resolvePrintImages(input(manifest, lookup), {
      scryfall: fakeScryfall([]),
      community: community(
        (name) => {
          searched.push(name);
          return Promise.resolve([candidate("drive-1", "unprinted card")]);
        },
        (id) => {
          downloaded.push(id);
          return Promise.resolve(scryfallPng);
        },
      ),
    });

    expect(searched).toEqual(["Unprinted Card"]);
    expect(downloaded).toEqual(["drive-1"]);
    const nop = slot(resolution, 2);
    expect(nop.chosen.front).toEqual({ kind: "community", id: "drive-1" });
    expect(nop.front).toMatchObject({ treatment: "bled", width: 822, height: 1122 });
    expect(resolution.complete).toBe(true);
  });

  it("downloads an explicitly chosen community image without searching", async () => {
    const lookup = lookupOf(COMMANDER, SOL_RING);
    const manifest = manifestOf(deck({ cards: [{ oracle_id: "sol", qty: 1 }] }), lookup);
    const searched: string[] = [];
    const resolution = await resolvePrintImages(
      input(manifest, lookup, {
        images: imagesFor(manifest, { "2": { front: { kind: "community", id: "drive-9" } } }),
      }),
      {
        scryfall: fakeScryfall([]),
        community: community((name) => {
          searched.push(name);
          return Promise.resolve([]);
        }),
      },
    );
    expect(searched).toEqual([]);
    expect(slot(resolution, 2).front?.source).toEqual({ kind: "community", id: "drive-9" });
  });

  it("reports several matches as ambiguous with the candidates, none as no_image, searches each name once and never picks for the user", async () => {
    const other = card({ oracle_id: "nop2", name: "Other Unprinted", printings: [] });
    const lookup = lookupOf(COMMANDER, NO_PRINTINGS, other);
    const manifest = manifestOf(
      deck({
        cards: [
          { oracle_id: "nop", qty: 2 },
          { oracle_id: "nop2", qty: 1 },
        ],
      }),
      lookup,
    );
    const searched: string[] = [];
    const downloaded: string[] = [];
    const resolution = await resolvePrintImages(input(manifest, lookup), {
      scryfall: fakeScryfall([]),
      community: community(
        (name) => {
          searched.push(name);
          return Promise.resolve(
            name === "Unprinted Card"
              ? [candidate("a", "Unprinted Card"), candidate("b", "Unprinted Card")]
              : [candidate("c", "Other Unprinted (Extended)")],
          );
        },
        (id) => {
          downloaded.push(id);
          return Promise.resolve(scryfallPng);
        },
      ),
    });
    expect(downloaded).toEqual([]);
    expect(searched).toEqual(["Unprinted Card", "Other Unprinted"]);
    expect(resolution.attention).toEqual([
      expect.objectContaining({
        kind: "ambiguous_match",
        slot: 2,
        candidates: [candidate("a", "Unprinted Card"), candidate("b", "Unprinted Card")],
      }),
      expect.objectContaining({ kind: "ambiguous_match", slot: 3 }),
      expect.objectContaining({ kind: "no_image", slot: 4 }),
    ]);
  });

  it("degrades to image_service_unavailable for the affected face when the community source fails, and still resolves the rest", async () => {
    const lookup = lookupOf(COMMANDER, NO_PRINTINGS);
    const manifest = manifestOf(deck({ cards: [{ oracle_id: "nop", qty: 1 }] }), lookup);
    const resolution = await resolvePrintImages(input(manifest, lookup), {
      scryfall: fakeScryfall([]),
      community: community(() =>
        Promise.reject(new StructuredError("UPSTREAM_UNAVAILABLE", "backend down")),
      ),
    });
    expect(slot(resolution, 1).front).not.toBeNull();
    expect(slot(resolution, 2).front).toBeNull();
    expect(resolution.attention).toEqual([
      expect.objectContaining({ kind: "image_service_unavailable", slot: 2, ref: "nop" }),
    ]);

    const htmlInsteadOfImage = await resolvePrintImages(input(manifest, lookup), {
      scryfall: fakeScryfall([]),
      community: community(
        () => Promise.resolve([candidate("drive-1", "Unprinted Card")]),
        () => Promise.resolve(new TextEncoder().encode("<html>sign in</html>")),
      ),
    });
    expect(htmlInsteadOfImage.attention).toEqual([
      expect.objectContaining({ kind: "image_service_unavailable", slot: 2 }),
    ]);
  });

  it("reports no_printing, not a community lookup, when no community source is configured", async () => {
    const lookup = lookupOf(COMMANDER, NO_PRINTINGS);
    const manifest = manifestOf(deck({ cards: [{ oracle_id: "nop", qty: 1 }] }), lookup);
    const resolution = await resolvePrintImages(input(manifest, lookup), {
      scryfall: fakeScryfall([]),
      community: null,
    });
    expect(resolution.attention).toEqual([
      expect.objectContaining({
        kind: "no_printing",
        slot: 2,
        message: expect.stringContaining("community"),
      }),
    ]);
  });
});

async function readBytes(path: string | undefined): Promise<Uint8Array> {
  if (!path) throw new Error("expected a prepared file");
  const { readFile } = await import("node:fs/promises");
  return readFile(path);
}

// Type-level pin: the selector's choices stay in the job store's vocabulary.
const _refs: PrintImageRef[] = [
  { kind: "printing", scryfall_id: "x" },
  { kind: "file", path: "/x" },
  { kind: "community", id: "x" },
];
void _refs;
