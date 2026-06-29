import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "./cardIndex.js";
import { SECONDARY_INDEXES } from "./schema.js";

const ORACLE = [
  {
    oracle_id: "o-sol",
    id: "p-sol-1",
    name: "Sol Ring",
    cmc: 1,
    colors: [],
    color_identity: [],
    type_line: "Artifact",
    oracle_text: "{T}: Add {C}{C}.",
    keywords: [],
    legalities: { commander: "legal" },
    prices: { usd: "1.50" },
  },
  {
    oracle_id: "o-atraxa",
    name: "Atraxa, Praetors' Voice",
    cmc: 4,
    colors: ["W", "U", "B", "G"],
    color_identity: ["W", "U", "B", "G"],
    type_line: "Legendary Creature — Phyrexian Angel Horror",
    oracle_text: "Flying, vigilance, deathtouch, lifelink.",
    keywords: ["Flying"],
    legalities: { commander: "legal" },
    prices: { usd: "10.00" },
  },
  {
    // Double-faced card: text lives in card_faces[].
    oracle_id: "o-dfc",
    name: "Goblin Frontier // Frontier Land",
    cmc: 2,
    colors: ["R"],
    color_identity: ["R"],
    legalities: { commander: "legal" },
    prices: {},
    card_faces: [
      {
        name: "Goblin Frontier",
        mana_cost: "{1}{R}",
        type_line: "Creature — Goblin",
        oracle_text: "Haste.",
      },
      { name: "Frontier Land", mana_cost: "", type_line: "Land", oracle_text: "{T}: Add {R}." },
    ],
  },
];

const DEFAULT = [
  {
    oracle_id: "o-sol",
    id: "p-sol-1",
    set: "cmm",
    set_name: "Commander Masters",
    collector_number: "447",
    rarity: "uncommon",
    prices: { usd: "1.50" },
    released_at: "2023-08-04",
  },
  {
    oracle_id: "o-sol",
    id: "p-sol-2",
    set: "c21",
    set_name: "Commander 2021",
    collector_number: "1",
    rarity: "uncommon",
    prices: { usd: "2.00" },
    released_at: "2021-04-23",
  },
  {
    oracle_id: "o-atraxa",
    id: "p-atr-1",
    set: "cmm",
    set_name: "Commander Masters",
    collector_number: "1",
    rarity: "mythic",
    prices: { usd: "10.00" },
    released_at: "2023-08-04",
  },
  { id: "p-token-no-oracle", name: "Goblin Token" },
];

let root: string;
let store: VersionedStore;
let index: CardIndex;
let dbPath: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-index-"));
  store = new VersionedStore(root);
  const version = "v-test";
  await store.createVersion(version);
  await writeFile(store.filePath(version, "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath(version, "default_cards.json"), JSON.stringify(DEFAULT), "utf8");
  await store.publish(version);

  const result = await buildIndex({ store });
  dbPath = result.dbPath;
  expect(result.cards).toBe(3);
  expect(result.printings).toBe(3); // token without oracle_id skipped
  index = CardIndex.open(dbPath);
});

afterEach(async () => {
  index.close();
  await rm(root, { recursive: true, force: true });
});

describe("CardIndex.getCard", () => {
  it("returns the full Card with joined printings, newest first", () => {
    const card = index.getCard("o-sol");
    expect(card?.name).toBe("Sol Ring");
    expect(card?.mv).toBe(1);
    expect(card?.is_commander_eligible).toBe(false);
    expect(card?.legalities.commander).toBe("legal");
    expect(card?.printings.map((p) => p.set)).toEqual(["cmm", "c21"]);
    expect(card?.printings[0]?.prices.usd).toBe("1.50");
  });

  it("flags a legendary creature as commander-eligible", () => {
    expect(index.getCard("o-atraxa")?.is_commander_eligible).toBe(true);
  });

  it("flattens double-faced card text from card_faces", () => {
    const dfc = index.getCard("o-dfc");
    expect(dfc?.type_line).toBe("Creature — Goblin // Land");
    expect(dfc?.oracle_text).toBe("Haste.\n//\n{T}: Add {R}.");
    expect(dfc?.mana_cost).toBe("{1}{R} // ");
  });

  it("returns null for an unknown oracle_id", () => {
    expect(index.getCard("nope")).toBeNull();
  });
});

describe("CardIndex.searchByName (FTS)", () => {
  it("finds a card by a name token and projects to a CardRef", () => {
    const refs = index.searchByName("Sol");
    expect(refs).toHaveLength(1);
    expect(refs[0]?.oracle_id).toBe("o-sol");
    expect(refs[0]?.ci).toEqual(["C"]); // colorless sentinel
  });

  it("matches oracle text and sorts color identity into WUBRG order", () => {
    const refs = index.searchByName("vigilance");
    expect(refs[0]?.oracle_id).toBe("o-atraxa");
    expect(refs[0]?.ci).toEqual(["W", "U", "B", "G"]);
  });
});

describe("index schema", () => {
  it("creates the secondary indexes for ci/mv/type/legalities", () => {
    const probe = new Database(dbPath, { readonly: true });
    const names = (
      probe.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    probe.close();
    for (const expected of SECONDARY_INDEXES) {
      expect(names).toContain(expected);
    }
  });
});
