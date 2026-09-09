import { describe, expect, it } from "vitest";
import { classifyRulingSource, parseRuling, parseRulingsText, RulingsCorpus } from "./rulings.js";

const WOTC = {
  object: "ruling",
  oracle_id: "53236dd7-845a-444c-96d5-f41ed7325d8f",
  source: "wotc",
  published_at: "2023-09-01",
  comment: "Rhystic Study's triggered ability resolves before the spell that caused it to trigger.",
};
const NOTE = {
  object: "ruling",
  oracle_id: "53236dd7-845a-444c-96d5-f41ed7325d8f",
  source: "scryfall",
  published_at: "2024-02-10",
  comment: "Scryfall note: this card was reprinted with updated wording.",
};
const OTHER = {
  oracle_id: "6ad8011d-3471-4369-9d68-b264cc027487",
  source: "community",
  comment: "A ruling with an unrecognized source and no date.",
};

describe("classifyRulingSource", () => {
  it("distinguishes Wizards rulings from provider notes and preserves other sources", () => {
    expect(classifyRulingSource("wotc")).toBe("wizards_ruling");
    expect(classifyRulingSource("scryfall")).toBe("provider_note");
    expect(classifyRulingSource("community")).toBe("other");
    expect(classifyRulingSource("")).toBe("other");
  });
});

describe("parseRuling", () => {
  it("keeps identity, raw source, source type, date and comment", () => {
    expect(parseRuling(WOTC)).toEqual({
      oracle_id: WOTC.oracle_id,
      source: "wotc",
      source_type: "wizards_ruling",
      published_at: "2023-09-01",
      comment: WOTC.comment,
    });
    expect(parseRuling(OTHER)).toEqual({
      oracle_id: OTHER.oracle_id,
      source: "community",
      source_type: "other",
      published_at: null,
      comment: OTHER.comment,
    });
  });

  it("rejects records without an oracle identity or comment", () => {
    expect(parseRuling({ source: "wotc", comment: "orphan" })).toBeNull();
    expect(parseRuling({ oracle_id: "x", source: "wotc" })).toBeNull();
    expect(parseRuling("not an object")).toBeNull();
    expect(parseRuling({ oracle_id: "x", comment: 5 })).toBeNull();
  });
});

describe("parseRulingsText", () => {
  it("reads JSONL, tolerates blank lines and counts malformed lines without dropping the rest", () => {
    const text = [
      JSON.stringify(WOTC),
      "",
      "{not json",
      JSON.stringify(NOTE),
      JSON.stringify(OTHER),
    ].join("\n");
    const parsed = parseRulingsText(text);
    expect(parsed.malformed_lines).toBe(1);
    expect(parsed.corpus.rulingCount).toBe(3);
    expect(parsed.corpus.cardCount).toBe(2);
    expect(parsed.corpus.rulingsFor(WOTC.oracle_id).map((r) => r.source_type)).toEqual([
      "wizards_ruling",
      "provider_note",
    ]);
  });

  it("reads a legacy JSON array export too", () => {
    const parsed = parseRulingsText(JSON.stringify([WOTC, NOTE]));
    expect(parsed.malformed_lines).toBe(0);
    expect(parsed.corpus.rulingCount).toBe(2);
  });
});

describe("RulingsCorpus", () => {
  const corpus = new RulingsCorpus([parseRuling(WOTC)!, parseRuling(NOTE)!, parseRuling(OTHER)!]);

  it("orders a card's rulings by publication date with undated rulings last", () => {
    const undated = { ...parseRuling(WOTC)!, published_at: null, comment: "undated" };
    const later = { ...parseRuling(WOTC)!, published_at: "2025-01-01", comment: "later" };
    const ordered = new RulingsCorpus([later, undated, parseRuling(WOTC)!]);
    expect(ordered.rulingsFor(WOTC.oracle_id).map((r) => r.comment)).toEqual([
      WOTC.comment,
      "later",
      "undated",
    ]);
  });

  it("preserves missingness: a card absent from the export has no rulings recorded", () => {
    expect(corpus.has("00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(corpus.rulingsFor("00000000-0000-4000-8000-000000000000")).toEqual([]);
    expect(corpus.has(OTHER.oracle_id)).toBe(true);
  });

  it("summarizes counts by source type", () => {
    expect(corpus.countsFor(WOTC.oracle_id)).toEqual({
      total: 2,
      wizards_ruling: 1,
      provider_note: 1,
      other: 0,
    });
  });
});
