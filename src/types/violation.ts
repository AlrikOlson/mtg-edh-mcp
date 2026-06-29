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
  | "COMMANDER_ELIGIBILITY"
  | "MULTI_COMMANDER"
  | "COMPANION";

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
