import { describe, it, expect } from "vitest";
import { parseQuery } from "./parser.js";
import type { QueryNode } from "./ast.js";

describe("parseQuery — operator families", () => {
  it("oracle text (quoted) and full oracle", () => {
    expect(parseQuery('o:"draw a card"')).toEqual({
      kind: "text",
      field: "oracle",
      value: "draw a card",
    });
    expect(parseQuery("fo:flying")).toEqual({ kind: "text", field: "fulloracle", value: "flying" });
  });

  it("type and bare-word name", () => {
    expect(parseQuery("t:dragon")).toEqual({ kind: "text", field: "type", value: "dragon" });
    expect(parseQuery("Lightning")).toEqual({ kind: "text", field: "name", value: "Lightning" });
  });

  it("numeric comparators (mv/pow/tou/usd)", () => {
    expect(parseQuery("mv<=2")).toEqual({ kind: "numeric", field: "mv", op: "<=", value: 2 });
    expect(parseQuery("cmc=3")).toEqual({ kind: "numeric", field: "mv", op: "=", value: 3 });
    expect(parseQuery("pow>=4")).toEqual({ kind: "numeric", field: "pow", op: ">=", value: 4 });
    expect(parseQuery("tou!=0")).toEqual({ kind: "numeric", field: "tou", op: "!=", value: 0 });
    expect(parseQuery("usd>5")).toEqual({ kind: "numeric", field: "usd", op: ">", value: 5 });
    // `:` normalizes to `=`
    expect(parseQuery("mv:1")).toEqual({ kind: "numeric", field: "mv", op: "=", value: 1 });
  });

  it("color identity (id<=) and color, with sorted letters", () => {
    expect(parseQuery("id<=wubg")).toEqual({
      kind: "color",
      field: "identity",
      op: "<=",
      colors: "wubg",
    });
    // letters get canonicalized into WUBRG(C) order
    expect(parseQuery("id<=gru")).toEqual({
      kind: "color",
      field: "identity",
      op: "<=",
      colors: "urg",
    });
    expect(parseQuery("c:r")).toEqual({ kind: "color", field: "color", op: "=", colors: "r" });
  });

  it.each([
    ["ci<=GRG", "<=", "rg"],
    ["CI:wu", "=", "wu"],
    ["ci>=r", ">=", "r"],
    ["ci!=c", "!=", "c"],
    ["ci<g", "<", "g"],
    ["ci>u", ">", "u"],
    ["ci=rg", "=", "rg"],
  ])("parses the advertised color-identity alias %s", (query, op, colors) => {
    expect(parseQuery(query)).toEqual({ kind: "color", field: "identity", op, colors });
  });

  it("is: and kw:", () => {
    expect(parseQuery("is:commander")).toEqual({ kind: "is", value: "commander" });
    expect(parseQuery("kw:flying")).toEqual({ kind: "text", field: "keyword", value: "flying" });
  });

  it("inline regex and re:", () => {
    expect(parseQuery("o:/draw .* card/")).toEqual({
      kind: "regex",
      field: "oracle",
      source: "draw .* card",
    });
    expect(parseQuery("re:/^\\{T\\}/")).toEqual({
      kind: "regex",
      field: "oracle",
      source: "^\\{T\\}",
    });
  });
});

describe("parseQuery — boolean structure", () => {
  it("implicit AND between adjacent terms", () => {
    const ast = parseQuery("t:creature mv<=2");
    expect(ast.kind).toBe("and");
    expect((ast as { clauses: QueryNode[] }).clauses).toHaveLength(2);
  });

  it("explicit OR", () => {
    const ast = parseQuery("t:dragon or t:angel");
    expect(ast.kind).toBe("or");
  });

  it("negation with -", () => {
    expect(parseQuery("-t:land")).toEqual({
      kind: "not",
      clause: { kind: "text", field: "type", value: "land" },
    });
  });

  it("grouping with parentheses and mixed precedence", () => {
    const ast = parseQuery("(t:dragon or t:angel) mv<=4");
    expect(ast.kind).toBe("and");
    const clauses = (ast as { clauses: QueryNode[] }).clauses;
    expect(clauses[0]?.kind).toBe("or");
    expect(clauses[1]).toEqual({ kind: "numeric", field: "mv", op: "<=", value: 4 });
  });

  it("negated group", () => {
    const ast = parseQuery("-(t:land o:enters)");
    expect(ast.kind).toBe("not");
    expect((ast as { clause: QueryNode }).clause.kind).toBe("and");
  });

  it("parses the §5A canonical example", () => {
    const ast = parseQuery("id<=wubg t:creature o:proliferate mv<=4");
    expect(ast.kind).toBe("and");
    expect((ast as { clauses: QueryNode[] }).clauses).toHaveLength(4);
  });
});

describe("parseQuery — malformed input → INVALID_QUERY with position", () => {
  it("unbalanced opening paren", () => {
    expect(() => parseQuery("(t:dragon")).toThrowError(
      expect.objectContaining({ code: "INVALID_QUERY" }),
    );
  });

  it("extra closing paren reports its position", () => {
    try {
      parseQuery("t:dragon )");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toMatchObject({ code: "INVALID_QUERY", details: { position: 9 } });
    }
  });

  it("dangling OR", () => {
    expect(() => parseQuery("t:dragon or")).toThrowError(
      expect.objectContaining({ code: "INVALID_QUERY" }),
    );
  });

  it("non-numeric value for a numeric field", () => {
    try {
      parseQuery("mv<=foo");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toMatchObject({ code: "INVALID_QUERY", details: { position: 0 } });
    }
  });

  it("empty query", () => {
    expect(() => parseQuery("   ")).toThrowError(
      expect.objectContaining({ code: "INVALID_QUERY" }),
    );
  });
});
