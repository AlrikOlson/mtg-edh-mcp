/**
 * Commander bracket / power-level classification (spec §5E/§12).
 *
 * The official Commander Brackets (beta) run 1 (Exhibition) → 5 (cEDH). The key
 * data input is the **Game Changers** list, which is published and updated by
 * Wizards — so it is FETCHED LIVE (through the {@link CacheStore}) and never
 * hardcoded here. `classifyBracket` is pure: it takes the fetched set as a
 * parameter, so it's fully unit-testable offline.
 *
 * Classification is heuristic and deliberately conservative: Game-Changer count
 * is the primary signal; mass land denial bumps to Optimized. cEDH (5) is a
 * meta/intent judgment we don't auto-assign — the ceiling here is 4.
 */
import type { Card, Deck } from "../types/index.js";
import { USER_AGENT } from "../types/index.js";
import type { CacheStore } from "./cache.js";
import type { FetchJson } from "./edhrec.js";

/** Game Changers lists change with set releases; cache for a week. */
export const GAME_CHANGERS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Resolves an oracle_id to its Card, or null. */
export type CardLookup = (oracleId: string) => Card | null;

export interface BracketPushers {
  game_changers: string[];
  fast_mana: string[];
  tutors: string[];
  mld: string[];
}

export interface BracketResult {
  /** 1 Exhibition · 2 Core · 3 Upgraded · 4 Optimized · 5 cEDH. */
  bracket: number;
  pushers: BracketPushers;
  rationale: string;
}

function isMassLandDenial(card: Card): boolean {
  return (
    /destroy all lands/i.test(card.oracle_text) ||
    /each player sacrifices[^.]*land/i.test(card.oracle_text) ||
    /\bArmageddon\b/i.test(card.name)
  );
}

/** Documented heuristic: a cheap rock/ritual making 2+ mana (Sol Ring, Mana Crypt, …). */
function isFastMana(card: Card): boolean {
  const ramps = card.roles.includes("mana_rock") || card.roles.includes("ramp");
  const twoPlus = /add\b[^.]*\{[^}]+\}[^.]*\{[^}]+\}/i.test(card.oracle_text);
  return ramps && card.mv <= 1 && twoPlus;
}

/**
 * Classify a deck into a Commander bracket using a fetched Game Changers set.
 * Pure: the GC set is supplied by the caller (never hardcoded).
 */
export function classifyBracket(
  deck: Deck,
  lookup: CardLookup,
  gameChangers: ReadonlySet<string>,
): BracketResult {
  const pushers: BracketPushers = { game_changers: [], fast_mana: [], tutors: [], mld: [] };
  const seen = new Set<string>();
  for (const oracleId of [...deck.commanders, ...deck.cards.map((e) => e.oracle_id)]) {
    if (seen.has(oracleId)) continue;
    seen.add(oracleId);
    const card = lookup(oracleId);
    if (!card) continue;
    if (gameChangers.has(card.name)) pushers.game_changers.push(card.name);
    if (card.roles.includes("tutor")) pushers.tutors.push(card.name);
    if (isFastMana(card)) pushers.fast_mana.push(card.name);
    if (isMassLandDenial(card)) pushers.mld.push(card.name);
  }

  const gc = pushers.game_changers.length;
  let bracket: number;
  if (gc >= 4 || pushers.mld.length > 0) bracket = 4;
  else if (gc >= 1) bracket = 3;
  else bracket = 2;

  const rationale =
    `${gc} Game Changer(s), ${pushers.fast_mana.length} fast-mana, ${pushers.tutors.length} tutor(s), ` +
    `${pushers.mld.length} mass-land-denial. cEDH (5) is a meta/intent call and is not auto-assigned.`;
  return { bracket, pushers, rationale };
}

/** Defensive parse of a Game Changers payload into a name set. */
export function parseGameChangers(json: unknown): Set<string> {
  const out = new Set<string>();
  const push = (v: unknown): void => {
    if (typeof v === "string") out.add(v);
    else if (v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string") {
      out.add((v as { name: string }).name);
    }
  };
  if (Array.isArray(json)) json.forEach(push);
  else if (json && typeof json === "object") {
    const cards =
      (json as { cards?: unknown; data?: unknown }).cards ?? (json as { data?: unknown }).data;
    if (Array.isArray(cards)) cards.forEach(push);
  }
  return out;
}

const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Game Changers HTTP ${res.status}`);
  return res.json();
};

export interface GameChangersClientOptions {
  fetchJson?: FetchJson;
  ttlMs?: number;
  /** Override the source URL (the published list location may change). */
  url?: string;
}

/** Fetches + caches the live Game Changers list. */
export class GameChangersClient {
  private readonly cache: CacheStore;
  private readonly fetchJson: FetchJson;
  private readonly ttlMs: number;
  private readonly url: string;

  constructor(cache: CacheStore, options: GameChangersClientOptions = {}) {
    this.cache = cache;
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.ttlMs = options.ttlMs ?? GAME_CHANGERS_TTL_MS;
    // Published Game Changers list (JSON). Configurable since the location may move.
    this.url = options.url ?? "https://json.edhrec.com/pages/game-changers.json";
  }

  /** The current Game Changers card-name set (cached; degrades via CacheStore). */
  async list(): Promise<Set<string>> {
    const raw = await this.cache.fetch("game-changers", this.ttlMs, () => this.fetchJson(this.url));
    return parseGameChangers(raw);
  }
}
