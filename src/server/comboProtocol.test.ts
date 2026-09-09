import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { DeckStore } from "../deck/index.js";
import { CacheStore, GameChangersClient, SpellbookClient } from "../meta/index.js";
import {
  SPELLBOOK_RESPONSE_FIXTURE,
  SPELLBOOK_VARIANT_FIXTURE,
} from "../meta/spellbook.fixture.js";
import { startHttp } from "./http.js";
import { staticSnapshotProvider } from "./snapshot.js";

const SNAPSHOT = "2026-09-08";
const ORACLE = [
  {
    oracle_id: "fixture-oracle-id",
    id: "p-faces",
    name: "Front // Back",
    layout: "transform",
    cmc: 2,
    color_identity: ["U"],
    legalities: { commander: "legal" },
    card_faces: [
      {
        name: "Front",
        mana_cost: "{1}{U}",
        type_line: "Legendary Creature — Wizard",
        oracle_text: "",
        colors: ["U"],
        power: "1",
        toughness: "1",
      },
      {
        name: "Back",
        mana_cost: "",
        type_line: "Legendary Enchantment",
        oracle_text: "",
        colors: ["U"],
      },
    ],
  },
  {
    oracle_id: "o-sol",
    id: "p-sol",
    name: "Sol Ring",
    layout: "normal",
    cmc: 1,
    mana_cost: "{1}",
    type_line: "Artifact",
    oracle_text: "{T}: Add {C}{C}.",
    colors: [],
    color_identity: [],
    legalities: { commander: "legal" },
  },
];

const RESPONSE = {
  ...SPELLBOOK_RESPONSE_FIXTURE,
  results: {
    ...SPELLBOOK_RESPONSE_FIXTURE.results,
    included: [
      {
        ...SPELLBOOK_VARIANT_FIXTURE,
        uses: SPELLBOOK_VARIANT_FIXTURE.uses.map((ingredient) => ({ ...ingredient, quantity: 1 })),
      },
    ],
  },
};

describe.each(["2026-07-28", "2024-11-05"] as const)(
  "combo evidence over protocol %s",
  (revision) => {
    let root: string;
    let index: CardIndex;
    let client: Client;
    let running: Awaited<ReturnType<typeof startHttp>>;
    let offline: boolean;
    let requests: Array<{ url: string; init?: RequestInit }>;

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "mtg-combo-protocol-"));
      const store = new VersionedStore(root);
      await store.createVersion(SNAPSHOT);
      await writeFile(store.filePath(SNAPSHOT, "oracle_cards.json"), JSON.stringify(ORACLE));
      await writeFile(store.filePath(SNAPSHOT, "default_cards.json"), "[]");
      await store.publish(SNAPSHOT);
      index = CardIndex.open((await buildIndex({ store })).dbPath);
      const deckStore = new DeckStore({ newId: () => "deck-combo" });
      offline = false;
      requests = [];
      running = await startHttp({
        index,
        deckStore,
        snapshot: staticSnapshotProvider(SNAPSHOT),
        spellbook: new SpellbookClient(new CacheStore({ now: () => 1000 }), {
          fetchJson: async (url, init) => {
            requests.push({ url, init });
            if (offline) throw new Error("offline");
            return RESPONSE;
          },
        }),
        gameChangers: new GameChangersClient(new CacheStore(), { fetchJson: async () => [] }),
      });
      client = new Client(
        { name: "combo-protocol-test", version: "1.0.0" },
        {
          supportedProtocolVersions: [revision],
          versionNegotiation: { mode: revision === "2026-07-28" ? { pin: revision } : "legacy" },
        },
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)),
      );
      await client.callTool({ name: "deck_create", arguments: { name: "Combo evidence" } });
      deckStore.update("deck-combo", (deck) => ({
        ...deck,
        commanders: ["fixture-oracle-id"],
        cards: [{ oracle_id: "o-sol", qty: 3 }],
      }));
    });

    afterEach(async () => {
      await client.close();
      await running.close();
      index.close();
      await rm(root, { recursive: true, force: true });
    });

    it("preserves prerequisite and canonical face evidence in structured and JSON text results", async () => {
      expect(client.getProtocolEra()).toBe(revision === "2026-07-28" ? "modern" : "legacy");
      const result = await client.callTool({
        name: "meta_combos",
        arguments: { deck_id: "deck-combo" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        data_snapshot: SNAPSHOT,
        included_count: 1,
        almost_count: 0,
        category_counts: { included: 1, included_by_changing_commanders: 0, almost_included: 0 },
        coverage: { status: "complete", provider_non_exhaustive: true },
        freshness: { status: "fresh", age_ms: 0 },
        combos: [
          {
            id: "fixture-commander-loop",
            url: "https://commanderspellbook.com/combo/fixture-commander-loop/",
            source_url: "https://backend.commanderspellbook.com/find-my-combos",
            provider_category: "included",
            confidence: "included",
            pieces: ["Front // Back"],
            produces: ["Infinite mana"],
            steps: "1. Activate the ability.\n2. Repeat.",
            mana_needed: "{2}{U}",
            mana_value_needed: 3,
            easy_prerequisites: "You control a creature.",
            notable_prerequisites: "Your life total is at least 5.",
            notes: "Each iteration requires an available target.",
            uses: [
              {
                quantity: 1,
                used_face: 2,
                must_be_commander: true,
                zone_locations: ["B", "G"],
                battlefield_card_state: "Untapped and without summoning sickness.",
                graveyard_card_state: "Above all other cards.",
              },
            ],
            requires: [
              {
                template: {
                  name: "A creature that can sacrifice itself",
                  scryfall_query: "t:creature o:sacrifice",
                },
                quantity: 1,
              },
            ],
            outputs: [
              { feature: { id: 301, name: "Infinite mana", uncountable: true }, quantity: 1 },
            ],
            applicability: {
              listed_pieces_present: "satisfied",
              deck_configuration: "unknown",
              setup_prerequisites: "unknown",
              executable_now: "unknown",
              ingredients: [
                {
                  oracle_id: "fixture-oracle-id",
                  required_quantity: 1,
                  available_quantity: 1,
                  missing_quantity: 0,
                  commander_requirement: "satisfied",
                  face_requirement: "satisfied",
                  face: { face_index: 1, source_path: "/card_faces/1", name: "Back" },
                },
              ],
            },
          },
        ],
      });
      expect(result.content).toContainEqual({
        type: "text",
        text: JSON.stringify(result.structuredContent),
      });
      expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
        commanders: [{ card: "Front // Back", quantity: 1 }],
        main: [{ card: "Sol Ring", quantity: 3 }],
      });
      const bracket = await client.callTool({
        name: "meta_classify_bracket",
        arguments: { deck_id: "deck-combo" },
      });
      expect(bracket.structuredContent).toMatchObject({
        data_snapshot: SNAPSHOT,
        provisional: true,
        pushers: { combos: [] },
        combo_evidence: {
          status: "available",
          candidate_count: 1,
          supported_count: 0,
          unknown_count: 1,
          absence_confirmed: false,
          freshness: { status: "cached" },
        },
      });
      expect(bracket.content).toContainEqual({
        type: "text",
        text: JSON.stringify(bracket.structuredContent),
      });
    });

    it("preserves lookup failures and provisional bracket evidence through the transport", async () => {
      offline = true;
      const combos = await client.callTool({
        name: "meta_combos",
        arguments: { deck_id: "deck-combo" },
      });
      expect(combos.isError).toBe(true);
      expect(combos.structuredContent).toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
        data_snapshot: SNAPSHOT,
      });
      expect(combos.content).toContainEqual({
        type: "text",
        text: JSON.stringify(combos.structuredContent),
      });
      const bracket = await client.callTool({
        name: "meta_classify_bracket",
        arguments: { deck_id: "deck-combo" },
      });
      expect(bracket.isError).not.toBe(true);
      expect(bracket.structuredContent).toMatchObject({
        data_snapshot: SNAPSHOT,
        provisional: true,
        combo_evidence: {
          status: "unavailable",
          absence_confirmed: false,
          error: { code: "UPSTREAM_UNAVAILABLE" },
        },
      });
      expect(bracket.content).toContainEqual({
        type: "text",
        text: JSON.stringify(bracket.structuredContent),
      });
    });
  },
);
