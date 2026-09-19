import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StructuredError } from "../types/errors.js";
import { fakeWorkerArgs, type FakeWorkerMode } from "./fakeWorker.test-support.js";
import { EngineJobError, EngineJobService } from "./jobs.js";
import { EngineJobStore, type JobRecord } from "./jobStore.js";
import { PreviewFixtureService } from "./previewRun.js";
import { PREVIEW_FIXTURE_ID } from "./protocol.generated.js";
import type { WorkerReceipt } from "./supervisor.js";
import { deriveTrialSeed } from "./trialSeed.js";

const input = { fixture_id: PREVIEW_FIXTURE_ID, seed: "0000000000000000" };
const roots: string[] = [];
const services: EngineJobService[] = [];
const stores: EngineJobStore[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "engine-jobs-service-"));
  roots.push(dir);
  return dir;
}

function runner(mode: FakeWorkerMode, maxConcurrent = 1): PreviewFixtureService {
  return new PreviewFixtureService({
    executable: process.execPath,
    args: fakeWorkerArgs(mode),
    maxConcurrent,
  });
}

interface Harness {
  readonly service: EngineJobService;
  readonly runner: PreviewFixtureService;
  readonly store: EngineJobStore;
  readonly receipts: WorkerReceipt[];
  readonly logs: string[];
}

async function harness(
  mode: FakeWorkerMode,
  options: {
    maxRunning?: number;
    maxQueued?: number;
    maxQueuedPerPrincipal?: number;
    beforeCommit?: () => void;
    runner?: PreviewFixtureService;
  } = {},
): Promise<Harness> {
  const dir = await root();
  const store = new EngineJobStore(dir, {
    ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}),
  });
  stores.push(store);
  const run = options.runner ?? runner(mode);
  const receipts: WorkerReceipt[] = [];
  run.onReceipt((receipt) => receipts.push(receipt));
  const logs: string[] = [];
  const service = new EngineJobService({
    runner: run,
    store,
    maxRunning: options.maxRunning ?? 1,
    maxQueued: options.maxQueued ?? 16,
    maxQueuedPerPrincipal: options.maxQueuedPerPrincipal ?? 4,
    busyRetryMs: 20,
    log: (message) => logs.push(message),
  });
  services.push(service);
  return { service, runner: run, store, receipts, logs };
}

async function settled(service: EngineJobService, principal: string, jobId: string) {
  await vi.waitFor(
    () => {
      const record = service.get(principal, jobId);
      if (!record) throw new Error("job vanished");
      if (record.status === "queued" || record.status === "running")
        throw new Error(`still ${record.status}`);
    },
    { timeout: 8000, interval: 20 },
  );
  const record = service.get(principal, jobId);
  if (!record) throw new Error("job vanished");
  return record;
}

async function running(service: EngineJobService, principal: string, jobId: string) {
  await vi.waitFor(() => expect(service.get(principal, jobId)?.status).toBe("running"), {
    timeout: 4000,
    interval: 10,
  });
}

/** Wait until the worker has reported at least `turns` turns of progress for the job. */
async function progressed(
  service: EngineJobService,
  principal: string,
  jobId: string,
  turns: number,
) {
  await vi.waitFor(
    () => {
      const record = service.get(principal, jobId);
      expect(record?.status).toBe("running");
      expect(record?.progress?.turns ?? 0).toBeGreaterThanOrEqual(turns);
    },
    { timeout: 6000, interval: 10 },
  );
}

function jobError(body: () => unknown): EngineJobError {
  try {
    body();
  } catch (error) {
    if (error instanceof EngineJobError) return error;
    throw error;
  }
  throw new Error("expected an EngineJobError");
}

describe("EngineJobService", () => {
  it("persists the job before returning its handle and ends with the worker's own outcome", async () => {
    const { service, store, receipts } = await harness("complete");
    const submitted = service.submit("alice", { ...input, max_turns: 3 }, { dataSnapshot: "s1" });
    expect(submitted.created).toBe(true);
    // On disk already, with the immutable inputs and the derived trial seed.
    const stored = store.get("alice", submitted.record.job_id);
    expect(stored).not.toBeNull();
    expect(stored?.input).toMatchObject({
      fixture_id: PREVIEW_FIXTURE_ID,
      max_turns: 3,
      trial_seed: deriveTrialSeed("0000000000000000", 0),
    });
    expect(stored?.data_snapshot).toBe("s1");
    expect(["queued", "running"]).toContain(submitted.record.status);
    expect(service.get("bob", submitted.record.job_id)).toBeNull();
    const done = await settled(service, "alice", submitted.record.job_id);
    expect(done.status).toBe("completed");
    expect(done.report).toMatchObject({
      stage: "run",
      status: "completed",
      supervision: { termination: "closed", exit_code: 0 },
    });
    expect(done.started_at).not.toBeNull();
    expect(done.finished_at).not.toBeNull();
    expect(done.failure).toBeNull();
    expect(done.persistence_error).toBeNull();
    expect(store.get("alice", done.job_id)).toEqual(done);
    expect(receipts).toHaveLength(1);
    expect(service.capacity()).toMatchObject({ running: 0, queued: 0 });
  });

  it("returns one job for concurrent submissions with the same idempotency key", async () => {
    const { service, receipts } = await harness("complete");
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        Promise.resolve().then(() => service.submit("alice", { ...input, idempotency_key: "k" })),
      ),
    );
    const ids = new Set(results.map((r) => r.record.job_id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const [id] = ids;
    await settled(service, "alice", id as string);
    // The same key from another principal is another job.
    const other = service.submit("bob", { ...input, idempotency_key: "k" });
    expect(other.created).toBe(true);
    expect(other.record.job_id).not.toBe(id);
    await settled(service, "bob", other.record.job_id);
    // A repeated key after the job finished still names it, from the store.
    const again = service.submit("alice", { ...input, idempotency_key: "k" });
    expect(again.created).toBe(false);
    expect(again.record.job_id).toBe(id);
    expect(receipts).toHaveLength(2);
  });

  it("refuses invalid input and never starts a worker", async () => {
    const { service, receipts } = await harness("complete");
    expect(jobError(() => service.submit("alice", { ...input, deck_id: "x" })).code).toBe(
      "invalid_input",
    );
    expect(jobError(() => service.submit("alice", { ...input, trial_index: 1 })).reason).toBe(
      "trial_index",
    );
    expect(
      jobError(() =>
        service.submit("alice", { ...input, policies: ["parent-relay", "fixture-pass"] }),
      ).code,
    ).toBe("invalid_input");
    expect(receipts).toHaveLength(0);
    expect(service.capacity()).toMatchObject({ running: 0, queued: 0 });
  });

  it("refuses a submission whose durable write fails, before any worker starts", async () => {
    let fail = true;
    const { service, receipts, store } = await harness("complete", {
      beforeCommit: () => {
        if (fail) throw new Error("disk full");
      },
    });
    let error: unknown;
    try {
      service.submit("alice", { ...input, idempotency_key: "k" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StructuredError);
    expect((error as StructuredError).code).toBe("STORAGE_ERROR");
    expect(store.findByKey("alice", "k")).toBeNull();
    expect(service.capacity()).toMatchObject({ running: 0, queued: 0 });
    fail = false;
    const retried = service.submit("alice", { ...input, idempotency_key: "k" });
    expect(retried.created).toBe(true);
    await settled(service, "alice", retried.record.job_id);
    expect(receipts).toHaveLength(1);
  });

  it("queues behind the running job in order, caps the queue and cancels a waiting job without a worker", async () => {
    const { service, receipts } = await harness("slow", {
      maxRunning: 1,
      maxQueued: 3,
      maxQueuedPerPrincipal: 2,
    });
    const a = service.submit("alice", { ...input, max_turns: 50 });
    await progressed(service, "alice", a.record.job_id, 1);
    const b = service.submit("alice", input);
    const c = service.submit("alice", input);
    expect(b.queue_position).toBe(1);
    expect(c.queue_position).toBe(2);
    expect(jobError(() => service.submit("alice", input)).reason).toBe("principal");
    const d = service.submit("bob", input);
    expect(d.queue_position).toBe(3);
    expect(jobError(() => service.submit("bob", input)).reason).toBe("global");
    expect(service.capacity()).toMatchObject({ running: 1, queued: 3 });

    // Cancelling a waiting job is terminal at once and spawns nothing.
    const cancelledB = service.cancel("alice", b.record.job_id);
    expect(cancelledB?.outcome).toBe("cancelled_before_start");
    expect(cancelledB?.record).toMatchObject({ status: "cancelled", report: null, failure: null });
    expect(service.position(c.record.job_id)).toBe(1);
    // Another principal cannot cancel or see the job.
    expect(service.cancel("bob", c.record.job_id)).toBeNull();

    // Cancelling the running job is acknowledged; the worker reports cancelled.
    const cancelledA = service.cancel("alice", a.record.job_id);
    expect(cancelledA?.outcome).toBe("acknowledged");
    expect(cancelledA?.record.status).toBe("running");
    expect(cancelledA?.record.cancel_requested_at).not.toBeNull();
    expect(cancelledA?.record.progress?.turns).toBeGreaterThanOrEqual(1);
    const doneA = await settled(service, "alice", a.record.job_id);
    expect(doneA.status).toBe("cancelled");
    expect(doneA.report).toMatchObject({
      status: "cancelled",
      supervision: { termination: "closed", hard_killed: false },
    });
    expect(service.cancel("alice", a.record.job_id)?.outcome).toBe("already_terminal");

    // The queue drains in order: C runs before D, each cancelled once live.
    await progressed(service, "alice", c.record.job_id, 1);
    expect(service.get("bob", d.record.job_id)?.status).toBe("queued");
    service.cancel("alice", c.record.job_id);
    const doneC = await settled(service, "alice", c.record.job_id);
    expect(doneC.status).toBe("cancelled");
    await progressed(service, "bob", d.record.job_id, 1);
    service.cancel("bob", d.record.job_id);
    const doneD = await settled(service, "bob", d.record.job_id);
    expect(doneD.status).toBe("cancelled");
    expect(doneC.started_at! < doneD.started_at!).toBe(true);
    expect(receipts).toHaveLength(3);
    expect(service.capacity()).toMatchObject({ running: 0, queued: 0 });
  }, 20_000);

  it("ends a running job as cancelled through a hard kill when the worker ignores the cancel", async () => {
    const run = new PreviewFixtureService({
      executable: process.execPath,
      args: fakeWorkerArgs("immortal-ignore-cancel"),
      maxConcurrent: 1,
    });
    const { service } = await harness("immortal-ignore-cancel", { runner: run });
    const job = service.submit("alice", { ...input, max_turns: 50 });
    await progressed(service, "alice", job.record.job_id, 1);
    expect(service.cancel("alice", job.record.job_id)?.outcome).toBe("acknowledged");
    const done = await settled(service, "alice", job.record.job_id);
    expect(done.status).toBe("cancelled");
    expect(done.report).toBeNull();
    expect(done.failure).toMatchObject({
      code: "worker_failure",
      reason: "aborted",
      receipt: { termination: "aborted", hard_killed: true },
    });
  }, 20_000);

  it("reports a crashed worker as a failed job carrying the receipt", async () => {
    const { service } = await harness("crash");
    const job = service.submit("alice", input);
    const done = await settled(service, "alice", job.record.job_id);
    expect(done.status).toBe("failed");
    expect(done.failure).toMatchObject({
      code: "worker_failure",
      reason: "crashed",
      receipt: { termination: "crashed", exit_code: 3 },
    });
  });

  it.each([
    ["unsupported", "unsupported"],
    ["engine_error", "engine_error"],
  ] as const)("keeps a worker %s outcome as the job status", async (mode, status) => {
    const { service } = await harness(mode);
    const job = service.submit("alice", input);
    const done = await settled(service, "alice", job.record.job_id);
    expect(done.status).toBe(status);
    expect(done.report?.status).toBe(status);
  });

  it("waits for the shared runner instead of failing when a preview request holds the slot", async () => {
    const run = runner("slow", 1);
    const { service, receipts } = await harness("slow", { runner: run });
    const controller = new AbortController();
    let job: ReturnType<EngineJobService["submit"]> | null = null;
    const preview = run.run(
      { ...input, max_turns: 50 },
      {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.turns === 1) job = service.submit("alice", { ...input, max_turns: 2 });
          if (p.turns === 4) controller.abort();
        },
      },
    );
    await preview;
    expect(job).not.toBeNull();
    const submitted = job as unknown as ReturnType<EngineJobService["submit"]>;
    // Once the preview released the slot the job ran; the slow fake never ends
    // on its own, so the job is cancelled once it is visibly live.
    await progressed(service, "alice", submitted.record.job_id, 2);
    service.cancel("alice", submitted.record.job_id);
    const done = await settled(service, "alice", submitted.record.job_id);
    expect(done.status).toBe("cancelled");
    expect(done.report?.status).toBe("cancelled");
    expect(receipts).toHaveLength(2);
  }, 20_000);

  it("marks jobs left unfinished by a previous process as interrupted", async () => {
    const dir = await root();
    const store = new EngineJobStore(dir);
    stores.push(store);
    const base = (status: JobRecord["status"]): JobRecord => ({
      job_id: randomUUID(),
      principal: "alice",
      idempotency_key: null,
      status,
      created_at: new Date().toISOString(),
      started_at: status === "running" ? new Date().toISOString() : null,
      finished_at: null,
      cancel_requested_at: null,
      data_snapshot: null,
      input: { ...input, trial_seed: "1".repeat(16) },
      fixture: { id: PREVIEW_FIXTURE_ID, version: 1, digest: "a".repeat(64) },
      engine: {
        protocol_version: 6,
        engine_version: "x",
        schema_sha256: "b".repeat(64),
        implementation_version: "core-support-v1",
      },
      progress: null,
      report: null,
      failure: null,
      persistence_error: null,
    });
    const wasRunning = store.insert(base("running")).record;
    const wasQueued = store.insert(base("queued")).record;
    const wasDone = store.insert({ ...base("completed"), finished_at: new Date().toISOString() });
    const service = new EngineJobService({ runner: runner("complete"), store, log: () => {} });
    services.push(service);
    expect(
      service
        .recoveredJobs()
        .map((r) => r.job_id)
        .sort(),
    ).toEqual([wasRunning.job_id, wasQueued.job_id].sort());
    for (const id of [wasRunning.job_id, wasQueued.job_id]) {
      const record = service.get("alice", id);
      expect(record).toMatchObject({
        status: "failed",
        failure: { code: "interrupted", reason: "process_restart", receipt: null },
      });
      expect(record?.finished_at).not.toBeNull();
    }
    expect(service.get("alice", wasDone.record.job_id)?.status).toBe("completed");
    expect(store.listNonTerminal()).toEqual([]);
  });

  it("keeps a terminal state visible when its persist fails and says so", async () => {
    let fail = false;
    const { service, store, logs } = await harness("complete", {
      beforeCommit: () => {
        if (fail) throw new Error("disk full");
      },
    });
    const job = service.submit("alice", input);
    await running(service, "alice", job.record.job_id);
    fail = true;
    const done = await settled(service, "alice", job.record.job_id);
    expect(done.status).toBe("completed");
    expect(done.persistence_error).toContain("disk full");
    expect(logs.some((line) => line.includes("disk full"))).toBe(true);
    // The store still holds the last state it could commit.
    expect(store.get("alice", job.record.job_id)?.status).toBe("running");
  });

  it("shuts down by cancelling waiting jobs and aborting running ones", async () => {
    const { service, runner: run } = await harness("slow");
    const a = service.submit("alice", { ...input, max_turns: 50 });
    await progressed(service, "alice", a.record.job_id, 1);
    const b = service.submit("alice", input);
    await service.shutdown();
    expect(service.get("alice", a.record.job_id)?.status).toBe("cancelled");
    expect(service.get("alice", b.record.job_id)).toMatchObject({
      status: "cancelled",
      report: null,
    });
    expect(run.active()).toBe(0);
    expect(jobError(() => service.submit("alice", input)).reason).toBe("closed");
  }, 20_000);
});
