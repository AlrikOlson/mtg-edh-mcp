import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { BulkClient, VersionedStore } from "../ingest/index.js";
import { refreshSnapshot } from "../index/refresh.js";
import { UserDataStore } from "../storage/userData.js";
import { runDoctor, runSetup } from "./setup.js";

let root: string;
const now = Date.parse("2026-09-08T01:00:00Z");
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mtg-setup-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
const options = () => ({
  env: { MCP_DATA_DIR: root },
  executable: "/path with spaces/node",
  entrypoint: "/path with spaces/dist/main.js",
  nodeVersion: "24.1.0",
  now: () => now,
});

async function files(directory = root): Promise<unknown> {
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const filename = join(directory, entry.name);
        const info = await stat(filename);
        return [
          entry.name,
          info.mtimeMs,
          entry.isDirectory()
            ? await files(filename)
            : createHash("sha256")
                .update(await readFile(filename))
                .digest("hex"),
        ];
      }),
  );
}

async function seed(): Promise<VersionedStore> {
  const store = new VersionedStore(root);
  await runSetup(options());
  await refreshSnapshot({
    store,
    client: new BulkClient({
      now: () => 0,
      sleep: async () => {},
      fetch: async (input) =>
        String(input).endsWith("/bulk-data")
          ? Response.json({
              data: ["oracle_cards", "default_cards"].map((type) => ({
                type,
                updated_at: "2026-09-08T00:00:00Z",
                download_uri: `https://fixture/${type}`,
              })),
            })
          : Response.json([
              {
                oracle_id: "oracle",
                id: "printing",
                name: "Test Card",
                cmc: 1,
                type_line: "Artifact",
                oracle_text: "Draw a card.",
                colors: [],
                color_identity: [],
                legalities: { commander: "legal" },
                prices: { usd: "1.00" },
                set: "tst",
                set_name: "Test",
                collector_number: "1",
                rarity: "common",
              },
            ]),
    }),
  });
  return store;
}

describe("setup", () => {
  it("initializes a nested root and emits an absolute credential-free client configuration", async () => {
    const nestedRoot = join(root, "nested", "cards");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const report = await runSetup({
      ...options(),
      env: { MCP_DATA_DIR: nestedRoot, SECRET_TOKEN: "hidden" },
    });
    expect(report.exitCode).toBe(0);
    expect(report.clientConfig).toEqual({
      mcpServers: {
        "mtg-edh": {
          command: resolve("/path with spaces/node"),
          args: [resolve("/path with spaces/dist/main.js"), "--stdio"],
          env: { MCP_DATA_DIR: nestedRoot },
        },
      },
    });
    expect(JSON.stringify(report)).not.toContain("hidden");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await stat(join(nestedRoot, "user-data.sqlite"))).size).toBeGreaterThan(0);
  });

  it("can run twice without changing existing decks, collections, backups or client files", async () => {
    await runSetup(options());
    const storage = new UserDataStore(root);
    const deck = storage.deckStore.create({ name: "Keep me" });
    storage.collection.add(["owned"]);
    storage.close();
    await writeFile(join(root, "client.json"), '{"custom":"keep"}');
    const before = await files();
    expect((await runSetup(options())).exitCode).toBe(0);
    expect(await files()).toEqual(before);
    const reopened = new UserDataStore(root);
    try {
      expect(reopened.deckStore.get(deck.deck_id)?.name).toBe("Keep me");
      expect(reopened.collection.get()).toEqual(new Set(["owned"]));
    } finally {
      reopened.close();
    }
  });

  it("reports broken storage without returning its contents or resetting it", async () => {
    await writeFile(join(root, "decks.json"), "PRIVATE_TOKEN=hidden");
    const report = await runSetup(options());
    expect(report.exitCode).toBe(1);
    expect(JSON.stringify(report)).not.toContain("hidden");
    expect(await readFile(join(root, "decks.json"), "utf8")).toBe("PRIVATE_TOKEN=hidden");
  });
});

describe("doctor", () => {
  it("reports missing initialization without creating the root or starting networking", async () => {
    const missing = join(root, "missing");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const before = await files();
    const report = await runDoctor({ ...options(), env: { MCP_DATA_DIR: missing } });
    expect(report.exitCode).toBe(2);
    expect(report.nextSteps.join(" ")).toContain("setup");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await files()).toEqual(before);
  });

  it("validates a complete WAL-format card snapshot and user data without filesystem writes", async () => {
    await seed();
    const before = await files();
    const report = await runDoctor(options());
    expect(report.exitCode).toBe(0);
    expect(report.checks.find((check) => check.name === "card_data")?.status).toBe("ok");
    expect(await files()).toEqual(before);
  });

  it("reports stale data using the same configured cadence as serving", async () => {
    await seed();
    const report = await runDoctor({
      ...options(),
      env: { MCP_DATA_DIR: root, MCP_BULK_INTERVAL_MS: "1000" },
    });
    expect(report.exitCode).toBe(2);
    expect(report.nextSteps.join(" ")).toContain("data_ingest");
  });

  it.each(["index", "user", "pointer"])(
    "diagnoses corrupt %s without modifying it",
    async (damage) => {
      const store = await seed();
      const current = await store.readCurrent();
      if (!current) throw new Error("No seeded snapshot");
      const target =
        damage === "index"
          ? store.filePath(current, "index.sqlite")
          : damage === "user"
            ? join(root, "user-data.sqlite")
            : store.pointerPath;
      await writeFile(target, "secret=do-not-output");
      const before = await files();
      const report = await runDoctor(options());
      expect(report.exitCode).toBe(1);
      expect(JSON.stringify(report)).not.toContain("do-not-output");
      expect(await files()).toEqual(before);
    },
  );

  it("does not inspect an incomplete main-file image while uncheckpointed WAL data exists", async () => {
    await seed();
    const db = new Database(join(root, "user-data.sqlite"));
    db.exec("UPDATE metadata SET value = value || 'x' WHERE key = 'legacy_decks_imported'");
    try {
      const before = await files();
      const report = await runDoctor(options());
      expect(report.exitCode).toBe(2);
      expect(report.nextSteps.join(" ")).toContain("Stop");
      expect(await files()).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("reports initialized-but-missing user storage as broken without recreating it", async () => {
    await runSetup(options());
    await rm(join(root, "user-data.sqlite"));
    const before = await files();
    expect((await runDoctor(options())).exitCode).toBe(1);
    expect(await files()).toEqual(before);
  });

  it("reports unsupported runtimes and non-directory roots with actionable failures", async () => {
    expect((await runDoctor({ ...options(), nodeVersion: "23.0.0" })).exitCode).toBe(1);
    const target = join(root, "file");
    await writeFile(target, "keep");
    expect((await runDoctor({ ...options(), env: { MCP_DATA_DIR: target } })).exitCode).toBe(1);
  });

  it.each([
    ["22.12.0", false],
    ["22.13.0", true],
    ["24.0.0", true],
    ["25.0.0", false],
    ["26.0.0", true],
  ] as const)("checks the supported Node engine boundary at %s", async (nodeVersion, supported) => {
    const report = await runDoctor({ ...options(), nodeVersion });
    expect(report.runtime.supported).toBe(supported);
    expect(report.checks.find((check) => check.name === "node")?.status).toBe(
      supported ? "ok" : "error",
    );
  });

  it("reports a native SQLite probe failure with reinstall guidance and no raw diagnostic secrets", async () => {
    const probe = vi.spyOn(Database.prototype, "prepare").mockImplementationOnce(() => {
      throw new Error("native addon path includes secret-token");
    });
    try {
      const before = await files();
      const report = await runDoctor(options());
      expect(report.exitCode).toBe(1);
      expect(report.runtime.sqlite).toBe(false);
      expect(report.nextSteps.join(" ")).toContain("Reinstall");
      expect(JSON.stringify(report)).not.toContain("secret-token");
      expect(await files()).toEqual(before);
    } finally {
      probe.mockRestore();
    }
  });

  it
    .skipIf(process.platform === "win32" || process.getuid?.() === 0)
    .each([
      "root",
      "user-data.sqlite",
      "backups",
      "versions",
      "user-data-lock.sqlite",
      ".refresh-lock.sqlite",
    ])("reports actual denied write permissions for %s without writing a probe", async (target) => {
    await seed();
    const storage = new UserDataStore(root);
    storage.deckStore.create({ name: "Backup required" });
    storage.close();
    const filename = target === "root" ? root : join(root, target);
    const originalMode = (await stat(filename)).mode;
    await chmod(filename, 0o500);
    try {
      const before = await files();
      const report = await runDoctor(options());
      expect(report.exitCode).toBe(1);
      expect(report.nextSteps.join(" ")).toMatch(/permissions|access/);
      expect(await files()).toEqual(before);
    } finally {
      await chmod(filename, originalMode);
    }
  });
});
