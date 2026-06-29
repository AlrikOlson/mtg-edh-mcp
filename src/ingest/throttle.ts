/**
 * Minimal request throttle (spec §3) — enforces a minimum spacing between
 * outbound requests so the server is a good Scryfall citizen. Shared by the bulk
 * client and the live fallback client; sleep/now are injectable for tests.
 */

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ThrottleOptions {
  /** Minimum spacing between requests in ms. */
  minSpacingMs: number;
  /** Injectable sleep, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (ms epoch), for deterministic spacing tests. */
  now?: () => number;
}

export class Throttle {
  private readonly minSpacingMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private lastAt = 0;

  constructor(options: ThrottleOptions) {
    this.minSpacingMs = options.minSpacingMs;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
  }

  /** Wait until at least `minSpacingMs` has elapsed since the previous request. */
  async wait(): Promise<void> {
    const elapsed = this.now() - this.lastAt;
    if (this.lastAt !== 0 && elapsed < this.minSpacingMs) {
      await this.sleep(this.minSpacingMs - elapsed);
    }
    this.lastAt = this.now();
  }
}
