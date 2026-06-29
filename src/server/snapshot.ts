/**
 * data_snapshot provenance (spec §3 / §11).
 *
 * Every tool response is stamped with `data_snapshot` — the ISO date of the card
 * index the server answered from. The value is read once from the current
 * version's manifest at startup (see src/index/freshness.ts) and held in a
 * cached, sync provider so the hot tool path never does I/O; it is refreshed via
 * {@link CachedSnapshotProvider.set} after an atomic bulk swap.
 */

/** Returns the current data_snapshot (ISO-8601 date string, e.g. "2026-06-27"). */
export type SnapshotProvider = () => string;

/** Placeholder used until the card index supplies a real snapshot (p1-freshness). */
export const UNINITIALIZED_SNAPSHOT = "0000-00-00";

/**
 * A fixed-value provider. Pass the current index date once ingestion exists;
 * defaults to {@link UNINITIALIZED_SNAPSHOT}.
 */
export function staticSnapshotProvider(
  snapshot: string = UNINITIALIZED_SNAPSHOT,
): SnapshotProvider {
  return () => snapshot;
}

/** A sync snapshot provider whose cached value can be updated after a swap. */
export interface CachedSnapshotProvider {
  /** Sync getter to pass as the server's SnapshotProvider. */
  readonly provider: SnapshotProvider;
  /** Update the cached snapshot (e.g. after an atomic bulk swap). */
  set(snapshot: string): void;
  /** The current cached value. */
  get(): string;
}

/**
 * Build a mutable, sync snapshot provider seeded with `initial`. Read the real
 * value once (async) at startup, seed it here, then `set()` it on each swap.
 */
export function cachedSnapshotProvider(
  initial: string = UNINITIALIZED_SNAPSHOT,
): CachedSnapshotProvider {
  let current = initial;
  return {
    provider: () => current,
    set: (snapshot: string) => {
      current = snapshot;
    },
    get: () => current,
  };
}
