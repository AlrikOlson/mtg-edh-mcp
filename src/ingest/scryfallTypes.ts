/**
 * Raw Scryfall card shapes (the upstream API contract). Owned by the ingest
 * layer; the canonical §4 Card mapping (src/index/map.ts) consumes these, and so
 * does the live fallback client — keeping all Scryfall-shaped types in one place
 * and preserving one-way layering (index depends on ingest, never the reverse).
 */

export interface ScryfallCardFace {
  name?: string;
  mana_cost?: string;
  oracle_text?: string;
  type_line?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
}

/** The subset of Scryfall card fields we read (from bulk files or the live API). */
export interface ScryfallCardRaw {
  /** Present on oracle_cards; may be absent on a few default_cards rows (skip those). */
  oracle_id?: string;
  /** Scryfall print id (used as the printing key in default_cards). */
  id?: string;
  name: string;
  mana_cost?: string;
  cmc?: number;
  colors?: string[];
  color_identity?: string[];
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  keywords?: string[];
  legalities?: Record<string, string>;
  prices?: Record<string, string | null>;
  card_faces?: ScryfallCardFace[];
  set?: string;
  set_name?: string;
  collector_number?: string;
  rarity?: string;
  released_at?: string;
}
