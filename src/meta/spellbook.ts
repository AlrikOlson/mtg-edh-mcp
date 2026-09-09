/**
 * Commander Spellbook combo enrichment (spec §5E/§12). POSTs a deck's card list
 * to the Commander Spellbook "find my combos" endpoint (through the
 * {@link CacheStore}) and retains provider inventory categories and execution
 * evidence. Inventory inclusion alone does not establish that a combo can run.
 *
 * Each combo carries its source + a confidence flag, since coverage is good but
 * not exhaustive. Like the EDHREC client, the HTTP boundary is an injectable
 * fetcher so parsing is unit-testable offline.
 */
import { USER_AGENT } from "../types/index.js";
import { z } from "zod";
import type { CacheStore, CacheFreshness } from "./cache.js";

/** Combo data changes less often than prices; cache a query for a day. */
export const SPELLBOOK_TTL_MS = 24 * 60 * 60 * 1000;
export const SPELLBOOK_FIND_MY_COMBOS_URL = "https://backend.commanderspellbook.com/find-my-combos";

/** Injectable JSON fetch supporting a request init (for POST). */
export type FetchJson = (url: string, init?: RequestInit) => Promise<unknown>;

export type ComboProviderCategory =
  | "included"
  | "included_by_changing_commanders"
  | "almost_included"
  | "almost_included_by_adding_colors"
  | "almost_included_by_changing_commanders"
  | "almost_included_by_adding_colors_and_changing_commanders";

export interface ComboIngredient {
  quantity: number | null;
  zone_locations: string[] | null;
  battlefield_card_state: string | null;
  exile_card_state: string | null;
  library_card_state: string | null;
  graveyard_card_state: string | null;
  must_be_commander: boolean | null;
  /** Absent provider fields; explicit null is retained separately. */
  missing_fields: string[];
}

export interface ComboCardIngredient extends ComboIngredient {
  card: { id: number | null; name: string | null; oracle_id: string | null };
  /** One-based face index; explicit null means the whole card. */
  used_face: number | null;
}

export interface ComboTemplateIngredient extends ComboIngredient {
  template: {
    id: number | null;
    name: string | null;
    scryfall_query: string | null;
    scryfall_api: string | null;
  };
}

export interface ComboOutput {
  feature: {
    id: number | null;
    name: string | null;
    uncountable: boolean | null;
    status: string | null;
  };
  quantity: number | null;
  missing_fields: string[];
}

/** `pieces`, `produces`, `steps` and `confidence` remain legacy projections. */
export interface Combo {
  id: string;
  pieces: string[];
  produces: string[];
  steps?: string;
  source: "commander_spellbook";
  url: string;
  source_url: string;
  /** Provider inventory category projection; never execution confidence. */
  confidence?: "included" | "almost";
  status: string | null;
  uses: ComboCardIngredient[];
  requires: ComboTemplateIngredient[];
  outputs: ComboOutput[];
  mana_needed: string | null;
  mana_value_needed: number | null;
  easy_prerequisites: string | null;
  notable_prerequisites: string | null;
  description: string | null;
  notes: string | null;
  provider_category: ComboProviderCategory;
  /** Absent evidence, including null ingredient collections (never known empty). */
  missing_fields: string[];
}

export interface ComboResults {
  included: Combo[];
  almostIncluded: Combo[];
  includedByChangingCommanders: Combo[];
  almostIncludedByAddingColors: Combo[];
  almostIncludedByChangingCommanders: Combo[];
  almostIncludedByAddingColorsAndChangingCommanders: Combo[];
  coverage: {
    /** Completeness of this response, not completeness of Spellbook's catalog. */
    status: "complete" | "partial";
    provider_non_exhaustive: true;
    missing_categories: ComboProviderCategory[];
    next: string | null;
    total_count: number | null;
  };
  freshness?: CacheFreshness;
}

const nullableText = z.string().nullable().optional();
const nullableQuantity = z.number().int().positive().nullable().optional();
const nullableId = z.number().int().nonnegative().nullable().optional();
const nullableBoolean = z.boolean().nullable().optional();
const recordSchema = z.record(z.string(), z.unknown());
const ingredientSchema = z.object({
  quantity: nullableQuantity,
  zone_locations: z.array(z.string()).nullable().optional(),
  battlefield_card_state: nullableText,
  exile_card_state: nullableText,
  library_card_state: nullableText,
  graveyard_card_state: nullableText,
  must_be_commander: nullableBoolean,
});
const cardSchema = z.object({ id: nullableId, name: nullableText, oracle_id: nullableText });
const templateSchema = z.object({
  id: nullableId,
  name: nullableText,
  scryfall_query: nullableText,
  scryfall_api: nullableText,
});
const featureSchema = z.object({
  id: nullableId,
  name: nullableText,
  uncountable: nullableBoolean,
  status: nullableText,
});
const variantSchema = z.object({
  id: z.union([z.string().min(1), z.number().int().nonnegative()]),
  status: nullableText,
  mana_needed: nullableText,
  mana_value_needed: z.number().int().nonnegative().nullable().optional(),
  easy_prerequisites: nullableText,
  notable_prerequisites: nullableText,
  description: nullableText,
  notes: nullableText,
});
const CATEGORY_KEYS = {
  included: "included",
  includedByChangingCommanders: "included_by_changing_commanders",
  almostIncluded: "almost_included",
  almostIncludedByAddingColors: "almost_included_by_adding_colors",
  almostIncludedByChangingCommanders: "almost_included_by_changing_commanders",
  almostIncludedByAddingColorsAndChangingCommanders:
    "almost_included_by_adding_colors_and_changing_commanders",
} satisfies Record<string, ComboProviderCategory>;

/** Live JSON is camelCase; archived/provider fixtures can use snake_case. */
function providerRecord(raw: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(recordSchema.parse(raw)).map(([key, value]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      value,
    ]),
  );
}

function missingFields(raw: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields.filter((field) => raw[field] === undefined);
}

function ingredient(raw: Record<string, unknown>): ComboIngredient {
  const value = ingredientSchema.parse(raw);
  return {
    quantity: value.quantity ?? null,
    zone_locations: value.zone_locations ?? null,
    battlefield_card_state: value.battlefield_card_state ?? null,
    exile_card_state: value.exile_card_state ?? null,
    library_card_state: value.library_card_state ?? null,
    graveyard_card_state: value.graveyard_card_state ?? null,
    must_be_commander: value.must_be_commander ?? null,
    missing_fields: missingFields(raw, Object.keys(ingredientSchema.shape)),
  };
}

function cardIngredient(raw: unknown): ComboCardIngredient {
  const value = providerRecord(raw);
  const cardRaw = providerRecord(value.card ?? {});
  const card = cardSchema.parse(cardRaw);
  const base = ingredient(value);
  return {
    ...base,
    card: { id: card.id ?? null, name: card.name ?? null, oracle_id: card.oracle_id ?? null },
    used_face: nullableQuantity.parse(value.used_face) ?? null,
    missing_fields: [
      ...base.missing_fields,
      ...missingFields(value, ["used_face", "card"]),
      ...missingFields(cardRaw, Object.keys(cardSchema.shape)).map((field) => `card.${field}`),
    ],
  };
}

function templateIngredient(raw: unknown): ComboTemplateIngredient {
  const value = providerRecord(raw);
  const templateRaw = providerRecord(value.template ?? {});
  const template = templateSchema.parse(templateRaw);
  const base = ingredient(value);
  return {
    ...base,
    template: {
      id: template.id ?? null,
      name: template.name ?? null,
      scryfall_query: template.scryfall_query ?? null,
      scryfall_api: template.scryfall_api ?? null,
    },
    missing_fields: [
      ...base.missing_fields,
      ...missingFields(value, ["template"]),
      ...missingFields(templateRaw, Object.keys(templateSchema.shape)).map(
        (field) => `template.${field}`,
      ),
    ],
  };
}

function comboOutput(raw: unknown): ComboOutput {
  const value = providerRecord(raw);
  const featureRaw = providerRecord(value.feature ?? {});
  const feature = featureSchema.parse(featureRaw);
  return {
    feature: {
      id: feature.id ?? null,
      name: feature.name ?? null,
      uncountable: feature.uncountable ?? null,
      status: feature.status ?? null,
    },
    quantity: nullableQuantity.parse(value.quantity) ?? null,
    missing_fields: [
      ...missingFields(value, ["quantity", "feature"]),
      ...missingFields(featureRaw, Object.keys(featureSchema.shape)).map(
        (field) => `feature.${field}`,
      ),
    ],
  };
}

function providerArray(raw: unknown): unknown[] {
  return raw == null ? [] : z.array(z.unknown()).parse(raw);
}

function parseVariant(raw: unknown, category: ComboProviderCategory): Combo {
  const value = providerRecord(raw);
  const variant = variantSchema.parse(value);
  const uses = providerArray(value.uses).map(cardIngredient);
  const requires = providerArray(value.requires).map(templateIngredient);
  const outputs = providerArray(value.produces).map(comboOutput);
  return {
    id: String(variant.id),
    pieces: uses.flatMap((entry) => (entry.card.name === null ? [] : [entry.card.name])),
    produces: outputs.flatMap((entry) => (entry.feature.name === null ? [] : [entry.feature.name])),
    steps: variant.description ?? undefined,
    source: "commander_spellbook",
    url: `https://commanderspellbook.com/combo/${encodeURIComponent(String(variant.id))}/`,
    source_url: SPELLBOOK_FIND_MY_COMBOS_URL,
    confidence: category.startsWith("included") ? "included" : "almost",
    status: variant.status ?? null,
    uses,
    requires,
    outputs,
    mana_needed: variant.mana_needed ?? null,
    mana_value_needed: variant.mana_value_needed ?? null,
    easy_prerequisites: variant.easy_prerequisites ?? null,
    notable_prerequisites: variant.notable_prerequisites ?? null,
    description: variant.description ?? null,
    notes: variant.notes ?? null,
    provider_category: category,
    missing_fields: [
      ...missingFields(value, Object.keys(variantSchema.shape)),
      ...["uses", "requires", "produces"].filter((field) => value[field] == null),
      ...outputs.flatMap((output, index) =>
        output.missing_fields.map((field) => `outputs.${index}.${field}`),
      ),
    ],
  };
}

function hasUnavailableIngredientEvidence(entry: ComboIngredient): boolean {
  return (
    entry.missing_fields.length > 0 ||
    entry.quantity === null ||
    entry.zone_locations === null ||
    entry.zone_locations.length === 0 ||
    entry.must_be_commander === null ||
    entry.battlefield_card_state === null ||
    entry.exile_card_state === null ||
    entry.library_card_state === null ||
    entry.graveyard_card_state === null
  );
}

/** Parse all provider categories; malformed responses must not poison the cache. */
export function parseCombos(json: unknown): ComboResults {
  const envelope = providerRecord(json);
  const root = envelope.results === undefined ? envelope : providerRecord(envelope.results);
  if (!Object.values(CATEGORY_KEYS).some((category) => category in root)) {
    throw new Error("Commander Spellbook response contains no combo categories");
  }
  const parseCategory = (category: ComboProviderCategory): Combo[] => {
    if (root[category] === undefined) return [];
    return z
      .array(z.unknown())
      .parse(root[category])
      .map((raw) => parseVariant(raw, category));
  };
  const categories = {
    included: parseCategory(CATEGORY_KEYS.included),
    includedByChangingCommanders: parseCategory(CATEGORY_KEYS.includedByChangingCommanders),
    almostIncluded: parseCategory(CATEGORY_KEYS.almostIncluded),
    almostIncludedByAddingColors: parseCategory(CATEGORY_KEYS.almostIncludedByAddingColors),
    almostIncludedByChangingCommanders: parseCategory(
      CATEGORY_KEYS.almostIncludedByChangingCommanders,
    ),
    almostIncludedByAddingColorsAndChangingCommanders: parseCategory(
      CATEGORY_KEYS.almostIncludedByAddingColorsAndChangingCommanders,
    ),
  };
  const missingCategories = Object.values(CATEGORY_KEYS).filter(
    (category) => root[category] === undefined,
  );
  const next = nullableText.parse(envelope.next) ?? null;
  const totalCount = nullableId.parse(envelope.count) ?? null;
  const allCombos = Object.values(categories).flat();
  const hasSparseEvidence = allCombos.some(
    (combo) =>
      combo.missing_fields.length > 0 ||
      combo.status === null ||
      combo.mana_needed === null ||
      combo.mana_value_needed === null ||
      combo.easy_prerequisites === null ||
      combo.notable_prerequisites === null ||
      combo.description === null ||
      combo.notes === null ||
      [...combo.uses, ...combo.requires].some(hasUnavailableIngredientEvidence) ||
      combo.uses.some((entry) => entry.card.id === null || entry.card.name === null) ||
      combo.requires.some((entry) => entry.template.id === null || entry.template.name === null) ||
      combo.outputs.some(
        (output) =>
          output.quantity === null || Object.values(output.feature).some((value) => value === null),
      ),
  );
  const paginationComplete =
    envelope.next !== undefined &&
    next === null &&
    totalCount !== null &&
    totalCount === allCombos.length;
  return {
    ...categories,
    coverage: {
      status:
        missingCategories.length > 0 || !paginationComplete || hasSparseEvidence
          ? "partial"
          : "complete",
      provider_non_exhaustive: true,
      missing_categories: missingCategories,
      next,
      total_count: totalCount,
    },
  };
}

const defaultFetchJson: FetchJson = async (url, init) => {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      ...init?.headers,
    },
  });
  if (!res.ok) throw new Error(`Commander Spellbook HTTP ${res.status}`);
  return res.json();
};

export interface SpellbookClientOptions {
  fetchJson?: FetchJson;
  ttlMs?: number;
}

/** A compact deck entry; quantities are never expanded into repeated strings. */
export interface SpellbookCardEntry {
  card: string;
  quantity: number;
}

const deckQuantitySchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const cardEntrySchema = z.object({ card: z.string(), quantity: deckQuantitySchema });

/** Client for Commander Spellbook's find-my-combos, cached + degrading. */
export class SpellbookClient {
  private readonly cache: CacheStore;
  private readonly fetchJson: FetchJson;
  private readonly ttlMs: number;

  constructor(cache: CacheStore, options: SpellbookClientOptions = {}) {
    this.cache = cache;
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.ttlMs = options.ttlMs ?? SPELLBOOK_TTL_MS;
  }

  /** Combos reachable from a deck (its commanders + main cards), cached. */
  async findMyCombos(
    commanders: readonly (string | SpellbookCardEntry)[],
    cards: readonly (string | SpellbookCardEntry)[],
  ): Promise<ComboResults & { freshness: CacheFreshness }> {
    const body = JSON.stringify({ commanders: cardEntries(commanders), main: cardEntries(cards) });
    const result = await this.cache.fetchWithMetadata(`spellbook:${body}`, this.ttlMs, async () =>
      parseCombos(
        await this.fetchJson(SPELLBOOK_FIND_MY_COMBOS_URL, {
          method: "POST",
          // The API requires {card, quantity} objects per entry — bare name strings
          // are rejected with HTTP 400 ("Expected a dictionary, but got str.").
          body,
        }),
      ),
    );
    return { ...result.value, freshness: result.freshness };
  }
}

/** Aggregate and sort entries once for both the request and collision-safe cache key. */
function cardEntries(entries: readonly (string | SpellbookCardEntry)[]): SpellbookCardEntry[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const { card, quantity } = cardEntrySchema.parse(
      typeof entry === "string" ? { card: entry, quantity: 1 } : entry,
    );
    counts.set(card, deckQuantitySchema.parse((counts.get(card) ?? 0) + quantity));
  }
  return [...counts]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([card, quantity]) => ({ card, quantity }));
}
