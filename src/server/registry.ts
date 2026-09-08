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
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
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
    /**
     * zod raw shape; the SDK advertises it over tools/list and safeParse-validates
     * structuredContent on success results (isError results are skipped — verified
     * in SDK 1.29 validateToolOutput). Keep fields optional so response variants
     * (conflicts, degraded paths) and the registry's data_snapshot stamp never fail.
     */
    outputSchema?: ZodRawShape;
    /** MCP tool annotations (readOnlyHint etc.) — harness-facing behavior hints. */
    annotations?: ToolAnnotations;
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

/** The SDK's registerTool callback type, at the registration boundary. */
type SdkToolCallback = Parameters<McpServer["registerTool"]>[2];

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
