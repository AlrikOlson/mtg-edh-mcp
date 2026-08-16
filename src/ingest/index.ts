// Scryfall bulk ingestion (spec §3): acquire oracle_cards + default_cards, stage
// to a versioned store with atomic build->swap->drop, expose a typed streaming
// iterator. The SQLite/FTS build over these staged files lives in p1-index.
export {
  BulkClient,
  BULK_DATA_URL,
  BULK_TYPES,
  USER_AGENT,
  MIN_REQUEST_SPACING_MS,
  resolveBulkDownload,
  type BulkType,
  type BulkDataEntry,
  type BulkClientOptions,
  type ResolvedBulkDownload,
  type FetchFn,
} from "./scryfall.js";
export { VersionedStore, type Manifest, type ManifestFile } from "./store.js";
export { ingestBulk, type IngestOptions, type IngestResult } from "./ingest.js";
export { streamCards, streamCardArray, readCardArray } from "./stream.js";
export { Throttle, type ThrottleOptions } from "./throttle.js";
export type { ScryfallCardRaw, ScryfallCardFace } from "./scryfallTypes.js";
export {
  LiveScryfallClient,
  SCRYFALL_API_BASE,
  SEARCH_SPACING_MS,
  CARD_SPACING_MS,
  type LiveClientOptions,
} from "./live.js";
