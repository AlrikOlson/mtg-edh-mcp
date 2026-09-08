/** Regrade retained baseline evidence; success flags are never trusted on their own. */
import { z } from "zod";
import type { BenchmarkCorpus } from "./corpus.js";
import { gradeClaims, gradeDeck, priceDeck } from "./graders.js";
import { summarizeCalls } from "../server/workflowMetrics.js";

const object = z.record(z.string(), z.unknown());
const entry = z.object({ id: z.string(), qty: z.number().int().positive() });
const artifact = z.object({
  commanders: z.array(z.string()),
  main: z.array(entry),
  companion: z.string().optional(),
  maybeboard: z.array(entry).optional(),
});
const call = z.object({
  name: z.string(),
  arguments: object,
  result: z.unknown(),
  elapsed_ms: z.number().finite().nonnegative(),
  expected_error: z.boolean(),
  rpc_error: z.string().optional(),
  rpc_error_code: z.number().optional(),
});
export const baselineReceiptSchema = z.object({
  format_version: z.literal(1),
  mode: z.literal("scripted_mcp"),
  model: z.null(),
  token_counts: z.null(),
  model_task_success: z.null(),
  corpus_version: z.string(),
  captured_at: z.string(),
  provenance: z.object({
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    production_tree_sha256: z.string(),
    production_diff: z.literal(""),
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
    lockfile_sha256: z.string(),
    corpus_sha256: z.string(),
    registration_sha256: z.string(),
  }),
  cases: z.array(
    z.object({
      id: z.string(),
      split: z.string(),
      request: z.string(),
      prompt: z.string(),
      calls: z.array(call),
      artifact,
      grades: z.array(
        z.object({
          check: z.string(),
          status: z.enum(["pass", "fail", "unsupported"]),
          expected: z.unknown().optional(),
          observed: z.unknown().optional(),
          evidence: z.string().min(1),
        }),
      ),
      metrics: z.object({
        tool_calls: z.number(),
        invalid_calls: z.number(),
        partial_failure_calls: z.number(),
        tool_errors: z.number(),
        rpc_errors: z.number(),
        expected_errors: z.number(),
        response_bytes: z.number(),
        elapsed_ms: z.number(),
      }),
    }),
  ),
});
function record(value: unknown): Record<string, unknown> {
  const parsed = object.safeParse(value);
  return parsed.success ? parsed.data : {};
}
function body(value: unknown): Record<string, unknown> {
  return record(record(value).structuredContent);
}
function cents(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : undefined;
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function verifyBaselineReceipt(corpus: BenchmarkCorpus, value: unknown): string[] {
  const parsed = baselineReceiptSchema.safeParse(value);
  if (!parsed.success) return ["Invalid baseline receipt: " + parsed.error.message];
  const report = parsed.data;
  const errors: string[] = [];
  if (report.corpus_version !== corpus.version) errors.push("Corpus version changed");
  if (
    !same(
      report.cases.map((item) => item.id),
      corpus.cases.map((item) => item.id),
    )
  )
    errors.push("Case coverage changed");
  for (const item of report.cases) {
    const scenario = corpus.cases.find((candidate) => candidate.id === item.id);
    if (!scenario) continue;
    const fail = (message: string) => errors.push(item.id + ": " + message);
    if (
      item.prompt !== scenario.prompt ||
      item.split !== scenario.split ||
      item.request !== scenario.request
    )
      fail("Frozen request changed");
    if (!same(summarizeCalls(item.calls), item.metrics)) fail("Observed metrics changed");
    if (new Set(item.grades.map((grade) => grade.check)).size !== item.grades.length)
      fail("Duplicate grade");
    const grade = (id: string) => {
      const found = item.grades.find((candidate) => candidate.check === id);
      if (!found) fail("Missing grade " + id);
      return found;
    };
    const check = (
      id: string,
      expected: unknown,
      observed: unknown,
      passed = same(expected, observed),
    ) => {
      const found = grade(id);
      if (
        found &&
        (!same(found.expected, expected) ||
          !same(found.observed, observed) ||
          found.status !== (passed ? "pass" : "fail"))
      )
        fail("Incorrect grade " + id);
    };
    const calls = (name: string) => item.calls.filter((candidate) => candidate.name === name);
    const finiteCap =
      scenario.main.some((card) => {
        const max = corpus.facts[card.id]?.maxCopies;
        return max !== null && max !== undefined && max > 1 && card.qty === max;
      }) && scenario.main.some((card) => corpus.facts[card.id]?.maxCopies === null);
    const profile = scenario.tags.some((tag) => /profile|new-commander|provider-absence/.test(tag));
    const expectedCalls = [
      "deck_create",
      "deck_import",
      ...(scenario.companion ? ["deck_set_companion"] : []),
      "deck_get",
      "validate_deck",
      "budget_plan",
      "collection_set",
      "budget_plan",
      "analyze_mana_base",
      ...(profile ? ["meta_recommend"] : []),
      ...(finiteCap ? ["deck_remove", "deck_import", "deck_get", "validate_deck"] : []),
    ];
    if (
      !same(
        item.calls.map((call) => call.name),
        expectedCalls,
      )
    )
      fail("Missing or reordered baseline call");
    if (!same(calls("deck_create")[0]?.arguments.commanders, scenario.commanders))
      fail("Commander input changed");
    const expectedList = scenario.main
      .map((card) => card.qty + " " + corpus.facts[card.id]?.name)
      .join("\n");
    if (calls("deck_import")[0]?.arguments.text !== expectedList)
      fail("Reference import input changed");
    const owned = Object.entries(scenario.owned)
      .filter(([, qty]) => qty > 0)
      .map(([id]) => id);
    if (
      !same(calls("collection_set")[0]?.arguments.cards, owned) ||
      calls("budget_plan")[0]?.arguments.use_collection === true ||
      calls("budget_plan")[1]?.arguments.use_collection !== true
    )
      fail("Acquisition probes changed");
    const get = calls("deck_get")[0];
    const rawDeck = body(get?.result).deck;
    const raw = record(rawDeck);
    const rawMain = z
      .array(z.object({ oracle_id: z.string(), qty: z.number() }))
      .safeParse(raw.cards);
    if (
      !rawMain.success ||
      !same(
        {
          commanders: raw.commanders,
          main: rawMain.success
            ? rawMain.data.map((card) => ({
                id: card.oracle_id,
                qty: card.qty,
              }))
            : [],
          ...(typeof raw.companion === "string" ? { companion: raw.companion } : {}),
        },
        item.artifact,
      )
    )
      fail("Artifact not tied to observed deck_get");
    const target = {
      commanders: scenario.commanders,
      main: scenario.main,
      ...(scenario.companion ? { companion: scenario.companion } : {}),
      ...(scenario.maybeboard ? { maybeboard: scenario.maybeboard } : {}),
    };
    check("reference-zones-and-quantities", target, item.artifact);
    check("resolved-reference-list", [], body(calls("deck_import")[0]?.result).unresolved);
    const state = gradeDeck(scenario, corpus.facts, item.artifact);
    check("independent-deck-invariants", [], state.failures, state.passed);
    for (const validation of calls("validate_deck")) {
      if (
        record(validation.result).isError === true ||
        typeof body(validation.result).ok !== "boolean"
      )
        fail("Validation error is not a legality verdict");
    }
    for (const name of [
      "deck_create",
      "deck_import",
      "deck_get",
      "validate_deck",
      "budget_plan",
      "collection_set",
      "analyze_mana_base",
    ]) {
      if (calls(name).length === 0) fail("Missing required call " + name);
    }
    for (const observed of item.calls) {
      if (
        (observed.name.startsWith("deck_") && observed.name !== "deck_create") ||
        ["validate_deck", "budget_plan", "analyze_mana_base", "meta_recommend"].includes(
          observed.name,
        )
      ) {
        if (observed.arguments.deck_id !== scenario.id) fail("Call bound to wrong deck");
      }
    }
    const legal = gradeClaims(scenario, corpus.facts, item.artifact, {
      legal: body(calls("validate_deck")[0]?.result).ok === true,
    });
    check("legality-verdict", [], legal.failures, legal.passed);
    const prices = priceDeck(item.artifact, corpus.facts, scenario.owned);
    check(
      "complete-deck-price",
      prices.deckPriceCents,
      cents(body(calls("budget_plan")[0]?.result).default_total_usd),
    );
    check(
      "quantity-aware-acquisition",
      prices.acquirePriceCents,
      cents(body(calls("budget_plan")[1]?.result).acquire_usd),
    );
    for (const unsupported of item.grades.filter(
      (candidate) =>
        candidate.check === "mana-payment-and-package-proof" ||
        candidate.check === "construction-request" ||
        candidate.check === "requested-workflow" ||
        candidate.check === "persistent-intent" ||
        candidate.check === "requested-mechanics" ||
        candidate.check === "discovery-without-profile",
    )) {
      if (unsupported.status !== "unsupported" || unsupported.observed !== null)
        fail("Unsupported work relabeled as success");
    }
    if (
      scenario.startingMain.reduce((sum, card) => sum + card.qty, 0) <
        scenario.main.reduce((sum, card) => sum + card.qty, 0) ||
      scenario.request === "build"
    )
      grade("construction-request");
    grade("mana-payment-and-package-proof");
    grade("requested-workflow");
    if (scenario.tags.some((tag) => /profile|new-commander|provider-absence/.test(tag))) {
      grade("discovery-without-profile");
      if (calls("meta_recommend").length === 0) fail("Missing no-profile observation");
    }
    if (scenario.protected.length || scenario.theme.length) grade("persistent-intent");
    if (!scenario.supported) grade("requested-mechanics");
    const limited = scenario.main.find((card) => {
      const max = corpus.facts[card.id]?.maxCopies;
      return max !== null && max !== undefined && max > 1 && card.qty === max;
    });
    const donor = scenario.main.find((card) => corpus.facts[card.id]?.maxCopies === null);
    const cap = item.grades.find((candidate) => candidate.check === "copy-limit-corruption");
    if (limited && donor && !cap) fail("Missing copy-limit corruption");
    if (cap) {
      if (!limited || !donor) {
        fail("Unregistered cap mutation");
        continue;
      }
      const finalGet = record(body(calls("deck_get").at(-1)?.result).deck);
      const cards = z
        .array(z.object({ oracle_id: z.string(), qty: z.number().int().positive() }))
        .safeParse(finalGet.cards);
      const commanders = z.array(z.string()).safeParse(finalGet.commanders);
      if (!cards.success || !commanders.success) {
        fail("Invalid cap artifact");
        continue;
      }
      const expectedMain = item.artifact.main
        .map((card) => ({
          id: card.id,
          qty: card.qty + (card.id === limited.id ? 1 : card.id === donor.id ? -1 : 0),
        }))
        .filter((card) => card.qty > 0);
      const observedMain = cards.data.map((card) => ({
        id: card.oracle_id,
        qty: card.qty,
      }));
      if (
        !same(observedMain, expectedMain) ||
        !same(commanders.data, item.artifact.commanders) ||
        finalGet.companion !== item.artifact.companion ||
        observedMain.reduce((sum, card) => sum + card.qty, commanders.data.length) !== 100
      )
        fail("Cap mutation did not preserve the declared count and zones");
      const verdict = body(calls("validate_deck").at(-1)?.result).ok;
      const result = gradeClaims(
        scenario,
        corpus.facts,
        { commanders: commanders.data, main: observedMain },
        { legal: verdict === true },
      );
      if (
        !same(cap.observed, { legal: verdict, failures: result.failures }) ||
        cap.status !== (result.passed ? "pass" : "fail")
      )
        fail("Incorrect copy-limit corruption grade");
    }
  }
  return errors;
}
