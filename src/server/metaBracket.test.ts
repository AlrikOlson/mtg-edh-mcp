import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { DeckStore } from "../deck/index.js";
import { CacheStore, GameChangersClient, SpellbookClient } from "../meta/index.js";
import {
  SPELLBOOK_RESPONSE_FIXTURE,
  SPELLBOOK_VARIANT_FIXTURE,
} from "../meta/spellbook.fixture.js";
import { createServer } from "./createServer.js";
import { staticSnapshotProvider } from "./snapshot.js";

const ORACLE = [
  {
    oracle_id: "o-atraxa",
    id: "p-atraxa",
    name: "Atraxa, Praetors' Voice",
    cmc: 4,
    colors: ["W", "U", "B", "G"],
    color_identity: ["W", "U", "B", "G"],
    type_line: "Legendary Creature — Phyrexian Angel Horror",
    oracle_text: "Flying, vigilance, deathtouch, lifelink",
    legalities: { commander: "legal" },
    prices: { usd: "10.00" },
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
    oracle_id: "o-rift",
    id: "p-rift",
    name: "Cyclonic Rift",
    cmc: 2,
    colors: ["U"],
    color_identity: ["U"],
    type_line: "Instant",
    oracle_text:
      "Return target nonland permanent you don't control to its owner's hand. Overload {6}{U}{U}.",
    legalities: { commander: "legal" },
    prices: { usd: "30.00" },
  },
  {
    oracle_id: "o-oracle",
    id: "p-oracle",
    name: "Thassa's Oracle",
    cmc: 2,
    colors: ["U"],
    color_identity: ["U"],
    type_line: "Creature — Merfolk Wizard",
    oracle_text: "When Thassa's Oracle enters, look at the top X cards of your library...",
    legalities: { commander: "legal" },
    prices: { usd: "5.00" },
  },
  {
    oracle_id: "o-consult",
    id: "p-consult",
    name: "Demonic Consultation",
    cmc: 1,
    colors: ["B"],
    color_identity: ["B"],
    type_line: "Instant",
    oracle_text: "Name a card. Exile the top six cards of your library...",
    legalities: { commander: "legal" },
    prices: { usd: "3.00" },
  },
];

const EMPTY_COMBOS = {
  ...SPELLBOOK_RESPONSE_FIXTURE,
  count: 0,
  results: { ...SPELLBOOK_RESPONSE_FIXTURE.results, included: [] },
};

function comboIngredient(name: string, oracleId: string) {
  return {
    card: { id: 1, name, oracleId },
    quantity: 1,
    zoneLocations: ["H"],
    battlefieldCardState: "",
    exileCardState: "",
    libraryCardState: "",
    graveyardCardState: "",
    mustBeCommander: false,
    usedFace: null,
  };
}

const TWO_CARD_COMBO = {
  ...SPELLBOOK_VARIANT_FIXTURE,
  id: "oracle-consultation",
  uses: [
    comboIngredient("Thassa's Oracle", "o-oracle"),
    comboIngredient("Demonic Consultation", "o-consult"),
  ],
  requires: [],
  manaNeeded: "{U}{U}{B}",
  manaValueNeeded: 3,
  easyPrerequisites: "",
  notablePrerequisites: "",
};

function withCombo(combo: unknown) {
  return { ...EMPTY_COMBOS, count: 1, results: { ...EMPTY_COMBOS.results, included: [combo] } };
}

let root: string;
let index: CardIndex;
let deckStore: DeckStore;
let client: Client;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-bracket-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(
    store.filePath("v1", "oracle_cards.json"),
    JSON.stringify(ORACLE.map((card) => ({ ...card, layout: "normal" }))),
    "utf8",
  );
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
  await store.publish("v1");
  index = CardIndex.open((await buildIndex({ store })).dbPath);
  deckStore = new DeckStore({ newId: () => "deck-1" });

  const gameChangers = new GameChangersClient(new CacheStore({ now: () => 1000 }), {
    fetchJson: async () => ["Cyclonic Rift"], // live list (faked, never network)
  });
  const server = createServer({
    index,
    deckStore,
    gameChangers,
    spellbook: new SpellbookClient(new CacheStore(), { fetchJson: async () => EMPTY_COMBOS }),
    snapshot: staticSnapshotProvider("2026-06-27"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  await client.callTool({ name: "deck_create", arguments: { name: "Atraxa" } });
  deckStore.update("deck-1", (d) => ({
    ...d,
    commanders: ["o-atraxa"],
    computed_color_identity: ["W", "U", "B", "G"],
    cards: [
      { oracle_id: "o-sol", qty: 1 },
      { oracle_id: "o-rift", qty: 1 },
    ],
  }));
});

function useComboDeck() {
  deckStore.update("deck-1", (deck) => ({
    ...deck,
    commanders: [],
    computed_color_identity: [],
    cards: [
      { oracle_id: "o-oracle", qty: 1 },
      { oracle_id: "o-consult", qty: 1 },
    ],
  }));
}

async function comboClient(spellbook: SpellbookClient): Promise<Client> {
  const server = createServer({
    index,
    deckStore,
    spellbook,
    gameChangers: new GameChangersClient(new CacheStore(), { fetchJson: async () => [] }),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const connected = new Client({ name: "combo-bracket-test", version: "1.0.0" });
  await connected.connect(ct);
  return connected;
}

const classify = (connected: Client) =>
  connected.callTool({ name: "meta_classify_bracket", arguments: { deck_id: "deck-1" } });
afterEach(async () => {
  await client.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

describe("meta_classify_bracket tool", () => {
  it("is registered", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("meta_classify_bracket");
  });

  it("classifies with the live Game Changers list and lists pushers", async () => {
    const res = await client.callTool({
      name: "meta_classify_bracket",
      arguments: { deck_id: "deck-1" },
    });
    const r = res.structuredContent as {
      bracket: number;
      pushers: { game_changers: string[]; fast_mana: string[] };
      rationale: string;
    };
    expect(r.bracket).toBe(3); // 1 Game Changer (Cyclonic Rift)
    expect(r.pushers.game_changers).toEqual(["Cyclonic Rift"]);
    expect(r.pushers.fast_mana).toContain("Sol Ring");
  });

  it("returns DECK_NOT_FOUND for an unknown deck", async () => {
    const res = await client.callTool({
      name: "meta_classify_bracket",
      arguments: { deck_id: "nope" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "DECK_NOT_FOUND" });
  });

  it("factors a deck's two-card Spellbook combo into the bracket (P11)", async () => {
    // Reconfigure deck-1 to hold an early two-card combo (Oracle MV2 + Consultation MV1).
    deckStore.update("deck-1", (d) => ({
      ...d,
      commanders: [],
      computed_color_identity: [],
      cards: [
        { oracle_id: "o-oracle", qty: 1 },
        { oracle_id: "o-consult", qty: 1 },
      ],
    }));
    const spellbook = new SpellbookClient(new CacheStore({ now: () => 1000 }), {
      fetchJson: async () => withCombo(TWO_CARD_COMBO),
    });
    const gc = new GameChangersClient(new CacheStore({ now: () => 1000 }), {
      fetchJson: async () => [], // no Game Changers — the combo is the only pusher
    });
    const server = createServer({
      index,
      deckStore,
      gameChangers: gc,
      spellbook,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c2 = new Client({ name: "t-combo", version: "0.0.0" });
    await c2.connect(ct);
    const res = await c2.callTool({
      name: "meta_classify_bracket",
      arguments: { deck_id: "deck-1" },
    });
    const r = res.structuredContent as {
      bracket: number;
      pushers: { combos: string[] };
    };
    expect(r.pushers.combos).toContain("Thassa's Oracle + Demonic Consultation");
    expect(r.bracket).toBe(4); // early combo (2 + 1 = 3 MV) → Optimized
    expect(res.structuredContent).toMatchObject({
      provisional: true,
      combo_evidence: {
        status: "available",
        candidate_count: 1,
        supported_count: 1,
        absence_confirmed: false,
      },
    });
    await c2.close();
  });

  it("uses explicit setup mana before claiming a low-mana-value combo is early", async () => {
    useComboDeck();
    const connected = await comboClient(
      new SpellbookClient(new CacheStore(), {
        fetchJson: async () =>
          withCombo({ ...TWO_CARD_COMBO, manaNeeded: "{10}", manaValueNeeded: 10 }),
      }),
    );
    try {
      const result = await classify(connected);
      expect(result.structuredContent).toMatchObject({
        bracket: 3,
        pushers: { combos: ["Thassa's Oracle + Demonic Consultation"] },
      });
    } finally {
      await connected.close();
    }
  });

  it.each([
    [
      "sparse ingredient evidence",
      {
        id: "sparse",
        uses: [{ card: { name: "Thassa's Oracle" } }, { card: { name: "Demonic Consultation" } }],
        produces: [],
      },
    ],
    ["required template", { ...TWO_CARD_COMBO, requires: SPELLBOOK_VARIANT_FIXTURE.requires }],
    ["unknown template collection", { ...TWO_CARD_COMBO, requires: null }],
    [
      "extra required copy",
      {
        ...TWO_CARD_COMBO,
        uses: [
          { ...comboIngredient("Thassa's Oracle", "o-oracle"), quantity: 2 },
          comboIngredient("Demonic Consultation", "o-consult"),
        ],
      },
    ],
    [
      "unmet commander requirement",
      {
        ...TWO_CARD_COMBO,
        uses: [
          { ...comboIngredient("Thassa's Oracle", "o-oracle"), mustBeCommander: true },
          comboIngredient("Demonic Consultation", "o-consult"),
        ],
      },
    ],
    [
      "unavailable face",
      {
        ...TWO_CARD_COMBO,
        uses: [
          { ...comboIngredient("Thassa's Oracle", "o-oracle"), usedFace: 2 },
          comboIngredient("Demonic Consultation", "o-consult"),
        ],
      },
    ],
    ["provider draft", { ...TWO_CARD_COMBO, status: "DRAFT" }],
    [
      "unresolved prose prerequisite",
      { ...TWO_CARD_COMBO, easyPrerequisites: "Your deck contains only blue cards." },
    ],
  ])("does not turn %s into a supported two-card bracket pusher", async (_label, combo) => {
    useComboDeck();
    const connected = await comboClient(
      new SpellbookClient(new CacheStore(), { fetchJson: async () => withCombo(combo) }),
    );
    try {
      expect((await classify(connected)).structuredContent).toMatchObject({
        bracket: 2,
        pushers: { combos: [] },
        provisional: true,
        combo_evidence: {
          status: "available",
          candidate_count: 1,
          supported_count: 0,
          absence_confirmed: false,
        },
      });
    } finally {
      await connected.close();
    }
  });

  it.each(["offline", "malformed"])(
    "reports %s combo lookup as unavailable rather than evidence of absence",
    async (failure) => {
      useComboDeck();
      const connected = await comboClient(
        new SpellbookClient(new CacheStore(), {
          fetchJson: async () => {
            if (failure === "offline") throw new Error("offline");
            return { detail: "invalid provider payload" };
          },
        }),
      );
      try {
        const result = await classify(connected);
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          provisional: true,
          combo_evidence: {
            status: "unavailable",
            freshness: null,
            coverage: null,
            absence_confirmed: false,
            error: { code: "UPSTREAM_UNAVAILABLE" },
          },
        });
      } finally {
        await connected.close();
      }
    },
  );

  it.each([
    ["complete empty response", EMPTY_COMBOS, "complete"],
    ["missing categories", { results: { included: [] } }, "partial"],
    [
      "unfetched next page",
      {
        ...EMPTY_COMBOS,
        count: 10,
        next: "https://backend.commanderspellbook.com/find-my-combos?offset=1",
      },
      "partial",
    ],
  ])("keeps %s non-exhaustive in bracket evidence", async (_label, response, status) => {
    useComboDeck();
    const connected = await comboClient(
      new SpellbookClient(new CacheStore(), { fetchJson: async () => response }),
    );
    try {
      expect((await classify(connected)).structuredContent).toMatchObject({
        provisional: true,
        combo_evidence: {
          status: "available",
          candidate_count: 0,
          absence_confirmed: false,
          coverage: { status, provider_non_exhaustive: true },
        },
      });
    } finally {
      await connected.close();
    }
  });

  it("exposes stale combo evidence after refresh failure without claiming absence", async () => {
    useComboDeck();
    let now = 1000;
    let offline = false;
    const connected = await comboClient(
      new SpellbookClient(new CacheStore({ now: () => now }), {
        ttlMs: 100,
        fetchJson: async () => {
          if (offline) throw new Error("offline");
          return EMPTY_COMBOS;
        },
      }),
    );
    try {
      await classify(connected);
      now = 1200;
      offline = true;
      expect((await classify(connected)).structuredContent).toMatchObject({
        provisional: true,
        combo_evidence: {
          status: "available",
          absence_confirmed: false,
          freshness: {
            status: "stale",
            refresh_failed: true,
            age_ms: 200,
            fetched_at: new Date(1000).toISOString(),
          },
        },
      });
    } finally {
      await connected.close();
    }
  });

  it("degrades to UPSTREAM_UNAVAILABLE when the Game Changers list is unreachable", async () => {
    const down = new GameChangersClient(new CacheStore({ now: () => 1000 }), {
      fetchJson: async () => {
        throw new Error("offline");
      },
    });
    const server = createServer({ index, deckStore, gameChangers: down });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c2 = new Client({ name: "t2", version: "0.0.0" });
    await c2.connect(ct);
    const res = await c2.callTool({
      name: "meta_classify_bracket",
      arguments: { deck_id: "deck-1" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    await c2.close();
  });
});

describe("ergo-meta consolidation", () => {
  it("meta_deck_summary and meta_themes are gone; deck_status + meta_classify_bracket cover them", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("meta_deck_summary");
    expect(names).not.toContain("meta_themes");
    expect(names).toContain("deck_status");
    expect(names).toContain("meta_classify_bracket");
  });
});
