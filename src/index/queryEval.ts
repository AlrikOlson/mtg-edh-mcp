/**
 * Lower a Scryfall query AST to parameterized SQL over the local card index
 * (spec §5A/§9/§11). Pure compilation: produces a WHERE clause + bind params, an
 * ORDER BY (always ending in oracle_id for determinism), and opaque pagination
 * cursors. The runner is CardIndex.evaluate.
 *
 * Supported now: o:/fo:/t:/name/kw:, numeric mv/pow/tou/loy/usd/eur/tix, id/c
 * (subset/superset/exact), is:commander, inline regex. Deferred (→ INVALID_QUERY):
 * year, rarity:, set:, non-commander is: values, order:edhrec_rank / order:released.
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
  year: "", // not stored — deferred
};

const ORDER_COLUMN: Record<string, string> = {
  name: "name",
  mv: "mv",
  price: "price_usd",
};

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
  switch (node.kind) {
    case "and":
    case "or": {
      if (node.clauses.length === 0) return { sql: "1=1", params: [] };
      const parts = node.clauses.map(compileNode);
      const joiner = node.kind === "and" ? " AND " : " OR ";
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
