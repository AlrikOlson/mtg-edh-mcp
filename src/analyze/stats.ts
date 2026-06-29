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
  total_price_usd: number;
} {
  const cards = resolved(entries, lookup);
  let total = 0;
  let nonland = 0;
  let mvSum = 0;
  let mvSumNonland = 0;
  let priceUsd = 0;
  const color_pips: Record<string, number> = {};
  for (const c of COLORS) color_pips[c] = 0;

  for (const { card, qty } of cards) {
    total += qty;
    mvSum += card.mv * qty;
    if (!isLand(card)) {
      nonland += qty;
      mvSumNonland += card.mv * qty;
    }
    const usd = Number(card.prices.usd);
    if (Number.isFinite(usd)) priceUsd += usd * qty;
    for (const [color, n] of Object.entries(pipColor(card.mana_cost))) {
      color_pips[color] = (color_pips[color] ?? 0) + n * qty;
    }
  }

  const round2 = (n: number): number => Math.round(n * 100) / 100;
  return {
    total_cards: total,
    nonland_cards: nonland,
    avg_mv: total > 0 ? round2(mvSum / total) : 0,
    avg_mv_nonland: nonland > 0 ? round2(mvSumNonland / nonland) : 0,
    color_pips,
    total_price_usd: round2(priceUsd),
  };
}
