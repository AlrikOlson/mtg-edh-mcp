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

let root: string;
let index: CardIndex;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-eval-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
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
