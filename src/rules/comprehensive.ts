/**
 * Comprehensive Rules corpus (Commander workshop: rules and combo intelligence).
 *
 * Parses the official plain-text release into numbered rules, section and
 * chapter headings and glossary entries, and answers exact identifier lookups
 * and bounded keyword searches over them. Text is returned verbatim; an
 * identifier the release does not contain is reported as unknown with the
 * nearest existing prefix, never resolved to a guess. Rules are renumbered
 * between releases, so callers must read the corpus provenance alongside any
 * identifier they cite.
 */
import type {
  ComprehensiveRules,
  GlossaryEntry,
  RuleChapter,
  RuleEntry,
  RuleSection,
} from "../types/rules.js";

/** `903.5a`, `704.5aa`, `903.1.` — subrules use one or two lowercase letters. */
const RULE_LINE = /^(\d{3})\.(\d+)([a-z]{1,2})?\.?\s+(.*)$/;
const SECTION_LINE = /^(\d{3})\.\s+(\S.*)$/;
const CHAPTER_LINE = /^(\d)\.\s+(\S.*)$/;
const EFFECTIVE_LINE = /^These rules are effective as of (.+?)\.?$/i;
const IDENTIFIER = /^(\d)(?:(\d{2})(?:\.(\d+)([a-z]{1,2})?)?)?$/;

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

/** "August 7, 2026" -> "2026-08-07"; null when the phrase is not a recognizable date. */
export function parseLongDate(phrase: string): string | null {
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/.exec(phrase.trim());
  if (!match) return null;
  const month = MONTHS[match[1]!.toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${month}-${match[2]!.padStart(2, "0")}`;
}

/**
 * Normalize a user-supplied identifier to its canonical form: chapter (`9`),
 * section (`903`), rule (`903.3`) or subrule (`903.3a`, `704.5aa`). Returns
 * null for anything that is not rule-shaped.
 */
export function normalizeRuleNumber(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^rule\s+/, "").replace(/\.$/, "");
  const match = IDENTIFIER.exec(value);
  if (!match) return null;
  const [, chapter, section, rule, sub] = match;
  if (section === undefined) return chapter!;
  if (rule === undefined) return `${chapter}${section}`;
  return `${chapter}${section}.${rule}${sub ?? ""}`;
}

/**
 * Parse one Comprehensive Rules text release. The body is the text after the
 * "Contents" listing; headings there are duplicated in the body, so headings
 * are only recorded where they precede rules. The glossary is the block
 * between the final "Glossary" line and the final "Credits" line.
 */
export function parseComprehensiveRules(text: string): ComprehensiveRules {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let effectiveDate: string | null = null;
  let effectiveText: string | null = null;
  for (const line of lines.slice(0, 40)) {
    const match = EFFECTIVE_LINE.exec(line.trim());
    if (match) {
      effectiveText = line.trim();
      effectiveDate = parseLongDate(match[1]!);
      break;
    }
  }

  const glossaryStart = lastIndexOf(lines, "Glossary");
  const creditsStart = lastIndexOf(lines, "Credits");
  const bodyEnd = glossaryStart >= 0 ? glossaryStart : lines.length;

  const chapters: RuleChapter[] = [];
  const sections: RuleSection[] = [];
  const rules: RuleEntry[] = [];
  const seenChapters = new Set<string>();
  const seenSections = new Set<string>();
  // Headings are listed once in the contents and once in the body; only a
  // heading that is followed by its rules counts, so record it lazily when the
  // first rule under it appears.
  let pendingChapter: RuleChapter | null = null;
  let pendingSection: RuleSection | null = null;
  for (let i = 0; i < bodyEnd; i += 1) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    const rule = RULE_LINE.exec(line);
    if (rule) {
      const [, section, ordinal, sub, body] = rule;
      const chapter = section![0]!;
      if (pendingChapter && !seenChapters.has(pendingChapter.number)) {
        chapters.push(pendingChapter);
        seenChapters.add(pendingChapter.number);
      }
      if (pendingSection && !seenSections.has(pendingSection.number)) {
        sections.push(pendingSection);
        seenSections.add(pendingSection.number);
      }
      rules.push({
        number: `${section}.${ordinal}${sub ?? ""}`,
        section: section!,
        chapter,
        text: body!.trim(),
      });
      continue;
    }
    const section = SECTION_LINE.exec(line);
    if (section) {
      pendingSection = {
        number: section[1]!,
        chapter: section[1]![0]!,
        title: section[2]!.trim(),
      };
      continue;
    }
    const chapter = CHAPTER_LINE.exec(line);
    if (chapter) {
      pendingChapter = { number: chapter[1]!, title: chapter[2]!.trim() };
    }
  }

  const glossary: GlossaryEntry[] = [];
  if (glossaryStart >= 0) {
    const end = creditsStart > glossaryStart ? creditsStart : lines.length;
    let term: string | null = null;
    let paragraphs: string[] = [];
    const flush = () => {
      if (term !== null && paragraphs.length > 0) {
        glossary.push({ term, text: paragraphs.join("\n") });
      }
      term = null;
      paragraphs = [];
    };
    for (let i = glossaryStart + 1; i < end; i += 1) {
      const line = lines[i]!.trim();
      if (line.length === 0) {
        flush();
        continue;
      }
      if (term === null) term = line;
      else paragraphs.push(line);
    }
    flush();
  }

  return {
    effective_date: effectiveDate,
    effective_date_text: effectiveText,
    chapters,
    sections,
    rules,
    glossary,
  };
}

function lastIndexOf(lines: readonly string[], heading: string): number {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]!.trim() === heading) return i;
  }
  return -1;
}

/** Heading reference embedded in lookup and search results. */
export interface HeadingRef {
  number: string;
  title: string;
}

export type RuleLookupResult =
  | {
      requested: string;
      number: string;
      status: "found";
      kind: "rule";
      rule: RuleEntry;
      section: HeadingRef;
      chapter: HeadingRef;
    }
  | {
      requested: string;
      number: string;
      status: "found";
      kind: "section";
      section: HeadingRef;
      chapter: HeadingRef;
      /** Top-level rule identifiers (no subrule letter) in document order. */
      rules: string[];
      /** Every rule and subrule in the section. */
      rule_count: number;
    }
  | {
      requested: string;
      number: string;
      status: "found";
      kind: "chapter";
      chapter: HeadingRef;
      sections: HeadingRef[];
    }
  | {
      requested: string;
      number: string | null;
      status: "unknown";
      reason: "not_in_corpus" | "not_a_rule_number";
      /** Longest existing identifier prefix, when the requested one is rule-shaped. */
      nearest: string | null;
    };

export type GlossaryLookupResult =
  | { requested: string; status: "found"; term: string; text: string }
  | { requested: string; status: "unknown"; reason: "not_in_corpus" };

export interface RuleSearchOptions {
  /** Maximum rule hits, 1..25 (default 10). */
  limit?: number;
  /** Restrict to a chapter (`9`) or section (`903`) prefix. */
  section?: string;
  /** Excerpt window in characters, 80..600 (default 240). */
  excerpt_chars?: number;
}

export interface RuleSearchHit {
  number: string;
  section: HeadingRef;
  /** A bounded window of the rule text around the first match; "…" marks cuts. */
  excerpt: string;
  /** Total token occurrences in the rule text. */
  matches: number;
  /** True when the excerpt is the complete rule text. */
  complete: boolean;
}

export interface RuleSearchResult {
  query: string;
  tokens: string[];
  section: string | null;
  limit: number;
  total_matches: number;
  returned: number;
  truncated: boolean;
  results: RuleSearchHit[];
  glossary: Array<{ term: string; excerpt: string; complete: boolean }>;
}

export const RULE_SEARCH_MAX_LIMIT = 25;
export const RULE_SEARCH_DEFAULT_LIMIT = 10;
const EXCERPT_DEFAULT = 240;
const EXCERPT_MIN = 80;
const EXCERPT_MAX = 600;
const GLOSSARY_HIT_LIMIT = 5;

function tokenize(query: string): string[] {
  const seen = new Set<string>();
  for (const token of query.toLowerCase().split(/[^\p{L}\p{N}'’-]+/u)) {
    const cleaned = token.replace(/^['’-]+|['’-]+$/g, "");
    if (cleaned.length > 0) seen.add(cleaned);
  }
  return [...seen];
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

function excerptAround(
  text: string,
  lower: string,
  tokens: readonly string[],
  chars: number,
): { excerpt: string; complete: boolean } {
  if (text.length <= chars) return { excerpt: text, complete: true };
  let first = -1;
  for (const token of tokens) {
    const at = lower.indexOf(token);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }
  const anchor = first === -1 ? 0 : first;
  let start = Math.max(0, anchor - Math.floor(chars / 3));
  let end = Math.min(text.length, start + chars);
  if (end - start < chars) start = Math.max(0, end - chars);
  // Prefer word boundaries so a cut never splits a word in half.
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space !== -1 && space < anchor) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > anchor + 1) end = space;
  }
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return { excerpt: `${prefix}${text.slice(start, end)}${suffix}`, complete: false };
}

/** Indexed corpus answering exact lookups and bounded searches. */
export class ComprehensiveRulesCorpus {
  readonly parsed: ComprehensiveRules;
  private readonly rulesByNumber = new Map<string, RuleEntry>();
  private readonly sectionsByNumber = new Map<string, RuleSection>();
  private readonly chaptersByNumber = new Map<string, RuleChapter>();
  private readonly glossaryByTerm = new Map<string, GlossaryEntry>();
  private readonly lowered: string[];

  constructor(parsed: ComprehensiveRules) {
    this.parsed = parsed;
    for (const rule of parsed.rules) this.rulesByNumber.set(rule.number, rule);
    for (const section of parsed.sections) this.sectionsByNumber.set(section.number, section);
    for (const chapter of parsed.chapters) this.chaptersByNumber.set(chapter.number, chapter);
    for (const entry of parsed.glossary) this.glossaryByTerm.set(entry.term.toLowerCase(), entry);
    this.lowered = parsed.rules.map((rule) => rule.text.toLowerCase());
  }

  get ruleCount(): number {
    return this.parsed.rules.length;
  }

  get glossaryCount(): number {
    return this.parsed.glossary.length;
  }

  private headingRef(kind: "section" | "chapter", number: string): HeadingRef {
    const heading =
      kind === "section" ? this.sectionsByNumber.get(number) : this.chaptersByNumber.get(number);
    return { number, title: heading?.title ?? "" };
  }

  /** Exact identifier lookup; unknown identifiers are reported, never approximated. */
  lookup(requested: string): RuleLookupResult {
    const number = normalizeRuleNumber(requested);
    if (number === null) {
      return {
        requested,
        number: null,
        status: "unknown",
        reason: "not_a_rule_number",
        nearest: null,
      };
    }
    const rule = this.rulesByNumber.get(number);
    if (rule) {
      return {
        requested,
        number,
        status: "found",
        kind: "rule",
        rule,
        section: this.headingRef("section", rule.section),
        chapter: this.headingRef("chapter", rule.chapter),
      };
    }
    if (number.length === 3 && this.sectionsByNumber.has(number)) {
      const inSection = this.parsed.rules.filter((r) => r.section === number);
      return {
        requested,
        number,
        status: "found",
        kind: "section",
        section: this.headingRef("section", number),
        chapter: this.headingRef("chapter", number[0]!),
        rules: inSection.filter((r) => /^\d{3}\.\d+$/.test(r.number)).map((r) => r.number),
        rule_count: inSection.length,
      };
    }
    if (number.length === 1 && this.chaptersByNumber.has(number)) {
      return {
        requested,
        number,
        status: "found",
        kind: "chapter",
        chapter: this.headingRef("chapter", number),
        sections: this.parsed.sections
          .filter((s) => s.chapter === number)
          .map((s) => ({ number: s.number, title: s.title })),
      };
    }
    return {
      requested,
      number,
      status: "unknown",
      reason: "not_in_corpus",
      nearest: this.nearest(number),
    };
  }

  /** Longest existing prefix of a rule-shaped identifier: subrule -> rule -> section -> chapter. */
  private nearest(number: string): string | null {
    const candidates: string[] = [];
    const sub = /^(\d{3}\.\d+)[a-z]{1,2}$/.exec(number);
    if (sub) candidates.push(sub[1]!);
    if (number.length > 3) candidates.push(number.slice(0, 3));
    if (number.length > 1) candidates.push(number[0]!);
    for (const candidate of candidates) {
      if (
        this.rulesByNumber.has(candidate) ||
        this.sectionsByNumber.has(candidate) ||
        this.chaptersByNumber.has(candidate)
      ) {
        return candidate;
      }
    }
    return null;
  }

  glossary(requested: string): GlossaryLookupResult {
    const entry = this.glossaryByTerm.get(requested.trim().toLowerCase());
    if (!entry) return { requested, status: "unknown", reason: "not_in_corpus" };
    return { requested, status: "found", term: entry.term, text: entry.text };
  }

  /** Bounded AND-token search over rule text (plus glossary), ranked by occurrences. */
  search(query: string, options: RuleSearchOptions = {}): RuleSearchResult {
    const tokens = tokenize(query);
    const limit = Math.min(
      RULE_SEARCH_MAX_LIMIT,
      Math.max(1, Math.floor(options.limit ?? RULE_SEARCH_DEFAULT_LIMIT)),
    );
    const chars = Math.min(
      EXCERPT_MAX,
      Math.max(EXCERPT_MIN, options.excerpt_chars ?? EXCERPT_DEFAULT),
    );
    const section = options.section ? normalizeRuleNumber(options.section) : null;
    const base = {
      query,
      tokens,
      section,
      limit,
      results: [] as RuleSearchHit[],
      glossary: [] as RuleSearchResult["glossary"],
    };
    if (tokens.length === 0) {
      return { ...base, total_matches: 0, returned: 0, truncated: false };
    }
    const scored: Array<{ index: number; matches: number }> = [];
    for (let i = 0; i < this.parsed.rules.length; i += 1) {
      const rule = this.parsed.rules[i]!;
      if (section !== null && !rule.number.startsWith(section)) continue;
      const lower = this.lowered[i]!;
      let matches = 0;
      let all = true;
      for (const token of tokens) {
        const count = countOccurrences(lower, token);
        if (count === 0) {
          all = false;
          break;
        }
        matches += count;
      }
      if (all) scored.push({ index: i, matches });
    }
    scored.sort((a, b) => b.matches - a.matches || a.index - b.index);
    const results = scored.slice(0, limit).map(({ index, matches }) => {
      const rule = this.parsed.rules[index]!;
      const { excerpt, complete } = excerptAround(rule.text, this.lowered[index]!, tokens, chars);
      return {
        number: rule.number,
        section: this.headingRef("section", rule.section),
        excerpt,
        matches,
        complete,
      };
    });
    const glossary: RuleSearchResult["glossary"] = [];
    if (section === null) {
      for (const entry of this.parsed.glossary) {
        const lower = `${entry.term}\n${entry.text}`.toLowerCase();
        if (!tokens.every((token) => lower.includes(token))) continue;
        const { excerpt, complete } = excerptAround(
          entry.text,
          entry.text.toLowerCase(),
          tokens,
          chars,
        );
        glossary.push({ term: entry.term, excerpt, complete });
        if (glossary.length >= GLOSSARY_HIT_LIMIT) break;
      }
    }
    return {
      ...base,
      total_matches: scored.length,
      returned: results.length,
      truncated: scored.length > results.length,
      results,
      glossary,
    };
  }
}
