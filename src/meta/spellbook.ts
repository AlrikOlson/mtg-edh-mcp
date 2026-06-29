/**
 * Commander Spellbook combo enrichment (spec §5E/§12). POSTs a deck's card list
 * to the Commander Spellbook "find my combos" endpoint (through the
 * {@link CacheStore}) and parses the combos that are fully present in the deck
 * ("included") or one card away ("almostIncluded").
 *
 * Each combo carries its source + a confidence flag, since coverage is good but
 * not exhaustive. Like the EDHREC client, the HTTP boundary is an injectable
 * fetcher so parsing is unit-testable offline.
 */
import type { CacheStore } from "./cache.js";

/** Combo data changes less often than prices; cache a query for a day. */
export const SPELLBOOK_TTL_MS = 24 * 60 * 60 * 1000;

/** Injectable JSON fetch supporting a request init (for POST). */
export type FetchJson = (url: string, init?: RequestInit) => Promise<unknown>;

/** A parsed combo. `pieces` and `produces` are card / result names. */
export interface Combo {
  id: string;
  pieces: string[];
  produces: string[];
  steps?: string;
  source: "commander_spellbook";
  /** "included" = all pieces in the deck; "almost" = one card away. */
  confidence?: "included" | "almost";
}

export interface ComboResults {
  included: Combo[];
  almostIncluded: Combo[];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function names(list: unknown, outer: string, inner: string): string[] {
  const out: string[] = [];
  for (const itemRaw of asArray(list)) {
    const name = asRecord(asRecord(itemRaw)[outer])[inner];
    if (typeof name === "string") out.push(name);
  }
  return out;
}

function parseVariant(raw: unknown, confidence: Combo["confidence"]): Combo {
  const v = asRecord(raw);
  return {
    id: typeof v.id === "string" ? v.id : String(v.id ?? ""),
    pieces: names(v.uses, "card", "name"),
    produces: names(v.produces, "feature", "name"),
    steps: typeof v.description === "string" ? v.description : undefined,
    source: "commander_spellbook",
    confidence,
  };
}

/** Parse a find-my-combos response into included + almost-included combos. */
export function parseCombos(json: unknown): ComboResults {
  const results = asRecord(asRecord(json).results);
  // The endpoint nests under `results`; tolerate a flat shape too.
  const root = Object.keys(results).length > 0 ? results : asRecord(json);
  return {
    included: asArray(root.included).map((v) => parseVariant(v, "included")),
    almostIncluded: asArray(root.almostIncluded).map((v) => parseVariant(v, "almost")),
  };
}

const defaultFetchJson: FetchJson = async (url, init) => {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "mtg-edh-mcp (+https://github.com/; Scryfall Fan Content)",
      ...init?.headers,
    },
  });
  if (!res.ok) throw new Error(`Commander Spellbook HTTP ${res.status}`);
  return res.json();
};

export interface SpellbookClientOptions {
  fetchJson?: FetchJson;
  ttlMs?: number;
}

/** Client for Commander Spellbook's find-my-combos, cached + degrading. */
export class SpellbookClient {
  private readonly cache: CacheStore;
  private readonly fetchJson: FetchJson;
  private readonly ttlMs: number;

  constructor(cache: CacheStore, options: SpellbookClientOptions = {}) {
    this.cache = cache;
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.ttlMs = options.ttlMs ?? SPELLBOOK_TTL_MS;
  }

  private static key(commanders: readonly string[], cards: readonly string[]): string {
    return `spellbook:${[...commanders].sort().join(",")}|${[...cards].sort().join(",")}`;
  }

  /** Combos reachable from a deck (its commanders + main cards), cached. */
  async findMyCombos(
    commanders: readonly string[],
    cards: readonly string[],
  ): Promise<ComboResults> {
    const raw = await this.cache.fetch(SpellbookClient.key(commanders, cards), this.ttlMs, () =>
      this.fetchJson("https://backend.commanderspellbook.com/find-my-combos", {
        method: "POST",
        body: JSON.stringify({ commanders, main: cards }),
      }),
    );
    return parseCombos(raw);
  }
}
