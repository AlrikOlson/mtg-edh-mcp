// Scryfall query grammar (spec §5A): parse query syntax into a typed AST. The
// evaluator (p2-eval) lowers the AST to SQL/FTS over the local card index.
export { parseQuery } from "./parser.js";
export { tokenize, type Token, type TokenType } from "./lexer.js";
export type {
  QueryNode,
  AndNode,
  OrNode,
  NotNode,
  NumericNode,
  ColorNode,
  TextNode,
  RegexNode,
  IsNode,
  ComparisonOp,
  NumericField,
  TextField,
  RegexField,
  ColorField,
} from "./ast.js";
