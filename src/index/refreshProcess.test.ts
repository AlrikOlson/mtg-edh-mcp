import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { VersionedStore } from "../ingest/store.js";

interface Message {
  type: string;
  phase?: string;
  version?: string;
  snapshot?: string;
  skipped?: boolean;
  code?: string;
  message?: string;
}

interface Driver {
  child: ChildProcess;
  messages: Message[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  waitFor(type: string): Promise<Message>;
}

let fixtureDir: string;
let workerPath: string;
let root: string;
let store: VersionedStore;
let originalVersion: string;
let originalHashes: Record<string, string>;
const children: Driver[] = [];
const require = createRequire(import.meta.url);

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "mtg-refresh-driver-"));
  workerPath = path.join(fixtureDir, "worker.cjs");
  // Compile actual production code once for independent Node processes. Bare
  // packages resolve from this checkout, so the driver may live in an OS temp dir.
  await build({
    entryPoints: [fileURLToPath(new URL("./refreshProcess.fixture.ts", import.meta.url))],
    outfile: workerPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    plugins: [
      {
        name: "external-native-sqlite",
        setup(builder) {
          builder.onResolve({ filter: /^better-sqlite3$/ }, ({ path: specifier }) => ({
            path: require.resolve(specifier),
            external: true,
          }));
        },
      },
    ],
  });
});

afterAll(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

function start(mode: "refresh" | "read", generation = "new", pauseAt = ""): Driver {
  const child = fork(workerPath, [root, mode, generation, pauseAt], {
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: Message[] = [];
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => (stderr += data.toString()));
  child.on("message", (message: Message) => messages.push(message));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  const driver: Driver = {
    child,
    messages,
    exited,
    waitFor(type) {
      const existing = messages.find((message) => message.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          child.off("message", onMessage);
          child.off("exit", onExit);
        };
        const onMessage = (message: Message) => {
          if (message.type === type) {
            cleanup();
            resolve(message);
          }
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          cleanup();
          reject(new Error(`Driver exited before ${type}: ${code}/${signal}; ${stderr}`));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Driver did not reach ${type}; ${JSON.stringify(messages)}; ${stderr}`));
        }, 10_000);
        child.on("message", onMessage);
        child.once("exit", onExit);
      });
    },
  };
  children.push(driver);
  return driver;
}

async function hashes(version: string): Promise<Record<string, string>> {
  const files = await readdir(store.versionDir(version));
  return Object.fromEntries(
    await Promise.all(
      files.sort().map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(store.filePath(version, file)))
          .digest("hex"),
      ]),
    ),
  );
}

async function expectView(generation: "old" | "new", version?: string): Promise<void> {
  const reader = start("read");
  const view = await reader.waitFor("view");
  expect(await reader.exited).toEqual({ code: 0, signal: null });
  expect(view).toMatchObject({
    snapshot: generation === "old" ? "2026-09-01" : "2026-09-02",
    cards: 2,
    names: [`${generation} Card 1`, `${generation} Card 2`],
    fts: [`${generation} Card 1`, `${generation} Card 2`],
    printings: [1, 2].map((number) => [
      {
        scryfall_id: `${generation}-printing-${number}`,
        prices: { usd: generation === "old" ? "1.00" : "2.00" },
      },
    ]),
  });
  if (version) expect(view.version).toBe(version);
  expect(view.version).toBe(await store.readCurrent());
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-refresh-process-"));
  store = new VersionedStore(root);
  const seed = start("refresh", "old");
  const result = await seed.waitFor("result");
  expect(await seed.exited).toEqual({ code: 0, signal: null });
  expect(result.version).toBeTypeOf("string");
  originalVersion = result.version!;
  originalHashes = await hashes(originalVersion);
});

afterEach(async () => {
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(children.splice(0).map((driver) => driver.exited));
  if (root) await rm(root, { recursive: true, force: true });
});

describe("snapshot refresh across real process boundaries", () => {
  it.each(["after-download", "during-build", "before-publish", "after-publish"])(
    "a SIGKILL at %s restarts into one complete generation and preserves the previous files",
    async (phase) => {
      const refresher = start("refresh", "new", phase);
      expect(await refresher.waitFor("paused")).toMatchObject({ phase });
      const expected = phase === "after-publish" ? "new" : "old";
      // Another process can read while the writer holds the root lock and,
      // during-build, an actual uncommitted first card in the staged database.
      await expectView(expected, expected === "old" ? originalVersion : undefined);
      expect(refresher.child.kill("SIGKILL")).toBe(true);
      expect(await refresher.exited).toEqual({ code: null, signal: "SIGKILL" });

      // This starts a fresh Node process and goes through the startup opener.
      await expectView(expected, expected === "old" ? originalVersion : undefined);
      expect(await hashes(originalVersion)).toEqual(originalHashes);
    },
    20_000,
  );

  it("rejects a competing process before network or staging and releases a killed owner's lock", async () => {
    const owner = start("refresh", "new", "after-download");
    await owner.waitFor("paused");
    const stagedBefore = (await readdir(store.versionsDir)).sort();

    const contender = start("refresh", "new");
    expect(await contender.waitFor("error")).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(await contender.exited).toEqual({ code: 1, signal: null });
    expect(contender.messages.filter((message) => message.type === "fetch")).toEqual([]);
    expect(contender.messages.filter((message) => message.type === "checkpoint")).toEqual([]);
    expect((await readdir(store.versionsDir)).sort()).toEqual(stagedBefore);
    expect(await store.readCurrent()).toBe(originalVersion);
    await expectView("old", originalVersion);

    expect(owner.child.kill("SIGKILL")).toBe(true);
    expect(await owner.exited).toEqual({ code: null, signal: "SIGKILL" });
    const retry = start("refresh", "new");
    const result = await retry.waitFor("result");
    expect(result).toMatchObject({ skipped: false, snapshot: "2026-09-02" });
    expect(await retry.exited).toEqual({ code: 0, signal: null });
    await expectView("new", result.version);
    expect(await hashes(originalVersion)).toEqual(originalHashes);
  }, 20_000);
});
