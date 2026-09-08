/** Test/evaluation tooling only; never registered as an MCP tool. */
import { performance } from "node:perf_hooks";

export interface WorkflowCall {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
  elapsed_ms: number;
  expected_error: boolean;
  rpc_error?: string;
  rpc_error_code?: number;
}

interface ToolCaller {
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Retain the observed result before checking success, including rejected RPCs. */
export async function recordToolCall(
  client: ToolCaller,
  calls: WorkflowCall[],
  name: string,
  args: Record<string, unknown>,
  expectedError = false,
): Promise<Record<string, unknown>> {
  const started = performance.now();
  let result: unknown;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (error) {
    calls.push({
      name,
      arguments: structuredClone(args),
      result: null,
      elapsed_ms: performance.now() - started,
      expected_error: expectedError,
      rpc_error: error instanceof Error ? error.message : String(error),
      ...(typeof record(error).code === "number"
        ? { rpc_error_code: Number(record(error).code) }
        : {}),
    });
    throw error;
  }
  calls.push({
    name,
    arguments: structuredClone(args),
    result: structuredClone(result),
    elapsed_ms: performance.now() - started,
    expected_error: expectedError,
  });
  const response = record(result);
  if (response.isError === true && !expectedError) {
    throw new Error(`Unexpected tool error from ${name}: ${JSON.stringify(result)}`);
  }
  if (response.isError !== true && expectedError) {
    throw new Error(`Expected tool error from ${name}, received success`);
  }
  if (
    response.structuredContent === null ||
    typeof response.structuredContent !== "object" ||
    Array.isArray(response.structuredContent)
  ) {
    throw new Error(`Missing object structuredContent from ${name}`);
  }
  return record(response.structuredContent);
}

const INPUT_ERRORS = new Set([
  "UNKNOWN_CARD",
  "AMBIGUOUS_NAME",
  "INVALID_QUERY",
  "DECK_NOT_FOUND",
  "COLOR_IDENTITY_VIOLATION",
  "SINGLETON_VIOLATION",
  "BANNED_CARD",
  "INELIGIBLE_COMMANDER",
]);

/** Parsed SDK-result JSON bytes, not transport framing, model tokens or cost. */
export function summarizeCalls(calls: readonly WorkflowCall[]) {
  let invalid = 0;
  let partial = 0;
  let errors = 0;
  let rpcErrors = 0;
  let expected = 0;
  let bytes = 0;
  let elapsed = 0;
  for (const call of calls) {
    const response = record(call.result);
    const body = record(response.structuredContent);
    // "unresolved" in meta_* describes upstream output, not the caller's input.
    const inputFields =
      call.name === "card_get"
        ? [body.missing, body.failed]
        : call.name === "deck_import" ||
            call.name === "collection_set" ||
            call.name === "collection_add"
          ? [body.unresolved]
          : call.name === "deck_add" || call.name === "deck_remove"
            ? [body.failed]
            : [];
    const partialFailure =
      inputFields.some((value) => Array.isArray(value) && value.length > 0) ||
      (call.name === "deck_add" &&
        Array.isArray(body.verdicts) &&
        body.verdicts.some((value) => record(value).status === "rejected"));
    if (partialFailure) partial += 1;
    if (
      partialFailure ||
      INPUT_ERRORS.has(String(body.code)) ||
      call.rpc_error_code === -32601 ||
      call.rpc_error_code === -32602
    )
      invalid += 1;
    if (response.isError === true) errors += 1;
    if (call.rpc_error !== undefined) rpcErrors += 1;
    if (call.expected_error && (response.isError === true || call.rpc_error !== undefined))
      expected += 1;
    if (call.result !== null) bytes += Buffer.byteLength(JSON.stringify(call.result), "utf8");
    elapsed += call.elapsed_ms;
  }
  return {
    tool_calls: calls.length,
    invalid_calls: invalid,
    partial_failure_calls: partial,
    tool_errors: errors,
    rpc_errors: rpcErrors,
    expected_errors: expected,
    response_bytes: bytes,
    elapsed_ms: elapsed,
  };
}
