/** Offline observations of the unchanged production MCP server, never expected truth. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { DeckStore } from "../deck/index.js";
import { CollectionStore } from "../collection/index.js";
import { CacheStore, EdhrecClient, SpellbookClient, GameChangersClient } from "../meta/index.js";
import { createServer } from "../server/createServer.js";
import { staticSnapshotProvider } from "../server/snapshot.js";
import { summarizeCalls, type WorkflowCall } from "../server/workflowMetrics.js";
import type { BenchmarkCase, BenchmarkCorpus, BenchmarkEntry } from "./corpus.js";
import { gradeDeck, gradeClaims, priceDeck, type DeckArtifact } from "./graders.js";

export interface BaselineGrade {
  check: string;
  status: "pass" | "fail" | "unsupported";
  expected: unknown;
  observed: unknown;
  evidence: string;
}
export interface BaselineCase {
  id: string;
  split: string;
  request: string;
  prompt: string;
  calls: WorkflowCall[];
  grades: BaselineGrade[];
  artifact?: DeckArtifact;
  error?: string;
  metrics: ReturnType<typeof summarizeCalls>;
}

const objectSchema = z.record(z.string(), z.unknown());
const artifactSchema = z.object({
  commanders: z.array(z.string()),
  cards: z.array(z.object({ oracle_id: z.string(), qty: z.number().int().positive() })),
  companion: z.string().optional(),
});
function object(value: unknown): Record<string, unknown> {
  const parsed = objectSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}
function artifactOf(value: unknown): DeckArtifact {
  const deck = artifactSchema.parse(value);
  return {
    commanders: deck.commanders,
    main: deck.cards.map((entry) => ({ id: entry.oracle_id, qty: entry.qty })),
    ...(deck.companion ? { companion: deck.companion } : {}),
  };
}
function targetOf(scenario: BenchmarkCase): DeckArtifact {
  return {
    commanders: scenario.commanders,
    main: scenario.main,
    ...(scenario.companion ? { companion: scenario.companion } : {}),
    ...(scenario.maybeboard ? { maybeboard: scenario.maybeboard } : {}),
  };
}
function cents(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : undefined;
}
function decklist(entries: BenchmarkEntry[], corpus: BenchmarkCorpus): string {
  return entries
    .map((entry) => {
      const fact = corpus.facts[entry.id];
      if (!fact) throw new Error(`Missing benchmark fact ${entry.id}`);
      return `${entry.qty} ${fact.name}`;
    })
    .join("\n");
}

/** Store full SDK results, including errors; never turn a failed call into missing evidence. */
async function call(
  client: Client,
  calls: WorkflowCall[],
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const started = performance.now();
  try {
    const result = await client.callTool({ name, arguments: args });
    calls.push({
      name,
      arguments: structuredClone(args),
      result: structuredClone(result),
      elapsed_ms: performance.now() - started,
      expected_error: false,
    });
    return object(result.structuredContent);
  } catch (error) {
    calls.push({
      name,
      arguments: structuredClone(args),
      result: null,
      elapsed_ms: performance.now() - started,
      expected_error: false,
      rpc_error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function comparison(
  check: string,
  expected: unknown,
  observed: unknown,
  evidence: string,
): BaselineGrade {
  return {
    check,
    status: JSON.stringify(expected) === JSON.stringify(observed) ? "pass" : "fail",
    expected,
    observed,
    evidence,
  };
}
function unsupported(check: string, evidence: string): BaselineGrade {
  return {
    check,
    status: "unsupported",
    expected: "Supported execution with independent evidence",
    observed: null,
    evidence,
  };
}

/**
 * Import complete authored reference decks to measure existing analysis, then separately
 * represent construction requests. Importing the supplied answer is never construction success.
 * Each scenario owns fresh stores/server/session. The shared card index is read-only.
 */
export async function runDeckQualityBaseline(corpus: BenchmarkCorpus) {
  const root = await mkdtemp(path.join(tmpdir(), "mtg-deck-quality-"));
  let index: CardIndex | undefined;
  const cases: BaselineCase[] = [];
  let catalog: { name: string; description?: string; inputSchema: unknown }[] = [];
  let serverInfo: { name: string; version: string } | undefined;
  try {
    const store = new VersionedStore(root);
    await store.createVersion("deck-quality-v1");
    await writeFile(
      store.filePath("deck-quality-v1", "oracle_cards.json"),
      JSON.stringify(corpus.oracleCards),
    );
    await writeFile(store.filePath("deck-quality-v1", "default_cards.json"), "[]");
    await store.publish("deck-quality-v1");
    index = CardIndex.open((await buildIndex({ store })).dbPath);
    for (const scenario of corpus.cases) {
      const calls: WorkflowCall[] = [];
      const grades: BaselineGrade[] = [];
      const decks = new DeckStore({ newId: () => scenario.id });
      const cache = () => new CacheStore({ now: () => 1000 });
      const server = createServer({
        index,
        deckStore: decks,
        collection: new CollectionStore(),
        session: scenario.id,
        snapshot: staticSnapshotProvider(corpus.snapshot),
        edhrec: new EdhrecClient(cache(), {
          fetchJson: async () => {
            throw new Error(
              "Pinned benchmark condition: EDHREC profile unavailable (simulated, not live absence)",
            );
          },
        }),
        spellbook: new SpellbookClient(cache(), {
          fetchJson: async () => {
            throw new Error("No pinned combo-provider evidence");
          },
        }),
        gameChangers: new GameChangersClient(cache(), {
          fetchJson: async () => {
            throw new Error("No pinned playgroup policy evidence");
          },
        }),
      });
      const client = new Client({
        name: "deck-quality-baseline",
        version: "1",
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      let artifact: DeckArtifact | undefined;
      let failure: string | undefined;
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        serverInfo ??= client.getServerVersion();
        if (catalog.length === 0)
          catalog = (await client.listTools()).tools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          }));
        const invoke = (name: string, args: Record<string, unknown>) =>
          call(client, calls, name, args);
        await invoke("deck_create", {
          name: scenario.id,
          commanders: scenario.commanders,
        });
        const imported = await invoke("deck_import", {
          deck_id: scenario.id,
          text: decklist(scenario.main, corpus),
        });
        grades.push(
          comparison("resolved-reference-list", [], imported.unresolved, "deck_import.unresolved"),
        );
        if (scenario.companion)
          await invoke("deck_set_companion", {
            deck_id: scenario.id,
            companion: scenario.companion,
          });
        const get = await invoke("deck_get", { deck_id: scenario.id });
        artifact = artifactOf(get.deck);
        const reference = targetOf(scenario);
        // Required zones cannot be silently discarded by the adapter.
        grades.push(
          comparison(
            "reference-zones-and-quantities",
            reference,
            artifact,
            "deck_get after supplied complete reference list; no construction claim",
          ),
        );
        const stateGrade = gradeDeck(scenario, corpus.facts, artifact);
        grades.push({
          check: "independent-deck-invariants",
          status: stateGrade.passed ? "pass" : "fail",
          expected: [],
          observed: stateGrade.failures,
          evidence:
            "Independent facts, counts, pairs, caps, protected choices and theme constraints",
        });
        const validation = await invoke("validate_deck", {
          deck_id: scenario.id,
        });
        if (typeof validation.ok !== "boolean" || object(calls.at(-1)?.result).isError === true) {
          throw new Error("Validation error is not a legality verdict");
        }
        const legality = gradeClaims(scenario, corpus.facts, artifact, {
          legal: validation.ok === true,
        });
        grades.push({
          check: "legality-verdict",
          status: legality.passed ? "pass" : "fail",
          expected: [],
          observed: legality.failures,
          evidence: "validate_deck.ok compared with independent legality facts",
        });
        grades.push(
          unsupported(
            "requested-workflow",
            "The user build/tune/acquisition prompt is frozen but not executed by a model host in this baseline. Current analytical results come from importing the authored reference deck.",
          ),
        );
        const prices = priceDeck(artifact, corpus.facts, scenario.owned);
        const budget = await invoke("budget_plan", {
          deck_id: scenario.id,
          ...(scenario.budgetCents !== undefined ? { target_usd: scenario.budgetCents / 100 } : {}),
        });
        grades.push(
          comparison(
            "complete-deck-price",
            prices.deckPriceCents,
            cents(budget.default_total_usd),
            "budget_plan.default_total_usd; default pinned printing includes command zone; unknown remains unknown",
          ),
        );
        await invoke("collection_set", {
          cards: Object.entries(scenario.owned)
            .filter(([, qty]) => qty > 0)
            .map(([id]) => id),
        });
        const acquisition = await invoke("budget_plan", {
          deck_id: scenario.id,
          use_collection: true,
        });
        grades.push(
          comparison(
            "quantity-aware-acquisition",
            prices.acquirePriceCents,
            cents(acquisition.acquire_usd),
            "budget_plan.acquire_usd; current collection API accepts membership only; oracle printing floor pinned to same selected printing",
          ),
        );
        await invoke("analyze_mana_base", { deck_id: scenario.id });
        grades.push(
          unsupported(
            "mana-payment-and-package-proof",
            "analyze_mana_base describes source counts; simulate_deck describes hand shapes. Neither accepts exact source/cost or package optimization questions. Frozen exhaustive reference puzzles define expected answers.",
          ),
        );
        if (
          scenario.startingMain.reduce((sum, card) => sum + card.qty, 0) <
            scenario.main.reduce((sum, card) => sum + card.qty, 0) ||
          scenario.request === "build"
        ) {
          grades.push(
            unsupported(
              "construction-request",
              "Catalog exposes create/import/add and recipe prompts, but no executable complete construction specification. The supplied reference list was imported only for analysis; no model host was run.",
            ),
          );
        }
        if (scenario.protected.length > 0 || scenario.theme.length > 0)
          grades.push(
            unsupported(
              "persistent-intent",
              "Catalog has role overrides but no protected-card/theme intent contract; passing authored target checks is not persistent intent support.",
            ),
          );
        if (!scenario.supported)
          grades.push(
            unsupported(
              "requested-mechanics",
              "Case explicitly declares unsupported gameplay evidence; no power or interaction success inferred from legal deck state.",
            ),
          );
        if (scenario.tags.some((tag) => /profile|new-commander|provider-absence/.test(tag))) {
          const recommendation = await invoke("meta_recommend", {
            deck_id: scenario.id,
            limit: 5,
          });
          grades.push(
            unsupported(
              "discovery-without-profile",
              "meta_recommend called with pinned simulated unavailable profile; raw result retained: " +
                JSON.stringify(recommendation),
            ),
          );
        }
        // Independently seeded count-preserving cap corruption exercises the production validator.
        const limited = scenario.main.find((entry) => {
          const max = corpus.facts[entry.id]?.maxCopies;
          return max !== null && max !== undefined && max > 1 && entry.qty === max;
        });
        const donor = scenario.main.find((entry) => corpus.facts[entry.id]?.maxCopies === null);
        if (limited && donor) {
          await invoke("deck_remove", {
            deck_id: scenario.id,
            cards: [{ card: donor.id, qty: 1 }],
          });
          await invoke("deck_import", {
            deck_id: scenario.id,
            text: decklist([{ id: limited.id, qty: 1 }], corpus),
          });
          const corrupt = artifactOf((await invoke("deck_get", { deck_id: scenario.id })).deck);
          const verdict = await invoke("validate_deck", {
            deck_id: scenario.id,
          });
          if (typeof verdict.ok !== "boolean" || object(calls.at(-1)?.result).isError === true) {
            throw new Error("Corruption validation error is not a legality verdict");
          }
          const mutation = gradeClaims(scenario, corpus.facts, corrupt, {
            legal: verdict.ok === true,
          });
          grades.push({
            check: "copy-limit-corruption",
            status: mutation.passed ? "pass" : "fail",
            expected: "Reject cap+1 while keeping 100 cards",
            observed: { legal: verdict.ok, failures: mutation.failures },
            evidence:
              "Real deck_remove + deck_import + validate_deck; Seven Dwarves/Nazgul limit fact is independent",
          });
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        grades.push({
          check: "scenario-execution",
          status: "fail",
          expected: "Complete observations",
          observed: failure,
          evidence: "Failure retained; remaining steps not silently passed",
        });
      } finally {
        await client.close();
        await server.close();
      }
      cases.push({
        id: scenario.id,
        split: scenario.split,
        request: scenario.request,
        prompt: scenario.prompt,
        calls,
        grades,
        ...(artifact ? { artifact } : {}),
        ...(failure ? { error: failure } : {}),
        metrics: summarizeCalls(calls),
      });
    }
    return {
      format_version: 1,
      corpus_version: corpus.version,
      mode: "scripted_mcp" as const,
      transport: "SDK InMemoryTransport; real client/server handlers; no stdio/HTTP framing",
      model: null,
      token_counts: null,
      model_task_success: null,
      server_info: serverInfo,
      catalog,
      cases,
      limitations: [
        "Authored complete targets are imported to measure analysis, not generated by a model or construction tool.",
        "This is corpus-limited deterministic analysis, not full-card-pool discovery or competitive win-rate evaluation.",
        "EDHREC absence is an injected provider condition, not evidence of a live missing profile.",
        "Prices are frozen default-printing USD observations, not current quotes; no shipping, taxes or marketplace fulfillment.",
        "Small exhaustive mana/package questions are reference truth; production sequence/optimizer APIs are unsupported.",
      ],
    };
  } finally {
    index?.close();
    await rm(root, { recursive: true, force: true });
  }
}

export const BENCHMARK_ROOT = new URL("../../docs/evaluation/deck-quality/", import.meta.url);
export async function benchmarkProvenance() {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const tracked = git("ls-files", "src")
    .split("\n")
    .filter((file) => file.endsWith(".ts") && !file.startsWith("src/evaluation/"));
  const production = await Promise.all(
    tracked.map(async (file) => [file, sha(await readFile(path.join(root, file)))]),
  );
  return {
    revision: git("rev-parse", "HEAD"),
    production_tree_sha256: sha(JSON.stringify(production)),
    production_diff: git(
      "diff",
      "HEAD",
      "--",
      "src",
      ":(exclude)src/evaluation",
      "package-lock.json",
    ),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    lockfile_sha256: sha(await readFile(path.join(root, "package-lock.json"))),
    corpus_sha256: sha(await readFile(new URL("corpus-v1.json", BENCHMARK_ROOT))),
    registration_sha256: sha(await readFile(new URL("registration-v1.json", BENCHMARK_ROOT))),
  };
}
