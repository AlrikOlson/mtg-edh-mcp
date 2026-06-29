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

interface DeckShape {
  deck_id: string;
  name: string;
  version: number;
  cards: Array<{ oracle_id: string; qty: number }>;
}
interface DiffShape {
  cards: {
    added: { oracle_id: string; qty: number }[];
    removed: { oracle_id: string; qty: number }[];
    changed: { oracle_id: string; from_qty: number; to_qty: number }[];
  };
  metadata: {
    name?: { from: string; to: string };
    version: { from: number; to: number };
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-deckver-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
  await store.publish("v1");
  index = CardIndex.open((await buildIndex({ store })).dbPath);

  let snapN = 0;
  deckStore = new DeckStore({ newId: () => "deck-1", newSnapshotId: () => `snap-${++snapN}` });

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

describe("deck versioning tools", () => {
  it("registers the three versioning tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["deck_snapshot", "deck_diff", "deck_restore"]));
  });

  it("snapshot → mutate → diff shows the delta, then restore rolls back", async () => {
    await client.callTool({ name: "deck_create", arguments: { name: "Mono" } });

    // Snapshot the empty baseline.
    const snapped = await client.callTool({
      name: "deck_snapshot",
      arguments: { deck_id: "deck-1" },
    });
    const snapId = (snapped.structuredContent as { snapshot_id: string; version: number })
      .snapshot_id;
    expect(snapId).toBe("snap-1");

    // Mutate: add a card + rename (deck_add lands in p3-addremove, so go via the store).
    deckStore.update("deck-1", (deck) => ({
      ...deck,
      name: "Mono Artifacts",
      cards: [{ oracle_id: "o-sol", qty: 1 }],
    }));

    // Diff baseline snapshot -> current deck.
    const diffed = await client.callTool({
      name: "deck_diff",
      arguments: { deck_id: "deck-1", snapshot_id: snapId },
    });
    const diff = (diffed.structuredContent as { diff: DiffShape }).diff;
    expect(diff.cards.added).toEqual([{ oracle_id: "o-sol", qty: 1 }]);
    expect(diff.cards.removed).toEqual([]);
    expect(diff.cards.changed).toEqual([]);
    expect(diff.metadata.name).toEqual({ from: "Mono", to: "Mono Artifacts" });
    // snapshot was v1; deck is now v2 after the update.
    expect(diff.metadata.version).toEqual({ from: 1, to: 2 });

    // Restore: deck rolls back to the snapshot, version bumps (restore is a mutation).
    const restored = await client.callTool({
      name: "deck_restore",
      arguments: { deck_id: "deck-1", snapshot_id: snapId },
    });
    const rc = restored.structuredContent as {
      deck_id: string;
      restored_from: string;
      deck: DeckShape;
    };
    expect(rc.deck_id).toBe("deck-1");
    expect(rc.restored_from).toBe(snapId);
    expect(rc.deck.name).toBe("Mono");
    expect(rc.deck.cards).toEqual([]);
    // Optimistic version keeps climbing: created v1, mutated v2, restored v3.
    expect(rc.deck.version).toBe(3);
  });

  it("diff detects a quantity change between two snapshots", async () => {
    await client.callTool({ name: "deck_create", arguments: { name: "Q" } });
    deckStore.update("deck-1", (deck) => ({ ...deck, cards: [{ oracle_id: "o-sol", qty: 1 }] }));
    const a = (
      (await client.callTool({ name: "deck_snapshot", arguments: { deck_id: "deck-1" } }))
        .structuredContent as { snapshot_id: string }
    ).snapshot_id;
    deckStore.update("deck-1", (deck) => ({ ...deck, cards: [{ oracle_id: "o-sol", qty: 4 }] }));
    const b = (
      (await client.callTool({ name: "deck_snapshot", arguments: { deck_id: "deck-1" } }))
        .structuredContent as { snapshot_id: string }
    ).snapshot_id;

    const diffed = await client.callTool({
      name: "deck_diff",
      arguments: { deck_id: "deck-1", snapshot_id: a, to_snapshot_id: b },
    });
    const diff = (diffed.structuredContent as { diff: DiffShape }).diff;
    expect(diff.cards.changed).toEqual([{ oracle_id: "o-sol", from_qty: 1, to_qty: 4 }]);
    expect(diff.cards.added).toEqual([]);
    expect(diff.cards.removed).toEqual([]);
  });

  it("snapshot is immutable — later deck mutation does not bleed into it", async () => {
    await client.callTool({ name: "deck_create", arguments: { name: "Imm" } });
    deckStore.update("deck-1", (deck) => ({ ...deck, cards: [{ oracle_id: "o-sol", qty: 1 }] }));
    const snap = deckStore.snapshot("deck-1");
    deckStore.update("deck-1", (deck) => ({ ...deck, cards: [{ oracle_id: "o-sol", qty: 9 }] }));
    expect(snap.deck.cards).toEqual([{ oracle_id: "o-sol", qty: 1 }]);
  });

  it("deck_snapshot on unknown deck and deck_restore on unknown snapshot return DECK_NOT_FOUND", async () => {
    const noDeck = await client.callTool({ name: "deck_snapshot", arguments: { deck_id: "nope" } });
    expect(noDeck.isError).toBe(true);
    expect(noDeck.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });

    await client.callTool({ name: "deck_create", arguments: { name: "R" } });
    const noSnap = await client.callTool({
      name: "deck_restore",
      arguments: { deck_id: "deck-1", snapshot_id: "missing" },
    });
    expect(noSnap.isError).toBe(true);
    expect(noSnap.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
  });
});
