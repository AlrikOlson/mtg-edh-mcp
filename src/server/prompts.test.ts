/**
 * Prompt conformance (ergo-prompts): the workflow prompts are asserted on the
 * WIRE (prompts/list + prompts/get), and every tool-shaped token in a prompt
 * text must exist in the live tool registry — renaming a tool that a recipe
 * references fails this suite, same rot-proofing as the FLOW lines.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

const EXPECTED_PROMPTS = ["build_commander_deck", "fit_budget", "tune_deck"];

const TOOL_TOKEN =
  /\b(?:ping|budget_plan|simulate_deck|(?:card|deck|meta|analyze|validate|collection|data)_[a-z_]+)\b/g;

/** Tokens that match the tool-name shape but are FIELD names, not tools. */
const NON_TOOL_TOKENS = new Set(["deck_id", "card_count", "data_snapshot"]);

let root: string;
let index: CardIndex;
let client: Client;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-prompts-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
  await store.publish("v1");
  index = CardIndex.open((await buildIndex({ store })).dbPath);

  const server = createServer({
    index,
    deckStore: new DeckStore(),
    snapshot: staticSnapshotProvider("2026-06-27"),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "prompt-lint", version: "0.0.0" });
  await client.connect(ct);
});
afterAll(async () => {
  await client.close();
  index.close();
  await rm(root, { recursive: true, force: true });
});

async function promptText(name: string, args: Record<string, string>): Promise<string> {
  const res = await client.getPrompt({ name, arguments: args });
  const first = res.messages[0];
  expect(first?.role).toBe("user");
  const content = first?.content as { type: string; text: string };
  expect(content.type).toBe("text");
  return content.text;
}

describe("workflow prompts (ergo-prompts)", () => {
  it("advertises exactly the three workflow prompts with their arguments", async () => {
    const listed = await client.listPrompts();
    expect(listed.prompts.map((p) => p.name).sort()).toEqual(EXPECTED_PROMPTS);
    const build = listed.prompts.find((p) => p.name === "build_commander_deck");
    const argNames = (build?.arguments ?? []).map((a) => a.name).sort();
    expect(argNames).toEqual(["budget_usd", "commander", "theme"]);
    expect(build?.arguments?.find((a) => a.name === "commander")?.required).toBe(true);
    expect(build?.arguments?.find((a) => a.name === "theme")?.required).toBeFalsy();
  });

  it("build_commander_deck interpolates the commander and includes the budget pass only when asked", async () => {
    const plain = await promptText("build_commander_deck", { commander: "Sol Ring" });
    expect(plain).toContain('deck_set_commander {commanders: "Sol Ring"}');
    expect(plain).not.toContain("Budget pass");

    const budgeted = await promptText("build_commander_deck", {
      commander: "Sol Ring",
      budget_usd: "150",
    });
    expect(budgeted).toContain("Budget pass (target $150)");
  });

  it("tune_deck and fit_budget interpolate their ids and targets", async () => {
    expect(await promptText("tune_deck", { deck_id: "deck-42" })).toContain(
      'deck_status {deck_id: "deck-42"}',
    );
    const fit = await promptText("fit_budget", { deck_id: "deck-42", target_usd: "100" });
    expect(fit).toContain("under $100");
    expect(fit).toContain("target_usd: 100");
  });

  it("every tool named in a prompt text exists in the live tool registry", async () => {
    const toolNames = new Set((await client.listTools()).tools.map((t) => t.name));
    const offenders: string[] = [];
    for (const name of EXPECTED_PROMPTS) {
      const args: Record<string, string> =
        name === "build_commander_deck"
          ? { commander: "X", theme: "y", budget_usd: "1" }
          : name === "fit_budget"
            ? { deck_id: "d", target_usd: "1" }
            : { deck_id: "d" };
      const text = await promptText(name, args);
      for (const token of text.match(TOOL_TOKEN) ?? []) {
        if (NON_TOOL_TOKENS.has(token)) continue;
        if (!toolNames.has(token)) offenders.push(`${name} references unknown '${token}'`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
