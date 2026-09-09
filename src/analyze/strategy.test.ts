import { describe, expect, it } from "vitest";
import { mapScryfallCard, type ScryfallCardRaw } from "../index/map.js";
import type { Card, Deck } from "../types/index.js";
import { analyzeStrategy, STRATEGY_LIMITS, SUPPORTED_STRATEGY_EDGES } from "./strategy.js";

/** These are explicitly synthetic Oracle-text probes, not claims about named printed cards. */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected fixture or report item");
  return value;
}
function probe(name: string, oracle_text: string, type_line = "Creature — Human"): Card {
  return mapScryfallCard({
    oracle_id: name,
    id: `print-${name}`,
    name,
    oracle_text,
    type_line,
    layout: "normal",
    color_identity: [],
    colors: [],
    keywords: [],
    legalities: { commander: "legal" },
  });
}
function report(commander: Card, cards: Card[], patch: Partial<Deck> = {}) {
  const all = new Map([commander, ...cards].map((c) => [c.oracle_id, c]));
  const deck: Deck = {
    deck_id: "strategy-probe",
    name: "Synthetic strategy corpus",
    format: "commander",
    commanders: [commander.oracle_id],
    command_zone_kind: "single",
    cards: cards.map((c) => ({ oracle_id: c.oracle_id, qty: 1 })),
    computed_color_identity: [],
    version: 1,
    data_snapshot: "2026-09-08",
    ...patch,
  };
  return analyzeStrategy(deck, (id) => all.get(id) ?? null);
}
const tokens = probe(
  "Creature Token Probe",
  "Create two 1/1 white Soldier creature tokens.",
  "Sorcery",
);
const clue = probe("Clue Probe", "Investigate.", "Sorcery");
const outlet = probe("Sacrifice Outlet Probe", "Sacrifice a creature: Add {C}{C}.", "Artifact");
const draw = probe("Draw Probe", "Draw two cards.", "Sorcery");
const gain = probe("Lifegain Probe", "You gain 3 life.", "Sorcery");
const mill = probe("Self Mill Probe", "You mill three cards.", "Sorcery");
const inert = probe("Unknown Probe", "Choose a color. Exchange control of two target permanents.");

const pairs = [
  {
    name: "draw payoff versus life supply",
    commander: probe(
      "Draw Commander Probe",
      "Whenever you draw a card, each opponent loses 1 life.",
    ),
    yes: draw,
    no: gain,
    kind: "draw_trigger",
  },
  {
    name: "lifegain payoff versus draw supply",
    commander: probe("Life Commander Probe", "Whenever you gain life, each opponent loses 1 life."),
    yes: gain,
    no: draw,
    kind: "lifegain_trigger",
  },
  {
    name: "discard payoff versus self mill",
    commander: probe(
      "Discard Commander Probe",
      "Whenever you discard a card, each opponent loses 1 life.",
    ),
    yes: probe("Discard Probe", "Discard a card.", "Sorcery"),
    no: mill,
    kind: "discard_trigger",
  },
  {
    name: "sacrifice payoff versus token creation alone",
    commander: probe(
      "Sacrifice Commander Probe",
      "Whenever you sacrifice a permanent, each opponent loses 1 life.",
    ),
    yes: outlet,
    no: tokens,
    kind: "sacrifice_trigger",
  },
  {
    name: "creature death payoff versus noncreature sacrifice",
    commander: probe(
      "Death Commander Probe",
      "Whenever another creature you control dies, each opponent loses 1 life.",
    ),
    yes: outlet,
    no: probe("Artifact Sacrifice Probe", "Sacrifice an artifact: Draw a card."),
    kind: "death_trigger",
  },
  {
    name: "token payoff versus draw supply",
    commander: probe(
      "Token Commander Probe",
      "Whenever you create a token, each opponent loses 1 life.",
    ),
    yes: tokens,
    no: draw,
    kind: "token_trigger",
  },
  {
    name: "creature sacrifice engine versus Clue supply",
    commander: probe("Outlet Commander Probe", "Sacrifice a creature: Draw a card."),
    yes: tokens,
    no: clue,
    kind: "token_sacrifice",
  },
  {
    name: "artifact tapping engine versus creature-only tokens",
    commander: probe("Tap Commander Probe", "Tap an untapped artifact you control: Draw a card."),
    yes: clue,
    no: tokens,
    kind: "token_tap",
  },
  {
    name: "graveyard recovery versus opponent mill",
    commander: probe(
      "Recursion Commander Probe",
      "Return target card from your graveyard to your hand.",
    ),
    yes: mill,
    no: probe("Opponent Mill Probe", "Target opponent mills three cards.", "Sorcery"),
    kind: "graveyard_supply",
  },
  {
    name: "counter removal engine versus wrong counter type",
    commander: probe(
      "Counter Commander Probe",
      "Remove a +1/+1 counter from Counter Commander Probe: Draw a card.",
    ),
    yes: probe("Counter Placement Probe", "Put a +1/+1 counter on target creature.", "Sorcery"),
    no: probe("Charge Placement Probe", "Put a charge counter on target creature.", "Sorcery"),
    kind: "counter_cost",
  },
];

describe("strategy same-commander contrast corpus (ten synthetic Oracle-text pairs)", () => {
  it.each(pairs)("$name", ({ commander, yes, no, kind }) => {
    const filler = probe("Shared Basic Land Probe", "", "Basic Land — Plains");
    const sharedPackage = [inert, filler];
    const supported = report(commander, [...sharedPackage, yes], {
      cards: [
        { oracle_id: filler.oracle_id, qty: 97 },
        { oracle_id: inert.oracle_id, qty: 1 },
        { oracle_id: yes.oracle_id, qty: 1 },
      ],
    });
    const unsupported = report(commander, [...sharedPackage, no], {
      cards: [
        { oracle_id: filler.oracle_id, qty: 97 },
        { oracle_id: inert.oracle_id, qty: 1 },
        { oracle_id: no.oracle_id, qty: 1 },
      ],
    });
    expect(supported.edges.some((e) => e.kind === kind && e.target === commander.oracle_id)).toBe(
      true,
    );
    expect(unsupported.edges.some((e) => e.kind === kind && e.target === commander.oracle_id)).toBe(
      false,
    );
    const theme = required(SUPPORTED_STRATEGY_EDGES.find((p) => p.id === kind)).theme;
    expect(supported.game_plan.some((plan) => plan.theme === theme)).toBe(true);
    expect(unsupported.game_plan.some((plan) => plan.theme === theme)).toBe(false);
    expect(supported.coverage.known_quantity).toBe(100);
  });
});

describe("strategy evidence, failure modes and declared intent", () => {
  it("preserves exact source evidence, faces, ability requirements and stable serialization", () => {
    const commander = required(pairs[0]).commander;
    const result = report(commander, [draw]);
    for (const edge of result.edges) {
      expect(SUPPORTED_STRATEGY_EDGES.some((p) => p.id === edge.kind)).toBe(true);
      expect(edge.status).toBe("candidate_support");
      for (const annotation of [edge.evidence.source, edge.evidence.target]) {
        const card = required(
          [commander, draw].find((c) => c.oracle_id === annotation.evidence.oracle_id),
        );
        expect(card.oracle_text.slice(annotation.evidence.start, annotation.evidence.end)).toBe(
          annotation.evidence.text,
        );
        expect(annotation.face_index).toBe(0);
        expect(annotation.ability_index).toBeGreaterThanOrEqual(0);
        expect(annotation.condition).toBeDefined();
      }
    }
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(report(commander, [draw])).toEqual(result);
  });

  it("updates dependency bottlenecks when one of two distinct supplies is removed", () => {
    const commander = required(pairs[6]).commander;
    const second = probe(
      "Recurring Token Probe",
      "At the beginning of your upkeep, create a 1/1 green Saproling creature token.",
    );
    const many = report(commander, [tokens, second]);
    const one = report(commander, [tokens]);
    const none = report(commander, [inert]);
    const dep = (r: ReturnType<typeof report>) =>
      required(r.dependencies.find((d) => d.requirement.kind === "sacrifice_permanent"));
    expect(dep(many)).toMatchObject({ status: "redundant_sources", provider_quantity: 2 });
    expect(dep(one)).toMatchObject({ status: "single_source", provider_quantity: 1 });
    expect(dep(none)).toMatchObject({ status: "missing_local_support", provider_quantity: 0 });
    expect(many.redundancy).toContainEqual(dep(many));
    expect(one.bottlenecks).toContainEqual(dep(one));
    const repeated = report(commander, [tokens], {
      cards: [{ oracle_id: tokens.oracle_id, qty: 4 }],
    });
    expect(dep(repeated)).toMatchObject({ status: "single_source", provider_quantity: 4 });
  });

  it("includes every commander once, aggregates library quantities, and reports missing identities", () => {
    const commander = required(pairs[6]).commander;
    const result = report(commander, [tokens, outlet], {
      commanders: [commander.oracle_id, outlet.oracle_id],
      command_zone_kind: "partner",
      cards: [
        { oracle_id: commander.oracle_id, qty: 1 },
        { oracle_id: tokens.oracle_id, qty: 2 },
        { oracle_id: tokens.oracle_id, qty: 3 },
        { oracle_id: "missing", qty: 1 },
      ],
    });
    expect(result.nodes.filter((n) => n.zone === "command").map((n) => n.oracle_id)).toEqual([
      commander.oracle_id,
      outlet.oracle_id,
    ]);
    expect(result.nodes.find((n) => n.oracle_id === commander.oracle_id)?.quantity).toBe(1);
    expect(result.nodes.find((n) => n.oracle_id === tokens.oracle_id)?.quantity).toBe(5);
    expect(result.coverage.missing_cards).toContainEqual({
      oracle_id: "missing",
      quantity: 1,
      zone: "library",
    });
  });

  it("retains unconventional intent and role corrections without inventing mechanical links", () => {
    const commander = required(pairs[6]).commander;
    const intent = {
      schema_version: 1 as const,
      hard: { locked_cards: [{ oracle_id: inert.oracle_id, qty: 1 }] },
      soft: {
        strategy: "Creatureless Clue politics",
        goals: ["Keep my favorite card"],
        favorites: [{ oracle_id: clue.oracle_id, qty: 1 }],
        role_targets: { ramp: { min: 0, max: 0 } },
      },
    };
    const result = report(commander, [inert, clue], {
      intent,
      role_overrides: { [inert.oracle_id]: ["wincon", "protection"] },
    });
    expect(result.declared_intent.intent).toEqual(intent);
    expect(result.declared_intent.effective_role_targets.ramp).toEqual({ min: 0, max: 0 });
    expect(result.nodes.find((n) => n.oracle_id === inert.oracle_id)).toMatchObject({
      locked_quantity: 1,
      roles: { effective_roles: ["wincon", "protection"], role_source: "user_override" },
    });
    expect(result.nodes.find((n) => n.oracle_id === clue.oracle_id)?.favorite_quantity).toBe(1);
    expect(result.edges).toEqual([]);
    expect(
      result.win_condition_requirements.some(
        (w) => w.oracle_id === inert.oracle_id && w.status === "role_only_unknown",
      ),
    ).toBe(true);
  });

  it("reports competition and recovery as conditional candidates without asserting execution", () => {
    const commander = required(pairs[6]).commander;
    const recover = probe(
      "Recovery Probe",
      "Return target card from your graveyard to your hand.",
      "Sorcery",
    );
    const result = report(commander, [tokens, outlet, recover]);
    expect(
      result.conflicts.some(
        (c) =>
          c.kind === "possible_resource_competition" &&
          c.consumer_ids.includes(outlet.oracle_id) &&
          c.consumer_ids.includes(commander.oracle_id),
      ),
    ).toBe(true);
    expect(
      result.recovery_options.some(
        (r) => r.oracle_id === recover.oracle_id && r.status === "candidate_not_verified",
      ),
    ).toBe(true);
    expect(result.limitations.join(" ")).toMatch(/infinite|infinity/i);
  });

  it("does not treat alternative faces, nontoken filters, self counters or opponents as matching supply", () => {
    const modal = mapScryfallCard({
      oracle_id: "modal",
      id: "modal-print",
      name: "Two Faces Probe",
      layout: "modal_dfc",
      card_faces: [
        {
          name: "Token Face Probe",
          type_line: "Sorcery",
          oracle_text: "Create a 1/1 white Soldier creature token.",
        },
        {
          name: "Outlet Face Probe",
          type_line: "Creature",
          oracle_text: "Sacrifice a creature: Draw a card.",
        },
      ],
      legalities: { commander: "legal" },
      color_identity: [],
    } as ScryfallCardRaw);
    expect(report(modal, []).edges).toEqual([]);
    const nontoken = probe("Nontoken Cost Probe", "Sacrifice a nontoken creature: Draw a card.");
    expect(report(nontoken, [tokens]).edges).toEqual([]);
    const selfCounter = probe("Self Counter Probe", "Put a +1/+1 counter on Self Counter Probe.");
    expect(report(required(pairs[9]).commander, [selfCounter]).edges).toEqual([]);
    expect(
      report(required(pairs[0]).commander, [
        probe("Opponent Draw Probe", "Each opponent draws a card."),
      ]).edges,
    ).toEqual([]);
  });

  it("keeps self-resource payments independent and excludes self death from another-creature triggers", () => {
    const self = probe(
      "Self Sacrifice Probe",
      "{1}, Sacrifice Self Sacrifice Probe: Draw a card.\nWhenever another creature you control dies, you gain 1 life.",
    );
    expect(report(self, []).edges.some((e) => e.kind === "death_trigger")).toBe(false);
    const dork = probe("Mana Creature Probe", "{T}: Add {G}.");
    const other = probe("Other Mana Creature Probe", "{T}: Add {G}.");
    expect(report(dork, [other]).conflicts).toEqual([]);
  });

  it("distinguishes supported Oracle annotations from filters outside the graph catalog", () => {
    const commander = probe(
      "Restricted Sacrifice Probe",
      "Sacrifice a legendary Zombie: Draw a card.",
    );
    const result = report(commander, [tokens]);
    expect(
      result.dependencies.find((d) => d.requirement.kind === "sacrifice_permanent")?.status,
    ).toBe("not_modeled");
    expect(result.coverage.graph_unmodeled_requirements).toBeGreaterThan(0);
    expect(result.edges).toEqual([]);
  });

  it.each([
    {
      source: probe("Restricted Discard Supply Probe", "Discard a card."),
      text: "Whenever you discard a card with mana value 3 or greater, each opponent loses 1 life.",
      kind: "discard",
    },
    {
      source: probe("Small Lifegain Supply Probe", "You gain 1 life."),
      text: "Whenever you gain 3 or more life, each opponent loses 1 life.",
      kind: "lifegain",
    },
    {
      source: draw,
      text: "Whenever you draw your second card each turn, each opponent loses 1 life.",
      kind: "draw",
    },
  ])("leaves restricted $kind events outside the graph catalog", ({ source, text, kind }) => {
    const commander = probe("Restricted Scalar Event Probe", text);
    const result = report(commander, [source]);
    expect(result.edges).toEqual([]);
    expect(result.dependencies.find((d) => d.requirement.kind === kind)?.status).toBe(
      "not_modeled",
    );
  });

  it("retains generic scalar events across matching controller, opponent and any-player subjects", () => {
    const cases = [
      {
        source: probe("Any Draw Supply Probe", "Each player draws a card."),
        text: "Whenever an opponent draws a card, you gain 1 life.",
        kind: "draw_trigger",
      },
      {
        source: gain,
        text: "Whenever a player gains life, draw a card.",
        kind: "lifegain_trigger",
      },
      {
        source: probe("Own Discard Supply Probe", "Discard a card."),
        text: "Whenever you discard a card, each opponent loses 1 life.",
        kind: "discard_trigger",
      },
    ];
    for (const { source, text, kind } of cases) {
      expect(
        report(probe("Generic Scalar Event Probe", text), [source]).edges.some(
          (e) => e.kind === kind,
        ),
      ).toBe(true);
    }
  });

  it.each([
    "Whenever another Zombie creature you control dies, you gain 1 life.",
    "Whenever another creature you control with power 4 or greater dies, you gain 1 life.",
    "Whenever you sacrifice another creature with flying, you gain 1 life.",
  ])("rejects lossy death and sacrifice filters: %s", (text) => {
    const commander = probe("Restricted Event Probe", text);
    const result = report(commander, [outlet]);
    expect(
      result.edges.filter((e) => ["death_trigger", "sacrifice_trigger"].includes(e.kind)),
    ).toEqual([]);
    expect(
      result.dependencies.find((d) => ["dies", "sacrifice"].includes(d.requirement.kind))?.status,
    ).toBe("not_modeled");
  });

  it("retains another-artifact-creature event restrictions rather than matching any creature", () => {
    const commander = probe(
      "Artifact Death Probe",
      "Whenever another artifact creature you control dies, you gain 1 life.",
    );
    expect(report(commander, [outlet]).edges.some((e) => e.kind === "death_trigger")).toBe(false);
    const restricted = probe(
      "Artifact Creature Sacrifice Probe",
      "Sacrifice an artifact creature: Draw a card.",
    );
    expect(report(commander, [restricted]).edges.some((e) => e.kind === "death_trigger")).toBe(
      true,
    );
  });

  it("records a graveyard dependency for an exile effect reached by supply edges", () => {
    const commander = probe("Graveyard Exile Probe", "Exile a card from your graveyard.");
    const result = report(commander, [mill]);
    const edge = required(result.edges.find((e) => e.kind === "graveyard_supply"));
    expect(
      result.dependencies.find(
        (d) => d.oracle_id === edge.target && d.annotation_index === edge.target_annotation,
      ),
    ).toMatchObject({
      requirement: { kind: "exile_from_graveyard", category: "effect" },
      status: "single_source",
      provider_ids: [mill.oracle_id],
    });
  });

  it("bounds returned graph edges while deriving dependency counts from every analyzed candidate", () => {
    const donors = Array.from({ length: 25 }, (_, i) =>
      probe(`Draw Supply ${i} Probe`, "Draw a card.", "Sorcery"),
    );
    const consumers = Array.from({ length: 25 }, (_, i) =>
      probe(`Draw Consumer ${i} Probe`, "Whenever you draw a card, each opponent loses 1 life."),
    );
    const result = report(inert, [...donors, ...consumers]);
    expect(result.coverage).toMatchObject({
      edge_count: 625,
      returned_edge_count: STRATEGY_LIMITS.edges,
      edges_truncated: true,
      analysis_truncated: false,
    });
    expect(
      result.dependencies
        .filter((d) => d.requirement.kind === "draw")
        .every(
          (d) =>
            d.provider_ids.length === 25 &&
            d.provider_quantity === 25 &&
            d.status === "redundant_sources",
        ),
    ).toBe(true);
    const returned = new Set(result.edges.map((e) => e.id));
    expect(result.game_plan.flatMap((p) => p.edge_ids).every((id) => returned.has(id))).toBe(true);
  });

  it("marks incomplete provider search when oversized persisted inventory exceeds analysis bounds", () => {
    const commander = required(pairs[0]).commander;
    const fillers = Array.from({ length: STRATEGY_LIMITS.cards }, (_, i) =>
      probe(`Oversized Filler ${i} Probe`, "", "Land"),
    );
    const result = report(commander, [...fillers, draw]);
    expect(result.coverage).toMatchObject({
      analysis_truncated: true,
      skipped_cards: 2,
      provider_search_complete: false,
    });
    expect(result.dependencies.find((d) => d.requirement.kind === "draw")).toMatchObject({
      status: "unknown_incomplete",
      provider_search_complete: false,
    });
    expect(result.bottlenecks.some((d) => d.requirement.kind === "draw")).toBe(false);
  });

  it("keeps triggered source setup and win-route costs unresolved even in a connected graph", () => {
    const death = required(pairs[4]).commander;
    const dependent = probe(
      "Death Token Probe",
      "Whenever another creature you control dies, create a 1/1 white Spirit creature token.",
    );
    const result = report(death, [dependent, outlet]);
    expect(
      result.edges
        .find((e) => e.source === dependent.oracle_id && e.kind === "token_sacrifice")
        ?.requirements.join(" "),
    ).toMatch(/trigger/i);
    expect(
      result.win_condition_requirements.find((w) => w.oracle_id === death.oracle_id),
    ).toMatchObject({ status: "candidate_not_verified", setup: "not_evaluated" });
    expect(
      result.win_condition_requirements
        .find((w) => w.oracle_id === death.oracle_id)
        ?.requirements.some((a) => a.kind === "dies"),
    ).toBe(true);
    expect(result.coverage.unmodeled_spans).toBeGreaterThanOrEqual(0);
  });
});
