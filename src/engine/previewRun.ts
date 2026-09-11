/**
 * Shared preview-fixture service: the first MCP-to-Rust game path.
 *
 * One instance is injected into every server the process creates (stdio pins
 * one server per connection; stateless HTTP builds one per POST), so all
 * cross-request state, the worker supervisor and its concurrency ceiling live
 * here and never inside a per-request McpServer.
 *
 * Per request the service captures immutable inputs (the trusted fixture, a
 * declared seed, trial index and bounded limits), spawns exactly one native
 * worker, performs the protocol-5 handshake, admits the fixture scenario, runs
 * one trial with the worker-derived seed and returns the worker's own outcome
 * with versions, digests, limits, a bounded progress trace and the process
 * receipt. It plays no Magic: every rule, choice and outcome is the canonical
 * engine's, and a supervisor failure is reported as such, never as a result.
 */
import { z } from "zod";
import { capturePreviewFixture } from "./previewFixture.js";
import { assertCompatibleHello } from "./protocol.js";
import {
  AdmissionSchema,
  CountSchema,
  ENGINE_VERSION,
  PositiveSchema,
  PROTOCOL_VERSION,
  PREVIEW_FIXTURE_DIGEST,
  PREVIEW_FIXTURE_ID,
  PREVIEW_FIXTURE_VERSION,
  SCHEMA_SHA256,
  SeedSchema,
  type Admission,
  type Admitted,
  type Limits,
  type Outcome,
  type Progress,
  type Response,
} from "./protocol.generated.js";
import {
  WorkerFailure,
  WorkerSupervisor,
  type RunResult,
  type WorkerReceipt,
  type WorkerSession,
} from "./supervisor.js";
import { deriveTrialSeed } from "./trialSeed.js";

interface BodyValue {
  readonly stage: "admit" | "run";
  readonly admission: Admitted | null;
  readonly outcome: Outcome;
}

/** The qualification implementation the worker must present for the fixture profile. */
export const PREVIEW_IMPLEMENTATION_VERSION = "core-support-v1";
/** The only decision clients the worker names for the fixture; nothing else is accepted. */
export const PREVIEW_POLICY_IDS = ["fixture-baseline", "fixture-pass"] as const;
export type PreviewPolicyId = (typeof PREVIEW_POLICY_IDS)[number];
const PREVIEW_POLICY_VERSION = "1";
const PREVIEW_OBSERVATION_VERSION = "1";
/** Declared for the worker; memory enforcement is engine-mvp-supervision's. */
const PREVIEW_MAX_MEMORY_BYTES = 256 * 1024 * 1024;
const MAX_TRIALS = 8;
/** Ceiling on the worker's own elapsed budget a caller may request. */
export const PREVIEW_MAX_ELAPSED_MS_CEILING = 30_000;
/** Parent slack beyond the worker budget before the supervisor kills the process. */
export const PREVIEW_PARENT_GRACE_MS = 5_000;
/** Grace between a cooperative cancel (or SIGTERM) and SIGKILL. */
export const PREVIEW_KILL_GRACE_MS = 1_000;
/** The numeric maximum duration of one request, declared to clients. */
export const PREVIEW_MAX_DURATION_MS =
  PREVIEW_MAX_ELAPSED_MS_CEILING + PREVIEW_PARENT_GRACE_MS + PREVIEW_KILL_GRACE_MS;
/** Progress events retained in a report; the total is always counted. */
const MAX_TRACE_EVENTS = 64;
/** Room for hello, admitted and outcome frames beyond the worker's event budget. */
const OUTPUT_SLACK_BYTES = 64 * 1024;

const PolicyIdSchema = z.enum(PREVIEW_POLICY_IDS);

/** Raw shape shared with the MCP tool's inputSchema; every field is bounded. */
export const PREVIEW_RUN_INPUT_SHAPE = {
  fixture_id: z.literal(PREVIEW_FIXTURE_ID),
  seed: SeedSchema,
  trial_index: CountSchema.max(MAX_TRIALS - 1).default(0),
  trials: PositiveSchema.max(MAX_TRIALS).default(1),
  policies: z.tuple([PolicyIdSchema, PolicyIdSchema]).default(["fixture-baseline", "fixture-pass"]),
  max_turns: z.number().int().min(1).max(50).default(10),
  max_actions: z.number().int().min(1).max(10_000).default(1_000),
  max_actions_per_turn: z.number().int().min(1).max(1_000).default(100),
  max_work: z.number().int().min(1).max(1_000_000).default(100_000),
  max_elapsed_ms: z.number().int().min(100).max(PREVIEW_MAX_ELAPSED_MS_CEILING).default(5_000),
  max_output_bytes: z.number().int().min(4_096).max(1_000_000).default(262_144),
};
export const PreviewRunInputSchema = z.strictObject(PREVIEW_RUN_INPUT_SHAPE);
export type PreviewRunInput = z.infer<typeof PreviewRunInputSchema>;

export type PreviewRunErrorCode = "invalid_input" | "worker_failure";

export class PreviewRunError extends Error {
  override readonly name = "PreviewRunError";
  constructor(
    readonly code: PreviewRunErrorCode,
    message: string,
    readonly reason: string,
    readonly receipt?: WorkerReceipt,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface PreviewRunReport {
  readonly fixture: { readonly id: string; readonly version: number; readonly digest: string };
  readonly engine: {
    readonly protocol_version: number;
    readonly engine_version: string;
    readonly schema_sha256: string;
    readonly implementation_version: string;
  };
  /** The immutable inputs exactly as captured, plus the derived trial seed. */
  readonly input: PreviewRunInput & { readonly trial_seed: string };
  readonly limits: Limits;
  readonly catalog_digest: string;
  /** Null when admission was refused before any run. */
  readonly admission: Admitted | null;
  /** `admit` when the worker refused admission; otherwise the run's outcome. */
  readonly stage: "admit" | "run";
  readonly status: Outcome["type"];
  readonly outcome: Outcome;
  readonly events: readonly Progress[];
  readonly events_total: number;
  readonly supervision: WorkerReceipt;
}

export interface PreviewRunOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: Progress, sequence: number) => void;
}

export interface PreviewFixtureServiceOptions {
  /** Absolute path of the pinned worker executable. */
  readonly executable: string;
  /**
   * Fixed argument array; defaults to the worker's `--protocol` mode. Tests
   * substitute a protocol-shaped fake here; requests never influence it.
   */
  readonly args?: readonly string[];
  readonly maxConcurrent?: number;
}

/** What the service will run, for tool descriptions and diagnostics. */
export interface PreviewFixtureDescription {
  readonly executable: string;
  readonly fixture_id: string;
  readonly fixture_version: number;
  readonly fixture_digest: string;
  readonly protocol_version: number;
  readonly engine_version: string;
  readonly policies: readonly PreviewPolicyId[];
  readonly max_duration_ms: number;
}

type Captured = Awaited<ReturnType<typeof capturePreviewFixture>>;

export class PreviewFixtureService {
  readonly executable: string;
  private readonly supervisor: WorkerSupervisor;
  private captured: Promise<Captured> | null = null;
  private readonly listeners: Array<(receipt: WorkerReceipt) => void> = [];

  constructor(options: PreviewFixtureServiceOptions) {
    this.executable = options.executable;
    this.supervisor = new WorkerSupervisor({
      executable: options.executable,
      args: options.args ?? ["--protocol"],
      maxConcurrent: options.maxConcurrent ?? 2,
      killGraceMs: PREVIEW_KILL_GRACE_MS,
    });
  }

  describe(): PreviewFixtureDescription {
    return {
      executable: this.executable,
      fixture_id: PREVIEW_FIXTURE_ID,
      fixture_version: PREVIEW_FIXTURE_VERSION,
      fixture_digest: PREVIEW_FIXTURE_DIGEST,
      protocol_version: PROTOCOL_VERSION,
      engine_version: ENGINE_VERSION,
      policies: PREVIEW_POLICY_IDS,
      max_duration_ms: PREVIEW_MAX_DURATION_MS,
    };
  }

  /** Workers currently alive for this service. */
  active(): number {
    return this.supervisor.active();
  }

  /** Observe every worker receipt, including failures (used by acceptance tests). */
  onReceipt(listener: (receipt: WorkerReceipt) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  private capture(): Promise<Captured> {
    this.captured ??= capturePreviewFixture().catch((error: unknown) => {
      this.captured = null;
      throw error;
    });
    return this.captured;
  }

  /** Build the immutable admission for validated inputs. */
  private async admission(
    input: PreviewRunInput,
  ): Promise<{ admission: Admission; captured: Captured }> {
    const captured = await this.capture();
    const limits: Limits = {
      trials: input.trials,
      concurrency: 1,
      max_turns: input.max_turns,
      max_actions: input.max_actions,
      max_actions_per_turn: input.max_actions_per_turn,
      max_work: input.max_work,
      max_elapsed_ms: input.max_elapsed_ms,
      max_memory_bytes: PREVIEW_MAX_MEMORY_BYTES,
      max_output_bytes: input.max_output_bytes,
    };
    const admission = AdmissionSchema.parse({
      scenario: {
        type: "preview_fixture",
        data: {
          scenario_id: "preview-mcp",
          engine_version: ENGINE_VERSION,
          snapshot_digest: captured.catalog.data.payload_digest,
          rules_digest: captured.rules_digest,
          fixture_id: PREVIEW_FIXTURE_ID,
          fixture_version: PREVIEW_FIXTURE_VERSION,
          fixture_digest: PREVIEW_FIXTURE_DIGEST,
          seats: input.policies.map((id, seat) => ({
            seat,
            deck_digest: PREVIEW_FIXTURE_DIGEST,
            policy: {
              id,
              version: PREVIEW_POLICY_VERSION,
              observation_version: PREVIEW_OBSERVATION_VERSION,
              search_nodes: 1,
            },
          })),
          seed: input.seed,
          limits,
        },
      },
      catalog: captured.catalog,
      expected_implementation_version: PREVIEW_IMPLEMENTATION_VERSION,
      expected_implementation_digest: null,
    });
    return { admission: deepFreeze(admission), captured };
  }

  /** Run exactly one worker trial for validated inputs. */
  async run(rawInput: unknown, options: PreviewRunOptions = {}): Promise<PreviewRunReport> {
    const parsed = PreviewRunInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new PreviewRunError("invalid_input", parsed.error.message, "schema");
    const input = parsed.data;
    if (input.trial_index >= input.trials)
      throw new PreviewRunError(
        "invalid_input",
        `trial_index ${input.trial_index} must be below trials ${input.trials}`,
        "trial_index",
      );
    const { admission } = await this.admission(input);
    const limits = admission.scenario.data.limits;
    const trialSeed = deriveTrialSeed(input.seed, input.trial_index);
    const frozenInput = Object.freeze({ ...input, trial_seed: trialSeed });
    const events: Progress[] = [];
    let eventsTotal = 0;
    const body = async (session: WorkerSession): Promise<BodyValue> => {
      assertCompatibleHello(
        await session.exchange("hello", {
          type: "hello",
          data: {
            protocol_version: PROTOCOL_VERSION,
            engine_version: ENGINE_VERSION,
            schema_sha256: SCHEMA_SHA256,
          },
        }),
        "hello",
      );
      const admitted = await session.exchange("admit", { type: "admit", data: admission });
      if (admitted.message.type !== "admitted") {
        if (admitted.message.type !== "outcome")
          throw new WorkerFailure("protocol", `unexpected ${admitted.message.type} for admit`);
        return { stage: "admit", admission: null, outcome: admitted.message.data };
      }
      const record = admitted.message.data;
      const outcome = await session.stream(
        "run",
        {
          type: "run",
          data: {
            admission_id: record.admission_id,
            scenario_digest: record.scenario_digest,
            trial_index: input.trial_index,
            seed: trialSeed,
          },
        },
        (reply: Response) => {
          if (reply.message.type === "outcome") return true;
          if (reply.message.type !== "event")
            throw new Error(`unexpected ${reply.message.type} during run`);
          const event = reply.message.data;
          if (event.data.type !== "progress")
            throw new Error(`unrelayable ${event.data.type} event during run`);
          eventsTotal += 1;
          if (events.length < MAX_TRACE_EVENTS) events.push(event.data.data);
          options.onProgress?.(event.data.data, event.sequence);
          return false;
        },
      );
      if (outcome.message.type !== "outcome")
        throw new WorkerFailure("protocol", `unexpected ${outcome.message.type} for run`);
      return { stage: "run", admission: record, outcome: outcome.message.data };
    };
    let result: RunResult<BodyValue>;
    try {
      result = await this.supervisor.run(body, {
        signal: options.signal,
        maxElapsedMs: input.max_elapsed_ms + PREVIEW_PARENT_GRACE_MS,
        maxOutputBytes: input.max_output_bytes + OUTPUT_SLACK_BYTES,
      });
    } catch (error) {
      if (error instanceof WorkerFailure) {
        if (error.receipt) this.notify(error.receipt);
        throw new PreviewRunError("worker_failure", error.message, error.reason, error.receipt);
      }
      throw error;
    }
    this.notify(result.receipt);
    const { value } = result;
    return Object.freeze({
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
      input: frozenInput,
      limits,
      catalog_digest: admission.catalog.data.payload_digest,
      admission: value.admission,
      stage: value.stage,
      status: value.outcome.type,
      outcome: value.outcome,
      events: Object.freeze([...events]),
      events_total: eventsTotal,
      supervision: result.receipt,
    });
  }

  private notify(receipt: WorkerReceipt): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(receipt);
      } catch {
        // Observers never affect a run.
      }
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
