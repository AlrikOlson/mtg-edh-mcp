import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { discoveryFixture, rawCard } from "../analyze/discovery.fixture.js";
import { DeckStore } from "../deck/index.js";
import { startHttp } from "./http.js";
import { staticSnapshotProvider } from "./snapshot.js";

const modelSchema = z
  .object({
    version: z.literal(1),
    coverage: z.object({
      total_quantity: z.number(),
      resolved_quantity: z.number(),
      supported_quantity: z.number(),
      unsupported_quantity: z.number(),
      unresolved_quantity: z.number(),
      overridden_quantity: z.number(),
    }),
    cards: z.array(
      z
        .object({
          oracle_id: z.string(),
          qty: z.number(),
          reasons: z.array(z.string()),
          assumptions: z.array(z.string()),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const reportSchema = z
  .object({
    deck_id: z.string(),
    deck_version: z.number(),
    data_snapshot: z.string(),
    model_scope: z.literal("library"),
    summary_basis: z.literal("legacy_heuristic"),
    mana_model: modelSchema,
    command_zone_mana_model: modelSchema,
  })
  .passthrough();

describe.each(["2026-07-28", "2024-11-05"] as const)(
  "mana source model on real HTTP MCP %s",
  (revision) => {
    let fixture: Awaited<ReturnType<typeof discoveryFixture>>;
    let running: Awaited<ReturnType<typeof startHttp>>;
    let client: Client;
    let store: DeckStore;

    function newClient() {
      return new Client(
        { name: "mana-model", version: "1" },
        {
          supportedProtocolVersions: [revision],
          versionNegotiation: { mode: revision === "2026-07-28" ? { pin: revision } : "legacy" },
        },
      );
    }

    beforeEach(async () => {
      fixture = await discoveryFixture([
        rawCard("Forest", "({T}: Add {G}.)", {
          type_line: "Basic Land — Forest",
          mana_cost: "",
          produced_mana: ["G"],
        }),
        rawCard("Sol Ring", "{T}: Add {C}{C}.", {
          type_line: "Artifact",
          mana_cost: "{1}",
          produced_mana: ["C"],
        }),
        rawCard(
          "Ancient Ziggurat",
          "{T}: Add one mana of any color. Spend this mana only to cast a creature spell.",
          {
            type_line: "Land",
            mana_cost: "",
            produced_mana: ["W", "U", "B", "R", "G"],
          },
        ),
        rawCard("Chief", "", { mana_cost: "{2}{G}", type_line: "Legendary Creature — Elf" }),
        rawCard("Outside", "", { mana_cost: "{4}{G}", type_line: "Creature — Cat" }),
      ]);
      store = new DeckStore({ newId: () => "d" });
      store.create({ name: "Mana test", commanders: ["Chief"], computedColorIdentity: ["G"] });
      store.update("d", (deck) => ({
        ...deck,
        companion: "Outside",
        cards: [
          { oracle_id: "Forest", qty: 3 },
          { oracle_id: "Sol Ring", qty: 1 },
          { oracle_id: "Ancient Ziggurat", qty: 2 },
          { oracle_id: "missing", qty: 4 },
        ],
      }));
      running = await startHttp({
        index: fixture.index,
        deckStore: store,
        snapshot: staticSnapshotProvider("2026-09-09"),
      });
      client = newClient();
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + running.port + "/mcp")),
      );
    });
    afterEach(async () => {
      await client.close();
      await running.close();
      await fixture.close();
    });

    it("reports supported, unsupported and unresolved quantities with equivalent text evidence", async () => {
      const before = structuredClone(store.get("d"));
      const result = await client.callTool({
        name: "analyze_mana_base",
        arguments: { deck_id: "d" },
      });
      expect(result.isError).not.toBe(true);
      const report = reportSchema.parse(result.structuredContent);
      expect(report.deck_version).toBe(before?.version);
      expect(report.mana_model.coverage).toEqual({
        total_quantity: 10,
        resolved_quantity: 6,
        supported_quantity: 4,
        unsupported_quantity: 2,
        unresolved_quantity: 4,
        overridden_quantity: 0,
      });
      expect(
        report.mana_model.cards.find((card) => card.oracle_id === "Ancient Ziggurat")?.reasons
          .length,
      ).toBeGreaterThan(0);
      expect(
        report.mana_model.cards.find((card) => card.oracle_id === "missing")?.reasons.length,
      ).toBeGreaterThan(0);
      expect(report.command_zone_mana_model.cards.map((card) => card.oracle_id)).toEqual(["Chief"]);
      expect(result.content).toContainEqual({
        type: "text",
        text: JSON.stringify(result.structuredContent),
      });
      expect(store.get("d")).toEqual(before);
      const tool = (await client.listTools()).tools.find(
        (entry) => entry.name === "analyze_mana_base",
      );
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(tool?.outputSchema).toBeUndefined();
    });

    it("marks bounded caller overrides without persisting or laundering extracted support", async () => {
      const before = structuredClone(store.get("d"));
      const result = await client.callTool({
        name: "analyze_mana_base",
        arguments: {
          deck_id: "d",
          overrides: [
            {
              oracle_id: "Ancient Ziggurat",
              face_index: 0,
              reason: "For this scenario every payment is a creature spell.",
              source: {
                outputs: [["G"]],
                activation_cost: "{0}",
                enters_tapped: false,
                summoning_delay: false,
              },
            },
          ],
        },
      });
      const report = reportSchema.parse(result.structuredContent);
      expect(report.mana_model.coverage.overridden_quantity).toBe(2);
      expect(report.mana_model.coverage.supported_quantity).toBe(4);
      const assumed = report.mana_model.cards.find((card) => card.oracle_id === "Ancient Ziggurat");
      expect(assumed?.assumptions.join(" ")).toContain("every payment is a creature spell");
      expect(result.content).toContainEqual({
        type: "text",
        text: JSON.stringify(result.structuredContent),
      });
      expect(store.get("d")).toEqual(before);
      const plain = reportSchema.parse(
        (
          await client.callTool({
            name: "analyze_mana_base",
            arguments: { deck_id: "d" },
          })
        ).structuredContent,
      );
      expect(plain.mana_model.coverage.overridden_quantity).toBe(0);
    });

    it("rejects malformed assumptions and version conflicts without changing the deck", async () => {
      const before = structuredClone(store.get("d"));
      if (!before) throw new Error("Missing test deck");
      for (const overrides of [
        [{ oracle_id: "Forest", face_index: -1, reason: "bad face" }],
        [{ oracle_id: "Forest", face_index: 0, reason: "", source: { outputs: [["Q"]] } }],
        [
          {
            oracle_id: "Forest",
            face_index: 0,
            reason: "Unbounded production",
            source: { outputs: [] },
          },
        ],
      ]) {
        expect(
          await client.callTool({
            name: "analyze_mana_base",
            arguments: { deck_id: "d", overrides },
          }),
        ).toMatchObject({ isError: true });
      }
      store.update("d", (deck) => ({ ...deck, name: "Changed" }));
      const changed = structuredClone(store.get("d"));
      const stale = await client.callTool({
        name: "analyze_mana_base",
        arguments: { deck_id: "d", expected_version: before.version },
      });
      expect(stale.structuredContent).toMatchObject({
        ok: false,
        conflict: true,
        expected_version: before.version,
        current_version: changed?.version,
      });
      expect(stale.content).toContainEqual({
        type: "text",
        text: JSON.stringify(stale.structuredContent),
      });
      expect(store.get("d")).toEqual(changed);
    });

    it("carries library coverage into deck_status and keeps other principals private", async () => {
      const status = await client.callTool({ name: "deck_status", arguments: { deck_id: "d" } });
      expect(status.structuredContent).toMatchObject({
        mana: {
          summary_basis: "legacy_heuristic",
          model_coverage: {
            total_quantity: 10,
            resolved_quantity: 6,
            unsupported_quantity: 2,
            unresolved_quantity: 4,
          },
        },
      });
      const other = newClient();
      try {
        await other.connect(
          new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + running.port + "/mcp"), {
            requestInit: { headers: { "x-mcp-principal": "other" } },
          }),
        );
        expect(
          await other.callTool({
            name: "analyze_mana_base",
            arguments: { deck_id: "d" },
          }),
        ).toMatchObject({ isError: true, structuredContent: { code: "DECK_NOT_FOUND" } });
      } finally {
        await other.close();
      }
    });
  },
);
