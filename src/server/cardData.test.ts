import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { BulkClient, VersionedStore } from "../ingest/index.js";
import { refreshSnapshot } from "../index/refresh.js";
import { DeckStore } from "../deck/index.js";
import { openCardData } from "./cardData.js";
import { createServer } from "./createServer.js";
import { startHttp } from "./http.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

let root: string;
let day: string;
let name: string;
let store: VersionedStore;
function client(): BulkClient {
  return new BulkClient({
    now: () => 0,
    sleep: async () => {},
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/bulk-data"))
        return Response.json({
          data: ["oracle_cards", "default_cards"].map((type) => ({
            type,
            updated_at: `${day}T00:00:00Z`,
            download_uri: `https://fixture/${type}`,
          })),
        });
      if (!url.startsWith("https://fixture/")) throw new Error(`Unexpected network: ${url}`);
      return Response.json([
        {
          oracle_id: "oracle",
          id: "printing",
          name,
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
      ]);
    },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mtg-runtime-refresh-"));
  store = new VersionedStore(root);
  day = "2026-09-01";
  name = "Old Card";
  await refreshSnapshot({ store, client: client() });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("served card-data activation", () => {
  it("keeps asynchronous MCP calls on one generation while activation waits", async () => {
    const data = await openCardData(store, client);
    if (!data.index) throw new Error("Expected seeded index");
    const index = data.index;
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish = () => {};
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const server = createServer({
      index,
      snapshot: data.snapshot.provider,
      ingest: data.ingest,
      tools: [
        {
          name: "slow_read",
          config: { inputSchema: {} },
          handler: async () => {
            const before = index.getCard("oracle")?.name;
            entered();
            await ready;
            return {
              content: [],
              structuredContent: {
                before,
                after: index.getCard("oracle")?.name,
              },
            };
          },
        },
      ],
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const mcp = new Client({ name: "refresh-concurrency", version: "1" });
    await mcp.connect(ct);
    const pause = vi.spyOn(data.snapshot, "pause");
    try {
      const oldCall = mcp.callTool({ name: "slow_read", arguments: {} });
      await started;
      day = "2026-09-02";
      name = "New Card";
      data.ingest.start(false);
      await vi.waitFor(() => expect(pause).toHaveBeenCalledOnce());
      expect(data.ingest.status().phase).toBe("build");
      expect(data.snapshot.get()).toBe("2026-09-01");
      const nextCall = mcp.callTool({
        name: "card_get",
        arguments: { cards: "oracle" },
      });
      finish();
      expect((await oldCall).structuredContent).toMatchObject({
        before: "Old Card",
        after: "Old Card",
        data_snapshot: "2026-09-01",
      });
      expect((await nextCall).structuredContent).toMatchObject({
        cards: [{ name: "New Card" }],
        data_snapshot: "2026-09-02",
      });
      await vi.waitFor(() => expect(data.ingest.status().phase).toBe("done"));
    } finally {
      finish();
      pause.mockRestore();
      await mcp.close();
      await server.close();
      index.close();
    }
  });

  it.each(["memory", "http", "modern-http"] as const)(
    "keeps the connected %s MCP index and snapshot together and reports done after activation",
    async (transport) => {
      const data = await openCardData(store, client);
      const server = createServer({
        index: data.index,
        snapshot: data.snapshot.provider,
        ingest: data.ingest,
      });
      const mcp = new Client(
        { name: "refresh-test", version: "1" },
        {
          versionNegotiation: {
            mode: transport === "modern-http" ? { pin: "2026-07-28" } : "legacy",
          },
        },
      );
      let http: Awaited<ReturnType<typeof startHttp>> | undefined;
      if (transport !== "memory") {
        http = await startHttp({
          port: 0,
          index: data.index,
          snapshot: data.snapshot.provider,
          ingest: data.ingest,
        });
        await mcp.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`)),
        );
      } else {
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await server.connect(st);
        await mcp.connect(ct);
      }
      const get = () => mcp.callTool({ name: "card_get", arguments: { cards: "oracle" } });
      try {
        expect((await get()).structuredContent).toMatchObject({
          cards: [{ name: "Old Card" }],
          data_snapshot: "2026-09-01",
        });
        day = "2026-09-02";
        name = "New Card";
        await mcp.callTool({ name: "data_ingest", arguments: {} });
        await vi.waitFor(() => expect(data.ingest.status().phase).toBe("done"));
        expect((await get()).structuredContent).toMatchObject({
          cards: [{ name: "New Card" }],
          data_snapshot: "2026-09-02",
        });
        expect(
          (await mcp.callTool({ name: "data_status", arguments: {} })).structuredContent,
        ).toMatchObject({
          ingest: { phase: "done", snapshot: "2026-09-02" },
          data_snapshot: "2026-09-02",
        });
      } finally {
        await mcp.close();
        await server.close();
        await http?.close();
        data.index?.close();
      }
    },
  );

  it("reports activation preparation failure without changing pointer, served data or stamp, then retries", async () => {
    const data = await openCardData(store, client);
    if (!data.index) throw new Error("Expected seeded index");
    const pointer = await readFile(store.pointerPath, "utf8");
    const prepare = vi.spyOn(data.index, "prepareReopen").mockImplementationOnce(() => {
      throw new Error("prepare denied");
    });
    try {
      day = "2026-09-02";
      name = "New Card";
      data.ingest.start(false);
      await vi.waitFor(() => expect(data.ingest.status().phase).toBe("error"));
      expect(data.ingest.status().error).toContain("prepare denied");
      expect(await readFile(store.pointerPath, "utf8")).toBe(pointer);
      expect(data.index.getCard("oracle")?.name).toBe("Old Card");
      expect(data.snapshot.get()).toBe("2026-09-01");
      expect(await data.snapshot.provider.withRead(async () => data.index?.count())).toBe(1);
      data.ingest.start(false);
      await vi.waitFor(() => expect(data.ingest.status().phase).toBe("done"));
      expect(data.index.getCard("oracle")?.name).toBe("New Card");
      expect(data.snapshot.get()).toBe("2026-09-02");
    } finally {
      prepare.mockRestore();
      data.index.close();
    }
  });

  it("reports freshness for the served version when a different process publishes", async () => {
    const data = await openCardData(store, client);
    try {
      const previous = await data.staleness();
      day = "2026-09-02";
      name = "New Card";
      await refreshSnapshot({ store, client: client() });
      expect(data.snapshot.get()).toBe("2026-09-01");
      expect(await data.staleness()).toEqual(previous);
      data.ingest.start(false);
      await vi.waitFor(() => expect(data.ingest.status().phase).toBe("done"));
      expect(data.ingest.status().skipped).toBe(true);
      expect(data.index?.getCard("oracle")?.name).toBe("New Card");
      expect(data.snapshot.get()).toBe("2026-09-02");
    } finally {
      data.index?.close();
    }
  });
});

describe("first card-data activation", () => {
  it.each(["memory", "http", "modern-http"] as const)(
    "activates indexed tools, resources, prompts and existing deck handlers on connected %s",
    async (transport) => {
      const data = await openCardData(new VersionedStore(join(root, "empty")), client);
      const deckStore = new DeckStore();
      const options = {
        cardData: data,
        snapshot: data.snapshot.provider,
        ingest: data.ingest,
        staleness: data.staleness,
        deckStore,
      };
      const server = createServer(options);
      const mcp = new Client(
        { name: "first-ingest", version: "1" },
        {
          versionNegotiation: {
            mode: transport === "modern-http" ? { pin: "2026-07-28" } : "legacy",
          },
        },
      );
      const changed = vi.fn();
      mcp.setNotificationHandler("notifications/tools/list_changed", changed);
      let http: Awaited<ReturnType<typeof startHttp>> | undefined;
      if (transport !== "memory") {
        http = await startHttp({ ...options, port: 0 });
        await mcp.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`)),
        );
      } else {
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await server.connect(st);
        await mcp.connect(ct);
      }
      try {
        expect((await mcp.listTools()).tools.map((tool) => tool.name)).not.toContain("card_get");
        expect(
          (await mcp.callTool({ name: "data_status", arguments: {} })).structuredContent,
        ).toMatchObject({ has_index: false, data_snapshot: "0000-00-00" });
        expect(mcp.getServerCapabilities()).toMatchObject({
          tools: { listChanged: transport === "memory" },
          resources: { listChanged: transport === "memory" },
          prompts: { listChanged: transport === "memory" },
        });
        expect((await mcp.listPrompts()).prompts).toEqual([]);
        const created = await mcp.callTool({
          name: "deck_create",
          arguments: { name: "Before setup" },
        });
        const deckId = (created.structuredContent as { deck_id: string }).deck_id;
        await mcp.callTool({ name: "data_ingest", arguments: {} });
        await vi.waitFor(() => expect(data.ingest.status().phase).toBe("done"));
        expect(data.index?.getCard("oracle")?.name).toBe("Old Card");
        const names = (await mcp.listTools()).tools.map((tool) => tool.name);
        expect(names).toContain("card_get");
        expect(names).toContain("validate_deck");
        expect(names).toContain("construction_spec");
        expect(
          (await mcp.callTool({ name: "construction_spec", arguments: {} })).structuredContent,
        ).toMatchObject({
          status: "needs_choices",
          data_snapshot: day,
          specification: {
            command_zone: null,
            budget: { mode: "unspecified" },
          },
        });
        expect(new Set(names).size).toBe(names.length);
        expect(
          (await mcp.callTool({ name: "data_status", arguments: {} })).structuredContent,
        ).toMatchObject({
          has_index: true,
          ingest: { phase: "done" },
          data_snapshot: day,
        });
        expect(
          (
            await mcp.callTool({
              name: "card_get",
              arguments: { cards: "Old Card" },
            })
          ).structuredContent,
        ).toMatchObject({ cards: [{ name: "Old Card" }], data_snapshot: day });
        const added = await mcp.callTool({
          name: "deck_add",
          arguments: { deck_id: deckId, cards: "Old Card" },
        });
        expect(added.structuredContent).toMatchObject({
          failed: [],
          verdicts: [{ oracle_id: "oracle", status: "ok" }],
        });
        const card = await mcp.readResource({ uri: "card://oracle" });
        const resource = card.contents[0];
        if (!resource || !("text" in resource)) throw new Error("Expected text card resource");
        expect(JSON.parse(resource.text)).toMatchObject({ name: "Old Card" });
        expect((await mcp.listPrompts()).prompts.length).toBeGreaterThan(0);
        if (transport === "memory") expect(changed).toHaveBeenCalled();
      } finally {
        await mcp.close();
        await server.close();
        await http?.close();
        data.index?.close();
      }
    },
  );

  it("includes a server created while first publication is awaiting I/O", async () => {
    const emptyStore = new VersionedStore(join(root, "late-connection"));
    const data = await openCardData(emptyStore, client);
    let entered = () => {};
    const publishing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish = () => {};
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const publish = emptyStore.publish.bind(emptyStore);
    vi.spyOn(emptyStore, "publish").mockImplementation(async (...args) => {
      entered();
      await ready;
      await publish(...args);
    });
    data.ingest.start(false);
    await publishing;
    const server = createServer({
      cardData: data,
      snapshot: data.snapshot.provider,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const mcp = new Client({ name: "late-connection", version: "1" });
    await mcp.connect(ct);
    try {
      finish();
      await vi.waitFor(() => expect(data.ingest.status().phase).toBe("done"));
      expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain("card_get");
      expect(
        (
          await mcp.callTool({
            name: "card_get",
            arguments: { cards: "Old Card" },
          })
        ).structuredContent,
      ).toMatchObject({ cards: [{ name: "Old Card" }], data_snapshot: day });
    } finally {
      finish();
      await mcp.close();
      await server.close();
      data.index?.close();
    }
  });

  it("rolls back partial catalog preparation, keeps the install cold, and retries", async () => {
    const emptyStore = new VersionedStore(join(root, "registration-failure"));
    const data = await openCardData(emptyStore, client);
    const server = createServer({
      cardData: data,
      snapshot: data.snapshot.provider,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const mcp = new Client({ name: "retry-registration", version: "1" });
    await mcp.connect(ct);
    const register = server.registerTool.bind(server);
    const failure = vi.spyOn(server, "registerTool").mockImplementation((...args) => {
      if (args[0] === "card_get") throw new Error("registration denied");
      return register(args[0], args[1], args[2]);
    });
    try {
      data.ingest.start(false);
      await vi.waitFor(() => expect(data.ingest.status().phase).toBe("error"));
      expect(data.ingest.status().error).toContain("registration denied");
      expect(data.index).toBeUndefined();
      expect(data.snapshot.get()).toBe("0000-00-00");
      expect(await emptyStore.readPointer()).toBeNull();
      expect((await mcp.listTools()).tools.map((tool) => tool.name)).not.toContain("card_search");
      failure.mockRestore();
      data.ingest.start(false);
      await vi.waitFor(() => expect(data.ingest.status().phase).toBe("done"));
      expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain("card_search");
    } finally {
      failure.mockRestore();
      await mcp.close();
      await server.close();
      data.index?.close();
    }
  });

  it("unsubscribes a cold server when its transport closes", async () => {
    const unsubscribe = vi.fn();
    const onReady = vi.fn(() => unsubscribe);
    const server = createServer({ cardData: { index: undefined, onReady } });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const mcp = new Client({ name: "closing", version: "1" });
    await mcp.connect(ct);
    await mcp.close();
    expect(onReady).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    await server.close();
  });
});
