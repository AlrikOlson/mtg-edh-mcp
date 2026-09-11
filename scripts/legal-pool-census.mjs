#!/usr/bin/env node
/**
 * Regenerate the Commander-legal pool census from the served card snapshot and
 * rules store. Offline: it reads the versioned data root only. Never run by
 * npm test or CI; the gated vitest compares the committed files instead.
 *
 *   node scripts/legal-pool-census.mjs [--data-root <dir>] [--out <dir>] [--check]
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
const bundle = path.join(outDir, "legalPoolReport.js");
await build({
  entryPoints: [path.join(root, "src", "evaluation", "legalPoolReport.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["better-sqlite3", "stream-chain", "stream-json"],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  logLevel: "silent",
});
const report = await import(pathToFileURL(bundle).href);
const dataRoot = values["data-root"] ?? (await report.servedDataRoot());
if (!dataRoot) throw new Error("No served data root: pass --data-root or set MCP_DATA_DIR");
const generated = await report.generateLegalPoolReport(dataRoot);
const target = values.out ?? report.LEGAL_POOL_DIRECTORY;
if (values.check) {
  const committed = await report.readLegalPoolReport(target);
  const same =
    JSON.stringify(committed.census) === JSON.stringify(generated.census) &&
    report.encodeLedger(committed.ledger) === report.encodeLedger(generated.ledger);
  if (!same) {
    process.stderr.write("legal-pool census drift: regenerate and review the diff\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("legal-pool census matches the served snapshot\n");
  }
} else {
  const written = await report.writeLegalPoolReport(generated, target);
  const c = generated.census;
  process.stdout.write(
    `Wrote ${written.census} and ${written.ledger}: ${c.snapshot.legal_identities} legal identities, ` +
      `${c.totals.clauses} clauses, ${c.totals.by_status.qualified} qualified / ${c.totals.by_status.owned} owned / ` +
      `${c.totals.by_status.unresolved} unresolved rows.\n`,
  );
}
