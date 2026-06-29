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
 * Cards explicitly allowed in any quantity whose oracle text may not match the
 * generic regex (kept as a safety net; the regex below catches the rest).
 */
const ANY_NUMBER_ALLOWLIST = new Set<string>([
  "Relentless Rats",
  "Rat Colony",
  "Persistent Petitioners",
  "Shadowborn Apostle",
  "Dragon's Approach",
  "Seven Dwarves",
  "Templar Knight",
  "Nazgûl",
]);

/** Oracle-text grant of unlimited copies, e.g. "A deck can have any number of cards named …". */
const ANY_NUMBER_TEXT = /any number of cards named/i;

/** True for basic lands (incl. Snow-Covered basics and Wastes), which are unlimited. */
function isBasicLand(card: Card): boolean {
  return card.type_line.includes("Basic") && card.type_line.includes("Land");
}

/** Why a card is exempt from the singleton rule (may appear in any quantity). */
export type AnyNumberReason = "basic_land" | "allowlist" | "oracle_text";

/** The singleton-exemption reason for a card, or null when the singleton rule applies. */
export function anyNumberReason(card: Card): AnyNumberReason | null {
  if (isBasicLand(card)) return "basic_land";
  if (ANY_NUMBER_ALLOWLIST.has(card.name)) return "allowlist";
  if (ANY_NUMBER_TEXT.test(card.oracle_text)) return "oracle_text";
  return null;
}

/** True when a card may appear in any quantity (exempt from the singleton rule). */
function isAnyNumberAllowed(card: Card): boolean {
  return anyNumberReason(card) !== null;
}

/** A qty>1 entry that is exempt from singleton, and why (advisory; not a violation). */
export interface AnyNumberExemption {
  oracle_id: string;
  name: string;
  qty: number;
  reason: AnyNumberReason;
}

/**
 * List the deck's qty>1 entries that are exempt from the singleton rule, with the
 * reason. Advisory messaging (review #14) — confirms the "any number" exception
 * applied so a multi-copy import (e.g. 15× Relentless Rats) isn't silently legal.
 */
export function anyNumberExemptions(deck: Deck, lookup: CardLookup): AnyNumberExemption[] {
  const out: AnyNumberExemption[] = [];
  for (const entry of deck.cards) {
    if (entry.qty <= 1) continue;
    const card = lookup(entry.oracle_id);
    if (!card) continue;
    const reason = anyNumberReason(card);
    if (reason) out.push({ oracle_id: card.oracle_id, name: card.name, qty: entry.qty, reason });
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
 * Singleton rule: any card with qty > 1 is a violation unless it is a basic
 * land, on the any-number allowlist, or its oracle text grants any number.
 */
export function checkSingleton(deck: Deck, lookup: CardLookup): Violation[] {
  const violations: Violation[] = [];
  for (const entry of deck.cards) {
    if (entry.qty <= 1) continue;
    const card = lookup(entry.oracle_id);
    if (card && isAnyNumberAllowed(card)) continue;
    violations.push({
      rule: "SINGLETON",
      severity: "error",
      card: card ? cardRef(card) : { oracle_id: entry.oracle_id, name: entry.oracle_id },
      detail: `${card?.name ?? entry.oracle_id} appears ${entry.qty} times (singleton format allows 1)`,
      fix_hint: "reduce to a single copy",
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
