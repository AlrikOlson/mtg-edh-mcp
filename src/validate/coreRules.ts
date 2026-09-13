/**
 * Core Commander validation rules (spec §6) — pure functions over a deck and a
 * card lookup, returning structured {@link Violation}s. No MCP/DeckStore
 * coupling: the validate_* tools (p4-tools) wire these to a CardIndex.
 *
 * The four core rules:
 *  - card count: exactly 100 including the command zone (report the delta);
 *  - singleton: at most one of each card, except basics, a curated "any number"
 *    allowlist, and cards whose oracle text grants any number;
 *  - color identity: each card's identity must be a subset of the deck's;
 *  - banlist: a card is banned iff `legalities.commander === "banned"` — derived
 *    purely from Scryfall data, never a hardcoded list.
 */
import type { Card, Color, Deck, Violation } from "../types/index.js";

/** Resolves an oracle_id to its full Card, or null when unknown. */
export type CardLookup = (oracleId: string) => Card | null;

/** Commander decks are exactly 100 cards including the command zone (§6). */
export const COMMANDER_DECK_SIZE = 100;

/**
 * Cards whose Oracle text grants any number of copies, kept as a safety net in
 * case a printing's text drifts from the generic phrase below. Bounded
 * exceptions (Seven Dwarves, Nazgûl) are never listed here: their limit is read
 * from the card text so the validator cannot silently widen it.
 */
const ANY_NUMBER_ALLOWLIST = new Set<string>([
  "Relentless Rats",
  "Rat Colony",
  "Persistent Petitioners",
  "Shadowborn Apostle",
  "Dragon's Approach",
  "Templar Knight",
]);

/** Names the unlimited safety net depends on, for evidence tracking. */
export function anyNumberAllowlistNames(): string[] {
  return [...ANY_NUMBER_ALLOWLIST].sort();
}

/** Oracle-text grant of unlimited copies, e.g. "A deck can have any number of cards named …". */
const ANY_NUMBER_TEXT = /any number of cards named/i;

/** Oracle-text bounded grant, e.g. "A deck can have up to seven cards named Seven Dwarves." */
const BOUNDED_TEXT = /A deck can have up to (\w+) cards named/i;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

/** True for basic lands (incl. Snow-Covered basics and Wastes), which are unlimited. */
function isBasicLand(card: Card): boolean {
  return card.type_line.includes("Basic") && card.type_line.includes("Land");
}

/** Why a card is exempt from the singleton rule (may appear in any quantity). */
export type AnyNumberReason = "basic_land" | "allowlist" | "oracle_text";

/**
 * How a card's Commander copy limit was decided. `bounded_text` is the card's
 * own "up to N cards named" grant (CR 101.1 lets card text override 903.5b);
 * `singleton` is the default one copy.
 */
export type CopyLimitReason = AnyNumberReason | "bounded_text" | "singleton";

export interface CopyLimit {
  /**
   * Maximum copies in a Commander deck. `null` only when the card carries a
   * bounded grant whose number this validator does not understand; callers must
   * treat that as unresolved, never as unlimited.
   */
  readonly max: number | null;
  readonly reason: CopyLimitReason;
}

/**
 * The single owner of Commander copy limits (CR 903.5b with card-text overrides
 * under CR 101.1): basic lands and "any number" grants are unlimited, "up to N"
 * grants are bounded, everything else is one copy. Deck construction and
 * validation both read this; no other module may parse copy grants.
 */
export function copyLimit(card: Card): CopyLimit {
  if (isBasicLand(card)) return { max: COMMANDER_DECK_SIZE, reason: "basic_land" };
  const bounded = BOUNDED_TEXT.exec(card.oracle_text)?.[1];
  if (bounded !== undefined) {
    const value = NUMBER_WORDS[bounded.toLowerCase()] ?? Number(bounded);
    return {
      max: Number.isSafeInteger(value) && value >= 1 ? value : null,
      reason: "bounded_text",
    };
  }
  if (ANY_NUMBER_ALLOWLIST.has(card.name)) return { max: COMMANDER_DECK_SIZE, reason: "allowlist" };
  if (ANY_NUMBER_TEXT.test(card.oracle_text))
    return { max: COMMANDER_DECK_SIZE, reason: "oracle_text" };
  return { max: 1, reason: "singleton" };
}

/** The singleton-exemption reason for an unlimited card, or null when a copy limit applies. */
export function anyNumberReason(card: Card): AnyNumberReason | null {
  const limit = copyLimit(card);
  return limit.reason === "bounded_text" || limit.reason === "singleton" ? null : limit.reason;
}

/** A qty>1 entry that is exempt from singleton, and why (advisory; not a violation). */
export interface AnyNumberExemption {
  oracle_id: string;
  name: string;
  qty: number;
  reason: AnyNumberReason | "bounded_text";
  /** The card-text cap for a bounded grant; absent for unlimited exemptions. */
  max?: number;
}

/**
 * List the deck's qty>1 entries that are exempt from the singleton rule, with the
 * reason. Advisory messaging (review #14) — confirms the "any number" or bounded
 * exception applied so a multi-copy import (e.g. 15× Relentless Rats) isn't
 * silently legal. An entry over its bounded cap is a violation, not an exemption.
 */
export function anyNumberExemptions(deck: Deck, lookup: CardLookup): AnyNumberExemption[] {
  const out: AnyNumberExemption[] = [];
  for (const entry of deck.cards) {
    if (entry.qty <= 1) continue;
    const card = lookup(entry.oracle_id);
    if (!card) continue;
    const limit = copyLimit(card);
    if (limit.reason === "singleton" || limit.max === null || entry.qty > limit.max) continue;
    const exemption: AnyNumberExemption = {
      oracle_id: card.oracle_id,
      name: card.name,
      qty: entry.qty,
      reason: limit.reason,
    };
    if (limit.reason === "bounded_text") exemption.max = limit.max;
    out.push(exemption);
  }
  return out;
}

/** A card-scoped violation's `card` field (oracle_id + name). */
function cardRef(card: Card): Pick<Card, "oracle_id" | "name"> {
  return { oracle_id: card.oracle_id, name: card.name };
}

/**
 * Card-count rule: total = sum of card quantities + commanders, expected to be
 * exactly 100. Emits a single CARD_COUNT error carrying the over/under delta.
 */
export function checkCardCount(deck: Deck): Violation[] {
  const cardTotal = deck.cards.reduce((sum, e) => sum + e.qty, 0);
  const total = cardTotal + deck.commanders.length;
  if (total === COMMANDER_DECK_SIZE) return [];
  const delta = total - COMMANDER_DECK_SIZE;
  const word = delta > 0 ? `${delta} over` : `${-delta} short of`;
  return [
    {
      rule: "CARD_COUNT",
      severity: "error",
      detail: `deck has ${total} cards (${word} ${COMMANDER_DECK_SIZE})`,
      fix_hint: delta > 0 ? `remove ${delta} card(s)` : `add ${-delta} card(s)`,
    },
  ];
}

/**
 * Singleton rule (CR 903.5b): any card with qty > 1 is a violation unless its
 * copy limit allows the quantity — basic lands and "any number" grants are
 * unlimited, "up to N" grants cap at N. A bounded grant whose number is not
 * understood is reported explicitly and treated as one copy, never as unlimited.
 */
export function checkSingleton(deck: Deck, lookup: CardLookup): Violation[] {
  const violations: Violation[] = [];
  for (const entry of deck.cards) {
    if (entry.qty <= 1) continue;
    const card = lookup(entry.oracle_id);
    const limit = card ? copyLimit(card) : null;
    if (limit && limit.max !== null && entry.qty <= limit.max) continue;
    const name = card?.name ?? entry.oracle_id;
    const detail =
      limit?.reason === "bounded_text"
        ? limit.max === null
          ? `${name} appears ${entry.qty} times (its bounded copy grant is not understood; treated as singleton)`
          : `${name} appears ${entry.qty} times (card text allows up to ${limit.max})`
        : `${name} appears ${entry.qty} times (singleton format allows 1)`;
    violations.push({
      rule: "SINGLETON",
      severity: "error",
      card: card ? cardRef(card) : { oracle_id: entry.oracle_id, name: entry.oracle_id },
      detail,
      fix_hint:
        limit?.reason === "bounded_text" && limit.max !== null
          ? `reduce to ${limit.max} copies`
          : "reduce to a single copy",
    });
  }
  return violations;
}

/**
 * Color-identity rule: every card's color identity must be a subset of the
 * deck's computed identity. Comparison is case-insensitive for robustness.
 */
export function checkColorIdentity(deck: Deck, lookup: CardLookup): Violation[] {
  const allowed = new Set<string>(deck.computed_color_identity.map((c) => c.toUpperCase()));
  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const oracleId of [...deck.commanders, ...deck.cards.map((e) => e.oracle_id)]) {
    if (seen.has(oracleId)) continue;
    seen.add(oracleId);
    const card = lookup(oracleId);
    if (!card) continue;
    const offending = card.color_identity
      .map((c: Color) => c.toUpperCase())
      .filter((c) => !allowed.has(c));
    if (offending.length === 0) continue;
    violations.push({
      rule: "COLOR_IDENTITY",
      severity: "error",
      card: cardRef(card),
      detail: `${offending.join("")} not in deck identity ${[...allowed].join("") || "(colorless)"}`,
      fix_hint: "remove the card or change the commander(s)",
    });
  }
  return violations;
}

/**
 * Banlist rule: a card is banned iff its Commander legality is "banned". The
 * banlist is therefore always current Scryfall data — never hardcoded.
 */
export function checkBanlist(deck: Deck, lookup: CardLookup): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const oracleId of [...deck.commanders, ...deck.cards.map((e) => e.oracle_id)]) {
    if (seen.has(oracleId)) continue;
    seen.add(oracleId);
    const card = lookup(oracleId);
    if (!card || card.legalities.commander !== "banned") continue;
    violations.push({
      rule: "BANLIST",
      severity: "error",
      card: cardRef(card),
      detail: `${card.name} is banned in Commander`,
      fix_hint: "remove the card",
    });
  }
  return violations;
}

/** Run all four core rules and return the concatenated violations (§6). */
export function validateCore(deck: Deck, lookup: CardLookup): Violation[] {
  return [
    ...checkCardCount(deck),
    ...checkSingleton(deck, lookup),
    ...checkColorIdentity(deck, lookup),
    ...checkBanlist(deck, lookup),
  ];
}
