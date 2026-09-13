import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/cardIndex.js";
import type { RulesManifest } from "../types/index.js";
import {
  attributeOwners,
  bindingsOf,
  currentEvidenceState,
  diffEvidence,
  evidenceState,
  identitiesToAttribute,
  readRequalification,
  writeRequalification,
  type EvidenceState,
  type RequalificationReport,
} from "./evidenceFreshness.js";
import {
  censusLegalPool,
  indexVocabulary,
  loadKeywordVocabulary,
  type KeywordVocabulary,
} from "./legalPool.js";
import { QUALIFIED_EVIDENCE } from "./legalPoolOwnership.js";
import { readLegalPoolReport, servedDataRoot, type LegalPoolReport } from "./legalPoolReport.js";
import { loadRulesExcerpt } from "./rulesAudit.js";

interface RawCard {
  oracle_id: string;
  id: string;
  name: string;
  type_line: string;
  oracle_text: string;
  keywords?: string[];
  legalities?: { commander: string };
  game_changer?: boolean;
}

function raw(card: RawCard) {
  return {
    layout: "normal",
    cmc: 1,
    colors: [],
    color_identity: [],
    keywords: [],
    legalities: { commander: "legal" },
    prices: {},
    ...card,
  };
}

const FOREST: RawCard = {
  oracle_id: "b34bb2dc-c1af-4d77-b0b3-a0fb342a5fc6",
  id: "p-forest",
  name: "Forest",
  type_line: "Basic Land — Forest",
  oracle_text: "",
};
const SOL: RawCard = {
  oracle_id: "o-sol",
  id: "p-sol",
  name: "Sol Ring",
  type_line: "Artifact",
  oracle_text: "{T}: Add {C}{C}.",
  game_changer: true,
};
const DWARVES: RawCard = {
  oracle_id: "o-dwarves",
  id: "p-dwarves",
  name: "Seven Dwarves",
  type_line: "Creature — Dwarf",
  oracle_text: "A deck can have up to seven cards named Seven Dwarves.",
};
const LURRUS: RawCard = {
  oracle_id: "o-lurrus",
  id: "p-lurrus",
  name: "Lurrus of the Dream-Den",
  type_line: "Legendary Creature — Cat Nightmare",
  oracle_text: "Companion — Each permanent card in your starting deck has mana value 2 or less.",
  keywords: ["Companion"],
};
const OLD: RawCard = {
  oracle_id: "o-old",
  id: "p-old",
  name: "Old Card",
  type_line: "Instant",
  oracle_text: "Draw a card.",
};
const GOLOS: RawCard = {
  oracle_id: "o-golos",
  id: "p-golos",
  name: "Golos, Tireless Pilgrim",
  type_line: "Legendary Artifact Creature — Scout",
  oracle_text: "",
  legalities: { commander: "banned" },
};
const NEW: RawCard = {
  oracle_id: "o-new",
  id: "p-new",
  name: "New Card",
  type_line: "Creature — Bird",
  oracle_text: "Flying",
  keywords: ["Flying"],
  game_changer: true,
};
const NEWLY_BANNED: RawCard = {
  oracle_id: "o-newly-banned",
  id: "p-newly-banned",
  name: "Newly Banned",
  type_line: "Sorcery",
  oracle_text: "Win the game.",
  legalities: { commander: "banned" },
};

const PREVIOUS = [FOREST, SOL, DWARVES, LURRUS, OLD, GOLOS];
const CURRENT = [
  FOREST,
  { ...SOL, oracle_text: "{T}: Add {C}{C}. (Errata.)" },
  { ...DWARVES, oracle_text: "A deck can have up to eight cards named Seven Dwarves." },
  LURRUS,
  GOLOS,
  NEW,
  NEWLY_BANNED,
];

async function fixtureIndex(root: string, cards: RawCard[]): Promise<CardIndex> {
  const store = new VersionedStore(root);
  const version = "v-fixture";
  await store.createVersion(version);
  await writeFile(
    store.filePath(version, "oracle_cards.json"),
    JSON.stringify(cards.map(raw)),
    "utf8",
  );
  await writeFile(
    store.filePath(version, "default_cards.json"),
    JSON.stringify(
      cards.map((c) => ({
        oracle_id: c.oracle_id,
        id: c.id,
        set: "tst",
        set_name: "Test",
        collector_number: "1",
        rarity: "common",
        prices: {},
      })),
    ),
    "utf8",
  );
  await store.publish(version);
  return CardIndex.open((await buildIndex({ store })).dbPath);
}

function manifest(sha256: string, published: string): RulesManifest {
  return {
    version: `rules-${published}`,
    created_at: "2026-09-11T00:00:00Z",
    comprehensive_rules: {
      url: `https://media.wizards.com/2026/downloads/MagicCompRules%20${published}.txt`,
      url_discovery: "rules_page",
      published_version: published,
      effective_date: "2026-08-07",
      sha256,
      bytes: 1,
      retrieved_at: "2026-09-11T00:00:00Z",
      rule_count: 3162,
      glossary_count: 739,
    },
    rulings: {
      source: "scryfall_bulk_rulings",
      url: "https://data.scryfall.io/rulings/rulings.jsonl.gz",
      updated_at: "2026-09-11T21:00:32.471+00:00",
      sha256: "e".repeat(64),
      bytes: 1,
      retrieved_at: "2026-09-11T00:00:00Z",
      ruling_count: 1,
    },
  };
}

let roots: string[] = [];
let previousIndex: CardIndex;
let currentIndex: CardIndex;
let vocabulary: KeywordVocabulary;
let excerptSha: string;

beforeAll(async () => {
  roots = await Promise.all([
    mkdtemp(path.join(tmpdir(), "mtg-evidence-a-")),
    mkdtemp(path.join(tmpdir(), "mtg-evidence-b-")),
  ]);
  [previousIndex, currentIndex] = await Promise.all([
    fixtureIndex(roots[0]!, PREVIOUS),
    fixtureIndex(roots[1]!, CURRENT),
  ]);
  vocabulary = await loadKeywordVocabulary();
  excerptSha = (await loadRulesExcerpt()).excerpt.corpus.sha256;
});

afterAll(async () => {
  previousIndex.close();
  currentIndex.close();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function report(
  index: CardIndex,
  options: { version: string; date: string; rules?: RulesManifest | null; engine?: string },
): LegalPoolReport {
  return censusLegalPool({
    index,
    snapshot: { version: options.version, snapshot: options.date, files: {} },
    rules: options.rules ?? manifest(excerptSha, "20260819"),
    vocabulary,
    baseline: { version: "fixture", records: [] },
    engineRevision: options.engine ?? QUALIFIED_EVIDENCE[0]!.engine_revision,
  });
}

async function run(
  previous: LegalPoolReport,
  current: LegalPoolReport,
  previousState: EvidenceState | null,
): Promise<RequalificationReport> {
  const state = await evidenceState(current, currentIndex);
  return diffEvidence({
    previous: { report: previous, state: previousState },
    current: { report: current, state },
    attribution: attributeOwners(
      identitiesToAttribute(previous.ledger, current.ledger),
      currentIndex,
      indexVocabulary(vocabulary),
    ),
  });
}

describe("evidence state", () => {
  it("binds the census and freezes construction dependencies and policy membership", async () => {
    const previous = report(previousIndex, { version: "v-a", date: "2026-09-11" });
    const state = await evidenceState(previous, previousIndex);
    expect(state.bindings).toEqual(bindingsOf(previous));
    expect(state.bindings.snapshot).toMatchObject({ version: "v-a", legal_identities: 5 });
    expect(state.bindings.rules?.sha256).toBe(excerptSha);
    expect(state.bindings.qualified_evidence.map((row) => row.name)).toEqual([
      "Swamp",
      "Island",
      "Forest",
    ]);
    expect(state.bindings.keyword_labels).toEqual(["Companion"]);
    const byName = Object.fromEntries(
      state.construction.dependencies.map((row) => [`${row.authority}:${row.name}`, row]),
    );
    expect(byName["companion:Lurrus of the Dream-Den"]).toMatchObject({
      oracle_id: "o-lurrus",
      detail: "supported",
    });
    expect(byName["companion:Yorion, Sky Nomad"]).toMatchObject({
      oracle_id: null,
      source_digest: null,
      detail: "absent",
    });
    expect(byName["copy_exception:Seven Dwarves"]).toMatchObject({
      oracle_id: "o-dwarves",
      detail: "max 7 (bounded_text)",
    });
    expect(byName["copy_exception:Relentless Rats"]?.detail).toBe("absent");
    expect(state.policy).toEqual({ game_changers: 1, digest: expect.any(String) });
    expect(state.rules_audit.corpus_sha256).toBe(excerptSha);
  });
});

describe("diffEvidence", () => {
  it("reports no work when nothing bound has moved", async () => {
    const previous = report(previousIndex, { version: "v-a", date: "2026-09-11" });
    const previousState = await evidenceState(previous, previousIndex);
    const same = diffEvidence({
      previous: { report: previous, state: previousState },
      current: { report: previous, state: previousState },
      attribution: [],
    });
    expect(same.status).toBe("current");
    expect(same.as_of).toBe("2026-09-11");
    expect(same.changes).toMatchObject({
      snapshot: false,
      rules: false,
      rulings: false,
      vocabulary: false,
      engine: false,
      pool: { added: [], removed: [], changed: [], unchanged: 5 },
      banned: { added: [], removed: [] },
      keywords: { added: [], removed: [] },
      construction: { added: [], removed: [], changed: [] },
      policy: { changed: false },
    });
    expect(same.invalidated).toEqual([]);
    expect(same.requalification).toEqual([]);
  });

  it("diffs identities by exact-source digest, tracks legality, keywords, construction and policy", async () => {
    const previous = report(previousIndex, { version: "v-a", date: "2026-09-11" });
    const previousState = await evidenceState(previous, previousIndex);
    const current = report(currentIndex, { version: "v-b", date: "2026-09-12" });
    const diff = await run(previous, current, previousState);

    expect(diff.status).toBe("requalification_required");
    expect(diff.as_of).toBe("2026-09-12");
    expect(diff.changes.snapshot).toBe(true);
    expect(diff.changes.rules).toBe(false);
    expect(diff.changes.pool.added).toEqual([{ oracle_id: "o-new", name: "New Card" }]);
    expect(diff.changes.pool.removed).toEqual([{ oracle_id: "o-old", name: "Old Card" }]);
    expect(diff.changes.pool.changed.map((row) => row.name).sort()).toEqual([
      "Seven Dwarves",
      "Sol Ring",
    ]);
    expect(diff.changes.pool.changed.every((row) => row.previous !== row.current)).toBe(true);
    expect(diff.changes.pool.unchanged).toBe(2);
    expect(diff.changes.banned.added).toEqual([
      { oracle_id: "o-newly-banned", name: "Newly Banned" },
    ]);
    expect(diff.changes.keywords).toEqual({ added: ["Flying"], removed: [] });
    expect(diff.changes.construction?.changed).toEqual([
      expect.objectContaining({
        authority: "copy_exception",
        name: "Seven Dwarves",
        detail: "max 8 (bounded_text)",
        previous_digest: expect.any(String),
      }),
    ]);
    expect(diff.changes.policy).toEqual({ changed: true });

    // Only the construction dependency is invalidated: the qualified Forest row is untouched.
    expect(diff.invalidated.map((row) => row.kind)).toEqual(["construction_dependency"]);
    expect(diff.invalidated[0]?.owners).toEqual(["src/validate/coreRules.ts"]);

    const kinds = diff.requalification.map((unit) => unit.kind);
    expect(kinds).toContain("construction_dependency");
    expect(kinds).toContain("policy_membership");
    expect(kinds).not.toContain("qualified_evidence");
    const pool = diff.requalification.filter((unit) => unit.kind === "pool_identities");
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.every((unit) => unit.owner !== null && unit.owner === unit.suggested_chunk)).toBe(
      true,
    );
    const combat = pool.find((unit) => unit.owner === "engine-any-kw-combat-evasion");
    expect(combat).toMatchObject({ identities: 1, samples: ["New Card"] });
    expect(pool.reduce((max, unit) => Math.max(max, unit.identities), 0)).toBe(3);
    expect(diff.previous.construction).toEqual(previousState.construction);
  });

  it("invalidates qualified evidence when its identity changes or the engine pin moves", async () => {
    const previous = report(previousIndex, { version: "v-a", date: "2026-09-11" });
    const current = report(currentIndex, { version: "v-b", date: "2026-09-12" });
    const tampered: LegalPoolReport = {
      census: current.census,
      ledger: current.ledger.map((row) =>
        row.name === "Forest" ? { ...row, source_digest: "0".repeat(64) } : row,
      ),
    };
    const changed = await run(previous, tampered, null);
    expect(changed.changes.construction).toBeNull();
    expect(changed.changes.policy).toBeNull();
    const forest = changed.invalidated.find((row) => row.kind === "qualified_evidence");
    expect(forest).toMatchObject({
      subject: "Forest intrinsic-basic-mana",
      owners: ["engine-mvp-lands"],
    });
    expect(forest?.owners.length).toBeGreaterThan(0);
    expect(
      changed.requalification.find((unit) => unit.kind === "qualified_evidence"),
    ).toMatchObject({
      owner: null,
      suggested_chunk: "requalify-evidence-2026-09-12",
      identities: 1,
      rows: 1,
    });

    const moved = report(currentIndex, {
      version: "v-b",
      date: "2026-09-12",
      engine: "f".repeat(40),
    });
    const engine = await run(previous, moved, null);
    expect(engine.changes.engine).toBe(true);
    expect(engine.invalidated.filter((row) => row.kind === "engine_revision")).toHaveLength(3);
    expect(engine.requalification.find((unit) => unit.kind === "engine_revision")).toMatchObject({
      identities: 3,
      rows: 3,
    });
  });

  it("opens rules and rulings units and flags the frozen audit excerpt when the release moves", async () => {
    const previous = report(previousIndex, { version: "v-a", date: "2026-09-11" });
    const current = report(currentIndex, {
      version: "v-b",
      date: "2026-09-12",
      rules: {
        ...manifest("a".repeat(64), "20261101"),
        rulings: {
          ...manifest("a".repeat(64), "20261101").rulings,
          updated_at: "2026-11-01T21:00:00+00:00",
        },
      },
    });
    const diff = await run(previous, current, null);
    expect(diff.changes.rules).toBe(true);
    expect(diff.changes.rulings).toBe(true);
    expect(diff.invalidated.find((row) => row.kind === "rules_audit_excerpt")).toMatchObject({
      owners: ["src/evaluation/rulesAudit.ts"],
    });
    expect(diff.requalification.find((unit) => unit.kind === "rules_release")).toMatchObject({
      suggested_chunk: "requalify-rules-20261101",
      rows: 1,
    });
    expect(diff.requalification.find((unit) => unit.kind === "rulings_export")).toBeDefined();
  });

  it("round-trips the committed file and reports absence as null", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mtg-requalification-"));
    try {
      expect(await readRequalification(directory)).toBeNull();
      const previous = report(previousIndex, { version: "v-a", date: "2026-09-11" });
      const current = report(currentIndex, { version: "v-b", date: "2026-09-12" });
      const diff = await run(previous, current, null);
      await writeRequalification(diff, directory);
      expect(await readRequalification(directory)).toEqual(JSON.parse(JSON.stringify(diff)));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("committed requalification", () => {
  it("binds exactly the committed census and names only known owners", async () => {
    const [committed, census] = await Promise.all([readRequalification(), readLegalPoolReport()]);
    expect(committed).not.toBeNull();
    expect(committed!.version).toBe("evidence-requalification-v1");
    expect(committed!.current.bindings).toEqual(bindingsOf(census));
    expect(committed!.as_of).toBe(census.census.snapshot.snapshot);
    expect(committed!.current.rules_audit.corpus_sha256).toBe(
      (await loadRulesExcerpt()).excerpt.corpus.sha256,
    );
    expect(committed!.previous.bindings.ledger_digest).not.toBe("");
    for (const unit of committed!.requalification) {
      if (unit.owner !== null) expect(unit.suggested_chunk).toBe(unit.owner);
    }
  });
});

const dataRoot = await servedDataRoot();
const served = describe.skipIf(dataRoot === null);

served("committed requalification against the served snapshot", () => {
  it("matches the current evidence state of the served data root", async () => {
    const committed = await readRequalification();
    const { state } = await currentEvidenceState(dataRoot!, await readLegalPoolReport());
    expect(state).toEqual(committed!.current);
  }, 120_000);
});
