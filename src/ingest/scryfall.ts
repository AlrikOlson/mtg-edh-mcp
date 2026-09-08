/**
 * Scryfall bulk-data client (spec §3).
 *
 * Reads the /bulk-data list, resolves the `oracle_cards` (gameplay base) and
 * `default_cards` (printings/prices) entries, and opens streaming downloads of
 * their payload. Good-citizen rate limiting: a mandatory descriptive
 * User-Agent and >=100ms spacing between requests (§3). Upstream failures map to
 * StructuredError("UPSTREAM_UNAVAILABLE").
 *
 * Payload format: Scryfall now publishes bulk exports as gzipped JSONL
 * (`jsonl_download_uri`); the legacy single-JSON-array `download_uri` was
 * retired (its URLs 404). {@link resolveBulkDownload} prefers the JSONL form and
 * still accepts the legacy field when present, and {@link BulkClient.openBulkStream}
 * gunzips on the fly so callers always see plain text bytes.
 */
import { StructuredError } from "../types/errors.js";
import { USER_AGENT } from "../types/index.js";
import { Throttle } from "./throttle.js";

export const BULK_DATA_URL = "https://api.scryfall.com/bulk-data";
// One descriptive User-Agent for the whole codebase (spec §11); see src/types.
export { USER_AGENT };
export const MIN_REQUEST_SPACING_MS = 100;
/** Metadata requests should fail promptly; bulk bodies need time to stream. */
export const SCRYFALL_JSON_TIMEOUT_MS = 30_000;
export const BULK_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

/** The two bulk exports this server ingests. */
export type BulkType = "oracle_cards" | "default_cards";
export const BULK_TYPES: readonly BulkType[] = ["oracle_cards", "default_cards"];

/** A single bulk-data descriptor from the /bulk-data list (subset we use). */
export interface BulkDataEntry {
  type: string;
  /** Current format: gzipped JSONL, one card object per line. */
  jsonl_download_uri?: string;
  /** Legacy format: a single JSON array. Retired upstream; kept for old fixtures. */
  download_uri?: string;
  /** ISO-8601 timestamp of the last upstream rebuild; drives idempotency. */
  updated_at: string;
  /** Byte size of the gzipped JSONL payload. */
  compressed_size?: number;
  size?: number;
  content_type?: string;
}

/** The download to fetch for a bulk entry, and how to decode it. */
export interface ResolvedBulkDownload {
  uri: string;
  /** True when the payload is gzipped JSONL rather than a plain JSON array. */
  jsonl: boolean;
}

/**
 * Pick the download URI for a bulk entry, preferring the current gzipped-JSONL
 * form over the retired JSON-array one.
 */
export function resolveBulkDownload(entry: BulkDataEntry): ResolvedBulkDownload {
  if (entry.jsonl_download_uri) return { uri: entry.jsonl_download_uri, jsonl: true };
  if (entry.download_uri) return { uri: entry.download_uri, jsonl: false };
  throw new StructuredError(
    "UPSTREAM_UNAVAILABLE",
    `Scryfall bulk entry '${entry.type}' has no download URI`,
    { reason: "neither jsonl_download_uri nor download_uri is present" },
  );
}

export type FetchFn = typeof fetch;

/** Preserve structured upstream errors when a deadline expires while reading JSON. */
export async function readScryfallJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new StructuredError("UPSTREAM_UNAVAILABLE", "Scryfall JSON response failed", {
      url: response.url || undefined,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

export interface BulkClientOptions {
  /** Injectable fetch (tests pass a stub). Defaults to global fetch. */
  fetch?: FetchFn;
  userAgent?: string;
  baseUrl?: string;
  /** Minimum spacing between requests in ms (default 100). */
  minSpacingMs?: number;
  /** Deadline for metadata responses, including their JSON body (default 30 seconds). */
  requestTimeoutMs?: number;
  /** Separate deadline for a complete bulk download (default 15 minutes). */
  downloadTimeoutMs?: number;
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
  private readonly requestTimeoutMs: number;
  private readonly downloadTimeoutMs: number;

  constructor(options: BulkClientOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
    this.userAgent = options.userAgent ?? USER_AGENT;
    this.baseUrl = options.baseUrl ?? BULK_DATA_URL;
    this.requestTimeoutMs = options.requestTimeoutMs ?? SCRYFALL_JSON_TIMEOUT_MS;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? BULK_DOWNLOAD_TIMEOUT_MS;
    this.throttle = new Throttle({
      minSpacingMs: options.minSpacingMs ?? MIN_REQUEST_SPACING_MS,
      sleep: options.sleep,
      now: options.now,
    });
  }

  private async request(url: string, timeoutMs = this.requestTimeoutMs): Promise<Response> {
    await this.throttle.wait();
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: { "User-Agent": this.userAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
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
    const body = (await readScryfallJson(response)) as { data?: BulkDataEntry[] } | null;
    if (!body || !Array.isArray(body.data)) {
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
    const response = await this.request(downloadUri, this.downloadTimeoutMs);
    if (!response.body) {
      throw new StructuredError(
        "UPSTREAM_UNAVAILABLE",
        `Scryfall download had no body: ${downloadUri}`,
      );
    }
    return response.body;
  }

  /**
   * Open a bulk entry's payload as decoded text bytes: the gzipped-JSONL export
   * is gunzipped on the fly, a legacy JSON-array body is passed through.
   */
  async openBulkStream(
    entry: BulkDataEntry,
  ): Promise<{ body: ReadableStream<Uint8Array>; download: ResolvedBulkDownload }> {
    const download = resolveBulkDownload(entry);
    const body = await this.openDownload(download.uri);
    // DecompressionStream is typed with a BufferSource-writable side, which does
    // not unify with ReadableStream<Uint8Array>; the cast bridges that one seam.
    const gunzip = new DecompressionStream("gzip") as unknown as {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    };
    return { body: download.jsonl ? body.pipeThrough(gunzip) : body, download };
  }
}
