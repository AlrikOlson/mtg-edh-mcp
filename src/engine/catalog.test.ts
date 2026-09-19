import { createHash } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { captureCatalog } from "./catalog.js";
import { catalogFixture } from "./catalogFixture.test-support.js";
import { CatalogPayloadSchema, CharacteristicsSchema } from "./protocol.generated.js";
import { DeckStore } from "../deck/index.js";
import { createServer } from "../server/createServer.js";
import { staticSnapshotProvider } from "../server/snapshot.js";

let f: Awaited<ReturnType<typeof catalogFixture>>;
beforeEach(async () => {
  f = await catalogFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.close();
});

it("captures immutable source facts and printings without prices or name lookup", () => {
  const lookup = vi.spyOn(f.index, "resolveName");
  const command = f.deck.commanders[0]!;
  const printing = f.source.records[0]!.printing_ids[0]!;
  const result = captureCatalog({
    ...f.options(),
    printings: { [command]: printing },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  const payload = CatalogPayloadSchema.parse(JSON.parse(result.envelope.payload_json));
  expect(payload.records).toEqual(f.source.records);
  expect(payload.deck.commanders[0]?.printing_id).toBe(printing);
  expect(payload.deck.cards[0]?.qty).toBe(99);
  expect(payload.deck.version).toBe(f.deckStore.get(f.deck.deck_id)!.version);
  expect(result.envelope.payload_digest).toBe(
    createHash("sha256").update(result.envelope.payload_json, "utf8").digest("hex"),
  );
  expect(Object.isFrozen(result.envelope)).toBe(true);
  expect(lookup).not.toHaveBeenCalled();
  expect(result.envelope.payload_json).not.toContain("prices");
  const bytes = result.envelope.payload_json;
  f.deck.version += 1;
  f.db
    .prepare(
      "UPDATE cards SET card = json_set(card, '$.gameplay.characteristics.oracle_text', 'changed')",
    )
    .run();
  expect(result.envelope.payload_json).toBe(bytes);
  expect(JSON.parse(bytes)).toEqual(payload);
});

it("pins all reads even when another SQLite connection commits during capture", () => {
  const options = f.options();
  const getCard = f.index.getCard.bind(f.index);
  let changed = false;
  vi.spyOn(f.index, "getCard").mockImplementation((id) => {
    const card = getCard(id);
    if (!changed) {
      changed = true;
      f.db
        .prepare(
          "UPDATE cards SET card = json_set(card, '$.gameplay.characteristics.oracle_text', 'next snapshot')",
        )
        .run();
    }
    return card;
  });
  const result = captureCatalog(options);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  expect(JSON.parse(result.envelope.payload_json).records).toEqual(f.source.records);
  expect(f.index.revision()).not.toBe(options.expectedIndexRevision);
  expect(captureCatalog(options)).toMatchObject({
    ok: false,
    code: "stale_index",
  });
});

it("rejects stale authored versions and snapshot labels", () => {
  expect(captureCatalog({ ...f.options(), expectedVersion: 8 })).toMatchObject({
    ok: false,
    code: "stale_deck",
  });
  expect(
    captureCatalog({
      ...f.options(),
      snapshot: staticSnapshotProvider("next"),
    }),
  ).toMatchObject({
    ok: false,
    code: "snapshot_mismatch",
  });
});
it("rejects a changed stored deck, foreign session and changed served snapshot", () => {
  const options = f.options();
  f.deckStore.update(f.deck.deck_id, (deck) => ({ ...deck, name: "Changed" }));
  expect(captureCatalog(options)).toMatchObject({
    ok: false,
    code: "stale_deck",
  });
  expect(captureCatalog({ ...f.options(), session: "foreign" })).toMatchObject({
    ok: false,
    code: "missing_deck",
  });
  const current = f.options();
  f.snapshot.set("2026-09-10");
  expect(captureCatalog(current)).toMatchObject({
    ok: false,
    code: "snapshot_mismatch",
  });
});
it("rejects missing records and selected printings without substituting cards", () => {
  const command = f.deck.commanders[0]!;
  expect(captureCatalog({ ...f.options(), printings: { [command]: "unknown" } })).toMatchObject({
    ok: false,
    code: "printing_mismatch",
  });
  expect(captureCatalog({ ...f.options(), printings: { unused: "p-other" } })).toMatchObject({
    ok: false,
    code: "printing_mismatch",
  });
  f.deck.cards = [{ oracle_id: "absent", qty: 99 }];
  expect(captureCatalog(f.options())).toMatchObject({
    ok: false,
    code: "missing_card",
  });
});
it.each([
  ["$.gameplay", null],
  ["$.gameplay.characteristics.cmc", -1],
  ["$.gameplay.source.oracle_id", "wrong"],
  ["$.gameplay.faces[0].face_index", 1],
])("rejects malformed persisted canonical source %s", (path, value) => {
  f.db
    .prepare("UPDATE cards SET card = json_set(card, ?, ?) WHERE oracle_id = ?")
    .run(path, value, f.deck.cards[0]!.oracle_id);
  expect(captureCatalog(f.options())).toMatchObject({
    ok: false,
    code: "invalid_catalog",
  });
});
it("enforces required nulls, finite fractions, UTF-8 byte bounds and valid Unicode", () => {
  const source = f.source.records[0]!.gameplay.characteristics;
  expect(CharacteristicsSchema.parse({ ...source, cmc: 0.5 }).cmc).toBe(0.5);
  const { defense: _defense, ...missing } = source;
  void _defense;
  expect(CharacteristicsSchema.safeParse(missing).success).toBe(false);
  for (const cmc of [NaN, Infinity, -1])
    expect(CharacteristicsSchema.safeParse({ ...source, cmc }).success).toBe(false);
  expect(CharacteristicsSchema.safeParse({ ...source, name: "é".repeat(16384) }).success).toBe(
    true,
  );
  expect(CharacteristicsSchema.safeParse({ ...source, name: "é".repeat(16385) }).success).toBe(
    false,
  );
  expect(CharacteristicsSchema.safeParse({ ...source, name: "\ud800" }).success).toBe(false);
});
it("matches the real MCP whole-deck gate for accepted and rejected construction", async () => {
  const store = new DeckStore({ newId: () => f.deck.deck_id });
  const server = createServer({
    index: f.index,
    deckStore: store,
    snapshot: staticSnapshotProvider(f.deck.data_snapshot),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "catalog-acceptance", version: "1" });
  await client.connect(clientTransport);
  try {
    await client.callTool({
      name: "deck_create",
      arguments: { name: "Catalog" },
    });
    for (const qty of [99, 98]) {
      f.deck.cards = f.deck.cards.map((e) => ({ ...e, qty }));
      store.update(f.deck.deck_id, () => structuredClone(f.deck));
      const verdict = await client.callTool({
        name: "validate_deck",
        arguments: { deck_id: f.deck.deck_id },
      });
      const capture = captureCatalog(f.options());
      expect(verdict.structuredContent).toMatchObject({
        ok: capture.ok,
        violations: capture.violations,
      });
      expect(capture.ok).toBe(qty === 99);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
it("refuses the consolidated construction verdicts with the violations validate_deck reports", async () => {
  const store = new DeckStore({ newId: () => f.deck.deck_id });
  const server = createServer({
    index: f.index,
    deckStore: store,
    snapshot: staticSnapshotProvider(f.deck.data_snapshot),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "catalog-acceptance", version: "1" });
  await client.connect(clientTransport);
  const command = f.deck.commanders[0]!;
  const land = f.deck.cards[0]!.oracle_id;
  try {
    await client.callTool({ name: "deck_create", arguments: { name: "Catalog" } });
    const variants: Array<{ deck: () => void; rule: string }> = [
      {
        // The commander also in the library (CR 903.5a, 903.5b).
        deck: () => {
          f.deck.cards = [
            { oracle_id: command, qty: 1 },
            { oracle_id: land, qty: 98 },
          ];
        },
        rule: "COMMANDER_LIBRARY_OVERLAP",
      },
      {
        // A card the served record marks not legal in Commander.
        deck: () => {
          f.deck.cards = [{ oracle_id: land, qty: 99 }];
          f.db
            .prepare(
              "UPDATE cards SET card = json_set(card, '$.legalities.commander', 'not_legal'), legalities_commander = 'not_legal' WHERE oracle_id = ?",
            )
            .run(land);
        },
        rule: "FORMAT_ILLEGAL",
      },
    ];
    for (const variant of variants) {
      variant.deck();
      store.update(f.deck.deck_id, () => structuredClone(f.deck));
      const verdict = await client.callTool({
        name: "validate_deck",
        arguments: { deck_id: f.deck.deck_id },
      });
      const capture = captureCatalog(f.options());
      expect(capture).toMatchObject({ ok: false, code: "invalid_construction" });
      expect(capture.violations.map((v) => v.rule)).toContain(variant.rule);
      expect(verdict.structuredContent).toMatchObject({
        ok: false,
        violations: capture.violations,
      });
    }
  } finally {
    await client.close();
    await server.close();
  }
});
