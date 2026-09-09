import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { DeckStore } from "../deck/index.js";
import { MECHANICS_EXTRACTOR_VERSION } from "../types/index.js";
import { createServer } from "./createServer.js";
import { startHttp } from "./http.js";
import { staticSnapshotProvider } from "./snapshot.js";

const SNAPSHOT = "2026-09-08";
const ORACLE = [
  {
    id: "p-ring",
    oracle_id: "o-ring",
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
  {
    id: "p-devil",
    oracle_id: "o-devil",
    name: "Mayhem Devil",
    layout: "normal",
    cmc: 3,
    type_line: "Creature — Devil",
    oracle_text:
      "Whenever a player sacrifices a permanent, Mayhem Devil deals 1 damage to any target.",
    colors: ["B", "R"],
    color_identity: ["B", "R"],
    legalities: { commander: "legal" },
  },
  {
    id: "p-modal",
    oracle_id: "o-modal",
    name: "Bala Ged Recovery // Bala Ged Sanctuary",
    layout: "modal_dfc",
    cmc: 3,
    color_identity: ["G"],
    legalities: { commander: "legal" },
    card_faces: [
      {
        name: "Bala Ged Recovery",
        mana_cost: "{2}{G}",
        type_line: "Sorcery",
        oracle_text: "Return target card from your graveyard to your hand.",
        colors: ["G"],
      },
      {
        name: "Bala Ged Sanctuary",
        mana_cost: "",
        type_line: "Land",
        oracle_text:
          "As Bala Ged Sanctuary enters, you may pay 3 life. If you don't, it enters tapped.\n{T}: Add {G}.",
        colors: [],
      },
    ],
  },
  {
    id: "p-chief",
    oracle_id: "o-chief",
    name: "Test Commander",
    layout: "normal",
    cmc: 3,
    type_line: "Legendary Creature — Human",
    oracle_text: "Whenever you cast a spell, draw a card.",
    colors: ["U"],
    color_identity: ["U"],
    legalities: { commander: "legal" },
  },
  { oracle_id: "o-sparse", name: "Incomplete source card" },
];

const annotationSchema = z
  .object({
    status: z.literal("supported"),
    pattern_id: z.string(),
    category: z.string(),
    kind: z.string(),
    subject: z.string(),
    face_index: z.number().nullable(),
    condition: z.object({ kind: z.string(), text: z.string().nullable() }),
    provenance: z.enum(["explicit", "inferred"]),
    extractor_version: z.string(),
    evidence: z.object({
      oracle_id: z.string(),
      field_path: z.string(),
      start: z.number(),
      end: z.number(),
      text: z.string(),
    }),
  })
  .passthrough();

const body = z.object({
  extractor_version: z.string(),
  supported_patterns: z.array(z.string()),
  deck_id: z.string().nullable(),
  cards: z.array(
    z
      .object({
        oracle_id: z.string(),
        name: z.string(),
        source: z.enum(["gameplay_faces", "flat_oracle_text"]),
        legality: z.literal("not_evaluated"),
        annotations: z.array(annotationSchema),
        unmodeled: z.array(z.object({ status: z.enum(["unmodeled", "uncertain"]) }).passthrough()),
        coverage: z
          .object({ abilities_total: z.number(), sentences_unmodeled: z.number() })
          .passthrough(),
        roles: z.object({
          inferred_roles: z.array(z.string()),
          effective_roles: z.array(z.string()),
          role_source: z.enum(["classifier", "user_override"]),
        }),
      })
      .passthrough(),
  ),
  missing: z.array(z.string()),
  data_snapshot: z.string(),
});

async function buildTestIndex(root: string): Promise<CardIndex> {
  const store = new VersionedStore(root);
  await store.createVersion(SNAPSHOT);
  await writeFile(store.filePath(SNAPSHOT, "oracle_cards.json"), JSON.stringify(ORACLE));
  await writeFile(store.filePath(SNAPSHOT, "default_cards.json"), "[]");
  await store.publish(SNAPSHOT);
  return CardIndex.open((await buildIndex({ store })).dbPath);
}

describe.each(["2026-07-28", "2024-11-05"] as const)(
  "public card_mechanics over protocol %s",
  (revision) => {
    let root: string;
    let index: CardIndex;
    let client: Client;
    let running: Awaited<ReturnType<typeof startHttp>>;

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "mtg-mechanics-"));
      index = await buildTestIndex(root);
      running = await startHttp({ index, snapshot: staticSnapshotProvider(SNAPSHOT) });
      client = new Client(
        { name: "mechanics-test", version: "1.0.0" },
        {
          supportedProtocolVersions: [revision],
          versionNegotiation: {
            mode: revision === "2026-07-28" ? { pin: revision } : "legacy",
          },
        },
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)),
      );
    });

    afterEach(async () => {
      await client.close();
      await running.close();
      index.close();
      await rm(root, { recursive: true, force: true });
    });

    it("returns inspectable evidence per card and face with a JSON text fallback", async () => {
      const result = await client.callTool({
        name: "card_mechanics",
        arguments: { cards: ["Sol Ring", "o-devil", "o-modal", "o-sparse", "o-nope"] },
      });
      expect(result.isError).not.toBe(true);
      const parsed = body.parse(result.structuredContent);
      expect(parsed.data_snapshot).toBe(SNAPSHOT);
      expect(parsed.extractor_version).toBe(MECHANICS_EXTRACTOR_VERSION);
      expect(parsed.supported_patterns).toContain("trigger.sacrifice");
      expect(parsed.missing).toEqual(["o-nope"]);
      expect(parsed.deck_id).toBeNull();
      expect(result.content).toContainEqual({
        type: "text",
        text: JSON.stringify(result.structuredContent),
      });

      const [ring, devil, modal, sparse] = parsed.cards;
      expect(ring?.source).toBe("gameplay_faces");
      const tap = ring?.annotations.find((a) => a.pattern_id === "cost.tap");
      expect(tap).toMatchObject({
        face_index: 0,
        subject: "self",
        condition: { kind: "unconditional", text: null },
        provenance: "inferred",
        extractor_version: MECHANICS_EXTRACTOR_VERSION,
        evidence: { oracle_id: "o-ring", field_path: "/oracle_text", text: "{T}" },
      });
      expect(ring?.roles).toEqual({
        inferred_roles: ["ramp", "mana_rock"],
        effective_roles: ["ramp", "mana_rock"],
        role_source: "classifier",
      });
      expect(ring?.legality).toBe("not_evaluated");
      expect(Object.keys(ring ?? {})).not.toContain("legalities");

      expect(devil?.annotations.map((a) => `${a.pattern_id}|${a.subject}`)).toEqual([
        "trigger.sacrifice|any_player",
        "effect.deal_damage|any_player",
      ]);

      const mana = modal?.annotations.find((a) => a.pattern_id === "effect.add_mana");
      expect(mana?.face_index).toBe(1);
      expect(mana?.evidence.field_path).toBe("/card_faces/1/oracle_text");
      const recovery = modal?.annotations.find(
        (a) => a.pattern_id === "effect.return_from_graveyard",
      );
      expect(recovery?.face_index).toBe(0);
      expect(modal?.unmodeled.some((u) => u.status === "unmodeled")).toBe(true);

      expect(sparse?.annotations).toEqual([]);
      expect(sparse?.coverage.abilities_total).toBe(0);
    });

    it("omits reported spans on request while keeping coverage counts", async () => {
      const result = await client.callTool({
        name: "card_mechanics",
        arguments: { cards: "o-modal", include_unmodeled: false },
      });
      const parsed = body.parse(result.structuredContent);
      expect(parsed.cards[0]?.unmodeled).toEqual([]);
      expect(parsed.cards[0]?.coverage.sentences_unmodeled).toBeGreaterThan(0);
    });

    it("leaves card_get legality untouched", async () => {
      const result = await client.callTool({
        name: "card_get",
        arguments: { cards: "Sol Ring", compact: true },
      });
      const parsed = z
        .object({ cards: z.array(z.object({ legalities: z.record(z.string(), z.string()) })) })
        .parse(result.structuredContent);
      expect(parsed.cards[0]?.legalities.commander).toBe("legal");
    });
  },
);

describe("card_mechanics deck role overlay", () => {
  let root: string;
  let index: CardIndex;
  let store: DeckStore;
  let client: Client;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "mtg-mechanics-deck-"));
    index = await buildTestIndex(root);
    let counter = 0;
    store = new DeckStore({ newId: () => `deck-${++counter}` });
    const server = createServer({ index, deckStore: store });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "mechanics-deck-test", version: "1" });
    await client.connect(clientTransport);
    store.create({ name: "Overlay test", commanders: ["o-chief"], computedColorIdentity: ["U"] });
  });

  afterEach(async () => {
    await client.close();
    index.close();
    await rm(root, { recursive: true, force: true });
  });

  it("reports deck role corrections through the shared role evidence shape", async () => {
    const version = store.get("deck-1")?.version ?? 0;
    const set = await client.callTool({
      name: "deck_set_roles",
      arguments: {
        deck_id: "deck-1",
        card: "Test Commander",
        roles: ["card_draw", "payoff"],
        expected_version: version,
      },
    });
    expect(set.isError).not.toBe(true);

    const withDeck = body.parse(
      (
        await client.callTool({
          name: "card_mechanics",
          arguments: { cards: "Test Commander", deck_id: "deck-1" },
        })
      ).structuredContent,
    );
    expect(withDeck.deck_id).toBe("deck-1");
    expect(withDeck.cards[0]?.roles).toEqual({
      inferred_roles: ["card_draw", "card_advantage"],
      effective_roles: ["card_draw", "payoff"],
      role_source: "user_override",
    });
    expect(withDeck.cards[0]?.annotations.map((a) => a.pattern_id)).toEqual([
      "trigger.cast_spell",
      "effect.draw_cards",
    ]);

    const withoutDeck = body.parse(
      (await client.callTool({ name: "card_mechanics", arguments: { cards: "Test Commander" } }))
        .structuredContent,
    );
    expect(withoutDeck.cards[0]?.roles.role_source).toBe("classifier");
    expect(withoutDeck.cards[0]?.roles.effective_roles).toEqual(["card_draw", "card_advantage"]);
  });

  it("rejects an unknown deck without touching the card report", async () => {
    const result = await client.callTool({
      name: "card_mechanics",
      arguments: { cards: "Sol Ring", deck_id: "deck-404" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("DECK_NOT_FOUND");
  });
});
