import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { DeckStore } from "../deck/index.js";
import { CacheStore, SpellbookClient } from "../meta/index.js";
import { createServer } from "./createServer.js";
import { staticSnapshotProvider } from "./snapshot.js";

const ORACLE = [
  {
    oracle_id: "o-talrand",
    id: "p-talrand",
    name: "Talrand, Sky Summoner",
    cmc: 4,
    colors: ["U"],
    color_identity: ["U"],
    type_line: "Legendary Creature — Merfolk Wizard",
    oracle_text: "",
    legalities: { commander: "legal" },
    prices: { usd: "1.00" },
  },
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
];

const RESPONSE = {
  results: {
    included: [
      {
        id: "1-2",
        uses: [{ card: { name: "Thassa's Oracle" } }, { card: { name: "Demonic Consultation" } }],
        produces: [{ feature: { name: "Win the game" } }],
        description: "Exile your library, then cast Thassa's Oracle to win.",
      },
    ],
    almostIncluded: [
      {
        id: "3-4",
        uses: [{ card: { name: "Isochron Scepter" } }, { card: { name: "Dramatic Reversal" } }],
        produces: [{ feature: { name: "Infinite mana" } }],
        description: "Imprint and loop.",
      },
    ],
  },
};

let root: string;
let index: CardIndex;
let deckStore: DeckStore;
let client: Client;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-combos-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
  await store.publish("v1");
  index = CardIndex.open((await buildIndex({ store })).dbPath);
  deckStore = new DeckStore({ newId: () => "deck-1" });

  const spellbook = new SpellbookClient(new CacheStore({ now: () => 1000 }), {
    fetchJson: async () => RESPONSE,
  });
  const server = createServer({
    index,
    deckStore,
    spellbook,
    snapshot: staticSnapshotProvider("2026-06-27"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  await client.callTool({ name: "deck_create", arguments: { name: "Talrand" } });
  deckStore.update("deck-1", (d) => ({
    ...d,
    commanders: ["o-talrand"],
    computed_color_identity: ["U"],
    cards: [{ oracle_id: "o-sol", qty: 1 }],
  }));
});
afterEach(async () => {
  await client.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

describe("meta_combos tool", () => {
  it("is registered", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("meta_combos");
  });

  it("returns included combos with pieces/result/steps/source/confidence", async () => {
    const res = await client.callTool({ name: "meta_combos", arguments: { deck_id: "deck-1" } });
    const r = res.structuredContent as {
      combos: Array<{
        id: string;
        pieces: string[];
        produces: string[];
        steps?: string;
        source: string;
        confidence: string;
      }>;
      included_count: number;
      almost_count: number;
    };
    expect(r.included_count).toBe(1);
    expect(r.almost_count).toBe(1);
    expect(r.combos).toHaveLength(1); // almost excluded by default
    expect(r.combos[0]).toMatchObject({
      id: "1-2",
      source: "commander_spellbook",
      confidence: "included",
    });
    expect(r.combos[0]?.pieces).toContain("Thassa's Oracle");
    expect(r.combos[0]?.produces).toContain("Win the game");
    expect(r.combos[0]?.steps).toBeTruthy();
  });

  it("includes almost-combos when include_almost is set", async () => {
    const res = await client.callTool({
      name: "meta_combos",
      arguments: { deck_id: "deck-1", include_almost: true },
    });
    const r = res.structuredContent as { combos: Array<{ confidence: string }> };
    expect(r.combos).toHaveLength(2);
    expect(r.combos.map((c) => c.confidence)).toEqual(["included", "almost"]);
  });

  it("returns DECK_NOT_FOUND for an unknown deck", async () => {
    const res = await client.callTool({ name: "meta_combos", arguments: { deck_id: "nope" } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
  });

  it("degrades to UPSTREAM_UNAVAILABLE when Spellbook is down", async () => {
    const down = new SpellbookClient(new CacheStore({ now: () => 1000 }), {
      fetchJson: async () => {
        throw new Error("offline");
      },
    });
    const server = createServer({ index, deckStore, spellbook: down });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c2 = new Client({ name: "t2", version: "0.0.0" });
    await c2.connect(ct);
    const res = await c2.callTool({ name: "meta_combos", arguments: { deck_id: "deck-1" } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await c2.close();
  });
});
