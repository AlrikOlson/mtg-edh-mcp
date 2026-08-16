/**
 * Freshness scheduler (spec §3) — the runtime that actually consumes
 * {@link FreshnessConfig}. Until this existed the cadence env vars were
 * documented but nothing ran them, so a long-lived server would serve a
 * silently aging snapshot indefinitely.
 *
 * Behavior:
 *  - On start: if the current manifest's upstream `updated_at` is older than
 *    the bulk interval, kick an ingest immediately (via the shared
 *    {@link IngestRunner}, which serializes runs and is safe to poke).
 *  - Every bulk interval: kick an ingest. `ingestBulk` is idempotent — when
 *    upstream is unchanged the run costs one /bulk-data list request.
 *  - A separate price-only pass is deliberately NOT scheduled: the bulk pass
 *    runs at least as often, and `refreshPrices` re-downloads the same ~600MB
 *    default_cards file — all cost, no added freshness.
 *
 * Timers are unref()'d so they never keep the process alive past a closed
 * transport (the stdio orphan-proofing in main.ts stays effective).
 *
 * Opt out with MCP_AUTO_REFRESH=0.
 */
import { VersionedStore } from "../ingest/index.js";
import { DEFAULT_FRESHNESS, type FreshnessConfig } from "../index/index.js";
import type { IngestRunner } from "./dataTools.js";

export interface SchedulerOptions {
  runner: IngestRunner;
  store: VersionedStore;
  config?: FreshnessConfig;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable timer for tests; defaults to setInterval. */
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
}

export interface RunningScheduler {
  /** Cancel the recurring check (used by tests; production runs for the process lifetime). */
  stop(): void;
}

/** True when MCP_AUTO_REFRESH disables the scheduler. */
export function autoRefreshDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.MCP_AUTO_REFRESH === "0" || env.MCP_AUTO_REFRESH === "false";
}

/**
 * The age of the current version's bulk data in ms (from the oracle_cards
 * upstream `updated_at`), or null when no version/manifest exists.
 */
export async function bulkAgeMs(store: VersionedStore, now: number): Promise<number | null> {
  const version = await store.readCurrent();
  if (!version) return null;
  const manifest = await store.readManifest(version);
  const updatedAt = manifest?.files?.oracle_cards?.updated_at;
  if (!updatedAt) return null;
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : null;
}

/**
 * Start the freshness scheduler: staleness check now, then every bulk
 * interval. Never throws — a failed check logs and waits for the next tick.
 */
export async function startScheduler(options: SchedulerOptions): Promise<RunningScheduler> {
  const { runner, store } = options;
  const config = options.config ?? DEFAULT_FRESHNESS;
  const now = options.now ?? (() => Date.now());
  const setIntervalFn = options.setIntervalFn ?? setInterval;

  const check = async (): Promise<void> => {
    try {
      const age = await bulkAgeMs(store, now());
      // No manifest = first run never happened; that is the GUI-onboarding
      // path (data_ingest), not the scheduler's — do nothing.
      if (age === null) return;
      if (age >= config.bulkIntervalMs) runner.start(false);
    } catch (err) {
      console.error("freshness check failed:", err instanceof Error ? err.message : err);
    }
  };

  await check();
  const timer = setIntervalFn(() => void check(), config.bulkIntervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
