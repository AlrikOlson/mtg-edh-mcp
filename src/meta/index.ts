// Enrichment integrations (spec §5E/§12). p6-cache ships the source-agnostic
// CacheStore (TTL + graceful UPSTREAM_UNAVAILABLE degradation) that the EDHREC,
// Commander Spellbook, and bracket sources build on in later P6 chunks.
export { CacheStore, type CacheStoreOptions } from "./cache.js";
export {
  EdhrecClient,
  slugify,
  parseProfile,
  parseThemes,
  EDHREC_TTL_MS,
  type FetchJson,
  type EdhrecCard,
  type CommanderProfile,
  type EdhrecClientOptions,
} from "./edhrec.js";
export {
  SpellbookClient,
  parseCombos,
  SPELLBOOK_TTL_MS,
  type Combo,
  type ComboResults,
  type SpellbookClientOptions,
} from "./spellbook.js";
export {
  GameChangersClient,
  classifyBracket,
  parseGameChangers,
  GAME_CHANGERS_TTL_MS,
  GAME_CHANGERS_URL,
  EARLY_COMBO_MV,
  EXTRA_TURN_CHAIN,
  type BracketResult,
  type BracketPushers,
  type BracketCombo,
  type GameChangersClientOptions,
  type CardLookup,
} from "./bracket.js";
