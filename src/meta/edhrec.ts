/**
 * EDHREC enrichment (spec §5E). Fetches a commander's page JSON from
 * json.edhrec.com (through the {@link CacheStore} for TTL + graceful
 * degradation) and parses out the average-deck card lists + themes.
 *
 * The HTTP boundary is an injectable `fetchJson` so the parsers and client are
 * fully unit-testable offline — production defaults to global `fetch`. Parsing
 * is pure and defensive: EDHREC's shape is non-obvious (cardlists live under
 * container.json_dict, themes under panels.taglinks) and may drift.
 */
import type { CacheStore } from "./cache.js";

/** EDHREC pages change slowly; cache a commander page for a week by default. */
export const EDHREC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Injectable JSON fetch (default: global fetch -> .json()). */
export type FetchJson = (url: string) => Promise<unknown>;

/** One recommended card parsed from a commander page. */
export interface EdhrecCard {
  name: string;
  category: string;
  /** Number of decks (EDHREC "inclusion"), when present. */
  inclusion?: number;
  /** Synergy score (can be negative), when present. */
  synergy?: number;
}

export interface CommanderProfile {
  cards: EdhrecCard[];
  themes: string[];
}

/** EDHREC commander slug, e.g. "Atraxa, Praetors' Voice" -> "atraxa-praetors-voice". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’.,]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Parse a commander page JSON into its card lists (by category) + themes. */
export function parseProfile(json: unknown): CommanderProfile {
  const root = asRecord(json);
  const jsonDict = asRecord(asRecord(root.container).json_dict);
  const cards: EdhrecCard[] = [];
  for (const listRaw of asArray(jsonDict.cardlists)) {
    const list = asRecord(listRaw);
    const category = typeof list.header === "string" ? list.header : String(list.tag ?? "");
    for (const cvRaw of asArray(list.cardviews)) {
      const cv = asRecord(cvRaw);
      if (typeof cv.name !== "string") continue;
      cards.push({
        name: cv.name,
        category,
        inclusion: asNumber(cv.inclusion),
        synergy: asNumber(cv.synergy),
      });
    }
  }
  return { cards, themes: parseThemes(json) };
}

/** Parse the commander's themes/archetypes from the page panels. */
export function parseThemes(json: unknown): string[] {
  const panels = asRecord(asRecord(json).panels);
  const themes: string[] = [];
  for (const linkRaw of asArray(panels.taglinks)) {
    const link = asRecord(linkRaw);
    if (typeof link.value === "string") themes.push(link.value);
  }
  return themes;
}

const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, {
    headers: { "User-Agent": "mtg-edh-mcp (+https://github.com/; Scryfall Fan Content)" },
  });
  if (!res.ok) throw new Error(`EDHREC HTTP ${res.status}`);
  return res.json();
};

export interface EdhrecClientOptions {
  fetchJson?: FetchJson;
  ttlMs?: number;
}

/** Client for EDHREC commander pages, cached + degrading via a CacheStore. */
export class EdhrecClient {
  private readonly cache: CacheStore;
  private readonly fetchJson: FetchJson;
  private readonly ttlMs: number;

  constructor(cache: CacheStore, options: EdhrecClientOptions = {}) {
    this.cache = cache;
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.ttlMs = options.ttlMs ?? EDHREC_TTL_MS;
  }

  private url(slug: string): string {
    return `https://json.edhrec.com/pages/commanders/${slug}.json`;
  }

  /** Raw commander page JSON (cached; throws UPSTREAM_UNAVAILABLE on cold failure). */
  async commanderPage(commander: string): Promise<unknown> {
    const slug = slugify(commander);
    return this.cache.fetch(`edhrec:commander:${slug}`, this.ttlMs, () =>
      this.fetchJson(this.url(slug)),
    );
  }

  /** Parsed commander profile (card lists + themes). */
  async profile(commander: string): Promise<CommanderProfile> {
    return parseProfile(await this.commanderPage(commander));
  }

  /** Commander themes/archetypes. */
  async themes(commander: string): Promise<string[]> {
    return parseThemes(await this.commanderPage(commander));
  }
}
