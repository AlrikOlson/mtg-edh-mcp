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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
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
  };
  handler: ToolHandler;
}

/** The SDK's registerTool callback type, at the registration boundary. */
type SdkToolCallback = Parameters<McpServer["registerTool"]>[2];

/** Merge `data_snapshot` into a tool result's structuredContent and _meta. */
export function stampSnapshot(result: CallToolResult, snapshot: string): CallToolResult {
  return {
    ...result,
    structuredContent: { ...(result.structuredContent ?? {}), data_snapshot: snapshot },
    _meta: { ...(result._meta ?? {}), data_snapshot: snapshot },
  };
}

/** Register one tool, wrapping its handler with stamping + structured-error mapping. */
export function registerTool(
  server: McpServer,
  def: ToolDefinition,
  snapshot: SnapshotProvider,
): void {
  const wrapped: ToolHandler = async (args, extra) => {
    try {
      const result = await def.handler(args, extra);
      return stampSnapshot(result, snapshot());
    } catch (err) {
      if (isStructuredError(err)) {
        return stampSnapshot(toolError(err), snapshot());
      }
      throw err;
    }
  };
  // Boundary cast: the SDK infers a per-schema callback type from inputSchema;
  // our wrapper is intentionally schema-agnostic.
  server.registerTool(def.name, def.config, wrapped as unknown as SdkToolCallback);
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
