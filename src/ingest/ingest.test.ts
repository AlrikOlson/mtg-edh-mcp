import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BulkClient, type FetchFn } from "./scryfall.js";
import { VersionedStore, type Manifest } from "./store.js";
import { ingestBulk } from "./ingest.js";
import { readCardArray } from "./stream.js";

const ORACLE = [
  { oracle_id: "o1", name: "Sol Ring", mv: 1 },
  { oracle_id: "o2", name: "Lightning Bolt", mv: 1 },
];
const DEFAULT = [{ oracle_id: "o1", name: "Sol Ring", set: "cmm" }];

interface Routes {
  updatedAt: string;
  failDefault?: boolean;
}

/** Build a stub fetch serving a /bulk-data list + two array downloads. */
function makeFetch(routes: Routes): FetchFn {
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
                updated_at: routes.updatedAt,
              },
              {
                type: "default_cards",
                download_uri: "https://x/default",
                updated_at: routes.updatedAt,
              },
            ],
          }),
          { status: 200 },
        ),
      );
    }
    if (url.endsWith("/oracle")) return Promise.resolve(new Response(JSON.stringify(ORACLE)));
    if (url.endsWith("/default")) {
      if (routes.failDefault) return Promise.reject(new Error("network down"));
      return Promise.resolve(new Response(JSON.stringify(DEFAULT)));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as FetchFn;
}

function clientFor(routes: Routes): BulkClient {
  // Instant spacing for tests.
  return new BulkClient({ fetch: makeFetch(routes), sleep: () => Promise.resolve(), now: () => 0 });
}

let root: string;
let store: VersionedStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-ingest-"));
  store = new VersionedStore(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ingestBulk", () => {
  it("populates a fresh store from both bulk files and stamps the snapshot", async () => {
    const result = await ingestBulk({
      store,
      client: clientFor({ updatedAt: "2026-06-27T09:00:00.000Z" }),
      clock: () => new Date("2026-06-27T10:00:00.000Z"),
    });

    expect(result.skipped).toBe(false);
    expect(result.snapshot).toBe("2026-06-27");
    expect(await store.readCurrent()).toBe(result.version);

    const manifest = (await store.readManifest(result.version)) as Manifest;
    expect(manifest.files.oracle_cards.updated_at).toBe("2026-06-27T09:00:00.000Z");
    expect(manifest.files.default_cards.name).toBe("default_cards.json");

    const cards = await readCardArray<{ name: string }>(
      store.filePath(result.version, "oracle_cards.json"),
    );
    expect(cards.map((c) => c.name)).toEqual(["Sol Ring", "Lightning Bolt"]);
  });

  it("is idempotent: a second run with unchanged updated_at is skipped", async () => {
    const first = await ingestBulk({
      store,
      client: clientFor({ updatedAt: "2026-06-27T09:00:00.000Z" }),
      clock: () => new Date("2026-06-27T10:00:00.000Z"),
    });
    const second = await ingestBulk({
      store,
      client: clientFor({ updatedAt: "2026-06-27T09:00:00.000Z" }),
      clock: () => new Date("2026-06-28T10:00:00.000Z"),
    });

    expect(second.skipped).toBe(true);
    expect(second.version).toBe(first.version);
    expect(await readdir(store.versionsDir)).toHaveLength(1);
  });

  it("keeps the published pointer on a mid-run failure (atomic swap)", async () => {
    const first = await ingestBulk({
      store,
      client: clientFor({ updatedAt: "2026-06-27T09:00:00.000Z" }),
      clock: () => new Date("2026-06-27T10:00:00.000Z"),
    });

    // New upstream data (so it won't skip), but default_cards download fails mid-run.
    await expect(
      ingestBulk({
        store,
        client: clientFor({ updatedAt: "2026-06-28T09:00:00.000Z", failDefault: true }),
        clock: () => new Date("2026-06-28T10:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });

    // The published version is still the first, complete one — never a partial.
    expect(await store.readCurrent()).toBe(first.version);
    expect(await readdir(store.versionsDir)).toEqual([first.version]);
  });
});
