/** Replay the checked-in protocol baseline; optionally retain a new observed trace. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { summarizeCalls } from "./workflowMetrics.js";
import { runWorkflowScenarios, WORKFLOW_FIXTURE, WORKFLOW_VERSION } from "./workflowScenarios.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const baselinePath = resolve(root, "docs/evaluation/v0.2.0-baseline.json");
const advicePath = resolve(root, "docs/evaluation/v0.3.0-advice.json");
const budgetPath = resolve(root, "docs/evaluation/whole-deck-budget-v2.json");
const recommendationPath = resolve(root, "docs/evaluation/contextual-recommendations-v1.json");
const manaPath = resolve(root, "docs/evaluation/mana-source-model-v1.json");
const count = z.number().nonnegative().finite();
const metricsSchema = z.object({
  tool_calls: count,
  invalid_calls: count,
  partial_failure_calls: count,
  tool_errors: count,
  rpc_errors: count,
  expected_errors: count,
  response_bytes: count,
  elapsed_ms: count,
});
const baselineSchema = z.object({
  format_version: z.literal(1),
  workflow_version: z.string(),
  fixture_sha256: z.string(),
  mode: z.literal("scripted_protocol"),
  model: z.null(),
  token_counts: z.null(),
  agent_task_success: z.null(),
  workflows: z.array(
    z.object({
      id: z.string(),
      prompt: z.string(),
      invariants: z.array(z.string()),
      metrics: metricsSchema,
      calls: z.array(
        z.object({
          name: z.string(),
          arguments: z.record(z.string(), z.unknown()),
          result: z.unknown(),
          elapsed_ms: count,
          expected_error: z.boolean(),
          rpc_error: z.string().optional(),
          rpc_error_code: z.number().optional(),
        }),
      ),
    }),
  ),
});

afterEach(() => vi.unstubAllGlobals());

/** Hash the live runtime sources, including files not yet added to Git. */
async function productionSourceHash(): Promise<string> {
  async function sourceFiles(directory: string): Promise<string[]> {
    const entries = await readdir(resolve(root, directory), {
      withFileTypes: true,
    });
    const files: string[] = [];
    for (const entry of entries) {
      // Use slash-separated relative names on every platform to keep digest framing stable.
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) files.push(...(await sourceFiles(file)));
      else if (
        entry.isFile() &&
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        !file.startsWith("src/server/workflow")
      )
        files.push(file);
    }
    return files;
  }
  const sourceHash = createHash("sha256");
  for (const file of (await sourceFiles("src")).sort())
    sourceHash
      .update(file)
      .update("\0")
      .update(await readFile(resolve(root, file)));
  return sourceHash.digest("hex");
}

/** Git is optional capture metadata; source-archive replay never needs to invoke it. */
function checkoutProvenance(): {
  checkout_commit: string | null;
  checkout_dirty: boolean | null;
} {
  try {
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    // An extracted source archive inside some other repository is not that checkout.
    if (resolve(git(["rev-parse", "--show-toplevel"]).trim()) === resolve(root))
      return {
        checkout_commit: git(["rev-parse", "HEAD"]).trim(),
        checkout_dirty: git(["status", "--porcelain"]).length > 0,
      };
  } catch {
    // Missing Git metadata is unknown, never a fabricated commit or clean status.
  }
  return { checkout_commit: null, checkout_dirty: null };
}

async function captureProvenance() {
  const versionSchema = z.object({ version: z.string() });
  const packageVersion = versionSchema.parse(
    JSON.parse(await readFile(resolve(root, "package.json"), "utf8")),
  ).version;
  const sdkVersion = versionSchema.parse(
    JSON.parse(
      await readFile(
        resolve(root, "node_modules/@modelcontextprotocol/server/package.json"),
        "utf8",
      ),
    ),
  ).version;
  return {
    ...checkoutProvenance(),
    production_source_sha256: await productionSourceHash(),
    package_version: packageVersion,
    sdk_package: "@modelcontextprotocol/server",
    sdk_version: sdkVersion,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    lockfile_sha256: createHash("sha256")
      .update(await readFile(resolve(root, "package-lock.json")))
      .digest("hex"),
  };
}

it("replays offline workflows within original behavior limits and reviewed mana coverage byte limits", async () => {
  const network = vi.fn(() => {
    throw new Error("Network is forbidden in workflow replay");
  });
  vi.stubGlobal("fetch", network);
  const runs = await runWorkflowScenarios();
  expect(network).not.toHaveBeenCalled();
  const fixtureHash = createHash("sha256").update(JSON.stringify(WORKFLOW_FIXTURE)).digest("hex");
  const report = {
    format_version: 1,
    workflow_version: WORKFLOW_VERSION,
    fixture_sha256: fixtureHash,
    mode: "scripted_protocol",
    transport: "SDK InMemoryTransport (no stdio/HTTP framing)",
    model: null,
    token_counts: null,
    agent_task_success: null,
    measurement: {
      response_bytes:
        "UTF-8 JSON.stringify of parsed SDK tool results, including text fallback; excludes JSON-RPC framing",
      elapsed_ms:
        "Sum of observed tool-call wall time; excludes fixture/index setup; no timing threshold",
      invalid_calls:
        "Calls with invalid input errors or partially rejected/unresolved input batches; expected recovery inputs are included",
    },
    workflows: runs.map((run) => ({
      ...run,
      metrics: summarizeCalls(run.calls),
    })),
  };
  // Opt-in capture never overwrites an earlier observation. Ordinary tests write nothing.
  if (process.env.WORKFLOW_TRACE_OUT) {
    const output = resolve(process.env.WORKFLOW_TRACE_OUT);
    const capture = {
      ...report,
      captured_at: new Date().toISOString(),
      provenance: await captureProvenance(),
    };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(capture, null, 2) + "\n", {
      flag: "wx",
    });
  }
  const baseline = baselineSchema.parse(JSON.parse(await readFile(baselinePath, "utf8")));
  const advice = baselineSchema.parse(JSON.parse(await readFile(advicePath, "utf8")));
  const budget = baselineSchema.parse(JSON.parse(await readFile(budgetPath, "utf8")));
  const recommendation = baselineSchema.parse(
    JSON.parse(await readFile(recommendationPath, "utf8")),
  );
  const mana = baselineSchema.parse(JSON.parse(await readFile(manaPath, "utf8")));
  expect(mana.workflow_version).toBe(baseline.workflow_version);
  expect(mana.fixture_sha256).toBe(baseline.fixture_sha256);
  expect(mana.workflows.map((run) => run.id)).toEqual(baseline.workflows.map((run) => run.id));
  expect(recommendation.workflow_version).toBe(baseline.workflow_version);
  expect(recommendation.fixture_sha256).toBe(baseline.fixture_sha256);
  expect(recommendation.workflows.map((run) => run.id)).toEqual(
    baseline.workflows.map((run) => run.id),
  );
  expect(budget.workflow_version).toBe(baseline.workflow_version);
  expect(budget.fixture_sha256).toBe(baseline.fixture_sha256);
  expect(budget.workflows.map((run) => run.id)).toEqual(baseline.workflows.map((run) => run.id));
  expect(advice.workflow_version).toBe(baseline.workflow_version);
  expect(advice.fixture_sha256).toBe(baseline.fixture_sha256);
  expect(advice.workflows.map((run) => run.id)).toEqual(baseline.workflows.map((run) => run.id));
  expect(WORKFLOW_VERSION).toBe(baseline.workflow_version);
  expect(fixtureHash).toBe(baseline.fixture_sha256);
  expect(runs.map((run) => run.id)).toEqual(baseline.workflows.map((run) => run.id));
  for (const current of report.workflows) {
    const previous = baseline.workflows.find((run) => run.id === current.id);
    expect(previous).toBeDefined();
    if (!previous) throw new Error(`Missing baseline for ${current.id}`);
    expect(current.prompt).toBe(previous.prompt);
    expect(current.invariants).toEqual(previous.invariants);
    // Behavior limits remain the v0.2.0 observations. The separately retained
    // mana trace adds supported-model coverage to one dashboard response;
    // only the byte ceiling changes, by the measured amount, with no extra margin.
    for (const key of [
      "tool_calls",
      "invalid_calls",
      "partial_failure_calls",
      "tool_errors",
      "rpc_errors",
    ] as const) {
      expect(current.metrics[key], `${current.id}: ${key}`).toBeLessThanOrEqual(
        previous.metrics[key],
      );
    }
    const observed = advice.workflows.find((run) => run.id === current.id);
    if (!observed) throw new Error(`Missing advice observation for ${current.id}`);
    expect(observed.prompt).toBe(previous.prompt);
    expect(observed.invariants).toEqual(previous.invariants);
    expect(summarizeCalls(observed.calls)).toEqual(observed.metrics);
    const budgetObserved = budget.workflows.find((run) => run.id === current.id);
    if (!budgetObserved) throw new Error(`Missing budget observation for ${current.id}`);
    expect(budgetObserved.prompt).toBe(previous.prompt);
    expect(budgetObserved.invariants).toEqual(previous.invariants);
    expect(summarizeCalls(budgetObserved.calls)).toEqual(budgetObserved.metrics);
    const recommendationObserved = recommendation.workflows.find((run) => run.id === current.id);
    if (!recommendationObserved)
      throw new Error(`Missing recommendation observation for ${current.id}`);
    expect(recommendationObserved.prompt).toBe(previous.prompt);
    expect(recommendationObserved.invariants).toEqual(previous.invariants);
    expect(summarizeCalls(recommendationObserved.calls)).toEqual(recommendationObserved.metrics);
    const manaObserved = mana.workflows.find((run) => run.id === current.id);
    if (!manaObserved) throw new Error(`Missing mana observation for ${current.id}`);
    expect(manaObserved.prompt).toBe(previous.prompt);
    expect(manaObserved.invariants).toEqual(previous.invariants);
    expect(summarizeCalls(manaObserved.calls)).toEqual(manaObserved.metrics);
    expect(
      manaObserved.calls.map((call) => ({
        name: call.name,
        arguments: call.arguments,
      })),
    ).toEqual(
      recommendationObserved.calls.map((call) => ({
        name: call.name,
        arguments: call.arguments,
      })),
    );
    expect(current.metrics.response_bytes, `${current.id}: response_bytes`).toBeLessThanOrEqual(
      manaObserved.metrics.response_bytes,
    );
    expect(current.metrics.expected_errors).toBe(previous.metrics.expected_errors);
    expect(summarizeCalls(previous.calls)).toEqual(previous.metrics);
    for (const call of current.calls) {
      const result = z
        .object({
          structuredContent: z.record(z.string(), z.unknown()),
          content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
          _meta: z.object({ data_snapshot: z.string() }),
        })
        .parse(call.result);
      expect(result.content).toContainEqual({
        type: "text",
        text: JSON.stringify(result.structuredContent),
      });
      expect(result.structuredContent.data_snapshot).toBe(result._meta.data_snapshot);
      expect(result.structuredContent.data_snapshot).toBe(WORKFLOW_FIXTURE.snapshot);
    }
  }
}, 30_000);
