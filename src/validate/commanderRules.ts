/**
 * Commander & multi-commander rules (spec §6) — pure functions over a deck and a
 * card lookup. Validates the command zone: each commander must be eligible, and
 * a two-card command zone must form a legal pairing (partner, friends forever,
 * partner with [name], Choose a Background + Background, or a Time Lord Doctor +
 * Doctor's companion). The combined color identity is the union of the
 * commanders' identities.
 *
 * COMPANION (§6) is intentionally NOT validated here: the Deck model has no
 * companion slot to declare one against, so there is nothing to check yet. See
 * the chunk close note — it needs a deck-model field first.
 */
import type { Card, Color, Deck, Violation } from "../types/index.js";
import type { CardLookup } from "./coreRules.js";

const WUBRG: readonly Color[] = ["W", "U", "B", "R", "G"];

/** A command-zone-relevant ability detected on a card. */
type PartnerKind = "partner" | "partner_with" | "friends_forever" | "doctors_companion";

interface CommanderShape {
  partner?: PartnerKind;
  /** The named partner, when the card has "Partner with [name]". */
  partnerName?: string;
  /** A "Choose a Background" commander. */
  choosesBackground: boolean;
  /** A Background enchantment (legal as a second commander). */
  isBackground: boolean;
  /** A Time Lord Doctor (pairs with a Doctor's companion). */
  isTimeLord: boolean;
}

function classify(card: Card): CommanderShape {
  const text = card.oracle_text;
  const withMatch = /partner with ([^.(\n]+)/i.exec(text);
  let partner: PartnerKind | undefined;
  if (withMatch) partner = "partner_with";
  else if (/friends forever/i.test(text)) partner = "friends_forever";
  else if (/doctor.?s companion/i.test(text)) partner = "doctors_companion";
  else if (card.keywords.some((k) => k.toLowerCase() === "partner") || /\bpartner\b/i.test(text))
    partner = "partner";
  return {
    partner,
    partnerName: withMatch?.[1]?.trim(),
    choosesBackground: /choose a background/i.test(text),
    isBackground: /\bBackground\b/.test(card.type_line),
    isTimeLord: /Time Lord/i.test(card.type_line),
  };
}

/** A card can be a sole commander if eligible by the server flag, type, or text. */
export function isCommanderEligible(card: Card): boolean {
  // Legendary + a printed power/toughness box is command-zone eligible: a
  // creature (matched by type, since DFC/meld faces may lack a top-level P/T),
  // or — since Edge of Eternities broadened rule 903.3 — a Vehicle or Spacecraft
  // (a non-creature with a printed P/T). The server flag and "can be your
  // commander" text cover the rest.
  const legendary = /Legendary/i.test(card.type_line);
  const hasPrintedPT = card.power !== undefined && card.toughness !== undefined;
  return (
    card.is_commander_eligible ||
    (legendary && (/Creature/i.test(card.type_line) || hasPrintedPT)) ||
    /can be your commander/i.test(card.oracle_text)
  );
}

/** Union of the commanders' color identities, in WUBRG order. Only reads `commanders`. */
export function commanderColorIdentity(
  deck: Pick<Deck, "commanders">,
  lookup: CardLookup,
): Color[] {
  const seen = new Set<string>();
  for (const id of deck.commanders) {
    const card = lookup(id);
    if (card) for (const c of card.color_identity) seen.add(c.toUpperCase());
  }
  return WUBRG.filter((c) => seen.has(c));
}

function cardRef(card: Card): Pick<Card, "oracle_id" | "name"> {
  return { oracle_id: card.oracle_id, name: card.name };
}

/** Each commander must be a legal commander (or a Background in a Background pairing). */
export function checkCommanderEligibility(deck: Deck, lookup: CardLookup): Violation[] {
  const violations: Violation[] = [];
  for (const id of deck.commanders) {
    const card = lookup(id);
    if (!card) continue;
    if (isCommanderEligible(card)) continue;
    if (deck.command_zone_kind === "background" && /\bBackground\b/.test(card.type_line)) continue;
    violations.push({
      rule: "COMMANDER_ELIGIBILITY",
      severity: "error",
      card: cardRef(card),
      detail: `${card.name} is not a legal commander`,
      fix_hint: "use a legendary creature (or a card that says it can be your commander)",
    });
  }
  return violations;
}

function multi(detail: string): Violation {
  return { rule: "MULTI_COMMANDER", severity: "error", detail, fix_hint: "fix the command zone" };
}

/**
 * The command zone must hold a legal number of commanders for its kind, and a
 * two-commander zone must form a valid pairing.
 */
export function checkMultiCommander(deck: Deck, lookup: CardLookup): Violation[] {
  const kind = deck.command_zone_kind;
  const ids = deck.commanders;
  if (kind === "single") {
    return ids.length === 1
      ? []
      : [multi(`single command zone expects 1 commander, found ${ids.length}`)];
  }

  if (ids.length !== 2) {
    return [multi(`${kind} command zone expects 2 commanders, found ${ids.length}`)];
  }
  const a = lookup(ids[0]!);
  const b = lookup(ids[1]!);
  if (!a || !b) return []; // unknown cards: can't judge the pairing

  const sa = classify(a);
  const sb = classify(b);

  if (kind === "partner") {
    const bothPartner = sa.partner === "partner" && sb.partner === "partner";
    const bothFriends = sa.partner === "friends_forever" && sb.partner === "friends_forever";
    const namedPair =
      sa.partner === "partner_with" &&
      sb.partner === "partner_with" &&
      sa.partnerName === b.name &&
      sb.partnerName === a.name;
    return bothPartner || bothFriends || namedPair
      ? []
      : [multi(`${a.name} and ${b.name} are not a legal partner pairing`)];
  }
  if (kind === "background") {
    const ok =
      (sa.choosesBackground && sb.isBackground) || (sb.choosesBackground && sa.isBackground);
    return ok ? [] : [multi(`${a.name} + ${b.name} is not a Choose-a-Background pairing`)];
  }
  // doctor_companion
  const ok =
    (sa.isTimeLord && sb.partner === "doctors_companion") ||
    (sb.isTimeLord && sa.partner === "doctors_companion");
  return ok ? [] : [multi(`${a.name} + ${b.name} is not a Doctor / Doctor's companion pairing`)];
}

/** Run the commander rules and return the concatenated violations (§6). */
export function validateCommander(deck: Deck, lookup: CardLookup): Violation[] {
  return [...checkCommanderEligibility(deck, lookup), ...checkMultiCommander(deck, lookup)];
}
