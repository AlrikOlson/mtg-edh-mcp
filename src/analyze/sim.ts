/**
 * Seeded opening-hand heuristics and bounded exact mana payment — pure + deterministic.
 *
 * Answers "how consistent is this deck's start?" by shuffling and drawing many
 * times: opening-hand keepable / mulligan / dead-on-arrival rates, average
 * opening lands, opening-hand SHAPE buckets (textbook / trap / explosive — see
 * HandScenario), lands available by turn, and the turn the deck can first cast a
 * spell. Shapes use real type lines + server-derived roles, not name heuristics.
 * Uses a SEEDED PRNG (mulberry32) — no Math.random — so identical inputs yield
 * byte-identical output (spec §11 determinism); advisory only.
 *
 * Scope (honest boundary): this is a MANA / CURVE goldfish — hand quality and
 * castability under a declared bounded source-development policy. It does NOT model combat,
 * the stack, interaction, or expected damage/turn-to-win; those need a far richer
 * engine and are explicitly out of scope here.
 */
import type { Card, DeckCardEntry } from "../types/index.js";
import type { CardLookup } from "./stats.js";
import { modelDeckMana, type ManaModelOptions } from "./manaModel.js";
import { sequenceMana, type SequenceCard, type ManaSequenceOptions } from "./manaSequence.js";

export interface SimOptions extends ManaModelOptions {
  /** Per-trial sequencing work cap (1..50000), within a total 2,000,000-unit cap. */
  maxWork?: number;
  /** Number of simulated games (default 1000). */
  trials?: number;
  /** PRNG seed — same seed + deck ⇒ identical result (default 1). */
  seed?: number;
  /** Opening hand size (default 7). */
  handSize?: number;
  /** On the play (skip the turn-1 draw). Default true. */
  onThePlay?: boolean;
  /** How many turns to play out per game (default 10). */
  maxTurns?: number;
}

/**
 * Opening-hand shape buckets. Aggregate rates say how often a hand is keepable;
 * shapes say WHAT the hand looks like — "3 lands and a rock" and "3 lands and
 * three 8-drops" are the same land count and opposite keep decisions. Buckets
 * are mutually exclusive and classified in this priority order.
 */
export type HandScenario =
  | "land_light_mulligan" // 0-1 lands: ship it
  | "flood" // 5+ lands
  | "explosive" // fast mana plus a second accelerant
  | "two_lands_no_accel_mulligan" // 2 lands, nothing to bridge — the classic trap keep
  | "lean_and_accelerated" // 2 lands + acceleration: usually keepable
  | "textbook" // 3-4 lands + acceleration
  | "top_heavy_trap" // 3-4 lands, no accel, expensive spells — looks great, does nothing
  | "playable_no_accel" // 3-4 lands, no accel, but a castable curve
  | "other";

export interface SimResult {
  trials: number;
  requested_trials: number;
  sequencing: {
    basis: "bounded_mana_policy";
    completed_trials: number;
    metrics_available: boolean;
    unsupported_trials: number;
    truncated_trials: number;
    unprocessed_trials: number;
    work: number;
    max_total_work: number;
    assumptions: string[];
  };
  hand_quality_basis: "legacy_land_and_role_heuristic";
  mana_model: ReturnType<typeof modelDeckMana>;
  /** Fraction of opening hands with a keepable land count (2..5). */
  keepable_rate: number;
  /** 1 - keepable_rate. */
  mulligan_rate: number;
  /** Fraction of opening hands that are mana-screwed (≤1 land) or flooded (≥6). */
  dead_on_arrival_rate: number;
  /** Average number of lands in the opening hand. */
  avg_opening_lands: number;
  /** Fraction of hands by opening land count (0..handSize). */
  opening_land_distribution: Record<number, number>;
  /** Fraction of hands falling in each shape bucket (see {@link HandScenario}). */
  scenarios: Record<HandScenario, number>;
  /** Average lands in play at the end of each turn (1..maxTurns). */
  lands_by_turn: Record<number, number>;
  /** Fraction of completed bounded trials with a supported paid spell; not a win-rate estimate. */
  first_spell_rate: number;
  /** Average turn the first spell was cast, over games that cast one (null if none did). */
  avg_turn_to_first_spell: number | null;
}

export interface LibraryCard {
  mv: number;
  isLand: boolean;
  /** Cheap acceleration that changes a keep decision: rock/dork, or ≤2mv ramp. */
  isAccel: boolean;
  /** ≤1mv nonland acceleration (Sol Ring, Mana Crypt, moxen, dorks). */
  isFastMana: boolean;
}

function isLand(card: Card): boolean {
  return /\bLand\b/.test(card.type_line);
}

/** Threshold for calling a no-accel hand "top-heavy": average nonland mv ≥ this. */
const TOP_HEAVY_AVG_MV = 4;

function classifyLibraryCard(card: Card): LibraryCard {
  const land = isLand(card);
  const accel =
    !land &&
    (card.roles.includes("mana_rock") ||
      card.roles.includes("mana_dork") ||
      (card.roles.includes("ramp") && card.mv <= 2));
  return {
    mv: card.mv,
    isLand: land,
    isAccel: accel,
    isFastMana: accel && card.mv <= 1,
  };
}

/** Classify one opening hand into its shape bucket. */
export function classifyHand(hand: readonly LibraryCard[]): HandScenario {
  const lands = hand.reduce((n, c) => n + (c.isLand ? 1 : 0), 0);
  const accel = hand.reduce((n, c) => n + (c.isAccel ? 1 : 0), 0);
  const fast = hand.reduce((n, c) => n + (c.isFastMana ? 1 : 0), 0);

  if (lands <= 1) return "land_light_mulligan";
  if (lands >= 5) return "flood";
  if (fast >= 1 && accel >= 2) return "explosive";
  if (lands === 2 && accel === 0) return "two_lands_no_accel_mulligan";
  if (lands === 2) return "lean_and_accelerated";
  // 3-4 lands from here.
  if (accel >= 1) return "textbook";
  const nonland = hand.filter((c) => !c.isLand);
  const avgMv = nonland.length ? nonland.reduce((s, c) => s + c.mv, 0) / nonland.length : 0;
  return avgMv >= TOP_HEAVY_AVG_MV ? "top_heavy_trap" : "playable_no_accel";
}

const SCENARIOS: readonly HandScenario[] = [
  "land_light_mulligan",
  "flood",
  "explosive",
  "two_lands_no_accel_mulligan",
  "lean_and_accelerated",
  "textbook",
  "top_heavy_trap",
  "playable_no_accel",
  "other",
];

/** Deterministic PRNG (mulberry32): seed → a () => float in [0,1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle in place using the seeded rng. */
function shuffle<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Goldfish-simulate a deck's library (the non-commander cards) over many seeded
 * games and return aggregate hand-quality + castability stats. Pure: no I/O, no
 * Math.random — `opts.seed` fully determines the outcome.
 */
export function simulateDeck(
  entries: readonly DeckCardEntry[],
  lookup: CardLookup,
  opts: SimOptions = {},
): SimResult {
  const trials = boundedInteger(opts.trials, 1000, 1, 100000, "trials");
  const seed = boundedInteger(
    opts.seed,
    1,
    -Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    "seed",
  );
  const handSize = boundedInteger(opts.handSize, 7, 1, 20, "handSize");
  const onThePlay = opts.onThePlay ?? true;
  const maxTurns = boundedInteger(opts.maxTurns, 10, 1, 50, "maxTurns");
  const maxWork = boundedInteger(opts.maxWork, 5000, 1, 50000, "maxWork");
  const prepared = prepareManaLibrary(entries, lookup, opts);
  const library = prepared.library.map((physical) => {
    const card = lookup(physical.model?.oracle_id ?? prepared.oracleIds.get(physical.id) ?? "");
    return {
      ...physical,
      shape: card
        ? classifyLibraryCard(card)
        : { mv: 0, isLand: false, isAccel: false, isFastMana: false },
    };
  });
  const maxTotalWork = 2000000;
  let work = 0,
    completed = 0,
    unsupported = 0,
    truncated = 0,
    processed = 0;
  let sequenceAssumptions: string[] = [];

  const rng = mulberry32(seed);
  let keepable = 0;
  let doa = 0;
  let openingLandSum = 0;
  let firstSpellGames = 0;
  let firstSpellTurnSum = 0;
  const landsByTurnSum: number[] = new Array<number>(maxTurns + 1).fill(0);
  const landDistCount: number[] = new Array<number>(handSize + 1).fill(0);
  const scenarioCount = new Map<HandScenario, number>();

  for (let t = 0; t < trials; t += 1) {
    if (work >= maxTotalWork) break;
    const deck = library.slice();
    shuffle(deck, rng);

    const hand = deck.slice(0, handSize).map((c) => c.shape);
    processed += 1;

    const openingLands = hand.reduce((n, c) => n + (c.isLand ? 1 : 0), 0);
    openingLandSum += openingLands;
    if (openingLands >= 2 && openingLands <= 5) keepable += 1;
    if (openingLands <= 1 || openingLands >= 6) doa += 1;
    landDistCount[Math.min(openingLands, handSize)]! += 1;
    const scenario = classifyHand(hand);
    scenarioCount.set(scenario, (scenarioCount.get(scenario) ?? 0) + 1);

    const sequence = sequenceMana(deck, [], {
      handSize,
      onThePlay,
      maxTurns,
      maxWork: Math.min(maxWork, maxTotalWork - work),
    });
    work += Math.max(1, sequence.work);
    sequenceAssumptions = sequence.assumptions;
    if (sequence.status === "truncated") {
      truncated += 1;
      continue;
    }
    if (sequence.status === "unsupported") {
      unsupported += 1;
      continue;
    }
    completed += 1;
    for (const turn of sequence.turns) landsByTurnSum[turn.turn]! += turn.lands_in_play;
    if (sequence.first_spell_turn !== null) {
      firstSpellGames += 1;
      firstSpellTurnSum += sequence.first_spell_turn;
    }
  }

  const lands_by_turn: Record<number, number> = {};
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    lands_by_turn[turn] = round3(landsByTurnSum[turn]! / Math.max(1, completed));
  }

  const opening_land_distribution: Record<number, number> = {};
  for (let i = 0; i <= handSize; i += 1) {
    opening_land_distribution[i] = round3(landDistCount[i]! / Math.max(1, processed));
  }
  const scenarios = Object.fromEntries(
    SCENARIOS.map((s) => [s, round3((scenarioCount.get(s) ?? 0) / Math.max(1, processed))]),
  ) as Record<HandScenario, number>;

  return {
    trials: processed,
    requested_trials: trials,
    sequencing: {
      basis: "bounded_mana_policy",
      completed_trials: completed,
      metrics_available: completed > 0,
      unsupported_trials: unsupported,
      truncated_trials: truncated,
      unprocessed_trials: trials - processed,
      work,
      max_total_work: maxTotalWork,
      assumptions: [
        ...sequenceAssumptions,
        "Casting and land averages use completed sequencing trials only; truncation and unsupported trials are excluded, never a success or proof of failure. If metrics_available is false, numeric zero fields are compatibility placeholders, not measurements.",
        "Opening-hand rates use processed initial hands. Keep/mulligan labels are land/role heuristics; no redraw or bottoming is performed.",
      ],
    },
    hand_quality_basis: "legacy_land_and_role_heuristic",
    mana_model: prepared.manaModel,
    keepable_rate: round3(keepable / Math.max(1, processed)),
    mulligan_rate: round3(processed ? 1 - keepable / processed : 0),
    dead_on_arrival_rate: round3(doa / Math.max(1, processed)),
    avg_opening_lands: round3(openingLandSum / Math.max(1, processed)),
    opening_land_distribution,
    scenarios,
    lands_by_turn,
    first_spell_rate: round3(firstSpellGames / Math.max(1, completed)),
    avg_turn_to_first_spell:
      firstSpellGames > 0 ? round3(firstSpellTurnSum / firstSpellGames) : null,
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max)
    throw new RangeError(`${name} must be an integer in ${min}..${max}.`);
  return resolved;
}

/** Quantity checks precede model construction and physical expansion. Unknown cards stay in the library. */
export function prepareManaLibrary(
  entries: readonly DeckCardEntry[],
  lookup: CardLookup,
  options: ManaModelOptions = {},
  prefix = "library",
) {
  if (
    entries.length > 512 ||
    entries.some((e) => !Number.isSafeInteger(e.qty) || e.qty < 1) ||
    entries.reduce((n, e) => n + e.qty, 0) > 512
  )
    throw new RangeError("Mana sequencing supports at most 512 positive-quantity physical cards.");
  const manaModel = modelDeckMana(entries, lookup, options);
  const library: SequenceCard[] = [];
  const oracleIds = new Map<string, string>();
  for (const [rowIndex, row] of manaModel.cards.entries()) {
    for (let copy = 0; copy < row.qty; copy += 1) {
      const id = `${prefix}:${rowIndex}:${copy}`;
      library.push({ id, model: row.model });
      oracleIds.set(id, row.oracle_id);
    }
  }
  return { library, manaModel, oracleIds };
}

/** One seeded scenario with replay evidence, separate from aggregate opening-hand heuristics. */
export function simulateManaSequence(
  entries: readonly DeckCardEntry[],
  commanders: readonly string[],
  lookup: CardLookup,
  options: ManaSequenceOptions & ManaModelOptions & { seed?: number } = {},
) {
  const prepared = prepareManaLibrary(entries, lookup, options);
  const command = prepareManaLibrary(
    commanders.map((oracle_id) => ({ oracle_id, qty: 1 })),
    lookup,
    options,
    "command",
  );
  const seed = boundedInteger(
    options.seed,
    1,
    -Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    "seed",
  );
  const library = prepared.library.slice();
  shuffle(library, mulberry32(seed));
  const sequenceOptions: ManaSequenceOptions = {
    handSize: options.handSize ?? 7,
    maxTurns: options.maxTurns ?? 10,
    onThePlay: options.onThePlay ?? true,
    maxWork: options.maxWork ?? 5000,
    ...(options.target ? { target: options.target } : {}),
  };
  return {
    seed,
    library_order: library.map((card) => card.id),
    physical_cards: [...prepared.oracleIds, ...command.oracleIds].map(([id, oracle_id]) => ({
      id,
      oracle_id,
    })),
    sequence_options: sequenceOptions,
    sequence: sequenceMana(library, command.library, sequenceOptions),
    mana_model: prepared.manaModel,
    command_zone_mana_model: command.manaModel,
  };
}
