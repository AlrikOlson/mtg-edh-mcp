/** Local, evidence-bearing card additions. Scores are comparative heuristics, not win rates. */
import { z } from "zod";
import type { CardIndex } from "../index/index.js";
import { effectiveRoleTargets } from "../deck/intent.js";
import {
  compilePlaygroupPolicy,
  evaluatePlaygroupPolicy,
  type PolicyEvidence,
} from "../meta/playgroupPolicy.js";
import {
  StructuredError,
  MECHANICS_EXTRACTOR_VERSION,
  type Card,
  type Deck,
  type Role,
} from "../types/index.js";
import { validateCompanion } from "../validate/companionRules.js";
import { commanderColorIdentity, validateCommander } from "../validate/commanderRules.js";
import { discover, DISCOVERY_THEMES } from "./discovery.js";
import { effectiveRoles, roleEvidence } from "./deckRoles.js";
import { extractMechanics } from "./mechanics.js";
import { cheapestUsdCents } from "./pricing.js";
import { analyzeStrategy, candidateStrategySupport, STRATEGY_VERSION } from "./strategy.js";

export const RECOMMENDATION_VERSION = "1.0.0";
export const RecommendationOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    exclude_lands: z.boolean().default(true),
    oracle_query: z.string().trim().min(1).max(2000).optional(),
    theme: z.string().trim().min(1).max(200).optional(),
    scan_limit: z.number().int().min(1).max(100000).default(50000),
  })
  .strict();
export type RecommendationOptions = z.input<typeof RecommendationOptionsSchema>;
type Support = ReturnType<typeof candidateStrategySupport>;
export interface RoleDeficit {
  role: Role;
  have: number;
  minimum: number;
  maximum: number;
  target_source: "declared" | "default";
  role_source: "user_override" | "classifier";
}
export interface Recommendation {
  oracle_id: string;
  name: string;
  score: number;
  rationale: string;
  score_breakdown: Record<string, number>;
  evidence: {
    strategy_links: Support["links"];
    candidate_requirements: Support["requirements"];
    role_deficits: RoleDeficit[];
    theme_matches: ReturnType<typeof extractMechanics>["annotations"];
    preferences: Array<{
      kind: "favorite" | "locked_requirement";
      requested_quantity: number;
      path: string;
    }>;
    query: { query: string; oracle_id: string } | null;
    policy_findings: ReturnType<typeof evaluatePlaygroupPolicy>["findings"];
  };
  uncertainty: string[];
  tradeoffs: string[];
  budget_impact: {
    basis: "cheapest_installed_usd_printing";
    candidate_usd: number | null;
    known_deck_usd: number;
    estimated_total_usd: number | null;
    unpriced_existing_quantity: number;
    spend_target_usd: number | null;
    status: "unknown" | "above_target" | "within_target" | "not_declared";
  };
  coverage: {
    strategy_link_count: number;
    strategy_links_truncated: boolean;
    candidate_annotations: number;
    candidate_annotations_truncated: boolean;
    candidate_unmodeled_spans: number;
    provider_search_complete: boolean;
  };
}
const compare = (a: Recommendation, b: Recommendation) =>
  b.score - a.score || a.name.localeCompare(b.name) || a.oracle_id.localeCompare(b.oracle_id);
const isLand = (card: Card) => /\bLand\b/.test(card.type_line);

/** Shared prospective gate for contextual and explicit provider-profile modes.
 * Unknown policy/companion capabilities remain reviewable, never treated as passes. */
export function createRecommendationAdditionChecker(index: CardIndex, deck: Deck) {
  const ids = new Set([
    ...deck.commanders,
    ...deck.cards.map((c) => c.oracle_id),
    ...(deck.companion ? [deck.companion] : []),
  ]);
  const cards = new Map([...ids].map((id) => [id, index.getCard(id)]));
  const lookup = (id: string) => cards.get(id) ?? null;
  const policy = compilePlaygroupPolicy(deck.intent);
  const identity = commanderColorIdentity(deck, lookup);
  const commanderIssues = validateCommander(deck, lookup);
  const evidence: PolicyEvidence = {
    game_changers: {
      names: index.gameChangerNames() ?? new Set(),
      source: { kind: "installed_card_index", coverage: "observed_flags_only" },
      complete: false,
    },
    combos: {
      status: "not_checked",
      candidates: [],
      freshness: null,
      coverage: null,
      error: null,
    },
    data_snapshot: deck.data_snapshot,
  };
  const baseline = evaluatePlaygroupPolicy(deck, lookup, evidence);
  const protectedQuantities = (findings: typeof baseline.findings) =>
    new Map(
      findings
        .filter((finding) => finding.category === "locked_cards")
        .flatMap((finding) => finding.cards.map((card) => [card.oracle_id, card.qty] as const)),
    );
  const previousProtected = protectedQuantities(baseline.findings);
  const missingProtected = (quantities: Map<string, number>) =>
    (policy.construction.locked_cards ?? []).reduce(
      (sum, lock) => sum + Math.max(0, lock.qty - (quantities.get(lock.oracle_id) ?? 0)),
      0,
    );
  const missingBefore = missingProtected(previousProtected);
  return (card: Card) => {
    let reason: string | null = null;
    if (
      !deck.commanders.length ||
      commanderIssues.length ||
      deck.commanders.some((id) => lookup(id)?.legalities.commander !== "legal")
    )
      reason = "command_zone";
    else if (card.legalities.commander !== "legal") reason = "legality";
    else if (
      card.color_identity.some((color) => !identity.includes(color)) ||
      card.color_identity.some(
        (color) =>
          policy.construction.commanders?.color_identity &&
          !policy.construction.commanders.color_identity.includes(color),
      )
    )
      reason = "color_identity";
    else if (policy.construction.excluded_cards?.includes(card.oracle_id)) reason = "excluded_card";
    else if (ids.has(card.oracle_id)) reason = "already_in_deck";
    else if (policy.construction.change_limit === 0) reason = "change_limit";
    const prospective: Deck = {
      ...deck,
      cards: [...deck.cards, { oracle_id: card.oracle_id, qty: 1 }],
    };
    const candidateLookup = (id: string) => (id === card.oracle_id ? card : lookup(id));
    const companion_violations = reason ? [] : validateCompanion(prospective, candidateLookup);
    if (companion_violations.length) reason = "companion";
    const report =
      !reason && (deck.intent?.hard || deck.intent?.playgroup)
        ? evaluatePlaygroupPolicy(prospective, candidateLookup, evidence)
        : baseline;
    const prospectiveProtected = protectedQuantities(report.findings);
    const progressesLocks =
      missingProtected(prospectiveProtected) < missingBefore &&
      [...previousProtected].every(([id, qty]) => (prospectiveProtected.get(id) ?? 0) >= qty);
    const failures = report.findings.filter((finding) => finding.status === "fail");
    // Aspirational locks may need several additions. Permit measurable progress only;
    // every other failed constraint still blocks, and remaining locks stay failed evidence.
    if (
      !reason &&
      failures.some((finding) => finding.category !== "locked_cards" || !progressesLocks)
    )
      reason = "policy";
    // A one-card addition has an explicit baseline and edit count; replace the current-deck unknown.
    const policy_findings = report.findings.map((finding) =>
      finding.category === "change_limit"
        ? {
            ...finding,
            status: policy.construction.change_limit === 0 ? ("fail" as const) : ("pass" as const),
            reason: `One proposed card addition against the current deck requires 1 change; declared maximum ${policy.construction.change_limit}. No cumulative edit history or future cut is counted.`,
            observed_count: 1,
            limit: policy.construction.change_limit,
          }
        : finding,
    );
    const uncertainty = policy_findings
      .filter((finding) => finding.status === "unknown")
      .map((finding) => `Policy ${finding.category}: ${finding.reason}`);
    uncertainty.push(
      ...policy.unevaluated.map((value) => `Unevaluated intent ${value.path}: ${value.reason}`),
    );
    if (!reason && progressesLocks && failures.length)
      uncertainty.push(
        `This addition reduces missing protected quantity from ${missingBefore} to ${missingProtected(prospectiveProtected)}, but protected-card requirements remain unmet: ${failures.flatMap((finding) => finding.cards.map((card) => card.name ?? card.oracle_id)).join(", ")}. This is construction progress, not compliance with all declared constraints.`,
      );
    if (deck.companion)
      uncertainty.push(
        "Companion checks cover only the existing validator's supported conditions and known starting cards; an empty result does not certify an unknown companion or all gameplay characteristics.",
      );
    return {
      accepted: reason === null,
      reason,
      uncertainty,
      policy_findings,
      companion_violations,
    };
  };
}

/** Reuses one strategy graph and discovery's complete bounded scan. No network, edits, or provider popularity. */
export function recommendCards(index: CardIndex, deck: Deck, input: RecommendationOptions = {}) {
  const options = RecommendationOptionsSchema.parse(input);
  if (!deck.commanders.length)
    throw new StructuredError(
      "INELIGIBLE_COMMANDER",
      "Recommendations require a selected legal command zone.",
    );
  const inventory = new Map<string, number>(deck.commanders.map((id) => [id, 1]));
  for (const entry of deck.cards)
    inventory.set(entry.oracle_id, (inventory.get(entry.oracle_id) ?? 0) + entry.qty);
  const cards = new Map(
    [...inventory.keys(), ...(deck.companion ? [deck.companion] : [])].map((id) => [
      id,
      index.getCard(id),
    ]),
  );
  const lookup = (id: string) => cards.get(id) ?? null;
  const strategy = analyzeStrategy(deck, lookup);
  const dependencies = new Map(strategy.dependencies.map((d) => [d.id, d]));
  const targets = effectiveRoleTargets(deck);
  const counts = new Map<Role, number>();
  let nonlandQuantity = 0;
  let totalManaValue = 0;
  let expensiveQuantity = 0;
  let knownPriceCents = 0;
  let unpricedQuantity = 0;
  for (const [id, qty] of inventory) {
    const card = lookup(id);
    const price = card ? cheapestUsdCents(card) : null;
    if (price === null) unpricedQuantity += qty;
    else knownPriceCents += price * qty;
    if (!card) continue;
    for (const role of effectiveRoles(card, deck.role_overrides))
      counts.set(role, (counts.get(role) ?? 0) + qty);
  }
  // Library curve measures draw composition; command-zone access is a separate support signal.
  for (const entry of deck.cards) {
    const card = lookup(entry.oracle_id);
    if (!card || isLand(card)) continue;
    nonlandQuantity += entry.qty;
    totalManaValue += card.mv * entry.qty;
    if (card.mv >= 5) expensiveQuantity += entry.qty;
  }
  const averageManaValue = nonlandQuantity ? totalManaValue / nonlandQuantity : null;
  const policy = compilePlaygroupPolicy(deck.intent);
  const rawTheme = options.theme ?? deck.intent?.soft?.strategy;
  const themeKey = rawTheme?.trim().toLowerCase();
  const themePatterns = new Set(
    themeKey && Object.hasOwn(DISCOVERY_THEMES, themeKey) ? DISCOVERY_THEMES[themeKey] : [],
  );
  const theme = {
    requested: rawTheme ?? null,
    source: options.theme ? "request" : rawTheme ? "declared_strategy" : "none",
    status: !rawTheme ? "not_declared" : themePatterns.size ? "supported" : "unsupported",
    patterns: [...themePatterns],
    interpretation:
      "Only exact supported theme names add advisory annotation-match credit; arbitrary goals and prose are not translated into mechanical claims.",
  };
  const gameChangers = index.gameChangerNames();
  const policyEvidence: PolicyEvidence = {
    game_changers: {
      names: gameChangers ?? new Set(),
      source: { kind: "installed_card_index", coverage: "observed_flags_only" },
      complete: false,
    },
    combos: {
      status: "not_checked",
      candidates: [],
      freshness: null,
      coverage: null,
      error: null,
    },
    data_snapshot: deck.data_snapshot,
  };
  const baselinePolicy = evaluatePlaygroupPolicy(deck, lookup, policyEvidence);
  const checkAddition = createRecommendationAdditionChecker(index, deck);
  const requiresCut = [...inventory.values()].reduce((sum, qty) => sum + qty, 0) >= 100;
  const results: Recommendation[] = [];
  const policyFailures: Array<{
    oracle_id: string;
    findings: ReturnType<typeof evaluatePlaygroupPolicy>["findings"];
  }> = [];
  const companionFailures: Array<{
    oracle_id: string;
    violations: ReturnType<typeof validateCompanion>;
  }> = [];
  let totalScored = 0;
  const scanned = discover(
    index,
    {
      limit: Math.min(50, options.limit),
      scan_limit: options.scan_limit,
      ...(options.oracle_query ? { oracle_query: options.oracle_query } : {}),
    },
    deck,
    {
      score(card) {
        if (options.exclude_lands && isLand(card)) return { score: 0, exclusion: "land" };
        const eligibility = checkAddition(card);
        if (!eligibility.accepted) {
          if (eligibility.reason === "companion" && companionFailures.length < 20)
            companionFailures.push({
              oracle_id: card.oracle_id,
              violations: eligibility.companion_violations,
            });
          if (eligibility.reason === "policy" && policyFailures.length < 20)
            policyFailures.push({
              oracle_id: card.oracle_id,
              findings: eligibility.policy_findings.filter((finding) => finding.status === "fail"),
            });
          return { score: 0, exclusion: eligibility.reason ?? "policy" };
        }
        const mechanics = extractMechanics(card);
        const support = candidateStrategySupport(card, strategy, lookup, mechanics);
        const role = roleEvidence(card, deck.role_overrides);
        const deficits = role.effective_roles.flatMap((r): RoleDeficit[] => {
          const band = targets[r];
          const have = counts.get(r) ?? 0;
          return band && have < band.min
            ? [
                {
                  role: r,
                  have,
                  minimum: band.min,
                  maximum: band.max,
                  target_source: deck.intent?.soft?.role_targets?.[r] ? "declared" : "default",
                  role_source: role.role_source,
                },
              ]
            : [];
        });
        const themeMatches = mechanics.annotations
          .filter((a) => themePatterns.has(a.pattern_id))
          .slice(0, 8);
        const favorite = deck.intent?.soft?.favorites?.find((f) => f.oracle_id === card.oracle_id);
        const lock = deck.intent?.hard?.locked_cards?.find((f) => f.oracle_id === card.oracle_id);
        const breakdown = {
          commander_support: 0,
          library_support: 0,
          bottleneck_relief: 0,
          redundancy: 0,
          role_deficits: 0,
          declared_theme: 0,
          favorite: 0,
          locked_requirement: 0,
          query: 0,
          curve: 0,
          unmet_setup: 0,
          budget: 0,
        };
        const rationale: string[] = [];
        const tradeoffs: string[] = requiresCut
          ? [
              "The starting deck already has at least 100 cards; this addition requires a separately evaluated cut that preserves locked quantities and any change limit. No final legal 100-card deck is claimed.",
            ]
          : [];
        const uncertainty = [
          "Supported links are conditional possibilities. Access, complete costs, targets, timing, interaction and replacement effects are not simulated; no win, combo execution or success probability is established.",
          "Unsupported mechanics and incomplete source text may hide support. Role and theme evidence is advisory, not a mechanical link.",
        ];
        const outgoing = new Map(
          support.links
            .filter((link) => link.source === card.oracle_id && link.target !== card.oracle_id)
            .map((link) => [`${link.target}:${link.target_annotation}`, link]),
        );
        const incoming = new Map(
          support.links
            .filter((link) => link.target === card.oracle_id && link.source !== card.oracle_id)
            .map((link) => [`${link.source}:${link.target_annotation}`, link]),
        );
        const commanderIds = new Set<string>();
        const libraryIds = new Set<string>();
        for (const link of outgoing.values()) {
          (deck.commanders.includes(link.target) ? commanderIds : libraryIds).add(link.target);
          const dependency = dependencies.get(`${link.target}:${link.target_annotation}`);
          if (dependency?.status === "missing_local_support") breakdown.bottleneck_relief += 8;
          else if (dependency?.status === "single_source") breakdown.bottleneck_relief += 4;
          else if (dependency?.status === "redundant_sources") breakdown.redundancy += 1;
        }
        for (const link of incoming.values())
          (deck.commanders.includes(link.source) ? commanderIds : libraryIds).add(link.source);
        breakdown.commander_support = Math.min(16, commanderIds.size * 6);
        breakdown.library_support = Math.min(12, libraryIds.size * 3);
        breakdown.bottleneck_relief = Math.min(24, breakdown.bottleneck_relief);
        breakdown.redundancy = Math.min(3, breakdown.redundancy);
        if (outgoing.size || incoming.size) {
          const linkedIds = [...commanderIds, ...libraryIds];
          rationale.push(
            `Conditional support with ${linkedIds.map((id) => lookup(id)?.name ?? id).join(", ")}; ${outgoing.size} supplied deck requirements and ${incoming.size} incoming support links.`,
          );
        }
        if (breakdown.bottleneck_relief)
          rationale.push("Adds a distinct source for a missing or single-source local dependency.");
        if (breakdown.redundancy)
          tradeoffs.push(
            "Some supplied requirements already have multiple distinct sources; this adds redundancy rather than fixing a missing source.",
          );
        breakdown.role_deficits = Math.min(
          12,
          deficits.reduce(
            (sum, d) =>
              sum + (d.target_source === "declared" ? 5 : 3) + Math.min(3, d.minimum - d.have),
            0,
          ),
        );
        for (const d of deficits)
          rationale.push(
            `${d.role}: ${d.have} counted versus ${d.minimum} minimum (${d.target_source} target, ${d.role_source} role).`,
          );
        for (const r of role.effective_roles) {
          const band = targets[r];
          if (band && (counts.get(r) ?? 0) >= band.max)
            tradeoffs.push(
              `${r} already has ${counts.get(r)} cards against a maximum target of ${band.max}; another copy of this role has no deficit credit.`,
            );
        }
        breakdown.declared_theme = Math.min(
          4,
          new Set(themeMatches.map((a) => a.pattern_id)).size * 2,
        );
        if (themeMatches.length)
          rationale.push(
            `Matches supported annotations for declared theme '${rawTheme}'; this preference does not establish an interaction.`,
          );
        if (favorite) {
          breakdown.favorite = 3;
          rationale.push("Fulfills an explicit favorite preference.");
        }
        if (lock) {
          breakdown.locked_requirement = 8;
          rationale.push("Supplies a missing protected-card requirement.");
        }
        if (options.oracle_query) breakdown.query = 1;
        const missing = support.requirements.filter((r) => r.status === "missing_local_support");
        breakdown.unmet_setup = -Math.min(6, missing.length * 2);
        if (missing.length)
          tradeoffs.push(
            `${missing.length} modeled candidate requirements lack a matching local provider: ${missing.map((r) => r.annotation.evidence.text).join("; ")}.`,
          );
        const unmodeled = support.requirements.filter(
          (r) => r.status === "not_modeled" || r.status === "unknown_incomplete",
        );
        if (unmodeled.length)
          uncertainty.push(
            `${unmodeled.length} candidate requirements cannot be established by the local support model; see candidate_requirements.`,
          );
        if (support.requirements.some((r) => r.status === "self_support_only"))
          tradeoffs.push(
            "Some candidate requirements rely on another ability of this same physical card; that does not supply independent setup or redundancy.",
          );
        if (!isLand(card)) {
          breakdown.curve = card.mv >= 5 ? -2 : 0;
          if (card.mv >= 5 && nonlandQuantity && expensiveQuantity / nonlandQuantity >= 0.25)
            breakdown.curve -= 3;
          if (
            nonlandQuantity &&
            averageManaValue !== null &&
            card.mv < averageManaValue &&
            averageManaValue >= 3.5
          )
            breakdown.curve += 1;
          tradeoffs.push(
            `Mana value ${card.mv}; library nonland average ${averageManaValue === null ? "unknown (no known nonlands)" : averageManaValue.toFixed(2)}, with ${expensiveQuantity}/${nonlandQuantity} known nonlands at mana value 5+. Mana value does not establish casting turn or affordability.`,
          );
        }
        if (isLand(card))
          tradeoffs.push(
            `Adds a land slot to ${counts.get("land") ?? 0} counted lands. Its mana production, entry conditions and competition with land drops are not evaluated by the strategic-link score.`,
          );
        const price = cheapestUsdCents(card);
        const spendTarget = deck.intent?.soft?.spend_target_usd;
        const projected =
          price !== null && unpricedQuantity === 0 ? (knownPriceCents + price) / 100 : null;
        const budget: Recommendation["budget_impact"] = {
          basis: "cheapest_installed_usd_printing",
          candidate_usd: price === null ? null : price / 100,
          known_deck_usd: knownPriceCents / 100,
          estimated_total_usd: projected,
          unpriced_existing_quantity: unpricedQuantity,
          spend_target_usd: spendTarget ?? null,
          status:
            price === null || unpricedQuantity > 0
              ? "unknown"
              : spendTarget === undefined
                ? "not_declared"
                : (projected ?? 0) > spendTarget
                  ? "above_target"
                  : "within_target",
        };
        if (budget.status === "above_target") {
          breakdown.budget = -3;
          tradeoffs.push(
            `Known estimated total $${projected?.toFixed(2)} exceeds the advisory $${spendTarget} spend target.`,
          );
        }
        if (budget.status === "unknown")
          uncertainty.push(
            "Budget impact is unknown because one or more current or candidate cards lack an installed USD price; unknown prices are not treated as free.",
          );
        uncertainty.push(...eligibility.uncertainty);
        if (theme.status === "unsupported")
          uncertainty.push(
            `Declared theme '${rawTheme}' is unsupported; no mechanical alignment is inferred from it.`,
          );
        const linked = outgoing.size + incoming.size;
        const hasEvidence =
          linked > 0 ||
          deficits.length > 0 ||
          themeMatches.length > 0 ||
          !!favorite ||
          !!lock ||
          !!options.oracle_query;
        if (!hasEvidence) return { score: 0, exclusion: "no_contextual_evidence" };
        if (!linked)
          tradeoffs.push(
            "No supported mechanical link to the current command zone or library was established; preference, role, or query evidence alone does not establish synergy.",
          );
        if (!rationale.length)
          rationale.push(
            `Matches the explicit query '${options.oracle_query}'; local strategic contribution remains unknown.`,
          );
        const sum = Object.values(breakdown).reduce((a, b) => a + b, 0);
        const score = sum;
        const candidate: Recommendation = {
          oracle_id: card.oracle_id,
          name: card.name,
          score,
          rationale: rationale.join(" "),
          score_breakdown: breakdown,
          evidence: {
            strategy_links: support.links,
            candidate_requirements: support.requirements,
            role_deficits: deficits,
            theme_matches: themeMatches,
            preferences: [
              ...(favorite
                ? [
                    {
                      kind: "favorite" as const,
                      requested_quantity: favorite.qty,
                      path: "/soft/favorites",
                    },
                  ]
                : []),
              ...(lock
                ? [
                    {
                      kind: "locked_requirement" as const,
                      requested_quantity: lock.qty,
                      path: "/hard/locked_cards",
                    },
                  ]
                : []),
            ],
            query: options.oracle_query
              ? { query: options.oracle_query, oracle_id: card.oracle_id }
              : null,
            policy_findings: eligibility.policy_findings,
          },
          uncertainty: [...new Set(uncertainty)],
          tradeoffs,
          budget_impact: budget,
          coverage: {
            strategy_link_count: support.link_count,
            strategy_links_truncated: support.links_truncated,
            candidate_annotations: mechanics.annotations.length,
            candidate_annotations_truncated: mechanics.annotations.length > 32,
            candidate_unmodeled_spans: mechanics.unmodeled.length,
            provider_search_complete: support.provider_search_complete,
          },
        };
        totalScored += 1;
        results.push(candidate);
        results.sort(compare);
        if (results.length > options.limit) results.pop();
        return { score: score || Number.EPSILON };
      },
    },
  );
  return {
    suggestions: results,
    metadata: {
      recommendation_version: RECOMMENDATION_VERSION,
      extractor_version: MECHANICS_EXTRACTOR_VERSION,
      strategy_version: STRATEGY_VERSION,
      deck_id: deck.deck_id,
      deck_version: deck.version,
      deck_data_snapshot: deck.data_snapshot,
      source: "installed_card_index",
      recommendation_providers: "not_used",
      theme,
      score_semantics:
        "Deterministic, unnormalized comparative heuristic; may be negative. Component weights are capped. Not a deck-quality, popularity, win-rate, or power estimate.",
      command_zone: scanned.selected_command_zone,
      constraints: {
        mode: "one_card_addition",
        change_count: 1,
        change_limit: policy.construction.change_limit ?? null,
        construction: policy.construction,
        full_deck_validation: "not_performed",
        card_count:
          "Not a final 100-card validation or swap proposal; a full deck needs a separately reviewed cut.",
      },
      policy: {
        status: "partial",
        declared: policy.declared,
        baseline_findings: baselinePolicy.findings,
        unevaluated: policy.unevaluated,
        game_changers: "installed positive flags only; absence unverified",
        combos: "not_checked",
      },
      companion: {
        oracle_id: deck.companion ?? null,
        status: deck.companion ? "partial" : "not_declared",
      },
      curve: {
        known_library_nonlands: nonlandQuantity,
        average_mana_value: averageManaValue,
        at_least_five: expensiveQuantity,
      },
      role_counts: Object.fromEntries(counts),
      role_targets: targets,
    },
    exclusions: {
      ...scanned.exclusions,
      policy_failures: policyFailures,
      companion_failures: companionFailures,
    },
    coverage: {
      installed: scanned.installed,
      scanned: scanned.scanned,
      scored: totalScored,
      returned: results.length,
      scan_limit: options.scan_limit,
      scan_truncated: scanned.truncation.scan,
      results_truncated: totalScored > results.length,
      strategy: strategy.coverage,
    },
    limitations: [
      "Ranking covers the bounded installed scan only and may omit unsupported or unscanned good cards. Exact input and snapshot produce deterministic ordering.",
      "Strategic scoring uses the first 64 reported support links per candidate in bounded graph traversal order; later links contribute coverage counts only. When graph cards, annotations or links are truncated, ranking can depend on that bounded inventory order and omit later support.",
      "Each result evaluates a hypothetical addition of one card to the current deck. No deck mutation, cut selection, legality certification for the final 100, or cumulative edit history is implied.",
      "Heuristic role targets, declared favorites and themes remain advisory. Popularity and external recommendation services are not inputs.",
      "Provider-backed combo restrictions, unavailable Game Changer membership and free-text preferences remain unknown. Known policy failures exclude candidates except measurable progress on missing protected cards, which retains remaining failed requirements.",
      "Budget estimates use installed cheapest USD prices, exclude the outside-deck companion, and do not establish current market price or ownership costs.",
    ],
  };
}
export type RecommendationResult = ReturnType<typeof recommendCards>;
