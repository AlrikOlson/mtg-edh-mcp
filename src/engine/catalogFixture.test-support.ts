/** Test-only installation of frozen canonical records, without a network or re-ingestion. */
import Database from "better-sqlite3";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CardIndex } from "../index/cardIndex.js";
import { DeckStore } from "../deck/deckStore.js";
import { cachedSnapshotProvider } from "../server/snapshot.js";
import { CARD_INDEX_VERSION, SCHEMA_SQL } from "../index/schema.js";
import type { Card, Color, Deck } from "../types/index.js";
import { CatalogPayloadSchema, type CatalogPayload } from "./protocol.generated.js";

export interface CatalogFixture {
  source: CatalogPayload;
  deck: Deck;
  index: CardIndex;
  db: Database.Database;
  deckStore: DeckStore;
  snapshot: ReturnType<typeof cachedSnapshotProvider>;
  options(): import("./catalog.js").CatalogCaptureOptions;
  close(): Promise<void>;
}
export async function catalogFixture(payload?: CatalogPayload): Promise<CatalogFixture> {
  const source =
    payload ??
    CatalogPayloadSchema.parse(
      JSON.parse(
        await readFile(
          new URL("../../engine/contract/catalog-fixture.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  // The wire fixture intentionally makes no legality claim; give this default test deck
  // eligible front characteristics. Explicit frozen payloads are never changed.
  if (!payload) {
    const command = source.records[0]!.gameplay;
    command.characteristics.type_line = "Legendary Creature — Elemental";
    command.faces![0]!.characteristics.type_line = "Legendary Creature — Elemental";
    source.records[1]!.gameplay.characteristics.type_line = "Basic Land — Island";
  }
  const root = await mkdtemp(join(tmpdir(), "mtg-catalog-"));
  const db = new Database(join(root, "index.sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  db.pragma("user_version = " + CARD_INDEX_VERSION);
  const colors = (values: readonly string[] | null): Color[] =>
    (["W", "U", "B", "R", "G"] as const).filter((c) => values?.includes(c));
  for (const record of source.records) {
    const c = record.gameplay.characteristics;
    const card: Card = {
      oracle_id: record.oracle_id,
      name: c.name ?? record.oracle_id,
      gameplay: { ...record.gameplay, version: 1 },
      mana_cost: c.mana_cost ?? "",
      mv: c.cmc ?? 0,
      colors: colors(c.colors),
      color_identity: colors(record.gameplay.color_identity),
      type_line: c.type_line ?? "",
      oracle_text: c.oracle_text ?? "",
      keywords: c.keywords ?? [],
      legalities: { commander: "legal" },
      prices: {},
      printings: [],
      roles: [],
      is_commander_eligible: false,
    };
    db.prepare(
      "INSERT INTO cards (oracle_id,name,mv,type_line,color_identity,legalities_commander,oracle_text,card) VALUES (?,?,?,?,?,?,?,?)",
    ).run(
      card.oracle_id,
      card.name,
      card.mv,
      card.type_line,
      card.color_identity.join(""),
      "legal",
      card.oracle_text,
      JSON.stringify(card),
    );
    for (const id of record.printing_ids)
      db.prepare("INSERT INTO printings (oracle_id,scryfall_id,prices) VALUES (?,?,?)").run(
        card.oracle_id,
        id,
        "{}",
      );
  }
  const deck: Deck = {
    deck_id: source.deck.deck_id,
    name: "Captured fixture",
    format: "commander",
    commanders: source.deck.commanders.map((e) => e.oracle_id),
    command_zone_kind: source.deck.command_zone_kind,
    cards: source.deck.cards.map(({ oracle_id, qty }) => ({ oracle_id, qty })),
    computed_color_identity: colors(source.deck.computed_color_identity),
    version: source.deck.version,
    data_snapshot: source.data_snapshot,
    ...(source.deck.companion ? { companion: source.deck.companion.oracle_id } : {}),
  };
  const deckStore = new DeckStore({ newId: () => deck.deck_id });
  deckStore.create({ name: deck.name, dataSnapshot: deck.data_snapshot });
  const snapshot = cachedSnapshotProvider(source.data_snapshot);
  const index = CardIndex.open(join(root, "index.sqlite"));
  return {
    source,
    deck,
    index,
    db,
    deckStore,
    snapshot,
    options: () => {
      deckStore.update(deck.deck_id, () => structuredClone(deck));
      return {
        index,
        deckStore,
        deckId: deck.deck_id,
        expectedVersion: deckStore.get(deck.deck_id)!.version,
        expectedIndexRevision: index.revision(),
        snapshot: snapshot.provider,
      };
    },
    async close() {
      index.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
/** Frozen gameplay bytes with test-only legalities; this does not rebaseline the corpus. */
export async function baselineCatalogFixture(): Promise<CatalogFixture> {
  const { loadEngineBaseline, validateEngineBaseline } =
    await import("../evaluation/engineBaseline.js");
  const baseline = await loadEngineBaseline();
  if (validateEngineBaseline(baseline).length) throw new Error("Frozen baseline changed");
  return catalogFixture(
    CatalogPayloadSchema.parse({
      schema_version: 1,
      data_snapshot: baseline.data_snapshot,
      index_revision: "a".repeat(64),
      deck: {
        deck_id: baseline.deck.deck_id,
        version: baseline.deck.version,
        data_snapshot: baseline.data_snapshot,
        format: "commander",
        command_zone_kind: "single",
        computed_color_identity: baseline.deck.computed_color_identity,
        commanders: baseline.deck.commanders.map((oracle_id) => ({
          oracle_id,
          qty: 1,
          printing_id: null,
        })),
        cards: baseline.deck.cards.map(({ oracle_id, qty }) => ({
          oracle_id,
          qty,
          printing_id: null,
        })),
        companion: null,
      },
      records: baseline.records.map((r) => ({
        oracle_id: r.oracle_id,
        gameplay: r.gameplay,
        printing_ids: r.gameplay.source.scryfall_id ? [r.gameplay.source.scryfall_id] : [],
      })),
    }),
  );
}
