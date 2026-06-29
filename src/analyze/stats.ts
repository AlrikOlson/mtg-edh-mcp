/**
 * Deck statistics (spec §5D) — exact, quantity-weighted aggregates over a deck.
 * These exist precisely because LLMs miscount and mis-sum: every figure here is
 * computed deterministically from card data, never estimated.
 *
 * Pure functions over (entries, lookup) where entries are {oracle_id, qty} and
 * lookup resolves a Card. The MCP tools (analyzeTools) supply lookup =
 * CardIndex.getCard. combo_piece/payoff roles and EDHREC rank are out of scope
 * (no edhrec_rank in the Card model yet).
 */
import type { Card, Color, DeckCardEntry, Role } from "../types/index.js";

/** Resolves an oracle_id to its Card, or null when unknown. */
export type CardLookup = (oracleId: string) => Card | null;

const COLORS: readonly Color[] = ["W", "U", "B", "R", "G"];
/** Highest explicit curve bucket; anything ≥ this is grouped into "7+". */
const CURVE_CAP = 7;

function isLand(card: Card): boolean {
  return /\bLand\b/.test(card.type_line);
}

/** Parse a price string to a finite number, or null (treats "" / undefined as missing). */
function priceUsd(value: string | null | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The card's default-printing USD (the chosen/oracle price), or null if unpriced. */
export function defaultUsd(card: Card): number | null {
  return priceUsd(card.prices.usd);
}

/**
 * The cheapest USD across the card's printings (review #4 — budget builders want
 * the real floor, not whatever printing happened to be chosen). Falls back to the
 * default price when no printing carries a usable price (e.g. unpriced fixtures).
 */
export function cheapestUsd(card: Card): number | null {
  let min: number | null = null;
  for (const printing of card.printings) {
    const usd = priceUsd(printing.prices.usd);
    if (usd !== null && (min === null || usd < min)) min = usd;
  }
  return min ?? defaultUsd(card);
}

/** Card type tokens the composition report counts (a card counts under each it has). */
const CARD_TYPES = [
  "Creature",
  "Instant",
  "Sorcery",
  "Artifact",
  "Enchantment",
  "Planeswalker",
  "Land",
  "Battle",
] as const;

/** Resolve each entry to its Card, dropping unknowns, preserving qty. */
function resolved(
  entries: readonly DeckCardEntry[],
  lookup: CardLookup,
): Array<{ card: Card; qty: number }> {
  const out: Array<{ card: Card; qty: number }> = [];
  for (const e of entries) {
    const card = lookup(e.oracle_id);
    if (card) out.push({ card, qty: e.qty });
  }
  return out;
}

export interface CurveFilter {
  exclude_lands?: boolean;
  role?: Role;
  color?: Color;
}

/** Quantity-weighted mana-value histogram, with optional filters. */
export function analyzeCurve(
  entries: readonly DeckCardEntry[],
  lookup: CardLookup,
  filter: CurveFilter = {},
): { buckets: Record<string, number>; total: number } {
  const buckets: Record<string, number> = {};
  let total = 0;
  for (const { card, qty } of resolved(entries, lookup)) {
    if (filter.exclude_lands && isLand(card)) continue;
    if (filter.role && !card.roles.includes(filter.role)) continue;
    if (filter.color && !card.color_identity.map((c) => c.toUpperCase()).includes(filter.color)) {
      continue;
    }
    const mv = Math.max(0, Math.floor(card.mv));
    const key = mv >= CURVE_CAP ? `${CURVE_CAP}+` : String(mv);
    buckets[key] = (buckets[key] ?? 0) + qty;
    total += qty;
  }
  return { buckets, total };
}

/** Quantity-weighted counts by card type and by functional role. */
export function analyzeComposition(
  entries: readonly DeckCardEntry[],
  lookup: CardLookup,
): { by_type: Record<string, number>; by_role: Record<string, number>; total: number } {
  const by_type: Record<string, number> = {};
  const by_role: Record<string, number> = {};
  let total = 0;
  for (const { card, qty } of resolved(entries, lookup)) {
    total += qty;
    for (const t of CARD_TYPES) {
      if (new RegExp(`\\b${t}\\b`).test(card.type_line)) by_type[t] = (by_type[t] ?? 0) + qty;
    }
    for (const role of card.roles) by_role[role] = (by_role[role] ?? 0) + qty;
  }
  return { by_type, by_role, total };
}

function pipColor(mana_cost: string): Record<string, number> {
  const pips: Record<string, number> = {};
  for (const m of mana_cost.matchAll(/\{([WUBRG])\}/g)) {
    const c = m[1]!;
    pips[c] = (pips[c] ?? 0) + 1;
  }
  return pips;
}

/** Aggregate stats: counts, average MV, color-pip distribution, total price. */
export function analyzeStats(
  entries: readonly DeckCardEntry[],
  lookup: CardLookup,
): {
  total_cards: number;
  nonland_cards: number;
  avg_mv: number;
  avg_mv_nonland: number;
  color_pips: Record<string, number>;
  /** Sum of each card's default-printing price (the chosen/oracle price). */
  total_price_usd: number;
  /** Sum of each card's CHEAPEST printing — the realistic floor to buy the deck (review #4). */
  min_buy_usd: number;
} {
  const cards = resolved(entries, lookup);
  let total = 0;
  let nonland = 0;
  let mvSum = 0;
  let mvSumNonland = 0;
  let defaultTotal = 0;
  let minBuyTotal = 0;
  const color_pips: Record<string, number> = {};
  for (const c of COLORS) color_pips[c] = 0;

  for (const { card, qty } of cards) {
    total += qty;
    mvSum += card.mv * qty;
    if (!isLand(card)) {
      nonland += qty;
      mvSumNonland += card.mv * qty;
    }
    defaultTotal += (defaultUsd(card) ?? 0) * qty;
    minBuyTotal += (cheapestUsd(card) ?? 0) * qty;
    for (const [color, n] of Object.entries(pipColor(card.mana_cost))) {
      color_pips[color] = (color_pips[color] ?? 0) + n * qty;
    }
  }

  return {
    total_cards: total,
    nonland_cards: nonland,
    avg_mv: total > 0 ? round2(mvSum / total) : 0,
    avg_mv_nonland: nonland > 0 ? round2(mvSumNonland / nonland) : 0,
    color_pips,
    total_price_usd: round2(defaultTotal),
    min_buy_usd: round2(minBuyTotal),
  };
}
