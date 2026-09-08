import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { DeckStore } from "../deck/index.js";
import { CacheStore, EdhrecClient } from "../meta/index.js";
import { createServer } from "./createServer.js";
import { staticSnapshotProvider } from "./snapshot.js";

const ORACLE = [
  {
    oracle_id: "o-talrand",
    id: "p-talrand",
    name: "Talrand, Sky Summoner",
    cmc: 4,
    colors: ["U"],
    color_identity: ["U"],
    type_line: "Legendary Creature — Merfolk Wizard",
    oracle_text: "Whenever you cast an instant or sorcery spell, create a 2/2 blue Drake.",
    legalities: { commander: "legal" },
    prices: { usd: "1.00" },
  },
  {
    oracle_id: "o-sol",
    id: "p-sol",
    name: "Sol Ring",
    cmc: 1,
    colors: [],
    color_identity: [],
    type_line: "Artifact",
    oracle_text: "{T}: Add {C}{C}.",
    legalities: { commander: "legal" },
    prices: { usd: "1.50" },
  },
  {
    oracle_id: "o-signet",
    id: "p-signet",
    name: "Arcane Signet",
    cmc: 2,
    colors: [],
    color_identity: [],
    type_line: "Artifact",
    oracle_text: "{T}: Add one mana of any color in your commander's color identity.",
    legalities: { commander: "legal" },
    prices: { usd: "1.00" },
  },
  {
    oracle_id: "o-bolt",
    id: "p-bolt",
    name: "Lightning Bolt",
    cmc: 1,
    colors: ["R"],
    color_identity: ["R"],
    type_line: "Instant",
    oracle_text: "Lightning Bolt deals 3 damage to any target.",
    legalities: { commander: "legal" },
    prices: { usd: "1.00" },
  },
  {
    oracle_id: "o-opt",
    id: "p-opt",
    name: "Opt",
    cmc: 1,
    colors: ["U"],
    color_identity: ["U"],
    type_line: "Instant",
    oracle_text: "Scry 1. Draw a card.",
    legalities: { commander: "legal" },
    prices: { usd: "0.25" },
  },
  {
    oracle_id: "o-mystery",
    id: "p-mystery",
    name: "Mystery Spell",
    cmc: 3,
    colors: ["U"],
    color_identity: ["U"],
    type_line: "Instant",
    oracle_text: "Draw two cards.",
    legalities: { commander: "legal" },
    prices: { usd: null },
  },
  ...["0.05", "0.10", "0.20"].map((usd) => ({
    oracle_id: `o-rock-${usd}`,
    id: `p-rock-${usd}`,
    name: `Rock ${usd}`,
    cmc: 1,
    colors: [],
    color_identity: [],
    type_line: "Artifact",
    oracle_text: "{T}: Add {C}.",
    legalities: { commander: "legal" },
    prices: { usd },
  })),
];

const EDHREC_PAGE = {
  container: {
    json_dict: {
      cardlists: [
        {
          header: "Top Cards",
          cardviews: [
            { name: "Sol Ring", inclusion: 900, synergy: 0.05 }, // already in deck
            { name: "Arcane Signet", inclusion: 800, synergy: 0.2 }, // on-color (colorless)
            { name: "Lightning Bolt", inclusion: 300, synergy: 0.5 }, // off-color R
            { name: "Nonexistent Card", inclusion: 10, synergy: 0.1 }, // unresolved
          ],
        },
      ],
    },
  },
  panels: { taglinks: [{ value: "Spellslinger" }, { value: "Counters" }] },
};

let root: string;
let index: CardIndex;
let deckStore: DeckStore;
let client: Client;
let edhrecPage: unknown;
let cacheNow: number;
let upstreamDown: boolean;

beforeEach(async () => {
  edhrecPage = EDHREC_PAGE;
  cacheNow = 1000;
  upstreamDown = false;
  root = await mkdtemp(path.join(tmpdir(), "mtg-meta-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
  await store.publish("v1");
  index = CardIndex.open((await buildIndex({ store })).dbPath);
  deckStore = new DeckStore({ newId: () => "deck-1" });

  const edhrec = new EdhrecClient(new CacheStore({ now: () => cacheNow }), {
    ttlMs: 100,
    fetchJson: async () => {
      if (upstreamDown) throw new Error("offline");
      return edhrecPage;
    },
  });
  const server = createServer({
    index,
    deckStore,
    edhrec,
    snapshot: staticSnapshotProvider("2026-06-27"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  // Mono-U Talrand deck already running Sol Ring.
  await client.callTool({
    name: "deck_create",
    arguments: { name: "Talrand" },
  });
  deckStore.update("deck-1", (d) => ({
    ...d,
    commanders: ["o-talrand"],
    computed_color_identity: ["U"],
    cards: [{ oracle_id: "o-sol", qty: 1 }],
  }));
});
afterEach(async () => {
  await client.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

describe("EDHREC meta tools", () => {
  it("registers exactly five meta_* tools (ergo-meta consolidation)", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    const meta = names.filter((n) => n.startsWith("meta_")).sort();
    expect(meta).toEqual([
      "meta_budget_swaps",
      "meta_classify_bracket",
      "meta_combos",
      "meta_commander_profile",
      "meta_recommend",
    ]);
  });

  it("meta_commander_profile parses cards + themes (limit + total_cards)", async () => {
    const res = await client.callTool({
      name: "meta_commander_profile",
      arguments: { commander: "Talrand, Sky Summoner" },
    });
    const r = res.structuredContent as {
      cards: unknown[];
      themes: string[];
      total_cards: number;
    };
    expect(r.cards).toHaveLength(4);
    expect(r.total_cards).toBe(4);
    expect(r.themes).toEqual(["Spellslinger", "Counters"]);

    const limited = await client.callTool({
      name: "meta_commander_profile",
      arguments: { commander: "Talrand, Sky Summoner", limit: 2 },
    });
    const lr = limited.structuredContent as {
      cards: unknown[];
      total_cards: number;
    };
    expect(lr.cards).toHaveLength(2);
    expect(lr.total_cards).toBe(4);
  });

  it("meta_recommend (default synergy rank) filters identity, excludes in-deck, reports unresolved", async () => {
    const res = await client.callTool({
      name: "meta_recommend",
      arguments: { deck_id: "deck-1" },
    });
    const r = res.structuredContent as {
      rank: string;
      suggestions: Array<{ oracle_id: string; name: string }>;
      unresolved: Array<{ name: string; reason: string }>;
    };
    expect(r.rank).toBe("synergy");
    const names = r.suggestions.map((x) => x.name);
    expect(names).toContain("Arcane Signet"); // colorless, not in deck
    expect(names).not.toContain("Sol Ring"); // already in deck
    expect(names).not.toContain("Lightning Bolt"); // off-color (R) for a mono-U deck
    expect(r.unresolved.map((u) => u.name)).toContain("Nonexistent Card");
  });

  it("meta_recommend returns DECK_NOT_FOUND for an unknown deck", async () => {
    const res = await client.callTool({
      name: "meta_recommend",
      arguments: { deck_id: "nope" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
  });

  it("degrades to UPSTREAM_UNAVAILABLE when EDHREC is down with nothing cached", async () => {
    const downEdhrec = new EdhrecClient(new CacheStore({ now: () => 1000 }), {
      fetchJson: async () => {
        throw new Error("offline");
      },
    });
    const server = createServer({ index, deckStore, edhrec: downEdhrec });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c2 = new Client({ name: "t2", version: "0.0.0" });
    await c2.connect(ct);
    const res = await c2.callTool({
      name: "meta_commander_profile",
      arguments: { commander: "Talrand, Sky Summoner" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    await c2.close();
  });
});

describe("meta_recommend rank:'inclusion' (the missing-staples mode)", () => {
  it("lists in-identity staples not in the deck, ranked by inclusion; reports unresolved", async () => {
    const res = await client.callTool({
      name: "meta_recommend",
      arguments: { deck_id: "deck-1", rank: "inclusion" },
    });
    const r = res.structuredContent as {
      commander: string;
      rank: string;
      suggestions: Array<{
        oracle_id: string;
        name: string;
        inclusion: number;
      }>;
      unresolved: Array<{ name: string; reason: string }>;
    };
    expect(r.commander).toBe("Talrand, Sky Summoner");
    expect(r.rank).toBe("inclusion");
    // Sol Ring is in-deck (excluded); Lightning Bolt is off-color (excluded);
    // Arcane Signet (colorless, on-color) is the missing staple. Nonexistent → unresolved.
    expect(r.suggestions.map((m) => m.name)).toEqual(["Arcane Signet"]);
    expect(r.suggestions[0]?.inclusion).toBe(800);
    expect(r.unresolved).toEqual([{ name: "Nonexistent Card", reason: "UNKNOWN_CARD" }]);
  });

  it("honors the min_inclusion threshold", async () => {
    const res = await client.callTool({
      name: "meta_recommend",
      arguments: { deck_id: "deck-1", rank: "inclusion", min_inclusion: 850 },
    });
    const r = res.structuredContent as { suggestions: unknown[] };
    expect(r.suggestions).toEqual([]); // Arcane Signet (800) is below the threshold
  });
});

describe("meta_budget_swaps (review #10 part 2)", () => {
  it("is registered", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("meta_budget_swaps");
  });

  it("suggests a cheaper same-role, in-identity replacement for an expensive card", async () => {
    // Make the deck's Sol Ring 'expensive' relative to the Arcane Signet candidate.
    deckStore.update("deck-1", (d) => ({
      ...d,
      cards: [{ oracle_id: "o-sol", qty: 1 }],
    }));
    const res = await client.callTool({
      name: "meta_budget_swaps",
      arguments: { deck_id: "deck-1" },
    });
    const r = res.structuredContent as {
      commander: string;
      swaps: Array<{
        out: { name: string };
        in: { name: string; cheapest_usd: number };
        roles_matched: string[];
        savings: number;
      }>;
      current_min_buy_usd: number;
      projected_min_buy_usd: number;
    };
    expect(r.swaps).toHaveLength(1);
    expect(r.swaps[0]?.out.name).toBe("Sol Ring");
    expect(r.swaps[0]?.in.name).toBe("Arcane Signet"); // cheaper ($1.00 < $1.50), shares a mana role, on-color
    expect(r.swaps[0]?.roles_matched.length).toBeGreaterThan(0);
    expect(r.swaps[0]?.savings).toBe(0.5);
    expect(r.current_min_buy_usd).toBe(1.5);
    expect(r.projected_min_buy_usd).toBe(1.0);
    // Lightning Bolt (off-color R) is never proposed.
    expect(r.swaps.every((s) => s.in.name !== "Lightning Bolt")).toBe(true);
  });

  it("returns DECK_NOT_FOUND for an unknown deck", async () => {
    const res = await client.callTool({
      name: "meta_budget_swaps",
      arguments: { deck_id: "x" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
  });
});

describe("explainable deck advice", () => {
  it.each([false, true])(
    "uses displayed cents for an exact budget target (cheaper candidate: %s)",
    async (hasCandidate) => {
      deckStore.update("deck-1", (d) => ({
        ...d,
        cards: [
          { oracle_id: "o-rock-0.10", qty: 1 },
          { oracle_id: "o-rock-0.20", qty: 1 },
        ],
      }));
      if (hasCandidate)
        edhrecPage = {
          container: {
            json_dict: {
              cardlists: [
                {
                  header: "Mana",
                  cardviews: [{ name: "Rock 0.05", inclusion: 1, synergy: 0.1 }],
                },
              ],
            },
          },
        };
      const result = (
        await client.callTool({
          name: "meta_budget_swaps",
          arguments: {
            deck_id: "deck-1",
            target_usd: 0.3,
          },
        })
      ).structuredContent;
      expect(result).toMatchObject({
        swaps: [],
        current_min_buy_usd: 0.3,
        projected_min_buy_usd: 0.3,
        target_met: true,
      });
    },
  );

  it("excludes a declared companion from addition and replacement candidates", async () => {
    deckStore.update("deck-1", (d) => ({ ...d, companion: "o-signet" }));
    expect(
      (await client.callTool({ name: "meta_recommend", arguments: { deck_id: "deck-1" } }))
        .structuredContent,
    ).toMatchObject({ suggestions: [] });
    expect(
      (await client.callTool({ name: "meta_budget_swaps", arguments: { deck_id: "deck-1" } }))
        .structuredContent,
    ).toMatchObject({ swaps: [] });
  });

  it("sorts actual synergy scores, distinguishes missing evidence and prices, and exposes stale provenance", async () => {
    edhrecPage = {
      container: {
        json_dict: {
          cardlists: [
            {
              header: "Test",
              cardviews: [
                { name: "Arcane Signet", inclusion: 800, synergy: 0.2 },
                { name: "Mystery Spell" },
                { name: "Opt", inclusion: 20, synergy: 0.9 },
              ],
            },
          ],
        },
      },
    };
    const request = { name: "meta_recommend", arguments: { deck_id: "deck-1" } };
    const first = (await client.callTool(request)).structuredContent as {
      suggestions: Array<{
        name: string;
        evidence: { synergy: number | null; inclusion: number | null };
        budget_impact: { delta_min_buy_usd: number | null };
        uncertainty: string[];
      }>;
      source: { fetched_at: string };
    };
    expect(first.suggestions.map((s) => s.name)).toEqual(["Opt", "Arcane Signet", "Mystery Spell"]);
    expect(first.suggestions[0]?.budget_impact.delta_min_buy_usd).toBe(0.25);
    expect(first.suggestions[2]?.evidence).toMatchObject({ synergy: null, inclusion: null });
    expect(first.suggestions[2]?.budget_impact.delta_min_buy_usd).toBeNull();
    expect(first.suggestions[2]?.uncertainty.length).toBeGreaterThan(0);
    cacheNow += 200;
    upstreamDown = true;
    const stale = await client.callTool(request);
    expect(stale.structuredContent).toMatchObject({
      data_snapshot: "2026-06-27",
      source: {
        status: "stale",
        refresh_failed: true,
        age_ms: 200,
        fetched_at: first.source.fetched_at,
      },
    });
    expect(stale.content).toContainEqual({
      type: "text",
      text: JSON.stringify(stale.structuredContent),
    });
  });

  it("explains role losses and mana tradeoffs using deck overrides without changing the index", async () => {
    deckStore.update("deck-1", (d) => ({
      ...d,
      role_overrides: { "o-sol": ["ramp", "protection"] },
    }));
    const result = (
      await client.callTool({ name: "meta_budget_swaps", arguments: { deck_id: "deck-1" } })
    ).structuredContent;
    expect(result).toMatchObject({
      swaps: [
        {
          out: {
            qty: 1,
            evidence: { role_source: "user_override", effective_roles: ["ramp", "protection"] },
          },
          in: { qty: 1, evidence: { role_source: "classifier" } },
          tradeoffs: { roles_lost: ["protection"], mana_value_delta: 1 },
          budget_impact: { delta_min_buy_usd: -0.5 },
        },
      ],
    });
    expect(index.getCard("o-sol")?.roles).not.toContain("protection");
    deckStore.update("deck-1", (d) => ({ ...d, role_overrides: { "o-sol": [] } }));
    expect(
      (await client.callTool({ name: "meta_budget_swaps", arguments: { deck_id: "deck-1" } }))
        .structuredContent,
    ).toMatchObject({ swaps: [] });
  });

  it("swaps only one copy and keeps unknown library costs from claiming a budget target", async () => {
    deckStore.update("deck-1", (d) => ({
      ...d,
      cards: [
        { oracle_id: "o-sol", qty: 3 },
        { oracle_id: "o-mystery", qty: 2 },
        { oracle_id: "missing", qty: 1 },
      ],
    }));
    const result = (
      await client.callTool({
        name: "meta_budget_swaps",
        arguments: { deck_id: "deck-1", target_usd: 4 },
      })
    ).structuredContent;
    expect(result).toMatchObject({
      swaps: [{ out: { qty: 1 }, in: { qty: 1 }, savings: 0.5 }],
      current_min_buy_usd: 4.5,
      projected_min_buy_usd: 4,
      target_met: null,
      budget: {
        scope: "library_only",
        ownership_adjusted: false,
        price_fetched_at: null,
        unpriced_copies: 2,
        unresolved_copies: 1,
        complete: false,
      },
    });
  });
});
