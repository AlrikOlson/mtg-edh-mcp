import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { DeckStore } from "../deck/index.js";
import { CacheStore, EdhrecClient } from "../meta/index.js";
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
    oracle_text: "Whenever you cast an instant or sorcery spell, create a 2/2 blue Drake.",
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
  {
    oracle_id: "o-signet",
    id: "p-signet",
    name: "Arcane Signet",
    cmc: 2,
    colors: [],
    color_identity: [],
    type_line: "Artifact",
    oracle_text: "{T}: Add one mana of any color in your commander's color identity.",
    legalities: { commander: "legal" },
    prices: { usd: "1.00" },
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
    prices: { usd: "1.00" },
  },
];

const EDHREC_PAGE = {
  container: {
    json_dict: {
      cardlists: [
        {
          header: "Top Cards",
          cardviews: [
            { name: "Sol Ring", inclusion: 900, synergy: 0.05 }, // already in deck
            { name: "Arcane Signet", inclusion: 800, synergy: 0.2 }, // on-color (colorless)
            { name: "Lightning Bolt", inclusion: 300, synergy: 0.5 }, // off-color R
            { name: "Nonexistent Card", inclusion: 10, synergy: 0.1 }, // unresolved
          ],
        },
      ],
    },
  },
  panels: { taglinks: [{ value: "Spellslinger" }, { value: "Counters" }] },
};

let root: string;
let index: CardIndex;
let deckStore: DeckStore;
let client: Client;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-meta-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
  await store.publish("v1");
  index = CardIndex.open((await buildIndex({ store })).dbPath);
  deckStore = new DeckStore({ newId: () => "deck-1" });

  const edhrec = new EdhrecClient(new CacheStore({ now: () => 1000 }), {
    fetchJson: async () => EDHREC_PAGE,
  });
  const server = createServer({
    index,
    deckStore,
    edhrec,
    snapshot: staticSnapshotProvider("2026-06-27"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  // Mono-U Talrand deck already running Sol Ring.
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

describe("EDHREC meta tools", () => {
  it("registers meta_commander_profile, meta_themes, meta_recommendations", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["meta_commander_profile", "meta_themes", "meta_recommendations"]),
    );
  });

  it("meta_commander_profile parses cards + themes", async () => {
    const res = await client.callTool({
      name: "meta_commander_profile",
      arguments: { commander: "Talrand, Sky Summoner" },
    });
    const r = res.structuredContent as { cards: unknown[]; themes: string[] };
    expect(r.cards).toHaveLength(4);
    expect(r.themes).toEqual(["Spellslinger", "Counters"]);
  });

  it("meta_recommendations filters identity, excludes in-deck, reports unresolved", async () => {
    const res = await client.callTool({
      name: "meta_recommendations",
      arguments: { deck_id: "deck-1" },
    });
    const r = res.structuredContent as {
      recommendations: Array<{ oracle_id: string; name: string }>;
      unresolved: Array<{ name: string; reason: string }>;
    };
    const names = r.recommendations.map((x) => x.name);
    expect(names).toContain("Arcane Signet"); // colorless, not in deck
    expect(names).not.toContain("Sol Ring"); // already in deck
    expect(names).not.toContain("Lightning Bolt"); // off-color (R) for a mono-U deck
    expect(r.unresolved.map((u) => u.name)).toContain("Nonexistent Card");
  });

  it("meta_themes returns the commander's themes", async () => {
    const res = await client.callTool({
      name: "meta_themes",
      arguments: { commander: "Talrand, Sky Summoner" },
    });
    expect((res.structuredContent as { themes: string[] }).themes).toEqual([
      "Spellslinger",
      "Counters",
    ]);
  });

  it("meta_recommendations returns DECK_NOT_FOUND for an unknown deck", async () => {
    const res = await client.callTool({
      name: "meta_recommendations",
      arguments: { deck_id: "nope" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
  });

  it("degrades to UPSTREAM_UNAVAILABLE when EDHREC is down with nothing cached", async () => {
    const downEdhrec = new EdhrecClient(new CacheStore({ now: () => 1000 }), {
      fetchJson: async () => {
        throw new Error("offline");
      },
    });
    const server = createServer({ index, deckStore, edhrec: downEdhrec });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c2 = new Client({ name: "t2", version: "0.0.0" });
    await c2.connect(ct);
    const res = await c2.callTool({
      name: "meta_commander_profile",
      arguments: { commander: "Talrand, Sky Summoner" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await c2.close();
  });
});
