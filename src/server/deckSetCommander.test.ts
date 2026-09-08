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
    oracle_id: "o-atraxa",
    id: "p-atraxa",
    name: "Atraxa, Praetors' Voice",
    cmc: 4,
    colors: ["W", "U", "B", "G"],
    color_identity: ["W", "U", "B", "G"],
    type_line: "Legendary Creature — Phyrexian Angel Horror",
    oracle_text: "Flying, vigilance, deathtouch, lifelink",
    legalities: { commander: "legal" },
    prices: { usd: "10.00" },
  },
  {
    oracle_id: "o-tymna",
    id: "p-tymna",
    name: "Tymna the Weaver",
    cmc: 3,
    colors: ["W", "B"],
    color_identity: ["W", "B"],
    type_line: "Legendary Creature — Human Cleric",
    oracle_text: "Partner (You can have two commanders if both have partner.)",
    keywords: ["Partner"],
    legalities: { commander: "legal" },
    prices: { usd: "5.00" },
  },
  {
    oracle_id: "o-thrasios",
    id: "p-thrasios",
    name: "Thrasios, Triton Hero",
    cmc: 2,
    colors: ["G", "U"],
    color_identity: ["G", "U"],
    type_line: "Legendary Creature — Merfolk Wizard",
    oracle_text: "Partner (You can have two commanders if both have partner.)",
    keywords: ["Partner"],
    legalities: { commander: "legal" },
    prices: { usd: "6.00" },
  },
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
];

let root: string;
let index: CardIndex;
let deckStore: DeckStore;
let client: Client;

interface SetResult {
  ok: boolean;
  deck_id: string;
  command_zone_kind?: string;
  computed_color_identity?: string[];
  version?: number;
  violations?: Array<{ rule: string }>;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-setcmd-"));
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
});
afterEach(async () => {
  await client.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

async function setCommander(commanders: string[], kind?: string): Promise<SetResult> {
  const res = await client.callTool({
    name: "deck_set_commander",
    arguments: {
      deck_id: "deck-1",
      commanders,
      ...(kind ? { command_zone_kind: kind } : {}),
    },
  });
  return res.structuredContent as SetResult;
}

describe("deck_set_commander", () => {
  it("registers the tool", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("deck_set_commander");
  });

  it("sets a legal single commander and recomputes the color identity", async () => {
    const r = await setCommander(["o-atraxa"]);
    expect(r.ok).toBe(true);
    expect(r.command_zone_kind).toBe("single");
    expect(r.computed_color_identity).toEqual(["W", "U", "B", "G"]);

    const got = await client.callTool({
      name: "deck_get",
      arguments: { deck_id: "deck-1" },
    });
    const deck = (got.structuredContent as { deck: { computed_color_identity: string[] } }).deck;
    expect(deck.computed_color_identity).toEqual(["W", "U", "B", "G"]);
  });

  it("rejects an ineligible commander with COMMANDER_ELIGIBILITY and does not apply it", async () => {
    const r = await setCommander(["o-sol"]);
    expect(r.ok).toBe(false);
    expect(r.violations?.map((v) => v.rule)).toContain("COMMANDER_ELIGIBILITY");
    const got = await client.callTool({
      name: "deck_get",
      arguments: { deck_id: "deck-1" },
    });
    const deck = (got.structuredContent as { deck: { commanders: string[] } }).deck;
    expect(deck.commanders).toEqual([]);
  });

  it("accepts a single commander as a bare string (no array)", async () => {
    const res = await client.callTool({
      name: "deck_set_commander",
      arguments: { deck_id: "deck-1", commanders: "o-atraxa" },
    });
    const r = res.structuredContent as SetResult;
    expect(r.ok).toBe(true);
    expect(r.command_zone_kind).toBe("single");
    expect(r.computed_color_identity).toEqual(["W", "U", "B", "G"]);
  });

  it("sets two Partner commanders and unions their identities", async () => {
    const r = await setCommander(["o-tymna", "o-thrasios"]);
    expect(r.ok).toBe(true);
    expect(r.command_zone_kind).toBe("partner");
    // Tymna WB + Thrasios GU -> WUBG in WUBRG order.
    expect(r.computed_color_identity).toEqual(["W", "U", "B", "G"]);
  });

  it("rejects a partner + non-partner pairing with MULTI_COMMANDER", async () => {
    const r = await setCommander(["o-tymna", "o-atraxa"], "partner");
    expect(r.ok).toBe(false);
    expect(r.violations?.map((v) => v.rule)).toContain("MULTI_COMMANDER");
  });

  it("returns DECK_NOT_FOUND for an unknown deck", async () => {
    const res = await client.callTool({
      name: "deck_set_commander",
      arguments: { deck_id: "nope", commanders: ["o-atraxa"] },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
  });
});
