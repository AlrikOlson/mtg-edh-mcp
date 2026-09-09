/** Pure request normalization. Ready means usable construction constraints, not a completed deck. */
import type { CardIndex } from "../index/cardIndex.js";
import type { Deck, DeckCardEntry, CommandZoneKind } from "../types/deck.js";
import { isDeepStrictEqual } from "node:util";
import { effectiveRoles } from "../analyze/deckRoles.js";
import { ROLES } from "../types/card.js";
import type { Card } from "../types/card.js";
import type {
  ConstructionRequest,
  ConstructionResult,
  ConstructionDiagnostic,
  ConstructionZone,
} from "../types/construction.js";
import { intentDiagnostics, type DeckIntent } from "./intent.js";
import { COMMANDER_DECK_SIZE, anyNumberReason, checkColorIdentity } from "../validate/coreRules.js";
import { commanderColorIdentity, validateCommander } from "../validate/commanderRules.js";
import {
  isCompanionCard,
  validateCompanion,
  companionRuleCoverage,
} from "../validate/companionRules.js";
import { budgetPlan } from "../analyze/budget.js";
import { compilePlaygroupPolicy } from "../meta/playgroupPolicy.js";

const copyLimit = (card: Card): number | null => {
  // The shared allowlist includes bounded-copy exceptions; preserve their actual limits here.
  const bounded = /up to (\w+) cards named/i.exec(card.oracle_text)?.[1];
  const numbers: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
  };
  if (bounded) {
    const value = numbers[bounded.toLowerCase()] ?? Number(bounded);
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
  }
  if (card.name === "Seven Dwarves") return 7;
  if (card.name === "Nazgûl") return 9;
  return anyNumberReason(card) ? COMMANDER_DECK_SIZE : 1;
};

export function normalizeConstruction(
  request: ConstructionRequest,
  index: CardIndex,
  deck?: Deck,
): ConstructionResult {
  const diagnostics: ConstructionDiagnostic[] = [];
  const choices: ConstructionResult["choices"] = [];
  const unresolved: ConstructionResult["unresolved_requirements"] = [];
  const relaxations: ConstructionResult["specification"]["preferred_relaxations"] = [];
  const add = (
    target: ConstructionDiagnostic[],
    code: string,
    severity: ConstructionDiagnostic["severity"],
    path: string,
    message: string,
    related_paths: string[] = [],
  ): void => {
    target.push({ code, severity, path, related_paths, message });
  };
  const resolve = (ref: string, path: string, target = diagnostics): string => {
    const direct = index.getCard(ref);
    if (direct) return direct.oracle_id;
    const matches = index.resolveName(ref, { exact: true });
    if (matches.length === 1 && matches[0]) return matches[0].oracle_id;
    add(
      target,
      matches.length ? "AMBIGUOUS_CARD" : "UNKNOWN_CARD",
      "unresolved",
      path,
      matches.length
        ? `Choose an exact canonical card for '${ref}'.`
        : `No exact indexed card matches '${ref}'.`,
    );
    if (target === diagnostics)
      choices.push({
        id: `card:${path}`,
        path,
        reason: "Resolve this card reference before construction.",
        options: matches.map((c) => ({ value: c.oracle_id, label: c.name })),
      });
    return ref;
  };
  const resolveEntries = (entries: readonly DeckCardEntry[], path: string): DeckCardEntry[] =>
    entries.map((e, i) => ({
      oracle_id: resolve(e.oracle_id, `${path}/${i}/oracle_id`),
      qty: e.qty,
    }));
  const normalizeIntent = (input: DeckIntent): DeckIntent => {
    const intent = structuredClone(input);
    if (intent.hard?.locked_cards)
      intent.hard.locked_cards = resolveEntries(
        intent.hard.locked_cards,
        "/intent/hard/locked_cards",
      );
    if (intent.hard?.excluded_cards)
      intent.hard.excluded_cards = intent.hard.excluded_cards.map((id, i) =>
        resolve(id, `/intent/hard/excluded_cards/${i}`),
      );
    for (const key of ["allowed", "required"] as const) {
      const values = intent.hard?.commanders?.[key];
      if (values && intent.hard?.commanders)
        intent.hard.commanders[key] = values.map((id, i) =>
          resolve(id, `/intent/hard/commanders/${key}/${i}`),
        );
    }
    if (intent.soft?.favorites)
      intent.soft.favorites = resolveEntries(intent.soft.favorites, "/intent/soft/favorites");
    for (const d of intentDiagnostics(intent)) {
      const preferred = d.path.startsWith("/soft/");
      add(
        diagnostics,
        d.code,
        preferred ? "advisory" : "conflict",
        `/intent${d.path}`,
        d.message,
        d.code === "LOCKED_EXCLUDED" ? ["/intent/hard/excluded_cards"] : [],
      );
      if (preferred) relaxations.push({ path: `/intent${d.path}`, reason: d.message });
    }
    return intent;
  };
  if (deck?.intent && request.intent && !isDeepStrictEqual(deck.intent, request.intent)) {
    add(
      diagnostics,
      "INTENT_OVERRIDE_CONFLICT",
      "conflict",
      "/intent",
      "The request supplies a different intent from the saved deck. Resolve or persist that intent change explicitly.",
      ["/source/intent_snapshot"],
    );
  }
  const intent = deck?.intent ?? request.intent;
  const normalizedIntent = intent ? normalizeIntent(intent) : null;
  const seedCounts = new Map<string, number>();
  for (const entry of resolveEntries(request.cards ?? deck?.cards ?? [], "/cards"))
    seedCounts.set(entry.oracle_id, (seedCounts.get(entry.oracle_id) ?? 0) + entry.qty);
  const seed = [...seedCounts].map(([oracle_id, qty]) => ({ oracle_id, qty }));
  if (deck && request.cards) {
    const baseline = new Map<string, number>();
    for (const entry of deck.cards)
      baseline.set(entry.oracle_id, (baseline.get(entry.oracle_id) ?? 0) + entry.qty);
    if (!isDeepStrictEqual(baseline, seedCounts))
      add(
        diagnostics,
        "SAVED_SEED_OVERRIDE_CONFLICT",
        "conflict",
        "/cards",
        "A saved deck already supplies the edit baseline; use a separate request or update that deck explicitly before supplying another seed.",
        ["/source"],
      );
  }
  for (const d of diagnostics)
    if (d.path.startsWith("/intent/soft/") && d.severity === "unresolved") {
      d.severity = "advisory";
      relaxations.push({
        path: d.path,
        reason: "Unresolved preferred card reference is preserved without a construction promise.",
      });
    }
  for (let i = choices.length - 1; i >= 0; i--)
    if (choices[i]?.path.startsWith("/intent/soft/")) choices.splice(i, 1);
  const source: ConstructionResult["specification"]["source"] = deck
    ? {
        kind: "saved_deck",
        deck_id: deck.deck_id,
        version: deck.version,
        data_snapshot: deck.data_snapshot,
        intent_snapshot: structuredClone(deck.intent ?? null),
      }
    : { kind: "request" };
  const budgetInput =
    request.budget ??
    (normalizedIntent?.soft?.spend_target_usd === undefined
      ? { mode: "unspecified" as const, include_companion: false }
      : {
          mode: "target" as const,
          usd: normalizedIntent.soft.spend_target_usd,
          include_companion: false,
        });
  const budget: ConstructionResult["specification"]["budget"] = {
    mode: budgetInput.mode,
    usd: budgetInput.usd ?? null,
    include_companion: budgetInput.include_companion,
    currency: "USD",
  };
  if ((budget.mode === "cap" || budget.mode === "target") && budget.usd === null)
    add(
      diagnostics,
      "BUDGET_AMOUNT_REQUIRED",
      "unresolved",
      "/budget/usd",
      "A cap or target requires an explicit USD amount.",
    );
  if ((budget.mode === "unspecified" || budget.mode === "unbounded") && budget.usd !== null)
    add(
      diagnostics,
      "BUDGET_MODE_CONFLICT",
      "conflict",
      "/budget/usd",
      "Only cap or target modes may include a USD amount.",
      ["/budget/mode"],
    );
  if (budget.mode === "unspecified")
    choices.push({
      id: "budget",
      path: "/budget",
      reason: "Declare a cap, preferred target, or an explicitly unbounded budget.",
      options: [
        { value: { mode: "unbounded" }, label: "Unbounded" },
        { value: { mode: "cap" }, label: "Set a hard cap" },
        { value: { mode: "target" }, label: "Set a preferred target" },
      ],
    });
  const unsupported = (
    id: string,
    path: string,
    value: string,
    strength: "hard" | "preferred",
    reason: string,
  ): void => {
    unresolved.push({ id, path, text: value, strength, reason });
    add(
      diagnostics,
      "UNSUPPORTED_REQUIREMENT",
      strength === "hard" ? "unresolved" : "advisory",
      path,
      reason,
    );
    if (strength === "preferred")
      relaxations.push({
        path,
        reason:
          "This preference is preserved but has no implemented evaluator; construction cannot promise it.",
      });
  };
  const requirements = structuredClone(request.requirements ?? []);
  const dependencies = structuredClone(request.strategy_dependencies ?? []);
  const seenRequirementIds = new Set<string>();
  for (const [i, req] of requirements.entries()) {
    if (seenRequirementIds.has(req.id))
      add(
        diagnostics,
        "DUPLICATE_REQUIREMENT_ID",
        "conflict",
        `/requirements/${i}/id`,
        "Requirement IDs must be unique.",
      );
    seenRequirementIds.add(req.id);
    unsupported(
      req.id,
      `/requirements/${i}`,
      req.text,
      req.strength,
      "Free-text requirements have no machine-checkable predicate in this version.",
    );
  }
  for (const [i, value] of (normalizedIntent?.unsupported ?? []).entries())
    unsupported(
      `intent:${i}`,
      `/intent/unsupported/${i}`,
      value,
      "hard",
      "Persisted unsupported intent remains unresolved.",
    );
  const policy = compilePlaygroupPolicy(normalizedIntent ?? undefined);
  for (const check of policy.checks)
    unsupported(
      `playgroup:${check.category}`,
      `/intent${check.provenance.path}`,
      check.rule,
      "hard",
      "This compiled playgroup rule is preserved but requires downstream policy evidence and evaluation.",
    );
  const mandatory = new Map<string, number>();
  for (const entry of normalizedIntent?.hard?.locked_cards ?? [])
    mandatory.set(entry.oracle_id, Math.max(mandatory.get(entry.oracle_id) ?? 0, entry.qty));
  for (const [i, dependency] of dependencies.entries()) {
    const path = `/strategy_dependencies/${i}`;
    if (seenRequirementIds.has(dependency.id))
      add(
        diagnostics,
        "DUPLICATE_REQUIREMENT_ID",
        "conflict",
        `${path}/id`,
        "Dependency and requirement IDs must be unique.",
      );
    seenRequirementIds.add(dependency.id);
    dependency.requires_cards = dependency.requires_cards?.map((ref, j) =>
      resolve(ref, `${path}/requires_cards/${j}`),
    );
    if (dependency.strength === "hard")
      for (const id of dependency.requires_cards ?? [])
        mandatory.set(id, Math.max(mandatory.get(id) ?? 0, 1));
    if (dependency.text || dependency.requires_roles?.length || !dependency.requires_cards?.length)
      unsupported(
        dependency.id,
        path,
        dependency.text ?? `Requires role support: ${(dependency.requires_roles ?? []).join(", ")}`,
        dependency.strength,
        "Role-support adequacy and free-text strategy dependencies require an explicit evaluator; required card IDs remain binding.",
      );
  }
  const roles = structuredClone(request.roles ?? {});
  for (const [role, range] of Object.entries(normalizedIntent?.soft?.role_targets ?? {})) {
    const knownRole = Object.keys(roles).find((key) => key === role);
    if (!knownRole) Object.assign(roles, { [role]: { ...range, strength: "preferred" } });
  }
  const ranges = [
    ...Object.entries(roles).map(([role, range]) => ({ path: `/roles/${role}`, range })),
    ...(request.lands ? [{ path: "/lands", range: request.lands }] : []),
  ];
  for (const { path, range } of ranges)
    if (range.min > range.max) {
      add(
        diagnostics,
        "INVALID_RANGE",
        range.strength === "hard" ? "conflict" : "advisory",
        path,
        "Minimum must not exceed maximum.",
      );
      if (range.strength === "preferred")
        relaxations.push({ path, reason: "Reversed preferred bounds cannot both be met." });
    }
  const companionRef = request.companion === undefined ? deck?.companion : request.companion;
  const companionId = companionRef ? resolve(companionRef, "/companion") : null;
  const companion = companionId ? { oracle_id: companionId, outside_deck: true as const } : null;
  const excluded = new Set(normalizedIntent?.hard?.excluded_cards ?? []);
  for (const [id, qty] of mandatory) {
    if (excluded.has(id))
      add(
        diagnostics,
        "REQUIRED_EXCLUDED",
        "conflict",
        "/strategy_dependencies",
        `Mandatory card '${id}' is excluded.`,
        ["/intent/hard/excluded_cards", "/intent/hard/locked_cards"],
      );
    const card = index.getCard(id);
    if (card && copyLimit(card) === null)
      add(
        diagnostics,
        "COPY_LIMIT_UNRESOLVED",
        "unresolved",
        "/intent/hard/locked_cards",
        `The bounded copy exception for ${card.name} is not understood.`,
      );
    if (card && card.legalities.commander !== "legal")
      add(
        diagnostics,
        card.legalities.commander ? "FORMAT_ILLEGAL" : "FORMAT_LEGALITY_UNKNOWN",
        card.legalities.commander ? "conflict" : "unresolved",
        "/intent/hard/locked_cards",
        `${card.name} has ${card.legalities.commander ?? "unknown"} Commander legality.`,
        ["/strategy_dependencies"],
      );
    const limit = card ? copyLimit(card) : null;
    if (card && limit !== null && qty > limit)
      add(
        diagnostics,
        "MANDATORY_COPY_LIMIT",
        "conflict",
        "/intent/hard/locked_cards",
        `${card.name} permits at most ${copyLimit(card)} copies, but ${qty} are required.`,
      );
  }
  if (companionId) {
    const card = index.getCard(companionId);
    if (card) {
      if (card.gameplay?.characteristics.oracle_text === null)
        add(
          diagnostics,
          "COMPANION_ABILITY_UNKNOWN",
          "unresolved",
          "/companion",
          "Companion ability evidence is missing.",
        );
      else if (!isCompanionCard(card))
        add(
          diagnostics,
          "NOT_A_COMPANION",
          "conflict",
          "/companion",
          `${card.name} does not have the companion ability.`,
        );
      if (card.legalities.commander !== "legal")
        add(
          diagnostics,
          "COMPANION_FORMAT_ILLEGAL",
          card.legalities.commander ? "conflict" : "unresolved",
          "/companion",
          `${card.name} is not known legal in Commander.`,
        );
      if (mandatory.has(companionId) || seedCounts.has(companionId))
        add(
          diagnostics,
          "COMPANION_DECK_OVERLAP",
          "conflict",
          "/companion",
          "The declared companion must be separate from the starting deck.",
          ["/cards", "/intent/hard/locked_cards"],
        );
      if (excluded.has(companionId))
        add(
          diagnostics,
          "COMPANION_EXCLUDED",
          "conflict",
          "/companion",
          "The declared companion is excluded by intent.",
          ["/intent/hard/excluded_cards"],
        );
    }
  }
  const editBounds = structuredClone(request.edit_bounds ?? {});
  if (normalizedIntent?.hard?.change_limit !== undefined)
    editBounds.max_changes = Math.min(
      editBounds.max_changes ?? 100,
      normalizedIntent.hard.change_limit,
    );
  const seedTotal = seed.reduce((sum, entry) => sum + entry.qty, 0);
  const asDeck = (zone: ConstructionZone, cards: DeckCardEntry[]): Deck => ({
    deck_id: "construction",
    name: "Construction constraints",
    format: "commander",
    commanders: zone.commanders,
    command_zone_kind: zone.command_zone_kind,
    cards,
    computed_color_identity: zone.color_identity,
    version: 0,
    data_snapshot: deck?.data_snapshot ?? "",
    ...(companionId ? { companion: companionId } : {}),
  });
  const evaluateZone = (
    refs: readonly string[],
    kind: CommandZoneKind,
    path: string,
    target: ConstructionDiagnostic[],
  ): ConstructionZone => {
    const commanders = refs.map((ref, i) => resolve(ref, `${path}/commanders/${i}`, target));
    const zone: ConstructionZone = {
      commanders,
      command_zone_kind: kind,
      color_identity: commanderColorIdentity({ commanders }, (id) => index.getCard(id)),
      library_size: COMMANDER_DECK_SIZE - commanders.length,
    };
    const known = commanders.every((id) => index.getCard(id) !== null);
    const inventory = new Map(mandatory);
    for (const id of commanders) inventory.set(id, Math.max(inventory.get(id) ?? 0, 1));
    const library = [...inventory]
      .map(([oracle_id, qty]) => ({
        oracle_id,
        qty: qty - (commanders.includes(oracle_id) ? 1 : 0),
      }))
      .filter((e) => e.qty > 0);
    const mandatoryDeck = asDeck(zone, library);
    const declare = (
      code: string,
      severity: ConstructionDiagnostic["severity"],
      message: string,
      related: string[] = [],
    ): void => add(target, code, severity, path, message, related);
    if (known)
      for (const violation of validateCommander(mandatoryDeck, (id) => index.getCard(id)))
        declare(violation.rule, "conflict", violation.detail);
    else if (commanders.length !== (kind === "single" ? 1 : 2))
      declare(
        "MULTI_COMMANDER",
        "conflict",
        "The declared command-zone kind has the wrong number of commanders.",
      );
    const constraints = normalizedIntent?.hard?.commanders;
    for (const id of commanders) {
      if (excluded.has(id))
        declare("COMMANDER_EXCLUDED", "conflict", `Selected commander '${id}' is excluded.`, [
          "/intent/hard/excluded_cards",
        ]);
      if (constraints?.allowed && !constraints.allowed.includes(id))
        declare(
          "COMMANDER_NOT_ALLOWED",
          "conflict",
          `Selected commander '${id}' is outside the allowed list.`,
          ["/intent/hard/commanders/allowed"],
        );
      if (seedCounts.has(id))
        declare(
          "COMMANDER_LIBRARY_OVERLAP",
          "conflict",
          `Commander '${id}' also occurs in the library seed.`,
          ["/cards"],
        );
    }
    for (const id of constraints?.required ?? [])
      if (!commanders.includes(id))
        declare(
          "REQUIRED_COMMANDER_MISSING",
          "conflict",
          `Required commander '${id}' is absent from this complete command zone.`,
          ["/intent/hard/commanders/required"],
        );
    if (
      constraints?.color_identity &&
      zone.color_identity.some((c) => !constraints.color_identity?.includes(c))
    )
      declare(
        "COMMANDER_COLOR_CONFLICT",
        "conflict",
        "The command zone exceeds the declared color identity.",
        ["/intent/hard/commanders/color_identity"],
      );
    for (const [id] of inventory) {
      const card = index.getCard(id);
      if (card && !mandatory.has(id) && card.legalities.commander !== "legal")
        declare(
          card.legalities.commander ? "FORMAT_ILLEGAL" : "FORMAT_LEGALITY_UNKNOWN",
          card.legalities.commander ? "conflict" : "unresolved",
          `${card.name} has ${card.legalities.commander ?? "unknown"} Commander legality.`,
          ["/intent/hard/locked_cards"],
        );
    }
    if (known)
      for (const violation of checkColorIdentity(mandatoryDeck, (id) => index.getCard(id)))
        declare(violation.rule, "conflict", violation.detail, [
          "/intent/hard/locked_cards",
          "/strategy_dependencies",
        ]);
    if ([...inventory.values()].reduce((a, b) => a + b, 0) > COMMANDER_DECK_SIZE)
      declare(
        "MANDATORY_QUANTITY_EXCEEDS_DECK",
        "conflict",
        "Commanders and mandatory library quantities exceed 100 cards.",
        ["/intent/hard/locked_cards", "/strategy_dependencies"],
      );
    for (const { path: rangePath, range } of ranges)
      if (range.min > zone.library_size) {
        add(
          target,
          "RANGE_EXCEEDS_LIBRARY",
          range.strength === "hard" ? "conflict" : "advisory",
          rangePath,
          `Minimum ${range.min} exceeds ${zone.library_size} library slots.`,
          [path],
        );
        if (range.strength === "preferred")
          relaxations.push({
            path: rangePath,
            reason: "Preferred minimum exceeds the available library slots.",
          });
      }
    if (request.lands?.strength === "hard") {
      const knownType = (card: Card | null): string | null => {
        if (!card || card.type_line.includes("//")) return null;
        if (card.gameplay)
          return card.gameplay.face_relationship === "single"
            ? card.gameplay.characteristics.type_line
            : null;
        return card.type_line || null;
      };
      if (library.some((e) => knownType(index.getCard(e.oracle_id)) === null))
        add(
          target,
          "LAND_CAPACITY_UNRESOLVED",
          "unresolved",
          "/lands",
          "Mandatory inventory has missing or multiface land characteristics; select a counting policy before enforcing this land range.",
          ["/intent/hard/locked_cards", "/strategy_dependencies"],
        );
      const lockedLands = library.reduce((sum, e) => {
        const type = knownType(index.getCard(e.oracle_id));
        return sum + (type && /\bLand\b/.test(type) ? e.qty : 0);
      }, 0);
      const lockedNonlands = library.reduce((sum, e) => {
        const type = knownType(index.getCard(e.oracle_id));
        return sum + (type && !/\bLand\b/.test(type) ? e.qty : 0);
      }, 0);
      if (lockedLands > request.lands.max || zone.library_size - lockedNonlands < request.lands.min)
        add(
          target,
          "LAND_CAPACITY_CONFLICT",
          "conflict",
          "/lands",
          "Mandatory cards leave no allocation satisfying the land range.",
          ["/intent/hard/locked_cards", "/strategy_dependencies", path],
        );
    }
    for (const role of ROLES) {
      const range = roles[role];
      if (!range || range.strength !== "hard") continue;
      const labeled = library.reduce((sum, e) => {
        const card = index.getCard(e.oracle_id);
        return (
          sum + (card && effectiveRoles(card, deck?.role_overrides).includes(role) ? e.qty : 0)
        );
      }, 0);
      const unfilled = zone.library_size - library.reduce((sum, e) => sum + e.qty, 0);
      if (labeled > range.max || labeled + unfilled < range.min)
        add(
          target,
          "ROLE_CAPACITY_UNRESOLVED",
          "unresolved",
          `/roles/${role}`,
          "Mandatory inventory cannot meet this hard range using current advisory role labels; correct role evidence or relax the constraint explicitly.",
          ["/intent/hard/locked_cards", "/strategy_dependencies"],
        );
    }
    if (companionId) {
      const card = index.getCard(companionId);
      if (card) {
        if (known && card.color_identity.some((c) => !zone.color_identity.includes(c)))
          add(
            target,
            "COMPANION_COLOR_IDENTITY",
            "conflict",
            "/companion",
            "The companion exceeds the command-zone color identity.",
            [path],
          );
        if (commanders.includes(companionId))
          add(
            target,
            "COMPANION_DECK_OVERLAP",
            "conflict",
            "/companion",
            "The declared companion must be separate from the starting deck.",
            ["/cards", "/intent/hard/locked_cards", path],
          );
        if (
          companionRuleCoverage(card) !== "supported" ||
          (card.name !== "Yorion, Sky Nomad" &&
            [...inventory.keys()].some((id) => {
              const starting = index.getCard(id);
              return (
                starting &&
                (/\bchangeling\b/i.test(starting.oracle_text) ||
                  starting.type_line.includes("//") ||
                  (starting.gameplay?.faces?.length ?? 0) > 1 ||
                  (starting.gameplay &&
                    (starting.gameplay.face_relationship !== "single" ||
                      starting.gameplay.characteristics.cmc === null ||
                      starting.gameplay.characteristics.mana_cost === null ||
                      starting.gameplay.characteristics.type_line === null ||
                      starting.gameplay.characteristics.oracle_text === null)))
              );
            }))
        )
          add(
            target,
            "COMPANION_CONDITION_UNRESOLVED",
            "unresolved",
            "/companion",
            "This companion condition lacks an exact evaluator.",
          );
        else
          for (const violation of validateCompanion(mandatoryDeck, (id) => index.getCard(id)))
            add(target, violation.rule, "conflict", "/companion", violation.detail, [
              path,
              "/intent/hard/locked_cards",
            ]);
      }
    }
    let forcedRemovals = 0;
    for (const [id, qty] of seedCounts) {
      const card = index.getCard(id);
      const incompatible =
        excluded.has(id) ||
        (card &&
          ((card.legalities.commander !== undefined && card.legalities.commander !== "legal") ||
            (known && card.color_identity.some((c) => !zone.color_identity.includes(c)))));
      if (incompatible) forcedRemovals += qty;
      else if (card) forcedRemovals += Math.max(0, qty - (copyLimit(card) ?? qty));
    }
    const lockedMissing = library.reduce(
      (sum, e) => sum + Math.max(0, e.qty - (seedCounts.get(e.oracle_id) ?? 0)),
      0,
    );
    const delta = zone.library_size - seedTotal;
    const additions = Math.max(0, lockedMissing, delta + forcedRemovals);
    const removals = Math.max(0, forcedRemovals, additions - delta);
    const zoneAdditions = deck
      ? commanders.filter((id) => !deck.commanders.includes(id)).length
      : 0;
    const zoneRemovals = deck ? deck.commanders.filter((id) => !commanders.includes(id)).length : 0;
    const companionAdditions = deck && companionId && companionId !== deck.companion ? 1 : 0;
    const companionRemovals = deck?.companion && deck.companion !== companionId ? 1 : 0;
    const totalAdditions = additions + zoneAdditions + companionAdditions;
    const totalRemovals = removals + zoneRemovals + companionRemovals;
    for (const [key, minimum] of [
      ["max_additions", totalAdditions],
      ["max_removals", totalRemovals],
      ["max_changes", totalAdditions + totalRemovals],
    ] as const) {
      const limit = editBounds[key];
      if (limit !== undefined && minimum > limit)
        add(
          target,
          "EDIT_BOUND_IMPOSSIBLE",
          "conflict",
          `/edit_bounds/${key}`,
          `At least ${minimum} card-copy ${key === "max_changes" ? "edits" : key === "max_additions" ? "additions" : "removals"} are required; the maximum is ${limit}.`,
          ["/cards", path, "/intent/hard/change_limit"],
        );
    }
    if (budget.mode === "cap" && budget.usd !== null) {
      const pricedInventory = new Map(inventory);
      if (budget.include_companion && companionId) pricedInventory.set(companionId, 1);
      const plan = budgetPlan(
        [...pricedInventory].map(([oracle_id, qty]) => ({ oracle_id, qty })),
        (id) => index.getCard(id),
        { targetUsd: budget.usd },
      );
      if (plan.minor_units.min_buy > Math.round(budget.usd * 100))
        add(
          target,
          "BUDGET_CAP_CONFLICT",
          "conflict",
          "/budget",
          `Observed mandatory-card price floor $${plan.min_buy_usd.toFixed(2)} exceeds the $${budget.usd.toFixed(2)} cap.`,
          [path, "/intent/hard/locked_cards", "/strategy_dependencies"],
        );
      else if (!plan.coverage.min_buy.complete)
        add(
          target,
          "BUDGET_PRICE_UNKNOWN",
          "unresolved",
          "/budget",
          "Mandatory-card price coverage is incomplete; missing prices cannot establish cap feasibility.",
          [path, "/intent/hard/locked_cards"],
        );
    }
    return zone;
  };
  const alternatives: ConstructionResult["specification"]["command_zone_alternatives"] = [];
  for (const [i, alternative] of (request.command_zone_alternatives ?? []).entries()) {
    const local: ConstructionDiagnostic[] = [];
    const zone = evaluateZone(
      alternative.commanders,
      alternative.command_zone_kind,
      `/command_zone_alternatives/${i}`,
      local,
    );
    alternatives.push({
      zone,
      status: local.some((d) => d.severity === "conflict")
        ? "invalid"
        : local.some((d) => d.severity === "unresolved")
          ? "unresolved"
          : "valid",
      diagnostics: local,
    });
  }
  const selectedRefs = request.commanders ?? (alternatives.length ? undefined : deck?.commanders);
  const selectedKind =
    request.command_zone_kind ??
    (request.commanders
      ? request.commanders.length === 1
        ? "single"
        : undefined
      : deck?.command_zone_kind);
  const requestedZone =
    selectedRefs || request.command_zone_kind
      ? {
          commanders: (selectedRefs ?? []).map((ref, i) => resolve(ref, `/commanders/${i}`)),
          command_zone_kind: selectedKind ?? null,
        }
      : null;
  let selected: ConstructionZone | null = null;
  if (selectedRefs?.length && selectedKind)
    selected = evaluateZone(selectedRefs, selectedKind, "/command_zone", diagnostics);
  else if (selectedRefs?.length)
    choices.push({
      id: "command_zone_kind",
      path: "/command_zone_kind",
      reason: "Choose the multi-commander rule governing the supplied command zone.",
      options: ["partner", "background", "doctor_companion"].map((value) => ({
        value,
        label: value,
      })),
    });
  if (alternatives.length) {
    if (request.commanders?.length || request.command_zone_kind)
      add(
        diagnostics,
        "COMMAND_ZONE_INPUT_CONFLICT",
        "conflict",
        "/command_zone_alternatives",
        "Provide either a selected command zone or alternatives requiring selection.",
        ["/commanders", "/command_zone_kind"],
      );
    const available = alternatives.filter((a) => a.status !== "invalid");
    if (!available.length)
      add(
        diagnostics,
        "NO_VALID_COMMAND_ZONE",
        "conflict",
        "/command_zone_alternatives",
        "Every proposed complete command zone conflicts with a declared constraint.",
      );
    else
      choices.push({
        id: "command_zone",
        path: "/command_zone_alternatives",
        reason: "Select a complete command-zone option; none has been chosen automatically.",
        options: available.map((a) => ({
          value: { commanders: a.zone.commanders, command_zone_kind: a.zone.command_zone_kind },
          label: a.zone.commanders.map((id) => index.getCard(id)?.name ?? id).join(" + "),
        })),
      });
  } else if (!selectedRefs?.length)
    choices.push({
      id: "commander",
      path: "/commanders",
      reason: "Choose a legal commander or provide complete command-zone alternatives.",
      options: [],
    });
  return {
    schema_version: 1,
    status: diagnostics.some((d) => d.severity === "conflict")
      ? "conflict"
      : choices.length ||
          diagnostics.some((d) => d.severity === "unresolved") ||
          unresolved.some((r) => r.strength === "hard")
        ? "needs_choices"
        : "ready",
    specification: {
      schema_version: 1,
      format: "commander",
      source,
      command_zone: selected,
      requested_command_zone: requestedZone,
      role_overrides: structuredClone(deck?.role_overrides ?? {}),
      command_zone_alternatives: alternatives,
      companion,
      theme: request.theme ?? null,
      seed_cards: seed,
      card_accounting: {
        deck_size: 100,
        command_zone_quantity: selected?.commanders.length ?? null,
        library_size: selected?.library_size ?? null,
        seed_library_quantity: seedTotal,
        companion_quantity: companion ? 1 : 0,
        role_memberships_overlap: true,
      },
      intent: normalizedIntent,
      budget,
      lands: structuredClone(request.lands ?? null),
      roles,
      requirements,
      strategy_dependencies: dependencies,
      edit_bounds: editBounds,
      preferred_relaxations: relaxations,
    },
    diagnostics,
    choices,
    unresolved_requirements: unresolved,
  };
}
