import { describe, expect, it } from "vitest";
import { parseComprehensiveRules } from "../rules/index.js";
import { loadRulesExcerpt, NOT_MODELED, runRulesAudit } from "./rulesAudit.js";

/**
 * Pinned digests. The corpus digest is the SHA-256 of the full
 * MagicCompRules 20260819.txt release (effective 2026-08-07) the excerpt was
 * cut from; the excerpt digest covers the fixture file itself. Either changing
 * means the audit must be re-read against a new release, never silently.
 */
const CORPUS_SHA256 = "4381ad1b39ab2c05f7d03633a20f711ed37277074d3266dcba5f38cbb527423f";
const EXCERPT_SHA256 = "f462cd092594ff759860326f703f1c82cdc90f16dc2a40536940cf2dffb7f3dc";

describe("Commander validation audit against the frozen Comprehensive Rules excerpt", () => {
  it("keeps the excerpt and its source release pinned", async () => {
    const { excerpt, digest } = await loadRulesExcerpt();
    expect(excerpt.corpus.sha256).toBe(CORPUS_SHA256);
    expect(excerpt.corpus.effective_date).toBe("2026-08-07");
    expect(excerpt.corpus.published_version).toBe("20260819");
    expect(digest).toBe(EXCERPT_SHA256);
  });

  it("freezes every rule the validators cite, in a shape the corpus parser reads back", async () => {
    const { excerpt } = await loadRulesExcerpt();
    for (const section of ["903", "702.124", "702.139"]) {
      expect(Object.keys(excerpt.rules).some((n) => n.startsWith(section))).toBe(true);
    }
    // The excerpt lines are release lines; the production parser must agree on their numbering.
    const text = Object.entries(excerpt.rules)
      .map(([number, body]) => `${number}${/^\d{3}\.\d+$/.test(number) ? "." : ""} ${body}`)
      .join("\r\n\r\n");
    const parsed = parseComprehensiveRules(
      `These rules are effective as of August 7, 2026.\r\n\r\n${text}`,
    );
    expect(parsed.rules.map((r) => r.number)).toEqual(Object.keys(excerpt.rules));
    expect(parsed.rules.map((r) => r.text)).toEqual(Object.values(excerpt.rules));
    expect(Object.keys(excerpt.glossary)).toContain("Commander");
    expect(Object.keys(excerpt.glossary)).toContain("Color Identity");
  });

  it("passes every audited configuration and quotes the load-bearing wording verbatim", async () => {
    const { excerpt } = await loadRulesExcerpt();
    const report = runRulesAudit(excerpt);
    const failures = report.cases
      .filter((c) => !c.passed)
      .map(
        (c) =>
          `${c.id}: expected [${c.expected.join(",")}] got [${c.actual.join(",")}]` +
          (c.missing_rules.length ? ` missing rules ${c.missing_rules.join(",")}` : "") +
          (c.missing_quotes.length
            ? ` missing quotes ${c.missing_quotes.map((q) => `${q.rule}:"${q.text}"`).join("; ")}`
            : ""),
      );
    expect(failures).toEqual([]);
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(report.cases.length);
    expect(report.cases.length).toBeGreaterThanOrEqual(25);
  });

  it("covers commander configurations, color identity, singleton, companions and eligible types", async () => {
    const { excerpt } = await loadRulesExcerpt();
    const { coverage } = runRulesAudit(excerpt);
    for (const rule of [
      "903.3",
      "903.3a",
      "903.4",
      "903.5a",
      "903.5b",
      "903.5c",
      "702.124c",
      "702.124f",
      "702.124h",
      "702.124i",
      "702.124j",
      "702.124k",
      "702.124m",
      "702.139a",
      "702.139b",
    ]) {
      expect(coverage.cited).toContain(rule);
    }
    for (const entry of NOT_MODELED) {
      expect(entry.rule in excerpt.rules).toBe(true);
      expect(coverage.cited).not.toContain(entry.rule);
    }
  });
});
