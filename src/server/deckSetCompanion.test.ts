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
    oracle_id: "o-gyruda",
    id: "p-gyruda",
    name: "Gyruda, Doom of Depths",
    cmc: 6,
    colors: ["U", "B"],
    color_identity: ["U", "B"],
    type_line: "Legendary Creature — Demon",
    oracle_text:
      "Companion — Each card in your starting deck has an even mana value. When Gyruda enters, each player mills four cards.",
    legalities: { commander: "legal" },
    prices: { usd: "2.00" },
  },
  {
    oracle_id: "o-even",
    id: "p-even",
    name: "Even Spell",
    cmc: 2,
    colors: ["U"],
    color_identity: ["U"],
    type_line: "Sorcery",
    oracle_text: "Draw two cards.",
    legalities: { commander: "legal" },
    prices: { usd: "0.10" },
  },
  {
    oracle_id: "o-odd",
    id: "p-odd",
    name: "Odd Spell",
    cmc: 3,
    colors: ["B"],
    color_identity: ["B"],
    type_line: "Sorcery",
    oracle_text: "Destroy target creature.",
    legalities: { commander: "legal" },
    prices: { usd: "0.10" },
  },
  {
    oracle_id: "o-island",
    id: "p-island",
    name: "Island",
    cmc: 0,
    colors: [],
    color_identity: [],
    type_line: "Basic Land — Island",
    oracle_text: "",
    legalities: { commander: "legal" },
    prices: { usd: "0.05" },
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
];

interface CompanionResult {
  ok: boolean;
  deck_id: string;
  companion?: { oracle_id: string; name: string } | null;
  condition_met?: boolean;
  violations?: Array<{ rule: string }>;
  version?: number;
  detail?: string;
}

let root: string;
let index: CardIndex;
let deckStore: DeckStore;
let client: Client;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-companion-"));
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
  await client.callTool({ name: "deck_create", arguments: { name: "D" } });
});
afterEach(async () => {
  await client.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

async function add(oracleId: string): Promise<void> {
  // force:true so the card lands in the deck regardless of the (commander-less)
  // color-identity precheck — we are testing the companion condition, not identity.
  await client.callTool({
    name: "deck_add",
    arguments: { deck_id: "deck-1", cards: [{ oracle_id: oracleId, qty: 1 }], force: true },
  });
}

async function setCompanion(companion?: string): Promise<CompanionResult> {
  const res = await client.callTool({
    name: "deck_set_companion",
    arguments: { deck_id: "deck-1", ...(companion === undefined ? {} : { companion }) },
  });
  return res.structuredContent as CompanionResult;
}

describe("deck_set_companion", () => {
  it("registers the tool", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("deck_set_companion");
  });

  it("declares a companion by name and reports the condition is met", async () => {
    await add("o-even");
    await add("o-island");
    const r = await setCompanion("Gyruda, Doom of Depths");
    expect(r.ok).toBe(true);
    expect(r.companion).toMatchObject({ name: "Gyruda, Doom of Depths" });
    expect(r.condition_met).toBe(true);
  });

  it("flags a deck that breaks the companion's condition", async () => {
    await add("o-odd"); // odd MV breaks Gyruda's even-MV restriction
    const r = await setCompanion("o-gyruda");
    expect(r.ok).toBe(true); // declaring still succeeds
    expect(r.condition_met).toBe(false);
    expect(r.violations?.map((v) => v.rule)).toContain("COMPANION");

    // validate_deck surfaces it as a COMPANION error.
    const v = await client.callTool({ name: "validate_deck", arguments: { deck_id: "deck-1" } });
    const rules = (v.structuredContent as { violations: Array<{ rule: string }> }).violations.map(
      (x) => x.rule,
    );
    expect(rules).toContain("COMPANION");
  });

  it("rejects a card that is not a companion", async () => {
    const r = await setCompanion("Sol Ring");
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/not a companion/i);
  });

  it("clears the companion", async () => {
    await setCompanion("o-gyruda");
    const r = await setCompanion("");
    expect(r.ok).toBe(true);
    expect(r.companion).toBeNull();
  });

  it("validate_deck has no COMPANION violation when none is declared", async () => {
    await add("o-odd");
    const v = await client.callTool({ name: "validate_deck", arguments: { deck_id: "deck-1" } });
    const rules = (v.structuredContent as { violations: Array<{ rule: string }> }).violations.map(
      (x) => x.rule,
    );
    expect(rules).not.toContain("COMPANION");
  });
});
