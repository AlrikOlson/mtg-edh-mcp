import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { loadBenchmarkCorpus } from "./corpus.js";
import { BENCHMARK_ROOT } from "./baseline.js";
import { baselineReceiptSchema, verifyBaselineReceipt } from "./receipt.js";

async function retained() {
  return baselineReceiptSchema.parse(
    JSON.parse(await readFile(new URL("baseline-v1.json", BENCHMARK_ROOT), "utf8")),
  );
}
it("regrades retained observations from independent truth with frozen input provenance", async () => {
  const corpus = await loadBenchmarkCorpus();
  const report = await retained();
  expect(verifyBaselineReceipt(corpus, report)).toEqual([]);
  for (const [file, expected] of [
    ["corpus-v1.json", report.provenance.corpus_sha256],
    ["registration-v1.json", report.provenance.registration_sha256],
  ]) {
    const bytes = await readFile(new URL(file ?? "", BENCHMARK_ROOT));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
  }
  expect(report.cases.flatMap((item) => item.grades).some((grade) => grade.status === "fail")).toBe(
    true,
  );
});
it("rejects deleted hard cases and relabeled budget failures or unsupported capability success", async () => {
  const corpus = await loadBenchmarkCorpus();
  const report = await retained();
  const missing = structuredClone(report);
  missing.cases.pop();
  expect(verifyBaselineReceipt(corpus, missing)).toContain("Case coverage changed");
  for (const target of ["complete-deck-price", "mana-payment-and-package-proof"]) {
    const corrupt = structuredClone(report);
    const grade = corrupt.cases
      .flatMap((item) => item.grades)
      .find((item) => item.check === target && item.status !== "pass");
    if (!grade) throw new Error("Missing seeded corruption target " + target);
    grade.status = "pass";
    expect(verifyBaselineReceipt(corpus, corrupt).length).toBeGreaterThan(0);
  }
});

it("rejects missing cap evidence, forged companion state, wrong deck calls and malformed verdicts", async () => {
  const corpus = await loadBenchmarkCorpus();
  const original = await retained();
  const noCap = structuredClone(original);
  const capped = noCap.cases.find((item) =>
    item.grades.some((grade) => grade.check === "copy-limit-corruption"),
  );
  if (!capped) throw new Error("Missing cap case");
  capped.grades = capped.grades.filter((grade) => grade.check !== "copy-limit-corruption");
  expect(
    verifyBaselineReceipt(corpus, noCap).some((error) => error.includes("Missing copy-limit")),
  ).toBe(true);

  const forged = structuredClone(original);
  const first = forged.cases[0];
  if (!first) throw new Error("Missing case");
  first.artifact.companion = "invented-companion";
  expect(
    verifyBaselineReceipt(corpus, forged).some((error) => error.includes("Artifact not tied")),
  ).toBe(true);

  const wrongDeck = structuredClone(original);
  const get = wrongDeck.cases[0]?.calls.find((call) => call.name === "deck_get");
  if (!get) throw new Error("Missing get");
  get.arguments.deck_id = "another-deck";
  expect(
    verifyBaselineReceipt(corpus, wrongDeck).some((error) => error.includes("wrong deck")),
  ).toBe(true);

  const badVerdict = structuredClone(original);
  const validate = badVerdict.cases[0]?.calls.find((call) => call.name === "validate_deck");
  if (!validate) throw new Error("Missing verdict");
  validate.result = { isError: true, structuredContent: { ok: false } };
  expect(
    verifyBaselineReceipt(corpus, badVerdict).some((error) =>
      error.includes("not a legality verdict"),
    ),
  ).toBe(true);
});
