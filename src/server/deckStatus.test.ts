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
    oracle_id: "o-island",
    id: "p-island",
    name: "Island",
    cmc: 0,
    colors: [],
    color_identity: ["U"],
    type_line: "Basic Land — Island",
    oracle_text: "({T}: Add {U}.)",
    legalities: { commander: "legal" },
    prices: { usd: "0.10" },
  },
];

let root: string;
let index: CardIndex;
let deckStore: DeckStore;
let client: Client;

interface Vitals {
  card_count: number;
  land_count: number;
  color_identity: string[];
  commander_count: number;
  legal: boolean;
  violation_count: number;
  version: number;
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await client.callTool({ name, arguments: args });
  return res.structuredContent as Record<string, unknown>;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-status-"));
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
});
afterEach(async () => {
  await client.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

describe("mutation vitals", () => {
  it("every mutation response carries vitals that match independently computed state", async () => {
    const created = await call("deck_create", { name: "Status deck" });
    expect(created.vitals).toMatchObject({
      card_count: 0,
      land_count: 0,
      commander_count: 0,
    });

    const setCmd = await call("deck_set_commander", {
      deck_id: "deck-1",
      commanders: "Atraxa, Praetors' Voice",
    });
    const cmdVitals = setCmd.vitals as Vitals;
    expect(cmdVitals.card_count).toBe(1); // command zone counts toward 100
    expect(cmdVitals.commander_count).toBe(1);
    expect(cmdVitals.color_identity).toEqual(["W", "U", "B", "G"]);
    expect(cmdVitals.legal).toBe(false); // 1/100 cards — CARD_COUNT error

    const added = await call("deck_add", {
      deck_id: "deck-1",
      cards: ["Sol Ring", { card: "Island", qty: 8 }],
    });
    const addVitals = added.vitals as Vitals;
    expect(addVitals.card_count).toBe(10); // 9 cards + commander
    expect(addVitals.land_count).toBe(8);
    expect(addVitals.version).toBe(added.version);

    // Cross-check against the authoritative gate: legal iff validate_deck ok.
    const validated = await call("validate_deck", { deck_id: "deck-1" });
    expect(addVitals.legal).toBe(validated.ok);
    expect(addVitals.violation_count).toBe((validated.errors as unknown[]).length);

    const removed = await call("deck_remove", { deck_id: "deck-1", cards: "Island" });
    expect((removed.vitals as Vitals).card_count).toBe(9);
    expect((removed.vitals as Vitals).land_count).toBe(7);

    const renamed = await call("deck_rename", { deck_id: "deck-1", name: "Renamed" });
    expect((renamed.vitals as Vitals).card_count).toBe(9);
  });

  it("a rejected set_commander still reports current-state vitals; conflicts carry none", async () => {
    await call("deck_create", { name: "D" });
    const rejected = await call("deck_set_commander", {
      deck_id: "deck-1",
      commanders: "Sol Ring", // not commander-eligible
    });
    expect(rejected.ok).toBe(false);
    expect((rejected.vitals as Vitals).commander_count).toBe(0);

    const conflict = await call("deck_rename", {
      deck_id: "deck-1",
      name: "X",
      expected_version: 999,
    });
    expect(conflict.conflict).toBe(true);
    expect(conflict.vitals).toBeUndefined();
  });
});

describe("deck_status", () => {
  it("returns the one-call dashboard, agreeing with the individual tools", async () => {
    await call("deck_create", { name: "Status deck" });
    await call("deck_set_commander", { deck_id: "deck-1", commanders: "o-atraxa" });
    await call("deck_add", {
      deck_id: "deck-1",
      cards: ["Sol Ring", { card: "Island", qty: 8 }],
    });

    const status = await call("deck_status", { deck_id: "deck-1" });
    expect(status.deck_id).toBe("deck-1");
    expect(status.name).toBe("Status deck");
    expect((status.vitals as Vitals).card_count).toBe(10);
    expect((status.vitals as Vitals).land_count).toBe(8);

    const legality = status.legality as {
      ok: boolean;
      errors: unknown[];
      error_count: number;
      warning_count: number;
    };
    const validated = await call("validate_deck", { deck_id: "deck-1" });
    expect(legality.ok).toBe(validated.ok);
    expect(legality.error_count).toBe((validated.errors as unknown[]).length);
    expect(legality.errors.length).toBeLessThanOrEqual(20);

    const curve = status.curve as { buckets: Record<string, number>; avg_mv: number };
    const analyzedCurve = await call("analyze_curve", { deck_id: "deck-1" });
    expect(curve.buckets).toEqual(analyzedCurve.buckets);
    const stats = await call("analyze_stats", { deck_id: "deck-1" });
    expect(curve.avg_mv).toBe(stats.avg_mv);

    const mana = status.mana as {
      sources_by_color: Record<string, number>;
      under_supported: string[];
    };
    const analyzedMana = await call("analyze_mana_base", { deck_id: "deck-1" });
    expect(mana.sources_by_color).toEqual(analyzedMana.sources);
    expect(mana.under_supported).toEqual(analyzedMana.under_supported);

    const price = status.price as { total_usd: number; min_buy_usd: number };
    expect(price.total_usd).toBe(stats.total_price_usd);
    expect(price.min_buy_usd).toBe(stats.min_buy_usd);

    const roles = status.roles as { gaps: Array<{ status: string }> };
    expect(roles.gaps.every((g) => g.status === "under")).toBe(true);
  });

  it("returns DECK_NOT_FOUND for an unknown deck", async () => {
    const res = await client.callTool({ name: "deck_status", arguments: { deck_id: "nope" } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
  });
});

describe("agent-shaped end-to-end flow (zero resolve round-trips)", () => {
  it("create → commander by name → add by names (one typo) → deck_status", async () => {
    const created = await call("deck_create", { name: "Agent deck" });
    expect(created.deck_id).toBe("deck-1");

    const cmd = await call("deck_set_commander", {
      deck_id: "deck-1",
      commanders: "Atraxa, Praetors' Voice",
    });
    expect(cmd.ok).toBe(true);

    const added = await call("deck_add", {
      deck_id: "deck-1",
      cards: ["Sol Ring", "Sol Rng", { card: "Island", qty: 5 }],
    });
    const verdicts = added.verdicts as Array<{ oracle_id: string; status: string }>;
    expect(verdicts.map((v) => v.oracle_id).sort()).toEqual(["o-island", "o-sol"]);
    const failed = added.failed as Array<{
      input: string;
      reason: string;
      suggestions: Array<{ name: string }>;
    }>;
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toBe("UNKNOWN_CARD");
    expect(failed[0]!.suggestions.map((s) => s.name)).toContain("Sol Ring");

    const status = await call("deck_status", { deck_id: "deck-1" });
    expect((status.vitals as Vitals).card_count).toBe(7); // 6 cards + commander
    expect((status.vitals as Vitals).legal).toBe(false); // far from 100
  });
});
