import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { discoveryFixture, rawCard } from "../analyze/discovery.fixture.js";
import { DeckStore } from "../deck/index.js";
import { startHttp } from "./http.js";
import { staticSnapshotProvider } from "./snapshot.js";

const modelSchema = z.object({
  coverage: z.object({
    total_quantity: z.number(),
    resolved_quantity: z.number(),
    supported_quantity: z.number(),
    unsupported_quantity: z.number(),
    unresolved_quantity: z.number(),
    overridden_quantity: z.number(),
  }),
  cards: z.array(
    z.object({ oracle_id: z.string(), qty: z.number(), assumptions: z.array(z.string()) }),
  ),
});
const reportSchema = z.object({
  deck_id: z.string(),
  deck_version: z.number(),
  data_snapshot: z.string(),
  mode: z.literal("sequence"),
  mana_model: modelSchema,
  command_zone_mana_model: modelSchema,
  sequence: z.object({
    status: z.enum(["success", "failure", "truncated", "unsupported"]),
    first_spell_turn: z.number().nullable(),
    target_cast_turn: z.number().nullable(),
    turns: z.array(z.object({ turn: z.number(), lands_in_play: z.number() }).passthrough()),
    reasons: z.array(z.string()),
    work: z.unknown(),
    replay: z.object({ ok: z.boolean(), reasons: z.array(z.string()) }),
  }),
});

describe.each(["2026-07-28", "2024-11-05"] as const)(
  "mana sequencing on real HTTP MCP %s",
  (revision) => {
    let fixture: Awaited<ReturnType<typeof discoveryFixture>>;
    let running: Awaited<ReturnType<typeof startHttp>>;
    let client: Client;
    let store: DeckStore;

    function newClient() {
      return new Client(
        { name: "mana-sequence", version: "1" },
        {
          supportedProtocolVersions: [revision],
          versionNegotiation: { mode: revision === "2026-07-28" ? { pin: revision } : "legacy" },
        },
      );
    }

    async function simulate(args: Record<string, unknown> = {}) {
      return client.callTool({
        name: "simulate_deck",
        arguments: { deck_id: "d", mode: "sequence", seed: 9, ...args },
      });
    }

    beforeEach(async () => {
      fixture = await discoveryFixture([
        rawCard("Forest", "({T}: Add {G}.)", {
          type_line: "Basic Land — Forest",
          mana_cost: "",
          produced_mana: ["G"],
        }),
        rawCard("Red Spell", "", { mana_cost: "{R}", type_line: "Sorcery" }),
        rawCard("Green Spell", "", { mana_cost: "{G}", type_line: "Sorcery" }),
        rawCard("Chief", "", { mana_cost: "{2}{G}", type_line: "Legendary Creature — Elf" }),
        rawCard("Outside", "", { mana_cost: "{0}", type_line: "Creature — Cat" }),
        rawCard(
          "Ancient Ziggurat",
          "{T}: Add one mana of any color. Spend this mana only to cast a creature spell.",
          { type_line: "Land", mana_cost: "", produced_mana: ["W", "U", "B", "R", "G"] },
        ),
      ]);
      store = new DeckStore({ newId: () => "d" });
      store.create({ name: "Sequence test", commanders: ["Chief"], computedColorIdentity: ["G"] });
      store.update("d", (deck) => ({
        ...deck,
        companion: "Outside",
        cards: [{ oracle_id: "Forest", qty: 3 }],
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

    it("casts a commander from its zone without drawing it or the companion", async () => {
      const before = structuredClone(store.get("d"));
      const args = {
        target: { oracle_id: "Chief", zone: "command" },
        hand_size: 3,
        max_turns: 3,
        on_the_play: true,
      };
      const result = await simulate(args);
      expect(result.isError).not.toBe(true);
      const report = reportSchema.parse(result.structuredContent);
      expect(report).toMatchObject({
        deck_id: "d",
        deck_version: before?.version,
        data_snapshot: "2026-09-09",
        sequence: {
          status: "success",
          first_spell_turn: 3,
          target_cast_turn: 3,
          replay: { ok: true },
        },
      });
      expect(report.sequence.turns.map((turn) => turn.lands_in_play)).toEqual([1, 2, 3]);
      expect(report.mana_model.cards).toEqual([{ oracle_id: "Forest", qty: 3, assumptions: [] }]);
      expect(report.command_zone_mana_model.cards.map((card) => card.oracle_id)).toEqual(["Chief"]);
      expect(result.content).toContainEqual({
        type: "text",
        text: JSON.stringify(result.structuredContent),
      });
      expect((await simulate(args)).structuredContent).toEqual(result.structuredContent);
      expect(store.get("d")).toEqual(before);
    });

    it("does not cast a target with the wrong color even when the mana count is sufficient", async () => {
      store.update("d", (deck) => ({
        ...deck,
        cards: [
          { oracle_id: "Forest", qty: 3 },
          { oracle_id: "Red Spell", qty: 1 },
        ],
      }));
      const report = reportSchema.parse(
        (
          await simulate({
            target: { oracle_id: "Red Spell", zone: "library" },
            hand_size: 4,
            max_turns: 2,
          })
        ).structuredContent,
      );
      expect(report.sequence).toMatchObject({
        status: "failure",
        first_spell_turn: null,
        target_cast_turn: null,
      });
      expect(report.sequence.reasons.length).toBeGreaterThan(0);
    });

    it("finds the first payable library spell when no explicit target is requested", async () => {
      store.update("d", (deck) => ({
        ...deck,
        cards: [
          { oracle_id: "Forest", qty: 1 },
          { oracle_id: "Green Spell", qty: 1 },
        ],
      }));
      const report = reportSchema.parse(
        (await simulate({ hand_size: 2, max_turns: 1 })).structuredContent,
      );
      expect(report.sequence).toMatchObject({ status: "success", first_spell_turn: 1 });
    });

    it("reports uncertain card quantities and stops a bounded search explicitly", async () => {
      store.update("d", (deck) => ({
        ...deck,
        cards: [
          { oracle_id: "Forest", qty: 3 },
          { oracle_id: "Ancient Ziggurat", qty: 2 },
          { oracle_id: "missing", qty: 4 },
        ],
      }));
      const result = await simulate({
        hand_size: 9,
        max_turns: 3,
        max_work: 1,
        target: { oracle_id: "Chief", zone: "command" },
      });
      const report = reportSchema.parse(result.structuredContent);
      expect(report.mana_model.coverage).toEqual({
        total_quantity: 9,
        resolved_quantity: 5,
        supported_quantity: 3,
        unsupported_quantity: 2,
        unresolved_quantity: 4,
        overridden_quantity: 0,
      });
      expect(report.sequence.status).toBe("truncated");
      expect(report.sequence.reasons.length).toBeGreaterThan(0);
      expect(report.sequence.target_cast_turn).toBeNull();
      expect(result.content).toContainEqual({
        type: "text",
        text: JSON.stringify(result.structuredContent),
      });
    });

    it("reports the exact default turn horizon needed to replay the sequence", async () => {
      const result = await simulate({ target: { oracle_id: "Chief", zone: "command" } });
      const report = reportSchema.parse(result.structuredContent);
      const settings = z
        .object({
          sequence_options: z.object({ maxTurns: z.number() }),
          library_order: z.array(z.string()),
          physical_cards: z.array(z.object({ id: z.string(), oracle_id: z.string() })),
        })
        .parse(result.structuredContent);
      expect(report.sequence.status).toBe("success");
      expect(settings.sequence_options.maxTurns).toBe(10);
      expect(report.sequence.turns).toHaveLength(settings.sequence_options.maxTurns);
      expect(new Set(settings.physical_cards.map((card) => card.id)).size).toBe(4);
      const identities = new Map(settings.physical_cards.map((card) => [card.id, card.oracle_id]));
      expect(settings.library_order.map((id) => identities.get(id))).toEqual([
        "Forest",
        "Forest",
        "Forest",
      ]);
      expect(
        settings.physical_cards
          .filter((card) => !settings.library_order.includes(card.id))
          .map((card) => card.oracle_id),
      ).toEqual(["Chief"]);
    });

    it("marks caller assumptions and does not persist them or change extracted coverage", async () => {
      store.update("d", (deck) => ({
        ...deck,
        cards: [{ oracle_id: "Ancient Ziggurat", qty: 3 }],
      }));
      const before = structuredClone(store.get("d"));
      const args = { hand_size: 3, max_turns: 3, target: { oracle_id: "Chief", zone: "command" } };
      const result = await simulate({
        ...args,
        overrides: [
          {
            oracle_id: "Ancient Ziggurat",
            face_index: 0,
            reason: "Assume all payments are creature spells for this scenario.",
            source: {
              outputs: [["G"]],
              activation_cost: "{0}",
              enters_tapped: false,
              summoning_delay: false,
            },
          },
        ],
      });
      const report = reportSchema.parse(result.structuredContent);
      expect(report.sequence).toMatchObject({ status: "success", target_cast_turn: 3 });
      expect(report.mana_model.coverage).toMatchObject({
        overridden_quantity: 3,
        supported_quantity: 0,
      });
      expect(report.mana_model.cards[0]?.assumptions.join(" ")).toContain(
        "all payments are creature spells",
      );
      expect(store.get("d")).toEqual(before);
      const plain = reportSchema.parse((await simulate(args)).structuredContent);
      expect(plain.mana_model.coverage.overridden_quantity).toBe(0);
      expect(plain.mana_model.coverage.unsupported_quantity).toBe(3);
      expect(plain.sequence).toMatchObject({ status: "failure", target_cast_turn: null });
      expect(plain.sequence.reasons.join(" ")).toContain("does not prove");
    });

    it("preserves default aggregate simulations and read-only discovery annotations", async () => {
      const result = await client.callTool({
        name: "simulate_deck",
        arguments: { deck_id: "d", trials: 20, seed: 5 },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        deck_id: "d",
        mode: "aggregate",
        trials: 20,
      });
      const tool = (await client.listTools()).tools.find((entry) => entry.name === "simulate_deck");
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(tool?.outputSchema).toBeUndefined();
    });

    it("distinguishes unavailable aggregate metrics from measured failure when every trial is truncated", async () => {
      const result = await client.callTool({
        name: "simulate_deck",
        arguments: { deck_id: "d", trials: 20, seed: 5, max_work: 1 },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        mode: "aggregate",
        first_spell_rate: 0,
        sequencing: { metrics_available: false, completed_trials: 0 },
      });
      const report = z
        .object({ sequencing: z.object({ truncated_trials: z.number() }) })
        .parse(result.structuredContent);
      expect(report.sequencing.truncated_trials).toBeGreaterThan(0);
      expect(result.content).toContainEqual({
        type: "text",
        text: JSON.stringify(result.structuredContent),
      });
    });

    it("rejects malformed bounds and targets before running a sequence", async () => {
      const before = structuredClone(store.get("d"));
      for (const invalid of [
        { mode: "optimal" },
        { max_work: 0 },
        { max_work: 50001 },
        { max_work: 1.5 },
        { max_turns: 0 },
        { hand_size: 21 },
        { expected_version: -1 },
        { target: { oracle_id: "Chief", face_index: 2 } },
        { target: { oracle_id: "Chief", zone: "sideboard" } },
        {
          overrides: Array.from({ length: 201 }, () => ({
            oracle_id: "Chief",
            face_index: 0,
            reason: "scenario",
            mana_cost: "{0}",
          })),
        },
        { overrides: [{ oracle_id: "Chief", face_index: 0, reason: "", mana_cost: "{0}" }] },
      ])
        expect(await simulate(invalid)).toMatchObject({ isError: true });
      expect(store.get("d")).toEqual(before);
    });

    it("rejects stale versions and keeps another principal's deck private", async () => {
      const before = store.get("d");
      if (!before) throw new Error("Missing test deck");
      store.update("d", (deck) => ({ ...deck, name: "Changed" }));
      const changed = structuredClone(store.get("d"));
      const stale = await simulate({ expected_version: before.version });
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
      expect(await simulate({ deck_id: "missing" })).toMatchObject({
        isError: true,
        structuredContent: { code: "DECK_NOT_FOUND" },
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
            name: "simulate_deck",
            arguments: { deck_id: "d", mode: "sequence" },
          }),
        ).toMatchObject({
          isError: true,
          structuredContent: { code: "DECK_NOT_FOUND" },
        });
      } finally {
        await other.close();
      }
      expect(store.get("d")).toEqual(changed);
    });
  },
);
