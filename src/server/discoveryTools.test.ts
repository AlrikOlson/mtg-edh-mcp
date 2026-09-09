import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { discoveryFixture, rawCard } from "../analyze/discovery.fixture.js";
import { DeckStore } from "../deck/index.js";
import { CacheStore, EdhrecClient, SpellbookClient, GameChangersClient } from "../meta/index.js";
import { startHttp } from "./http.js";
import { staticSnapshotProvider } from "./snapshot.js";
const body = z
  .object({
    data_snapshot: z.string(),
    discovery_version: z.string(),
    deck_version: z.number().nullable(),
    results: z.array(z.object({ cards: z.array(z.object({ name: z.string() })) }).passthrough()),
    interpretation: z.object({ status: z.string() }).passthrough(),
  })
  .passthrough();
describe.each(["2026-07-28", "2024-11-05"] as const)(
  "card_discover on real HTTP MCP %s",
  (revision) => {
    let fixture: Awaited<ReturnType<typeof discoveryFixture>>;
    let running: Awaited<ReturnType<typeof startHttp>>;
    let client: Client;
    let deckStore: DeckStore;
    const fetcher = vi.fn(async () => {
      throw new Error("All recommendation providers disabled");
    });
    beforeEach(async () => {
      fetcher.mockClear();
      fixture = await discoveryFixture([
        rawCard("Chief", "Whenever you discard a card, draw a card.", {
          type_line: "Legendary Creature — Human",
          color_identity: ["U"],
        }),
        rawCard("Draw", "Draw two cards.", { color_identity: ["U"] }),
        rawCard("Red", "Draw a card.", { color_identity: ["R"] }),
      ]);
      deckStore = new DeckStore({ newId: () => "d" });
      deckStore.create({
        name: "d",
        commanders: ["Chief"],
        computedColorIdentity: ["U"],
      });
      running = await startHttp({
        index: fixture.index,
        deckStore,
        snapshot: staticSnapshotProvider("2026-09-08"),
        edhrec: new EdhrecClient(new CacheStore(), { fetchJson: fetcher }),
        spellbook: new SpellbookClient(new CacheStore(), {
          fetchJson: fetcher,
        }),
        gameChangers: new GameChangersClient(new CacheStore(), {
          fetchJson: fetcher,
        }),
      });
      client = new Client(
        { name: "discovery-test", version: "1" },
        {
          supportedProtocolVersions: [revision],
          versionNegotiation: {
            mode: revision === "2026-07-28" ? { pin: revision } : "legacy",
          },
        },
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + running.port + "/mcp")),
      );
    });
    afterEach(async () => {
      await client.close();
      await running.close();
      await fixture.close();
    });
    it("advertises a read-only tool and gives equivalent structured and JSON text evidence offline", async () => {
      const catalog = await client.listTools();
      const tool = catalog.tools.find((t) => t.name === "card_discover");
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false,
      });
      expect(tool?.outputSchema).toBeUndefined();
      const before = structuredClone(deckStore.get("d"));
      if (!before) throw new Error("fixture deck missing");
      const result = await client.callTool({
        name: "card_discover",
        arguments: { deck_id: "d", theme: "draw" },
      });
      expect(result.isError).not.toBe(true);
      const parsed = body.parse(result.structuredContent);
      expect(parsed.results.map((r) => r.cards[0]?.name)).toEqual(["Draw"]);
      expect(parsed.data_snapshot).toBe("2026-09-08");
      expect(parsed.deck_version).toBe(before.version);
      expect(result.content).toContainEqual({
        type: "text",
        text: JSON.stringify(result.structuredContent),
      });
      expect(deckStore.get("d")).toEqual(before);
      expect(fetcher).not.toHaveBeenCalled();
    });
    it("resolves names, rejects unknown inputs and respects updated deck versions", async () => {
      const selected = await client.callTool({
        name: "card_discover",
        arguments: { commanders: ["Chief"], theme: "draw" },
      });
      expect(body.parse(selected.structuredContent).results.map((r) => r.cards[0]?.name)).toEqual([
        "Draw",
      ]);
      const missing = await client.callTool({
        name: "card_discover",
        arguments: { commanders: ["Missing"], theme: "draw" },
      });
      expect(missing.isError).toBe(true);
      const missingDeck = await client.callTool({
        name: "card_discover",
        arguments: { deck_id: "missing", theme: "draw" },
      });
      expect(missingDeck.isError).toBe(true);
      expect(missingDeck.structuredContent).toMatchObject({
        code: "DECK_NOT_FOUND",
      });
      const invalid = await client.callTool({
        name: "card_discover",
        arguments: { mechanics: ["fake.pattern"] },
      });
      expect(invalid.isError).toBe(true);
      const saved = deckStore.get("d");
      if (!saved) throw new Error("fixture deck missing");
      deckStore.update("d", (d) => ({
        ...d,
        intent: { schema_version: 1, hard: { excluded_cards: ["Draw"] } },
      }));
      const changed = await client.callTool({
        name: "card_discover",
        arguments: { deck_id: "d", theme: "draw" },
      });
      const parsed = body.parse(changed.structuredContent);
      expect(parsed.deck_version).toBeGreaterThan(saved.version);
      expect(parsed.results).toEqual([]);
      expect(fetcher).not.toHaveBeenCalled();
    });
  },
);
