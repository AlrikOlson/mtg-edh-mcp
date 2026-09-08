import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { DeckStore } from "../deck/index.js";
import { createServer } from "./createServer.js";
import { staticSnapshotProvider } from "./snapshot.js";

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
];

let root: string;
let index: CardIndex;
let deckStore: DeckStore;
let client: Client;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-resources-"));
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
});
afterEach(async () => {
  await client.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

describe("addressable resources", () => {
  it("resolves card://{oracle_id} to the canonical card", async () => {
    const res = await client.readResource({ uri: "card://o-sol" });
    const card = JSON.parse((res.contents[0] as { text: string }).text) as { name: string };
    expect(card.name).toBe("Sol Ring");
  });

  it("resolves deck://{deck_id} to the current decklist", async () => {
    deckStore.create({ name: "Atraxa" });
    const res = await client.readResource({ uri: "deck://deck-1" });
    const deck = JSON.parse((res.contents[0] as { text: string }).text) as {
      name: string;
      version: number;
    };
    expect(deck).toMatchObject({ name: "Atraxa", version: 1 });
  });

  it("rejects an unknown deck:// (error surfaces as a protocol error)", async () => {
    // Resource-read errors come back as MCP protocol errors carrying the message
    // (the structured `code` path is for tool results, not resources).
    await expect(client.readResource({ uri: "deck://missing" })).rejects.toThrow(/unknown deck/);
  });
});

describe("deck subscription updates", () => {
  it("notifies deck:// subscribers when a deck mutates", async () => {
    deckStore.create({ name: "Atraxa" });
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updates.push(n.params.uri);
    });
    await client.subscribeResource({ uri: "deck://deck-1" });

    deckStore.setName("deck-1", "Atraxa Superfriends");
    await tick();

    expect(updates).toContain("deck://deck-1");
    expect(deckStore.get("deck-1")?.version).toBe(2);
  });

  it("only notifies the owning session when deck IDs are reused across sessions", async () => {
    deckStore.create({ name: "Local" });
    deckStore.create({ name: "Alice" }, "alice");
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updates.push(n.params.uri);
    });
    await client.subscribeResource({ uri: "deck://deck-1" });
    deckStore.setName("deck-1", "Alice changed", "alice");
    await tick();
    expect(updates).toEqual([]);
    deckStore.setName("deck-1", "Local changed");
    await tick();
    expect(updates).toEqual(["deck://deck-1"]);
  });

  it("rejects subscriptions to missing or foreign resources", async () => {
    deckStore.create({ name: "Alice" }, "alice");
    await expect(client.subscribeResource({ uri: "deck://deck-1" })).rejects.toThrow(
      "Unknown deck resource",
    );
    await expect(client.subscribeResource({ uri: "collection://alice" })).rejects.toThrow(
      "Unknown deck resource",
    );
  });

  it("stops sending updates after a subscription is removed", async () => {
    deckStore.create({ name: "Local" });
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updates.push(n.params.uri);
    });
    await client.subscribeResource({ uri: "deck://deck-1" });
    await client.unsubscribeResource({ uri: "deck://deck-1" });
    deckStore.setName("deck-1", "Changed");
    await tick();
    expect(updates).toEqual([]);
  });
});
