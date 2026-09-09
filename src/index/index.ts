// Local card index (spec §5A/§9): build a better-sqlite3 + FTS5 index from the
// staged Scryfall bulk files and serve full-Card lookups + name search. The
// query evaluator (p2), rules (p4), and analysis (p5) read through CardIndex.
export { buildIndex, CardIndex, DEFAULT_INDEX_NAME } from "./cardIndex.js";
export type {
  BuildIndexOptions,
  BuildIndexResult,
  SearchOptions,
  SearchResult,
} from "./cardIndex.js";
export {
  compileNode,
  orderClause,
  encodeCursor,
  decodeCursor,
  clampLimit,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type CompiledWhere,
  type SqlParam,
} from "./queryEval.js";
export {
  mapScryfallCard,
  oracleTextEvidence,
  extractPrinting,
  colorIdentitySorted,
  isCommanderEligible,
  type ScryfallCardRaw,
  type ScryfallCardFace,
  type PrintingRow,
} from "./map.js";
export { SCHEMA_SQL, SECONDARY_INDEXES } from "./schema.js";
export {
  readSnapshot,
  refreshPrices,
  freshnessConfigFromEnv,
  DEFAULT_FRESHNESS,
  DEFAULT_DATA_ROOT,
  type FreshnessConfig,
  type RefreshPricesOptions,
  type RefreshPricesResult,
} from "./freshness.js";
export {
  resolveCardByNameFallback,
  type CardFallbackResult,
  type ResolveByNameOptions,
} from "./fallback.js";
