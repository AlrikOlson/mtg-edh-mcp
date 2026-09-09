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
    mana_cost: "{1}",
    legalities: { commander: "legal" },
    prices: { usd: "1.50" },
  },
  {
    oracle_id: "o-forest",
    id: "p-forest",
    name: "Forest",
    cmc: 0,
    colors: [],
    color_identity: ["G"],
    type_line: "Basic Land — Forest",
    oracle_text: "({T}: Add {G}.)",
    mana_cost: "",
    legalities: { commander: "legal" },
    prices: { usd: "0.10" },
  },
  {
    oracle_id: "o-counter",
    id: "p-counter",
    name: "Counterspell",
    cmc: 2,
    colors: ["U"],
    color_identity: ["U"],
    type_line: "Instant",
    oracle_text: "Counter target spell.",
    mana_cost: "{U}{U}",
    legalities: { commander: "legal" },
    prices: { usd: "1.00" },
  },
];

let root: string;
let index: CardIndex;
let deckStore: DeckStore;
let client: Client;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-analyze-"));
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
  // 1 Sol Ring + 4 Forest + 1 Counterspell.
  deckStore.update("deck-1", (d) => ({
    ...d,
    cards: [
      { oracle_id: "o-sol", qty: 1 },
      { oracle_id: "o-forest", qty: 4 },
      { oracle_id: "o-counter", qty: 1 },
    ],
  }));
});
afterEach(async () => {
  await client.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

describe("whole-deck budget MCP contract", () => {
  it("keeps full value separate from membership acquisition without mutating deck versions", async () => {
    deckStore.update("deck-1", (d) => ({
      ...d,
      commanders: ["o-sol"],
      cards: [{ oracle_id: "o-forest", qty: 99 }],
    }));
    await client.callTool({
      name: "collection_set",
      arguments: { cards: ["o-forest"] },
    });
    const before = deckStore.get("deck-1");
    const response = await client.callTool({
      name: "budget_plan",
      arguments: { deck_id: "deck-1", target_usd: 2, use_collection: true },
    });
    expect(response.structuredContent).toMatchObject({
      version: before?.version,
      price_scope: "library",
      acquire_usd: 0,
      full_deck: {
        min_buy_usd: 11.4,
        acquire_usd: 1.5,
        owned_value_usd: 9.9,
        target_met: false,
        acquire_target_met: true,
        ownership_basis: "oracle_id_membership_all_copies",
      },
    });
    expect(deckStore.get("deck-1")).toEqual(before);
    const conflict = await client.callTool({
      name: "deck_rename",
      arguments: {
        deck_id: "deck-1",
        name: "Stale write",
        expected_version: 0,
      },
    });
    expect(conflict.structuredContent).toMatchObject({
      ok: false,
      conflict: true,
    });
    const after = await client.callTool({
      name: "budget_plan",
      arguments: { deck_id: "deck-1", target_usd: 2, use_collection: true },
    });
    expect(after.structuredContent).toEqual(response.structuredContent);
  });

  it("includes both commanders, keeps library compatibility, and excludes a companion", async () => {
    deckStore.update("deck-1", (d) => ({
      ...d,
      commanders: ["o-sol", "o-counter"],
      command_zone_kind: "partner",
      cards: [{ oracle_id: "o-forest", qty: 98 }],
      companion: "o-sol",
    }));
    const response = await client.callTool({
      name: "budget_plan",
      arguments: { deck_id: "deck-1", target_usd: 10 },
    });
    expect(response.structuredContent).toMatchObject({
      price_scope: "library",
      min_buy_usd: 9.8,
      library: { min_buy_usd: 9.8 },
      command_zone: { min_buy_usd: 2.5 },
      full_deck: {
        min_buy_usd: 12.3,
        target_met: false,
        over_min_buy_by_usd: 2.3,
      },
      companion: { min_buy_usd: 1.5 },
      scope: { full_deck_quantity: 100, companion_included: false },
    });
    const jsonBlock = response.content.find(
      (block) => block.type === "text" && block.text.startsWith("{"),
    );
    expect(jsonBlock?.type === "text" ? JSON.parse(jsonBlock.text) : null).toEqual(
      response.structuredContent,
    );
    for (const name of ["analyze_stats", "deck_status"]) {
      const result = await client.callTool({
        name,
        arguments: { deck_id: "deck-1" },
      });
      expect(result.structuredContent).toMatchObject(
        name === "analyze_stats"
          ? {
              min_buy_usd: 9.8,
              price_scope: "library",
              budget: { full_deck: { min_buy_usd: 12.3 } },
            }
          : {
              price: {
                min_buy_usd: 9.8,
                price_scope: "library",
                full_deck: { min_buy_usd: 12.3 },
              },
            },
      );
    }
  });

  it("discloses unknown commanders and timestamp coverage without claiming within budget", async () => {
    deckStore.update("deck-1", (d) => ({
      ...d,
      commanders: ["missing-commander"],
    }));
    const response = await client.callTool({
      name: "budget_plan",
      arguments: { deck_id: "deck-1", target_usd: 100 },
    });
    expect(response.structuredContent).toMatchObject({
      full_deck: {
        target_met: null,
        over_min_buy_by_usd: null,
        coverage: {
          complete: false,
          unresolved: [{ oracle_id: "missing-commander", qty: 1 }],
        },
        pricing: {
          currency: "USD",
          data_snapshot: "2026-06-27",
          price_timestamp: null,
        },
        freshness: { status: "unknown" },
      },
    });
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("incomplete"),
    });
  });
});

describe("analysis tools", () => {
  it("registers analyze_curve, analyze_composition, analyze_stats", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["analyze_curve", "analyze_composition", "analyze_stats"]),
    );
  });

  it("analyze_curve returns exact quantity-weighted buckets + filters", async () => {
    const all = await client.callTool({
      name: "analyze_curve",
      arguments: { deck_id: "deck-1" },
    });
    expect((all.structuredContent as { buckets: Record<string, number> }).buckets).toEqual({
      "0": 4,
      "1": 1,
      "2": 1,
    });
    const noLands = await client.callTool({
      name: "analyze_curve",
      arguments: { deck_id: "deck-1", exclude_lands: true },
    });
    expect((noLands.structuredContent as { buckets: Record<string, number> }).buckets).toEqual({
      "1": 1,
      "2": 1,
    });
  });

  it("analyze_composition returns exact type + role counts", async () => {
    const res = await client.callTool({
      name: "analyze_composition",
      arguments: { deck_id: "deck-1" },
    });
    const r = res.structuredContent as {
      by_type: Record<string, number>;
      by_role: Record<string, number>;
    };
    expect(r.by_type).toEqual({ Artifact: 1, Land: 4, Instant: 1 });
    expect(r.by_role.ramp).toBe(1);
    expect(r.by_role.land).toBe(4);
    expect(r.by_role.counterspell).toBe(1);
  });

  it("analyze_stats returns exact averages, pips, and price", async () => {
    const res = await client.callTool({
      name: "analyze_stats",
      arguments: { deck_id: "deck-1" },
    });
    const r = res.structuredContent as {
      total_cards: number;
      avg_mv: number;
      color_pips: Record<string, number>;
      total_price_usd: number;
    };
    expect(r.total_cards).toBe(6);
    expect(r.avg_mv).toBe(0.5);
    expect(r.color_pips.U).toBe(2);
    expect(r.total_price_usd).toBe(2.9);
  });

  it("returns DECK_NOT_FOUND for an unknown deck", async () => {
    const res = await client.callTool({
      name: "analyze_stats",
      arguments: { deck_id: "nope" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
  });
});

describe("simulate_deck (goldfish)", () => {
  it("is registered", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("simulate_deck");
  });

  it("returns goldfish stats for a deck", async () => {
    const res = await client.callTool({
      name: "simulate_deck",
      arguments: { deck_id: "deck-1", trials: 100, seed: 5 },
    });
    const r = res.structuredContent as {
      deck_id: string;
      trials: number;
      keepable_rate: number;
      dead_on_arrival_rate: number;
      lands_by_turn: Record<string, number>;
    };
    expect(r.deck_id).toBe("deck-1");
    expect(r.trials).toBe(100);
    expect(r.keepable_rate).toBeGreaterThanOrEqual(0);
    expect(r.keepable_rate).toBeLessThanOrEqual(1);
    expect(Object.keys(r.lands_by_turn).length).toBeGreaterThan(0);
  });

  it("is deterministic through the tool boundary (same seed → identical output)", async () => {
    const args = { deck_id: "deck-1", trials: 100, seed: 5 };
    const a = await client.callTool({ name: "simulate_deck", arguments: args });
    const b = await client.callTool({ name: "simulate_deck", arguments: args });
    expect(b.structuredContent).toEqual(a.structuredContent);
  });

  it("returns DECK_NOT_FOUND for an unknown deck", async () => {
    const res = await client.callTool({
      name: "simulate_deck",
      arguments: { deck_id: "nope" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
  });
});

describe("budget_plan", () => {
  it("is registered and reports budget figures for a deck", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("budget_plan");
    const res = await client.callTool({
      name: "budget_plan",
      arguments: { deck_id: "deck-1", target_usd: 1 },
    });
    const r = res.structuredContent as {
      min_buy_usd: number;
      default_total_usd: number;
      reprint_savings_usd: number;
      cost_drivers: unknown[];
      over_min_buy_by_usd: number | null;
    };
    expect(typeof r.min_buy_usd).toBe("number");
    expect(r.default_total_usd).toBeGreaterThanOrEqual(r.min_buy_usd);
    expect(Array.isArray(r.cost_drivers)).toBe(true);
    expect(r.over_min_buy_by_usd).not.toBeNull();
  });

  it("returns DECK_NOT_FOUND for an unknown deck", async () => {
    const res = await client.callTool({
      name: "budget_plan",
      arguments: { deck_id: "nope" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
  });

  it("use_collection treats owned cards as acquired ($0), off by default (bl-collection-budget)", async () => {
    interface Plan {
      acquire_usd: number | null;
      owned_value_usd: number | null;
      min_buy_usd: number;
    }
    const plan = async (args: Record<string, unknown>): Promise<Plan> =>
      (
        await client.callTool({
          name: "budget_plan",
          arguments: { deck_id: "deck-1", ...args },
        })
      ).structuredContent as Plan;

    // No collection yet: use_collection is a no-op (acquire null, identical to today).
    expect((await plan({ use_collection: true })).acquire_usd).toBeNull();

    // Own Sol Ring + the Forests → only Counterspell remains to acquire.
    await client.callTool({
      name: "collection_set",
      arguments: { cards: ["o-sol", "o-forest"] },
    });
    const owned = await plan({ use_collection: true });
    expect(owned.acquire_usd).toBe(1.0); // just Counterspell
    expect(owned.owned_value_usd).toBe(owned.min_buy_usd - 1.0);

    // Flag off → acquire stays null even with a collection set.
    expect((await plan({})).acquire_usd).toBeNull();
  });
});
