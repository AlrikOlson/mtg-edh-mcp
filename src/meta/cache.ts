/**
 * Enrichment cache & graceful degradation (spec §3/§8/§11).
 *
 * A source-agnostic, TTL-keyed cache wrapping an async fetcher. It lets the P6
 * enrichment sources (EDHREC, Commander Spellbook, the bracket / Game-Changers
 * list) stay responsive and keep working when upstream is down:
 *
 *  - a hit within its TTL is served from memory (no network);
 *  - a miss or expired entry triggers the fetcher and caches the result;
 *  - if the fetcher fails but a (possibly stale) entry exists, the stale value
 *    is served — degrade, never crash;
 *  - if the fetcher fails with nothing cached, UPSTREAM_UNAVAILABLE is thrown.
 *
 * TTL is per call, so each source picks its own cadence. Storage is an in-memory
 * Map (process-local; an on-disk cache is a later concern). The clock is
 * injectable for deterministic tests, mirroring {@link Throttle}.
 */
import { StructuredError } from "../types/index.js";

interface CacheEntry {
  value: unknown;
  /** Epoch ms when this entry was stored. */
  at: number;
}

export interface CacheStoreOptions {
  /** Injectable clock (tests pass a deterministic one). Defaults to Date.now. */
  now?: () => number;
}

/** Local observation age, not a claim about when the upstream data was published. */
export interface CacheFreshness {
  fetched_at: string;
  age_ms: number;
  ttl_ms: number;
  status: "fresh" | "cached" | "stale";
  refresh_failed: boolean;
}

export interface CachedResult<T> {
  value: T;
  freshness: CacheFreshness;
}

export class CacheStore {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly now: () => number;

  constructor(options: CacheStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Return `key`'s value, fetching via `fetcher` on a miss/expiry. On a fetch
   * failure, fall back to a stale cached value if present, else throw
   * UPSTREAM_UNAVAILABLE. `ttlMs` is the freshness window for this call.
   */
  async fetch<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    return (await this.fetchWithMetadata(key, ttlMs, fetcher)).value;
  }

  /** Fetch with observation metadata; stale fallback keeps its original timestamp. */
  async fetchWithMetadata<T>(
    key: string,
    ttlMs: number,
    fetcher: () => Promise<T>,
  ): Promise<CachedResult<T>> {
    const result = (value: T, at: number, status: CacheFreshness["status"]): CachedResult<T> => ({
      value,
      freshness: {
        fetched_at: new Date(at).toISOString(),
        age_ms: Math.max(0, this.now() - at),
        ttl_ms: ttlMs,
        status,
        refresh_failed: status === "stale",
      },
    });
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.at < ttlMs) {
      return result(entry.value as T, entry.at, "cached");
    }
    try {
      const value = await fetcher();
      const at = this.now();
      this.entries.set(key, { value, at });
      return result(value, at, "fresh");
    } catch (cause) {
      if (entry) return result(entry.value as T, entry.at, "stale");
      throw new StructuredError(
        "UPSTREAM_UNAVAILABLE",
        `cache miss and upstream failed for '${key}'`,
        {
          reason: cause instanceof Error ? cause.message : String(cause),
        },
      );
    }
  }

  /** True if a (possibly stale) entry exists for `key`. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** The cached value for `key` regardless of freshness, or undefined. */
  peek<T>(key: string): T | undefined {
    return this.entries.get(key)?.value as T | undefined;
  }

  /** Drop a single key, or all entries when `key` is omitted. */
  invalidate(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }

  /** Number of cached entries (fresh or stale). */
  get size(): number {
    return this.entries.size;
  }
}
