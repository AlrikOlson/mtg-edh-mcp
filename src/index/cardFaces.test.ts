import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mapScryfallCard } from "./map.js";
import { oracleTextEvidence } from "../server/index.js";
import { buildIndex, CardIndex } from "./cardIndex.js";
import { VersionedStore } from "../ingest/index.js";
import { parseQuery } from "../query/index.js";

// Pinned synthetic API-contract fixtures, not a current Oracle/rules corpus.
// Deliberately include variable/hybrid/Phyrexian costs and land Adventures;
// do not derive characteristics that Scryfall did not supply.
const fixtures = [
  {
    oracle_id: "normal",
    id: "p-normal",
    name: "Variable Device",
    layout: "normal",
    mana_cost: "{X}{X}",
    cmc: 0,
    type_line: "Artifact Creature — Construct",
    oracle_text: "",
    colors: [],
    color_identity: [],
    keywords: [],
    produced_mana: [],
    power: "0",
    toughness: "0",
  },
  {
    oracle_id: "split",
    id: "p-split",
    name: "Flame // Mist",
    layout: "split",
    mana_cost: "{1}{R} // {U}",
    cmc: 3,
    type_line: "Instant // Instant",
    colors: ["R", "U"],
    keywords: ["Fuse"],
    card_faces: [
      {
        name: "Flame",
        mana_cost: "{1}{R}",
        type_line: "Instant",
        oracle_text: "Deal 2 damage.",
        colors: ["R"],
      },
      {
        name: "Mist",
        mana_cost: "{U}",
        type_line: "Instant",
        oracle_text: "Draw a card.",
        colors: ["U"],
      },
    ],
  },
  {
    oracle_id: "adventure",
    id: "p-adventure",
    name: "Harbor // Journey",
    layout: "adventure",
    cmc: 0,
    type_line: "Land // Sorcery — Adventure",
    produced_mana: ["U"],
    keywords: [],
    card_faces: [
      {
        name: "Harbor",
        mana_cost: "",
        type_line: "Land",
        oracle_text: "{T}: Add {U}.",
        colors: [],
      },
      {
        name: "Journey",
        mana_cost: "{5}{U}",
        type_line: "Sorcery — Adventure",
        oracle_text: "Draw three cards.",
        colors: ["U"],
      },
    ],
  },
  {
    oracle_id: "modal",
    id: "p-modal",
    name: "Scholar // Shore",
    layout: "modal_dfc",
    cmc: 3,
    keywords: [],
    produced_mana: ["U"],
    card_faces: [
      {
        name: "Scholar",
        mana_cost: "{1}{U/P}{U/P}",
        type_line: "Creature — Wizard",
        oracle_text: "Whenever you draw, scry 1.",
        colors: ["U"],
        power: "*",
        toughness: "1+*",
      },
      {
        name: "Shore",
        mana_cost: "",
        type_line: "Land",
        oracle_text: "{T}: Add {U}.",
        colors: [],
      },
    ],
  },
  {
    oracle_id: "transform",
    id: "p-transform",
    name: "Defender // Awakened",
    layout: "transform",
    cmc: 4,
    keywords: ["Transform"],
    card_faces: [
      {
        name: "Defender",
        mana_cost: "{2}{W/U}{W/U}",
        type_line: "Battle — Siege",
        oracle_text: "When this enters, draw a card.",
        colors: ["W", "U"],
        defense: "4",
      },
      {
        name: "Awakened",
        mana_cost: "",
        type_line: "Planeswalker",
        oracle_text: "+1: Draw a card.\n−2: Add {C}{C}.",
        color_indicator: ["U"],
        colors: ["U"],
        loyalty: "3",
        printed_name: "Awakened",
        printed_text: "+1: Draw a card.",
        printed_type_line: "Planeswalker",
      },
    ],
  },
  {
    oracle_id: "meld",
    id: "p-meld-front",
    name: "Meld Component",
    layout: "meld",
    cmc: 3,
    mana_cost: "{1}{G}{G}",
    colors: ["G"],
    type_line: "Legendary Creature — Human",
    oracle_text: "Meld this with its partner.",
    power: "3",
    toughness: "3",
    keywords: ["Meld"],
    all_parts: [
      {
        id: "p-meld-front",
        component: "meld_part",
        name: "Meld Component",
        type_line: "Legendary Creature — Human",
        uri: "https://api.scryfall.com/cards/p-meld-front",
      },
      {
        id: "p-meld-partner",
        component: "meld_part",
        name: "Meld Partner",
        type_line: "Artifact",
        uri: "https://api.scryfall.com/cards/p-meld-partner",
      },
      {
        id: "p-meld-result",
        component: "meld_result",
        name: "Meld Result",
        type_line: "Legendary Creature",
        uri: "https://api.scryfall.com/cards/p-meld-result",
      },
    ],
  },
];

let root: string | undefined;
let index: CardIndex | undefined;
afterEach(async () => {
  index?.close();
  index = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});

describe("canonical source gameplay", () => {
  it("preserves supplied facts through streamed ingestion, SQLite, and canonical lookup", async () => {
    root = await mkdtemp(path.join(tmpdir(), "mtg-faces-"));
    const store = new VersionedStore(root);
    await store.createVersion("pinned-faces-v1");
    await writeFile(
      store.filePath("pinned-faces-v1", "oracle_cards.json"),
      JSON.stringify(fixtures),
    );
    await writeFile(
      store.filePath("pinned-faces-v1", "default_cards.json"),
      JSON.stringify(fixtures),
    );
    const built = await buildIndex({ store, version: "pinned-faces-v1" });
    index = CardIndex.open(built.dbPath);
    expect(index.count()).toBe(6); // face and meld links never synthesize canonical rows
    for (const raw of fixtures) {
      const card = index.getCard(raw.oracle_id);
      const gameplay = card?.gameplay;
      expect(gameplay?.layout).toBe(raw.layout);
      expect(gameplay?.source).toEqual({
        oracle_id: raw.oracle_id,
        scryfall_id: raw.id,
      });
      expect(gameplay?.playability).toBe("not_evaluated");
      expect(gameplay?.characteristics.mana_cost).toBe(raw.mana_cost ?? null);
      expect(gameplay?.characteristics.cmc).toBe(raw.cmc);
      expect(gameplay?.characteristics.keywords).toEqual(raw.keywords);
      expect(gameplay?.characteristics.produced_mana).toEqual(raw.produced_mana ?? null);
      const supplied = raw.card_faces ?? [raw];
      expect(gameplay?.faces).toHaveLength(supplied.length);
      for (const [i, face] of supplied.entries()) {
        const mapped = gameplay?.faces?.[i];
        expect(mapped?.face_index).toBe(i);
        expect(mapped?.source_path).toBe(raw.card_faces ? `/card_faces/${i}` : "");
        for (const key of [
          "name",
          "mana_cost",
          "type_line",
          "oracle_text",
          "colors",
          "power",
          "toughness",
          "loyalty",
          "defense",
          "cmc",
          "color_indicator",
          "printed_name",
          "printed_text",
          "printed_type_line",
        ] as const) {
          expect(mapped?.characteristics[key]).toEqual(
            key in face ? face[key as keyof typeof face] : null,
          );
        }
      }
      expect(card?.printings).toHaveLength(1);
    }
    expect(index.getCard("meld")?.gameplay?.related_cards).toEqual(fixtures[5]?.all_parts);
    expect(index.getCard("modal")?.gameplay?.face_relationship).toBe("modal");
    expect(index.getCard("transform")?.gameplay?.face_relationship).toBe("transform");
    expect(index.getCard("meld")?.gameplay?.face_relationship).toBe("meld");
    expect(index.getCard("split")?.gameplay?.face_relationship).toBe("split");
    expect(index.getCard("adventure")?.gameplay?.face_relationship).toBe("adventure");
    const query = index.evaluate(parseQuery("o:draw"));
    expect(query.total).toBe(4);
    expect(new Set(query.results.map((card) => card.oracle_id)).size).toBe(query.total);
    expect(index.resolveName("Shore")).toHaveLength(1);
    expect(index.getCard("modal")?.mana_cost).toBe("{1}{U/P}{U/P} // ");
    expect(index.getCard("modal")?.oracle_text).toBe(
      "Whenever you draw, scry 1.\n//\n{T}: Add {U}.",
    );
  });

  it("distinguishes absent from known empty facts without distributing parent facts", () => {
    // The pinned array above contains normal at 0 and modal at 3.
    const normal = mapScryfallCard(fixtures[0]!);
    expect(normal.gameplay?.color_identity).toEqual([]);
    expect(normal.gameplay?.characteristics).toMatchObject({
      mana_cost: "{X}{X}",
      cmc: 0,
      oracle_text: "",
      colors: [],
      keywords: [],
      produced_mana: [],
      loyalty: null,
    });
    // Position 3 is the pinned modal fixture.
    const modal = mapScryfallCard(fixtures[3]!);
    expect(modal.gameplay?.characteristics.produced_mana).toEqual(["U"]);
    expect(modal.gameplay?.faces?.[1]?.characteristics).toMatchObject({
      mana_cost: "",
      cmc: null,
      produced_mana: null,
      keywords: null,
      colors: [],
    });
    const missing = mapScryfallCard({ name: "Missing", oracle_id: "missing" });
    expect(missing.gameplay).toMatchObject({
      layout: null,
      face_relationship: "unknown",
      faces: null,
    });
    expect(missing.gameplay?.color_identity).toBeNull();
    expect(missing.gameplay?.characteristics).toMatchObject({
      mana_cost: null,
      cmc: null,
      oracle_text: null,
      colors: null,
      keywords: null,
    });
  });

  it("retains unknown layouts, empty faces, independent face oracle IDs and supplied face metadata", () => {
    const raw = {
      name: "Unknown",
      oracle_id: "unknown",
      layout: "future_layout",
      card_faces: [
        {
          name: "First",
          oracle_id: "first-oracle",
          cmc: 2,
          mana_cost: "{2}",
          produced_mana: ["S", "C"],
          keywords: [],
        },
      ],
    };
    const mapped = mapScryfallCard(raw);
    expect(mapped.gameplay).toMatchObject({
      layout: "future_layout",
      face_relationship: "unsupported",
      playability: "not_evaluated",
    });
    expect(mapped.gameplay?.faces?.[0]).toMatchObject({
      oracle_id: "first-oracle",
      characteristics: { cmc: 2, produced_mana: ["S", "C"], keywords: [] },
    });
    expect(mapScryfallCard({ ...raw, card_faces: [] }).gameplay?.faces).toEqual([]);
  });
});
describe("Oracle source spans", () => {
  it("addresses an exact face substring without the joined display separator", () => {
    const card = mapScryfallCard({
      name: "Front // Back",
      oracle_id: "o",
      id: "p",
      layout: "modal_dfc",
      card_faces: [
        { name: "Front", oracle_text: "First face." },
        {
          name: "Back",
          oracle_text: "🧙\n{T}: Add {C}.",
          oracle_id: "back-id",
        },
      ],
    });
    expect(oracleTextEvidence(card, 1, 3, 16)).toEqual({
      oracle_id: "o",
      scryfall_id: "p",
      source_oracle_id: "back-id",
      face_index: 1,
      field_path: "/card_faces/1/oracle_text",
      offset_unit: "utf16_code_units",
      start: 3,
      end: 16,
      text: "{T}: Add {C}.",
    });
    expect(oracleTextEvidence(card, 1)?.text).toBe("🧙\n{T}: Add {C}.");
    expect(oracleTextEvidence(card, null)).toBeNull(); // no supplied root text
    expect(oracleTextEvidence(card, 2)).toBeNull();
    expect(oracleTextEvidence(card, -1)).toBeNull();
    expect(oracleTextEvidence(card, 0.5)).toBeNull();
    for (const [start, end] of [
      [-1, 1],
      [2, 1],
      [0, 100],
      [NaN, 1],
      [0.5, 1],
      [0, Infinity],
    ]) {
      expect(oracleTextEvidence(card, 1, start, end)).toBeNull();
    }
  });

  it("distinguishes empty source text from missing text and preserves root scope", () => {
    const card = mapScryfallCard({
      name: "Vanilla",
      oracle_id: "v",
      layout: "normal",
      oracle_text: "",
    });
    expect(oracleTextEvidence(card, 0)).toMatchObject({
      field_path: "/oracle_text",
      start: 0,
      end: 0,
      text: "",
    });
    expect(oracleTextEvidence(card, null)).toMatchObject({
      face_index: null,
      field_path: "/oracle_text",
      text: "",
    });
    expect(
      oracleTextEvidence(mapScryfallCard({ name: "Missing", layout: "normal" }), 0),
    ).toBeNull();
    expect(oracleTextEvidence({ ...card, gameplay: null }, 0)).toBeNull();
  });

  it("keeps explicit nulls absent and detaches arrays from mutable raw input", () => {
    const raw = {
      name: "Nullable",
      layout: "normal",
      mana_cost: null,
      colors: ["U"],
      card_faces: null,
      oracle_text: null,
      keywords: null,
      produced_mana: null,
      power: null,
    };
    const card = mapScryfallCard(raw);
    raw.colors.push("R");
    expect(card.gameplay?.characteristics).toMatchObject({
      mana_cost: null,
      colors: ["U"],
      oracle_text: null,
      keywords: null,
      produced_mana: null,
    });
    expect(card.mana_cost).toBe("");
    expect(card.oracle_text).toBe("");
  });
});
