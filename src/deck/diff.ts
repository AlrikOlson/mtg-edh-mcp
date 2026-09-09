/**
 * Pure deck diffing (spec §5B). Computes the delta between two deck states so
 * an agent can snapshot, mutate, and compare. Direction is from -> to: `added`
 * are entries present in `to` but not `from`; `removed` the reverse; `changed`
 * are entries in both with a different quantity.
 */
import type { Deck } from "../types/index.js";
import { isDeepStrictEqual } from "node:util";
import type { DeckIntent } from "./intent.js";

/** A card entry whose quantity changed between the two decks. */
export interface CardQtyChange {
  oracle_id: string;
  from_qty: number;
  to_qty: number;
}

/** A scalar metadata field that changed between the two decks. */
export interface FieldChange<T> {
  from: T;
  to: T;
}

/** Structured delta from one deck state to another. */
export interface DeckDiff {
  cards: {
    added: { oracle_id: string; qty: number }[];
    removed: { oracle_id: string; qty: number }[];
    changed: CardQtyChange[];
    flags?: Array<{
      oracle_id: string;
      from_illegal: boolean;
      to_illegal: boolean;
    }>;
  };
  metadata: {
    name?: FieldChange<string>;
    format?: FieldChange<Deck["format"]>;
    companion?: FieldChange<string | null>;
    computed_color_identity?: FieldChange<Deck["computed_color_identity"]>;
    data_snapshot?: FieldChange<string>;
    role_overrides?: FieldChange<Deck["role_overrides"] | null>;
    commanders?: FieldChange<readonly string[]>;
    command_zone_kind?: FieldChange<string>;
    intent?: FieldChange<DeckIntent | null>;
    version: FieldChange<number>;
  };
}

function qtyByOracle(deck: Deck): Map<string, number> {
  const m = new Map<string, number>();
  for (const entry of deck.cards) m.set(entry.oracle_id, (m.get(entry.oracle_id) ?? 0) + entry.qty);
  return m;
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Compute the card-entry + metadata delta going from `from` to `to`. */
export function diffDecks(from: Deck, to: Deck): DeckDiff {
  const fromQty = qtyByOracle(from);
  const toQty = qtyByOracle(to);

  const added: { oracle_id: string; qty: number }[] = [];
  const removed: { oracle_id: string; qty: number }[] = [];
  const changed: CardQtyChange[] = [];

  for (const [oracle_id, to_qty] of toQty) {
    const from_qty = fromQty.get(oracle_id);
    if (from_qty === undefined) added.push({ oracle_id, qty: to_qty });
    else if (from_qty !== to_qty) changed.push({ oracle_id, from_qty, to_qty });
  }
  for (const [oracle_id, qty] of fromQty) {
    if (!toQty.has(oracle_id)) removed.push({ oracle_id, qty });
  }

  const metadata: DeckDiff["metadata"] = {
    version: { from: from.version, to: to.version },
  };
  if (from.name !== to.name) metadata.name = { from: from.name, to: to.name };
  if (!sameStringList(from.commanders, to.commanders)) {
    metadata.commanders = { from: from.commanders, to: to.commanders };
  }
  if (from.command_zone_kind !== to.command_zone_kind) {
    metadata.command_zone_kind = {
      from: from.command_zone_kind,
      to: to.command_zone_kind,
    };
  }
  if (!isDeepStrictEqual(from.intent, to.intent)) {
    metadata.intent = { from: from.intent ?? null, to: to.intent ?? null };
  }

  if (from.format !== to.format) metadata.format = { from: from.format, to: to.format };
  if (from.companion !== to.companion)
    metadata.companion = {
      from: from.companion ?? null,
      to: to.companion ?? null,
    };
  if (!sameStringList(from.computed_color_identity, to.computed_color_identity))
    metadata.computed_color_identity = {
      from: from.computed_color_identity,
      to: to.computed_color_identity,
    };
  if (from.data_snapshot !== to.data_snapshot)
    metadata.data_snapshot = { from: from.data_snapshot, to: to.data_snapshot };
  if (!isDeepStrictEqual(from.role_overrides, to.role_overrides))
    metadata.role_overrides = {
      from: from.role_overrides ?? null,
      to: to.role_overrides ?? null,
    };
  const fromFlags = new Set(
    from.cards.filter((entry) => entry.illegal).map((entry) => entry.oracle_id),
  );
  const toFlags = new Set(
    to.cards.filter((entry) => entry.illegal).map((entry) => entry.oracle_id),
  );
  const flags = [...new Set([...fromFlags, ...toFlags])]
    .filter((oracleId) => fromFlags.has(oracleId) !== toFlags.has(oracleId))
    .map((oracle_id) => ({
      oracle_id,
      from_illegal: fromFlags.has(oracle_id),
      to_illegal: toFlags.has(oracle_id),
    }));
  return {
    cards: { added, removed, changed, ...(flags.length ? { flags } : {}) },
    metadata,
  };
}
