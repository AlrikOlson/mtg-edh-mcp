/**
 * Local card index — build + query (spec §5A/§9).
 *
 * `buildIndex` streams the staged oracle_cards (gameplay base) into the `cards`
 * table + FTS, then streams default_cards into the joined `printings` table, all
 * inside one transaction. `CardIndex` opens the built DB read-only and serves
 * full-Card lookups and name search.
 */
import { lstat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { Card, CardRef, Color, Prices, Printing, RefColorIdentity } from "../types/index.js";
import type { QueryNode } from "../query/index.js";
import { streamCardArray, VersionedStore } from "../ingest/index.js";
import { CARD_INDEX_VERSION, SCHEMA_SQL } from "./schema.js";
import {
  colorIdentitySorted,
  extractPrinting,
  mapScryfallCard,
  projectedColumns,
  type PrintingRow,
  type ScryfallCardRaw,
} from "./map.js";
import { clampLimit, compileNode, decodeCursor, encodeCursor, orderClause } from "./queryEval.js";

type Db = InstanceType<typeof Database>;

export const DEFAULT_INDEX_NAME = "index.sqlite";

export interface BuildIndexOptions {
  store: VersionedStore;
  /** Version to build; defaults to the store's current published version. */
  version?: string;
  /** Index file name within the version dir (default index.sqlite). */
  dbName?: string;
  /** Optional observer, awaited inside the build transaction after each oracle insert. */
  onCardInserted?: (cards: number) => void | Promise<void>;
}

export interface BuildIndexResult {
  dbPath: string;
  version: string;
  cards: number;
  printings: number;
}

export interface SearchOptions {
  /** Page size (clamped to 1..175; default 25). */
  limit?: number;
  /** Order key: name | mv | price. Always tiebroken by oracle_id. */
  order?: string;
  /** Opaque pagination cursor from a prior result. */
  cursor?: string;
  /**
   * Optional allow-set: restrict results to these oracle_ids (e.g. an owned
   * collection). Applied at the SQL layer so total/returned/cursor stay exact.
   * Empty/omitted = no restriction.
   */
  oracleIds?: readonly string[];
}

export interface SearchResult {
  total: number;
  returned: number;
  results: CardRef[];
  /** Present when more results exist beyond this page. */
  nextCursor?: string;
}

function refColorIdentity(stored: string): RefColorIdentity {
  return stored.length > 0 ? (stored.split("") as (Color | "C")[]) : ["C"];
}

interface CardRefRow {
  oracle_id: string;
  name: string;
  mv: number;
  type_line: string;
  color_identity: string;
}

function rowToRef(r: CardRefRow): CardRef {
  return {
    oracle_id: r.oracle_id,
    name: r.name,
    mv: r.mv,
    ci: refColorIdentity(r.color_identity),
    type: r.type_line,
  };
}

/** A token / emblem row (its type_line carries the marker; real cards never do). */
function isTokenType(typeLine: string): boolean {
  return /\bToken\b/i.test(typeLine) || /^Emblem\b/i.test(typeLine);
}

/**
 * De-rank token/emblem rows: when a name matches both a real card and its token
 * (e.g. Llanowar Elves), return only the real card(s). Falls back to the full
 * set when nothing real matched, so a token-only name still resolves rather than
 * becoming UNKNOWN. Discriminates on type_line only — never on the card name.
 */
function preferRealCards(refs: CardRef[]): CardRef[] {
  const real = refs.filter((r) => !isTokenType(r.type));
  return real.length > 0 ? real : refs;
}

const REF_COLUMNS = "oracle_id, name, mv, type_line, color_identity";

function rowToPrinting(row: PrintingRow): Printing {
  const printing: Printing = {
    scryfall_id: row.scryfall_id,
    set: row.set_code,
    set_name: row.set_name,
    collector_number: row.collector_number,
    rarity: row.rarity,
    prices: JSON.parse(row.prices) as Prices,
  };
  if (row.released_at) printing.released_at = row.released_at;
  return printing;
}

/** Build a new SQLite index; existing candidates and their sidecars are never replaced. */
export async function buildIndex(options: BuildIndexOptions): Promise<BuildIndexResult> {
  const { store, dbName = DEFAULT_INDEX_NAME } = options;
  const version = options.version ?? (await store.readCurrent());
  if (!version) {
    throw new Error("buildIndex: no version specified and the store has no current version");
  }

  const dbPath = store.filePath(version, dbName);
  // Reserve the destination exclusively before SQLite opens it. A failed build
  // remains available for inspection; retrying requires a new candidate path.
  const reservation = await open(dbPath, "wx");
  await reservation.close();
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = `${dbPath}${suffix}`;
    try {
      await lstat(sidecar);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`buildIndex: refusing existing SQLite sidecar ${sidecar}`);
  }

  const db = new Database(dbPath);
  let cards = 0;
  let printings = 0;
  try {
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA_SQL);

    const insertCard = db.prepare(
      `INSERT OR REPLACE INTO cards
       (oracle_id, name, mv, type_line, color_identity, colors, legalities_commander, oracle_text,
        keywords, pow, tou, loy, price_usd, price_eur, price_tix, is_commander_eligible,
        is_game_changer, card)
       VALUES (@oracle_id, @name, @mv, @type_line, @color_identity, @colors, @legalities_commander,
        @oracle_text, @keywords, @pow, @tou, @loy, @price_usd, @price_eur, @price_tix,
        @is_commander_eligible, @is_game_changer, @card)`,
    );
    const insertFts = db.prepare(
      `INSERT INTO cards_fts (oracle_id, name, oracle_text) VALUES (@oracle_id, @name, @oracle_text)`,
    );
    const insertPrinting = db.prepare(
      `INSERT OR REPLACE INTO printings
       (oracle_id, scryfall_id, set_code, set_name, collector_number, rarity, prices, released_at)
       VALUES (@oracle_id, @scryfall_id, @set_code, @set_name, @collector_number, @rarity, @prices, @released_at)`,
    );

    db.exec("BEGIN");
    db.pragma(`user_version = ${CARD_INDEX_VERSION}`);
    for await (const raw of streamCardArray<ScryfallCardRaw>(
      await store.stagedFile(version, "oracle_cards"),
    )) {
      const card = mapScryfallCard(raw);
      if (!card.oracle_id) continue;
      const cols = projectedColumns(card);
      insertCard.run({
        oracle_id: card.oracle_id,
        name: card.name,
        mv: card.mv,
        type_line: card.type_line,
        color_identity: colorIdentitySorted(card.color_identity),
        colors: cols.colors,
        legalities_commander: card.legalities.commander ?? "not_legal",
        oracle_text: card.oracle_text,
        keywords: cols.keywords,
        pow: cols.pow,
        tou: cols.tou,
        loy: cols.loy,
        price_usd: cols.price_usd,
        price_eur: cols.price_eur,
        price_tix: cols.price_tix,
        is_commander_eligible: cols.is_commander_eligible,
        is_game_changer: cols.is_game_changer,
        card: JSON.stringify(card),
      });
      insertFts.run({
        oracle_id: card.oracle_id,
        name: card.name,
        oracle_text: card.oracle_text,
      });
      cards += 1;
      await options.onCardInserted?.(cards);
    }
    for await (const raw of streamCardArray<ScryfallCardRaw>(
      await store.stagedFile(version, "default_cards"),
    )) {
      const printing = extractPrinting(raw);
      if (!printing) continue;
      insertPrinting.run(printing);
      printings += 1;
    }
    db.exec("COMMIT");
    if (db.pragma("quick_check", { simple: true }) !== "ok") {
      throw new Error("buildIndex: SQLite quick_check failed");
    }
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // no active transaction
    }
    throw err;
  } finally {
    db.close();
  }

  return { dbPath, version, cards, printings };
}

interface CardIndexState {
  db: Db;
  revisionCache?: { dataVersion: unknown; digest: string };
  getCardStmt: Database.Statement<[string]>;
  getPrintingsStmt: Database.Statement<[string]>;
  searchStmt: Database.Statement<[string, number]>;
  countStmt: Database.Statement<[]>;
  resolveExactStmt: Database.Statement<[string]>;
  resolveFuzzyStmt: Database.Statement<[string, number]>;
}

export class CardIndex {
  private constructor(private state: CardIndexState) {}

  /** Pin one SQLite read snapshot across synchronous plan validation and its digest. */
  withRead<T>(operation: () => T): T {
    if (this.state.db.inTransaction) return operation();
    return this.state.db.transaction(() => {
      // A deferred BEGIN alone does not establish a read snapshot.
      this.state.countStmt.get();
      const result = operation();
      if (result instanceof Promise) throw new Error("CardIndex reads must be synchronous");
      return result;
    })();
  }

  /** Exact served image identity, including same-day refreshes and printing changes.
   * Computed lazily only for plans; reuse until this connection observes a commit.
   */
  revision(): string {
    return this.withRead(() => {
      const dataVersion = this.state.db.pragma("data_version", {
        simple: true,
      });
      const cached = this.state.revisionCache;
      if (cached && cached.dataVersion === dataVersion) return cached.digest;
      const digest = createHash("sha256").update(this.state.db.serialize()).digest("hex");
      this.state.revisionCache = { dataVersion, digest };
      return digest;
    });
  }

  /** Register functions + prepare all statements against `db`. */
  private static prepare(db: Db): CardIndexState {
    const version = db.pragma("user_version", { simple: true });
    if (version !== CARD_INDEX_VERSION) {
      throw new Error(
        `Unsupported card index format ${version}; expected ${CARD_INDEX_VERSION}. Run data_ingest to rebuild card data.`,
      );
    }
    // Register REGEXP so `column REGEXP ?` works in evaluated queries.
    db.function("regexp", (pattern: unknown, value: unknown): number => {
      if (typeof pattern !== "string" || typeof value !== "string") return 0;
      try {
        return new RegExp(pattern).test(value) ? 1 : 0;
      } catch {
        return 0;
      }
    });
    const getCardStmt = db.prepare<[string]>(`SELECT card FROM cards WHERE oracle_id = ?`);
    const getPrintingsStmt = db.prepare<[string]>(
      `SELECT oracle_id, scryfall_id, set_code, set_name, collector_number, rarity, prices, released_at
       FROM printings WHERE oracle_id = ? ORDER BY released_at DESC, scryfall_id`,
    );
    const searchStmt = db.prepare<[string, number]>(
      `SELECT c.oracle_id, c.name, c.mv, c.type_line, c.color_identity
       FROM cards_fts f JOIN cards c ON c.oracle_id = f.oracle_id
       WHERE cards_fts MATCH ? LIMIT ?`,
    );
    const countStmt = db.prepare<[]>(`SELECT count(*) AS n FROM cards`);
    const resolveExactStmt = db.prepare<[string]>(
      `SELECT ${REF_COLUMNS} FROM cards WHERE name = ? COLLATE NOCASE ORDER BY oracle_id`,
    );
    const resolveFuzzyStmt = db.prepare<[string, number]>(
      `SELECT ${REF_COLUMNS} FROM cards WHERE name LIKE ? ORDER BY length(name), oracle_id LIMIT ?`,
    );
    return {
      db,
      getCardStmt,
      getPrintingsStmt,
      searchStmt,
      countStmt,
      resolveExactStmt,
      resolveFuzzyStmt,
    };
  }

  /** Open a built index read-only, or validate a detached in-memory byte snapshot. */
  static open(dbPath: string | Buffer): CardIndex {
    const db = new Database(dbPath, { readonly: true });
    try {
      return new CardIndex(CardIndex.prepare(db));
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /**
   * Hot-swap this instance onto a freshly built index (after an atomic bulk
   * swap): every tool closure holds this CardIndex, so re-binding internally
   * makes the new data visible without re-registering tools. The old DB handle
   * is closed after a fully prepared candidate is installed.
   */
  reopen(dbPath: string): void {
    this.prepareReopen(dbPath).commit();
  }

  /**
   * Prepare all candidate statements without touching live readers. Commit is
   * synchronous and cannot roll back the swap if retired-handle cleanup fails.
   * Disposing before commit cancels the swap; both operations are idempotent.
   */
  prepareReopen(dbPath: string): { commit(): void; dispose(): void } {
    const next = new Database(dbPath, { readonly: true });
    let prepared: CardIndexState;
    try {
      prepared = CardIndex.prepare(next);
    } catch (err) {
      next.close();
      throw err;
    }
    let pending = true;
    return {
      commit: () => {
        if (!pending) return;
        pending = false;
        const old = this.state.db;
        this.state = prepared;
        try {
          old.close();
        } catch {
          // The new state is already live. Cleanup cannot undo publication.
        }
      },
      dispose: () => {
        if (!pending) return;
        pending = false;
        next.close();
      },
    };
  }

  /** Full §4 Card by oracle_id (with joined printings), or null. */
  getCard(oracleId: string): Card | null {
    const row = this.state.getCardStmt.get(oracleId) as { card: string } | undefined;
    if (!row) return null;
    const card = JSON.parse(row.card) as Card;
    const printingRows = this.state.getPrintingsStmt.all(oracleId) as PrintingRow[];
    return { ...card, printings: printingRows.map(rowToPrinting) };
  }

  /** Name/oracle-text FTS search, projected to lean CardRefs (§5A default). */
  searchByName(query: string, limit = 20): CardRef[] {
    const rows = this.state.searchStmt.all(query, limit) as Array<{
      oracle_id: string;
      name: string;
      mv: number;
      type_line: string;
      color_identity: string;
    }>;
    return rows.map((r) => ({
      oracle_id: r.oracle_id,
      name: r.name,
      mv: r.mv,
      ci: refColorIdentity(r.color_identity),
      type: r.type_line,
    }));
  }

  count(): number {
    return (this.state.countStmt.get() as { n: number }).n;
  }

  /**
   * The Game Changers card names carried by this index's snapshot, or null when
   * the index predates the `is_game_changer` column (or stores no flags) — the
   * caller then falls back to the live list. Prepared lazily (not during open) so
   * old indexes keep opening.
   */
  gameChangerNames(): Set<string> | null {
    try {
      const rows = this.state.db
        .prepare(`SELECT name FROM cards WHERE is_game_changer = 1`)
        .all() as Array<{ name: string }>;
      return rows.length > 0 ? new Set(rows.map((r) => r.name)) : null;
    } catch {
      return null; // pre-column schema
    }
  }

  /**
   * Resolve a card name to candidate CardRefs (the anti-hallucination gateway).
   * Returns exact (case-insensitive) matches; when none and not `exact`, falls
   * back to a substring (fuzzy) match. Token/emblem rows are de-ranked so a name
   * shared by a real card and its token (e.g. Llanowar Elves, Mutavault) resolves
   * to the real card instead of bouncing to AMBIGUOUS_NAME. The caller maps
   * 0→UNKNOWN_CARD, >1→AMBIGUOUS_NAME.
   */
  resolveName(name: string, options: { exact?: boolean } = {}): CardRef[] {
    const exactRows = this.state.resolveExactStmt.all(name) as CardRefRow[];
    if (options.exact || exactRows.length > 0) return preferRealCards(exactRows.map(rowToRef));
    return preferRealCards(
      (this.state.resolveFuzzyStmt.all(`%${name}%`, 25) as CardRefRow[]).map(rowToRef),
    );
  }

  /**
   * Did-you-mean suggestions for a name that failed to resolve. Per-token
   * substring matches against card names (longest tokens first, so the most
   * distinctive word drives the ranking), deterministic and safe for any input
   * (plain LIKE — no FTS MATCH syntax to trip on). Token/emblem rows are
   * de-ranked like resolveName. Returns [] when nothing plausibly matches.
   */
  suggestNames(name: string, limit = 5): CardRef[] {
    const tokens = (name.match(/[A-Za-z0-9']+/g) ?? [])
      .map((t) => t.replace(/'/g, ""))
      .filter((t) => t.length > 0);
    // Drop short glue words unless they're all we have.
    const meaningful = tokens.filter((t) => t.length >= 3);
    const candidates = (meaningful.length > 0 ? meaningful : tokens).sort(
      (a, b) => b.length - a.length,
    );
    const seen = new Set<string>();
    const refs: CardRef[] = [];
    for (const token of candidates) {
      if (refs.length >= limit) break;
      const rows = this.state.resolveFuzzyStmt.all(`%${token}%`, limit) as CardRefRow[];
      for (const ref of preferRealCards(rows.map(rowToRef))) {
        if (refs.length >= limit) break;
        if (seen.has(ref.oracle_id)) continue;
        seen.add(ref.oracle_id);
        refs.push(ref);
      }
    }
    return refs;
  }

  /** All printings for an oracle_id (newest first), or [] if the card is unknown. */
  getPrintings(oracleId: string): Printing[] {
    return (this.state.getPrintingsStmt.all(oracleId) as PrintingRow[]).map(rowToPrinting);
  }

  /**
   * Evaluate a parsed Scryfall query AST against the index, returning a lean
   * CardRef page plus total/returned and an opaque next cursor. Ordering is
   * deterministic (oracle_id tiebreak), so identical query + snapshot ⇒
   * identical results.
   */
  evaluate(node: QueryNode, options: SearchOptions = {}): SearchResult {
    const where = compileNode(node);
    const order = orderClause(options.order);
    const limit = clampLimit(options.limit);
    const offset = options.cursor ? decodeCursor(options.cursor) : 0;

    // Optional owned-collection allow-set: AND an oracle_id IN (...) onto the
    // query (params appended) so the count + page both honor it — keeping
    // total/returned/cursor exact. Empty = no restriction.
    let whereSql = where.sql;
    const whereParams = [...where.params];
    if (options.oracleIds && options.oracleIds.length > 0) {
      const placeholders = options.oracleIds.map(() => "?").join(",");
      whereSql = `(${whereSql}) AND oracle_id IN (${placeholders})`;
      whereParams.push(...options.oracleIds);
    }

    const total = (
      this.state.db
        .prepare(`SELECT count(*) AS n FROM cards WHERE ${whereSql}`)
        .get(...whereParams) as {
        n: number;
      }
    ).n;

    const rows = this.state.db
      .prepare(
        `SELECT oracle_id, name, mv, type_line, color_identity
         FROM cards WHERE ${whereSql} ${order} LIMIT ? OFFSET ?`,
      )
      .all(...whereParams, limit, offset) as Array<{
      oracle_id: string;
      name: string;
      mv: number;
      type_line: string;
      color_identity: string;
    }>;

    const results: CardRef[] = rows.map((r) => ({
      oracle_id: r.oracle_id,
      name: r.name,
      mv: r.mv,
      ci: refColorIdentity(r.color_identity),
      type: r.type_line,
    }));

    const result: SearchResult = { total, returned: results.length, results };
    if (offset + results.length < total) result.nextCursor = encodeCursor(offset + limit);
    return result;
  }

  close(): void {
    this.state.db.close();
  }
}
