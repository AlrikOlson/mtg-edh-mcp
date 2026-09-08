/**
 * HTTP multi-tenancy & concurrency (spec §2/§11, chunk:p7-multitenancy).
 *
 * Three guarantees:
 *  1. Two principals' decks are ISOLATED — a deck created under one
 *     x-mcp-principal is invisible to another, even though both hit the same
 *     stateless HTTP server backed by one shared DeckStore.
 *  2. Card data is SHARED read-only — every principal resolves the same card
 *     from the single shared CardIndex.
 *  3. Optimistic concurrency — a deck mutator with a stale expected_version
 *     returns a conflict and does NOT mutate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { DeckStore } from "../deck/index.js";
import { createServer } from "./createServer.js";
import { startHttp, type RunningHttpServer, PRINCIPAL_HEADER } from "./http.js";
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

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-mt-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
  await store.publish("v1");
  index = CardIndex.open((await buildIndex({ store })).dbPath);
  deckStore = new DeckStore();
});
afterEach(async () => {
  index.close();
  await rm(root, { recursive: true, force: true });
});

/** A Client over the running HTTP server carrying a fixed principal header. */
async function connectPrincipal(
  principal: string,
  url: URL,
  era: "legacy" | "modern",
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { [PRINCIPAL_HEADER]: principal } },
  });
  const client = new Client(
    { name: principal, version: "0.0.0" },
    {
      versionNegotiation: {
        mode: era === "modern" ? { pin: "2026-07-28" } : "legacy",
      },
    },
  );
  await client.connect(transport);
  expect(client.getProtocolEra()).toBe(era);
  return client;
}

describe.each(["legacy", "modern"] as const)("HTTP multi-tenancy (§2/§11) %s", (era) => {
  const connectAs = (principal: string, url: URL) => connectPrincipal(principal, url, era);
  let running: RunningHttpServer;
  let url: URL;

  beforeEach(async () => {
    // One shared DeckStore + CardIndex across every per-request server instance.
    running = await startHttp({
      index,
      deckStore,
      snapshot: staticSnapshotProvider("2026-06-27"),
    });
    url = new URL(`http://127.0.0.1:${running.port}/`);
  });
  afterEach(async () => {
    await running.close();
  });

  it("isolates two principals' decks", async () => {
    const alice = await connectAs("alice", url);
    const bob = await connectAs("bob", url);

    const created = await alice.callTool({
      name: "deck_create",
      arguments: { name: "Alice deck" },
    });
    const aliceDeckId = (created.structuredContent as { deck_id: string }).deck_id;

    // Bob sees none of Alice's decks.
    const bobList = await bob.callTool({ name: "deck_list", arguments: {} });
    expect((bobList.structuredContent as { decks: unknown[] }).decks).toHaveLength(0);

    // Alice sees exactly her deck.
    const aliceList = await alice.callTool({
      name: "deck_list",
      arguments: {},
    });
    expect((aliceList.structuredContent as { decks: { deck_id: string }[] }).decks).toHaveLength(1);

    // Bob cannot fetch Alice's deck by id.
    const bobGet = await bob.callTool({
      name: "deck_get",
      arguments: { deck_id: aliceDeckId },
    });
    expect(bobGet.isError).toBe(true);
    expect(bobGet.structuredContent).toMatchObject({
      code: "DECK_NOT_FOUND",
    });

    await alice.close();
    await bob.close();
  });

  it("shares card data read-only across principals", async () => {
    const alice = await connectAs("alice", url);
    const bob = await connectAs("bob", url);

    const want = { name: "Sol Ring" };
    const a = await alice.callTool({
      name: "card_resolve_name",
      arguments: want,
    });
    const b = await bob.callTool({
      name: "card_resolve_name",
      arguments: want,
    });
    expect((a.structuredContent as { oracle_id: string }).oracle_id).toBe("o-sol");
    expect((b.structuredContent as { oracle_id: string }).oracle_id).toBe("o-sol");

    await alice.close();
    await bob.close();
  });

  it("scopes deck resource reads to the requesting principal, including local decks", async () => {
    const localDeck = deckStore.create({ name: "Private local deck" });
    const aliceDeck = deckStore.create({ name: "Alice resource" }, "alice");
    const alice = await connectAs("alice", url);
    const bob = await connectAs("bob", url);
    try {
      const own = await alice.readResource({
        uri: `deck://${aliceDeck.deck_id}`,
      });
      expect(own.contents[0]).toMatchObject({
        text: JSON.stringify(aliceDeck),
      });
      await expect(bob.readResource({ uri: `deck://${aliceDeck.deck_id}` })).rejects.toThrow(
        "unknown deck",
      );
      await expect(alice.readResource({ uri: `deck://${localDeck.deck_id}` })).rejects.toThrow(
        "unknown deck",
      );
      expect(alice.getServerCapabilities()?.resources?.subscribe).not.toBe(true);
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  it("persists default collections between POSTs and prevents foreign collection reads", async () => {
    const alice = await connectAs("alice", url);
    const bob = await connectAs("bob", url);
    try {
      await alice.callTool({
        name: "collection_set",
        arguments: { cards: "Sol Ring" },
      });
      const own = await alice.readResource({ uri: "collection://alice" });
      const content = own.contents[0];
      expect(content && "text" in content ? JSON.parse(content.text) : undefined).toMatchObject({
        session: "alice",
        owned: ["o-sol"],
        owned_count: 1,
      });
      await expect(bob.readResource({ uri: "collection://alice" })).rejects.toThrow(
        "Unknown collection",
      );
      await expect(alice.readResource({ uri: "collection://local" })).rejects.toThrow(
        "Unknown collection",
      );
      const bobCollection = await bob.callTool({
        name: "collection_get",
        arguments: {},
      });
      expect(bobCollection.structuredContent).toMatchObject({
        owned_count: 0,
      });
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  it("reuses the default enrichment cache across fresh per-request servers", async () => {
    const realFetch = globalThis.fetch;
    let upstreamCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const target = input instanceof Request ? input.url : String(input);
      if (target.startsWith("https://json.edhrec.com/")) {
        upstreamCalls += 1;
        return Promise.resolve(Response.json({ panels: { taglinks: [{ value: "Artifacts" }] } }));
      }
      return realFetch(input, init);
    });
    const alice = await connectAs("alice", url);
    const bob = await connectAs("bob", url);
    try {
      for (const client of [alice, bob, alice]) {
        const result = await client.callTool({
          name: "meta_commander_profile",
          arguments: { commander: "Test Commander" },
        });
        expect(result.structuredContent).toMatchObject({
          themes: ["Artifacts"],
        });
      }
      expect(upstreamCalls).toBe(1);
    } finally {
      await alice.close();
      await bob.close();
      fetchSpy.mockRestore();
    }
  });

  it("never leaks across principals under interleaved stateless POSTs (CVE-2026-25536 guard)", async () => {
    // CVE-2026-25536: sharing one McpServer/transport across clients in
    // stateless deployments can leak cross-client response data (vulnerable
    // SDK <=1.25.3; fixed 1.26.0 — we pin ^1.29.0). Our http.ts constructs a
    // FRESH server + transport per POST, so the precondition is structurally
    // absent. This test pins that property: strictly interleaved requests
    // from two principals must never observe each other's data.
    const alice = await connectAs("alice", url);
    const bob = await connectAs("bob", url);

    const aCreated = await alice.callTool({
      name: "deck_create",
      arguments: { name: "A deck" },
    });
    const aId = (aCreated.structuredContent as { deck_id: string }).deck_id;
    const bCreated = await bob.callTool({
      name: "deck_create",
      arguments: { name: "B deck" },
    });
    const bId = (bCreated.structuredContent as { deck_id: string }).deck_id;
    expect(aId).not.toBe(bId);

    // Interleave mutations and reads A/B/A/B over the same shared stores.
    await alice.callTool({
      name: "deck_add",
      arguments: { deck_id: aId, cards: "Sol Ring" },
    });
    await bob.callTool({
      name: "deck_add",
      arguments: { deck_id: bId, cards: "Sol Ring" },
    });
    const aStatus = await alice.callTool({
      name: "deck_status",
      arguments: { deck_id: aId },
    });
    const bStatus = await bob.callTool({
      name: "deck_status",
      arguments: { deck_id: bId },
    });

    // Each principal's response references only their own deck…
    expect((aStatus.structuredContent as { deck_id: string; name: string }).name).toBe("A deck");
    expect((bStatus.structuredContent as { deck_id: string; name: string }).name).toBe("B deck");
    // …and never carries the other principal's identifiers anywhere in the payload.
    expect(JSON.stringify(aStatus.structuredContent)).not.toContain(bId);
    expect(JSON.stringify(bStatus.structuredContent)).not.toContain(aId);

    // Cross-reads and cross-lists stay walled off after the interleaving.
    const aList = await alice.callTool({ name: "deck_list", arguments: {} });
    const bList = await bob.callTool({ name: "deck_list", arguments: {} });
    expect(
      (aList.structuredContent as { decks: { deck_id: string }[] }).decks.map((d) => d.deck_id),
    ).toEqual([aId]);
    expect(
      (bList.structuredContent as { decks: { deck_id: string }[] }).decks.map((d) => d.deck_id),
    ).toEqual([bId]);
    const crossGet = await bob.callTool({
      name: "deck_get",
      arguments: { deck_id: aId },
    });
    expect(crossGet.isError).toBe(true);

    await alice.close();
    await bob.close();
  });

  it("defaults to the 'local' session when no principal header is sent", async () => {
    const transport = new StreamableHTTPClientTransport(url);
    const anon = new Client({ name: "anon", version: "0.0.0" });
    await anon.connect(transport);
    await anon.callTool({
      name: "deck_create",
      arguments: { name: "anon deck" },
    });
    // The default-session deck is the one DeckStore.list("local") returns.
    expect(deckStore.list("local")).toHaveLength(1);
    await anon.close();
  });
});

describe("optimistic concurrency (§11)", () => {
  it("rejects a stale expected_version without mutating, and accepts the current one", async () => {
    const server = createServer({
      index,
      deckStore,
      snapshot: staticSnapshotProvider("2026-06-27"),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0.0.0" });
    await client.connect(ct);

    const created = await client.callTool({
      name: "deck_create",
      arguments: { name: "D" },
    });
    const deckId = (created.structuredContent as { deck_id: string }).deck_id;
    // Fresh deck is version 1.

    // Stale expected_version -> conflict, no mutation.
    const stale = await client.callTool({
      name: "deck_add",
      arguments: {
        deck_id: deckId,
        cards: [{ oracle_id: "o-sol", qty: 1 }],
        expected_version: 99,
      },
    });
    expect(stale.structuredContent).toMatchObject({
      ok: false,
      conflict: true,
      current_version: 1,
    });
    expect(deckStore.get(deckId)?.cards ?? []).toHaveLength(0);

    // Correct expected_version -> applied.
    const ok = await client.callTool({
      name: "deck_add",
      arguments: {
        deck_id: deckId,
        cards: [{ oracle_id: "o-sol", qty: 1 }],
        expected_version: 1,
      },
    });
    expect((ok.structuredContent as { version: number }).version).toBe(2);
    expect(deckStore.get(deckId)?.cards).toHaveLength(1);

    await client.close();
  });
});
