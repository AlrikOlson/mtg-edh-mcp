/**
 * Description conformance lint (ergo-descriptions): every tool description on
 * the WIRE (tools/list, exactly what an agent's harness sees) must follow the
 * workflow-teaching template:
 *
 *   <Imperative one-liner.>
 *   USE: <triggers>. NOT: <anti-use -> right tool>.
 *   FLOW: <predecessors> -> this -> <successors>.
 *   ARGS: <key params, defaults>.
 *   RETURNS: <top-level structuredContent keys + semantics>.
 *
 * The FLOW cross-check makes descriptions rot-proof: renaming or deleting a
 * tool that another description points at fails this suite.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { DeckStore } from "../deck/index.js";
import { createServer } from "./createServer.js";
import { staticSnapshotProvider } from "./snapshot.js";

const ORACLE = [
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
];

const EXPECTED_TOOL_COUNT = 50;
const MAX_DESCRIPTION_CHARS = 700;

const TEMPLATE =
  /^[^\n]+\.\nUSE: [^\n]+\. NOT: [^\n]+\nFLOW: [^\n]+ -> [^\n]+\nARGS: [^\n]+\nRETURNS: [\s\S]+$/;

/** Tool-name-shaped tokens inside a FLOW line. */
const FLOW_TOOL_TOKEN =
  /\b(?:ping|budget_plan|simulate_deck|(?:card|deck|meta|analyze|validate|collection|data|rules)_[a-z_]+)\b/g;

/** The lint-pinned read-only set (ergo-protocol): drift in either direction fails. */
const READ_ONLY_TOOLS = [
  "ping",
  "data_status",
  "card_search",
  "card_get",
  "card_resolve_name",
  "card_printings",
  "card_mechanics",
  "card_rulings",
  "rules_lookup",
  "rules_search",
  "collection_get",
  "deck_get",
  "deck_get_intent",
  "deck_list",
  "deck_diff",
  "deck_export",
  "deck_status",
  "validate_deck",
  "validate_card",
  "validate_commander",
  "analyze_curve",
  "analyze_composition",
  "analyze_stats",
  "analyze_mana_base",
  "analyze_role_coverage",
  "simulate_deck",
  "budget_plan",
  "meta_commander_profile",
  "meta_recommend",
  "meta_budget_swaps",
  "meta_combos",
  "meta_classify_bracket",
  "meta_check_policy",
].sort();

/** Tools that reach the network (openWorldHint: true). */
const OPEN_WORLD_TOOLS = [
  "data_ingest",
  "rules_refresh",
  "meta_commander_profile",
  "meta_recommend",
  "meta_budget_swaps",
  "meta_combos",
  "meta_classify_bracket",
  "meta_check_policy",
].sort();

// Keep the established catalog contract: no advertised outputSchema. Earlier
// declarations were removed after strict-client rejection of SDK v1 draft-07.
// The SDK migration preserves this policy; re-enabling needs real host validation.

interface WireTool {
  name: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  outputSchema?: Record<string, unknown>;
}

let root: string;
let index: CardIndex;
let client: Client;
let tools: WireTool[];

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-desc-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
  await store.publish("v1");
  index = CardIndex.open((await buildIndex({ store })).dbPath);
  const deckStore = new DeckStore();

  const server = createServer({
    index,
    deckStore,
    snapshot: staticSnapshotProvider("2026-06-27"),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "desc-lint", version: "0.0.0" });
  await client.connect(ct);
  tools = (await client.listTools()).tools;
});
afterAll(async () => {
  await client.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

describe("tool description conformance (the wire is the contract)", () => {
  it(`registers exactly ${EXPECTED_TOOL_COUNT} tools`, () => {
    expect(tools.map((t) => t.name).sort()).toHaveLength(EXPECTED_TOOL_COUNT);
  });

  it("every description follows the USE/NOT/FLOW/ARGS/RETURNS template within the length cap", () => {
    const offenders: string[] = [];
    for (const tool of tools) {
      const d = tool.description ?? "";
      if (!TEMPLATE.test(d)) offenders.push(`${tool.name}: template mismatch`);
      if (d.length > MAX_DESCRIPTION_CHARS) {
        offenders.push(`${tool.name}: ${d.length} chars (max ${MAX_DESCRIPTION_CHARS})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("FLOW lines only reference tools that actually exist", () => {
    const names = new Set(tools.map((t) => t.name));
    const offenders: string[] = [];
    for (const tool of tools) {
      const flowLine = (tool.description ?? "")
        .split("\n")
        .find((line) => line.startsWith("FLOW: "));
      for (const token of flowLine?.match(FLOW_TOOL_TOKEN) ?? []) {
        if (!names.has(token)) offenders.push(`${tool.name} -> FLOW references unknown '${token}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no description carries stale baggage", () => {
    const stale = tools.filter((t) =>
      /not yet available|deprecated|TODO/i.test(t.description ?? ""),
    );
    expect(stale.map((t) => t.name)).toEqual([]);
  });
});

describe("tool annotations (ergo-protocol)", () => {
  it("every tool carries annotations", () => {
    const missing = tools.filter((t) => !t.annotations).map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it("the read-only set exactly matches the pinned list", () => {
    const readOnly = tools
      .filter((t) => t.annotations?.readOnlyHint === true)
      .map((t) => t.name)
      .sort();
    expect(readOnly).toEqual(READ_ONLY_TOOLS);
  });

  it("mutators declare destructive + idempotent hints explicitly", () => {
    const incomplete = tools
      .filter((t) => t.annotations?.readOnlyHint === false)
      .filter(
        (t) =>
          typeof t.annotations?.destructiveHint !== "boolean" ||
          typeof t.annotations?.idempotentHint !== "boolean",
      )
      .map((t) => t.name);
    expect(incomplete).toEqual([]);
  });

  it("openWorldHint marks exactly the network-reaching tools", () => {
    const openWorld = tools
      .filter((t) => t.annotations?.openWorldHint === true)
      .map((t) => t.name)
      .sort();
    expect(openWorld).toEqual(OPEN_WORLD_TOOLS);
  });

  it("preserves the catalog without advertised output schemas", () => {
    const offenders = tools.filter((t) => t.outputSchema !== undefined).map((t) => t.name);
    expect(offenders).toEqual([]);
  });
});
