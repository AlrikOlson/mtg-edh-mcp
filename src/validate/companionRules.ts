/**
 * Companion deckbuilding-condition validation (spec §6) — pure functions over a
 * deck and a card lookup, mirroring {@link coreRules}. A companion (the ten
 * Ikoria cards) may only be used if the whole starting deck satisfies its
 * printed restriction. The restriction is intrinsic to each named companion — a
 * closed, rules-defined set — so it is modelled as a name-keyed table of pure
 * predicates rather than a list of arbitrary cards.
 *
 * The check runs only when a companion is declared (`deck.companion`) and the
 * card is known. A companion that also sits in the starting deck is an overlap
 * (CR 702.139a: the companion comes from outside the game). A condition this
 * module cannot establish exactly (an unmodeled companion, a heuristic
 * restriction, or a starting card whose characteristics are incomplete) is
 * reported as unresolved, never passed silently; {@link resolveCompanionCondition}
 * is the one owner of that decision for validation and construction alike.
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

/** Companions whose condition reads only the deck's size, never a card's characteristics. */
const COUNT_ONLY_COMPANIONS = new Set<string>(["Yorion, Sky Nomad"]);

/** Companions whose deckbuilding condition this authority models, for evidence tracking. */
export function modeledCompanionNames(): string[] {
  return Object.keys(COMPANION_RULES).sort();
}

/**
 * Predicate availability, not proof of complete rules coverage. Callers must
 * also ensure starting-card characteristics are represented faithfully.
 */
export function companionRuleCoverage(card: Card): "supported" | "heuristic" | "unmodeled" {
  if (!Object.hasOwn(COMPANION_RULES, card.name)) return "unmodeled";
  // Printed subtypes miss changeling; activated-ability detection is heuristic.
  if (card.name === "Kaheera, the Orphanguard" || card.name === "Zirda, the Dawnwaker")
    return "heuristic";
  return "supported";
}

/**
 * True when a starting card's characteristics cannot be read exactly for a
 * companion condition: a changeling carries every creature type, a multiface
 * record flattens two faces into one, and a canonical record missing its mana
 * value, mana cost, type line or Oracle text establishes nothing. The one
 * owner of this reading; the deck plan, deck construction and the build
 * library consume it.
 */
export function companionCharacteristicsUnknown(card: Card): boolean {
  return (
    /\bchangeling\b/i.test(card.oracle_text) ||
    card.type_line.includes("//") ||
    (card.gameplay?.faces?.length ?? 0) > 1 ||
    Boolean(
      card.gameplay &&
      (card.gameplay.face_relationship !== "single" ||
        card.gameplay.characteristics.cmc === null ||
        card.gameplay.characteristics.mana_cost === null ||
        card.gameplay.characteristics.type_line === null ||
        card.gameplay.characteristics.oracle_text === null),
    )
  );
}

/** Whether the declared companion's condition is exactly evaluable over the starting deck. */
export type CompanionResolution =
  | { status: "exact" }
  | { status: "unresolved"; reason: "unmodeled" | "heuristic" }
  | {
      status: "unresolved";
      reason: "characteristics";
      /** The starting cards whose characteristics are incomplete. */
      cards: Array<Pick<Card, "oracle_id" | "name">>;
    };

/** The starting deck's known cards (commanders and library), each identity once. */
function startingCards(deck: Deck, lookup: CardLookup): Card[] {
  const starting: Card[] = [];
  const seen = new Set<string>();
  for (const id of [...deck.commanders, ...deck.cards.map((e) => e.oracle_id)]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const card = lookup(id);
    if (card) starting.push(card);
  }
  return starting;
}

/**
 * The one decision of whether a companion condition can be established exactly
 * (CR 702.139a: the condition must be fulfilled by the starting deck): the
 * companion's coverage label first, then every known starting card's
 * characteristic completeness, except for a count-only condition. No declared
 * or known companion resolves as exact because there is nothing to establish.
 */
export function resolveCompanionCondition(deck: Deck, lookup: CardLookup): CompanionResolution {
  if (!deck.companion) return { status: "exact" };
  const companionCard = lookup(deck.companion);
  if (!companionCard) return { status: "exact" };
  const coverage = companionRuleCoverage(companionCard);
  if (coverage !== "supported") return { status: "unresolved", reason: coverage };
  if (COUNT_ONLY_COMPANIONS.has(companionCard.name)) return { status: "exact" };
  const cards = startingCards(deck, lookup)
    .filter(companionCharacteristicsUnknown)
    .map((c) => ({ oracle_id: c.oracle_id, name: c.name }));
  return cards.length === 0
    ? { status: "exact" }
    : { status: "unresolved", reason: "characteristics", cards };
}

/**
 * Companion overlap (CR 702.139a: the companion is one card from outside the
 * game): the declared companion may not also be a commander or a library card.
 * Construction maps this verdict to its COMPANION_DECK_OVERLAP diagnostic.
 */
export function checkCompanionOverlap(deck: Deck, lookup?: CardLookup): Violation[] {
  const id = deck.companion;
  if (!id) return [];
  const inside =
    deck.commanders.includes(id) || deck.cards.some((e) => e.oracle_id === id && e.qty > 0);
  if (!inside) return [];
  const name = lookup?.(id)?.name ?? id;
  return [
    {
      rule: "COMPANION_DECK_OVERLAP",
      severity: "error",
      card: { oracle_id: id, name },
      detail: `${name} is the declared companion and also part of the starting deck`,
      fix_hint: "remove the companion from the deck or drop the companion",
    },
  ];
}

function unresolvedDetail(
  companionCard: Card,
  resolution: Exclude<CompanionResolution, { status: "exact" }>,
): string {
  switch (resolution.reason) {
    case "unmodeled":
      return `${companionCard.name}'s companion condition is not modeled by this validator`;
    case "heuristic":
      return `${companionCard.name}'s companion condition is evaluated heuristically (printed subtypes and ability shapes), not exactly`;
    case "characteristics":
      return `${companionCard.name}'s companion condition cannot be established exactly: incomplete characteristics for ${resolution.cards.map((c) => c.name).join(", ")}`;
    default: {
      const exhaustive: never = resolution;
      return String(exhaustive);
    }
  }
}

function unresolvedViolation(
  companionCard: Card,
  resolution: Exclude<CompanionResolution, { status: "exact" }>,
): Violation {
  const detail = unresolvedDetail(companionCard, resolution);
  return {
    rule: "COMPANION_CONDITION_UNRESOLVED",
    severity: "error",
    card: { oracle_id: companionCard.oracle_id, name: companionCard.name },
    detail,
    fix_hint: "drop the companion, or supply exact card evidence for its condition",
  };
}

/**
 * Validate the declared companion over the deck's starting cards (the
 * commanders + the 99): the overlap check, the restriction's breaks, then an
 * unresolved report when the condition is not exactly established. A supported
 * restriction is evaluated over the exactly readable cards even when another
 * card's characteristics are incomplete (a break on a complete card is
 * certain); a heuristic or unmodeled restriction is never evaluated, because
 * its break would not be a certified verdict. Returns no violations when no
 * companion is declared or the companion card is unknown.
 */
export function validateCompanion(deck: Deck, lookup: CardLookup): Violation[] {
  if (!deck.companion) return [];
  const companionCard = lookup(deck.companion);
  if (!companionCard) return [];
  const violations = checkCompanionOverlap(deck, lookup);
  const resolution = resolveCompanionCondition(deck, lookup);
  const rule = COMPANION_RULES[companionCard.name];
  if (rule && (resolution.status === "exact" || resolution.reason === "characteristics")) {
    const starting = startingCards(deck, lookup);
    violations.push(
      ...rule.check(
        resolution.status === "exact"
          ? starting
          : starting.filter((c) => !companionCharacteristicsUnknown(c)),
        deck,
      ),
    );
  }
  if (resolution.status === "unresolved")
    violations.push(unresolvedViolation(companionCard, resolution));
  return violations;
}
