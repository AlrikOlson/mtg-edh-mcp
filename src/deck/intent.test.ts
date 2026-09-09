import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_BANDS } from "../analyze/mana.js";
import {
  DeckIntentSchema,
  effectiveRoleTargets,
  intentDiagnostics,
  patchDeckIntent,
} from "./intent.js";

describe("deck intent validation", () => {
  it("keeps hard constraints distinct from soft preferences and unsupported requests", () => {
    const intent = DeckIntentSchema.parse({
      schema_version: 1,
      hard: {
        locked_cards: [{ oracle_id: "favorite", qty: 2 }],
        excluded_cards: ["unwanted"],
        commanders: { allowed: ["leader"], required: ["leader"], color_identity: ["G"] },
        change_limit: 0,
      },
      soft: {
        goals: ["Win with creatures"],
        strategy: "Token combat",
        favorites: [{ oracle_id: "pet-card", qty: 1 }],
        role_targets: { ramp: { min: 10, max: 14 } },
        spend_target_usd: 0,
        playgroup_preferences: ["Avoid infinite combos"],
      },
      unsupported: ["Guarantee a turn-four win"],
    });
    expect(intent.hard?.locked_cards).toEqual([{ oracle_id: "favorite", qty: 2 }]);
    expect(intent.soft?.favorites).toEqual([{ oracle_id: "pet-card", qty: 1 }]);
    expect(intentDiagnostics(intent)).toEqual([]);
  });

  it.each([
    { schema_version: 2 },
    { schema_version: 1, mysterious: true },
    { schema_version: 1, hard: { locked_cards: [{ oracle_id: "x", qty: 0 }] } },
    { schema_version: 1, hard: { locked_cards: [{ oracle_id: "x", qty: 101 }] } },
    { schema_version: 1, hard: { locked_cards: [{ oracle_id: "x", qty: 1.5 }] } },
    { schema_version: 1, hard: { excluded_cards: ["   "] } },
    { schema_version: 1, hard: { excluded_cards: [" x "] } },
    { schema_version: 1, hard: { excluded_cards: ["x\0y"] } },
    { schema_version: 1, hard: { commanders: { color_identity: ["C"] } } },
    { schema_version: 1, hard: { change_limit: -1 } },
    { schema_version: 1, soft: { role_targets: { flying: { min: 0, max: 3 } } } },
    { schema_version: 1, soft: { role_targets: { ramp: { min: 0, max: 3, weight: 4 } } } },
    { schema_version: 1, soft: { spend_target_usd: Number.POSITIVE_INFINITY } },
    { schema_version: 1, soft: { goals: [""] } },
  ])("rejects malformed intent %j", (value) => {
    expect(DeckIntentSchema.safeParse(value).success).toBe(false);
  });

  it("reports conflicting constraints with stable codes and paths", () => {
    const intent = DeckIntentSchema.parse({
      schema_version: 1,
      hard: {
        locked_cards: [
          { oracle_id: "locked", qty: 100 },
          { oracle_id: "locked", qty: 1 },
        ],
        excluded_cards: ["locked", "leader", "leader"],
        commanders: { allowed: [], required: ["leader", "other", "third"] },
      },
      soft: { role_targets: { ramp: { min: 12, max: 8 } } },
    });
    expect(intentDiagnostics(intent)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DUPLICATE_CARD", path: "/hard/locked_cards/1" }),
        expect.objectContaining({ code: "DUPLICATE_CARD", path: "/hard/excluded_cards/2" }),
        expect.objectContaining({ code: "LOCKED_EXCLUDED", path: "/hard/locked_cards/0" }),
        expect.objectContaining({ code: "REQUIRED_EXCLUDED", path: "/hard/commanders/required/0" }),
        expect.objectContaining({
          code: "REQUIRED_NOT_ALLOWED",
          path: "/hard/commanders/required/0",
        }),
        expect.objectContaining({ code: "NO_ALLOWED_COMMANDER", path: "/hard/commanders/allowed" }),
        expect.objectContaining({
          code: "TOO_MANY_REQUIRED_COMMANDERS",
          path: "/hard/commanders/required",
        }),
        expect.objectContaining({
          code: "LOCKED_QUANTITY_EXCEEDS_DECK",
          path: "/hard/locked_cards",
        }),
        expect.objectContaining({ code: "INVALID_ROLE_RANGE", path: "/soft/role_targets/ramp" }),
      ]),
    );
  });

  it("diagnoses duplicate identifiers and an allowed list eliminated by exclusions", () => {
    const intent = DeckIntentSchema.parse({
      schema_version: 1,
      hard: {
        excluded_cards: ["leader"],
        commanders: {
          allowed: ["leader", "leader"],
          required: ["leader", "leader"],
          color_identity: ["G", "G"],
        },
      },
      soft: {
        favorites: [
          { oracle_id: "pet", qty: 1 },
          { oracle_id: "pet", qty: 2 },
        ],
      },
    });
    expect(intentDiagnostics(intent)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DUPLICATE_CARD", path: "/hard/commanders/allowed/1" }),
        expect.objectContaining({ code: "DUPLICATE_CARD", path: "/hard/commanders/required/1" }),
        expect.objectContaining({
          code: "DUPLICATE_COLOR",
          path: "/hard/commanders/color_identity/1",
        }),
        expect.objectContaining({ code: "DUPLICATE_CARD", path: "/soft/favorites/1" }),
        expect.objectContaining({ code: "NO_ALLOWED_COMMANDER", path: "/hard/commanders/allowed" }),
      ]),
    );
  });

  it("includes required commanders in the physical deck limit without double-counting locks", () => {
    const intent = DeckIntentSchema.parse({
      schema_version: 1,
      hard: {
        locked_cards: [{ oracle_id: "island", qty: 99 }],
        commanders: { required: ["leader", "partner"] },
      },
    });
    expect(intentDiagnostics(intent)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "REQUIRED_QUANTITY_EXCEEDS_DECK", path: "/hard" }),
      ]),
    );
    const inLimit = DeckIntentSchema.parse({
      schema_version: 1,
      hard: {
        locked_cards: [
          { oracle_id: "island", qty: 98 },
          { oracle_id: "leader", qty: 1 },
        ],
        commanders: { required: ["leader", "partner"] },
      },
    });
    expect(intentDiagnostics(inLimit)).toEqual([]);
    const duplicate = DeckIntentSchema.parse({
      schema_version: 1,
      hard: {
        locked_cards: [{ oracle_id: "island", qty: 99 }],
        commanders: { required: ["leader", "leader"] },
      },
    });
    expect(intentDiagnostics(duplicate).map((item) => item.code)).toEqual(["DUPLICATE_CARD"]);
  });
});

describe("deck intent merge patches", () => {
  it("recursively merges objects, replaces arrays, removes null fields, and preserves input", () => {
    const original = DeckIntentSchema.parse({
      schema_version: 1,
      hard: { excluded_cards: ["old"], change_limit: 3 },
      soft: {
        goals: ["old goal"],
        strategy: "tokens",
        role_targets: { ramp: { min: 8, max: 12 } },
      },
    });
    const saved = structuredClone(original);
    const next = patchDeckIntent(original, {
      hard: { excluded_cards: ["new"] },
      soft: { goals: null, role_targets: { ramp: { min: 10 } } },
    });
    expect(next).toEqual({
      schema_version: 1,
      hard: { excluded_cards: ["new"], change_limit: 3 },
      soft: { strategy: "tokens", role_targets: { ramp: { min: 10, max: 12 } } },
    });
    expect(original).toEqual(saved);
    expect(patchDeckIntent(next, { hard: null, soft: null })).toEqual({ schema_version: 1 });
  });

  it("initializes absent intent with the supported schema version", () => {
    expect(patchDeckIntent(undefined, { soft: { strategy: "tokens" } })).toEqual({
      schema_version: 1,
      soft: { strategy: "tokens" },
    });
  });

  it.each([
    null,
    [],
    "intent",
    { schema_version: null },
    { hard: { unknown: true } },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ])("rejects invalid merge patch %j", (patch) => {
    expect(() => patchDeckIntent(undefined, patch)).toThrow();
    expect(Object.hasOwn({}, "polluted")).toBe(false);
  });

  it.each([
    { patch: null, path: [] },
    { patch: { hard: { constructor: {} } }, path: ["hard", "constructor"] },
  ])("returns structured validation paths for rejected patches %j", ({ patch, path }) => {
    let caught: unknown;
    try {
      patchDeckIntent(undefined, patch);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(z.ZodError);
    if (!(caught instanceof z.ZodError)) throw new Error("missing validation issue");
    expect(caught.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "custom", path, message: expect.any(String) }),
      ]),
    );
  });
});

describe("effective role targets", () => {
  it("overlays intent targets and returns independent copies of shared defaults", () => {
    const intent = DeckIntentSchema.parse({
      schema_version: 1,
      soft: {
        role_targets: { ramp: { min: 12, max: 16 }, wincon: { min: 2, max: 4 } },
      },
    });
    const bands = effectiveRoleTargets({ intent });
    expect(bands).toMatchObject({
      ramp: { min: 12, max: 16 },
      land: { min: 33, max: 38 },
      wincon: { min: 2, max: 4 },
    });
    if (bands.land) bands.land.min = 0;
    if (bands.ramp) bands.ramp.min = 0;
    expect(DEFAULT_BANDS.land?.min).toBe(33);
    expect(intent.soft?.role_targets?.ramp?.min).toBe(12);
    expect(effectiveRoleTargets({})).toEqual(DEFAULT_BANDS);
  });
});
