/**
 * Companion deckbuilding-condition validation (spec §6) — pure functions over a
 * deck and a card lookup, mirroring {@link coreRules}. A companion (the ten
 * Ikoria cards) may only be used if the whole starting deck satisfies its
 * printed restriction. The restriction is intrinsic to each named companion — a
 * closed, rules-defined set — so it is modelled as a name-keyed table of pure
 * predicates rather than a list of arbitrary cards.
 *
 * The check runs only when a companion is declared (`deck.companion`); an
 * undeclared deck, or a declared card we do not model, yields no violations.
 */
import type { Card, Deck, Violation } from "../types/index.js";
import type { CardLookup } from "./coreRules.js";

/** A card is a companion iff its rules text grants the companion ability. */
export function isCompanionCard(card: Card): boolean {
  return /\bcompanion\b/i.test(card.oracle_text);
}

function isLand(card: Card): boolean {
  return /\bLand\b/.test(card.type_line);
}

function isCreature(card: Card): boolean {
  return /\bCreature\b/.test(card.type_line);
}

/** Permanents are everything except instants and sorceries. */
function isPermanent(card: Card): boolean {
  return !/\b(Instant|Sorcery)\b/.test(card.type_line);
}

/** Heuristic: a permanent has an activated ability if its text has a "cost: effect". */
function hasActivatedAbility(card: Card): boolean {
  return /\S:\s/.test(card.oracle_text);
}

/** True when a mana cost contains the same colored/hybrid/colorless symbol twice. */
function repeatsAManaSymbol(manaCost: string): boolean {
  const tokens = (manaCost.match(/\{([^}]+)\}/g) ?? []).map((t) => t.slice(1, -1).toUpperCase());
  const seen = new Set<string>();
  for (const t of tokens) {
    // Generic numeric symbols ({2}) are never printed twice; only symbols with a
    // letter (colored, hybrid, colorless {C}, Phyrexian) can repeat.
    if (/^\d+$/.test(t)) continue;
    if (seen.has(t)) return true;
    seen.add(t);
  }
  return false;
}

const KAHEERA_TYPES = ["Cat", "Elemental", "Nightmare", "Dinosaur", "Beast"];
function kaheeraOk(card: Card): boolean {
  if (!isCreature(card)) return true;
  return KAHEERA_TYPES.some((t) => new RegExp(`\\b${t}\\b`).test(card.type_line));
}

const CARD_TYPES = [
  "Artifact",
  "Battle",
  "Creature",
  "Enchantment",
  "Instant",
  "Planeswalker",
  "Sorcery",
];
function cardTypes(card: Card): string[] {
  const front = card.type_line.split("//")[0] ?? card.type_line;
  const pre = front.split("—")[0] ?? front;
  return CARD_TYPES.filter((t) => new RegExp(`\\b${t}\\b`).test(pre));
}

function companionViolation(detail: string, card?: Card): Violation {
  return {
    rule: "COMPANION",
    severity: "error",
    ...(card ? { card: { oracle_id: card.oracle_id, name: card.name } } : {}),
    detail,
    fix_hint: "satisfy the companion's condition or drop the companion",
  };
}

/** A companion's restriction over the starting deck. */
interface CompanionRule {
  restriction: string;
  check(starting: Card[], deck: Deck): Violation[];
}

/** A per-card restriction: every starting-deck card must satisfy `ok`. */
function eachCard(restriction: string, ok: (card: Card) => boolean): CompanionRule {
  return {
    restriction,
    check(starting) {
      return starting
        .filter((c) => !ok(c))
        .map((c) =>
          companionViolation(`${c.name} breaks the companion condition: ${restriction}`, c),
        );
    },
  };
}

/** Lutri — each nonland card has a different name (in Commander: nonland singleton). */
const lutriRule: CompanionRule = {
  restriction: "each nonland card has a different name",
  check(starting, deck) {
    const byId = new Map(starting.map((c) => [c.oracle_id, c]));
    const out: Violation[] = [];
    for (const entry of deck.cards) {
      if (entry.qty <= 1) continue;
      const card = byId.get(entry.oracle_id);
      if (!card || isLand(card)) continue;
      out.push(
        companionViolation(
          `${card.name} appears ${entry.qty} times — Lutri requires each nonland card to have a different name`,
          card,
        ),
      );
    }
    return out;
  },
};

/** Umori — every nonland card shares a card type. */
const umoriRule: CompanionRule = {
  restriction: "each nonland card shares a card type",
  check(starting) {
    const nonland = starting.filter((c) => !isLand(c));
    if (nonland.length === 0) return [];
    const common = CARD_TYPES.filter((t) => nonland.every((c) => cardTypes(c).includes(t)));
    if (common.length > 0) return [];
    return [
      companionViolation(
        "the nonland cards do not all share a single card type, which Umori requires",
      ),
    ];
  },
};

/** Yorion — the starting deck must exceed the format minimum by 20 (impossible at a fixed 100). */
const yorionRule: CompanionRule = {
  restriction: "starting deck is at least 20 cards over the 100-card minimum",
  check(_starting, deck) {
    const total = deck.cards.reduce((s, e) => s + e.qty, 0) + deck.commanders.length;
    if (total >= 120) return [];
    return [
      companionViolation(
        `deck has ${total} cards; Yorion needs at least 120 — a fixed 100-card Commander deck cannot satisfy this`,
      ),
    ];
  },
};

/** The deckbuilding restriction for each official companion, keyed by card name. */
const COMPANION_RULES: Record<string, CompanionRule> = {
  "Lurrus of the Dream-Den": eachCard(
    "each permanent card has mana value 2 or less",
    (c) => !isPermanent(c) || c.mv <= 2,
  ),
  "Gyruda, Doom of Depths": eachCard("each card has an even mana value", (c) => c.mv % 2 === 0),
  "Jegantha, the Wellspring": eachCard(
    "no card has two of the same mana symbol in its cost",
    (c) => !repeatsAManaSymbol(c.mana_cost),
  ),
  "Keruga, the Macrosage": eachCard(
    "each card is a land or has mana value 3 or greater",
    (c) => isLand(c) || c.mv >= 3,
  ),
  "Kaheera, the Orphanguard": eachCard(
    "each creature is a Cat, Elemental, Nightmare, Dinosaur, or Beast",
    kaheeraOk,
  ),
  "Obosh, the Preypiercer": eachCard(
    "each card is a land or has an odd mana value",
    (c) => isLand(c) || c.mv % 2 === 1,
  ),
  "Zirda, the Dawnwaker": eachCard(
    "each permanent card has an activated ability",
    (c) => !isPermanent(c) || hasActivatedAbility(c),
  ),
  "Lutri, the Spellchaser": lutriRule,
  "Umori, the Collector": umoriRule,
  "Yorion, Sky Nomad": yorionRule,
};

/**
 * Validate the declared companion's deckbuilding condition over the deck's
 * starting cards (the commanders + the 99, excluding the companion itself).
 * Returns no violations when no companion is declared, the companion card is
 * unknown, or it is not one we model.
 */
export function validateCompanion(deck: Deck, lookup: CardLookup): Violation[] {
  if (!deck.companion) return [];
  const companionCard = lookup(deck.companion);
  if (!companionCard) return [];
  const rule = COMPANION_RULES[companionCard.name];
  if (!rule) return [];

  const starting: Card[] = [];
  const seen = new Set<string>([deck.companion]);
  for (const id of [...deck.commanders, ...deck.cards.map((e) => e.oracle_id)]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const card = lookup(id);
    if (card) starting.push(card);
  }
  return rule.check(starting, deck);
}
