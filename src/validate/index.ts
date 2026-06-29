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
  COMMANDER_DECK_SIZE,
  type CardLookup,
  type AnyNumberReason,
  type AnyNumberExemption,
} from "./coreRules.js";
export {
  validateCommander,
  checkCommanderEligibility,
  checkMultiCommander,
  isCommanderEligible,
  commanderColorIdentity,
} from "./commanderRules.js";
