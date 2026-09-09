/**
 * Raw Scryfall shapes shared by bulk ingest and live lookup. Nullable optional
 * fields preserve the API's absent values; canonical mapping owns projections.
 */
export interface ScryfallCharacteristicsRaw {
  name?: string | null;
  mana_cost?: string | null;
  cmc?: number | null;
  colors?: string[] | null;
  color_indicator?: string[] | null;
  type_line?: string | null;
  oracle_text?: string | null;
  power?: string | null;
  toughness?: string | null;
  loyalty?: string | null;
  defense?: string | null;
  keywords?: string[] | null;
  produced_mana?: string[] | null;
  printed_name?: string | null;
  printed_text?: string | null;
  printed_type_line?: string | null;
}
export interface ScryfallCardFace extends ScryfallCharacteristicsRaw {
  oracle_id?: string | null;
}
export interface ScryfallRelatedCard {
  id: string;
  component: string;
  name: string;
  type_line: string;
  uri: string;
}
/** The subset of Scryfall fields read from bulk files or the live API. */
export interface ScryfallCardRaw extends ScryfallCharacteristicsRaw {
  oracle_id?: string;
  /** Scryfall printing identity, distinct from canonical Oracle identity. */
  id?: string;
  name: string;
  layout?: string | null;
  color_identity?: string[];
  legalities?: Record<string, string>;
  prices?: Record<string, string | null>;
  card_faces?: ScryfallCardFace[] | null;
  all_parts?: ScryfallRelatedCard[] | null;
  set?: string;
  set_name?: string;
  collector_number?: string;
  rarity?: string;
  released_at?: string;
  game_changer?: boolean;
}
