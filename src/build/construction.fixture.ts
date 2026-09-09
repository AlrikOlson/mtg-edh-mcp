import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import discoveryCorpus from "../../docs/evaluation/discovery-corpus.json" with { type: "json" };
import corpus from "./construction-cards.json" with { type: "json" };
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { ConstructionRequestSchema, type ConstructionRequest } from "../types/construction.js";

/** Real Oracle records frozen before running the builder; no provider or network is used by tests. */
export const constructionCards = [
  ...new Map(
    [...corpus.cards, ...discoveryCorpus.cards].map((card) => [card.oracle_id, card]),
  ).values(),
];
export const constructionProvenance = {
  source: corpus.source,
  frozen_at: corpus.frozen_at,
  purpose: corpus.purpose,
};

export function constructionCardId(name: string): string {
  const card = constructionCards.find((candidate) => candidate.name === name);
  if (!card) throw new Error(`Missing pinned construction card: ${name}`);
  return card.oracle_id;
}

export async function constructionFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "mtg-construction-"));
  const store = new VersionedStore(root);
  const snapshot = constructionProvenance.frozen_at;
  await store.createVersion(snapshot);
  await writeFile(store.filePath(snapshot, "oracle_cards.json"), JSON.stringify(constructionCards));
  await writeFile(store.filePath(snapshot, "default_cards.json"), "[]");
  await store.publish(snapshot);
  const index = CardIndex.open((await buildIndex({ store })).dbPath);
  return {
    index,
    async close() {
      index.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export interface ConstructionCase {
  id: string;
  coverage: readonly string[];
  request: ConstructionRequest;
  expected: {
    colorCount: number;
    commanderCount: number;
    companion?: string;
    requiredCards: Array<{ oracle_id: string; qty: number }>;
    minimumNonlands: number;
  };
}

const entry = (name: string, qty = 1) => ({ oracle_id: constructionCardId(name), qty });
const required = (...names: string[]) => names.map((name) => entry(name));

function scenario(
  id: string,
  coverage: string[],
  colorCount: number,
  commanders: string[],
  strategyCards: string[],
  patch: Record<string, unknown> = {},
  copies: Array<{ oracle_id: string; qty: number }> = [],
): ConstructionCase {
  const request = ConstructionRequestSchema.parse({
    commanders,
    command_zone_kind: commanders.length === 1 ? "single" : "partner",
    budget: { mode: "unbounded" },
    lands: { min: 36, max: 38, strength: "hard" },
    // Overlapping classifier labels are composition constraints, not gameplay-quality scores.
    roles: {
      ramp: { min: 8, max: 30, strength: "hard" },
      card_draw: { min: 6, max: 30, strength: "hard" },
      spot_removal: { min: 5, max: 20, strength: "hard" },
    },
    strategy_dependencies: [
      { id: `${id}-ingredients`, strength: "hard", requires_cards: strategyCards },
    ],
    ...(copies.length ? { intent: { schema_version: 1, hard: { locked_cards: copies } } } : {}),
    ...patch,
  });
  return {
    id,
    coverage,
    request,
    expected: {
      colorCount,
      commanderCount: commanders.length,
      ...(request.companion ? { companion: constructionCardId(request.companion) } : {}),
      requiredCards: [...required(...strategyCards), ...copies],
      minimumNonlands: 100 - commanders.length - 38,
    },
  };
}

/**
 * Independent, pinned composition tasks. These measure legal construction and
 * declared strategy support on real cards, not win rate or human deck quality.
 * Every task starts empty or partial, requires >=60 nonlands and three functional
 * roles, and declares a distinct strategy package. All records lack providers.
 */
export const constructionCases: readonly ConstructionCase[] = [
  scenario(
    "colorless-artifact-recovery",
    ["empty", "colorless", "providers_absent"],
    0,
    ["Liberator, Urza's Battlethopter"],
    ["Scrap Trawler", "Myr Retriever", "Foundry Inspector"],
    { theme: "artifacts" },
  ),
  scenario(
    "mono-black-small-creatures",
    ["partial", "one_color", "providers_absent"],
    1,
    ["Shirei, Shizo's Caretaker"],
    ["Blood Pet", "Viscera Seer", "Zulaport Cutthroat"],
    { cards: [entry("Swamp", 8), entry("Blood Pet")], theme: "sacrifice" },
  ),
  scenario(
    "two-color-explore",
    ["empty", "two_colors", "obscure_commander", "providers_absent"],
    2,
    ["Nicanzil, Current Conductor"],
    ["Path of Discovery", "Topography Tracker", "Merfolk Branchwalker"],
    { theme: "explore" },
  ),
  scenario(
    "theme-first-three-color-discard",
    ["partial", "theme_first", "three_colors", "recent_commander", "providers_absent"],
    3,
    ["Hashaton, Scarab's Fist"],
    ["Putrid Imp", "Skirge Familiar", "Myr Battlesphere"],
    {
      commanders: undefined,
      command_zone_kind: undefined,
      cards: [entry("Swamp", 5), entry("Putrid Imp")],
      theme: "discard",
    },
  ),
  scenario(
    "four-color-counters",
    ["empty", "four_colors", "providers_absent"],
    4,
    ["Atraxa, Praetors' Voice"],
    ["Contagion Clasp", "Steel Overseer", "Hangarback Walker"],
    { theme: "counters" },
  ),
  scenario(
    "five-color-reanimation",
    ["empty", "five_colors", "providers_absent"],
    5,
    ["Kenrith, the Returned King"],
    ["Satyr Wayfinder", "Myr Battlesphere", "Zulaport Cutthroat"],
    { theme: "graveyard" },
  ),
  scenario(
    "obscure-token-sacrifice",
    ["partial", "obscure_commander", "providers_absent"],
    2,
    ["Lagomos, Hand of Hatred"],
    ["Goblin Wizardry", "Ruthless Knave", "Blood Artist"],
    { cards: [entry("Mountain", 4), entry("Goblin Wizardry")], theme: "tokens" },
  ),
  scenario(
    "alternative-scry-partners",
    ["empty", "explicit_alternatives", "legal_partner", "providers_absent"],
    1,
    ["Eligeth, Crossroads Augur", "Siani, Eye of the Storm"],
    ["Cryptic Annelid", "Mystic Speculation", "Tome of Legends"],
    {
      commanders: undefined,
      command_zone_kind: undefined,
      command_zone_alternatives: [
        {
          commanders: ["Eligeth, Crossroads Augur", "Siani, Eye of the Storm"],
          command_zone_kind: "partner",
        },
      ],
      theme: "scry",
    },
  ),
  scenario(
    "background-combat-draw",
    ["empty", "legal_background", "providers_absent"],
    2,
    ["Wilson, Refined Grizzly", "Candlekeep Sage"],
    ["Mask of Memory", "Skullclamp", "Veilstone Amulet"],
    { command_zone_kind: "background", theme: "card draw" },
  ),
  scenario(
    "doctor-historic-artifacts",
    ["partial", "legal_doctor_companion", "providers_absent"],
    3,
    ["The Fourth Doctor", "Sarah Jane Smith"],
    ["Academy Manufactor", "Inspiring Statuary", "Myr Sire"],
    { command_zone_kind: "doctor_companion", cards: [entry("Myr Sire")], theme: "artifacts" },
  ),
  scenario(
    "five-color-jegantha-companion",
    ["empty", "supported_companion", "providers_absent"],
    5,
    ["Kenrith, the Returned King"],
    ["Academy Manufactor", "Mind Stone", "Foundry Inspector"],
    { companion: "Jegantha, the Wellspring", theme: "artifacts" },
  ),
  scenario(
    "seven-dwarves-finite-multiplicity",
    ["partial", "finite_multiplicity", "providers_absent"],
    1,
    ["Magda, Brazen Outlaw"],
    ["Inspiring Statuary", "Skullclamp", "Dwarven Recruiter"],
    { cards: [entry("Seven Dwarves", 2), entry("Mountain", 6)], theme: "treasure" },
    [entry("Seven Dwarves", 7)],
  ),
  scenario(
    "petitioners-any-number-multiplicity",
    ["partial", "any_number_multiplicity", "providers_absent"],
    1,
    ["Bruvac the Grandiloquent"],
    ["Tome of Legends", "Perpetual Timepiece", "Mystic Speculation"],
    { cards: [entry("Persistent Petitioners", 6), entry("Island", 8)], theme: "mill" },
    [entry("Persistent Petitioners", 24)],
  ),
];
