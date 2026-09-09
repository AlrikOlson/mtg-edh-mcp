/**
 * Independently annotated mechanics corpus and its scorer.
 *
 * Cases carry authored Oracle-style text plus expected assertions written from
 * a reading of the text, not from extractor output. `calibration` cases may
 * inform extractor changes; `holdout` cases are protected by a pinned digest so
 * any edit is visible in review. Precision is the acceptance metric; recall and
 * coverage are reported separately and are not gated.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { extractMechanics } from "../analyze/mechanics.js";
import { mapScryfallCard, type ScryfallCardRaw } from "../index/map.js";
import type { CardMechanics, MechanicAnnotation } from "../types/index.js";

const SUBJECTS = [
  "controller",
  "opponent",
  "each_player",
  "target_player",
  "any_player",
  "self",
  "unknown",
] as const;

const assertionSchema = z.object({
  pattern: z.string().regex(/^(?:trigger|cost|effect|permission)\.[a-z_]+$/),
  subject: z.enum(SUBJECTS).optional(),
  condition: z.enum(["conditional", "unconditional"]).optional(),
  face: z.number().int().nonnegative().nullable().optional(),
});
const faceSchema = z.object({
  name: z.string(),
  type_line: z.string(),
  oracle_text: z.string(),
  mana_cost: z.string().optional(),
});
const caseSchema = z.object({
  id: z.string(),
  split: z.enum(["calibration", "holdout"]),
  name: z.string(),
  type_line: z.string().optional(),
  oracle_text: z.string().optional(),
  keywords: z.array(z.string()).default([]),
  card_faces: z.array(faceSchema).optional(),
  /** Assertions the extractor must produce. */
  expect: z.array(assertionSchema),
  /** Assertions that count as false positives wherever they appear. */
  reject: z.array(assertionSchema).default([]),
  /** When true, every produced supported annotation must match an expected assertion. */
  complete: z.boolean(),
  expect_unmodeled: z.boolean().default(false),
  expect_uncertain: z.boolean().default(false),
  notes: z.string().optional(),
});
const corpusSchema = z.object({
  version: z.string(),
  subject_conventions: z.record(z.string(), z.string()),
  sources: z.object({
    authorship: z.string(),
    text_provenance: z.string(),
    annotation_protocol: z.string(),
    holdout_policy: z.string(),
    limitations: z.array(z.string()),
  }),
  cases: z.array(caseSchema),
});

export type MechanicsAssertion = z.infer<typeof assertionSchema>;
export type MechanicsCase = z.infer<typeof caseSchema>;
export type MechanicsCorpus = z.infer<typeof corpusSchema>;

export const MECHANICS_CORPUS_PATH = new URL(
  "../../docs/evaluation/mechanics/cases-v1.json",
  import.meta.url,
);

export async function loadMechanicsCorpus(): Promise<MechanicsCorpus> {
  const raw = await readFile(MECHANICS_CORPUS_PATH, "utf8");
  const corpus = corpusSchema.parse(JSON.parse(raw));
  const ids = new Set<string>();
  for (const c of corpus.cases) {
    if (ids.has(c.id)) throw new Error(`duplicate mechanics case id '${c.id}'`);
    ids.add(c.id);
  }
  return corpus;
}

/** Digest of the holdout cases; the test pins it so tuning edits to holdout are visible. */
export function holdoutDigest(corpus: MechanicsCorpus): string {
  const holdout = corpus.cases
    .filter((c) => c.split === "holdout")
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify(holdout)).digest("hex");
}

/** Build the same Card the index would store, so faces and evidence match production. */
export function caseCard(c: MechanicsCase): ReturnType<typeof mapScryfallCard> {
  const raw: ScryfallCardRaw = {
    oracle_id: `o-${c.id}`,
    id: `p-${c.id}`,
    name: c.name,
    layout: c.card_faces ? "modal_dfc" : "normal",
    legalities: { commander: "legal" },
    color_identity: [],
    colors: [],
    keywords: c.keywords,
    ...(c.card_faces ? { card_faces: c.card_faces } : {}),
    ...(c.type_line !== undefined ? { type_line: c.type_line } : {}),
    ...(c.oracle_text !== undefined ? { oracle_text: c.oracle_text } : {}),
  };
  return mapScryfallCard(raw);
}

function matches(assertion: MechanicsAssertion, a: MechanicAnnotation): boolean {
  if (assertion.pattern !== a.pattern_id) return false;
  if (assertion.subject !== undefined && assertion.subject !== a.subject) return false;
  if (assertion.condition !== undefined && assertion.condition !== a.condition.kind) return false;
  if (assertion.face !== undefined && assertion.face !== a.face_index) return false;
  return true;
}

export interface MechanicsFailure {
  case_id: string;
  split: MechanicsCase["split"];
  kind: "false_positive" | "missed" | "missing_unmodeled" | "missing_uncertain";
  detail: string;
}

export interface MechanicsSplitScore {
  split: "calibration" | "holdout" | "all";
  cases: number;
  expected: number;
  produced: number;
  true_positives: number;
  false_positives: number;
  missed: number;
  /** TP / (TP + FP); null when nothing was produced. */
  precision: number | null;
  /** TP over expected assertions; null when nothing was expected. */
  recall: number | null;
  coverage: {
    abilities_total: number;
    abilities_with_support: number;
    abilities_fully_modeled: number;
    sentences_total: number;
    sentences_supported: number;
    sentences_unmodeled: number;
    sentences_uncertain: number;
    cards_fully_modeled: number;
  };
  failures: MechanicsFailure[];
}

export interface MechanicsScoreReport {
  extractor_version: string;
  corpus_version: string;
  holdout_digest: string;
  splits: Record<"calibration" | "holdout" | "all", MechanicsSplitScore>;
}

function emptyScore(split: MechanicsSplitScore["split"]): MechanicsSplitScore {
  return {
    split,
    cases: 0,
    expected: 0,
    produced: 0,
    true_positives: 0,
    false_positives: 0,
    missed: 0,
    precision: null,
    recall: null,
    coverage: {
      abilities_total: 0,
      abilities_with_support: 0,
      abilities_fully_modeled: 0,
      sentences_total: 0,
      sentences_supported: 0,
      sentences_unmodeled: 0,
      sentences_uncertain: 0,
      cards_fully_modeled: 0,
    },
    failures: [],
  };
}

function describe(a: MechanicAnnotation): string {
  return `${a.pattern_id}|${a.subject}|${a.condition.kind}|face ${a.face_index ?? "root"}: "${a.evidence.text}"`;
}

/** Score one case against its independent annotations. */
export function scoreCase(
  c: MechanicsCase,
  report: CardMechanics,
): Pick<
  MechanicsSplitScore,
  "expected" | "produced" | "true_positives" | "false_positives" | "missed" | "failures"
> {
  const failures: MechanicsFailure[] = [];
  const produced = report.annotations;
  let tp = 0;
  let fp = 0;
  for (const a of produced) {
    const rejected = c.reject.some((r) => matches(r, a));
    const expected = c.expect.some((e) => matches(e, a));
    if (rejected || (c.complete && !expected)) {
      fp += 1;
      failures.push({
        case_id: c.id,
        split: c.split,
        kind: "false_positive",
        detail: `${rejected ? "rejected" : "unexpected"} ${describe(a)}`,
      });
    } else if (expected) {
      tp += 1;
    }
  }
  let missed = 0;
  for (const e of c.expect) {
    if (!produced.some((a) => matches(e, a))) {
      missed += 1;
      failures.push({
        case_id: c.id,
        split: c.split,
        kind: "missed",
        detail: `${e.pattern}|${e.subject ?? "*"}|${e.condition ?? "*"}`,
      });
    }
  }
  if (c.expect_unmodeled && !report.unmodeled.some((u) => u.status === "unmodeled")) {
    failures.push({
      case_id: c.id,
      split: c.split,
      kind: "missing_unmodeled",
      detail: "expected at least one unmodeled span",
    });
  }
  if (c.expect_uncertain && !report.unmodeled.some((u) => u.status === "uncertain")) {
    failures.push({
      case_id: c.id,
      split: c.split,
      kind: "missing_uncertain",
      detail: "expected at least one uncertain span",
    });
  }
  return {
    expected: c.expect.length,
    produced: produced.length,
    true_positives: tp,
    false_positives: fp,
    missed,
    failures,
  };
}

export function scoreMechanicsCorpus(corpus: MechanicsCorpus): MechanicsScoreReport {
  const splits = {
    calibration: emptyScore("calibration"),
    holdout: emptyScore("holdout"),
    all: emptyScore("all"),
  };
  let extractorVersion = "";
  for (const c of corpus.cases) {
    const report = extractMechanics(caseCard(c));
    extractorVersion = report.extractor_version;
    const s = scoreCase(c, report);
    for (const target of [splits[c.split], splits.all]) {
      target.cases += 1;
      target.expected += s.expected;
      target.produced += s.produced;
      target.true_positives += s.true_positives;
      target.false_positives += s.false_positives;
      target.missed += s.missed;
      target.failures.push(...s.failures);
      const cov = target.coverage;
      cov.abilities_total += report.coverage.abilities_total;
      cov.abilities_with_support += report.coverage.abilities_with_support;
      cov.abilities_fully_modeled += report.coverage.abilities_fully_modeled;
      cov.sentences_total += report.coverage.sentences_total;
      cov.sentences_supported += report.coverage.sentences_supported;
      cov.sentences_unmodeled += report.coverage.sentences_unmodeled;
      cov.sentences_uncertain += report.coverage.sentences_uncertain;
      if (report.unmodeled.length === 0 && report.coverage.abilities_total > 0) {
        cov.cards_fully_modeled += 1;
      }
    }
  }
  for (const s of Object.values(splits)) {
    const denominator = s.true_positives + s.false_positives;
    s.precision = denominator === 0 ? null : s.true_positives / denominator;
    s.recall = s.expected === 0 ? null : (s.expected - s.missed) / s.expected;
  }
  return {
    extractor_version: extractorVersion,
    corpus_version: corpus.version,
    holdout_digest: holdoutDigest(corpus),
    splits,
  };
}
