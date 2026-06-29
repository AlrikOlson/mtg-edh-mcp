/**
 * Mana base & role coverage analysis (spec §5D) — pure, quantity-weighted.
 *
 * analyzeManaBase: per-color source counts (lands + mana rocks/dorks), the
 * tapped/untapped split for lands, fixing density, and which of the deck's
 * colors look under-supported. analyzeRoleCoverage: role tallies vs configurable
 * target bands -> gaps. Both advisory (never feed validation).
 */
import type { Card, Color, DeckCardEntry, Role } from "../types/index.js";

/** Resolves an oracle_id to its Card, or null when unknown. */
export type CardLookup = (oracleId: string) => Card | null;

const COLORS: readonly Color[] = ["W", "U", "B", "R", "G"];

function isLand(card: Card): boolean {
  return /\bLand\b/.test(card.type_line);
}
function entersTapped(card: Card): boolean {
  return /enters (?:the battlefield )?tapped/i.test(card.oracle_text);
}
function addsAnyColor(card: Card): boolean {
  return (
    /add[^.]*one mana of any color/i.test(card.oracle_text) || /any color/i.test(card.oracle_text)
  );
}

/** Which colors a card can produce (from "Add {X}" pips + "any color"). */
function producedColors(card: Card, identity: readonly Color[]): Set<Color> {
  const out = new Set<Color>();
  if (addsAnyColor(card)) {
    const fill = identity.length > 0 ? identity : COLORS;
    for (const c of fill) out.add(c);
    return out;
  }
  // For each "Add …" clause (up to the sentence end), collect every colored pip.
  for (const m of card.oracle_text.matchAll(/add\b[^.]*/gi)) {
    for (const p of m[0].matchAll(/\{([WUBRG])\}/g)) out.add(p[1] as Color);
  }
  return out;
}

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

export interface ManaBaseReport {
  total_lands: number;
  untapped_lands: number;
  tapped_lands: number;
  /** Per-color source counts (lands + rocks + dorks that can produce it). */
  sources: Record<string, number>;
  /** Sources that produce 2+ colors or any color. */
  fixing_sources: number;
  /** Deck-identity colors whose source count is below `threshold`. */
  under_supported: Color[];
}

/** Analyze a deck's mana base (qty-weighted). `identity` scopes "any color". */
export function analyzeManaBase(
  entries: readonly DeckCardEntry[],
  lookup: CardLookup,
  options: { identity?: readonly Color[]; threshold?: number } = {},
): ManaBaseReport {
  const identity = options.identity ?? [];
  const threshold = options.threshold ?? 10;
  const sources: Record<string, number> = {};
  for (const c of COLORS) sources[c] = 0;
  let total_lands = 0;
  let tapped_lands = 0;
  let fixing_sources = 0;

  for (const { card, qty } of resolved(entries, lookup)) {
    const colors = producedColors(card, identity);
    const producesMana = colors.size > 0;
    if (isLand(card)) {
      total_lands += qty;
      if (entersTapped(card)) tapped_lands += qty;
    }
    if (producesMana) {
      for (const c of colors) sources[c] = (sources[c] ?? 0) + qty;
      if (colors.size >= 2 || addsAnyColor(card)) fixing_sources += qty;
    }
  }

  const scope = identity.length > 0 ? identity : COLORS;
  const under_supported = scope.filter((c) => (sources[c] ?? 0) < threshold);
  return {
    total_lands,
    untapped_lands: total_lands - tapped_lands,
    tapped_lands,
    sources,
    fixing_sources,
    under_supported,
  };
}

/** A target band for a role's count. */
export interface RoleBand {
  min: number;
  max: number;
}
export type RoleBands = Partial<Record<Role, RoleBand>>;

/** Heuristic default target bands for a typical Commander deck (configurable). */
export const DEFAULT_BANDS: RoleBands = {
  ramp: { min: 8, max: 12 },
  card_draw: { min: 8, max: 12 },
  spot_removal: { min: 5, max: 10 },
  board_wipe: { min: 2, max: 4 },
  land: { min: 33, max: 38 },
  tutor: { min: 0, max: 10 },
  protection: { min: 2, max: 8 },
};

export interface CoverageGap {
  role: Role;
  have: number;
  want_min: number;
  want_max: number;
  status: "under" | "ok" | "over";
}

/** Compare quantity-weighted role counts against target bands. */
export function analyzeRoleCoverage(
  entries: readonly DeckCardEntry[],
  lookup: CardLookup,
  bands: RoleBands = DEFAULT_BANDS,
): { counts: Record<string, number>; gaps: CoverageGap[] } {
  const counts: Record<string, number> = {};
  for (const { card, qty } of resolved(entries, lookup)) {
    for (const role of card.roles) counts[role] = (counts[role] ?? 0) + qty;
  }
  const gaps: CoverageGap[] = [];
  for (const [role, band] of Object.entries(bands) as [Role, RoleBand][]) {
    const have = counts[role] ?? 0;
    const status = have < band.min ? "under" : have > band.max ? "over" : "ok";
    gaps.push({ role, have, want_min: band.min, want_max: band.max, status });
  }
  return { counts, gaps };
}
