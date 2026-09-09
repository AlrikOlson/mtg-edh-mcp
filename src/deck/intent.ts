/** Durable deckbuilding intent: hard constraints, advisory preferences and explicit limits. */
import { z } from "zod";
import { PlaygroupPolicySchema } from "./playgroupPolicy.js";
import { DEFAULT_BANDS, type RoleBands } from "../analyze/mana.js";
import { ROLES } from "../types/card.js";
import type { Deck } from "../types/deck.js";

const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => value === value.trim() && !value.includes("\0"),
    "identifier must be trimmed and contain no NUL",
  );
const text = z
  .string()
  .min(1)
  .max(2000)
  .refine(
    (value) => value.trim().length > 0 && !value.includes("\0"),
    "text must be nonempty and contain no NUL",
  );
const quantity = z.number().int().min(1).max(100);
const count = z.number().int().min(0).max(100);
const cardQuantity = z.object({ oracle_id: identifier, qty: quantity }).strict();
const roleBand = z.object({ min: count, max: count }).strict();

/** The sole schema for tool input and persisted intent, including nested fields. */
export const DeckIntentSchema = z
  .object({
    schema_version: z.literal(1),
    playgroup: PlaygroupPolicySchema.optional(),
    hard: z
      .object({
        locked_cards: z.array(cardQuantity).max(100).optional(),
        excluded_cards: z.array(identifier).max(1000).optional(),
        commanders: z
          .object({
            allowed: z.array(identifier).max(1000).optional(),
            required: z.array(identifier).max(100).optional(),
            color_identity: z
              .array(z.enum(["W", "U", "B", "R", "G"]))
              .max(5)
              .optional(),
          })
          .strict()
          .optional(),
        change_limit: count.optional(),
      })
      .strict()
      .optional(),
    soft: z
      .object({
        goals: z.array(text).max(100).optional(),
        strategy: text.optional(),
        favorites: z.array(cardQuantity).max(100).optional(),
        role_targets: z.partialRecord(z.enum(ROLES), roleBand).optional(),
        spend_target_usd: z.number().finite().nonnegative().optional(),
        playgroup_preferences: z.array(text).max(100).optional(),
      })
      .strict()
      .optional(),
    unsupported: z.array(text).max(100).optional(),
  })
  .strict();

export type DeckIntent = z.infer<typeof DeckIntentSchema>;

/** JSON Pointer paths identify the exact request field requiring attention. */
export interface IntentDiagnostic {
  code: string;
  path: string;
  message: string;
}

/** Check internal consistency without requiring an aspirational intent to match today's deck. */
export function intentDiagnostics(intent: DeckIntent): IntentDiagnostic[] {
  const diagnostics: IntentDiagnostic[] = [];
  const add = (code: string, path: string, message: string): void => {
    diagnostics.push({ code, path, message });
  };
  const duplicates = (values: readonly string[], path: string, code = "DUPLICATE_CARD"): void => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) add(code, `${path}/${index}`, `Duplicate value '${value}'.`);
      seen.add(value);
    }
  };
  const locked = intent.hard?.locked_cards ?? [];
  const excluded = new Set(intent.hard?.excluded_cards ?? []);
  const commanders = intent.hard?.commanders;
  const allowed = commanders?.allowed === undefined ? undefined : new Set(commanders.allowed);
  const required = commanders?.required ?? [];

  duplicates(
    locked.map((entry) => entry.oracle_id),
    "/hard/locked_cards",
  );
  duplicates(intent.hard?.excluded_cards ?? [], "/hard/excluded_cards");
  duplicates(commanders?.allowed ?? [], "/hard/commanders/allowed");
  duplicates(required, "/hard/commanders/required");
  duplicates(
    commanders?.color_identity ?? [],
    "/hard/commanders/color_identity",
    "DUPLICATE_COLOR",
  );
  duplicates(
    (intent.soft?.favorites ?? []).map((entry) => entry.oracle_id),
    "/soft/favorites",
  );

  for (const [index, entry] of locked.entries()) {
    if (excluded.has(entry.oracle_id)) {
      add(
        "LOCKED_EXCLUDED",
        `/hard/locked_cards/${index}`,
        `Locked card '${entry.oracle_id}' is also excluded.`,
      );
    }
  }
  for (const [index, oracleId] of required.entries()) {
    if (excluded.has(oracleId)) {
      add(
        "REQUIRED_EXCLUDED",
        `/hard/commanders/required/${index}`,
        `Required commander '${oracleId}' is also excluded.`,
      );
    }
    if (allowed && !allowed.has(oracleId)) {
      add(
        "REQUIRED_NOT_ALLOWED",
        `/hard/commanders/required/${index}`,
        `Required commander '${oracleId}' is outside the allowed list.`,
      );
    }
  }
  if (allowed && [...allowed].every((oracleId) => excluded.has(oracleId))) {
    add(
      "NO_ALLOWED_COMMANDER",
      "/hard/commanders/allowed",
      "No allowed commander remains after exclusions.",
    );
  }
  if (required.length > 2) {
    add(
      "TOO_MANY_REQUIRED_COMMANDERS",
      "/hard/commanders/required",
      "Commander supports at most two required commanders.",
    );
  }
  const lockedQuantity = locked.reduce((sum, entry) => sum + entry.qty, 0);
  const lockedIds = new Set(locked.map((entry) => entry.oracle_id));
  const requiredOutsideLocks = [...new Set(required)].filter((id) => !lockedIds.has(id)).length;
  if (lockedQuantity > 100) {
    add(
      "LOCKED_QUANTITY_EXCEEDS_DECK",
      "/hard/locked_cards",
      "Locked quantities exceed the 100-card deck size.",
    );
  } else if (lockedQuantity + requiredOutsideLocks > 100) {
    add(
      "REQUIRED_QUANTITY_EXCEEDS_DECK",
      "/hard",
      "Locked quantities and required commanders together exceed the 100-card deck size.",
    );
  }
  for (const [role, band] of Object.entries(intent.soft?.role_targets ?? {})) {
    if (band.min > band.max) {
      add(
        "INVALID_ROLE_RANGE",
        `/soft/role_targets/${role}`,
        "Role minimum must not exceed its maximum.",
      );
    }
  }
  return diagnostics;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/** RFC 7396 merge behavior; maps avoid special treatment of keys such as __proto__. */
function mergePatch(current: unknown, patch: unknown, path: string[] = []): unknown {
  if (!isObject(patch)) return patch;
  const merged = new Map(Object.entries(isObject(current) ? current : {}));
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new z.ZodError([
        {
          code: "custom",
          path: [...path, key],
          message: `Unsupported intent patch key '${key}'.`,
        },
      ]);
    }
    if (value === null) merged.delete(key);
    else merged.set(key, mergePatch(merged.get(key), value, [...path, key]));
  }
  return Object.fromEntries(merged);
}

/** Apply an object merge patch and validate the complete result before any state mutation. */
export function patchDeckIntent(current: DeckIntent | undefined, patch: unknown): DeckIntent {
  if (!isObject(patch))
    throw new z.ZodError([
      {
        code: "custom",
        path: [],
        message: "Deck intent patch must be an object.",
      },
    ]);
  return DeckIntentSchema.parse(mergePatch(current ?? { schema_version: 1 }, patch));
}

/** Per-deck preferences overlay the established advisory bands without sharing mutable objects. */
export function effectiveRoleTargets(deck: Pick<Deck, "intent">): RoleBands {
  return structuredClone({
    ...DEFAULT_BANDS,
    ...deck.intent?.soft?.role_targets,
  });
}
