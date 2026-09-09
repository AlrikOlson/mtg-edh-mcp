/** Versioned, read-only input and normalized output for future deck construction. */
import { z } from "zod";
import { DeckIntentSchema, type DeckIntent } from "../deck/intent.js";
import { ROLES, type Role } from "./card.js";
import type { CommandZoneKind, DeckCardEntry } from "./deck.js";
import type { Color } from "./color.js";

const reference = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !value.includes("\0"), "Reference must contain no NUL");
const text = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((value) => !value.includes("\0"), "Text must contain no NUL");
const count = z.number().int().min(0).max(100);
const strength = z.enum(["hard", "preferred"]);
const zoneKind = z.enum(["single", "partner", "background", "doctor_companion"]);
const entry = z.object({ oracle_id: reference, qty: z.number().int().min(1).max(100) }).strict();
const range = z.object({ min: count, max: count, strength }).strict();
const zone = z
  .object({ commanders: z.array(reference).min(1).max(2), command_zone_kind: zoneKind })
  .strict();

export const ConstructionRequestSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    commanders: z.array(reference).max(2).optional(),
    command_zone_kind: zoneKind.optional(),
    command_zone_alternatives: z.array(zone).min(1).max(30).optional(),
    companion: reference.nullable().optional(),
    theme: text.optional(),
    cards: z.array(entry).max(100).optional(),
    intent: DeckIntentSchema.optional(),
    budget: z
      .object({
        mode: z.enum(["unspecified", "unbounded", "cap", "target"]),
        usd: z.number().finite().nonnegative().optional(),
        include_companion: z.boolean().default(false),
      })
      .strict()
      .optional(),
    lands: range.optional(),
    roles: z.partialRecord(z.enum(ROLES), range).optional(),
    requirements: z
      .array(z.object({ id: reference, text, strength }).strict())
      .max(100)
      .optional(),
    strategy_dependencies: z
      .array(
        z
          .object({
            id: reference,
            strength,
            requires_cards: z.array(reference).max(100).optional(),
            requires_roles: z.array(z.enum(ROLES)).max(ROLES.length).optional(),
            text: text.optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    edit_bounds: z
      .object({
        max_additions: count.optional(),
        max_removals: count.optional(),
        max_changes: count.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ConstructionRequest = z.infer<typeof ConstructionRequestSchema>;
export interface ConstructionDiagnostic {
  code: string;
  severity: "conflict" | "unresolved" | "advisory";
  path: string;
  related_paths: string[];
  message: string;
}
export interface ConstructionZone {
  commanders: string[];
  command_zone_kind: CommandZoneKind;
  color_identity: Color[];
  library_size: number;
}
export interface ConstructionChoice {
  id: string;
  path: string;
  reason: string;
  options: Array<{ value: unknown; label: string }>;
}
export interface ConstructionUnresolvedRequirement {
  id: string;
  path: string;
  text: string;
  strength: "hard" | "preferred";
  reason: string;
}
export interface ConstructionSpecification {
  schema_version: 1;
  format: "commander";
  source:
    | { kind: "request" }
    | {
        kind: "saved_deck";
        deck_id: string;
        version: number;
        data_snapshot: string;
        intent_snapshot: DeckIntent | null;
      };
  command_zone: ConstructionZone | null;
  requested_command_zone: {
    commanders: string[];
    command_zone_kind: CommandZoneKind | null;
  } | null;
  role_overrides: Readonly<Record<string, readonly Role[]>>;
  command_zone_alternatives: Array<{
    zone: ConstructionZone;
    status: "valid" | "invalid" | "unresolved";
    diagnostics: ConstructionDiagnostic[];
  }>;
  companion: { oracle_id: string; outside_deck: true } | null;
  theme: string | null;
  seed_cards: DeckCardEntry[];
  card_accounting: {
    deck_size: 100;
    command_zone_quantity: number | null;
    library_size: number | null;
    seed_library_quantity: number;
    companion_quantity: 0 | 1;
    role_memberships_overlap: true;
  };
  intent: DeckIntent | null;
  budget: {
    mode: "unspecified" | "unbounded" | "cap" | "target";
    usd: number | null;
    include_companion: boolean;
    currency: "USD";
  };
  lands: ConstructionRequest["lands"] | null;
  roles: Partial<Record<Role, { min: number; max: number; strength: "hard" | "preferred" }>>;
  requirements: NonNullable<ConstructionRequest["requirements"]>;
  strategy_dependencies: NonNullable<ConstructionRequest["strategy_dependencies"]>;
  edit_bounds: NonNullable<ConstructionRequest["edit_bounds"]>;
  preferred_relaxations: Array<{ path: string; reason: string }>;
}
export interface ConstructionResult {
  schema_version: 1;
  status: "ready" | "needs_choices" | "conflict";
  specification: ConstructionSpecification;
  diagnostics: ConstructionDiagnostic[];
  choices: ConstructionChoice[];
  unresolved_requirements: ConstructionUnresolvedRequirement[];
}
