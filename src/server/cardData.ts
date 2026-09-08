/** Own the exact served generation, its provenance, and transactional activation. */
import { BulkClient, VersionedStore } from "../ingest/index.js";
import { freshnessConfigFromEnv } from "../index/index.js";
import { openCurrentSnapshot, refreshSnapshot } from "../index/refresh.js";
import { IngestRunner, type StalenessProvider } from "./dataTools.js";
import { cachedSnapshotProvider } from "./snapshot.js";

export async function openCardData(
  store: VersionedStore,
  makeClient: () => BulkClient = () => new BulkClient(),
) {
  const current = await openCurrentSnapshot(store);
  const index = current?.index;
  const snapshot = cachedSnapshotProvider(current?.snapshot);
  let servedVersion = current?.version;
  const freshness = freshnessConfigFromEnv();
  const ingest = new IngestRunner(store.root, async (_root, force, onPhase) => {
    const result = await refreshSnapshot({
      store,
      client: makeClient(),
      force,
      onPhase,
      prepareActivation: index
        ? async (next) => {
            const release = await snapshot.pause();
            try {
              const prepared = index.prepareReopen(next.dbPath);
              return {
                commit() {
                  prepared.commit();
                  snapshot.set(next.snapshot);
                  servedVersion = next.version;
                  release();
                },
                dispose() {
                  try {
                    prepared.dispose();
                  } finally {
                    release();
                  }
                },
              };
            } catch (error) {
              release();
              throw error;
            }
          }
        : undefined,
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
  return { index, snapshot, ingest, staleness, bulkAge };
}
