/** Pure complete desired-state validation; storage and application own concurrency. */
import { budgetPlan } from "../analyze/budget.js";
import { effectiveRoles } from "../analyze/deckRoles.js";
import type { CardIndex } from "../index/cardIndex.js";
import type { Card, Role } from "../types/card.js";
import type { ConstructionDiagnostic } from "../types/construction.js";
import type { Deck, DeckCardEntry } from "../types/deck.js";
import type { DeckPlanRequest, DeckPlanValidation } from "../types/deckPlan.js";
import { commanderColorIdentity, validateCommander } from "../validate/commanderRules.js";
import {
  companionRuleCoverage,
  isCompanionCard,
  validateCompanion,
} from "../validate/companionRules.js";
import { validateCore } from "../validate/coreRules.js";
import { copyLimit, normalizeConstruction } from "./construction.js";

const counts = (entries: readonly DeckCardEntry[]): Map<string, number> => {
  const result = new Map<string, number>();
  for (const entry of entries)
    result.set(entry.oracle_id, (result.get(entry.oracle_id) ?? 0) + entry.qty);
  return result;
};

function countEdits(base: Deck | undefined, desired: Deck): DeckPlanValidation["edits"] {
  const inventory = (deck: Deck | undefined): Map<string, number> =>
    counts([
      ...(deck?.cards.map((e) => ({ ...e, oracle_id: `library:${e.oracle_id}` })) ?? []),
      ...(deck?.commanders.map((oracle_id) => ({ oracle_id: `commander:${oracle_id}`, qty: 1 })) ??
        []),
      ...(deck?.companion ? [{ oracle_id: `companion:${deck.companion}`, qty: 1 }] : []),
    ]);
  const before = inventory(base);
  const after = inventory(desired);
  let additions = 0;
  let removals = 0;
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const delta = (after.get(id) ?? 0) - (before.get(id) ?? 0);
    additions += Math.max(0, delta);
    removals += Math.max(0, -delta);
  }
  return { additions, removals, changes: additions + removals };
}

function knownLandType(card: Card | null): string | null {
  if (!card || card.type_line.includes("//")) return null;
  if (card.gameplay)
    return card.gameplay.face_relationship === "single"
      ? card.gameplay.characteristics.type_line
      : null;
  return card.type_line || null;
}

function companionCharacteristicsUnknown(card: Card): boolean {
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

export function prepareDeckChange(
  input: DeckPlanRequest,
  index: CardIndex,
  base: Deck | undefined,
  dataSnapshot: string,
): { desired: Deck; validation: DeckPlanValidation } {
  const diagnostics: ConstructionDiagnostic[] = [];
  const add = (
    code: string,
    severity: ConstructionDiagnostic["severity"],
    path: string,
    message: string,
  ): void => {
    diagnostics.push({ code, severity, path, related_paths: [], message });
  };
  const resolve = (ref: string, path: string): string => {
    const direct = index.getCard(ref);
    if (direct) return direct.oracle_id;
    const matches = index.resolveName(ref, { exact: true });
    if (matches.length === 1 && matches[0]) return matches[0].oracle_id;
    add(
      matches.length ? "AMBIGUOUS_CARD" : "UNKNOWN_CARD",
      "unresolved",
      path,
      `An exact indexed card is required for '${ref}'.`,
    );
    return ref;
  };
  const desiredCounts = counts(
    input.request.cards.map((entry, i) => ({
      oracle_id: resolve(entry.oracle_id, `/cards/${i}/oracle_id`),
      qty: entry.qty,
    })),
  );
  const cards = [...desiredCounts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([oracle_id, qty]) => ({ oracle_id, qty }));
  // This normalizer checks the proposed inventory and protected declarations.
  // The original base remains the sole baseline for exact edit accounting below.
  const normalization = normalizeConstruction(
    { ...input.request, cards: base ? undefined : cards },
    index,
    base ? { ...base, cards } : undefined,
  );
  diagnostics.push(...structuredClone(normalization.diagnostics));
  const specification = normalization.specification;
  if (normalization.choices.length)
    add(
      "CONSTRUCTION_CHOICES_REQUIRED",
      "unresolved",
      "/request",
      "Resolve every construction choice before applying this inventory.",
    );
  const commanders =
    specification.command_zone?.commanders ??
    specification.requested_command_zone?.commanders ??
    [];
  const desired: Deck = {
    deck_id: base?.deck_id ?? "pending-deck-plan",
    name: input.name ?? base?.name ?? "New deck",
    format: "commander",
    commanders: [...commanders],
    command_zone_kind:
      specification.command_zone?.command_zone_kind ?? base?.command_zone_kind ?? "single",
    cards,
    computed_color_identity: commanderColorIdentity({ commanders }, (id) => index.getCard(id)),
    version: (base?.version ?? 0) + 1,
    data_snapshot: dataSnapshot,
    ...(specification.companion ? { companion: specification.companion.oracle_id } : {}),
    ...(specification.intent ? { intent: structuredClone(specification.intent) } : {}),
    ...(base?.role_overrides ? { role_overrides: structuredClone(base.role_overrides) } : {}),
  };
  const lookup = (id: string) => index.getCard(id);
  const startingEntries = [...cards, ...commanders.map((oracle_id) => ({ oracle_id, qty: 1 }))];
  const startingCounts = counts(startingEntries);
  const allIds = new Set([
    ...startingCounts.keys(),
    ...(desired.companion ? [desired.companion] : []),
  ]);
  for (const id of allIds) {
    const card = lookup(id);
    if (!card) {
      add(
        "UNKNOWN_CARD",
        "unresolved",
        "/cards",
        `Card '${id}' is absent from the installed index.`,
      );
      continue;
    }
    if (card.legalities.commander !== "legal")
      add(
        card.legalities.commander ? "FORMAT_ILLEGAL" : "FORMAT_LEGALITY_UNKNOWN",
        card.legalities.commander ? "conflict" : "unresolved",
        "/cards",
        `${card.name} has ${card.legalities.commander ?? "unknown"} Commander legality.`,
      );
    const limit = copyLimit(card);
    if (limit === null)
      add(
        "COPY_LIMIT_UNRESOLVED",
        "unresolved",
        "/cards",
        `The bounded copy exception for ${card.name} is not understood.`,
      );
    else if ((startingCounts.get(id) ?? 0) > limit)
      add(
        "COPY_LIMIT_EXCEEDED",
        "conflict",
        "/cards",
        `${card.name} permits at most ${limit} copies in the starting deck.`,
      );
  }
  for (const id of commanders)
    if (desiredCounts.has(id))
      add(
        "COMMANDER_LIBRARY_OVERLAP",
        "conflict",
        "/commanders",
        `Commander '${id}' also appears in the library.`,
      );
  if (desired.companion) {
    const companion = lookup(desired.companion);
    if (startingCounts.has(desired.companion))
      add(
        "COMPANION_DECK_OVERLAP",
        "conflict",
        "/companion",
        "The declared companion must be outside the starting deck.",
      );
    if (companion) {
      if (!isCompanionCard(companion))
        add(
          "NOT_A_COMPANION",
          "conflict",
          "/companion",
          `${companion.name} does not have the companion ability.`,
        );
      if (companion.color_identity.some((c) => !desired.computed_color_identity.includes(c)))
        add(
          "COMPANION_COLOR_IDENTITY",
          "conflict",
          "/companion",
          "The companion exceeds the command-zone color identity.",
        );
      if (
        companionRuleCoverage(companion) !== "supported" ||
        (companion.name !== "Yorion, Sky Nomad" &&
          [...startingCounts.keys()].some((id) => {
            const card = lookup(id);
            return !card || companionCharacteristicsUnknown(card);
          }))
      )
        add(
          "COMPANION_CONDITION_UNRESOLVED",
          "unresolved",
          "/companion",
          "Installed starting-card characteristics do not establish this companion condition exactly.",
        );
    }
  }
  const legality = [
    ...validateCore(desired, lookup),
    ...validateCommander(desired, lookup),
    ...validateCompanion(desired, lookup),
  ];
  const hard = specification.intent?.hard;
  for (const entry of hard?.locked_cards ?? [])
    if ((startingCounts.get(entry.oracle_id) ?? 0) < entry.qty)
      add(
        "LOCKED_CARD_MISSING",
        "conflict",
        "/intent/hard/locked_cards",
        `The starting deck must retain at least ${entry.qty} copies of '${entry.oracle_id}'.`,
      );
  for (const id of hard?.excluded_cards ?? [])
    if (allIds.has(id))
      add(
        "EXCLUDED_CARD_PRESENT",
        "conflict",
        "/intent/hard/excluded_cards",
        `Excluded card '${id}' occurs in the proposed deck or companion zone.`,
      );
  for (const [i, dependency] of specification.strategy_dependencies.entries())
    for (const id of dependency.requires_cards ?? [])
      if (!startingCounts.has(id))
        add(
          "STRATEGY_CARD_MISSING",
          dependency.strength === "hard" ? "conflict" : "advisory",
          `/strategy_dependencies/${i}`,
          `Dependency '${dependency.id}' requires '${id}'.`,
        );
  const edits = countEdits(base, desired);
  for (const [key, value] of [
    ["max_additions", edits.additions],
    ["max_removals", edits.removals],
    ["max_changes", edits.changes],
  ] as const) {
    const limit = specification.edit_bounds[key];
    if (limit !== undefined && value > limit)
      add(
        "EDIT_BOUND_EXCEEDED",
        "conflict",
        `/edit_bounds/${key}`,
        `The proposed ${value} card-copy ${key === "max_changes" ? "edits" : key === "max_additions" ? "additions" : "removals"} exceed the maximum ${limit}.`,
      );
  }
  let landCount: number | null = 0;
  const roleCounts: Partial<Record<Role, number>> = {};
  for (const entry of cards) {
    const card = lookup(entry.oracle_id);
    const type = knownLandType(card);
    if (type === null) landCount = null;
    else if (landCount !== null && /\bLand\b/.test(type)) landCount += entry.qty;
    if (card)
      for (const role of effectiveRoles(card, desired.role_overrides))
        roleCounts[role] = (roleCounts[role] ?? 0) + entry.qty;
  }
  const lands = specification.lands;
  if (lands) {
    const severity = lands.strength === "hard" ? "unresolved" : "advisory";
    if (landCount === null)
      add(
        "LAND_COUNT_UNRESOLVED",
        severity,
        "/lands",
        "Missing or multiface land characteristics require an explicit counting policy.",
      );
    else if (landCount < lands.min || landCount > lands.max)
      add(
        "LAND_RANGE_UNMET",
        lands.strength === "hard" ? "conflict" : "advisory",
        "/lands",
        `The library contains ${landCount} lands; requested range is ${lands.min}–${lands.max}.`,
      );
  }
  for (const [role, range] of Object.entries(specification.roles)) {
    const count = Object.entries(roleCounts).find(([key]) => key === role)?.[1] ?? 0;
    if (count < range.min || count > range.max)
      add(
        "ROLE_RANGE_UNMET",
        range.strength === "hard" ? "unresolved" : "advisory",
        `/roles/${role}`,
        `Current advisory role labels count ${count}; requested range is ${range.min}–${range.max}. Saved user role overrides are included.`,
      );
  }
  const budgetSpec = specification.budget;
  const budget = budgetPlan(
    [
      ...startingEntries,
      ...(budgetSpec.include_companion && desired.companion
        ? [{ oracle_id: desired.companion, qty: 1 }]
        : []),
    ],
    lookup,
    {
      ...(budgetSpec.usd === null ? {} : { targetUsd: budgetSpec.usd }),
      dataSnapshot,
    },
  );
  if ((budgetSpec.mode === "cap" || budgetSpec.mode === "target") && budgetSpec.usd !== null) {
    const hardCap = budgetSpec.mode === "cap";
    if (budget.minor_units.min_buy > Math.round(budgetSpec.usd * 100))
      add(
        hardCap ? "BUDGET_CAP_EXCEEDED" : "BUDGET_TARGET_UNMET",
        hardCap ? "conflict" : "advisory",
        "/budget",
        `The installed whole-deck price floor $${budget.min_buy_usd.toFixed(2)} exceeds $${budgetSpec.usd.toFixed(2)}${budgetSpec.include_companion ? ", including companion" : ", excluding companion"}.`,
      );
    else if (!budget.coverage.min_buy.complete)
      add(
        "BUDGET_PRICE_UNKNOWN",
        hardCap ? "unresolved" : "advisory",
        "/budget",
        "Missing installed prices cannot establish that the complete deck meets this amount.",
      );
  }
  return {
    desired,
    validation: {
      valid:
        normalization.status === "ready" &&
        !diagnostics.some((d) => d.severity !== "advisory") &&
        !legality.some((v) => v.severity === "error"),
      normalization,
      diagnostics,
      legality,
      budget,
      edits,
      land_count: landCount,
      role_counts: roleCounts,
    },
  };
}
