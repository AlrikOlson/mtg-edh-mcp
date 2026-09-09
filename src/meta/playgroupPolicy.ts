/** Pure policy compilation and bounded evidence checks; never a power-rating engine. */
import type { DeckIntent } from "../deck/intent.js";
import type { PlaygroupPolicy } from "../deck/playgroupPolicy.js";
import type { Card, Deck } from "../types/index.js";
import { classifyBracket } from "./bracket.js";
import type { CacheFreshness } from "./cache.js";
import type { ComboApplicability } from "./comboApplicability.js";
import type { Combo, ComboResults } from "./spellbook.js";

export const PLAYGROUP_RULESET = {
  id: "commander-brackets-2025-10-21+game-changers-2026-02-09",
  sources: [
    "https://magic.wizards.com/en/news/announcements/introducing-commander-brackets-beta",
    "https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-october-21-2025",
    "https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-february-9-2026",
  ],
} as const;
type Category = keyof NonNullable<PlaygroupPolicy["limits"]>;
type Construction = NonNullable<DeckIntent["hard"]>;
interface RuleProvenance {
  kind: "official_bracket" | "custom" | "intent";
  path: string;
  ruleset?: typeof PLAYGROUP_RULESET.id;
  overrides?: { rule: string; max?: number };
}
interface PolicyCheck {
  category: Category;
  rule: string;
  max?: number;
  provenance: RuleProvenance;
}
export interface CompiledPlaygroupPolicy {
  declared: boolean;
  bracket: number | null;
  construction: Construction;
  checks: PolicyCheck[];
  preferences: NonNullable<DeckIntent["soft"]> & {
    profile?: PlaygroupPolicy["profile"];
    profile_goal?: string;
    bracket_goal?: string;
  };
  unevaluated: { path: string; value: unknown; reason: string }[];
}
export interface PolicyEvidence {
  game_changers: { names: ReadonlySet<string>; source: Record<string, unknown>; complete: boolean };
  combos: {
    status: "available" | "unavailable" | "not_checked";
    candidates: Array<Combo & { applicability: ComboApplicability }>;
    freshness: CacheFreshness | null;
    coverage: ComboResults["coverage"] | null;
    error: { code: string; message: string } | null;
  };
  data_snapshot: string;
}
interface PolicyCard {
  oracle_id: string;
  name: string | null;
  qty: number;
}
interface PolicyCombo {
  id: string;
  url: string;
  source_url: string;
  cards: string[];
  known_infinite: boolean;
  applicability: ComboApplicability;
  reasons: string[];
}
export interface PolicyFinding {
  id: string;
  category:
    | Category
    | "excluded_cards"
    | "locked_cards"
    | "commanders"
    | "policy_conflict"
    | "change_limit";
  status: "pass" | "fail" | "unknown";
  provenance: RuleProvenance;
  reason: string;
  cards: PolicyCard[];
  limit?: number;
  observed_count?: number;
  combo_candidates?: PolicyCombo[];
}
export interface PlaygroupPolicyReport {
  schema_version: 1;
  declared: boolean;
  status: "compatible" | "incompatible" | "unknown";
  policy: CompiledPlaygroupPolicy;
  findings: PolicyFinding[];
  unknown_oracle_ids: string[];
  evidence: {
    ruleset: typeof PLAYGROUP_RULESET;
    data_snapshot: string;
    game_changers: { source: Record<string, unknown>; complete: boolean };
    combos: Omit<PolicyEvidence["combos"], "candidates"> & {
      candidate_count: number;
      absence_confirmed: false;
    };
  };
  limitations: string[];
}
const PROFILE_GOALS = {
  casual: "Social play and the group's desired game experience; no implied bracket or card bans.",
  thematic: "Preserve the declared theme, strategy and favorite cards; no implied power ceiling.",
  competitive: "Optimize for competitive play as a declared goal; performance is not predicted.",
  custom: "Apply only the group's explicit constraints and preferences.",
};
const BRACKET_GOALS: Record<number, string> = {
  1: "Exhibition: prioritize theme and shared experience.",
  2: "Core: accessible, social games with time for decks to develop.",
  3: "Upgraded: stronger synergy with six turns generally played before finishing.",
  4: "Optimized: high-powered play without additional bracket card restrictions.",
  5: "cEDH: competitive metagame intent without additional bracket card restrictions.",
};

/** Explicit limits replace only their category; replaced official provenance survives. */
export function compilePlaygroupPolicy(intent: DeckIntent | undefined): CompiledPlaygroupPolicy {
  const declaration = intent?.playgroup;
  const bracket = declaration?.bracket ?? null;
  const checks = new Map<Category, PolicyCheck>();
  const official = (category: Category, rule: string, max?: number): void => {
    checks.set(category, {
      category,
      rule,
      ...(max === undefined ? {} : { max }),
      provenance: {
        kind: "official_bracket",
        path: "/playgroup/bracket",
        ruleset: PLAYGROUP_RULESET.id,
      },
    });
  };
  if (bracket !== null && bracket <= 3) {
    official("game_changers", "Game Changer card maximum", bracket === 3 ? 3 : 0);
    official("mass_land_denial", "No mass land denial", 0);
    official(
      "extra_turns",
      bracket === 1
        ? "No extra-turn cards"
        : "Low extra-turn quantities; no intended succession or loops",
      bracket === 1 ? 0 : undefined,
    );
    official(
      "infinite_combos",
      bracket === 3
        ? "No intentional early two-card infinite combos"
        : "No intentional two-card infinite combos",
    );
  }
  for (const [category, max] of Object.entries(declaration?.limits ?? {})) {
    // Enumerate schema keys rather than trusting an arbitrary cast from Object.entries.
    const key = (
      [
        "game_changers",
        "tutors",
        "fast_mana",
        "extra_turns",
        "mass_land_denial",
        "infinite_combos",
      ] as const
    ).find((value) => value === category);
    if (key === undefined || max === undefined) continue;
    const prior = checks.get(key);
    checks.set(key, {
      category: key,
      rule:
        key === "infinite_combos"
          ? "Maximum detected infinite packages with supported deck configuration"
          : "Custom category maximum",
      max,
      provenance: {
        kind: "custom",
        path: `/playgroup/limits/${key}`,
        ...(prior
          ? {
              overrides: {
                rule: prior.rule,
                ...(prior.max === undefined ? {} : { max: prior.max }),
              },
            }
          : {}),
      },
    });
  }
  const unevaluated: CompiledPlaygroupPolicy["unevaluated"] = [];
  const prose = (values: readonly string[] | undefined, path: string): void => {
    values?.forEach((value, i) =>
      unevaluated.push({
        path: `${path}/${i}`,
        value,
        reason: "Free text is retained for review; it is not an executable restriction.",
      }),
    );
  };
  prose(intent?.soft?.playgroup_preferences, "/soft/playgroup_preferences");
  prose(intent?.soft?.goals, "/soft/goals");
  prose(intent?.unsupported, "/unsupported");
  if (intent?.soft?.strategy)
    unevaluated.push({
      path: "/soft/strategy",
      value: intent.soft.strategy,
      reason: "Theme/strategy satisfaction needs human review.",
    });
  return {
    declared: declaration !== undefined,
    bracket,
    construction: structuredClone(intent?.hard ?? {}),
    checks: [...checks.values()],
    preferences: {
      ...structuredClone(intent?.soft ?? {}),
      ...(declaration?.profile
        ? { profile: declaration.profile, profile_goal: PROFILE_GOALS[declaration.profile] }
        : {}),
      ...(bracket === null ? {} : { bracket_goal: BRACKET_GOALS[bracket] }),
    },
    unevaluated,
  };
}

/** Canonical quantities: commander slots once, main duplicates aggregated, companion outside. */
function inventory(deck: Deck): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of deck.cards)
    if (!deck.commanders.includes(entry.oracle_id))
      counts.set(entry.oracle_id, (counts.get(entry.oracle_id) ?? 0) + entry.qty);
  for (const id of deck.commanders) counts.set(id, 1);
  return counts;
}
function knownInfinite(combo: Combo): boolean {
  return combo.outputs.some((output) => /^infinite\b/i.test(output.feature.name ?? ""));
}
function twoCard(combo: Combo): boolean {
  return (
    combo.uses.length > 0 &&
    combo.uses.every((entry) => entry.quantity !== null) &&
    combo.uses.reduce((n, entry) => n + (entry.quantity ?? 0), 0) === 2 &&
    combo.requires.length === 0
  );
}
/** Variants with the same canonical card quantities describe one ingredient package. */
function packageKey(combo: Combo & { applicability: ComboApplicability }): string | null {
  const quantities = new Map<string, number>();
  for (const [index, entry] of combo.uses.entries()) {
    const id = combo.applicability.ingredients[index]?.oracle_id ?? entry.card.oracle_id;
    if (id === null || entry.quantity === null) return null;
    quantities.set(id, (quantities.get(id) ?? 0) + entry.quantity);
  }
  return quantities.size > 0 && combo.requires.length === 0
    ? JSON.stringify([...quantities].sort(([a], [b]) => a.localeCompare(b)))
    : null;
}
function comboObservation(combo: Combo & { applicability: ComboApplicability }): PolicyCombo {
  return {
    id: combo.id,
    url: combo.url,
    source_url: combo.source_url,
    cards: [...combo.pieces],
    known_infinite: knownInfinite(combo),
    applicability: structuredClone(combo.applicability),
    reasons: [
      "Deck configuration checks do not establish setup, execution, intentionality or timing.",
      ...(knownInfinite(combo) ? [] : ["No explicit infinite outcome is available."]),
      ...combo.applicability.issues,
    ],
  };
}

/** Does not call providers, mutate the deck, infer gameplay intent, or certify heuristic misses. */
export function evaluatePlaygroupPolicy(
  deck: Deck,
  lookup: (id: string) => Card | null,
  evidence: PolicyEvidence,
): PlaygroupPolicyReport {
  const policy = compilePlaygroupPolicy(deck.intent);
  const counts = inventory(deck);
  const cards = [...counts].map(([oracle_id, qty]): PolicyCard => ({
    oracle_id,
    qty,
    name: lookup(oracle_id)?.name ?? null,
  }));
  const unknown = cards.filter((card) => card.name === null).map((card) => card.oracle_id);
  const findings: PolicyFinding[] = [];
  const hard = policy.construction;
  const addHard = (
    category: PolicyFinding["category"],
    path: string,
    status: PolicyFinding["status"],
    reason: string,
    involved: PolicyCard[] = [],
  ): void => {
    findings.push({
      id: `${category}:${findings.length}`,
      category,
      status,
      provenance: { kind: "intent", path },
      reason,
      cards: involved,
    });
  };
  const identify = (id: string): PolicyCard => ({
    oracle_id: id,
    name: lookup(id)?.name ?? null,
    qty: counts.get(id) ?? 0,
  });
  const excluded = new Set(hard.excluded_cards ?? []);
  if (hard.excluded_cards) {
    const present = cards.filter((card) => excluded.has(card.oracle_id));
    addHard(
      "excluded_cards",
      "/hard/excluded_cards",
      present.length ? "fail" : "pass",
      present.length
        ? "Excluded cards are present."
        : "No explicitly excluded identities are present.",
      present,
    );
  }
  for (const lock of hard.locked_cards ?? []) {
    const actual = identify(lock.oracle_id);
    addHard(
      "locked_cards",
      "/hard/locked_cards",
      actual.qty >= lock.qty ? "pass" : "fail",
      `Protected quantity requires at least ${lock.qty}; present ${actual.qty}.`,
      [actual],
    );
    if (excluded.has(lock.oracle_id))
      addHard("policy_conflict", "/hard", "fail", "A protected card is also excluded.", [actual]);
  }
  const required = hard.commanders?.required ?? [];
  const allowed = hard.commanders?.allowed;
  for (const id of required) {
    addHard(
      "commanders",
      "/hard/commanders/required",
      deck.commanders.includes(id) ? "pass" : "fail",
      "Required command-zone identity.",
      [identify(id)],
    );
    if (excluded.has(id) || (allowed && !allowed.includes(id)))
      addHard(
        "policy_conflict",
        "/hard/commanders",
        "fail",
        "Required commander conflicts with exclusions or allowed commanders.",
        [identify(id)],
      );
  }
  if (allowed) {
    const outside = deck.commanders.filter((id) => !allowed.includes(id));
    addHard(
      "commanders",
      "/hard/commanders/allowed",
      outside.length ? "fail" : "pass",
      "Current commanders checked against the explicit allowed list.",
      outside.map(identify),
    );
  }
  if (hard.commanders?.color_identity) {
    const declared = new Set(hard.commanders.color_identity);
    const identities = deck.commanders.map((id) => lookup(id)?.gameplay?.color_identity);
    const unresolved =
      identities.length === 0 ||
      identities.some((identity) => identity === null || identity === undefined);
    const outside = identities.some((identity) =>
      identity?.some((color) => ![...declared].some((permitted) => permitted === color)),
    );
    addHard(
      "commanders",
      "/hard/commanders/color_identity",
      outside ? "fail" : unresolved ? "unknown" : "pass",
      "Source commander identities must be subsets of the permitted color set; missing source identity is unknown.",
      deck.commanders.map(identify),
    );
  }
  if (hard.change_limit !== undefined)
    addHard(
      "change_limit",
      "/hard/change_limit",
      "unknown",
      "A change limit needs a proposed edit and baseline; this report checks the current deck only.",
    );

  // Reuse only category observations, never the bracket classifier's MV/turn proxies.
  const pushers = classifyBracket(deck, lookup, evidence.game_changers.names).pushers;
  const byCategory: Record<Exclude<Category, "infinite_combos">, Set<string>> = {
    game_changers: new Set(pushers.game_changers),
    tutors: new Set(pushers.tutors),
    fast_mana: new Set(pushers.fast_mana),
    extra_turns: new Set(pushers.extra_turns),
    mass_land_denial: new Set(pushers.mld),
  };
  // Explicit official examples cover these positives, not the full mass-land-denial definition.
  const documentedMld = new Set(["Armageddon", "Ruination", "Sunder", "Blood Moon", "Winter Orb"]);
  for (const card of cards)
    if (card.name !== null && documentedMld.has(card.name))
      byCategory.mass_land_denial.add(card.name);
  const combos = [
    ...new Map(evidence.combos.candidates.map((combo) => [combo.id, combo])).values(),
  ];
  for (const check of policy.checks) {
    if (check.category === "infinite_combos") {
      const candidates =
        check.provenance.kind === "official_bracket"
          ? combos.filter((combo) => knownInfinite(combo) && twoCard(combo))
          : combos;
      const supported =
        evidence.combos.status === "available"
          ? candidates.filter(
              (combo) =>
                knownInfinite(combo) && combo.applicability.deck_configuration === "satisfied",
            )
          : [];
      const packages = new Set(
        supported.map(packageKey).filter((key): key is string => key !== null),
      );
      const stale =
        evidence.combos.freshness?.status === "stale" ||
        evidence.combos.freshness?.refresh_failed === true;
      const violates = !stale && check.max !== undefined && packages.size > check.max;
      findings.push({
        id: `limit:${check.category}`,
        category: check.category,
        status: violates ? "fail" : "unknown",
        provenance: check.provenance,
        cards: [],
        ...(check.max === undefined ? {} : { limit: check.max }),
        observed_count: packages.size,
        combo_candidates: candidates.map(comboObservation),
        reason:
          check.provenance.kind === "official_bracket"
            ? `${check.rule}; intentionality${policy.bracket === 3 ? " and early timing" : ""} cannot be established from a card list. Mana value is not timing evidence. Provider coverage cannot establish absence.`
            : `${packages.size} distinct known infinite ingredient package(s) satisfy bounded deck-configuration checks; provider variants sharing canonical ingredient quantities count once. ${violates ? "The custom detected-package maximum is exceeded." : "Provider coverage cannot establish absence or compliance."} ${stale ? "Stale observations cannot establish a current limit violation." : ""} Setup and execution remain unknown.`,
      });
      continue;
    }
    const category = check.category;
    const matches = cards.filter(
      (card) => card.name !== null && byCategory[category].has(card.name),
    );
    const observed = matches.reduce((n, card) => n + card.qty, 0);
    const authoritative =
      category === "game_changers"
        ? observed
        : category === "mass_land_denial"
          ? matches
              .filter((card) => card.name !== null && documentedMld.has(card.name))
              .reduce((n, card) => n + card.qty, 0)
          : 0;
    const violates = check.max !== undefined && authoritative > check.max;
    const complete =
      category === "game_changers" && evidence.game_changers.complete && unknown.length === 0;
    const status = violates ? "fail" : complete ? "pass" : "unknown";
    findings.push({
      id: `limit:${category}`,
      category,
      status,
      provenance: check.provenance,
      cards: matches,
      ...(check.max === undefined ? {} : { limit: check.max }),
      observed_count: observed,
      reason:
        category === "game_changers"
          ? `${observed} observed Game Changer card(s) at the supplied snapshot. ${complete ? "Membership and card identity coverage are complete for this check." : "Membership absence is unproven; observed positives can establish a cap violation."}`
          : `${check.rule}. ${observed} category observation(s); role/Oracle-text heuristics are non-exhaustive and require review. ${category === "mass_land_denial" ? "Armageddon, Ruination, Sunder, Blood Moon and Winter Orb are documented official examples; other observations are heuristic." : ""} ${category === "extra_turns" && check.max === undefined ? "No official numeric cap; succession, loops and gameplay intent are unknown." : "Heuristic positives and misses do not certify category membership or absence."}`,
    });
    const protectedQuantities = new Map(
      (hard.locked_cards ?? []).map((lock) => [lock.oracle_id, lock.qty]),
    );
    for (const id of required)
      protectedQuantities.set(id, Math.max(1, protectedQuantities.get(id) ?? 0));
    const protectedMatches = [...protectedQuantities]
      .filter(([id]) => {
        const name = lookup(id)?.name;
        return (
          name !== undefined &&
          (category === "game_changers"
            ? evidence.game_changers.names.has(name)
            : category === "mass_land_denial" && documentedMld.has(name))
        );
      })
      .map(([id, qty]) => ({ ...identify(id), qty }));
    if (
      check.max !== undefined &&
      protectedMatches.reduce((n, card) => n + card.qty, 0) > check.max
    )
      addHard(
        "policy_conflict",
        "/hard",
        "fail",
        "The protected minimum exceeds the category maximum; these declarations cannot both be satisfied.",
        protectedMatches,
      );
  }
  const status = findings.some((finding) => finding.status === "fail")
    ? "incompatible"
    : !policy.declared ||
        findings.some((finding) => finding.status === "unknown") ||
        unknown.length > 0 ||
        policy.unevaluated.length > 0 ||
        (policy.checks.length === 0 && policy.bracket === null)
      ? "unknown"
      : "compatible";
  return {
    schema_version: 1,
    declared: policy.declared,
    status,
    policy,
    findings,
    unknown_oracle_ids: unknown,
    evidence: {
      ruleset: PLAYGROUP_RULESET,
      data_snapshot: evidence.data_snapshot,
      game_changers: {
        source: structuredClone(evidence.game_changers.source),
        complete: evidence.game_changers.complete,
      },
      combos: {
        status: evidence.combos.status,
        freshness: structuredClone(evidence.combos.freshness),
        coverage: structuredClone(evidence.combos.coverage),
        error: structuredClone(evidence.combos.error),
        candidate_count: combos.length,
        absence_confirmed: false,
      },
    },
    limitations: [
      "This is a check of declared restrictions, not a power rating, official matchmaking certification, or win-rate prediction.",
      "Profiles and bracket goals remain separate advisory intent; legality and card quality are outside this report.",
      "Tutor roles, fast-mana and extra-turn regexes, and mass-land-destruction patterns are non-exhaustive. Mass land denial also includes tapping, bounce, exile and mana-production changes; detected heuristic positives need review.",
      "Combo configuration does not establish intentionality, timing, setup or executability; an empty or partial provider result never proves no combos.",
      "Explicit category overrides are custom playgroup decisions; passing them does not establish compliance with the replaced official restriction.",
    ],
  };
}
