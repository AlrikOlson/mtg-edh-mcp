/** Own the exact served generation, its provenance, and transactional activation. */
import { BulkClient, VersionedStore } from "../ingest/index.js";
import { CardIndex, freshnessConfigFromEnv } from "../index/index.js";
import { openCurrentSnapshot, refreshSnapshot, type PreparedActivation } from "../index/refresh.js";
import { IngestRunner, summarizeCollection, type StalenessProvider } from "./dataTools.js";
import { cachedSnapshotProvider } from "./snapshot.js";

/** Live index state shared by all transports; first readiness is transactional. */
export interface CardDataSource {
  readonly index: CardIndex | undefined;
  /** Prepare catalog changes before publication. Commit must only install prepared state. */
  onReady(listener: (index: CardIndex) => PreparedActivation): () => void;
}

/**
 * Outcome of one attempt to adopt the pointer another process published:
 * `adopted` installed it; `current` means this process already serves it;
 * `cold` means no index is served yet (first-run belongs to ingest); `busy`
 * means an ingest or activation of this process is in flight; `unavailable`
 * means the pointer names nothing this release can open.
 */
export type AdoptOutcome = "adopted" | "current" | "cold" | "busy" | "unavailable";

export async function openCardData(
  store: VersionedStore,
  makeClient: () => BulkClient = () => new BulkClient(),
) {
  const current = await openCurrentSnapshot(store);
  let index = current?.index;
  const readyListeners = new Set<(index: CardIndex) => PreparedActivation>();
  let pendingReady: { index: CardIndex; catalogs: PreparedActivation[] } | undefined;
  const snapshot = cachedSnapshotProvider(current?.snapshot);
  let servedVersion = current?.version;
  const freshness = freshnessConfigFromEnv();
  /** Prepare the served generation swap to `next`; commit installs it atomically. */
  const activate = async (next: {
    version: string;
    snapshot: string;
    dbPath: string;
  }): Promise<PreparedActivation> => {
    const release = await snapshot.pause();
    let preparedIndex: PreparedActivation | undefined;
    const catalogs: PreparedActivation[] = [];
    const dispose = () => {
      const errors: unknown[] = [];
      for (const activation of [...catalogs].reverse().concat(preparedIndex ?? [])) {
        try {
          activation.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      pendingReady = undefined;
      release();
      if (errors.length) throw new AggregateError(errors, "Snapshot activation cleanup failed");
    };
    try {
      if (index) {
        preparedIndex = index.prepareReopen(next.dbPath);
      } else {
        const firstIndex = CardIndex.open(next.dbPath);
        preparedIndex = {
          commit() {
            index = firstIndex;
          },
          dispose() {
            firstIndex.close();
          },
        };
        // Servers may be created while store.publish awaits filesystem I/O.
        // Include their preparations in this same pending commit.
        pendingReady = { index: firstIndex, catalogs };
        for (const listener of readyListeners) catalogs.push(listener(firstIndex));
      }
      const activatedIndex = preparedIndex;
      return {
        commit() {
          activatedIndex.commit();
          snapshot.set(next.snapshot);
          servedVersion = next.version;
          for (const activation of catalogs) activation.commit();
          readyListeners.clear();
          pendingReady = undefined;
          release();
        },
        dispose,
      };
    } catch (error) {
      try {
        dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Snapshot activation preparation failed", {
          cause: cleanupError,
        });
      }
      throw error;
    }
  };
  const ingest = new IngestRunner(store.root, async (_root, force, onPhase) => {
    const result = await refreshSnapshot({
      store,
      client: makeClient(),
      force,
      onPhase,
      prepareActivation: activate,
    });
    return {
      snapshot: result.snapshot,
      cards: result.cards,
      skipped: result.skipped,
      ...(result.collection ? { collection: summarizeCollection(result.collection) } : {}),
    };
  });
  const bulkAge = async (now: number): Promise<number | null> => {
    // Another process may have published since this process opened its index.
    let manifest = servedVersion ? await store.readManifest(servedVersion) : null;
    if (!manifest && servedVersion) {
      // The served directory was collected after a later publication; measure
      // the published generation so staleness keeps driving adoption or refresh.
      const published = await store.readCurrent();
      manifest = published ? await store.readManifest(published) : null;
    }
    const updated = Date.parse(manifest?.files.oracle_cards.updated_at ?? "");
    return Number.isFinite(updated) ? Math.max(0, now - updated) : null;
  };
  /**
   * Install the version named by `current.json` when another process published
   * it, through the same prepared activation an ingest uses, without taking the
   * refresh lease or touching the network. Never performs first-run activation.
   */
  const adoptPublished = async (): Promise<AdoptOutcome> => {
    if (!index) return "cold";
    if (ingest.status().running) return "busy";
    const pointer = await store.readPointer();
    if (!pointer || pointer.version === servedVersion) return "current";
    const published = await openCurrentSnapshot(store);
    if (!published) return "unavailable";
    published.index.close();
    if (published.version === servedVersion) return "current";
    let prepared: PreparedActivation;
    try {
      prepared = await activate(published);
    } catch (error) {
      if (error instanceof Error && /already pending/.test(error.message)) return "busy";
      throw error;
    }
    prepared.commit();
    return "adopted";
  };
  const staleness: StalenessProvider = async () => {
    const age = await bulkAge(Date.now());
    return {
      bulk_age_hours: age === null ? null : Math.round((age / 3_600_000) * 10) / 10,
      stale: age !== null && age >= freshness.bulkIntervalMs,
    };
  };
  return {
    get index() {
      return index;
    },
    onReady(listener: (index: CardIndex) => PreparedActivation) {
      if (pendingReady) pendingReady.catalogs.push(listener(pendingReady.index));
      readyListeners.add(listener);
      return () => {
        readyListeners.delete(listener);
      };
    },
    snapshot,
    ingest,
    staleness,
    bulkAge,
    adoptPublished,
  };
}
