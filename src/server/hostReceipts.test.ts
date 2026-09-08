import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  gradeHostEvaluation,
  HOST_EVALUATION_SCENARIOS,
  type HostEvaluationEvent,
  type HostEvaluationScenario,
  type HostEvaluationState,
} from "./hostEvaluation.fixture.js";
import { summarizeCalls, type WorkflowCall } from "./workflowMetrics.js";
import { WORKFLOW_FIXTURE, WORKFLOW_VERSION } from "./workflowScenarios.js";

type Host = "claude" | "codex";
type Revision = "baseline" | "current" | "final";
type JsonObject = Record<string, unknown>;
interface RpcMessage extends JsonObject {
  id?: string | number;
  method?: string;
  params?: { name: string; arguments?: JsonObject };
  result?: JsonObject & { structuredContent?: JsonObject };
  error?: { code: number; message: string };
}
interface TraceEvent extends HostEvaluationEvent {
  message?: RpcMessage;
}
interface HostEvent {
  type: string;
  subtype?: string;
  model?: string;
  is_error?: boolean;
  usage?: unknown;
  item?: { type: string; server?: string };
  message?: { content?: Array<{ type: string; name?: string }> };
}
interface Result {
  scenario: HostEvaluationScenario;
  original_prompt: string;
  prompt_sha256: string;
  host: Host;
  host_version: string;
  requested_model: string;
  observed_model: string | null;
  model_identity_source: string;
  exit: { code: number | null; signal: string | null };
  timed_out: boolean;
  spawn_error: string | null;
  host_completed: boolean;
  protocol_version: unknown;
  server_info: unknown;
  workflow_version: string;
  fixture_sha256: string;
  metrics: ReturnType<typeof summarizeCalls> & {
    tool_elapsed_ms: number;
    unanswered_tool_calls: number;
    token_counts: unknown;
    token_source: string;
  };
  grade: ReturnType<typeof gradeHostEvaluation>;
  prohibited_host_events: number;
  agent_task_success: boolean;
}
interface Receipt {
  format_version: number;
  mode: string;
  captured_at: string;
  provenance: {
    source_root_kind: string;
    checkout_commit: string;
    checkout_dirty: boolean;
    package_version: string;
    sdk_package: string;
    sdk_version: string;
    lockfile_sha256: string;
    bundled_input_sha256: string;
    bundled_inputs: Array<{ file: string; sha256: string }>;
    adapter_sha256: string;
    runner_sha256: string;
    server_bundle_sha256: string;
    grader_bundle_sha256: string;
    node: string;
  };
  results: Result[];
}

const base = new URL("../../docs/evaluation/hosts/", import.meta.url);
const hosts = ["claude", "codex"] as const;
const revisions = ["baseline", "current", "final"] as const;
// The initial baseline-* attempts retain an ABI startup failure. The node24
// retries are the production baseline; an unavailable fixture is never a pass.
const directory = (host: Host, revision: Revision) =>
  revision === "baseline" ? `baseline-${host}-node24` : `${revision}-${host}`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const fixtureHash = sha256(JSON.stringify(WORKFLOW_FIXTURE));
const digest = /^[a-f0-9]{64}$/;
const readText = (name: string) => readFile(new URL(name, base), "utf8");
const readJson = async <T>(name: string): Promise<T> => JSON.parse(await readText(name)) as T;
const readJsonLines = async <T>(name: string): Promise<T[]> =>
  (await readText(name))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);

function replayCalls(events: TraceEvent[], scenario: HostEvaluationScenario) {
  const requests = events.filter(
    (event) => event.direction === "client_to_server" && event.message?.method === "tools/call",
  );
  const ids = requests.map((event) => event.message?.id);
  expect(ids.every((id) => typeof id === "string" || typeof id === "number")).toBe(true);
  expect(new Set(ids).size).toBe(requests.length);
  let unanswered = 0;
  const calls: WorkflowCall[] = requests.map((request) => {
    const responses = events.filter(
      (event) =>
        event.direction === "server_to_client" && event.message?.id === request.message?.id,
    );
    expect(responses.length).toBeLessThanOrEqual(1);
    const response = responses[0];
    const message = response?.message;
    if (!response) unanswered += 1;
    else expect(response.sequence).toBeGreaterThan(request.sequence);
    const params = request.message?.params;
    assert(params && typeof params.name === "string", "Tool call must name its requested tool");
    return {
      name: params.name,
      arguments: params.arguments ?? {},
      result: message?.result ?? null,
      ...(message?.error
        ? { rpc_error: message.error.message, rpc_error_code: message.error.code }
        : {}),
      elapsed_ms: response ? response.elapsed_ms - request.elapsed_ms : 0,
      expected_error:
        scenario === "error-recovery" &&
        ["AMBIGUOUS_NAME", "UPSTREAM_UNAVAILABLE"].includes(
          String(message?.result?.structuredContent?.code),
        ),
    };
  });
  return { calls, unanswered };
}

/** Accepted evidence must be internally consistent and successful. */
function assertAcceptedOutcome(
  result: Result,
  complete: boolean,
  prohibited: number,
  unanswered: number,
): void {
  expect(result.agent_task_success).toBe(
    complete &&
      result.exit.code === 0 &&
      !result.timed_out &&
      prohibited === 0 &&
      unanswered === 0 &&
      result.grade.passed,
  );
  expect(result.agent_task_success, "Accepted host evidence must record a successful task").toBe(
    true,
  );
}

it("rejects a self-consistent failed task in the accepted host evidence", async () => {
  const receipt = await readJson<Receipt>("final-codex/receipt.json");
  const original = receipt.results[0];
  assert(original);
  const failed = structuredClone(original);
  failed.agent_task_success = false;
  failed.grade.passed = false;
  const firstCheck = failed.grade.checks[0];
  assert(firstCheck);
  firstCheck.passed = false;
  // An accurately recorded task failure is still insufficient release evidence.
  expect(() => assertAcceptedOutcome(failed, true, 0, 0)).toThrow();
});

for (const host of hosts) {
  for (const revision of revisions) {
    const dir = directory(host, revision);
    describe(`retained model-host evidence: ${dir}`, () => {
      it.each(HOST_EVALUATION_SCENARIOS)(
        "replays %s without a host or network",
        async (scenario) => {
          const prefix = `${dir}/${scenario}`;
          const [receipt, result, state, events, hostEvents, prompt] = await Promise.all([
            readJson<Receipt>(`${dir}/receipt.json`),
            readJson<Result>(`${prefix}/result.json`),
            readJson<HostEvaluationState>(`${prefix}/state.json`),
            readJsonLines<TraceEvent>(`${prefix}/mcp.jsonl`),
            readJsonLines<HostEvent>(`${prefix}/host.jsonl`),
            readText(`${prefix}/prompt.txt`),
          ]);
          expect(receipt.format_version).toBe(1);
          expect(receipt.mode).toBe("model_driven_host");
          expect(Number.isFinite(Date.parse(receipt.captured_at))).toBe(true);
          expect(receipt.results.map((item) => item.scenario)).toEqual(HOST_EVALUATION_SCENARIOS);
          expect(receipt.results.find((item) => item.scenario === scenario)).toEqual(result);
          expect(result.host).toBe(host);
          expect(result.scenario).toBe(scenario);
          expect(result.prompt_sha256).toBe(sha256(prompt));
          expect(prompt).toContain(result.original_prompt);
          expect(result.workflow_version).toBe(WORKFLOW_VERSION);
          expect(result.fixture_sha256).toBe(fixtureHash);
          const finalEvent = events.at(-1);
          assert(finalEvent, "Retained MCP trace must contain its final state");
          expect(finalEvent.state).toEqual(state);
          for (const [index, event] of events.entries()) {
            expect(event.sequence).toBe(index + 1);
            expect(event.state).toMatchObject({
              scenario,
              workflow_version: WORKFLOW_VERSION,
              fixture_sha256: fixtureHash,
            });
            expect(event.elapsed_ms).toBeGreaterThanOrEqual(events[index - 1]?.elapsed_ms ?? 0);
          }
          expect(result.grade).toEqual(gradeHostEvaluation(scenario, state, events));
          const { calls, unanswered } = replayCalls(events, scenario);
          const { elapsed_ms: toolElapsed, ...summary } = summarizeCalls(calls);
          const {
            elapsed_ms: wallElapsed,
            tool_elapsed_ms: recordedToolElapsed,
            unanswered_tool_calls: recordedUnanswered,
            token_counts: tokens,
            token_source: tokenSource,
            ...recordedSummary
          } = result.metrics;
          expect(recordedSummary).toEqual(summary);
          expect(recordedToolElapsed).toBe(toolElapsed);
          expect(recordedUnanswered).toBe(unanswered);
          expect(Number.isFinite(wallElapsed)).toBe(true);
          expect(wallElapsed).toBeGreaterThanOrEqual(finalEvent.elapsed_ms);
          const reversedHostEvents = [...hostEvents].reverse();
          const lastResult = reversedHostEvents.find((event) => event.type === "result");
          const lastTurn = reversedHostEvents.find((event) => event.type === "turn.completed");
          const usage = (host === "claude" ? lastResult?.usage : lastTurn?.usage) ?? null;
          expect(tokens).toEqual(usage);
          expect(tokenSource).toBe(usage === null ? "unobserved" : "host_reported");
          const observedModel =
            host === "claude"
              ? (hostEvents.find((event) => event.type === "system" && event.subtype === "init")
                  ?.model ?? null)
              : null;
          expect(result.observed_model).toBe(observedModel);
          expect(result.model_identity_source).toBe(
            host === "claude"
              ? "host_init_event"
              : "explicit_CLI_selection_no_resolved_revision_event",
          );
          const prohibited = hostEvents.filter((event) => {
            if (event.type === "item.completed") {
              if (event.item?.type === "mcp_tool_call") return event.item.server !== "mtg";
              return !["agent_message", "reasoning", "plan", "todo_list", "error"].includes(
                event.item?.type ?? "",
              );
            }
            return (
              event.type === "assistant" &&
              event.message?.content?.some(
                (item) => item.type === "tool_use" && !item.name?.startsWith("mcp__mtg__"),
              )
            );
          });
          expect(result.prohibited_host_events).toBe(prohibited.length);
          const complete =
            host === "claude" ? lastResult?.is_error === false : lastTurn !== undefined;
          expect(result.host_completed).toBe(complete);
          assertAcceptedOutcome(result, complete, prohibited.length, unanswered);
          const initialize = events.find((event) => event.message?.result?.protocolVersion)?.message
            ?.result;
          expect(result.protocol_version).toEqual(initialize?.protocolVersion ?? null);
          expect(result.server_info).toEqual(initialize?.serverInfo ?? null);
        },
      );
    });
  }

  it.each(["current", "final"] as const)(
    `${host} %s comparison retains identical tasks and distinct production provenance`,
    async (revision) => {
      const current = await readJson<Receipt>(`${directory(host, revision)}/receipt.json`);
      const baseline = await readJson<Receipt>(`${directory(host, "baseline")}/receipt.json`);
      for (const receipt of [current, baseline]) {
        const provenance = receipt.provenance;
        expect(provenance.checkout_commit).toMatch(/^[a-f0-9]{40}$/);
        expect(provenance.bundled_inputs.length).toBeGreaterThan(0);
        for (const input of provenance.bundled_inputs) expect(input.sha256).toMatch(digest);
        expect(provenance.bundled_input_sha256).toBe(
          sha256(JSON.stringify(provenance.bundled_inputs)),
        );
        for (const field of [
          "lockfile_sha256",
          "adapter_sha256",
          "runner_sha256",
          "server_bundle_sha256",
          "grader_bundle_sha256",
        ] as const)
          expect(provenance[field]).toMatch(digest);
        for (const productionFile of ["src/server/createServer.ts", "src/server/deckTools.ts"])
          expect(
            provenance.bundled_inputs.some((input) => input.file.endsWith(productionFile)),
          ).toBe(true);
      }
      expect(current.provenance).toMatchObject({
        source_root_kind: "working_checkout",
        checkout_dirty: true,
        sdk_package: "@modelcontextprotocol/server",
        package_version: revision === "final" ? "0.3.0" : "0.2.0",
      });
      expect(baseline.provenance).toMatchObject({
        source_root_kind: "comparison_checkout",
        checkout_dirty: false,
        sdk_package: "@modelcontextprotocol/sdk",
        package_version: "0.2.0",
      });
      expect(current.provenance.checkout_commit).not.toBe(baseline.provenance.checkout_commit);
      expect(current.provenance.server_bundle_sha256).not.toBe(
        baseline.provenance.server_bundle_sha256,
      );
      // The baseline retry adds a native SQLite preflight before invoking the
      // model. Runner hashes remain attached, while prompts and grading match.
      for (const field of ["adapter_sha256", "grader_bundle_sha256", "node"] as const)
        expect(current.provenance[field]).toBe(baseline.provenance[field]);
      for (const scenario of HOST_EVALUATION_SCENARIOS) {
        const before = baseline.results.find((result) => result.scenario === scenario);
        const after = current.results.find((result) => result.scenario === scenario);
        assert(before && after, `Both revisions must retain the ${scenario} task`);
        for (const field of [
          "original_prompt",
          "prompt_sha256",
          "host",
          "host_version",
          "requested_model",
          "workflow_version",
          "fixture_sha256",
        ] as const)
          expect(after[field]).toEqual(before[field]);
        expect(after.requested_model.length).toBeGreaterThan(0);
        expect(after.host_version.length).toBeGreaterThan(0);
      }
    },
  );
}

it.each(revisions)(
  "both hosts evaluate the same %s production revision and fixture adapter",
  async (revision) => {
    const claude = await readJson<Receipt>(`${directory("claude", revision)}/receipt.json`);
    const codex = await readJson<Receipt>(`${directory("codex", revision)}/receipt.json`);
    expect(claude.provenance).toEqual(codex.provenance);
  },
);
