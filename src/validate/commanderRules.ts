/**
 * Commander & multi-commander rules (spec §6; CR 903 and 702.124) — pure
 * functions over a deck and a card lookup. Validates the command zone: each
 * commander must be eligible (903.3, 903.3a), and a two-card command zone must
 * form one legal partner pairing: partner (702.124h), the same partner—[text]
 * label (702.124i), partner with [name] (702.124j), Choose a Background plus a
 * legendary Background enchantment (702.124k), or a Doctor's companion plus a
 * Time Lord Doctor with no other creature types (702.124m). Different partner
 * abilities never combine (702.124f). The combined color identity is the union
 * of the commanders' identities (702.124c, 903.4).
 *
 * Companion deckbuilding conditions (702.139) live in companionRules.ts. The
 * frozen rule text these checks were audited against is
 * docs/evaluation/rules/commander-rules-excerpt-20260807.json.
 */
import type { Card, Color, Deck, Violation } from "../types/index.js";
import type { CardLookup } from "./coreRules.js";

const WUBRG: readonly Color[] = ["W", "U", "B", "R", "G"];

/** A command-zone-relevant ability detected on a card (CR 702.124a). */
type PartnerKind = "partner" | "partner_text" | "partner_with" | "doctors_companion";

interface CommanderShape {
  partner?: PartnerKind;
  /** The named partner, when the card has "Partner with [name]". */
  partnerName?: string;
  /** The lowercase label of a "Partner—[text]" ability (survivors, friends forever, ...). */
  partnerLabel?: string;
  /** A "Choose a Background" commander. */
  choosesBackground: boolean;
  /** A legendary Background enchantment (legal only as the second commander). */
  isBackground: boolean;
  /** A legendary Time Lord Doctor creature with no other creature types (702.124m). */
  isTimeLordDoctor: boolean;
}

/** Creature subtypes of the front face, e.g. "Time Lord Doctor" -> ["Time Lord", "Doctor"]. */
function creatureTypes(typeLine: string): string[] {
  const front = typeLine.split("//")[0] ?? typeLine;
  const sub = (front.split("—")[1] ?? "").trim();
  if (sub.length === 0) return [];
  // "Time Lord" is the one two-word creature type (CR 205.3m).
  return sub
    .replace(/\bTime Lord\b/g, "Time_Lord")
    .split(/\s+/)
    .map((t) => t.replace("Time_Lord", "Time Lord"));
}

function classify(card: Card): CommanderShape {
  const text = card.oracle_text;
  const withMatch = /partner with ([^.(\n]+)/i.exec(text);
  // Scryfall's keywords list every variant as "Partner", so the label must be
  // read from the printed text (702.124i). "Friends forever" is printed as its
  // own keyword line on older cards and is the partner—Friends forever ability.
  const labelMatch = /\bpartner\s*[—–-]\s*([^.(\n]+)/i.exec(text);
  let partner: PartnerKind | undefined;
  let partnerLabel: string | undefined;
  if (withMatch) partner = "partner_with";
  else if (labelMatch) {
    partner = "partner_text";
    partnerLabel = labelMatch[1]!.trim().toLowerCase();
  } else if (/friends forever/i.test(text)) {
    partner = "partner_text";
    partnerLabel = "friends forever";
  } else if (/doctor.?s companion/i.test(text)) partner = "doctors_companion";
  else if (card.keywords.some((k) => k.toLowerCase() === "partner") || /\bpartner\b/i.test(text))
    partner = "partner";
  const types = creatureTypes(card.type_line);
  const legendary = /Legendary/i.test(card.type_line);
  return {
    partner,
    partnerName: withMatch?.[1]?.trim(),
    partnerLabel,
    choosesBackground: /choose a background/i.test(text),
    isBackground: isLegendaryBackground(card),
    isTimeLordDoctor:
      legendary &&
      /\bCreature\b/.test(card.type_line) &&
      types.length === 2 &&
      types.includes("Time Lord") &&
      types.includes("Doctor"),
  };
}

/** A legendary Background enchantment card (CR 702.124k). */
export function isLegendaryBackground(card: Card): boolean {
  return (
    /Legendary/i.test(card.type_line) &&
    /\bEnchantment\b/.test(card.type_line) &&
    /\bBackground\b/.test(card.type_line)
  );
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
    // 702.124k: only a legendary Background enchantment rides along a Choose-a-Background commander.
    if (deck.command_zone_kind === "background" && isLegendaryBackground(card)) continue;
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
    // 702.124f: different partner abilities cannot be combined.
    const bothPartner = sa.partner === "partner" && sb.partner === "partner";
    const sameLabel =
      sa.partner === "partner_text" &&
      sb.partner === "partner_text" &&
      sa.partnerLabel !== undefined &&
      sa.partnerLabel === sb.partnerLabel;
    const namedPair =
      sa.partner === "partner_with" &&
      sb.partner === "partner_with" &&
      sa.partnerName === b.name &&
      sb.partnerName === a.name;
    return bothPartner || sameLabel || namedPair
      ? []
      : [multi(`${a.name} and ${b.name} are not a legal partner pairing`)];
  }
  if (kind === "background") {
    const ok =
      (sa.choosesBackground && sb.isBackground) || (sb.choosesBackground && sa.isBackground);
    return ok
      ? []
      : [
          multi(
            `${a.name} + ${b.name} is not a Choose-a-Background pairing (the second commander must be a legendary Background enchantment)`,
          ),
        ];
  }
  // doctor_companion (702.124m)
  const ok =
    (sa.isTimeLordDoctor && sb.partner === "doctors_companion") ||
    (sb.isTimeLordDoctor && sa.partner === "doctors_companion");
  return ok
    ? []
    : [
        multi(
          `${a.name} + ${b.name} is not a Doctor / Doctor's companion pairing (the Doctor must be a legendary Time Lord Doctor with no other creature types)`,
        ),
      ];
}

/** Run the commander rules and return the concatenated violations (§6). */
export function validateCommander(deck: Deck, lookup: CardLookup): Violation[] {
  return [...checkCommanderEligibility(deck, lookup), ...checkMultiCommander(deck, lookup)];
}
