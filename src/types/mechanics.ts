/**
 * Card mechanics evidence (Commander workshop: strategy and synergy).
 *
 * A mechanic annotation is a bounded, inspectable claim about a card's Oracle
 * text: the ability it sits in, the pattern it matched, which player's
 * resources it concerns, whether it is conditional, and the exact source span
 * that supports it. Text the extractor does not model is reported as such —
 * never guessed. Nothing here is a rules interpreter: annotations never assert
 * legality, playability, or that an ability resolves in a given game.
 */
import type { OracleTextEvidence } from "./card.js";

/** Bump on any change to extraction behavior; annotations carry it verbatim. */
export const MECHANICS_EXTRACTOR_VERSION = "1.0.0";

/** Where an annotation sits inside an ability (CR 602/603 terminology). */
export type MechanicCategory = "trigger" | "cost" | "effect" | "permission";

/** Ability classification of the paragraph an annotation was read from. */
export type AbilityKind = "triggered" | "activated" | "static" | "spell";

/** Whose resources or actions a mechanic concerns. */
export type MechanicSubject =
  "controller" | "opponent" | "each_player" | "target_player" | "any_player" | "self" | "unknown";

export type MechanicZone = "battlefield" | "graveyard" | "hand" | "library" | "exile" | "stack";

/** Trigger events the extractor recognizes. */
export type TriggerKind =
  | "enters_battlefield"
  | "dies"
  | "leaves_battlefield"
  | "landfall"
  | "cast_spell"
  | "sacrifice"
  | "attacks"
  | "blocks"
  | "combat_damage_player"
  | "deals_damage"
  | "lifegain"
  | "lose_life"
  | "draw"
  | "discard"
  | "token_created"
  | "counters_placed"
  | "upkeep"
  | "draw_step"
  | "beginning_of_combat"
  | "end_step"
  | "card_to_graveyard"
  | "leaves_graveyard"
  | "becomes_tapped"
  | "becomes_targeted";

/** Cost elements the extractor recognizes (everything before the colon). */
export type CostKind =
  | "tap"
  | "untap"
  | "mana"
  | "sacrifice_self"
  | "sacrifice_permanent"
  | "discard_cards"
  | "pay_life"
  | "remove_counters"
  | "exile_from_graveyard"
  | "return_to_hand"
  | "tap_permanent";

/** Effects the extractor recognizes (resolution text and spell text). */
export type EffectKind =
  | "create_token"
  | "put_counters"
  | "enters_with_counters"
  | "proliferate"
  | "draw_cards"
  | "discard_cards"
  | "sacrifice_self"
  | "sacrifice_permanent"
  | "gain_life"
  | "lose_life"
  | "mill"
  | "scry"
  | "surveil"
  | "return_from_graveyard"
  | "exile_from_graveyard"
  | "deal_damage"
  | "destroy"
  | "exile"
  | "search_library"
  | "add_mana"
  | "counter_spell";

/** Standing permissions granted by static text. */
export type PermissionKind = "cast_from_graveyard";

export type MechanicKind = TriggerKind | CostKind | EffectKind | PermissionKind;

/** A declared supported pattern: the only claims the extractor may make. */
export interface MechanicPattern {
  /** `<category>.<kind>`, stable across extractor versions. */
  id: string;
  category: MechanicCategory;
  kind: MechanicKind;
  description: string;
}

export interface MechanicCondition {
  kind: "unconditional" | "conditional";
  /** The supporting clause when conditional (intervening-if, unless, as long as, timing restriction, modal choice). */
  text: string | null;
}

/** A parsed quantity where the text states one. */
export type MechanicAmount = number | "X" | "variable" | null;

export interface MechanicAnnotation {
  status: "supported";
  pattern_id: string;
  category: MechanicCategory;
  kind: MechanicKind;
  ability_index: number;
  ability_kind: AbilityKind;
  face_index: number | null;
  subject: MechanicSubject;
  /** Object or resource phrase read from the text (token type, counter type, spell filter…). */
  qualifier: string | null;
  amount: MechanicAmount;
  zones: { from: MechanicZone | null; to: MechanicZone | null };
  condition: MechanicCondition;
  /** "you may" text: the controller chooses whether the effect happens. */
  optional: boolean;
  /** explicit: backed by a Scryfall keyword/ability word; inferred: read from Oracle text patterns. */
  provenance: "explicit" | "inferred";
  evidence: OracleTextEvidence;
  extractor_version: string;
}

/** Text the extractor read but does not model, or could not classify safely. */
export interface UnmodeledSpan {
  status: "unmodeled" | "uncertain";
  ability_index: number;
  ability_kind: AbilityKind | null;
  face_index: number | null;
  reason: string;
  evidence: OracleTextEvidence;
}

export interface MechanicsCoverage {
  abilities_total: number;
  abilities_with_support: number;
  abilities_fully_modeled: number;
  sentences_total: number;
  sentences_supported: number;
  sentences_unmodeled: number;
  sentences_uncertain: number;
}

export interface CardMechanics {
  version: 1;
  extractor_version: string;
  oracle_id: string;
  name: string;
  /** gameplay_faces: read from canonical face characteristics; flat_oracle_text: legacy card without gameplay facts. */
  source: "gameplay_faces" | "flat_oracle_text";
  annotations: readonly MechanicAnnotation[];
  unmodeled: readonly UnmodeledSpan[];
  coverage: MechanicsCoverage;
  /** Never asserted by this module. */
  legality: "not_evaluated";
}
