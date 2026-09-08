/** Finite evaluation puzzles, not a gameplay simulator or production recommendation engine. */
import type { GradeResult } from "./graders.js";

export type Mana = "W" | "U" | "B" | "R" | "G" | "C";
export interface ManaSource {
  id: string;
  /** Alternative outputs from one activation; each source can be used at most once. */
  options: Mana[][];
  available?: boolean;
}
export interface ManaPuzzle {
  id: string;
  sources: ManaSource[];
  cost: { colored: Mana[]; generic: number };
}

/** Enumerate skip/one-output choices; exact colored and C demands precede generic payment. */
export function solveMana(puzzle: ManaPuzzle): boolean {
  if (
    puzzle.sources.length > 8 ||
    new Set(puzzle.sources.map((s) => s.id)).size !== puzzle.sources.length
  )
    throw new Error("reference mana puzzles require at most eight uniquely named sources");
  if (!Number.isSafeInteger(puzzle.cost.generic) || puzzle.cost.generic < 0)
    throw new Error("invalid generic demand");
  if (
    puzzle.sources.some(
      (source) => source.options.length > 6 || source.options.some((output) => output.length > 6),
    )
  )
    throw new Error("reference output bound exceeded");
  const payable = (pool: Mana[]): boolean => {
    const remaining = [...pool];
    for (const mana of puzzle.cost.colored) {
      const index = remaining.indexOf(mana);
      if (index < 0) return false;
      remaining.splice(index, 1);
    }
    return remaining.length >= puzzle.cost.generic;
  };
  const visit = (index: number, pool: Mana[]): boolean => {
    if (index === puzzle.sources.length) return payable(pool);
    const source = puzzle.sources[index];
    if (!source) throw new Error("Missing source in reference puzzle");
    if (visit(index + 1, pool)) return true;
    return (
      source.available !== false &&
      source.options.some((output) => visit(index + 1, [...pool, ...output]))
    );
  };
  return visit(0, []);
}

export function gradeManaAnswer(puzzle: ManaPuzzle, claimedPayable: boolean): GradeResult {
  const expected = solveMana(puzzle);
  return {
    passed: expected === claimedPayable,
    failures:
      expected === claimedPayable
        ? []
        : [
            {
              code: "MANA_PAYMENT",
              detail: `${puzzle.id}: claimed ${claimedPayable}; exhaustive result ${expected}`,
            },
          ],
  };
}

export const MANA_CASES: (ManaPuzzle & { expected: boolean })[] = [
  {
    id: "one-dual-cannot-pay-wu",
    sources: [{ id: "dual", options: [["W"], ["U"]] }],
    cost: { colored: ["W", "U"], generic: 0 },
    expected: false,
  },
  {
    id: "dual-and-island-pay-wu",
    sources: [
      { id: "dual", options: [["W"], ["U"]] },
      { id: "island", options: [["U"]] },
    ],
    cost: { colored: ["W", "U"], generic: 0 },
    expected: true,
  },
  {
    id: "dual-and-island-cannot-pay-ww",
    sources: [
      { id: "dual", options: [["W"], ["U"]] },
      { id: "island", options: [["U"]] },
    ],
    cost: { colored: ["W", "W"], generic: 0 },
    expected: false,
  },
  {
    id: "wastes-pays-colorless",
    sources: [{ id: "wastes", options: [["C"]] }],
    cost: { colored: ["C"], generic: 0 },
    expected: true,
  },
  {
    id: "wastes-cannot-pay-blue",
    sources: [{ id: "wastes", options: [["C"]] }],
    cost: { colored: ["U"], generic: 0 },
    expected: false,
  },
  {
    id: "unavailable-tapped-land",
    sources: [{ id: "island", options: [["U"]], available: false }],
    cost: { colored: ["U"], generic: 0 },
    expected: false,
  },
  {
    id: "sol-ring-pays-two-generic",
    sources: [{ id: "ring", options: [["C", "C"]] }],
    cost: { colored: [], generic: 2 },
    expected: true,
  },
  {
    id: "sol-ring-cannot-pay-colored",
    sources: [{ id: "ring", options: [["C", "C"]] }],
    cost: { colored: ["R"], generic: 1 },
    expected: false,
  },
];

export interface PackageCandidate {
  id: string;
  costCents: number;
  roles: string[];
  legal: boolean;
}
export interface PackagePuzzle {
  id: string;
  candidates: PackageCandidate[];
  slots: number;
  requiredRoles: { role: string; min: number }[];
  protected: string[];
  budgetCents: number;
}
export interface PackageAnswer {
  ids: string[];
  costCents: number;
}
export interface PackageSolution {
  minimumCents: number | null;
  optimal: PackageAnswer[];
  combinationsExamined: number;
}

/** Check every exact-size subset of a deliberately small, authored finite candidate pool. */
export function solvePackage(puzzle: PackagePuzzle): PackageSolution {
  const candidates = puzzle.candidates;
  if (candidates.length > 12 || new Set(candidates.map((c) => c.id)).size !== candidates.length)
    throw new Error("reference package puzzles require at most twelve unique candidates");
  if (
    !Number.isSafeInteger(puzzle.slots) ||
    puzzle.slots < 0 ||
    !Number.isSafeInteger(puzzle.budgetCents) ||
    puzzle.budgetCents < 0 ||
    candidates.some((c) => !Number.isSafeInteger(c.costCents) || c.costCents < 0)
  )
    throw new Error("invalid package quantities or integer cents");
  const result: PackageSolution = { minimumCents: null, optimal: [], combinationsExamined: 0 };
  const visit = (index: number, chosen: PackageCandidate[]) => {
    if (chosen.length === puzzle.slots) {
      result.combinationsExamined++;
      if (chosen.some((candidate) => !candidate.legal)) return;
      if (puzzle.protected.some((id) => !chosen.some((candidate) => candidate.id === id))) return;
      if (
        puzzle.requiredRoles.some(
          ({ role, min }) =>
            chosen.filter((candidate) => candidate.roles.includes(role)).length < min,
        )
      )
        return;
      const costCents = chosen.reduce((sum, candidate) => sum + candidate.costCents, 0);
      if (
        costCents > puzzle.budgetCents ||
        (result.minimumCents !== null && costCents > result.minimumCents)
      )
        return;
      if (result.minimumCents === null || costCents < result.minimumCents) {
        result.minimumCents = costCents;
        result.optimal = [];
      }
      result.optimal.push({ ids: chosen.map((candidate) => candidate.id).sort(), costCents });
      return;
    }
    const candidate = candidates[index];
    if (!candidate) return;
    visit(index + 1, [...chosen, candidate]);
    visit(index + 1, chosen);
  };
  visit(0, []);
  result.optimal.sort((a, b) => a.ids.join(",").localeCompare(b.ids.join(",")));
  return result;
}

export function gradePackageAnswer(puzzle: PackagePuzzle, answer: PackageAnswer): GradeResult {
  const expected = solvePackage(puzzle);
  const ids = [...answer.ids].sort();
  const passed = expected.optimal.some(
    (option) =>
      option.costCents === answer.costCents && JSON.stringify(option.ids) === JSON.stringify(ids),
  );
  return {
    passed,
    failures: passed
      ? []
      : [
          {
            code: "PACKAGE_OPTIMUM",
            detail: `${puzzle.id}: claimed ${JSON.stringify(answer)}; exhaustive optima ${JSON.stringify(expected.optimal)}`,
          },
        ],
  };
}

const CANDIDATES: PackageCandidate[] = [
  { id: "ramp", costCents: 30, roles: ["ramp"], legal: true },
  { id: "draw", costCents: 40, roles: ["draw"], legal: true },
  { id: "versatile", costCents: 50, roles: ["ramp", "draw"], legal: true },
  { id: "bait", costCents: 1, roles: ["draw"], legal: true },
  { id: "banned", costCents: 0, roles: ["ramp", "draw"], legal: false },
  { id: "protected", costCents: 60, roles: ["theme"], legal: true },
];
export const PACKAGE_CASES: (PackagePuzzle & {
  expectedMinimumCents: number;
  expectedOptimalIds: string[][];
})[] = [
  {
    id: "protected-theme-package",
    candidates: CANDIDATES,
    slots: 2,
    requiredRoles: [
      { role: "ramp", min: 1 },
      { role: "draw", min: 1 },
      { role: "theme", min: 1 },
    ],
    protected: ["protected"],
    budgetCents: 110,
    expectedMinimumCents: 110,
    expectedOptimalIds: [["protected", "versatile"]],
  },
  {
    id: "cheapest-complementary-package",
    candidates: CANDIDATES,
    slots: 2,
    requiredRoles: [
      { role: "ramp", min: 1 },
      { role: "draw", min: 1 },
    ],
    protected: [],
    budgetCents: 100,
    expectedMinimumCents: 31,
    expectedOptimalIds: [["bait", "ramp"]],
  },
];
