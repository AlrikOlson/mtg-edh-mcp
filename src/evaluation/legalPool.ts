/**
 * Complete Commander-legal pool census (evaluation owner).
 *
 * Static classification of every legal Oracle identity in the served snapshot,
 * joined to the canonical Rust support module's conventions: the same key-sorted
 * JSON source digest, the same requirement ids (`/faces/{i}/characteristics/
 * oracle_text:{start}-{end}` over UTF-16 paragraph offsets, the characteristic
 * field rows, the shared rows and `intrinsic-basic-mana`). Rows are planning
 * obligations routed to pending roadmap owners; only rows listed in
 * QUALIFIED_EVIDENCE carry executable evidence. Nothing here executes rules,
 * interprets Oracle text for play, or authorizes admission.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CardIndex } from "../index/cardIndex.js";
import type { Card, CardCharacteristics, CardGameplay } from "../types/index.js";
import type { RulesManifest } from "../types/index.js";
import { commanderShape, isCommanderEligible } from "../validate/commanderRules.js";
import { companionRuleCoverage } from "../validate/companionRules.js";
import { digestEvaluation } from "./registration.js";
import {
  FAMILY_OWNERS,
  KEYWORD_BATCHES,
  QUALIFIED_EVIDENCE,
  UNLISTED_KEYWORD_CHUNK,
  keywordBatchIndex,
  type QualifiedEvidence,
} from "./legalPoolOwnership.js";

export const LEGAL_POOL_CENSUS_VERSION = "legal-pool-census-v1";

// --- Frozen keyword vocabulary -------------------------------------------------

const vocabularyListSchema = z.object({
  uri: z.string(),
  total_values: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  data: z.array(z.string()),
});
const vocabularySchema = z.object({
  version: z.literal("keyword-vocabulary-v1"),
  retrieved_at: z.string(),
  user_agent: z.string(),
  note: z.string(),
  catalogs: z.object({
    keyword_abilities: vocabularyListSchema,
    keyword_actions: vocabularyListSchema,
    ability_words: vocabularyListSchema,
  }),
});
export type KeywordVocabulary = z.infer<typeof vocabularySchema>;
export type VocabularyKind = "keyword_ability" | "keyword_action" | "ability_word";

export const KEYWORD_VOCABULARY_PATH = new URL(
  "../../docs/evaluation/engine-any/keyword-vocabulary-v1.json",
  import.meta.url,
);

/** Load the frozen vocabulary and verify each list digest; a changed list fails loudly. */
export async function loadKeywordVocabulary(
  path: URL = KEYWORD_VOCABULARY_PATH,
): Promise<KeywordVocabulary> {
  const vocabulary = vocabularySchema.parse(JSON.parse(await readFile(path, "utf8")));
  for (const [kind, list] of Object.entries(vocabulary.catalogs)) {
    if (list.data.length !== list.total_values || digestEvaluation(list.data) !== list.sha256) {
      throw new Error(`Keyword vocabulary ${kind} does not match its frozen digest`);
    }
  }
  return vocabulary;
}

interface VocabularyEntry {
  readonly name: string;
  readonly kind: VocabularyKind;
}

/** Case-insensitive lookup plus a longest-first list for keyword-line prefix matching. */
export interface VocabularyIndex {
  readonly byLower: ReadonlyMap<string, VocabularyEntry>;
  readonly longestFirst: readonly VocabularyEntry[];
}

export function indexVocabulary(vocabulary: KeywordVocabulary): VocabularyIndex {
  const byLower = new Map<string, VocabularyEntry>();
  const add = (names: readonly string[], kind: VocabularyKind) => {
    for (const name of names)
      if (!byLower.has(name.toLowerCase())) byLower.set(name.toLowerCase(), { name, kind });
  };
  add(vocabulary.catalogs.keyword_abilities.data, "keyword_ability");
  add(vocabulary.catalogs.keyword_actions.data, "keyword_action");
  add(vocabulary.catalogs.ability_words.data, "ability_word");
  const longestFirst = [...byLower.values()].sort(
    (a, b) => b.name.length - a.name.length || (a.name < b.name ? -1 : 1),
  );
  return { byLower, longestFirst };
}

// --- Rows ------------------------------------------------------------------------

export type RowStatus = "qualified" | "owned" | "unresolved";

export interface CensusRow {
  /** Requirement id in the Rust support module's scheme (or a census extension). */
  readonly id: string;
  readonly path: string;
  readonly face_index: number | null;
  readonly start: number | null;
  readonly end: number | null;
  readonly families: readonly string[];
  readonly status: RowStatus;
  readonly owners: readonly string[];
  /** False for root-characteristic rows duplicated by an explicit face inventory. */
  readonly counted: boolean;
}

export interface CardCensus {
  readonly oracle_id: string;
  readonly name: string;
  readonly source_digest: string;
  readonly layout: string | null;
  readonly face_relationship: CardGameplay["face_relationship"];
  readonly faces: number | null;
  readonly rows: readonly CensusRow[];
}

export type ClauseShape =
  | "loyalty"
  | "chapter"
  | "mode_line"
  | "modal"
  | "keyword_line"
  | "triggered"
  | "activated"
  | "replacement"
  | "reminder"
  | "static";

const SOURCE_FIELDS = [
  "name",
  "mana_cost",
  "cmc",
  "type_line",
  "colors",
  "color_indicator",
  "power",
  "toughness",
  "loyalty",
  "defense",
  "keywords",
  "produced_mana",
] as const satisfies readonly (keyof CardCharacteristics)[];

const TYPE_WORDS = [
  "Creature",
  "Planeswalker",
  "Battle",
  "Saga",
  "Class",
  "Case",
  "Room",
  "Vehicle",
  "Spacecraft",
  "Aura",
  "Equipment",
  "Land",
  "Instant",
  "Sorcery",
  "Kindred",
  "Legendary",
  "Artifact",
  "Enchantment",
  "Background",
  "Attraction",
  "Stickers",
  "Contraption",
] as const;

const REMINDER = /\([^)]*\)/g;
const LOYALTY = /^[+−-]?(?:\d+|X):\s/;
const CHAPTER = /^(?:I|II|III|IV|V|VI|VII)(?:, (?:I|II|III|IV|V|VI|VII))*\s*—\s/;
const MODE_LINE = /^•\s/;
const MODAL = /^Choose (?:one|two|three|four|any number|one or more|up to)\b/i;
const TRIGGERED = /^(?:When|Whenever|At the beginning of|At end of)\b/;
const ACTIVATED = /^[^.:]{1,120}:\s/;
const REPLACEMENT = /\binstead\b|\bwould\b/i;
const KEYWORD_TERMINATOR = /^(?:$|[\s{—–\-,.;:])/;

function typeFamilies(typeLine: string | null): string[] {
  if (!typeLine) return [];
  return TYPE_WORDS.filter((word) => new RegExp(`\\b${word}\\b`).test(typeLine)).map(
    (word) => `type:${word}`,
  );
}

/** Recognize a keyword-line part ("Equip {2}", "Protection from red", "Partner with X"). */
export function keywordOfPart(part: string, vocabulary: VocabularyIndex): VocabularyEntry | null {
  const lower = part.trim().toLowerCase();
  if (!lower) return null;
  for (const entry of vocabulary.longestFirst) {
    const name = entry.name.toLowerCase();
    if (lower.startsWith(name) && KEYWORD_TERMINATOR.test(lower.slice(name.length))) return entry;
  }
  return null;
}

/** Provisional paragraph shape from its opening; planning only, never semantics. */
export function classifyClause(
  line: string,
  vocabulary: VocabularyIndex,
): { shape: ClauseShape; keywords: VocabularyEntry[] } {
  const trimmed = line.trim();
  if (LOYALTY.test(trimmed)) return { shape: "loyalty", keywords: [] };
  if (CHAPTER.test(trimmed)) return { shape: "chapter", keywords: [] };
  if (MODE_LINE.test(trimmed)) return { shape: "mode_line", keywords: [] };
  if (MODAL.test(trimmed)) return { shape: "modal", keywords: [] };
  const stripped = trimmed.replace(REMINDER, "").trim();
  if (!stripped) return { shape: "reminder", keywords: [] };
  const parts = stripped
    .split(/,\s*|;\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const keywords = parts.map((part) => keywordOfPart(part, vocabulary));
  if (parts.length > 0 && keywords.every((entry) => entry !== null)) {
    return { shape: "keyword_line", keywords: keywords as VocabularyEntry[] };
  }
  // A keyword whose parameter contains a comma ("Partner with Toothy, Imaginary Friend").
  const whole = keywordOfPart(stripped, vocabulary);
  if (
    whole &&
    whole.name.length < stripped.length &&
    /[\s—]/.test(stripped.charAt(whole.name.length))
  )
    return { shape: "keyword_line", keywords: [whole] };
  if (TRIGGERED.test(stripped)) return { shape: "triggered", keywords: [] };
  if (ACTIVATED.test(stripped)) return { shape: "activated", keywords: [] };
  if (REPLACEMENT.test(stripped)) return { shape: "replacement", keywords: [] };
  return { shape: "static", keywords: [] };
}

interface RowDraft {
  id: string;
  path: string;
  face_index: number | null;
  start: number | null;
  end: number | null;
  families: string[];
  counted: boolean;
}

function draft(id: string, path: string, families: string[], counted = true): RowDraft {
  return { id, path, face_index: null, start: null, end: null, families, counted };
}

function fieldRows(
  characteristics: CardCharacteristics,
  base: string,
  counted: boolean,
): RowDraft[] {
  return SOURCE_FIELDS.map((key) => {
    const path = `${base}/${key}`;
    const value = characteristics[key];
    // A null field is transferred, not evaluated: it owes nothing beyond faithful capture.
    const families = value === null ? ["field:absent"] : [`field:${key}`];
    if (
      (key === "power" || key === "toughness") &&
      typeof value === "string" &&
      /[^0-9]/.test(value)
    )
      families.push("field:cda");
    if (key === "type_line") families.push(...typeFamilies(characteristics.type_line));
    return draft(path, path, families, counted);
  });
}

/** Paragraph clauses with UTF-16 offsets, exactly as the Rust support module splits them. */
function clauseRows(
  text: string,
  face: number | null,
  path: string,
  counted: boolean,
  vocabulary: VocabularyIndex,
): RowDraft[] {
  const rows: RowDraft[] = [];
  let start = 0;
  for (const line of text.split("\n")) {
    const end = start + line.length;
    if (end !== start) {
      const { shape, keywords } = classifyClause(line, vocabulary);
      const families = [`shape:${shape}`];
      for (const entry of keywords) families.push(`kw:${entry.name}`);
      rows.push({
        id: `${path}:${start}-${end}`,
        path,
        face_index: face,
        start,
        end,
        families: [...new Set(families)],
        counted,
      });
    }
    start = end + 1;
  }
  return rows;
}

function keywordFamily(keyword: string, vocabulary: VocabularyIndex): string[] {
  const entry = vocabulary.byLower.get(keyword.toLowerCase());
  return entry ? [`kw:${entry.name}`, `vocab:${entry.kind}`] : ["vocab:unlisted"];
}

/** Pending chunks owning a row's families (sorted, unique); empty means unresolved. */
export function ownersOfFamilies(
  families: readonly string[],
  batches: ReadonlyMap<string, string> = keywordBatchIndex(),
): string[] {
  const owners = new Set<string>();
  for (const family of families) {
    if (family.startsWith("kw:")) {
      const chunk = batches.get(family.slice(3).toLowerCase());
      if (chunk) owners.add(chunk);
      continue;
    }
    for (const chunk of FAMILY_OWNERS[family] ?? []) owners.add(chunk);
  }
  return [...owners].sort();
}

/** Every census obligation for one stored card. Pure; no index access. */
export function censusCard(
  card: Card,
  vocabulary: VocabularyIndex,
  batches: ReadonlyMap<string, string> = keywordBatchIndex(),
  evidence: readonly QualifiedEvidence[] = QUALIFIED_EVIDENCE,
): CardCensus {
  const gameplay = card.gameplay;
  if (!gameplay) throw new Error(`Card ${card.oracle_id} has no canonical gameplay record`);
  const faces = gameplay.faces;
  const hasFaces = faces !== null;
  const rows: RowDraft[] = [
    draft("catalog-physical-adapter", "/", ["shared:physical_adapter"]),
    draft("shared-runtime-rules", "/", ["shared:runtime_rules"]),
    draft("/layout", "/layout", [`layout:${gameplay.layout ?? "null"}`]),
    draft("/face_relationship", "/face_relationship", [
      `relationship:${gameplay.face_relationship}`,
    ]),
    draft("/color_identity", "/color_identity", ["field:color_identity"]),
    ...fieldRows(gameplay.characteristics, "/characteristics", !hasFaces),
    ...clauseRows(
      gameplay.characteristics.oracle_text ?? "",
      null,
      "/characteristics/oracle_text",
      !hasFaces,
      vocabulary,
    ),
  ];
  if (faces) {
    faces.forEach((face, index) => {
      const base = `/faces/${index}/characteristics`;
      rows.push(...fieldRows(face.characteristics, base, true));
      rows.push(
        ...clauseRows(
          face.characteristics.oracle_text ?? "",
          index,
          `${base}/oracle_text`,
          true,
          vocabulary,
        ),
      );
    });
  } else {
    rows.push(draft("faces", "/faces", ["faces:missing"]));
  }
  for (const keyword of new Set(card.keywords)) {
    rows.push(
      draft(`keyword:${keyword}`, "/characteristics/keywords", keywordFamily(keyword, vocabulary)),
    );
  }
  // Commander configurations reuse the construction authority's front-face reading.
  const shape = commanderShape(card);
  if (isCommanderEligible(card))
    rows.push(draft("commander:eligible", "/", ["commander:eligible"]));
  if (/can be your commander/i.test(card.oracle_text))
    rows.push(draft("commander:can_be_commander", "/", ["commander:can_be_commander"]));
  if (shape.partner)
    rows.push(draft(`commander:${shape.partner}`, "/", [`commander:${shape.partner}`]));
  if (shape.choosesBackground)
    rows.push(draft("commander:chooses_background", "/", ["commander:chooses_background"]));
  if (shape.isBackground) rows.push(draft("commander:background", "/", ["commander:background"]));
  if (shape.isTimeLordDoctor)
    rows.push(draft("commander:time_lord_doctor", "/", ["commander:time_lord_doctor"]));
  if (card.keywords.some((keyword) => keyword.toLowerCase() === "companion"))
    rows.push(draft("companion", "/", [`companion:${companionRuleCoverage(card)}`]));
  // Generated objects: related records are references, never captured definitions.
  let relatedToken = false;
  let relatedEmblem = false;
  for (const related of gameplay.related_cards ?? []) {
    if (related.component === "token") {
      const emblem = /^Emblem\b/.test(related.type_line);
      relatedToken ||= !emblem;
      relatedEmblem ||= emblem;
      rows.push(
        draft(`generated:token:${related.id}`, "/related_cards", [
          emblem ? "generated:emblem" : "generated:token",
        ]),
      );
    } else if (related.component === "meld_part" || related.component === "meld_result") {
      rows.push(
        draft(`generated:${related.component}:${related.id}`, "/related_cards", [
          `generated:${related.component}`,
        ]),
      );
    } else if (related.component === "combo_piece") {
      rows.push(
        draft(`related:combo_piece:${related.id}`, "/related_cards", ["related:combo_piece"]),
      );
    }
  }
  if (!relatedToken && /\bcreate\b[^.\n]*\btokens?\b/i.test(card.oracle_text))
    rows.push(draft("generated:token-text", "/", ["generated:token_text_unlinked"]));
  if (!relatedEmblem && /\bemblem\b/i.test(card.oracle_text))
    rows.push(draft("generated:emblem-text", "/", ["generated:emblem_text"]));
  const typeLines = [
    gameplay.characteristics.type_line,
    ...(faces ?? []).map((face) => face.characteristics.type_line),
  ];
  if (typeLines.some((line) => line !== null && /\bBasic\b/.test(line) && /\bLand\b/.test(line)))
    rows.push(
      draft("intrinsic-basic-mana", "/characteristics/type_line", ["intrinsic:basic_mana"]),
    );

  const qualifiedIds = new Set(
    evidence.filter((row) => row.oracle_id === card.oracle_id).map((row) => row.requirement),
  );
  const resolved: CensusRow[] = rows.map((row) => {
    if (qualifiedIds.has(row.id)) return { ...row, status: "qualified", owners: [] };
    const owners = ownersOfFamilies(row.families, batches);
    return { ...row, status: owners.length > 0 ? "owned" : "unresolved", owners };
  });
  return {
    oracle_id: card.oracle_id,
    name: card.name,
    source_digest: digestEvaluation(gameplay),
    layout: gameplay.layout,
    face_relationship: gameplay.face_relationship,
    faces: faces ? faces.length : null,
    rows: resolved,
  };
}

// --- Pool census ------------------------------------------------------------------

export interface SnapshotBinding {
  readonly version: string;
  readonly snapshot: string;
  readonly files: Readonly<
    Record<string, { name: string; updated_at: string; bytes: number; source_uri: string }>
  >;
}

export interface BaselineRecord {
  readonly oracle_id: string;
  readonly name: string;
  readonly gameplay: unknown;
}

export interface LegalPoolInput {
  readonly index: CardIndex;
  readonly snapshot: SnapshotBinding;
  readonly rules: RulesManifest | null;
  readonly vocabulary: KeywordVocabulary;
  readonly baseline: { readonly version: string; readonly records: readonly BaselineRecord[] };
  readonly engineRevision: string;
}

export interface FamilySummary {
  readonly family: string;
  readonly rows: number;
  readonly cards: number;
  readonly owners: readonly string[];
  readonly samples: readonly string[];
}

export interface LedgerRow {
  readonly oracle_id: string;
  readonly name: string;
  readonly source_digest: string;
}

export interface LegalPoolCensus {
  readonly version: typeof LEGAL_POOL_CENSUS_VERSION;
  readonly snapshot: SnapshotBinding & {
    readonly index_revision: string;
    readonly identities_total: number;
    readonly legal_identities: number;
    readonly banned_identities: number;
    readonly not_legal_identities: number;
  };
  readonly rules: {
    readonly comprehensive_rules: RulesManifest["comprehensive_rules"];
    readonly rulings: RulesManifest["rulings"];
    readonly version: string;
  } | null;
  readonly vocabulary: {
    readonly version: string;
    readonly retrieved_at: string;
    readonly digests: Readonly<Record<string, string>>;
  };
  readonly qualified_evidence: readonly QualifiedEvidence[];
  readonly engine_revision: string;
  readonly totals: {
    readonly faces: number;
    readonly faceless_identities: number;
    readonly rows_total: number;
    readonly rows_counted: number;
    readonly clauses: number;
    readonly by_status: Readonly<Record<RowStatus, number>>;
    readonly by_shape: Readonly<Record<string, number>>;
  };
  readonly owners: readonly { chunk: string; rows: number; cards: number }[];
  readonly families: readonly FamilySummary[];
  readonly keywords: {
    readonly listed: readonly {
      keyword: string;
      kind: VocabularyKind;
      cards: number;
      batch: string;
    }[];
    readonly unlisted: readonly { keyword: string; cards: number; batch: string }[];
    readonly vocabulary_unused: readonly string[];
  };
  readonly layouts: readonly {
    layout: string;
    cards: number;
    face_relationship: string;
    faces_missing: number;
  }[];
  readonly baseline: {
    readonly version: string;
    readonly identities: number;
    readonly unchanged: number;
    readonly changed: readonly {
      oracle_id: string;
      name: string;
      frozen: string;
      current: string;
    }[];
    readonly absent: readonly { oracle_id: string; name: string }[];
  };
  readonly banned: readonly { oracle_id: string; name: string }[];
  readonly banned_digest: string;
  readonly ledger: { readonly rows: number; readonly digest: string };
  readonly unresolved: readonly {
    oracle_id: string;
    name: string;
    id: string;
    families: readonly string[];
  }[];
  readonly limitations: readonly string[];
}

export const CENSUS_LIMITATIONS: readonly string[] = [
  "Rows are planning obligations joined to the canonical Rust support ids; an owner is pending work, never support. Only the three registered intrinsic basic-land mana clauses carry executable evidence.",
  "Clause shapes are provisional classes of paragraph openings used to route pending work; they are not rules semantics, and a misrouted clause still remains owned.",
  "Keyword families come from Scryfall's card-level keyword labels and recognized keyword lines; a label outside the three frozen catalogs is a named ability owned by the named-abilities batch, not a keyword ability.",
  "Related token, meld and emblem records are references; captured canonical definitions remain owed to the catalog-objects owner. Text-created tokens without a related record are counted separately.",
  "Root characteristic rows duplicated by an explicit face inventory are emitted for Rust join compatibility but not counted; faceless records (class, saga, case, leveler, mutate, prototype layouts) count their root rows and carry an explicit missing-faces obligation.",
  "The per-identity ledger freezes identity and exact-source digests; exact text stays in the immutable versioned snapshot bound by file provenance and the pool digest.",
];

function increment(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function sortedRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Census over the served index inside one read snapshot; deterministic for a fixed snapshot. */
export function censusLegalPool(input: LegalPoolInput): {
  census: LegalPoolCensus;
  ledger: LedgerRow[];
} {
  const vocabulary = indexVocabulary(input.vocabulary);
  const batches = keywordBatchIndex();
  const familyRows = new Map<string, number>();
  const familyCards = new Map<string, Set<string>>();
  const familySamples = new Map<string, string[]>();
  const familyOwners = new Map<string, Set<string>>();
  const ownerRows = new Map<string, number>();
  const ownerCards = new Map<string, Set<string>>();
  const shapes = new Map<string, number>();
  const layouts = new Map<string, { cards: number; relationship: string; facesMissing: number }>();
  const keywordCards = new Map<string, number>();
  const byStatus: Record<RowStatus, number> = { qualified: 0, owned: 0, unresolved: 0 };
  const unresolved: { oracle_id: string; name: string; id: string; families: readonly string[] }[] =
    [];
  const ledger: LedgerRow[] = [];
  const banned: { oracle_id: string; name: string }[] = [];
  const byOracle = new Map<string, string>();
  let faces = 0;
  let faceless = 0;
  let rowsTotal = 0;
  let rowsCounted = 0;
  let clauses = 0;

  const { legal, bannedCount, notLegal, revision, total } = input.index.withRead(() => {
    const legal = input.index.forEachCommanderLegality("legal", (card) => {
      const result = censusCard(card, vocabulary, batches);
      byOracle.set(result.oracle_id, result.source_digest);
      ledger.push({
        oracle_id: result.oracle_id,
        name: result.name,
        source_digest: result.source_digest,
      });
      if (result.faces === null) faceless += 1;
      else faces += result.faces;
      const layoutKey = result.layout ?? "null";
      const layout = layouts.get(layoutKey) ?? {
        cards: 0,
        relationship: result.face_relationship,
        facesMissing: 0,
      };
      layout.cards += 1;
      if (result.faces === null) layout.facesMissing += 1;
      layouts.set(layoutKey, layout);
      for (const keyword of new Set(card.keywords)) increment(keywordCards, keyword);
      const cardFamilies = new Set<string>();
      const cardOwners = new Set<string>();
      for (const row of result.rows) {
        rowsTotal += 1;
        if (!row.counted) continue;
        rowsCounted += 1;
        byStatus[row.status] += 1;
        if (row.start !== null) {
          clauses += 1;
          for (const family of row.families)
            if (family.startsWith("shape:")) increment(shapes, family.slice(6));
        }
        if (row.status === "unresolved")
          unresolved.push({
            oracle_id: result.oracle_id,
            name: result.name,
            id: row.id,
            families: row.families,
          });
        for (const family of row.families) {
          increment(familyRows, family);
          cardFamilies.add(family);
          const owners = familyOwners.get(family) ?? new Set<string>();
          for (const owner of row.owners) owners.add(owner);
          familyOwners.set(family, owners);
        }
        for (const owner of row.owners) {
          increment(ownerRows, owner);
          cardOwners.add(owner);
        }
      }
      for (const family of cardFamilies) {
        const cards = familyCards.get(family) ?? new Set<string>();
        cards.add(result.oracle_id);
        familyCards.set(family, cards);
        const samples = familySamples.get(family) ?? [];
        if (samples.length < 5) samples.push(result.name);
        familySamples.set(family, samples);
      }
      for (const owner of cardOwners) {
        const cards = ownerCards.get(owner) ?? new Set<string>();
        cards.add(result.oracle_id);
        ownerCards.set(owner, cards);
      }
    });
    const bannedCount = input.index.forEachCommanderLegality("banned", (card) =>
      banned.push({ oracle_id: card.oracle_id, name: card.name }),
    );
    const notLegal = input.index.forEachCommanderLegality("not_legal", () => {});
    return {
      legal,
      bannedCount,
      notLegal,
      revision: input.index.revision(),
      total: input.index.count(),
    };
  });

  const changed: { oracle_id: string; name: string; frozen: string; current: string }[] = [];
  const absent: { oracle_id: string; name: string }[] = [];
  let unchanged = 0;
  for (const record of input.baseline.records) {
    const frozen = digestEvaluation(record.gameplay);
    const current = byOracle.get(record.oracle_id);
    if (current === undefined) absent.push({ oracle_id: record.oracle_id, name: record.name });
    else if (current === frozen) unchanged += 1;
    else changed.push({ oracle_id: record.oracle_id, name: record.name, frozen, current });
  }

  const listed: { keyword: string; kind: VocabularyKind; cards: number; batch: string }[] = [];
  const unlistedKeywords: { keyword: string; cards: number; batch: string }[] = [];
  for (const [keyword, cards] of [...keywordCards.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const entry = vocabulary.byLower.get(keyword.toLowerCase());
    if (entry) {
      listed.push({
        keyword: entry.name,
        kind: entry.kind,
        cards,
        batch: batches.get(entry.name.toLowerCase()) ?? "",
      });
    } else unlistedKeywords.push({ keyword, cards, batch: UNLISTED_KEYWORD_CHUNK });
  }
  const used = new Set(listed.map((row) => row.keyword.toLowerCase()));
  const vocabularyUnused = vocabulary.longestFirst
    .map((entry) => entry.name)
    .filter((name) => !used.has(name.toLowerCase()))
    .sort();

  const families: FamilySummary[] = [...familyRows.keys()].sort().map((family) => ({
    family,
    rows: familyRows.get(family) ?? 0,
    cards: familyCards.get(family)?.size ?? 0,
    owners: [...(familyOwners.get(family) ?? [])].sort(),
    samples: familySamples.get(family) ?? [],
  }));
  const owners = [...ownerRows.keys()].sort().map((chunk) => ({
    chunk,
    rows: ownerRows.get(chunk) ?? 0,
    cards: ownerCards.get(chunk)?.size ?? 0,
  }));
  const bannedSorted = banned.sort((a, b) => (a.oracle_id < b.oracle_id ? -1 : 1));
  const census: LegalPoolCensus = {
    version: LEGAL_POOL_CENSUS_VERSION,
    snapshot: {
      ...input.snapshot,
      index_revision: revision,
      identities_total: total,
      legal_identities: legal,
      banned_identities: bannedCount,
      not_legal_identities: notLegal,
    },
    rules: input.rules
      ? {
          version: input.rules.version,
          comprehensive_rules: input.rules.comprehensive_rules,
          rulings: input.rules.rulings,
        }
      : null,
    vocabulary: {
      version: input.vocabulary.version,
      retrieved_at: input.vocabulary.retrieved_at,
      digests: Object.fromEntries(
        Object.entries(input.vocabulary.catalogs).map(([kind, list]) => [kind, list.sha256]),
      ),
    },
    qualified_evidence: QUALIFIED_EVIDENCE,
    engine_revision: input.engineRevision,
    totals: {
      faces,
      faceless_identities: faceless,
      rows_total: rowsTotal,
      rows_counted: rowsCounted,
      clauses,
      by_status: byStatus,
      by_shape: sortedRecord(shapes),
    },
    owners,
    families,
    keywords: { listed, unlisted: unlistedKeywords, vocabulary_unused: vocabularyUnused },
    layouts: [...layouts.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([layout, value]) => ({
        layout,
        cards: value.cards,
        face_relationship: value.relationship,
        faces_missing: value.facesMissing,
      })),
    baseline: {
      version: input.baseline.version,
      identities: input.baseline.records.length,
      unchanged,
      changed,
      absent,
    },
    banned: bannedSorted,
    banned_digest: digestEvaluation(bannedSorted),
    ledger: { rows: ledger.length, digest: digestEvaluation(ledger) },
    unresolved,
    limitations: CENSUS_LIMITATIONS,
  };
  return { census, ledger };
}

/** Batch chunks referenced by the ownership table, for roadmap reconciliation and tests. */
export function ownershipChunks(): string[] {
  const chunks = new Set<string>([UNLISTED_KEYWORD_CHUNK]);
  for (const batch of KEYWORD_BATCHES) chunks.add(batch.chunk);
  for (const owners of Object.values(FAMILY_OWNERS)) for (const chunk of owners) chunks.add(chunk);
  return [...chunks].sort();
}
