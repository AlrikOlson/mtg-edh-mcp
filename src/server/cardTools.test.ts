import { describe, it, expect, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { createServer } from "./createServer.js";
import { staticSnapshotProvider } from "./snapshot.js";

const SNAPSHOT = "2026-06-27";

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
    oracle_id: "o-llanv",
    id: "p-llanv",
    name: "Llanowar Visionary",
    cmc: 3,
    colors: ["G"],
    color_identity: ["G"],
    type_line: "Creature — Elf Druid",
    oracle_text: "Ramp and draw.",
    power: "2",
    toughness: "2",
    legalities: { commander: "legal" },
    prices: { usd: "0.15" },
  },
  {
    oracle_id: "o-atra",
    id: "p-atra",
    name: "Atraxa, Praetors' Voice",
    cmc: 4,
    colors: ["W", "U", "B", "G"],
    color_identity: ["W", "U", "B", "G"],
    type_line: "Legendary Creature — Phyrexian Angel Horror",
    oracle_text: "Flying. Proliferate.",
    power: "4",
    toughness: "4",
    legalities: { commander: "legal" },
    prices: { usd: "10.00" },
  },
];

const DEFAULT = [
  {
    oracle_id: "o-sol",
    id: "p-sol-cmm",
    set: "cmm",
    set_name: "Commander Masters",
    collector_number: "447",
    rarity: "uncommon",
    prices: { usd: "1.50" },
    released_at: "2023-08-04",
  },
  {
    oracle_id: "o-sol",
    id: "p-sol-c21",
    set: "c21",
    set_name: "Commander 2021",
    collector_number: "1",
    rarity: "uncommon",
    prices: { usd: "2.00" },
    released_at: "2021-04-23",
  },
];

let root: string;
let index: CardIndex;
let client: Client;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-cardtools-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify(DEFAULT), "utf8");
  await store.publish("v1");
  const built = await buildIndex({ store });
  index = CardIndex.open(built.dbPath);

  const server = createServer({
    index,
    snapshot: staticSnapshotProvider(SNAPSHOT),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
});
afterEach(async () => {
  await client.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

describe("card tools registration", () => {
  it("registers the four card tools + card_mechanics + card_rulings + collection, data, rules tools + ping", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "card_get",
      "card_mechanics",
      "card_printings",
      "card_resolve_name",
      "card_rulings",
      "card_search",
      "collection_add",
      "collection_clear",
      "collection_get",
      "collection_set",
      "data_ingest",
      "data_status",
      "ping",
      "rules_lookup",
      "rules_refresh",
      "rules_search",
    ]);
  });
});

describe("card_search", () => {
  it("accepts ci identity subsets with the same indexed results as id", async () => {
    const canonical = await client.callTool({
      name: "card_search",
      arguments: { query: "id<=g" },
    });
    const alias = await client.callTool({
      name: "card_search",
      arguments: { query: "ci<=g" },
    });
    expect(alias.isError).not.toBe(true);
    expect(alias.structuredContent).toEqual(canonical.structuredContent);
    const body = alias.structuredContent as { results: Array<{ oracle_id: string }> };
    expect(body.results.map((card) => card.oracle_id).sort()).toEqual([
      "o-llan",
      "o-llanv",
      "o-sol",
    ]);
  });

  it("returns CardRefs with totals and a stamped data_snapshot", async () => {
    const res = await client.callTool({
      name: "card_search",
      arguments: { query: "t:creature" },
    });
    const sc = res.structuredContent as {
      total: number;
      returned: number;
      results: Array<{ oracle_id: string }>;
      data_snapshot: string;
    };
    expect(sc.total).toBe(3);
    expect(sc.results.map((r) => r.oracle_id).sort()).toEqual(["o-atra", "o-llan", "o-llanv"]);
    expect(sc.data_snapshot).toBe(SNAPSHOT);
  });

  it("surfaces a malformed query as INVALID_QUERY with teaching examples", async () => {
    const res = await client.callTool({
      name: "card_search",
      arguments: { query: "(t:dragon" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "INVALID_QUERY" });
    const details = (res.structuredContent as { details?: { examples?: string[] } }).details;
    expect(details?.examples?.length).toBeGreaterThanOrEqual(3);
    expect(details?.examples?.[0]).toContain("t:instant");
    assert(details?.examples);
    for (const query of details.examples) {
      const example = await client.callTool({ name: "card_search", arguments: { query } });
      expect(example.isError, `Published recovery example: ${query}`).not.toBe(true);
    }
  });
});

describe("card_get", () => {
  it("returns found cards and reports missing ids", async () => {
    const res = await client.callTool({
      name: "card_get",
      arguments: { oracle_ids: ["o-sol", "o-nope"] },
    });
    const sc = res.structuredContent as {
      cards: Array<{
        name: string;
        default_usd: number | null;
        cheapest_usd: number | null;
      }>;
      missing: string[];
    };
    expect(sc.cards.map((c) => c.name)).toEqual(["Sol Ring"]);
    expect(sc.missing).toEqual(["o-nope"]);
    // Each card carries default + cheapest USD (review #4); keys are always present.
    const sol = sc.cards[0]!;
    expect(sol).toHaveProperty("default_usd");
    expect(sol).toHaveProperty("cheapest_usd");
    // Lean by default (review #2): the heavy printings array is omitted.
    expect(sol).not.toHaveProperty("printings");
  });

  it("includes the full printings array only when include_printings is set", async () => {
    const res = await client.callTool({
      name: "card_get",
      arguments: { oracle_ids: ["o-sol"], include_printings: true },
    });
    const sc = res.structuredContent as {
      cards: Array<{ printings: unknown[] }>;
    };
    expect(Array.isArray(sc.cards[0]?.printings)).toBe(true);
  });

  it("compact:true trims to gameplay essentials (batch-friendly)", async () => {
    const res = await client.callTool({
      name: "card_get",
      arguments: { cards: ["o-sol"], compact: true },
    });
    const sc = res.structuredContent as {
      cards: Array<Record<string, unknown> & { legalities: Record<string, string> }>;
    };
    const sol = sc.cards[0]!;
    // Keeps what deckbuilding reads…
    expect(sol.name).toBe("Sol Ring");
    expect(sol.oracle_text).toBeTruthy();
    expect(sol.roles).toBeTruthy();
    expect(sol).toHaveProperty("default_usd");
    expect(sol.legalities).toEqual({ commander: "legal" }); // only the format that matters here
    // …and drops the bulk.
    expect(sol).not.toHaveProperty("prices");
    expect(sol).not.toHaveProperty("keywords");
    expect(sol).not.toHaveProperty("printings");
  });

  it("accepts a card NAME or oracle_id (review #3), reporting unresolved in missing[]", async () => {
    const res = await client.callTool({
      name: "card_get",
      arguments: { oracle_ids: ["Sol Ring", "o-sol", "No Such Card"] },
    });
    const sc = res.structuredContent as {
      cards: Array<{ name: string }>;
      missing: string[];
    };
    // "Sol Ring" (name) and "o-sol" (id) both resolve to the same card.
    expect(sc.cards.map((c) => c.name)).toEqual(["Sol Ring", "Sol Ring"]);
    expect(sc.missing).toEqual(["No Such Card"]);
  });
});

describe("card_resolve_name", () => {
  it("resolves an exact name to its oracle_id", async () => {
    const res = await client.callTool({
      name: "card_resolve_name",
      arguments: { name: "sol ring" },
    });
    expect(res.structuredContent).toMatchObject({ oracle_id: "o-sol" });
  });

  it("returns AMBIGUOUS_NAME with candidates for a fuzzy multi-match", async () => {
    const res = await client.callTool({
      name: "card_resolve_name",
      arguments: { name: "Llanowar" },
    });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as {
      code: string;
      details: { candidates: unknown[] };
    };
    expect(sc.code).toBe("AMBIGUOUS_NAME");
    expect(sc.details.candidates).toHaveLength(2);
  });

  it("returns UNKNOWN_CARD for a name with no match", async () => {
    const res = await client.callTool({
      name: "card_resolve_name",
      arguments: { name: "Definitely Not A Card" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "UNKNOWN_CARD" });
  });

  it("attaches did-you-mean suggestions to UNKNOWN_CARD for a near-miss typo", async () => {
    const res = await client.callTool({
      name: "card_resolve_name",
      arguments: { name: "Sol Rng" },
    });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as {
      code: string;
      details: { input: string; suggestions: Array<{ name: string }> };
    };
    expect(sc.code).toBe("UNKNOWN_CARD");
    expect(sc.details.input).toBe("Sol Rng");
    expect(sc.details.suggestions.map((s) => s.name)).toContain("Sol Ring");
  });
});

describe("card_printings", () => {
  it("returns all printings for an oracle_id", async () => {
    const res = await client.callTool({
      name: "card_printings",
      arguments: { oracle_id: "o-sol" },
    });
    const sc = res.structuredContent as { printings: Array<{ set: string }> };
    expect(sc.printings.map((p) => p.set)).toEqual(["cmm", "c21"]);
  });

  it("returns UNKNOWN_CARD for an unknown oracle_id", async () => {
    const res = await client.callTool({
      name: "card_printings",
      arguments: { oracle_id: "o-nope" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "UNKNOWN_CARD" });
  });

  it("accepts a card name via the canonical `card` key", async () => {
    const res = await client.callTool({
      name: "card_printings",
      arguments: { card: "Sol Ring" },
    });
    const sc = res.structuredContent as {
      oracle_id: string;
      printings: Array<{ set: string }>;
    };
    expect(sc.oracle_id).toBe("o-sol");
    expect(sc.printings.map((p) => p.set)).toEqual(["cmm", "c21"]);
  });
});
