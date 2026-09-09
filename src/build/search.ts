/** Small deterministic beam over complete inventory construction, with optimistic pruning. */
import type { CardIndex } from "../index/cardIndex.js";
import type { Card, Role } from "../types/card.js";
import type { ConstructionRequest, ConstructionResult } from "../types/construction.js";
import type { Deck, DeckCardEntry } from "../types/deck.js";
import type { DeckPlanRequest, DeckPlanValidation } from "../types/deckPlan.js";
import type { ConstructionOptions, ConstructionSearchReport } from "./construction.js";
import { cheapestUsdCents } from "../analyze/pricing.js";
import { validateCompanion } from "../validate/companionRules.js";

export interface BuildCandidate {
  card: Card;
  limit: number;
  land: boolean;
  roles: readonly Role[];
  price: number | null;
  seed: number;
  favorite: number;
  priority: number;
}
interface State {
  inventory: Map<string, number>;
  quantity: number;
  lands: number;
  roles: Map<string, number>;
  cents: number;
  score: number;
  key: string;
}
interface FoundInventory {
  proposal: DeckPlanRequest;
  desired: Deck;
  validation: DeckPlanValidation;
}
interface SearchInput {
  request: ConstructionRequest;
  normalized: ConstructionResult;
  context: Deck;
  mandatory: Map<string, number>;
  pool: BuildCandidate[];
  roleTargets: Record<string, { min: number; max: number; strength: "hard" | "preferred" }>;
  index: CardIndex;
  options: ConstructionOptions;
  search: ConstructionSearchReport;
  validate(cards: DeckCardEntry[]): FoundInventory | null;
}
const inventoryKey = (inventory: ReadonlyMap<string, number>): string =>
  JSON.stringify([...inventory].sort(([a], [b]) => a.localeCompare(b)));
const inventoryEntries = (inventory: ReadonlyMap<string, number>): DeckCardEntry[] =>
  [...inventory]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([oracle_id, qty]) => ({ oracle_id, qty }));

export function searchInventory(input: SearchInput): FoundInventory | null {
  const { normalized, context, pool, options, search } = input;
  const spec = normalized.specification;
  const target = spec.command_zone?.library_size ?? 99;
  const landRange = spec.lands ?? {
    min: Math.min(37, target),
    max: Math.min(37, target),
    strength: "preferred",
  };
  const cap =
    spec.budget.mode === "cap" && spec.budget.usd !== null
      ? Math.round(spec.budget.usd * 100)
      : null;
  const softBudget =
    spec.budget.mode === "target" && spec.budget.usd !== null
      ? Math.round(spec.budget.usd * 100)
      : null;
  const baseline = new Map(options.base?.cards.map((entry) => [entry.oracle_id, entry.qty]) ?? []);
  const baselineQuantity = [...baseline.values()].reduce((sum, qty) => sum + qty, 0);
  const oldCommanders = options.base?.commanders ?? [];
  const zoneAdditions =
    context.commanders.filter((id) => !oldCommanders.includes(id)).length +
    Number(Boolean(context.companion && context.companion !== options.base?.companion));
  const zoneRemovals =
    oldCommanders.filter((id) => !context.commanders.includes(id)).length +
    Number(Boolean(options.base?.companion && options.base.companion !== context.companion));
  const fixedPrices = [
    ...context.commanders,
    ...(spec.budget.include_companion && context.companion ? [context.companion] : []),
  ].reduce((sum, id) => {
    const card = input.index.getCard(id);
    return sum + (card ? (cheapestUsdCents(card) ?? 0) : 0);
  }, 0);
  const byId = new Map(pool.map((candidate) => [candidate.card.oracle_id, candidate]));
  const priceOrder = [...pool].sort(
    (a, b) =>
      (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER) ||
      a.card.oracle_id.localeCompare(b.card.oracle_id),
  );
  let initial: State = {
    inventory: new Map(),
    quantity: 0,
    lands: 0,
    roles: new Map(),
    cents: fixedPrices,
    score: 0,
    key: "[]",
  };
  function add(state: State, candidate: BuildCandidate, qty: number, score: number): State {
    const inventory = new Map(state.inventory);
    inventory.set(candidate.card.oracle_id, (inventory.get(candidate.card.oracle_id) ?? 0) + qty);
    const roles = new Map(state.roles);
    for (const role of candidate.roles) roles.set(role, (roles.get(role) ?? 0) + qty);
    return {
      inventory,
      quantity: state.quantity + qty,
      lands: state.lands + (candidate.land ? qty : 0),
      roles,
      cents: state.cents + (candidate.price ?? 0) * qty,
      score: state.score + score,
      key: inventoryKey(inventory),
    };
  }
  for (const [id, qty] of input.mandatory) {
    const candidate = byId.get(id);
    if (!candidate || qty > candidate.limit) return null;
    initial = add(initial, candidate, qty, 0);
  }
  function feasible(state: State): boolean {
    const slots = target - state.quantity;
    if (slots < 0 || (cap !== null && state.cents > cap)) return false;
    if (
      landRange.strength === "hard" &&
      (state.lands > landRange.max || state.lands + slots < landRange.min)
    )
      return false;
    for (const [role, range] of Object.entries(spec.roles))
      if (range.strength === "hard") {
        const current = state.roles.get(role) ?? 0;
        if (current > range.max || current + slots < range.min) return false;
      }
    let available = 0;
    let availableLands = 0;
    let availableNonlands = 0;
    let retainable = 0;
    const availableRoles = new Map<string, number>();
    for (const candidate of pool) {
      const remaining = Math.max(
        0,
        candidate.limit - (state.inventory.get(candidate.card.oracle_id) ?? 0),
      );
      available += remaining;
      if (candidate.land) availableLands += remaining;
      else availableNonlands += remaining;
      retainable += Math.min(
        remaining,
        Math.max(
          0,
          (baseline.get(candidate.card.oracle_id) ?? 0) -
            (state.inventory.get(candidate.card.oracle_id) ?? 0),
        ),
      );
      for (const role of candidate.roles)
        availableRoles.set(role, (availableRoles.get(role) ?? 0) + remaining);
    }
    if (available < slots) return false;
    if (
      landRange.strength === "hard" &&
      (state.lands + Math.min(slots, availableLands) < landRange.min ||
        state.quantity - state.lands + Math.min(slots, availableNonlands) < target - landRange.max)
    )
      return false;
    for (const [role, range] of Object.entries(spec.roles))
      if (
        range.strength === "hard" &&
        (state.roles.get(role) ?? 0) + Math.min(slots, availableRoles.get(role) ?? 0) < range.min
      )
        return false;
    if (cap !== null) {
      let remaining = slots;
      let minimum = state.cents;
      for (const candidate of priceOrder) {
        const qty = Math.min(
          remaining,
          Math.max(0, candidate.limit - (state.inventory.get(candidate.card.oracle_id) ?? 0)),
        );
        minimum += qty * (candidate.price ?? 0);
        remaining -= qty;
        if (!remaining) break;
      }
      if (minimum > cap) return false;
    }
    if (Object.keys(spec.edit_bounds).length) {
      let overlap = 0;
      for (const [id, qty] of state.inventory) overlap += Math.min(qty, baseline.get(id) ?? 0);
      const maximumOverlap = overlap + Math.min(slots, retainable);
      const additions = target - maximumOverlap + zoneAdditions;
      const removals = baselineQuantity - maximumOverlap + zoneRemovals;
      if (
        (spec.edit_bounds.max_additions !== undefined &&
          additions > spec.edit_bounds.max_additions) ||
        (spec.edit_bounds.max_removals !== undefined && removals > spec.edit_bounds.max_removals) ||
        (spec.edit_bounds.max_changes !== undefined &&
          additions + removals > spec.edit_bounds.max_changes)
      )
        return false;
    }
    return true;
  }
  function score(state: State, candidate: BuildCandidate): number {
    const current = state.inventory.get(candidate.card.oracle_id) ?? 0;
    let value =
      candidate.priority +
      (current < candidate.seed ? 400 : 0) +
      (current < candidate.favorite ? 200 : 0);
    if (current === 0 && !candidate.land) value += 10;
    if (candidate.land) {
      if (state.lands < landRange.min) value += landRange.strength === "hard" ? 10000 : 100;
      else if (state.lands >= landRange.max) value -= 500;
      // Prefer distributed basic sources; their color labels alone do not establish castability.
      value -= current * 2;
    }
    for (const role of candidate.roles) {
      const range = input.roleTargets[role];
      const count = state.roles.get(role) ?? 0;
      if (range && count < range.min) value += range.strength === "hard" ? 10000 : 30;
      else if (range && count >= range.max) value -= 20;
    }
    if (cap !== null || softBudget !== null) value -= (candidate.price ?? 10000) / 10;
    return value;
  }
  if (!feasible(initial)) return null;
  let beam = [initial];
  while (beam.length) {
    const next = new Map<string, State>();
    for (const state of beam) {
      if (state.quantity === target) {
        const found = input.validate(inventoryEntries(state.inventory));
        if (found) return found;
        continue;
      }
      if (search.nodes >= search.limits.node_limit) {
        search.truncation.nodes = true;
        return null;
      }
      const ranked = pool
        .filter(
          (candidate) => (state.inventory.get(candidate.card.oracle_id) ?? 0) < candidate.limit,
        )
        .map((candidate) => ({ candidate, score: score(state, candidate) }))
        .sort(
          (a, b) =>
            b.score - a.score ||
            (a.candidate.price ?? Number.MAX_SAFE_INTEGER) -
              (b.candidate.price ?? Number.MAX_SAFE_INTEGER) ||
            a.candidate.card.oracle_id.localeCompare(b.candidate.card.oracle_id),
        );
      let retained = 0;
      for (const item of ranked) {
        if (retained >= search.limits.branch_limit) {
          search.truncation.branches = true;
          break;
        }
        if (search.nodes >= search.limits.node_limit) {
          search.truncation.nodes = true;
          break;
        }
        // A rejected proposal still consumes work; the bound covers every attempted expansion.
        search.nodes += 1;
        const candidate = add(state, item.candidate, 1, item.score);
        if (!feasible(candidate)) continue;
        if (
          context.companion &&
          validateCompanion({ ...context, cards: inventoryEntries(candidate.inventory) }, (id) =>
            input.index.getCard(id),
          ).some((violation) => violation.severity === "error")
        )
          continue;
        retained += 1;
        const previous = next.get(candidate.key);
        if (!previous || candidate.score > previous.score) next.set(candidate.key, candidate);
      }
    }
    const ordered = [...next.values()].sort(
      (a, b) => b.score - a.score || a.key.localeCompare(b.key),
    );
    if (ordered.length > search.limits.branch_limit) search.truncation.branches = true;
    beam = ordered.slice(0, search.limits.branch_limit);
  }
  return null;
}
