/**
 * Scryfall query AST (spec §5A).
 *
 * A discriminated union the parser produces and the evaluator (p2-eval) lowers
 * to SQL/FTS over the local index. Boolean structure: implicit AND between
 * adjacent terms, explicit `or`, `-` negation, and `()` grouping.
 */

/** Numeric/string comparison operators. `:` is normalized to `=` (or contains, for text). */
export type ComparisonOp = "=" | "!=" | "<" | "<=" | ">" | ">=";

/** Fields compared numerically. */
export type NumericField = "mv" | "pow" | "tou" | "loy" | "usd" | "eur" | "tix" | "year";

/** Free-text fields (substring/contains match). */
export type TextField = "oracle" | "fulloracle" | "type" | "name" | "keyword" | "rarity" | "set";

/** Fields a regex can target. */
export type RegexField = "oracle" | "fulloracle" | "type" | "name";

/** Color-set fields: `color` (face colors) vs `identity` (color identity). */
export type ColorField = "color" | "identity";

export interface AndNode {
  kind: "and";
  clauses: QueryNode[];
}
export interface OrNode {
  kind: "or";
  clauses: QueryNode[];
}
export interface NotNode {
  kind: "not";
  clause: QueryNode;
}
export interface NumericNode {
  kind: "numeric";
  field: NumericField;
  op: ComparisonOp;
  value: number;
}
export interface ColorNode {
  kind: "color";
  field: ColorField;
  op: ComparisonOp;
  /** Sorted lowercase color letters, e.g. "bgu"; "c" denotes colorless. */
  colors: string;
}
export interface TextNode {
  kind: "text";
  field: TextField;
  value: string;
}
export interface RegexNode {
  kind: "regex";
  field: RegexField;
  source: string;
}
export interface IsNode {
  kind: "is";
  value: string;
}

export type QueryNode =
  AndNode | OrNode | NotNode | NumericNode | ColorNode | TextNode | RegexNode | IsNode;
