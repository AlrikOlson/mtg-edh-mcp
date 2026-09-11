/**
 * The single TypeScript owner of the worker's trial-seed derivation.
 *
 * The canonical worker (crates/mtg-worker, protocol 5) derives each trial's
 * seed as the first 16 hex digits of SHA-256 over the fixed domain string, the
 * scenario seed and the big-endian u32 trial index, and rejects a `run` whose
 * seed does not match. Seeds therefore depend only on the scenario and the
 * trial index, never on scheduling. Nothing here interprets the seed.
 */
import { createHash } from "node:crypto";
import { SeedSchema, CountSchema, type Seed } from "./protocol.generated.js";

export const TRIAL_SEED_DOMAIN = "mtg-worker-trial-seed-v1";

/** Derive the seed the worker expects for `trialIndex` of a scenario seeded with `seed`. */
export function deriveTrialSeed(seed: Seed, trialIndex: number): Seed {
  const scenarioSeed = SeedSchema.parse(seed);
  const index = CountSchema.parse(trialIndex);
  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE(index);
  return createHash("sha256")
    .update(TRIAL_SEED_DOMAIN)
    .update(scenarioSeed)
    .update(suffix)
    .digest("hex")
    .slice(0, 16);
}
