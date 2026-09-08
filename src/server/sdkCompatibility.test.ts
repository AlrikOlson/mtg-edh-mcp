import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { DeckStore } from "../deck/index.js";
import { PRINCIPAL_HEADER, startHttp } from "./http.js";
import { staticSnapshotProvider } from "./snapshot.js";

const SNAPSHOT = "2026-09-08";
const ORACLE = [
  {
    oracle_id: "o-sol",
    id: "p-sol",
    name: "Sol Ring",
    cmc: 1,
    colors: [],
    color_identity: [],
    type_line: "Artifact",
    oracle_text: "{T}: Add {C}{C}.",
    legalities: { commander: "legal" },
    prices: { usd: "1.50" },
  },
];
let root: string;
let index: CardIndex;
let fixtureDir: string;
let dbPath: string;

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "mtg-sdk-stdio-"));
  const require = createRequire(import.meta.url);
  await build({
    stdin: {
      contents: `
        import { startStdio } from "./stdio.js";
        import { CardIndex } from "../index/index.js";
        import { DeckStore } from "../deck/index.js";
        import { staticSnapshotProvider } from "./snapshot.js";
        await startStdio({
          index: CardIndex.open(process.argv[2]),
          deckStore: new DeckStore(),
          snapshot: staticSnapshotProvider(${JSON.stringify(SNAPSHOT)}),
        });
      `,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      sourcefile: "compatibility-stdio.ts",
      loader: "ts",
    },
    outfile: path.join(fixtureDir, "main.mjs"),
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

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-sdk-compatibility-"));
  const store = new VersionedStore(root);
  await store.createVersion(SNAPSHOT);
  await writeFile(store.filePath(SNAPSHOT, "oracle_cards.json"), JSON.stringify(ORACLE));
  await writeFile(store.filePath(SNAPSHOT, "default_cards.json"), "[]");
  await store.publish(SNAPSHOT);
  dbPath = (await buildIndex({ store })).dbPath;
  index = CardIndex.open(dbPath);
});

afterEach(async () => {
  index.close();
  await rm(root, { recursive: true, force: true });
});

const revisions = ["2026-07-28", "2024-11-05"] as const;
function compatibilityClient(revision: (typeof revisions)[number]): Client {
  return new Client(
    { name: "compatibility-test", version: "1.0.0" },
    {
      supportedProtocolVersions: [revision],
      versionNegotiation: { mode: revision === "2026-07-28" ? { pin: revision } : "legacy" },
    },
  );
}

function stdioTransport(): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [path.join(fixtureDir, "main.mjs"), dbPath],
    stderr: "pipe",
  });
}

async function verifyCatalogAndResults(client: Client): Promise<void> {
  const { tools } = await client.listTools();
  expect(tools).toHaveLength(41);
  expect(tools.every((tool) => tool.outputSchema === undefined)).toBe(true);
  expect((await client.listPrompts()).prompts).toHaveLength(3);
  expect(
    (await client.getPrompt({ name: "tune_deck", arguments: { deck_id: "sample" } })).messages[0]
      ?.content,
  ).toMatchObject({ type: "text", text: expect.stringContaining("sample") });
  expect((await client.readResource({ uri: "card://o-sol" })).contents[0]).toMatchObject({
    text: expect.stringContaining("Sol Ring"),
  });
  for (const request of [
    { name: "ping", arguments: { message: "compatible" } },
    { name: "deck_get", arguments: { deck_id: "missing" } },
  ]) {
    const result = await client.callTool(request);
    expect(result.isError === true).toBe(request.name === "deck_get");
    expect(result.structuredContent).toMatchObject({ data_snapshot: SNAPSHOT });
    expect(result._meta).toMatchObject({ data_snapshot: SNAPSHOT });
    expect(result.content).toContainEqual({
      type: "text",
      text: JSON.stringify(result.structuredContent),
    });
  }
}

describe("SDK v2 protocol compatibility", () => {
  it.each(revisions)(
    "serves the full catalog and stamped results over HTTP %s",
    async (revision) => {
      const running = await startHttp({
        index,
        deckStore: new DeckStore(),
        snapshot: staticSnapshotProvider(SNAPSHOT),
      });
      const client = compatibilityClient(revision);
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)),
        );
        expect(client.getProtocolEra()).toBe(revision === "2026-07-28" ? "modern" : "legacy");
        expect(client.getServerCapabilities()).toMatchObject({
          tools: { listChanged: false },
          prompts: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
        });
        await verifyCatalogAndResults(client);
        if (revision === "2026-07-28") {
          await expect(client.listen({ toolsListChanged: true })).rejects.toThrow(
            "persistent stdio",
          );
        }
      } finally {
        await client.close();
        await running.close();
      }
    },
  );

  it.each(revisions)(
    "serves the full catalog and stamped results over stdio %s",
    async (revision) => {
      const client = compatibilityClient(revision);
      const transport = stdioTransport();
      try {
        await client.connect(transport);
        expect(client.getProtocolEra()).toBe(revision === "2026-07-28" ? "modern" : "legacy");
        await verifyCatalogAndResults(client);
      } finally {
        await client.close();
      }
    },
  );

  it("delivers modern stdio deck updates only while the resource listen stream is open", async () => {
    const client = compatibilityClient("2026-07-28");
    try {
      await client.connect(stdioTransport());
      const created = await client.callTool({
        name: "deck_create",
        arguments: { name: "Subscriptions" },
      });
      const deckId = z.object({ deck_id: z.string() }).parse(created.structuredContent).deck_id;
      const uri = `deck://${deckId}`;
      const updates: string[] = [];
      client.setNotificationHandler("notifications/resources/updated", (notification) => {
        updates.push(notification.params.uri);
      });
      const subscription = await client.listen({ resourceSubscriptions: [uri] });
      expect(subscription.honoredFilter).toEqual({ resourceSubscriptions: [uri] });
      await client.callTool({
        name: "deck_add",
        arguments: { deck_id: deckId, cards: "Sol Ring" },
      });
      await vi.waitFor(() => expect(updates).toEqual([uri]));
      await subscription.close();
      expect(await subscription.closed).toBe("local");
      await client.callTool({
        name: "deck_remove",
        arguments: { deck_id: deckId, cards: "Sol Ring" },
      });
      await client.callTool({ name: "ping", arguments: {} });
      expect(updates).toEqual([uri]);
    } finally {
      await client.close();
    }
  });

  it("isolates interleaved modern HTTP principals and allows its browser protocol headers", async () => {
    const running = await startHttp({ index, deckStore: new DeckStore() });
    const url = new URL(`http://127.0.0.1:${running.port}/mcp`);
    const clients = [compatibilityClient("2026-07-28"), compatibilityClient("2026-07-28")];
    try {
      const preflight = await fetch(url, {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:5173" },
      });
      expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain(
        "mcp-method, mcp-name",
      );
      await Promise.all(
        clients.map((client, i) =>
          client.connect(
            new StreamableHTTPClientTransport(url, {
              requestInit: { headers: { [PRINCIPAL_HEADER]: `principal-${i}` } },
            }),
          ),
        ),
      );
      const created = await Promise.all(
        clients.map((client, i) =>
          client.callTool({
            name: "deck_create",
            arguments: { name: `Deck ${i}` },
          }),
        ),
      );
      const lists = await Promise.all(
        clients.map((client) => client.callTool({ name: "deck_list", arguments: {} })),
      );
      const createdIds = created.map(
        (result) => z.object({ deck_id: z.string() }).parse(result.structuredContent).deck_id,
      );
      for (const [i, result] of lists.entries()) {
        expect(result.structuredContent).toMatchObject({ decks: [{ name: `Deck ${i}` }] });
        expect(JSON.stringify(result.structuredContent)).not.toContain(createdIds[1 - i]);
      }
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await running.close();
    }
  });
});
