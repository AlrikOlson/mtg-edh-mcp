import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
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

/** Gzip a JSONL rendering of `cards`, as Scryfall's current bulk export ships it. */
function gzippedJsonl(cards: readonly unknown[]): Buffer {
  return gzipSync(Buffer.from(cards.map((c) => JSON.stringify(c)).join("\n") + "\n", "utf8"));
}

/** Stub fetch serving the current /bulk-data shape: gzipped JSONL, no download_uri. */
function jsonlFetch(updatedAt: string): FetchFn {
  return ((input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/bulk-data")) {
      return Promise.resolve(
        Response.json({
          data: [
            {
              type: "oracle_cards",
              jsonl_download_uri: "https://x/oracle.jsonl.gz",
              updated_at: updatedAt,
              compressed_size: 1,
            },
            {
              type: "default_cards",
              jsonl_download_uri: "https://x/default.jsonl.gz",
              updated_at: updatedAt,
              compressed_size: 1,
            },
          ],
        }),
      );
    }
    if (url.endsWith("/oracle.jsonl.gz"))
      return Promise.resolve(new Response(gzippedJsonl(ORACLE)));
    if (url.endsWith("/default.jsonl.gz"))
      return Promise.resolve(new Response(gzippedJsonl(DEFAULT)));
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as FetchFn;
}

function jsonlClientFor(updatedAt: string): BulkClient {
  return new BulkClient({
    fetch: jsonlFetch(updatedAt),
    sleep: () => Promise.resolve(),
    now: () => 0,
  });
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

  it("stages the gzipped-JSONL export as a decompressed .jsonl file", async () => {
    const result = await ingestBulk({
      store,
      client: jsonlClientFor("2026-08-15T21:01:56.082+00:00"),
      clock: () => new Date("2026-08-16T08:00:00.000Z"),
    });

    expect(result.snapshot).toBe("2026-08-15");
    const manifest = (await store.readManifest(result.version)) as Manifest;
    expect(manifest.files.oracle_cards.name).toBe("oracle_cards.jsonl");
    expect(manifest.files.oracle_cards.source_uri).toBe("https://x/oracle.jsonl.gz");

    // Staged decompressed, one card per line, and readable through the seam.
    const staged = await store.stagedFile(result.version, "oracle_cards");
    expect(staged.endsWith("oracle_cards.jsonl")).toBe(true);
    const cards = await readCardArray<{ name: string }>(staged);
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
