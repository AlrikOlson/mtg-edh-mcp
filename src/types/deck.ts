/**
 * Deck state model (spec §4 / §2).
 */
import type { ColorIdentity } from "./color.js";
import type { Role } from "./card.js";

/**
 * Deckbuilding format. `commander` is the v1 target; the field is first-class so
 * the rules engine can later generalize to Brawl/Oathbreaker (backlog §12).
 */
export type Format = "commander";

/**
 * The command-zone configuration (§4 / §6) — which multi-commander rule the
 * deck's command zone uses.
 */
export type CommandZoneKind = "single" | "partner" | "background" | "doctor_companion";

/** A card entry in a deck: an oracle_id with a quantity (§4). */
export interface DeckCardEntry {
  oracle_id: string;
  qty: number;
  /**
   * Set when the card was force-added despite a validation Violation (§5B): the
   * card stays in the deck state but is flagged illegal rather than dropped.
   */
  illegal?: boolean;
}

/**
 * `Deck` (§4) — long-lived, versioned, session-scoped server state (§2).
 */
export interface Deck {
  deck_id: string;
  name: string;
  format: Format;
  /** Commander oracle_id(s); 1 for single, 2 for partner/background/companion. */
  commanders: readonly string[];
  command_zone_kind: CommandZoneKind;
  /**
   * A declared companion's oracle_id (§6), when one is chosen. Its deckbuilding
   * condition is checked by validate_deck only while declared; absent means no
   * companion. The companion lives outside the 100-card deck (it is not in
   * `cards`).
   */
  companion?: string;
  cards: readonly DeckCardEntry[];
  /** Union of the commanders' color identities (§6). */
  computed_color_identity: ColorIdentity;
  /** Optimistic-concurrency version, bumped on every mutation (§2/§11). */
  version: number;
  /** ISO date of the card index this deck was last computed against (§3/§11). */
  data_snapshot: string;
  /** User-specified role labels, preserved by persistence and deck snapshots. */
  role_overrides?: Readonly<Record<string, readonly Role[]>>;
}
