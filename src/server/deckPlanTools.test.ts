import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import Database from "better-sqlite3";
import { DeckStore } from "../deck/index.js";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { createServer } from "./createServer.js";
import { cachedSnapshotProvider } from "./snapshot.js";
import type { CardDataSource } from "./cardData.js";

const ORACLE = [
  {
    oracle_id: "o-chief",
    name: "Test Commander",
    type_line: "Legendary Creature — Human",
    cmc: 3,
    color_identity: ["U"],
  },
  {
    oracle_id: "o-island",
    name: "Island",
    type_line: "Basic Land — Island",
    cmc: 0,
    color_identity: ["U"],
  },
  { oracle_id: "o-sol", name: "Sol Ring", type_line: "Artifact", cmc: 1, color_identity: [] },
].map((card) => ({
  ...card,
  id: `p-${card.oracle_id}`,
  oracle_text: "",
  colors: card.color_identity,
  legalities: { commander: "legal" },
  prices: { usd: "1.00" },
}));

let root: string;
let index: CardIndex;
let dbPath: string;
let store: DeckStore;
let client: Client;
let snapshot: ReturnType<typeof cachedSnapshotProvider>;
const clients: Client[] = [];

async function connect(options: Parameters<typeof createServer>[0]): Promise<Client> {
  const server = createServer(options);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const connected = new Client({ name: "plan-acceptance", version: "1" });
  await connected.connect(ct);
  clients.push(connected);
  return connected;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-plan-"));
  const data = new VersionedStore(root);
  await data.createVersion("v1");
  await writeFile(data.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE));
  await writeFile(data.filePath("v1", "default_cards.json"), "[]");
  await data.publish("v1");
  dbPath = (await buildIndex({ store: data })).dbPath;
  index = CardIndex.open(dbPath);
  let id = 0;
  store = new DeckStore({ newId: () => `deck-${++id}` });
  store.create({
    name: "Original",
    commanders: ["o-chief"],
    computedColorIdentity: ["U"],
    dataSnapshot: "2026-09-01",
  });
  store.update("deck-1", (deck) => ({ ...deck, cards: [{ oracle_id: "o-island", qty: 99 }] }));
  snapshot = cachedSnapshotProvider("2026-09-01");
  client = await connect({ index, deckStore: store, snapshot: snapshot.provider });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((connected) => connected.close()));
  index.close();
  await rm(root, { recursive: true, force: true });
});

function input() {
  return {
    name: "Reviewed build",
    request: {
      budget: { mode: "unbounded" },
      cards: [
        { oracle_id: "Island", qty: 98 },
        { oracle_id: "Sol Ring", qty: 1 },
      ],
      commanders: ["Test Commander"],
      command_zone_kind: "single",
    },
  };
}

function currentVersion(): number {
  const deck = store.get("deck-1");
  if (!deck) throw new Error("Missing test deck");
  return deck.version;
}

async function call(name: string, args: Record<string, unknown>, connected = client) {
  const result = await connected.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
}

async function preview(args: Record<string, unknown> = {}) {
  return call("deck_plan_preview", {
    input: input(),
    deck_id: "deck-1",
    expected_version: currentVersion(),
    ...args,
  });
}

/** A caller can recompute the public consistency digest; it is not a signature. */
function rehashPlan(plan: Record<string, unknown>) {
  const bound = { ...plan };
  delete bound.request_hash;
  const serialized = JSON.stringify(bound, (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
  return { ...bound, request_hash: createHash("sha256").update(serialized).digest("hex") };
}

describe("deck change plan MCP protocol", () => {
  it("advertises a read-only preview and an idempotent apply with no output schema", async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.find((tool) => tool.name === "deck_plan_preview")).toMatchObject({
      annotations: { readOnlyHint: true, openWorldHint: false },
    });
    expect(tools.find((tool) => tool.name === "deck_plan_apply")).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      inputSchema: { required: ["plan"] },
    });
    expect(
      tools
        .filter((tool) => tool.name.startsWith("deck_plan_"))
        .every((tool) => tool.outputSchema === undefined),
    ).toBe(true);
  });

  it("previews canonical exact changes without writing, then applies one version and snapshot", async () => {
    const before = store.dump();
    const version = currentVersion();
    const result = await preview();
    expect(result).toMatchObject({
      ok: true,
      validation: { valid: true },
      data_snapshot: "2026-09-01",
      desired: {
        cards: [
          { oracle_id: "o-island", qty: 98 },
          { oracle_id: "o-sol", qty: 1 },
        ],
      },
    });
    expect(store.dump()).toEqual(before);
    const applied = await call("deck_plan_apply", { plan: result.plan });
    expect(applied).toMatchObject({
      ok: true,
      replayed: false,
      receipt: {
        deck: {
          deck_id: "deck-1",
          version: version + 1,
          name: "Reviewed build",
          data_snapshot: "2026-09-01",
        },
        snapshot_id: expect.any(String),
      },
    });
    expect(store.listSnapshots("deck-1")).toHaveLength(1);
    expect(store.listSnapshots("deck-1")[0]?.deck).toEqual(before.decks[0]?.[1]);
    const after = store.dump();
    expect(await call("deck_plan_apply", { plan: result.plan })).toMatchObject({
      replayed: true,
      receipt: applied.receipt,
    });
    expect(store.dump()).toEqual(after);
  });

  it("preserves normalized desired state, full diff and evidence in the portable plan alone", async () => {
    const result = await preview();
    const portable: unknown = JSON.parse(JSON.stringify(result.plan));
    expect(portable).toMatchObject({
      review: { desired: result.desired, diff: result.diff, validation: result.validation },
    });
    expect(portable).toMatchObject({
      review: {
        desired: {
          cards: [
            { oracle_id: "o-island", qty: 98 },
            { oracle_id: "o-sol", qty: 1 },
          ],
        },
        validation: { valid: true, budget: expect.any(Object), normalization: expect.any(Object) },
      },
    });
    expect(await call("deck_plan_apply", { plan: portable })).toMatchObject({ ok: true });
  });

  it("rejects a changed reviewed desired state or diff even when the public digest is recomputed", async () => {
    const result = await preview();
    const plan = z.record(z.string(), z.unknown()).parse(result.plan);
    const review = z.record(z.string(), z.unknown()).parse(plan.review);
    const desired = z.record(z.string(), z.unknown()).parse(review.desired);
    const before = store.dump();
    const misleadingDesired = {
      ...plan,
      review: { ...review, desired: { ...desired, name: "Misleading review" } },
    };
    expect(
      await client.callTool({ name: "deck_plan_apply", arguments: { plan: misleadingDesired } }),
    ).toMatchObject({ isError: true, structuredContent: { code: "PLAN_HASH_MISMATCH" } });
    for (const misleading of [misleadingDesired, { ...plan, review: { ...review, diff: {} } }]) {
      expect(
        await client.callTool({
          name: "deck_plan_apply",
          arguments: { plan: rehashPlan(misleading) },
        }),
      ).toMatchObject({ isError: true, structuredContent: { code: "PLAN_CONTENT_MISMATCH" } });
    }
    expect(store.dump()).toEqual(before);
  });

  it("returns the committed receipt for retries after later edits, refresh, or deletion", async () => {
    const planned = await preview();
    const applied = await call("deck_plan_apply", { plan: planned.plan });
    store.setName("deck-1", "Later edit");
    snapshot.set("2026-09-02");
    expect(await call("deck_plan_apply", { plan: planned.plan })).toMatchObject({
      replayed: true,
      receipt: applied.receipt,
    });
    expect(store.get("deck-1")?.name).toBe("Later edit");
    store.delete("deck-1");
    expect(await call("deck_plan_apply", { plan: planned.plan })).toMatchObject({
      replayed: true,
      receipt: applied.receipt,
    });
    expect(store.get("deck-1")).toBeUndefined();
    const detachedIndex = CardIndex.open(dbPath);
    const resumed = await connect({
      index: detachedIndex,
      deckStore: store,
      snapshot: snapshot.provider,
    });
    detachedIndex.close();
    expect(await call("deck_plan_apply", { plan: planned.plan }, resumed)).toMatchObject({
      replayed: true,
      receipt: applied.receipt,
    });
  });

  it("creates an empty-source build once per plan while fresh previews remain independent", async () => {
    const before = store.dump();
    const first = await call("deck_plan_preview", { input: input() });
    const second = await call("deck_plan_preview", { input: input() });
    expect(first.plan).not.toEqual(second.plan);
    expect(store.dump()).toEqual(before);
    const applied = await call("deck_plan_apply", { plan: first.plan });
    expect(applied).toMatchObject({
      receipt: {
        deck: {
          version: 1,
          name: "Reviewed build",
          cards: [
            { oracle_id: "o-island", qty: 98 },
            { oracle_id: "o-sol", qty: 1 },
          ],
        },
      },
    });
    expect(await call("deck_plan_apply", { plan: first.plan })).toMatchObject({
      replayed: true,
      receipt: applied.receipt,
    });
    await call("deck_plan_apply", { plan: second.plan });
    expect(store.list()).toHaveLength(3);
  });

  it("includes newly authored intent in the empty-source diff", async () => {
    const intent = { schema_version: 1, soft: { goals: ["Build a reliable mana base"] } };
    const result = await call("deck_plan_preview", {
      input: { ...input(), request: { ...input().request, intent } },
    });
    expect(result).toMatchObject({
      desired: { intent },
      diff: { metadata: { intent: { from: null, to: intent } } },
    });
  });

  it("rejects stale versions, stale data, altered payloads, and unsupported inventory without mutation", async () => {
    const staleVersion = await preview();
    store.setName("deck-1", "Concurrent");
    let before = store.dump();
    expect(
      await client.callTool({ name: "deck_plan_apply", arguments: { plan: staleVersion.plan } }),
    ).toMatchObject({ isError: true, structuredContent: { code: "PLAN_VERSION_CONFLICT" } });
    expect(store.dump()).toEqual(before);
    const staleData = await preview();
    snapshot.set("2026-09-02");
    before = store.dump();
    expect(
      await client.callTool({ name: "deck_plan_apply", arguments: { plan: staleData.plan } }),
    ).toMatchObject({ isError: true, structuredContent: { code: "PLAN_DATA_CONFLICT" } });
    const valid = await preview();
    const plan = z.record(z.string(), z.unknown()).parse(valid.plan);
    expect(
      await client.callTool({
        name: "deck_plan_apply",
        arguments: { plan: { ...plan, input: { ...input(), name: "Tampered" } } },
      }),
    ).toMatchObject({ isError: true, structuredContent: { code: "PLAN_HASH_MISMATCH" } });
    expect(
      await client.callTool({
        name: "deck_plan_preview",
        arguments: { input: input(), inventory_revision: "owned-v1" },
      }),
    ).toMatchObject({ isError: true, structuredContent: { code: "PLAN_INVENTORY_UNSUPPORTED" } });
    expect(store.dump()).toEqual(before);
  });

  it("rejects foreign existing-deck and new-deck plans without revealing receipts", async () => {
    const other = await connect({
      index,
      deckStore: store,
      snapshot: snapshot.provider,
      session: "other",
    });
    const existing = await preview();
    const fresh = await call("deck_plan_preview", { input: input() });
    await call("deck_plan_apply", { plan: existing.plan });
    const before = store.dump();
    for (const plan of [existing.plan, fresh.plan]) {
      expect(await other.callTool({ name: "deck_plan_apply", arguments: { plan } })).toMatchObject({
        isError: true,
        structuredContent: { code: "PLAN_SESSION_MISMATCH" },
      });
    }
    expect(store.dump()).toEqual(before);
  });

  it("rejects a changed card database even when the snapshot date stays the same", async () => {
    const planned = await preview();
    const before = store.dump();
    const writer = new Database(dbPath);
    try {
      writer.prepare("UPDATE cards SET price_usd = 2 WHERE oracle_id = ?").run("o-sol");
    } finally {
      writer.close();
    }
    expect(snapshot.get()).toBe("2026-09-01");
    expect(
      await client.callTool({ name: "deck_plan_apply", arguments: { plan: planned.plan } }),
    ).toMatchObject({ isError: true, structuredContent: { code: "PLAN_DATA_CONFLICT" } });
    expect(store.dump()).toEqual(before);
  });

  it("revalidates an invalid preview at apply instead of trusting a supplied desired state", async () => {
    const before = store.dump();
    const invalid = await client.callTool({
      name: "deck_plan_preview",
      arguments: {
        input: {
          ...input(),
          request: { ...input().request, cards: [{ oracle_id: "Island", qty: 1 }] },
        },
      },
    });
    expect(invalid).toMatchObject({
      isError: true,
      structuredContent: { code: "PLAN_INVALID", validation: { valid: false } },
    });
    const plan = z.record(z.string(), z.unknown()).parse(invalid.structuredContent).plan;
    expect(await client.callTool({ name: "deck_plan_apply", arguments: { plan } })).toMatchObject({
      isError: true,
      structuredContent: { code: "PLAN_INVALID", validation: { valid: false } },
    });
    const invalidPlan = z.record(z.string(), z.unknown()).parse(plan);
    const invalidReview = z.record(z.string(), z.unknown()).parse(invalidPlan.review);
    const forgedValidation = rehashPlan({
      ...invalidPlan,
      review: { ...invalidReview, validation: { valid: true } },
    });
    expect(
      await client.callTool({ name: "deck_plan_apply", arguments: { plan: forgedValidation } }),
    ).toMatchObject({
      isError: true,
      structuredContent: { code: "PLAN_INVALID", validation: { valid: false } },
    });
    const planned = await preview();
    const forged = {
      ...z.record(z.string(), z.unknown()).parse(planned.plan),
      desired: { cards: [] },
      validation: { valid: true },
    };
    expect(
      await client.callTool({ name: "deck_plan_apply", arguments: { plan: forged } }),
    ).toMatchObject({ isError: true });
    expect(store.dump()).toEqual(before);
  });

  it("rejects malformed or incomplete plans instead of treating them as a partial update", async () => {
    const before = store.dump();
    for (const args of [
      { input: input(), deck_id: "deck-1" },
      { input: input(), expected_version: 2 },
      { input: { request: {} } },
      { input: { request: { cards: [{ oracle_id: "Sol Rin", qty: 1 }] } } },
      {
        input: {
          request: {
            cards: [{ oracle_id: "Island", qty: 1 }],
            commanders: ["Test Commander"],
            command_zone_kind: "single",
          },
        },
      },
    ])
      expect(await client.callTool({ name: "deck_plan_preview", arguments: args })).toMatchObject({
        isError: true,
      });
    expect(store.dump()).toEqual(before);
  });

  it("binds the fixed deck catalog to the first ingested index without a restart", async () => {
    let listener: Parameters<CardDataSource["onReady"]>[0] | undefined;
    const source: CardDataSource = {
      index: undefined,
      onReady(callback) {
        listener = callback;
        return () => {};
      },
    };
    const offline = await connect({
      cardData: source,
      deckStore: store,
      snapshot: snapshot.provider,
    });
    expect(
      await offline.callTool({ name: "deck_plan_preview", arguments: { input: input() } }),
    ).toMatchObject({ isError: true, structuredContent: { code: "UPSTREAM_UNAVAILABLE" } });
    if (!listener) throw new Error("Missing readiness listener");
    listener(index).commit();
    expect(await call("deck_plan_preview", { input: input() }, offline)).toMatchObject({
      validation: { valid: true },
    });
  });
});
