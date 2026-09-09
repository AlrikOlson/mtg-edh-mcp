import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { BulkClient, VersionedStore, type FetchFn } from "../ingest/index.js";
import { UserDataStore } from "../storage/userData.js";
import { openCurrentSnapshot, refreshSnapshot } from "./refresh.js";

const CARD = {
  oracle_id: "oracle-sol",
  id: "printing-sol",
  name: "Sol Ring",
  layout: "normal",
  cmc: 1,
  color_identity: [],
  colors: [],
  type_line: "Artifact",
  oracle_text: "Add two mana.",
  legalities: { commander: "legal" },
  prices: { usd: "1.00" },
  set: "cmm",
  set_name: "Commander Masters",
  collector_number: "1",
  rarity: "uncommon",
};

function source(day = "2026-09-01", failure?: "download" | "build" | "empty-printings") {
  const downloads = vi.fn();
  const fetch: FetchFn = async (input) => {
    const url = String(input);
    if (url.endsWith("/bulk-data")) {
      return Response.json({
        data: ["oracle_cards", "default_cards"].map((type) => ({
          type,
          updated_at: `${day}T12:00:00Z`,
          download_uri: `https://fixture/${type}`,
        })),
      });
    }
    downloads(url);
    if (url.endsWith("default_cards") && failure === "download") throw new Error("download failed");
    if (url.endsWith("default_cards") && failure === "build") return new Response("[broken JSON");
    if (url.endsWith("default_cards") && failure === "empty-printings") return Response.json([]);
    return Response.json([CARD]);
  };
  return { client: new BulkClient({ fetch, sleep: async () => {}, now: () => 0 }), downloads };
}

let root: string;
let store: VersionedStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-refresh-"));
  store = new VersionedStore(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("refreshSnapshot", () => {
  it("publishes only after both exports, SQLite, and activation preparation are complete", async () => {
    const phases: string[] = [];
    let prepared = false;
    let committed = false;
    const result = await refreshSnapshot({
      store,
      client: source().client,
      onPhase: (phase) => phases.push(phase),
      prepareActivation: (candidate) => {
        expect(candidate.cards).toBe(1);
        prepared = true;
        return {
          commit: () => {
            committed = true;
          },
          dispose: () => {},
        };
      },
      checkpoint: async (phase) => {
        if (phase === "after-download") expect(await store.readCurrent()).toBeNull();
        if (phase === "before-publish") {
          expect(prepared).toBe(true);
          expect(committed).toBe(false);
          expect(await store.readCurrent()).toBeNull();
        }
      },
    });
    expect(phases).toEqual(["download", "build"]);
    expect(committed).toBe(true);
    expect(await store.readCurrent()).toBe(result.version);
    const opened = await openCurrentSnapshot(store);
    expect(opened?.snapshot).toBe(result.snapshot);
    expect(opened?.index.getCard(CARD.oracle_id)?.name).toBe("Sol Ring");
    opened?.index.close();
  });

  it.each(["download", "build"] as const)(
    "retains previous usable data and recovery files after %s failure",
    async (failure) => {
      const first = await refreshSnapshot({ store, client: source().client });
      const previousBytes = await readFile(first.dbPath);
      await expect(
        refreshSnapshot({ store, client: source("2026-09-02", failure).client }),
      ).rejects.toThrow();
      expect(await store.readCurrent()).toBe(first.version);
      expect(await readFile(first.dbPath)).toEqual(previousBytes);
      expect((await readdir(store.versionsDir)).length).toBe(2);
      const opened = await openCurrentSnapshot(store);
      expect(opened?.index.count()).toBe(1);
      opened?.index.close();
    },
  );

  it("disposes prepared activation when publication fails and keeps the current index", async () => {
    const first = await refreshSnapshot({ store, client: source().client });
    const commit = vi.fn();
    const dispose = vi.fn();
    const publish = vi.spyOn(store, "publish").mockRejectedValueOnce(new Error("rename failed"));
    await expect(
      refreshSnapshot({
        store,
        client: source("2026-09-02").client,
        prepareActivation: () => ({ commit, dispose }),
      }),
    ).rejects.toThrow("rename failed");
    expect(commit).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(await store.readCurrent()).toBe(first.version);
    publish.mockRestore();
  });

  it("rejects an empty printing export while preserving the previous pointer and reader", async () => {
    const first = await refreshSnapshot({ store, client: source().client });
    const current = await openCurrentSnapshot(store);
    expect(current).not.toBeNull();
    try {
      await expect(
        refreshSnapshot({
          store,
          client: source("2026-09-02", "empty-printings").client,
        }),
      ).rejects.toThrow(/empty printing index/);
      expect(await store.readCurrent()).toBe(first.version);
      expect(current?.snapshot).toBe(first.snapshot);
      expect(current?.index.getPrintings(CARD.oracle_id)).toHaveLength(1);
      const restarted = await openCurrentSnapshot(store);
      expect(restarted?.version).toBe(first.version);
      expect(restarted?.index.getPrintings(CARD.oracle_id)).toHaveLength(1);
      restarted?.index.close();
    } finally {
      current?.index.close();
    }
  });

  it("does not publish a candidate whose activation preparation fails", async () => {
    const first = await refreshSnapshot({ store, client: source().client });
    await expect(
      refreshSnapshot({
        store,
        client: source("2026-09-02").client,
        prepareActivation: () => {
          throw new Error("cannot bind candidate");
        },
      }),
    ).rejects.toThrow("cannot bind candidate");
    expect(await store.readCurrent()).toBe(first.version);
  });

  it("skips unchanged complete data without downloading or replacing the database", async () => {
    const first = await refreshSnapshot({ store, client: source().client });
    const before = await stat(first.dbPath);
    const bytes = await readFile(first.dbPath);
    const same = source();
    const onPhase = vi.fn();
    const second = await refreshSnapshot({ store, client: same.client, onPhase });
    expect(second).toMatchObject({ version: first.version, skipped: true, cards: 1 });
    expect(same.downloads).not.toHaveBeenCalled();
    expect(onPhase).not.toHaveBeenCalledWith("build");
    const after = await stat(first.dbPath);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(first.dbPath)).toEqual(bytes);
  });

  it("rebuilds unchanged upstream into a new version when the legacy current index is missing", async () => {
    const first = await refreshSnapshot({ store, client: source().client });
    await rm(first.dbPath);
    const nextSource = source();
    const next = await refreshSnapshot({ store, client: nextSource.client });
    expect(next.version).not.toBe(first.version);
    expect(next.skipped).toBe(false);
    expect(nextSource.downloads).toHaveBeenCalledTimes(2);
    expect(await readdir(store.versionsDir)).toContain(first.version);
  });

  it("rebuilds an old Card format without changing recovery files or personal data", async () => {
    const first = await refreshSnapshot({ store, client: source().client });
    const legacy = new Database(first.dbPath);
    legacy.pragma("user_version = 0");
    legacy.exec("UPDATE cards SET card = json_remove(card, '$.gameplay')");
    legacy.close();
    const personal = new UserDataStore(root);
    const deck = personal.deckStore.create({ name: "Keep my deck" }, "alice");
    const updated = personal.deckStore.update(
      deck.deck_id,
      (d) => ({
        ...d,
        cards: [{ oracle_id: CARD.oracle_id, qty: 1 }],
        role_overrides: { [CARD.oracle_id]: ["ramp"] },
      }),
      "alice",
    );
    const snapshot = personal.deckStore.snapshot(deck.deck_id, "alice");
    personal.collection.add([CARD.oracle_id], "alice");
    personal.collection.add(["bob-card"], "bob");
    personal.close();
    const preservedPaths = [
      first.dbPath,
      store.filePath(first.version, "oracle_cards.json"),
      store.filePath(first.version, "default_cards.json"),
      store.filePath(first.version, "manifest.json"),
      path.join(root, "user-data.sqlite"),
    ];
    const before = await Promise.all(preservedPaths.map((file) => readFile(file)));
    const outdated = await openCurrentSnapshot(store);
    try {
      expect(outdated).toBeNull();
    } finally {
      outdated?.index.close();
    }

    await expect(
      refreshSnapshot({
        store,
        client: source("2026-09-01", "download").client,
      }),
    ).rejects.toThrow();
    expect(await store.readCurrent()).toBe(first.version);
    expect(await Promise.all(preservedPaths.map((file) => readFile(file)))).toEqual(before);

    const upstream = source();
    const rebuilt = await refreshSnapshot({ store, client: upstream.client });
    expect(rebuilt.version).not.toBe(first.version);
    expect(rebuilt).toMatchObject({ skipped: false, snapshot: first.snapshot });
    expect(upstream.downloads).toHaveBeenCalledTimes(2);
    expect(await Promise.all(preservedPaths.map((file) => readFile(file)))).toEqual(before);
    const reopened = await openCurrentSnapshot(store);
    try {
      expect(reopened?.version).toBe(rebuilt.version);
      expect(reopened?.index.getCard(CARD.oracle_id)).toMatchObject({
        gameplay: { version: 1, layout: "normal" },
      });
    } finally {
      reopened?.index.close();
    }
    const restored = new UserDataStore(root);
    try {
      expect(restored.deckStore.get(deck.deck_id, "alice")).toEqual(updated);
      expect(restored.deckStore.getSnapshot(deck.deck_id, snapshot.snapshot_id, "alice")).toEqual(
        snapshot,
      );
      expect(restored.deckStore.list("bob")).toEqual([]);
      expect(restored.collection.get("alice")).toEqual(new Set([CARD.oracle_id]));
      expect(restored.collection.get("bob")).toEqual(new Set(["bob-card"]));
    } finally {
      restored.close();
    }
  });

  it("recovers the compatible explicit predecessor when the current Card format is incompatible", async () => {
    const first = await refreshSnapshot({ store, client: source().client });
    const second = await refreshSnapshot({ store, client: source("2026-09-02").client });
    const incompatible = new Database(second.dbPath);
    incompatible.pragma("user_version = 99");
    incompatible.close();
    const recovered = await openCurrentSnapshot(store);
    try {
      expect(recovered?.version).toBe(first.version);
      expect(recovered?.index.getCard(CARD.oracle_id)?.name).toBe(CARD.name);
      expect(await store.readCurrent()).toBe(second.version);
    } finally {
      recovered?.index.close();
    }
  });

  it("rejects another refresh while the store lease is held and releases it after a failure", async () => {
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = refreshSnapshot({
      store,
      client: source().client,
      checkpoint: async (phase) => {
        if (phase === "after-download") {
          reached();
          await resume;
          throw new Error("stop owner");
        }
      },
    });
    const failedOwner = expect(first).rejects.toThrow("stop owner");
    await paused;
    const contender = source();
    await expect(
      refreshSnapshot({ store: new VersionedStore(root), client: contender.client }),
    ).rejects.toThrow(/already running/i);
    expect(contender.downloads).not.toHaveBeenCalled();
    release();
    await failedOwner;
    await expect(refreshSnapshot({ store, client: source().client })).resolves.toMatchObject({
      cards: 1,
    });
  });

  it("recovers the explicit previous version when the current database is unusable", async () => {
    const first = await refreshSnapshot({ store, client: source().client });
    const second = await refreshSnapshot({ store, client: source("2026-09-02").client });
    await writeFile(second.dbPath, "broken sqlite");
    const recovered = await openCurrentSnapshot(store);
    expect(recovered?.version).toBe(first.version);
    expect(recovered?.snapshot).toBe(first.snapshot);
    recovered?.index.close();
  });

  it("keeps a committed result successful when a post-publication diagnostic fails", async () => {
    const dispose = vi.fn();
    const result = await refreshSnapshot({
      store,
      client: source().client,
      prepareActivation: () => ({ commit: () => {}, dispose }),
      checkpoint: (phase) => {
        if (phase === "after-publish") throw new Error("diagnostic failed");
      },
    });
    expect(await store.readCurrent()).toBe(result.version);
    expect(dispose).not.toHaveBeenCalled();
  });
});
