/**
 * Tool-registration framework (spec §2/§3/§8).
 *
 * Every tool registers through {@link registerTools}, which wraps each handler so
 * that, uniformly and for free:
 *   - the response is stamped with `data_snapshot` (§3/§11) in both
 *     `structuredContent` and `_meta`;
 *   - a thrown {@link StructuredError} becomes an MCP `isError` result carrying
 *     the §8 code (via {@link toolError}), rather than an opaque protocol error.
 * Unexpected (non-structured) throws propagate to the SDK's generic isError path.
 */
import type {
  McpServer,
  RegisteredTool,
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z, type ZodRawShape } from "zod";
import { isStructuredError, toolError } from "../types/errors.js";
import type { SnapshotProvider } from "./snapshot.js";

/** A tool handler: receives validated args and returns an MCP tool result. */
export type ToolHandler = (
  args: Record<string, unknown>,
  extra: unknown,
) => CallToolResult | Promise<CallToolResult>;

/** Declarative tool definition registered against the server. */
export interface ToolDefinition {
  /** `namespace_action`, lowercase, underscore-delimited (§2). */
  name: string;
  config: {
    title?: string;
    description?: string;
    /** zod raw shape; the SDK validates input against it before the handler runs. */
    inputSchema?: ZodRawShape;
    /**
     * zod raw shape; the SDK advertises it over tools/list and safeParse-validates
     * structuredContent on success results (isError results are skipped — verified
     * by the SDK). Keep fields optional so response variants
     * (conflicts, degraded paths) and the registry's data_snapshot stamp never fail.
     */
    outputSchema?: ZodRawShape;
    /** MCP tool annotations (readOnlyHint etc.) — harness-facing behavior hints. */
    annotations?: ToolAnnotations;
    /**
     * Reject unknown argument keys instead of stripping them (the default keeps
     * the lenient boundary every existing tool relies on). Set it where an extra
     * key would mean the caller expects behavior the tool never offers.
     */
    strictInput?: boolean;
  };
  handler: ToolHandler;
}

/** Annotation presets (ergo-protocol): local read-only, live read-only, local mutator. */
export const READS_LOCAL: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
};
export const READS_LIVE: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};
export function mutates(hints: {
  destructive: boolean;
  idempotent: boolean;
  openWorld?: boolean;
}): ToolAnnotations {
  return {
    readOnlyHint: false,
    destructiveHint: hints.destructive,
    idempotentHint: hints.idempotent,
    openWorldHint: hints.openWorld ?? false,
  };
}

/** Merge `data_snapshot` into a tool result's structuredContent and _meta. */
export function stampSnapshot(result: CallToolResult, snapshot: string): CallToolResult {
  const structuredContent = {
    ...(result.structuredContent ?? {}),
    data_snapshot: snapshot,
  };
  const serialized = JSON.stringify(structuredContent);
  // MCP recommends a text fallback so clients without structuredContent support
  // receive the actual cards/decks, rather than only a count or status summary.
  const content = result.content.some((block) => block.type === "text" && block.text === serialized)
    ? result.content
    : [...result.content, { type: "text" as const, text: serialized }];
  return {
    ...result,
    content,
    structuredContent,
    _meta: { ...(result._meta ?? {}), data_snapshot: snapshot },
  };
}

/**
 * Per-server request cancellation registry (MCP 2026-07-28 cancellation).
 *
 * The installed SDK (2.0.0) aborts a handler's `mcpReq.signal` on transport
 * close and on `notifications/cancelled`, but its notification handler drops
 * request id 0 (`if (!requestId) return`), which is the first request of every
 * modern stdio connection. Tool handlers therefore receive a signal combined
 * from the SDK's own and one this registry aborts itself on the notification,
 * for any id. Replacing the SDK handler is safe here because every tool goes
 * through this registry and no other request handler in this server consumes
 * an abort signal. Remove once the SDK honors id 0 (engineTools.test.ts pins
 * the first-request cancellation).
 */
const cancellations = new WeakMap<McpServer, Map<string | number, AbortController>>();

function cancellationMap(server: McpServer): Map<string | number, AbortController> {
  let map = cancellations.get(server);
  if (!map) {
    map = new Map();
    cancellations.set(server, map);
    server.server.setNotificationHandler("notifications/cancelled", (notification) => {
      const id = notification.params.requestId;
      if (id === undefined) return;
      const controller = cancellations.get(server)?.get(id);
      controller?.abort(notification.params.reason ?? "cancelled");
    });
  }
  return map;
}

interface RequestSlice {
  readonly id: string | number;
  readonly signal: AbortSignal;
}

function requestSlice(extra: unknown): RequestSlice | null {
  if (typeof extra !== "object" || extra === null || !("mcpReq" in extra)) return null;
  const req = (extra as { mcpReq: unknown }).mcpReq;
  if (typeof req !== "object" || req === null || !("id" in req) || !("signal" in req)) return null;
  const { id, signal } = req as { id: unknown; signal: unknown };
  if ((typeof id !== "string" && typeof id !== "number") || !(signal instanceof AbortSignal))
    return null;
  return { id, signal };
}

/** Register one tool, wrapping its handler with stamping + structured-error mapping. */
export function registerTool(
  server: McpServer,
  def: ToolDefinition,
  snapshot: SnapshotProvider,
): RegisteredTool {
  const live = cancellationMap(server);
  const wrapped: ToolHandler = (rawArgs, rawExtra) => {
    const invoke = async (): Promise<CallToolResult> => {
      const request = requestSlice(rawExtra);
      const controller = request ? new AbortController() : null;
      let extra = rawExtra;
      if (request && controller) {
        live.set(request.id, controller);
        const mcpReq = (rawExtra as { mcpReq: object }).mcpReq;
        extra = {
          ...(rawExtra as object),
          mcpReq: { ...mcpReq, signal: AbortSignal.any([request.signal, controller.signal]) },
        };
      }
      try {
        const result = await def.handler(rawArgs, extra);
        return stampSnapshot(result, snapshot());
      } catch (err) {
        if (isStructuredError(err)) {
          return stampSnapshot(toolError(err), snapshot());
        }
        throw err;
      } finally {
        if (request && live.get(request.id) === controller) live.delete(request.id);
      }
    };
    return snapshot.withRead ? snapshot.withRead(invoke) : invoke();
  };
  // Keep tool definitions data-first; adapt their raw shapes once at the SDK's
  // Standard Schema boundary. An empty schema still gives handlers an args object.
  const { strictInput, ...config } = def.config;
  const shape = config.inputSchema ?? {};
  return server.registerTool(
    def.name,
    {
      ...config,
      inputSchema: strictInput ? z.strictObject(shape) : z.object(shape),
      outputSchema: config.outputSchema ? z.object(config.outputSchema) : undefined,
    },
    wrapped,
  );
}

/** Register a batch of tools. */
export function registerTools(
  server: McpServer,
  defs: readonly ToolDefinition[],
  snapshot: SnapshotProvider,
): void {
  for (const def of defs) {
    registerTool(server, def, snapshot);
  }
}
