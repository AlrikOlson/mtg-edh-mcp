/**
 * Map raw Scryfall card JSON to the canonical §4 Card (spec §4/§5A/§9).
 *
 * Double-faced cards carry per-face oracle_text/mana_cost/type_line in
 * `card_faces[]`; we flatten them (joined with " // " / "\n//\n") so the index
 * has a single searchable text per oracle_id.
 */
import type { Card, Color, ColorIdentity, Legalities, Prices } from "../types/index.js";
import { classifyRoles } from "../analyze/index.js";
import type { ScryfallCardFace, ScryfallCardRaw } from "../ingest/scryfallTypes.js";

// Re-export the raw Scryfall shapes so existing importers of ./map keep working.
export type { ScryfallCardFace, ScryfallCardRaw } from "../ingest/scryfallTypes.js";

const COLOR_ORDER: readonly string[] = ["W", "U", "B", "R", "G"];

/** Canonical sorted WUBRG letters, e.g. ["G","B"] -> "BG"; colorless -> "". */
export function colorIdentitySorted(ci: ColorIdentity): string {
  return [...ci].sort((a, b) => COLOR_ORDER.indexOf(a) - COLOR_ORDER.indexOf(b)).join("");
}

function faceJoin(
  raw: ScryfallCardRaw,
  pick: (f: ScryfallCardFace) => string | undefined,
  sep: string,
): string {
  return (raw.card_faces ?? []).map((f) => pick(f) ?? "").join(sep);
}

function flattenOracleText(raw: ScryfallCardRaw): string {
  if (raw.oracle_text !== undefined) return raw.oracle_text;
  return faceJoin(raw, (f) => f.oracle_text, "\n//\n");
}

function flattenManaCost(raw: ScryfallCardRaw): string {
  if (raw.mana_cost !== undefined) return raw.mana_cost;
  return faceJoin(raw, (f) => f.mana_cost, " // ");
}

function flattenTypeLine(raw: ScryfallCardRaw): string {
  if (raw.type_line !== undefined) return raw.type_line;
  return faceJoin(raw, (f) => f.type_line, " // ");
}

/** Heuristic command-zone eligibility; refined by the commander rules (p4). */
export function isCommanderEligible(
  typeLine: string,
  oracleText: string,
  power?: string,
  toughness?: string,
): boolean {
  // A legendary permanent with a printed power/toughness box — a creature, or
  // (since Edge of Eternities broadened rule 903.3) a Vehicle or Spacecraft —
  // is command-zone eligible. Creatures are matched by type, since our data may
  // not carry a top-level power/toughness for DFC/meld faces; non-creatures need
  // a printed P/T. The "... can be your commander" text path covers the rest.
  const legendary = /Legendary/i.test(typeLine);
  const hasPrintedPT = power !== undefined && toughness !== undefined;
  const legendaryPermanent = legendary && (/Creature/i.test(typeLine) || hasPrintedPT);
  return legendaryPermanent || /can be your commander/i.test(oracleText);
}

/** Map a raw oracle_cards entry to a canonical Card (printings filled separately). */
export function mapScryfallCard(raw: ScryfallCardRaw): Card {
  const type_line = flattenTypeLine(raw);
  const oracle_text = flattenOracleText(raw);
  return {
    oracle_id: raw.oracle_id ?? raw.id ?? "",
    name: raw.name,
    mana_cost: flattenManaCost(raw),
    mv: raw.cmc ?? 0,
    colors: (raw.colors ?? []) as readonly Color[],
    color_identity: (raw.color_identity ?? []) as ColorIdentity,
    type_line,
    oracle_text,
    power: raw.power,
    toughness: raw.toughness,
    loyalty: raw.loyalty,
    keywords: raw.keywords ?? [],
    legalities: (raw.legalities ?? {}) as Legalities,
    prices: (raw.prices ?? {}) as Prices,
    is_commander_eligible: isCommanderEligible(type_line, oracle_text, raw.power, raw.toughness),
    roles: classifyRoles({
      name: raw.name,
      type_line,
      oracle_text,
      keywords: raw.keywords ?? [],
      mana_cost: flattenManaCost(raw),
    }),
    printings: [],
  };
}

/** Projected/indexed column values derived from a mapped Card (for the cards table). */
export interface CardColumns {
  colors: string;
  keywords: string;
  pow: number | null;
  tou: number | null;
  loy: number | null;
  price_usd: number | null;
  price_eur: number | null;
  price_tix: number | null;
  is_commander_eligible: number;
}

function numericOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function priceOrNull(value: string | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Derive the projected columns the query evaluator filters/sorts on. */
export function projectedColumns(card: Card): CardColumns {
  return {
    colors: colorIdentitySorted(card.colors),
    keywords: card.keywords.join(" ").toLowerCase(),
    pow: numericOrNull(card.power),
    tou: numericOrNull(card.toughness),
    loy: numericOrNull(card.loyalty),
    price_usd: priceOrNull(card.prices.usd),
    price_eur: priceOrNull(card.prices.eur),
    price_tix: priceOrNull(card.prices.tix),
    is_commander_eligible: card.is_commander_eligible ? 1 : 0,
  };
}

/** A printings-table row extracted from a default_cards entry. */
export interface PrintingRow {
  oracle_id: string;
  scryfall_id: string;
  set_code: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  prices: string;
  released_at: string | null;
}

/** Extract a printings row from a default_cards entry; null if it lacks ids. */
export function extractPrinting(raw: ScryfallCardRaw): PrintingRow | null {
  if (!raw.oracle_id || !raw.id) return null;
  return {
    oracle_id: raw.oracle_id,
    scryfall_id: raw.id,
    set_code: raw.set ?? "",
    set_name: raw.set_name ?? "",
    collector_number: raw.collector_number ?? "",
    rarity: raw.rarity ?? "",
    prices: JSON.stringify(raw.prices ?? {}),
    released_at: raw.released_at ?? null,
  };
}
