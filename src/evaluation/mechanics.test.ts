import { describe, expect, it } from "vitest";
import { MECHANICS_EXTRACTOR_VERSION } from "../types/index.js";
import {
  holdoutDigest,
  loadMechanicsCorpus,
  scoreMechanicsCorpus,
  type MechanicsScoreReport,
  type MechanicsSplitScore,
} from "./mechanics.js";

/**
 * Pinned digest of the holdout subset. Changing holdout cases changes this
 * value; the change must be reviewed as an annotation correction, never as
 * tuning toward the extractor (docs/evaluation/mechanics/README.md).
 */
const HOLDOUT_DIGEST = "f5180f57d5b229292bc158dd54f52e75160e15fea1837e10eb21bbb318db5af9";

/** Acceptance: precision of supported assertions. Recall and coverage are reported, not gated. */
const PRECISION_FLOOR = 0.95;

function summary(s: MechanicsSplitScore): string {
  const cov = s.coverage;
  return (
    `${s.split}: cases ${s.cases}, expected ${s.expected}, produced ${s.produced}, ` +
    `TP ${s.true_positives}, FP ${s.false_positives}, missed ${s.missed}, ` +
    `precision ${s.precision?.toFixed(4) ?? "n/a"}, recall ${s.recall?.toFixed(4) ?? "n/a"}, ` +
    `sentence coverage ${cov.sentences_supported}/${cov.sentences_total} ` +
    `(unmodeled ${cov.sentences_unmodeled}, uncertain ${cov.sentences_uncertain}), ` +
    `abilities fully modeled ${cov.abilities_fully_modeled}/${cov.abilities_total}, ` +
    `cards fully modeled ${cov.cards_fully_modeled}/${s.cases}`
  );
}

function failureLines(report: MechanicsScoreReport, split: "calibration" | "holdout"): string {
  return report.splits[split].failures
    .map((f) => `  ${f.case_id} ${f.kind}: ${f.detail}`)
    .join("\n");
}

describe("mechanics evidence corpus", () => {
  it("has at least 100 independently annotated cases across both splits", async () => {
    const corpus = await loadMechanicsCorpus();
    const calibration = corpus.cases.filter((c) => c.split === "calibration");
    const holdout = corpus.cases.filter((c) => c.split === "holdout");
    expect(corpus.cases.length).toBeGreaterThanOrEqual(100);
    expect(calibration.length).toBeGreaterThanOrEqual(30);
    expect(holdout.length).toBeGreaterThanOrEqual(30);
    // Negatives exist in both splits: rejections and cases that assert nothing.
    for (const split of [calibration, holdout]) {
      expect(split.some((c) => c.reject.length > 0)).toBe(true);
      expect(split.some((c) => c.expect.length === 0 && c.expect_unmodeled)).toBe(true);
      expect(split.some((c) => c.expect.some((e) => e.condition === "conditional"))).toBe(true);
      expect(split.some((c) => c.expect.some((e) => e.subject === "opponent"))).toBe(true);
      expect(split.some((c) => c.expect.some((e) => e.pattern.startsWith("cost.")))).toBe(true);
    }
  });

  it("keeps the holdout subset frozen behind a pinned digest", async () => {
    const corpus = await loadMechanicsCorpus();
    const digest = holdoutDigest(corpus);
    expect(digest, `holdout digest is ${digest}`).toBe(HOLDOUT_DIGEST);
  });

  it("reaches the precision floor on holdout and overall, and reports recall and coverage", async () => {
    const corpus = await loadMechanicsCorpus();
    const report = scoreMechanicsCorpus(corpus);
    expect(report.extractor_version).toBe(MECHANICS_EXTRACTOR_VERSION);
    const lines = [
      `extractor ${report.extractor_version}, corpus ${report.corpus_version}`,
      summary(report.splits.calibration),
      summary(report.splits.holdout),
      summary(report.splits.all),
    ];
    console.info(lines.join("\n"));
    const calibrationFailures = failureLines(report, "calibration");
    if (calibrationFailures) console.info(`calibration failures:\n${calibrationFailures}`);
    const holdoutFailures = failureLines(report, "holdout");
    if (holdoutFailures) console.info(`holdout failures:\n${holdoutFailures}`);
    const holdout = report.splits.holdout;
    const all = report.splits.all;
    expect(
      holdout.precision,
      `holdout failures:\n${failureLines(report, "holdout")}`,
    ).not.toBeNull();
    expect(
      holdout.precision ?? 0,
      `holdout failures:\n${failureLines(report, "holdout")}`,
    ).toBeGreaterThanOrEqual(PRECISION_FLOOR);
    expect(
      all.precision ?? 0,
      `calibration failures:\n${failureLines(report, "calibration")}`,
    ).toBeGreaterThanOrEqual(PRECISION_FLOOR);
    // Status expectations (unmodeled/uncertain reporting) hold on every case.
    const statusFailures = all.failures.filter(
      (f) => f.kind === "missing_unmodeled" || f.kind === "missing_uncertain",
    );
    expect(statusFailures, JSON.stringify(statusFailures, null, 2)).toEqual([]);
    // Recall and coverage are measured and non-degenerate; they are not acceptance gates.
    expect(all.recall).not.toBeNull();
    expect(all.coverage.sentences_total).toBeGreaterThan(0);
  });
});
