import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { DEFAULT_BANDS } from "../analyze/index.js";
import { DeckStore } from "../deck/index.js";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { createServer } from "./createServer.js";

const ORACLE = [
  {
    oracle_id: "o-sol",
    name: "Sol Ring",
    cmc: 1,
    type_line: "Artifact",
    oracle_text: "{T}: Add {C}{C}.",
    color_identity: [],
  },
  {
    oracle_id: "o-island",
    name: "Island",
    cmc: 0,
    type_line: "Basic Land — Island",
    oracle_text: "({T}: Add {U}.)",
    color_identity: ["U"],
  },
  {
    oracle_id: "o-chief",
    name: "Test Commander",
    cmc: 3,
    type_line: "Legendary Creature — Human",
    oracle_text: "",
    color_identity: ["U"],
  },
].map((card) => ({
  ...card,
  id: `printing-${card.oracle_id}`,
  colors: card.color_identity,
  legalities: { commander: "legal" },
  prices: { usd: "1.00" },
}));

let root: string;
let index: CardIndex;
let store: DeckStore;
let client: Client;
const clients: Client[] = [];

async function connect(options: Parameters<typeof createServer>[0]): Promise<Client> {
  const server = createServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const connected = new Client({ name: "intent-acceptance", version: "1" });
  await connected.connect(clientTransport);
  clients.push(connected);
  return connected;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-intent-"));
  const data = new VersionedStore(root);
  await data.createVersion("v1");
  await writeFile(data.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE));
  await writeFile(data.filePath("v1", "default_cards.json"), "[]");
  await data.publish("v1");
  index = CardIndex.open((await buildIndex({ store: data })).dbPath);
  let counter = 0;
  store = new DeckStore({ newId: () => `deck-${++counter}` });
  store.create({ name: "Intent test", commanders: ["o-chief"], computedColorIdentity: ["U"] });
  store.update("deck-1", (deck) => ({
    ...deck,
    cards: [
      { oracle_id: "o-sol", qty: 1 },
      { oracle_id: "o-island", qty: 4 },
    ],
    role_overrides: { "o-sol": ["payoff"] },
  }));
  client = await connect({ index, deckStore: store });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((connected) => connected.close()));
  index.close();
  await rm(root, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}, connected = client) {
  const result = await connected.callTool({ name, arguments: { deck_id: "deck-1", ...args } });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
}

function version(): number {
  const deck = store.get("deck-1");
  if (!deck) throw new Error("Missing test deck");
  return deck.version;
}

async function mutate(args: Record<string, unknown>, connected = client) {
  return call("deck_set_intent", { expected_version: version(), ...args }, connected);
}

describe("deck intent MCP tools", () => {
  it("discovers a read tool and a mutation with required optimistic versioning", async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.find((tool) => tool.name === "deck_get_intent")).toMatchObject({
      annotations: { readOnlyHint: true },
      inputSchema: { required: ["deck_id"] },
    });
    expect(tools.find((tool) => tool.name === "deck_set_intent")).toMatchObject({
      annotations: { readOnlyHint: false },
      inputSchema: { required: expect.arrayContaining(["deck_id", "expected_version", "action"]) },
    });
  });

  it("reports absent intent and advisory defaults without synthesizing user preferences", async () => {
    const before = store.dump();
    expect(await call("deck_get_intent")).toMatchObject({
      ok: true,
      deck_id: "deck-1",
      version: version(),
      intent: null,
      defaults: { role_targets: DEFAULT_BANDS },
      effective: { role_targets: DEFAULT_BANDS, spend_target_usd: null },
      evaluation: {
        hard_constraints: "not_evaluated",
        soft_preferences: "advisory",
        unsupported_requirements: "not_evaluated",
      },
    });
    expect(store.dump()).toEqual(before);
  });

  it("normalizes exact card references and preserves hard, soft, and unsupported intent separately", async () => {
    const currentVersion = version();
    const result = await mutate({
      action: "set",
      intent: {
        schema_version: 1,
        hard: {
          locked_cards: [{ oracle_id: "Sol Ring", qty: 1 }],
          commanders: { allowed: ["Test Commander"], required: ["o-chief"], color_identity: ["U"] },
          change_limit: 2,
        },
        soft: {
          goals: ["Improve resilience"],
          strategy: "Artifacts",
          favorites: [{ oracle_id: "Island", qty: 4 }],
          role_targets: { ramp: { min: 1, max: 3 } },
          spend_target_usd: 35,
          playgroup_preferences: ["Keep turns short"],
        },
        unsupported: ["Every opening hand must contain an Island"],
      },
    });
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      version: currentVersion + 1,
      intent: {
        schema_version: 1,
        hard: {
          locked_cards: [{ oracle_id: "o-sol", qty: 1 }],
          commanders: { allowed: ["o-chief"], required: ["o-chief"], color_identity: ["U"] },
          change_limit: 2,
        },
        soft: {
          goals: ["Improve resilience"],
          strategy: "Artifacts",
          favorites: [{ oracle_id: "o-island", qty: 4 }],
          playgroup_preferences: ["Keep turns short"],
        },
        unsupported: ["Every opening hand must contain an Island"],
      },
      defaults: { role_targets: DEFAULT_BANDS },
      effective: {
        role_targets: { ...DEFAULT_BANDS, ramp: { min: 1, max: 3 } },
        spend_target_usd: 35,
      },
      evaluation: { hard_constraints: "not_evaluated", unsupported_requirements: "not_evaluated" },
    });
    expect(await call("deck_get_intent")).toMatchObject({
      intent: result.intent,
      version: result.version,
    });
    expect(await call("deck_get")).toMatchObject({ deck: { intent: result.intent } });
  });

  it("patches recursively, replaces arrays, removes null fields, and clears explicitly", async () => {
    await mutate({
      action: "set",
      intent: {
        schema_version: 1,
        hard: { change_limit: 3 },
        soft: {
          goals: ["Old goal", "Another goal"],
          strategy: "Artifacts",
          spend_target_usd: 20,
          role_targets: { ramp: { min: 2, max: 4 } },
        },
        unsupported: ["Untested request"],
      },
    });
    expect(
      await mutate({
        action: "patch",
        patch: {
          soft: { goals: ["New goal"], spend_target_usd: null, role_targets: { ramp: { min: 3 } } },
          unsupported: null,
        },
      }),
    ).toMatchObject({
      intent: {
        schema_version: 1,
        hard: { change_limit: 3 },
        soft: {
          goals: ["New goal"],
          strategy: "Artifacts",
          role_targets: { ramp: { min: 3, max: 4 } },
        },
      },
      effective: { spend_target_usd: null },
    });
    const persisted = await call("deck_get_intent");
    expect(persisted.intent).not.toHaveProperty("unsupported");
    expect(persisted.intent).not.toHaveProperty("soft.spend_target_usd");
    expect(await mutate({ action: "patch", patch: { hard: null, soft: null } })).toMatchObject({
      intent: { schema_version: 1 },
      effective: { role_targets: DEFAULT_BANDS },
    });
    expect(await mutate({ action: "clear" })).toMatchObject({ changed: true, intent: null });
    expect(await mutate({ action: "clear" })).toMatchObject({ changed: false, intent: null });
  });

  it("rejects malformed payloads atomically instead of stripping unknown requirements", async () => {
    for (const args of [
      { action: "set", intent: { schema_version: 2 } },
      { action: "set", intent: { schema_version: 1, unknown_requirement: true } },
      { action: "set", intent: { schema_version: 1, hard: { change_limit: -1 } } },
      { action: "set", intent: { schema_version: 1, soft: { spend_target_usd: -1 } } },
      {
        action: "set",
        intent: { schema_version: 1, soft: { role_targets: { ramp: { min: 5, max: 2 } } } },
      },
      {
        action: "set",
        intent: { schema_version: 1, soft: { role_targets: { imaginary: { min: 1, max: 2 } } } },
      },
      {
        action: "set",
        intent: { schema_version: 1, hard: { locked_cards: [{ oracle_id: "o-sol", qty: 0 }] } },
      },
      { action: "set" },
      { action: "patch", patch: [] },
      { action: "patch", patch: { schema_version: null } },
      { action: "clear", intent: { schema_version: 1 } },
    ]) {
      const before = store.dump();
      const result = await client.callTool({
        name: "deck_set_intent",
        arguments: {
          deck_id: "deck-1",
          expected_version: version(),
          ...args,
        },
      });
      // Invalid schema inputs may be rejected by the MCP SDK before the handler.
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(store.dump()).toEqual(before);
    }
  });

  it("reports malformed merged patch diagnostics without changing the saved intent", async () => {
    await mutate({
      action: "set",
      intent: {
        schema_version: 1,
        soft: { role_targets: { ramp: { min: 1, max: 3 } } },
      },
    });
    const before = store.dump();
    expect(
      await client.callTool({
        name: "deck_set_intent",
        arguments: {
          deck_id: "deck-1",
          expected_version: version(),
          action: "patch",
          patch: { soft: { role_targets: { ramp: { min: -1 } } } },
        },
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: {
        code: "INVALID_INTENT",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: expect.any(String),
            path: expect.any(String),
            message: expect.any(String),
          }),
        ]),
      },
    });
    expect(store.dump()).toEqual(before);
  });

  it("rejects contradictory hard requirements with actionable paths and no write", async () => {
    const before = store.dump();
    const result = await client.callTool({
      name: "deck_set_intent",
      arguments: {
        deck_id: "deck-1",
        expected_version: version(),
        action: "set",
        intent: {
          schema_version: 1,
          hard: { locked_cards: [{ oracle_id: "Sol Ring", qty: 1 }], excluded_cards: ["o-sol"] },
        },
      },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        code: "INTENT_CONFLICT",
        version: version(),
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: expect.any(String),
            path: expect.any(String),
            message: expect.any(String),
          }),
        ]),
      },
    });
    expect(store.dump()).toEqual(before);
  });

  it("never fuzzy-resolves new intent card names", async () => {
    for (const oracle_id of ["Sol Rin", "Unknown card"]) {
      const before = store.dump();
      const result = await client.callTool({
        name: "deck_set_intent",
        arguments: {
          deck_id: "deck-1",
          expected_version: version(),
          action: "set",
          intent: {
            schema_version: 1,
            soft: { favorites: [{ oracle_id, qty: 1 }] },
          },
        },
      });
      expect(result.isError).toBe(true);
      expect(store.dump()).toEqual(before);
    }
  });

  it.each([
    { commanders: { allowed: ["Test Commander"], color_identity: ["G"] } },
    { commanders: { required: ["Test Commander"], color_identity: ["G"] } },
    { commanders: { color_identity: ["G"] }, locked_cards: [{ oracle_id: "Island", qty: 1 }] },
  ])("rejects card requirements outside the allowed commander identity: %j", async (hard) => {
    const before = store.dump();
    expect(
      await client.callTool({
        name: "deck_set_intent",
        arguments: {
          deck_id: "deck-1",
          expected_version: version(),
          action: "set",
          intent: { schema_version: 1, hard },
        },
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: {
        code: "INTENT_CONFLICT",
        version: version(),
        diagnostics: expect.any(Array),
      },
    });
    expect(store.dump()).toEqual(before);
  });

  it("rejects duplicate lock identities supplied through exact aliases without summing quantities", async () => {
    const before = store.dump();
    expect(
      await client.callTool({
        name: "deck_set_intent",
        arguments: {
          deck_id: "deck-1",
          expected_version: version(),
          action: "set",
          intent: {
            schema_version: 1,
            hard: {
              locked_cards: [
                { oracle_id: "Sol Ring", qty: 1 },
                { oracle_id: "o-sol", qty: 1 },
              ],
            },
          },
        },
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: {
        code: "INTENT_CONFLICT",
        diagnostics: expect.any(Array),
      },
    });
    expect(store.dump()).toEqual(before);
  });

  it("protects reads and writes against stale versions and other principals", async () => {
    const other = await connect({ index, deckStore: store, session: "other" });
    for (const name of ["deck_get_intent", "deck_set_intent"]) {
      const before = store.dump();
      const args = name === "deck_set_intent" ? { action: "clear" } : {};
      expect(await call(name, { ...args, expected_version: version() - 1 })).toMatchObject({
        ok: false,
        conflict: true,
        current_version: version(),
        expected_version: version() - 1,
      });
      const denied = await other.callTool({
        name,
        arguments: {
          deck_id: "deck-1",
          expected_version: version(),
          ...args,
        },
      });
      expect(denied).toMatchObject({
        isError: true,
        structuredContent: { code: "DECK_NOT_FOUND" },
      });
      expect(store.dump()).toEqual(before);
    }
    const before = store.dump();
    expect(
      await client.callTool({
        name: "deck_set_intent",
        arguments: {
          deck_id: "deck-1",
          action: "clear",
        },
      }),
    ).toMatchObject({ isError: true });
    expect(store.dump()).toEqual(before);
  });

  it("allows offline text updates and clear while requiring an index for new card references", async () => {
    await mutate({
      action: "set",
      intent: {
        schema_version: 1,
        hard: { locked_cards: [{ oracle_id: "Sol Ring", qty: 1 }] },
      },
    });
    const offline = await connect({ deckStore: store });
    expect(await call("deck_get_intent", {}, offline)).toMatchObject({
      intent: {
        hard: { locked_cards: [{ oracle_id: "o-sol", qty: 1 }] },
      },
    });
    expect(
      await mutate({ action: "patch", patch: { soft: { goals: ["Stay resilient"] } } }, offline),
    ).toMatchObject({
      intent: {
        hard: { locked_cards: [{ oracle_id: "o-sol", qty: 1 }] },
        soft: { goals: ["Stay resilient"] },
      },
    });
    const before = store.dump();
    expect(
      await offline.callTool({
        name: "deck_set_intent",
        arguments: {
          deck_id: "deck-1",
          expected_version: version(),
          action: "patch",
          patch: {
            soft: { favorites: [{ oracle_id: "Island", qty: 1 }] },
          },
        },
      }),
    ).toMatchObject({ isError: true });
    expect(store.dump()).toEqual(before);
    expect(await mutate({ action: "clear" }, offline)).toMatchObject({ intent: null });
    expect(
      await mutate(
        { action: "set", intent: { schema_version: 1, soft: { strategy: "Artifacts" } } },
        offline,
      ),
    ).toMatchObject({
      intent: { schema_version: 1, soft: { strategy: "Artifacts" } },
    });
  });

  it("uses stored role targets as advisory defaults with explicit call overrides", async () => {
    const before = await call("deck_status");
    const original = store.get("deck-1");
    await mutate({
      action: "set",
      intent: {
        schema_version: 1,
        soft: { role_targets: { ramp: { min: 0, max: 0 }, payoff: { min: 1, max: 1 } } },
      },
    });
    expect(await call("analyze_role_coverage")).toMatchObject({
      gaps: expect.arrayContaining([
        { role: "ramp", have: 0, want_min: 0, want_max: 0, status: "ok" },
        { role: "payoff", have: 1, want_min: 1, want_max: 1, status: "ok" },
        expect.objectContaining({ role: "land", want_min: DEFAULT_BANDS.land?.min }),
      ]),
    });
    expect(
      await call("analyze_role_coverage", { bands: { ramp: { min: 9, max: 10 } } }),
    ).toMatchObject({
      gaps: [{ role: "ramp", have: 0, want_min: 9, want_max: 10, status: "under" }],
    });
    const status = await call("deck_status");
    expect(status).toMatchObject({
      legality: before.legality,
      vitals: { ...z.record(z.string(), z.unknown()).parse(before.vitals), version: version() },
    });
    expect(z.record(z.string(), z.unknown()).parse(status.roles).gaps).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "ramp" })]),
    );
    expect(store.get("deck-1")).toMatchObject({
      cards: original?.cards,
      role_overrides: original?.role_overrides,
      commanders: original?.commanders,
      computed_color_identity: original?.computed_color_identity,
    });
    store.create({ name: "Default targets" });
    expect(await call("deck_get_intent", { deck_id: "deck-2" })).toMatchObject({
      intent: null,
      effective: { role_targets: DEFAULT_BANDS },
    });
    await mutate({ action: "clear" });
    expect(await call("deck_status")).toMatchObject({
      roles: before.roles,
      legality: before.legality,
    });
  });

  it("snapshots, diffs, and restores intent independently of card and role contents", async () => {
    const original = store.get("deck-1");
    const first = await mutate({
      action: "set",
      intent: { schema_version: 1, soft: { goals: ["First"] } },
    });
    const snapshot = await call("deck_snapshot");
    const second = await mutate({ action: "patch", patch: { soft: { goals: ["Second"] } } });
    expect(await call("deck_diff", { snapshot_id: snapshot.snapshot_id })).toMatchObject({
      diff: {
        cards: { added: [], removed: [], changed: [] },
        metadata: { intent: { from: first.intent, to: second.intent } },
      },
    });
    expect(await call("deck_restore", { snapshot_id: snapshot.snapshot_id })).toMatchObject({
      deck: {
        intent: first.intent,
        cards: original?.cards,
        role_overrides: original?.role_overrides,
      },
    });
    expect(await call("deck_get_intent")).toMatchObject({ intent: first.intent });
  });
});
