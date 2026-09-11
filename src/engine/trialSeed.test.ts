import { describe, expect, it } from "vitest";
import { deriveTrialSeed, TRIAL_SEED_DOMAIN } from "./trialSeed.js";

describe("deriveTrialSeed", () => {
  it("derives the worker's scheduling-independent seed from the scenario seed and index", () => {
    const first = deriveTrialSeed("0000000000000000", 0);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveTrialSeed("0000000000000000", 0)).toBe(first);
    expect(deriveTrialSeed("0000000000000000", 1)).not.toBe(first);
    expect(deriveTrialSeed("0000000000000001", 0)).not.toBe(first);
    expect(TRIAL_SEED_DOMAIN).toBe("mtg-worker-trial-seed-v1");
  });

  it("rejects seeds and indexes outside the wire contract", () => {
    expect(() => deriveTrialSeed("nothex", 0)).toThrow();
    expect(() => deriveTrialSeed("0000000000000000", -1)).toThrow();
    expect(() => deriveTrialSeed("0000000000000000", 1.5)).toThrow();
  });
});
