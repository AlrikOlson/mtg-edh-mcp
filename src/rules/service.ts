/**
 * Rules runtime service (Commander workshop: rules and combo intelligence).
 *
 * Holds the rules corpora one server process answers from, mirroring how the
 * card index is held: loaded once from disk without network at boot, swapped
 * atomically after an explicit refresh, and shared by every per-request HTTP
 * server. Status is always reported with the corpus so callers can see
 * whether an identifier came from a current, stale or missing release.
 */
import { readFile } from "node:fs/promises";
import { StructuredError } from "../types/index.js";
import type { ComprehensiveRulesProvenance, RulingsProvenance } from "../types/rules.js";
import type { ComprehensiveRulesCorpus } from "./comprehensive.js";
import { RulingsCorpus, parseRulingsText } from "./rulings.js";
import {
  RulesClient,
  RulesStore,
  openCurrentRules,
  refreshRules,
  type OpenRules,
} from "./store.js";

/** The Comprehensive Rules change with each set; treat a month-old retrieval as stale. */
export const RULES_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface RulesCorpusStatus {
  /** `unavailable`: nothing on disk. `stale`: aged past the window or the last refresh failed. */
  status: "current" | "stale" | "unavailable";
  version: string | null;
  comprehensive_rules: ComprehensiveRulesProvenance | null;
  rulings: RulingsProvenance | null;
  /** Hours since the older of the two retrievals, rounded to one decimal; null when unavailable. */
  age_hours: number | null;
  stale_after_hours: number;
  /** True when the most recent refresh attempt in this process failed. */
  refresh_failed: boolean;
  last_refresh: { at: string; ok: boolean; skipped?: boolean; error?: string } | null;
  refreshing: boolean;
  /** True when the pointer's current version was unusable and its predecessor serves. */
  recovered_from_previous: boolean;
}

export type RefreshOutcome =
  | { ok: true; version: string; skipped: boolean }
  | { ok: false; error: { code: StructuredError["code"]; message: string } };

export interface RulesServiceOptions {
  /** Factory for the network client; called per refresh so tests inject stubs. */
  client?: () => RulesClient;
  now?: () => number;
  staleAfterMs?: number;
}

export class RulesService {
  private readonly store: RulesStore;
  private readonly makeClient: () => RulesClient;
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private open: OpenRules | null = null;
  private rulingsCache: { path: string; corpus: RulingsCorpus } | null = null;
  private lastRefresh: RulesCorpusStatus["last_refresh"] = null;
  private inFlight = false;

  constructor(store: RulesStore, options: RulesServiceOptions = {}) {
    this.store = store;
    this.makeClient = options.client ?? (() => new RulesClient());
    this.now = options.now ?? (() => Date.now());
    this.staleAfterMs = options.staleAfterMs ?? RULES_STALE_AFTER_MS;
  }

  /** Read the published version from disk; never reaches the network. */
  async load(): Promise<void> {
    this.open = await openCurrentRules(this.store);
    this.rulingsCache = null;
  }

  get corpus(): ComprehensiveRulesCorpus | null {
    return this.open?.corpus ?? null;
  }

  /** The rulings export, parsed on first use and cached per version. */
  async rulings(): Promise<RulingsCorpus | null> {
    const open = this.open;
    if (!open) return null;
    if (this.rulingsCache?.path === open.rulingsPath) return this.rulingsCache.corpus;
    try {
      const text = await readFile(open.rulingsPath, "utf8");
      const corpus = parseRulingsText(text).corpus;
      this.rulingsCache = { path: open.rulingsPath, corpus };
      return corpus;
    } catch {
      return null;
    }
  }

  status(): RulesCorpusStatus {
    const open = this.open;
    const staleAfterHours = this.staleAfterMs / 3_600_000;
    if (!open) {
      return {
        status: "unavailable",
        version: null,
        comprehensive_rules: null,
        rulings: null,
        age_hours: null,
        stale_after_hours: staleAfterHours,
        refresh_failed: this.lastRefresh?.ok === false,
        last_refresh: this.lastRefresh,
        refreshing: this.inFlight,
        recovered_from_previous: false,
      };
    }
    const retrieved = Math.min(
      Date.parse(open.manifest.comprehensive_rules.retrieved_at),
      Date.parse(open.manifest.rulings.retrieved_at),
    );
    const ageMs = Number.isFinite(retrieved) ? Math.max(0, this.now() - retrieved) : null;
    const refreshFailed = this.lastRefresh?.ok === false;
    const stale = refreshFailed || ageMs === null || ageMs >= this.staleAfterMs;
    return {
      status: stale ? "stale" : "current",
      version: open.version,
      comprehensive_rules: open.manifest.comprehensive_rules,
      rulings: open.manifest.rulings,
      age_hours: ageMs === null ? null : Math.round((ageMs / 3_600_000) * 10) / 10,
      stale_after_hours: staleAfterHours,
      refresh_failed: refreshFailed,
      last_refresh: this.lastRefresh,
      refreshing: this.inFlight,
      recovered_from_previous: open.recovered_from_previous,
    };
  }

  /**
   * Download and publish fresh corpora, then reload. A failure keeps the
   * currently loaded corpus and is recorded as the last refresh outcome.
   */
  async refresh(options: { force?: boolean; url?: string } = {}): Promise<RefreshOutcome> {
    if (this.inFlight) {
      return {
        ok: false,
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "A rules refresh is already running in this process",
        },
      };
    }
    this.inFlight = true;
    const at = new Date(this.now()).toISOString();
    try {
      const result = await refreshRules({
        store: this.store,
        client: this.makeClient(),
        force: options.force,
        url: options.url,
        now: () => new Date(this.now()),
      });
      if (!result.skipped || !this.open) await this.load();
      this.lastRefresh = { at, ok: true, skipped: result.skipped };
      return { ok: true, version: result.version, skipped: result.skipped };
    } catch (err) {
      const error =
        err instanceof StructuredError
          ? err
          : new StructuredError("UPSTREAM_UNAVAILABLE", "Rules refresh failed", {
              reason: err instanceof Error ? err.message : String(err),
            });
      this.lastRefresh = { at, ok: false, error: `${error.code}: ${error.message}` };
      return { ok: false, error: { code: error.code, message: error.message } };
    } finally {
      this.inFlight = false;
    }
  }
}
