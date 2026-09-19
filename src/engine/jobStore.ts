/**
 * Durable engine job records (chunk engine-mvp-supervision).
 *
 * Jobs are derived engine evidence, not authored user data: they live in their
 * own SQLite file beside the user-data store rather than inside it, so a job
 * can never touch a deck or a collection and the user-data schema needs no
 * migration. The write discipline is the same as user data: WAL, synchronous
 * FULL and one BEGIN IMMEDIATE transaction per write, so a handle is only ever
 * returned after its record is on disk.
 *
 * The store validates every record it reads; a corrupt or foreign row is a
 * STORAGE_ERROR, never a guessed job.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { StructuredError } from "../types/errors.js";
import type { PreviewRunReport } from "./previewRun.js";
import type { WorkerReceipt } from "./supervisor.js";

export const ENGINE_JOBS_DATABASE_NAME = "engine-jobs.sqlite";
const SCHEMA_VERSION = 1;

export const JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "truncated",
  "cancelled",
  "unsupported",
  "invalid",
  "engine_error",
  "failed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "completed",
  "truncated",
  "cancelled",
  "unsupported",
  "invalid",
  "engine_error",
  "failed",
]);

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

/** An object carrying every named key; the payload types are the service's own frozen objects. */
function carrying<T>(...keys: readonly string[]) {
  return z.custom<T>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      keys.every((key) => key in (value as Record<string, unknown>)),
    { message: `expected an object with ${keys.join(", ")}` },
  );
}

/** Why a job ended without a worker outcome. */
export const JobFailureSchema = z.object({
  /** worker_failure: the supervisor ended the run; decision_failure: a relay handler failed; interrupted: the serving process ended. */
  code: z.enum(["worker_failure", "decision_failure", "interrupted"]),
  reason: z.string().min(1),
  message: z.string(),
  /** The process receipt when one exists (never for interrupted jobs). */
  receipt: carrying<WorkerReceipt>("termination", "exit_code", "hard_killed").nullable(),
});
export type JobFailure = z.infer<typeof JobFailureSchema>;

/** The last progress event of a live run; the total is always counted. */
export const JobProgressSchema = z.object({
  turns: z.number().int().nonnegative(),
  actions: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
});
export type JobProgress = z.infer<typeof JobProgressSchema>;

/**
 * The persisted record. `input`, `report` and `failure` are the service's own
 * frozen objects; the envelope is validated strictly and the payloads by their
 * load-bearing keys, so a future report field never makes an old row unreadable.
 */
export const JobRecordSchema = z.strictObject({
  job_id: z.uuid(),
  principal: z.string().min(1),
  idempotency_key: z.string().min(1).max(128).nullable(),
  status: z.enum(JOB_STATUSES),
  created_at: z.iso.datetime(),
  started_at: z.iso.datetime().nullable(),
  finished_at: z.iso.datetime().nullable(),
  cancel_requested_at: z.iso.datetime().nullable(),
  /** The data snapshot the submitting server served, for provenance. */
  data_snapshot: z.string().nullable(),
  /** Immutable inputs exactly as captured, including the derived trial seed. */
  input: z.looseObject({ fixture_id: z.string(), seed: z.string(), trial_seed: z.string() }),
  fixture: z.object({ id: z.string(), version: z.number().int(), digest: z.string() }),
  engine: z.object({
    protocol_version: z.number().int(),
    engine_version: z.string(),
    schema_sha256: z.string(),
    implementation_version: z.string(),
  }),
  /** Progress of the live run, kept in memory and persisted with each state change. */
  progress: JobProgressSchema.nullable(),
  /** The worker's own report once a run ended with an outcome. */
  report: carrying<PreviewRunReport>("stage", "status", "outcome", "supervision").nullable(),
  failure: JobFailureSchema.nullable(),
  /** Set when a state change could not be persisted; the in-memory state stayed authoritative. */
  persistence_error: z.string().nullable(),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

export interface EngineJobStoreOptions {
  /** Failure injection at the final pre-commit boundary, for durability tests. */
  beforeCommit?: () => void;
}

const row = z.object({ payload: z.string() });

function storageError(context: string, error: unknown): StructuredError<"STORAGE_ERROR"> {
  return new StructuredError(
    "STORAGE_ERROR",
    `${context}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

export class EngineJobStore {
  readonly path: string;
  private readonly db: Database.Database;
  private readonly options: EngineJobStoreOptions;

  constructor(root: string, options: EngineJobStoreOptions = {}) {
    this.options = options;
    this.path = join(root, ENGINE_JOBS_DATABASE_NAME);
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      this.db = new Database(this.path, { timeout: 5000 });
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      const version = this.db.pragma("user_version", { simple: true });
      if (version === 0) {
        this.db
          .transaction(() => {
            this.db.exec(
              "CREATE TABLE IF NOT EXISTS engine_jobs (" +
                "job_id TEXT PRIMARY KEY, principal TEXT NOT NULL, idempotency_key TEXT, " +
                "status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, " +
                "payload TEXT NOT NULL, " +
                "UNIQUE (principal, idempotency_key))",
            );
            this.db.exec(
              "CREATE INDEX IF NOT EXISTS engine_jobs_status ON engine_jobs (status, created_at)",
            );
            this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
          })
          .immediate();
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(`unsupported engine-jobs schema version ${String(version)}`);
      }
    } catch (error) {
      throw storageError(`Cannot open engine job store at ${this.path}`, error);
    }
  }

  /**
   * Persist a new record before anything runs. When another record of the same
   * principal already carries the idempotency key, that record is returned and
   * nothing is written; the caller sees `created: false`.
   */
  insert(record: JobRecord): { readonly record: JobRecord; readonly created: boolean } {
    const validated = JobRecordSchema.parse(record);
    if (validated.idempotency_key !== null) {
      const existing = this.findByKey(validated.principal, validated.idempotency_key);
      if (existing) return { record: existing, created: false };
    }
    this.write("Cannot create engine job; nothing was saved", () => {
      this.db
        .prepare(
          "INSERT INTO engine_jobs (job_id, principal, idempotency_key, status, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          validated.job_id,
          validated.principal,
          validated.idempotency_key,
          validated.status,
          validated.created_at,
          new Date().toISOString(),
          JSON.stringify(validated),
        );
    });
    return { record: validated, created: true };
  }

  /** Replace the stored state of an existing record atomically. */
  update(record: JobRecord): void {
    const validated = JobRecordSchema.parse(record);
    this.write("Cannot save engine job state; the previous state is kept", () => {
      const result = this.db
        .prepare("UPDATE engine_jobs SET status = ?, updated_at = ?, payload = ? WHERE job_id = ?")
        .run(
          validated.status,
          new Date().toISOString(),
          JSON.stringify(validated),
          validated.job_id,
        );
      if (result.changes !== 1) throw new Error(`job ${validated.job_id} is not stored`);
    });
  }

  /** A principal's record by id, or null; another principal's job is indistinguishable from none. */
  get(principal: string, jobId: string): JobRecord | null {
    return this.read("Cannot read engine job", () => {
      const value = this.db
        .prepare("SELECT payload FROM engine_jobs WHERE job_id = ? AND principal = ?")
        .get(jobId, principal);
      return value ? this.parse(value) : null;
    });
  }

  /** The principal's record carrying the idempotency key, or null. */
  findByKey(principal: string, idempotencyKey: string): JobRecord | null {
    return this.read("Cannot read engine job", () => {
      const value = this.db
        .prepare("SELECT payload FROM engine_jobs WHERE principal = ? AND idempotency_key = ?")
        .get(principal, idempotencyKey);
      return value ? this.parse(value) : null;
    });
  }

  /** Every record that is neither terminal nor known to be running here, oldest first. */
  listNonTerminal(): JobRecord[] {
    return this.read("Cannot list engine jobs", () =>
      this.db
        .prepare(
          "SELECT payload FROM engine_jobs WHERE status IN ('queued', 'running') ORDER BY created_at, job_id",
        )
        .all()
        .map((value) => this.parse(value)),
    );
  }

  /** Terminal and live records of one principal, newest first, bounded. */
  list(principal: string, limit: number): JobRecord[] {
    return this.read("Cannot list engine jobs", () =>
      this.db
        .prepare(
          "SELECT payload FROM engine_jobs WHERE principal = ? ORDER BY created_at DESC, job_id DESC LIMIT ?",
        )
        .all(principal, limit)
        .map((value) => this.parse(value)),
    );
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  private parse(value: unknown): JobRecord {
    return JobRecordSchema.parse(JSON.parse(row.parse(value).payload));
  }

  private read<T>(context: string, body: () => T): T {
    try {
      return body();
    } catch (error) {
      throw storageError(context, error);
    }
  }

  private write(context: string, body: () => void): void {
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw storageError("Cannot lock the engine job store for writing", error);
    }
    try {
      body();
      this.options.beforeCommit?.();
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw storageError(context, error);
    }
  }
}
