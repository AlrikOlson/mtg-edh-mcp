/**
 * Card resolution with live fallback (spec §3/§8).
 *
 * Resolves a card from the local index first; a local miss is treated as the
 * STALE_CARD / newer-than-snapshot condition and routes to the live Scryfall
 * client, whose raw JSON is mapped to a canonical §4 Card here (keeping the
 * mapping in one place and layering one-way: index -> ingest).
 */
import type { Card } from "../types/index.js";
import { LiveScryfallClient } from "../ingest/index.js";
import { CardIndex } from "./cardIndex.js";
import { mapScryfallCard } from "./map.js";

export interface CardFallbackResult {
  card: Card;
  /** Where the card came from: the local index, or a live Scryfall fetch. */
  source: "index" | "live";
}

export interface ResolveByNameOptions {
  index: CardIndex;
  live: LiveScryfallClient;
  name: string;
  /** Exact name match upstream (default fuzzy). */
  exact?: boolean;
}

/** Quote a name as a single FTS5 phrase so punctuation/spaces don't break MATCH. */
function ftsPhrase(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Resolve a card by name, preferring the local index and falling back to a live
 * Scryfall lookup when the card is absent locally (e.g. printed after the last
 * bulk snapshot).
 */
export async function resolveCardByNameFallback(
  options: ResolveByNameOptions,
): Promise<CardFallbackResult> {
  const hits = options.index.searchByName(ftsPhrase(options.name), 1);
  const top = hits[0];
  if (top) {
    const local = options.index.getCard(top.oracle_id);
    if (local) return { card: local, source: "index" };
  }
  const raw = await options.live.getCardByName(options.name, { exact: options.exact });
  return { card: mapScryfallCard(raw), source: "live" };
}
