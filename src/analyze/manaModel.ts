/**
 * Conservative canonical mana model and a finite payment-witness checker.
 * Sources describe one physical card with alternative faces/output bundles.
 * This is neither a game engine nor a turn/probability/search simulator.
 */
import { z } from "zod";
import type { Card, CardCharacteristics, OracleTextEvidence } from "../types/card.js";
import type { Color } from "../types/color.js";
import type { DeckCardEntry } from "../types/deck.js";
import type { MechanicAnnotation } from "../types/mechanics.js";
import { oracleTextEvidence } from "../index/map.js";
import { extractMechanics } from "./mechanics.js";

export const MANA_MODEL_VERSION = 1;
export const MANA_TYPES = ["W", "U", "B", "R", "G", "C"] as const;
export type Mana = (typeof MANA_TYPES)[number];
export type ManaModelStatus = "supported" | "unsupported" | "overridden";
const isMana = (symbol: string): symbol is Mana => MANA_TYPES.some((m) => m === symbol);

export interface ManaCostModel {
  status: ManaModelStatus;
  kind: "mana" | "no_mana_cost" | "unknown";
  raw: string | null;
  generic: number;
  /** Colored requirements and true colorless requirements; duplicates are significant. */
  required: Mana[];
  symbols: string[];
  reasons: string[];
  evidence?: { field_path: string; value: string | null };
}

/** Empty source cost is absent, whereas {0} is a payable zero cost. */
export function parseManaCost(raw: string | null): ManaCostModel {
  const result: ManaCostModel = {
    status: "supported",
    kind: raw === null ? "unknown" : raw === "" ? "no_mana_cost" : "mana",
    raw,
    generic: 0,
    required: [],
    symbols: [],
    reasons: [],
  };
  if (raw === null) {
    result.status = "unsupported";
    result.reasons.push("Mana cost was not supplied.");
    return result;
  }
  if (raw === "") return result;
  if (raw.length > 500 || !/^(?:\{[^{}]+\})+$/.test(raw)) {
    result.status = "unsupported";
    result.reasons.push("Malformed or out-of-bounds mana cost.");
    return result;
  }
  result.symbols = Array.from(raw.matchAll(/\{([^{}]+)\}/g), (m) => m[1] ?? "");
  for (const symbol of result.symbols) {
    if (isMana(symbol)) result.required.push(symbol);
    else if (/^(?:0|[1-9]\d*)$/.test(symbol) && Number(symbol) <= 1000)
      result.generic += Number(symbol);
    else {
      result.status = "unsupported";
      result.reasons.push(`Unsupported mana symbol: {${symbol}}.`);
    }
  }
  if (result.generic > 1000 || result.required.length > 100) {
    result.status = "unsupported";
    result.reasons.push("Cost exceeds the bounded model limits.");
  }
  return result;
}

const supportedCostSchema = z
  .string()
  .max(500)
  .refine((raw) => {
    const parsed = parseManaCost(raw);
    return parsed.status === "supported" && parsed.kind === "mana";
  }, "Expected a bounded generic, colored or colorless mana cost.");

/** An explicit assumption replaces only one face's finite source/cost model. */
export const manaModelOverrideSchema = z
  .object({
    oracle_id: z.string().min(1).max(200),
    face_index: z.number().int().min(0).max(1),
    reason: z.string().trim().min(1).max(500),
    mana_cost: supportedCostSchema.optional(),
    source: z
      .object({
        outputs: z.array(z.array(z.enum(MANA_TYPES)).min(1).max(20)).max(20),
        activation_cost: supportedCostSchema,
        enters_tapped: z.boolean(),
        summoning_delay: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.source !== undefined || value.mana_cost !== undefined,
    "An override must specify source or mana_cost.",
  );
export type ManaModelOverride = z.infer<typeof manaModelOverrideSchema>;
export interface ManaModelOptions {
  identity?: readonly Color[];
  overrides?: readonly ManaModelOverride[];
}

export interface ManaSourceModel {
  status: ManaModelStatus;
  kind: "mana" | "fetch" | "none" | "unsupported";
  /** Outer entries are alternatives; every symbol in one inner entry is produced together. */
  outputs: Mana[][];
  activation_cost: ManaCostModel;
  tap: boolean;
  sacrifice_self: boolean;
  enters_tapped: boolean;
  summoning_delay: boolean;
  fetch?: { basic_only: true; destination: "battlefield"; enters_tapped: true };
  reasons: string[];
  evidence: OracleTextEvidence[];
  mechanics: MechanicAnnotation[];
  provenance: "canonical_oracle" | "basic_land_type_rule" | "caller_override" | "none";
  /** Retained unsupported conditions; these are evidence, never enforced rules. */
  restrictions: {
    status: "unsupported";
    kind: "spending_restriction" | "entry_condition" | "source_condition";
    evidence: OracleTextEvidence;
  }[];
  characteristic_evidence?: { field_path: string; value: string; rule: "CR 305.6" };
}
export interface ManaFaceModel {
  face_index: number;
  name: string | null;
  type_line: string | null;
  is_land: boolean;
  is_basic: boolean;
  cost: ManaCostModel;
  source: ManaSourceModel;
  assumptions: string[];
}
export interface CardManaModel {
  version: typeof MANA_MODEL_VERSION;
  oracle_id: string;
  name: string;
  status: ManaModelStatus;
  face_relationship: string;
  faces: ManaFaceModel[];
  reasons: string[];
  assumptions: string[];
}

const BASIC_MANA: readonly [string, Mana][] = [
  ["Plains", "W"],
  ["Island", "U"],
  ["Swamp", "B"],
  ["Mountain", "R"],
  ["Forest", "G"],
];
const MODEL_ASSUMPTIONS = [
  "Only canonical face facts and the declared bounded mana grammar are modeled; roles, color identity and produced_mana are not unconditional sources.",
  "Output bundles are alternatives per activation, and modal faces share one physical card. No probability, turn sequencing, legality or general rules simulation is performed.",
  "The witness checks a supplied single-turn action order with no external effects, replacement effects, cost changes, untap effects, haste or opponents. Battlefield readiness and initial mana are caller-supplied assumptions.",
];
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Unsupported payment/casting mechanisms are recognized from both source keywords
// and Oracle text. This catalog does not supply alternate payment rules.
const COST_CHANGE_KEYWORDS = new Set([
  "convoke",
  "delve",
  "improvise",
  "affinity",
  "undaunted",
  "assist",
  "kicker",
  "multikicker",
  "buyback",
  "replicate",
  "strive",
  "escalate",
  "conspire",
  "spree",
  "prototype",
  "suspend",
  "foretell",
  "plot",
  "emerge",
  "evoke",
  "bargain",
  "offspring",
  "casualty",
  "squad",
  "cleave",
  "mutate",
  "overload",
  "flashback",
  "bestow",
  "dash",
  "blitz",
  "escape",
  "madness",
  "miracle",
  "spectacle",
  "jump-start",
  "retrace",
  "disturb",
  "awaken",
  "surge",
  "prowl",
  "offering",
  "morph",
  "megamorph",
  "disguise",
  "ninjutsu",
  "commander ninjutsu",
  "unearth",
  "embalm",
  "eternalize",
]);
const COST_CHANGE = new RegExp(
  `\\b(?:rather than pay|without paying|additional cost|alternative cost|costs? (?:\\{|less|more)|${[...COST_CHANGE_KEYWORDS].join("|")})\\b`,
  "i",
);

function sourceModel(
  card: Card,
  characteristics: CardCharacteristics,
  faceIndex: number,
  sourcePath: string,
  options: ManaModelOptions,
  mechanics: readonly MechanicAnnotation[],
): ManaSourceModel {
  const oracle = characteristics.oracle_text;
  const type = characteristics.type_line;
  const source: ManaSourceModel = {
    status: "supported",
    kind: "none",
    outputs: [],
    activation_cost: parseManaCost("{0}"),
    tap: false,
    sacrifice_self: false,
    enters_tapped: false,
    summoning_delay: /\bCreature\b/.test(type ?? ""),
    reasons: [],
    evidence: [],
    restrictions: [],
    mechanics: mechanics.filter((a) => a.face_index === faceIndex),
    provenance: "none",
  };
  const evidence = oracleTextEvidence(card, faceIndex);
  if (evidence) source.evidence.push(evidence);
  const reject = (reason: string) => {
    source.status = "unsupported";
    source.kind = "unsupported";
    source.outputs = [];
    source.reasons.push(reason);
    return source;
  };
  if (oracle === null || type === null)
    return reject("Canonical Oracle text or type line was not supplied.");
  const isLand = /\bLand\b/.test(type);
  // Broad candidate detection is deliberate: unknown mana production, pool
  // manipulation and replacements must reach the closed grammar below. This can
  // conservatively exclude unrelated mana-value prose, never certify its rules.
  const sourceCandidate =
    isLand || /\b(?:mana|add)\b|search your library[^.\n]*land|untap[^.\n]*land/i.test(oracle);
  if (!sourceCandidate) return source;
  if (evidence) {
    if (/\bSpend this mana only\b/i.test(evidence.text))
      source.restrictions.push({ status: "unsupported", kind: "spending_restriction", evidence });
    if (
      /(?:\b[Aa]s .+ enters\b|\benters[^.\n]*\b(?:if|unless)\b|\b[Ii]f[^.\n]*\benters\b)/.test(
        evidence.text,
      )
    )
      source.restrictions.push({ status: "unsupported", kind: "entry_condition", evidence });
    if (/\b(?:could produce|[Aa]ctivate only|[Aa]s long as)\b/.test(evidence.text))
      source.restrictions.push({ status: "unsupported", kind: "source_condition", evidence });
  }

  const name = escapeRegex(characteristics.name ?? card.name);
  const self = `(?:${name}|[Tt]his (?:land|artifact|creature|permanent))`;
  const entry = new RegExp(`^${self} enters(?: the battlefield)? tapped\\.$`);
  const fetch = new RegExp(
    `^\\{T\\}, Sacrifice ${self}: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle\\.$`,
  );
  const lines = oracle
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let manaAbilityCount = 0;
  for (const line of lines) {
    // Only known mana reminder text is ignored; arbitrary parenthesized rules are not.
    if (/^\(\{T\}: Add (?:\{[WUBRGC]\}(?: or |, )?)+\.\)$/.test(line)) continue;
    if (/^(Flying|Reach|Vigilance|Defender)$/.test(line)) continue;
    if (entry.test(line)) {
      source.enters_tapped = true;
      continue;
    }
    if (fetch.test(line)) {
      if (++manaAbilityCount > 1)
        return reject("Multiple source abilities require an explicit model.");
      source.kind = "fetch";
      source.tap = true;
      source.sacrifice_self = true;
      source.fetch = { basic_only: true, destination: "battlefield", enters_tapped: true };
      source.provenance = "canonical_oracle";
      continue;
    }
    const match = /^(?:(\{[^{}]+\}(?:\{[^{}]+\})*), )?\{T\}: Add (.+)\.$/.exec(line);
    if (!match)
      return reject(
        "Source text, entry condition or non-mana ability is outside the supported grammar.",
      );
    if (++manaAbilityCount > 1)
      return reject("Multiple source abilities require an explicit model.");
    const activation = parseManaCost(match[1] ?? "{0}");
    if (activation.status !== "supported") return reject("Unsupported activation mana cost.");
    source.activation_cost = activation;
    source.tap = true;
    source.kind = "mana";
    source.provenance = "canonical_oracle";
    const output = match[2] ?? "";
    if (output === "one mana of any color")
      source.outputs = MANA_TYPES.filter((m) => m !== "C").map((m) => [m]);
    else if (output === "one mana of any color in your commander's color identity") {
      if (options.identity === undefined)
        return reject("Commander color identity must be explicitly supplied for this source.");
      if (options.identity.some((m) => !/^[WUBRG]$/.test(m)))
        return reject("Commander identity contains an invalid color.");
      source.outputs = [...new Set(options.identity)].map((m) => [m]);
    } else {
      const alternatives = output.split(/(?:,? or |, )/);
      if (alternatives.length > 20 || alternatives.some((a) => !/^(?:\{[WUBRGC]\}){1,20}$/.test(a)))
        return reject(
          "Output quantity, choice, spending restriction or condition is outside the supported grammar.",
        );
      source.outputs = alternatives.map((a) =>
        Array.from(a.matchAll(/\{([WUBRGC])\}/g), (m) => m[1]).filter(
          (m): m is Mana => m !== undefined && isMana(m),
        ),
      );
    }
  }
  const subtypes = (type.split("—")[1] ?? "").trim().split(/\s+/);
  const inherent = subtypes.flatMap((subtype) =>
    BASIC_MANA.filter(([basic]) => basic === subtype).map(([, mana]) => [mana]),
  );
  if (isLand && inherent.length) {
    if (manaAbilityCount)
      return reject(
        "Combining inherent basic-land-type abilities with another source ability is unsupported.",
      );
    source.kind = "mana";
    source.outputs = inherent;
    source.tap = true;
    source.provenance = "basic_land_type_rule";
    source.characteristic_evidence = {
      field_path: `${sourcePath}/type_line`,
      value: type,
      rule: "CR 305.6",
    };
  } else if (isLand && !manaAbilityCount)
    return reject("No supported mana or fetch ability is established for this land.");
  return source;
}

const aggregateStatus = (statuses: readonly ManaModelStatus[]): ManaModelStatus =>
  statuses.includes("unsupported")
    ? "unsupported"
    : statuses.includes("overridden")
      ? "overridden"
      : "supported";

export function modelCardMana(card: Card, options: ManaModelOptions = {}): CardManaModel {
  const model: CardManaModel = {
    version: MANA_MODEL_VERSION,
    oracle_id: card.oracle_id,
    name: card.name,
    status: "unsupported",
    face_relationship: card.gameplay?.face_relationship ?? "unknown",
    faces: [],
    reasons: [],
    assumptions: [],
  };
  const gameplay = card.gameplay;
  if (
    !gameplay ||
    !["single", "modal"].includes(gameplay.face_relationship) ||
    !gameplay.faces?.length ||
    (gameplay.face_relationship === "single" && gameplay.faces.length !== 1) ||
    (gameplay.face_relationship === "modal" && gameplay.faces.length !== 2) ||
    gameplay.faces.some((f, i) => f.face_index !== i)
  ) {
    model.reasons.push(
      "Canonical single-face or two-face modal gameplay facts are required; legacy, unknown and other face relationships are unsupported.",
    );
    return model;
  }
  const mechanics = extractMechanics(card).annotations;
  for (const face of gameplay.faces) {
    const c = face.characteristics;
    const cost = parseManaCost(c.mana_cost);
    cost.evidence = { field_path: `${face.source_path}/mana_cost`, value: c.mana_cost };
    if (
      c.oracle_text === null ||
      COST_CHANGE.test(c.oracle_text) ||
      c.keywords?.some((keyword) => COST_CHANGE_KEYWORDS.has(keyword.toLowerCase()))
    ) {
      cost.status = "unsupported";
      cost.reasons.push(
        c.oracle_text === null
          ? "Oracle text is missing; alternate costs cannot be assessed."
          : "Alternate, additional or modified costs are outside this model.",
      );
    }
    const source = sourceModel(card, c, face.face_index, face.source_path, options, mechanics);
    const modeled: ManaFaceModel = {
      face_index: face.face_index,
      name: c.name,
      type_line: c.type_line,
      is_land: /\bLand\b/.test(c.type_line ?? ""),
      is_basic: /\bBasic\b/.test(c.type_line ?? ""),
      cost,
      source,
      assumptions: [],
    };
    // Keep extracted reasons even when an assumption supplies an effective model.
    model.reasons.push(...cost.reasons, ...source.reasons);
    const overrides = (options.overrides ?? []).filter(
      (o) => o.oracle_id === card.oracle_id && o.face_index === face.face_index,
    );
    if (overrides.length > 1) {
      cost.status = "unsupported";
      source.status = "unsupported";
      model.reasons.push(`Conflicting overrides for face ${face.face_index}.`);
    } else if (overrides[0]) {
      const parsed = manaModelOverrideSchema.safeParse(overrides[0]);
      if (!parsed.success) {
        model.reasons.push(`Invalid override for face ${face.face_index}.`);
        source.status = "unsupported";
      } else {
        const override = parsed.data;
        modeled.assumptions.push(override.reason);
        if (override.mana_cost !== undefined)
          modeled.cost = {
            ...parseManaCost(override.mana_cost),
            status: "overridden",
            reasons: cost.reasons,
            evidence: cost.evidence,
          };
        if (override.source)
          modeled.source = {
            ...source,
            ...override.source,
            status: "overridden",
            kind: "mana",
            tap: true,
            sacrifice_self: false,
            activation_cost: parseManaCost(override.source.activation_cost),
            fetch: undefined,
            provenance: "caller_override",
          };
      }
    }
    if (
      options.identity !== undefined &&
      c.oracle_text?.includes("your commander's color identity")
    )
      modeled.assumptions.push(
        `Supplied commander color identity: ${options.identity.join("") || "colorless (no colors)"}.`,
      );
    model.faces.push(modeled);
    model.assumptions.push(...modeled.assumptions);
  }
  model.status = aggregateStatus(model.faces.flatMap((f) => [f.cost.status, f.source.status]));
  return model;
}

export interface ManaCoverage {
  total_quantity: number;
  resolved_quantity: number;
  supported_quantity: number;
  unsupported_quantity: number;
  unresolved_quantity: number;
  overridden_quantity: number;
}
const emptyCoverage = (): ManaCoverage => ({
  total_quantity: 0,
  resolved_quantity: 0,
  supported_quantity: 0,
  unsupported_quantity: 0,
  unresolved_quantity: 0,
  overridden_quantity: 0,
});
function countCoverage(
  coverage: ManaCoverage,
  qty: number,
  status: ManaModelStatus | "unresolved",
) {
  coverage.total_quantity += qty;
  if (status === "unresolved") coverage.unresolved_quantity += qty;
  else {
    coverage.resolved_quantity += qty;
    coverage[`${status}_quantity`] += qty;
  }
}
export function modelDeckMana(
  entries: readonly DeckCardEntry[],
  lookup: (id: string) => Card | null | undefined,
  options: ManaModelOptions = {},
) {
  const coverage = emptyCoverage(),
    source_coverage = emptyCoverage(),
    cost_coverage = emptyCoverage();
  const cards = entries.map((entry) => {
    const card = lookup(entry.oracle_id);
    const model = card ? modelCardMana(card, options) : null;
    const status = model?.status ?? "unresolved";
    countCoverage(coverage, entry.qty, status);
    countCoverage(
      source_coverage,
      entry.qty,
      model
        ? model.faces.length
          ? aggregateStatus(model.faces.map((f) => f.source.status))
          : "unsupported"
        : "unresolved",
    );
    countCoverage(
      cost_coverage,
      entry.qty,
      model
        ? model.faces.length
          ? aggregateStatus(model.faces.map((f) => f.cost.status))
          : "unsupported"
        : "unresolved",
    );
    return {
      oracle_id: entry.oracle_id,
      name: card?.name ?? null,
      qty: entry.qty,
      status,
      reasons: model?.reasons ?? ["Card was not resolved from the supplied lookup."],
      model,
      assumptions: model?.assumptions ?? [],
    };
  });
  const override_diagnostics = (options.overrides ?? []).flatMap((override) => {
    const row = cards.find((card) => card.oracle_id === override.oracle_id);
    if (!row)
      return [
        {
          oracle_id: override.oracle_id,
          face_index: override.face_index,
          reason: "Override card is not in this model's entry scope.",
        },
      ];
    if (!row.model?.faces.some((face) => face.face_index === override.face_index))
      return [
        {
          oracle_id: override.oracle_id,
          face_index: override.face_index,
          reason: "Override did not match a canonical supported face relationship and index.",
        },
      ];
    return [];
  });
  return {
    version: MANA_MODEL_VERSION,
    coverage,
    source_coverage,
    cost_coverage,
    cards,
    override_diagnostics,
    assumptions: [...MODEL_ASSUMPTIONS],
    cost_policy:
      "Cost support describes supplied printed/base mana costs only. Recognized alternate, additional and modified costs are explicitly unsupported; the model does not certify every casting rule or external cost change.",
    override_policy:
      "Caller overrides are assumptions, counted separately from extracted support; unmatched overrides do not create cards or faces.",
  };
}

export interface ManaWitnessSource {
  /** Stable ID for a physical copy, distinct from the card's Oracle ID. */
  id: string;
  model: CardManaModel;
  face_index: number;
  zone: "battlefield" | "hand" | "library";
  entered_this_turn?: boolean;
  tapped?: boolean;
}
export type ManaWitnessAction =
  | { kind: "activate"; source_id: string; output_index: number; payment?: readonly Mana[] }
  | { kind: "play"; source_id: string; face_index: number; payment?: readonly Mana[] }
  | { kind: "fetch"; source_id: string; target_id: string };
export interface ManaPaymentWitness {
  sources: readonly ManaWitnessSource[];
  actions: readonly ManaWitnessAction[];
  cost: string;
  initial_pool?: readonly Mana[];
  payment?: readonly Mana[];
}
export interface ManaPaymentWitnessResult {
  ok: boolean;
  reasons: string[];
  pool: Mana[];
  used_source_ids: string[];
  assumptions: string[];
}

/** Check exactly this finite witness; failure does not prove no other payment exists. */
export function checkManaPaymentWitness(witness: ManaPaymentWitness): ManaPaymentWitnessResult {
  let pool = [...(witness.initial_pool ?? [])];
  const used = new Set<string>();
  const assumptions = [...MODEL_ASSUMPTIONS];
  const result = (ok: boolean, reason?: string): ManaPaymentWitnessResult => ({
    ok,
    reasons: reason ? [reason] : [],
    pool,
    used_source_ids: [...used],
    assumptions,
  });
  if (
    witness.sources.length > 512 ||
    witness.actions.length > 128 ||
    pool.length > 1000 ||
    pool.some((m) => !isMana(m))
  )
    return result(false, "Witness exceeds bounds or contains invalid initial mana.");
  const state = new Map<
    string,
    Omit<ManaWitnessSource, "zone"> & { zone: ManaWitnessSource["zone"] | "graveyard" }
  >(
    witness.sources.map((s) => [
      s.id,
      { ...s, entered_this_turn: s.entered_this_turn ?? false, tapped: s.tapped ?? false },
    ]),
  );
  if (state.size !== witness.sources.length || witness.sources.some((s) => !s.id))
    return result(false, "Each physical card requires a unique nonempty source ID.");
  const pay = (cost: ManaCostModel, explicit?: readonly Mana[]): boolean => {
    if (cost.status === "unsupported" || cost.kind !== "mana") return false;
    const chosen = explicit ? [...explicit] : [...pool];
    if (chosen.some((m) => !isMana(m))) return false;
    const spend: Mana[] = [];
    for (const mana of cost.required) {
      const i = chosen.indexOf(mana);
      if (i < 0) return false;
      chosen.splice(i, 1);
      spend.push(mana);
    }
    if (chosen.length < cost.generic || (explicit && chosen.length !== cost.generic)) return false;
    spend.push(...chosen.slice(0, cost.generic));
    const remaining = [...pool];
    for (const mana of spend) {
      const i = remaining.indexOf(mana);
      if (i < 0) return false;
      remaining.splice(i, 1);
    }
    pool = remaining;
    return true;
  };
  let landPlays = 0;
  for (const action of witness.actions) {
    const physical = state.get(action.source_id);
    if (!physical) return result(false, "Action references a missing physical card.");
    if (physical.model.status === "unsupported")
      return result(false, "A used physical card has an unsupported model.");
    const face = physical.model.faces.find(
      (f) => f.face_index === (action.kind === "play" ? action.face_index : physical.face_index),
    );
    if (!face) return result(false, "Action references an unknown face.");
    assumptions.push(...face.assumptions);
    if (action.kind === "play") {
      if (face.source.kind !== "mana" && face.source.kind !== "fetch")
        return result(
          false,
          "Only supported mana-source permanents can be played in this witness; unrelated permanent effects are not interpreted.",
        );
      if (physical.zone !== "hand")
        return result(false, "Only a card in hand can be played; an MDFC cannot play both faces.");
      if (face.is_land) {
        if (++landPlays > 1)
          return result(false, "The witness permits at most one normal land play.");
      } else if (
        !/\b(?:Artifact|Creature|Enchantment|Planeswalker|Battle)\b/.test(face.type_line ?? "") ||
        !pay(face.cost, action.payment)
      )
        return result(
          false,
          "The permanent face's supported casting cost must be paid before it becomes a source.",
        );
      physical.zone = "battlefield";
      physical.face_index = face.face_index;
      physical.entered_this_turn = true;
      physical.tapped = face.source.enters_tapped;
      continue;
    }
    if (
      physical.zone !== "battlefield" ||
      physical.tapped ||
      (physical.entered_this_turn && (face.source.enters_tapped || face.source.summoning_delay))
    )
      return result(false, "Source is absent, tapped, or unavailable on its arrival turn.");
    if (action.kind === "fetch") {
      if (face.source.kind !== "fetch")
        return result(false, "Source has no supported fetch ability.");
      const target = state.get(action.target_id);
      const targetFace = target?.model.faces.find((f) => f.face_index === target.face_index);
      if (
        !target ||
        target.zone !== "library" ||
        target.model.status === "unsupported" ||
        target.model.face_relationship !== "single" ||
        !targetFace?.is_land ||
        !targetFace.is_basic
      )
        return result(
          false,
          "Fetch requires an explicit supported basic land card still in the library.",
        );
      physical.zone = "graveyard";
      physical.tapped = true;
      used.add(physical.id);
      target.zone = "battlefield";
      target.entered_this_turn = true;
      target.tapped = true;
      continue;
    }
    if (
      face.source.kind !== "mana" ||
      face.source.status === "unsupported" ||
      !Number.isInteger(action.output_index)
    )
      return result(false, "Source or chosen output is unsupported.");
    const output = face.source.outputs[action.output_index];
    if (!output) return result(false, "Output choice is unavailable.");
    // This must precede output credit: a Signet cannot fund its own activation.
    if (!pay(face.source.activation_cost, action.payment))
      return result(false, "Activation cost must be paid from previously available mana.");
    physical.tapped = true;
    used.add(physical.id);
    pool.push(...output);
  }
  return pay(parseManaCost(witness.cost), witness.payment)
    ? result(true)
    : result(false, "The final cost cannot be paid from this witness's remaining mana.");
}
