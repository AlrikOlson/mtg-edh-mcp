import { describe, it, expect } from "vitest";
import {
  ERROR_CODES,
  StructuredError,
  isStructuredError,
  toolError,
  type ErrorPayload,
} from "./errors.js";
import { ROLES } from "./card.js";

describe("error taxonomy", () => {
  it("declares the §8 codes plus actionable storage failures", () => {
    expect(ERROR_CODES).toHaveLength(11);
    expect(ERROR_CODES).toContain("STORAGE_ERROR");
    expect(ERROR_CODES).toContain("UNKNOWN_CARD");
    expect(ERROR_CODES).toContain("STALE_CARD");
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it("declares all nineteen §7 roles", () => {
    expect(ROLES).toHaveLength(19);
    expect(new Set(ROLES).size).toBe(ROLES.length);
  });
});

describe("StructuredError", () => {
  it("is an Error carrying a code, message, and details", () => {
    const err = new StructuredError("AMBIGUOUS_NAME", "matched 2 cards", {
      candidates: [{ oracle_id: "a", name: "Fire", mv: 2, ci: ["R"], type: "Instant" }],
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(StructuredError);
    expect(err.name).toBe("StructuredError");
    expect(err.code).toBe("AMBIGUOUS_NAME");
    expect(err.message).toBe("matched 2 cards");
    expect(err.details?.candidates).toHaveLength(1);
  });

  it("is recognized by the type guard", () => {
    expect(isStructuredError(new StructuredError("DECK_NOT_FOUND", "no such deck"))).toBe(true);
    expect(isStructuredError(new Error("plain"))).toBe(false);
    expect(isStructuredError(null)).toBe(false);
  });
});

describe("toolError", () => {
  it("produces an MCP isError result with the code in text and structuredContent", () => {
    const result = toolError("UNKNOWN_CARD", "oracle_id not in index");

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);

    const block = result.content[0];
    expect(block?.type).toBe("text");

    // The code is model-visible in the text block.
    const parsed = JSON.parse((block as { text: string }).text) as ErrorPayload;
    expect(parsed.code).toBe("UNKNOWN_CARD");
    expect(parsed.message).toBe("oracle_id not in index");
    expect(parsed).not.toHaveProperty("details");

    // ...and mirrored in structuredContent for programmatic clients.
    expect(result.structuredContent).toMatchObject({
      code: "UNKNOWN_CARD",
      message: "oracle_id not in index",
    });
  });

  it("includes structured details when present", () => {
    const result = toolError("INVALID_QUERY", "unexpected token", {
      position: 7,
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as ErrorPayload;
    expect(parsed.details).toEqual({ position: 7 });
    expect(result.structuredContent).toMatchObject({
      details: { position: 7 },
    });
  });

  it("accepts a StructuredError instance directly", () => {
    const err = new StructuredError("UPSTREAM_UNAVAILABLE", "EDHREC down");
    const result = toolError(err);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
  });
});
