/**
 * Pure decklist parsing + formatting (spec §5B).
 *
 * Handles the common interchange formats — Moxfield / Archidekt / MTGO / Arena /
 * plaintext — which all share a "<qty> <name>" line shape. Quantities may use an
 * `x` suffix ("1x Sol Ring"); names may carry a trailing set/collector hint
 * ("Sol Ring (C21) 263"), a foil marker ("*F*"), or a trailing tag — all of
 * which are stripped down to the gameplay name. Blank lines, comments (`//`/`#`),
 * and section headers ("Deck", "Commander:", "Sideboard", …) are skipped as
 * structure, not reported as unresolved.
 *
 * Resolution of names to oracle_ids happens at the tool layer (via the index);
 * this module is intentionally index-free and deterministic.
 */
import type { DeckCardEntry } from "../types/index.js";

/** A parsed decklist line: a quantity, a gameplay name, and its raw source line. */
export interface ParsedEntry {
  qty: number;
  name: string;
  /** The original (trimmed) line, for the unresolved-lines report. */
  raw: string;
}

/** Structural lines that are skipped rather than treated as card entries. */
const SECTION_HEADERS = new Set([
  "deck",
  "commander",
  "commanders",
  "sideboard",
  "maybeboard",
  "companion",
  "tokens",
  "about",
  "sb",
]);

/** Strip a trailing set/collector hint, foil marker, and tag suffixes from a name. */
function stripSuffixes(name: string): string {
  return name
    .replace(/\s+\*[^*]*\*\s*$/u, "") // foil/finish marker: *F*
    .replace(/\s+\([A-Za-z0-9]{1,6}\)(?:\s+[A-Za-z0-9-]+)?\s*$/u, "") // (SET) 123
    .trim();
}

/**
 * Parse decklist text into card entries. Lines that carry no gameplay name
 * (blank, comment, or section header) are skipped; everything else becomes an
 * entry (defaulting to qty 1 for a bare card name). Name resolution is the
 * caller's job.
 */
export function parseDecklist(text: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("//") || line.startsWith("#")) continue;
    if (line.endsWith(":")) continue; // header like "Commander:"

    const m = /^(\d+)\s*[xX]?\s+(.+)$/u.exec(line);
    let qty = 1;
    let rest = line;
    if (m) {
      const parsed = Number.parseInt(m[1] ?? "1", 10);
      qty = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
      rest = m[2] ?? line;
    } else if (SECTION_HEADERS.has(line.toLowerCase())) {
      continue;
    }

    const name = stripSuffixes(rest);
    if (!name) continue;
    entries.push({ qty, name, raw: line });
  }
  return entries;
}

/**
 * Format deck entries as plaintext "<qty> <name>" lines. `nameOf` maps an
 * oracle_id to its gameplay name; entries whose name is unknown fall back to the
 * oracle_id so nothing is silently lost.
 */
export function formatDecklist(
  entries: readonly DeckCardEntry[],
  nameOf: (oracleId: string) => string | undefined,
): string {
  return entries.map((e) => `${e.qty} ${nameOf(e.oracle_id) ?? e.oracle_id}`).join("\n");
}
