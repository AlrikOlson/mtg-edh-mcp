/**
 * Monte Carlo goldfish simulator (spec §5D, review #8/#13) — pure + deterministic.
 *
 * Answers "how consistent is this deck's start?" by shuffling and drawing many
 * times: opening-hand keepable / mulligan / dead-on-arrival rates, average
 * opening lands, lands available by turn, and the turn the deck can first cast a
 * spell. Uses a SEEDED PRNG (mulberry32) — no Math.random — so identical inputs
 * yield byte-identical output (spec §11 determinism); advisory only.
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
  /** Average lands in play at the end of each turn (1..maxTurns). */
  lands_by_turn: Record<number, number>;
  /** Fraction of games that cast at least one spell within maxTurns. */
  first_spell_rate: number;
  /** Average turn the first spell was cast, over games that cast one (null if none did). */
  avg_turn_to_first_spell: number | null;
}

interface LibraryCard {
  mv: number;
  isLand: boolean;
}

function isLand(card: Card): boolean {
  return /\bLand\b/.test(card.type_line);
}

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
    const lib: LibraryCard = { mv: card.mv, isLand: isLand(card) };
    for (let i = 0; i < entry.qty; i += 1) library.push({ ...lib });
  }

  const rng = mulberry32(seed);
  let keepable = 0;
  let doa = 0;
  let openingLandSum = 0;
  let firstSpellGames = 0;
  let firstSpellTurnSum = 0;
  const landsByTurnSum: number[] = new Array<number>(maxTurns + 1).fill(0);

  for (let t = 0; t < trials; t += 1) {
    const deck = library.slice();
    shuffle(deck, rng);

    const hand = deck.slice(0, handSize);
    let drawIndex = handSize; // next card to be drawn from the top of `deck`

    const openingLands = hand.reduce((n, c) => n + (c.isLand ? 1 : 0), 0);
    openingLandSum += openingLands;
    if (openingLands >= 2 && openingLands <= 5) keepable += 1;
    if (openingLands <= 1 || openingLands >= 6) doa += 1;

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

  return {
    trials,
    keepable_rate: round3(keepable / trials),
    mulligan_rate: round3(1 - keepable / trials),
    dead_on_arrival_rate: round3(doa / trials),
    avg_opening_lands: round3(openingLandSum / trials),
    lands_by_turn,
    first_spell_rate: round3(firstSpellGames / trials),
    avg_turn_to_first_spell:
      firstSpellGames > 0 ? round3(firstSpellTurnSum / firstSpellGames) : null,
  };
}
