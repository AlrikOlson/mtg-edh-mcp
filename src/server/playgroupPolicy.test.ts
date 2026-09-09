import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { DeckStore } from "../deck/index.js";
import { CacheStore, SpellbookClient } from "../meta/index.js";
import {
  SPELLBOOK_RESPONSE_FIXTURE,
  SPELLBOOK_VARIANT_FIXTURE,
} from "../meta/spellbook.fixture.js";
import { startHttp, PRINCIPAL_HEADER } from "./http.js";
import { staticSnapshotProvider } from "./snapshot.js";

const SNAPSHOT = "2026-09-08";
const ORACLE = [
  {
    oracle_id: "leader",
    name: "Policy Commander",
    type_line: "Legendary Creature — Wizard",
    cmc: 3,
    oracle_text: "",
    color_identity: ["U"],
    power: "2",
    toughness: "2",
  },
  {
    oracle_id: "rift",
    name: "Cyclonic Rift",
    type_line: "Instant",
    cmc: 2,
    oracle_text: "Return target nonland permanent you don't control to its owner's hand.",
    color_identity: ["U"],
    game_changer: true,
  },
  {
    oracle_id: "island",
    name: "Island",
    type_line: "Basic Land — Island",
    cmc: 0,
    oracle_text: "({T}: Add {U}.)",
    color_identity: ["U"],
  },
].map((card) => ({
  ...card,
  id: "p-" + card.oracle_id,
  layout: "normal",
  colors: card.color_identity,
  legalities: { commander: "legal" },
}));

describe.each(["2026-07-28", "2024-11-05"] as const)("playgroup policy over %s", (revision) => {
  let root: string;
  let index: CardIndex;
  let store: DeckStore;
  let client: Client;
  let running: Awaited<ReturnType<typeof startHttp>>;
  let now: number;
  let offline: boolean;
  let requests: number;
  let response: unknown;
  let pause: Promise<void> | undefined;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "mtg-policy-"));
    const data = new VersionedStore(root);
    await data.createVersion(SNAPSHOT);
    await writeFile(data.filePath(SNAPSHOT, "oracle_cards.json"), JSON.stringify(ORACLE));
    await writeFile(data.filePath(SNAPSHOT, "default_cards.json"), "[]");
    await data.publish(SNAPSHOT);
    index = CardIndex.open((await buildIndex({ store: data })).dbPath);
    store = new DeckStore({ newId: () => "policy-deck" });
    store.create({
      name: "Legal policy fixture",
      commanders: ["leader"],
      computedColorIdentity: ["U"],
    });
    store.update("policy-deck", (deck) => ({
      ...deck,
      cards: [
        { oracle_id: "rift", qty: 1 },
        { oracle_id: "island", qty: 98 },
      ],
    }));
    now = 1000;
    offline = false;
    requests = 0;
    pause = undefined;
    response = structuredClone(SPELLBOOK_RESPONSE_FIXTURE);
    running = await startHttp({
      index,
      deckStore: store,
      snapshot: staticSnapshotProvider(SNAPSHOT),
      spellbook: new SpellbookClient(new CacheStore({ now: () => now }), {
        ttlMs: 10,
        fetchJson: async () => {
          requests++;
          await pause;
          if (offline) throw new Error("offline");
          return response;
        },
      }),
    });
    client = new Client(
      { name: "policy-acceptance", version: "1" },
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
  function version() {
    const deck = store.get("policy-deck");
    if (!deck) throw new Error("Missing fixture");
    return deck.version;
  }
  async function set(playgroup: Record<string, unknown>, hard?: Record<string, unknown>) {
    const result = await client.callTool({
      name: "deck_set_intent",
      arguments: {
        deck_id: "policy-deck",
        expected_version: version(),
        action: "set",
        intent: { schema_version: 1, playgroup, ...(hard ? { hard } : {}) },
      },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      intent: { playgroup },
    });
    return result;
  }
  async function check(extra: Record<string, unknown> = {}) {
    const result = await client.callTool({
      name: "meta_check_policy",
      arguments: { deck_id: "policy-deck", ...extra },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.content).toContainEqual({
      type: "text",
      text: JSON.stringify(result.structuredContent),
    });
    return result;
  }
  it("discovers a read-only tool and reports no declaration without inventing one", async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.find((tool) => tool.name === "meta_check_policy")).toMatchObject({
      annotations: { readOnlyHint: true, openWorldHint: true },
    });
    const before = store.dump();
    const result = await check();
    expect(result.structuredContent).toMatchObject({
      deck_id: "policy-deck",
      deck_version: version(),
      data_snapshot: SNAPSHOT,
      status: "unknown",
      declared: false,
    });
    expect(store.dump()).toEqual(before);
    expect(requests).toBe(0);
  });
  it("changes compatibility for the same legal deck and preserves rules legality", async () => {
    const validate = () =>
      client.callTool({
        name: "validate_deck",
        arguments: { deck_id: "policy-deck" },
      });
    const before = await validate();
    expect(before.structuredContent).toMatchObject({
      ok: true,
      error_count: 0,
      errors: [],
    });
    await set({ profile: "casual", bracket: 2 });
    const low = await check();
    expect(low.structuredContent).toMatchObject({
      status: "incompatible",
      declared: true,
    });
    expect(JSON.stringify(low.structuredContent)).toContain("Cyclonic Rift");
    expect(JSON.stringify(low.structuredContent)).toContain("magic.wizards.com");
    await set({ profile: "competitive", bracket: 5 });
    expect((await check()).structuredContent).toMatchObject({
      status: "compatible",
      declared: true,
    });
    expect((await validate()).structuredContent).toEqual(before.structuredContent);
  });
  it("preserves custom overrides, locks and exclusions for downstream planners", async () => {
    await set(
      { profile: "thematic", bracket: 2, limits: { game_changers: 1 } },
      {
        locked_cards: [{ oracle_id: "Cyclonic Rift", qty: 1 }],
        excluded_cards: ["Island"],
      },
    );
    const result = await check();
    expect(result.structuredContent).toMatchObject({
      status: "incompatible",
    });
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).toContain('"locked_cards":[{"oracle_id":"rift","qty":1}]');
    expect(serialized).toContain('"excluded_cards":["island"]');
    expect(serialized).toContain("custom");
    expect(serialized).toContain("thematic");
  });
  it("returns version conflicts before provider calls and rejects another principal", async () => {
    await set({ bracket: 3 });
    const before = requests;
    const conflict = await check({ expected_version: version() - 1 });
    expect(conflict.structuredContent).toMatchObject({
      ok: false,
      conflict: true,
      current_version: version(),
      expected_version: version() - 1,
    });
    expect(requests).toBe(before);
    const other = new Client({ name: "policy-other", version: "1" });
    try {
      await other.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`), {
          requestInit: { headers: { [PRINCIPAL_HEADER]: "other" } },
        }),
      );
      expect(
        await other.callTool({
          name: "meta_check_policy",
          arguments: { deck_id: "policy-deck" },
        }),
      ).toMatchObject({
        isError: true,
        structuredContent: { code: "DECK_NOT_FOUND" },
      });
    } finally {
      await other.close();
    }
  });
  it("reports cold provider failures, stale observations and incomplete list evidence without proving absence", async () => {
    await set({
      profile: "custom",
      limits: { infinite_combos: 0, game_changers: 3 },
    });
    offline = true;
    const cold = await check();
    expect(cold.structuredContent).toMatchObject({ status: "unknown" });
    expect(JSON.stringify(cold.structuredContent)).toContain("UPSTREAM_UNAVAILABLE");
    offline = false;
    const fresh = await check();
    expect(fresh.structuredContent).toMatchObject({ status: "unknown" });
    expect(JSON.stringify(fresh.structuredContent)).toContain('"absence_confirmed":false');
    now += 20;
    offline = true;
    const stale = await check();
    expect(stale.structuredContent).toMatchObject({ status: "unknown" });
    expect(JSON.stringify(stale.structuredContent)).toContain('"status":"stale"');
    expect(JSON.stringify(stale.structuredContent)).toContain('"complete":false');
  });
  it("bounds combo evidence without changing evaluated counts or hiding truncation", async () => {
    await set({ profile: "custom", limits: { infinite_combos: 0 } });
    response = {
      ...SPELLBOOK_RESPONSE_FIXTURE,
      results: {
        ...SPELLBOOK_RESPONSE_FIXTURE.results,
        included: Array.from({ length: 3 }, (_, i) => ({
          ...SPELLBOOK_VARIANT_FIXTURE,
          id: "variant-" + i,
        })),
      },
    };
    const result = await check({ limit: 1 });
    expect(result.structuredContent).toMatchObject({
      status: "unknown",
      evidence: { combos: { candidate_count: 3 } },
      findings: expect.arrayContaining([
        expect.objectContaining({
          category: "infinite_combos",
          combo_candidate_count: 3,
          combo_candidates_truncated: true,
          combo_candidates: [expect.objectContaining({ id: "variant-0" })],
        }),
      ]),
    });
    const expanded = await check({ limit: 3 });
    expect(expanded.structuredContent).toMatchObject({
      status: "unknown",
      findings: expect.arrayContaining([
        expect.objectContaining({
          category: "infinite_combos",
          combo_candidate_count: 3,
          combo_candidates_truncated: false,
        }),
      ]),
    });
  });
  it("captures one deck version across an asynchronous provider lookup", async () => {
    await set({ profile: "casual", bracket: 2 });
    const captured = version();
    let release: () => void = () => {};
    pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = check({ expected_version: captured });
    void pending.catch(() => {});
    // The request may not have entered the server yet; wait for its provider.
    for (let i = 0; i < 100 && requests === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(requests).toBeGreaterThan(0);
    store.update("policy-deck", (deck) => ({
      ...deck,
      intent: {
        schema_version: 1,
        playgroup: { profile: "competitive", bracket: 5 },
      },
    }));
    release();
    const result = await pending;
    expect(result.structuredContent).toMatchObject({
      deck_version: captured,
      status: "incompatible",
    });
  });
});
