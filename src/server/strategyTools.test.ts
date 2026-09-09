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
    deck_id: z.string(),
    deck_version: z.number(),
    data_snapshot: z.string(),
    strategy_version: z.string(),
    nodes: z.array(z.object({ oracle_id: z.string() }).passthrough()),
    edges: z.array(z.object({}).passthrough()),
    declared_intent: z.object({
      intent: z.unknown(),
      effective_role_targets: z.record(z.string(), z.object({ min: z.number(), max: z.number() })),
      alignment: z.literal("not_evaluated"),
    }),
    coverage: z.object({}).passthrough(),
    limitations: z.array(z.string()),
  })
  .passthrough();

describe.each(["2026-07-28", "2024-11-05"] as const)(
  "analyze_strategy on real HTTP MCP %s",
  (revision) => {
    let fixture: Awaited<ReturnType<typeof discoveryFixture>>;
    let running: Awaited<ReturnType<typeof startHttp>>;
    let client: Client;
    let store: DeckStore;
    const fetcher = vi.fn(async () => {
      throw new Error("Providers disabled");
    });
    beforeEach(async () => {
      fetcher.mockClear();
      fixture = await discoveryFixture([
        rawCard("Chief", "Whenever you gain life, draw a card.", {
          type_line: "Legendary Creature — Human",
        }),
        rawCard("Partner", "Whenever you draw a card, you gain 1 life.", {
          type_line: "Legendary Creature — Human",
        }),
        rawCard("Support", "You gain 3 life.", { type_line: "Sorcery" }),
        rawCard("Outside", "You gain 2 life.", { type_line: "Creature — Cat" }),
      ]);
      store = new DeckStore({ newId: () => "d" });
      store.create({
        name: "d",
        commanders: ["Chief", "Partner"],
        computedColorIdentity: [],
      });
      store.update("d", (deck) => ({
        ...deck,
        companion: "Outside",
        cards: [{ oracle_id: "Support", qty: 1 }],
        intent: {
          schema_version: 1,
          soft: {
            strategy: "Deliberately unconventional lifegain",
            goals: ["Keep Support"],
          },
        },
      }));
      running = await startHttp({
        index: fixture.index,
        deckStore: store,
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
        { name: "strategy-test", version: "1" },
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

    it("advertises offline read-only analysis with equivalent structured and JSON text evidence", async () => {
      const tool = (await client.listTools()).tools.find(
        (entry) => entry.name === "analyze_strategy",
      );
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false,
      });
      expect(tool?.outputSchema).toBeUndefined();
      const before = structuredClone(store.get("d"));
      if (!before) throw new Error("Missing fixture deck");
      const result = await client.callTool({
        name: "analyze_strategy",
        arguments: { deck_id: "d" },
      });
      expect(result.isError).not.toBe(true);
      const report = body.parse(result.structuredContent);
      expect(report.deck_version).toBe(before.version);
      expect(report.data_snapshot).toBe("2026-09-08");
      expect(report.nodes.map((node) => node.oracle_id).sort()).toEqual([
        "Chief",
        "Partner",
        "Support",
      ]);
      expect(report.edges.length).toBeGreaterThan(0);
      expect(JSON.stringify(report.declared_intent)).toContain(
        "Deliberately unconventional lifegain",
      );
      expect(result.content).toContainEqual({
        type: "text",
        text: JSON.stringify(result.structuredContent),
      });
      expect(store.get("d")).toEqual(before);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it("observes saved intent and card changes, rejects stale reads and preserves stale-write conflicts", async () => {
      const initial = body.parse(
        (
          await client.callTool({
            name: "analyze_strategy",
            arguments: { deck_id: "d" },
          })
        ).structuredContent,
      );
      const changed = await client.callTool({
        name: "deck_set_intent",
        arguments: {
          deck_id: "d",
          expected_version: initial.deck_version,
          action: "patch",
          patch: {
            soft: {
              strategy: "Keep the niche plan",
              role_targets: { card_draw: { min: 0, max: 2 } },
            },
          },
        },
      });
      expect(changed.structuredContent).toMatchObject({ ok: true });
      const current = body.parse(
        (
          await client.callTool({
            name: "analyze_strategy",
            arguments: { deck_id: "d" },
          })
        ).structuredContent,
      );
      expect(current.deck_version).toBeGreaterThan(initial.deck_version);
      expect(current.declared_intent.effective_role_targets.card_draw).toEqual({
        min: 0,
        max: 2,
      });
      expect(JSON.stringify(current.declared_intent)).toContain("Keep the niche plan");
      const before = structuredClone(store.get("d"));
      const stale = await client.callTool({
        name: "analyze_strategy",
        arguments: { deck_id: "d", expected_version: initial.deck_version },
      });
      expect(stale.structuredContent).toMatchObject({
        ok: false,
        conflict: true,
        expected_version: initial.deck_version,
        current_version: current.deck_version,
      });
      expect(stale.content).toContainEqual({
        type: "text",
        text: JSON.stringify(stale.structuredContent),
      });
      const staleWrite = await client.callTool({
        name: "deck_set_intent",
        arguments: {
          deck_id: "d",
          expected_version: initial.deck_version,
          action: "clear",
        },
      });
      expect(staleWrite.structuredContent).toMatchObject({
        ok: false,
        conflict: true,
      });
      expect(store.get("d")).toEqual(before);
      store.update("d", (deck) => ({ ...deck, cards: [] }));
      const removed = body.parse(
        (
          await client.callTool({
            name: "analyze_strategy",
            arguments: { deck_id: "d" },
          })
        ).structuredContent,
      );
      expect(removed.nodes.map((node) => node.oracle_id).sort()).toEqual(["Chief", "Partner"]);
      expect(removed.edges.length).toBeLessThan(current.edges.length);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it("keeps another principal's deck private", async () => {
      const other = new Client(
        { name: "strategy-other", version: "1" },
        {
          supportedProtocolVersions: [revision],
          versionNegotiation: {
            mode: revision === "2026-07-28" ? { pin: revision } : "legacy",
          },
        },
      );
      try {
        await other.connect(
          new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + running.port + "/mcp"), {
            requestInit: { headers: { "x-mcp-principal": "other" } },
          }),
        );
        expect(
          await other.callTool({
            name: "analyze_strategy",
            arguments: { deck_id: "d" },
          }),
        ).toMatchObject({
          isError: true,
          structuredContent: { code: "DECK_NOT_FOUND" },
        });
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        await other.close();
      }
    });

    it("returns the standard missing-deck error and validates the read version", async () => {
      expect(
        await client.callTool({
          name: "analyze_strategy",
          arguments: { deck_id: "missing" },
        }),
      ).toMatchObject({
        isError: true,
        structuredContent: { code: "DECK_NOT_FOUND" },
      });
      expect(
        await client.callTool({
          name: "analyze_strategy",
          arguments: { deck_id: "d", expected_version: -1 },
        }),
      ).toMatchObject({ isError: true });
    });
  },
);
