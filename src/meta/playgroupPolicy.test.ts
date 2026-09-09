import { describe, expect, it } from "vitest";
import { DeckIntentSchema } from "../deck/intent.js";
import { PlaygroupPolicySchema } from "../deck/playgroupPolicy.js";
import type { Card, Deck } from "../types/index.js";
import type { Combo } from "./spellbook.js";
import type { ComboApplicability } from "./comboApplicability.js";
import {
  compilePlaygroupPolicy,
  evaluatePlaygroupPolicy,
  type PolicyEvidence,
} from "./playgroupPolicy.js";

function card(id: string, values: Partial<Card> = {}): Card {
  return {
    oracle_id: id,
    name: id,
    mana_cost: "",
    mv: 1,
    colors: [],
    color_identity: [],
    type_line: "Artifact",
    oracle_text: "",
    keywords: [],
    legalities: { commander: "legal" },
    prices: {},
    is_commander_eligible: false,
    roles: [],
    printings: [],
    ...values,
  };
}
function deck(intent: unknown, cards: Deck["cards"] = []): Deck {
  return {
    deck_id: "policy",
    name: "Policy",
    format: "commander",
    commanders: [],
    command_zone_kind: "single",
    cards,
    computed_color_identity: [],
    version: 1,
    data_snapshot: "2026-09-08",
    ...(intent === undefined ? {} : { intent: DeckIntentSchema.parse(intent) }),
  };
}
function evidence(overrides: Partial<PolicyEvidence> = {}): PolicyEvidence {
  return {
    game_changers: { names: new Set(), source: { type: "fixture" }, complete: true },
    combos: {
      status: "available",
      candidates: [],
      freshness: null,
      coverage: {
        status: "complete",
        provider_non_exhaustive: true,
        missing_categories: [],
        next: null,
        total_count: 0,
      },
      error: null,
    },
    data_snapshot: "2026-09-08",
    ...overrides,
  };
}
function combo(
  id: string,
  configuration: ComboApplicability["deck_configuration"] = "satisfied",
  infinite = true,
): Combo & { applicability: ComboApplicability } {
  const ingredient = {
    quantity: 1,
    zone_locations: ["B"],
    battlefield_card_state: "",
    exile_card_state: "",
    library_card_state: "",
    graveyard_card_state: "",
    must_be_commander: false,
    missing_fields: [],
    used_face: null,
  };
  return {
    id,
    pieces: ["A", "B"],
    produces: [infinite ? "Infinite mana" : "Win the game"],
    source: "commander_spellbook",
    url: `https://commanderspellbook.com/combo/${id}/`,
    source_url: "https://backend.commanderspellbook.com/find-my-combos",
    status: "OK",
    uses: ["A", "B"].map((name, i) => ({ ...ingredient, card: { id: i, oracle_id: name, name } })),
    requires: [],
    outputs: [
      {
        feature: {
          id: 1,
          name: infinite ? "Infinite mana" : "Win the game",
          uncountable: infinite,
          status: "H",
        },
        quantity: 1,
        missing_fields: [],
      },
    ],
    mana_needed: "",
    mana_value_needed: 0,
    easy_prerequisites: "",
    notable_prerequisites: "",
    description: "",
    notes: "",
    provider_category: "included",
    missing_fields: [],
    applicability: {
      listed_pieces_present: "satisfied",
      deck_configuration: configuration,
      setup_prerequisites: "unknown",
      executable_now: "unknown",
      ingredients: [],
      issues: [],
      limitations: [],
    },
  };
}
const noLookup = (): null => null;
const intent = (playgroup: unknown) => ({ schema_version: 1, playgroup });

describe("playgroup policy schema and compiler", () => {
  it.each([
    {},
    { profile: "casual" },
    { profile: "thematic", bracket: 1 },
    { bracket: 5, limits: { tutors: 100, fast_mana: 0 } },
  ])("accepts bounded declarations %j", (value) => {
    expect(PlaygroupPolicySchema.parse(value)).toEqual(value);
  });
  it.each([
    { bracket: 0 },
    { bracket: 6 },
    { bracket: 1.5 },
    { profile: "optimized" },
    { limits: { tutors: -1 } },
    { limits: { fast_mana: 101 } },
    { limits: { extra_turns: 0.5 } },
    { limits: { mana: 2 } },
    { banlist: [] },
  ])("rejects invalid policy %j", (value) => {
    expect(PlaygroupPolicySchema.safeParse(value).success).toBe(false);
  });
  it("keeps construction constraints, soft thematic goals, and unevaluated prose separate", () => {
    const source = DeckIntentSchema.parse({
      ...intent({ profile: "thematic" }),
      hard: { excluded_cards: ["X"], locked_cards: [{ oracle_id: "A", qty: 2 }], change_limit: 3 },
      soft: {
        strategy: "cats",
        goals: ["tell a story"],
        favorites: [{ oracle_id: "B", qty: 1 }],
        playgroup_preferences: ["no repetitive turns"],
      },
      unsupported: ["win exactly on turn 8"],
    });
    const result = compilePlaygroupPolicy(source);
    expect(result.construction).toEqual(source.hard);
    expect(result.checks).toEqual([]);
    expect(result.preferences).toMatchObject({
      profile: "thematic",
      strategy: "cats",
      goals: ["tell a story"],
    });
    expect(result.unevaluated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/soft/playgroup_preferences/0" }),
        expect.objectContaining({ path: "/unsupported/0" }),
      ]),
    );
  });
  it("labels explicit bracket category overrides custom and preserves the replaced official rule", () => {
    const result = compilePlaygroupPolicy(
      DeckIntentSchema.parse(intent({ bracket: 2, limits: { game_changers: 2, tutors: 1 } })),
    );
    expect(result.checks.find((check) => check.category === "game_changers")).toMatchObject({
      max: 2,
      provenance: { kind: "custom", overrides: { max: 0 } },
    });
    expect(result.checks.filter((check) => check.category === "tutors")).toMatchObject([
      { provenance: { kind: "custom" } },
    ]);
  });
  it.each(["casual", "thematic", "competitive", "custom"])(
    "never infers a bracket or bans from %s",
    (profile) => {
      const result = compilePlaygroupPolicy(DeckIntentSchema.parse(intent({ profile })));
      expect(result.bracket).toBeNull();
      expect(result.checks).toEqual([]);
    },
  );
});

describe("playgroup compatibility evidence", () => {
  it("reports no declaration as unknown without mutating the deck", () => {
    const d = deck(undefined);
    const before = structuredClone(d);
    expect(evaluatePlaygroupPolicy(d, noLookup, evidence())).toMatchObject({
      declared: false,
      status: "unknown",
    });
    expect(d).toEqual(before);
  });
  it("reports excluded and protected quantity failures with card identities", () => {
    const d = deck(
      {
        ...intent({ profile: "custom" }),
        hard: { excluded_cards: ["A"], locked_cards: [{ oracle_id: "B", qty: 2 }] },
      },
      [
        { oracle_id: "A", qty: 1 },
        { oracle_id: "B", qty: 1 },
      ],
    );
    const report = evaluatePlaygroupPolicy(d, (id) => card(id), evidence());
    expect(report.status).toBe("incompatible");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "excluded_cards",
          status: "fail",
          cards: [expect.objectContaining({ oracle_id: "A" })],
        }),
        expect.objectContaining({
          category: "locked_cards",
          status: "fail",
          cards: [expect.objectContaining({ oracle_id: "B" })],
        }),
      ]),
    );
  });
  it("reports protected-excluded policy contradictions even before construction", () => {
    const d = deck({
      ...intent({ profile: "custom" }),
      hard: { excluded_cards: ["A"], locked_cards: [{ oracle_id: "A", qty: 1 }] },
    });
    expect(evaluatePlaygroupPolicy(d, noLookup, evidence()).findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "policy_conflict", status: "fail" }),
      ]),
    );
  });
  it("aggregates quantities, counts commander overlap once, and excludes companion", () => {
    const d = deck(intent({ limits: { game_changers: 3 } }), [
      { oracle_id: "A", qty: 1 },
      { oracle_id: "A", qty: 1 },
      { oracle_id: "C", qty: 7 },
    ]);
    d.commanders = ["C"];
    d.companion = "D";
    const result = evaluatePlaygroupPolicy(
      d,
      (id) => card(id),
      evidence({ game_changers: { names: new Set(["A", "C", "D"]), source: {}, complete: true } }),
    );
    expect(result.findings.find((finding) => finding.category === "game_changers")).toMatchObject({
      observed_count: 3,
      status: "pass",
    });
  });
  it.each([1, 2, 3])("checks official Game Changer cap at bracket %i", (bracket) => {
    const cap = bracket === 3 ? 3 : 0;
    const d = deck(intent({ bracket }), [{ oracle_id: "A", qty: cap + 1 }]);
    expect(
      evaluatePlaygroupPolicy(
        d,
        (id) => card(id),
        evidence({ game_changers: { names: new Set(["A"]), source: {}, complete: false } }),
      ).findings,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "game_changers", status: "fail", limit: cap }),
      ]),
    );
  });
  it("retains uncertainty when Game Changer membership or card identity is incomplete", () => {
    const d = deck(intent({ limits: { game_changers: 0 } }), [{ oracle_id: "unknown", qty: 1 }]);
    const result = evaluatePlaygroupPolicy(d, noLookup, evidence());
    expect(result).toMatchObject({ status: "unknown", unknown_oracle_ids: ["unknown"] });
    expect(result.findings.find((finding) => finding.category === "game_changers")?.status).toBe(
      "unknown",
    );
    expect(
      evaluatePlaygroupPolicy(
        deck(intent({ limits: { game_changers: 0 } })),
        noLookup,
        evidence({ game_changers: { names: new Set(), source: {}, complete: false } }),
      ).status,
    ).toBe("unknown");
  });
  it("does not certify heuristic category positives or misses", () => {
    const cards = [
      card("Unlisted land denial", { oracle_text: "Destroy all lands." }),
      card("Tutor", { roles: ["tutor"] }),
      card("Warp", { oracle_text: "Take an extra turn after this one." }),
    ];
    const d = deck(
      intent({ limits: { mass_land_denial: 0, tutors: 0, extra_turns: 0, fast_mana: 0 } }),
      cards.map((c) => ({ oracle_id: c.oracle_id, qty: 1 })),
    );
    const result = evaluatePlaygroupPolicy(
      d,
      (id) => cards.find((c) => c.oracle_id === id) ?? null,
      evidence(),
    );
    expect(result.status).toBe("unknown");
    expect(
      result.findings
        .filter((finding) =>
          ["mass_land_denial", "tutors", "extra_turns", "fast_mana"].includes(finding.category),
        )
        .every((finding) => finding.status === "unknown"),
    ).toBe(true);
    expect(
      result.findings.find((finding) => finding.category === "mass_land_denial"),
    ).toMatchObject({
      observed_count: 1,
      cards: [{ oracle_id: "Unlisted land denial", name: "Unlisted land denial", qty: 1 }],
    });
  });
  it.each([2, 3])(
    "uses gameplay review without inventing an extra-turn cap at bracket %i",
    (bracket) => {
      const result = evaluatePlaygroupPolicy(deck(intent({ bracket })), noLookup, evidence());
      expect(result.findings.find((finding) => finding.category === "extra_turns")).toMatchObject({
        status: "unknown",
      });
      expect(
        result.findings.find((finding) => finding.category === "extra_turns"),
      ).not.toHaveProperty("limit");
    },
  );
  it.each([1, 2, 3])(
    "requires intentionality and timing review for official combos at bracket %i",
    (bracket) => {
      const e = evidence();
      e.combos.candidates = [combo("two-card")];
      const result = evaluatePlaygroupPolicy(deck(intent({ bracket })), noLookup, e);
      expect(
        result.findings.find((finding) => finding.category === "infinite_combos"),
      ).toMatchObject({
        status: "unknown",
        combo_candidates: [
          expect.objectContaining({
            id: "two-card",
            url: "https://commanderspellbook.com/combo/two-card/",
          }),
        ],
      });
    },
  );
  it("counts only known infinite packages with satisfied configuration for custom limits", () => {
    const e = evidence();
    e.combos.candidates = [
      combo("good"),
      combo("uncertain", "unknown"),
      combo("absent", "unsatisfied"),
      combo("finite", "satisfied", false),
      combo("good"),
    ];
    const result = evaluatePlaygroupPolicy(
      deck(intent({ limits: { infinite_combos: 0 } })),
      noLookup,
      e,
    );
    expect(result.findings.find((finding) => finding.category === "infinite_combos")).toMatchObject(
      { status: "fail", observed_count: 1 },
    );
  });
  it("does not count distinct provider variants of the same ingredient package twice", () => {
    const e = evidence();
    e.combos.candidates = [combo("variant-a"), combo("variant-b")];
    expect(
      evaluatePlaygroupPolicy(
        deck(intent({ limits: { infinite_combos: 1 } })),
        noLookup,
        e,
      ).findings.find((finding) => finding.category === "infinite_combos"),
    ).toMatchObject({ status: "unknown", observed_count: 1 });
  });
  it("keeps a supported stale combo observation unknown instead of a current count violation", () => {
    const e = evidence();
    e.combos.candidates = [combo("stale")];
    e.combos.freshness = {
      fetched_at: "2026-08-01",
      age_ms: 100000,
      ttl_ms: 1,
      status: "stale",
      refresh_failed: true,
    };
    expect(
      evaluatePlaygroupPolicy(
        deck(intent({ limits: { infinite_combos: 0 } })),
        noLookup,
        e,
      ).findings.find((finding) => finding.category === "infinite_combos"),
    ).toMatchObject({ status: "unknown", observed_count: 1 });
  });
  it("identifies only unavoidable protected category conflicts", () => {
    const e = evidence({
      game_changers: { names: new Set(["Farewell", "Biorhythm"]), source: {}, complete: false },
    });
    const d = deck(
      {
        ...intent({ limits: { game_changers: 1 } }),
        hard: { locked_cards: [{ oracle_id: "Farewell", qty: 1 }] },
      },
      [
        { oracle_id: "Farewell", qty: 1 },
        { oracle_id: "Biorhythm", qty: 1 },
      ],
    );
    const result = evaluatePlaygroupPolicy(d, (id) => card(id), e);
    expect(result.status).toBe("incompatible");
    expect(result.findings.some((finding) => finding.category === "policy_conflict")).toBe(false);
    const conflict = deck({
      ...intent({ limits: { game_changers: 0 } }),
      hard: { locked_cards: [{ oracle_id: "Farewell", qty: 1 }] },
    });
    expect(evaluatePlaygroupPolicy(conflict, (id) => card(id), e).findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "policy_conflict",
          reason: expect.stringContaining("protected minimum"),
        }),
      ]),
    );
  });
  it.each([
    ["U", "pass"],
    ["R", "fail"],
    [null, "unknown"],
  ] as const)("treats commander colors as a permitted set with evidence %s", (color, status) => {
    const commander = card("commander", {
      gameplay: {
        version: 1,
        source: { scryfall_id: null, oracle_id: "commander" },
        layout: "normal",
        color_identity: color === null ? null : [color],
        face_relationship: "single",
        playability: "not_evaluated",
        faces: [],
        related_cards: [],
        characteristics: {
          name: null,
          mana_cost: null,
          cmc: null,
          type_line: null,
          oracle_text: null,
          colors: null,
          color_indicator: null,
          power: null,
          toughness: null,
          loyalty: null,
          defense: null,
          keywords: null,
          produced_mana: null,
          printed_name: null,
          printed_text: null,
          printed_type_line: null,
        },
      },
    });
    const d = deck({
      ...intent({ bracket: 4 }),
      hard: { commanders: { color_identity: ["U", "B"] } },
    });
    d.commanders = ["commander"];
    d.computed_color_identity = ["R"];
    expect(
      evaluatePlaygroupPolicy(d, () => commander, evidence()).findings.find(
        (finding) => finding.provenance.path === "/hard/commanders/color_identity",
      ),
    ).toMatchObject({ status });
  });
  it("does not include three-card infinite packages in official two-card observations", () => {
    const e = evidence();
    const three = combo("three");
    const first = three.uses[0];
    if (!first) throw new Error("fixture ingredient missing");
    three.uses.push({ ...first, card: { id: 3, oracle_id: "C", name: "C" } });
    three.pieces.push("C");
    e.combos.candidates = [three];
    expect(
      evaluatePlaygroupPolicy(deck(intent({ bracket: 2 })), noLookup, e).findings.find(
        (finding) => finding.category === "infinite_combos",
      ),
    ).toMatchObject({ observed_count: 0, combo_candidates: [] });
    expect(
      evaluatePlaygroupPolicy(
        deck(intent({ limits: { infinite_combos: 0 } })),
        noLookup,
        e,
      ).findings.find((finding) => finding.category === "infinite_combos"),
    ).toMatchObject({ observed_count: 1, status: "fail" });
  });
  it("does not count legacy produces text when explicit outcome evidence is absent", () => {
    const e = evidence();
    const sparse = combo("sparse");
    sparse.outputs = [];
    e.combos.candidates = [sparse];
    expect(
      evaluatePlaygroupPolicy(
        deck(intent({ limits: { infinite_combos: 0 } })),
        noLookup,
        e,
      ).findings.find((finding) => finding.category === "infinite_combos"),
    ).toMatchObject({ observed_count: 0, status: "unknown" });
  });
  it.each(["Armageddon", "Ruination", "Sunder", "Blood Moon", "Winter Orb"])(
    "uses documented official mass-land-denial example %s as positive evidence",
    (name) => {
      const result = evaluatePlaygroupPolicy(
        deck(intent({ bracket: 2 }), [{ oracle_id: name, qty: 1 }]),
        (id) => card(id),
        evidence(),
      );
      expect(
        result.findings.find((finding) => finding.category === "mass_land_denial"),
      ).toMatchObject({ status: "fail", observed_count: 1 });
    },
  );
  it.each(["available", "unavailable"] as const)(
    "never turns %s combo absence into a proof of compatibility",
    (status) => {
      const e = evidence();
      e.combos.status = status;
      e.combos.error =
        status === "unavailable" ? { code: "UPSTREAM_UNAVAILABLE", message: "offline" } : null;
      const result = evaluatePlaygroupPolicy(
        deck(intent({ limits: { infinite_combos: 0 } })),
        noLookup,
        e,
      );
      expect(result.status).toBe("unknown");
      expect(result.evidence.combos.absence_confirmed).toBe(false);
      expect(result.evidence.combos.error).toEqual(e.combos.error);
    },
  );
  it.each([4, 5])("keeps bracket %i goals separate from unrestricted card checks", (bracket) => {
    const result = evaluatePlaygroupPolicy(deck(intent({ bracket })), noLookup, evidence());
    expect(result.policy.checks).toEqual([]);
    expect(result.policy.preferences.bracket_goal).toBeTruthy();
    expect(result.limitations.join(" ")).toContain("power");
  });
});
