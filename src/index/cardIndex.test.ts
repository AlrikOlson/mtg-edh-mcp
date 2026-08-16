import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "./cardIndex.js";
import { SECONDARY_INDEXES } from "./schema.js";
import { parseQuery } from "../query/index.js";

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
    game_changer: true,
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

describe("CardIndex.evaluate — owned-collection allow-set (bl-collection)", () => {
  it("restricts results to the allow-set, keeping total/returned exact", () => {
    const node = parseQuery("t:creature"); // o-atraxa + o-dfc
    expect(index.evaluate(node).total).toBe(2);

    const owned = index.evaluate(node, { oracleIds: ["o-atraxa"] });
    expect(owned.total).toBe(1);
    expect(owned.returned).toBe(1);
    expect(owned.results[0]?.oracle_id).toBe("o-atraxa");
  });

  it("an empty/absent allow-set is a no-op (identical to no filter)", () => {
    const node = parseQuery("t:creature");
    expect(index.evaluate(node, { oracleIds: [] }).total).toBe(2);
  });

  it("treats allow-set ids as bound data, not SQL — an injection string matches nothing and is harmless", () => {
    const node = parseQuery("t:creature");
    const evil = "o-atraxa'); DROP TABLE cards;--";
    const res = index.evaluate(node, { oracleIds: [evil] });
    expect(res.total).toBe(0);
    expect(res.results).toEqual([]);
    // The table is intact: a normal query still works afterward.
    expect(index.evaluate(node).total).toBe(2);
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

describe("CardIndex.gameChangerNames", () => {
  it("returns the snapshot's Game Changers name set", () => {
    expect(index.gameChangerNames()).toEqual(new Set(["Sol Ring"]));
  });

  it("returns null (fallback signal) when the index carries no flags", async () => {
    // Rebuild from a fixture without any game_changer flags.
    const r2 = await mkdtemp(path.join(tmpdir(), "mtg-nogc-"));
    try {
      const s = new VersionedStore(r2);
      await s.createVersion("v1");
      const noFlags = ORACLE.map((card) => {
        const { game_changer, ...rest } = card as { game_changer?: boolean };
        void game_changer;
        return rest;
      });
      await writeFile(s.filePath("v1", "oracle_cards.json"), JSON.stringify(noFlags), "utf8");
      await writeFile(s.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
      await s.publish("v1");
      const plain = CardIndex.open((await buildIndex({ store: s })).dbPath);
      expect(plain.gameChangerNames()).toBeNull();
      plain.close();
    } finally {
      await rm(r2, { recursive: true, force: true });
    }
  });
});

describe("CardIndex.reopen (hot-swap)", () => {
  it("re-binds the SAME instance onto a freshly built index", async () => {
    // Build a second version with an extra card, as a bulk refresh would.
    const version = "v-next";
    await store.createVersion(version);
    const extra = [
      ...ORACLE,
      {
        oracle_id: "o-new",
        name: "Brand New Legend",
        cmc: 3,
        colors: ["U"],
        color_identity: ["U"],
        type_line: "Legendary Creature — Wizard",
        oracle_text: "Flash.",
        legalities: { commander: "legal" },
        prices: {},
      },
    ];
    await writeFile(store.filePath(version, "oracle_cards.json"), JSON.stringify(extra), "utf8");
    await writeFile(store.filePath(version, "default_cards.json"), JSON.stringify([]), "utf8");
    await store.publish(version);
    const built = await buildIndex({ store, version });

    expect(index.getCard("o-new")).toBeNull(); // old data before the swap
    index.reopen(built.dbPath);
    expect(index.getCard("o-new")?.name).toBe("Brand New Legend"); // new data after
    expect(index.getCard("o-sol")?.name).toBe("Sol Ring"); // old cards still resolve
    expect(index.count()).toBe(4);
  });
});

describe("CardIndex.resolveName — token disambiguation (review #6)", () => {
  let r2: string;
  let tokenIndex: CardIndex;
  const ORACLE2 = [
    {
      oracle_id: "o-llan",
      name: "Llanowar Elves",
      cmc: 1,
      color_identity: ["G"],
      type_line: "Creature — Elf Druid",
      oracle_text: "{T}: Add {G}.",
      legalities: { commander: "legal" },
      prices: {},
    },
    {
      oracle_id: "o-llan-tok",
      name: "Llanowar Elves",
      cmc: 0,
      color_identity: ["G"],
      type_line: "Token Creature — Elf Druid",
      oracle_text: "{T}: Add {G}.",
      legalities: {},
      prices: {},
    },
    {
      oracle_id: "o-treasure-tok",
      name: "Treasure",
      cmc: 0,
      color_identity: [],
      type_line: "Token Artifact — Treasure",
      oracle_text: "{T}, Sacrifice: Add one mana.",
      legalities: {},
      prices: {},
    },
    {
      oracle_id: "o-gm1",
      name: "Goblin Matron",
      cmc: 2,
      color_identity: ["R"],
      type_line: "Creature — Goblin",
      oracle_text: "Search for a Goblin.",
      legalities: { commander: "legal" },
      prices: {},
    },
    {
      oracle_id: "o-gm2",
      name: "Goblin Matriarch",
      cmc: 5,
      color_identity: ["R"],
      type_line: "Creature — Goblin",
      oracle_text: "Make Goblins.",
      legalities: { commander: "legal" },
      prices: {},
    },
  ];

  beforeEach(async () => {
    r2 = await mkdtemp(path.join(tmpdir(), "mtg-tok-"));
    const s = new VersionedStore(r2);
    await s.createVersion("v1");
    await writeFile(s.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE2), "utf8");
    await writeFile(s.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
    await s.publish("v1");
    tokenIndex = CardIndex.open((await buildIndex({ store: s })).dbPath);
  });
  afterEach(async () => {
    tokenIndex.close();
    await rm(r2, { recursive: true, force: true });
  });

  it("prefers the real card over a token sharing the name", () => {
    const refs = tokenIndex.resolveName("Llanowar Elves");
    expect(refs).toHaveLength(1);
    expect(refs[0]?.oracle_id).toBe("o-llan");
    expect(refs[0]?.type).toBe("Creature — Elf Druid");
  });

  it("falls back to the token when no real card shares the name", () => {
    const refs = tokenIndex.resolveName("Treasure");
    expect(refs).toHaveLength(1);
    expect(refs[0]?.oracle_id).toBe("o-treasure-tok");
  });

  it("still returns multiple candidates for genuinely ambiguous REAL cards", () => {
    const refs = tokenIndex.resolveName("Goblin Mat"); // fuzzy: two real Goblin cards
    expect(refs.map((r) => r.oracle_id).sort()).toEqual(["o-gm1", "o-gm2"]);
  });
});
