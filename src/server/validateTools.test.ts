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
    oracle_text: "",
    legalities: { commander: "legal" },
    prices: { usd: "1.50" },
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
  {
    oracle_id: "o-recur",
    id: "p-recur",
    name: "Recurring Nightmare",
    cmc: 3,
    colors: ["B"],
    color_identity: ["B"],
    type_line: "Enchantment",
    oracle_text: "",
    legalities: { commander: "banned" },
    prices: { usd: "5.00" },
  },
  {
    oracle_id: "o-tymna",
    id: "p-tymna",
    name: "Tymna the Weaver",
    cmc: 3,
    colors: ["W", "B"],
    color_identity: ["W", "B"],
    type_line: "Legendary Creature — Human Cleric",
    oracle_text: "Partner",
    keywords: ["Partner"],
    legalities: { commander: "legal" },
    prices: { usd: "5.00" },
  },
  {
    oracle_id: "o-island",
    id: "p-island",
    name: "Island",
    cmc: 0,
    colors: [],
    color_identity: ["U"],
    type_line: "Basic Land — Island",
    oracle_text: "",
    legalities: { commander: "legal" },
    prices: { usd: "0.10" },
  },
];

let root: string;
let index: CardIndex;
let deckStore: DeckStore;
let client: Client;

interface Result {
  ok: boolean;
  violations: Array<{ rule: string; severity: string }>;
  errors?: unknown[];
  warnings?: unknown[];
  computed_color_identity?: string[];
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-valtools-"));
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
  await client.callTool({ name: "deck_create", arguments: { name: "D" } });
  // Mono-blue identity so R/B cards are off-color.
  deckStore.update("deck-1", (d) => ({ ...d, computed_color_identity: ["U"] }));
});
afterEach(async () => {
  await client.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

describe("validation tools", () => {
  it("registers validate_deck, validate_card, validate_commander", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["validate_deck", "validate_card", "validate_commander"]),
    );
  });

  it("validate_deck reports a banned card, an off-color card, and the card-count shortfall", async () => {
    deckStore.update("deck-1", (d) => ({
      ...d,
      cards: [
        { oracle_id: "o-recur", qty: 1 },
        { oracle_id: "o-bolt", qty: 1 },
      ],
    }));
    const res = await client.callTool({
      name: "validate_deck",
      arguments: { deck_id: "deck-1" },
    });
    const r = res.structuredContent as Result;
    const rules = r.violations.map((v) => v.rule);
    expect(rules).toContain("BANLIST");
    expect(rules).toContain("COLOR_IDENTITY");
    expect(rules).toContain("CARD_COUNT"); // authoritative gate: a 2-card deck is short of 100
    expect(r.ok).toBe(false);
    // Every violation today is a hard error; warnings stay empty until P5 advisories.
    expect(r.violations.every((v) => v.severity === "error")).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("validate_deck surfaces any-number exemptions for qty>1 exempt cards (review #14)", async () => {
    deckStore.update("deck-1", (d) => ({
      ...d,
      cards: [{ oracle_id: "o-island", qty: 12 }],
    }));
    const res = await client.callTool({
      name: "validate_deck",
      arguments: { deck_id: "deck-1" },
    });
    const r = res.structuredContent as Result & {
      exemptions: Array<{ oracle_id: string; reason: string; qty: number }>;
    };
    // 12 basic Islands: no SINGLETON violation, AND an explicit exemption note.
    expect(r.violations.some((v) => v.rule === "SINGLETON")).toBe(false);
    expect(r.exemptions).toEqual([
      { oracle_id: "o-island", name: "Island", qty: 12, reason: "basic_land" },
    ]);
  });

  it("validate_card is a read-only precheck that does not mutate the deck", async () => {
    const before = await client.callTool({
      name: "deck_get",
      arguments: { deck_id: "deck-1" },
    });
    const beforeCards = (before.structuredContent as { deck: { cards: unknown[] } }).deck.cards;

    const res = await client.callTool({
      name: "validate_card",
      arguments: { deck_id: "deck-1", oracle_id: "o-bolt" },
    });
    const r = res.structuredContent as Result;
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("COLOR_IDENTITY");

    const after = await client.callTool({
      name: "deck_get",
      arguments: { deck_id: "deck-1" },
    });
    const afterCards = (after.structuredContent as { deck: { cards: unknown[] } }).deck.cards;
    expect(afterCards).toEqual(beforeCards); // unchanged
  });

  it("validate_card returns ok for an on-identity / colorless card", async () => {
    const res = await client.callTool({
      name: "validate_card",
      arguments: { deck_id: "deck-1", oracle_id: "o-sol" },
    });
    expect((res.structuredContent as Result).ok).toBe(true);
  });

  it("validate_commander accepts commanders inline and reports a bad pairing", async () => {
    const bad = await client.callTool({
      name: "validate_commander",
      arguments: {
        commanders: ["o-tymna", "o-sol"],
        command_zone_kind: "partner",
      },
    });
    const r = bad.structuredContent as Result;
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("MULTI_COMMANDER");
  });

  it("validate_commander returns the combined identity for a legal single commander", async () => {
    const res = await client.callTool({
      name: "validate_commander",
      arguments: { commanders: ["o-tymna"] },
    });
    const r = res.structuredContent as Result;
    expect(r.ok).toBe(true);
    expect(r.computed_color_identity).toEqual(["W", "B"]);
  });

  it("validate_deck returns DECK_NOT_FOUND for an unknown deck", async () => {
    const res = await client.callTool({
      name: "validate_deck",
      arguments: { deck_id: "nope" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
  });
});
