import { describe, expect, it } from "vitest";
import {
  MANA_CASES,
  PACKAGE_CASES,
  gradeManaAnswer,
  gradePackageAnswer,
  solveMana,
  solvePackage,
  type ManaPuzzle,
  type PackagePuzzle,
} from "./references.js";

function packageAt(index: number): PackagePuzzle {
  const puzzle = PACKAGE_CASES[index];
  if (!puzzle) throw new Error(`Expected package fixture ${index}`);
  return puzzle;
}

describe("small exhaustive mana-payment oracle", () => {
  it.each(MANA_CASES)("$id matches its independently authored answer", (puzzle) => {
    expect(solveMana(puzzle)).toBe(puzzle.expected);
    expect(gradeManaAnswer(puzzle, puzzle.expected).passed).toBe(true);
  });
  it.each(MANA_CASES)("$id rejects the opposite plausible payment claim", (puzzle) => {
    expect(gradeManaAnswer(puzzle, !puzzle.expected).passed).toBe(false);
  });
  it("a dual source cannot be reused for both colors", () => {
    const puzzle: ManaPuzzle = {
      id: "dual",
      sources: [{ id: "dual", options: [["W"], ["U"]] }],
      cost: { colored: ["W", "U"], generic: 0 },
    };
    expect(solveMana(puzzle)).toBe(false);
    expect(
      solveMana({ ...puzzle, sources: [...puzzle.sources, { id: "island", options: [["U"]] }] }),
    ).toBe(true);
  });
  it("rejects ambiguous duplicate source ids and oversized reference problems", () => {
    expect(() =>
      solveMana({
        id: "duplicate",
        sources: [
          { id: "x", options: [["R"]] },
          { id: "x", options: [["R"]] },
        ],
        cost: { colored: [], generic: 1 },
      }),
    ).toThrow();
    expect(() =>
      solveMana({
        id: "oversized",
        sources: Array.from({ length: 9 }, (_, index) => ({ id: String(index), options: [["R"]] })),
        cost: { colored: [], generic: 1 },
      }),
    ).toThrow();
  });
});

describe("small exhaustive package-optimum oracle", () => {
  it.each(PACKAGE_CASES)("$id matches authored optimum cents and selected IDs", (puzzle) => {
    const result = solvePackage(puzzle);
    expect(result.minimumCents).toBe(puzzle.expectedMinimumCents);
    expect(result.optimal.map((solution) => solution.ids)).toEqual(puzzle.expectedOptimalIds);
    expect(result.combinationsExamined).toBeGreaterThan(0);
    for (const solution of result.optimal)
      expect(gradePackageAnswer(puzzle, solution).passed).toBe(true);
  });
  it.each([
    ["cheap package drops protected theme", { ids: ["ramp", "draw"], costCents: 70 }],
    ["illegal bargain", { ids: ["protected", "banned"], costCents: 60 }],
    ["omitted activation package member", { ids: ["versatile"], costCents: 50 }],
    ["duplicate discount", { ids: ["versatile", "versatile"], costCents: 100 }],
    ["invented savings", { ids: ["protected", "versatile"], costCents: 109 }],
  ])("rejects plausible package mutation: %s", (_name, answer) => {
    expect(gradePackageAnswer(packageAt(0), answer).passed).toBe(false);
  });
  it("rejects feasible but nonoptimal recommendations", () => {
    expect(gradePackageAnswer(packageAt(1), { ids: ["draw", "ramp"], costCents: 70 }).passed).toBe(
      false,
    );
  });
  it("reports an infeasible budget without making up a package", () => {
    const impossible = { ...packageAt(0), budgetCents: 109 };
    expect(solvePackage(impossible).minimumCents).toBeNull();
    expect(solvePackage(impossible).optimal).toEqual([]);
  });
});
