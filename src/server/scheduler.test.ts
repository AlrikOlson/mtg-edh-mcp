import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { VersionedStore, type Manifest } from "../ingest/index.js";
import { DEFAULT_FRESHNESS } from "../index/index.js";
import { IngestRunner, type IngestPipeline } from "./dataTools.js";
import { autoRefreshDisabled, bulkAgeMs, startScheduler } from "./scheduler.js";

const NOW = Date.parse("2026-08-16T12:00:00.000Z");

/** Stage a published version whose oracle bulk was updated `ageMs` before NOW. */
async function stageVersion(store: VersionedStore, ageMs: number): Promise<void> {
  const updated = new Date(NOW - ageMs).toISOString();
  await store.createVersion("v1");
  const manifest: Manifest = {
    version: "v1",
    snapshot: updated.slice(0, 10),
    created_at: updated,
    files: {
      oracle_cards: { name: "oracle_cards.jsonl", updated_at: updated, bytes: 1, source_uri: "u" },
      default_cards: {
        name: "default_cards.jsonl",
        updated_at: updated,
        bytes: 1,
        source_uri: "u",
      },
    },
  };
  await store.writeManifest("v1", manifest);
  await store.publish("v1");
}

/** A runner whose pipeline never resolves — we only observe start() calls. */
function countingRunner(): { runner: IngestRunner; starts: () => number } {
  let count = 0;
  const pipeline: IngestPipeline = () => {
    count += 1;
    return new Promise(() => undefined);
  };
  return { runner: new IngestRunner("unused", pipeline), starts: () => count };
}

let root: string;
let store: VersionedStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-sched-"));
  store = new VersionedStore(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("bulkAgeMs", () => {
  it("returns the age of the current version's oracle bulk", async () => {
    await stageVersion(store, 5_000);
    expect(await bulkAgeMs(store, NOW)).toBe(5_000);
  });

  it("returns null when no version exists", async () => {
    expect(await bulkAgeMs(store, NOW)).toBeNull();
  });
});

describe("startScheduler", () => {
  it("refreshes stale served data even when another process published fresh data", async () => {
    await stageVersion(store, 1_000);
    const { runner, starts } = countingRunner();
    const observedTimes: number[] = [];
    const sched = await startScheduler({
      runner,
      store,
      now: () => NOW,
      bulkAge: async (now) => {
        observedTimes.push(now);
        return DEFAULT_FRESHNESS.bulkIntervalMs + 1;
      },
      setIntervalFn: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
    });
    try {
      expect(starts()).toBe(1);
      expect(observedTimes).toEqual([NOW]);
    } finally {
      sched.stop();
    }
  });

  it("keeps first-run onboarding when served age is unknown despite an old disk pointer", async () => {
    await stageVersion(store, DEFAULT_FRESHNESS.bulkIntervalMs + 1);
    const { runner, starts } = countingRunner();
    const sched = await startScheduler({
      runner,
      store,
      now: () => NOW,
      bulkAge: async () => null,
      setIntervalFn: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
    });
    try {
      expect(starts()).toBe(0);
    } finally {
      sched.stop();
    }
  });

  it("kicks an ingest immediately when the bulk data is older than the interval", async () => {
    await stageVersion(store, DEFAULT_FRESHNESS.bulkIntervalMs + 1);
    const { runner, starts } = countingRunner();
    const sched = await startScheduler({
      runner,
      store,
      now: () => NOW,
      setIntervalFn: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
    });
    expect(starts()).toBe(1);
    sched.stop();
  });

  it("does nothing when the bulk data is fresh, then kicks on a later stale tick", async () => {
    await stageVersion(store, 1_000);
    const { runner, starts } = countingRunner();
    let tick: (() => void) | undefined;
    let clock = NOW;
    const sched = await startScheduler({
      runner,
      store,
      now: () => clock,
      setIntervalFn: (fn) => {
        tick = fn;
        return { unref: () => undefined } as unknown as NodeJS.Timeout;
      },
    });
    expect(starts()).toBe(0); // fresh at boot

    clock = NOW + DEFAULT_FRESHNESS.bulkIntervalMs; // 12h later: now stale
    tick?.();
    // The tick's check is async (two fs reads); poll until it lands.
    for (let i = 0; i < 200 && starts() === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(starts()).toBe(1);
    sched.stop();
  });

  it("never ingests a store that has no version at all (first-run is the GUI's job)", async () => {
    const { runner, starts } = countingRunner();
    const sched = await startScheduler({
      runner,
      store,
      now: () => NOW,
      setIntervalFn: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
    });
    expect(starts()).toBe(0);
    sched.stop();
  });
});

describe("autoRefreshDisabled", () => {
  it("is disabled only by MCP_AUTO_REFRESH=0/false", () => {
    expect(autoRefreshDisabled({})).toBe(false);
    expect(autoRefreshDisabled({ MCP_AUTO_REFRESH: "1" })).toBe(false);
    expect(autoRefreshDisabled({ MCP_AUTO_REFRESH: "0" })).toBe(true);
    expect(autoRefreshDisabled({ MCP_AUTO_REFRESH: "false" })).toBe(true);
  });
});
