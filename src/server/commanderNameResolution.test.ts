/**
 * Set-commander / validate-commander accept a card NAME, not just an oracle_id
 * (review #1, chunk:p8-commander-name-resolution).
 *
 * Regression guard for the identity bug: passing a commander by name used to
 * fall through getCard(name)->null and yield computed_color_identity [], which
 * then rejected every colored card. Now names resolve to oracle_ids (exact-first,
 * fuzzy fallback) and identity computes correctly; unknown/ambiguous names fail
 * loud with the existing error taxonomy.
 */
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
    oracle_id: "o-karumonix",
    id: "p-karumonix",
    name: "Karumonix, the Rat King",
    cmc: 4,
    colors: ["B"],
    color_identity: ["B"],
    type_line: "Legendary Creature — Phyrexian Rat",
    oracle_text: "Toxic 1. Other Rats you control have toxic 1.",
    legalities: { commander: "legal" },
    prices: { usd: "2.00" },
  },
  // Two fuzzy-colliding names (no exact match for 'Goblin Mat' -> AMBIGUOUS).
  {
    oracle_id: "o-matron",
    id: "p-matron",
    name: "Goblin Matron",
    cmc: 2,
    colors: ["R"],
    color_identity: ["R"],
    type_line: "Creature — Goblin",
    oracle_text: "When Goblin Matron enters, search your library for a Goblin card.",
    legalities: { commander: "legal" },
    prices: { usd: "0.50" },
  },
  {
    oracle_id: "o-matriarch",
    id: "p-matriarch",
    name: "Goblin Matriarch",
    cmc: 5,
    colors: ["R"],
    color_identity: ["R"],
    type_line: "Creature — Goblin",
    oracle_text: "Whenever Goblin Matriarch attacks, create a Goblin.",
    legalities: { commander: "legal" },
    prices: { usd: "0.30" },
  },
];

let root: string;
let index: CardIndex;
let deckStore: DeckStore;
let client: Client;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-cnr-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
  await store.publish("v1");
  index = CardIndex.open((await buildIndex({ store })).dbPath);
  deckStore = new DeckStore({ newId: () => "deck-1" });

  const server = createServer({ index, deckStore, snapshot: staticSnapshotProvider("2026-06-27") });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "cnr", version: "0.0.0" });
  await client.connect(ct);
  await client.callTool({ name: "deck_create", arguments: { name: "Rats" } });
});
afterEach(async () => {
  await client.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

type Sc = Record<string, unknown>;
const sc = (r: unknown): Sc => (r as { structuredContent?: unknown }).structuredContent as Sc;

describe("deck_set_commander accepts a name (review #1)", () => {
  it("computes the correct color identity when set by NAME", async () => {
    const res = sc(
      await client.callTool({
        name: "deck_set_commander",
        arguments: { deck_id: "deck-1", commanders: ["Karumonix, the Rat King"] },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.commanders).toEqual(["o-karumonix"]); // resolved to oracle_id
    expect(res.computed_color_identity).toEqual(["B"]); // not [] anymore

    const got = sc(await client.callTool({ name: "deck_get", arguments: { deck_id: "deck-1" } }));
    expect((got.deck as { computed_color_identity: string[] }).computed_color_identity).toEqual([
      "B",
    ]);
  });

  it("still accepts an oracle_id (regression)", async () => {
    const res = sc(
      await client.callTool({
        name: "deck_set_commander",
        arguments: { deck_id: "deck-1", commanders: ["o-karumonix"] },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.computed_color_identity).toEqual(["B"]);
  });

  it("fails loud with UNKNOWN_CARD for an unknown name", async () => {
    const res = await client.callTool({
      name: "deck_set_commander",
      arguments: { deck_id: "deck-1", commanders: ["Definitely Not A Card"] },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "UNKNOWN_CARD" });
  });

  it("fails loud with AMBIGUOUS_NAME (with candidates) for a fuzzy-colliding name", async () => {
    const res = await client.callTool({
      name: "deck_set_commander",
      arguments: { deck_id: "deck-1", commanders: ["Goblin Mat"] },
    });
    expect(res.isError).toBe(true);
    const detail = res.structuredContent as { code: string; details?: { candidates?: unknown[] } };
    expect(detail.code).toBe("AMBIGUOUS_NAME");
    expect((detail.details?.candidates ?? []).length).toBe(2);
  });
});

describe("validate_commander + deck_create accept a name", () => {
  it("validate_commander resolves a name to its identity", async () => {
    const res = sc(
      await client.callTool({
        name: "validate_commander",
        arguments: { commanders: ["Karumonix, the Rat King"], command_zone_kind: "single" },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.computed_color_identity).toEqual(["B"]);
  });

  it("deck_create stores commanders resolved to oracle_ids", async () => {
    const created = sc(
      await client.callTool({
        name: "deck_create",
        arguments: { name: "By Name", commanders: ["Karumonix, the Rat King"] },
      }),
    );
    const deckId = created.deck_id as string;
    const got = sc(await client.callTool({ name: "deck_get", arguments: { deck_id: deckId } }));
    expect((got.deck as { commanders: string[] }).commanders).toEqual(["o-karumonix"]);
  });
});
