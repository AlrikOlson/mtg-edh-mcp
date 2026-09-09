// Rules and rulings evidence (Commander workshop): versioned retrieval of the
// Comprehensive Rules and Scryfall rulings, exact lookup, bounded search and a
// runtime service with explicit provenance. No rules interpretation lives here.
export {
  ComprehensiveRulesCorpus,
  normalizeRuleNumber,
  parseComprehensiveRules,
  parseLongDate,
  RULE_SEARCH_DEFAULT_LIMIT,
  RULE_SEARCH_MAX_LIMIT,
  type GlossaryLookupResult,
  type HeadingRef,
  type RuleLookupResult,
  type RuleSearchHit,
  type RuleSearchOptions,
  type RuleSearchResult,
} from "./comprehensive.js";
export {
  classifyRulingSource,
  parseRuling,
  parseRulingsText,
  RulingsCorpus,
  type ParsedRulings,
  type RulingCounts,
} from "./rulings.js";
export {
  COMPREHENSIVE_RULES_FILE,
  COMPREHENSIVE_RULES_PAGE_URL,
  MIN_COMPREHENSIVE_RULE_COUNT,
  PINNED_COMPREHENSIVE_RULES_URL,
  RULES_DIRECTORY,
  RULINGS_FILE,
  RulesClient,
  RulesStore,
  openCurrentRules,
  refreshRules,
  releaseVersionFromUrl,
  validateComprehensiveRules,
  type OpenRules,
  type RefreshRulesOptions,
  type RefreshRulesResult,
  type RulesClientOptions,
} from "./store.js";
export {
  RULES_STALE_AFTER_MS,
  RulesService,
  type RefreshOutcome,
  type RulesCorpusStatus,
  type RulesServiceOptions,
} from "./service.js";
