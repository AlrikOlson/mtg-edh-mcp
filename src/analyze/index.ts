// Analysis engines (spec §7/§5D). Functional role classifier (p5-roles); curve/
// composition/mana-base analysis land in p5-basic / p5-mana. Advisory only —
// nothing here feeds validation.
export { classifyRoles, type RoleInput } from "./roles.js";
export {
  analyzeCurve,
  analyzeComposition,
  analyzeStats,
  cheapestUsd,
  defaultUsd,
  type CardLookup,
  type CurveFilter,
} from "./stats.js";
export {
  analyzeManaBase,
  analyzeRoleCoverage,
  DEFAULT_BANDS,
  type ManaBaseReport,
  type RoleBand,
  type RoleBands,
  type CoverageGap,
} from "./mana.js";
export {
  simulateDeck,
  classifyHand,
  type SimOptions,
  type SimResult,
  type HandScenario,
  type LibraryCard,
} from "./sim.js";
export {
  budgetPlan,
  type BudgetOptions,
  type BudgetPlan,
  type ReprintSaving,
  type CostDriver,
} from "./budget.js";
export { extractMechanics, SUPPORTED_MECHANIC_PATTERNS } from "./mechanics.js";
