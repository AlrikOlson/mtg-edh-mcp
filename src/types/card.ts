/**
 * Card data model (spec §4 + §7).
 */
import type { Color, ColorIdentity, RefColorIdentity } from "./color.js";

/**
 * Functional roles (spec §7). Heuristic and intentionally advisory — derived by
 * the classifier (p5-roles); they feed coverage analysis, never validation.
 */
export type Role =
  | "ramp"
  | "mana_rock"
  | "mana_dork"
  | "land"
  | "fixing"
  | "card_draw"
  | "card_advantage"
  | "tutor"
  | "spot_removal"
  | "board_wipe"
  | "counterspell"
  | "protection"
  | "recursion"
  | "graveyard_hate"
  | "stax"
  | "combo_piece"
  | "payoff"
  | "wincon"
  | "utility";

/** All §7 roles, in spec order — the runtime companion to the {@link Role} union. */
export const ROLES = [
  "ramp",
  "mana_rock",
  "mana_dork",
  "land",
  "fixing",
  "card_draw",
  "card_advantage",
  "tutor",
  "spot_removal",
  "board_wipe",
  "counterspell",
  "protection",
  "recursion",
  "graveyard_hate",
  "stax",
  "combo_piece",
  "payoff",
  "wincon",
  "utility",
] as const satisfies readonly Role[];

/** A Scryfall per-format legality status. */
export type Legality = "legal" | "not_legal" | "restricted" | "banned";

/**
 * Per-format legality map (Scryfall `legalities`). Keyed by format name; the
 * `commander` key is authoritative for the banlist (§6). Kept as an open record
 * so newly added formats survive a bulk refresh without a code change.
 */
export type Legalities = Record<string, Legality>;

/**
 * Price map (Scryfall `prices`). Keyed by currency/finish (`usd`, `usd_foil`,
 * `eur`, `tix`, …); values are decimal strings or null when unpriced.
 */
export type Prices = Record<string, string | null>;

/**
 * `CardRef` (§4) — the lean currency that moves between tools. Colorless cards
 * use the `["C"]` sentinel in `ci`.
 */
export interface CardRef {
  oracle_id: string;
  name: string;
  /** Mana value (converted mana cost). */
  mv: number;
  /** Color identity, lean form (`["C"]` for colorless). */
  ci: RefColorIdentity;
  /** Primary type, e.g. "Artifact" or "Legendary Creature — Elf Druid". */
  type: string;
}

/** A single printing of a card (spec §4 `printings[]`; populated by p1/p2). */
export interface Printing {
  /** Scryfall print id (unique per printing). */
  scryfall_id: string;
  set: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  prices: Prices;
  /** ISO release date of the set/printing. */
  released_at?: string;
}

/** Source characteristics only. Null means not supplied, never a derived zero/empty.
 * Arrays preserve upstream values/order, including future mana symbols.
 * cmc is supplied mana value, not a cost calculation or a claim about a face in play.
 */
export interface CardCharacteristics {
  name: string | null;
  mana_cost: string | null;
  cmc: number | null;
  type_line: string | null;
  oracle_text: string | null;
  colors: readonly string[] | null;
  color_indicator: readonly string[] | null;
  power: string | null;
  toughness: string | null;
  loyalty: string | null;
  defense: string | null;
  keywords: readonly string[] | null;
  /** Possible outputs; does not establish quantity, restrictions or availability. */
  produced_mana: readonly string[] | null;
  printed_name: string | null;
  printed_text: string | null;
  printed_type_line: string | null;
}

export interface CardFace {
  /** Position within this canonical card, never a separate physical-card count. */
  face_index: number;
  /** JSON Pointer in the source card: "" for root, "/card_faces/0" for a face. */
  source_path: string;
  /** A face's own supplied Oracle identity (e.g. reversible cards), not inherited. */
  oracle_id: string | null;
  characteristics: CardCharacteristics;
}

/** Scryfall printing links, not additional faces or additional deck entries. */
export interface RelatedCard {
  id: string;
  component: string;
  name: string;
  type_line: string;
  uri: string;
}

export interface CardGameplay {
  version: 1;
  source: { scryfall_id: string | null; oracle_id: string | null };
  layout: string | null;
  /** Supplied whole-card Commander identity; never copied to individual faces. */
  color_identity: readonly string[] | null;
  /** Layout classification only. Split/Fuse, Adventure, transform and meld need rules/context. */
  face_relationship:
    "single" | "split" | "adventure" | "modal" | "transform" | "meld" | "unknown" | "unsupported";
  /** No face or combination is asserted to be currently playable. */
  playability: "not_evaluated";
  characteristics: CardCharacteristics;
  /** Supplied ordered faces; one root-source face for normal/meld; null when unknown. */
  faces: readonly CardFace[] | null;
  related_cards: readonly RelatedCard[] | null;
}

export interface OracleTextEvidence {
  oracle_id: string;
  scryfall_id: string | null;
  face_index: number | null;
  source_oracle_id: string | null;
  /** JSON Pointer to the original Oracle field, never the joined display projection. */
  field_path: string;
  offset_unit: "utf16_code_units";
  /** Half-open [start, end) offsets into that field's unmodified text. */
  start: number;
  end: number;
  text: string;
}

/** Full card plus flat compatibility projections, source evidence and printings. */
export interface Card {
  /** Present on newly ingested cards; absent on legacy caller-created objects. */
  gameplay?: CardGameplay | null;
  oracle_id: string;
  name: string;
  mana_cost: string;
  /** Mana value (converted mana cost). */
  mv: number;
  colors: readonly Color[];
  color_identity: ColorIdentity;
  type_line: string;
  oracle_text: string;
  /** Scryfall power/toughness/loyalty are strings (e.g. "*", "1+*"). */
  power?: string;
  toughness?: string;
  loyalty?: string;
  keywords: readonly string[];
  legalities: Legalities;
  prices: Prices;
  /** Server-derived: is this card legal in the command zone? */
  is_commander_eligible: boolean;
  /** On WotC's official Game Changers list (Scryfall `game_changer`). */
  game_changer?: boolean;
  /** Server-derived functional roles (§7). */
  roles: readonly Role[];
  printings: readonly Printing[];
}
