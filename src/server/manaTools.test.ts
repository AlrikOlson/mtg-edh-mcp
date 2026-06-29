import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { DeckStore } from "../deck/index.js";
import { createServer } from "./createServer.js";
import { staticSnapshotProvider } from "./snapshot.js";

const ORACLE = [
  {
    oracle_id: "o-forest",
    id: "p-forest",
    name: "Forest",
    cmc: 0,
    colors: [],
    color_identity: ["G"],
    type_line: "Basic Land — Forest",
    oracle_text: "({T}: Add {G}.)",
    legalities: { commander: "legal" },
    prices: { usd: "0.10" },
  },
  {
    oracle_id: "o-tower",
    id: "p-tower",
    name: "Command Tower",
    cmc: 0,
    colors: [],
    color_identity: [],
    type_line: "Land",
    oracle_text: "{T}: Add one mana of any color in your commander's color identity.",
    legalities: { commander: "legal" },
    prices: { usd: "0.50" },
  },
  {
    oracle_id: "o-elf",
    id: "p-elf",
    name: "Llanowar Elves",
    cmc: 1,
    colors: ["G"],
    color_identity: ["G"],
    type_line: "Creature — Elf Druid",
    oracle_text: "{T}: Add {G}.",
    mana_cost: "{G}",
    legalities: { commander: "legal" },
    prices: { usd: "0.25" },
  },
];

let root: string;
let index: CardIndex;
let deckStore: DeckStore;
let client: Client;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-mana-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
  await store.publish("v1");
  index = CardIndex.open((await buildIndex({ store })).dbPath);
  deckStore = new DeckStore({ newId: () => "deck-1" });

  const server = createServer({ index, deckStore, snapshot: staticSnapshotProvider("2026-06-27") });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  await client.callTool({ name: "deck_create", arguments: { name: "Mono G" } });
  deckStore.update("deck-1", (d) => ({
    ...d,
    computed_color_identity: ["G"],
    cards: [
      { oracle_id: "o-forest", qty: 4 },
      { oracle_id: "o-tower", qty: 1 },
      { oracle_id: "o-elf", qty: 1 },
    ],
  }));
});
afterEach(async () => {
  await client.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

describe("mana base & role coverage tools", () => {
  it("registers analyze_mana_base and analyze_role_coverage", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["analyze_mana_base", "analyze_role_coverage"]));
  });

  it("analyze_mana_base reports exact green sources + flags under-support", async () => {
    const res = await client.callTool({
      name: "analyze_mana_base",
      arguments: { deck_id: "deck-1" },
    });
    const r = res.structuredContent as {
      total_lands: number;
      untapped_lands: number;
      sources: Record<string, number>;
      fixing_sources: number;
      under_supported: string[];
    };
    expect(r.sources.G).toBe(6); // 4 forest + tower(any->G) + elf
    expect(r.total_lands).toBe(5);
    expect(r.untapped_lands).toBe(5);
    expect(r.fixing_sources).toBe(1); // command tower
    expect(r.under_supported).toEqual(["G"]); // 6 < default 10
  });

  it("analyze_role_coverage flags ramp/land as under target", async () => {
    const res = await client.callTool({
      name: "analyze_role_coverage",
      arguments: { deck_id: "deck-1" },
    });
    const r = res.structuredContent as {
      counts: Record<string, number>;
      gaps: Array<{ role: string; status: string }>;
    };
    expect(r.counts.land).toBe(5); // 4 forest + command tower
    expect(r.gaps.find((g) => g.role === "ramp")?.status).toBe("under");
    expect(r.gaps.find((g) => g.role === "land")?.status).toBe("under");
  });

  it("returns DECK_NOT_FOUND for an unknown deck", async () => {
    const res = await client.callTool({
      name: "analyze_mana_base",
      arguments: { deck_id: "nope" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
  });
});
