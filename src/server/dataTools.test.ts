import { describe, expect, it } from "vitest";
import { IngestRunner, makeDataTools, type IngestPipeline } from "./dataTools.js";
import type { ToolDefinition } from "./registry.js";

function tool(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

/** A pipeline the test controls: resolves/rejects on command. */
function controlledPipeline(): {
  pipeline: IngestPipeline;
  finish: (cards: number) => void;
  fail: (message: string) => void;
} {
  let resolve!: (v: { snapshot: string; cards: number; skipped: boolean }) => void;
  let reject!: (e: Error) => void;
  const pipeline: IngestPipeline = (_root, _force, onPhase) => {
    onPhase("download");
    return new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
  };
  return {
    pipeline,
    finish: (cards) => resolve({ snapshot: "2026-07-02", cards, skipped: false }),
    fail: (message) => reject(new Error(message)),
  };
}

/** Let the runner's background promise settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("IngestRunner", () => {
  it("runs one ingest at a time and reports done", async () => {
    const { pipeline, finish } = controlledPipeline();
    const runner = new IngestRunner("unused", pipeline);
    expect(runner.status().phase).toBe("idle");

    expect(runner.start(false)).toBe(true);
    expect(runner.start(false)).toBe(false); // already running
    expect(runner.status()).toMatchObject({ running: true, phase: "download" });

    finish(31337);
    await tick();
    expect(runner.status()).toMatchObject({
      running: false,
      phase: "done",
      snapshot: "2026-07-02",
      cards: 31337,
    });
    // A finished runner can start again.
    expect(runner.start(true)).toBe(true);
  });

  it("captures pipeline failure as a retryable error state", async () => {
    const { pipeline, fail } = controlledPipeline();
    const runner = new IngestRunner("unused", pipeline);
    runner.start(false);
    fail("network down");
    await tick();
    expect(runner.status()).toMatchObject({
      running: false,
      phase: "error",
      error: "network down",
    });
    expect(runner.start(false)).toBe(true); // retryable
  });
});

describe("data tools", () => {
  it("data_status reports index presence + ingest state", async () => {
    const { pipeline } = controlledPipeline();
    const runner = new IngestRunner("unused", pipeline);
    const status = tool(makeDataTools({ hasIndex: false, runner }), "data_status");
    const result = await status.handler({}, undefined);
    expect(result.structuredContent).toMatchObject({
      has_index: false,
      ingest: { running: false, phase: "idle" },
    });
  });

  it("data_ingest starts a run and reports already_running on the second call", async () => {
    const { pipeline } = controlledPipeline();
    const runner = new IngestRunner("unused", pipeline);
    const ingest = tool(makeDataTools({ hasIndex: true, runner }), "data_ingest");
    const first = await ingest.handler({}, undefined);
    expect(first.structuredContent).toMatchObject({ started: true, already_running: false });
    const second = await ingest.handler({}, undefined);
    expect(second.structuredContent).toMatchObject({ started: false, already_running: true });
  });
});
