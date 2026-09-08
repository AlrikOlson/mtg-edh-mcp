import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadBenchmarkCorpus } from "./corpus.js";
import { BENCHMARK_ROOT, benchmarkProvenance, runDeckQualityBaseline } from "./baseline.js";

afterEach(() => vi.unstubAllGlobals());

it("records real isolated MCP outcomes for every frozen case without network or model-success claims", async () => {
  const network = vi.fn(() => {
    throw new Error("Benchmark replay must be offline");
  });
  vi.stubGlobal("fetch", network);
  const corpus = await loadBenchmarkCorpus();
  const report = await runDeckQualityBaseline(corpus);
  expect(report.cases.map((entry) => entry.id)).toEqual(corpus.cases.map((entry) => entry.id));
  expect(report.mode).toBe("scripted_mcp");
  expect(report.model).toBeNull();
  expect(report.cases.every((entry) => entry.calls.length > 0)).toBe(true);
  expect(report.cases.filter((entry) => entry.error)).toEqual([]);
  expect(
    report.cases.every((entry) =>
      entry.grades.some((grade) => grade.check === "complete-deck-price"),
    ),
  ).toBe(true);
  expect(network).not.toHaveBeenCalled();
  if (process.env.DECK_QUALITY_BASELINE_OUT) {
    const provenance = await benchmarkProvenance();
    const outcomes: Record<string, Record<string, number>> = {};
    for (const grade of report.cases.flatMap((item) => item.grades)) {
      const row = (outcomes[grade.check] ??= {});
      row[grade.status] = (row[grade.status] ?? 0) + 1;
    }
    console.info(
      JSON.stringify({
        cases: report.cases.length,
        calls: report.cases.reduce((sum, item) => sum + item.calls.length, 0),
        outcomes,
      }),
    );
    expect(provenance.production_diff).toBe("");
    await writeFile(
      resolve(process.env.DECK_QUALITY_BASELINE_OUT),
      JSON.stringify({ ...report, captured_at: new Date().toISOString(), provenance }, null, 2) +
        "\n",
      { flag: "wx" },
    );
  } else {
    // Observational failures are retained separately from test failures; future features may improve.
    const retained = JSON.parse(
      await readFile(new URL("baseline-v1.json", BENCHMARK_ROOT), "utf8"),
    );
    expect(report.cases.map((entry) => entry.id)).toEqual(
      retained.cases.map((entry: { id: string }) => entry.id),
    );
  }
}, 120_000);
