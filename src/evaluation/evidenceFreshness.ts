/**
 * Evidence freshness and requalification (evaluation owner).
 *
 * The census freezes what the any-deck denominator looked like when it was
 * generated; this module is the update → diff → invalidation → requalification
 * step that runs when any bound source moves: the served Oracle snapshot, the
 * published Comprehensive Rules release, the rulings export, the frozen
 * keyword vocabulary, the engine source pin, the frozen MVP baseline, the
 * rules-audit excerpt, the construction authority's named card dependencies
 * or the Game Changers policy list. It produces a dated report whose finite
 * requalification units are filed as pending roadmap work by the maintainer.
 * Nothing here executes rules, qualifies a card or authorizes admission.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CardIndex } from "../index/cardIndex.js";
import { openCurrentSnapshot } from "../index/refresh.js";
import { VersionedStore } from "../ingest/index.js";
import { anyNumberAllowlistNames, copyLimit } from "../validate/coreRules.js";
import { companionRuleCoverage, modeledCompanionNames } from "../validate/companionRules.js";
import {
  censusCard,
  indexVocabulary,
  loadKeywordVocabulary,
  ownersOfFamilies,
  type KeywordVocabulary,
  type LedgerRow,
  type LegalPoolCensus,
  type VocabularyIndex,
} from "./legalPool.js";
import { keywordBatchIndex } from "./legalPoolOwnership.js";
import {
  LEGAL_POOL_DIRECTORY,
  generateLegalPoolReport,
  type LegalPoolReport,
} from "./legalPoolReport.js";
import { digestEvaluation } from "./registration.js";
import { loadRulesExcerpt } from "./rulesAudit.js";

export const REQUALIFICATION_VERSION = "evidence-requalification-v1";
export const REQUALIFICATION_FILE = "requalification-v1.json";

// --- Evidence state ---------------------------------------------------------------

export interface Identity {
  readonly oracle_id: string;
  readonly name: string;
}

/** Everything a committed census binds, reduced to the fields a diff compares. */
export interface EvidenceBindings {
  readonly census_version: string;
  readonly snapshot: {
    readonly version: string;
    readonly snapshot: string;
    readonly index_revision: string;
    readonly legal_identities: number;
    readonly banned_identities: number;
  };
  readonly rules: {
    readonly version: string;
    readonly url: string;
    readonly sha256: string;
    readonly effective_date: string | null;
    readonly published_version: string | null;
  } | null;
  readonly rulings: {
    readonly updated_at: string;
    readonly sha256: string;
    readonly ruling_count: number;
  } | null;
  readonly vocabulary: {
    readonly version: string;
    readonly digests: Readonly<Record<string, string>>;
  };
  readonly engine_revision: string;
  readonly ledger_digest: string;
  readonly banned_digest: string;
  readonly qualified_evidence: readonly {
    readonly oracle_id: string;
    readonly name: string;
    readonly requirement: string;
    readonly engine_revision: string;
  }[];
  readonly baseline: {
    readonly version: string;
    readonly identities: number;
    readonly changed: number;
    readonly absent: number;
  };
  /** Keyword labels seen on legal cards (listed and unlisted), sorted. */
  readonly keyword_labels: readonly string[];
}

export type ConstructionAuthority = "companion" | "copy_exception";

/** A card the construction authority names or reads a bounded grant from, frozen by digest. */
export interface ConstructionDependency {
  readonly authority: ConstructionAuthority;
  readonly name: string;
  readonly oracle_id: string | null;
  readonly source_digest: string | null;
  /** companionRuleCoverage for companions; the parsed cap for copy exceptions. */
  readonly detail: string;
}

export interface EvidenceState {
  readonly bindings: EvidenceBindings;
  readonly construction: {
    readonly dependencies: readonly ConstructionDependency[];
    readonly digest: string;
  };
  /** Game Changers membership carried by the snapshot; null when the index stores no flags. */
  readonly policy: { readonly game_changers: number; readonly digest: string } | null;
  readonly rules_audit: {
    readonly excerpt_sha256: string;
    readonly corpus_sha256: string;
    readonly effective_date: string;
  };
}

export function bindingsOf(report: LegalPoolReport): EvidenceBindings {
  const census = report.census;
  const labels = [
    ...census.keywords.listed.map((row) => row.keyword),
    ...census.keywords.unlisted.map((row) => row.keyword),
  ].sort();
  return {
    census_version: census.version,
    snapshot: {
      version: census.snapshot.version,
      snapshot: census.snapshot.snapshot,
      index_revision: census.snapshot.index_revision,
      legal_identities: census.snapshot.legal_identities,
      banned_identities: census.snapshot.banned_identities,
    },
    rules: census.rules
      ? {
          version: census.rules.version,
          url: census.rules.comprehensive_rules.url,
          sha256: census.rules.comprehensive_rules.sha256,
          effective_date: census.rules.comprehensive_rules.effective_date,
          published_version: census.rules.comprehensive_rules.published_version,
        }
      : null,
    rulings: census.rules
      ? {
          updated_at: census.rules.rulings.updated_at,
          sha256: census.rules.rulings.sha256,
          ruling_count: census.rules.rulings.ruling_count,
        }
      : null,
    vocabulary: { version: census.vocabulary.version, digests: census.vocabulary.digests },
    engine_revision: census.engine_revision,
    ledger_digest: census.ledger.digest,
    banned_digest: census.banned_digest,
    qualified_evidence: census.qualified_evidence.map((row) => ({
      oracle_id: row.oracle_id,
      name: row.name,
      requirement: row.requirement,
      engine_revision: row.engine_revision,
    })),
    baseline: {
      version: census.baseline.version,
      identities: census.baseline.identities,
      changed: census.baseline.changed.length,
      absent: census.baseline.absent.length,
    },
    keyword_labels: labels,
  };
}

/**
 * The construction authority's card dependencies as the served index stores
 * them: the modeled companions, the unlimited allowlist and every legal card
 * carrying a bounded copy grant. A changed digest means the authority's
 * assumption about that card must be re-read against the new text.
 */
export function constructionDependencies(index: CardIndex): ConstructionDependency[] {
  const rows: ConstructionDependency[] = [];
  const named = new Map<string, ConstructionAuthority>();
  for (const name of modeledCompanionNames()) named.set(name, "companion");
  for (const name of anyNumberAllowlistNames()) named.set(name, "copy_exception");
  const seen = new Set<string>();
  index.withRead(() => {
    for (const [name, authority] of named) {
      const card = index
        .resolveName(name, { exact: true })
        .map((ref) => index.getCard(ref.oracle_id))
        .find((candidate) => candidate?.name === name);
      if (!card) {
        rows.push({ authority, name, oracle_id: null, source_digest: null, detail: "absent" });
        continue;
      }
      seen.add(card.oracle_id);
      rows.push({
        authority,
        name,
        oracle_id: card.oracle_id,
        source_digest: card.gameplay ? digestEvaluation(card.gameplay) : null,
        detail:
          authority === "companion"
            ? companionRuleCoverage(card)
            : `max ${String(copyLimit(card).max)} (${copyLimit(card).reason})`,
      });
    }
    index.forEachCommanderLegality("legal", (card) => {
      if (seen.has(card.oracle_id)) return;
      const limit = copyLimit(card);
      if (limit.reason !== "bounded_text") return;
      seen.add(card.oracle_id);
      rows.push({
        authority: "copy_exception",
        name: card.name,
        oracle_id: card.oracle_id,
        source_digest: card.gameplay ? digestEvaluation(card.gameplay) : null,
        detail: `max ${String(limit.max)} (bounded_text)`,
      });
    });
  });
  return rows.sort((a, b) =>
    a.authority < b.authority ? -1 : a.authority > b.authority ? 1 : a.name < b.name ? -1 : 1,
  );
}

export function policyState(index: CardIndex): EvidenceState["policy"] {
  const names = index.gameChangerNames();
  if (!names) return null;
  const sorted = [...names].sort();
  return { game_changers: sorted.length, digest: digestEvaluation(sorted) };
}

/** Assemble the current evidence state from a generated report and the served index. */
export async function evidenceState(
  report: LegalPoolReport,
  index: CardIndex,
): Promise<EvidenceState> {
  const excerpt = await loadRulesExcerpt();
  const dependencies = constructionDependencies(index);
  return {
    bindings: bindingsOf(report),
    construction: { dependencies, digest: digestEvaluation(dependencies) },
    policy: policyState(index),
    rules_audit: {
      excerpt_sha256: excerpt.digest,
      corpus_sha256: excerpt.excerpt.corpus.sha256,
      effective_date: excerpt.excerpt.corpus.effective_date,
    },
  };
}

// --- Diff ---------------------------------------------------------------------------

export interface ChangedIdentity extends Identity {
  readonly previous: string;
  readonly current: string;
}

export type InvalidationKind =
  | "qualified_evidence"
  | "engine_revision"
  | "rules_audit_excerpt"
  | "construction_dependency"
  | "baseline_corpus";

export interface Invalidation {
  readonly kind: InvalidationKind;
  readonly subject: string;
  readonly reason: string;
  /** Owner chunks (pending work) or evaluation owners responsible for requalifying. */
  readonly owners: readonly string[];
}

export type UnitKind =
  | "pool_identities"
  | "qualified_evidence"
  | "rules_release"
  | "rulings_export"
  | "vocabulary"
  | "engine_revision"
  | "construction_dependency"
  | "policy_membership"
  | "baseline_corpus";

/** One finite requalification obligation to file as pending roadmap work. */
export interface RequalificationUnit {
  readonly kind: UnitKind;
  /** Existing pending chunk that absorbs the work, or null when a new chunk must be filed. */
  readonly owner: string | null;
  readonly suggested_chunk: string;
  readonly identities: number;
  readonly rows: number;
  readonly samples: readonly string[];
  readonly detail: string;
}

export interface RequalificationReport {
  readonly version: typeof REQUALIFICATION_VERSION;
  /** The current snapshot's data date; deterministic for a fixed input pair. */
  readonly as_of: string;
  readonly status: "current" | "requalification_required";
  readonly previous: {
    readonly bindings: EvidenceBindings;
    readonly construction: EvidenceState["construction"] | null;
    readonly policy: EvidenceState["policy"] | null;
    readonly rules_audit: EvidenceState["rules_audit"] | null;
  };
  readonly current: EvidenceState;
  readonly changes: {
    readonly snapshot: boolean;
    readonly rules: boolean;
    readonly rulings: boolean;
    readonly vocabulary: boolean;
    readonly engine: boolean;
    readonly pool: {
      readonly added: readonly Identity[];
      readonly removed: readonly Identity[];
      readonly changed: readonly ChangedIdentity[];
      readonly unchanged: number;
    };
    readonly banned: { readonly added: readonly Identity[]; readonly removed: readonly Identity[] };
    readonly keywords: { readonly added: readonly string[]; readonly removed: readonly string[] };
    readonly construction: {
      readonly added: readonly ConstructionDependency[];
      readonly removed: readonly ConstructionDependency[];
      readonly changed: readonly (ConstructionDependency & {
        readonly previous_digest: string | null;
      })[];
    } | null;
    readonly policy: { readonly changed: boolean } | null;
  };
  readonly invalidated: readonly Invalidation[];
  readonly requalification: readonly RequalificationUnit[];
  readonly limitations: readonly string[];
}

export const REQUALIFICATION_LIMITATIONS: readonly string[] = [
  "Identity-level pool changes compare exact-source digests of the canonical gameplay record; the previous ledger is the committed file before this update (its digest is recorded), reproducible from repository history.",
  "Requalification units name pending owners for planning; filing them in the native roadmap is a maintainer step, and only the canonical Rust support report ever qualifies a row.",
  "Commander eligibility and companion conditions change only through the card record (covered by the source digest) or the rules release (covered by the rules binding); no separate eligibility ledger exists.",
  "Game Changers membership is compared as a digest of the snapshot's flagged names; provenance dates for the list are not published by the source.",
];

function identityDiff(previous: readonly LedgerRow[], current: readonly LedgerRow[]) {
  const before = new Map(previous.map((row) => [row.oracle_id, row]));
  const after = new Map(current.map((row) => [row.oracle_id, row]));
  const added: Identity[] = [];
  const changed: ChangedIdentity[] = [];
  let unchanged = 0;
  for (const row of current) {
    const old = before.get(row.oracle_id);
    if (!old) added.push({ oracle_id: row.oracle_id, name: row.name });
    else if (old.source_digest !== row.source_digest)
      changed.push({
        oracle_id: row.oracle_id,
        name: row.name,
        previous: old.source_digest,
        current: row.source_digest,
      });
    else unchanged += 1;
  }
  const removed: Identity[] = previous
    .filter((row) => !after.has(row.oracle_id))
    .map((row) => ({ oracle_id: row.oracle_id, name: row.name }));
  return { added, removed, changed, unchanged };
}

function setDiff<T extends string>(previous: readonly T[], current: readonly T[]) {
  const before = new Set(previous);
  const after = new Set(current);
  return {
    added: current.filter((item) => !before.has(item)),
    removed: previous.filter((item) => !after.has(item)),
  };
}

function bannedDiff(previous: LegalPoolCensus, current: LegalPoolCensus) {
  const before = new Map(previous.banned.map((row) => [row.oracle_id, row]));
  const after = new Map(current.banned.map((row) => [row.oracle_id, row]));
  return {
    added: current.banned.filter((row) => !before.has(row.oracle_id)),
    removed: previous.banned.filter((row) => !after.has(row.oracle_id)),
  };
}

/** Owner attribution for changed identities: census rows grouped by pending owner chunk. */
export interface OwnerAttribution {
  readonly owner: string;
  readonly identities: number;
  readonly rows: number;
  readonly samples: readonly string[];
}

export function attributeOwners(
  identities: readonly Identity[],
  index: CardIndex,
  vocabulary: VocabularyIndex,
): OwnerAttribution[] {
  const batches = keywordBatchIndex();
  const perOwner = new Map<string, { identities: Set<string>; rows: number; samples: string[] }>();
  index.withRead(() => {
    for (const identity of identities) {
      const card = index.getCard(identity.oracle_id);
      if (!card) continue;
      const census = censusCard(card, vocabulary, batches);
      for (const row of census.rows) {
        if (!row.counted) continue;
        const owners =
          row.status === "qualified" ? ownersOfFamilies(row.families, batches) : row.owners;
        for (const owner of owners) {
          const entry = perOwner.get(owner) ?? { identities: new Set(), rows: 0, samples: [] };
          entry.rows += 1;
          if (!entry.identities.has(identity.oracle_id)) {
            entry.identities.add(identity.oracle_id);
            if (entry.samples.length < 5) entry.samples.push(identity.name);
          }
          perOwner.set(owner, entry);
        }
      }
    }
  });
  return [...perOwner.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([owner, entry]) => ({
      owner,
      identities: entry.identities.size,
      rows: entry.rows,
      samples: entry.samples,
    }));
}

export interface DiffInput {
  readonly previous: {
    readonly report: LegalPoolReport;
    /** The `current` state of the previously committed requalification, if any. */
    readonly state: EvidenceState | null;
  };
  readonly current: { readonly report: LegalPoolReport; readonly state: EvidenceState };
  /** Owner attribution for added and changed identities (needs the served index). */
  readonly attribution: readonly OwnerAttribution[];
}

/** Pure diff over two evidence states; deterministic for fixed inputs. */
export function diffEvidence(input: DiffInput): RequalificationReport {
  const previous = bindingsOf(input.previous.report);
  const current = input.current.state;
  const now = current.bindings;
  const pool = identityDiff(input.previous.report.ledger, input.current.report.ledger);
  const banned = bannedDiff(input.previous.report.census, input.current.report.census);
  const keywords = setDiff(previous.keyword_labels, now.keyword_labels);
  const rulesChanged = (previous.rules?.sha256 ?? null) !== (now.rules?.sha256 ?? null);
  const rulingsChanged =
    (previous.rulings?.updated_at ?? null) !== (now.rulings?.updated_at ?? null) ||
    (previous.rulings?.sha256 ?? null) !== (now.rulings?.sha256 ?? null);
  const vocabularyChanged =
    JSON.stringify(previous.vocabulary.digests) !== JSON.stringify(now.vocabulary.digests);
  const engineChanged = previous.engine_revision !== now.engine_revision;
  const snapshotChanged = previous.snapshot.version !== now.snapshot.version;

  const previousState = input.previous.state;
  let construction: RequalificationReport["changes"]["construction"] = null;
  if (previousState) {
    const before = new Map(
      previousState.construction.dependencies.map((row) => [`${row.authority}:${row.name}`, row]),
    );
    const after = new Map(
      current.construction.dependencies.map((row) => [`${row.authority}:${row.name}`, row]),
    );
    construction = {
      added: current.construction.dependencies.filter(
        (row) => !before.has(`${row.authority}:${row.name}`),
      ),
      removed: previousState.construction.dependencies.filter(
        (row) => !after.has(`${row.authority}:${row.name}`),
      ),
      changed: current.construction.dependencies.flatMap((row) => {
        const old = before.get(`${row.authority}:${row.name}`);
        return old && (old.source_digest !== row.source_digest || old.detail !== row.detail)
          ? [{ ...row, previous_digest: old.source_digest }]
          : [];
      }),
    };
  }
  const policy =
    previousState?.policy && current.policy
      ? { changed: previousState.policy.digest !== current.policy.digest }
      : null;

  const changedIds = new Map(pool.changed.map((row) => [row.oracle_id, row]));
  const removedIds = new Set(pool.removed.map((row) => row.oracle_id));
  const batches = keywordBatchIndex();
  const invalidated: Invalidation[] = [];
  const evidenceOwners = ownersOfFamilies(["intrinsic:basic_mana"], batches);
  for (const row of now.qualified_evidence) {
    const subject = `${row.name} ${row.requirement}`;
    if (engineChanged || row.engine_revision !== now.engine_revision)
      invalidated.push({
        kind: "engine_revision",
        subject,
        reason: `evidence pinned to engine ${row.engine_revision.slice(0, 8)}; pin is now ${now.engine_revision.slice(0, 8)}`,
        owners: evidenceOwners,
      });
    else if (removedIds.has(row.oracle_id))
      invalidated.push({
        kind: "qualified_evidence",
        subject,
        reason: "identity left the legal pool",
        owners: evidenceOwners,
      });
    else if (changedIds.has(row.oracle_id))
      invalidated.push({
        kind: "qualified_evidence",
        subject,
        reason: `source digest changed ${changedIds.get(row.oracle_id)!.previous.slice(0, 8)} → ${changedIds.get(row.oracle_id)!.current.slice(0, 8)}`,
        owners: evidenceOwners,
      });
  }
  if (now.rules && current.rules_audit.corpus_sha256 !== now.rules.sha256)
    invalidated.push({
      kind: "rules_audit_excerpt",
      subject: `docs/evaluation/rules excerpt (release ${current.rules_audit.effective_date})`,
      reason: `excerpt was cut from release ${current.rules_audit.corpus_sha256.slice(0, 8)}; published corpus is ${now.rules.sha256.slice(0, 8)} (effective ${now.rules.effective_date ?? "unknown"})`,
      owners: ["src/evaluation/rulesAudit.ts"],
    });
  for (const row of construction?.changed ?? [])
    invalidated.push({
      kind: "construction_dependency",
      subject: `${row.authority} ${row.name}`,
      reason: `record changed (${row.previous_digest?.slice(0, 8) ?? "absent"} → ${row.source_digest?.slice(0, 8) ?? "absent"}); re-read the authority's assumption`,
      owners: [
        row.authority === "companion"
          ? "src/validate/companionRules.ts"
          : "src/validate/coreRules.ts",
      ],
    });
  if (now.baseline.changed > 0 || now.baseline.absent > 0)
    invalidated.push({
      kind: "baseline_corpus",
      subject: `${now.baseline.version} (${now.baseline.identities} identities)`,
      reason: `${now.baseline.changed} changed, ${now.baseline.absent} absent against the current pool`,
      owners: ["engine-mvp-corpus"],
    });

  const units: RequalificationUnit[] = [];
  const date = now.snapshot.snapshot;
  for (const owner of input.attribution)
    units.push({
      kind: "pool_identities",
      owner: owner.owner,
      suggested_chunk: owner.owner,
      identities: owner.identities,
      rows: owner.rows,
      samples: owner.samples,
      detail: `${owner.identities} added or changed legal identities contribute ${owner.rows} counted rows to this pending owner`,
    });
  const qualifiedHits = invalidated.filter(
    (row) => row.kind === "qualified_evidence" || row.kind === "engine_revision",
  );
  if (qualifiedHits.length > 0)
    units.push({
      kind: engineChanged ? "engine_revision" : "qualified_evidence",
      owner: null,
      suggested_chunk: `requalify-evidence-${date}`,
      identities: new Set(qualifiedHits.map((row) => row.subject.split(" ")[0])).size,
      rows: qualifiedHits.length,
      samples: qualifiedHits.slice(0, 5).map((row) => row.subject),
      detail: engineChanged
        ? "engine source pin moved; every qualified row must be re-run against the new revision"
        : "qualified identities changed or left the pool; re-run their conformance evidence",
    });
  if (rulesChanged)
    units.push({
      kind: "rules_release",
      owner: null,
      suggested_chunk: `requalify-rules-${now.rules?.published_version ?? date}`,
      identities: 0,
      rows: invalidated.filter((row) => row.kind === "rules_audit_excerpt").length,
      samples: [],
      detail: `Comprehensive Rules moved ${previous.rules?.published_version ?? "none"} → ${now.rules?.published_version ?? "none"}; re-read the frozen validator excerpt and the census rules binding`,
    });
  if (rulingsChanged)
    units.push({
      kind: "rulings_export",
      owner: null,
      suggested_chunk: `requalify-rulings-${date}`,
      identities: 0,
      rows: 0,
      samples: [],
      detail: `rulings export moved ${previous.rulings?.updated_at ?? "none"} → ${now.rulings?.updated_at ?? "none"}; card_rulings evidence for cited interactions is stale`,
    });
  if (vocabularyChanged)
    units.push({
      kind: "vocabulary",
      owner: null,
      suggested_chunk: `requalify-vocabulary-${date}`,
      identities: 0,
      rows: 0,
      samples: [],
      detail:
        "frozen keyword vocabulary digests changed; assign new entries to a batch (npm test fails until done)",
    });
  if (construction && (construction.changed.length > 0 || construction.added.length > 0))
    units.push({
      kind: "construction_dependency",
      owner: null,
      suggested_chunk: `requalify-construction-${date}`,
      identities: construction.changed.length + construction.added.length,
      rows: construction.changed.length + construction.added.length,
      samples: [...construction.changed, ...construction.added].slice(0, 5).map((row) => row.name),
      detail:
        "construction authority dependencies changed or appeared; re-read companion conditions and copy grants",
    });
  if (policy?.changed)
    units.push({
      kind: "policy_membership",
      owner: null,
      suggested_chunk: `requalify-policy-${date}`,
      identities: current.policy?.game_changers ?? 0,
      rows: 0,
      samples: [],
      detail:
        "Game Changers membership digest changed; bracket and policy evidence must cite the new list",
    });
  if (now.baseline.changed > 0 || now.baseline.absent > 0)
    units.push({
      kind: "baseline_corpus",
      owner: "engine-mvp-corpus",
      suggested_chunk: "engine-mvp-corpus",
      identities: now.baseline.changed + now.baseline.absent,
      rows: now.baseline.changed + now.baseline.absent,
      samples: input.current.report.census.baseline.changed.slice(0, 5).map((row) => row.name),
      detail:
        "frozen MVP baseline records no longer match the pool; the fixed corpus needs requalification",
    });

  const requalificationRequired =
    units.length > 0 ||
    invalidated.length > 0 ||
    pool.removed.length > 0 ||
    banned.added.length > 0;
  return {
    version: REQUALIFICATION_VERSION,
    as_of: date,
    status: requalificationRequired ? "requalification_required" : "current",
    previous: {
      bindings: previous,
      construction: previousState?.construction ?? null,
      policy: previousState?.policy ?? null,
      rules_audit: previousState?.rules_audit ?? null,
    },
    current,
    changes: {
      snapshot: snapshotChanged,
      rules: rulesChanged,
      rulings: rulingsChanged,
      vocabulary: vocabularyChanged,
      engine: engineChanged,
      pool,
      banned,
      keywords,
      construction,
      policy,
    },
    invalidated,
    requalification: units,
    limitations: REQUALIFICATION_LIMITATIONS,
  };
}

/** Identities whose owners the diff attributes: added plus changed. */
export function identitiesToAttribute(
  previous: readonly LedgerRow[],
  current: readonly LedgerRow[],
): Identity[] {
  const { added, changed } = identityDiff(previous, current);
  return [...added, ...changed.map((row) => ({ oracle_id: row.oracle_id, name: row.name }))];
}

export function vocabularyIndexFor(vocabulary: KeywordVocabulary): VocabularyIndex {
  return indexVocabulary(vocabulary);
}

// --- Generation over the served data root ------------------------------------------

export interface RequalificationRun {
  readonly current: LegalPoolReport;
  readonly state: EvidenceState;
  readonly report: RequalificationReport;
}

/** Open the served snapshot read-only and run `use` over its index. */
async function withServedIndex<T>(
  dataRoot: string,
  use: (index: CardIndex) => Promise<T> | T,
): Promise<T> {
  const snapshot = await openCurrentSnapshot(new VersionedStore(dataRoot));
  if (!snapshot) throw new Error(`No served card snapshot under ${dataRoot}`);
  try {
    return await use(snapshot.index);
  } finally {
    snapshot.index.close();
  }
}

/** The current evidence state of a data root, for --check comparisons. */
export async function currentEvidenceState(
  dataRoot: string,
  report?: LegalPoolReport,
): Promise<{ report: LegalPoolReport; state: EvidenceState }> {
  const current = report ?? (await generateLegalPoolReport(dataRoot));
  const state = await withServedIndex(dataRoot, (index) => evidenceState(current, index));
  return { report: current, state };
}

/**
 * The update step: regenerate the census over the served data root, diff it
 * against the previously committed report and requalification state, and
 * attribute added/changed identities to their pending owners.
 */
export async function generateRequalification(
  dataRoot: string,
  previous: { report: LegalPoolReport; state: EvidenceState | null },
): Promise<RequalificationRun> {
  const current = await generateLegalPoolReport(dataRoot);
  const vocabulary = vocabularyIndexFor(await loadKeywordVocabulary());
  const { state, attribution } = await withServedIndex(dataRoot, async (index) => ({
    state: await evidenceState(current, index),
    attribution: attributeOwners(
      identitiesToAttribute(previous.report.ledger, current.ledger),
      index,
      vocabulary,
    ),
  }));
  const report = diffEvidence({
    previous,
    current: { report: current, state },
    attribution,
  });
  return { current, state, report };
}

// --- Committed file ---------------------------------------------------------------

export async function writeRequalification(
  report: RequalificationReport,
  directory: string = LEGAL_POOL_DIRECTORY,
): Promise<string> {
  const file = join(directory, REQUALIFICATION_FILE);
  await writeFile(file, JSON.stringify(report, null, 2) + "\n", "utf8");
  return file;
}

export async function readRequalification(
  directory: string = LEGAL_POOL_DIRECTORY,
): Promise<RequalificationReport | null> {
  try {
    return JSON.parse(
      await readFile(join(directory, REQUALIFICATION_FILE), "utf8"),
    ) as RequalificationReport;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}
