/**
 * Pure deck diffing (spec §5B). Computes the delta between two deck states so
 * an agent can snapshot, mutate, and compare. Direction is from -> to: `added`
 * are entries present in `to` but not `from`; `removed` the reverse; `changed`
 * are entries in both with a different quantity.
 */
import type { Deck } from "../types/index.js";

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
  };
  metadata: {
    name?: FieldChange<string>;
    commanders?: FieldChange<readonly string[]>;
    command_zone_kind?: FieldChange<string>;
    version: FieldChange<number>;
  };
}

function qtyByOracle(deck: Deck): Map<string, number> {
  const m = new Map<string, number>();
  for (const entry of deck.cards) m.set(entry.oracle_id, entry.qty);
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

  const metadata: DeckDiff["metadata"] = { version: { from: from.version, to: to.version } };
  if (from.name !== to.name) metadata.name = { from: from.name, to: to.name };
  if (!sameStringList(from.commanders, to.commanders)) {
    metadata.commanders = { from: from.commanders, to: to.commanders };
  }
  if (from.command_zone_kind !== to.command_zone_kind) {
    metadata.command_zone_kind = { from: from.command_zone_kind, to: to.command_zone_kind };
  }

  return { cards: { added, removed, changed }, metadata };
}
