import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { VersionedStore } from "../ingest/index.js";
import { parseQuery } from "../query/index.js";
import { buildIndex, CardIndex } from "./cardIndex.js";

const ORACLE = [
  {
    oracle_id: "o-sol",
    id: "p-sol",
    name: "Sol Ring",
    cmc: 1,
    colors: [],
    color_identity: [],
    type_line: "Artifact",
    oracle_text: "{T}: Add {C}{C}.",
    legalities: { commander: "legal" },
    prices: { usd: "1.50" },
    game_changer: true,
  },
  {
    oracle_id: "o-llan",
    id: "p-llan",
    name: "Llanowar Elves",
    cmc: 1,
    colors: ["G"],
    color_identity: ["G"],
    type_line: "Creature — Elf Druid",
    oracle_text: "{T}: Add {G}.",
    power: "1",
    toughness: "1",
    legalities: { commander: "legal" },
    prices: { usd: "0.25" },
  },
  {
    oracle_id: "o-atra",
    id: "p-atra",
    name: "Atraxa, Praetors' Voice",
    cmc: 4,
    colors: ["W", "U", "B", "G"],
    color_identity: ["W", "U", "B", "G"],
    type_line: "Legendary Creature — Phyrexian Angel Horror",
    oracle_text: "Flying, vigilance, deathtouch, lifelink. Proliferate.",
    power: "4",
    toughness: "4",
    keywords: ["Flying"],
    legalities: { commander: "legal" },
    prices: { usd: "10.00" },
  },
  {
    oracle_id: "o-bolt",
    id: "p-bolt",
    name: "Lightning Bolt",
    cmc: 1,
    colors: ["R"],
    color_identity: ["R"],
    type_line: "Instant",
    oracle_text: "Lightning Bolt deals 3 damage to any target.",
    legalities: { commander: "legal" },
    prices: { usd: "2.00" },
  },
  {
    oracle_id: "o-cult",
    id: "p-cult",
    name: "Cultivate",
    cmc: 3,
    colors: ["G"],
    color_identity: ["G"],
    type_line: "Sorcery",
    oracle_text: "Search your library for basic lands; draw nothing.",
    legalities: { commander: "legal" },
    prices: { usd: "0.50" },
  },
];

/** Printings for the printing-level predicates (set:/rarity:/year, order:released). */
const DEFAULT = [
  {
    oracle_id: "o-sol",
    id: "p-sol-lea",
    name: "Sol Ring",
    set: "lea",
    set_name: "Limited Edition Alpha",
    rarity: "uncommon",
    released_at: "1993-08-05",
    prices: { usd: "5000.00" },
  },
  {
    oracle_id: "o-sol",
    id: "p-sol-cmm",
    name: "Sol Ring",
    set: "cmm",
    set_name: "Commander Masters",
    rarity: "uncommon",
    released_at: "2023-08-04",
    prices: { usd: "1.50" },
  },
  {
    oracle_id: "o-llan",
    id: "p-llan-m10",
    name: "Llanowar Elves",
    set: "m10",
    set_name: "Magic 2010",
    rarity: "common",
    released_at: "2009-07-17",
    prices: { usd: "0.25" },
  },
  {
    oracle_id: "o-atra",
    id: "p-atra-c16",
    name: "Atraxa, Praetors' Voice",
    set: "c16",
    set_name: "Commander 2016",
    rarity: "mythic",
    released_at: "2016-11-11",
    prices: { usd: "10.00" },
  },
];

let root: string;
let index: CardIndex;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-eval-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify(DEFAULT), "utf8");
  await store.publish("v1");
  const built = await buildIndex({ store });
  index = CardIndex.open(built.dbPath);
});
afterEach(async () => {
  index.close();
  await rm(root, { recursive: true, force: true });
});

/** Evaluate a query string and return the matched oracle_ids as a sorted set. */
function ids(query: string, opts = {}): string[] {
  return index
    .evaluate(parseQuery(query), opts)
    .results.map((r) => r.oracle_id)
    .sort();
}

describe("query evaluation — predicate families", () => {
  it("type filter", () => {
    expect(ids("t:creature")).toEqual(["o-atra", "o-llan"]);
  });

  it("numeric mv and pow", () => {
    expect(ids("mv<=1")).toEqual(["o-bolt", "o-llan", "o-sol"]);
    expect(ids("pow>=4")).toEqual(["o-atra"]);
  });

  it("color identity subset (id<=g) includes colorless and mono-green", () => {
    expect(ids("id<=g")).toEqual(["o-cult", "o-llan", "o-sol"]);
  });

  it("color identity superset (id>=wubg)", () => {
    expect(ids("id>=wubg")).toEqual(["o-atra"]);
  });

  it("oracle text via FTS", () => {
    expect(ids("o:draw")).toEqual(["o-cult"]);
  });

  it("is:commander", () => {
    expect(ids("is:commander")).toEqual(["o-atra"]);
  });

  it("inline regex over oracle text", () => {
    expect(ids("o:/Add \\{[CG]\\}/")).toEqual(["o-llan", "o-sol"]);
  });

  it("is:gamechanger reads the indexed flag", () => {
    expect(ids("is:gamechanger")).toEqual(["o-sol"]);
  });
});

describe("query evaluation — printing-level predicates", () => {
  it("set: matches by code (any printing) and by full set name", () => {
    expect(ids("set:cmm")).toEqual(["o-sol"]);
    expect(ids("set:LEA")).toEqual(["o-sol"]); // case-insensitive code
    expect(ids('set:"Commander 2016"')).toEqual(["o-atra"]);
    expect(ids("e:m10")).toEqual(["o-llan"]); // e: alias
  });

  it("rarity: accepts the word and the Scryfall letter", () => {
    expect(ids("rarity:mythic")).toEqual(["o-atra"]);
    expect(ids("r:c")).toEqual(["o-llan"]);
    expect(ids("r:u")).toEqual(["o-sol"]);
  });

  it("year compares against any printing's release year", () => {
    expect(ids("year<=1994")).toEqual(["o-sol"]); // Alpha printing
    expect(ids("year=2009")).toEqual(["o-llan"]);
  });

  it("ANDed printing predicates must hit a SINGLE printing (merged EXISTS)", () => {
    // Sol Ring has 1993 and 2023 printings but none inside [2016, 2020]:
    // separate EXISTS per predicate would wrongly match it via different rows.
    expect(ids("year>=2016 year<=2020")).toEqual(["o-atra"]);
    expect(ids("set:cmm r:u")).toEqual(["o-sol"]);
    expect(ids("set:lea year>=2016")).toEqual([]); // Alpha printing is 1993
  });

  it("cards with no printings never match a printing-level predicate", () => {
    expect(ids("set:lea or set:m10 or set:c16 or set:cmm")).toEqual(["o-atra", "o-llan", "o-sol"]);
    expect(ids("year>=1900")).toEqual(["o-atra", "o-llan", "o-sol"]); // bolt/cult excluded
  });

  it("order:released sorts by first-printing date, oldest first", () => {
    const res = index.evaluate(parseQuery("set:lea or set:m10 or set:c16"), { order: "released" });
    expect(res.results.map((r) => r.oracle_id)).toEqual(["o-sol", "o-llan", "o-atra"]);
  });
});

describe("query evaluation — boolean structure", () => {
  it("implicit AND", () => {
    expect(ids("t:creature mv>=4")).toEqual(["o-atra"]);
  });

  it("OR", () => {
    expect(ids("t:instant or t:sorcery")).toEqual(["o-bolt", "o-cult"]);
  });

  it("negation", () => {
    // creatures NOT within mono-green identity → only Atraxa
    expect(ids("t:creature -id<=g")).toEqual(["o-atra"]);
  });
});

describe("query evaluation — ordering, totals, pagination", () => {
  it("orders by mv ascending with Atraxa (mv 4) last", () => {
    const res = index.evaluate(parseQuery("mv>=0"), { order: "mv" });
    expect(res.total).toBe(5);
    expect(res.results[res.results.length - 1]?.oracle_id).toBe("o-atra");
  });

  it("paginates with opaque, stable cursors", () => {
    const page1 = index.evaluate(parseQuery("mv>=0"), { limit: 2, order: "name" });
    expect(page1.total).toBe(5);
    expect(page1.returned).toBe(2);
    expect(page1.nextCursor).toBeTypeOf("string");

    const page2 = index.evaluate(parseQuery("mv>=0"), {
      limit: 2,
      order: "name",
      cursor: page1.nextCursor,
    });
    const page3 = index.evaluate(parseQuery("mv>=0"), {
      limit: 2,
      order: "name",
      cursor: page2.nextCursor,
    });
    expect(page3.returned).toBe(1);
    expect(page3.nextCursor).toBeUndefined();

    // All five distinct, in name order across pages.
    const all = [...page1.results, ...page2.results, ...page3.results].map((r) => r.name);
    expect(all).toEqual([...all].sort((a, b) => a.localeCompare(b)));
    expect(new Set(all).size).toBe(5);
  });

  it("is deterministic: identical query yields identical order", () => {
    const a = index
      .evaluate(parseQuery("mv>=0"), { order: "name" })
      .results.map((r) => r.oracle_id);
    const b = index
      .evaluate(parseQuery("mv>=0"), { order: "name" })
      .results.map((r) => r.oracle_id);
    expect(a).toEqual(b);
  });

  it("malformed cursor → INVALID_QUERY", () => {
    expect(() => index.evaluate(parseQuery("mv>=0"), { cursor: "!!!notbase64json" })).toThrowError(
      expect.objectContaining({ code: "INVALID_QUERY" }),
    );
  });
});
