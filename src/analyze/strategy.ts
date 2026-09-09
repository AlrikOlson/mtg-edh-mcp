/** Offline, conservative support graph. Edges are possibilities backed by two
 * canonical annotations; they never establish a legal or executable sequence. */
import { effectiveRoleTargets } from "../deck/intent.js";
import type { Card, Deck, MechanicAnnotation } from "../types/index.js";
import { roleEvidence } from "./deckRoles.js";
import { extractMechanics } from "./mechanics.js";
import type { CardLookup } from "./stats.js";

export const STRATEGY_VERSION = "1.0.0";
export const STRATEGY_LIMITS = {
  cards: 250,
  annotations_per_card: 32,
  edges: 500,
  conflicts: 200,
  plan_edge_refs: 100,
} as const;
export const SUPPORTED_STRATEGY_EDGES = [
  {
    id: "token_sacrifice",
    theme: "Token sacrifice",
    description: "Compatible created tokens can supply a permanent sacrifice cost.",
  },
  {
    id: "token_tap",
    theme: "Token tapping",
    description: "Compatible created tokens can supply a permanent tapping cost.",
  },
  {
    id: "draw_trigger",
    theme: "Draw payoffs",
    description: "A draw effect can supply a matching player's draw event.",
  },
  {
    id: "lifegain_trigger",
    theme: "Lifegain payoffs",
    description: "A life gain effect can supply a matching player's life gain event.",
  },
  {
    id: "discard_trigger",
    theme: "Discard payoffs",
    description: "A discard effect or cost can supply a matching player's discard event.",
  },
  {
    id: "sacrifice_trigger",
    theme: "Sacrifice payoffs",
    description: "A compatible sacrifice cost or effect can supply a sacrifice event.",
  },
  {
    id: "death_trigger",
    theme: "Death payoffs",
    description:
      "A creature sacrifice can supply a matching death event, subject to zone replacements.",
  },
  {
    id: "token_trigger",
    theme: "Token payoffs",
    description: "A token effect can supply an unfiltered token-created event.",
  },
  {
    id: "graveyard_supply",
    theme: "Graveyard recovery",
    description: "Self mill or discard can supply unfiltered cards for graveyard use.",
  },
  {
    id: "counter_cost",
    theme: "Counter resources",
    description:
      "Matching counters placed on the consuming card can supply a counter removal cost.",
  },
] as const;
type EdgeKind = (typeof SUPPORTED_STRATEGY_EDGES)[number]["id"];
type Annotation = MechanicAnnotation;

export interface StrategyNode {
  oracle_id: string;
  name: string;
  quantity: number;
  zone: "command" | "library";
  mechanics: ReturnType<typeof extractMechanics>;
  roles: ReturnType<typeof roleEvidence>;
  locked_quantity: number;
  favorite_quantity: number;
}
export interface StrategyEdge {
  id: string;
  kind: EdgeKind;
  source: string;
  target: string;
  source_annotation: number;
  target_annotation: number;
  evidence: { source: Annotation; target: Annotation };
  status: "candidate_support";
  requirements: string[];
}
export interface StrategyDependency {
  id: string;
  oracle_id: string;
  annotation_index: number;
  resource: string;
  requirement: Annotation;
  provider_ids: string[];
  provider_quantity: number;
  status:
    | "missing_local_support"
    | "single_source"
    | "redundant_sources"
    | "not_modeled"
    | "unknown_incomplete";
  provider_search_complete: boolean;
  setup: "not_evaluated";
}

/** Only these simple filters are interpreted. Unknown adjectives, subtype,
 * state, color and mana-value restrictions deliberately suppress a match. */
function simpleTypes(phrase: string | null): string[] | null {
  const normalized = (phrase ?? "")
    .toLowerCase()
    .replace(/\byou control\b/g, "")
    .replace(/\b(?:a|an|another|target|one|two|three|\d+|untapped|card|cards)\b/g, "")
    .replace(/\b(creature|artifact|enchantment|land|permanent)s\b/g, "$1")
    .trim();
  if (!normalized) return [];
  const words = normalized.split(/\s+/);
  return words.every((word) =>
    ["creature", "artifact", "enchantment", "land", "permanent"].includes(word),
  )
    ? words
    : null;
}
function tokenTypes(a: Annotation): string[] {
  const text = (a.qualifier ?? "").toLowerCase();
  const types = ["creature", "artifact", "enchantment", "land"].filter((type) =>
    new RegExp(`\\b${type}\\b`).test(text),
  );
  // These standard predefined tokens are artifacts even when Oracle names only the token.
  if (/^(?:clue|treasure|food|blood|gold|powerstone|map)$/.test(text)) types.push("artifact");
  return types;
}
function typesFit(available: string[], required: string[] | null): boolean {
  return (
    required !== null && required.every((type) => type === "permanent" || available.includes(type))
  );
}
function compatibleSubject(source: Annotation["subject"], target: Annotation["subject"]): boolean {
  if (["unknown", "target_player", "any_player", "self"].includes(source)) return false;
  return (
    source === target ||
    target === "any_player" ||
    target === "each_player" ||
    (source === "each_player" && ["controller", "opponent"].includes(target))
  );
}
function cardTypes(card: Card, face: number | null): string[] {
  const typeLine =
    card.gameplay?.faces?.find((f) => f.face_index === face)?.characteristics.type_line ??
    card.type_line;
  return ["creature", "artifact", "enchantment", "land", "planeswalker", "battle"].filter((type) =>
    new RegExp(`\\b${type}\\b`, "i").test(typeLine),
  );
}
function sameAbility(a: Annotation, b: Annotation): boolean {
  return a.face_index === b.face_index && a.ability_index === b.ability_index;
}
function sourceRequirements(a: Annotation): string[] {
  const result = [
    "Both cards, relevant faces, costs, legal targets and timing must be available; game state is not evaluated.",
  ];
  if (a.ability_kind === "triggered")
    result.push(
      "The source effect requires its own trigger event and any setup before it supplies this resource.",
    );
  if (a.ability_kind === "activated")
    result.push(
      "The source activation requires all of its costs; repeatability and net resources are not established.",
    );
  if (a.condition.kind === "conditional")
    result.push(`Source condition: ${a.condition.text ?? "unknown"}`);
  if (a.optional) result.push("The source effect is optional.");
  return result;
}
/** Trigger qualifiers are deliberately lossy in the mechanics extractor. Match
 * complete event evidence so omitted subtypes or suffixes never become generic
 * creature/permanent requirements. The same predicate gates coverage status. */
function eventTypes(a: Annotation): string[] | null {
  if (a.category !== "trigger") return null;
  const text = a.evidence.text;
  if (a.kind === "dies") {
    const object =
      /^(?:when|whenever) (?:a|an|another|one or more) ((?:(?:artifact|enchantment) )?creatures?)(?: you control| an opponent controls)? (?:dies|die)$/i.exec(
        text,
      )?.[1];
    return object === undefined ? null : simpleTypes(object);
  }
  if (a.kind === "sacrifice") {
    const object =
      /^(?:when|whenever) (?:you|a player|an opponent|each player|each opponent) sacrifices? (?:a|an|another|one or more) ((?:(?:artifact|enchantment) )?(?:creature|permanent|artifact|enchantment|land)s?)(?: you control)?$/i.exec(
        text,
      )?.[1];
    return object === undefined ? null : simpleTypes(object);
  }
  return null;
}

/** Scalar event qualifiers omit thresholds and card restrictions too. Unknown
 * additions require a richer rules model and are not treated as generic events. */
function simpleScalarEvent(a: Annotation): boolean {
  if (a.category !== "trigger") return false;
  const actor = "(?:you|a player|an opponent|each player|each opponent)";
  const action =
    a.kind === "draw"
      ? "draws? (?:a|one|one or more) cards?"
      : a.kind === "discard"
        ? "discards? (?:a|one|one or more) cards?"
        : a.kind === "lifegain"
          ? "gains? life"
          : null;
  return (
    action !== null &&
    new RegExp(`^(?:when|whenever) ${actor} ${action}$`, "i").test(a.evidence.text)
  );
}

function matches(source: Card, a: Annotation, target: Card, b: Annotation): EdgeKind | null {
  if (source.oracle_id === target.oracle_id && (a.face_index !== b.face_index || sameAbility(a, b)))
    return null;
  if (a.category !== "effect" && a.category !== "cost") return null;
  if (a.kind === "create_token" && a.subject === "controller") {
    if (
      b.category === "cost" &&
      b.subject === "controller" &&
      typesFit(tokenTypes(a), simpleTypes(b.qualifier))
    ) {
      if (b.kind === "sacrifice_permanent") return "token_sacrifice";
      if (b.kind === "tap_permanent") return "token_tap";
    }
    // Token-created extractor qualifiers omit filters: only the literal unfiltered event is safe.
    if (
      b.kind === "token_created" &&
      b.category === "trigger" &&
      compatibleSubject(a.subject, b.subject) &&
      /^whenever you create (?:a|one or more) tokens?$/i.test(b.evidence.text)
    )
      return "token_trigger";
  }
  if (simpleScalarEvent(b) && compatibleSubject(a.subject, b.subject)) {
    if (a.kind === "draw_cards" && b.kind === "draw") return "draw_trigger";
    if (a.kind === "gain_life" && b.kind === "lifegain") return "lifegain_trigger";
    if (
      a.kind === "discard_cards" &&
      b.kind === "discard" &&
      simpleTypes(b.qualifier)?.length === 0
    )
      return "discard_trigger";
  }
  if (
    ["sacrifice_permanent", "sacrifice_self"].includes(a.kind) &&
    b.category === "trigger" &&
    compatibleSubject(a.subject === "self" ? "controller" : a.subject, b.subject)
  ) {
    if (
      a.kind === "sacrifice_self" &&
      source.oracle_id === target.oracle_id &&
      /\banother\b/i.test(b.evidence.text)
    )
      return null;
    const available =
      a.kind === "sacrifice_self" ? cardTypes(source, a.face_index) : simpleTypes(a.qualifier);
    const required = eventTypes(b);
    if (available !== null && typesFit(available, required)) {
      if (b.kind === "sacrifice") return "sacrifice_trigger";
      if (b.kind === "dies" && available.includes("creature")) return "death_trigger";
    }
  }
  if (
    ["mill", "discard_cards"].includes(a.kind) &&
    a.subject === "controller" &&
    ["return_from_graveyard", "exile_from_graveyard", "cast_from_graveyard"].includes(b.kind) &&
    b.subject === "controller" &&
    simpleTypes(b.qualifier)?.length === 0
  )
    return "graveyard_supply";
  if (
    ["put_counters", "enters_with_counters"].includes(a.kind) &&
    b.kind === "remove_counters" &&
    b.category === "cost" &&
    b.subject === "self" &&
    a.qualifier !== null &&
    a.qualifier.toLowerCase() === b.qualifier?.toLowerCase()
  ) {
    if (a.subject === "self")
      return source.oracle_id === target.oracle_id && a.face_index === b.face_index
        ? "counter_cost"
        : null;
    // A target phrase is absent from the extractor's counter qualifier; inspect its exact evidence.
    const on = /counters? on (.+?)(?=[,.]|$| for each| unless| if )/i.exec(a.evidence.text)?.[1];
    if (
      on &&
      /^(?:target|another target) (?:creature|artifact|permanent)(?: you control)?$/i.test(on) &&
      !(/another/i.test(on) && source.oracle_id === target.oracle_id) &&
      typesFit(cardTypes(target, b.face_index), simpleTypes(on))
    )
      return "counter_cost";
  }
  return null;
}
function resource(a: Annotation): string {
  if (a.kind === "sacrifice_permanent" || a.kind === "tap_permanent")
    return `permanents:${(simpleTypes(a.qualifier) ?? ["unmodeled_filter"]).join("+") || "any"}`;
  if (a.kind === "remove_counters") return `counters:${a.qualifier ?? "unknown"}`;
  if (["return_from_graveyard", "exile_from_graveyard", "cast_from_graveyard"].includes(a.kind))
    return `graveyard:${a.qualifier ?? "cards"}`;
  if (a.kind === "discard_cards") return "hand_cards";
  if (a.kind === "pay_life") return "life";
  if (a.kind === "mana") return `mana:${a.qualifier ?? "unknown"}`;
  return `${a.category}:${a.kind}`;
}
function modeledRequirement(a: Annotation): boolean {
  if (["unknown", "target_player", "self"].includes(a.subject) && a.kind !== "remove_counters")
    return false;
  if (a.category === "trigger") {
    if (["draw", "lifegain", "discard"].includes(a.kind)) return simpleScalarEvent(a);
    if (["sacrifice", "dies"].includes(a.kind)) return eventTypes(a) !== null;
    if (a.kind === "token_created")
      return /^whenever you create (?:a|one or more) tokens?$/i.test(a.evidence.text);
    return false;
  }
  if (["sacrifice_permanent", "tap_permanent"].includes(a.kind))
    return simpleTypes(a.qualifier) !== null;
  if (a.kind === "remove_counters") return a.subject === "self" && a.qualifier !== null;
  return (
    ["return_from_graveyard", "exile_from_graveyard", "cast_from_graveyard"].includes(a.kind) &&
    simpleTypes(a.qualifier)?.length === 0
  );
}

/** Candidate-only comparison reuses the graph's exact predicates and cached deck
 * annotations. It does not rebuild the deck graph for each installed card. */
export function candidateStrategySupport(
  card: Card,
  graph: ReturnType<typeof analyzeStrategy>,
  lookup: CardLookup,
  mechanics = extractMechanics(card),
) {
  const links: StrategyEdge[] = [];
  const providers = new Map<number, Set<string>>();
  let linkCount = 0;
  const compare = (
    source: Card,
    sourceAnnotations: readonly Annotation[],
    target: Card,
    targetAnnotations: readonly Annotation[],
  ) => {
    for (const [ai, a] of sourceAnnotations
      .slice(0, STRATEGY_LIMITS.annotations_per_card)
      .entries())
      for (const [bi, b] of targetAnnotations
        .slice(0, STRATEGY_LIMITS.annotations_per_card)
        .entries()) {
        const kind = matches(source, a, target, b);
        if (!kind) continue;
        linkCount += 1;
        if (target.oracle_id === card.oracle_id) {
          const ids = providers.get(bi) ?? new Set<string>();
          ids.add(source.oracle_id);
          providers.set(bi, ids);
        }
        if (links.length < 64)
          links.push({
            id: `${source.oracle_id}:${ai}>${target.oracle_id}:${bi}:${kind}`,
            kind,
            source: source.oracle_id,
            target: target.oracle_id,
            source_annotation: ai,
            target_annotation: bi,
            evidence: { source: a, target: b },
            status: "candidate_support",
            requirements: supportRequirements(a, b, kind, source.oracle_id === target.oracle_id),
          });
      }
  };
  for (const node of graph.nodes) {
    const existing = lookup(node.oracle_id);
    if (!existing) continue;
    compare(card, mechanics.annotations, existing, node.mechanics.annotations);
    compare(existing, node.mechanics.annotations, card, mechanics.annotations);
  }
  compare(card, mechanics.annotations, card, mechanics.annotations);
  const complete =
    graph.coverage.provider_search_complete &&
    mechanics.annotations.length <= STRATEGY_LIMITS.annotations_per_card;
  const requirements = mechanics.annotations
    .slice(0, STRATEGY_LIMITS.annotations_per_card)
    .flatMap((annotation, index) => {
      if (!isRequirement(annotation)) return [];
      const ids = [...(providers.get(index) ?? [])];
      return [
        {
          annotation,
          provider_ids: ids,
          status: ids.some((id) => id !== card.oracle_id)
            ? ("supported_by_deck" as const)
            : ids.length
              ? ("self_support_only" as const)
              : !modeledRequirement(annotation)
                ? ("not_modeled" as const)
                : complete
                  ? ("missing_local_support" as const)
                  : ("unknown_incomplete" as const),
        },
      ];
    });
  return {
    links,
    link_count: linkCount,
    links_truncated: links.length < linkCount,
    requirements,
    provider_search_complete: complete,
  };
}

function isRequirement(annotation: Annotation): boolean {
  return (
    annotation.category === "cost" ||
    annotation.category === "trigger" ||
    ["return_from_graveyard", "exile_from_graveyard", "cast_from_graveyard"].includes(
      annotation.kind,
    )
  );
}

function supportRequirements(
  a: Annotation,
  b: Annotation,
  kind: EdgeKind,
  self: boolean,
): string[] {
  const requirements = sourceRequirements(a);
  requirements.push(
    "The target ability's complete event, filters, thresholds and conditions still apply.",
  );
  if (b.condition.kind === "conditional")
    requirements.push(`Target condition: ${b.condition.text ?? "unknown"}`);
  if (self)
    requirements.push("Same-card abilities are dependent uses, not independent redundancy.");
  if (kind === "death_trigger")
    requirements.push(
      "The sacrificed creature must actually enter a graveyard; replacement effects may prevent dying.",
    );
  return requirements;
}

export function analyzeStrategy(deck: Deck, lookup: CardLookup) {
  const inventory = new Map<string, { quantity: number; zone: "command" | "library" }>();
  for (const id of deck.commanders) inventory.set(id, { quantity: 1, zone: "command" });
  for (const entry of deck.cards) {
    if (inventory.get(entry.oracle_id)?.zone === "command") continue;
    inventory.set(entry.oracle_id, {
      quantity: (inventory.get(entry.oracle_id)?.quantity ?? 0) + entry.qty,
      zone: "library",
    });
  }
  const cards = new Map<string, Card>();
  const nodes: StrategyNode[] = [];
  const missing: { oracle_id: string; quantity: number; zone: "command" | "library" }[] = [];
  const selectedInventory = [...inventory].slice(0, STRATEGY_LIMITS.cards);
  const skippedCards = inventory.size - selectedInventory.length;
  for (const [id, entry] of selectedInventory) {
    const card = lookup(id);
    if (!card) {
      missing.push({ oracle_id: id, ...entry });
      continue;
    }
    cards.set(id, card);
    nodes.push({
      oracle_id: id,
      name: card.name,
      ...entry,
      mechanics: extractMechanics(card),
      roles: roleEvidence(card, deck.role_overrides),
      locked_quantity: deck.intent?.hard?.locked_cards?.find((c) => c.oracle_id === id)?.qty ?? 0,
      favorite_quantity: deck.intent?.soft?.favorites?.find((c) => c.oracle_id === id)?.qty ?? 0,
    });
  }
  const edges: StrategyEdge[] = [];
  let edgeCount = 0;
  const graphAnnotationsSkipped = nodes.reduce(
    (sum, n) =>
      sum + Math.max(0, n.mechanics.annotations.length - STRATEGY_LIMITS.annotations_per_card),
    0,
  );
  const providerSearchComplete =
    skippedCards === 0 && graphAnnotationsSkipped === 0 && missing.length === 0;
  const providersByDependency = new Map<string, Set<string>>();
  const themeMatches = new Map<
    EdgeKind,
    { count: number; source_ids: Set<string>; target_ids: Set<string>; edge_ids: string[] }
  >();
  for (const source of nodes)
    for (const target of nodes) {
      const sourceCard = cards.get(source.oracle_id);
      const targetCard = cards.get(target.oracle_id);
      if (!sourceCard || !targetCard) continue;
      for (const [ai, a] of source.mechanics.annotations
        .slice(0, STRATEGY_LIMITS.annotations_per_card)
        .entries())
        for (const [bi, b] of target.mechanics.annotations
          .slice(0, STRATEGY_LIMITS.annotations_per_card)
          .entries()) {
          const kind = matches(sourceCard, a, targetCard, b);
          if (!kind) continue;
          const id = `${source.oracle_id}:${ai}>${target.oracle_id}:${bi}:${kind}`;
          edgeCount += 1;
          const key = `${target.oracle_id}:${bi}`;
          const providers = providersByDependency.get(key) ?? new Set<string>();
          providers.add(source.oracle_id);
          providersByDependency.set(key, providers);
          const motif = themeMatches.get(kind) ?? {
            count: 0,
            source_ids: new Set<string>(),
            target_ids: new Set<string>(),
            edge_ids: [],
          };
          motif.count += 1;
          motif.source_ids.add(source.oracle_id);
          motif.target_ids.add(target.oracle_id);
          if (
            motif.edge_ids.length < STRATEGY_LIMITS.plan_edge_refs &&
            edges.length < STRATEGY_LIMITS.edges
          )
            motif.edge_ids.push(id);
          themeMatches.set(kind, motif);
          if (edges.length >= STRATEGY_LIMITS.edges) continue;
          const requirements = supportRequirements(
            a,
            b,
            kind,
            source.oracle_id === target.oracle_id,
          );
          edges.push({
            id,
            kind,
            source: source.oracle_id,
            target: target.oracle_id,
            source_annotation: ai,
            target_annotation: bi,
            evidence: { source: a, target: b },
            status: "candidate_support",
            requirements,
          });
        }
    }
  const dependencies: StrategyDependency[] = [];
  for (const node of nodes)
    for (const [index, annotation] of node.mechanics.annotations
      .slice(0, STRATEGY_LIMITS.annotations_per_card)
      .entries()) {
      if (!isRequirement(annotation)) continue;
      const providers = [...(providersByDependency.get(`${node.oracle_id}:${index}`) ?? [])];
      const independent = providers.filter((id) => id !== node.oracle_id);
      const quantity = nodes
        .filter((n) => providers.includes(n.oracle_id))
        .reduce((sum, n) => sum + n.quantity, 0);
      const status =
        independent.length > 1
          ? "redundant_sources"
          : !modeledRequirement(annotation) && providers.length === 0
            ? "not_modeled"
            : !providerSearchComplete
              ? "unknown_incomplete"
              : providers.length
                ? "single_source"
                : "missing_local_support";
      dependencies.push({
        id: `${node.oracle_id}:${index}`,
        oracle_id: node.oracle_id,
        annotation_index: index,
        resource: resource(annotation),
        requirement: annotation,
        provider_ids: providers,
        provider_quantity: quantity,
        status,
        provider_search_complete: providerSearchComplete,
        setup: "not_evaluated",
      });
    }
  const bottlenecks = dependencies.filter(
    (d) => d.status === "single_source" || d.status === "missing_local_support",
  );
  const redundancy = dependencies.filter((d) => d.status === "redundant_sources");
  const conflicts: {
    kind: "possible_resource_competition";
    resource: string;
    consumer_ids: string[];
    dependency_ids: string[];
    provider_ids: string[];
    uncertainty: string;
  }[] = [];
  let conflictCount = 0;
  // Compare consumers only when a shared resource identity or actual shared provider is known.
  for (const [index, a] of dependencies.entries())
    for (const b of dependencies.slice(index + 1)) {
      if (
        a.oracle_id === b.oracle_id ||
        a.requirement.category === "trigger" ||
        b.requirement.category === "trigger"
      )
        continue;
      const shared = a.provider_ids.filter((id) => b.provider_ids.includes(id));
      if (
        shared.length === 0 &&
        (a.resource !== b.resource ||
          a.requirement.subject === "self" ||
          b.requirement.subject === "self" ||
          a.resource.includes("unmodeled_filter"))
      )
        continue;
      conflictCount += 1;
      if (conflicts.length >= STRATEGY_LIMITS.conflicts) continue;
      conflicts.push({
        kind: "possible_resource_competition",
        resource: a.resource === b.resource ? a.resource : `${a.resource} / ${b.resource}`,
        consumer_ids: [a.oracle_id, b.oracle_id],
        dependency_ids: [a.id, b.id],
        provider_ids: shared,
        uncertainty:
          "Costs may compete for the same finite resources. Timing, zones, usable quantities, replenishment and opportunity cost are not evaluated.",
      });
    }
  const recovery_options = nodes.flatMap((node) => {
    const recursion = node.mechanics.annotations.filter(
      (a) => a.kind === "return_from_graveyard" && a.subject === "controller",
    );
    const protection = node.roles.effective_roles.includes("protection");
    if (!recursion.length && !protection) return [];
    return [
      {
        oracle_id: node.oracle_id,
        kind: recursion.length ? "graveyard_recovery" : "role_based_protection",
        status: "candidate_not_verified" as const,
        evidence: recursion,
        roles: node.roles,
        candidate_for: [...new Set(bottlenecks.flatMap((b) => b.provider_ids))].filter(
          (id) =>
            id !== node.oracle_id &&
            (protection ||
              recursion.some((a) => {
                const c = cards.get(id);
                return c !== undefined && typesFit(cardTypes(c, 0), simpleTypes(a.qualifier));
              })),
        ),
        requirements: [
          "The lost card must be in a legal zone and match the full target restrictions; recovery costs and timing remain unknown.",
          "Protection role labels are advisory candidates and do not prove a specific protective interaction.",
        ],
      },
    ];
  });
  const win_condition_requirements = nodes.flatMap((node) => {
    const outcomes = node.mechanics.annotations.filter(
      (a) =>
        a.category === "effect" &&
        ((["lose_life", "mill"].includes(a.kind) &&
          ["opponent", "each_player"].includes(a.subject)) ||
          (a.kind === "deal_damage" &&
            (a.subject === "opponent" ||
              /any target|target player|each player/.test(a.qualifier ?? "")))),
    );
    const roleOnly = node.roles.effective_roles.includes("wincon") && outcomes.length === 0;
    if (!outcomes.length && !roleOnly) return [];
    return [
      {
        oracle_id: node.oracle_id,
        status: roleOnly ? ("role_only_unknown" as const) : ("candidate_not_verified" as const),
        outcomes,
        requirements: node.mechanics.annotations.filter(
          (a) =>
            (a.category === "cost" || a.category === "trigger") &&
            outcomes.some((outcome) => sameAbility(a, outcome)),
        ),
        dependency_ids: dependencies
          .filter(
            (d) =>
              d.oracle_id === node.oracle_id &&
              outcomes.some((outcome) => sameAbility(d.requirement, outcome)),
          )
          .map((d) => d.id),
        setup: "not_evaluated" as const,
        unknowns: [
          "Access, casting costs, legal targets, full event and ability conditions, damage/life/library totals and sufficient repetitions are unknown.",
          "An outcome is potential progress, not a demonstrated win or executable combo.",
          ...(roleOnly
            ? ["Only an advisory wincon role is available; no winning mechanic was extracted."]
            : []),
        ],
      },
    ];
  });
  const game_plan = SUPPORTED_STRATEGY_EDGES.flatMap((pattern) => {
    const motif = themeMatches.get(pattern.id);
    if (!motif) return [];
    const sourceIds = [...motif.source_ids];
    const targetIds = [...motif.target_ids];
    const ids = [...new Set([...sourceIds, ...targetIds])];
    return [
      {
        theme: pattern.theme,
        card_ids: ids,
        source_ids: sourceIds,
        consumer_ids: targetIds,
        edge_ids: motif.edge_ids,
        edge_count: motif.count,
        edge_refs_truncated: motif.edge_ids.length < motif.count,
        dependency_ids: dependencies
          .filter((d) => targetIds.includes(d.oracle_id))
          .map((d) => d.id),
        stages: [
          { action: "Establish sources and their unresolved setup", card_ids: sourceIds },
          { action: "Supply matching resources or events to these consumers", card_ids: targetIds },
        ],
        summary: `${pattern.theme}: ${ids.map((id) => cards.get(id)?.name ?? id).join(", ")}. ${pattern.description} This is conditional support; the stages describe dependencies, not an executable sequence.`,
      },
    ];
  });
  return {
    strategy_version: STRATEGY_VERSION,
    deck_id: deck.deck_id,
    deck_version: deck.version,
    nodes,
    edges,
    dependencies,
    bottlenecks,
    redundancy,
    recovery_options,
    conflicts,
    win_condition_requirements,
    game_plan,
    declared_intent: {
      intent: structuredClone(deck.intent ?? null),
      effective_role_targets: effectiveRoleTargets(deck),
      alignment: "not_evaluated" as const,
    },
    coverage: {
      limits: STRATEGY_LIMITS,
      inventory_distinct_cards: inventory.size,
      skipped_cards: skippedCards,
      graph_annotations_skipped: graphAnnotationsSkipped,
      analysis_truncated: skippedCards > 0 || graphAnnotationsSkipped > 0,
      provider_search_complete: providerSearchComplete,
      edge_count: edgeCount,
      returned_edge_count: edges.length,
      edges_truncated: edges.length < edgeCount,
      conflict_count: conflictCount,
      conflicts_truncated: conflicts.length < conflictCount,
      graph_unmodeled_requirements: dependencies.filter((d) => d.status === "not_modeled").length,
      known_cards: nodes.length,
      known_quantity: nodes.reduce((sum, n) => sum + n.quantity, 0),
      missing_cards: missing,
      annotated_cards: nodes.filter((n) => n.mechanics.annotations.length > 0).length,
      supported_annotations: nodes.reduce((sum, n) => sum + n.mechanics.annotations.length, 0),
      unmodeled_spans: nodes.reduce(
        (sum, n) => sum + n.mechanics.unmodeled.filter((s) => s.status === "unmodeled").length,
        0,
      ),
      uncertain_spans: nodes.reduce(
        (sum, n) => sum + n.mechanics.unmodeled.filter((s) => s.status === "uncertain").length,
        0,
      ),
      edge_catalog: SUPPORTED_STRATEGY_EDGES,
    },
    limitations: [
      "Offline annotation catalog, not a rules engine. Unsupported text and filters can hide support; missing_local_support does not prove a deck cannot function.",
      "Provider quantity counts physical cards, not activations, token yield, resource stock, draws or success probability. Redundancy requires distinct card identities and is still conditional.",
      "Dependencies do not establish independent setup. Connected paths and cycles never prove an infinite combo; no Commander Spellbook lookup or execution simulation is performed.",
      "Alternative faces share a physical card; cross-face self support is suppressed. Other face choices and simultaneous availability remain unknown.",
      "Game actions, combat routes, threshold requirements, interaction, replacement effects, targets, access and net resource balance are not simulated. A payoff is not a verified win.",
      "Declared goals, locks, favorites and role overrides remain user intent; free text and role labels never establish mechanical edges. Companion outside the deck is not analyzed.",
    ],
  };
}
