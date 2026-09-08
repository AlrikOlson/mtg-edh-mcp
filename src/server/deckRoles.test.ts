import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { DeckStore } from "../deck/index.js";
import { createServer } from "./createServer.js";
import { makeDeckTools } from "./deckTools.js";

const ORACLE = [
  {
    oracle_id: "o-sol",
    id: "p-sol",
    name: "Sol Ring",
    cmc: 1,
    type_line: "Artifact",
    oracle_text: "{T}: Add {C}{C}.",
    color_identity: [],
    prices: { usd: "1.50" },
  },
  {
    oracle_id: "o-island",
    id: "p-island",
    name: "Island",
    cmc: 0,
    type_line: "Basic Land — Island",
    oracle_text: "({T}: Add {U}.)",
    color_identity: ["U"],
    prices: { usd: "0.10" },
  },
  {
    oracle_id: "o-tower",
    id: "p-tower",
    name: "Command Tower",
    cmc: 0,
    type_line: "Land",
    oracle_text: "{T}: Add one mana of any color in your commander's color identity.",
    color_identity: [],
    prices: { usd: "0.50" },
  },
  {
    oracle_id: "o-chief",
    id: "p-chief",
    name: "Test Commander",
    cmc: 3,
    type_line: "Legendary Creature — Human",
    oracle_text: "",
    color_identity: ["U"],
    prices: { usd: "1.00" },
  },
].map((card) => ({ ...card, colors: [], legalities: { commander: "legal" } }));

let root: string;
let index: CardIndex;
let store: DeckStore;
let client: Client;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-roles-"));
  const data = new VersionedStore(root);
  await data.createVersion("v1");
  await writeFile(data.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE));
  await writeFile(data.filePath("v1", "default_cards.json"), "[]");
  await data.publish("v1");
  index = CardIndex.open((await buildIndex({ store: data })).dbPath);
  let counter = 0;
  store = new DeckStore({ newId: () => `deck-${++counter}` });
  const server = createServer({ index, deckStore: store });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "role-test", version: "1" });
  await client.connect(clientTransport);
  store.create({ name: "Role test", commanders: ["o-chief"], computedColorIdentity: ["U"] });
  store.update("deck-1", (deck) => ({
    ...deck,
    companion: "o-tower",
    cards: [
      { oracle_id: "o-sol", qty: 1 },
      { oracle_id: "o-island", qty: 4 },
    ],
  }));
});

afterEach(async () => {
  await client.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: { deck_id: "deck-1", ...args } });
  expect(result.isError).not.toBe(true);
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
}

describe("deck role corrections", () => {
  it("registers a required nullable role list even without an index", async () => {
    expect(makeDeckTools(store).map((tool) => tool.name)).toContain("deck_set_roles");
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "deck_set_roles");
    expect(tool?.inputSchema.required).toEqual(
      expect.arrayContaining(["deck_id", "card", "roles"]),
    );
  });

  it("replaces labels in canonical unique order and exposes inferred vs effective provenance", async () => {
    const version = store.get("deck-1")?.version;
    expect(
      await call("deck_set_roles", {
        card: "Sol Ring",
        roles: ["payoff", "combo_piece", "payoff"],
        expected_version: version,
      }),
    ).toMatchObject({
      ok: true,
      changed: true,
      oracle_id: "o-sol",
      version: (version ?? 0) + 1,
      inferred_roles: ["ramp", "mana_rock"],
      effective_roles: ["combo_piece", "payoff"],
      role_source: "user_override",
    });
    expect(store.get("deck-1")?.role_overrides).toEqual({ "o-sol": ["combo_piece", "payoff"] });
    expect(await call("deck_get")).toMatchObject({
      deck: {
        cards: [
          {
            oracle_id: "o-sol",
            inferred_roles: ["ramp", "mana_rock"],
            effective_roles: ["combo_piece", "payoff"],
            role_source: "user_override",
          },
          { oracle_id: "o-island" },
        ],
      },
    });
  });

  it("distinguishes an empty override from resetting to inferred labels", async () => {
    expect(await call("deck_set_roles", { card: "o-sol", roles: [] })).toMatchObject({
      effective_roles: [],
      role_source: "user_override",
      changed: true,
    });
    expect(store.get("deck-1")?.role_overrides?.["o-sol"]).toEqual([]);
    expect(await call("deck_set_roles", { card: "Sol Ring", roles: null })).toMatchObject({
      effective_roles: ["ramp", "mana_rock"],
      role_source: "classifier",
      changed: true,
    });
    expect(store.get("deck-1")?.role_overrides?.["o-sol"]).toBeUndefined();
  });

  it("corrects weighted composition, coverage, status and role-filtered curve without changing legality or the index", async () => {
    const before = await call("deck_status");
    const original = index.getCard("o-island");
    await call("deck_set_roles", { card: "Island", roles: ["ramp"] });
    expect(await call("analyze_composition")).toMatchObject({
      by_role: { ramp: 5, mana_rock: 1 },
      by_type: { Land: 4 },
      role_source_default: "classifier",
      role_overrides: { "o-island": ["ramp"] },
    });
    const composition = await call("analyze_composition");
    expect(composition).not.toMatchObject({ by_role: { land: 4 } });
    expect(
      await call("analyze_role_coverage", { bands: { ramp: { min: 5, max: 5 } } }),
    ).toMatchObject({ gaps: [{ role: "ramp", have: 5, status: "ok" }] });
    expect(await call("analyze_curve", { role: "ramp" })).toMatchObject({
      total: 5,
      buckets: { "0": 4, "1": 1 },
    });
    const after = await call("deck_status");
    expect(after).toMatchObject({
      legality: before?.legality,
      roles: { gaps: expect.arrayContaining([expect.objectContaining({ role: "ramp", have: 5 })]) },
      vitals: { land_count: 4 },
    });
    expect(index.getCard("o-island")).toEqual(original);
    expect(await call("deck_set_roles", { card: "Island", roles: null })).toMatchObject({
      effective_roles: ["land"],
    });
    expect(await call("analyze_composition")).toMatchObject({ by_role: { land: 4, ramp: 1 } });
  });

  it("uses corrections in budget cost-driver roles", async () => {
    await call("deck_set_roles", { card: "Sol Ring", roles: ["payoff"] });
    expect(await call("budget_plan")).toMatchObject({
      cost_drivers: expect.arrayContaining([
        expect.objectContaining({ oracle_id: "o-sol", roles: ["payoff"] }),
      ]),
    });
  });

  it("uses corrected acceleration roles in hand simulation while retaining physical land counts", async () => {
    const options = { trials: 20, seed: 17, hand_size: 5 };
    expect(await call("simulate_deck", options)).toMatchObject({
      scenarios: { textbook: 1 },
      opening_land_distribution: { "4": 1 },
    });
    await call("deck_set_roles", { card: "Sol Ring", roles: [] });
    await call("deck_set_roles", { card: "Island", roles: [] });
    expect(await call("simulate_deck", options)).toMatchObject({
      scenarios: { textbook: 0, playable_no_accel: 1 },
      opening_land_distribution: { "4": 1 },
    });
  });

  it("reports unchanged labels accurately while preserving successful mutation versioning", async () => {
    await call("deck_set_roles", { card: "Sol Ring", roles: ["payoff"] });
    const version = store.get("deck-1")?.version ?? 0;
    expect(
      await call("deck_set_roles", { card: "Sol Ring", roles: ["payoff", "payoff"] }),
    ).toMatchObject({ changed: false, version: version + 1 });
    await call("deck_set_roles", { card: "Sol Ring", roles: null });
    expect(await call("deck_set_roles", { card: "Sol Ring", roles: null })).toMatchObject({
      changed: false,
      version: version + 3,
    });
  });

  it("scopes mutations to the owning principal", async () => {
    const server = createServer({ index, deckStore: store, session: "other" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const other = new Client({ name: "other", version: "1" });
    await other.connect(clientTransport);
    try {
      const before = store.dump();
      const result = await other.callTool({
        name: "deck_set_roles",
        arguments: { deck_id: "deck-1", card: "Sol Ring", roles: [] },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
      expect(store.dump()).toEqual(before);
    } finally {
      await other.close();
    }
  });

  it("accepts commanders and companions, but rejects missing cards and invalid roles without mutation", async () => {
    await call("deck_set_roles", { card: "Test Commander", roles: ["payoff"] });
    await call("deck_set_roles", { card: "o-tower", roles: ["fixing"] });
    store.update("deck-1", (deck) => ({ ...deck, companion: undefined }));
    for (const args of [
      { card: "Sol Ring", roles: ["imaginary"] },
      { card: "Sol Ring" },
      { card: "unknown missing card", roles: [] },
      { card: "Command", roles: [] },
      { card: "Command Tower", roles: ["ramp"] },
      { card: "", roles: [] },
    ]) {
      const before = store.dump();
      const result = await client.callTool({
        name: "deck_set_roles",
        arguments: { deck_id: "deck-1", ...args },
      });
      expect(result.isError).toBe(true);
      expect(store.dump()).toEqual(before);
    }
  });

  it("resets an unavailable override through the public tool without a card index", async () => {
    store.update("deck-1", (deck) => ({ ...deck, role_overrides: { "missing-id": ["payoff"] } }));
    const server = createServer({ deckStore: store });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const noIndex = new Client({ name: "without-index", version: "1" });
    await noIndex.connect(clientTransport);
    try {
      const result = await noIndex.callTool({
        name: "deck_set_roles",
        arguments: { deck_id: "deck-1", card: "missing-id", roles: null },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        changed: true,
        role_source: "classifier",
        inferred_roles: null,
        effective_roles: null,
      });
      expect(store.get("deck-1")?.role_overrides).toEqual({});
      const before = store.dump();
      const rejected = await noIndex.callTool({
        name: "deck_set_roles",
        arguments: { deck_id: "deck-1", card: "o-sol", roles: [] },
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toMatchObject({ code: "UNKNOWN_CARD" });
      expect(store.dump()).toEqual(before);
    } finally {
      await noIndex.close();
    }
  });

  it("returns conflicts with no mutation and keeps another deck's classifier defaults", async () => {
    store.create({ name: "Uncorrected" });
    store.update("deck-2", (deck) => ({ ...deck, cards: [{ oracle_id: "o-sol", qty: 1 }] }));
    const before = store.dump();
    expect(
      await call("deck_set_roles", { card: "Sol Ring", roles: [], expected_version: 0 }),
    ).toMatchObject({ ok: false, conflict: true });
    expect(store.dump()).toEqual(before);
    await call("deck_set_roles", { card: "Sol Ring", roles: [] });
    expect(await call("analyze_composition", { deck_id: "deck-2" })).toMatchObject({
      by_role: { ramp: 1, mana_rock: 1 },
    });
  });

  it("restores snapshots and resets removed or unresolved override IDs", async () => {
    await call("deck_set_roles", { card: "Sol Ring", roles: ["payoff"] });
    const snapshot = await call("deck_snapshot");
    await call("deck_set_roles", { card: "Sol Ring", roles: [] });
    await call("deck_restore", { snapshot_id: snapshot?.snapshot_id });
    expect(store.get("deck-1")?.role_overrides).toEqual({ "o-sol": ["payoff"] });
    await call("deck_remove", { cards: "Sol Ring" });
    await call("deck_set_roles", { card: "Sol Ring", roles: null });
    store.update("deck-1", (deck) => ({ ...deck, role_overrides: { "gone-oracle-id": [] } }));
    expect(await call("deck_set_roles", { card: "gone-oracle-id", roles: null })).toMatchObject({
      changed: true,
      oracle_id: "gone-oracle-id",
      inferred_roles: null,
      effective_roles: null,
      role_source: "classifier",
    });
    expect(store.get("deck-1")?.role_overrides?.["gone-oracle-id"]).toBeUndefined();
  });
});
