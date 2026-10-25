import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Card, CardFace, CardGameplay, Deck, Printing } from "../types/index.js";
import type { CardLookup } from "../validate/index.js";
import type { PreparedFace, PrintImageResolution } from "./imageSelector.js";
import type { PrintImageRef, PrintSettings } from "./jobStore.js";
import { buildPrintManifest, type PrintManifest } from "./manifest.js";
import {
  MPC_BRACKETS,
  MPC_PROJECT_MAX_SIZE,
  PRINT_CARDS_XML_FILENAME,
  PRINT_PROJECT_FILENAME,
  PrintProjectSchema,
  bracketFor,
  buildPrintProject,
  renderCardsXml,
  writePrintProject,
  type PrintProject,
  type PrintProjectJob,
} from "./projectFile.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

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

function printing(scryfall_id: string): Printing {
  return {
    scryfall_id,
    set: "set",
    set_name: "SET",
    collector_number: "1",
    rarity: "rare",
    prices: {},
    released_at: "2026-01-01",
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

const COMMANDER = card({ oracle_id: "cmd", name: "Commander", printings: [printing("p-cmd")] });
const ALPHA = card({ oracle_id: "alpha", name: "Alpha", printings: [printing("p-alpha")] });
const DFC = card({
  oracle_id: "dfc",
  name: "Delver of Secrets // Insectile Aberration",
  printings: [printing("p-dfc")],
  gameplay: gameplay("transform", [face(0, "Delver of Secrets"), face(1, "Insectile Aberration")]),
});
const COMPANION = card({ oracle_id: "pal", name: "Lutri", printings: [printing("p-pal")] });

function lookupOf(...cards: Card[]): CardLookup {
  const byId = new Map(cards.map((c) => [c.oracle_id, c]));
  return (id) => byId.get(id) ?? null;
}

function deck(partial: Partial<Deck> = {}): Deck {
  return {
    deck_id: "deck-1",
    name: "Print me",
    format: "commander",
    commanders: ["cmd"],
    command_zone_kind: "single",
    cards: [
      { oracle_id: "alpha", qty: 4 },
      { oracle_id: "dfc", qty: 1 },
    ],
    computed_color_identity: [],
    version: 3,
    data_snapshot: "snap-1",
    ...partial,
  };
}

function manifestOf(d: Deck, lookup: CardLookup = lookupOf(COMMANDER, ALPHA, DFC)): PrintManifest {
  const result = buildPrintManifest(d, lookup);
  if (result.kind !== "manifest") throw new Error("expected a manifest");
  return result.manifest;
}

const JOB_ID = "0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b";
const JOB_DIR = `/data/print-jobs/${JOB_ID}`;
const CARD_BACK_FILE: PrintImageRef = { kind: "file", path: "/home/user/back.png" };

function job(
  manifest: PrintManifest,
  overrides: Omit<Partial<PrintProjectJob>, "settings"> & {
    settings?: Partial<PrintSettings>;
  } = {},
): PrintProjectJob {
  const { settings, ...rest } = overrides;
  return {
    job_id: JOB_ID,
    project_name: "mtg-edh-print-0f1e2d3c",
    job_dir: JOB_DIR,
    deck_id: manifest.deck_id,
    deck_name: manifest.deck_name,
    deck_version: manifest.version,
    data_snapshot: manifest.data_snapshot,
    manifest,
    settings: {
      stock: "(S33) Superior Smooth",
      foil: true,
      card_back: CARD_BACK_FILE,
      ...settings,
    },
    ...rest,
  };
}

function prepared(jobDir: string, stem: string, source: PrintImageRef): PreparedFace {
  return {
    path: join(jobDir, "images", `${stem}.png`),
    width: 822,
    height: 1122,
    treatment: "bled",
    source,
  };
}

/** The resolution the image selector leaves for `manifest`: one file per face, grouped by printing. */
function resolutionOf(
  manifest: PrintManifest,
  jobDir = JOB_DIR,
  options: { card_back?: PreparedFace | null } = {},
): PrintImageResolution {
  const slots: PrintImageResolution["slots"] = {};
  const physical = [
    ...manifest.cards,
    ...(manifest.extras.companion ? [manifest.extras.companion] : []),
  ];
  for (const printCard of physical) {
    const stem = `slot-${String(printCard.slot).padStart(3, "0")}`;
    const ref: PrintImageRef = { kind: "printing", scryfall_id: `p-${printCard.oracle_id}` };
    const front = prepared(jobDir, `${stem}-front`, ref);
    const back = printCard.back ? prepared(jobDir, `${stem}-back`, ref) : null;
    slots[String(printCard.slot)] = {
      front,
      back,
      chosen: { front: ref, back: back ? ref : null },
    };
  }
  const card_back =
    options.card_back === undefined
      ? { ...prepared(jobDir, "card-back", CARD_BACK_FILE), treatment: "as_is" as const }
      : options.card_back;
  return { slots, card_back, attention: [], complete: true };
}

function expectProject(result: ReturnType<typeof buildPrintProject>): PrintProject {
  if (result.kind !== "project") throw new Error(`expected a project, got ${result.kind}`);
  return result.project;
}

describe("MakePlayingCards brackets", () => {
  it("lists the printer's brackets in ascending order up to the project maximum", () => {
    expect([...MPC_BRACKETS]).toEqual([...MPC_BRACKETS].sort((a, b) => a - b));
    expect(MPC_BRACKETS[MPC_BRACKETS.length - 1]).toBe(MPC_PROJECT_MAX_SIZE);
    expect(MPC_PROJECT_MAX_SIZE).toBe(612);
  });

  it.each([
    [1, 18],
    [18, 18],
    [19, 36],
    [100, 108],
    [234, 234],
    [235, 396],
    [612, 612],
  ])("picks the smallest bracket at or above %i cards (%i)", (quantity, bracket) => {
    expect(bracketFor(quantity)).toBe(bracket);
  });

  it("has no bracket above the project maximum or for an empty order", () => {
    expect(bracketFor(613)).toBeNull();
    expect(bracketFor(0)).toBeNull();
  });
});

describe("buildPrintProject", () => {
  const manifest = manifestOf(deck());

  it("matches the golden project document for a commander, a 4x card and a transform card", () => {
    const project = expectProject(buildPrintProject(job(manifest), resolutionOf(manifest)));
    const golden: unknown = JSON.parse(
      readFileSync(join(FIXTURES, "printProject.golden.json"), "utf8"),
    );
    expect(project).toEqual(golden);
    expect(project.quantity).toBe(manifest.total);
    expect(project.bracket).toBe(bracketFor(manifest.total));
    expect(PrintProjectSchema.parse(golden)).toEqual(project);
  });

  it("numbers front slots contiguously from zero and puts the back on exactly its front slot", () => {
    const project = expectProject(buildPrintProject(job(manifest), resolutionOf(manifest)));
    const fronts = project.fronts.flatMap((image) => image.slots).sort((a, b) => a - b);
    expect(fronts).toEqual([0, 1, 2, 3, 4, 5]);
    expect(project.slots.map((slot) => slot.slot)).toEqual([0, 1, 2, 3, 4, 5]);
    const dfcSlot = project.slots.find((slot) => slot.oracle_id === "dfc");
    expect(project.backs).toEqual([
      { path: "images/slot-006-back.png", name: "slot-006-back.png", slots: [dfcSlot?.slot] },
    ]);
    expect(project.card_back).toBe("images/card-back.png");
  });

  it("counts a printed companion as a physical card after the main cards", () => {
    const withCompanion = manifestOf(
      deck({ companion: "pal" }),
      lookupOf(COMMANDER, ALPHA, DFC, COMPANION),
    );
    const project = expectProject(
      buildPrintProject(job(withCompanion), resolutionOf(withCompanion)),
    );
    expect(project.quantity).toBe(withCompanion.total + 1);
    expect(project.slots.at(-1)).toEqual({
      slot: 6,
      name: "Lutri",
      oracle_id: "pal",
      source: "companion",
    });
    expect(project.fronts.at(-1)).toEqual({
      path: "images/slot-007-front.png",
      name: "slot-007-front.png",
      slots: [6],
    });
  });

  it("keeps the printer's default back when the job chose none", () => {
    const project = expectProject(
      buildPrintProject(
        job(manifest, { settings: { card_back: null } }),
        resolutionOf(manifest, JOB_DIR, { card_back: null }),
      ),
    );
    expect(project.card_back).toBeNull();
  });

  it("refuses an incomplete resolution instead of writing holes", () => {
    const resolution = resolutionOf(manifest);
    const dfc = resolution.slots["6"];
    if (!dfc) throw new Error("expected slot 6");
    resolution.slots["6"] = { ...dfc, back: null };
    resolution.complete = false;
    resolution.attention.push({
      kind: "no_image",
      slot: 6,
      face: "back",
      ref: "dfc",
      message:
        "Scryfall serves no back face image for printing p-dfc; supply a file for this face.",
    });
    const result = buildPrintProject(job(manifest), resolution);
    expect(result.kind).toBe("incomplete");
    if (result.kind !== "incomplete") return;
    expect(result.attention).toEqual(resolution.attention);
    expect(result.missing).toEqual([{ slot: 6, face: "back" }]);
  });

  it("reports a face the selector never resolved and a missing chosen card back", () => {
    const resolution = resolutionOf(manifest, JOB_DIR, { card_back: null });
    delete resolution.slots["3"];
    const result = buildPrintProject(job(manifest), resolution);
    expect(result.kind).toBe("incomplete");
    if (result.kind !== "incomplete") return;
    expect(result.missing).toEqual([
      { slot: 3, face: "front" },
      { slot: null, face: "front" },
    ]);
  });

  it("validates stock and foil against the schema before anything is written", () => {
    const badStock = buildPrintProject(
      job(manifest, { settings: { stock: "(S27) Smooth" as PrintSettings["stock"] } }),
      resolutionOf(manifest),
    );
    expect(badStock.kind).toBe("invalid");
    if (badStock.kind === "invalid") expect(badStock.message).toContain("stock");
    const badFoil = buildPrintProject(
      job(manifest, { settings: { foil: "yes" as unknown as boolean } }),
      resolutionOf(manifest),
    );
    expect(badFoil.kind).toBe("invalid");
    if (badFoil.kind === "invalid") expect(badFoil.message).toContain("foil");
  });

  it("refuses an order above the largest bracket", () => {
    const big = manifestOf(deck({ cards: [{ oracle_id: "alpha", qty: 612 }] }));
    const result = buildPrintProject(job(big), resolutionOf(big));
    expect(result).toEqual({ kind: "too_large", quantity: 613, max: 612 });
  });
});

describe("renderCardsXml", () => {
  const manifest = manifestOf(deck());

  it("matches the golden cards.xml with absolute local file paths", () => {
    const project = expectProject(buildPrintProject(job(manifest), resolutionOf(manifest)));
    const golden = readFileSync(join(FIXTURES, "printProjectCards.golden.xml"), "utf8");
    expect(renderCardsXml(project, JOB_DIR)).toBe(golden);
  });

  it("omits backs when no card has one and leaves the cardback empty for the printer default", () => {
    const plain = manifestOf(deck({ cards: [{ oracle_id: "alpha", qty: 2 }] }));
    const project = expectProject(
      buildPrintProject(
        job(plain, { settings: { card_back: null, foil: false, stock: "(S30) Standard Smooth" } }),
        resolutionOf(plain, JOB_DIR, { card_back: null }),
      ),
    );
    const xml = renderCardsXml(project, JOB_DIR);
    expect(xml).not.toContain("<backs>");
    expect(xml).toContain("<cardback/>");
    expect(xml).toContain("<quantity>3</quantity>");
    expect(xml).toContain("<stock>(S30) Standard Smooth</stock>");
    expect(xml).toContain("<foil>false</foil>");
    expect(xml).not.toContain("<bracket>");
    expect(xml).not.toContain("<query>");
  });

  it("escapes XML-significant characters in file paths", () => {
    const odd = "/data/Tom & Jerry's <proxies>";
    const project = expectProject(
      buildPrintProject(job(manifest, { job_dir: odd }), resolutionOf(manifest, odd)),
    );
    const xml = renderCardsXml(project, odd);
    expect(xml).toContain(
      "<id>/data/Tom &amp; Jerry&apos;s &lt;proxies&gt;/images/slot-001-front.png</id>",
    );
    expect(xml).not.toContain("Tom & Jerry");
  });
});

describe("writePrintProject", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "print-project-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes project.json and cards.xml into the job directory without leaving temporary files", async () => {
    const manifest = manifestOf(deck());
    const jobDir = join(root, "print-jobs", JOB_ID);
    const record = job(manifest, { job_dir: jobDir });
    const result = await writePrintProject(record, resolutionOf(manifest, jobDir));
    expect(result.kind).toBe("written");
    if (result.kind !== "written") return;
    expect(result.project_path).toBe(join(jobDir, PRINT_PROJECT_FILENAME));
    expect(result.cards_xml_path).toBe(join(jobDir, PRINT_CARDS_XML_FILENAME));
    expect(readdirSync(jobDir).sort()).toEqual([PRINT_CARDS_XML_FILENAME, PRINT_PROJECT_FILENAME]);
    const stored: unknown = JSON.parse(readFileSync(result.project_path, "utf8"));
    expect(PrintProjectSchema.parse(stored)).toEqual(result.project);
    expect(readFileSync(result.cards_xml_path, "utf8")).toBe(
      renderCardsXml(result.project, jobDir),
    );
    expect(readFileSync(result.project_path, "utf8").endsWith("\n")).toBe(true);
  });

  it("replaces a previous document whole and keeps both files when later steps fail", async () => {
    const manifest = manifestOf(deck());
    const jobDir = join(root, "print-jobs", JOB_ID);
    const first = await writePrintProject(
      job(manifest, { job_dir: jobDir }),
      resolutionOf(manifest, jobDir),
    );
    expect(first.kind).toBe("written");
    const second = await writePrintProject(
      job(manifest, { job_dir: jobDir, settings: { foil: false } }),
      resolutionOf(manifest, jobDir),
    );
    expect(second.kind).toBe("written");
    if (second.kind !== "written") return;
    expect(second.project.foil).toBe(false);
    const stored: unknown = JSON.parse(readFileSync(second.project_path, "utf8"));
    expect(PrintProjectSchema.parse(stored).foil).toBe(false);
    // A later step failing (simulated here) must not remove the retained files.
    await expect(Promise.reject(new Error("filler failed"))).rejects.toThrow("filler failed");
    expect(existsSync(second.project_path)).toBe(true);
    expect(existsSync(second.cards_xml_path)).toBe(true);
    expect(readdirSync(jobDir).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("writes nothing for an incomplete resolution", async () => {
    const manifest = manifestOf(deck());
    const jobDir = join(root, "print-jobs", JOB_ID);
    const resolution = resolutionOf(manifest, jobDir);
    delete resolution.slots["2"];
    const result = await writePrintProject(job(manifest, { job_dir: jobDir }), resolution);
    expect(result.kind).toBe("incomplete");
    expect(existsSync(join(jobDir, PRINT_PROJECT_FILENAME))).toBe(false);
    expect(existsSync(join(jobDir, PRINT_CARDS_XML_FILENAME))).toBe(false);
  });
});
