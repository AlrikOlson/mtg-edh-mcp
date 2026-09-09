import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { startHttp } from "./http.js";
import { staticSnapshotProvider } from "./snapshot.js";

const SNAPSHOT = "2026-09-08";
const ORACLE = [
  {
    id: "p-modal",
    oracle_id: "o-modal",
    name: "Tangled Florahedron // Tangled Vale",
    layout: "modal_dfc",
    cmc: 2,
    color_identity: ["G"],
    legalities: { commander: "legal" },
    card_faces: [
      {
        name: "Tangled Florahedron",
        mana_cost: "{1}{G}",
        type_line: "Creature — Elemental",
        oracle_text: "{T}: Add {G}.",
        colors: ["G"],
        power: "1",
        toughness: "1",
      },
      {
        name: "Tangled Vale",
        mana_cost: "",
        type_line: "Land",
        oracle_text: "Tangled Vale enters tapped.\n{T}: Add {G}.",
        colors: [],
      },
    ],
  },
  {
    id: "p-ring",
    oracle_id: "o-ring",
    name: "Sol Ring",
    layout: "normal",
    cmc: 1,
    mana_cost: "{1}",
    type_line: "Artifact",
    oracle_text: "{T}: Add {C}{C}.",
    produced_mana: ["C"],
    colors: [],
    color_identity: [],
    legalities: { commander: "legal" },
  },
  { oracle_id: "o-sparse", name: "Incomplete source card" },
];

const cardBody = z.object({
  cards: z.array(
    z.object({ oracle_id: z.string(), gameplay: z.record(z.string(), z.unknown()) }).passthrough(),
  ),
  missing: z.array(z.string()),
  data_snapshot: z.string(),
});

describe.each(["2026-07-28", "2024-11-05"] as const)(
  "public card face evidence over protocol %s",
  (revision) => {
    let root: string;
    let index: CardIndex;
    let client: Client;
    let running: Awaited<ReturnType<typeof startHttp>>;

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "mtg-card-faces-"));
      const store = new VersionedStore(root);
      await store.createVersion(SNAPSHOT);
      await writeFile(store.filePath(SNAPSHOT, "oracle_cards.json"), JSON.stringify(ORACLE));
      await writeFile(store.filePath(SNAPSHOT, "default_cards.json"), "[]");
      await store.publish(SNAPSHOT);
      index = CardIndex.open((await buildIndex({ store })).dbPath);
      running = await startHttp({ index, snapshot: staticSnapshotProvider(SNAPSHOT) });
      client = new Client(
        { name: "card-faces-test", version: "1.0.0" },
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

    it.each([false, true])(
      "retains ordered face evidence in structured, text, and resource output (compact=%s)",
      async (compact) => {
        const result = await client.callTool({
          name: "card_get",
          arguments: { cards: ["o-modal", "o-ring", "o-sparse"], compact },
        });
        expect(result.isError).not.toBe(true);
        const body = cardBody.parse(result.structuredContent);
        expect(body.data_snapshot).toBe(SNAPSHOT);
        expect(body.missing).toEqual([]);
        expect(result.content).toContainEqual({
          type: "text",
          text: JSON.stringify(result.structuredContent),
        });

        const modal = body.cards[0];
        assert(modal);
        expect(modal.gameplay).toMatchObject({
          version: 1,
          layout: "modal_dfc",
          source: { scryfall_id: "p-modal", oracle_id: "o-modal" },
          face_relationship: "modal",
          playability: "not_evaluated",
          faces: [
            {
              face_index: 0,
              source_path: "/card_faces/0",
              characteristics: { name: "Tangled Florahedron", mana_cost: "{1}{G}" },
            },
            {
              face_index: 1,
              source_path: "/card_faces/1",
              characteristics: { name: "Tangled Vale", mana_cost: "", type_line: "Land" },
            },
          ],
        });
        // Compatibility projections remain available alongside the source evidence.
        expect(modal.mana_cost).toBe("{1}{G} // ");
        expect(modal.type_line).toBe("Creature — Elemental // Land");
        expect(modal.mv).toBe(2);
        expect(body.cards[1]?.gameplay).toMatchObject({
          layout: "normal",
          characteristics: { produced_mana: ["C"] },
          playability: "not_evaluated",
        });

        for (const card of body.cards) {
          const resource = await client.readResource({ uri: `card://${card.oracle_id}` });
          const content = resource.contents[0];
          assert(content && "text" in content);
          const canonical = z
            .object({ gameplay: z.record(z.string(), z.unknown()) })
            .parse(JSON.parse(content.text));
          expect(card.gameplay).toEqual(canonical.gameplay);
          if (compact) {
            expect(card).not.toHaveProperty("printings");
            expect(card).not.toHaveProperty("prices");
          }
        }
      },
    );

    it("exposes absent source values as null through both card_get modes", async () => {
      for (const compact of [false, true]) {
        const result = await client.callTool({
          name: "card_get",
          arguments: { cards: "o-sparse", compact },
        });
        expect(cardBody.parse(result.structuredContent).cards[0]?.gameplay).toMatchObject({
          layout: null,
          source: { scryfall_id: null, oracle_id: "o-sparse" },
          characteristics: { mana_cost: null, oracle_text: null, colors: null },
          faces: null,
          related_cards: null,
          face_relationship: "unknown",
          playability: "not_evaluated",
        });
      }
    });
  },
);
