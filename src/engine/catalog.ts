/** Capture canonical inputs for the internal worker. Success is never play admission. */
import { createHash } from "node:crypto";
import type { CardIndex } from "../index/cardIndex.js";
import type { DeckStore } from "../deck/deckStore.js";
import type { SnapshotProvider } from "../server/snapshot.js";
import type { Card, Violation } from "../types/index.js";
import { validateDeck } from "../validate/validateDeck.js";
import { commanderColorIdentity } from "../validate/commanderRules.js";
import {
  CatalogEnvelopeSchema,
  CatalogGameplaySchema,
  CatalogPayloadSchema,
  type CatalogEnvelope,
  type CatalogEntry,
  type CatalogRecord,
} from "./protocol.generated.js";

export interface CatalogCaptureOptions {
  index: CardIndex;
  deckStore: DeckStore;
  deckId: string;
  session?: string;
  expectedVersion: number;
  expectedIndexRevision: string;
  /** Served snapshot label paired with this index, not a download date guessed by the worker. */
  snapshot: SnapshotProvider;
  /** Optional printing choice per Oracle identity; absent means unspecified. */
  printings?: Readonly<Record<string, string>>;
}
type CaptureError =
  | "missing_deck"
  | "stale_deck"
  | "stale_index"
  | "snapshot_mismatch"
  | "missing_card"
  | "printing_mismatch"
  | "invalid_catalog"
  | "invalid_construction";
export type CatalogCaptureResult =
  | { ok: true; envelope: Readonly<CatalogEnvelope>; violations: Violation[] }
  | { ok: false; code: CaptureError; violations: Violation[] };
const failure = (code: CaptureError, violations: Violation[] = []): CatalogCaptureResult => ({
  ok: false,
  code,
  violations,
});

/** No async boundary, name resolution, pricing, registry lookup or gameplay implementation. */
export function captureCatalog(options: CatalogCaptureOptions): CatalogCaptureResult {
  const { index } = options;
  return index.withRead(() => {
    const deck = options.deckStore.get(options.deckId, options.session ?? "local");
    if (!deck) return failure("missing_deck");
    if (deck.version !== options.expectedVersion) return failure("stale_deck");
    const revision = index.revision();
    const dataSnapshot = options.snapshot();
    if (revision !== options.expectedIndexRevision) return failure("stale_index");
    if (deck.data_snapshot !== dataSnapshot) return failure("snapshot_mismatch");

    const entries = [
      ...deck.commanders.map((oracle_id) => ({ oracle_id, qty: 1 })),
      ...deck.cards,
      ...(deck.companion ? [{ oracle_id: deck.companion, qty: 1 }] : []),
    ];
    // Operational bounds and authored inventory shape, not new Commander copy rules.
    if (
      entries.length > 1003 ||
      entries.reduce((n, e) => n + e.qty, 0) > 1000 ||
      new Set(deck.cards.map((e) => e.oracle_id)).size !== deck.cards.length
    )
      return failure("invalid_catalog");
    const cards = new Map<string, Card>();
    const records: CatalogRecord[] = [];
    const printingOwners = new Map<string, string>();
    for (const { oracle_id } of entries) {
      if (cards.has(oracle_id)) continue;
      const card = index.getCard(oracle_id);
      if (!card) return failure("missing_card");
      const parsed = CatalogGameplaySchema.safeParse(card.gameplay);
      if (!parsed.success || card.oracle_id !== oracle_id) return failure("invalid_catalog");
      const gameplay = parsed.data;
      if (gameplay.source.oracle_id !== null && gameplay.source.oracle_id !== oracle_id)
        return failure("invalid_catalog");
      if (
        gameplay.faces?.some(
          (f, i, faces) =>
            f.face_index !== i ||
            !(f.source_path === "/card_faces/" + i || (faces.length === 1 && f.source_path === "")),
        )
      )
        return failure("invalid_catalog");
      const printing_ids = [
        ...new Set([
          ...card.printings.map((p) => p.scryfall_id),
          ...(gameplay.source.scryfall_id ? [gameplay.source.scryfall_id] : []),
        ]),
      ];
      for (const printing of printing_ids) {
        if (printingOwners.has(printing)) return failure("invalid_catalog");
        printingOwners.set(printing, oracle_id);
      }
      cards.set(oracle_id, card);
      records.push({ oracle_id, gameplay, printing_ids });
    }
    for (const [oracle, printing] of Object.entries(options.printings ?? {}))
      if (!cards.has(oracle) || printingOwners.get(printing) !== oracle)
        return failure("printing_mismatch");
    const lookup = (id: string) => cards.get(id) ?? null;
    // Detect stale computed metadata using the existing identity authority.
    if (commanderColorIdentity(deck, lookup).join("") !== deck.computed_color_identity.join(""))
      return failure("invalid_catalog");
    const violations = validateDeck(deck, lookup);
    if (violations.some((v) => v.severity === "error"))
      return failure("invalid_construction", violations);
    const entry = (oracle_id: string, qty: number): CatalogEntry => ({
      oracle_id,
      qty,
      printing_id: options.printings?.[oracle_id] ?? null,
    });
    const payload = CatalogPayloadSchema.safeParse({
      schema_version: 1,
      data_snapshot: dataSnapshot,
      index_revision: revision,
      deck: {
        deck_id: deck.deck_id,
        version: deck.version,
        data_snapshot: deck.data_snapshot,
        format: deck.format,
        command_zone_kind: deck.command_zone_kind,
        computed_color_identity: deck.computed_color_identity,
        commanders: deck.commanders.map((id) => entry(id, 1)),
        cards: deck.cards.map((e) => entry(e.oracle_id, e.qty)),
        companion: deck.companion ? entry(deck.companion, 1) : null,
      },
      records,
    });
    if (!payload.success) return failure("invalid_catalog");
    const payload_json = JSON.stringify(payload.data);
    const envelope = CatalogEnvelopeSchema.safeParse({
      payload_json,
      payload_digest: createHash("sha256").update(payload_json, "utf8").digest("hex"),
      expected_index_revision: revision,
      expected_deck_id: deck.deck_id,
      expected_deck_version: deck.version,
    });
    if (!envelope.success) return failure("invalid_catalog");
    // Every envelope field is scalar, so freezing severs all mutable source aliases.
    return { ok: true, envelope: Object.freeze(envelope.data), violations };
  });
}
