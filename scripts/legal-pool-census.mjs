#!/usr/bin/env node
/**
 * Update or check the Commander-legal pool evidence from the served card
 * snapshot and rules store. Offline: it reads the versioned data root only.
 * Never run by npm test or CI; the gated vitest compares the committed files.
 *
 *   node scripts/legal-pool-census.mjs [--data-root <dir>] [--out <dir>] [--check]
 *
 * Without --check this is the update step: the committed census and ledger are
 * read as the previous evidence, the census is regenerated over the served
 * snapshot, the two are diffed into requalification-v1.json (invalidated
 * evidence and finite requalification units per pending owner), and the new
 * census, ledger and requalification report are written together. --check
 * regenerates and compares: census and ledger must match byte for byte and
 * the committed requalification's `current` state must match the data root.
 */
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    "data-root": { type: "string" },
    out: { type: "string" },
    check: { type: "boolean", default: false },
  },
});

const outDir = path.join(root, "build", "legal-pool-census");
await mkdir(outDir, { recursive: true });
await build({
  entryPoints: [
    path.join(root, "src", "evaluation", "legalPoolReport.ts"),
    path.join(root, "src", "evaluation", "evidenceFreshness.ts"),
  ],
  outdir: outDir,
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["better-sqlite3", "stream-chain", "stream-json"],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  logLevel: "silent",
});
const report = await import(pathToFileURL(path.join(outDir, "legalPoolReport.js")).href);
const freshness = await import(pathToFileURL(path.join(outDir, "evidenceFreshness.js")).href);
const dataRoot = values["data-root"] ?? (await report.servedDataRoot());
if (!dataRoot) throw new Error("No served data root: pass --data-root or set MCP_DATA_DIR");
const target = values.out ?? report.LEGAL_POOL_DIRECTORY;

if (values.check) {
  const generated = await report.generateLegalPoolReport(dataRoot);
  const committed = await report.readLegalPoolReport(target);
  const same =
    JSON.stringify(committed.census) === JSON.stringify(generated.census) &&
    report.encodeLedger(committed.ledger) === report.encodeLedger(generated.ledger);
  if (!same) {
    process.stderr.write("legal-pool census drift: run the update and review the diff\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("legal-pool census matches the served snapshot\n");
  }
  const requalification = await freshness.readRequalification(target);
  const { state } = await freshness.currentEvidenceState(dataRoot, generated);
  if (!requalification) {
    process.stderr.write("no committed requalification report: run the update\n");
    process.exitCode = 1;
  } else if (JSON.stringify(requalification.current) !== JSON.stringify(state)) {
    process.stderr.write(
      "requalification drift: the committed current evidence state differs from the data root\n",
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `requalification report is current (as of ${requalification.as_of}, status ${requalification.status})\n`,
    );
  }
} else {
  const previousReport = await report.readLegalPoolReport(target);
  const previousState = (await freshness.readRequalification(target))?.current ?? null;
  const run = await freshness.generateRequalification(dataRoot, {
    report: previousReport,
    state: previousState,
  });
  const written = await report.writeLegalPoolReport(run.current, target);
  const requalificationFile = await freshness.writeRequalification(run.report, target);
  const c = run.current.census;
  const r = run.report;
  process.stdout.write(
    `Wrote ${written.census}, ${written.ledger} and ${requalificationFile}.\n` +
      `Census: ${c.snapshot.legal_identities} legal identities, ${c.totals.clauses} clauses, ` +
      `${c.totals.by_status.qualified} qualified / ${c.totals.by_status.owned} owned / ` +
      `${c.totals.by_status.unresolved} unresolved rows.\n` +
      `Requalification (${r.previous.bindings.snapshot.snapshot} → ${r.as_of}): ${r.status}; ` +
      `pool +${r.changes.pool.added.length} -${r.changes.pool.removed.length} ~${r.changes.pool.changed.length}, ` +
      `banned +${r.changes.banned.added.length} -${r.changes.banned.removed.length}, ` +
      `keywords +${r.changes.keywords.added.length} -${r.changes.keywords.removed.length}, ` +
      `rules ${r.changes.rules ? "changed" : "same"}, rulings ${r.changes.rulings ? "changed" : "same"}, ` +
      `engine ${r.changes.engine ? "changed" : "same"}; ${r.invalidated.length} invalidation(s), ` +
      `${r.requalification.length} unit(s).\n`,
  );
  for (const unit of r.requalification)
    process.stdout.write(
      `  - ${unit.kind} → ${unit.owner ?? `new: ${unit.suggested_chunk}`}: ${unit.identities} identities, ${unit.rows} rows${unit.samples.length ? ` (${unit.samples.join(", ")})` : ""}\n`,
    );
  for (const row of r.invalidated)
    process.stdout.write(`  ! ${row.kind} ${row.subject}: ${row.reason}\n`);
}
