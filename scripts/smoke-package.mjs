/**
 * Exercise the artifact a user installs, outside the checkout, without Scryfall
 * downloads. Run through npm run test:package so the npm CLI path is portable.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCli = process.env.npm_execpath;
assert(npmCli, "Run this check with npm run test:package.");
const temp = await mkdtemp(join(tmpdir(), "mtg-package-"));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

function npm(args, cwd) {
  execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    stdio: "inherit",
    timeout: 180_000,
  });
}

try {
  npm(["pack", "--pack-destination", temp], root);
  const archives = (await readdir(temp)).filter((file) => file.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  const consumer = join(temp, "consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  npm(["install", "--omit=dev", "--no-audit", "--no-fund", join(temp, archives[0])], consumer);
  const packageRoot = join(consumer, "node_modules", manifest.name);
  const entry = join(packageRoot, "dist", "main.js");
  const dataDir = join(temp, "saved decks");
  const env = {
    ...process.env,
    MCP_DATA_DIR: dataDir,
    MCP_AUTO_REFRESH: "0",
    MCP_TRANSPORT: "stdio",
    MCP_WATCH_STDIN: "0",
  };
  const installedFiles = await readdir(packageRoot);
  for (const excluded of ["src", "gui", ".env", ".magistr", ".claude", "data"]) {
    assert(!installedFiles.includes(excluded), `Unexpected packaged content: ${excluded}`);
  }
  for (const required of ["README.md", "LICENSE", "dist", "docs"]) {
    assert(installedFiles.includes(required), `Missing packaged content: ${required}`);
  }
  const library = await import(pathToFileURL(join(packageRoot, "dist", "index.js")).href);
  assert.equal(library.SERVER_VERSION, manifest.version);
  assert.equal(typeof library.createServer, "function");
  await readFile(join(packageRoot, "dist", "index.d.ts"));

  // Import and execute the installed native dependency, never the checkout's.
  const resolveInstalled = createRequire(join(packageRoot, "package.json"));
  // Windows cannot unlink a loaded native addon. Let a child own the DLL so
  // its process exits before the temporary installation is removed.
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import assert from "node:assert/strict";' +
        "const { default: Database } = await import(process.argv[1]);" +
        'const db = new Database(":memory:");' +
        'try { assert.deepEqual(db.prepare("select 1 as ready").get(), { ready: 1 }); }' +
        "finally { db.close(); }",
      pathToFileURL(resolveInstalled.resolve("better-sqlite3")).href,
    ],
    { cwd: consumer, stdio: "inherit", timeout: 10_000 },
  );

  for (const flag of ["--help", "--version"]) {
    const result = spawnSync(process.execPath, [entry, flag], {
      cwd: consumer,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert(result.stdout.includes(flag === "--version" ? manifest.version : "MCP_DATA_DIR"));
  }
  const shimVersion = execFileSync(
    process.execPath,
    [npmCli, "exec", "--offline", "--", "mtg-edh-mcp", "--version"],
    { cwd: consumer, env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(shimVersion.trim(), manifest.version, "Installed npm bin shim must execute.");
  assert(!(await readdir(temp)).includes("saved decks"), "Help must not create data directories.");
  const invalid = spawnSync(process.execPath, [entry, "--unknown"], {
    cwd: consumer,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /Unknown argument/);

  async function connect(nodeArgs = []) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...nodeArgs, entry, "--stdio"],
      cwd: consumer,
      env,
      stderr: "pipe",
    });
    let diagnostics = "";
    transport.stderr?.on("data", (chunk) => {
      diagnostics += chunk.toString();
    });
    const client = new Client({ name: "package-smoke", version: "1.0.0" });
    try {
      await client.connect(transport, { timeout: 10_000 });
    } catch (error) {
      await transport.close();
      throw new Error(`Packaged server failed to initialize: ${diagnostics}`, {
        cause: error,
      });
    }
    assert.equal(client.getServerVersion()?.version, manifest.version);
    return client;
  }

  let deckId;
  const client = await connect();
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["ping", "data_status", "data_ingest", "deck_create", "deck_get"]) {
      assert(names.includes(name), `Missing first-run tool: ${name}`);
    }
    const status = await client.callTool({
      name: "data_status",
      arguments: {},
    });
    assert.equal(status.structuredContent.has_index, false);
    assert(
      status.content.some(
        (block) => block.type === "text" && block.text === JSON.stringify(status.structuredContent),
      ),
    );
    const created = await client.callTool({
      name: "deck_create",
      arguments: { name: "Smoke deck" },
    });
    assert(!created.isError);
    deckId = created.structuredContent.deck_id;
    assert.equal(typeof deckId, "string");
    const resource = await client.readResource({ uri: `deck://${deckId}` });
    assert.equal(JSON.parse(resource.contents[0].text).name, "Smoke deck");
  } finally {
    await client.close();
  }

  const restarted = await connect();
  try {
    const deck = await restarted.callTool({
      name: "deck_get",
      arguments: { deck_id: deckId },
    });
    assert(!deck.isError);
    assert.equal(deck.structuredContent.deck.name, "Smoke deck");
  } finally {
    await restarted.close();
  }

  // Inject fetch only in these test processes, before installed entrypoints
  // load. The packaged CLI and server use their normal production bootstrap.
  const fixturePath = join(consumer, "scryfall-fixture.json");
  const fetchTracePath = join(consumer, "scryfall-fetches.jsonl");
  const preloadPath = join(consumer, "offline-scryfall.mjs");
  await writeFile(
    preloadPath,
    String.raw`
import { appendFile, readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

globalThis.fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  await appendFile(new URL("./scryfall-fetches.jsonl", import.meta.url), JSON.stringify(url) + "\n");
  const fixture = JSON.parse(await readFile(new URL("./scryfall-fixture.json", import.meta.url), "utf8"));
  if (url === "https://api.scryfall.com/bulk-data") {
    return Response.json({
      data: ["oracle_cards", "default_cards"].map((type) => ({
        type,
        updated_at: fixture.snapshot + "T09:00:00.000Z",
        jsonl_download_uri: "https://offline.invalid/" + type + ".jsonl.gz",
      })),
    });
  }
  if (url === "https://offline.invalid/oracle_cards.jsonl.gz" ||
      url === "https://offline.invalid/default_cards.jsonl.gz") {
    return new Response(gzipSync(JSON.stringify(fixture.card) + "\n"));
  }
  throw new Error("Unexpected network request in installed-package smoke: " + url);
};
`,
  );
  const nodeArgs = ["--import", pathToFileURL(preloadPath).href];
  const oracleId = "00000000-0000-4000-8000-000000000001";
  const oldFixture = {
    snapshot: "2026-09-01",
    card: {
      oracle_id: oracleId,
      id: "00000000-0000-4000-8000-000000000002",
      name: "Package Seed Card",
      cmc: 1,
      colors: [],
      color_identity: [],
      type_line: "Artifact",
      oracle_text: "{T}: Add {C}.",
      legalities: { commander: "legal" },
      set: "tst",
      set_name: "Installed package fixture",
      collector_number: "1",
      rarity: "common",
      prices: { usd: "1.00" },
    },
  };
  await writeFile(fixturePath, JSON.stringify(oldFixture));

  function runInstalledIngest() {
    const result = spawnSync(
      process.execPath,
      [...nodeArgs, join(packageRoot, "dist", "ingest.js")],
      { cwd: consumer, env, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "", "The ingestion CLI must keep diagnostics on stderr.");
    return result.stderr;
  }

  async function versionHashes(version) {
    const directory = join(dataDir, "versions", version);
    return Object.fromEntries(
      await Promise.all(
        (await readdir(directory)).sort().map(async (file) => [
          file,
          createHash("sha256")
            .update(await readFile(join(directory, file)))
            .digest("hex"),
        ]),
      ),
    );
  }

  const readPointer = async () => JSON.parse(await readFile(join(dataDir, "current.json"), "utf8"));
  const readFetches = async () =>
    (await readFile(fetchTracePath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.match(runInstalledIngest(), /Done: 1 cards, 1 printings/);
  const firstPointer = await readPointer();
  const firstHashes = await versionHashes(firstPointer.version);
  assert(
    firstHashes["index.sqlite"],
    "Installed CLI must build a SQLite index before publication.",
  );
  const initialFetches = await readFetches();
  assert(initialFetches.includes("https://offline.invalid/oracle_cards.jsonl.gz"));
  assert(initialFetches.includes("https://offline.invalid/default_cards.jsonl.gz"));

  assert.match(runInstalledIngest(), /Up to date: reused 1 cards .*no rebuild/);
  assert.deepEqual(
    await readPointer(),
    firstPointer,
    "Unchanged CLI ingestion must reuse the pointer.",
  );
  assert.deepEqual(await versionHashes(firstPointer.version), firstHashes);
  assert.deepEqual(await readdir(join(dataDir, "versions")), [firstPointer.version]);
  assert.deepEqual((await readFetches()).slice(initialFetches.length), [
    "https://api.scryfall.com/bulk-data",
    "https://api.scryfall.com/bulk-data",
  ]);

  async function expectInstalledCard(server, fixture) {
    const result = await server.callTool({
      name: "card_get",
      arguments: { cards: oracleId, include_printings: true },
    });
    assert(!result.isError, JSON.stringify(result));
    assert.equal(result.structuredContent.data_snapshot, fixture.snapshot);
    assert.equal(result._meta.data_snapshot, fixture.snapshot);
    assert.deepEqual(result.structuredContent.missing, []);
    assert.equal(result.structuredContent.cards.length, 1);
    const [card] = result.structuredContent.cards;
    assert.equal(card.name, fixture.card.name);
    assert.equal(card.oracle_text, fixture.card.oracle_text);
    assert.equal(card.printings.length, 1);
    assert.equal(card.printings[0].scryfall_id, fixture.card.id);
    assert.deepEqual(card.printings[0].prices, fixture.card.prices);
  }

  const newFixture = {
    snapshot: "2026-09-02",
    card: {
      ...oldFixture.card,
      id: "00000000-0000-4000-8000-000000000003",
      name: "Package Refreshed Card",
      oracle_text: "{T}: Add {C}{C}.",
      prices: { usd: "2.00" },
    },
  };
  const indexed = await connect(nodeArgs);
  try {
    await expectInstalledCard(indexed, oldFixture);
    await writeFile(fixturePath, JSON.stringify(newFixture));
    const started = await indexed.callTool({ name: "data_ingest", arguments: {} });
    assert(!started.isError, JSON.stringify(started));
    assert.equal(started.structuredContent.started, true);
    let completed = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await indexed.callTool({ name: "data_status", arguments: {} });
      assert(!result.isError, JSON.stringify(result));
      const status = result.structuredContent;
      assert.equal(status.has_index, true);
      assert.notEqual(status.ingest.phase, "error", status.ingest.error);
      if (status.ingest.phase === "done") {
        assert.equal(status.ingest.running, false);
        assert.equal(status.ingest.skipped, false);
        assert.equal(status.ingest.cards, 1);
        assert.equal(status.ingest.snapshot, newFixture.snapshot);
        assert.equal(status.data_snapshot, newFixture.snapshot);
        completed = true;
        break;
      }
      await delay(20);
    }
    assert(completed, "Installed data_ingest must finish within the offline smoke deadline.");
    await expectInstalledCard(indexed, newFixture);
    const nextPointer = await readPointer();
    assert.notEqual(nextPointer.version, firstPointer.version);
    assert.equal(nextPointer.previous, firstPointer.version);
    assert.deepEqual(await versionHashes(firstPointer.version), firstHashes);
  } finally {
    await indexed.close();
  }

  const refreshedRestart = await connect(nodeArgs);
  try {
    await expectInstalledCard(refreshedRestart, newFixture);
  } finally {
    await refreshedRestart.close();
  }
  assert.deepEqual(await versionHashes(firstPointer.version), firstHashes);
  console.log(
    "Package smoke passed: clean install, native SQLite, help/version, stdio, resources, persisted decks, offline refresh CLI, unchanged reuse, hot activation, and refreshed restart.",
  );
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 3 });
}
