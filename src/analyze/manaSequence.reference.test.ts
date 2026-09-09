import { describe, expect, it } from "vitest";
import { manaFixtures, manaCard } from "./manaModel.fixture.js";
import { modelCardMana } from "./manaModel.js";
import { sequenceMana, type ManaSequenceResult, type SequenceCard } from "./manaSequence.js";

// This tiny reference uses literal fixture semantics, individual mana tokens,
// and exhaustive legal transitions. It does not call the production payment
// allocator, model parser for its rules, or sequence replay checker.
type Token = "G" | "U" | "W" | "C";
interface Price {
  generic: number;
  colored: Token[];
}
interface Face {
  land: boolean;
  price: Price;
  outputs: Token[][];
  tapped?: boolean;
  delay?: boolean;
  activation?: Price;
}
interface ExampleCard {
  id: string;
  faces: Face[];
  physical: SequenceCard;
}
interface BoardCard {
  id: string;
  face: number;
  tapped: boolean;
  fresh: boolean;
}
interface State {
  hand: string[];
  board: BoardCard[];
  pool: Token[];
  landPlayed: boolean;
}
interface Action {
  kind: "play" | "activate";
  source_id: string;
  face_index?: number;
  output_index?: number;
  payment: Token[];
}
const free: Price = { generic: 0, colored: [] };
const price = (generic: number, ...colored: Token[]): Price => ({ generic, colored });
const land = (...outputs: Token[]): Face => ({
  land: true,
  price: free,
  outputs: outputs.map((m) => [m]),
});
const source = (cost: Price, ...output: Token[]): Face => ({
  land: false,
  price: cost,
  outputs: [output],
});
const semantics: Partial<Record<keyof typeof manaFixtures, Face[]>> = {
  forest: [land("G")],
  island: [land("U")],
  wastes: [land("C")],
  tropical: [land("G", "U")],
  guildgate: [{ ...land("W", "U"), tapped: true }],
  ring: [source(price(1), "C", "C")],
  diamond: [{ ...source(price(2), "U"), tapped: true }],
  signet: [{ ...source(price(2), "W", "U"), activation: price(1) }],
  elves: [{ ...source(price(0, "G"), "G"), delay: true }],
  pathway: [land("G"), land("U")],
  tangled: [
    { ...source(price(1, "G"), "G"), delay: true },
    { ...land("G"), tapped: true },
  ],
};
function example(key: keyof typeof manaFixtures, id: string): ExampleCard {
  const faces = semantics[key];
  if (!faces) throw new Error(`No independent semantics for ${key}`);
  return { id, faces, physical: { id, model: modelCardMana(manaFixtures[key]) } };
}
function target(cost: Price): ExampleCard {
  const raw = `{${cost.generic}}${cost.colored.map((m) => `{${m}}`).join("")}`;
  return {
    id: "target",
    faces: [{ land: false, price: cost, outputs: [] }],
    physical: {
      id: "target",
      model: modelCardMana(
        manaCard("target", { type_line: "Sorcery", mana_cost: raw, oracle_text: "Draw a card." }),
      ),
    },
  };
}
const canonical = (tokens: readonly string[]) => [...tokens].sort().join("");

/** Enumerate subsets of actual tokens, then check the literal required colors. */
function payments(pool: Token[], cost: Price): { payment: Token[]; pool: Token[] }[] {
  const size = cost.generic + cost.colored.length;
  const answers = new Map<string, { payment: Token[]; pool: Token[] }>();
  for (let mask = 0; mask < 2 ** pool.length; mask++) {
    const paid = pool.filter((_, index) => (mask & (1 << index)) !== 0);
    if (paid.length !== size) continue;
    const required = [...paid];
    let fits = true;
    for (const color of cost.colored) {
      const index = required.indexOf(color);
      if (index < 0) {
        fits = false;
        break;
      }
      required.splice(index, 1);
    }
    if (fits)
      answers.set(canonical(paid), {
        payment: paid,
        pool: pool.filter((_, index) => (mask & (1 << index)) === 0),
      });
  }
  return [...answers.values()];
}
function transitions(state: State, cards: ExampleCard[]): { action: Action; state: State }[] {
  const next: { action: Action; state: State }[] = [];
  for (const card of cards) {
    if (card.id === "target") continue;
    if (state.hand.includes(card.id)) {
      for (const [index, face] of card.faces.entries()) {
        if (face.land && state.landPlayed) continue;
        for (const paid of payments(state.pool, face.land ? free : face.price)) {
          next.push({
            action: { kind: "play", source_id: card.id, face_index: index, payment: paid.payment },
            state: {
              hand: state.hand.filter((id) => id !== card.id),
              board: [
                ...state.board,
                { id: card.id, face: index, tapped: face.tapped ?? false, fresh: true },
              ],
              pool: paid.pool,
              landPlayed: state.landPlayed || face.land,
            },
          });
        }
      }
    }
    const permanent = state.board.find((item) => item.id === card.id);
    const face = permanent && card.faces[permanent.face];
    if (!permanent || !face || permanent.tapped || (permanent.fresh && face.delay)) continue;
    for (const paid of payments(state.pool, face.activation ?? free)) {
      for (const [index, output] of face.outputs.entries()) {
        next.push({
          action: {
            kind: "activate",
            source_id: card.id,
            output_index: index,
            payment: paid.payment,
          },
          state: {
            ...state,
            board: state.board.map((item) =>
              item.id === card.id ? { ...item, tapped: true } : item,
            ),
            pool: [...paid.pool, ...output],
          },
        });
      }
    }
  }
  return next;
}
const key = (state: State) =>
  JSON.stringify({
    ...state,
    hand: [...state.hand].sort(),
    pool: canonical(state.pool),
    board: [...state.board].sort((a, b) => a.id.localeCompare(b.id)),
  });
const nextTurn = (state: State): State => ({
  ...state,
  landPlayed: false,
  pool: [],
  board: state.board.map((c) => ({ ...c, fresh: false, tapped: false })),
});
const initial = (cards: ExampleCard[], command: boolean): State => ({
  hand: cards.filter((c) => !command || c.id !== "target").map((c) => c.id),
  board: [],
  pool: [],
  landPlayed: false,
});

function earliest(
  cards: ExampleCard[],
  cost: Price,
  maxTurns: number,
  command: boolean,
): number | null {
  let starts = [initial(cards, command)];
  for (let turn = 1; turn <= maxTurns; turn++) {
    const queue = starts.map(nextTurn);
    const visited = new Set(queue.map(key));
    for (let index = 0; index < queue.length; index++) {
      const state = queue[index];
      if (!state) throw new Error("Reference queue lost a state");
      if ((command || state.hand.includes("target")) && payments(state.pool, cost).length)
        return turn;
      for (const candidate of transitions(state, cards)) {
        const identity = key(candidate.state);
        if (!visited.has(identity)) {
          visited.add(identity);
          queue.push(candidate.state);
        }
      }
      if (queue.length > 25000)
        throw new Error("Tiny exhaustive fixture grew beyond its intended scope");
    }
    starts = [
      ...new Map(
        queue.map((state) => {
          const next = nextTurn(state);
          return [key(next), next];
        }),
      ).values(),
    ];
  }
  return null;
}

function referenceReplay(
  cards: ExampleCard[],
  cost: Price,
  command: boolean,
  result: ManaSequenceResult,
): void {
  let state = initial(cards, command);
  let terminalCast = false;
  for (const turn of result.turns) {
    state = nextTurn(state);
    expect(turn.drawn).toBeNull(); // All library cards are in this fixture's initial hand.
    for (const action of turn.actions) {
      const found = transitions(state, cards).find(
        (candidate) =>
          candidate.action.kind === action.kind &&
          candidate.action.source_id === action.source_id &&
          (action.kind !== "play" || candidate.action.face_index === action.face_index) &&
          (action.kind !== "activate" || candidate.action.output_index === action.output_index) &&
          canonical(candidate.action.payment) === canonical(action.payment ?? []),
      );
      expect(found, `independent legal transition for ${JSON.stringify(action)}`).toBeDefined();
      if (!found) throw new Error("Illegal production transition");
      state = found.state;
    }
    if (turn.cast) {
      expect(terminalCast).toBe(false);
      expect(turn.cast.source_id).toBe("target");
      expect(turn.cast.zone).toBe(command ? "command" : "library");
      expect(command || state.hand.includes("target")).toBe(true);
      const paid = payments(state.pool, cost).find(
        (p) => canonical(p.payment) === canonical(turn.cast?.payment ?? []),
      );
      expect(paid).toBeDefined();
      if (!paid) throw new Error("Illegal production target payment");
      state = { ...state, hand: state.hand.filter((id) => id !== "target"), pool: paid.pool };
      terminalCast = true;
    }
    expect(canonical(turn.pool)).toBe(canonical(state.pool));
    expect(turn.lands_in_play).toBe(
      state.board.filter((p) => cards.find((c) => c.id === p.id)?.faces[p.face]?.land).length,
    );
  }
}

const cases: {
  name: string;
  sources: (keyof typeof manaFixtures)[];
  price: Price;
  turns: number;
  expected: number | null;
  command?: boolean;
}[] = [
  {
    name: "basic required color",
    sources: ["forest"],
    price: price(0, "G"),
    turns: 1,
    expected: 1,
  },
  {
    name: "wrong basic color",
    sources: ["island"],
    price: price(0, "G"),
    turns: 2,
    expected: null,
  },
  {
    name: "flexible dual cannot produce twice",
    sources: ["tropical"],
    price: price(0, "G", "U"),
    turns: 2,
    expected: null,
  },
  {
    name: "dual and basic allocation",
    sources: ["tropical", "forest"],
    price: price(0, "G", "U"),
    turns: 2,
    expected: 2,
  },
  {
    name: "tapped land delay",
    sources: ["guildgate"],
    price: price(0, "U"),
    turns: 2,
    expected: 2,
  },
  {
    name: "rock casting consumes its land",
    sources: ["wastes", "ring"],
    price: price(3),
    turns: 2,
    expected: 2,
  },
  {
    name: "rock chain retains excess",
    sources: ["wastes", "ring", "ring"],
    price: price(3),
    turns: 1,
    expected: 1,
  },
  {
    name: "creature source waits",
    sources: ["forest", "elves"],
    price: price(0, "G", "G"),
    turns: 2,
    expected: 2,
  },
  {
    name: "paid tapped artifact waits",
    sources: ["wastes", "wastes", "diamond"],
    price: price(0, "U"),
    turns: 3,
    expected: 3,
  },
  {
    name: "signet activation consumes mana",
    sources: ["wastes", "wastes", "signet"],
    price: price(0, "W", "U"),
    turns: 3,
    expected: 3,
  },
  {
    name: "spell and land MDFC exclusivity",
    sources: ["tangled", "forest"],
    price: price(0, "G", "G"),
    turns: 2,
    expected: 2,
  },
  {
    name: "commander access",
    sources: ["forest"],
    price: price(0, "G"),
    turns: 1,
    expected: 1,
    command: true,
  },
];
describe("independent tiny exhaustive sequencing reference", () => {
  it.each(cases)("agrees on $name and independently replays every emitted action", (fixture) => {
    const cards = [
      ...fixture.sources.map((s, i) => example(s, `source-${i}`)),
      target(fixture.price),
    ];
    const command = fixture.command ?? false;
    const library = cards.filter((c) => !command || c.id !== "target").map((c) => c.physical);
    const commanders = command ? cards.filter((c) => c.id === "target").map((c) => c.physical) : [];
    const result = sequenceMana(library, commanders, {
      handSize: library.length,
      maxTurns: fixture.turns,
      target: { oracle_id: "target", zone: command ? "command" : "library" },
    });
    expect(earliest(cards, fixture.price, fixture.turns, command)).toBe(fixture.expected);
    expect(result.target_cast_turn).toBe(fixture.expected);
    expect(result.status).toBe(fixture.expected === null ? "failure" : "success");
    referenceReplay(cards, fixture.price, command, result);
  });
  it("recognizes the declared first-face policy can miss a legal MDFC line", () => {
    const cards = [example("pathway", "source"), target(price(0, "U"))];
    const result = sequenceMana(
      cards.map((c) => c.physical),
      [],
      { handSize: 2, maxTurns: 1, target: { oracle_id: "target" } },
    );
    expect(earliest(cards, price(0, "U"), 1, false)).toBe(1);
    expect(result.status).toBe("failure");
    expect(result.target_cast_turn).toBeNull();
    referenceReplay(cards, price(0, "U"), false, result);
  });
});
