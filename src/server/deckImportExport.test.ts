import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

const card = (oracle_id: string, id: string, name: string) => ({
  oracle_id,
  id,
  name,
  cmc: 1,
  colors: [],
  color_identity: [],
  type_line: "Instant",
  oracle_text: "",
  legalities: { commander: "legal" },
  prices: { usd: "0.10" },
});
const ORACLE = [
  card("o-sol", "p-sol", "Sol Ring"),
  card("o-bolt", "p-bolt", "Lightning Bolt"),
  card("o-chain", "p-chain", "Chain Lightning"),
];

let root: string;
let index: CardIndex;
let deckStore: DeckStore;
let client: Client;

interface ImportResult {
  deck_id: string;
  resolved_count: number;
  unresolved: Array<{
    line: string;
    name: string;
    reason: string;
    candidates?: unknown[];
  }>;
}
interface ExportResult {
  deck_id: string;
  format: string;
  text: string;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-deckio-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
  await store.publish("v1");
  index = CardIndex.open((await buildIndex({ store })).dbPath);

  let n = 0;
  deckStore = new DeckStore({ newId: () => `deck-${++n}` });

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

const LIST = [
  "// My deck",
  "Deck",
  "1 Sol Ring",
  "1x Lightning Bolt",
  "1 Sol Ring (C21) 263", // MTGO/Arena style — merges with the first Sol Ring
  "1 Notacard Xyz", // unknown
  "2 Lightning", // ambiguous (Lightning Bolt + Chain Lightning)
].join("\n");

describe("deck import / export tools", () => {
  it("rolls back the new deck when a compound import fails before adding its cards", async () => {
    const notices: string[] = [];
    deckStore.onDirty(() => notices.push("dirty"));
    const update = vi.spyOn(deckStore, "update").mockImplementationOnce(() => {
      throw new Error("injected update failure");
    });
    try {
      const result = await client.callTool({
        name: "deck_import",
        arguments: { name: "Must not survive", text: "1 Sol Ring" },
      });
      expect(result.isError).toBe(true);
      expect(deckStore.list()).toEqual([]);
      expect(notices).toEqual([]);
    } finally {
      update.mockRestore();
    }
  });

  it("registers deck_import and deck_export", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["deck_import", "deck_export"]));
  });

  it("imports a mixed-format list, resolving and reporting unresolved lines", async () => {
    const res = await client.callTool({
      name: "deck_import",
      arguments: { text: LIST, name: "Imp" },
    });
    const r = res.structuredContent as ImportResult;

    // Two distinct resolved cards: Sol Ring (qty 2, merged) + Lightning Bolt (qty 1).
    expect(r.deck_id).toBe("deck-1");
    expect(r.resolved_count).toBe(2);

    // Unresolved: the bogus line (UNKNOWN_CARD) + the ambiguous "Lightning" (AMBIGUOUS_NAME).
    const reasons = r.unresolved.map((u) => u.reason).sort();
    expect(reasons).toEqual(["AMBIGUOUS_NAME", "UNKNOWN_CARD"]);
    const ambiguous = r.unresolved.find((u) => u.reason === "AMBIGUOUS_NAME");
    expect(ambiguous?.candidates).toHaveLength(2);

    // The merged Sol Ring quantity survives (1 + 1 = 2).
    const got = await client.callTool({
      name: "deck_get",
      arguments: { deck_id: "deck-1" },
    });
    const cards = (
      got.structuredContent as {
        deck: { cards: { oracle_id: string; qty: number }[] };
      }
    ).deck.cards;
    expect(cards.find((c) => c.oracle_id === "o-sol")?.qty).toBe(2);
  });

  it("round-trips import -> export -> import preserving quantities", async () => {
    const first = (
      (
        await client.callTool({
          name: "deck_import",
          arguments: { text: LIST },
        })
      ).structuredContent as ImportResult
    ).deck_id;

    const exported = (
      (
        await client.callTool({
          name: "deck_export",
          arguments: { deck_id: first },
        })
      ).structuredContent as ExportResult
    ).text;
    expect(exported).toContain("2 Sol Ring");
    expect(exported).toContain("1 Lightning Bolt");

    // Re-import the exported text into a brand-new deck; cards must match.
    const second = await client.callTool({
      name: "deck_import",
      arguments: { text: exported },
    });
    const sr = second.structuredContent as ImportResult;
    expect(sr.unresolved).toEqual([]);
    const got = await client.callTool({
      name: "deck_get",
      arguments: { deck_id: sr.deck_id },
    });
    const cards = (
      got.structuredContent as {
        deck: { cards: { oracle_id: string; qty: number }[] };
      }
    ).deck.cards;
    expect(cards.find((c) => c.oracle_id === "o-sol")?.qty).toBe(2);
    expect(cards.find((c) => c.oracle_id === "o-bolt")?.qty).toBe(1);
  });

  it("imports into an existing deck, merging quantities", async () => {
    await client.callTool({ name: "deck_create", arguments: { name: "Base" } });
    await client.callTool({
      name: "deck_import",
      arguments: { deck_id: "deck-1", text: "1 Sol Ring" },
    });
    await client.callTool({
      name: "deck_import",
      arguments: { deck_id: "deck-1", text: "3 Sol Ring" },
    });
    const got = await client.callTool({
      name: "deck_get",
      arguments: { deck_id: "deck-1" },
    });
    const cards = (
      got.structuredContent as {
        deck: { cards: { oracle_id: string; qty: number }[] };
      }
    ).deck.cards;
    expect(cards).toEqual([{ oracle_id: "o-sol", qty: 4, name: "Sol Ring" }]);
  });

  it("deck_import into an unknown deck and deck_export of an unknown deck return DECK_NOT_FOUND", async () => {
    const imp = await client.callTool({
      name: "deck_import",
      arguments: { deck_id: "nope", text: "1 Sol Ring" },
    });
    expect(imp.isError).toBe(true);
    expect(imp.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });

    const exp = await client.callTool({
      name: "deck_export",
      arguments: { deck_id: "nope" },
    });
    expect(exp.isError).toBe(true);
    expect(exp.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
  });
});
