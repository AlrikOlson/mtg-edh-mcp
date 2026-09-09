import { z } from "zod";

const maximum = z.number().int().min(0).max(100);

/** Typed playgroup declarations only; profile labels do not imply restrictions. */
export const PlaygroupPolicySchema = z
  .object({
    profile: z.enum(["casual", "thematic", "competitive", "custom"]).optional(),
    bracket: z.number().int().min(1).max(5).optional(),
    limits: z
      .object({
        game_changers: maximum.optional(),
        tutors: maximum.optional(),
        fast_mana: maximum.optional(),
        extra_turns: maximum.optional(),
        mass_land_denial: maximum.optional(),
        infinite_combos: maximum.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PlaygroupPolicy = z.infer<typeof PlaygroupPolicySchema>;
