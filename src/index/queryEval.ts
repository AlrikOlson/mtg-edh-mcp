/**
 * Lower a Scryfall query AST to parameterized SQL over the local card index
 * (spec §5A/§9/§11). Pure compilation: produces a WHERE clause + bind params, an
 * ORDER BY (always ending in oracle_id for determinism), and opaque pagination
 * cursors. The runner is CardIndex.evaluate.
 *
 * Supported now: o:/fo:/t:/name/kw:, numeric mv/pow/tou/loy/usd/eur/tix/year,
 * id/c (subset/superset/exact), set:/e: (code or full name), rarity:/r: (full
 * word or c/u/r/m/s/b letter), is:commander, is:gamechanger, inline regex,
 * order:name/mv/price/released (released = first printing date, oldest first).
 * Printing-level predicates (set/rarity/year) compile to an EXISTS over the
 * printings table; several of them under one AND merge into a single EXISTS,
 * so `set:lea year<=1994` needs ONE printing satisfying both (Scryfall's
 * semantics for oracle-level results). Deferred (→ INVALID_QUERY): other is:
 * values, order:edhrec_rank.
 */
import { StructuredError } from "../types/index.js";
import type { ComparisonOp, NumericField, QueryNode } from "../query/index.js";

export type SqlParam = string | number;

export interface CompiledWhere {
  sql: string;
  params: SqlParam[];
}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 175;

const NUMERIC_COLUMN: Record<NumericField, string> = {
  mv: "mv",
  pow: "pow",
  tou: "tou",
  loy: "loy",
  usd: "price_usd",
  eur: "price_eur",
  tix: "price_tix",
  year: "", // printing-level; compiled via an EXISTS over printings
};

const ORDER_COLUMN: Record<string, string> = {
  name: "name",
  mv: "mv",
  price: "price_usd",
  // First-printing date (oldest first); correlated MIN over the joined table.
  released: "(SELECT MIN(p.released_at) FROM printings p WHERE p.oracle_id = cards.oracle_id)",
};

/** Scryfall rarity letters -> stored rarity words; full words pass through. */
const RARITY_WORDS: Record<string, string> = {
  c: "common",
  u: "uncommon",
  r: "rare",
  m: "mythic",
  s: "special",
  b: "bonus",
};

/** A condition over one printings-table row (aliased `p`). */
interface PrintingCondition {
  condition: string;
  params: SqlParam[];
}

/** Wrap printing-row conditions in an EXISTS: ANY single printing satisfies ALL of them. */
function printingExists(conditions: readonly PrintingCondition[]): CompiledWhere {
  const combined = conditions.map((c) => c.condition).join(" AND ");
  return {
    sql: `EXISTS (SELECT 1 FROM printings p WHERE p.oracle_id = cards.oracle_id AND ${combined})`,
    params: conditions.flatMap((c) => c.params),
  };
}

/**
 * The printing-row condition for a printing-level leaf (set:/rarity:/year), or
 * null for any other node. Kept separate from compileNode so an AND of several
 * printing predicates can merge them into ONE EXISTS — Scryfall semantics: a
 * card matches `set:lea year<=1994` only if a SINGLE printing satisfies both,
 * not one printing each.
 */
function printingCondition(node: QueryNode): PrintingCondition | null {
  if (node.kind === "numeric" && node.field === "year") {
    return {
      condition: `(p.released_at IS NOT NULL AND CAST(substr(p.released_at, 1, 4) AS INTEGER) ${node.op} ?)`,
      params: [Math.trunc(node.value)],
    };
  }
  if (node.kind === "text" && node.field === "set") {
    // Scryfall set:/e: matches the set code or the full set name.
    return {
      condition: `(p.set_code = ? COLLATE NOCASE OR p.set_name = ? COLLATE NOCASE)`,
      params: [node.value, node.value],
    };
  }
  if (node.kind === "text" && node.field === "rarity") {
    const lowered = node.value.toLowerCase();
    return { condition: `p.rarity = ?`, params: [RARITY_WORDS[lowered] ?? lowered] };
  }
  return null;
}

function unsupported(what: string): never {
  throw new StructuredError("INVALID_QUERY", `unsupported query operator: ${what}`);
}

function ftsPhrase(value: string): string {
  return value.replace(/"/g, '""');
}

function subsetsOf(letters: string): string[] {
  const chars = [...letters];
  const out: string[] = [];
  for (let mask = 0; mask < 1 << chars.length; mask += 1) {
    let s = "";
    for (let i = 0; i < chars.length; i += 1) {
      if (mask & (1 << i)) s += chars[i];
    }
    out.push(s);
  }
  return out;
}

function colorPredicate(column: string, op: ComparisonOp, raw: string): CompiledWhere {
  // `c` denotes colorless (stored as ""); drop any stray 'c'. The index stores
  // color identity/colors as UPPERCASE WUBRG letters, so compare in uppercase.
  const target = (raw === "c" ? "" : raw.replace(/c/g, "")).toUpperCase();
  switch (op) {
    case "=":
      return { sql: `${column} = ?`, params: [target] };
    case "!=":
      return { sql: `${column} != ?`, params: [target] };
    case "<=": {
      const subs = subsetsOf(target);
      return { sql: `${column} IN (${subs.map(() => "?").join(",")})`, params: subs };
    }
    case "<": {
      const subs = subsetsOf(target).filter((s) => s !== target);
      if (subs.length === 0) return { sql: "0", params: [] };
      return { sql: `${column} IN (${subs.map(() => "?").join(",")})`, params: subs };
    }
    case ">=": {
      if (target === "") return { sql: "1=1", params: [] };
      const letters = [...target];
      return {
        sql: `(${letters.map(() => `${column} LIKE ?`).join(" AND ")})`,
        params: letters.map((l) => `%${l}%`),
      };
    }
    case ">": {
      if (target === "") return { sql: `${column} != ?`, params: [""] };
      const letters = [...target];
      return {
        sql: `(${letters.map(() => `${column} LIKE ?`).join(" AND ")} AND ${column} != ?)`,
        params: [...letters.map((l) => `%${l}%`), target],
      };
    }
    default:
      return unsupported(`color operator '${op as string}'`);
  }
}

/** Compile one AST node to a SQL fragment + params. */
export function compileNode(node: QueryNode): CompiledWhere {
  // A lone printing-level leaf: ANY printing satisfying it matches the card.
  const printing = printingCondition(node);
  if (printing) return printingExists([printing]);

  switch (node.kind) {
    case "and":
    case "or": {
      if (node.clauses.length === 0) return { sql: "1=1", params: [] };
      const joiner = node.kind === "and" ? " AND " : " OR ";
      let clauses = node.clauses;
      const parts: CompiledWhere[] = [];
      if (node.kind === "and") {
        // Merge the AND's printing-level leaves into ONE EXISTS (see
        // printingCondition); the remaining clauses compile normally.
        const merged = node.clauses
          .map(printingCondition)
          .filter((c): c is PrintingCondition => c !== null);
        if (merged.length > 1) {
          parts.push(printingExists(merged));
          clauses = node.clauses.filter((c) => printingCondition(c) === null);
        }
      }
      parts.push(...clauses.map(compileNode));
      return {
        sql: `(${parts.map((p) => p.sql).join(joiner)})`,
        params: parts.flatMap((p) => p.params),
      };
    }
    case "not": {
      const inner = compileNode(node.clause);
      return { sql: `NOT (${inner.sql})`, params: inner.params };
    }
    case "numeric": {
      // year is handled above as a printing-level leaf.
      const column = NUMERIC_COLUMN[node.field];
      if (!column) unsupported(node.field);
      return { sql: `${column} ${node.op} ?`, params: [node.value] };
    }
    case "color": {
      const column = node.field === "identity" ? "color_identity" : "colors";
      return colorPredicate(column, node.op, node.colors);
    }
    case "text": {
      switch (node.field) {
        case "oracle":
        case "fulloracle":
          return {
            sql: `oracle_id IN (SELECT oracle_id FROM cards_fts WHERE cards_fts MATCH ?)`,
            params: [`oracle_text : "${ftsPhrase(node.value)}"`],
          };
        case "name":
          return {
            sql: `oracle_id IN (SELECT oracle_id FROM cards_fts WHERE cards_fts MATCH ?)`,
            params: [`name : "${ftsPhrase(node.value)}"`],
          };
        case "type":
          return { sql: `type_line LIKE ?`, params: [`%${node.value}%`] };
        case "keyword":
          return { sql: `keywords LIKE ?`, params: [`%${node.value.toLowerCase()}%`] };
        default:
          // set/rarity are printing-level leaves, handled before the switch.
          return unsupported(`${node.field}:`);
      }
    }
    case "regex": {
      const column =
        node.field === "type" ? "type_line" : node.field === "name" ? "name" : "oracle_text";
      return { sql: `${column} REGEXP ?`, params: [node.source] };
    }
    case "is": {
      if (node.value === "commander") return { sql: `is_commander_eligible = 1`, params: [] };
      if (node.value === "gamechanger") return { sql: `is_game_changer = 1`, params: [] };
      return unsupported(`is:${node.value}`);
    }
    default:
      return unsupported("query");
  }
}

/** ORDER BY clause; always ends with oracle_id for a deterministic tiebreak (§11). */
export function orderClause(order?: string): string {
  if (order === undefined) return "ORDER BY name ASC, oracle_id ASC";
  const column = ORDER_COLUMN[order];
  if (!column) unsupported(`order:${order}`);
  return `ORDER BY ${column} ASC, oracle_id ASC`;
}

export function clampLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

/** Encode an offset as an opaque base64url cursor. */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

/** Decode an opaque cursor to its offset; malformed → INVALID_QUERY. */
export function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown };
    if (typeof parsed.o !== "number" || parsed.o < 0) throw new Error("bad offset");
    return Math.trunc(parsed.o);
  } catch {
    throw new StructuredError("INVALID_QUERY", "malformed pagination cursor");
  }
}
