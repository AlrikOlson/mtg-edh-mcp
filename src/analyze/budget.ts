/**
 * Budget planner (spec §5F, review #10) — pure + deterministic.
 *
 * Two honest, zero-judgment levers toward a price target:
 *  1. Reprint savings — for each card whose chosen/default printing costs more
 *     than its cheapest printing, you can buy the cheap printing with NO change
 *     to the deck. The sum is `reprint_savings_usd` (the gap between the default
 *     total and the min-buy total).
 *  2. Cost drivers — the cards contributing the most to the min-buy floor
 *     (cheapest × qty), with their functional roles, so the agent knows what to
 *     consider cutting/replacing.
 *
 * Functional REPLACEMENT (swap an expensive card for a cheaper same-role card) is
 * the hard, heuristic part and lives in a separate chunk (p9-budget-replace).
 *
 * Honest caveat: all figures are the price floors present in the local index
 * (Scryfall-derived); for bulk commons those floors can sit well above real
 * street prices. Advisory only.
 */
import type { Deck, DeckCardEntry, Role } from "../types/index.js";
import type { CardLookup } from "./stats.js";
import { cheapestUsdCents, defaultUsdCents, priceUsdCents } from "./pricing.js";

export interface PriceCoverage {
  complete: boolean;
  priced_quantity: number;
  missing_quantity: number;
  /** Resolved owned copies need no acquisition price. */
  excluded_quantity: number;
}

export interface BudgetCoverage {
  complete: boolean;
  requested_quantity: number;
  resolved_quantity: number;
  unresolved: Array<{ oracle_id: string; qty: number }>;
  missing_prices: Array<{
    oracle_id: string;
    name: string;
    qty: number;
    fields: Array<"default_total" | "min_buy">;
  }>;
  default_total: PriceCoverage;
  min_buy: PriceCoverage;
  acquire: PriceCoverage | null;
}

export interface ReprintSaving {
  oracle_id: string;
  name: string;
  qty: number;
  default_usd: number;
  cheapest_usd: number;
  /** (default - cheapest) × qty — savings from buying the cheapest printing. */
  savings: number;
}

export interface CostDriver {
  oracle_id: string;
  name: string;
  qty: number;
  cheapest_usd: number;
  /** cheapest × qty — this card's contribution to the min-buy floor. */
  contribution: number;
  roles: Role[];
}

export interface BudgetPlan {
  /** Sum of each card's default-printing price × qty. */
  default_total_usd: number;
  /** Sum of each card's cheapest-printing price × qty (the realistic floor). */
  min_buy_usd: number;
  /** default_total - min_buy: savings available from reprints alone (no deck change). */
  reprint_savings_usd: number;
  /** Cards whose default printing is pricier than their cheapest, ranked by savings. */
  reprint_suggestions: ReprintSaving[];
  /** Most expensive cards by cheapest × qty (what to consider cutting), ranked. */
  cost_drivers: CostDriver[];
  target_usd: number | null;
  /** How far the min-buy floor exceeds the target (0 when within budget), or null. */
  over_min_buy_by_usd: number | null;
  /**
   * Cost to actually ACQUIRE the deck when an owned collection is supplied:
   * sum of cheapest×qty for cards NOT owned (owned cards count as $0). Null when
   * no collection was given. Ownership is membership — owning a card zeroes its
   * whole entry regardless of qty (the collection tracks no quantities).
   */
  acquire_usd: number | null;
  /** Min-buy value already covered by owned cards (min_buy − acquire), or null. */
  owned_value_usd: number | null;
  /** How far the acquire cost exceeds the target (0 when within budget), or null. */
  over_acquire_by_usd: number | null;
  /** Observed price estimates; missing prices never count as evidence of zero cost. */
  minor_units: { default_total: number; min_buy: number; acquire: number | null };
  coverage: BudgetCoverage;
  pricing: {
    currency: "USD";
    source: "scryfall";
    basis: "local_index";
    data_snapshot: string | null;
    price_timestamp: string | null;
  };
  /** Age of the min-buy observations, separate from price and card coverage. */
  freshness: {
    status: "fresh" | "stale" | "unknown";
    price_timestamp: string | null;
    max_age_ms: number;
    stale_quantity: number;
    unknown_quantity: number;
  };
  target_met: boolean | null;
  acquire_target_met: boolean | null;
  ownership_basis: "oracle_id_membership_all_copies" | null;
}

export interface BudgetOptions {
  /** Price target in USD; when set, reports the over-budget gap against min-buy. */
  targetUsd?: number;
  /** Max entries in reprint_suggestions / cost_drivers (default 10). */
  limit?: number;
  /**
   * Owned cards (oracle_ids). When given, the plan adds acquire_usd — the cost to
   * buy only the cards you don't own. Omitted = no collection (acquire figures null).
   */
  owned?: ReadonlySet<string>;
  /** Actual observation time, never the dataset or printing release date. */
  priceTimestamp?: string;
  dataSnapshot?: string;
  /** Milliseconds since epoch; injectable for deterministic freshness checks. */
  now?: number;
  /** Freshness threshold; defaults to one day. */
  maxAgeMs?: number;
}

function coverage(requested: number, priced: number, excluded = 0): PriceCoverage {
  const missing = requested - priced - excluded;
  return {
    complete: missing === 0,
    priced_quantity: priced,
    missing_quantity: missing,
    excluded_quantity: excluded,
  };
}

/**
 * Compute a deterministic budget plan for a deck: reprint savings, cost drivers,
 * and the gap to a target. Pure — figures are local-index price floors. Lists are
 * ranked deterministically (value desc, oracle_id tiebreak).
 */
export function budgetPlan(
  entries: readonly DeckCardEntry[],
  lookup: CardLookup,
  opts: BudgetOptions = {},
): BudgetPlan {
  const limit = opts.limit ?? 10;
  const owned = opts.owned;
  let defaultTotal = 0;
  let minBuyTotal = 0;
  let acquireTotal = 0;
  let requestedQuantity = 0;
  let resolvedQuantity = 0;
  let defaultPriced = 0;
  let cheapestPriced = 0;
  let acquirePriced = 0;
  let ownedQuantity = 0;
  const unresolved: BudgetCoverage["unresolved"] = [];
  const missingPrices: BudgetCoverage["missing_prices"] = [];
  const reprints: ReprintSaving[] = [];
  const drivers: CostDriver[] = [];

  for (const entry of entries) {
    const qty = entry.qty;
    requestedQuantity += qty;
    const card = lookup(entry.oracle_id);
    if (!card) {
      unresolved.push({ oracle_id: entry.oracle_id, qty });
      continue;
    }
    resolvedQuantity += qty;
    const d = defaultUsdCents(card);
    const c = cheapestUsdCents(card);
    const missingFields: Array<"default_total" | "min_buy"> = [];
    if (d === null) missingFields.push("default_total");
    else {
      defaultTotal += d * qty;
      defaultPriced += qty;
    }
    if (c === null) missingFields.push("min_buy");
    else {
      minBuyTotal += c * qty;
      cheapestPriced += qty;
    }
    if (missingFields.length > 0)
      missingPrices.push({
        oracle_id: card.oracle_id,
        name: card.name,
        qty,
        fields: missingFields,
      });
    // Owned cards are already in hand ($0 to acquire); the rest cost cheapest×qty.
    if (owned?.has(entry.oracle_id)) ownedQuantity += qty;
    else if (c !== null) {
      acquireTotal += c * qty;
      acquirePriced += qty;
    }

    const savings = d !== null && c !== null ? (d - c) * qty : 0;
    if (d !== null && c !== null && savings > 0) {
      reprints.push({
        oracle_id: card.oracle_id,
        name: card.name,
        qty,
        default_usd: d / 100,
        cheapest_usd: c / 100,
        savings: savings / 100,
      });
    }
    if (c !== null && c > 0) {
      drivers.push({
        oracle_id: card.oracle_id,
        name: card.name,
        qty,
        cheapest_usd: c / 100,
        contribution: (c * qty) / 100,
        roles: [...card.roles],
      });
    }
  }

  reprints.sort((a, b) => b.savings - a.savings || a.oracle_id.localeCompare(b.oracle_id));
  drivers.sort((a, b) => b.contribution - a.contribution || a.oracle_id.localeCompare(b.oracle_id));

  const targetCents = opts.targetUsd === undefined ? null : priceUsdCents(String(opts.targetUsd));
  const target = targetCents === null ? null : targetCents / 100;
  const defaultCoverage = coverage(requestedQuantity, defaultPriced);
  const minBuyCoverage = coverage(requestedQuantity, cheapestPriced);
  const acquireCoverage = owned ? coverage(requestedQuantity, acquirePriced, ownedQuantity) : null;
  const maxAgeMs = opts.maxAgeMs ?? 86_400_000;
  const now = opts.now ?? Date.now();
  const observed = opts.priceTimestamp === undefined ? NaN : Date.parse(opts.priceTimestamp);
  const validObservation = Number.isFinite(observed) && observed <= now;
  const priceTimestamp = validObservation ? (opts.priceTimestamp ?? null) : null;
  const staleQuantity = validObservation && now - observed > maxAgeMs ? cheapestPriced : 0;
  const unknownQuantity = validObservation ? requestedQuantity - cheapestPriced : requestedQuantity;
  const freshness: BudgetPlan["freshness"] = {
    status:
      staleQuantity > 0 ? "stale" : unknownQuantity > 0 || !validObservation ? "unknown" : "fresh",
    price_timestamp: priceTimestamp,
    max_age_ms: maxAgeMs,
    stale_quantity: staleQuantity,
    unknown_quantity: unknownQuantity,
  };
  const canCompareMin = targetCents !== null && minBuyCoverage.complete;
  const canCompareAcquire = targetCents !== null && acquireCoverage?.complete === true;
  return {
    default_total_usd: defaultTotal / 100,
    min_buy_usd: minBuyTotal / 100,
    reprint_savings_usd: (defaultTotal - minBuyTotal) / 100,
    reprint_suggestions: reprints.slice(0, limit),
    cost_drivers: drivers.slice(0, limit),
    target_usd: target,
    over_min_buy_by_usd: canCompareMin ? Math.max(0, minBuyTotal - targetCents) / 100 : null,
    acquire_usd: owned ? acquireTotal / 100 : null,
    owned_value_usd: owned ? (minBuyTotal - acquireTotal) / 100 : null,
    over_acquire_by_usd: canCompareAcquire ? Math.max(0, acquireTotal - targetCents) / 100 : null,
    minor_units: {
      default_total: defaultTotal,
      min_buy: minBuyTotal,
      acquire: owned ? acquireTotal : null,
    },
    coverage: {
      complete: defaultCoverage.complete && minBuyCoverage.complete,
      requested_quantity: requestedQuantity,
      resolved_quantity: resolvedQuantity,
      unresolved,
      missing_prices: missingPrices,
      default_total: defaultCoverage,
      min_buy: minBuyCoverage,
      acquire: acquireCoverage,
    },
    pricing: {
      currency: "USD",
      source: "scryfall",
      basis: "local_index",
      data_snapshot: opts.dataSnapshot ?? null,
      price_timestamp: priceTimestamp,
    },
    freshness,
    target_met: canCompareMin ? minBuyTotal <= targetCents : null,
    acquire_target_met: canCompareAcquire ? acquireTotal <= targetCents : null,
    ownership_basis: owned ? "oracle_id_membership_all_copies" : null,
  };
}

/** Authoritative deck price scope: library quantities plus one per command-zone slot. */
export function wholeDeckBudget(deck: Deck, lookup: CardLookup, opts: BudgetOptions = {}) {
  const options = { ...opts, dataSnapshot: opts.dataSnapshot ?? deck.data_snapshot };
  const commanders = deck.commanders.map((oracle_id) => ({ oracle_id, qty: 1 }));
  const companion = deck.companion ? [{ oracle_id: deck.companion, qty: 1 }] : [];
  const library = budgetPlan(deck.cards, lookup, options);
  const commandZone = budgetPlan(commanders, lookup, options);
  const seenCommanders = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of deck.commanders) {
    if (seenCommanders.has(id)) duplicates.add(id);
    seenCommanders.add(id);
  }
  return {
    library,
    command_zone: commandZone,
    full_deck: budgetPlan([...deck.cards, ...commanders], lookup, options),
    companion: budgetPlan(companion, lookup, options),
    scope: {
      library_quantity: library.coverage.requested_quantity,
      command_zone_quantity: commanders.length,
      full_deck_quantity: library.coverage.requested_quantity + commanders.length,
      companion_quantity: companion.length,
      companion_included: false,
      auxiliary_zones: "not_represented",
      duplicate_commanders: [...duplicates].sort(),
      command_library_overlap: [
        ...new Set(
          deck.cards
            .filter((entry) => seenCommanders.has(entry.oracle_id))
            .map((entry) => entry.oracle_id),
        ),
      ].sort(),
    },
  };
}
