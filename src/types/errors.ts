/**
 * Error taxonomy (spec §8).
 *
 * All tool errors are reported *in the result object* with MCP `isError: true`
 * (not as protocol-level errors), so the agent can see and branch on a
 * structured `code` without parsing prose. Per the MCP 2025-06-18 spec the code
 * is emitted in BOTH `content[].text` (always model-visible) and
 * `structuredContent` (for programmatic clients that may keep it hidden from the
 * model).
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CardRef } from "./card.js";

/** The structured error codes (§8), in spec order. */
export const ERROR_CODES = [
  "UNKNOWN_CARD",
  "AMBIGUOUS_NAME",
  "INVALID_QUERY",
  "COLOR_IDENTITY_VIOLATION",
  "SINGLETON_VIOLATION",
  "BANNED_CARD",
  "INELIGIBLE_COMMANDER",
  "DECK_NOT_FOUND",
  "UPSTREAM_UNAVAILABLE",
  "STALE_CARD",
] as const;

/** A structured error code from the §8 taxonomy. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Typed detail payloads keyed by code. A code absent from this map carries no
 * structured details. These mirror the "agent recovery" column of §8 (e.g.
 * AMBIGUOUS_NAME returns the candidate cards to pick from).
 */
export interface ErrorDetailMap {
  AMBIGUOUS_NAME: { candidates: readonly CardRef[] };
  INVALID_QUERY: { position?: number };
  STALE_CARD: { requested?: string; snapshot?: string };
  UPSTREAM_UNAVAILABLE: { url?: string; status?: number; reason?: string };
}

/** Details type for a given code, or undefined when the code has none. */
export type ErrorDetails<C extends ErrorCode> = C extends keyof ErrorDetailMap
  ? ErrorDetailMap[C]
  : undefined;

/** The JSON payload embedded in both content text and structuredContent. */
export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * An error carrying a §8 code (and optional structured details). Throw it from
 * tool handlers; convert to an MCP result with {@link toolError}.
 */
export class StructuredError<C extends ErrorCode = ErrorCode> extends Error {
  override readonly name = "StructuredError";
  readonly code: C;
  readonly details?: ErrorDetails<C>;

  constructor(code: C, message: string, details?: ErrorDetails<C>) {
    super(message);
    this.code = code;
    this.details = details;
    // Preserve `instanceof` across the ES target's transpiled Error subclass.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Type guard for {@link StructuredError}. */
export function isStructuredError(value: unknown): value is StructuredError {
  return value instanceof StructuredError;
}

function payloadOf(error: StructuredError): ErrorPayload {
  return {
    code: error.code,
    message: error.message,
    ...(error.details !== undefined ? { details: error.details as Record<string, unknown> } : {}),
  };
}

/**
 * Build an MCP `isError` result from a §8 error. The code lives in both the text
 * content block (model-visible) and `structuredContent` (programmatic clients).
 */
export function toolError(error: StructuredError): CallToolResult;
export function toolError<C extends ErrorCode>(
  code: C,
  message: string,
  details?: ErrorDetails<C>,
): CallToolResult;
export function toolError(
  codeOrError: ErrorCode | StructuredError,
  message?: string,
  details?: ErrorDetails<ErrorCode>,
): CallToolResult {
  const error = isStructuredError(codeOrError)
    ? codeOrError
    : new StructuredError(codeOrError, message ?? "", details);
  const payload = payloadOf(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}
