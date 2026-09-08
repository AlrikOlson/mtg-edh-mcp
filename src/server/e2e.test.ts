/**
 * End-to-end worked-example acceptance (spec §10, chunk:p7-e2e).
 *
 * Proves the primitives are sufficient: the three deliberately-different §10 decks
 * are each built to a LEGAL 100-card list purely by composing MCP tool calls — the
 * server makes zero strategic decisions and enforces every rule (Principle 1). The
 * three flows share one toolset; no per-archetype code path exists.
 *
 *   (a) cEDH combo  — Thrasios/Tymna partner pairing, fast mana + tutor, bracket.
 *   (b) Budget tribal — $75 Goblins, price-watched, exported.
 *   (c) Jank build-around — group-hug "everyone draws", oracle-text mined.
 *
 * Every deck is padded to exactly 100 with Wastes (a colorless basic: singleton-
 * exempt, empty color identity ⊆ every deck's identity) resolved via card tools.
 * The EDHREC / Spellbook / Game Changers clients are injected with fake fetchers —
 * never network. Assertions read structuredContent from real client.callTool results.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { DeckStore } from "../deck/index.js";
import { CacheStore, EdhrecClient, SpellbookClient, GameChangersClient } from "../meta/index.js";
import { createServer } from "./createServer.js";
import { staticSnapshotProvider } from "./snapshot.js";

/** Minimal raw-Scryfall-shaped fixture covering all three §10 flows + padding. */
const ORACLE = [
  // (a) cEDH — partner pair (G/U + W/B = WUBG), fast mana, a tutor.
  {
    oracle_id: "o-thrasios",
    id: "p-thrasios",
    name: "Thrasios, Triton Hero",
    cmc: 2,
    colors: ["G", "U"],
    color_identity: ["G", "U"],
    type_line: "Legendary Creature — Merfolk Wizard",
    oracle_text:
      "{4}: Scry 1, then draw a card... Partner (You can have two commanders if both have partner.)",
    legalities: { commander: "legal" },
    prices: { usd: "3.00" },
  },
  {
    oracle_id: "o-tymna",
    id: "p-tymna",
    name: "Tymna the Weaver",
    cmc: 2,
    colors: ["W", "B"],
    color_identity: ["W", "B"],
    type_line: "Legendary Creature — Human Cleric",
    oracle_text:
      "...draw that many cards. Partner (You can have two commanders if both have partner.)",
    legalities: { commander: "legal" },
    prices: { usd: "4.00" },
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
    oracle_id: "o-demonic",
    id: "p-demonic",
    name: "Demonic Tutor",
    cmc: 2,
    colors: ["B"],
    color_identity: ["B"],
    type_line: "Sorcery",
    oracle_text: "Search your library for a card, put it into your hand, then shuffle.",
    legalities: { commander: "legal" },
    prices: { usd: "2.00" },
  },
  // (b) Budget tribal — mono-red goblins.
  {
    oracle_id: "o-krenko",
    id: "p-krenko",
    name: "Krenko, Mob Boss",
    cmc: 4,
    colors: ["R"],
    color_identity: ["R"],
    type_line: "Legendary Creature — Goblin Warrior",
    oracle_text:
      "{T}: Create X 1/1 red Goblin creature tokens, where X is the number of Goblins you control.",
    legalities: { commander: "legal" },
    prices: { usd: "2.50" },
  },
  {
    oracle_id: "o-prospector",
    id: "p-prospector",
    name: "Skirk Prospector",
    cmc: 1,
    colors: ["R"],
    color_identity: ["R"],
    type_line: "Creature — Goblin",
    oracle_text: "Sacrifice a Goblin: Add {R}.",
    legalities: { commander: "legal" },
    prices: { usd: "0.25" },
  },
  {
    oracle_id: "o-matron",
    id: "p-matron",
    name: "Goblin Matron",
    cmc: 2,
    colors: ["R"],
    color_identity: ["R"],
    type_line: "Creature — Goblin",
    oracle_text: "When Goblin Matron enters, search your library for a Goblin card.",
    legalities: { commander: "legal" },
    prices: { usd: "0.50" },
  },
  // (c) Jank — group hug commander + a hand-size payoff.
  {
    oracle_id: "o-kwain",
    id: "p-kwain",
    name: "Kwain, Itinerant Meddler",
    cmc: 2,
    colors: ["U"],
    color_identity: ["U"],
    type_line: "Legendary Creature — Human Advisor",
    oracle_text:
      "{T}: Each player may draw a card, then each player draws a card and gains 1 life.",
    legalities: { commander: "legal" },
    prices: { usd: "0.50" },
  },
  {
    oracle_id: "o-reliquary",
    id: "p-reliquary",
    name: "Reliquary Tower",
    cmc: 0,
    colors: [],
    color_identity: [],
    type_line: "Land",
    oracle_text: "You have no maximum hand size. {T}: Add {C}.",
    legalities: { commander: "legal" },
    prices: { usd: "1.00" },
  },
  // Padding: colorless basic, unlimited, identity ⊆ every deck.
  {
    oracle_id: "o-wastes",
    id: "p-wastes",
    name: "Wastes",
    cmc: 0,
    colors: [],
    color_identity: [],
    type_line: "Basic Land — Wastes",
    oracle_text: "{T}: Add {C}.",
    legalities: { commander: "legal" },
    prices: { usd: "0.10" },
  },
];

let root: string;
let index: CardIndex;
let deckStore: DeckStore;
let client: Client;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-e2e-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
  await store.publish("v1");
  index = CardIndex.open((await buildIndex({ store })).dbPath);
  deckStore = new DeckStore();

  // Fake enrichment clients — deterministic, never network.
  const cache = () => new CacheStore({ now: () => 1000 });
  const spellbook = new SpellbookClient(cache(), {
    fetchJson: async () => ({
      results: {
        included: [
          {
            id: "combo-1",
            uses: [{ card: { name: "Thrasios, Triton Hero" } }, { card: { name: "Sol Ring" } }],
            produces: [{ feature: { name: "Infinite mana" } }],
            description: "Tap, float, repeat.",
          },
        ],
        almostIncluded: [],
      },
    }),
  });
  const edhrec = new EdhrecClient(cache(), { fetchJson: async () => ({}) }); // no themes (jank)
  const gameChangers = new GameChangersClient(cache(), {
    fetchJson: async () => ["Thrasios, Triton Hero"], // one Game Changer in the pool
  });

  const server = createServer({
    index,
    deckStore,
    edhrec,
    spellbook,
    gameChangers,
    snapshot: staticSnapshotProvider("2026-06-27"),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(ct);
});
afterEach(async () => {
  await client.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

type Sc = Record<string, unknown>;
const sc = (r: unknown): Sc => (r as { structuredContent?: unknown }).structuredContent as Sc;

/** card_search → return the lean CardRef whose name matches (proves the search found it). */
async function searchFor(
  query: string,
  name: string,
  order?: string,
): Promise<{ oracle_id: string }> {
  const res = await client.callTool({
    name: "card_search",
    arguments: order ? { query, order } : { query },
  });
  const results = sc(res).results as { oracle_id: string; name: string }[];
  const hit = results.find((c) => c.name === name);
  expect(hit, `card_search '${query}' should surface ${name}`).toBeTruthy();
  return hit!;
}

/** Add one searched card to the deck via deck_add; assert the pre-check verdict is ok. */
async function addOne(deckId: string, oracleId: string): Promise<void> {
  const res = await client.callTool({
    name: "deck_add",
    arguments: { deck_id: deckId, cards: [{ oracle_id: oracleId, qty: 1 }] },
  });
  const verdicts = sc(res).verdicts as { status: string }[];
  expect(verdicts[0]?.status).toBe("ok");
}

/** Pad the deck with Wastes to exactly 100 (commanders + cards), using only tools. */
async function padToHundred(deckId: string, commanderCount: number): Promise<void> {
  const wastes = sc(
    await client.callTool({
      name: "card_resolve_name",
      arguments: { name: "Wastes" },
    }),
  );
  const before = sc(await client.callTool({ name: "deck_get", arguments: { deck_id: deckId } }));
  const deck = before.deck as { cards: { qty: number }[] };
  const have = deck.cards.reduce((s, e) => s + e.qty, 0) + commanderCount;
  const need = 100 - have;
  expect(need).toBeGreaterThan(0);
  await client.callTool({
    name: "deck_add",
    arguments: {
      deck_id: deckId,
      cards: [{ oracle_id: wastes.oracle_id as string, qty: need }],
    },
  });
}

/** Assert validate_deck reports a legal 100-card deck. */
async function expectLegal(deckId: string): Promise<void> {
  const res = await client.callTool({
    name: "validate_deck",
    arguments: { deck_id: deckId },
  });
  const v = sc(res);
  expect(v.ok, `validate_deck errors: ${JSON.stringify(v.errors)}`).toBe(true);
  expect((v.errors as unknown[]).length).toBe(0);
}

describe("§10 worked examples — built by composing tools only", () => {
  it("(a) cEDH combo — Thrasios/Tymna partner, fast mana + tutor, bracket", async () => {
    // 1. validate the partner pairing before committing to it.
    const vc = sc(
      await client.callTool({
        name: "validate_commander",
        arguments: {
          commanders: ["o-thrasios", "o-tymna"],
          command_zone_kind: "partner",
        },
      }),
    );
    expect(vc.ok).toBe(true);
    expect([...(vc.computed_color_identity as string[])].sort()).toEqual(["B", "G", "U", "W"]);

    // 2. create + set the command zone (recomputes identity to WUBG).
    const deckId = sc(
      await client.callTool({
        name: "deck_create",
        arguments: { name: "Thrasios/Tymna" },
      }),
    ).deck_id as string;
    const set = sc(
      await client.callTool({
        name: "deck_set_commander",
        arguments: {
          deck_id: deckId,
          commanders: ["o-thrasios", "o-tymna"],
          command_zone_kind: "partner",
        },
      }),
    );
    expect(set.ok).toBe(true);

    // 3. combos reachable from the commanders (fake Spellbook).
    const combos = sc(
      await client.callTool({
        name: "meta_combos",
        arguments: { deck_id: deckId },
      }),
    );
    expect(combos.included_count).toBe(1);

    // 4–5. fast mana + a tutor, found by search, added with an ok verdict.
    const sol = await searchFor("id<=wubg o:add mv<=1", "Sol Ring");
    await addOne(deckId, sol.oracle_id);
    const tutor = await searchFor('id<=wubg o:"search your library"', "Demonic Tutor");
    await addOne(deckId, tutor.oracle_id);

    // 6. role coverage is computable (advisory).
    const cov = sc(
      await client.callTool({
        name: "analyze_role_coverage",
        arguments: { deck_id: deckId },
      }),
    );
    expect(Array.isArray(cov.gaps)).toBe(true);

    // 7. pad to a legal 100, then classify the bracket (fake Game Changers).
    await padToHundred(deckId, 2);
    const bracket = sc(
      await client.callTool({
        name: "meta_classify_bracket",
        arguments: { deck_id: deckId },
      }),
    );
    expect(typeof bracket.bracket).toBe("number");
    expect((bracket.pushers as { game_changers: string[] }).game_changers).toContain(
      "Thrasios, Triton Hero",
    );

    // 8. legal.
    await expectLegal(deckId);
  });

  it("(b) budget tribal — $75 Goblins, price-watched, exported", async () => {
    const deckId = sc(
      await client.callTool({
        name: "deck_create",
        arguments: { name: "$75 Goblins" },
      }),
    ).deck_id as string;
    await client.callTool({
      name: "deck_set_commander",
      arguments: {
        deck_id: deckId,
        commanders: ["o-krenko"],
        command_zone_kind: "single",
      },
    });

    // affordable goblins, surfaced cheapest-first.
    const matron = await searchFor("id<=r t:goblin usd<=3", "Goblin Matron", "price");
    await addOne(deckId, matron.oracle_id);
    const prospector = await searchFor("id<=r t:goblin usd<=3", "Skirk Prospector", "price");
    await addOne(deckId, prospector.oracle_id);

    // analyze_stats watches the running price; mana base reports red sources.
    const stats = sc(
      await client.callTool({
        name: "analyze_stats",
        arguments: { deck_id: deckId },
      }),
    );
    expect(stats.total_price_usd as number).toBeGreaterThan(0);
    const mana = sc(
      await client.callTool({
        name: "analyze_mana_base",
        arguments: { deck_id: deckId },
      }),
    );
    expect(typeof mana.total_lands).toBe("number");

    await padToHundred(deckId, 1);
    await expectLegal(deckId);

    // exportable to plaintext decklist.
    const exp = sc(
      await client.callTool({
        name: "deck_export",
        arguments: { deck_id: deckId },
      }),
    );
    expect((exp.text as string).length).toBeGreaterThan(0);
    // Export is the 99-card library (the command zone is not part of the decklist).
    expect(exp.text).toContain("Goblin Matron");
  });

  it("(c) jank build-around — group-hug 'everyone draws', oracle-text mined", async () => {
    // 1. mine a build-around commander purely from oracle text, then lock it by name.
    const candidate = await searchFor('o:"each player draws"', "Kwain, Itinerant Meddler");
    const resolved = sc(
      await client.callTool({
        name: "card_resolve_name",
        arguments: { name: "Kwain, Itinerant Meddler" },
      }),
    );
    expect(resolved.oracle_id).toBe(candidate.oracle_id);

    const deckId = sc(
      await client.callTool({
        name: "deck_create",
        arguments: { name: "Group Hug" },
      }),
    ).deck_id as string;
    await client.callTool({
      name: "deck_set_commander",
      arguments: {
        deck_id: deckId,
        commanders: [candidate.oracle_id],
        command_zone_kind: "single",
      },
    });

    // 2. a payoff no preset archetype tool would anticipate (no max hand size).
    const payoff = await searchFor('o:"maximum hand size"', "Reliquary Tower");
    await addOne(deckId, payoff.oracle_id);

    // 3. EDHREC may have no theme for jank — that's fine; local search carried it.
    //    (themes ride the commander profile since ergo-meta consolidated meta_themes away)
    const profile = sc(
      await client.callTool({
        name: "meta_commander_profile",
        arguments: { commander: "Kwain, Itinerant Meddler" },
      }),
    );
    expect(Array.isArray(profile.themes)).toBe(true);

    // 4. composition is computable; pad + validate.
    const comp = sc(
      await client.callTool({
        name: "analyze_composition",
        arguments: { deck_id: deckId },
      }),
    );
    expect(comp.total as number).toBeGreaterThan(0);
    await padToHundred(deckId, 1);
    await expectLegal(deckId);
  });
});
