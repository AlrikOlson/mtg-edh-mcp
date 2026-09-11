import { describe, expect, it } from "vitest";
import { fakeWorkerArgs, type FakeWorkerMode } from "./fakeWorker.test-support.js";
import {
  PREVIEW_MAX_DURATION_MS,
  PreviewFixtureService,
  PreviewRunError,
  PreviewRunInputSchema,
} from "./previewRun.js";
import { PREVIEW_FIXTURE_DIGEST, PREVIEW_FIXTURE_ID } from "./protocol.generated.js";
import { deriveTrialSeed } from "./trialSeed.js";

const binary = process.env.MTG_WORKER_BINARY;
const native = it.skipIf(!binary);
const input = { fixture_id: PREVIEW_FIXTURE_ID, seed: "0000000000000000" };

/** The fake worker speaks protocol 5 through `node -e`; the service only sees an executable. */
function fakeService(mode: FakeWorkerMode): PreviewFixtureService {
  return new PreviewFixtureService({
    executable: process.execPath,
    args: fakeWorkerArgs(mode),
    maxConcurrent: 1,
  });
}

async function failure(promise: Promise<unknown>): Promise<PreviewRunError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PreviewRunError) return error;
    throw error;
  }
  throw new Error("expected a PreviewRunError");
}

describe("PreviewFixtureService input boundary", () => {
  it("accepts only the declared fixture, bounded limits and the two named policies", () => {
    const parsed = PreviewRunInputSchema.parse(input);
    expect(parsed).toMatchObject({
      trial_index: 0,
      trials: 1,
      policies: ["fixture-baseline", "fixture-pass"],
      max_turns: 10,
      max_elapsed_ms: 5000,
    });
    for (const bad of [
      { ...input, fixture_id: "muldrotha-final" },
      { ...input, seed: "seed" },
      { ...input, deck_id: "authored" },
      { ...input, policies: ["fixture-baseline", "optimal"] },
      { ...input, max_turns: 0 },
      { ...input, max_turns: 51 },
      { ...input, max_elapsed_ms: 60_000 },
      { ...input, trials: 9 },
    ])
      expect(PreviewRunInputSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a trial index at or beyond the trial count before any worker starts", async () => {
    const service = fakeService("complete");
    const error = await failure(service.run({ ...input, trial_index: 1, trials: 1 }));
    expect(error.code).toBe("invalid_input");
    expect(error.reason).toBe("trial_index");
    expect(service.active()).toBe(0);
  });

  it("declares a numeric maximum duration", () => {
    expect(fakeService("complete").describe()).toMatchObject({
      fixture_id: PREVIEW_FIXTURE_ID,
      fixture_digest: PREVIEW_FIXTURE_DIGEST,
      policies: ["fixture-baseline", "fixture-pass"],
      max_duration_ms: PREVIEW_MAX_DURATION_MS,
    });
    expect(PREVIEW_MAX_DURATION_MS).toBe(36_000);
  });
});

describe("PreviewFixtureService over a protocol-shaped fake worker", () => {
  it("returns the worker's own outcome with immutable inputs, trace and receipt", async () => {
    const service = fakeService("complete");
    const receipts: unknown[] = [];
    service.onReceipt((receipt) => receipts.push(receipt));
    const progress: number[] = [];
    const report = await service.run(
      { ...input, max_turns: 3 },
      { onProgress: (p) => progress.push(p.turns) },
    );
    expect(report).toMatchObject({
      stage: "run",
      status: "completed",
      fixture: { id: PREVIEW_FIXTURE_ID, digest: PREVIEW_FIXTURE_DIGEST },
      engine: { protocol_version: 5, implementation_version: "core-support-v1" },
      admission: { admission_id: "fake-admission" },
      events_total: 2,
      supervision: { termination: "closed", exit_code: 0 },
    });
    expect(report.input.trial_seed).toBe(deriveTrialSeed("0000000000000000", 0));
    expect(report.limits).toMatchObject({ trials: 1, max_turns: 3, max_work: 100_000 });
    expect(progress).toEqual([1, 2]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.input)).toBe(true);
    expect(receipts).toHaveLength(1);
  });

  it.each([
    ["unsupported", "unsupported"],
    ["engine_error", "engine_error"],
  ] as const)("propagates a worker %s outcome as a result, not a failure", async (mode, status) => {
    const report = await fakeService(mode).run(input);
    expect(report.stage).toBe("run");
    expect(report.status).toBe(status);
    expect(report.outcome.type).toBe(status);
  });

  it("reports a crashed worker as a worker failure carrying the receipt", async () => {
    const service = fakeService("crash");
    const receipts: unknown[] = [];
    service.onReceipt((receipt) => receipts.push(receipt));
    const error = await failure(service.run(input));
    expect(error.code).toBe("worker_failure");
    expect(error.reason).toBe("crashed");
    expect(error.receipt).toMatchObject({ exit_code: 3 });
    expect(receipts).toHaveLength(1);
    expect(service.active()).toBe(0);
  });

  it("cancels a live run cooperatively from the request signal", async () => {
    const controller = new AbortController();
    const report = await fakeService("slow").run(input, {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.turns === 2) controller.abort();
      },
    });
    expect(report.status).toBe("cancelled");
    expect(report.events_total).toBeGreaterThanOrEqual(2);
    expect(report.supervision).toMatchObject({ termination: "closed", hard_killed: false });
  });

  it("hard-kills a worker that ignores the cancel and reports the abort", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const error = await failure(
      fakeService("immortal-ignore-cancel").run(input, { signal: controller.signal }),
    );
    expect(error.code).toBe("worker_failure");
    expect(error.reason).toBe("aborted");
    expect(error.receipt).toMatchObject({ termination: "aborted", hard_killed: true });
  });

  it("refuses a second concurrent run as busy", async () => {
    const service = fakeService("slow");
    const controller = new AbortController();
    let busy: PreviewRunError | null = null;
    const first = service.run(input, {
      signal: controller.signal,
      onProgress: async () => {
        if (busy) return;
        busy = await failure(service.run(input));
        controller.abort();
      },
    });
    await first;
    expect((busy as unknown as PreviewRunError | null)?.reason).toBe("busy");
    expect(service.active()).toBe(0);
  });
});

describe("PreviewFixtureService against the pinned native worker", () => {
  native("plays the fixture to the baseline's lethal attack on turn five", async () => {
    const service = new PreviewFixtureService({ executable: binary as string });
    const [a, b] = await Promise.all([service.run(input), service.run(input)]);
    expect(a.stage).toBe("run");
    expect(a.status).toBe("completed");
    if (a.outcome.type !== "completed") throw new Error(JSON.stringify(a.outcome));
    expect(a.outcome.data).toMatchObject({
      winner_seats: [0],
      reason: "life_reached_zero",
      turns: 5,
    });
    // Admission proves setup for the scenario seed; the trial starts from its derived seed.
    expect(a.admission?.initial_state_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.outcome.data.initial_state_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.outcome.data.initial_state_hash).not.toBe(a.outcome.data.final_state_hash);
    expect(a.events.map((e) => e.turns)).toEqual([1, 2, 3, 4]);
    expect(a.catalog_digest).toBe(a.admission?.catalog_digest);
    // Two independent processes agree on every digest and hash.
    expect(b.admission).toEqual(a.admission);
    expect(b.outcome).toEqual(a.outcome);
    expect(b.events).toEqual(a.events);
    expect(a.supervision).toMatchObject({ termination: "closed", exit_code: 0, stderr: "" });
  });

  native("truncates at the declared turn cap without naming a winner", async () => {
    const service = new PreviewFixtureService({ executable: binary as string });
    const report = await service.run({ ...input, max_turns: 2 });
    expect(report.status).toBe("truncated");
    expect(report.outcome).toMatchObject({
      type: "truncated",
      data: { reason: "turn_limit", turns: 2 },
    });
    expect(report.outcome).not.toHaveProperty("data.winner_seats");
  });

  native("changes the game with another trial index and rejects nothing it admitted", async () => {
    const service = new PreviewFixtureService({ executable: binary as string });
    const [first, second] = await Promise.all([
      service.run({ ...input, trials: 2, trial_index: 0 }),
      service.run({ ...input, trials: 2, trial_index: 1 }),
    ]);
    expect(first.admission?.scenario_digest).toBe(second.admission?.scenario_digest);
    expect(first.input.trial_seed).not.toBe(second.input.trial_seed);
    expect(first.status).toBe("completed");
    expect(second.stage).toBe("run");
  });
});
