/**
 * Exercise the artifact a user installs, outside the checkout, without Scryfall
 * downloads. Run through npm run test:package so the npm CLI path is portable.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

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

  const transports = new WeakMap();
  async function connect(nodeArgs = [], serverEnv = env, modern = false) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...nodeArgs, entry, "--stdio"],
      cwd: consumer,
      env: serverEnv,
      stderr: "pipe",
    });
    let diagnostics = "";
    transport.stderr?.on("data", (chunk) => {
      diagnostics += chunk.toString();
    });
    const client = new Client(
      { name: "package-smoke", version: "1.0.0" },
      {
        versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy" },
      },
    );
    try {
      await client.connect(transport, { timeout: 10_000 });
      assert.equal(client.getProtocolEra(), modern ? "modern" : "legacy");
    } catch (error) {
      await transport.close();
      throw new Error(`Packaged server failed to initialize: ${diagnostics}`, {
        cause: error,
      });
    }
    assert.equal(client.getServerVersion()?.version, manifest.version);
    transports.set(client, transport);
    return client;
  }

  async function killImmediately(server) {
    const pid = transports.get(server)?.pid;
    assert.equal(typeof pid, "number", "The installed stdio server must be a separate process.");
    let timer;
    const exited = new Promise((resolve, reject) => {
      server.onclose = resolve;
      timer = setTimeout(() => reject(new Error("Killed installed server did not exit")), 10_000);
    });
    process.kill(pid, "SIGKILL");
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
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
        updated_at: fixture.updatedAt ?? fixture.snapshot + "T09:00:00.000Z",
        jsonl_download_uri: "https://offline.invalid/" + type + ".jsonl.gz",
      })),
    });
  }
  if (url === "https://offline.invalid/oracle_cards.jsonl.gz" ||
      url === "https://offline.invalid/default_cards.jsonl.gz") {
    const bytes = gzipSync(JSON.stringify(fixture.card) + "\n");
    if (fixture.interrupt && url.includes("oracle_cards")) {
      return new Response(new ReadableStream({
        start(controller) {
          // Leave an incomplete gzip body on disk so recovery exercises a
          // real interrupted download, not just a rejected metadata request.
          controller.enqueue(bytes.subarray(0, bytes.length - 8));
          if (fixture.interrupt === "error") {
            setTimeout(() => controller.error(new Error("Fixture download interrupted")), 50);
          }
        },
      }));
    }
    return new Response(bytes);
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

  function runInstalledIngest(serverEnv = env) {
    const result = spawnSync(
      process.execPath,
      [...nodeArgs, join(packageRoot, "dist", "ingest.js")],
      { cwd: consumer, env: serverEnv, encoding: "utf8", timeout: 10_000 },
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

  async function treeState(directory) {
    let info;
    try {
      info = await stat(directory);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    return {
      modified: info.mtimeMs,
      ...(info.isDirectory()
        ? {
            children: Object.fromEntries(
              await Promise.all(
                (await readdir(directory))
                  .sort()
                  .map(async (name) => [name, await treeState(join(directory, name))]),
              ),
            ),
          }
        : {
            size: info.size,
            hash: createHash("sha256")
              .update(await readFile(directory))
              .digest("hex"),
          }),
    };
  }

  // Setup and doctor execute through the installed CLI, with poisoned secret
  // values and the same deterministic network trap as production bootstrap.
  const secret = "package-smoke-secret-do-not-print";
  const setupRoot = join(temp, "setup data");
  const setupEnv = {
    ...env,
    MCP_DATA_DIR: setupRoot,
    MCP_BULK_INTERVAL_MS: String(12 * 60 * 60 * 1000),
    OPENAI_API_KEY: secret,
    MCP_API_KEY: secret,
  };
  function runOperation(command, expectedCode, operationEnv = setupEnv) {
    const result = spawnSync(process.execPath, [...nodeArgs, entry, command], {
      cwd: consumer,
      env: operationEnv,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, expectedCode, `${command}: ${result.stdout}\n${result.stderr}`);
    assert(!`${result.stdout}${result.stderr}`.includes(secret), `${command} leaked a secret`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, command);
    assert.equal(report.exitCode, expectedCode);
    assert.equal(report.paths.dataRoot, operationEnv.MCP_DATA_DIR);
    assert.equal(
      report.status,
      expectedCode === 0 ? "ready" : expectedCode === 2 ? "needs_action" : "error",
    );
    return report;
  }
  async function doctor(expectedCode, operationEnv = setupEnv) {
    const before = await treeState(operationEnv.MCP_DATA_DIR);
    const networkBefore = await treeState(fetchTracePath);
    const report = runOperation("doctor", expectedCode, operationEnv);
    assert.deepEqual(
      await treeState(operationEnv.MCP_DATA_DIR),
      before,
      "Doctor changed local data",
    );
    assert.deepEqual(
      await treeState(fetchTracePath),
      networkBefore,
      "Doctor made a network request",
    );
    return report;
  }
  await doctor(2);
  const setupNetwork = await treeState(fetchTracePath);
  const firstSetup = runOperation("setup", 0);
  assert(firstSetup.clientConfig, "Setup must provide client configuration");
  const configuredServers = Object.values(firstSetup.clientConfig.mcpServers);
  assert.equal(configuredServers.length, 1);
  assert.deepEqual(
    configuredServers[0],
    {
      command: process.execPath,
      args: [await realpath(entry), "--stdio"],
      env: { MCP_DATA_DIR: setupRoot },
    },
    "Setup configuration must use the installed entrypoint and only the required data directory",
  );
  const setupState = await treeState(setupRoot);
  runOperation("setup", 0);
  // Opening and closing SQLite can change the root mtime via temporary sidecars.
  assert.deepEqual(
    (await treeState(setupRoot)).children,
    setupState.children,
    "Repeated setup must preserve initialized storage",
  );
  assert.deepEqual(
    await treeState(fetchTracePath),
    setupNetwork,
    "Setup must not download card data",
  );
  await doctor(2); // Setup prepares storage; the user explicitly starts the download.
  const freshTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await writeFile(
    fixturePath,
    JSON.stringify({
      ...oldFixture,
      snapshot: freshTime.slice(0, 10),
      updatedAt: freshTime,
    }),
  );
  runInstalledIngest(setupEnv);
  await doctor(0);
  await doctor(2, { ...setupEnv, MCP_BULK_INTERVAL_MS: "1" });
  const setupPointer = JSON.parse(await readFile(join(setupRoot, "current.json"), "utf8"));
  const setupIndex = join(setupRoot, "versions", setupPointer.version, "index.sqlite");
  const validIndex = await readFile(setupIndex);
  await writeFile(setupIndex, "deliberately corrupt card index");
  await doctor(1);
  await writeFile(setupIndex, validIndex);
  await writeFile(join(setupRoot, "user-data.sqlite"), "deliberately corrupt user data");
  await doctor(1);

  async function ingestToPhase(server, phase) {
    const started = await server.callTool({
      name: "data_ingest",
      arguments: {},
    });
    assert(!started.isError, JSON.stringify(started));
    assert.equal(started.structuredContent.started, true);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await server.callTool({
        name: "data_status",
        arguments: {},
      });
      assert(!result.isError, JSON.stringify(result));
      const status = result.structuredContent;
      if (status.ingest.phase === phase) {
        assert.equal(status.ingest.running, false);
        assert.equal(status.has_index, phase === "done");
        return status;
      }
      assert.notEqual(status.ingest.phase, "error", JSON.stringify(status.ingest));
      await delay(20);
    }
    assert.fail(`Installed ingest never reached ${phase}`);
  }

  async function expectFirstActivation(server) {
    const names = (await server.listTools()).tools.map((tool) => tool.name);
    assert(names.includes("card_search"), "Connected first-run client must discover card_search");
    const search = await server.callTool({
      name: "card_search",
      arguments: { query: "t:artifact" },
    });
    assert(!search.isError, JSON.stringify(search));
    assert.equal(search.structuredContent.data_snapshot, oldFixture.snapshot);
    assert.deepEqual(
      search.structuredContent.results.map((card) => card.oracle_id),
      [oracleId],
    );
    await expectInstalledCard(server, oldFixture);
    const card = await server.readResource({ uri: `card://${oracleId}` });
    assert.equal(JSON.parse(card.contents[0].text).name, oldFixture.card.name);
    assert(
      (await server.listPrompts()).prompts.some((prompt) => prompt.name === "build_commander_deck"),
    );
    const prompt = await server.getPrompt({
      name: "build_commander_deck",
      arguments: { commander: oldFixture.card.name },
    });
    assert(JSON.stringify(prompt.messages).includes(oldFixture.card.name));
    const created = await server.callTool({
      name: "deck_create",
      arguments: { name: "First activation" },
    });
    assert(!created.isError, JSON.stringify(created));
    const added = await server.callTool({
      name: "deck_add",
      arguments: {
        deck_id: created.structuredContent.deck_id,
        cards: oldFixture.card.name,
      },
    });
    assert(!added.isError, JSON.stringify(added));
    const deck = await server.callTool({
      name: "deck_get",
      arguments: { deck_id: created.structuredContent.deck_id },
    });
    assert.equal(deck.structuredContent.deck.cards[0].oracle_id, oracleId);
    assert(names.includes("deck_set_roles"), "Installed catalog includes role corrections");
    for (const roles of [[], null]) {
      const correction = await server.callTool({
        name: "deck_set_roles",
        arguments: {
          deck_id: created.structuredContent.deck_id,
          card: oracleId,
          roles,
        },
      });
      assert(!correction.isError, JSON.stringify(correction));
      assert.equal(correction.structuredContent.ok, true);
      assert.equal(
        correction.structuredContent.role_source,
        roles === null ? "classifier" : "user_override",
      );
      assert.deepEqual(
        correction.structuredContent.effective_roles,
        roles === null ? correction.structuredContent.inferred_roles : [],
      );
      assert(
        correction.content.some(
          (block) =>
            block.type === "text" && block.text === JSON.stringify(correction.structuredContent),
        ),
      );
    }
  }

  async function firstRun(server, directory, interrupt = false) {
    assert.equal(
      (await server.callTool({ name: "data_status", arguments: {} })).structuredContent.has_index,
      false,
    );
    if (interrupt) {
      await writeFile(fixturePath, JSON.stringify({ ...oldFixture, interrupt: "error" }));
      await ingestToPhase(server, "error");
      assert.equal(
        await treeState(join(directory, "current.json")),
        null,
        "Failed ingest published a pointer",
      );
    }
    await writeFile(fixturePath, JSON.stringify(oldFixture));
    const status = await ingestToPhase(server, "done");
    assert.equal(status.data_snapshot, oldFixture.snapshot);
    await expectFirstActivation(server);
  }

  const firstRoot = join(temp, "first stdio ingest");
  const firstClient = await connect(
    nodeArgs,
    {
      ...env,
      MCP_DATA_DIR: firstRoot,
    },
    true,
  );
  try {
    await firstRun(firstClient, firstRoot, true);
  } finally {
    await firstClient.close();
  }

  const killedRoot = join(temp, "interrupted first ingest");
  await writeFile(fixturePath, JSON.stringify({ ...oldFixture, interrupt: "hold" }));
  const killedClient = await connect(nodeArgs, {
    ...env,
    MCP_DATA_DIR: killedRoot,
  });
  try {
    const started = await killedClient.callTool({
      name: "data_ingest",
      arguments: {},
    });
    assert.equal(started.structuredContent.started, true);
    const deadline = Date.now() + 10_000;
    let partial = false;
    while (Date.now() < deadline) {
      const state = await treeState(join(killedRoot, "versions"));
      partial = Object.values(state?.children ?? {}).some(
        (version) => version.children?.["oracle_cards.jsonl"]?.size > 0,
      );
      if (partial) break;
      await delay(20);
    }
    assert(partial, "SIGKILL must occur during a staged download");
    const status = await killedClient.callTool({
      name: "data_status",
      arguments: {},
    });
    assert.equal(status.structuredContent.ingest.running, true);
    assert.equal(status.structuredContent.has_index, false);
    assert.equal(await treeState(join(killedRoot, "current.json")), null);
    await killImmediately(killedClient);
  } finally {
    await killedClient.close();
  }
  const retryClient = await connect(nodeArgs, {
    ...env,
    MCP_DATA_DIR: killedRoot,
  });
  try {
    // No cleanup of the interrupted stage before retrying the normal tool.
    await firstRun(retryClient, killedRoot);
  } finally {
    await retryClient.close();
  }

  const httpRoot = join(temp, "first http ingest");
  const httpProcess = spawn(process.execPath, [...nodeArgs, entry, "--http"], {
    cwd: consumer,
    env: {
      ...env,
      MCP_DATA_DIR: httpRoot,
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let httpOutput = "";
  httpProcess.stdout.on("data", (chunk) => {
    httpOutput += chunk.toString();
  });
  httpProcess.stderr.on("data", (chunk) => {
    httpOutput += chunk.toString();
  });
  const httpExited = new Promise((resolve) => httpProcess.once("exit", resolve));
  const httpClient = new Client(
    {
      name: "package-http-smoke",
      version: "1.0.0",
    },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    const deadline = Date.now() + 10_000;
    let endpoint;
    while (Date.now() < deadline) {
      endpoint = httpOutput.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/)?.[0];
      if (endpoint) break;
      assert.equal(httpProcess.exitCode, null, httpOutput);
      await delay(20);
    }
    assert(endpoint, `Installed HTTP server did not listen: ${httpOutput}`);
    await httpClient.connect(new StreamableHTTPClientTransport(new URL(endpoint)), {
      timeout: 10_000,
    });
    assert.equal(httpClient.getProtocolEra(), "modern");
    await firstRun(httpClient, httpRoot, true);
  } finally {
    await httpClient.close();
    httpProcess.kill("SIGKILL");
    await httpExited;
  }

  await writeFile(fixturePath, JSON.stringify(oldFixture));
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
  let savedSnapshot;
  const indexed = await connect(nodeArgs);
  try {
    await expectInstalledCard(indexed, oldFixture);
    await writeFile(fixturePath, JSON.stringify(newFixture));
    const started = await indexed.callTool({
      name: "data_ingest",
      arguments: {},
    });
    assert(!started.isError, JSON.stringify(started));
    assert.equal(started.structuredContent.started, true);
    let completed = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await indexed.callTool({
        name: "data_status",
        arguments: {},
      });
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

    const collection = await indexed.callTool({
      name: "collection_set",
      arguments: { cards: oracleId },
    });
    assert(!collection.isError, JSON.stringify(collection));
    assert.deepEqual(collection.structuredContent.owned, [oracleId]);
    const added = await indexed.callTool({
      name: "deck_add",
      arguments: { deck_id: deckId, cards: oracleId },
    });
    assert(!added.isError, JSON.stringify(added));
    const snapshot = await indexed.callTool({
      name: "deck_snapshot",
      arguments: { deck_id: deckId },
    });
    assert(!snapshot.isError, JSON.stringify(snapshot));
    savedSnapshot = snapshot.structuredContent.snapshot_id;
    // Automatic pre-write backup of this rename contains the known deck,
    // collection and snapshot. Kill at the acknowledgement, without a flush.
    const renamed = await indexed.callTool({
      name: "deck_rename",
      arguments: { deck_id: deckId, name: "Acknowledged before SIGKILL" },
    });
    assert(!renamed.isError, JSON.stringify(renamed));
    await killImmediately(indexed);
  } finally {
    await indexed.close();
  }

  const refreshedRestart = await connect(nodeArgs);
  try {
    await expectInstalledCard(refreshedRestart, newFixture);
    const deck = await refreshedRestart.callTool({
      name: "deck_get",
      arguments: { deck_id: deckId },
    });
    assert(!deck.isError, JSON.stringify(deck));
    assert.equal(deck.structuredContent.deck.name, "Acknowledged before SIGKILL");
    assert.equal(deck.structuredContent.deck.cards[0].oracle_id, oracleId);
    const collection = await refreshedRestart.callTool({
      name: "collection_get",
      arguments: {},
    });
    assert(!collection.isError, JSON.stringify(collection));
    assert.deepEqual(collection.structuredContent.owned, [oracleId]);
  } finally {
    await refreshedRestart.close();
  }

  const backups = (await readdir(join(dataDir, "backups")))
    .filter((name) => name.endsWith(".sqlite"))
    .sort();
  assert(backups.length > 0, "Successful mutations must create automatic SQLite backups.");
  const selectedBackup = join(dataDir, "backups", backups.at(-1));
  const database = join(dataDir, "user-data.sqlite");
  const corruptBytes = Buffer.from(
    "Deliberately corrupted user data for installed restore acceptance\n",
  );
  await writeFile(database, corruptBytes);
  const corruptStart = spawnSync(process.execPath, [entry, "--stdio"], {
    cwd: consumer,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(corruptStart.status, 1, corruptStart.stderr);
  assert.equal(corruptStart.stdout, "");
  assert.deepEqual(
    await readFile(database),
    corruptBytes,
    "Startup must preserve corrupt user data.",
  );
  const recovered = spawnSync(process.execPath, [entry, "restore-user-data", selectedBackup], {
    cwd: consumer,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(recovered.status, 0, recovered.stderr);
  const recoveryReport = JSON.parse(recovered.stdout);
  assert.equal(recoveryReport.restoredFrom, selectedBackup);
  assert.equal(typeof recoveryReport.preservedPath, "string");
  assert.deepEqual(await readFile(recoveryReport.preservedPath), corruptBytes);
  const restored = await connect(nodeArgs);
  try {
    const deck = await restored.callTool({
      name: "deck_get",
      arguments: { deck_id: deckId },
    });
    assert(!deck.isError, JSON.stringify(deck));
    assert.equal(deck.structuredContent.deck.name, "Smoke deck");
    assert.equal(deck.structuredContent.deck.cards[0].oracle_id, oracleId);
    const collection = await restored.callTool({
      name: "collection_get",
      arguments: {},
    });
    assert(!collection.isError, JSON.stringify(collection));
    assert.deepEqual(collection.structuredContent.owned, [oracleId]);
    const snapshot = await restored.callTool({
      name: "deck_restore",
      arguments: { deck_id: deckId, snapshot_id: savedSnapshot },
    });
    assert(!snapshot.isError, JSON.stringify(snapshot));
    assert.equal(snapshot.structuredContent.deck.cards[0].oracle_id, oracleId);
    await expectInstalledCard(restored, newFixture);
  } finally {
    await restored.close();
  }
  assert.deepEqual(await versionHashes(firstPointer.version), firstHashes);
  console.log(
    "Package smoke passed: clean install, native SQLite, help/version, idempotent setup, read-only doctor, first-ingest activation over connected stdio and HTTP, interrupted download retries, resources/prompts/name resolution, durable decks/collections/snapshots after SIGKILL, explicit corrupted-store recovery, offline refresh CLI, unchanged reuse, hot activation, and refreshed restart.",
  );
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 3 });
}
