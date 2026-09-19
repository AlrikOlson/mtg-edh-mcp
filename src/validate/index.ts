// Commander validation rules (spec §6): pure functions over a deck + card
// lookup -> Violation[]. The validate_* MCP tools (p4-tools) wire these to a
// CardIndex.
export {
  validateCore,
  checkCardCount,
  checkSingleton,
  checkColorIdentity,
  checkBanlist,
  anyNumberReason,
  anyNumberExemptions,
  copyLimit,
  commanderLegality,
  checkFormatLegality,
  checkCommanderLibraryOverlap,
  COMMANDER_DECK_SIZE,
  type CardLookup,
  type AnyNumberReason,
  type AnyNumberExemption,
  type CommanderLegality,
  type CopyLimit,
  type CopyLimitReason,
} from "./coreRules.js";
export {
  validateCommander,
  checkCommanderEligibility,
  checkMultiCommander,
  isCommanderEligible,
  isLegendaryBackground,
  commanderColorIdentity,
} from "./commanderRules.js";
export {
  validateCompanion,
  isCompanionCard,
  checkCompanionOverlap,
  companionCharacteristicsUnknown,
  companionRuleCoverage,
  resolveCompanionCondition,
  type CompanionResolution,
} from "./companionRules.js";
export { validateDeck } from "./validateDeck.js";
