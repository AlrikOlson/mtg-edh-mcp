/**
 * Recursive-descent parser for Scryfall query syntax → {@link QueryNode} AST
 * (spec §5A). Grammar (lowest to highest precedence):
 *
 *   or    := and ( "or" and )*
 *   and   := unary ( ["and"] unary )*      // juxtaposition = AND
 *   unary := "-" unary | primary
 *   primary := "(" or ")" | atom
 *
 * Malformed input throws StructuredError("INVALID_QUERY", { position }).
 */
import { StructuredError } from "../types/index.js";
import type {
  ColorField,
  ComparisonOp,
  NumericField,
  QueryNode,
  RegexField,
  TextField,
} from "./ast.js";
import { tokenize, type Token } from "./lexer.js";

const NUMERIC_FIELDS: Record<string, NumericField> = {
  mv: "mv",
  cmc: "mv",
  manavalue: "mv",
  pow: "pow",
  power: "pow",
  tou: "tou",
  toughness: "tou",
  loy: "loy",
  loyalty: "loy",
  usd: "usd",
  eur: "eur",
  tix: "tix",
  year: "year",
};

const TEXT_FIELDS: Record<string, TextField> = {
  o: "oracle",
  oracle: "oracle",
  fo: "fulloracle",
  fulloracle: "fulloracle",
  t: "type",
  type: "type",
  name: "name",
  kw: "keyword",
  keyword: "keyword",
  r: "rarity",
  rarity: "rarity",
  set: "set",
  e: "set",
};

const COLOR_FIELDS: Record<string, ColorField> = {
  c: "color",
  color: "color",
  colors: "color",
  id: "identity",
  identity: "identity",
};

const REGEX_FIELDS: Record<string, RegexField> = {
  o: "oracle",
  oracle: "oracle",
  fo: "fulloracle",
  fulloracle: "fulloracle",
  t: "type",
  type: "type",
  name: "name",
};

const COLOR_ORDER = "wubrgc";

function invalid(position: number, message: string): never {
  throw new StructuredError("INVALID_QUERY", message, { position });
}

function normalizeOp(raw: string): ComparisonOp {
  return raw === ":" ? "=" : (raw as ComparisonOp);
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function isRegexLiteral(value: string): boolean {
  return value.length >= 2 && value.startsWith("/") && value.endsWith("/");
}

function stripRegex(value: string): string {
  return isRegexLiteral(value) ? value.slice(1, -1) : value;
}

function normalizeColors(value: string): string {
  const lower = unquote(value).toLowerCase();
  if (!/^[wubrgc]+$/.test(lower)) return lower; // guild/word forms pass through to the evaluator
  return [...new Set(lower.split(""))]
    .sort((a, b) => COLOR_ORDER.indexOf(a) - COLOR_ORDER.indexOf(b))
    .join("");
}

/** Parse one term token (e.g. `o:"draw"`, `mv<=4`, `id<=wubg`, `dragon`) into a node. */
function parseAtom(token: Token): QueryNode {
  const match = /^([a-zA-Z]+)(<=|>=|!=|<|>|=|:)(.*)$/.exec(token.text);
  if (!match) {
    // Bare word → name match.
    return { kind: "text", field: "name", value: unquote(token.text) };
  }
  const field = (match[1] ?? "").toLowerCase();
  const op = normalizeOp(match[2] ?? ":");
  const rest = match[3] ?? "";
  if (rest === "") invalid(token.start, `missing value for '${field}'`);

  if (field === "is") {
    return { kind: "is", value: unquote(rest).toLowerCase() };
  }
  if (field === "re" || field === "regex") {
    return { kind: "regex", field: "oracle", source: stripRegex(rest) };
  }
  const numericField = NUMERIC_FIELDS[field];
  if (numericField) {
    const value = Number(rest);
    if (!Number.isFinite(value)) invalid(token.start, `'${field}' expects a number, got '${rest}'`);
    return { kind: "numeric", field: numericField, op, value };
  }
  const colorField = COLOR_FIELDS[field];
  if (colorField) {
    return { kind: "color", field: colorField, op, colors: normalizeColors(rest) };
  }
  const textField = TEXT_FIELDS[field];
  if (textField) {
    const regexField = REGEX_FIELDS[field];
    if (regexField && isRegexLiteral(rest)) {
      return { kind: "regex", field: regexField, source: stripRegex(rest) };
    }
    return { kind: "text", field: textField, value: unquote(rest) };
  }
  return invalid(token.start, `unknown field '${field}'`);
}

class Cursor {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}
  peek(): Token | undefined {
    return this.tokens[this.i];
  }
  next(): Token | undefined {
    return this.tokens[this.i++];
  }
  eof(): boolean {
    return this.i >= this.tokens.length;
  }
}

function parsePrimary(cur: Cursor, end: number): QueryNode {
  const tok = cur.peek();
  if (!tok) invalid(end, "unexpected end of query");
  if (tok.type === "lparen") {
    cur.next();
    const inner = parseOr(cur, end);
    const close = cur.peek();
    if (!close || close.type !== "rparen") invalid(close ? close.start : end, "expected ')'");
    cur.next();
    return inner;
  }
  if (tok.type === "term") {
    cur.next();
    return parseAtom(tok);
  }
  return invalid(tok.start, `unexpected '${tok.text}'`);
}

function parseUnary(cur: Cursor, end: number): QueryNode {
  if (cur.peek()?.type === "minus") {
    cur.next();
    return { kind: "not", clause: parseUnary(cur, end) };
  }
  return parsePrimary(cur, end);
}

function parseAnd(cur: Cursor, end: number): QueryNode {
  const clauses: QueryNode[] = [parseUnary(cur, end)];
  for (;;) {
    const tok = cur.peek();
    if (!tok || tok.type === "or" || tok.type === "rparen") break;
    if (tok.type === "and") cur.next(); // explicit AND is optional
    clauses.push(parseUnary(cur, end));
  }
  return clauses.length === 1 ? (clauses[0] as QueryNode) : { kind: "and", clauses };
}

function parseOr(cur: Cursor, end: number): QueryNode {
  const clauses: QueryNode[] = [parseAnd(cur, end)];
  while (cur.peek()?.type === "or") {
    cur.next();
    clauses.push(parseAnd(cur, end));
  }
  return clauses.length === 1 ? (clauses[0] as QueryNode) : { kind: "or", clauses };
}

/** Parse a Scryfall query string into a {@link QueryNode}. Throws INVALID_QUERY. */
export function parseQuery(input: string): QueryNode {
  const tokens = tokenize(input);
  if (tokens.length === 0) invalid(0, "empty query");
  const cur = new Cursor(tokens);
  const node = parseOr(cur, input.length);
  if (!cur.eof()) {
    const extra = cur.peek();
    invalid(extra ? extra.start : input.length, `unexpected '${extra?.text ?? ""}'`);
  }
  return node;
}
