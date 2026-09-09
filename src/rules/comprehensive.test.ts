import { describe, expect, it } from "vitest";
import {
  ComprehensiveRulesCorpus,
  normalizeRuleNumber,
  parseComprehensiveRules,
} from "./comprehensive.js";

/** A release-shaped excerpt: BOM, CRLF, contents duplicating headings, glossary, credits. */
const SAMPLE =
  "﻿Magic: The Gathering Comprehensive Rules\r\n" +
  "\r\n" +
  "These rules are effective as of August 7, 2026.\r\n" +
  "\r\n" +
  "Introduction\r\n" +
  "\r\n" +
  "This document is the ultimate authority.\r\n" +
  "\r\n" +
  "Contents\r\n" +
  "\r\n" +
  "7. Additional Rules\r\n" +
  "702. Keyword Abilities\r\n" +
  "704. State-Based Actions\r\n" +
  "\r\n" +
  "9. Casual Variants\r\n" +
  "903. Commander\r\n" +
  "\r\n" +
  "Glossary\r\n" +
  "\r\n" +
  "Credits\r\n" +
  "\r\n" +
  "7. Additional Rules\r\n" +
  "\r\n" +
  "702. Keyword Abilities\r\n" +
  "\r\n" +
  "702.124. Partner\r\n" +
  "\r\n" +
  "702.124a Partner abilities are keyword abilities that modify the rules for deck construction in the Commander variant (see rule 903).\r\n" +
  "\r\n" +
  "702.124i “Partner—[text]” means “You may designate two legendary cards as your commander rather than one if each of them has the same ‘partner—[text]’ ability.”\r\n" +
  "\r\n" +
  "704. State-Based Actions\r\n" +
  "\r\n" +
  "704.5aa If a player controls a permanent with start your engines! and that player has no speed, that player’s speed becomes 1.\r\n" +
  "\r\n" +
  "9. Casual Variants\r\n" +
  "\r\n" +
  "903. Commander\r\n" +
  "\r\n" +
  "903.1. In the Commander variant, each deck is led by a legendary creature designated as that deck’s commander.\r\n" +
  "\r\n" +
  "903.3. Each deck has a legendary card designated as its commander. That card must be either (a) a creature card, (b) a Vehicle card, or (c) a Spacecraft card with one or more power/toughness boxes.\r\n" +
  "\r\n" +
  "903.3a Some cards have an ability that states the card can be your commander.\r\n" +
  "\r\n" +
  "903.5. Each Commander deck is subject to the following deck construction rules.\r\n" +
  "\r\n" +
  "903.5a Each deck must contain exactly 100 cards, including its commander.\r\n" +
  "\r\n" +
  "903.5b Other than basic lands, each card in a Commander deck must have a different English name.\r\n" +
  "\r\n" +
  "Glossary\r\n" +
  "\r\n" +
  "Commander\r\n" +
  "1. A casual variant in which each deck is led by a legendary creature. See rule 903, “Commander.”\r\n" +
  "2. A designation given to one or more legendary cards.\r\n" +
  "\r\n" +
  "Commander Tax\r\n" +
  "An informal term for the additional cost to cast a commander from the command zone. See rule 903.8.\r\n" +
  "\r\n" +
  "Credits\r\n" +
  "\r\n" +
  "Magic: The Gathering Original Game Design: Richard Garfield\r\n";

describe("parseComprehensiveRules", () => {
  const parsed = parseComprehensiveRules(SAMPLE);

  it("reads the effective date, chapters, sections and numbered rules from the body only", () => {
    expect(parsed.effective_date).toBe("2026-08-07");
    expect(parsed.effective_date_text).toBe("These rules are effective as of August 7, 2026.");
    expect(parsed.chapters).toEqual([
      { number: "7", title: "Additional Rules" },
      { number: "9", title: "Casual Variants" },
    ]);
    expect(parsed.sections).toEqual([
      { number: "702", chapter: "7", title: "Keyword Abilities" },
      { number: "704", chapter: "7", title: "State-Based Actions" },
      { number: "903", chapter: "9", title: "Commander" },
    ]);
    expect(parsed.rules.map((r) => r.number)).toEqual([
      "702.124",
      "702.124a",
      "702.124i",
      "704.5aa",
      "903.1",
      "903.3",
      "903.3a",
      "903.5",
      "903.5a",
      "903.5b",
    ]);
  });

  it("keeps rule text verbatim, including two-letter subrules and typographic quotes", () => {
    const byNumber = new Map(parsed.rules.map((r) => [r.number, r]));
    expect(byNumber.get("704.5aa")).toEqual({
      number: "704.5aa",
      section: "704",
      chapter: "7",
      text: "If a player controls a permanent with start your engines! and that player has no speed, that player’s speed becomes 1.",
    });
    expect(byNumber.get("702.124")?.text).toBe("Partner");
    expect(byNumber.get("702.124i")?.text).toContain("‘partner—[text]’");
    expect(byNumber.get("903.3")?.text.startsWith("Each deck has a legendary card")).toBe(true);
  });

  it("parses glossary terms with multi-paragraph definitions and stops at the credits", () => {
    expect(parsed.glossary).toEqual([
      {
        term: "Commander",
        text:
          "1. A casual variant in which each deck is led by a legendary creature. See rule 903, “Commander.”\n" +
          "2. A designation given to one or more legendary cards.",
      },
      {
        term: "Commander Tax",
        text: "An informal term for the additional cost to cast a commander from the command zone. See rule 903.8.",
      },
    ]);
  });

  it("reports a missing effective date and an empty body honestly", () => {
    const empty = parseComprehensiveRules("Just some text\r\nwith no rules");
    expect(empty.effective_date).toBeNull();
    expect(empty.effective_date_text).toBeNull();
    expect(empty.rules).toEqual([]);
    expect(empty.glossary).toEqual([]);
  });
});

describe("normalizeRuleNumber", () => {
  it("accepts rule, subrule, section and chapter identifiers with optional trailing periods", () => {
    expect(normalizeRuleNumber(" 903.3a. ")).toBe("903.3a");
    expect(normalizeRuleNumber("903.3A")).toBe("903.3a");
    expect(normalizeRuleNumber("704.5AA")).toBe("704.5aa");
    expect(normalizeRuleNumber("903.")).toBe("903");
    expect(normalizeRuleNumber("9")).toBe("9");
    expect(normalizeRuleNumber("rule 903.5b")).toBe("903.5b");
  });

  it("rejects identifiers that are not rule-shaped", () => {
    expect(normalizeRuleNumber("commander")).toBeNull();
    expect(normalizeRuleNumber("903.3abc")).toBeNull();
    expect(normalizeRuleNumber("")).toBeNull();
    expect(normalizeRuleNumber("903.x")).toBeNull();
  });
});

describe("ComprehensiveRulesCorpus lookup", () => {
  const corpus = new ComprehensiveRulesCorpus(parseComprehensiveRules(SAMPLE));

  it("returns the exact rule, its section and chapter for a known identifier", () => {
    const hit = corpus.lookup("903.5a.");
    expect(hit).toMatchObject({
      requested: "903.5a.",
      number: "903.5a",
      status: "found",
      kind: "rule",
      section: { number: "903", title: "Commander" },
      chapter: { number: "9", title: "Casual Variants" },
    });
    expect(hit.status === "found" && hit.kind === "rule" ? hit.rule.text : null).toBe(
      "Each deck must contain exactly 100 cards, including its commander.",
    );
  });

  it("returns a section with its top-level rule identifiers", () => {
    const hit = corpus.lookup("903");
    expect(hit.status).toBe("found");
    if (hit.status === "found" && hit.kind === "section") {
      expect(hit.section.title).toBe("Commander");
      expect(hit.rules).toEqual(["903.1", "903.3", "903.5"]);
      expect(hit.rule_count).toBe(6);
    } else {
      throw new Error("expected a section hit");
    }
  });

  it("returns a chapter with its section identifiers", () => {
    const hit = corpus.lookup("9");
    expect(hit.status).toBe("found");
    if (hit.status === "found" && hit.kind === "chapter") {
      expect(hit.sections).toEqual([{ number: "903", title: "Commander" }]);
    } else {
      throw new Error("expected a chapter hit");
    }
  });

  it("reports an unknown identifier explicitly with the nearest existing prefix", () => {
    expect(corpus.lookup("903.3z")).toEqual({
      requested: "903.3z",
      number: "903.3z",
      status: "unknown",
      reason: "not_in_corpus",
      nearest: "903.3",
    });
    expect(corpus.lookup("903.9")).toMatchObject({ status: "unknown", nearest: "903" });
    expect(corpus.lookup("999.1")).toMatchObject({ status: "unknown", nearest: "9" });
    expect(corpus.lookup("099.1")).toMatchObject({ status: "unknown", nearest: null });
  });

  it("reports an identifier that is not rule-shaped without guessing", () => {
    expect(corpus.lookup("the commander rule")).toEqual({
      requested: "the commander rule",
      number: null,
      status: "unknown",
      reason: "not_a_rule_number",
      nearest: null,
    });
  });

  it("looks up glossary terms case-insensitively and reports missing terms", () => {
    expect(corpus.glossary("commander tax")).toEqual({
      requested: "commander tax",
      status: "found",
      term: "Commander Tax",
      text: "An informal term for the additional cost to cast a commander from the command zone. See rule 903.8.",
    });
    expect(corpus.glossary("Planechase")).toEqual({
      requested: "Planechase",
      status: "unknown",
      reason: "not_in_corpus",
    });
  });
});

describe("ComprehensiveRulesCorpus search", () => {
  const corpus = new ComprehensiveRulesCorpus(parseComprehensiveRules(SAMPLE));

  it("requires every token, ranks by matches and bounds the excerpt", () => {
    const result = corpus.search("commander legendary", { limit: 2, excerpt_chars: 100 });
    expect(result.tokens).toEqual(["commander", "legendary"]);
    expect(result.total_matches).toBeGreaterThan(2);
    expect(result.results).toHaveLength(2);
    expect(result.truncated).toBe(true);
    for (const hit of result.results) {
      // The window plus at most one ellipsis on each side.
      expect(hit.excerpt.length).toBeLessThanOrEqual(100 + 2);
      expect(hit.complete).toBe(false);
      expect(hit.excerpt.toLowerCase()).toContain("commander");
      expect(hit.section).toEqual({ number: expect.any(String), title: expect.any(String) });
      expect(hit.matches).toBeGreaterThan(0);
    }
    // 903.1 mentions "commander" twice and "legendary" once; every other hit has fewer.
    expect(result.results[0]?.number).toBe("903.1");
    expect(result.results[0]!.matches).toBeGreaterThanOrEqual(result.results[1]!.matches);
  });

  it("restricts results to a section or chapter prefix", () => {
    const section = corpus.search("commander", { section: "903" });
    expect(section.results.every((hit) => hit.number.startsWith("903."))).toBe(true);
    const chapter = corpus.search("commander", { section: "7" });
    expect(chapter.results.every((hit) => hit.number.startsWith("70"))).toBe(true);
    expect(corpus.search("commander", { section: "999" }).results).toEqual([]);
  });

  it("returns glossary matches separately and reports an empty query", () => {
    const result = corpus.search("commander tax");
    expect(result.glossary.map((g) => g.term)).toEqual(["Commander Tax"]);
    const empty = corpus.search("   ");
    expect(empty.tokens).toEqual([]);
    expect(empty.results).toEqual([]);
    expect(empty.total_matches).toBe(0);
  });

  it("clamps the limit to the documented maximum", () => {
    expect(corpus.search("commander", { limit: 500 }).limit).toBe(25);
    expect(corpus.search("commander", { limit: 0 }).limit).toBe(1);
  });
});
