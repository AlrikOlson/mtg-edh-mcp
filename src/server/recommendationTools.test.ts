import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { discoveryFixture, rawCard } from "../analyze/discovery.fixture.js";
import { DeckStore } from "../deck/index.js";
import { CacheStore, EdhrecClient } from "../meta/index.js";
import { startHttp } from "./http.js";
import { staticSnapshotProvider } from "./snapshot.js";

const resultSchema = z
  .object({
    deck_id: z.string(),
    deck_version: z.number(),
    data_snapshot: z.string(),
    rank: z.literal("contextual"),
    suggestions: z.array(
      z
        .object({
          oracle_id: z.string(),
          score: z.number(),
          rationale: z.string().min(1),
          evidence: z.unknown(),
          uncertainty: z.array(z.string()).min(1),
          tradeoffs: z.unknown(),
          provider_metrics: z.array(
            z.object({
              commander_id: z.string(),
              metrics: z.array(
                z.object({
                  name: z.string(),
                  provider_field: z.string(),
                  value: z.number(),
                  scale: z.string(),
                  source: z
                    .object({
                      name: z.literal("EDHREC"),
                      url: z.string(),
                      fetched_at: z.string(),
                    })
                    .passthrough(),
                }),
              ),
            }),
          ),
        })
        .passthrough(),
    ),
    providers: z.array(z.object({ commander_id: z.string(), status: z.string() }).passthrough()),
  })
  .passthrough();

describe.each(["2026-07-28", "2024-11-05"] as const)(
  "contextual recommendations over HTTP MCP %s",
  (revision) => {
    let fixture: Awaited<ReturnType<typeof discoveryFixture>>;
    let running: Awaited<ReturnType<typeof startHttp>>;
    let client: Client;
    let store: DeckStore;
    let fail: boolean;
    let beforeFetch: (() => void) | undefined;
    const fetcher = vi.fn(async () => {
      beforeFetch?.();
      if (fail) throw new Error("offline");
      return {
        container: {
          json_dict: {
            cardlists: [
              {
                header: "Popular",
                cardviews: [
                  {
                    name: "Plain",
                    num_decks: 1000,
                    potential_decks: 1200,
                    synergy: 0.9,
                    lift: 9,
                  },
                  {
                    name: "Supply",
                    num_decks: 1,
                    potential_decks: 1200,
                    synergy: -0.2,
                  },
                ],
              },
            ],
          },
        },
      };
    });
    beforeEach(async () => {
      fail = false;
      beforeFetch = undefined;
      fetcher.mockClear();
      fixture = await discoveryFixture([
        rawCard("Chief", "Partner", {
          type_line: "Legendary Creature — Human",
        }),
        rawCard("Second", "Partner\nWhenever you gain life, draw a card.", {
          type_line: "Legendary Creature — Human",
        }),
        rawCard("Supply", "You gain 3 life.", {
          type_line: "Sorcery",
          prices: { usd: "0.10" },
        }),
        rawCard("Plain", "{T}: Add {C}{C}.", { type_line: "Artifact" }),
        rawCard("Banned", "You gain 4 life.", {
          legalities: { commander: "banned" },
        }),
        rawCard("Offcolor", "You gain 5 life.", { color_identity: ["R"] }),
      ]);
      store = new DeckStore({ newId: () => "d" });
      store.create({
        name: "d",
        commanders: ["Chief", "Second"],
        computedColorIdentity: [],
      });
      store.update("d", (deck) => ({ ...deck, command_zone_kind: "partner" }));
      running = await startHttp({
        index: fixture.index,
        deckStore: store,
        snapshot: staticSnapshotProvider("2026-09-08"),
        edhrec: new EdhrecClient(new CacheStore(), { fetchJson: fetcher }),
      });
      client = new Client(
        { name: "recommendation-test", version: "1" },
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
    const call = () => client.callTool({ name: "meta_recommend", arguments: { deck_id: "d" } });

    it("defaults to local deck evidence without fetching and preserves structured/text results and state", async () => {
      const before = structuredClone(store.get("d"));
      const response = await call();
      expect(response.isError).not.toBe(true);
      const report = resultSchema.parse(response.structuredContent);
      expect(report.suggestions[0]?.oracle_id).toBe("Supply");
      expect(report.suggestions.map((s) => s.oracle_id)).not.toContain("Banned");
      expect(report.suggestions.map((s) => s.oracle_id)).not.toContain("Offcolor");
      expect(report.data_snapshot).toBe("2026-09-08");
      expect(report.deck_version).toBe(before?.version);
      expect(report.providers).toEqual([]);
      expect(response.content).toContainEqual({
        type: "text",
        text: JSON.stringify(response.structuredContent),
      });
      expect(store.get("d")).toEqual(before);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it("keeps optional metrics per commander separate and leaves local scores and order unchanged", async () => {
      const local = resultSchema.parse((await call()).structuredContent);
      const enriched = resultSchema.parse(
        (
          await client.callTool({
            name: "meta_recommend",
            arguments: { deck_id: "d", provider: "edhrec" },
          })
        ).structuredContent,
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(enriched.providers).toHaveLength(2);
      expect(enriched.suggestions.map((s) => [s.oracle_id, s.score])).toEqual(
        local.suggestions.map((s) => [s.oracle_id, s.score]),
      );
      const plain = enriched.suggestions.find((s) => s.oracle_id === "Plain");
      expect(plain?.provider_metrics.map((p) => p.commander_id)).toEqual(["Chief", "Second"]);
      expect(plain?.provider_metrics[0]?.metrics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "inclusion",
            provider_field: "num_decks",
            value: 1000,
            scale: "deck_count",
          }),
          expect.objectContaining({
            name: "synergy",
            value: 0.9,
            scale: "proportion_difference",
          }),
          expect.objectContaining({ name: "lift", value: 9, scale: "unknown" }),
        ]),
      );
    });

    it("still returns locally grounded candidates when optional EDHREC fails", async () => {
      fail = true;
      const response = await client.callTool({
        name: "meta_recommend",
        arguments: { deck_id: "d", provider: "edhrec" },
      });
      expect(response.isError).not.toBe(true);
      const report = resultSchema.parse(response.structuredContent);
      expect(report.suggestions[0]?.oracle_id).toBe("Supply");
      expect(report.providers.map((p) => p.status)).toEqual(["unavailable", "unavailable"]);
    });

    it("filters hard exclusions before limit and reads fresh intent without mutation", async () => {
      store.update("d", (deck) => ({
        ...deck,
        intent: { schema_version: 1, hard: { excluded_cards: ["Supply"] } },
      }));
      const before = structuredClone(store.get("d"));
      const response = await client.callTool({
        name: "meta_recommend",
        arguments: { deck_id: "d", limit: 1 },
      });
      const report = resultSchema.parse(response.structuredContent);
      expect(report.suggestions.map((s) => s.oracle_id)).toEqual(["Plain"]);
      expect(store.get("d")).toEqual(before);
    });

    it("applies hard exclusions in explicit profile ranks before limiting", async () => {
      store.update("d", (deck) => ({
        ...deck,
        intent: { schema_version: 1, hard: { excluded_cards: ["Plain"] } },
      }));
      const response = await client.callTool({
        name: "meta_recommend",
        arguments: { deck_id: "d", rank: "inclusion", limit: 1 },
      });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        rank: "inclusion",
        suggestions: [{ oracle_id: "Supply" }],
      });
    });

    it("requires contextual options to be used with contextual ranking", async () => {
      for (const args of [
        { min_inclusion: 1 },
        { rank: "synergy", provider: "none" },
        { rank: "inclusion", theme: "tokens" },
      ]) {
        const response = await client.callTool({
          name: "meta_recommend",
          arguments: { deck_id: "d", ...args },
        });
        expect(response.isError).toBe(true);
        expect(response.structuredContent).toMatchObject({
          code: "INVALID_QUERY",
        });
      }
      expect(fetcher).not.toHaveBeenCalled();
    });
    it("returns a stale read conflict before provider work and rejects changes during enrichment", async () => {
      const before = store.get("d");
      if (!before) throw new Error("Missing deck");
      const stale = await client.callTool({
        name: "meta_recommend",
        arguments: {
          deck_id: "d",
          expected_version: before.version - 1,
          provider: "edhrec",
        },
      });
      expect(stale.structuredContent).toMatchObject({
        ok: false,
        conflict: true,
        current_version: before.version,
      });
      expect(fetcher).not.toHaveBeenCalled();
      beforeFetch = () => {
        beforeFetch = undefined;
        store.update("d", (deck) => ({ ...deck, name: "changed" }));
      };
      const concurrent = await client.callTool({
        name: "meta_recommend",
        arguments: { deck_id: "d", provider: "edhrec" },
      });
      expect(concurrent.structuredContent).toMatchObject({
        ok: false,
        conflict: true,
        expected_version: before.version,
      });
      expect(store.get("d")?.name).toBe("changed");
    });
  },
);
