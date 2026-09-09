import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { discoveryFixture, rawCard } from "../analyze/discovery.fixture.js";
import { DeckStore } from "../deck/index.js";
import { startHttp } from "./http.js";
import { staticSnapshotProvider } from "./snapshot.js";

describe.each(["2026-07-28", "2024-11-05"] as const)(
  "construction specifications over HTTP MCP %s",
  (revision) => {
    let fixture: Awaited<ReturnType<typeof discoveryFixture>>;
    let running: Awaited<ReturnType<typeof startHttp>>;
    let client: Client;
    let store: DeckStore;
    beforeEach(async () => {
      fixture = await discoveryFixture([
        rawCard("Chief", "Partner", {
          type_line: "Legendary Creature — Human",
        }),
        rawCard("Second", "Partner", {
          type_line: "Legendary Creature — Human",
        }),
        rawCard("Supply", "Draw a card. Add {C}.", { type_line: "Sorcery" }),
        rawCard("Wastes", "{T}: Add {C}.", {
          type_line: "Basic Land — Wastes",
        }),
      ]);
      store = new DeckStore({ newId: () => "d" });
      store.create({
        name: "Draft",
        commanders: ["Chief"],
        computedColorIdentity: [],
      });
      store.update("d", (deck) => ({
        ...deck,
        cards: [{ oracle_id: "Wastes", qty: 20 }],
        intent: {
          schema_version: 1,
          hard: { locked_cards: [{ oracle_id: "Supply", qty: 1 }] },
          soft: { strategy: "draw and ramp", spend_target_usd: 50 },
        },
      }));
      running = await startHttp({
        index: fixture.index,
        deckStore: store,
        snapshot: staticSnapshotProvider("construction-fixture"),
      });
      client = new Client(
        { name: "construction-test", version: "1" },
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
    const call = (args: Record<string, unknown> = {}) =>
      client.callTool({ name: "construction_spec", arguments: args });

    it("advertises a local read-only normalization tool and returns unresolved empty choices with full text fallback", async () => {
      const tool = (await client.listTools()).tools.find((t) => t.name === "construction_spec");
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false,
      });
      const before = structuredClone(store.get("d"));
      const response = await call();
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        status: "needs_choices",
        data_snapshot: "construction-fixture",
      });
      expect(response.content).toContainEqual({
        type: "text",
        text: JSON.stringify(response.structuredContent),
      });
      expect(store.get("d")).toEqual(before);
    });
    it("normalizes a partial saved deck and durable intent without mutation", async () => {
      const before = structuredClone(store.get("d"));
      const response = await call({
        deck_id: "d",
        expected_version: before?.version,
      });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        deck_id: "d",
        deck_version: before?.version,
      });
      expect(response.structuredContent).toMatchObject({
        specification: {
          source: {
            kind: "saved_deck",
            deck_id: "d",
            version: before?.version,
            intent_snapshot: before?.intent,
          },
          intent: before?.intent,
          seed_cards: [{ oracle_id: "Wastes", qty: 20 }],
          budget: { mode: "target", usd: 50 },
        },
      });
      expect(store.get("d")).toEqual(before);
    });
    it("rejects stale source versions before normalizing and does not invent a new version", async () => {
      const before = store.get("d");
      const response = await call({ deck_id: "d", expected_version: 0 });
      expect(response.structuredContent).toMatchObject({
        ok: false,
        conflict: true,
        expected_version: 0,
        current_version: before?.version,
      });
      expect(store.get("d")).toEqual(before);
    });
    it("requires a source deck for expected_version and hides decks outside the caller scope", async () => {
      const invalid = await call({ expected_version: 1 });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toMatchObject({
        code: "INVALID_QUERY",
      });
      const missing = await call({ deck_id: "missing" });
      expect(missing.isError).toBe(true);
      expect(missing.structuredContent).toMatchObject({
        code: "DECK_NOT_FOUND",
      });
    });
    it("returns specific conflict diagnostics for an excluded commander without searching", async () => {
      const response = await call({
        request: {
          commanders: ["Chief"],
          intent: { schema_version: 1, hard: { excluded_cards: ["Chief"] } },
        },
      });
      expect(response.structuredContent).toMatchObject({ status: "conflict" });
      expect(JSON.stringify(response.structuredContent)).toMatch(/excluded/i);
      expect(response.content).toContainEqual({
        type: "text",
        text: JSON.stringify(response.structuredContent),
      });
    });
    it("never exposes saved intent across principals", async () => {
      const other = new Client(
        { name: "other", version: "1" },
        {
          supportedProtocolVersions: [revision],
          versionNegotiation: {
            mode: revision === "2026-07-28" ? { pin: revision } : "legacy",
          },
        },
      );
      await other.connect(
        new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + running.port + "/mcp"), {
          requestInit: { headers: { "x-mcp-principal": "other" } },
        }),
      );
      try {
        const result = await other.callTool({
          name: "construction_spec",
          arguments: { deck_id: "d" },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          code: "DECK_NOT_FOUND",
        });
        expect(JSON.stringify(result)).not.toContain("draw and ramp");
        const empty = await other.callTool({
          name: "construction_spec",
          arguments: {},
        });
        expect(empty.structuredContent).toMatchObject({
          status: "needs_choices",
          specification: { source: { kind: "request" } },
        });
      } finally {
        await other.close();
      }
    });
    it("preserves unknown hard requirements and exact quantities in a common specification", async () => {
      const result = await call({
        request: {
          commanders: ["Chief", "Second"],
          command_zone_kind: "partner",
          cards: [
            { oracle_id: "Wastes", qty: 20 },
            { oracle_id: "Wastes", qty: 10 },
          ],
          budget: { mode: "unbounded" },
          requirements: [
            {
              id: "novel",
              text: "win via an unsupported mechanic",
              strength: "hard",
            },
          ],
        },
      });
      expect(result.structuredContent).toMatchObject({
        schema_version: 1,
        status: "needs_choices",
        specification: {
          command_zone: { library_size: 98 },
          seed_cards: [{ oracle_id: "Wastes", qty: 30 }],
          budget: { mode: "unbounded", usd: null },
          card_accounting: {
            seed_library_quantity: 30,
            command_zone_quantity: 2,
            role_memberships_overlap: true,
          },
        },
        unresolved_requirements: expect.arrayContaining([
          expect.objectContaining({ id: "novel", strength: "hard" }),
        ]),
      });
    });
    it("rejects unsupported request versions and unrecognized constraint fields at the schema boundary", async () => {
      for (const request of [{ schema_version: 2 }, { hidden_hard_constraint: true }]) {
        const result = await call({ request });
        expect(result.isError).toBe(true);
      }
    });
    it("offers theme-first and empty build prompts without requiring a commander", async () => {
      const cases: Record<string, string>[] = [{ theme: "tokens" }, {}];
      for (const args of cases) {
        const response = await client.getPrompt({
          name: "build_commander_deck",
          arguments: args,
        });
        const text = JSON.stringify(response.messages);
        expect(text).toContain("construction_spec");
        expect(text).not.toContain("undefined");
        expect(text).toContain("card_discover");
      }
    });
  },
);
