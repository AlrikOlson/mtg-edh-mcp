import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { createServer } from "./createServer.js";
import { staticSnapshotProvider } from "./snapshot.js";

const ORACLE = [
  {
    oracle_id: "o-counter",
    name: "Counterspell",
    cmc: 2,
    colors: ["U"],
    color_identity: ["U"],
    type_line: "Instant",
    oracle_text: "Counter target spell.",
    legalities: { commander: "legal" },
    prices: { usd: "1.00" },
  },
  {
    oracle_id: "o-rift",
    name: "Cyclonic Rift",
    cmc: 2,
    colors: ["U"],
    color_identity: ["U"],
    type_line: "Instant",
    oracle_text: "Return target nonland permanent you don't control to its owner's hand.",
    legalities: { commander: "legal" },
    prices: { usd: "30.00" },
  },
  {
    oracle_id: "o-llan",
    name: "Llanowar Elves",
    cmc: 1,
    colors: ["G"],
    color_identity: ["G"],
    type_line: "Creature — Elf Druid",
    oracle_text: "{T}: Add {G}.",
    legalities: { commander: "legal" },
    prices: { usd: "0.50" },
  },
];

let root: string;
let index: CardIndex;
let client: Client;

async function freshClient(): Promise<Client> {
  const server = createServer({
    index,
    snapshot: staticSnapshotProvider("2026-06-27"),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: "test", version: "0.0.0" });
  await c.connect(ct);
  return c;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-collection-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
  await store.publish("v1");
  index = CardIndex.open((await buildIndex({ store })).dbPath);
  client = await freshClient();
});
afterEach(async () => {
  await client.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

interface CollectionView {
  owned_count: number;
  owned: string[];
  cards: Array<{ oracle_id: string; name?: string }>;
  unresolved?: string[];
}
interface SearchView {
  total: number;
  returned: number;
  results: Array<{ oracle_id: string }>;
}

describe("collection tools", () => {
  it("registers the collection tools + card_search owned_only", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "collection_set",
        "collection_add",
        "collection_get",
        "collection_clear",
      ]),
    );
    const search = tools.tools.find((t) => t.name === "card_search");
    expect(Object.keys(search?.inputSchema.properties ?? {})).toContain("owned_only");
  });

  it("sets by name, reports unresolved, and reads back", async () => {
    const set = (
      await client.callTool({
        name: "collection_set",
        arguments: { cards: ["Counterspell", "Not A Real Card"] },
      })
    ).structuredContent as CollectionView;
    expect(set.owned_count).toBe(1);
    expect(set.owned).toEqual(["o-counter"]);
    expect(set.unresolved).toEqual(["Not A Real Card"]);

    const got = (await client.callTool({ name: "collection_get", arguments: {} }))
      .structuredContent as CollectionView;
    expect(got.cards).toEqual([{ oracle_id: "o-counter", name: "Counterspell" }]);
  });

  it("collection_get paginates with limit + next_cursor and reports total", async () => {
    await client.callTool({
      name: "collection_set",
      arguments: { cards: ["o-counter", "o-rift"] },
    });
    const page1 = (await client.callTool({ name: "collection_get", arguments: { limit: 1 } }))
      .structuredContent as CollectionView & {
      total: number;
      next_cursor: string | null;
    };
    expect(page1.owned).toHaveLength(1);
    expect(page1.total).toBe(2);
    expect(page1.next_cursor).toBe("1");

    const page2 = (
      await client.callTool({
        name: "collection_get",
        arguments: { limit: 1, cursor: page1.next_cursor },
      })
    ).structuredContent as CollectionView & {
      total: number;
      next_cursor: string | null;
    };
    expect(page2.owned).toHaveLength(1);
    expect(page2.next_cursor).toBeNull();
    expect(page2.owned[0]).not.toBe(page1.owned[0]);
  });

  it("clear empties the collection", async () => {
    await client.callTool({
      name: "collection_set",
      arguments: { cards: ["o-counter"] },
    });
    const cleared = (await client.callTool({ name: "collection_clear", arguments: {} }))
      .structuredContent as CollectionView;
    expect(cleared.owned_count).toBe(0);
  });
});

describe("card_search owned_only", () => {
  async function search(owned_only: boolean): Promise<SearchView> {
    const res = await client.callTool({
      name: "card_search",
      arguments: {
        query: "t:instant",
        ...(owned_only ? { owned_only: true } : {}),
      },
    });
    return res.structuredContent as SearchView;
  }

  it("is a no-op when no collection is set (off by default)", async () => {
    expect((await search(false)).total).toBe(2); // both instants
    expect((await search(true)).total).toBe(2); // owned_only with empty collection = identical
  });

  it("restricts to owned cards once a collection is set, keeping totals exact", async () => {
    await client.callTool({
      name: "collection_set",
      arguments: { cards: ["Counterspell"] },
    });
    const owned = await search(true);
    expect(owned.total).toBe(1);
    expect(owned.results.map((r) => r.oracle_id)).toEqual(["o-counter"]);
    // ...while owned_only:false still sees both.
    expect((await search(false)).total).toBe(2);
  });
});

describe("collection:// resource", () => {
  it("exposes the owned set for a session", async () => {
    await client.callTool({
      name: "collection_set",
      arguments: { cards: ["o-counter", "o-llan"] },
    });
    const res = await client.readResource({ uri: "collection://local" });
    const text = (res.contents[0] as { text: string }).text;
    const body = JSON.parse(text) as CollectionView & { session: string };
    expect(body.session).toBe("local");
    expect(body.owned_count).toBe(2);
    expect(body.owned.sort()).toEqual(["o-counter", "o-llan"]);
  });
});
