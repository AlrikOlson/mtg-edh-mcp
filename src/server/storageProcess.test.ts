import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { VersionedStore } from "../ingest/store.js";
import { BulkClient } from "../ingest/scryfall.js";
import { refreshSnapshot } from "../index/refresh.js";
import { PRINCIPAL_HEADER } from "./http.js";
import { UserDataStore } from "../storage/userData.js";

interface Message {
  type: string;
  port?: number;
  deck?: unknown;
}

interface Driver {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  waitFor(type: string): Promise<Message>;
}

let fixtureDir: string;
let root: string;
let indexPath: string;
const children: Driver[] = [];
const clients: Client[] = [];
const require = createRequire(import.meta.url);
const oracle = [
  {
    oracle_id: "o-captain",
    name: "Plan Captain",
    type_line: "Legendary Creature — Human",
    oracle_text: "",
    cmc: 2,
  },
  {
    oracle_id: "o-sol",
    name: "Sol Ring",
    type_line: "Artifact",
    oracle_text: "{T}: Add {C}{C}.",
    cmc: 1,
  },
  {
    oracle_id: "o-island",
    name: "Island",
    type_line: "Basic Land — Island",
    oracle_text: "({T}: Add {U}.)",
    cmc: 0,
  },
].map((card) => ({
  ...card,
  id: `printing-${card.oracle_id}`,
  layout: "normal",
  colors: [],
  color_identity: [],
  legalities: { commander: "legal" },
}));

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "mtg-storage-drivers-"));
  // Independent Node processes run the real CLI bootstrap and server/storage
  // code. Only the second entry adds explicit IPC fault controls for tests.
  await build({
    entryPoints: {
      main: fileURLToPath(new URL("./main.ts", import.meta.url)),
      fixture: fileURLToPath(new URL("./storageProcess.fixture.ts", import.meta.url)),
    },
    outdir: fixtureDir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    plugins: [
      {
        name: "external-native-sqlite",
        setup(builder) {
          builder.onResolve({ filter: /^better-sqlite3$/ }, ({ path: specifier }) => ({
            path: pathToFileURL(require.resolve(specifier)).href,
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

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-storage-process-"));
  const store = new VersionedStore(root);
  const seeded = await refreshSnapshot({
    store,
    client: new BulkClient({
      fetch: async (input) => {
        const url = String(input);
        if (url === "https://api.scryfall.com/bulk-data") {
          return Response.json({
            data: ["oracle_cards", "default_cards"].map((type) => ({
              type,
              download_uri: `https://offline.invalid/${type}`,
              updated_at: "2026-09-08T09:00:00.000Z",
            })),
          });
        }
        if (
          url === "https://offline.invalid/oracle_cards" ||
          url === "https://offline.invalid/default_cards"
        )
          return Response.json(oracle);
        throw new Error(`Unexpected storage fixture request: ${url}`);
      },
      sleep: () => Promise.resolve(),
      now: () => 0,
    }),
  });
  indexPath = seeded.dbPath;
});

afterEach(async () => {
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(children.splice(0).map((driver) => driver.exited));
  await Promise.all(clients.splice(0).map((client) => client.close()));
  if (root) await rm(root, { recursive: true, force: true });
});

function start(kind: "main" | "fixture" = "main"): Driver {
  const child = fork(
    path.join(fixtureDir, `${kind}.mjs`),
    kind === "fixture" ? [root, indexPath] : ["--http"],
    {
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        MCP_DATA_DIR: root,
        MCP_AUTO_REFRESH: "0",
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: "0",
        MCP_WATCH_STDIN: "0",
      },
    },
  );
  const messages: Message[] = [];
  let diagnostics = "";
  const listeners = new Set<(message: Message) => void>();
  const receive = (message: Message) => {
    messages.push(message);
    for (const listener of listeners) listener(message);
  };
  child.on("message", receive);
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
    const ready = /listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(diagnostics);
    if (ready && !messages.some((message) => message.type === "ready")) {
      receive({ type: "ready", port: Number(ready[1]) });
    }
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const driver: Driver = {
    child,
    exited,
    waitFor(type) {
      const position = messages.findIndex((message) => message.type === type);
      if (position !== -1) {
        const message = messages.splice(position, 1)[0];
        if (message) return Promise.resolve(message);
      }
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          listeners.delete(onMessage);
          child.off("exit", onExit);
        };
        const onMessage = (message: Message) => {
          if (message.type !== type) return;
          cleanup();
          messages.splice(messages.indexOf(message), 1);
          resolve(message);
        };
        const onExit = () => {
          cleanup();
          reject(new Error(`Storage driver exited before ${type}: ${diagnostics}`));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Storage driver did not reach ${type}: ${diagnostics}`));
        }, 10_000);
        listeners.add(onMessage);
        child.once("exit", onExit);
        if (child.exitCode !== null || child.signalCode !== null) onExit();
      });
    },
  };
  children.push(driver);
  return driver;
}

async function connect(driver: Driver, principal = "alice", port?: number): Promise<Client> {
  const address = port ?? (await driver.waitFor("ready")).port;
  if (!address) throw new Error("Storage driver did not publish its port");
  const client = new Client({ name: `storage-${principal}`, version: "1.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address}/mcp`), {
      requestInit: { headers: { [PRINCIPAL_HEADER]: principal } },
    }),
  );
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const body = result.structuredContent;
  if (!body || typeof body !== "object") throw new Error(`Missing structured ${name} result`);
  return { ...body };
}

function id(body: Record<string, unknown>, key = "deck_id"): string {
  const value = body[key];
  if (typeof value !== "string") throw new Error(`Expected ${key} in ${JSON.stringify(body)}`);
  return value;
}

async function kill(driver: Driver): Promise<void> {
  expect(driver.child.kill("SIGKILL")).toBe(true);
  expect(await driver.exited).toEqual({ code: null, signal: "SIGKILL" });
}

function persistedDeckDump() {
  const data = new UserDataStore(root);
  try {
    return data.deckStore.dump();
  } finally {
    data.close();
  }
}

function deckPlanInput(name = "Planned deck", includeSol = false): Record<string, unknown> {
  return {
    name,
    request: {
      commanders: ["Plan Captain"],
      command_zone_kind: "single",
      budget: { mode: "unbounded" },
      cards: [
        { oracle_id: "Island", qty: includeSol ? 98 : 99 },
        ...(includeSol ? [{ oracle_id: "Sol Ring", qty: 1 }] : []),
      ],
    },
  };
}

describe("atomic deck plans across real MCP processes", () => {
  it.each(["new", "partial"])(
    "constructs a reviewed %s deck, rolls back an injected apply failure and restores after retry",
    async (kind) => {
      const writer = start("fixture");
      const client = await connect(writer);
      const source =
        kind === "partial"
          ? await call(client, "deck_create", { name: "Empty saved draft" })
          : undefined;
      const deckId = source ? id(source) : undefined;
      const baseline = deckId ? await call(client, "deck_get", { deck_id: deckId }) : undefined;
      const before = persistedDeckDump();
      // This tiny process fixture isolates transaction behavior. Diverse complete
      // game plans and ordinary land ratios live in constructionBenchmark.test.ts.
      const generated = await call(client, "deck_construct", {
        name: "Generated complete deck",
        request: {
          commanders: ["Plan Captain"],
          budget: { mode: "unbounded" },
          lands: { min: 98, max: 98, strength: "hard" },
          roles: { ramp: { min: 1, max: 1, strength: "hard" } },
          strategy_dependencies: [
            {
              id: "mana-source",
              strength: "hard",
              requires_cards: ["Sol Ring"],
            },
          ],
        },
        ...(deckId ? { deck_id: deckId, expected_version: 1 } : {}),
      });
      expect(
        generated,
        JSON.stringify({
          normalization: generated.normalization,
          search: generated.search,
        }),
      ).toMatchObject({
        status: "found",
        validation: { valid: true },
      });
      expect(generated.plan).toBeTruthy();
      expect(persistedDeckDump()).toEqual(before);
      writer.child.send({ type: "fail-next-commit" });
      await writer.waitFor("armed");
      expect(
        await client.callTool({
          name: "deck_plan_apply",
          arguments: { plan: generated.plan },
        }),
      ).toMatchObject({
        isError: true,
        structuredContent: { code: "STORAGE_ERROR" },
      });
      expect(persistedDeckDump()).toEqual(before);
      await kill(writer);
      const restarted = await connect(start("fixture"));
      expect(persistedDeckDump()).toEqual(before);
      const saved = await call(restarted, "deck_plan_apply", {
        plan: generated.plan,
      });
      if (!generated.desired || typeof generated.desired !== "object")
        throw new Error("Missing reviewed desired deck");
      expect(saved.deck).toEqual({
        ...generated.desired,
        deck_id: saved.deck_id,
      });
      expect(saved).toMatchObject({
        version: kind === "new" ? 1 : 2,
        replayed: false,
      });
      const checked = await call(restarted, "validate_deck", {
        deck_id: saved.deck_id,
      });
      expect(checked).toMatchObject({ ok: true, error_count: 0 });
      expect(await call(restarted, "deck_plan_apply", { plan: generated.plan })).toMatchObject({
        replayed: true,
        deck: saved.deck,
      });
      if (deckId) {
        await call(restarted, "deck_restore", {
          deck_id: deckId,
          snapshot_id: saved.snapshot_id,
        });
        if (!baseline?.deck || typeof baseline.deck !== "object")
          throw new Error("Missing baseline deck");
        expect((await call(restarted, "deck_get", { deck_id: deckId })).deck).toEqual({
          ...baseline.deck,
          version: 3,
        });
      }
    },
    30_000,
  );

  it("previews without writes and creates only once across concurrent apply and SIGKILL retry", async () => {
    const first = start();
    const second = start();
    const [a, b] = await Promise.all([connect(first), connect(second)]);
    const beforePreview = persistedDeckDump();
    const preview = await call(a, "deck_plan_preview", {
      input: deckPlanInput(),
    });
    expect(preview).toMatchObject({ ok: true, validation: { valid: true } });
    expect(persistedDeckDump()).toEqual(beforePreview);
    expect(await call(a, "deck_list")).toMatchObject({ total: 0 });
    const applied = await Promise.all(
      [a, b].map((client) => call(client, "deck_plan_apply", { plan: preview.plan })),
    );
    expect(applied.filter((result) => result.replayed === false)).toHaveLength(1);
    expect(applied.filter((result) => result.replayed === true)).toHaveLength(1);
    expect(applied[0]?.deck).toEqual(applied[1]?.deck);
    const saved = applied[0];
    if (!saved) throw new Error("Missing applied plan");
    expect(saved).toMatchObject({
      version: 1,
      deck: {
        version: 1,
        commanders: ["o-captain"],
        cards: [{ oracle_id: "o-island", qty: 99 }],
      },
    });
    await Promise.all([kill(first), kill(second)]);
    const reader = start();
    const ready = await reader.waitFor("ready");
    const alice = await connect(reader, "alice", ready.port);
    const bob = await connect(reader, "bob", ready.port);
    expect(await call(alice, "deck_plan_apply", { plan: preview.plan })).toMatchObject({
      ok: true,
      replayed: true,
      deck: saved.deck,
    });
    expect(await call(alice, "deck_list")).toMatchObject({ total: 1 });
    expect(
      await bob.callTool({
        name: "deck_plan_apply",
        arguments: { plan: preview.plan },
      }),
    ).toMatchObject({ isError: true });
    expect(await call(bob, "deck_list")).toMatchObject({ total: 0 });
    // A separately previewed identical deck is an intentional new creation.
    const another = await call(alice, "deck_plan_preview", {
      input: deckPlanInput(),
    });
    const next = await call(alice, "deck_plan_apply", { plan: another.plan });
    expect(next.deck_id).not.toEqual(saved.deck_id);
    expect(await call(alice, "deck_list")).toMatchObject({ total: 2 });
  }, 30_000);

  it("admits one competing plan at a version and restores the complete pre-change state", async () => {
    const first = start();
    const second = start();
    const [a, b] = await Promise.all([connect(first), connect(second)]);
    const seed = await call(a, "deck_plan_preview", { input: deckPlanInput() });
    const initial = await call(a, "deck_plan_apply", { plan: seed.plan });
    const deckId = id(initial);
    await call(a, "deck_set_roles", {
      deck_id: deckId,
      card: "Island",
      roles: ["utility"],
    });
    const intent = await call(a, "deck_set_intent", {
      expected_version: 2,
      deck_id: deckId,
      action: "set",
      intent: {
        schema_version: 1,
        hard: { locked_cards: [{ oracle_id: "o-island", qty: 98 }] },
      },
    });
    const before = await call(a, "deck_get", { deck_id: deckId });
    const previews = await Promise.all(
      [a, b].map((client, n) =>
        call(client, "deck_plan_preview", {
          deck_id: deckId,
          expected_version: intent.version,
          input: deckPlanInput("Winner " + n, true),
        }),
      ),
    );
    const responses = await Promise.all(
      [a, b].map((client, n) =>
        client.callTool({
          name: "deck_plan_apply",
          arguments: { plan: previews[n]?.plan },
        }),
      ),
    );
    const bodies: Record<string, unknown>[] = responses.map((response) => {
      const body = response.structuredContent;
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("Missing plan response");
      return { ...body };
    });
    const winners = bodies.filter((body) => body?.ok === true);
    expect(winners).toHaveLength(1);
    expect(bodies.filter((body) => body?.conflict === true)).toHaveLength(1);
    const winner = winners[0];
    if (!winner || typeof winner.snapshot_id !== "string")
      throw new Error("Missing pre-change snapshot");
    expect(winner).toMatchObject({ version: Number(intent.version) + 1 });
    expect(await call(a, "deck_get", { deck_id: deckId })).toEqual(
      await call(b, "deck_get", { deck_id: deckId }),
    );
    const snapshotId = winner.snapshot_id;
    await Promise.all([kill(first), kill(second)]);
    const restarted = await connect(start());
    const restored = await call(restarted, "deck_restore", {
      deck_id: deckId,
      snapshot_id: snapshotId,
    });
    if (!before.deck || typeof before.deck !== "object") throw new Error("Missing baseline");
    expect((await call(restarted, "deck_get", { deck_id: deckId })).deck).toEqual({
      ...before.deck,
      version: Number(intent.version) + 2,
    });
    const restoredRead = (await call(restarted, "deck_get", { deck_id: deckId })).deck;
    expect(restored).toMatchObject({
      deck: { version: Number(intent.version) + 2 },
    });
    const winningIndex = bodies.findIndex((body) => body?.ok === true);
    expect(
      await call(restarted, "deck_plan_apply", {
        plan: previews[winningIndex]?.plan,
      }),
    ).toMatchObject({ replayed: true, deck: winner.deck });
    // A historical retry must not reapply over the explicit restore.
    expect((await call(restarted, "deck_get", { deck_id: deckId })).deck).toEqual(restoredRead);
  }, 30_000);

  it.each(["new", "existing"])(
    "rolls back %s plan, snapshot and receipt on injected commit failure then retries after restart",
    async (kind) => {
      const writer = start("fixture");
      const client = await connect(writer);
      let deckId: string | undefined;
      let expectedVersion: unknown;
      if (kind === "existing") {
        const seed = await call(client, "deck_plan_preview", {
          input: deckPlanInput(),
        });
        const created = await call(client, "deck_plan_apply", {
          plan: seed.plan,
        });
        deckId = id(created);
        expectedVersion = created.version;
      }
      const before = await call(client, "deck_list");
      const beforeDump = persistedDeckDump();
      const baseline = deckId ? await call(client, "deck_get", { deck_id: deckId }) : undefined;
      const preview = await call(client, "deck_plan_preview", {
        input: deckPlanInput("Retry final state", true),
        ...(deckId ? { deck_id: deckId, expected_version: expectedVersion } : {}),
      });
      writer.child.send({ type: "fail-next-commit" });
      await writer.waitFor("armed");
      expect(
        await client.callTool({
          name: "deck_plan_apply",
          arguments: { plan: preview.plan },
        }),
      ).toMatchObject({
        isError: true,
        structuredContent: { code: "STORAGE_ERROR" },
      });
      expect(await call(client, "deck_list")).toEqual(before);
      expect(persistedDeckDump()).toEqual(beforeDump);
      if (deckId) expect(await call(client, "deck_get", { deck_id: deckId })).toEqual(baseline);
      await kill(writer);
      const restarted = await connect(start("fixture"));
      const applied = await call(restarted, "deck_plan_apply", {
        plan: preview.plan,
      });
      expect(applied).toMatchObject({
        ok: true,
        replayed: false,
        version: kind === "new" ? 1 : 2,
      });
      expect(await call(restarted, "deck_list")).toMatchObject({ total: 1 });
      const retry = await call(restarted, "deck_plan_apply", {
        plan: preview.plan,
      });
      expect(retry).toMatchObject({ replayed: true, deck: applied.deck });
      if (deckId) {
        const restored = await call(restarted, "deck_restore", {
          deck_id: deckId,
          snapshot_id: applied.snapshot_id,
        });
        if (!baseline?.deck || typeof baseline.deck !== "object")
          throw new Error("Missing baseline");
        expect(restored).toMatchObject({ deck: { version: 3 } });
        expect((await call(restarted, "deck_get", { deck_id: deckId })).deck).toEqual({
          ...baseline.deck,
          version: 3,
        });
      }
    },
    30_000,
  );
});

describe("durable user state across real MCP processes", () => {
  it("keeps independent deck and collection writes from two live CLI processes after restart", async () => {
    const first = start();
    const second = start();
    const [alice1, alice2] = await Promise.all([connect(first), connect(second)]);
    const created = await Promise.all([
      call(alice1, "deck_create", { name: "First process" }),
      call(alice2, "deck_create", { name: "Second process" }),
    ]);
    await Promise.all([
      call(alice1, "collection_add", { cards: "Sol Ring" }),
      call(alice2, "collection_add", { cards: "Island" }),
    ]);
    const wantedIds = created.map((deck) => id(deck)).sort();
    for (const client of [alice1, alice2]) {
      expect(await call(client, "deck_list")).toMatchObject({
        total: 2,
        decks: expect.arrayContaining(
          wantedIds.map((deck_id) => expect.objectContaining({ deck_id })),
        ),
      });
      expect(await call(client, "collection_get")).toMatchObject({
        total: 2,
        owned: expect.arrayContaining(["o-sol", "o-island"]),
      });
    }
    await Promise.all([kill(first), kill(second)]);
    const restarted = start();
    const ready = await restarted.waitFor("ready");
    const alice = await connect(restarted, "alice", ready.port);
    const bob = await connect(restarted, "bob", ready.port);
    expect(await call(alice, "deck_list")).toMatchObject({ total: 2 });
    expect(await call(alice, "collection_get")).toMatchObject({ total: 2 });
    expect(await call(bob, "deck_list")).toMatchObject({ total: 0 });
    expect(await call(bob, "collection_get")).toMatchObject({ total: 0 });
    expect(
      await bob.callTool({
        name: "deck_get",
        arguments: { deck_id: wantedIds[0] },
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: { code: "DECK_NOT_FOUND" },
    });
    await expect(bob.readResource({ uri: "collection://alice" })).rejects.toThrow(
      "Unknown collection",
    );
  }, 30_000);

  it("admits exactly one same-version writer across separate CLI servers", async () => {
    const first = start();
    const second = start();
    const [a, b] = await Promise.all([connect(first), connect(second)]);
    const deckId = id(await call(a, "deck_create", { name: "Racing deck" }));
    for (let version = 1; version <= 8; version += 1) {
      const replies = await Promise.all(
        [a, b].map((client, writer) =>
          call(client, "deck_rename", {
            deck_id: deckId,
            expected_version: version,
            name: `Writer ${writer}, version ${version}`,
          }),
        ),
      );
      expect(replies.filter((reply) => reply.ok === true)).toHaveLength(1);
      expect(replies.filter((reply) => reply.conflict === true)).toEqual([
        expect.objectContaining({
          ok: false,
          current_version: version + 1,
          expected_version: version,
        }),
      ]);
      const winner = replies.find((reply) => reply.ok === true);
      for (const client of [a, b]) {
        expect(await call(client, "deck_get", { deck_id: deckId })).toMatchObject({
          deck: { name: winner?.name, version: version + 1 },
        });
      }
    }
  }, 30_000);

  it.each(["deck", "snapshot", "collection", "roles"])(
    "recovers the acknowledged %s mutation when SIGKILL is the very next operation",
    async (lastMutation) => {
      const writer = start("fixture");
      const alice = await connect(writer);
      const deckId = id(
        await call(alice, "deck_import", {
          name: "Durable payload",
          text: "1 Sol Ring\n7 Island",
        }),
      );
      await call(alice, "collection_set", { cards: ["Sol Ring"] });
      writer.child.send({
        type: "set-roles",
        deck_id: deckId,
        session: "alice",
      });
      let saved = (await writer.waitFor("roles-saved")).deck;
      let snapshot = await call(alice, "deck_snapshot", { deck_id: deckId });
      let expectedName = "Durable payload";
      const expectedOwned = ["o-sol"];
      if (lastMutation === "deck") {
        expectedName = "Last acknowledged deck";
        await call(alice, "deck_rename", {
          deck_id: deckId,
          name: expectedName,
        });
      } else if (lastMutation === "snapshot") {
        snapshot = await call(alice, "deck_snapshot", { deck_id: deckId });
      } else if (lastMutation === "collection") {
        expectedOwned.push("o-island");
        await call(alice, "collection_add", { cards: "Island" });
      } else {
        writer.child.send({
          type: "set-roles",
          deck_id: deckId,
          session: "alice",
          revised: true,
        });
        saved = (await writer.waitFor("roles-saved")).deck;
      }
      // No graceful close, store flush, timeout or read between the tool's success
      // acknowledgement and the uncatchable kill.
      await kill(writer);

      const reader = start();
      const ready = await reader.waitFor("ready");
      const restoredAlice = await connect(reader, "alice", ready.port);
      const bob = await connect(reader, "bob", ready.port);
      const persisted = await restoredAlice.readResource({
        uri: `deck://${deckId}`,
      });
      const content = persisted.contents[0];
      const persistedDeck: unknown =
        content && "text" in content ? JSON.parse(content.text) : undefined;
      if (lastMutation === "deck") {
        expect(persistedDeck).toMatchObject({ name: expectedName, version: 4 });
      } else {
        expect(persistedDeck).toEqual(saved);
      }
      expect(await call(restoredAlice, "collection_get")).toMatchObject({
        total: expectedOwned.length,
        owned: expect.arrayContaining(expectedOwned),
      });
      await call(restoredAlice, "deck_remove", {
        deck_id: deckId,
        cards: "Sol Ring",
      });
      const restored = await call(restoredAlice, "deck_restore", {
        deck_id: deckId,
        snapshot_id: id(snapshot, "snapshot_id"),
      });
      expect(restored.deck).toMatchObject({
        cards: [
          { oracle_id: "o-sol", qty: 1 },
          { oracle_id: "o-island", qty: 7 },
        ],
        role_overrides: { "o-sol": ["combo_piece", "payoff"], "o-island": [] },
      });
      expect(
        await bob.callTool({
          name: "deck_restore",
          arguments: {
            deck_id: deckId,
            snapshot_id: id(snapshot, "snapshot_id"),
          },
        }),
      ).toMatchObject({
        isError: true,
        structuredContent: { code: "DECK_NOT_FOUND" },
      });
      expect(await call(bob, "collection_get")).toMatchObject({ total: 0 });
    },
    30_000,
  );

  it.each([
    {
      mode: "set",
      roles: ["combo_piece", "payoff"],
      expected: ["combo_piece", "payoff"],
    },
    { mode: "empty", roles: [], expected: [] },
    { mode: "reset", roles: null, expected: undefined },
  ])(
    "persists public role $mode immediately across SIGKILL and preserves isolation",
    async ({ roles, expected }) => {
      const writer = start();
      const alice = await connect(writer);
      const deckId = id(
        await call(alice, "deck_import", {
          name: "Role durability",
          text: "1 Sol Ring",
        }),
      );
      await call(alice, "deck_set_roles", {
        deck_id: deckId,
        card: "Sol Ring",
        roles: ["wincon"],
      });
      const snapshot = await call(alice, "deck_snapshot", { deck_id: deckId });
      const acknowledged = await call(alice, "deck_set_roles", {
        deck_id: deckId,
        card: "Sol Ring",
        roles,
      });
      await kill(writer);

      const reader = start();
      const ready = await reader.waitFor("ready");
      const restored = await connect(reader, "alice", ready.port);
      const bob = await connect(reader, "bob", ready.port);
      const saved = await call(restored, "deck_get", { deck_id: deckId });
      expect(saved).toMatchObject({ deck: { version: acknowledged.version } });
      const deck = saved.deck;
      if (!deck || typeof deck !== "object" || Array.isArray(deck))
        throw new Error("Missing persisted deck");
      const overrides = "role_overrides" in deck ? deck.role_overrides : undefined;
      const composition = await call(restored, "analyze_composition", {
        deck_id: deckId,
      });
      if (expected === undefined) {
        expect(overrides ?? {}).not.toHaveProperty("o-sol");
        expect(composition.by_role).toEqual({ ramp: 1, mana_rock: 1 });
      } else {
        expect(overrides).toEqual({ "o-sol": expected });
        expect(composition.by_role).toEqual(Object.fromEntries(expected.map((role) => [role, 1])));
      }
      expect(
        await bob.callTool({
          name: "deck_set_roles",
          arguments: { deck_id: deckId, card: "Sol Ring", roles: [] },
        }),
      ).toMatchObject({
        isError: true,
        structuredContent: { code: "DECK_NOT_FOUND" },
      });
      expect(await call(restored, "deck_get", { deck_id: deckId })).toEqual(saved);
      expect(
        await call(restored, "deck_restore", {
          deck_id: deckId,
          snapshot_id: id(snapshot, "snapshot_id"),
        }),
      ).toMatchObject({ deck: { role_overrides: { "o-sol": ["wincon"] } } });
    },
    30_000,
  );

  it("admits one public role correction at a version across two CLI processes", async () => {
    const first = start();
    const second = start();
    const [a, b] = await Promise.all([connect(first), connect(second)]);
    const deckId = id(await call(a, "deck_import", { name: "Role race", text: "1 Sol Ring" }));
    const before = await call(a, "deck_get", { deck_id: deckId });
    const deck = before.deck;
    if (
      !deck ||
      typeof deck !== "object" ||
      !("version" in deck) ||
      typeof deck.version !== "number"
    )
      throw new Error("Missing version");
    const expectedVersion = deck.version;
    const replies = await Promise.all(
      [a, b].map((client, n) =>
        call(client, "deck_set_roles", {
          deck_id: deckId,
          card: "Sol Ring",
          roles: n === 0 ? [] : ["payoff"],
          expected_version: expectedVersion,
        }),
      ),
    );
    expect(replies.filter((reply) => reply.ok === true)).toHaveLength(1);
    expect(replies.filter((reply) => reply.conflict === true)).toEqual([
      expect.objectContaining({
        current_version: expectedVersion + 1,
        expected_version: expectedVersion,
      }),
    ]);
    expect(await call(a, "deck_get", { deck_id: deckId })).toEqual(
      await call(b, "deck_get", { deck_id: deckId }),
    );
  }, 30_000);

  it("rolls back a failed public role correction and permits retry after restart", async () => {
    const writer = start("fixture");
    const client = await connect(writer);
    const deckId = id(
      await call(client, "deck_import", {
        name: "Role rollback",
        text: "1 Sol Ring",
      }),
    );
    const before = await call(client, "deck_get", { deck_id: deckId });
    writer.child.send({ type: "fail-next-commit" });
    await writer.waitFor("armed");
    expect(
      await client.callTool({
        name: "deck_set_roles",
        arguments: { deck_id: deckId, card: "Sol Ring", roles: ["payoff"] },
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: { code: "STORAGE_ERROR" },
    });
    expect(await call(client, "deck_get", { deck_id: deckId })).toEqual(before);
    await kill(writer);
    const restarted = await connect(start());
    expect(await call(restarted, "deck_get", { deck_id: deckId })).toEqual(before);
    expect(
      await call(restarted, "deck_set_roles", {
        deck_id: deckId,
        card: "Sol Ring",
        roles: ["payoff"],
      }),
    ).toMatchObject({ ok: true });
  }, 30_000);

  it.each(["set", "patch", "clear"])(
    "persists acknowledged intent %s through immediate SIGKILL and keeps principal isolation",
    async (action) => {
      const writer = start();
      const alice = await connect(writer);
      const deckId = id(await call(alice, "deck_create", { name: "Intent durability" }));
      const baseline = await call(alice, "deck_set_intent", {
        deck_id: deckId,
        expected_version: 1,
        action: "set",
        intent: {
          schema_version: 1,
          playgroup: {
            profile: "casual",
            bracket: 2,
            limits: { fast_mana: 0 },
          },
          soft: { goals: ["Baseline"], spend_target_usd: 25 },
        },
      });
      const snapshot = await call(alice, "deck_snapshot", { deck_id: deckId });
      const payload =
        action === "set"
          ? {
              intent: {
                schema_version: 1,
                hard: { locked_cards: [{ oracle_id: "Sol Ring", qty: 1 }] },
                playgroup: { profile: "competitive", bracket: 5 },
              },
            }
          : action === "patch"
            ? {
                patch: {
                  playgroup: {
                    bracket: 3,
                    limits: { fast_mana: null, tutors: 1 },
                  },
                  soft: { goals: ["Revised"], spend_target_usd: null },
                },
              }
            : {};
      const acknowledged = await call(alice, "deck_set_intent", {
        deck_id: deckId,
        expected_version: baseline.version,
        action,
        ...payload,
      });
      // Mutation acknowledgement is immediately followed by an uncatchable kill.
      await kill(writer);

      const reader = start();
      const ready = await reader.waitFor("ready");
      const restored = await connect(reader, "alice", ready.port);
      const bob = await connect(reader, "bob", ready.port);
      const persisted = await call(restored, "deck_get_intent", {
        deck_id: deckId,
      });
      expect(persisted).toMatchObject({
        intent: acknowledged.intent,
        version: acknowledged.version,
        effective: acknowledged.effective,
      });
      for (const name of ["deck_get_intent", "deck_set_intent"]) {
        expect(
          await bob.callTool({
            name,
            arguments: {
              deck_id: deckId,
              expected_version: acknowledged.version,
              ...(name === "deck_set_intent" ? { action: "clear" } : {}),
            },
          }),
        ).toMatchObject({
          isError: true,
          structuredContent: { code: "DECK_NOT_FOUND" },
        });
      }
      expect(await call(restored, "deck_get_intent", { deck_id: deckId })).toEqual(persisted);
      expect(
        await call(restored, "deck_restore", {
          deck_id: deckId,
          snapshot_id: id(snapshot, "snapshot_id"),
        }),
      ).toMatchObject({ deck: { intent: baseline.intent } });
    },
    30_000,
  );

  it("admits exactly one same-version intent patch across live CLI processes", async () => {
    const first = start();
    const second = start();
    const [a, b] = await Promise.all([connect(first), connect(second)]);
    const deckId = id(await call(a, "deck_create", { name: "Intent race" }));
    await call(a, "deck_set_intent", {
      deck_id: deckId,
      expected_version: 1,
      action: "set",
      intent: {
        schema_version: 1,
        playgroup: { profile: "thematic" },
        soft: { strategy: "Artifacts" },
      },
    });
    const replies = await Promise.all(
      [a, b].map((connected, writer) =>
        call(connected, "deck_set_intent", {
          deck_id: deckId,
          expected_version: 2,
          action: "patch",
          patch: {
            playgroup: { limits: { tutors: writer } },
            soft: { goals: [`Writer ${writer}`] },
          },
        }),
      ),
    );
    expect(replies.filter((reply) => reply.ok === true)).toHaveLength(1);
    expect(replies.filter((reply) => reply.conflict === true)).toEqual([
      expect.objectContaining({ current_version: 3, expected_version: 2 }),
    ]);
    const winner = replies.find((reply) => reply.ok === true);
    for (const connected of [a, b]) {
      expect(await call(connected, "deck_get_intent", { deck_id: deckId })).toMatchObject({
        version: 3,
        intent: winner?.intent,
      });
    }
    await Promise.all([kill(first), kill(second)]);
    expect(
      await call(await connect(start()), "deck_get_intent", {
        deck_id: deckId,
      }),
    ).toMatchObject({
      version: 3,
      intent: winner?.intent,
    });
  }, 30_000);

  it("rolls back a failed intent commit and permits the same version to retry after restart", async () => {
    const writer = start("fixture");
    const connected = await connect(writer);
    const deckId = id(await call(connected, "deck_create", { name: "Intent rollback" }));
    const before = await call(connected, "deck_get_intent", {
      deck_id: deckId,
    });
    const mutation = {
      deck_id: deckId,
      expected_version: 1,
      action: "set",
      intent: {
        schema_version: 1,
        playgroup: { bracket: 3, limits: { tutors: 0 } },
        soft: { goals: ["Durable intent"] },
      },
    };
    writer.child.send({ type: "fail-next-commit" });
    await writer.waitFor("armed");
    expect(
      await connected.callTool({
        name: "deck_set_intent",
        arguments: mutation,
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: { code: "STORAGE_ERROR" },
    });
    expect(await call(connected, "deck_get_intent", { deck_id: deckId })).toEqual(before);
    await kill(writer);
    const restarted = await connect(start());
    expect(await call(restarted, "deck_get_intent", { deck_id: deckId })).toEqual(before);
    expect(await call(restarted, "deck_set_intent", mutation)).toMatchObject({
      ok: true,
      version: 2,
      intent: mutation.intent,
    });
  }, 30_000);

  it("returns STORAGE_ERROR over MCP and preserves the previous durable state on a failed commit", async () => {
    const writer = start("fixture");
    const client = await connect(writer);
    const deckId = id(await call(client, "deck_create", { name: "Before failure" }));
    await call(client, "collection_set", { cards: "Sol Ring" });
    for (const [name, args] of [
      ["deck_rename", { deck_id: deckId, name: "Must roll back", expected_version: 1 }],
      ["collection_add", { cards: "Island" }],
    ] satisfies Array<[string, Record<string, unknown>]>) {
      writer.child.send({ type: "fail-next-commit" });
      await writer.waitFor("armed");
      const failed = await client.callTool({ name, arguments: args });
      expect(failed).toMatchObject({
        isError: true,
        structuredContent: { code: "STORAGE_ERROR" },
      });
      expect(JSON.stringify(failed.content)).toContain("STORAGE_ERROR");
    }
    await kill(writer);
    const reader = await connect(start());
    expect(await call(reader, "deck_get", { deck_id: deckId })).toMatchObject({
      deck: { name: "Before failure", version: 1 },
    });
    expect(await call(reader, "collection_get")).toMatchObject({
      owned: ["o-sol"],
      total: 1,
    });
    expect(
      await call(reader, "deck_rename", {
        deck_id: deckId,
        name: "Retry",
        expected_version: 1,
      }),
    ).toMatchObject({ ok: true, version: 2 });
  }, 30_000);
});
