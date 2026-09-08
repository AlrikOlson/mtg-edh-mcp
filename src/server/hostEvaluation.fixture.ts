/** Evaluation adapter only: real MCP stdio, pinned providers, and independent state receipts. */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, openSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";
import * as stdioSdk from "@modelcontextprotocol/server/stdio";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { DeckStore, type DeckStoreDump } from "../deck/index.js";
import { CollectionStore } from "../collection/index.js";
import { CacheStore, EdhrecClient, SpellbookClient, GameChangersClient } from "../meta/index.js";
import { createServer } from "./createServer.js";
import { staticSnapshotProvider } from "./snapshot.js";
import { WORKFLOW_FIXTURE, WORKFLOW_VERSION } from "./workflowScenarios.js";

export const HOST_EVALUATION_SCENARIOS = [
  "budget-build",
  "import-tune",
  "acquisition-reduction",
  "error-recovery",
] as const;
export type HostEvaluationScenario = (typeof HOST_EVALUATION_SCENARIOS)[number];

export interface HostEvaluationState {
  scenario: HostEvaluationScenario;
  workflow_version: string;
  fixture_sha256: string;
  deck_store: DeckStoreDump;
  collection: string[];
  edhrec_requests: number;
}

export interface HostEvaluationEvent {
  sequence: number;
  elapsed_ms: number;
  direction: "client_to_server" | "server_to_client" | "audit";
  message?: Record<string, unknown>;
  state: HostEvaluationState;
  note?: string;
}

function fixtureHash(): string {
  return createHash("sha256").update(JSON.stringify(WORKFLOW_FIXTURE)).digest("hex");
}

function scenarioId(value: string): HostEvaluationScenario {
  if (!HOST_EVALUATION_SCENARIOS.includes(value as HostEvaluationScenario))
    throw new Error(`Unknown host evaluation scenario: ${value}`);
  return value as HostEvaluationScenario;
}

/**
 * Import-safe entrypoint. A runner supplies isolated absolute output paths and
 * invokes this in a dedicated process; no model orchestration occurs here.
 * All relative production imports can be bundled against a historical checkout.
 */
export async function startHostEvaluation(options: {
  scenario: string;
  tracePath: string;
  statePath: string;
  stdin?: Readable;
  stdout?: Writable;
}): Promise<{ close(): Promise<void>; state(): HostEvaluationState }> {
  const scenario = scenarioId(options.scenario);
  const tracePath = path.resolve(options.tracePath);
  const statePath = path.resolve(options.statePath);
  if (tracePath === statePath) throw new Error("Trace and state paths must differ");
  await mkdir(path.dirname(tracePath), { recursive: true });
  await mkdir(path.dirname(statePath), { recursive: true });
  // Refuse to overwrite evidence from any previous run.
  const traceFd = openSync(tracePath, "wx");
  try {
    closeSync(openSync(statePath, "wx"));
  } catch (error) {
    closeSync(traceFd);
    throw error;
  }
  const root = await mkdtemp(path.join(tmpdir(), "mtg-model-host-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("External network is forbidden in host evaluation fixture");
  };
  let index: CardIndex | undefined;
  let handle: { close(): Promise<void> } | undefined;
  let closed = false;
  let deckNumber = 0;
  let snapshotNumber = 0;
  let edhrecRequests = 0;
  let eventNumber = 0;
  const started = performance.now();
  const decks = new DeckStore({
    newId: () => `${scenario}-deck-${++deckNumber}`,
    newSnapshotId: () => `${scenario}-snapshot-${++snapshotNumber}`,
  });
  const collection = new CollectionStore();
  const state = (): HostEvaluationState => ({
    scenario,
    workflow_version: WORKFLOW_VERSION,
    fixture_sha256: fixtureHash(),
    deck_store: decks.dump(),
    collection: [...collection.get(scenario)].sort(),
    edhrec_requests: edhrecRequests,
  });
  function audit(
    direction: HostEvaluationEvent["direction"],
    message?: unknown,
    note?: string,
  ): void {
    const current = state();
    const event: HostEvaluationEvent = {
      sequence: ++eventNumber,
      elapsed_ms: performance.now() - started,
      direction,
      ...(message ? { message: structuredClone(message) as Record<string, unknown> } : {}),
      state: current,
      ...(note ? { note } : {}),
    };
    appendFileSync(traceFd, JSON.stringify(event) + "\n");
    // Persist the direct store observation before stdout can acknowledge a call.
    const temporary = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(current, null, 2) + "\n");
    renameSync(temporary, statePath);
  }
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    try {
      await handle?.close();
      audit("audit", undefined, "connection_closed");
    } finally {
      index?.close();
      closeSync(traceFd);
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  }
  try {
    const store = new VersionedStore(root);
    await store.createVersion("workflow-fixture-v1");
    await writeFile(
      store.filePath("workflow-fixture-v1", "oracle_cards.json"),
      JSON.stringify(WORKFLOW_FIXTURE.oracle_cards),
    );
    await writeFile(
      store.filePath("workflow-fixture-v1", "default_cards.json"),
      JSON.stringify(WORKFLOW_FIXTURE.default_cards),
    );
    await store.publish("workflow-fixture-v1");
    index = CardIndex.open((await buildIndex({ store })).dbPath);
    const cache = () => new CacheStore({ now: () => WORKFLOW_FIXTURE.cache_clock_ms });
    const server = createServer({
      index,
      deckStore: decks,
      collection,
      session: scenario,
      snapshot: staticSnapshotProvider(WORKFLOW_FIXTURE.snapshot),
      edhrec: new EdhrecClient(cache(), {
        fetchJson: async () => {
          edhrecRequests += 1;
          if (scenario === "error-recovery" && edhrecRequests === 1)
            throw new Error(WORKFLOW_FIXTURE.recovery_upstream_failure);
          return WORKFLOW_FIXTURE.edhrec_profile;
        },
      }),
      spellbook: new SpellbookClient(cache(), {
        fetchJson: async () => WORKFLOW_FIXTURE.spellbook,
      }),
      gameChangers: new GameChangersClient(cache(), {
        fetchJson: async () => WORKFLOW_FIXTURE.game_changers,
      }),
    });
    const stdin = options.stdin ?? process.stdin;
    const transport = new stdioSdk.StdioServerTransport(stdin, options.stdout ?? process.stdout);
    const start = transport.start.bind(transport);
    transport.start = async () => {
      const receive = transport.onmessage;
      transport.onmessage = (message) => {
        audit("client_to_server", message);
        receive?.(message);
      };
      await start();
    };
    const send = transport.send.bind(transport);
    transport.send = async (message) => {
      audit("server_to_client", message);
      await send(message);
    };
    audit(
      "audit",
      undefined,
      "ready; synthetic prices and in-memory user state; not a durability or deck-quality evaluation",
    );
    // Namespace lookup permits a baseline bundle to map this SDK import to v1,
    // which only exposes StdioServerTransport and initialization-based serving.
    const modernServe = Reflect.get(stdioSdk, "serveStdio") as
      typeof stdioSdk.serveStdio | undefined;
    if (modernServe) handle = modernServe(() => server, { transport });
    else {
      await server.connect(transport);
      handle = server;
    }
    stdin.once("end", () => {
      void close().catch((error: unknown) => console.error(error));
    });
    return { close, state };
  } catch (error) {
    await close();
    throw error;
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

interface ObservedCall {
  name: string;
  arguments: Record<string, unknown>;
  request: HostEvaluationEvent;
  response: HostEvaluationEvent;
  result: Record<string, unknown>;
  body: Record<string, unknown>;
}

function observedCalls(events: HostEvaluationEvent[]): ObservedCall[] {
  const requests = new Map<unknown, HostEvaluationEvent>();
  const calls: ObservedCall[] = [];
  for (const event of events) {
    const message = event.message;
    if (!message) continue;
    if (event.direction === "client_to_server" && message.method === "tools/call")
      requests.set(message.id, event);
    if (event.direction !== "server_to_client" || !("id" in message)) continue;
    const request = requests.get(message.id);
    if (!request) continue;
    requests.delete(message.id);
    const params = object(request.message?.params);
    const result = object(message.result);
    calls.push({
      name: String(params.name),
      arguments: object(params.arguments),
      request,
      response: event,
      result,
      body: object(result.structuredContent),
    });
  }
  return calls;
}

/** Grade observed stores and actual exchanges; never trusts a model's final prose. */
export function gradeHostEvaluation(
  scenario: string,
  state: HostEvaluationState,
  events: HostEvaluationEvent[],
): {
  passed: boolean;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
} {
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const check = (id: string, passed: boolean, detail: string) => {
    checks.push({ id, passed, detail });
  };
  const calls = observedCalls(events);
  const successful = (name: string) =>
    calls.filter(
      (call) =>
        call.name === name &&
        call.result.isError !== true &&
        "result" in (call.response.message ?? {}),
    );
  const deck = state.deck_store.decks[0]?.[1];
  const observedDeck = (call: ObservedCall) =>
    (call.arguments.deck_id ?? (call.name === "deck_import" ? call.body.deck_id : undefined)) ===
    deck?.deck_id
      ? call.response.state.deck_store.decks.find(
          ([, value]) => value.deck_id === deck?.deck_id,
        )?.[1]
      : undefined;
  const observesFinalDeck = (call: ObservedCall) =>
    deck !== undefined && JSON.stringify(observedDeck(call)) === JSON.stringify(deck);
  const finalCalls = (name: string) => successful(name).filter(observesFinalDeck);
  const observesFinalCollection = (call: ObservedCall) =>
    JSON.stringify(call.response.state.collection) === JSON.stringify(state.collection);
  const preservesState = (call: ObservedCall) =>
    JSON.stringify({
      deck_store: call.request.state.deck_store,
      collection: call.request.state.collection,
    }) ===
    JSON.stringify({
      deck_store: call.response.state.deck_store,
      collection: call.response.state.collection,
    });
  const fixtureCards = new Map(WORKFLOW_FIXTURE.oracle_cards.map((card) => [card.oracle_id, card]));
  const entries = deck?.cards ?? [];
  const commanderIds = deck?.commanders ?? [];
  const qty = (id: string) =>
    entries.filter((entry) => entry.oracle_id === id).reduce((sum, entry) => sum + entry.qty, 0);
  const fullCount = entries.reduce((sum, entry) => sum + entry.qty, commanderIds.length);
  const price = (id: string) => Number(fixtureCards.get(id)?.prices.usd ?? Number.NaN);
  const fullPrice =
    entries.reduce((sum, entry) => sum + Math.round(price(entry.oracle_id) * 100) * entry.qty, 0) +
    commanderIds.reduce((sum, id) => sum + Math.round(price(id) * 100), 0);
  const known = [...entries.map((entry) => entry.oracle_id), ...commanderIds].every((id) =>
    fixtureCards.has(id),
  );
  const legalEntries = entries.every(
    (entry) =>
      Number.isSafeInteger(entry.qty) &&
      entry.qty > 0 &&
      (fixtureCards.get(entry.oracle_id)?.type_line.includes("Basic Land") ||
        qty(entry.oracle_id) === 1) &&
      !commanderIds.includes(entry.oracle_id) &&
      fixtureCards.get(entry.oracle_id)?.color_identity.every((color) => color === "R"),
  );
  check(
    "fixture_identity",
    state.scenario === scenario &&
      state.workflow_version === WORKFLOW_VERSION &&
      state.fixture_sha256 === fixtureHash(),
    "Scenario and immutable fixture provenance match",
  );
  check(
    "one_deck",
    state.deck_store.decks.length === 1,
    `Observed ${state.deck_store.decks.length} final decks`,
  );
  check(
    "legal_100_cards_including_commander",
    commanderIds.length === 1 &&
      commanderIds[0] === "wf-krenko" &&
      fullCount === 100 &&
      known &&
      legalEntries,
    `Independent fixture count ${fullCount}; commander ${commanderIds.join(",")}`,
  );
  check(
    "validation_observed",
    finalCalls("validate_deck").some((call) => call.body.ok === true),
    "Host requested successful rules validation of the final deck state",
  );

  const exactLibrary = (cards: typeof entries, expected: Record<string, number>) => {
    const actual: Record<string, number> = {};
    for (const entry of cards) actual[entry.oracle_id] = (actual[entry.oracle_id] ?? 0) + entry.qty;
    return (
      Object.keys(actual).length === Object.keys(expected).length &&
      Object.entries(expected).every(([id, count]) => actual[id] === count)
    );
  };
  const original = { "wf-sol": 1, "wf-matron": 1, "wf-mountain": 97 };
  const swapped = { "wf-arcane": 1, "wf-matron": 1, "wf-mountain": 97 };
  const imports = successful("deck_import");
  if (scenario === "budget-build") {
    check(
      "full_price_at_most_100_usd",
      Number.isFinite(fullPrice) && fullPrice <= 10000,
      `Commander-inclusive fixture price $${(fullPrice / 100).toFixed(2)}`,
    );
    check(
      "owned_cards_used",
      state.collection.join(",") === "wf-matron,wf-sol" &&
        qty("wf-sol") === 1 &&
        qty("wf-matron") === 1,
      "Owned Sol Ring and Goblin Matron remain in collection and deck",
    );
    check(
      "requested_prospector_used",
      qty("wf-prospector") === 1,
      "The explicitly requested Skirk Prospector is in the final deck",
    );
    check(
      "collection_budget_observed",
      finalCalls("budget_plan").some(
        (call) =>
          observesFinalCollection(call) &&
          call.arguments.use_collection === true &&
          Number(call.body.acquire_usd) < Number(call.body.min_buy_usd),
      ),
      "Host observed collection-aware acquisition reduction",
    );
    check(
      "export_observed",
      finalCalls("deck_export").length > 0,
      "Host requested the finished library export",
    );
  } else if (scenario === "import-tune" || scenario === "acquisition-reduction") {
    check(
      "original_import_observed",
      imports.some((call) => exactLibrary(observedDeck(call)?.cards ?? [], original)),
      "Original imported state contains Sol Ring, Goblin Matron, and 97 Mountain",
    );
    check(
      "exact_swap",
      exactLibrary(entries, swapped),
      "Final library replaces only Sol Ring with Arcane Signet",
    );
    if (scenario === "import-tune") {
      check(
        "original_snapshot_retained",
        state.deck_store.snapshots.some(
          ([, snapshot]) =>
            snapshot.deck.deck_id === deck?.deck_id && exactLibrary(snapshot.deck.cards, original),
        ),
        "Original imported library is retained in a snapshot",
      );
      check(
        "diff_observed",
        finalCalls("deck_diff").some((call) => {
          const cards = object(object(call.body.diff).cards);
          return (
            JSON.stringify(cards.added) === JSON.stringify([{ oracle_id: "wf-arcane", qty: 1 }]) &&
            JSON.stringify(cards.removed) === JSON.stringify([{ oracle_id: "wf-sol", qty: 1 }]) &&
            JSON.stringify(cards.changed) === "[]"
          );
        }),
        "Host requested the exact snapshot diff",
      );
      check(
        "export_observed",
        finalCalls("deck_export").some(
          (call) =>
            typeof call.body.text === "string" &&
            call.body.text.includes("1 Arcane Signet") &&
            !call.body.text.includes("Sol Ring"),
        ),
        "Export reports the actual replacement library",
      );
    } else {
      check(
        "owned_card_retained",
        state.collection.join(",") === "wf-matron" && qty("wf-matron") === 1,
        "Owned Goblin Matron is preserved",
      );
      const budgets = successful("budget_plan").filter(
        (call) => call.arguments.use_collection === true,
      );
      const before = budgets.find(
        (call) =>
          call.body.acquire_usd === 89.7 &&
          observesFinalCollection(call) &&
          exactLibrary(observedDeck(call)?.cards ?? [], original),
      );
      const after = budgets.find(
        (call) =>
          call.body.acquire_usd === 10.7 &&
          observesFinalCollection(call) &&
          observesFinalDeck(call),
      );
      check(
        "acquisition_reduced_by_79_usd",
        Boolean(before && after && before.response.sequence < after.response.sequence),
        "Observed owned-aware acquisition cost $89.70 → $10.70",
      );
    }
  } else if (scenario === "error-recovery") {
    check(
      "exact_recovery_library",
      exactLibrary(entries, { "wf-mountain": 98, "wf-prospector": 1 }),
      "Final library contains exactly 98 Mountain and the requested Skirk Prospector",
    );
    const ambiguous = calls.find(
      (call) => call.body.code === "AMBIGUOUS_NAME" && call.result.isError === true,
    );
    const outage = calls.find(
      (call) => call.body.code === "UPSTREAM_UNAVAILABLE" && call.result.isError === true,
    );
    check(
      "ambiguous_name_recovered",
      Boolean(
        ambiguous &&
        successful("deck_set_commander").some(
          (call) => call.response.sequence > ambiguous.response.sequence,
        ),
      ),
      "Host explicitly corrected the ambiguous commander",
    );
    const failures = calls.filter(
      (call) => call.result.isError === true || "error" in (call.response.message ?? {}),
    );
    check(
      "failed_calls_preserve_state",
      failures.every(preservesState),
      "Observed failed calls leave deck/snapshot/collection state unchanged",
    );
    const local = successful("card_search").find(
      (call) => outage && call.response.sequence > outage.response.sequence,
    );
    const addition = successful("deck_add").find(
      (call) => local && call.response.sequence > local.response.sequence,
    );
    const retry = finalCalls("meta_recommend").find(
      (call) => addition && call.response.sequence > addition.response.sequence,
    );
    check(
      "outage_local_fallback_then_retry",
      Boolean(outage && local && addition && retry && state.edhrec_requests >= 2),
      "Cold upstream failure is followed by local search/add and a successful upstream retry",
    );
    check(
      "successful_recommendations_preserve_state",
      successful("meta_recommend").every(preservesState),
      "Successful recommendations leave deck/snapshot/collection state unchanged",
    );
  } else check("known_scenario", false, `Unknown scenario ${scenario}`);
  return { passed: checks.every((entry) => entry.passed), checks };
}
