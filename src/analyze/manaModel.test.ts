import { describe, expect, it } from "vitest";
import {
  checkManaPaymentWitness,
  manaModelOverrideSchema,
  modelCardMana,
  modelDeckMana,
  parseManaCost,
} from "./manaModel.js";
import { manaCard, manaFixtures as f } from "./manaModel.fixture.js";

const modeled = (key: keyof typeof f) => modelCardMana(f[key]);
const permanent = (id: string, key: keyof typeof f, entered_this_turn = false) => ({
  id,
  model: modeled(key),
  face_index: 0,
  zone: "battlefield" as const,
  entered_this_turn,
});

describe("canonical mana source and cost model", () => {
  it("retains generic, colored, colorless, zero, missing and absent costs separately", () => {
    expect(parseManaCost("{2}{U}{U}{C}")).toMatchObject({
      status: "supported",
      kind: "mana",
      generic: 2,
      required: ["U", "U", "C"],
    });
    expect(parseManaCost("{0}")).toMatchObject({ kind: "mana", generic: 0, required: [] });
    expect(parseManaCost("")).toMatchObject({ kind: "no_mana_cost" });
    expect(parseManaCost(null)).toMatchObject({ kind: "unknown", status: "unsupported" });
    for (const cost of ["{W/U}", "{U/P}", "{S}", "{X}", "U", "{1.5}"])
      expect(parseManaCost(cost).status).toBe("unsupported");
    expect(modeled("force").faces[0]?.cost.status).toBe("unsupported");
  });

  it("models every frozen source class with alternatives distinct from simultaneous output", () => {
    for (const key of [
      "plains",
      "island",
      "swamp",
      "mountain",
      "forest",
      "wastes",
      "tropical",
      "guildgate",
      "ring",
      "diamond",
      "elves",
      "birds",
      "signet",
      "wilds",
      "pathway",
      "tangled",
    ] as const)
      expect(modeled(key).status, key).toBe("supported");
    expect(modeled("tropical").faces[0]?.source.outputs).toEqual([["G"], ["U"]]);
    expect(modeled("ring").faces[0]?.source.outputs).toEqual([["C", "C"]]);
    expect(modeled("signet").faces[0]?.source).toMatchObject({
      outputs: [["W", "U"]],
      activation_cost: { generic: 1 },
    });
    expect(modeled("birds").faces[0]?.source.outputs).toEqual([["W"], ["U"], ["B"], ["R"], ["G"]]);
    expect(modeled("diamond").faces[0]?.source.enters_tapped).toBe(true);
    expect(modeled("elves").faces[0]?.source.summoning_delay).toBe(true);
    expect(modeled("wilds").faces[0]?.source).toMatchObject({
      kind: "fetch",
      sacrifice_self: true,
      fetch: { basic_only: true, destination: "battlefield", enters_tapped: true },
    });
  });

  it("requires supplied commander identity, including explicit colorless identity", () => {
    expect(modeled("tower").status).toBe("unsupported");
    expect(modelCardMana(f.tower, { identity: ["U", "G"] }).faces[0]?.source.outputs).toEqual([
      ["U"],
      ["G"],
    ]);
    expect(modelCardMana(f.tower, { identity: [] }).faces[0]?.source.outputs).toEqual([]);
  });

  it("preserves exact evidence and links the existing mechanics annotations", () => {
    const face = modeled("signet").faces[0];
    expect(face?.source.evidence[0]).toMatchObject({
      field_path: "/oracle_text",
      start: 0,
      end: f.signet.oracle_text.length,
      text: f.signet.oracle_text,
    });
    expect(face?.source.mechanics.some((a) => a.pattern_id === "effect.add_mana")).toBe(true);
    expect(modeled("tangled").faces[1]?.source.evidence[0]?.field_path).toBe(
      "/card_faces/1/oracle_text",
    );
  });

  it("fails closed for unsupported conditional sources, incomplete and legacy facts", () => {
    for (const key of ["ziggurat", "pool", "shock", "check"] as const)
      expect(modeled(key).faces[0]?.source.status, key).toBe("unsupported");
    expect(modelCardMana({ ...f.forest, gameplay: undefined }).status).toBe("unsupported");
    expect(modelCardMana(manaCard("Unknown", { oracle_text: undefined })).status).toBe(
      "unsupported",
    );
    expect(
      modelCardMana(manaCard("Mana impostor", { oracle_text: "{T}: Add {G}. Draw a card." }))
        .status,
    ).toBe("unsupported");
  });

  it("reports per-face costs without duplicating physical deck quantities", () => {
    const deck = modelDeckMana(
      [
        { oracle_id: f.tangled.oracle_id, qty: 2 },
        { oracle_id: "missing", qty: 3 },
        { oracle_id: f.pool.oracle_id, qty: 1 },
      ],
      (id) => Object.values(f).find((c) => c.oracle_id === id) ?? null,
    );
    expect(deck.coverage).toMatchObject({
      total_quantity: 6,
      resolved_quantity: 3,
      supported_quantity: 2,
      unsupported_quantity: 1,
      unresolved_quantity: 3,
      overridden_quantity: 0,
    });
    expect(deck.cards[0]?.model?.faces).toHaveLength(2);
    expect(deck.cards[0]?.model?.faces[0]?.cost).toMatchObject({ generic: 1, required: ["G"] });
    expect(deck.cards[0]?.model?.faces[1]?.cost.kind).toBe("no_mana_cost");
  });

  it("validates bounded caller overrides and preserves original unsupported reasons", () => {
    const override = {
      oracle_id: f.pool.oracle_id,
      face_index: 0,
      reason: "Assume another land supplies blue",
      source: {
        outputs: [["U"]],
        activation_cost: "{0}",
        enters_tapped: false,
        summoning_delay: false,
      },
    };
    const checked = manaModelOverrideSchema.parse(override);
    const report = modelDeckMana([{ oracle_id: f.pool.oracle_id, qty: 2 }], () => f.pool, {
      overrides: [checked],
    });
    expect(report.coverage).toMatchObject({ supported_quantity: 0, overridden_quantity: 2 });
    expect(report.cards[0]?.model?.faces[0]?.source.status).toBe("overridden");
    expect(report.cards[0]?.model?.reasons.length).toBeGreaterThan(0);
    expect(report.cards[0]?.assumptions).toContain("Assume another land supplies blue");
    expect(
      manaModelOverrideSchema.safeParse({
        ...override,
        source: { ...override.source, outputs: [["X"]] },
      }).success,
    ).toBe(false);
    expect(
      manaModelOverrideSchema.safeParse({
        ...override,
        source: { ...override.source, activation_cost: "{W/U}" },
      }).success,
    ).toBe(false);
  });
});

describe("bounded payment witness checker", () => {
  it("one dual cannot pay UG but two sources can, and colorless cannot pay colored", () => {
    const activate = { kind: "activate" as const, source_id: "dual", output_index: 0 };
    expect(
      checkManaPaymentWitness({
        sources: [permanent("dual", "tropical")],
        actions: [activate],
        cost: "{G}{U}",
      }).ok,
    ).toBe(false);
    expect(
      checkManaPaymentWitness({
        sources: [permanent("dual", "tropical")],
        actions: [activate, { ...activate, output_index: 1 }],
        cost: "{G}{U}",
      }).ok,
    ).toBe(false);
    expect(
      checkManaPaymentWitness({
        sources: [permanent("dual", "tropical"), permanent("u", "island")],
        actions: [activate, { kind: "activate", source_id: "u", output_index: 0 }],
        cost: "{G}{U}",
      }).ok,
    ).toBe(true);
    expect(
      checkManaPaymentWitness({
        sources: [permanent("ring", "ring")],
        actions: [{ kind: "activate", source_id: "ring", output_index: 0 }],
        cost: "{U}",
      }).ok,
    ).toBe(false);
    expect(
      checkManaPaymentWitness({
        sources: [permanent("ring", "ring")],
        actions: [{ kind: "activate", source_id: "ring", output_index: 0 }],
        cost: "{C}{1}",
      }).ok,
    ).toBe(true);
  });

  it("pays activation mana before output, preventing Signet self-funding", () => {
    const action = { kind: "activate" as const, source_id: "signet", output_index: 0 };
    expect(
      checkManaPaymentWitness({
        sources: [permanent("signet", "signet")],
        actions: [action],
        cost: "{W}{U}",
      }).ok,
    ).toBe(false);
    expect(
      checkManaPaymentWitness({
        sources: [permanent("signet", "signet"), permanent("c", "wastes")],
        actions: [{ kind: "activate", source_id: "c", output_index: 0 }, action],
        cost: "{W}{U}",
      }).ok,
    ).toBe(true);
  });

  it("enforces tapped arrival and creature summoning delay", () => {
    for (const key of ["guildgate", "diamond", "elves", "birds"] as const)
      expect(
        checkManaPaymentWitness({
          sources: [permanent("new", key, true)],
          actions: [{ kind: "activate", source_id: "new", output_index: 0 }],
          cost: "{1}",
        }).ok,
        key,
      ).toBe(false);
    expect(
      checkManaPaymentWitness({
        sources: [permanent("new", "ring", true)],
        actions: [{ kind: "activate", source_id: "new", output_index: 0 }],
        cost: "{2}",
      }).ok,
    ).toBe(true);
  });

  it("requires a real basic fetch target in the library and makes it arrive tapped", () => {
    const actions = [{ kind: "fetch" as const, source_id: "fetch", target_id: "target" }];
    expect(
      checkManaPaymentWitness({ sources: [permanent("fetch", "wilds")], actions, cost: "{0}" }).ok,
    ).toBe(false);
    expect(
      checkManaPaymentWitness({
        sources: [permanent("fetch", "wilds"), permanent("target", "forest")],
        actions,
        cost: "{0}",
      }).ok,
    ).toBe(false);
    const target = { ...permanent("target", "forest"), zone: "library" as const };
    expect(
      checkManaPaymentWitness({
        sources: [permanent("fetch", "wilds"), target],
        actions,
        cost: "{0}",
      }).ok,
    ).toBe(true);
    expect(
      checkManaPaymentWitness({
        sources: [permanent("fetch", "wilds"), target],
        actions: [...actions, { kind: "activate", source_id: "target", output_index: 0 }],
        cost: "{G}",
      }).ok,
    ).toBe(false);
    expect(
      checkManaPaymentWitness({
        sources: [permanent("fetch", "wilds"), { ...target, model: modeled("tropical") }],
        actions,
        cost: "{0}",
      }).ok,
    ).toBe(false);
  });

  it("chooses one MDFC face and pays a spell face before it can become a source", () => {
    const pathway = { ...permanent("path", "pathway"), zone: "hand" as const };
    expect(
      checkManaPaymentWitness({
        sources: [pathway],
        actions: [
          { kind: "play", source_id: "path", face_index: 1 },
          { kind: "activate", source_id: "path", output_index: 0 },
        ],
        cost: "{U}",
      }).ok,
    ).toBe(true);
    expect(
      checkManaPaymentWitness({
        sources: [pathway],
        actions: [
          { kind: "play", source_id: "path", face_index: 0 },
          { kind: "play", source_id: "path", face_index: 1 },
        ],
        cost: "{0}",
      }).ok,
    ).toBe(false);
    expect(
      checkManaPaymentWitness({
        sources: [{ ...permanent("t", "tangled"), zone: "hand" }],
        actions: [{ kind: "play", source_id: "t", face_index: 0 }],
        cost: "{0}",
      }).ok,
    ).toBe(false);
    expect(
      checkManaPaymentWitness({
        sources: [permanent("same", "forest"), permanent("same", "island")],
        actions: [],
        cost: "{0}",
      }).ok,
    ).toBe(false);
  });
});

describe("mana model acceptance edge cases", () => {
  it("accepts current self-reference Oracle wording and type-based dual abilities without reminder text", () => {
    expect(
      modelCardMana(
        manaCard("Tropical Island", { type_line: "Land — Forest Island", oracle_text: "" }),
      ).faces[0]?.source.outputs,
    ).toEqual([["G"], ["U"]]);
    expect(
      modelCardMana(
        manaCard("Azorius Guildgate", {
          oracle_text: "This land enters tapped.\n{T}: Add {W} or {U}.",
        }),
      ).status,
    ).toBe("supported");
    expect(
      modelCardMana(
        manaCard("Sky Diamond", {
          type_line: "Artifact",
          mana_cost: "{2}",
          oracle_text: "This artifact enters tapped.\n{T}: Add {U}.",
        }),
      ).status,
    ).toBe("supported");
    expect(
      modelCardMana(
        manaCard("Evolving Wilds", {
          oracle_text:
            "{T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.",
        }),
      ).status,
    ).toBe("supported");
  });

  it("retains source and cost coverage independently and reports unmatched or conflicting overrides", () => {
    const override = manaModelOverrideSchema.parse({
      oracle_id: f.pool.oracle_id,
      face_index: 1,
      reason: "Choose a missing face",
      mana_cost: "{0}",
    });
    const report = modelDeckMana([{ oracle_id: f.pool.oracle_id, qty: 2 }], () => f.pool, {
      overrides: [override],
    });
    expect(report.cost_coverage.supported_quantity).toBe(2);
    expect(report.source_coverage.unsupported_quantity).toBe(2);
    expect(report.override_diagnostics).toHaveLength(1);
    const duplicate = { ...override, face_index: 0 };
    expect(modelCardMana(f.pool, { overrides: [duplicate, duplicate] }).reasons).toContain(
      "Conflicting overrides for face 0.",
    );
  });

  it("does not cast no-cost permanents for free or infer cost reductions and additional costs", () => {
    const card = manaCard("No cost", {
      type_line: "Artifact",
      mana_cost: "",
      oracle_text: "{T}: Add {C}.",
    });
    const sources = [
      { id: "no-cost", model: modelCardMana(card), face_index: 0, zone: "hand" as const },
    ];
    expect(
      checkManaPaymentWitness({
        sources,
        actions: [{ kind: "play", source_id: "no-cost", face_index: 0 }],
        cost: "{0}",
      }).ok,
    ).toBe(false);
    const zero = manaCard("Zero cost", {
      type_line: "Artifact",
      mana_cost: "{0}",
      oracle_text: "{T}: Add {C}.",
    });
    expect(
      checkManaPaymentWitness({
        sources: [{ id: "no-cost", model: modelCardMana(zero), face_index: 0, zone: "hand" }],
        actions: [
          { kind: "play", source_id: "no-cost", face_index: 0 },
          { kind: "activate", source_id: "no-cost", output_index: 0 },
        ],
        cost: "{C}",
      }).ok,
    ).toBe(true);
    for (const oracle_text of [
      "Convoke\nDraw a card.",
      "As an additional cost to cast this spell, sacrifice a creature.\nDraw a card.",
      "This spell costs {1} less to cast for each creature you control.",
    ])
      expect(
        modelCardMana(
          manaCard("Modified cost", { type_line: "Sorcery", mana_cost: "{2}{U}", oracle_text }),
        ).faces[0]?.cost.status,
      ).toBe("unsupported");
  });

  it("checks caller-selected generic allocation without searching for a better payment", () => {
    const sources = [permanent("s", "signet")];
    const action = { kind: "activate" as const, source_id: "s", output_index: 0 };
    expect(
      checkManaPaymentWitness({
        sources,
        initial_pool: ["U", "C"],
        actions: [action],
        cost: "{W}{U}{U}",
      }).ok,
    ).toBe(false);
    expect(
      checkManaPaymentWitness({
        sources,
        initial_pool: ["U", "C"],
        actions: [{ ...action, payment: ["C"] }],
        cost: "{W}{U}{U}",
      }).ok,
    ).toBe(true);
    expect(
      checkManaPaymentWitness({
        sources,
        initial_pool: ["U"],
        actions: [{ ...action, payment: ["C"] }],
        cost: "{W}{U}",
      }).ok,
    ).toBe(false);
  });

  it("never mutates canonical cards, input deck entries, or witness state", () => {
    const entries = [{ oracle_id: f.tangled.oracle_id, qty: 2 }];
    const before = JSON.stringify({ entries, card: f.tangled });
    modelDeckMana(entries, () => f.tangled);
    expect(JSON.stringify({ entries, card: f.tangled })).toBe(before);
    const witness = {
      sources: [permanent("ring", "ring")],
      actions: [{ kind: "activate" as const, source_id: "ring", output_index: 0 }],
      cost: "{1}",
    };
    const snapshot = JSON.stringify(witness);
    checkManaPaymentWitness(witness);
    expect(JSON.stringify(witness)).toBe(snapshot);
  });
});

it("marks alternate-cost keywords unsupported from canonical Oracle and keyword facts", () => {
  for (const keyword of [
    "Overload",
    "Flashback",
    "Escape",
    "Madness",
    "Bestow",
    "Dash",
    "Blitz",
    "Miracle",
    "Spectacle",
    "Jump-start",
    "Disturb",
    "Awaken",
    "Surge",
  ]) {
    const oracle = manaCard(keyword, {
      type_line: "Sorcery",
      mana_cost: "{2}{U}",
      oracle_text: `${keyword} {1}{U}\nDraw a card.`,
    });
    expect(modelCardMana(oracle).faces[0]?.cost.status, keyword).toBe("unsupported");
    const keywords = manaCard(`${keyword} source keyword`, {
      type_line: "Sorcery",
      mana_cost: "{2}{U}",
      oracle_text: "Draw a card.",
      keywords: [keyword],
    });
    expect(modelCardMana(keywords).faces[0]?.cost.status, keyword).toBe("unsupported");
  }
});

it("rejects playing unrelated permanents whose static effects the witness cannot interpret", () => {
  const moon = modelCardMana(
    manaCard("Blood Moon", {
      type_line: "Enchantment",
      mana_cost: "{2}{R}",
      oracle_text: "Nonbasic lands are Mountains.",
    }),
  );
  expect(moon.status).toBe("supported");
  expect(
    checkManaPaymentWitness({
      sources: [
        { id: "moon", model: moon, face_index: 0, zone: "hand" },
        permanent("dual", "tropical"),
      ],
      initial_pool: ["C", "C", "R"],
      actions: [
        { kind: "play", source_id: "moon", face_index: 0 },
        { kind: "activate", source_id: "dual", output_index: 0 },
      ],
      cost: "{G}",
    }).ok,
  ).toBe(false);
});

it("keeps unrelated spell conditions out of mana source restriction metadata", () => {
  const leak = modelCardMana(
    manaCard("Mana Leak", {
      mana_cost: "{1}{U}",
      type_line: "Instant",
      oracle_text: "Counter target spell unless its controller pays {3}.",
    }),
  );
  expect(leak.faces[0]?.source.kind).toBe("none");
  expect(leak.faces[0]?.source.restrictions).toEqual([]);
  expect(
    modeled("check").faces[0]?.source.restrictions.some(
      (restriction) => restriction.kind === "entry_condition",
    ),
  ).toBe(true);
  expect(
    modeled("ziggurat").faces[0]?.source.restrictions.some(
      (restriction) => restriction.kind === "spending_restriction",
    ),
  ).toBe(true);
});

it("reports variable mana-pool doubling and production replacement effects as unsupported sources", () => {
  const cube = manaCard("Doubling Cube", {
    type_line: "Artifact",
    mana_cost: "{2}",
    oracle_text: "{3}, {T}: Double the amount of each type of unspent mana you have.",
  });
  const ancient = manaCard("Nyxbloom Ancient", {
    type_line: "Enchantment Creature — Elemental",
    mana_cost: "{4}{G}{G}{G}",
    oracle_text:
      "Trample\nIf you tap a permanent for mana, it produces three times as much of that mana instead.",
  });
  for (const card of [cube, ancient]) {
    const model = modelCardMana(card);
    expect(model.faces[0]?.source.status, card.name).toBe("unsupported");
    expect(model.faces[0]?.source.kind, card.name).toBe("unsupported");
    expect(model.faces[0]?.source.outputs, card.name).toEqual([]);
  }
});
