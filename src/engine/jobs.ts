/**
 * Durable, principal-scoped engine jobs (chunk engine-mvp-supervision).
 *
 * One instance per process is injected into every server the process creates,
 * exactly like {@link PreviewFixtureService}: all job state, the queue and the
 * cancellation controllers live here, never inside a per-request McpServer.
 *
 * A job is the same bounded fixture run the preview tool performs, detached
 * from the request that submitted it: the record is written to the durable
 * {@link EngineJobStore} before its handle is returned, it waits in a bounded
 * FIFO queue behind the runner's concurrency ceiling, it runs through the one
 * existing service (which spawns the one supervised worker), and its terminal
 * state is the worker's own outcome or the supervisor's receipt, never a state
 * the parent made up. Cancelling a running job is acknowledged at once and
 * becomes terminal only when the worker is actually gone.
 *
 * The installed SDK carries no Tasks-extension runtime, so this is the bounded
 * explicit submit/status/cancel workflow every host can use; the extension is
 * a separate roadmap unit over this service.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  EngineJobStore,
  isTerminalJobStatus,
  type JobFailure,
  type JobRecord,
  type JobStatus,
} from "./jobStore.js";
import {
  PREVIEW_IMPLEMENTATION_VERSION,
  PREVIEW_RUN_INPUT_SHAPE,
  PreviewFixtureService,
  PreviewRunError,
} from "./previewRun.js";
import {
  ENGINE_VERSION,
  PREVIEW_FIXTURE_DIGEST,
  PREVIEW_FIXTURE_ID,
  PREVIEW_FIXTURE_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_SHA256,
} from "./protocol.generated.js";
import { deriveTrialSeed } from "./trialSeed.js";

/** The tool's own bounded shape plus an optional idempotency key; the relay client stays refused. */
export const JOB_SUBMIT_INPUT_SHAPE = {
  ...PREVIEW_RUN_INPUT_SHAPE,
  /** Repeating a submission with the same key under the same principal returns the same job. */
  idempotency_key: z.string().min(1).max(128).optional(),
};
const JobSubmitInputSchema = z.strictObject(JOB_SUBMIT_INPUT_SHAPE);

export type EngineJobErrorCode = "invalid_input" | "queue_full";

export class EngineJobError extends Error {
  override readonly name = "EngineJobError";
  constructor(
    readonly code: EngineJobErrorCode,
    message: string,
    readonly reason: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface EngineJobServiceOptions {
  readonly runner: PreviewFixtureService;
  readonly store: EngineJobStore;
  /** Jobs running at once; at most the runner's own concurrency ceiling is useful. */
  readonly maxRunning?: number;
  /** Jobs waiting behind the running ones, across every principal. */
  readonly maxQueued?: number;
  /** Jobs one principal may have waiting. */
  readonly maxQueuedPerPrincipal?: number;
  /** Delay before retrying a job the shared runner refused as busy. */
  readonly busyRetryMs?: number;
  /** Diagnostics sink; defaults to stderr. */
  readonly log?: (message: string) => void;
}

export interface SubmitOptions {
  /** The data snapshot the submitting server serves, kept for provenance. */
  readonly dataSnapshot?: string;
}

export interface SubmitResult {
  readonly record: JobRecord;
  /** False when the idempotency key named an existing job. */
  readonly created: boolean;
  /** One-based place in the queue, or null when the job is not waiting. */
  readonly queue_position: number | null;
}

export type CancelOutcome = "cancelled_before_start" | "acknowledged" | "already_terminal";

export interface CancelResult {
  readonly record: JobRecord;
  readonly outcome: CancelOutcome;
}

export interface JobCapacity {
  readonly running: number;
  readonly queued: number;
  readonly max_running: number;
  readonly max_queued: number;
  readonly max_queued_per_principal: number;
}

interface LiveJob {
  record: JobRecord;
  /** The runner's input: the captured fields without the record-only trial seed and key. */
  readonly input: Record<string, unknown>;
  readonly controller: AbortController;
}

const DEFAULT_MAX_RUNNING = 1;
const DEFAULT_MAX_QUEUED = 16;
const DEFAULT_MAX_QUEUED_PER_PRINCIPAL = 4;
const DEFAULT_BUSY_RETRY_MS = 100;
/** Terminal records kept in memory after the store, so a failed persist stays visible. */
const RECENT_TERMINAL = 64;

const now = (): string => new Date().toISOString();

export class EngineJobService {
  private readonly runner: PreviewFixtureService;
  private readonly store: EngineJobStore;
  private readonly maxRunning: number;
  private readonly maxQueued: number;
  private readonly maxQueuedPerPrincipal: number;
  private readonly busyRetryMs: number;
  private readonly log: (message: string) => void;
  private readonly queue: LiveJob[] = [];
  private readonly running = new Map<string, LiveJob>();
  private readonly live = new Map<string, LiveJob>();
  private readonly recent = new Map<string, JobRecord>();
  private readonly executions = new Set<Promise<void>>();
  private readonly recovered: readonly JobRecord[];
  private retryTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: EngineJobServiceOptions) {
    this.runner = options.runner;
    this.store = options.store;
    this.maxRunning = options.maxRunning ?? DEFAULT_MAX_RUNNING;
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.maxQueuedPerPrincipal = options.maxQueuedPerPrincipal ?? DEFAULT_MAX_QUEUED_PER_PRINCIPAL;
    this.busyRetryMs = options.busyRetryMs ?? DEFAULT_BUSY_RETRY_MS;
    this.log = options.log ?? ((message) => console.error(message));
    for (const value of [this.maxRunning, this.maxQueued, this.maxQueuedPerPrincipal])
      if (!Number.isInteger(value) || value <= 0)
        throw new RangeError("job capacities must be positive integers");
    // Nothing survives the process: a job that was queued or running when the
    // previous process ended has no worker and no checkpoint to resume from.
    const recovered: JobRecord[] = [];
    const interrupted: JobFailure = {
      code: "interrupted",
      reason: "process_restart",
      message:
        "the serving process ended before the job finished; there is no checkpoint to resume it",
      receipt: null,
    };
    for (const record of this.store.listNonTerminal()) {
      const failed: JobRecord = Object.freeze({
        ...record,
        status: "failed",
        finished_at: now(),
        failure: interrupted,
        persistence_error: null,
      });
      try {
        this.store.update(failed);
        recovered.push(failed);
      } catch (error) {
        this.log(`engine job ${record.job_id}: ${error instanceof Error ? error.message : "?"}`);
        recovered.push({ ...failed, persistence_error: describe(error) });
      }
    }
    this.recovered = Object.freeze(recovered);
  }

  /** Jobs found unfinished at construction and marked interrupted. */
  recoveredJobs(): readonly JobRecord[] {
    return this.recovered;
  }

  capacity(): JobCapacity {
    return {
      running: this.running.size,
      queued: this.queue.length,
      max_running: this.maxRunning,
      max_queued: this.maxQueued,
      max_queued_per_principal: this.maxQueuedPerPrincipal,
    };
  }

  /**
   * Validate, persist and queue one job. The record is on disk before this
   * returns; the returned status is `queued` or, when a slot was free, `running`.
   */
  submit(principal: string, rawInput: unknown, options: SubmitOptions = {}): SubmitResult {
    if (this.closed)
      throw new EngineJobError("queue_full", "the job service is shut down", "closed");
    const parsed = JobSubmitInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new EngineJobError("invalid_input", parsed.error.message, "schema");
    const { idempotency_key: key = null, ...input } = parsed.data;
    if (input.trial_index >= input.trials)
      throw new EngineJobError(
        "invalid_input",
        `trial_index ${input.trial_index} must be below trials ${input.trials}`,
        "trial_index",
      );
    if (key !== null) {
      const existing = this.find(principal, key);
      if (existing)
        return { record: existing, created: false, queue_position: this.position(existing.job_id) };
    }
    if (this.queue.length >= this.maxQueued)
      throw new EngineJobError(
        "queue_full",
        `the job queue holds ${this.maxQueued} jobs; retry when one finishes`,
        "global",
      );
    const mine = this.queue.filter((job) => job.record.principal === principal).length;
    if (mine >= this.maxQueuedPerPrincipal)
      throw new EngineJobError(
        "queue_full",
        `this principal already has ${this.maxQueuedPerPrincipal} jobs waiting`,
        "principal",
      );
    const record: JobRecord = {
      job_id: randomUUID(),
      principal,
      idempotency_key: key,
      status: "queued",
      created_at: now(),
      started_at: null,
      finished_at: null,
      cancel_requested_at: null,
      data_snapshot: options.dataSnapshot ?? null,
      input: Object.freeze({
        ...input,
        trial_seed: deriveTrialSeed(input.seed, input.trial_index),
      }),
      fixture: {
        id: PREVIEW_FIXTURE_ID,
        version: PREVIEW_FIXTURE_VERSION,
        digest: PREVIEW_FIXTURE_DIGEST,
      },
      engine: {
        protocol_version: PROTOCOL_VERSION,
        engine_version: ENGINE_VERSION,
        schema_sha256: SCHEMA_SHA256,
        implementation_version: PREVIEW_IMPLEMENTATION_VERSION,
      },
      progress: null,
      report: null,
      failure: null,
      persistence_error: null,
    };
    // Durable creation before the handle exists; a storage error propagates
    // and no worker is started.
    const inserted = this.store.insert(record);
    if (!inserted.created)
      return {
        record: inserted.record,
        created: false,
        queue_position: this.position(inserted.record.job_id),
      };
    const live: LiveJob = {
      record: Object.freeze(inserted.record),
      input,
      controller: new AbortController(),
    };
    this.queue.push(live);
    this.live.set(live.record.job_id, live);
    this.pump();
    return {
      record: live.record,
      created: true,
      queue_position: this.position(live.record.job_id),
    };
  }

  /** The principal's record, or null; another principal's job is indistinguishable from none. */
  get(principal: string, jobId: string): JobRecord | null {
    const live = this.live.get(jobId);
    if (live) return live.record.principal === principal ? live.record : null;
    const recent = this.recent.get(jobId);
    if (recent) return recent.principal === principal ? recent : null;
    return this.store.get(principal, jobId);
  }

  /** One-based queue position of a waiting job, or null. */
  position(jobId: string): number | null {
    const index = this.queue.findIndex((job) => job.record.job_id === jobId);
    return index < 0 ? null : index + 1;
  }

  /**
   * Cancel a job. A waiting job ends at once without a worker; a running job is
   * acknowledged (`cancel_requested_at`) and ends when its worker reports
   * `cancelled` or the supervisor has terminated it; a finished job is left as is.
   */
  cancel(principal: string, jobId: string): CancelResult | null {
    const live = this.live.get(jobId);
    if (!live || live.record.principal !== principal) {
      const stored = this.get(principal, jobId);
      return stored ? { record: stored, outcome: "already_terminal" } : null;
    }
    const stamp = now();
    if (live.record.status === "queued") {
      const index = this.queue.indexOf(live);
      if (index >= 0) this.queue.splice(index, 1);
      this.live.delete(jobId);
      this.transition(live, {
        status: "cancelled",
        cancel_requested_at: stamp,
        finished_at: stamp,
      });
      this.remember(live.record);
      this.pump();
      return { record: live.record, outcome: "cancelled_before_start" };
    }
    if (live.record.cancel_requested_at === null) {
      this.transition(live, { cancel_requested_at: stamp });
      live.controller.abort();
    }
    return { record: live.record, outcome: "acknowledged" };
  }

  /**
   * Stop accepting jobs, cancel every waiting one, abort every running one and
   * resolve once their workers are gone (the supervisor's grace bounds this).
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    for (const live of this.queue.splice(0)) {
      this.live.delete(live.record.job_id);
      const stamp = now();
      this.transition(live, {
        status: "cancelled",
        cancel_requested_at: stamp,
        finished_at: stamp,
      });
      this.remember(live.record);
    }
    for (const live of this.running.values()) {
      if (live.record.cancel_requested_at === null)
        this.transition(live, { cancel_requested_at: now() });
      live.controller.abort();
    }
    await Promise.all([...this.executions]);
  }

  private find(principal: string, key: string): JobRecord | null {
    for (const live of this.live.values())
      if (live.record.principal === principal && live.record.idempotency_key === key)
        return live.record;
    for (const record of this.recent.values())
      if (record.principal === principal && record.idempotency_key === key) return record;
    return this.store.findByKey(principal, key);
  }

  private pump(): void {
    if (this.closed) return;
    while (this.running.size < this.maxRunning && this.queue.length > 0) {
      const live = this.queue.shift();
      if (!live) break;
      this.running.set(live.record.job_id, live);
      this.transition(live, { status: "running", started_at: now() });
      const execution = this.execute(live).finally(() => this.executions.delete(execution));
      this.executions.add(execution);
    }
  }

  private async execute(live: LiveJob): Promise<void> {
    const jobId = live.record.job_id;
    let terminal: Partial<JobRecord>;
    let events = 0;
    try {
      const report = await this.runner.run(live.input, {
        signal: live.controller.signal,
        onProgress: (progress) => {
          events += 1;
          // In memory only; the store sees progress with the next state change.
          live.record = Object.freeze({
            ...live.record,
            progress: { turns: progress.turns, actions: progress.actions, events },
          });
        },
      });
      terminal = { status: report.status, report, finished_at: now() };
    } catch (error) {
      if (error instanceof PreviewRunError && error.reason === "busy" && !this.closed) {
        // The runner is shared with the request-scoped preview tool; wait for
        // its slot instead of failing the job.
        this.running.delete(jobId);
        this.queue.unshift(live);
        this.transition(live, { status: "queued", started_at: null, progress: null });
        this.scheduleRetry();
        return;
      }
      terminal = this.failure(live, error);
    }
    this.running.delete(jobId);
    this.live.delete(jobId);
    this.transition(live, terminal);
    this.remember(live.record);
    this.pump();
  }

  private failure(live: LiveJob, error: unknown): Partial<JobRecord> {
    const finished_at = now();
    if (error instanceof PreviewRunError) {
      const failure: JobFailure = {
        code: error.code === "decision_failure" ? "decision_failure" : "worker_failure",
        reason: error.reason,
        message: error.message,
        receipt: error.receipt ?? null,
      };
      // A requested cancel that the supervisor had to enforce is still a
      // cancellation; the receipt shows the hard kill.
      const cancelled =
        live.record.cancel_requested_at !== null &&
        error.code === "worker_failure" &&
        error.reason === "aborted";
      const status: JobStatus = cancelled ? "cancelled" : "failed";
      return { status, failure, finished_at };
    }
    return {
      status: "failed",
      failure: {
        code: "worker_failure",
        reason: "unexpected",
        message: describe(error),
        receipt: null,
      },
      finished_at,
    };
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.pump();
    }, this.busyRetryMs);
    this.retryTimer.unref?.();
  }

  /** Apply a state change in memory and on disk; a failed persist is recorded, never hidden. */
  private transition(live: LiveJob, patch: Partial<JobRecord>): void {
    const next: JobRecord = { ...live.record, ...patch, persistence_error: null };
    try {
      this.store.update(next);
      live.record = Object.freeze(next);
    } catch (error) {
      const message = describe(error);
      this.log(`engine job ${next.job_id}: ${message}`);
      live.record = Object.freeze({ ...next, persistence_error: message });
    }
  }

  private remember(record: JobRecord): void {
    if (!isTerminalJobStatus(record.status)) return;
    this.recent.set(record.job_id, record);
    while (this.recent.size > RECENT_TERMINAL) {
      const oldest = this.recent.keys().next().value;
      if (oldest === undefined) break;
      this.recent.delete(oldest);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
