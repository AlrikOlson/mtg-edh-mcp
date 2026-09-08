/** Frozen evaluation requirements, distinct from measured execution evidence. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { BenchmarkCorpus } from "./corpus.js";
import { MANA_CASES, PACKAGE_CASES } from "./references.js";

const HARD_CHECKS = [
  "CARD_COUNT",
  "QUANTITY",
  "COMMAND_ZONE",
  "COMMANDER_ELIGIBILITY",
  "COMPANION_ZONE",
  "MAYBEBOARD",
  "UNKNOWN_CARD",
  "COLOR_IDENTITY",
  "LEGALITY",
  "COPY_LIMIT",
  "PROTECTED",
  "THEME",
  "BUDGET",
  "DECK_PRICE",
  "ACQUIRE_PRICE",
  "COMPANION_PRICE",
  "CLAIMED_COUNT",
  "CLAIMED_THEME",
  "CLAIMED_LEGALITY",
] as const;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const pinSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !/^(latest|default|unknown|unavailable|pending|unversioned|current)$/i.test(value),
    "A concrete observed version is required.",
  );
const configurationSchema = z.object({
  id: z.string().min(1),
  host: z.enum(["codex-cli", "claude-cli"]),
  transport: z.enum(["stdio", "http"]),
});
const registeredCaseSchema = z.object({
  id: z.string().min(1),
  split: z.enum(["calibration", "holdout"]),
  request: z.enum(["build", "tune", "acquisition"]),
  supported: z.boolean(),
  expectedHardFailures: z.array(z.literal("BUDGET")),
  expectedUnsupportedChecks: z.array(z.literal("REQUESTED_MECHANICS")),
  requiredChecks: z.array(z.enum(["PRICE_UNCERTAINTY", "UNSUPPORTED_DISCLOSURE"])),
});
const registrationSchema = z.object({
  version: z.literal("deck-quality-registration-v1"),
  status: z.literal("preregistered-not-executed"),
  corpusVersion: z.string().min(1),
  corpusDigest: sha256Schema,
  configurations: z.array(configurationSchema),
  cases: z.array(registeredCaseSchema).min(20),
  seeds: z.array(z.number().int().positive()),
  repetitions: z.number().int().positive(),
  hardChecks: z.array(z.enum(HARD_CHECKS)),
  referenceSuites: z.array(z.enum(["mana-payment", "package-optimum"])),
  referenceFixtures: z.array(
    z.object({
      id: z.enum(["mana-payment", "package-optimum"]),
      caseIds: z.array(z.string()).min(1),
      digest: sha256Schema,
    }),
  ),
  finalTasks: z.array(
    z.object({
      id: z.string().min(1),
      caseIds: z.array(z.string()).min(1),
      check: z.string().min(1),
      requirement: z.string().min(1),
    }),
  ),
  thresholds: z.object({
    requiredCheckMatchRate: z.literal(1),
    exactReferenceMismatches: z.literal(0),
    perCaseHardRegressions: z.literal(0),
    supportedCasePassRate: z.literal(1),
  }),
  policy: z.object({
    unsupported: z.literal("retain-and-report-separately-never-pass"),
    holdout: z.literal("never-drop-or-tune-on-holdout"),
    versioning: z.literal("append-new-versions-preserve-v1"),
    configurationFreeze: z.literal("pin-before-first-baseline-and-reuse-for-candidate"),
    execution: z.literal("actual-hosts-at-final-gate-not-this-preregistration"),
    tokens: z.literal("measured-required-for-final-acceptance"),
    regression: z.literal("no-per-case-hard-regression-no-aggregate-offset"),
  }),
  limitations: z.array(z.string()).min(1),
});

export type EvaluationRegistration = z.infer<typeof registrationSchema>;

/** Stable across object property ordering; array order remains part of the contract. */
export function digestEvaluation(value: unknown): string {
  function canonical(entry: unknown): string {
    if (entry === null || typeof entry !== "object") return JSON.stringify(entry) ?? "null";
    if (Array.isArray(entry)) return `[${entry.map(canonical).join(",")}]`;
    return `{${Object.entries(entry)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export async function loadRegistration(): Promise<EvaluationRegistration> {
  const raw = await readFile(
    new URL("../../docs/evaluation/deck-quality/registration-v1.json", import.meta.url),
    "utf8",
  );
  return registrationSchema.parse(JSON.parse(raw));
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((item) => right.includes(item))
  );
}

/** Bind the frozen task matrix to the authored corpus before producing a baseline. */
export function validateRegistration(
  registration: EvaluationRegistration,
  corpus: BenchmarkCorpus,
): string[] {
  const errors: string[] = [];
  if (
    registration.corpusVersion !== corpus.version ||
    registration.corpusDigest !== digestEvaluation(corpus)
  ) {
    errors.push("The corpus changed after preregistration; append a new version and preserve v1.");
  }
  const cases = corpus.cases.map(({ id, split, request, supported, tags }) => ({
    id,
    split,
    request,
    supported,
    expectedHardFailures: tags.includes("unknown-price") ? ["BUDGET"] : [],
    expectedUnsupportedChecks: supported ? [] : ["REQUESTED_MECHANICS"],
    requiredChecks: [
      ...(tags.includes("unknown-price") ? ["PRICE_UNCERTAINTY"] : []),
      ...(supported ? [] : ["UNSUPPORTED_DISCLOSURE"]),
    ],
  }));
  if (digestEvaluation(registration.cases) !== digestEvaluation(cases)) {
    errors.push(
      "The registration must retain every corpus case exactly once with its original split, request, and support status.",
    );
  }
  if (
    digestEvaluation(registration.configurations) !==
    digestEvaluation([
      { id: "codex-cli-stdio", host: "codex-cli", transport: "stdio" },
      { id: "claude-cli-http", host: "claude-cli", transport: "http" },
    ])
  )
    errors.push("Both preregistered real host configurations and transports are required.");
  if (!sameMembers(registration.hardChecks, HARD_CHECKS))
    errors.push("No hard invariant may be removed or duplicated.");
  if (!sameMembers(registration.referenceSuites, ["mana-payment", "package-optimum"])) {
    errors.push("Both independent exact reference suites are required.");
  }
  const fixtures = [
    {
      id: "mana-payment",
      caseIds: MANA_CASES.map((entry) => entry.id),
      digest: digestEvaluation(MANA_CASES),
    },
    {
      id: "package-optimum",
      caseIds: PACKAGE_CASES.map((entry) => entry.id),
      digest: digestEvaluation(PACKAGE_CASES),
    },
  ];
  if (digestEvaluation(registration.referenceFixtures) !== digestEvaluation(fixtures)) {
    errors.push(
      "Exact reference fixture definitions changed; append a new version and preserve v1.",
    );
  }
  if (
    digestEvaluation(registration.seeds) !== digestEvaluation([1701, 2909, 7307]) ||
    registration.repetitions !== 1
  ) {
    errors.push("The three fixed seeds and one repetition per seed may not be weakened.");
  }
  const requiredTasks = [
    "whole-deck",
    "empty-partial-construction",
    "discovery-without-profile",
    "unsupported-mechanics",
  ];
  if (
    !sameMembers(
      registration.finalTasks.map((task) => task.id),
      requiredTasks,
    )
  ) {
    errors.push("Every preregistered final task is required.");
  }
  const caseIds = cases.map((entry) => entry.id);
  for (const task of registration.finalTasks) {
    const expectedIds =
      task.id === "whole-deck"
        ? caseIds
        : task.id === "unsupported-mechanics"
          ? corpus.cases.filter((entry) => !entry.supported).map((entry) => entry.id)
          : task.id === "empty-partial-construction"
            ? corpus.cases
                .filter(
                  (entry) =>
                    entry.request === "build" ||
                    entry.startingMain.reduce((sum, card) => sum + card.qty, 0) <
                      entry.main.reduce((sum, card) => sum + card.qty, 0),
                )
                .map((entry) => entry.id)
            : corpus.cases
                .filter((entry) => entry.tags.includes("no-commander-profile"))
                .map((entry) => entry.id);
    if (!sameMembers(task.caseIds, expectedIds))
      errors.push(`Final task ${task.id} lost or changed its authored case coverage.`);
  }
  return errors;
}

const evidenceSchema = z.object({ path: z.string().min(1), sha256: sha256Schema });
const statusSchema = z.enum(["pass", "fail", "unsupported"]);
const manifestSchema = z.object({
  registrationDigest: sha256Schema,
  corpusDigest: sha256Schema,
  frozenAt: z.iso.datetime(),
  baselineCommit: z.string().regex(/^[a-f0-9]{40}$/),
  candidateCommit: z.string().regex(/^[a-f0-9]{40}$/),
  configurations: z
    .array(
      configurationSchema.extend({
        hostVersion: pinSchema,
        model: pinSchema,
        modelVersion: pinSchema,
        runtime: pinSchema,
        runtimeVersion: pinSchema,
        providerStateDigest: sha256Schema,
        parametersDigest: sha256Schema,
        limits: z.object({
          maxToolCalls: z.number().int().positive(),
          maxRunInputTokens: z.number().int().positive(),
          maxRunOutputTokens: z.number().int().positive(),
          maxWallTimeMs: z.number().int().positive(),
        }),
      }),
    )
    .min(2),
});
const reportSchema = z.object({
  registrationVersion: z.literal("deck-quality-registration-v1"),
  manifest: manifestSchema,
  manifestDigest: sha256Schema,
  baselineManifestDigest: sha256Schema,
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  referenceResults: z.array(
    z.object({
      id: z.string(),
      configurationId: z.string(),
      status: statusSchema,
      mismatches: z.number().int().nonnegative(),
      caseIds: z.array(z.string()),
      definitionDigest: sha256Schema,
      evidence: evidenceSchema,
    }),
  ),
  runs: z.array(
    z.object({
      configurationId: z.string(),
      caseId: z.string(),
      seed: z.number().int(),
      repetition: z.number().int().positive(),
      status: statusSchema,
      checks: z.record(z.string(), statusSchema),
      limitations: z.array(z.string()),
      measurement: z.object({
        kind: z.literal("measured-host-run"),
        transport: z.enum(["stdio", "http"]),
        wallTimeMs: z.number().positive(),
        toolCalls: z.number().int().positive(),
        toolFailures: z.number().int().nonnegative(),
        responseBytes: z.number().int().nonnegative(),
        tokens: z.discriminatedUnion("status", [
          z.object({
            status: z.literal("measured"),
            input: z.number().int().nonnegative(),
            output: z.number().int().nonnegative(),
          }),
          z.object({ status: z.literal("unavailable"), reason: z.string().min(1) }),
        ]),
        transcript: evidenceSchema,
      }),
    }),
  ),
});
export type CandidateReport = z.infer<typeof reportSchema>;
export interface CandidateAssessment {
  accepted: boolean;
  errors: string[];
  expectedRuns: number;
  passedRuns: number;
  unsupportedRuns: number;
}

/**
 * Completeness gate, not an authenticity attestation: the final runner must also
 * verify referenced files and derive checks from the independent graders.
 * Passing unsupported coverage never credits the unsupported domain as a pass.
 */
export function validateCandidateReport(
  input: unknown,
  registration: EvaluationRegistration,
): CandidateAssessment {
  const expectedRuns =
    registration.cases.length *
    registration.configurations.length *
    registration.seeds.length *
    registration.repetitions;
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success)
    return {
      accepted: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      expectedRuns,
      passedRuns: 0,
      unsupportedRuns: 0,
    };
  const report = parsed.data;
  const errors: string[] = [];
  if (
    report.manifest.registrationDigest !== digestEvaluation(registration) ||
    report.manifest.corpusDigest !== registration.corpusDigest
  ) {
    errors.push("The report does not reference the frozen registration and corpus.");
  }
  if (
    report.manifestDigest !== digestEvaluation(report.manifest) ||
    report.baselineManifestDigest !== report.manifestDigest
  ) {
    errors.push(
      "Configuration manifest digest changed; freeze exact pins before the baseline and candidate runs.",
    );
  }
  if (Date.parse(report.manifest.frozenAt) >= Date.parse(report.startedAt)) {
    errors.push("The configuration manifest must be frozen before execution starts.");
  }
  if (Date.parse(report.completedAt) < Date.parse(report.startedAt))
    errors.push("Execution timestamps are out of order.");
  const configurations = report.manifest.configurations.map(({ id, host, transport }) => ({
    id,
    host,
    transport,
  }));
  if (digestEvaluation(configurations) !== digestEvaluation(registration.configurations)) {
    errors.push("Every preregistered host configuration must have exact observed pins.");
  }
  if (
    !sameMembers(
      report.referenceResults.map((result) => JSON.stringify([result.configurationId, result.id])),
      registration.configurations.flatMap((configuration) =>
        registration.referenceSuites.map((id) => JSON.stringify([configuration.id, id])),
      ),
    )
  ) {
    errors.push(
      "Every named exact reference suite must be reported once for each registered host configuration.",
    );
  }
  for (const reference of report.referenceResults) {
    if (reference.status !== "pass" || reference.mismatches !== 0)
      errors.push(`${reference.id} requires a pass with zero mismatches.`);
    const fixture = registration.referenceFixtures.find((entry) => entry.id === reference.id);
    if (
      !fixture ||
      !sameMembers(reference.caseIds, fixture.caseIds) ||
      reference.definitionDigest !== fixture.digest
    ) {
      errors.push(`${reference.id} must retain every named frozen reference fixture.`);
    }
  }
  const runKeys = new Set<string>();
  let passedRuns = 0;
  let unsupportedRuns = 0;
  for (const run of report.runs) {
    const key = JSON.stringify([run.configurationId, run.caseId, run.seed, run.repetition]);
    const entry = registration.cases.find((candidate) => candidate.id === run.caseId);
    const configuration = registration.configurations.find(
      (candidate) => candidate.id === run.configurationId,
    );
    if (
      !entry ||
      !configuration ||
      !registration.seeds.includes(run.seed) ||
      run.repetition > registration.repetitions ||
      runKeys.has(key)
    ) {
      errors.push(`Unexpected or duplicate matrix row: ${key}.`);
    }
    runKeys.add(key);
    const requiredChecks = [
      ...registration.hardChecks,
      ...(entry?.requiredChecks ?? []),
      ...(entry?.expectedUnsupportedChecks ?? []),
      ...registration.finalTasks
        .filter((task) => task.caseIds.includes(run.caseId))
        .map((task) => task.check),
    ];
    for (const check of requiredChecks) {
      const expected = entry?.expectedHardFailures.some((id) => id === check)
        ? "fail"
        : entry?.expectedUnsupportedChecks.some((id) => id === check)
          ? "unsupported"
          : "pass";
      if (run.checks[check] !== expected)
        errors.push(`${key}: ${check} requires explicit ${expected} evidence.`);
    }
    if (entry?.supported) {
      if (run.status !== "pass")
        errors.push(`${key}: supported cases must pass every hard requirement.`);
      else passedRuns++;
    } else if (entry) {
      if (run.status !== "unsupported" || run.limitations.length === 0)
        errors.push(
          `${key}: unsupported mechanics must remain separately reported with limitations.`,
        );
      else unsupportedRuns++;
    }
    if (run.measurement.transport !== configuration?.transport)
      errors.push(`${key}: measured transport does not match the configuration.`);
    if (run.measurement.tokens.status !== "measured")
      errors.push(`${key}: token usage is unavailable; final acceptance requires measured usage.`);
    if (run.measurement.toolFailures > run.measurement.toolCalls)
      errors.push(`${key}: tool failures exceed measured calls.`);
    const pins = report.manifest.configurations.find(
      (candidate) => candidate.id === run.configurationId,
    );
    if (pins) {
      const checkLimit = (metric: string, observed: number, maximum: number) => {
        if (observed > maximum)
          errors.push(
            `${key}: ${metric} exceeds the frozen configuration limit (${observed} > ${maximum}).`,
          );
      };
      checkLimit("toolCalls", run.measurement.toolCalls, pins.limits.maxToolCalls);
      checkLimit("wallTimeMs", run.measurement.wallTimeMs, pins.limits.maxWallTimeMs);
      if (run.measurement.tokens.status === "measured") {
        checkLimit("inputTokens", run.measurement.tokens.input, pins.limits.maxRunInputTokens);
        checkLimit("outputTokens", run.measurement.tokens.output, pins.limits.maxRunOutputTokens);
      }
    }
  }
  if (report.runs.length !== expectedRuns || runKeys.size !== expectedRuns) {
    errors.push(
      "The complete preregistered case/configuration/seed/repetition matrix is required.",
    );
  }
  return { accepted: errors.length === 0, errors, expectedRuns, passedRuns, unsupportedRuns };
}
