/** Deterministic, bounded construction; only a validated whole deck is a found result. */
import { z } from "zod";
import { discover, DISCOVERY_THEMES } from "../analyze/discovery.js";
import { effectiveRoles } from "../analyze/deckRoles.js";
import { extractMechanics } from "../analyze/mechanics.js";
import { analyzeManaBase, DEFAULT_BANDS } from "../analyze/mana.js";
import { cheapestUsdCents } from "../analyze/pricing.js";
import { analyzeStrategy, candidateStrategySupport } from "../analyze/strategy.js";
import { copyLimit, normalizeConstruction } from "../deck/construction.js";
import { prepareDeckChange } from "../deck/deckPlan.js";
import type { CardIndex } from "../index/cardIndex.js";
import { ROLES, type Card } from "../types/card.js";
import type {
  ConstructionDiagnostic,
  ConstructionRequest,
  ConstructionResult,
} from "../types/construction.js";
import type { Deck, DeckCardEntry } from "../types/deck.js";
import type { DeckPlanRequest, DeckPlanValidation } from "../types/deckPlan.js";
import { validateCompanion } from "../validate/companionRules.js";
import { searchInventory, type BuildCandidate } from "./search.js";

export const CONSTRUCTION_VERSION = "1.0.0";
export const ConstructionSearchSchema = z
  .object({
    scan_limit: z.number().int().min(1).max(100000).default(50000),
    candidate_limit: z.number().int().min(1).max(2000).default(512),
    node_limit: z.number().int().min(1).max(100000).default(10000),
    branch_limit: z.number().int().min(1).max(16).default(4),
  })
  .strict();
export type ConstructionSearchOptions = z.input<typeof ConstructionSearchSchema>;
export interface ConstructionOptions {
  base?: Deck;
  dataSnapshot: string;
  name?: string;
  search?: ConstructionSearchOptions;
}
export interface ConstructionSearchReport {
  limits: z.output<typeof ConstructionSearchSchema>;
  installed: number;
  scan_scope: "inventory_stage";
  scanned: number;
  /** Discovery has its own per-stage scan and pairing bounds, separate from inventory expansions. */
  discovery: Pick<
    ReturnType<typeof discover>,
    "scanned" | "pair_checks" | "limits" | "truncation"
  > | null;
  candidates: number;
  zones_checked: number;
  nodes: number;
  completed_inventories: number;
  truncation: {
    scan: boolean;
    candidates: boolean;
    nodes: boolean;
    branches: boolean;
    zones: boolean;
  };
  exclusions: Record<string, number>;
  exhaustive: false;
}
export interface DeckConstructionResult {
  construction_version: string;
  status: "found" | "proven_conflict" | "search_exhausted";
  proposal: DeckPlanRequest | null;
  validation: DeckPlanValidation | null;
  normalization: ConstructionResult;
  diagnostics: ConstructionDiagnostic[];
  search: ConstructionSearchReport;
  source: {
    kind: "installed_card_index";
    data_snapshot: string;
    recommendation_providers: "not_used";
  };
  selection: { method: "selected" | "alternatives" | "theme_discovery"; considered_zones: number };
  explanations: {
    game_plan: ReturnType<typeof analyzeStrategy>["game_plan"];
    key_dependencies: ReturnType<typeof analyzeStrategy>["dependencies"];
    declared_dependencies: ConstructionRequest["strategy_dependencies"];
    mana_base: ReturnType<typeof analyzeManaBase> | null;
    preferred_relaxations: Array<{ path: string; reason: string }>;
    limitations: string[];
  };
}

const entries = (inventory: ReadonlyMap<string, number>): DeckCardEntry[] =>
  [...inventory]
    .filter(([, qty]) => qty > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([oracle_id, qty]) => ({ oracle_id, qty }));

/** Conservative characteristics match the exact desired-state validator. */
function landStatus(card: Card): boolean | null {
  if (card.type_line.includes("//")) return null;
  const type = card.gameplay
    ? card.gameplay.face_relationship === "single"
      ? card.gameplay.characteristics.type_line
      : null
    : card.type_line || null;
  return type === null ? null : /\bLand\b/.test(type);
}
function companionUnknown(card: Card): boolean {
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

/** A seed is editable inventory. Moving a seed card to its declared external zone is a repair. */
function normalizeForBuild(
  request: ConstructionRequest,
  index: CardIndex,
  base?: Deck,
): ConstructionResult {
  const original = normalizeConstruction(request, index, base);
  if (original.diagnostics.some((diagnostic) => diagnostic.code === "SAVED_SEED_OVERRIDE_CONFLICT"))
    return original;
  const spec = original.specification;
  const commanders = spec.command_zone?.commanders ?? [];
  const mandatory = new Set([
    ...(spec.intent?.hard?.locked_cards ?? []).map((entry) => entry.oracle_id),
    ...spec.strategy_dependencies
      .filter((dependency) => dependency.strength === "hard")
      .flatMap((dependency) => dependency.requires_cards ?? []),
  ]);
  const companion = spec.companion?.oracle_id;
  const removable = new Set([
    ...commanders,
    ...(companion && !mandatory.has(companion) && !commanders.includes(companion)
      ? [companion]
      : []),
  ]);
  const cards = spec.seed_cards.filter((entry) => !removable.has(entry.oracle_id));
  if (cards.length === spec.seed_cards.length) return original;
  const normalized = normalizeConstruction(
    { ...request, cards: base ? undefined : cards },
    index,
    base ? { ...base, cards } : undefined,
  );
  normalized.specification.seed_cards = spec.seed_cards;
  normalized.specification.card_accounting.seed_library_quantity =
    spec.card_accounting.seed_library_quantity;
  normalized.diagnostics.push({
    code: "SEED_ZONE_OVERLAP_REPAIR",
    severity: "advisory",
    path: "/cards",
    related_paths: ["/commanders", "/companion"],
    message:
      "Seed cards assigned to the command or companion zone are removed from the proposed library; exact zone edits remain subject to final validation.",
  });
  return normalized;
}

/** The synchronous read scope pins discovery, prices and final validation to one index image. */
export function constructDeck(
  request: ConstructionRequest,
  index: CardIndex,
  options: ConstructionOptions,
): DeckConstructionResult {
  return index.withRead(() => constructWithinRead(request, index, options));
}

function constructWithinRead(
  request: ConstructionRequest,
  index: CardIndex,
  options: ConstructionOptions,
): DeckConstructionResult {
  const limits = ConstructionSearchSchema.parse(options.search ?? {});
  const normalization = normalizeForBuild(request, index, options.base);
  const search: ConstructionSearchReport = {
    limits,
    installed: index.count(),
    scan_scope: "inventory_stage",
    scanned: 0,
    discovery: null,
    candidates: 0,
    zones_checked: 0,
    nodes: 0,
    completed_inventories: 0,
    truncation: { scan: false, candidates: false, nodes: false, branches: false, zones: false },
    exclusions: {},
    exhaustive: false,
  };
  const result: DeckConstructionResult = {
    construction_version: CONSTRUCTION_VERSION,
    status: "search_exhausted",
    proposal: null,
    validation: null,
    normalization,
    diagnostics: [...normalization.diagnostics],
    search,
    source: {
      kind: "installed_card_index",
      data_snapshot: options.dataSnapshot,
      recommendation_providers: "not_used",
    },
    selection: { method: "selected", considered_zones: 0 },
    explanations: {
      game_plan: [],
      key_dependencies: [],
      declared_dependencies: request.strategy_dependencies ?? [],
      mana_base: null,
      preferred_relaxations: [...normalization.specification.preferred_relaxations],
      limitations: [
        "Bounded beam search is heuristic; search_exhausted never proves infeasibility or optimality.",
        "Role labels, themes and strategy links rank candidates; they are not performance or win-rate claims.",
        "Mana reporting counts observed sources; castability, tapped timing, mulligans and opening-hand probabilities are not simulated.",
        "Prices are cheapest installed USD observations; freshness and market availability are not established.",
      ],
    },
  };
  if (
    normalization.status === "conflict" &&
    (!request.command_zone_alternatives?.length ||
      request.commanders?.length ||
      request.command_zone_kind)
  ) {
    result.status = "proven_conflict";
    return result;
  }
  let variants: ConstructionRequest[] = [request];
  if (!request.commanders?.length && request.command_zone_alternatives?.length) {
    result.selection.method = "alternatives";
    variants = request.command_zone_alternatives.map((zone) => ({
      ...request,
      command_zone_alternatives: undefined,
      commanders: zone.commanders,
      command_zone_kind: zone.command_zone_kind,
    }));
  } else if (
    !request.commanders?.length &&
    !options.base &&
    request.theme &&
    !request.command_zone_kind
  ) {
    result.selection.method = "theme_discovery";
    variants = [];
    if (Object.hasOwn(DISCOVERY_THEMES, request.theme.toLowerCase())) {
      const discovery = discover(index, {
        mode: "commanders",
        theme: request.theme,
        scan_limit: limits.scan_limit,
        pair_limit: limits.node_limit,
        limit: 30,
      });
      search.discovery = {
        scanned: discovery.scanned,
        pair_checks: discovery.pair_checks,
        limits: discovery.limits,
        truncation: discovery.truncation,
      };
      search.truncation.zones =
        discovery.truncation.results || discovery.truncation.pairs || discovery.truncation.scan;
      variants = discovery.results.flatMap((candidate) =>
        candidate.command_zone_kind
          ? [
              {
                ...request,
                commanders: candidate.cards.map((card) => card.oracle_id),
                command_zone_kind: candidate.command_zone_kind,
              },
            ]
          : [],
      );
    }
  }
  result.selection.considered_zones = variants.length;
  const evaluated = variants.map((variant) => ({
    request: variant,
    normalized: normalizeForBuild(variant, index, options.base),
  }));
  const ready = evaluated.filter(
    ({ normalized }) => normalized.status === "ready" && normalized.specification.command_zone,
  );
  if (!ready.length) {
    if (
      result.selection.method === "alternatives" &&
      evaluated.length &&
      evaluated.every(({ normalized }) => normalized.status === "conflict")
    )
      result.status = "proven_conflict";
    const diagnostics = new Map(
      result.diagnostics.map((diagnostic) => [JSON.stringify(diagnostic), diagnostic]),
    );
    for (const { normalized } of evaluated)
      for (const diagnostic of normalized.diagnostics)
        diagnostics.set(JSON.stringify(diagnostic), diagnostic);
    result.diagnostics = [...diagnostics.values()];
    result.diagnostics.push({
      code:
        result.selection.method === "theme_discovery" && !variants.length
          ? "CONSTRUCTION_THEME_UNRESOLVED"
          : "CONSTRUCTION_CHOICES_REQUIRED",
      severity: result.status === "proven_conflict" ? "conflict" : "unresolved",
      path: result.selection.method === "theme_discovery" ? "/theme" : "/request",
      related_paths: [],
      message:
        result.selection.method === "theme_discovery" && !variants.length
          ? "No supported installed command-zone match was found for this theme within the discovery bounds. Select exact commanders or supply supported complete alternatives."
          : "No command-zone option has ready constraints. Resolve the reported diagnostics and normalization choices before construction.",
    });
    return result;
  }
  // One bounded scan supplies every legal command-zone option, independent of providers.
  const installed: Card[] = [];
  let cursor: string | undefined;
  do {
    const page = index.evaluate(
      { kind: "and", clauses: [] },
      {
        limit: Math.min(175, limits.scan_limit - search.scanned),
        cursor,
        order: "name",
      },
    );
    for (const ref of page.results) {
      search.scanned += 1;
      const card = index.getCard(ref.oracle_id);
      if (card) installed.push(card);
    }
    cursor = page.nextCursor;
    if (search.scanned >= limits.scan_limit) break;
  } while (cursor);
  search.truncation.scan = Boolean(cursor);
  const excluded = (reason: string): void => {
    search.exclusions[reason] = (search.exclusions[reason] ?? 0) + 1;
  };
  for (const variant of ready) {
    if (search.nodes >= limits.node_limit) {
      search.truncation.nodes = true;
      break;
    }
    search.zones_checked += 1;
    const spec = variant.normalized.specification;
    const zone = spec.command_zone;
    if (!zone) continue;
    const blockedIds = new Set([
      ...zone.commanders,
      ...(spec.intent?.hard?.excluded_cards ?? []),
      ...(spec.companion ? [spec.companion.oracle_id] : []),
    ]);
    const mandatory = new Map<string, number>();
    for (const entry of spec.intent?.hard?.locked_cards ?? [])
      if (!zone.commanders.includes(entry.oracle_id)) mandatory.set(entry.oracle_id, entry.qty);
    for (const dependency of spec.strategy_dependencies)
      if (dependency.strength === "hard")
        for (const id of dependency.requires_cards ?? [])
          if (!zone.commanders.includes(id)) mandatory.set(id, Math.max(1, mandatory.get(id) ?? 0));
    const context: Deck = {
      deck_id: options.base?.deck_id ?? "construction",
      name: options.name ?? options.base?.name ?? "Constructed deck",
      format: "commander",
      commanders: zone.commanders,
      command_zone_kind: zone.command_zone_kind,
      cards: entries(mandatory),
      computed_color_identity: zone.color_identity,
      version: options.base?.version ?? 0,
      data_snapshot: options.dataSnapshot,
      ...(spec.companion ? { companion: spec.companion.oracle_id } : {}),
      ...(spec.intent ? { intent: spec.intent } : {}),
      ...(options.base?.role_overrides ? { role_overrides: options.base.role_overrides } : {}),
    };
    const graph = analyzeStrategy(context, (id) => index.getCard(id));
    const seed = new Map(spec.seed_cards.map((entry) => [entry.oracle_id, entry.qty]));
    const favorites = new Map(
      (spec.intent?.soft?.favorites ?? []).map((entry) => [entry.oracle_id, entry.qty]),
    );
    const theme = spec.theme?.toLowerCase();
    const themePatterns = new Set(
      theme && Object.hasOwn(DISCOVERY_THEMES, theme) ? DISCOVERY_THEMES[theme] : [],
    );
    const sourceCards = new Map(installed.map((card) => [card.oracle_id, card]));
    // Mandatory and seed IDs are direct indexed evidence even if the general scan was bounded.
    for (const id of [...mandatory.keys(), ...seed.keys(), ...favorites.keys()]) {
      const card = index.getCard(id);
      if (card) sourceCards.set(id, card);
    }
    const candidates: BuildCandidate[] = [];
    for (const card of sourceCards.values()) {
      if (blockedIds.has(card.oracle_id)) {
        excluded("excluded_or_other_zone");
        continue;
      }
      if (card.legalities.commander !== "legal") {
        excluded("format_legality");
        continue;
      }
      if (card.color_identity.some((color) => !zone.color_identity.includes(color))) {
        excluded("color_identity");
        continue;
      }
      const copies = copyLimit(card);
      if (copies === null) {
        excluded("copy_limit_unknown");
        continue;
      }
      const land = landStatus(card);
      if (land === null && spec.lands?.strength === "hard") {
        excluded("land_count_unknown");
        continue;
      }
      const price = cheapestUsdCents(card);
      if (price === null && spec.budget.mode === "cap") {
        excluded("budget_price_unknown");
        continue;
      }
      if (
        context.companion &&
        (companionUnknown(card) ||
          validateCompanion(
            { ...context, cards: [...context.cards, { oracle_id: card.oracle_id, qty: 1 }] },
            (id) => index.getCard(id),
          ).some((violation) => violation.severity === "error"))
      ) {
        excluded("companion");
        continue;
      }
      const mechanics = extractMechanics(card);
      const support = candidateStrategySupport(card, graph, (id) => index.getCard(id), mechanics);
      const themeMatches = new Set(
        mechanics.annotations
          .filter((annotation) => themePatterns.has(annotation.pattern_id))
          .map((annotation) => annotation.pattern_id),
      ).size;
      const roles = effectiveRoles(card, spec.role_overrides);
      const usefulRoles = roles.filter((role) => role !== "land" && role !== "utility").length;
      candidates.push({
        card,
        limit: copies,
        land: land ?? /\bLand\b/.test(card.type_line),
        roles,
        price,
        seed: seed.get(card.oracle_id) ?? 0,
        favorite: favorites.get(card.oracle_id) ?? 0,
        priority:
          Math.min(8, support.link_count) * 20 +
          themeMatches * 40 +
          usefulRoles * 3 -
          Math.min(card.mv, 10),
      });
    }
    const compare = (a: BuildCandidate, b: BuildCandidate): number =>
      Number(mandatory.has(b.card.oracle_id)) - Number(mandatory.has(a.card.oracle_id)) ||
      Number(b.seed > 0) - Number(a.seed > 0) ||
      Number(b.favorite > 0) - Number(a.favorite > 0) ||
      b.priority - a.priority ||
      (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER) ||
      a.card.oracle_id.localeCompare(b.card.oracle_id);
    candidates.sort(compare);
    // Reserve representation for cheap repeatable lands and each requested role before the global ranking.
    const retain = new Map<string, BuildCandidate>();
    const retainCard = (candidate: BuildCandidate | undefined): void => {
      if (candidate) retain.set(candidate.card.oracle_id, candidate);
    };
    for (const candidate of candidates)
      if (mandatory.has(candidate.card.oracle_id) || candidate.seed) retainCard(candidate);
    const byPrice = [...candidates].sort(
      (a, b) =>
        (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER) ||
        compare(a, b),
    );
    for (const color of [...zone.color_identity, "C"])
      retainCard(
        byPrice.find(
          (candidate) =>
            candidate.land &&
            candidate.limit > 1 &&
            (color === "C"
              ? candidate.card.color_identity.length === 0
              : candidate.card.color_identity.some((identity) => identity === color)),
        ),
      );
    for (const role of ROLES)
      if (spec.roles[role])
        for (const candidate of byPrice
          .filter((candidate) => candidate.roles.includes(role))
          .slice(0, spec.roles[role]?.min ?? 0))
          retainCard(candidate);
    for (const candidate of candidates) {
      if (retain.size >= limits.candidate_limit) break;
      retainCard(candidate);
    }
    const pool = [...retain.values()].slice(0, limits.candidate_limit).sort(compare);
    search.candidates = Math.max(search.candidates, pool.length);
    search.truncation.candidates ||= pool.length < candidates.length;
    const roleTargets = Object.fromEntries(
      ROLES.map((role) => [
        role,
        spec.roles[role] ?? {
          ...(DEFAULT_BANDS[role] ?? { min: 0, max: zone.library_size }),
          strength: "preferred" as const,
        },
      ]),
    );
    const found = searchInventory({
      request: variant.request,
      normalized: variant.normalized,
      context,
      mandatory,
      pool,
      roleTargets,
      index,
      options,
      search,
      validate(cards) {
        const proposal: DeckPlanRequest = {
          ...(options.name ? { name: options.name } : {}),
          request: { ...variant.request, cards },
        };
        const prepared = prepareDeckChange(proposal, index, options.base, options.dataSnapshot);
        search.completed_inventories += 1;
        result.validation = prepared.validation;
        if (!prepared.validation.valid) return null;
        return { proposal, ...prepared };
      },
    });
    if (found) {
      result.status = "found";
      result.proposal = found.proposal;
      result.validation = found.validation;
      result.normalization = variant.normalized;
      result.diagnostics = found.validation.diagnostics;
      const strategy = analyzeStrategy(found.desired, (id) => index.getCard(id));
      result.explanations.game_plan = strategy.game_plan;
      result.explanations.key_dependencies = strategy.dependencies;
      result.explanations.mana_base = analyzeManaBase(
        found.desired.cards,
        (id) => index.getCard(id),
        { identity: zone.color_identity },
      );
      result.explanations.preferred_relaxations = [
        ...variant.normalized.specification.preferred_relaxations,
        ...found.validation.diagnostics
          .filter((diagnostic) => diagnostic.severity === "advisory")
          .map((diagnostic) => ({ path: diagnostic.path, reason: diagnostic.message })),
      ];
      result.explanations.limitations.push(...strategy.limitations);
      return result;
    }
  }
  if (result.validation) result.diagnostics.push(...result.validation.diagnostics);
  result.diagnostics.push({
    code: "CONSTRUCTION_SEARCH_EXHAUSTED",
    severity: "unresolved",
    path: "/search",
    related_paths: [],
    message:
      "No complete validated deck was found within the disclosed candidate and search bounds. This is not an infeasibility proof.",
  });
  return result;
}
