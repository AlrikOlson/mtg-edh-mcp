/**
 * Exercise the artifact a user installs, outside the checkout, without Scryfall
 * downloads. Run through npm run test:package so the npm CLI path is portable.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  const { default: Database } = await import(
    pathToFileURL(resolveInstalled.resolve("better-sqlite3")).href
  );
  const db = new Database(":memory:");
  assert.deepEqual(db.prepare("select 1 as ready").get(), { ready: 1 });
  db.close();

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

  async function connect() {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, "--stdio"],
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
  console.log(
    "Package smoke passed: clean install, native SQLite, help/version, stdio, resources, and persisted decks.",
  );
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 3 });
}
