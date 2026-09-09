/**
 * Card rulings corpus (Commander workshop: rules and combo intelligence).
 *
 * Reads Scryfall's bulk `rulings` export (gzipped JSONL upstream, staged as
 * plain JSONL; a legacy JSON array is also accepted). Each ruling keeps its
 * Oracle identity, the provider's raw `source` and a classified source type so
 * official Wizards rulings are never confused with the provider's own notes.
 * A card absent from the export simply has no rulings recorded; that absence is
 * reported, not filled in.
 */
import type { CardRuling, RulingSourceType } from "../types/rules.js";

/** Scryfall documents `wotc` (official rulings) and `scryfall` (provider notes). */
export function classifyRulingSource(source: string): RulingSourceType {
  if (source === "wotc") return "wizards_ruling";
  if (source === "scryfall") return "provider_note";
  return "other";
}

/** Parse one exported ruling record; null when identity or comment is missing. */
export function parseRuling(raw: unknown): CardRuling | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const oracleId = record.oracle_id;
  const comment = record.comment;
  if (typeof oracleId !== "string" || oracleId.length === 0) return null;
  if (typeof comment !== "string") return null;
  const source = typeof record.source === "string" ? record.source : "";
  const publishedAt = record.published_at;
  return {
    oracle_id: oracleId,
    source,
    source_type: classifyRulingSource(source),
    published_at: typeof publishedAt === "string" && publishedAt.length > 0 ? publishedAt : null,
    comment,
  };
}

export interface ParsedRulings {
  corpus: RulingsCorpus;
  /** Lines (or array items) that were not parseable rulings. */
  malformed_lines: number;
}

/** Parse a staged rulings export: JSONL, or a legacy single JSON array. */
export function parseRulingsText(text: string): ParsedRulings {
  const rulings: CardRuling[] = [];
  let malformed = 0;
  const trimmed = text.replace(/^\uFEFF/, "").trimStart();
  if (trimmed.startsWith("[")) {
    let items: unknown;
    try {
      items = JSON.parse(trimmed);
    } catch {
      items = null;
    }
    if (!Array.isArray(items)) return { corpus: new RulingsCorpus([]), malformed_lines: 1 };
    for (const item of items) {
      const ruling = parseRuling(item);
      if (ruling) rulings.push(ruling);
      else malformed += 1;
    }
    return { corpus: new RulingsCorpus(rulings), malformed_lines: malformed };
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = line.trim();
    if (candidate.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.replace(/,$/, ""));
    } catch {
      malformed += 1;
      continue;
    }
    const ruling = parseRuling(parsed);
    if (ruling) rulings.push(ruling);
    else malformed += 1;
  }
  return { corpus: new RulingsCorpus(rulings), malformed_lines: malformed };
}

export interface RulingCounts {
  total: number;
  wizards_ruling: number;
  provider_note: number;
  other: number;
}

function byPublication(a: CardRuling, b: CardRuling): number {
  if (a.published_at === b.published_at) return 0;
  if (a.published_at === null) return 1;
  if (b.published_at === null) return -1;
  return a.published_at < b.published_at ? -1 : 1;
}

/** Rulings grouped by Oracle identity, ordered by publication date (undated last). */
export class RulingsCorpus {
  private readonly byOracleId = new Map<string, CardRuling[]>();
  readonly rulingCount: number;

  constructor(rulings: readonly CardRuling[]) {
    for (const ruling of rulings) {
      const list = this.byOracleId.get(ruling.oracle_id);
      if (list) list.push(ruling);
      else this.byOracleId.set(ruling.oracle_id, [ruling]);
    }
    for (const list of this.byOracleId.values()) list.sort(byPublication);
    this.rulingCount = rulings.length;
  }

  get cardCount(): number {
    return this.byOracleId.size;
  }

  /** True when the export carries at least one ruling for the card. */
  has(oracleId: string): boolean {
    return this.byOracleId.has(oracleId);
  }

  rulingsFor(oracleId: string): CardRuling[] {
    return [...(this.byOracleId.get(oracleId) ?? [])];
  }

  countsFor(oracleId: string): RulingCounts {
    const counts: RulingCounts = { total: 0, wizards_ruling: 0, provider_note: 0, other: 0 };
    for (const ruling of this.byOracleId.get(oracleId) ?? []) {
      counts.total += 1;
      counts[ruling.source_type] += 1;
    }
    return counts;
  }
}
