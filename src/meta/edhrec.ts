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
import { USER_AGENT } from "../types/index.js";
import type { CacheStore, CacheFreshness } from "./cache.js";

/** EDHREC pages change slowly; cache a commander page for a week by default. */
export const EDHREC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Injectable JSON fetch (default: global fetch -> .json()). */
export type FetchJson = (url: string) => Promise<unknown>;

/** One recommended card parsed from a commander page. */
export interface EdhrecCard {
  name: string;
  category: string;
  /** Number of decks: legacy inclusion, falling back to current num_decks. */
  inclusion?: number;
  /** Present when inclusion is a compatibility alias for the current provider field. */
  inclusion_provider_field?: "num_decks";
  /** Raw provider deck count and eligible population, when present. */
  num_decks?: number;
  potential_decks?: number;
  /** Synergy score (can be negative), when present. */
  synergy?: number;
  /** Raw lift value. Provider versions may use different scales; do not infer one. */
  lift?: number;
}

export interface CommanderProfile {
  cards: EdhrecCard[];
  themes: string[];
}

export interface SourcedCommanderProfile extends CommanderProfile {
  source: CacheFreshness & { name: "EDHREC"; url: string };
}

export interface EdhrecMetric {
  name: "inclusion" | "potential_decks" | "synergy" | "lift";
  provider_field: "inclusion" | "num_decks" | "potential_decks" | "synergy" | "lift";
  value: number;
  scale: "deck_count" | "proportion_difference" | "unknown";
  source: SourcedCommanderProfile["source"];
}

/** Report observed provider metrics independently of local deck-fit evidence.
 * Missing values are omitted, never measured zero; raw and log lift are not
 * interchangeable, so its scale stays unknown until the source specifies it. */
export function edhrecMetrics(
  card: EdhrecCard,
  source: SourcedCommanderProfile["source"],
): EdhrecMetric[] {
  const metrics: EdhrecMetric[] = [];
  const add = (
    name: EdhrecMetric["name"],
    provider_field: EdhrecMetric["provider_field"],
    value: number | undefined,
    scale: EdhrecMetric["scale"],
  ): void => {
    if (value !== undefined) metrics.push({ name, provider_field, value, scale, source });
  };
  add(
    "inclusion",
    card.inclusion_provider_field ?? "inclusion",
    asCount(card.inclusion),
    "deck_count",
  );
  if (card.inclusion_provider_field !== "num_decks")
    add("inclusion", "num_decks", asCount(card.num_decks), "deck_count");
  add("potential_decks", "potential_decks", asCount(card.potential_decks), "deck_count");
  add("synergy", "synergy", asNumber(card.synergy), "proportion_difference");
  add("lift", "lift", asNumber(card.lift), "unknown");
  return metrics;
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
function asCount(v: unknown): number | undefined {
  const value = asNumber(v);
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
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
      const inclusion = asCount(cv.inclusion);
      const numDecks = asCount(cv.num_decks);
      cards.push({
        name: cv.name,
        category,
        inclusion: inclusion ?? numDecks,
        ...(inclusion === undefined && numDecks !== undefined
          ? { inclusion_provider_field: "num_decks" as const }
          : {}),
        num_decks: numDecks,
        potential_decks: asCount(cv.potential_decks),
        synergy: asNumber(cv.synergy),
        lift: asNumber(cv.lift),
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
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30_000),
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

  /** Profile plus local fetch age, separately from the server's card data_snapshot. */
  async profileWithSource(commander: string): Promise<SourcedCommanderProfile> {
    const slug = slugify(commander);
    const url = this.url(slug);
    const result = await this.cache.fetchWithMetadata(`edhrec:commander:${slug}`, this.ttlMs, () =>
      this.fetchJson(url),
    );
    return { ...parseProfile(result.value), source: { name: "EDHREC", url, ...result.freshness } };
  }

  /** Commander themes/archetypes. */
  async themes(commander: string): Promise<string[]> {
    return parseThemes(await this.commanderPage(commander));
  }
}
