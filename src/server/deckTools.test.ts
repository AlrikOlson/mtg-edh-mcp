import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
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
  {
    oracle_id: "o-marwyn",
    id: "p-marwyn",
    name: "Marwyn, the Nurturer",
    cmc: 3,
    colors: ["G"],
    color_identity: ["G"],
    type_line: "Legendary Creature — Elf Druid",
    oracle_text: "Whenever another Elf you control enters, put a +1/+1 counter on Marwyn.",
    power: "1",
    toughness: "1",
    legalities: { commander: "legal" },
    prices: { usd: "0.50" },
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
];

let root: string;
let index: CardIndex;
let deckStore: DeckStore;
let client: Client;

interface DeckShape {
  deck_id: string;
  name: string;
  version: number;
  cards: Array<{
    oracle_id: string;
    qty: number;
    name?: string;
    card?: { name: string } | null;
  }>;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-decktools-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
  await store.publish("v1");
  index = CardIndex.open((await buildIndex({ store })).dbPath);
  deckStore = new DeckStore({ newId: () => "deck-1" });

  const server = createServer({
    index,
    deckStore,
    snapshot: staticSnapshotProvider("2026-06-27"),
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

describe("deck lifecycle tools", () => {
  it("registers the four deck tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["deck_create", "deck_get", "deck_list", "deck_delete"]),
    );
  });

  it("create → get → list → delete round-trips, with a usable deck_id", async () => {
    const created = await client.callTool({
      name: "deck_create",
      arguments: { name: "Atraxa", commanders: ["o-atraxa"] },
    });
    const csc = created.structuredContent as {
      deck_id: string;
      deck: DeckShape;
    };
    expect(csc.deck_id).toBe("deck-1");
    expect(csc.deck).toMatchObject({
      name: "Atraxa",
      version: 1,
      data_snapshot: "2026-06-27",
    });

    const got = await client.callTool({
      name: "deck_get",
      arguments: { deck_id: "deck-1" },
    });
    expect((got.structuredContent as { deck: DeckShape }).deck.name).toBe("Atraxa");

    const listed = await client.callTool({ name: "deck_list", arguments: {} });
    const listing = listed.structuredContent as {
      decks: Array<{
        deck_id: string;
        name: string;
        version: number;
        commanders: string[];
        card_count: number;
      }>;
      total: number;
    };
    // Lean entries: identity + vitals-adjacent counts, never full card lists.
    expect(listing.decks.map((d) => d.deck_id)).toEqual(["deck-1"]);
    expect(listing.total).toBe(1);
    expect(listing.decks[0]).toMatchObject({ name: "Atraxa", card_count: 1 });
    expect(listing.decks[0]).not.toHaveProperty("cards");

    const deleted = await client.callTool({
      name: "deck_delete",
      arguments: { deck_id: "deck-1" },
    });
    expect(deleted.structuredContent).toMatchObject({ deleted: true });

    const gone = await client.callTool({
      name: "deck_get",
      arguments: { deck_id: "deck-1" },
    });
    expect(gone.isError).toBe(true);
    expect(gone.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
  });

  it("deck_create with commanders computes color identity immediately (no deck_set_commander needed)", async () => {
    const res = await client.callTool({
      name: "deck_create",
      arguments: { name: "Elves", commanders: "Marwyn, the Nurturer" },
    });
    const sc = res.structuredContent as {
      deck_id: string;
      deck: {
        computed_color_identity: string[];
        commanders: string[];
        version: number;
      };
    };
    // The historic bug: identity stayed [] until deck_set_commander, so the
    // next import rejected every colored card as a COLOR_IDENTITY violation.
    expect(sc.deck.computed_color_identity).toEqual(["G"]);
    expect(sc.deck.commanders).toEqual(["o-marwyn"]); // name resolved to oracle_id
    expect(sc.deck.version).toBe(1); // applied at create, not via a hidden update

    // And a colored add now passes without any commander call in between.
    const add = await client.callTool({
      name: "deck_add",
      arguments: {
        deck_id: sc.deck_id,
        cards: [{ oracle_id: "o-llan", qty: 1 }],
      },
    });
    const verdicts = (add.structuredContent as { verdicts: Array<{ status: string }> }).verdicts;
    expect(verdicts[0]?.status).toBe("ok");
  });

  it("deck_get projects cards lean by default and full on expand", async () => {
    await client.callTool({ name: "deck_create", arguments: { name: "Mono" } });
    // Inject a card entry directly (deck_add lands in p3-addremove).
    deckStore.update("deck-1", (deck) => ({
      ...deck,
      cards: [{ oracle_id: "o-sol", qty: 1 }],
    }));

    const lean = await client.callTool({
      name: "deck_get",
      arguments: { deck_id: "deck-1" },
    });
    const leanCards = (lean.structuredContent as { deck: DeckShape }).deck.cards;
    expect(leanCards[0]).toEqual({
      oracle_id: "o-sol",
      qty: 1,
      name: "Sol Ring",
    });
    expect(leanCards[0]).not.toHaveProperty("card");

    const expanded = await client.callTool({
      name: "deck_get",
      arguments: { deck_id: "deck-1", expand: true },
    });
    const expCards = (expanded.structuredContent as { deck: DeckShape }).deck.cards;
    expect(expCards[0]?.card?.name).toBe("Sol Ring");
  });

  it("deck_delete on an unknown deck returns DECK_NOT_FOUND", async () => {
    const res = await client.callTool({
      name: "deck_delete",
      arguments: { deck_id: "nope" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
  });

  it("deck_rename renames (version bump), conflicts on stale expected_version", async () => {
    await client.callTool({
      name: "deck_create",
      arguments: { name: "Old Name" },
    });
    const renamed = await client.callTool({
      name: "deck_rename",
      arguments: { deck_id: "deck-1", name: "New Name" },
    });
    expect(renamed.structuredContent).toMatchObject({
      ok: true,
      deck_id: "deck-1",
      name: "New Name",
      version: 2,
    });
    const got = await client.callTool({
      name: "deck_get",
      arguments: { deck_id: "deck-1" },
    });
    expect((got.structuredContent as { deck: DeckShape }).deck.name).toBe("New Name");

    const stale = await client.callTool({
      name: "deck_rename",
      arguments: { deck_id: "deck-1", name: "Nope", expected_version: 1 },
    });
    expect(stale.structuredContent).toMatchObject({
      ok: false,
      conflict: true,
    });

    const unknown = await client.callTool({
      name: "deck_rename",
      arguments: { deck_id: "nope", name: "X" },
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
  });
});
