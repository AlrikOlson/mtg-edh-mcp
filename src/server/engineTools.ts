/**
 * Development-only engine preview tool (chunk engine-mvp-preview-mcp).
 *
 * `engine_preview_fixture` is the first MCP route into the canonical Rust
 * engine. It runs only the trusted internal Forest/Bears fixture through one
 * supervised native worker per request and returns the worker's own outcome. It
 * is registered solely when an operator injects a {@link PreviewFixtureService}
 * (`MTG_ENGINE_PREVIEW=1` with `MTG_WORKER_BINARY`), never by default, and it
 * does not change `simulate_deck` or any other public owner: those routes
 * switch to engine evidence at engine-mvp-cutover.
 *
 * Cancellation uses the ordinary MCP request context (2026-07-28): the SDK
 * aborts `ctx.mcpReq.signal` on a stdio `notifications/cancelled` and when a
 * Streamable HTTP client closes the response stream; the service turns that
 * into the worker's cooperative cancel followed by a parent-enforced kill.
 * Progress rides `notifications/progress` when the request carried a token;
 * the maximum duration is declared numerically regardless.
 */
import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { EngineJobError, EngineJobService, JOB_SUBMIT_INPUT_SHAPE } from "../engine/jobs.js";
import { EngineJobStore, isTerminalJobStatus, type JobRecord } from "../engine/jobStore.js";
import {
  PREVIEW_MAX_DURATION_MS,
  PREVIEW_PARENT_GRACE_MS,
  PREVIEW_RUN_INPUT_SHAPE,
  PreviewFixtureService,
  PreviewRunError,
  type PreviewRunReport,
} from "../engine/previewRun.js";
import { StructuredError } from "../types/errors.js";
import { mutates, READS_LOCAL } from "./registry.js";
import type { ToolDefinition } from "./registry.js";
import type { SnapshotProvider } from "./snapshot.js";

export const ENGINE_PREVIEW_TOOL = "engine_preview_fixture";
export const ENGINE_JOB_SUBMIT_TOOL = "engine_job_submit";
export const ENGINE_JOB_STATUS_TOOL = "engine_job_status";
export const ENGINE_JOB_CANCEL_TOOL = "engine_job_cancel";
export const ENGINE_JOB_TOOLS = [
  ENGINE_JOB_SUBMIT_TOOL,
  ENGINE_JOB_STATUS_TOOL,
  ENGINE_JOB_CANCEL_TOOL,
] as const;
export const ENGINE_PREVIEW_ENV = "MTG_ENGINE_PREVIEW";
export const WORKER_BINARY_ENV = "MTG_WORKER_BINARY";

/** The slice of the SDK's ServerContext this tool relies on, guarded at runtime. */
interface RequestContext {
  signal?: AbortSignal;
  progressToken?: string | number;
  notify?: (notification: { method: string; params: Record<string, unknown> }) => Promise<void>;
}

function requestContext(extra: unknown): RequestContext {
  if (typeof extra !== "object" || extra === null || !("mcpReq" in extra)) return {};
  const req = (extra as { mcpReq: unknown }).mcpReq;
  if (typeof req !== "object" || req === null) return {};
  const context: RequestContext = {};
  if ("signal" in req && req.signal instanceof AbortSignal) context.signal = req.signal;
  if ("_meta" in req && typeof req._meta === "object" && req._meta !== null) {
    const token = (req._meta as { progressToken?: unknown }).progressToken;
    if (typeof token === "string" || typeof token === "number") context.progressToken = token;
  }
  if ("notify" in req && typeof req.notify === "function")
    context.notify = req.notify as RequestContext["notify"];
  return context;
}

/**
 * Construct the shared service from the environment, or nothing when the
 * operator has not opted in. An opt-in with a missing or relative executable is
 * a configuration error reported at boot, not a silent no-op.
 */
export function enginePreviewFromEnv(
  env: Record<string, string | undefined>,
): PreviewFixtureService | undefined {
  if (env[ENGINE_PREVIEW_ENV] !== "1") return undefined;
  const executable = env[WORKER_BINARY_ENV]?.trim() ?? "";
  if (!isAbsolute(executable))
    throw new Error(`${WORKER_BINARY_ENV} must be an absolute path when ${ENGINE_PREVIEW_ENV}=1`);
  try {
    accessSync(executable, constants.X_OK);
  } catch {
    throw new Error(`${WORKER_BINARY_ENV} is not an executable file: ${executable}`);
  }
  return new PreviewFixtureService({ executable });
}

/**
 * The durable job service for an enabled preview: its own store in the data
 * root, wrapping the same preview service (and therefore the same supervisor
 * and concurrency ceiling) the request-scoped tool uses.
 */
export function engineJobsFor(runner: PreviewFixtureService, dataRoot: string): EngineJobService {
  return new EngineJobService({ runner, store: new EngineJobStore(dataRoot) });
}

function present(report: PreviewRunReport): Record<string, unknown> {
  return {
    tool_status: report.status,
    stage: report.stage,
    outcome: report.outcome,
    fixture: report.fixture,
    engine: report.engine,
    input: report.input,
    limits: report.limits,
    catalog_digest: report.catalog_digest,
    admission: report.admission,
    events: report.events,
    events_total: report.events_total,
    decisions: report.decisions,
    decisions_total: report.decisions_total,
    supervision: report.supervision,
    max_duration_ms: PREVIEW_MAX_DURATION_MS,
  };
}

export function makeEnginePreviewTools(service: PreviewFixtureService): ToolDefinition[] {
  const described = service.describe();
  return [
    {
      name: ENGINE_PREVIEW_TOOL,
      config: {
        annotations: mutates({ destructive: false, idempotent: true }),
        title: "Run the internal engine fixture",
        description:
          "Run one bounded trial of the internal Forest/Bears fixture in the native Rust engine worker.\n" +
          `USE: development proof that the MCP-to-engine path admits, runs, caps and cancels (fixture ${described.fixture_id} v${described.fixture_version}, policies ${described.policies.join("/")}). NOT: deck evaluation, Muldrotha or any authored deck (simulate_deck stays the public owner).\n` +
          "FLOW: ping -> engine_preview_fixture -> (inspect outcome, digests and supervision).\n" +
          "ARGS: fixture_id (fixed), seed (16 hex), trial_index/trials (<= 8), policies (one per seat, 2-4 seats in turn order), max_turns (10), max_actions, max_actions_per_turn, max_work, max_elapsed_ms (5000), max_output_bytes.\n" +
          `RETURNS: tool_status (completed|truncated|cancelled|unsupported|invalid|engine_error), stage, outcome, fixture, engine, input (with trial_seed), limits, catalog_digest, admission, events (bounded progress), supervision receipt. MAX DURATION: ${PREVIEW_MAX_DURATION_MS} ms; the parent kills the worker ${PREVIEW_PARENT_GRACE_MS} ms after max_elapsed_ms even while progress is emitted.`,
        inputSchema: PREVIEW_RUN_INPUT_SHAPE,
        // An unknown key (a deck id, a profile, a path) is a request for something
        // this route will never do; refuse it rather than run the fixture anyway.
        strictInput: true,
      },
      handler: async (args, extra) => {
        const context = requestContext(extra);
        const maxTurns = z.number().int().optional().parse(args.max_turns) ?? 10;
        let report: PreviewRunReport;
        try {
          report = await service.run(args, {
            signal: context.signal,
            onProgress:
              context.progressToken !== undefined && context.notify
                ? (progress) => {
                    void context
                      .notify?.({
                        method: "notifications/progress",
                        params: {
                          progressToken: context.progressToken,
                          progress: progress.turns,
                          total: maxTurns,
                          message: `turn ${progress.turns}, ${progress.actions} actions`,
                        },
                      })
                      .catch(() => {
                        // A lost progress notification never affects the run.
                      });
                  }
                : undefined,
          });
        } catch (error) {
          if (error instanceof PreviewRunError) {
            if (error.code === "invalid_input") {
              const payload = { code: "ENGINE_PREVIEW_INPUT", message: error.message };
              return {
                isError: true,
                content: [{ type: "text", text: JSON.stringify(payload) }],
                structuredContent: payload,
              };
            }
            throw new StructuredError(
              "UPSTREAM_UNAVAILABLE",
              `native engine worker ${error.reason}: ${error.message}`,
              { reason: error.reason },
            );
          }
          throw error;
        }
        const structured = present(report);
        return {
          content: [
            {
              type: "text",
              text: `engine_preview_fixture: ${report.status} at stage ${report.stage} after ${report.events_total} turn(s)`,
            },
          ],
          structuredContent: structured,
        };
      },
    },
  ];
}

/** The job as clients see it: the principal is implied by the caller, never echoed. */
function presentJob(record: JobRecord): Record<string, unknown> {
  return {
    job_id: record.job_id,
    status: record.status,
    terminal: isTerminalJobStatus(record.status),
    created_at: record.created_at,
    started_at: record.started_at,
    finished_at: record.finished_at,
    cancel_requested_at: record.cancel_requested_at,
    progress: record.progress,
    input: record.input,
    fixture: record.fixture,
    engine: record.engine,
    data_snapshot: record.data_snapshot,
    idempotency_key: record.idempotency_key,
    report: record.report ? present(record.report) : null,
    failure: record.failure,
    persistence_error: record.persistence_error,
  };
}

function jobError(code: string, message: string, details: Record<string, unknown> = {}) {
  const payload = { code, message, ...details };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

const JOB_ID_SHAPE = { job_id: z.uuid() };

/**
 * Durable, principal-scoped fixture jobs over the shared {@link EngineJobService}.
 * A submit returns as soon as the record is on disk; the run outlives the
 * request, its transport and the server instance that accepted it. Cancelling
 * is explicit through `engine_job_cancel`: a closed request stream or a
 * `notifications/cancelled` for the submit request never cancels a job. The
 * installed SDK serves no Tasks extension, so this bounded submit/status/cancel
 * workflow is what every host uses.
 */
export function makeEngineJobTools(
  service: EngineJobService,
  session: string,
  snapshot: SnapshotProvider,
): ToolDefinition[] {
  const capacity = service.capacity();
  const workflow =
    "FLOW: engine_job_submit -> engine_job_status (poll until terminal) -> inspect report | engine_job_cancel.";
  return [
    {
      name: ENGINE_JOB_SUBMIT_TOOL,
      config: {
        annotations: mutates({ destructive: false, idempotent: false }),
        title: "Submit an engine fixture job",
        description:
          "Submit one bounded trial of the internal Forest/Bears fixture as a durable background job in the native Rust engine worker.\n" +
          "USE: development proof of the detached job path; the job is persisted before this returns and keeps running after this request, its connection or the server instance ends. NOT: deck evaluation or any authored deck (simulate_deck stays the public owner).\n" +
          `${workflow}\n` +
          "ARGS: the engine_preview_fixture arguments (fixture_id, seed, trial_index/trials, policies, max_turns, max_actions, max_actions_per_turn, max_work, max_elapsed_ms, max_output_bytes) plus optional idempotency_key (same key under the same caller returns the same job).\n" +
          `RETURNS: job_id, status (queued|running), created, queue_position, capacity. QUEUE: at most ${capacity.max_running} running, ${capacity.max_queued} waiting (${capacity.max_queued_per_principal} per caller); beyond that ENGINE_JOB_QUEUE_FULL. MAX DURATION of one job's run: ${PREVIEW_MAX_DURATION_MS} ms after it starts.`,
        inputSchema: JOB_SUBMIT_INPUT_SHAPE,
        strictInput: true,
      },
      handler: async (args) => {
        // The request signal is deliberately ignored: a job outlives its request.
        try {
          const result = service.submit(session, args, { dataSnapshot: snapshot() });
          const structured = {
            job_id: result.record.job_id,
            status: result.record.status,
            created: result.created,
            queue_position: result.queue_position,
            created_at: result.record.created_at,
            capacity: service.capacity(),
            max_duration_ms: PREVIEW_MAX_DURATION_MS,
          };
          return {
            content: [
              {
                type: "text",
                text: `engine_job_submit: job ${result.record.job_id} ${result.created ? "created" : "already exists"} (${result.record.status})`,
              },
            ],
            structuredContent: structured,
          };
        } catch (error) {
          if (error instanceof EngineJobError)
            return jobError(
              error.code === "queue_full" ? "ENGINE_JOB_QUEUE_FULL" : "ENGINE_JOB_INPUT",
              error.message,
              { reason: error.reason },
            );
          throw error;
        }
      },
    },
    {
      name: ENGINE_JOB_STATUS_TOOL,
      config: {
        annotations: READS_LOCAL,
        title: "Read an engine job",
        description:
          "Read the state of one engine fixture job submitted by this caller.\n" +
          `${workflow}\n` +
          "ARGS: job_id.\n" +
          "RETURNS: status (queued|running|completed|truncated|cancelled|unsupported|invalid|engine_error|failed), terminal, timestamps, progress while running, the immutable input, and when terminal the worker's own report (outcome, events, decisions, supervision receipt) or the failure (code, reason, receipt). Another caller's job is ENGINE_JOB_NOT_FOUND.",
        inputSchema: JOB_ID_SHAPE,
        strictInput: true,
      },
      handler: async (args) => {
        const jobId = z.uuid().parse(args.job_id);
        const record = service.get(session, jobId);
        if (!record) return jobError("ENGINE_JOB_NOT_FOUND", `no job ${jobId} for this caller`);
        return {
          content: [{ type: "text", text: `engine_job_status: ${record.job_id} ${record.status}` }],
          structuredContent: presentJob(record),
        };
      },
    },
    {
      name: ENGINE_JOB_CANCEL_TOOL,
      config: {
        annotations: mutates({ destructive: false, idempotent: true }),
        title: "Cancel an engine job",
        description:
          "Cancel one engine fixture job submitted by this caller.\n" +
          `${workflow}\n` +
          "ARGS: job_id.\n" +
          "RETURNS: outcome cancelled_before_start (a waiting job, terminal now), acknowledged (a running job: the worker is asked to stop and is killed if it does not; poll engine_job_status for the terminal state) or already_terminal, plus the job.",
        inputSchema: JOB_ID_SHAPE,
        strictInput: true,
      },
      handler: async (args) => {
        const jobId = z.uuid().parse(args.job_id);
        const result = service.cancel(session, jobId);
        if (!result) return jobError("ENGINE_JOB_NOT_FOUND", `no job ${jobId} for this caller`);
        return {
          content: [{ type: "text", text: `engine_job_cancel: ${jobId} ${result.outcome}` }],
          structuredContent: { outcome: result.outcome, ...presentJob(result.record) },
        };
      },
    },
  ];
}
