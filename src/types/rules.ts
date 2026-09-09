/**
 * Rules and rulings evidence (Commander workshop: rules and combo intelligence).
 *
 * The server retrieves two versioned external corpora and answers from them
 * verbatim: the Magic Comprehensive Rules (a numbered text document published
 * by Wizards of the Coast) and card rulings (Scryfall's bulk `rulings` export,
 * which carries both official Wizards rulings and Scryfall's own notes). Every
 * answer names the exact identifier it came from and the corpus version it was
 * read from. Nothing here interprets rules or judges an interaction.
 */

/** One numbered rule or subrule, e.g. `903.3` or `704.5aa`. */
export interface RuleEntry {
  /** Canonical identifier without a trailing period, e.g. "903.5a". */
  number: string;
  /** Three-digit section, e.g. "903". */
  section: string;
  /** Single-digit chapter, e.g. "9". */
  chapter: string;
  /** Verbatim rule text following the identifier. */
  text: string;
}

/** A numbered section heading, e.g. `903. Commander`. */
export interface RuleSection {
  number: string;
  chapter: string;
  title: string;
}

/** A chapter heading, e.g. `9. Casual Variants`. */
export interface RuleChapter {
  number: string;
  title: string;
}

/** A glossary term and its verbatim definition paragraphs. */
export interface GlossaryEntry {
  term: string;
  text: string;
}

/** Everything parsed from one Comprehensive Rules text release. */
export interface ComprehensiveRules {
  /** ISO date parsed from the "effective as of" line, or null when absent. */
  effective_date: string | null;
  /** The verbatim effective-date sentence, preserved for provenance. */
  effective_date_text: string | null;
  chapters: RuleChapter[];
  sections: RuleSection[];
  rules: RuleEntry[];
  glossary: GlossaryEntry[];
}

/**
 * Who authored a ruling. Scryfall's `source` is `wotc` for official Wizards
 * rulings and `scryfall` for the provider's own notes; any other value is
 * preserved verbatim and classified as `other`.
 */
export type RulingSourceType = "wizards_ruling" | "provider_note" | "other";

/** One ruling as published, keyed by canonical Oracle identity. */
export interface CardRuling {
  oracle_id: string;
  /** The provider's raw source value, e.g. "wotc" or "scryfall". */
  source: string;
  source_type: RulingSourceType;
  /** ISO date the ruling was published, or null when the provider omitted it. */
  published_at: string | null;
  comment: string;
}

/** Provenance of one retrieved corpus file. */
export interface RulesSourceProvenance {
  /** The URL the bytes were retrieved from. */
  url: string;
  /** SHA-256 of the stored bytes. */
  sha256: string;
  bytes: number;
  /** ISO timestamp of the local retrieval. */
  retrieved_at: string;
}

/** Provenance of the stored Comprehensive Rules release. */
export interface ComprehensiveRulesProvenance extends RulesSourceProvenance {
  /** Effective date declared inside the document, e.g. "2026-08-07". */
  effective_date: string | null;
  /** Release label from the download filename, e.g. "20260819", when known. */
  published_version: string | null;
  /** How the download URL was chosen. */
  url_discovery: "rules_page" | "pinned_default" | "explicit";
  rule_count: number;
  glossary_count: number;
}

/** Provenance of the stored rulings export. */
export interface RulingsProvenance extends RulesSourceProvenance {
  source: "scryfall_bulk_rulings";
  /** Upstream `updated_at` of the bulk export. */
  updated_at: string;
  ruling_count: number;
}

/** Manifest written next to a published rules version. */
export interface RulesManifest {
  version: string;
  created_at: string;
  comprehensive_rules: ComprehensiveRulesProvenance;
  rulings: RulingsProvenance;
}
