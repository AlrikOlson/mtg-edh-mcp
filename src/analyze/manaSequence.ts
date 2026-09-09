/** Bounded deterministic sequencing of the canonical model; never a game-rules engine. */
import {
  checkManaPaymentWitness,
  MANA_TYPES,
  type CardManaModel,
  type Mana,
  type ManaCostModel,
  type ManaFaceModel,
  type ManaWitnessAction,
  type ManaWitnessSource,
} from "./manaModel.js";

export interface SequenceCard {
  /** Unique physical-copy identity, independent of Oracle identity. */
  id: string;
  model: CardManaModel | null;
}
export interface ManaSequenceOptions {
  handSize?: number;
  maxTurns?: number;
  onThePlay?: boolean;
  maxWork?: number;
  target?: { oracle_id: string; face_index?: number; zone?: "library" | "command" };
}
export interface ManaSequenceCast {
  source_id: string;
  face_index: number;
  zone: "library" | "command";
  payment: Mana[];
}
export interface ManaSequenceTurn {
  turn: number;
  drawn: string | null;
  lands_in_play: number;
  actions: ManaWitnessAction[];
  /** Terminal cast: only cost payment is modeled, never the spell's resolution. */
  cast: ManaSequenceCast | null;
  pool: Mana[];
}
export interface ManaSequenceReplay {
  ok: boolean;
  reasons: string[];
}
export interface ManaSequenceResult {
  status: "success" | "failure" | "truncated" | "unsupported";
  first_spell_turn: number | null;
  target_cast_turn: number | null;
  turns: ManaSequenceTurn[];
  work: number;
  reasons: string[];
  assumptions: string[];
  replay: ManaSequenceReplay;
}
const ASSUMPTIONS = [
  "Deterministic bounded heuristic, not optimal sequencing or a general Magic rules engine. Costs are printed/base mana costs; no opponents, spell resolution, taxes, cost changes, extra land drops, mulligans, untap effects or non-mana resources.",
  "The library is supplied in shuffled order. Draw one each turn except turn one on the play; the opening hand is its prefix. Command-zone targets are available without drawing.",
  "Play the first supported land face in hand/face order, reserving physical copies of a named spell target. Fetch the first supported single-face basic remaining in library, entering tapped; preserve remaining order without modeling a reshuffle.",
  "Try the named target before each accelerant. Pay supported accelerants in hand/face order. Without a named target, try nonland spells in hand/face order. Exact bounded payment search chooses the first legal witness, not a globally optimal future allocation.",
  "Actions occur in one main phase: excess mana persists and used sources stay tapped until the next turn. New mana creatures wait a turn. After terminal success only land drops and fetches continue for land statistics.",
];
type Zone = "library" | "hand" | "battlefield" | "command" | "graveyard" | "cast";
interface Physical extends SequenceCard {
  zone: Zone;
  face_index: number;
  entered_this_turn: boolean;
  tapped: boolean;
}
interface Settings {
  handSize: number;
  maxTurns: number;
  onThePlay: boolean;
  maxWork: number;
}
function settings(options: ManaSequenceOptions): Settings {
  return {
    handSize: options.handSize ?? 7,
    maxTurns: options.maxTurns ?? 10,
    onThePlay: options.onThePlay ?? true,
    maxWork: options.maxWork ?? 5000,
  };
}
function inputErrors(
  library: readonly SequenceCard[],
  commanders: readonly SequenceCard[],
  options: ManaSequenceOptions,
): string[] {
  const s = settings(options);
  const physical = [...library, ...commanders];
  if (
    physical.length > 512 ||
    physical.some((c) => !c.id) ||
    new Set(physical.map((c) => c.id)).size !== physical.length
  )
    return ["At most 512 physical cards with unique nonempty IDs are required."];
  if (
    !Number.isInteger(s.handSize) ||
    s.handSize < 0 ||
    s.handSize > 512 ||
    !Number.isInteger(s.maxTurns) ||
    s.maxTurns < 1 ||
    s.maxTurns > 50 ||
    !Number.isInteger(s.maxWork) ||
    s.maxWork < 1 ||
    s.maxWork > 50000
  )
    return ["Sequence bounds require handSize 0–512, maxTurns 1–50 and maxWork 1–50000."];
  if (options.target) {
    const target = options.target;
    const cards = target.zone === "command" ? commanders : library;
    if (
      !cards.some(
        (c) =>
          c.model?.oracle_id === target.oracle_id &&
          c.model.faces.some((f) => f.face_index === (target.face_index ?? 0) && payableSpell(f)),
      )
    )
      return [
        "The named target must identify a present nonland face with a supported payable mana cost in the selected zone.",
      ];
  }
  return [];
}
const faceOf = (card: Physical) => card.model?.faces.find((f) => f.face_index === card.face_index);
const payableSpell = (face: ManaFaceModel) =>
  !face.is_land && face.cost.status !== "unsupported" && face.cost.kind === "mana";
const usableModel = (card: SequenceCard) =>
  card.model !== null && card.model.status !== "unsupported";
const selected = (card: SequenceCard, face: ManaFaceModel, options: ManaSequenceOptions) =>
  options.target !== undefined &&
  card.model?.oracle_id === options.target.oracle_id &&
  face.face_index === (options.target.face_index ?? 0);
const counts = (pool: readonly Mana[]) => MANA_TYPES.map((m) => pool.filter((p) => p === m).length);
const symbols = (pool: readonly number[]): Mana[] =>
  MANA_TYPES.flatMap((m, i) => Array.from({ length: pool[i] ?? 0 }, () => m));
class WorkBudget {
  work = 0;
  exhausted = false;
  constructor(readonly maximum: number) {}
  take(): boolean {
    if (this.work >= this.maximum) {
      this.exhausted = true;
      return false;
    }
    this.work++;
    return true;
  }
}
interface Allocation {
  pool: number[];
  payment: Mana[];
}
/** Enumerate generic allocations by counts, not indistinguishable individual mana. */
function* allocations(
  pool: readonly number[],
  cost: ManaCostModel,
  budget: WorkBudget,
): Generator<Allocation> {
  if (cost.kind !== "mana" || cost.status === "unsupported") return;
  const remaining = [...pool];
  for (const mana of cost.required) {
    const index = MANA_TYPES.indexOf(mana);
    if ((remaining[index] ?? 0) < 1) return;
    remaining[index] = (remaining[index] ?? 0) - 1;
  }
  if (remaining.reduce((a, b) => a + b, 0) < cost.generic) return;
  const order = [5, 0, 1, 2, 3, 4]; // Spend true colorless on generic first.
  function* distribute(position: number, need: number, payment: Mana[]): Generator<Allocation> {
    if (budget.exhausted) return;
    if (!need) {
      if (budget.take()) yield { pool: [...remaining], payment: [...cost.required, ...payment] };
      return;
    }
    const index = order[position];
    if (
      index === undefined ||
      order.slice(position).reduce((total, i) => total + (remaining[i] ?? 0), 0) < need
    )
      return;
    const available = remaining[index] ?? 0;
    for (let amount = Math.min(need, available); amount >= 0; amount--) {
      remaining[index] = available - amount;
      yield* distribute(position + 1, need - amount, [
        ...payment,
        ...Array.from({ length: amount }, () => MANA_TYPES[index] ?? "C"),
      ]);
      if (budget.exhausted) break;
    }
    remaining[index] = available;
  }
  yield* distribute(0, cost.generic, []);
}
interface Payment {
  pool: Mana[];
  payment: Mana[];
  actions: ManaWitnessAction[];
}
function findPayment(
  cards: readonly Physical[],
  pool: readonly Mana[],
  cost: ManaCostModel,
  budget: WorkBudget,
  actionRoom: number,
): Payment | null {
  const sources = cards.filter((c) => {
    const face = faceOf(c);
    return (
      usableModel(c) &&
      c.zone === "battlefield" &&
      !c.tapped &&
      face?.source.kind === "mana" &&
      face.source.status !== "unsupported" &&
      !(c.entered_this_turn && (face.source.enters_tapped || face.source.summoning_delay))
    );
  });
  // These are optimistic bounds: ignoring activation costs can only overestimate
  // what the available physical sources produce, so rejection is sound.
  const potential = sources.map((source) => faceOf(source)?.source.outputs ?? []);
  const totalUpper =
    pool.length +
    potential.reduce(
      (total, alternatives) => total + Math.max(0, ...alternatives.map((output) => output.length)),
      0,
    );
  const missingType = MANA_TYPES.some((mana) => {
    const required = cost.required.filter((symbol) => symbol === mana).length;
    const upper =
      pool.filter((symbol) => symbol === mana).length +
      potential.reduce(
        (total, alternatives) =>
          total +
          Math.max(
            0,
            ...alternatives.map((output) => output.filter((symbol) => symbol === mana).length),
          ),
        0,
      );
    return required > upper;
  });
  if (totalUpper < cost.generic + cost.required.length || missingType) {
    budget.take();
    return null;
  }
  const queue: { pool: number[]; used: bigint; actions: ManaWitnessAction[] }[] = [
    { pool: counts(pool), used: 0n, actions: [] },
  ];
  const seen = new Set<string>([`0:${counts(pool).join(",")}`]);
  let bounded = false;
  for (let index = 0; index < queue.length; index++) {
    if (!budget.take()) return null;
    const state = queue[index];
    if (!state) continue;
    const paid = allocations(state.pool, cost, budget).next().value;
    if (paid) return { pool: symbols(paid.pool), payment: paid.payment, actions: state.actions };
    if (budget.exhausted) return null;
    if (state.actions.length >= actionRoom) {
      if (sources.some((_, i) => !(state.used & (1n << BigInt(i))))) bounded = true;
      continue;
    }
    for (const [sourceIndex, source] of sources.entries()) {
      const bit = 1n << BigInt(sourceIndex);
      if (state.used & bit) continue;
      const face = faceOf(source);
      if (!face) continue;
      for (const activation of allocations(state.pool, face.source.activation_cost, budget)) {
        for (const [outputIndex, output] of face.source.outputs.entries()) {
          if (!budget.take()) return null;
          const nextPool = [...activation.pool];
          for (const mana of output) {
            const i = MANA_TYPES.indexOf(mana);
            nextPool[i] = (nextPool[i] ?? 0) + 1;
          }
          if (nextPool.reduce((a, b) => a + b, 0) > 1000) {
            bounded = true;
            continue;
          }
          const used = state.used | bit;
          const key = `${used}:${nextPool.join(",")}`;
          if (seen.has(key)) continue;
          seen.add(key);
          queue.push({
            pool: nextPool,
            used,
            actions: [
              ...state.actions,
              {
                kind: "activate",
                source_id: source.id,
                output_index: outputIndex,
                payment: activation.payment,
              },
            ],
          });
        }
      }
      if (budget.exhausted) return null;
    }
  }
  if (bounded) budget.exhausted = true;
  return null;
}

export function sequenceMana(
  library: readonly SequenceCard[],
  commanders: readonly SequenceCard[] = [],
  options: ManaSequenceOptions = {},
): ManaSequenceResult {
  const errors = inputErrors(library, commanders, options);
  const result: ManaSequenceResult = {
    status: "failure",
    first_spell_turn: null,
    target_cast_turn: null,
    turns: [],
    work: 0,
    reasons: errors,
    assumptions: [...ASSUMPTIONS],
    replay: { ok: false, reasons: [] },
  };
  if (errors.length) {
    result.status = "unsupported";
    result.replay.reasons = [...errors];
    return result;
  }
  const s = settings(options);
  const budget = new WorkBudget(s.maxWork);
  const cards: Physical[] = [
    ...library.map((c, i): Physical => ({
      ...c,
      zone: i < s.handSize ? "hand" : "library",
      face_index: 0,
      entered_this_turn: false,
      tapped: false,
    })),
    ...commanders.map((c): Physical => ({
      ...c,
      zone: "command",
      face_index: 0,
      entered_this_turn: false,
      tapped: false,
    })),
  ];
  let done = false;
  for (let turn = 1; turn <= s.maxTurns; turn++) {
    if (!budget.take()) break;
    for (const card of cards) {
      card.entered_this_turn = false;
      if (card.zone === "battlefield") card.tapped = false;
    }
    const draw = turn > 1 || !s.onThePlay ? cards.find((c) => c.zone === "library") : undefined;
    if (draw) draw.zone = "hand";
    const row: ManaSequenceTurn = {
      turn,
      drawn: draw?.id ?? null,
      lands_in_play: 0,
      actions: [],
      cast: null,
      pool: [],
    };
    const reserved = (c: Physical) =>
      options.target?.zone !== "command" && c.model?.faces.some((f) => selected(c, f, options));
    const land = cards.find(
      (c) =>
        c.zone === "hand" &&
        usableModel(c) &&
        !reserved(c) &&
        c.model?.faces.some(
          (f) => f.is_land && (f.source.kind === "mana" || f.source.kind === "fetch"),
        ),
    );
    const landFace = land?.model?.faces.find(
      (f) => f.is_land && (f.source.kind === "mana" || f.source.kind === "fetch"),
    );
    if (land && landFace) {
      land.zone = "battlefield";
      land.face_index = landFace.face_index;
      land.entered_this_turn = true;
      land.tapped = landFace.source.enters_tapped;
      row.actions.push({ kind: "play", source_id: land.id, face_index: landFace.face_index });
    }
    for (const fetch of cards) {
      const face = faceOf(fetch);
      if (
        fetch.zone !== "battlefield" ||
        fetch.tapped ||
        face?.source.kind !== "fetch" ||
        (fetch.entered_this_turn && face.source.summoning_delay)
      )
        continue;
      const basic = cards.find(
        (c) =>
          c.zone === "library" &&
          usableModel(c) &&
          c.model?.face_relationship === "single" &&
          faceOf(c)?.is_basic &&
          faceOf(c)?.is_land,
      );
      if (!basic) continue;
      if (row.actions.length >= 128 || !budget.take()) {
        budget.exhausted = true;
        break;
      }
      row.actions.push({ kind: "fetch", source_id: fetch.id, target_id: basic.id });
      fetch.zone = "graveyard";
      fetch.tapped = true;
      basic.zone = "battlefield";
      basic.tapped = true;
      basic.entered_this_turn = true;
    }
    const applyPayment = (paid: Payment) => {
      row.actions.push(...paid.actions);
      row.pool = paid.pool;
      for (const action of paid.actions) {
        const c = cards.find((c) => c.id === action.source_id);
        if (c) c.tapped = true;
      }
    };
    const tryTarget = (): boolean => {
      for (const candidate of cards) {
        const zone = options.target?.zone === "command" ? "command" : "hand";
        if (candidate.zone !== zone) continue;
        for (const face of candidate.model?.faces ?? []) {
          if (!payableSpell(face) || (options.target && !selected(candidate, face, options)))
            continue;
          const paid = findPayment(cards, row.pool, face.cost, budget, 128 - row.actions.length);
          if (!paid) {
            if (budget.exhausted) return false;
            continue;
          }
          applyPayment(paid);
          row.cast = {
            source_id: candidate.id,
            face_index: face.face_index,
            zone: zone === "command" ? "command" : "library",
            payment: paid.payment,
          };
          candidate.zone = "cast";
          result.first_spell_turn ??= turn;
          result.target_cast_turn = turn;
          return true;
        }
      }
      return false;
    };
    if (!done && !budget.exhausted) done = tryTarget();
    if (!done && options.target && !budget.exhausted) {
      // Each pass restarts hand order because a just-paid source may enable an earlier card.
      let advanced = true;
      while (advanced && !done && !budget.exhausted) {
        advanced = false;
        for (const candidate of cards) {
          if (candidate.zone !== "hand" || !usableModel(candidate) || reserved(candidate)) continue;
          for (const face of candidate.model?.faces ?? []) {
            if (
              !payableSpell(face) ||
              selected(candidate, face, options) ||
              face.source.kind !== "mana" ||
              !/\b(?:Artifact|Creature|Enchantment|Planeswalker|Battle)\b/.test(
                face.type_line ?? "",
              )
            )
              continue;
            if (row.actions.length >= 128) {
              budget.exhausted = true;
              break;
            }
            const paid = findPayment(cards, row.pool, face.cost, budget, 127 - row.actions.length);
            if (!paid) {
              if (budget.exhausted) break;
              continue;
            }
            applyPayment(paid);
            row.actions.push({
              kind: "play",
              source_id: candidate.id,
              face_index: face.face_index,
              payment: paid.payment,
            });
            candidate.zone = "battlefield";
            candidate.face_index = face.face_index;
            candidate.entered_this_turn = true;
            candidate.tapped = face.source.enters_tapped;
            result.first_spell_turn ??= turn;
            advanced = true;
            done = tryTarget();
            break;
          }
          if (advanced || budget.exhausted) break;
        }
      }
    }
    row.lands_in_play = cards.filter((c) => c.zone === "battlefield" && faceOf(c)?.is_land).length;
    // A partial turn is excluded: callers must not use incomplete trials as negative evidence.
    if (budget.exhausted) break;
    result.turns.push(row);
  }
  // Summaries contain only evidence retained in complete turn records.
  result.first_spell_turn = null;
  result.target_cast_turn = null;
  const usedAssumptions = new Set(ASSUMPTIONS);
  for (const row of result.turns) {
    for (const action of row.actions) {
      const model = cards.find((card) => card.id === action.source_id)?.model;
      for (const assumption of model?.assumptions ?? []) usedAssumptions.add(assumption);
      if (
        action.kind === "play" &&
        !model?.faces.find((face) => face.face_index === action.face_index)?.is_land
      )
        result.first_spell_turn ??= row.turn;
    }
    if (row.cast) {
      result.first_spell_turn ??= row.turn;
      result.target_cast_turn = row.turn;
      for (const assumption of cards.find((card) => card.id === row.cast?.source_id)?.model
        ?.assumptions ?? [])
        usedAssumptions.add(assumption);
    }
  }
  result.assumptions = [...usedAssumptions];
  result.work = budget.work;
  result.status = budget.exhausted ? "truncated" : done ? "success" : "failure";
  if (budget.exhausted)
    result.reasons.push(
      "Sequence work or action bound reached; incomplete trial is not evidence of failure.",
    );
  else if (!done)
    result.reasons.push(
      "The deterministic policy did not pay a supported target within the requested turns; this does not prove no legal sequence exists.",
    );
  result.replay = replayManaSequence(library, commanders, options, result);
  if (!result.replay.ok && result.status !== "truncated") {
    result.status = "unsupported";
    result.reasons.push(...result.replay.reasons);
  }
  return result;
}

/** Replay derives all zones and readiness from the initial ordered deck and actions. */
export function replayManaSequence(
  library: readonly SequenceCard[],
  commanders: readonly SequenceCard[],
  options: ManaSequenceOptions,
  result: ManaSequenceResult,
): ManaSequenceReplay {
  const fail = (reason: string): ManaSequenceReplay => ({ ok: false, reasons: [reason] });
  const errors = inputErrors(library, commanders, options);
  if (errors.length) return { ok: false, reasons: errors };
  const s = settings(options);
  if (
    result.turns.length > s.maxTurns ||
    result.work < 0 ||
    result.work > s.maxWork ||
    !Number.isInteger(result.work)
  )
    return fail("Invalid sequence bounds or work count.");
  if (result.status !== "truncated" && result.turns.length !== s.maxTurns)
    return fail("A complete sequence must include every requested turn.");
  // This ledger is independent of the planner's Physical state and payment search.
  const byId = new Map([...library, ...commanders].map((c) => [c.id, c]));
  const hand = new Set(library.slice(0, s.handSize).map((c) => c.id));
  const command = new Set(commanders.map((c) => c.id));
  const deck = library.slice(s.handSize).map((c) => c.id);
  const battlefield = new Map<string, number>();
  let first: number | null = null;
  let castTurn: number | null = null;
  for (const [index, turn] of result.turns.entries()) {
    if (turn.turn !== index + 1 || turn.actions.length > 128)
      return fail("Turns must be consecutive and action-bounded.");
    const expectedDraw = turn.turn > 1 || !s.onThePlay ? (deck.shift() ?? null) : null;
    if (turn.drawn !== expectedDraw)
      return fail("A turn draw disagrees with the remaining physical library.");
    if (expectedDraw !== null) hand.add(expectedDraw);
    const sources: ManaWitnessSource[] = [];
    for (const card of byId.values()) {
      if (!card.model) continue;
      if (battlefield.has(card.id))
        sources.push({
          id: card.id,
          model: card.model,
          face_index: battlefield.get(card.id) ?? 0,
          zone: "battlefield",
        });
      else if (hand.has(card.id))
        sources.push({ id: card.id, model: card.model, face_index: 0, zone: "hand" });
      else if (deck.includes(card.id))
        sources.push({ id: card.id, model: card.model, face_index: 0, zone: "library" });
    }
    let cost = "{0}";
    if (turn.cast) {
      if (castTurn !== null) return fail("A terminal target cannot be cast more than once.");
      const cast = turn.cast;
      const card = byId.get(cast.source_id);
      const face = card?.model?.faces.find((f) => f.face_index === cast.face_index);
      const available = cast.zone === "command" ? command : hand;
      if (
        !card ||
        !face ||
        !payableSpell(face) ||
        !available.has(card.id) ||
        face.cost.raw === null
      )
        return fail("Terminal cast lacks an available physical card and supported nonland cost.");
      if (
        options.target
          ? !selected(card, face, options) || cast.zone !== (options.target.zone ?? "library")
          : cast.zone !== "library"
      )
        return fail("Terminal cast does not match the requested target and zone.");
      cost = face.cost.raw;
    }
    if (
      castTurn !== null &&
      turn.actions.some(
        (a) =>
          a.kind === "play" &&
          !byId.get(a.source_id)?.model?.faces.find((f) => f.face_index === a.face_index)?.is_land,
      )
    )
      return fail("No further spells may be paid after terminal success.");
    const checked = checkManaPaymentWitness({
      sources,
      actions: turn.actions,
      cost,
      payment: turn.cast?.payment ?? [],
    });
    if (!checked.ok) return fail(`Turn ${turn.turn}: ${checked.reasons.join(" ")}`);
    if (
      JSON.stringify(counts(turn.pool)) !== JSON.stringify(counts(checked.pool)) ||
      turn.pool.some((m) => !MANA_TYPES.includes(m))
    )
      return fail("Turn residual mana disagrees with its payment witness.");
    for (const action of turn.actions) {
      if (action.kind === "play") {
        if (!hand.delete(action.source_id)) return fail("Played physical card is not in hand.");
        battlefield.set(action.source_id, action.face_index);
        if (
          !byId.get(action.source_id)?.model?.faces.find((f) => f.face_index === action.face_index)
            ?.is_land
        )
          first ??= turn.turn;
      } else if (action.kind === "fetch") {
        const targetIndex = deck.indexOf(action.target_id);
        if (targetIndex < 0 || !battlefield.delete(action.source_id))
          return fail("Fetch violates the physical zone ledger.");
        deck.splice(targetIndex, 1);
        battlefield.set(action.target_id, 0);
      }
    }
    if (turn.cast) {
      const available = turn.cast.zone === "command" ? command : hand;
      if (!available.delete(turn.cast.source_id))
        return fail("Terminal physical card was already used by another action.");
      first ??= turn.turn;
      castTurn = turn.turn;
    }
    const landCount = [...battlefield].filter(
      ([id, faceIndex]) =>
        byId.get(id)?.model?.faces.find((f) => f.face_index === faceIndex)?.is_land,
    ).length;
    if (turn.lands_in_play !== landCount)
      return fail("Land count disagrees with the physical battlefield ledger.");
  }
  if (
    result.first_spell_turn !== first ||
    result.target_cast_turn !== castTurn ||
    (result.status !== "truncated" && (result.status === "success") !== (castTurn !== null))
  )
    return fail("Summary success or spell-turn claims disagree with replayed casts.");
  return { ok: true, reasons: [] };
}
