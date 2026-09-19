/**
 * Validation output model (spec §4 / §5C / §6).
 */
import type { CardRef } from "./card.js";

/** Severity separates hard legality errors from advisories (§5C/§6). */
export type Severity = "error" | "warning";

/**
 * The validation rule that produced a {@link Violation}, mirroring the ordered
 * checks `validate_deck` runs (§6). The rules engine (p4) owns the semantics;
 * this union names them so output is branchable without prose parsing.
 */
export type ViolationRule =
  | "CARD_COUNT"
  | "SINGLETON"
  | "COLOR_IDENTITY"
  | "BANLIST"
  /** A card whose Commander legality is not_legal (or restricted); banned is BANLIST. */
  | "FORMAT_ILLEGAL"
  /** A card record carrying no Commander legality at all. */
  | "FORMAT_LEGALITY_UNKNOWN"
  /** A commander that also appears in the library beyond its copy limit (CR 903.5a, 903.5b). */
  | "COMMANDER_LIBRARY_OVERLAP"
  | "COMMANDER_ELIGIBILITY"
  | "MULTI_COMMANDER"
  | "COMPANION"
  /** The declared companion also sits in the starting deck (CR 702.139a). */
  | "COMPANION_DECK_OVERLAP"
  /** The companion condition cannot be established exactly over the starting deck. */
  | "COMPANION_CONDITION_UNRESOLVED";

/**
 * `Violation` (§4) — the unit of validation output. `card` is omitted for
 * deck-level violations (e.g. a card-count delta).
 */
export interface Violation {
  rule: ViolationRule;
  severity: Severity;
  /** The offending card, when the violation is card-scoped. */
  card?: Pick<CardRef, "oracle_id" | "name">;
  /** Human-readable specifics, e.g. "R not in deck identity WUBG". */
  detail: string;
  /** Actionable suggestion, e.g. "remove or change commander". */
  fix_hint?: string;
}
