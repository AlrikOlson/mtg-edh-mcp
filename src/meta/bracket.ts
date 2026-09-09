/**
 * Commander bracket / power-level classification (spec §5E/§12).
 *
 * The official Commander Brackets (beta) run 1 (Exhibition) → 5 (cEDH). The key
 * data input is the **Game Changers** list, which is published and updated by
 * Wizards — so it is FETCHED LIVE (through the {@link CacheStore}) and never
 * hardcoded here; see {@link GAME_CHANGERS_URL} for the current source.
 * `classifyBracket` is pure: it takes the fetched set as a parameter, so it's
 * fully unit-testable offline.
 *
 * Classification is heuristic and deliberately conservative. Game-Changer count
 * is the primary signal, mapped to the official tiers (verified against the
 * Commander Brackets Beta, incl. the Feb 2026 update):
 *   · Bracket 2 (Core)      — 0 Game Changers, no mass land denial
 *   · Bracket 3 (Upgraded)  — 1–3 Game Changers, no mass land denial
 *   · Bracket 4 (Optimized) — 4+ Game Changers, OR any mass land denial
 * Tutors do NOT gate the bracket — the beta removed tutor restrictions, so they
 * are reported as pushers only, never moved up a tier. cEDH (5) is a meta/intent
 * judgment we don't auto-assign — the ceiling here is 4.
 *
 * Combo inputs must pass bounded deck/configuration checks. Printed mana value
 * remains an advisory earliness proxy, never a turn or execution prediction.
 * Provider lookup status and non-exhaustive coverage accompany every estimate.
 */
import type { Card, Deck } from "../types/index.js";
import { USER_AGENT } from "../types/index.js";
import type { CacheStore, CacheFreshness } from "./cache.js";
import type { ComboResults } from "./spellbook.js";
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
  /** Two-card infinite combos present in the deck, as "Piece A + Piece B" labels. */
  combos: string[];
  /** Cards that grant an extra turn (a chain of these gates up a tier). */
  extra_turns: string[];
}

/**
 * A deck-reachable combo for bracket purposes, given as the oracle_ids of its
 * pieces. The caller (the tool layer) resolves Commander Spellbook combos to
 * the deck's cards and passes them in — classifyBracket stays pure + offline.
 */
export interface BracketCombo {
  pieces: readonly string[];
  /** Null is unknown; undefined preserves the legacy pure-caller proxy. */
  mana_value_needed?: number | null;
  uses_nondefault_face?: boolean;
}

/**
 * A two-card combo counts as "early" — and so pushes to Optimized — when its
 * pieces' combined mana value is this low (a proxy for "assembles by ~turn 3-4").
 */
export const EARLY_COMBO_MV = 5;

/** This many extra-turn cards is treated as a chain (Upgraded forbids chaining). */
export const EXTRA_TURN_CHAIN = 2;

export interface BracketComboEvidence {
  status: "available" | "unavailable" | "not_checked";
  freshness: CacheFreshness | null;
  coverage: ComboResults["coverage"] | null;
  candidate_count: number;
  supported_count: number;
  unknown_count: number;
  rejected_count: number;
  unresolved_oracle_ids: string[];
  error: { code: string; message: string } | null;
  absence_confirmed: false;
}

export interface BracketResult {
  /** 1 Exhibition · 2 Core · 3 Upgraded · 4 Optimized · 5 cEDH. */
  bracket: number;
  pushers: BracketPushers;
  rationale: string;
  provisional: true;
  combo_evidence: BracketComboEvidence;
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

/** A card that grants an extra turn (Time Warp "takes an extra turn", Temporal Manipulation "take an extra turn", …). */
function isExtraTurn(card: Card): boolean {
  return /takes? an extra turn/i.test(card.oracle_text);
}

/**
 * Classify a deck into a Commander bracket using a fetched Game Changers set.
 * Pure: the GC set is supplied by the caller (never hardcoded).
 */
export function classifyBracket(
  deck: Deck,
  lookup: CardLookup,
  gameChangers: ReadonlySet<string>,
  combos: readonly BracketCombo[] = [],
  comboEvidence: BracketComboEvidence = {
    status: "not_checked",
    freshness: null,
    coverage: null,
    candidate_count: 0,
    supported_count: 0,
    unknown_count: 0,
    rejected_count: 0,
    unresolved_oracle_ids: [],
    error: null,
    absence_confirmed: false,
  },
): BracketResult {
  const pushers: BracketPushers = {
    game_changers: [],
    fast_mana: [],
    tutors: [],
    mld: [],
    combos: [],
    extra_turns: [],
  };
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
    if (isExtraTurn(card)) pushers.extra_turns.push(card.name);
  }

  // Two-card combos (the official "two-card infinite combo" the tiers gate on).
  // Printed mana is only a proxy; supplied unknown/high mana or alternate faces
  // prevent the early promotion. It never establishes execution timing.
  const twoCard = combos.filter((c) => c.pieces.length === 2);
  let earlyCombo = false;
  for (const c of twoCard) {
    const cards = c.pieces.map((id) => lookup(id)).filter((x): x is Card => x !== null);
    const [first, second] = cards;
    if (first && second) {
      pushers.combos.push(`${first.name} + ${second.name}`);
      if (
        first.mv + second.mv <= EARLY_COMBO_MV &&
        c.mana_value_needed !== null &&
        (c.mana_value_needed ?? 0) <= EARLY_COMBO_MV &&
        !c.uses_nondefault_face
      )
        earlyCombo = true;
    }
  }
  const extraTurnChain = pushers.extra_turns.length >= EXTRA_TURN_CHAIN;

  const gc = pushers.game_changers.length;
  const base = gc >= 4 || pushers.mld.length > 0 ? 4 : gc >= 1 ? 3 : 2;
  // Combos/extra-turns only RAISE the floor, never lower the GC/MLD verdict.
  let comboFloor = 0;
  if (pushers.combos.length > 0) comboFloor = 3; // a two-card combo can't be Core (bracket 2)
  if (earlyCombo || extraTurnChain) comboFloor = 4; // early combo / extra-turn chain → Optimized
  const bracket = Math.max(base, comboFloor);

  const rationale =
    `${gc} Game Changer(s), ${pushers.fast_mana.length} fast-mana, ${pushers.tutors.length} tutor(s), ` +
    `${pushers.mld.length} mass-land-denial, ${pushers.combos.length} supported two-card combo candidate(s), ` +
    `${pushers.extra_turns.length} extra-turn card(s). Heuristic tiers: Core=0 GC, ` +
    `Upgraded=1–3 GC or a late two-card combo, Optimized=4+ GC / mass land denial / early combo / ` +
    `extra-turn chain (tutors don't gate). cEDH (5) is a meta/intent call and is not auto-assigned.`;
  return {
    bracket,
    pushers,
    provisional: true,
    combo_evidence: comboEvidence,
    rationale:
      rationale +
      ` Combo evidence: ${comboEvidence.status}` +
      ` (${comboEvidence.freshness?.status ?? "no observation"}; ${comboEvidence.coverage?.status ?? "unknown"} coverage); ` +
      `${comboEvidence.unknown_count} candidate(s) have unknown applicability. Combo absence is not established. ` +
      "Mana value is an earliness proxy; setup and execution are unknown.",
  };
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
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Game Changers HTTP ${res.status}`);
  return res.json();
};

/**
 * Default source: Scryfall's `is:gamechanger` search, which mirrors the official
 * WotC list and is versioned with the rest of the card data. (The former source,
 * json.edhrec.com/pages/game-changers.json, was withdrawn — it now 403s — so it
 * is no longer the default.)
 */
export const GAME_CHANGERS_URL =
  "https://api.scryfall.com/cards/search?q=is%3Agamechanger&unique=cards";

/** Stop following `next_page` after this many pages (the list is ~1 page). */
const MAX_PAGES = 10;

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
    // Configurable since the published location may move again.
    this.url = options.url ?? GAME_CHANGERS_URL;
  }

  /** Fetch every page of the source, following Scryfall-style `next_page` links. */
  private async fetchAll(): Promise<unknown[]> {
    const pages: unknown[] = [];
    let url: string | undefined = this.url;
    for (let i = 0; url && i < MAX_PAGES; i += 1) {
      const page: unknown = await this.fetchJson(url);
      pages.push(page);
      const { has_more, next_page } = (page ?? {}) as {
        has_more?: unknown;
        next_page?: unknown;
      };
      url = has_more === true && typeof next_page === "string" ? next_page : undefined;
    }
    return pages;
  }

  /** The current Game Changers card-name set (cached; degrades via CacheStore). */
  async list(): Promise<Set<string>> {
    const pages = await this.cache.fetch("game-changers", this.ttlMs, () => this.fetchAll());
    const names = new Set<string>();
    for (const page of pages) {
      for (const name of parseGameChangers(page)) names.add(name);
    }
    return names;
  }
}
