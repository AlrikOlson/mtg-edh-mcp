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

/**
 * `Card` (§4) — the full object, returned only by `card_get` / the `card://`
 * resource. Carries all Scryfall gameplay fields plus server-derived `roles`
 * (§7) and `printings`.
 */
export interface Card {
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
