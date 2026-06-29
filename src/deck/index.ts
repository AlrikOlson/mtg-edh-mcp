// Versioned deck store (spec §2/§4): long-lived, session-scoped Deck objects
// with version bumps + change notifications. Deck lifecycle tools (deck_create,
// deck_get, …) register against this store in P3.
export {
  DeckStore,
  DEFAULT_SESSION,
  type CreateDeckInput,
  type DeckChangeListener,
  type DeckStoreOptions,
  type DeckSnapshot,
} from "./deckStore.js";
export { diffDecks, type DeckDiff, type CardQtyChange, type FieldChange } from "./diff.js";
export { parseDecklist, formatDecklist, type ParsedEntry } from "./decklist.js";
