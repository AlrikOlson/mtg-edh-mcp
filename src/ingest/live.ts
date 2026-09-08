/**
 * Live Scryfall API client (spec §3/§8) — used ONLY as a fallback when the local
 * index misses or is stale. Returns raw Scryfall JSON; the index layer maps it
 * to a §4 Card (one-way layering). Rate limiting per Scryfall guidance: search
 * endpoints <2 req/s (>=500ms spacing); other card lookups >=100ms. Every
 * request sends a mandatory descriptive User-Agent. Non-2xx -> UPSTREAM_UNAVAILABLE,
 * except 404 -> UNKNOWN_CARD.
 */
import { StructuredError } from "../types/errors.js";
import type { ScryfallCardRaw } from "./scryfallTypes.js";
import { Throttle } from "./throttle.js";
import {
  USER_AGENT,
  SCRYFALL_JSON_TIMEOUT_MS,
  readScryfallJson,
  type FetchFn,
} from "./scryfall.js";

export const SCRYFALL_API_BASE = "https://api.scryfall.com";
/** Search-class endpoints: <2 req/s. */
export const SEARCH_SPACING_MS = 500;
/** Card-class endpoints (single-card lookups). */
export const CARD_SPACING_MS = 100;

export interface LiveClientOptions {
  fetch?: FetchFn;
  userAgent?: string;
  baseUrl?: string;
  searchSpacingMs?: number;
  cardSpacingMs?: number;
  /** Deadline for each response, including its JSON body (default 30 seconds). */
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class LiveScryfallClient {
  private readonly fetchFn: FetchFn;
  private readonly userAgent: string;
  private readonly baseUrl: string;
  private readonly cardThrottle: Throttle;
  private readonly searchThrottle: Throttle;
  private readonly requestTimeoutMs: number;

  constructor(options: LiveClientOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
    this.userAgent = options.userAgent ?? USER_AGENT;
    this.baseUrl = options.baseUrl ?? SCRYFALL_API_BASE;
    this.requestTimeoutMs = options.requestTimeoutMs ?? SCRYFALL_JSON_TIMEOUT_MS;
    this.cardThrottle = new Throttle({
      minSpacingMs: options.cardSpacingMs ?? CARD_SPACING_MS,
      sleep: options.sleep,
      now: options.now,
    });
    this.searchThrottle = new Throttle({
      minSpacingMs: options.searchSpacingMs ?? SEARCH_SPACING_MS,
      sleep: options.sleep,
      now: options.now,
    });
  }

  private async request(path: string, throttle: Throttle): Promise<Response> {
    await throttle.wait();
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: { "User-Agent": this.userAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (cause) {
      throw new StructuredError("UPSTREAM_UNAVAILABLE", `Scryfall request failed: ${url}`, {
        url,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (response.status === 404) {
      throw new StructuredError("UNKNOWN_CARD", `Scryfall has no card for ${path}`);
    }
    if (!response.ok) {
      throw new StructuredError(
        "UPSTREAM_UNAVAILABLE",
        `Scryfall returned ${response.status} for ${url}`,
        {
          url,
          status: response.status,
        },
      );
    }
    return response;
  }

  /** Fetch a single card by Scryfall print id (`/cards/:id`). */
  async getCardById(scryfallId: string): Promise<ScryfallCardRaw> {
    const response = await this.request(
      `/cards/${encodeURIComponent(scryfallId)}`,
      this.cardThrottle,
    );
    return (await readScryfallJson(response)) as ScryfallCardRaw;
  }

  /** Resolve a card by name (`/cards/named`), exact or fuzzy. */
  async getCardByName(name: string, options: { exact?: boolean } = {}): Promise<ScryfallCardRaw> {
    const key = options.exact ? "exact" : "fuzzy";
    const response = await this.request(
      `/cards/named?${key}=${encodeURIComponent(name)}`,
      this.cardThrottle,
    );
    return (await readScryfallJson(response)) as ScryfallCardRaw;
  }

  /** Search-class query (`/cards/search`); returns the first page of cards. */
  async search(query: string): Promise<ScryfallCardRaw[]> {
    const response = await this.request(
      `/cards/search?q=${encodeURIComponent(query)}`,
      this.searchThrottle,
    );
    const body = (await readScryfallJson(response)) as { data?: ScryfallCardRaw[] };
    return body.data ?? [];
  }
}
