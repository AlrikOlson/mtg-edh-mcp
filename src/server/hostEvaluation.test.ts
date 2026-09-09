import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  gradeHostEvaluation,
  startHostEvaluation,
  type HostEvaluationEvent,
  type HostEvaluationState,
} from "./hostEvaluation.fixture.js";

let directory: string;
let sequence = 0;
const clients: Client[] = [];
const require = createRequire(import.meta.url);

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "mtg-host-evaluation-"));
  await build({
    stdin: {
      contents: `import { startHostEvaluation } from "./hostEvaluation.fixture.ts";
await startHostEvaluation({
  scenario: process.env.HOST_EVAL_SCENARIO,
  tracePath: process.env.HOST_EVAL_TRACE_PATH,
  statePath: process.env.HOST_EVAL_STATE_PATH,
});`,
      resolveDir: fileURLToPath(new URL("./", import.meta.url)),
      sourcefile: "host-evaluation-entry.ts",
    },
    outfile: path.join(directory, "server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    plugins: [
      {
        name: "native-sqlite",
        setup(builder) {
          builder.onResolve({ filter: /^better-sqlite3$/ }, ({ path: specifier }) => ({
            path: pathToFileURL(require.resolve(specifier)).href,
            external: true,
          }));
        },
      },
    ],
  });
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function connect(scenario: string) {
  const stem = path.join(directory, `${++sequence}-${scenario}`);
  const client = new Client({ name: "fixture-verification", version: "1" });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(directory, "server.mjs")],
      env: {
        HOST_EVAL_SCENARIO: scenario,
        HOST_EVAL_TRACE_PATH: `${stem}.jsonl`,
        HOST_EVAL_STATE_PATH: `${stem}.json`,
      },
      stderr: "pipe",
    }),
  );
  return {
    client,
    call: (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args }),
    async receipt() {
      return {
        state: JSON.parse(await readFile(`${stem}.json`, "utf8")) as HostEvaluationState,
        events: (await readFile(`${stem}.jsonl`, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as HostEvaluationEvent),
      };
    },
  };
}

describe("model-host fixture transport and independent grading", () => {
  it("does not credit checks on a temporary second deck to the final deck", async () => {
    const run = await connect("budget-build");
    await run.call("collection_set", { cards: ["Sol Ring", "Goblin Matron"] });
    for (const name of ["Actual final deck", "Temporary comparison deck"]) {
      await run.call("deck_create", { name, commanders: "Krenko, Mob Boss" });
      const receipt = await run.receipt();
      const deck = receipt.state.deck_store.decks.at(-1)?.[1];
      assert(deck);
      await run.call("deck_add", {
        deck_id: deck.deck_id,
        cards: ["Sol Ring", "Goblin Matron", "Skirk Prospector", { card: "Mountain", qty: 96 }],
      });
    }
    const temporary = "budget-build-deck-2";
    await run.call("validate_deck", { deck_id: temporary });
    await run.call("budget_plan", {
      deck_id: temporary,
      target_usd: 100,
      use_collection: true,
    });
    await run.call("deck_export", { deck_id: temporary });
    await run.call("deck_delete", { deck_id: temporary });
    const { state, events } = await run.receipt();
    const grade = gradeHostEvaluation("budget-build", state, events);
    expect(grade.checks).toContainEqual(
      expect.objectContaining({
        id: "legal_100_cards_including_commander",
        passed: true,
      }),
    );
    for (const id of ["validation_observed", "collection_budget_observed", "export_observed"])
      expect(grade.checks).toContainEqual(expect.objectContaining({ id, passed: false }));
  }, 30_000);

  it("refuses to overwrite a retained host trace", async () => {
    const tracePath = path.join(directory, "retained.jsonl");
    await writeFile(tracePath, "retained observation\n");
    await expect(
      startHostEvaluation({
        scenario: "budget-build",
        tracePath,
        statePath: path.join(directory, "retained-state.json"),
      }),
    ).rejects.toThrow();
    expect(await readFile(tracePath, "utf8")).toBe("retained observation\n");
  });

  it("retains real stdio exchanges and audits the actual deck including commander price", async () => {
    const run = await connect("budget-build");
    await run.client.listTools();
    await run.call("collection_set", { cards: ["Sol Ring", "Goblin Matron"] });
    await run.call("deck_create", {
      name: "Host budget",
      commanders: "Krenko, Mob Boss",
    });
    await run.call("deck_add", {
      deck_id: "budget-build-deck-1",
      cards: ["Sol Ring", "Goblin Matron", "Skirk Prospector", { card: "Mountain", qty: 96 }],
    });
    await run.call("validate_deck", { deck_id: "budget-build-deck-1" });
    await run.call("budget_plan", {
      deck_id: "budget-build-deck-1",
      target_usd: 100,
      use_collection: true,
    });
    await run.call("deck_export", { deck_id: "budget-build-deck-1" });
    const { state, events } = await run.receipt();
    expect(events.some((event) => event.message?.method === "initialize")).toBe(true);
    expect(events.some((event) => event.message?.method === "tools/list")).toBe(true);
    expect(
      events.filter(
        (event) => event.direction === "client_to_server" && event.message?.method === "tools/call",
      ),
    ).toHaveLength(6);
    expect(state.collection).toEqual(["wf-matron", "wf-sol"]);
    expect(state.deck_store.decks[0]?.[1].cards).toContainEqual({
      oracle_id: "wf-mountain",
      qty: 96,
    });
    expect(gradeHostEvaluation("budget-build", state, events).passed).toBe(true);
    const invalid = structuredClone(state);
    const invalidCard = invalid.deck_store.decks[0]?.[1].cards[0];
    assert(invalidCard);
    invalidCard.qty = 2;
    expect(gradeHostEvaluation("budget-build", invalid, events).passed).toBe(false);
    expect(gradeHostEvaluation("import-tune", state, events).passed).toBe(false);

    // A valid intermediate deck cannot stand in for requested final-state checks.
    await run.call("deck_rename", {
      deck_id: "budget-build-deck-1",
      name: "Changed after checks",
    });
    const changed = await run.receipt();
    const staleGrade = gradeHostEvaluation("budget-build", changed.state, changed.events);
    for (const id of ["validation_observed", "collection_budget_observed", "export_observed"])
      expect(staleGrade.checks).toContainEqual(expect.objectContaining({ id, passed: false }));
    await run.call("deck_remove", {
      deck_id: "budget-build-deck-1",
      cards: "Skirk Prospector",
    });
    await run.call("deck_add", {
      deck_id: "budget-build-deck-1",
      cards: "Arcane Signet",
    });
    const substituted = await run.receipt();
    expect(
      gradeHostEvaluation("budget-build", substituted.state, substituted.events).checks,
    ).toContainEqual(
      expect.objectContaining({
        id: "requested_prospector_used",
        passed: false,
      }),
    );
  }, 30_000);

  it("injects the cold outage, retains failures, and detects mutation hidden behind an error", async () => {
    const run = await connect("error-recovery");
    const deckId = "error-recovery-deck-1";
    await run.call("deck_create", {
      name: "Recovery",
      commanders: "Krenko, Mob Boss",
    });
    await run.call("deck_add", {
      deck_id: deckId,
      cards: { card: "Mountain", qty: 98 },
    });
    expect(
      await run.call("deck_set_commander", {
        deck_id: deckId,
        commanders: "Krenko",
      }),
    ).toMatchObject({ isError: true });
    await run.call("deck_set_commander", {
      deck_id: deckId,
      commanders: "Krenko, Mob Boss",
    });
    expect(await run.call("meta_recommend", { deck_id: deckId, rank: "synergy" })).toMatchObject({
      isError: true,
    });
    await run.call("card_search", { query: "id<=r t:goblin usd<=1" });
    await run.call("deck_add", { deck_id: deckId, cards: "Skirk Prospector" });
    await run.call("validate_deck", { deck_id: deckId });
    await run.call("meta_recommend", { deck_id: deckId, rank: "synergy" });
    const { state, events } = await run.receipt();
    expect(state.edhrec_requests).toBe(2);
    expect(gradeHostEvaluation("error-recovery", state, events).passed).toBe(true);
    const forged = structuredClone(events);
    const failed = forged.find(
      (event) =>
        event.direction === "server_to_client" &&
        (event.message?.result as { isError?: boolean } | undefined)?.isError,
    );
    const failedDeck = failed?.state.deck_store.decks[0]?.[1];
    assert(failedDeck);
    failedDeck.name = "Unacknowledged change";
    expect(gradeHostEvaluation("error-recovery", state, forged).checks).toContainEqual(
      expect.objectContaining({
        id: "failed_calls_preserve_state",
        passed: false,
      }),
    );
    const mutatingAdvice = structuredClone(events);
    const retry = mutatingAdvice
      .filter(
        (event) =>
          event.direction === "server_to_client" &&
          (event.message?.result as { structuredContent?: { suggestions?: unknown[] } } | undefined)
            ?.structuredContent?.suggestions,
      )
      .at(-1);
    const adviceDeck = retry?.state.deck_store.decks[0]?.[1];
    assert(adviceDeck);
    adviceDeck.name = "Advice secretly changed this deck";
    expect(gradeHostEvaluation("error-recovery", state, mutatingAdvice).checks).toContainEqual(
      expect.objectContaining({
        id: "successful_recommendations_preserve_state",
        passed: false,
      }),
    );

    await run.call("deck_remove", {
      deck_id: deckId,
      cards: "Skirk Prospector",
    });
    await run.call("deck_add", { deck_id: deckId, cards: "Goblin Matron" });
    const wrongFallback = await run.receipt();
    expect(
      gradeHostEvaluation("error-recovery", wrongFallback.state, wrongFallback.events).checks,
    ).toContainEqual(expect.objectContaining({ id: "exact_recovery_library", passed: false }));
  }, 30_000);

  it.each(["import-tune", "acquisition-reduction"])(
    "grades the actual exact swap for %s and rejects a missing original import",
    async (scenario) => {
      const run = await connect(scenario);
      const deckId = `${scenario}-deck-1`;
      if (scenario === "acquisition-reduction")
        await run.call("deck_create", {
          name: "Import",
          commanders: "Krenko, Mob Boss",
        });
      await run.call("deck_import", {
        ...(scenario === "import-tune" ? { name: "Imported new deck" } : { deck_id: deckId }),
        text: "1 Sol Ring\n1 Goblin Matron\n97 Mountain",
      });
      if (scenario === "import-tune")
        await run.call("deck_set_commander", {
          deck_id: deckId,
          commanders: "Krenko, Mob Boss",
        });
      if (scenario === "import-tune") await run.call("deck_snapshot", { deck_id: deckId });
      if (scenario === "acquisition-reduction")
        await run.call("collection_set", { cards: ["Goblin Matron"] });
      await run.call("budget_plan", {
        deck_id: deckId,
        target_usd: 20,
        use_collection: true,
      });
      await run.call("deck_remove", { deck_id: deckId, cards: "Sol Ring" });
      await run.call("deck_add", { deck_id: deckId, cards: "Arcane Signet" });
      await run.call("validate_deck", { deck_id: deckId });
      await run.call("budget_plan", {
        deck_id: deckId,
        target_usd: 20,
        use_collection: true,
      });
      if (scenario === "import-tune")
        await run.call("deck_diff", {
          deck_id: deckId,
          snapshot_id: `${scenario}-snapshot-1`,
        });
      await run.call("deck_export", { deck_id: deckId });
      const { state, events } = await run.receipt();
      expect(gradeHostEvaluation(scenario, state, events).passed).toBe(true);
      const missing = events.filter(
        (event) =>
          event.message?.method !== "tools/call" ||
          (event.message.params as { name?: string } | undefined)?.name !== "deck_import",
      );
      expect(gradeHostEvaluation(scenario, state, missing).passed).toBe(false);
    },
    30_000,
  );
});
