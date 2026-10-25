/**
 * The print_* tools over the wire: an in-memory MCP client, a real card index,
 * a real UserDataStore and the print order service with a fake Scryfall image
 * fetcher and no filler worker. The service's behaviour is covered in
 * src/print/service.test.ts; this suite pins the tool catalog, the wire
 * shapes, strict inputs and principal isolation.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { fakeScryfall, solidPng } from "../print/catalogFixtures.test-support.js";
import { PrintFillerService } from "../print/filler.js";
import { PrintOrderService } from "../print/service.js";
import { UserDataStore } from "../storage/userData.js";
import { createServer } from "./createServer.js";
import { PRINT_TOOLS } from "./printTools.js";
import { staticSnapshotProvider } from "./snapshot.js";

const ORACLE = [
  {
    oracle_id: "o-atra",
    id: "p-atra",
    name: "Atraxa, Praetors' Voice",
    cmc: 4,
    colors: ["W", "U", "B", "G"],
    color_identity: ["W", "U", "B", "G"],
    type_line: "Legendary Creature — Phyrexian Angel Horror",
    oracle_text: "Flying. Proliferate.",
    power: "4",
    toughness: "4",
    legalities: { commander: "legal" },
    prices: { usd: "10.00" },
  },
  {
    oracle_id: "o-sol",
    id: "p-sol-cmm",
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

const DEFAULT = [
  {
    oracle_id: "o-atra",
    id: "p-atra",
    set: "c16",
    set_name: "Commander 2016",
    collector_number: "28",
    rarity: "mythic",
    prices: { usd: "10.00" },
    released_at: "2016-11-11",
  },
  {
    oracle_id: "o-sol",
    id: "p-sol-cmm",
    set: "cmm",
    set_name: "Commander Masters",
    collector_number: "447",
    rarity: "uncommon",
    prices: { usd: "1.50" },
    released_at: "2023-08-04",
  },
  {
    oracle_id: "o-sol",
    id: "p-sol-c21",
    set: "c21",
    set_name: "Commander 2021",
    collector_number: "1",
    rarity: "uncommon",
    prices: { usd: "2.00" },
    released_at: "2021-04-23",
  },
];

let root: string;
let index: CardIndex;
let userData: UserDataStore;
let print: PrintOrderService;
let alice: Client;
let bob: Client;

async function connect(session: string): Promise<Client> {
  const server = createServer({
    index,
    deckStore: userData.deckStore,
    print,
    session,
    snapshot: staticSnapshotProvider("2026-10-25"),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: `print-${session}`, version: "0.0.0" });
  await client.connect(ct);
  return client;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-print-tools-"));
  const store = new VersionedStore(path.join(root, "data"));
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify(DEFAULT), "utf8");
  await store.publish("v1");
  index = CardIndex.open((await buildIndex({ store })).dbPath);
  userData = new UserDataStore(path.join(root, "user-data"));
  print = new PrintOrderService({
    jobs: userData.print,
    filler: new PrintFillerService({
      jobs: userData.print,
      dataRoot: path.join(root, "user-data"),
      workerEntry: path.join(root, "absent", "print-filler.js"),
    }),
    images: { scryfall: fakeScryfall(await solidPng(745, 1040)) },
  });
  alice = await connect("alice");
  bob = await connect("bob");
});

afterAll(async () => {
  await alice.close();
  await bob.close();
  await print.shutdown();
  userData.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

function structured(result: CallToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { result, data: structured(result) };
}

describe("print_* tools", () => {
  it("registers the four tools with deliberate annotations", async () => {
    const { tools } = await alice.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect([...PRINT_TOOLS].sort()).toEqual(
      ["print_prepare", "print_update", "print_start", "print_status"].sort(),
    );
    for (const name of PRINT_TOOLS) expect(byName.has(name), name).toBe(true);
    expect(byName.get("print_status")?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(byName.get("print_prepare")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(byName.get("print_update")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(byName.get("print_start")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("prepares, updates, reports and refuses to start a deck's print job for its own principal only", async () => {
    const created = await call(alice, "deck_create", {
      name: "Atraxa proxies",
      commanders: ["Atraxa, Praetors' Voice"],
    });
    const deckId = String(created.data.deck_id);
    const added = await call(alice, "deck_add", { deck_id: deckId, cards: ["Sol Ring"] });
    expect(added.result.isError).not.toBe(true);

    const prepared = await call(alice, "print_prepare", { deck_id: deckId });
    expect(prepared.result.isError).not.toBe(true);
    expect(prepared.data).toMatchObject({
      status: "prepared",
      created: true,
      total: 2,
      complete: true,
      attention: [],
      deck: { deck_id: deckId, version: 2 },
    });
    const jobId = String(prepared.data.job_id);
    expect(prepared.data.cards).toEqual([
      expect.objectContaining({
        slot: 1,
        name: "Atraxa, Praetors' Voice",
        source: "commander",
        front: { kind: "printing", scryfall_id: "p-atra" },
      }),
      expect.objectContaining({
        slot: 2,
        name: "Sol Ring",
        source: "library",
        front: { kind: "printing", scryfall_id: "p-sol-cmm" },
      }),
    ]);

    const updated = await call(alice, "print_update", {
      job_id: jobId,
      images: { "2": { front: { kind: "printing", scryfall_id: "p-sol-c21" } } },
      foil: true,
    });
    expect(updated.result.isError).not.toBe(true);
    expect(updated.data).toMatchObject({
      job_id: jobId,
      status: "prepared",
      settings: { foil: true },
    });
    expect((updated.data.cards as Array<Record<string, unknown>>)[1]).toMatchObject({
      front: { kind: "printing", scryfall_id: "p-sol-c21" },
    });

    const status = await call(alice, "print_status", { job_id: jobId });
    expect(status.result.isError).not.toBe(true);
    expect(status.data).toMatchObject({
      job_id: jobId,
      status: "prepared",
      deck: { deck_id: deckId, version: 2 },
      drift: { pinned_version: 2, live_version: 2, state: "current" },
      settings: { foil: true },
    });
    expect(status.data.attention).toEqual([expect.objectContaining({ kind: "worker_missing" })]);

    // No filler worker: starting is refused with the attention item, and the
    // job is left reviewed with its project file written.
    const refused = await call(alice, "print_start", { job_id: jobId });
    expect(refused.result.isError).toBe(true);
    expect(refused.data).toMatchObject({
      code: "PRINT_FILLER_UNAVAILABLE",
      attention: [expect.objectContaining({ kind: "worker_missing" })],
    });
    const reviewed = await call(alice, "print_status", { job_id: jobId });
    expect(reviewed.data).toMatchObject({ status: "reviewed" });
    expect((reviewed.data.evidence as Record<string, unknown>).project).toMatch(/project\.json$/);

    // The list form names the caller's jobs.
    const listed = await call(alice, "print_status", {});
    expect(listed.data.jobs).toEqual([
      expect.objectContaining({ job_id: jobId, status: "reviewed", deck_id: deckId }),
    ]);

    // Another principal cannot see, change or start it.
    for (const [name, args] of [
      ["print_status", { job_id: jobId }],
      ["print_update", { job_id: jobId, foil: false }],
      ["print_start", { job_id: jobId }],
    ] as const) {
      const other = await call(bob, name, args);
      expect(other.result.isError, name).toBe(true);
      expect(other.data).toMatchObject({ code: "PRINT_JOB_NOT_FOUND" });
    }
    const bobsDeck = await call(bob, "print_prepare", { deck_id: deckId });
    expect(bobsDeck.result.isError).toBe(true);
    expect(bobsDeck.data).toMatchObject({ code: "DECK_NOT_FOUND" });
    expect((await call(bob, "print_status", {})).data.jobs).toEqual([]);
  });

  it("rejects unknown argument keys and a stale expected_version", async () => {
    const strict = await call(alice, "print_status", { job: "x" });
    expect(strict.result.isError).toBe(true);

    const created = await call(alice, "deck_create", { name: "Versioned" });
    const deckId = String(created.data.deck_id);
    const conflict = await call(alice, "print_prepare", { deck_id: deckId, expected_version: 7 });
    expect(conflict.result.isError).not.toBe(true);
    expect(conflict.data).toMatchObject({
      ok: false,
      conflict: true,
      deck_id: deckId,
      expected_version: 7,
      current_version: 1,
    });
  });
});
