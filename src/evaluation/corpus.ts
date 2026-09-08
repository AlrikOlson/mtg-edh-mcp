/** Versioned, project-authored deck requests and independently annotated facts. */
import { readFile } from "node:fs/promises";
import { z } from "zod";

const entrySchema = z.object({ id: z.string(), qty: z.number().int().positive() });
const factSchema = z.object({
  id: z.string(),
  name: z.string(),
  colors: z.array(z.string()),
  maxCopies: z.number().int().positive().nullable(),
  commander: z.boolean(),
  legal: z.boolean(),
  priceCents: z.number().int().nonnegative().nullable(),
  roles: z.array(z.string()),
  scryfallUri: z.string().optional(),
});
const caseSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  tags: z.array(z.string()),
  split: z.enum(["calibration", "holdout"]),
  request: z.enum(["build", "tune", "acquisition"]),
  commanders: z.array(z.string()),
  main: z.array(entrySchema),
  startingMain: z.array(entrySchema),
  companion: z.string().optional(),
  maybeboard: z.array(entrySchema).optional(),
  owned: z.record(z.string(), z.number().int().nonnegative()),
  protected: z.array(z.string()),
  theme: z.array(z.object({ role: z.string(), min: z.number().int().nonnegative() })),
  budgetCents: z.number().int().nonnegative().optional(),
  expectedPair: z.tuple([z.string(), z.string()]).optional(),
  supported: z.boolean(),
});
const corpusSchema = z.object({
  version: z.string(),
  snapshot: z.string(),
  facts: z.record(z.string(), factSchema),
  cases: z.array(caseSchema),
  oracleCards: z.array(z.record(z.string(), z.unknown())),
  sources: z.object({
    oracleSha256: z.string(),
    defaultSha256: z.string(),
    capturedAt: z.string(),
    authorship: z.string(),
    cardData: z.string(),
    permissions: z.array(z.string()),
    pricePolicy: z.string(),
    limitations: z.array(z.string()),
  }),
});

export type BenchmarkEntry = z.infer<typeof entrySchema>;
export type BenchmarkFact = z.infer<typeof factSchema>;
export type BenchmarkCase = z.infer<typeof caseSchema>;
export type BenchmarkCorpus = z.infer<typeof corpusSchema>;

/** No live provider calls: released corpora remain reproducible as upstream data changes. */
export async function loadBenchmarkCorpus(): Promise<BenchmarkCorpus> {
  const raw = await readFile(
    new URL("../../docs/evaluation/deck-quality/corpus-v1.json", import.meta.url),
    "utf8",
  );
  return corpusSchema.parse(JSON.parse(raw));
}
