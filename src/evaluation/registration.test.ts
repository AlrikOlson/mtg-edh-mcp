import { describe, expect, it } from "vitest";
import { loadBenchmarkCorpus } from "./corpus.js";
import {
  digestEvaluation,
  loadRegistration,
  validateCandidateReport,
  validateRegistration,
  type CandidateReport,
  type EvaluationRegistration,
} from "./registration.js";

// Synthetic receipts exercise validation only. They are not host-run evidence.
function exampleReport(registration: EvaluationRegistration): CandidateReport {
  const manifest = {
    registrationDigest: digestEvaluation(registration),
    corpusDigest: registration.corpusDigest,
    frozenAt: "2026-09-08T00:00:00.000Z",
    baselineCommit: "a".repeat(40),
    candidateCommit: "b".repeat(40),
    configurations: registration.configurations.map((configuration) => ({
      ...configuration,
      hostVersion: "test-host-1.0.0",
      model: "test-only-model",
      modelVersion: "test-only-snapshot-2026-09-08",
      runtime: "node",
      runtimeVersion: "24.0.0",
      providerStateDigest: "c".repeat(64),
      parametersDigest: "d".repeat(64),
      limits: {
        maxToolCalls: configuration.host === "codex-cli" ? 100 : 50,
        maxRunInputTokens: configuration.host === "codex-cli" ? 100000 : 50000,
        maxRunOutputTokens: configuration.host === "codex-cli" ? 20000 : 10000,
        maxWallTimeMs: configuration.host === "codex-cli" ? 600000 : 300000,
      },
    })),
  };
  return {
    registrationVersion: registration.version,
    manifest,
    manifestDigest: digestEvaluation(manifest),
    baselineManifestDigest: digestEvaluation(manifest),
    startedAt: "2026-09-08T01:00:00.000Z",
    completedAt: "2026-09-08T02:00:00.000Z",
    referenceResults: registration.configurations.flatMap((configuration) =>
      registration.referenceFixtures.map((fixture) => ({
        id: fixture.id,
        configurationId: configuration.id,
        caseIds: fixture.caseIds,
        definitionDigest: fixture.digest,
        status: "pass",
        mismatches: 0,
        evidence: { path: "test-only/reference.json", sha256: "e".repeat(64) },
      })),
    ),
    runs: registration.configurations.flatMap((configuration) =>
      registration.cases.flatMap((entry) =>
        registration.seeds.flatMap((seed) =>
          Array.from({ length: registration.repetitions }, (_, repetition) => ({
            configurationId: configuration.id,
            caseId: entry.id,
            seed,
            repetition: repetition + 1,
            status: entry.supported ? ("pass" as const) : ("unsupported" as const),
            checks: Object.fromEntries(
              [
                ...registration.hardChecks,
                ...entry.requiredChecks,
                ...entry.expectedUnsupportedChecks,
                ...registration.finalTasks
                  .filter((task) => task.caseIds.includes(entry.id))
                  .map((task) => task.check),
              ].map((id) => [
                id,
                entry.expectedHardFailures.some((check) => check === id)
                  ? "fail"
                  : entry.expectedUnsupportedChecks.some((check) => check === id)
                    ? "unsupported"
                    : "pass",
              ]),
            ),
            limitations: entry.supported
              ? []
              : ["Authored unsupported mechanic remains unsupported."],
            measurement: {
              kind: "measured-host-run" as const,
              transport: configuration.transport,
              wallTimeMs: 100,
              toolCalls: 2,
              toolFailures: 0,
              responseBytes: 1024,
              tokens: { status: "measured" as const, input: 120, output: 80 },
              transcript: { path: "test-only/transcript.jsonl", sha256: "f".repeat(64) },
            },
          })),
        ),
      ),
    ),
  };
}

describe("preregistered final Commander quality gate", () => {
  it("freezes every authored case and requires both real host transports", async () => {
    const [registration, corpus] = await Promise.all([loadRegistration(), loadBenchmarkCorpus()]);
    expect(validateRegistration(registration, corpus)).toEqual([]);
    expect(registration.configurations.map((entry) => entry.transport)).toEqual(["stdio", "http"]);
    expect(registration.referenceSuites).toEqual(["mana-payment", "package-optimum"]);
  });

  it("counts explicitly unsupported cases separately from passes", async () => {
    const registration = await loadRegistration();
    const result = validateCandidateReport(exampleReport(registration), registration);
    expect(result.errors).toEqual([]);
    expect(result.accepted).toBe(true);
    expect(result.unsupportedRuns).toBeGreaterThan(0);
    expect(result.passedRuns + result.unsupportedRuns).toBe(result.expectedRuns);
  });

  it("rejects a report that drops a holdout repetition", async () => {
    const registration = await loadRegistration();
    const report = exampleReport(registration);
    const holdout = registration.cases.find((entry) => entry.split === "holdout");
    report.runs.splice(
      report.runs.findIndex((run) => run.caseId === holdout?.id),
      1,
    );
    expect(validateCandidateReport(report, registration).errors).toContain(
      "The complete preregistered case/configuration/seed/repetition matrix is required.",
    );
  });

  it("rejects unsupported mechanics relabeled as passed", async () => {
    const registration = await loadRegistration();
    const report = exampleReport(registration);
    const run = report.runs.find((entry) => entry.status === "unsupported");
    if (!run) throw new Error("Registration must retain unsupported coverage.");
    run.status = "pass";
    expect(validateCandidateReport(report, registration).accepted).toBe(false);
  });

  it("requires truthful budget uncertainty rather than a false cap certification", async () => {
    const registration = await loadRegistration();
    const report = exampleReport(registration);
    const scenario = registration.cases.find((entry) =>
      entry.expectedHardFailures.includes("BUDGET"),
    );
    const run = report.runs.find((entry) => entry.caseId === scenario?.id);
    if (!run) throw new Error("Expected protected unknown-price coverage.");
    expect(validateCandidateReport(report, registration).accepted).toBe(true);
    run.checks.BUDGET = "pass";
    delete run.checks.PRICE_UNCERTAINTY;
    const result = validateCandidateReport(report, registration);
    expect(result.accepted).toBe(false);
    expect(result.errors.some((message) => message.includes("BUDGET requires explicit fail"))).toBe(
      true,
    );
    expect(result.errors.some((message) => message.includes("PRICE_UNCERTAINTY"))).toBe(true);
  });

  it("rejects missing hard evidence and a nonzero exact-reference mismatch", async () => {
    const registration = await loadRegistration();
    const report = exampleReport(registration);
    const run = report.runs[0];
    const reference = report.referenceResults[0];
    if (!run || !reference) throw new Error("Expected matrix and reference suite.");
    delete run.checks.ACQUIRE_PRICE;
    reference.mismatches = 1;
    const result = validateCandidateReport(report, registration);
    expect(result.accepted).toBe(false);
    expect(result.errors.some((message) => message.includes("ACQUIRE_PRICE"))).toBe(true);
    expect(result.errors.some((message) => message.includes("zero mismatches"))).toBe(true);
  });

  it("rejects changed model pins and a manifest frozen after execution", async () => {
    const registration = await loadRegistration();
    const report = exampleReport(registration);
    const configuration = report.manifest.configurations[0];
    if (!configuration) throw new Error("Expected configuration.");
    configuration.modelVersion = "changed-after-baseline";
    report.manifest.frozenAt = report.completedAt;
    const result = validateCandidateReport(report, registration);
    expect(result.errors).toContain(
      "Configuration manifest digest changed; freeze exact pins before the baseline and candidate runs.",
    );
    expect(result.errors).toContain(
      "The configuration manifest must be frozen before execution starts.",
    );
  });

  it("rejects an exact suite result that silently omits a difficult puzzle", async () => {
    const registration = await loadRegistration();
    const report = exampleReport(registration);
    const reference = report.referenceResults[0];
    if (!reference) throw new Error("Expected reference suite.");
    reference.caseIds = reference.caseIds.slice(1);
    const result = validateCandidateReport(report, registration);
    expect(result.accepted).toBe(false);
    expect(result.errors).toContain(
      `${reference.id} must retain every named frozen reference fixture.`,
    );
  });

  it("requires each exact reference suite independently for both registered hosts", async () => {
    const registration = await loadRegistration();
    const report = exampleReport(registration);
    expect(report.referenceResults).toHaveLength(4);
    expect(validateCandidateReport(report, registration).accepted).toBe(true);
    report.referenceResults.pop();
    const result = validateCandidateReport(report, registration);
    expect(result.accepted).toBe(false);
    expect(result.errors).toContain(
      "Every named exact reference suite must be reported once for each registered host configuration.",
    );
  });

  it.each(["toolCalls", "inputTokens", "outputTokens", "wallTimeMs"])(
    "rejects %s beyond that host's frozen run budget",
    async (metric) => {
      const registration = await loadRegistration();
      const report = exampleReport(registration);
      const configuration = report.manifest.configurations[1];
      const run = report.runs.find((entry) => entry.configurationId === configuration?.id);
      if (!configuration || !run || run.measurement.tokens.status !== "measured")
        throw new Error("Expected measured host run.");
      const limits = configuration.limits;
      if (metric === "toolCalls") run.measurement.toolCalls = limits.maxToolCalls + 1;
      if (metric === "inputTokens") run.measurement.tokens.input = limits.maxRunInputTokens + 1;
      if (metric === "outputTokens") run.measurement.tokens.output = limits.maxRunOutputTokens + 1;
      if (metric === "wallTimeMs") run.measurement.wallTimeMs = limits.maxWallTimeMs + 1;
      const result = validateCandidateReport(report, registration);
      expect(result.accepted).toBe(false);
      expect(
        result.errors.some((message) =>
          message.includes(`${metric} exceeds the frozen configuration limit`),
        ),
      ).toBe(true);
    },
  );

  it("accepts measurements at the exact frozen run limits", async () => {
    const registration = await loadRegistration();
    const report = exampleReport(registration);
    const configuration = report.manifest.configurations[1];
    const run = report.runs.find((entry) => entry.configurationId === configuration?.id);
    if (!configuration || !run) throw new Error("Expected measured host run.");
    const limits = configuration.limits;
    run.measurement.toolCalls = limits.maxToolCalls;
    run.measurement.tokens = {
      status: "measured",
      input: limits.maxRunInputTokens,
      output: limits.maxRunOutputTokens,
    };
    run.measurement.wallTimeMs = limits.maxWallTimeMs;
    expect(validateCandidateReport(report, registration).errors).toEqual([]);
  });

  it("rejects mock or absent measurements and malformed reports without throwing", async () => {
    const registration = await loadRegistration();
    const report = exampleReport(registration);
    const run = report.runs[0];
    if (!run) throw new Error("Expected run.");
    const simulated = {
      ...report,
      runs: [{ ...run, measurement: { ...run.measurement, kind: "simulated" } }],
    };
    expect(validateCandidateReport(simulated, registration).accepted).toBe(false);
    expect(validateCandidateReport({}, registration).accepted).toBe(false);
  });

  it("detects corpus and matrix tampering even when a report is internally consistent", async () => {
    const [registration, corpus] = await Promise.all([loadRegistration(), loadBenchmarkCorpus()]);
    registration.cases.pop();
    corpus.cases[0]?.tags.push("changed-after-freeze");
    const errors = validateRegistration(registration, corpus);
    expect(errors).toContain(
      "The corpus changed after preregistration; append a new version and preserve v1.",
    );
    expect(errors).toContain(
      "The registration must retain every corpus case exactly once with its original split, request, and support status.",
    );
  });
});
