import { describe, expect, it } from "vitest";
import { recordToolCall, summarizeCalls, type WorkflowCall } from "./workflowMetrics.js";

const result = (body: Record<string, unknown>, isError = false) => ({
  isError,
  structuredContent: body,
  content: [{ type: "text", text: JSON.stringify(body) }],
});

describe("workflow measurement", () => {
  it("counts UTF-8 bytes and distinguishes invalid inputs from upstream failures", () => {
    const calls: WorkflowCall[] = [
      {
        name: "card_get",
        arguments: {},
        result: result({ name: "Æther" }),
        elapsed_ms: 1,
        expected_error: false,
      },
      {
        name: "card_resolve_name",
        arguments: {},
        result: result({ code: "AMBIGUOUS_NAME" }, true),
        elapsed_ms: 2,
        expected_error: true,
      },
      {
        name: "meta_recommend",
        arguments: {},
        result: result({ code: "UPSTREAM_UNAVAILABLE" }, true),
        elapsed_ms: 3,
        expected_error: true,
      },
    ];
    const metrics = summarizeCalls(calls);
    expect(metrics).toMatchObject({
      tool_calls: 3,
      invalid_calls: 1,
      tool_errors: 2,
      rpc_errors: 0,
      expected_errors: 2,
      elapsed_ms: 6,
    });
    expect(metrics.response_bytes).toBe(
      calls.reduce((sum, call) => sum + Buffer.byteLength(JSON.stringify(call.result), "utf8"), 0),
    );
    expect(metrics.response_bytes).toBeGreaterThan(
      calls.reduce((sum, call) => sum + JSON.stringify(call.result).length, 0),
    );
  });

  it("counts partial rejected batches as invalid without marking whole-tool errors", () => {
    const calls: WorkflowCall[] = [
      {
        name: "deck_add",
        arguments: {},
        expected_error: false,
        elapsed_ms: 0,
        result: result({ failed: [{ reason: "UNKNOWN_CARD" }] }),
      },
    ];
    expect(summarizeCalls(calls)).toMatchObject({
      invalid_calls: 1,
      tool_errors: 0,
      partial_failure_calls: 1,
    });
  });

  it.each([
    ["card_get", { cards: [], missing: ["Not a card"] }, 1],
    ["collection_add", { unresolved: ["Not a card"] }, 1],
    ["deck_import", { unresolved: [{ name: "Not a card" }] }, 1],
    ["meta_recommend", { suggestions: [], unresolved: [{ name: "Upstream stale card" }] }, 0],
    ["meta_budget_swaps", { unresolved: [{ name: "Upstream stale card" }] }, 0],
  ])(
    "classifies %s input failures without blaming callers for upstream output",
    (name, body, invalid) => {
      const calls: WorkflowCall[] = [
        {
          name,
          arguments: {},
          expected_error: false,
          elapsed_ms: 0,
          result: result(body),
        },
      ];
      expect(summarizeCalls(calls)).toMatchObject({
        invalid_calls: invalid,
        partial_failure_calls: invalid,
        tool_errors: 0,
      });
    },
  );

  it("records successful calls and retains unexpected tool errors before rejecting", async () => {
    const calls: WorkflowCall[] = [];
    const ok = result({ name: "Sol Ring" });
    await expect(
      recordToolCall({ callTool: async () => ok }, calls, "card_get", {
        cards: "Sol Ring",
      }),
    ).resolves.toEqual({ name: "Sol Ring" });
    expect(calls[0]).toMatchObject({
      name: "card_get",
      arguments: { cards: "Sol Ring" },
      result: ok,
      expected_error: false,
    });
    const failure = result({ code: "UNKNOWN_CARD" }, true);
    await expect(
      recordToolCall({ callTool: async () => failure }, calls, "card_get", {}),
    ).rejects.toThrow("Unexpected tool error");
    expect(calls[1]?.result).toEqual(failure);
  });

  it("retains rejected RPC calls before propagating the error", async () => {
    const calls: WorkflowCall[] = [];
    await expect(
      recordToolCall(
        {
          callTool: async () => {
            throw new Error("RPC disconnected");
          },
        },
        calls,
        "card_get",
        {},
      ),
    ).rejects.toThrow("RPC disconnected");
    expect(calls[0]).toMatchObject({
      result: null,
      rpc_error: "RPC disconnected",
    });
    expect(summarizeCalls(calls)).toMatchObject({
      tool_calls: 1,
      rpc_errors: 1,
      tool_errors: 0,
      invalid_calls: 0,
    });
  });

  it("fails when an expected recovery error unexpectedly succeeds", async () => {
    await expect(
      recordToolCall({ callTool: async () => result({}) }, [], "card_resolve_name", {}, true),
    ).rejects.toThrow("Expected tool error");
  });
});
