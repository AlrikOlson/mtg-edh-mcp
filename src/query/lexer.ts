/**
 * Tokenizer for Scryfall query syntax (spec §5A).
 *
 * Produces a flat token stream the parser consumes. A "term" is a maximal run
 * that keeps quoted strings ("...") and inline regexes (/.../) atomic so spaces
 * inside them don't split the token. A leading `-` is its own `minus` token
 * (negation); `or`/`and` words become boolean tokens; `(` `)` group.
 */

export type TokenType = "lparen" | "rparen" | "minus" | "or" | "and" | "term";

export interface Token {
  type: TokenType;
  /** Byte offset of the token's first character (for INVALID_QUERY positions). */
  start: number;
  text: string;
}

function isBoundary(ch: string): boolean {
  return ch === "" || ch === " " || ch === "\t" || ch === "\n" || ch === "(" || ch === ")";
}

/** Read one term starting at `start`, keeping quotes/regex atomic. Returns end index. */
function readTerm(input: string, start: number): { text: string; end: number } {
  let i = start;
  let text = "";
  while (i < input.length) {
    const ch = input.charAt(i);
    if (isBoundary(ch)) break;
    if (ch === '"' || ch === "/") {
      const close = ch;
      text += ch;
      i += 1;
      while (i < input.length && input.charAt(i) !== close) {
        text += input.charAt(i);
        i += 1;
      }
      if (i < input.length) {
        text += input.charAt(i); // closing delimiter
        i += 1;
      }
      continue;
    }
    text += ch;
    i += 1;
  }
  return { text, end: i };
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input.charAt(i);
    if (ch === " " || ch === "\t" || ch === "\n") {
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", start: i, text: "(" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", start: i, text: ")" });
      i += 1;
      continue;
    }
    if (ch === "-") {
      tokens.push({ type: "minus", start: i, text: "-" });
      i += 1;
      continue;
    }
    const { text, end } = readTerm(input, i);
    const lower = text.toLowerCase();
    if (lower === "or") {
      tokens.push({ type: "or", start: i, text });
    } else if (lower === "and") {
      tokens.push({ type: "and", start: i, text });
    } else {
      tokens.push({ type: "term", start: i, text });
    }
    i = end;
  }
  return tokens;
}
