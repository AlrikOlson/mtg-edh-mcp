/** Own the exact served generation, its provenance, and transactional activation. */
import { BulkClient, VersionedStore } from "../ingest/index.js";
import { CardIndex, freshnessConfigFromEnv } from "../index/index.js";
import { openCurrentSnapshot, refreshSnapshot, type PreparedActivation } from "../index/refresh.js";
import { IngestRunner, type StalenessProvider } from "./dataTools.js";
import { cachedSnapshotProvider } from "./snapshot.js";

/** Live index state shared by all transports; first readiness is transactional. */
export interface CardDataSource {
  readonly index: CardIndex | undefined;
  /** Prepare catalog changes before publication. Commit must only install prepared state. */
  onReady(listener: (index: CardIndex) => PreparedActivation): () => void;
}

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
  const ingest = new IngestRunner(store.root, async (_root, force, onPhase) => {
    const result = await refreshSnapshot({
      store,
      client: makeClient(),
      force,
      onPhase,
      prepareActivation: async (next) => {
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
            throw new AggregateError(
              [error, cleanupError],
              "Snapshot activation preparation failed",
              { cause: cleanupError },
            );
          }
          throw error;
        }
      },
    });
    return {
      snapshot: result.snapshot,
      cards: result.cards,
      skipped: result.skipped,
    };
  });
  const bulkAge = async (now: number): Promise<number | null> => {
    // Another process may have published since this process opened its index.
    const manifest = servedVersion ? await store.readManifest(servedVersion) : null;
    const updated = Date.parse(manifest?.files.oracle_cards.updated_at ?? "");
    return Number.isFinite(updated) ? Math.max(0, now - updated) : null;
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
  };
}
