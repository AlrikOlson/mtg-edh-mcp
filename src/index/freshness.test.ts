import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BulkClient, VersionedStore, type FetchFn, type Manifest } from "../ingest/index.js";
import { buildIndex, CardIndex } from "./cardIndex.js";
import {
  readSnapshot,
  refreshPrices,
  freshnessConfigFromEnv,
  DEFAULT_FRESHNESS,
} from "./freshness.js";
import { cachedSnapshotProvider, UNINITIALIZED_SNAPSHOT } from "../server/snapshot.js";

const ORACLE = [
  {
    oracle_id: "o-sol",
    id: "p-sol-1",
    name: "Sol Ring",
    cmc: 1,
    colors: [],
    color_identity: [],
    type_line: "Artifact",
    oracle_text: "{T}: Add {C}{C}.",
    legalities: { commander: "legal" },
    prices: { usd: "1.50" },
  },
];

function defaultCards(price: string) {
  return [
    {
      oracle_id: "o-sol",
      id: "p-sol-1",
      set: "cmm",
      set_name: "Commander Masters",
      collector_number: "447",
      rarity: "uncommon",
      prices: { usd: price },
      released_at: "2023-08-04",
    },
  ];
}

/** Stub fetch serving a /bulk-data list + a default_cards download with given price. */
function makeFetch(price: string): FetchFn {
  return ((input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/bulk-data")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                type: "oracle_cards",
                download_uri: "https://x/oracle",
                updated_at: "2026-06-28T09:00:00.000Z",
              },
              {
                type: "default_cards",
                download_uri: "https://x/default",
                updated_at: "2026-06-28T09:00:00.000Z",
              },
            ],
          }),
          { status: 200 },
        ),
      );
    }
    if (url.endsWith("/default"))
      return Promise.resolve(new Response(JSON.stringify(defaultCards(price))));
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as FetchFn;
}

let root: string;
let store: VersionedStore;
const VERSION = "v-test";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-fresh-"));
  store = new VersionedStore(root);
  await store.createVersion(VERSION);
  await writeFile(store.filePath(VERSION, "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(
    store.filePath(VERSION, "default_cards.json"),
    JSON.stringify(defaultCards("1.50")),
    "utf8",
  );
  await store.publish(VERSION);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("readSnapshot", () => {
  it("returns the manifest snapshot of the current version", async () => {
    const manifest: Manifest = {
      version: VERSION,
      snapshot: "2026-06-27",
      created_at: "2026-06-27T10:00:00.000Z",
      files: {
        oracle_cards: { name: "oracle_cards.json", updated_at: "x", bytes: 1, source_uri: "u" },
        default_cards: { name: "default_cards.json", updated_at: "x", bytes: 1, source_uri: "u" },
      },
    };
    await store.writeManifest(VERSION, manifest);
    expect(await readSnapshot(store)).toBe("2026-06-27");
  });

  it("returns null when there is no manifest", async () => {
    expect(await readSnapshot(store)).toBeNull();
  });
});

describe("refreshPrices", () => {
  it("updates printing prices in place without rebuilding the index", async () => {
    const built = await buildIndex({ store });
    expect(built.cards).toBe(1);

    let index = CardIndex.open(built.dbPath);
    expect(index.getCard("o-sol")?.printings[0]?.prices.usd).toBe("1.50");
    expect(index.count()).toBe(1);
    index.close();

    const client = new BulkClient({
      fetch: makeFetch("5.00"),
      sleep: () => Promise.resolve(),
      now: () => 0,
    });
    const result = await refreshPrices({ store, client });
    expect(result.version).toBe(VERSION);
    expect(result.updated).toBe(1);

    index = CardIndex.open(built.dbPath);
    expect(index.getCard("o-sol")?.printings[0]?.prices.usd).toBe("5.00"); // price updated
    expect(index.getCard("o-sol")?.name).toBe("Sol Ring"); // oracle data untouched
    expect(index.count()).toBe(1); // no rebuild / no row churn
    index.close();
  });
});

describe("cachedSnapshotProvider", () => {
  it("is sync and updatable", () => {
    const cached = cachedSnapshotProvider("2026-06-27");
    expect(cached.provider()).toBe("2026-06-27");
    cached.set("2026-06-28");
    expect(cached.provider()).toBe("2026-06-28");
  });

  it("defaults to the uninitialized placeholder", () => {
    expect(cachedSnapshotProvider().provider()).toBe(UNINITIALIZED_SNAPSHOT);
  });
});

describe("freshnessConfigFromEnv", () => {
  it("defaults when env is unset", () => {
    expect(freshnessConfigFromEnv({})).toEqual(DEFAULT_FRESHNESS);
  });

  it("honors valid overrides and ignores invalid ones", () => {
    const cfg = freshnessConfigFromEnv({
      MCP_BULK_INTERVAL_MS: "1000",
      MCP_PRICE_INTERVAL_MS: "-5",
    });
    expect(cfg.bulkIntervalMs).toBe(1000);
    expect(cfg.priceIntervalMs).toBe(DEFAULT_FRESHNESS.priceIntervalMs); // invalid -> fallback
  });
});
