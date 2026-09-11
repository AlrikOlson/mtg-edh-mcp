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
import {
  PREVIEW_MAX_DURATION_MS,
  PREVIEW_PARENT_GRACE_MS,
  PREVIEW_RUN_INPUT_SHAPE,
  PreviewFixtureService,
  PreviewRunError,
  type PreviewRunReport,
} from "../engine/previewRun.js";
import { StructuredError } from "../types/errors.js";
import { mutates } from "./registry.js";
import type { ToolDefinition } from "./registry.js";

export const ENGINE_PREVIEW_TOOL = "engine_preview_fixture";
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
          "ARGS: fixture_id (fixed), seed (16 hex), trial_index/trials (<= 8), policies pair, max_turns (10), max_actions, max_actions_per_turn, max_work, max_elapsed_ms (5000), max_output_bytes.\n" +
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
