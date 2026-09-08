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
export type SnapshotProvider = (() => string) & {
  /** Hold the served generation throughout a tool's asynchronous work and stamp. */
  withRead?: <T>(operation: () => Promise<T>) => Promise<T>;
};

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
  readonly provider: SnapshotProvider & {
    withRead: <T>(operation: () => Promise<T>) => Promise<T>;
  };
  /** Drain active tools and hold new calls until the returned release is called. */
  pause(): Promise<() => void>;
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
  let readers = 0;
  let paused: Promise<void> | undefined;
  let drained: (() => void) | undefined;
  const provider = Object.assign(() => current, {
    async withRead<T>(operation: () => Promise<T>): Promise<T> {
      while (paused) await paused;
      readers += 1;
      try {
        return await operation();
      } finally {
        readers -= 1;
        if (readers === 0) drained?.();
      }
    },
  });
  return {
    provider,
    async pause() {
      if (paused) throw new Error("Snapshot activation is already pending");
      let resume = () => {};
      paused = new Promise<void>((resolve) => {
        resume = resolve;
      });
      if (readers > 0) {
        await new Promise<void>((resolve) => {
          drained = resolve;
        });
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        drained = undefined;
        paused = undefined;
        resume();
      };
    },
    set: (snapshot: string) => {
      current = snapshot;
    },
    get: () => current,
  };
}
