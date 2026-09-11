import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/cardIndex.js";
import { loadEngineBaseline } from "./engineBaseline.js";
import {
  censusCard,
  censusLegalPool,
  classifyClause,
  indexVocabulary,
  loadKeywordVocabulary,
  ownershipChunks,
  type KeywordVocabulary,
  type LegalPoolCensus,
} from "./legalPool.js";
import {
  FAMILY_OWNERS,
  KEYWORD_BATCHES,
  QUALIFIED_EVIDENCE,
  UNLISTED_KEYWORD_CHUNK,
} from "./legalPoolOwnership.js";
import {
  encodeLedger,
  generateLegalPoolReport,
  readLegalPoolReport,
  servedDataRoot,
} from "./legalPoolReport.js";
import { digestEvaluation } from "./registration.js";

/** Raw Scryfall-shaped fixture covering every census family kind. */
const ORACLE = [
  {
    oracle_id: "b34bb2dc-c1af-4d77-b0b3-a0fb342a5fc6",
    id: "p-forest",
    name: "Forest",
    layout: "normal",
    cmc: 0,
    colors: [],
    color_identity: ["G"],
    type_line: "Basic Land — Forest",
    oracle_text: "",
    keywords: [],
    legalities: { commander: "legal" },
    prices: {},
  },
  {
    oracle_id: "o-plains",
    id: "p-plains",
    name: "Plains",
    layout: "normal",
    cmc: 0,
    colors: [],
    color_identity: ["W"],
    type_line: "Basic Land — Plains",
    oracle_text: "",
    keywords: [],
    legalities: { commander: "legal" },
    prices: {},
  },
  {
    oracle_id: "o-sol",
    id: "p-sol",
    name: "Sol Ring",
    layout: "normal",
    cmc: 1,
    colors: [],
    color_identity: [],
    type_line: "Artifact",
    oracle_text: "{T}: Add {C}{C}.",
    keywords: [],
    legalities: { commander: "legal" },
    prices: {},
  },
  {
    oracle_id: "o-atraxa",
    id: "p-atraxa",
    name: "Atraxa, Praetors' Voice",
    layout: "normal",
    cmc: 4,
    colors: ["W", "U", "B", "G"],
    color_identity: ["W", "U", "B", "G"],
    type_line: "Legendary Creature — Phyrexian Angel Horror",
    oracle_text:
      "Flying, vigilance, deathtouch, lifelink\nAt the beginning of your end step, proliferate. (Choose any number of permanents and/or players, then give each another counter of each kind already there.)",
    power: "4",
    toughness: "4",
    keywords: ["Flying", "Vigilance", "Deathtouch", "Lifelink", "Proliferate"],
    legalities: { commander: "legal" },
    prices: {},
  },
  {
    oracle_id: "o-dfc",
    id: "p-dfc",
    name: "Delver Front // Delver Back",
    layout: "transform",
    cmc: 1,
    colors: ["U"],
    color_identity: ["U"],
    keywords: ["Flying", "Transform"],
    legalities: { commander: "legal" },
    prices: {},
    card_faces: [
      {
        name: "Delver Front",
        mana_cost: "{U}",
        type_line: "Creature — Human Wizard",
        oracle_text:
          "At the beginning of your upkeep, look at the top card of your library. You may reveal that card. If an instant or sorcery card is revealed this way, transform this creature.",
        power: "1",
        toughness: "1",
      },
      {
        name: "Delver Back",
        mana_cost: "",
        type_line: "Creature — Human Insect",
        oracle_text: "Flying",
        power: "3",
        toughness: "2",
      },
    ],
  },
  {
    oracle_id: "o-saga",
    id: "p-saga",
    name: "Chronicle",
    layout: "saga",
    cmc: 3,
    colors: ["W"],
    color_identity: ["W"],
    type_line: "Enchantment — Saga",
    oracle_text:
      "(As this Saga enters and after your draw step, add a lore counter.)\nI — Create a 1/1 white Soldier creature token.\nII, III — Creatures you control get +1/+1 until end of turn.",
    keywords: [],
    legalities: { commander: "legal" },
    prices: {},
  },
  {
    oracle_id: "o-walker",
    id: "p-walker",
    name: "Planar Guide",
    layout: "normal",
    cmc: 5,
    colors: ["U"],
    color_identity: ["U"],
    type_line: "Legendary Planeswalker — Guide",
    oracle_text:
      '+1: Draw a card.\n−3: Choose one —\n• Return target creature to its owner\'s hand.\n• Counter target spell.\n−8: You get an emblem with "You have no maximum hand size."',
    loyalty: "4",
    keywords: [],
    legalities: { commander: "legal" },
    prices: {},
  },
  {
    oracle_id: "o-partner",
    id: "p-partner",
    name: "Pir, Imaginative Rascal",
    layout: "normal",
    cmc: 3,
    colors: ["G"],
    color_identity: ["G"],
    type_line: "Legendary Creature — Human",
    oracle_text:
      "If one or more counters would be put on a permanent or player, that many plus one of each of those kinds of counters are put on that permanent or player instead.\nPartner with Toothy, Imaginary Friend (When this creature enters, target player may put Toothy into their hand from their library, then shuffle.)",
    power: "1",
    toughness: "1",
    keywords: ["Partner with"],
    legalities: { commander: "legal" },
    prices: {},
    all_parts: [
      {
        object: "related_card",
        id: "toothy",
        component: "combo_piece",
        name: "Toothy, Imaginary Friend",
        type_line: "Legendary Creature — Illusion",
        uri: "https://api.scryfall.com/cards/toothy",
      },
    ],
  },
  {
    oracle_id: "o-background",
    id: "p-background",
    name: "Raised by Giants",
    layout: "normal",
    cmc: 6,
    colors: ["G"],
    color_identity: ["G"],
    type_line: "Legendary Enchantment — Background",
    oracle_text:
      "Commander creatures you own have base power and toughness 10/10 and are Giants in addition to their other types.",
    keywords: [],
    legalities: { commander: "legal" },
    prices: {},
  },
  {
    oracle_id: "o-chooser",
    id: "p-chooser",
    name: "Wilson, Refined Grizzly",
    layout: "normal",
    cmc: 2,
    colors: ["G"],
    color_identity: ["G"],
    type_line: "Legendary Creature — Bear Warrior",
    oracle_text:
      "Choose a Background (You can have a Background as a second commander.)\nVigilance, reach, trample, ward {1}",
    power: "2",
    toughness: "2",
    keywords: ["Choose a background", "Vigilance", "Reach", "Trample", "Ward"],
    legalities: { commander: "legal" },
    prices: {},
  },
  {
    oracle_id: "o-companion",
    id: "p-companion",
    name: "Lurrus of the Dream-Den",
    layout: "normal",
    cmc: 3,
    colors: ["W", "B"],
    color_identity: ["W", "B"],
    type_line: "Legendary Creature — Cat Nightmare",
    oracle_text:
      "Companion — Each permanent card in your starting deck has mana value 2 or less. (If this card is your chosen companion, you may put it into your hand from outside the game for {3} any time you could cast a sorcery.)\nLifelink\nDuring each of your turns, you may cast one permanent spell with mana value 2 or less from your graveyard.",
    power: "3",
    toughness: "2",
    keywords: ["Companion", "Lifelink"],
    legalities: { commander: "legal" },
    prices: {},
  },
  {
    oracle_id: "o-tokens",
    id: "p-tokens",
    name: "Skeleton Crew",
    layout: "normal",
    cmc: 4,
    colors: ["B"],
    color_identity: ["B"],
    type_line: "Sorcery",
    oracle_text: "Create two 2/2 black Skeleton Pirate creature tokens.",
    keywords: [],
    legalities: { commander: "legal" },
    prices: {},
    all_parts: [
      {
        object: "related_card",
        id: "skeleton-pirate",
        component: "token",
        name: "Skeleton Pirate",
        type_line: "Token Creature — Skeleton Pirate",
        uri: "https://api.scryfall.com/cards/skeleton-pirate",
      },
    ],
  },
  {
    oracle_id: "o-perk",
    id: "p-perk",
    name: "Vault Dweller",
    layout: "normal",
    cmc: 2,
    colors: ["W"],
    color_identity: ["W"],
    type_line: "Creature — Human",
    oracle_text: "Pick a Perk — When this creature enters, you gain 2 life.",
    power: "2",
    toughness: "1",
    keywords: ["Pick a Perk"],
    legalities: { commander: "legal" },
    prices: {},
  },
  {
    oracle_id: "o-banned",
    id: "p-banned",
    name: "Golos, Tireless Pilgrim",
    layout: "normal",
    cmc: 5,
    colors: [],
    color_identity: [],
    type_line: "Legendary Artifact Creature — Scout",
    oracle_text: "When this creature enters, you may search your library for a land card.",
    power: "3",
    toughness: "5",
    keywords: [],
    legalities: { commander: "banned" },
    prices: {},
  },
  {
    oracle_id: "o-notlegal",
    id: "p-notlegal",
    name: "Advantageous Proclamation",
    layout: "normal",
    cmc: 0,
    colors: [],
    color_identity: [],
    type_line: "Conspiracy",
    oracle_text: "Hidden agenda",
    keywords: ["Hidden agenda"],
    legalities: { commander: "not_legal" },
    prices: {},
  },
];

let root: string;
let index: CardIndex;
let vocabulary: KeywordVocabulary;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-legal-pool-"));
  const store = new VersionedStore(root);
  const version = "v-census";
  await store.createVersion(version);
  await writeFile(store.filePath(version, "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(
    store.filePath(version, "default_cards.json"),
    JSON.stringify(
      ORACLE.map((c) => ({
        oracle_id: c.oracle_id,
        id: c.id,
        set: "tst",
        set_name: "Test",
        collector_number: "1",
        rarity: "common",
        prices: {},
      })),
    ),
    "utf8",
  );
  await store.publish(version);
  index = CardIndex.open((await buildIndex({ store })).dbPath);
  vocabulary = await loadKeywordVocabulary();
});

afterAll(async () => {
  index.close();
  await rm(root, { recursive: true, force: true });
});

function fixtureCensus(): {
  census: LegalPoolCensus;
  ledger: ReturnType<typeof censusLegalPool>["ledger"];
} {
  return censusLegalPool({
    index,
    snapshot: { version: "v-census", snapshot: "2026-09-11", files: {} },
    rules: null,
    vocabulary,
    baseline: { version: "fixture", records: [] },
    engineRevision: QUALIFIED_EVIDENCE[0]!.engine_revision,
  });
}

describe("ownership table", () => {
  it("assigns every frozen vocabulary entry to exactly one keyword batch", () => {
    const vocabularyNames = [
      ...vocabulary.catalogs.keyword_abilities.data,
      ...vocabulary.catalogs.keyword_actions.data,
      ...vocabulary.catalogs.ability_words.data,
    ];
    const assigned = new Map<string, string[]>();
    for (const batch of KEYWORD_BATCHES) {
      for (const keyword of batch.keywords) {
        const list = assigned.get(keyword.toLowerCase()) ?? [];
        list.push(batch.chunk);
        assigned.set(keyword.toLowerCase(), list);
      }
    }
    const duplicates = [...assigned.entries()].filter(([, chunks]) => chunks.length > 1);
    const missing = vocabularyNames.filter((name) => !assigned.has(name.toLowerCase()));
    const vocabularySet = new Set(vocabularyNames.map((name) => name.toLowerCase()));
    const extra = [...assigned.keys()].filter((name) => !vocabularySet.has(name));
    expect({ duplicates, missing, extra }).toEqual({ duplicates: [], missing: [], extra: [] });
    expect(assigned.size).toBe(new Set(vocabularyNames.map((n) => n.toLowerCase())).size);
  });

  it("names only pending-work chunks and never reuses a family owner as evidence", () => {
    for (const [family, owners] of Object.entries(FAMILY_OWNERS)) {
      for (const owner of owners) expect(owner, family).toMatch(/^(engine|mcp)-[a-z0-9-]+$/);
    }
    expect(ownershipChunks()).toContain(UNLISTED_KEYWORD_CHUNK);
    expect(FAMILY_OWNERS["shape:keyword_line"]).toEqual([]);
  });

  it("pins qualified evidence to the current engine source pin", async () => {
    const pin = JSON.parse(
      await (
        await import("node:fs/promises")
      ).readFile(new URL("../../engine/source.json", import.meta.url), "utf8"),
    ) as { revision: string };
    for (const row of QUALIFIED_EVIDENCE) expect(row.engine_revision).toBe(pin.revision);
    expect(QUALIFIED_EVIDENCE.map((row) => row.name).sort()).toEqual(["Forest", "Island", "Swamp"]);
  });
});

describe("clause shapes", () => {
  it("classifies paragraph openings provisionally and recognizes keyword lines", () => {
    const v = indexVocabulary(vocabulary);
    expect(classifyClause("+1: Draw a card.", v).shape).toBe("loyalty");
    expect(classifyClause("−3: Choose one —", v).shape).toBe("loyalty");
    expect(
      classifyClause("II, III — Creatures you control get +1/+1 until end of turn.", v).shape,
    ).toBe("chapter");
    expect(classifyClause("• Counter target spell.", v).shape).toBe("mode_line");
    expect(classifyClause("Choose one —", v).shape).toBe("modal");
    expect(classifyClause("Whenever a creature dies, draw a card.", v).shape).toBe("triggered");
    expect(classifyClause("{T}: Add {C}{C}.", v).shape).toBe("activated");
    expect(classifyClause("If a creature would die, exile it instead.", v).shape).toBe(
      "replacement",
    );
    expect(classifyClause("(Reminder only.)", v).shape).toBe("reminder");
    expect(classifyClause("Other Elves you control get +1/+1.", v).shape).toBe("static");
    const line = classifyClause(
      "Flying, vigilance, deathtouch, lifelink (Damage dealt by this creature also causes you to gain that much life.)",
      v,
    );
    expect(line.shape).toBe("keyword_line");
    expect(line.keywords.map((k) => k.name)).toEqual([
      "Flying",
      "Vigilance",
      "Deathtouch",
      "Lifelink",
    ]);
    expect(classifyClause("Equip {2}", v).keywords[0]?.name).toBe("Equip");
    expect(classifyClause("Cycling {2} ({2}, Discard this card: Draw a card.)", v).shape).toBe(
      "keyword_line",
    );
    expect(classifyClause("Protection from red and from blue", v).keywords[0]?.name).toBe(
      "Protection",
    );
    expect(classifyClause("Hexproof from black", v).keywords[0]?.name).toBe("Hexproof from");
    expect(classifyClause("Partner with Toothy, Imaginary Friend", v).keywords[0]?.name).toBe(
      "Partner with",
    );
    expect(classifyClause("Flyingly odd sentence.", v).shape).toBe("static");
  });
});

describe("card census rows", () => {
  it("emits the Rust support ids, qualifies only registered intrinsic clauses and owns every row", () => {
    const v = indexVocabulary(vocabulary);
    const forest = censusCard(index.getCard("b34bb2dc-c1af-4d77-b0b3-a0fb342a5fc6")!, v);
    const intrinsic = forest.rows.find((row) => row.id === "intrinsic-basic-mana");
    expect(intrinsic?.status).toBe("qualified");
    expect(forest.rows.filter((row) => row.counted && row.status === "unresolved")).toEqual([]);
    const plains = censusCard(index.getCard("o-plains")!, v);
    expect(plains.rows.find((row) => row.id === "intrinsic-basic-mana")).toMatchObject({
      status: "owned",
      owners: ["engine-mvp-lands"],
    });

    const atraxa = censusCard(index.getCard("o-atraxa")!, v);
    const ids = atraxa.rows.map((row) => row.id);
    expect(ids).toContain("/faces/0/characteristics/oracle_text:0-39");
    expect(ids).toContain("/faces/0/characteristics/name");
    expect(ids).toContain("/characteristics/oracle_text:0-39");
    expect(atraxa.rows.find((row) => row.id === "/characteristics/oracle_text:0-39")?.counted).toBe(
      false,
    );
    const keywordLine = atraxa.rows.find(
      (row) => row.id === "/faces/0/characteristics/oracle_text:0-39",
    );
    expect(keywordLine?.families).toEqual([
      "shape:keyword_line",
      "kw:Flying",
      "kw:Vigilance",
      "kw:Deathtouch",
      "kw:Lifelink",
    ]);
    expect(keywordLine?.owners).toEqual(["engine-any-kw-combat-evasion"]);
    const trigger = atraxa.rows.find((row) => row.start === 40);
    expect(trigger?.families).toEqual(["shape:triggered"]);
    expect(atraxa.rows.find((row) => row.id === "keyword:Proliferate")?.owners).toEqual([
      "engine-any-kw-counters-modifiers",
    ]);
    expect(atraxa.rows.find((row) => row.id === "commander:eligible")?.owners).toEqual([
      "engine-mvp-commander",
    ]);
    expect(
      atraxa.rows.find((row) => row.id === "/faces/0/characteristics/type_line")?.families,
    ).toEqual(["field:type_line", "type:Creature", "type:Legendary"]);
  });

  it("reports missing face inventories, layouts, chapters, loyalty, modes and generated objects", () => {
    const v = indexVocabulary(vocabulary);
    const saga = censusCard(index.getCard("o-saga")!, v);
    expect(saga.faces).toBeNull();
    expect(saga.rows.find((row) => row.id === "faces")).toMatchObject({
      families: ["faces:missing"],
      owners: ["mcp-catalog-face-inventory"],
    });
    expect(saga.rows.find((row) => row.id === "/layout")?.families).toEqual(["layout:saga"]);
    expect(saga.rows.find((row) => row.id === "/face_relationship")?.owners).toEqual([
      "engine-any-layouts-special-actions",
      "mcp-catalog-face-inventory",
    ]);
    expect(saga.rows.find((row) => row.id === "/characteristics/loyalty")?.families).toEqual([
      "field:absent",
    ]);
    // Root rows count when no face inventory exists.
    const chapter = saga.rows.find(
      (row) => row.start !== null && row.families.includes("shape:chapter"),
    );
    expect(chapter?.counted).toBe(true);
    expect(chapter?.owners).toEqual(["engine-any-card-type-lifecycles"]);
    expect(saga.rows.find((row) => row.id === "generated:token-text")?.families).toEqual([
      "generated:token_text_unlinked",
    ]);

    const walker = censusCard(index.getCard("o-walker")!, v);
    const shapes = walker.rows
      .filter((row) => row.start !== null && row.counted)
      .map((row) => row.families[0]);
    expect(shapes).toEqual([
      "shape:loyalty",
      "shape:loyalty",
      "shape:mode_line",
      "shape:mode_line",
      "shape:loyalty",
    ]);
    expect(walker.rows.find((row) => row.id === "generated:emblem-text")).toBeDefined();
    expect(
      walker.rows.find((row) => row.id === "/faces/0/characteristics/loyalty")?.owners,
    ).toEqual(["engine-mvp-planeswalkers"]);

    const tokens = censusCard(index.getCard("o-tokens")!, v);
    expect(
      tokens.rows.find((row) => row.id === "generated:token:skeleton-pirate")?.families,
    ).toEqual(["generated:token"]);
    expect(tokens.rows.find((row) => row.id === "generated:token-text")).toBeUndefined();

    const dfc = censusCard(index.getCard("o-dfc")!, v);
    expect(dfc.faces).toBe(2);
    expect(dfc.rows.filter((row) => row.face_index === 1 && row.start !== null)).toHaveLength(1);
    expect(dfc.rows.find((row) => row.id === "/layout")?.owners).toEqual([
      "engine-any-layouts-special-actions",
    ]);
  });

  it("classifies commander configurations, companions and unlisted vocabulary", () => {
    const v = indexVocabulary(vocabulary);
    const partner = censusCard(index.getCard("o-partner")!, v);
    expect(partner.rows.find((row) => row.id === "commander:partner_with")).toBeDefined();
    expect(partner.rows.find((row) => row.id === "related:combo_piece:toothy")?.families).toEqual([
      "related:combo_piece",
    ]);
    expect(partner.rows.find((row) => row.start === 0)?.families).toEqual(["shape:replacement"]);
    const background = censusCard(index.getCard("o-background")!, v);
    expect(background.rows.find((row) => row.id === "commander:background")).toBeDefined();
    expect(background.rows.find((row) => row.id === "commander:eligible")).toBeUndefined();
    const chooser = censusCard(index.getCard("o-chooser")!, v);
    expect(chooser.rows.find((row) => row.id === "commander:chooses_background")).toBeDefined();
    expect(chooser.rows.find((row) => row.start === 0)?.families).toEqual([
      "shape:keyword_line",
      "kw:Choose a background",
    ]);
    const companion = censusCard(index.getCard("o-companion")!, v);
    expect(companion.rows.find((row) => row.id === "companion")?.families).toEqual([
      "companion:supported",
    ]);
    const perk = censusCard(index.getCard("o-perk")!, v);
    expect(perk.rows.find((row) => row.id === "keyword:Pick a Perk")).toMatchObject({
      families: ["vocab:unlisted"],
      owners: [UNLISTED_KEYWORD_CHUNK],
    });
  });

  it("reproduces the canonical Rust registry source digest for a frozen record", async () => {
    const baseline = await loadEngineBaseline();
    const sage = baseline.records.find((record) => record.name === "Reclamation Sage");
    expect(digestEvaluation(sage?.gameplay)).toBe(
      "067d5222a738327e35d99dd909b939c82512be7c84c5d5e8dd3071b465985b3b",
    );
  });
});

describe("pool census", () => {
  it("counts only legal identities, lists banned ones and leaves no unresolved row", () => {
    const { census, ledger } = fixtureCensus();
    expect(census.snapshot).toMatchObject({
      identities_total: 15,
      legal_identities: 13,
      banned_identities: 1,
      not_legal_identities: 1,
    });
    expect(census.banned).toEqual([{ oracle_id: "o-banned", name: "Golos, Tireless Pilgrim" }]);
    expect(ledger.map((row) => row.oracle_id)).toEqual(
      [...ledger.map((row) => row.oracle_id)].sort(),
    );
    expect(ledger).toHaveLength(13);
    expect(census.ledger).toEqual({ rows: 13, digest: digestEvaluation(ledger) });
    expect(census.totals.by_status.qualified).toBe(1);
    expect(census.totals.by_status.unresolved).toBe(0);
    expect(census.unresolved).toEqual([]);
    expect(census.totals.faceless_identities).toBe(1);
    expect(census.totals.rows_counted + 0).toBeLessThan(census.totals.rows_total);
    expect(census.keywords.unlisted).toEqual([
      { keyword: "Pick a Perk", cards: 1, batch: UNLISTED_KEYWORD_CHUNK },
    ]);
    expect(census.keywords.listed.find((row) => row.keyword === "Hidden agenda")).toBeUndefined();
    expect(census.keywords.vocabulary_unused).toContain("Hidden agenda");
    expect(census.layouts.find((row) => row.layout === "saga")).toEqual({
      layout: "saga",
      cards: 1,
      face_relationship: "unsupported",
      faces_missing: 1,
    });
    expect(census.families.find((f) => f.family === "commander:eligible")?.cards).toBe(4);
    expect(census.owners.every((owner) => owner.rows > 0 && owner.cards > 0)).toBe(true);
    expect(census.families.every((family) => family.samples.length <= 5)).toBe(true);
  });

  it("reports baseline drift explicitly instead of silently re-freezing", () => {
    const { census } = censusLegalPool({
      index,
      snapshot: { version: "v-census", snapshot: "2026-09-11", files: {} },
      rules: null,
      vocabulary,
      baseline: {
        version: "fixture",
        records: [
          { oracle_id: "o-sol", name: "Sol Ring", gameplay: index.getCard("o-sol")!.gameplay },
          { oracle_id: "o-atraxa", name: "Atraxa", gameplay: { version: 1, changed: true } },
          { oracle_id: "o-missing", name: "Missing", gameplay: {} },
        ],
      },
      engineRevision: "x",
    });
    expect(census.baseline).toMatchObject({
      identities: 3,
      unchanged: 1,
      absent: [{ oracle_id: "o-missing", name: "Missing" }],
    });
    expect(census.baseline.changed.map((row) => row.oracle_id)).toEqual(["o-atraxa"]);
  });
});

const dataRoot = await servedDataRoot();
const served = describe.skipIf(dataRoot === null);

served("committed census against the served snapshot", () => {
  it("matches the committed summary and ledger byte for byte", async () => {
    const [generated, committed] = await Promise.all([
      generateLegalPoolReport(dataRoot!),
      readLegalPoolReport(),
    ]);
    expect(generated.census.snapshot.version).toBe(committed.census.snapshot.version);
    expect(encodeLedger(generated.ledger)).toBe(encodeLedger(committed.ledger));
    expect(generated.census).toEqual(committed.census);
    expect(committed.census.totals.by_status.unresolved).toBe(0);
    expect(committed.census.baseline.identities).toBe(77);
  }, 120_000);
});
