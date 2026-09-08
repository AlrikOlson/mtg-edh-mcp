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
    oracle_id: "o-plains",
    id: "p-plains",
    name: "Plains",
    cmc: 0,
    colors: [],
    color_identity: [],
    type_line: "Basic Land — Plains",
    oracle_text: "",
    legalities: { commander: "legal" },
    prices: { usd: "0.10" },
  },
];

let root: string;
let index: CardIndex;
let deckStore: DeckStore;
let client: Client;

interface Verdict {
  oracle_id: string;
  name?: string;
  status: string;
  violations?: Array<{ rule: string }>;
}
interface AddResult {
  deck_id: string;
  version: number;
  verdicts: Verdict[];
  failed: Array<{
    input: string;
    reason: string;
    suggestions?: Array<{ name: string }>;
    candidates?: Array<{ name: string }>;
  }>;
}
interface DeckCards {
  deck: { cards: Array<{ oracle_id: string; qty: number; illegal?: boolean }> };
}

async function deckCards(deckId: string): Promise<DeckCards["deck"]["cards"]> {
  const got = await client.callTool({
    name: "deck_get",
    arguments: { deck_id: deckId },
  });
  return (got.structuredContent as DeckCards).deck.cards;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-addrm-"));
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

  // A mono-blue deck so off-color (R/B) cards trip the identity rule.
  await client.callTool({ name: "deck_create", arguments: { name: "Mono U" } });
  deckStore.update("deck-1", (d) => ({ ...d, computed_color_identity: ["U"] }));
});
afterEach(async () => {
  await client.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

async function add(cards: unknown, force?: boolean): Promise<AddResult> {
  const res = await client.callTool({
    name: "deck_add",
    arguments: { deck_id: "deck-1", cards, ...(force ? { force: true } : {}) },
  });
  return res.structuredContent as AddResult;
}

describe("deck_add / deck_remove tools", () => {
  it("registers deck_add and deck_remove", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["deck_add", "deck_remove"]));
  });

  it("adds a legal card with an ok verdict and applies it", async () => {
    const r = await add([{ oracle_id: "o-sol", qty: 1 }]);
    expect(r.verdicts).toEqual([{ oracle_id: "o-sol", name: "Sol Ring", status: "ok" }]);
    expect(await deckCards("deck-1")).toEqual([{ oracle_id: "o-sol", qty: 1, name: "Sol Ring" }]);
  });

  it("accepts a bare card name string (singular, no array, no resolve round-trip)", async () => {
    const r = await add("Sol Ring");
    expect(r.verdicts).toEqual([{ oracle_id: "o-sol", name: "Sol Ring", status: "ok" }]);
    expect(r.failed).toEqual([]);
    expect(await deckCards("deck-1")).toEqual([{ oracle_id: "o-sol", qty: 1, name: "Sol Ring" }]);
  });

  it("accepts a mixed name+id batch and reports a typo in failed[] with suggestions, applying the rest", async () => {
    const r = await add(["Sol Rng", { card: "Plains", qty: 3 }, { oracle_id: "o-sol", qty: 1 }]);
    expect(r.verdicts.map((v) => v.oracle_id).sort()).toEqual(["o-plains", "o-sol"]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({
      input: "Sol Rng",
      reason: "UNKNOWN_CARD",
    });
    expect(r.failed[0]?.suggestions?.map((s) => s.name)).toContain("Sol Ring");
    const cards = await deckCards("deck-1");
    expect(cards).toEqual(
      expect.arrayContaining([
        { oracle_id: "o-sol", qty: 1, name: "Sol Ring" },
        { oracle_id: "o-plains", qty: 3, name: "Plains" },
      ]),
    );
  });

  it("merges duplicate references (name + id of the same card) by summing qty", async () => {
    const r = await add([
      { card: "Plains", qty: 2 },
      { oracle_id: "o-plains", qty: 3 },
    ]);
    expect(r.verdicts).toHaveLength(1);
    expect(await deckCards("deck-1")).toEqual([{ oracle_id: "o-plains", qty: 5, name: "Plains" }]);
  });

  it("rejects an off-color card with a COLOR_IDENTITY violation and does not apply it", async () => {
    const r = await add([{ oracle_id: "o-bolt", qty: 1 }]);
    expect(r.verdicts[0]?.status).toBe("rejected");
    expect(r.verdicts[0]?.violations?.map((v) => v.rule)).toContain("COLOR_IDENTITY");
    expect(await deckCards("deck-1")).toEqual([]);
  });

  it("rejects a banned card with a BANLIST violation", async () => {
    const r = await add([{ oracle_id: "o-recur", qty: 1 }]);
    expect(r.verdicts[0]?.status).toBe("rejected");
    expect(r.verdicts[0]?.violations?.map((v) => v.rule)).toContain("BANLIST");
    expect(await deckCards("deck-1")).toEqual([]);
  });

  it("force:true applies a violating card flagged illegal rather than dropping it", async () => {
    const r = await add([{ oracle_id: "o-bolt", qty: 1 }], true);
    expect(r.verdicts[0]?.status).toBe("added_illegal");
    const cards = await deckCards("deck-1");
    expect(cards).toEqual([{ oracle_id: "o-bolt", qty: 1, name: "Lightning Bolt", illegal: true }]);
  });

  it("is idempotent: re-adding an exempt card merges quantity into one entry", async () => {
    await add([{ oracle_id: "o-plains", qty: 2 }]);
    const r = await add([{ oracle_id: "o-plains", qty: 3 }]);
    expect(r.verdicts[0]?.status).toBe("ok");
    expect(await deckCards("deck-1")).toEqual([{ oracle_id: "o-plains", qty: 5, name: "Plains" }]);
  });

  it("flags a non-exempt duplicate as a SINGLETON violation", async () => {
    await add([{ oracle_id: "o-sol", qty: 1 }]);
    const r = await add([{ oracle_id: "o-sol", qty: 1 }]); // would make qty 2
    expect(r.verdicts[0]?.status).toBe("rejected");
    expect(r.verdicts[0]?.violations?.map((v) => v.rule)).toContain("SINGLETON");
    // Still a single copy — the rejected add was not applied.
    expect((await deckCards("deck-1"))[0]?.qty).toBe(1);
  });

  it("deck_remove decrements quantity and drops entries at zero", async () => {
    await add([{ oracle_id: "o-plains", qty: 5 }]);
    await client.callTool({
      name: "deck_remove",
      arguments: {
        deck_id: "deck-1",
        cards: [{ oracle_id: "o-plains", qty: 2 }],
      },
    });
    expect((await deckCards("deck-1"))[0]?.qty).toBe(3);

    // Bare name string removes one copy (qty defaults to 1).
    await client.callTool({
      name: "deck_remove",
      arguments: { deck_id: "deck-1", cards: "Plains" },
    });
    expect((await deckCards("deck-1"))[0]?.qty).toBe(2);
    await client.callTool({
      name: "deck_remove",
      arguments: { deck_id: "deck-1", cards: [{ card: "Plains", qty: 1 }] },
    });
    expect((await deckCards("deck-1"))[0]?.qty).toBe(1);

    await client.callTool({
      name: "deck_remove",
      arguments: {
        deck_id: "deck-1",
        cards: [{ oracle_id: "o-plains", qty: 10 }],
      },
    });
    expect(await deckCards("deck-1")).toEqual([]);
  });

  it("deck_add / deck_remove on an unknown deck return DECK_NOT_FOUND", async () => {
    const a = await client.callTool({
      name: "deck_add",
      arguments: { deck_id: "nope", cards: [{ oracle_id: "o-sol", qty: 1 }] },
    });
    expect(a.isError).toBe(true);
    expect(a.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });

    const r = await client.callTool({
      name: "deck_remove",
      arguments: { deck_id: "nope", cards: [{ oracle_id: "o-sol", qty: 1 }] },
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
  });
});
