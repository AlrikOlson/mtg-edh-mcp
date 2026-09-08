/** Offline child-process driver for crash and shared-root acceptance tests. */
import { BulkClient, type FetchFn } from "../ingest/scryfall.js";
import { VersionedStore } from "../ingest/store.js";
import { openCurrentSnapshot, refreshSnapshot } from "./refresh.js";

const [root, mode, generation = "new", pauseAt = ""] = process.argv.slice(2);
if (!root) throw new Error("Expected a card-store root");
const store = new VersionedStore(root);

function send(message: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error("Expected an IPC channel"));
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

const snapshot = generation === "old" ? "2026-09-01" : "2026-09-02";
const rows = [1, 2].map((number) => ({
  oracle_id: `oracle-${number}`,
  id: `${generation}-printing-${number}`,
  name: `${generation} Card ${number}`,
  cmc: number,
  colors: [],
  color_identity: [],
  type_line: "Artifact",
  oracle_text: `${generation} rules`,
  legalities: { commander: "legal" },
  set: "tst",
  set_name: "Offline process fixture",
  collector_number: String(number),
  rarity: "common",
  prices: { usd: generation === "old" ? "1.00" : "2.00" },
}));

const fetch: FetchFn = async (input) => {
  const url = String(input);
  await send({ type: "fetch", url });
  if (url.endsWith("/bulk-data")) {
    return Response.json({
      data: ["oracle_cards", "default_cards"].map((type) => ({
        type,
        download_uri: `https://offline.invalid/${type}`,
        updated_at: `${snapshot}T09:00:00.000Z`,
      })),
    });
  }
  if (url === "https://offline.invalid/oracle_cards") return Response.json(rows);
  if (url === "https://offline.invalid/default_cards") return Response.json(rows);
  throw new Error(`Unexpected offline fixture URL: ${url}`);
};

async function main(): Promise<void> {
  if (mode === "read") {
    const current = await openCurrentSnapshot(store);
    if (!current) throw new Error("No published snapshot after restart");
    try {
      await send({
        type: "view",
        version: current.version,
        snapshot: current.snapshot,
        cards: current.index.count(),
        names: [1, 2].map((number) => current.index.getCard(`oracle-${number}`)?.name),
        printings: [1, 2].map((number) => current.index.getPrintings(`oracle-${number}`)),
        fts: current.index
          .searchByName("Card")
          .map((card) => card.name)
          .sort(),
      });
    } finally {
      current.index.close();
    }
    return;
  }

  const result = await refreshSnapshot({
    store,
    client: new BulkClient({ fetch, sleep: () => Promise.resolve(), now: () => 0 }),
    checkpoint: async (phase) => {
      await send({ type: "checkpoint", phase });
      if (phase === pauseAt) {
        await send({ type: "paused", phase });
        // A live IPC listener keeps Node alive at the exact checkpoint until
        // the parent kills it. No sleeps or timing assumptions select the cut.
        await new Promise<void>((resolve) => process.once("message", () => resolve()));
      }
    },
  });
  await send({ type: "result", ...result });
}

void main()
  .catch(async (error: unknown) => {
    await send({
      type: "error",
      code: error && typeof error === "object" && "code" in error ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  })
  .finally(() => process.disconnect?.());
