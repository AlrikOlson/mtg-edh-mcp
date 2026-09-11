/**
 * Generate and read the committed legal-pool census from the served data root.
 * Reuses the versioned card store, the served index, the rules store and the
 * frozen engine baseline; performs no network access.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VersionedStore } from "../ingest/index.js";
import { openCurrentSnapshot } from "../index/refresh.js";
import { RulesStore, openCurrentRules } from "../rules/index.js";
import { loadEngineBaseline } from "./engineBaseline.js";
import {
  censusLegalPool,
  loadKeywordVocabulary,
  type LedgerRow,
  type LegalPoolCensus,
} from "./legalPool.js";

export const LEGAL_POOL_DIRECTORY = fileURLToPath(
  new URL("../../docs/evaluation/engine-any/", import.meta.url),
);
export const LEGAL_POOL_CENSUS_FILE = "census-v1.json";
export const LEGAL_POOL_LEDGER_FILE = "pool-ledger-v1.jsonl";
const ENGINE_SOURCE_PIN = new URL("../../engine/source.json", import.meta.url);

export interface LegalPoolReport {
  readonly census: LegalPoolCensus;
  readonly ledger: readonly LedgerRow[];
}

/** The served data root when one is configured or installed locally; null otherwise. */
export async function servedDataRoot(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const candidates = [
    env.MCP_DATA_DIR,
    env.HOME ? join(env.HOME, ".mtg-edh-mcp", "cards") : undefined,
  ];
  for (const root of candidates) {
    if (!root) continue;
    try {
      await access(join(root, "current.json"));
      return root;
    } catch {
      /* Try the next candidate. */
    }
  }
  return null;
}

/** Run the census against the served snapshot and rules of a data root. */
export async function generateLegalPoolReport(dataRoot: string): Promise<LegalPoolReport> {
  const store = new VersionedStore(dataRoot);
  const snapshot = await openCurrentSnapshot(store);
  if (!snapshot) throw new Error(`No served card snapshot under ${dataRoot}`);
  try {
    const manifest = await store.readManifest(snapshot.version);
    if (!manifest) throw new Error(`Snapshot ${snapshot.version} has no manifest`);
    const rules = await openCurrentRules(new RulesStore(dataRoot));
    const [vocabulary, baseline, pin] = await Promise.all([
      loadKeywordVocabulary(),
      loadEngineBaseline(),
      readFile(ENGINE_SOURCE_PIN, "utf8"),
    ]);
    const engineRevision = (JSON.parse(pin) as { revision: string }).revision;
    return censusLegalPool({
      index: snapshot.index,
      snapshot: { version: snapshot.version, snapshot: snapshot.snapshot, files: manifest.files },
      rules: rules?.manifest ?? null,
      vocabulary,
      baseline: { version: baseline.version, records: baseline.records },
      engineRevision,
    });
  } finally {
    snapshot.index.close();
  }
}

/** One compact JSON array per line: [oracle_id, name, source_digest]. */
export function encodeLedger(ledger: readonly LedgerRow[]): string {
  return (
    ledger.map((row) => JSON.stringify([row.oracle_id, row.name, row.source_digest])).join("\n") +
    "\n"
  );
}

export function decodeLedger(text: string): LedgerRow[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [oracle_id, name, source_digest] = JSON.parse(line) as [string, string, string];
      return { oracle_id, name, source_digest };
    });
}

/** Write the census summary and identity ledger; returns the written paths. */
export async function writeLegalPoolReport(
  report: LegalPoolReport,
  directory: string = LEGAL_POOL_DIRECTORY,
): Promise<{ census: string; ledger: string }> {
  await mkdir(directory, { recursive: true });
  const census = join(directory, LEGAL_POOL_CENSUS_FILE);
  const ledger = join(directory, LEGAL_POOL_LEDGER_FILE);
  await writeFile(census, JSON.stringify(report.census, null, 2) + "\n", "utf8");
  await writeFile(ledger, encodeLedger(report.ledger), "utf8");
  return { census, ledger };
}

/** Read the committed report back; the census is parsed, the ledger decoded line by line. */
export async function readLegalPoolReport(
  directory: string = LEGAL_POOL_DIRECTORY,
): Promise<LegalPoolReport> {
  const [census, ledger] = await Promise.all([
    readFile(join(directory, LEGAL_POOL_CENSUS_FILE), "utf8"),
    readFile(join(directory, LEGAL_POOL_LEDGER_FILE), "utf8"),
  ]);
  return { census: JSON.parse(census) as LegalPoolCensus, ledger: decodeLedger(ledger) };
}
