/**
 * Scripted protocol journeys over the production server and an isolated local index.
 * These are synthetic acceptance fixtures, not model-driven evaluations or competitive
 * deck recommendations. Prices are fixed examples, not market quotes. Basic-land padding
 * deliberately tests quantity and legality contracts; it does not test deck strategy.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { DeckStore } from "../deck/index.js";
import { CollectionStore } from "../collection/index.js";
import { CacheStore, EdhrecClient, SpellbookClient, GameChangersClient } from "../meta/index.js";
import { createServer } from "./createServer.js";
import { staticSnapshotProvider } from "./snapshot.js";
import { recordToolCall, type WorkflowCall } from "./workflowMetrics.js";

export interface WorkflowRun {
  id: string;
  prompt: string;
  calls: WorkflowCall[];
  invariants: string[];
  protocol_version?: string;
  server_info?: { name: string; version: string };
}

export const WORKFLOW_VERSION = "1";

const SNAPSHOT = "2026-09-08";
const ORACLE = [
  {
    oracle_id: "wf-krenko",
    id: "print-krenko",
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
    oracle_id: "wf-kingpin",
    id: "print-kingpin",
    name: "Krenko, Tin Street Kingpin",
    cmc: 3,
    colors: ["R"],
    color_identity: ["R"],
    type_line: "Legendary Creature — Goblin",
    oracle_text: "Whenever Krenko attacks, put a +1/+1 counter on it, then create Goblin tokens.",
    legalities: { commander: "legal" },
    prices: { usd: "1.00" },
  },
  {
    oracle_id: "wf-sol",
    id: "print-sol",
    name: "Sol Ring",
    cmc: 1,
    colors: [],
    color_identity: [],
    type_line: "Artifact",
    oracle_text: "{T}: Add {C}{C}.",
    legalities: { commander: "legal" },
    prices: { usd: "80.00" },
  },
  {
    oracle_id: "wf-arcane",
    id: "print-arcane",
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
    oracle_id: "wf-matron",
    id: "print-matron",
    name: "Goblin Matron",
    cmc: 3,
    colors: ["R"],
    color_identity: ["R"],
    type_line: "Creature — Goblin",
    oracle_text: "When Goblin Matron enters, search your library for a Goblin card.",
    legalities: { commander: "legal" },
    prices: { usd: "0.50" },
  },
  {
    oracle_id: "wf-prospector",
    id: "print-prospector",
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
    oracle_id: "wf-mountain",
    id: "print-mountain",
    name: "Mountain",
    cmc: 0,
    colors: [],
    color_identity: ["R"],
    type_line: "Basic Land — Mountain",
    oracle_text: "{T}: Add {R}.",
    legalities: { commander: "legal" },
    prices: { usd: "0.10" },
  },
];

const EDHREC_PROFILE = {
  container: {
    json_dict: {
      cardlists: [
        {
          header: "Creatures",
          cardviews: [
            { name: "Goblin Matron", inclusion: 75, synergy: 0.5 },
            { name: "Skirk Prospector", inclusion: 65, synergy: 0.4 },
          ],
        },
      ],
    },
  },
  panels: { taglinks: [{ value: "Goblins" }] },
};

/** Included in baseline provenance so changing fixture data invalidates its digest. */
export const WORKFLOW_FIXTURE = {
  snapshot: SNAPSHOT,
  oracle_cards: ORACLE,
  default_cards: [],
  edhrec_profile: EDHREC_PROFILE,
  recovery_upstream_failure: "Synthetic EDHREC outage",
  spellbook: { results: { included: [], almostIncluded: [] } },
  game_changers: [],
  cache_clock_ms: 1000,
  limitations:
    "Synthetic prices and basic-land padding; collection tracks membership, not owned quantities.",
};

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

function objects(value: unknown): Record<string, unknown>[] {
  assert(Array.isArray(value));
  return value.map(object);
}

function string(value: unknown): string {
  assert.equal(typeof value, "string");
  return String(value);
}

function number(value: unknown): number {
  assert(typeof value === "number" && Number.isFinite(value));
  return value;
}

interface Journey {
  call: (
    name: string,
    args: Record<string, unknown>,
    expectedError?: boolean,
  ) => Promise<Record<string, unknown>>;
  run: WorkflowRun;
}

async function runJourney(
  id: string,
  prompt: string,
  body: (journey: Journey) => Promise<void>,
  failFirstEdhrec = false,
): Promise<WorkflowRun> {
  const root = await mkdtemp(path.join(tmpdir(), "mtg-workflow-"));
  let index: CardIndex | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let client: Client | undefined;
  try {
    const store = new VersionedStore(root);
    await store.createVersion("workflow-fixture-v1");
    await writeFile(
      store.filePath("workflow-fixture-v1", "oracle_cards.json"),
      JSON.stringify(ORACLE),
      "utf8",
    );
    await writeFile(store.filePath("workflow-fixture-v1", "default_cards.json"), "[]", "utf8");
    await store.publish("workflow-fixture-v1");
    index = CardIndex.open((await buildIndex({ store })).dbPath);
    let deckNumber = 0;
    let snapshotNumber = 0;
    let edhrecCalls = 0;
    const cache = () => new CacheStore({ now: () => WORKFLOW_FIXTURE.cache_clock_ms });
    server = createServer({
      index,
      deckStore: new DeckStore({
        newId: () => `${id}-deck-${++deckNumber}`,
        newSnapshotId: () => `${id}-snapshot-${++snapshotNumber}`,
      }),
      collection: new CollectionStore(),
      session: id,
      snapshot: staticSnapshotProvider(SNAPSHOT),
      edhrec: new EdhrecClient(cache(), {
        fetchJson: async () => {
          edhrecCalls += 1;
          if (failFirstEdhrec && edhrecCalls === 1)
            throw new Error(WORKFLOW_FIXTURE.recovery_upstream_failure);
          return EDHREC_PROFILE;
        },
      }),
      spellbook: new SpellbookClient(cache(), {
        fetchJson: async () => WORKFLOW_FIXTURE.spellbook,
      }),
      gameChangers: new GameChangersClient(cache(), {
        fetchJson: async () => WORKFLOW_FIXTURE.game_changers,
      }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let protocolVersion: string | undefined;
    const send = serverTransport.send.bind(serverTransport);
    serverTransport.send = async (message, options) => {
      if ("result" in message && typeof message.result.protocolVersion === "string") {
        protocolVersion = message.result.protocolVersion;
      }
      await send(message, options);
    };
    await server.connect(serverTransport);
    const connected = new Client({
      name: "workflow-baseline",
      version: "1.0.0",
    });
    client = connected;
    await client.connect(clientTransport);
    assert(protocolVersion, "Initialize must expose the negotiated protocol revision");
    const run: WorkflowRun = {
      id,
      prompt,
      calls: [],
      invariants: [],
      protocol_version: protocolVersion,
      server_info: connected.getServerVersion(),
    };
    await body({
      run,
      call: (name, args, expectedError = false) =>
        recordToolCall(connected, run.calls, name, args, expectedError),
    });
    if (failFirstEdhrec)
      assert.equal(edhrecCalls, 2, "Retry must reach the injected upstream after a cold failure");
    return run;
  } finally {
    try {
      await client?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        index?.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}

async function getDeck(journey: Journey, deckId: string): Promise<Record<string, unknown>> {
  return object((await journey.call("deck_get", { deck_id: deckId })).deck);
}

async function createDeck(journey: Journey, name: string): Promise<string> {
  return string(
    (
      await journey.call("deck_create", {
        name,
        commanders: "Krenko, Mob Boss",
      })
    ).deck_id,
  );
}

async function addCards(journey: Journey, deckId: string, cards: unknown): Promise<void> {
  const added = await journey.call("deck_add", { deck_id: deckId, cards });
  assert.deepEqual(added.failed, []);
  assert(objects(added.verdicts).every((verdict) => verdict.status === "ok"));
}

async function legalHundred(journey: Journey, deckId: string): Promise<Record<string, unknown>> {
  const legal = await journey.call("validate_deck", { deck_id: deckId });
  assert.equal(legal.ok, true, JSON.stringify(legal.errors));
  assert.deepEqual(legal.errors, []);
  const deck = await getDeck(journey, deckId);
  assert(Array.isArray(deck.commanders));
  assert.equal(
    objects(deck.cards).reduce((sum, entry) => sum + number(entry.qty), deck.commanders.length),
    100,
  );
  journey.run.invariants.push("legal_100_cards_including_commander");
  return deck;
}

/** Price every card including command-zone cards independently of the 99-card budget tool. */
function fixtureFullPrice(deck: Record<string, unknown>): number {
  const cents = new Map(
    ORACLE.map((card) => [card.oracle_id, Math.round(Number(card.prices.usd) * 100)]),
  );
  const price = (id: string) => {
    const value = cents.get(id);
    assert(value !== undefined);
    return value;
  };
  assert(Array.isArray(deck.commanders));
  const library = objects(deck.cards).reduce(
    (sum, card) => sum + price(string(card.oracle_id)) * number(card.qty),
    0,
  );
  return (
    (library + deck.commanders.reduce((sum: number, id: unknown) => sum + price(string(id)), 0)) /
    100
  );
}

async function importFullDeck(journey: Journey, deckId: string): Promise<void> {
  const imported = await journey.call("deck_import", {
    deck_id: deckId,
    text: "1 Sol Ring\n1 Goblin Matron\n97 Mountain",
  });
  assert.deepEqual(imported.unresolved, []);
  assert.equal(imported.resolved_count, 3);
}

async function replaceExpensiveRock(journey: Journey, deckId: string): Promise<void> {
  const candidates = await journey.call("card_search", {
    query: "id<=r t:artifact o:add usd<=2",
    order: "price",
  });
  const replacement = objects(candidates.results).find((card) => card.name === "Arcane Signet");
  assert(replacement);
  const removed = await journey.call("deck_remove", {
    deck_id: deckId,
    cards: "Sol Ring",
  });
  assert.deepEqual(removed.failed, []);
  await addCards(journey, deckId, string(replacement.oracle_id));
}

/** Run four independent, fully scripted sessions; assertions fail on domain regressions. */
export async function runWorkflowScenarios(): Promise<WorkflowRun[]> {
  const runs: WorkflowRun[] = [];
  runs.push(
    await runJourney(
      "budget-build",
      "Build a legal 100-card Krenko deck for at most $100, using my owned Sol Ring and Goblin Matron.",
      async (journey) => {
        await journey.call("collection_set", {
          cards: ["Sol Ring", "Goblin Matron"],
        });
        const owned = await journey.call("card_search", {
          query: "id<=r",
          owned_only: true,
        });
        assert.deepEqual(
          objects(owned.results)
            .map((card) => card.oracle_id)
            .sort(),
          ["wf-matron", "wf-sol"],
        );
        const deckId = await createDeck(journey, "Synthetic $100 Goblins");
        const commander = await journey.call("deck_set_commander", {
          deck_id: deckId,
          commanders: "Krenko, Mob Boss",
        });
        assert.equal(commander.ok, true);
        await addCards(journey, deckId, [
          "Sol Ring",
          "Goblin Matron",
          "Skirk Prospector",
          { card: "Mountain", qty: 96 },
        ]);
        const deck = await legalHundred(journey, deckId);
        const budget = await journey.call("budget_plan", {
          deck_id: deckId,
          target_usd: 100,
          use_collection: true,
        });
        assert.equal(budget.min_buy_usd, 90.35);
        assert.equal(budget.acquire_usd, 9.85);
        assert.equal(fixtureFullPrice(deck), 92.85);
        assert(fixtureFullPrice(deck) <= 100);
        const exported = await journey.call("deck_export", { deck_id: deckId });
        assert(string(exported.text).includes("96 Mountain"));
        // deck_export is the 99-card library: the verified command zone is separate.
        assert(!string(exported.text).includes("Krenko"));
        journey.run.invariants.push(
          "full_100_card_price_including_commander_at_most_100_usd",
          "owned_cards_reduce_acquisition_cost",
          "export_contains_99_card_library_with_separate_commander",
        );
      },
    ),
  );

  runs.push(
    await runJourney(
      "import-tune",
      "Import my Krenko list, replace the expensive mana rock, and show the exact change and export.",
      async (journey) => {
        const deckId = await createDeck(journey, "Imported Goblins");
        await importFullDeck(journey, deckId);
        const snapshot = await journey.call("deck_snapshot", {
          deck_id: deckId,
        });
        const snapshotId = string(snapshot.snapshot_id);
        await journey.call("deck_status", { deck_id: deckId });
        await replaceExpensiveRock(journey, deckId);
        await legalHundred(journey, deckId);
        const diff = object(
          (
            await journey.call("deck_diff", {
              deck_id: deckId,
              snapshot_id: snapshotId,
            })
          ).diff,
        );
        assert.deepEqual(object(diff.cards), {
          added: [{ oracle_id: "wf-arcane", qty: 1 }],
          removed: [{ oracle_id: "wf-sol", qty: 1 }],
          changed: [],
        });
        const exported = string((await journey.call("deck_export", { deck_id: deckId })).text);
        assert(exported.includes("1 Arcane Signet"));
        assert(!exported.includes("Sol Ring"));
        assert(exported.includes("97 Mountain"));
        journey.run.invariants.push(
          "import_resolves_every_line",
          "snapshot_diff_exactly_matches_explicit_swap",
          "export_reflects_tuned_library",
        );
      },
    ),
  );

  runs.push(
    await runJourney(
      "acquisition-reduction",
      "Reduce the cost to acquire this Krenko deck while retaining my owned Goblin Matron and a legal 100 cards.",
      async (journey) => {
        const deckId = await createDeck(journey, "Acquire Goblins");
        await importFullDeck(journey, deckId);
        await journey.call("collection_set", { cards: ["Goblin Matron"] });
        const before = await journey.call("budget_plan", {
          deck_id: deckId,
          target_usd: 20,
          use_collection: true,
        });
        assert.equal(before.min_buy_usd, 90.2);
        assert.equal(before.acquire_usd, 89.7);
        await replaceExpensiveRock(journey, deckId);
        const after = await journey.call("budget_plan", {
          deck_id: deckId,
          target_usd: 20,
          use_collection: true,
        });
        assert.equal(after.min_buy_usd, 11.2);
        assert.equal(after.acquire_usd, 10.7);
        assert.equal(
          Math.round((number(before.acquire_usd) - number(after.acquire_usd)) * 100),
          7900,
        );
        const deck = await legalHundred(journey, deckId);
        assert(
          objects(deck.cards).some((card) => card.oracle_id === "wf-matron" && card.qty === 1),
        );
        journey.run.invariants.push(
          "owned_aware_acquisition_cost_reduced_by_79_usd",
          "owned_card_retained_without_changing_collection",
        );
      },
    ),
  );

  runs.push(
    await runJourney(
      "error-recovery",
      "Use Krenko as commander; recover from an ambiguous name and unavailable EDHREC using local cards, then retry recommendations.",
      async (journey) => {
        const deckId = await createDeck(journey, "Recovery Goblins");
        await addCards(journey, deckId, { card: "Mountain", qty: 98 });
        const initial = await getDeck(journey, deckId);
        const ambiguous = await journey.call(
          "deck_set_commander",
          { deck_id: deckId, commanders: "Krenko" },
          true,
        );
        assert.equal(ambiguous.code, "AMBIGUOUS_NAME");
        assert(
          objects(object(ambiguous.details).candidates).some(
            (card) => card.name === "Krenko, Mob Boss",
          ),
        );
        const afterAmbiguous = await getDeck(journey, deckId);
        assert.deepEqual(afterAmbiguous, initial);
        const resolved = await journey.call("card_resolve_name", {
          name: "Krenko, Mob Boss",
          exact: true,
        });
        const set = await journey.call("deck_set_commander", {
          deck_id: deckId,
          commanders: string(resolved.oracle_id),
        });
        assert.equal(set.ok, true);
        const beforeOutage = await getDeck(journey, deckId);
        const unavailable = await journey.call(
          "meta_recommend",
          { deck_id: deckId, rank: "synergy" },
          true,
        );
        assert.equal(unavailable.code, "UPSTREAM_UNAVAILABLE");
        assert.deepEqual(await getDeck(journey, deckId), beforeOutage);
        const local = await journey.call("card_search", {
          query: "id<=r t:goblin usd<=1",
          order: "price",
        });
        const fallback = objects(local.results).find((card) => card.name === "Skirk Prospector");
        assert(fallback);
        await addCards(journey, deckId, string(fallback.oracle_id));
        const recovered = await legalHundred(journey, deckId);
        const retried = await journey.call("meta_recommend", {
          deck_id: deckId,
          rank: "synergy",
        });
        assert(objects(retried.suggestions).some((card) => card.oracle_id === "wf-matron"));
        assert.deepEqual(await getDeck(journey, deckId), recovered);
        journey.run.invariants.push(
          "failed_calls_preserve_deck_card_contents",
          "ambiguous_name_corrected_explicitly",
          "local_fallback_completes_deck_during_upstream_outage",
          "upstream_retry_returns_grounded_suggestions_without_mutation",
        );
      },
      true,
    ),
  );
  return runs;
}
