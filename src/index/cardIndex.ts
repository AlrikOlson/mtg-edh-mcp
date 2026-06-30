/**
 * Local card index — build + query (spec §5A/§9).
 *
 * `buildIndex` streams the staged oracle_cards (gameplay base) into the `cards`
 * table + FTS, then streams default_cards into the joined `printings` table, all
 * inside one transaction. `CardIndex` opens the built DB read-only and serves
 * full-Card lookups and name search.
 */
import { rm } from "node:fs/promises";
import Database from "better-sqlite3";
import type { Card, CardRef, Color, Prices, Printing, RefColorIdentity } from "../types/index.js";
import type { QueryNode } from "../query/index.js";
import { streamCardArray, VersionedStore } from "../ingest/index.js";
import { SCHEMA_SQL } from "./schema.js";
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

/** Build (or rebuild) the SQLite index for a staged version. */
export async function buildIndex(options: BuildIndexOptions): Promise<BuildIndexResult> {
  const { store, dbName = DEFAULT_INDEX_NAME } = options;
  const version = options.version ?? (await store.readCurrent());
  if (!version) {
    throw new Error("buildIndex: no version specified and the store has no current version");
  }

  const dbPath = store.filePath(version, dbName);
  // Fresh build: clear any prior DB + WAL sidecars so the rebuild is clean.
  await Promise.all([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((p) => rm(p, { force: true })));

  const db = new Database(dbPath);
  let cards = 0;
  let printings = 0;
  try {
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA_SQL);

    const insertCard = db.prepare(
      `INSERT OR REPLACE INTO cards
       (oracle_id, name, mv, type_line, color_identity, colors, legalities_commander, oracle_text,
        keywords, pow, tou, loy, price_usd, price_eur, price_tix, is_commander_eligible, card)
       VALUES (@oracle_id, @name, @mv, @type_line, @color_identity, @colors, @legalities_commander,
        @oracle_text, @keywords, @pow, @tou, @loy, @price_usd, @price_eur, @price_tix,
        @is_commander_eligible, @card)`,
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
    for await (const raw of streamCardArray<ScryfallCardRaw>(
      store.filePath(version, "oracle_cards.json"),
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
        card: JSON.stringify(card),
      });
      insertFts.run({ oracle_id: card.oracle_id, name: card.name, oracle_text: card.oracle_text });
      cards += 1;
    }
    for await (const raw of streamCardArray<ScryfallCardRaw>(
      store.filePath(version, "default_cards.json"),
    )) {
      const printing = extractPrinting(raw);
      if (!printing) continue;
      insertPrinting.run(printing);
      printings += 1;
    }
    db.exec("COMMIT");
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

export class CardIndex {
  private readonly db: Db;
  private readonly getCardStmt: Database.Statement<[string]>;
  private readonly getPrintingsStmt: Database.Statement<[string]>;
  private readonly searchStmt: Database.Statement<[string, number]>;
  private readonly countStmt: Database.Statement<[]>;
  private readonly resolveExactStmt: Database.Statement<[string]>;
  private readonly resolveFuzzyStmt: Database.Statement<[string, number]>;

  private constructor(db: Db) {
    this.db = db;
    // Register REGEXP so `column REGEXP ?` works in evaluated queries.
    db.function("regexp", (pattern: unknown, value: unknown): number => {
      if (typeof pattern !== "string" || typeof value !== "string") return 0;
      try {
        return new RegExp(pattern).test(value) ? 1 : 0;
      } catch {
        return 0;
      }
    });
    this.getCardStmt = db.prepare(`SELECT card FROM cards WHERE oracle_id = ?`);
    this.getPrintingsStmt = db.prepare(
      `SELECT oracle_id, scryfall_id, set_code, set_name, collector_number, rarity, prices, released_at
       FROM printings WHERE oracle_id = ? ORDER BY released_at DESC, scryfall_id`,
    );
    this.searchStmt = db.prepare(
      `SELECT c.oracle_id, c.name, c.mv, c.type_line, c.color_identity
       FROM cards_fts f JOIN cards c ON c.oracle_id = f.oracle_id
       WHERE cards_fts MATCH ? LIMIT ?`,
    );
    this.countStmt = db.prepare(`SELECT count(*) AS n FROM cards`);
    this.resolveExactStmt = db.prepare(
      `SELECT ${REF_COLUMNS} FROM cards WHERE name = ? COLLATE NOCASE ORDER BY oracle_id`,
    );
    this.resolveFuzzyStmt = db.prepare(
      `SELECT ${REF_COLUMNS} FROM cards WHERE name LIKE ? ORDER BY length(name), oracle_id LIMIT ?`,
    );
  }

  /** Open a built index read-only. */
  static open(dbPath: string): CardIndex {
    return new CardIndex(new Database(dbPath, { readonly: true }));
  }

  /** Full §4 Card by oracle_id (with joined printings), or null. */
  getCard(oracleId: string): Card | null {
    const row = this.getCardStmt.get(oracleId) as { card: string } | undefined;
    if (!row) return null;
    const card = JSON.parse(row.card) as Card;
    const printingRows = this.getPrintingsStmt.all(oracleId) as PrintingRow[];
    return { ...card, printings: printingRows.map(rowToPrinting) };
  }

  /** Name/oracle-text FTS search, projected to lean CardRefs (§5A default). */
  searchByName(query: string, limit = 20): CardRef[] {
    const rows = this.searchStmt.all(query, limit) as Array<{
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
    return (this.countStmt.get() as { n: number }).n;
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
    const exactRows = this.resolveExactStmt.all(name) as CardRefRow[];
    if (options.exact || exactRows.length > 0) return preferRealCards(exactRows.map(rowToRef));
    return preferRealCards(
      (this.resolveFuzzyStmt.all(`%${name}%`, 25) as CardRefRow[]).map(rowToRef),
    );
  }

  /** All printings for an oracle_id (newest first), or [] if the card is unknown. */
  getPrintings(oracleId: string): Printing[] {
    return (this.getPrintingsStmt.all(oracleId) as PrintingRow[]).map(rowToPrinting);
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
      this.db.prepare(`SELECT count(*) AS n FROM cards WHERE ${whereSql}`).get(...whereParams) as {
        n: number;
      }
    ).n;

    const rows = this.db
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
    this.db.close();
  }
}
