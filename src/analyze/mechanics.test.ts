import { describe, expect, it } from "vitest";
import { mapScryfallCard, type ScryfallCardRaw } from "../index/map.js";
import { MECHANICS_EXTRACTOR_VERSION, type Card, type MechanicAnnotation } from "../types/index.js";
import { extractMechanics, SUPPORTED_MECHANIC_PATTERNS } from "./mechanics.js";

function card(raw: Partial<ScryfallCardRaw> & { name: string }): Card {
  return mapScryfallCard({
    oracle_id: `o-${raw.name.toLowerCase().replace(/[^a-z]+/g, "-")}`,
    id: "p-1",
    layout: raw.card_faces ? "modal_dfc" : "normal",
    legalities: { commander: "legal" },
    color_identity: [],
    colors: [],
    keywords: [],
    ...raw,
  });
}

function keys(annotations: readonly MechanicAnnotation[]): string[] {
  return annotations.map((a) => `${a.pattern_id}|${a.subject}|${a.condition.kind}`);
}

describe("extractMechanics evidence contract", () => {
  it("stamps card, face, exact Oracle span, version, condition and provenance on every annotation", () => {
    const c = card({
      name: "Fecundity Probe",
      type_line: "Enchantment",
      oracle_text: "Whenever a creature dies, its controller may draw a card.",
    });
    const report = extractMechanics(c);
    expect(report.extractor_version).toBe(MECHANICS_EXTRACTOR_VERSION);
    expect(report.source).toBe("gameplay_faces");
    expect(report.legality).toBe("not_evaluated");
    expect(report.annotations.length).toBeGreaterThan(0);
    for (const a of report.annotations) {
      expect(a.status).toBe("supported");
      expect(a.extractor_version).toBe(MECHANICS_EXTRACTOR_VERSION);
      expect(a.face_index).toBe(0);
      expect(a.evidence.oracle_id).toBe(c.oracle_id);
      expect(a.evidence.field_path).toBe("/oracle_text");
      expect(a.evidence.offset_unit).toBe("utf16_code_units");
      expect(c.oracle_text.slice(a.evidence.start, a.evidence.end)).toBe(a.evidence.text);
      expect(["unconditional", "conditional"]).toContain(a.condition.kind);
      expect(["explicit", "inferred"]).toContain(a.provenance);
      expect(SUPPORTED_MECHANIC_PATTERNS.some((p) => p.id === a.pattern_id)).toBe(true);
    }
    const trigger = report.annotations.find((a) => a.category === "trigger");
    expect(trigger).toMatchObject({
      kind: "dies",
      subject: "any_player",
      ability_kind: "triggered",
    });
    expect(trigger?.evidence.text).toBe("Whenever a creature dies");
    const draw = report.annotations.find((a) => a.kind === "draw_cards");
    expect(draw).toMatchObject({ subject: "unknown", optional: true, amount: 1 });
  });

  it("addresses each face of a multi-face card by its own face index and source path", () => {
    const c = card({
      name: "Bala Ged Recovery // Bala Ged Sanctuary",
      card_faces: [
        {
          name: "Bala Ged Recovery",
          type_line: "Sorcery",
          oracle_text: "Return target card from your graveyard to your hand.",
        },
        {
          name: "Bala Ged Sanctuary",
          type_line: "Land",
          oracle_text:
            "As Bala Ged Sanctuary enters, you may pay 3 life. If you don't, it enters tapped.\n{T}: Add {G}.",
        },
      ],
    });
    const report = extractMechanics(c);
    const recover = report.annotations.find((a) => a.kind === "return_from_graveyard");
    expect(recover).toMatchObject({
      face_index: 0,
      subject: "controller",
      zones: { from: "graveyard", to: "hand" },
      ability_kind: "spell",
    });
    expect(recover?.evidence.field_path).toBe("/card_faces/0/oracle_text");
    const mana = report.annotations.find((a) => a.kind === "add_mana");
    expect(mana).toMatchObject({ face_index: 1, category: "effect", ability_kind: "activated" });
    expect(mana?.evidence.field_path).toBe("/card_faces/1/oracle_text");
    const tap = report.annotations.find((a) => a.kind === "tap");
    expect(tap).toMatchObject({ face_index: 1, category: "cost" });
    // The replacement-effect sentence is not modeled and is reported as such.
    expect(report.unmodeled.some((u) => u.face_index === 1 && u.status === "unmodeled")).toBe(true);
  });

  it("falls back to the flat Oracle text for legacy cards without gameplay facts", () => {
    const legacy: Card = {
      ...card({ name: "Legacy Draw", type_line: "Sorcery", oracle_text: "Draw two cards." }),
      gameplay: undefined,
    };
    const report = extractMechanics(legacy);
    expect(report.source).toBe("flat_oracle_text");
    expect(report.annotations[0]).toMatchObject({
      kind: "draw_cards",
      face_index: null,
      amount: 2,
      subject: "controller",
    });
    expect(report.annotations[0]?.evidence.field_path).toBe("/oracle_text");
  });
});

describe("extractMechanics distinguishes costs, payoffs, subjects and conditions", () => {
  it("separates a sacrifice cost from a sacrifice payoff trigger", () => {
    const outlet = card({
      name: "Ashnod's Altar",
      type_line: "Artifact",
      oracle_text: "Sacrifice a creature: Add {C}{C}.",
    });
    const payoff = card({
      name: "Mayhem Devil",
      type_line: "Creature — Devil",
      oracle_text:
        "Whenever a player sacrifices a permanent, Mayhem Devil deals 1 damage to any target.",
    });
    const outletKeys = keys(extractMechanics(outlet).annotations);
    expect(outletKeys).toContain("cost.sacrifice_permanent|controller|unconditional");
    expect(outletKeys).toContain("effect.add_mana|controller|unconditional");
    expect(outletKeys.some((k) => k.startsWith("trigger.sacrifice"))).toBe(false);
    const payoffKeys = keys(extractMechanics(payoff).annotations);
    expect(payoffKeys).toContain("trigger.sacrifice|any_player|unconditional");
    expect(payoffKeys).toContain("effect.deal_damage|any_player|unconditional");
    expect(payoffKeys.some((k) => k.startsWith("cost."))).toBe(false);
  });

  it("reads self-sacrifice costs as sacrifice_self, not a generic outlet", () => {
    const c = card({
      name: "Mind Stone",
      type_line: "Artifact",
      oracle_text: "{T}: Add {C}.\n{1}, {T}, Sacrifice Mind Stone: Draw a card.",
    });
    const k = keys(extractMechanics(c).annotations);
    expect(k).toContain("cost.sacrifice_self|self|unconditional");
    expect(k).not.toContain("cost.sacrifice_permanent|controller|unconditional");
    expect(k).toContain("effect.draw_cards|controller|unconditional");
    const report = extractMechanics(c);
    expect(report.annotations.filter((a) => a.kind === "tap")).toHaveLength(2);
    expect(report.annotations.map((a) => a.ability_index)).toEqual(expect.arrayContaining([0, 1]));
  });

  it("separates opponent-facing discard from controller discard", () => {
    const opp = card({
      name: "Syphon Mind",
      type_line: "Sorcery",
      oracle_text:
        "Each other player discards a card. You draw a card for each card discarded this way.",
    });
    const you = card({
      name: "Faithless Looting",
      type_line: "Sorcery",
      oracle_text: "Draw two cards, then discard two cards.",
    });
    const oppKeys = keys(extractMechanics(opp).annotations);
    expect(oppKeys).toContain("effect.discard_cards|opponent|unconditional");
    expect(oppKeys).not.toContain("effect.discard_cards|controller|unconditional");
    expect(oppKeys).toContain("effect.draw_cards|controller|unconditional");
    const youKeys = keys(extractMechanics(you).annotations);
    expect(youKeys).toContain("effect.discard_cards|controller|unconditional");
    expect(youKeys).toContain("effect.draw_cards|controller|unconditional");
    expect(youKeys).not.toContain("effect.discard_cards|opponent|unconditional");
  });

  it("marks intervening-if triggers as conditional and plain triggers as unconditional", () => {
    const cond = card({
      name: "Conditional Payoff",
      type_line: "Creature — Elf",
      oracle_text:
        "Whenever a creature you control dies, if it was a token, put a +1/+1 counter on Conditional Payoff.",
    });
    const plain = card({
      name: "Plain Payoff",
      type_line: "Creature — Elf",
      oracle_text: "Whenever a creature you control dies, put a +1/+1 counter on Plain Payoff.",
    });
    const condReport = extractMechanics(cond);
    const condTrigger = condReport.annotations.find((a) => a.category === "trigger");
    expect(condTrigger).toMatchObject({
      kind: "dies",
      subject: "controller",
      condition: { kind: "conditional", text: "if it was a token" },
    });
    const counters = condReport.annotations.find((a) => a.kind === "put_counters");
    expect(counters).toMatchObject({
      condition: { kind: "conditional" },
      qualifier: "+1/+1",
      amount: 1,
      subject: "self",
    });
    const plainTrigger = extractMechanics(plain).annotations.find((a) => a.category === "trigger");
    expect(plainTrigger?.condition).toEqual({ kind: "unconditional", text: null });
  });

  it("treats timing restrictions and unless clauses as conditions", () => {
    const c = card({
      name: "Restricted Outlet",
      type_line: "Artifact",
      oracle_text:
        "{2}, {T}: Create a 1/1 white Soldier creature token. Activate only as a sorcery.",
    });
    const token = extractMechanics(c).annotations.find((a) => a.kind === "create_token");
    expect(token).toMatchObject({
      condition: { kind: "conditional", text: "Activate only as a sorcery" },
      qualifier: "1/1 white Soldier creature",
      amount: 1,
    });
  });

  it("marks explicit provenance when a Scryfall ability word backs the trigger", () => {
    const c = card({
      name: "Rampaging Baloths",
      type_line: "Creature — Beast",
      keywords: ["Landfall", "Trample"],
      oracle_text:
        "Trample\nLandfall — Whenever a land you control enters, you may create a 4/4 green Beast creature token.",
    });
    const report = extractMechanics(c);
    const landfall = report.annotations.find((a) => a.kind === "landfall");
    expect(landfall).toMatchObject({ provenance: "explicit", subject: "controller" });
    const token = report.annotations.find((a) => a.kind === "create_token");
    expect(token).toMatchObject({ optional: true, provenance: "inferred", amount: 1 });
    // A bare keyword line carries no modeled mechanic and is reported, not counted as support.
    expect(report.unmodeled.some((u) => u.evidence.text === "Trample")).toBe(true);
  });
});

describe("extractMechanics reports what it does not model", () => {
  it("returns unmodeled spans for static text outside the supported catalog", () => {
    const c = card({
      name: "Glorious Anthem",
      type_line: "Enchantment",
      oracle_text: "Creatures you control get +1/+1.",
    });
    const report = extractMechanics(c);
    expect(report.annotations).toEqual([]);
    expect(report.unmodeled).toHaveLength(1);
    expect(report.unmodeled[0]).toMatchObject({
      status: "unmodeled",
      ability_kind: "static",
      face_index: 0,
    });
    expect(report.unmodeled[0]?.evidence.text).toBe("Creatures you control get +1/+1.");
    expect(report.coverage).toMatchObject({
      abilities_total: 1,
      abilities_with_support: 0,
      sentences_total: 1,
      sentences_unmodeled: 1,
    });
  });

  it("does not annotate granted ability text inside quotation marks", () => {
    const c = card({
      name: "Granting Aura",
      type_line: "Enchantment — Aura",
      oracle_text:
        'Enchant creature\nEnchanted creature has "When this creature dies, draw a card."',
    });
    const report = extractMechanics(c);
    expect(report.annotations.some((a) => a.kind === "draw_cards")).toBe(false);
    expect(report.unmodeled.some((u) => u.status === "uncertain")).toBe(true);
  });

  it("marks an unrecognized trigger event as uncertain while keeping its recognizable effect", () => {
    const c = card({
      name: "Odd Trigger",
      type_line: "Enchantment",
      oracle_text: "Whenever you roll a die, draw a card.",
    });
    const report = extractMechanics(c);
    expect(report.annotations.some((a) => a.category === "trigger")).toBe(false);
    expect(report.annotations.some((a) => a.kind === "draw_cards")).toBe(true);
    expect(report.unmodeled.some((u) => u.status === "uncertain")).toBe(true);
  });

  it("ignores reminder text and yields no abilities for a basic land", () => {
    const c = card({
      name: "Forest",
      type_line: "Basic Land — Forest",
      oracle_text: "({T}: Add {G}.)",
    });
    const report = extractMechanics(c);
    expect(report.annotations).toEqual([]);
    expect(report.unmodeled).toEqual([]);
    expect(report.coverage.abilities_total).toBe(0);
  });

  it("never touches roles or legality", () => {
    const c = card({
      name: "Sol Ring",
      type_line: "Artifact",
      oracle_text: "{T}: Add {C}{C}.",
    });
    const before = JSON.stringify(c);
    extractMechanics(c);
    expect(JSON.stringify(c)).toBe(before);
  });
});
