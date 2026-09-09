import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { discoveryFixture, rawCard } from "../analyze/discovery.fixture.js";
import { DeckStore } from "../deck/index.js";
import { startHttp } from "./http.js";
import { DeckChangePlanSchema } from "./deckPlanTools.js";
import { staticSnapshotProvider } from "./snapshot.js";
import { constructionCases, constructionFixture } from "../build/construction.fixture.js";

const priced = { prices: { usd: "0.10" } };
const request = {
  commanders: ["Chief"],
  command_zone_kind: "single",
  budget: { mode: "unbounded" },
};

describe.each(["2026-07-28", "2024-11-05"] as const)(
  "complete construction over HTTP MCP %s",
  (revision) => {
    let fixture: Awaited<ReturnType<typeof discoveryFixture>>;
    let running: Awaited<ReturnType<typeof startHttp>>;
    let client: Client;
    let store: DeckStore;
    const connect = async (principal?: string) => {
      const connected = new Client(
        { name: "construction-builder-test", version: "1" },
        {
          supportedProtocolVersions: [revision],
          versionNegotiation: {
            mode: revision === "2026-07-28" ? { pin: revision } : "legacy",
          },
        },
      );
      await connected.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`), {
          requestInit: principal ? { headers: { "x-mcp-principal": principal } } : undefined,
        }),
      );
      return connected;
    };
    const call = (args: Record<string, unknown> = {}) =>
      client.callTool({ name: "deck_construct", arguments: args });

    beforeEach(async () => {
      fixture = await discoveryFixture([
        rawCard("Chief", "Partner\nWhenever a creature enters, draw a card.", {
          ...priced,
          cmc: 4,
          mana_cost: "{2}{U}{B}",
          color_identity: ["U", "B"],
          type_line: "Legendary Creature — Human",
        }),
        rawCard("Second", "Partner", {
          ...priced,
          type_line: "Legendary Creature — Human",
        }),
        rawCard("Supply", "Draw a card. Add {C}.", { ...priced, type_line: "Sorcery" }),
        rawCard("Wastes", "{T}: Add {C}.", {
          ...priced,
          cmc: 0,
          mana_cost: "",
          type_line: "Basic Land — Wastes",
        }),
        rawCard(
          "Persistent Petitioners",
          "A deck can have any number of cards named Persistent Petitioners.",
          { ...priced, mana_cost: "{1}{U}", color_identity: ["U"] },
        ),
        rawCard(
          "Gyruda, Doom of Depths",
          "Companion — Your starting deck contains only cards with even mana values.",
          {
            ...priced,
            cmc: 6,
            mana_cost: "{4}{U/B}{U/B}",
            color_identity: ["U", "B"],
            type_line: "Legendary Creature — Demon Kraken",
          },
        ),
      ]);
      store = new DeckStore();
      running = await startHttp({
        index: fixture.index,
        deckStore: store,
        snapshot: staticSnapshotProvider("construction-fixture"),
      });
      client = await connect();
    });
    afterEach(async () => {
      await client.close();
      await running.close();
      await fixture.close();
    });

    it("returns a reviewed, read-only complete proposal with full text fallback and applies it once", async () => {
      const tool = (await client.listTools()).tools.find(
        (entry) => entry.name === "deck_construct",
      );
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      const before = store.dump();
      const response = await call({ name: "Generated deck", request });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        status: "found",
        ok: true,
        validation: { valid: true },
        data_snapshot: "construction-fixture",
      });
      expect(response.content).toContainEqual({
        type: "text",
        text: JSON.stringify(response.structuredContent),
      });
      const result = z.record(z.string(), z.unknown()).parse(response.structuredContent);
      const plan = DeckChangePlanSchema.parse(result.plan);
      expect(plan.input.request.cards.reduce((sum, entry) => sum + entry.qty, 0)).toBe(99);
      expect(plan.input.request.commanders).toEqual(["Chief"]);
      expect(result.explanations).toBeDefined();
      expect(result.search).toBeDefined();
      expect(store.dump()).toEqual(before);
      const applied = await client.callTool({ name: "deck_plan_apply", arguments: { plan } });
      expect(applied).toMatchObject({
        structuredContent: { ok: true, replayed: false, version: 1 },
      });
      const replay = await client.callTool({ name: "deck_plan_apply", arguments: { plan } });
      expect(replay).toMatchObject({ structuredContent: { ok: true, replayed: true } });
      expect(store.list()).toHaveLength(1);
    });

    it("builds a legal partner deck with an outside companion and special card multiplicity", async () => {
      const response = await call({
        request: {
          ...request,
          commanders: ["Chief", "Second"],
          command_zone_kind: "partner",
          companion: "Gyruda, Doom of Depths",
          budget: { mode: "cap", usd: 20, include_companion: true },
          lands: { min: 36, max: 36, strength: "hard" },
          intent: {
            schema_version: 1,
            hard: { locked_cards: [{ oracle_id: "Persistent Petitioners", qty: 60 }] },
          },
        },
      });
      expect(
        response.structuredContent,
        JSON.stringify(z.object({ diagnostics: z.unknown() }).parse(response.structuredContent)),
      ).toMatchObject({
        status: "found",
        validation: { valid: true, land_count: 36 },
      });
      const result = z.record(z.string(), z.unknown()).parse(response.structuredContent);
      const plan = DeckChangePlanSchema.parse(result.plan);
      expect(plan.input.request.cards.reduce((sum, entry) => sum + entry.qty, 0)).toBe(98);
      expect(
        plan.input.request.cards.find((entry) => entry.oracle_id === "Persistent Petitioners")?.qty,
      ).toBeGreaterThanOrEqual(60);
      expect(
        plan.input.request.cards.some((entry) => entry.oracle_id === "Gyruda, Doom of Depths"),
      ).toBe(false);
      const applied = await client.callTool({ name: "deck_plan_apply", arguments: { plan } });
      const { deck_id } = z.object({ deck_id: z.string() }).parse(applied.structuredContent);
      expect(
        await client.callTool({ name: "validate_deck", arguments: { deck_id } }),
      ).toMatchObject({ structuredContent: { ok: true, error_count: 0 } });
      expect(store.get(deck_id)?.companion).toBe("Gyruda, Doom of Depths");
    });

    it("turns theme-first goals into a complete proposal with a selected command zone", async () => {
      const before = store.dump();
      const response = await call({
        request: { theme: "draw", budget: { mode: "unbounded" } },
      });
      expect(response.structuredContent).toMatchObject({
        status: "found",
        validation: { valid: true },
      });
      const result = z.record(z.string(), z.unknown()).parse(response.structuredContent);
      const plan = DeckChangePlanSchema.parse(result.plan);
      const commandZone = plan.input.request.commanders ?? [];
      expect(commandZone.length).toBeGreaterThan(0);
      expect(
        plan.input.request.cards.reduce((sum, entry) => sum + entry.qty, commandZone.length),
      ).toBe(100);
      expect(plan.input.request.theme).toBe("draw");
      expect(store.dump()).toEqual(before);
    });

    it("constructs from a saved partial deck while retaining intent and binds its source version", async () => {
      const deck = store.create({
        name: "Draft",
        commanders: ["Chief"],
        computedColorIdentity: ["U", "B"],
      });
      store.update(deck.deck_id, (current) => ({
        ...current,
        cards: [{ oracle_id: "Wastes", qty: 20 }],
        intent: { schema_version: 1, hard: { locked_cards: [{ oracle_id: "Supply", qty: 1 }] } },
      }));
      const source = store.get(deck.deck_id);
      const before = store.dump();
      const response = await call({
        deck_id: deck.deck_id,
        expected_version: source?.version,
        request: { budget: { mode: "unbounded" } },
      });
      expect(response.structuredContent).toMatchObject({
        status: "found",
        desired: { intent: source?.intent },
      });
      const result = z.record(z.string(), z.unknown()).parse(response.structuredContent);
      const plan = DeckChangePlanSchema.parse(result.plan);
      expect(plan).toMatchObject({ deck_id: deck.deck_id, expected_version: source?.version });
      expect(plan.input.request.cards).toContainEqual({ oracle_id: "Supply", qty: 1 });
      expect(store.dump()).toEqual(before);
      store.setName(deck.deck_id, "Concurrent edit");
      expect(await client.callTool({ name: "deck_plan_apply", arguments: { plan } })).toMatchObject(
        { isError: true, structuredContent: { code: "PLAN_VERSION_CONFLICT" } },
      );
    });

    it("keeps bounded exhaustion distinct from a proven constraint conflict and offers no apply plan", async () => {
      const before = store.dump();
      for (const [args, status] of [
        [{ request, search: { node_limit: 1 } }, "search_exhausted"],
        [
          {
            request: {
              ...request,
              intent: { schema_version: 1, hard: { excluded_cards: ["Chief"] } },
            },
          },
          "proven_conflict",
        ],
        [
          {
            request: {
              ...request,
              requirements: [
                { id: "unknown", text: "Win by a novel unsupported mechanic", strength: "hard" },
              ],
            },
          },
          "search_exhausted",
        ],
      ] as const) {
        const response = await call(args);
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent).toMatchObject({ status, ok: false });
        expect(
          z.record(z.string(), z.unknown()).parse(response.structuredContent).plan,
        ).toBeUndefined();
        expect(response.content).toContainEqual({
          type: "text",
          text: JSON.stringify(response.structuredContent),
        });
      }
      expect(store.dump()).toEqual(before);
    });

    it("requires explicit source versions and never exposes another principal's partial deck or plan", async () => {
      const deck = store.create({
        name: "Private draft",
        commanders: ["Chief"],
        computedColorIdentity: ["U", "B"],
      });
      expect(await call({ deck_id: deck.deck_id, request })).toMatchObject({
        isError: true,
        structuredContent: { code: "PLAN_VERSION_REQUIRED" },
      });
      expect(await call({ expected_version: 1, request })).toMatchObject({
        isError: true,
        structuredContent: { code: "PLAN_VERSION_REQUIRED" },
      });
      expect(await call({ deck_id: deck.deck_id, expected_version: 99, request })).toMatchObject({
        isError: true,
        structuredContent: { code: "PLAN_VERSION_CONFLICT" },
      });
      const response = await call({ request });
      const plan = z.record(z.string(), z.unknown()).parse(response.structuredContent).plan;
      const other = await connect("other");
      try {
        expect(
          await other.callTool({
            name: "deck_construct",
            arguments: { deck_id: deck.deck_id, expected_version: deck.version, request },
          }),
        ).toMatchObject({ isError: true, structuredContent: { code: "DECK_NOT_FOUND" } });
        expect(
          await other.callTool({ name: "deck_plan_apply", arguments: { plan } }),
        ).toMatchObject({ isError: true, structuredContent: { code: "PLAN_SESSION_MISMATCH" } });
      } finally {
        await other.close();
      }
    });
  },
);

describe.each(["2026-07-28", "2024-11-05"] as const)(
  "real-card construction acceptance over HTTP MCP %s",
  (revision) => {
    let fixture: Awaited<ReturnType<typeof constructionFixture>>;
    beforeAll(async () => {
      fixture = await constructionFixture();
    });
    afterAll(async () => {
      await fixture.close();
    });

    it.each(
      constructionCases.filter(
        (testCase) =>
          testCase.expected.companion ||
          testCase.coverage.some((coverage) => coverage.endsWith("multiplicity")),
      ),
    )(
      "constructs, applies and validates $id with its real companion or copy exception",
      async (testCase) => {
        const store = new DeckStore();
        const running = await startHttp({
          index: fixture.index,
          deckStore: store,
          snapshot: staticSnapshotProvider("construction-real-card-fixture"),
        });
        const client = new Client(
          { name: "construction-real-card-test", version: "1" },
          {
            supportedProtocolVersions: [revision],
            versionNegotiation: { mode: revision === "2026-07-28" ? { pin: revision } : "legacy" },
          },
        );
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)),
          );
          const response = await client.callTool({
            name: "deck_construct",
            arguments: { request: testCase.request },
          });
          expect(response.isError).not.toBe(true);
          expect(response.structuredContent).toMatchObject({
            status: "found",
            validation: { valid: true },
          });
          const plan = DeckChangePlanSchema.parse(
            z.record(z.string(), z.unknown()).parse(response.structuredContent).plan,
          );
          expect(store.list()).toEqual([]);
          expect(
            plan.input.request.cards.reduce(
              (sum, entry) => sum + entry.qty,
              testCase.expected.commanderCount,
            ),
          ).toBe(100);
          for (const required of testCase.expected.requiredCards)
            expect(
              plan.input.request.cards.find((entry) => entry.oracle_id === required.oracle_id)?.qty,
            ).toBeGreaterThanOrEqual(required.qty);
          const applied = await client.callTool({ name: "deck_plan_apply", arguments: { plan } });
          expect(applied.isError).not.toBe(true);
          const { deck_id } = z.object({ deck_id: z.string() }).parse(applied.structuredContent);
          expect(store.get(deck_id)?.companion).toBe(testCase.expected.companion);
          expect(
            await client.callTool({ name: "validate_deck", arguments: { deck_id } }),
          ).toMatchObject({ structuredContent: { ok: true, error_count: 0 } });
        } finally {
          await client.close();
          await running.close();
        }
      },
    );
  },
);
