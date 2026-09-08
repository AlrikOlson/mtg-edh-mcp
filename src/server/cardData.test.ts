import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BulkClient, VersionedStore } from "../ingest/index.js";
import { refreshSnapshot } from "../index/refresh.js";
import { openCardData } from "./cardData.js";
import { createServer } from "./createServer.js";
import { startHttp } from "./http.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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

  it.each(["memory", "http"] as const)(
    "keeps the connected %s MCP index and snapshot together and reports done after activation",
    async (transport) => {
      const data = await openCardData(store, client);
      const server = createServer({
        index: data.index,
        snapshot: data.snapshot.provider,
        ingest: data.ingest,
      });
      const mcp = new Client({ name: "refresh-test", version: "1" });
      let http: Awaited<ReturnType<typeof startHttp>> | undefined;
      if (transport === "http") {
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
