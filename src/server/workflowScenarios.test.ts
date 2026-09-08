import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runWorkflowScenarios, type WorkflowRun } from "./workflowScenarios.js";

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

function structured(run: WorkflowRun, name: string): Record<string, unknown>[] {
  return run.calls
    .filter((call) => call.name === name)
    .map((call) => object(object(call.result).structuredContent));
}

describe("deterministic protocol workflow scenarios", () => {
  let runs: WorkflowRun[];
  const network = vi.fn(() => {
    throw new Error("Workflow attempted external network access");
  });

  beforeAll(async () => {
    vi.stubGlobal("fetch", network);
    runs = await runWorkflowScenarios();
  });
  afterAll(() => vi.unstubAllGlobals());

  function workflow(id: string): WorkflowRun {
    const run = runs.find((candidate) => candidate.id === id);
    assert(run, `Missing workflow ${id}`);
    return run;
  }

  it("builds a legal hundred-card deck while counting commander cost and using owned cards", () => {
    const run = workflow("budget-build");
    expect(structured(run, "validate_deck")[0]).toMatchObject({ ok: true, errors: [] });
    const budget = structured(run, "budget_plan")[0];
    assert(budget);
    expect(budget).toMatchObject({ min_buy_usd: 90.35, acquire_usd: 9.85 });
    expect(run.invariants).toContain("full_100_card_price_including_commander_at_most_100_usd");
    expect(structured(run, "collection_set")).toHaveLength(1);
  });

  it("tunes an imported deck with real mutation, snapshot, diff and export calls", () => {
    const run = workflow("import-tune");
    expect(structured(run, "deck_import")[0]).toMatchObject({ unresolved: [] });
    expect(structured(run, "deck_diff")[0]).toMatchObject({
      diff: {
        cards: {
          added: [{ oracle_id: "wf-arcane", qty: 1 }],
          removed: [{ oracle_id: "wf-sol", qty: 1 }],
          changed: [],
        },
      },
    });
    expect(structured(run, "validate_deck")[0]).toMatchObject({ ok: true });
    expect(structured(run, "deck_export")[0]?.text).toContain("1 Arcane Signet");
  });

  it("reduces acquisition cost against the same owned collection without changing card count", () => {
    const run = workflow("acquisition-reduction");
    expect(structured(run, "budget_plan")).toMatchObject([
      { min_buy_usd: 90.2, acquire_usd: 89.7 },
      { min_buy_usd: 11.2, acquire_usd: 10.7 },
    ]);
    expect(run.invariants).toContain("owned_aware_acquisition_cost_reduced_by_79_usd");
    expect(structured(run, "validate_deck")[0]).toMatchObject({ ok: true });
  });

  it("recovers from ambiguous names and a cold upstream outage without failed-call mutations", () => {
    const run = workflow("error-recovery");
    const errors = run.calls.filter((call) => call.expected_error);
    expect(errors.map((call) => object(object(call.result).structuredContent).code)).toEqual([
      "AMBIGUOUS_NAME",
      "UPSTREAM_UNAVAILABLE",
    ]);
    expect(errors.every((call) => object(call.result).isError === true)).toBe(true);
    expect(structured(run, "meta_recommend")).toHaveLength(2);
    expect(run.invariants).toContain("failed_calls_preserve_deck_card_contents");
    expect(structured(run, "validate_deck")[0]).toMatchObject({ ok: true });
  });

  it("uses no ambient network and repeats identical calls/results apart from measured latency", async () => {
    const repeated = await runWorkflowScenarios();
    const withoutLatency = (values: WorkflowRun[]) =>
      values.map((run) => ({
        ...run,
        calls: run.calls.map((call) => ({ ...call, elapsed_ms: 0 })),
      }));
    expect(withoutLatency(repeated)).toEqual(withoutLatency(runs));
    expect(network).not.toHaveBeenCalled();
    expect(new Set(runs.map((run) => run.id)).size).toBe(4);
  });
});
