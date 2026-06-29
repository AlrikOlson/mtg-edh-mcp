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
import type { DeckCardEntry, Role } from "../types/index.js";
import type { CardLookup } from "./stats.js";
import { cheapestUsd, defaultUsd } from "./stats.js";

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
}

export interface BudgetOptions {
  /** Price target in USD; when set, reports the over-budget gap against min-buy. */
  targetUsd?: number;
  /** Max entries in reprint_suggestions / cost_drivers (default 10). */
  limit?: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

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
  let defaultTotal = 0;
  let minBuyTotal = 0;
  const reprints: ReprintSaving[] = [];
  const drivers: CostDriver[] = [];

  for (const entry of entries) {
    const card = lookup(entry.oracle_id);
    if (!card) continue;
    const d = defaultUsd(card) ?? 0;
    const c = cheapestUsd(card) ?? 0;
    const qty = entry.qty;
    defaultTotal += d * qty;
    minBuyTotal += c * qty;

    const savings = (d - c) * qty;
    if (savings > 0) {
      reprints.push({
        oracle_id: card.oracle_id,
        name: card.name,
        qty,
        default_usd: round2(d),
        cheapest_usd: round2(c),
        savings: round2(savings),
      });
    }
    if (c > 0) {
      drivers.push({
        oracle_id: card.oracle_id,
        name: card.name,
        qty,
        cheapest_usd: round2(c),
        contribution: round2(c * qty),
        roles: [...card.roles],
      });
    }
  }

  reprints.sort((a, b) => b.savings - a.savings || a.oracle_id.localeCompare(b.oracle_id));
  drivers.sort((a, b) => b.contribution - a.contribution || a.oracle_id.localeCompare(b.oracle_id));

  const target = opts.targetUsd ?? null;
  return {
    default_total_usd: round2(defaultTotal),
    min_buy_usd: round2(minBuyTotal),
    reprint_savings_usd: round2(defaultTotal - minBuyTotal),
    reprint_suggestions: reprints.slice(0, limit),
    cost_drivers: drivers.slice(0, limit),
    target_usd: target,
    over_min_buy_by_usd: target !== null ? round2(Math.max(0, minBuyTotal - target)) : null,
  };
}
