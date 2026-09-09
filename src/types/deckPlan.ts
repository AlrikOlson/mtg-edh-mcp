/** Exact desired inventory plus versioned construction constraints for a preview. */
import { z } from "zod";
import {
  ConstructionRequestSchema,
  type ConstructionDiagnostic,
  type ConstructionResult,
} from "./construction.js";
import type { BudgetPlan } from "../analyze/budget.js";
import type { Role } from "./card.js";
import type { Violation } from "./violation.js";

export const DeckPlanRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine((value) => !value.includes("\0"), "Name must contain no NUL")
      .optional(),
    request: ConstructionRequestSchema.extend({
      cards: ConstructionRequestSchema.shape.cards.unwrap(),
    }),
  })
  .strict();
export type DeckPlanRequest = z.infer<typeof DeckPlanRequestSchema>;

export interface DeckPlanValidation {
  valid: boolean;
  normalization: ConstructionResult;
  diagnostics: ConstructionDiagnostic[];
  legality: Violation[];
  budget: BudgetPlan;
  edits: { additions: number; removals: number; changes: number };
  /** Null when installed characteristics do not establish a single counting policy. */
  land_count: number | null;
  /** Counts of overlapping advisory labels, including saved user overrides. */
  role_counts: Partial<Record<Role, number>>;
}
