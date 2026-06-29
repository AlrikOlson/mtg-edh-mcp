/**
 * Scryfall bulk-data client (spec §3).
 *
 * Reads the /bulk-data list, resolves the `oracle_cards` (gameplay base) and
 * `default_cards` (printings/prices) entries, and opens streaming downloads of
 * their `download_uri`. Good-citizen rate limiting: a mandatory descriptive
 * User-Agent and >=100ms spacing between requests (§3). Upstream failures map to
 * StructuredError("UPSTREAM_UNAVAILABLE").
 */
import { StructuredError } from "../types/errors.js";
import { Throttle } from "./throttle.js";

export const BULK_DATA_URL = "https://api.scryfall.com/bulk-data";
export const USER_AGENT = "mtg-edh-mcp/0.0.0 (+https://github.com/alrik/mtg-edh-mcp)";
export const MIN_REQUEST_SPACING_MS = 100;

/** The two bulk exports this server ingests. */
export type BulkType = "oracle_cards" | "default_cards";
export const BULK_TYPES: readonly BulkType[] = ["oracle_cards", "default_cards"];

/** A single bulk-data descriptor from the /bulk-data list (subset we use). */
export interface BulkDataEntry {
  type: string;
  download_uri: string;
  /** ISO-8601 timestamp of the last upstream rebuild; drives idempotency. */
  updated_at: string;
  size?: number;
  content_type?: string;
}

export type FetchFn = typeof fetch;

export interface BulkClientOptions {
  /** Injectable fetch (tests pass a stub). Defaults to global fetch. */
  fetch?: FetchFn;
  userAgent?: string;
  baseUrl?: string;
  /** Minimum spacing between requests in ms (default 100). */
  minSpacingMs?: number;
  /** Injectable sleep, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (ms epoch), for deterministic spacing tests. */
  now?: () => number;
}

export class BulkClient {
  private readonly fetchFn: FetchFn;
  private readonly userAgent: string;
  private readonly baseUrl: string;
  private readonly throttle: Throttle;

  constructor(options: BulkClientOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
    this.userAgent = options.userAgent ?? USER_AGENT;
    this.baseUrl = options.baseUrl ?? BULK_DATA_URL;
    this.throttle = new Throttle({
      minSpacingMs: options.minSpacingMs ?? MIN_REQUEST_SPACING_MS,
      sleep: options.sleep,
      now: options.now,
    });
  }

  private async request(url: string): Promise<Response> {
    await this.throttle.wait();
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: { "User-Agent": this.userAgent, Accept: "application/json" },
      });
    } catch (cause) {
      throw new StructuredError("UPSTREAM_UNAVAILABLE", `Scryfall request failed: ${url}`, {
        url,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
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

  /** Fetch the full /bulk-data list. */
  async listBulkData(): Promise<BulkDataEntry[]> {
    const response = await this.request(this.baseUrl);
    const body = (await response.json()) as { data?: BulkDataEntry[] };
    if (!body.data || !Array.isArray(body.data)) {
      throw new StructuredError(
        "UPSTREAM_UNAVAILABLE",
        "Scryfall /bulk-data response missing data[]",
      );
    }
    return body.data;
  }

  /** Resolve a single bulk entry by type, or fail with UPSTREAM_UNAVAILABLE. */
  async getEntry(type: BulkType): Promise<BulkDataEntry> {
    const entry = (await this.listBulkData()).find((e) => e.type === type);
    if (!entry) {
      throw new StructuredError(
        "UPSTREAM_UNAVAILABLE",
        `Scryfall /bulk-data has no '${type}' entry`,
      );
    }
    return entry;
  }

  /** Open a streaming download of a bulk file; returns its web ReadableStream body. */
  async openDownload(downloadUri: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.request(downloadUri);
    if (!response.body) {
      throw new StructuredError(
        "UPSTREAM_UNAVAILABLE",
        `Scryfall download had no body: ${downloadUri}`,
      );
    }
    return response.body;
  }
}
