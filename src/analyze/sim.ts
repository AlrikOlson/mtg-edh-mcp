/**
 * Monte Carlo goldfish simulator (spec §5D, review #8/#13) — pure + deterministic.
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
 * castability under a one-land-per-turn assumption. It does NOT model combat,
 * the stack, interaction, or expected damage/turn-to-win; those need a far richer
 * engine and are explicitly out of scope here.
 */
import type { Card, DeckCardEntry } from "../types/index.js";
import type { CardLookup } from "./stats.js";

export interface SimOptions {
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
  /** Fraction of games that cast at least one spell within maxTurns. */
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
  const trials = opts.trials ?? 1000;
  const seed = opts.seed ?? 1;
  const handSize = opts.handSize ?? 7;
  const onThePlay = opts.onThePlay ?? true;
  const maxTurns = opts.maxTurns ?? 10;

  // The library = each entry's card expanded by quantity (commanders excluded —
  // they live in the command zone, not the deck you draw from). Unknown cards
  // are skipped (can't classify them).
  const library: LibraryCard[] = [];
  for (const entry of entries) {
    const card = lookup(entry.oracle_id);
    if (!card) continue;
    const lib = classifyLibraryCard(card);
    for (let i = 0; i < entry.qty; i += 1) library.push({ ...lib });
  }

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
    const deck = library.slice();
    shuffle(deck, rng);

    const hand = deck.slice(0, handSize);
    let drawIndex = handSize; // next card to be drawn from the top of `deck`

    const openingLands = hand.reduce((n, c) => n + (c.isLand ? 1 : 0), 0);
    openingLandSum += openingLands;
    if (openingLands >= 2 && openingLands <= 5) keepable += 1;
    if (openingLands <= 1 || openingLands >= 6) doa += 1;
    landDistCount[Math.min(openingLands, handSize)]! += 1;
    const scenario = classifyHand(hand);
    scenarioCount.set(scenario, (scenarioCount.get(scenario) ?? 0) + 1);

    // Play out turns: draw 1 (except turn 1 on the play), play ≤1 land/turn from
    // hand, and note the first turn a nonland is castable (mv ≤ lands in play).
    let landsInPlay = 0;
    let firstSpellTurn = 0;
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      if (!(onThePlay && turn === 1) && drawIndex < deck.length) {
        hand.push(deck[drawIndex]!);
        drawIndex += 1;
      }
      const landIdx = hand.findIndex((c) => c.isLand);
      if (landIdx >= 0) {
        hand.splice(landIdx, 1);
        landsInPlay += 1;
      }
      landsByTurnSum[turn]! += landsInPlay;
      if (firstSpellTurn === 0 && landsInPlay >= 1) {
        const castable = hand.some((c) => !c.isLand && c.mv <= landsInPlay);
        if (castable) firstSpellTurn = turn;
      }
    }
    if (firstSpellTurn > 0) {
      firstSpellGames += 1;
      firstSpellTurnSum += firstSpellTurn;
    }
  }

  const lands_by_turn: Record<number, number> = {};
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    lands_by_turn[turn] = round3(landsByTurnSum[turn]! / trials);
  }

  const opening_land_distribution: Record<number, number> = {};
  for (let i = 0; i <= handSize; i += 1) {
    opening_land_distribution[i] = round3(landDistCount[i]! / trials);
  }
  const scenarios = Object.fromEntries(
    SCENARIOS.map((s) => [s, round3((scenarioCount.get(s) ?? 0) / trials)]),
  ) as Record<HandScenario, number>;

  return {
    trials,
    keepable_rate: round3(keepable / trials),
    mulligan_rate: round3(1 - keepable / trials),
    dead_on_arrival_rate: round3(doa / trials),
    avg_opening_lands: round3(openingLandSum / trials),
    opening_land_distribution,
    scenarios,
    lands_by_turn,
    first_spell_rate: round3(firstSpellGames / trials),
    avg_turn_to_first_spell:
      firstSpellGames > 0 ? round3(firstSpellTurnSum / firstSpellGames) : null,
  };
}
