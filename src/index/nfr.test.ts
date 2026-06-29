/**
 * Non-functional requirements (spec §11): determinism and latency.
 *
 * Determinism — identical inputs against a fixed data_snapshot must yield byte-
 * identical outputs: the query evaluator's ordering has an oracle_id tiebreak
 * and opaque, stable cursors; the validate/analyze engines are pure. Latency —
 * local search/validation/analysis target <50ms. The smoke assertion uses a
 * generous CI-safe ceiling (shared runners are noisy); the real budget is 50ms.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "./index.js";
import { parseQuery } from "../query/index.js";
import { validateCore, validateCommander } from "../validate/index.js";
import { analyzeStats } from "../analyze/index.js";
import type { Deck } from "../types/index.js";

/** Several creatures, two sharing mv (to exercise the oracle_id tiebreak). */
const ORACLE = [
  mk("o-a", "Aaa", 2),
  mk("o-b", "Bbb", 2), // same mv as Aaa -> tiebreak must order by oracle_id
  mk("o-c", "Ccc", 3),
  mk("o-d", "Ddd", 1),
  mk("o-e", "Eee", 4),
];
function mk(oracle_id: string, name: string, cmc: number) {
  return {
    oracle_id,
    id: `p-${oracle_id}`,
    name,
    cmc,
    colors: ["G"],
    color_identity: ["G"],
    type_line: "Creature — Beast",
    oracle_text: "",
    legalities: { commander: "legal" },
    prices: { usd: "0.10" },
  };
}

let root: string;
let index: CardIndex;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-nfr-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
  await store.publish("v1");
  index = CardIndex.open((await buildIndex({ store })).dbPath);
});
afterEach(async () => {
  index.close();
  await rm(root, { recursive: true, force: true });
});

describe("determinism (§11)", () => {
  it("identical query + snapshot yields identical evaluator output", () => {
    const node = parseQuery("t:creature");
    const a = index.evaluate(node, { order: "mv", limit: 3 });
    const b = index.evaluate(node, { order: "mv", limit: 3 });
    expect(b).toEqual(a);
    expect(a.results.length).toBe(3);
  });

  it("orders deterministically with an oracle_id tiebreak on equal sort keys", () => {
    const node = parseQuery("t:creature");
    const r = index.evaluate(node, { order: "mv", limit: 10 });
    // Aaa and Bbb both mv 2; the tiebreak must place o-a before o-b, every run.
    const ids = r.results.map((c) => c.oracle_id);
    expect(ids.indexOf("o-a")).toBeLessThan(ids.indexOf("o-b"));
    const again = index.evaluate(node, { order: "mv", limit: 10 }).results.map((c) => c.oracle_id);
    expect(again).toEqual(ids);
  });

  it("paginates with stable opaque cursors", () => {
    const node = parseQuery("t:creature");
    const page1 = index.evaluate(node, { order: "mv", limit: 2 });
    expect(page1.nextCursor).toBeTruthy();
    const page2a = index.evaluate(node, { order: "mv", limit: 2, cursor: page1.nextCursor });
    const page2b = index.evaluate(node, { order: "mv", limit: 2, cursor: page1.nextCursor });
    expect(page2b).toEqual(page2a);
    // No overlap between page 1 and page 2.
    const p1 = new Set(page1.results.map((c) => c.oracle_id));
    expect(page2a.results.every((c) => !p1.has(c.oracle_id))).toBe(true);
  });

  it("pure validation + analysis are deterministic", () => {
    const deck: Deck = {
      deck_id: "d1",
      name: "T",
      format: "commander",
      commanders: [],
      command_zone_kind: "single",
      cards: [
        { oracle_id: "o-a", qty: 1 },
        { oracle_id: "o-c", qty: 1 },
      ],
      computed_color_identity: ["G"],
      version: 1,
      data_snapshot: "2026-06-27",
    };
    const lookup = (id: string) => index.getCard(id);
    expect(validateCore(deck, lookup)).toEqual(validateCore(deck, lookup));
    expect(validateCommander(deck, lookup)).toEqual(validateCommander(deck, lookup));
    expect(analyzeStats(deck.cards, lookup)).toEqual(analyzeStats(deck.cards, lookup));
  });
});

describe("latency smoke (§11)", () => {
  it("evaluates well under the CI-safe ceiling (target <50ms typical)", () => {
    const node = parseQuery("t:creature");
    const N = 50;
    const samples: number[] = [];
    for (let i = 0; i < N; i += 1) {
      const t0 = performance.now();
      index.evaluate(node, { order: "mv", limit: 20 });
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(N / 2)] ?? 0;
    // Real target is <50ms; ceiling is generous to avoid flaking on shared CI.
    expect(p50).toBeLessThan(200);
  });
});
