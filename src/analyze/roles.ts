/**
 * Functional role taxonomy classifier (spec §7). Pure heuristics over a card's
 * oracle text, type line, and keywords that label it with zero or more
 * {@link Role}s (ramp, removal, draw, …).
 *
 * ADVISORY ONLY: roles never feed validation (src/validate must not import
 * this). They drive composition/coverage analysis (p5-basic / p5-mana) and are
 * deliberately heuristic — a card may carry several roles or none. combo_piece
 * and payoff are intentionally left to later override/feedback work; they can't
 * be inferred reliably from text alone.
 */
import { ROLES, type Card, type Role } from "../types/index.js";

/** The card fields the classifier reads. */
export type RoleInput = Pick<Card, "name" | "type_line" | "oracle_text" | "keywords" | "mana_cost">;

function has(re: RegExp, s: string): boolean {
  return re.test(s);
}

/** Classify a card into zero or more functional roles (advisory). */
export function classifyRoles(card: RoleInput): Role[] {
  const type = card.type_line;
  const text = card.oracle_text;
  const kw = card.keywords.map((k) => k.toLowerCase());
  const roles = new Set<Role>();

  const isLand = /\bLand\b/.test(type);
  const isCreature = /\bCreature\b/.test(type);
  const isArtifact = /\bArtifact\b/.test(type);
  const addsMana =
    /\badd\b[^.]*\{(?:[WUBRGC]|\d)\}/i.test(text) || /\badd\b[^.]*\bmana\b/i.test(text);
  const anyColor =
    /mana of any (?:one )?color/i.test(text) || /add one mana of any color/i.test(text);

  if (isLand) roles.add("land");

  // Mana production / ramp.
  const manaRock = isArtifact && !isCreature && addsMana;
  const manaDork = isCreature && addsMana;
  if (manaRock) roles.add("mana_rock");
  if (manaDork) roles.add("mana_dork");
  const landRamp =
    /search your library for[^.]*\bland\b/i.test(text) && /onto the battlefield/i.test(text);
  if (manaRock || manaDork || landRamp) roles.add("ramp");

  // Color fixing.
  if (anyColor || (isLand && addsMana && /\{[WUBRG]\}[^.]*\{[WUBRG]\}/.test(text))) {
    roles.add("fixing");
  }

  // Card draw / advantage.
  if (/\bdraw(?:s)? (?:a|one|two|three|four|x|that many|\d+) cards?\b/i.test(text)) {
    roles.add("card_draw");
    roles.add("card_advantage");
  }

  // Tutor: search the library for a card to hand/top — but not a land ramp spell.
  if (
    /search your library for[^.]*card/i.test(text) &&
    /(into your hand|top of your library)/i.test(text) &&
    !/\bbasic land\b/i.test(text)
  ) {
    roles.add("tutor");
  }

  // Removal.
  if (
    /(destroy|exile) all\b/i.test(text) ||
    /each (?:creature|player|opponent)[^.]*sacrifices/i.test(text)
  ) {
    roles.add("board_wipe");
  } else if (
    /(destroy|exile) target (?:creature|permanent|nonland|artifact|enchantment|planeswalker|player)/i.test(
      text,
    )
  ) {
    roles.add("spot_removal");
  }

  if (/counter target/i.test(text)) roles.add("counterspell");

  // Protection.
  if (
    /\b(hexproof|indestructible|shroud)\b/i.test(text) ||
    kw.some((k) => k === "hexproof" || k === "indestructible" || k === "ward") ||
    /protection from/i.test(text) ||
    /prevent all (?:combat )?damage/i.test(text)
  ) {
    roles.add("protection");
  }

  // Recursion from the graveyard.
  if (/return[^.]*from (?:your |a )?graveyard to (?:the battlefield|your hand)/i.test(text)) {
    roles.add("recursion");
  }

  // Graveyard hate.
  if (
    /exile[^.]*(?:from|target)[^.]*graveyard/i.test(text) ||
    /exile[^.]*all[^.]*graveyard/i.test(text)
  ) {
    roles.add("graveyard_hate");
  }

  // Stax / resource denial.
  if (
    /opponents?[^.]*can't/i.test(text) ||
    /can't untap/i.test(text) ||
    /skip[^.]*untap step/i.test(text)
  ) {
    roles.add("stax");
  }

  // Wincon.
  if (/wins? the game/i.test(text) || /loses? the game/i.test(text)) roles.add("wincon");

  // Utility fallback: an interactive card that matched nothing else.
  if (
    roles.size === 0 &&
    !isLand &&
    (has(/:/, text) || /\b(when|whenever|at the beginning)\b/i.test(text))
  ) {
    roles.add("utility");
  }

  // Emit in canonical ROLES order for determinism.
  return ROLES.filter((r) => roles.has(r));
}
